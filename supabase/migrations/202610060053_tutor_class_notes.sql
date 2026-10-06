-- AC-4: supplementary, versioned Tutor class notes. Additive only;
-- migrations 001-052 are byte-for-byte unchanged, and no existing attested
-- message format (022/025/028/031/032/040/051) is altered.
--
-- Design (docs/46-agent-behaviour-ac4.md):
--
-- 1. A Tutor class note is a Tutor support answer the learner chose, BEFORE
--    sending the request, to keep as a supplementary note. Tutor/Lab output
--    is otherwise never persisted (migration 028), so the note body can only
--    come from the trusted server's own copy of the provider output, after
--    the governed execution's FINALIZE has been confirmed SUCCEEDED. No
--    second provider call is made and no browser-supplied text is accepted:
--    the controller records the note through a NEW attested RPC with its own
--    protocol tag (DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1, same controller
--    key store as migration 022 via agent_behaviour_private.verify_mac),
--    whose MAC covers the SHA-256 of the exact body.
-- 2. Authority is the narrowest real chain that exists: learner -> TUTOR
--    delivery handoff (023/028/043) -> COMPLETED Tutor content release ->
--    SUCCEEDED Tutor provider execution -> AC-2 execution provenance. There
--    is no authoritative Tutor class session, and none is invented. The
--    database derives every identity from the execution id and verifies the
--    whole chain, including the provenance against the programme version's
--    FROZEN AC-2 behaviour binding, before anything is written.
-- 3. Notes are structurally separate from curriculum: they never touch
--    programme_versions, modules, lessons, lesson_objectives,
--    course_practicals, course packages or learning_resources (no
--    CLASS_NOTE kind is added there), and they never replace published
--    material.
-- 4. Versioning: one immutable series per Tutor delivery handoff (the
--    support topic), and append-only revisions. Each revision is one
--    complete Tutor answer; the highest revision number is the current one.
--    The database allocates revision numbers under the series row lock;
--    unique(series_id, revision_number) and unique(source execution) are
--    the backstops. At most 10 revisions per series, at most 8,000
--    characters per body. Nothing can be updated or deleted.
-- 5. The controlled-assessment firewall is re-checked at the write boundary
--    (no body is persisted while it is closed, and no denial receipt is
--    written) and on every learner read.
-- 6. Notes are learner-only: the learner read is owner-only and returns no
--    execution, provenance, handoff or series identifier. There is no admin,
--    instructor, Counsellor, Sarah, Lab or Professor read, and no delete RPC.
-- 7. Notes are NOT LearningEvidence, mastery, attendance, lesson progress,
--    a grade, an assessment result or completion, and write none of them.

create schema tutor_class_note_private;
revoke all on schema tutor_class_note_private from public, anon, authenticated, service_role;

-- Reviewed bounds (mirror of src/domain/tutor-class-notes.ts).
create function tutor_class_note_private.body_max() returns integer
language sql immutable set search_path='' as $$ select 8000 $$;
create function tutor_class_note_private.revisions_max() returns integer
language sql immutable set search_path='' as $$ select 10 $$;
create function tutor_class_note_private.page_size() returns integer
language sql immutable set search_path='' as $$ select 5 $$;

