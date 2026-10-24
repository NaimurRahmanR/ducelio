-- Unified purchases reuse Academy orders, signed Stripe fulfilment,
-- checkout-session replacement and refund/revocation evidence. No cohorts.
begin;
create table public.course_engine_coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check(code ~ '^[A-Z0-9][A-Z0-9_-]{3,39}$'),
  percent_off integer not null check(percent_off between 1 and 100),
  expires_at timestamptz not null,
  redemption_limit integer not null check(redemption_limit between 1 and 1000000),
  course_id uuid references public.course_engine_publications(course_id),
  active boolean not null default true,
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index course_engine_coupons_course on public.course_engine_coupons(course_id);
create index course_engine_coupons_creator on public.course_engine_coupons(created_by);

-- A reservation freezes the discount for the order and consumes capacity.
-- Abandoned payments resume/recover the SAME order and slot; they never
-- reserve again or release a slot while a Stripe session could still pay.
create table public.course_engine_coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.course_engine_coupons(id),
  learner_id uuid not null references public.app_users(id),
  course_id uuid not null references public.course_engine_publications(course_id),
  order_id uuid unique references public.academy_orders(id),
  list_amount_minor integer not null check(list_amount_minor between 1 and 100000000),
  discount_amount_minor integer not null check(discount_amount_minor between 1 and 100000000),
  created_at timestamptz not null default clock_timestamp(),
  unique(coupon_id,learner_id,course_id),
  check(discount_amount_minor <= list_amount_minor),
  check((order_id is null) = (discount_amount_minor = list_amount_minor))
);
create index course_engine_redemptions_learner on public.course_engine_coupon_redemptions(learner_id);
create index course_engine_redemptions_course on public.course_engine_coupon_redemptions(course_id);
create table public.course_engine_order_terms (
  order_id uuid primary key references public.academy_orders(id),
  list_amount_minor integer not null check(list_amount_minor between 1 and 100000000),
  discount_amount_minor integer not null check(discount_amount_minor between 0 and 100000000),
  redemption_id uuid unique references public.course_engine_coupon_redemptions(id),
  check(discount_amount_minor < list_amount_minor),
  check((redemption_id is null) = (discount_amount_minor = 0))
);

create function academy_private.guard_unified_coupon() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-'active') is distinct from (to_jsonb(old)-'active') then
    raise exception 'IMMUTABLE_HISTORY';
  end if;
  return new;
end $$;
create trigger course_engine_coupon_guard before update or delete on public.course_engine_coupons
  for each row execute function academy_private.guard_unified_coupon();
do $$ declare t text; begin
  foreach t in array array['course_engine_coupons','course_engine_coupon_redemptions','course_engine_order_terms'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    if t <> 'course_engine_coupons' then
      execute format('create trigger immutable_history before update or delete on public.%I for each row execute function academy_private.guard_history()',t);
    end if;
  end loop;
end $$;

alter table public.academy_orders alter column format_id drop not null;
alter table public.academy_orders drop constraint academy_orders_format_id_check,
  add constraint academy_orders_format_id_check check(format_id is null or academy_private.format_weeks(format_id) is not null);
create unique index academy_orders_one_unified_pending on public.academy_orders(learner_id,course_id)
  where state='PENDING' and format_id is null;
alter table public.academy_entitlements
  drop constraint academy_entitlements_source_check,
  drop constraint academy_entitlements_provenance,
  add column coupon_redemption_id uuid unique references public.course_engine_coupon_redemptions(id),
  add constraint academy_entitlements_source_check check(source in ('COMPLIMENTARY_GRANT','PURCHASE','COUPON')),
  add constraint academy_entitlements_provenance check(
    (source='COMPLIMENTARY_GRANT' and granted_by is not null and order_id is null and coupon_redemption_id is null)
    or (source='PURCHASE' and granted_by is null and order_id is not null and coupon_redemption_id is null)
    or (source='COUPON' and granted_by is null and order_id is null and format_id is null and coupon_redemption_id is not null)
  );

-- Preserve the legacy purchased-format invariant. Only a verified unified
-- order's entitlement may leave duration unchosen for learner activation.
create function academy_private.guard_unified_entitlement() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.source='PURCHASE' and new.format_id is null and not exists(
    select 1 from public.academy_orders o join public.course_engine_order_terms t on t.order_id=o.id
    join public.course_engine_publications p on p.course_id=o.course_id and p.offer_id=o.offer_id
    where o.id=new.order_id and o.learner_id=new.learner_id and o.course_id=new.course_id and o.offer_id=new.offer_id
      and o.format_id is null and o.amount_minor=t.list_amount_minor-t.discount_amount_minor
  ) then raise exception 'INVALID_PURCHASE_PROVENANCE'; end if;
  if new.source='COUPON' and not exists(
    select 1 from public.course_engine_coupon_redemptions r join public.course_engine_publications p on p.course_id=r.course_id
    where r.id=new.coupon_redemption_id and r.order_id is null and r.learner_id=new.learner_id
      and r.course_id=new.course_id and p.offer_id=new.offer_id
  ) then raise exception 'INVALID_COUPON_PROVENANCE'; end if;
  return new;
end $$;
create trigger unified_entitlement_provenance before insert on public.academy_entitlements
  for each row execute function academy_private.guard_unified_entitlement();

create function public.create_course_coupon(p_code text,p_percent_off integer,p_expires_at timestamptz,
  p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_course_admin(); reason text:=academy_private.require_reason(p_reason);
  v_code text:=upper(trim(p_code)); c public.course_engine_coupons%rowtype; v_id uuid;
begin
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,39}$' or p_percent_off is null or p_percent_off not between 1 and 100
    or p_expires_at is null or p_redemption_limit is null or p_redemption_limit not between 1 and 1000000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_COUPON:'||v_code,0));
  select * into c from public.course_engine_coupons where code=v_code;
  if found then
    if c.percent_off<>p_percent_off or c.expires_at<>p_expires_at or c.redemption_limit<>p_redemption_limit
      or c.course_id is distinct from p_course_id then raise exception 'COUPON_CONFLICT'; end if;
    return c.id;
  end if;
  if p_expires_at <= clock_timestamp() then raise exception 'INVALID_INPUT'; end if;
  insert into public.course_engine_coupons(code,percent_off,expires_at,redemption_limit,course_id,created_by)
    values(v_code,p_percent_off,p_expires_at,p_redemption_limit,p_course_id,actor) returning id into v_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COURSE_COUPON_CREATED','course_engine_coupons',v_id,'UNIFIED_COURSE_ENGINE_V1',reason,
      jsonb_build_object('percent_off',p_percent_off,'redemption_limit',p_redemption_limit,'course_id',p_course_id,'expires_at',p_expires_at));
  return v_id;
