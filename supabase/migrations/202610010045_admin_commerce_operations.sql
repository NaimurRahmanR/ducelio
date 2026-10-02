-- Commerce operations. Deploy AFTER 202610010044_admin_control_plane_foundations.sql.
-- Does not replace or bypass the upstream cohort/order/offer/enrolment guards.
-- Stripe evidence is signed by the existing private commerce controller; operators
-- cannot declare payment or refund truth. No payment payload or secret is stored.

alter table public.commercial_v1_entitlements
  drop constraint commercial_v1_entitlements_state_check,
  add constraint commercial_v1_entitlements_state_check check(state in ('ACTIVE','REVOKED')),
  -- Never infer ownership of existing historical enrolments.
  add column enrolment_origin text not null default 'UNKNOWN' check(enrolment_origin in ('COMMERCE','ACADEMIC','UNKNOWN')),
  add column revoked_at timestamptz,
  add column revocation_reason text,
  add constraint entitlement_revocation_provenance check(
    (state='ACTIVE' and revoked_at is null and revocation_reason is null) or
    (state='REVOKED' and revoked_at is not null and revocation_reason is not null and length(trim(revocation_reason)) between 5 and 300));

drop trigger entitlements_append_only on public.commercial_v1_entitlements;
create function commercial_v1_commerce_private.guard_entitlement() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Entitlements cannot be deleted'; end if;
  if (to_jsonb(NEW)-array['state','revoked_at','revocation_reason']) is distinct from
     (to_jsonb(OLD)-array['state','revoked_at','revocation_reason'])
     or OLD.state='REVOKED' or NEW.state<>'REVOKED' then
    raise exception 'Only ACTIVE to REVOKED is permitted';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_entitlement() from public,anon,authenticated,service_role;
create trigger guard_entitlement before update or delete on public.commercial_v1_entitlements
for each row execute function commercial_v1_commerce_private.guard_entitlement();

create table public.commercial_v1_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique check(length(event_id) between 1 and 200),
  event_type text not null check(length(event_type) between 1 and 100),
  subject_id text check(length(subject_id) between 1 and 200),
  order_id uuid references public.commercial_v1_orders(id),
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  state text not null default 'RECEIVED' check(state in ('RECEIVED','RESOLVED','UNRESOLVED','IGNORED')),
  reason text not null default 'AWAITING_PROCESSING' check(reason ~ '^[A-Z_]{1,80}$')
);
create index commerce_webhook_queue on public.commercial_v1_webhook_receipts(state,received_at desc,id);
alter table public.commercial_v1_webhook_receipts enable row level security;
revoke all on public.commercial_v1_webhook_receipts from public,anon,authenticated,service_role;

create table public.commercial_v1_order_refunds (
  order_id uuid primary key references public.commercial_v1_orders(id),
  charge_id text not null check(length(charge_id) between 1 and 200),
  event_id text not null check(length(event_id) between 1 and 200),
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  verified_at timestamptz not null default clock_timestamp()
);
alter table public.commercial_v1_order_refunds enable row level security;
revoke all on public.commercial_v1_order_refunds from public,anon,authenticated,service_role;
create trigger refunds_append_only before update or delete on public.commercial_v1_order_refunds
for each row execute function commercial_v1_commerce_private.append_only();

