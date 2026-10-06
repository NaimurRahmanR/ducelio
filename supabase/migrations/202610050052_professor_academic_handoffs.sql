-- AC-3: minimum-data governed academic handoffs from a Professor classroom
-- to the Tutor or Lab Instructor. Additive only; migrations 001-051 are
-- byte-for-byte unchanged, and no existing attested message format
-- (022/025/028/031/032/040/051) is altered.
--
-- Design (docs/45-agent-behaviour-ac3.md):
--
-- 1. The learner delivery handoff contract (migrations 023/028/043) is NOT
--    altered. A Professor follow-up composes the existing, unmodified
--    public.request_delivery_handoff (Tutor, OBJECTIVE_REINFORCEMENT) or
--    public.request_practical_support (Lab Instructor, PRACTICAL_HELP),
--    exactly as migration 028 composed request_delivery_handoff, so every
--    existing ownership, firewall, limit, idempotency and Tutor/Lab
--    execution rule applies unchanged. The resulting delivery handoff is an
--    ordinary learner handoff (provenance LEARNER_REQUEST: the learner asks
--    for it from their own classroom).
-- 2. An additive, immutable link row (professor_academic_handoffs) records
--    the minimum academic continuation projection: which delivery handoff,
--    the source Professor execution and its AC-2 provenance, and the
--    classroom/lesson/objective-or-practical scope -- every identity derived
--    or verified by the database. It stores no transcript, learner or
--    Professor text, provider output, prompt, reasoning or free text: the
--    only text is a fixed, code-owned summary pinned by a CHECK.
-- 3. A release-scoped read gives the Tutor/Lab runtime the projection only
--    for the learner's own ACTIVE Tutor/Lab content release of that exact
--    delivery handoff, and only while the controlled-assessment firewall
--    allows explanation.
-- 4. Level 2: TUTOR_BEHAVIOUR_V1 and LAB_INSTRUCTOR_BEHAVIOUR_V1 state that
--    no Professor record exists, so their text is never edited. New reviewed
--    versions TUTOR_BEHAVIOUR_V2 / LAB_INSTRUCTOR_BEHAVIOUR_V2 (code-owned in
--    src/domain/agent-behaviour.ts) become the version a NEW publication
--    freezes. Versions already frozen on V1 keep V1 exactly (AC-2 pinning)
--    and their Tutor/Lab never receive a Professor record. Consequently a
--    Professor academic handoff is CREATED only when the destination role's
--    frozen binding is the AC-3-aware V2 (DESTINATION_BEHAVIOUR_UNSUPPORTED
--    otherwise, before anything is written); V1 versions keep the ordinary
--    learner Tutor/Lab handoff flows unchanged.

