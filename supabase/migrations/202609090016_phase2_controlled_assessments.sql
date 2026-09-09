-- Phase 2 checkpoint 11: controlled assessment foundations.
-- Protected assessment content is released only from server-owned attempt state.
-- No prompt-only firewall, no automatic grading, and no AI actor integration.

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  lesson_id uuid not null,
  instructor_id uuid not null references public.staff_profiles(user_id),
  title text not null check(length(trim(title)) between 1 and 200),
  instructions text not null check(length(trim(instructions)) between 1 and 12000),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  duration_minutes integer not null check(duration_minutes between 1 and 360),
  attempts_allowed integer not null default 1 check(attempts_allowed between 1 and 5),
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
  check(closes_at > opens_at),
  check(
    (status='DRAFT' and published_by is null and published_at is null and closed_by is null and closed_at is null)
    or
    (status='PUBLISHED' and published_by is not null and published_at is not null and closed_by is null and closed_at is null)
    or
    (status='CLOSED' and published_by is not null and published_at is not null and closed_by is not null and closed_at is not null)
  )
);

create index assessments_cohort_window
  on public.assessments(cohort_id, opens_at, closes_at);
create index assessments_instructor_status
  on public.assessments(instructor_id, status, opens_at);

create table public.assessment_questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id),
  position integer not null check(position > 0),
  prompt text not null check(length(trim(prompt)) between 1 and 12000),
  max_marks integer not null check(max_marks between 1 and 100),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  unique(assessment_id, position),
  unique(id, assessment_id)
);

create table public.assessment_answer_keys (
  question_id uuid primary key references public.assessment_questions(id),
  expected_answer text not null check(length(trim(expected_answer)) between 1 and 12000),
  marking_guidance text check(marking_guidance is null or length(trim(marking_guidance)) between 1 and 12000),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now()
);

create table public.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null,
  enrolment_id uuid not null,
  student_id uuid not null,
  cohort_id uuid not null,
  programme_version_id uuid not null,
  attempt_number integer not null check(attempt_number > 0),
  state text not null default 'ACTIVE' check(state in ('ACTIVE','SUBMITTED','VOIDED')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references public.app_users(id),
  void_reason text check(void_reason is null or length(trim(void_reason)) between 5 and 300),
  foreign key(assessment_id, cohort_id, programme_version_id)
    references public.assessments(id, cohort_id, programme_version_id),
  foreign key(enrolment_id, student_id, cohort_id, programme_version_id)
    references public.enrolments(id, student_id, cohort_id, programme_version_id),
  unique(assessment_id, enrolment_id, attempt_number),
  check(expires_at > started_at),
  check(
    (state='ACTIVE' and submitted_at is null and voided_at is null and voided_by is null and void_reason is null)
    or
    (state='SUBMITTED' and submitted_at is not null and voided_at is null and voided_by is null and void_reason is null)
    or
    (state='VOIDED' and submitted_at is null and voided_at is not null and voided_by is not null and void_reason is not null)
  )
);

create unique index one_active_controlled_assessment_per_student
  on public.assessment_attempts(student_id) where state='ACTIVE';
create index assessment_attempts_student
  on public.assessment_attempts(student_id, started_at desc);
create index assessment_attempts_assessment
  on public.assessment_attempts(assessment_id, state, started_at desc);

create table public.assessment_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts(id),
  question_id uuid not null,
  assessment_id uuid not null,
  student_id uuid not null references public.student_profiles(user_id),
  revision_number integer not null check(revision_number > 0),
  body text not null check(length(trim(body)) between 1 and 20000),
  idempotency_key text not null unique check(length(trim(idempotency_key)) between 8 and 200),
  recorded_at timestamptz not null default now(),
  foreign key(question_id, assessment_id)
    references public.assessment_questions(id, assessment_id),
  unique(attempt_id, question_id, revision_number)
);

create index assessment_responses_attempt
  on public.assessment_responses(attempt_id, question_id, revision_number desc);
create index assessment_responses_student
  on public.assessment_responses(student_id, recorded_at desc);