-- Academic history stays intact. Only COMMERCE-created ACTIVE/PAUSED rows
-- become WITHDRAWN. ACADEMIC/UNKNOWN retain their governed academic status;
-- UNKNOWN still loses commercial content access. COMPLETED stays COMPLETED.
create function commercial_v1_commerce_private.revoke_entitlement(p_id uuid,p_actor uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.commercial_v1_entitlements; previous_status text; revoked_stamp timestamptz;
begin
  select * into e from public.commercial_v1_entitlements where id=p_id;
  if not found then return jsonb_build_object('ok',false,'code','ENTITLEMENT_NOT_FOUND'); end if;
  -- Same learner lock as fulfilment/academic writes, then entitlement/enrolment.
  perform 1 from public.student_profiles where user_id=e.learner_id for update;
  select * into e from public.commercial_v1_entitlements where id=p_id for update;
  if e.state='REVOKED' then return jsonb_build_object('ok',true,'code','ALREADY_REVOKED'); end if;
  select status into previous_status from public.enrolments where id=e.enrolment_id for update;
  update public.commercial_v1_entitlements set state='REVOKED',revoked_at=clock_timestamp(),revocation_reason=p_reason where id=e.id;
  perform set_config('app.audit_reason',p_reason,true);
  update public.enrolments set status='WITHDRAWN' where id=e.enrolment_id and e.enrolment_origin='COMMERCE' and status in ('ACTIVE','PAUSED');
  -- Generic Professor read leases have no enrolment identity. Conservatively
  -- abort this learner's in-flight leases at revocation; later requests for
  -- other paid courses remain permitted. Their existing lifecycle audit fires.
  revoked_stamp:=clock_timestamp();
  update public.academic_content_releases set
    state=case when expires_at<=revoked_stamp then 'EXPIRED' else 'ABORTED' end,
    terminal_at=least(expires_at,revoked_stamp)
    where student_id=e.learner_id and state='ACTIVE' and e.enrolment_origin<>'ACADEMIC';
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(p_actor,'COMMERCIAL_V1_ENTITLEMENT_REVOKED','commercial_v1_entitlements',e.id,'COMMERCE_OPERATIONS_V1',p_reason,
    jsonb_build_object('enrolment_id',e.enrolment_id,'previous_enrolment_status',previous_status,'enrolment_origin',e.enrolment_origin,'state','REVOKED'));
  return jsonb_build_object('ok',true,'code',case when e.enrolment_origin='COMMERCE' then 'ACCESS_REVOKED' else 'ENTITLEMENT_REVOKED' end);
end $$;
revoke all on function commercial_v1_commerce_private.revoke_entitlement(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.admin_revoke_commercial_v1_entitlement(p_entitlement_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb; linked_order uuid;
begin
  actor:=course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
  select order_id into linked_order from public.commercial_v1_entitlements where id=p_entitlement_id;
  -- Order first, matching refund and fulfilment. Complimentary grants have none.
  perform 1 from public.commercial_v1_orders where id=linked_order for update;
  result:=commercial_v1_commerce_private.revoke_entitlement(p_entitlement_id,actor,trim(p_reason));
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_ACCESS_CANCELLATION','commercial_v1_entitlements',p_entitlement_id,'COMMERCE_OPERATIONS_V1',trim(p_reason),result);
  return result;
end $$;
revoke all on function public.admin_revoke_commercial_v1_entitlement(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_revoke_commercial_v1_entitlement(uuid,text) to authenticated;

-- Revoked commercial access cannot be reactivated via an academic status edit.
create function commercial_v1_commerce_private.guard_revoked_enrolment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if NEW.status in ('ACTIVE','PAUSED') and exists(
    select 1 from public.commercial_v1_entitlements where enrolment_id=NEW.id and state='REVOKED' and enrolment_origin<>'ACADEMIC'
  ) then raise exception 'COMMERCIAL_ACCESS_REVOKED'; end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_revoked_enrolment() from public,anon,authenticated,service_role;
create trigger guard_revoked_commercial_enrolment before update of status on public.enrolments
for each row execute function commercial_v1_commerce_private.guard_revoked_enrolment();

-- Preserve original fulfilment rules, adding only immutable enrolment provenance.
-- The narrow wrapper retains the late-fulfilment refund/revocation barrier.
-- All existing entrypoints still converge here; refunded/revoked access can never
-- be re-granted by a late checkout event or a learner success-page replay.
alter function public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)
  set schema commercial_v1_commerce_private;
revoke all on function commercial_v1_commerce_private.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)
  from public,anon,authenticated,service_role;
-- The original fulfilment body below changes only provenance at INSERT:
-- COMMERCE iff its enrolment INSERT RETURNING actually created the row;
-- ACADEMIC iff it reused a pre-existing ACTIVE row. Both paths still use all
-- existing identity, payment, idempotency and upstream 044 cohort guards.
create or replace function commercial_v1_commerce_private.fulfill_commercial_v1_order(
  p_key_id uuid,p_order_id uuid,p_provider text,p_session_id text,p_event_id text,
  p_amount integer,p_currency text,p_status text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  order_record public.commercial_v1_orders%rowtype;
  entitlement_record public.commercial_v1_entitlements%rowtype;
  enrolment_id uuid;
  enrolment_status text;
  enrolment_origin text:='ACADEMIC';
begin
  if not commercial_v1_commerce_private.verify_fulfillment_claim(
    p_key_id,p_order_id,p_provider,p_session_id,p_event_id,p_amount,p_currency,p_status,p_issued_at,p_expires_at,p_mac
  ) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_CLAIM');
  end if;

  -- Lock the order FIRST, before any other read -- serializes a webhook and
  -- a success-page reconciliation racing for the SAME order, and serializes
  -- two webhook deliveries for the same order.
  select * into order_record from public.commercial_v1_orders where id=p_order_id for update;
  if not found then return jsonb_build_object('ok',false,'code','ORDER_NOT_FOUND'); end if;

  if order_record.provider_session_id is null then
    update public.commercial_v1_orders set provider_session_id=p_session_id where id=p_order_id;
    order_record.provider_session_id := p_session_id;
  elsif order_record.provider_session_id<>p_session_id then
    return jsonb_build_object('ok',false,'code','MISMATCHED_SESSION');
  end if;
  if order_record.amount_minor<>p_amount then return jsonb_build_object('ok',false,'code','MISMATCHED_AMOUNT'); end if;
  if order_record.currency<>p_currency then return jsonb_build_object('ok',false,'code','MISMATCHED_CURRENCY'); end if;

  -- Idempotent provenance: a duplicate provider event id is a REPLAY, not a
  -- new fact. Swallow the conflict and continue exactly as a first delivery
  -- would (the idempotent short-circuits below still apply identically).
  begin
    insert into public.commercial_v1_payment_events(order_id,provider,provider_event_id,session_id,amount_minor,currency,status)
    values(p_order_id,p_provider,p_event_id,p_session_id,p_amount,p_currency,p_status);
  exception when unique_violation then null;
  end;

  if order_record.state='FULFILLED' then
    select * into entitlement_record from public.commercial_v1_entitlements where order_id=p_order_id;
    if entitlement_record.id is null then
      -- V2 correction (finding 11): THIS order may have been a redundant
      -- duplicate payment whose entitlement was attributed to an EARLIER
      -- order for the same learner+course (see the on-conflict fallback
      -- below) -- the entitlement still exists, just keyed by that other
      -- order's id. Fall back to the stable per-learner-per-course lookup
      -- so a replay can never return a null entitlement/enrolment id.
      select * into entitlement_record from public.commercial_v1_entitlements
      where learner_id=order_record.learner_id and activation_id=order_record.activation_id;
    end if;
    return jsonb_build_object('ok',true,'fulfilled',true,'replay',true,'orderId',order_record.id,
      'entitlementId',entitlement_record.id,'enrolmentId',entitlement_record.enrolment_id,
      'activationId',order_record.activation_id);
  end if;

  if p_status<>'PAID' then
    return jsonb_build_object('ok',true,'fulfilled',false,'code','NOT_PAID','orderId',order_record.id);
  end if;

  -- Reproduce create_enrolment's OWN invariant checks (migration 007) --
  -- create_enrolment remains admin-only and is never called with borrowed
  -- authority. The enrolments table's own BEFORE INSERT triggers
  -- (prepare_enrolment_record / guard_enrolment_history) independently
  -- re-verify cohort/programme-version identity and PUBLISHED status
  -- regardless of caller, so those are not duplicated here.
  perform 1 from public.student_profiles where user_id=order_record.learner_id for update;
  if not found then return jsonb_build_object('ok',false,'code','LEARNER_NOT_FOUND'); end if;
  if not exists(select 1 from public.role_grants where user_id=order_record.learner_id and role='STUDENT') then
    return jsonb_build_object('ok',false,'code','LEARNER_NOT_STUDENT');
  end if;

  insert into public.enrolments(student_id,cohort_id,programme_version_id)
  values(order_record.learner_id,order_record.cohort_id,order_record.programme_version_id)
  on conflict(student_id,cohort_id) do nothing
  returning id into enrolment_id;

  if enrolment_id is null then
    select id,status into enrolment_id,enrolment_status
    from public.enrolments where student_id=order_record.learner_id and cohort_id=order_record.cohort_id;
  else
    enrolment_status := 'ACTIVE';
    enrolment_origin := 'COMMERCE';
  end if;

  -- V2 correction (finding 5): a FRESH insert is always 'ACTIVE'. Because
  -- create_commercial_v1_order now independently blocks purchase whenever
  -- ANY existing enrolment already exists for that cohort (see Section 9),
  -- reaching this point with a PRE-EXISTING, non-ACTIVE enrolment can only
  -- happen through a genuine race/concurrent academic action -- never
  -- auto-reactivate PAUSED/COMPLETED/WITHDRAWN here either. Fail closed and
  -- surface the reconciliation need instead of inventing entitlement
  -- behaviour (the payment_events row above already stands as bounded
  -- proof of the verified payment for that reconciliation).
  if enrolment_status<>'ACTIVE' then
    return jsonb_build_object('ok',false,'code','ENROLMENT_NOT_ACTIVATABLE','orderId',order_record.id,'enrolmentId',enrolment_id);
  end if;

  insert into public.commercial_v1_entitlements(learner_id,offer_id,activation_id,order_id,enrolment_id,enrolment_origin)
  values(order_record.learner_id,order_record.offer_id,order_record.activation_id,p_order_id,enrolment_id,enrolment_origin)
  on conflict(learner_id,activation_id) do nothing
  returning * into entitlement_record;

  if entitlement_record.id is null then
    -- A second successful payment for a course the learner already holds a
    -- DIFFERENT entitlement for. Never a second entitlement/enrolment row;
    -- this order is still marked fulfilled against the EXISTING
    -- entitlement (see docs/28 -- no automatic refund is issued for an
    -- accidental duplicate purchase; that is explicitly out of scope).
    select * into entitlement_record from public.commercial_v1_entitlements
    where learner_id=order_record.learner_id and activation_id=order_record.activation_id;
  end if;

  update public.commercial_v1_orders set state='FULFILLED',fulfilled_at=clock_timestamp() where id=p_order_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(order_record.learner_id,'COMMERCIAL_V1_ORDER_FULFILLED','commercial_v1_orders',p_order_id,'COMMERCIAL_V1_COMMERCE_V1',
    'Verified payment fulfilled',jsonb_build_object('order_id',p_order_id,'offer_id',order_record.offer_id,
      'activation_id',order_record.activation_id,'entitlement_id',entitlement_record.id,
      'enrolment_id',entitlement_record.enrolment_id,'amount_minor',p_amount,'currency',p_currency));

  return jsonb_build_object('ok',true,'fulfilled',true,'replay',false,'orderId',p_order_id,
    'entitlementId',entitlement_record.id,'enrolmentId',entitlement_record.enrolment_id,'activationId',order_record.activation_id);
end $$;

create function public.fulfill_commercial_v1_order(
  p_key_id uuid,p_order_id uuid,p_provider text,p_session_id text,p_event_id text,
  p_amount integer,p_currency text,p_status text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.commercial_v1_orders;
begin
  if not commercial_v1_commerce_private.verify_fulfillment_claim(p_key_id,p_order_id,p_provider,p_session_id,p_event_id,p_amount,p_currency,p_status,p_issued_at,p_expires_at,p_mac)
  then return jsonb_build_object('ok',false,'code','UNTRUSTED_CLAIM'); end if;
  select * into o from public.commercial_v1_orders where id=p_order_id for update;
  perform 1 from public.student_profiles where user_id=o.learner_id for update;
  if exists(
    select 1 from public.commercial_v1_entitlements where learner_id=o.learner_id and activation_id=o.activation_id and state='REVOKED' and enrolment_origin<>'ACADEMIC'
  ) then return jsonb_build_object('ok',false,'code','ACCESS_REVOKED'); end if;
  if exists(select 1 from public.commercial_v1_order_refunds where order_id=p_order_id) then
    return jsonb_build_object('ok',false,'code','ORDER_REFUNDED');
  end if;
  return commercial_v1_commerce_private.fulfill_commercial_v1_order(p_key_id,p_order_id,p_provider,p_session_id,p_event_id,p_amount,p_currency,p_status,p_issued_at,p_expires_at,p_mac);
end $$;
revoke all on function public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text) to anon,authenticated;

create function public.admin_reconcile_commercial_v1_order(
  p_key_id uuid,p_order_id uuid,p_provider text,p_session_id text,p_event_id text,
  p_amount integer,p_currency text,p_status text,p_issued_at bigint,p_expires_at bigint,p_mac text,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; result jsonb;
begin
  actor:=course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
  result:=public.fulfill_commercial_v1_order(p_key_id,p_order_id,p_provider,p_session_id,p_event_id,p_amount,p_currency,p_status,p_issued_at,p_expires_at,p_mac);
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_OPERATOR_RECONCILIATION','commercial_v1_orders',p_order_id,'COMMERCE_OPERATIONS_V1',trim(p_reason),result);
  return result;
end $$;
revoke all on function public.admin_reconcile_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_reconcile_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text,text) to authenticated;

-- New purpose-separated signed envelope. The MAC covers the exact bounded UTF8
-- payload, including operator identity where present. No generic signing oracle.
create function public.apply_commercial_v1_commerce_operation(
  p_key_id uuid,p_payload text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; mismatch integer:=0; i integer;
  stamp numeric:=extract(epoch from clock_timestamp()); x jsonb; actor uuid; o public.commercial_v1_orders;
  entitlement uuid; result jsonb; matched_order uuid; previous public.commercial_v1_webhook_receipts; inserted_count integer;
begin
  if p_payload is null or octet_length(p_payload)>4000 or p_key_id is null
    or p_issued_at is null or p_issued_at>stamp+30 or p_issued_at<stamp-300
    or p_expires_at is null or p_expires_at<=stamp or p_expires_at<=p_issued_at or p_expires_at>p_issued_at+60
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then raise exception 'UNTRUSTED_CLAIM'; end if;
  select secret into key_bytes from commercial_v1_commerce_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then raise exception 'UNTRUSTED_CLAIM'; end if;
  expected:=extensions.hmac(convert_to(concat_ws(E'\n','DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1',p_key_id::text,p_payload,p_issued_at::text,p_expires_at::text),'UTF8'),key_bytes,'sha256');
  supplied:=decode(p_mac,'hex');
  for i in 0..31 loop mismatch:=mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  if mismatch<>0 then raise exception 'UNTRUSTED_CLAIM'; end if;
  x:=p_payload::jsonb;
  if x->>'actorId' is not null then
    actor:=course_activation_private.require_admin();
    if actor::text<>x->>'actorId' then raise exception 'ACTOR_MISMATCH'; end if;
    if x->>'reason' is null or length(trim(x->>'reason')) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
  end if;
  if x->>'kind' in ('WEBHOOK_RECEIVED','WEBHOOK_RESULT') then
    if x->>'kind'='WEBHOOK_RECEIVED' then
      select id into matched_order from public.commercial_v1_orders where id=nullif(x->>'orderId','')::uuid;
      insert into public.commercial_v1_webhook_receipts(event_id,event_type,subject_id,order_id)
      values(x->>'eventId',x->>'eventType',x->>'subjectId',matched_order) on conflict(event_id) do nothing;
    else
      select * into previous from public.commercial_v1_webhook_receipts where event_id=x->>'eventId' for update;
      if not found then raise exception 'RECEIPT_REQUIRED'; end if;
      if x->>'state' not in ('RESOLVED','UNRESOLVED','IGNORED') then raise exception 'INVALID_STATE'; end if;
      select id into matched_order from public.commercial_v1_orders where id=nullif(x->>'orderId','')::uuid;
      update public.commercial_v1_webhook_receipts set state=x->>'state',reason=x->>'reason',updated_at=clock_timestamp(),
        order_id=coalesce(order_id,matched_order) where id=previous.id and state not in ('RESOLVED','IGNORED');
    end if;
    return jsonb_build_object('ok',true,'code','RECORDED');
  elsif x->>'kind'='OPERATOR_FAILURE' then
    if actor is null or x->>'code' is null or (x->>'code') !~ '^[A-Z_]{1,80}$' then raise exception 'INVALID_INPUT'; end if;
    insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COMMERCIAL_V1_OPERATOR_RECONCILIATION','commercial_v1_orders',(x->>'orderId')::uuid,'COMMERCE_OPERATIONS_V1',x->>'reason',jsonb_build_object('code',x->>'code'));
    return jsonb_build_object('ok',false,'code',x->>'code');
  elsif x->>'kind'='REFUND' then
    select * into o from public.commercial_v1_orders where id=(x->>'orderId')::uuid for update;
    if not found then return jsonb_build_object('ok',false,'code','ORDER_NOT_FOUND'); end if;
    if (o.provider_session_id is not null and o.provider_session_id is distinct from x->>'sessionId') or o.amount_minor is distinct from (x->>'amountMinor')::integer
      or o.currency is distinct from x->>'currency' then return jsonb_build_object('ok',false,'code','REFUND_MISMATCH'); end if;
    if (x->>'refundedMinor')::integer is distinct from o.amount_minor then return jsonb_build_object('ok',false,'code','PARTIAL_REFUND_REVIEW'); end if;
    if o.provider_session_id is null then update public.commercial_v1_orders set provider_session_id=x->>'sessionId' where id=o.id; end if;
    insert into public.commercial_v1_order_refunds(order_id,charge_id,event_id,amount_minor,currency)
    values(o.id,x->>'chargeId',x->>'eventId',o.amount_minor,o.currency) on conflict(order_id) do nothing;
    get diagnostics inserted_count = row_count;
    -- Only revoke THIS payment's entitlement; a redundant order must not revoke
    -- independently purchased or complimentary access to the same activation.
    select id into entitlement from public.commercial_v1_entitlements where order_id=o.id;
    if entitlement is null then result:=jsonb_build_object('ok',true,'code','REFUNDED_NO_LINKED_ENTITLEMENT');
    else result:=commercial_v1_commerce_private.revoke_entitlement(entitlement,actor,'Verified full Stripe refund'); end if;
    if actor is not null or inserted_count>0 then
      insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
      values(actor,'COMMERCIAL_V1_REFUND_RECONCILIATION','commercial_v1_orders',o.id,'COMMERCE_OPERATIONS_V1',
        case when actor is null then 'Verified full Stripe refund' else left(x->>'reason',300) end,result);
    end if;
    return result;
  end if;
  raise exception 'INVALID_OPERATION';
end $$;
revoke all on function public.apply_commercial_v1_commerce_operation(uuid,text,bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.apply_commercial_v1_commerce_operation(uuid,text,bigint,bigint,text) to anon,authenticated;

-- Additional restrictive content boundary. Existing RBAC/RLS must ALSO pass.
-- Retain enrolment/results/evidence/history reads, while closing course content
-- even for a completed (historically immutable) refunded enrolment.
create function public.commercial_v1_can_access_scope(p_version uuid,p_cohort uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN') or public.has_role('REGISTRAR') or public.has_role('INSTRUCTOR')
  or not exists(select 1 from public.enrolments e join public.commercial_v1_entitlements t on t.enrolment_id=e.id
    where e.student_id=public.current_app_user() and e.programme_version_id=p_version
      and (p_cohort is null or e.cohort_id=p_cohort) and t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC')
  or exists(select 1 from public.enrolments e where e.student_id=public.current_app_user() and e.programme_version_id=p_version
    and (p_cohort is null or e.cohort_id=p_cohort) and e.status in ('ACTIVE','PAUSED','COMPLETED')
    and not exists(select 1 from public.commercial_v1_entitlements t where t.enrolment_id=e.id and t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC'))
$$;
revoke all on function public.commercial_v1_can_access_scope(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.commercial_v1_can_access_scope(uuid,uuid) to authenticated;
create policy commerce_access on public.modules as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id));
create policy commerce_access on public.lessons as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id));
create policy commerce_access on public.lesson_objectives as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id));
create policy commerce_access on public.lesson_segments as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id));
create policy commerce_access on public.learning_resources as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id));
create policy commerce_access on public.assignments as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id,cohort_id));
create policy commerce_access on public.assessments as restrictive for select to authenticated using(public.commercial_v1_can_access_scope(programme_version_id,cohort_id));

