-- AC-5: Sarah Mitchell production execution plane (learner guide).
-- Additive only; migrations 001-053 are byte-for-byte unchanged, and no
-- existing attested message format (022/025/028/031/032/040/051/053) is
-- altered.
--
-- Design (docs/47-agent-behaviour-ac5-sarah.md):
--
-- 1. Sarah Mitchell is Ducelio's AI learner-success counsellor and learner
--    guide. Her technical authority is the PLATFORM role COUNSELLOR with the
--    fixed runtime profile COUNSELLOR_PLATFORM_V1. Nothing here reads or
--    writes academic_agent_configs, behaviour bindings, Professor, Tutor/Lab
--    or Examiner execution tables. The historical academic COUNSELLOR row
--    stays non-executable and cannot launch Sarah.
-- 2. Sarah is not a human staff account. She has no app_users row, role
--    grant or counsellor assignment, and nothing here consults
--    counsellor_assignments for authority or reads counsellor_interactions.
--    Authority is: the authenticated STUDENT, acting on their own records.
-- 3. SARAH_EXECUTION_V1: a separate, content-free execution ledger with the
--    AUTHORIZE/START/FINALIZE lifecycle, attested with the EXISTING
--    controller key store (migration 022, via
--    agent_behaviour_private.verify_mac) under the NEW protocol tag
--    DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1. Exactly one provider call per
--    learner request; the budget ceiling equals COUNSELLOR_PLATFORM_V1's.
--    One execution per idempotency reservation.
-- 4. A bounded, learner-owned context projection (get_my_sarah_context):
--    confirmed support profile, enrolment and schedule summaries, study-plan
--    counts, open support-event and notification KINDS with counts, open
--    follow-up count and whether a human counsellor is assigned. Never:
--    human counsellor notes, follow-up or plan item titles, transcripts,
--    Tutor notes, assessment content, grades, payments or audit.
-- 5. Support-profile proposals: created only from a SUCCEEDED
--    SUPPORT_PROFILE execution, through a second new attested RPC
--    (DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1). Proposed values are
--    immutable. Only the owning learner confirms or declines. Confirmation
--    re-checks, under the learner lock, that the confirmed profile has not
--    changed since Sarah saw it (STALE_PROPOSAL otherwise) and applies
--    exactly the proposed fields to student_support_profiles, the single
--    confirmed-profile truth.
-- 6. No learner message, Sarah reply, prompt or provider payload is stored
--    anywhere. Audit carries identifiers, states and field NAMES only, with
--    a truthful source per state.
-- 7. Independent-review corrections: new reservations are admission-bounded
--    under the learner lock; at most one provider attempt is recorded; an
--    absent support profile is never treated as confirmed defaults; START
--    re-checks mode and profile version before any provider call; and the
--    known previously seeded fictional human "Sarah Mitchell" fixture is
--    renamed (section 10).

create schema sarah_private;
revoke all on schema sarah_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Derived learner facts (database-owned; never caller-supplied).
-- ==========================================================================

-- PROSPECT: no enrolment. ACTIVE_COURSE: any ACTIVE or PAUSED enrolment.
-- POST_COURSE: only COMPLETED or WITHDRAWN enrolments.
create function sarah_private.learner_mode(p_student uuid) returns text
language sql stable set search_path='' as $$
  select case
    when exists(select 1 from public.enrolments e where e.student_id = p_student and e.status in ('ACTIVE','PAUSED'))
      then 'ACTIVE_COURSE'
    when exists(select 1 from public.enrolments e where e.student_id = p_student)
      then 'POST_COURSE'
    else 'PROSPECT'
  end
$$;

-- A version fingerprint of the learner's confirmed support profile. Every
-- confirmed write sets updated_at, so any change after Sarah saw the
-- profile changes the fingerprint (no last-write-wins). The goal is last:
-- the fields before it have fixed formats, so the encoding is unambiguous.
create function sarah_private.profile_fingerprint(p_student uuid) returns text
language sql stable set search_path='' as $$
  select encode(extensions.digest(convert_to(coalesce(
    (select concat_ws(E'\n', 'SARAH_SUPPORT_PROFILE_V1', 'PRESENT', s.weekly_hours::text, s.preferred_contact,
       to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), s.study_goal)
     from public.student_support_profiles s where s.student_id = p_student),
    concat_ws(E'\n', 'SARAH_SUPPORT_PROFILE_V1', 'ABSENT')), 'UTF8'), 'sha256'), 'hex')
$$;

create function sarah_private.profile_view(p_student uuid) returns jsonb
language sql stable set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('confirmed', true, 'studyGoal', nullif(s.study_goal, ''),
       'weeklyHours', s.weekly_hours, 'preferredContact', s.preferred_contact)
     from public.student_support_profiles s where s.student_id = p_student),
    jsonb_build_object('confirmed', false, 'studyGoal', null, 'weeklyHours', null, 'preferredContact', null))
$$;

