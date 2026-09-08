-- Phase 2 checkpoint 6: versioned lesson segments and learner progress.
-- Progress records completion of planned lesson segments; it does not establish mastery.

create table public.lesson_segments (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  programme_version_id uuid not null,
  title text not null check(length(trim(title)) between 1 and 200),
  position integer not null check(position > 0),
  foreign key(lesson_id, programme_version_id)
    references public.lessons(id, programme_version_id),
  unique(lesson_id, position),
  unique(id, lesson_id, programme_version_id)
);

create trigger freeze_content
before insert or update or delete on public.lesson_segments
for each row execute function public.guard_curriculum_version();

alter table public.lesson_segments enable row level security;
revoke all on public.lesson_segments from anon, authenticated;
grant select on public.lesson_segments to authenticated;
create policy read_permitted on public.lesson_segments
for select to authenticated using (public.can_read_version(programme_version_id));

create function public.create_lesson_segment(
  p_lesson_id uuid,
  p_title text,
  p_position integer,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  version_id uuid;
  version_status text;
  result uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_title is null or length(trim(p_title)) not between 1 and 200 then
    raise exception 'A bounded lesson segment title is required';
  end if;

  if p_position is null or p_position < 1 then
    raise exception 'Lesson segment position must be positive';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded curriculum-change reason is required';
  end if;

  select l.programme_version_id, v.status
  into version_id, version_status
  from public.lessons l
  join public.programme_versions v on v.id = l.programme_version_id
  where l.id = p_lesson_id
  for update of v;

  if not found then
    raise exception 'Lesson not found';
  end if;

  if version_status <> 'DRAFT' then
    raise exception 'Lesson segments can only be changed on draft programme versions';
  end if;

  if exists(
    select 1 from public.enrolments where programme_version_id = version_id
  ) then
    raise exception 'Enrolled curriculum is immutable';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.lesson_segments(lesson_id, programme_version_id, title, position)
  values(p_lesson_id, version_id, trim(p_title), p_position)
  returning id into result;

  return result;
end $$;

revoke all on function public.create_lesson_segment(uuid,text,integer,text) from public;
grant execute on function public.create_lesson_segment(uuid,text,integer,text) to authenticated;

create table public.lesson_progress (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  student_id uuid not null,
  segment_id uuid not null,
  lesson_id uuid not null,
  programme_version_id uuid not null,
  last_session_id uuid not null references public.class_sessions(id),
  status text not null check(status in ('IN_PROGRESS','COMPLETED')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key(enrolment_id, student_id)
    references public.enrolments(id, student_id),
  foreign key(segment_id, lesson_id, programme_version_id)
    references public.lesson_segments(id, lesson_id, programme_version_id),
  unique(enrolment_id, segment_id)
);

create index lesson_progress_student
  on public.lesson_progress(student_id, lesson_id);
create index lesson_progress_session
  on public.lesson_progress(last_session_id);

create function public.guard_lesson_progress_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Lesson progress history is immutable; correct the status instead';
  end if;

  if NEW.enrolment_id <> OLD.enrolment_id
    or NEW.student_id <> OLD.student_id
    or NEW.segment_id <> OLD.segment_id
    or NEW.lesson_id <> OLD.lesson_id
    or NEW.programme_version_id <> OLD.programme_version_id
    or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at then
    raise exception 'Lesson progress identity history is immutable';
  end if;

  NEW.updated_at := now();
  return NEW;
end $$;

revoke all on function public.guard_lesson_progress_history() from public;
create trigger guard_lesson_progress_history
before update or delete on public.lesson_progress
for each row execute function public.guard_lesson_progress_history();

create function public.can_read_lesson_progress(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.lesson_progress p
    join public.class_sessions s on s.id = p.last_session_id
    where p.id = target
      and (
        p.student_id = public.current_app_user()
        or public.is_academic_admin()
        or public.is_assigned_counsellor(p.student_id)
        or (
          public.has_role('INSTRUCTOR')
          and s.instructor_id = public.current_app_user()
        )
      )
  )
$$;

revoke all on function public.can_read_lesson_progress(uuid) from public;
grant execute on function public.can_read_lesson_progress(uuid) to authenticated;

alter table public.lesson_progress enable row level security;
revoke all on public.lesson_progress from anon, authenticated;
grant select on public.lesson_progress to authenticated;
create policy read_permitted on public.lesson_progress
for select to authenticated using (public.can_read_lesson_progress(id));

create function public.record_lesson_progress(
  p_session_id uuid,
  p_enrolment_id uuid,
  p_segment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  session_record public.class_sessions%rowtype;
  enrolment_record public.enrolments%rowtype;
  segment_record public.lesson_segments%rowtype;
  result uuid;
begin
  actor := public.current_app_user();
  if actor is null then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_status not in ('IN_PROGRESS','COMPLETED') then
    raise exception 'Unsupported lesson progress status';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded progress reason is required';
  end if;

  select * into session_record
  from public.class_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Class session not found';
  end if;

  if not (
    public.is_academic_admin()
    or (
      public.has_role('INSTRUCTOR')
      and session_record.instructor_id = actor
    )
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if session_record.status = 'CANCELLED' then
    raise exception 'Lesson progress cannot be recorded for a cancelled class session';
  end if;

  if session_record.scheduled_start > now() then
    raise exception 'Lesson progress cannot be recorded before the class session starts';
  end if;

  select * into enrolment_record
  from public.enrolments
  where id = p_enrolment_id;

  if not found then
    raise exception 'Enrolment not found';
  end if;

  if enrolment_record.cohort_id <> session_record.cohort_id
    or enrolment_record.programme_version_id <> session_record.programme_version_id then
    raise exception 'Progress enrolment must belong to the class session cohort and programme version';
  end if;

  select * into segment_record
  from public.lesson_segments
  where id = p_segment_id;

  if not found then
    raise exception 'Lesson segment not found';
  end if;

  if segment_record.lesson_id <> session_record.lesson_id
    or segment_record.programme_version_id <> session_record.programme_version_id then
    raise exception 'Progress segment must belong to the class session lesson and programme version';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  select id into result
  from public.lesson_progress
  where enrolment_id = p_enrolment_id and segment_id = p_segment_id
  for update;

  if result is null then
    insert into public.lesson_progress(
      enrolment_id, student_id, segment_id, lesson_id, programme_version_id,
      last_session_id, status, created_by, updated_by
    ) values (
      p_enrolment_id, enrolment_record.student_id, p_segment_id,
      segment_record.lesson_id, segment_record.programme_version_id,
      p_session_id, p_status, actor, actor
    ) returning id into result;
  else
    update public.lesson_progress
    set status = p_status,
        last_session_id = p_session_id,
        updated_by = actor
    where id = result;
  end if;

  return result;
end $$;

revoke all on function public.record_lesson_progress(uuid,uuid,uuid,text,text) from public;
grant execute on function public.record_lesson_progress(uuid,uuid,uuid,text,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.lesson_segments
for each row execute function public.audit_institutional_change();

create trigger audit_change
after insert or update or delete on public.lesson_progress
for each row execute function public.audit_institutional_change();
