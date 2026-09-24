-- Commercial V1 -- independent-review correction checkpoint.
-- Forward-only from CLOSED GREEN local Checkpoints A/B/C (migration 040
-- already present). No historical migration (001-040) is modified.
--
-- This migration closes three of the four independent-review findings that
-- require a database change:
--
--   SECTION 1: audit-provenance source misclassification (Finding 3).
--   SECTION 2: a bounded admin discovery/read surface for stranded initial
--     Examiner executions eligible for recovery (Finding 1).
--   SECTION 3: a bounded admin read surface for an activation's real,
--     materialised assessments/practicals and current policy-publication
--     state, so the four existing Checkpoint C policy Server Actions can be
--     driven from real selectable options instead of a blind-typed UUID
--     (Finding 2).
--
-- Finding 4 (test/documentation wording) has no database component and is
-- corrected entirely in TypeScript/test/doc files alongside this migration.

-- ============================================================================
-- SECTION 1 -- audit-provenance source correction (Finding 3).
--
-- Migrations 031, 032 and 040 each classify an audit_events row's `source`
-- column using `reason_code` alone:
--
--   case when NEW.reason_code='EXECUTION_TIMEOUT'
--     then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end
--
-- This is not semantically correct. EXECUTION_TIMEOUT can appear on TWO
-- structurally different transitions:
--
--   A. The database's own lazy-expiry sweep (every governed RPC's own
--      opening `update ... set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT'
--      ... where expires_at<=stamp`, and the CONTEXT_READ-time expiry check):
--      state='TIMEOUT'. This genuinely IS a database-owned policy decision,
--      made with no controller attestation at all -- DATABASE_EXECUTION_POLICY
--      is correct.
--   B. A controller-attested FINALIZE reporting that the runtime/provider
--      call itself observed a timeout: state='FAILED', reason_code=
--      'EXECUTION_TIMEOUT'. This IS an attested controller transition, MAC-
--      verified exactly like every other FINALIZE outcome (PROVIDER_ERROR,
--      OUTPUT_INVALID, ...) -- classifying it as a database-only decision is
--      wrong provenance, even though the audit content itself was already
--      correct and privacy-safe.
--
-- The fix distinguishes the two using the authoritative lifecycle column,
-- `state`, not `reason_code`: only a genuine state='TIMEOUT' row is
-- DATABASE_EXECUTION_POLICY; every other terminal state (including
-- state='FAILED' with reason_code='EXECUTION_TIMEOUT') is
-- ATTESTED_EXECUTION_CONTROLLER, matching every other controller-attested
-- transition on the same table.
--
-- `create or replace function` preserves each function's OID, so the
-- existing AFTER INSERT/UPDATE triggers (created by migrations 031/032/040
-- and never touched here) automatically pick up the corrected body with no
-- trigger DDL of any kind in this migration. No column, table, audit row
-- CONTENT field, or historical audit_events row is touched -- this is a
-- forward-only correction to how FUTURE rows classify `source`; a row
-- already written under the old (looser) classification is not rewritten,
-- consistent with audit_events being append-only/immutable throughout this
-- codebase. Nothing else about these three functions changes.
-- ============================================================================
create or replace function commercial_v1_examiner_private.audit_execution() returns trigger
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
    case when NEW.state='TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
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