-- ==========================================================================
-- 1. Interaction reservation: one durable row per (learner, idempotency
--    key), written BEFORE any provider work. Only the SHA-256 of the
--    request material is stored, never the message.
-- ==========================================================================
create table public.sarah_interaction_reservations (
  student_id uuid not null references public.student_profiles(user_id),
  idempotency_key uuid not null,
  intent text not null check(intent in ('GUIDE','SUPPORT_PROFILE')),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz not null default clock_timestamp(),
  primary key(student_id, idempotency_key)
);
-- Admission bound for NEW reservations (independent review, Blocker 1).
create index sarah_interaction_reservations_admission
  on public.sarah_interaction_reservations(student_id, reserved_at);
alter table public.sarah_interaction_reservations enable row level security;
revoke all on public.sarah_interaction_reservations from public, anon, authenticated, service_role;

create function sarah_private.guard_reservation() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'SARAH_RESERVATION_IMMUTABLE: Sarah interaction reservations cannot be updated or deleted'
    using errcode = '55000';
end $$;
create trigger guard_sarah_interaction_reservation
before update or delete on public.sarah_interaction_reservations
for each row execute function sarah_private.guard_reservation();

-- ==========================================================================
-- 2. Execution ledger: SARAH_EXECUTION_V1. Content-free.
-- ==========================================================================
create table public.sarah_executions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(user_id),
  idempotency_key uuid not null,
  policy_version text not null default 'SARAH_EXECUTION_V1' check(policy_version = 'SARAH_EXECUTION_V1'),
  platform_role text not null default 'COUNSELLOR' check(platform_role = 'COUNSELLOR'),
  runtime_profile_ref text not null default 'COUNSELLOR_PLATFORM_V1' check(runtime_profile_ref = 'COUNSELLOR_PLATFORM_V1'),
  behaviour_version text not null default 'SARAH_BEHAVIOUR_V1' check(behaviour_version = 'SARAH_BEHAVIOUR_V1'),
  mode text not null check(mode in ('PROSPECT','ACTIVE_COURSE','POST_COURSE')),
  intent text not null check(intent in ('GUIDE','SUPPORT_PROFILE')),
  -- The confirmed-profile version the context showed Sarah (verified by the
  -- database at AUTHORIZE). Never returned to the learner or audited.
  source_profile_sha256 text not null check(source_profile_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check(state in (
    'AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','BUDGET_BLOCKED','TIMEOUT','CANCELLED','BLOCKED'
  )),
  reason_code text,
  budget_stage text check(budget_stage in ('PRE_CALL','POST_CALL')),
  created_at timestamptz not null,
  authorized_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz not null,
  -- Equal to (never looser than) COUNSELLOR_PLATFORM_V1: one call, 500
  -- output tokens, 10,000 microUSD.
  max_provider_calls integer not null check(max_provider_calls = 1),
  max_output_tokens integer not null check(max_output_tokens between 1 and 500),
  max_estimated_cost_microusd bigint not null check(max_estimated_cost_microusd between 1 and 10000),
  unique(student_id, idempotency_key),
  foreign key(student_id, idempotency_key) references public.sarah_interaction_reservations(student_id, idempotency_key),
  check(expires_at > created_at and expires_at <= created_at + interval '20 seconds'),
  check(authorized_at is null or authorized_at = created_at),
  check(started_at is null or (started_at >= created_at and started_at < expires_at)),
  check(terminal_at is null or terminal_at >= coalesce(started_at, created_at)),
  check(
    (state = 'AUTHORIZED' and authorized_at is not null and started_at is null and terminal_at is null
      and reason_code is null and budget_stage is null) or
    (state = 'RUNNING' and authorized_at is not null and started_at is not null and terminal_at is null
      and reason_code is null and budget_stage is null) or
    (state = 'SUCCEEDED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code = 'PROVIDER_COMPLETE' and budget_stage is null) or
    (state = 'FAILED' and authorized_at is not null and terminal_at is not null and budget_stage is null
      and reason_code in ('PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
        'PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','EXECUTION_TIMEOUT')) or
    (state = 'ABSTAINED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and budget_stage is null and reason_code in ('NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','POLICY_BLOCKED')) or
    (state = 'BUDGET_BLOCKED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code = 'BUDGET_BLOCKED' and budget_stage in ('PRE_CALL','POST_CALL')) or
    (state = 'TIMEOUT' and authorized_at is not null and terminal_at is not null
      and reason_code = 'EXECUTION_TIMEOUT' and budget_stage is null) or
    (state = 'CANCELLED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code = 'CANCELLED' and budget_stage is null) or
    (state = 'BLOCKED' and authorized_at is null and started_at is null and terminal_at = created_at
      and budget_stage is null and reason_code in ('RATE_LIMITED','OUT_OF_ENVELOPE'))
  )
);
create index sarah_executions_admission on public.sarah_executions(student_id, created_at);
create index sarah_executions_active on public.sarah_executions(student_id, expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.sarah_executions enable row level security;
revoke all on public.sarah_executions from public, anon, authenticated, service_role;

create table public.sarah_execution_usage (
  execution_id uuid primary key references public.sarah_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 1),
  -- COUNSELLOR_PLATFORM_V1 allows exactly one attempt (no retries).
  attempts integer not null check(attempts between 0 and 1),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.sarah_execution_usage enable row level security;
revoke all on public.sarah_execution_usage from public, anon, authenticated, service_role;

-- Terminal history is immutable; identity, scope and budget never change;
-- only the reviewed forward transitions exist; nothing is deleted.
create function sarah_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: execution history cannot be deleted' using errcode = '55000';
  end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then
    raise exception 'SARAH_EXECUTION_IMMUTABLE: terminal execution history is immutable' using errcode = '55000';
  end if;
  if row(NEW.id, NEW.student_id, NEW.idempotency_key, NEW.policy_version, NEW.platform_role, NEW.runtime_profile_ref,
      NEW.behaviour_version, NEW.mode, NEW.intent, NEW.source_profile_sha256, NEW.created_at, NEW.authorized_at,
      NEW.expires_at, NEW.max_provider_calls, NEW.max_output_tokens, NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id, OLD.student_id, OLD.idempotency_key, OLD.policy_version, OLD.platform_role,
      OLD.runtime_profile_ref, OLD.behaviour_version, OLD.mode, OLD.intent, OLD.source_profile_sha256, OLD.created_at,
      OLD.authorized_at, OLD.expires_at, OLD.max_provider_calls, OLD.max_output_tokens, OLD.max_estimated_cost_microusd) then
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
create trigger guard_sarah_execution_history
before update or delete on public.sarah_executions
for each row execute function sarah_private.guard_execution();

create function sarah_private.guard_usage() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'SARAH_EXECUTION_IMMUTABLE: execution usage is append-only' using errcode = '55000';
end $$;
create trigger guard_sarah_execution_usage
before update or delete on public.sarah_execution_usage
for each row execute function sarah_private.guard_usage();

-- Audit: identifiers, scope, state, budget and usage counts only. No
-- message, reply, prompt, profile value or profile fingerprint.
--
-- The source follows the resulting execution SHAPE (independent re-review),
-- never reason_code alone:
--   BLOCKED                                    -> DATABASE_EXECUTION_POLICY
--     (AUTHORIZE admission refused: RATE_LIMITED / OUT_OF_ENVELOPE)
--   TIMEOUT                                    -> DATABASE_EXECUTION_POLICY
--     (the database lease expiry)
--   FAILED / POLICY_BLOCKED, started_at null   -> DATABASE_EXECUTION_POLICY
--     (the START mode/profile re-check refused before any provider call)
--   everything else                            -> ATTESTED_EXECUTION_CONTROLLER
--     (AUTHORIZED, RUNNING and every controller FINALIZE, including a
--     runtime-reported FAILED / EXECUTION_TIMEOUT after START)
-- A controller FINALIZE always follows START, so it never has a null
-- started_at, and it can never request TIMEOUT or BLOCKED.
create function sarah_private.audit_execution() returns trigger
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
    'Sarah Mitchell learner-guide execution lifecycle',
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
create trigger audit_sarah_execution
after insert or update on public.sarah_executions
for each row execute function sarah_private.audit_execution();

-- ==========================================================================
-- 3. Support-profile proposals: structured, bounded, immutable content.
-- ==========================================================================
create table public.sarah_support_profile_proposals (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  source_execution_id uuid not null unique references public.sarah_executions(id),
  proposal_policy text not null default 'SARAH_PROFILE_PROPOSAL_V1' check(proposal_policy = 'SARAH_PROFILE_PROPOSAL_V1'),
  -- One plain line: no control characters, trimmed, at most 300 characters.
  proposed_study_goal text check(proposed_study_goal is null or (
    length(proposed_study_goal) between 1 and 300 and proposed_study_goal ~ '\S'
    and proposed_study_goal = btrim(proposed_study_goal) and proposed_study_goal !~ '[[:cntrl:]]')),
  proposed_weekly_hours integer check(proposed_weekly_hours between 0 and 80),
  proposed_preferred_contact text check(proposed_preferred_contact in ('ACADEMY','EMAIL')),
  source_profile_sha256 text not null check(source_profile_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'PENDING' check(state in ('PENDING','CONFIRMED','DECLINED','STALE')),
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  check(proposed_study_goal is not null or proposed_weekly_hours is not null or proposed_preferred_contact is not null),
  check((state = 'PENDING' and decided_at is null) or (state <> 'PENDING' and decided_at is not null and decided_at >= created_at))
);
create index sarah_support_profile_proposals_student on public.sarah_support_profile_proposals(student_id, created_at desc);
alter table public.sarah_support_profile_proposals enable row level security;
revoke all on public.sarah_support_profile_proposals from public, anon, authenticated, service_role;

-- Structural backstop for every table writer, including the database owner:
-- a proposal needs a SUCCEEDED SUPPORT_PROFILE execution of the same learner
-- and that execution's own source profile version; content is immutable;
-- the only change is one PENDING -> CONFIRMED|DECLINED|STALE transition.
-- The full application authority (attestation, staleness, limits, the
-- learner lock) belongs to the public RPCs below.
create function sarah_private.guard_proposal() returns trigger
language plpgsql set search_path='' as $$
declare x public.sarah_executions%rowtype;
begin
  if TG_OP = 'DELETE' then
    raise exception 'SARAH_PROPOSAL_IMMUTABLE: a Sarah proposal cannot be deleted' using errcode = '55000';
  end if;
  if TG_OP = 'INSERT' then
    select * into x from public.sarah_executions where id = NEW.source_execution_id;
    if x.id is null or x.student_id <> NEW.student_id or x.state <> 'SUCCEEDED' or x.intent <> 'SUPPORT_PROFILE'
      or x.source_profile_sha256 <> NEW.source_profile_sha256 then
      raise exception 'SARAH_PROPOSAL_SOURCE_INVALID: a proposal needs a SUCCEEDED Sarah support-profile execution of this learner'
        using errcode = '55000';
    end if;
    NEW.proposal_policy := 'SARAH_PROFILE_PROPOSAL_V1';
    NEW.state := 'PENDING';
    NEW.decided_at := null;
    NEW.created_at := clock_timestamp();
    return NEW;
  end if;
  if row(NEW.id, NEW.student_id, NEW.source_execution_id, NEW.proposal_policy, NEW.proposed_study_goal,
      NEW.proposed_weekly_hours, NEW.proposed_preferred_contact, NEW.source_profile_sha256, NEW.created_at)
    is distinct from row(OLD.id, OLD.student_id, OLD.source_execution_id, OLD.proposal_policy, OLD.proposed_study_goal,
      OLD.proposed_weekly_hours, OLD.proposed_preferred_contact, OLD.source_profile_sha256, OLD.created_at)
    or OLD.state <> 'PENDING' or NEW.state not in ('CONFIRMED','DECLINED','STALE') then
    raise exception 'SARAH_PROPOSAL_IMMUTABLE: proposal content is immutable and a decision is final' using errcode = '55000';
  end if;
  NEW.decided_at := clock_timestamp();
  return NEW;
end $$;
create trigger guard_sarah_support_profile_proposal
before insert or update or delete on public.sarah_support_profile_proposals
for each row execute function sarah_private.guard_proposal();

-- Audit: identifiers, state and changed field NAMES only, never values.
-- The source is truthful per resulting state (independent review, Blocker
-- 5): a PENDING proposal is written by the attested controller; CONFIRMED
-- and DECLINED are the learner's own decision; STALE is always chosen by
-- the database staleness policy, including when a learner's CONFIRM
-- attempt finds the profile changed.
create function sarah_private.audit_proposal() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state, occurred_at)
  values (NEW.student_id, 'SARAH_PROFILE_PROPOSAL_' || NEW.state, 'sarah_support_profile_proposals', NEW.id,
    case NEW.state
      when 'PENDING' then 'ATTESTED_EXECUTION_CONTROLLER'
      when 'STALE' then 'DATABASE_STALE_POLICY'
      else 'LEARNER_DECISION'
    end,
    'Sarah Mitchell support-profile proposal',
    jsonb_build_object('proposal_id', NEW.id, 'student_id', NEW.student_id,
      'source_execution_id', NEW.source_execution_id, 'state', NEW.state,
      'changed_fields', to_jsonb(array_remove(array[
        case when NEW.proposed_study_goal is not null then 'study_goal' end,
        case when NEW.proposed_weekly_hours is not null then 'weekly_hours' end,
        case when NEW.proposed_preferred_contact is not null then 'preferred_contact' end], null)),
      'created_at', NEW.created_at, 'decided_at', NEW.decided_at),
    clock_timestamp());
  return NEW;
end $$;
create trigger audit_sarah_support_profile_proposal
after insert or update on public.sarah_support_profile_proposals
for each row execute function sarah_private.audit_proposal();

-- ==========================================================================
-- 4. Learner-owned context projection (read-only, STUDENT only).
-- ==========================================================================
create function public.get_my_sarah_context() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if not exists(select 1 from public.student_profiles where user_id = actor) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  return jsonb_build_object(
    'ok', true,
    'mode', sarah_private.learner_mode(actor),
    'profileFingerprint', sarah_private.profile_fingerprint(actor),
    'supportProfile', sarah_private.profile_view(actor),
    'enrolments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'programmeTitle', left(p.title, 200), 'cohortTitle', left(c.title, 200),
        'cohortStartsOn', to_char(c.starts_on, 'YYYY-MM-DD'), 'status', e.status,
        'deliveryPlan', (select jsonb_build_object('state', d.state, 'studyDays', to_jsonb(d.study_days),
            'localStartTime', to_char(d.local_start_time, 'HH24:MI'), 'timezone', left(d.timezone, 100))
          from public.delivery_study_plans d where d.enrolment_id = e.id))
        order by e.enrolled_at desc, e.id)
      from (select * from public.enrolments where student_id = actor order by enrolled_at desc, id limit 5) e
      join public.cohorts c on c.id = e.cohort_id
      join public.programme_versions v on v.id = e.programme_version_id
      join public.programmes p on p.id = v.programme_id), '[]'::jsonb),
    'upcomingClasses', coalesce((
      select jsonb_agg(jsonb_build_object('lessonTitle', left(s.lesson_title, 200),
        'scheduledStart', s.scheduled_start, 'scheduledEnd', s.scheduled_end) order by s.scheduled_start, s.id)
      from (select cs.id, cs.scheduled_start, cs.scheduled_end, l.title as lesson_title
            from public.class_sessions cs
            join public.enrolments e on e.cohort_id = cs.cohort_id and e.programme_version_id = cs.programme_version_id
            join public.lessons l on l.id = cs.lesson_id
            where e.student_id = actor and e.status = 'ACTIVE' and cs.status = 'SCHEDULED'
              and cs.scheduled_end > clock_timestamp()
            order by cs.scheduled_start, cs.id limit 3) s), '[]'::jsonb),
    'studyPlan', (
      select jsonb_build_object('active', count(sp.id) > 0,
        'plannedItems', (select count(*) from public.study_plan_items i join public.study_plans p2 on p2.id = i.plan_id
          where i.student_id = actor and p2.status = 'ACTIVE' and i.status = 'PLANNED'),
        'overdueItems', (select count(*) from public.study_plan_items i join public.study_plans p2 on p2.id = i.plan_id
          where i.student_id = actor and p2.status = 'ACTIVE' and i.status = 'PLANNED' and i.due_on < current_date),
        'nextDueOn', (select to_char(min(i.due_on), 'YYYY-MM-DD') from public.study_plan_items i
          join public.study_plans p2 on p2.id = i.plan_id
          where i.student_id = actor and p2.status = 'ACTIVE' and i.status = 'PLANNED' and i.due_on >= current_date))
      from public.study_plans sp where sp.student_id = actor and sp.status = 'ACTIVE'),
    'openSupportEvents', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'count', n) order by kind)
      from (select kind, count(*) as n from public.support_events where student_id = actor and status = 'OPEN' group by kind) k),
      '[]'::jsonb),
    'openFollowUps', (select count(*) from public.support_followups where student_id = actor and status = 'OPEN'),
    'unreadNotifications', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'count', n) order by kind)
      from (select kind, count(*) as n from public.institutional_notifications
            where student_id = actor and read_at is null group by kind) k), '[]'::jsonb),
    'humanCounsellorAssigned', exists(select 1 from public.counsellor_assignments a
      where a.student_id = actor and a.starts_at <= clock_timestamp() and a.ended_at is null));
