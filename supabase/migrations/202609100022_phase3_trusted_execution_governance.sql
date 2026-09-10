-- B1: authenticated learner + independently authenticated controller command.
-- No provider execution, usage accounting, content storage or service-role path.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Fail deployment if an existing installation uses a different schema. Relocation
-- is an explicit operator decision, never an implicit change to another extension.
do $$ begin
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace
    where e.extname='pgcrypto' and n.nspname='extensions') then
    raise exception 'Execution governance requires pgcrypto in extensions';
  end if;
end $$;

create schema academic_execution_private;
revoke all on schema academic_execution_private from public, anon, authenticated;
create table academic_execution_private.controller_keys (
  id uuid primary key,
  secret bytea not null check(octet_length(secret)=32),
  installed_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check(revoked_at is null or revoked_at>=installed_at)
);
alter table academic_execution_private.controller_keys enable row level security;
revoke all on academic_execution_private.controller_keys from public, anon, authenticated;

-- Database-owner provisioning only, with bound binary parameters over a protected
-- operator connection. No secret value is embedded in migration/seed/source.
create function academic_execution_private.install_controller_key(p_id uuid,p_secret bytea)
returns void language sql set search_path='' as $$
  insert into academic_execution_private.controller_keys(id,secret) values(p_id,p_secret)
$$;
revoke all on function academic_execution_private.install_controller_key(uuid,bytea) from public, anon, authenticated;

create table public.academic_executions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(user_id),
  release_id uuid not null unique references public.academic_content_releases(id),
  invocation_id uuid not null,
  agent_profile text not null default 'PROFESSOR' check(agent_profile='PROFESSOR'),
  policy_version text not null default 'PROFESSOR_EXECUTION_V1' check(policy_version='PROFESSOR_EXECUTION_V1'),
  execution_kind text not null default 'CONTROL_PLANE_ONLY' check(execution_kind='CONTROL_PLANE_ONLY'),
  state text not null check(state in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','ESCALATED','BLOCKED')),
  reason_code text,
  created_at timestamptz not null,
  authorized_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz not null,
  -- Zero external budget in B1. These are ceilings, never actual usage/cost.
  max_provider_calls integer not null default 0 check(max_provider_calls=0),
  max_input_tokens integer not null default 0 check(max_input_tokens=0),
  max_output_tokens integer not null default 0 check(max_output_tokens=0),
  max_estimated_cost_microusd bigint not null default 0 check(max_estimated_cost_microusd=0),
  review_path text check(review_path='ACADEMIC_REVIEW'),
  check(expires_at>created_at and expires_at<=created_at+interval '20 seconds'),
  check(authorized_at is null or authorized_at=created_at),
  check(started_at is null or (started_at>=created_at and started_at<expires_at)),
  check(terminal_at is null or terminal_at>=coalesce(started_at,created_at)),
  check((state in ('AUTHORIZED','RUNNING') and reason_code is null) or
    (state not in ('AUTHORIZED','RUNNING') and reason_code is not null and terminal_at is not null)),
  check(
    (state='AUTHORIZED' and authorized_at is not null and started_at is null and terminal_at is null and reason_code is null) or
    (state='RUNNING' and authorized_at is not null and started_at is not null and terminal_at is null and reason_code is null) or
    (state='SUCCEEDED' and authorized_at is not null and started_at is not null and terminal_at is not null and reason_code='CONTROL_PLANE_COMPLETE') or
    (state='ABSTAINED' and authorized_at is not null and started_at is not null and terminal_at is not null and reason_code in ('ABSTAIN_UNCERTAIN','POLICY_BLOCKED')) or
    (state='ESCALATED' and authorized_at is not null and started_at is not null and terminal_at is not null and reason_code='HUMAN_REVIEW_REQUIRED') or
    (state='FAILED' and authorized_at is not null and terminal_at is not null and reason_code in (
      'EXECUTION_TIMEOUT','INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED')) or
    (state='BLOCKED' and authorized_at is null and started_at is null and terminal_at=created_at and reason_code in ('RATE_LIMITED','BUDGET_BLOCKED'))
  ),
  check((state='ESCALATED' and review_path is not null) or (state<>'ESCALATED' and review_path is null))
);
create index academic_executions_admission on public.academic_executions(student_id,created_at);
create index academic_executions_active on public.academic_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.academic_executions enable row level security;
revoke all on public.academic_executions from public, anon, authenticated;

