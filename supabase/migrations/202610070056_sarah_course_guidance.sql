-- AC-7: Sarah Mitchell course guidance, with a hard data firewall between
-- learner-support context and commercial context.
-- Migrations 001-055 are byte-for-byte unchanged. This migration evolves the
-- AC-5 (054) Sarah ledger only where the new intent requires it and
-- preserves every historical row. No existing attested message format
-- (022/025/028/031/032/040/051/053/054) is altered, and the 054 RPCs
-- govern_sarah_execution, get_my_sarah_context, record_sarah_profile_proposal,
-- list_my_sarah_profile_proposals and decide_sarah_profile_proposal are not
-- replaced.
--
-- Design (docs/49-agent-behaviour-ac7-sarah-course-guidance.md):
--
-- 1. One new intent, COURSE_GUIDANCE, allowed only in PROSPECT and
--    POST_COURSE. During an active course it is refused before any provider
--    work, at reservation, context, AUTHORIZE and START.
-- 2. A PHYSICALLY SEPARATE commercial context projection
--    (get_my_sarah_commercial_context, via sarah_private.commercial_projection)
--    that reads only: the learner's mode, currently PUBLISHED public offers
--    (bounded to 20) with the learner's own enrolment status and new-purchase
--    availability per offer, and in POST_COURSE a bounded list (5) of the
--    learner's completed course identities and completion dates. The only
--    completion-receipt field consumed is completed_at. It never reads the
--    support profile, Sarah proposals, support events, follow-ups,
--    notifications, study plans, counsellor assignments or interactions,
--    AC-6 session feedback, Professor/Tutor/Lab stores, assessments,
--    assessment/lab result rows or result-detail data, scores, pass marks,
--    marks, outcomes, mastery, remediation, orders, payment events,
--    campaigns or redemptions.
-- 3. A commercial-context fingerprint: SHA-256 over
--    'SARAH_COMMERCIAL_CONTEXT_V1' and the exact deterministic projection.
--    It contains no actor identity, so two learners with identical
--    commercial state get the identical fingerprint. COURSE_GUIDANCE
--    executions bind to it (source_commercial_sha256) and never to the
--    support-profile fingerprint (source_profile_sha256 is NULL by design).
--    GUIDE / SUPPORT_PROFILE keep source_profile_sha256 and never gain a
--    commercial fingerprint (cross-field CHECK).
-- 4. A separate attested lifecycle RPC, govern_sarah_course_guidance, with
--    the NEW protocol tag DUCELIO_SARAH_COURSE_GUIDANCE_HMAC_SHA256_V1 over
--    the existing controller key store (verify_mac). AUTHORIZE and START
--    both re-check the mode and the commercial fingerprint; START closes a
--    stale execution FAILED/POLICY_BLOCKED before any provider call. Same
--    SARAH_EXECUTION_V1 policy, COUNSELLOR_PLATFORM_V1 profile, budget
--    ceiling, one-attempt usage and rate-limit envelope as AC-5, shared with
--    the AC-5 intents (one Sarah envelope per learner).
-- 5. Behaviour version SARAH_COMMERCIAL_BEHAVIOUR_V1 for COURSE_GUIDANCE;
--    GUIDE / SUPPORT_PROFILE keep SARAH_BEHAVIOUR_V1.
-- 6. No message, reply, recommendation, reason, preference, prompt or
--    provider payload is stored. Sarah performs no commercial mutation: no
--    order, checkout session, campaign redemption, entitlement, enrolment,
--    offer, price, discount or seat is created or changed here.
--
-- Lock order: the learner student_profiles row FOR UPDATE first, exactly as
-- every 054 write.

-- ==========================================================================
-- 1. Ledger vocabulary and intent-aware shape (historical rows stay valid).
-- ==========================================================================
alter table public.sarah_interaction_reservations
  drop constraint sarah_interaction_reservations_intent_check,
  add constraint sarah_interaction_reservations_intent_check
    check(intent in ('GUIDE','SUPPORT_PROFILE','COURSE_GUIDANCE'));

alter table public.sarah_executions
  add column source_commercial_sha256 text
    constraint sarah_executions_source_commercial_sha256_check
    check(source_commercial_sha256 ~ '^[0-9a-f]{64}$');