end $$;

-- ==========================================================================
-- 5. Reservation RPC: before any provider work. Same key and same request
--    material is a safe duplicate; same key with a different intent or
--    message fails closed.
-- ==========================================================================
create function public.reserve_sarah_interaction(p_idempotency_key uuid, p_intent text, p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; prior public.sarah_interaction_reservations%rowtype; inserted integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_idempotency_key is null or p_intent is null or p_intent not in ('GUIDE','SUPPORT_PROFILE')
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
  -- Admission bound for a genuinely NEW durable row (independent review,
  -- Blocker 1), equal to Sarah's execution admission: at most 5 new
  -- reservations per 60 seconds and 30 per hour. Nothing is written when
  -- exceeded.
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
-- 6. Execution lifecycle: one finite, attested command surface.
-- ==========================================================================
--   DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1
--   SARAH_EXECUTION_V1
--   platform_role / runtime_profile_ref
--   key_id / actor / execution_id / idempotency_key / operation
--   mode / intent / profile_fingerprint
--   requested_state / requested_reason / requested_budget_stage
--   max_provider_calls / max_output_tokens / max_estimated_cost_microusd
--   provider_calls / attempts / input_tokens / output_tokens /
--   estimated_cost_microusd / elapsed_ms
--   issued_at_epoch_seconds / expires_at_epoch_seconds
create function sarah_private.execution_projection(p_id uuid, p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok', true, 'transitioned', p_changed, 'execution', jsonb_build_object(
    'executionId', e.id, 'studentId', e.student_id, 'policyVersion', e.policy_version,
    'platformRole', e.platform_role, 'runtimeProfileRef', e.runtime_profile_ref, 'mode', e.mode, 'intent', e.intent,
    'state', e.state, 'reasonCode', e.reason_code, 'budgetStage', e.budget_stage, 'createdAt', e.created_at,
    'authorizedAt', e.authorized_at, 'startedAt', e.started_at, 'terminalAt', e.terminal_at, 'expiresAt', e.expires_at,
    'budget', jsonb_build_object('maxProviderCalls', e.max_provider_calls, 'maxOutputTokens', e.max_output_tokens,
      'maxEstimatedCostMicrousd', e.max_estimated_cost_microusd),
    'usage', (select jsonb_build_object('providerCalls', u.provider_calls, 'attempts', u.attempts,
      'inputTokens', u.input_tokens, 'outputTokens', u.output_tokens,
      'estimatedCostMicrousd', u.estimated_cost_microusd, 'elapsedMs', u.elapsed_ms)
      from public.sarah_execution_usage u where u.execution_id = e.id)))
  from public.sarah_executions e where e.id = p_id and e.student_id = public.current_app_user()
