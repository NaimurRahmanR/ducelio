-- AC-2: governed academic agent behaviour. Additive only; migrations 001-050
-- are byte-for-byte unchanged, and no existing attested message format
-- (migrations 022/025/028/031/032/040) is altered.
--
-- Adds four things:
--
-- 1. academic_agent_behaviour_configs: the LEVEL-3 programme-version
--    behaviour configuration for PROFESSOR / TUTOR / LAB_INSTRUCTOR (bounded
--    enums plus bounded courseContextNotes). It is a separate table rather
--    than new academic_agent_configs columns, so COURSE_PACKAGE_V1, the
--    migration-035 publication fingerprint, migration-027 activation
--    comparison and the AC-1 semantic-freeze rules stay exactly as reviewed.
--    Rows are authored only while the programme version is an unpublished,
--    unenrolled draft; once the version is PUBLISHED or enrolled every
--    insert/update is refused (AGENT_BEHAVIOUR_CONFIG_FROZEN) and rows can
--    never be deleted. A DRAFT with no row resolves to the versioned default
--    AGENT_BEHAVIOUR_DEFAULT_V1. When a version becomes bound, the database
--    freezes an immutable academic_agent_behaviour_bindings row per role
--    holding the actual effective values and the pinned Level-2 role
--    behaviour version (section 1b); already-bound versions are backfilled
--    (section 6). Bound runtime reads only the binding and fails closed if
--    it is missing or does not verify, so a later code default or role
--    baseline can never drift into history. The existing academic_agent_configs.instructional_notes stays
--    stored-but-unused (AC-1): it is NOT reinterpreted as behaviour, so no
--    already-published version silently gains new behaviour text.
--    The freeze applies to a FIRST insert exactly as to an update: the
--    guard takes the same programme_versions row lock (FOR UPDATE) that
--    publication (FOR UPDATE) and enrolment (FOR SHARE) take, before it
--    evaluates "bound", so a configuration write and a publication or first
--    enrolment of the same version serialise.
--    AGENT_BEHAVIOUR_FINGERPRINT_V1 is a separate, explicitly named
--    deterministic fingerprint of a version's actual effective semantic
--    values (pinned role version, source, config version, the four values
--    and notes, including a default's concrete values).
--    The migration-035 package publication fingerprint
--    (COURSE_PREPUBLICATION_TEST_V1) does NOT cover behaviour and is not
--    changed: reusing its tag over different material would silently
--    invalidate existing readiness evidence.
--
-- 2. academic_agent_execution_provenance: one immutable row per Professor
--    or Tutor/Lab provider execution recording role, programme version,
--    runtime profile ref, the applied Level-1 institutional baseline
--    version, the pinned Level-2 behaviour version, the behaviour-config
--    source/version/row and the behaviour fingerprint.
--    No prompt, response, key, MAC or provider payload is stored.
--      * Tutor/Lab: derived entirely by the database in an AFTER INSERT
--        trigger on tutor_lab_provider_executions, from the execution's own
--        governed release (enrolment -> programme version -> stored config).
--      * Professor: migration 025's execution row carries no enrolment, so
--        the trusted controller records it through a NEW attested RPC with
--        its own protocol tag (DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1). The
--        database re-derives the programme version from the learner's own
--        classroom, and the runtime profile ref, behaviour version and
--        behaviour-config version from authoritative state, refusing any
--        mismatch with what the controller claims. The same attestation
--        binds a CONTEXT-RELEASE MANIFEST: every PROFESSOR_READ_V2 content
--        release that contributed data to the call (release id and
--        capability only, never content). The database requires the exact
--        capability set the stored configuration implies and verifies each
--        release's learner, profile, contract, capability and ACTIVE lease.
--        Legacy content releases carry no lesson selector, so lesson
--        identity is not provable from the release row itself.
--
-- 3. professor_classroom_turns: bounded, NON-AUTHORITATIVE, learner-visible
--    Professor classroom memory. Only the learner's visible message and the
--    Professor's visible reply are stored; no reasoning or provider payload.
--    A turn is written only through a NEW attested RPC
--    (DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1) bound to a SUCCEEDED Professor
--    execution of the same learner whose provenance names the same
--    classroom, so a browser can never forge history. It is read only by the
--    owning learner, only while the controlled-assessment firewall allows
--    explanation. It is not LearningEvidence, mastery, a grade, attendance,
--    progress or completion, and no admin, Counsellor/Sarah, Tutor or Lab
--    read exists. Retention: kept until a later governed retention policy;
--    there is no automated expiry in AC-2. At most 200 turns per classroom:
--    the learner-scoped read reports capacityReached, and the Professor
--    refuses further turns in that classroom before any provider call.
--    Continuity is derived, never assumed: the read reports how many
--    SUCCEEDED, provenance-bound exchanges of this classroom have no
--    recorded turn, so a lost write is surfaced as DEGRADED memory rather
--    than silently disappearing.
--
-- 4. get_my_professor_classroom_state: a read-only, learner-owned view of
--    the classroom's authoritative timing (scheduled start/end, database
--    clock, LIVE/CATCH_UP) so remaining class time is server-derived.

create schema agent_behaviour_private;
revoke all on schema agent_behaviour_private from public, anon, authenticated, service_role;

-- Mirror of src/domain/agent-behaviour.ts INSTITUTIONAL_BASELINE_VERSION.
-- Level 1 is a global, non-editable institutional safety baseline: it may
-- evolve institutionally rather than being frozen per programme, so it is
-- not part of a behaviour binding. The version actually applied is recorded
-- on every execution-provenance row, and the server refuses to execute when
-- this mirror disagrees with the code.
create function agent_behaviour_private.institutional_baseline_version() returns text
language sql immutable set search_path='' as $$ select 'DUCELIO_INSTITUTIONAL_BASELINE_V1'::text $$;

