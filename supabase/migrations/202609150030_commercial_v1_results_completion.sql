-- Commercial V1 PR11 pass 11A: deterministic results, lab policy/submission,
-- objective outcomes, remediation and course completion. Additive only;
-- migrations 001-029 are byte-for-byte unchanged.
--
-- Explicitly NOT implemented here: provider-backed Examiner execution, AI
-- grading, leaderboards. No public RPC writes result revisions in 11A --
-- trusted finalization is 11B, cryptographically/controller-bound to
-- Examiner execution (see docs/24-commercial-v1-results-completion.md).
-- Tests seed result/objective-outcome rows with database-owner fixture
-- authority to exercise deterministic projection/completion logic only.

-- ==========================================================================
-- Section 1: per-lab weighting. Never inferred equal-weighted -- an explicit
-- admin-configured row per legitimate PRACTICAL_LAB, mutable only until the
-- result policy for the owning activation is published.
-- ==========================================================================
create table public.commercial_v1_lab_policies (
  activation_id uuid not null references public.course_activations(id),
  practical_id uuid not null references public.course_practicals(id),
  max_marks integer not null check(max_marks between 1 and 100),
  contribution_bp integer not null check(contribution_bp between 0 and 2000),
  grading_guidance text check(grading_guidance is null or length(trim(grading_guidance)) between 1 and 4000),
  configured_by uuid not null references public.app_users(id),
  configured_at timestamptz not null default clock_timestamp(),
  primary key(activation_id,practical_id),
  check(contribution_bp=0 or grading_guidance is not null)
);

create function commercial_v1_private.guard_lab_policy() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial V1 lab policies cannot be deleted'; end if;
  if NEW.activation_id<>OLD.activation_id or NEW.practical_id<>OLD.practical_id then
    raise exception 'Commercial V1 lab policy identity is immutable';
  end if;
  if exists(select 1 from public.commercial_v1_result_policies where activation_id=OLD.activation_id) then
    raise exception 'Commercial V1 lab policies are immutable once the result policy is published';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.guard_lab_policy() from public;
-- Attached after commercial_v1_result_policies exists, below.

-- ==========================================================================
-- Section 2: the immutable Commercial V1 result policy. Requires the PR10
-- grading policy to already exist for this activation. No universal pass
-- mark -- pass_mark_bp is explicit, bounded, institution-supplied input.
-- ==========================================================================
create table public.commercial_v1_result_policies (
  activation_id uuid primary key references public.course_activations(id),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  policy_version text not null default 'COMMERCIAL_V1_RESULTS_V1' check(policy_version='COMMERCIAL_V1_RESULTS_V1'),
  pass_mark_bp integer not null check(pass_mark_bp between 1 and 10000),
  require_remediation_clear_for_completion boolean not null,
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp()
);
create trigger guard_lab_policy
before update or delete on public.commercial_v1_lab_policies
for each row execute function commercial_v1_private.guard_lab_policy();
create trigger result_policy_immutable
before update or delete on public.commercial_v1_result_policies
for each row execute function commercial_v1_private.immutable();

-- ==========================================================================
-- Section 3: learner-owned final Commercial V1 lab submission. Text only,
-- one final per enrolment+practical, idempotent replay, never graded here.
-- ==========================================================================
create table public.commercial_v1_lab_submissions (
  id uuid primary key default gen_random_uuid(),
  activation_id uuid not null references public.course_activations(id),
  practical_id uuid not null references public.course_practicals(id),
  enrolment_id uuid not null,
  student_id uuid not null,
  body text not null check(length(trim(body)) between 1 and 20000),
  idempotency_key text not null unique check(length(trim(idempotency_key)) between 8 and 200),
  submitted_at timestamptz not null default clock_timestamp(),
  unique(enrolment_id,practical_id)
);
create function commercial_v1_private.append_only() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'This Commercial V1 institutional record is append-only'; end $$;
revoke all on function commercial_v1_private.append_only() from public;
create trigger lab_submission_append_only
before update or delete on public.commercial_v1_lab_submissions
for each row execute function commercial_v1_private.append_only();

-- ==========================================================================
-- Section 4: append-only, revision-ready result storage. No public writer
-- RPC in 11A -- see the file header. Score arithmetic is a PostgreSQL
-- GENERATED column (round-half-up NUMERIC arithmetic), never JS floating
-- point, never independently recomputable by a careless future writer.
-- ==========================================================================
create table public.commercial_v1_assessment_result_revisions (
  id uuid primary key default gen_random_uuid(),
  activation_id uuid not null references public.course_activations(id),
  enrolment_id uuid not null,
  student_id uuid not null,
  component text not null check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  attempt_id uuid not null references public.assessment_attempts(id),
  assessment_id uuid not null references public.assessments(id),
  revision_number integer not null check(revision_number>0),
  earned_marks_total integer not null check(earned_marks_total>=0),
  max_marks_total integer not null check(max_marks_total>0),
  component_weight_bp integer not null check(component_weight_bp>=0),
  score_bp integer generated always as (round(earned_marks_total::numeric*10000/max_marks_total)::integer) stored,
  weighted_contribution_bp integer generated always as (round(earned_marks_total::numeric*component_weight_bp/max_marks_total)::integer) stored,
  provenance text not null default 'COMMERCIAL_V1_RESULTS_V1' check(provenance='COMMERCIAL_V1_RESULTS_V1'),
  finalized_at timestamptz not null default clock_timestamp(),
  unique(enrolment_id,component,revision_number),
  check(earned_marks_total<=max_marks_total)
);
create trigger assessment_result_append_only
before update or delete on public.commercial_v1_assessment_result_revisions
for each row execute function commercial_v1_private.append_only();

create table public.commercial_v1_assessment_question_marks (
  result_revision_id uuid not null references public.commercial_v1_assessment_result_revisions(id),
  question_id uuid not null references public.assessment_questions(id),
  marks_awarded integer not null check(marks_awarded>=0),
  max_marks_snapshot integer not null check(max_marks_snapshot>0),
  primary key(result_revision_id,question_id),
  check(marks_awarded<=max_marks_snapshot)
);
create trigger assessment_question_marks_append_only
before update or delete on public.commercial_v1_assessment_question_marks
for each row execute function commercial_v1_private.append_only();

-- The outcome classification itself is a DB-enforced CHECK, not a value any
-- writer (including the derivation helper below) can get wrong:
-- earned=0 => INCORRECT; earned=max => CORRECT; otherwise => PARTIAL.
create table public.commercial_v1_assessment_objective_outcomes (
  result_revision_id uuid not null references public.commercial_v1_assessment_result_revisions(id),
  objective_id uuid not null,
  earned_marks integer not null check(earned_marks>=0),
  max_marks integer not null check(max_marks>0),
  outcome text not null check(outcome in ('CORRECT','PARTIAL','INCORRECT')),
  primary key(result_revision_id,objective_id),
  check(earned_marks<=max_marks),
  check(
    (earned_marks=0 and outcome='INCORRECT')
    or (earned_marks=max_marks and outcome='CORRECT')
    or (earned_marks>0 and earned_marks<max_marks and outcome='PARTIAL')
  )
);
create trigger assessment_objective_outcomes_append_only
before update or delete on public.commercial_v1_assessment_objective_outcomes
for each row execute function commercial_v1_private.append_only();

