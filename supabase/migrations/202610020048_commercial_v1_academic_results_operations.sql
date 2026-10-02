-- Commercial V1 academic results operations: bounded, READ-ONLY admin
-- projections over the existing result model. Forward-only; migrations
-- 001-047 are not modified.
--
-- What this adds:
--   * list_commercial_v1_academic_results: bounded, server-filtered discovery
--     of assessment and lab result revisions (50 per page, offset <= 100000);
--   * get_commercial_v1_academic_result: one revision's operator detail --
--     marks, weight, contribution, objective outcomes, revision history and
--     provenance (initial Examiner, recovery, regrade, human academic review);
--   * get_commercial_v1_academic_enrolment_record: the enrolment's governed
--     state and completion receipt (progress itself stays the existing
--     get_commercial_v1_course_progress authority);
--   * get_commercial_v1_academic_results_filters: bounded filter options;
--   * partial indexes on the existing result_revision_id provenance columns.
--
-- What this deliberately does NOT add: any result write, delete, update,
-- void or correction authority. Result revisions stay append-only. The
-- current result of a target is its highest revision when that revision is
-- valid (migration 030's current_assessment_result/current_lab_result); an
-- invalid highest revision makes the target PENDING, it never falls back to
-- an earlier revision. Excluding ("voiding") a current revision would
-- therefore turn a graded target into an ungraded one that no authority can
-- fill (human review needs a result-free escalated case, regrade a current
-- valid result, recovery a terminal original). Correction of a judged grade
-- remains the existing regrade authority (migration 032), which appends the
-- next revision; this migration only makes that history visible.
--
-- Authority: ACADEMIC_ADMIN or PLATFORM_ADMIN only (REGISTRAR, INSTRUCTOR,
-- COUNSELLOR and STUDENT are refused). As in migration 047, an operator never
-- operates on their own academic record: a learner who is also an admin does
-- not see their own results here (SELF_RECORD_FORBIDDEN), and a new insert
-- guard refuses a regrade execution whose actor is the learner
-- (SELF_REGRADE_FORBIDDEN) -- a tightening of migration 032, not a new
-- regrade authority. Reads never return answer keys,
-- marking guidance, question prompts, learner response or lab submission
-- bodies, provider output, grade digests, MACs, budgets or audit JSON.
create schema commercial_v1_results_ops_private;
revoke all on schema commercial_v1_results_ops_private from public,anon,authenticated,service_role;

create index commercial_v1_examiner_executions_result_revision
  on public.commercial_v1_examiner_executions(result_revision_id) where result_revision_id is not null;
create index commercial_v1_examiner_recovery_executions_result_revision
  on public.commercial_v1_examiner_recovery_executions(result_revision_id) where result_revision_id is not null;
create index commercial_v1_examiner_regrade_executions_result_revision
  on public.commercial_v1_examiner_regrade_executions(result_revision_id) where result_revision_id is not null;

-- Self-regrade guard on the existing regrade execution table (migration 032
-- admitted any academic admin, including the learner themselves).
create function commercial_v1_results_ops_private.guard_regrade_actor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if NEW.actor_id=NEW.student_id then raise exception 'SELF_REGRADE_FORBIDDEN' using errcode='42501'; end if;
  return NEW;
end $$;
create trigger guard_examiner_regrade_actor before insert on public.commercial_v1_examiner_regrade_executions
  for each row execute function commercial_v1_results_ops_private.guard_regrade_actor();

create function commercial_v1_results_ops_private.require_results_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return actor;
end $$;

-- One row per result revision of either kind. is_current follows migration
-- 030 exactly: the highest revision of its target (validity is separate).
create view commercial_v1_results_ops_private.result_revisions as
select 'ASSESSMENT'::text as kind, r.id, r.activation_id, r.enrolment_id, r.student_id, r.component,
  null::uuid as practical_id, r.attempt_id, r.assessment_id, null::uuid as submission_id, r.revision_number,
  r.earned_marks_total as earned_marks, r.max_marks_total as max_marks, r.score_bp,
  r.component_weight_bp as weight_bp, r.weighted_contribution_bp, r.finalized_at,
  r.revision_number=(select max(x.revision_number) from public.commercial_v1_assessment_result_revisions x
    where x.enrolment_id=r.enrolment_id and x.component=r.component) as is_current
from public.commercial_v1_assessment_result_revisions r
union all
select 'LAB', l.id, l.activation_id, l.enrolment_id, l.student_id, null::text, l.practical_id, null::uuid, null::uuid,
  l.submission_id, l.revision_number, l.earned_marks, l.max_marks, null::integer, l.contribution_bp,
  l.weighted_contribution_bp, l.finalized_at,
  l.revision_number=(select max(x.revision_number) from public.commercial_v1_lab_result_revisions x
    where x.enrolment_id=l.enrolment_id and x.practical_id=l.practical_id)
from public.commercial_v1_lab_result_revisions l;
revoke all on commercial_v1_results_ops_private.result_revisions from public,anon,authenticated,service_role;

create function commercial_v1_results_ops_private.is_valid(p_kind text,p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select case when p_kind='ASSESSMENT' then commercial_v1_private.assessment_result_is_valid(p_id)
              else commercial_v1_private.lab_result_is_valid(p_id) end
$$;

-- Which governed authority produced a revision. The execution tables store
-- result_revision_id without a foreign key, so the target kind is matched too.
create function commercial_v1_results_ops_private.origin(p_kind text,p_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select case
    when exists(select 1 from public.commercial_v1_academic_review_decisions d
      where (p_kind='ASSESSMENT' and d.assessment_result_revision_id=p_id) or (p_kind='LAB' and d.lab_result_revision_id=p_id))
      then 'HUMAN_ACADEMIC_REVIEW'
    when exists(select 1 from public.commercial_v1_examiner_regrade_executions g where g.result_revision_id=p_id
      and g.target_kind=case when p_kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end)
      then 'EXAMINER_REGRADE'
    when exists(select 1 from public.commercial_v1_examiner_recovery_executions v where v.result_revision_id=p_id
      and v.target_kind=case when p_kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end)
      then 'EXAMINER_RECOVERY'
    when exists(select 1 from public.commercial_v1_examiner_executions x where x.result_revision_id=p_id
      and x.target_kind=case when p_kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end)
      then 'EXAMINER_INITIAL'
    else 'UNATTRIBUTED'
  end
$$;

-- Bounded row: labels, marks and state only.
create function commercial_v1_results_ops_private.summary(r commercial_v1_results_ops_private.result_revisions) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'resultId',r.id,'kind',r.kind,'revisionNumber',r.revision_number,'isCurrent',r.is_current,
    'isValid',commercial_v1_results_ops_private.is_valid(r.kind,r.id),
    'origin',commercial_v1_results_ops_private.origin(r.kind,r.id),
    'earnedMarks',r.earned_marks,'maxMarks',r.max_marks,'scoreBp',r.score_bp,'weightBp',r.weight_bp,
    'weightedContributionBp',r.weighted_contribution_bp,'finalizedAt',r.finalized_at,
    'component',r.component,'practicalId',r.practical_id,
    'targetTitle',coalesce(
      (select a.title from public.assessments a where a.id=r.assessment_id),
      (select p.title from public.course_practicals p where p.id=r.practical_id)),
    'enrolmentId',r.enrolment_id,'enrolmentStatus',e.status,
    'completed',exists(select 1 from public.commercial_v1_completion_receipts cr where cr.enrolment_id=r.enrolment_id),
    'learnerName',u.display_name,'studentNumber',s.student_number,
    'cohortTitle',c.title,'programmeTitle',coalesce(pv.title_snapshot,pr.title),'versionLabel',pv.label)
  from public.enrolments e
  left join public.app_users u on u.id=e.student_id
  left join public.student_profiles s on s.user_id=e.student_id
  left join public.cohorts c on c.id=e.cohort_id
  left join public.programme_versions pv on pv.id=e.programme_version_id
  left join public.programmes pr on pr.id=pv.programme_id
  where e.id=r.enrolment_id
$$;

create function public.list_commercial_v1_academic_results(
  p_query text default null,p_kind text default null,p_cohort_id uuid default null,
  p_programme_version_id uuid default null,p_component text default null,p_practical_id uuid default null,
  p_current_only boolean default true,p_completion text default null,p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; q text; page jsonb;
begin
  actor := commercial_v1_results_ops_private.require_results_admin();
  q := nullif(btrim(coalesce(p_query,'')),'');
  if (q is not null and length(q)>100)
    or (p_kind is not null and p_kind not in ('ASSESSMENT','LAB'))
    or (p_component is not null and p_component not in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL'))
    or (p_completion is not null and p_completion not in ('COMPLETED','NOT_COMPLETED'))
    or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'INVALID_INPUT';
  end if;
  select coalesce(jsonb_agg(commercial_v1_results_ops_private.summary(p.r) order by (p.r).finalized_at desc,(p.r).id),'[]'::jsonb)
  into page
  from (
    select r from commercial_v1_results_ops_private.result_revisions r
    join public.enrolments e on e.id=r.enrolment_id
    left join public.app_users u on u.id=e.student_id
    left join public.student_profiles s on s.user_id=e.student_id
    where r.student_id<>actor
      and (p_kind is null or r.kind=p_kind)
      and (p_cohort_id is null or e.cohort_id=p_cohort_id)
      and (p_programme_version_id is null or e.programme_version_id=p_programme_version_id)
      and (p_component is null or r.component=p_component)
      and (p_practical_id is null or r.practical_id=p_practical_id)
      and (not coalesce(p_current_only,true) or r.is_current)
      and (p_completion is null or (p_completion='COMPLETED')=exists(
        select 1 from public.commercial_v1_completion_receipts cr where cr.enrolment_id=e.id))
      and (q is null or position(lower(q) in lower(coalesce(u.display_name,'')))>0
        or position(lower(q) in lower(coalesce(s.student_number,'')))>0)
    order by r.finalized_at desc,r.id
    limit 51 offset p_offset
  ) p;
  return jsonb_build_object(
    'results',(select coalesce(jsonb_agg(x),'[]'::jsonb) from (
      select x from jsonb_array_elements(page) with ordinality as t(x,n) where n<=50 order by n) y),
    'hasMore',jsonb_array_length(page)>50,'offset',p_offset);
end $$;

create function public.get_commercial_v1_academic_results_filters() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform commercial_v1_results_ops_private.require_results_admin();
  return jsonb_build_object(
    'cohorts',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title) order by c.starts_on desc,c.id),'[]'::jsonb)
      from (select c.* from public.cohorts c where exists(select 1 from public.course_activations a where a.cohort_id=c.id)
        order by c.starts_on desc,c.id limit 200) c),
    'programmeVersions',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'title',v.title,'label',v.label) order by v.title,v.label,v.id),'[]'::jsonb)
      from (select pv.id,coalesce(pv.title_snapshot,pr.title) title,pv.label from public.programme_versions pv
        join public.programmes pr on pr.id=pv.programme_id
        where exists(select 1 from public.course_activations a where a.programme_version_id=pv.id)
        order by 2,pv.label,pv.id limit 200) v),
    'practicals',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title) order by p.title,p.id),'[]'::jsonb)
      from (select distinct p.id,p.title from public.course_practicals p
        join public.commercial_v1_lab_policies lp on lp.practical_id=p.id
        order by p.title,p.id limit 200) p));