alter table public.sarah_executions
  drop constraint sarah_executions_intent_check,
  drop constraint sarah_executions_behaviour_version_check,
  alter column source_profile_sha256 drop not null,
  add constraint sarah_executions_intent_check
    check(intent in ('GUIDE','SUPPORT_PROFILE','COURSE_GUIDANCE')),
  -- Explicit valid shapes. The learner-support intents keep exactly their
  -- 054 shape (support-profile version required, AC-5 behaviour); course
  -- guidance carries ONLY a commercial-context version, its own behaviour
  -- and never runs in ACTIVE_COURSE.
  add constraint sarah_executions_intent_shape check(
    (intent in ('GUIDE','SUPPORT_PROFILE') and behaviour_version = 'SARAH_BEHAVIOUR_V1'
      and source_profile_sha256 is not null and source_commercial_sha256 is null)
    or
    (intent = 'COURSE_GUIDANCE' and behaviour_version = 'SARAH_COMMERCIAL_BEHAVIOUR_V1'
      and mode in ('PROSPECT','POST_COURSE')
      and source_profile_sha256 is null and source_commercial_sha256 is not null)
  );

-- The execution guard (054) extended by the new column: identity, scope,
-- both context versions and the budget stay immutable. Transitions are
-- unchanged.
create or replace function sarah_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: execution history cannot be deleted' using errcode = '55000';
  end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: terminal execution history is immutable' using errcode = '55000';
  end if;
  if row(NEW.id, NEW.student_id, NEW.idempotency_key, NEW.policy_version, NEW.platform_role, NEW.runtime_profile_ref,
      NEW.behaviour_version, NEW.mode, NEW.intent, NEW.source_profile_sha256, NEW.source_commercial_sha256,
      NEW.created_at, NEW.authorized_at, NEW.expires_at, NEW.max_provider_calls, NEW.max_output_tokens,
      NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id, OLD.student_id, OLD.idempotency_key, OLD.policy_version, OLD.platform_role,
      OLD.runtime_profile_ref, OLD.behaviour_version, OLD.mode, OLD.intent, OLD.source_profile_sha256,
      OLD.source_commercial_sha256, OLD.created_at, OLD.authorized_at, OLD.expires_at, OLD.max_provider_calls,
      OLD.max_output_tokens, OLD.max_estimated_cost_microusd) then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: execution identity, scope and budget are immutable' using errcode = '55000';
  end if;
  if not ((OLD.state = 'AUTHORIZED' and NEW.state in ('RUNNING','FAILED','TIMEOUT')) or
    (OLD.state = 'RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ABSTAINED','BUDGET_BLOCKED','TIMEOUT','CANCELLED'))) then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: invalid execution transition' using errcode = '55000';
  end if;
  if OLD.state = 'RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: execution start is immutable' using errcode = '55000';
  end if;
  return NEW;
end $$;

-- Execution audit (054) with intent-aware reason wording. The audit-source
-- classifier is byte-for-byte the 054 shape-based classifier. Still no
-- message, reply, recommendation, reason, profile value or fingerprint
-- (support or commercial) is audited.
create or replace function sarah_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object('providerCalls', u.provider_calls, 'attempts', u.attempts, 'inputTokens', u.input_tokens,
      'outputTokens', u.output_tokens, 'estimatedCostMicrousd', u.estimated_cost_microusd, 'elapsedMs', u.elapsed_ms)
      into usage_snapshot from public.sarah_execution_usage u where u.execution_id = NEW.id;
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state, occurred_at)
  values (NEW.student_id, 'SARAH_EXECUTION_' || NEW.state, 'sarah_executions', NEW.id,
    case
      when NEW.state in ('BLOCKED','TIMEOUT') then 'DATABASE_EXECUTION_POLICY'
      when NEW.state = 'FAILED' and NEW.reason_code = 'POLICY_BLOCKED' and NEW.started_at is null
        then 'DATABASE_EXECUTION_POLICY'
      else 'ATTESTED_EXECUTION_CONTROLLER'
    end,
    case when NEW.intent = 'COURSE_GUIDANCE'
      then 'Sarah Mitchell course-guidance execution lifecycle'
      else 'Sarah Mitchell learner-guide execution lifecycle'
    end,
    jsonb_build_object('execution_id', NEW.id, 'student_id', NEW.student_id, 'policy_version', NEW.policy_version,
      'platform_role', NEW.platform_role, 'runtime_profile_ref', NEW.runtime_profile_ref,
      'behaviour_version', NEW.behaviour_version, 'mode', NEW.mode, 'intent', NEW.intent, 'state', NEW.state,
      'reason_code', NEW.reason_code, 'budget_stage', NEW.budget_stage, 'created_at', NEW.created_at,
      'started_at', NEW.started_at, 'terminal_at', NEW.terminal_at, 'expires_at', NEW.expires_at,
      'max_provider_calls', NEW.max_provider_calls, 'max_output_tokens', NEW.max_output_tokens,
      'max_estimated_cost_microusd', NEW.max_estimated_cost_microusd, 'usage', usage_snapshot),
    clock_timestamp());
  return NEW;
