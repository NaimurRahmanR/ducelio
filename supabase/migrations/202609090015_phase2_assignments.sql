-- Phase 2 checkpoint 10: governed coursework assignments and learner submissions.
-- Assignments are ordinary coursework, not controlled assessments. Submission alone does not create learning evidence or mastery.

alter table public.enrolments
  add constraint enrolments_assignment_identity
  unique(id, student_id, cohort_id, programme_version_id);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  lesson_id uuid not null,
  instructor_id uuid not null references public.staff_profiles(user_id),
  title text not null check(length(trim(title)) between 1 and 200),
  instructions text not null check(length(trim(instructions)) between 1 and 12000),
  opens_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'DRAFT' check(status in ('DRAFT','PUBLISHED','CLOSED')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  published_by uuid references public.app_users(id),
  published_at timestamptz,
  closed_by uuid references public.app_users(id),
  closed_at timestamptz,
  foreign key(cohort_id, programme_version_id)
    references public.cohorts(id, programme_version_id),
  foreign key(lesson_id, programme_version_id)
    references public.lessons(id, programme_version_id),
  unique(id, cohort_id, programme_version_id),
  check(due_at > opens_at),
  check(
    (status = 'DRAFT' and published_by is null and published_at is null and closed_by is null and closed_at is null)
    or
    (status = 'PUBLISHED' and published_by is not null and published_at is not null and closed_by is null and closed_at is null)
    or
    (status = 'CLOSED' and published_by is not null and published_at is not null and closed_by is not null and closed_at is not null)
  )
);

create index assignments_cohort_due
  on public.assignments(cohort_id, due_at);
create index assignments_instructor
  on public.assignments(instructor_id, status, due_at);

create table public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  enrolment_id uuid not null,
  student_id uuid not null,
  cohort_id uuid not null,
  programme_version_id uuid not null,
  attempt_number integer not null check(attempt_number > 0),
  body text not null check(length(trim(body)) between 1 and 20000),
  idempotency_key text not null unique check(length(trim(idempotency_key)) between 8 and 200),
  submitted_at timestamptz not null default now(),
  foreign key(assignment_id, cohort_id, programme_version_id)
    references public.assignments(id, cohort_id, programme_version_id),
  foreign key(enrolment_id, student_id, cohort_id, programme_version_id)
    references public.enrolments(id, student_id, cohort_id, programme_version_id),
  unique(assignment_id, enrolment_id, attempt_number)
);

create index assignment_submissions_student
  on public.assignment_submissions(student_id, submitted_at desc);
create index assignment_submissions_assignment
  on public.assignment_submissions(assignment_id, submitted_at desc);

create function public.guard_assignment_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Assignments cannot be deleted; close published coursework or correct a draft';
  end if;

  if NEW.cohort_id <> OLD.cohort_id
    or NEW.programme_version_id <> OLD.programme_version_id
    or NEW.lesson_id <> OLD.lesson_id
    or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at then
    raise exception 'Assignment identity and curriculum binding are immutable';
  end if;

  if OLD.status = 'DRAFT' and NEW.status = 'DRAFT' then
    return NEW;
  end if;

  if OLD.status = 'DRAFT' and NEW.status = 'PUBLISHED' then
    if NEW.title <> OLD.title
      or NEW.instructions <> OLD.instructions
      or NEW.opens_at <> OLD.opens_at
      or NEW.due_at <> OLD.due_at
      or NEW.instructor_id <> OLD.instructor_id then
      raise exception 'Publish an assignment without changing its draft content in the same transition';
    end if;
    return NEW;
  end if;

  if OLD.status = 'PUBLISHED' and NEW.status = 'CLOSED' then
    if NEW.title <> OLD.title
      or NEW.instructions <> OLD.instructions
      or NEW.opens_at <> OLD.opens_at
      or NEW.due_at <> OLD.due_at
      or NEW.instructor_id <> OLD.instructor_id
      or NEW.published_by <> OLD.published_by
      or NEW.published_at <> OLD.published_at then
      raise exception 'Published assignment content and publication history are immutable';
    end if;
    return NEW;
  end if;

  raise exception 'Invalid assignment lifecycle transition';
end $$;

revoke all on function public.guard_assignment_history() from public;
create trigger guard_assignment_history
before update or delete on public.assignments
for each row execute function public.guard_assignment_history();

create function public.guard_assignment_submission_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Assignment submissions are append-only; submit a new attempt instead';
end $$;

revoke all on function public.guard_assignment_submission_history() from public;
create trigger guard_assignment_submission_history
before update or delete on public.assignment_submissions
for each row execute function public.guard_assignment_submission_history();

