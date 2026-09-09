-- Phase 2 checkpoint 9: deterministic objective mastery current state and immutable history.
-- Mastery is derived only from validated learning evidence. Navigation, elapsed time and progress do not participate.

alter table public.lesson_objectives
  add constraint lesson_objectives_identity_version
  unique(id, lesson_id, programme_version_id);

create table public.objective_mastery (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  student_id uuid not null,
  objective_id uuid not null,
  lesson_id uuid not null,
  programme_version_id uuid not null,
  state text not null check(state in ('NOT_STARTED','DEVELOPING','DEMONSTRATED','NEEDS_REINFORCEMENT')),
  evidence_count integer not null check(evidence_count >= 0),
  correct_evidence_count integer not null check(correct_evidence_count >= 0),
  correct_session_count integer not null check(correct_session_count >= 0),
  correct_kind_count integer not null check(correct_kind_count >= 0),
  last_evidence_id uuid not null references public.learning_evidence(id),
  policy_version text not null,
  evaluated_by uuid references public.app_users(id),
  evaluated_at timestamptz not null default now(),
  foreign key(enrolment_id, student_id)
    references public.enrolments(id, student_id),
  foreign key(objective_id, lesson_id, programme_version_id)
    references public.lesson_objectives(id, lesson_id, programme_version_id),
  unique(enrolment_id, objective_id)
);

create index objective_mastery_student
  on public.objective_mastery(student_id, programme_version_id, lesson_id);

create table public.objective_mastery_history (
  id uuid primary key default gen_random_uuid(),
  mastery_id uuid not null references public.objective_mastery(id),
  enrolment_id uuid not null,
  student_id uuid not null,
  objective_id uuid not null,
  from_state text not null check(from_state in ('NOT_STARTED','DEVELOPING','DEMONSTRATED','NEEDS_REINFORCEMENT')),
  to_state text not null check(to_state in ('NOT_STARTED','DEVELOPING','DEMONSTRATED','NEEDS_REINFORCEMENT')),
  trigger_evidence_id uuid not null references public.learning_evidence(id),
  evidence_count integer not null check(evidence_count >= 0),
  correct_evidence_count integer not null check(correct_evidence_count >= 0),
  correct_session_count integer not null check(correct_session_count >= 0),
  correct_kind_count integer not null check(correct_kind_count >= 0),
  policy_version text not null,
  evaluated_by uuid references public.app_users(id),
  changed_at timestamptz not null default now()
);

create index objective_mastery_history_objective
  on public.objective_mastery_history(enrolment_id, objective_id, changed_at);

create function public.guard_objective_mastery_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Objective mastery current state cannot be deleted';
  end if;

  if NEW.enrolment_id <> OLD.enrolment_id
    or NEW.student_id <> OLD.student_id
    or NEW.objective_id <> OLD.objective_id
    or NEW.lesson_id <> OLD.lesson_id
    or NEW.programme_version_id <> OLD.programme_version_id then
    raise exception 'Objective mastery identity is immutable';
  end if;

  return NEW;
end $$;

revoke all on function public.guard_objective_mastery_history() from public;
create trigger guard_objective_mastery_history
before update or delete on public.objective_mastery
for each row execute function public.guard_objective_mastery_history();

create function public.guard_mastery_transition_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Objective mastery transition history is append-only';
end $$;

revoke all on function public.guard_mastery_transition_history() from public;
create trigger guard_mastery_transition_history
before update or delete on public.objective_mastery_history
for each row execute function public.guard_mastery_transition_history();

create function public.can_read_objective_mastery(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.objective_mastery m
    where m.id = target
      and (
        public.can_read_student(m.student_id)
        or (
          public.has_role('INSTRUCTOR')
          and exists(
            select 1
            from public.enrolments e
            join public.class_sessions s
              on s.cohort_id = e.cohort_id
             and s.programme_version_id = e.programme_version_id
            where e.id = m.enrolment_id
              and s.instructor_id = public.current_app_user()
          )
        )
      )
  )
$$;

revoke all on function public.can_read_objective_mastery(uuid) from public;
grant execute on function public.can_read_objective_mastery(uuid) to authenticated;

create function public.can_read_objective_mastery_history(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.objective_mastery_history h
    join public.objective_mastery m on m.id = h.mastery_id
    where h.id = target and public.can_read_objective_mastery(m.id)
  )
$$;

revoke all on function public.can_read_objective_mastery_history(uuid) from public;
grant execute on function public.can_read_objective_mastery_history(uuid) to authenticated;