create function public.guard_assessment_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Assessments cannot be deleted; close published assessments or correct a draft';
  end if;

  if NEW.cohort_id<>OLD.cohort_id
    or NEW.programme_version_id<>OLD.programme_version_id
    or NEW.lesson_id<>OLD.lesson_id
    or NEW.created_by<>OLD.created_by
    or NEW.created_at<>OLD.created_at then
    raise exception 'Assessment identity and curriculum binding are immutable';
  end if;

  if OLD.status='DRAFT' and NEW.status='DRAFT' then
    return NEW;
  end if;

  if OLD.status='DRAFT' and NEW.status='PUBLISHED' then
    if NEW.title<>OLD.title
      or NEW.instructions<>OLD.instructions
      or NEW.opens_at<>OLD.opens_at
      or NEW.closes_at<>OLD.closes_at
      or NEW.duration_minutes<>OLD.duration_minutes
      or NEW.attempts_allowed<>OLD.attempts_allowed
      or NEW.instructor_id<>OLD.instructor_id then
      raise exception 'Publish an assessment without changing its draft content in the same transition';
    end if;
    return NEW;
  end if;

  if OLD.status='PUBLISHED' and NEW.status='CLOSED' then
    if NEW.title<>OLD.title
      or NEW.instructions<>OLD.instructions
      or NEW.opens_at<>OLD.opens_at
      or NEW.closes_at<>OLD.closes_at
      or NEW.duration_minutes<>OLD.duration_minutes
      or NEW.attempts_allowed<>OLD.attempts_allowed
      or NEW.instructor_id<>OLD.instructor_id
      or NEW.published_by<>OLD.published_by
      or NEW.published_at<>OLD.published_at then
      raise exception 'Published assessment content and publication history are immutable';
    end if;
    return NEW;
  end if;

  raise exception 'Invalid assessment lifecycle transition';
end $$;

revoke all on function public.guard_assessment_history() from public;
create trigger guard_assessment_history
before update or delete on public.assessments
for each row execute function public.guard_assessment_history();

create function public.guard_assessment_question_history() returns trigger
language plpgsql set search_path='' as $$
declare
  parent_status text;
begin
  if TG_OP='DELETE' then
    select status into parent_status from public.assessments where id=OLD.assessment_id;
  else
    select status into parent_status from public.assessments where id=NEW.assessment_id;
  end if;

  if parent_status is distinct from 'DRAFT' then
    raise exception 'Published assessment questions are immutable';
  end if;

  return case when TG_OP='DELETE' then OLD else NEW end;
end $$;

revoke all on function public.guard_assessment_question_history() from public;
create trigger guard_assessment_question_history
before insert or update or delete on public.assessment_questions
for each row execute function public.guard_assessment_question_history();

create function public.guard_assessment_answer_key_history() returns trigger
language plpgsql set search_path='' as $$
declare
  parent_status text;
  question_id_value uuid;
begin
  question_id_value := case when TG_OP='DELETE' then OLD.question_id else NEW.question_id end;
  select a.status into parent_status
  from public.assessment_questions q
  join public.assessments a on a.id=q.assessment_id
  where q.id=question_id_value;

  if parent_status is distinct from 'DRAFT' then
    raise exception 'Published assessment answer keys are immutable';
  end if;

  return case when TG_OP='DELETE' then OLD else NEW end;
end $$;

revoke all on function public.guard_assessment_answer_key_history() from public;
create trigger guard_assessment_answer_key_history
before insert or update or delete on public.assessment_answer_keys
for each row execute function public.guard_assessment_answer_key_history();

create function public.guard_assessment_attempt_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Assessment attempts are immutable institutional history';
  end if;

  if NEW.assessment_id<>OLD.assessment_id
    or NEW.enrolment_id<>OLD.enrolment_id
    or NEW.student_id<>OLD.student_id
    or NEW.cohort_id<>OLD.cohort_id
    or NEW.programme_version_id<>OLD.programme_version_id
    or NEW.attempt_number<>OLD.attempt_number
    or NEW.started_at<>OLD.started_at
    or NEW.expires_at<>OLD.expires_at then
    raise exception 'Assessment attempt identity and timing are immutable';
  end if;

  if OLD.state='ACTIVE' and NEW.state in ('SUBMITTED','VOIDED') then
    return NEW;
  end if;
  if NEW is not distinct from OLD then return NEW; end if;
  raise exception 'Closed assessment attempts are immutable';
end $$;

