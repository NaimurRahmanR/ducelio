-- Learner academic policies (docs/61 section 3). Additive: no row, table or
-- historical record is deleted or rewritten. Replaced functions keep their
-- signatures (CREATE OR REPLACE keeps their reviewed ACL); every new function
-- is revoked from every API role and granted explicitly below, then verified.
--
--  1. Attempts: allowed = least(template.attemptsAllowed, 2). A start is
--     allowed while now < closes_at of the enrolment's assessment window and
--     the attempt deadline is least(now + duration, closes_at). An ACTIVE
--     attempt is resumed with its original deadline.
--  2. Result confidentiality: an assessment is RELEASED for an enrolment when
--     now >= closes_at of that enrolment's window and no attempt is ACTIVE.
--     Before release no learner RPC returns a score, mark, correctness,
--     correct answer, explanation, outcome or completion derived from it.
--  3. Deferred processing: assessment objective evidence, MASTERY_V1 updates
--     and completion run at release processing (idempotent), never at
--     finalisation. Finalisation still scores the questions and closes the
--     attempt. Human lab marking keeps recording its own evidence.
--  4. Cross-course collisions: occupied intervals [starts_at, ends_at) of a
--     new or revised timetable may not overlap an occupied interval of the
--     learner's other current timetables; an attempt may not start when
--     [now, expires_at) overlaps another course's occupied interval. The
--     23 h 59 min availability windows are never used for collisions.
--  5. Attendance and display-only class evidence (never mastery).
--  6. Missed-class recap data for the next class's Professor context.
--  7. Monthly pseudonymous assessment leaderboards (released results only).
--  8. Provider attribution and the learner projections behind
--     src/server/learner-academics.ts.
--
-- Time is always the database clock; the browser never supplies "now".
begin;

