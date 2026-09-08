-- Phase 2 checkpoint 4: persisted, governed class sessions.
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null,
  programme_version_id uuid not null references public.programme_versions(id),
  lesson_id uuid not null,
  instructor_id uuid not null references public.staff_profiles(user_id),
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  status text not null default 'SCHEDULED' check(status in ('SCHEDULED','COMPLETED','CANCELLED')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  check(scheduled_end > scheduled_start),
  foreign key(cohort_id,programme_version_id)
    references public.cohorts(id,programme_version_id),
  foreign key(lesson_id,programme_version_id)
    references public.lessons(id,programme_version_id)
);

create index class_sessions_cohort_time
  on public.class_sessions(cohort_id,scheduled_start);
create index class_sessions_instructor_time
  on public.class_sessions(instructor_id,scheduled_start);

create function public.guard_class_session_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Class session history is immutable; cancel the session instead';
  end if;

  if NEW.cohort_id <> OLD.cohort_id
    or NEW.programme_version_id <> OLD.programme_version_id
    or NEW.lesson_id <> OLD.lesson_id
    or NEW.instructor_id <> OLD.instructor_id
    or NEW.scheduled_start <> OLD.scheduled_start
    or NEW.scheduled_end <> OLD.scheduled_end
    or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at then
    raise exception 'Class session schedule history is immutable; cancel and create a replacement';
  end if;

  if OLD.status in ('COMPLETED','CANCELLED') and NEW.status <> OLD.status then
    raise exception 'Closed class session history is immutable';
  end if;

  return NEW;
end $$;

revoke all on function public.guard_class_session_history() from public;
create trigger guard_class_session_history
before update or delete on public.class_sessions
for each row execute function public.guard_class_session_history();

create function public.can_read_class_session(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.class_sessions s
    where s.id = target
      and (
        public.is_academic_admin()
        or (
          public.has_role('INSTRUCTOR')
          and s.instructor_id = public.current_app_user()
        )
        or exists(
          select 1
          from public.enrolments e
          where e.cohort_id = s.cohort_id
            and e.student_id = public.current_app_user()
            and e.status in ('ACTIVE','PAUSED')
        )
      )
  )
$$;

revoke all on function public.can_read_class_session(uuid) from public;
grant execute on function public.can_read_class_session(uuid) to authenticated;

alter table public.class_sessions enable row level security;
revoke all on public.class_sessions from anon, authenticated;
grant select on public.class_sessions to authenticated;
create policy read_permitted on public.class_sessions
for select to authenticated using (public.can_read_class_session(id));

create function public.list_assignable_instructors()
returns table(user_id uuid, display_name text, title text)
language sql stable security definer set search_path='' as $$
  select s.user_id, u.display_name, s.title
  from public.staff_profiles s
  join public.app_users u on u.id = s.user_id
  join public.role_grants r on r.user_id = s.user_id and r.role = 'INSTRUCTOR'
  where public.current_app_user() is not null
    and public.is_academic_admin()
  order by u.display_name, s.user_id
$$;

revoke all on function public.list_assignable_instructors() from public;
grant execute on function public.list_assignable_instructors() to authenticated;

create function public.create_class_session(
  p_cohort_id uuid,
  p_lesson_id uuid,
  p_instructor_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  result uuid;
  version_id uuid;
  version_status text;
begin
  if public.current_app_user() is null or not public.is_academic_admin() then
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

  if not found then
    raise exception 'Cohort not found';
  end if;

  if version_status <> 'PUBLISHED' then
    raise exception 'Class sessions require a published programme version';
  end if;

  if not exists(
    select 1 from public.lessons
    where id = p_lesson_id and programme_version_id = version_id
  ) then
    raise exception 'Lesson must belong to the cohort programme version';
  end if;

  if not exists(
    select 1
    from public.staff_profiles s
    join public.role_grants r on r.user_id = s.user_id
    where s.user_id = p_instructor_id and r.role = 'INSTRUCTOR'
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
    p_scheduled_start, p_scheduled_end, public.current_app_user()
  ) returning id into result;

  return result;
end $$;

create function public.change_class_session_status(
  p_session_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  current_status text;
  session_end timestamptz;
begin
  if public.current_app_user() is null or not public.is_academic_admin() then
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

  if not found then
    raise exception 'Class session not found';
  end if;

  if current_status = p_status then
    return p_session_id;
  end if;

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

revoke all on function public.create_class_session(uuid,uuid,uuid,timestamptz,timestamptz,text) from public;
grant execute on function public.create_class_session(uuid,uuid,uuid,timestamptz,timestamptz,text) to authenticated;
revoke all on function public.change_class_session_status(uuid,text,text) from public;
grant execute on function public.change_class_session_status(uuid,text,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.class_sessions
for each row execute function public.audit_institutional_change();
