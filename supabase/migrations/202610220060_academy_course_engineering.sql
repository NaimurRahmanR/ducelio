-- Ducelio Academy (B2C) Course Engineering and individual delivery.
-- Additive. Migrations 001-059 are unchanged, and so is every existing
-- organisation/cohort table, RPC, policy and grant.
--
-- A complete ACADEMY_COURSE_PACKAGE_V1 (src/domain/academy-course-package.ts)
-- embeds an unchanged COURSE_PACKAGE_V1 curriculum. The curriculum is
-- materialised through the EXISTING Course & Agent Engineering pipeline
-- (import -> validate -> apply -> agent configuration -> pre-publication
-- test -> publish, migrations 024/035/036/050). This migration adds only what
-- that pipeline and the cohort-bound activation (027) cannot express:
--
--   * the Academy package register and its review/publication lifecycle;
--   * the published delivery blueprint (fixed unit order, formats, grading);
--   * Academy offers with per-format prices supplied explicitly at publish;
--   * a learner-scoped entitlement and enrolment WITHOUT a cohort or
--     instructor (the existing enrolments/assessments/attempts tables carry
--     NOT NULL cohort and instructor foreign keys and are left untouched);
--   * the authoritative personal timetable planner (academy_private.plan_
--     units), mirrored by src/domain/academy-scheduler.ts and parity-tested;
--   * server-owned assessment sittings that reuse migration 059's objective
--     question validators and scorer (assessment_interaction_private), lab
--     submissions marked against the package rubric, results and
--     completion.
--
-- Security model: every table below has RLS enabled and NO privileges for
-- anon, authenticated or service_role. All access is through SECURITY
-- DEFINER RPCs that derive the actor from auth.uid() (current_app_user),
-- never from an argument. Answer keys, expected answers, marking guidance
-- and lab marking guidance never leave the database through a learner RPC.
-- Time is always the database clock; the browser never supplies "now".

create schema academy_private;
revoke all on schema academy_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 1: fixed vocabulary.
-- ==========================================================================
create function academy_private.format_weeks(p_format text) returns integer
language sql immutable set search_path='' as $$
  select case p_format
    when 'ACCELERATED_2W' then 2 when 'INTENSIVE_4W' then 4 when 'STANDARD_6W' then 6
    when 'EXTENDED_8W' then 8 when 'FLEXIBLE_12W' then 12 end
$$;

create function academy_private.require_course_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return actor;
end $$;

create function academy_private.require_student() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return actor;
end $$;

create function academy_private.require_reason(p_reason text) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'INVALID_INPUT';
  end if;
  return trim(p_reason);
end $$;

-- ==========================================================================
-- Section 2: tables.
-- ==========================================================================
create table public.academy_course_packages (
  id uuid primary key default gen_random_uuid(),
  package_key text not null check (package_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(package_key) between 3 and 80),
  package_revision integer not null check (package_revision between 1 and 100000),
  schema_version text not null check (schema_version = 'ACADEMY_COURSE_PACKAGE_V1'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  raw_package jsonb not null check (jsonb_typeof(raw_package) = 'object' and pg_column_size(raw_package) <= 4194304),
  status text not null default 'UPLOADED' check (status in ('UPLOADED','VALIDATED','PUBLISHED','REJECTED')),
  -- Admin-only review summary written at validation. Contains counts,
  -- titles, durations, weights and format estimates; never answers.
  review jsonb,
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  validated_by uuid references public.app_users(id),
  validated_at timestamptz,
  published_by uuid references public.app_users(id),
  published_at timestamptz,
  rejected_by uuid references public.app_users(id),
  rejected_at timestamptz,
  rejected_reason text check (rejected_reason is null or length(rejected_reason) between 5 and 300),
  unique (package_key, package_revision),
  check (
    (status = 'UPLOADED' and review is null and validated_at is null and published_at is null and rejected_at is null)
    or (status = 'VALIDATED' and review is not null and validated_by is not null and validated_at is not null and published_at is null and rejected_at is null)
    or (status = 'PUBLISHED' and review is not null and validated_at is not null and published_by is not null and published_at is not null and rejected_at is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null and rejected_reason is not null and published_at is null)
  )
);

-- The published, immutable academic blueprint of one package revision.
create table public.academy_courses (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null unique references public.academy_course_packages(id),
  curriculum_import_id uuid not null unique references public.course_package_imports(id),
  programme_version_id uuid not null unique references public.programme_versions(id),
  title text not null check (length(title) between 1 and 200),
  units jsonb not null check (jsonb_typeof(units) = 'array' and jsonb_array_length(units) between 1 and 5000),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp()
);

create table public.academy_course_lessons (
  course_id uuid not null references public.academy_courses(id),
  sequence integer not null check (sequence > 0),
  lesson_ref text not null,
  lesson_id uuid not null references public.lessons(id),
  primary key (course_id, sequence),
  unique (course_id, lesson_ref),
  unique (course_id, lesson_id)
);

create table public.academy_offers (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null unique references public.academy_courses(id),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  summary text check (summary is null or length(summary) between 1 and 500),
  state text not null default 'PUBLISHED' check (state in ('PUBLISHED','ARCHIVED')),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp(),
  archived_by uuid references public.app_users(id),
  archived_at timestamptz,
  check ((state = 'PUBLISHED' and archived_at is null) or (state = 'ARCHIVED' and archived_at is not null and archived_by is not null))
);

-- One approved price per offered format. Only formats the published
-- blueprint supports can be priced (checked at publication).
create table public.academy_offer_formats (
  offer_id uuid not null references public.academy_offers(id),
  format_id text not null check (academy_private.format_weeks(format_id) is not null),
  session_minutes integer not null check (session_minutes between 30 and 480),
  min_study_days integer not null check (min_study_days between 1 and 7),
  max_study_days integer not null check (max_study_days between min_study_days and 7),
  price_amount_minor integer not null check (price_amount_minor between 1 and 100000000),
  primary key (offer_id, format_id)
);

create table public.academy_entitlements (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.app_users(id),
  offer_id uuid not null references public.academy_offers(id),
  course_id uuid not null references public.academy_courses(id),
  -- Fixed by the purchased/granted terms, or null: the learner chooses once
  -- among the offer's formats when confirming a timetable.
  format_id text check (format_id is null or academy_private.format_weeks(format_id) is not null),
  source text not null check (source in ('COMPLIMENTARY_GRANT')),
  granted_by uuid not null references public.app_users(id),
  reason text not null check (length(reason) between 5 and 300),
  created_at timestamptz not null default clock_timestamp(),
  unique (learner_id, course_id),
  unique (id, learner_id, course_id)
);

create table public.academy_enrolments (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null unique,
  learner_id uuid not null,
  course_id uuid not null,
  programme_version_id uuid not null references public.programme_versions(id),
  format_id text check (format_id is null or academy_private.format_weeks(format_id) is not null),
  format_locked_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','COMPLETED')),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (entitlement_id, learner_id, course_id) references public.academy_entitlements(id, learner_id, course_id),
  unique (id, learner_id),
  check ((format_id is null) = (format_locked_at is null)),
  check ((status = 'COMPLETED') = (completed_at is not null))
);

create table public.academy_schedules (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.academy_enrolments(id),
  revision integer not null check (revision between 1 and 50),
  format_id text not null check (academy_private.format_weeks(format_id) is not null),
  start_on date not null,
  end_on date not null,
  study_days integer[] not null check (cardinality(study_days) between 1 and 7 and study_days <@ array[1,2,3,4,5,6,7]),
  local_time time not null,
  timezone text not null check (length(timezone) between 1 and 100),
  -- Items starting before this instant were carried unchanged from the
  -- previous revision; revision 1 has no carried items.
  effective_from timestamptz not null,
  request_key uuid not null,
  plan_summary jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  unique (enrolment_id, revision),
  unique (enrolment_id, request_key),
  check (end_on = start_on + academy_private.format_weeks(format_id) * 7 - 1)
);
create unique index academy_schedules_current on public.academy_schedules(enrolment_id) where superseded_at is null;

create table public.academy_schedule_items (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.academy_schedules(id),
  enrolment_id uuid not null references public.academy_enrolments(id),
  sequence integer not null check (sequence > 0),
  unit_index integer not null check (unit_index >= 0),
  kind text not null check (kind in ('LESSON','LAB','REVISION','ASSESSMENT')),
  ref text not null check (length(ref) between 1 and 80),
  part integer not null check (part >= 1),
  parts integer not null check (parts >= part),
  session_index integer not null check (session_index >= 0),
  local_date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  minutes integer not null check (minutes > 0),
  opens_at timestamptz,
  closes_at timestamptz,
  carried_from uuid references public.academy_schedule_items(id),
  unique (schedule_id, sequence),
  check (ends_at > starts_at),
  check ((kind = 'ASSESSMENT') = (opens_at is not null and closes_at is not null)),
  check (closes_at is null or closes_at > opens_at)
);
create index academy_schedule_items_enrolment on public.academy_schedule_items(enrolment_id, kind, ref);

create table public.academy_assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  learner_id uuid not null,
  assessment_ref text not null,
  attempt_number integer not null check (attempt_number between 1 and 5),
  schedule_item_id uuid not null references public.academy_schedule_items(id),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','SUBMITTED')),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  submitted_at timestamptz,
  submission text check (submission in ('STUDENT_SUBMIT','AUTO_TIMEOUT')),
  score integer check (score >= 0),
  max_score integer check (max_score > 0),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id),
  unique (enrolment_id, assessment_ref, attempt_number),
  check (expires_at > started_at),
  check ((state = 'ACTIVE' and submitted_at is null and submission is null and score is null)
      or (state = 'SUBMITTED' and submitted_at is not null and submission is not null and score is not null and max_score is not null and score <= max_score))
);
create unique index academy_assessment_attempts_one_active
  on public.academy_assessment_attempts(enrolment_id, assessment_ref) where state = 'ACTIVE';

create table public.academy_assessment_responses (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references public.academy_assessment_attempts(id),
  question_position integer not null check (question_position > 0),
  body text not null check (length(body) between 1 and 20000),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (attempt_id, idempotency_key)
);