-- ==========================================================================
-- Section 1: windows, release and attempt policy helpers.
-- ==========================================================================
-- The availability window of any schedule item. Unified courses use the
-- authoritative unified window (including an approved recovery); historical
-- Academy assessments keep their stored sitting window; other historical
-- items open at their start and have no closing instant.
create function academy_private.item_window(p_item_id uuid)
returns table(opens_at timestamptz, closes_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare i public.academy_schedule_items%rowtype;
begin
  select * into i from public.academy_schedule_items where id = p_item_id;
  if not found then return; end if;
  if academy_private.unified_enrolment(i.enrolment_id) then
    return query select w.opens_at, w.closes_at from academy_private.unified_item_window(i.id) w;
    if found then return; end if;
  end if;
  return query select coalesce(i.opens_at, i.starts_at), i.closes_at;
end $$;

-- The ASSESSMENT item of the enrolment's CURRENT schedule.
create function academy_private.assessment_item(p_enrolment_id uuid, p_ref text) returns public.academy_schedule_items
language sql stable security definer set search_path='' as $$
  select i.* from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
  where s.enrolment_id = p_enrolment_id and s.superseded_at is null and i.kind = 'ASSESSMENT' and i.ref = p_ref
  order by i.sequence limit 1
$$;

create function academy_private.assessment_closes_at(p_enrolment_id uuid, p_ref text) returns timestamptz
language sql stable security definer set search_path='' as $$
  select w.closes_at from academy_private.item_window((academy_private.assessment_item(p_enrolment_id, p_ref)).id) w
$$;

-- RELEASED (owner decision 2026-10-27): the learner's OWN full scheduled
-- window has closed and grading is final (no attempt ACTIVE or unscored; a
-- stale attempt must first be finalised by a volatile call). Never earlier,
-- even when every allowed attempt is used; never delayed for other
-- learners. Score, correct answers and explanations release together.
create function academy_private.assessment_released(p_enrolment_id uuid, p_ref text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(clock_timestamp() >= academy_private.assessment_closes_at(p_enrolment_id, p_ref), false)
    and not exists (select 1 from public.academy_assessment_attempts a
      where a.enrolment_id = p_enrolment_id and a.assessment_ref = p_ref
        -- Grading is final: no attempt still open, none submitted unscored.
        and (a.state = 'ACTIVE' or a.score is null))
$$;

create function academy_private.attempts_allowed(p_template jsonb) returns integer
language sql immutable set search_path='' as $$
  select least(greatest(coalesce((p_template->>'attemptsAllowed')::integer, 1), 1), 2)
$$;

create function academy_private.course_provider(p_course_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select o.name from public.course_engine_publications p
    join public.course_engine_organisations o on o.id = p.organisation_id where p.course_id = p_course_id limit 1), 'Ducelio')
$$;

-- The first occupied interval of the learner's OTHER active, unrevoked
-- current timetables that overlaps [p_from, p_to). Availability windows are
-- deliberately not consulted.
create function academy_private.schedule_conflict(p_learner uuid, p_enrolment uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('enrolmentId', e.id, 'courseTitle', c.title, 'kind', i.kind, 'ref', i.ref,
      'title', academy_private.unit_title(p.raw_package, i.kind, i.ref), 'startsAt', i.starts_at, 'endsAt', i.ends_at)
  from public.academy_enrolments e
  join public.academy_entitlements t on t.id = e.entitlement_id and t.state = 'ACTIVE'
  join public.academy_schedules s on s.enrolment_id = e.id and s.superseded_at is null
  join public.academy_schedule_items i on i.schedule_id = s.id
  join public.academy_courses c on c.id = e.course_id
  join public.academy_course_packages p on p.id = c.package_id
  where e.learner_id = p_learner and e.id <> p_enrolment and e.status = 'ACTIVE'
    and i.starts_at < p_to and p_from < i.ends_at
  order by i.starts_at, i.sequence limit 1
$$;

-- The first new plan item that overlaps another current timetable.
create function academy_private.plan_conflict(p_learner uuid, p_enrolment uuid, p_items jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
  select academy_private.schedule_conflict(p_learner, p_enrolment, (x->>'startsAt')::timestamptz, (x->>'endsAt')::timestamptz)
    || jsonb_build_object('itemKind', x->>'kind', 'itemRef', x->>'ref', 'itemStartsAt', x->'startsAt', 'itemEndsAt', x->'endsAt')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where academy_private.schedule_conflict(p_learner, p_enrolment, (x->>'startsAt')::timestamptz, (x->>'endsAt')::timestamptz) is not null
  order by (x->>'startsAt')::timestamptz limit 1
$$;

-- ==========================================================================
-- Section 2: tables.
-- ==========================================================================
-- One row per (enrolment, assessment, closing instant) whose release was
-- processed. Informational and idempotency only: release itself is always
-- derived from the window and the attempts, never from this table.
create table public.academy_assessment_releases (
  enrolment_id uuid not null references public.academy_enrolments(id),
  assessment_ref text not null check (length(assessment_ref) between 1 and 80),
  closes_at timestamptz not null,
  processed_at timestamptz not null default clock_timestamp(),
  primary key (enrolment_id, assessment_ref, closes_at)
);

-- Attendance: one row per enrolment and ROOT scheduled LESSON session. Not
-- completion, not study, not evidence, not mastery.
create table public.academy_class_attendance (
  enrolment_id uuid not null,
  learner_id uuid not null,
  schedule_item_id uuid not null references public.academy_schedule_items(id),
  checked_in_item_id uuid not null references public.academy_schedule_items(id),
  checked_in_at timestamptz not null default clock_timestamp(),
  primary key (enrolment_id, schedule_item_id),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id)
);

-- Display-only class evidence, recorded only from a server-governed,
-- attested, SUCCEEDED Professor execution whose turn was recorded. It is
-- never academy_objective_evidence and never changes mastery.
create table public.academy_class_evidence_records (
  execution_id uuid primary key references public.academy_professor_execution_provenance(execution_id),
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  enrolment_id uuid not null references public.academy_enrolments(id),
  recorded_at timestamptz not null default clock_timestamp()
);
create index academy_class_evidence_records_classroom on public.academy_class_evidence_records(classroom_id);
create table public.academy_class_checks (
  execution_id uuid primary key references public.academy_class_evidence_records(execution_id),
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  objective_id uuid not null references public.lesson_objectives(id),
  correct boolean not null,
  source text not null default 'PROFESSOR_EXECUTION' check (source = 'PROFESSOR_EXECUTION'),
  recorded_at timestamptz not null default clock_timestamp()
);
create index academy_class_checks_classroom on public.academy_class_checks(classroom_id);
create table public.academy_class_covered_objectives (
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  objective_id uuid not null references public.lesson_objectives(id),
  execution_id uuid not null references public.academy_class_evidence_records(execution_id),
  source text not null default 'PROFESSOR_EXECUTION' check (source = 'PROFESSOR_EXECUTION'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (classroom_id, objective_id)
);

do $$ declare t text; begin
  foreach t in array array['academy_assessment_releases','academy_class_attendance','academy_class_evidence_records',
    'academy_class_checks','academy_class_covered_objectives'] loop
    execute format('create trigger guard_history before update or delete on public.%I for each row execute function academy_private.immutable_teaching_row()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- Question-bank integrity (owner decision 2026-10-27): every learner gets
-- their answers when their own window closes, so answer sharing across
-- schedules is mitigated by per-attempt variation rather than by delaying
-- release. Each new attempt carries a server-generated random seed that
-- orders its questions and shuffles answer options; the seed is never
-- returned to a client and never changes. Scoring is keyed by question
-- position and option id, so variation never affects marks. Attempts that
-- predate this migration keep the authored order (null seed).
alter table public.academy_assessment_attempts add column presentation_seed text
  check (presentation_seed ~ '^[0-9a-f]{32}$');
alter table public.academy_assessment_attempts
  alter column presentation_seed set default replace(gen_random_uuid()::text, '-', '');

create function academy_private.immutable_presentation_seed() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.presentation_seed is distinct from old.presentation_seed then
    raise exception 'IMMUTABLE_HISTORY' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger presentation_seed_immutable before update of presentation_seed on public.academy_assessment_attempts
  for each row execute function academy_private.immutable_presentation_seed();

-- A seeded permutation of a JSON array of {id, ...} choices.
create function academy_private.shuffled(p_items jsonb, p_seed text, p_salt text) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(x.value order by md5(p_seed || ':' || p_salt || ':' || coalesce(x.value->>'id', x.n::text))), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality x(value, n)
$$;

-- The learner-visible interaction for one attempt. Ordering questions keep
-- their authored display order: authoring guarantees it differs from the
-- correct order, which a random permutation could reproduce.
create function academy_private.present_interaction(p_type text, p_interaction jsonb, p_seed text, p_position integer)
returns jsonb language sql immutable set search_path='' as $$
  select case
    when p_seed is null or p_interaction is null then p_interaction
    when p_type in ('SINGLE_SELECT','MULTIPLE_SELECT') then
      jsonb_set(p_interaction, '{options}', academy_private.shuffled(p_interaction->'options', p_seed, p_position || ':options'))
    when p_type = 'PBQ_MATCHING' then
      jsonb_set(jsonb_set(p_interaction, '{items}', academy_private.shuffled(p_interaction->'items', p_seed, p_position || ':items')),
        '{targets}', academy_private.shuffled(p_interaction->'targets', p_seed, p_position || ':targets'))
    when p_type = 'PBQ_CONFIGURATION' then
      jsonb_set(p_interaction, '{fields}', coalesce((select jsonb_agg(f.value || jsonb_build_object('options',
          academy_private.shuffled(f.value->'options', p_seed, p_position || ':field:' || (f.value->>'id'))) order by f.n)
        from jsonb_array_elements(p_interaction->'fields') with ordinality f(value, n)), '[]'::jsonb))
    else p_interaction end
$$;

-- Sort key for a question within one attempt (authored order without a seed).
create function academy_private.question_rank(p_seed text, p_position integer) returns text
language sql immutable set search_path='' as $$
  select case when p_seed is null then lpad(p_position::text, 10, '0') else md5(p_seed || ':question:' || p_position) end
$$;

-- ==========================================================================
-- Section 3: finalisation scores and closes only; release processing writes
-- evidence, mastery and completion.
-- ==========================================================================
create or replace function academy_private.finalise_attempt(p_attempt_id uuid, p_submission text) returns public.academy_assessment_attempts
language plpgsql security definer set search_path='' as $$
declare a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype; template jsonb; q jsonb; body text;
  marks integer; total integer := 0; max_total integer := 0;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id for update;
  if a.state = 'SUBMITTED' then return a; end if;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  template := academy_private.assessment_template(e.course_id, a.assessment_ref);
  for q in select value from jsonb_array_elements(template->'questions') order by (value->>'position')::integer loop
    select r.body into body from public.academy_assessment_responses r
    where r.attempt_id = a.id and r.question_position = (q->>'position')::integer
      and (p_submission = 'STUDENT_SUBMIT' or r.recorded_at <= a.expires_at)
    order by r.id desc limit 1;
    -- Migration 059's scorer: the only grading engine for objective types.
    marks := case when body is null then 0 else assessment_interaction_private.score_response(
      q->>'questionType', q->'interaction', q->'answerKey', (q->>'maxMarks')::integer, body) end;
    insert into public.academy_question_marks(attempt_id, question_position, marks, max_marks)
    values (a.id, (q->>'position')::integer, marks, (q->>'maxMarks')::integer);
    total := total + marks;
    max_total := max_total + (q->>'maxMarks')::integer;
  end loop;
  update public.academy_assessment_attempts
  set state = 'SUBMITTED', submitted_at = case when p_submission = 'AUTO_TIMEOUT' then a.expires_at else clock_timestamp() end,
      submission = p_submission, score = total, max_score = max_total
  where id = a.id returning * into a;
  return a;
end $$;

-- Results: an ASSESSMENT component counts only once RELEASED. A released
-- assessment with no attempt scores 0, so NOT_PASSED and completion resolve
-- deterministically after the window closes. There is no "attempts left"
-- state after release: the window, not an unused attempt, decides.
create or replace function academy_private.results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype; pkg jsonb; comp jsonb; out jsonb := '[]'; a jsonb; score_bp integer; status text;
  course_bp integer := 0; all_final boolean := true; every_passed boolean := true; labs_marks integer; labs_max integer; labs_pending integer;
  template jsonb; pass integer; released boolean; closes timestamptz; best integer; best_max integer; used integer;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = e.course_id;
  for comp in select value from jsonb_array_elements(pkg->'grading'->'components') loop
    score_bp := null; status := 'PENDING'; pass := null; released := false; closes := null; best := null; best_max := null; used := null;
    a := null; template := null;
    if comp->>'source' = 'ASSESSMENT' then
      select value into a from jsonb_array_elements(pkg->'assessments') where value->>'componentKey' = comp->>'componentKey';
      template := academy_private.assessment_template(e.course_id, a->>'templateRef');
      pass := (a->>'passMarkBp')::integer;
      released := academy_private.assessment_released(e.id, a->>'templateRef');
      if released then
        closes := academy_private.assessment_closes_at(e.id, a->>'templateRef');
        select count(*)::integer into used from public.academy_assessment_attempts t
          where t.enrolment_id = e.id and t.assessment_ref = a->>'templateRef' and t.state = 'SUBMITTED';
        if used = 0 then
          best := 0;
          select coalesce(sum((x->>'maxMarks')::integer), 0)::integer into best_max from jsonb_array_elements(template->'questions') x;
          score_bp := 0;
        else
          select t.score, t.max_score into best, best_max from public.academy_assessment_attempts t
            where t.enrolment_id = e.id and t.assessment_ref = a->>'templateRef' and t.state = 'SUBMITTED'
            order by case when a->>'attemptScoring' = 'LATEST' then t.attempt_number end desc nulls last,
              t.score * 10000 / t.max_score desc, t.attempt_number
            limit 1;
          score_bp := best * 10000 / best_max;
        end if;
        status := 'GRADED';
      end if;
    else
      select coalesce(sum(m.marks), 0), coalesce(sum(m.max_marks), 0) into labs_marks, labs_max
      from public.academy_lab_submissions s join public.academy_lab_marks m on m.submission_id = s.id where s.enrolment_id = e.id;
      select count(*) into labs_pending from jsonb_array_elements(pkg->'labs') lb
      where (lb.value->>'graded')::boolean and not exists (select 1 from public.academy_lab_submissions s join public.academy_lab_marks m on m.submission_id = s.id
        where s.enrolment_id = e.id and s.lab_ref = lb.value->>'activityRef');
      if labs_pending = 0 and labs_max > 0 then score_bp := labs_marks * 10000 / labs_max; status := 'GRADED'; released := true; end if;
    end if;
    if score_bp is null then all_final := false;
    else course_bp := course_bp + score_bp * (comp->>'weightBp')::integer / 10000;
      if pass is not null and score_bp < pass then every_passed := false; end if;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('componentKey', comp->>'componentKey', 'source', comp->>'source',
      'weightBp', (comp->>'weightBp')::integer, 'status', status, 'scoreBp', score_bp, 'passMarkBp', pass,
      'assessmentRef', a->>'templateRef', 'title', template->>'title', 'kind', a->>'kind',
      'released', released, 'releasedAt', closes, 'bestScore', best, 'maxScore', best_max, 'attemptsUsed', used));
  end loop;
  return jsonb_build_object('components', out, 'allComponentsGraded', all_final,
    'courseScoreBp', case when all_final then course_bp end, 'passMarkBp', (pkg->'completion'->>'coursePassMarkBp')::integer,
    'outcome', case
      when not all_final then 'IN_PROGRESS'
      when course_bp >= (pkg->'completion'->>'coursePassMarkBp')::integer
        and (every_passed or not (pkg->'completion'->>'requireEveryComponentPassMark')::boolean) then 'PASSED'
      else 'NOT_PASSED' end);
end $$;

-- Idempotent release processing for one enrolment. Lazily finalises its
-- expired attempts, then for each RELEASED assessment records one
-- RETRIEVAL_CHECK observation per assessed objective for every submitted
-- attempt not yet evidenced (MASTERY_V1 via record_evidence), and finally
-- evaluates completion. Never trusts a client clock; never runs for revoked
-- access. Returns the released assessment refs.
create function academy_private.process_releases(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype; spec jsonb; ref text; closes timestamptz; released jsonb := '[]';
  a public.academy_assessment_attempts%rowtype; template jsonb; obj record; n integer; revoked boolean;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  if not found then return '[]'::jsonb; end if;
  for a in select * from public.academy_assessment_attempts
      where enrolment_id = e.id and state = 'ACTIVE' and expires_at <= clock_timestamp() loop
    perform academy_private.finalise_attempt(a.id, 'AUTO_TIMEOUT');
  end loop;
  revoked := exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED');
  for spec in select x.value from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
      jsonb_array_elements(p.raw_package->'assessments') with ordinality x where c.id = e.course_id order by x.ordinality loop
    ref := spec->>'templateRef';
    if not academy_private.assessment_released(e.id, ref) then continue; end if;
    released := released || to_jsonb(ref);
    if revoked then continue; end if;
    closes := academy_private.assessment_closes_at(e.id, ref);
    insert into public.academy_assessment_releases(enrolment_id, assessment_ref, closes_at) values (e.id, ref, closes)
    on conflict do nothing;
    get diagnostics n = row_count;
    if n > 0 then
      insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
      values (null, 'ACADEMY_ASSESSMENT_RELEASED', 'academy_enrolments', e.id, 'ACADEMY_DELIVERY_V1',
        'Assessment window closed; results released.',
        jsonb_build_object('assessment_ref', ref, 'closes_at', closes,
          'attempts', (select count(*) from public.academy_assessment_attempts t where t.enrolment_id = e.id and t.assessment_ref = ref)));
    end if;
    template := academy_private.assessment_template(e.course_id, ref);
    for a in select * from public.academy_assessment_attempts t
        where t.enrolment_id = e.id and t.assessment_ref = ref and t.state = 'SUBMITTED'
          and not exists (select 1 from public.academy_objective_evidence v where v.source_id = t.id)
        order by t.attempt_number loop
      for obj in
        select coalesce(q.value->>'lessonRef', template->>'lessonRef') as lesson_ref, o.value #>> '{}' as objective_key,
          sum(m.marks)::integer as marks, sum(m.max_marks)::integer as max_marks
        from jsonb_array_elements(template->'questions') q
        cross join lateral jsonb_array_elements(q.value->'objectiveRefs') o
        join public.academy_question_marks m on m.attempt_id = a.id and m.question_position = (q.value->>'position')::integer
        group by 1, 2
      loop
        perform academy_private.record_evidence(e.id, academy_private.objective_id(e.course_id, obj.lesson_ref, obj.objective_key),
          'ASSESSMENT_ATTEMPT', a.id, 'RETRIEVAL_CHECK', obj.marks, obj.max_marks);
      end loop;
    end loop;
  end loop;
  if not revoked and e.status = 'ACTIVE' then perform academy_private.evaluate_completion(e.id); end if;
  return released;
end $$;

-- ==========================================================================
-- Section 4: cross-course collisions in preview, confirmation and revision.
-- The existing planner is kept unchanged under a private name; every caller
-- (preview, confirm, revise) reaches the collision check through the
-- original name. Confirm and revise hold the learner-profile lock
-- (my_enrolment(.., true)) before planning, so concurrent activations of
-- two courses serialise and the second sees the first's committed items.
-- ==========================================================================
alter function academy_private.compute_plan(public.academy_enrolments, text, date, integer[], text, text, date)
  rename to compute_plan_base;

create function academy_private.compute_plan(
  e public.academy_enrolments, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text,
  p_effective_on date
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare plan jsonb := academy_private.compute_plan_base(e, p_format_id, p_start_on, p_study_days, p_local_time, p_timezone, p_effective_on);
  conflict jsonb;
begin
  if not coalesce((plan->>'feasible')::boolean, false) then return plan; end if;
  conflict := academy_private.plan_conflict(e.learner_id, e.id, plan->'items');
  if conflict is null then return plan; end if;
  return jsonb_build_object('feasible', false, 'code', 'SCHEDULE_CONFLICT',
    'message', format('This timetable overlaps %s in %s (%s to %s). Choose another class time or study days.',
      coalesce(conflict->>'title', 'a scheduled session'), conflict->>'courseTitle',
      to_char((conflict->>'startsAt')::timestamptz at time zone p_timezone, 'FMDD Mon YYYY HH24:MI'),
      to_char((conflict->>'endsAt')::timestamptz at time zone p_timezone, 'HH24:MI')),
    'conflict', conflict, 'alternatives', '[]'::jsonb);
end $$;

-- ==========================================================================
-- Section 5: sittings.
-- ==========================================================================
create or replace function public.start_my_academy_assessment(p_enrolment_id uuid, p_assessment_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype;
  s public.academy_schedules%rowtype; item public.academy_schedule_items%rowtype; template jsonb;
  active public.academy_assessment_attempts%rowtype; used integer; attempt public.academy_assessment_attempts%rowtype;
  now_ts timestamptz; duration interval; actor uuid; opens timestamptz; closes timestamptz; expires timestamptz; conflict jsonb;
  allowed integer;
begin
  -- my_enrolment(.., true) takes the learner profile lock, then the
  -- enrolment lock: the same order as start_assessment_attempt.
  e := academy_private.my_enrolment(p_enrolment_id, true);
  actor := e.learner_id;
  now_ts := clock_timestamp();
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  -- Migration 021's content-release exclusion, preserved for Academy starts.
  perform public.expire_my_academic_content_releases();
  if exists(select 1 from public.academic_content_releases
    where student_id = actor and state = 'ACTIVE' and expires_at > now_ts) then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BUSY');
  end if;
  -- Finalise stale attempts in both systems before judging exclusivity, and
  -- process any release they complete.
  perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, now_ts);
  for active in select * from public.academy_assessment_attempts where learner_id = actor and state = 'ACTIVE' loop
    perform academy_private.expire_if_due(active.id);
  end loop;
  perform academy_private.process_releases(e.id);
  if exists (select 1 from public.assessment_attempts where student_id = actor and state = 'ACTIVE' and expires_at > now_ts) then
    return jsonb_build_object('ok', false, 'code', 'ANOTHER_ASSESSMENT_ACTIVE');
  end if;
  select * into active from public.academy_assessment_attempts where learner_id = actor and state = 'ACTIVE';
  if found then
    -- Same-attempt resume: the original deadline, never a new attempt.
    if active.enrolment_id = e.id and active.assessment_ref = p_assessment_ref then
      return jsonb_build_object('ok', true, 'attemptId', active.id, 'resumed', true, 'expiresAt', active.expires_at);
    end if;
    return jsonb_build_object('ok', false, 'code', 'ANOTHER_ASSESSMENT_ACTIVE');
  end if;
  s := academy_private.current_schedule(e.id);
  if s.id is null then return jsonb_build_object('ok', false, 'code', 'PLAN_REQUIRED'); end if;
  select * into item from public.academy_schedule_items where schedule_id = s.id and kind = 'ASSESSMENT' and ref = p_assessment_ref
    order by sequence limit 1;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  template := academy_private.assessment_template(e.course_id, p_assessment_ref);
  duration := make_interval(mins => (template->>'durationMinutes')::integer);
  select w.opens_at, w.closes_at into opens, closes from academy_private.item_window(item.id) w;
  if opens is null or now_ts < opens then
    return jsonb_build_object('ok', false, 'code', 'SITTING_NOT_OPEN', 'opensAt', opens);
  end if;
  if closes is null or now_ts >= closes then
    return jsonb_build_object('ok', false, 'code', 'SITTING_CLOSED', 'closesAt', closes);
  end if;
  allowed := academy_private.attempts_allowed(template);
  select count(*) into used from public.academy_assessment_attempts where enrolment_id = e.id and assessment_ref = p_assessment_ref;
  if used >= allowed then return jsonb_build_object('ok', false, 'code', 'NO_ATTEMPTS_REMAINING'); end if;
  -- A late start is shortened to the window's close, never extended.
  expires := least(now_ts + duration, closes);
  conflict := academy_private.schedule_conflict(actor, e.id, now_ts, expires);
  if conflict is not null then
    return jsonb_build_object('ok', false, 'code', 'SCHEDULE_CONFLICT', 'conflict', conflict);
  end if;
  insert into public.academy_assessment_attempts(enrolment_id, learner_id, assessment_ref, attempt_number, schedule_item_id, started_at, expires_at)
  values (e.id, actor, p_assessment_ref, used + 1, item.id, now_ts, expires) returning * into attempt;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_ASSESSMENT_STARTED', 'academy_assessment_attempts', attempt.id, 'ACADEMY_DELIVERY_V1', 'Learner started an assessment sitting.',
    jsonb_build_object('enrolment_id', e.id, 'assessment_ref', p_assessment_ref, 'attempt_number', used + 1,
      'shortened_to_window', expires < now_ts + duration));
  return jsonb_build_object('ok', true, 'attemptId', attempt.id, 'resumed', false, 'expiresAt', attempt.expires_at);
end $$;

create or replace function public.get_my_academy_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype;
  template jsonb; released boolean; result jsonb;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  -- Shared lock order: the learner profile first, then the attempt.
  perform 1 from public.student_profiles where user_id = actor for update;
  perform academy_private.expire_if_due(a.id);
  perform academy_private.process_releases(a.enrolment_id);
  select * into a from public.academy_assessment_attempts where id = p_attempt_id;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  template := academy_private.assessment_template(e.course_id, a.assessment_ref);
  if a.state = 'SUBMITTED' then
    released := academy_private.assessment_released(e.id, a.assessment_ref);
    result := jsonb_build_object('attemptId', a.id, 'enrolmentId', a.enrolment_id, 'assessmentRef', a.assessment_ref, 'title', template->>'title',
      'state', a.state, 'submission', a.submission, 'submittedAt', a.submitted_at,
      'attemptNumber', a.attempt_number, 'attemptsAllowed', academy_private.attempts_allowed(template),
      'released', released, 'releasedAt', case when released then academy_private.assessment_closes_at(e.id, a.assessment_ref) end);
    if not released then return result; end if;
    result := result || jsonb_build_object('score', a.score, 'maxScore', a.max_score,
      -- Answer review is withheld while any controlled assessment is active.
      'reviewAvailable', not academy_private.exam_active());
    if academy_private.exam_active() then return result; end if;
    return result || jsonb_build_object('review', (select coalesce(jsonb_agg(jsonb_build_object(
        'position', (q->>'position')::integer, 'prompt', q->>'prompt', 'questionType', q->>'questionType',
        'interaction', academy_private.present_interaction(q->>'questionType', q->'interaction', a.presentation_seed, (q->>'position')::integer),
        'maxMarks', (q->>'maxMarks')::integer,
        'response', (select r.body from public.academy_assessment_responses r where r.attempt_id = a.id
            and r.question_position = (q->>'position')::integer
            and (a.submission = 'STUDENT_SUBMIT' or r.recorded_at <= a.expires_at) order by r.id desc limit 1),
        'marks', (select m.marks from public.academy_question_marks m where m.attempt_id = a.id and m.question_position = (q->>'position')::integer),
        'correctAnswer', q->'answerKey', 'expectedAnswer', q->>'expectedAnswer', 'explanation', q->>'markingGuidance')
        order by academy_private.question_rank(a.presentation_seed, (q->>'position')::integer)), '[]'::jsonb)
      from jsonb_array_elements(template->'questions') q));
  end if;
  -- Learner-visible definition only: prompt, type, interaction, marks.
  return jsonb_build_object('attemptId', a.id, 'enrolmentId', a.enrolment_id, 'assessmentRef', a.assessment_ref, 'title', template->>'title',
    'instructions', template->>'instructions', 'state', a.state, 'startedAt', a.started_at, 'expiresAt', a.expires_at,
    'serverTime', clock_timestamp(), 'durationMinutes', (template->>'durationMinutes')::integer,
    'attemptNumber', a.attempt_number, 'attemptsAllowed', academy_private.attempts_allowed(template),
    'questions', (select jsonb_agg(jsonb_build_object('position', (q->>'position')::integer, 'prompt', q->>'prompt',
        'questionType', q->>'questionType',
        'interaction', academy_private.present_interaction(q->>'questionType', q->'interaction', a.presentation_seed, (q->>'position')::integer),
        'maxMarks', (q->>'maxMarks')::integer,
        'response', (select r.body from public.academy_assessment_responses r where r.attempt_id = a.id
                     and r.question_position = (q->>'position')::integer order by r.id desc limit 1),
        'revisions', (select count(*) from public.academy_assessment_responses r where r.attempt_id = a.id
                     and r.question_position = (q->>'position')::integer))
        order by academy_private.question_rank(a.presentation_seed, (q->>'position')::integer))
      from jsonb_array_elements(template->'questions') q));
end $$;

create or replace function public.record_my_academy_response(p_attempt_id uuid, p_question_position integer, p_body text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype;
  q jsonb;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.academy_assessment_responses where attempt_id = a.id and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if a.state <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ATTEMPT_CLOSED'); end if;
  if a.expires_at <= clock_timestamp() then
    perform academy_private.finalise_attempt(a.id, 'AUTO_TIMEOUT');
    perform academy_private.process_releases(a.enrolment_id);
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  select value into q from jsonb_array_elements(academy_private.assessment_template(e.course_id, a.assessment_ref)->'questions')
  where (value->>'position')::integer = p_question_position;
  if q is null or not assessment_interaction_private.response_is_valid(q->>'questionType', q->'interaction', p_body) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESPONSE');
  end if;
  insert into public.academy_assessment_responses(attempt_id, question_position, body, idempotency_key)
  values (a.id, p_question_position, p_body, p_idempotency_key);
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

-- Submission never returns a score: results appear only after release.
create or replace function public.submit_my_academy_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if a.state = 'ACTIVE' then
    a := academy_private.finalise_attempt(a.id, case when a.expires_at <= clock_timestamp() then 'AUTO_TIMEOUT' else 'STUDENT_SUBMIT' end);
  end if;
  perform academy_private.process_releases(a.enrolment_id);
  return jsonb_build_object('ok', true, 'state', a.state, 'submission', a.submission);
end $$;

-- Learner-callable, idempotent release processing for one own enrolment.
create function public.refresh_my_academy_releases(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); e public.academy_enrolments%rowtype;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  e := academy_private.my_enrolment_history(p_enrolment_id);
  perform 1 from public.academy_enrolments where id = e.id for update;
  return jsonb_build_object('ok', true, 'enrolmentId', e.id, 'released', academy_private.process_releases(e.id));
end $$;

-- Learner results: unreleased assessment components carry no score, marks,
-- attempt count or outcome (results() withholds them at the source).
create or replace function public.get_my_academy_results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
begin
  return academy_private.results(e.id) || jsonb_build_object('enrolmentId', e.id, 'status', e.status,
    'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]') from jsonb_array_elements(academy_private.pending_decisions(e.course_id)) d),
    'completion', (select jsonb_build_object('completedAt', c.completed_at, 'courseScoreBp', c.course_score_bp)
                   from public.academy_completions c where c.enrolment_id = e.id));
end $$;

-- ==========================================================================
-- Section 6: learner enrolments with provider attribution.
-- ==========================================================================
create or replace function public.list_my_academy_enrolments() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'enrolmentId', e.id, 'courseId', c.id, 'title', c.title, 'status', e.status, 'formatId', e.format_id,
      'fixedFormatId', ent.format_id, 'offerSlug', o.slug, 'accessRevoked',ent.state='REVOKED',
      'organisationName', academy_private.course_provider(c.id),
      'formats', (select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
          'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days)
          order by academy_private.format_weeks(f.format_id)) from public.academy_offer_formats f where f.offer_id = o.id),
      'schedule', (select jsonb_build_object('revision', s.revision, 'startOn', s.start_on, 'endOn', s.end_on,
          'studyDays', to_jsonb(s.study_days), 'localTime', to_char(s.local_time, 'HH24:MI'), 'timezone', s.timezone)
        from public.academy_schedules s where s.enrolment_id = e.id and s.superseded_at is null),
      'completedAt', e.completed_at) order by e.created_at desc)
    from public.academy_enrolments e join public.academy_entitlements ent on ent.id = e.entitlement_id
    join public.academy_courses c on c.id = e.course_id join public.academy_offers o on o.course_id = c.id
    where e.learner_id = actor), '[]');