end $$;

create function public.set_course_coupon_active(p_coupon_id uuid,p_active boolean,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_course_admin(); reason text:=academy_private.require_reason(p_reason); c public.course_engine_coupons%rowtype;
begin
  if p_active is null then raise exception 'INVALID_INPUT'; end if;
  select * into c from public.course_engine_coupons where id=p_coupon_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if c.active=p_active then return c.id; end if;
  update public.course_engine_coupons set active=p_active where id=c.id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COURSE_COUPON_AVAILABILITY_CHANGED','course_engine_coupons',c.id,'UNIFIED_COURSE_ENGINE_V1',reason,jsonb_build_object('active',p_active));
  return c.id;
end $$;

create function public.create_unified_course_order(p_offer_slug text,p_coupon_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_student(); o public.academy_offers%rowtype; p public.course_engine_publications%rowtype;
  c public.course_engine_coupons%rowtype; prior public.academy_orders%rowtype; ent public.academy_entitlements%rowtype;
  v_code text:=nullif(upper(trim(p_coupon_code)),''); v_amount integer; v_order uuid; v_redemption uuid; v_ent uuid; v_enrol uuid;
begin
  if v_code is not null and (length(v_code)>40 or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,39}$') then
    return jsonb_build_object('ok',false,'code','COUPON_UNAVAILABLE');
  end if;
  select * into o from public.academy_offers where slug=p_offer_slug;
  if not found then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  select * into p from public.course_engine_publications where course_id=o.course_id and offer_id=o.id;
  if not found then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_ORDER:'||actor::text||':'||p.course_id::text,0));
  -- Existing order first, learner second: matches signed fulfilment's lock order.
  select * into prior from public.academy_orders where learner_id=actor and course_id=p.course_id and state='PENDING' and format_id is null for update;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  select * into ent from public.academy_entitlements where learner_id=actor and course_id=p.course_id;
  if found then
    if ent.state='REVOKED' then return jsonb_build_object('ok',false,'code','ACCESS_REVOKED'); end if;
    select id into v_enrol from public.academy_enrolments where entitlement_id=ent.id;
    return jsonb_build_object('ok',true,'accessGranted',true,'enrolmentId',v_enrol,'reused',true);
  end if;
  if o.state<>'PUBLISHED' or o.sale_mode<>'PUBLIC_SALE' then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  if prior.id is not null then
    if v_code is distinct from (select cp.code from public.course_engine_order_terms t
        join public.course_engine_coupon_redemptions r on r.id=t.redemption_id
        join public.course_engine_coupons cp on cp.id=r.coupon_id where t.order_id=prior.id) then
      return jsonb_build_object('ok',false,'code','CHECKOUT_TERMS_LOCKED');
    end if;
    return jsonb_build_object('ok',true,'accessGranted',false,'orderId',prior.id,'amountMinor',prior.amount_minor,'currency',prior.currency,'offerSlug',o.slug,'formatId',null,'reused',true);
  end if;
  v_amount:=p.amount_minor;
  if v_code is not null then
    select * into c from public.course_engine_coupons where code=v_code for update;
    if not found or not c.active or c.expires_at<=clock_timestamp() or (c.course_id is not null and c.course_id<>p.course_id)
      or (select count(*) from public.course_engine_coupon_redemptions where coupon_id=c.id)>=c.redemption_limit then
      return jsonb_build_object('ok',false,'code','COUPON_UNAVAILABLE');
    end if;
    v_amount:=((p.amount_minor::bigint*(100-c.percent_off)+99)/100)::integer;
    if v_amount=p.amount_minor then return jsonb_build_object('ok',false,'code','COUPON_NO_DISCOUNT'); end if;
  end if;
  if v_amount>0 then
    insert into public.academy_orders(learner_id,offer_id,course_id,format_id,amount_minor,currency)
      values(actor,o.id,p.course_id,null,v_amount,p.currency) returning id into v_order;
  end if;
  if c.id is not null then
    insert into public.course_engine_coupon_redemptions(coupon_id,learner_id,course_id,order_id,list_amount_minor,discount_amount_minor)
      values(c.id,actor,p.course_id,v_order,p.amount_minor,p.amount_minor-v_amount) returning id into v_redemption;
  end if;
  if v_order is not null then
    insert into public.course_engine_order_terms(order_id,list_amount_minor,discount_amount_minor,redemption_id)
      values(v_order,p.amount_minor,p.amount_minor-v_amount,v_redemption);
  else
    insert into public.academy_entitlements(learner_id,offer_id,course_id,format_id,source,reason,coupon_redemption_id)
      values(actor,o.id,p.course_id,null,'COUPON','Verified full-discount course coupon',v_redemption) returning id into v_ent;
    insert into public.academy_enrolments(entitlement_id,learner_id,course_id,programme_version_id)
      select v_ent,actor,p.course_id,programme_version_id from public.academy_courses where id=p.course_id returning id into v_enrol;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'UNIFIED_COURSE_CHECKOUT_CREATED','academy_courses',p.course_id,'UNIFIED_COURSE_ENGINE_V1','Learner started course checkout',
      jsonb_build_object('order_id',v_order,'redemption_id',v_redemption,'amount_minor',v_amount,'currency',p.currency,'entitlement_id',v_ent));
  if v_order is null then return jsonb_build_object('ok',true,'accessGranted',true,'enrolmentId',v_enrol,'reused',false); end if;
  return jsonb_build_object('ok',true,'accessGranted',false,'orderId',v_order,'amountMinor',v_amount,'currency',p.currency,'offerSlug',o.slug,'formatId',null,'reused',false);
end $$;

create function public.list_course_coupons() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'percentOff',c.percent_off,'expiresAt',c.expires_at,
    'redemptionLimit',c.redemption_limit,'courseId',c.course_id,'active',c.active,
    'reserved',(select count(*) from public.course_engine_coupon_redemptions r join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and o.state='PENDING'),
    'redeemed',(select count(*) from public.course_engine_coupon_redemptions r left join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and (o.state='FULFILLED' or r.order_id is null))
  ) order by c.created_at desc) from (select * from public.course_engine_coupons order by created_at desc limit 200) c),'[]');
