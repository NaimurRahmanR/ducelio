-- Terminal, provider-verified cancellation. Never release a payable session.
begin;
create table public.course_engine_checkout_cancellations (
 order_id uuid primary key references public.course_engine_order_terms(order_id),
 expired_session_id text not null unique,
 amount_minor integer not null check(amount_minor>0),
 currency text not null check(currency in ('GBP','USD','EUR')),
 confirmed_at timestamptz not null default clock_timestamp()
);
alter table public.course_engine_checkout_cancellations enable row level security;
revoke all on public.course_engine_checkout_cancellations from public,anon,authenticated,service_role;
create trigger immutable_history before update or delete on public.course_engine_checkout_cancellations for each row execute function academy_private.guard_history();
alter table public.academy_orders drop constraint academy_orders_state_check,
 add constraint academy_orders_state_check check(state in ('PENDING','FULFILLED','CANCELLED'));
do $$ declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.academy_orders'::regclass and contype='c' and pg_get_constraintdef(oid) like '%fulfilled_at%' loop
 execute format('alter table public.academy_orders drop constraint %I',c.conname);end loop;
 for c in select conname from pg_constraint where conrelid='public.course_engine_coupon_redemptions'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (coupon_id, learner_id, course_id)' loop
 execute format('alter table public.course_engine_coupon_redemptions drop constraint %I',c.conname);end loop;
end $$;
alter table public.academy_orders add constraint academy_orders_fulfilled_shape check((state='FULFILLED')=(fulfilled_at is not null));
create function academy_private.guard_active_redemption() returns trigger
language plpgsql set search_path='' as $$
begin
 perform 1 from public.course_engine_coupons where id=new.coupon_id for update;
 if exists(select 1 from public.course_engine_coupon_redemptions r where r.coupon_id=new.coupon_id and r.learner_id=new.learner_id and r.course_id=new.course_id
   and not exists(select 1 from public.course_engine_checkout_cancellations c where c.order_id=r.order_id)) then raise exception 'ACTIVE_REDEMPTION_EXISTS';end if;
 return new;
end $$;
create trigger active_redemption before insert on public.course_engine_coupon_redemptions for each row execute function academy_private.guard_active_redemption();

create function public.list_my_unified_course_orders() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=academy_private.require_student();
begin
 return coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'state',o.state,'title',c.title,'offerSlug',f.slug,'amountMinor',o.amount_minor,'currency',o.currency,'sessionBound',o.provider_session_id is not null,'createdAt',o.created_at) order by o.created_at desc)
 from (select a.* from public.academy_orders a join public.course_engine_order_terms t on t.order_id=a.id where a.learner_id=actor order by a.created_at desc limit 50) o
 join public.academy_courses c on c.id=o.course_id join public.academy_offers f on f.id=o.offer_id),'[]');
end $$;
revoke all on function academy_private.guard_active_redemption() from public,anon,authenticated,service_role;
revoke all on function public.list_my_unified_course_orders() from public,anon,authenticated,service_role;
grant execute on function public.list_my_unified_course_orders() to authenticated;

