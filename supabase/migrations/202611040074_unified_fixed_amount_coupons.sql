-- Fixed-amount course coupons for the unified course engine.
--
-- A coupon now carries exactly one discount kind: a percentage, or a fixed
-- amount in one currency. A fixed-amount coupon applies only to a course
-- priced in that currency and never discounts below zero; a discount that
-- covers the whole price grants access without payment, exactly as a 100%
-- coupon does. A partial discount that would leave less than the provider's
-- minimum card charge is refused before any reservation, so a coupon use is
-- never held by an order that can never be paid. Coupon terms remain
-- immutable (guard_unified_coupon); only availability can change.
begin;

alter table public.course_engine_coupons
  alter column percent_off drop not null,
  add column amount_off_minor integer check (amount_off_minor between 1 and 100000000),
  add column currency text check (currency in ('GBP','USD','EUR')),
  add constraint course_engine_coupons_one_discount check (
    (percent_off is not null and amount_off_minor is null and currency is null)
    or (percent_off is null and amount_off_minor is not null and currency is not null));

-- Stripe's documented minimum charge for the three supported currencies.
create function academy_private.minimum_charge_minor(p_currency text) returns integer
language sql immutable set search_path='' as $$
  select case p_currency when 'GBP' then 30 when 'USD' then 50 when 'EUR' then 50 end
$$;

-- Shared creation path: organisation authority, input validation, an
-- idempotent replay of identical terms and COUPON_CONFLICT for any other.
create function academy_private.create_unified_coupon(p_organisation_id uuid,p_code text,p_percent_off integer,
  p_amount_off_minor integer,p_currency text,p_expires_at timestamptz,p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_org(p_organisation_id); reason text:=academy_private.require_reason(p_reason);
  v_code text:=upper(trim(p_code)); c public.course_engine_coupons%rowtype; v_id uuid; pub public.course_engine_publications%rowtype;
begin
  if p_course_id is not null then
    select * into pub from public.course_engine_publications where course_id=p_course_id and organisation_id=p_organisation_id;
    if not found then raise exception 'FORBIDDEN';end if;
  end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,39}$'
    or p_expires_at is null or p_redemption_limit is null or p_redemption_limit not between 1 and 1000000
    or (p_percent_off is null) = (p_amount_off_minor is null)
    or (p_percent_off is not null and (p_percent_off not between 1 and 100 or p_currency is not null))
    or (p_amount_off_minor is not null and (p_amount_off_minor not between 1 and 100000000
      or p_currency is null or p_currency not in ('GBP','USD','EUR')
      or (pub.course_id is not null and pub.currency<>p_currency))) then
    raise exception 'INVALID_INPUT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_COUPON:'||p_organisation_id::text||':'||v_code,0));
  select * into c from public.course_engine_coupons where code=v_code and organisation_id=p_organisation_id;
  if found then
    if c.percent_off is distinct from p_percent_off or c.amount_off_minor is distinct from p_amount_off_minor
      or c.currency is distinct from p_currency or c.expires_at<>p_expires_at or c.redemption_limit<>p_redemption_limit
      or c.course_id is distinct from p_course_id then raise exception 'COUPON_CONFLICT'; end if;
    return c.id;
  end if;
  if p_expires_at <= clock_timestamp() then raise exception 'INVALID_INPUT'; end if;
  insert into public.course_engine_coupons(code,percent_off,amount_off_minor,currency,expires_at,redemption_limit,course_id,created_by,organisation_id)
    values(v_code,p_percent_off,p_amount_off_minor,p_currency,p_expires_at,p_redemption_limit,p_course_id,actor,p_organisation_id) returning id into v_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COURSE_COUPON_CREATED','course_engine_coupons',v_id,'UNIFIED_COURSE_ENGINE_V1',reason,
      jsonb_strip_nulls(jsonb_build_object('percent_off',p_percent_off,'amount_off_minor',p_amount_off_minor,'currency',p_currency,
        'redemption_limit',p_redemption_limit,'course_id',p_course_id,'expires_at',p_expires_at)));
  return v_id;
end $$;

