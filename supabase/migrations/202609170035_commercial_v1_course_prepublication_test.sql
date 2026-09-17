-- Commercial V1: governed course test-before-publish gate.
-- Additive/corrective only; migrations 001-034 are unmodified. This adds an
-- append-only pre-publication test ledger and makes database publication
-- authority (not the UI) require a current passing test before a
-- package-linked ProgrammeVersion may publish.
--
-- Frozen invariant this migration enforces: "A course package may not
-- publish unless a persisted successful pre-publication test exists for the
-- exact package/version/configuration state being published."
--
-- Scope note: this is a deterministic governed integrity/readiness check --
-- stored package content re-validation, exact package/version binding, and
-- exact five-role agent-configuration match against the reviewed package
-- proposal. It never calls an external model/provider, never evaluates
-- model output quality, and is not hosted/production acceptance; those
-- remain separate Commercial V1 release gates (see docs/18 and docs/29).
--
-- Mirrors the migration 022/023/024 ACL-hardening pattern: service_role has
-- BYPASSRLS in this project's Supabase-like setup, so RLS alone never
-- protects new objects from it. Every new table/function is explicitly
-- revoked from public, anon, authenticated and service_role, and a closing
-- effective-ACL assertion fails this migration's deployment if any of those
-- roles retains unsafe inherited access. Only authenticated ever receives an
-- explicit, reviewed EXECUTE grant, and only on the reviewed public RPCs.

------------------------------------------------------------------
-- LEDGER TABLE
------------------------------------------------------------------

-- Append-only. One row per attempted pre-publication test run, PASS or FAIL.
-- No free-form diagnostic content: failure_code is a small closed
-- vocabulary and failed_roles is bounded to the five reviewed role names.
-- Never stores raw_package content, exception text or PostgREST/SQL detail.
create table public.course_package_test_runs (
  id uuid primary key default gen_random_uuid(),
  run_sequence bigint generated always as identity unique,
  import_id uuid not null,
  programme_version_id uuid not null,
  test_policy_version text not null check(test_policy_version = 'COURSE_PREPUBLICATION_TEST_V1'),
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check(outcome in ('PASS','FAIL')),
  failure_code text check(failure_code is null or failure_code in (
    'PACKAGE_REVALIDATION_FAILED','MATERIALIZED_STATE_MISMATCH',
    'CONFIGURATION_INCOMPLETE','CONFIGURATION_MISMATCH'
  )),
  failed_roles text[] not null default '{}'
    check(failed_roles <@ array['PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR']),
  run_by uuid not null references public.app_users(id),
  run_at timestamptz not null default clock_timestamp(),
  check(
    (outcome = 'PASS' and failure_code is null and coalesce(array_length(failed_roles,1),0) = 0)
    or
    (outcome = 'FAIL' and failure_code is not null)
  ),
  foreign key(import_id, programme_version_id)
    references public.course_package_imports(id, programme_version_id)
);

create index course_package_test_runs_lookup
  on public.course_package_test_runs(import_id, programme_version_id, test_policy_version, fingerprint, run_sequence desc);
create index course_package_test_runs_import
  on public.course_package_test_runs(import_id, run_sequence desc);

-- No direct table access at all: only the reviewed RPCs below expose safe,
-- bounded results. service_role is revoked explicitly too (see header);
-- BYPASSRLS does not bypass object ACLs.
alter table public.course_package_test_runs enable row level security;
revoke all on public.course_package_test_runs from public, anon, authenticated, service_role;

-- Immutable history: no UPDATE, no DELETE, ever, regardless of role. This is
-- the real backstop (not the column-level REVOKE below, which only limits
-- ordinary grantees) because it applies unconditionally in plpgsql.
create function public.guard_course_package_test_run_history() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Course package test run history is immutable';
end $$;

create trigger guard_course_package_test_run_history
before update or delete on public.course_package_test_runs
for each row execute function public.guard_course_package_test_run_history();

-- No protected content is ever written to this table, so the full row is
-- safe to audit without redaction (unlike course_package_imports/
-- academic_agent_configs, which redact raw_package/instructional_notes).
create function public.audit_course_package_test_run() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(
    actor_id, action, target_type, target_id, reason, before_state, after_state
  ) values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, NEW.id,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed course package pre-publication test'),
    null, to_jsonb(NEW)
  );
  return NEW;
end $$;

create trigger audit_change
after insert on public.course_package_test_runs
for each row execute function public.audit_course_package_test_run();

------------------------------------------------------------------
-- PRIVATE HELPERS
------------------------------------------------------------------

