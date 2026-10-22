-- Shared AI execution reliability. Additive: migrations 001-063 are
-- unchanged, including the reviewed governance functions of migrations 025
-- (govern_professor_provider_execution) and 028
-- (govern_tutor_lab_provider_execution). It closes two gaps that apply to
-- the cohort and Academy Professor, Tutor and Lab Instructor alike, with two
-- new controller-attested commands over the existing controller key store:
--
-- 1. Late usage. An execution may expire (20 seconds) while its provider
--    call is still running. The FINALIZE that reports the call then arrives
--    after expiry, and the governance correctly refuses it as
--    EXECUTION_TIMEOUT (marking the execution TIMEOUT if its own sweep had
--    not already), but writes no usage row, so real provider spend is
--    missing from the ledger. record_late_provider_execution_usage records
--    exactly that usage, once, for a TIMEOUT execution that had STARTED. It
--    never changes the execution's state: a timed-out execution stays
--    TIMEOUT and its output never becomes a success. It admits nothing, so
--    no budget ceiling is touched; the usage is bounded by the execution's
--    own admitted call count and the ledger's own column checks.
--
-- 2. Pre-START cleanup. FINALIZE is accepted only from RUNNING, so an
--    execution that was AUTHORIZED but could not START (a provenance
--    refusal, a transport failure, a policy change) could not be closed by
--    the controller and held the learner's single active execution until
--    expiry, blocking their next request. abandon_unstarted_provider_
--    execution terminalises an AUTHORIZED execution as FAILED (or TIMEOUT,
--    if it has already expired) immediately. No provider call can have
--    happened before START, so no usage exists to record.
--
-- Both commands carry their own protocol tag, so no execution, provenance,
-- memory or note attestation can authorise either, and vice versa. Both
-- bind to the authenticated learner and the execution's own release, and
-- take the shared learner-profile lock before the execution row lock,
-- exactly as the governance functions do.

create table public.provider_execution_late_usage (
  id uuid primary key default gen_random_uuid(),
  execution_kind text not null check (execution_kind in ('PROFESSOR_PROVIDER_V2','TUTOR_LAB_PROVIDER_V1')),
  professor_execution_id uuid unique references public.academic_provider_executions(id),
  tutor_lab_execution_id uuid unique references public.tutor_lab_provider_executions(id),
  student_id uuid not null references public.student_profiles(user_id),
  recorded_at timestamptz not null default clock_timestamp(),
  check ((execution_kind = 'PROFESSOR_PROVIDER_V2') = (professor_execution_id is not null)),
  check ((execution_kind = 'TUTOR_LAB_PROVIDER_V1') = (tutor_lab_execution_id is not null))
);
alter table public.provider_execution_late_usage enable row level security;
revoke all on table public.provider_execution_late_usage from public, anon, authenticated, service_role;

create schema execution_reliability_private;
revoke all on schema execution_reliability_private from public, anon, authenticated, service_role;

create function execution_reliability_private.immutable_row() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'IMMUTABLE_HISTORY' using errcode = '55000'; end $$;
create trigger guard_history before update or delete on public.provider_execution_late_usage
for each row execute function execution_reliability_private.immutable_row();

