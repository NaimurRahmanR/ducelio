-- Ducelio Academy (B2C), second checkpoint. Additive; migrations 001-060 are
-- unchanged. Every replaced function keeps its signature (CREATE OR REPLACE
-- keeps its reviewed ACL); every new function is granted explicitly below.
--
--  1. One student-level controlled-assessment admission across BOTH exam
--     systems. The existing authority is reused, not duplicated: the learner
--     profile row lock (taken first by start_assessment_attempt, every AI
--     content release and Tutor note write) now also serialises Academy
--     sitting starts, and current_academic_activity_state() /
--     academic_content_release_explain_allowed() -- which every Professor,
--     Tutor, Lab Instructor, handoff and note path consults -- now see an
--     active Academy attempt. A table guard stops an institutional attempt
--     from being inserted while an Academy attempt is active, and a unique
--     index allows one active Academy attempt per learner.
--  2. Authorised lesson release: lesson content opens only from the
--     learner's own scheduled session, never during an active controlled
--     assessment (either system), never after access is revoked.
--  3. Academic policy gate: a package's declared pendingDecisions keep its
--     offer REVIEW_ONLY (no public catalogue, no checkout, no completion
--     receipt). Public sale needs zero pending decisions, every graded lab
--     rubric present, and an explicit, audited owner-approval confirmation.
--  4. Academy checkout on the EXISTING commerce controller keys and Stripe
--     integration: learner-owned orders snapshot the approved per-format
--     price; fulfilment and refunds are HMAC-attested claims (purpose-
--     separated from the cohort claims); entitlements record the purchased
--     format; a verified full refund revokes access while history stays.
--  5. Objective evidence from database-scored attempts and recorded lab
--     marks, evaluated by MASTERY_V1's exact transition rule (migration
--     014), and learner-confirmed study progress, which never counts toward
--     mastery or completion.

-- ==========================================================================
-- Section 1: shared admission and firewall.
-- ==========================================================================
create unique index academy_assessment_attempts_one_active_per_learner
  on public.academy_assessment_attempts(learner_id) where state = 'ACTIVE';

create or replace function public.current_academic_activity_state() returns text
language sql stable security definer set search_path='' as $$
  select case when exists(
    select 1
    from public.assessment_attempts t
    join public.assessments a on a.id=t.assessment_id
    where t.student_id=public.current_app_user()
      and t.state='ACTIVE'
      and a.status='PUBLISHED'
      and now() between a.opens_at and a.closes_at
      and now()<=t.expires_at
  ) or exists(
    select 1 from public.academy_assessment_attempts x
    where x.learner_id=public.current_app_user() and x.state='ACTIVE' and now()<=x.expires_at
  ) then 'CONTROLLED_ASSESSMENT_ACTIVE' else 'NORMAL' end
$$;

create or replace function public.academic_content_release_explain_allowed() returns boolean
language sql security definer set search_path='' as $$
  select public.academic_action_allowed('EXPLAIN') and not exists(
    select 1 from public.assessment_attempts t join public.assessments a on a.id=t.assessment_id
    where t.student_id=public.current_app_user() and t.state='ACTIVE'
      and a.status='PUBLISHED' and t.expires_at>=clock_timestamp()
  ) and not exists(
    select 1 from public.academy_assessment_attempts x
    where x.learner_id=public.current_app_user() and x.state='ACTIVE' and x.expires_at>=clock_timestamp()
  )
$$;

-- The institutional start paths hold the learner profile lock before they
-- insert, so this check is serialised with Academy starts.
create function academy_private.guard_institutional_attempt() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.academy_assessment_attempts x
    where x.learner_id = new.student_id and x.state = 'ACTIVE' and x.expires_at > clock_timestamp()) then
    raise exception 'Another controlled assessment attempt is already active';
  end if;
  return new;
end $$;
create trigger guard_academy_exclusion before insert on public.assessment_attempts
for each row execute function academy_private.guard_institutional_attempt();

-- ==========================================================================
-- Section 2: tables for policy gating, commerce, evidence and progress.
-- ==========================================================================
alter table public.academy_offers
  add column sale_mode text not null default 'REVIEW_ONLY' check (sale_mode in ('REVIEW_ONLY','PUBLIC_SALE')),
  add column sale_approved_by uuid references public.app_users(id),
  add column sale_approved_at timestamptz,
  add column sale_approval_reason text check (sale_approval_reason is null or length(sale_approval_reason) between 5 and 300),
  add constraint academy_offers_sale_provenance check (
    (sale_mode = 'REVIEW_ONLY' and sale_approved_by is null and sale_approved_at is null and sale_approval_reason is null)
    or (sale_mode = 'PUBLIC_SALE' and sale_approved_by is not null and sale_approved_at is not null and sale_approval_reason is not null));

