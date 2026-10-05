-- AGENT-CONTROL-1: academic agent configuration governance.
-- Additive only; migrations 001-049 are byte-for-byte unchanged.
--
-- academic_agent_configs (migration 024, tightened by 036) is keyed by
-- ProgrammeVersion, but unlike the curriculum it belongs to
-- (guard_curriculum_version, migrations 001/005) it stayed fully mutable
-- after the version was PUBLISHED and after learners enrolled on it. An
-- admin could therefore silently change the academic configuration bound to
-- learners already enrolled on a published version.
--
-- This migration binds academic-semantic configuration to the version in
-- the same way as the curriculum. Once the version is PUBLISHED, or has any
-- enrolment, the following are refused (AGENT_CONFIG_SEMANTIC_FROZEN):
--   * any instructional_notes change (including clearing them);
--   * any model_profile_ref change (including null <-> the role's own ref);
--   * any capability widening (a capability not already configured);
--   * any escalation_policy change, except EXAMINER NONE -> ACADEMIC_REVIEW.
-- These remain available as audited operational controls:
--   * enabled true/false (the kill switch);
--   * capability narrowing (a subset of the configured capabilities);
--   * EXAMINER escalation NONE -> ACADEMIC_REVIEW. This is the only
--     escalation transition with one well-defined, truthful meaning on
--     every path that reads it: Examiner initial grading (036) and
--     recovery (040) AUTHORIZE create a durable ESCALATED claim, which the
--     human academic-review worklist (047) lists as a case. Professor turns
--     ACADEMIC_REVIEW into an unavailable response with no review record,
--     and Tutor/Lab never read the field, so no change is permitted for
--     those roles. The reverse direction (back to automated grading) is
--     refused.
-- First binding of a role that has no row yet:
--   * DRAFT (unpublished, unenrolled) version: ordinary authoring.
--   * PUBLISHED, unenrolled version: allowed ONLY when the new row exactly
--     matches the version's single, immutable published course package
--     proposal for that role, which the database derives itself from
--     course_package_imports (AGENT_CONFIG_PACKAGE_MISMATCH otherwise;
--     AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE when there is not exactly
--     one bound import, in status PUBLISHED). This is exactly what course
--     activation (migration 027/037 course_activation_private.configs())
--     supplies, so activation keeps working, with no bypass flag, session
--     variable, reason string or caller-supplied package identity.
--   * Enrolled version: always refused (AGENT_CONFIG_BINDING_CLOSED), even
--     when the row would match the package.
--
-- The guard is a trigger, so it binds every writer, including any future
-- SECURITY DEFINER function and the database owner, not only
-- set_agent_config. It takes the programme_versions row lock that migration
-- 027's activation_config_serialization already takes; enrolment creation
-- (guard_enrolment_history FOR SHARE, plus the enrolments foreign key) and
-- publication contend for that same row, so a concurrent first enrolment or
-- publication is serialised against a configuration write.
--
-- Audit: migration 024 deliberately strips instructional_notes from audit
-- payloads. That property is preserved: no note text, hash, digest,
-- preview, prefix or suffix is ever recorded. An UPDATE additionally
-- records which field categories changed (changed_fields), so a notes-only
-- change is distinguishable from a no-op re-save without revealing content.
--
-- Read surface: admin_list_agent_configuration_scopes, a bounded keyset-
-- paged ACADEMIC_ADMIN / PLATFORM_ADMIN read for the read-only
-- /admin/agents control plane. It reports whether notes are stored, never
-- their text.

create schema agent_config_governance_private;
revoke all on schema agent_config_governance_private from public, anon, authenticated, service_role;

-- The single definition of "bound": the same PUBLISHED-or-enrolled rule
-- guard_curriculum_version applies to the curriculum itself.
create function agent_config_governance_private.version_bound(p_version uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from public.programme_versions v where v.id = p_version and v.status = 'PUBLISHED')
      or exists(select 1 from public.enrolments e where e.programme_version_id = p_version)
$$;

-- The single reference authority for a first binding on a PUBLISHED
-- version: the stored, immutable raw_package of the one course package
-- import bound to that version (migration 024 makes raw_package, package
-- identity and the version binding immutable, and refuses DELETE). It is
-- derived here from programme_version_id alone; no caller-supplied package
-- identity is consulted. The schema has no unique constraint on
-- course_package_imports.programme_version_id, so anything other than
-- exactly one bound import, in status PUBLISHED, is ambiguous and fails
-- closed rather than choosing a row. Comparison uses exactly the
-- normalisation migration 027's course_activation_private.configs() and
-- migration 035's evaluate_config_readiness use: null-safe IS DISTINCT
-- FROM, nullif(trim(...),'') notes, and capabilities compared as sorted
-- sets. Returns MATCH, MISMATCH or AUTHORITY_UNAVAILABLE.
create function agent_config_governance_private.package_first_binding(
  p_row public.academic_agent_configs
) returns text
language plpgsql stable set search_path='' as $$
declare
  bound_imports integer;
  package jsonb;
  proposal jsonb;
begin
  select count(*) into bound_imports
  from public.course_package_imports
  where programme_version_id = p_row.programme_version_id;
  if bound_imports <> 1 then return 'AUTHORITY_UNAVAILABLE'; end if;

  select raw_package into package
  from public.course_package_imports
  where programme_version_id = p_row.programme_version_id and status = 'PUBLISHED';
  if not found then return 'AUTHORITY_UNAVAILABLE'; end if;

  proposal := package->'agentConfiguration'->p_row.role;
  if proposal is null or jsonb_typeof(proposal) <> 'object'
    or jsonb_typeof(proposal->'enabled') is distinct from 'boolean'
    or jsonb_typeof(proposal->'capabilities') is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(proposal->'capabilities') e where jsonb_typeof(e) <> 'string') then
    return 'AUTHORITY_UNAVAILABLE';
  end if;

  if p_row.policy_version is distinct from 'ACADEMIC_AGENT_CONFIG_V1'
    or p_row.enabled is distinct from (proposal->>'enabled')::boolean
    or p_row.model_profile_ref is distinct from proposal->>'modelProfileRef'
    or p_row.instructional_notes is distinct from nullif(trim(proposal->>'instructionalNotes'), '')
    or p_row.escalation_policy is distinct from proposal->>'escalationPolicy'
    or array(select unnest(coalesce(p_row.capabilities, array[]::text[])) order by 1)
       is distinct from array(select jsonb_array_elements_text(proposal->'capabilities') order by 1) then
    return 'MISMATCH';
  end if;
  return 'MATCH';