end $$;

-- ==========================================================================
-- 2. Commercial context projection (the firewall). Reads ONLY public offer
--    facts, the learner's own enrolment status per offer cohort, entitlement
--    EXISTENCE (to mirror create_commercial_v1_order's eligibility, never
--    any entitlement field), whether the offer's cohort is open with a free
--    seat (a boolean, never a count), and completed-course identities with
--    the completion date: completed_at is the only completion-receipt field
--    consumed (never a score, pass mark, mark, result detail or outcome).
-- ==========================================================================
create function sarah_private.commercial_projection(p_student uuid) returns jsonb
language sql stable set search_path='' as $$
  with ctx as (select sarah_private.learner_mode(p_student) as mode),
  published as (
    select o.slug, o.price_amount_minor, o.currency, o.summary, o.delivery_plan, o.activation_id,
      a.cohort_id, c.starts_on, c.status as cohort_status, c.capacity, p.title, p.examination_body, p.qualification_name,
      row_number() over (order by o.published_at desc, o.id) as position
    from public.commercial_v1_offers o
    join public.course_activations a on a.id = o.activation_id
    join public.cohorts c on c.id = a.cohort_id
    join public.programme_versions v on v.id = a.programme_version_id
    join public.programmes p on p.id = v.programme_id
    where o.state = 'PUBLISHED'
  ),
  viewer as (
    select x.*, coalesce((select e.status from public.enrolments e
        where e.student_id = p_student and e.cohort_id = x.cohort_id), 'NONE') as viewer_status,
      exists(select 1 from public.commercial_v1_entitlements t
        where t.learner_id = p_student and t.activation_id = x.activation_id) as entitled,
      -- Conservative: never suggest a cohort that is not OPEN or is already
      -- full (migration 044's enrolment rules). Only this boolean is used;
      -- no seat count is exposed.
      x.cohort_status = 'OPEN' and (x.capacity is null or (select count(*) from public.enrolments s
        where s.cohort_id = x.cohort_id and s.status <> 'WITHDRAWN') < x.capacity) as cohort_open
    from published x where x.position <= 20
  )
  select jsonb_build_object(
    'mode', (select mode from ctx),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
        'slug', y.slug, 'title', left(y.title, 200), 'examinationBody', left(y.examination_body, 200),
        'qualificationName', left(y.qualification_name, 200), 'priceAmountMinor', y.price_amount_minor,
        'currency', y.currency, 'summary', y.summary, 'cohortStartsOn', to_char(y.starts_on, 'YYYY-MM-DD'),
        'deliveryPlan', y.delivery_plan, 'viewerStatus', y.viewer_status,
        'newPurchaseAvailable', y.viewer_status = 'NONE' and not y.entitled and y.cohort_open)
      order by y.position) from viewer y), '[]'::jsonb),
    'offersTruncated', (select count(*) > 20 from published),
    'completedCourses', case when (select mode from ctx) = 'POST_COURSE' then coalesce((
      select jsonb_agg(jsonb_build_object(
          'programmeTitle', left(coalesce(v.title_snapshot, p.title), 200),
          'qualificationName', left(coalesce(v.qualification_name_snapshot, p.qualification_name), 200),
          'completedOn', (select to_char(r.completed_at at time zone 'UTC', 'YYYY-MM-DD')
            from public.commercial_v1_completion_receipts r where r.enrolment_id = e.id))
        order by e.enrolled_at desc, e.id)
      from (select * from public.enrolments where student_id = p_student and status = 'COMPLETED'
            order by enrolled_at desc, id limit 5) e
      join public.programme_versions v on v.id = e.programme_version_id
      join public.programmes p on p.id = v.programme_id), '[]'::jsonb) else '[]'::jsonb end)
$$;