create table public.commercial_v1_lab_result_revisions (
  id uuid primary key default gen_random_uuid(),
  activation_id uuid not null references public.course_activations(id),
  enrolment_id uuid not null,
  student_id uuid not null,
  practical_id uuid not null references public.course_practicals(id),
  submission_id uuid not null references public.commercial_v1_lab_submissions(id),
  revision_number integer not null check(revision_number>0),
  earned_marks integer not null check(earned_marks>=0),
  max_marks integer not null check(max_marks>0),
  contribution_bp integer not null check(contribution_bp>=0),
  weighted_contribution_bp integer generated always as (round(earned_marks::numeric*contribution_bp/max_marks)::integer) stored,
  provenance text not null default 'COMMERCIAL_V1_RESULTS_V1' check(provenance='COMMERCIAL_V1_RESULTS_V1'),
  finalized_at timestamptz not null default clock_timestamp(),
  unique(enrolment_id,practical_id,revision_number),
  check(earned_marks<=max_marks)
);
create trigger lab_result_append_only
before update or delete on public.commercial_v1_lab_result_revisions
for each row execute function commercial_v1_private.append_only();

create table public.commercial_v1_lab_objective_outcomes (
  result_revision_id uuid not null references public.commercial_v1_lab_result_revisions(id),
  objective_id uuid not null,
  earned_marks integer not null check(earned_marks>=0),
  max_marks integer not null check(max_marks>0),
  outcome text not null check(outcome in ('CORRECT','PARTIAL','INCORRECT')),
  primary key(result_revision_id,objective_id),
  check(earned_marks<=max_marks),
  check(
    (earned_marks=0 and outcome='INCORRECT')
    or (earned_marks=max_marks and outcome='CORRECT')
    or (earned_marks>0 and earned_marks<max_marks and outcome='PARTIAL')
  )
);
create trigger lab_objective_outcomes_append_only
before update or delete on public.commercial_v1_lab_objective_outcomes
for each row execute function commercial_v1_private.append_only();

-- Static insert guards and current-result validators. 11A deliberately
-- exposes no public result writer, but the institutional substrate itself must
-- fail closed so 11B cannot accidentally finalize inconsistent source data.
create function commercial_v1_private.expected_component_weight(p_activation_id uuid,p_component text) returns integer
language sql stable set search_path='' as $$
  select case p_component
    when 'QUIZ_1' then gp.quiz_1_weight_bp when 'QUIZ_2' then gp.quiz_2_weight_bp
    when 'MIDTERM' then gp.midterm_weight_bp when 'QUIZ_3' then gp.quiz_3_weight_bp
    when 'QUIZ_4' then gp.quiz_4_weight_bp when 'FINAL' then gp.final_weight_bp
  end
  from public.commercial_v1_grading_policies gp where gp.activation_id=p_activation_id
$$;
revoke all on function commercial_v1_private.expected_component_weight(uuid,text) from public;

create function commercial_v1_private.guard_assessment_result_insert() returns trigger
language plpgsql set search_path='' as $$
declare e public.enrolments%rowtype; expected_weight integer; expected_max integer;
begin
  select * into e from public.enrolments where id=NEW.enrolment_id;
  if not found or e.student_id<>NEW.student_id then raise exception 'INVALID_ASSESSMENT_RESULT_IDENTITY'; end if;
  if not exists(select 1 from public.course_activations a where a.id=NEW.activation_id and a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id) then
    raise exception 'INVALID_ASSESSMENT_RESULT_ACTIVATION';
  end if;
  if not exists(select 1 from public.commercial_v1_result_policies rp where rp.activation_id=NEW.activation_id) then
    raise exception 'RESULT_POLICY_REQUIRED';
  end if;
  if not exists(select 1 from public.commercial_v1_component_bindings b where b.activation_id=NEW.activation_id and b.component=NEW.component and b.assessment_id=NEW.assessment_id) then
    raise exception 'INVALID_ASSESSMENT_RESULT_COMPONENT';
  end if;
  if not exists(select 1 from public.assessment_attempts a where a.id=NEW.attempt_id and a.assessment_id=NEW.assessment_id and a.enrolment_id=NEW.enrolment_id and a.student_id=NEW.student_id and a.state='SUBMITTED') then
    raise exception 'INVALID_ASSESSMENT_RESULT_ATTEMPT';
  end if;
  expected_weight:=commercial_v1_private.expected_component_weight(NEW.activation_id,NEW.component);
  if expected_weight is null or NEW.component_weight_bp<>expected_weight then raise exception 'INVALID_COMPONENT_WEIGHT'; end if;
  select sum(q.max_marks)::integer into expected_max from public.assessment_questions q where q.assessment_id=NEW.assessment_id;
  if expected_max is null or NEW.max_marks_total<>expected_max then raise exception 'INVALID_ASSESSMENT_MAX_TOTAL'; end if;
  if NEW.revision_number=1 then
    if exists(select 1 from public.commercial_v1_assessment_result_revisions r where r.enrolment_id=NEW.enrolment_id and r.component=NEW.component) then raise exception 'INVALID_RESULT_REVISION_SEQUENCE'; end if;
  elsif not exists(select 1 from public.commercial_v1_assessment_result_revisions r where r.enrolment_id=NEW.enrolment_id and r.component=NEW.component and r.revision_number=NEW.revision_number-1) then
    raise exception 'INVALID_RESULT_REVISION_SEQUENCE';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.guard_assessment_result_insert() from public;
create trigger guard_assessment_result_insert
before insert on public.commercial_v1_assessment_result_revisions
for each row execute function commercial_v1_private.guard_assessment_result_insert();

create function commercial_v1_private.guard_assessment_question_mark_insert() returns trigger
language plpgsql set search_path='' as $$
declare r public.commercial_v1_assessment_result_revisions%rowtype; actual_max integer;
begin
  select * into r from public.commercial_v1_assessment_result_revisions where id=NEW.result_revision_id;
  if not found then raise exception 'INVALID_RESULT_REVISION'; end if;
  select q.max_marks into actual_max from public.assessment_questions q where q.id=NEW.question_id and q.assessment_id=r.assessment_id;
  if not found then raise exception 'QUESTION_NOT_IN_RESULT_ASSESSMENT'; end if;
  if NEW.max_marks_snapshot<>actual_max then raise exception 'QUESTION_MAX_MARKS_MISMATCH'; end if;
  if NEW.marks_awarded>actual_max then raise exception 'QUESTION_MARKS_EXCEED_ACTUAL_MAX'; end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.guard_assessment_question_mark_insert() from public;
create trigger guard_assessment_question_mark_insert
before insert on public.commercial_v1_assessment_question_marks
for each row execute function commercial_v1_private.guard_assessment_question_mark_insert();