create or replace function public.create_organisation_course_coupon(p_organisation_id uuid,p_code text,p_percent_off integer,p_expires_at timestamptz,
  p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  if p_percent_off is null then raise exception 'INVALID_INPUT'; end if;
  return academy_private.create_unified_coupon(p_organisation_id,p_code,p_percent_off,null,null,p_expires_at,p_redemption_limit,p_course_id,p_reason);
end $$;

create function public.create_organisation_course_amount_coupon(p_organisation_id uuid,p_code text,p_amount_off_minor integer,p_currency text,
  p_expires_at timestamptz,p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  if p_amount_off_minor is null or p_currency is null then raise exception 'INVALID_INPUT'; end if;
  return academy_private.create_unified_coupon(p_organisation_id,p_code,null,p_amount_off_minor,p_currency,p_expires_at,p_redemption_limit,p_course_id,p_reason);
end $$;

-- Identical to migration 072 except the discount calculation block.
create or replace function public.create_unified_course_order(p_offer_slug text,p_coupon_code text default null) returns jsonb
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
    select * into c from public.course_engine_coupons where code=v_code and organisation_id=p.organisation_id for update;
    if not found or not c.active or c.expires_at<=clock_timestamp() or (c.course_id is not null and c.course_id<>p.course_id)
      or (c.currency is not null and c.currency<>p.currency)
      or (select count(*) from public.course_engine_coupon_redemptions r where r.coupon_id=c.id and not exists(select 1 from public.course_engine_checkout_cancellations released where released.order_id=r.order_id))>=c.redemption_limit then
      return jsonb_build_object('ok',false,'code','COUPON_UNAVAILABLE');
    end if;
    if c.amount_off_minor is not null then
      v_amount:=greatest(p.amount_minor-c.amount_off_minor,0);
    else
      v_amount:=((p.amount_minor::bigint*(100-c.percent_off)+99)/100)::integer;
    end if;
    if v_amount=p.amount_minor then return jsonb_build_object('ok',false,'code','COUPON_NO_DISCOUNT'); end if;
    if v_amount>0 and v_amount<academy_private.minimum_charge_minor(p.currency) then
      return jsonb_build_object('ok',false,'code','COUPON_BELOW_MINIMUM_CHARGE');
    end if;
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

create or replace function public.list_course_coupons() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id,'MANAGE')) then raise exception 'FORBIDDEN';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'percentOff',c.percent_off,
    'amountOffMinor',c.amount_off_minor,'currency',c.currency,'expiresAt',c.expires_at,
    'redemptionLimit',c.redemption_limit,'courseId',c.course_id,'active',c.active,
    'reserved',(select count(*) from public.course_engine_coupon_redemptions r join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and o.state='PENDING'),
    'redeemed',(select count(*) from public.course_engine_coupon_redemptions r left join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and (o.state='FULFILLED' or r.order_id is null))
  ) order by c.created_at desc) from (select * from public.course_engine_coupons where academy_private.can_manage_org(organisation_id) order by created_at desc limit 200) c),'[]');
end $$;

do $$ declare f record; begin
  for f in select oid::regprocedure sig from pg_proc where pronamespace='academy_private'::regnamespace
    and proname in ('minimum_charge_minor','create_unified_coupon') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
  for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace
    and proname in ('create_organisation_course_coupon','create_organisation_course_amount_coupon','create_unified_course_order','list_course_coupons') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
    execute format('grant execute on function %s to authenticated',f.sig);
  end loop;
end $$;
do $$ declare r text; f text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(r,'public.course_engine_coupons','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r,'public.course_engine_coupons','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe unified coupon table privileges';
    end if;
    foreach f in array array['academy_private.minimum_charge_minor(text)',
      'academy_private.create_unified_coupon(uuid,text,integer,integer,text,timestamptz,integer,uuid,text)'] loop
      if has_function_privilege(r,f,'EXECUTE') then raise exception 'Unsafe private coupon function privileges'; end if;
    end loop;
    foreach f in array array['public.create_organisation_course_coupon(uuid,text,integer,timestamptz,integer,uuid,text)',
      'public.create_organisation_course_amount_coupon(uuid,text,integer,text,timestamptz,integer,uuid,text)',
      'public.create_unified_course_order(text,text)','public.list_course_coupons()'] loop
      if has_function_privilege(r,f,'EXECUTE') <> (r='authenticated') then raise exception 'Unsafe unified coupon RPC privileges'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
