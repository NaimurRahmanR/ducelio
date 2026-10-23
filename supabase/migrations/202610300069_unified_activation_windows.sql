-- Unified personal activation and exact 1439-minute availability. Historical
-- cohort/Academy courses keep their existing policy. No data is deleted.
begin;
create table public.course_engine_recoveries (
 id uuid primary key default gen_random_uuid(),
 enrolment_id uuid not null references public.academy_enrolments(id),
 root_item_id uuid not null references public.academy_schedule_items(id),
 request_key uuid not null,
 opens_at timestamptz not null,
 reason_code text not null check(reason_code in ('MISSED_WINDOW','TECHNICAL_ISSUE')),
 state text not null default 'PENDING' check(state in ('PENDING','APPROVED','DENIED')),
 requested_at timestamptz not null default clock_timestamp(),
 reviewed_by uuid references public.app_users(id),reviewed_at timestamptz,review_reason text,
 unique(enrolment_id,request_key),
 check((state='PENDING' and reviewed_by is null and reviewed_at is null and review_reason is null)
   or (state<>'PENDING' and reviewed_by is not null and reviewed_at is not null and length(review_reason) between 5 and 300))
);
create unique index one_pending_activity_recovery on public.course_engine_recoveries(enrolment_id,root_item_id) where state='PENDING';
create unique index one_approved_activity_recovery on public.course_engine_recoveries(enrolment_id,root_item_id) where state='APPROVED';
create index course_recovery_reviewer on public.course_engine_recoveries(reviewed_by);
create index course_recovery_item on public.course_engine_recoveries(root_item_id);
alter table public.course_engine_recoveries enable row level security;
revoke all on public.course_engine_recoveries from public,anon,authenticated,service_role;
create function academy_private.guard_recovery() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.state<>'PENDING' or new.state not in ('APPROVED','DENIED')
  or (to_jsonb(new)-array['state','reviewed_by','reviewed_at','review_reason']) is distinct from
     (to_jsonb(old)-array['state','reviewed_by','reviewed_at','review_reason']) then raise exception 'IMMUTABLE_HISTORY';end if;
 return new;
end $$;
create trigger recovery_history before update or delete on public.course_engine_recoveries for each row execute function academy_private.guard_recovery();
-- Each new schedule item has either a complete window or no legacy window.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.academy_schedule_items'::regclass
   and contype='c' and pg_get_constraintdef(oid) like '%kind%opens_at%' loop
   execute format('alter table public.academy_schedule_items drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.academy_schedule_items add constraint academy_activity_window_shape check (
 (opens_at is not null and closes_at is not null) or (kind <> 'ASSESSMENT' and opens_at is null and closes_at is null));
create function academy_private.unified_enrolment(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.academy_enrolments e join public.course_engine_publications p on p.course_id=e.course_id where e.id=p_id)
$$;
create function academy_private.unified_item_window(p_item uuid)
returns table(opens_at timestamptz,closes_at timestamptz)
language sql stable security definer set search_path='' as $$
 select coalesce(r.opens_at,i.starts_at),coalesce(r.opens_at,i.starts_at)+interval '1439 minutes' from public.academy_schedule_items i
 join public.academy_schedules s on s.id=i.schedule_id
 left join public.course_engine_recoveries r on r.enrolment_id=i.enrolment_id
   and r.root_item_id=academy_private.root_schedule_item(i.id) and r.state='APPROVED'
 where i.id=p_item and s.superseded_at is null and academy_private.unified_enrolment(i.enrolment_id)
$$;
create function academy_private.unified_activity_open_at(p_enrolment uuid,p_kind text,p_ref text,p_root uuid,p_now timestamptz) returns boolean
language sql volatile security definer set search_path='' as $$
 select exists(select 1 from public.academy_schedule_items i
 join public.academy_schedules s on s.id=i.schedule_id
 join public.academy_enrolments e on e.id=i.enrolment_id
 join public.academy_entitlements ent on ent.id=e.entitlement_id
 cross join lateral academy_private.unified_item_window(i.id) w
 where e.id=p_enrolment and e.learner_id=public.current_app_user() and e.status='ACTIVE' and ent.state='ACTIVE'
 and s.superseded_at is null and i.kind=p_kind and i.ref=p_ref
 and (p_root is null or academy_private.root_schedule_item(i.id)=p_root)
 and p_now>=w.opens_at and p_now<w.closes_at)
$$;
create function academy_private.unified_activity_open(p_enrolment uuid,p_kind text,p_ref text,p_root uuid default null) returns boolean
language sql volatile security definer set search_path='' as $$
 select academy_private.unified_activity_open_at(p_enrolment,p_kind,p_ref,p_root,clock_timestamp())
$$;

create function academy_private.enforce_unified_item_window() returns trigger
language plpgsql set search_path='' as $$
begin
 if academy_private.unified_enrolment(new.enrolment_id) then
   new.opens_at:=new.starts_at;new.closes_at:=new.starts_at+interval '1439 minutes';
 end if;
 return new;
end $$;
create trigger unified_item_window before insert on public.academy_schedule_items for each row execute function academy_private.enforce_unified_item_window();


