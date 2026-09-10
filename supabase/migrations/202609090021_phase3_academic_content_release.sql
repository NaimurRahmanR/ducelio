-- Phase 3 checkpoint 1D-A: release AUTHORIZATION, not proof of gateway/model execution.
-- These two RPCs are callable directly using an authenticated user's session.
create table public.academic_content_releases (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  invocation_id uuid not null,
  agent_profile text not null default 'PROFESSOR' check(agent_profile = 'PROFESSOR'),
  capability_name text not null check(capability_name in (
    'get_current_learner_context','get_lesson_context','get_lesson_objectives',
    'get_current_class_session','get_learning_resources',
    'get_permitted_learning_history','get_current_mastery_state'
  )),
  capability_contract_version text not null check(capability_contract_version = 'PROFESSOR_READ_V2'),
  state text not null check(state in ('ACTIVE','COMPLETED','ABORTED','EXPIRED','BLOCKED')),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  terminal_at timestamptz,
  unique(student_id, invocation_id),
  check(expires_at = started_at + interval '30 seconds'),
  check((state = 'ACTIVE' and terminal_at is null) or
        (state <> 'ACTIVE' and terminal_at is not null and terminal_at >= started_at)),
  check(state <> 'EXPIRED' or terminal_at = expires_at),
  check(state not in ('COMPLETED','ABORTED','BLOCKED') or terminal_at < expires_at)
);
create index academic_content_release_active on public.academic_content_releases(student_id, expires_at)
  where state = 'ACTIVE';
alter table public.academic_content_releases enable row level security;
-- No direct table access, including for multi-role students. Existing Platform
-- Admin audit_events visibility remains the institutional audit review surface.
revoke all on public.academic_content_releases from public, anon, authenticated;

create function public.guard_academic_content_release() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Release history cannot be deleted'; end if;
  if OLD.state <> 'ACTIVE' then raise exception 'Terminal release history is immutable'; end if;
  if row(NEW.id,NEW.student_id,NEW.invocation_id,NEW.agent_profile,NEW.capability_name,
         NEW.capability_contract_version,NEW.started_at,NEW.expires_at)
    is distinct from
     row(OLD.id,OLD.student_id,OLD.invocation_id,OLD.agent_profile,OLD.capability_name,
         OLD.capability_contract_version,OLD.started_at,OLD.expires_at) then
    raise exception 'Release identity is immutable';
  end if;
  if NEW.state not in ('COMPLETED','ABORTED','EXPIRED') then
    raise exception 'Invalid release transition';
  end if;
  return NEW;
end $$;
revoke all on function public.guard_academic_content_release() from public, anon, authenticated;
create trigger guard_release_history before update or delete on public.academic_content_releases
for each row execute function public.guard_academic_content_release();

create function public.audit_academic_content_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- Deliberate allowlist, independent of app.audit_reason and generic row JSON.
  -- COMPLETED means the owner closed the authorization, never that a model ran.
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id, 'CONTENT_RELEASE_' || NEW.state, 'academic_content_releases', NEW.id,
    'DATABASE', 'Academic content release authorization lifecycle',
    jsonb_build_object(
      'student_id',NEW.student_id,'agent_profile',NEW.agent_profile,
      'capability_name',NEW.capability_name,'capability_contract_version',NEW.capability_contract_version,
      'invocation_id',NEW.invocation_id,'release_id',NEW.id,'state',NEW.state,
      'started_at',NEW.started_at,'expires_at',NEW.expires_at,'terminal_at',NEW.terminal_at
    ), clock_timestamp());
  return NEW;
end $$;
revoke all on function public.audit_academic_content_release() from public, anon, authenticated;
create trigger audit_release_lifecycle after insert or update on public.academic_content_releases
for each row execute function public.audit_academic_content_release();

-- Private helpers: callers below must first lock the current learner profile.
create function public.expire_my_academic_content_releases() returns void
language sql security definer set search_path='' as $$
  update public.academic_content_releases set state='EXPIRED',terminal_at=expires_at
  where student_id=public.current_app_user() and state='ACTIVE' and expires_at<=clock_timestamp()
$$;
revoke all on function public.expire_my_academic_content_releases() from public, anon, authenticated;

create function public.academic_content_release_explain_allowed() returns boolean
language sql security definer set search_path='' as $$
  select public.academic_action_allowed('EXPLAIN') and not exists(
    -- Also check the live DB clock after lock acquisition. The existing firewall
    -- uses transaction-start now(), which can precede a wait across an opening.
    -- Conservatively deny any unexpired ACTIVE attempt on a published assessment.
    select 1 from public.assessment_attempts t join public.assessments a on a.id=t.assessment_id
    where t.student_id=public.current_app_user() and t.state='ACTIVE'
      and a.status='PUBLISHED' and t.expires_at>=clock_timestamp()
  )
$$;
revoke all on function public.academic_content_release_explain_allowed() from public, anon, authenticated;