create or replace function commercial_v1_regrade_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.commercial_v1_examiner_regrade_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.actor_id,'COMMERCIAL_V1_EXAMINER_REGRADE_'||NEW.state,'commercial_v1_examiner_regrade_executions',NEW.id,
    case when NEW.state='TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Commercial V1 Examiner regrade execution lifecycle',
    jsonb_build_object('actor_id',NEW.actor_id,'source_result_revision_id',NEW.source_result_revision_id,'source_revision_number',NEW.source_revision_number,'execution_id',NEW.id,'student_id',NEW.student_id,'enrolment_id',NEW.enrolment_id,
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

create or replace function commercial_v1_recovery_private.audit_execution() returns trigger
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
    case when NEW.state='TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
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

-- ============================================================================
-- SECTION 2 -- bounded admin recovery-operations read surface (Finding 1).
--
-- Closes the operational reachability gap: recoverControlledAssessmentGrade/
-- recoverPracticalLabGrade (migration 040) exist and are fully governed, but
-- nothing lets an ACADEMIC_ADMIN/PLATFORM_ADMIN discover a real stranded
-- target without direct database access. This section adds exactly two
-- read-only SECURITY DEFINER functions built over one private view, admin-
-- gated identically to migration 040's own AUTHORIZE (has_role check), never
-- the HMAC-attested command surface itself -- these are reads, not state
-- transitions, so they carry no controller MAC and cannot themselves create,
-- modify or terminate any execution or recovery row.
--
-- Privacy minimisation: the projection is bounded metadata only --
-- identifiers, target kind/capability/component-or-practical, original
-- terminal state/reason code/timestamp, and recovery claim status if one
-- exists. It never includes a learner response body, answer key, marking
-- guidance, provider output, prompt, MAC, secret, the recovery claim's own
-- stored `recovery_reason` text, or the generic audit_events JSON. Student
-- identity is exposed only as `studentId`/`enrolmentId` (opaque identifiers
-- already used throughout this codebase for cross-learner staff reads), not
-- a display name or contact detail -- this surface does not need one to be
-- operable, so it is deliberately not added.
--
-- The private view's WHERE clause is the exact same RECOVERABLE-state
-- policy migration 040's own commercial_v1_recovery_private.original()
-- already encodes (FAILED/TIMEOUT/BUDGET_BLOCKED/CANCELLED), so this list
-- can never disagree with what govern_commercial_v1_examiner_recovery
-- itself would actually admit. A row is included even once a recovery claim
-- exists (including a SUCCEEDED one) -- deliberately, so "eligible, never
-- attempted" (recoveryStatus='ELIGIBLE') stays visibly distinct from
-- "attempted and exhausted the one-claim ceiling"
-- (recoveryStatus='RECOVERY_EXHAUSTED') or "already recovered"
-- (recoveryStatus='RECOVERED') -- exactly the distinction the review
-- requires, since the one-claim-per-source ceiling is intentional and an
-- admin must be able to see it was already used rather than wrongly assume
-- nothing was ever tried.
-- ============================================================================
create view commercial_v1_recovery_private.stranded_targets as
select
  x.id as source_execution_id, x.target_kind, x.capability,
  x.student_id, x.enrolment_id, x.activation_id, x.component, x.practical_id,
  x.state as original_state, x.reason_code as original_reason_code, x.terminal_at,
  r.id as recovery_execution_id, r.state as recovery_state,
  case
    when r.id is null then 'ELIGIBLE'
    when r.state in ('AUTHORIZED','RUNNING') then 'RECOVERY_IN_PROGRESS'
    when r.state='SUCCEEDED' then 'RECOVERED'
    when r.state='ESCALATED' then 'RECOVERY_ESCALATED'
    else 'RECOVERY_EXHAUSTED'
  end as recovery_status
from public.commercial_v1_examiner_executions x
left join public.commercial_v1_examiner_recovery_executions r on r.source_execution_id=x.id
where x.state in ('FAILED','TIMEOUT','BUDGET_BLOCKED','CANCELLED')
  and (
    r.id is not null
    or (x.target_kind='ASSESSMENT_ATTEMPT' and not exists(
      select 1 from public.commercial_v1_assessment_result_revisions rr
      where rr.enrolment_id=x.enrolment_id and rr.component=x.component))
    or (x.target_kind='LAB_SUBMISSION' and not exists(
      select 1 from public.commercial_v1_lab_result_revisions rr
      where rr.enrolment_id=x.enrolment_id and rr.practical_id=x.practical_id))
  );
revoke all on commercial_v1_recovery_private.stranded_targets from public, anon, authenticated, service_role;

create function commercial_v1_recovery_private.target_projection(t commercial_v1_recovery_private.stranded_targets) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'sourceExecutionId',t.source_execution_id,'targetKind',t.target_kind,'capability',t.capability,
    'studentId',t.student_id,'enrolmentId',t.enrolment_id,'activationId',t.activation_id,
    'component',t.component,'practicalId',t.practical_id,
    'originalState',t.original_state,'originalReasonCode',t.original_reason_code,'terminalAt',t.terminal_at,
    'recoveryExecutionId',t.recovery_execution_id,'recoveryState',t.recovery_state,'recoveryStatus',t.recovery_status
  )
$$;
revoke all on function commercial_v1_recovery_private.target_projection(commercial_v1_recovery_private.stranded_targets) from public, anon, authenticated, service_role;

-- Bounded list, newest-terminal-first, capped at 200 -- an operational
-- worklist, not an unbounded export. ACADEMIC_ADMIN/PLATFORM_ADMIN only.
create function public.list_commercial_v1_examiner_recovery_targets() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if public.current_app_user() is null then raise exception 'UNAUTHENTICATED'; end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN';
  end if;
  return jsonb_build_object('targets',(
    select coalesce(jsonb_agg(commercial_v1_recovery_private.target_projection(t)),'[]'::jsonb)
    from (
      select * from commercial_v1_recovery_private.stranded_targets
      order by terminal_at desc, source_execution_id limit 200
    ) t
  ));
end $$;
revoke all on function public.list_commercial_v1_examiner_recovery_targets() from public, anon, authenticated, service_role;
grant execute on function public.list_commercial_v1_examiner_recovery_targets() to authenticated;