create or replace function academy_private.compute_plan(
  e public.academy_enrolments, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text,
  p_effective_on date
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  fmt public.academy_offer_formats%rowtype; ent public.academy_entitlements%rowtype; course public.academy_courses%rowtype;
  cur public.academy_schedules%rowtype; t time; days integer[]; weeks integer; today date; plan jsonb; timed jsonb;
  remaining jsonb := '[]'; kept jsonb := '[]'; cutover timestamptz; first_unit integer; first_offset integer := 0;
  kept_minutes integer; last_teaching date; u integer; alt jsonb := '[]'; other public.academy_offer_formats%rowtype;
  extra integer[]; candidate integer[]; k integer; session_base integer := 0;
begin
  select * into ent from public.academy_entitlements where id = e.entitlement_id;
  select * into course from public.academy_courses where id = e.course_id;
  if e.status <> 'ACTIVE' then return jsonb_build_object('feasible',false,'code','ENROLMENT_CLOSED','message','This course is complete; its timetable can no longer change.'); end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    return jsonb_build_object('feasible',false,'code','INVALID_TIMEZONE','message','Choose a recognised timezone.');
  end if;
  if p_local_time is null or p_local_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    return jsonb_build_object('feasible',false,'code','INVALID_INPUT','message','Choose a class time in HH:MM format.');
  end if;
  t := p_local_time::time;
  select array_agg(distinct d order by d) into days from unnest(p_study_days) d;
  if days is null or not (days <@ array[1,2,3,4,5,6,7]) then
    return jsonb_build_object('feasible',false,'code','INVALID_INPUT','message','Choose at least one study day.');
  end if;
  cur := academy_private.current_schedule(e.id);
  if p_effective_on is not null then
    if cur.id is null then return jsonb_build_object('feasible',false,'code','PLAN_REQUIRED','message','Confirm a first timetable before revising it.'); end if;
    p_format_id := cur.format_id;
    p_start_on := cur.start_on;
  end if;
  if ent.format_id is not null and p_format_id is distinct from ent.format_id then
    return jsonb_build_object('feasible',false,'code','FORMAT_FIXED','message','Your access is for a specific learning format.','formatId',ent.format_id);
  end if;
  if e.format_id is not null and p_format_id is distinct from e.format_id then
    return jsonb_build_object('feasible',false,'code','FORMAT_FIXED','message','Your learning format is already confirmed.','formatId',e.format_id);
  end if;
  select f.* into fmt from public.academy_offer_formats f join public.academy_offers o on o.id = f.offer_id
  where o.course_id = e.course_id and f.format_id = p_format_id;
  if not found then return jsonb_build_object('feasible',false,'code','INVALID_FORMAT','message','That learning format is not offered for this course.'); end if;
  weeks := academy_private.format_weeks(fmt.format_id);
  if cardinality(days) not between fmt.min_study_days and fmt.max_study_days then
    return jsonb_build_object('feasible',false,'code','STUDY_DAYS_OUT_OF_RANGE',
      'message',format('The %s format needs between %s and %s study days a week.', fmt.format_id, fmt.min_study_days, fmt.max_study_days),
      'minStudyDays',fmt.min_study_days,'maxStudyDays',fmt.max_study_days);
  end if;
  today := (clock_timestamp() at time zone p_timezone)::date;

  if p_effective_on is null then
    if p_start_on is null or p_start_on < today or p_start_on > today + 180 then
      return jsonb_build_object('feasible',false,'code','INVALID_START_DATE','message','Choose a start date from today up to 180 days ahead.');
    end if;
    plan := academy_private.plan_units(course.units, weeks, fmt.session_minutes, p_start_on, days, null, null, 0);
    remaining := course.units;
  else
    if p_effective_on <= today or p_effective_on > cur.end_on then
      return jsonb_build_object('feasible',false,'code','INVALID_EFFECTIVE_DATE','message','Changes can start from tomorrow until your course end date.');
    end if;
    cutover := (p_effective_on + time '00:00') at time zone p_timezone;
    if cutover <= clock_timestamp() then
      return jsonb_build_object('feasible',false,'code','INVALID_EFFECTIVE_DATE','message','Changes can start from tomorrow until your course end date.');
    end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.sequence), '[]') into kept
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at < cutover;
    select min(i.unit_index) into first_unit from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at >= cutover;
    if first_unit is null then
      return jsonb_build_object('feasible',false,'code','NOTHING_TO_RESCHEDULE','message','Every scheduled activity is before that date.');
    end if;
    select coalesce(sum(i.minutes), 0), coalesce(max(i.part), 0) into kept_minutes, first_offset
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.unit_index = first_unit and i.starts_at < cutover;
    select max((i.starts_at at time zone p_timezone)::date) into last_teaching
    from public.academy_schedule_items i where i.schedule_id = cur.id and i.kind = 'LESSON' and i.starts_at < cutover;
    select coalesce(max(i.session_index) + 1, 0) into session_base from public.academy_schedule_items i where i.schedule_id = cur.id and i.starts_at < cutover;
    for u in first_unit .. jsonb_array_length(course.units) - 1 loop
      remaining := remaining || jsonb_build_array(case when u = first_unit
        then jsonb_set(course.units->u, '{minutes}', to_jsonb((course.units->u->>'minutes')::integer - kept_minutes))
        else course.units->u end);
    end loop;
    plan := academy_private.plan_units(remaining, weeks, fmt.session_minutes, cur.start_on, days, p_effective_on, last_teaching, first_offset);
  end if;

  if not (plan->>'feasible')::boolean then
    -- Alternatives are offered, never applied.
    extra := array(select d from unnest(array[1,2,3,4,5,6,7]) d where not d = any(days) order by d);
    for k in 1 .. cardinality(extra) loop
      exit when cardinality(days) + k > fmt.max_study_days;
      candidate := array(select d from unnest(days || extra[1:k]) d order by d);
      if (academy_private.plan_units(remaining, weeks, fmt.session_minutes, p_start_on, candidate,
            p_effective_on, last_teaching, first_offset)->>'feasible')::boolean then
        alt := alt || jsonb_build_array(jsonb_build_object('kind','STUDY_DAYS','formatId',fmt.format_id,'studyDays',to_jsonb(candidate)));
        exit;
      end if;
    end loop;
    if p_effective_on is null and e.format_id is null and ent.format_id is null then
      for other in select f.* from public.academy_offer_formats f where f.offer_id = fmt.offer_id and f.format_id <> fmt.format_id
                   order by academy_private.format_weeks(f.format_id) loop
        if cardinality(days) between other.min_study_days and other.max_study_days
          and (academy_private.plan_units(course.units, academy_private.format_weeks(other.format_id), other.session_minutes,
                 p_start_on, days, null, null, 0)->>'feasible')::boolean then
          alt := alt || jsonb_build_array(jsonb_build_object('kind','FORMAT','formatId',other.format_id,'studyDays',to_jsonb(days)));
        end if;
      end loop;
    end if;
    return plan || jsonb_build_object('message',
      format('Your selected days give %s class sessions before %s, which is not enough to complete every lesson, lab and assessment with the required preparation time.',
        plan->>'availableSessions', to_char((plan->>'endDate')::date, 'FMDD Mon YYYY')),
      'alternatives', alt);
  end if;

  timed := academy_private.timed_items(plan, remaining, t, p_timezone);
  if not (timed->>'feasible')::boolean then
    return timed || jsonb_build_object('message', format('%s does not exist on %s in %s because of a daylight-saving change. Choose another class time.',
      p_local_time, timed->>'localDate', p_timezone), 'alternatives', '[]'::jsonb);
  end if;
  if academy_private.unified_enrolment(e.id) then
    if p_effective_on is null and exists(select 1 from jsonb_array_elements(timed->'items') x where (x->>'startsAt')::timestamptz < clock_timestamp()) then
      return jsonb_build_object('feasible',false,'code','INVALID_START_TIME','message','Choose a class time whose first activity is still in the future.');
    end if;
    select jsonb_build_object('items',coalesce(jsonb_agg(x || jsonb_build_object('opensAt',x->'startsAt','closesAt',(x->>'startsAt')::timestamptz+interval '1439 minutes') order by ord),'[]')) into timed
      from jsonb_array_elements(timed->'items') with ordinality a(x,ord);
  end if;
  return jsonb_build_object('feasible', true, 'formatId', fmt.format_id, 'weeks', weeks, 'sessionMinutes', fmt.session_minutes,
    'startOn', coalesce(cur.start_on, p_start_on), 'endOn', (plan->>'endDate')::date,
    'studyDays', to_jsonb(days), 'localTime', p_local_time, 'timezone', p_timezone,
    'effectiveOn', p_effective_on, 'cutover', cutover, 'sessionBase', session_base,
    'kept', kept, 'items', timed->'items');