create table public.academy_question_marks (
  attempt_id uuid not null references public.academy_assessment_attempts(id),
  question_position integer not null,
  marks integer not null check (marks >= 0),
  max_marks integer not null check (max_marks > 0 and marks <= max_marks),
  primary key (attempt_id, question_position)
);

create table public.academy_lab_submissions (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  learner_id uuid not null,
  lab_ref text not null,
  body text not null check (length(trim(body)) between 1 and 20000),
  request_key uuid not null,
  submitted_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id),
  unique (enrolment_id, lab_ref)
);

create table public.academy_lab_marks (
  submission_id uuid primary key references public.academy_lab_submissions(id),
  criterion_marks jsonb not null check (jsonb_typeof(criterion_marks) = 'object'),
  marks integer not null check (marks >= 0),
  max_marks integer not null check (max_marks > 0 and marks <= max_marks),
  marked_by uuid not null references public.app_users(id),
  marked_at timestamptz not null default clock_timestamp(),
  reason text not null check (length(reason) between 5 and 300)
);

create table public.academy_completions (
  enrolment_id uuid primary key references public.academy_enrolments(id),
  course_score_bp integer not null check (course_score_bp between 0 and 10000),
  pass_mark_bp integer not null check (pass_mark_bp between 1 and 10000 and course_score_bp >= pass_mark_bp),
  component_scores jsonb not null,
  completed_at timestamptz not null default clock_timestamp()
);

