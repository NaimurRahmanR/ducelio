-- Ducelio Academy (B2C), third checkpoint: AI Professor teaching for an
-- individual Academy enrolment. Additive; migrations 001-061 are unchanged
-- except two learner read projections replaced with the same signatures
-- (CREATE OR REPLACE keeps their reviewed ACL).
--
-- The existing governed Professor infrastructure is REUSED, not duplicated:
--   * academic_content_releases (migration 021) -- the PROFESSOR_READ_V2
--     lease every Professor read happens under, begun and closed by the
--     existing begin_/close_academic_content_release;
--   * academic_provider_executions + usage ledger and
--     govern_professor_provider_execution (migration 025) -- AUTHORIZE /
--     START / FINALIZE, rate limits, the hard budget ceiling and expiry,
--     which are student-scoped and enrolment-agnostic;
--   * the controller key store and agent_behaviour_private.verify_mac
--     (migration 051) for attested provenance and memory writes;
--   * the agent configuration (migration 024/050) and the behaviour binding
--     frozen at publication (migration 051), both keyed by the programme
--     version the Academy curriculum was materialised as.
--
-- What is Academy-specific is only the classroom identity: a classroom is
-- one scheduled LESSON session of the learner's own timetable, never a
-- cohort class session, so no cohort, class session, instructor or B2B
-- enrolment is created or required. The cohort tables (enrolments,
-- professor_classroom_sessions, professor_classroom_turns,
-- academic_agent_execution_provenance) are not touched.
--
-- Distinct learning states, never inferred from one another:
--   class scheduled      academy_schedule_items (migration 060)
--   class opened         academy_professor_classrooms (this migration)
--   teaching completed   academy_professor_classroom_turns (this migration)
--   study confirmed      academy_lesson_progress (migration 061)
--   assessment graded    academy_assessment_attempts / academy_lab_marks
--   objective mastery    academy_objective_mastery (MASTERY_V1, evidence only)
--   course completed     academy_completions
-- Opening a class or talking to the Professor writes no evidence, mastery,
-- progress, grade or completion.

-- ==========================================================================
-- Section 1: classrooms.
-- ==========================================================================
-- The first schedule item a (possibly carried) item descends from. A
-- schedule revision carries started items unchanged (carried_from), so a
-- classroom opened before a revision keeps its identity and history.
create function academy_private.root_schedule_item(p_item_id uuid) returns uuid
language sql stable security definer set search_path='' as $$
  with recursive chain(id, carried_from, depth) as (
    select i.id, i.carried_from, 0 from public.academy_schedule_items i where i.id = p_item_id
    union all
    select p.id, p.carried_from, c.depth + 1 from chain c
      join public.academy_schedule_items p on p.id = c.carried_from where c.depth < 60
  )
  select id from chain where carried_from is null order by depth desc limit 1
$$;

create table public.academy_professor_classrooms (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null,
  -- The root scheduled LESSON session this classroom teaches.
  schedule_item_id uuid not null unique references public.academy_schedule_items(id),
  programme_version_id uuid not null references public.programme_versions(id),
  lesson_ref text not null check (length(lesson_ref) between 1 and 80),
  lesson_id uuid not null references public.lessons(id),
  part integer not null check (part >= 1),
  parts integer not null check (parts >= part),
  -- Snapshot of the scheduled session when the class was first opened.
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  opened_at timestamptz not null default clock_timestamp(),
  foreign key (enrolment_id, learner_id) references public.academy_enrolments(id, learner_id),
  check (scheduled_end > scheduled_start),
  check (opened_at >= scheduled_start)
);
create index academy_professor_classrooms_enrolment on public.academy_professor_classrooms(enrolment_id);

create table public.academy_professor_interaction_reservations (
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 100),
  reserved_at timestamptz not null default clock_timestamp(),
  primary key (classroom_id, idempotency_key)
);

-- One Academy read per content release: the release is consumed by exactly
-- one classroom read of exactly its own capability, and the provenance
-- manifest must name only consumed releases of the same classroom.
create table public.academy_professor_context_reads (
  release_id uuid primary key references public.academic_content_releases(id),
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  capability_name text not null check (capability_name in (
    'get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state')),
  read_at timestamptz not null default clock_timestamp()
);

