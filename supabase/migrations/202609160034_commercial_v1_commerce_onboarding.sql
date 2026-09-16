-- Commercial V1 PR13: commerce, payment, entitlement and customer onboarding.
-- Additive only; migrations 001-033 are byte-for-byte unchanged. Stripe
-- supplies PAYMENT EVIDENCE only -- it never owns identity, entitlement,
-- enrolment, curriculum, scheduling or academic state. The database is the
-- sole authority for financial/institutional truth; a browser redirect, a
-- Stripe metadata field or a client-supplied amount/currency/learner/cohort
-- is NEVER trusted (see docs/28).
--
-- Journey: public offer (anon-safe read) -> authenticated STUDENT creates a
-- durable order snapshotting price/currency/course scope -> the Next.js
-- server calls Stripe using a server secret and binds the resulting
-- Checkout Session id to that exact order -> a narrow, cryptographically
-- signed fulfillment claim (mirroring the existing controller/HMAC
-- philosophy of migrations 022/025/028/031/032/033, but bound to ORDER
-- identity rather than a live learner session, since a Stripe webhook has
-- no session at all) atomically verifies payment evidence, records bounded
-- payment history, creates/reuses an entitlement and the underlying
-- enrolment (reproducing migration 007's create_enrolment invariants
-- directly -- create_enrolment itself remains admin-only and is never
-- weakened or called with borrowed authority), marks the order fulfilled,
-- and writes bounded audit metadata, all in one atomic transaction.