end $$;

create function public.get_commercial_v1_academic_result(p_result_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; r commercial_v1_results_ops_private.result_revisions; detail jsonb; provenance jsonb;
  history jsonb; history_has_more boolean; regrade_claim jsonb;
  v_target_kind text;
begin
  actor := commercial_v1_results_ops_private.require_results_admin();
  select * into r from commercial_v1_results_ops_private.result_revisions where id=p_result_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if r.student_id=actor then raise exception 'SELF_RECORD_FORBIDDEN'; end if;
  v_target_kind := case when r.kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end;

  -- Provenance: the producing claim/decision and, where the repository holds
  -- it, the institutional actor, bounded reason and source revision.
  select coalesce(
    (select jsonb_build_object('origin','HUMAN_ACADEMIC_REVIEW','decisionId',d.id,'caseKind',d.case_kind,
        'actorName',(select u.display_name from public.app_users u where u.id=d.actor_id),'reason',d.reason,'decidedAt',d.decided_at)
      from public.commercial_v1_academic_review_decisions d
      where (r.kind='ASSESSMENT' and d.assessment_result_revision_id=r.id) or (r.kind='LAB' and d.lab_result_revision_id=r.id)),
    (select jsonb_build_object('origin','EXAMINER_REGRADE','executionId',g.id,'sourceResultRevisionId',g.source_result_revision_id,
        'sourceRevisionNumber',g.source_revision_number,
        'actorName',(select u.display_name from public.app_users u where u.id=g.actor_id),'reason',g.request_reason,'decidedAt',g.terminal_at)
      from public.commercial_v1_examiner_regrade_executions g
      where g.result_revision_id=r.id and g.target_kind=case when r.kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end),
    (select jsonb_build_object('origin','EXAMINER_RECOVERY','executionId',v.id,'sourceExecutionId',v.source_execution_id,
        'actorName',(select u.display_name from public.app_users u where u.id=v.actor_id),'reason',v.recovery_reason,'decidedAt',v.terminal_at)
      from public.commercial_v1_examiner_recovery_executions v
      where v.result_revision_id=r.id and v.target_kind=case when r.kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end),
    (select jsonb_build_object('origin','EXAMINER_INITIAL','executionId',x.id,'decidedAt',x.terminal_at)
      from public.commercial_v1_examiner_executions x
      where x.result_revision_id=r.id and x.target_kind=case when r.kind='ASSESSMENT' then 'ASSESSMENT_ATTEMPT' else 'LAB_SUBMISSION' end),
    jsonb_build_object('origin','UNATTRIBUTED')) into provenance;

  -- Revision history READ bound: the newest 100 revisions of the target
  -- (always including the current one), in ascending order, plus
  -- historyHasMore. This bounds the response only -- legitimate revisions
  -- beyond it still exist, unchanged, and are listed by the paginated
  -- all-revisions listing. The selected revision itself is always returned
  -- above, even when it is older than this window.
  select coalesce(jsonb_agg(jsonb_build_object(
      'resultId',w.id,'revisionNumber',w.revision_number,'isCurrent',w.is_current,
      'isValid',commercial_v1_results_ops_private.is_valid(w.kind,w.id),
      'origin',commercial_v1_results_ops_private.origin(w.kind,w.id),
      'earnedMarks',w.earned_marks,'maxMarks',w.max_marks,'scoreBp',w.score_bp,
      'weightedContributionBp',w.weighted_contribution_bp,'finalizedAt',w.finalized_at)
      order by w.revision_number) filter (where w.n<=100),'[]'::jsonb),
    coalesce(bool_or(w.n>100),false)
  into history,history_has_more
  from (
    select h.*,row_number() over (order by h.revision_number desc) as n
    from commercial_v1_results_ops_private.result_revisions h
    where h.kind=r.kind and h.enrolment_id=r.enrolment_id
      and h.component is not distinct from r.component and h.practical_id is not distinct from r.practical_id
    order by h.revision_number desc
    limit 101
  ) w;

  -- The existing OUTGOING regrade claim for this revision (migration 032
  -- admits at most one per source revision and target kind). Bounded
  -- operational metadata only: no digest, MAC, budget, usage, review path or
  -- protected context. An AUTHORIZED/RUNNING claim past its expiry is
  -- reported as expired; the regrade authority records it as TIMEOUT on its
  -- next check, and the claim still occupies this source revision.
  select jsonb_build_object('executionId',g.id,'state',g.state,'reasonCode',g.reason_code,
      'requestReason',g.request_reason,
      'actorName',(select u.display_name from public.app_users u where u.id=g.actor_id),
      'createdAt',g.created_at,'terminalAt',g.terminal_at,'producedResultRevisionId',g.result_revision_id,
      'expired',g.state in ('AUTHORIZED','RUNNING') and g.expires_at<=now())
  into regrade_claim
  from public.commercial_v1_examiner_regrade_executions g
  where g.source_result_revision_id=r.id and g.target_kind=v_target_kind;

  detail := commercial_v1_results_ops_private.summary(r) || jsonb_build_object(
    'activationId',r.activation_id,'provenance',provenance,
    'history',history,'historyHasMore',history_has_more,'historyLimit',100,
    'regradeClaim',coalesce(regrade_claim,'null'::jsonb));

  if r.kind='ASSESSMENT' then
    return detail || jsonb_build_object(
      'assessmentId',r.assessment_id,'attemptId',r.attempt_id,
      'attemptSubmittedAt',(select t.submitted_at from public.assessment_attempts t where t.id=r.attempt_id),
      'questionMarks',(select coalesce(jsonb_agg(jsonb_build_object(
          'questionId',m.question_id,'position',q.position,'marksAwarded',m.marks_awarded,'maxMarks',m.max_marks_snapshot)
          order by q.position),'[]'::jsonb)
        from public.commercial_v1_assessment_question_marks m join public.assessment_questions q on q.id=m.question_id
        where m.result_revision_id=r.id),
      'objectiveOutcomes',(select coalesce(jsonb_agg(jsonb_build_object(
          'objectiveId',o.objective_id,'description',lo.description,'earnedMarks',o.earned_marks,'maxMarks',o.max_marks,
          'outcome',o.outcome,'remediationOpen',exists(select 1 from public.commercial_v1_remediation_items ri
            where ri.enrolment_id=r.enrolment_id and ri.objective_id=o.objective_id and ri.state='OPEN'))
          order by lo.position,o.objective_id),'[]'::jsonb)
        from public.commercial_v1_assessment_objective_outcomes o join public.lesson_objectives lo on lo.id=o.objective_id
        where o.result_revision_id=r.id));
  end if;
  return detail || jsonb_build_object(
    'submissionId',r.submission_id,
    'submissionSubmittedAt',(select s.submitted_at from public.commercial_v1_lab_submissions s where s.id=r.submission_id),
    'objectiveOutcomes',(select coalesce(jsonb_agg(jsonb_build_object(
        'objectiveId',o.objective_id,'description',lo.description,'earnedMarks',o.earned_marks,'maxMarks',o.max_marks,
        'outcome',o.outcome,'remediationOpen',exists(select 1 from public.commercial_v1_remediation_items ri
          where ri.enrolment_id=r.enrolment_id and ri.objective_id=o.objective_id and ri.state='OPEN'))
        order by lo.position,o.objective_id),'[]'::jsonb)
      from public.commercial_v1_lab_objective_outcomes o join public.lesson_objectives lo on lo.id=o.objective_id
      where o.result_revision_id=r.id));
end $$;

-- The enrolment's governed academic state and completion receipt. Course
-- progress (scores, weights, pending components, remediation, pass mark) is
-- the existing get_commercial_v1_course_progress authority, never recomputed.
create function public.get_commercial_v1_academic_enrolment_record(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; e public.enrolments;
begin
  actor := commercial_v1_results_ops_private.require_results_admin();
  select * into e from public.enrolments where id=p_enrolment_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if e.student_id=actor then raise exception 'SELF_RECORD_FORBIDDEN'; end if;
  return jsonb_build_object(
    'enrolmentId',e.id,'enrolmentStatus',e.status,
    'learnerName',(select u.display_name from public.app_users u where u.id=e.student_id),
    'studentNumber',(select s.student_number from public.student_profiles s where s.user_id=e.student_id),
    'cohortTitle',(select c.title from public.cohorts c where c.id=e.cohort_id),
    'programmeTitle',(select coalesce(pv.title_snapshot,pr.title) from public.programme_versions pv
      join public.programmes pr on pr.id=pv.programme_id where pv.id=e.programme_version_id),
    'versionLabel',(select pv.label from public.programme_versions pv where pv.id=e.programme_version_id),
    'receipt',(select jsonb_build_object('receiptId',cr.id,'finalCourseScoreBp',cr.final_course_score_bp,
        'passMarkBp',cr.pass_mark_bp,'completedAt',cr.completed_at,
        'completedByName',(select u.display_name from public.app_users u where u.id=cr.completed_by))
      from public.commercial_v1_completion_receipts cr where cr.enrolment_id=e.id));
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f record; r text; public_fns text[] := array[
  'list_commercial_v1_academic_results','get_commercial_v1_academic_results_filters',
  'get_commercial_v1_academic_result','get_commercial_v1_academic_enrolment_record'];
begin
  for f in select p.oid::regprocedure as sig,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='commercial_v1_results_ops_private' or (n.nspname='public' and p.proname=any(public_fns)) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.sig);
    if f.nspname='public' then execute format('grant execute on function %s to authenticated',f.sig); end if;
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r,'commercial_v1_results_ops_private','USAGE,CREATE') then
      raise exception 'Unsafe academic results schema privileges for %',r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='commercial_v1_results_ops_private' or (n.nspname='public' and p.proname=any(public_fns)) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then
        raise exception 'Unsafe academic results function privileges for % on %',r,f.proname;
      end if;
    end loop;
  end loop;
end $$;
