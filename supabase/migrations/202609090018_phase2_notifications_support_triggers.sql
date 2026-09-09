-- Phase 2 checkpoint 13: institutional notifications and deterministic support triggers.
-- Rules are derived only from authoritative Academy OS state. No clicks, page views,
-- prompt sentiment or inferred engagement state participate.

alter table public.support_events
  drop constraint support_events_kind_check,
  add constraint support_events_kind_check check(
    kind in (
      'MISSED_CLASS',
      'DEADLINE_APPROACHING',
      'INACTIVITY',
      'MILESTONE',
      'PLAN_OVERDUE',
      'OBJECTIVE_REINFORCEMENT'
    )
  );

create table public.institutional_notifications (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  kind text not null check(kind in (
    'MISSED_CLASS',
    'ASSIGNMENT_DEADLINE',
    'PLAN_OVERDUE',
    'MASTERY_REINFORCEMENT',
    'SUPPORT_FOLLOWUP'
  )),
  title text not null check(length(trim(title)) between 1 and 200),
  body text not null check(length(trim(body)) between 1 and 1000),
  source_type text not null check(source_type in ('SUPPORT_EVENT','SUPPORT_FOLLOWUP')),
  source_id uuid not null,
  deduplication_key text not null unique check(length(trim(deduplication_key)) between 8 and 300),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index institutional_notifications_student_time
  on public.institutional_notifications(student_id, created_at desc);
create index institutional_notifications_unread
  on public.institutional_notifications(student_id, created_at desc)
  where read_at is null;

create function public.guard_notification_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Institutional notification history cannot be deleted';
  end if;

  if NEW.student_id<>OLD.student_id
    or NEW.kind<>OLD.kind
    or NEW.title<>OLD.title
    or NEW.body<>OLD.body
    or NEW.source_type<>OLD.source_type
    or NEW.source_id<>OLD.source_id
    or NEW.deduplication_key<>OLD.deduplication_key
    or NEW.created_at<>OLD.created_at then
    raise exception 'Institutional notification provenance is immutable';
  end if;

  if OLD.read_at is not null and NEW.read_at is distinct from OLD.read_at then
    raise exception 'Read notification history cannot be rewritten';
  end if;

  if OLD.read_at is null and NEW.read_at is null then
    return NEW;
  end if;

  if OLD.read_at is null and NEW.read_at is not null then
    return NEW;
  end if;

  raise exception 'Invalid institutional notification transition';
end $$;

revoke all on function public.guard_notification_history() from public;
create trigger guard_notification_history
before update or delete on public.institutional_notifications
for each row execute function public.guard_notification_history();

alter table public.institutional_notifications enable row level security;
revoke all on public.institutional_notifications from anon, authenticated;
grant select on public.institutional_notifications to authenticated;
create policy read_permitted on public.institutional_notifications
for select to authenticated using (
  student_id=public.current_app_user()
  or public.has_role('ACADEMIC_ADMIN')
  or public.has_role('PLATFORM_ADMIN')
);

create function public.mark_institutional_notification_read(p_notification_id uuid)
returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  notification_record public.institutional_notifications%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;

  select * into notification_record
  from public.institutional_notifications
  where id=p_notification_id
  for update;

  if not found then raise exception 'Notification not found'; end if;
  if notification_record.student_id<>actor then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if notification_record.read_at is null then
    update public.institutional_notifications
    set read_at=clock_timestamp()
    where id=p_notification_id;
  end if;

  return p_notification_id;
end $$;

revoke all on function public.mark_institutional_notification_read(uuid) from public;
grant execute on function public.mark_institutional_notification_read(uuid) to authenticated;

create function public.refresh_deterministic_support_triggers(p_reason text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  open_event_count integer;
  unread_notification_count integer;
begin
  actor:=public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded deterministic-trigger reason is required';
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);

  -- Rule SUPPORT_V1_MISSED_CLASS:
  -- an authoritative ABSENT attendance record creates/reopens a missed-class event.
  insert into public.support_events(
    student_id,kind,source_reference,deduplication_key,occurred_at,status
  )
  select
    a.student_id,
    'MISSED_CLASS',
    'attendance:'||a.id::text,
    'support:v1:missed-class:'||a.id::text,
    a.updated_at,
    'OPEN'
  from public.attendance_records a
  where a.status='ABSENT'
  on conflict(deduplication_key) do update set status='OPEN';

  update public.support_events e
  set status='RESOLVED'
  where e.kind='MISSED_CLASS'
    and e.deduplication_key like 'support:v1:missed-class:%'
    and e.status='OPEN'
    and not exists(
      select 1 from public.attendance_records a
      where 'attendance:'||a.id::text=e.source_reference
        and a.status='ABSENT'
    );

  -- Rule SUPPORT_V1_ASSIGNMENT_DEADLINE:
  -- active learners with a currently open published assignment due within 48 hours
  -- and no submission receive a deadline event. This is time/state based, not engagement based.
  insert into public.support_events(
    student_id,kind,source_reference,deduplication_key,occurred_at,status
  )
  select
    e.student_id,
    'DEADLINE_APPROACHING',
    'assignment:'||a.id::text,
    'support:v1:assignment-deadline:'||a.id::text||':'||e.id::text,
    clock_timestamp(),
    'OPEN'
  from public.assignments a
  join public.enrolments e
    on e.cohort_id=a.cohort_id
   and e.programme_version_id=a.programme_version_id
  where a.status='PUBLISHED'
    and e.status='ACTIVE'
    and now() between a.opens_at and a.due_at
    and a.due_at<=now()+interval '48 hours'
    and not exists(
      select 1 from public.assignment_submissions s
      where s.assignment_id=a.id and s.enrolment_id=e.id
    )
  on conflict(deduplication_key) do update set status='OPEN';

  update public.support_events se
  set status='RESOLVED'
  where se.kind='DEADLINE_APPROACHING'
    and se.deduplication_key like 'support:v1:assignment-deadline:%'
    and se.status='OPEN'
    and not exists(
      select 1
      from public.assignments a
      join public.enrolments e
        on e.cohort_id=a.cohort_id
       and e.programme_version_id=a.programme_version_id
      where 'assignment:'||a.id::text=se.source_reference
        and e.student_id=se.student_id
        and a.status='PUBLISHED'
        and e.status='ACTIVE'
        and now() between a.opens_at and a.due_at
        and a.due_at<=now()+interval '48 hours'
        and not exists(
          select 1 from public.assignment_submissions s
          where s.assignment_id=a.id and s.enrolment_id=e.id
        )
    );

  -- Rule SUPPORT_V1_PLAN_OVERDUE:
  -- a still-planned personal study item past its due date creates an overdue event.
  insert into public.support_events(
    student_id,kind,source_reference,deduplication_key,occurred_at,status
  )
  select
    i.student_id,
    'PLAN_OVERDUE',
    'study-plan-item:'||i.id::text,
    'support:v1:plan-overdue:'||i.id::text,
    clock_timestamp(),
    'OPEN'
  from public.study_plan_items i
  where i.status='PLANNED' and i.due_on<current_date
  on conflict(deduplication_key) do update set status='OPEN';

  update public.support_events e
  set status='RESOLVED'
  where e.kind='PLAN_OVERDUE'
    and e.deduplication_key like 'support:v1:plan-overdue:%'
    and e.status='OPEN'
    and not exists(
      select 1 from public.study_plan_items i
      where 'study-plan-item:'||i.id::text=e.source_reference
        and i.status='PLANNED'
        and i.due_on<current_date
    );

  -- Rule SUPPORT_V1_OBJECTIVE_REINFORCEMENT:
  -- only the deterministic mastery state may create this support condition.
  insert into public.support_events(
    student_id,kind,source_reference,deduplication_key,occurred_at,status
  )
  select
    m.student_id,
    'OBJECTIVE_REINFORCEMENT',
    'mastery:'||m.id::text,
    'support:v1:objective-reinforcement:'||m.id::text,
    m.evaluated_at,
    'OPEN'
  from public.objective_mastery m
  where m.state='NEEDS_REINFORCEMENT'
  on conflict(deduplication_key) do update set status='OPEN';

  update public.support_events e
  set status='RESOLVED'
  where e.kind='OBJECTIVE_REINFORCEMENT'
    and e.deduplication_key like 'support:v1:objective-reinforcement:%'
    and e.status='OPEN'
    and not exists(
      select 1 from public.objective_mastery m
      where 'mastery:'||m.id::text=e.source_reference
        and m.state='NEEDS_REINFORCEMENT'
    );

  -- Learner notifications are projections of deterministic support events.
  -- One source event yields at most one institutional notification.
  insert into public.institutional_notifications(
    student_id,kind,title,body,source_type,source_id,deduplication_key,created_at
  )
  select
    e.student_id,
    case e.kind
      when 'MISSED_CLASS' then 'MISSED_CLASS'
      when 'DEADLINE_APPROACHING' then 'ASSIGNMENT_DEADLINE'
      when 'PLAN_OVERDUE' then 'PLAN_OVERDUE'
      when 'OBJECTIVE_REINFORCEMENT' then 'MASTERY_REINFORCEMENT'
    end,
    case e.kind
      when 'MISSED_CLASS' then 'Attendance follow-up'
      when 'DEADLINE_APPROACHING' then 'Assignment deadline approaching'
      when 'PLAN_OVERDUE' then 'Study-plan item overdue'
      when 'OBJECTIVE_REINFORCEMENT' then 'Objective needs reinforcement'
    end,
    case e.kind
      when 'MISSED_CLASS' then 'An authorised attendance record marks a class as absent. Check your Classes and Support areas for the current record and any follow-up.'
      when 'DEADLINE_APPROACHING' then 'A published assignment is due within 48 hours and no submission is recorded for your enrolment.'
      when 'PLAN_OVERDUE' then 'A planned personal study-plan item is past its due date. Personal plan dates do not change institutional deadlines.'
      when 'OBJECTIVE_REINFORCEMENT' then 'The deterministic mastery policy currently marks a learning objective as needing reinforcement. Review Results for the authoritative objective state.'
    end,
    'SUPPORT_EVENT',
    e.id,
    'notification:v1:support-event:'||e.id::text,
    clock_timestamp()
  from public.support_events e
  where e.status='OPEN'
    and e.deduplication_key like 'support:v1:%'
    and e.kind in ('MISSED_CLASS','DEADLINE_APPROACHING','PLAN_OVERDUE','OBJECTIVE_REINFORCEMENT')
  on conflict(deduplication_key) do nothing;

  -- Open counsellor follow-ups due today or tomorrow produce a learner notification.
  insert into public.institutional_notifications(
    student_id,kind,title,body,source_type,source_id,deduplication_key,created_at
  )
  select
    f.student_id,
    'SUPPORT_FOLLOWUP',
    f.title,
    'An open learner-support follow-up is due by '||f.due_on::text||'.',
    'SUPPORT_FOLLOWUP',
    f.id,
    'notification:v1:support-followup:'||f.id::text,
    clock_timestamp()
  from public.support_followups f
  where f.status='OPEN'
    and f.due_on<=current_date+1
  on conflict(deduplication_key) do nothing;

  select count(*)::integer into open_event_count
  from public.support_events
  where status='OPEN' and deduplication_key like 'support:v1:%';

  select count(*)::integer into unread_notification_count
  from public.institutional_notifications
  where read_at is null;

  return jsonb_build_object(
    'openSupportEvents',open_event_count,
    'unreadNotifications',unread_notification_count,
    'policyVersion','SUPPORT_V1'
  );
end $$;

revoke all on function public.refresh_deterministic_support_triggers(text) from public;
grant execute on function public.refresh_deterministic_support_triggers(text) to authenticated;