-- Mirror of src/domain/agent-behaviour.ts ROLE_BEHAVIOUR_VERSION.
create function agent_behaviour_private.role_behaviour_version(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'PROFESSOR' then 'PROFESSOR_BEHAVIOUR_V1'
    when 'TUTOR' then 'TUTOR_BEHAVIOUR_V1'
    when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_BEHAVIOUR_V1'
    else null
  end
$$;

-- ==========================================================================
-- 1. Level-3 behaviour configuration.
-- ==========================================================================
create table public.academic_agent_behaviour_configs (
  id uuid primary key default gen_random_uuid(),
  programme_version_id uuid not null references public.programme_versions(id),
  role text not null check(role in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')),
  policy_version text not null default 'AGENT_BEHAVIOUR_CONFIG_V1' check(policy_version = 'AGENT_BEHAVIOUR_CONFIG_V1'),
  response_depth text not null check(response_depth in ('CONCISE','STANDARD','DETAILED')),
  teaching_approach text not null check(teaching_approach in ('CONCEPT_FIRST','WORKED_EXAMPLE_FIRST','GUIDED_QUESTIONING')),
  understanding_check_frequency text not null check(understanding_check_frequency in ('LOW','STANDARD','HIGH')),
  challenge_level text not null check(challenge_level in ('FOUNDATION','STANDARD','ADVANCED')),
  course_context_notes text check(course_context_notes is null
    or (length(course_context_notes) between 1 and 2000 and course_context_notes = btrim(course_context_notes))),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(programme_version_id, role)
);
alter table public.academic_agent_behaviour_configs enable row level security;
revoke all on public.academic_agent_behaviour_configs from public, anon, authenticated, service_role;

create function agent_behaviour_private.guard_behaviour_config() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'AGENT_BEHAVIOUR_CONFIG_HISTORY: behaviour configuration rows cannot be deleted'
      using errcode = '55000';
  end if;
  -- The same version-row lock used by configuration writes, activation,
  -- enrolment (FOR SHARE) and publication.
  perform 1 from public.programme_versions where id = NEW.programme_version_id for update;
  if TG_OP = 'UPDATE' and (
    NEW.programme_version_id <> OLD.programme_version_id or NEW.role <> OLD.role
    or NEW.policy_version <> OLD.policy_version or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at) then
    raise exception 'AGENT_BEHAVIOUR_CONFIG_HISTORY: behaviour configuration identity is immutable'
      using errcode = '55000';
  end if;
  if agent_config_governance_private.version_bound(NEW.programme_version_id) then
    raise exception 'AGENT_BEHAVIOUR_CONFIG_FROZEN: behaviour configuration is fixed once the programme version is published or enrolled'
      using errcode = '55000';
  end if;
  return NEW;
end $$;
create trigger guard_agent_behaviour_config
before insert or update or delete on public.academic_agent_behaviour_configs
for each row execute function agent_behaviour_private.guard_behaviour_config();

-- Audit without the free-text notes (same privacy rule as AC-1 instructional
-- notes); changed field categories only.
create function agent_behaviour_private.audit_behaviour_config() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous jsonb; following jsonb; changed text[];
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD) - 'course_context_notes'; end if;
  following := to_jsonb(NEW) - 'course_context_notes';
  if TG_OP = 'UPDATE' then
    changed := array_remove(array[
      case when NEW.response_depth is distinct from OLD.response_depth then 'response_depth' end,
      case when NEW.teaching_approach is distinct from OLD.teaching_approach then 'teaching_approach' end,
      case when NEW.understanding_check_frequency is distinct from OLD.understanding_check_frequency then 'understanding_check_frequency' end,
      case when NEW.challenge_level is distinct from OLD.challenge_level then 'challenge_level' end,
      case when NEW.course_context_notes is distinct from OLD.course_context_notes then 'course_context_notes' end
    ], null);
    following := following || jsonb_build_object('changed_fields', to_jsonb(coalesce(changed, array[]::text[])));
  end if;
  insert into public.audit_events(actor_id, action, target_type, target_id, reason, before_state, after_state)
  values (public.current_app_user(), TG_OP, TG_TABLE_NAME, NEW.id,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed agent behaviour configuration'),
    previous, following);
  return NEW;
end $$;
create trigger audit_change
after insert or update on public.academic_agent_behaviour_configs
for each row execute function agent_behaviour_private.audit_behaviour_config();

create function agent_behaviour_private.require_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return actor;
end $$;

create function public.admin_set_agent_behaviour_config(
  p_programme_version_id uuid,
  p_role text,
  p_response_depth text,
  p_teaching_approach text,
  p_understanding_check_frequency text,
  p_challenge_level text,
  p_course_context_notes text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; notes text; result_id uuid;
begin
  actor := agent_behaviour_private.require_admin();
  notes := nullif(btrim(coalesce(p_course_context_notes, '')), '');
  if p_programme_version_id is null
    or p_role is null or p_role not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')
    or p_response_depth is null or p_response_depth not in ('CONCISE','STANDARD','DETAILED')
    or p_teaching_approach is null or p_teaching_approach not in ('CONCEPT_FIRST','WORKED_EXAMPLE_FIRST','GUIDED_QUESTIONING')
    or p_understanding_check_frequency is null or p_understanding_check_frequency not in ('LOW','STANDARD','HIGH')
    or p_challenge_level is null or p_challenge_level not in ('FOUNDATION','STANDARD','ADVANCED')
    or (notes is not null and length(notes) > 2000)
    or p_reason is null or length(btrim(p_reason)) not between 5 and 300 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists(select 1 from public.programme_versions where id = p_programme_version_id) then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  insert into public.academic_agent_behaviour_configs(
    programme_version_id, role, response_depth, teaching_approach,
    understanding_check_frequency, challenge_level, course_context_notes, created_by
  ) values (
    p_programme_version_id, p_role, p_response_depth, p_teaching_approach,
    p_understanding_check_frequency, p_challenge_level, notes, actor
  )
  on conflict (programme_version_id, role) do update
  set response_depth = excluded.response_depth,
      teaching_approach = excluded.teaching_approach,
      understanding_check_frequency = excluded.understanding_check_frequency,
      challenge_level = excluded.challenge_level,
      course_context_notes = excluded.course_context_notes,
      updated_at = clock_timestamp()
  returning id into result_id;
  return result_id;
end $$;

-- ==========================================================================
-- 1b. Publication-time behaviour bindings (historical default drift).
--
-- A version with no explicit row would otherwise be resolved against
-- whatever code-owned default and role behaviour version exist at
-- EXECUTION time, so a later code change to the default or to a role
-- baseline would silently rewrite the behaviour of already-published and
-- enrolled versions. Instead, PUBLICATION (the only normal materialisation
-- boundary) freezes one immutable binding per role, inside the publication
-- transaction, holding the actual effective semantic values: the pinned
-- Level-2 role behaviour version, the Level-3 source and config version,
-- the four enum values and the notes. Publication cannot commit without all
-- three verified bindings. Versions published before this migration are
-- bound once by the section-6 backfill. Enrolment and runtime only VERIFY:
-- a missing or invalid binding refuses enrolment and execution, and nothing
-- outside publication and that backfill ever creates or repairs a binding
-- or falls back to the current code default.
-- ==========================================================================

-- Versioned default values. A version's values never change; a future
-- default is a NEW version string, so bindings that name V1 keep V1 values.
create function agent_behaviour_private.default_config(p_config_version text) returns jsonb
language sql immutable set search_path='' as $$
  select case p_config_version
    when 'AGENT_BEHAVIOUR_DEFAULT_V1' then jsonb_build_object(
      'responseDepth', 'STANDARD', 'teachingApproach', 'CONCEPT_FIRST',
      'understandingCheckFrequency', 'STANDARD', 'challengeLevel', 'STANDARD',
      'courseContextNotes', null)
    else null
  end
$$;

-- The default a NEW binding uses. Mirror of src/domain/agent-behaviour.ts
-- AGENT_BEHAVIOUR_DEFAULT_VERSION; existing bindings never consult it.
create function agent_behaviour_private.current_default_version() returns text
language sql immutable set search_path='' as $$ select 'AGENT_BEHAVIOUR_DEFAULT_V1'::text $$;

create table public.academic_agent_behaviour_bindings (
  programme_version_id uuid not null references public.programme_versions(id),
  role text not null check(role in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')),
  binding_policy text not null default 'AGENT_BEHAVIOUR_BINDING_V1' check(binding_policy = 'AGENT_BEHAVIOUR_BINDING_V1'),
  -- Pinned Level-2 role behaviour version. Every known version of a role
  -- is listed here; a new role version needs a reviewed migration.
  behaviour_version text not null check(behaviour_version in ('PROFESSOR_BEHAVIOUR_V1','TUTOR_BEHAVIOUR_V1','LAB_INSTRUCTOR_BEHAVIOUR_V1')),
  config_source text not null check(config_source in ('EXPLICIT','DEFAULT')),
  config_version text not null check(config_version in ('AGENT_BEHAVIOUR_CONFIG_V1','AGENT_BEHAVIOUR_DEFAULT_V1')),
  config_id uuid references public.academic_agent_behaviour_configs(id),
  response_depth text not null check(response_depth in ('CONCISE','STANDARD','DETAILED')),
  teaching_approach text not null check(teaching_approach in ('CONCEPT_FIRST','WORKED_EXAMPLE_FIRST','GUIDED_QUESTIONING')),
  understanding_check_frequency text not null check(understanding_check_frequency in ('LOW','STANDARD','HIGH')),
  challenge_level text not null check(challenge_level in ('FOUNDATION','STANDARD','ADVANCED')),
  course_context_notes text check(course_context_notes is null or length(course_context_notes) between 1 and 2000),
  bound_event text not null check(bound_event in ('PUBLICATION','MIGRATION_BACKFILL')),
  semantic_digest text not null check(semantic_digest ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz not null default clock_timestamp(),
  primary key(programme_version_id, role),
  check(starts_with(behaviour_version, role || '_BEHAVIOUR_V')),
  check((config_source = 'EXPLICIT') = (config_id is not null)),
  check((config_source = 'EXPLICIT') = (config_version = 'AGENT_BEHAVIOUR_CONFIG_V1')),
  check(config_source = 'EXPLICIT' or course_context_notes is null)
);
alter table public.academic_agent_behaviour_bindings enable row level security;
revoke all on public.academic_agent_behaviour_bindings from public, anon, authenticated, service_role;

-- The binding's semantic material as canonical jsonb (jsonb text output is
-- key-ordered and deterministic).
create function agent_behaviour_private.binding_semantics(b public.academic_agent_behaviour_bindings) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'behaviourVersion', b.behaviour_version, 'source', b.config_source,
    'configVersion', b.config_version, 'configId', b.config_id,
    'config', jsonb_build_object(
      'responseDepth', b.response_depth, 'teachingApproach', b.teaching_approach,
      'understandingCheckFrequency', b.understanding_check_frequency, 'challengeLevel', b.challenge_level,
      'courseContextNotes', b.course_context_notes))
$$;

create function agent_behaviour_private.binding_digest(b public.academic_agent_behaviour_bindings) returns text
language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(
    'AGENT_BEHAVIOUR_BINDING_V1|' || b.programme_version_id::text || '|' || b.role || '|'
      || agent_behaviour_private.binding_semantics(b)::text, 'UTF8'), 'sha256'), 'hex')