create function commercial_v1_private.guard_lab_result_insert() returns trigger
language plpgsql set search_path='' as $$
declare e public.enrolments%rowtype; lp public.commercial_v1_lab_policies%rowtype;
begin
  select * into e from public.enrolments where id=NEW.enrolment_id;
  if not found or e.student_id<>NEW.student_id then raise exception 'INVALID_LAB_RESULT_IDENTITY'; end if;
  if not exists(select 1 from public.course_activations a where a.id=NEW.activation_id and a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id) then
    raise exception 'INVALID_LAB_RESULT_ACTIVATION';
  end if;
  if not exists(select 1 from public.commercial_v1_result_policies rp where rp.activation_id=NEW.activation_id) then raise exception 'RESULT_POLICY_REQUIRED'; end if;
  if not exists(select 1 from public.commercial_v1_lab_submissions s where s.id=NEW.submission_id and s.activation_id=NEW.activation_id and s.enrolment_id=NEW.enrolment_id and s.student_id=NEW.student_id and s.practical_id=NEW.practical_id) then
    raise exception 'INVALID_LAB_RESULT_SUBMISSION';
  end if;
  select * into lp from public.commercial_v1_lab_policies where activation_id=NEW.activation_id and practical_id=NEW.practical_id;
  if not found then raise exception 'LAB_POLICY_REQUIRED'; end if;
  if NEW.max_marks<>lp.max_marks then raise exception 'LAB_MAX_MARKS_MISMATCH'; end if;
  if NEW.contribution_bp<>lp.contribution_bp then raise exception 'LAB_CONTRIBUTION_MISMATCH'; end if;
  if NEW.revision_number=1 then
    if exists(select 1 from public.commercial_v1_lab_result_revisions r where r.enrolment_id=NEW.enrolment_id and r.practical_id=NEW.practical_id) then raise exception 'INVALID_RESULT_REVISION_SEQUENCE'; end if;
  elsif not exists(select 1 from public.commercial_v1_lab_result_revisions r where r.enrolment_id=NEW.enrolment_id and r.practical_id=NEW.practical_id and r.revision_number=NEW.revision_number-1) then
    raise exception 'INVALID_RESULT_REVISION_SEQUENCE';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.guard_lab_result_insert() from public;
create trigger guard_lab_result_insert
before insert on public.commercial_v1_lab_result_revisions
for each row execute function commercial_v1_private.guard_lab_result_insert();

create function commercial_v1_private.assessment_result_is_valid(p_result_revision_id uuid) returns boolean
language sql stable set search_path='' as $$
with r as (
  select * from public.commercial_v1_assessment_result_revisions where id=p_result_revision_id
), expected_outcomes as (
  select co.objective_id,
         sum(m.marks_awarded)::integer earned_marks,
         sum(q.max_marks)::integer max_marks,
         case when sum(m.marks_awarded)=0 then 'INCORRECT'
              when sum(m.marks_awarded)=sum(q.max_marks) then 'CORRECT' else 'PARTIAL' end outcome
  from r
  join public.commercial_v1_assessment_question_marks m on m.result_revision_id=r.id
  join public.assessment_questions q on q.id=m.question_id and q.assessment_id=r.assessment_id
  join public.course_assessment_objectives co on co.question_id=q.id and co.assessment_id=r.assessment_id
  group by co.objective_id
), actual_outcomes as (
  select oo.objective_id,oo.earned_marks,oo.max_marks,oo.outcome
  from public.commercial_v1_assessment_objective_outcomes oo where oo.result_revision_id=p_result_revision_id
)
select coalesce((select
  exists(select 1 from public.enrolments e join public.course_activations a on a.id=r.activation_id and a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id
         where e.id=r.enrolment_id and e.student_id=r.student_id)
  and exists(select 1 from public.commercial_v1_result_policies rp where rp.activation_id=r.activation_id)
  and exists(select 1 from public.commercial_v1_component_bindings b where b.activation_id=r.activation_id and b.component=r.component and b.assessment_id=r.assessment_id)
  and exists(select 1 from public.assessment_attempts a where a.id=r.attempt_id and a.assessment_id=r.assessment_id and a.enrolment_id=r.enrolment_id and a.student_id=r.student_id and a.state='SUBMITTED')
  and r.component_weight_bp=commercial_v1_private.expected_component_weight(r.activation_id,r.component)
  and r.max_marks_total=(select sum(q.max_marks)::integer from public.assessment_questions q where q.assessment_id=r.assessment_id)
  and r.earned_marks_total=(select coalesce(sum(m.marks_awarded),0)::integer from public.commercial_v1_assessment_question_marks m where m.result_revision_id=r.id)
  and (select count(*) from public.commercial_v1_assessment_question_marks m where m.result_revision_id=r.id)=(select count(*) from public.assessment_questions q where q.assessment_id=r.assessment_id)
  and not exists(select 1 from public.commercial_v1_assessment_question_marks m left join public.assessment_questions q on q.id=m.question_id and q.assessment_id=r.assessment_id where m.result_revision_id=r.id and (q.id is null or m.max_marks_snapshot<>q.max_marks or m.marks_awarded>q.max_marks))
  from r),false)
  and not exists((select * from expected_outcomes except select * from actual_outcomes)
                 union all
                 (select * from actual_outcomes except select * from expected_outcomes))
$$;
revoke all on function commercial_v1_private.assessment_result_is_valid(uuid) from public;

create function commercial_v1_private.lab_result_is_valid(p_result_revision_id uuid) returns boolean
language sql stable set search_path='' as $$
with r as (
  select * from public.commercial_v1_lab_result_revisions where id=p_result_revision_id
), expected_outcomes as (
  select po.objective_id,r.earned_marks,r.max_marks,
         case when r.earned_marks=0 then 'INCORRECT' when r.earned_marks=r.max_marks then 'CORRECT' else 'PARTIAL' end outcome
  from r join public.course_practical_objectives po on po.practical_id=r.practical_id
), actual_outcomes as (
  select oo.objective_id,oo.earned_marks,oo.max_marks,oo.outcome
  from public.commercial_v1_lab_objective_outcomes oo where oo.result_revision_id=p_result_revision_id
)
select coalesce((select
  exists(select 1 from public.enrolments e join public.course_activations a on a.id=r.activation_id and a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id where e.id=r.enrolment_id and e.student_id=r.student_id)
  and exists(select 1 from public.commercial_v1_result_policies rp where rp.activation_id=r.activation_id)
  and exists(select 1 from public.commercial_v1_lab_submissions s where s.id=r.submission_id and s.activation_id=r.activation_id and s.enrolment_id=r.enrolment_id and s.student_id=r.student_id and s.practical_id=r.practical_id)
  and exists(select 1 from public.commercial_v1_lab_policies lp where lp.activation_id=r.activation_id and lp.practical_id=r.practical_id and lp.max_marks=r.max_marks and lp.contribution_bp=r.contribution_bp)
  from r),false)
  and not exists((select * from expected_outcomes except select * from actual_outcomes)
                 union all
                 (select * from actual_outcomes except select * from expected_outcomes))
$$;
revoke all on function commercial_v1_private.lab_result_is_valid(uuid) from public;

-- ==========================================================================
-- Section 5: remediation, separate from MASTERY_V1. A negative CURRENT
-- outcome opens/maintains remediation; resolution happens only by (1) a
-- superseding result removing every negative current outcome for that
-- objective, or (2) real, later MASTERY_V1 DEMONSTRATED evidence. Neither
-- apply_objective_mastery_policy nor record_learning_evidence is replaced --
-- this section only ADDS triggers.
-- ==========================================================================
create table public.commercial_v1_remediation_items (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  student_id uuid not null,
  activation_id uuid not null references public.course_activations(id),
  objective_id uuid not null,
  state text not null check(state in ('OPEN','RESOLVED')),
  opened_at timestamptz not null default clock_timestamp(),
  opened_reason text not null,
  resolved_at timestamptz,
  resolved_reason text check(resolved_reason is null or resolved_reason in ('SUPERSEDED_RESULT','MASTERY_DEMONSTRATED')),
  check(
    (state='OPEN' and resolved_at is null and resolved_reason is null)
    or (state='RESOLVED' and resolved_at is not null and resolved_reason is not null)
  )
);
create unique index one_open_remediation_item
  on public.commercial_v1_remediation_items(enrolment_id,objective_id) where state='OPEN';
create index remediation_items_enrolment
  on public.commercial_v1_remediation_items(enrolment_id,state);

