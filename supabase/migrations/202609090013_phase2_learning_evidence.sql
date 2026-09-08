-- Phase 2 checkpoint 8: deterministic learning-evidence collection.
-- Evidence is authoritative provenance for later mastery evaluation; it does not itself update mastery.

create table public.learning_evidence (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null,
  student_id uuid not null,
  objective_id uuid not null references public.lesson_objectives(id),
  lesson_id uuid not null,
  programme_version_id uuid not null,
  session_id uuid not null references public.class_sessions(id),
  evidence_kind text not null check(evidence_kind in ('CLASS_RESPONSE','RETRIEVAL_CHECK','PRACTICAL_TASK','DEBUGGING_TASK')),
  result text not null check(result in ('CORRECT','PARTIAL','INCORRECT')),
  evidence_reference text not null check(length(trim(evidence_reference)) between 1 and 300),
  idempotency_key text not null check(length(trim(idempotency_key)) between 8 and 200),
  recorded_by uuid not null references public.app_users(id),
  recorded_at timestamptz not null default now(),
  foreign key(enrolment_id, student_id)
    references public.enrolments(id, student_id),
  foreign key(lesson_id, programme_version_id)
    references public.lessons(id, programme_version_id),
  unique(idempotency_key)
);

create index learning_evidence_student_objective
  on public.learning_evidence(student_id, objective_id, recorded_at);
create index learning_evidence_session
  on public.learning_evidence(session_id, recorded_at);

create function public.guard_learning_evidence_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Learning evidence is append-only; submit a new evidence record instead';
end $$;

revoke all on function public.guard_learning_evidence_history() from public;
create trigger guard_learning_evidence_history
before update or delete on public.learning_evidence
for each row execute function public.guard_learning_evidence_history();

create function public.can_read_learning_evidence(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.learning_evidence e
    join public.class_sessions s on s.id = e.session_id
    where e.id = target
      and (
        e.student_id = public.current_app_user()
        or public.is_academic_admin()
        or (
          public.has_role('INSTRUCTOR')
          and s.instructor_id = public.current_app_user()
        )
      )
  )
$$;

revoke all on function public.can_read_learning_evidence(uuid) from public;
grant execute on function public.can_read_learning_evidence(uuid) to authenticated;

alter table public.learning_evidence enable row level security;
revoke all on public.learning_evidence from anon, authenticated;
grant select on public.learning_evidence to authenticated;
create policy read_permitted on public.learning_evidence
for select to authenticated using (public.can_read_learning_evidence(id));

create function public.record_learning_evidence(
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
  where id = p_enrolment_id;

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
    session_id, evidence_kind, result, evidence_reference, idempotency_key, recorded_by
  ) values (
    p_enrolment_id, enrolment_record.student_id, p_objective_id,
    session_record.lesson_id, session_record.programme_version_id,
    p_session_id, p_evidence_kind, p_result, trim(p_evidence_reference),
    trim(p_idempotency_key), actor
  ) returning id into result_id;

  return result_id;
end $$;

revoke all on function public.record_learning_evidence(uuid,uuid,uuid,text,text,text,text,text) from public;
grant execute on function public.record_learning_evidence(uuid,uuid,uuid,text,text,text,text,text) to authenticated;

create trigger audit_change
after insert or update or delete on public.learning_evidence
for each row execute function public.audit_institutional_change();
