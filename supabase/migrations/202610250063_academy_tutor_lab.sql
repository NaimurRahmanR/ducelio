-- Ducelio Academy (B2C), fourth checkpoint: AI Tutor and AI Lab Instructor
-- for an individual Academy enrolment. Additive; migrations 001-062 are
-- unchanged except as listed in Section 2 (one table generalised and three
-- functions replaced with identical cohort behaviour).
--
-- The existing governed Tutor/Lab infrastructure is REUSED, not duplicated:
--   * tutor_lab_content_releases (migration 028): the 30-second lease every
--     Tutor/Lab provider call runs under, with its guard and audit trigger;
--   * tutor_lab_provider_executions, its usage ledger and
--     govern_tutor_lab_provider_execution (migration 028): AUTHORIZE / START
--     / FINALIZE, one active execution per learner, 5/minute and 30/hour,
--     exactly one provider call, the 2000-token / 100000 micro-USD ceiling
--     and the 20-second expiry. The governance reads only the release's
--     learner, role, state and expiry, so it is unchanged;
--   * the controller key store and verifier (migrations 022/051);
--   * the agent configuration and the behaviour binding frozen at
--     publication, keyed by the Academy curriculum's programme version.
--
-- What is Academy-specific is only the admission source. In the cohort
-- model a Tutor/Lab release is admitted by a DELIVERY_V1 handoff of a cohort
-- enrolment. An Academy learner has no cohort or instructor, so the release
-- is admitted instead by an academy_support_request: the learner's own
-- request for Tutor help with one objective of a released lesson, or for
-- Lab Instructor help with one scheduled practical that has started.
--
-- Tutor/Lab conversations write no evidence, mastery, progress, grade or
-- completion. Examiner-assisted lab grading is not connected: Academy labs
-- have no approved rubrics.

-- ==========================================================================
-- Section 1: Academy support requests (the cohort-free admission source).
-- ==========================================================================
-- The lesson whose published practical activities contain this key, and
-- the activity itself (learner-facing fields only: kind, title,
-- instructions, objective keys). Never the lab rubric or marking guidance,
-- which live in the package's separate labs[] section.
create function academy_private.practical_activity(p_course_id uuid, p_key text,
  out lesson_ref text, out activity jsonb)
language sql stable security definer set search_path='' as $$
  select o.lesson_key, pa.value
  from public.academy_courses c
  join public.academy_course_packages p on p.id = c.package_id
  join academy_private.ordered_lessons(p.raw_package->'curriculum') o on true
  join lateral jsonb_array_elements(coalesce(o.lesson->'practicalActivities', '[]'::jsonb)) pa on pa.value->>'key' = p_key
  where c.id = p_course_id
  limit 1
$$;

create table public.academy_support_requests (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null,
  role text not null check (role in ('TUTOR','LAB_INSTRUCTOR')),
  -- The existing reviewed reason vocabulary, never a new one: Tutor help is
  -- objective reinforcement, Lab help is practical help.
  reason_code text not null,
  programme_version_id uuid not null references public.programme_versions(id),
  lesson_ref text not null check (length(lesson_ref) between 1 and 80),
  lesson_id uuid not null references public.lessons(id),
  objective_id uuid references public.lesson_objectives(id),
  practical_key text check (practical_key is null or length(practical_key) between 1 and 80),
  -- LAB: the root scheduled practical session the help belongs to.
  schedule_item_id uuid references public.academy_schedule_items(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id),
  check ((role = 'TUTOR' and reason_code = 'OBJECTIVE_REINFORCEMENT' and objective_id is not null
            and practical_key is null and schedule_item_id is null)
      or (role = 'LAB_INSTRUCTOR' and reason_code = 'PRACTICAL_HELP' and objective_id is null
            and practical_key is not null and schedule_item_id is not null))
);
-- One support thread per objective (Tutor) or per scheduled practical (Lab).
create unique index academy_support_requests_tutor on public.academy_support_requests(enrolment_id, objective_id)
  where role = 'TUTOR';
create unique index academy_support_requests_lab on public.academy_support_requests(schedule_item_id)
  where role = 'LAB_INSTRUCTOR';

-- ==========================================================================
-- Section 2: one release table, two admission sources. A cohort release
-- keeps exactly its previous constraints (enrolment, handoff, and the Lab
-- practical binding); an Academy release has neither cohort enrolment nor
-- handoff nor cohort practical, and is bound to its Academy request.
-- ==========================================================================
alter table public.tutor_lab_content_releases
  alter column enrolment_id drop not null,
  alter column handoff_id drop not null,
  add column academy_request_id uuid references public.academy_support_requests(id);