-- History guards: academic records are append-only. The few permitted
-- transitions are named explicitly; everything else is refused, including
-- for the table owner's own definer functions.
create function academy_private.guard_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'DELETE' then raise exception 'IMMUTABLE_HISTORY'; end if;
  if tg_table_name = 'academy_course_packages' then
    if new.id <> old.id or new.raw_package <> old.raw_package or new.content_hash <> old.content_hash
      or new.package_key <> old.package_key or new.package_revision <> old.package_revision
      or old.status in ('PUBLISHED','REJECTED')
      or (old.status = 'VALIDATED' and new.status not in ('PUBLISHED','REJECTED'))
      or (old.status = 'VALIDATED' and new.review is distinct from old.review) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_offers' then
    if new.id <> old.id or new.course_id <> old.course_id or new.slug <> old.slug or new.currency <> old.currency
      or new.summary is distinct from old.summary or old.state <> 'PUBLISHED' or new.state <> 'ARCHIVED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_enrolments' then
    if new.id <> old.id or new.entitlement_id <> old.entitlement_id or new.learner_id <> old.learner_id
      or new.course_id <> old.course_id or new.programme_version_id <> old.programme_version_id
      or (old.format_id is not null and (new.format_id is distinct from old.format_id or new.format_locked_at is distinct from old.format_locked_at))
      or old.status = 'COMPLETED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_schedules' then
    if (to_jsonb(new) - 'superseded_at') <> (to_jsonb(old) - 'superseded_at') or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_assessment_attempts' then
    if old.state <> 'ACTIVE' or (to_jsonb(new) - array['state','submitted_at','submission','score','max_score'])
        <> (to_jsonb(old) - array['state','submitted_at','submission','score','max_score']) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  else
    raise exception 'IMMUTABLE_HISTORY';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['academy_course_packages','academy_courses','academy_course_lessons','academy_offers',
    'academy_offer_formats','academy_entitlements','academy_enrolments','academy_schedules','academy_schedule_items',
    'academy_assessment_attempts','academy_assessment_responses','academy_question_marks','academy_lab_submissions',
    'academy_lab_marks','academy_completions'] loop
    execute format('create trigger guard_history before update or delete on public.%I for each row execute function academy_private.guard_history()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ==========================================================================
-- Section 3: blueprint derivation and the authoritative planner. Mirrors
-- buildPlanUnits / planSchedule (src/domain/academy-*.ts) exactly.
-- ==========================================================================
create function academy_private.ordered_lessons(p_curriculum jsonb)
returns table(idx integer, lesson_key text, module_position integer, lesson_position integer, lesson jsonb)
language sql immutable set search_path='' as $$
  select (row_number() over (order by (m.value->>'position')::integer, (l.value->>'position')::integer) - 1)::integer,
         l.value->>'key', (m.value->>'position')::integer, (l.value->>'position')::integer, l.value
  from jsonb_array_elements(p_curriculum->'modules') m, jsonb_array_elements(m.value->'lessons') l
  order by 1
$$;

create function academy_private.build_units(p jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
  result jsonb := '[]';
  l record; lab record; a record; template jsonb;
begin
  for l in select * from academy_private.ordered_lessons(p->'curriculum') loop
    result := result || jsonb_build_array(jsonb_build_object(
      'kind','LESSON','ref',l.lesson_key,'minDays',0,
      'minutes',(select (w->>'teachingMinutes')::integer from jsonb_array_elements(p->'workload'->'lessons') w
                 where w->>'lessonRef' = l.lesson_key)));
    for lab in
      with act as (
        select pa.value->>'key' as key, o.idx, o.lesson_key, (pa.value->>'position')::integer as pos
        from academy_private.ordered_lessons(p->'curriculum') o, jsonb_array_elements(o.lesson->'practicalActivities') pa)
      select lb.value as spec from jsonb_array_elements(p->'labs') lb join act on act.key = lb.value->>'activityRef'
      where coalesce(lb.value->>'afterLessonRef', act.lesson_key) = l.lesson_key
      order by act.idx, act.pos
    loop
      result := result || jsonb_build_array(jsonb_build_object(
        'kind','LAB','ref',lab.spec->>'activityRef','minutes',(lab.spec->>'durationMinutes')::integer,'minDays',0));
    end loop;
    for a in select x.value as spec from jsonb_array_elements(p->'assessments') with ordinality x
             where x.value->>'afterLessonRef' = l.lesson_key order by x.ordinality loop
      select t.value into template from jsonb_array_elements(p->'curriculum'->'assessmentTemplates') t
      where t.value->>'key' = a.spec->>'templateRef';
      if (a.spec->'preparation'->>'revisionMinutes')::integer > 0 then
        result := result || jsonb_build_array(jsonb_build_object('kind','REVISION','ref',a.spec->>'templateRef',
          'minutes',(a.spec->'preparation'->>'revisionMinutes')::integer,'minDays',0));
      end if;
      result := result || jsonb_build_array(jsonb_build_object('kind','ASSESSMENT','ref',a.spec->>'templateRef',
        'minutes',(template->>'durationMinutes')::integer,
        'minDays',(a.spec->'preparation'->>'minimumDaysAfterTeaching')::integer,
        'windowHours',(a.spec->>'sittingWindowHours')::integer));
    end loop;
  end loop;
  return result;
end $$;

-- Pure local-calendar planner. Returns {feasible:true, items:[...]} or
-- {feasible:false, code:'INSUFFICIENT_AVAILABILITY', ...}.
create function academy_private.plan_units(
  p_units jsonb, p_weeks integer, p_session_minutes integer, p_start date, p_days integer[],
  p_from date, p_last_teaching date, p_first_part_offset integer
) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
  end_on date := p_start + p_weeks * 7 - 1;
  slots date[] := '{}';
  used integer[];
  d date;
  n integer;
  slot integer := 1;
  u integer;
  unit jsonb;
  kind text;
  minutes integer;
  remaining integer;
  part integer;
  take integer;
  earliest date;
  last_teaching date := p_last_teaching;
  items jsonb := '[]';
  parts jsonb := '{}';
  total integer;
begin
  d := greatest(coalesce(p_from, p_start), p_start);
  while d <= end_on loop
    if extract(isodow from d)::integer = any(p_days) then slots := slots || d; end if;
    d := d + 1;
  end loop;
  n := coalesce(array_length(slots, 1), 0);
  used := array_fill(0, array[greatest(n, 1)]);
  select coalesce(sum((x->>'minutes')::integer), 0) into total from jsonb_array_elements(p_units) x;
  for u in 0 .. jsonb_array_length(p_units) - 1 loop
    unit := p_units->u;
    kind := unit->>'kind';
    minutes := (unit->>'minutes')::integer;
    if kind in ('LESSON','REVISION') then
      remaining := minutes;
      part := case when u = 0 then coalesce(p_first_part_offset, 0) else 0 end;
      while remaining > 0 loop
        if slot > n then
          return jsonb_build_object('feasible',false,'code','INSUFFICIENT_AVAILABILITY','firstUnscheduledUnit',u,
            'requiredMinutes',total,'availableSessions',n,'startDate',p_start,'endDate',end_on);
        end if;
        if p_session_minutes - used[slot] <= 0 then slot := slot + 1; continue; end if;
        take := least(p_session_minutes - used[slot], remaining);
        part := part + 1;
        items := items || jsonb_build_array(jsonb_build_object('sequence',jsonb_array_length(items) + 1,'unitIndex',u,
          'kind',kind,'ref',unit->>'ref','part',part,'sessionIndex',slot - 1,'localDate',slots[slot],
          'offsetMinutes',used[slot],'minutes',take));
        used[slot] := used[slot] + take;
        remaining := remaining - take;
        if kind = 'LESSON' then last_teaching := slots[slot]; end if;
      end loop;
      parts := parts || jsonb_build_object(u::text, part);
    else
      earliest := case when kind = 'ASSESSMENT' and last_teaching is not null
        then last_teaching + coalesce((unit->>'minDays')::integer, 0) end;
      loop
        if slot > n then
          return jsonb_build_object('feasible',false,'code','INSUFFICIENT_AVAILABILITY','firstUnscheduledUnit',u,
            'requiredMinutes',total,'availableSessions',n,'startDate',p_start,'endDate',end_on);
        end if;
        exit when p_session_minutes - used[slot] >= minutes and (earliest is null or slots[slot] >= earliest);
        slot := slot + 1;
      end loop;
      items := items || jsonb_build_array(jsonb_build_object('sequence',jsonb_array_length(items) + 1,'unitIndex',u,
        'kind',kind,'ref',unit->>'ref','part',1,'sessionIndex',slot - 1,'localDate',slots[slot],
        'offsetMinutes',used[slot],'minutes',minutes));
      used[slot] := used[slot] + minutes;
      parts := parts || jsonb_build_object(u::text, 1);
    end if;
  end loop;
  return jsonb_build_object('feasible',true,'startDate',p_start,'endDate',end_on,
    'items',(select coalesce(jsonb_agg(i || jsonb_build_object('parts',(parts->>(i->>'unitIndex'))::integer) order by (i->>'sequence')::integer), '[]')
             from jsonb_array_elements(items) i));
end $$;

-- Defence-in-depth structural checks of the invariants the database relies
-- on. The TypeScript validator is the primary, actionable gate.
create function academy_private.assert_package_valid(p jsonb) returns void
language plpgsql stable set search_path='' as $$
declare c jsonb := p->'curriculum'; bad integer; total integer; f jsonb; q record;
begin
  if p->>'schemaVersion' is distinct from 'ACADEMY_COURSE_PACKAGE_V1' or jsonb_typeof(c) is distinct from 'object'
    or c->>'schemaVersion' is distinct from 'COURSE_PACKAGE_V1'
    or c->>'packageKey' is distinct from p->>'packageKey' or c->>'packageRevision' is distinct from p->>'packageRevision' then
    raise exception 'ACADEMY_PACKAGE_INVALID: identity';
  end if;
  select count(*) into bad from academy_private.ordered_lessons(c) o
  where (select count(*) from jsonb_array_elements(p->'workload'->'lessons') w where w->>'lessonRef' = o.lesson_key) <> 1;
  if bad > 0 or jsonb_array_length(p->'workload'->'lessons') <> (select count(*) from academy_private.ordered_lessons(c)) then
    raise exception 'ACADEMY_PACKAGE_INVALID: workload';
  end if;
  select count(*) into bad from academy_private.ordered_lessons(c) o, jsonb_array_elements(o.lesson->'practicalActivities') pa
  where (select count(*) from jsonb_array_elements(p->'labs') lb where lb.value->>'activityRef' = pa.value->>'key') <> 1;
  if bad > 0 or jsonb_array_length(p->'labs') <> (select count(*) from academy_private.ordered_lessons(c) o,
      jsonb_array_elements(o.lesson->'practicalActivities')) then
    raise exception 'ACADEMY_PACKAGE_INVALID: labs';
  end if;
  select count(*) into bad from jsonb_array_elements(c->'assessmentTemplates') t
  where (select count(*) from jsonb_array_elements(p->'assessments') a where a.value->>'templateRef' = t.value->>'key') <> 1
     or not exists (select 1 from academy_private.ordered_lessons(c) o, jsonb_array_elements(p->'assessments') a
                    where a.value->>'templateRef' = t.value->>'key' and o.lesson_key = a.value->>'afterLessonRef');
  if bad > 0 or jsonb_array_length(p->'assessments') <> jsonb_array_length(c->'assessmentTemplates') then
    raise exception 'ACADEMY_PACKAGE_INVALID: assessments';
  end if;
  select coalesce(sum((g->>'weightBp')::integer), 0) into total from jsonb_array_elements(p->'grading'->'components') g;
  if total <> 10000 then raise exception 'ACADEMY_PACKAGE_INVALID: grading'; end if;
  for q in select t.value as template, x.value as question from jsonb_array_elements(c->'assessmentTemplates') t,
           jsonb_array_elements(t.value->'questions') x loop
    if coalesce(q.question->>'questionType', 'FREE_TEXT') = 'FREE_TEXT'
      or not assessment_interaction_private.interaction_is_valid(q.question->>'questionType', q.question->'interaction')
      or not assessment_interaction_private.answer_key_is_valid(q.question->>'questionType', q.question->'interaction', q.question->'answerKey') then
      raise exception 'ACADEMY_PACKAGE_INVALID: questions';
    end if;
  end loop;
  for f in select value from jsonb_array_elements(p->'deliveryFormats') loop
    if academy_private.format_weeks(f->>'formatId') is null
      or exists (select 1 from jsonb_array_elements(p->'labs') lb where (lb.value->>'durationMinutes')::integer > (f->>'sessionMinutes')::integer)
      or exists (select 1 from jsonb_array_elements(c->'assessmentTemplates') t where (t.value->>'durationMinutes')::integer > (f->>'sessionMinutes')::integer) then
      raise exception 'ACADEMY_PACKAGE_INVALID: formats';
    end if;
  end loop;
end $$;

-- Converts a feasible local plan into instants in the learner's timezone.
-- A local start time that does not exist on a session date (a daylight-
-- saving gap) is refused rather than silently moved, exactly like
-- DELIVERY_V1 (migration 023).
create function academy_private.timed_items(p_plan jsonb, p_units jsonb, p_time time, p_zone text) returns jsonb
language plpgsql stable set search_path='' as $$
declare i jsonb; result_items jsonb := '[]'; local_stamp timestamp; session_start timestamptz; starts timestamptz; unit jsonb;
begin
  for i in select value from jsonb_array_elements(p_plan->'items') order by (value->>'sequence')::integer loop
    local_stamp := (i->>'localDate')::date + p_time;
    session_start := local_stamp at time zone p_zone;
    if session_start at time zone p_zone <> local_stamp then
      return jsonb_build_object('feasible',false,'code','INVALID_LOCAL_TIME','localDate',i->>'localDate');
    end if;
    starts := session_start + make_interval(mins => (i->>'offsetMinutes')::integer);
    unit := p_units->((i->>'unitIndex')::integer);
    result_items := result_items || jsonb_build_array(i || jsonb_build_object(
      'startsAt', starts, 'endsAt', starts + make_interval(mins => (i->>'minutes')::integer),
      'opensAt', case when i->>'kind' = 'ASSESSMENT' then starts end,
      'closesAt', case when i->>'kind' = 'ASSESSMENT' then starts + make_interval(hours => (unit->>'windowHours')::integer) end));
  end loop;
  return jsonb_build_object('feasible',true,'items',result_items);
end $$;

-- ==========================================================================
-- Section 4: admin Course Engineering RPCs.
-- ==========================================================================
create function public.upload_academy_course_package(p_raw_package jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  hash text; existing public.academy_course_packages%rowtype; new_id uuid;
begin
  if jsonb_typeof(p_raw_package) is distinct from 'object' or p_raw_package->>'schemaVersion' is distinct from 'ACADEMY_COURSE_PACKAGE_V1'
    or coalesce(p_raw_package->>'packageKey', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or jsonb_typeof(p_raw_package->'packageRevision') is distinct from 'number'
    or (p_raw_package->>'packageRevision') !~ '^[1-9][0-9]{0,5}$' then
    raise exception 'MALFORMED_PACKAGE';
  end if;
  hash := encode(extensions.digest(p_raw_package::text, 'sha256'), 'hex');
  select * into existing from public.academy_course_packages
  where package_key = p_raw_package->>'packageKey' and package_revision = (p_raw_package->>'packageRevision')::integer for update;
  if found then
    if existing.content_hash = hash then return existing.id; end if;
    raise exception 'REVISION_CONFLICT';
  end if;
  insert into public.academy_course_packages(package_key, package_revision, schema_version, content_hash, raw_package, created_by)
  values (p_raw_package->>'packageKey', (p_raw_package->>'packageRevision')::integer, 'ACADEMY_COURSE_PACKAGE_V1', hash, p_raw_package, actor)
  returning id into new_id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_PACKAGE_UPLOADED', 'academy_course_packages', new_id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('package_key', p_raw_package->>'packageKey', 'package_revision', (p_raw_package->>'packageRevision')::integer, 'content_hash', hash));
  return new_id;
end $$;

create function public.mark_academy_course_package_validated(p_package_id uuid, p_review jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'VALIDATED' then return pkg.id; end if;
  if pkg.status <> 'UPLOADED' then raise exception 'INVALID_STATE'; end if;
  if jsonb_typeof(p_review) is distinct from 'object' or pg_column_size(p_review) > 262144
    or p_review->>'packageKey' is distinct from pkg.package_key then
    raise exception 'INVALID_INPUT';
  end if;
  perform academy_private.assert_package_valid(pkg.raw_package);
  update public.academy_course_packages set status = 'VALIDATED', review = p_review, validated_by = actor, validated_at = clock_timestamp()
  where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_PACKAGE_VALIDATED', 'academy_course_packages', pkg.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return pkg.id;
end $$;

create function public.reject_academy_course_package(p_package_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'REJECTED' then return pkg.id; end if;
  if pkg.status = 'PUBLISHED' then raise exception 'INVALID_STATE'; end if;
  update public.academy_course_packages set status = 'REJECTED', rejected_by = actor, rejected_at = clock_timestamp(), rejected_reason = reason
  where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_PACKAGE_REJECTED', 'academy_course_packages', pkg.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return pkg.id;
end $$;

-- Admin-only: the embedded curriculum, to drive the existing curriculum
-- pipeline. Contains draft answer keys, exactly like get_course_package_
-- content (migration 024), and is never called on a learner path.
create function public.get_academy_course_package_curriculum(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_course_admin();
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return pkg.raw_package->'curriculum';
end $$;

create function public.get_academy_course_package_content(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_course_admin();
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status not in ('UPLOADED','VALIDATED') then raise exception 'INVALID_STATE'; end if;
  return pkg.raw_package;
end $$;

create function public.list_academy_course_packages() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'packageKey', p.package_key, 'packageRevision', p.package_revision, 'status', p.status,
      'contentHash', p.content_hash, 'createdAt', p.created_at, 'validatedAt', p.validated_at,
      'publishedAt', p.published_at, 'rejectedReason', p.rejected_reason,
      'title', coalesce(p.review->>'title', left(p.raw_package->'curriculum'->'programme'->>'title', 200)),
      'curriculumImport', (select jsonb_build_object('id', i.id, 'status', i.status, 'programmeVersionId', i.programme_version_id)
         from public.course_package_imports i
         where i.package_key = p.package_key and i.package_revision = p.package_revision
           and i.raw_package = p.raw_package->'curriculum'),
      'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state)
         from public.academy_courses c left join public.academy_offers o on o.course_id = c.id where c.package_id = p.id)
    ) order by p.created_at desc)
    from (select * from public.academy_course_packages order by created_at desc limit 100) p), '[]');
end $$;

create function public.get_academy_course_package_review(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_course_admin();
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('id', pkg.id, 'status', pkg.status, 'review', pkg.review);
end $$;

-- Publication: explicit, separately authorised, never automatic on
-- validation. Requires the embedded curriculum to have been published by
-- the existing pipeline (including its passing pre-publication test) with
-- byte-equal content, re-checks the package, derives the blueprint and
-- creates the offer with the explicitly supplied per-format prices.
create function public.publish_academy_course(
  p_package_id uuid, p_offer_slug text, p_currency text, p_summary text, p_prices jsonb, p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype; imp public.course_package_imports%rowtype;
  units jsonb; v_course_id uuid; v_offer_id uuid; price jsonb; fmt jsonb; plan jsonb; days integer[]; lesson_count integer;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'PUBLISHED' then
    select c.id into v_course_id from public.academy_courses c join public.academy_offers o on o.course_id = c.id
    where c.package_id = pkg.id and o.slug = p_offer_slug;
    if v_course_id is null then raise exception 'INVALID_STATE'; end if;
    return v_course_id;
  end if;
  if pkg.status <> 'VALIDATED' then raise exception 'INVALID_STATE'; end if;
  if p_offer_slug is null or p_offer_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_offer_slug) not between 3 and 80
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or (p_summary is not null and length(trim(p_summary)) not between 1 and 500)
    or jsonb_typeof(p_prices) is distinct from 'array' or jsonb_array_length(p_prices) not between 1 and 5 then
    raise exception 'INVALID_INPUT';
  end if;
  if exists (select 1 from public.commercial_v1_offers where slug = p_offer_slug)
    or exists (select 1 from public.academy_offers where slug = p_offer_slug) then
    raise exception 'SLUG_CONFLICT';
  end if;
  perform academy_private.assert_package_valid(pkg.raw_package);

  select * into imp from public.course_package_imports
  where package_key = pkg.package_key and package_revision = pkg.package_revision for update;
  if not found or imp.status <> 'PUBLISHED' or imp.raw_package <> pkg.raw_package->'curriculum' then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;
  if exists (select 1 from public.programme_versions v where v.id = imp.programme_version_id and v.status <> 'PUBLISHED') then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;

  units := academy_private.build_units(pkg.raw_package);
  insert into public.academy_courses(package_id, curriculum_import_id, programme_version_id, title, units, published_by)
  values (pkg.id, imp.id, imp.programme_version_id, left(pkg.raw_package->'curriculum'->'programme'->>'title', 200), units, actor)
  returning id into v_course_id;

  insert into public.academy_course_lessons(course_id, sequence, lesson_ref, lesson_id)
  select v_course_id, o.idx + 1, o.lesson_key, l.id
  from academy_private.ordered_lessons(pkg.raw_package->'curriculum') o
  join public.modules m on m.programme_version_id = imp.programme_version_id and m.position = o.module_position
  join public.lessons l on l.module_id = m.id and l.position = o.lesson_position;
  get diagnostics lesson_count = row_count;
  if lesson_count <> (select count(*) from academy_private.ordered_lessons(pkg.raw_package->'curriculum')) then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;

  insert into public.academy_offers(course_id, slug, currency, summary, published_by)
  values (v_course_id, p_offer_slug, p_currency, nullif(trim(p_summary), ''), actor) returning id into v_offer_id;
  for price in select value from jsonb_array_elements(p_prices) loop
    fmt := null;
    select value into fmt from jsonb_array_elements(pkg.raw_package->'deliveryFormats') where value->>'formatId' = price->>'formatId';
    if fmt is null or jsonb_typeof(price->'amountMinor') is distinct from 'number'
      or (price->>'amountMinor') !~ '^[1-9][0-9]{0,8}$' or (price->>'amountMinor')::bigint > 100000000 then
      raise exception 'INVALID_PRICE';
    end if;
    -- Re-check feasibility at the format's maximum weekly days.
    days := array(select x.d from unnest(array[1,3,5,2,4,6,7]) with ordinality x(d, o) where x.o <= (fmt->>'maxStudyDaysPerWeek')::integer order by x.d);
    plan := academy_private.plan_units(units, academy_private.format_weeks(fmt->>'formatId'), (fmt->>'sessionMinutes')::integer,
      date '2027-01-04', days, null, null, 0);
    if not (plan->>'feasible')::boolean then raise exception 'FORMAT_INFEASIBLE'; end if;
    insert into public.academy_offer_formats(offer_id, format_id, session_minutes, min_study_days, max_study_days, price_amount_minor)
    values (v_offer_id, fmt->>'formatId', (fmt->>'sessionMinutes')::integer, (fmt->>'minStudyDaysPerWeek')::integer,
      (fmt->>'maxStudyDaysPerWeek')::integer, (price->>'amountMinor')::integer);
  end loop;

  update public.academy_course_packages set status = 'PUBLISHED', published_by = actor, published_at = clock_timestamp() where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_COURSE_PUBLISHED', 'academy_courses', v_course_id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('package_id', pkg.id, 'offer_id', v_offer_id, 'slug', p_offer_slug, 'currency', p_currency,
      'formats', (select jsonb_agg(jsonb_build_object('formatId', format_id, 'amountMinor', price_amount_minor) order by format_id)
                  from public.academy_offer_formats where academy_offer_formats.offer_id = v_offer_id)));
  return v_course_id;
exception when unique_violation then
  raise exception 'PUBLICATION_CONFLICT';
end $$;

create function public.archive_academy_offer(p_offer_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype;
begin
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if offer.state = 'ARCHIVED' then return offer.id; end if;
  update public.academy_offers set state = 'ARCHIVED', archived_by = actor, archived_at = clock_timestamp() where id = offer.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_OFFER_ARCHIVED', 'academy_offers', offer.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return offer.id;
end $$;

-- Authorised (complimentary/reviewer) access. Commerce authority is the
-- course administrator, recorded and audited; it creates the learner's
-- individual enrolment directly -- no cohort, no instructor.
create function public.grant_academy_entitlement(p_offer_id uuid, p_learner_email text, p_format_id text, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype; learner uuid; ent public.academy_entitlements%rowtype; enrolment uuid; version_id uuid;
begin
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found or offer.state <> 'PUBLISHED' then raise exception 'NOT_FOUND'; end if;
  if p_format_id is not null and not exists (select 1 from public.academy_offer_formats f where f.offer_id = offer.id and f.format_id = p_format_id) then
    raise exception 'INVALID_FORMAT';
  end if;
  select u.id into learner from public.app_users u join auth.users a on a.id = u.auth_user_id
  where lower(a.email) = lower(trim(p_learner_email)) and a.email_confirmed_at is not null and not u.is_demo and u.account_status = 'ACTIVE'
    and exists (select 1 from public.role_grants g where g.user_id = u.id and g.role = 'STUDENT');
  if learner is null then raise exception 'LEARNER_NOT_FOUND'; end if;
  select * into ent from public.academy_entitlements where learner_id = learner and course_id = offer.course_id;
  if found then
    if ent.format_id is distinct from p_format_id then raise exception 'ENTITLEMENT_EXISTS'; end if;
    select id into enrolment from public.academy_enrolments where entitlement_id = ent.id;
    return enrolment;
  end if;
  insert into public.academy_entitlements(learner_id, offer_id, course_id, format_id, source, granted_by, reason)
  values (learner, offer.id, offer.course_id, p_format_id, 'COMPLIMENTARY_GRANT', actor, reason) returning * into ent;
  select programme_version_id into version_id from public.academy_courses where id = offer.course_id;
  insert into public.academy_enrolments(entitlement_id, learner_id, course_id, programme_version_id)
  values (ent.id, learner, offer.course_id, version_id) returning id into enrolment;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_ENTITLEMENT_GRANTED', 'academy_entitlements', ent.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('enrolment_id', enrolment, 'offer_id', offer.id, 'format_id', p_format_id, 'source', 'COMPLIMENTARY_GRANT'));
  return enrolment;
end $$;

-- ==========================================================================
-- Section 5: public catalogue (published offers only).
-- ==========================================================================
create function public.list_academy_catalogue() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offerId', o.id, 'slug', o.slug, 'title', c.title, 'summary', o.summary, 'currency', o.currency,
    'description', p.raw_package->'course'->>'description',
    'qualificationPreparation', p.raw_package->'course'->'qualificationPreparation',
    'demoContent', (p.raw_package->'course'->>'demoContent')::boolean,
    'lessons', (select count(*) from public.academy_course_lessons l where l.course_id = c.id),
    'labs', jsonb_array_length(p.raw_package->'labs'),
    'assessments', jsonb_array_length(p.raw_package->'assessments'),
    'formats', (select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
        'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days,
        'amountMinor', f.price_amount_minor) order by academy_private.format_weeks(f.format_id))
      from public.academy_offer_formats f where f.offer_id = o.id)
  ) order by o.published_at desc), '[]')
  from public.academy_offers o join public.academy_courses c on c.id = o.course_id
  join public.academy_course_packages p on p.id = c.package_id
  where o.state = 'PUBLISHED'