$$;

create function public.govern_sarah_execution(
  p_key_id uuid, p_platform_role text, p_runtime_profile_ref text,
  p_execution_id uuid, p_idempotency_key uuid, p_operation text,
  p_mode text, p_intent text, p_profile_fingerprint text,
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
  if p_key_id is null or p_platform_role is null or p_runtime_profile_ref is null or p_execution_id is null
    or p_idempotency_key is null or p_operation is null or p_operation not in ('AUTHORIZE','START','FINALIZE')
    or p_mode is null or p_mode not in ('PROSPECT','ACTIVE_COURSE','POST_COURSE')
    or p_intent is null or p_intent not in ('GUIDE','SUPPORT_PROFILE')
    or p_profile_fingerprint is null or p_profile_fingerprint !~ '^[0-9a-f]{64}$'
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
      'DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1', 'SARAH_EXECUTION_V1', p_platform_role, p_runtime_profile_ref,
      p_key_id::text, actor::text, p_execution_id::text, p_idempotency_key::text, p_operation,
      p_mode, p_intent, p_profile_fingerprint, p_state, p_reason, p_budget_stage,
      p_max_calls::text, p_max_output::text, p_max_cost::text,
      p_calls::text, p_attempts::text, p_input::text, p_output::text, p_cost::text, p_elapsed::text,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_EXECUTION');
  end if;
  -- Sarah is only ever the platform COUNSELLOR on its one fixed profile. An
  -- academic role, another profile or a cross-role reference never runs.
  if p_platform_role <> 'COUNSELLOR' or p_runtime_profile_ref <> 'COUNSELLOR_PLATFORM_V1' then
    return jsonb_build_object('ok', false, 'code', 'POLICY_BLOCKED');
  end if;
  -- The learner lock serialises every Sarah transition with proposal
  -- creation and confirmation for this learner (same order everywhere:
  -- learner profile first).
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
    if r.intent <> p_intent then return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT'); end if;
    if exists(select 1 from public.sarah_executions where id = p_execution_id
        or (student_id = actor and idempotency_key = p_idempotency_key)) then
      return jsonb_build_object('ok', false, 'code', 'REPLAY_REJECTED');
    end if;
    -- Mode and the confirmed-profile version are database truths; the
    -- context the server read must still be current.
    if sarah_private.learner_mode(actor) <> p_mode
      or sarah_private.profile_fingerprint(actor) <> p_profile_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
    end if;
    if exists(select 1 from public.sarah_executions where student_id = actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.sarah_executions where student_id = actor and created_at > stamp - interval '60 seconds') >= 5
      or (select count(*) from public.sarah_executions where student_id = actor and created_at > stamp - interval '1 hour') >= 30 then
      denied := 'RATE_LIMITED';
    elsif p_max_calls <> 1 or p_max_output < 1 or p_max_output > 500 or p_max_cost < 1 or p_max_cost > 10000 then
      denied := 'OUT_OF_ENVELOPE';
    end if;
    stamp := clock_timestamp();
    insert into public.sarah_executions(id, student_id, idempotency_key, mode, intent, source_profile_sha256, state,
      reason_code, created_at, authorized_at, expires_at, terminal_at, max_provider_calls, max_output_tokens,
      max_estimated_cost_microusd)
    values (p_execution_id, actor, p_idempotency_key, p_mode, p_intent, p_profile_fingerprint,
      case when denied is null then 'AUTHORIZED' else 'BLOCKED' end, denied, stamp,
      case when denied is null then stamp else null end, stamp + interval '20 seconds',
      case when denied is null then null else stamp end, 1,
      case when denied is null then p_max_output else 1 end, case when denied is null then p_max_cost else 1 end);
    return sarah_private.execution_projection(p_execution_id, true);
  end if;

  select * into x from public.sarah_executions
  where id = p_execution_id and student_id = actor and idempotency_key = p_idempotency_key;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.mode <> p_mode or x.intent <> p_intent or x.source_profile_sha256 <> p_profile_fingerprint then
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
    -- Final pre-provider authority check (independent review, Correction
    -- 9), under the learner lock taken above: the database-owned mode and
    -- confirmed-profile version must still be the ones AUTHORIZE admitted.
    -- Otherwise the execution is closed FAILED/POLICY_BLOCKED (never left
    -- RUNNING) and no provider call is admitted.
    if sarah_private.learner_mode(actor) <> x.mode
      or sarah_private.profile_fingerprint(actor) <> x.source_profile_sha256 then
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
-- 7. Proposal creation: the controller records the structured proposal of
--    one SUCCEEDED SUPPORT_PROFILE execution, after FINALIZE was confirmed.
-- ==========================================================================
--   DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1
--   SARAH_PROFILE_PROPOSAL_V1
--   COUNSELLOR
--   key_id / actor / execution_id
--   sha256_hex(proposal material: STUDY_GOAL / WEEKLY_HOURS /
--     PREFERRED_CONTACT lines, "+value" when proposed, "-" when not)
--   issued_at_epoch_seconds / expires_at_epoch_seconds
create function public.record_sarah_profile_proposal(
  p_key_id uuid, p_execution_id uuid, p_study_goal text, p_weekly_hours integer, p_preferred_contact text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; x public.sarah_executions%rowtype; prior public.sarah_support_profile_proposals%rowtype;
  current_profile public.student_support_profiles%rowtype; profile_exists boolean; material text; fingerprint text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_key_id is null or p_execution_id is null
    or (p_study_goal is null and p_weekly_hours is null and p_preferred_contact is null)
    or (p_study_goal is not null and (length(p_study_goal) not between 1 and 300 or p_study_goal !~ '\S'
      or p_study_goal <> btrim(p_study_goal) or p_study_goal ~ '[[:cntrl:]]'))
    or (p_weekly_hours is not null and p_weekly_hours not between 0 and 80)
    or (p_preferred_contact is not null and p_preferred_contact not in ('ACADEMY','EMAIL')) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  material := concat_ws(E'\n',
    case when p_study_goal is null then 'STUDY_GOAL:-' else 'STUDY_GOAL:+' || p_study_goal end,
    case when p_weekly_hours is null then 'WEEKLY_HOURS:-' else 'WEEKLY_HOURS:+' || p_weekly_hours::text end,
    case when p_preferred_contact is null then 'PREFERRED_CONTACT:-' else 'PREFERRED_CONTACT:+' || p_preferred_contact end);
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1', 'SARAH_PROFILE_PROPOSAL_V1', 'COUNSELLOR',
      p_key_id::text, actor::text, p_execution_id::text,
      encode(extensions.digest(convert_to(material, 'UTF8'), 'sha256'), 'hex'),
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;

  select * into x from public.sarah_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'SUCCEEDED' or x.reason_code is distinct from 'PROVIDER_COMPLETE' or x.intent <> 'SUPPORT_PROFILE'
    or x.terminal_at < clock_timestamp() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_NOT_ELIGIBLE');
  end if;
  -- Idempotency: one proposal per source execution; identical values replay.
  select * into prior from public.sarah_support_profile_proposals where source_execution_id = x.id;
  if found then
    if prior.proposed_study_goal is distinct from p_study_goal or prior.proposed_weekly_hours is distinct from p_weekly_hours
      or prior.proposed_preferred_contact is distinct from p_preferred_contact then
      return jsonb_build_object('ok', false, 'code', 'SOURCE_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select * into current_profile from public.student_support_profiles where student_id = actor for update;
  profile_exists := found;
  fingerprint := sarah_private.profile_fingerprint(actor);
  if fingerprint <> x.source_profile_sha256 then
    return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL');
  end if;
  -- NO_CHANGE only against a CONFIRMED profile row (independent review,
  -- Blocker 4). Without a row nothing is confirmed yet, so every proposed
  -- field is a real proposal, even one equal to a table default.
  if profile_exists
    and (p_study_goal is null or p_study_goal = current_profile.study_goal)
    and (p_weekly_hours is null or p_weekly_hours = current_profile.weekly_hours)
    and (p_preferred_contact is null or p_preferred_contact = current_profile.preferred_contact) then
    return jsonb_build_object('ok', false, 'code', 'NO_CHANGE');
  end if;
  -- Pending proposals made against an older profile version can never
  -- apply; close them as STALE so they do not hold a pending slot.
  update public.sarah_support_profile_proposals set state = 'STALE'
  where student_id = actor and state = 'PENDING' and source_profile_sha256 <> fingerprint;
  if (select count(*) from public.sarah_support_profile_proposals where student_id = actor and state = 'PENDING') >= 3 then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_LIMIT_REACHED');
  end if;
  insert into public.sarah_support_profile_proposals(student_id, source_execution_id, proposed_study_goal,
    proposed_weekly_hours, proposed_preferred_contact, source_profile_sha256)
  values (actor, x.id, p_study_goal, p_weekly_hours, p_preferred_contact, x.source_profile_sha256);
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- ==========================================================================
-- 8. Learner-safe proposal read: the confirmed profile and the learner's
--    pending (at most 3) and 5 most recent decided proposals. No execution,
--    fingerprint or audit field.
-- ==========================================================================
create function public.list_my_sarah_profile_proposals() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; fingerprint text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if not exists(select 1 from public.student_profiles where user_id = actor) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  fingerprint := sarah_private.profile_fingerprint(actor);
  return jsonb_build_object('ok', true, 'current', sarah_private.profile_view(actor),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'state', q.state,
        'stale', q.state = 'PENDING' and q.source_profile_sha256 <> fingerprint,
        'createdAt', q.created_at, 'decidedAt', q.decided_at, 'studyGoal', q.proposed_study_goal,
        'weeklyHours', q.proposed_weekly_hours, 'preferredContact', q.proposed_preferred_contact)
        order by q.state <> 'PENDING', q.created_at desc, q.id)
      from (
        (select * from public.sarah_support_profile_proposals where student_id = actor and state = 'PENDING'
          order by created_at desc, id limit 3)
        union all
        (select * from public.sarah_support_profile_proposals where student_id = actor and state <> 'PENDING'
          order by decided_at desc, id limit 5)
      ) q), '[]'::jsonb));
