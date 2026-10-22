-- Ducelio Academy (B2C) Professor / Tutor / Lab Instructor hardening, from
-- an independent review of migrations 062 and 063. Additive: no earlier
-- migration file changes. Each replaced function keeps its signature and
-- reviewed ACL (CREATE OR REPLACE), and its body is the previous body with
-- only the changes listed here.
--
--  1. Graded practicals: the AI Lab Instructor is refused for a practical
--     the package marks as graded, until the owner decides an AI-assistance
--     policy for assessed work. The previous protection was the agent's
--     instructions only, which the Academy rules forbid for assessment
--     integrity. The timetable says why instead of offering the help.
--  2. Lock order: every Academy reply-record writer now takes the shared
--     learner-profile lock first and locks its request or classroom row FOR
--     NO KEY UPDATE (still serialising turn numbering), so it can no longer
--     deadlock with a release or execution insert that holds the profile
--     lock and needs a foreign-key share lock on that row.
--  3. Firewall locking contract (migration 021): the Academy context reads
--     take the learner-profile lock before checking the firewall, so they
--     serialise with controlled-assessment starts.
--  4. Reply records re-prove admission (ownership, ACTIVE unrevoked
--     enrolment, release, no controlled assessment) when written, like the
--     cohort Tutor class notes.
--  5. Reservation ceilings count under a row lock on the request or
--     classroom, so concurrent reservations cannot exceed them.
--  6. An Academy Tutor/Lab release row must agree with its request
--     (learner, role, lesson, objective), enforced by the schema.

-- ==========================================================================
-- 1. Graded practicals.
-- ==========================================================================
create function academy_private.lab_graded(p_course_id uuid, p_key text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select (l.value->>'graded')::boolean
    from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
      jsonb_array_elements(coalesce(p.raw_package->'labs', '[]'::jsonb)) l
    where c.id = p_course_id and l.value->>'activityRef' = p_key limit 1), false)
$$;

create or replace function academy_private.support_admission(p_request_id uuid,
  out q public.academy_support_requests, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; e public.academy_enrolments%rowtype;
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor;
  if q.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  select * into r from academy_private.teaching_enrolment(q.enrolment_id, false);
  if r.code is not null then code := r.code; return; end if;
  e := r.e;
  if q.role = 'LAB_INSTRUCTOR' and academy_private.lab_graded(e.course_id, q.practical_key) then
    code := 'GRADED_PRACTICAL'; return;
  end if;
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

create or replace function public.open_my_academy_lab_support(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
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
  if academy_private.lab_graded(e.course_id, i.ref) then
    return jsonb_build_object('ok', false, 'code', 'GRADED_PRACTICAL');
  end if;
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
        'labGraded', case when i.kind = 'LAB' then academy_private.lab_graded(e.course_id, i.ref) end,
        'studied', case when i.kind = 'LESSON' then exists (select 1 from public.academy_lesson_progress lp
            where lp.enrolment_id = e.id and lp.lesson_ref = i.ref) end,
        'classOpened', case when i.kind = 'LESSON' then cr.id is not null end,
        'teachingTurns', case when i.kind = 'LESSON' then (select count(*) from public.academy_professor_classroom_turns t
            where t.classroom_id = cr.id) end) order by i.sequence), '[]')
      from public.academy_schedule_items i
      left join public.academy_professor_classrooms cr on cr.schedule_item_id = academy_private.root_schedule_item(i.id)
      where i.schedule_id = s.id));
end $$;