create function public.begin_academic_content_release(
  p_invocation_id uuid, p_capability_name text, p_contract_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  release_id uuid;
  stamp timestamptz;
  allowed boolean;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if p_invocation_id is null or p_contract_version is distinct from 'PROFESSOR_READ_V2'
    or p_capability_name is null or p_capability_name not in (
      'get_current_learner_context','get_lesson_context','get_lesson_objectives',
      'get_current_class_session','get_learning_resources',
      'get_permitted_learning_history','get_current_mastery_state'
    ) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  perform public.expire_my_academic_content_releases();
  -- Invocation reuse never extends a lease or creates a second grant.
  if exists(select 1 from public.academic_content_releases where student_id=actor and invocation_id=p_invocation_id) then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  allowed := public.academic_content_release_explain_allowed();
  stamp := clock_timestamp();
  insert into public.academic_content_releases(
    student_id,invocation_id,capability_name,capability_contract_version,state,started_at,expires_at,terminal_at
  ) values(actor,p_invocation_id,p_capability_name,p_contract_version,
    case when allowed then 'ACTIVE' else 'BLOCKED' end, stamp, stamp+interval '30 seconds',
    case when allowed then null else stamp end) returning id into release_id;
  if not allowed then
    -- Structured denial commits BLOCKED and its audit event; RAISE would undo both.
    return jsonb_build_object('ok',false,'code','ACTIVITY_BLOCKED');
  end if;
  return jsonb_build_object('ok',true,'release_id',release_id,'student_id',actor,'invocation_id',p_invocation_id);
end $$;
revoke all on function public.begin_academic_content_release(uuid,text,text) from public, anon, authenticated;
grant execute on function public.begin_academic_content_release(uuid,text,text) to authenticated;

create function public.close_academic_content_release(p_release_id uuid, p_complete boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  release_record public.academic_content_releases%rowtype;
  terminal_state text;
  stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if p_complete is null then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  perform public.expire_my_academic_content_releases();
  select * into release_record from public.academic_content_releases where id=p_release_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if release_record.state <> 'ACTIVE' then
    return jsonb_build_object('ok',true,'state',release_record.state,'transitioned',false);
  end if;
  -- Role revocation still permits cleanup, but cannot complete a release.
  terminal_state := case when p_complete and public.has_role('STUDENT')
    and public.academic_content_release_explain_allowed() then 'COMPLETED' else 'ABORTED' end;
  stamp := clock_timestamp();
  if stamp >= release_record.expires_at then
    terminal_state := 'EXPIRED';
    stamp := release_record.expires_at;
  end if;
  update public.academic_content_releases set state=terminal_state,terminal_at=stamp where id=release_record.id;
  return jsonb_build_object('ok',true,'state',terminal_state,'transitioned',true);
end $$;
revoke all on function public.close_academic_content_release(uuid,boolean) from public, anon, authenticated;
grant execute on function public.close_academic_content_release(uuid,boolean) to authenticated;

-- The final Phase 2 start workflow is preserved below, with one exclusion check
-- inserted immediately after its existing learner lock.
create or replace function public.start_assessment_attempt(p_assessment_id uuid) returns uuid
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
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;

  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then raise exception 'Learner profile not found'; end if;

  perform public.expire_my_academic_content_releases();
  if exists(select 1 from public.academic_content_releases
    where student_id=actor and state='ACTIVE' and expires_at>clock_timestamp()) then
    raise exception 'Academic activity is busy. Retry shortly.' using errcode='42501';
  end if;

  perform set_config(
    'app.audit_reason',
    'Expired or closed controlled assessment finalised',
    true
  );
  update public.assessment_attempts t
  set state = 'SUBMITTED',
      submitted_at = least(clock_timestamp(), t.expires_at)
  from public.assessments a
  where t.assessment_id = a.id
    and t.student_id = actor
    and t.state = 'ACTIVE'
    and (
      t.expires_at < clock_timestamp()
      or a.status <> 'PUBLISHED'
    );

  select * into assessment_record
  from public.assessments
  where id = p_assessment_id
  for share;
  if not found then raise exception 'Assessment not found'; end if;
  if assessment_record.status <> 'PUBLISHED' then raise exception 'Assessment is not available'; end if;
  if now() < assessment_record.opens_at then raise exception 'Assessment has not opened yet'; end if;
  if now() > assessment_record.closes_at then raise exception 'Assessment window has closed'; end if;

  select * into enrolment_record
  from public.enrolments
  where student_id = actor
    and cohort_id = assessment_record.cohort_id
    and programme_version_id = assessment_record.programme_version_id
  for update;
  if not found then raise exception 'Matching learner enrolment not found'; end if;
  if enrolment_record.status <> 'ACTIVE' then
    raise exception 'Only an active enrolment can start a controlled assessment';
  end if;

  select id into existing_id
  from public.assessment_attempts
  where student_id = actor and state = 'ACTIVE'
  for update;
  if found then
    if exists(
      select 1 from public.assessment_attempts
      where id = existing_id and assessment_id = p_assessment_id
    ) then
      return existing_id;
    end if;
    raise exception 'Another controlled assessment attempt is already active';
  end if;

  select
    count(*) filter(where state <> 'VOIDED')::integer,
    coalesce(max(attempt_number), 0) + 1
  into nonvoid_count, next_attempt
  from public.assessment_attempts
  where assessment_id = p_assessment_id
    and enrolment_id = enrolment_record.id;

  if nonvoid_count >= assessment_record.attempts_allowed then
    raise exception 'No assessment attempts remain';
  end if;

  expiry := least(
    assessment_record.closes_at,
    clock_timestamp() + (assessment_record.duration_minutes || ' minutes')::interval
  );

  perform set_config('app.audit_reason', 'Learner started controlled assessment', true);
  insert into public.assessment_attempts(
    assessment_id, enrolment_id, student_id, cohort_id, programme_version_id,
    attempt_number, state, started_at, expires_at
  ) values (
    p_assessment_id, enrolment_record.id, actor, assessment_record.cohort_id,
    assessment_record.programme_version_id, next_attempt, 'ACTIVE',
    clock_timestamp(), expiry
  ) returning id into result_id;

  return result_id;
end $$;

revoke all on function public.start_assessment_attempt(uuid) from public;
grant execute on function public.start_assessment_attempt(uuid) to authenticated;