-- ==========================================================================
-- Section 1: commercial offer / catalogue.
-- ==========================================================================
create table public.commercial_v1_offers (
  id uuid primary key default gen_random_uuid(),
  -- Public URL identity. Immutable once created (see guard_offer below).
  slug text not null unique check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  -- The exact sellable course activation -- therefore the exact cohort and
  -- programme version (course_activations.cohort_id is itself unique,
  -- migration 027). Learner-facing academic title/metadata is DERIVED from
  -- this join at read time (programmes/programme_versions/cohorts), never
  -- duplicated here.
  activation_id uuid not null references public.course_activations(id),
  price_amount_minor integer not null check(price_amount_minor between 1 and 100000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  -- Bounded commercial copy only (never academic truth).
  summary text check(summary is null or length(summary) between 1 and 500),
  state text not null default 'PUBLISHED' check(state in ('PUBLISHED','ARCHIVED')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp()
);
-- At most one PUBLISHED, sellable offer per activation at any time -- an
-- admin who wants to re-price archives the old offer and publishes a new
-- one; historical orders/entitlements keep referencing the old (now
-- archived) offer row untouched.
create unique index commercial_v1_offers_one_published_per_activation
  on public.commercial_v1_offers(activation_id) where state='PUBLISHED';
alter table public.commercial_v1_offers enable row level security;
revoke all on public.commercial_v1_offers from public,anon,authenticated,service_role;

create schema commercial_v1_commerce_private;
revoke all on schema commercial_v1_commerce_private from public,anon,authenticated,service_role;

create function commercial_v1_commerce_private.append_only() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'This Commercial V1 commerce record is append-only'; end $$;
revoke all on function commercial_v1_commerce_private.append_only() from public,anon,authenticated,service_role;

-- Identity/price/provenance immutable always; state only ever moves
-- PUBLISHED -> ARCHIVED (never back), matching "offer price change after
-- order creation cannot rewrite old order amount" (orders snapshot their
-- own amount/currency independently, see Section 2) and "no silent
-- mutation of historical financial/commercial state".
create function commercial_v1_commerce_private.guard_offer() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial offers cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.slug<>OLD.slug or NEW.activation_id<>OLD.activation_id
    or NEW.price_amount_minor<>OLD.price_amount_minor or NEW.currency<>OLD.currency
    or NEW.created_by<>OLD.created_by or NEW.created_at<>OLD.created_at
    or NEW.published_by<>OLD.published_by or NEW.published_at<>OLD.published_at then
    raise exception 'Commercial offer identity/price/provenance is immutable';
  end if;
  if OLD.state='ARCHIVED' and NEW.state<>'ARCHIVED' then
    raise exception 'An archived commercial offer cannot be republished';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_offer() from public,anon,authenticated,service_role;
create trigger guard_offer before update or delete on public.commercial_v1_offers
for each row execute function commercial_v1_commerce_private.guard_offer();

-- ==========================================================================
-- Section 2: durable order / checkout state.
-- ==========================================================================
create table public.commercial_v1_orders (
  id uuid primary key default gen_random_uuid(),
  -- The AUTHENTICATED actor at order-creation time. Never a browser-supplied
  -- student id.
  learner_id uuid not null references public.app_users(id),
  offer_id uuid not null references public.commercial_v1_offers(id),
  -- Snapshotted from the offer/activation AT ORDER CREATION -- a later
  -- offer re-price or archival never rewrites this row (guard_order below).
  activation_id uuid not null references public.course_activations(id),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  provider text not null default 'STRIPE' check(provider='STRIPE'),
  provider_session_id text unique,
  state text not null default 'PENDING' check(state in ('PENDING','FULFILLED')),
  created_at timestamptz not null default clock_timestamp(),
  fulfilled_at timestamptz,
  check((state='PENDING' and fulfilled_at is null) or (state='FULFILLED' and fulfilled_at is not null)),
  foreign key(cohort_id,programme_version_id) references public.cohorts(id,programme_version_id)
);
-- Bounded idempotency: a learner retrying checkout for the SAME offer while
-- an order is still pending reuses that order rather than creating a
-- duplicate (see create_commercial_v1_order). This is the entire
-- idempotency mechanism -- no client-supplied idempotency token is needed
-- or trusted.
create unique index commercial_v1_orders_one_pending_per_learner_offer
  on public.commercial_v1_orders(learner_id,offer_id) where state='PENDING';
create index commercial_v1_orders_learner on public.commercial_v1_orders(learner_id,created_at desc);
alter table public.commercial_v1_orders enable row level security;
revoke all on public.commercial_v1_orders from public,anon,authenticated,service_role;

-- Financial identity is immutable always. provider_session_id may be set
-- exactly once (from null) and never subsequently replaced. state only
-- ever moves PENDING -> FULFILLED (never back).
create function commercial_v1_commerce_private.guard_order() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial orders cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.learner_id<>OLD.learner_id or NEW.offer_id<>OLD.offer_id
    or NEW.activation_id<>OLD.activation_id or NEW.cohort_id<>OLD.cohort_id
    or NEW.programme_version_id<>OLD.programme_version_id or NEW.amount_minor<>OLD.amount_minor
    or NEW.currency<>OLD.currency or NEW.provider<>OLD.provider or NEW.created_at<>OLD.created_at then
    raise exception 'Commercial order financial identity is immutable';
  end if;
  if OLD.provider_session_id is not null and NEW.provider_session_id is distinct from OLD.provider_session_id then
    raise exception 'A bound Stripe checkout session cannot be replaced';
  end if;
  if OLD.state='FULFILLED' and NEW.state<>'FULFILLED' then
    raise exception 'A fulfilled order cannot be reopened';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_order() from public,anon,authenticated,service_role;
create trigger guard_order before update or delete on public.commercial_v1_orders
for each row execute function commercial_v1_commerce_private.guard_order();

-- ==========================================================================
-- Section 3: immutable payment verification history. Content-minimised --
-- no raw webhook body, signature, secret, full customer object or card
-- data. Bounded metadata sufficient for audit/idempotency/reconciliation
-- only.
-- ==========================================================================
create table public.commercial_v1_payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commercial_v1_orders(id),
  provider text not null default 'STRIPE' check(provider='STRIPE'),
  provider_event_id text not null check(length(provider_event_id) between 1 and 200),
  session_id text not null check(length(session_id) between 1 and 200),
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  status text not null check(status in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')),
  verified_at timestamptz not null default clock_timestamp(),
  unique(provider,provider_event_id)
);
create index commercial_v1_payment_events_order on public.commercial_v1_payment_events(order_id,verified_at desc);
alter table public.commercial_v1_payment_events enable row level security;
revoke all on public.commercial_v1_payment_events from public,anon,authenticated,service_role;
create trigger payment_events_append_only before update or delete on public.commercial_v1_payment_events
for each row execute function commercial_v1_commerce_private.append_only();

-- ==========================================================================
-- Section 4: first-class deterministic entitlement. Payment success never
-- equals enrolment merely because a browser says so -- only
-- fulfill_commercial_v1_order (Section 6) ever writes this table, after
-- independently verifying trusted, DB-matched payment evidence.
-- ==========================================================================
create table public.commercial_v1_entitlements (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.app_users(id),
  offer_id uuid not null references public.commercial_v1_offers(id),
  activation_id uuid not null references public.course_activations(id),
  order_id uuid not null unique references public.commercial_v1_orders(id),
  enrolment_id uuid not null references public.enrolments(id),
  state text not null default 'ACTIVE' check(state='ACTIVE'),
  created_at timestamptz not null default clock_timestamp(),
  -- One active entitlement per learner per sellable course (activation),
  -- never per offer -- a re-priced offer must not let the same learner
  -- accumulate a second entitlement to the same course.
  unique(learner_id,activation_id)
);
create index commercial_v1_entitlements_learner on public.commercial_v1_entitlements(learner_id);
alter table public.commercial_v1_entitlements enable row level security;
revoke all on public.commercial_v1_entitlements from public,anon,authenticated,service_role;
create trigger entitlements_append_only before update or delete on public.commercial_v1_entitlements
for each row execute function commercial_v1_commerce_private.append_only();

-- ==========================================================================
-- Section 5: narrow server-to-database trust root for fulfillment.
-- Mirrors the architecture of migration 022's academic_execution_private
-- controller-key pattern (bounded canonical message, fixed-key store,
-- fixed-length MAC comparison, distinct protocol/policy tag) but is
-- DELIBERATELY a separate key store and a separate canonical shape: that
-- pattern binds identity via current_app_user() (a live learner session),
-- which a Stripe webhook never has. This claim instead binds the exact
-- values needed to prevent tampering with a FULFILLMENT fact regardless of
-- which trusted entrypoint (webhook or authenticated success-page
-- reconciliation) produced it -- see docs/28. No signing oracle, no
-- generic HMAC verifier, no arbitrary payload writer: the only thing a
-- valid claim can ever do is invoke fulfill_commercial_v1_order below.
-- ==========================================================================
create table commercial_v1_commerce_private.controller_keys (
  id uuid primary key,
  secret bytea not null check(octet_length(secret)=32),
  installed_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check(revoked_at is null or revoked_at>=installed_at)
);
alter table commercial_v1_commerce_private.controller_keys enable row level security;
revoke all on commercial_v1_commerce_private.controller_keys from public,anon,authenticated,service_role;

-- Database-owner provisioning only, exactly like
-- academic_execution_private.install_controller_key. No secret in
-- migration/seed/source.
create function commercial_v1_commerce_private.install_controller_key(p_id uuid,p_secret bytea)
returns void language sql set search_path='' as $$
  insert into commercial_v1_commerce_private.controller_keys(id,secret) values(p_id,p_secret)
$$;
revoke all on function commercial_v1_commerce_private.install_controller_key(uuid,bytea) from public,anon,authenticated,service_role;

create function commercial_v1_commerce_private.verify_fulfillment_claim(
  p_key_id uuid,p_order_id uuid,p_provider text,p_session_id text,p_event_id text,
  p_amount integer,p_currency text,p_status text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean language plpgsql security definer set search_path='' as $$
declare
  key_bytes bytea; expected bytea; supplied bytea; canonical text; mismatch integer:=0; stamp numeric; i integer;
begin
  stamp := extract(epoch from clock_timestamp());
  if p_key_id is null or p_order_id is null or p_provider is null or p_provider<>'STRIPE'
    or p_session_id is null or length(p_session_id) not between 1 and 200
    or p_event_id is null or length(p_event_id) not between 1 and 200
    or p_amount is null or p_amount not between 1 and 100000000
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_status is null or p_status not in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')
    -- Wider skew tolerance than the live-session AUTHORIZE/START/FINALIZE
    -- surfaces (migration 022): webhook delivery/network latency is real,
    -- and a 5-minute claim lifetime is still tightly bounded, never open-
    -- ended.
    or p_issued_at is null or p_issued_at>stamp+30 or p_issued_at<stamp-300
    or p_expires_at is null or p_expires_at<=p_issued_at or p_expires_at>p_issued_at+300 or p_expires_at<=stamp
    or p_mac is null or length(p_mac)<>64 or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from commercial_v1_commerce_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical := concat_ws(E'\n','DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1','COMMERCIAL_V1_COMMERCE_V1',
    p_key_id::text,p_provider,p_order_id::text,p_session_id,p_event_id,p_amount::text,p_currency,p_status,
    p_issued_at::text,p_expires_at::text);
  expected := extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256');
  supplied := decode(p_mac,'hex');
  -- Fixed 32-byte comparison without an early exit on the first differing
  -- byte (same defensive shape as migration 022's verify_command; not a
  -- claim of hosted side-channel resistance).
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function commercial_v1_commerce_private.verify_fulfillment_claim(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)
  from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 6: atomic payment fulfillment -> entitlement -> enrolment. The
-- ONE fulfillment authority both the webhook path and the authenticated
-- success-page reconciliation fallback converge on (never two competing
-- implementations). Locks the order row, independently verifies the
-- trusted claim actually matches the persisted order (session/amount/
-- currency), idempotently records payment evidence, creates/reuses the
-- entitlement, reproduces (never weakens or borrows) create_enrolment's
-- own invariant checks to create/reuse the enrolment, marks the order
-- fulfilled and writes bounded audit metadata -- all inside one PL/pgSQL
-- function body, so it commits atomically or not at all.
-- ==========================================================================
create function public.fulfill_commercial_v1_order(
  p_key_id uuid,p_order_id uuid,p_provider text,p_session_id text,p_event_id text,
  p_amount integer,p_currency text,p_status text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  order_record public.commercial_v1_orders%rowtype;
  entitlement_record public.commercial_v1_entitlements%rowtype;
  enrolment_id uuid;
  enrolment_status text;
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

  insert into public.commercial_v1_entitlements(learner_id,offer_id,activation_id,order_id,enrolment_id)
  values(order_record.learner_id,order_record.offer_id,order_record.activation_id,p_order_id,enrolment_id)
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
revoke all on function public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)
  from public,anon,authenticated,service_role;
-- anon: the Stripe webhook has no learner session at all. authenticated:
-- the success-page reconciliation fallback runs as the owning learner.
-- Either way, nothing happens unless the cryptographic claim verifies.
grant execute on function public.fulfill_commercial_v1_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text)
  to anon,authenticated;

-- ==========================================================================
-- Section 7: public/anonymous-safe offer projections. Only PUBLISHED-offer,
-- public-safe fields ever cross this surface -- no protected course
-- content, assessment content, agent configuration or private learner
-- data. Learner-facing title/metadata is derived from authoritative
-- programme state, never duplicated.
-- ==========================================================================
create function public.list_commercial_v1_offers() returns jsonb
language sql security definer stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug',o.slug,'title',p.title,'examinationBody',p.examination_body,'qualificationName',p.qualification_name,
    'priceAmountMinor',o.price_amount_minor,'currency',o.currency,'summary',o.summary,'cohortStartsOn',c.starts_on
  ) order by o.published_at desc,o.id),'[]'::jsonb)
  from public.commercial_v1_offers o
  join public.course_activations a on a.id=o.activation_id
  join public.cohorts c on c.id=a.cohort_id
  join public.programme_versions v on v.id=a.programme_version_id
  join public.programmes p on p.id=v.programme_id
  where o.state='PUBLISHED'