$$;

-- Live (unbound) effective behaviour: the explicit row, or the CURRENT
-- versioned default, with the CURRENT role behaviour version. Used only for
-- drafts and to create a binding; never for a bound version's runtime.
create function agent_behaviour_private.live_effective(p_programme_version_id uuid, p_role text) returns jsonb
language plpgsql stable set search_path='' as $$
declare c public.academic_agent_behaviour_configs%rowtype; dv text := agent_behaviour_private.current_default_version();
begin
  select * into c from public.academic_agent_behaviour_configs
    where programme_version_id = p_programme_version_id and role = p_role;
  if found then
    return jsonb_build_object(
      'behaviourVersion', agent_behaviour_private.role_behaviour_version(p_role), 'source', 'EXPLICIT',
      'configVersion', c.policy_version, 'configId', c.id,
      'config', jsonb_build_object(
        'responseDepth', c.response_depth, 'teachingApproach', c.teaching_approach,
        'understandingCheckFrequency', c.understanding_check_frequency, 'challengeLevel', c.challenge_level,
        'courseContextNotes', c.course_context_notes));
  end if;
  return jsonb_build_object(
    'behaviourVersion', agent_behaviour_private.role_behaviour_version(p_role), 'source', 'DEFAULT',
    'configVersion', dv, 'configId', null, 'config', agent_behaviour_private.default_config(dv));
end $$;

-- Bindings are created only for a bound version, only with exactly the
-- live effective semantics at that moment, with a database-computed digest,
-- and are never updated or deleted.
create function agent_behaviour_private.guard_behaviour_binding() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP <> 'INSERT' then
    raise exception 'AGENT_BEHAVIOUR_BINDING_IMMUTABLE: a behaviour binding cannot be updated or deleted'
      using errcode = '55000';
  end if;
  if not agent_config_governance_private.version_bound(NEW.programme_version_id) then
    raise exception 'AGENT_BEHAVIOUR_BINDING_NOT_BOUND: only a published or enrolled version is bound'
      using errcode = '55000';
  end if;
  NEW.binding_policy := 'AGENT_BEHAVIOUR_BINDING_V1';
  NEW.bound_at := clock_timestamp();
  if agent_behaviour_private.binding_semantics(NEW)
      is distinct from agent_behaviour_private.live_effective(NEW.programme_version_id, NEW.role) then
    raise exception 'AGENT_BEHAVIOUR_BINDING_MISMATCH: a binding must freeze the effective behaviour exactly'
      using errcode = '55000';
  end if;
  NEW.semantic_digest := agent_behaviour_private.binding_digest(NEW);
  return NEW;
end $$;
create trigger guard_agent_behaviour_binding
before insert or update or delete on public.academic_agent_behaviour_bindings
for each row execute function agent_behaviour_private.guard_behaviour_binding();

-- Materialises missing bindings of a bound version. Called ONLY by the
-- publication trigger and by the one-time migration-051 backfill; no
-- runtime or enrolment path calls it. Idempotent.
create function agent_behaviour_private.bind_version(p_programme_version_id uuid, p_event text) returns void
language plpgsql security definer set search_path='' as $$
declare role_name text; eff jsonb;
begin
  foreach role_name in array array['PROFESSOR','TUTOR','LAB_INSTRUCTOR'] loop
    -- An existing binding is never recomputed: skip it before any insert,
    -- so a later default or role version can never touch (or, through the
    -- insert guard and CHECKs, block) an already-bound version.
    continue when exists(select 1 from public.academic_agent_behaviour_bindings
      where programme_version_id = p_programme_version_id and role = role_name);
    eff := agent_behaviour_private.live_effective(p_programme_version_id, role_name);
    insert into public.academic_agent_behaviour_bindings(
      programme_version_id, role, behaviour_version, config_source, config_version, config_id,
      response_depth, teaching_approach, understanding_check_frequency, challenge_level,
      course_context_notes, bound_event, semantic_digest
    ) values (
      p_programme_version_id, role_name, eff->>'behaviourVersion', eff->>'source', eff->>'configVersion',
      (eff->>'configId')::uuid,
      eff->'config'->>'responseDepth', eff->'config'->>'teachingApproach',
      eff->'config'->>'understandingCheckFrequency', eff->'config'->>'challengeLevel',
      eff->'config'->>'courseContextNotes', p_event, repeat('0', 64)
    ) on conflict (programme_version_id, role) do nothing;
  end loop;
end $$;

-- Every Level-2 role behaviour version this database recognises (reviewed
-- text exists for it in code). A binding naming anything else is invalid.
create function agent_behaviour_private.recognised_role_behaviour_version(p_role text, p_version text) returns boolean
language sql immutable set search_path='' as $$
  select (p_role, p_version) in (('PROFESSOR','PROFESSOR_BEHAVIOUR_V1'),
    ('TUTOR','TUTOR_BEHAVIOUR_V1'), ('LAB_INSTRUCTOR','LAB_INSTRUCTOR_BEHAVIOUR_V1'))