create function public.can_read_assignment(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.assignments a
    where a.id = target
      and (
        public.is_academic_admin()
        or (
          public.has_role('INSTRUCTOR')
          and a.instructor_id = public.current_app_user()
        )
        or (
          a.status in ('PUBLISHED','CLOSED')
          and public.has_role('STUDENT')
          and exists(
            select 1
            from public.enrolments e
            where e.student_id = public.current_app_user()
              and e.cohort_id = a.cohort_id
              and e.programme_version_id = a.programme_version_id
          )
        )
      )
  )
$$;

revoke all on function public.can_read_assignment(uuid) from public;
grant execute on function public.can_read_assignment(uuid) to authenticated;

create function public.can_read_assignment_submission(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.assignment_submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.id = target
      and (
        s.student_id = public.current_app_user()
        or public.is_academic_admin()
        or (
          public.has_role('INSTRUCTOR')
          and a.instructor_id = public.current_app_user()
        )
      )
  )
$$;

revoke all on function public.can_read_assignment_submission(uuid) from public;
grant execute on function public.can_read_assignment_submission(uuid) to authenticated;

alter table public.assignments enable row level security;
revoke all on public.assignments from anon, authenticated;
grant select on public.assignments to authenticated;
create policy read_permitted on public.assignments
for select to authenticated using (public.can_read_assignment(id));

alter table public.assignment_submissions enable row level security;
revoke all on public.assignment_submissions from anon, authenticated;
grant select on public.assignment_submissions to authenticated;
create policy read_permitted on public.assignment_submissions
for select to authenticated using (public.can_read_assignment_submission(id));

create function public.audit_assignment_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then following := to_jsonb(NEW); end if;

  -- Coursework text may contain substantial academic or learner content. Keep audit metadata,
  -- not the full instructions/submission body.
  previous := previous - 'instructions' - 'body';
  following := following - 'instructions' - 'body';
  target := coalesce(following->>'id', previous->>'id')::uuid;

  insert into public.audit_events(
    actor_id, action, target_type, target_id, reason, before_state, after_state
  ) values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, target,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed assignment workflow'),
    previous, following
  );

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;

revoke all on function public.audit_assignment_change() from public;

create trigger audit_change
after insert or update or delete on public.assignments
for each row execute function public.audit_assignment_change();

create trigger audit_change
after insert or update or delete on public.assignment_submissions
for each row execute function public.audit_assignment_change();

create function public.create_assignment(
  p_cohort_id uuid,
  p_lesson_id uuid,
  p_instructor_id uuid,
  p_title text,
  p_instructions text,
  p_opens_at timestamptz,
  p_due_at timestamptz,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  cohort_version uuid;
  lesson_version uuid;
  version_status text;
  result_id uuid;
begin
  actor := public.current_app_user();
  if actor is null then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and p_instructor_id = actor)
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_title is null or length(trim(p_title)) not between 1 and 200 then
    raise exception 'A bounded assignment title is required';
  end if;
  if p_instructions is null or length(trim(p_instructions)) not between 1 and 12000 then
    raise exception 'Bounded assignment instructions are required';
  end if;
  if p_opens_at is null or p_due_at is null or p_due_at <= p_opens_at then
    raise exception 'Assignment due time must be after its opening time';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded assignment reason is required';
  end if;

  select c.programme_version_id, v.status
  into cohort_version, version_status
  from public.cohorts c
  join public.programme_versions v on v.id = c.programme_version_id
  where c.id = p_cohort_id
  for share of c, v;

  if not found then raise exception 'Cohort not found'; end if;
  if version_status <> 'PUBLISHED' then
    raise exception 'Assignments require a published programme version';
  end if;

  select l.programme_version_id into lesson_version
  from public.lessons l
  where l.id = p_lesson_id;

  if not found then raise exception 'Lesson not found'; end if;
  if lesson_version <> cohort_version then
    raise exception 'Assignment lesson must belong to the cohort programme version';
  end if;

  if not exists(
    select 1 from public.role_grants
    where user_id = p_instructor_id and role = 'INSTRUCTOR'
  ) then
    raise exception 'Assigned staff must have INSTRUCTOR role';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.assignments(
    cohort_id, programme_version_id, lesson_id, instructor_id,
    title, instructions, opens_at, due_at, created_by
  ) values (
    p_cohort_id, cohort_version, p_lesson_id, p_instructor_id,
    trim(p_title), trim(p_instructions), p_opens_at, p_due_at, actor
  ) returning id into result_id;

  return result_id;
end $$;

revoke all on function public.create_assignment(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text) from public;
grant execute on function public.create_assignment(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text) to authenticated;