alter table public.objective_mastery enable row level security;
revoke all on public.objective_mastery from anon, authenticated;
grant select on public.objective_mastery to authenticated;
create policy read_permitted on public.objective_mastery
for select to authenticated using (public.can_read_objective_mastery(id));

alter table public.objective_mastery_history enable row level security;
revoke all on public.objective_mastery_history from anon, authenticated;
grant select on public.objective_mastery_history to authenticated;
create policy read_permitted on public.objective_mastery_history
for select to authenticated using (public.can_read_objective_mastery_history(id));

-- Policy MASTERY_V1:
-- 1. first valid evidence moves NOT_STARTED -> DEVELOPING;
-- 2. DEMONSTRATED requires the triggering evidence to be CORRECT plus correct evidence
--    from at least two distinct class sessions and at least two distinct evidence kinds;
-- 3. after DEMONSTRATED, a PARTIAL or INCORRECT observation moves the objective to
--    NEEDS_REINFORCEMENT;
-- 4. a later CORRECT observation restores DEMONSTRATED once the diversity thresholds remain met.
create function public.apply_objective_mastery_policy(
  p_enrolment_id uuid,
  p_objective_id uuid,
  p_trigger_evidence_id uuid,
  p_actor uuid
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  trigger_record public.learning_evidence%rowtype;
  current_record public.objective_mastery%rowtype;
  current_state text := 'NOT_STARTED';
  next_state text;
  evidence_total integer;
  correct_total integer;
  correct_sessions integer;
  correct_kinds integer;
  mastery_id uuid;
begin
  select * into trigger_record
  from public.learning_evidence
  where id = p_trigger_evidence_id;

  if not found
    or trigger_record.enrolment_id <> p_enrolment_id
    or trigger_record.objective_id <> p_objective_id then
    raise exception 'Mastery evaluation requires matching validated learning evidence';
  end if;

  select
    count(*)::integer,
    count(*) filter(where e.result = 'CORRECT')::integer,
    count(distinct e.session_id) filter(where e.result = 'CORRECT')::integer,
    count(distinct e.evidence_kind) filter(where e.result = 'CORRECT')::integer
  into evidence_total, correct_total, correct_sessions, correct_kinds
  from public.learning_evidence e
  where e.enrolment_id = p_enrolment_id
    and e.objective_id = p_objective_id
    and (
      e.recorded_at < trigger_record.recorded_at
      or (e.recorded_at = trigger_record.recorded_at and e.id <= trigger_record.id)
    );

  select * into current_record
  from public.objective_mastery
  where enrolment_id = p_enrolment_id and objective_id = p_objective_id
  for update;

  if found then
    current_state := current_record.state;
  end if;

  if current_state in ('DEMONSTRATED','NEEDS_REINFORCEMENT')
    and trigger_record.result <> 'CORRECT' then
    next_state := 'NEEDS_REINFORCEMENT';
  elsif trigger_record.result = 'CORRECT'
    and correct_sessions >= 2
    and correct_kinds >= 2 then
    next_state := 'DEMONSTRATED';
  else
    next_state := 'DEVELOPING';
  end if;

  if current_record.id is null then
    insert into public.objective_mastery(
      enrolment_id, student_id, objective_id, lesson_id, programme_version_id,
      state, evidence_count, correct_evidence_count, correct_session_count,
      correct_kind_count, last_evidence_id, policy_version, evaluated_by, evaluated_at
    ) values (
      trigger_record.enrolment_id, trigger_record.student_id, trigger_record.objective_id,
      trigger_record.lesson_id, trigger_record.programme_version_id,
      next_state, evidence_total, correct_total, correct_sessions, correct_kinds,
      trigger_record.id, 'MASTERY_V1', p_actor, clock_timestamp()
    ) returning id into mastery_id;
  else
    mastery_id := current_record.id;
    update public.objective_mastery
    set state = next_state,
        evidence_count = evidence_total,
        correct_evidence_count = correct_total,
        correct_session_count = correct_sessions,
        correct_kind_count = correct_kinds,
        last_evidence_id = trigger_record.id,
        policy_version = 'MASTERY_V1',
        evaluated_by = p_actor,
        evaluated_at = clock_timestamp()
    where id = mastery_id;
  end if;

  if current_record.id is null or current_state <> next_state then
    insert into public.objective_mastery_history(
      mastery_id, enrolment_id, student_id, objective_id, from_state, to_state,
      trigger_evidence_id, evidence_count, correct_evidence_count,
      correct_session_count, correct_kind_count, policy_version, evaluated_by, changed_at
    ) values (
      mastery_id, trigger_record.enrolment_id, trigger_record.student_id,
      trigger_record.objective_id, current_state, next_state, trigger_record.id,
      evidence_total, correct_total, correct_sessions, correct_kinds,
      'MASTERY_V1', p_actor, clock_timestamp()
    );
  end if;

  return mastery_id;
end $$;

revoke all on function public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid) from public;