end $$;

-- ==========================================================================
-- Section 7: attendance.
-- ==========================================================================
create function public.check_in_my_academy_class(p_enrolment_id uuid, p_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; i public.academy_schedule_items%rowtype; s public.academy_schedules%rowtype;
  root uuid; opens timestamptz; closes timestamptz; existing public.academy_class_attendance%rowtype; stamp timestamptz; created timestamptz;
begin
  if p_enrolment_id is null or p_item_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  -- Lock order shared with every admission: learner profile, then enrolment.
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  perform academy_private.process_releases(e.id);
  select * into i from public.academy_schedule_items where id = p_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LESSON' then return jsonb_build_object('ok', false, 'code', 'NOT_A_CLASS'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
  root := academy_private.root_schedule_item(i.id);
  select * into existing from public.academy_class_attendance where enrolment_id = e.id and schedule_item_id = root;
  if found then
    return jsonb_build_object('ok', true, 'checkedInAt', existing.checked_in_at, 'replayed', true);
  end if;
  stamp := clock_timestamp();
  select w.opens_at, w.closes_at into opens, closes from academy_private.item_window(i.id) w;
  if opens is null or stamp < opens then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED', 'opensAt', opens); end if;
  if closes is not null and stamp >= closes then return jsonb_build_object('ok', false, 'code', 'WINDOW_CLOSED', 'closesAt', closes); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  insert into public.academy_class_attendance(enrolment_id, learner_id, schedule_item_id, checked_in_item_id)
  values (e.id, e.learner_id, root, i.id) on conflict do nothing returning checked_in_at into created;
  if created is null then
    select * into existing from public.academy_class_attendance where enrolment_id = e.id and schedule_item_id = root;
    return jsonb_build_object('ok', true, 'checkedInAt', existing.checked_in_at, 'replayed', true);
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'ACADEMY_CLASS_CHECKED_IN', 'academy_schedule_items', root, 'ACADEMY_DELIVERY_V1',
    'Learner checked in to a scheduled class.', jsonb_build_object('enrolment_id', e.id));
  return jsonb_build_object('ok', true, 'checkedInAt', created, 'replayed', false);