$$;
revoke all on function public.list_commercial_v1_offers() from public,anon,authenticated,service_role;
grant execute on function public.list_commercial_v1_offers() to anon,authenticated;

-- Includes bounded VIEWER state (authenticated/entitled/enrolment id) for
-- the CURRENT actor only, derived from current_app_user() -- never from any
-- caller-supplied learner id. Anonymous callers simply see
-- viewerAuthenticated=false.
create function public.get_commercial_v1_offer(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  o public.commercial_v1_offers%rowtype; p_title text; p_body text; p_qual text; starts date; a_cohort uuid;
  actor uuid; entitled boolean:=false; enrolment uuid; viewer_status text:='NONE';
begin
  select * into o from public.commercial_v1_offers where slug=p_slug and state='PUBLISHED';
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
    select e.enrolment_id into enrolment from public.commercial_v1_entitlements e
    where e.learner_id=actor and e.activation_id=o.activation_id;
    entitled := enrolment is not null;
    -- V2 correction (finding 4): independent of commerce entitlement -- the
    -- CANONICAL academic enrolments table is the authority for whether the
    -- current learner already has real access to this exact cohort (e.g. a
    -- comped/free seat with no entitlement row at all). ACTIVE/PAUSED/
    -- COMPLETED/WITHDRAWN are surfaced verbatim so the UI never offers a
    -- fresh purchase to an already-enrolled learner.
    select status into viewer_status from public.enrolments where student_id=actor and cohort_id=a_cohort;
    viewer_status := coalesce(viewer_status,'NONE');
  end if;

  return jsonb_build_object('ok',true,'slug',o.slug,'title',p_title,'examinationBody',p_body,'qualificationName',p_qual,
    'priceAmountMinor',o.price_amount_minor,'currency',o.currency,'summary',o.summary,'cohortStartsOn',starts,
    'viewerAuthenticated',actor is not null,'viewerEntitled',entitled,'viewerEnrolmentId',enrolment,
    'viewerEnrolmentStatus',viewer_status);
end $$;
revoke all on function public.get_commercial_v1_offer(text) from public,anon,authenticated,service_role;
grant execute on function public.get_commercial_v1_offer(text) to anon,authenticated;

-- ==========================================================================
-- Section 8: admin publication authority. Reuses
-- course_activation_private.require_admin() -- the exact same
-- ACADEMIC_ADMIN/PLATFORM_ADMIN authority every other Commercial V1
-- publish RPC already uses. No new role.
-- ==========================================================================
create function public.publish_commercial_v1_offer(
  p_activation_id uuid,p_slug text,p_price_amount_minor integer,p_currency text,p_summary text,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid; activation public.course_activations%rowtype; offer_id uuid;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded publication reason is required';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) not between 3 and 80 then
    raise exception 'INVALID_SLUG';
  end if;
  if p_price_amount_minor is null or p_price_amount_minor not between 1 and 100000000 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_currency is null or upper(p_currency) !~ '^[A-Z]{3}$' then raise exception 'INVALID_CURRENCY'; end if;
  if p_summary is not null and length(p_summary) not between 1 and 500 then raise exception 'INVALID_SUMMARY'; end if;

  -- Launch-readiness signal (documented limitation, docs/28): the ONLY
  -- deterministic signal available today is that a real course_activations
  -- row exists for this exact activation id -- itself proof of a validated
  -- COURSE_PACKAGE_V1 import, a real instructor, a real cohort and a
  -- PUBLISHED programme version (migration 027's own activate_course_package
  -- invariants). This does NOT verify Commercial V1 grading/result/lab
  -- policy readiness, content completeness beyond schema validation, or
  -- instructor availability -- no such deterministic signal exists yet.
  select * into activation from public.course_activations where id=p_activation_id for share;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  if exists(select 1 from public.commercial_v1_offers where activation_id=p_activation_id and state='PUBLISHED') then
    raise exception 'ALREADY_PUBLISHED';
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_offers(slug,activation_id,price_amount_minor,currency,summary,created_by,published_by)
  values(p_slug,p_activation_id,p_price_amount_minor,upper(p_currency),nullif(trim(p_summary),''),actor,actor)
  returning id into offer_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_OFFER_PUBLISHED','commercial_v1_offers',offer_id,'COMMERCIAL_V1_COMMERCE_V1',trim(p_reason),
    jsonb_build_object('offer_id',offer_id,'activation_id',p_activation_id,'slug',p_slug,
      'price_amount_minor',p_price_amount_minor,'currency',upper(p_currency)));
  return offer_id;
end $$;
revoke all on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text) to authenticated;

