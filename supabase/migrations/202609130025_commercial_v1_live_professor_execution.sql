-- Commercial V1: trusted live Professor provider-backed execution (V2).
-- Additive/corrective only; migrations 001-024 are unmodified, migration 022
-- is not edited. Migration 022's PROFESSOR_EXECUTION_V1/CONTROL_PLANE_ONLY
-- path, its zero-budget envelope and its historical semantics are preserved
-- exactly as-is. This migration introduces a SEPARATE, distinctly
-- identifiable governance surface -- PROFESSOR_EXECUTION_V2 /
-- PROVIDER_BACKED_V1 -- in its own table, with its own DB-owned hard budget
-- ceilings and its own durable, content-free usage ledger, reusing only the
-- already-reviewed academic_execution_private.controller_keys trust root
-- (migration 022) rather than provisioning a second secret.
--
-- Mirrors migration 022's ACL-hardening pattern throughout: service_role has
-- BYPASSRLS in this project's Supabase-like setup, so RLS alone never
-- protects these objects from it. Every table/function below is explicitly
-- revoked from public, anon, authenticated and service_role at creation,
-- and a closing effective-ACL assertion fails this migration's deployment
-- if any of those roles retains unsafe inherited access. Only authenticated
-- ever receives an explicit, reviewed EXECUTE grant, and only on the exact
-- RPC documented below.

do $$ begin
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions') then
    raise exception 'Live Professor execution requires pgcrypto in extensions';
  end if;
end $$;

