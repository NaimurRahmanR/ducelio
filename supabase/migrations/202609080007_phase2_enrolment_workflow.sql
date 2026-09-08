-- Phase 2 checkpoint 2: governed enrolment creation and lifecycle transitions.

alter table public.enrolments
  add column cohort_title_snapshot text,
  add column cohort_starts_on_snapshot date;

update public.enrolments e
set cohort_title_snapshot = c.title,
    cohort_starts_on_snapshot = c.starts_on
from public.cohorts c
where e.cohort_id = c.id;

alter table public.enrolments
  alter column cohort_title_snapshot set not null,
  alter column cohort_starts_on_snapshot set not null,
  add constraint enrolment_cohort_title_snapshot_not_blank
    check(length(trim(cohort_title_snapshot)) > 0);

create function public.prepare_enrolment_record() returns trigger
language plpgsql set search_path='' as $$
declare
  cohort_record public.cohorts%rowtype;
begin
  select * into cohort_record
  from public.cohorts
  where id = NEW.cohort_id;

  if not found then
    raise exception 'Cohort not found';
  end if;

  if NEW.programme_version_id <> cohort_record.programme_version_id then
    raise exception 'Enrolment and cohort must share a programme version';
  end if;

  NEW.cohort_title_snapshot := cohort_record.title;
  NEW.cohort_starts_on_snapshot := cohort_record.starts_on;
  return NEW;
end $$;

revoke all on function public.prepare_enrolment_record() from public;

create trigger prepare_enrolment_record
before insert on public.enrolments
for each row execute function public.prepare_enrolment_record();

create function public.create_enrolment(
  p_student_id uuid,
  p_cohort_id uuid,
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
    raise exception 'A bounded enrolment reason is required';
  end if;

  perform 1 from public.student_profiles where user_id = p_student_id for update;
  if not found then
    raise exception 'Learner not found';
  end if;

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

  if not found then
    raise exception 'Cohort not found';
  end if;

  if version_status <> 'PUBLISHED' then
    raise exception 'Enrolment requires a published programme version';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  insert into public.enrolments(student_id, cohort_id, programme_version_id)
  values(p_student_id, p_cohort_id, version_id)
  on conflict(student_id, cohort_id) do nothing
  returning id into result;

  if result is null then
    select id into result
    from public.enrolments
    where student_id = p_student_id and cohort_id = p_cohort_id;
  end if;

  return result;
end $$;

create function public.change_enrolment_status(
  p_enrolment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  current_status text;
begin
  if public.current_app_user() is null or not public.is_academic_admin() then
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

  if not found then
    raise exception 'Enrolment not found';
  end if;

  if current_status = p_status then
    return p_enrolment_id;
  end if;

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

revoke all on function public.create_enrolment(uuid,uuid,text) from public;
grant execute on function public.create_enrolment(uuid,uuid,text) to authenticated;
revoke all on function public.change_enrolment_status(uuid,text,text) from public;
grant execute on function public.change_enrolment_status(uuid,text,text) to authenticated;