create function public.record_late_provider_execution_usage(
  p_kind text, p_key_id uuid, p_execution_id uuid, p_release_id uuid,
  p_calls integer, p_attempts integer, p_input integer, p_output integer, p_cost bigint, p_elapsed integer,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
  px public.academic_provider_executions%rowtype; tx public.tutor_lab_provider_executions%rowtype;
  st text; reason text; started timestamptz; expires timestamptz; max_calls integer; has_usage boolean;
begin
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  if p_kind is null or p_kind not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')
    or p_execution_id is null or p_release_id is null
    or p_calls is null or p_calls not between 0 and 3 or p_attempts is null or p_attempts not between 0 and 3
    or p_input is null or p_input not between 0 and 1000000 or p_output is null or p_output not between 0 and 1000000
    or p_cost is null or p_cost not between 0 and 1000000000 or p_elapsed is null or p_elapsed not between 0 and 60000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_LATE_PROVIDER_USAGE_HMAC_SHA256_V1', p_kind, p_key_id::text, actor::text,
      p_execution_id::text, p_release_id::text,
      p_calls::text, p_attempts::text, p_input::text, p_output::text, p_cost::text, p_elapsed::text,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  -- Shared lock order: learner profile, then the execution row. Parallel
  -- attempts for one execution therefore serialise, and the second sees the
  -- first one's usage row.
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_kind = 'PROFESSOR' then
    select * into px from public.academic_provider_executions
      where id = p_execution_id and student_id = actor and release_id = p_release_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    st := px.state; reason := px.reason_code; started := px.started_at; expires := px.expires_at;
    max_calls := px.max_provider_calls;
    has_usage := exists (select 1 from public.academic_provider_execution_usage where execution_id = px.id);
  else
    select * into tx from public.tutor_lab_provider_executions
      where id = p_execution_id and student_id = actor and release_id = p_release_id and agent_profile = p_kind for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    st := tx.state; reason := tx.reason_code; started := tx.started_at; expires := tx.expires_at;
    max_calls := tx.max_provider_calls;
    has_usage := exists (select 1 from public.tutor_lab_provider_execution_usage where execution_id = tx.id);
  end if;
  -- Exactly once: usage already in the ledger (from FINALIZE or an earlier
  -- late report) is never duplicated or replaced.
  if has_usage then return jsonb_build_object('ok', false, 'code', 'ALREADY_RECORDED'); end if;
  -- Only an execution that timed out after it STARTED can have spent
  -- provider usage the ledger is missing.
  if st <> 'TIMEOUT' or reason is distinct from 'EXECUTION_TIMEOUT' or started is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  end if;
  if clock_timestamp() > expires + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'LATE_USAGE_WINDOW_CLOSED');
  end if;
  -- Never more provider calls than this execution was admitted for.
  if p_calls > max_calls or p_attempts < p_calls then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if p_kind = 'PROFESSOR' then
    insert into public.academic_provider_execution_usage(execution_id, provider_calls, attempts, input_tokens,
      output_tokens, estimated_cost_microusd, elapsed_ms)
    values (px.id, p_calls, p_attempts, p_input, p_output, p_cost, p_elapsed);
    insert into public.provider_execution_late_usage(execution_kind, professor_execution_id, student_id)
    values ('PROFESSOR_PROVIDER_V2', px.id, actor);
  else
    insert into public.tutor_lab_provider_execution_usage(execution_id, provider_calls, attempts, input_tokens,
      output_tokens, estimated_cost_microusd, elapsed_ms)
    values (tx.id, p_calls, p_attempts, p_input, p_output, p_cost, p_elapsed);
    insert into public.provider_execution_late_usage(execution_kind, tutor_lab_execution_id, student_id)
    values ('TUTOR_LAB_PROVIDER_V1', tx.id, actor);
  end if;
  -- Content-free audit: identifiers and usage counts only.
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state, occurred_at)
  values (actor, 'PROVIDER_EXECUTION_LATE_USAGE_RECORDED',
    case when p_kind = 'PROFESSOR' then 'academic_provider_executions' else 'tutor_lab_provider_executions' end,
    p_execution_id, 'ATTESTED_EXECUTION_CONTROLLER', 'Provider usage reported after execution expiry',
    jsonb_build_object('execution_id', p_execution_id, 'role', p_kind, 'state', st,
      'usage', jsonb_build_object('providerCalls', p_calls, 'attempts', p_attempts, 'inputTokens', p_input,
        'outputTokens', p_output, 'estimatedCostMicrousd', p_cost, 'elapsedMs', p_elapsed)),
    clock_timestamp());
  return jsonb_build_object('ok', true, 'state', st);
end $$;