-- Takes the public slug (not an internal id) -- the smallest input an
-- admin operator actually has on hand from the catalogue/offer page, and
-- one fewer internal identifier the admin UI needs to look up separately.
create function public.archive_commercial_v1_offer(p_slug text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; offer_id uuid;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded archive reason is required';
  end if;
  select id into offer_id from public.commercial_v1_offers where slug=p_slug and state='PUBLISHED';
  if offer_id is null then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  perform set_config('app.audit_reason',trim(p_reason),true);
  update public.commercial_v1_offers set state='ARCHIVED' where id=offer_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_OFFER_ARCHIVED','commercial_v1_offers',offer_id,'COMMERCIAL_V1_COMMERCE_V1',trim(p_reason),
    jsonb_build_object('offer_id',offer_id,'slug',p_slug));
  return offer_id;
end $$;
revoke all on function public.archive_commercial_v1_offer(text,text) from public,anon,authenticated,service_role;
grant execute on function public.archive_commercial_v1_offer(text,text) to authenticated;

-- V2 correction (finding 10): the smallest operational admin read needed to
-- actually USE publish_commercial_v1_offer -- an admin has no other way to
-- discover a real activation id to paste into the publish form. Read-only,
-- admin-gated, reusing the exact same programme/cohort join
-- get_commercial_v1_offer already uses; no protected content, no new
-- table, no duplicated course-authority logic.
create function public.list_commercial_v1_offer_activations() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform course_activation_private.require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'activationId',a.id,'programmeTitle',p.title,'cohortTitle',c.title,'cohortStartsOn',c.starts_on,
    'publishedOfferSlug',(select o.slug from public.commercial_v1_offers o where o.activation_id=a.id and o.state='PUBLISHED')
  ) order by c.starts_on desc,a.id),'[]'::jsonb)
  from public.course_activations a
  join public.cohorts c on c.id=a.cohort_id
  join public.programme_versions v on v.id=a.programme_version_id
  join public.programmes p on p.id=v.programme_id
  limit 200);
