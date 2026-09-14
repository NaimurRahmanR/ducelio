-- Commercial V1: assessment policy + one-sitting controlled assessment
-- lifecycle. Additive over the existing Phase 2 controlled-assessment
-- foundation (migration 016, hardened by migration 020) and the Commercial
-- V1 course-activation provenance system (migration 027). Migrations
-- 001-028 are byte-for-byte unchanged.
--
-- Scope (deliberately narrow -- see docs/23-commercial-v1-assessment-policy.md):
--   1. explicit QUIZ_1/QUIZ_2/MIDTERM/QUIZ_3/QUIZ_4/FINAL component identity,
--      bound post-activation through a governed admin RPC (never inferred
--      from title/template-key/position/package content);
--   2. deterministic WITH_LABS/NO_LABS grading-profile derivation and
--      immutable basis-point weight persistence, entirely server-derived --
--      the caller never chooses the profile or supplies weights;
--   3. latest-start-at / full-duration one-sitting attempt timing for
--      assessments governed by a published Commercial V1 grading policy,
--      replacing the legacy least(closes_at, started_at+duration) shortening
--      behaviour for THOSE assessments only -- historical/non-Commercial-V1
--      assessments keep their exact existing timing behaviour;
--   4. truthful STUDENT_SUBMIT / AUTO_TIMEOUT / ADMIN_CLOSED provenance,
--      applied universally (a strict, backward-compatible truthfulness
--      improvement, never a widening of authority);
--   5. a deterministic self-scoped Commercial V1 lazy finalizer and a
--      private generic primitive preserving the shared start workflow.
--
-- Explicitly NOT implemented here: provider-backed Examiner execution, AI
-- grading, finalized numeric institutional results, numeric lab grading,
-- assessment-derived mastery, remediation, course completion, leaderboard
-- snapshots/ranking/UI. EXAMINER remains non-executing; ROLES_WITH_REVIEWED_
-- EXECUTION_PATH is untouched by this checkpoint.

create schema commercial_v1_private;
revoke all on schema commercial_v1_private from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 1: truthful submission provenance on the existing attempt table.
-- Existing submitted history cannot reveal how submission occurred. Classify it
-- once as LEGACY_UNCLASSIFIED without changing any identity, timing or state.
-- The migration-016 history guard rejects even metadata updates on terminal
-- rows. Suspend only that trigger in one atomic block; its original function
-- remains unchanged, the audit trigger remains enabled, and the table lock is
-- retained until restoration/commit. Any failure rolls the whole block back.
alter table public.assessment_attempts
  add column submission_provenance text;
do $$ begin
  alter table public.assessment_attempts disable trigger guard_assessment_attempt_history;
  update public.assessment_attempts
    set submission_provenance='LEGACY_UNCLASSIFIED'
    where state='SUBMITTED' and submission_provenance is null;
  alter table public.assessment_attempts enable trigger guard_assessment_attempt_history;
end $$;
alter table public.assessment_attempts
  add constraint submission_provenance_values
  check(submission_provenance is null or submission_provenance in ('STUDENT_SUBMIT','AUTO_TIMEOUT','ADMIN_CLOSED','LEGACY_UNCLASSIFIED'));
alter table public.assessment_attempts
  add constraint submission_provenance_truthful
  check((state='SUBMITTED')=(submission_provenance is not null));

-- ==========================================================================
-- Section 2: explicit Commercial V1 formal-component identity and the
-- immutable grading policy. Option B from the checkpoint brief: explicit
-- post-activation binding through a governed admin RPC, never inferred from
-- package/template content -- preserves COURSE_PACKAGE_V1 exactly as-is, no
-- schema-version bump.
-- ==========================================================================
create table public.commercial_v1_component_bindings (
  id uuid not null default gen_random_uuid() unique,
  activation_id uuid not null references public.course_activations(id),
  component text not null check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  assessment_id uuid not null references public.course_assessment_bindings(assessment_id),
  bound_by uuid not null references public.app_users(id),
  bound_at timestamptz not null default clock_timestamp(),
  primary key(activation_id,component),
  unique(activation_id,assessment_id)
);
create index commercial_v1_component_bindings_assessment
  on public.commercial_v1_component_bindings(assessment_id);

-- Mutable (rebindable) only until a grading policy is published for the
-- owning activation; immutable identity (activation_id, component) always;
-- never deletable. Mirrors the DRAFT-vs-PUBLISHED freeze pattern migration
-- 016 already uses for assessment_questions/assessment_answer_keys.
create function commercial_v1_private.guard_component_binding() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Commercial V1 component bindings cannot be deleted';
  end if;
  if NEW.activation_id<>OLD.activation_id or NEW.component<>OLD.component then
    raise exception 'Commercial V1 component binding identity is immutable';
  end if;
  if exists(select 1 from public.commercial_v1_grading_policies where activation_id=OLD.activation_id) then
    raise exception 'Commercial V1 component bindings are immutable once the grading policy is published';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.guard_component_binding() from public;