-- The commercial-context version: a distinct domain tag over the exact
-- projection text (deterministic jsonb). No actor identity is included.
create function sarah_private.commercial_digest(p_projection jsonb) returns text
language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to('SARAH_COMMERCIAL_CONTEXT_V1' || E'\n' || p_projection::text, 'UTF8'),
    'sha256'), 'hex')
$$;

create function sarah_private.commercial_fingerprint(p_student uuid) returns text
language sql stable set search_path='' as $$
  select sarah_private.commercial_digest(sarah_private.commercial_projection(p_student))
$$;

-- Learner-callable, self-scoped (no learner argument), STUDENT only, and
-- refused during an active course before any catalogue is assembled. The
-- commercialFingerprint is an opaque, authority-free version token of the
-- learner's own commercial view (same boundary as AC-5's
-- profileFingerprint): AUTHORIZE also needs the controller MAC and the
-- database recomputes it at AUTHORIZE and START.
create function public.get_my_sarah_commercial_context() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; projection jsonb;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if not exists(select 1 from public.student_profiles where user_id = actor) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if sarah_private.learner_mode(actor) not in ('PROSPECT','POST_COURSE') then
    return jsonb_build_object('ok', false, 'code', 'NOT_AVAILABLE_IN_MODE');
  end if;
  projection := sarah_private.commercial_projection(actor);
  return jsonb_build_object('ok', true, 'commercialFingerprint', sarah_private.commercial_digest(projection))
    || projection;
end $$;