create function academic_execution_private.guard_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Execution history cannot be deleted'; end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then raise exception 'Terminal execution history is immutable'; end if;
  if row(NEW.id,NEW.student_id,NEW.release_id,NEW.invocation_id,NEW.agent_profile,NEW.policy_version,
    NEW.execution_kind,NEW.created_at,NEW.authorized_at,NEW.expires_at,NEW.max_provider_calls,
    NEW.max_input_tokens,NEW.max_output_tokens,NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id,OLD.student_id,OLD.release_id,OLD.invocation_id,OLD.agent_profile,OLD.policy_version,
    OLD.execution_kind,OLD.created_at,OLD.authorized_at,OLD.expires_at,OLD.max_provider_calls,
    OLD.max_input_tokens,OLD.max_output_tokens,OLD.max_estimated_cost_microusd) then
    raise exception 'Execution identity and budget are immutable';
  end if;
  if not ((OLD.state='AUTHORIZED' and NEW.state in ('RUNNING','FAILED')) or
    (OLD.state='RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ABSTAINED','ESCALATED'))) then
    raise exception 'Invalid execution transition';
  end if;
  if OLD.state='RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'Execution start is immutable';
  end if;
  return NEW;
end $$;
revoke all on function academic_execution_private.guard_execution() from public, anon, authenticated;
create trigger guard_execution_history before update or delete on public.academic_executions
for each row execute function academic_execution_private.guard_execution();

create function academic_execution_private.audit_execution() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'EXECUTION_'||NEW.state,'academic_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Professor control-plane lifecycle; no provider execution attested',
    jsonb_build_object('execution_id',NEW.id,'student_id',NEW.student_id,'release_id',NEW.release_id,
      'invocation_id',NEW.invocation_id,'agent_profile',NEW.agent_profile,'policy_version',NEW.policy_version,
      'execution_kind',NEW.execution_kind,'state',NEW.state,'reason_code',NEW.reason_code,
      'created_at',NEW.created_at,'authorized_at',NEW.authorized_at,'started_at',NEW.started_at,
      'terminal_at',NEW.terminal_at,'expires_at',NEW.expires_at,'review_path',NEW.review_path,
      'max_provider_calls',NEW.max_provider_calls,'max_input_tokens',NEW.max_input_tokens,
      'max_output_tokens',NEW.max_output_tokens,'max_estimated_cost_microusd',NEW.max_estimated_cost_microusd),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function academic_execution_private.audit_execution() from public, anon, authenticated;
create trigger audit_execution_lifecycle after insert or update on public.academic_executions
for each row execute function academic_execution_private.audit_execution();