end $$;

create function public.get_course_coupon_redemptions(p_coupon_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'learnerId',r.learner_id,'courseId',r.course_id,'orderId',r.order_id,
    'listAmountMinor',r.list_amount_minor,'discountAmountMinor',r.discount_amount_minor,'createdAt',r.created_at,
    'state',case when r.order_id is null or o.state='FULFILLED' then 'REDEEMED' else 'RESERVED' end) order by r.created_at desc)
    from (select * from public.course_engine_coupon_redemptions where coupon_id=p_coupon_id order by created_at desc limit 200) r
    left join public.academy_orders o on o.id=r.order_id),'[]');
end $$;

revoke all on function academy_private.guard_unified_coupon(),academy_private.guard_unified_entitlement() from public,anon,authenticated,service_role;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
    and proname in ('create_course_coupon','set_course_coupon_active','create_unified_course_order','list_course_coupons','get_course_coupon_redemptions') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
do $$ declare r text; t text; f text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['course_engine_coupons','course_engine_coupon_redemptions','course_engine_order_terms'] loop
      if has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe unified commerce table privileges'; end if;
    end loop;
    foreach f in array array['create_course_coupon(text,integer,timestamptz,integer,uuid,text)',
      'set_course_coupon_active(uuid,boolean,text)','create_unified_course_order(text,text)',
      'list_course_coupons()','get_course_coupon_redemptions(uuid)'] loop
      if has_function_privilege(r,'public.'||f,'EXECUTE') <> (r='authenticated') then raise exception 'Unsafe unified commerce RPC privileges'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
