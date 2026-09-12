-- DELIVERY_V1: learner logistics, not a replacement for cohort ClassSession,
-- private Counsellor study_plans, evidence, mastery, or official completion.
create schema delivery_private;
revoke all on schema delivery_private from public, anon, authenticated, service_role;

create table public.delivery_study_plans (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null unique,
  student_id uuid not null,
  cohort_id uuid not null,
  programme_version_id uuid not null,
  policy_version text not null default 'DELIVERY_V1' check(policy_version='DELIVERY_V1'),
  timezone text not null default 'Europe/London' check(length(timezone) between 1 and 100),
  study_days integer[] not null default array[1,3,5],
  local_start_time time not null default '19:00' check(extract(second from local_start_time)=0),
  cadence integer generated always as (cardinality(study_days)) stored check(cadence between 1 and 7),
  state text not null default 'DRAFT' check(state in ('DRAFT','CONFIRMED')),
  created_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz,
  foreign key(enrolment_id,student_id,cohort_id,programme_version_id)
    references public.enrolments(id,student_id,cohort_id,programme_version_id),
  unique(id,enrolment_id,programme_version_id),
  check((state='DRAFT' and confirmed_at is null) or (state='CONFIRMED' and confirmed_at is not null))
);

create table public.delivery_schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  enrolment_id uuid not null,
  programme_version_id uuid not null,
  revision integer not null check(revision between 1 and 50),
  study_days integer[] not null,
  local_start_time time not null,
  timezone text not null,
  cadence integer generated always as (cardinality(study_days)) stored check(cadence between 1 and 7),
  effective_on date not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references public.app_users(id),
  foreign key(plan_id,enrolment_id,programme_version_id)
    references public.delivery_study_plans(id,enrolment_id,programme_version_id),
  unique(plan_id,revision), unique(id,enrolment_id,programme_version_id)
);

create table public.scheduled_learning_occurrences (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null,
  enrolment_id uuid not null,
  programme_version_id uuid not null,
  lesson_id uuid not null,
  ordinal integer not null check(ordinal between 1 and 250),
  scheduled_at timestamptz not null,
  next_scheduled_at timestamptz not null,
  latest_start_at timestamptz not null,
  expected_duration_minutes integer not null default 60 check(expected_duration_minutes=60),
  transition_anchor boolean not null default false,
  replaces_id uuid unique,
  foreign key(revision_id,enrolment_id,programme_version_id)
    references public.delivery_schedule_revisions(id,enrolment_id,programme_version_id),
  foreign key(lesson_id,programme_version_id) references public.lessons(id,programme_version_id),
  unique(revision_id,lesson_id),
  unique(id,enrolment_id,programme_version_id,lesson_id,ordinal),
  foreign key(replaces_id,enrolment_id,programme_version_id,lesson_id,ordinal)
    references public.scheduled_learning_occurrences(id,enrolment_id,programme_version_id,lesson_id,ordinal),
  check(latest_start_at=next_scheduled_at-interval '60 minutes' and latest_start_at>=scheduled_at)
);
create index delivery_occurrence_window on public.scheduled_learning_occurrences(enrolment_id,scheduled_at,ordinal);

create table public.delivery_occurrence_starts (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null unique references public.scheduled_learning_occurrences(id),
  started_at timestamptz not null default clock_timestamp(),
  actor_id uuid not null references public.app_users(id),
  source text not null check(source='LEARNER_START')
);

create table public.delivery_catch_up (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null unique references public.scheduled_learning_occurrences(id),
  required_at timestamptz not null,
  resolved_at timestamptz
);