create function commercial_v1_private.guard_remediation_item() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial V1 remediation history cannot be deleted'; end if;
  if NEW.enrolment_id<>OLD.enrolment_id or NEW.student_id<>OLD.student_id
    or NEW.activation_id<>OLD.activation_id or NEW.objective_id<>OLD.objective_id
    or NEW.opened_at<>OLD.opened_at or NEW.opened_reason<>OLD.opened_reason then
    raise exception 'Commercial V1 remediation item identity is immutable';
  end if;
  if OLD.state='OPEN' and NEW.state='RESOLVED' then return NEW; end if;
  if NEW is not distinct from OLD then return NEW; end if;
  raise exception 'Resolved Commercial V1 remediation items are immutable; a reopened objective opens a new item';
end $$;
revoke all on function commercial_v1_private.guard_remediation_item() from public;
create trigger guard_remediation_item
before update or delete on public.commercial_v1_remediation_items
for each row execute function commercial_v1_private.guard_remediation_item();

-- Deterministic reconciliation for one enrolment+objective: opens a new item
-- when a negative CURRENT outcome exists and none is already open; resolves
-- the open item (SUPERSEDED_RESULT) when no negative current outcome
-- remains. "Current" = the highest revision_number per component/practical
-- that actually maps to this objective.
create function commercial_v1_private.reconcile_remediation(
  p_enrolment_id uuid, p_student_id uuid, p_activation_id uuid, p_objective_id uuid, p_reason text
) returns void
language plpgsql set search_path='' as $$
declare has_negative boolean; has_invalid_current boolean; open_id uuid;
begin
  -- A malformed highest revision never falls back to an older result and never
  -- resolves/opens remediation. 11B must finish one valid revision atomically
  -- under the enrolment lock before this reconciliation is authoritative.
  select exists(
    select 1 from public.commercial_v1_assessment_result_revisions r
    where r.enrolment_id=p_enrolment_id
      and exists(select 1 from public.course_assessment_objectives co where co.assessment_id=r.assessment_id and co.objective_id=p_objective_id)
      and r.revision_number=(select max(r2.revision_number) from public.commercial_v1_assessment_result_revisions r2 where r2.enrolment_id=r.enrolment_id and r2.component=r.component)
      and not commercial_v1_private.assessment_result_is_valid(r.id)
  ) or exists(
    select 1 from public.commercial_v1_lab_result_revisions r
    where r.enrolment_id=p_enrolment_id
      and exists(select 1 from public.course_practical_objectives po where po.practical_id=r.practical_id and po.objective_id=p_objective_id)
      and r.revision_number=(select max(r2.revision_number) from public.commercial_v1_lab_result_revisions r2 where r2.enrolment_id=r.enrolment_id and r2.practical_id=r.practical_id)
      and not commercial_v1_private.lab_result_is_valid(r.id)
  ) into has_invalid_current;
  if has_invalid_current then return; end if;

  select exists(
    select 1
    from public.commercial_v1_assessment_objective_outcomes oo
    join public.commercial_v1_assessment_result_revisions r on r.id=oo.result_revision_id
    where r.enrolment_id=p_enrolment_id and oo.objective_id=p_objective_id
      and oo.outcome<>'CORRECT'
      and r.revision_number=(select max(r2.revision_number) from public.commercial_v1_assessment_result_revisions r2 where r2.enrolment_id=r.enrolment_id and r2.component=r.component)
      and commercial_v1_private.assessment_result_is_valid(r.id)
  ) or exists(
    select 1
    from public.commercial_v1_lab_objective_outcomes oo
    join public.commercial_v1_lab_result_revisions r on r.id=oo.result_revision_id
    where r.enrolment_id=p_enrolment_id and oo.objective_id=p_objective_id
      and oo.outcome<>'CORRECT'
      and r.revision_number=(select max(r2.revision_number) from public.commercial_v1_lab_result_revisions r2 where r2.enrolment_id=r.enrolment_id and r2.practical_id=r.practical_id)
      and commercial_v1_private.lab_result_is_valid(r.id)
  ) into has_negative;

  select id into open_id from public.commercial_v1_remediation_items
  where enrolment_id=p_enrolment_id and objective_id=p_objective_id and state='OPEN';

  if has_negative and open_id is null then
    insert into public.commercial_v1_remediation_items(enrolment_id,student_id,activation_id,objective_id,state,opened_reason)
    values(p_enrolment_id,p_student_id,p_activation_id,p_objective_id,'OPEN',coalesce(p_reason,'Negative current objective outcome'));
  elsif not has_negative and open_id is not null then
    update public.commercial_v1_remediation_items
    set state='RESOLVED',resolved_at=clock_timestamp(),resolved_reason='SUPERSEDED_RESULT'
    where id=open_id;
  end if;
end $$;
revoke all on function commercial_v1_private.reconcile_remediation(uuid,uuid,uuid,uuid,text) from public;

create function commercial_v1_private.reconcile_remediation_from_assessment_outcome() returns trigger
language plpgsql set search_path='' as $$
declare r public.commercial_v1_assessment_result_revisions%rowtype;
begin
  select * into r from public.commercial_v1_assessment_result_revisions where id=NEW.result_revision_id;
  perform commercial_v1_private.reconcile_remediation(r.enrolment_id,r.student_id,r.activation_id,NEW.objective_id,
    'Assessment component '||r.component||' revision '||r.revision_number);
  return NEW;
end $$;
revoke all on function commercial_v1_private.reconcile_remediation_from_assessment_outcome() from public;
create trigger reconcile_remediation_from_assessment_outcome
after insert on public.commercial_v1_assessment_objective_outcomes
for each row execute function commercial_v1_private.reconcile_remediation_from_assessment_outcome();

create function commercial_v1_private.reconcile_remediation_from_lab_outcome() returns trigger
language plpgsql set search_path='' as $$
declare r public.commercial_v1_lab_result_revisions%rowtype;
begin
  select * into r from public.commercial_v1_lab_result_revisions where id=NEW.result_revision_id;
  perform commercial_v1_private.reconcile_remediation(r.enrolment_id,r.student_id,r.activation_id,NEW.objective_id,
    'Lab practical revision '||r.revision_number);
  return NEW;
end $$;
revoke all on function commercial_v1_private.reconcile_remediation_from_lab_outcome() from public;
create trigger reconcile_remediation_from_lab_outcome
after insert on public.commercial_v1_lab_objective_outcomes
for each row execute function commercial_v1_private.reconcile_remediation_from_lab_outcome();

-- ADDITIVE hook on the EXISTING objective_mastery table (migration 014,
-- untouched): neither apply_objective_mastery_policy nor
-- record_learning_evidence is replaced. Resolves an open remediation item
-- only when DEMONSTRATED is reached by evidence evaluated strictly AFTER
-- that item opened -- never by a stale/pre-existing mastery row, and never
-- by CORRECT alone (this trigger never writes objective_mastery itself).
create function commercial_v1_private.resolve_remediation_on_mastery_demonstrated() returns trigger
language plpgsql set search_path='' as $$
begin
  if NEW.state='DEMONSTRATED' then
    update public.commercial_v1_remediation_items
    set state='RESOLVED',resolved_at=clock_timestamp(),resolved_reason='MASTERY_DEMONSTRATED'
    where enrolment_id=NEW.enrolment_id and objective_id=NEW.objective_id
      and state='OPEN' and opened_at<NEW.evaluated_at;
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_private.resolve_remediation_on_mastery_demonstrated() from public;
create trigger resolve_remediation_on_mastery_demonstrated
after insert or update on public.objective_mastery
for each row execute function commercial_v1_private.resolve_remediation_on_mastery_demonstrated();