create table public.academy_orders (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.app_users(id),
  offer_id uuid not null references public.academy_offers(id),
  course_id uuid not null references public.academy_courses(id),
  format_id text not null check (academy_private.format_weeks(format_id) is not null),
  amount_minor integer not null check (amount_minor between 1 and 100000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null default 'STRIPE' check (provider = 'STRIPE'),
  provider_session_id text unique check (provider_session_id is null or length(provider_session_id) between 1 and 200),
  state text not null default 'PENDING' check (state in ('PENDING','FULFILLED')),
  created_at timestamptz not null default clock_timestamp(),
  fulfilled_at timestamptz,
  check ((state = 'PENDING') = (fulfilled_at is null))
);
create unique index academy_orders_one_pending on public.academy_orders(learner_id, course_id, format_id) where state = 'PENDING';

create table public.academy_checkout_replacements (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.academy_orders(id),
  expired_session_id text not null unique,
  replacement_session_id text not null unique,
  created_at timestamptz not null default clock_timestamp()
);

create table public.academy_payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.academy_orders(id),
  provider text not null check (provider = 'STRIPE'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  session_id text not null,
  amount_minor integer not null,
  currency text not null,
  status text not null check (status in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_event_id)
);

create table public.academy_order_refunds (
  order_id uuid primary key references public.academy_orders(id),
  charge_id text not null check (length(charge_id) between 1 and 200),
  event_id text not null check (length(event_id) between 1 and 200),
  amount_minor integer not null,
  currency text not null,
  verified_at timestamptz not null default clock_timestamp()
);

alter table public.academy_entitlements
  drop constraint academy_entitlements_source_check,
  add constraint academy_entitlements_source_check check (source in ('COMPLIMENTARY_GRANT','PURCHASE')),
  alter column granted_by drop not null,
  add column order_id uuid unique references public.academy_orders(id),
  add column state text not null default 'ACTIVE' check (state in ('ACTIVE','REVOKED')),
  add column revoked_at timestamptz,
  add column revocation_reason text,
  add constraint academy_entitlements_provenance check (
    (source = 'COMPLIMENTARY_GRANT' and granted_by is not null and order_id is null)
    or (source = 'PURCHASE' and granted_by is null and order_id is not null and format_id is not null)),
  add constraint academy_entitlements_revocation check (
    (state = 'ACTIVE' and revoked_at is null and revocation_reason is null)
    or (state = 'REVOKED' and revoked_at is not null and length(revocation_reason) between 5 and 300));

create table public.academy_objective_evidence (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references public.academy_enrolments(id),
  objective_id uuid not null references public.lesson_objectives(id),
  source_kind text not null check (source_kind in ('ASSESSMENT_ATTEMPT','LAB_MARK')),
  source_id uuid not null,
  evidence_kind text not null check (evidence_kind in ('RETRIEVAL_CHECK','PRACTICAL_TASK')),
  result text not null check (result in ('CORRECT','PARTIAL','INCORRECT')),
  marks integer not null check (marks >= 0),
  max_marks integer not null check (max_marks > 0 and marks <= max_marks),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (source_id, objective_id)
);
create table public.academy_objective_mastery (
  enrolment_id uuid not null references public.academy_enrolments(id),
  objective_id uuid not null references public.lesson_objectives(id),
  state text not null check (state in ('DEVELOPING','DEMONSTRATED','NEEDS_REINFORCEMENT')),
  evidence_count integer not null,
  correct_evidence_count integer not null,
  correct_session_count integer not null,
  correct_kind_count integer not null,
  last_evidence_id uuid not null references public.academy_objective_evidence(id),
  policy_version text not null check (policy_version = 'MASTERY_V1'),
  evaluated_at timestamptz not null default clock_timestamp(),
  primary key (enrolment_id, objective_id)
);
create table public.academy_objective_mastery_history (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  objective_id uuid not null,
  from_state text not null,
  to_state text not null,
  trigger_evidence_id uuid not null references public.academy_objective_evidence(id),
  correct_session_count integer not null,
  correct_kind_count integer not null,
  policy_version text not null,
  changed_at timestamptz not null default clock_timestamp()
);
-- Learner-confirmed study. Not evidence, not mastery, not completion.
create table public.academy_lesson_progress (
  enrolment_id uuid not null references public.academy_enrolments(id),
  lesson_ref text not null,
  confirmed_at timestamptz not null default clock_timestamp(),
  primary key (enrolment_id, lesson_ref)
);

create or replace function academy_private.guard_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'DELETE' then raise exception 'IMMUTABLE_HISTORY'; end if;
  if tg_table_name = 'academy_course_packages' then
    if new.id <> old.id or new.raw_package <> old.raw_package or new.content_hash <> old.content_hash
      or new.package_key <> old.package_key or new.package_revision <> old.package_revision
      or old.status in ('PUBLISHED','REJECTED')
      or (old.status = 'VALIDATED' and new.status not in ('PUBLISHED','REJECTED'))
      or (old.status = 'VALIDATED' and new.review is distinct from old.review) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_offers' then
    if new.id <> old.id or new.course_id <> old.course_id or new.slug <> old.slug or new.currency <> old.currency
      or new.summary is distinct from old.summary or old.state <> 'PUBLISHED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
    -- Exactly one change per update: archive, or REVIEW_ONLY -> PUBLIC_SALE.
    if not ((new.state = 'ARCHIVED' and new.sale_mode = old.sale_mode)
      or (new.state = 'PUBLISHED' and old.sale_mode = 'REVIEW_ONLY' and new.sale_mode = 'PUBLIC_SALE')) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_enrolments' then
    if new.id <> old.id or new.entitlement_id <> old.entitlement_id or new.learner_id <> old.learner_id
      or new.course_id <> old.course_id or new.programme_version_id <> old.programme_version_id
      or (old.format_id is not null and (new.format_id is distinct from old.format_id or new.format_locked_at is distinct from old.format_locked_at))
      or old.status = 'COMPLETED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_entitlements' then
    if (to_jsonb(new) - array['state','revoked_at','revocation_reason']) <> (to_jsonb(old) - array['state','revoked_at','revocation_reason'])
      or old.state <> 'ACTIVE' or new.state <> 'REVOKED' then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_orders' then
    if (to_jsonb(new) - array['provider_session_id','state','fulfilled_at']) <> (to_jsonb(old) - array['provider_session_id','state','fulfilled_at'])
      or old.state = 'FULFILLED'
      or (new.provider_session_id is distinct from old.provider_session_id and old.provider_session_id is not null
          and not exists (select 1 from public.academy_checkout_replacements r where r.order_id = old.id
            and r.expired_session_id = old.provider_session_id and r.replacement_session_id = new.provider_session_id)) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_objective_mastery' then
    if new.enrolment_id <> old.enrolment_id or new.objective_id <> old.objective_id then raise exception 'IMMUTABLE_HISTORY'; end if;
  elsif tg_table_name = 'academy_schedules' then
    if (to_jsonb(new) - 'superseded_at') <> (to_jsonb(old) - 'superseded_at') or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  elsif tg_table_name = 'academy_assessment_attempts' then
    if old.state <> 'ACTIVE' or (to_jsonb(new) - array['state','submitted_at','submission','score','max_score'])
        <> (to_jsonb(old) - array['state','submitted_at','submission','score','max_score']) then
      raise exception 'IMMUTABLE_HISTORY';
    end if;
  else
    raise exception 'IMMUTABLE_HISTORY';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['academy_orders','academy_checkout_replacements','academy_payment_events','academy_order_refunds',
    'academy_objective_evidence','academy_objective_mastery','academy_objective_mastery_history','academy_lesson_progress'] loop
    execute format('create trigger guard_history before update or delete on public.%I for each row execute function academy_private.guard_history()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ==========================================================================
-- Section 3: learner access. Revoked access closes content, scheduling,
-- sittings and submissions; enrolment history and results stay readable.
-- ==========================================================================
create or replace function academy_private.my_enrolment(p_enrolment_id uuid, p_lock boolean) returns public.academy_enrolments
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); e public.academy_enrolments%rowtype;
begin
  if p_lock then
    -- Shared lock order: the learner profile first (the controlled-
    -- assessment admission authority), then the enrolment.
    perform 1 from public.student_profiles where user_id = actor for update;
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor for update;
  else
    select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor;
  end if;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    raise exception 'ACCESS_REVOKED';
  end if;
  return e;
end $$;

create function academy_private.my_enrolment_history(p_enrolment_id uuid) returns public.academy_enrolments
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); e public.academy_enrolments%rowtype;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id and learner_id = actor;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  return e;
end $$;