-- Fixed code-to-route mapping. No client/agent prose or caller-selected source role.
create table public.delivery_handoffs (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.enrolments(id),
  requested_by uuid not null references public.app_users(id),
  request_id uuid not null,
  initiator_kind text not null default 'LEARNER' check(initiator_kind='LEARNER'),
  destination_profile text not null check(destination_profile in ('TUTOR','LAB_INSTRUCTOR')),
  reason_code text not null check(reason_code in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE','PRACTICAL_HELP')),
  lesson_id uuid not null references public.lessons(id),
  objective_id uuid references public.lesson_objectives(id),
  summary text not null check(length(summary) between 1 and 120),
  priority text not null default 'NORMAL' check(priority='NORMAL'),
  provenance text not null default 'LEARNER_REQUEST' check(provenance='LEARNER_REQUEST'),
  status text not null default 'OPEN' check(status='OPEN'),
  created_at timestamptz not null default clock_timestamp(),
  unique(requested_by,request_id)
);
create index delivery_handoff_queue on public.delivery_handoffs(enrolment_id,status,created_at);

create function delivery_private.guard_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Delivery history is immutable'; end if;
  if TG_TABLE_NAME='delivery_study_plans' then
    if OLD.state='DRAFT' and (to_jsonb(NEW)-'cadence'-'study_days'-'local_start_time'-'timezone'-'state'-'confirmed_at')=(to_jsonb(OLD)-'cadence'-'study_days'-'local_start_time'-'timezone'-'state'-'confirmed_at') then return NEW; end if;
  end if;
  if TG_TABLE_NAME='delivery_catch_up'
    and (to_jsonb(NEW)-'resolved_at')=(to_jsonb(OLD)-'resolved_at') then return NEW; end if;
  raise exception 'Delivery history is immutable';
end $$;

create function delivery_private.audit_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,before_state,after_state)
  values(public.current_app_user(),'DELIVERY_'||TG_OP,TG_TABLE_NAME,NEW.id,'DELIVERY_V1',
    'Governed delivery lifecycle',case when TG_OP='UPDATE' then to_jsonb(OLD)-'summary' end,to_jsonb(NEW)-'summary');
  return NEW;
end $$;

do $$ declare t text; begin
  foreach t in array array['delivery_study_plans','delivery_schedule_revisions','scheduled_learning_occurrences','delivery_occurrence_starts','delivery_catch_up','delivery_handoffs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role',t);
    execute format('create trigger delivery_history before update or delete on public.%I for each row execute function delivery_private.guard_history()',t);
    execute format('create trigger delivery_audit after insert or update on public.%I for each row execute function delivery_private.audit_change()',t);
  end loop;
end $$;

-- All public self-service entry points use this scope; staff permissions never
-- widen a self query. Staff have a separate explicit metadata read entry point.
create function delivery_private.enrolment(p_id uuid,p_staff boolean default false,p_active boolean default false)
returns public.enrolments language plpgsql security definer set search_path='' as $$
declare e public.enrolments; actor uuid:=public.current_app_user();
begin
  if actor is null then raise exception 'UNAUTHENTICATED' using errcode='42501'; end if;
  if not p_staff and not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into e from public.enrolments where id=p_id for update;
  if e.id is null or (not p_staff and e.student_id<>actor)
    or (p_staff and not (public.is_academic_admin() or public.is_assigned_counsellor(e.student_id))) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501';
  end if;
  if p_active and e.status<>'ACTIVE' then raise exception 'POLICY_BLOCKED'; end if;
  return e;
end $$;

-- At least one planned segment, all completed through the existing governed
-- progress authority. No mastery calculation, submission or engagement proxy.
create function delivery_private.completed_at(p_enrolment uuid,p_lesson uuid) returns timestamptz
language sql stable security definer set search_path='' as $$
  select case when count(*)>0 and bool_and(p.status is not distinct from 'COMPLETED') then max(p.updated_at) end
  from public.lesson_segments s join public.enrolments e on e.id=p_enrolment and e.programme_version_id=s.programme_version_id
  left join public.lesson_progress p on p.enrolment_id=e.id and p.student_id=e.student_id and p.segment_id=s.id
    and p.programme_version_id=e.programme_version_id and p.lesson_id=s.lesson_id
  where s.lesson_id=p_lesson
$$;

create function delivery_private.refresh_catch_up(p_enrolment uuid,p_tick timestamptz default clock_timestamp()) returns void
language plpgsql security definer set search_path='' as $$
declare tick timestamptz:=p_tick;
begin
  insert into public.delivery_catch_up(occurrence_id,required_at,resolved_at)
  select o.id,o.latest_start_at,delivery_private.completed_at(o.enrolment_id,o.lesson_id)
  from public.scheduled_learning_occurrences o
  where o.enrolment_id=p_enrolment and o.latest_start_at<tick
    and not exists(select 1 from public.delivery_occurrence_starts s where s.occurrence_id=o.id)
    and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)
    and delivery_private.completed_at(o.enrolment_id,o.lesson_id) is null
  on conflict(occurrence_id) do nothing;
  update public.delivery_catch_up c set resolved_at=delivery_private.completed_at(o.enrolment_id,o.lesson_id)
  from public.scheduled_learning_occurrences o where o.id=c.occurrence_id and o.enrolment_id=p_enrolment
    and ((c.resolved_at is null and delivery_private.completed_at(o.enrolment_id,o.lesson_id) is not null)
      or (c.resolved_at is not null and delivery_private.completed_at(o.enrolment_id,o.lesson_id) is null));
end $$;