create table public.academy_professor_execution_provenance (
  execution_id uuid primary key references public.academic_provider_executions(id),
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  learner_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.academy_enrolments(id),
  programme_version_id uuid not null references public.programme_versions(id),
  runtime_profile_ref text check (runtime_profile_ref is null or runtime_profile_ref ~ '^[A-Za-z0-9_.-]{1,100}$'),
  institutional_baseline_version text not null check (institutional_baseline_version in ('DUCELIO_INSTITUTIONAL_BASELINE_V1')),
  behaviour_version text not null check (starts_with(behaviour_version, 'PROFESSOR_BEHAVIOUR_V')),
  behaviour_config_source text not null check (behaviour_config_source in ('EXPLICIT','DEFAULT')),
  behaviour_config_version text not null check (behaviour_config_version in ('AGENT_BEHAVIOUR_CONFIG_V1','AGENT_BEHAVIOUR_DEFAULT_V1')),
  behaviour_config_id uuid references public.academic_agent_behaviour_configs(id),
  behaviour_fingerprint text not null check (behaviour_fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check ((behaviour_config_source = 'EXPLICIT') = (behaviour_config_id is not null)),
  check ((behaviour_config_source = 'EXPLICIT') = (behaviour_config_version = 'AGENT_BEHAVIOUR_CONFIG_V1'))
);
create index academy_professor_execution_provenance_classroom on public.academy_professor_execution_provenance(classroom_id);

create table public.academy_professor_execution_context_releases (
  execution_id uuid not null references public.academy_professor_execution_provenance(execution_id),
  release_id uuid not null unique references public.academy_professor_context_reads(release_id),
  capability_name text not null check (capability_name in (
    'get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state')),
  position integer not null check (position between 1 and 4),
  primary key (execution_id, capability_name),
  unique (execution_id, position)
);

-- Learner-visible classroom memory only: the learner's message and the
-- Professor's reply. Not evidence, progress, mastery or a grade.
create table public.academy_professor_classroom_turns (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.academy_professor_classrooms(id),
  learner_id uuid not null references public.student_profiles(user_id),
  execution_id uuid not null unique references public.academy_professor_execution_provenance(execution_id),
  turn_number integer not null check (turn_number between 1 and 200),
  interaction_kind text not null check (interaction_kind in ('BEGIN_LESSON','LEARNER_QUESTION')),
  learner_message text check (learner_message is null or length(learner_message) between 1 and 2000),
  professor_message text not null check (length(professor_message) between 1 and 12000),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (classroom_id, turn_number),
  check ((interaction_kind = 'BEGIN_LESSON') = (learner_message is null))
);

create function academy_private.immutable_teaching_row() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'IMMUTABLE_HISTORY' using errcode = '55000'; end $$;

do $$ declare t text; begin
  foreach t in array array['academy_professor_classrooms','academy_professor_interaction_reservations',
    'academy_professor_context_reads','academy_professor_execution_provenance',
    'academy_professor_execution_context_releases','academy_professor_classroom_turns'] loop
    execute format('create trigger guard_history before update or delete on public.%I for each row execute function academy_private.immutable_teaching_row()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ==========================================================================
-- Section 2: shared admission checks. Every check returns a bounded code;
-- nothing raises past the caller, so a refusal never hides a partial write.
-- ==========================================================================
-- The learner's own ACTIVE, unrevoked enrolment (or a refusal code).
create function academy_private.teaching_enrolment(p_enrolment_id uuid, p_lock boolean,
  out e public.academy_enrolments, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  if p_lock then
    perform 1 from public.student_profiles where user_id = actor for update;
    if not found then code := 'FORBIDDEN'; return; end if;
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor for update;
  else
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor;
  end if;
  if e.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    code := 'ACCESS_REVOKED'; return;
  end if;
  if e.status <> 'ACTIVE' then code := 'ENROLMENT_CLOSED'; return; end if;
end $$;

-- A classroom may teach only while: it is the learner's own; the enrolment
-- is ACTIVE and unrevoked; the lesson is released by the learner's CURRENT
-- schedule (a revision that moves the lesson later closes it again); and no
-- controlled assessment is active in either exam system.
create function academy_private.teaching_classroom(p_classroom_id uuid,
  out c public.academy_professor_classrooms, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record;
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor;
  if c.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  select * into r from academy_private.teaching_enrolment(c.enrolment_id, false);
  if r.code is not null then code := r.code; return; end if;
  if not academy_private.lesson_released(c.enrolment_id, c.lesson_ref) then code := 'NOT_RELEASED'; return; end if;
  if academy_private.exam_active() then code := 'ACTIVITY_BLOCKED'; return; end if;
end $$;

-- ==========================================================================
-- Section 3: entering a scheduled class from the timetable.
-- ==========================================================================
create function public.open_my_academy_professor_classroom(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
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
  select * into i from public.academy_schedule_items where id = p_schedule_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LESSON' then return jsonb_build_object('ok', false, 'code', 'NOT_A_CLASS'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
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

-- Authoritative classroom state, shaped exactly like the cohort classroom
-- state (classSessionId is the scheduled session's identity) so the
-- existing teaching-context builder is reused unchanged.
create function public.get_my_academy_professor_classroom_state(p_classroom_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; c public.academy_professor_classrooms%rowtype; e public.academy_enrolments%rowtype;
  l public.lessons%rowtype; m public.modules%rowtype; cl public.academy_course_lessons%rowtype;
  course public.academy_courses%rowtype; stamp timestamptz;
begin
  if p_classroom_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  c := r.c;
  select * into e from public.academy_enrolments where id = c.enrolment_id;
  select * into course from public.academy_courses where id = e.course_id;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = c.lesson_ref;
  select * into l from public.lessons where id = c.lesson_id;
  select * into m from public.modules where id = l.module_id;
  stamp := clock_timestamp();
  return jsonb_build_object('ok', true,
    'state', jsonb_build_object(
      'classroomId', c.id, 'classSessionId', c.schedule_item_id,
      'enrolmentId', c.enrolment_id, 'programmeVersionId', c.programme_version_id,
      'lessonId', c.lesson_id, 'lessonTitle', l.title, 'lessonPosition', cl.sequence,
      'moduleTitle', m.title, 'scheduledStart', c.scheduled_start, 'scheduledEnd', c.scheduled_end,
      'serverNow', stamp,
      'mode', case when stamp <= c.scheduled_end then 'LIVE' else 'CATCH_UP' end),
    'view', jsonb_build_object('courseTitle', course.title, 'lessonRef', c.lesson_ref,
      'part', c.part, 'parts', c.parts, 'openedAt', c.opened_at));
end $$;

-- Reserved before any provider call: a replayed submission of the same
-- learner action can never cause a second provider call.
create function public.reserve_my_academy_professor_interaction(p_classroom_id uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; c public.academy_professor_classrooms%rowtype; n integer;
begin
  if p_classroom_id is null or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  c := r.c;
  insert into public.academy_professor_interaction_reservations(classroom_id, idempotency_key)
  values (c.id, p_idempotency_key) on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'duplicate', n = 0);
end $$;

-- ==========================================================================
-- Section 4: governed content reads. Each read happens under the learner's
-- own ACTIVE PROFESSOR_READ_V2 release of exactly that capability, consumes
-- the release, and returns the reviewed capability output shape. Only the
-- approved published curriculum of the enrolment's programme version is
-- read: lesson, published objectives, approved learner resources and
-- persisted Academy mastery. Never assessment questions, answer keys, lab
-- rubrics or marking guidance.
-- ==========================================================================
create function public.read_my_academy_professor_context(p_release_id uuid, p_classroom_id uuid, p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; c public.academy_professor_classrooms%rowtype;
  rel public.academic_content_releases%rowtype; l public.lessons%rowtype; total integer; data jsonb;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_release_id is null or p_classroom_id is null or p_capability is null or p_capability not in (
    'get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into rel from public.academic_content_releases where id = p_release_id and student_id = actor for update;
  if not found or rel.state <> 'ACTIVE' or rel.expires_at <= clock_timestamp()
    or rel.agent_profile <> 'PROFESSOR' or rel.capability_contract_version <> 'PROFESSOR_READ_V2'
    or rel.capability_name <> p_capability
    or exists (select 1 from public.academy_professor_context_reads where release_id = rel.id) then
    return jsonb_build_object('ok', false, 'code', 'CONTENT_RELEASE_UNAVAILABLE');
  end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  c := r.c;
  select * into l from public.lessons where id = c.lesson_id and programme_version_id = c.programme_version_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if p_capability = 'get_lesson_context' then
    data := jsonb_build_object('enrolmentId', c.enrolment_id, 'programmeVersionId', c.programme_version_id,
      'lessonId', l.id, 'moduleId', l.module_id, 'title', l.title, 'position', l.position);
  elsif p_capability = 'get_lesson_objectives' then
    select count(*) into total from public.lesson_objectives o
      where o.lesson_id = l.id and o.programme_version_id = c.programme_version_id;
    data := jsonb_build_object('enrolmentId', c.enrolment_id, 'programmeVersionId', c.programme_version_id, 'lessonId', l.id,
      'objectives', coalesce((select jsonb_agg(jsonb_build_object('objectiveId', o.id, 'description', o.description,
          'position', o.position) order by o.position)
        from (select * from public.lesson_objectives o where o.lesson_id = l.id
              and o.programme_version_id = c.programme_version_id order by o.position limit 50) o), '[]'::jsonb),
      'nextAfterPosition', case when total > 50 then (select o.position from public.lesson_objectives o
          where o.lesson_id = l.id and o.programme_version_id = c.programme_version_id order by o.position offset 49 limit 1) end);
  elsif p_capability = 'get_learning_resources' then
    select count(*) into total from public.learning_resources x
      where x.lesson_id = l.id and x.programme_version_id = c.programme_version_id;
    data := jsonb_build_object('enrolmentId', c.enrolment_id, 'programmeVersionId', c.programme_version_id, 'lessonId', l.id,
      'resources', coalesce((select jsonb_agg(jsonb_build_object('resourceId', x.id, 'title', x.title, 'position', x.position,
          'kind', x.kind, 'body', x.body, 'url', x.url) order by x.position)
        from (select * from public.learning_resources x where x.lesson_id = l.id
              and x.programme_version_id = c.programme_version_id order by x.position limit 5) x), '[]'::jsonb),
      'nextCursor', case when total > 5 then jsonb_build_object('afterPosition', (select x.position from public.learning_resources x
          where x.lesson_id = l.id and x.programme_version_id = c.programme_version_id order by x.position offset 4 limit 1)) end);
  else
    data := jsonb_build_object('enrolmentId', c.enrolment_id, 'programmeVersionId', c.programme_version_id, 'lessonId', l.id,
      'persistedOnly', true,
      'records', coalesce((select jsonb_agg(jsonb_build_object('objectiveId', m.objective_id, 'state', m.state,
          'policyVersion', m.policy_version, 'evaluatedAt', m.evaluated_at, 'evidenceCount', m.evidence_count,
          'correctEvidenceCount', m.correct_evidence_count, 'correctSessionCount', m.correct_session_count,
          'correctKindCount', m.correct_kind_count) order by o.position)
        from public.academy_objective_mastery m join public.lesson_objectives o on o.id = m.objective_id
        where m.enrolment_id = c.enrolment_id and o.lesson_id = l.id), '[]'::jsonb));
  end if;
  insert into public.academy_professor_context_reads(release_id, classroom_id, capability_name)
  values (rel.id, c.id, p_capability);
  return jsonb_build_object('ok', true, 'data', data);
end $$;

-- The Professor configuration and the behaviour binding frozen when the
-- Academy curriculum's programme version was published: the same sources
-- the cohort path reads, resolved from the Academy enrolment.
create function public.get_my_academy_professor_agent(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; cfg public.academic_agent_configs%rowtype; eff jsonb;
begin
  if p_enrolment_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, false);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  select * into cfg from public.academic_agent_configs c where c.programme_version_id = e.programme_version_id and c.role = 'PROFESSOR';
  eff := agent_behaviour_private.effective_behaviour(e.programme_version_id, 'PROFESSOR');
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
-- Section 5: attested provenance and memory. Same controller key store and
-- verifier as migration 051, with Academy-only protocol tags, so no cohort
-- attestation can authorize an Academy write and vice versa.
-- ==========================================================================
create function public.record_my_academy_professor_provenance(
  p_key_id uuid, p_execution_id uuid, p_release_id uuid, p_classroom_id uuid,
  p_context_capabilities text[], p_context_release_ids uuid[],
  p_runtime_profile_ref text, p_institutional_baseline_version text,
  p_behaviour_version text, p_behaviour_config_version text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; c public.academy_professor_classrooms%rowtype;
  x public.academic_provider_executions%rowtype; cfg public.academic_agent_configs%rowtype; eff record;
  db_ref text; fingerprint text; manifest text; expected text[]; outer_release public.academic_content_releases%rowtype; n integer;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_release_id is null or p_classroom_id is null
    or p_institutional_baseline_version is null or p_behaviour_version is null or p_behaviour_config_version is null
    or p_context_capabilities is null or p_context_release_ids is null
    or cardinality(p_context_capabilities) not between 2 and 4
    or cardinality(p_context_capabilities) <> cardinality(p_context_release_ids)
    or array_position(p_context_capabilities, null) is not null
    or array_position(p_context_release_ids, null) is not null
    or (p_runtime_profile_ref is not null and p_runtime_profile_ref !~ '^[A-Za-z0-9_.-]{1,100}$') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  manifest := array_to_string(array(
    select u.capability || ':' || u.release_id::text
    from unnest(p_context_capabilities, p_context_release_ids) with ordinality as u(capability, release_id, n)
    order by u.n), ',');
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_ACADEMY_PROFESSOR_PROVENANCE_HMAC_SHA256_V1', 'PROFESSOR', p_key_id::text, actor::text,
      p_execution_id::text, p_release_id::text, p_classroom_id::text, manifest,
      coalesce(p_runtime_profile_ref, 'NONE'), p_institutional_baseline_version,
      p_behaviour_version, p_behaviour_config_version,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  select * into x from public.academic_provider_executions
    where id = p_execution_id and student_id = actor and release_id = p_release_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'AUTHORIZED' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if exists (select 1 from public.academy_professor_execution_provenance where execution_id = x.id)
    or exists (select 1 from public.academic_agent_execution_provenance where professor_execution_id = x.id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_RECORDED');
  end if;
  -- Admission is re-proven here, immediately before START: own classroom,
  -- ACTIVE unrevoked enrolment, lesson released, no controlled assessment.
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  c := r.c;
  select * into cfg from public.academic_agent_configs where programme_version_id = c.programme_version_id and role = 'PROFESSOR';
  if not found or not cfg.enabled or cfg.escalation_policy <> 'NONE' then
    return jsonb_build_object('ok', false, 'code', 'POLICY_BLOCKED');
  end if;
  db_ref := agent_behaviour_private.runtime_profile_ref(c.programme_version_id, 'PROFESSOR');
  select * into eff from agent_behaviour_private.effective_config(c.programme_version_id, 'PROFESSOR');
  fingerprint := agent_behaviour_private.behaviour_fingerprint(c.programme_version_id);
  if not eff.ok or fingerprint is null then return jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_INVALID'); end if;
  if db_ref is distinct from p_runtime_profile_ref
    or p_institutional_baseline_version is distinct from agent_behaviour_private.institutional_baseline_version()
    or p_behaviour_version is distinct from eff.behaviour_version
    or p_behaviour_config_version is distinct from eff.config_version then
    return jsonb_build_object('ok', false, 'code', 'PROVENANCE_MISMATCH');
  end if;
  expected := array['get_lesson_context','get_lesson_objectives'];
  if 'get_learning_resources' = any(cfg.capabilities) then expected := expected || 'get_learning_resources'::text; end if;
  if 'get_current_mastery_state' = any(cfg.capabilities) then expected := expected || 'get_current_mastery_state'::text; end if;
  if not ('get_lesson_context' = any(cfg.capabilities) and 'get_lesson_objectives' = any(cfg.capabilities))
    or p_context_capabilities is distinct from expected or p_context_release_ids[1] <> p_release_id
    or (select count(distinct v) from unnest(p_context_release_ids) v) <> cardinality(p_context_release_ids) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_MANIFEST_MISMATCH');
  end if;
  select * into outer_release from public.academic_content_releases where id = p_release_id;
  for n in 1..cardinality(p_context_release_ids) loop
    if not exists (select 1 from public.academic_content_releases rr
        join public.academy_professor_context_reads cr on cr.release_id = rr.id
        where rr.id = p_context_release_ids[n] and rr.student_id = actor
          and rr.agent_profile = 'PROFESSOR' and rr.capability_contract_version = 'PROFESSOR_READ_V2'
          and rr.capability_name = p_context_capabilities[n]
          and rr.state = 'ACTIVE' and rr.expires_at > clock_timestamp()
          and rr.started_at >= outer_release.started_at
          and cr.classroom_id = c.id and cr.capability_name = p_context_capabilities[n])
      or exists (select 1 from public.academy_professor_execution_context_releases m where m.release_id = p_context_release_ids[n]) then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_RELEASE_INVALID');
    end if;
  end loop;
  insert into public.academy_professor_execution_provenance(execution_id, classroom_id, learner_id, enrolment_id,
    programme_version_id, runtime_profile_ref, institutional_baseline_version, behaviour_version, behaviour_config_source,
    behaviour_config_version, behaviour_config_id, behaviour_fingerprint)
  values (x.id, c.id, actor, c.enrolment_id, c.programme_version_id, db_ref, p_institutional_baseline_version,
    eff.behaviour_version, eff.source, eff.config_version, eff.config_id, fingerprint);
  insert into public.academy_professor_execution_context_releases(execution_id, release_id, capability_name, position)
  select x.id, u.release_id, u.capability, u.n
  from unnest(p_context_capabilities, p_context_release_ids) with ordinality as u(capability, release_id, n);
  return jsonb_build_object('ok', true);
end $$;

-- Recorded only after FINALIZE confirmed SUCCEEDED. Memory writes do not
-- re-check the firewall: the exchange was already shown, and recording it
-- truthfully is better than hiding it (the read path is firewall-gated).
create function public.record_my_academy_professor_turn(
  p_key_id uuid, p_execution_id uuid, p_classroom_id uuid, p_interaction_kind text,
  p_learner_message text, p_professor_message text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); c public.academy_professor_classrooms%rowtype;
  x public.academic_provider_executions%rowtype; turns integer;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_classroom_id is null
    or p_interaction_kind is null or p_interaction_kind not in ('BEGIN_LESSON','LEARNER_QUESTION')
    or ((p_interaction_kind = 'BEGIN_LESSON') <> (p_learner_message is null))
    or (p_learner_message is not null and length(p_learner_message) not between 1 and 2000)
    or p_professor_message is null or length(p_professor_message) not between 1 and 12000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_ACADEMY_CLASSROOM_TURN_HMAC_SHA256_V1', 'PROFESSOR', p_key_id::text, actor::text,
      p_execution_id::text, p_classroom_id::text, p_interaction_kind,
      encode(extensions.digest(convert_to(coalesce(p_learner_message, ''), 'UTF8'), 'sha256'), 'hex'),
      encode(extensions.digest(convert_to(p_professor_message, 'UTF8'), 'sha256'), 'hex'),
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into x from public.academic_provider_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'SUCCEEDED' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if not exists (select 1 from public.academy_professor_execution_provenance where execution_id = x.id and classroom_id = c.id) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  if exists (select 1 from public.academy_professor_classroom_turns where execution_id = x.id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select coalesce(max(turn_number), 0) into turns from public.academy_professor_classroom_turns where classroom_id = c.id;
  if turns >= 200 then return jsonb_build_object('ok', false, 'code', 'TURN_LIMIT_REACHED'); end if;
  insert into public.academy_professor_classroom_turns(classroom_id, learner_id, execution_id, turn_number,
    interaction_kind, learner_message, professor_message)
  values (c.id, actor, x.id, turns + 1, p_interaction_kind, p_learner_message, p_professor_message);
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- The owning learner's transcript, refused while a controlled assessment is
-- active (a transcript of explanations is explanation content) and once
-- access is revoked. Same shape as the cohort classroom memory read.
create function public.list_my_academy_professor_turns(p_classroom_id uuid, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); c public.academy_professor_classrooms%rowtype; e public.academy_enrolments%rowtype;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_classroom_id is null or p_limit is null or p_limit not between 1 and 50 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into e from public.academy_enrolments where id = c.enrolment_id;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  return jsonb_build_object('ok', true,
    'totalTurns', (select count(*) from public.academy_professor_classroom_turns where classroom_id = c.id),
    'capacity', 200,
    'capacityReached', coalesce((select max(turn_number) from public.academy_professor_classroom_turns where classroom_id = c.id), 0) >= 200,
    'unrecordedExchanges', (select count(*) from public.academy_professor_execution_provenance p
      join public.academic_provider_executions x on x.id = p.execution_id
      where p.classroom_id = c.id and x.state = 'SUCCEEDED'
        and not exists (select 1 from public.academy_professor_classroom_turns t where t.execution_id = x.id)),
    'turns', coalesce((
      select jsonb_agg(jsonb_build_object('turnNumber', t.turn_number, 'interactionKind', t.interaction_kind,
        'learnerMessage', t.learner_message, 'professorMessage', t.professor_message, 'recordedAt', t.recorded_at)
        order by t.turn_number)
      from (select * from public.academy_professor_classroom_turns where classroom_id = c.id
            order by turn_number desc limit p_limit) t), '[]'::jsonb));
end $$;

-- ==========================================================================
-- Section 6: learner projections with the distinct teaching states. Same
-- signatures as migration 061; only fields are added.
-- ==========================================================================
create or replace function public.get_my_academy_timetable(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
  s public.academy_schedules%rowtype; pkg jsonb; course public.academy_courses%rowtype; revoked boolean;
begin
  s := academy_private.current_schedule(e.id);
  select * into course from public.academy_courses where id = e.course_id;
  revoked := exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED');
  if s.id is null then
    return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'schedule', null, 'items', '[]'::jsonb, 'accessRevoked', revoked);
  end if;
  select raw_package into pkg from public.academy_course_packages where id = course.package_id;
  return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'status', e.status, 'serverTime', clock_timestamp(),
    'accessRevoked', revoked, 'examActive', academy_private.exam_active(),
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
            where l.enrolment_id = e.id and l.lab_ref = i.ref) end,
        'studied', case when i.kind = 'LESSON' then exists (select 1 from public.academy_lesson_progress lp
            where lp.enrolment_id = e.id and lp.lesson_ref = i.ref) end,
        'classOpened', case when i.kind = 'LESSON' then cr.id is not null end,
        'teachingTurns', case when i.kind = 'LESSON' then (select count(*) from public.academy_professor_classroom_turns t
            where t.classroom_id = cr.id) end) order by i.sequence), '[]')
      from public.academy_schedule_items i
      left join public.academy_professor_classrooms cr on cr.schedule_item_id = academy_private.root_schedule_item(i.id)
      where i.schedule_id = s.id));
end $$;

create or replace function public.get_my_academy_progress(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
begin
  return jsonb_build_object('enrolmentId', e.id,
    'lessons', (select count(*) from public.academy_course_lessons where course_id = e.course_id),
    'released', (select count(*) from public.academy_course_lessons cl where cl.course_id = e.course_id
                 and academy_private.lesson_released(e.id, cl.lesson_ref)),
    'classesOpened', (select count(*) from public.academy_professor_classrooms where enrolment_id = e.id),
    'teachingInteractions', (select count(*) from public.academy_professor_classroom_turns t
      join public.academy_professor_classrooms c on c.id = t.classroom_id where c.enrolment_id = e.id),
    'studied', (select count(*) from public.academy_lesson_progress where enrolment_id = e.id),
    'objectives', (select coalesce(jsonb_agg(jsonb_build_object('objectiveId', lo.id, 'lessonRef', cl.lesson_ref,
        'description', lo.description, 'state', coalesce(m.state, 'NOT_STARTED'), 'evidence', coalesce(m.evidence_count, 0))
        order by cl.sequence, lo.position), '[]')
      from public.academy_course_lessons cl join public.lesson_objectives lo on lo.lesson_id = cl.lesson_id
      left join public.academy_objective_mastery m on m.enrolment_id = e.id and m.objective_id = lo.id
      where cl.course_id = e.course_id),
    'policyVersion', 'MASTERY_V1');
end $$;

-- ==========================================================================
-- Section 7: privileges, verified.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('open_my_academy_professor_classroom',
      'get_my_academy_professor_classroom_state','reserve_my_academy_professor_interaction',
      'read_my_academy_professor_context','get_my_academy_professor_agent',
      'record_my_academy_professor_provenance','record_my_academy_professor_turn','list_my_academy_professor_turns') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

do $$ declare r text; t record; f record; columns text; begin
  for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'academy\_professor\_%' loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns
      from pg_attribute where attrelid = t.oid and attnum > 0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns, columns, columns, columns, t.oid::regclass);
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'academy\_%' loop
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