-- ==========================================================================
-- 1. Level-2 role behaviour versions (AC-2 mirrors, additive widening).
-- ==========================================================================
create or replace function agent_behaviour_private.role_behaviour_version(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'PROFESSOR' then 'PROFESSOR_BEHAVIOUR_V1'
    when 'TUTOR' then 'TUTOR_BEHAVIOUR_V2'
    when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_BEHAVIOUR_V2'
    else null
  end
$$;

create or replace function agent_behaviour_private.recognised_role_behaviour_version(p_role text, p_version text) returns boolean
language sql immutable set search_path='' as $$
  select (p_role, p_version) in (('PROFESSOR','PROFESSOR_BEHAVIOUR_V1'),
    ('TUTOR','TUTOR_BEHAVIOUR_V1'), ('LAB_INSTRUCTOR','LAB_INSTRUCTOR_BEHAVIOUR_V1'),
    ('TUTOR','TUTOR_BEHAVIOUR_V2'), ('LAB_INSTRUCTOR','LAB_INSTRUCTOR_BEHAVIOUR_V2'))
$$;

-- Widen the reviewed version lists on the binding and provenance tables
-- (migration 051 named every known version; a new version needs exactly
-- this reviewed migration). Existing V1 rows remain valid.
do $$ declare t text; c record; begin
  foreach t in array array['public.academic_agent_behaviour_bindings','public.academic_agent_execution_provenance'] loop
    for c in select conname from pg_constraint
      where conrelid = t::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%''PROFESSOR_BEHAVIOUR_V1''%'
        and pg_get_constraintdef(oid) like '%behaviour_version%' loop
      execute format('alter table %s drop constraint %I', t, c.conname);
    end loop;
    execute format('alter table %s add constraint %I check(behaviour_version in (%s))', t,
      replace(split_part(t, '.', 2), 'academic_agent_', '') || '_behaviour_version_known',
      '''PROFESSOR_BEHAVIOUR_V1'',''TUTOR_BEHAVIOUR_V1'',''LAB_INSTRUCTOR_BEHAVIOUR_V1'',''TUTOR_BEHAVIOUR_V2'',''LAB_INSTRUCTOR_BEHAVIOUR_V2''');
  end loop;
end $$;

-- ==========================================================================
-- 2. The minimum-data Professor academic handoff projection.
-- ==========================================================================
create schema professor_handoff_private;
revoke all on schema professor_handoff_private from public, anon, authenticated, service_role;

-- Fixed, code-owned learner-safe summaries (mirror of
-- src/domain/professor-academic-handoff.ts). Never model-generated.
create function professor_handoff_private.summary(p_reason_code text) returns text
language sql immutable set search_path='' as $$
  select case p_reason_code
    when 'OBJECTIVE_REINFORCEMENT' then 'After a Professor lesson, the learner asked the Tutor to reinforce this objective.'
    when 'PRACTICAL_HELP' then 'After a Professor lesson, the learner asked the Lab Instructor for help with this practical.'
  end
$$;

create table public.professor_academic_handoffs (
  id uuid primary key default gen_random_uuid(),
  handoff_policy text not null default 'PROFESSOR_ACADEMIC_HANDOFF_V1' check(handoff_policy = 'PROFESSOR_ACADEMIC_HANDOFF_V1'),
  -- The ordinary learner delivery handoff this projection belongs to (1:1).
  handoff_id uuid not null unique references public.delivery_handoffs(id),
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.enrolments(id),
  programme_version_id uuid not null references public.programme_versions(id),
  classroom_id uuid not null references public.professor_classroom_sessions(id),
  class_session_id uuid not null references public.class_sessions(id),
  lesson_id uuid not null references public.lessons(id),
  objective_id uuid references public.lesson_objectives(id),
  practical_id uuid references public.course_practicals(id),
  source_role text not null default 'PROFESSOR' check(source_role = 'PROFESSOR'),
  destination_role text not null check(destination_role in ('TUTOR','LAB_INSTRUCTOR')),
  reason_code text not null check(reason_code in ('OBJECTIVE_REINFORCEMENT','PRACTICAL_HELP')),
  source_professor_execution_id uuid not null references public.academic_provider_executions(id),
  source_provenance_id uuid not null references public.academic_agent_execution_provenance(id),
  summary text not null,
  scope_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  -- Idempotent per classroom and scope: one record per (reason, objective
  -- or practical) in a classroom, whichever source execution created it.
  unique(classroom_id, reason_code, scope_key),
  check((reason_code = 'OBJECTIVE_REINFORCEMENT') = (destination_role = 'TUTOR')),
  check(reason_code <> 'OBJECTIVE_REINFORCEMENT' or (objective_id is not null and practical_id is null)),
  check(reason_code <> 'PRACTICAL_HELP' or (practical_id is not null and objective_id is null)),
  check(summary = professor_handoff_private.summary(reason_code)),
  check(scope_key = case when objective_id is not null then 'OBJECTIVE:' || objective_id::text
    else 'PRACTICAL:' || practical_id::text end)
);
create index professor_academic_handoffs_classroom on public.professor_academic_handoffs(classroom_id, created_at);
alter table public.professor_academic_handoffs enable row level security;
revoke all on public.professor_academic_handoffs from public, anon, authenticated, service_role;

create function professor_handoff_private.immutable() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'PROFESSOR_HANDOFF_IMMUTABLE: a Professor academic handoff cannot be updated or deleted'
    using errcode = '55000';
end $$;
create trigger guard_professor_academic_handoff
before update or delete on public.professor_academic_handoffs
for each row execute function professor_handoff_private.immutable();

-- Audit identifiers and fixed codes only (the row holds no prose).
create function professor_handoff_private.audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id, action, target_type, target_id, reason, before_state, after_state)
  values (public.current_app_user(), 'INSERT', 'professor_academic_handoffs', NEW.id,
    'Learner-requested Professor follow-up', null,
    jsonb_build_object('handoff_policy', NEW.handoff_policy, 'handoff_id', NEW.handoff_id,
      'enrolment_id', NEW.enrolment_id, 'classroom_id', NEW.classroom_id, 'lesson_id', NEW.lesson_id,
      'objective_id', NEW.objective_id, 'practical_id', NEW.practical_id,
      'destination_role', NEW.destination_role, 'reason_code', NEW.reason_code,
      'source_professor_execution_id', NEW.source_professor_execution_id));
  return NEW;