do $$ declare c text; n integer; begin
  select count(*), min(conname) into n, c from pg_constraint
  where conrelid = 'public.tutor_lab_content_releases'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%LAB_INSTRUCTOR%practical_id IS NOT NULL%';
  if n <> 1 then raise exception 'expected exactly one Lab practical binding constraint, found %', n; end if;
  execute format('alter table public.tutor_lab_content_releases drop constraint %I', c);
end $$;
alter table public.tutor_lab_content_releases add constraint tutor_lab_content_releases_source check (
  (academy_request_id is null and enrolment_id is not null and handoff_id is not null
    and (agent_profile = 'LAB_INSTRUCTOR') = (practical_id is not null))
  or (academy_request_id is not null and enrolment_id is null and handoff_id is null and practical_id is null));
create index tutor_lab_content_releases_academy on public.tutor_lab_content_releases(academy_request_id)
  where academy_request_id is not null;

-- Same guard as migration 028, with the new source column in the immutable
-- identity.
create or replace function tutor_lab_execution_private.guard_content_release() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Release history cannot be deleted'; end if;
  if OLD.state <> 'ACTIVE' then raise exception 'Terminal release history is immutable'; end if;
  if row(NEW.id,NEW.student_id,NEW.invocation_id,NEW.agent_profile,NEW.enrolment_id,NEW.handoff_id,
      NEW.lesson_id,NEW.objective_id,NEW.practical_id,NEW.started_at,NEW.expires_at,NEW.academy_request_id)
    is distinct from
     row(OLD.id,OLD.student_id,OLD.invocation_id,OLD.agent_profile,OLD.enrolment_id,OLD.handoff_id,
      OLD.lesson_id,OLD.objective_id,OLD.practical_id,OLD.started_at,OLD.expires_at,OLD.academy_request_id) then
    raise exception 'Release identity is immutable';
  end if;
  if NEW.state not in ('COMPLETED','ABORTED','EXPIRED') then raise exception 'Invalid release transition'; end if;
  return NEW;
end $$;

-- Same content-minimised audit as migration 028; an Academy release also
-- names its request (a cohort release's payload is unchanged).
create or replace function tutor_lab_execution_private.audit_content_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'TUTOR_LAB_RELEASE_'||NEW.state,'tutor_lab_content_releases',NEW.id,'TUTOR_LAB_SUPPORT_V1',
    'Tutor/Lab content release authorization lifecycle',
    jsonb_build_object('release_id',NEW.id,'student_id',NEW.student_id,'agent_profile',NEW.agent_profile,
      'enrolment_id',NEW.enrolment_id,'handoff_id',NEW.handoff_id,'lesson_id',NEW.lesson_id,
      'objective_id',NEW.objective_id,'practical_id',NEW.practical_id,'invocation_id',NEW.invocation_id,
      'state',NEW.state,'started_at',NEW.started_at,'expires_at',NEW.expires_at,'terminal_at',NEW.terminal_at)
    || case when NEW.academy_request_id is null then '{}'::jsonb
         else jsonb_build_object('academy_request_id',NEW.academy_request_id) end,
    clock_timestamp());
  return NEW;
end $$;