alter table public.commercial_v1_remediation_items enable row level security;
revoke all on public.commercial_v1_remediation_items from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 5b: deterministic derivation helpers. Not granted to any role --
-- callable only by direct database-owner authority (tests in 11A; a future
-- 11B trusted writer would call these from within its own SECURITY DEFINER
-- function, never exposing them directly). A question mapped to multiple
-- objectives contributes its full marks to EACH mapped objective's outcome
-- independently -- the assessment/course-level score is a SEPARATE input
-- (earned_marks_total on the result revision itself, one sum over
-- question_marks) and is never re-derived from these fan-out sums, so no
-- double-counting of the numeric score can occur.
-- ==========================================================================
create function commercial_v1_private.assert_complete_question_marks(p_result_revision_id uuid) returns void
language plpgsql set search_path='' as $$
declare
  r public.commercial_v1_assessment_result_revisions%rowtype;
  missing integer; actual_count integer; actual_earned integer; actual_max integer; expected_count integer;
begin
  select * into r from public.commercial_v1_assessment_result_revisions where id=p_result_revision_id;
  if not found then raise exception 'INVALID_RESULT_REVISION'; end if;
  select count(*) into missing from public.assessment_questions q
  where q.assessment_id=r.assessment_id
    and not exists(select 1 from public.commercial_v1_assessment_question_marks m where m.result_revision_id=p_result_revision_id and m.question_id=q.id);
  if missing>0 then raise exception 'INCOMPLETE_QUESTION_MARKS: % question(s) missing (unanswered must be recorded as zero)', missing; end if;
  select count(*),coalesce(sum(m.marks_awarded),0)::integer,coalesce(sum(q.max_marks),0)::integer
  into actual_count,actual_earned,actual_max
  from public.commercial_v1_assessment_question_marks m
  join public.assessment_questions q on q.id=m.question_id and q.assessment_id=r.assessment_id
  where m.result_revision_id=p_result_revision_id;
  select count(*) into expected_count from public.assessment_questions q where q.assessment_id=r.assessment_id;
  if actual_count<>expected_count or actual_earned<>r.earned_marks_total or actual_max<>r.max_marks_total then
    raise exception 'RESULT_TOTAL_MISMATCH';
  end if;
end $$;
revoke all on function commercial_v1_private.assert_complete_question_marks(uuid) from public;

create function commercial_v1_private.derive_and_insert_objective_outcomes(p_result_revision_id uuid) returns void
language plpgsql set search_path='' as $$
declare r public.commercial_v1_assessment_result_revisions%rowtype; obj record; outcome text;
begin
  perform commercial_v1_private.assert_complete_question_marks(p_result_revision_id);
  select * into r from public.commercial_v1_assessment_result_revisions where id=p_result_revision_id;
  for obj in
    select co.objective_id, sum(m.marks_awarded)::integer as earned, sum(m.max_marks_snapshot)::integer as max
    from public.course_assessment_objectives co
    join public.commercial_v1_assessment_question_marks m
      on m.question_id=co.question_id and m.result_revision_id=p_result_revision_id
    where co.assessment_id=r.assessment_id
    group by co.objective_id
  loop
    outcome := case when obj.earned=0 then 'INCORRECT' when obj.earned=obj.max then 'CORRECT' else 'PARTIAL' end;
    insert into public.commercial_v1_assessment_objective_outcomes(result_revision_id,objective_id,earned_marks,max_marks,outcome)
    values(p_result_revision_id,obj.objective_id,obj.earned,obj.max,outcome);
  end loop;
  -- Multi-objective revisions become valid only after the final outcome row is
  -- inserted. Reconcile every mapped objective once the complete revision is
  -- present so early row-level triggers cannot leave stale remediation behind.
  if commercial_v1_private.assessment_result_is_valid(p_result_revision_id) then
    for obj in select objective_id from public.commercial_v1_assessment_objective_outcomes where result_revision_id=p_result_revision_id loop
      perform commercial_v1_private.reconcile_remediation(r.enrolment_id,r.student_id,r.activation_id,obj.objective_id,
        'Assessment component '||r.component||' revision '||r.revision_number);
    end loop;
  end if;
end $$;
revoke all on function commercial_v1_private.derive_and_insert_objective_outcomes(uuid) from public;

create function commercial_v1_private.derive_and_insert_lab_objective_outcomes(p_result_revision_id uuid) returns void
language plpgsql set search_path='' as $$
declare r public.commercial_v1_lab_result_revisions%rowtype; obj record; outcome text;
begin
  select * into r from public.commercial_v1_lab_result_revisions where id=p_result_revision_id;
  outcome := case when r.earned_marks=0 then 'INCORRECT' when r.earned_marks=r.max_marks then 'CORRECT' else 'PARTIAL' end;
  for obj in select po.objective_id from public.course_practical_objectives po where po.practical_id=r.practical_id loop
    insert into public.commercial_v1_lab_objective_outcomes(result_revision_id,objective_id,earned_marks,max_marks,outcome)
    values(p_result_revision_id,obj.objective_id,r.earned_marks,r.max_marks,outcome);
  end loop;
  if commercial_v1_private.lab_result_is_valid(p_result_revision_id) then
    for obj in select objective_id from public.commercial_v1_lab_objective_outcomes where result_revision_id=p_result_revision_id loop
      perform commercial_v1_private.reconcile_remediation(r.enrolment_id,r.student_id,r.activation_id,obj.objective_id,
        'Lab practical revision '||r.revision_number);
    end loop;
  end if;
end $$;
revoke all on function commercial_v1_private.derive_and_insert_lab_objective_outcomes(uuid) from public;

-- ==========================================================================
-- Section 6: course completion. enrolments.status already permits
-- 'COMPLETED' (migration 001); change_enrolment_status (migration 019,
-- immutable) already refuses it as a caller-selectable target -- no
-- historical function is touched. Only this dedicated RPC ever writes
-- status='COMPLETED', via a direct UPDATE (SECURITY DEFINER), never through
-- the generic RPC.
-- ==========================================================================
create table public.commercial_v1_completion_receipts (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null unique,
  student_id uuid not null,
  activation_id uuid not null references public.course_activations(id),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  final_course_score_bp integer not null check(final_course_score_bp between 0 and 10000),
  pass_mark_bp integer not null check(pass_mark_bp between 1 and 10000),
  result_policy_version text not null default 'COMMERCIAL_V1_RESULTS_V1' check(result_policy_version='COMMERCIAL_V1_RESULTS_V1'),
  grading_policy_version text not null default 'COMMERCIAL_V1_GRADING_V1' check(grading_policy_version='COMMERCIAL_V1_GRADING_V1'),
  completed_by uuid not null references public.app_users(id),
  completed_at timestamptz not null default clock_timestamp()
);
create trigger completion_receipt_append_only
before update or delete on public.commercial_v1_completion_receipts
for each row execute function commercial_v1_private.append_only();

-- Resolves the activation governing one enrolment (its cohort's own unique
-- activation row -- course_activations.cohort_id is unique, migration 027).
create function commercial_v1_private.enrolment_activation(p_enrolment_id uuid)
returns public.course_activations
language sql stable set search_path='' as $$
  select a.* from public.course_activations a
  join public.enrolments e on e.cohort_id=a.cohort_id
  where e.id=p_enrolment_id