end $$;
revoke all on function public.list_commercial_v1_offer_activations() from public,anon,authenticated,service_role;
grant execute on function public.list_commercial_v1_offer_activations() to authenticated;

-- ==========================================================================
-- Section 9: authenticated STUDENT order/checkout-binding surface.
-- ==========================================================================
create function public.create_commercial_v1_order(p_offer_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; o public.commercial_v1_offers%rowtype; existing public.commercial_v1_orders%rowtype;
  a_cohort uuid; a_version uuid; order_id uuid; enrolment_status text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;

  select * into o from public.commercial_v1_offers where slug=p_offer_slug and state='PUBLISHED' for share;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;

  if exists(select 1 from public.commercial_v1_entitlements where learner_id=actor and activation_id=o.activation_id) then
    return jsonb_build_object('ok',false,'code','ALREADY_ENTITLED');
  end if;

  select a.cohort_id,a.programme_version_id into a_cohort,a_version from public.course_activations a where a.id=o.activation_id;

  -- V2 correction (finding 4): the CANONICAL academic enrolments table is
  -- the authority here, independent of commerce entitlement -- a learner
  -- can be legitimately enrolled (e.g. a comped/free seat an admin created
  -- directly via create_enrolment) without ever holding a commerce
  -- entitlement row, and the entitlement check above alone would miss
  -- that. Always the AUTHENTICATED actor's own enrolment for the EXACT
  -- cohort this offer sells -- never derived from browser input.
  select status into enrolment_status from public.enrolments where student_id=actor and cohort_id=a_cohort;
  if found then
    if enrolment_status in ('ACTIVE','PAUSED','COMPLETED') then
      return jsonb_build_object('ok',false,'code','ALREADY_ENROLLED');
    else
      -- WITHDRAWN: never silently reactivated by a fresh purchase.
      return jsonb_build_object('ok',false,'code','ENROLMENT_REQUIRES_SUPPORT');
    end if;
  end if;

  select * into existing from public.commercial_v1_orders where learner_id=actor and offer_id=o.id and state='PENDING';
  if found then
    return jsonb_build_object('ok',true,'orderId',existing.id,'amountMinor',existing.amount_minor,'currency',existing.currency,
      'offerSlug',p_offer_slug,'activationId',existing.activation_id,'reused',true);
  end if;

  insert into public.commercial_v1_orders(learner_id,offer_id,activation_id,cohort_id,programme_version_id,amount_minor,currency)
  values(actor,o.id,o.activation_id,a_cohort,a_version,o.price_amount_minor,o.currency)
  returning id into order_id;

  return jsonb_build_object('ok',true,'orderId',order_id,'amountMinor',o.price_amount_minor,'currency',o.currency,
    'offerSlug',p_offer_slug,'activationId',o.activation_id,'reused',false);
end $$;
revoke all on function public.create_commercial_v1_order(text) from public,anon,authenticated,service_role;
grant execute on function public.create_commercial_v1_order(text) to authenticated;

create function public.attach_commercial_v1_checkout_session(p_order_id uuid,p_session_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; o public.commercial_v1_orders%rowtype;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if p_session_id is null or length(p_session_id) not between 1 and 200 then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;
  select * into o from public.commercial_v1_orders where id=p_order_id and learner_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if o.state<>'PENDING' then return jsonb_build_object('ok',false,'code','INVALID_STATE'); end if;
  if o.provider_session_id is not null and o.provider_session_id<>p_session_id then
    -- V2 correction (finding 1): report the ALREADY-BOUND session id so the
    -- caller can retrieve/reuse it rather than ever falling back to the
    -- newly created, unbound session's own URL.
    return jsonb_build_object('ok',false,'code','SESSION_ALREADY_BOUND','existingSessionId',o.provider_session_id);
  end if;
  update public.commercial_v1_orders set provider_session_id=p_session_id
  where id=p_order_id and provider_session_id is null;
  return jsonb_build_object('ok',true,'orderId',p_order_id);
end $$;
revoke all on function public.attach_commercial_v1_checkout_session(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.attach_commercial_v1_checkout_session(uuid,text) to authenticated;

create function public.get_commercial_v1_order(p_order_id uuid) returns jsonb
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
    'activationId',o.activation_id,'amountMinor',o.amount_minor,'currency',o.currency,'fulfilledAt',o.fulfilled_at));
end $$;
revoke all on function public.get_commercial_v1_order(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_commercial_v1_order(uuid) to authenticated;

-- ==========================================================================
-- Section 10: RLS/ACL hardening, mirroring migrations 022/027/029/030/031/
-- 032/033 exactly. No direct table access is ever granted; every read/write
-- goes through the governed RPCs above.
-- ==========================================================================
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.commercial_v1_offers'::regclass,'public.commercial_v1_orders'::regclass,
    'public.commercial_v1_payment_events'::regclass,'public.commercial_v1_entitlements'::regclass
  ] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=protected_table and attnum>0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns,columns,columns,columns,protected_table);
  end loop;
