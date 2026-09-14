-- Commercial V1: governed Tutor / Lab Instructor provider-backed execution.
-- Additive only; migrations 001-027 are byte-for-byte unchanged. Migration
-- 021's academic_content_releases and migration 025's
-- academic_provider_executions remain hard-coded to agent_profile='PROFESSOR'
-- and are NOT edited or weakened -- Professor's existing release/execution
-- lifecycle, budgets and guarantees are untouched. This migration introduces
-- a SEPARATE, distinctly identifiable governance surface --
-- TUTOR_LAB_EXECUTION_V1 / PROVIDER_BACKED_V1 -- generalised across exactly
-- the two roles this checkpoint reviews (TUTOR, LAB_INSTRUCTOR), reusing
-- only the already-reviewed academic_execution_private.controller_keys trust
-- root (migration 022) under a distinct protocol tag, so a Professor V2
-- attestation can never authorize a Tutor/Lab transition and vice versa.
-- EXAMINER and COUNSELLOR remain structurally unable to reach this surface:
-- every table/function below is constrained to ('TUTOR','LAB_INSTRUCTOR')
-- only, and ROLES_WITH_REVIEWED_EXECUTION_PATH in
-- src/server/academic-runtime/index.ts is unmodified (still {PROFESSOR}) --
-- Tutor/Lab execution is composed through a SEPARATE boundary
-- (src/server/tutor-lab-execution), never by widening that set.
--
-- Handoff/practical provenance: public.delivery_handoffs (migration 023) is
-- NOT altered -- its status column is structurally locked to 'OPEN' by its
-- own CHECK constraint and its own immutability trigger forbids any update,
-- so a Tutor/Lab execution never invents a "resolved" handoff state; a
-- handoff stays visibly OPEN and a learner may request further support
-- against it. public.course_practicals (migration 027) also has no
-- practical_id column on delivery_handoffs to resolve from, so this
-- migration adds one small additive link table
-- (tutor_lab_handoff_practicals) populated only by a narrowly
-- CREATE-OR-REPLACEd public.request_practical_support (same signature
-- migration 027 defined; the function body is extended, migration 027's own
-- file is not touched) -- never by inferring a practical from title/order.
--
-- Mirrors migrations 022/024/025/026/027's ACL-hardening pattern throughout:
-- service_role has BYPASSRLS in this project's Supabase-like setup, so RLS
-- alone never protects these objects from it. Every table/function below is
-- explicitly revoked from public, anon, authenticated and service_role at
-- creation, closed by an effective-ACL assertion that fails this migration's
-- deployment if any of those roles retains unsafe inherited access.

do $$ begin
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions') then
    raise exception 'Tutor/Lab execution requires pgcrypto in extensions';
  end if;
end $$;

