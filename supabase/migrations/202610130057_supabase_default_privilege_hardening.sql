-- LR-BASELINE-01: close function privileges that hosted Supabase default
-- privileges left open, and stop future functions inheriting them.
-- Migrations 001-056 are byte-for-byte unchanged.
--
-- Hosted facts (read-only, acceptance project, 2026-10-13):
-- * Every Ducelio function is owned by `postgres`, the non-superuser role
--   migrations run as. `postgres` is not a member of `supabase_admin`.
-- * pg_default_acl for `postgres` IN SCHEMA public grants EXECUTE on every
--   new function to anon, authenticated and service_role explicitly.
-- * `postgres` has no global (all-schema) default entry for functions, so
--   PostgreSQL's built-in default also grants EXECUTE to PUBLIC, of which
--   anon and authenticated are members.
-- * `postgres` can create functions only in public, its own Ducelio
--   *_private schemas, `extensions` (pgcrypto, uuid-ossp,
--   pg_stat_statements; 48 of its 49 functions there rely on that PUBLIC
--   default) and `supabase_migrations`.
--
-- Phase 1-2 migrations wrote `revoke all ... from public` and then granted
-- authenticated, which does not remove the explicit anon grant. Every
-- drifting function was created in migrations 003-019. The local PGlite
-- chain never emulated the anon/authenticated defaults, which is why this
-- was not caught by the existing suites.
--
-- 1. apply_objective_mastery_policy is an internal helper, called only by
--    record_learning_evidence (SECURITY DEFINER, as its owner). Migration
--    014 granted it to no role. With the hosted default, any authenticated
--    caller could invoke it through PostgREST with a caller-chosen trigger
--    evidence row and a caller-chosen p_actor, re-deriving mastery "as of"
--    older evidence (e.g. NEEDS_REINFORCEMENT -> DEMONSTRATED) and
--    appending history attributed to another user. It is now executable by
--    no API role.
-- 2. The 52 phase 1-2 public RPCs below were designed for authenticated
--    callers only: each resolves the actor internally and refuses a missing
--    one, every application call site authenticates first, and every RLS
--    policy that calls one is `to authenticated`. Anon EXECUTE is removed so
--    unauthenticated callers are denied by privilege, not only by function
--    bodies. Authenticated grants are unchanged.
-- 3. Long-term control: a function `postgres` creates from now on gets no
--    EXECUTE for PUBLIC, anon, authenticated or service_role unless its
--    migration grants it explicitly, as every reviewed RPC already does.
--    PUBLIC's built-in default is kept, explicitly, in every other schema
--    `postgres` can create functions in (`extensions`, `supabase_migrations`)
--    so future extension installs behave exactly as today.
--
-- Not changed here: the four public RPCs the migrations intentionally grant
-- to anon (list/get_commercial_v1_offer(s), fulfill_commercial_v1_order,
-- apply_commercial_v1_commerce_operation); existing trigger functions
-- (EXECUTE is only checked at CREATE TRIGGER, never when a trigger fires);
-- service_role grants on the phase 1-2 RPCs (left for independent review);
-- default privileges of supabase_admin, supabase_auth_admin or any other
-- Supabase-managed role, and of `postgres` in schemas it cannot create
-- functions in (e.g. storage); table and sequence defaults; and any object
-- not created by a Ducelio migration.

revoke all on function public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

do $$
declare
  signatures text[] := array[
  'public.academic_action_allowed(text)',
  'public.add_assessment_question(uuid, integer, text, integer, text, text, text)',
  'public.assert_academic_action_allowed(text)',
  'public.assign_counsellor(uuid, uuid, text)',
  'public.can_correct_official_records()',
  'public.can_read_assessment(uuid)',
  'public.can_read_assessment_attempt(uuid)',
  'public.can_read_assessment_response(uuid)',
  'public.can_read_assignment(uuid)',
  'public.can_read_assignment_submission(uuid)',
  'public.can_read_attendance(uuid)',
  'public.can_read_class_session(uuid)',
  'public.can_read_identity(uuid)',
  'public.can_read_learning_evidence(uuid)',
  'public.can_read_lesson_progress(uuid)',
  'public.can_read_objective_mastery(uuid)',
  'public.can_read_objective_mastery_history(uuid)',
  'public.can_read_student(uuid)',
  'public.can_read_version(uuid)',
  'public.can_support(uuid)',
  'public.change_assessment_status(uuid, text, text)',
  'public.change_assignment_status(uuid, text, text)',
  'public.change_class_session_status(uuid, text, text)',
  'public.change_enrolment_status(uuid, text, text)',
  'public.create_assessment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, integer, integer, text)',
  'public.create_assignment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text)',
  'public.create_enrolment(uuid, uuid, text)',
  'public.create_learning_resource(uuid, text, text, text, text, integer, text)',
  'public.create_lesson_segment(uuid, text, integer, text)',
  'public.create_study_plan_item(uuid, uuid, text, date)',
  'public.create_support_followup(uuid, uuid, text, date)',
  'public.current_academic_activity_state()',
  'public.current_app_user()',
  'public.has_role(platform_role)',
  'public.is_academic_admin()',
  'public.is_assigned_counsellor(uuid)',
  'public.list_assessment_authoring_questions(uuid)',
  'public.list_assignable_counsellors()',
  'public.list_assignable_instructors()',
  'public.list_my_class_sessions()',
  'public.mark_institutional_notification_read(uuid)',
  'public.record_attendance(uuid, uuid, text, text)',
  'public.record_counsellor_interaction(uuid, text)',
  'public.record_learning_evidence(uuid, uuid, uuid, text, text, text, text, text)',
  'public.record_lesson_progress(uuid, uuid, uuid, text, text)',
  'public.refresh_deterministic_support_triggers(text)',
  'public.registrar_correct_attendance_status(uuid, text, text)',
  'public.registrar_correct_enrolment_status(uuid, text, text)',
  'public.start_assessment_attempt(uuid)',
  'public.submit_assignment(uuid, text, text)',
  'public.update_draft_assignment(uuid, text, text, timestamp with time zone, timestamp with time zone, text)',
  'public.void_assessment_attempt(uuid, text)'
  ];
  signature text;