-- Retained learner records must not depend on PostgREST curriculum embeds:
-- restrictive content RLS hides those rows after commercial access revocation.
-- Definer access supplies ONLY labels for this actor's existing history rows,
-- never objectives without history, lesson bodies, resources or assessment data.
create function public.get_student_retained_learning_history(p_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); result jsonb;
begin
  if actor is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_kind='evidence' then
    select coalesce(jsonb_agg(item order by stamp desc,id desc),'[]'::jsonb) into result from (
      select r.id,r.recorded_at stamp,jsonb_build_object(
        'id',r.id,'objective_id',r.objective_id,'evidence_kind',r.evidence_kind,'result',r.result,
        'evidence_reference',r.evidence_reference,'recorded_at',r.recorded_at,
        'lesson_objectives',jsonb_build_object('description',o.description,'position',o.position),
        'lessons',jsonb_build_object('title',l.title)) item
      from public.learning_evidence r join public.enrolments e on e.id=r.enrolment_id and e.student_id=r.student_id
      join public.lesson_objectives o on o.id=r.objective_id and o.lesson_id=r.lesson_id and o.programme_version_id=r.programme_version_id
      join public.lessons l on l.id=r.lesson_id and l.programme_version_id=r.programme_version_id
      where r.student_id=actor order by r.recorded_at desc,r.id desc limit 500
    ) history;
  elsif p_kind='mastery' then
    select coalesce(jsonb_agg(item order by stamp desc,id desc),'[]'::jsonb) into result from (
      select r.id,r.evaluated_at stamp,jsonb_build_object(
        'id',r.id,'objective_id',r.objective_id,'lesson_id',r.lesson_id,'state',r.state,
        'evidence_count',r.evidence_count,'correct_evidence_count',r.correct_evidence_count,
        'correct_session_count',r.correct_session_count,'correct_kind_count',r.correct_kind_count,
        'policy_version',r.policy_version,'evaluated_at',r.evaluated_at,
        'lesson_objectives',jsonb_build_object('description',o.description,'position',o.position,
          'lessons',jsonb_build_object('title',l.title))) item
      from public.objective_mastery r join public.enrolments e on e.id=r.enrolment_id and e.student_id=r.student_id
      join public.lesson_objectives o on o.id=r.objective_id and o.lesson_id=r.lesson_id and o.programme_version_id=r.programme_version_id
      join public.lessons l on l.id=r.lesson_id and l.programme_version_id=r.programme_version_id
      where r.student_id=actor order by r.evaluated_at desc,r.id desc limit 500
    ) history;
  elsif p_kind='progress' then
    select coalesce(jsonb_agg(item order by stamp desc,id desc),'[]'::jsonb) into result from (
      select r.id,r.updated_at stamp,jsonb_build_object(
        'id',r.id,'lesson_id',r.lesson_id,'segment_id',r.segment_id,'status',r.status,'updated_at',r.updated_at,
        'lesson_segments',jsonb_build_object('title',s.title,'position',s.position,
          'lessons',jsonb_build_object('title',l.title))) item
      from public.lesson_progress r join public.enrolments e on e.id=r.enrolment_id and e.student_id=r.student_id
      join public.lesson_segments s on s.id=r.segment_id and s.lesson_id=r.lesson_id and s.programme_version_id=r.programme_version_id
      join public.lessons l on l.id=r.lesson_id and l.programme_version_id=r.programme_version_id
      where r.student_id=actor order by r.updated_at desc,r.id desc limit 500
    ) history;
  else raise exception 'INVALID_HISTORY_KIND'; end if;
  return result;