create function academy_private.exam_active() returns boolean
language sql stable security definer set search_path='' as $$
  select public.current_academic_activity_state() = 'CONTROLLED_ASSESSMENT_ACTIVE'
    or not public.academic_content_release_explain_allowed()
$$;

-- A lesson is released from the start of its first scheduled session.
create function academy_private.lesson_released(p_enrolment_id uuid, p_lesson_ref text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists (select 1 from public.academy_schedules s join public.academy_schedule_items i on i.schedule_id = s.id
    where s.enrolment_id = p_enrolment_id and s.superseded_at is null and i.kind = 'LESSON' and i.ref = p_lesson_ref
      and i.part = 1 and i.starts_at <= clock_timestamp())
$$;

create function academy_private.pending_decisions(p_course_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(p.raw_package->'pendingDecisions', '[]'::jsonb)
  from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = p_course_id
$$;

create or replace function public.get_my_academy_lesson(p_enrolment_id uuid, p_lesson_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, false);
  cl public.academy_course_lessons%rowtype; pkg jsonb; lesson jsonb;
begin
  if (academy_private.current_schedule(e.id)).id is null then raise exception 'PLAN_REQUIRED'; end if;
  if academy_private.exam_active() then raise exception 'ACTIVITY_BLOCKED'; end if;
  select * into cl from public.academy_course_lessons where course_id = e.course_id and lesson_ref = p_lesson_ref;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if not academy_private.lesson_released(e.id, p_lesson_ref) then raise exception 'NOT_RELEASED'; end if;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = e.course_id;
  select o.lesson into lesson from academy_private.ordered_lessons(pkg->'curriculum') o where o.lesson_key = p_lesson_ref;
  return jsonb_build_object('lessonRef', p_lesson_ref, 'sequence', cl.sequence,
    'title', (select title from public.lessons where id = cl.lesson_id),
    'studied', exists (select 1 from public.academy_lesson_progress lp where lp.enrolment_id = e.id and lp.lesson_ref = p_lesson_ref),
    'objectives', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'description', o.description) order by o.position), '[]')
       from public.lesson_objectives o where o.lesson_id = cl.lesson_id),
    'resources', (select coalesce(jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'body', r.body, 'url', r.url) order by r.position), '[]')
       from public.learning_resources r where r.lesson_id = cl.lesson_id),
    'practicalActivities', (select coalesce(jsonb_agg(jsonb_build_object('ref', pa.value->>'key', 'kind', pa.value->>'kind',
        'title', pa.value->>'title', 'instructions', pa.value->>'instructions') order by (pa.value->>'position')::integer), '[]')
       from jsonb_array_elements(lesson->'practicalActivities') pa));
end $$;

create function public.record_my_academy_lesson_studied(p_enrolment_id uuid, p_lesson_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment(p_enrolment_id, true); inserted integer;
begin
  if e.status <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ENROLMENT_CLOSED'); end if;
  if academy_private.exam_active() then return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED'); end if;
  if not exists (select 1 from public.academy_course_lessons where course_id = e.course_id and lesson_ref = p_lesson_ref) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN');
  end if;
  if not academy_private.lesson_released(e.id, p_lesson_ref) then return jsonb_build_object('ok', false, 'code', 'NOT_RELEASED'); end if;
  insert into public.academy_lesson_progress(enrolment_id, lesson_ref) values (e.id, p_lesson_ref) on conflict do nothing;
  get diagnostics inserted = row_count;
  return jsonb_build_object('ok', true, 'replayed', inserted = 0);
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
        'endsAt', i.ends_at, 'minutes', i.minutes, 'opensAt', i.opens_at, 'closesAt', i.closes_at, 'carried', i.carried_from is not null,
        'title', academy_private.unit_title(pkg, i.kind, i.ref),
        'attempts', case when i.kind = 'ASSESSMENT' then (select count(*) from public.academy_assessment_attempts a
            where a.enrolment_id = e.id and a.assessment_ref = i.ref) end,
        'labSubmitted', case when i.kind = 'LAB' then exists (select 1 from public.academy_lab_submissions l
            where l.enrolment_id = e.id and l.lab_ref = i.ref) end,
        'studied', case when i.kind = 'LESSON' then exists (select 1 from public.academy_lesson_progress lp
            where lp.enrolment_id = e.id and lp.lesson_ref = i.ref) end) order by i.sequence), '[]')
      from public.academy_schedule_items i where i.schedule_id = s.id));
end $$;

-- ==========================================================================
-- Section 4: sittings under the shared admission authority.
-- ==========================================================================
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