end $$;

-- ==========================================================================
-- 9. Learner decision: CONFIRM applies exactly the proposed fields to the
--    confirmed profile, once, only if the profile has not changed since
--    Sarah saw it. DECLINE closes it. Only the owning STUDENT can decide:
--    not Sarah, not the model, not staff.
-- ==========================================================================
create function public.decide_sarah_profile_proposal(p_proposal_id uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; q public.sarah_support_profile_proposals%rowtype; target text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_proposal_id is null or p_decision is null or p_decision not in ('CONFIRM','DECLINE') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  target := case when p_decision = 'CONFIRM' then 'CONFIRMED' else 'DECLINED' end;
  -- Lock order: learner profile, then the proposal, then the support profile.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into q from public.sarah_support_profile_proposals where id = p_proposal_id and student_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if q.state = target then return jsonb_build_object('ok', true, 'state', target, 'duplicate', true); end if;
  if q.state = 'STALE' and p_decision = 'CONFIRM' then return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL'); end if;
  if q.state <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'PROPOSAL_DECIDED'); end if;
  if p_decision = 'DECLINE' then
    update public.sarah_support_profile_proposals set state = 'DECLINED' where id = q.id;
    return jsonb_build_object('ok', true, 'state', 'DECLINED', 'duplicate', false);
  end if;
  perform 1 from public.student_support_profiles where student_id = actor for update;
  if sarah_private.profile_fingerprint(actor) <> q.source_profile_sha256 then
    update public.sarah_support_profile_proposals set state = 'STALE' where id = q.id;
    return jsonb_build_object('ok', false, 'code', 'STALE_PROPOSAL');
  end if;
  perform set_config('app.audit_reason', 'Learner confirmed a Sarah Mitchell support-profile proposal', true);
  insert into public.student_support_profiles(student_id, study_goal, weekly_hours, preferred_contact, updated_at)
  values (actor, coalesce(q.proposed_study_goal, ''), coalesce(q.proposed_weekly_hours, 0),
    coalesce(q.proposed_preferred_contact, 'ACADEMY'), clock_timestamp())
  on conflict (student_id) do update set
    study_goal = coalesce(q.proposed_study_goal, public.student_support_profiles.study_goal),
    weekly_hours = coalesce(q.proposed_weekly_hours, public.student_support_profiles.weekly_hours),
    preferred_contact = coalesce(q.proposed_preferred_contact, public.student_support_profiles.preferred_contact),
    updated_at = clock_timestamp();
  update public.sarah_support_profile_proposals set state = 'CONFIRMED' where id = q.id;
  return jsonb_build_object('ok', true, 'state', 'CONFIRMED', 'duplicate', false);