$$;

-- Verdict on one role's FROZEN binding, whatever the version's lifecycle
-- state. It never creates, repairs or replaces anything. The binding must
-- exist, carry the current binding policy and a matching database digest,
-- name a recognised role behaviour version and a recognised config version,
-- and agree with its frozen source: the explicit row it names (EXPLICIT),
-- or the fixed values of the default version it names with no explicit row
-- present (DEFAULT).
create function agent_behaviour_private.frozen_binding(p_programme_version_id uuid, p_role text) returns jsonb
language plpgsql stable set search_path='' as $$
declare b public.academic_agent_behaviour_bindings%rowtype; c public.academic_agent_behaviour_configs%rowtype;
  expected jsonb; semantics jsonb;
begin
  select * into b from public.academic_agent_behaviour_bindings
    where programme_version_id = p_programme_version_id and role = p_role;
  if not found then return jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_MISSING'); end if;
  semantics := agent_behaviour_private.binding_semantics(b);
  if b.config_source = 'EXPLICIT' and b.config_version = 'AGENT_BEHAVIOUR_CONFIG_V1' then
    select * into c from public.academic_agent_behaviour_configs
      where id = b.config_id and programme_version_id = p_programme_version_id and role = p_role;
    expected := case when found then jsonb_build_object(
      'responseDepth', c.response_depth, 'teachingApproach', c.teaching_approach,
      'understandingCheckFrequency', c.understanding_check_frequency, 'challengeLevel', c.challenge_level,
      'courseContextNotes', c.course_context_notes) end;
  elsif b.config_source = 'DEFAULT' then
    -- Null for an unrecognised default version.
    expected := agent_behaviour_private.default_config(b.config_version);
    if exists(select 1 from public.academic_agent_behaviour_configs
        where programme_version_id = p_programme_version_id and role = p_role) then
      expected := null;
    end if;
  end if;
  if b.binding_policy is distinct from 'AGENT_BEHAVIOUR_BINDING_V1'
    or b.semantic_digest is distinct from agent_behaviour_private.binding_digest(b)
    or not agent_behaviour_private.recognised_role_behaviour_version(p_role, b.behaviour_version)
    or expected is null or semantics->'config' is distinct from expected then
    return jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_INVALID');
  end if;
  return jsonb_build_object('ok', true, 'state', 'BOUND') || semantics;
end $$;

-- Raises a precise governed error unless every teaching role of the
-- version has a verified frozen binding. Verification only: it never
-- inserts, repairs, rebuilds a digest or falls back to a current default.
create function agent_behaviour_private.require_frozen_bindings(p_programme_version_id uuid) returns void
language plpgsql stable set search_path='' as $$
declare role_name text; verdict jsonb;
begin
  foreach role_name in array array['PROFESSOR','TUTOR','LAB_INSTRUCTOR'] loop
    verdict := agent_behaviour_private.frozen_binding(p_programme_version_id, role_name);
    if not (verdict->>'ok')::boolean then
      raise exception 'AGENT_%: % behaviour binding of programme version % is %',
        verdict->>'code', role_name, p_programme_version_id,
        case verdict->>'code' when 'BEHAVIOUR_BINDING_MISSING' then 'missing' else 'invalid' end
        using errcode = '55000';
    end if;
  end loop;
end $$;

-- PUBLICATION is the only normal materialisation boundary: inside the
-- publication transaction, freeze every teaching role, then require all
-- three verified bindings before the publication can commit.
create function agent_behaviour_private.bind_on_publication() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if NEW.status = 'PUBLISHED' and OLD.status is distinct from 'PUBLISHED' then
    perform agent_behaviour_private.bind_version(NEW.id, 'PUBLICATION');
    perform agent_behaviour_private.require_frozen_bindings(NEW.id);
  end if;
  return NEW;
end $$;
create trigger bind_agent_behaviour_on_publication
after update of status on public.programme_versions
for each row execute function agent_behaviour_private.bind_on_publication();

-- ENROLMENT only VERIFIES frozen behaviour. It never creates, recreates,
-- repairs or replaces a binding: a missing or invalid binding refuses the
-- enrolment (AGENT_BEHAVIOUR_BINDING_MISSING / _INVALID) and nothing is
-- written. It fires after guard_enrolment (trigger names order BEFORE
-- triggers), which has already locked the version FOR SHARE and refused an
-- unpublished one.
create function agent_behaviour_private.verify_on_enrolment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform agent_behaviour_private.require_frozen_bindings(NEW.programme_version_id);
  return NEW;
end $$;
create trigger verify_agent_behaviour_on_enrolment
before insert on public.enrolments
for each row execute function agent_behaviour_private.verify_on_enrolment();

-- THE effective behaviour resolver for a version/role. A draft resolves
-- live. A bound version resolves ONLY from its verified frozen binding;
-- otherwise {ok:false} and every caller fails closed.
create function agent_behaviour_private.effective_behaviour(p_programme_version_id uuid, p_role text) returns jsonb
language plpgsql stable set search_path='' as $$
begin
  if p_role is null or p_role not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_config_governance_private.version_bound(p_programme_version_id) then
    return jsonb_build_object('ok', true, 'state', 'DRAFT')
      || agent_behaviour_private.live_effective(p_programme_version_id, p_role);
  end if;
  return agent_behaviour_private.frozen_binding(p_programme_version_id, p_role);
end $$;