create or replace function public.record_my_academy_response(p_attempt_id uuid, p_question_position integer, p_body text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype;
  q jsonb;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  select * into a from public.academy_assessment_attempts where id = p_attempt_id and learner_id = actor for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then raise exception 'INVALID_INPUT'; end if;
  if exists (select 1 from public.academy_assessment_responses where attempt_id = a.id and idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if a.state <> 'ACTIVE' then return jsonb_build_object('ok', false, 'code', 'ATTEMPT_CLOSED'); end if;
  if a.expires_at <= clock_timestamp() then
    perform academy_private.finalise_attempt(a.id, 'AUTO_TIMEOUT');
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  if exists (select 1 from public.academy_entitlements where id = e.entitlement_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  select value into q from jsonb_array_elements(academy_private.assessment_template(e.course_id, a.assessment_ref)->'questions')
  where (value->>'position')::integer = p_question_position;
  if q is null or not assessment_interaction_private.response_is_valid(q->>'questionType', q->'interaction', p_body) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESPONSE');
  end if;
  insert into public.academy_assessment_responses(attempt_id, question_position, body, idempotency_key)
  values (a.id, p_question_position, p_body, p_idempotency_key);
  return jsonb_build_object('ok', true, 'replayed', false);
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
  if clock_timestamp() < item_start then return jsonb_build_object('ok', false, 'code', 'LAB_NOT_OPEN', 'opensAt', item_start); end if;
  insert into public.academy_lab_submissions(enrolment_id, learner_id, lab_ref, body, request_key)
  values (e.id, e.learner_id, p_lab_ref, trim(p_body), p_request_key) returning id into new_id;
  return jsonb_build_object('ok', true, 'submissionId', new_id, 'replayed', false);
end $$;

-- ==========================================================================
-- Section 5: objective evidence and MASTERY_V1.
-- ==========================================================================
-- MASTERY_V1 (migration 014), the identical transition rule:
--  * after DEMONSTRATED/NEEDS_REINFORCEMENT, a non-CORRECT observation moves
--    to NEEDS_REINFORCEMENT;
--  * a CORRECT trigger with correct evidence from >= 2 distinct sessions and
--    >= 2 distinct evidence kinds is DEMONSTRATED;
--  * otherwise DEVELOPING.
-- An Academy "session" is the distinct scored sitting or marked lab.
create function academy_private.mastery_v1_next_state(p_current text, p_trigger_result text, p_correct_sessions integer, p_correct_kinds integer)
returns text language sql immutable set search_path='' as $$
  select case
    when p_current in ('DEMONSTRATED','NEEDS_REINFORCEMENT') and p_trigger_result <> 'CORRECT' then 'NEEDS_REINFORCEMENT'
    when p_trigger_result = 'CORRECT' and p_correct_sessions >= 2 and p_correct_kinds >= 2 then 'DEMONSTRATED'
    else 'DEVELOPING' end
$$;

create function academy_private.apply_mastery(p_evidence_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare ev public.academy_objective_evidence%rowtype; cur public.academy_objective_mastery%rowtype; current_state text := 'NOT_STARTED';
  next_state text; total integer; correct integer; sessions integer; kinds integer;
begin
  select * into ev from public.academy_objective_evidence where id = p_evidence_id;
  select count(*)::integer, count(*) filter (where result = 'CORRECT')::integer,
    count(distinct source_id) filter (where result = 'CORRECT')::integer, count(distinct evidence_kind) filter (where result = 'CORRECT')::integer
  into total, correct, sessions, kinds
  from public.academy_objective_evidence where enrolment_id = ev.enrolment_id and objective_id = ev.objective_id
    and (recorded_at < ev.recorded_at or (recorded_at = ev.recorded_at and id <= ev.id));
  select * into cur from public.academy_objective_mastery where enrolment_id = ev.enrolment_id and objective_id = ev.objective_id for update;
  if found then current_state := cur.state; end if;
  next_state := academy_private.mastery_v1_next_state(current_state, ev.result, sessions, kinds);
  if cur.enrolment_id is null then
    insert into public.academy_objective_mastery(enrolment_id, objective_id, state, evidence_count, correct_evidence_count,
      correct_session_count, correct_kind_count, last_evidence_id, policy_version)
    values (ev.enrolment_id, ev.objective_id, next_state, total, correct, sessions, kinds, ev.id, 'MASTERY_V1');
  else
    update public.academy_objective_mastery set state = next_state, evidence_count = total, correct_evidence_count = correct,
      correct_session_count = sessions, correct_kind_count = kinds, last_evidence_id = ev.id, evaluated_at = clock_timestamp()
    where enrolment_id = ev.enrolment_id and objective_id = ev.objective_id;
  end if;
  if cur.enrolment_id is null or current_state <> next_state then
    insert into public.academy_objective_mastery_history(enrolment_id, objective_id, from_state, to_state, trigger_evidence_id,
      correct_session_count, correct_kind_count, policy_version)
    values (ev.enrolment_id, ev.objective_id, current_state, next_state, ev.id, sessions, kinds, 'MASTERY_V1');
  end if;
end $$;

-- Package objective (lesson key + objective key) -> materialised objective.
create function academy_private.objective_id(p_course_id uuid, p_lesson_ref text, p_objective_key text) returns uuid
language sql stable security definer set search_path='' as $$
  select lo.id from public.academy_courses c
  join public.academy_course_packages p on p.id = c.package_id
  join public.academy_course_lessons cl on cl.course_id = c.id and cl.lesson_ref = p_lesson_ref
  join academy_private.ordered_lessons(p.raw_package->'curriculum') o on o.lesson_key = p_lesson_ref
  join lateral jsonb_array_elements(o.lesson->'objectives') ob on ob.value->>'key' = p_objective_key
  join public.lesson_objectives lo on lo.lesson_id = cl.lesson_id and lo.position = (ob.value->>'position')::integer
  where c.id = p_course_id
$$;

-- Evidence result: all marks CORRECT, some PARTIAL, none INCORRECT.
create function academy_private.record_evidence(p_enrolment_id uuid, p_objective_id uuid, p_source_kind text, p_source_id uuid,
  p_evidence_kind text, p_marks integer, p_max integer) returns void
language plpgsql security definer set search_path='' as $$
declare new_id uuid;
begin
  if p_objective_id is null or p_max <= 0 then return; end if;
  insert into public.academy_objective_evidence(enrolment_id, objective_id, source_kind, source_id, evidence_kind, result, marks, max_marks)
  values (p_enrolment_id, p_objective_id, p_source_kind, p_source_id, p_evidence_kind,
    case when p_marks >= p_max then 'CORRECT' when p_marks > 0 then 'PARTIAL' else 'INCORRECT' end, p_marks, p_max)
  on conflict (source_id, objective_id) do nothing returning id into new_id;
  if new_id is not null then perform academy_private.apply_mastery(new_id); end if;
end $$;

create or replace function academy_private.finalise_attempt(p_attempt_id uuid, p_submission text) returns public.academy_assessment_attempts
language plpgsql security definer set search_path='' as $$
declare a public.academy_assessment_attempts%rowtype; e public.academy_enrolments%rowtype; template jsonb; q jsonb; body text;
  marks integer; total integer := 0; max_total integer := 0; ref text; obj record;
begin
  select * into a from public.academy_assessment_attempts where id = p_attempt_id for update;
  if a.state = 'SUBMITTED' then return a; end if;
  select * into e from public.academy_enrolments where id = a.enrolment_id;
  template := academy_private.assessment_template(e.course_id, a.assessment_ref);
  for q in select value from jsonb_array_elements(template->'questions') order by (value->>'position')::integer loop
    select r.body into body from public.academy_assessment_responses r
    where r.attempt_id = a.id and r.question_position = (q->>'position')::integer
      and (p_submission = 'STUDENT_SUBMIT' or r.recorded_at <= a.expires_at)
    order by r.id desc limit 1;
    -- Migration 059's scorer: the only grading engine for objective types.
    marks := case when body is null then 0 else assessment_interaction_private.score_response(
      q->>'questionType', q->'interaction', q->'answerKey', (q->>'maxMarks')::integer, body) end;
    insert into public.academy_question_marks(attempt_id, question_position, marks, max_marks)
    values (a.id, (q->>'position')::integer, marks, (q->>'maxMarks')::integer);
    total := total + marks;
    max_total := max_total + (q->>'maxMarks')::integer;
  end loop;
  update public.academy_assessment_attempts
  set state = 'SUBMITTED', submitted_at = case when p_submission = 'AUTO_TIMEOUT' then a.expires_at else clock_timestamp() end,
      submission = p_submission, score = total, max_score = max_total
  where id = a.id returning * into a;
  -- One RETRIEVAL_CHECK observation per objective this sitting assessed.
  for obj in
    select coalesce(q.value->>'lessonRef', template->>'lessonRef') as lesson_ref, o.value #>> '{}' as objective_key,
      sum(m.marks)::integer as marks, sum(m.max_marks)::integer as max_marks
    from jsonb_array_elements(template->'questions') q
    cross join lateral jsonb_array_elements(q.value->'objectiveRefs') o
    join public.academy_question_marks m on m.attempt_id = a.id and m.question_position = (q.value->>'position')::integer
    group by 1, 2
  loop
    perform academy_private.record_evidence(e.id, academy_private.objective_id(e.course_id, obj.lesson_ref, obj.objective_key),
      'ASSESSMENT_ATTEMPT', a.id, 'RETRIEVAL_CHECK', obj.marks, obj.max_marks);
  end loop;
  perform academy_private.evaluate_completion(e.id);
  return a;
end $$;

create or replace function public.mark_academy_lab_submission(p_submission_id uuid, p_criterion_marks jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  s public.academy_lab_submissions%rowtype; e public.academy_enrolments%rowtype; spec jsonb; crit jsonb; total integer := 0; max_total integer := 0; v jsonb;
  lesson_ref text; objective_key text;
begin
  select * into s from public.academy_lab_submissions where id = p_submission_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if exists (select 1 from public.academy_lab_marks where submission_id = s.id) then raise exception 'ALREADY_MARKED'; end if;
  select * into e from public.academy_enrolments where id = s.enrolment_id;
  select lb.value into spec from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
    jsonb_array_elements(p.raw_package->'labs') lb where c.id = e.course_id and lb.value->>'activityRef' = s.lab_ref;
  if spec is null or not (spec->>'graded')::boolean or jsonb_typeof(p_criterion_marks) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
  -- No rubric means no approved marking basis: never invent one.
  if jsonb_array_length(spec->'rubric') = 0 or spec->>'markingGuidance' is null then raise exception 'RUBRIC_PENDING'; end if;
  if (select count(*) from jsonb_object_keys(p_criterion_marks)) <> jsonb_array_length(spec->'rubric') then raise exception 'INVALID_INPUT'; end if;
  for crit in select value from jsonb_array_elements(spec->'rubric') loop
    v := p_criterion_marks->(crit->>'key');
    if v is null or jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,3}$' or (v #>> '{}')::integer > (crit->>'maxMarks')::integer then
      raise exception 'INVALID_INPUT';
    end if;
    total := total + (v #>> '{}')::integer;
    max_total := max_total + (crit->>'maxMarks')::integer;
  end loop;
  insert into public.academy_lab_marks(submission_id, criterion_marks, marks, max_marks, marked_by, reason)
  values (s.id, p_criterion_marks, total, max_total, actor, reason);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_LAB_MARKED', 'academy_lab_submissions', s.id, 'ACADEMY_DELIVERY_V1', reason,
    jsonb_build_object('marks', total, 'max_marks', max_total));
  -- One PRACTICAL_TASK observation per objective the practical addresses.
  for lesson_ref, objective_key in
    select o.lesson_key, r.value #>> '{}' from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
      academy_private.ordered_lessons(p.raw_package->'curriculum') o, jsonb_array_elements(o.lesson->'practicalActivities') pa,
      jsonb_array_elements(pa.value->'objectiveRefs') r
    where c.id = e.course_id and pa.value->>'key' = s.lab_ref
  loop
    perform academy_private.record_evidence(e.id, academy_private.objective_id(e.course_id, lesson_ref, objective_key),
      'LAB_MARK', s.id, 'PRACTICAL_TASK', total, max_total);
  end loop;
  perform academy_private.evaluate_completion(e.id);
  return jsonb_build_object('ok', true, 'marks', total, 'maxMarks', max_total);
end $$;

-- An official completion is never recorded while academic policy for the
-- course (pass mark, workload, rubrics, ...) is still pending approval.
create or replace function academy_private.evaluate_completion(p_enrolment_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare r jsonb := academy_private.results(p_enrolment_id); e public.academy_enrolments%rowtype;
begin
  select * into e from public.academy_enrolments where id = p_enrolment_id;
  if jsonb_array_length(academy_private.pending_decisions(e.course_id)) > 0 then return; end if;
  if r->>'outcome' = 'PASSED' and not exists (select 1 from public.academy_completions where enrolment_id = p_enrolment_id) then
    insert into public.academy_completions(enrolment_id, course_score_bp, pass_mark_bp, component_scores)
    values (p_enrolment_id, (r->>'courseScoreBp')::integer, (r->>'passMarkBp')::integer, r->'components');
    update public.academy_enrolments set status = 'COMPLETED', completed_at = clock_timestamp() where id = p_enrolment_id;
  end if;
end $$;

create or replace function public.get_my_academy_results(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
begin
  return academy_private.results(e.id) || jsonb_build_object('enrolmentId', e.id, 'status', e.status,
    'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]') from jsonb_array_elements(academy_private.pending_decisions(e.course_id)) d),
    'completion', (select jsonb_build_object('completedAt', c.completed_at, 'courseScoreBp', c.course_score_bp)
                   from public.academy_completions c where c.enrolment_id = e.id));
end $$;

create function public.get_my_academy_progress(p_enrolment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.academy_enrolments%rowtype := academy_private.my_enrolment_history(p_enrolment_id);
begin
  return jsonb_build_object('enrolmentId', e.id,
    'lessons', (select count(*) from public.academy_course_lessons where course_id = e.course_id),
    'released', (select count(*) from public.academy_course_lessons cl where cl.course_id = e.course_id
                 and academy_private.lesson_released(e.id, cl.lesson_ref)),
    'studied', (select count(*) from public.academy_lesson_progress where enrolment_id = e.id),
    'objectives', (select coalesce(jsonb_agg(jsonb_build_object('objectiveId', lo.id, 'lessonRef', cl.lesson_ref,
        'description', lo.description, 'state', coalesce(m.state, 'NOT_STARTED'), 'evidence', coalesce(m.evidence_count, 0))
        order by cl.sequence, lo.position), '[]')
      from public.academy_course_lessons cl join public.lesson_objectives lo on lo.lesson_id = cl.lesson_id
      left join public.academy_objective_mastery m on m.enrolment_id = e.id and m.objective_id = lo.id
      where cl.course_id = e.course_id),
    'policyVersion', 'MASTERY_V1');
end $$;

-- ==========================================================================
-- Section 6: policy gate for public sale.
-- ==========================================================================
create or replace function public.list_academy_catalogue() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offerId', o.id, 'slug', o.slug, 'title', c.title, 'summary', o.summary, 'currency', o.currency,
    'description', p.raw_package->'course'->>'description',
    'qualificationPreparation', p.raw_package->'course'->'qualificationPreparation',
    'demoContent', (p.raw_package->'course'->>'demoContent')::boolean,
    'lessons', (select count(*) from public.academy_course_lessons l where l.course_id = c.id),
    'labs', jsonb_array_length(p.raw_package->'labs'),
    'assessments', jsonb_array_length(p.raw_package->'assessments'),
    'formats', (select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
        'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days,
        'amountMinor', f.price_amount_minor) order by academy_private.format_weeks(f.format_id))
      from public.academy_offer_formats f where f.offer_id = o.id)
  ) order by o.published_at desc), '[]')
  from public.academy_offers o join public.academy_courses c on c.id = o.course_id
  join public.academy_course_packages p on p.id = c.package_id
  where o.state = 'PUBLISHED' and o.sale_mode = 'PUBLIC_SALE'