-- Exact, bounded canonical message, shared with the Node signer. No prompt/content
-- digest. Identity comes from current_app_user(), not from an RPC actor parameter.
create function academic_execution_private.verify_command(
  p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,
  p_calls integer,p_input integer,p_output integer,p_cost bigint,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean language plpgsql security definer set search_path='' as $$
declare
  key_bytes bytea;
  expected bytea;
  supplied bytea;
  canonical text;
  mismatch integer := 0;
  stamp numeric;
begin
  stamp := extract(epoch from clock_timestamp());
  if public.current_app_user() is null or p_key_id is null or p_execution_id is null or p_release_id is null
    or p_operation is null or p_operation not in ('AUTHORIZE','START','FINALIZE')
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','ESCALATED')
    or p_reason is null or p_reason not in ('NONE','CONTROL_PLANE_COMPLETE','INTERNAL_ERROR','OUTPUT_INVALID',
      'POLICY_BLOCKED','ABSTAIN_UNCERTAIN','HUMAN_REVIEW_REQUIRED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED')
    or p_calls is null or p_calls not between 0 and 10
    or p_input is null or p_input not between 0 and 1000000
    or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or length(p_mac)<>64 or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical := concat_ws(E'\n','DUCELIO_EXECUTION_HMAC_SHA256_V1','PROFESSOR_EXECUTION_V1','PROFESSOR',
    p_key_id::text,public.current_app_user()::text,p_execution_id::text,p_release_id::text,
    p_operation,p_state,p_reason,p_calls::text,p_input::text,p_output::text,p_cost::text,p_issued_at::text,p_expires_at::text);
  expected := extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256');
  supplied := decode(p_mac,'hex');
  -- Fixed 32-byte comparison without an early exit on the first differing byte.
  -- This is not a claim of hosted side-channel resistance or network isolation.
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function academic_execution_private.verify_command(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,bigint,bigint,text) from public, anon, authenticated;

create function academic_execution_private.execution_projection(p_id uuid,p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'transitioned',p_changed,'execution',jsonb_build_object(
    'executionId',id,'studentId',student_id,'releaseId',release_id,'invocationId',invocation_id,
    'agentProfile',agent_profile,'policyVersion',policy_version,'executionKind',execution_kind,
    'state',state,'reasonCode',reason_code,'createdAt',created_at,'authorizedAt',authorized_at,
    'startedAt',started_at,'terminalAt',terminal_at,'expiresAt',expires_at,'reviewPath',review_path,
    'budget',jsonb_build_object('maxProviderCalls',max_provider_calls,'maxInputTokens',max_input_tokens,
      'maxOutputTokens',max_output_tokens,'maxEstimatedCostMicrousd',max_estimated_cost_microusd)))
  from public.academic_executions where id=p_id and student_id=public.current_app_user()
$$;
revoke all on function academic_execution_private.execution_projection(uuid,boolean) from public, anon, authenticated;

-- One finite command surface, not a generic SQL/RPC/audit writer. EXECUTE is
-- authenticated-callable, but every transition also requires a valid server MAC.
create function public.govern_professor_execution(
  p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,
  p_calls integer,p_input integer,p_output integer,p_cost bigint,p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  release_record public.academic_content_releases%rowtype;
  execution_record public.academic_executions%rowtype;
  stamp timestamptz;
  deadline timestamptz;
  denied text;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not academic_execution_private.verify_command(p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,p_calls,p_input,p_output,p_cost,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  -- Recheck freshness/revocation after any lock wait.
  if not academic_execution_private.verify_command(p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,p_calls,p_input,p_output,p_cost,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  update public.academic_executions set state='FAILED',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
  where student_id=actor and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;
  perform public.expire_my_academic_content_releases();
  select * into release_record from public.academic_content_releases where id=p_release_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;

  if p_operation='AUTHORIZE' then
    if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
    if p_state<>'AUTHORIZED' or p_reason<>'NONE' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    if exists(select 1 from public.academic_executions where id=p_execution_id or release_id=p_release_id) then
      return jsonb_build_object('ok',false,'code','REPLAY_REJECTED');
    end if;
    if release_record.state<>'ACTIVE' or release_record.expires_at<=clock_timestamp()
      or release_record.capability_contract_version<>'PROFESSOR_READ_V2'
      or release_record.agent_profile<>'PROFESSOR' then
      return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE');
    end if;
    if public.academic_content_release_explain_allowed() is not true then
      return jsonb_build_object('ok',false,'code','ACTIVITY_BLOCKED');
    end if;
    -- Versioned pre-production abuse ceilings, not commercial quotas. Denied
    -- trusted admissions count too; caller cannot raise these DB-owned limits.
    if exists(select 1 from public.academic_executions where student_id=actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.academic_executions where student_id=actor and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.academic_executions where student_id=actor and created_at>stamp-interval '1 hour')>=30 then
      denied := 'RATE_LIMITED';
    elsif p_calls>0 or p_input>0 or p_output>0 or p_cost>0 then denied := 'BUDGET_BLOCKED'; end if;
    stamp := clock_timestamp();
    deadline := least(stamp+interval '20 seconds',release_record.expires_at);
    if deadline<=stamp then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
    insert into public.academic_executions(id,student_id,release_id,invocation_id,state,reason_code,created_at,authorized_at,expires_at,terminal_at)
    values(p_execution_id,actor,p_release_id,release_record.invocation_id,
      case when denied is null then 'AUTHORIZED' else 'BLOCKED' end,denied,stamp,
      case when denied is null then stamp else null end,deadline,case when denied is null then null else stamp end);
    return academic_execution_private.execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.academic_executions where id=p_execution_id and student_id=actor and release_id=p_release_id;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
  if p_calls<>0 or p_input<>0 or p_output<>0 or p_cost<>0 then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    -- Captured terminal attestations never authorize a second accepted command.
    return jsonb_build_object('ok',false,'code',case when execution_record.reason_code='EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;
  denied := case when not public.has_role('STUDENT') then 'POLICY_BLOCKED'
    when release_record.state<>'ACTIVE' or release_record.expires_at<=clock_timestamp() then 'CONTENT_RELEASE_UNAVAILABLE'
    when public.academic_content_release_explain_allowed() is not true then 'ACTIVITY_BLOCKED' else null end;
  stamp := clock_timestamp();
  if stamp>=execution_record.expires_at then denied := 'EXECUTION_TIMEOUT'; stamp := execution_record.expires_at; end if;
  if denied is not null then
    update public.academic_executions set state='FAILED',reason_code=denied,terminal_at=stamp where id=p_execution_id;
    return jsonb_build_object('ok',false,'code',denied);
  end if;
  if p_operation='START' then
    if p_state<>'RUNNING' or p_reason<>'NONE' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    if execution_record.state='RUNNING' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.academic_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
  elsif p_operation='FINALIZE' then
    if not (
      (p_state='FAILED' and p_reason in ('INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED')) or
      (execution_record.state='RUNNING' and (
        (p_state='SUCCEEDED' and p_reason='CONTROL_PLANE_COMPLETE') or
        (p_state='ABSTAINED' and p_reason in ('ABSTAIN_UNCERTAIN','POLICY_BLOCKED')) or
        (p_state='ESCALATED' and p_reason='HUMAN_REVIEW_REQUIRED')))
    ) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
    update public.academic_executions set state=p_state,reason_code=p_reason,terminal_at=stamp,
      review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end where id=p_execution_id;
  end if;
  return academic_execution_private.execution_projection(p_execution_id,true);
end $$;
revoke all on function public.govern_professor_execution(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.govern_professor_execution(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,bigint,bigint,text) to authenticated;

-- Explicitly close ambient Supabase service-role/default ACL paths. BYPASSRLS
-- does not bypass object ACLs. B1 uses the authenticated learner plus MAC only.
revoke all on schema academic_execution_private from service_role;
revoke all on all tables in schema academic_execution_private from service_role;
revoke all on all functions in schema academic_execution_private from service_role;
revoke all on public.academic_executions, public.academic_content_releases from service_role;
-- Preserve existing audit SELECT; no broad role may manufacture trusted events.
revoke insert, update, delete, truncate, references, trigger on public.audit_events from service_role;
revoke all on function public.govern_professor_execution(uuid,uuid,uuid,text,text,text,integer,integer,integer,bigint,bigint,bigint,text) from service_role;
revoke all on function public.begin_academic_content_release(uuid,text,text) from service_role;
revoke all on function public.close_academic_content_release(uuid,boolean) from service_role;
revoke all on function public.expire_my_academic_content_releases() from service_role;
revoke all on function public.academic_content_release_explain_allowed() from service_role;
revoke all on function public.guard_academic_content_release() from service_role;
revoke all on function public.audit_academic_content_release() from service_role;

-- Table REVOKE alone does not clear pre-existing column-level privileges.
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.academic_executions'::regclass,'public.academic_content_releases'::regclass,
    'public.audit_events'::regclass,'academic_execution_private.controller_keys'::regclass
  ] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=protected_table and attnum>0 and not attisdropped;
    execute format('revoke insert (%s), update (%s), references (%s) on table %s from service_role',
      columns,columns,columns,protected_table);
  end loop;
end $$;

-- Effective-ACL acceptance: fail migration rather than silently inherit unsafe
-- rights from an unexpected hosted role membership. Never revoke learner grants.
do $$ declare protected_table regclass; begin
  foreach protected_table in array array[
    'public.academic_executions'::regclass,'public.academic_content_releases'::regclass,
    'public.audit_events'::regclass,'academic_execution_private.controller_keys'::regclass
  ] loop
    if has_table_privilege('service_role',protected_table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('service_role',protected_table,'INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe effective service-role execution privileges';
    end if;
  end loop;
  if has_schema_privilege('service_role','academic_execution_private','USAGE,CREATE')
    or has_any_column_privilege('service_role','academic_execution_private.controller_keys','SELECT')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='academic_execution_private' or (n.nspname='public' and p.proname in (
        'govern_professor_execution','begin_academic_content_release','close_academic_content_release',
        'expire_my_academic_content_releases','academic_content_release_explain_allowed',
        'guard_academic_content_release','audit_academic_content_release')))
      and has_function_privilege('service_role',p.oid,'EXECUTE')) then
    raise exception 'Unsafe effective service-role execution privileges';
  end if;
end $$;
