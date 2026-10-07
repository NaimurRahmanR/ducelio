-- AC-6: Sarah post-session feedback and the admin teaching-quality surface.
-- Additive only; migrations 001-054 are byte-for-byte unchanged. Nothing
-- here touches the AC-5 Sarah execution plane (054): feedback is
-- deterministic, structured institutional data, collected under Sarah
-- Mitchell's learner-facing persona WITHOUT any model or provider call.
--
-- Design (docs/48-agent-behaviour-ac6-sarah-feedback.md):
--
-- 1. Feedback binds to the authoritative public.class_sessions row. The
--    learner, cohort, programme version, lesson and instructor are derived
--    by the database; the browser supplies only the session handle, a
--    request UUID and three ratings.
-- 2. Eligibility (all must hold, re-checked under locks at submission):
--    STUDENT role; the session exists; the learner's OWN enrolment is in
--    the session's cohort and programme version and is ACTIVE, PAUSED or
--    COMPLETED; the session is not CANCELLED; scheduled_end <=
--    clock_timestamp(); the learner's authoritative attendance record for
--    that session and enrolment is exactly PRESENT. A session still
--    SCHEDULED after its end is eligible (admin status lag never blocks).
-- 3. Exactly three integer ratings 1-5 (higher is better): clarity, pace
--    (how well the pace suited the learner) and usefulness. No free text.
-- 4. One immutable row per (learner, session). Same request UUID and same
--    submission replays; same UUID with different values conflicts; a
--    different UUID for an already-rated session is ALREADY_SUBMITTED.
-- 5. Admin teaching quality is aggregate-only (ACADEMIC_ADMIN and
--    PLATFORM_ADMIN; REGISTRAR, INSTRUCTOR, COUNSELLOR and STUDENT are
--    refused). Session averages require at least 3 responses; the filtered
--    summary averages only sessions that individually meet the threshold,
--    so a hidden session cannot be derived by differencing. Cancelled
--    sessions keep their historical feedback but are excluded.
-- 6. Feedback changes no grade, mark, mastery, evidence, progress,
--    attendance, session status, agent configuration, content, instructor
--    assignment or enrolment, and is exposed to no commercial path (AC-7).
-- 7. Audit: feedback id, session id, action and time only. The actor is
--    deliberately NULL and the ratings are not copied, so audit readers
--    cannot link a learner to a response.
--
-- Lock order (submission): learner student_profiles FOR UPDATE, then the
-- enrolment FOR SHARE, then the class session FOR SHARE, then the
-- attendance record FOR SHARE. This extends the existing learner-first
-- order (021/053/054) and matches record_attendance's session-then-
-- attendance order, so neither status changes nor attendance corrections
-- can interleave with an eligibility decision.

create schema session_feedback_private;
revoke all on schema session_feedback_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- 1. Feedback table: content-minimal, immutable.
-- ==========================================================================
create table public.session_teaching_feedback (
  id uuid primary key default gen_random_uuid(),
  class_session_id uuid not null references public.class_sessions(id),
  student_id uuid not null references public.student_profiles(user_id),
  request_id uuid not null,
  policy_version text not null default 'SESSION_FEEDBACK_V1' check(policy_version = 'SESSION_FEEDBACK_V1'),
  clarity_rating integer not null check(clarity_rating between 1 and 5),
  pace_rating integer not null check(pace_rating between 1 and 5),
  usefulness_rating integer not null check(usefulness_rating between 1 and 5),
  submitted_at timestamptz not null default clock_timestamp(),
  unique(student_id, class_session_id),
  unique(student_id, request_id)
);
create index session_teaching_feedback_session on public.session_teaching_feedback(class_session_id);
alter table public.session_teaching_feedback enable row level security;
revoke all on public.session_teaching_feedback from public, anon, authenticated, service_role;

