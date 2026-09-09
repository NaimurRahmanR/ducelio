-- Phase 2 checkpoint 15: final review hardening.
-- Closes review findings around instructor self-assignment, support-notification
-- privacy boundaries and expired controlled-assessment lifecycle state.

-- An INSTRUCTOR role by itself is not a relationship to every cohort. If an
-- instructor initiates creation of coursework/controlled assessment content,
-- require a real non-cancelled ClassSession binding for the same cohort/lesson.
-- Academic/platform administrators may still create and explicitly assign an
-- instructor through the governed authoring services.
create function public.guard_instructor_authoring_scope() returns trigger
language plpgsql set search_path='' as $$
declare
  actor uuid;
begin
  actor := public.current_app_user();

  if actor is not null
    and public.has_role('INSTRUCTOR')
    and not public.has_role('ACADEMIC_ADMIN')
    and not public.has_role('PLATFORM_ADMIN') then
    if NEW.instructor_id <> actor
      or not exists(
        select 1
        from public.class_sessions s
        where s.cohort_id = NEW.cohort_id
          and s.programme_version_id = NEW.programme_version_id
          and s.lesson_id = NEW.lesson_id
          and s.instructor_id = actor
          and s.status <> 'CANCELLED'
      ) then
      raise exception 'Instructor authoring requires an assigned class session'
        using errcode='42501';
    end if;
  end if;

  return NEW;
end $$;

revoke all on function public.guard_instructor_authoring_scope() from public;

create trigger instructor_authoring_scope
before insert on public.assignments
for each row execute function public.guard_instructor_authoring_scope();

create trigger instructor_authoring_scope
before insert on public.assessments
for each row execute function public.guard_instructor_authoring_scope();

-- Learner notifications may project academic state to academic operators, but
-- support-only records keep their separate privacy boundary. Never copy a
-- counsellor-authored follow-up title into the cross-boundary notification row.
create function public.minimise_support_notification_content() returns trigger
language plpgsql set search_path='' as $$
begin
  if NEW.kind = 'SUPPORT_FOLLOWUP' then
    NEW.title := 'Learner-support follow-up';
  end if;
  return NEW;
end $$;

revoke all on function public.minimise_support_notification_content() from public;

create trigger minimise_support_notification_content
before insert on public.institutional_notifications
for each row execute function public.minimise_support_notification_content();

-- One-time privacy correction for any pre-production rows generated before this
-- migration. The immutable-provenance guard is temporarily removed only for the
-- controlled migration rewrite and is restored immediately afterwards.
drop trigger guard_notification_history on public.institutional_notifications;
update public.institutional_notifications
set title = 'Learner-support follow-up'
where kind = 'SUPPORT_FOLLOWUP';
create trigger guard_notification_history
before update or delete on public.institutional_notifications
for each row execute function public.guard_notification_history();

-- Academic operators may inspect notification projections only when the source
-- is academic/institutional state they are already authorised to see. Personal
-- study-plan and counsellor-follow-up notifications remain learner-only here.
drop policy read_permitted on public.institutional_notifications;
create policy read_permitted on public.institutional_notifications
for select to authenticated using (
  student_id = public.current_app_user()
  or (
    (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN'))
    and kind in ('MISSED_CLASS','ASSIGNMENT_DEADLINE','MASTERY_REINFORCEMENT')
  )
);

-- Before starting a new controlled attempt, deterministically finalise any stale
-- ACTIVE attempt whose expiry has passed or whose assessment was administratively
-- closed. The attempt remains non-void and therefore consumes an allowed attempt.
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

  perform set_config(
    'app.audit_reason',
    'Expired or closed controlled assessment finalised',
    true
  );
  update public.assessment_attempts t
  set state = 'SUBMITTED',
      submitted_at = least(clock_timestamp(), t.expires_at)
  from public.assessments a
  where t.assessment_id = a.id
    and t.student_id = actor
    and t.state = 'ACTIVE'
    and (
      t.expires_at < clock_timestamp()
      or a.status <> 'PUBLISHED'
    );

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

revoke all on function public.start_assessment_attempt(uuid) from public;
grant execute on function public.start_assessment_attempt(uuid) to authenticated;