create function delivery_private.validate_preferences(p_days integer[],p_time time,p_zone text) returns void
language plpgsql set search_path='' as $$
begin
  if p_days is null or cardinality(p_days) not between 1 and 7 or array_ndims(p_days)<>1
    or array_position(p_days,null) is not null or not p_days <@ array[1,2,3,4,5,6,7]
    or cardinality(p_days)<>(select count(distinct d) from unnest(p_days) d)
    or p_time is null or extract(second from p_time)<>0 or p_time='24:00'::time
    or p_zone is null or length(p_zone)>100
    or not (p_zone='UTC' or (p_zone like '%/%' and p_zone not like 'posix/%' and p_zone not like 'right/%'))
    or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone) then raise exception 'INVALID_INPUT'; end if;
end $$;

-- PostgreSQL IANA rules choose the standard-time occurrence of an ambiguous
-- local timestamp. Nonexistent local times fail the whole schedule transaction.
create function delivery_private.next_slot(p_after timestamptz,p_days integer[],p_time time,p_zone text) returns timestamptz
language plpgsql set search_path='' as $$
declare d date:=(p_after at time zone p_zone)::date; local_stamp timestamp; candidate timestamptz; i integer;
begin
  for i in 0..8 loop
    if extract(isodow from d+i)::integer=any(p_days) then
      local_stamp:=(d+i)+p_time; candidate:=local_stamp at time zone p_zone;
      if candidate>p_after then
        if candidate at time zone p_zone<>local_stamp then raise exception 'INVALID_LOCAL_TIME'; end if;
        return candidate;
      end if;
    end if;
  end loop;
  raise exception 'INVALID_INPUT';
end $$;

create function delivery_private.guard_preferences() returns trigger
language plpgsql set search_path='' as $$
begin
  perform delivery_private.validate_preferences(NEW.study_days,NEW.local_start_time,NEW.timezone);
  return NEW;
end $$;
create trigger validate_delivery_preferences before insert or update on public.delivery_study_plans
for each row execute function delivery_private.guard_preferences();
create trigger validate_revision_preferences before insert on public.delivery_schedule_revisions
for each row execute function delivery_private.guard_preferences();

create function public.save_delivery_study_plan(p_enrolment_id uuid,p_study_days integer[] default null,p_local_start_time time default null,p_timezone text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.delivery_study_plans; days integer[]; local_time time; zone text;
begin
  e:=delivery_private.enrolment(p_enrolment_id,false,true);
  select * into p from public.delivery_study_plans where enrolment_id=e.id;
  days:=coalesce(p_study_days,p.study_days,array[1,3,5]); local_time:=coalesce(p_local_start_time,p.local_start_time,'19:00'::time);
  zone:=coalesce(p_timezone,p.timezone,(select timezone from public.student_profiles where user_id=e.student_id));
  perform delivery_private.validate_preferences(days,local_time,zone);
  days:=array(select d from unnest(days) d order by d);
  if p.id is null then
    insert into public.delivery_study_plans(enrolment_id,student_id,cohort_id,programme_version_id,study_days,local_start_time,timezone)
    values(e.id,e.student_id,e.cohort_id,e.programme_version_id,days,local_time,zone) returning * into p;
  elsif p.state<>'DRAFT' then raise exception 'PLAN_FROZEN';
  elsif p.study_days<>days or p.local_start_time<>local_time or p.timezone<>zone then
    update public.delivery_study_plans set study_days=days,local_start_time=local_time,timezone=zone where id=p.id;
  end if;
  return p.id;
end $$;

-- Replace only a future suffix after every opened/started/completed occurrence.
-- Preserve its first opening as a transition anchor: the immutable predecessor's
-- next-slot/latest-start boundary must not change when preferences change.
create function delivery_private.generate_schedule(p_plan uuid,p_days integer[],p_time time,p_zone text,p_effective date,p_initial boolean,p_confirmed_at timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.delivery_study_plans; revision_id uuid; number integer; item record; i integer:=0;
  moment timestamptz; next_moment timestamptz; protected_ordinal integer; first_moment timestamptz;
begin
  perform delivery_private.validate_preferences(p_days,p_time,p_zone);
  select * into p from public.delivery_study_plans where id=p_plan;
  select coalesce(max(revision),0)+1 into number from public.delivery_schedule_revisions where plan_id=p.id;
  if number>50 then raise exception 'LIMIT_EXCEEDED'; end if;
  select coalesce(max(o.ordinal),0) into protected_ordinal from public.scheduled_learning_occurrences o
    where o.enrolment_id=p.enrolment_id and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)
      and (o.scheduled_at<(p_effective::timestamp at time zone p_zone) or o.scheduled_at<=clock_timestamp()
        or delivery_private.completed_at(p.enrolment_id,o.lesson_id) is not null
        or exists(select 1 from public.delivery_occurrence_starts s where s.occurrence_id=o.id));
  first_moment:=delivery_private.next_slot(greatest((p_effective::timestamp at time zone p_zone)-interval '1 microsecond',p_confirmed_at),p_days,p_time,p_zone);
  insert into public.delivery_schedule_revisions(plan_id,enrolment_id,programme_version_id,revision,study_days,local_start_time,timezone,effective_on,created_by)
  values(p.id,p.enrolment_id,p.programme_version_id,number,p_days,p_time,p_zone,p_effective,public.current_app_user()) returning id into revision_id;
  for item in
    select l.id as lesson_id,row_number() over(order by m.position,l.position,l.id)::integer as ordinal,
      o.id as old_id,o.scheduled_at
    from public.lessons l join public.modules m on m.id=l.module_id
    left join public.scheduled_learning_occurrences o on o.enrolment_id=p.enrolment_id and o.lesson_id=l.id
      and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)
    where l.programme_version_id=p.programme_version_id
    order by m.position,l.position,l.id
  loop
    if p_initial or (item.old_id is not null and item.ordinal>protected_ordinal) then
      if i=0 then moment:=case when p_initial then first_moment else item.scheduled_at end; else moment:=next_moment; end if;
      -- A transition anchor keeps its old opening; the new preference begins
      -- on a later local date, never a second class on the anchor's local day.
      next_moment:=delivery_private.next_slot(case when not p_initial and i=0 then
        (((moment at time zone p_zone)::date+1)::timestamp at time zone p_zone)-interval '1 microsecond'
        else moment end,p_days,p_time,p_zone);
      if next_moment-moment<interval '60 minutes' then raise exception 'INVALID_INPUT'; end if;
      insert into public.scheduled_learning_occurrences(revision_id,enrolment_id,programme_version_id,lesson_id,ordinal,
        scheduled_at,next_scheduled_at,latest_start_at,replaces_id,transition_anchor)
      values(revision_id,p.enrolment_id,p.programme_version_id,item.lesson_id,item.ordinal,moment,next_moment,next_moment-interval '60 minutes',item.old_id,not p_initial and i=0);
      i:=i+1;
    end if;
  end loop;
  if i=0 then raise exception 'NO_ELIGIBLE_LESSONS'; end if;
  return revision_id;