$$;

-- ==========================================================================
-- Section 6: learner scheduling.
-- ==========================================================================
create function academy_private.my_enrolment(p_enrolment_id uuid, p_lock boolean) returns public.academy_enrolments
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); e public.academy_enrolments%rowtype;
begin
  if p_lock then
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor for update;
  else
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor;
  end if;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  return e;
end $$;

create function academy_private.current_schedule(p_enrolment_id uuid) returns public.academy_schedules
language sql stable security definer set search_path='' as $$
  select * from public.academy_schedules where enrolment_id = p_enrolment_id and superseded_at is null
$$;

-- Shared input checks and planning for preview, confirmation and revision.
-- Never raises for a learner-correctable problem: it returns
-- {feasible:false, code, message, alternatives} so the learner sees why.
create function academy_private.compute_plan(
  e public.academy_enrolments, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text,
  p_effective_on date
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  fmt public.academy_offer_formats%rowtype; ent public.academy_entitlements%rowtype; course public.academy_courses%rowtype;
  cur public.academy_schedules%rowtype; t time; days integer[]; weeks integer; today date; plan jsonb; timed jsonb;
  remaining jsonb := '[]'; kept jsonb := '[]'; cutover timestamptz; first_unit integer; first_offset integer := 0;
  kept_minutes integer; last_teaching date; u integer; alt jsonb := '[]'; other public.academy_offer_formats%rowtype;
  extra integer[]; candidate integer[]; k integer; session_base integer := 0;
begin
  select * into ent from public.academy_entitlements where id = e.entitlement_id;
  select * into course from public.academy_courses where id = e.course_id;
  if e.status <> 'ACTIVE' then return jsonb_build_object('feasible',false,'code','ENROLMENT_CLOSED','message','This course is complete; its timetable can no longer change.'); end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    return jsonb_build_object('feasible',false,'code','INVALID_TIMEZONE','message','Choose a recognised timezone.');
  end if;
  if p_local_time is null or p_local_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    return jsonb_build_object('feasible',false,'code','INVALID_INPUT','message','Choose a class time in HH:MM format.');
  end if;
  t := p_local_time::time;
  select array_agg(distinct d order by d) into days from unnest(p_study_days) d;
  if days is null or not (days <@ array[1,2,3,4,5,6,7]) then
    return jsonb_build_object('feasible',false,'code','INVALID_INPUT','message','Choose at least one study day.');
  end if;
  cur := academy_private.current_schedule(e.id);
  if p_effective_on is not null then
    if cur.id is null then return jsonb_build_object('feasible',false,'code','PLAN_REQUIRED','message','Confirm a first timetable before revising it.'); end if;
    p_format_id := cur.format_id;
    p_start_on := cur.start_on;
  end if;
  if ent.format_id is not null and p_format_id is distinct from ent.format_id then
    return jsonb_build_object('feasible',false,'code','FORMAT_FIXED','message','Your access is for a specific learning format.','formatId',ent.format_id);
  end if;
  if e.format_id is not null and p_format_id is distinct from e.format_id then
    return jsonb_build_object('feasible',false,'code','FORMAT_FIXED','message','Your learning format is already confirmed.','formatId',e.format_id);
  end if;
  select f.* into fmt from public.academy_offer_formats f join public.academy_offers o on o.id = f.offer_id
  where o.course_id = e.course_id and f.format_id = p_format_id;
  if not found then return jsonb_build_object('feasible',false,'code','INVALID_FORMAT','message','That learning format is not offered for this course.'); end if;
  weeks := academy_private.format_weeks(fmt.format_id);
  if cardinality(days) not between fmt.min_study_days and fmt.max_study_days then
    return jsonb_build_object('feasible',false,'code','STUDY_DAYS_OUT_OF_RANGE',
      'message',format('The %s format needs between %s and %s study days a week.', fmt.format_id, fmt.min_study_days, fmt.max_study_days),
      'minStudyDays',fmt.min_study_days,'maxStudyDays',fmt.max_study_days);
  end if;
  today := (clock_timestamp() at time zone p_timezone)::date;

  if p_effective_on is null then
    if p_start_on is null or p_start_on < today or p_start_on > today + 180 then
      return jsonb_build_object('feasible',false,'code','INVALID_START_DATE','message','Choose a start date from today up to 180 days ahead.');
    end if;
    plan := academy_private.plan_units(course.units, weeks, fmt.session_minutes, p_start_on, days, null, null, 0);
    remaining := course.units;
  else
    if p_effective_on <= today or p_effective_on > cur.end_on then
      return jsonb_build_object('feasible',false,'code','INVALID_EFFECTIVE_DATE','message','Changes can start from tomorrow until your course end date.');
    end if;
    cutover := (p_effective_on + time '00:00') at time zone p_timezone;
    if cutover <= clock_timestamp() then
      return jsonb_build_object('feasible',false,'code','INVALID_EFFECTIVE_DATE','message','Changes can start from tomorrow until your course end date.');
    end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.sequence), '[]') into kept
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at < cutover;
    select min(i.unit_index) into first_unit from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at >= cutover;
    if first_unit is null then
      return jsonb_build_object('feasible',false,'code','NOTHING_TO_RESCHEDULE','message','Every scheduled activity is before that date.');
    end if;
    select coalesce(sum(i.minutes), 0), coalesce(max(i.part), 0) into kept_minutes, first_offset
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.unit_index = first_unit and i.starts_at < cutover;
    select max((i.starts_at at time zone p_timezone)::date) into last_teaching
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.kind = 'LESSON' and i.starts_at < cutover;
    select coalesce(max(i.session_index) + 1, 0) into session_base from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at < cutover;
    for u in first_unit .. jsonb_array_length(course.units) - 1 loop
      remaining := remaining || jsonb_build_array(case when u = first_unit
        then jsonb_set(course.units->u, '{minutes}', to_jsonb((course.units->u->>'minutes')::integer - kept_minutes))
        else course.units->u end);
    end loop;
    plan := academy_private.plan_units(remaining, weeks, fmt.session_minutes, cur.start_on, days, p_effective_on, last_teaching, first_offset);
  end if;

  if not (plan->>'feasible')::boolean then
    -- Alternatives are offered, never applied.
    extra := array(select d from unnest(array[1,2,3,4,5,6,7]) d where not d = any(days) order by d);
    for k in 1 .. cardinality(extra) loop
      exit when cardinality(days) + k > fmt.max_study_days;
      candidate := array(select d from unnest(days || extra[1:k]) d order by d);
      if (academy_private.plan_units(remaining, weeks, fmt.session_minutes, p_start_on, candidate,
            p_effective_on, last_teaching, first_offset)->>'feasible')::boolean then
        alt := alt || jsonb_build_array(jsonb_build_object('kind','STUDY_DAYS','formatId',fmt.format_id,'studyDays',to_jsonb(candidate)));
        exit;
      end if;
    end loop;
    if p_effective_on is null and e.format_id is null and ent.format_id is null then
      for other in select f.* from public.academy_offer_formats f where f.offer_id = fmt.offer_id and f.format_id <> fmt.format_id
                   order by academy_private.format_weeks(f.format_id) loop
        if cardinality(days) between other.min_study_days and other.max_study_days
          and (academy_private.plan_units(course.units, academy_private.format_weeks(other.format_id), other.session_minutes,
                 p_start_on, days, null, null, 0)->>'feasible')::boolean then
          alt := alt || jsonb_build_array(jsonb_build_object('kind','FORMAT','formatId',other.format_id,'studyDays',to_jsonb(days)));
        end if;
      end loop;
    end if;
    return plan || jsonb_build_object('message',
      format('Your selected days give %s class sessions before %s, which is not enough to complete every lesson, lab and assessment with the required preparation time.',
        plan->>'availableSessions', to_char((plan->>'endDate')::date, 'FMDD Mon YYYY')),
      'alternatives', alt);
  end if;

  timed := academy_private.timed_items(plan, remaining, t, p_timezone);
  if not (timed->>'feasible')::boolean then
    return timed || jsonb_build_object('message', format('%s does not exist on %s in %s because of a daylight-saving change. Choose another class time.',
      p_local_time, timed->>'localDate', p_timezone), 'alternatives', '[]'::jsonb);
  end if;
  return jsonb_build_object('feasible', true, 'formatId', fmt.format_id, 'weeks', weeks, 'sessionMinutes', fmt.session_minutes,
    'startOn', coalesce(cur.start_on, p_start_on), 'endOn', (plan->>'endDate')::date,
    'studyDays', to_jsonb(days), 'localTime', p_local_time, 'timezone', p_timezone,
    'effectiveOn', p_effective_on, 'cutover', cutover, 'sessionBase', session_base,
    'kept', kept, 'items', timed->'items');