end $$;

create or replace function public.confirm_my_academy_schedule(
  p_enrolment_id uuid, p_format_id text, p_start_on date, p_study_days integer[], p_local_time text, p_timezone text, p_request_key uuid
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  existing public.academy_schedules%rowtype; plan jsonb; schedule_id uuid;
begin
  if p_request_key is null then raise exception 'INVALID_INPUT'; end if;
  select * into existing from public.academy_schedules where enrolment_id = e.id and request_key = p_request_key;
  if found then
    if existing.format_id is distinct from p_format_id or existing.start_on is distinct from p_start_on
      or existing.study_days is distinct from array(select distinct d from unnest(p_study_days) d order by d)
      or to_char(existing.local_time,'HH24:MI') is distinct from p_local_time or existing.timezone is distinct from p_timezone then
      return jsonb_build_object('ok',false,'code','REQUEST_CONFLICT','message','This confirmation key already records different timetable choices. Reload before trying again.');
    end if;
    return jsonb_build_object('ok', true, 'scheduleId', existing.id, 'revision', existing.revision, 'replayed', true);
  end if;
  if (academy_private.current_schedule(e.id)).id is not null then
    return jsonb_build_object('ok', false, 'code', 'PLAN_EXISTS', 'message', 'Your timetable is already confirmed; revise future dates instead.');
  end if;
  plan := academy_private.compute_plan(e, p_format_id, p_start_on, p_study_days, p_local_time, p_timezone, null);
  if not (plan->>'feasible')::boolean then return plan || jsonb_build_object('ok', false); end if;
  if e.format_id is null then
    update public.academy_enrolments set format_id = plan->>'formatId', format_locked_at = clock_timestamp() where id = e.id;
  end if;
  schedule_id := academy_private.store_plan(e, plan, p_request_key, null);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (e.learner_id, 'ACADEMY_SCHEDULE_CONFIRMED', 'academy_schedules', schedule_id, 'ACADEMY_DELIVERY_V1', 'Learner confirmed a personal timetable.',
    jsonb_build_object('enrolment_id', e.id, 'revision', 1, 'format_id', plan->>'formatId'));
  return jsonb_build_object('ok', true, 'scheduleId', schedule_id, 'revision', 1, 'replayed', false);
end $$;

create or replace function academy_private.lesson_released(p_enrolment_id uuid,p_lesson_ref text) returns boolean
language sql volatile security definer set search_path='' as $$
 select case when academy_private.unified_enrolment(p_enrolment_id) then
   academy_private.unified_activity_open(p_enrolment_id,'LESSON',p_lesson_ref)
 else exists(select 1 from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
 where s.enrolment_id=p_enrolment_id and s.superseded_at is null and i.kind='LESSON' and i.ref=p_lesson_ref and i.part=1 and i.starts_at<=clock_timestamp()) end
$$;

create or replace function academy_private.teaching_classroom(p_classroom_id uuid,
  out c public.academy_professor_classrooms, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record;
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  select * into c from public.academy_professor_classrooms where id = p_classroom_id and learner_id = actor;
  if c.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  select * into r from academy_private.teaching_enrolment(c.enrolment_id, false);
  if r.code is not null then code := r.code; return; end if;
  if not academy_private.lesson_released(c.enrolment_id, c.lesson_ref) then code := 'NOT_RELEASED'; return; end if;
  if academy_private.unified_enrolment(c.enrolment_id) and not academy_private.unified_activity_open(c.enrolment_id,'LESSON',c.lesson_ref,c.schedule_item_id) then code:='WINDOW_CLOSED';return;end if;
  if academy_private.exam_active() then code := 'ACTIVITY_BLOCKED'; return; end if;
end $$;

create or replace function public.open_my_academy_professor_classroom(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; i public.academy_schedule_items%rowtype;
  root public.academy_schedule_items%rowtype; s public.academy_schedules%rowtype;
  cl public.academy_course_lessons%rowtype; existing uuid; created uuid;
begin
  if p_enrolment_id is null or p_schedule_item_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- Lock order shared with every admission: learner profile, then enrolment.
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  select * into i from public.academy_schedule_items where id = p_schedule_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LESSON' then return jsonb_build_object('ok', false, 'code', 'NOT_A_CLASS'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
  if academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id,'LESSON',i.ref,academy_private.root_schedule_item(i.id)) then return jsonb_build_object('ok',false,'code','WINDOW_CLOSED');end if;
  if clock_timestamp() < i.starts_at then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = i.ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into root from public.academy_schedule_items where id = academy_private.root_schedule_item(i.id);
  if root.id is null or root.enrolment_id <> e.id or root.kind <> 'LESSON' or root.ref <> i.ref then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
  end if;
  select id into existing from public.academy_professor_classrooms where schedule_item_id = root.id;
  if existing is not null then
    return jsonb_build_object('ok', true, 'classroomId', existing, 'resumed', true);
  end if;
  insert into public.academy_professor_classrooms(learner_id, enrolment_id, schedule_item_id, programme_version_id,
    lesson_ref, lesson_id, part, parts, scheduled_start, scheduled_end)
  values (e.learner_id, e.id, root.id, e.programme_version_id, root.ref, cl.lesson_id, root.part, root.parts,
    root.starts_at, root.ends_at)
  on conflict (schedule_item_id) do nothing
  returning id into created;
  if created is null then
    select id into existing from public.academy_professor_classrooms where schedule_item_id = root.id;
    return jsonb_build_object('ok', true, 'classroomId', existing, 'resumed', true);
  end if;
  return jsonb_build_object('ok', true, 'classroomId', created, 'resumed', false);
end $$;

create or replace function public.open_my_academy_lab_support(p_enrolment_id uuid, p_schedule_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; e public.academy_enrolments%rowtype; i public.academy_schedule_items%rowtype;
  s public.academy_schedules%rowtype; root uuid; pa record; cl public.academy_course_lessons%rowtype;
  existing uuid; created uuid;
begin
  if p_enrolment_id is null or p_schedule_item_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into r from academy_private.teaching_enrolment(p_enrolment_id, true);
  if r.code is not null then return jsonb_build_object('ok', false, 'code', r.code); end if;
  e := r.e;
  select * into i from public.academy_schedule_items where id = p_schedule_item_id and enrolment_id = e.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if i.kind <> 'LAB' then return jsonb_build_object('ok', false, 'code', 'NOT_A_PRACTICAL'); end if;
  select * into s from public.academy_schedules where id = i.schedule_id;
  if s.superseded_at is not null then return jsonb_build_object('ok', false, 'code', 'SCHEDULE_SUPERSEDED'); end if;
  if academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id,'LAB',i.ref,academy_private.root_schedule_item(i.id)) then return jsonb_build_object('ok',false,'code','WINDOW_CLOSED');end if;
  if clock_timestamp() < i.starts_at then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED'); end if;
  if academy_private.lab_graded(e.course_id, i.ref) then
    return jsonb_build_object('ok', false, 'code', 'GRADED_PRACTICAL');
  end if;
  select * into pa from academy_private.practical_activity(e.course_id, i.ref);
  if pa.lesson_ref is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = pa.lesson_ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if not academy_private.unified_enrolment(e.id) and not academy_private.lesson_released(e.id, pa.lesson_ref) then return jsonb_build_object('ok', false, 'code', 'NOT_RELEASED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  root := academy_private.root_schedule_item(i.id);
  if root is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select id into existing from public.academy_support_requests where schedule_item_id = root and role = 'LAB_INSTRUCTOR';
  if existing is not null then return jsonb_build_object('ok', true, 'requestId', existing, 'resumed', true); end if;
  insert into public.academy_support_requests(learner_id, enrolment_id, role, reason_code, programme_version_id,
    lesson_ref, lesson_id, practical_key, schedule_item_id)
  values (e.learner_id, e.id, 'LAB_INSTRUCTOR', 'PRACTICAL_HELP', e.programme_version_id, pa.lesson_ref, cl.lesson_id, i.ref, root)
  on conflict do nothing
  returning id into created;
  if created is null then
    select id into existing from public.academy_support_requests where schedule_item_id = root and role = 'LAB_INSTRUCTOR';
    return jsonb_build_object('ok', true, 'requestId', existing, 'resumed', true);
  end if;
  return jsonb_build_object('ok', true, 'requestId', created, 'resumed', false);
end $$;

create or replace function academy_private.support_admission(p_request_id uuid,
  out q public.academy_support_requests, out code text)
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user(); r record; e public.academy_enrolments%rowtype;
begin
  if actor is null or not public.has_role('STUDENT') then code := 'FORBIDDEN'; return; end if;
  select * into q from public.academy_support_requests where id = p_request_id and learner_id = actor;
  if q.id is null then code := 'NOT_FOUND_OR_FORBIDDEN'; return; end if;
  select * into r from academy_private.teaching_enrolment(q.enrolment_id, false);
  if r.code is not null then code := r.code; return; end if;
  e := r.e;
  if q.role = 'LAB_INSTRUCTOR' and academy_private.lab_graded(e.course_id, q.practical_key) then
    code := 'GRADED_PRACTICAL'; return;
  end if;
  if (q.role<>'LAB_INSTRUCTOR' or not academy_private.unified_enrolment(e.id)) and not academy_private.lesson_released(q.enrolment_id, q.lesson_ref) then code := 'NOT_RELEASED'; return; end if;
  if q.role='LAB_INSTRUCTOR' and academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id,'LAB',q.practical_key,q.schedule_item_id) then code:='WINDOW_CLOSED';return;end if;
  if q.role = 'LAB_INSTRUCTOR' and not exists (
      select 1 from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
      where s.enrolment_id = q.enrolment_id and s.superseded_at is null and i.kind = 'LAB' and i.ref = q.practical_key
        and i.starts_at <= clock_timestamp()
        and academy_private.root_schedule_item(i.id) = q.schedule_item_id) then
    code := 'NOT_RELEASED'; return;
  end if;
  if academy_private.exam_active() then code := 'ACTIVITY_BLOCKED'; return; end if;
end $$;

create or replace function public.submit_my_academy_lab(p_enrolment_id uuid, p_lab_ref text, p_body text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true);
  s public.academy_schedules%rowtype; item_start timestamptz; existing public.academy_lab_submissions%rowtype; new_id uuid;
begin
  if p_request_key is null or p_body is null or length(trim(p_body)) not between 1 and 20000 then raise exception 'INVALID_INPUT'; end if;
  select * into existing from public.academy_lab_submissions where enrolment_id = e.id and lab_ref = p_lab_ref;
  if found then
    if existing.request_key = p_request_key then return jsonb_build_object('ok', true, 'submissionId', existing.id, 'replayed', true); end if;
    return jsonb_build_object('ok', false, 'code', 'ALREADY_SUBMITTED');
  end if;
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  s := academy_private.current_schedule(e.id);
  select min(starts_at) into item_start from public.academy_schedule_items where schedule_id = s.id and kind = 'LAB' and ref = p_lab_ref;
  if item_start is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if academy_private.unified_enrolment(e.id) and not academy_private.unified_activity_open(e.id,'LAB',p_lab_ref) then return jsonb_build_object('ok',false,'code','WINDOW_CLOSED');end if;
  if clock_timestamp() < item_start then return jsonb_build_object('ok', false, 'code', 'LAB_NOT_OPEN', 'opensAt', item_start); end if;
  insert into public.academy_lab_submissions(enrolment_id, learner_id, lab_ref, body, request_key)
  values (e.id, e.learner_id, p_lab_ref, trim(p_body), p_request_key) returning id into new_id;
  return jsonb_build_object('ok', true, 'submissionId', new_id, 'replayed', false);
end $$;

create or replace function public.start_my_academy_assessment(p_enrolment_id uuid, p_assessment_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype;
  s public.academy_schedules%rowtype; item public.academy_schedule_items%rowtype; template jsonb;
  active public.academy_assessment_attempts%rowtype; used integer; attempt public.academy_assessment_attempts%rowtype;
  now_ts timestamptz; duration interval; actor uuid;
begin
  -- my_enrolment(.., true) takes the learner profile lock, then the
  -- enrolment lock: the same order as start_assessment_attempt.
  e := academy_private.my_enrolment(p_enrolment_id, true);
  actor := e.learner_id;
  now_ts := clock_timestamp();
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  -- Migration 021's content-release exclusion, preserved for Academy starts.
  perform public.expire_my_academic_content_releases();
  if exists(select 1 from public.academic_content_releases
    where student_id = actor and state = 'ACTIVE' and expires_at > now_ts) then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BUSY');
  end if;
  -- Finalise stale attempts in both systems before judging exclusivity.
  perform commercial_v1_private.finalize_expired_attempts_for_actor(actor, now_ts);
  for active in select * from public.academy_assessment_attempts where learner_id = actor and state = 'ACTIVE' loop
    perform academy_private.expire_if_due(active.id);
  end loop;
  if exists (select 1 from public.assessment_attempts where student_id = actor and state = 'ACTIVE' and expires_at > now_ts) then
    return jsonb_build_object('ok', false, 'code', 'ANOTHER_ASSESSMENT_ACTIVE');
  end if;
  select * into active from public.academy_assessment_attempts where learner_id = actor and state = 'ACTIVE';
  if found then
    if active.enrolment_id = e.id and active.assessment_ref = p_assessment_ref then
      return jsonb_build_object('ok', true, 'attemptId', active.id, 'resumed', true);
    end if;
    return jsonb_build_object('ok', false, 'code', 'ANOTHER_ASSESSMENT_ACTIVE');
  end if;
  s := academy_private.current_schedule(e.id);
  if s.id is null then return jsonb_build_object('ok', false, 'code', 'PLAN_REQUIRED'); end if;
  select * into item from public.academy_schedule_items where schedule_id = s.id and kind = 'ASSESSMENT' and ref = p_assessment_ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  template := academy_private.assessment_template(e.course_id, p_assessment_ref);
  duration := make_interval(mins => (template->>'durationMinutes')::integer);
  if academy_private.unified_enrolment(e.id) then
    select w.opens_at,w.closes_at into item.opens_at,item.closes_at from academy_private.unified_item_window(item.id) w;
  end if;
  if now_ts < item.opens_at then
    return jsonb_build_object('ok', false, 'code', 'SITTING_NOT_OPEN', 'opensAt', item.opens_at);
  end if;
  if now_ts + duration > item.closes_at then
    return jsonb_build_object('ok', false, 'code', 'SITTING_CLOSED', 'closesAt', item.closes_at);
  end if;
  select count(*) into used from public.academy_assessment_attempts where enrolment_id = e.id and assessment_ref = p_assessment_ref;
  if used >= (template->>'attemptsAllowed')::integer then return jsonb_build_object('ok', false, 'code', 'NO_ATTEMPTS_REMAINING'); end if;
  insert into public.academy_assessment_attempts(enrolment_id, learner_id, assessment_ref, attempt_number, schedule_item_id, started_at, expires_at)
  values (e.id, actor, p_assessment_ref, used + 1, item.id, now_ts, now_ts + duration) returning * into attempt;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_ASSESSMENT_STARTED', 'academy_assessment_attempts', attempt.id, 'ACADEMY_DELIVERY_V1', 'Learner started an assessment sitting.',
    jsonb_build_object('enrolment_id', e.id, 'assessment_ref', p_assessment_ref, 'attempt_number', used + 1));
  return jsonb_build_object('ok', true, 'attemptId', attempt.id, 'resumed', false);
end $$;

create or replace function public.get_my_academy_timetable(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
  s public.academy_schedules%rowtype; pkg jsonb; course public.academy_courses%rowtype; revoked boolean;
begin
  s := academy_private.current_schedule(e.id);
  select * into course from public.academy_courses where id = e.course_id;
  revoked := exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED');
  if s.id is null then
    return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'schedule', null, 'items', '[]'::jsonb, 'accessRevoked', revoked);
  end if;
  select raw_package into pkg from public.academy_course_packages where id = course.package_id;
  return jsonb_build_object('enrolmentId', e.id, 'title', course.title, 'status', e.status, 'serverTime', clock_timestamp(),
    'accessRevoked', revoked, 'examActive', academy_private.exam_active(),
    'schedule', jsonb_build_object('revision', s.revision, 'formatId', s.format_id, 'startOn', s.start_on, 'endOn', s.end_on,
      'studyDays', to_jsonb(s.study_days), 'localTime', to_char(s.local_time, 'HH24:MI'), 'timezone', s.timezone,
      'sessionMinutes', s.plan_summary->'sessionMinutes'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'sequence', i.sequence, 'kind', i.kind, 'ref', i.ref,
        'part', i.part, 'parts', i.parts, 'sessionIndex', i.session_index, 'localDate', i.local_date, 'startsAt', i.starts_at,
        'endsAt', i.ends_at, 'minutes', i.minutes, 'opensAt', case when academy_private.unified_enrolment(e.id) then (select opens_at from academy_private.unified_item_window(i.id)) else i.opens_at end, 'closesAt', case when academy_private.unified_enrolment(e.id) then (select closes_at from academy_private.unified_item_window(i.id)) else i.closes_at end, 'carried', i.carried_from is not null,
        'title', academy_private.unit_title(pkg, i.kind, i.ref),
        'attempts', case when i.kind = 'ASSESSMENT' then (select count(*) from public.academy_assessment_attempts a
            where a.enrolment_id = e.id and a.assessment_ref = i.ref) end,
        'labSubmitted', case when i.kind = 'LAB' then exists (select 1 from public.academy_lab_submissions l
            where l.enrolment_id = e.id and l.lab_ref = i.ref) end,
        'labGraded', case when i.kind = 'LAB' then academy_private.lab_graded(e.course_id, i.ref) end,
        'studied', case when i.kind = 'LESSON' then exists (select 1 from public.academy_lesson_progress lp
            where lp.enrolment_id = e.id and lp.lesson_ref = i.ref) end,
        'classOpened', case when i.kind = 'LESSON' then cr.id is not null end,
        'teachingTurns', case when i.kind = 'LESSON' then (select count(*) from public.academy_professor_classroom_turns t
            where t.classroom_id = cr.id) end) order by i.sequence), '[]')
      from public.academy_schedule_items i
      left join public.academy_professor_classrooms cr on cr.schedule_item_id = academy_private.root_schedule_item(i.id)
      where i.schedule_id = s.id));