end $$;

-- ==========================================================================
-- 10. Identity compatibility repair (independent review, Blocker 3).
--     Earlier local/acceptance seeds created a FICTIONAL demo human
--     COUNSELLOR staff user named "Sarah Mitchell". Sarah Mitchell is now
--     only the AI persona, so that one known fixture is renamed, exactly as
--     the current seed.sql names it. The guard is exact: the fixed demo id,
--     is_demo, the old display name and a COUNSELLOR grant must all hold.
--     A real account, another "Sarah Mitchell", any other COUNSELLOR and the
--     AI persona (which has no row) are never touched; with the fixture
--     absent this is a no-op.
-- ==========================================================================
update public.app_users u
set display_name = 'Jamie Carter'
where u.id = '10000000-0000-4000-8000-000000000002'::uuid
  and u.is_demo = true
  and u.display_name = 'Sarah Mitchell'
  and exists(select 1 from public.role_grants r where r.user_id = u.id and r.role = 'COUNSELLOR');

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'sarah_private'
       or (n.nspname = 'public' and p.proname in ('get_my_sarah_context','reserve_sarah_interaction',
         'govern_sarah_execution','record_sarah_profile_proposal','list_my_sarah_profile_proposals',
         'decide_sarah_profile_proposal')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.get_my_sarah_context() to authenticated;
grant execute on function public.reserve_sarah_interaction(uuid,text,text) to authenticated;
grant execute on function public.govern_sarah_execution(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,
  integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text) to authenticated;
grant execute on function public.record_sarah_profile_proposal(uuid,uuid,text,integer,text,bigint,bigint,text) to authenticated;
grant execute on function public.list_my_sarah_profile_proposals() to authenticated;
grant execute on function public.decide_sarah_profile_proposal(uuid,text) to authenticated;

do $$
declare r text; f record; t text;
  public_fns text[] := array['get_my_sarah_context','reserve_sarah_interaction','govern_sarah_execution',
    'record_sarah_profile_proposal','list_my_sarah_profile_proposals','decide_sarah_profile_proposal'];
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
    end loop;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'sarah_private' or (n.nspname = 'public' and p.proname = any(public_fns)) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.nspname = 'public') then
        raise exception 'Unsafe Sarah function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