end $$;

-- Learner-safe presentation of a plan: titles, never protected content.
create function academy_private.present_plan(p_course public.academy_courses, p_plan jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg jsonb; items jsonb; base integer := coalesce((p_plan->>'sessionBase')::integer, 0);
begin
  select raw_package into pkg from public.academy_course_packages where id = p_course.package_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', x.kind, 'ref', x.ref, 'part', x.part, 'parts', x.parts, 'sessionIndex', x.session_index, 'localDate', x.local_date,
      'startsAt', x.starts_at, 'endsAt', x.ends_at, 'minutes', x.minutes, 'opensAt', x.opens_at, 'closesAt', x.closes_at,
      'carried', x.carried, 'title', academy_private.unit_title(pkg, x.kind, x.ref)) order by x.ord), '[]')
  into items
  from (
    select k.value->>'kind' kind, k.value->>'ref' ref, (k.value->>'part')::integer part, (k.value->>'parts')::integer parts,
      (k.value->>'session_index')::integer session_index, (k.value->>'local_date')::date local_date,
      (k.value->>'starts_at')::timestamptz starts_at, (k.value->>'ends_at')::timestamptz ends_at, (k.value->>'minutes')::integer minutes,
      (k.value->>'opens_at')::timestamptz opens_at, (k.value->>'closes_at')::timestamptz closes_at, true carried, k.ordinality ord
    from jsonb_array_elements(coalesce(p_plan->'kept', '[]')) with ordinality k
    union all
    select n.value->>'kind', n.value->>'ref', (n.value->>'part')::integer, (n.value->>'parts')::integer,
      (n.value->>'sessionIndex')::integer + base, (n.value->>'localDate')::date,
      (n.value->>'startsAt')::timestamptz, (n.value->>'endsAt')::timestamptz, (n.value->>'minutes')::integer,
      (n.value->>'opensAt')::timestamptz, (n.value->>'closesAt')::timestamptz, false, 100000 + n.ordinality
    from jsonb_array_elements(coalesce(p_plan->'items', '[]')) with ordinality n
  ) x;
  return (p_plan - 'kept' - 'items') || jsonb_build_object('items', items,
    'finishOn', (select max((i->>'localDate')::date) from jsonb_array_elements(items) i),
    'weeklyMinutes', (select coalesce(jsonb_agg(m order by w), '[]') from (
        select w, coalesce(sum((i->>'minutes')::integer), 0) m
        from generate_series(0, academy_private.format_weeks(p_plan->>'formatId') - 1) w
        left join jsonb_array_elements(items) i on ((i->>'localDate')::date - (p_plan->>'startOn')::date) / 7 = w
        group by w) s));
