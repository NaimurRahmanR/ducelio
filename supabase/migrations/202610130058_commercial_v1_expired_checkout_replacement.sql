-- LR-03: let a learner resume purchase after their Stripe Checkout Session
-- expired. Migrations 001-057 are byte-for-byte unchanged.
--
-- Defect. A learner has at most one PENDING order per offer, reused on every
-- checkout attempt, and migration 034's guard_order makes the order's bound
-- Stripe session immutable. Stripe expires a Checkout Session (default 24
-- hours) and forgets its idempotency key (about 24 hours). A learner who
-- abandons checkout and returns later therefore gets a new Stripe session
-- that can never be bound, while the bound one has no URL, so checkout
-- failed closed with CHECKOUT_UNAVAILABLE for that course permanently.
--
-- Correction. One narrowly scoped, attested replacement:
-- 1. public.commercial_v1_checkout_session_replacements is append-only
--    provenance: order, superseded session, replacement session, learner and
--    time. Each session id can appear at most once on each side, so an
--    expired session is superseded at most once and a replacement is never
--    reused.
-- 2. guard_order is re-created from its LATEST definition (migration 039,
--    which added campaign_redemption_id to the immutable financial identity)
--    with ONE added exception: a PENDING order may change its bound session
--    only to the exact replacement recorded for the exact currently bound
--    session. Every other session change still raises 'A bound Stripe
--    checkout session cannot be replaced'. Financial identity (including
--    039's campaign_redemption_id), delete and reopen guards are unchanged.
-- 3. public.replace_expired_commercial_v1_checkout_session is the only
--    writer. It is HMAC-attested with the existing commerce controller key
--    store under its own tag, DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1
--    (domain-separated from the operations and fulfilment tags), with the
--    same freshness window as apply_commercial_v1_commerce_operation. The
--    server signs only after Stripe itself reports the bound session
--    'expired' and unpaid; the database binds the attested learner to the
--    calling learner, who must own the PENDING order. It is idempotent and
--    audited (COMMERCIAL_V1_CHECKOUT_SESSION_REPLACED).
--
-- 4. public.get_my_commercial_v1_checkout_binding lets the owning learner
--    read their own order's state and currently bound session id, so the
--    server inspects the authoritative binding BEFORE choosing an
--    idempotency key (review finding: Stripe may keep returning a cached,
--    expired session for the original order key).
--
-- Fulfilment, reconciliation and refund authority are unchanged: they still
-- accept only the order's currently bound session, so a payment can only
-- ever complete against the live replacement.

create table public.commercial_v1_checkout_session_replacements (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commercial_v1_orders(id),
  superseded_session_id text not null unique
    check (length(superseded_session_id) between 1 and 200),
  replacement_session_id text not null unique
    check (replacement_session_id ~ '^cs_[A-Za-z0-9_]{1,197}$'),
  replaced_by uuid not null references public.app_users(id),
  replaced_at timestamptz not null default clock_timestamp(),
  check (superseded_session_id <> replacement_session_id)
);
create index commercial_v1_checkout_session_replacements_order
  on public.commercial_v1_checkout_session_replacements(order_id);
alter table public.commercial_v1_checkout_session_replacements enable row level security;
revoke all on public.commercial_v1_checkout_session_replacements
  from public, anon, authenticated, service_role;

create function commercial_v1_commerce_private.guard_checkout_session_replacement()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Checkout session replacement history is append-only';
end $$;
revoke all on function commercial_v1_commerce_private.guard_checkout_session_replacement()
  from public, anon, authenticated, service_role;
create trigger guard_checkout_session_replacement
before update or delete on public.commercial_v1_checkout_session_replacements
for each row execute function commercial_v1_commerce_private.guard_checkout_session_replacement();

create or replace function commercial_v1_commerce_private.guard_order() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial orders cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.learner_id<>OLD.learner_id or NEW.offer_id<>OLD.offer_id
    or NEW.activation_id<>OLD.activation_id or NEW.cohort_id<>OLD.cohort_id
    or NEW.programme_version_id<>OLD.programme_version_id or NEW.amount_minor<>OLD.amount_minor
    or NEW.currency<>OLD.currency or NEW.provider<>OLD.provider or NEW.created_at<>OLD.created_at
    or NEW.campaign_redemption_id is distinct from OLD.campaign_redemption_id then
    raise exception 'Commercial order financial identity is immutable';
  end if;
  if OLD.provider_session_id is not null and NEW.provider_session_id is distinct from OLD.provider_session_id then
    -- LR-03: the single permitted change -- an attested replacement of the
    -- exact bound session on a still-PENDING order.
    if not (
      OLD.state = 'PENDING' and NEW.state = 'PENDING'
      and NEW.provider_session_id is not null
      and exists (
        select 1 from public.commercial_v1_checkout_session_replacements r
        where r.order_id = OLD.id
          and r.superseded_session_id = OLD.provider_session_id
          and r.replacement_session_id = NEW.provider_session_id
      )
    ) then
      raise exception 'A bound Stripe checkout session cannot be replaced';
    end if;
  end if;
  if OLD.state='FULFILLED' and NEW.state<>'FULFILLED' then
    raise exception 'A fulfilled order cannot be reopened';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_order() from public,anon,authenticated,service_role;