revoke all on function public.guard_assessment_attempt_history() from public;
create trigger guard_assessment_attempt_history
before update or delete on public.assessment_attempts
for each row execute function public.guard_assessment_attempt_history();

create function public.guard_assessment_response_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Assessment responses are append-only revisions';
end $$;

revoke all on function public.guard_assessment_response_history() from public;
create trigger guard_assessment_response_history
before update or delete on public.assessment_responses
for each row execute function public.guard_assessment_response_history();

create function public.can_read_assessment(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.assessments a
    where a.id=target
      and (
        public.has_role('ACADEMIC_ADMIN')
        or public.has_role('PLATFORM_ADMIN')
        or (public.has_role('INSTRUCTOR') and a.instructor_id=public.current_app_user())
        or (
          a.status in ('PUBLISHED','CLOSED')
          and public.has_role('STUDENT')
          and exists(
            select 1 from public.enrolments e
            where e.student_id=public.current_app_user()
              and e.cohort_id=a.cohort_id
              and e.programme_version_id=a.programme_version_id
          )
        )
      )
  )
$$;

revoke all on function public.can_read_assessment(uuid) from public;
grant execute on function public.can_read_assessment(uuid) to authenticated;

create function public.can_read_assessment_attempt(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.assessment_attempts t
    join public.assessments a on a.id=t.assessment_id
    where t.id=target
      and (
        t.student_id=public.current_app_user()
        or public.has_role('ACADEMIC_ADMIN')
        or public.has_role('PLATFORM_ADMIN')
        or (public.has_role('INSTRUCTOR') and a.instructor_id=public.current_app_user())
      )
  )
$$;

revoke all on function public.can_read_assessment_attempt(uuid) from public;
grant execute on function public.can_read_assessment_attempt(uuid) to authenticated;

create function public.can_read_assessment_response(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.assessment_responses r
    join public.assessment_attempts t on t.id=r.attempt_id
    join public.assessments a on a.id=t.assessment_id
    where r.id=target
      and (
        r.student_id=public.current_app_user()
        or (
          t.state in ('SUBMITTED','VOIDED')
          and (
            public.has_role('ACADEMIC_ADMIN')
            or public.has_role('PLATFORM_ADMIN')
            or (public.has_role('INSTRUCTOR') and a.instructor_id=public.current_app_user())
          )
        )
      )
  )
$$;

revoke all on function public.can_read_assessment_response(uuid) from public;
grant execute on function public.can_read_assessment_response(uuid) to authenticated;

alter table public.assessments enable row level security;
revoke all on public.assessments from anon, authenticated;
grant select on public.assessments to authenticated;
create policy read_permitted on public.assessments
for select to authenticated using(public.can_read_assessment(id));

alter table public.assessment_questions enable row level security;
revoke all on public.assessment_questions from anon, authenticated;

alter table public.assessment_answer_keys enable row level security;
revoke all on public.assessment_answer_keys from anon, authenticated;

alter table public.assessment_attempts enable row level security;
revoke all on public.assessment_attempts from anon, authenticated;
grant select on public.assessment_attempts to authenticated;
create policy read_permitted on public.assessment_attempts
for select to authenticated using(public.can_read_assessment_attempt(id));

alter table public.assessment_responses enable row level security;
revoke all on public.assessment_responses from anon, authenticated;
grant select on public.assessment_responses to authenticated;
create policy read_permitted on public.assessment_responses
for select to authenticated using(public.can_read_assessment_response(id));

create function public.audit_assessment_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
begin
  if TG_OP<>'INSERT' then previous:=to_jsonb(OLD); end if;
  if TG_OP<>'DELETE' then following:=to_jsonb(NEW); end if;

  previous:=previous-'instructions'-'prompt'-'expected_answer'-'marking_guidance'-'body';
  following:=following-'instructions'-'prompt'-'expected_answer'-'marking_guidance'-'body';
  target:=coalesce(following->>'id',following->>'question_id',previous->>'id',previous->>'question_id')::uuid;

  insert into public.audit_events(actor_id,action,target_type,target_id,reason,before_state,after_state)
  values(
    public.current_app_user(),TG_OP,TG_TABLE_NAME,target,
    coalesce(nullif(current_setting('app.audit_reason',true),''),'Governed controlled assessment workflow'),
    previous,following
  );

  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;

