-- Phase 2 checkpoint 14: integration hardening.
-- This migration closes cross-checkpoint integrity and authorization gaps without
-- changing the deterministic Academy OS model.

-- Ordinary enrolment operations belong to academic authority. Registrar-only
-- actors use the dedicated correction workflow introduced in checkpoint 12.
create or replace function public.create_enrolment(
  p_student_id uuid,
  p_cohort_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  result uuid;
  version_id uuid;
  version_status text;
  existing_status text;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded enrolment reason is required';
  end if;

  perform 1 from public.student_profiles where user_id = p_student_id for update;
  if not found then raise exception 'Learner not found'; end if;

  if not exists(
    select 1 from public.role_grants
    where user_id = p_student_id and role = 'STUDENT'
  ) then
    raise exception 'Enrolment requires a learner with STUDENT role';
  end if;

  select c.programme_version_id, v.status
  into version_id, version_status
  from public.cohorts c
  join public.programme_versions v on v.id = c.programme_version_id
  where c.id = p_cohort_id
  for share of c, v;

  if not found then raise exception 'Cohort not found'; end if;
  if version_status <> 'PUBLISHED' then
    raise exception 'Enrolment requires a published programme version';
  end if;

  select id, status into result, existing_status
  from public.enrolments
  where student_id = p_student_id and cohort_id = p_cohort_id
  for update;

  if found then
    if existing_status = 'ACTIVE' then
      return result;
    elsif existing_status = 'PAUSED' then
      raise exception 'Existing enrolment is PAUSED; restore it through the governed status workflow';
    else
      raise exception 'Existing enrolment history cannot be replaced; use a new cohort';
    end if;
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.enrolments(student_id, cohort_id, programme_version_id)
  values(p_student_id, p_cohort_id, version_id)
  returning id into result;

  return result;
end $$;

create or replace function public.change_enrolment_status(
  p_enrolment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  current_status text;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded status-change reason is required';
  end if;
  if p_status not in ('ACTIVE','PAUSED','WITHDRAWN') then
    raise exception 'Unsupported enrolment status transition';
  end if;

  select status into current_status
  from public.enrolments
  where id = p_enrolment_id
  for update;

  if not found then raise exception 'Enrolment not found'; end if;
  if current_status = p_status then return p_enrolment_id; end if;

  if not (
    (current_status = 'ACTIVE' and p_status in ('PAUSED','WITHDRAWN')) or
    (current_status = 'PAUSED' and p_status in ('ACTIVE','WITHDRAWN'))
  ) then
    raise exception 'Invalid enrolment status transition';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.enrolments set status = p_status where id = p_enrolment_id;
  return p_enrolment_id;
end $$;

-- Serialize scheduling for the same instructor as well as the same cohort.
-- All scheduling through this RPC now locks the instructor row before overlap
-- checks, preventing two different cohorts from concurrently double-booking one
-- instructor.
create or replace function public.create_class_session(
  p_cohort_id uuid,
  p_lesson_id uuid,
  p_instructor_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  result uuid;
  version_id uuid;
  version_status text;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded scheduling reason is required';
  end if;
  if p_scheduled_start is null or p_scheduled_end is null
    or p_scheduled_end <= p_scheduled_start then
    raise exception 'Class session end must be after its start';
  end if;

  select c.programme_version_id, v.status
  into version_id, version_status
  from public.cohorts c
  join public.programme_versions v on v.id = c.programme_version_id
  where c.id = p_cohort_id
  for update of c;

  if not found then raise exception 'Cohort not found'; end if;
  if version_status <> 'PUBLISHED' then
    raise exception 'Class sessions require a published programme version';
  end if;

  if not exists(
    select 1 from public.lessons
    where id = p_lesson_id and programme_version_id = version_id
  ) then
    raise exception 'Lesson must belong to the cohort programme version';
  end if;

  perform 1 from public.staff_profiles where user_id = p_instructor_id for update;
  if not found or not exists(
    select 1 from public.role_grants
    where user_id = p_instructor_id and role = 'INSTRUCTOR'
  ) then
    raise exception 'Assigned staff must have INSTRUCTOR role';
  end if;

  if exists(
    select 1 from public.class_sessions
    where cohort_id = p_cohort_id
      and status <> 'CANCELLED'
      and scheduled_start < p_scheduled_end
      and scheduled_end > p_scheduled_start
  ) then
    raise exception 'Cohort already has an overlapping class session';
  end if;

  if exists(
    select 1 from public.class_sessions
    where instructor_id = p_instructor_id
      and status <> 'CANCELLED'
      and scheduled_start < p_scheduled_end
      and scheduled_end > p_scheduled_start
  ) then
    raise exception 'Instructor already has an overlapping class session';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.class_sessions(
    cohort_id, programme_version_id, lesson_id, instructor_id,
    scheduled_start, scheduled_end, created_by
  ) values (
    p_cohort_id, version_id, p_lesson_id, p_instructor_id,
    p_scheduled_start, p_scheduled_end, actor
  ) returning id into result;

  return result;
end $$;

create or replace function public.change_class_session_status(
  p_session_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  current_status text;
  session_end timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded session-status reason is required';
  end if;
  if p_status not in ('COMPLETED','CANCELLED') then
    raise exception 'Unsupported class session status';
  end if;

  select status, scheduled_end into current_status, session_end
  from public.class_sessions
  where id = p_session_id
  for update;

  if not found then raise exception 'Class session not found'; end if;
  if current_status = p_status then return p_session_id; end if;
  if current_status <> 'SCHEDULED' then
    raise exception 'Closed class session history is immutable';
  end if;
  if p_status = 'COMPLETED' and session_end > now() then
    raise exception 'A future class session cannot be completed';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.class_sessions set status = p_status where id = p_session_id;
  return p_session_id;
end $$;

-- Safe learner projection: return only the instructor identity fields needed by
-- the timetable. The browser no longer depends on nested app_users RLS to render
-- another person's name.
create function public.list_my_class_sessions()
returns table(
  id uuid,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text,
  cohort_title text,
  lesson_title text,
  instructor_name text,
  instructor_title text,
  programme_title text,
  programme_version_label text
)
language sql stable security definer set search_path='' as $$
  select
    s.id,
    s.scheduled_start,
    s.scheduled_end,
    s.status,
    c.title,
    l.title,
    u.display_name,
    sp.title,
    coalesce(v.title_snapshot, 'Programme'),
    v.label
  from public.class_sessions s
  join public.enrolments e
    on e.cohort_id = s.cohort_id
   and e.programme_version_id = s.programme_version_id
  join public.cohorts c on c.id = s.cohort_id
  join public.lessons l on l.id = s.lesson_id
  join public.staff_profiles sp on sp.user_id = s.instructor_id
  join public.app_users u on u.id = s.instructor_id
  join public.programme_versions v on v.id = s.programme_version_id
  where public.current_app_user() is not null
    and public.has_role('STUDENT')
    and e.student_id = public.current_app_user()
    and e.status in ('ACTIVE','PAUSED')
  order by s.scheduled_start, s.id
$$;

revoke all on function public.list_my_class_sessions() from public;
grant execute on function public.list_my_class_sessions() to authenticated;

-- Bind response identity to the attempt at the database layer, not only inside
-- the response RPC.
alter table public.assessment_attempts
  add constraint assessment_attempt_response_identity
  unique(id, assessment_id, student_id);

alter table public.assessment_responses
  add constraint assessment_response_attempt_identity
  foreign key(attempt_id, assessment_id, student_id)
  references public.assessment_attempts(id, assessment_id, student_id);

-- Preserve monotonically increasing attempt numbers even when an earlier
-- attempt was voided. Also serialize all attempt starts for one learner so the
-- global one-active-attempt rule does not rely on a late unique-index race.
create or replace function public.start_assessment_attempt(p_assessment_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
  enrolment_record public.enrolments%rowtype;
  existing_id uuid;
  nonvoid_count integer;
  next_attempt integer;
  result_id uuid;
  expiry timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;

  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then raise exception 'Learner profile not found'; end if;

  select * into assessment_record
  from public.assessments
  where id = p_assessment_id
  for share;
  if not found then raise exception 'Assessment not found'; end if;
  if assessment_record.status <> 'PUBLISHED' then raise exception 'Assessment is not available'; end if;
  if now() < assessment_record.opens_at then raise exception 'Assessment has not opened yet'; end if;
  if now() > assessment_record.closes_at then raise exception 'Assessment window has closed'; end if;

  select * into enrolment_record
  from public.enrolments
  where student_id = actor
    and cohort_id = assessment_record.cohort_id
    and programme_version_id = assessment_record.programme_version_id
  for update;
  if not found then raise exception 'Matching learner enrolment not found'; end if;
  if enrolment_record.status <> 'ACTIVE' then
    raise exception 'Only an active enrolment can start a controlled assessment';
  end if;

  select id into existing_id
  from public.assessment_attempts
  where student_id = actor and state = 'ACTIVE'
  for update;
  if found then
    if exists(
      select 1 from public.assessment_attempts
      where id = existing_id and assessment_id = p_assessment_id
    ) then
      return existing_id;
    end if;
    raise exception 'Another controlled assessment attempt is already active';
  end if;

  select
    count(*) filter(where state <> 'VOIDED')::integer,
    coalesce(max(attempt_number), 0) + 1
  into nonvoid_count, next_attempt
  from public.assessment_attempts
  where assessment_id = p_assessment_id
    and enrolment_id = enrolment_record.id;

  if nonvoid_count >= assessment_record.attempts_allowed then
    raise exception 'No assessment attempts remain';
  end if;

  expiry := least(
    assessment_record.closes_at,
    clock_timestamp() + (assessment_record.duration_minutes || ' minutes')::interval
  );

  perform set_config('app.audit_reason', 'Learner started controlled assessment', true);
  insert into public.assessment_attempts(
    assessment_id, enrolment_id, student_id, cohort_id, programme_version_id,
    attempt_number, state, started_at, expires_at
  ) values (
    p_assessment_id, enrolment_record.id, actor, assessment_record.cohort_id,
    assessment_record.programme_version_id, next_attempt, 'ACTIVE',
    clock_timestamp(), expiry
  ) returning id into result_id;

  return result_id;
end $$;

-- Avoid copying full lecture-note bodies into the generic institutional audit
-- table. Resource content remains in its authoritative versioned record.
create function public.audit_learning_resource_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD) - 'body'; end if;
  if TG_OP <> 'DELETE' then following := to_jsonb(NEW) - 'body'; end if;
  target := coalesce(following->>'id', previous->>'id')::uuid;

  insert into public.audit_events(
    actor_id, action, target_type, target_id, reason, before_state, after_state
  ) values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, target,
    coalesce(
      nullif(current_setting('app.audit_reason', true), ''),
      'Governed learning resource workflow'
    ),
    previous, following
  );

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;

revoke all on function public.audit_learning_resource_change() from public;
drop trigger if exists audit_change on public.learning_resources;
create trigger audit_change
after insert or update or delete on public.learning_resources
for each row execute function public.audit_learning_resource_change();
