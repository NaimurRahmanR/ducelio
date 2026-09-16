-- Commercial V1 PR11B1: governed Examiner execution and trusted atomic
-- initial-grade finalization. Additive only; migrations 001-030 are
-- byte-for-byte unchanged. Migration 021's academic_content_releases,
-- migration 025's academic_provider_executions and migration 028's
-- tutor_lab_provider_executions remain untouched and hard-coded to their own
-- agent_profile values -- this migration introduces a SEPARATE, distinctly
-- identifiable governance surface (COMMERCIAL_V1_EXAMINER_V1 /
-- PROVIDER_BACKED_V1), constrained to EXAMINER only, reusing only the
-- already-reviewed academic_execution_private.controller_keys HMAC trust
-- root (migration 022) under a distinct protocol tag/canonical namespace so
-- no other surface's attestation can ever authorize an Examiner transition
-- and vice versa. ROLES_WITH_REVIEWED_EXECUTION_PATH in
-- src/server/academic-runtime/index.ts is NOT modified (still {PROFESSOR}
-- only) -- Examiner execution is composed through its own SEPARATE boundary
-- (src/server/commercial-v1-examiner-grading), never by widening that set.
--
-- Scope: this is the FIRST production grade only (revision 1). No
-- regrade/supersession authority is added here. PR11A's current-result rule
-- (highest revision must independently validate; no fallback to an older
-- revision) is unchanged and is reused, not redefined. MASTERY_V1
-- (migration 014) and PR11A's remediation reconciliation triggers (migration
-- 030) are reused exactly as written -- neither is replaced.

do $$ begin
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions') then
    raise exception 'Examiner grading requires pgcrypto in extensions';
  end if;
end $$;