end $$;

-- Attended or studied work is not eligible for missed-activity recovery.
create or replace function academy_private.recovery_eligible(e public.academy_enrolments,i public.academy_schedule_items) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from public.academy_assessment_attempts a where a.enrolment_id=e.id and a.assessment_ref=i.ref and i.kind='ASSESSMENT')
 and not exists(select 1 from public.academy_lab_submissions l where l.enrolment_id=e.id and l.lab_ref=i.ref and i.kind='LAB')
 and not exists(select 1 from public.academy_lesson_progress l where l.enrolment_id=e.id and l.lesson_ref=i.ref and i.kind='LESSON')
 and not exists(select 1 from public.academy_class_attendance t where t.enrolment_id=e.id and i.kind='LESSON'
   and t.schedule_item_id=academy_private.root_schedule_item(i.id))
$$;

-- Opening a class also processes due releases (a volatile learner path).
create or replace function public.open_my_academy_professor_classroom(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; i public.academy_schedule_items%rowtype;
  root public.academy_schedule_items%rowtype; s public.academy_schedules%rowtype;
  cl public.academy_course_lessons%rowtype; existing uuid; created uuid;
begin
  if p_enrolment_id is null or p_schedule_item_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Lock order shared with every admission: learner profile, then enrolment.
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  perform academy_private.process_releases(e.id);
  select * into i from public.academy_schedule_items where id = p_schedule_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LESSON' then return jsonb_build_object('ok', false, 'code', 'NOT_A_CLASS'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
  if academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id,'LESSON',i.ref,academy_private.root_schedule_item(i.id)) then return jsonb_build_object('ok',false,'code','WINDOW_CLOSED');end if;
  if clock_timestamp() < i.starts_at then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = i.ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into root from public.academy_schedule_items where id = academy_private.root_schedule_item(i.id);
  if root.id is null or root.enrolment_id <> e.id or root.kind <> 'LESSON' or root.ref <> i.ref then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
  end if;
  select id into existing from public.academy_professor_classrooms where schedule_item_id = root.id;
  if existing is not null then
    return jsonb_build_object('ok', true, 'classroomId', existing, 'resumed', true);
  end if;
  insert into public.academy_professor_classrooms(learner_id, enrolment_id, schedule_item_id, programme_version_id,
    lesson_ref, lesson_id, part, parts, scheduled_start, scheduled_end)
  values (e.learner_id, e.id, root.id, e.programme_version_id, root.ref, cl.lesson_id, root.part, root.parts,
    root.starts_at, root.ends_at)
  on conflict (schedule_item_id) do nothing
  returning id into created;
  if created is null then
    select id into existing from public.academy_professor_classrooms where schedule_item_id = root.id;
    return jsonb_build_object('ok', true, 'classroomId', existing, 'resumed', true);
  end if;
  return jsonb_build_object('ok', true, 'classroomId', created, 'resumed', false);