-- ==========================================================================
-- 2 and 4. Reply-record writers: lock order and admission.
-- ==========================================================================
create or replace function public.record_my_academy_support_turn(
  p_key_id uuid, p_execution_id uuid, p_request_id uuid, p_learner_message text, p_agent_message text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); q public.academy_support_requests%rowtype; r record;
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
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor for no key update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into r from academy_private.support_admission(q.id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
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

create or replace function public.record_my_academy_professor_turn(
  p_key_id uuid, p_execution_id uuid, p_classroom_id uuid, p_interaction_kind text,
  p_learner_message text, p_professor_message text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); c public.academy_professor_classrooms%rowtype; r record;
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
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor for no key update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into r from academy_private.teaching_classroom(c.id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
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

-- ==========================================================================
-- 3. Context reads: learner-profile lock before the firewall check.
-- ==========================================================================
create or replace function public.read_my_academy_support_context(p_release_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); rel public.tutor_lab_content_releases%rowtype; r record;
  q public.academy_support_requests%rowtype; e public.academy_enrolments%rowtype; l public.lessons%rowtype;
  cfg public.academic_agent_configs%rowtype; pa record; ids uuid[]; keys text[]; data jsonb;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_release_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
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

create or replace function public.read_my_academy_professor_context(p_release_id uuid, p_classroom_id uuid, p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; c public.academy_professor_classrooms%rowtype;
  rel public.academic_content_releases%rowtype; l public.lessons%rowtype; total integer; data jsonb;
begin
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_release_id is null or p_classroom_id is null or p_capability is null or p_capability not in (
    'get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
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

-- ==========================================================================
-- 5. Reservation ceilings counted under a row lock.
-- ==========================================================================
create or replace function public.reserve_my_academy_support_interaction(p_request_id uuid, p_idempotency_key uuid, p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; q public.academy_support_requests%rowtype; existing public.academy_support_reservations%rowtype; n integer;
begin
  if p_request_id is null or p_idempotency_key is null or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.support_admission(p_request_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  q := r.q;
  perform 1 from public.academy_support_requests where id = q.id for no key update;
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

create or replace function public.reserve_my_academy_professor_interaction(p_classroom_id uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; c public.academy_professor_classrooms%rowtype; n integer;
begin
  if p_classroom_id is null or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_classroom(p_classroom_id);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  c := r.c;
  perform 1 from public.academy_professor_classrooms where id = c.id for no key update;
  if exists (select 1 from public.academy_professor_interaction_reservations
      where classroom_id = c.id and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  -- Bounded per classroom: a learner cannot flood the reservation table.
  -- Ceilings sit well above the provider rate limits (migration 025), so a
  -- genuine learner is never refused here first.
  if (select count(*) from public.academy_professor_interaction_reservations
      where classroom_id = c.id and reserved_at > clock_timestamp() - interval '60 seconds') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  if (select count(*) from public.academy_professor_interaction_reservations where classroom_id = c.id) >= 1000 then
    return jsonb_build_object('ok', false, 'code', 'CAPACITY_REACHED');
  end if;
  insert into public.academy_professor_interaction_reservations(classroom_id, idempotency_key)
  values (c.id, p_idempotency_key) on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'duplicate', n = 0);
end $$;

-- ==========================================================================
-- 6. An Academy release row agrees with its request.
-- ==========================================================================
create function academy_private.bind_academy_support_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if NEW.academy_request_id is not null and not exists (select 1 from public.academy_support_requests q
      where q.id = NEW.academy_request_id and q.learner_id = NEW.student_id and q.role = NEW.agent_profile
        and q.lesson_id = NEW.lesson_id and q.objective_id is not distinct from NEW.objective_id) then
    raise exception 'ACADEMY_RELEASE_REQUEST_MISMATCH' using errcode = '55000';
  end if;
  return NEW;
end $$;
create trigger bind_academy_support_release before insert on public.tutor_lab_content_releases
for each row execute function academy_private.bind_academy_support_release();

-- ==========================================================================
-- Privileges, verified (same rules as migrations 060-063).
-- ==========================================================================
do $$ declare f regprocedure; r text; g record; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    for g in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'academy_private' or (n.nspname = 'public' and p.proname like '%academy%') loop
      if has_function_privilege(r, g.oid, 'EXECUTE') is distinct from (
        g.nspname = 'public' and (r = 'authenticated' or (r = 'anon' and g.proname in
          ('list_academy_catalogue','fulfill_academy_order','apply_academy_commerce_operation')))) then
        raise exception 'Unsafe academy function privileges for % on %', r, g.proname;
      end if;
    end loop;
  end loop;
end $$;