end $$;

create function agent_config_governance_private.guard_semantic_binding() returns trigger
language plpgsql set search_path='' as $$
declare
  enrolled boolean;
  published boolean;
  package_match text;
begin
  -- Same lock migration 027 takes before every configuration write; taken
  -- here explicitly so this guard never depends on trigger firing order.
  perform 1 from public.programme_versions where id = NEW.programme_version_id for update;
  enrolled := exists(select 1 from public.enrolments where programme_version_id = NEW.programme_version_id);

  if TG_OP = 'INSERT' then
    -- set_agent_config upserts (INSERT ... ON CONFLICT DO UPDATE), and a
    -- BEFORE INSERT trigger fires before conflict detection. An existing
    -- row means this statement will become an UPDATE, which the UPDATE
    -- branch below governs; the version lock above makes this check stable.
    if exists(
      select 1 from public.academic_agent_configs c
      where c.programme_version_id = NEW.programme_version_id and c.role = NEW.role
    ) then
      return NEW;
    end if;
    -- A genuine first binding (no row for this role yet).
    if enrolled then
      raise exception 'AGENT_CONFIG_BINDING_CLOSED: a role cannot receive its first configuration once learners are enrolled on this programme version'
        using errcode = '55000';
    end if;
    published := exists(
      select 1 from public.programme_versions
      where id = NEW.programme_version_id and status = 'PUBLISHED'
    );
    if not published then
      return NEW; -- ordinary DRAFT authoring
    end if;
    -- PUBLISHED, unenrolled: only the exact immutable package binding, which
    -- is precisely what course activation (migration 027/037) supplies.
    package_match := agent_config_governance_private.package_first_binding(NEW);
    if package_match = 'AUTHORITY_UNAVAILABLE' then
      raise exception 'AGENT_CONFIG_PACKAGE_AUTHORITY_UNAVAILABLE: this published programme version has no single published course package to bind a first configuration to'
        using errcode = '55000';
    elsif package_match <> 'MATCH' then
      raise exception 'AGENT_CONFIG_PACKAGE_MISMATCH: a first configuration on a published programme version must exactly match its published course package'
        using errcode = '55000';
    end if;
    return NEW;
  end if;

  if not agent_config_governance_private.version_bound(NEW.programme_version_id) then
    return NEW;
  end if;

  if NEW.policy_version is distinct from OLD.policy_version
    or NEW.instructional_notes is distinct from OLD.instructional_notes
    or NEW.model_profile_ref is distinct from OLD.model_profile_ref
    or not (coalesce(NEW.capabilities, array[]::text[]) <@ coalesce(OLD.capabilities, array[]::text[])) then
    raise exception 'AGENT_CONFIG_SEMANTIC_FROZEN: instructional notes, model profile and capability widening are fixed once the programme version is published or enrolled'
      using errcode = '55000';
  end if;

  if NEW.escalation_policy is distinct from OLD.escalation_policy
    and not (NEW.role = 'EXAMINER' and OLD.escalation_policy = 'NONE' and NEW.escalation_policy = 'ACADEMIC_REVIEW') then
    raise exception 'AGENT_CONFIG_SEMANTIC_FROZEN: escalation policy is fixed once the programme version is published or enrolled'
      using errcode = '55000';
  end if;

  return NEW;
end $$;

create trigger guard_agent_config_semantic_binding
before insert or update on public.academic_agent_configs
for each row execute function agent_config_governance_private.guard_semantic_binding();