end $$;

-- No result, progress or original schedule row is rewritten by recovery.
create function academy_private.recovery_eligible(e public.academy_enrolments,i public.academy_schedule_items) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from public.academy_assessment_attempts a where a.enrolment_id=e.id and a.assessment_ref=i.ref and i.kind='ASSESSMENT')
 and not exists(select 1 from public.academy_lab_submissions l where l.enrolment_id=e.id and l.lab_ref=i.ref and i.kind='LAB')
 and not exists(select 1 from public.academy_lesson_progress l where l.enrolment_id=e.id and l.lesson_ref=i.ref and i.kind='LESSON')
$$;
create function public.request_my_course_recovery(p_enrolment_id uuid,p_item_id uuid,p_opens_at timestamptz,p_reason_code text,p_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype:=academy_private.my_enrolment(p_enrolment_id,true);
 i public.academy_schedule_items%rowtype;r public.course_engine_recoveries%rowtype;root uuid;created uuid;
begin
 if not academy_private.unified_enrolment(e.id) or e.status<>'ACTIVE' then raise exception 'INVALID_STATE';end if;
 if p_request_key is null or p_reason_code is null or p_reason_code not in ('MISSED_WINDOW','TECHNICAL_ISSUE') or p_opens_at is null then raise exception 'INVALID_INPUT';end if;
 select * into i from public.academy_schedule_items where id=p_item_id and enrolment_id=e.id
   and schedule_id=(academy_private.current_schedule(e.id)).id;
 if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN';end if;
 root:=academy_private.root_schedule_item(i.id);
 select * into r from public.course_engine_recoveries where enrolment_id=e.id and request_key=p_request_key;
 if found then
  if r.root_item_id<>root or r.opens_at<>p_opens_at or r.reason_code<>p_reason_code then raise exception 'REQUEST_CONFLICT';end if;
  return jsonb_build_object('ok',true,'requestId',r.id,'state',r.state,'replayed',true);
 end if;
 if academy_private.exam_active() then raise exception 'ACTIVITY_BLOCKED';end if;
 if i.starts_at+interval '1439 minutes'>clock_timestamp() or not academy_private.recovery_eligible(e,i) then raise exception 'RECOVERY_NOT_ELIGIBLE';end if;
 if p_opens_at<clock_timestamp()+interval '5 minutes' or p_opens_at>clock_timestamp()+interval '7 days' then raise exception 'INVALID_RECOVERY_TIME';end if;
 if (select count(*) from public.course_engine_recoveries where enrolment_id=e.id and state='PENDING')>=10 then raise exception 'RECOVERY_LIMIT';end if;
 if exists(select 1 from public.course_engine_recoveries where enrolment_id=e.id and root_item_id=root and state in ('PENDING','APPROVED')) then raise exception 'RECOVERY_ALREADY_REQUESTED';end if;
 insert into public.course_engine_recoveries(enrolment_id,root_item_id,request_key,opens_at,reason_code)
 values(e.id,root,p_request_key,p_opens_at,p_reason_code) returning id into created;
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
 values(e.learner_id,'COURSE_RECOVERY_REQUESTED','course_engine_recoveries',created,'UNIFIED_RECOVERY_V1','Learner requested a missed activity recovery.',jsonb_build_object('enrolment_id',e.id,'item_id',root));
 return jsonb_build_object('ok',true,'requestId',created,'state','PENDING','replayed',false);
end $$;
create function public.review_course_recovery(p_request_id uuid,p_approve boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_course_admin();reason text:=academy_private.require_reason(p_reason);
 r public.course_engine_recoveries%rowtype;e public.academy_enrolments%rowtype;i public.academy_schedule_items%rowtype;
begin
 select * into r from public.course_engine_recoveries where id=p_request_id;
 if not found then raise exception 'NOT_FOUND';end if;
 select * into e from public.academy_enrolments where id=r.enrolment_id;
 -- Shared learner lock first; never recovery -> enrolment in the opposite order.
 perform 1 from public.student_profiles where user_id=e.learner_id for update;
 select * into e from public.academy_enrolments where id=r.enrolment_id for update;
 select * into r from public.course_engine_recoveries where id=p_request_id for update;
 if actor=e.learner_id or p_approve is null then raise exception 'FORBIDDEN';end if;
 if r.state<>'PENDING' then
  if (r.state='APPROVED') is distinct from p_approve then raise exception 'REQUEST_CONFLICT';end if;
  return jsonb_build_object('ok',true,'state',r.state,'replayed',true);
 end if;
 if p_approve then
  select * into i from public.academy_schedule_items where enrolment_id=e.id and schedule_id=(academy_private.current_schedule(e.id)).id
    and academy_private.root_schedule_item(id)=r.root_item_id;
  if not found or e.status<>'ACTIVE' or exists(select 1 from public.academy_entitlements where id=e.entitlement_id and state<>'ACTIVE')
    or not academy_private.recovery_eligible(e,i) then raise exception 'RECOVERY_NOT_ELIGIBLE';end if;
  if r.opens_at<clock_timestamp()+interval '5 minutes' then raise exception 'INVALID_RECOVERY_TIME';end if;
 end if;
 update public.course_engine_recoveries set state=case when p_approve then 'APPROVED' else 'DENIED' end,
  reviewed_by=actor,reviewed_at=clock_timestamp(),review_reason=reason where id=r.id;
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
 values(actor,'COURSE_RECOVERY_REVIEWED','course_engine_recoveries',r.id,'UNIFIED_RECOVERY_V1',reason,jsonb_build_object('approved',p_approve));
 return jsonb_build_object('ok',true,'state',case when p_approve then 'APPROVED' else 'DENIED' end,'replayed',false);
end $$;
create function public.list_my_course_recoveries(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype:=academy_private.my_enrolment_history(p_enrolment_id);
begin
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'itemId',r.root_item_id,'state',r.state,'opensAt',r.opens_at,
  'closesAt',r.opens_at+interval '1439 minutes','reasonCode',r.reason_code) order by r.requested_at desc)
 from (select * from public.course_engine_recoveries where enrolment_id=e.id order by requested_at desc limit 200) r),'[]');