end $$;
revoke all on function public.get_student_retained_learning_history(text) from public,anon,authenticated,service_role;
grant execute on function public.get_student_retained_learning_history(text) to authenticated;

-- A single bounded diagnosis uses database state, including a missing order.
create function public.admin_diagnose_commercial_v1_access(p_learner_id uuid,p_offer_id uuid,p_order_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.commercial_v1_orders; t public.commercial_v1_entitlements; e public.enrolments;
  offer public.commercial_v1_offers; activation public.course_activations; learner_name text;
  payments jsonb; audits jsonb; reason text; paid boolean; refunded boolean; version_label text; course_title text;
  learner_enabled boolean; learner_student boolean;
begin
  perform course_activation_private.require_admin();
  if p_order_id is not null then
    select * into o from public.commercial_v1_orders where id=p_order_id;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
    p_learner_id:=o.learner_id; p_offer_id:=o.offer_id;
  end if;
  select display_name into learner_name from public.app_users where id=p_learner_id;
  if not found then raise exception 'LEARNER_NOT_FOUND'; end if;
  select coalesce(to_jsonb(u)->>'account_status','ACTIVE')='ACTIVE' and a.email_confirmed_at is not null,
    exists(select 1 from public.role_grants where user_id=u.id and role='STUDENT') into learner_enabled,learner_student
    from public.app_users u left join auth.users a on a.id=u.auth_user_id where u.id=p_learner_id;
  select * into offer from public.commercial_v1_offers where id=p_offer_id;
  if not found then raise exception 'OFFER_NOT_FOUND'; end if;
  select * into activation from public.course_activations where id=offer.activation_id;
  if o.id is null then
    select * into o from public.commercial_v1_orders where learner_id=p_learner_id and offer_id=p_offer_id order by created_at desc,id desc limit 1;
  end if;
  select * into t from public.commercial_v1_entitlements where learner_id=p_learner_id and activation_id=activation.id;
  select * into e from public.enrolments where student_id=p_learner_id and cohort_id=activation.cohort_id;
  select v.label,coalesce(v.title_snapshot,p.title) into version_label,course_title from public.programme_versions v join public.programmes p on p.id=v.programme_id where v.id=activation.programme_version_id;
  paid:=exists(select 1 from public.commercial_v1_payment_events where order_id=o.id and status='PAID');
  refunded:=exists(select 1 from public.commercial_v1_order_refunds where order_id=o.id);
  reason:=case
    when not coalesce(learner_enabled,false) then 'ACCOUNT_UNAVAILABLE'
    when not learner_student then 'LEARNER_NOT_STUDENT'
    when t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC' then 'ENTITLEMENT_REVOKED'
    when refunded and t.id is null then 'ORDER_REFUNDED'
    when e.id is not null and e.status<>'ACTIVE' then 'ENROLMENT_'||e.status
    when t.id is not null and (e.id is null or t.enrolment_id<>e.id) then 'ENTITLEMENT_ENROLMENT_MISMATCH'
    when e.status='ACTIVE' then 'ACCESS_ACTIVE'
    when o.state='FULFILLED' and t.id is null then 'FULFILLED_WITHOUT_ENTITLEMENT'
    when paid and t.id is null then 'PAID_AWAITING_FULFILMENT'
    when o.id is null then 'NO_ORDER_OR_ENROLMENT'
    when o.provider_session_id is null then 'CHECKOUT_NOT_BOUND'
    else 'PAYMENT_NOT_CONFIRMED' end;
  select coalesce(jsonb_agg(row_value order by stamp desc),'[]'::jsonb) into payments from (
    select verified_at stamp,jsonb_build_object('eventId',provider_event_id,'status',status,'amountMinor',amount_minor,'currency',currency,'verifiedAt',verified_at) row_value
    from public.commercial_v1_payment_events where order_id=o.id order by verified_at desc,id desc limit 50
  ) q;
  select coalesce(jsonb_agg(row_value order by stamp desc),'[]'::jsonb) into audits from (
    select a.occurred_at stamp,jsonb_build_object('action',a.action,'actor',coalesce(u.display_name,'Stripe webhook'),'reason',a.reason,'at',a.occurred_at) row_value
    from public.audit_events a left join public.app_users u on u.id=a.actor_id
    where (a.target_id=o.id or a.target_id=t.id or a.target_id=e.id)
      and (a.action like 'COMMERCIAL_V1_%' or a.target_type='enrolments')
    order by a.occurred_at desc,a.id desc limit 50
  ) q;
  return jsonb_build_object(
    'learnerId',p_learner_id,'learnerName',learner_name,'offerId',offer.id,'offerSlug',offer.slug,
    'courseTitle',course_title,'versionLabel',version_label,'programmeVersionId',activation.programme_version_id,
    'cohortId',activation.cohort_id,'cohortTitle',(select title from public.cohorts where id=activation.cohort_id),'activationId',activation.id,
    'orderId',o.id,'orderState',o.state,'orderCreatedAt',o.created_at,'sessionId',o.provider_session_id,'amountMinor',o.amount_minor,'currency',o.currency,
    'paymentConfirmed',paid,'refunded',refunded,'fulfilmentAttempted',coalesce(o.state='FULFILLED',false)
      or exists(select 1 from public.commercial_v1_payment_events where order_id=o.id)
      or exists(select 1 from public.commercial_v1_webhook_receipts w where w.order_id=o.id and w.reason='FULFILMENT_UNAVAILABLE'),
    'entitlementId',t.id,'entitlementState',t.state,'entitlementSource',t.source,'entitlementOrderId',t.order_id,
    'revocationReason',t.revocation_reason,'enrolmentId',e.id,'enrolmentStatus',e.status,'enrolmentOrigin',t.enrolment_origin,
    'hasAccess',reason='ACCESS_ACTIVE','accessReason',reason,'payments',payments,'audit',audits,
    'reconciliationState',case when refunded then 'FULL_REFUND_RECORDED' when o.state='FULFILLED' and t.id is null then 'FULFILLED_WITHOUT_ENTITLEMENT'
      when paid and o.state='PENDING' then 'PAID_AWAITING_FULFILMENT' when o.state='FULFILLED' and e.status<>'ACTIVE' then 'FULFILLED_WITH_NON_ACTIVE_ENROLMENT'
      when o.state='FULFILLED' then 'FULFILLED' else 'NO_CONFIRMED_FULFILMENT' end,
    'paymentsTruncated',(select count(*)>50 from public.commercial_v1_payment_events where order_id=o.id),
    'auditTruncated',(select count(*)>50 from public.audit_events where target_id in (o.id,t.id,e.id) and (action like 'COMMERCIAL_V1_%' or target_type='enrolments'))
  );
end $$;
revoke all on function public.admin_diagnose_commercial_v1_access(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_diagnose_commercial_v1_access(uuid,uuid,uuid) to authenticated;

-- Each tab has independent bounded, searchable pagination. Search never selects
-- emails, support prose, raw Stripe objects or secret/controller material.
create function public.admin_list_commercial_v1_operations(p_view text,p_query text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform course_activation_private.require_admin();
  if p_view is null or p_view not in ('orders','entitlements','redemptions','issues','offers','learners','audit')
    or p_query is null or length(p_query)>100 or p_offset is null or p_offset<0 or p_offset>100000 then raise exception 'INVALID_INPUT'; end if;
  with rows as (
    select o.id::text id,u.display_name title,f.slug subtitle,o.state state,o.created_at stamp,o.id order_id,t.id entitlement_id,o.learner_id,f.id offer_id,
      case when t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC' then 'ENTITLEMENT_REVOKED' when e.status<>'ACTIVE' then 'ENROLMENT_'||e.status
        when o.state='FULFILLED' and t.id is null then 'FULFILLED_WITHOUT_ENTITLEMENT'
        when exists(select 1 from public.commercial_v1_payment_events p where p.order_id=o.id and p.status='PAID') and o.state='PENDING' then 'PAID_AWAITING_FULFILMENT' else null end reason
    from public.commercial_v1_orders o join public.app_users u on u.id=o.learner_id join public.commercial_v1_offers f on f.id=o.offer_id
    left join public.commercial_v1_entitlements t on t.learner_id=o.learner_id and t.activation_id=o.activation_id
    left join public.enrolments e on e.student_id=o.learner_id and e.cohort_id=o.cohort_id where p_view='orders'
    union all
    select t.id::text,u.display_name,f.slug,t.state,t.created_at,t.order_id,t.id,t.learner_id,f.id,t.revocation_reason
    from public.commercial_v1_entitlements t join public.app_users u on u.id=t.learner_id join public.commercial_v1_offers f on f.id=t.offer_id where p_view='entitlements'
    union all
    select r.id::text,u.display_name,c.code||' / '||f.slug,coalesce(t.state,'NO_ENTITLEMENT')||' / '||coalesce(e.status,'NO_ENROLMENT'),r.redeemed_at,o.id,t.id,r.learner_id,f.id,null
    from public.commercial_v1_campaign_redemptions r join public.app_users u on u.id=r.learner_id join public.commercial_v1_campaigns c on c.id=r.campaign_id
    join public.commercial_v1_offers f on f.id=r.offer_id left join public.commercial_v1_orders o on o.campaign_redemption_id=r.id
    left join public.commercial_v1_entitlements t on t.campaign_redemption_id=r.id or t.order_id=o.id
    left join public.enrolments e on e.id=t.enrolment_id where p_view='redemptions'
    union all
    select w.id::text,w.event_id,w.event_type||coalesce(' / '||w.subject_id,''),w.state,w.received_at,w.order_id,null,null,null,w.reason
    from public.commercial_v1_webhook_receipts w where p_view='issues'
    union all
    select f.id::text,coalesce(v.title_snapshot,p.title),f.slug||' / '||c.title||' / '||f.price_amount_minor::text||' '||f.currency,f.state,f.created_at,null,null,null,f.id,null
    from public.commercial_v1_offers f join public.course_activations a on a.id=f.activation_id join public.cohorts c on c.id=a.cohort_id
    join public.programme_versions v on v.id=a.programme_version_id join public.programmes p on p.id=v.programme_id where p_view='offers'
    union all
    select u.id::text,u.display_name,s.student_number,'LEARNER',null,null,null,u.id,null,null
    from public.student_profiles s join public.app_users u on u.id=s.user_id where p_view='learners' and not u.is_demo
    union all
    select a.id::text,coalesce(u.display_name,'Stripe webhook'),coalesce(a.reason,''),a.action,a.occurred_at,
      case when a.target_type='commercial_v1_orders' then a.target_id else null end,
      case when a.target_type='commercial_v1_entitlements' then a.target_id else null end,null,null,null
    from public.audit_events a left join public.app_users u on u.id=a.actor_id where p_view='audit' and a.action like 'COMMERCIAL_V1_%'
      and a.target_type in ('commercial_v1_orders','commercial_v1_offers','commercial_v1_campaigns','commercial_v1_campaign_redemptions',
        'commercial_v1_entitlements','commercial_v1_webhook_receipts','commercial_v1_order_refunds')
  ), bounded as (
    select * from rows where p_query='' or position(lower(p_query) in lower(concat_ws(' ',id,title,subtitle,reason)))>0
    order by stamp desc nulls last,id desc limit 26 offset p_offset
  ) select jsonb_build_object('hasMore',count(*)>25,'rows',coalesce((select jsonb_agg(jsonb_build_object(
    'id',id,'title',title,'subtitle',subtitle,'state',state,'occurredAt',stamp,'orderId',order_id,
    'entitlementId',entitlement_id,'learnerId',learner_id,'offerId',offer_id,'reason',reason) order by stamp desc nulls last,id desc)
    from (select * from bounded order by stamp desc nulls last,id desc limit 25) shown),'[]'::jsonb)) into result from bounded;
  return result;
end $$;
revoke all on function public.admin_list_commercial_v1_operations(text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.admin_list_commercial_v1_operations(text,text,integer) to authenticated;

create function public.admin_prepare_commercial_v1_webhook_retry(p_receipt_id uuid,p_reason text)
returns text language plpgsql security definer set search_path='' as $$
declare actor uuid; event text;
begin
  actor:=course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
  select event_id into event from public.commercial_v1_webhook_receipts where id=p_receipt_id for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if exists(select 1 from public.commercial_v1_webhook_receipts where id=p_receipt_id and state in ('RESOLVED','IGNORED')) then raise exception 'RECEIPT_TERMINAL'; end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_WEBHOOK_RECOVERY','commercial_v1_webhook_receipts',p_receipt_id,'COMMERCE_OPERATIONS_V1',trim(p_reason),jsonb_build_object('event_id',event));
  return event;
end $$;
revoke all on function public.admin_prepare_commercial_v1_webhook_retry(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_prepare_commercial_v1_webhook_retry(uuid,text) to authenticated;

create function public.admin_prepare_commercial_v1_reconciliation(p_order_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor:=course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
  if not exists(select 1 from public.commercial_v1_orders where id=p_order_id) then raise exception 'ORDER_NOT_FOUND'; end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_RECONCILIATION_REQUESTED','commercial_v1_orders',p_order_id,'COMMERCE_OPERATIONS_V1',trim(p_reason),jsonb_build_object('state','REQUESTED'));
end $$;
revoke all on function public.admin_prepare_commercial_v1_reconciliation(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_prepare_commercial_v1_reconciliation(uuid,text) to authenticated;

-- Protected content uses SECURITY DEFINER and therefore needs its own explicit
-- revocation check in addition to table RLS, including an already-live attempt.
alter function public.get_active_assessment_questions(uuid) set schema commercial_v1_commerce_private;
revoke all on function commercial_v1_commerce_private.get_active_assessment_questions(uuid) from public,anon,authenticated,service_role;
create function public.get_active_assessment_questions(p_assessment_id uuid)
returns table(id uuid,"position" integer,prompt text,max_marks integer)
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.student_profiles where user_id=public.current_app_user() for update;
  if exists(select 1 from public.assessments a join public.enrolments e on e.cohort_id=a.cohort_id and e.programme_version_id=a.programme_version_id
    join public.commercial_v1_entitlements t on t.enrolment_id=e.id
    where a.id=p_assessment_id and e.student_id=public.current_app_user() and t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC') then
    raise exception 'COMMERCIAL_ACCESS_REVOKED' using errcode='42501';
  end if;
  return query select * from commercial_v1_commerce_private.get_active_assessment_questions(p_assessment_id);
end $$;
revoke all on function public.get_active_assessment_questions(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_active_assessment_questions(uuid) to authenticated;

-- A learner may already have an open assessment when access is revoked. Deny
-- further learner writes through both response APIs and explicit submission,
-- retaining attempts/responses and leaving deadline finalisation authoritative.
-- Lock the learner before the original RPC takes the attempt lock, matching
-- start/fulfilment/revocation. The original grading and timeout rules are intact.
create function commercial_v1_commerce_private.require_attempt_access(p_attempt_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.student_profiles where user_id=public.current_app_user() for update;
  if exists(select 1 from public.assessment_attempts a
    join public.assessments s on s.id=a.assessment_id
    join public.enrolments e on e.student_id=a.student_id and e.cohort_id=s.cohort_id and e.programme_version_id=s.programme_version_id
    join public.commercial_v1_entitlements t on t.enrolment_id=e.id
    where a.id=p_attempt_id and a.student_id=public.current_app_user() and t.state='REVOKED' and t.enrolment_origin<>'ACADEMIC') then
    raise exception 'COMMERCIAL_ACCESS_REVOKED' using errcode='42501';
  end if;
end $$;
revoke all on function commercial_v1_commerce_private.require_attempt_access(uuid) from public,anon,authenticated,service_role;

alter function public.record_assessment_response(uuid,uuid,text,text) set schema commercial_v1_commerce_private;
revoke all on function commercial_v1_commerce_private.record_assessment_response(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.record_assessment_response(p_attempt_id uuid,p_question_id uuid,p_body text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform commercial_v1_commerce_private.require_attempt_access(p_attempt_id);
  return commercial_v1_commerce_private.record_assessment_response(p_attempt_id,p_question_id,p_body,p_idempotency_key);
end $$;
revoke all on function public.record_assessment_response(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.record_assessment_response(uuid,uuid,text,text) to authenticated;

alter function public.record_commercial_v1_assessment_response(uuid,uuid,text,text) set schema commercial_v1_commerce_private;
revoke all on function commercial_v1_commerce_private.record_commercial_v1_assessment_response(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.record_commercial_v1_assessment_response(p_attempt_id uuid,p_question_id uuid,p_body text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform commercial_v1_commerce_private.require_attempt_access(p_attempt_id);
  return commercial_v1_commerce_private.record_commercial_v1_assessment_response(p_attempt_id,p_question_id,p_body,p_idempotency_key);
end $$;
revoke all on function public.record_commercial_v1_assessment_response(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.record_commercial_v1_assessment_response(uuid,uuid,text,text) to authenticated;

alter function public.submit_assessment_attempt(uuid) set schema commercial_v1_commerce_private;
revoke all on function commercial_v1_commerce_private.submit_assessment_attempt(uuid) from public,anon,authenticated,service_role;
create function public.submit_assessment_attempt(p_attempt_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform commercial_v1_commerce_private.require_attempt_access(p_attempt_id);
  return commercial_v1_commerce_private.submit_assessment_attempt(p_attempt_id);
end $$;
revoke all on function public.submit_assessment_attempt(uuid) from public,anon,authenticated,service_role;
grant execute on function public.submit_assessment_attempt(uuid) to authenticated;

-- Public offer projection must not claim a revoked entitlement is active.
create or replace function public.get_commercial_v1_offer(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  o public.commercial_v1_offers%rowtype;
  p_title text;
  p_body text;
  p_qual text;
  starts date;
  a_cohort uuid;
  actor uuid;
  entitled boolean:=false;
  enrolment uuid;
  viewer_status text:='NONE';
begin
  select * into o from public.commercial_v1_offers
  where slug=p_slug and state='PUBLISHED';
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;

  select p.title,p.examination_body,p.qualification_name,c.starts_on,a.cohort_id
  into p_title,p_body,p_qual,starts,a_cohort
  from public.course_activations a
  join public.cohorts c on c.id=a.cohort_id
  join public.programme_versions v on v.id=a.programme_version_id
  join public.programmes p on p.id=v.programme_id
  where a.id=o.activation_id;

  actor := public.current_app_user();
  if actor is not null and public.has_role('STUDENT') then
    select e.enrolment_id into enrolment
    from public.commercial_v1_entitlements e
    where e.learner_id=actor and e.activation_id=o.activation_id and e.state='ACTIVE';
    entitled := enrolment is not null;

    select status into viewer_status
    from public.enrolments
    where student_id=actor and cohort_id=a_cohort;
    viewer_status := coalesce(viewer_status,'NONE');
  end if;

  return jsonb_build_object(
    'ok',true,
    'slug',o.slug,
    'title',p_title,
    'examinationBody',p_body,
    'qualificationName',p_qual,
    'priceAmountMinor',o.price_amount_minor,
    'currency',o.currency,
    'summary',o.summary,
    'cohortStartsOn',starts,
    'deliveryPlan',o.delivery_plan,
    'viewerAuthenticated',actor is not null,
    'viewerEntitled',entitled,
    'viewerEnrolmentId',enrolment,
    'viewerEnrolmentStatus',viewer_status
  );
end $$;
revoke all on function public.get_commercial_v1_offer(text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_commercial_v1_offer(text) to anon,authenticated;


-- Existing learner reconciliation must not report revoked access as fulfilled.
create or replace function public.get_commercial_v1_order(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; o public.commercial_v1_orders%rowtype; slug text;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  select * into o from public.commercial_v1_orders where id=p_order_id;
  if not found or not (o.learner_id=actor or public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;
  select s.slug into slug from public.commercial_v1_offers s where s.id=o.offer_id;
  return jsonb_build_object('ok',true,'order',jsonb_build_object('id',o.id,'state',o.state,'offerSlug',slug,
    'orderRefunded',exists(select 1 from public.commercial_v1_order_refunds where order_id=o.id),
    'accessRevoked',exists(select 1 from public.commercial_v1_entitlements where learner_id=o.learner_id and activation_id=o.activation_id and state='REVOKED' and enrolment_origin<>'ACADEMIC'),'activationId',o.activation_id,'amountMinor',o.amount_minor,'currency',o.currency,'fulfilledAt',o.fulfilled_at));
end $$;
revoke all on function public.get_commercial_v1_order(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_commercial_v1_order(uuid) to authenticated;


-- SECURITY DEFINER practical/delivery reads bypass table RLS. Preserve their
-- existing ownership/academic rules and add explicit commercial revocation.
create or replace function course_activation_private.student_enrolment(p_id uuid) returns public.enrolments language plpgsql security definer set search_path='' as $$
declare e public.enrolments; actor uuid:=public.current_app_user(); begin
 if actor is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 perform 1 from public.student_profiles where user_id=actor for update;
 select * into e from public.enrolments where id=p_id and student_id=actor;
 if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 if exists(select 1 from public.commercial_v1_entitlements where enrolment_id=e.id and state='REVOKED' and enrolment_origin<>'ACADEMIC') then raise exception 'COMMERCIAL_ACCESS_REVOKED' using errcode='42501'; end if;
 return e;
end $$;
create or replace function delivery_private.enrolment(p_id uuid,p_staff boolean default false,p_active boolean default false)
returns public.enrolments language plpgsql security definer set search_path='' as $$
declare e public.enrolments; actor uuid:=public.current_app_user();
begin
  if actor is null then raise exception 'UNAUTHENTICATED' using errcode='42501'; end if;
  if not p_staff and not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into e from public.enrolments where id=p_id for update;
  if e.id is null or (not p_staff and e.student_id<>actor)
    or (p_staff and not (public.is_academic_admin() or public.is_assigned_counsellor(e.student_id))) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501';
  end if;
  if p_active and e.status<>'ACTIVE' then raise exception 'POLICY_BLOCKED'; end if;
  if not p_staff and exists(select 1 from public.commercial_v1_entitlements where enrolment_id=e.id and state='REVOKED' and enrolment_origin<>'ACADEMIC') then raise exception 'COMMERCIAL_ACCESS_REVOKED' using errcode='42501'; end if;
  return e;
end $$;