end $$;

create function public.confirm_delivery_study_plan(p_enrolment_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.delivery_study_plans; first_day date; lesson_count integer; confirmed timestamptz;
begin
  e:=delivery_private.enrolment(p_enrolment_id,false,true);
  select * into p from public.delivery_study_plans where enrolment_id=e.id;
  if p.id is null then raise exception 'PLAN_REQUIRED'; end if;
  if p.state='CONFIRMED' then return p.id; end if;
  select count(*) into lesson_count from public.lessons where programme_version_id=e.programme_version_id;
  if lesson_count not between 1 and 250 then raise exception 'LIMIT_EXCEEDED'; end if;
  -- One DB-owned confirmation instant: today's later local slot is eligible.
  confirmed:=clock_timestamp();
  select greatest(starts_on,(confirmed at time zone p.timezone)::date) into first_day from public.cohorts where id=e.cohort_id;
  perform delivery_private.generate_schedule(p.id,p.study_days,p.local_start_time,p.timezone,first_day,true,confirmed);
  update public.delivery_study_plans set state='CONFIRMED',confirmed_at=confirmed where id=p.id;
  return p.id;
end $$;

create function public.change_future_delivery_schedule(p_enrolment_id uuid,p_study_days integer[],p_local_start_time time,p_timezone text,p_effective_on date) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.delivery_study_plans; last_day date;
begin
  e:=delivery_private.enrolment(p_enrolment_id,false,true);
  perform delivery_private.validate_preferences(p_study_days,p_local_start_time,p_timezone);
  if p_effective_on is null or p_effective_on <= (clock_timestamp() at time zone p_timezone)::date
    or p_effective_on > (clock_timestamp() at time zone p_timezone)::date+365 then raise exception 'INVALID_INPUT'; end if;
  select * into p from public.delivery_study_plans where enrolment_id=e.id;
  if p.state is distinct from 'CONFIRMED' then raise exception 'PLAN_REQUIRED'; end if;
  select max(effective_on) into last_day from public.delivery_schedule_revisions where plan_id=p.id;
  if p_effective_on<=last_day then raise exception 'INVALID_INPUT'; end if;
  if exists(select 1 from public.delivery_schedule_revisions r where r.plan_id=p.id
    and (r.effective_on::timestamp at time zone r.timezone)>=(p_effective_on::timestamp at time zone p_timezone)) then raise exception 'INVALID_INPUT'; end if;
  perform delivery_private.refresh_catch_up(e.id);
  return delivery_private.generate_schedule(p.id,p_study_days,p_local_start_time,p_timezone,p_effective_on,false);
end $$;

create function delivery_private.start_decision(p_scheduled timestamptz,p_latest timestamptz,p_started timestamptz,p_now timestamptz)
returns text language sql immutable set search_path='' as $$
  select case when p_started is not null then 'ALREADY_STARTED' when p_now<p_scheduled then 'NOT_OPEN'
    when p_now<=p_latest then 'START_ALLOWED' else 'MISSED' end
$$;
create function delivery_private.occurrence_state(p_open timestamptz,p_latest timestamptz,p_started timestamptz,p_completed timestamptz,p_now timestamptz)
returns text language sql immutable set search_path='' as $$
  select case when p_completed is not null then 'COMPLETED' when p_started is not null then 'STARTED'
    when p_now<p_open then 'UPCOMING' when p_now<=p_latest then 'DUE' else 'MISSED' end
$$;

create function delivery_private.counsellor_mode(p_actor uuid) returns text
language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.enrolments where student_id=p_actor and status in ('ACTIVE','PAUSED')) then 'ACTIVE_COURSE'
    when exists(select 1 from public.enrolments where student_id=p_actor and status='COMPLETED') then 'POST_COURSE' else 'PROSPECT' end