end $$;
create trigger audit_professor_academic_handoff
after insert on public.professor_academic_handoffs
for each row execute function professor_handoff_private.audit();

-- ==========================================================================
-- 3. Learner-initiated creation.
-- ==========================================================================
-- Everything is derived from the authenticated learner and the classroom
-- they own; the caller supplies only the class session, one of two reviewed
-- reason codes, and the objective (Tutor) or practical (Lab) to follow up.
-- No summary, destination, execution, provenance, lesson, enrolment or
-- version is accepted from the caller.
create function public.request_professor_academic_handoff(
  p_class_session_id uuid, p_reason_code text, p_objective_id uuid, p_practical_id uuid
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; c public.professor_classroom_sessions%rowtype; e public.enrolments%rowtype;
  source_execution uuid; source_provenance uuid; prior public.professor_academic_handoffs%rowtype;
  scope text; destination text; request_id uuid; handoff uuid; objective_count integer;
  destination_behaviour jsonb; required_behaviour_version text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_class_session_id is null or p_reason_code is null
    or p_reason_code not in ('OBJECTIVE_REINFORCEMENT','PRACTICAL_HELP')
    or (p_reason_code = 'OBJECTIVE_REINFORCEMENT' and (p_objective_id is null or p_practical_id is not null))
    or (p_reason_code = 'PRACTICAL_HELP' and (p_practical_id is null or p_objective_id is not null)) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- The classroom row lock serialises concurrent requests for the same
  -- classroom (the idempotency check and the insert happen under it).
  select * into c from public.professor_classroom_sessions
    where student_id = actor and class_session_id = p_class_session_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  select * into e from public.enrolments
    where id = c.enrolment_id and student_id = actor and programme_version_id = c.programme_version_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;

  -- Source: the learner's most recent SUCCEEDED Professor execution in THIS
  -- classroom, whose AC-2 provenance (database-derived) names this exact
  -- classroom, enrolment and version, and whose attested context-release
  -- manifest shows the lesson objectives were part of the governed context.
  select x.id, p.id into source_execution, source_provenance
    from public.academic_agent_execution_provenance p
    join public.academic_provider_executions x on x.id = p.professor_execution_id
    where p.execution_kind = 'PROFESSOR_PROVIDER_V2' and p.role = 'PROFESSOR'
      and p.classroom_id = c.id and p.student_id = actor and x.student_id = actor
      and p.enrolment_id = c.enrolment_id and p.programme_version_id = c.programme_version_id
      and x.agent_profile = 'PROFESSOR' and x.state = 'SUCCEEDED'
      and exists(select 1 from public.academic_agent_execution_context_releases m
        where m.professor_execution_id = x.id and m.capability_name = 'get_lesson_objectives')
    order by x.terminal_at desc, x.id desc limit 1;
  if source_execution is null then return jsonb_build_object('ok', false, 'code', 'NO_SOURCE_EXECUTION'); end if;

  if p_reason_code = 'OBJECTIVE_REINFORCEMENT' then
    if not exists(select 1 from public.lesson_objectives
        where id = p_objective_id and lesson_id = c.lesson_id and programme_version_id = c.programme_version_id) then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
    end if;
    -- The Professor runtime refuses any lesson whose objectives exceed one
    -- governed page (50) and otherwise sends the COMPLETE set (AC-2), and a
    -- published curriculum is immutable. So an objective of this lesson was
    -- in the source execution's context exactly when the lesson has at most
    -- 50 objectives. Beyond that it cannot be proven: refuse.
    select count(*) into objective_count from public.lesson_objectives
      where lesson_id = c.lesson_id and programme_version_id = c.programme_version_id;
    if objective_count > 50 then return jsonb_build_object('ok', false, 'code', 'OBJECTIVE_SCOPE_UNPROVEN'); end if;
    scope := 'OBJECTIVE:' || p_objective_id::text; destination := 'TUTOR';
  else
    if not exists(select 1 from public.course_practicals cp
        where cp.id = p_practical_id and cp.lesson_id = c.lesson_id and cp.programme_version_id = c.programme_version_id
          and cp.kind = 'PRACTICAL_LAB'
          and exists(select 1 from public.course_activations a where a.import_id = cp.import_id and a.cohort_id = e.cohort_id)) then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
    end if;
    scope := 'PRACTICAL:' || p_practical_id::text; destination := 'LAB_INSTRUCTOR';
  end if;

  -- The destination must be able to consume the record. Its role behaviour
  -- version is read from the programme version's FROZEN AC-2 binding (the
  -- verified binding, never the live/current version) and must be exactly
  -- the reviewed AC-3-aware version. A missing, invalid or V1 binding is
  -- refused here, before any delivery handoff is composed, so no
  -- Professor-labelled handoff exists that Tutor/Lab could never read.
  destination_behaviour := agent_behaviour_private.effective_behaviour(c.programme_version_id, destination);
  required_behaviour_version := case destination when 'TUTOR' then 'TUTOR_BEHAVIOUR_V2'
    else 'LAB_INSTRUCTOR_BEHAVIOUR_V2' end;
  if not coalesce((destination_behaviour->>'ok')::boolean, false)
    or destination_behaviour->>'state' is distinct from 'BOUND'
    or destination_behaviour->>'behaviourVersion' is distinct from required_behaviour_version then
    return jsonb_build_object('ok', false, 'code', 'DESTINATION_BEHAVIOUR_UNSUPPORTED');
  end if;

  select * into prior from public.professor_academic_handoffs
    where classroom_id = c.id and reason_code = p_reason_code and scope_key = scope;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'handoffId', prior.handoff_id);
  end if;
  if (select count(*) from public.professor_academic_handoffs where classroom_id = c.id) >= 20 then
    return jsonb_build_object('ok', false, 'code', 'LIMIT_EXCEEDED');
  end if;

  -- Deterministic request id, so the composed delivery handoff is itself
  -- idempotent under migration 023's (requested_by, request_id) identity.
  request_id := md5('PROFESSOR_ACADEMIC_HANDOFF_V1|' || c.id::text || '|' || p_reason_code || '|' || scope)::uuid;
  begin
    if p_reason_code = 'OBJECTIVE_REINFORCEMENT' then
      handoff := public.request_delivery_handoff(e.id, c.lesson_id, p_objective_id, 'OBJECTIVE_REINFORCEMENT', request_id);
    else
      handoff := public.request_practical_support(e.id, p_practical_id, request_id);
    end if;
    if not exists(select 1 from public.delivery_handoffs h where h.id = handoff and h.requested_by = actor
        and h.enrolment_id = e.id and h.lesson_id = c.lesson_id and h.destination_profile = destination
        and h.reason_code = p_reason_code and h.objective_id is not distinct from p_objective_id) then
      raise exception 'CONTEXT_CONFLICT';
    end if;
    insert into public.professor_academic_handoffs(
      handoff_id, student_id, enrolment_id, programme_version_id, classroom_id, class_session_id, lesson_id,
      objective_id, practical_id, destination_role, reason_code, source_professor_execution_id,
      source_provenance_id, summary, scope_key
    ) values (
      handoff, actor, e.id, c.programme_version_id, c.id, c.class_session_id, c.lesson_id,
      p_objective_id, p_practical_id, destination, p_reason_code, source_execution,
      source_provenance, professor_handoff_private.summary(p_reason_code), scope
    );
  exception when others then
    -- Everything in this block is rolled back; known governed refusals are
    -- reported as codes, anything else is re-raised.
    if sqlerrm in ('ACTIVITY_BLOCKED','LIMIT_EXCEEDED','CONTEXT_CONFLICT','NOT_FOUND_OR_FORBIDDEN','INVALID_INPUT','POLICY_BLOCKED','FORBIDDEN') then
      return jsonb_build_object('ok', false, 'code', sqlerrm);
    end if;
    raise;
  end;
  return jsonb_build_object('ok', true, 'duplicate', false, 'handoffId', handoff);
