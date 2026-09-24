-- Commercial V1 -- Examiner initial-grade failure recovery.
-- Forward-only from CLOSED GREEN PR25 (migration 039 already present). No
-- historical migration is modified.
--
-- Problem this closes: migration 031's commercial_v1_examiner_executions has
-- a partial unique index per attempt_id/submission_id, so an admitted
-- initial-grading claim occupies its target PERMANENTLY -- including a
-- terminal FAILED/TIMEOUT/BUDGET_BLOCKED/CANCELLED outcome that produced NO
-- result revision. Migration 032's regrade authority cannot recover this: it
-- resolves its source strictly from an EXISTING result revision
-- (commercial_v1_regrade_private.source), and there is none. Without this
-- migration, such a target is permanently stranded: not gradeable, not
-- regradeable, no institutional path to a result.
--
-- Design chosen (Option B from the checkpoint brief): a SEPARATE, dedicated
-- INITIAL_GRADE_RECOVERY authority, structurally distinct from both initial
-- grading and regrade, reusing exactly the shared reviewed primitives that
-- are semantically identical across all three (controller-key HMAC trust
-- root, atomic-finalizer/result-integrity helpers from migration 030,
-- grade-digest/mark-validation shape) while keeping each surface's own
-- identity, protocol tag and unique-claim semantics fully separate. Option A
-- (extending regrade) was rejected: regrade's source resolver, its
-- NOT_CURRENT_RESULT/CURRENT_RESULT_INVALID checks and its revision_number =
-- src.revision_number+1 insert all assume an EXISTING result to key off and
-- supersede -- overloading that function to sometimes mean "no result exists
-- yet" would blur two structurally different authorities (superseding a
-- judged grade vs. giving a never-graded target its legitimate first
-- attempt) behind one confusing code path, for no line-count benefit: the
-- claim table, HMAC protocol and AUTHORIZE eligibility logic all still need
-- to be new either way.
--
-- Eligibility policy (explicit, not inferred):
--   RECOVERABLE original terminal states:   FAILED (any reason, including
--     NO_PROVIDER_CONFIGURED -- an infra/config condition, not a
--     determination about the work), TIMEOUT, BUDGET_BLOCKED, CANCELLED.
--   NOT RECOVERABLE:                        ESCALATED (an explicit
--     institutional "this needs human academic review" determination --
--     either config-driven at AUTHORIZE, per migration 036's
--     escalationPolicy=ACADEMIC_REVIEW, or provider-driven via a genuine
--     {"outcome":"ESCALATE"} response -- re-running the SAME automated
--     Examiner path would not resolve that determination and would
--     circumvent it); AUTHORIZED/RUNNING (still active, not terminal);
--     SUCCEEDED (already has a result -- migration 032's regrade is the
--     correct authority for a dispute over an existing grade, not this one).
--
-- Recovery ceiling: EXACTLY ONE recovery claim is ever admitted per original
-- failed execution (a single-column unique index on source_execution_id,
-- mirroring the "one claim per target, ever" philosophy migration 031
-- already established for the original claim itself). If that one recovery
-- attempt ALSO terminates without a result, the target remains a known,
-- durably auditable stranded state (two terminal claims, still zero
-- results) requiring a separate, deliberately reviewed future institutional
-- mechanism -- never a second automatic recovery. This is a direct
-- extension of PR11B1's own "no automatic retry after terminal" philosophy,
-- documented there and preserved here.
--
-- Configuration governance: recovery reuses the EXACT SAME
-- academic_agent_configs EXAMINER row/capability check migration 036 added
-- to initial grading's own AUTHORIZE (same lock, same enabled/capability/
-- profile-ref resolution, same direct-ESCALATED-claim behaviour for
-- escalationPolicy=ACADEMIC_REVIEW) -- deliberately NOT regrade's
-- unconditional admin-override model. Recovery is "let the governed
-- automated Examiner pipeline have its one legitimate first attempt", not
-- "an admin manually overrides an existing judged grade"; an institution
-- that has disabled AI-assisted grading for a course, or not enabled
-- grade_controlled_assessment/grade_practical_lab, correctly blocks BOTH
-- initial grading and its recovery through the one governed toggle an admin
-- actually controls.
create schema commercial_v1_recovery_private;
revoke all on schema commercial_v1_recovery_private from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 1: the governed recovery claim record. actor_id is the initiating
-- ACADEMIC_ADMIN/PLATFORM_ADMIN (immutable; only that actor may continue
-- START/CONTEXT_READ/FINALIZE for the admitted claim, exactly mirroring
-- migration 032's own actor-scoped continuation). Every institutional
-- identity field (student/enrolment/activation/capability/target/attempt-or-
-- submission/component-or-practical) is copied from the ORIGINAL execution
-- row at AUTHORIZE time -- never re-derived independently -- so recovery can
-- never target anything other than the exact same work the original claim
-- already proved eligible.
-- ==========================================================================
create table public.commercial_v1_examiner_recovery_executions (
  id uuid primary key,
  actor_id uuid not null references public.app_users(id),
  source_execution_id uuid not null references public.commercial_v1_examiner_executions(id),
  recovery_reason text not null check(length(recovery_reason) between 1 and 300 and recovery_reason=btrim(recovery_reason)),
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid references public.enrolments(id),
  activation_id uuid references public.course_activations(id),
  capability text not null check(capability in ('grade_controlled_assessment','grade_practical_lab')),
  target_kind text not null check(target_kind in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')),
  attempt_id uuid references public.assessment_attempts(id),
  submission_id uuid references public.commercial_v1_lab_submissions(id),
  component text check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  practical_id uuid references public.course_practicals(id),
  policy_version text not null default 'COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1' check(policy_version='COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1'),
  execution_kind text not null default 'PROVIDER_BACKED_RECOVERY_V1' check(execution_kind='PROVIDER_BACKED_RECOVERY_V1'),
  -- The code-owned runtime/model profile this recovery execution was
  -- admitted under, resolved (never caller-supplied) from the SAME
  -- programme-version EXAMINER academic_agent_configs row migration 036
  -- reads for initial grading. EXAMINER's allowed ref is currently fixed to
  -- exactly this one literal (course_engineering_private.
  -- role_profile_allowed_ref('EXAMINER')) -- this CHECK is a reviewed-
  -- migration tripwire against that ever silently drifting, not a caller
  -- input.
  runtime_profile_ref text not null check(runtime_profile_ref='EXAMINER_COMMERCIAL_V1'),
  state text not null check(state in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED')),
  reason_code text,
  budget_stage text check(budget_stage in ('PRE_CALL','POST_CALL')),
  created_at timestamptz not null,
  authorized_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz not null,
  max_provider_calls integer not null check(max_provider_calls=1),
  max_output_tokens integer not null check(max_output_tokens between 1 and 1200),
  max_estimated_cost_microusd bigint not null check(max_estimated_cost_microusd between 1 and 50000),
  review_path text check(review_path='ACADEMIC_REVIEW'),
  grade_digest text check(grade_digest is null or grade_digest ~ '^[0-9a-f]{64}$'),
  result_revision_id uuid,
  check((target_kind='ASSESSMENT_ATTEMPT')=(attempt_id is not null)),
  check((target_kind='ASSESSMENT_ATTEMPT')=(component is not null)),
  check((target_kind='LAB_SUBMISSION')=(submission_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(practical_id is not null)),
  check((capability='grade_controlled_assessment')=(target_kind='ASSESSMENT_ATTEMPT')),
  check(expires_at>created_at and expires_at<=created_at+interval '20 seconds'),
  check(authorized_at is null or authorized_at=created_at),
  check(started_at is null or (started_at>=created_at and started_at<expires_at)),
  check(terminal_at is null or terminal_at>=coalesce(started_at,created_at)),
  check((state='SUCCEEDED')=(result_revision_id is not null)),
  check((state='SUCCEEDED')=(grade_digest is not null)),
  check(
    (state='AUTHORIZED' and enrolment_id is not null and activation_id is not null and authorized_at is not null
      and started_at is null and terminal_at is null and reason_code is null and budget_stage is null) or
    (state='RUNNING' and enrolment_id is not null and activation_id is not null and started_at is not null
      and terminal_at is null and reason_code is null and budget_stage is null) or
    (state='SUCCEEDED' and terminal_at is not null and reason_code='GRADED' and budget_stage is null) or
    (state='FAILED' and terminal_at is not null and budget_stage is null and reason_code in (
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
      'PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID','RESULT_INTEGRITY_FAILED',
      'EXECUTION_TIMEOUT','NO_PROVIDER_CONFIGURED')) or
    (state='ESCALATED' and terminal_at is not null and reason_code='HUMAN_REVIEW_REQUIRED' and budget_stage is null) or
    (state='BUDGET_BLOCKED' and terminal_at is not null and reason_code='BUDGET_BLOCKED' and budget_stage in ('PRE_CALL','POST_CALL')) or
    (state='TIMEOUT' and terminal_at is not null and reason_code='EXECUTION_TIMEOUT' and budget_stage is null) or
    (state='CANCELLED' and terminal_at is not null and reason_code='CANCELLED' and budget_stage is null)
  ),
  check((state='ESCALATED' and review_path is not null) or (state<>'ESCALATED' and review_path is null))
);
-- Exactly one recovery claim is EVER admitted per original failed execution
-- -- the structural "recovery ceiling" (see header comment). A single
-- column suffices: source_execution_id already uniquely identifies one
-- target, since migration 031's own partial unique indexes guarantee at
-- most one commercial_v1_examiner_executions row per attempt_id/submission_id.
create unique index examiner_recovery_one_per_source on public.commercial_v1_examiner_recovery_executions(source_execution_id);
create index examiner_recovery_admission on public.commercial_v1_examiner_recovery_executions(student_id,created_at);
create index examiner_recovery_active on public.commercial_v1_examiner_recovery_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.commercial_v1_examiner_recovery_executions enable row level security;
revoke all on public.commercial_v1_examiner_recovery_executions from public, anon, authenticated, service_role;

create table public.commercial_v1_examiner_recovery_usage (
  execution_id uuid primary key references public.commercial_v1_examiner_recovery_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 1),
  attempts integer not null check(attempts between 0 and 3),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.commercial_v1_examiner_recovery_usage enable row level security;
revoke all on public.commercial_v1_examiner_recovery_usage from public, anon, authenticated, service_role;

-- Immutable identity/terminal-history guard, transitions identical to
-- migrations 031/032's own execution guards.
create function commercial_v1_recovery_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Examiner recovery execution history cannot be deleted'; end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then raise exception 'Terminal Examiner recovery execution history is immutable'; end if;
  if row(NEW.id,NEW.actor_id,NEW.source_execution_id,NEW.recovery_reason,NEW.student_id,NEW.capability,NEW.target_kind,
    NEW.attempt_id,NEW.submission_id,NEW.component,NEW.practical_id,NEW.policy_version,NEW.execution_kind,NEW.runtime_profile_ref,
    NEW.created_at,NEW.authorized_at,NEW.expires_at,NEW.max_provider_calls,NEW.max_output_tokens,NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id,OLD.actor_id,OLD.source_execution_id,OLD.recovery_reason,OLD.student_id,OLD.capability,OLD.target_kind,
    OLD.attempt_id,OLD.submission_id,OLD.component,OLD.practical_id,OLD.policy_version,OLD.execution_kind,OLD.runtime_profile_ref,
    OLD.created_at,OLD.authorized_at,OLD.expires_at,OLD.max_provider_calls,OLD.max_output_tokens,OLD.max_estimated_cost_microusd) then
    raise exception 'Examiner recovery execution identity and budget are immutable';
  end if;
  if OLD.enrolment_id is not null and NEW.enrolment_id is distinct from OLD.enrolment_id then
    raise exception 'Examiner recovery execution identity and budget are immutable';
  end if;
  if OLD.activation_id is not null and NEW.activation_id is distinct from OLD.activation_id then
    raise exception 'Examiner recovery execution identity and budget are immutable';
  end if;
  if not ((OLD.state='AUTHORIZED' and NEW.state in ('RUNNING','FAILED','TIMEOUT')) or
    (OLD.state='RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED'))) then
    raise exception 'Invalid Examiner recovery execution transition';
  end if;
  if OLD.state='RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'Examiner recovery execution start is immutable';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_recovery_private.guard_execution() from public, anon, authenticated, service_role;
create trigger guard_examiner_recovery_execution before update or delete on public.commercial_v1_examiner_recovery_executions
for each row execute function commercial_v1_recovery_private.guard_execution();

-- Append-only usage ledger: the shared guard already used by migration
-- 032's own recovery-adjacent (regrade) usage table is schema/table-
-- agnostic (it unconditionally refuses every UPDATE/DELETE), so it is
-- reused directly rather than redefining an identical function.
create trigger guard_examiner_recovery_usage before update or delete on public.commercial_v1_examiner_recovery_usage
for each row execute function commercial_v1_examiner_private.guard_execution_usage();

-- Content-minimised audit: identifiers/state/usage/digest/profile/source
-- only. recovery_reason deliberately never enters this generic audit JSON,
-- mirroring migration 032's own exclusion of request_reason -- it lives
-- only on the protected execution row.
create function commercial_v1_recovery_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.commercial_v1_examiner_recovery_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.actor_id,'COMMERCIAL_V1_EXAMINER_RECOVERY_'||NEW.state,'commercial_v1_examiner_recovery_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Commercial V1 Examiner initial-grade recovery execution lifecycle',
    jsonb_build_object(
      'actor_id',NEW.actor_id,'source_execution_id',NEW.source_execution_id,'execution_id',NEW.id,
      'student_id',NEW.student_id,'enrolment_id',NEW.enrolment_id,'activation_id',NEW.activation_id,
      'capability',NEW.capability,'target_kind',NEW.target_kind,'attempt_id',NEW.attempt_id,
      'submission_id',NEW.submission_id,'component',NEW.component,'practical_id',NEW.practical_id,
      'runtime_profile_ref',NEW.runtime_profile_ref,'state',NEW.state,'reason_code',NEW.reason_code,
      'budget_stage',NEW.budget_stage,'grade_digest',NEW.grade_digest,'result_revision_id',NEW.result_revision_id,
      'usage',usage_snapshot),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function commercial_v1_recovery_private.audit_execution() from public, anon, authenticated, service_role;
create trigger audit_examiner_recovery_execution after insert or update on public.commercial_v1_examiner_recovery_executions
for each row execute function commercial_v1_recovery_private.audit_execution();

create function commercial_v1_recovery_private.execution_projection(p_id uuid,p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'transitioned',p_changed,'execution',jsonb_build_object(
    'actorId',e.actor_id,'sourceExecutionId',e.source_execution_id,'executionId',e.id,'studentId',e.student_id,
    'enrolmentId',e.enrolment_id,'activationId',e.activation_id,
    'capability',e.capability,'targetKind',e.target_kind,'attemptId',e.attempt_id,'submissionId',e.submission_id,
    'component',e.component,'practicalId',e.practical_id,'policyVersion',e.policy_version,'executionKind',e.execution_kind,
    'runtimeProfileRef',e.runtime_profile_ref,
    'state',e.state,'reasonCode',e.reason_code,'budgetStage',e.budget_stage,'createdAt',e.created_at,
    'authorizedAt',e.authorized_at,'startedAt',e.started_at,'terminalAt',e.terminal_at,'expiresAt',e.expires_at,
    'reviewPath',e.review_path,'gradeDigest',e.grade_digest,'resultRevisionId',e.result_revision_id,
    'budget',jsonb_build_object('maxProviderCalls',e.max_provider_calls,'maxOutputTokens',e.max_output_tokens,
      'maxEstimatedCostMicrousd',e.max_estimated_cost_microusd),
    'usage',(select jsonb_build_object('providerCalls',u.provider_calls,'attempts',u.attempts,
      'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,
      'estimatedCostMicrousd',u.estimated_cost_microusd,'elapsedMs',u.elapsed_ms)
      from public.commercial_v1_examiner_recovery_usage u where u.execution_id=e.id)))
  from public.commercial_v1_examiner_recovery_executions e where e.id=p_id
$$;
revoke all on function commercial_v1_recovery_private.execution_projection(uuid,boolean) from public, anon, authenticated, service_role;

-- Resolves the ORIGINAL initial-grading execution's authoritative identity
-- and eligibility, never a result revision (there is none). p_target_kind
-- is part of the WHERE filter, not a post-hoc comparison: a caller-supplied
-- target-kind mismatch is therefore indistinguishable from a nonexistent
-- source_execution_id (matching the same convention every other cross-
-- learner/cross-target lookup in this codebase already uses), never its own
-- separate INVALID_INPUT code. is_eligible encodes the explicit
-- RECOVERABLE/NOT_RECOVERABLE policy from this migration's header comment;
-- is_result_free independently re-confirms no result revision exists for
-- the same target (defense in depth on top of the original claim's own
-- one-slot-per-target guarantee).
create function commercial_v1_recovery_private.original(p_source_execution_id uuid, p_target_kind text)
returns table(
  id uuid, student_id uuid, enrolment_id uuid, activation_id uuid, capability text, target_kind text,
  attempt_id uuid, submission_id uuid, component text, practical_id uuid, state text, reason_code text,
  is_eligible boolean, is_result_free boolean
)
language sql stable set search_path='' as $$
  select x.id,x.student_id,x.enrolment_id,x.activation_id,x.capability,x.target_kind,
    x.attempt_id,x.submission_id,x.component,x.practical_id,x.state,x.reason_code,
    x.state in ('FAILED','TIMEOUT','BUDGET_BLOCKED','CANCELLED'),
    case when x.target_kind='ASSESSMENT_ATTEMPT' then
      not exists(select 1 from public.commercial_v1_assessment_result_revisions r
        where r.enrolment_id=x.enrolment_id and r.component=x.component)
    else
      not exists(select 1 from public.commercial_v1_lab_result_revisions r
        where r.enrolment_id=x.enrolment_id and r.practical_id=x.practical_id)
    end
  from public.commercial_v1_examiner_executions x where x.id=p_source_execution_id and x.target_kind=p_target_kind
$$;
revoke all on function commercial_v1_recovery_private.original(uuid,text) from public, anon, authenticated, service_role;

-- HMAC verification. Distinct protocol/policy tags from both
-- DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1 (migration 031) and
-- DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1 (migration 032), so
-- an initial-grading or regrade attestation can never authorize a recovery
-- transition and vice versa, without needing a second key -- reuses the
-- exact same academic_execution_private.controller_keys trust root.
create function commercial_v1_recovery_private.verify_command(
  p_key_id uuid,p_execution_id uuid,p_source_execution_id uuid,p_recovery_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean
language plpgsql security definer set search_path='' as $$
declare stamp numeric:=extract(epoch from clock_timestamp()); key_bytes bytea; expected bytea; supplied bytea;
  canonical text; mismatch integer:=0;
begin
  if public.current_app_user() is null or p_key_id is null or p_execution_id is null or p_source_execution_id is null
    or p_recovery_reason is null or length(p_recovery_reason) not between 1 and 300 or p_recovery_reason<>btrim(p_recovery_reason)
    or p_capability is null or p_capability not in ('grade_controlled_assessment','grade_practical_lab')
    or p_target_kind is null or p_target_kind not in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')
    or (p_capability='grade_controlled_assessment')<>(p_target_kind='ASSESSMENT_ATTEMPT')
    or p_operation is null or p_operation not in ('AUTHORIZE','START','CONTEXT_READ','FINALIZE')
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','GRADED','PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED',
      'PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID',
      'NO_PROVIDER_CONFIGURED','HUMAN_REVIEW_REQUIRED','BUDGET_BLOCKED','EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls<>1 or p_max_output is null or p_max_output not between 1 and 1200
    or p_max_cost is null or p_max_cost not between 1 and 50000
    or p_calls is null or p_calls not between 0 and 1 or p_attempts is null or p_attempts not between 0 and 3
    or p_input is null or p_input not between 0 and 1000000 or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000 or p_elapsed is null or p_elapsed not between 0 and 60000
    or (p_grade_digest is not null and p_grade_digest !~ '^[0-9a-f]{64}$')
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical:=concat_ws(E'\n','DUCELIO_COMMERCIAL_V1_EXAMINER_RECOVERY_HMAC_SHA256_V1','COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1',
    'EXAMINER','EXAMINER_COMMERCIAL_V1',p_key_id::text,public.current_app_user()::text,p_execution_id::text,
    p_source_execution_id::text,encode(convert_to(p_recovery_reason,'UTF8'),'hex'),p_capability,p_target_kind,
    coalesce(p_student_id::text,'NONE'),coalesce(p_attempt_id::text,'NONE'),coalesce(p_submission_id::text,'NONE'),
    coalesce(p_enrolment_id::text,'NONE'),coalesce(p_activation_id::text,'NONE'),p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls::text,p_max_output::text,p_max_cost::text,p_calls::text,p_attempts::text,p_input::text,p_output::text,
    p_cost::text,p_elapsed::text,coalesce(p_grade_digest,'NONE'),p_issued_at::text,p_expires_at::text);
  expected:=extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256'); supplied:=decode(p_mac,'hex');
  for i in 0..31 loop mismatch:=mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function commercial_v1_recovery_private.verify_command(
  uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text
) from public, anon, authenticated, service_role;

-- ==========================================================================
-- The one governed command surface: AUTHORIZE / START / CONTEXT_READ /
-- FINALIZE, mirroring migration 032's shape and reusing migration 030's
-- atomic-finalizer machinery for the SUCCEEDED branch exactly as migrations
-- 031/032 both already do.
-- ==========================================================================
create function public.govern_commercial_v1_examiner_recovery(
  p_key_id uuid,p_execution_id uuid,p_source_execution_id uuid,p_recovery_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,p_assessment_marks jsonb,p_lab_marks_awarded integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=public.current_app_user(); stamp timestamptz; orig record; e public.enrolments%rowtype;
  execution_record public.commercial_v1_examiner_recovery_executions%rowtype;
  existing public.commercial_v1_examiner_recovery_executions%rowtype;
  agent_config public.academic_agent_configs%rowtype; resolved_profile_ref text;
  denied text; result_id uuid; computed_digest text; marks_text text; expected_weight integer; max_total integer;
  mark_elem jsonb; qid uuid; mark integer; qmax integer; answered_count integer; marks_count integer; q_row record; lp record;
  asm public.assessments%rowtype; sub public.commercial_v1_lab_submissions%rowtype; pr public.course_practicals%rowtype;
begin
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if not commercial_v1_recovery_private.verify_command(p_key_id,p_execution_id,p_source_execution_id,p_recovery_reason,p_capability,p_target_kind,
    p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION'); end if;
  select * into orig from commercial_v1_recovery_private.original(p_source_execution_id, p_target_kind);
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  -- Shared learner lock serializes admission accounting across enrolments,
  -- then the SAME enrolment row lock attempt_commercial_v1_course_completion
  -- and migrations 031/032 all use -- before every authoritative
  -- current/status observation or write.
  perform 1 from public.student_profiles where user_id=orig.student_id for update;
  select * into e from public.enrolments where id=orig.enrolment_id for update;
  if not commercial_v1_recovery_private.verify_command(p_key_id,p_execution_id,p_source_execution_id,p_recovery_reason,p_capability,p_target_kind,
    p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION'); end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  stamp:=clock_timestamp();
  update public.commercial_v1_examiner_recovery_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
    where student_id=orig.student_id and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;
  select * into orig from commercial_v1_recovery_private.original(p_source_execution_id, p_target_kind);

  if p_operation='AUTHORIZE' then
    -- orig was resolved by (source_execution_id, target_kind) together above,
    -- so a capability/target-kind mismatch already fell into the bounded
    -- NOT_FOUND_OR_FORBIDDEN branch before this point is ever reached.
    if p_student_id is not null or p_attempt_id is not null or p_submission_id is not null or p_enrolment_id is not null or p_activation_id is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    if p_state<>'AUTHORIZED' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    -- Exact-target replay-first (independent-review Blocker 2 pattern,
    -- migration 031): a prior claim for this exact original execution --
    -- terminal or active -- must always be observed on its own terms,
    -- before any eligibility/rate-limit check below could otherwise discard
    -- it (e.g. wrongly reporting a SUCCEEDED recovery as ALREADY_GRADED
    -- merely because the target now has a result).
    select * into existing from public.commercial_v1_examiner_recovery_executions where source_execution_id=p_source_execution_id;
    if found then
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      return commercial_v1_recovery_private.execution_projection(existing.id,false);
    end if;

    -- Only reached when NO recovery claim has ever existed for this
    -- original execution: eligibility, rate limits and config governance
    -- now apply.
    if not orig.is_eligible then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
    if not orig.is_result_free then return jsonb_build_object('ok',false,'code','ALREADY_GRADED'); end if;
    if e.status<>'ACTIVE' or e.student_id<>orig.student_id then
      return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
    if exists(select 1 from public.commercial_v1_examiner_recovery_executions where student_id=orig.student_id and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.commercial_v1_examiner_recovery_executions where student_id=orig.student_id and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.commercial_v1_examiner_recovery_executions where student_id=orig.student_id and created_at>stamp-interval '1 hour')>=30 then
      return jsonb_build_object('ok',false,'code','RATE_LIMITED'); end if;
    if p_max_calls<>1 or p_max_output<1 or p_max_output>1200 or p_max_cost<1 or p_max_cost>50000 then
      return jsonb_build_object('ok',false,'code','OUT_OF_ENVELOPE'); end if;

    -- Configuration governance: the SAME programme-version EXAMINER
    -- academic_agent_configs row and lock migration 036 uses for initial
    -- grading's own AUTHORIZE (see header comment).
    perform 1 from public.programme_versions where id=e.programme_version_id for share;
    select * into agent_config from public.academic_agent_configs
      where programme_version_id=e.programme_version_id and role='EXAMINER';
    if not found or not agent_config.enabled then
      return jsonb_build_object('ok',false,'code','POLICY_BLOCKED'); end if;
    if not (p_capability = any(agent_config.capabilities)) then
      return jsonb_build_object('ok',false,'code','POLICY_BLOCKED'); end if;
    resolved_profile_ref := course_engineering_private.resolve_role_profile_ref('EXAMINER', agent_config.model_profile_ref);
    if resolved_profile_ref is null then
      return jsonb_build_object('ok',false,'code','UNKNOWN_MODEL_PROFILE'); end if;

    if agent_config.escalation_policy = 'ACADEMIC_REVIEW' then
      insert into public.commercial_v1_examiner_recovery_executions(
        id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,capability,target_kind,
        attempt_id,submission_id,component,practical_id,runtime_profile_ref,state,reason_code,terminal_at,review_path,
        created_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) values (
        p_execution_id,actor,p_source_execution_id,p_recovery_reason,orig.student_id,orig.enrolment_id,orig.activation_id,
        orig.capability,orig.target_kind,orig.attempt_id,orig.submission_id,orig.component,orig.practical_id,
        resolved_profile_ref,'ESCALATED','HUMAN_REVIEW_REQUIRED',stamp,'ACADEMIC_REVIEW',
        stamp,stamp+interval '20 seconds',p_max_calls,p_max_output,p_max_cost
      ) on conflict (source_execution_id) do nothing;
    else
      insert into public.commercial_v1_examiner_recovery_executions(
        id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,capability,target_kind,
        attempt_id,submission_id,component,practical_id,runtime_profile_ref,
        state,created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) values (
        p_execution_id,actor,p_source_execution_id,p_recovery_reason,orig.student_id,orig.enrolment_id,orig.activation_id,
        orig.capability,orig.target_kind,orig.attempt_id,orig.submission_id,orig.component,orig.practical_id,
        resolved_profile_ref,
        'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',p_max_calls,p_max_output,p_max_cost
      ) on conflict (source_execution_id) do nothing;
    end if;
    if not found then
      -- Concurrency backstop: a genuinely concurrent AUTHORIZE for this same
      -- original execution won the insert race between the pre-check above
      -- and here.
      select * into existing from public.commercial_v1_examiner_recovery_executions where source_execution_id=p_source_execution_id;
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      return commercial_v1_recovery_private.execution_projection(existing.id,false);
    end if;
    return commercial_v1_recovery_private.execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.commercial_v1_examiner_recovery_executions where id=p_execution_id and actor_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if row(execution_record.source_execution_id,execution_record.recovery_reason,execution_record.capability,execution_record.target_kind,
    execution_record.student_id,execution_record.attempt_id,execution_record.submission_id,execution_record.enrolment_id,execution_record.activation_id,
    execution_record.max_provider_calls,execution_record.max_output_tokens,execution_record.max_estimated_cost_microusd)
    is distinct from row(p_source_execution_id,p_recovery_reason,p_capability,p_target_kind,p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_max_calls,p_max_output,p_max_cost) then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT'); end if;
  -- Unconditional, exactly mirroring migration 032: an execution that is
  -- ALREADY terminal (not AUTHORIZED/RUNNING) is refused here outright, with
  -- no cleanup exception -- the zero-usage INTERNAL_ERROR cleanup below is
  -- reachable only from AUTHORIZED (an uncertain pre-START transport
  -- failure), which trivially passes this check since 'AUTHORIZED' is
  -- itself in ('AUTHORIZED','RUNNING'). Letting an already-terminal row
  -- reach the FINALIZE branch would only ever hit guard_execution()'s own
  -- immutable-history trigger as a raw exception instead of this clean,
  -- structured denial.
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    return jsonb_build_object('ok',false,'code',
      case when execution_record.state='TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end); end if;

  -- A late eligibility change (enrolment no longer ACTIVE, or -- structurally
  -- unexpected but checked for defense-in-depth -- a result now exists) is
  -- denied for every op except a zero-progress FAILED/INTERNAL_ERROR cleanup,
  -- which may still durably record truthful (usually zero) observed usage.
  if e.status<>'ACTIVE' or e.student_id<>orig.student_id then denied:='TARGET_NOT_ELIGIBLE';
  elsif not orig.is_result_free then denied:='ALREADY_GRADED'; end if;
  if denied is not null and not (p_operation='FINALIZE' and p_state<>'SUCCEEDED') then
    return jsonb_build_object('ok',false,'code',denied); end if;

  if p_operation='START' then
    if p_state<>'RUNNING' or execution_record.state<>'AUTHORIZED' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.commercial_v1_examiner_recovery_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return commercial_v1_recovery_private.execution_projection(p_execution_id,true);
  end if;
  if execution_record.state<>'RUNNING' and not (p_operation='FINALIZE' and p_state='FAILED' and p_reason='INTERNAL_ERROR'
    and p_calls=0 and p_attempts=0 and p_input=0 and p_output=0 and p_cost=0 and p_elapsed=0) then
    return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;

  if p_operation='CONTEXT_READ' then
    if p_state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    -- Own inline protected-content read, keyed to THIS recovery execution's
    -- RUNNING state -- never migration 031's context RPCs, whose CONTEXT_READ
    -- attestation is bound to the (permanently terminal) original execution
    -- id and can never be RUNNING again. Same authoritative
    -- questions/answer-keys/latest-response (assessment) or
    -- practical/policy/submission/objectives (lab) shape as migrations
    -- 031/032 -- never the original failure reason, previous marks, or this
    -- recovery's own reason.
    if p_target_kind='ASSESSMENT_ATTEMPT' then
      select * into asm from public.assessments where id=(select assessment_id from public.assessment_attempts where id=execution_record.attempt_id);
      return jsonb_build_object('ok',true,'attemptId',execution_record.attempt_id,'assessmentId',asm.id,'component',execution_record.component,
        'title',asm.title,'instructions',asm.instructions,
        'questions',(
          select coalesce(jsonb_agg(jsonb_build_object(
            'questionId',q.id,'position',q.position,'prompt',q.prompt,'maxMarks',q.max_marks,
            'expectedAnswer',ak.expected_answer,'markingGuidance',ak.marking_guidance,
            'responseBody',r.body
          ) order by q.position),'[]'::jsonb)
          from public.assessment_questions q
          join public.assessment_answer_keys ak on ak.question_id=q.id
          join lateral (
            select body from public.assessment_responses
            where attempt_id=execution_record.attempt_id and question_id=q.id
            order by revision_number desc limit 1
          ) r on true
          where q.assessment_id=asm.id
        ));
    else
      select * into sub from public.commercial_v1_lab_submissions where id=execution_record.submission_id;
      select * into pr from public.course_practicals where id=execution_record.practical_id;
      select * into lp from public.commercial_v1_lab_policies where activation_id=execution_record.activation_id and practical_id=execution_record.practical_id;
      return jsonb_build_object('ok',true,'submissionId',execution_record.submission_id,'practicalId',execution_record.practical_id,
        'title',pr.title,'instructions',pr.instructions,'maxMarks',lp.max_marks,'gradingGuidance',lp.grading_guidance,
        'submissionBody',sub.body,
        'objectives',(
          select coalesce(jsonb_agg(jsonb_build_object('objectiveId',lo.id,'description',lo.description) order by lo.position),'[]'::jsonb)
          from public.course_practical_objectives po
          join public.lesson_objectives lo on lo.id=po.objective_id
          where po.practical_id=execution_record.practical_id
        ));
    end if;
  end if;

  -- FINALIZE input-shape validation, identical family to migrations 031/032.
  if not (
    (p_state='SUCCEEDED' and p_reason='GRADED' and p_budget_stage='NONE' and p_grade_digest is not null) or
    (p_state='FAILED' and p_budget_stage='NONE' and p_grade_digest is null and p_reason in (
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
      'PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID','EXECUTION_TIMEOUT','NO_PROVIDER_CONFIGURED')) or
    (p_state='ESCALATED' and p_reason='HUMAN_REVIEW_REQUIRED' and p_budget_stage='NONE' and p_grade_digest is null) or
    (p_state='BUDGET_BLOCKED' and p_reason='BUDGET_BLOCKED' and p_budget_stage in ('PRE_CALL','POST_CALL') and p_grade_digest is null) or
    (p_state='CANCELLED' and p_reason='CANCELLED' and p_budget_stage='NONE' and p_grade_digest is null)
  ) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_calls>execution_record.max_provider_calls then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_state='SUCCEEDED' and (p_output>execution_record.max_output_tokens or p_cost>execution_record.max_estimated_cost_microusd) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  insert into public.commercial_v1_examiner_recovery_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);

  if p_state='SUCCEEDED' then
    -- CRITICAL SUCCESS RULE, identical shape to migrations 031/032: the same
    -- enrolment row lock is already held above (acquired before this whole
    -- function's first authoritative observation, not re-acquired here).
    -- revision_number is hard-coded to 1 -- never src.revision_number+1 like
    -- regrade -- because by construction (is_result_free re-checked just
    -- above, and guard_assessment_result_insert's own revision-1-uniqueness
    -- CHECK as a database-owned backstop) no revision can already exist.
    denied := null;
    begin
      if execution_record.target_kind='ASSESSMENT_ATTEMPT' then
        select string_agg(format('%s:%s',(x->>'questionId'),(x->>'marksAwarded')),';' order by (x->>'questionId'))
          into marks_text from jsonb_array_elements(coalesce(p_assessment_marks,'[]'::jsonb)) x;
        computed_digest := encode(extensions.digest(convert_to(coalesce(marks_text,''),'UTF8'),'sha256'),'hex');
        if computed_digest is distinct from p_grade_digest then raise exception 'GRADE_DIGEST_MISMATCH'; end if;
        if p_assessment_marks is null or jsonb_typeof(p_assessment_marks)<>'array' then raise exception 'INVALID_GRADE_PAYLOAD'; end if;
        if (select count(*) from jsonb_array_elements(p_assessment_marks)) <>
           (select count(distinct (x->>'questionId')) from jsonb_array_elements(p_assessment_marks) x) then
          raise exception 'DUPLICATE_QUESTION_ID';
        end if;
        for mark_elem in select * from jsonb_array_elements(p_assessment_marks) loop
          if (select count(*) from jsonb_object_keys(mark_elem))<>2 or not(mark_elem ? 'questionId') or not(mark_elem ? 'marksAwarded')
            or jsonb_typeof(mark_elem->'questionId')<>'string' or jsonb_typeof(mark_elem->'marksAwarded')<>'number'
            or (mark_elem->>'marksAwarded') !~ '^\d+$' then
            raise exception 'INVALID_GRADE_PAYLOAD';
          end if;
          qid := (mark_elem->>'questionId')::uuid;
          mark := (mark_elem->>'marksAwarded')::integer;
          select q.max_marks into qmax from public.assessment_questions q
            join public.assessment_attempts a on a.assessment_id=q.assessment_id
            where q.id=qid and a.id=execution_record.attempt_id;
          if not found then raise exception 'FOREIGN_QUESTION'; end if;
          if mark>qmax then raise exception 'MARKS_EXCEED_MAX'; end if;
          if not exists(select 1 from public.assessment_responses where attempt_id=execution_record.attempt_id and question_id=qid) then
            raise exception 'UNANSWERED_QUESTION_GRADED';
          end if;
        end loop;
        select count(distinct question_id) into answered_count from public.assessment_responses where attempt_id=execution_record.attempt_id;
        select count(*) into marks_count from jsonb_array_elements(p_assessment_marks);
        if marks_count<>answered_count then raise exception 'ANSWERED_QUESTION_SET_MISMATCH'; end if;

        expected_weight := commercial_v1_private.expected_component_weight(execution_record.activation_id,execution_record.component);
        select sum(q.max_marks)::integer into max_total from public.assessment_questions q
          join public.assessment_attempts a on a.assessment_id=q.assessment_id where a.id=execution_record.attempt_id;

        insert into public.commercial_v1_assessment_result_revisions(
          activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
          earned_marks_total,max_marks_total,component_weight_bp
        ) values (
          execution_record.activation_id,execution_record.enrolment_id,execution_record.student_id,execution_record.component,
          execution_record.attempt_id,(select assessment_id from public.assessment_attempts where id=execution_record.attempt_id),1,
          (select coalesce(sum((x->>'marksAwarded')::integer),0) from jsonb_array_elements(p_assessment_marks) x),
          max_total,expected_weight
        ) returning id into result_id;

        for q_row in
          select q.id as qid,q.max_marks as qmax,
            coalesce((select (x->>'marksAwarded')::integer from jsonb_array_elements(p_assessment_marks) x where (x->>'questionId')::uuid=q.id),0) as awarded
          from public.assessment_questions q
          join public.assessment_attempts a on a.assessment_id=q.assessment_id where a.id=execution_record.attempt_id
        loop
          insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot)
          values(result_id,q_row.qid,q_row.awarded,q_row.qmax);
        end loop;

        perform commercial_v1_private.derive_and_insert_objective_outcomes(result_id);
        if not commercial_v1_private.assessment_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;
      else
        computed_digest := encode(extensions.digest(convert_to('marksAwarded:'||coalesce(p_lab_marks_awarded::text,'NULL'),'UTF8'),'sha256'),'hex');
        if computed_digest is distinct from p_grade_digest then raise exception 'GRADE_DIGEST_MISMATCH'; end if;
        if p_lab_marks_awarded is null or p_lab_marks_awarded<0 then raise exception 'INVALID_GRADE_PAYLOAD'; end if;
        select * into lp
          from public.commercial_v1_lab_policies where activation_id=execution_record.activation_id and practical_id=execution_record.practical_id;
        if not found then raise exception 'LAB_POLICY_MISSING'; end if;
        if p_lab_marks_awarded>lp.max_marks then raise exception 'MARKS_EXCEED_MAX'; end if;

        insert into public.commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values (
          execution_record.activation_id,execution_record.enrolment_id,execution_record.student_id,execution_record.practical_id,
          execution_record.submission_id,1,p_lab_marks_awarded,lp.max_marks,lp.contribution_bp
        ) returning id into result_id;

        perform commercial_v1_private.derive_and_insert_lab_objective_outcomes(result_id);
        if not commercial_v1_private.lab_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;
      end if;
      update public.commercial_v1_examiner_recovery_executions
      set state='SUCCEEDED',reason_code='GRADED',terminal_at=stamp,result_revision_id=result_id,grade_digest=p_grade_digest
      where id=p_execution_id;
    exception when others then
      denied := 'RESULT_INTEGRITY_FAILED';
    end;
    if denied is not null then
      update public.commercial_v1_examiner_recovery_executions
      set state='FAILED',reason_code=denied,terminal_at=stamp where id=p_execution_id;
    end if;
  else
    update public.commercial_v1_examiner_recovery_executions
    set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
      review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
    where id=p_execution_id;
  end if;
  return commercial_v1_recovery_private.execution_projection(p_execution_id,true);
end $$;
revoke all on function public.govern_commercial_v1_examiner_recovery(
  uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) from public, anon, authenticated, service_role;
grant execute on function public.govern_commercial_v1_examiner_recovery(
  uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) to authenticated;

-- ==========================================================================
-- ACL hardening: explicit table/column/schema/function revokes PLUS the
-- deployment-time assertion pattern (raises on any unsafe effective
-- privilege, including inherited service_role BYPASSRLS defaults) --
-- migration 031's stronger pattern, not migration 032's revoke-only one,
-- since neither may ever be weakened and 031's is the strictly more
-- rigorous of the two already in this codebase.
-- ==========================================================================
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.commercial_v1_examiner_recovery_executions'::regclass,'public.commercial_v1_examiner_recovery_usage'::regclass
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
      'public.commercial_v1_examiner_recovery_executions'::regclass,'public.commercial_v1_examiner_recovery_usage'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective Examiner recovery table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r,'commercial_v1_recovery_private','USAGE,CREATE') then
      raise exception 'Unsafe effective Examiner recovery schema privileges for %', r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commercial_v1_recovery_private'
         or (n.nspname='public' and p.proname='govern_commercial_v1_examiner_recovery') loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname='govern_commercial_v1_examiner_recovery') then
        raise exception 'Unsafe effective Examiner recovery function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