begin
  foreach signature in array signatures loop
    -- The regprocedure cast fails the migration if a signature is missing.
    execute format('revoke execute on function %s from anon', signature::regprocedure);
  end loop;

  -- Migration-time self-verification of exactly what this migration owns.
  foreach signature in array signatures loop
    if has_function_privilege('anon', signature::regprocedure, 'execute') then
      raise exception 'anon still has EXECUTE on %', signature;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid)', 'execute')
    or has_function_privilege('service_role', 'public.apply_objective_mastery_policy(uuid,uuid,uuid,uuid)', 'execute') then
    raise exception 'apply_objective_mastery_policy is still executable by an API role';
  end if;
end $$;

-- 3. Default privileges for functions created by the migration role.
do $$
declare
  owner_role regrole := (
    select proowner::regrole from pg_catalog.pg_proc
    where oid = 'public.record_learning_evidence(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure
  );
  preserved text;
  probe_ok boolean;
begin
  -- The policy is written for the role that owns Ducelio's functions.
  if owner_role <> 'postgres'::regrole or current_user <> 'postgres' then
    raise exception 'migration 057 expects to run as postgres, the owner of Ducelio functions';
  end if;

  alter default privileges for role postgres in schema public
    revoke execute on functions from anon, authenticated, service_role;

  -- Keep PUBLIC's built-in default, explicitly, in every schema other than
  -- public and Ducelio's own private schemas where postgres can create
  -- functions. Per-schema grants are added to the global entry below.
  for preserved in
    select n.nspname from pg_catalog.pg_namespace n
    where pg_catalog.has_schema_privilege('postgres', n.oid, 'CREATE')
      and n.nspname <> 'public'
      and n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema'
      and not (n.nspname ~ '_private$' and n.nspowner = 'postgres'::regrole)
  loop
    execute format(
      'alter default privileges for role postgres in schema %I grant execute on functions to public',
      preserved
    );
  end loop;

  -- A global entry replaces PostgreSQL's built-in PUBLIC default for
  -- postgres-created functions. service_role is included so no global grant
  -- to it can survive either (hosted has none; this is then a no-op).
  alter default privileges for role postgres
    revoke execute on functions from public, service_role;

  -- Self-verification: a new internal SECURITY DEFINER function in public
  -- is executable by no API role until a migration grants it.
  create function public.ducelio_057_default_acl_probe() returns integer
    language sql security definer set search_path = '' as 'select 1';
  probe_ok := not (
    has_function_privilege('public', 'public.ducelio_057_default_acl_probe()', 'execute')
    or has_function_privilege('anon', 'public.ducelio_057_default_acl_probe()', 'execute')
    or has_function_privilege('authenticated', 'public.ducelio_057_default_acl_probe()', 'execute')
    or has_function_privilege('service_role', 'public.ducelio_057_default_acl_probe()', 'execute')
  );
  drop function public.ducelio_057_default_acl_probe();
  if not probe_ok then
    raise exception 'a new public function is still executable by an API role by default';
  end if;

  -- Self-verification: the preserved schemas still default to PUBLIC.
  for preserved in
    select n.nspname from pg_catalog.pg_namespace n
    where pg_catalog.has_schema_privilege('postgres', n.oid, 'CREATE')
      and n.nspname <> 'public'
      and n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema'
      and not (n.nspname ~ '_private$' and n.nspowner = 'postgres'::regrole)
  loop
    if not exists (
      select 1 from pg_catalog.pg_default_acl d,
        lateral pg_catalog.aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole
        and d.defaclnamespace = preserved::regnamespace
        and d.defaclobjtype = 'f'
        and a.grantee = 0
        and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'the PUBLIC function default was not preserved in schema %', preserved;
    end if;
  end loop;
end $$;