$$;

create function delivery_private.context(p_enrolment uuid,p_cursor integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.delivery_study_plans; e public.enrolments; tick timestamptz:=clock_timestamp(); items jsonb; total integer; backlog integer; current_lesson uuid; current_ordinal integer;
begin
  if p_cursor is null or p_cursor not between 0 and 250 then raise exception 'INVALID_INPUT'; end if;
  perform delivery_private.refresh_catch_up(p_enrolment,tick);
  select * into e from public.enrolments where id=p_enrolment;
  select * into p from public.delivery_study_plans where enrolment_id=p_enrolment;
  select count(*) into total from public.scheduled_learning_occurrences o where enrolment_id=p_enrolment
    and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id);
  select count(*) into backlog from public.delivery_catch_up c join public.scheduled_learning_occurrences o on o.id=c.occurrence_id
    where o.enrolment_id=p_enrolment and c.resolved_at is null;
  select o.lesson_id,o.ordinal into current_lesson,current_ordinal from public.scheduled_learning_occurrences o
    where o.enrolment_id=p_enrolment and o.latest_start_at>=tick
      and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)
    order by o.scheduled_at,o.ordinal limit 1;
  select coalesce(jsonb_agg(v.item order by v.ordinal),'[]'::jsonb) into items from (
    select o.ordinal,jsonb_build_object('id',o.id,'lessonId',o.lesson_id,'ordinal',o.ordinal,
      'scheduledAt',o.scheduled_at,'nextScheduledAt',o.next_scheduled_at,'latestStartAt',o.latest_start_at,
      'expectedDurationMinutes',o.expected_duration_minutes,'transitionAnchor',o.transition_anchor,'startedAt',s.started_at,
      'state',delivery_private.occurrence_state(o.scheduled_at,o.latest_start_at,s.started_at,delivery_private.completed_at(o.enrolment_id,o.lesson_id),tick),
      'completedAt',delivery_private.completed_at(o.enrolment_id,o.lesson_id),
      'catchUp',case when c.id is null then 'NONE' when c.resolved_at is null then 'REQUIRED' else 'RESOLVED' end) as item
    from public.scheduled_learning_occurrences o left join public.delivery_catch_up c on c.occurrence_id=o.id
    left join public.delivery_occurrence_starts s on s.occurrence_id=o.id
    where o.enrolment_id=p_enrolment and o.ordinal>p_cursor
      and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)
    order by o.ordinal limit 25
  ) v;
  return jsonb_build_object('enrolmentId',p_enrolment,'policyVersion','DELIVERY_V1','serverTime',tick,
    'enrolmentStatus',e.status,'counsellorMode',delivery_private.counsellor_mode(e.student_id),
    'academicEligibility',case when e.status='ACTIVE' then 'SUBJECT_TO_ACTIVITY' else 'CLOSED' end,
    'plan',case when p.id is null then null else jsonb_build_object('id',p.id,'state',p.state,'cadence',p.cadence,'timezone',p.timezone,
      'studyDays',p.study_days,'localStartTime',to_char(p.local_start_time,'HH24:MI'),
      'programmeVersionId',p.programme_version_id,'confirmedAt',p.confirmed_at) end,
    'effectiveCadence',coalesce((select r.cadence from public.delivery_schedule_revisions r where r.plan_id=p.id
      and r.effective_on<=(tick at time zone r.timezone)::date order by r.revision desc limit 1),p.cadence),
    'occurrences',items,'nextCursor',case when p_cursor+25<total then p_cursor+25 else null end,'backlogCount',backlog,
    'currentLessonId',current_lesson,
    'recoveryLessonIds',(select coalesce(jsonb_agg(o.lesson_id order by o.ordinal),'[]'::jsonb)
      from public.scheduled_learning_occurrences o
      where o.enrolment_id=p_enrolment and delivery_private.completed_at(o.enrolment_id,o.lesson_id) is null
        and o.scheduled_at<=tick and o.ordinal<coalesce(current_ordinal,251)
        and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id)),
    'revisions',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'cadence',r.cadence,'effectiveOn',r.effective_on,
      'studyDays',r.study_days,'localStartTime',to_char(r.local_start_time,'HH24:MI'),'timezone',r.timezone) order by r.revision),'[]'::jsonb)
      from public.delivery_schedule_revisions r where r.enrolment_id=p_enrolment));