create or replace function academy_private.guard_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'DELETE' then raise exception 'IMMUTABLE_HISTORY'; end if;
  if tg_table_name = 'academy_course_packages' then
    if new.id <> old.id or new.raw_package <> old.raw_package or new.content_hash <> old.content_hash
      or new.package_key <> old.package_key or new.package_revision <> old.package_revision
      or old.status in ('PUBLISHED','REJECTED')
      or (old.status = 'VALIDATED' and new.status not in ('PUBLISHED','REJECTED'))
      or (old.status = 'VALIDATED' and new.review is distinct from old.review) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_offers' then
    if new.id <> old.id or new.course_id <> old.course_id or new.slug <> old.slug or new.currency <> old.currency
      or new.summary is distinct from old.summary or old.state <> 'PUBLISHED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
    -- Exactly one change per update: archive, or REVIEW_ONLY -> PUBLIC_SALE.
    if not ((new.state = 'ARCHIVED' and new.sale_mode = old.sale_mode)
      or (new.state = 'PUBLISHED' and old.sale_mode = 'REVIEW_ONLY' and new.sale_mode = 'PUBLIC_SALE')) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_enrolments' then
    if new.id <> old.id or new.entitlement_id <> old.entitlement_id or new.learner_id <> old.learner_id
      or new.course_id <> old.course_id or new.programme_version_id <> old.programme_version_id
      or (old.format_id is not null and (new.format_id is distinct from old.format_id or new.format_locked_at is distinct from old.format_locked_at))
      or old.status = 'COMPLETED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_entitlements' then
    if (to_jsonb(new) - array['state','revoked_at','revocation_reason']) <> (to_jsonb(old) - array['state','revoked_at','revocation_reason'])
      or old.state <> 'ACTIVE' or new.state <> 'REVOKED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_orders' then
    if (to_jsonb(new) - array['provider_session_id','state','fulfilled_at']) <> (to_jsonb(old) - array['provider_session_id','state','fulfilled_at'])
      or old.state <> 'PENDING'
      or (new.state='CANCELLED' and not exists(select 1 from public.course_engine_checkout_cancellations where order_id=old.id))
      or (new.provider_session_id is distinct from old.provider_session_id and old.provider_session_id is not null
          and not exists (select 1 from public.academy_checkout_replacements r where r.order_id = old.id
            and r.expired_session_id = old.provider_session_id and r.replacement_session_id = new.provider_session_id)) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_objective_mastery' then
    if new.enrolment_id <> old.enrolment_id or new.objective_id <> old.objective_id then raise exception 'IMMUTABLE_HISTORY'; end if;
  elsif tg_table_name = 'academy_schedules' then
    if (to_jsonb(new) - 'superseded_at') <> (to_jsonb(old) - 'superseded_at') or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_assessment_attempts' then
    if old.state <> 'ACTIVE' or (to_jsonb(new) - array['state','submitted_at','submission','score','max_score'])
        <> (to_jsonb(old) - array['state','submitted_at','submission','score','max_score']) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  else
    raise exception 'IMMUTABLE_HISTORY';
  end if;
  return new;
end $$;