$$;

create function public.enable_academy_public_sale(p_offer_id uuid, p_owner_approval_confirmed boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype; pending jsonb; pkg jsonb;
begin
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found or offer.state <> 'PUBLISHED' then raise exception 'NOT_FOUND'; end if;
  if offer.sale_mode = 'PUBLIC_SALE' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  pending := academy_private.pending_decisions(offer.course_id);
  if jsonb_array_length(pending) > 0 then
    return jsonb_build_object('ok', false, 'code', 'POLICY_PENDING',
      'pending', (select jsonb_agg(d->>'key') from jsonb_array_elements(pending) d));
  end if;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = offer.course_id;
  if exists (select 1 from jsonb_array_elements(pkg->'labs') lb where (lb.value->>'graded')::boolean
      and (jsonb_array_length(lb.value->'rubric') = 0 or lb.value->>'markingGuidance' is null)) then
    return jsonb_build_object('ok', false, 'code', 'RUBRIC_PENDING');
  end if;
  if p_owner_approval_confirmed is distinct from true then return jsonb_build_object('ok', false, 'code', 'APPROVAL_REQUIRED'); end if;
  update public.academy_offers set sale_mode = 'PUBLIC_SALE', sale_approved_by = actor, sale_approved_at = clock_timestamp(),
    sale_approval_reason = reason where id = offer.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_PUBLIC_SALE_APPROVED', 'academy_offers', offer.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('owner_approval_confirmed', true));
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

create or replace function public.list_academy_course_packages() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'packageKey', p.package_key, 'packageRevision', p.package_revision, 'status', p.status,
      'contentHash', p.content_hash, 'createdAt', p.created_at, 'validatedAt', p.validated_at,
      'publishedAt', p.published_at, 'rejectedReason', p.rejected_reason,
      'title', coalesce(p.review->>'title', left(p.raw_package->'curriculum'->'programme'->>'title', 200)),
      'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]') from jsonb_array_elements(coalesce(p.raw_package->'pendingDecisions', '[]')) d),
      'curriculumImport', (select jsonb_build_object('id', i.id, 'status', i.status, 'programmeVersionId', i.programme_version_id)
         from public.course_package_imports i
         where i.package_key = p.package_key and i.package_revision = p.package_revision
           and i.raw_package = p.raw_package->'curriculum'),
      'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state, 'saleMode', o.sale_mode)
         from public.academy_courses c left join public.academy_offers o on o.course_id = c.id where c.package_id = p.id)
    ) order by p.created_at desc)
    from (select * from public.academy_course_packages order by created_at desc limit 100) p), '[]');