-- Shared publication-actor/reason authorization, reused by
-- publish_programme_version, publish_course_package and (indirectly, via
-- its own inline check) run_course_package_test, so the identical rule is
-- never duplicated into independently-drifting copies.
create function course_engineering_private.require_publication_actor(p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded publication reason is required';
  end if;
  return actor;
end $$;

-- The exact prior body of publish_programme_version (migration 006), minus
-- its own auth/reason check (now the caller's responsibility via
-- require_publication_actor, so both public entry points share one
-- lock/status/audit/update implementation instead of duplicating it). The
-- existing prepare_programme_publication trigger (migration 006) still
-- fires on this UPDATE and still enforces the completeness/snapshot rules.
create function course_engineering_private.publish_version_unconditional(
  p_version_id uuid, p_actor uuid, p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare current_status text;
begin
  select status into current_status
  from public.programme_versions
  where id = p_version_id
  for update;

  if not found then
    raise exception 'Programme version not found';
  end if;

  if current_status = 'PUBLISHED' then
    return p_version_id;
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.programme_versions
  set status = 'PUBLISHED', published_by = p_actor
  where id = p_version_id;

  return p_version_id;
end $$;

-- V2 correction: the package's own content_hash is the raw UPLOADED JSON,
-- never what apply_course_package actually MATERIALISED into institutional
-- tables -- and migration 024's apply_course_package updates the SHARED
-- `programmes` row (title/examination_body/qualification_name) on every
-- later revision of the same package_key, while migration 006's
-- prepare_programme_publication reads that CURRENT live row at publish
-- time rather than a per-version snapshot taken at Apply. Content-hash-only
-- binding therefore let a later revision's Apply silently change what an
-- earlier, already-tested revision would snapshot at publish -- the tested
-- state and the published state could diverge. See
-- materialized_content_hash_from_live/_from_package and
-- compute_materialized_state_hash below, which close this by binding the
-- database's own current institutional materialisation, independent of the
-- immutable raw_package content hash.
--
-- Given the same programme/version, this is a pure function of current
-- materialised institutional content -- see materialized_content_hash_from_
-- live's own comment for the exact canonical shape and why module/lesson/
-- objective/resource row ids are deliberately excluded from it.
create function course_engineering_private.materialized_content_hash_from_live(
  p_programme_id uuid, p_programme_version_id uuid
) returns text
language plpgsql set search_path='' as $$
declare
  programme_record public.programmes%rowtype;
  version_record public.programme_versions%rowtype;
  module_record record;
  lesson_record record;
  objective_record record;
  resource_record record;
  modules_json jsonb := '[]'::jsonb;
  lessons_json jsonb;
  objectives_json jsonb;
  resources_json jsonb;
  material text;
begin
  select * into programme_record from public.programmes where id = p_programme_id;
  select * into version_record from public.programme_versions where id = p_programme_version_id;

  for module_record in
    select id, title, position from public.modules
    where programme_version_id = p_programme_version_id order by position
  loop
    lessons_json := '[]'::jsonb;
    for lesson_record in
      select id, title, position from public.lessons
      where module_id = module_record.id and programme_version_id = p_programme_version_id
      order by position
    loop
      objectives_json := '[]'::jsonb;
      for objective_record in
        select description, position from public.lesson_objectives
        where lesson_id = lesson_record.id and programme_version_id = p_programme_version_id
        order by position
      loop
        objectives_json := objectives_json || jsonb_build_array(jsonb_build_object(
          'description', objective_record.description, 'position', objective_record.position
        ));
      end loop;

      resources_json := '[]'::jsonb;
      for resource_record in
        select kind, title, body, url, position from public.learning_resources
        where lesson_id = lesson_record.id and programme_version_id = p_programme_version_id
        order by position
      loop
        resources_json := resources_json || jsonb_build_array(jsonb_build_object(
          'kind', resource_record.kind, 'title', resource_record.title,
          'body', resource_record.body, 'url', resource_record.url,
          'position', resource_record.position
        ));
      end loop;

      lessons_json := lessons_json || jsonb_build_array(jsonb_build_object(
        'title', lesson_record.title, 'position', lesson_record.position,
        'objectives', objectives_json, 'resources', resources_json
      ));
    end loop;

    modules_json := modules_json || jsonb_build_array(jsonb_build_object(
      'title', module_record.title, 'position', module_record.position, 'lessons', lessons_json
    ));
  end loop;

  -- Deliberately excludes every module/lesson/objective/resource row id:
  -- those are random UUIDs assigned at apply time with no package
  -- semantics (COURSE_PACKAGE_V1 identifies them by key, never stored
  -- institutionally). Position-ordered hierarchy plus title/description/
  -- body/url/kind is the exact materialisable subset apply_course_package
  -- actually writes (assignment/assessment templates and practical
  -- activities are never materialised -- see apply_course_package's own
  -- comment -- so they are correctly absent here too).
  material := jsonb_build_object(
    'programme', jsonb_build_object(
      'title', programme_record.title,
      'examinationBody', programme_record.examination_body,
      'qualificationName', programme_record.qualification_name
    ),
    'curriculumVersion', jsonb_build_object('label', version_record.label),
    'modules', modules_json
  )::text;

  return encode(extensions.digest(material, 'sha256'), 'hex');
end $$;

-- Same canonical content shape as materialized_content_hash_from_live
-- above, computed instead from the package's own immutable raw_package --
-- never from a caller-supplied projection. Used only to compare against
-- the live hash (evaluate_materialized_readiness below); never itself part
-- of the publication fingerprint, since a package alone has no database
-- identity to bind.
create function course_engineering_private.materialized_content_hash_from_package(p_raw_package jsonb) returns text
language plpgsql set search_path='' as $$
declare
  module_item jsonb;
  lesson_item jsonb;
  objective_item jsonb;
  resource_item jsonb;
  modules_json jsonb := '[]'::jsonb;
  lessons_json jsonb;
  objectives_json jsonb;
  resources_json jsonb;
  material text;
begin
  for module_item in
    select value from jsonb_array_elements(p_raw_package->'modules') order by (value->>'position')::integer
  loop
    lessons_json := '[]'::jsonb;
    for lesson_item in
      select value from jsonb_array_elements(module_item->'lessons') order by (value->>'position')::integer
    loop
      objectives_json := '[]'::jsonb;
      for objective_item in
        select value from jsonb_array_elements(lesson_item->'objectives') order by (value->>'position')::integer
      loop
        objectives_json := objectives_json || jsonb_build_array(jsonb_build_object(
          'description', objective_item->>'description',
          'position', (objective_item->>'position')::integer
        ));
      end loop;

      resources_json := '[]'::jsonb;
      for resource_item in
        select value from jsonb_array_elements(lesson_item->'resources') order by (value->>'position')::integer
      loop
        resources_json := resources_json || jsonb_build_array(jsonb_build_object(
          'kind', resource_item->>'kind', 'title', resource_item->>'title',
          'body', resource_item->>'body', 'url', resource_item->>'url',
          'position', (resource_item->>'position')::integer
        ));
      end loop;

      lessons_json := lessons_json || jsonb_build_array(jsonb_build_object(
        'title', lesson_item->>'title', 'position', (lesson_item->>'position')::integer,
        'objectives', objectives_json, 'resources', resources_json
      ));
    end loop;

    modules_json := modules_json || jsonb_build_array(jsonb_build_object(
      'title', module_item->>'title', 'position', (module_item->>'position')::integer,
      'lessons', lessons_json
    ));
  end loop;

  material := jsonb_build_object(
    'programme', jsonb_build_object(
      'title', p_raw_package->'programme'->>'title',
      'examinationBody', p_raw_package->'programme'->>'examinationBody',
      'qualificationName', p_raw_package->'programme'->>'qualificationName'
    ),
    'curriculumVersion', jsonb_build_object('label', p_raw_package->'curriculumVersion'->>'label'),
    'modules', modules_json
  )::text;

  return encode(extensions.digest(material, 'sha256'), 'hex');
end $$;

-- Independent, database-owned verification that the CURRENT materialised
-- institutional state still corresponds exactly to the package that was
-- applied. Two independent things must both hold, since neither implies the
-- other:
--
--   1. Content equality -- content only (titles/positions/descriptions/
--      bodies/urls), never row counts alone: a changed title, body, url or
--      position anywhere in the tree makes the two hashes differ.
--   2. Identity/binding equality (V3 correction) -- a privileged mutation
--      that repoints the bound programme_version at a DIFFERENT (but
--      otherwise entirely valid) programme, or repoints the shared
--      programmes row's slug away from this import's package_key, leaves
--      every module/lesson/objective/resource row (and therefore the
--      content-only hash) completely unchanged, because that content is
--      keyed by programme_version_id, never by programme_id or slug.
--      Content equality alone would silently miss exactly that drift, so
--      the binding itself is independently re-checked here too, not merely
--      inferred from the foreign keys already stored on import_record.
--
-- False when the import has no bound programme/version yet, or when either
-- check fails.
create function course_engineering_private.evaluate_materialized_readiness(p_import_id uuid) returns boolean
language plpgsql set search_path='' as $$
declare
  import_record public.course_package_imports%rowtype;
  programme_record public.programmes%rowtype;
  version_record public.programme_versions%rowtype;
  live_hash text;
  package_hash text;
begin
  select * into import_record from public.course_package_imports where id = p_import_id;
  if not found then
    raise exception 'Course package import not found';
  end if;
  if import_record.programme_id is null or import_record.programme_version_id is null then
    return false;
  end if;

  select * into programme_record from public.programmes where id = import_record.programme_id;
  if not found then
    return false;
  end if;
  select * into version_record from public.programme_versions where id = import_record.programme_version_id;
  if not found
    or programme_record.id is distinct from import_record.programme_id
    or programme_record.slug is distinct from import_record.package_key
    or version_record.id is distinct from import_record.programme_version_id
    or version_record.programme_id is distinct from import_record.programme_id
  then
    return false;
  end if;

  live_hash := course_engineering_private.materialized_content_hash_from_live(
    import_record.programme_id, import_record.programme_version_id
  );
  package_hash := course_engineering_private.materialized_content_hash_from_package(import_record.raw_package);

  return live_hash = package_hash;
end $$;

-- The materialised-state component of the publication fingerprint: binds
-- programme/version IDENTITY (programmes.id/slug, programme_versions.id/
-- programme_id/status -- deliberately included despite being database
-- UUIDs, unlike the content-tree row ids above, because these specifically
-- identify WHICH shared programme/version this state belongs to, which is
-- exactly the identity a later revision's Apply can silently redirect)
-- together with the exact same live content hash
-- evaluate_materialized_readiness independently verifies against the
-- package.
create function course_engineering_private.compute_materialized_state_hash(p_import_id uuid) returns text
language plpgsql set search_path='' as $$
declare
  import_record public.course_package_imports%rowtype;
  programme_record public.programmes%rowtype;
  version_record public.programme_versions%rowtype;
  content_hash_v text;
  material text;
begin
  select * into import_record from public.course_package_imports where id = p_import_id;
  if not found then
    raise exception 'Course package import not found';
  end if;
  if import_record.programme_id is null or import_record.programme_version_id is null then
    raise exception 'Course package import has no bound programme';
  end if;

  select * into programme_record from public.programmes where id = import_record.programme_id;
  select * into version_record from public.programme_versions where id = import_record.programme_version_id;

  content_hash_v := course_engineering_private.materialized_content_hash_from_live(
    import_record.programme_id, import_record.programme_version_id
  );

  material := programme_record.id::text || '|' || programme_record.slug || '|'
    || version_record.id::text || '|' || version_record.programme_id::text || '|'
    || version_record.status || '|' || content_hash_v;

  return encode(extensions.digest(material, 'sha256'), 'hex');
end $$;

-- Authoritative publication fingerprint. The caller supplies only the
-- import id; every other input (content hash, programme-version id, the
-- current materialised institutional state and the exact five current
-- agent-configuration rows) is derived here, directly from current
-- database state, never accepted from a caller. This is what makes the
-- fingerprint trustworthy: no caller-supplied hash, config JSON or
-- materialised-state projection can ever substitute for what is actually
-- stored right now.
--
-- Binds: literal policy version 'COURSE_PREPUBLICATION_TEST_V1', the import
-- id, the programme-version id, the package's own immutable content_hash,
-- the current materialised-state hash (compute_materialized_state_hash --
-- see its own comment; this is the V2 correction closing the shared-
-- programme divergence described above), and -- in fixed role order
-- (PROFESSOR, TUTOR, LAB_INSTRUCTOR, EXAMINER, COUNSELLOR) -- each role's
-- policy_version/enabled/model_profile_ref/instructional_notes/sorted-
-- capabilities/escalation_policy, or an explicit "not configured" marker
-- when no row exists for that role. Deliberately excludes created_at/
-- updated_at/audit reason/actor/config row id: none of those are semantic
-- publication state, and including them would make an unrelated timestamp
-- change silently invalidate an otherwise-identical PASS. Capabilities are
-- sorted before hashing because array order is not semantically meaningful
-- in the domain contract (src/domain/course-package.ts's
-- agentRoleConfigSchema.capabilities is an unordered set).
create function course_engineering_private.compute_publication_fingerprint(p_import_id uuid) returns text
language plpgsql set search_path='' as $$
declare
  import_record public.course_package_imports%rowtype;
  role_names text[] := array['PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR'];
  role_name text;
  config_record public.academic_agent_configs%rowtype;
  canonical jsonb := '[]'::jsonb;
  materialized_hash text;
  material text;
begin
  select * into import_record from public.course_package_imports where id = p_import_id;
  if not found then
    raise exception 'Course package import not found';
  end if;
  if import_record.programme_version_id is null then
    raise exception 'Course package import has no bound programme version';
  end if;

  materialized_hash := course_engineering_private.compute_materialized_state_hash(p_import_id);

  foreach role_name in array role_names loop
    select * into config_record
    from public.academic_agent_configs
    where programme_version_id = import_record.programme_version_id and role = role_name;

    if found then
      canonical := canonical || jsonb_build_array(jsonb_build_object(
        'role', config_record.role,
        'policyVersion', config_record.policy_version,
        'enabled', config_record.enabled,
        'modelProfileRef', config_record.model_profile_ref,
        'instructionalNotes', config_record.instructional_notes,
        'capabilities', to_jsonb(array(select unnest(config_record.capabilities) order by 1)),
        'escalationPolicy', config_record.escalation_policy
      ));
    else
      canonical := canonical || jsonb_build_array(jsonb_build_object(
        'role', role_name, 'configured', false
      ));
    end if;
  end loop;

  material := 'COURSE_PREPUBLICATION_TEST_V1' || '|' || p_import_id::text || '|'
    || import_record.programme_version_id::text || '|' || import_record.content_hash || '|'
    || materialized_hash || '|' || canonical::text;

  return encode(extensions.digest(material, 'sha256'), 'hex');
end $$;

-- Independent, database-owned comparison of the five saved
-- academic_agent_configs rows against the package's own proposed
-- agentConfiguration, using exactly migration 027's
-- (course_activation_private.configs) established comparison semantics:
-- IS DISTINCT FROM (null-safe) for enabled/model_profile_ref/
-- instructional_notes/escalation_policy, nullif(trim(...),'') to normalize
-- blank instructional notes to NULL, and order-independent (sorted) array
-- comparison for capabilities. Unlike migration 027's activation helper,
-- this NEVER creates a missing row: a readiness check must observe state,
-- not mutate it. A role with no saved row at all is reported as missing,
-- never silently treated as an implicit match.
create function course_engineering_private.evaluate_config_readiness(
  p_import_id uuid, p_programme_version_id uuid
) returns table(missing_roles text[], mismatched_roles text[])
language plpgsql set search_path='' as $$
declare
  import_record public.course_package_imports%rowtype;
  role_names text[] := array['PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR'];
  role_name text;
  proposal jsonb;
  proposed_caps text[];
  stored public.academic_agent_configs%rowtype;
  missing text[] := array[]::text[];
  mismatched text[] := array[]::text[];
begin
  select * into import_record from public.course_package_imports where id = p_import_id;
  if not found then
    raise exception 'Course package import not found';
  end if;

  foreach role_name in array role_names loop
    proposal := import_record.raw_package->'agentConfiguration'->role_name;
    proposed_caps := array(select jsonb_array_elements_text(proposal->'capabilities') order by 1);

    select * into stored
    from public.academic_agent_configs
    where programme_version_id = p_programme_version_id and role = role_name;

    if not found then
      missing := missing || role_name;
    elsif stored.enabled is distinct from (proposal->>'enabled')::boolean
      or stored.model_profile_ref is distinct from proposal->>'modelProfileRef'
      or stored.instructional_notes is distinct from nullif(trim(proposal->>'instructionalNotes'), '')
      or stored.escalation_policy is distinct from proposal->>'escalationPolicy'
      or array(select unnest(stored.capabilities) order by 1) is distinct from proposed_caps
    then
      mismatched := mismatched || role_name;
    end if;
  end loop;

  return query select missing, mismatched;
end $$;

------------------------------------------------------------------
-- PUBLIC RPCs
------------------------------------------------------------------

-- Pre-publication only: allowed exclusively while the import is APPLIED,
-- never against a PUBLISHED package (no re-testing a live version) and
-- never before Apply (no bound programme version to test). This RPC never
-- accepts a caller-supplied outcome or fingerprint -- both are derived
-- entirely server-side, exactly like mark_course_package_validated never
-- trusts a caller-supplied validation report.
--
-- Expected readiness failures (stored package no longer independently
-- valid; incomplete or mismatched agent configuration) persist an
-- immutable FAIL row and RETURN NORMALLY -- they are not exceptions, so a
-- FAIL is never rolled back by its own reporting. Only genuine API/system
-- errors (unauthorized, malformed reason, unknown import, wrong lifecycle
-- state, unexpected database failure) raise.
create function public.run_course_package_test(p_import_id uuid, p_reason text)
returns table(
  id uuid, outcome text, failure_code text, failed_roles text[],
  fingerprint text, run_sequence bigint, run_at timestamptz
)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
  version_status text;
  revalidation_ok boolean := true;
  missing_roles_v text[] := array[]::text[];
  mismatched_roles_v text[] := array[]::text[];
  outcome_v text;
  failure_code_v text := null;
  failed_roles_v text[] := array[]::text[];
  fingerprint_v text;
  result_id uuid;
  result_seq bigint;
  result_at timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded test-run reason is required';
  end if;

  -- V2 correction lock order for package flows: course_package_imports
  -- row, then the shared programmes row, then the bound programme_versions
  -- row -- matching apply_course_package's own order (import row, then
  -- programmes row) with the version row added last. The programmes row is
  -- locked here, before revalidation/materialisation are even checked, so
  -- a concurrent apply of a later revision under the same package key
  -- cannot mutate shared programme metadata mid-test.
  -- Bare "id" would otherwise be ambiguous against this function's own
  -- "returns table(id uuid, ...)" OUT parameter, so it is schema/table
  -- qualified here, matching get_course_package_preview's identical
  -- precedent in migration 024.
  select * into import_record
  from public.course_package_imports
  where public.course_package_imports.id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status <> 'APPLIED' or import_record.programme_version_id is null then
    raise exception 'A course package must be applied before a pre-publication test can be run';
  end if;

  perform 1 from public.programmes where public.programmes.id = import_record.programme_id for update;

  select status into version_status
  from public.programme_versions
  where public.programme_versions.id = import_record.programme_version_id
  for update;
  if version_status is distinct from 'DRAFT' then
    raise exception 'The bound programme version is no longer awaiting publication';
  end if;

  -- Defense in depth: re-verify independently of the stored VALIDATED/
  -- APPLIED status. A bounded nested exception block maps any failure to a
  -- fixed code; SQLERRM is never exposed to the caller or persisted.
  begin
    perform course_engineering_private.assert_full_package_valid(
      import_record.package_key, import_record.package_revision,
      import_record.schema_version, import_record.raw_package
    );
  exception when others then
    revalidation_ok := false;
  end;

  if not revalidation_ok then
    failure_code_v := 'PACKAGE_REVALIDATION_FAILED';
  elsif not course_engineering_private.evaluate_materialized_readiness(p_import_id) then
    -- V2 correction: the stored package content is valid on its own, but
    -- no longer matches what is actually materialised for this version
    -- (title/body/url/position drift anywhere in the tree, or shared
    -- programme metadata since changed by a later revision's Apply).
    failure_code_v := 'MATERIALIZED_STATE_MISMATCH';
  else
    select missing_roles, mismatched_roles into missing_roles_v, mismatched_roles_v
    from course_engineering_private.evaluate_config_readiness(p_import_id, import_record.programme_version_id);

    if array_length(missing_roles_v, 1) is not null then
      failure_code_v := 'CONFIGURATION_INCOMPLETE';
      failed_roles_v := missing_roles_v;
    elsif array_length(mismatched_roles_v, 1) is not null then
      failure_code_v := 'CONFIGURATION_MISMATCH';
      failed_roles_v := mismatched_roles_v;
    end if;
  end if;

  outcome_v := case when failure_code_v is null then 'PASS' else 'FAIL' end;
  fingerprint_v := course_engineering_private.compute_publication_fingerprint(p_import_id);

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.course_package_test_runs(
    import_id, programme_version_id, test_policy_version, fingerprint,
    outcome, failure_code, failed_roles, run_by
  ) values (
    p_import_id, import_record.programme_version_id, 'COURSE_PREPUBLICATION_TEST_V1', fingerprint_v,
    outcome_v, failure_code_v, coalesce(failed_roles_v, array[]::text[]), actor
  )
  returning course_package_test_runs.id, course_package_test_runs.run_sequence, course_package_test_runs.run_at
  into result_id, result_seq, result_at;

  return query select
    result_id, outcome_v, failure_code_v, coalesce(failed_roles_v, array[]::text[]),
    fingerprint_v, result_seq, result_at;
end $$;

-- Safe, read-only status projection for the admin surface. Derives the
-- CURRENT fingerprint fresh (not cached) and reports one of four bounded
-- states: NOT_TESTED (no run exists for this import at all), FAILED (the
-- latest run for the current exact fingerprint is FAIL), PASSED_CURRENT
-- (the latest run for the current exact fingerprint is PASS -- exactly
-- what publish_course_package itself requires) or PASSED_STALE (at least
-- one run exists for this import, but none matches the current
-- fingerprint -- state changed since it was last tested). This function
-- never mutates anything; it exists purely for display, and PUBLICATION
-- ENFORCEMENT DOES NOT DEPEND ON IT -- publish_course_package recomputes
-- and re-checks everything independently.
create function public.get_course_package_test_status(p_import_id uuid)
returns table(
  status text, outcome text, failure_code text, failed_roles text[],
  fingerprint text, run_sequence bigint, run_at timestamptz
)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
  current_fingerprint text;
  latest public.course_package_test_runs%rowtype;
  any_pass boolean;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  -- Bare "id"/"fingerprint"/"run_sequence"/"outcome" would otherwise be
  -- ambiguous against this function's own "returns table(status, outcome,
  -- ..., fingerprint, run_sequence, ...)" OUT parameters, so each is
  -- schema/table qualified, matching get_course_package_preview's identical
  -- precedent in migration 024.
  select * into import_record
  from public.course_package_imports
  where public.course_package_imports.id = p_import_id;
  if not found then raise exception 'Course package import not found'; end if;

  if import_record.programme_version_id is null then
    return query select 'NOT_TESTED'::text, null::text, null::text, array[]::text[], null::text, null::bigint, null::timestamptz;
    return;
  end if;

  current_fingerprint := course_engineering_private.compute_publication_fingerprint(p_import_id);

  select * into latest
  from public.course_package_test_runs
  where public.course_package_test_runs.import_id = p_import_id
    and public.course_package_test_runs.fingerprint = current_fingerprint
    and public.course_package_test_runs.test_policy_version = 'COURSE_PREPUBLICATION_TEST_V1'
  order by public.course_package_test_runs.run_sequence desc
  limit 1;

  if found then
    return query select
      case when latest.outcome = 'PASS' then 'PASSED_CURRENT' else 'FAILED' end,
      latest.outcome, latest.failure_code, latest.failed_roles, latest.fingerprint,
      latest.run_sequence, latest.run_at;
    return;
  end if;

  select exists(
    select 1 from public.course_package_test_runs
    where public.course_package_test_runs.import_id = p_import_id
      and public.course_package_test_runs.outcome = 'PASS'
  ) into any_pass;

  if any_pass then
    return query select 'PASSED_STALE'::text, null::text, null::text, array[]::text[], null::text, null::bigint, null::timestamptz;
  else
    return query select 'NOT_TESTED'::text, null::text, null::text, array[]::text[], null::text, null::bigint, null::timestamptz;
  end if;
end $$;

------------------------------------------------------------------
-- PUBLICATION SURFACE CORRECTION
------------------------------------------------------------------

-- A package-linked ProgrammeVersion must publish only through
-- publish_course_package, which transitions both authoritative states
-- (ProgrammeVersion + course_package_imports) atomically in the same
-- transaction. Direct publish_programme_version is preserved unchanged for
-- every ProgrammeVersion with no linked course_package_imports row (see
-- tests/programme-publication.test.ts, which publishes such versions
-- directly), but fails closed -- even after a valid current PASS -- for any
-- version bound to a governed package, because publishing it through this
-- path would leave course_package_imports stuck in APPLIED forever.
--
-- A course_package_imports row's programme_version_id, once set, is
-- immutable (guard_course_package_import_history, migration 024) and is
-- only ever set inside apply_course_package's own transaction alongside the
-- programme_versions INSERT itself, so there is no window in which another
-- transaction can observe a version id as linked or unlinked other than its
-- true, already-committed state -- no additional lock is required to make
-- this existence check race-free.
create or replace function public.publish_programme_version(
  p_version_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := course_engineering_private.require_publication_actor(p_reason);

  if exists(
    select 1 from public.course_package_imports where programme_version_id = p_version_id
  ) then
    raise exception 'This programme version is governed by a course package; publish it through the course-package publication authority';
  end if;

  return course_engineering_private.publish_version_unconditional(p_version_id, actor, p_reason);
end $$;

-- Publication is a distinct, explicit step that reuses
-- publish_version_unconditional (the shared implementation
-- publish_programme_version itself now calls for the non-package case)
-- rather than duplicating its lock/status/audit/update behavior, and is the
-- ONLY public authority able to publish a package-linked ProgrammeVersion.
--
-- Gate: the latest test run for this exact (import, programme version,
-- current test policy, CURRENT fingerprint) must be PASS. The fingerprint
-- is recomputed fresh, from current database state, while holding both the
-- shared programmes row lock and the programme_versions row lock (V2
-- correction; see compute_publication_fingerprint's own comment on why the
-- programmes row must be protected too) -- so a config mutation OR a later
-- revision's Apply that races with publication is always resolved by
-- whichever transaction actually commits its lock first; the loser
-- recomputes against the other's already-committed state (see the
-- migration's own concurrency notes below and tests/course-engineering-
-- workflow.test.ts's race coverage). Both locks are held continuously
-- through publish_version_unconditional's UPDATE below, so
-- prepare_programme_publication's own snapshot read of the programmes row
-- (migration 006) cannot race against a concurrent apply_course_package
-- under the same package key. "Latest", not "any historical", so a newer
-- FAIL for an identical fingerprint deliberately overrides an older PASS
-- for that same state.
create or replace function public.publish_course_package(p_import_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
  programme_record public.programmes%rowtype;
  version_record public.programme_versions%rowtype;
  current_fingerprint text;
  latest_outcome text;
begin
  actor := course_engineering_private.require_publication_actor(p_reason);

  select * into import_record from public.course_package_imports where id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status = 'PUBLISHED' then
    return import_record.programme_version_id;
  end if;
  if import_record.status <> 'APPLIED' or import_record.programme_version_id is null then
    raise exception 'A course package must be applied before it can be published';
  end if;

  -- V2 correction lock order: course_package_imports row (above), then the
  -- shared programmes row, then the programme_versions row -- matching
  -- apply_course_package's own order and run_course_package_test. Held
  -- continuously through the UPDATE below.
  select * into programme_record from public.programmes where id = import_record.programme_id for update;
  if not found then
    raise exception 'Course package programme/version identity no longer matches its bound import; publication is blocked pending investigation';
  end if;
  select * into version_record from public.programme_versions where id = import_record.programme_version_id for update;

  -- Defense in depth (V3 correction): independently re-verify the
  -- programme/version/import identity bindings while holding both locks,
  -- exactly like evaluate_materialized_readiness now does for
  -- run_course_package_test, rather than relying solely on the fingerprint
  -- comparison below to notice a privileged identity mutation. This is
  -- checked, and must hold, before the current PASS below is ever accepted.
  if not found
    or programme_record.id is distinct from import_record.programme_id
    or programme_record.slug is distinct from import_record.package_key
    or version_record.id is distinct from import_record.programme_version_id
    or version_record.programme_id is distinct from import_record.programme_id
  then
    raise exception 'Course package programme/version identity no longer matches its bound import; publication is blocked pending investigation';
  end if;

  current_fingerprint := course_engineering_private.compute_publication_fingerprint(p_import_id);

  select outcome into latest_outcome
  from public.course_package_test_runs
  where import_id = p_import_id
    and programme_version_id = import_record.programme_version_id
    and test_policy_version = 'COURSE_PREPUBLICATION_TEST_V1'
    and fingerprint = current_fingerprint
  order by run_sequence desc
  limit 1;

  if latest_outcome is distinct from 'PASS' then
    raise exception 'A current passing pre-publication test does not exist for this exact package, materialised institutional state and agent-configuration state';
  end if;

  perform course_engineering_private.publish_version_unconditional(
    import_record.programme_version_id, actor, p_reason
  );

  update public.course_package_imports
  set status = 'PUBLISHED', published_at = clock_timestamp(), published_by = actor
  where id = p_import_id;

  return import_record.programme_version_id;
end $$;

------------------------------------------------------------------
-- MATERIALISED CURRICULUM WRITE SERIALIZATION (V4 correction)
------------------------------------------------------------------

-- run_course_package_test and publish_course_package both lock the owning
-- programme_versions row FOR UPDATE before reading or recomputing anything
-- materialisation-related (see their own comments above and the
-- Concurrency section of docs/30). The package's materialised-state
-- projection they read -- materialized_content_hash_from_live, in turn used
-- by evaluate_materialized_readiness and compute_materialized_state_hash --
-- is sourced from public.modules/lessons/lesson_objectives/
-- learning_resources. For that lock to actually serve as a snapshot
-- boundary for those reads, every privileged/backend write to those four
-- tables must itself take the exact same programme_versions row lock,
-- BEFORE the write is allowed, and re-check PUBLISHED/enrolled status only
-- AFTER acquiring it -- never relying on a check performed before a
-- potential wait, since the version's status can change while this
-- transaction blocks on the lock.
--
-- Migration 001/005's existing freeze_content/guard_curriculum_version
-- trigger already takes this same lock-then-check path on these four
-- tables (see its own "order by id for update" then re-check), so under
-- real PostgreSQL this already serializes correctly against
-- run_course_package_test/publish_course_package's own programme_versions
-- lock. This migration adds an explicit, dedicated, independently-tested
-- trigger of its own rather than relying on that inference -- matching the
-- V2/V3 corrections' own "defense in depth" precedent (see
-- evaluate_materialized_readiness's identity checks and
-- publish_course_package's own re-verification) and giving this exact
-- serialization guarantee its own auditable, migration-035-owned
-- implementation and direct test coverage, without editing the historical
-- migration. Firing alongside the pre-existing trigger is intentionally
-- redundant, not conflicting: both reach the identical lock and the
-- identical PUBLISHED/enrolled check, so this can never reject a write
-- migration 001/005 would allow, or allow one it would reject.
--
-- Mirrors migration 027's course_activation_private.lock_config_version,
-- which takes the identical programme_versions lock before every
-- academic_agent_configs write, so configuration writes, materialised
-- curriculum writes, test runs and publication all now serialize against
-- each other through the same single row lock.
create function course_engineering_private.lock_materialized_curriculum_version() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  old_version uuid;
  new_version uuid;
begin
  if TG_OP <> 'INSERT' then old_version := OLD.programme_version_id; end if;
  if TG_OP <> 'DELETE' then new_version := NEW.programme_version_id; end if;

  -- Deterministic lock order (by id) when an UPDATE moves a row between two
  -- distinct version ids, avoiding deadlock against another transaction
  -- locking the same two rows in the opposite order.
  perform 1 from public.programme_versions
  where id in (old_version, new_version)
  order by id
  for update;

  -- Re-checked AFTER the lock above is held, never before it.
  if exists(
    select 1 from public.programme_versions v
    where v.id in (old_version, new_version)
      and (
        v.status = 'PUBLISHED'
        or exists(select 1 from public.enrolments e where e.programme_version_id = v.id)
      )
  ) then
    raise exception 'Published or enrolled curriculum is immutable';
  end if;

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;

create trigger materialized_curriculum_serialization
before insert or update or delete on public.modules
for each row execute function course_engineering_private.lock_materialized_curriculum_version();
create trigger materialized_curriculum_serialization
before insert or update or delete on public.lessons
for each row execute function course_engineering_private.lock_materialized_curriculum_version();
create trigger materialized_curriculum_serialization
before insert or update or delete on public.lesson_objectives
for each row execute function course_engineering_private.lock_materialized_curriculum_version();
create trigger materialized_curriculum_serialization
before insert or update or delete on public.learning_resources
for each row execute function course_engineering_private.lock_materialized_curriculum_version();

------------------------------------------------------------------
-- ACL HARDENING
------------------------------------------------------------------

-- Explicitly neutralise ambient Supabase default ACLs, including
-- service_role, on every function this migration created (the private
-- schema's helpers and the public RPCs') AND on publish_programme_version/
-- publish_course_package. CREATE OR REPLACE FUNCTION preserves whatever ACL
-- a function already had, and migration 006's original grant on
-- publish_programme_version only ever revoked from `public`, never
-- explicitly from service_role -- so service_role has held ambient EXECUTE
-- on programme publication since migration 006, unnoticed until this
-- migration's own closing assertion below caught it. Closing that gap here,
-- on the exact two functions this migration already redefines, keeps the
-- fix additive/corrective (migrations 001-034 stay byte-identical) while
-- still applying the same explicit-revoke-then-reviewed-grant discipline
-- migrations 022/023/024 established for everything else.
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'course_engineering_private' and p.proname in (
             'require_publication_actor','publish_version_unconditional',
             'materialized_content_hash_from_live','materialized_content_hash_from_package',
             'evaluate_materialized_readiness','compute_materialized_state_hash',
             'compute_publication_fingerprint','evaluate_config_readiness',
             'lock_materialized_curriculum_version'
           ))
       or (n.nspname = 'public' and p.proname in (
             'guard_course_package_test_run_history','audit_course_package_test_run',
             'run_course_package_test','get_course_package_test_status',
             'publish_programme_version','publish_course_package'
           )) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'run_course_package_test','get_course_package_test_status',
      'publish_programme_version','publish_course_package'
    ) loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Table REVOKE alone does not clear pre-existing column-level privileges
-- from Supabase-like broad defaults.
do $$ declare t regclass; columns text; begin
  t := 'public.course_package_test_runs'::regclass;
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns
    from pg_attribute where attrelid = t and attnum > 0 and not attisdropped;
  execute format(
    'revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
    columns, columns, columns, columns, t
  );
end $$;

-- Effective-ACL acceptance: unexpected inherited privileges fail deployment
-- rather than silently relying on RLS against a BYPASSRLS role. Authenticated
-- access is through only the reviewed public RPCs listed above, each with an
-- operation-specific identity/role check. publish_programme_version and
-- publish_course_package are asserted here too, confirming the explicit
-- revoke/grant pair above actually closed migration 006's latent
-- service_role gap.
do $$ declare t regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    t := 'public.course_package_test_runs'::regclass;
    if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe effective course-prepublication-test table privileges for %', r;
    end if;

    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'course_engineering_private' and p.proname in (
               'require_publication_actor','publish_version_unconditional',
               'materialized_content_hash_from_live','materialized_content_hash_from_package',
               'evaluate_materialized_readiness','compute_materialized_state_hash',
               'compute_publication_fingerprint','evaluate_config_readiness',
               'lock_materialized_curriculum_version'
             ))
         or (n.nspname = 'public' and p.proname in (
               'guard_course_package_test_run_history','audit_course_package_test_run',
               'run_course_package_test','get_course_package_test_status',
               'publish_programme_version','publish_course_package'
             )) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        r = 'authenticated' and f.nspname = 'public' and f.proname in (
          'run_course_package_test','get_course_package_test_status',
          'publish_programme_version','publish_course_package'
        )
      ) then
        raise exception 'Unsafe effective course-prepublication-test function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