create schema tutor_lab_execution_private;
revoke all on schema tutor_lab_execution_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Practical provenance: additive link from a PRACTICAL_HELP handoff to the
-- exact institutional practical that generated it. Populated only at
-- request time (never inferred later), immutable once recorded.
-- ==========================================================================
create table public.tutor_lab_handoff_practicals (
  handoff_id uuid primary key references public.delivery_handoffs(id),
  practical_id uuid not null references public.course_practicals(id),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.tutor_lab_handoff_practicals enable row level security;
revoke all on public.tutor_lab_handoff_practicals from public, anon, authenticated, service_role;

create function tutor_lab_execution_private.guard_handoff_practical() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Handoff/practical provenance is immutable'; end $$;
revoke all on function tutor_lab_execution_private.guard_handoff_practical() from public, anon, authenticated, service_role;
create trigger guard_handoff_practical_immutable before update or delete on public.tutor_lab_handoff_practicals
for each row execute function tutor_lab_execution_private.guard_handoff_practical();

-- Extends migration 027's public.request_practical_support (same signature,
-- same authorization/ownership derivation) to additionally record which
-- exact practical a PRACTICAL_HELP (or PRACTICAL_PREREQUISITE) handoff came
-- from.
--
-- Correction pass (independent review, Blocker 1): request_delivery_handoff's
-- OWN idempotency identity (migration 023, unmodified) is
-- (requested_by, request_id), and its replay-equivalence check covers only
-- enrolment/lesson/objective/reason -- it structurally cannot know about
-- practical_id at all. Two different PRACTICAL_LAB (or EXERCISE) rows can
-- legitimately share the same lesson and therefore the same computed
-- reason/destination, so a replayed request_id with a DIFFERENT practical_id
-- would return the SAME handoff from request_delivery_handoff. The
-- provenance insert below is therefore no longer a bare
-- "on conflict do nothing": after the insert-or-noop (atomic, race-safe
-- under the table's own primary key), the ACTUAL stored practical_id for
-- this handoff is re-read and compared. Same practical + same request_id
-- remains idempotent (the stored link already matches); a different
-- practical replayed under the same request_id fails CONTEXT_CONFLICT
-- rather than silently keeping the original practical while reporting
-- success -- and this holds even when two callers race concurrently: the
-- primary key admits exactly one practical_id per handoff, and every other
-- racer's post-insert re-read sees that same, single, admitted value.
create or replace function public.request_practical_support(
  p_enrolment_id uuid, p_practical_id uuid, p_request_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.course_practicals; result uuid; linked_practical_id uuid;
begin
  e:=course_activation_private.student_enrolment(p_enrolment_id);
  select * into p from public.course_practicals where id=p_practical_id and programme_version_id=e.programme_version_id
    and exists(select 1 from public.course_activations a where a.import_id=course_practicals.import_id and a.cohort_id=e.cohort_id);
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  result := public.request_delivery_handoff(e.id,p.lesson_id,null,
    case when p.kind='PRACTICAL_LAB' then 'PRACTICAL_HELP' else 'PRACTICAL_PREREQUISITE' end,p_request_id);
  insert into public.tutor_lab_handoff_practicals(handoff_id,practical_id) values(result,p_practical_id)
    on conflict (handoff_id) do nothing;
  select practical_id into linked_practical_id from public.tutor_lab_handoff_practicals where handoff_id=result;
  if linked_practical_id is distinct from p_practical_id then raise exception 'CONTEXT_CONFLICT'; end if;
  return result;
end $$;

-- Resolves the exact institutional practical a PRACTICAL_HELP handoff refers
-- to, re-deriving ownership from the caller's own enrolment (never trusting
-- a caller-supplied practical id in isolation) and re-enforcing the exact
-- same EXPLAIN firewall migration 027's list_my_practicals already uses.
create function public.get_owned_practical(p_enrolment_id uuid, p_practical_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.course_practicals;
begin
  e:=course_activation_private.student_enrolment(p_enrolment_id);
  perform public.assert_academic_action_allowed('EXPLAIN');
  select * into p from public.course_practicals where id=p_practical_id and programme_version_id=e.programme_version_id
    and exists(select 1 from public.course_activations a where a.import_id=course_practicals.import_id and a.cohort_id=e.cohort_id);
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  return jsonb_build_object('id',p.id,'lessonId',p.lesson_id,'kind',p.kind,'title',p.title,'instructions',p.instructions,
    'position',p.position,
    'objectiveIds',(select coalesce(jsonb_agg(objective_id order by objective_id),'[]'::jsonb) from public.course_practical_objectives where practical_id=p.id));
end $$;
revoke all on function public.get_owned_practical(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_owned_practical(uuid,uuid) to authenticated;

-- ==========================================================================
-- Content release: generalised across TUTOR/LAB_INSTRUCTOR only, structurally
-- separate from Professor's agent_profile='PROFESSOR'-only
-- academic_content_releases (migration 021, untouched). Same 30-second
-- lease/lifecycle shape, bound instead to the exact handoff/enrolment/
-- lesson/objective/practical identifiers that prove scope for THIS role,
-- since Tutor/Lab context has no capability_name axis to select from --
-- content is fully determined by the owning handoff, never a caller choice.
-- ==========================================================================
create table public.tutor_lab_content_releases (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.student_profiles(user_id),
  invocation_id uuid not null,
  agent_profile text not null check(agent_profile in ('TUTOR','LAB_INSTRUCTOR')),
  enrolment_id uuid not null references public.enrolments(id),
  handoff_id uuid not null references public.delivery_handoffs(id),
  lesson_id uuid not null references public.lessons(id),
  objective_id uuid references public.lesson_objectives(id),
  practical_id uuid references public.course_practicals(id),
  state text not null check(state in ('ACTIVE','COMPLETED','ABORTED','EXPIRED','BLOCKED')),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  terminal_at timestamptz,
  unique(student_id, invocation_id),
  check(expires_at = started_at + interval '30 seconds'),
  check((state = 'ACTIVE' and terminal_at is null) or
        (state <> 'ACTIVE' and terminal_at is not null and terminal_at >= started_at)),
  check(state <> 'EXPIRED' or terminal_at = expires_at),
  check(state not in ('COMPLETED','ABORTED','BLOCKED') or terminal_at < expires_at),
  -- LAB_INSTRUCTOR always binds an exact practical; TUTOR never does (Tutor
  -- handoffs structurally have no practical -- see request_practical_support
  -- above, which only ever creates PRACTICAL_HELP/PRACTICAL_PREREQUISITE
  -- links for practicals, and PRACTICAL_PREREQUISITE routes to TUTOR without
  -- a practical binding here by design: the Tutor answers conceptually,
  -- never reading the practical row itself).
  check((agent_profile = 'LAB_INSTRUCTOR') = (practical_id is not null))
);
create index tutor_lab_content_release_active on public.tutor_lab_content_releases(student_id, expires_at)
  where state = 'ACTIVE';
alter table public.tutor_lab_content_releases enable row level security;
revoke all on public.tutor_lab_content_releases from public, anon, authenticated, service_role;

create function tutor_lab_execution_private.guard_content_release() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Release history cannot be deleted'; end if;
  if OLD.state <> 'ACTIVE' then raise exception 'Terminal release history is immutable'; end if;
  if row(NEW.id,NEW.student_id,NEW.invocation_id,NEW.agent_profile,NEW.enrolment_id,NEW.handoff_id,
      NEW.lesson_id,NEW.objective_id,NEW.practical_id,NEW.started_at,NEW.expires_at)
    is distinct from
     row(OLD.id,OLD.student_id,OLD.invocation_id,OLD.agent_profile,OLD.enrolment_id,OLD.handoff_id,
      OLD.lesson_id,OLD.objective_id,OLD.practical_id,OLD.started_at,OLD.expires_at) then
    raise exception 'Release identity is immutable';
  end if;
  if NEW.state not in ('COMPLETED','ABORTED','EXPIRED') then raise exception 'Invalid release transition'; end if;
  return NEW;
end $$;
revoke all on function tutor_lab_execution_private.guard_content_release() from public, anon, authenticated, service_role;
create trigger guard_tutor_lab_release_history before update or delete on public.tutor_lab_content_releases
for each row execute function tutor_lab_execution_private.guard_content_release();

-- Content-minimised audit: identifiers/state/timestamps only. No learner
-- message, provider response, practical instructions or lesson body ever
-- enters after_state -- there is structurally no column here for any of it.
create function tutor_lab_execution_private.audit_content_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'TUTOR_LAB_RELEASE_'||NEW.state,'tutor_lab_content_releases',NEW.id,'TUTOR_LAB_SUPPORT_V1',
    'Tutor/Lab content release authorization lifecycle',
    jsonb_build_object('release_id',NEW.id,'student_id',NEW.student_id,'agent_profile',NEW.agent_profile,
      'enrolment_id',NEW.enrolment_id,'handoff_id',NEW.handoff_id,'lesson_id',NEW.lesson_id,
      'objective_id',NEW.objective_id,'practical_id',NEW.practical_id,'invocation_id',NEW.invocation_id,
      'state',NEW.state,'started_at',NEW.started_at,'expires_at',NEW.expires_at,'terminal_at',NEW.terminal_at),
    clock_timestamp());
  return NEW;
end $$;
revoke all on function tutor_lab_execution_private.audit_content_release() from public, anon, authenticated, service_role;
create trigger audit_tutor_lab_release_lifecycle after insert or update on public.tutor_lab_content_releases
for each row execute function tutor_lab_execution_private.audit_content_release();

create function public.expire_my_tutor_lab_content_releases() returns void
language sql security definer set search_path='' as $$
  update public.tutor_lab_content_releases set state='EXPIRED',terminal_at=expires_at
  where student_id=public.current_app_user() and state='ACTIVE' and expires_at<=clock_timestamp()
$$;
revoke all on function public.expire_my_tutor_lab_content_releases() from public, anon, authenticated, service_role;

-- Derives role, ownership and reason-specific selector requirements ENTIRELY
-- server-side from the handoff itself -- the caller supplies no role at all,
-- eliminating "forged role" as a possibility by construction. Fails closed
-- BEFORE opening a release for: a handoff not owned by the caller (proving
-- BOTH current_app_user()=handoff.requested_by AND enrolment.student_id=
-- current_app_user()), an unknown/mismatched reason code, OBJECTIVE_
-- REINFORCEMENT missing its required objective, or (for LAB_INSTRUCTOR) a
-- PRACTICAL_HELP handoff whose linked practical cannot be re-verified as
-- belonging to the caller's own activated cohort/version.
create function public.begin_tutor_lab_content_release(p_invocation_id uuid, p_handoff_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; h public.delivery_handoffs; e public.enrolments; pr public.course_practicals;
  role_name text; release_id uuid; stamp timestamptz; allowed boolean;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if p_invocation_id is null or p_handoff_id is null then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;

  select * into h from public.delivery_handoffs where id=p_handoff_id;
  if h.id is null or h.requested_by<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into e from public.enrolments where id=h.enrolment_id;
  if e.id is null or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  role_name := h.destination_profile;
  if role_name not in ('TUTOR','LAB_INSTRUCTOR') then return jsonb_build_object('ok',false,'code','NO_EXECUTION_PATH'); end if;

  if role_name='TUTOR' then
    if h.reason_code not in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE') then
      return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
    end if;
    if h.reason_code='OBJECTIVE_REINFORCEMENT' and h.objective_id is null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
  else
    if h.reason_code<>'PRACTICAL_HELP' then return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT'); end if;
    select cp.* into pr from public.tutor_lab_handoff_practicals b
      join public.course_practicals cp on cp.id=b.practical_id
      where b.handoff_id=h.id and cp.programme_version_id=e.programme_version_id
        and exists(select 1 from public.course_activations a where a.import_id=cp.import_id and a.cohort_id=e.cohort_id);
    if pr.id is null then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  end if;

  perform public.expire_my_tutor_lab_content_releases();
  if exists(select 1 from public.tutor_lab_content_releases where student_id=actor and invocation_id=p_invocation_id) then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  allowed := e.status='ACTIVE' and public.academic_content_release_explain_allowed();
  stamp := clock_timestamp();
  insert into public.tutor_lab_content_releases(
    student_id,invocation_id,agent_profile,enrolment_id,handoff_id,lesson_id,objective_id,practical_id,
    state,started_at,expires_at,terminal_at
  ) values(actor,p_invocation_id,role_name,e.id,h.id,h.lesson_id,h.objective_id,
    case when role_name='LAB_INSTRUCTOR' then pr.id else null end,
    case when allowed then 'ACTIVE' else 'BLOCKED' end,stamp,stamp+interval '30 seconds',
    case when allowed then null else stamp end) returning id into release_id;
  if not allowed then return jsonb_build_object('ok',false,'code','ACTIVITY_BLOCKED'); end if;
  -- Correction pass (independent review, Blocker 2): the authoritative
  -- handoff reason -- never the role name, and never a browser-supplied
  -- value -- is returned here so provider context construction can use the
  -- real reason (MISSED_LESSON_PRACTICE/OBJECTIVE_REINFORCEMENT/
  -- PRACTICAL_PREREQUISITE/PRACTICAL_HELP) instead of mistaking "TUTOR" or
  -- "LAB_INSTRUCTOR" for a reason code.
  return jsonb_build_object('ok',true,'release_id',release_id,'student_id',actor,'invocation_id',p_invocation_id,
    'role',role_name,'reason_code',h.reason_code,'enrolment_id',e.id,'lesson_id',h.lesson_id,
    'objective_id',h.objective_id,
    'practical_id',case when role_name='LAB_INSTRUCTOR' then pr.id else null end);
end $$;
revoke all on function public.begin_tutor_lab_content_release(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.begin_tutor_lab_content_release(uuid,uuid) to authenticated;

create function public.close_tutor_lab_content_release(p_release_id uuid, p_complete boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; r public.tutor_lab_content_releases; e public.enrolments; terminal_state text; stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if p_complete is null then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  perform public.expire_my_tutor_lab_content_releases();
  select * into r from public.tutor_lab_content_releases where id=p_release_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  if r.state<>'ACTIVE' then return jsonb_build_object('ok',true,'state',r.state,'transitioned',false); end if;
  select * into e from public.enrolments where id=r.enrolment_id;
  terminal_state := case when p_complete and public.has_role('STUDENT') and e.status='ACTIVE'
    and public.academic_content_release_explain_allowed() then 'COMPLETED' else 'ABORTED' end;
  stamp := clock_timestamp();
  if stamp>=r.expires_at then terminal_state:='EXPIRED'; stamp:=r.expires_at; end if;
  update public.tutor_lab_content_releases set state=terminal_state,terminal_at=stamp where id=r.id;
  return jsonb_build_object('ok',true,'state',terminal_state,'transitioned',true);
end $$;
revoke all on function public.close_tutor_lab_content_release(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.close_tutor_lab_content_release(uuid,boolean) to authenticated;

-- ==========================================================================
-- Provider execution: generalised across TUTOR/LAB_INSTRUCTOR, structurally
-- separate from migration 025's agent_profile='PROFESSOR'-only
-- academic_provider_executions (untouched). Same AUTHORIZE/START/FINALIZE
-- lifecycle and MAC-attested transition model, deliberately tighter budget
-- envelope (max_provider_calls is fixed at exactly 1 -- no demonstrated need
-- for a multi-call Tutor/Lab response). Correction pass (independent
-- review, truth-sync): the reused, provider-neutral runtime harness's own
-- retry loop checks providerCalls>=maxProviderCalls BEFORE each attempt, so
-- once this DB ceiling admits max_provider_calls=1, a second provider
-- attempt is structurally unreachable regardless of the runtime profile's
-- own maxAttempts value. The production TUTOR_COMMERCIAL_V1/
-- LAB_INSTRUCTOR_COMMERCIAL_V1 profiles set maxAttempts=1 to say this
-- truthfully: exactly one provider attempt/call per Tutor/Lab interaction,
-- never a retry.
-- ==========================================================================
create table public.tutor_lab_provider_executions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(user_id),
  release_id uuid not null unique references public.tutor_lab_content_releases(id),
  invocation_id uuid not null,
  agent_profile text not null check(agent_profile in ('TUTOR','LAB_INSTRUCTOR')),
  policy_version text not null default 'TUTOR_LAB_EXECUTION_V1' check(policy_version='TUTOR_LAB_EXECUTION_V1'),
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
  max_provider_calls integer not null check(max_provider_calls=1),
  max_output_tokens integer not null check(max_output_tokens between 1 and 2000),
  max_estimated_cost_microusd bigint not null check(max_estimated_cost_microusd between 1 and 100000),
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
create index tutor_lab_provider_executions_admission on public.tutor_lab_provider_executions(student_id,created_at);
create index tutor_lab_provider_executions_active on public.tutor_lab_provider_executions(student_id,expires_at)
  where state in ('AUTHORIZED','RUNNING');
alter table public.tutor_lab_provider_executions enable row level security;
revoke all on public.tutor_lab_provider_executions from public, anon, authenticated, service_role;

-- Durable, content-free usage ledger, identical shape to migration 025's.
create table public.tutor_lab_provider_execution_usage (
  execution_id uuid primary key references public.tutor_lab_provider_executions(id),
  provider_calls integer not null check(provider_calls between 0 and 1),
  attempts integer not null check(attempts between 0 and 3),
  input_tokens integer not null check(input_tokens between 0 and 1000000),
  output_tokens integer not null check(output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint not null check(estimated_cost_microusd between 0 and 1000000000),
  elapsed_ms integer not null check(elapsed_ms between 0 and 60000),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.tutor_lab_provider_execution_usage enable row level security;
revoke all on public.tutor_lab_provider_execution_usage from public, anon, authenticated, service_role;

create function tutor_lab_execution_private.guard_provider_execution() returns trigger
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
revoke all on function tutor_lab_execution_private.guard_provider_execution() from public, anon, authenticated, service_role;
create trigger guard_tutor_lab_provider_execution_history before update or delete on public.tutor_lab_provider_executions
for each row execute function tutor_lab_execution_private.guard_provider_execution();

create function tutor_lab_execution_private.guard_provider_execution_usage() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Provider execution usage is append-only and immutable'; end $$;
revoke all on function tutor_lab_execution_private.guard_provider_execution_usage() from public, anon, authenticated, service_role;
create trigger guard_tutor_lab_provider_execution_usage_history before update or delete on public.tutor_lab_provider_execution_usage
for each row execute function tutor_lab_execution_private.guard_provider_execution_usage();

create function tutor_lab_execution_private.audit_provider_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare usage_snapshot jsonb;
begin
  if NEW.terminal_at is not null then
    select jsonb_build_object(
      'providerCalls',u.provider_calls,'attempts',u.attempts,'inputTokens',u.input_tokens,
      'outputTokens',u.output_tokens,'estimatedCostMicrousd',u.estimated_cost_microusd,
      'elapsedMs',u.elapsed_ms,'recordedAt',u.recorded_at)
      into usage_snapshot
    from public.tutor_lab_provider_execution_usage u where u.execution_id=NEW.id;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state,occurred_at)
  values(NEW.student_id,'TUTOR_LAB_EXECUTION_'||NEW.state,'tutor_lab_provider_executions',NEW.id,
    case when NEW.reason_code='EXECUTION_TIMEOUT' then 'DATABASE_EXECUTION_POLICY' else 'ATTESTED_EXECUTION_CONTROLLER' end,
    'Tutor/Lab provider-backed execution lifecycle',
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
revoke all on function tutor_lab_execution_private.audit_provider_execution() from public, anon, authenticated, service_role;
create trigger audit_tutor_lab_provider_execution_lifecycle after insert or update on public.tutor_lab_provider_executions
for each row execute function tutor_lab_execution_private.audit_provider_execution();

-- V1 canonical message for this new surface: identical field order/shape to
-- migration 025's V2 message, with the hard-coded 'PROFESSOR' literal
-- replaced by the caller-declared p_role (still verified against the bound
-- release's own agent_profile before any state transition below) and a
-- distinct protocol tag/policy version, over the SAME controller secret.
--   DUCELIO_EXECUTION_HMAC_TUTOR_LAB_V1
--   TUTOR_LAB_EXECUTION_V1
--   role                       (TUTOR|LAB_INSTRUCTOR)
--   key_id / actor / execution_id / release_id / operation / requested_state
--   requested_reason / requested_budget_stage
--   max_provider_calls / max_output_tokens / max_estimated_cost_microusd
--   provider_calls / attempts / input_tokens / output_tokens /
--   estimated_cost_microusd / elapsed_ms
--   issued_at_epoch_seconds / expires_at_epoch_seconds
create function tutor_lab_execution_private.verify_command_tl1(
  p_role text,p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns boolean language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; canonical text; mismatch integer := 0; stamp numeric;
begin
  stamp := extract(epoch from clock_timestamp());
  if public.current_app_user() is null or p_role not in ('TUTOR','LAB_INSTRUCTOR')
    or p_key_id is null or p_execution_id is null or p_release_id is null
    or p_operation is null or p_operation not in ('AUTHORIZE','START','FINALIZE')
    or p_state is null or p_state not in ('AUTHORIZED','RUNNING','SUCCEEDED','FAILED','ABSTAINED','ESCALATED','BUDGET_BLOCKED','TIMEOUT','CANCELLED')
    or p_reason is null or p_reason not in ('NONE','PROVIDER_COMPLETE',
      'PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_INVALID_RESPONSE','PROVIDER_REFUSED','PROVIDER_ERROR',
      'INTERNAL_ERROR','OUTPUT_INVALID','POLICY_BLOCKED','CONTENT_RELEASE_UNAVAILABLE','ACTIVITY_BLOCKED',
      'NO_PROVIDER_CONFIGURED','UNKNOWN_MODEL_PROFILE','NO_EXECUTION_PATH','HUMAN_REVIEW_REQUIRED','BUDGET_BLOCKED','EXECUTION_TIMEOUT','CANCELLED')
    or p_budget_stage is null or p_budget_stage not in ('NONE','PRE_CALL','POST_CALL')
    or p_max_calls is null or p_max_calls not between 0 and 1
    or p_max_output is null or p_max_output not between 0 and 2000
    or p_max_cost is null or p_max_cost not between 0 and 100000
    or p_calls is null or p_calls not between 0 and 1
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
  canonical := concat_ws(E'\n','DUCELIO_EXECUTION_HMAC_TUTOR_LAB_V1','TUTOR_LAB_EXECUTION_V1',p_role,
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
revoke all on function tutor_lab_execution_private.verify_command_tl1(
  text,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) from public, anon, authenticated, service_role;

create function tutor_lab_execution_private.provider_execution_projection(p_id uuid,p_changed boolean) returns jsonb
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
      from public.tutor_lab_provider_execution_usage u where u.execution_id=e.id)))
  from public.tutor_lab_provider_executions e where e.id=p_id and e.student_id=public.current_app_user()
$$;
revoke all on function tutor_lab_execution_private.provider_execution_projection(uuid,boolean) from public, anon, authenticated, service_role;

-- One finite command surface for TUTOR/LAB_INSTRUCTOR, mirroring migration
-- 025's govern_professor_provider_execution shape exactly (same trust
-- model: authenticated learner session + a valid server MAC for every
-- transition), generalised over p_role rather than fixed to PROFESSOR. Not
-- a generic SQL/RPC/audit writer: every field is typed and bounded, no
-- arbitrary caller/browser JSON, no free-form reason, no provider payload.
create function public.govern_tutor_lab_provider_execution(
  p_role text,p_key_id uuid,p_execution_id uuid,p_release_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid; release_record public.tutor_lab_content_releases%rowtype;
  execution_record public.tutor_lab_provider_executions%rowtype; stamp timestamptz; deadline timestamptz; denied text;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not tutor_lab_execution_private.verify_command_tl1(p_role,p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,
    p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if not tutor_lab_execution_private.verify_command_tl1(p_role,p_key_id,p_execution_id,p_release_id,p_operation,p_state,p_reason,
    p_budget_stage,p_max_calls,p_max_output,p_max_cost,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  update public.tutor_lab_provider_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
  where student_id=actor and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;
  perform public.expire_my_tutor_lab_content_releases();
  select * into release_record from public.tutor_lab_content_releases where id=p_release_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
  if release_record.agent_profile<>p_role then return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT'); end if;

  if p_operation='AUTHORIZE' then
    if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
    if p_state<>'AUTHORIZED' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if exists(select 1 from public.tutor_lab_provider_executions where id=p_execution_id or release_id=p_release_id) then
      return jsonb_build_object('ok',false,'code','REPLAY_REJECTED');
    end if;
    if release_record.state<>'ACTIVE' or release_record.expires_at<=clock_timestamp() then
      return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE');
    end if;
    if public.academic_content_release_explain_allowed() is not true then
      return jsonb_build_object('ok',false,'code','ACTIVITY_BLOCKED');
    end if;
    if exists(select 1 from public.tutor_lab_provider_executions where student_id=actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.tutor_lab_provider_executions where student_id=actor and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.tutor_lab_provider_executions where student_id=actor and created_at>stamp-interval '1 hour')>=30 then
      denied := 'RATE_LIMITED';
    elsif p_max_calls<>1 or p_max_output<1 or p_max_output>2000 or p_max_cost<1 or p_max_cost>100000 then
      denied := 'OUT_OF_ENVELOPE';
    end if;
    stamp := clock_timestamp();
    deadline := least(stamp+interval '20 seconds',release_record.expires_at);
    if deadline<=stamp then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
    insert into public.tutor_lab_provider_executions(
      id,student_id,release_id,invocation_id,agent_profile,state,reason_code,created_at,authorized_at,expires_at,terminal_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd
    ) values(p_execution_id,actor,p_release_id,release_record.invocation_id,p_role,
      case when denied is null then 'AUTHORIZED' else 'BLOCKED' end,denied,stamp,
      case when denied is null then stamp else null end,deadline,case when denied is null then null else stamp end,
      1,case when denied is null then p_max_output else 1 end,case when denied is null then p_max_cost else 1 end);
    return tutor_lab_execution_private.provider_execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.tutor_lab_provider_executions
  where id=p_execution_id and student_id=actor and release_id=p_release_id and agent_profile=p_role;
  if not found then return jsonb_build_object('ok',false,'code','CONTENT_RELEASE_UNAVAILABLE'); end if;
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    return jsonb_build_object('ok',false,'code',
      case when execution_record.reason_code='EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;

  if p_operation='START' then
    denied := case when not public.has_role('STUDENT') then 'POLICY_BLOCKED'
      when release_record.state<>'ACTIVE' or release_record.expires_at<=clock_timestamp() then 'CONTENT_RELEASE_UNAVAILABLE'
      when public.academic_content_release_explain_allowed() is not true then 'ACTIVITY_BLOCKED' else null end;
  end if;
  stamp := clock_timestamp();
  if stamp>=execution_record.expires_at then denied := 'EXECUTION_TIMEOUT'; stamp := execution_record.expires_at; end if;
  if denied is not null then
    update public.tutor_lab_provider_executions
    set state=case when denied='EXECUTION_TIMEOUT' then 'TIMEOUT' else 'FAILED' end,reason_code=denied,terminal_at=stamp
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code',denied);
  end if;

  if p_operation='START' then
    if p_state<>'RUNNING' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if execution_record.state='RUNNING' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.tutor_lab_provider_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return tutor_lab_execution_private.provider_execution_projection(p_execution_id,true);
  end if;

  if execution_record.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if not (
    (p_state='SUCCEEDED' and p_reason='PROVIDER_COMPLETE' and p_budget_stage='NONE') or
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
  if p_calls>execution_record.max_provider_calls then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
  if p_state='SUCCEEDED' and (p_output>execution_record.max_output_tokens or p_cost>execution_record.max_estimated_cost_microusd) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;
  insert into public.tutor_lab_provider_execution_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);
  update public.tutor_lab_provider_executions
  set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
    review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
  where id=p_execution_id;
  return tutor_lab_execution_private.provider_execution_projection(p_execution_id,true);
end $$;
revoke all on function public.govern_tutor_lab_provider_execution(
  text,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.govern_tutor_lab_provider_execution(
  text,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,integer,integer,integer,integer,bigint,integer,bigint,bigint,text
) to authenticated;

-- ==========================================================================
-- Idempotency: durable per-learner reservation, keyed by (student_id,
-- idempotency_key) -- mirrors migration 026's
-- professor_classroom_interaction_reservations pattern exactly (a single
-- atomic insert ... on conflict do nothing, never a "compare against the
-- latest key" design). A replay with the SAME key and the SAME
-- handoff+message fingerprint is a safe duplicate (no second provider call);
-- a replay with the SAME key but a DIFFERENT handoff or message fails
-- closed as a conflict, never silently proceeding with new content under an
-- old reservation. No learner prose is stored -- only its SHA-256 digest.
-- ==========================================================================
create table public.tutor_lab_interaction_reservations (
  student_id uuid not null references public.student_profiles(user_id),
  idempotency_key uuid not null,
  handoff_id uuid not null references public.delivery_handoffs(id),
  request_hash text not null check(length(request_hash)=64),
  reserved_at timestamptz not null,
  primary key(student_id, idempotency_key)
);
alter table public.tutor_lab_interaction_reservations enable row level security;
revoke all on public.tutor_lab_interaction_reservations from public, anon, authenticated, service_role;

create function tutor_lab_execution_private.guard_interaction_reservation() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Tutor/Lab interaction reservations are immutable: they cannot be updated or deleted'; end $$;
revoke all on function tutor_lab_execution_private.guard_interaction_reservation() from public, anon, authenticated, service_role;
create trigger guard_tutor_lab_reservation_immutable before update or delete on public.tutor_lab_interaction_reservations
for each row execute function tutor_lab_execution_private.guard_interaction_reservation();

-- Correction pass (independent review, Blocker 5): handoff ownership is now
-- proven HERE, before any reservation row is ever written -- not left to
-- the later release-open authorization alone, since by then a foreign
-- handoff would already have an immutable reservation row created against
-- it. Proves BOTH current_app_user()=handoff.requested_by AND
-- enrolment.student_id=current_app_user() for the handoff's own
-- enrolment_id, exactly like begin_tutor_lab_content_release. A missing
-- handoff and a real-but-foreign handoff return the identical bounded
-- NOT_FOUND_OR_FORBIDDEN result (two separate lookups, but the same
-- indistinguishable outcome either way) -- never revealing whether a given
-- UUID belongs to someone else. A multi-role STUDENT+staff account gets no
-- wider scope: ownership is checked by exact identity equality, never role.
create function public.reserve_tutor_lab_interaction(p_handoff_id uuid, p_idempotency_key uuid, p_request_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; prior public.tutor_lab_interaction_reservations; stamp timestamptz; inserted_count int;
  h public.delivery_handoffs; e public.enrolments;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if p_handoff_id is null or p_idempotency_key is null or p_request_hash is null or length(p_request_hash)<>64
    or p_request_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;
  select * into h from public.delivery_handoffs where id=p_handoff_id;
  if h.id is null or h.requested_by<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into e from public.enrolments where id=h.enrolment_id;
  if e.id is null or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
  stamp := clock_timestamp();
  insert into public.tutor_lab_interaction_reservations(student_id,idempotency_key,handoff_id,request_hash,reserved_at)
  values(actor,p_idempotency_key,p_handoff_id,p_request_hash,stamp)
  on conflict (student_id,idempotency_key) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count>0 then return jsonb_build_object('ok',true,'duplicate',false); end if;
  select * into prior from public.tutor_lab_interaction_reservations where student_id=actor and idempotency_key=p_idempotency_key;
  if prior.request_hash<>p_request_hash or prior.handoff_id<>p_handoff_id then
    return jsonb_build_object('ok',false,'code','DUPLICATE_KEY_CONFLICT');
  end if;
  return jsonb_build_object('ok',true,'duplicate',true);
end $$;
revoke all on function public.reserve_tutor_lab_interaction(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_tutor_lab_interaction(uuid,uuid,text) to authenticated;

-- ==========================================================================
-- ACL hardening: table/schema/function/column revokes plus effective
-- privilege acceptance, mirroring migrations 022/024/025/026/027 exactly.
-- ==========================================================================
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.tutor_lab_handoff_practicals'::regclass,'public.tutor_lab_content_releases'::regclass,
    'public.tutor_lab_provider_executions'::regclass,'public.tutor_lab_provider_execution_usage'::regclass,
    'public.tutor_lab_interaction_reservations'::regclass
  ] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=protected_table and attnum>0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns,columns,columns,columns,protected_table);
  end loop;
end $$;

do $$ declare protected_table regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach protected_table in array array[
      'public.tutor_lab_handoff_practicals'::regclass,'public.tutor_lab_content_releases'::regclass,
      'public.tutor_lab_provider_executions'::regclass,'public.tutor_lab_provider_execution_usage'::regclass,
      'public.tutor_lab_interaction_reservations'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective tutor/lab table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r,'tutor_lab_execution_private','USAGE,CREATE') then
      raise exception 'Unsafe effective tutor/lab schema privileges for %', r;
    end if;
    -- expire_my_tutor_lab_content_releases is an internal helper only ever
    -- called from inside another SECURITY DEFINER function's own body
    -- (which executes with the definer's privileges regardless of the
    -- caller's grants) -- exactly like migration 021's
    -- expire_my_academic_content_releases, it is never directly granted to
    -- authenticated and must show zero effective privilege for every role.
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='tutor_lab_execution_private'
         or (n.nspname='public' and p.proname in (
           'begin_tutor_lab_content_release','close_tutor_lab_content_release','expire_my_tutor_lab_content_releases',
           'govern_tutor_lab_provider_execution','reserve_tutor_lab_interaction','get_owned_practical',
           'request_practical_support'
         )) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname in (
          'begin_tutor_lab_content_release','close_tutor_lab_content_release',
          'govern_tutor_lab_provider_execution','reserve_tutor_lab_interaction','get_owned_practical',
          'request_practical_support'
        )) then
        raise exception 'Unsafe effective tutor/lab function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