-- Structural backstop for every writer, including the database owner: a
-- row needs an ended, non-cancelled session and a PRESENT attendance record
-- of the same learner. Content and identity are immutable; nothing is
-- deleted. The full application authority (role, enrolment, locks,
-- idempotency) belongs to the public RPC below.
create function session_feedback_private.guard_feedback() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'SESSION_FEEDBACK_IMMUTABLE: session feedback cannot be deleted' using errcode = '55000';
  end if;
  if TG_OP = 'UPDATE' then
    raise exception 'SESSION_FEEDBACK_IMMUTABLE: session feedback cannot be changed' using errcode = '55000';
  end if;
  if not exists(
      select 1 from public.class_sessions s
      join public.attendance_records a on a.session_id = s.id
      where s.id = NEW.class_session_id and s.status <> 'CANCELLED'
        and s.scheduled_end <= clock_timestamp()
        and a.student_id = NEW.student_id and a.status = 'PRESENT') then
    raise exception 'SESSION_FEEDBACK_INELIGIBLE: feedback needs an ended session the learner attended'
      using errcode = '55000';
  end if;
  NEW.policy_version := 'SESSION_FEEDBACK_V1';
  NEW.submitted_at := clock_timestamp();
  return NEW;
end $$;
create trigger guard_session_teaching_feedback
before insert or update or delete on public.session_teaching_feedback
for each row execute function session_feedback_private.guard_feedback();

-- Minimal, respondent-anonymous audit: no actor, no learner, no ratings.
create function session_feedback_private.audit_feedback() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state, occurred_at)
  values (null, 'SESSION_FEEDBACK_SUBMITTED', 'session_teaching_feedback', NEW.id, 'LEARNER_SESSION_FEEDBACK',
    'Learner submitted structured post-session feedback',
    jsonb_build_object('feedback_id', NEW.id, 'class_session_id', NEW.class_session_id,
      'action', 'SESSION_FEEDBACK_SUBMITTED', 'submitted_at', NEW.submitted_at),
    clock_timestamp());
  return NEW;
end $$;
create trigger audit_session_teaching_feedback
after insert on public.session_teaching_feedback
for each row execute function session_feedback_private.audit_feedback();

-- ==========================================================================
-- 2. Learner opportunities: the most recent 10 eligible, unrated sessions.
-- ==========================================================================
create function public.list_my_session_feedback_opportunities() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT')
    or not exists(select 1 from public.student_profiles where user_id = actor) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  return jsonb_build_object('ok', true, 'opportunities', coalesce((
    select jsonb_agg(jsonb_build_object(
      'classSessionId', q.id, 'lessonTitle', left(q.lesson_title, 200),
      'cohortTitle', left(q.cohort_title, 200), 'programmeTitle', left(q.programme_title, 200),
      'instructorName', left(q.instructor_name, 100),
      'scheduledStart', q.scheduled_start, 'scheduledEnd', q.scheduled_end)
      order by q.scheduled_end desc, q.id)
    from (
      select s.id, s.scheduled_start, s.scheduled_end, l.title as lesson_title, c.title as cohort_title,
        coalesce(v.title_snapshot, 'Programme') as programme_title, u.display_name as instructor_name
      from public.class_sessions s
      join public.enrolments e on e.cohort_id = s.cohort_id and e.programme_version_id = s.programme_version_id
      join public.attendance_records a on a.session_id = s.id and a.enrolment_id = e.id
      join public.lessons l on l.id = s.lesson_id
      join public.cohorts c on c.id = s.cohort_id
      join public.programme_versions v on v.id = s.programme_version_id
      join public.app_users u on u.id = s.instructor_id
      where e.student_id = actor and a.student_id = actor
        and e.status in ('ACTIVE','PAUSED','COMPLETED')
        and a.status = 'PRESENT'
        and s.status <> 'CANCELLED'
        and s.scheduled_end <= clock_timestamp()
        and not exists(select 1 from public.session_teaching_feedback f
          where f.student_id = actor and f.class_session_id = s.id)
      order by s.scheduled_end desc, s.id
      limit 10) q), '[]'::jsonb));
end $$;