create or replace function public.apply_academy_commerce_operation(p_key_id uuid, p_payload text, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare x jsonb; o public.academy_orders%rowtype; ent uuid; inserted integer; result jsonb;
begin
  if p_payload is null or octet_length(p_payload) > 4000 or not academy_private.verify_claim(p_key_id,
    concat_ws(E'\n', 'DUCELIO_ACADEMY_COMMERCE_OPERATIONS_HMAC_SHA256_V1', p_key_id::text, p_payload, p_issued_at::text, p_expires_at::text),
    p_issued_at, p_expires_at, p_mac, 60) then
    raise exception 'UNTRUSTED_CLAIM';
  end if;
  x := p_payload::jsonb;
  if x->>'kind'='CANCEL_UNIFIED_CHECKOUT' then
    if public.current_app_user() is distinct from (x->>'learnerId')::uuid then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');end if;
    select * into o from public.academy_orders where id=(x->>'orderId')::uuid and learner_id=(x->>'learnerId')::uuid for update;
    if not found or not exists(select 1 from public.course_engine_order_terms where order_id=o.id) then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');end if;
    if o.state='CANCELLED' and exists(select 1 from public.course_engine_checkout_cancellations where order_id=o.id and expired_session_id=x->>'sessionId') then return jsonb_build_object('ok',true,'code','ALREADY_CANCELLED');end if;
    if o.state<>'PENDING' then return jsonb_build_object('ok',false,'code','INVALID_STATE');end if;
    if o.provider_session_id is null or o.provider_session_id is distinct from x->>'sessionId' or o.amount_minor is distinct from (x->>'amountMinor')::integer or o.currency is distinct from x->>'currency'
      or x->>'sessionStatus' is distinct from 'EXPIRED' or x->>'paymentStatus' is distinct from 'UNPAID' then return jsonb_build_object('ok',false,'code','CANCELLATION_MISMATCH');end if;
    perform 1 from public.student_profiles where user_id=o.learner_id for update;
    perform 1 from public.course_engine_coupons where id=(select r.coupon_id from public.course_engine_order_terms t join public.course_engine_coupon_redemptions r on r.id=t.redemption_id where t.order_id=o.id) for update;
    if exists(select 1 from public.academy_payment_events where order_id=o.id and status='PAID') or exists(select 1 from public.academy_entitlements where order_id=o.id) then return jsonb_build_object('ok',false,'code','PAYMENT_REVIEW_REQUIRED');end if;
    insert into public.course_engine_checkout_cancellations(order_id,expired_session_id,amount_minor,currency) values(o.id,o.provider_session_id,o.amount_minor,o.currency);
    update public.academy_orders set state='CANCELLED' where id=o.id;
    insert into public.audit_events(actor_id,action,target_type,target_id,source,reason) values(o.learner_id,'UNIFIED_CHECKOUT_CANCELLED','academy_orders',o.id,'UNIFIED_COURSE_ENGINE_V1','Stripe session verified expired and unpaid');
    return jsonb_build_object('ok',true,'code','CANCELLED');
  elsif x->>'kind' = 'REFUND' then
    select * into o from public.academy_orders where id = (x->>'orderId')::uuid for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
    if (o.provider_session_id is not null and o.provider_session_id is distinct from x->>'sessionId')
      or o.amount_minor is distinct from (x->>'amountMinor')::integer or o.currency is distinct from x->>'currency' then
      return jsonb_build_object('ok', false, 'code', 'REFUND_MISMATCH');
    end if;
    if (x->>'refundedMinor')::integer is distinct from o.amount_minor then return jsonb_build_object('ok', false, 'code', 'PARTIAL_REFUND_REVIEW'); end if;
    insert into public.academy_order_refunds(order_id, charge_id, event_id, amount_minor, currency)
    values (o.id, x->>'chargeId', x->>'eventId', o.amount_minor, o.currency) on conflict (order_id) do nothing;
    get diagnostics inserted = row_count;
    -- Only THIS payment's entitlement; never complimentary or other access.
    select id into ent from public.academy_entitlements where order_id = o.id;
    if ent is null then result := jsonb_build_object('ok', true, 'code', 'REFUNDED_NO_LINKED_ENTITLEMENT');
    else result := academy_private.revoke_entitlement(ent, null, 'Verified full Stripe refund'); end if;
    if inserted > 0 then
      insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
      values (null, 'ACADEMY_REFUND_RECONCILED', 'academy_orders', o.id, 'ACADEMY_COMMERCE_V1', 'Verified full Stripe refund', result);
    end if;
    return result;
  elsif x->>'kind' = 'CHECKOUT_REPLACEMENT' then
    if public.current_app_user() is distinct from (x->>'learnerId')::uuid then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    select * into o from public.academy_orders where id = (x->>'orderId')::uuid and learner_id = (x->>'learnerId')::uuid for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    if o.state <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
    if exists (select 1 from public.academy_checkout_replacements where expired_session_id = x->>'expiredSessionId'
      and replacement_session_id = x->>'replacementSessionId' and order_id = o.id) then
      return jsonb_build_object('ok', true, 'code', 'ALREADY_REPLACED');
    end if;
    if o.provider_session_id is distinct from x->>'expiredSessionId' then return jsonb_build_object('ok', false, 'code', 'SESSION_CHANGED'); end if;
    if (x->>'replacementSessionId') !~ '^cs_[A-Za-z0-9_]{1,197}$' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
    insert into public.academy_checkout_replacements(order_id, expired_session_id, replacement_session_id)
    values (o.id, x->>'expiredSessionId', x->>'replacementSessionId');
    update public.academy_orders set provider_session_id = x->>'replacementSessionId' where id = o.id;
    return jsonb_build_object('ok', true, 'code', 'REPLACED');
  end if;
  raise exception 'INVALID_OPERATION';
end $$;

create or replace function public.fulfill_academy_order(
  p_key_id uuid, p_order_id uuid, p_provider text, p_session_id text, p_event_id text,
  p_amount integer, p_currency text, p_status text, p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.academy_orders%rowtype; ent public.academy_entitlements%rowtype; enrolment uuid; version_id uuid;
begin
  if p_provider is distinct from 'STRIPE' or p_order_id is null or p_session_id is null or length(p_session_id) not between 1 and 200
    or p_event_id is null or length(p_event_id) not between 1 and 200 or p_amount is null or p_amount not between 1 and 100000000
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_status not in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')
    or not academy_private.verify_claim(p_key_id, concat_ws(E'\n', 'DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1', 'ACADEMY_COMMERCE_V1',
      p_key_id::text, p_provider, p_order_id::text, p_session_id, p_event_id, p_amount::text, p_currency, p_status,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac, 300) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  -- Lock order: the order, then the learner profile (as the cohort path).
  select * into o from public.academy_orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  perform 1 from public.student_profiles where user_id = o.learner_id for update;
  if exists (select 1 from public.academy_order_refunds where order_id = o.id) then return jsonb_build_object('ok', false, 'code', 'ORDER_REFUNDED'); end if;
  if exists (select 1 from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  if o.provider_session_id is null then
    update public.academy_orders set provider_session_id = p_session_id where id = o.id;
  elsif o.provider_session_id <> p_session_id then
    return jsonb_build_object('ok', false, 'code', 'MISMATCHED_SESSION');
  end if;
  if o.amount_minor <> p_amount then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_AMOUNT'); end if;
  if o.currency <> p_currency then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_CURRENCY'); end if;
  insert into public.academy_payment_events(order_id, provider, provider_event_id, session_id, amount_minor, currency, status)
  values (o.id, p_provider, p_event_id, p_session_id, p_amount, p_currency, p_status) on conflict (provider, provider_event_id) do nothing;
  if o.state='CANCELLED' then return jsonb_build_object('ok',false,'code',case when p_status='PAID' then 'CANCELLED_PAYMENT_REVIEW' else 'ORDER_CANCELLED' end);end if;
  if o.state = 'FULFILLED' then
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
    return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', true, 'orderId', o.id, 'entitlementId', ent.id,
      'enrolmentId', (select id from public.academy_enrolments where entitlement_id = ent.id));
  end if;
  if p_status <> 'PAID' then return jsonb_build_object('ok', true, 'fulfilled', false, 'code', 'NOT_PAID', 'orderId', o.id); end if;
  if not exists (select 1 from public.role_grants where user_id = o.learner_id and role = 'STUDENT') then
    return jsonb_build_object('ok', false, 'code', 'LEARNER_NOT_STUDENT');
  end if;
  insert into public.academy_entitlements(learner_id, offer_id, course_id, format_id, source, order_id, reason)
  values (o.learner_id, o.offer_id, o.course_id, o.format_id, 'PURCHASE', o.id, 'Verified Stripe payment')
  on conflict (learner_id, course_id) do nothing returning * into ent;
  if ent.id is null then
    -- A second payment for a course already held: never a second
    -- entitlement; reconciliation is a support decision (as for cohorts).
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
  else
    select programme_version_id into version_id from public.academy_courses where id = o.course_id;
    insert into public.academy_enrolments(entitlement_id, learner_id, course_id, programme_version_id)
    values (ent.id, o.learner_id, o.course_id, version_id);
  end if;
  update public.academy_orders set state = 'FULFILLED', fulfilled_at = clock_timestamp() where id = o.id;
  select id into enrolment from public.academy_enrolments where entitlement_id = ent.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (o.learner_id, 'ACADEMY_ORDER_FULFILLED', 'academy_orders', o.id, 'ACADEMY_COMMERCE_V1', 'Verified payment fulfilled',
    jsonb_build_object('entitlement_id', ent.id, 'enrolment_id', enrolment, 'format_id', o.format_id, 'amount_minor', p_amount,
      'currency', p_currency, 'duplicate', ent.order_id is distinct from o.id));
  return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', false, 'orderId', o.id, 'entitlementId', ent.id,
    'enrolmentId', enrolment, 'duplicate', ent.order_id is distinct from o.id);
end $$;

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
      or (select count(*) from public.course_engine_coupon_redemptions r where r.coupon_id=c.id and not exists(select 1 from public.course_engine_checkout_cancellations released where released.order_id=r.order_id))>=c.redemption_limit then
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

create or replace function public.get_course_coupon_redemptions(p_coupon_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_coupon(p_coupon_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'learnerId',r.learner_id,'courseId',r.course_id,'orderId',r.order_id,
    'listAmountMinor',r.list_amount_minor,'discountAmountMinor',r.discount_amount_minor,'createdAt',r.created_at,
    'state',case when o.state='CANCELLED' then 'RELEASED' when r.order_id is null or o.state='FULFILLED' then 'REDEEMED' else 'RESERVED' end) order by r.created_at desc)
    from (select * from public.course_engine_coupon_redemptions where coupon_id=p_coupon_id order by created_at desc limit 200) r
    left join public.academy_orders o on o.id=r.order_id),'[]');
end $$;

commit;
