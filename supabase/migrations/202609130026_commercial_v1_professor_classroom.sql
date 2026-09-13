-- Commercial V1: learner-facing Professor classroom.
-- Additive only; migrations 001-025 are unmodified. This introduces exactly
-- one table of learner-owned, NON-AUTHORITATIVE classroom UX state -- never
-- an institutional academic record. It never marks attendance, writes
-- LearningEvidence, changes ObjectiveMastery or LessonProgress, assigns a
-- grade, completes an assessment or otherwise touches any table those
-- existing institutional services already own. Ownership of a client-
-- supplied class_session_id is independently re-derived here, from the
-- SAME cohort_id + programme_version_id join migration 019's
-- list_my_class_sessions already uses, never trusted from the caller.
--
-- Mirrors migrations 022/024/025's ACL-hardening pattern: service_role has
-- BYPASSRLS in this project's Supabase-like setup, so RLS alone never
-- protects this table from it. It is explicitly revoked from public, anon,
-- authenticated and service_role at creation, and a closing effective-ACL
-- assertion fails this migration's deployment if any of those roles
-- retains unsafe inherited access. Only authenticated ever receives an
-- explicit, reviewed EXECUTE grant, and only on the three RPCs below.

create table public.professor_classroom_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  class_session_id uuid not null references public.class_sessions(id),
  enrolment_id uuid not null references public.enrolments(id),
  programme_version_id uuid not null references public.programme_versions(id),
  lesson_id uuid not null references public.lessons(id),
  mode text not null check(mode in ('LIVE','CATCH_UP')),
  first_opened_at timestamptz not null,
  last_opened_at timestamptz not null,
  unique(student_id, class_session_id),
  check(last_opened_at >= first_opened_at)
);
create index professor_classroom_sessions_student
  on public.professor_classroom_sessions(student_id, last_opened_at desc);
alter table public.professor_classroom_sessions enable row level security;
revoke all on public.professor_classroom_sessions from public, anon, authenticated, service_role;

create schema professor_classroom_private;
revoke all on schema professor_classroom_private from public, anon, authenticated, service_role;

create function professor_classroom_private.guard_classroom_session() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Classroom session history cannot be deleted';
  end if;
  if NEW.id <> OLD.id
    or NEW.student_id <> OLD.student_id
    or NEW.class_session_id <> OLD.class_session_id
    or NEW.enrolment_id <> OLD.enrolment_id
    or NEW.programme_version_id <> OLD.programme_version_id
    or NEW.lesson_id <> OLD.lesson_id
    or NEW.first_opened_at <> OLD.first_opened_at then
    raise exception 'Classroom session identity is immutable';
  end if;
  return NEW;
end $$;
revoke all on function professor_classroom_private.guard_classroom_session() from public, anon, authenticated, service_role;
create trigger guard_classroom_session_history
before update or delete on public.professor_classroom_sessions
for each row execute function professor_classroom_private.guard_classroom_session();

-- Correction pass (independent review): idempotency reservations, keyed by
-- (classroom_id, idempotency_key) with a PRIMARY KEY, not "compare against
-- the most recently seen key" (which a replayed key from BEFORE the most
-- recent one could defeat -- K1, then K2, then a replayed K1 would
-- incorrectly be admitted again, since only K2 was ever remembered). Every
-- key this learner has ever spent for this classroom is now durably and
-- permanently reserved, so a stale/replayed key can never be re-admitted no
-- matter how many other interactions happened in between. Metadata only:
-- no learner prose, no provider response, no prompt, no course/assessment
-- content, no token payload -- just the fact that this exact key was
-- reserved for this exact classroom, once. Never treated as an institutional
-- record or audit/evidence store (see the ACL/immutability posture below,
-- identical to professor_classroom_sessions itself). A single `insert ...
-- on conflict (classroom_id, idempotency_key) do nothing` is what makes the
-- reservation atomic: PostgreSQL's own unique-index conflict resolution
-- guarantees that of any two rows racing to insert the same key, exactly
-- one insert succeeds and the other observes zero affected rows -- there is
-- no read-then-write window for two concurrent callers to both "win". The
-- PGlite test harness used in this repository is single-connection and
-- cannot itself exercise genuine cross-connection concurrency; this
-- atomicity guarantee is a property of PostgreSQL's MVCC/unique-index
-- implementation, proven here only by the sequential K1/K2/K1-replay
-- ordering tests, not by true concurrent load. True independent hosted
-- PostgreSQL concurrency acceptance remains a separate, outstanding item
-- (see docs/20-professor-classroom.md), exactly as already documented for
-- migration 025's own concurrency posture.
create table public.professor_classroom_interaction_reservations (
  classroom_id uuid not null references public.professor_classroom_sessions(id),
  idempotency_key text not null check(length(idempotency_key) between 1 and 100),
  reserved_at timestamptz not null,
  primary key (classroom_id, idempotency_key)
);
alter table public.professor_classroom_interaction_reservations enable row level security;
revoke all on public.professor_classroom_interaction_reservations from public, anon, authenticated, service_role;