end $$;

create function academy_private.unit_title(p jsonb, p_kind text, p_ref text) returns text
language sql immutable set search_path='' as $$
  select case
    when p_kind = 'LESSON' then (select o.lesson->>'title' from academy_private.ordered_lessons(p->'curriculum') o where o.lesson_key = p_ref)
    when p_kind = 'LAB' then (select pa.value->>'title' from academy_private.ordered_lessons(p->'curriculum') o,
                               jsonb_array_elements(o.lesson->'practicalActivities') pa where pa.value->>'key' = p_ref)
    when p_kind = 'REVISION' then 'Revision: ' || (select t.value->>'title' from jsonb_array_elements(p->'curriculum'->'assessmentTemplates') t where t.value->>'key' = p_ref)
    else (select t.value->>'title' from jsonb_array_elements(p->'curriculum'->'assessmentTemplates') t where t.value->>'key' = p_ref)
  end
$$;

create function public.preview_my_academy_schedule(
  p_enrolment_id uuid, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  course public.academy_courses%rowtype; plan jsonb;
begin
  if (academy_private.current_schedule(e.id)).id is not null then
    return jsonb_build_object('feasible',false,'code','PLAN_EXISTS','message','Your timetable is already confirmed; revise future dates instead.');
  end if;
  select * into course from public.academy_courses where id = e.course_id;
  plan := academy_private.compute_plan(e, p_format_id, p_start_on, p_study_days, p_local_time, p_timezone, null);
  if (plan->>'feasible')::boolean then return academy_private.present_plan(course, plan); end if;
  return plan;
end $$;

create function public.preview_my_academy_schedule_revision(
  p_enrolment_id uuid, p_effective_on date, p_study_days integer[], p_local_time text, p_timezone text
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  course public.academy_courses%rowtype; plan jsonb;
begin
  select * into course from public.academy_courses where id = e.course_id;
  plan := academy_private.compute_plan(e, null, null, p_study_days, p_local_time, p_timezone, p_effective_on);
  if (plan->>'feasible')::boolean then return academy_private.present_plan(course, plan); end if;
  return plan;
end $$;

create function academy_private.store_plan(e public.academy_enrolments, p_plan jsonb, p_request_key uuid, p_previous public.academy_schedules)
returns uuid
language plpgsql security definer set search_path='' as $$
declare new_schedule uuid; next_revision integer := coalesce(p_previous.revision, 0) + 1; seq integer := 0; k jsonb; n jsonb;
  base integer := coalesce((p_plan->>'sessionBase')::integer, 0); unit_base integer := coalesce((p_plan->>'unitBase')::integer, 0);
  first_start timestamptz; split_parts integer;
begin
  if p_previous.id is not null then
    update public.academy_schedules set superseded_at = clock_timestamp() where id = p_previous.id;
  end if;
  select min((i->>'startsAt')::timestamptz) into first_start from jsonb_array_elements(p_plan->'items') i;
  -- A lesson split across a revision cutover keeps its carried parts; its
  -- total part count becomes the carried parts plus the re-planned rest.
  select max((i->>'parts')::integer) into split_parts from jsonb_array_elements(p_plan->'items') i where (i->>'unitIndex')::integer = 0;
  insert into public.academy_schedules(enrolment_id, revision, format_id, start_on, end_on, study_days, local_time, timezone,
    effective_from, request_key, plan_summary)
  values (e.id, next_revision, p_plan->>'formatId', (p_plan->>'startOn')::date, (p_plan->>'endOn')::date,
    array(select jsonb_array_elements_text(p_plan->'studyDays')::integer), (p_plan->>'localTime')::time, p_plan->>'timezone',
    coalesce((p_plan->>'cutover')::timestamptz, first_start), p_request_key,
    jsonb_build_object('sessionMinutes', p_plan->'sessionMinutes', 'weeks', p_plan->'weeks', 'effectiveOn', p_plan->'effectiveOn'))
  returning id into new_schedule;
  for k in select value from jsonb_array_elements(coalesce(p_plan->'kept', '[]')) order by (value->>'sequence')::integer loop
    seq := seq + 1;
    insert into public.academy_schedule_items(schedule_id, enrolment_id, sequence, unit_index, kind, ref, part, parts, session_index,
      local_date, starts_at, ends_at, minutes, opens_at, closes_at, carried_from)
    values (new_schedule, e.id, seq, (k->>'unit_index')::integer, k->>'kind', k->>'ref', (k->>'part')::integer,
      case when (k->>'unit_index')::integer = unit_base and split_parts is not null then split_parts else (k->>'parts')::integer end,
      (k->>'session_index')::integer, (k->>'local_date')::date, (k->>'starts_at')::timestamptz, (k->>'ends_at')::timestamptz,
      (k->>'minutes')::integer, (k->>'opens_at')::timestamptz, (k->>'closes_at')::timestamptz, (k->>'id')::uuid);
  end loop;
  for n in select value from jsonb_array_elements(p_plan->'items') order by (value->>'sequence')::integer loop
    seq := seq + 1;
    insert into public.academy_schedule_items(schedule_id, enrolment_id, sequence, unit_index, kind, ref, part, parts, session_index,
      local_date, starts_at, ends_at, minutes, opens_at, closes_at)
    values (new_schedule, e.id, seq, (n->>'unitIndex')::integer + unit_base, n->>'kind', n->>'ref',
      (n->>'part')::integer, (n->>'parts')::integer, (n->>'sessionIndex')::integer + base, (n->>'localDate')::date,
      (n->>'startsAt')::timestamptz, (n->>'endsAt')::timestamptz, (n->>'minutes')::integer,
      (n->>'opensAt')::timestamptz, (n->>'closesAt')::timestamptz);
  end loop;
  return new_schedule;
end $$;

create function public.confirm_my_academy_schedule(
  p_enrolment_id uuid, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text, p_request_key uuid
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  existing public.academy_schedules%rowtype; plan jsonb; schedule_id uuid;
begin
  if p_request_key is null then raise exception 'INVALID_INPUT'; end if;
  select * into existing from public.academy_schedules where enrolment_id = e.id and request_key = p_request_key;
  if found then return jsonb_build_object('ok', true, 'scheduleId', existing.id, 'revision', existing.revision, 'replayed', true); end if;
  if (academy_private.current_schedule(e.id)).id is not null then
    return jsonb_build_object('ok', false, 'code', 'PLAN_EXISTS', 'message', 'Your timetable is already confirmed; revise future dates instead.');
  end if;
  plan := academy_private.compute_plan(e, p_format_id, p_start_on, p_study_days, p_local_time, p_timezone, null);
  if not (plan->>'feasible')::boolean then return plan || jsonb_build_object('ok', false); end if;
  if e.format_id is null then
    update public.academy_enrolments set format_id = plan->>'formatId', format_locked_at = clock_timestamp() where id = e.id;
  end if;
  schedule_id := academy_private.store_plan(e, plan, p_request_key, null);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'ACADEMY_SCHEDULE_CONFIRMED', 'academy_schedules', schedule_id, 'ACADEMY_DELIVERY_V1', 'Learner confirmed a personal timetable.',
    jsonb_build_object('enrolment_id', e.id, 'revision', 1, 'format_id', plan->>'formatId'));
  return jsonb_build_object('ok', true, 'scheduleId', schedule_id, 'revision', 1, 'replayed', false);
end $$;

create function public.revise_my_academy_schedule(
  p_enrolment_id uuid, p_expected_revision integer, p_effective_on date, p_study_days integer[], p_local_time text, p_timezone text,
  p_request_key uuid
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  existing public.academy_schedules%rowtype; cur public.academy_schedules%rowtype; plan jsonb; schedule_id uuid; first_unit integer;
begin
  if p_request_key is null then raise exception 'INVALID_INPUT'; end if;
  select * into existing from public.academy_schedules where enrolment_id = e.id and request_key = p_request_key;
  if found then return jsonb_build_object('ok', true, 'scheduleId', existing.id, 'revision', existing.revision, 'replayed', true); end if;
  cur := academy_private.current_schedule(e.id);
  if cur.id is null then return jsonb_build_object('ok', false, 'code', 'PLAN_REQUIRED', 'message', 'Confirm a first timetable before revising it.'); end if;
  if cur.revision is distinct from p_expected_revision then
    return jsonb_build_object('ok', false, 'code', 'STALE_REVISION', 'message', 'Your timetable changed since you opened it. Review the latest version.');
  end if;
  if cur.revision >= 50 then return jsonb_build_object('ok', false, 'code', 'LIMIT_EXCEEDED', 'message', 'This timetable cannot be revised again.'); end if;
  plan := academy_private.compute_plan(e, null, null, p_study_days, p_local_time, p_timezone, p_effective_on);
  if not (plan->>'feasible')::boolean then return plan || jsonb_build_object('ok', false); end if;
  select min(i.unit_index) into first_unit from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at >= (plan->>'cutover')::timestamptz;
  schedule_id := academy_private.store_plan(e, plan || jsonb_build_object('unitBase', first_unit), p_request_key, cur);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'ACADEMY_SCHEDULE_REVISED', 'academy_schedules', schedule_id, 'ACADEMY_DELIVERY_V1', 'Learner revised future timetable dates.',
    jsonb_build_object('enrolment_id', e.id, 'revision', cur.revision + 1, 'effective_on', p_effective_on));
  return jsonb_build_object('ok', true, 'scheduleId', schedule_id, 'revision', cur.revision + 1, 'replayed', false);
end $$;

-- ==========================================================================
-- Section 7: learner reads.
-- ==========================================================================
create function public.list_my_academy_enrolments() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'enrolmentId', e.id, 'courseId', c.id, 'title', c.title, 'status', e.status, 'formatId', e.format_id,
      'fixedFormatId', ent.format_id, 'offerSlug', o.slug,
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

create function public.get_my_academy_timetable(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  s public.academy_schedules%rowtype; pkg jsonb; course public.academy_courses%rowtype;
begin
  s := academy_private.current_schedule(e.id);
  select * into course from public.academy_courses where id = e.course_id;
  if s.id is null then return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'schedule', null, 'items', '[]'::jsonb); end if;
  select raw_package into pkg from public.academy_course_packages where id = course.package_id;
  return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'status', e.status, 'serverTime', clock_timestamp(),
    'schedule', jsonb_build_object('revision', s.revision, 'formatId', s.format_id, 'startOn', s.start_on, 'endOn', s.end_on,
      'studyDays', to_jsonb(s.study_days), 'localTime', to_char(s.local_time, 'HH24:MI'), 'timezone', s.timezone,
      'sessionMinutes', s.plan_summary->'sessionMinutes'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'sequence', i.sequence, 'kind', i.kind, 'ref', i.ref,
        'part', i.part, 'parts', i.parts, 'sessionIndex', i.session_index, 'localDate', i.local_date, 'startsAt', i.starts_at,
        'endsAt', i.ends_at, 'minutes', i.minutes, 'opensAt', i.opens_at, 'closesAt', i.closes_at, 'carried', i.carried_from is not null,
        'title', academy_private.unit_title(pkg, i.kind, i.ref),
        'attempts', case when i.kind = 'ASSESSMENT' then (select count(*) from public.academy_assessment_attempts a
            where a.enrolment_id = e.id and a.assessment_ref = i.ref) end,
        'labSubmitted', case when i.kind = 'LAB' then exists (select 1 from public.academy_lab_submissions l
            where l.enrolment_id = e.id and l.lab_ref = i.ref) end) order by i.sequence), '[]')
      from public.academy_schedule_items i where i.schedule_id = s.id));