revoke all on function public.audit_assessment_change() from public;

create trigger audit_change after insert or update or delete on public.assessments
for each row execute function public.audit_assessment_change();
create trigger audit_change after insert or update or delete on public.assessment_questions
for each row execute function public.audit_assessment_change();
create trigger audit_change after insert or update or delete on public.assessment_answer_keys
for each row execute function public.audit_assessment_change();
create trigger audit_change after insert or update or delete on public.assessment_attempts
for each row execute function public.audit_assessment_change();
create trigger audit_change after insert or update or delete on public.assessment_responses
for each row execute function public.audit_assessment_change();

create function public.create_assessment(
  p_cohort_id uuid,
  p_lesson_id uuid,
  p_instructor_id uuid,
  p_title text,
  p_instructions text,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_duration_minutes integer,
  p_attempts_allowed integer,
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
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and p_instructor_id=actor)
  ) then raise exception 'Access denied' using errcode='42501'; end if;

  if p_title is null or length(trim(p_title)) not between 1 and 200 then raise exception 'A bounded assessment title is required'; end if;
  if p_instructions is null or length(trim(p_instructions)) not between 1 and 12000 then raise exception 'Bounded assessment instructions are required'; end if;
  if p_opens_at is null or p_closes_at is null or p_closes_at<=p_opens_at then raise exception 'Assessment close time must be after its opening time'; end if;
  if p_duration_minutes not between 1 and 360 then raise exception 'Assessment duration must be between 1 and 360 minutes'; end if;
  if p_attempts_allowed not between 1 and 5 then raise exception 'Assessment attempts allowed must be between 1 and 5'; end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'A bounded assessment reason is required'; end if;

  select c.programme_version_id,v.status into cohort_version,version_status
  from public.cohorts c
  join public.programme_versions v on v.id=c.programme_version_id
  where c.id=p_cohort_id
  for share of c,v;
  if not found then raise exception 'Cohort not found'; end if;
  if version_status<>'PUBLISHED' then raise exception 'Assessments require a published programme version'; end if;

  select programme_version_id into lesson_version from public.lessons where id=p_lesson_id;
  if not found then raise exception 'Lesson not found'; end if;
  if lesson_version<>cohort_version then raise exception 'Assessment lesson must belong to the cohort programme version'; end if;
  if not exists(select 1 from public.role_grants where user_id=p_instructor_id and role='INSTRUCTOR') then raise exception 'Assigned staff must have INSTRUCTOR role'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.assessments(
    cohort_id,programme_version_id,lesson_id,instructor_id,title,instructions,
    opens_at,closes_at,duration_minutes,attempts_allowed,created_by
  ) values (
    p_cohort_id,cohort_version,p_lesson_id,p_instructor_id,trim(p_title),trim(p_instructions),
    p_opens_at,p_closes_at,p_duration_minutes,p_attempts_allowed,actor
  ) returning id into result_id;
  return result_id;
end $$;

revoke all on function public.create_assessment(uuid,uuid,uuid,text,text,timestamptz,timestamptz,integer,integer,text) from public;
grant execute on function public.create_assessment(uuid,uuid,uuid,text,text,timestamptz,timestamptz,integer,integer,text) to authenticated;

create function public.add_assessment_question(
  p_assessment_id uuid,
  p_position integer,
  p_prompt text,
  p_max_marks integer,
  p_expected_answer text,
  p_marking_guidance text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
  result_id uuid;
begin
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  select * into assessment_record from public.assessments where id=p_assessment_id for update;
  if not found then raise exception 'Assessment not found'; end if;
  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and assessment_record.instructor_id=actor)
  ) then raise exception 'Access denied' using errcode='42501'; end if;
  if assessment_record.status<>'DRAFT' then raise exception 'Questions can only be added to a draft assessment'; end if;
  if p_position is null or p_position<=0 then raise exception 'Question position must be positive'; end if;
  if p_prompt is null or length(trim(p_prompt)) not between 1 and 12000 then raise exception 'A bounded assessment prompt is required'; end if;
  if p_max_marks is null or p_max_marks not between 1 and 100 then raise exception 'Question marks must be between 1 and 100'; end if;
  if p_expected_answer is null or length(trim(p_expected_answer)) not between 1 and 12000 then raise exception 'A bounded protected answer key is required'; end if;
  if p_marking_guidance is not null and length(trim(p_marking_guidance)) not between 1 and 12000 then raise exception 'Marking guidance must be null or bounded'; end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'A bounded assessment reason is required'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.assessment_questions(assessment_id,position,prompt,max_marks,created_by)
  values(p_assessment_id,p_position,trim(p_prompt),p_max_marks,actor)
  returning id into result_id;
  insert into public.assessment_answer_keys(question_id,expected_answer,marking_guidance,created_by)
  values(result_id,trim(p_expected_answer),nullif(trim(p_marking_guidance),''),actor);
  return result_id;