-- AGENT_BEHAVIOUR_FINGERPRINT_V1: sha256 over the version id and, in fixed
-- role order, each role's ACTUAL effective semantics: pinned behaviour
-- version, source, config version and the four values plus notes (for a
-- default, the default's concrete values, not merely its name). Draft:
-- live semantics, so any draft edit changes it. Bound: the frozen
-- bindings, so it is stable and never moves with a later code default.
-- Timestamps, actors and row ids are excluded. Null when a bound version's
-- binding is missing or does not verify.
create function agent_behaviour_private.behaviour_fingerprint(p_programme_version_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare canonical jsonb := '[]'::jsonb; role_name text; eff jsonb;
begin
  foreach role_name in array array['PROFESSOR','TUTOR','LAB_INSTRUCTOR'] loop
    eff := agent_behaviour_private.effective_behaviour(p_programme_version_id, role_name);
    if not (eff->>'ok')::boolean then return null; end if;
    canonical := canonical || jsonb_build_array(jsonb_build_object(
      'role', role_name, 'behaviourVersion', eff->'behaviourVersion', 'source', eff->'source',
      'configVersion', eff->'configVersion', 'config', eff->'config'));
  end loop;
  return encode(extensions.digest(convert_to(
    'AGENT_BEHAVIOUR_FINGERPRINT_V1|' || p_programme_version_id::text || '|' || canonical::text, 'UTF8'), 'sha256'), 'hex');
end $$;

-- Per-role effective behaviour for admin projections. With p_include_notes
-- false (the /admin/agents scope) only whether notes exist is reported.
create function agent_behaviour_private.effective_summary(p_programme_version_id uuid, p_include_notes boolean) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb := '[]'::jsonb; role_name text; eff jsonb;
begin
  foreach role_name in array array['PROFESSOR','TUTOR','LAB_INSTRUCTOR'] loop
    eff := agent_behaviour_private.effective_behaviour(p_programme_version_id, role_name);
    if not (eff->>'ok')::boolean then
      result := result || jsonb_build_array(jsonb_build_object('role', role_name, 'state', eff->>'code'));
    else
      result := result || jsonb_build_array(jsonb_build_object(
        'role', role_name, 'state', eff->>'state', 'behaviourVersion', eff->'behaviourVersion',
        'source', eff->'source', 'configVersion', eff->'configVersion',
        'responseDepth', eff->'config'->'responseDepth', 'teachingApproach', eff->'config'->'teachingApproach',
        'understandingCheckFrequency', eff->'config'->'understandingCheckFrequency',
        'challengeLevel', eff->'config'->'challengeLevel')
        || case when p_include_notes then jsonb_build_object('courseContextNotes', eff->'config'->'courseContextNotes')
                else jsonb_build_object('hasCourseContextNotes', jsonb_typeof(eff->'config'->'courseContextNotes') = 'string') end);
    end if;
  end loop;
  return result;
end $$;

create function public.admin_list_agent_behaviour_configs(p_programme_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform agent_behaviour_private.require_admin();
  if not exists(select 1 from public.programme_versions where id = p_programme_version_id) then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'programmeVersionId', p_programme_version_id,
    'frozen', agent_config_governance_private.version_bound(p_programme_version_id),
    'fingerprintPolicy', 'AGENT_BEHAVIOUR_FINGERPRINT_V1',
    'behaviourFingerprint', agent_behaviour_private.behaviour_fingerprint(p_programme_version_id),
    -- Effective per-role behaviour: live for a draft, the frozen binding
    -- once bound, or a BEHAVIOUR_BINDING_MISSING/INVALID state.
    'effective', agent_behaviour_private.effective_summary(p_programme_version_id, true),
    'configs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', c.role, 'responseDepth', c.response_depth, 'teachingApproach', c.teaching_approach,
        'understandingCheckFrequency', c.understanding_check_frequency, 'challengeLevel', c.challenge_level,
        'courseContextNotes', c.course_context_notes, 'updatedAt', c.updated_at
      ) order by c.role)
      from public.academic_agent_behaviour_configs c where c.programme_version_id = p_programme_version_id
    ), '[]'::jsonb));
end $$;