-- ==========================================================================
-- 1. Series: one per Tutor delivery handoff (the learner's support topic).
-- ==========================================================================
create table public.tutor_class_note_series (
  id uuid primary key default gen_random_uuid(),
  note_policy text not null default 'TUTOR_CLASS_NOTE_V1' check(note_policy = 'TUTOR_CLASS_NOTE_V1'),
  author_role text not null default 'TUTOR' check(author_role = 'TUTOR'),
  handoff_id uuid not null unique references public.delivery_handoffs(id),
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.enrolments(id),
  programme_version_id uuid not null references public.programme_versions(id),
  lesson_id uuid not null,
  objective_id uuid references public.lesson_objectives(id),
  reason_code text not null check(reason_code in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE')),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(lesson_id, programme_version_id) references public.lessons(id, programme_version_id),
  check(reason_code <> 'OBJECTIVE_REINFORCEMENT' or objective_id is not null)
);
create index tutor_class_note_series_enrolment on public.tutor_class_note_series(enrolment_id, created_at desc, id desc);
alter table public.tutor_class_note_series enable row level security;
revoke all on public.tutor_class_note_series from public, anon, authenticated, service_role;

-- ==========================================================================
-- 2. Revisions: append-only, immutable, one per SUCCEEDED Tutor execution.
-- ==========================================================================
create table public.tutor_class_note_revisions (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.tutor_class_note_series(id),
  student_id uuid not null references public.student_profiles(user_id),
  author_role text not null default 'TUTOR' check(author_role = 'TUTOR'),
  revision_number integer not null check(revision_number between 1 and 10),
  source_tutor_execution_id uuid not null unique references public.tutor_lab_provider_executions(id),
  source_provenance_id uuid not null unique references public.academic_agent_execution_provenance(id),
  -- Only the learner-visible answer text: no prompt, learner message,
  -- reasoning, provider payload or model metadata.
  body text not null check(length(body) between 1 and 8000 and body ~ '\S'),
  -- Database-computed (guard trigger); never caller-supplied.
  body_sha256 text not null check(body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(series_id, revision_number)
);
alter table public.tutor_class_note_revisions enable row level security;
revoke all on public.tutor_class_note_revisions from public, anon, authenticated, service_role;

-- Series rows are immutable and are only ever created for the learner's own
-- TUTOR delivery handoff, with identities that agree with that handoff and
-- its enrolment. This binds every writer, including the database owner.
create function tutor_class_note_private.guard_series() returns trigger
language plpgsql set search_path='' as $$
declare h public.delivery_handoffs%rowtype; e public.enrolments%rowtype;
begin
  if TG_OP <> 'INSERT' then
    raise exception 'TUTOR_CLASS_NOTE_IMMUTABLE: a Tutor class note cannot be updated or deleted'
      using errcode = '55000';
  end if;
  select * into h from public.delivery_handoffs where id = NEW.handoff_id;
  select * into e from public.enrolments where id = NEW.enrolment_id;
  if h.id is null or e.id is null
    or h.destination_profile <> 'TUTOR' or h.requested_by <> NEW.student_id
    or h.enrolment_id <> NEW.enrolment_id or e.student_id <> NEW.student_id
    or e.programme_version_id <> NEW.programme_version_id
    or h.lesson_id <> NEW.lesson_id or h.objective_id is distinct from NEW.objective_id
    or h.reason_code <> NEW.reason_code then
    raise exception 'TUTOR_CLASS_NOTE_SCOPE_INVALID: a note series must match its Tutor handoff'
      using errcode = '55000';
  end if;
  NEW.note_policy := 'TUTOR_CLASS_NOTE_V1';
  NEW.author_role := 'TUTOR';
  NEW.created_at := clock_timestamp();
  return NEW;
end $$;
create trigger guard_tutor_class_note_series
before insert or update or delete on public.tutor_class_note_series
for each row execute function tutor_class_note_private.guard_series();

-- Revisions are append-only. This trigger is the STRUCTURAL and
-- immutability backstop for every table writer: the database (not the
-- caller) allocates the revision number under the series row lock and
-- computes the body digest, and the source must be a SUCCEEDED Tutor
-- execution of the series' learner whose release is a COMPLETED TUTOR
-- release of exactly the series' handoff, enrolment, lesson and objective,
-- with that execution's own provenance row. It does NOT re-verify the
-- provenance against the frozen behaviour binding, the ACTIVE enrolment or
-- the firewall: that full application authority belongs to the attested
-- public RPC record_tutor_class_note, the only supported write path.
create function tutor_class_note_private.guard_revision() returns trigger
language plpgsql set search_path='' as $$
declare s public.tutor_class_note_series%rowtype; x public.tutor_lab_provider_executions%rowtype;
  latest integer;
begin
  if TG_OP <> 'INSERT' then
    raise exception 'TUTOR_CLASS_NOTE_IMMUTABLE: a Tutor class note cannot be updated or deleted'
      using errcode = '55000';
  end if;
  select * into s from public.tutor_class_note_series where id = NEW.series_id for update;
  select * into x from public.tutor_lab_provider_executions where id = NEW.source_tutor_execution_id;
  if s.id is null or x.id is null or NEW.student_id <> s.student_id
    or x.student_id <> s.student_id or x.agent_profile <> 'TUTOR' or x.state <> 'SUCCEEDED'
    or not exists(select 1 from public.tutor_lab_content_releases r
      where r.id = x.release_id and r.agent_profile = 'TUTOR' and r.state = 'COMPLETED'
        and r.student_id = s.student_id and r.handoff_id = s.handoff_id
        and r.enrolment_id = s.enrolment_id and r.lesson_id = s.lesson_id
        and r.objective_id is not distinct from s.objective_id)
    or not exists(select 1 from public.academic_agent_execution_provenance p
      where p.id = NEW.source_provenance_id and p.tutor_lab_execution_id = x.id and p.role = 'TUTOR') then
    raise exception 'TUTOR_CLASS_NOTE_SOURCE_INVALID: a note revision needs a SUCCEEDED Tutor execution of this series'
      using errcode = '55000';
  end if;
  select coalesce(max(revision_number), 0) into latest
    from public.tutor_class_note_revisions where series_id = s.id;
  if latest >= tutor_class_note_private.revisions_max() then
    raise exception 'TUTOR_CLASS_NOTE_REVISION_LIMIT: this note has reached its revision limit'
      using errcode = '55000';
  end if;
  NEW.revision_number := latest + 1;
  NEW.author_role := 'TUTOR';
  NEW.body_sha256 := encode(extensions.digest(convert_to(NEW.body, 'UTF8'), 'sha256'), 'hex');
  NEW.created_at := clock_timestamp();
  return NEW;
end $$;
create trigger guard_tutor_class_note_revision
before insert or update or delete on public.tutor_class_note_revisions
for each row execute function tutor_class_note_private.guard_revision();

-- Audit identifiers, role and revision only: never the body, its digest,
-- the learner message or any provider output.
create function tutor_class_note_private.audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_TABLE_NAME = 'tutor_class_note_series' then
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (NEW.student_id, 'TUTOR_CLASS_NOTE_SERIES_CREATED', TG_TABLE_NAME, NEW.id, 'ATTESTED_EXECUTION_CONTROLLER',
      'Learner-kept supplementary Tutor note',
      jsonb_build_object('series_id', NEW.id, 'note_policy', NEW.note_policy, 'author_role', NEW.author_role,
        'handoff_id', NEW.handoff_id, 'enrolment_id', NEW.enrolment_id, 'lesson_id', NEW.lesson_id,
        'objective_id', NEW.objective_id, 'reason_code', NEW.reason_code, 'created_at', NEW.created_at));
  else
    insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
    values (NEW.student_id, 'TUTOR_CLASS_NOTE_REVISION_CREATED', TG_TABLE_NAME, NEW.id, 'ATTESTED_EXECUTION_CONTROLLER',
      'Learner-kept supplementary Tutor note',
      jsonb_build_object('revision_id', NEW.id, 'series_id', NEW.series_id, 'author_role', NEW.author_role,
        'revision_number', NEW.revision_number, 'source_tutor_execution_id', NEW.source_tutor_execution_id,
        'created_at', NEW.created_at));
  end if;
  return NEW;
end $$;
create trigger audit_tutor_class_note_series
after insert on public.tutor_class_note_series
for each row execute function tutor_class_note_private.audit();
create trigger audit_tutor_class_note_revision
after insert on public.tutor_class_note_revisions
for each row execute function tutor_class_note_private.audit();

-- ==========================================================================
-- 3. Trusted creation: the controller records the exact learner-visible
--    output of one SUCCEEDED Tutor execution the learner asked to keep.
-- ==========================================================================
--   DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1
--   TUTOR
--   key_id / actor / execution_id
--   sha256_hex(body)
--   issued_at_epoch_seconds / expires_at_epoch_seconds
create function public.record_tutor_class_note(
  p_key_id uuid, p_execution_id uuid, p_body text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; x public.tutor_lab_provider_executions%rowtype; r public.tutor_lab_content_releases%rowtype;
  h public.delivery_handoffs%rowtype; e public.enrolments%rowtype; p public.academic_agent_execution_provenance%rowtype;
  s public.tutor_class_note_series%rowtype; prior public.tutor_class_note_revisions%rowtype;
  eff jsonb; digest_hex text; latest integer; allocated integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_key_id is null or p_execution_id is null or p_body is null
    or length(p_body) not between 1 and tutor_class_note_private.body_max() or p_body !~ '\S' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  digest_hex := encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex');
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1', 'TUTOR', p_key_id::text, actor::text,
      p_execution_id::text, digest_hex, p_issued_at::text, p_expires_at::text),
      p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  -- Firewall locking contract (migration 021): lock the learner profile
  -- before relying on academic_content_release_explain_allowed(). This is
  -- the same row start_assessment_attempt locks first, so a note write and
  -- an assessment start for this learner serialise. Lock order matches the
  -- existing flows: learner profile first, then enrolment (below).
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;

  -- Source: the learner's own execution, of the TUTOR role only, SUCCEEDED.
  select * into x from public.tutor_lab_provider_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.agent_profile <> 'TUTOR' or x.state <> 'SUCCEEDED' or x.reason_code is distinct from 'PROVIDER_COMPLETE' then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_NOT_ELIGIBLE');
  end if;
  -- Its governed content release closed COMPLETED (the release-close
  -- firewall recheck passed), for the learner's own TUTOR handoff, and the
  -- release, handoff, enrolment, lesson, objective and version all agree.
  select * into r from public.tutor_lab_content_releases where id = x.release_id and student_id = actor;
  if not found or r.agent_profile <> 'TUTOR' or r.state <> 'COMPLETED' then
    return jsonb_build_object('ok', false, 'code', 'SOURCE_NOT_ELIGIBLE');
  end if;
  select * into h from public.delivery_handoffs where id = r.handoff_id;
  -- Locked (after the learner profile, as start_assessment_attempt does), so
  -- a concurrent enrolment status transition cannot race the ACTIVE check.
  select * into e from public.enrolments where id = r.enrolment_id and student_id = actor for update;
  if h.id is null or e.id is null or h.requested_by <> actor or h.destination_profile <> 'TUTOR'
    or h.reason_code not in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE')
    or h.enrolment_id <> r.enrolment_id or h.lesson_id <> r.lesson_id
    or h.objective_id is distinct from r.objective_id
    or not exists(select 1 from public.lessons l where l.id = r.lesson_id and l.programme_version_id = e.programme_version_id)
    or (r.objective_id is not null and not exists(select 1 from public.lesson_objectives o
      where o.id = r.objective_id and o.lesson_id = r.lesson_id and o.programme_version_id = e.programme_version_id)) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_NOT_ACTIVE'); end if;

  -- AC-2 provenance (database-derived at AUTHORIZE) must exist and agree
  -- with the execution, the enrolment, and the programme version's FROZEN
  -- behaviour binding, fingerprint, runtime profile and Level-1 baseline.
  select * into p from public.academic_agent_execution_provenance where tutor_lab_execution_id = x.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'PROVENANCE_INVALID'); end if;
  eff := agent_behaviour_private.effective_behaviour(e.programme_version_id, 'TUTOR');
  if p.execution_kind <> 'TUTOR_LAB_PROVIDER_V1' or p.role <> 'TUTOR' or p.student_id <> actor
    or p.enrolment_id <> e.id or p.programme_version_id <> e.programme_version_id or p.classroom_id is not null
    or not coalesce((eff->>'ok')::boolean, false) or eff->>'state' is distinct from 'BOUND'
    or p.behaviour_version is distinct from eff->>'behaviourVersion'
    or p.behaviour_config_source is distinct from eff->>'source'
    or p.behaviour_config_version is distinct from eff->>'configVersion'
    or p.behaviour_config_id is distinct from (eff->>'configId')::uuid
    or p.behaviour_fingerprint is distinct from agent_behaviour_private.behaviour_fingerprint(e.programme_version_id)
    or p.runtime_profile_ref is distinct from agent_behaviour_private.runtime_profile_ref(e.programme_version_id, 'TUTOR')
    or p.institutional_baseline_version is distinct from agent_behaviour_private.institutional_baseline_version() then
    return jsonb_build_object('ok', false, 'code', 'PROVENANCE_MISMATCH');
  end if;

  -- Final authoritative firewall recheck at the write boundary. Nothing is
  -- written while explanation is blocked: no body and no denial receipt.
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;

  -- The series row lock serialises every write to one note.
  insert into public.tutor_class_note_series(
    handoff_id, student_id, enrolment_id, programme_version_id, lesson_id, objective_id, reason_code
  ) values (h.id, actor, e.id, e.programme_version_id, r.lesson_id, r.objective_id, h.reason_code)
  on conflict (handoff_id) do nothing;
  select * into s from public.tutor_class_note_series where handoff_id = h.id for update;
  if s.student_id <> actor or s.enrolment_id <> e.id or s.programme_version_id <> e.programme_version_id
    or s.lesson_id <> r.lesson_id or s.objective_id is distinct from r.objective_id then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;

  -- Idempotency: one revision per source execution. A replay of the same
  -- body returns the existing revision; a different body is refused.
  select * into prior from public.tutor_class_note_revisions where source_tutor_execution_id = x.id;
  if found then
    if prior.series_id <> s.id or prior.body_sha256 <> digest_hex then
      return jsonb_build_object('ok', false, 'code', 'SOURCE_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'revisionNumber', prior.revision_number);
  end if;
  select coalesce(max(revision_number), 0) into latest from public.tutor_class_note_revisions where series_id = s.id;
  if latest >= tutor_class_note_private.revisions_max() then
    return jsonb_build_object('ok', false, 'code', 'REVISION_LIMIT_REACHED');
  end if;
  -- revision_number is allocated by the guard trigger; the value supplied
  -- here is a placeholder it replaces.
  insert into public.tutor_class_note_revisions(
    series_id, student_id, revision_number, source_tutor_execution_id, source_provenance_id, body, body_sha256
  ) values (s.id, actor, 1, x.id, p.id, p_body, repeat('0', 64))
  returning revision_number into allocated;
  return jsonb_build_object('ok', true, 'duplicate', false, 'revisionNumber', allocated);
end $$;

-- ==========================================================================
-- 4. Learner-safe read: the owning learner's notes for one enrolment, in
--    pages of 5 notes (newest first), each with its bounded revision
--    history. No execution, provenance, handoff, series or audit identifier
--    is returned. Gated by the controlled-assessment firewall: a note is
--    explanatory content.
-- ==========================================================================
-- VOLATILE (not STABLE): it takes the learner-profile row lock.
create function public.list_my_tutor_class_notes(p_enrolment_id uuid, p_page integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; e public.enrolments%rowtype; size integer := tutor_class_note_private.page_size();
  total integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_enrolment_id is null or p_page is null or p_page not between 0 and 49 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Firewall locking contract (migration 021): the learner-profile lock is
  -- the short serialisation boundary with start_assessment_attempt, taken
  -- before the firewall check and before any note text is returned.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into e from public.enrolments where id = p_enrolment_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  select count(*) into total from public.tutor_class_note_series where enrolment_id = e.id and student_id = actor;
  return jsonb_build_object('ok', true, 'page', p_page, 'pageSize', size,
    'hasMore', total > (p_page + 1) * size,
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lessonTitle', l.title,
        'objectiveDescription', o.description,
        'reasonCode', s.reason_code,
        'createdAt', s.created_at,
        'revisionCount', (select count(*) from public.tutor_class_note_revisions v where v.series_id = s.id),
        'revisions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'revisionNumber', v.revision_number,
            'current', v.revision_number = (select max(w.revision_number) from public.tutor_class_note_revisions w where w.series_id = s.id),
            'body', v.body,
            'createdAt', v.created_at) order by v.revision_number desc)
          from public.tutor_class_note_revisions v where v.series_id = s.id), '[]'::jsonb)
      ) order by s.created_at desc, s.id desc)
      from (select * from public.tutor_class_note_series
            where enrolment_id = e.id and student_id = actor
            order by created_at desc, id desc offset p_page * size limit size) s
      join public.lessons l on l.id = s.lesson_id
      left join public.lesson_objectives o on o.id = s.objective_id
    ), '[]'::jsonb));
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tutor_class_note_private'
       or (n.nspname = 'public' and p.proname in ('record_tutor_class_note','list_my_tutor_class_notes')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.record_tutor_class_note(uuid,uuid,text,bigint,bigint,text) to authenticated;
grant execute on function public.list_my_tutor_class_notes(uuid,integer) to authenticated;

do $$
declare r text; f record; t text;
  public_fns text[] := array['record_tutor_class_note','list_my_tutor_class_notes'];
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'tutor_class_note_private', 'USAGE,CREATE') then
      raise exception 'Unsafe Tutor class note schema privileges for %', r;
    end if;
    foreach t in array array['public.tutor_class_note_series','public.tutor_class_note_revisions'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe privileges for % on %', r, t;
      end if;
    end loop;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'tutor_class_note_private'
         or (n.nspname = 'public' and p.proname = any(public_fns)) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.nspname = 'public') then
        raise exception 'Unsafe Tutor class note function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