end $$;

revoke all on function public.add_assessment_question(uuid,integer,text,integer,text,text,text) from public;
grant execute on function public.add_assessment_question(uuid,integer,text,integer,text,text,text) to authenticated;

create function public.change_assessment_status(
  p_assessment_id uuid,
  p_status text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  if p_status not in ('PUBLISHED','CLOSED') then raise exception 'Unsupported assessment status'; end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'A bounded assessment reason is required'; end if;

  select * into assessment_record from public.assessments where id=p_assessment_id for update;
  if not found then raise exception 'Assessment not found'; end if;
  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and assessment_record.instructor_id=actor)
  ) then raise exception 'Access denied' using errcode='42501'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  if assessment_record.status='DRAFT' and p_status='PUBLISHED' then
    if not exists(select 1 from public.assessment_questions q where q.assessment_id=p_assessment_id) then
      raise exception 'Assessment publication requires at least one protected question';
    end if;
    if exists(
      select 1 from public.assessment_questions q
      left join public.assessment_answer_keys k on k.question_id=q.id
      where q.assessment_id=p_assessment_id and k.question_id is null
    ) then raise exception 'Every assessment question requires a protected answer key'; end if;
    update public.assessments
    set status='PUBLISHED',published_by=actor,published_at=clock_timestamp()
    where id=p_assessment_id;
  elsif assessment_record.status='PUBLISHED' and p_status='CLOSED' then
    update public.assessments
    set status='CLOSED',closed_by=actor,closed_at=clock_timestamp()
    where id=p_assessment_id;
  elsif assessment_record.status=p_status then
    return p_assessment_id;
  else
    raise exception 'Invalid assessment lifecycle transition';
  end if;
  return p_assessment_id;
end $$;

revoke all on function public.change_assessment_status(uuid,text,text) from public;
grant execute on function public.change_assessment_status(uuid,text,text) to authenticated;