end $$;

-- ==========================================================================
-- Section 8: display-only class evidence from the governed Professor path.
-- A sibling of record_my_academy_professor_turn with its own protocol tag:
-- the server (holder of the controller key) attests the validated proposal;
-- the database restricts every objective to the classroom's own lesson and
-- requires the execution's recorded turn. Never mastery or evidence.
-- ==========================================================================
create function public.record_my_academy_class_evidence(
  p_key_id uuid, p_execution_id uuid, p_classroom_id uuid, p_covered_objective_ids uuid[],
  p_check_objective_id uuid, p_check_correct boolean,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); c public.academy_professor_classrooms%rowtype; r record;
  x public.academic_provider_executions%rowtype; covered text;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_classroom_id is null or p_covered_objective_ids is null
    or cardinality(p_covered_objective_ids) > 50 or array_position(p_covered_objective_ids, null) is not null
    or ((p_check_objective_id is null) <> (p_check_correct is null))
    or (cardinality(p_covered_objective_ids) = 0 and p_check_objective_id is null) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Canonical manifest: distinct lowercase ids in byte order (collation-free).
  covered := array_to_string(array(select distinct lower(v::text) collate "C" from unnest(p_covered_objective_ids) v order by 1), ',');
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_ACADEMY_CLASS_EVIDENCE_HMAC_SHA256_V1', 'PROFESSOR', p_key_id::text, actor::text,
      p_execution_id::text, p_classroom_id::text, covered,
      coalesce(p_check_objective_id::text, 'NONE'), coalesce(p_check_correct::text, 'NONE'),
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor for no key update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into x from public.academic_provider_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'SUCCEEDED'
    or not exists (select 1 from public.academy_professor_execution_provenance where execution_id = x.id and classroom_id = c.id)
    or not exists (select 1 from public.academy_professor_classroom_turns where execution_id = x.id and classroom_id = c.id) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  end if;
  if exists (select 1 from public.academy_class_evidence_records where execution_id = x.id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select * into r from academy_private.teaching_classroom(c.id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  if exists (select 1 from unnest(p_covered_objective_ids || coalesce(array[p_check_objective_id], '{}'::uuid[])) v
      where v is not null and not exists (select 1 from public.lesson_objectives o
        where o.id = v and o.lesson_id = c.lesson_id and o.programme_version_id = c.programme_version_id)) then
    return jsonb_build_object('ok', false, 'code', 'OBJECTIVE_OUTSIDE_LESSON');
  end if;
  insert into public.academy_class_evidence_records(execution_id, classroom_id, enrolment_id) values (x.id, c.id, c.enrolment_id);
  insert into public.academy_class_covered_objectives(classroom_id, objective_id, execution_id)
  select c.id, v, x.id from (select distinct v from unnest(p_covered_objective_ids) v) d on conflict do nothing;
  if p_check_objective_id is not null then
    insert into public.academy_class_checks(execution_id, classroom_id, objective_id, correct)
    values (x.id, c.id, p_check_objective_id, p_check_correct);
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- ==========================================================================
-- Section 9: missed-class recap for the Professor context. Minimum data:
-- the missed lessons' titles and objective descriptions since the last
-- attended class. Same admission and firewall as the classroom reads. A
-- missed class is never marked completed.
-- ==========================================================================
create function academy_private.missed_lessons(p_enrolment_id uuid, p_before timestamptz, p_exclude_ref text) returns jsonb
language sql stable security definer set search_path='' as $$
  with cur as (
    select i.* from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
    where s.enrolment_id = p_enrolment_id and s.superseded_at is null and i.kind = 'LESSON'
  ), attended as (
    select max(i.starts_at) as last_at from cur i
    where i.starts_at < p_before and exists (select 1 from public.academy_class_attendance a
      where a.enrolment_id = p_enrolment_id and a.schedule_item_id = academy_private.root_schedule_item(i.id))
  ), missed as (
    select i.ref, min(i.starts_at) first_start from cur i cross join lateral academy_private.item_window(i.id) w
    where i.starts_at < p_before and i.starts_at > coalesce((select last_at from attended), '-infinity'::timestamptz)
      and i.ref <> coalesce(p_exclude_ref, '')
      and w.closes_at is not null and w.closes_at <= clock_timestamp()
      and not exists (select 1 from public.academy_class_attendance a
        where a.enrolment_id = p_enrolment_id and a.schedule_item_id = academy_private.root_schedule_item(i.id))
    group by i.ref
  )
  select coalesce(jsonb_agg(jsonb_build_object('lessonRef', m.ref, 'lessonTitle', l.title,
      'objectives', coalesce((select jsonb_agg(o.description order by o.position)
        from (select * from public.lesson_objectives o where o.lesson_id = l.id order by o.position limit 50) o), '[]'::jsonb))
    order by m.first_start), '[]'::jsonb)
  from (select * from missed order by first_start limit 10) m
  join public.academy_enrolments e on e.id = p_enrolment_id
  join public.academy_course_lessons cl on cl.course_id = e.course_id and cl.lesson_ref = m.ref
  join public.lessons l on l.id = cl.lesson_id
$$;

create function public.get_my_academy_class_recap(p_classroom_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; c public.academy_professor_classrooms%rowtype;
begin
  if p_classroom_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  c := r.c;
  return jsonb_build_object('ok', true, 'classroomId', c.id,
    'missedLessons', academy_private.missed_lessons(c.enrolment_id, c.scheduled_start, c.lesson_ref));
end $$;

-- ==========================================================================
-- Section 10: learner projections (src/domain/learner-contract.ts).
-- ==========================================================================
-- Server-derived activity state. Attendance is not completion; completion
-- is not mastery; a result is visible only once RELEASED.
create function academy_private.activity_state(p_item public.academy_schedule_items, p_opens timestamptz, p_closes timestamptz, p_now timestamptz)
returns text
language plpgsql stable security definer set search_path='' as $$
declare attempts integer; active boolean;
begin
  if p_item.kind = 'LESSON' then
    if exists (select 1 from public.academy_class_attendance a where a.enrolment_id = p_item.enrolment_id
        and a.schedule_item_id = academy_private.root_schedule_item(p_item.id)) then return 'ATTENDED'; end if;
    if p_now < p_opens then return 'UPCOMING'; end if;
    if p_closes is not null and p_now >= p_closes then return 'MISSED'; end if;
    return 'OPEN';
  elsif p_item.kind = 'ASSESSMENT' then
    select count(*)::integer, coalesce(bool_or(t.state = 'ACTIVE'), false) into attempts, active
      from public.academy_assessment_attempts t where t.enrolment_id = p_item.enrolment_id and t.assessment_ref = p_item.ref;
    if academy_private.assessment_released(p_item.enrolment_id, p_item.ref) then
      return case when attempts > 0 then 'RELEASED' else 'MISSED' end;
    end if;
    if p_now < p_opens then return 'UPCOMING'; end if;
    if attempts > 0 and not active then return 'SUBMITTED'; end if;
    return 'OPEN';
  elsif p_item.kind = 'LAB' then
    if exists (select 1 from public.academy_lab_submissions l where l.enrolment_id = p_item.enrolment_id and l.lab_ref = p_item.ref) then
      return 'SUBMITTED';
    end if;
    if p_now < p_opens then return 'UPCOMING'; end if;
    if p_closes is not null and p_now >= p_closes then return 'MISSED'; end if;
    return 'OPEN';
  end if;
  if p_now < p_opens then return 'UPCOMING'; end if;
  if p_closes is not null and p_now >= p_closes then return 'CLOSED'; end if;
  return 'OPEN';
end $$;

create function academy_private.activity_json(p_item public.academy_schedule_items, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare opens timestamptz; closes timestamptz; course public.academy_courses%rowtype; pkg jsonb;
begin
  select w.opens_at, w.closes_at into opens, closes from academy_private.item_window(p_item.id) w;
  opens := coalesce(opens, p_item.starts_at);
  select c.* into course from public.academy_enrolments e join public.academy_courses c on c.id = e.course_id where e.id = p_item.enrolment_id;
  select raw_package into pkg from public.academy_course_packages where id = course.package_id;
  return jsonb_build_object('itemId', p_item.id, 'enrolmentId', p_item.enrolment_id, 'courseTitle', course.title,
    'provider', academy_private.course_provider(course.id), 'kind', p_item.kind, 'ref', p_item.ref,
    'title', coalesce(academy_private.unit_title(pkg, p_item.kind, p_item.ref), p_item.ref),
    'part', p_item.part, 'parts', p_item.parts, 'startsAt', p_item.starts_at, 'endsAt', p_item.ends_at,
    'opensAt', opens, 'closesAt', closes, 'state', academy_private.activity_state(p_item, opens, closes, p_now));
end $$;

create function academy_private.learner_course_json(p_enrolment_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('enrolmentId', e.id, 'courseId', c.id, 'title', c.title,
    'provider', academy_private.course_provider(c.id), 'status', e.status,
    'scheduled', exists (select 1 from public.academy_schedules s where s.enrolment_id = e.id and s.superseded_at is null),
    'accessRevoked', t.state = 'REVOKED')
  from public.academy_enrolments e join public.academy_courses c on c.id = e.course_id
  join public.academy_entitlements t on t.id = e.entitlement_id where e.id = p_enrolment_id
$$;

create function public.list_my_academy_courses() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(academy_private.learner_course_json(e.id) order by e.created_at desc, e.id)
    from public.academy_enrolments e where e.learner_id = actor), '[]'::jsonb);
end $$;

-- Every activity of the learner's current, unrevoked timetables whose
-- occupied interval starts in the learner's week. No truncation.
create function public.list_my_academy_week(p_week_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); tz text; monday date; from_ts timestamptz; to_ts timestamptz;
  now_ts timestamptz := clock_timestamp();
begin
  select s.timezone into tz from public.academy_schedules s join public.academy_enrolments e on e.id = s.enrolment_id
    join public.academy_entitlements t on t.id = e.entitlement_id
    where e.learner_id = actor and s.superseded_at is null and t.state = 'ACTIVE' order by s.created_at desc, s.id limit 1;
  tz := coalesce(tz, 'UTC');
  monday := coalesce(p_week_start, (now_ts at time zone tz)::date);
  if monday < ((now_ts at time zone tz)::date - 800) or monday > ((now_ts at time zone tz)::date + 800) then
    raise exception 'INVALID_INPUT';
  end if;
  monday := monday - (extract(isodow from monday)::integer - 1);
  from_ts := (monday + time '00:00') at time zone tz;
  to_ts := ((monday + 7) + time '00:00') at time zone tz;
  return jsonb_build_object('weekStart', monday, 'timezone', tz, 'serverTime', now_ts,
    'activities', coalesce((select jsonb_agg(academy_private.activity_json(i, now_ts) order by i.starts_at, i.enrolment_id, i.sequence)
      from public.academy_schedule_items i
      join public.academy_schedules s on s.id = i.schedule_id and s.superseded_at is null
      join public.academy_enrolments e on e.id = s.enrolment_id and e.learner_id = actor
      join public.academy_entitlements t on t.id = e.entitlement_id and t.state = 'ACTIVE'
      where i.starts_at >= from_ts and i.starts_at < to_ts), '[]'::jsonb));
end $$;

-- Display-only class evidence for every LESSON of the learner's week
-- (optionally one enrolment), keyed by schedule item id.
create function public.list_my_academy_class_evidence(p_enrolment_id uuid, p_week_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); week jsonb;
begin
  if p_enrolment_id is not null then perform academy_private.my_enrolment_history(p_enrolment_id); end if;
  week := public.list_my_academy_week(p_week_start);
  return jsonb_build_object('weekStart', week->'weekStart', 'timezone', week->'timezone',
    'evidence', coalesce((select jsonb_object_agg(i.id::text,
        academy_private.class_evidence(i.enrolment_id, academy_private.root_schedule_item(i.id), i.ref))
      from jsonb_array_elements(week->'activities') a
      join public.academy_schedule_items i on i.id = (a->>'itemId')::uuid
      where i.kind = 'LESSON' and (p_enrolment_id is null or i.enrolment_id = p_enrolment_id)), '{}'::jsonb));
end $$;

-- The learner's next activity: the earliest OPEN or UPCOMING item of an
-- ACTIVE unrevoked enrolment that has not yet ended (or null).
create function public.get_my_academy_next_activity() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); now_ts timestamptz := clock_timestamp(); i public.academy_schedule_items%rowtype; a jsonb;
begin
  for i in select x.* from public.academy_schedule_items x
      join public.academy_schedules s on s.id = x.schedule_id and s.superseded_at is null
      join public.academy_enrolments e on e.id = s.enrolment_id and e.learner_id = actor and e.status = 'ACTIVE'
      join public.academy_entitlements t on t.id = e.entitlement_id and t.state = 'ACTIVE'
      where coalesce(x.closes_at, x.ends_at) > now_ts - interval '8 days'
      order by x.starts_at, x.enrolment_id, x.sequence limit 500 loop
    a := academy_private.activity_json(i, now_ts);
    if a->>'state' in ('OPEN','UPCOMING')
      and coalesce((a->>'closesAt')::timestamptz, i.ends_at) > now_ts then
      return a;
    end if;
  end loop;
  return null;
end $$;

create function academy_private.class_evidence(p_enrolment_id uuid, p_root_item uuid, p_lesson_ref text) returns jsonb
language sql stable security definer set search_path='' as $$
  with cl as (select c.id from public.academy_professor_classrooms c where c.schedule_item_id = p_root_item and c.enrolment_id = p_enrolment_id),
  obj as (select o.* from public.academy_enrolments e join public.academy_course_lessons l on l.course_id = e.course_id and l.lesson_ref = p_lesson_ref
    join public.lesson_objectives o on o.lesson_id = l.lesson_id where e.id = p_enrolment_id)
  select jsonb_build_object(
    'checkedInAt', (select a.checked_in_at from public.academy_class_attendance a where a.enrolment_id = p_enrolment_id and a.schedule_item_id = p_root_item),
    'correctInClassAnswers', (select count(*)::integer from public.academy_class_checks k where k.classroom_id in (select id from cl) and k.correct),
    'lessonObjectives', coalesce((select jsonb_agg(jsonb_build_object('ref', o.id, 'title', o.description,
        'covered', exists (select 1 from public.academy_class_covered_objectives v where v.classroom_id in (select id from cl) and v.objective_id = o.id))
        order by o.position) from obj o), '[]'::jsonb),
    'topicsCovered', coalesce((select jsonb_agg(o.description order by o.position) from obj o
        where exists (select 1 from public.academy_class_covered_objectives v where v.classroom_id in (select id from cl) and v.objective_id = o.id)), '[]'::jsonb))
$$;

create function academy_private.released_results(p_enrolment_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'courseTitle', c.title,
      'assessmentRef', x->>'assessmentRef', 'assessmentTitle', coalesce(x->>'title', x->>'assessmentRef'),
      'kind', coalesce(x->>'kind', 'ASSESSMENT'), 'releasedAt', x->'releasedAt',
      'bestScore', (x->>'bestScore')::integer, 'maxScore', (x->>'maxScore')::integer,
      'attemptsUsed', (x->>'attemptsUsed')::integer,
      'passed', case when x->>'passMarkBp' is null then null else (x->>'scoreBp')::integer >= (x->>'passMarkBp')::integer end,
      -- The learner's own submitted attempt whose released review opens from
      -- this result (highest score, then the latest); null with no attempt.
      'reviewAttemptId', (select t.id from public.academy_assessment_attempts t
        where t.enrolment_id = e.id and t.assessment_ref = x->>'assessmentRef' and t.state = 'SUBMITTED'
        order by t.score * 10000 / t.max_score desc, t.attempt_number desc limit 1))
    order by (x->>'releasedAt')::timestamptz, x->>'assessmentRef'), '[]'::jsonb)
  from public.academy_enrolments e join public.academy_courses c on c.id = e.course_id
  cross join lateral jsonb_array_elements(academy_private.results(e.id)->'components') x
  where e.id = p_enrolment_id and x->>'source' = 'ASSESSMENT' and (x->>'released')::boolean