$$;
revoke all on function commercial_v1_private.enrolment_activation(uuid) from public;

create function commercial_v1_private.current_assessment_result(p_enrolment_id uuid,p_component text)
returns public.commercial_v1_assessment_result_revisions
language plpgsql stable set search_path='' as $$
declare r public.commercial_v1_assessment_result_revisions%rowtype;
begin
  select * into r from public.commercial_v1_assessment_result_revisions
  where enrolment_id=p_enrolment_id and component=p_component
  order by revision_number desc limit 1;
  if r.id is null or not commercial_v1_private.assessment_result_is_valid(r.id) then return null; end if;
  return r;
end $$;
revoke all on function commercial_v1_private.current_assessment_result(uuid,text) from public;

create function commercial_v1_private.current_lab_result(p_enrolment_id uuid,p_practical_id uuid)
returns public.commercial_v1_lab_result_revisions
language plpgsql stable set search_path='' as $$
declare r public.commercial_v1_lab_result_revisions%rowtype;
begin
  select * into r from public.commercial_v1_lab_result_revisions
  where enrolment_id=p_enrolment_id and practical_id=p_practical_id
  order by revision_number desc limit 1;
  if r.id is null or not commercial_v1_private.lab_result_is_valid(r.id) then return null; end if;
  return r;
end $$;
revoke all on function commercial_v1_private.current_lab_result(uuid,uuid) from public;

-- Computes course_score_bp plus the pending-requirement list. Never raises
-- for an incomplete course -- callers decide what an incomplete score means.
create function commercial_v1_private.course_progress(p_enrolment_id uuid)
returns jsonb
language plpgsql stable set search_path='' as $$
declare
  activation public.course_activations%rowtype;
  gp public.commercial_v1_grading_policies%rowtype;
  rp public.commercial_v1_result_policies%rowtype;
  comp text; result public.commercial_v1_assessment_result_revisions%rowtype;
  lab record; lab_result public.commercial_v1_lab_result_revisions%rowtype;
  score_bp integer := 0;
  pending jsonb := '[]'::jsonb;
  components jsonb := '{}'::jsonb;
  labs jsonb := '{}'::jsonb;
begin
  activation := commercial_v1_private.enrolment_activation(p_enrolment_id);
  if activation.id is null then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;
  select * into gp from public.commercial_v1_grading_policies where activation_id=activation.id;
  select * into rp from public.commercial_v1_result_policies where activation_id=activation.id;

  foreach comp in array array['QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL'] loop
    result := commercial_v1_private.current_assessment_result(p_enrolment_id,comp);
    if result.id is null then
      pending := pending || jsonb_build_array(jsonb_build_object('kind','ASSESSMENT','component',comp));
      components := components || jsonb_build_object(comp,jsonb_build_object('status','PENDING'));
    else
      score_bp := score_bp + result.weighted_contribution_bp;
      components := components || jsonb_build_object(comp,jsonb_build_object(
        'status','FINALIZED','scoreBp',result.score_bp,'weightedContributionBp',result.weighted_contribution_bp));
    end if;
  end loop;

  if gp.resolved_profile='WITH_LABS' then
    for lab in select practical_id,contribution_bp from public.commercial_v1_lab_policies where activation_id=activation.id and contribution_bp>0 loop
      lab_result := commercial_v1_private.current_lab_result(p_enrolment_id,lab.practical_id);
      if lab_result.id is null then
        pending := pending || jsonb_build_array(jsonb_build_object('kind','LAB','practicalId',lab.practical_id));
        labs := labs || jsonb_build_object(lab.practical_id::text,jsonb_build_object('status','PENDING'));
      else
        score_bp := score_bp + lab_result.weighted_contribution_bp;
        labs := labs || jsonb_build_object(lab.practical_id::text,jsonb_build_object(
          'status','FINALIZED','weightedContributionBp',lab_result.weighted_contribution_bp));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok',true,
    'activationId',activation.id,
    'gradingPolicyPublished',gp.activation_id is not null,
    'resultPolicyPublished',rp.activation_id is not null,
    'passMarkBp',rp.pass_mark_bp,
    'requireRemediationClearForCompletion',rp.require_remediation_clear_for_completion,
    'components',components,
    'labs',labs,
    'courseScoreBp',case when jsonb_array_length(pending)=0 then score_bp else null end,
    'pending',pending,
    'openRemediationCount',(select count(*) from public.commercial_v1_remediation_items where enrolment_id=p_enrolment_id and state='OPEN')
  );
end $$;
revoke all on function commercial_v1_private.course_progress(uuid) from public;