-- Reviewed, DB-owned V2 provider-execution hard ceilings. These are the
-- absolute maximum a signed AUTHORIZE proposal may ever request; a runtime
-- profile's own budgetPolicy (src/domain/academic-runtime-profile.ts) must
-- independently stay within these, but even a compromised/corrupt caller
-- cannot widen them, because they are enforced as table CHECK constraints
-- on the admitted row itself, not merely application logic. Changing these
-- is a reviewed policy migration, never a learner/course/package input.
--   max_provider_calls        : 1..3
--   max_output_tokens         : 1..4000
--   max_estimated_cost_microusd: 1..200000  (up to 20 US cents, in micro-USD)
-- Input-token and monetary-cost enforcement is POST-CALL reconciliation
-- against what a provider actually reports (see the FINALIZE usage checks
-- below), never a pre-call promise: only provider call count and the
-- requested output-token ceiling are meaningfully pre-call quantities.
create table public.academic_provider_executions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(user_id),
  release_id uuid not null unique references public.academic_content_releases(id),
  invocation_id uuid not null,
  agent_profile text not null default 'PROFESSOR' check(agent_profile='PROFESSOR'),
  policy_version text not null default 'PROFESSOR_EXECUTION_V2' check(policy_version='PROFESSOR_EXECUTION_V2'),
  execution_kind text not null default 'PROVIDER_BACKED_V1' check(execution_kind='PROVIDER_BACKED_V1'),
  state text not null check(state in (
    'AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED','BLOCKED'
  )),
  reason_code text,
  budget_stage text check(budget_stage in ('PRE_CALL','POST_CALL')),
  created_at timestamptz not null,
  authorized_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz not null,
  max_provider_calls integer not null check(max_provider_calls between 1 and 3),
  max_output_tokens integer not null check(max_output_tokens between 1 and 4000),
  max_estimated_cost_microusd bigint not null check(max_estimated_cost_microusd between 1 and 200000),
  review_path text check(review_path='ACADEMIC_REVIEW'),
  check(expires_at>created_at and expires_at<=created_at+interval '20 seconds'),
  check(authorized_at is null or authorized_at=created_at),
  check(started_at is null or (started_at>=created_at and started_at<expires_at)),
  check(terminal_at is null or terminal_at>=coalesce(started_at,created_at)),
  check(
    (state='AUTHORIZED' and authorized_at is not null and started_at is null and terminal_at is null
      and reason_code is null and budget_stage is null) or
    (state='RUNNING' and authorized_at is not null and started_at is not null and terminal_at is null
      and reason_code is null and budget_stage is null) or
    (state='SUCCEEDED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code='PROVIDER_COMPLETE' and budget_stage is null) or
    -- EXECUTION_TIMEOUT is a valid FAILED reason here (distinct from the
    -- separate TIMEOUT state reserved for the DB's own lazy-expiry sweep,
    -- see below): the trusted controller observing its OWN runtime deadline
    -- mid-execution reports that truthfully via a normal FINALIZE call from
    -- RUNNING, exactly like any other provider/governance failure reason.
    (state='FAILED' and authorized_at is not null and terminal_at is not null and budget_stage is null
      and reason_code in (
        'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
        'PROVIDER_REFUSED','PROVIDER_ERROR',
        'INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED',
        'EXECUTION_TIMEOUT')) or
    (state='ABSTAINED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and budget_stage is null
      and reason_code in ('NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','NO_EXECUTION_PATH','POLICY_BLOCKED','ACTIVITY_BLOCKED')) or
    (state='ESCALATED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code='HUMAN_REVIEW_REQUIRED' and budget_stage is null) or
    (state='BUDGET_BLOCKED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code='BUDGET_BLOCKED' and budget_stage in ('PRE_CALL','POST_CALL')) or
    (state='TIMEOUT' and authorized_at is not null and terminal_at is not null
      and reason_code='EXECUTION_TIMEOUT' and budget_stage is null) or
    (state='CANCELLED' and authorized_at is not null and started_at is not null and terminal_at is not null
      and reason_code='CANCELLED' and budget_stage is null) or
    (state='BLOCKED' and authorized_at is null and started_at is null and terminal_at=created_at and budget_stage is null
      and reason_code in ('RATE_LIMITED','OUT_OF_ENVELOPE'))
  ),
  check((state='ESCALATED' and review_path is not null) or (state<>'ESCALATED' and review_path is null))
);
create index academic_provider_executions_admission on public.academic_provider_executions(student_id,created_at);
create index academic_provider_executions_active on public.academic_provider_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.academic_provider_executions enable row level security;
revoke all on public.academic_provider_executions from public, anon, authenticated, service_role;

-- Durable, content-free usage ledger: exactly one immutable row per
-- execution, written only by FINALIZE (see below) in the same transaction
-- as the execution's own terminal-state UPDATE. No prompt, response,
-- resource body, objective prose, assessment prompt/answer, arbitrary
-- provider payload, credential or secret can be stored here -- there is
-- structurally no column for any of that. A BEFORE UPDATE/DELETE guard
-- below makes every row permanently immutable once recorded, stronger than
-- the execution table's own "terminal rows are immutable" rule (this table
-- has no non-terminal state to begin with).
create table public.academic_provider_execution_usage (
  execution_id uuid primary key references public.academic_provider_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 3),
  attempts integer not null check(attempts between 0 and 3),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.academic_provider_execution_usage enable row level security;
revoke all on public.academic_provider_execution_usage from public, anon, authenticated, service_role;

create function academic_execution_private.guard_provider_execution() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Execution history cannot be deleted'; end if;
  if OLD.state not in ('AUTHORIZED','RUNNING') then raise exception 'Terminal execution history is immutable'; end if;
  if row(NEW.id,NEW.student_id,NEW.release_id,NEW.invocation_id,NEW.agent_profile,NEW.policy_version,
    NEW.execution_kind,NEW.created_at,NEW.authorized_at,NEW.expires_at,NEW.max_provider_calls,
    NEW.max_output_tokens,NEW.max_estimated_cost_microusd)
    is distinct from row(OLD.id,OLD.student_id,OLD.release_id,OLD.invocation_id,OLD.agent_profile,OLD.policy_version,
    OLD.execution_kind,OLD.created_at,OLD.authorized_at,OLD.expires_at,OLD.max_provider_calls,
    OLD.max_output_tokens,OLD.max_estimated_cost_microusd) then
    raise exception 'Execution identity and budget are immutable';
  end if;
  if not ((OLD.state='AUTHORIZED' and NEW.state in ('RUNNING','FAILED','TIMEOUT')) or
    (OLD.state='RUNNING' and NEW.state in ('SUCCEEDED','FAILED','ABSTAINED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED'))) then
    raise exception 'Invalid execution transition';
  end if;
  if OLD.state='RUNNING' and NEW.started_at is distinct from OLD.started_at then
    raise exception 'Execution start is immutable';
  end if;
  return NEW;
end $$;
revoke all on function academic_execution_private.guard_provider_execution() from public, anon, authenticated, service_role;
create trigger guard_provider_execution_history before update or delete on public.academic_provider_executions
for each row execute function academic_execution_private.guard_provider_execution();

create function academic_execution_private.guard_provider_execution_usage() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Provider execution usage is append-only and immutable';
end $$;
revoke all on function academic_execution_private.guard_provider_execution_usage() from public, anon, authenticated, service_role;
create trigger guard_provider_execution_usage_history before update or delete on public.academic_provider_execution_usage
for each row execute function academic_execution_private.guard_provider_execution_usage();

-- Fires on every execution insert/update. When the row just became terminal
-- and a usage row already exists for it (FINALIZE always inserts usage
-- before updating execution state to terminal, in the same transaction),
-- the audit event embeds that same bounded, content-free usage snapshot --
-- one queryable trail tying usage immutably to its execution, without a
-- second trigger on the usage table.
create function academic_execution_private.audit_provider_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.academic_provider_execution_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'PROVIDER_EXECUTION_'||NEW.state,'academic_provider_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Professor provider-backed execution lifecycle',
    jsonb_build_object('execution_id',NEW.id,'student_id',NEW.student_id,'release_id',NEW.release_id,
      'invocation_id',NEW.invocation_id,'agent_profile',NEW.agent_profile,'policy_version',NEW.policy_version,
      'execution_kind',NEW.execution_kind,'state',NEW.state,'reason_code',NEW.reason_code,'budget_stage',NEW.budget_stage,
      'created_at',NEW.created_at,'authorized_at',NEW.authorized_at,'started_at',NEW.started_at,
      'terminal_at',NEW.terminal_at,'expires_at',NEW.expires_at,'review_path',NEW.review_path,
      'max_provider_calls',NEW.max_provider_calls,'max_output_tokens',NEW.max_output_tokens,
      'max_estimated_cost_microusd',NEW.max_estimated_cost_microusd,'usage',usage_snapshot),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function academic_execution_private.audit_provider_execution() from public, anon, authenticated, service_role;
create trigger audit_provider_execution_lifecycle after insert or update on public.academic_provider_executions
for each row execute function academic_execution_private.audit_provider_execution();

-- V2 canonical message: 22 LF-separated fields, no trailing LF, same
-- HMAC-SHA256 primitive and fixed-time comparison as migration 022's
-- verify_command, over the SAME controller secret (the trust root is the
-- key store, not a protocol-version-specific secret). A distinct protocol
-- tag and policy version make a V1 attestation structurally unable to
-- authorize any V2 transition and vice versa, even by accident, without
-- needing a second key.
--
--   DUCELIO_EXECUTION_HMAC_SHA256_V2
--   PROFESSOR_EXECUTION_V2
--   PROFESSOR
--   key_id
--   authenticated_app_user_id
--   execution_id
--   release_id
--   operation                 (AUTHORIZE|START|FINALIZE)
--   requested_state
--   requested_reason
--   requested_budget_stage    (NONE|PRE_CALL|POST_CALL)
--   max_provider_calls        (AUTHORIZE: proposed ceiling; else 0)
--   max_output_tokens         (AUTHORIZE: proposed ceiling; else 0)
--   max_estimated_cost_microusd (AUTHORIZE: proposed ceiling; else 0)
--   provider_calls             (FINALIZE: actual reported; else 0)
--   attempts                   (FINALIZE: actual reported; else 0)
--   input_tokens                (FINALIZE: actual reported; else 0)
--   output_tokens                (FINALIZE: actual reported; else 0)
--   estimated_cost_microusd    (FINALIZE: actual reported; else 0)
--   elapsed_ms                 (FINALIZE: actual reported; else 0)
--   issued_at_epoch_seconds
--   expires_at_epoch_seconds
create function academic_execution_private.verify_command_v2(
  p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_issued_at bigint,p_expires_at bigint,p_mac text
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
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','PROVIDER_COMPLETE',
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR',
      'INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED',
      'NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','NO_EXECUTION_PATH','HUMAN_REVIEW_REQUIRED','BUDGET_BLOCKED','EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls not between 0 and 3
    or p_max_output is null or p_max_output not between 0 and 4000
    or p_max_cost is null or p_max_cost not between 0 and 200000
    or p_calls is null or p_calls not between 0 and 3
    or p_attempts is null or p_attempts not between 0 and 3
    or p_input is null or p_input not between 0 and 1000000
    or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000
    or p_elapsed is null or p_elapsed not between 0 and 60000
    or p_issued_at is null or p_issued_at>stamp+5 or p_issued_at<stamp-10
    or p_expires_at is null or p_expires_at::numeric<>p_issued_at::numeric+10 or p_expires_at<=stamp
    or p_mac is null or length(p_mac)<>64 or p_mac !~ '^[0-9a-f]{64}$' then return false; end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id=p_key_id and revoked_at is null;
  if not found then return false; end if;
  canonical := concat_ws(E'\n','DUCELIO_EXECUTION_HMAC_SHA256_V2','PROFESSOR_EXECUTION_V2','PROFESSOR',
    p_key_id::text,public.current_app_user()::text,p_execution_id::text,p_release_id::text,
    p_operation,p_state,p_reason,p_budget_stage,
    p_max_calls::text,p_max_output::text,p_max_cost::text,
    p_calls::text,p_attempts::text,p_input::text,p_output::text,p_cost::text,p_elapsed::text,
    p_issued_at::text,p_expires_at::text);
  expected := extensions.hmac(convert_to(canonical,'UTF8'),key_bytes,'sha256');
  supplied := decode(p_mac,'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected,i) # get_byte(supplied,i)); end loop;
  return mismatch=0;
end $$;
revoke all on function academic_execution_private.verify_command_v2(
  uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) from public, anon, authenticated, service_role;

create function academic_execution_private.provider_execution_projection(p_id uuid,p_changed boolean) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'transitioned',p_changed,'execution',jsonb_build_object(
    'executionId',e.id,'studentId',e.student_id,'releaseId',e.release_id,'invocationId',e.invocation_id,
    'agentProfile',e.agent_profile,'policyVersion',e.policy_version,'executionKind',e.execution_kind,
    'state',e.state,'reasonCode',e.reason_code,'budgetStage',e.budget_stage,'createdAt',e.created_at,
    'authorizedAt',e.authorized_at,'startedAt',e.started_at,'terminalAt',e.terminal_at,'expiresAt',e.expires_at,
    'reviewPath',e.review_path,
    'budget',jsonb_build_object('maxProviderCalls',e.max_provider_calls,'maxOutputTokens',e.max_output_tokens,
      'maxEstimatedCostMicrousd',e.max_estimated_cost_microusd),
    'usage',(select jsonb_build_object('providerCalls',u.provider_calls,'attempts',u.attempts,
      'inputTokens',u.input_tokens,'outputTokens',u.output_tokens,
      'estimatedCostMicrousd',u.estimated_cost_microusd,'elapsedMs',u.elapsed_ms)
      from public.academic_provider_execution_usage u where u.execution_id=e.id)))
  from public.academic_provider_executions e where e.id=p_id and e.student_id=public.current_app_user()
$$;
revoke all on function academic_execution_private.provider_execution_projection(uuid,boolean) from public, anon, authenticated, service_role;

-- One finite command surface for V2, mirroring migration 022's
-- govern_professor_execution shape exactly (same trust model: authenticated
-- learner session + a valid server MAC for every transition), extended only
-- with an admitted, DB-ceiling-bounded nonzero provider budget and a
-- durable, content-free usage ledger written atomically with FINALIZE.
-- Not a generic SQL/RPC/audit writer: every field is typed and bounded: no
-- arbitrary caller/browser JSON, no free-form reason, no provider payload.
create function public.govern_professor_provider_execution(
  p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  release_record public.academic_content_releases%rowtype;
  execution_record public.academic_provider_executions%rowtype;
  stamp timestamptz;
  deadline timestamptz;
  denied text;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not academic_execution_private.verify_command_v2(p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,
    p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  -- Recheck freshness/revocation after any lock wait.
  if not academic_execution_private.verify_command_v2(p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,
    p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  update public.academic_provider_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
  where student_id=actor and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;
  perform public.expire_my_academic_content_releases();
  select * into release_record from public.academic_content_releases where id=p_release_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;

  if p_operation='AUTHORIZE' then
    if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
    if p_state<>'AUTHORIZED' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if exists(select 1 from public.academic_provider_executions where id=p_execution_id or release_id=p_release_id) then
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
    -- Versioned pre-production abuse ceilings, its own independent pool from
    -- migration 022's V1 envelope. Denied trusted admissions count too;
    -- caller cannot raise these DB-owned limits.
    if exists(select 1 from public.academic_provider_executions where student_id=actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.academic_provider_executions where student_id=actor and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.academic_provider_executions where student_id=actor and created_at>stamp-interval '1 hour')>=30 then
      denied := 'RATE_LIMITED';
    -- The DB-owned hard ceiling: a caller-proposed budget of zero (no
    -- provider calls requested at all) or anything exceeding the reviewed
    -- maximum is refused here, before any provider call, regardless of what
    -- a runtime profile or course/agent configuration proposed upstream.
    elsif p_max_calls<1 or p_max_calls>3 or p_max_output<1 or p_max_output>4000 or p_max_cost<1 or p_max_cost>200000 then
      denied := 'OUT_OF_ENVELOPE';
    end if;
    stamp := clock_timestamp();
    deadline := least(stamp+interval '20 seconds',release_record.expires_at);
    if deadline<=stamp then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
    -- A BLOCKED admission never becomes an admitted envelope: the proposed
    -- ceiling columns are not-null and range-checked (1..3 / 1..4000 /
    -- 1..200000) because they describe what THIS execution may actually
    -- spend once AUTHORIZED, which a BLOCKED row never is. A rejected
    -- proposal (possibly 0, or otherwise out of range) is therefore never
    -- written into them; the true rejected values are never needed again
    -- once state/reason_code record the denial itself, so a fixed valid
    -- placeholder is stored instead.
    insert into public.academic_provider_executions(
      id,student_id,release_id,invocation_id,state,reason_code,created_at,authorized_at,expires_at,terminal_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd
    ) values(p_execution_id,actor,p_release_id,release_record.invocation_id,
      case when denied is null then 'AUTHORIZED' else 'BLOCKED' end,denied,stamp,
      case when denied is null then stamp else null end,deadline,case when denied is null then null else stamp end,
      case when denied is null then p_max_calls else 1 end,
      case when denied is null then p_max_output else 1 end,
      case when denied is null then p_max_cost else 1 end);
    return academic_execution_private.provider_execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.academic_provider_executions
  where id=p_execution_id and student_id=actor and release_id=p_release_id;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    -- Captured terminal attestations never authorize a second accepted command.
    return jsonb_build_object('ok',false,'code',
      case when execution_record.reason_code='EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;
  -- START happens strictly while the surrounding academic-content release is
  -- still ACTIVE (inside that release's own consumer callback). FINALIZE
  -- happens strictly AFTER that same release has already closed by design
  -- (see the TypeScript composition boundary: FINALIZE is only ever called
  -- once withValidatedProfessorContent has returned and the release has
  -- already finalized), so it deliberately does NOT re-require an ACTIVE
  -- release: by the time FINALIZE runs, the release is expected to already
  -- be COMPLETED/ABORTED/EXPIRED, and re-requiring ACTIVE here would make
  -- every legitimate FINALIZE call fail. FINALIZE still independently
  -- checks the EXECUTION's own expiry immediately below, regardless of
  -- operation.
  if p_operation='START' then
    denied := case when not public.has_role('STUDENT') then 'POLICY_BLOCKED'
      when release_record.state<>'ACTIVE' or release_record.expires_at<=clock_timestamp() then 'CONTENT_RELEASE_UNAVAILABLE'
      when public.academic_content_release_explain_allowed() is not true then 'ACTIVITY_BLOCKED' else null end;
  end if;
  stamp := clock_timestamp();
  if stamp>=execution_record.expires_at then denied := 'EXECUTION_TIMEOUT'; stamp := execution_record.expires_at; end if;
  if denied is not null then
    update public.academic_provider_executions
    set state=case when denied='EXECUTION_TIMEOUT' then 'TIMEOUT' else 'FAILED' end,
        reason_code=denied,terminal_at=stamp
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code',denied);
  end if;

  if p_operation='START' then
    if p_state<>'RUNNING' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if execution_record.state='RUNNING' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.academic_provider_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return academic_execution_private.provider_execution_projection(p_execution_id,true);
  end if;

  -- FINALIZE: durably reconciles the actual reported provider usage AND
  -- terminalizes the execution, atomically, in one trusted transaction.
  -- Only reachable from RUNNING -- the whole point of this composition is
  -- that this call happens strictly AFTER the surrounding academic-content
  -- release has already closed successfully (see the TypeScript composition
  -- boundary); it is never called from inside the release's own consumer
  -- callback. A second FINALIZE for the same execution is REPLAY_REJECTED
  -- above (state no longer RUNNING), so usage can never be duplicated; a
  -- FINALIZE attempted while still AUTHORIZED (START skipped) is simply
  -- out of order, not a replay.
  if execution_record.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if not (
    (p_state='SUCCEEDED' and p_reason='PROVIDER_COMPLETE' and p_budget_stage='NONE') or
    -- EXECUTION_TIMEOUT: the controller's own genuine runtime-deadline
    -- observation (RuntimeResult outcome TIMEOUT), reported truthfully as a
    -- normal FINALIZE from RUNNING -- not to be confused with the separate
    -- TIMEOUT state below, reserved for the DB's own lazy-expiry sweep.
    (p_state='FAILED' and p_budget_stage='NONE' and p_reason in (
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE',
      'PROVIDER_REFUSED','PROVIDER_ERROR',
      'INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED',
      'EXECUTION_TIMEOUT')) or
    (p_state='ABSTAINED' and p_budget_stage='NONE' and p_reason in (
      'NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','NO_EXECUTION_PATH','POLICY_BLOCKED','ACTIVITY_BLOCKED')) or
    (p_state='ESCALATED' and p_reason='HUMAN_REVIEW_REQUIRED' and p_budget_stage='NONE') or
    (p_state='BUDGET_BLOCKED' and p_reason='BUDGET_BLOCKED' and p_budget_stage in ('PRE_CALL','POST_CALL')) or
    (p_state='CANCELLED' and p_reason='CANCELLED' and p_budget_stage='NONE')
  ) then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  -- Hard structural bound regardless of outcome: a controller can never
  -- report having made more provider calls than this execution was ever
  -- admitted for.
  if p_calls>execution_record.max_provider_calls then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  -- A controller reporting SUCCEEDED while its own reported usage already
  -- exceeds the admitted ceiling is self-contradictory: refuse rather than
  -- silently persist an impossible success.
  if p_state='SUCCEEDED' and (p_output>execution_record.max_output_tokens or p_cost>execution_record.max_estimated_cost_microusd) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;
  insert into public.academic_provider_execution_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);
  update public.academic_provider_executions
  set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
    review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
  where id=p_execution_id;
  return academic_execution_private.provider_execution_projection(p_execution_id,true);
end $$;
revoke all on function public.govern_professor_provider_execution(
  uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.govern_professor_provider_execution(
  uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) to authenticated;

-- Table REVOKE alone does not clear pre-existing column-level privileges
-- from Supabase-like broad defaults.
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.academic_provider_executions'::regclass,'public.academic_provider_execution_usage'::regclass
  ] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=protected_table and attnum>0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns,columns,columns,columns,protected_table);
  end loop;
end $$;

-- Effective-ACL acceptance: fail migration rather than silently inherit
-- unsafe rights from an unexpected hosted role membership. Never revoke the
-- authenticated learner's own grant on the one reviewed public RPC.
do $$ declare protected_table regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach protected_table in array array[
      'public.academic_provider_executions'::regclass,'public.academic_provider_execution_usage'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective provider-execution table privileges for %', r;
      end if;
    end loop;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='academic_execution_private' and p.proname in (
          'guard_provider_execution','guard_provider_execution_usage','audit_provider_execution',
          'verify_command_v2','provider_execution_projection'))
        or (n.nspname='public' and p.proname='govern_professor_provider_execution') loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname='govern_professor_provider_execution') then
        raise exception 'Unsafe effective provider-execution function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