-- ==========================================================================
-- 3. Submission: the RPC owns every eligibility and ownership check.
-- ==========================================================================
create function public.submit_my_session_feedback(
  p_class_session_id uuid,
  p_request_id uuid,
  p_clarity_rating integer,
  p_pace_rating integer,
  p_usefulness_rating integer
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  prior public.session_teaching_feedback%rowtype;
  s public.class_sessions%rowtype;
  e public.enrolments%rowtype;
  attendance_status text;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if p_class_session_id is null or p_request_id is null
    or p_clarity_rating is null or p_clarity_rating not between 1 and 5
    or p_pace_rating is null or p_pace_rating not between 1 and 5
    or p_usefulness_rating is null or p_usefulness_rating not between 1 and 5 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Learner lock first: one learner's submissions are serialised, so a
  -- racing retry observes the committed row and replays or refuses.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;

  -- Idempotent replay: the exact submission tuple is the fingerprint.
  select * into prior from public.session_teaching_feedback
  where student_id = actor and request_id = p_request_id;
  if found then
    if prior.class_session_id = p_class_session_id and prior.clarity_rating = p_clarity_rating
      and prior.pace_rating = p_pace_rating and prior.usefulness_rating = p_usefulness_rating then
      return jsonb_build_object('ok', true, 'outcome', 'REPLAYED');
    end if;
    return jsonb_build_object('ok', false, 'code', 'REQUEST_CONFLICT');
  end if;
  if exists(select 1 from public.session_teaching_feedback
      where student_id = actor and class_session_id = p_class_session_id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SUBMITTED');
  end if;

  -- Cohort and version are immutable session facts (guard_class_session_
  -- history), so they may be read before the session lock.
  select * into s from public.class_sessions where id = p_class_session_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE'); end if;
  select * into e from public.enrolments
  where student_id = actor and cohort_id = s.cohort_id and programme_version_id = s.programme_version_id
  for share;
  if not found or e.status not in ('ACTIVE','PAUSED','COMPLETED') then
    return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE');
  end if;
  -- FOR SHARE conflicts with change_class_session_status / reschedule FOR
  -- UPDATE: a cancellation either commits first (seen here) or waits.
  select * into s from public.class_sessions where id = p_class_session_id for share;
  if s.status = 'CANCELLED' then return jsonb_build_object('ok', false, 'code', 'SESSION_CANCELLED'); end if;
  if s.scheduled_end > clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_ENDED');
  end if;
  -- FOR SHARE conflicts with record_attendance and registrar corrections.
  select a.status into attendance_status from public.attendance_records a
  where a.session_id = s.id and a.enrolment_id = e.id and a.student_id = actor
  for share;
  if attendance_status is distinct from 'PRESENT' then
    return jsonb_build_object('ok', false, 'code', 'ATTENDANCE_NOT_PRESENT');
  end if;

  begin
    insert into public.session_teaching_feedback(class_session_id, student_id, request_id,
      clarity_rating, pace_rating, usefulness_rating)
    values (s.id, actor, p_request_id, p_clarity_rating, p_pace_rating, p_usefulness_rating);
  exception when unique_violation then
    -- Race-safe backstop; unreachable under the learner lock.
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SUBMITTED');
  end;
  return jsonb_build_object('ok', true, 'outcome', 'RECORDED');
end $$;

-- ==========================================================================
-- 4. Admin teaching quality: deterministic, aggregate-only, bounded.
-- ==========================================================================
create function public.admin_session_teaching_quality(
  p_instructor_id uuid default null,
  p_cohort_id uuid default null,
  p_from timestamptz default null,
  p_until timestamptz default null,
  p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  -- Explicit roles: is_academic_admin() also admits REGISTRAR, whose
  -- correction authority is not teaching-quality authority.
  if public.current_app_user() is null
    or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_offset is null or p_offset not between 0 and 100000
    or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until))
    or (p_from is not null and p_until is not null and p_until <= p_from) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with scope as (
    select s.id, s.scheduled_start, s.scheduled_end, s.status, l.title as lesson_title, c.title as cohort_title,
      u.display_name as instructor_name, coalesce(v.title_snapshot, 'Programme') as programme_title,
      v.label as version_label,
      (select count(*) from public.attendance_records a where a.session_id = s.id and a.status = 'PRESENT') as present_count,
      (select count(*) from public.session_teaching_feedback f where f.class_session_id = s.id) as response_count,
      (select round(avg(f.clarity_rating)::numeric, 2) from public.session_teaching_feedback f where f.class_session_id = s.id) as clarity,
      (select round(avg(f.pace_rating)::numeric, 2) from public.session_teaching_feedback f where f.class_session_id = s.id) as pace,
      (select round(avg(f.usefulness_rating)::numeric, 2) from public.session_teaching_feedback f where f.class_session_id = s.id) as usefulness
    from public.class_sessions s
    join public.lessons l on l.id = s.lesson_id
    join public.cohorts c on c.id = s.cohort_id
    join public.programme_versions v on v.id = s.programme_version_id
    join public.app_users u on u.id = s.instructor_id
    where s.status <> 'CANCELLED' and s.scheduled_end <= clock_timestamp()
      and (p_instructor_id is null or s.instructor_id = p_instructor_id)
      and (p_cohort_id is null or s.cohort_id = p_cohort_id)
      and (p_from is null or s.scheduled_start >= p_from)
      and (p_until is null or s.scheduled_start < p_until)
  ), scored as (
    select f.* from public.session_teaching_feedback f
    where f.class_session_id in (select id from scope where response_count >= 3)
  ), page as (
    select * from scope order by scheduled_start desc, id offset p_offset limit 51
  )
  select jsonb_build_object(
    'minimumResponses', 3,
    'offset', p_offset,
    'hasMore', (select count(*) > 50 from page),
    'summary', jsonb_build_object(
      'sessionCount', (select count(*) from scope),
      'responseCount', (select coalesce(sum(response_count), 0) from scope),
      'scoredSessionCount', (select count(*) from scope where response_count >= 3),
      'scoredResponseCount', (select count(*) from scored),
      'clarityAverage', (select round(avg(clarity_rating)::numeric, 2) from scored),
      'paceAverage', (select round(avg(pace_rating)::numeric, 2) from scored),
      'usefulnessAverage', (select round(avg(usefulness_rating)::numeric, 2) from scored)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'sessionId', q.id, 'lessonTitle', q.lesson_title, 'cohortTitle', q.cohort_title,
        'instructorName', q.instructor_name, 'programmeTitle', q.programme_title, 'versionLabel', q.version_label,
        'scheduledStart', q.scheduled_start, 'scheduledEnd', q.scheduled_end, 'status', q.status,
        'presentCount', q.present_count, 'responseCount', q.response_count,
        'scoresAvailable', q.response_count >= 3,
        'clarityAverage', case when q.response_count >= 3 then q.clarity end,
        'paceAverage', case when q.response_count >= 3 then q.pace end,
        'usefulnessAverage', case when q.response_count >= 3 then q.usefulness end)
        order by q.scheduled_start desc, q.id)
      from (select * from page order by scheduled_start desc, id limit 50) q), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'session_feedback_private'
       or (n.nspname = 'public' and p.proname in ('list_my_session_feedback_opportunities',
         'submit_my_session_feedback','admin_session_teaching_quality')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- Column-level grants inherited from broad defaults must not survive.
do $$ declare cols text; r text; begin
  select string_agg(quote_ident(attname), ',') into cols from pg_attribute
  where attrelid = 'public.session_teaching_feedback'::regclass and attnum > 0 and not attisdropped;
  foreach r in array array['public','anon','authenticated','service_role'] loop
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.session_teaching_feedback from %I',
      cols, cols, cols, cols, r);
  end loop;