end $$;

create function delivery_private.schedule_history(p_enrolment uuid,p_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.delivery_schedule_revisions;
begin
  if p_revision is null or p_revision not between 1 and 50 then raise exception 'INVALID_INPUT'; end if;
  select * into r from public.delivery_schedule_revisions where enrolment_id=p_enrolment and revision=p_revision;
  if r.id is null then raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('enrolmentId',p_enrolment,'revision',p_revision,'occurrences',(
    select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'lessonId',o.lesson_id,'ordinal',o.ordinal,
      'scheduledAt',o.scheduled_at,'nextScheduledAt',o.next_scheduled_at,'latestStartAt',o.latest_start_at,
      'expectedDurationMinutes',o.expected_duration_minutes,'transitionAnchor',o.transition_anchor,'replacesId',o.replaces_id) order by o.ordinal),'[]'::jsonb)
    from public.scheduled_learning_occurrences o where o.revision_id=r.id));
end $$;
create function public.get_delivery_schedule_history(p_enrolment_id uuid,p_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id);
  return delivery_private.schedule_history(p_enrolment_id,p_revision);
end $$;
create function public.get_delivery_admin_schedule_history(p_enrolment_id uuid,p_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id,true);
  return delivery_private.schedule_history(p_enrolment_id,p_revision);
end $$;

create function public.get_delivery_context(p_enrolment_id uuid,p_cursor integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id);
  return delivery_private.context(p_enrolment_id,p_cursor);
end $$;
create function public.get_delivery_admin_context(p_enrolment_id uuid,p_cursor integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id,true);
  return delivery_private.context(p_enrolment_id,p_cursor);
end $$;

create function public.get_delivery_agent_access(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; academic text;
begin
  e:=delivery_private.enrolment(p_enrolment_id);
  academic:=case when e.status<>'ACTIVE' then 'CLOSED'
    when not public.academic_content_release_explain_allowed() then 'ACTIVITY_BLOCKED' else 'AVAILABLE' end;
  return jsonb_build_object('enrolmentId',e.id,'PROFESSOR',academic,'TUTOR',academic,'LAB_INSTRUCTOR',academic,
    'EXAMINER',case when e.status='ACTIVE' then 'ASSESSMENT_CONTROLLED' else 'CLOSED' end,'COUNSELLOR','AVAILABLE');
end $$;

create function delivery_private.guard_start() returns trigger
language plpgsql set search_path='' as $$
declare o public.scheduled_learning_occurrences;
begin
  select * into o from public.scheduled_learning_occurrences where id=NEW.occurrence_id;
  if o.id is null or NEW.started_at<o.scheduled_at or NEW.started_at>o.latest_start_at
    or exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o.id) then raise exception 'INVALID_START'; end if;
  return NEW;
end $$;
create trigger validate_delivery_start before insert on public.delivery_occurrence_starts
for each row execute function delivery_private.guard_start();

create function public.start_scheduled_learning(p_occurrence_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); o public.scheduled_learning_occurrences; e public.enrolments;
  started timestamptz; decision text; tick timestamptz;