-- Single-target authoritative resolution. This is what the TypeScript
-- composition layer calls FIRST -- and ONLY -- to resolve a source
-- execution's real targetKind/capability strictly from server/database
-- state before dispatching internally to the correct existing
-- recoverControlledAssessmentGrade/recoverPracticalLabGrade entrypoint.
-- The browser never supplies targetKind/capability on the recovery action
-- itself; this lookup is the server-owned routing decision the review
-- requires, structurally impossible to override from client input because
-- the client's only input to the whole recovery flow is sourceExecutionId
-- and a bounded reason string (see the recoveryInputSchema reused verbatim
-- for this composition in src/domain/commercial-v1-examiner-recovery.ts).
create function public.get_commercial_v1_examiner_recovery_target(p_source_execution_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t commercial_v1_recovery_private.stranded_targets;
begin
  if public.current_app_user() is null then raise exception 'UNAUTHENTICATED'; end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN';
  end if;
  select * into t from commercial_v1_recovery_private.stranded_targets where source_execution_id=p_source_execution_id;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  return commercial_v1_recovery_private.target_projection(t);
end $$;
revoke all on function public.get_commercial_v1_examiner_recovery_target(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_commercial_v1_examiner_recovery_target(uuid) to authenticated;

-- ============================================================================
-- SECTION 3 -- bounded admin policy-setup read (Finding 2).
--
-- The four Checkpoint C policy Server Actions (bindComponentAction,
-- publishGradingPolicyAction, setLabPolicyAction, publishResultPolicyAction)
-- already compose real, correct, governed RPCs with no invented weight,
-- pass mark or component-identity inference anywhere. What was missing is a
-- safe way for an admin to discover an activation's own real assessment/
-- practical row identifiers to bind, rather than typing an arbitrary
-- internal UUID. This single bounded read closes exactly that gap -- it
-- adds no new writing authority and does not alter any of the four
-- existing, already-reviewed governed RPCs it reads alongside.
-- ============================================================================
create function public.get_commercial_v1_policy_setup_options(p_activation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare activation public.course_activations%rowtype;
begin
  perform course_activation_private.require_admin();
  select * into activation from public.course_activations where id=p_activation_id;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  return jsonb_build_object(
    'activationId',activation.id,
    'assessments',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'assessmentId',a.id,'title',a.title,'boundComponent',cb.component
      ) order by a.title,a.id),'[]'::jsonb)
      from public.course_assessment_bindings cab
      join public.assessments a on a.id=cab.assessment_id
      left join public.commercial_v1_component_bindings cb
        on cb.activation_id=p_activation_id and cb.assessment_id=a.id
      where cab.activation_id=p_activation_id
    ),
    'practicals',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'practicalId',p.id,'title',p.title,
        'hasLabPolicy',(lp.practical_id is not null),
        'maxMarks',lp.max_marks,'contributionBp',lp.contribution_bp
      ) order by p.title,p.id),'[]'::jsonb)
      from public.course_practicals p
      left join public.commercial_v1_lab_policies lp
        on lp.activation_id=p_activation_id and lp.practical_id=p.id
      where p.import_id=activation.import_id and p.programme_version_id=activation.programme_version_id
        and p.kind='PRACTICAL_LAB'
    ),
    'componentBindings',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'component',cb.component,'assessmentId',cb.assessment_id,'assessmentTitle',a.title
      ) order by cb.component),'[]'::jsonb)
      from public.commercial_v1_component_bindings cb
      join public.assessments a on a.id=cb.assessment_id
      where cb.activation_id=p_activation_id
    ),
    'gradingPolicyPublished',exists(select 1 from public.commercial_v1_grading_policies where activation_id=p_activation_id),
    'resultPolicyPublished',exists(select 1 from public.commercial_v1_result_policies where activation_id=p_activation_id)
  );
end $$;
revoke all on function public.get_commercial_v1_policy_setup_options(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_commercial_v1_policy_setup_options(uuid) to authenticated;

-- ============================================================================
-- ACL hardening for the new objects this migration adds, mirroring migration
-- 040's own effective-privilege assertion pattern exactly.
-- ============================================================================
do $$ declare r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(r,'commercial_v1_recovery_private.stranded_targets','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r,'commercial_v1_recovery_private.stranded_targets'::regclass,'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe effective stranded_targets view privileges for %', r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='commercial_v1_recovery_private' and p.proname='target_projection')
        or (n.nspname='public' and p.proname in (
          'list_commercial_v1_examiner_recovery_targets','get_commercial_v1_examiner_recovery_target',
          'get_commercial_v1_policy_setup_options')) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public') then
        raise exception 'Unsafe effective review-correction function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