$$;

create function public.list_my_academy_released_results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); e public.academy_enrolments%rowtype; out jsonb := '[]';
begin
  if p_enrolment_id is not null then
    e := academy_private.my_enrolment_history(p_enrolment_id);
    return academy_private.released_results(e.id);
  end if;
  for e in select * from public.academy_enrolments where learner_id = actor order by created_at desc, id loop
    out := out || academy_private.released_results(e.id);
  end loop;
  return out;
end $$;

create function academy_private.progression(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype; s public.academy_schedules%rowtype; pkg jsonb; now_ts timestamptz := clock_timestamp();
  total integer := 0; attended integer := 0; missed integer := 0; i public.academy_schedule_items%rowtype; st text; w record; released integer := 0; spec jsonb;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = e.course_id;
  s := academy_private.current_schedule(e.id);
  if s.id is not null then
    for i in select * from public.academy_schedule_items where schedule_id = s.id and kind = 'LESSON' order by sequence loop
      select x.opens_at, x.closes_at into w from academy_private.item_window(i.id) x;
      st := academy_private.activity_state(i, coalesce(w.opens_at, i.starts_at), w.closes_at, now_ts);
      total := total + 1;
      if st = 'ATTENDED' then attended := attended + 1; elsif st = 'MISSED' then missed := missed + 1; end if;
    end loop;
  end if;
  for spec in select value from jsonb_array_elements(pkg->'assessments') loop
    if academy_private.assessment_released(e.id, spec->>'templateRef') then released := released + 1; end if;
  end loop;
  return jsonb_build_object('enrolmentId', e.id,
    'classes', jsonb_build_object('total', total, 'attended', attended, 'missed', missed),
    'objectives', jsonb_build_object(
      'total', (select count(*)::integer from public.academy_course_lessons cl join public.lesson_objectives o on o.lesson_id = cl.lesson_id where cl.course_id = e.course_id),
      'demonstrated', (select count(*)::integer from public.academy_objective_mastery m where m.enrolment_id = e.id and m.state = 'DEMONSTRATED')),
    'practicals', jsonb_build_object(
      'total', (select count(distinct x.value->>'activityRef')::integer from jsonb_array_elements(pkg->'labs') x),
      'submitted', (select count(*)::integer from public.academy_lab_submissions l where l.enrolment_id = e.id),
      'graded', (select count(*)::integer from public.academy_lab_submissions l join public.academy_lab_marks m on m.submission_id = l.id where l.enrolment_id = e.id)),
    'assessments', jsonb_build_object('total', jsonb_array_length(coalesce(pkg->'assessments', '[]'::jsonb)), 'released', released),
    'completion', jsonb_build_object('completed', exists (select 1 from public.academy_completions c where c.enrolment_id = e.id),
      'completedAt', (select c.completed_at from public.academy_completions c where c.enrolment_id = e.id)));
end $$;

create function public.get_my_academy_progression(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
begin
  return academy_private.progression(e.id);
end $$;

-- One authorised read of the course workspace: course, current class (with
-- display-only class evidence), tutor availability, assessment centre,
-- practical, released results and progression.
create function public.get_my_academy_course_workspace(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
  s public.academy_schedules%rowtype; now_ts timestamptz := clock_timestamp(); revoked boolean; exam boolean;
  cls public.academy_schedule_items%rowtype; asmt public.academy_schedule_items%rowtype; lab public.academy_schedule_items%rowtype;
  class_json jsonb; asmt_json jsonb; lab_json jsonb; template jsonb; used integer; allowed integer; active_id uuid;
  w record; reason text; root uuid; act jsonb;
begin
  revoked := exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED');
  exam := academy_private.exam_active();
  s := academy_private.current_schedule(e.id);
  if s.id is not null then
    -- Current class: the LESSON whose window is open now, else the next one.
    select i.* into cls from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
      where i.schedule_id = s.id and i.kind = 'LESSON' and x.opens_at <= now_ts and now_ts < coalesce(x.closes_at, i.ends_at)
      order by i.starts_at, i.sequence limit 1;
    if cls.id is null then
      select i.* into cls from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
        where i.schedule_id = s.id and i.kind = 'LESSON' and x.opens_at > now_ts order by i.starts_at, i.sequence limit 1;
    end if;
    if cls.id is not null then
      root := academy_private.root_schedule_item(cls.id);
      class_json := academy_private.activity_json(cls, now_ts) || jsonb_build_object(
        'evidence', academy_private.class_evidence(e.id, root, cls.ref),
        'classroomId', (select c.id from public.academy_professor_classrooms c where c.schedule_item_id = root));
    end if;
    -- Assessment centre: an active attempt's sitting, else an open sitting
    -- with attempts remaining, else any open sitting, else the next one.
    select i.* into asmt from public.academy_schedule_items i
      where i.schedule_id = s.id and i.kind = 'ASSESSMENT' and exists (select 1 from public.academy_assessment_attempts t
        where t.enrolment_id = e.id and t.assessment_ref = i.ref and t.state = 'ACTIVE') order by i.sequence limit 1;
    if asmt.id is null then
      select i.* into asmt from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
        where i.schedule_id = s.id and i.kind = 'ASSESSMENT' and x.opens_at <= now_ts and now_ts < x.closes_at
          and (select count(*) from public.academy_assessment_attempts t where t.enrolment_id = e.id and t.assessment_ref = i.ref)
            < academy_private.attempts_allowed(academy_private.assessment_template(e.course_id, i.ref))
        order by i.starts_at, i.sequence limit 1;
    end if;
    if asmt.id is null then
      select i.* into asmt from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
        where i.schedule_id = s.id and i.kind = 'ASSESSMENT' and x.opens_at <= now_ts and now_ts < x.closes_at
        order by i.starts_at, i.sequence limit 1;
    end if;
    if asmt.id is null then
      select i.* into asmt from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
        where i.schedule_id = s.id and i.kind = 'ASSESSMENT' and x.opens_at > now_ts order by i.starts_at, i.sequence limit 1;
    end if;
    if asmt.id is not null then
      act := academy_private.activity_json(asmt, now_ts);
      template := academy_private.assessment_template(e.course_id, asmt.ref);
      allowed := academy_private.attempts_allowed(template);
      select count(*)::integer into used from public.academy_assessment_attempts t where t.enrolment_id = e.id and t.assessment_ref = asmt.ref;
      select t.id into active_id from public.academy_assessment_attempts t where t.enrolment_id = e.id and t.assessment_ref = asmt.ref and t.state = 'ACTIVE';
      reason := case
        when revoked then 'ACCESS_REVOKED'
        when e.status <> 'ACTIVE' then 'ENROLMENT_CLOSED'
        when active_id is not null then 'ATTEMPT_ACTIVE'
        when now_ts < (act->>'opensAt')::timestamptz then 'SITTING_NOT_OPEN'
        when act->>'closesAt' is null or now_ts >= (act->>'closesAt')::timestamptz then 'SITTING_CLOSED'
        when used >= allowed then 'NO_ATTEMPTS_REMAINING'
        when exists (select 1 from public.academy_assessment_attempts t where t.learner_id = e.learner_id and t.state = 'ACTIVE')
          or exists (select 1 from public.assessment_attempts t where t.student_id = e.learner_id and t.state = 'ACTIVE' and t.expires_at > now_ts)
          then 'ANOTHER_ASSESSMENT_ACTIVE'
        when academy_private.schedule_conflict(e.learner_id, e.id, now_ts,
            least(now_ts + make_interval(mins => (template->>'durationMinutes')::integer), (act->>'closesAt')::timestamptz)) is not null
          then 'SCHEDULE_CONFLICT'
        end;
      asmt_json := jsonb_build_object('itemId', asmt.id, 'ref', asmt.ref, 'title', act->'title',
        'opensAt', act->'opensAt', 'closesAt', act->'closesAt', 'durationMinutes', (template->>'durationMinutes')::integer,
        'attemptsUsed', used, 'attemptsAllowed', allowed, 'activeAttemptId', active_id, 'state', act->'state',
        'canStart', reason is null, 'reason', reason);
    end if;
    -- Practical: the LAB open now, else the next one.
    select i.* into lab from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
      where i.schedule_id = s.id and i.kind = 'LAB' and x.opens_at <= now_ts and now_ts < coalesce(x.closes_at, i.ends_at)
      order by i.starts_at, i.sequence limit 1;
    if lab.id is null then
      select i.* into lab from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) x
        where i.schedule_id = s.id and i.kind = 'LAB' and x.opens_at > now_ts order by i.starts_at, i.sequence limit 1;
    end if;
    if lab.id is not null then
      act := academy_private.activity_json(lab, now_ts);
      lab_json := jsonb_build_object('itemId', lab.id, 'ref', lab.ref, 'title', act->'title',
        'opensAt', act->'opensAt', 'closesAt', act->'closesAt', 'state', act->'state',
        'canAttend', not revoked and e.status = 'ACTIVE' and not exam and now_ts >= (act->>'opensAt')::timestamptz
          and (act->>'closesAt' is null or now_ts < (act->>'closesAt')::timestamptz),
        'submitted', exists (select 1 from public.academy_lab_submissions l where l.enrolment_id = e.id and l.lab_ref = lab.ref),
        'graded', exists (select 1 from public.academy_lab_submissions l join public.academy_lab_marks m on m.submission_id = l.id
          where l.enrolment_id = e.id and l.lab_ref = lab.ref));
    end if;
  end if;
  return jsonb_build_object('course', academy_private.learner_course_json(e.id),
    'currentClass', class_json, 'tutorAvailable', not exam and not revoked and e.status = 'ACTIVE',
    'assessment', asmt_json, 'lab', lab_json,
    'results', academy_private.released_results(e.id), 'progression', academy_private.progression(e.id));
end $$;

-- ==========================================================================
-- Section 11: monthly assessment leaderboards. Cohort: enrolments in the
-- same course whose FIRST attempt at the assessment started in the UTC
-- month; RELEASED, unrevoked entries only; best score per attemptScoring;
-- ties by the earlier first-attempt start, then enrolment id; top 10;
-- pseudonymous labels, the caller's own row labelled "You".
-- ==========================================================================
create function academy_private.leaderboard_label(p_course uuid, p_ref text, p_month date, p_enrolment uuid) returns text
language sql immutable set search_path='' as $$
  select 'Learner ' || upper(left(encode(extensions.digest(convert_to(
    'DUCELIO_LEADERBOARD_V1:' || p_course::text || ':' || p_ref || ':' || to_char(p_month, 'YYYY-MM') || ':' || p_enrolment::text, 'UTF8'),
    'sha256'), 'hex'), 6))
$$;

create function public.get_my_academy_assessment_leaderboard(p_enrolment_id uuid, p_assessment_ref text, p_month date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
  course public.academy_courses%rowtype; spec jsonb; template jsonb; v_month date; from_ts timestamptz; to_ts timestamptz; entries jsonb;
begin
  if p_assessment_ref is null or p_month is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into course from public.academy_courses where id = e.course_id;
  select x.value into spec from public.academy_course_packages p, jsonb_array_elements(p.raw_package->'assessments') x
    where p.id = course.package_id and x.value->>'templateRef' = p_assessment_ref;
  if spec is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  template := academy_private.assessment_template(course.id, p_assessment_ref);
  v_month := date_trunc('month', p_month)::date;
  from_ts := v_month::timestamp at time zone 'UTC';
  to_ts := (v_month + interval '1 month')::timestamp at time zone 'UTC';
  with cohort as (
    select x.id enrolment_id, f.started_at first_started
    from public.academy_enrolments x
    join public.academy_entitlements t on t.id = x.entitlement_id and t.state = 'ACTIVE'
    join public.academy_assessment_attempts f on f.enrolment_id = x.id and f.assessment_ref = p_assessment_ref and f.attempt_number = 1
    where x.course_id = course.id and f.started_at >= from_ts and f.started_at < to_ts
  ), scored as (
    select c.enrolment_id, c.first_started, b.score best, b.max_score best_max
    from cohort c cross join lateral (
      select t.score, t.max_score from public.academy_assessment_attempts t
      where t.enrolment_id = c.enrolment_id and t.assessment_ref = p_assessment_ref and t.state = 'SUBMITTED'
      order by case when spec->>'attemptScoring' = 'LATEST' then t.attempt_number end desc nulls last,
        t.score * 10000 / t.max_score desc, t.attempt_number limit 1) b
    where academy_private.assessment_released(c.enrolment_id, p_assessment_ref)
  ), ranked as (
    select s.*, row_number() over (order by s.best desc, s.first_started asc, s.enrolment_id asc) as rank from scored s
  )
  select coalesce(jsonb_agg(jsonb_build_object('rank', r.rank,
      'label', case when r.enrolment_id = e.id then 'You' else academy_private.leaderboard_label(course.id, p_assessment_ref, v_month, r.enrolment_id) end,
      'bestScore', r.best, 'maxScore', r.best_max, 'isMe', r.enrolment_id = e.id) order by r.rank), '[]'::jsonb)
  into entries from ranked r where r.rank <= 10;
  return jsonb_build_object('ok', true, 'courseTitle', course.title, 'assessmentRef', p_assessment_ref,
    'assessmentTitle', coalesce(template->>'title', p_assessment_ref), 'month', to_char(v_month, 'YYYY-MM'), 'entries', entries);
end $$;

-- Available (enrolment, assessment, month) boards for the caller's courses:
-- only months with at least one released entry.
create function public.list_my_academy_leaderboards() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', b.enrolment_id, 'courseTitle', b.course_title,
      'assessmentRef', b.ref, 'assessmentTitle', b.title, 'month', b.board_month) order by b.course_title, b.enrolment_id, b.pos, b.board_month desc)
    from (
      select distinct e.id as enrolment_id, c.title as course_title, a.value->>'templateRef' as ref, a.ordinality as pos,
        coalesce(academy_private.unit_title(p.raw_package, 'ASSESSMENT', a.value->>'templateRef'), a.value->>'templateRef') as title,
        to_char(date_trunc('month', f.started_at at time zone 'UTC'), 'YYYY-MM') as board_month
      from public.academy_enrolments e
      join public.academy_courses c on c.id = e.course_id
      join public.academy_course_packages p on p.id = c.package_id
      cross join lateral jsonb_array_elements(p.raw_package->'assessments') with ordinality a
      join public.academy_enrolments x on x.course_id = e.course_id
      join public.academy_entitlements t on t.id = x.entitlement_id and t.state = 'ACTIVE'
      join public.academy_assessment_attempts f on f.enrolment_id = x.id and f.assessment_ref = a.value->>'templateRef' and f.attempt_number = 1
      where e.learner_id = actor and academy_private.assessment_released(x.id, a.value->>'templateRef')
        and exists (select 1 from public.academy_assessment_attempts g where g.enrolment_id = x.id
          and g.assessment_ref = a.value->>'templateRef' and g.state = 'SUBMITTED')
    ) b), '[]'::jsonb);