-- ==========================================================================
-- 3. Reservation (054) with the widened intent vocabulary and a course-
--    guidance mode gate. GUIDE / SUPPORT_PROFILE behaviour is unchanged: the
--    same learner lock, replay/conflict and admission bound. A new
--    COURSE_GUIDANCE reservation is refused during an active course and
--    writes no row; an existing reservation still replays or conflicts.
-- ==========================================================================
create or replace function public.reserve_sarah_interaction(p_idempotency_key uuid, p_intent text, p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; prior public.sarah_interaction_reservations%rowtype; inserted integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_idempotency_key is null or p_intent is null or p_intent not in ('GUIDE','SUPPORT_PROFILE','COURSE_GUIDANCE')
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Learner lock first (the same first lock as every Sarah write), so new
  -- reservation admission for one learner is serialised and the bound below
  -- is counted deterministically.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  -- An existing reservation replays (or conflicts) even while the learner is
  -- at the new-reservation bound: retries of a sent request stay safe.
  select * into prior from public.sarah_interaction_reservations where student_id = actor and idempotency_key = p_idempotency_key;
  if found then
    if prior.request_hash <> p_request_hash or prior.intent <> p_intent then
      return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  -- AC-7: course guidance never runs during an active course.
  if p_intent = 'COURSE_GUIDANCE' and sarah_private.learner_mode(actor) not in ('PROSPECT','POST_COURSE') then
    return jsonb_build_object('ok', false, 'code', 'NOT_AVAILABLE_IN_MODE');
  end if;
  -- Admission bound for a genuinely NEW durable row (independent review,
  -- Blocker 1), equal to Sarah's execution admission: at most 5 new
  -- reservations per 60 seconds and 30 per hour, shared by every intent.
  -- Nothing is written when exceeded.
  if (select count(*) from public.sarah_interaction_reservations
        where student_id = actor and reserved_at > clock_timestamp() - interval '60 seconds') >= 5
    or (select count(*) from public.sarah_interaction_reservations
        where student_id = actor and reserved_at > clock_timestamp() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  insert into public.sarah_interaction_reservations(student_id, idempotency_key, intent, request_hash)
  values (actor, p_idempotency_key, p_intent, p_request_hash)
  on conflict (student_id, idempotency_key) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY_CONFLICT'); end if;
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- ==========================================================================
-- 4. Course-guidance execution lifecycle: one finite, attested command
--    surface, separate from govern_sarah_execution (which still accepts
--    only GUIDE / SUPPORT_PROFILE and is unchanged).
-- ==========================================================================
--   DUCELIO_SARAH_COURSE_GUIDANCE_HMAC_SHA256_V1
--   SARAH_EXECUTION_V1
--   platform_role / runtime_profile_ref / behaviour_version
--   key_id / actor / execution_id / idempotency_key / operation
--   mode / COURSE_GUIDANCE / commercial_fingerprint
--   requested_state / requested_reason / requested_budget_stage
--   max_provider_calls / max_output_tokens / max_estimated_cost_microusd
--   provider_calls / attempts / input_tokens / output_tokens /
--   estimated_cost_microusd / elapsed_ms
--   issued_at_epoch_seconds / expires_at_epoch_seconds
create function public.govern_sarah_course_guidance(
  p_key_id uuid, p_platform_role text, p_runtime_profile_ref text, p_behaviour_version text,
  p_execution_id uuid, p_idempotency_key uuid, p_operation text,
  p_mode text, p_commercial_fingerprint text,
  p_state text, p_reason text, p_budget_stage text,
  p_max_calls integer, p_max_output integer, p_max_cost bigint,
  p_calls integer, p_attempts integer, p_input integer, p_output integer, p_cost bigint, p_elapsed integer,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; r public.sarah_interaction_reservations%rowtype; x public.sarah_executions%rowtype;
  stamp timestamptz; denied text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_key_id is null or p_platform_role is null or p_runtime_profile_ref is null or p_behaviour_version is null
    or p_execution_id is null or p_idempotency_key is null
    or p_operation is null or p_operation not in ('AUTHORIZE','START','FINALIZE')
    or p_mode is null or p_mode not in ('PROSPECT','ACTIVE_COURSE','POST_COURSE')
    or p_commercial_fingerprint is null or p_commercial_fingerprint !~ '^[0-9a-f]{64}$'
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','BUDGET_BLOCKED','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','PROVIDER_COMPLETE','PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR',
      'OUTPUT_INVALID','POLICY_BLOCKED','NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','BUDGET_BLOCKED',
      'EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls not between 0 and 1
    or p_max_output is null or p_max_output not between 0 and 500
    or p_max_cost is null or p_max_cost not between 0 and 10000
    or p_calls is null or p_calls not between 0 and 1
    -- One attempt at most: COUNSELLOR_PLATFORM_V1 allows no retries.
    or p_attempts is null or p_attempts not between 0 and 1
    or p_input is null or p_input not between 0 and 1000000
    or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000
    or p_elapsed is null or p_elapsed not between 0 and 60000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_SARAH_COURSE_GUIDANCE_HMAC_SHA256_V1', 'SARAH_EXECUTION_V1', p_platform_role, p_runtime_profile_ref,
      p_behaviour_version, p_key_id::text, actor::text, p_execution_id::text, p_idempotency_key::text, p_operation,
      p_mode, 'COURSE_GUIDANCE', p_commercial_fingerprint, p_state, p_reason, p_budget_stage,
      p_max_calls::text, p_max_output::text, p_max_cost::text,
      p_calls::text, p_attempts::text, p_input::text, p_output::text, p_cost::text, p_elapsed::text,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_EXECUTION');
  end if;
  -- Only the platform COUNSELLOR on its one fixed profile, with the course-
  -- guidance behaviour, and never during an active course.
  if p_platform_role <> 'COUNSELLOR' or p_runtime_profile_ref <> 'COUNSELLOR_PLATFORM_V1'
    or p_behaviour_version <> 'SARAH_COMMERCIAL_BEHAVIOUR_V1' or p_mode not in ('PROSPECT','POST_COURSE') then
    return jsonb_build_object('ok', false, 'code', 'POLICY_BLOCKED');
  end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  stamp := clock_timestamp();
  update public.sarah_executions set state = 'TIMEOUT', reason_code = 'EXECUTION_TIMEOUT', terminal_at = expires_at
  where student_id = actor and state in ('AUTHORIZED','RUNNING') and expires_at <= stamp;

  if p_operation = 'AUTHORIZE' then
    if p_state <> 'AUTHORIZED' or p_reason <> 'NONE' or p_budget_stage <> 'NONE'
      or p_calls <> 0 or p_attempts <> 0 or p_input <> 0 or p_output <> 0 or p_cost <> 0 or p_elapsed <> 0 then
      return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    end if;
    select * into r from public.sarah_interaction_reservations where student_id = actor and idempotency_key = p_idempotency_key;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    if r.intent <> 'COURSE_GUIDANCE' then return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT'); end if;
    if exists(select 1 from public.sarah_executions where id = p_execution_id
        or (student_id = actor and idempotency_key = p_idempotency_key)) then
      return jsonb_build_object('ok', false, 'code', 'REPLAY_REJECTED');
    end if;
    -- Mode and the commercial-context version are database truths; the
    -- commercial context the server read must still be current.
    if sarah_private.learner_mode(actor) <> p_mode
      or sarah_private.commercial_fingerprint(actor) <> p_commercial_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
    end if;
    -- The same Sarah admission envelope as AC-5, shared across intents.
    if exists(select 1 from public.sarah_executions where student_id = actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.sarah_executions where student_id = actor and created_at > stamp - interval '60 seconds') >= 5
      or (select count(*) from public.sarah_executions where student_id = actor and created_at > stamp - interval '1 hour') >= 30 then
      denied := 'RATE_LIMITED';
    elsif p_max_calls <> 1 or p_max_output < 1 or p_max_output > 500 or p_max_cost < 1 or p_max_cost > 10000 then
      denied := 'OUT_OF_ENVELOPE';
    end if;
    stamp := clock_timestamp();
    insert into public.sarah_executions(id, student_id, idempotency_key, behaviour_version, mode, intent,
      source_profile_sha256, source_commercial_sha256, state, reason_code, created_at, authorized_at, expires_at,
      terminal_at, max_provider_calls, max_output_tokens, max_estimated_cost_microusd)
    values (p_execution_id, actor, p_idempotency_key, 'SARAH_COMMERCIAL_BEHAVIOUR_V1', p_mode, 'COURSE_GUIDANCE',
      null, p_commercial_fingerprint,
      case when denied is null then 'AUTHORIZED' else 'BLOCKED' end, denied, stamp,
      case when denied is null then stamp else null end, stamp + interval '20 seconds',
      case when denied is null then null else stamp end, 1,
      case when denied is null then p_max_output else 1 end, case when denied is null then p_max_cost else 1 end);
    return sarah_private.execution_projection(p_execution_id, true);
  end if;

  select * into x from public.sarah_executions
  where id = p_execution_id and student_id = actor and idempotency_key = p_idempotency_key;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.intent <> 'COURSE_GUIDANCE' or x.mode <> p_mode
    or x.source_commercial_sha256 is distinct from p_commercial_fingerprint then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  if x.state not in ('AUTHORIZED','RUNNING') then
    return jsonb_build_object('ok', false, 'code',
      case when x.reason_code = 'EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;
  stamp := clock_timestamp();
  if stamp >= x.expires_at then
    update public.sarah_executions set state = 'TIMEOUT', reason_code = 'EXECUTION_TIMEOUT', terminal_at = x.expires_at
    where id = x.id;
    return jsonb_build_object('ok', false, 'code', 'EXECUTION_TIMEOUT');
  end if;

  if p_operation = 'START' then
    if p_state <> 'RUNNING' or p_reason <> 'NONE' or p_budget_stage <> 'NONE'
      or p_max_calls <> 0 or p_max_output <> 0 or p_max_cost <> 0
      or p_calls <> 0 or p_attempts <> 0 or p_input <> 0 or p_output <> 0 or p_cost <> 0 or p_elapsed <> 0 then
      return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    end if;
    if x.state <> 'AUTHORIZED' then return jsonb_build_object('ok', false, 'code', 'REPLAY_REJECTED'); end if;
    -- Final pre-provider authority check under the learner lock: the mode
    -- and the commercial context (published offers, prices, the learner's
    -- own enrolment state, completed identities) must still be exactly what
    -- AUTHORIZE admitted. Otherwise the execution is closed
    -- FAILED/POLICY_BLOCKED and no provider call is admitted: Sarah never
    -- answers from a stale catalogue or price.
    if sarah_private.learner_mode(actor) <> x.mode
      or sarah_private.commercial_fingerprint(actor) <> x.source_commercial_sha256 then
      update public.sarah_executions set state = 'FAILED', reason_code = 'POLICY_BLOCKED', terminal_at = stamp
      where id = x.id;
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
    end if;
    update public.sarah_executions set state = 'RUNNING', started_at = stamp where id = x.id;
    return sarah_private.execution_projection(x.id, true);
  end if;

  -- FINALIZE: RUNNING only, one reviewed terminal outcome, usage recorded.
  if x.state <> 'RUNNING' or p_max_calls <> 0 or p_max_output <> 0 or p_max_cost <> 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not (
    (p_state = 'SUCCEEDED' and p_reason = 'PROVIDER_COMPLETE' and p_budget_stage = 'NONE') or
    (p_state = 'FAILED' and p_budget_stage = 'NONE' and p_reason in ('PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR',
      'OUTPUT_INVALID','POLICY_BLOCKED','EXECUTION_TIMEOUT')) or
    (p_state = 'ABSTAINED' and p_budget_stage = 'NONE'
      and p_reason in ('NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','POLICY_BLOCKED')) or
    (p_state = 'BUDGET_BLOCKED' and p_reason = 'BUDGET_BLOCKED' and p_budget_stage in ('PRE_CALL','POST_CALL')) or
    (p_state = 'CANCELLED' and p_reason = 'CANCELLED' and p_budget_stage = 'NONE')
  ) then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  if p_calls > x.max_provider_calls then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  if p_state = 'SUCCEEDED' and (p_calls <> 1 or p_output > x.max_output_tokens or p_cost > x.max_estimated_cost_microusd) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  insert into public.sarah_execution_usage(execution_id, provider_calls, attempts, input_tokens, output_tokens,
    estimated_cost_microusd, elapsed_ms)
  values (x.id, p_calls, p_attempts, p_input, p_output, p_cost, p_elapsed);
  update public.sarah_executions
  set state = p_state, reason_code = p_reason, budget_stage = nullif(p_budget_stage, 'NONE'), terminal_at = stamp
  where id = x.id;
  return sarah_private.execution_projection(x.id, true);
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification (054 surface
-- plus the two AC-7 RPCs; every sarah_private function stays closed).
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'sarah_private'
       or (n.nspname = 'public' and p.proname in ('get_my_sarah_context','reserve_sarah_interaction',
         'govern_sarah_execution','record_sarah_profile_proposal','list_my_sarah_profile_proposals',
         'decide_sarah_profile_proposal','get_my_sarah_commercial_context','govern_sarah_course_guidance')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- Column-level privileges on the evolved ledger must not exist either.
do $$ declare cols text; r text; begin
  select string_agg(quote_ident(attname), ',') into cols from pg_attribute
  where attrelid = 'public.sarah_executions'::regclass and attnum > 0 and not attisdropped;
  foreach r in array array['public','anon','authenticated','service_role'] loop
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.sarah_executions from %I',
      cols, cols, cols, cols, r);
  end loop;
end $$;
grant execute on function public.get_my_sarah_context() to authenticated;
grant execute on function public.reserve_sarah_interaction(uuid,text,text) to authenticated;
grant execute on function public.govern_sarah_execution(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,
  integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text) to authenticated;
grant execute on function public.record_sarah_profile_proposal(uuid,uuid,text,integer,text,bigint,bigint,text) to authenticated;
grant execute on function public.list_my_sarah_profile_proposals() to authenticated;
grant execute on function public.decide_sarah_profile_proposal(uuid,text) to authenticated;
grant execute on function public.get_my_sarah_commercial_context() to authenticated;
grant execute on function public.govern_sarah_course_guidance(uuid,text,text,text,uuid,uuid,text,text,text,text,text,text,
  integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text) to authenticated;

do $sarah_course_guidance_acl$
declare r text; f record; t text;
  reviewed oid[] := array[
    'public.get_my_sarah_context()'::regprocedure::oid,
    'public.reserve_sarah_interaction(uuid,text,text)'::regprocedure::oid,
    'public.govern_sarah_execution(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text)'::regprocedure::oid,
    'public.record_sarah_profile_proposal(uuid,uuid,text,integer,text,bigint,bigint,text)'::regprocedure::oid,
    'public.list_my_sarah_profile_proposals()'::regprocedure::oid,
    'public.decide_sarah_profile_proposal(uuid,text)'::regprocedure::oid,
    'public.get_my_sarah_commercial_context()'::regprocedure::oid,
    'public.govern_sarah_course_guidance(uuid,text,text,text,uuid,uuid,text,text,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text)'::regprocedure::oid
  ];
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'sarah_private', 'USAGE,CREATE') then
      raise exception 'Unsafe Sarah schema privileges for %', r;
    end if;
    foreach t in array array['public.sarah_interaction_reservations','public.sarah_executions',
        'public.sarah_execution_usage','public.sarah_support_profile_proposals'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe privileges for % on %', r, t;
      end if;
      if current_setting('server_version_num')::integer >= 170000 then
        if has_table_privilege(r, t, 'MAINTAIN') then
          raise exception 'Unsafe privileges for % on %', r, t;
        end if;
      end if;
    end loop;
    for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'sarah_private'
        or (n.nspname = 'public' and (p.proname like '%sarah%')) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.oid = any(reviewed)) then
        raise exception 'Unsafe Sarah function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $sarah_course_guidance_acl$;