end $$;
create function public.list_course_recoveries() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform academy_private.require_course_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'enrolmentId',r.enrolment_id,'itemId',r.root_item_id,
  'state',r.state,'opensAt',r.opens_at,'closesAt',r.opens_at+interval '1439 minutes','reasonCode',r.reason_code) order by r.requested_at)
 from (select * from public.course_engine_recoveries where state='PENDING' order by requested_at limit 100) r),'[]');
end $$;
create function public.get_my_unified_revision(p_enrolment_id uuid,p_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype:=academy_private.my_enrolment(p_enrolment_id,false);
 i public.academy_schedule_items%rowtype;spec jsonb;
begin
 select * into i from public.academy_schedule_items where id=p_item_id and enrolment_id=e.id and kind='REVISION'
 and schedule_id=(academy_private.current_schedule(e.id)).id;
 if not found or not academy_private.unified_activity_open(e.id,'REVISION',i.ref,academy_private.root_schedule_item(i.id)) then raise exception 'NOT_RELEASED';end if;
 if academy_private.exam_active() then raise exception 'ACTIVITY_BLOCKED';end if;
 select a into spec from public.academy_courses c join public.academy_course_packages p on p.id=c.package_id,
 jsonb_array_elements(p.raw_package->'curriculum'->'assessmentTemplates') a where c.id=e.course_id and a->>'key'=i.ref;
 return jsonb_build_object('title','Revision: '||coalesce(spec->>'title',i.ref),
 'objectives',coalesce((select jsonb_agg(jsonb_build_object('title',l.title,'description',o.description) order by cl.sequence,o.position)
 from public.academy_course_lessons cl join public.lessons l on l.id=cl.lesson_id join public.lesson_objectives o on o.lesson_id=cl.lesson_id where cl.course_id=e.course_id
 and exists(select 1 from public.academy_schedule_items taught where taught.schedule_id=i.schedule_id and taught.kind='LESSON' and taught.ref=cl.lesson_ref and taught.unit_index<i.unit_index)),'[]'));
end $$;
revoke all on function public.request_my_course_recovery(uuid,uuid,timestamptz,text,uuid),public.review_course_recovery(uuid,boolean,text),
 public.list_my_course_recoveries(uuid),public.list_course_recoveries(),public.get_my_unified_revision(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_my_course_recovery(uuid,uuid,timestamptz,text,uuid),public.review_course_recovery(uuid,boolean,text),
 public.list_my_course_recoveries(uuid),public.list_course_recoveries(),public.get_my_unified_revision(uuid,uuid) to authenticated;

create or replace function public.list_my_academy_enrolments() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'enrolmentId', e.id, 'courseId', c.id, 'title', c.title, 'status', e.status, 'formatId', e.format_id,
      'fixedFormatId', ent.format_id, 'offerSlug', o.slug, 'accessRevoked',ent.state='REVOKED',
      'formats', (select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
          'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days)
          order by academy_private.format_weeks(f.format_id)) from public.academy_offer_formats f where f.offer_id = o.id),
      'schedule', (select jsonb_build_object('revision', s.revision, 'startOn', s.start_on, 'endOn', s.end_on,
          'studyDays', to_jsonb(s.study_days), 'localTime', to_char(s.local_time, 'HH24:MI'), 'timezone', s.timezone)
        from public.academy_schedules s where s.enrolment_id = e.id and s.superseded_at is null),
      'completedAt', e.completed_at) order by e.created_at desc)
    from public.academy_enrolments e join public.academy_entitlements ent on ent.id = e.entitlement_id
    join public.academy_courses c on c.id = e.course_id join public.academy_offers o on o.course_id = c.id
    where e.learner_id = actor), '[]');
end $$;

do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='academy_private'::regnamespace loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
