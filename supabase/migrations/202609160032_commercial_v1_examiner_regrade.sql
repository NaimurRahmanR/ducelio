-- PR11B2: separate admin-authorized regrade claims. Initial grading is unchanged.
-- All result validity, objective derivation, remediation and completion authority
-- remain migration 030's. No old revision is ever updated or deleted.
create schema commercial_v1_regrade_private;
revoke all on schema commercial_v1_regrade_private from public,anon,authenticated,service_role;
create table public.commercial_v1_examiner_regrade_executions (
  id uuid primary key,
  actor_id uuid not null references public.app_users(id),
  source_result_revision_id uuid not null,
  source_revision_number integer not null check(source_revision_number>0),
  request_reason text not null check(length(request_reason) between 1 and 300 and request_reason=btrim(request_reason)),
  student_id uuid not null references public.student_profiles(user_id),
  enrolment_id uuid not null references public.enrolments(id),
  activation_id uuid not null references public.course_activations(id),
  capability text not null check(capability in ('regrade_controlled_assessment','regrade_practical_lab')),
  target_kind text not null check(target_kind in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')),
  attempt_id uuid references public.assessment_attempts(id),
  submission_id uuid references public.commercial_v1_lab_submissions(id),
  component text check(component in ('QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL')),
  practical_id uuid references public.course_practicals(id),
  policy_version text not null default 'COMMERCIAL_V1_EXAMINER_REGRADE_V1' check(policy_version='COMMERCIAL_V1_EXAMINER_REGRADE_V1'),
  execution_kind text not null default 'PROVIDER_BACKED_REGRADE_V1' check(execution_kind='PROVIDER_BACKED_REGRADE_V1'),
  runtime_profile_ref text not null default 'EXAMINER_COMMERCIAL_V1' check(runtime_profile_ref='EXAMINER_COMMERCIAL_V1'),
  state text not null check(state in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED')),
  reason_code text,
  budget_stage text check(budget_stage in ('PRE_CALL','POST_CALL')),
  created_at timestamptz not null,
  authorized_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz not null,
  max_provider_calls integer not null check(max_provider_calls=1),
  max_output_tokens integer not null check(max_output_tokens between 1 and 1200),
  max_estimated_cost_microusd bigint not null check(max_estimated_cost_microusd between 1 and 50000),
  review_path text check(review_path='ACADEMIC_REVIEW'),
  grade_digest text check(grade_digest is null or grade_digest ~ '^[0-9a-f]{64}$'),
  result_revision_id uuid,
  check((target_kind='ASSESSMENT_ATTEMPT')=(attempt_id is not null)),
  check((target_kind='ASSESSMENT_ATTEMPT')=(component is not null)),
  check((target_kind='LAB_SUBMISSION')=(submission_id is not null)),
  check((target_kind='LAB_SUBMISSION')=(practical_id is not null)),
  check((capability='regrade_controlled_assessment')=(target_kind='ASSESSMENT_ATTEMPT')),
  check((capability='regrade_practical_lab')=(target_kind='LAB_SUBMISSION')),
  check(expires_at>created_at and expires_at<=created_at+interval '20 seconds'),
  check(authorized_at is null or authorized_at=created_at),
  check(started_at is null or (started_at>=created_at and started_at<expires_at)),
  check(terminal_at is null or terminal_at>=coalesce(started_at,created_at)),
  check((state='SUCCEEDED')=(result_revision_id is not null)),
  check((state='SUCCEEDED')=(grade_digest is not null)),
  check(
    (state='AUTHORIZED' and enrolment_id is not null and activation_id is not null and authorized_at is not null
      and started_at is null and terminal_at is null and reason_code is null and budget_stage is null) or
    (state='RUNNING' and enrolment_id is not null and activation_id is not null and started_at is not null
      and terminal_at is null and reason_code is null and budget_stage is null) or
    (state='SUCCEEDED' and terminal_at is not null and reason_code='GRADED' and budget_stage is null) or
    (state='FAILED' and terminal_at is not null and budget_stage is null and reason_code in (
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
      'PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID','RESULT_INTEGRITY_FAILED',
      'EXECUTION_TIMEOUT','NO_PROVIDER_CONFIGURED')) or
    (state='ESCALATED' and terminal_at is not null and reason_code='HUMAN_REVIEW_REQUIRED' and budget_stage is null) or
    (state='BUDGET_BLOCKED' and terminal_at is not null and reason_code='BUDGET_BLOCKED' and budget_stage in ('PRE_CALL','POST_CALL')) or
    (state='TIMEOUT' and terminal_at is not null and reason_code='EXECUTION_TIMEOUT' and budget_stage is null) or
    (state='CANCELLED' and terminal_at is not null and reason_code='CANCELLED' and budget_stage is null)
  ),
  check((state='ESCALATED' and review_path is not null) or (state<>'ESCALATED' and review_path is null))
);
create unique index examiner_regrade_one_per_source on public.commercial_v1_examiner_regrade_executions(target_kind,source_result_revision_id);
create index examiner_regrade_admission on public.commercial_v1_examiner_regrade_executions(student_id,created_at);
create index examiner_regrade_active on public.commercial_v1_examiner_regrade_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.commercial_v1_examiner_regrade_executions enable row level security;
revoke all on public.commercial_v1_examiner_regrade_executions from public, anon, authenticated, service_role;

create table public.commercial_v1_examiner_regrade_usage (
  execution_id uuid primary key references public.commercial_v1_examiner_regrade_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 1),
  attempts integer not null check(attempts between 0 and 3),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.commercial_v1_examiner_regrade_usage enable row level security;
revoke all on public.commercial_v1_examiner_regrade_usage from public, anon, authenticated, service_role;

create function commercial_v1_regrade_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Examiner execution history cannot be deleted'; end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then raise exception 'Terminal Examiner execution history is immutable'; end if;
  if row(NEW.actor_id,NEW.source_result_revision_id,NEW.source_revision_number,NEW.request_reason,NEW.id,NEW.student_id,NEW.capability,NEW.target_kind,NEW.attempt_id,NEW.submission_id,NEW.component,
    NEW.practical_id,NEW.policy_version,NEW.execution_kind,NEW.runtime_profile_ref,
    NEW.created_at,NEW.authorized_at,NEW.expires_at,NEW.max_provider_calls,
    NEW.max_output_tokens,NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.actor_id,OLD.source_result_revision_id,OLD.source_revision_number,OLD.request_reason,OLD.id,OLD.student_id,OLD.capability,OLD.target_kind,OLD.attempt_id,OLD.submission_id,OLD.component,
    OLD.practical_id,OLD.policy_version,OLD.execution_kind,OLD.runtime_profile_ref,
    OLD.created_at,OLD.authorized_at,OLD.expires_at,OLD.max_provider_calls,
    OLD.max_output_tokens,OLD.max_estimated_cost_microusd) then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  if OLD.enrolment_id is not null and NEW.enrolment_id is distinct from OLD.enrolment_id then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  if OLD.activation_id is not null and NEW.activation_id is distinct from OLD.activation_id then
    raise exception 'Examiner execution identity and budget are immutable';
  end if;
  if not ((OLD.state='AUTHORIZED' and NEW.state in ('RUNNING','FAILED','TIMEOUT')) or
    (OLD.state='RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED'))) then
    raise exception 'Invalid Examiner execution transition';
  end if;
  if OLD.state='RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'Examiner execution start is immutable';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_regrade_private.guard_execution() from public, anon, authenticated, service_role;
create trigger guard_examiner_execution before update or delete on public.commercial_v1_examiner_regrade_executions
for each row execute function commercial_v1_regrade_private.guard_execution();

create trigger guard_examiner_regrade_usage before update or delete on public.commercial_v1_examiner_regrade_usage
for each row execute function commercial_v1_examiner_private.guard_execution_usage();

create function commercial_v1_regrade_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.commercial_v1_examiner_regrade_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.actor_id,'COMMERCIAL_V1_EXAMINER_REGRADE_'||NEW.state,'commercial_v1_examiner_regrade_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Commercial V1 Examiner regrade execution lifecycle',
    jsonb_build_object('actor_id',NEW.actor_id,'source_result_revision_id',NEW.source_result_revision_id,'source_revision_number',NEW.source_revision_number,'execution_id',NEW.id,'student_id',NEW.student_id,'enrolment_id',NEW.enrolment_id,
      'activation_id',NEW.activation_id,'capability',NEW.capability,'target_kind',NEW.target_kind,
      'attempt_id',NEW.attempt_id,'submission_id',NEW.submission_id,'component',NEW.component,
      'practical_id',NEW.practical_id,'policy_version',NEW.policy_version,'execution_kind',NEW.execution_kind,
      'runtime_profile_ref',NEW.runtime_profile_ref,
      'state',NEW.state,'reason_code',NEW.reason_code,'budget_stage',NEW.budget_stage,
      'created_at',NEW.created_at,'authorized_at',NEW.authorized_at,'started_at',NEW.started_at,
      'terminal_at',NEW.terminal_at,'expires_at',NEW.expires_at,'review_path',NEW.review_path,
      'grade_digest',NEW.grade_digest,'result_revision_id',NEW.result_revision_id,
      'max_provider_calls',NEW.max_provider_calls,'max_output_tokens',NEW.max_output_tokens,
      'max_estimated_cost_microusd',NEW.max_estimated_cost_microusd,'usage',usage_snapshot),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function commercial_v1_regrade_private.audit_execution() from public, anon, authenticated, service_role;
create trigger audit_examiner_execution after insert or update on public.commercial_v1_examiner_regrade_executions
for each row execute function commercial_v1_regrade_private.audit_execution();

create function commercial_v1_regrade_private.execution_projection(p_id uuid,p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'transitioned',p_changed,'execution',jsonb_build_object(
    'actorId',e.actor_id,'sourceResultRevisionId',e.source_result_revision_id,'sourceRevisionNumber',e.source_revision_number,'executionId',e.id,'studentId',e.student_id,'enrolmentId',e.enrolment_id,'activationId',e.activation_id,
    'capability',e.capability,'targetKind',e.target_kind,'attemptId',e.attempt_id,'submissionId',e.submission_id,
    'component',e.component,'practicalId',e.practical_id,'policyVersion',e.policy_version,'executionKind',e.execution_kind,
    'runtimeProfileRef',e.runtime_profile_ref,
    'state',e.state,'reasonCode',e.reason_code,'budgetStage',e.budget_stage,'createdAt',e.created_at,
    'authorizedAt',e.authorized_at,'startedAt',e.started_at,'terminalAt',e.terminal_at,'expiresAt',e.expires_at,
    'reviewPath',e.review_path,'gradeDigest',e.grade_digest,'resultRevisionId',e.result_revision_id,
    'budget',jsonb_build_object('maxProviderCalls',e.max_provider_calls,'maxOutputTokens',e.max_output_tokens,
      'maxEstimatedCostMicrousd',e.max_estimated_cost_microusd),
    'usage',(select jsonb_build_object('providerCalls',u.provider_calls,'attempts',u.attempts,
      'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,
      'estimatedCostMicrousd',u.estimated_cost_microusd,'elapsedMs',u.elapsed_ms)
      from public.commercial_v1_examiner_regrade_usage u where u.execution_id=e.id)))
  from public.commercial_v1_examiner_regrade_executions e where e.id=p_id
$$;
revoke all on function commercial_v1_regrade_private.execution_projection(uuid,boolean) from public, anon, authenticated, service_role;


-- Resolve highest FIRST, then invoke the existing validator. No fallback.
create function commercial_v1_regrade_private.source(p_id uuid,p_kind text)
returns table(id uuid,student_id uuid,enrolment_id uuid,activation_id uuid,revision_number integer,
  attempt_id uuid,submission_id uuid,component text,practical_id uuid,is_current boolean,is_valid boolean)
language sql stable set search_path='' as $$
  select r.id,r.student_id,r.enrolment_id,r.activation_id,r.revision_number,r.attempt_id,null::uuid,r.component,null::uuid,
    r.revision_number=(select max(x.revision_number) from public.commercial_v1_assessment_result_revisions x where x.enrolment_id=r.enrolment_id and x.component=r.component),
    commercial_v1_private.assessment_result_is_valid(r.id)
  from public.commercial_v1_assessment_result_revisions r where r.id=p_id and p_kind='ASSESSMENT_ATTEMPT'
  union all
  select r.id,r.student_id,r.enrolment_id,r.activation_id,r.revision_number,null::uuid,r.submission_id,null::text,r.practical_id,
    r.revision_number=(select max(x.revision_number) from public.commercial_v1_lab_result_revisions x where x.enrolment_id=r.enrolment_id and x.practical_id=r.practical_id),
    commercial_v1_private.lab_result_is_valid(r.id)
  from public.commercial_v1_lab_result_revisions r where r.id=p_id and p_kind='LAB_SUBMISSION'
$$;
create function commercial_v1_regrade_private.verify_command(p_key_id uuid,p_execution_id uuid,p_source_id uuid,p_request_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text) returns boolean
language plpgsql security definer set search_path='' as $$
declare stamp numeric:=extract(epoch from clock_timestamp()); key_bytes bytea; expected bytea; supplied bytea;
  canonical text; mismatch integer:=0;
begin
  if public.current_app_user() is null or p_key_id is null or p_execution_id is null or p_source_id is null
    or p_request_reason is null or length(p_request_reason) not between 1 and 300 or p_request_reason<>btrim(p_request_reason)
    or p_capability is null or p_capability not in ('regrade_controlled_assessment','regrade_practical_lab')
    or p_target_kind is null or p_target_kind not in ('ASSESSMENT_ATTEMPT','LAB_SUBMISSION')
    or (p_capability='regrade_controlled_assessment')<>(p_target_kind='ASSESSMENT_ATTEMPT')
    or p_operation is null or p_operation not in ('AUTHORIZE','START','CONTEXT_READ','FINALIZE')
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_BLOCKED','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','GRADED','PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED',
      'PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID',
      'NO_PROVIDER_CONFIGURED','HUMAN_REVIEW_REQUIRED','BUDGET_BLOCKED','EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls<>1 or p_max_output is null or p_max_output not between 1 and 1200
    or p_max_cost is null or p_max_cost not between 1 and 50000
    or p_calls is null or p_calls not between 0 and 1 or p_attempts is null or p_attempts not between 0 and 3
    or p_input is null or p_input not between 0 and 1000000 or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000 or p_elapsed is null or p_elapsed not between 0 and 60000
    or (p_grade_digest is not null and p_grade_digest !~ '^[0-9a-f]{64}$')
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical:=concat_ws(E'\n','DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1','COMMERCIAL_V1_EXAMINER_REGRADE_V1',
    'EXAMINER','EXAMINER_COMMERCIAL_V1',p_key_id::text,public.current_app_user()::text,p_execution_id::text,
    p_source_id::text,encode(convert_to(p_request_reason,'UTF8'),'hex'),p_capability,p_target_kind,
    coalesce(p_student_id::text,'NONE'),coalesce(p_attempt_id::text,'NONE'),coalesce(p_submission_id::text,'NONE'),
    coalesce(p_enrolment_id::text,'NONE'),coalesce(p_activation_id::text,'NONE'),p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls::text,p_max_output::text,p_max_cost::text,p_calls::text,p_attempts::text,p_input::text,p_output::text,
    p_cost::text,p_elapsed::text,coalesce(p_grade_digest,'NONE'),p_issued_at::text,p_expires_at::text);
  expected:=extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256'); supplied:=decode(p_mac,'hex');
  for i in 0..31 loop mismatch:=mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
create function public.govern_commercial_v1_examiner_regrade(p_key_id uuid,p_execution_id uuid,p_source_id uuid,p_request_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,p_assessment_marks jsonb,p_lab_marks_awarded integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); stamp timestamptz; src record; e public.enrolments%rowtype;
  execution_record public.commercial_v1_examiner_regrade_executions%rowtype;
  existing public.commercial_v1_examiner_regrade_executions%rowtype;
  denied text; result_id uuid; computed_digest text; marks_text text; expected_weight integer; max_total integer;
  mark_elem jsonb; qid uuid; mark integer; qmax integer; answered_count integer; marks_count integer; q_row record; lp record;
  asm public.assessments%rowtype; sub public.commercial_v1_lab_submissions%rowtype; pr public.course_practicals%rowtype;
begin
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if not commercial_v1_regrade_private.verify_command(p_key_id,p_execution_id,p_source_id,p_request_reason,p_capability,p_target_kind,p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION'); end if;
  select * into src from commercial_v1_regrade_private.source(p_source_id,p_target_kind);
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  -- Shared learner lock serializes admission counts across enrolments.
  perform 1 from public.student_profiles where user_id=src.student_id for update;
  -- Same completion lock, before EVERY authoritative current/status observation.
  select * into e from public.enrolments where id=src.enrolment_id for update;
  if not commercial_v1_regrade_private.verify_command(p_key_id,p_execution_id,p_source_id,p_request_reason,p_capability,p_target_kind,p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION'); end if;
  if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  stamp:=clock_timestamp();
  update public.commercial_v1_examiner_regrade_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
    where student_id=src.student_id and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;
  select * into src from commercial_v1_regrade_private.source(p_source_id,p_target_kind);

  if p_operation='AUTHORIZE' then
    if p_student_id is not null or p_attempt_id is not null or p_submission_id is not null or p_enrolment_id is not null or p_activation_id is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    -- Replay precedes CURRENT check: the completed claim's source is now older.
    -- The source claim is institutional: any currently authorized Academic or
    -- Platform Admin may observe its bounded replay outcome. actor_id remains
    -- the immutable initiating actor; START/CONTEXT_READ/FINALIZE remain
    -- bound to that original actor below.
    select * into existing from public.commercial_v1_examiner_regrade_executions where source_result_revision_id=p_source_id and target_kind=p_target_kind;
    if found then
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      return commercial_v1_regrade_private.execution_projection(existing.id,false);
    end if;
  else
    select * into execution_record from public.commercial_v1_examiner_regrade_executions where id=p_execution_id and actor_id=actor;
    if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
    if row(execution_record.source_result_revision_id,execution_record.request_reason,execution_record.capability,execution_record.target_kind,
      execution_record.student_id,execution_record.attempt_id,execution_record.submission_id,execution_record.enrolment_id,execution_record.activation_id,
      execution_record.max_provider_calls,execution_record.max_output_tokens,execution_record.max_estimated_cost_microusd)
      is distinct from row(p_source_id,p_request_reason,p_capability,p_target_kind,p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,p_max_calls,p_max_output,p_max_cost) then
      return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT'); end if;
    if execution_record.state not in ('AUTHORIZED','RUNNING') then
      return jsonb_build_object('ok',false,'code',case when execution_record.state='TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end); end if;
  end if;

  if e.status<>'ACTIVE' or e.student_id<>src.student_id or src.activation_id is distinct from (commercial_v1_private.enrolment_activation(e.id)).id then
    denied:='TARGET_NOT_ELIGIBLE';
  elsif not src.is_current then denied:='NOT_CURRENT_RESULT';
  elsif not src.is_valid then denied:='CURRENT_RESULT_INVALID'; end if;
  -- A failure cleanup can still durably account for observed usage after a
  -- current/status change; it cannot write a result or return protected context.
  if denied is not null and not (p_operation='FINALIZE' and p_state<>'SUCCEEDED') then
    return jsonb_build_object('ok',false,'code',denied); end if;

  if p_operation<>'FINALIZE' then
    if p_reason<>'NONE' or p_budget_stage<>'NONE' or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0
      or p_grade_digest is not null or p_assessment_marks is not null or p_lab_marks_awarded is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  end if;
  if p_operation='AUTHORIZE' then
    if p_state<>'AUTHORIZED' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    if exists(select 1 from public.commercial_v1_examiner_regrade_executions where student_id=src.student_id and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.commercial_v1_examiner_regrade_executions where student_id=src.student_id and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.commercial_v1_examiner_regrade_executions where student_id=src.student_id and created_at>stamp-interval '1 hour')>=30 then
      return jsonb_build_object('ok',false,'code','RATE_LIMITED'); end if;
    insert into public.commercial_v1_examiner_regrade_executions(id,actor_id,source_result_revision_id,source_revision_number,request_reason,
      student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,submission_id,component,practical_id,state,
      created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd)
    values(p_execution_id,actor,src.id,src.revision_number,p_request_reason,src.student_id,src.enrolment_id,src.activation_id,p_capability,p_target_kind,
      src.attempt_id,src.submission_id,src.component,src.practical_id,'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',p_max_calls,p_max_output,p_max_cost);
    return commercial_v1_regrade_private.execution_projection(p_execution_id,true);
  end if;
  if p_operation='START' then
    if p_state<>'RUNNING' or execution_record.state<>'AUTHORIZED' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.commercial_v1_examiner_regrade_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return commercial_v1_regrade_private.execution_projection(p_execution_id,true);
  end if;
  if execution_record.state<>'RUNNING' and not (p_operation='FINALIZE' and p_state='FAILED' and p_reason='INTERNAL_ERROR'
    and p_calls=0 and p_attempts=0 and p_input=0 and p_output=0 and p_cost=0 and p_elapsed=0) then
    return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;
  if p_operation='CONTEXT_READ' then
    if p_state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    if p_target_kind='ASSESSMENT_ATTEMPT' then
  select * into asm from public.assessments where id=(select assessment_id from public.assessment_attempts where id=execution_record.attempt_id);
  return jsonb_build_object('ok',true,'attemptId',execution_record.attempt_id,'assessmentId',asm.id,'component',execution_record.component,
    'title',asm.title,'instructions',asm.instructions,
    'questions',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'questionId',q.id,'position',q.position,'prompt',q.prompt,'maxMarks',q.max_marks,
        'expectedAnswer',ak.expected_answer,'markingGuidance',ak.marking_guidance,
        'responseBody',r.body
      ) order by q.position),'[]'::jsonb)
      from public.assessment_questions q
      join public.assessment_answer_keys ak on ak.question_id=q.id
      join lateral (
        select body from public.assessment_responses
        where attempt_id=execution_record.attempt_id and question_id=q.id
        order by revision_number desc limit 1
      ) r on true
      where q.assessment_id=asm.id
    ));
    else
  select * into sub from public.commercial_v1_lab_submissions where id=execution_record.submission_id;
  select * into pr from public.course_practicals where id=execution_record.practical_id;
  select * into lp from public.commercial_v1_lab_policies where activation_id=execution_record.activation_id and practical_id=execution_record.practical_id;
  return jsonb_build_object('ok',true,'submissionId',execution_record.submission_id,'practicalId',execution_record.practical_id,
    'title',pr.title,'instructions',pr.instructions,'maxMarks',lp.max_marks,'gradingGuidance',lp.grading_guidance,
    'submissionBody',sub.body,
    'objectives',(
      select coalesce(jsonb_agg(jsonb_build_object('objectiveId',lo.id,'description',lo.description) order by lo.position),'[]'::jsonb)
      from public.course_practical_objectives po
      join public.lesson_objectives lo on lo.id=po.objective_id
      where po.practical_id=execution_record.practical_id
    ));
    end if;
  end if;
  -- A pre-provider START transport failure may leave AUTHORIZED. Only a
  -- zero-usage INTERNAL_ERROR cleanup is admitted from that state above.
  if not (
    (p_state='SUCCEEDED' and p_reason='GRADED' and p_budget_stage='NONE' and p_grade_digest is not null) or
    (p_state='FAILED' and p_budget_stage='NONE' and p_grade_digest is null and p_reason in (
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
      'PROVIDER_REFUSED','PROVIDER_ERROR','INTERNAL_ERROR','OUTPUT_INVALID','EXECUTION_TIMEOUT','NO_PROVIDER_CONFIGURED')) or
    (p_state='ESCALATED' and p_reason='HUMAN_REVIEW_REQUIRED' and p_budget_stage='NONE' and p_grade_digest is null) or
    (p_state='BUDGET_BLOCKED' and p_reason='BUDGET_BLOCKED' and p_budget_stage in ('PRE_CALL','POST_CALL') and p_grade_digest is null) or
    (p_state='CANCELLED' and p_reason='CANCELLED' and p_budget_stage='NONE' and p_grade_digest is null)
  ) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_calls>execution_record.max_provider_calls then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_state='SUCCEEDED' and (p_calls<>1 or p_attempts<>1) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_state='SUCCEEDED' and (p_output>execution_record.max_output_tokens or p_cost>execution_record.max_estimated_cost_microusd) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  insert into public.commercial_v1_examiner_regrade_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);

  if p_state='SUCCEEDED' then
    perform 1 from public.enrolments where id=execution_record.enrolment_id for update;
    denied := null;
    begin
      if execution_record.target_kind='ASSESSMENT_ATTEMPT' then
        select string_agg(format('%s:%s',(x->>'questionId'),(x->>'marksAwarded')),';' order by (x->>'questionId'))
          into marks_text from jsonb_array_elements(coalesce(p_assessment_marks,'[]'::jsonb)) x;
        computed_digest := encode(extensions.digest(convert_to(coalesce(marks_text,''),'UTF8'),'sha256'),'hex');
        if computed_digest is distinct from p_grade_digest then raise exception 'GRADE_DIGEST_MISMATCH'; end if;
        if p_assessment_marks is null or jsonb_typeof(p_assessment_marks)<>'array' then raise exception 'INVALID_GRADE_PAYLOAD'; end if;
        if (select count(*) from jsonb_array_elements(p_assessment_marks)) <>
           (select count(distinct (x->>'questionId')) from jsonb_array_elements(p_assessment_marks) x) then
          raise exception 'DUPLICATE_QUESTION_ID';
        end if;
        for mark_elem in select * from jsonb_array_elements(p_assessment_marks) loop
          if (select count(*) from jsonb_object_keys(mark_elem))<>2 or not(mark_elem ? 'questionId') or not(mark_elem ? 'marksAwarded')
            or jsonb_typeof(mark_elem->'questionId')<>'string' or jsonb_typeof(mark_elem->'marksAwarded')<>'number'
            or (mark_elem->>'marksAwarded') !~ '^\d+$' then
            raise exception 'INVALID_GRADE_PAYLOAD';
          end if;
          qid := (mark_elem->>'questionId')::uuid;
          mark := (mark_elem->>'marksAwarded')::integer;
          select q.max_marks into qmax from public.assessment_questions q
            join public.assessment_attempts a on a.assessment_id=q.assessment_id
            where q.id=qid and a.id=execution_record.attempt_id;
          if not found then raise exception 'FOREIGN_QUESTION'; end if;
          if mark>qmax then raise exception 'MARKS_EXCEED_MAX'; end if;
          if not exists(select 1 from public.assessment_responses where attempt_id=execution_record.attempt_id and question_id=qid) then
            raise exception 'UNANSWERED_QUESTION_GRADED';
          end if;
        end loop;
        select count(distinct question_id) into answered_count from public.assessment_responses where attempt_id=execution_record.attempt_id;
        select count(*) into marks_count from jsonb_array_elements(p_assessment_marks);
        if marks_count<>answered_count then raise exception 'ANSWERED_QUESTION_SET_MISMATCH'; end if;

        expected_weight := commercial_v1_private.expected_component_weight(execution_record.activation_id,execution_record.component);
        select sum(q.max_marks)::integer into max_total from public.assessment_questions q
          join public.assessment_attempts a on a.assessment_id=q.assessment_id where a.id=execution_record.attempt_id;

        insert into public.commercial_v1_assessment_result_revisions(
          activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
          earned_marks_total,max_marks_total,component_weight_bp
        ) values (
          execution_record.activation_id,execution_record.enrolment_id,execution_record.student_id,execution_record.component,
          execution_record.attempt_id,(select assessment_id from public.assessment_attempts where id=execution_record.attempt_id),src.revision_number+1,
          (select coalesce(sum((x->>'marksAwarded')::integer),0) from jsonb_array_elements(p_assessment_marks) x),
          max_total,expected_weight
        ) returning id into result_id;

        for q_row in
          select q.id as qid,q.max_marks as qmax,
            coalesce((select (x->>'marksAwarded')::integer from jsonb_array_elements(p_assessment_marks) x where (x->>'questionId')::uuid=q.id),0) as awarded
          from public.assessment_questions q
          join public.assessment_attempts a on a.assessment_id=q.assessment_id where a.id=execution_record.attempt_id
        loop
          insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot)
          values(result_id,q_row.qid,q_row.awarded,q_row.qmax);
        end loop;

        perform commercial_v1_private.derive_and_insert_objective_outcomes(result_id);
        if not commercial_v1_private.assessment_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;
      else
        computed_digest := encode(extensions.digest(convert_to('marksAwarded:'||coalesce(p_lab_marks_awarded::text,'NULL'),'UTF8'),'sha256'),'hex');
        if computed_digest is distinct from p_grade_digest then raise exception 'GRADE_DIGEST_MISMATCH'; end if;
        if p_lab_marks_awarded is null or p_lab_marks_awarded<0 then raise exception 'INVALID_GRADE_PAYLOAD'; end if;
        select * into lp
          from public.commercial_v1_lab_policies where activation_id=execution_record.activation_id and practical_id=execution_record.practical_id;
        if not found then raise exception 'LAB_POLICY_MISSING'; end if;
        if p_lab_marks_awarded>lp.max_marks then raise exception 'MARKS_EXCEED_MAX'; end if;

        insert into public.commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values (
          execution_record.activation_id,execution_record.enrolment_id,execution_record.student_id,execution_record.practical_id,
          execution_record.submission_id,src.revision_number+1,p_lab_marks_awarded,lp.max_marks,lp.contribution_bp
        ) returning id into result_id;

        perform commercial_v1_private.derive_and_insert_lab_objective_outcomes(result_id);
        if not commercial_v1_private.lab_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;
      end if;
      update public.commercial_v1_examiner_regrade_executions
      set state='SUCCEEDED',reason_code='GRADED',terminal_at=stamp,result_revision_id=result_id,grade_digest=p_grade_digest
      where id=p_execution_id;
    exception when others then
      denied := 'RESULT_INTEGRITY_FAILED';
    end;
    if denied is not null then
      update public.commercial_v1_examiner_regrade_executions
      set state='FAILED',reason_code=denied,terminal_at=stamp where id=p_execution_id;
    end if;
  else
    update public.commercial_v1_examiner_regrade_executions
    set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
      review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
    where id=p_execution_id;
  end if;
  return commercial_v1_regrade_private.execution_projection(p_execution_id,true);
end $$;

-- Explicit table/column/schema/function ACLs, including BYPASSRLS service_role.
do $$ declare tbl regclass; cols text; fn regprocedure; begin
  foreach tbl in array array['public.commercial_v1_examiner_regrade_executions'::regclass,'public.commercial_v1_examiner_regrade_usage'::regclass] loop
    execute format('revoke all on table %s from public,anon,authenticated,service_role',tbl);
    select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid=tbl and attnum>0 and not attisdropped;
    execute format('revoke all privileges (%s) on table %s from public,anon,authenticated,service_role',cols,tbl);
  end loop;
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='commercial_v1_regrade_private' or (n.nspname='public' and p.proname='govern_commercial_v1_examiner_regrade') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);
    if fn::text like 'govern_commercial_v1_examiner_regrade(%' or fn::text like 'public.govern_commercial_v1_examiner_regrade(%' then
      execute format('grant execute on function %s to authenticated',fn);
    end if;
  end loop;
end $$;