create schema commercial_v1_examiner_private;
revoke all on schema commercial_v1_examiner_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 1: the governed Examiner execution/claim record. Exactly one row
-- is ever created per grading target (assessment attempt or lab submission)
-- -- enforced by the two partial unique indexes below, not merely by
-- convention. A transient admission refusal (rate limit, target not yet
-- eligible) writes NO row at all, so it can be legitimately retried once the
-- underlying condition clears; only a REAL admitted claim (state AUTHORIZED
-- or later) ever occupies the one-row-per-target slot, so a terminal outcome
-- (SUCCEEDED/FAILED/ESCALATED/TIMEOUT/CANCELLED/BUDGET_BLOCKED) can never be
-- superseded by a second provider call for the same target -- this IS the
-- concurrency claim and the "initial grade only" guarantee at once.
-- ==========================================================================
create table public.commercial_v1_examiner_executions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid references public.enrolments(id),
  activation_id uuid references public.course_activations(id),
  capability text not null check(capability in ('grade_controlled_assessment','grade_practical_lab')),
  target_kind text not null check(target_kind in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')),
  attempt_id uuid references public.assessment_attempts(id),
  submission_id uuid references public.commercial_v1_lab_submissions(id),
  component text check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  practical_id uuid references public.course_practicals(id),
  policy_version text not null default 'COMMERCIAL_V1_EXAMINER_V1' check(policy_version='COMMERCIAL_V1_EXAMINER_V1'),
  execution_kind text not null default 'PROVIDER_BACKED_V1' check(execution_kind='PROVIDER_BACKED_V1'),
  -- The exact reviewed, code-owned runtime/model profile this execution was
  -- admitted under (src/server/academic-runtime/profile-registry.ts). Fixed
  -- for this checkpoint (no per-course override exists), immutable once
  -- inserted, and bound into the HMAC canonical message below so execution
  -- policy/profile provenance cannot drift silently. Never caller-supplied.
  runtime_profile_ref text not null default 'EXAMINER_COMMERCIAL_V1' check(runtime_profile_ref='EXAMINER_COMMERCIAL_V1'),
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
  -- Independently reproducible: the DB recomputes this exact digest from the
  -- normalized grade payload at FINALIZE and refuses any mismatch. Never a
  -- caller-trusted proof of marks on its own -- see verify_command_ex1 and
  -- the FINALIZE branch below. No raw provider output or answer-key content
  -- is ever stored on this row.
  grade_digest text check(grade_digest is null or grade_digest ~ '^[0-9a-f]{64}$'),
  result_revision_id uuid,
  check((target_kind='ASSESSMENT_ATTEMPT')=(attempt_id is not null)),
  check((target_kind='ASSESSMENT_ATTEMPT')=(component is not null)),
  check((target_kind='LAB_SUBMISSION')=(submission_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(practical_id is not null)),
  check((capability='grade_controlled_assessment')=(target_kind='ASSESSMENT_ATTEMPT')),
  check((capability='grade_practical_lab')=(target_kind='LAB_SUBMISSION')),
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
create unique index examiner_execution_one_per_attempt
  on public.commercial_v1_examiner_executions(attempt_id) where attempt_id is not null;
create unique index examiner_execution_one_per_submission
  on public.commercial_v1_examiner_executions(submission_id) where submission_id is not null;
create index examiner_execution_admission on public.commercial_v1_examiner_executions(student_id,created_at);
create index examiner_execution_active on public.commercial_v1_examiner_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.commercial_v1_examiner_executions enable row level security;
revoke all on public.commercial_v1_examiner_executions from public, anon, authenticated, service_role;

-- Durable, content-free usage ledger, identical shape to migrations 025/028.
create table public.commercial_v1_examiner_execution_usage (
  execution_id uuid primary key references public.commercial_v1_examiner_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 1),
  attempts integer not null check(attempts between 0 and 3),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.commercial_v1_examiner_execution_usage enable row level security;
revoke all on public.commercial_v1_examiner_execution_usage from public, anon, authenticated, service_role;

create function commercial_v1_examiner_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Examiner execution history cannot be deleted'; end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then raise exception 'Terminal Examiner execution history is immutable'; end if;
  -- Every institutional identity/policy/budget binding derived at AUTHORIZE
  -- is immutable for the rest of the row's life: student, capability,
  -- target kind, attempt/submission, component/practical, policy version,
  -- execution kind, runtime profile ref, creation/authorization timestamps
  -- and the admitted budget ceilings. Only result_revision_id/state/
  -- reason_code/budget_stage/started_at/terminal_at/grade_digest/
  -- review_path may ever change, and only along the legitimate transitions
  -- checked below.
  if row(NEW.id,NEW.student_id,NEW.capability,NEW.target_kind,NEW.attempt_id,NEW.submission_id,NEW.component,
    NEW.practical_id,NEW.policy_version,NEW.execution_kind,NEW.runtime_profile_ref,
    NEW.created_at,NEW.authorized_at,NEW.expires_at,NEW.max_provider_calls,
    NEW.max_output_tokens,NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id,OLD.student_id,OLD.capability,OLD.target_kind,OLD.attempt_id,OLD.submission_id,OLD.component,
    OLD.practical_id,OLD.policy_version,OLD.execution_kind,OLD.runtime_profile_ref,
    OLD.created_at,OLD.authorized_at,OLD.expires_at,OLD.max_provider_calls,
    OLD.max_output_tokens,OLD.max_estimated_cost_microusd) then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  -- enrolment_id/activation_id are set exactly once, at the AUTHORIZED->
  -- (same row) point, and are otherwise immutable.
  if OLD.enrolment_id is not null and NEW.enrolment_id is distinct from OLD.enrolment_id then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  if OLD.activation_id is not null and NEW.activation_id is distinct from OLD.activation_id then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  if not ((OLD.state='AUTHORIZED' and NEW.state in ('RUNNING','FAILED','TIMEOUT')) or
    (OLD.state='RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED'))) then
    raise exception 'Invalid Examiner execution transition';
  end if;
  if OLD.state='RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'Examiner execution start is immutable';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_examiner_private.guard_execution() from public, anon, authenticated, service_role;
create trigger guard_examiner_execution before update or delete on public.commercial_v1_examiner_executions
for each row execute function commercial_v1_examiner_private.guard_execution();

create function commercial_v1_examiner_private.guard_execution_usage() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Examiner execution usage is append-only and immutable'; end $$;
revoke all on function commercial_v1_examiner_private.guard_execution_usage() from public, anon, authenticated, service_role;
create trigger guard_examiner_execution_usage before update or delete on public.commercial_v1_examiner_execution_usage
for each row execute function commercial_v1_examiner_private.guard_execution_usage();

-- Content-minimised audit: identifiers/state/usage/grade digest only. There
-- is structurally no column here for raw provider output, an answer key, a
-- learner response body or a lab submission body.
create function commercial_v1_examiner_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.commercial_v1_examiner_execution_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'COMMERCIAL_V1_EXAMINER_EXECUTION_'||NEW.state,'commercial_v1_examiner_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Commercial V1 Examiner grading execution lifecycle',
    jsonb_build_object('execution_id',NEW.id,'student_id',NEW.student_id,'enrolment_id',NEW.enrolment_id,
      'activation_id',NEW.activation_id,'capability',NEW.capability,'target_kind',NEW.target_kind,
      'attempt_id',NEW.attempt_id,'submission_id',NEW.submission_id,'component',NEW.component,
      'practical_id',NEW.practical_id,'policy_version',NEW.policy_version,'execution_kind',NEW.execution_kind,
      'runtime_profile_ref',NEW.runtime_profile_ref,
      'state',NEW.state,'reason_code',NEW.reason_code,'budget_stage',NEW.budget_stage,
      'created_at',NEW.created_at,'authorized_at',NEW.authorized_at,'started_at',NEW.started_at,
      'terminal_at',NEW.terminal_at,'expires_at',NEW.expires_at,'review_path',NEW.review_path,
      'grade_digest',NEW.grade_digest,'result_revision_id',NEW.result_revision_id,
      'max_provider_calls',NEW.max_provider_calls,'max_output_tokens',NEW.max_output_tokens,
      'max_estimated_cost_microusd',NEW.max_estimated_cost_microusd,'usage',usage_snapshot),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function commercial_v1_examiner_private.audit_execution() from public, anon, authenticated, service_role;
create trigger audit_examiner_execution after insert or update on public.commercial_v1_examiner_executions
for each row execute function commercial_v1_examiner_private.audit_execution();

-- ==========================================================================
-- Section 2: controller attestation. Canonical message for this surface,
-- reusing academic_execution_private.controller_keys (migration 022) under
-- a distinct protocol tag/policy version, so no other surface's MAC can
-- ever authorize an Examiner transition and vice versa:
--   DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1
--   COMMERCIAL_V1_EXAMINER_V1
--   EXAMINER
--   EXAMINER_COMMERCIAL_V1  (the fixed runtime profile ref -- a hardcoded
--     literal in this canonical text, never a caller-supplied parameter, so
--     execution policy/profile provenance cannot drift silently; a future
--     checkpoint that changes this ref must also change this literal,
--     which is itself a reviewed migration diff)
--   key_id / actor / execution_id
--   capability / target_kind / attempt_id|'NONE' / submission_id|'NONE'
--   enrolment_id|'NONE' / activation_id|'NONE'  (unknown at AUTHORIZE;
--     bound at START/FINALIZE to the exact identity AUTHORIZE itself
--     derived and returned, and independently re-checked against the stored
--     row -- never a caller-supplied identity claim taken on faith)
--   operation / requested_state / requested_reason / requested_budget_stage
--   max_provider_calls / max_output_tokens / max_estimated_cost_microusd
--   provider_calls / attempts / input_tokens / output_tokens /
--   estimated_cost_microusd / elapsed_ms
--   grade_digest|'NONE'  (the sha256 hex digest of the normalized grade
--     payload -- never the raw marks themselves; independently recomputed
--     and required to match at FINALIZE, see below)
--   issued_at_epoch_seconds / expires_at_epoch_seconds
-- ==========================================================================
create function commercial_v1_examiner_private.verify_command_ex1(
  p_key_id uuid,p_execution_id uuid,p_capability text,p_target_kind text,p_attempt_id uuid,p_submission_id uuid,
  p_enrolment_id uuid,p_activation_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; canonical text; mismatch integer := 0; stamp numeric;
begin
  stamp := extract(epoch from clock_timestamp());
  if public.current_app_user() is null or p_key_id is null or p_execution_id is null
    or p_capability is null or p_capability not in ('grade_controlled_assessment','grade_practical_lab')
    or p_target_kind is null or p_target_kind not in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')
    or p_operation is null or p_operation not in ('AUTHORIZE','START','FINALIZE')
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','GRADED',
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR',
      'INTERNAL_ERROR','OUTPUT_INVALID','RESULT_INTEGRITY_FAILED','NO_PROVIDER_CONFIGURED',
      'HUMAN_REVIEW_REQUIRED','BUDGET_BLOCKED','EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls not between 0 and 1
    or p_max_output is null or p_max_output not between 0 and 1200
    or p_max_cost is null or p_max_cost not between 0 and 50000
    or p_calls is null or p_calls not between 0 and 1
    or p_attempts is null or p_attempts not between 0 and 3
    or p_input is null or p_input not between 0 and 1000000
    or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000
    or p_elapsed is null or p_elapsed not between 0 and 60000
    or (p_grade_digest is not null and p_grade_digest !~ '^[0-9a-f]{64}$')
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or length(p_mac)<>64 or p_mac !~ '^[0-9a-f]{64}$'
    or (p_target_kind='ASSESSMENT_ATTEMPT') <> (p_attempt_id is not null)
    or (p_target_kind='LAB_SUBMISSION') <> (p_submission_id is not null) then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical := concat_ws(E'\n','DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1','COMMERCIAL_V1_EXAMINER_V1','EXAMINER',
    'EXAMINER_COMMERCIAL_V1',
    p_key_id::text,public.current_app_user()::text,p_execution_id::text,
    p_capability,p_target_kind,coalesce(p_attempt_id::text,'NONE'),coalesce(p_submission_id::text,'NONE'),
    coalesce(p_enrolment_id::text,'NONE'),coalesce(p_activation_id::text,'NONE'),
    p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls::text,p_max_output::text,p_max_cost::text,
    p_calls::text,p_attempts::text,p_input::text,p_output::text,p_cost::text,p_elapsed::text,
    coalesce(p_grade_digest,'NONE'),p_issued_at::text,p_expires_at::text);
  expected := extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256');
  supplied := decode(p_mac,'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function commercial_v1_examiner_private.verify_command_ex1(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text
) from public, anon, authenticated, service_role;

-- ==========================================================================
-- Blocker 1 (independent review, V2): a fresh, dedicated controller
-- attestation for CONTEXT_READ. Knowing a RUNNING execution UUID is never
-- sufficient on its own to read expected_answer/marking_guidance/response/
-- submission bodies -- only the trusted server (holder of the controller
-- secret) can produce a valid signature for this operation. Distinct
-- canonical operation ('CONTEXT_READ') under the SAME policy/protocol tag
-- (so it is unmistakably Examiner-scoped, never confusable with a
-- Professor/Tutor/Lab attestation), binding: policy, EXAMINER, the fixed
-- runtime profile ref, key id, actor, execution id, capability, target
-- kind, attempt-or-submission id, enrolment, activation, the operation
-- itself, and issued/expiry -- a strictly lighter parameter set than
-- verify_command_ex1 (no state/reason/budget/usage/grade-digest exists for
-- a read), deliberately not reusing that function's own signature.
-- ==========================================================================
create function commercial_v1_examiner_private.verify_context_read_ex1(
  p_key_id uuid,p_execution_id uuid,p_capability text,p_target_kind text,p_attempt_id uuid,p_submission_id uuid,
  p_enrolment_id uuid,p_activation_id uuid,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; canonical text; mismatch integer := 0; stamp numeric;
begin
  stamp := extract(epoch from clock_timestamp());
  if public.current_app_user() is null or p_key_id is null or p_execution_id is null
    or p_capability is null or p_capability not in ('grade_controlled_assessment','grade_practical_lab')
    or p_target_kind is null or p_target_kind not in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')
    or p_enrolment_id is null or p_activation_id is null
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or length(p_mac)<>64 or p_mac !~ '^[0-9a-f]{64}$'
    or (p_target_kind='ASSESSMENT_ATTEMPT') <> (p_attempt_id is not null)
    or (p_target_kind='LAB_SUBMISSION') <> (p_submission_id is not null) then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical := concat_ws(E'\n','DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1','COMMERCIAL_V1_EXAMINER_V1','EXAMINER',
    'EXAMINER_COMMERCIAL_V1',
    p_key_id::text,public.current_app_user()::text,p_execution_id::text,
    p_capability,p_target_kind,coalesce(p_attempt_id::text,'NONE'),coalesce(p_submission_id::text,'NONE'),
    p_enrolment_id::text,p_activation_id::text,'CONTEXT_READ',p_issued_at::text,p_expires_at::text);
  expected := extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256');
  supplied := decode(p_mac,'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function commercial_v1_examiner_private.verify_context_read_ex1(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,bigint,bigint,text
) from public, anon, authenticated, service_role;

create function commercial_v1_examiner_private.execution_projection(p_id uuid,p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'transitioned',p_changed,'execution',jsonb_build_object(
    'executionId',e.id,'studentId',e.student_id,'enrolmentId',e.enrolment_id,'activationId',e.activation_id,
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
      from public.commercial_v1_examiner_execution_usage u where u.execution_id=e.id)))
  from public.commercial_v1_examiner_executions e where e.id=p_id
$$;
revoke all on function commercial_v1_examiner_private.execution_projection(uuid,boolean) from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 3: the one governed command surface. AUTHORIZE derives and
-- validates the ENTIRE authoritative identity chain (attempt/submission
-- ownership, SUBMITTED state, bound formal component or published lab
-- policy, published result policy, absence of any existing production
-- result for this target) before ever creating the one-row-per-target claim
-- -- this is the database-backed claim/state transition required before any
-- provider call, and it is what makes a second concurrent/replayed
-- AUTHORIZE for the SAME target either lose the race (REPLAY_REJECTED while
-- non-terminal) or observe the SAME terminal outcome (idempotent replay
-- after SUCCEEDED/FAILED/ESCALATED/TIMEOUT) rather than ever reaching a
-- second provider call.
-- ==========================================================================
create function public.govern_commercial_v1_examiner_execution(
  p_key_id uuid,p_execution_id uuid,p_capability text,p_target_kind text,p_attempt_id uuid,p_submission_id uuid,
  p_enrolment_id uuid,p_activation_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,
  p_assessment_marks jsonb,p_lab_marks_awarded integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid; stamp timestamptz; execution_record public.commercial_v1_examiner_executions%rowtype;
  attempt public.assessment_attempts%rowtype; e public.enrolments%rowtype; activation public.course_activations%rowtype;
  binding public.commercial_v1_component_bindings%rowtype; submission public.commercial_v1_lab_submissions%rowtype;
  inserted_count integer; existing public.commercial_v1_examiner_executions%rowtype; denied text;
  computed_digest text; marks_text text; expected_weight integer; max_total integer; result_id uuid;
  mark_elem jsonb; qid uuid; mark integer; qmax integer; answered_count integer; marks_count integer;
  q_row record; lp record;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not commercial_v1_examiner_private.verify_command_ex1(p_key_id,p_execution_id,p_capability,p_target_kind,p_attempt_id,p_submission_id,
    p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
    p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if not commercial_v1_examiner_private.verify_command_ex1(p_key_id,p_execution_id,p_capability,p_target_kind,p_attempt_id,p_submission_id,
    p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
    p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  -- Lazily timeout any stale AUTHORIZED/RUNNING execution for this student
  -- (backstop, mirrors migrations 025/028; the terminal row remains the
  -- ONE row ever created for its own target -- no retry follows).
  update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
  where student_id=actor and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;

  if p_operation='AUTHORIZE' then
    if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
    if p_state<>'AUTHORIZED' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0
      or p_grade_digest is not null or p_enrolment_id is not null or p_activation_id is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;

    -- Blocker 2 (independent review, V3): check for an existing Examiner
    -- execution CLAIM for this EXACT target FIRST -- strictly before the
    -- student's generic new-admission rate limits, budget-envelope
    -- validation and fresh-target eligibility checks below. Otherwise a
    -- prior SUCCEEDED target could incorrectly surface as RATE_LIMITED
    -- merely because another target is currently active, or because the
    -- student's 5/60s or 30/1h admission counters are exhausted -- neither
    -- of which has anything to do with a target that was already resolved.
    -- A same-target replay must always observe its OWN execution's outcome
    -- (preserving, for a prior SUCCEEDED grade, the exact resultRevisionId)
    -- rather than a generic ALREADY_GRADED denial or an unrelated
    -- admission-limit denial that would both discard it. ALREADY_GRADED
    -- remains reachable below, but only once this checkpoint's own
    -- execution history has nothing to say about the target -- i.e. only
    -- for a production result that predates (or exists independent of) any
    -- Examiner execution for it. Actor-safe by construction: the lookup is
    -- filtered to student_id=actor, so a caller probing with a foreign
    -- attempt/submission id observes nothing here (falls through to the
    -- ordinary ownership check below, which returns the same bounded
    -- NOT_FOUND_OR_FORBIDDEN it always has) -- never another student's
    -- execution projection, state or resultRevisionId.
    if p_capability='grade_controlled_assessment' then
      select * into existing from public.commercial_v1_examiner_executions where attempt_id=p_attempt_id and student_id=actor;
    else
      select * into existing from public.commercial_v1_examiner_executions where submission_id=p_submission_id and student_id=actor;
    end if;
    if found then
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      return commercial_v1_examiner_private.execution_projection(existing.id,false);
    end if;

    -- Only reached when NO exact-target claim exists for this actor: new-
    -- admission rate limiting, budget-envelope validation and fresh-target
    -- eligibility checks now apply.
    if exists(select 1 from public.commercial_v1_examiner_executions where student_id=actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.commercial_v1_examiner_executions where student_id=actor and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.commercial_v1_examiner_executions where student_id=actor and created_at>stamp-interval '1 hour')>=30 then
      return jsonb_build_object('ok',false,'code','RATE_LIMITED');
    end if;
    if p_max_calls<>1 or p_max_output<1 or p_max_output>1200 or p_max_cost<1 or p_max_cost>50000 then
      return jsonb_build_object('ok',false,'code','OUT_OF_ENVELOPE');
    end if;

    if p_capability='grade_controlled_assessment' then
      select * into attempt from public.assessment_attempts where id=p_attempt_id;
      if not found or attempt.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      if attempt.state<>'SUBMITTED' then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      select * into e from public.enrolments where id=attempt.enrolment_id;
      if not found or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select a.* into activation from public.course_activations a where a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id;
      if not found then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      select * into binding from public.commercial_v1_component_bindings where activation_id=activation.id and assessment_id=attempt.assessment_id;
      if not found then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      if not exists(select 1 from public.commercial_v1_result_policies where activation_id=activation.id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      -- No Examiner execution exists for this target (checked above), but a
      -- production result already does -- historical/external result state
      -- (e.g. a future manual/service-authored result). Fail closed rather
      -- than create a second execution claim that could never produce a
      -- second revision anyway (guard_assessment_result_insert, migration
      -- 030, refuses revision 1 once one already exists).
      if exists(select 1 from public.commercial_v1_assessment_result_revisions where enrolment_id=e.id and component=binding.component) then
        return jsonb_build_object('ok',false,'code','ALREADY_GRADED');
      end if;
      insert into public.commercial_v1_examiner_executions(
        id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
        state,created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) values (
        p_execution_id,actor,e.id,activation.id,p_capability,'ASSESSMENT_ATTEMPT',p_attempt_id,binding.component,
        'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
      ) on conflict (attempt_id) where attempt_id is not null do nothing;
    else
      select * into submission from public.commercial_v1_lab_submissions where id=p_submission_id;
      if not found or submission.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select * into e from public.enrolments where id=submission.enrolment_id;
      if not found or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select a.* into activation from public.course_activations a where a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id;
      if not found or activation.id<>submission.activation_id then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      if not exists(select 1 from public.commercial_v1_lab_policies where activation_id=activation.id and practical_id=submission.practical_id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      if not exists(select 1 from public.commercial_v1_result_policies where activation_id=activation.id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      if exists(select 1 from public.commercial_v1_lab_result_revisions where enrolment_id=e.id and practical_id=submission.practical_id) then
        return jsonb_build_object('ok',false,'code','ALREADY_GRADED');
      end if;
      insert into public.commercial_v1_examiner_executions(
        id,student_id,enrolment_id,activation_id,capability,target_kind,submission_id,practical_id,
        state,created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) values (
        p_execution_id,actor,e.id,activation.id,p_capability,'LAB_SUBMISSION',p_submission_id,submission.practical_id,
        'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
      ) on conflict (submission_id) where submission_id is not null do nothing;
    end if;
    get diagnostics inserted_count = row_count;
    if inserted_count=0 then
      -- Concurrency backstop: another request for this SAME actor's SAME
      -- target won the insert race between the pre-check above and here
      -- (a foreign actor can never reach this point at all -- the
      -- eligibility checks just above already required this target to
      -- belong to `actor`). Still filtered by student_id=actor for
      -- defense-in-depth consistency with the pre-check.
      if p_capability='grade_controlled_assessment' then
        select * into existing from public.commercial_v1_examiner_executions where attempt_id=p_attempt_id and student_id=actor;
      else
        select * into existing from public.commercial_v1_examiner_executions where submission_id=p_submission_id and student_id=actor;
      end if;
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      -- A pre-existing TERMINAL row for this exact target: return its own
      -- outcome unchanged, never a second provider call for it.
      return commercial_v1_examiner_private.execution_projection(existing.id,false);
    end if;
    return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.commercial_v1_examiner_executions where id=p_execution_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;
  if execution_record.capability<>p_capability or execution_record.target_kind<>p_target_kind
    or execution_record.attempt_id is distinct from p_attempt_id or execution_record.submission_id is distinct from p_submission_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    return jsonb_build_object('ok',false,'code',
      case when execution_record.reason_code='EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;
  if stamp>=execution_record.expires_at then
    update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=execution_record.expires_at
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code','EXECUTION_TIMEOUT');
  end if;
  if p_enrolment_id<>execution_record.enrolment_id or p_activation_id<>execution_record.activation_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;

  if p_operation='START' then
    if p_state<>'RUNNING' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 or p_grade_digest is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if execution_record.state='RUNNING' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.commercial_v1_examiner_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
  end if;

  -- FINALIZE
  if execution_record.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
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

  insert into public.commercial_v1_examiner_execution_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);

  if p_state='SUCCEEDED' then
    -- ============================================================
    -- CRITICAL SUCCESS RULE: the SAME enrolment row lock
    -- attempt_commercial_v1_course_completion uses, acquired before any
    -- current-result observation or write. Everything below -- the
    -- authoritative result insert, the question marks (assessment) or
    -- earned/max/contribution (lab), the existing PR11A derivation helper,
    -- PR11A's own assessment_result_is_valid/lab_result_is_valid check, and
    -- the execution row's own transition to SUCCEEDED -- happens inside
    -- this single PL/pgSQL function invocation, which is one PostgreSQL
    -- transaction: it either all commits together, or (on any exception,
    -- caught below) none of the result-side writes survive and the
    -- execution is instead durably recorded FAILED/RESULT_INTEGRITY_FAILED.
    -- A result can therefore never exist while its Examiner execution
    -- remains non-successful, and this row can never become SUCCEEDED
    -- while its result is missing or invalid.
    -- ============================================================
    perform 1 from public.enrolments where id=execution_record.enrolment_id for update;
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
      update public.commercial_v1_examiner_executions
      set state='SUCCEEDED',reason_code='GRADED',terminal_at=stamp,result_revision_id=result_id,grade_digest=p_grade_digest
      where id=p_execution_id;
    exception when others then
      denied := 'RESULT_INTEGRITY_FAILED';
    end;
    if denied is not null then
      update public.commercial_v1_examiner_executions
      set state='FAILED',reason_code=denied,terminal_at=stamp where id=p_execution_id;
    end if;
  else
    update public.commercial_v1_examiner_executions
    set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
      review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
    where id=p_execution_id;
  end if;
  return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
end $$;
revoke all on function public.govern_commercial_v1_examiner_execution(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) from public, anon, authenticated, service_role;
grant execute on function public.govern_commercial_v1_examiner_execution(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) to authenticated;

-- ==========================================================================
-- Section 4 (Blocker 1, independent review V2): authoritative, protected
-- provider context. These are the ONLY readers of expected_answer/
-- marking_guidance/response bodies/submission bodies for this checkpoint.
-- Knowing a RUNNING execution UUID is NEVER sufficient on its own: each
-- call requires a FRESH, valid CONTEXT_READ controller attestation
-- (verify_context_read_ex1, above) -- an authenticated learner who merely
-- owns a RUNNING execution, but cannot produce a valid MAC, is refused. The
-- execution must additionally still be RUNNING and unexpired AT READ TIME;
-- an expired RUNNING execution is lazily transitioned to TIMEOUT here
-- (identical lifecycle semantics to the timeout handling inside
-- govern_commercial_v1_examiner_execution) and the read fails closed.
-- ==========================================================================
create function public.get_commercial_v1_examiner_assessment_context(
  p_key_id uuid,p_execution_id uuid,p_attempt_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; ex public.commercial_v1_examiner_executions%rowtype; asm public.assessments%rowtype; stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not commercial_v1_examiner_private.verify_context_read_ex1(p_key_id,p_execution_id,'grade_controlled_assessment',
    'ASSESSMENT_ATTEMPT',p_attempt_id,null,p_enrolment_id,p_activation_id,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  select * into ex from public.commercial_v1_examiner_executions where id=p_execution_id and student_id=actor for update;
  if not found or ex.target_kind<>'ASSESSMENT_ATTEMPT' or ex.attempt_id<>p_attempt_id
    or ex.enrolment_id<>p_enrolment_id or ex.activation_id<>p_activation_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  if ex.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;
  if stamp>=ex.expires_at then
    update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=ex.expires_at
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code','EXECUTION_TIMEOUT');
  end if;
  select * into asm from public.assessments where id=(select assessment_id from public.assessment_attempts where id=ex.attempt_id);
  return jsonb_build_object('ok',true,'attemptId',ex.attempt_id,'assessmentId',asm.id,'component',ex.component,
    'title',asm.title,'instructions',asm.instructions,
    'questions',(
      -- Answered questions only (the reviewed context contract, section 6/
      -- 7 of the checkpoint brief): the trusted finalizer -- not the
      -- provider -- supplies the deterministic zero for every question
      -- that has no response row.
      select coalesce(jsonb_agg(jsonb_build_object(
        'questionId',q.id,'position',q.position,'prompt',q.prompt,'maxMarks',q.max_marks,
        'expectedAnswer',ak.expected_answer,'markingGuidance',ak.marking_guidance,
        'responseBody',r.body
      ) order by q.position),'[]'::jsonb)
      from public.assessment_questions q
      join public.assessment_answer_keys ak on ak.question_id=q.id
      join lateral (
        select body from public.assessment_responses
        where attempt_id=ex.attempt_id and question_id=q.id
        order by revision_number desc limit 1
      ) r on true
      where q.assessment_id=asm.id
    ));
end $$;
revoke all on function public.get_commercial_v1_examiner_assessment_context(
  uuid,uuid,uuid,uuid,uuid,bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.get_commercial_v1_examiner_assessment_context(
  uuid,uuid,uuid,uuid,uuid,bigint,bigint,text
) to authenticated;

create function public.get_commercial_v1_examiner_lab_context(
  p_key_id uuid,p_execution_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; ex public.commercial_v1_examiner_executions%rowtype; sub public.commercial_v1_lab_submissions%rowtype;
  pr public.course_practicals%rowtype; lp public.commercial_v1_lab_policies%rowtype; stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not commercial_v1_examiner_private.verify_context_read_ex1(p_key_id,p_execution_id,'grade_practical_lab',
    'LAB_SUBMISSION',null,p_submission_id,p_enrolment_id,p_activation_id,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  select * into ex from public.commercial_v1_examiner_executions where id=p_execution_id and student_id=actor for update;
  if not found or ex.target_kind<>'LAB_SUBMISSION' or ex.submission_id<>p_submission_id
    or ex.enrolment_id<>p_enrolment_id or ex.activation_id<>p_activation_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  if ex.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;
  if stamp>=ex.expires_at then
    update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=ex.expires_at
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code','EXECUTION_TIMEOUT');
  end if;
  select * into sub from public.commercial_v1_lab_submissions where id=ex.submission_id;
  select * into pr from public.course_practicals where id=ex.practical_id;
  select * into lp from public.commercial_v1_lab_policies where activation_id=ex.activation_id and practical_id=ex.practical_id;
  return jsonb_build_object('ok',true,'submissionId',ex.submission_id,'practicalId',ex.practical_id,
    'title',pr.title,'instructions',pr.instructions,'maxMarks',lp.max_marks,'gradingGuidance',lp.grading_guidance,
    'submissionBody',sub.body,
    'objectives',(
      select coalesce(jsonb_agg(jsonb_build_object('objectiveId',lo.id,'description',lo.description) order by lo.position),'[]'::jsonb)
      from public.course_practical_objectives po
      join public.lesson_objectives lo on lo.id=po.objective_id
      where po.practical_id=ex.practical_id
    ));
end $$;
revoke all on function public.get_commercial_v1_examiner_lab_context(
  uuid,uuid,uuid,uuid,uuid,bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.get_commercial_v1_examiner_lab_context(
  uuid,uuid,uuid,uuid,uuid,bigint,bigint,text
) to authenticated;

-- ==========================================================================
-- Section 5: RLS/ACL hardening, mirroring migrations 022/025/028/030 exactly.
-- ==========================================================================
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.commercial_v1_examiner_executions'::regclass,'public.commercial_v1_examiner_execution_usage'::regclass
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
      'public.commercial_v1_examiner_executions'::regclass,'public.commercial_v1_examiner_execution_usage'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective Examiner execution table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r,'commercial_v1_examiner_private','USAGE,CREATE') then
      raise exception 'Unsafe effective Examiner schema privileges for %', r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commercial_v1_examiner_private'
         or (n.nspname='public' and p.proname in (
           'govern_commercial_v1_examiner_execution','get_commercial_v1_examiner_assessment_context',
           'get_commercial_v1_examiner_lab_context'
         )) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname in (
          'govern_commercial_v1_examiner_execution','get_commercial_v1_examiner_assessment_context',
          'get_commercial_v1_examiner_lab_context'
        )) then
        raise exception 'Unsafe effective Examiner function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