end $$;

-- ==========================================================================
-- Section 12: privileges, verified. Private helpers: no role. New public
-- RPCs: the authenticated role only.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('refresh_my_academy_releases','check_in_my_academy_class',
      'record_my_academy_class_evidence','get_my_academy_class_recap','list_my_academy_courses','list_my_academy_week',
      'get_my_academy_next_activity','list_my_academy_released_results','get_my_academy_progression',
      'get_my_academy_course_workspace','get_my_academy_assessment_leaderboard','list_my_academy_leaderboards',
      'list_my_academy_class_evidence') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

do $$ declare r text; t record; f record; n integer; begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('refresh_my_academy_releases','check_in_my_academy_class',
      'record_my_academy_class_evidence','get_my_academy_class_recap','list_my_academy_courses','list_my_academy_week',
      'get_my_academy_next_activity','list_my_academy_released_results','get_my_academy_progression',
      'get_my_academy_course_workspace','get_my_academy_assessment_leaderboard','list_my_academy_leaderboards',
      'list_my_academy_class_evidence');
  if n <> 13 then raise exception 'Learner academic RPC inventory drift (%)', n; end if;
  foreach r in array array['anon','authenticated','service_role'] loop
    for t in select c.oid from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'public' and c.relkind = 'r' and c.relname in ('academy_assessment_releases','academy_class_attendance',
        'academy_class_evidence_records','academy_class_checks','academy_class_covered_objectives') loop
      if has_table_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe learner academic table privileges for %', r;
      end if;
    end loop;
    for f in select p.oid, s.nspname, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'academy_private' or (s.nspname = 'public' and p.proname in ('refresh_my_academy_releases',
        'check_in_my_academy_class','record_my_academy_class_evidence','get_my_academy_class_recap','list_my_academy_courses',
        'list_my_academy_week','get_my_academy_next_activity','list_my_academy_released_results','get_my_academy_progression',
        'get_my_academy_course_workspace','get_my_academy_assessment_leaderboard','list_my_academy_leaderboards',
        'list_my_academy_class_evidence','start_my_academy_assessment','get_my_academy_attempt','record_my_academy_response','submit_my_academy_attempt',
        'get_my_academy_results','list_my_academy_enrolments','open_my_academy_professor_classroom')) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (f.nspname = 'public' and r = 'authenticated') then
        raise exception 'Unsafe learner academic function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
