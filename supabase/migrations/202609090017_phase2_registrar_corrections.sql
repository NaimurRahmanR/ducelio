-- Phase 2 checkpoint 12: governed registrar corrections and exception handling.
-- Registrar authority is restricted to official-record workflows. It does not grant
-- curriculum, teaching, evidence or assessment authority.

create function public.can_correct_official_records() returns boolean
language sql stable security definer set search_path='' as $$
  select public.has_role('REGISTRAR') or public.has_role('PLATFORM_ADMIN')
$$;

revoke all on function public.can_correct_official_records() from public;
grant execute on function public.can_correct_official_records() to authenticated;

create table public.registrar_corrections (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  correction_kind text not null check(correction_kind in ('ENROLMENT_STATUS','ATTENDANCE_STATUS')),
  enrolment_id uuid references public.enrolments(id),
  attendance_record_id uuid references public.attendance_records(id),
  before_value text not null check(length(trim(before_value)) between 1 and 40),
  after_value text not null check(length(trim(after_value)) between 1 and 40),
  reason text not null check(length(trim(reason)) between 5 and 300),
  corrected_by uuid not null references public.app_users(id),
  corrected_at timestamptz not null default now(),
  check(before_value <> after_value),
  check(
    (correction_kind='ENROLMENT_STATUS' and enrolment_id is not null and attendance_record_id is null)
    or
    (correction_kind='ATTENDANCE_STATUS' and attendance_record_id is not null and enrolment_id is null)
  )
);

create index registrar_corrections_student_time
  on public.registrar_corrections(student_id, corrected_at desc);
create index registrar_corrections_enrolment
  on public.registrar_corrections(enrolment_id) where enrolment_id is not null;
create index registrar_corrections_attendance
  on public.registrar_corrections(attendance_record_id) where attendance_record_id is not null;

create function public.guard_registrar_correction_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Registrar correction history is append-only';
end $$;

revoke all on function public.guard_registrar_correction_history() from public;
create trigger guard_registrar_correction_history
before update or delete on public.registrar_corrections
for each row execute function public.guard_registrar_correction_history();

alter table public.registrar_corrections enable row level security;
revoke all on public.registrar_corrections from anon, authenticated;
grant select on public.registrar_corrections to authenticated;
create policy read_permitted on public.registrar_corrections
for select to authenticated using (
  public.has_role('REGISTRAR')
  or public.has_role('ACADEMIC_ADMIN')
  or public.has_role('PLATFORM_ADMIN')
);

-- Existing early Phase 2 services used is_academic_admin(), which includes REGISTRAR
-- for broad read access. Prevent a registrar-only actor from using those academic
-- mutation paths. A deliberate registrar correction can temporarily opt in only
-- for the attendance row it is correcting.
create function public.guard_registrar_academic_mutation() returns trigger
language plpgsql set search_path='' as $$
begin
  if public.current_app_user() is not null
    and public.has_role('REGISTRAR')
    and not public.has_role('ACADEMIC_ADMIN')
    and not public.has_role('PLATFORM_ADMIN')
    and coalesce(current_setting('app.registrar_correction', true),'') <> 'true' then
    raise exception 'Registrar role cannot perform academic operational mutations' using errcode='42501';
  end if;

  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;

revoke all on function public.guard_registrar_academic_mutation() from public;

create trigger registrar_boundary
before insert or update or delete on public.class_sessions
for each row execute function public.guard_registrar_academic_mutation();

create trigger registrar_boundary
before insert or update or delete on public.attendance_records
for each row execute function public.guard_registrar_academic_mutation();

create trigger registrar_boundary
before insert or update or delete on public.lesson_progress
for each row execute function public.guard_registrar_academic_mutation();

create trigger registrar_boundary
before insert or update or delete on public.learning_evidence
for each row execute function public.guard_registrar_academic_mutation();

create function public.registrar_correct_enrolment_status(
  p_enrolment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  enrolment_record public.enrolments%rowtype;
  correction_id uuid;
begin
  actor:=public.current_app_user();
  if actor is null or not public.can_correct_official_records() then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_status not in ('ACTIVE','PAUSED','WITHDRAWN') then
    raise exception 'Registrar correction cannot set this enrolment status';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded registrar correction reason is required';
  end if;

  select * into enrolment_record
  from public.enrolments
  where id=p_enrolment_id
  for update;
  if not found then raise exception 'Enrolment not found'; end if;
  if enrolment_record.status='COMPLETED' then
    raise exception 'Completed enrolments require a separate academic completion workflow';
  end if;
  if enrolment_record.status=p_status then
    raise exception 'Registrar correction must change the recorded enrolment status';
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  update public.enrolments set status=p_status where id=p_enrolment_id;

  insert into public.registrar_corrections(
    student_id,correction_kind,enrolment_id,before_value,after_value,reason,corrected_by,corrected_at
  ) values (
    enrolment_record.student_id,'ENROLMENT_STATUS',p_enrolment_id,
    enrolment_record.status,p_status,trim(p_reason),actor,clock_timestamp()
  ) returning id into correction_id;

  return correction_id;
end $$;

revoke all on function public.registrar_correct_enrolment_status(uuid,text,text) from public;
grant execute on function public.registrar_correct_enrolment_status(uuid,text,text) to authenticated;

create function public.registrar_correct_attendance_status(
  p_attendance_record_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attendance_record public.attendance_records%rowtype;
  correction_id uuid;
begin
  actor:=public.current_app_user();
  if actor is null or not public.can_correct_official_records() then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_status not in ('PRESENT','LATE','ABSENT','EXCUSED') then
    raise exception 'Unsupported corrected attendance status';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded registrar correction reason is required';
  end if;

  select * into attendance_record
  from public.attendance_records
  where id=p_attendance_record_id
  for update;
  if not found then raise exception 'Attendance record not found'; end if;
  if attendance_record.status=p_status then
    raise exception 'Registrar correction must change the recorded attendance status';
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  perform set_config('app.registrar_correction','true',true);
  update public.attendance_records
  set status=p_status,updated_by=actor
  where id=p_attendance_record_id;
  perform set_config('app.registrar_correction','false',true);

  insert into public.registrar_corrections(
    student_id,correction_kind,attendance_record_id,before_value,after_value,reason,corrected_by,corrected_at
  ) values (
    attendance_record.student_id,'ATTENDANCE_STATUS',p_attendance_record_id,
    attendance_record.status,p_status,trim(p_reason),actor,clock_timestamp()
  ) returning id into correction_id;

  return correction_id;
end $$;

revoke all on function public.registrar_correct_attendance_status(uuid,text,text) from public;
grant execute on function public.registrar_correct_attendance_status(uuid,text,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.registrar_corrections
for each row execute function public.audit_institutional_change();