create function public.get_commercial_v1_course_progress(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; e public.enrolments%rowtype; progress jsonb;
begin
  actor := public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  select * into e from public.enrolments where id=p_enrolment_id;
  if not found or not (e.student_id=actor or public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;
  progress := commercial_v1_private.course_progress(p_enrolment_id);
  if coalesce((progress->>'ok')::boolean,false)=false then return progress; end if;
  progress := progress || jsonb_build_object(
    'enrolmentStatus',e.status,
    'completed',e.status='COMPLETED'
  );
  return progress;
end $$;
revoke all on function public.get_commercial_v1_course_progress(uuid) from public;
grant execute on function public.get_commercial_v1_course_progress(uuid) to authenticated;

-- Bounded learner-safe source-level objective diagnostics. This deliberately
-- does not invent a single aggregate objective grade: each current valid
-- assessment/lab source is represented independently.
create function public.list_commercial_v1_objective_diagnostics(p_enrolment_id uuid,p_limit integer,p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; e public.enrolments%rowtype; items jsonb;
begin
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 10000 then raise exception 'INVALID_PAGINATION'; end if;
  select * into e from public.enrolments where id=p_enrolment_id;
  if not found or not (e.student_id=actor or public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;
  if not exists(select 1 from public.course_activations a where a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;
  with diagnostic_rows as (
    select oo.objective_id,'ASSESSMENT'::text source_kind,r.component,null::uuid practical_id,oo.outcome,
      exists(select 1 from public.commercial_v1_remediation_items ri where ri.enrolment_id=p_enrolment_id and ri.objective_id=oo.objective_id and ri.state='OPEN') remediation_open
    from public.commercial_v1_assessment_result_revisions r
    join public.commercial_v1_assessment_objective_outcomes oo on oo.result_revision_id=r.id
    where r.enrolment_id=p_enrolment_id
      and r.id=(select cur.id from commercial_v1_private.current_assessment_result(p_enrolment_id,r.component) cur)
    union all
    select oo.objective_id,'LAB'::text,null::text,r.practical_id,oo.outcome,
      exists(select 1 from public.commercial_v1_remediation_items ri where ri.enrolment_id=p_enrolment_id and ri.objective_id=oo.objective_id and ri.state='OPEN') remediation_open
    from public.commercial_v1_lab_result_revisions r
    join public.commercial_v1_lab_objective_outcomes oo on oo.result_revision_id=r.id
    where r.enrolment_id=p_enrolment_id
      and r.id=(select cur.id from commercial_v1_private.current_lab_result(p_enrolment_id,r.practical_id) cur)
  ), page as (
    select * from diagnostic_rows
    order by objective_id::text,source_kind,coalesce(component,''),coalesce(practical_id::text,'')
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'objectiveId',objective_id,'sourceKind',source_kind,'component',component,
    'practicalId',practical_id,'outcome',outcome,'remediationOpen',remediation_open
  ) order by objective_id::text,source_kind,coalesce(component,''),coalesce(practical_id::text,'')),'[]'::jsonb) into items from page;
  return jsonb_build_object('ok',true,'items',items,'limit',p_limit,'offset',p_offset);
end $$;
revoke all on function public.list_commercial_v1_objective_diagnostics(uuid,integer,integer) from public;
grant execute on function public.list_commercial_v1_objective_diagnostics(uuid,integer,integer) to authenticated;

create function public.attempt_commercial_v1_course_completion(p_enrolment_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; e public.enrolments%rowtype; progress jsonb; activation public.course_activations%rowtype;
  rp public.commercial_v1_result_policies%rowtype; receipt_id uuid; score_bp integer;
begin
  actor := public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded completion reason is required';
  end if;

  select * into e from public.enrolments where id=p_enrolment_id for update;
  if not found or not (e.student_id=actor or public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;

  if e.status='COMPLETED' then
    select id into receipt_id from public.commercial_v1_completion_receipts where enrolment_id=p_enrolment_id;
    if receipt_id is null then return jsonb_build_object('ok',false,'code','COMPLETION_RECEIPT_MISSING'); end if;
    return jsonb_build_object('ok',true,'code','ALREADY_COMPLETED','receiptId',receipt_id);
  end if;
  if e.status<>'ACTIVE' then
    return jsonb_build_object('ok',false,'code','ENROLMENT_NOT_ACTIVE');
  end if;

  activation := commercial_v1_private.enrolment_activation(p_enrolment_id);
  if activation.id is null then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into rp from public.commercial_v1_result_policies where activation_id=activation.id;
  if not found then return jsonb_build_object('ok',false,'code','RESULT_POLICY_REQUIRED'); end if;

  progress := commercial_v1_private.course_progress(p_enrolment_id);
  if jsonb_array_length(progress->'pending')>0 then
    return jsonb_build_object('ok',false,'code','COMPONENTS_INCOMPLETE','pending',progress->'pending');
  end if;
  score_bp := (progress->>'courseScoreBp')::integer;
  if score_bp < rp.pass_mark_bp then
    return jsonb_build_object('ok',false,'code','BELOW_PASS_MARK','courseScoreBp',score_bp,'passMarkBp',rp.pass_mark_bp);
  end if;
  if rp.require_remediation_clear_for_completion and (progress->>'openRemediationCount')::integer>0 then
    return jsonb_build_object('ok',false,'code','REMEDIATION_NOT_CLEAR');
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_completion_receipts(
    enrolment_id,student_id,activation_id,cohort_id,programme_version_id,
    final_course_score_bp,pass_mark_bp,completed_by
  ) values (
    p_enrolment_id,e.student_id,activation.id,e.cohort_id,e.programme_version_id,
    score_bp,rp.pass_mark_bp,actor
  ) returning id into receipt_id;
  update public.enrolments set status='COMPLETED' where id=p_enrolment_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_COURSE_COMPLETED','enrolments',p_enrolment_id,'COMMERCIAL_V1_RESULTS_V1',trim(p_reason),
    jsonb_build_object('enrolment_id',p_enrolment_id,'final_course_score_bp',score_bp,'pass_mark_bp',rp.pass_mark_bp));

  return jsonb_build_object('ok',true,'code','COMPLETED','receiptId',receipt_id,'courseScoreBp',score_bp);
end $$;
revoke all on function public.attempt_commercial_v1_course_completion(uuid,text) from public;
grant execute on function public.attempt_commercial_v1_course_completion(uuid,text) to authenticated;

-- ==========================================================================
-- Section 7: governed admin RPCs -- lab policy configuration and result
-- policy publication.
-- ==========================================================================
create function public.set_commercial_v1_lab_policy(
  p_activation_id uuid,p_practical_id uuid,p_max_marks integer,p_contribution_bp integer,
  p_grading_guidance text,p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; activation public.course_activations%rowtype; existing public.commercial_v1_lab_policies%rowtype;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded lab-policy reason is required';
  end if;
  if p_max_marks not between 1 and 100 then raise exception 'INVALID_MAX_MARKS'; end if;
  if p_contribution_bp not between 0 and 2000 then raise exception 'INVALID_CONTRIBUTION_BP'; end if;
  if p_contribution_bp>0 and (p_grading_guidance is null or length(trim(p_grading_guidance)) not between 1 and 4000) then
    raise exception 'GRADING_GUIDANCE_REQUIRED';
  end if;

  select * into activation from public.course_activations where id=p_activation_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists(select 1 from public.commercial_v1_result_policies where activation_id=p_activation_id) then
    raise exception 'RESULT_POLICY_ALREADY_PUBLISHED';
  end if;

  -- Only a legitimate PRACTICAL_LAB materialised for THIS activation's own
  -- import/programme-version is eligible; EXERCISE is not.
  if not exists(
    select 1 from public.course_practicals p
    where p.id=p_practical_id and p.import_id=activation.import_id
      and p.programme_version_id=activation.programme_version_id and p.kind='PRACTICAL_LAB'
  ) then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  select * into existing from public.commercial_v1_lab_policies
  where activation_id=p_activation_id and practical_id=p_practical_id for update;
  if found then
    update public.commercial_v1_lab_policies
    set max_marks=p_max_marks,contribution_bp=p_contribution_bp,
      grading_guidance=nullif(trim(coalesce(p_grading_guidance,'')),''),configured_by=actor,configured_at=clock_timestamp()
    where activation_id=p_activation_id and practical_id=p_practical_id;
  else
    insert into public.commercial_v1_lab_policies(
      activation_id,practical_id,max_marks,contribution_bp,grading_guidance,configured_by
    ) values (
      p_activation_id,p_practical_id,p_max_marks,p_contribution_bp,
      nullif(trim(coalesce(p_grading_guidance,'')),''),actor
    );
  end if;
  return p_practical_id;
end $$;
revoke all on function public.set_commercial_v1_lab_policy(uuid,uuid,integer,integer,text,text) from public;
grant execute on function public.set_commercial_v1_lab_policy(uuid,uuid,integer,integer,text,text) to authenticated;

create function public.publish_commercial_v1_result_policy(
  p_activation_id uuid,p_pass_mark_bp integer,p_require_remediation_clear_for_completion boolean,p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; activation public.course_activations%rowtype; gp public.commercial_v1_grading_policies%rowtype;
  existing public.commercial_v1_result_policies%rowtype; lab_total integer; missing_count integer;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded result-policy reason is required';
  end if;
  if p_pass_mark_bp not between 1 and 10000 then raise exception 'INVALID_PASS_MARK'; end if;
  if p_require_remediation_clear_for_completion is null then raise exception 'INVALID_INPUT'; end if;

  select * into activation from public.course_activations where id=p_activation_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  select * into gp from public.commercial_v1_grading_policies where activation_id=p_activation_id;
  if not found then raise exception 'GRADING_POLICY_REQUIRED'; end if;

  select * into existing from public.commercial_v1_result_policies where activation_id=p_activation_id;
  if found then
    if existing.pass_mark_bp=p_pass_mark_bp
      and existing.require_remediation_clear_for_completion=p_require_remediation_clear_for_completion then
      return existing.activation_id;
    end if;
    raise exception 'RESULT_POLICY_ALREADY_PUBLISHED';
  end if;

  if gp.resolved_profile='WITH_LABS' then
    select count(*) into missing_count
    from public.course_practicals p
    where p.import_id=activation.import_id and p.programme_version_id=activation.programme_version_id and p.kind='PRACTICAL_LAB'
      and not exists(
        select 1 from public.commercial_v1_lab_policies lp
        where lp.activation_id=p_activation_id and lp.practical_id=p.id
      );
    if missing_count>0 then raise exception 'LAB_POLICY_INCOMPLETE'; end if;

    select coalesce(sum(contribution_bp),0) into lab_total
    from public.commercial_v1_lab_policies where activation_id=p_activation_id;
    if lab_total<>2000 then raise exception 'LAB_CONTRIBUTION_MUST_SUM_2000'; end if;
  else
    select coalesce(sum(contribution_bp),0) into lab_total
    from public.commercial_v1_lab_policies where activation_id=p_activation_id;
    if lab_total<>0 then raise exception 'NO_LABS_FORBIDS_POSITIVE_CONTRIBUTION'; end if;
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_result_policies(
    activation_id,cohort_id,programme_version_id,pass_mark_bp,require_remediation_clear_for_completion,published_by
  ) values (
    p_activation_id,activation.cohort_id,activation.programme_version_id,
    p_pass_mark_bp,p_require_remediation_clear_for_completion,actor
  );

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_RESULT_POLICY_PUBLISHED','commercial_v1_result_policies',p_activation_id,'COMMERCIAL_V1_RESULTS_V1',
    trim(p_reason),jsonb_build_object('activation_id',p_activation_id,'pass_mark_bp',p_pass_mark_bp,
      'require_remediation_clear_for_completion',p_require_remediation_clear_for_completion));

  return p_activation_id;
end $$;
revoke all on function public.publish_commercial_v1_result_policy(uuid,integer,boolean,text) from public;
grant execute on function public.publish_commercial_v1_result_policy(uuid,integer,boolean,text) to authenticated;

-- ==========================================================================
-- Section 8: learner-owned final lab submission.
-- ==========================================================================
create function public.submit_commercial_v1_lab_work(
  p_enrolment_id uuid,p_practical_id uuid,p_body text,p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; e public.enrolments%rowtype; activation public.course_activations%rowtype;
  existing public.commercial_v1_lab_submissions%rowtype; result_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  if p_body is null or length(trim(p_body)) not between 1 and 20000 then raise exception 'A bounded lab submission body is required'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then raise exception 'A bounded idempotency key is required'; end if;

  select * into e from public.enrolments where id=p_enrolment_id and student_id=actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if e.status<>'ACTIVE' then raise exception 'Only an active enrolment can submit lab work'; end if;

  activation := commercial_v1_private.enrolment_activation(p_enrolment_id);
  if activation.id is null then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if not exists(
    select 1 from public.course_practicals p
    where p.id=p_practical_id and p.import_id=activation.import_id
      and p.programme_version_id=activation.programme_version_id and p.kind='PRACTICAL_LAB'
  ) then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if not exists(select 1 from public.commercial_v1_result_policies where activation_id=activation.id) then
    raise exception 'RESULT_POLICY_REQUIRED';
  end if;

  select * into existing from public.commercial_v1_lab_submissions
  where enrolment_id=p_enrolment_id and practical_id=p_practical_id;
  if found then
    if existing.idempotency_key=trim(p_idempotency_key) and existing.body=trim(p_body) then return existing.id; end if;
    raise exception 'LAB_ALREADY_SUBMITTED';
  end if;

  select * into existing from public.commercial_v1_lab_submissions where idempotency_key=trim(p_idempotency_key);
  if found then raise exception 'Idempotency key is already bound to a different lab submission'; end if;

  insert into public.commercial_v1_lab_submissions(
    activation_id,practical_id,enrolment_id,student_id,body,idempotency_key
  ) values (
    activation.id,p_practical_id,p_enrolment_id,actor,trim(p_body),trim(p_idempotency_key)
  ) returning id into result_id;
  return result_id;
end $$;
revoke all on function public.submit_commercial_v1_lab_work(uuid,uuid,text,text) from public;
grant execute on function public.submit_commercial_v1_lab_work(uuid,uuid,text,text) to authenticated;

-- ==========================================================================
-- Section 9: RLS/ACL hardening, mirroring migration 029's own pattern.
-- No direct table access is ever granted; every read/write goes through the
-- governed RPCs above. Result/outcome/remediation tables have zero direct
-- grants at all (not even SELECT) -- reads happen only through the bounded
-- projection RPC.
-- ==========================================================================
do $$ declare t regclass; cols text; f regprocedure; r text; begin
 for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
  'commercial_v1_lab_policies','commercial_v1_result_policies','commercial_v1_lab_submissions',
  'commercial_v1_assessment_result_revisions','commercial_v1_assessment_question_marks','commercial_v1_assessment_objective_outcomes',
  'commercial_v1_lab_result_revisions','commercial_v1_lab_objective_outcomes','commercial_v1_remediation_items',
  'commercial_v1_completion_receipts') loop
  execute format('alter table %s enable row level security',t);
  execute format('revoke all on %s from public,anon,authenticated,service_role',t);
  select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid=t and attnum>0 and not attisdropped;
  execute format('revoke select(%s),insert(%s),update(%s),references(%s) on %s from public,anon,authenticated,service_role',cols,cols,cols,cols,t);
  foreach r in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe commercial_v1 results privileges'; end if;
  end loop;
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_private' or (n.nspname='public' and p.proname in ('set_commercial_v1_lab_policy','publish_commercial_v1_result_policy','submit_commercial_v1_lab_work','attempt_commercial_v1_course_completion','get_commercial_v1_course_progress','list_commercial_v1_objective_diagnostics')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like 'set_commercial_v1_lab_policy(%' or f::text like 'publish_commercial_v1_result_policy(%' or f::text like 'submit_commercial_v1_lab_work(%' or f::text like 'attempt_commercial_v1_course_completion(%' or f::text like 'get_commercial_v1_course_progress(%' or f::text like 'list_commercial_v1_objective_diagnostics(%' then execute format('grant execute on function %s to authenticated',f); end if;
 end loop;
 foreach r in array array['anon','authenticated','service_role'] loop
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('set_commercial_v1_lab_policy','publish_commercial_v1_result_policy','submit_commercial_v1_lab_work','attempt_commercial_v1_course_completion','get_commercial_v1_course_progress','list_commercial_v1_objective_diagnostics') loop
   if has_function_privilege(r,f,'EXECUTE') is distinct from (r='authenticated') then raise exception 'Unsafe commercial_v1 results privileges'; end if;
  end loop;
 end loop;
end $$;

do $$ declare r text; t regclass; f record; begin
 foreach r in array array['anon','authenticated','service_role'] loop
  for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
   'commercial_v1_lab_policies','commercial_v1_result_policies','commercial_v1_lab_submissions',
   'commercial_v1_assessment_result_revisions','commercial_v1_assessment_question_marks','commercial_v1_assessment_objective_outcomes',
   'commercial_v1_lab_result_revisions','commercial_v1_lab_objective_outcomes','commercial_v1_remediation_items',
   'commercial_v1_completion_receipts') loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe commercial_v1 results privileges'; end if;
  end loop;
  for f in select p.oid,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_private' or (n.nspname='public' and p.proname in ('set_commercial_v1_lab_policy','publish_commercial_v1_result_policy','submit_commercial_v1_lab_work','attempt_commercial_v1_course_completion','get_commercial_v1_course_progress','list_commercial_v1_objective_diagnostics')) loop
   if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then raise exception 'Unsafe commercial_v1 results privileges'; end if;
  end loop;
 end loop;
end $$;