begin
  if actor is null then raise exception 'UNAUTHENTICATED' using errcode='42501'; end if;
  if not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Orders the first-start decision against assessment start. A start receipt
  -- is not an active content lease and grants no continuing runtime access.
  perform 1 from public.student_profiles where user_id=actor for update;
  select o1.* into o from public.scheduled_learning_occurrences o1 join public.enrolments e1 on e1.id=o1.enrolment_id
    where o1.id=p_occurrence_id and e1.student_id=actor
      and not exists(select 1 from public.scheduled_learning_occurrences n where n.replaces_id=o1.id);
  if o.id is null then raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501'; end if;
  e:=delivery_private.enrolment(o.enrolment_id,false,true);
  select started_at into started from public.delivery_occurrence_starts where occurrence_id=o.id;
  if started is null and delivery_private.completed_at(e.id,o.lesson_id) is not null
    and not exists(select 1 from public.delivery_catch_up c where c.occurrence_id=o.id) then raise exception 'POLICY_BLOCKED'; end if;
  tick:=clock_timestamp();
  decision:=delivery_private.start_decision(o.scheduled_at,o.latest_start_at,started,tick);
  if decision='START_ALLOWED' then
    if not public.academic_content_release_explain_allowed() then raise exception 'ACTIVITY_BLOCKED'; end if;
    started:=clock_timestamp();
    -- Re-evaluate after the firewall work; do not accept a crossed deadline.
    decision:=delivery_private.start_decision(o.scheduled_at,o.latest_start_at,null,started);
    if decision='START_ALLOWED' then
      insert into public.delivery_occurrence_starts(occurrence_id,started_at,actor_id,source) values(o.id,started,actor,'LEARNER_START');
      decision:='STARTED';
    else started:=null; end if;
  end if;
  perform delivery_private.refresh_catch_up(e.id);
  -- A late denial commits its catch-up/audit. Raising here would undo the miss.
  return jsonb_build_object('occurrenceId',o.id,'decision',decision,'startedAt',started);
end $$;

-- An authenticated account need not own a StudentProfile or enrolment to be a prospect.
create function public.get_counsellor_lifecycle() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); mode text;
begin
  if actor is null then raise exception 'UNAUTHENTICATED' using errcode='42501'; end if;
  mode:=delivery_private.counsellor_mode(actor);
  return jsonb_build_object('mode',mode,'available',true,'policyVersion','COUNSELLOR_SCOPE_V1');
end $$;

create function public.request_delivery_handoff(p_enrolment_id uuid,p_lesson_id uuid,p_objective_id uuid,p_reason_code text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; prior public.delivery_handoffs; result uuid; destination text; summary text;
begin
  e:=delivery_private.enrolment(p_enrolment_id,false,true);
  if not public.academic_content_release_explain_allowed() then raise exception 'ACTIVITY_BLOCKED'; end if;
  if p_request_id is null or p_reason_code is null or p_reason_code not in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE','PRACTICAL_HELP') then raise exception 'INVALID_INPUT'; end if;
  if not exists(select 1 from public.lessons where id=p_lesson_id and programme_version_id=e.programme_version_id)
    or (p_objective_id is not null and not exists(select 1 from public.lesson_objectives where id=p_objective_id and lesson_id=p_lesson_id and programme_version_id=e.programme_version_id)) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501'; end if;
  select * into prior from public.delivery_handoffs where requested_by=e.student_id and request_id=p_request_id;
  if prior.id is not null then
    if prior.enrolment_id=e.id and prior.lesson_id=p_lesson_id and prior.objective_id is not distinct from p_objective_id and prior.reason_code=p_reason_code then return prior.id; end if;
    raise exception 'CONTEXT_CONFLICT';
  end if;
  if (select count(*) from public.delivery_handoffs where enrolment_id=e.id and status='OPEN')>=20
    or (select count(*) from public.delivery_handoffs where enrolment_id=e.id)>=250 then raise exception 'LIMIT_EXCEEDED'; end if;
  destination:=case when p_reason_code='PRACTICAL_HELP' then 'LAB_INSTRUCTOR' else 'TUTOR' end;
  summary:=case p_reason_code when 'MISSED_LESSON_PRACTICE' then 'Learner requests practice for missed material.'
    when 'OBJECTIVE_REINFORCEMENT' then 'Learner requests objective reinforcement.'
    when 'PRACTICAL_PREREQUISITE' then 'Learner requests conceptual preparation for a practical.' else 'Learner requests practical support.' end;
  insert into public.delivery_handoffs(enrolment_id,requested_by,request_id,initiator_kind,destination_profile,reason_code,lesson_id,objective_id,summary)
  values(e.id,e.student_id,p_request_id,'LEARNER',destination,p_reason_code,p_lesson_id,p_objective_id,summary) returning id into result;
  return result;
end $$;

create function delivery_private.handoff_page(p_enrolment_id uuid,p_cursor integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if p_cursor is null or p_cursor not between 0 and 250 then raise exception 'INVALID_INPUT'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'enrolment_id',h.enrolment_id,'initiator_kind',h.initiator_kind,
    'destination_profile',h.destination_profile,'reason_code',h.reason_code,'lesson_id',h.lesson_id,'objective_id',h.objective_id,
    'summary',h.summary,'priority',h.priority,'provenance',h.provenance,'status',h.status,'created_at',h.created_at) order by h.created_at,h.id),'[]'::jsonb)
    from (select * from public.delivery_handoffs where enrolment_id=p_enrolment_id order by created_at,id limit 20 offset p_cursor) h);