end $$;

create function public.get_my_academy_lesson(p_enrolment_id uuid, p_lesson_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  cl public.academy_course_lessons%rowtype; pkg jsonb; lesson jsonb;
begin
  if (academy_private.current_schedule(e.id)).id is null then raise exception 'PLAN_REQUIRED'; end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = p_lesson_ref;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = e.course_id;
  select o.lesson into lesson from academy_private.ordered_lessons(pkg->'curriculum') o where o.lesson_key = p_lesson_ref;
  return jsonb_build_object('lessonRef', p_lesson_ref, 'sequence', cl.sequence,
    'title', (select title from public.lessons where id = cl.lesson_id),
    'objectives', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'description', o.description) order by o.position), '[]')
       from public.lesson_objectives o where o.lesson_id = cl.lesson_id),
    'resources', (select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'body', r.body, 'url', r.url) order by r.position), '[]')
       from public.learning_resources r where r.lesson_id = cl.lesson_id),
    'practicalActivities', (select coalesce(jsonb_agg(jsonb_build_object('ref', pa.value->>'key', 'kind', pa.value->>'kind',
        'title', pa.value->>'title', 'instructions', pa.value->>'instructions') order by (pa.value->>'position')::integer), '[]')
       from jsonb_array_elements(lesson->'practicalActivities') pa));
end $$;

-- ==========================================================================
-- Section 8: assessment sittings. The schedule item is the eligibility
-- authority: an attempt can start only inside the learner's own sitting
-- window, with the full fixed duration still available before it closes.
-- ==========================================================================
create function academy_private.assessment_template(p_course_id uuid, p_ref text) returns jsonb
language sql stable security definer set search_path='' as $$
  select t.value from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
    jsonb_array_elements(p.raw_package->'curriculum'->'assessmentTemplates') t
  where c.id = p_course_id and t.value->>'key' = p_ref
$$;

create function academy_private.finalise_attempt(p_attempt_id uuid, p_submission text) returns public.academy_assessment_attempts
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
  perform academy_private.evaluate_completion(e.id);
  return a;
end $$;

create function academy_private.expire_if_due(p_attempt_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if exists (select 1 from public.academy_assessment_attempts where id = p_attempt_id and state = 'ACTIVE' and expires_at <= clock_timestamp()) then
    perform academy_private.finalise_attempt(p_attempt_id, 'AUTO_TIMEOUT');
  end if;
end $$;

create function public.start_my_academy_assessment(p_enrolment_id uuid, p_assessment_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  s public.academy_schedules%rowtype; item public.academy_schedule_items%rowtype; template jsonb;
  active public.academy_assessment_attempts%rowtype; used integer; attempt public.academy_assessment_attempts%rowtype;
  now_ts timestamptz := clock_timestamp(); duration interval;
begin
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  s := academy_private.current_schedule(e.id);
  if s.id is null then return jsonb_build_object('ok', false, 'code', 'PLAN_REQUIRED'); end if;
  select * into item from public.academy_schedule_items where schedule_id = s.id and kind = 'ASSESSMENT' and ref = p_assessment_ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  for active in select * from public.academy_assessment_attempts where enrolment_id = e.id and assessment_ref = p_assessment_ref and state = 'ACTIVE' loop
    perform academy_private.expire_if_due(active.id);
  end loop;
  select * into active from public.academy_assessment_attempts where enrolment_id = e.id and assessment_ref = p_assessment_ref and state = 'ACTIVE';
  if found then return jsonb_build_object('ok', true, 'attemptId', active.id, 'resumed', true); end if;
  template := academy_private.assessment_template(e.course_id, p_assessment_ref);
  duration := make_interval(mins => (template->>'durationMinutes')::integer);
  if now_ts < item.opens_at then
    return jsonb_build_object('ok', false, 'code', 'SITTING_NOT_OPEN', 'opensAt', item.opens_at);
  end if;
  if now_ts + duration > item.closes_at then
    return jsonb_build_object('ok', false, 'code', 'SITTING_CLOSED', 'closesAt', item.closes_at);
  end if;
  select count(*) into used from public.academy_assessment_attempts where enrolment_id = e.id and assessment_ref = p_assessment_ref;
  if used >= (template->>'attemptsAllowed')::integer then return jsonb_build_object('ok', false, 'code', 'NO_ATTEMPTS_REMAINING'); end if;
  insert into public.academy_assessment_attempts(enrolment_id, learner_id, assessment_ref, attempt_number, schedule_item_id, started_at, expires_at)
  values (e.id, e.learner_id, p_assessment_ref, used + 1, item.id, now_ts, now_ts + duration) returning * into attempt;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'ACADEMY_ASSESSMENT_STARTED', 'academy_assessment_attempts', attempt.id, 'ACADEMY_DELIVERY_V1', 'Learner started an assessment sitting.',
    jsonb_build_object('enrolment_id', e.id, 'assessment_ref', p_assessment_ref, 'attempt_number', used + 1));
  return jsonb_build_object('ok', true, 'attemptId', attempt.id, 'resumed', false);
end $$;

create function public.get_my_academy_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype;
  template jsonb;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  perform academy_private.expire_if_due(a.id);
  select * into a from public.academy_assessment_attempts where id = p_attempt_id;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  template := academy_private.assessment_template(e.course_id, a.assessment_ref);
  if a.state = 'SUBMITTED' then
    return jsonb_build_object('attemptId', a.id, 'enrolmentId', a.enrolment_id, 'assessmentRef', a.assessment_ref, 'title', template->>'title',
      'state', a.state, 'submission', a.submission, 'submittedAt', a.submitted_at, 'score', a.score, 'maxScore', a.max_score,
      'attemptNumber', a.attempt_number, 'attemptsAllowed', (template->>'attemptsAllowed')::integer);
  end if;
  -- Learner-visible definition only: prompt, type, interaction, marks.
  return jsonb_build_object('attemptId', a.id, 'enrolmentId', a.enrolment_id, 'assessmentRef', a.assessment_ref, 'title', template->>'title',
    'instructions', template->>'instructions', 'state', a.state, 'startedAt', a.started_at, 'expiresAt', a.expires_at,
    'serverTime', clock_timestamp(), 'durationMinutes', (template->>'durationMinutes')::integer,
    'attemptNumber', a.attempt_number, 'attemptsAllowed', (template->>'attemptsAllowed')::integer,
    'questions', (select jsonb_agg(jsonb_build_object('position', (q->>'position')::integer, 'prompt', q->>'prompt',
        'questionType', q->>'questionType', 'interaction', q->'interaction', 'maxMarks', (q->>'maxMarks')::integer,
        'response', (select r.body from public.academy_assessment_responses r where r.attempt_id = a.id
                     and r.question_position = (q->>'position')::integer order by r.id desc limit 1),
        'revisions', (select count(*) from public.academy_assessment_responses r where r.attempt_id = a.id
                     and r.question_position = (q->>'position')::integer))
        order by (q->>'position')::integer) from jsonb_array_elements(template->'questions') q));
end $$;

create function public.record_my_academy_response(p_attempt_id uuid, p_question_position integer, p_body text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype;
  q jsonb;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.academy_assessment_responses where attempt_id = a.id and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if a.state <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ATTEMPT_CLOSED'); end if;
  if a.expires_at <= clock_timestamp() then
    perform academy_private.finalise_attempt(a.id, 'AUTO_TIMEOUT');
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  select value into q from jsonb_array_elements(academy_private.assessment_template(e.course_id, a.assessment_ref)->'questions')
  where (value->>'position')::integer = p_question_position;
  if q is null or not assessment_interaction_private.response_is_valid(q->>'questionType', q->'interaction', p_body) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESPONSE');
  end if;
  insert into public.academy_assessment_responses(attempt_id, question_position, body, idempotency_key)
  values (a.id, p_question_position, p_body, p_idempotency_key);
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

create function public.submit_my_academy_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if a.state = 'ACTIVE' then
    a := academy_private.finalise_attempt(a.id, case when a.expires_at <= clock_timestamp() then 'AUTO_TIMEOUT' else 'STUDENT_SUBMIT' end);
  end if;
  return jsonb_build_object('ok', true, 'state', a.state, 'submission', a.submission, 'score', a.score, 'maxScore', a.max_score);
end $$;

-- ==========================================================================
-- Section 9: labs.
-- ==========================================================================
create function public.submit_my_academy_lab(p_enrolment_id uuid, p_lab_ref text, p_body text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  s public.academy_schedules%rowtype; item_start timestamptz; existing public.academy_lab_submissions%rowtype; new_id uuid;
begin
  if p_request_key is null or p_body is null or length(trim(p_body)) not between 1 and 20000 then raise exception 'INVALID_INPUT'; end if;
  select * into existing from public.academy_lab_submissions where enrolment_id = e.id and lab_ref = p_lab_ref;
  if found then
    if existing.request_key = p_request_key then return jsonb_build_object('ok', true, 'submissionId', existing.id, 'replayed', true); end if;
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SUBMITTED');
  end if;
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  s := academy_private.current_schedule(e.id);
  select min(starts_at) into item_start from public.academy_schedule_items where schedule_id = s.id and kind = 'LAB' and ref = p_lab_ref;
  if item_start is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if clock_timestamp() < item_start then return jsonb_build_object('ok', false, 'code', 'LAB_NOT_OPEN', 'opensAt', item_start); end if;
  insert into public.academy_lab_submissions(enrolment_id, learner_id, lab_ref, body, request_key)
  values (e.id, e.learner_id, p_lab_ref, trim(p_body), p_request_key) returning id into new_id;
  return jsonb_build_object('ok', true, 'submissionId', new_id, 'replayed', false);
end $$;

create function public.list_academy_lab_submissions_for_review() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('submissionId', s.id, 'courseTitle', c.title, 'labRef', s.lab_ref,
      'title', academy_private.unit_title(p.raw_package, 'LAB', s.lab_ref), 'body', s.body, 'submittedAt', s.submitted_at,
      'rubric', lb.value->'rubric', 'markingGuidance', lb.value->>'markingGuidance') order by s.submitted_at)
    from public.academy_lab_submissions s join public.academy_enrolments e on e.id = s.enrolment_id
    join public.academy_courses c on c.id = e.course_id join public.academy_course_packages p on p.id = c.package_id
    join lateral jsonb_array_elements(p.raw_package->'labs') lb on lb.value->>'activityRef' = s.lab_ref
    where (lb.value->>'graded')::boolean and not exists (select 1 from public.academy_lab_marks m where m.submission_id = s.id)
    limit 200), '[]');