end $$;

-- ==========================================================================
-- 4. Learner visibility: exactly what was handed off, for one classroom.
-- ==========================================================================
create function public.list_my_professor_academic_handoffs(p_class_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; c public.professor_classroom_sessions%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_class_session_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into c from public.professor_classroom_sessions where student_id = actor and class_session_id = p_class_session_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  -- Objective and practical text is lesson content: firewall-gated.
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  return jsonb_build_object('ok', true, 'handoffs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'handoffId', a.handoff_id, 'destinationRole', a.destination_role, 'reasonCode', a.reason_code,
      'lessonTitle', l.title, 'objectiveDescription', o.description, 'practicalTitle', cp.title,
      'summary', a.summary, 'createdAt', a.created_at) order by a.created_at, a.id)
    from public.professor_academic_handoffs a
    join public.lessons l on l.id = a.lesson_id
    left join public.lesson_objectives o on o.id = a.objective_id
    left join public.course_practicals cp on cp.id = a.practical_id
    where a.classroom_id = c.id and a.student_id = actor
  ), '[]'::jsonb));
end $$;

-- ==========================================================================
-- 5. Tutor/Lab consumption: the projection for the learner's own ACTIVE
--    Tutor/Lab content release of that exact delivery handoff.
-- ==========================================================================
create function public.get_professor_academic_handoff_for_release(p_release_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; r public.tutor_lab_content_releases%rowtype; a public.professor_academic_handoffs%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_release_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  perform public.expire_my_tutor_lab_content_releases();
  select * into r from public.tutor_lab_content_releases where id = p_release_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if r.state <> 'ACTIVE' or r.expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_NOT_ACTIVE');
  end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  select * into a from public.professor_academic_handoffs
    where handoff_id = r.handoff_id and student_id = actor;
  if not found then return jsonb_build_object('ok', true, 'available', false); end if;
  -- The release, the delivery handoff and the projection must all agree.
  if a.destination_role <> r.agent_profile or a.enrolment_id <> r.enrolment_id or a.lesson_id <> r.lesson_id
    or a.objective_id is distinct from r.objective_id
    or (a.destination_role = 'LAB_INSTRUCTOR' and a.practical_id is distinct from r.practical_id) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  return jsonb_build_object('ok', true, 'available', true, 'record', jsonb_build_object(
    'policy', a.handoff_policy, 'sourceRole', a.source_role, 'destinationRole', a.destination_role,
    'reasonCode', a.reason_code,
    'scope', case when a.objective_id is not null then 'OBJECTIVE' else 'PRACTICAL' end,
    'summary', a.summary, 'recordedAt', a.created_at));
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'professor_handoff_private'
       or (n.nspname = 'agent_behaviour_private' and p.proname in ('role_behaviour_version','recognised_role_behaviour_version'))
       or (n.nspname = 'public' and p.proname in ('request_professor_academic_handoff',
         'list_my_professor_academic_handoffs','get_professor_academic_handoff_for_release')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.request_professor_academic_handoff(uuid,text,uuid,uuid) to authenticated;
grant execute on function public.list_my_professor_academic_handoffs(uuid) to authenticated;
grant execute on function public.get_professor_academic_handoff_for_release(uuid) to authenticated;

do $$
declare r text; f record;
  public_fns text[] := array['request_professor_academic_handoff','list_my_professor_academic_handoffs',
    'get_professor_academic_handoff_for_release'];
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'professor_handoff_private', 'USAGE,CREATE') then
      raise exception 'Unsafe Professor handoff schema privileges for %', r;
    end if;
    if has_table_privilege(r, 'public.professor_academic_handoffs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r, 'public.professor_academic_handoffs', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe privileges for % on professor_academic_handoffs', r;
    end if;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'professor_handoff_private'
         or (n.nspname = 'agent_behaviour_private' and p.proname in ('role_behaviour_version','recognised_role_behaviour_version'))
         or (n.nspname = 'public' and p.proname = any(public_fns)) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.nspname = 'public') then
        raise exception 'Unsafe Professor handoff function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