create table public.commercial_v1_grading_policies (
  activation_id uuid primary key references public.course_activations(id),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  policy_version text not null default 'COMMERCIAL_V1_GRADING_V1' check(policy_version='COMMERCIAL_V1_GRADING_V1'),
  resolved_profile text not null check(resolved_profile in ('WITH_LABS','NO_LABS')),
  quiz_1_weight_bp integer not null check(quiz_1_weight_bp=500),
  quiz_2_weight_bp integer not null check(quiz_2_weight_bp=500),
  midterm_weight_bp integer not null check(midterm_weight_bp=2000),
  quiz_3_weight_bp integer not null check(quiz_3_weight_bp=500),
  quiz_4_weight_bp integer not null check(quiz_4_weight_bp=500),
  labs_weight_bp integer not null check(labs_weight_bp in (0,2000)),
  final_weight_bp integer not null check(final_weight_bp in (4000,6000)),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp(),
  check(
    (resolved_profile='WITH_LABS' and labs_weight_bp=2000 and final_weight_bp=4000)
    or
    (resolved_profile='NO_LABS' and labs_weight_bp=0 and final_weight_bp=6000)
  ),
  check(
    quiz_1_weight_bp+quiz_2_weight_bp+midterm_weight_bp+quiz_3_weight_bp+quiz_4_weight_bp+labs_weight_bp+final_weight_bp=10000
  )
);

-- Now that both tables exist, attach the binding guard (it references
-- commercial_v1_grading_policies).
create trigger guard_component_binding
before update or delete on public.commercial_v1_component_bindings
for each row execute function commercial_v1_private.guard_component_binding();

-- Published institutional history: never updatable, never deletable. Once
-- published, later course/package changes can never retroactively alter the
-- persisted profile or weights -- later checkpoints must read this row, not
-- recompute from current activation state.
create function commercial_v1_private.immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Commercial V1 grading policy is immutable institutional history'; end $$;
revoke all on function commercial_v1_private.immutable() from public;
create trigger grading_policy_immutable
before update or delete on public.commercial_v1_grading_policies
for each row execute function commercial_v1_private.immutable();

-- Content-minimised audit trail for component binding, mirroring
-- audit_assessment_change (migration 016)/audit_course_activation pattern.
create function commercial_v1_private.audit_binding_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,before_state,after_state)
  values(
    public.current_app_user(),TG_OP,'commercial_v1_component_bindings',NEW.id,'COMMERCIAL_V1_GRADING_V1',
    coalesce(nullif(current_setting('app.audit_reason',true),''),'Commercial V1 component binding'),
    case when TG_OP='UPDATE' then jsonb_build_object('activation_id',OLD.activation_id,'component',OLD.component,'assessment_id',OLD.assessment_id) else null end,
    jsonb_build_object('activation_id',NEW.activation_id,'component',NEW.component,'assessment_id',NEW.assessment_id)
  );
  return NEW;
end $$;
revoke all on function commercial_v1_private.audit_binding_change() from public;
create trigger audit_binding_change
after insert or update on public.commercial_v1_component_bindings
for each row execute function commercial_v1_private.audit_binding_change();