end $$;

do $$ declare protected_table regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach protected_table in array array[
      'public.commercial_v1_offers'::regclass,'public.commercial_v1_orders'::regclass,
      'public.commercial_v1_payment_events'::regclass,'public.commercial_v1_entitlements'::regclass,
      'commercial_v1_commerce_private.controller_keys'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective commerce table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r,'commercial_v1_commerce_private','USAGE,CREATE') then
      raise exception 'Unsafe effective commerce schema privileges for %', r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commercial_v1_commerce_private'
         or (n.nspname='public' and p.proname in (
           'list_commercial_v1_offers','get_commercial_v1_offer','publish_commercial_v1_offer','archive_commercial_v1_offer',
           'list_commercial_v1_offer_activations','create_commercial_v1_order','attach_commercial_v1_checkout_session',
           'get_commercial_v1_order','fulfill_commercial_v1_order'
         )) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (
        (r in ('anon','authenticated') and f.nspname='public' and f.proname in (
          'list_commercial_v1_offers','get_commercial_v1_offer','fulfill_commercial_v1_order'
        )) or
        (r='authenticated' and f.nspname='public' and f.proname in (
          'publish_commercial_v1_offer','archive_commercial_v1_offer','list_commercial_v1_offer_activations',
          'create_commercial_v1_order','attach_commercial_v1_checkout_session','get_commercial_v1_order'
        ))
      ) then raise exception 'Unsafe effective commerce function privileges for % on %', r, f.proname; end if;
    end loop;
  end loop;
end $$;