end $$;
grant execute on function public.list_my_session_feedback_opportunities() to authenticated;
grant execute on function public.submit_my_session_feedback(uuid,uuid,integer,integer,integer) to authenticated;
grant execute on function public.admin_session_teaching_quality(uuid,uuid,timestamptz,timestamptz,integer) to authenticated;

do $session_feedback_acl$
declare r text; f record;
  reviewed oid[] := array[
    'public.list_my_session_feedback_opportunities()'::regprocedure::oid,
    'public.submit_my_session_feedback(uuid,uuid,integer,integer,integer)'::regprocedure::oid,
    'public.admin_session_teaching_quality(uuid,uuid,timestamptz,timestamptz,integer)'::regprocedure::oid
  ];
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'session_feedback_private', 'USAGE,CREATE') then
      raise exception 'Unsafe session-feedback schema privileges for %', r;
    end if;
    if has_table_privilege(r, 'public.session_teaching_feedback', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r, 'public.session_teaching_feedback', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe session-feedback table privileges for %', r;
    end if;
    if current_setting('server_version_num')::integer >= 170000 then
      if has_table_privilege(r, 'public.session_teaching_feedback', 'MAINTAIN') then
        raise exception 'Unsafe session-feedback table privileges for %', r;
      end if;
    end if;
    for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'session_feedback_private'
        or (n.nspname = 'public' and p.proname in ('list_my_session_feedback_opportunities',
          'submit_my_session_feedback','admin_session_teaching_quality')) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.oid = any(reviewed)) then
        raise exception 'Unsafe session-feedback function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $session_feedback_acl$;