create function professor_classroom_private.guard_classroom_interaction_reservation() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Classroom interaction reservations are immutable: they cannot be updated or deleted';
end $$;
revoke all on function professor_classroom_private.guard_classroom_interaction_reservation() from public, anon, authenticated, service_role;
create trigger guard_classroom_interaction_reservation_immutable
before update or delete on public.professor_classroom_interaction_reservations
for each row execute function professor_classroom_private.guard_classroom_interaction_reservation();

-- Resolves and durably records that this learner opened (or resumed) a
-- classroom for a specific class session, independently re-verifying every
-- ownership relationship from the class_session_id alone -- the same
-- cohort_id + programme_version_id join migration 019's
-- list_my_class_sessions already relies on, so a client-supplied id can
-- never select another student's enrolment, another cohort, another
-- programme version, another user's classroom, or a cancelled/ineligible
-- session. Mode (LIVE/CATCH_UP) is computed from clock_timestamp() against
-- the class_session's own scheduled_start/scheduled_end -- server/database
-- time only, never a caller-supplied instant -- and is recomputed on every
-- call, so a session that was LIVE on a previous visit correctly becomes
-- CATCH_UP once its window has passed. A future (not-yet-started) session
-- is refused outright: no early classroom entry.
create function public.open_professor_classroom(p_class_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  session_record public.class_sessions%rowtype;
  enrolment_record public.enrolments%rowtype;
  lesson_record public.lessons%rowtype;
  module_record public.modules%rowtype;
  cohort_record public.cohorts%rowtype;
  programme_record public.programme_versions%rowtype;
  computed_mode text;
  stamp timestamptz;
  row_record public.professor_classroom_sessions%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;
  if p_class_session_id is null then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  select * into session_record from public.class_sessions where id=p_class_session_id;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;

  select * into enrolment_record from public.enrolments
    where student_id=actor
      and cohort_id=session_record.cohort_id
      and programme_version_id=session_record.programme_version_id
      and status in ('ACTIVE','PAUSED')
    order by enrolled_at desc
    limit 1;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;

  if session_record.status = 'CANCELLED' then
    return jsonb_build_object('ok',false,'code','CANCELLED');
  end if;

  stamp := clock_timestamp();
  if stamp < session_record.scheduled_start then
    return jsonb_build_object('ok',false,'code','NOT_YET_STARTED');
  end if;
  computed_mode := case when stamp <= session_record.scheduled_end then 'LIVE' else 'CATCH_UP' end;

  select * into lesson_record from public.lessons where id=session_record.lesson_id;
  select * into module_record from public.modules where id=lesson_record.module_id;
  select * into cohort_record from public.cohorts where id=session_record.cohort_id;
  select * into programme_record from public.programme_versions where id=session_record.programme_version_id;

  insert into public.professor_classroom_sessions(
    student_id,class_session_id,enrolment_id,programme_version_id,lesson_id,mode,
    first_opened_at,last_opened_at
  ) values (
    actor,p_class_session_id,enrolment_record.id,session_record.programme_version_id,session_record.lesson_id,
    computed_mode,stamp,stamp
  )
  on conflict (student_id,class_session_id) do update
  set mode=excluded.mode, last_opened_at=stamp
  returning * into row_record;

  return jsonb_build_object('ok',true,'classroom',jsonb_build_object(
    'classroomId',row_record.id,
    'classSessionId',row_record.class_session_id,
    'enrolmentId',row_record.enrolment_id,
    'programmeVersionId',row_record.programme_version_id,
    'lessonId',row_record.lesson_id,
    'mode',row_record.mode,
    'firstOpenedAt',row_record.first_opened_at,
    'lastOpenedAt',row_record.last_opened_at,
    'scheduledStart',session_record.scheduled_start,
    'scheduledEnd',session_record.scheduled_end,
    'lessonTitle',lesson_record.title,
    'moduleTitle',module_record.title,
    'cohortTitle',cohort_record.title,
    'programmeTitle',coalesce(programme_record.title_snapshot,'Programme'),
    'programmeVersionLabel',programme_record.label
  ));
end $$;
revoke all on function public.open_professor_classroom(uuid) from public, anon, authenticated, service_role;
grant execute on function public.open_professor_classroom(uuid) to authenticated;

-- One durable, per-classroom idempotency reservation per learner action,
-- never a transcript and never academic evidence. A repeated key (e.g. a
-- replayed/duplicated form submission, or the same key replayed after OTHER
-- interactions happened in between) is reported as a duplicate and the
-- caller must not attempt a second provider call for it; a genuinely new
-- key reserves the attempt and the caller proceeds. Requires an
-- already-opened classroom row (open_professor_classroom must run first).
-- Ownership: the classroom_id used for the reservation is resolved from
-- this caller's OWN (student_id, class_session_id) row only, so a learner
-- can never reserve -- or observe the reservation state of -- another
-- learner's classroom. Reservation itself is a single atomic
-- `insert ... on conflict do nothing`, so two callers racing on the exact
-- same key can never both be told to proceed (see the reservation table's
-- own comment above for the concurrency argument).
create function public.record_professor_classroom_interaction(
  p_class_session_id uuid, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  row_record public.professor_classroom_sessions%rowtype;
  stamp timestamptz;
  inserted_count int;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;
  if p_class_session_id is null or p_idempotency_key is null
    or length(p_idempotency_key) not between 1 and 100 then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  select * into row_record from public.professor_classroom_sessions
    where student_id=actor and class_session_id=p_class_session_id;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;

  stamp := clock_timestamp();
  insert into public.professor_classroom_interaction_reservations(
    classroom_id, idempotency_key, reserved_at
  ) values (row_record.id, p_idempotency_key, stamp)
  on conflict (classroom_id, idempotency_key) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 0 then
    return jsonb_build_object('ok',true,'duplicate',true);
  end if;

  return jsonb_build_object('ok',true,'duplicate',false);
end $$;
revoke all on function public.record_professor_classroom_interaction(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.record_professor_classroom_interaction(uuid,text) to authenticated;

-- Minimal bounded read for the Classes list CTA (Start vs Resume class /
-- Start vs Resume catch-up): only the set of class_session_id values this
-- learner has already opened a classroom for, never any other column.
create function public.list_my_professor_classroom_session_ids() returns uuid[]
language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(class_session_id), array[]::uuid[])
  from public.professor_classroom_sessions
  where student_id = public.current_app_user()
$$;
revoke all on function public.list_my_professor_classroom_session_ids() from public, anon, authenticated, service_role;
grant execute on function public.list_my_professor_classroom_session_ids() to authenticated;

-- Table REVOKE alone does not clear pre-existing column-level privileges
-- from Supabase-like broad defaults. Applies to both tables this migration
-- creates.
do $$ declare columns text; begin
  select string_agg(quote_ident(attname),', ' order by attnum) into columns
    from pg_attribute where attrelid='public.professor_classroom_sessions'::regclass
      and attnum>0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.professor_classroom_sessions from public, anon, authenticated, service_role',
    columns,columns,columns,columns);
  select string_agg(quote_ident(attname),', ' order by attnum) into columns
    from pg_attribute where attrelid='public.professor_classroom_interaction_reservations'::regclass
      and attnum>0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.professor_classroom_interaction_reservations from public, anon, authenticated, service_role',
    columns,columns,columns,columns);
end $$;

-- Effective-ACL acceptance: fail migration rather than silently inherit
-- unsafe rights from an unexpected hosted role membership. Never revoke the
-- authenticated learner's own grant on the three reviewed public RPCs.
do $$ declare r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(r,'public.professor_classroom_sessions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r,'public.professor_classroom_sessions','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe effective professor-classroom table privileges for %', r;
    end if;
    if has_table_privilege(r,'public.professor_classroom_interaction_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r,'public.professor_classroom_interaction_reservations','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe effective professor-classroom-reservation table privileges for %', r;
    end if;
    if has_schema_privilege(r,'professor_classroom_private','USAGE,CREATE') then
      raise exception 'Unsafe effective professor-classroom schema privileges for %', r;
    end if;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='professor_classroom_private'
         or (n.nspname='public' and p.proname in (
           'open_professor_classroom','record_professor_classroom_interaction',
           'list_my_professor_classroom_session_ids'
         )) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname in (
          'open_professor_classroom','record_professor_classroom_interaction',
          'list_my_professor_classroom_session_ids'
        )) then
        raise exception 'Unsafe effective professor-classroom function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