end $$;

-- Human academic evaluation against the package rubric (the same
-- ACADEMIC_ADMIN/PLATFORM_ADMIN authority as migration 047's human review).
create function public.mark_academy_lab_submission(p_submission_id uuid, p_criterion_marks jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  s public.academy_lab_submissions%rowtype; e public.academy_enrolments%rowtype; spec jsonb; crit jsonb; total integer := 0; max_total integer := 0; v jsonb;
begin
  select * into s from public.academy_lab_submissions where id = p_submission_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if exists (select 1 from public.academy_lab_marks where submission_id = s.id) then raise exception 'ALREADY_MARKED'; end if;
  select * into e from public.academy_enrolments where id = s.enrolment_id;
  select lb.value into spec from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
    jsonb_array_elements(p.raw_package->'labs') lb where c.id = e.course_id and lb.value->>'activityRef' = s.lab_ref;
  if spec is null or not (spec->>'graded')::boolean or jsonb_typeof(p_criterion_marks) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
  if (select count(*) from jsonb_object_keys(p_criterion_marks)) <> jsonb_array_length(spec->'rubric') then raise exception 'INVALID_INPUT'; end if;
  for crit in select value from jsonb_array_elements(spec->'rubric') loop
    v := p_criterion_marks->(crit->>'key');
    if v is null or jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,3}$' or (v #>> '{}')::integer > (crit->>'maxMarks')::integer then
      raise exception 'INVALID_INPUT';
    end if;
    total := total + (v #>> '{}')::integer;
    max_total := max_total + (crit->>'maxMarks')::integer;
  end loop;
  insert into public.academy_lab_marks(submission_id, criterion_marks, marks, max_marks, marked_by, reason)
  values (s.id, p_criterion_marks, total, max_total, actor, reason);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_LAB_MARKED', 'academy_lab_submissions', s.id, 'ACADEMY_DELIVERY_V1', reason,
    jsonb_build_object('marks', total, 'max_marks', max_total));
  perform academy_private.evaluate_completion(e.id);
  return jsonb_build_object('ok', true, 'marks', total, 'maxMarks', max_total);
end $$;

-- ==========================================================================
-- Section 10: results and completion. Derived only from submitted
-- attempts (database-scored) and recorded lab marks; nothing else counts.
-- ==========================================================================
create function academy_private.results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype; pkg jsonb; comp jsonb; out jsonb := '[]'; a jsonb; score_bp integer; status text;
  course_bp integer := 0; all_final boolean := true; every_passed boolean := true; labs_marks integer; labs_max integer; labs_pending integer;
  attempts_left boolean := false; template jsonb; used integer; pass integer;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = e.course_id;
  for comp in select value from jsonb_array_elements(pkg->'grading'->'components') loop
    score_bp := null; status := 'PENDING'; pass := null;
    if comp->>'source' = 'ASSESSMENT' then
      select value into a from jsonb_array_elements(pkg->'assessments') where value->>'componentKey' = comp->>'componentKey';
      template := academy_private.assessment_template(e.course_id, a->>'templateRef');
      pass := (a->>'passMarkBp')::integer;
      select case when a->>'attemptScoring' = 'LATEST'
          then (array_agg((t.score * 10000 / t.max_score) order by t.attempt_number desc))[1]
          else max(t.score * 10000 / t.max_score) end, count(*)
        into score_bp, used
      from public.academy_assessment_attempts t where t.enrolment_id = e.id and t.assessment_ref = a->>'templateRef' and t.state = 'SUBMITTED';
      if used < (template->>'attemptsAllowed')::integer then attempts_left := true; end if;
      if score_bp is not null then status := 'GRADED'; end if;
    else
      select coalesce(sum(m.marks), 0), coalesce(sum(m.max_marks), 0) into labs_marks, labs_max
      from public.academy_lab_submissions s join public.academy_lab_marks m on m.submission_id = s.id where s.enrolment_id = e.id;
      select count(*) into labs_pending from jsonb_array_elements(pkg->'labs') lb
      where (lb.value->>'graded')::boolean and not exists (select 1 from public.academy_lab_submissions s join public.academy_lab_marks m on m.submission_id = s.id
        where s.enrolment_id = e.id and s.lab_ref = lb.value->>'activityRef');
      if labs_pending = 0 and labs_max > 0 then score_bp := labs_marks * 10000 / labs_max; status := 'GRADED'; end if;
    end if;
    if score_bp is null then all_final := false;
    else course_bp := course_bp + score_bp * (comp->>'weightBp')::integer / 10000;
      if pass is not null and score_bp < pass then every_passed := false; end if;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('componentKey', comp->>'componentKey', 'source', comp->>'source',
      'weightBp', (comp->>'weightBp')::integer, 'status', status, 'scoreBp', score_bp, 'passMarkBp', pass,
      'assessmentRef', a->>'templateRef', 'title', template->>'title'));
    a := null; template := null;
  end loop;
  return jsonb_build_object('components', out, 'allComponentsGraded', all_final,
    'courseScoreBp', case when all_final then course_bp end, 'passMarkBp', (pkg->'completion'->>'coursePassMarkBp')::integer,
    'outcome', case
      when not all_final then 'IN_PROGRESS'
      when course_bp >= (pkg->'completion'->>'coursePassMarkBp')::integer
        and (every_passed or not (pkg->'completion'->>'requireEveryComponentPassMark')::boolean) then 'PASSED'
      when attempts_left then 'IN_PROGRESS'
      else 'NOT_PASSED' end);
end $$;

create function academy_private.evaluate_completion(p_enrolment_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare r jsonb := academy_private.results(p_enrolment_id);
begin
  if r->>'outcome' = 'PASSED' and not exists (select 1 from public.academy_completions where enrolment_id = p_enrolment_id) then
    insert into public.academy_completions(enrolment_id, course_score_bp, pass_mark_bp, component_scores)
    values (p_enrolment_id, (r->>'courseScoreBp')::integer, (r->>'passMarkBp')::integer, r->'components');
    update public.academy_enrolments set status = 'COMPLETED', completed_at = clock_timestamp() where id = p_enrolment_id;
  end if;
end $$;

create function public.get_my_academy_results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
begin
  return academy_private.results(e.id) || jsonb_build_object('enrolmentId', e.id, 'status', e.status,
    'completion', (select jsonb_build_object('completedAt', c.completed_at, 'courseScoreBp', c.course_score_bp)
                   from public.academy_completions c where c.enrolment_id = e.id));
end $$;

-- ==========================================================================
-- Section 11: privileges. Private helpers: no role. Public RPCs: the
-- authenticated role only, except the published catalogue (also anon).
-- Verified below, failing the migration on any drift.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' or (n.nspname = 'public' and p.proname like '%academy%') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%academy%' loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  grant execute on function public.list_academy_catalogue() to anon;
end $$;

do $$ declare r text; t record; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'academy\_%' loop
      if has_table_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe academy table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r, 'academy_private', 'USAGE,CREATE') then raise exception 'Unsafe academy schema privileges for %', r; end if;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'academy_private' or (n.nspname = 'public' and p.proname like '%academy%') loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        f.nspname = 'public' and (r = 'authenticated' or (r = 'anon' and f.proname = 'list_academy_catalogue'))) then
        raise exception 'Unsafe academy function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
