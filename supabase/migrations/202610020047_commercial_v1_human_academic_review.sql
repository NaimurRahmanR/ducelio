-- Commercial V1 human academic review: governed manual FIRST grade.
-- Forward-only; migrations 001-046 are not modified.
--
-- Gap this closes. The grading chain deliberately leaves result-free targets
-- that no automated authority may grade:
--   * an initial Examiner execution that reached ESCALATED /
--     HUMAN_REVIEW_REQUIRED (migration 040 forbids automated recovery of it);
--   * the one permitted recovery execution (migration 040) that itself reached
--     ESCALATED, or terminated without a result (FAILED / TIMEOUT /
--     BUDGET_BLOCKED / CANCELLED) -- the one-recovery ceiling forbids a retry.
-- Regrade (migration 032) cannot help: it resolves its source from an
-- EXISTING result revision, and there is none.
--
-- Authority. A SEPARATE institutional authority, never a provider execution:
-- a freshly authenticated ACADEMIC_ADMIN or PLATFORM_ADMIN supplies only the
-- human judgment (per-question marks, or one lab mark) plus a bounded
-- reason, for a case identified by its case id. Every target identity and
-- policy value -- learner, enrolment, activation, attempt/submission,
-- assessment, component/practical, question set, max marks, component
-- weight, lab max/contribution, revision number -- is resolved here from
-- authoritative state. No HMAC, provider, budget or runtime profile is
-- involved, and no Examiner/recovery/regrade execution row is touched.
--
-- Result model. The produced row is an ordinary revision 1 written through
-- the unchanged migration 030 insert guards, derivation helpers and
-- assessment_result_is_valid / lab_result_is_valid validators, so progress,
-- completion, remediation, leaderboard and regrade read it exactly like any
-- other valid result. The result table's provenance CHECK
-- (provenance='COMMERCIAL_V1_RESULTS_V1') is deliberately NOT weakened:
-- human origin is recorded in a separate append-only decision row linked
-- one-to-one to the revision, plus an explicit HUMAN_ACADEMIC_REVIEW audit
-- event.
--
-- Concurrency. Each write locks the learner's student_profiles row, then the
-- enrolment row (regrade's established order; completion and Examiner
-- FINALIZE take the same enrolment lock), then re-checks reviewer authority,
-- re-resolves the case and re-checks that the target is still result-free.
-- A repeat or late submission for an already-resolved case returns the
-- existing decision idempotently; a case resolved by any other path fails
-- closed. Migration 030's unique(enrolment_id,component|practical_id,
-- revision_number) and revision-1 guard independently make a second
-- revision 1 impossible, and the decision table allows one decision per
-- original target claim.
create schema commercial_v1_review_private;
revoke all on schema commercial_v1_review_private from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 1: the append-only human academic review decision record.
-- ==========================================================================
create table public.commercial_v1_academic_review_decisions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.app_users(id),
  case_kind text not null check(case_kind in ('INITIAL_ESCALATION','RECOVERY_ESCALATION','RECOVERY_EXHAUSTED')),
  -- The original target claim (always) and, for recovery cases, the one
  -- recovery claim whose terminal outcome opened the case.
  source_execution_id uuid not null unique references public.commercial_v1_examiner_executions(id),
  recovery_execution_id uuid unique references public.commercial_v1_examiner_recovery_executions(id),
  case_state text not null check(case_state in ('ESCALATED','FAILED','TIMEOUT','BUDGET_BLOCKED','CANCELLED')),
  case_reason_code text not null check(case_reason_code ~ '^[A-Z_]{1,80}$'),
  case_opened_at timestamptz not null,
  target_kind text not null check(target_kind in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')),
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.enrolments(id),
  activation_id uuid not null references public.course_activations(id),
  attempt_id uuid references public.assessment_attempts(id),
  component text check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  submission_id uuid references public.commercial_v1_lab_submissions(id),
  practical_id uuid references public.course_practicals(id),
  assessment_result_revision_id uuid unique references public.commercial_v1_assessment_result_revisions(id),
  lab_result_revision_id uuid unique references public.commercial_v1_lab_result_revisions(id),
  result_revision_number integer not null check(result_revision_number=1),
  decision_kind text not null default 'MANUAL_FIRST_GRADE' check(decision_kind='MANUAL_FIRST_GRADE'),
  status text not null default 'RESULT_CREATED' check(status='RESULT_CREATED'),
  policy_version text not null default 'COMMERCIAL_V1_ACADEMIC_REVIEW_V1' check(policy_version='COMMERCIAL_V1_ACADEMIC_REVIEW_V1'),
  reason text not null check(length(reason) between 5 and 300 and reason=btrim(reason)),
  decided_at timestamptz not null default clock_timestamp(),
  check((case_kind='INITIAL_ESCALATION')=(recovery_execution_id is null)),
  check(case_kind<>'INITIAL_ESCALATION' or case_state='ESCALATED'),
  check(case_kind<>'RECOVERY_ESCALATION' or case_state='ESCALATED'),
  check(case_kind<>'RECOVERY_EXHAUSTED' or case_state in ('FAILED','TIMEOUT','BUDGET_BLOCKED','CANCELLED')),
  check((target_kind='ASSESSMENT_ATTEMPT')=(attempt_id is not null)),
  check((target_kind='ASSESSMENT_ATTEMPT')=(component is not null)),
  check((target_kind='ASSESSMENT_ATTEMPT')=(assessment_result_revision_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(submission_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(practical_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(lab_result_revision_id is not null)),
  check(decided_at>=case_opened_at)
);
alter table public.commercial_v1_academic_review_decisions enable row level security;
revoke all on public.commercial_v1_academic_review_decisions from public,anon,authenticated,service_role;

create function commercial_v1_review_private.decisions_append_only() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Academic review decisions are append-only and immutable'; end $$;
create trigger academic_review_decisions_append_only
before update or delete on public.commercial_v1_academic_review_decisions
for each row execute function commercial_v1_review_private.decisions_append_only();

-- ==========================================================================
-- Section 2: case resolution. case_candidates are every terminal claim that
-- CAN open a human-review case; open_cases are those whose target is still
-- result-free. A case id is the id of the claim that opened it (the initial
-- execution for INITIAL_ESCALATION, the recovery execution otherwise).
-- Ordinary FAILED/TIMEOUT/BUDGET_BLOCKED/CANCELLED originals are excluded:
-- they still have their one automated recovery (migration 040/041 worklist).
-- ==========================================================================
create view commercial_v1_review_private.case_candidates as
select 'INITIAL_ESCALATION'::text as case_kind, x.id as case_id, x.id as source_execution_id,
  null::uuid as recovery_execution_id, x.state as case_state, x.reason_code as case_reason_code,
  x.terminal_at as case_opened_at, x.target_kind, x.student_id, x.enrolment_id, x.activation_id,
  x.attempt_id, x.component, x.submission_id, x.practical_id
from public.commercial_v1_examiner_executions x
where x.state='ESCALATED' and x.enrolment_id is not null and x.activation_id is not null
union all
select case when r.state='ESCALATED' then 'RECOVERY_ESCALATION' else 'RECOVERY_EXHAUSTED' end, r.id, r.source_execution_id,
  r.id, r.state, r.reason_code, r.terminal_at, r.target_kind, r.student_id, r.enrolment_id, r.activation_id,
  r.attempt_id, r.component, r.submission_id, r.practical_id
from public.commercial_v1_examiner_recovery_executions r
where r.state in ('ESCALATED','FAILED','TIMEOUT','BUDGET_BLOCKED','CANCELLED')
  and r.enrolment_id is not null and r.activation_id is not null;
revoke all on commercial_v1_review_private.case_candidates from public,anon,authenticated,service_role;

create view commercial_v1_review_private.open_cases as
select c.* from commercial_v1_review_private.case_candidates c
where not (
  (c.target_kind='ASSESSMENT_ATTEMPT' and exists(
    select 1 from public.commercial_v1_assessment_result_revisions rr
    where rr.enrolment_id=c.enrolment_id and rr.component=c.component))
  or (c.target_kind='LAB_SUBMISSION' and exists(
    select 1 from public.commercial_v1_lab_result_revisions rr
    where rr.enrolment_id=c.enrolment_id and rr.practical_id=c.practical_id))
);
revoke all on commercial_v1_review_private.open_cases from public,anon,authenticated,service_role;

create function commercial_v1_review_private.require_reviewer() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return actor;
end $$;

-- Bounded case metadata: labels an operator needs to recognise the case.
-- No response/submission body, answer key, guidance, provider output, MAC,
-- budget, recovery reason text or generic audit JSON.
create function commercial_v1_review_private.case_summary(c commercial_v1_review_private.open_cases) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'caseId',c.case_id,'caseKind',c.case_kind,'caseState',c.case_state,'caseReasonCode',c.case_reason_code,
    'caseOpenedAt',c.case_opened_at,'targetKind',c.target_kind,'component',c.component,
    'targetTitle',coalesce(
      (select a.title from public.assessment_attempts t join public.assessments a on a.id=t.assessment_id where t.id=c.attempt_id),
      (select p.title from public.course_practicals p where p.id=c.practical_id)),
    'programmeTitle',(select coalesce(v.title_snapshot,pr.title) from public.course_activations ca
      join public.programme_versions v on v.id=ca.programme_version_id join public.programmes pr on pr.id=v.programme_id
      where ca.id=c.activation_id),
    'cohortTitle',(select co.title from public.course_activations ca join public.cohorts co on co.id=ca.cohort_id where ca.id=c.activation_id),
    'learnerName',(select u.display_name from public.app_users u where u.id=c.student_id),
    'studentNumber',(select s.student_number from public.student_profiles s where s.user_id=c.student_id),
    'submittedAt',coalesce(
      (select t.submitted_at from public.assessment_attempts t where t.id=c.attempt_id),
      (select s.submitted_at from public.commercial_v1_lab_submissions s where s.id=c.submission_id)))
$$;

-- ==========================================================================
-- Section 3: protected reviewer reads (ACADEMIC_ADMIN / PLATFORM_ADMIN).
-- ==========================================================================
-- A reviewer never sees, reads or grades their own work (a multi-role
-- learner who is also an academic admin): SELF_REVIEW_FORBIDDEN.
create function public.list_commercial_v1_academic_review_cases() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid;
begin
  actor := commercial_v1_review_private.require_reviewer();
  return jsonb_build_object('cases',(
    select coalesce(jsonb_agg(commercial_v1_review_private.case_summary(c) order by c.case_opened_at desc,c.case_id),'[]'::jsonb)
    from (select * from commercial_v1_review_private.open_cases where student_id<>actor
      order by case_opened_at desc,case_id limit 200) c));
end $$;

-- The authoritative context a human needs for one OPEN case: for an
-- assessment, every question of the attempt's assessment with its prompt,
-- authoritative max marks, answer key / marking guidance and the learner's
-- latest response (or none); for a lab, the submission body, authoritative
-- max marks/contribution, grading guidance and mapped objectives.
create function public.get_commercial_v1_academic_review_case(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; c commercial_v1_review_private.open_cases; asm public.assessments; lp public.commercial_v1_lab_policies;
begin
  actor := commercial_v1_review_private.require_reviewer();
  select * into c from commercial_v1_review_private.open_cases where case_id=p_case_id;
  if not found then raise exception 'CASE_NOT_OPEN'; end if;
  if c.student_id=actor then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if c.target_kind='ASSESSMENT_ATTEMPT' then
    select a.* into asm from public.assessments a join public.assessment_attempts t on t.assessment_id=a.id where t.id=c.attempt_id;
    return commercial_v1_review_private.case_summary(c) || jsonb_build_object(
      'assessment',jsonb_build_object(
        'title',asm.title,'instructions',asm.instructions,
        'componentWeightBp',commercial_v1_private.expected_component_weight(c.activation_id,c.component),
        'maxMarksTotal',(select sum(q.max_marks)::integer from public.assessment_questions q where q.assessment_id=asm.id),
        'questions',(select coalesce(jsonb_agg(jsonb_build_object(
            'questionId',q.id,'position',q.position,'prompt',q.prompt,'maxMarks',q.max_marks,
            'expectedAnswer',ak.expected_answer,'markingGuidance',ak.marking_guidance,
            'answered',r.body is not null,'responseBody',r.body) order by q.position),'[]'::jsonb)
          from public.assessment_questions q
          left join public.assessment_answer_keys ak on ak.question_id=q.id
          left join lateral (select ar.body from public.assessment_responses ar
            where ar.attempt_id=c.attempt_id and ar.question_id=q.id order by ar.revision_number desc limit 1) r on true
          where q.assessment_id=asm.id)));
  end if;
  select * into lp from public.commercial_v1_lab_policies where activation_id=c.activation_id and practical_id=c.practical_id;
  return commercial_v1_review_private.case_summary(c) || jsonb_build_object(
    'lab',jsonb_build_object(
      'title',(select p.title from public.course_practicals p where p.id=c.practical_id),
      'instructions',(select p.instructions from public.course_practicals p where p.id=c.practical_id),
      'maxMarks',lp.max_marks,'contributionBp',lp.contribution_bp,'gradingGuidance',lp.grading_guidance,
      'submissionBody',(select s.body from public.commercial_v1_lab_submissions s where s.id=c.submission_id),
      'objectives',(select coalesce(jsonb_agg(jsonb_build_object('description',lo.description) order by lo.position),'[]'::jsonb)
        from public.course_practical_objectives po join public.lesson_objectives lo on lo.id=po.objective_id
        where po.practical_id=c.practical_id)));
end $$;

-- ==========================================================================
-- Section 4: governed manual first-grade writers.
-- ==========================================================================
-- Locks the case's learner and enrolment (regrade's order), then re-checks
-- reviewer authority under those locks. Returns the existing decision id for
-- an already-resolved case (the caller answers idempotently), else NULL; the
-- caller then re-resolves the still-OPEN case under the same locks.
create function commercial_v1_review_private.lock_case(p_case_id uuid,p_target_kind text) returns uuid
language plpgsql security definer set search_path='' as $$
declare candidate commercial_v1_review_private.case_candidates; prior public.commercial_v1_academic_review_decisions;
begin
  select * into candidate from commercial_v1_review_private.case_candidates where case_id=p_case_id;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  perform 1 from public.student_profiles where user_id=candidate.student_id for update;
  perform 1 from public.enrolments where id=candidate.enrolment_id for update;
  if commercial_v1_review_private.require_reviewer()=candidate.student_id then
    raise exception 'SELF_REVIEW_FORBIDDEN';
  end if;
  select * into prior from public.commercial_v1_academic_review_decisions where source_execution_id=candidate.source_execution_id;
  if not found then return null; end if;
  if prior.target_kind<>p_target_kind then raise exception 'TARGET_KIND_MISMATCH'; end if;
  return prior.id;
end $$;

create function commercial_v1_review_private.reason(p_reason text) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_reason is null or length(btrim(p_reason)) not between 5 and 300 then raise exception 'INVALID_REASON'; end if;
  return btrim(p_reason);
end $$;

create function commercial_v1_review_private.record_decision(c commercial_v1_review_private.open_cases,p_actor uuid,
  p_reason text,p_assessment_result uuid,p_lab_result uuid,p_audit jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare decision_id uuid;
begin
  insert into public.commercial_v1_academic_review_decisions(
    actor_id,case_kind,source_execution_id,recovery_execution_id,case_state,case_reason_code,case_opened_at,
    target_kind,student_id,enrolment_id,activation_id,attempt_id,component,submission_id,practical_id,
    assessment_result_revision_id,lab_result_revision_id,result_revision_number,reason
  ) values (
    p_actor,c.case_kind,c.source_execution_id,c.recovery_execution_id,c.case_state,c.case_reason_code,c.case_opened_at,
    c.target_kind,c.student_id,c.enrolment_id,c.activation_id,c.attempt_id,c.component,c.submission_id,c.practical_id,
    p_assessment_result,p_lab_result,1,p_reason
  ) returning id into decision_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(p_actor,'COMMERCIAL_V1_ACADEMIC_REVIEW_FIRST_GRADE','commercial_v1_academic_review_decisions',decision_id,
    'HUMAN_ACADEMIC_REVIEW',p_reason,
    jsonb_build_object('decision_id',decision_id,'decision_kind','MANUAL_FIRST_GRADE','case_kind',c.case_kind,
      'case_state',c.case_state,'source_execution_id',c.source_execution_id,'recovery_execution_id',c.recovery_execution_id,
      'target_kind',c.target_kind,'student_id',c.student_id,'enrolment_id',c.enrolment_id,'activation_id',c.activation_id,
      'attempt_id',c.attempt_id,'component',c.component,'submission_id',c.submission_id,'practical_id',c.practical_id,
      'result_revision_id',coalesce(p_assessment_result,p_lab_result),'revision_number',1) || p_audit);
  return decision_id;
end $$;

create function commercial_v1_review_private.resolved(p_decision_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'code','ALREADY_RESOLVED','decisionId',d.id,
    'resultRevisionId',coalesce(d.assessment_result_revision_id,d.lab_result_revision_id),'revisionNumber',1)
  from public.commercial_v1_academic_review_decisions d where d.id=p_decision_id
$$;

-- p_marks: [{"questionId": uuid, "marksAwarded": integer}, ...] covering
-- EVERY question of the attempt's assessment exactly once. Max marks come
-- only from assessment_questions. An unanswered question must be 0 (the
-- Examiner finalizer's own rule: the deterministic zero for no response).
create function public.submit_commercial_v1_academic_review_assessment_grade(p_case_id uuid,p_marks jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; c commercial_v1_review_private.open_cases; prior_id uuid;
  asm_id uuid; elem jsonb; qid uuid; raw text; mark integer; qmax integer; seen uuid[] := '{}';
  question_count integer; earned integer := 0; max_total integer; weight integer; result_id uuid; decision_id uuid;
begin
  actor := commercial_v1_review_private.require_reviewer();
  why := commercial_v1_review_private.reason(p_reason);
  prior_id := commercial_v1_review_private.lock_case(p_case_id,'ASSESSMENT_ATTEMPT');
  if prior_id is not null then return commercial_v1_review_private.resolved(prior_id); end if;
  select * into c from commercial_v1_review_private.open_cases where case_id=p_case_id;
  if not found then raise exception 'CASE_NOT_OPEN'; end if;
  if c.target_kind<>'ASSESSMENT_ATTEMPT' then raise exception 'TARGET_KIND_MISMATCH'; end if;

  select t.assessment_id into asm_id from public.assessment_attempts t where t.id=c.attempt_id;
  if p_marks is null or jsonb_typeof(p_marks)<>'array' then raise exception 'INVALID_MARKS'; end if;
  for elem in select value from jsonb_array_elements(p_marks) loop
    if jsonb_typeof(elem)<>'object' or (select count(*) from jsonb_object_keys(elem))<>2
      or not (elem ? 'questionId') or not (elem ? 'marksAwarded')
      or jsonb_typeof(elem->'questionId')<>'string' or jsonb_typeof(elem->'marksAwarded')<>'number'
      or (elem->>'questionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_MARKS';
    end if;
    raw := elem->>'marksAwarded';
    if raw ~ '^-[0-9]+$' then raise exception 'MARKS_BELOW_ZERO'; end if;
    if raw !~ '^[0-9]{1,6}$' then raise exception 'INVALID_MARKS'; end if;
    qid := (elem->>'questionId')::uuid;
    mark := raw::integer;
    if qid = any(seen) then raise exception 'DUPLICATE_QUESTION'; end if;
    seen := seen || qid;
    select q.max_marks into qmax from public.assessment_questions q where q.id=qid and q.assessment_id=asm_id;
    if not found then raise exception 'FOREIGN_QUESTION'; end if;
    if mark>qmax then raise exception 'MARKS_EXCEED_MAX'; end if;
    if mark>0 and not exists(select 1 from public.assessment_responses where attempt_id=c.attempt_id and question_id=qid) then
      raise exception 'UNANSWERED_QUESTION_GRADED';
    end if;
    earned := earned+mark;
  end loop;
  select count(*)::integer,sum(q.max_marks)::integer into question_count,max_total
    from public.assessment_questions q where q.assessment_id=asm_id;
  if coalesce(array_length(seen,1),0)<>question_count then raise exception 'INCOMPLETE_QUESTION_MARKS'; end if;
  weight := commercial_v1_private.expected_component_weight(c.activation_id,c.component);

  insert into public.commercial_v1_assessment_result_revisions(
    activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
    earned_marks_total,max_marks_total,component_weight_bp
  ) values (c.activation_id,c.enrolment_id,c.student_id,c.component,c.attempt_id,asm_id,1,earned,max_total,weight)
  returning id into result_id;
  insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot)
  select result_id,q.id,
    (select (x->>'marksAwarded')::integer from jsonb_array_elements(p_marks) x where (x->>'questionId')::uuid=q.id),q.max_marks
  from public.assessment_questions q where q.assessment_id=asm_id;
  perform commercial_v1_private.derive_and_insert_objective_outcomes(result_id);
  if not commercial_v1_private.assessment_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;

  decision_id := commercial_v1_review_private.record_decision(c,actor,why,result_id,null,
    jsonb_build_object('earned_marks_total',earned,'max_marks_total',max_total,'component_weight_bp',weight));
  return jsonb_build_object('ok',true,'code','RESULT_CREATED','decisionId',decision_id,'resultRevisionId',result_id,
    'revisionNumber',1,'earnedMarks',earned,'maxMarks',max_total);
end $$;

-- p_marks_awarded: the single human lab mark. Max marks and contribution come
-- only from the activation's published lab policy.
create function public.submit_commercial_v1_academic_review_lab_grade(p_case_id uuid,p_marks_awarded integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; c commercial_v1_review_private.open_cases; prior_id uuid;
  lp public.commercial_v1_lab_policies; result_id uuid; decision_id uuid;
begin
  actor := commercial_v1_review_private.require_reviewer();
  why := commercial_v1_review_private.reason(p_reason);
  prior_id := commercial_v1_review_private.lock_case(p_case_id,'LAB_SUBMISSION');
  if prior_id is not null then return commercial_v1_review_private.resolved(prior_id); end if;
  select * into c from commercial_v1_review_private.open_cases where case_id=p_case_id;
  if not found then raise exception 'CASE_NOT_OPEN'; end if;
  if c.target_kind<>'LAB_SUBMISSION' then raise exception 'TARGET_KIND_MISMATCH'; end if;

  if p_marks_awarded is null then raise exception 'INVALID_MARKS'; end if;
  if p_marks_awarded<0 then raise exception 'MARKS_BELOW_ZERO'; end if;
  select * into lp from public.commercial_v1_lab_policies where activation_id=c.activation_id and practical_id=c.practical_id;
  if not found then raise exception 'LAB_POLICY_REQUIRED'; end if;
  if p_marks_awarded>lp.max_marks then raise exception 'MARKS_EXCEED_MAX'; end if;

  insert into public.commercial_v1_lab_result_revisions(
    activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
  ) values (c.activation_id,c.enrolment_id,c.student_id,c.practical_id,c.submission_id,1,p_marks_awarded,lp.max_marks,lp.contribution_bp)
  returning id into result_id;
  perform commercial_v1_private.derive_and_insert_lab_objective_outcomes(result_id);
  if not commercial_v1_private.lab_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;

  decision_id := commercial_v1_review_private.record_decision(c,actor,why,null,result_id,
    jsonb_build_object('earned_marks',p_marks_awarded,'max_marks',lp.max_marks,'contribution_bp',lp.contribution_bp));
  return jsonb_build_object('ok',true,'code','RESULT_CREATED','decisionId',decision_id,'resultRevisionId',result_id,
    'revisionNumber',1,'earnedMarks',p_marks_awarded,'maxMarks',lp.max_marks);
end $$;

-- ==========================================================================
-- Section 5: recovery worklist status truth. Identical to migration 041's
-- view except one added status: a recovery claim whose target was later
-- given its first result by human academic review reads
-- RESOLVED_BY_ACADEMIC_REVIEW instead of still claiming to be stranded. The
-- immutable recovery execution itself is untouched.
-- ==========================================================================
create or replace view commercial_v1_recovery_private.stranded_targets as
select
  x.id as source_execution_id, x.target_kind, x.capability,
  x.student_id, x.enrolment_id, x.activation_id, x.component, x.practical_id,
  x.state as original_state, x.reason_code as original_reason_code, x.terminal_at,
  r.id as recovery_execution_id, r.state as recovery_state,
  case
    when r.id is null then 'ELIGIBLE'
    when r.state in ('AUTHORIZED','RUNNING') then 'RECOVERY_IN_PROGRESS'
    when r.state='SUCCEEDED' then 'RECOVERED'
    when exists(select 1 from public.commercial_v1_academic_review_decisions d where d.recovery_execution_id=r.id)
      then 'RESOLVED_BY_ACADEMIC_REVIEW'
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

-- ==========================================================================
-- Section 6: ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare columns text; begin
  select string_agg(quote_ident(attname),', ' order by attnum) into columns from pg_attribute
    where attrelid='public.commercial_v1_academic_review_decisions'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.commercial_v1_academic_review_decisions from public, anon, authenticated, service_role',
    columns,columns,columns,columns);
end $$;

do $$ declare f record; r text; public_fns text[] := array[
  'list_commercial_v1_academic_review_cases','get_commercial_v1_academic_review_case',
  'submit_commercial_v1_academic_review_assessment_grade','submit_commercial_v1_academic_review_lab_grade'];
begin
  for f in select p.oid::regprocedure as sig,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='commercial_v1_review_private' or (n.nspname='public' and p.proname=any(public_fns)) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.sig);
    if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.sig); end if;
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(r,'public.commercial_v1_academic_review_decisions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r,'public.commercial_v1_academic_review_decisions','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe academic review decision privileges for %',r;
    end if;
    if has_schema_privilege(r,'commercial_v1_review_private','USAGE,CREATE') then
      raise exception 'Unsafe academic review schema privileges for %',r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commercial_v1_review_private' or (n.nspname='public' and p.proname=any(public_fns)) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then
        raise exception 'Unsafe academic review function privileges for % on %',r,f.proname;
      end if;
    end loop;
  end loop;
end $$;