create function public.start_assessment_attempt(p_assessment_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
  enrolment_record public.enrolments%rowtype;
  existing_id uuid;
  nonvoid_count integer;
  next_attempt integer;
  result_id uuid;
  expiry timestamptz;
begin
  actor:=public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;

  select * into assessment_record from public.assessments where id=p_assessment_id for share;
  if not found then raise exception 'Assessment not found'; end if;
  if assessment_record.status<>'PUBLISHED' then raise exception 'Assessment is not available'; end if;
  if now()<assessment_record.opens_at then raise exception 'Assessment has not opened yet'; end if;
  if now()>assessment_record.closes_at then raise exception 'Assessment window has closed'; end if;

  select * into enrolment_record
  from public.enrolments
  where student_id=actor
    and cohort_id=assessment_record.cohort_id
    and programme_version_id=assessment_record.programme_version_id
  for update;
  if not found then raise exception 'Matching learner enrolment not found'; end if;
  if enrolment_record.status<>'ACTIVE' then raise exception 'Only an active enrolment can start a controlled assessment'; end if;

  select id into existing_id
  from public.assessment_attempts
  where student_id=actor and state='ACTIVE'
  for update;
  if found then
    if exists(select 1 from public.assessment_attempts where id=existing_id and assessment_id=p_assessment_id) then
      return existing_id;
    end if;
    raise exception 'Another controlled assessment attempt is already active';
  end if;

  select count(*)::integer,coalesce(max(attempt_number),0)+1
  into nonvoid_count,next_attempt
  from public.assessment_attempts
  where assessment_id=p_assessment_id
    and enrolment_id=enrolment_record.id
    and state<>'VOIDED';

  if nonvoid_count>=assessment_record.attempts_allowed then raise exception 'No assessment attempts remain'; end if;
  expiry:=least(assessment_record.closes_at,clock_timestamp()+(assessment_record.duration_minutes||' minutes')::interval);

  perform set_config('app.audit_reason','Learner started controlled assessment',true);
  insert into public.assessment_attempts(
    assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,
    attempt_number,state,started_at,expires_at
  ) values (
    p_assessment_id,enrolment_record.id,actor,assessment_record.cohort_id,
    assessment_record.programme_version_id,next_attempt,'ACTIVE',clock_timestamp(),expiry
  ) returning id into result_id;
  return result_id;
end $$;

revoke all on function public.start_assessment_attempt(uuid) from public;
grant execute on function public.start_assessment_attempt(uuid) to authenticated;

create function public.get_active_assessment_questions(p_assessment_id uuid)
returns table(id uuid,position integer,prompt text,max_marks integer)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  active_attempt public.assessment_attempts%rowtype;
  assessment_record public.assessments%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  select * into assessment_record from public.assessments where public.assessments.id=p_assessment_id;
  if not found or assessment_record.status<>'PUBLISHED' then raise exception 'Assessment content is not available'; end if;
  if now()<assessment_record.opens_at or now()>assessment_record.closes_at then raise exception 'Assessment content is outside the release window'; end if;

  select * into active_attempt
  from public.assessment_attempts t
  where t.assessment_id=p_assessment_id
    and t.student_id=actor
    and t.state='ACTIVE';
  if not found or now()>active_attempt.expires_at then raise exception 'Protected assessment content requires an active attempt'; end if;

  return query
  select q.id,q.position,q.prompt,q.max_marks
  from public.assessment_questions q
  where q.assessment_id=p_assessment_id
  order by q.position;
end $$;

revoke all on function public.get_active_assessment_questions(uuid) from public;
grant execute on function public.get_active_assessment_questions(uuid) to authenticated;

create function public.record_assessment_response(
  p_attempt_id uuid,
  p_question_id uuid,
  p_body text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
  assessment_record public.assessments%rowtype;
  existing public.assessment_responses%rowtype;
  next_revision integer;
  result_id uuid;
begin
  actor:=public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  if p_body is null or length(trim(p_body)) not between 1 and 20000 then raise exception 'A bounded assessment response is required'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then raise exception 'A bounded idempotency key is required'; end if;

  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found then raise exception 'Assessment attempt not found'; end if;
  if attempt_record.student_id<>actor then raise exception 'Access denied' using errcode='42501'; end if;
  if attempt_record.state<>'ACTIVE' then raise exception 'Assessment attempt is no longer active'; end if;
  if now()>attempt_record.expires_at then raise exception 'Assessment attempt has expired'; end if;

  select * into assessment_record from public.assessments where id=attempt_record.assessment_id;
  if assessment_record.status<>'PUBLISHED' or now()>assessment_record.closes_at then raise exception 'Assessment response window has closed'; end if;
  if not exists(select 1 from public.assessment_questions where id=p_question_id and assessment_id=attempt_record.assessment_id) then raise exception 'Question does not belong to this assessment attempt'; end if;

  select * into existing from public.assessment_responses where idempotency_key=trim(p_idempotency_key);
  if found then
    if existing.attempt_id=p_attempt_id and existing.question_id=p_question_id and existing.student_id=actor and existing.body=trim(p_body) then return existing.id; end if;
    raise exception 'Idempotency key is already bound to a different assessment response';
  end if;

  select coalesce(max(revision_number),0)+1 into next_revision
  from public.assessment_responses
  where attempt_id=p_attempt_id and question_id=p_question_id;

  perform set_config('app.audit_reason','Learner saved controlled assessment response',true);
  insert into public.assessment_responses(
    attempt_id,question_id,assessment_id,student_id,revision_number,body,idempotency_key,recorded_at
  ) values (
    p_attempt_id,p_question_id,attempt_record.assessment_id,actor,next_revision,trim(p_body),trim(p_idempotency_key),clock_timestamp()
  ) returning id into result_id;
  return result_id;
end $$;

revoke all on function public.record_assessment_response(uuid,uuid,text,text) from public;
grant execute on function public.record_assessment_response(uuid,uuid,text,text) to authenticated;

create function public.submit_assessment_attempt(p_attempt_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then raise exception 'Access denied' using errcode='42501'; end if;
  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found then raise exception 'Assessment attempt not found'; end if;
  if attempt_record.student_id<>actor then raise exception 'Access denied' using errcode='42501'; end if;
  if attempt_record.state='SUBMITTED' then return p_attempt_id; end if;
  if attempt_record.state<>'ACTIVE' then raise exception 'Assessment attempt cannot be submitted'; end if;

  perform set_config('app.audit_reason','Learner submitted controlled assessment',true);
  update public.assessment_attempts
  set state='SUBMITTED',submitted_at=clock_timestamp()
  where id=p_attempt_id;
  return p_attempt_id;
end $$;

revoke all on function public.submit_assessment_attempt(uuid) from public;
grant execute on function public.submit_assessment_attempt(uuid) to authenticated;

create function public.void_assessment_attempt(
  p_attempt_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  attempt_record public.assessment_attempts%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then raise exception 'Access denied' using errcode='42501'; end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'A bounded override reason is required'; end if;

  select * into attempt_record from public.assessment_attempts where id=p_attempt_id for update;
  if not found then raise exception 'Assessment attempt not found'; end if;
  if attempt_record.state='VOIDED' then return p_attempt_id; end if;
  if attempt_record.state<>'ACTIVE' then raise exception 'Only active assessment attempts can be voided'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  update public.assessment_attempts
  set state='VOIDED',voided_at=clock_timestamp(),voided_by=actor,void_reason=trim(p_reason)
  where id=p_attempt_id;
  return p_attempt_id;
end $$;

revoke all on function public.void_assessment_attempt(uuid,text) from public;
grant execute on function public.void_assessment_attempt(uuid,text) to authenticated;

create function public.current_academic_activity_state() returns text
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
  ) then 'CONTROLLED_ASSESSMENT_ACTIVE' else 'NORMAL' end
$$;

revoke all on function public.current_academic_activity_state() from public;
grant execute on function public.current_academic_activity_state() to authenticated;

create function public.academic_action_allowed(p_action text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare
  activity text;
begin
  if p_action not in (
    'EXPLAIN','HINT','CRITIQUE_ATTEMPT','GIVE_FINAL_ANSWER','GENERATE_SUBMISSION',
    'PRACTICE','EXAMINER_DELIVERY','COUNSELLOR_LOGISTICS'
  ) then
    return false;
  end if;

  activity:=public.current_academic_activity_state();
  if activity='CONTROLLED_ASSESSMENT_ACTIVE' then
    return p_action in ('EXAMINER_DELIVERY','COUNSELLOR_LOGISTICS');
  end if;
  return true;
end $$;

revoke all on function public.academic_action_allowed(text) from public;
grant execute on function public.academic_action_allowed(text) to authenticated;

create function public.assert_academic_action_allowed(p_action text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.academic_action_allowed(p_action) then
    raise exception 'Academic action is blocked by the current controlled activity firewall' using errcode='42501';
  end if;
  return true;
end $$;

revoke all on function public.assert_academic_action_allowed(text) from public;
grant execute on function public.assert_academic_action_allowed(text) to authenticated;

create function public.list_assessment_authoring_questions(p_assessment_id uuid)
returns table(id uuid,position integer,prompt text,max_marks integer)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  assessment_record public.assessments%rowtype;
begin
  actor:=public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode='42501'; end if;
  select * into assessment_record from public.assessments where public.assessments.id=p_assessment_id;
  if not found then raise exception 'Assessment not found'; end if;
  if not (
    public.has_role('ACADEMIC_ADMIN')
    or public.has_role('PLATFORM_ADMIN')
    or (public.has_role('INSTRUCTOR') and assessment_record.instructor_id=actor)
  ) then raise exception 'Access denied' using errcode='42501'; end if;

  return query
  select q.id,q.position,q.prompt,q.max_marks
  from public.assessment_questions q
  where q.assessment_id=p_assessment_id
  order by q.position;
end $$;

revoke all on function public.list_assessment_authoring_questions(uuid) from public;
grant execute on function public.list_assessment_authoring_questions(uuid) to authenticated;