create function public.abandon_unstarted_provider_execution(
  p_kind text, p_key_id uuid, p_execution_id uuid, p_release_id uuid, p_reason text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
  px public.academic_provider_executions%rowtype; tx public.tutor_lab_provider_executions%rowtype;
  st text; expires timestamptz; stamp timestamptz; final_state text;
begin
  if actor is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'); end if;
  if p_kind is null or p_kind not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')
    or p_execution_id is null or p_release_id is null
    or p_reason is null or p_reason not in ('INTERNAL_ERROR','POLICY_BLOCKED','ACTIVITY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_ABANDON_PROVIDER_EXECUTION_HMAC_SHA256_V1', p_kind, p_key_id::text, actor::text,
      p_execution_id::text, p_release_id::text, p_reason,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  perform 1 from public.student_profiles where user_id = actor for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_kind = 'PROFESSOR' then
    select * into px from public.academic_provider_executions
      where id = p_execution_id and student_id = actor and release_id = p_release_id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    st := px.state; expires := px.expires_at;
  else
    select * into tx from public.tutor_lab_provider_executions
      where id = p_execution_id and student_id = actor and release_id = p_release_id and agent_profile = p_kind for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
    st := tx.state; expires := tx.expires_at;
  end if;
  -- A started execution may have called the provider: only FINALIZE, with
  -- its real usage, may close it.
  if st = 'RUNNING' then return jsonb_build_object('ok', false, 'code', 'EXECUTION_RUNNING'); end if;
  -- Already terminal (finalized, refused, timed out, blocked): nothing to do.
  if st <> 'AUTHORIZED' then return jsonb_build_object('ok', true, 'state', st, 'transitioned', false); end if;
  stamp := clock_timestamp();
  -- Same outcome the governance's own lazy sweep would record once expired.
  final_state := case when stamp >= expires then 'TIMEOUT' else 'FAILED' end;
  if p_kind = 'PROFESSOR' then
    update public.academic_provider_executions
    set state = final_state,
        reason_code = case when final_state = 'TIMEOUT' then 'EXECUTION_TIMEOUT' else p_reason end,
        terminal_at = case when final_state = 'TIMEOUT' then expires else stamp end
    where id = px.id;
  else
    update public.tutor_lab_provider_executions
    set state = final_state,
        reason_code = case when final_state = 'TIMEOUT' then 'EXECUTION_TIMEOUT' else p_reason end,
        terminal_at = case when final_state = 'TIMEOUT' then expires else stamp end
    where id = tx.id;
  end if;
  return jsonb_build_object('ok', true, 'state', final_state, 'transitioned', true);
end $$;

-- ==========================================================================
-- Privileges, verified.
-- ==========================================================================
revoke all on function execution_reliability_private.immutable_row() from public, anon, authenticated, service_role;
revoke all on function public.record_late_provider_execution_usage(
  text,uuid,uuid,uuid,integer,integer,integer,integer,bigint,integer,bigint,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.record_late_provider_execution_usage(
  text,uuid,uuid,uuid,integer,integer,integer,integer,bigint,integer,bigint,bigint,text) to authenticated;
revoke all on function public.abandon_unstarted_provider_execution(
  text,uuid,uuid,uuid,text,bigint,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.abandon_unstarted_provider_execution(
  text,uuid,uuid,uuid,text,bigint,bigint,text) to authenticated;

do $$ declare r text; columns text; begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns
    from pg_attribute where attrelid = 'public.provider_execution_late_usage'::regclass and attnum > 0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.provider_execution_late_usage from public, anon, authenticated, service_role',
    columns, columns, columns, columns);
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(r, 'public.provider_execution_late_usage', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r, 'public.provider_execution_late_usage', 'SELECT,INSERT,UPDATE,REFERENCES')
      or has_function_privilege(r, 'execution_reliability_private.immutable_row()', 'EXECUTE') then
      raise exception 'Unsafe execution reliability privileges for %', r;
    end if;
    if has_function_privilege(r, 'public.record_late_provider_execution_usage(text,uuid,uuid,uuid,integer,integer,integer,integer,bigint,integer,bigint,bigint,text)', 'EXECUTE')
        is distinct from (r = 'authenticated')
      or has_function_privilege(r, 'public.abandon_unstarted_provider_execution(text,uuid,uuid,uuid,text,bigint,bigint,text)', 'EXECUTE')
        is distinct from (r = 'authenticated') then
      raise exception 'Unsafe execution reliability function privileges for %', r;
    end if;
  end loop;
end $$;