end $$;

-- ==========================================================================
-- Section 7: checkout and paid access.
-- ==========================================================================
create function public.create_academy_order(p_offer_slug text, p_format_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); offer public.academy_offers%rowtype; fmt public.academy_offer_formats%rowtype;
  ent public.academy_entitlements%rowtype; existing public.academy_orders%rowtype; new_id uuid;
begin
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into offer from public.academy_offers where slug = p_offer_slug;
  if not found or offer.state <> 'PUBLISHED' then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if offer.sale_mode <> 'PUBLIC_SALE' then return jsonb_build_object('ok', false, 'code', 'SALE_NOT_OPEN'); end if;
  select * into fmt from public.academy_offer_formats where offer_id = offer.id and format_id = p_format_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_FORMAT'); end if;
  select * into ent from public.academy_entitlements where learner_id = actor and course_id = offer.course_id;
  if found then
    return jsonb_build_object('ok', false, 'code', case when ent.state = 'REVOKED' then 'ACCESS_REVOKED' else 'ALREADY_ENTITLED' end);
  end if;
  select * into existing from public.academy_orders where learner_id = actor and course_id = offer.course_id and format_id = p_format_id and state = 'PENDING';
  if found then
    return jsonb_build_object('ok', true, 'orderId', existing.id, 'amountMinor', existing.amount_minor, 'currency', existing.currency,
      'offerSlug', offer.slug, 'formatId', existing.format_id, 'reused', true);
  end if;
  insert into public.academy_orders(learner_id, offer_id, course_id, format_id, amount_minor, currency)
  values (actor, offer.id, offer.course_id, fmt.format_id, fmt.price_amount_minor, offer.currency) returning id into new_id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_ORDER_CREATED', 'academy_orders', new_id, 'ACADEMY_COMMERCE_V1', 'Learner started Academy checkout.',
    jsonb_build_object('offer_id', offer.id, 'format_id', fmt.format_id, 'amount_minor', fmt.price_amount_minor, 'currency', offer.currency));
  return jsonb_build_object('ok', true, 'orderId', new_id, 'amountMinor', fmt.price_amount_minor, 'currency', offer.currency,
    'offerSlug', offer.slug, 'formatId', fmt.format_id, 'reused', false);