-- ==========================================================================
-- Section 3: governed RPCs. Only ACADEMIC_ADMIN/PLATFORM_ADMIN (reused from
-- course_activation_private.require_admin, already reviewed in migration
-- 027) may bind components or publish the policy. Neither RPC accepts a
-- weight, profile, or lab-presence parameter from the caller -- there is no
-- such parameter to supply.
-- ==========================================================================
create function public.bind_commercial_v1_assessment_component(
  p_activation_id uuid,
  p_component text,
  p_assessment_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  activation public.course_activations%rowtype;
  asm public.assessments%rowtype;
  existing public.commercial_v1_component_bindings%rowtype;
  result_id uuid;
begin
  actor := course_activation_private.require_admin();
  if p_component not in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL') then
    raise exception 'INVALID_COMPONENT';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded binding reason is required';
  end if;

  select * into activation from public.course_activations where id=p_activation_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  if exists(select 1 from public.commercial_v1_grading_policies where activation_id=p_activation_id) then
    raise exception 'POLICY_ALREADY_PUBLISHED';
  end if;

  -- The assessment must be a real assessment materialised through the
  -- existing activation/provenance system for THIS exact activation. Since
  -- every course_assessment_bindings row for one activation_id shares the
  -- same cohort_id/programme_version_id by construction (activate_course_
  -- package inserts them together), this single check structurally proves
  -- same-activation, same-cohort and same-programme-version simultaneously.
  if not exists(
    select 1 from public.course_assessment_bindings cab
    where cab.assessment_id=p_assessment_id and cab.activation_id=p_activation_id
  ) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN';
  end if;

  select * into asm from public.assessments where id=p_assessment_id;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if asm.attempts_allowed<>1 then raise exception 'INVALID_ATTEMPTS_ALLOWED'; end if;

  -- app.audit_reason is set BEFORE this lookup, never between it and the
  -- `if found` check below: PERFORM re-sets PL/pgSQL's FOUND based on its
  -- own query, so a perform sandwiched in between would silently clobber
  -- the SELECT INTO's real found/not-found result.
  perform set_config('app.audit_reason',trim(p_reason),true);
  select * into existing
  from public.commercial_v1_component_bindings
  where activation_id=p_activation_id and component=p_component
  for update;

  if found then
    if existing.assessment_id=p_assessment_id then return existing.id; end if;
    update public.commercial_v1_component_bindings
    set assessment_id=p_assessment_id,bound_by=actor,bound_at=clock_timestamp()
    where activation_id=p_activation_id and component=p_component;
    return existing.id;
  end if;

  insert into public.commercial_v1_component_bindings(activation_id,component,assessment_id,bound_by)
  values(p_activation_id,p_component,p_assessment_id,actor)
  returning id into result_id;
  return result_id;
end $$;
revoke all on function public.bind_commercial_v1_assessment_component(uuid,text,uuid,text) from public;
grant execute on function public.bind_commercial_v1_assessment_component(uuid,text,uuid,text) to authenticated;

create function public.publish_commercial_v1_grading_policy(
  p_activation_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  activation public.course_activations%rowtype;
  existing public.commercial_v1_grading_policies%rowtype;
  binding_count integer;
  sequence_order text[] := array['QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL'];
  comp text;
  idx integer;
  bind public.commercial_v1_component_bindings%rowtype;
  asm public.assessments%rowtype;
  prev_closes timestamptz;
  has_labs boolean;
  labs_bp integer;
  final_bp integer;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded grading-policy reason is required';
  end if;

  select * into activation from public.course_activations where id=p_activation_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  -- Idempotent replay: publish takes no weight/profile parameter at all, so
  -- there is no way for a replay to carry a different institutional meaning
  -- once the six bindings are themselves frozen by the first publish (see
  -- guard_component_binding). A second call simply returns the same,
  -- already-immutable policy.
  select * into existing from public.commercial_v1_grading_policies where activation_id=p_activation_id;
  if found then return existing.activation_id; end if;

  select count(*) into binding_count
  from public.commercial_v1_component_bindings
  where activation_id=p_activation_id;
  if binding_count<>6 then raise exception 'INCOMPLETE_COMPONENT_BINDINGS'; end if;

  -- Share the assessment-row serialization used by start_assessment_attempt.
  -- Acquire all six in a stable order before checking history or publishing.
  perform a.id from public.assessments a
  join public.commercial_v1_component_bindings b on b.assessment_id=a.id
  where b.activation_id=p_activation_id order by a.id for update of a;
  if exists(
    select 1 from public.assessment_attempts t
    join public.commercial_v1_component_bindings b on b.assessment_id=t.assessment_id
    where b.activation_id=p_activation_id
  ) then raise exception 'ASSESSMENT_HISTORY_ALREADY_EXISTS'; end if;

  prev_closes := null;
  for idx in 1..6 loop
    comp := sequence_order[idx];
    select * into bind
    from public.commercial_v1_component_bindings
    where activation_id=p_activation_id and component=comp;
    if not found then raise exception 'MISSING_COMPONENT: %', comp; end if;

    if not exists(
      select 1 from public.course_assessment_bindings cab
      where cab.assessment_id=bind.assessment_id and cab.activation_id=p_activation_id
    ) then raise exception 'FOREIGN_ASSESSMENT_BINDING'; end if;

    select * into asm from public.assessments where id=bind.assessment_id;
    if not found then raise exception 'ASSESSMENT_NOT_FOUND'; end if;
    if asm.cohort_id<>activation.cohort_id or asm.programme_version_id<>activation.programme_version_id then
      raise exception 'CROSS_SCOPE_ASSESSMENT';
    end if;
    if asm.status<>'PUBLISHED' then raise exception 'ASSESSMENT_NOT_PUBLISHED'; end if;
    if asm.attempts_allowed<>1 then raise exception 'INVALID_ATTEMPTS_ALLOWED'; end if;
    if asm.closes_at-asm.opens_at < make_interval(mins=>asm.duration_minutes) then
      raise exception 'ASSESSMENT_WINDOW_TOO_SHORT';
    end if;

    -- Fixed institutional sequence order (never sorted by actual time): a
    -- component whose real window occurs out of order relative to the
    -- PREVIOUS formal component in QUIZ_1..FINAL order fails closed here,
    -- which also structurally forbids any overlap between adjacent formal
    -- windows in that order.
    if prev_closes is not null and asm.opens_at<prev_closes then
      raise exception 'ASSESSMENT_SEQUENCE_INVALID: % after %', comp, sequence_order[idx-1];
    end if;
    prev_closes := asm.closes_at;
  end loop;

  -- Lab presence is derived exclusively from the practicals actually
  -- materialised for this activation's own import/programme-version
  -- (course_practicals, populated only by activate_course_package) -- never
  -- from title, metadata, or caller input.
  has_labs := exists(
    select 1 from public.course_practicals p
    where p.import_id=activation.import_id
      and p.programme_version_id=activation.programme_version_id
      and p.kind='PRACTICAL_LAB'
  );
  if has_labs then labs_bp:=2000; final_bp:=4000; else labs_bp:=0; final_bp:=6000; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_grading_policies(
    activation_id,cohort_id,programme_version_id,resolved_profile,
    quiz_1_weight_bp,quiz_2_weight_bp,midterm_weight_bp,quiz_3_weight_bp,quiz_4_weight_bp,labs_weight_bp,final_weight_bp,
    published_by
  ) values (
    p_activation_id,activation.cohort_id,activation.programme_version_id,
    case when has_labs then 'WITH_LABS' else 'NO_LABS' end,
    500,500,2000,500,500,labs_bp,final_bp,actor
  );

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(
    actor,'COMMERCIAL_V1_GRADING_POLICY_PUBLISHED','commercial_v1_grading_policies',p_activation_id,'COMMERCIAL_V1_GRADING_V1',
    trim(p_reason),
    jsonb_build_object(
      'activation_id',p_activation_id,
      'resolved_profile',case when has_labs then 'WITH_LABS' else 'NO_LABS' end,
      'labs_weight_bp',labs_bp,'final_weight_bp',final_bp
    )
  );

  return p_activation_id;
end $$;
revoke all on function public.publish_commercial_v1_grading_policy(uuid,text) from public;
grant execute on function public.publish_commercial_v1_grading_policy(uuid,text) to authenticated;

-- ==========================================================================
-- Section 4: one-sitting attempt timing. CREATE OR REPLACE over the exact
-- signatures migration 016/020 already defined -- no new parallel attempt-
-- lifecycle surface. Every assessment continues through the SAME functions;
-- behaviour branches only on whether the assessment is bound as a formal
-- component under a PUBLISHED Commercial V1 grading policy. A non-governed
-- (historical or not-yet-governed) assessment keeps its EXACT existing
-- least(closes_at, started_at+duration) / opens_at..closes_at behaviour,
-- unchanged.
-- ==========================================================================

-- Returns the published policy governing this assessment, or an all-null
-- row if none exists (assessment not bound, or bound but not yet published).
create function commercial_v1_private.governing_policy(p_assessment_id uuid)
returns public.commercial_v1_grading_policies
language sql stable set search_path='' as $$
  select gp.*
  from public.commercial_v1_grading_policies gp
  join public.commercial_v1_component_bindings b on b.activation_id=gp.activation_id
  where b.assessment_id=p_assessment_id
  limit 1
$$;
revoke all on function commercial_v1_private.governing_policy(uuid) from public;

-- Private generic cleanup preserves the migration-020/021 start workflow.
-- Public Commercial V1 entry points pass p_commercial_only=true: they cannot
-- observe or mutate legacy attempts. Deadline expiry takes precedence when
-- already elapsed; otherwise administrative closure is truthfully ADMIN_CLOSED.
create function commercial_v1_private.finalize_expired_attempts_for_actor(
  p_actor uuid,p_stamp timestamptz,p_commercial_only boolean default false
) returns void
language plpgsql set search_path='' as $$
begin
  perform set_config('app.audit_reason','Expired or closed controlled assessment finalised',true);
  update public.assessment_attempts t
  set state='SUBMITTED',
      submitted_at=least(p_stamp,t.expires_at),
      submission_provenance=case when t.expires_at<=p_stamp then 'AUTO_TIMEOUT' else 'ADMIN_CLOSED' end
  from public.assessments a
  where t.assessment_id=a.id and t.student_id=p_actor and t.state='ACTIVE'
    and (t.expires_at<=p_stamp or a.status<>'PUBLISHED')
    and (not p_commercial_only or exists(
      select 1 from public.commercial_v1_component_bindings b
      join public.commercial_v1_grading_policies gp on gp.activation_id=b.activation_id
      where b.assessment_id=t.assessment_id
    ));
end $$;
revoke all on function commercial_v1_private.finalize_expired_attempts_for_actor(uuid,timestamptz,boolean) from public;

create or replace function public.start_assessment_attempt(p_assessment_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
  enrolment_record public.enrolments%rowtype;
  existing_id uuid;
  nonvoid_count integer;
  next_attempt integer;
  result_id uuid;
  expiry timestamptz;
  latest_start timestamptz;
  duration interval;
  governing public.commercial_v1_grading_policies;
  stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;

  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then raise exception 'Learner profile not found'; end if;

  -- Migration 021's Professor-content-release mutual-exclusion check,
  -- preserved EXACTLY (same position immediately after the learner lock,
  -- same exclusion condition, same error) -- CREATE OR REPLACE here must
  -- never silently drop an invariant a later migration already added on
  -- top of migration 016/020's original body. This checkpoint's own
  -- static regression test (tests/academic-content-release.test.ts) reads
  -- the LIVE function definition back from the database and fails loudly
  -- if this check is ever missing or reordered again.
  perform public.expire_my_academic_content_releases();
  if exists(select 1 from public.academic_content_releases
    where student_id=actor and state='ACTIVE' and expires_at>clock_timestamp()) then
    raise exception 'Academic activity is busy. Retry shortly.' using errcode='42501';
  end if;

  -- One authoritative timestamp for this whole operation: every gate below
  -- (opens/latest-start/closes) and both persisted timestamps (started_at,
  -- expires_at) are derived from this single instant, so boundary behaviour
  -- is deterministic rather than depending on how many clock_timestamp()/
  -- now() calls happen to elapse across the transaction.
  stamp := clock_timestamp();

  -- Commercial V1 correction: the exact same stale-ACTIVE-attempt
  -- finalisation migration 020/021 performed inline here (now provenanced
  -- and shared -- see commercial_v1_private.finalize_expired_attempts_for_actor).
  perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, stamp);

  select * into assessment_record from public.assessments where id = p_assessment_id for share;
  if not found then raise exception 'Assessment not found'; end if;
  if assessment_record.status <> 'PUBLISHED' then raise exception 'Assessment is not available'; end if;

  governing := commercial_v1_private.governing_policy(p_assessment_id);
  duration := (assessment_record.duration_minutes || ' minutes')::interval;

  select * into enrolment_record
  from public.enrolments
  where student_id = actor
    and cohort_id = assessment_record.cohort_id
    and programme_version_id = assessment_record.programme_version_id
  for update;
  if not found then raise exception 'Matching learner enrolment not found'; end if;
  if enrolment_record.status <> 'ACTIVE' then
    raise exception 'Only an active enrolment can start a controlled assessment';
  end if;

  -- One-sitting replay safety: returning to an already-active attempt for
  -- THIS assessment resumes the same institutional attempt untouched
  -- (identical started_at/expires_at/attempt_number); it is never reset,
  -- extended, or duplicated by a repeated start action.
  select id into existing_id
  from public.assessment_attempts
  where student_id = actor and state = 'ACTIVE'
  for update;
  if found then
    if exists(
      select 1 from public.assessment_attempts
      where id = existing_id and assessment_id = p_assessment_id
    ) then
      return existing_id;
    end if;
    raise exception 'Another controlled assessment attempt is already active';
  end if;

  -- Availability limits govern only a FIRST start. A valid active attempt
  -- above resumes under its own immutable expiry, even after latest_start_at.
  if governing.activation_id is not null then
    -- Commercial V1: a full-duration, one-sitting attempt. The learner may
    -- start any time up to and including latest_start_at = closes_at -
    -- duration; once started, expires_at = started_at + the FULL configured
    -- duration, never shortened by an approaching closes_at.
    latest_start := assessment_record.closes_at - duration;
    if stamp < assessment_record.opens_at then raise exception 'Assessment has not opened yet'; end if;
    if stamp > latest_start then raise exception 'Assessment window has closed'; end if;
  else
    if stamp < assessment_record.opens_at then raise exception 'Assessment has not opened yet'; end if;
    if stamp > assessment_record.closes_at then raise exception 'Assessment window has closed'; end if;
  end if;

  select
    count(*) filter(where state <> 'VOIDED')::integer,
    coalesce(max(attempt_number), 0) + 1
  into nonvoid_count, next_attempt
  from public.assessment_attempts
  where assessment_id = p_assessment_id
    and enrolment_id = enrolment_record.id;

  if nonvoid_count >= assessment_record.attempts_allowed then
    raise exception 'No assessment attempts remain';
  end if;

  if governing.activation_id is not null then
    expiry := stamp + duration;
  else
    expiry := least(assessment_record.closes_at, stamp + duration);
  end if;

  perform set_config('app.audit_reason', 'Learner started controlled assessment', true);
  insert into public.assessment_attempts(
    assessment_id, enrolment_id, student_id, cohort_id, programme_version_id,
    attempt_number, state, started_at, expires_at
  ) values (
    p_assessment_id, enrolment_record.id, actor, assessment_record.cohort_id,
    assessment_record.programme_version_id, next_attempt, 'ACTIVE',
    stamp, expiry
  ) returning id into result_id;

  return result_id;
end $$;
revoke all on function public.start_assessment_attempt(uuid) from public;
grant execute on function public.start_assessment_attempt(uuid) to authenticated;

create or replace function public.record_assessment_response(
  p_attempt_id uuid,
  p_question_id uuid,
  p_body text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
  assessment_record public.assessments%rowtype;
  governing public.commercial_v1_grading_policies;
  existing public.assessment_responses%rowtype;
  next_revision integer;
  result_id uuid;
  stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  if p_body is null or length(trim(p_body)) not between 1 and 20000 then raise exception 'A bounded assessment response is required'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then raise exception 'A bounded idempotency key is required'; end if;

  stamp := clock_timestamp();
  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found then raise exception 'Assessment attempt not found'; end if;
  if attempt_record.student_id<>actor then raise exception 'Access denied' using errcode='42501'; end if;

  -- Independent review correction: a Commercial V1-governed attempt must
  -- NEVER be reachable through this legacy RPC. Its expired-response path
  -- cannot satisfy the frozen contract (durably finalizing AUTO_TIMEOUT in
  -- the SAME governed operation that refuses the write) using a raised
  -- exception, since PostgreSQL rolls back an entire statement's effects
  -- -- including any UPDATE already performed inside this same call --
  -- when that same function subsequently raises. The dedicated
  -- record_commercial_v1_assessment_response RPC below solves this with a
  -- non-raising, deterministic jsonb result instead. This exclusion check
  -- is the other half of that fix: it makes the legacy RPC structurally
  -- unusable as a bypass around the governed one, for every state (not
  -- only the expiry case) -- a learner cannot dodge Commercial V1's
  -- deadline/finalization semantics by calling the older generic RPC.
  governing := commercial_v1_private.governing_policy(attempt_record.assessment_id);
  if governing.activation_id is not null then
    raise exception 'Commercial V1 governed attempts must use record_commercial_v1_assessment_response';
  end if;

  -- Non-governed (historical/not-yet-governed) assessments keep this exact
  -- pre-existing behaviour, with one small global tightening: the deadline
  -- check below uses `>=`, not the original `>`, closing the exact-
  -- boundary gap where a write landing in the very same instant as
  -- expires_at could otherwise be accepted.
  if attempt_record.state<>'ACTIVE' then raise exception 'Assessment attempt is no longer active'; end if;
  if stamp>=attempt_record.expires_at then raise exception 'Assessment attempt has expired'; end if;

  select * into assessment_record from public.assessments where id=attempt_record.assessment_id for share;
  stamp := clock_timestamp();
  if stamp>=attempt_record.expires_at then raise exception 'Assessment attempt has expired'; end if;
  if assessment_record.status<>'PUBLISHED' or stamp>assessment_record.closes_at then raise exception 'Assessment response window has closed'; end if;
  if not exists(select 1 from public.assessment_questions where id=p_question_id and assessment_id=attempt_record.assessment_id) then raise exception 'Question does not belong to this assessment attempt'; end if;

  select * into existing from public.assessment_responses where idempotency_key=trim(p_idempotency_key);
  if found then
    if existing.attempt_id=p_attempt_id and existing.question_id=p_question_id and existing.student_id=actor and existing.body=trim(p_body) then return existing.id; end if;
    raise exception 'Idempotency key is already bound to a different assessment response';
  end if;

  select coalesce(max(revision_number),0)+1 into next_revision
  from public.assessment_responses
  where attempt_id=p_attempt_id and question_id=p_question_id;

  perform set_config('app.audit_reason','Learner saved controlled assessment response',true);
  insert into public.assessment_responses(
    attempt_id,question_id,assessment_id,student_id,revision_number,body,idempotency_key,recorded_at
  ) values (
    p_attempt_id,p_question_id,attempt_record.assessment_id,actor,next_revision,trim(p_body),trim(p_idempotency_key),stamp
  ) returning id into result_id;
  return result_id;
end $$;
revoke all on function public.record_assessment_response(uuid,uuid,text,text) from public;
grant execute on function public.record_assessment_response(uuid,uuid,text,text) to authenticated;

-- Dedicated Commercial V1 response surface. Same append-only, idempotent,
-- ownership-proven, protected-content-free semantics as the legacy RPC
-- above, but returns a deterministic jsonb result rather than raising for
-- the EXPIRED case specifically -- so an expired-response request can, in
-- ONE governed operation: refuse the mutation (never inserts a row, never
-- returns a fabricated response id) AND durably commit the attempt's
-- transition to AUTO_TIMEOUT, anchored to its own expires_at, without a
-- raised exception ever rolling that transition back. Usable ONLY for
-- attempts governed by a published Commercial V1 policy -- the symmetric
-- opposite of record_assessment_response's own exclusion above -- so
-- neither RPC can be used to bypass the other's semantics.
create function public.record_commercial_v1_assessment_response(
  p_attempt_id uuid,
  p_question_id uuid,
  p_body text,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
  assessment_record public.assessments%rowtype;
  governing public.commercial_v1_grading_policies;
  existing public.assessment_responses%rowtype;
  next_revision integer;
  result_id uuid;
  stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  if p_body is null or length(trim(p_body)) not between 1 and 20000 then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  stamp := clock_timestamp();
  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found or attempt_record.student_id<>actor then
    -- Identical bounded outcome for "does not exist" and "belongs to
    -- someone else" -- a caller cannot distinguish the two.
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;

  governing := commercial_v1_private.governing_policy(attempt_record.assessment_id);
  if governing.activation_id is null then
    return jsonb_build_object('ok',false,'code','NOT_COMMERCIAL_V1_GOVERNED');
  end if;

  -- The critical governed transition (independent review requirement): if
  -- the deadline has already passed (at or after expires_at), durably
  -- finalize the attempt AUTO_TIMEOUT in THIS SAME statement/transaction --
  -- via a plain RETURN, never a RAISE, so the finalizer's own UPDATE
  -- commits together with this refusal rather than being rolled back by
  -- it. submitted_at remains anchored to the attempt's own expires_at (set
  -- by the finalizer itself, never to "now"). Idempotent: a repeat call
  -- against an already-terminal AUTO_TIMEOUT attempt falls through to the
  -- state<>'ACTIVE' branch below and returns the identical EXPIRED result
  -- without attempting the transition again or creating any further
  -- history.
  if attempt_record.state='ACTIVE' and stamp>=attempt_record.expires_at then
    perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, stamp, true);
    select * into attempt_record from public.assessment_attempts where id=p_attempt_id;
    return jsonb_build_object(
      'ok',false,'code','EXPIRED',
      'state',attempt_record.state,
      'submittedAt',attempt_record.submitted_at,
      'submissionProvenance',attempt_record.submission_provenance
    );
  end if;

  if attempt_record.state<>'ACTIVE' then
    if attempt_record.submission_provenance='AUTO_TIMEOUT' then
      return jsonb_build_object(
        'ok',false,'code','EXPIRED',
        'state',attempt_record.state,
        'submittedAt',attempt_record.submitted_at,
        'submissionProvenance',attempt_record.submission_provenance
      );
    end if;
    return jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  end if;

  select * into assessment_record from public.assessments where id=attempt_record.assessment_id for share;
  stamp := clock_timestamp();
  if assessment_record.status<>'PUBLISHED' or stamp>=attempt_record.expires_at then
    perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, stamp, true);
    select * into attempt_record from public.assessment_attempts where id=p_attempt_id;
    if attempt_record.submission_provenance='AUTO_TIMEOUT' then
      return jsonb_build_object('ok',false,'code','EXPIRED','state','SUBMITTED',
        'submittedAt',attempt_record.submitted_at,'submissionProvenance','AUTO_TIMEOUT');
    end if;
    return jsonb_build_object('ok',false,'code','RESPONSE_WINDOW_CLOSED');
  end if;
  if stamp>assessment_record.closes_at then
    return jsonb_build_object('ok',false,'code','RESPONSE_WINDOW_CLOSED');
  end if;
  if not exists(select 1 from public.assessment_questions where id=p_question_id and assessment_id=attempt_record.assessment_id) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  select * into existing from public.assessment_responses where idempotency_key=trim(p_idempotency_key);
  if found then
    if existing.attempt_id=p_attempt_id and existing.question_id=p_question_id and existing.student_id=actor and existing.body=trim(p_body) then
      return jsonb_build_object('ok',true,'responseId',existing.id);
    end if;
    return jsonb_build_object('ok',false,'code','IDEMPOTENCY_CONFLICT');
  end if;

  select coalesce(max(revision_number),0)+1 into next_revision
  from public.assessment_responses
  where attempt_id=p_attempt_id and question_id=p_question_id;

  perform set_config('app.audit_reason','Learner saved controlled assessment response',true);
  insert into public.assessment_responses(
    attempt_id,question_id,assessment_id,student_id,revision_number,body,idempotency_key,recorded_at
  ) values (
    p_attempt_id,p_question_id,attempt_record.assessment_id,actor,next_revision,trim(p_body),trim(p_idempotency_key),stamp
  ) returning id into result_id;
  return jsonb_build_object('ok',true,'responseId',result_id);
end $$;
revoke all on function public.record_commercial_v1_assessment_response(uuid,uuid,text,text) from public;
grant execute on function public.record_commercial_v1_assessment_response(uuid,uuid,text,text) to authenticated;

create or replace function public.submit_assessment_attempt(p_attempt_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
  stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  stamp := clock_timestamp();
  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found then raise exception 'Assessment attempt not found'; end if;
  if attempt_record.student_id<>actor then raise exception 'Access denied' using errcode='42501'; end if;
  if attempt_record.state='SUBMITTED' then return p_attempt_id; end if;
  if attempt_record.state<>'ACTIVE' then raise exception 'Assessment attempt cannot be submitted'; end if;

  -- Lock the parent status before deciding learner submission provenance.
  perform 1 from public.assessments where id=attempt_record.assessment_id for share;
  stamp := clock_timestamp();
  perform set_config('app.audit_reason','Controlled assessment submission finalised',true);
  if stamp>=attempt_record.expires_at then
    -- A late click cannot masquerade as an on-time student submission: the
    -- deadline had already passed, so this resolves truthfully as
    -- AUTO_TIMEOUT, anchored to the attempt's own expires_at.
    update public.assessment_attempts
    set state='SUBMITTED',submitted_at=expires_at,submission_provenance='AUTO_TIMEOUT'
    where id=p_attempt_id;
  elsif exists(select 1 from public.assessments where id=attempt_record.assessment_id and status<>'PUBLISHED') then
    update public.assessment_attempts
    set state='SUBMITTED',submitted_at=stamp,submission_provenance='ADMIN_CLOSED'
    where id=p_attempt_id;
  else
    update public.assessment_attempts
    set state='SUBMITTED',submitted_at=stamp,submission_provenance='STUDENT_SUBMIT'
    where id=p_attempt_id;
  end if;
  return p_attempt_id;
end $$;
revoke all on function public.submit_assessment_attempt(uuid) from public;
grant execute on function public.submit_assessment_attempt(uuid) to authenticated;

-- STUDENT self-scoped Commercial V1 cleanup only: both binding and published
-- policy are required. Generic cleanup remains private and is used by the
-- shared start workflow. No bulk/service-role/scheduler path is introduced.
create function public.finalize_expired_commercial_v1_attempts() returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, clock_timestamp(), true);
end $$;
revoke all on function public.finalize_expired_commercial_v1_attempts() from public;
grant execute on function public.finalize_expired_commercial_v1_attempts() to authenticated;

-- Safe resume DTO: bounded fields only, never protected question/answer
-- content (that remains behind get_active_assessment_questions, untouched).
-- Derives entirely from database state; lazily finalizes first so a stale
-- expired attempt is never reported as resumable.
create function public.get_commercial_v1_active_attempt() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; att public.assessment_attempts%rowtype; asm public.assessments%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, clock_timestamp(), true);
  select t.* into att from public.assessment_attempts t
  where t.student_id=actor and t.state='ACTIVE' and exists(
    select 1 from public.commercial_v1_component_bindings b
    join public.commercial_v1_grading_policies gp on gp.activation_id=b.activation_id
    where b.assessment_id=t.assessment_id
  );
  if not found then return null; end if;
  select * into asm from public.assessments where id=att.assessment_id;
  return jsonb_build_object(
    'attemptId',att.id,'assessmentId',att.assessment_id,'attemptNumber',att.attempt_number,
    'title',asm.title,'startedAt',att.started_at,'expiresAt',att.expires_at
  );