-- Replace the checkpoint-8 evidence service so evidence validation, evidence insert,
-- deterministic mastery evaluation, transition history and audit all share one transaction.
create or replace function public.record_learning_evidence(
  p_session_id uuid,
  p_enrolment_id uuid,
  p_objective_id uuid,
  p_evidence_kind text,
  p_result text,
  p_evidence_reference text,
  p_idempotency_key text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  session_record public.class_sessions%rowtype;
  enrolment_record public.enrolments%rowtype;
  objective_lesson uuid;
  objective_version uuid;
  result_id uuid;
  existing public.learning_evidence%rowtype;
begin
  actor := public.current_app_user();
  if actor is null then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_evidence_kind not in ('CLASS_RESPONSE','RETRIEVAL_CHECK','PRACTICAL_TASK','DEBUGGING_TASK') then
    raise exception 'Unsupported evidence kind';
  end if;

  if p_result not in ('CORRECT','PARTIAL','INCORRECT') then
    raise exception 'Unsupported evidence result';
  end if;

  if p_evidence_reference is null or length(trim(p_evidence_reference)) not between 1 and 300 then
    raise exception 'A bounded evidence reference is required';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'A bounded idempotency key is required';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded evidence reason is required';
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
    raise exception 'Learning evidence cannot be recorded for a cancelled class session';
  end if;

  if session_record.scheduled_start > now() then
    raise exception 'Learning evidence cannot be recorded before the class session starts';
  end if;

  select * into enrolment_record
  from public.enrolments
  where id = p_enrolment_id
  for update;

  if not found then
    raise exception 'Enrolment not found';
  end if;

  if enrolment_record.cohort_id <> session_record.cohort_id
    or enrolment_record.programme_version_id <> session_record.programme_version_id then
    raise exception 'Evidence enrolment must belong to the class session cohort and programme version';
  end if;

  select lesson_id, programme_version_id
  into objective_lesson, objective_version
  from public.lesson_objectives
  where id = p_objective_id;

  if not found then
    raise exception 'Learning objective not found';
  end if;

  if objective_lesson <> session_record.lesson_id
    or objective_version <> session_record.programme_version_id then
    raise exception 'Evidence objective must belong to the class session lesson and programme version';
  end if;

  select * into existing
  from public.learning_evidence
  where idempotency_key = trim(p_idempotency_key);

  if found then
    if existing.session_id = p_session_id
      and existing.enrolment_id = p_enrolment_id
      and existing.objective_id = p_objective_id
      and existing.evidence_kind = p_evidence_kind
      and existing.result = p_result
      and existing.evidence_reference = trim(p_evidence_reference) then
      return existing.id;
    end if;
    raise exception 'Idempotency key is already bound to different evidence';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  insert into public.learning_evidence(
    enrolment_id, student_id, objective_id, lesson_id, programme_version_id,
    session_id, evidence_kind, result, evidence_reference, idempotency_key,
    recorded_by, recorded_at
  ) values (
    p_enrolment_id, enrolment_record.student_id, p_objective_id,
    session_record.lesson_id, session_record.programme_version_id,
    p_session_id, p_evidence_kind, p_result, trim(p_evidence_reference),
    trim(p_idempotency_key), actor, clock_timestamp()
  ) returning id into result_id;

  perform public.apply_objective_mastery_policy(
    p_enrolment_id, p_objective_id, result_id, actor
  );

  return result_id;
end $$;

revoke all on function public.record_learning_evidence(uuid,uuid,uuid,text,text,text,text,text) from public;
grant execute on function public.record_learning_evidence(uuid,uuid,uuid,text,text,text,text,text) to authenticated;

-- Reconstruct current mastery deterministically if evidence already exists when this migration is applied.
do $$
declare
  evidence_record record;
begin
  for evidence_record in
    select id, enrolment_id, objective_id, recorded_by
    from public.learning_evidence
    order by recorded_at, id
  loop
    perform public.apply_objective_mastery_policy(
      evidence_record.enrolment_id,
      evidence_record.objective_id,
      evidence_record.id,
      evidence_record.recorded_by
    );
  end loop;
end $$;

create trigger audit_change
  after insert or update or delete on public.objective_mastery
  for each row execute function public.audit_institutional_change();

create trigger audit_change
  after insert or update or delete on public.objective_mastery_history
  for each row execute function public.audit_institutional_change();