end $$;

create function public.attach_academy_checkout_session(p_order_id uuid, p_session_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); o public.academy_orders%rowtype;
begin
  if p_session_id is null or length(p_session_id) not between 1 and 200 then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into o from public.academy_orders where id = p_order_id and learner_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if o.state <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if o.provider_session_id is not null then
    if o.provider_session_id = p_session_id then return jsonb_build_object('ok', true, 'orderId', o.id); end if;
    return jsonb_build_object('ok', false, 'code', 'SESSION_ALREADY_BOUND', 'existingSessionId', o.provider_session_id);
  end if;
  update public.academy_orders set provider_session_id = p_session_id where id = o.id;
  return jsonb_build_object('ok', true, 'orderId', o.id);
end $$;

create function public.get_my_academy_order(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := academy_private.require_student(); o public.academy_orders%rowtype; ent public.academy_entitlements%rowtype;
begin
  select * into o from public.academy_orders where id = p_order_id and learner_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into ent from public.academy_entitlements where learner_id = actor and course_id = o.course_id;
  return jsonb_build_object('ok', true, 'order', jsonb_build_object('id', o.id, 'state', o.state, 'amountMinor', o.amount_minor,
    'currency', o.currency, 'formatId', o.format_id, 'sessionId', o.provider_session_id,
    'offerSlug', (select slug from public.academy_offers where id = o.offer_id),
    'title', (select title from public.academy_courses where id = o.course_id),
    'orderRefunded', exists (select 1 from public.academy_order_refunds where order_id = o.id),
    'accessRevoked', coalesce(ent.state = 'REVOKED', false),
    'enrolmentId', (select id from public.academy_enrolments where entitlement_id = ent.id and ent.state = 'ACTIVE')));
end $$;

-- Purpose-separated from the cohort fulfilment claim, on the same controller
-- keys (commercial_v1_commerce_private.controller_keys).
create function academy_private.verify_claim(p_key_id uuid, p_canonical text, p_issued_at bigint, p_expires_at bigint, p_mac text, p_max_ttl integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; mismatch integer := 0; i integer; stamp numeric := extract(epoch from clock_timestamp());
begin
  if p_key_id is null or p_issued_at is null or p_issued_at > stamp + 30 or p_issued_at < stamp - 300
    or p_expires_at is null or p_expires_at <= p_issued_at or p_expires_at > p_issued_at + p_max_ttl or p_expires_at <= stamp
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from commercial_v1_commerce_private.controller_keys where id = p_key_id and revoked_at is null;
  if not found then return false; end if;
  expected := extensions.hmac(convert_to(p_canonical, 'UTF8'), key_bytes, 'sha256');
  supplied := decode(p_mac, 'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected, i) # get_byte(supplied, i)); end loop;
  return mismatch = 0;
end $$;

create function public.fulfill_academy_order(
  p_key_id uuid, p_order_id uuid, p_provider text, p_session_id text, p_event_id text,
  p_amount integer, p_currency text, p_status text, p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.academy_orders%rowtype; ent public.academy_entitlements%rowtype; enrolment uuid; version_id uuid;
begin
  if p_provider is distinct from 'STRIPE' or p_order_id is null or p_session_id is null or length(p_session_id) not between 1 and 200
    or p_event_id is null or length(p_event_id) not between 1 and 200 or p_amount is null or p_amount not between 1 and 100000000
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_status not in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')
    or not academy_private.verify_claim(p_key_id, concat_ws(E'\n', 'DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1', 'ACADEMY_COMMERCE_V1',
      p_key_id::text, p_provider, p_order_id::text, p_session_id, p_event_id, p_amount::text, p_currency, p_status,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac, 300) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  -- Lock order: the order, then the learner profile (as the cohort path).
  select * into o from public.academy_orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  perform 1 from public.student_profiles where user_id = o.learner_id for update;
  if exists (select 1 from public.academy_order_refunds where order_id = o.id) then return jsonb_build_object('ok', false, 'code', 'ORDER_REFUNDED'); end if;
  if exists (select 1 from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  if o.provider_session_id is null then
    update public.academy_orders set provider_session_id = p_session_id where id = o.id;
  elsif o.provider_session_id <> p_session_id then
    return jsonb_build_object('ok', false, 'code', 'MISMATCHED_SESSION');
  end if;
  if o.amount_minor <> p_amount then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_AMOUNT'); end if;
  if o.currency <> p_currency then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_CURRENCY'); end if;
  insert into public.academy_payment_events(order_id, provider, provider_event_id, session_id, amount_minor, currency, status)
  values (o.id, p_provider, p_event_id, p_session_id, p_amount, p_currency, p_status) on conflict (provider, provider_event_id) do nothing;
  if o.state = 'FULFILLED' then
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
    return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', true, 'orderId', o.id, 'entitlementId', ent.id,
      'enrolmentId', (select id from public.academy_enrolments where entitlement_id = ent.id));
  end if;
  if p_status <> 'PAID' then return jsonb_build_object('ok', true, 'fulfilled', false, 'code', 'NOT_PAID', 'orderId', o.id); end if;
  if not exists (select 1 from public.role_grants where user_id = o.learner_id and role = 'STUDENT') then
    return jsonb_build_object('ok', false, 'code', 'LEARNER_NOT_STUDENT');
  end if;
  insert into public.academy_entitlements(learner_id, offer_id, course_id, format_id, source, order_id, reason)
  values (o.learner_id, o.offer_id, o.course_id, o.format_id, 'PURCHASE', o.id, 'Verified Stripe payment')
  on conflict (learner_id, course_id) do nothing returning * into ent;
  if ent.id is null then
    -- A second payment for a course already held: never a second
    -- entitlement; reconciliation is a support decision (as for cohorts).
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
  else
    select programme_version_id into version_id from public.academy_courses where id = o.course_id;
    insert into public.academy_enrolments(entitlement_id, learner_id, course_id, programme_version_id)
    values (ent.id, o.learner_id, o.course_id, version_id);
  end if;
  update public.academy_orders set state = 'FULFILLED', fulfilled_at = clock_timestamp() where id = o.id;
  select id into enrolment from public.academy_enrolments where entitlement_id = ent.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (o.learner_id, 'ACADEMY_ORDER_FULFILLED', 'academy_orders', o.id, 'ACADEMY_COMMERCE_V1', 'Verified payment fulfilled',
    jsonb_build_object('entitlement_id', ent.id, 'enrolment_id', enrolment, 'format_id', o.format_id, 'amount_minor', p_amount,
      'currency', p_currency, 'duplicate', ent.order_id is distinct from o.id));
  return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', false, 'orderId', o.id, 'entitlementId', ent.id,
    'enrolmentId', enrolment, 'duplicate', ent.order_id is distinct from o.id);
end $$;

create function academy_private.revoke_entitlement(p_entitlement_id uuid, p_actor uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ent public.academy_entitlements%rowtype;
begin
  select * into ent from public.academy_entitlements where id = p_entitlement_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if ent.state = 'REVOKED' then return jsonb_build_object('ok', true, 'code', 'ALREADY_REVOKED'); end if;
  update public.academy_entitlements set state = 'REVOKED', revoked_at = clock_timestamp(), revocation_reason = p_reason where id = ent.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (p_actor, 'ACADEMY_ENTITLEMENT_REVOKED', 'academy_entitlements', ent.id, 'ACADEMY_COMMERCE_V1', p_reason,
    jsonb_build_object('source', ent.source, 'order_id', ent.order_id));
  return jsonb_build_object('ok', true, 'code', 'ACCESS_REVOKED');
end $$;

create function public.admin_revoke_academy_entitlement(p_entitlement_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); reason text := academy_private.require_reason(p_reason);
begin
  return academy_private.revoke_entitlement(p_entitlement_id, actor, reason);
end $$;

-- Signed operations (same transport as the cohort envelope, purpose-
-- separated): a verified full refund, and replacing an EXPIRED unpaid
-- checkout session (the LR-03 recovery) for the calling learner only.
create function public.apply_academy_commerce_operation(p_key_id uuid, p_payload text, p_issued_at bigint, p_expires_at bigint, p_mac text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare x jsonb; o public.academy_orders%rowtype; ent uuid; inserted integer; result jsonb;
begin
  if p_payload is null or octet_length(p_payload) > 4000 or not academy_private.verify_claim(p_key_id,
    concat_ws(E'\n', 'DUCELIO_ACADEMY_COMMERCE_OPERATIONS_HMAC_SHA256_V1', p_key_id::text, p_payload, p_issued_at::text, p_expires_at::text),
    p_issued_at, p_expires_at, p_mac, 60) then
    raise exception 'UNTRUSTED_CLAIM';
  end if;
  x := p_payload::jsonb;
  if x->>'kind' = 'REFUND' then
    select * into o from public.academy_orders where id = (x->>'orderId')::uuid for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
    if (o.provider_session_id is not null and o.provider_session_id is distinct from x->>'sessionId')
      or o.amount_minor is distinct from (x->>'amountMinor')::integer or o.currency is distinct from x->>'currency' then
      return jsonb_build_object('ok', false, 'code', 'REFUND_MISMATCH');
    end if;
    if (x->>'refundedMinor')::integer is distinct from o.amount_minor then return jsonb_build_object('ok', false, 'code', 'PARTIAL_REFUND_REVIEW'); end if;
    insert into public.academy_order_refunds(order_id, charge_id, event_id, amount_minor, currency)
    values (o.id, x->>'chargeId', x->>'eventId', o.amount_minor, o.currency) on conflict (order_id) do nothing;
    get diagnostics inserted = row_count;
    -- Only THIS payment's entitlement; never complimentary or other access.
    select id into ent from public.academy_entitlements where order_id = o.id;
    if ent is null then result := jsonb_build_object('ok', true, 'code', 'REFUNDED_NO_LINKED_ENTITLEMENT');
    else result := academy_private.revoke_entitlement(ent, null, 'Verified full Stripe refund'); end if;
    if inserted > 0 then
      insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
      values (null, 'ACADEMY_REFUND_RECONCILED', 'academy_orders', o.id, 'ACADEMY_COMMERCE_V1', 'Verified full Stripe refund', result);
    end if;
    return result;
  elsif x->>'kind' = 'CHECKOUT_REPLACEMENT' then
    if public.current_app_user() is distinct from (x->>'learnerId')::uuid then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    select * into o from public.academy_orders where id = (x->>'orderId')::uuid and learner_id = (x->>'learnerId')::uuid for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    if o.state <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
    if exists (select 1 from public.academy_checkout_replacements where expired_session_id = x->>'expiredSessionId'
      and replacement_session_id = x->>'replacementSessionId' and order_id = o.id) then
      return jsonb_build_object('ok', true, 'code', 'ALREADY_REPLACED');
    end if;
    if o.provider_session_id is distinct from x->>'expiredSessionId' then return jsonb_build_object('ok', false, 'code', 'SESSION_CHANGED'); end if;
    if (x->>'replacementSessionId') !~ '^cs_[A-Za-z0-9_]{1,197}$' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
    insert into public.academy_checkout_replacements(order_id, expired_session_id, replacement_session_id)
    values (o.id, x->>'expiredSessionId', x->>'replacementSessionId');
    update public.academy_orders set provider_session_id = x->>'replacementSessionId' where id = o.id;
    return jsonb_build_object('ok', true, 'code', 'REPLACED');
  end if;
  raise exception 'INVALID_OPERATION';
end $$;

-- ==========================================================================
-- Section 8: privileges, verified.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'academy_private' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('record_my_academy_lesson_studied','get_my_academy_progress',
      'enable_academy_public_sale','create_academy_order','attach_academy_checkout_session','get_my_academy_order',
      'fulfill_academy_order','admin_revoke_academy_entitlement','apply_academy_commerce_operation') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Like the cohort webhook fulfilment and operations envelope: reachable
  -- without a session, gated entirely by the controller MAC.
  grant execute on function public.fulfill_academy_order(uuid,uuid,text,text,text,integer,text,text,bigint,bigint,text) to anon;
  grant execute on function public.apply_academy_commerce_operation(uuid,text,bigint,bigint,text) to anon;
end $$;

do $$ declare r text; t record; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'academy\_%' loop
      if has_table_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe academy table privileges for %', r;
      end if;
    end loop;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'academy_private' or (n.nspname = 'public' and p.proname like '%academy%') loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        f.nspname = 'public' and (r = 'authenticated' or (r = 'anon' and f.proname in
          ('list_academy_catalogue','fulfill_academy_order','apply_academy_commerce_operation')))) then
        raise exception 'Unsafe academy function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