-- Learner-scoped effective behaviour read, ownership re-derived from the
-- authenticated learner. An enrolment means the version is bound, so this
-- returns ONLY the frozen binding (actual values and pinned role behaviour
-- version, including for a default) and fails closed when the binding is
-- missing or does not verify; it never resolves against the current code
-- default. Course context notes are bounded programme teaching context
-- that reaches the provider as data under the learner's own session, so
-- they are learner-readable by design (the authoring UI says so); nothing
-- confidential belongs there.
create function public.get_agent_behaviour_for_enrolment(p_enrolment_id uuid, p_role text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; e public.enrolments%rowtype; eff jsonb;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if p_enrolment_id is null or p_role is null or p_role not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into e from public.enrolments where id = p_enrolment_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  eff := agent_behaviour_private.effective_behaviour(e.programme_version_id, p_role);
  if not (eff->>'ok')::boolean then return jsonb_build_object('ok', false, 'code', eff->>'code'); end if;
  if eff->>'state' <> 'BOUND' then return jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_MISSING'); end if;
  return jsonb_build_object('ok', true, 'source', eff->'source', 'configVersion', eff->'configVersion',
    'behaviourVersion', eff->'behaviourVersion', 'config', eff->'config',
    'institutionalBaselineVersion', agent_behaviour_private.institutional_baseline_version());
end $$;

-- ==========================================================================
-- 2. Execution provenance.
-- ==========================================================================
create table public.academic_agent_execution_provenance (
  id uuid primary key default gen_random_uuid(),
  execution_kind text not null check(execution_kind in ('PROFESSOR_PROVIDER_V2','TUTOR_LAB_PROVIDER_V1')),
  professor_execution_id uuid unique references public.academic_provider_executions(id),
  tutor_lab_execution_id uuid unique references public.tutor_lab_provider_executions(id),
  student_id uuid not null references public.student_profiles(user_id),
  role text not null check(role in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR')),
  programme_version_id uuid not null references public.programme_versions(id),
  enrolment_id uuid not null references public.enrolments(id),
  classroom_id uuid references public.professor_classroom_sessions(id),
  runtime_profile_ref text check(runtime_profile_ref is null or runtime_profile_ref ~ '^[A-Za-z0-9_.-]{1,100}$'),
  -- The Level-1 institutional baseline version applied to this execution
  -- (version only, never its rule text).
  institutional_baseline_version text not null check(institutional_baseline_version in ('DUCELIO_INSTITUTIONAL_BASELINE_V1')),
  behaviour_version text not null check(behaviour_version in ('PROFESSOR_BEHAVIOUR_V1','TUTOR_BEHAVIOUR_V1','LAB_INSTRUCTOR_BEHAVIOUR_V1')),
  behaviour_config_source text not null check(behaviour_config_source in ('EXPLICIT','DEFAULT')),
  behaviour_config_version text not null check(behaviour_config_version in ('AGENT_BEHAVIOUR_CONFIG_V1','AGENT_BEHAVIOUR_DEFAULT_V1')),
  behaviour_config_id uuid references public.academic_agent_behaviour_configs(id),
  behaviour_fingerprint text not null check(behaviour_fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  check((execution_kind = 'PROFESSOR_PROVIDER_V2') = (professor_execution_id is not null)),
  check((execution_kind = 'TUTOR_LAB_PROVIDER_V1') = (tutor_lab_execution_id is not null)),
  check((execution_kind = 'PROFESSOR_PROVIDER_V2') = (role = 'PROFESSOR')),
  check((execution_kind = 'PROFESSOR_PROVIDER_V2') = (classroom_id is not null)),
  -- The pinned version from the binding, not the CURRENT code mirror, so a
  -- later role-baseline version never invalidates historical provenance.
  check(starts_with(behaviour_version, role || '_BEHAVIOUR_V')),
  check((behaviour_config_source = 'EXPLICIT') = (behaviour_config_id is not null)),
  check((behaviour_config_source = 'EXPLICIT') = (behaviour_config_version = 'AGENT_BEHAVIOUR_CONFIG_V1'))
);
alter table public.academic_agent_execution_provenance enable row level security;
revoke all on public.academic_agent_execution_provenance from public, anon, authenticated, service_role;

create function agent_behaviour_private.immutable_row() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'AGENT_BEHAVIOUR_HISTORY_IMMUTABLE: this record cannot be updated or deleted' using errcode = '55000'; end $$;
create trigger guard_agent_execution_provenance
before update or delete on public.academic_agent_execution_provenance
for each row execute function agent_behaviour_private.immutable_row();

-- The content releases that contributed data to one Professor provider
-- execution: identifiers and capability names only. No content, prompt,
-- learner prose or provider payload.
create table public.academic_agent_execution_context_releases (
  professor_execution_id uuid not null
    references public.academic_agent_execution_provenance(professor_execution_id),
  release_id uuid not null unique references public.academic_content_releases(id),
  capability_name text not null check(capability_name in (
    'get_lesson_context','get_lesson_objectives','get_learning_resources','get_current_mastery_state')),
  position integer not null check(position between 1 and 4),
  primary key(professor_execution_id, capability_name),
  unique(professor_execution_id, position)
);
alter table public.academic_agent_execution_context_releases enable row level security;
revoke all on public.academic_agent_execution_context_releases from public, anon, authenticated, service_role;
create trigger guard_agent_execution_context_release
before update or delete on public.academic_agent_execution_context_releases
for each row execute function agent_behaviour_private.immutable_row();

-- Authoritative effective behaviour identity for a version/role, from the
-- single resolver (the frozen binding once bound). ok is false when a bound
-- version's binding is missing or does not verify.
create function agent_behaviour_private.effective_config(p_programme_version_id uuid, p_role text,
  out ok boolean, out behaviour_version text, out source text, out config_version text, out config_id uuid)
language plpgsql stable set search_path='' as $$
declare eff jsonb;
begin
  eff := agent_behaviour_private.effective_behaviour(p_programme_version_id, p_role);
  ok := (eff->>'ok')::boolean;
  if ok then
    behaviour_version := eff->>'behaviourVersion'; source := eff->>'source';
    config_version := eff->>'configVersion'; config_id := (eff->>'configId')::uuid;
  end if;
end $$;

-- Authoritative runtime profile ref for a version/role: the same role-bound
-- resolution migration 036 uses (null when no configuration row exists).
create function agent_behaviour_private.runtime_profile_ref(p_programme_version_id uuid, p_role text) returns text
language plpgsql stable set search_path='' as $$
declare ref text;
begin
  select course_engineering_private.resolve_role_profile_ref(p_role, c.model_profile_ref) into ref
  from public.academic_agent_configs c
  where c.programme_version_id = p_programme_version_id and c.role = p_role;
  return ref;
end $$;

-- Tutor/Lab: fully database-derived, no caller input at all.
create function agent_behaviour_private.record_tutor_lab_provenance() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.tutor_lab_content_releases%rowtype; e public.enrolments%rowtype; eff record; fingerprint text;
begin
  select * into r from public.tutor_lab_content_releases where id = NEW.release_id;
  select * into e from public.enrolments where id = r.enrolment_id;
  select * into eff from agent_behaviour_private.effective_config(e.programme_version_id, NEW.agent_profile);
  fingerprint := agent_behaviour_private.behaviour_fingerprint(e.programme_version_id);
  -- Fail closed: no Tutor/Lab execution without a verified behaviour binding.
  if not eff.ok or fingerprint is null then
    raise exception 'AGENT_BEHAVIOUR_BINDING_INVALID: the programme version has no verified behaviour binding'
      using errcode = '55000';
  end if;
  insert into public.academic_agent_execution_provenance(
    execution_kind, tutor_lab_execution_id, student_id, role, programme_version_id, enrolment_id,
    runtime_profile_ref, institutional_baseline_version, behaviour_version, behaviour_config_source,
    behaviour_config_version, behaviour_config_id, behaviour_fingerprint
  ) values (
    'TUTOR_LAB_PROVIDER_V1', NEW.id, NEW.student_id, NEW.agent_profile, e.programme_version_id, e.id,
    agent_behaviour_private.runtime_profile_ref(e.programme_version_id, NEW.agent_profile),
    -- The legacy Tutor/Lab AUTHORIZE format is unchanged, so this is the
    -- database mirror; the server refuses to execute unless the learner
    -- read's mirror equals the code's applied baseline.
    agent_behaviour_private.institutional_baseline_version(),
    eff.behaviour_version, eff.source, eff.config_version, eff.config_id, fingerprint
  );
  return NEW;
end $$;
create trigger record_tutor_lab_execution_provenance
after insert on public.tutor_lab_provider_executions
for each row execute function agent_behaviour_private.record_tutor_lab_provenance();

-- Shared verifier for the two new attested protocols: same controller key
-- store, same freshness window and constant-time comparison as migration
-- 025's verify_command_v2, but distinct protocol tags, so a V1/V2 execution
-- attestation can never authorize a provenance or turn write and vice versa.
create function agent_behaviour_private.verify_mac(
  p_key_id uuid, p_canonical text, p_issued_at bigint, p_expires_at bigint, p_mac text
) returns boolean
language plpgsql security definer set search_path='' as $$
declare key_bytes bytea; expected bytea; supplied bytea; mismatch integer := 0; stamp numeric;
begin
  stamp := extract(epoch from clock_timestamp());
  if p_key_id is null or p_canonical is null
    or p_issued_at is null or p_issued_at > stamp + 5 or p_issued_at < stamp - 10
    or p_expires_at is null or p_expires_at::numeric <> p_issued_at::numeric + 10 or p_expires_at <= stamp
    or p_mac is null or p_mac !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select secret into key_bytes from academic_execution_private.controller_keys where id = p_key_id and revoked_at is null;
  if not found then return false; end if;
  expected := extensions.hmac(convert_to(p_canonical, 'UTF8'), key_bytes, 'sha256');
  supplied := decode(p_mac, 'hex');
  for i in 0..31 loop mismatch := mismatch | (get_byte(expected, i) # get_byte(supplied, i)); end loop;
  return mismatch = 0;
end $$;

create function public.record_professor_execution_provenance(
  p_key_id uuid, p_execution_id uuid, p_release_id uuid, p_class_session_id uuid,
  p_context_capabilities text[], p_context_release_ids uuid[],
  p_runtime_profile_ref text, p_institutional_baseline_version text,
  p_behaviour_version text, p_behaviour_config_version text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; x public.academic_provider_executions%rowtype;
  classroom public.professor_classroom_sessions%rowtype; eff record; db_ref text; fingerprint text;
  manifest text; expected text[]; config_caps text[]; outer_release public.academic_content_releases%rowtype;
  n integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_release_id is null or p_class_session_id is null
    or p_institutional_baseline_version is null
    or p_behaviour_version is null or p_behaviour_config_version is null
    or p_context_capabilities is null or p_context_release_ids is null
    or cardinality(p_context_capabilities) not between 2 and 4
    or cardinality(p_context_capabilities) <> cardinality(p_context_release_ids)
    or array_position(p_context_capabilities, null) is not null
    or array_position(p_context_release_ids, null) is not null
    or (p_runtime_profile_ref is not null and p_runtime_profile_ref !~ '^[A-Za-z0-9_.-]{1,100}$') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  -- The manifest is part of the attested message, so application code can
  -- never substitute different release ids after the fact.
  manifest := array_to_string(array(
    select u.capability || ':' || u.release_id::text
    from unnest(p_context_capabilities, p_context_release_ids) with ordinality as u(capability, release_id, n)
    order by u.n), ',');
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1', 'PROFESSOR', p_key_id::text, actor::text,
      p_execution_id::text, p_release_id::text, p_class_session_id::text, manifest,
      coalesce(p_runtime_profile_ref, 'NONE'), p_institutional_baseline_version,
      p_behaviour_version, p_behaviour_config_version,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  select * into x from public.academic_provider_executions
    where id = p_execution_id and student_id = actor and release_id = p_release_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'AUTHORIZED' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if exists(select 1 from public.academic_agent_execution_provenance where professor_execution_id = x.id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_RECORDED');
  end if;
  select * into classroom from public.professor_classroom_sessions
    where student_id = actor and class_session_id = p_class_session_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  db_ref := agent_behaviour_private.runtime_profile_ref(classroom.programme_version_id, 'PROFESSOR');
  select * into eff from agent_behaviour_private.effective_config(classroom.programme_version_id, 'PROFESSOR');
  fingerprint := agent_behaviour_private.behaviour_fingerprint(classroom.programme_version_id);
  if not eff.ok or fingerprint is null then
    return jsonb_build_object('ok', false, 'code', 'BEHAVIOUR_BINDING_INVALID');
  end if;
  -- The claimed role behaviour version must be the version PINNED by the
  -- binding, not merely the current code version.
  if db_ref is distinct from p_runtime_profile_ref
    or p_institutional_baseline_version is distinct from agent_behaviour_private.institutional_baseline_version()
    or p_behaviour_version is distinct from eff.behaviour_version
    or p_behaviour_config_version is distinct from eff.config_version then
    return jsonb_build_object('ok', false, 'code', 'PROVENANCE_MISMATCH');
  end if;
  -- The complete manifest: lesson context (the execution's own, outermost
  -- release) and objectives always, then resources and persisted mastery
  -- exactly when the stored configuration authorises them, in that order.
  select c.capabilities into config_caps from public.academic_agent_configs c
    where c.programme_version_id = classroom.programme_version_id and c.role = 'PROFESSOR';
  expected := array['get_lesson_context','get_lesson_objectives'];
  if 'get_learning_resources' = any(coalesce(config_caps, array[]::text[])) then
    expected := expected || 'get_learning_resources'::text;
  end if;
  if 'get_current_mastery_state' = any(coalesce(config_caps, array[]::text[])) then
    expected := expected || 'get_current_mastery_state'::text;
  end if;
  if p_context_capabilities is distinct from expected or p_context_release_ids[1] <> p_release_id
    or (select count(distinct r) from unnest(p_context_release_ids) r) <> cardinality(p_context_release_ids) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_MANIFEST_MISMATCH');
  end if;
  select * into outer_release from public.academic_content_releases where id = p_release_id;
  for n in 1..cardinality(p_context_release_ids) loop
    if not exists(select 1 from public.academic_content_releases r
        where r.id = p_context_release_ids[n] and r.student_id = actor
          and r.agent_profile = 'PROFESSOR' and r.capability_contract_version = 'PROFESSOR_READ_V2'
          and r.capability_name = p_context_capabilities[n]
          and r.state = 'ACTIVE' and r.expires_at > clock_timestamp()
          and r.started_at >= outer_release.started_at)
      or exists(select 1 from public.academic_agent_execution_context_releases m
        where m.release_id = p_context_release_ids[n]) then
      return jsonb_build_object('ok', false, 'code', 'CONTEXT_RELEASE_INVALID');
    end if;
  end loop;
  insert into public.academic_agent_execution_provenance(
    execution_kind, professor_execution_id, student_id, role, programme_version_id, enrolment_id, classroom_id,
    runtime_profile_ref, institutional_baseline_version, behaviour_version, behaviour_config_source,
    behaviour_config_version, behaviour_config_id, behaviour_fingerprint
  ) values (
    'PROFESSOR_PROVIDER_V2', x.id, actor, 'PROFESSOR', classroom.programme_version_id, classroom.enrolment_id, classroom.id,
    db_ref, p_institutional_baseline_version, eff.behaviour_version, eff.source, eff.config_version, eff.config_id, fingerprint
  );
  insert into public.academic_agent_execution_context_releases(professor_execution_id, release_id, capability_name, position)
  select x.id, u.release_id, u.capability, u.n
  from unnest(p_context_capabilities, p_context_release_ids) with ordinality as u(capability, release_id, n);
  return jsonb_build_object('ok', true);
end $$;

-- ==========================================================================
-- 3. Professor classroom memory.
-- ==========================================================================
create table public.professor_classroom_turns (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.professor_classroom_sessions(id),
  student_id uuid not null references public.student_profiles(user_id),
  execution_id uuid not null unique references public.academic_provider_executions(id),
  turn_number integer not null check(turn_number between 1 and 200),
  interaction_kind text not null check(interaction_kind in ('BEGIN_LESSON','LEARNER_QUESTION')),
  learner_message text check(learner_message is null or length(learner_message) between 1 and 2000),
  professor_message text not null check(length(professor_message) between 1 and 12000),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(classroom_id, turn_number),
  check((interaction_kind = 'BEGIN_LESSON') = (learner_message is null))
);
alter table public.professor_classroom_turns enable row level security;
revoke all on public.professor_classroom_turns from public, anon, authenticated, service_role;
create trigger guard_professor_classroom_turn
before update or delete on public.professor_classroom_turns
for each row execute function agent_behaviour_private.immutable_row();

create function public.record_professor_classroom_turn(
  p_key_id uuid, p_execution_id uuid, p_class_session_id uuid, p_interaction_kind text,
  p_learner_message text, p_professor_message text,
  p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; classroom public.professor_classroom_sessions%rowtype; x public.academic_provider_executions%rowtype;
  turns integer;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_execution_id is null or p_class_session_id is null
    or p_interaction_kind is null or p_interaction_kind not in ('BEGIN_LESSON','LEARNER_QUESTION')
    or ((p_interaction_kind = 'BEGIN_LESSON') <> (p_learner_message is null))
    or (p_learner_message is not null and length(p_learner_message) not between 1 and 2000)
    or p_professor_message is null or length(p_professor_message) not between 1 and 12000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  if not agent_behaviour_private.verify_mac(p_key_id, concat_ws(E'\n',
      'DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1', 'PROFESSOR', p_key_id::text, actor::text,
      p_execution_id::text, p_class_session_id::text, p_interaction_kind,
      encode(extensions.digest(convert_to(coalesce(p_learner_message, ''), 'UTF8'), 'sha256'), 'hex'),
      encode(extensions.digest(convert_to(p_professor_message, 'UTF8'), 'sha256'), 'hex'),
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac) then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_INVALID');
  end if;
  select * into classroom from public.professor_classroom_sessions
    where student_id = actor and class_session_id = p_class_session_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into x from public.academic_provider_executions where id = p_execution_id and student_id = actor;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if x.state <> 'SUCCEEDED' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if not exists(select 1 from public.academic_agent_execution_provenance
      where professor_execution_id = x.id and classroom_id = classroom.id) then
    return jsonb_build_object('ok', false, 'code', 'CONTEXT_CONFLICT');
  end if;
  if exists(select 1 from public.professor_classroom_turns where execution_id = x.id) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  -- Turns are numbered contiguously from 1, so the highest number is both
  -- the count and the capacity position.
  select coalesce(max(turn_number), 0) into turns from public.professor_classroom_turns where classroom_id = classroom.id;
  if turns >= 200 then return jsonb_build_object('ok', false, 'code', 'TURN_LIMIT_REACHED'); end if;
  insert into public.professor_classroom_turns(
    classroom_id, student_id, execution_id, turn_number, interaction_kind, learner_message, professor_message
  ) values (classroom.id, actor, x.id, turns + 1, p_interaction_kind, p_learner_message, p_professor_message);
  return jsonb_build_object('ok', true, 'duplicate', false);
end $$;

-- Owning learner only, and only while the controlled-assessment firewall
-- allows explanation: a transcript of Professor explanations is explanation
-- content.
create function public.list_my_professor_classroom_turns(p_class_session_id uuid, p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; classroom public.professor_classroom_sessions%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_class_session_id is null or p_limit is null or p_limit not between 1 and 50 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  select * into classroom from public.professor_classroom_sessions
    where student_id = actor and class_session_id = p_class_session_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  if public.academic_content_release_explain_allowed() is not true then
    return jsonb_build_object('ok', false, 'code', 'ACTIVITY_BLOCKED');
  end if;
  return jsonb_build_object('ok', true,
    'totalTurns', (select count(*) from public.professor_classroom_turns where classroom_id = classroom.id),
    'capacity', 200,
    'capacityReached', coalesce((select max(turn_number) from public.professor_classroom_turns where classroom_id = classroom.id), 0) >= 200,
    -- SUCCEEDED (so shown to the learner), provenance-bound exchanges of
    -- this classroom with no recorded turn: memory is DEGRADED, not
    -- complete, and the Professor is told so.
    'unrecordedExchanges', (select count(*) from public.academic_agent_execution_provenance p
      join public.academic_provider_executions x on x.id = p.professor_execution_id
      where p.classroom_id = classroom.id and x.state = 'SUCCEEDED'
        and not exists(select 1 from public.professor_classroom_turns t where t.execution_id = x.id)),
    'turns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'turnNumber', t.turn_number, 'interactionKind', t.interaction_kind,
        'learnerMessage', t.learner_message, 'professorMessage', t.professor_message,
        'recordedAt', t.recorded_at) order by t.turn_number)
      from (select * from public.professor_classroom_turns where classroom_id = classroom.id
            order by turn_number desc limit p_limit) t
    ), '[]'::jsonb));
end $$;

-- ==========================================================================
-- 4. Authoritative classroom timing (read-only; touches no row).
-- ==========================================================================
create function public.get_my_professor_classroom_state(p_class_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; classroom public.professor_classroom_sessions%rowtype; s public.class_sessions%rowtype;
  l public.lessons%rowtype; m public.modules%rowtype; stamp timestamptz;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if p_class_session_id is null then return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT'); end if;
  select * into classroom from public.professor_classroom_sessions
    where student_id = actor and class_session_id = p_class_session_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_FORBIDDEN'); end if;
  select * into s from public.class_sessions where id = p_class_session_id;
  if s.status = 'CANCELLED' then return jsonb_build_object('ok', false, 'code', 'CANCELLED'); end if;
  stamp := clock_timestamp();
  if stamp < s.scheduled_start then return jsonb_build_object('ok', false, 'code', 'NOT_YET_STARTED'); end if;
  select * into l from public.lessons where id = classroom.lesson_id;
  select * into m from public.modules where id = l.module_id;
  return jsonb_build_object('ok', true, 'state', jsonb_build_object(
    'classroomId', classroom.id, 'classSessionId', classroom.class_session_id,
    'enrolmentId', classroom.enrolment_id, 'programmeVersionId', classroom.programme_version_id,
    'lessonId', classroom.lesson_id, 'lessonTitle', l.title, 'lessonPosition', l.position,
    'moduleTitle', m.title, 'scheduledStart', s.scheduled_start, 'scheduledEnd', s.scheduled_end,
    'serverNow', stamp,
    'mode', case when stamp <= s.scheduled_end then 'LIVE' else 'CATCH_UP' end));
end $$;

-- ==========================================================================
-- 5. /admin/agents scope projection: adds Level-3 behaviour state per role
--    (whether notes are stored, never their text). Same signature as 050.
-- ==========================================================================
create or replace function agent_config_governance_private.scope_summary(p_version uuid) returns jsonb
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
    'behaviourFingerprint', agent_behaviour_private.behaviour_fingerprint(v.id),
    'behaviourEffective', agent_behaviour_private.effective_summary(v.id, false),
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
    ), '[]'::jsonb),
    'behaviourConfigs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', b.role,
        'responseDepth', b.response_depth,
        'teachingApproach', b.teaching_approach,
        'understandingCheckFrequency', b.understanding_check_frequency,
        'challengeLevel', b.challenge_level,
        'hasCourseContextNotes', b.course_context_notes is not null
      ) order by b.role)
      from public.academic_agent_behaviour_configs b where b.programme_version_id = v.id
    ), '[]'::jsonb)
  )
  from public.programme_versions v
  join public.programmes p on p.id = v.programme_id
  where v.id = p_version