-- Execution provenance (migration 051's trigger). The cohort branch is the
-- previous body unchanged; an Academy execution records Academy provenance
-- from the Academy enrolment's programme version, failing closed the same
-- way without a verified behaviour binding.
create table public.academy_support_execution_provenance (
  execution_id uuid primary key references public.tutor_lab_provider_executions(id),
  request_id uuid not null references public.academy_support_requests(id),
  learner_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.academy_enrolments(id),
  programme_version_id uuid not null references public.programme_versions(id),
  role text not null check (role in ('TUTOR','LAB_INSTRUCTOR')),
  runtime_profile_ref text check (runtime_profile_ref is null or runtime_profile_ref ~ '^[A-Za-z0-9_.-]{1,100}$'),
  institutional_baseline_version text not null check (institutional_baseline_version in ('DUCELIO_INSTITUTIONAL_BASELINE_V1')),
  behaviour_version text not null,
  behaviour_config_source text not null check (behaviour_config_source in ('EXPLICIT','DEFAULT')),
  behaviour_config_version text not null check (behaviour_config_version in ('AGENT_BEHAVIOUR_CONFIG_V1','AGENT_BEHAVIOUR_DEFAULT_V1')),
  behaviour_config_id uuid references public.academic_agent_behaviour_configs(id),
  behaviour_fingerprint text not null check (behaviour_fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check (starts_with(behaviour_version, role || '_BEHAVIOUR_V')),
  check ((behaviour_config_source = 'EXPLICIT') = (behaviour_config_id is not null)),
  check ((behaviour_config_source = 'EXPLICIT') = (behaviour_config_version = 'AGENT_BEHAVIOUR_CONFIG_V1'))
);

create or replace function agent_behaviour_private.record_tutor_lab_provenance() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.tutor_lab_content_releases%rowtype; e public.enrolments%rowtype; eff record; fingerprint text;
  q public.academy_support_requests%rowtype;
begin
  select * into r from public.tutor_lab_content_releases where id = NEW.release_id;
  if r.academy_request_id is not null then
    select * into q from public.academy_support_requests where id = r.academy_request_id;
    select * into eff from agent_behaviour_private.effective_config(q.programme_version_id, NEW.agent_profile);
    fingerprint := agent_behaviour_private.behaviour_fingerprint(q.programme_version_id);
    if q.id is null or q.role <> NEW.agent_profile or not eff.ok or fingerprint is null then
      raise exception 'AGENT_BEHAVIOUR_BINDING_INVALID: the programme version has no verified behaviour binding'
        using errcode = '55000';
    end if;
    insert into public.academy_support_execution_provenance(
      execution_id, request_id, learner_id, enrolment_id, programme_version_id, role,
      runtime_profile_ref, institutional_baseline_version, behaviour_version, behaviour_config_source,
      behaviour_config_version, behaviour_config_id, behaviour_fingerprint
    ) values (
      NEW.id, q.id, NEW.student_id, q.enrolment_id, q.programme_version_id, NEW.agent_profile,
      agent_behaviour_private.runtime_profile_ref(q.programme_version_id, NEW.agent_profile),
      agent_behaviour_private.institutional_baseline_version(),
      eff.behaviour_version, eff.source, eff.config_version, eff.config_id, fingerprint
    );
    return NEW;
  end if;
  select * into e from public.enrolments where id = r.enrolment_id;
  select * into eff from agent_behaviour_private.effective_config(e.programme_version_id, NEW.agent_profile);
  fingerprint := agent_behaviour_private.behaviour_fingerprint(e.programme_version_id);
  -- Fail closed: no Tutor/Lab execution without a verified behaviour binding.
  if not eff.ok or fingerprint is null then
    raise exception 'AGENT_BEHAVIOUR_BINDING_INVALID: the programme version has no verified behaviour binding'
      using errcode = '55000';
  end if;
  insert into public.academic_agent_execution_provenance(
    execution_kind, tutor_lab_execution_id, student_id, role, programme_version_id, enrolment_id,
    runtime_profile_ref, institutional_baseline_version, behaviour_version, behaviour_config_source,
    behaviour_config_version, behaviour_config_id, behaviour_fingerprint
  ) values (
    'TUTOR_LAB_PROVIDER_V1', NEW.id, NEW.student_id, NEW.agent_profile, e.programme_version_id, e.id,
    agent_behaviour_private.runtime_profile_ref(e.programme_version_id, NEW.agent_profile),
    -- The legacy Tutor/Lab AUTHORIZE format is unchanged, so this is the
    -- database mirror; the server refuses to execute unless the learner
    -- read's mirror equals the code's applied baseline.
    agent_behaviour_private.institutional_baseline_version(),
    eff.behaviour_version, eff.source, eff.config_version, eff.config_id, fingerprint
  );
  return NEW;
end $$;

-- ==========================================================================
-- Section 3: admission. A request may be served only while: it is the
-- learner's own; the Academy enrolment is ACTIVE and unrevoked; its lesson
-- is released by the learner's CURRENT timetable; for Lab help, its
-- scheduled practical (carried through revisions) has started; and no
-- controlled assessment is active in either exam system.
-- ==========================================================================
create function academy_private.support_admission(p_request_id uuid,
  out q public.academy_support_requests, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record;
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor;
  if q.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  select * into r from academy_private.teaching_enrolment(q.enrolment_id, false);
  if r.code is not null then code := r.code; return; end if;
  if not academy_private.lesson_released(q.enrolment_id, q.lesson_ref) then code := 'NOT_RELEASED'; return; end if;
  if q.role = 'LAB_INSTRUCTOR' and not exists (
      select 1 from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
      where s.enrolment_id = q.enrolment_id and s.superseded_at is null and i.kind = 'LAB' and i.ref = q.practical_key
        and i.starts_at <= clock_timestamp()
        and academy_private.root_schedule_item(i.id) = q.schedule_item_id) then
    code := 'NOT_RELEASED'; return;
  end if;
  if academy_private.exam_active() then code := 'ACTIVITY_BLOCKED'; return; end if;
end $$;

-- Tutor: one objective of a released lesson of the learner's own course.
create function public.open_my_academy_tutor_support(p_enrolment_id uuid, p_lesson_ref text, p_objective_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; cl public.academy_course_lessons%rowtype; existing uuid; created uuid;
begin
  if p_enrolment_id is null or p_lesson_ref is null or p_objective_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = p_lesson_ref;
  if not found or not exists (select 1 from public.lesson_objectives o
      where o.id = p_objective_id and o.lesson_id = cl.lesson_id and o.programme_version_id = e.programme_version_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
  end if;
  if not academy_private.lesson_released(e.id, p_lesson_ref) then return jsonb_build_object('ok', false, 'code', 'NOT_RELEASED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  select id into existing from public.academy_support_requests
    where enrolment_id = e.id and objective_id = p_objective_id and role = 'TUTOR';
  if existing is not null then return jsonb_build_object('ok', true, 'requestId', existing, 'resumed', true); end if;
  insert into public.academy_support_requests(learner_id, enrolment_id, role, reason_code, programme_version_id,
    lesson_ref, lesson_id, objective_id)
  values (e.learner_id, e.id, 'TUTOR', 'OBJECTIVE_REINFORCEMENT', e.programme_version_id, p_lesson_ref, cl.lesson_id, p_objective_id)
  returning id into created;
  return jsonb_build_object('ok', true, 'requestId', created, 'resumed', false);
end $$;

-- Lab Instructor: one scheduled practical session that has started.
create function public.open_my_academy_lab_support(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; i public.academy_schedule_items%rowtype;
  s public.academy_schedules%rowtype; root uuid; pa record; cl public.academy_course_lessons%rowtype;
  existing uuid; created uuid;
begin
  if p_enrolment_id is null or p_schedule_item_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  select * into i from public.academy_schedule_items where id = p_schedule_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LAB' then return jsonb_build_object('ok', false, 'code', 'NOT_A_PRACTICAL'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
  if clock_timestamp() < i.starts_at then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED'); end if;
  select * into pa from academy_private.practical_activity(e.course_id, i.ref);
  if pa.lesson_ref is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = pa.lesson_ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if not academy_private.lesson_released(e.id, pa.lesson_ref) then return jsonb_build_object('ok', false, 'code', 'NOT_RELEASED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  root := academy_private.root_schedule_item(i.id);
  if root is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select id into existing from public.academy_support_requests where schedule_item_id = root and role = 'LAB_INSTRUCTOR';
  if existing is not null then return jsonb_build_object('ok', true, 'requestId', existing, 'resumed', true); end if;
  insert into public.academy_support_requests(learner_id, enrolment_id, role, reason_code, programme_version_id,
    lesson_ref, lesson_id, practical_key, schedule_item_id)
  values (e.learner_id, e.id, 'LAB_INSTRUCTOR', 'PRACTICAL_HELP', e.programme_version_id, pa.lesson_ref, cl.lesson_id, i.ref, root)
  on conflict do nothing
  returning id into created;
  if created is null then
    select id into existing from public.academy_support_requests where schedule_item_id = root and role = 'LAB_INSTRUCTOR';
    return jsonb_build_object('ok', true, 'requestId', existing, 'resumed', true);
  end if;
  return jsonb_build_object('ok', true, 'requestId', created, 'resumed', false);
end $$;

-- The learner-facing description of one request (no provider context).
create function public.get_my_academy_support_request(p_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; q public.academy_support_requests%rowtype; e public.academy_enrolments%rowtype;
  course public.academy_courses%rowtype; pa record;
begin
  if p_request_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into r from academy_private.support_admission(p_request_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  q := r.q;
  select * into e from public.academy_enrolments where id = q.enrolment_id;
  select * into course from public.academy_courses where id = e.course_id;
  if q.role = 'LAB_INSTRUCTOR' then select * into pa from academy_private.practical_activity(e.course_id, q.practical_key); end if;
  return jsonb_build_object('ok', true, 'request', jsonb_build_object(
    'requestId', q.id, 'enrolmentId', q.enrolment_id, 'role', q.role, 'courseTitle', course.title,
    'lessonRef', q.lesson_ref, 'lessonTitle', (select title from public.lessons where id = q.lesson_id),
    'objective', case when q.objective_id is null then null else
      (select o.description from public.lesson_objectives o where o.id = q.objective_id) end,
    'practical', case when q.role = 'LAB_INSTRUCTOR' then jsonb_build_object('kind', pa.activity->>'kind',
      'title', pa.activity->>'title', 'instructions', pa.activity->>'instructions') end,
    'graded', case when q.role = 'LAB_INSTRUCTOR' then coalesce((select (l.value->>'graded')::boolean
      from public.academy_course_packages p, jsonb_array_elements(p.raw_package->'labs') l
      where p.id = course.package_id and l.value->>'activityRef' = q.practical_key limit 1), false) end));
end $$;

-- ==========================================================================
-- Section 4: governed releases over the reused tutor_lab_content_releases.
-- ==========================================================================
create function public.begin_my_academy_support_release(p_invocation_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; q public.academy_support_requests%rowtype;
  release_id uuid; stamp timestamptz; allowed boolean;
begin
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  if not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  -- The shared admission lock: the same learner-profile row every release,
  -- execution and assessment start takes first.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_invocation_id is null or p_request_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into r from academy_private.support_admission(p_request_id);
  -- The firewall is recorded as a BLOCKED release, exactly as the cohort
  -- path does; every other refusal opens nothing.
  if r.code is not null and r.code <> 'ACTIVITY_BLOCKED' then return jsonb_build_object('ok', false, 'code', r.code); end if;
  q := r.q;
  perform public.expire_my_tutor_lab_content_releases();
  if exists (select 1 from public.tutor_lab_content_releases where student_id = actor and invocation_id = p_invocation_id) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  allowed := r.code is null and public.academic_content_release_explain_allowed();
  stamp := clock_timestamp();
  insert into public.tutor_lab_content_releases(student_id, invocation_id, agent_profile, enrolment_id, handoff_id,
    academy_request_id, lesson_id, objective_id, practical_id, state, started_at, expires_at, terminal_at)
  values (actor, p_invocation_id, q.role, null, null, q.id, q.lesson_id, q.objective_id, null,
    case when allowed then 'ACTIVE' else 'BLOCKED' end, stamp, stamp + interval '30 seconds',
    case when allowed then null else stamp end)
  returning id into release_id;
  if not allowed then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  return jsonb_build_object('ok', true, 'release_id', release_id, 'student_id', actor, 'invocation_id', p_invocation_id,
    'role', q.role, 'reason_code', q.reason_code, 'request_id', q.id, 'enrolment_id', q.enrolment_id,
    'lesson_id', q.lesson_id, 'objective_id', q.objective_id);
end $$;

-- COMPLETED only when admission still holds at close (after the provider
-- call): a revocation, closed enrolment, withdrawn lesson or practical, or
-- a controlled assessment that began meanwhile aborts the release.
create function public.close_my_academy_support_release(p_release_id uuid, p_complete boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); rel public.tutor_lab_content_releases%rowtype; r record;
  terminal_state text; stamp timestamptz;
begin
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if p_complete is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  perform public.expire_my_tutor_lab_content_releases();
  select * into rel from public.tutor_lab_content_releases
    where id = p_release_id and student_id = actor and academy_request_id is not null;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if rel.state <> 'ACTIVE' then return jsonb_build_object('ok', true, 'state', rel.state, 'transitioned', false); end if;
  select * into r from academy_private.support_admission(rel.academy_request_id);
  terminal_state := case when p_complete and r.code is null and public.academic_content_release_explain_allowed()
    then 'COMPLETED' else 'ABORTED' end;
  stamp := clock_timestamp();
  if stamp >= rel.expires_at then terminal_state := 'EXPIRED'; stamp := rel.expires_at; end if;
  update public.tutor_lab_content_releases set state = terminal_state, terminal_at = stamp where id = rel.id;
  return jsonb_build_object('ok', true, 'state', terminal_state, 'transitioned', true);
end $$;

-- One bounded context read per release, in exactly the Tutor/Lab context
-- shapes of the cohort path (src/server/tutor-lab-execution/context.ts):
-- the lesson, its published objectives (Tutor: a first-page overview plus
-- the requested objective; Lab: every objective the practical addresses),
-- approved resource titles when the configuration authorises them (Tutor),
-- and the practical's learner-facing instructions (Lab). Never assessment
-- questions, answer keys, lab rubrics or marking guidance.
create table public.academy_support_context_reads (
  release_id uuid primary key references public.tutor_lab_content_releases(id),
  request_id uuid not null references public.academy_support_requests(id),
  read_at timestamptz not null default clock_timestamp()
);

create function public.read_my_academy_support_context(p_release_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); rel public.tutor_lab_content_releases%rowtype; r record;
  q public.academy_support_requests%rowtype; e public.academy_enrolments%rowtype; l public.lessons%rowtype;
  cfg public.academic_agent_configs%rowtype; pa record; ids uuid[]; keys text[]; data jsonb;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_release_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into rel from public.tutor_lab_content_releases
    where id = p_release_id and student_id = actor and academy_request_id is not null for update;
  if not found or rel.state <> 'ACTIVE' or rel.expires_at <= clock_timestamp()
    or exists (select 1 from public.academy_support_context_reads where release_id = rel.id) then
    return jsonb_build_object('ok', false, 'code', 'CONTENT_RELEASE_UNAVAILABLE');
  end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  select * into r from academy_private.support_admission(rel.academy_request_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  q := r.q;
  if q.role <> rel.agent_profile or q.lesson_id <> rel.lesson_id or q.objective_id is distinct from rel.objective_id then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  -- The stored configuration must enable the role and authorise the lesson
  -- and objectives reads (resources stay optional).
  select * into cfg from public.academic_agent_configs where programme_version_id = q.programme_version_id and role = q.role;
  if not found or not cfg.enabled or not ('get_lesson_context' = any(cfg.capabilities))
    or not ('get_lesson_objectives' = any(cfg.capabilities)) then
    return jsonb_build_object('ok', false, 'code', 'POLICY_BLOCKED');
  end if;
  select * into e from public.academy_enrolments where id = q.enrolment_id;
  select * into l from public.lessons where id = q.lesson_id and programme_version_id = q.programme_version_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if q.role = 'TUTOR' then
    data := jsonb_build_object('role', 'TUTOR', 'reasonCode', q.reason_code,
      'lesson', jsonb_build_object('title', l.title, 'position', l.position),
      'objectives', coalesce((select jsonb_agg(jsonb_build_object('description', o.description, 'position', o.position)
          order by o.position)
        from (select * from public.lesson_objectives o where o.lesson_id = l.id
              and o.programme_version_id = q.programme_version_id order by o.position limit 50) o), '[]'::jsonb),
      'requestedObjective', (select jsonb_build_object('description', o.description) from public.lesson_objectives o
        where o.id = q.objective_id and o.lesson_id = l.id),
      'resources', case when 'get_learning_resources' = any(cfg.capabilities) then
        coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'kind', x.kind) order by x.position)
          from (select * from public.learning_resources x where x.lesson_id = l.id
                and x.programme_version_id = q.programme_version_id order by x.position limit 5) x), '[]'::jsonb) end);
    if data->'requestedObjective' is null or data->'requestedObjective' = 'null'::jsonb then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
    end if;
  else
    select * into pa from academy_private.practical_activity(e.course_id, q.practical_key);
    if pa.lesson_ref is distinct from q.lesson_ref then return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT'); end if;
    keys := array(select jsonb_array_elements_text(coalesce(pa.activity->'objectiveRefs', '[]'::jsonb)));
    ids := array(select academy_private.objective_id(e.course_id, q.lesson_ref, k) from unnest(keys) k);
    -- Every objective the practical addresses must resolve: never a
    -- partial objective set.
    if cardinality(keys) = 0 or array_position(ids, null) is not null then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
    end if;
    data := jsonb_build_object('role', 'LAB_INSTRUCTOR', 'reasonCode', q.reason_code,
      'lesson', jsonb_build_object('title', l.title, 'position', l.position),
      'practical', jsonb_build_object('kind', pa.activity->>'kind', 'title', pa.activity->>'title',
        'instructions', pa.activity->>'instructions'),
      'objectives', (select jsonb_agg(jsonb_build_object('description', o.description, 'position', o.position)
          order by o.position)
        from public.lesson_objectives o where o.id = any(ids)));
  end if;
  insert into public.academy_support_context_reads(release_id, request_id) values (rel.id, q.id);
  return jsonb_build_object('ok', true, 'data', data);
end $$;

-- The stored role configuration and the behaviour binding frozen at
-- publication, for the Academy enrolment's programme version.
create function public.get_my_academy_support_agent(p_enrolment_id uuid, p_role text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; cfg public.academic_agent_configs%rowtype; eff jsonb;
begin
  if p_enrolment_id is null or p_role is null or p_role not in ('TUTOR','LAB_INSTRUCTOR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, false);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  e := r.e;
  select * into cfg from public.academic_agent_configs c where c.programme_version_id = e.programme_version_id and c.role = p_role;
  eff := agent_behaviour_private.effective_behaviour(e.programme_version_id, p_role);
  return jsonb_build_object('ok', true,
    'config', jsonb_build_object('enabled', coalesce(cfg.enabled, false), 'modelProfileRef', cfg.model_profile_ref,
      'capabilities', to_jsonb(coalesce(cfg.capabilities, array[]::text[])),
      'escalationPolicy', coalesce(cfg.escalation_policy, 'NONE')),
    'behaviour', case when (eff->>'ok')::boolean and eff->>'state' = 'BOUND' then jsonb_build_object('ok', true,
        'source', eff->'source', 'configVersion', eff->'configVersion', 'behaviourVersion', eff->'behaviourVersion',
        'config', eff->'config', 'institutionalBaselineVersion', agent_behaviour_private.institutional_baseline_version())
      else jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_MISSING') end);
end $$;

-- ==========================================================================
-- Section 5: idempotent learner actions and the recorded conversation.
-- ==========================================================================
-- Reserved before any release or provider work, keyed by the learner and a
-- browser-supplied key, fingerprinted over the request and message (no
-- prose stored): a replay is a DUPLICATE, a changed replay a conflict.
create table public.academy_support_reservations (
  learner_id uuid not null references public.student_profiles(user_id),
  idempotency_key uuid not null,
  request_id uuid not null references public.academy_support_requests(id),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz not null default clock_timestamp(),
  primary key (learner_id, idempotency_key)
);
create index academy_support_reservations_recent on public.academy_support_reservations(request_id, reserved_at);

create function public.reserve_my_academy_support_interaction(p_request_id uuid, p_idempotency_key uuid, p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; q public.academy_support_requests%rowtype; existing public.academy_support_reservations%rowtype; n integer;
begin
  if p_request_id is null or p_idempotency_key is null or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.support_admission(p_request_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  q := r.q;
  select * into existing from public.academy_support_reservations
    where learner_id = q.learner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing.request_id <> q.id or existing.request_hash <> p_request_hash then
      return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if (select count(*) from public.academy_support_reservations
      where request_id = q.id and reserved_at > clock_timestamp() - interval '60 seconds') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  if (select count(*) from public.academy_support_reservations where request_id = q.id) >= 1000 then
    return jsonb_build_object('ok', false, 'code', 'CAPACITY_REACHED');
  end if;
  insert into public.academy_support_reservations(learner_id, idempotency_key, request_id, request_hash)
  values (q.learner_id, p_idempotency_key, q.id, p_request_hash) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    select * into existing from public.academy_support_reservations
      where learner_id = q.learner_id and idempotency_key = p_idempotency_key;
    if existing.request_id <> q.id or existing.request_hash <> p_request_hash then
      return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY_CONFLICT');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', n = 0);
end $$;

-- The learner-visible exchange of a SUCCEEDED execution whose release
-- closed COMPLETED, attested by the controller with its own protocol tag.
-- Not evidence, progress, mastery or a grade.
create table public.academy_support_turns (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.academy_support_requests(id),
  learner_id uuid not null references public.student_profiles(user_id),
  execution_id uuid not null unique references public.academy_support_execution_provenance(execution_id),
  turn_number integer not null check (turn_number between 1 and 200),
  learner_message text not null check (length(learner_message) between 1 and 2000),
  agent_message text not null check (length(agent_message) between 1 and 12000),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (request_id, turn_number)
);

create function public.record_my_academy_support_turn(
  p_key_id uuid, p_execution_id uuid, p_request_id uuid, p_learner_message text, p_agent_message text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); q public.academy_support_requests%rowtype;
  x public.tutor_lab_provider_executions%rowtype; turns integer;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_request_id is null
    or p_learner_message is null or length(p_learner_message) not between 1 and 2000
    or p_agent_message is null or length(p_agent_message) not between 1 and 12000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_ACADEMY_SUPPORT_TURN_HMAC_SHA256_V1', p_key_id::text, actor::text,
      p_execution_id::text, p_request_id::text,
      encode(extensions.digest(convert_to(p_learner_message, 'UTF8'), 'sha256'), 'hex'),
      encode(extensions.digest(convert_to(p_agent_message, 'UTF8'), 'sha256'), 'hex'),
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into x from public.tutor_lab_provider_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'SUCCEEDED' or x.agent_profile <> q.role
    or not exists (select 1 from public.tutor_lab_content_releases rel
      where rel.id = x.release_id and rel.academy_request_id = q.id and rel.state = 'COMPLETED')
    or not exists (select 1 from public.academy_support_execution_provenance p
      where p.execution_id = x.id and p.request_id = q.id) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  end if;
  if exists (select 1 from public.academy_support_turns where execution_id = x.id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select coalesce(max(turn_number), 0) into turns from public.academy_support_turns where request_id = q.id;
  if turns >= 200 then return jsonb_build_object('ok', false, 'code', 'TURN_LIMIT_REACHED'); end if;
  insert into public.academy_support_turns(request_id, learner_id, execution_id, turn_number, learner_message, agent_message)
  values (q.id, actor, x.id, turns + 1, p_learner_message, p_agent_message);
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- The owning learner's conversation, refused during a controlled
-- assessment and after revocation; shown-but-unrecorded replies are
-- counted truthfully.
create function public.list_my_academy_support_turns(p_request_id uuid, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); q public.academy_support_requests%rowtype; e public.academy_enrolments%rowtype;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_request_id is null or p_limit is null or p_limit not between 1 and 50 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into e from public.academy_enrolments where id = q.enrolment_id;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  return jsonb_build_object('ok', true,
    'totalTurns', (select count(*) from public.academy_support_turns where request_id = q.id),
    'unrecordedExchanges', (select count(*) from public.academy_support_execution_provenance p
      join public.tutor_lab_provider_executions x on x.id = p.execution_id
      join public.tutor_lab_content_releases rel on rel.id = x.release_id
      where p.request_id = q.id and x.state = 'SUCCEEDED' and rel.state = 'COMPLETED'
        and not exists (select 1 from public.academy_support_turns t where t.execution_id = x.id)),
    'turns', coalesce((select jsonb_agg(jsonb_build_object('turnNumber', t.turn_number,
        'learnerMessage', t.learner_message, 'agentMessage', t.agent_message, 'recordedAt', t.recorded_at)
        order by t.turn_number)
      from (select * from public.academy_support_turns where request_id = q.id order by turn_number desc limit p_limit) t),
      '[]'::jsonb));
end $$;

-- ==========================================================================
-- Section 6: immutability and privileges, verified.
-- ==========================================================================
do $$ declare t text; begin
  foreach t in array array['academy_support_requests','academy_support_execution_provenance',
    'academy_support_context_reads','academy_support_reservations','academy_support_turns'] loop
    execute format('create trigger guard_history before update or delete on public.%I for each row execute function academy_private.immutable_teaching_row()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('open_my_academy_tutor_support','open_my_academy_lab_support',
      'get_my_academy_support_request','begin_my_academy_support_release','close_my_academy_support_release',
      'read_my_academy_support_context','get_my_academy_support_agent','reserve_my_academy_support_interaction',
      'record_my_academy_support_turn','list_my_academy_support_turns') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- The replaced trigger functions keep their reviewed (revoked) ACLs.
  execute 'revoke all on function tutor_lab_execution_private.guard_content_release() from public, anon, authenticated, service_role';
  execute 'revoke all on function tutor_lab_execution_private.audit_content_release() from public, anon, authenticated, service_role';
  execute 'revoke all on function agent_behaviour_private.record_tutor_lab_provenance() from public, anon, authenticated, service_role';
end $$;

do $$ declare r text; t record; f record; columns text; begin
  for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (c.relname like 'academy\_support\_%' or c.relname = 'tutor_lab_content_releases') loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns
      from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns, columns, columns, columns, t.oid::regclass);
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname like 'academy\_%' or c.relname = 'tutor_lab_content_releases') loop
      if has_table_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe academy table privileges for %', r;
      end if;
    end loop;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'academy_private' or (n.nspname = 'public' and p.proname like '%academy%') loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        f.nspname = 'public' and (r = 'authenticated' or (r = 'anon' and f.proname in
          ('list_academy_catalogue','fulfill_academy_order','apply_academy_commerce_operation')))) then
        raise exception 'Unsafe academy function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
