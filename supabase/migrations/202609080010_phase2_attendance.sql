-- Phase 2 checkpoint 5: authoritative attendance records tied to sessions and enrolments.
alter table public.enrolments
  add constraint enrolments_id_student_unique unique(id, student_id);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id),
  enrolment_id uuid not null,
  student_id uuid not null,
  status text not null check(status in ('PRESENT','LATE','ABSENT','EXCUSED')),
  recorded_by uuid not null references public.app_users(id),
  recorded_at timestamptz not null default now(),
  updated_by uuid not null references public.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key(enrolment_id,student_id)
    references public.enrolments(id,student_id),
  unique(session_id,enrolment_id)
);

create index attendance_student on public.attendance_records(student_id,session_id);
create index attendance_session on public.attendance_records(session_id,status);

create function public.guard_attendance_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Attendance history is immutable; correct the status instead';
  end if;

  if NEW.session_id <> OLD.session_id
    or NEW.enrolment_id <> OLD.enrolment_id
    or NEW.student_id <> OLD.student_id
    or NEW.recorded_by <> OLD.recorded_by
    or NEW.recorded_at <> OLD.recorded_at then
    raise exception 'Attendance identity history is immutable';
  end if;

  NEW.updated_at := now();
  return NEW;
end $$;

revoke all on function public.guard_attendance_history() from public;
create trigger guard_attendance_history
before update or delete on public.attendance_records
for each row execute function public.guard_attendance_history();

create function public.can_read_attendance(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.attendance_records a
    join public.class_sessions s on s.id = a.session_id
    where a.id = target
      and (
        public.is_academic_admin()
        or a.student_id = public.current_app_user()
        or (
          public.has_role('INSTRUCTOR')
          and s.instructor_id = public.current_app_user()
        )
      )
  )
$$;

revoke all on function public.can_read_attendance(uuid) from public;
grant execute on function public.can_read_attendance(uuid) to authenticated;

alter table public.attendance_records enable row level security;
revoke all on public.attendance_records from anon, authenticated;
grant select on public.attendance_records to authenticated;
create policy read_permitted on public.attendance_records
for select to authenticated using (public.can_read_attendance(id));

create function public.record_attendance(
  p_session_id uuid,
  p_enrolment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  result uuid;
  session_record public.class_sessions%rowtype;
  enrolment_record public.enrolments%rowtype;
  actor uuid;
begin
  actor := public.current_app_user();
  if actor is null then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_status not in ('PRESENT','LATE','ABSENT','EXCUSED') then
    raise exception 'Unsupported attendance status';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded attendance reason is required';
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
    raise exception 'Attendance cannot be recorded for a cancelled class session';
  end if;

  if session_record.scheduled_start > now() then
    raise exception 'Attendance cannot be recorded before the class session starts';
  end if;

  select * into enrolment_record
  from public.enrolments
  where id = p_enrolment_id;

  if not found then
    raise exception 'Enrolment not found';
  end if;

  if enrolment_record.cohort_id <> session_record.cohort_id
    or enrolment_record.programme_version_id <> session_record.programme_version_id then
    raise exception 'Attendance enrolment must belong to the class session cohort and programme version';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  select id into result
  from public.attendance_records
  where session_id = p_session_id and enrolment_id = p_enrolment_id
  for update;

  if result is null then
    insert into public.attendance_records(
      session_id,enrolment_id,student_id,status,recorded_by,updated_by
    ) values (
      p_session_id,p_enrolment_id,enrolment_record.student_id,p_status,actor,actor
    ) returning id into result;
  else
    update public.attendance_records
    set status = p_status,
        updated_by = actor
    where id = result;
  end if;

  return result;
end $$;

revoke all on function public.record_attendance(uuid,uuid,text,text) from public;
grant execute on function public.record_attendance(uuid,uuid,text,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.attendance_records
for each row execute function public.audit_institutional_change();