$$;

-- ==========================================================================
-- 6. Backfill: freeze the behaviour of every version that is ALREADY bound
--    when this migration runs. No such version has a Level-3 row (the
--    table is new and the freeze refuses first inserts), so each is bound
--    to AGENT_BEHAVIOUR_DEFAULT_V1's values and the V1 role baselines,
--    exactly what it would otherwise resolve to today. Version rows are
--    locked in id order, the same FOR UPDATE publication takes; the
--    publication trigger already exists, so a concurrent publication
--    either waits or is bound by the trigger. Idempotent.
-- ==========================================================================
do $$ declare v uuid; begin
  for v in select pv.id from public.programme_versions pv
      where agent_config_governance_private.version_bound(pv.id) order by pv.id for update loop
    perform agent_behaviour_private.bind_version(v, 'MIGRATION_BACKFILL');
  end loop;
end $$;

-- ==========================================================================
-- ACL hardening and effective-privilege self-verification.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'agent_behaviour_private'
       or (n.nspname = 'agent_config_governance_private' and p.proname = 'scope_summary')
       or (n.nspname = 'public' and p.proname in (
         'admin_set_agent_behaviour_config','admin_list_agent_behaviour_configs','get_agent_behaviour_for_enrolment',
         'record_professor_execution_provenance','record_professor_classroom_turn',
         'list_my_professor_classroom_turns','get_my_professor_classroom_state')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.admin_set_agent_behaviour_config(uuid,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.admin_list_agent_behaviour_configs(uuid) to authenticated;
grant execute on function public.get_agent_behaviour_for_enrolment(uuid,text) to authenticated;
grant execute on function public.record_professor_execution_provenance(uuid,uuid,uuid,uuid,text[],uuid[],text,text,text,text,bigint,bigint,text) to authenticated;
grant execute on function public.record_professor_classroom_turn(uuid,uuid,uuid,text,text,text,bigint,bigint,text) to authenticated;
grant execute on function public.list_my_professor_classroom_turns(uuid,integer) to authenticated;
grant execute on function public.get_my_professor_classroom_state(uuid) to authenticated;

do $$
declare r text; f record; t text;
  public_fns text[] := array['admin_set_agent_behaviour_config','admin_list_agent_behaviour_configs',
    'get_agent_behaviour_for_enrolment','record_professor_execution_provenance','record_professor_classroom_turn',
    'list_my_professor_classroom_turns','get_my_professor_classroom_state'];
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r, 'agent_behaviour_private', 'USAGE,CREATE') then
      raise exception 'Unsafe agent behaviour schema privileges for %', r;
    end if;
    foreach t in array array['public.academic_agent_behaviour_configs','public.academic_agent_behaviour_bindings',
        'public.academic_agent_execution_provenance',
        'public.academic_agent_execution_context_releases','public.professor_classroom_turns'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe privileges for % on %', r, t;
      end if;
    end loop;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'agent_behaviour_private'
         or (n.nspname = 'agent_config_governance_private' and p.proname = 'scope_summary')
         or (n.nspname = 'public' and p.proname = any(public_fns)) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.nspname = 'public') then
        raise exception 'Unsafe agent behaviour function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