end $$;
revoke all on function public.get_commercial_v1_active_attempt() from public;
grant execute on function public.get_commercial_v1_active_attempt() to authenticated;

-- ==========================================================================
-- Section 5: RLS/ACL hardening for the two new tables and this migration's
-- functions, mirroring migration 027/028's own effective-ACL assertion
-- pattern exactly. No direct table access is ever granted; every read/write
-- goes through the governed RPCs above.
-- ==========================================================================
do $$ declare t regclass; cols text; f regprocedure; r text; begin
 for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
  'commercial_v1_component_bindings','commercial_v1_grading_policies') loop
  execute format('alter table %s enable row level security',t);
  execute format('revoke all on %s from public,anon,authenticated,service_role',t);
  select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid=t and attnum>0 and not attisdropped;
  execute format('revoke select(%s),insert(%s),update(%s),references(%s) on %s from public,anon,authenticated,service_role',cols,cols,cols,cols,t);
  foreach r in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  end loop;
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_private' or (n.nspname='public' and p.proname in ('bind_commercial_v1_assessment_component','publish_commercial_v1_grading_policy','finalize_expired_commercial_v1_attempts','get_commercial_v1_active_attempt','record_commercial_v1_assessment_response')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like 'bind_commercial_v1_assessment_component(%' or f::text like 'publish_commercial_v1_grading_policy(%' or f::text like 'finalize_expired_commercial_v1_attempts(%' or f::text like 'get_commercial_v1_active_attempt(%' or f::text like 'record_commercial_v1_assessment_response(%' then execute format('grant execute on function %s to authenticated',f); end if;
 end loop;
 foreach r in array array['anon','authenticated','service_role'] loop
  if has_schema_privilege(r,'commercial_v1_private','USAGE,CREATE') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_private' and has_function_privilege(r,p.oid,'EXECUTE')) then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('bind_commercial_v1_assessment_component','publish_commercial_v1_grading_policy','finalize_expired_commercial_v1_attempts','get_commercial_v1_active_attempt','record_commercial_v1_assessment_response') loop
   if has_function_privilege(r,f,'EXECUTE') is distinct from (r='authenticated') then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  end loop;
 end loop;
end $$;

-- Effective ACL acceptance: separately executable deployment check, mirroring
-- migration 027's own second pass.
do $$ declare r text; t regclass; f record; begin
 foreach r in array array['anon','authenticated','service_role'] loop
  for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
   'commercial_v1_component_bindings','commercial_v1_grading_policies') loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  end loop;
  if has_schema_privilege(r,'commercial_v1_private','USAGE,CREATE') then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  for f in select p.oid,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_private' or (n.nspname='public' and p.proname in ('bind_commercial_v1_assessment_component','publish_commercial_v1_grading_policy','finalize_expired_commercial_v1_attempts','get_commercial_v1_active_attempt','record_commercial_v1_assessment_response')) loop
   if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then raise exception 'Unsafe commercial_v1 assessment-policy privileges'; end if;
  end loop;
 end loop;
end $$;