create function public.update_draft_assignment(
  p_assignment_id uuid,
  p_title text,
  p_instructions text,
  p_opens_at timestamptz,
  p_due_at timestamptz,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assignment_record public.assignments%rowtype;
begin
  actor := public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;

  select * into assignment_record
  from public.assignments
  where id = p_assignment_id
  for update;

  if not found then raise exception 'Assignment not found'; end if;

  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and assignment_record.instructor_id = actor)
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if assignment_record.status <> 'DRAFT' then
    raise exception 'Only draft assignments can be corrected';
  end if;
  if p_title is null or length(trim(p_title)) not between 1 and 200 then
    raise exception 'A bounded assignment title is required';
  end if;
  if p_instructions is null or length(trim(p_instructions)) not between 1 and 12000 then
    raise exception 'Bounded assignment instructions are required';
  end if;
  if p_opens_at is null or p_due_at is null or p_due_at <= p_opens_at then
    raise exception 'Assignment due time must be after its opening time';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded assignment reason is required';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.assignments
  set title = trim(p_title),
      instructions = trim(p_instructions),
      opens_at = p_opens_at,
      due_at = p_due_at
  where id = p_assignment_id;

  return p_assignment_id;
end $$;

revoke all on function public.update_draft_assignment(uuid,text,text,timestamptz,timestamptz,text) from public;
grant execute on function public.update_draft_assignment(uuid,text,text,timestamptz,timestamptz,text) to authenticated;

create function public.change_assignment_status(
  p_assignment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assignment_record public.assignments%rowtype;
begin
  actor := public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;

  if p_status not in ('PUBLISHED','CLOSED') then
    raise exception 'Unsupported assignment status';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded assignment reason is required';
  end if;

  select * into assignment_record
  from public.assignments
  where id = p_assignment_id
  for update;

  if not found then raise exception 'Assignment not found'; end if;

  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and assignment_record.instructor_id = actor)
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  if assignment_record.status = 'DRAFT' and p_status = 'PUBLISHED' then
    update public.assignments
    set status = 'PUBLISHED', published_by = actor, published_at = clock_timestamp()
    where id = p_assignment_id;
  elsif assignment_record.status = 'PUBLISHED' and p_status = 'CLOSED' then
    update public.assignments
    set status = 'CLOSED', closed_by = actor, closed_at = clock_timestamp()
    where id = p_assignment_id;
  elsif assignment_record.status = p_status then
    return p_assignment_id;
  else
    raise exception 'Invalid assignment lifecycle transition';
  end if;

  return p_assignment_id;
end $$;

revoke all on function public.change_assignment_status(uuid,text,text) from public;
grant execute on function public.change_assignment_status(uuid,text,text) to authenticated;

create function public.submit_assignment(
  p_assignment_id uuid,
  p_body text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assignment_record public.assignments%rowtype;
  enrolment_record public.enrolments%rowtype;
  existing public.assignment_submissions%rowtype;
  next_attempt integer;
  result_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_body is null or length(trim(p_body)) not between 1 and 20000 then
    raise exception 'A bounded assignment response is required';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'A bounded idempotency key is required';
  end if;

  select * into assignment_record
  from public.assignments
  where id = p_assignment_id
  for share;

  if not found then raise exception 'Assignment not found'; end if;
  if assignment_record.status <> 'PUBLISHED' then
    raise exception 'Assignment is not open for submission';
  end if;
  if now() < assignment_record.opens_at then
    raise exception 'Assignment has not opened yet';
  end if;
  if now() > assignment_record.due_at then
    raise exception 'Assignment submission window has closed';
  end if;

  select * into enrolment_record
  from public.enrolments
  where student_id = actor
    and cohort_id = assignment_record.cohort_id
    and programme_version_id = assignment_record.programme_version_id
  for update;

  if not found then raise exception 'Matching learner enrolment not found'; end if;
  if enrolment_record.status <> 'ACTIVE' then
    raise exception 'Only an active enrolment can submit coursework';
  end if;

  select * into existing
  from public.assignment_submissions
  where idempotency_key = trim(p_idempotency_key);

  if found then
    if existing.assignment_id = p_assignment_id
      and existing.student_id = actor
      and existing.body = trim(p_body) then
      return existing.id;
    end if;
    raise exception 'Idempotency key is already bound to a different submission';
  end if;

  select coalesce(max(attempt_number), 0) + 1
  into next_attempt
  from public.assignment_submissions
  where assignment_id = p_assignment_id
    and enrolment_id = enrolment_record.id;

  perform set_config('app.audit_reason', 'Learner assignment submission', true);
  insert into public.assignment_submissions(
    assignment_id, enrolment_id, student_id, cohort_id, programme_version_id,
    attempt_number, body, idempotency_key, submitted_at
  ) values (
    p_assignment_id, enrolment_record.id, actor, assignment_record.cohort_id,
    assignment_record.programme_version_id, next_attempt, trim(p_body),
    trim(p_idempotency_key), clock_timestamp()
  ) returning id into result_id;

  return result_id;
end $$;

revoke all on function public.submit_assignment(uuid,text,text) from public;
grant execute on function public.submit_assignment(uuid,text,text) to authenticated;