end $$;

create function public.list_delivery_handoffs(p_enrolment_id uuid,p_cursor integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id);
  return delivery_private.handoff_page(p_enrolment_id,p_cursor);
end $$;
create function public.list_delivery_admin_handoffs(p_enrolment_id uuid,p_cursor integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform delivery_private.enrolment(p_enrolment_id,true);
  return delivery_private.handoff_page(p_enrolment_id,p_cursor);
end $$;

-- Progress corrections are respected; an existing catch-up row is never deleted.
-- Observe overdue incomplete work BEFORE the write so a late completion cannot
-- erase a missed window merely because nobody fetched its projection earlier.
-- The AFTER observation resolves it. Reaffirming already-completed progress
-- must not invent a late miss or rewrite a previous catch-up resolution time.
create function delivery_private.progress_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.enrolments where id=NEW.enrolment_id for update;
  -- Progress is academic authority, never evidence of a learner start.
  perform delivery_private.refresh_catch_up(NEW.enrolment_id);
  return NEW;
end $$;
create trigger delivery_progress_changed after insert or update on public.lesson_progress
for each row execute function delivery_private.progress_changed();
create trigger delivery_progress_before before insert or update on public.lesson_progress
for each row execute function delivery_private.progress_changed();

-- Explicitly neutralize ambient Supabase default ACLs, including service_role.
revoke all on all functions in schema delivery_private from public,anon,authenticated,service_role;
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('save_delivery_study_plan','confirm_delivery_study_plan','change_future_delivery_schedule',
      'get_delivery_context','get_delivery_admin_context','get_delivery_agent_access','get_counsellor_lifecycle',
      'request_delivery_handoff','list_delivery_handoffs','list_delivery_admin_handoffs',
      'get_delivery_schedule_history','get_delivery_admin_schedule_history','start_scheduled_learning') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
    execute format('grant execute on function %s to authenticated',f);
  end loop;
end $$;

-- Table REVOKE does not remove separate column ACLs.
do $$ declare t regclass; columns text; begin
  foreach t in array array['public.delivery_study_plans'::regclass,'public.delivery_schedule_revisions'::regclass,
    'public.scheduled_learning_occurrences'::regclass,'public.delivery_occurrence_starts'::regclass,
    'public.delivery_catch_up'::regclass,'public.delivery_handoffs'::regclass] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=t and attnum>0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public,anon,authenticated,service_role',
      columns,columns,columns,columns,t);
  end loop;
end $$;

-- Effective-ACL acceptance: unexpected inherited privileges fail deployment.
-- BYPASSRLS cannot bypass object ACLs; authenticated access is through only the
-- reviewed public RPCs, with operation-specific identity/ownership checks.
do $$ declare t regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['public.delivery_study_plans'::regclass,'public.delivery_schedule_revisions'::regclass,
      'public.scheduled_learning_occurrences'::regclass,'public.delivery_occurrence_starts'::regclass,
      'public.delivery_catch_up'::regclass,'public.delivery_handoffs'::regclass] loop
      if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective delivery privileges';
      end if;
    end loop;
    if has_schema_privilege(r,'delivery_private','USAGE,CREATE') then
      raise exception 'Unsafe effective delivery privileges';
    end if;
    for f in select p.oid,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='delivery_private' or (n.nspname='public' and p.proname in (
        'save_delivery_study_plan','confirm_delivery_study_plan','change_future_delivery_schedule',
        'get_delivery_context','get_delivery_admin_context','get_delivery_agent_access','get_counsellor_lifecycle',
        'request_delivery_handoff','list_delivery_handoffs','list_delivery_admin_handoffs',
        'get_delivery_schedule_history','get_delivery_admin_schedule_history','start_scheduled_learning')) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then
        raise exception 'Unsafe effective delivery privileges';
      end if;
    end loop;
  end loop;
end $$;