create function public.replace_expired_commercial_v1_checkout_session(
  p_key_id uuid, p_payload text, p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  key_bytes bytea; expected bytea; supplied bytea; mismatch integer := 0; i integer;
  stamp numeric := extract(epoch from clock_timestamp());
  x jsonb; actor uuid; o public.commercial_v1_orders%rowtype;
  expired_id text; replacement_id text;
begin
  if p_payload is null or octet_length(p_payload) > 1000 or p_key_id is null
    or p_issued_at is null or p_issued_at > stamp + 30 or p_issued_at < stamp - 300
    or p_expires_at is null or p_expires_at <= stamp or p_expires_at <= p_issued_at
    or p_expires_at > p_issued_at + 60
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then
    raise exception 'UNTRUSTED_CLAIM';
  end if;
  select secret into key_bytes from commercial_v1_commerce_private.controller_keys
  where id = p_key_id and revoked_at is null;
  if not found then raise exception 'UNTRUSTED_CLAIM'; end if;
  expected := extensions.hmac(convert_to(concat_ws(E'\n',
    'DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1', p_key_id::text, p_payload,
    p_issued_at::text, p_expires_at::text), 'UTF8'), key_bytes, 'sha256');
  supplied := decode(p_mac, 'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected, i) # get_byte(supplied, i)); end loop;
  if mismatch <> 0 then raise exception 'UNTRUSTED_CLAIM'; end if;

  x := p_payload::jsonb;
  if jsonb_typeof(x) <> 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(x) k)
      <> array['expiredSessionId', 'learnerId', 'orderId', 'replacementSessionId'] then
    raise exception 'INVALID_INPUT';
  end if;
  expired_id := x->>'expiredSessionId';
  replacement_id := x->>'replacementSessionId';
  if expired_id is null or length(expired_id) not between 1 and 200
    or replacement_id is null or replacement_id !~ '^cs_[A-Za-z0-9_]{1,197}$'
    or expired_id = replacement_id then
    raise exception 'INVALID_INPUT';
  end if;

  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  if actor::text <> x->>'learnerId' then raise exception 'ACTOR_MISMATCH'; end if;

  select * into o from public.commercial_v1_orders
  where id = (x->>'orderId')::uuid and learner_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if o.state <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if o.provider_session_id = replacement_id and exists (
    select 1 from public.commercial_v1_checkout_session_replacements r
    where r.order_id = o.id and r.superseded_session_id = expired_id
      and r.replacement_session_id = replacement_id
  ) then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_REPLACED');
  end if;
  if o.provider_session_id is distinct from expired_id then
    return jsonb_build_object('ok', false, 'code', 'SESSION_CHANGED');
  end if;

  insert into public.commercial_v1_checkout_session_replacements
    (order_id, superseded_session_id, replacement_session_id, replaced_by)
  values (o.id, expired_id, replacement_id, actor);
  update public.commercial_v1_orders set provider_session_id = replacement_id
  where id = o.id and provider_session_id = expired_id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, before_state, after_state)
  values (actor, 'COMMERCIAL_V1_CHECKOUT_SESSION_REPLACED', 'commercial_v1_orders', o.id,
    'COMMERCE_OPERATIONS_V1', 'Expired unpaid checkout session replaced',
    jsonb_build_object('sessionId', expired_id), jsonb_build_object('sessionId', replacement_id));
  return jsonb_build_object('ok', true, 'code', 'REPLACED');
end $$;
revoke all on function public.replace_expired_commercial_v1_checkout_session(uuid, text, bigint, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_expired_commercial_v1_checkout_session(uuid, text, bigint, bigint, text)
  to authenticated;

create function public.get_my_commercial_v1_checkout_binding(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := public.current_app_user(); o public.commercial_v1_orders%rowtype;
begin
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  select * into o from public.commercial_v1_orders where id = p_order_id and learner_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  return jsonb_build_object('ok', true, 'state', o.state, 'sessionId', o.provider_session_id);
end $$;
revoke all on function public.get_my_commercial_v1_checkout_binding(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_commercial_v1_checkout_binding(uuid) to authenticated;

-- Migration-time self-verification of exactly what this migration owns.
do $$
begin
  if has_function_privilege('anon', 'public.replace_expired_commercial_v1_checkout_session(uuid,text,bigint,bigint,text)', 'execute')
    or has_function_privilege('service_role', 'public.replace_expired_commercial_v1_checkout_session(uuid,text,bigint,bigint,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.replace_expired_commercial_v1_checkout_session(uuid,text,bigint,bigint,text)', 'execute') then
    raise exception 'replace_expired_commercial_v1_checkout_session has unexpected privileges';
  end if;
  if has_function_privilege('anon', 'public.get_my_commercial_v1_checkout_binding(uuid)', 'execute')
    or has_function_privilege('service_role', 'public.get_my_commercial_v1_checkout_binding(uuid)', 'execute')
    or not has_function_privilege('authenticated', 'public.get_my_commercial_v1_checkout_binding(uuid)', 'execute') then
    raise exception 'get_my_commercial_v1_checkout_binding has unexpected privileges';
  end if;
  if has_table_privilege('anon', 'public.commercial_v1_checkout_session_replacements', 'select')
    or has_table_privilege('authenticated', 'public.commercial_v1_checkout_session_replacements', 'select')
    or has_table_privilege('authenticated', 'public.commercial_v1_checkout_session_replacements', 'insert')
    or has_table_privilege('service_role', 'public.commercial_v1_checkout_session_replacements', 'select') then
    raise exception 'checkout session replacement history is exposed to an API role';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'guard_order'
      and tgrelid = 'public.commercial_v1_orders'::regclass)
    or not exists (select 1 from pg_trigger where tgname = 'guard_checkout_session_replacement'
      and tgrelid = 'public.commercial_v1_checkout_session_replacements'::regclass) then
    raise exception 'checkout session guards are missing';
  end if;
end $$;