-- Migration 024's audit trigger, unchanged except for changed_fields on
-- UPDATE. instructional_notes is still removed from both payloads, and its
-- category name is the only trace a notes change leaves.
create or replace function public.audit_agent_config_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
  changed text[];
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then following := to_jsonb(NEW); end if;
  previous := previous - 'instructional_notes';
  following := following - 'instructional_notes';
  if TG_OP = 'UPDATE' then
    changed := array_remove(array[
      case when NEW.enabled is distinct from OLD.enabled then 'enabled' end,
      case when NEW.model_profile_ref is distinct from OLD.model_profile_ref then 'model_profile_ref' end,
      case when NEW.instructional_notes is distinct from OLD.instructional_notes then 'instructional_notes' end,
      case when NEW.capabilities is distinct from OLD.capabilities then 'capabilities' end,
      case when NEW.escalation_policy is distinct from OLD.escalation_policy then 'escalation_policy' end
    ], null);
    following := following || jsonb_build_object('changed_fields', to_jsonb(coalesce(changed, array[]::text[])));
  end if;
  target := coalesce(following->>'id', previous->>'id')::uuid;

  insert into public.audit_events(
    actor_id, action, target_type, target_id, reason, before_state, after_state
  ) values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, target,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed agent configuration workflow'),
    previous, following
  );

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;

-- Bounded, note-free projection of one programme version's agent
-- configuration scope.
create function agent_config_governance_private.scope_summary(p_version uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'programmeVersionId', v.id,
    'programmeTitle', coalesce(v.title_snapshot, p.title),
    'versionLabel', v.label,
    'versionStatus', v.status,
    'isDemo', v.is_demo,
    'createdAt', v.created_at,
    'hasEnrolments', exists(select 1 from public.enrolments e where e.programme_version_id = v.id),
    'semanticConfigFrozen', agent_config_governance_private.version_bound(v.id),
    'configs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', c.role,
        'enabled', c.enabled,
        'modelProfileRef', c.model_profile_ref,
        'hasInstructionalNotes', c.instructional_notes is not null,
        'capabilities', to_jsonb(c.capabilities),
        'escalationPolicy', c.escalation_policy,
        'updatedAt', c.updated_at
      ) order by c.role)
      from public.academic_agent_configs c where c.programme_version_id = v.id
    ), '[]'::jsonb)
  )
  from public.programme_versions v
  join public.programmes p on p.id = v.programme_id
  where v.id = p_version
$$;

-- Keyset page of programme versions (newest first). The cursor is the last
-- row's (createdAt, id); both or neither must be supplied.
create function public.admin_list_agent_configuration_scopes(
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  page_size constant integer := 50;
  actor uuid;
  candidate_count integer;
  versions jsonb;
  last_created timestamptz;
  last_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select count(*) into candidate_count from (
    select 1 from public.programme_versions v
    where p_cursor_id is null or (v.created_at, v.id) < (p_cursor_created_at, p_cursor_id)
    order by v.created_at desc, v.id desc
    limit page_size + 1
  ) x;

  select coalesce(jsonb_agg(agent_config_governance_private.scope_summary(page.id) order by page.created_at desc, page.id desc), '[]'::jsonb),
         (array_agg(page.created_at order by page.created_at asc, page.id asc))[1],
         (array_agg(page.id order by page.created_at asc, page.id asc))[1]
    into versions, last_created, last_id
  from (
    select v.id, v.created_at from public.programme_versions v
    where p_cursor_id is null or (v.created_at, v.id) < (p_cursor_created_at, p_cursor_id)
    order by v.created_at desc, v.id desc
    limit page_size
  ) page;

  return jsonb_build_object(
    'versions', versions,
    'pageSize', page_size,
    'hasMore', candidate_count > page_size,
    'nextCursor', case when candidate_count > page_size
      then jsonb_build_object('createdAt', last_created, 'id', last_id) end
  );
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification. service_role
-- has BYPASSRLS, so RLS is never relied on: object privileges are revoked
-- explicitly and the effective result is asserted.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'agent_config_governance_private'
       or (n.nspname = 'public' and p.proname in ('admin_list_agent_configuration_scopes', 'audit_agent_config_change')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.admin_list_agent_configuration_scopes(timestamptz, uuid) to authenticated;

do $$
declare
  r text;
  f record;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(r, 'agent_config_governance_private', 'USAGE,CREATE') then
      raise exception 'Unsafe agent configuration governance schema privileges for %', r;
    end if;
    if has_table_privilege(r, 'public.academic_agent_configs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r, 'public.academic_agent_configs', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unsafe academic_agent_configs privileges for %', r;
    end if;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'agent_config_governance_private'
         or (n.nspname = 'public' and p.proname in (
           'admin_list_agent_configuration_scopes', 'set_agent_config', 'list_agent_configs',
           'get_agent_config_for_enrolment', 'audit_agent_config_change', 'guard_agent_config_history')) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        r = 'authenticated' and f.nspname = 'public' and f.proname in (
          'admin_list_agent_configuration_scopes', 'set_agent_config', 'list_agent_configs', 'get_agent_config_for_enrolment'))
      then
        raise exception 'Unsafe agent configuration function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
