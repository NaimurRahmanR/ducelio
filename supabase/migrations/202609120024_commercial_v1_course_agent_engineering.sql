-- Commercial V1: reusable Course & Agent Engineering foundation.
-- Additive/corrective only; migrations 001-023 are unmodified. This adds a
-- governed staging/publication boundary that reuses existing Programme /
-- ProgrammeVersion / Module / Lesson / LessonObjective / LearningResource
-- authority (migrations 001, 006, 012) rather than duplicating it, plus a
-- reusable per-role academic-agent configuration table. It introduces no
-- provider, model call, learner-facing AI surface or change to the
-- migration 021/022 academic-execution governance.
--
-- Mirrors the migration 022/023 ACL-hardening pattern throughout: service_role
-- has BYPASSRLS in this project's Supabase-like setup (see tests/db-helper.ts),
-- so RLS alone never protects these objects from it. Every table/function
-- below is explicitly revoked from public, anon, authenticated and
-- service_role at creation, and a closing effective-ACL assertion fails this
-- migration's deployment if any of those roles retains unsafe inherited
-- access. Only authenticated ever receives an explicit, reviewed EXECUTE
-- grant, and only on the exact RPCs documented below.

create extension if not exists pgcrypto with schema extensions;
do $$ begin
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions') then
    raise exception 'Course & Agent Engineering requires pgcrypto in extensions';
  end if;
end $$;

create schema course_engineering_private;
revoke all on schema course_engineering_private from public, anon, authenticated, service_role;

create table public.course_package_imports (
  id uuid primary key default gen_random_uuid(),
  package_key text not null check(package_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(package_key) between 3 and 80),
  package_revision integer not null check(package_revision > 0),
  schema_version text not null check(schema_version = 'COURSE_PACKAGE_V1'),
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
  raw_package jsonb not null,
  validation_report jsonb,
  status text not null default 'IMPORTED' check(status in ('IMPORTED','VALIDATED','APPLIED','PUBLISHED','REJECTED')),
  programme_id uuid references public.programmes(id),
  programme_version_id uuid references public.programme_versions(id),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  validated_at timestamptz,
  applied_at timestamptz,
  applied_by uuid references public.app_users(id),
  published_at timestamptz,
  published_by uuid references public.app_users(id),
  rejected_at timestamptz,
  rejected_by uuid references public.app_users(id),
  rejected_reason text check(rejected_reason is null or length(trim(rejected_reason)) between 5 and 300),
  unique(package_key, package_revision),
  check(
    (status = 'IMPORTED' and validation_report is null and programme_id is null and programme_version_id is null
      and applied_at is null and applied_by is null and published_at is null and published_by is null
      and rejected_at is null and rejected_by is null and rejected_reason is null)
    or
    (status = 'VALIDATED' and validation_report is not null and programme_id is null and programme_version_id is null
      and applied_at is null and applied_by is null and published_at is null and published_by is null
      and rejected_at is null and rejected_by is null and rejected_reason is null)
    or
    (status = 'APPLIED' and validation_report is not null and programme_id is not null and programme_version_id is not null
      and applied_at is not null and applied_by is not null and published_at is null and published_by is null
      and rejected_at is null and rejected_by is null and rejected_reason is null)
    or
    (status = 'PUBLISHED' and validation_report is not null and programme_id is not null and programme_version_id is not null
      and applied_at is not null and applied_by is not null and published_at is not null and published_by is not null
      and rejected_at is null and rejected_by is null and rejected_reason is null)
    or
    (status = 'REJECTED' and rejected_at is not null and rejected_by is not null and rejected_reason is not null)
  )
);

create index course_package_imports_key on public.course_package_imports(package_key, package_revision desc);
create index course_package_imports_status on public.course_package_imports(status, created_at desc);

-- No direct table access at all, even for admin roles: raw_package can embed
-- controlled-assessment answer keys/marking guidance, and this project never
-- exposes those through an ordinary readable table (see assessment_answer_keys
-- in migration 016). All access is through the RPCs below, which redact that
-- content before any preview/listing response. service_role is revoked
-- explicitly too (see header); BYPASSRLS does not bypass object ACLs.
alter table public.course_package_imports enable row level security;
revoke all on public.course_package_imports from public, anon, authenticated, service_role;

create function public.guard_course_package_import_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Course package imports are immutable institutional history';
  end if;

  if NEW.package_key <> OLD.package_key
    or NEW.package_revision <> OLD.package_revision
    or NEW.schema_version <> OLD.schema_version
    or NEW.content_hash <> OLD.content_hash
    or NEW.raw_package is distinct from OLD.raw_package
    or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at then
    raise exception 'Course package identity and content are immutable';
  end if;

  if OLD.programme_version_id is not null
    and NEW.programme_version_id is distinct from OLD.programme_version_id then
    raise exception 'Course package curriculum binding is immutable once applied';
  end if;

  if OLD.validation_report is not null
    and NEW.validation_report is distinct from OLD.validation_report then
    raise exception 'Course package validation report is immutable once recorded';
  end if;

  if NEW.status = OLD.status then return NEW; end if;
  if OLD.status = 'IMPORTED' and NEW.status in ('VALIDATED','REJECTED') then return NEW; end if;
  if OLD.status = 'VALIDATED' and NEW.status in ('APPLIED','REJECTED') then return NEW; end if;
  if OLD.status = 'APPLIED' and NEW.status = 'PUBLISHED' then return NEW; end if;

  raise exception 'Invalid course package lifecycle transition';
end $$;

create trigger guard_course_package_import_history
before update or delete on public.course_package_imports
for each row execute function public.guard_course_package_import_history();

create function public.audit_course_package_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then following := to_jsonb(NEW); end if;

  -- Package content can embed controlled-assessment answer keys/marking
  -- guidance and full lecture text; keep audit metadata only.
  previous := previous - 'raw_package' - 'validation_report';
  following := following - 'raw_package' - 'validation_report';
  target := coalesce(following->>'id', previous->>'id')::uuid;

  insert into public.audit_events(
    actor_id, action, target_type, target_id, reason, before_state, after_state
  ) values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, target,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed course package workflow'),
    previous, following
  );

  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end $$;

create trigger audit_change
after insert or update or delete on public.course_package_imports
for each row execute function public.audit_course_package_change();

-- Strips controlled-assessment answer keys/marking guidance from a package's
-- assessment templates before any preview/listing response leaves the RPC
-- boundary. Never exposed to anon/authenticated/service_role directly.
create function course_engineering_private.redact_answer_keys(p_package jsonb) returns jsonb
language sql stable as $$
  select jsonb_set(
    p_package,
    '{assessmentTemplates}',
    coalesce((
      select jsonb_agg(
        jsonb_set(
          template,
          '{questions}',
          coalesce((
            select jsonb_agg(question - 'expectedAnswer' - 'markingGuidance')
            from jsonb_array_elements(template->'questions') as question
          ), '[]'::jsonb)
        )
      )
      from jsonb_array_elements(p_package->'assessmentTemplates') as template
    ), '[]'::jsonb)
  )
$$;

-- Independent, database-owned structural re-verification of exactly what
-- apply_course_package() is about to materialise into institutional tables
-- (programme/module/lesson/objective/resource). This is the trust boundary
-- this checkpoint chose: the richer TypeScript cross-reference validator
-- (duplicate keys, assignment/assessment template lessonRef/objectiveRefs)
-- still runs client-side and is recorded informationally in
-- validation_report, because those templates are never written to an
-- institutional table by this checkpoint (see apply_course_package's own
-- comment). Everything that DOES get written is re-checked here,
-- independently of any caller-supplied report, so neither a direct
-- authenticated RPC call nor a forged/tampered VALIDATED status can make a
-- malformed package reach APPLIED/PUBLISHED. Called from both
-- mark_course_package_validated (the gate into VALIDATED) and
-- apply_course_package itself (defense in depth at the actual mutation
-- point), so a forged validation state is never sufficient on its own.
create function course_engineering_private.assert_materializable(p_package jsonb) returns void
language plpgsql as $$
declare
  module_item jsonb;
  lesson_item jsonb;
  objective_item jsonb;
  resource_item jsonb;
  module_positions integer[] := array[]::integer[];
  lesson_positions integer[];
  objective_positions integer[];
  module_position integer;
  lesson_position integer;
  objective_position integer;
  resource_position integer;
begin
  if jsonb_typeof(p_package) is distinct from 'object' then
    raise exception 'Package content must be a JSON object';
  end if;
  if p_package->>'schemaVersion' is distinct from 'COURSE_PACKAGE_V1' then
    raise exception 'Unsupported or missing package schema version';
  end if;
  if jsonb_typeof(p_package->'programme') is distinct from 'object'
    or coalesce(length(trim(p_package->'programme'->>'title')), 0) = 0
    or coalesce(length(trim(p_package->'programme'->>'examinationBody')), 0) = 0
    or coalesce(length(trim(p_package->'programme'->>'qualificationName')), 0) = 0 then
    raise exception 'Package programme metadata is missing required fields';
  end if;
  if jsonb_typeof(p_package->'curriculumVersion') is distinct from 'object'
    or coalesce(length(trim(p_package->'curriculumVersion'->>'label')), 0) = 0 then
    raise exception 'Package curriculum version metadata is missing a label';
  end if;
  if jsonb_typeof(p_package->'modules') is distinct from 'array'
    or jsonb_array_length(p_package->'modules') < 1 then
    raise exception 'Package must declare at least one module';
  end if;

  for module_item in select jsonb_array_elements(p_package->'modules') loop
    if jsonb_typeof(module_item) is distinct from 'object'
      or coalesce(length(trim(module_item->>'title')), 0) = 0
      or jsonb_typeof(module_item->'position') is distinct from 'number' then
      raise exception 'A module is missing a required title or position';
    end if;
    module_position := (module_item->>'position')::integer;
    if module_position <= 0 or module_position = any(module_positions) then
      raise exception 'A module position is invalid or duplicated';
    end if;
    module_positions := module_positions || module_position;

    if jsonb_typeof(module_item->'lessons') is distinct from 'array'
      or jsonb_array_length(module_item->'lessons') < 1 then
      raise exception 'Every module must declare at least one lesson';
    end if;

    lesson_positions := array[]::integer[];
    for lesson_item in select jsonb_array_elements(module_item->'lessons') loop
      if jsonb_typeof(lesson_item) is distinct from 'object'
        or coalesce(length(trim(lesson_item->>'title')), 0) = 0
        or jsonb_typeof(lesson_item->'position') is distinct from 'number' then
        raise exception 'A lesson is missing a required title or position';
      end if;
      lesson_position := (lesson_item->>'position')::integer;
      if lesson_position <= 0 or lesson_position = any(lesson_positions) then
        raise exception 'A lesson position is invalid or duplicated within its module';
      end if;
      lesson_positions := lesson_positions || lesson_position;

      if jsonb_typeof(lesson_item->'objectives') is distinct from 'array'
        or jsonb_array_length(lesson_item->'objectives') < 1 then
        raise exception 'Every lesson must declare at least one objective';
      end if;

      objective_positions := array[]::integer[];
      for objective_item in select jsonb_array_elements(lesson_item->'objectives') loop
        if jsonb_typeof(objective_item) is distinct from 'object'
          or coalesce(length(trim(objective_item->>'description')), 0) = 0
          or jsonb_typeof(objective_item->'position') is distinct from 'number' then
          raise exception 'An objective is missing a required description or position';
        end if;
        objective_position := (objective_item->>'position')::integer;
        if objective_position <= 0 or objective_position = any(objective_positions) then
          raise exception 'An objective position is invalid or duplicated within its lesson';
        end if;
        objective_positions := objective_positions || objective_position;
      end loop;

      if jsonb_typeof(lesson_item->'resources') is distinct from 'array' then
        raise exception 'A lesson resources field must be an array';
      end if;
      for resource_item in select jsonb_array_elements(lesson_item->'resources') loop
        if jsonb_typeof(resource_item) is distinct from 'object'
          or resource_item->>'kind' not in ('LECTURE_NOTE','REFERENCE_LINK')
          or coalesce(length(trim(resource_item->>'title')), 0) = 0
          or jsonb_typeof(resource_item->'position') is distinct from 'number' then
          raise exception 'A learning resource is missing required fields';
        end if;
        resource_position := (resource_item->>'position')::integer;
        if resource_position <= 0 then
          raise exception 'A learning resource position must be positive';
        end if;
        if resource_item->>'kind' = 'LECTURE_NOTE' then
          if coalesce(length(trim(resource_item->>'body')), 0) = 0 or resource_item->>'url' is not null then
            raise exception 'A lecture-note resource requires body text and no URL';
          end if;
        else
          if coalesce(resource_item->>'url', '') !~ '^https://\S+$' or resource_item->>'body' is not null then
            raise exception 'A reference-link resource requires an HTTPS URL and no body text';
          end if;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- Single source of truth for the reviewed per-role capability allowlist,
-- shared by set_agent_config (below) and assert_full_package_valid (next),
-- so the two never drift into divergent copies of the same policy. Must
-- stay byte-for-byte in step with src/domain/academic-capability-policy.ts's
-- roleCapabilityCatalogue.
create function course_engineering_private.role_capability_allowlist(p_role text) returns text[]
language sql immutable set search_path='' as $$
  select case p_role
    when 'PROFESSOR' then array[
      'get_actor_context','get_activity_permissions','get_current_learner_context',
      'get_lesson_context','get_lesson_objectives','get_current_class_session',
      'get_learning_resources','get_permitted_learning_history','get_current_mastery_state'
    ]
    when 'TUTOR' then array[
      'get_current_learner_context','get_lesson_context','get_lesson_objectives','get_learning_resources'
    ]
    when 'LAB_INSTRUCTOR' then array[
      'get_current_learner_context','get_lesson_context','get_lesson_objectives'
    ]
    when 'EXAMINER' then array[
      'get_current_learner_context','get_lesson_context'
    ]
    when 'COUNSELLOR' then array['get_current_learner_context']
    else null
  end
$$;

-- Shared structural primitives for assert_full_package_valid below. Every
-- local reference/key field in COURSE_PACKAGE_V1 uses the exact same
-- bounded-identifier shape (src/domain/course-package.ts's localRef schema:
-- trimmed, 1..80 chars, ^[A-Za-z0-9_.-]+$); modelProfileRef uses the same
-- shape at a different max length (100). Every bounded free-text field uses
-- the same "trim, then check length" shape, with or without null allowed.
-- Every nested package object is a z.strictObject: no field may be missing
-- (enforced by the specific checks below) and no extra field may be present
-- (enforced once here, everywhere a package object is checked), so a
-- malformed or tampered raw_package can never silently carry content the
-- TypeScript contract would have rejected. Factored out once so every call
-- site enforces identically the same rule instead of risking independently
-- drifting copies, and so every check is ->`jsonb_typeof`-based rather than
-- relying on the `->>` text operator, which silently stringifies a non-
-- string JSON value (a number, boolean or object) and would otherwise let
-- one through undetected.
create function course_engineering_private.assert_bounded_identifier(
  p_value jsonb, p_max integer, p_context text
) returns void
language plpgsql immutable set search_path='' as $$
declare v text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception '% must be a string', p_context;
  end if;
  v := trim(p_value #>> '{}');
  if length(v) not between 1 and p_max or v !~ '^[A-Za-z0-9_.-]+$' then
    raise exception '% must be a bounded identifier of 1 to % characters matching [A-Za-z0-9_.-]', p_context, p_max;
  end if;
end $$;

create function course_engineering_private.assert_local_ref(p_value jsonb, p_context text) returns void
language plpgsql immutable set search_path='' as $$
begin
  perform course_engineering_private.assert_bounded_identifier(p_value, 80, p_context);
end $$;

create function course_engineering_private.assert_bounded_text(
  p_value jsonb, p_min integer, p_max integer, p_context text
) returns void
language plpgsql immutable set search_path='' as $$
declare v text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception '% must be a string', p_context;
  end if;
  v := trim(p_value #>> '{}');
  if length(v) not between p_min and p_max then
    raise exception '% must be between % and % characters', p_context, p_min, p_max;
  end if;
end $$;

-- Same bounds as assert_bounded_text, but a JSON null is accepted in place
-- of a string (the TypeScript field is `.nullable()`). A JSON null is
-- distinct from the field being entirely absent: jsonb_typeof of a missing
-- key is SQL NULL, not the text 'null', and IS DISTINCT FROM treats SQL
-- NULL as distinct from everything including itself's absence, so an
-- omitted key still falls through to assert_bounded_text and is correctly
-- rejected as "must be a string" rather than silently accepted.
create function course_engineering_private.assert_bounded_text_or_null(
  p_value jsonb, p_min integer, p_max integer, p_context text
) returns void
language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'null' then
    perform course_engineering_private.assert_bounded_text(p_value, p_min, p_max, p_context);
  end if;
end $$;

-- Rejects any key in p_object outside p_allowed, matching z.strictObject's
-- "no unrecognised key" semantics. Required-key presence is enforced by the
-- specific field checks at each call site, not here; this only closes the
-- other half of strictObject (no silently-accepted extra field).
create function course_engineering_private.assert_exact_keys(
  p_object jsonb, p_allowed text[], p_context text
) returns void
language plpgsql immutable set search_path='' as $$
declare k text;
begin
  for k in select jsonb_object_keys(p_object) loop
    if not (k = any(p_allowed)) then
      raise exception 'Unexpected field "%" in %', k, p_context;
    end if;
  end loop;
end $$;

-- Full COURSE_PACKAGE_V1 validator: independently re-verifies the ENTIRE
-- stored package contract, not just the curriculum subset
-- assert_materializable writes to institutional tables. This is what makes
-- the database's own VALIDATED state truthful: a caller-supplied
-- validation_report is recorded for information only (see
-- mark_course_package_validated below) and can never substitute for this
-- independent check, including when an authenticated ACADEMIC_ADMIN calls
-- the RPC directly and skips the TypeScript validator entirely.
--
-- Deliberately re-verifies package/programme/curriculum identity and the
-- same curriculum structure assert_materializable checks (modules/lessons/
-- objectives/resources), because this function's job is the complete
-- contract rather than only what gets materialised; the two are not
-- reconciled into one function because they run at different times for
-- different purposes (validate-the-whole-package vs a defense-in-depth
-- recheck immediately before an institutional write). Additionally checks
-- practical activities, assignment templates (including rubric criteria),
-- assessment templates/questions (including markingGuidance), scheduling
-- defaults (including the timezone against PostgreSQL's own tzdata), the
-- top-level reason/packageRevision bounds, all five agent-role
-- configurations (including modelProfileRef/instructionalNotes, not only
-- enabled/escalationPolicy/capabilities) against the shared allowlist
-- above, and z.strictObject's no-extra-field rule at every nested object in
-- the contract. This function and src/domain/course-package.ts's
-- coursePackageSchema are required to stay in semantic parity; a field
-- added to one without the other is itself a defect.
create function course_engineering_private.assert_full_package_valid(
  p_package_key text,
  p_package_revision integer,
  p_schema_version text,
  p_package jsonb
) returns void
language plpgsql set search_path='' as $$
declare
  module_item jsonb;
  lesson_item jsonb;
  objective_item jsonb;
  resource_item jsonb;
  activity_item jsonb;
  template_item jsonb;
  question_item jsonb;
  rubric_item jsonb;
  ref_element jsonb;
  ref_text text;
  day_element jsonb;
  day_value integer;
  day_values integer[];
  module_keys text[] := array[]::text[];
  module_positions integer[] := array[]::integer[];
  lesson_keys text[] := array[]::text[];
  lesson_objective_map jsonb := '{}'::jsonb;
  module_position integer;
  lesson_position integer;
  objective_position integer;
  resource_position integer;
  activity_position integer;
  question_position integer;
  lesson_positions integer[];
  objective_positions integer[];
  resource_keys text[];
  resource_positions integer[];
  activity_keys text[];
  activity_positions integer[];
  objective_keys text[];
  objective_refs_for_lesson jsonb;
  assignment_keys text[] := array[]::text[];
  assessment_keys text[] := array[]::text[];
  role_names text[] := array['PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR'];
  role_item text;
  role_config jsonb;
  allowed text[];
  capability_item text;
  study_days jsonb;
begin
  ------------------------------------------------------------------
  -- IDENTITY: schema version, top-level shape, programme/curriculum
  -- metadata, the top-level reason, and the declared outer identity bound
  -- to the stored raw JSON a second time (defense in depth;
  -- import_course_package already bound this once and the row is
  -- immutable thereafter).
  ------------------------------------------------------------------
  if jsonb_typeof(p_package) is distinct from 'object' then
    raise exception 'Package content must be a JSON object';
  end if;
  perform course_engineering_private.assert_exact_keys(p_package, array[
    'schemaVersion','packageKey','packageRevision','programme','curriculumVersion',
    'modules','assignmentTemplates','assessmentTemplates','schedulingDefaults',
    'agentConfiguration','reason'
  ], 'the package');
  if p_package->>'schemaVersion' is distinct from 'COURSE_PACKAGE_V1'
    or p_package->>'schemaVersion' is distinct from p_schema_version then
    raise exception 'Package schema version is unsupported or does not match declared identity';
  end if;
  -- The ->> text operator stringifies ANY JSON scalar, so a raw packageKey
  -- of JSON number 123 would otherwise read as the text '123' and could
  -- coincidentally match a caller-supplied p_package_key of '123', even
  -- though coursePackageSchema requires packageKey to be a JSON string and
  -- would reject this raw package outright. Proving the JSON type first
  -- closes that gap independently of whatever import_course_package already
  -- bound at import time.
  if jsonb_typeof(p_package->'packageKey') is distinct from 'string'
    or p_package->>'packageKey' is distinct from p_package_key then
    raise exception 'Package key does not match declared identity';
  end if;
  if jsonb_typeof(p_package->'packageRevision') is distinct from 'number' then
    raise exception 'Package revision must be a number';
  end if;
  if (p_package->>'packageRevision')::integer is distinct from p_package_revision then
    raise exception 'Package revision does not match declared identity';
  end if;
  if p_package_revision > 100000 then
    raise exception 'Package revision exceeds the maximum of 100000';
  end if;
  if jsonb_typeof(p_package->'programme') is distinct from 'object' then
    raise exception 'Package programme metadata must be an object';
  end if;
  perform course_engineering_private.assert_exact_keys(p_package->'programme',
    array['title','examinationBody','qualificationName'], 'the package programme metadata');
  perform course_engineering_private.assert_bounded_text(p_package->'programme'->'title', 1, 200, 'Package programme title');
  perform course_engineering_private.assert_bounded_text(p_package->'programme'->'examinationBody', 1, 200, 'Package programme examinationBody');
  perform course_engineering_private.assert_bounded_text(p_package->'programme'->'qualificationName', 1, 200, 'Package programme qualificationName');
  if jsonb_typeof(p_package->'curriculumVersion') is distinct from 'object' then
    raise exception 'Package curriculum version metadata must be an object';
  end if;
  perform course_engineering_private.assert_exact_keys(p_package->'curriculumVersion',
    array['label'], 'the package curriculum version metadata');
  perform course_engineering_private.assert_bounded_text(p_package->'curriculumVersion'->'label', 1, 200, 'Package curriculum version label');
  perform course_engineering_private.assert_bounded_text(p_package->'reason', 5, 300, 'Package reason');

  ------------------------------------------------------------------
  -- CURRICULUM: modules / lessons / objectives / resources / practicals.
  -- Also builds lesson_objective_map, used below to validate every
  -- assignment/assessment/practical-activity objective reference.
  ------------------------------------------------------------------
  if jsonb_typeof(p_package->'modules') is distinct from 'array'
    or jsonb_array_length(p_package->'modules') < 1
    or jsonb_array_length(p_package->'modules') > 250 then
    raise exception 'Package must declare between one and 250 modules';
  end if;

  for module_item in select jsonb_array_elements(p_package->'modules') loop
    if jsonb_typeof(module_item) is distinct from 'object' then
      raise exception 'A module must be an object';
    end if;
    perform course_engineering_private.assert_exact_keys(module_item,
      array['key','title','position','lessons'], 'a module');
    perform course_engineering_private.assert_local_ref(module_item->'key', 'a module key');
    perform course_engineering_private.assert_bounded_text(module_item->'title', 1, 200, 'A module title');
    if jsonb_typeof(module_item->'position') is distinct from 'number' then
      raise exception 'A module position is required';
    end if;
    if module_item->>'key' = any(module_keys) then
      raise exception 'Duplicate module key in package';
    end if;
    module_keys := module_keys || (module_item->>'key');
    module_position := (module_item->>'position')::integer;
    if module_position <= 0 or module_position > 10000 or module_position = any(module_positions) then
      raise exception 'A module position is invalid or duplicated';
    end if;
    module_positions := module_positions || module_position;

    if jsonb_typeof(module_item->'lessons') is distinct from 'array'
      or jsonb_array_length(module_item->'lessons') < 1
      or jsonb_array_length(module_item->'lessons') > 250 then
      raise exception 'Every module must declare between one and 250 lessons';
    end if;

    lesson_positions := array[]::integer[];
    for lesson_item in select jsonb_array_elements(module_item->'lessons') loop
      if jsonb_typeof(lesson_item) is distinct from 'object' then
        raise exception 'A lesson must be an object';
      end if;
      perform course_engineering_private.assert_exact_keys(lesson_item,
        array['key','title','position','objectives','resources','practicalActivities'], 'a lesson');
      perform course_engineering_private.assert_local_ref(lesson_item->'key', 'a lesson key');
      perform course_engineering_private.assert_bounded_text(lesson_item->'title', 1, 200, 'A lesson title');
      if jsonb_typeof(lesson_item->'position') is distinct from 'number' then
        raise exception 'A lesson position is required';
      end if;
      if lesson_item->>'key' = any(lesson_keys) then
        raise exception 'Duplicate lesson key in package';
      end if;
      lesson_keys := lesson_keys || (lesson_item->>'key');
      lesson_position := (lesson_item->>'position')::integer;
      if lesson_position <= 0 or lesson_position > 10000 or lesson_position = any(lesson_positions) then
        raise exception 'A lesson position is invalid or duplicated within its module';
      end if;
      lesson_positions := lesson_positions || lesson_position;

      if jsonb_typeof(lesson_item->'objectives') is distinct from 'array'
        or jsonb_array_length(lesson_item->'objectives') < 1
        or jsonb_array_length(lesson_item->'objectives') > 250 then
        raise exception 'Every lesson must declare between one and 250 objectives';
      end if;

      objective_keys := array[]::text[];
      objective_positions := array[]::integer[];
      for objective_item in select jsonb_array_elements(lesson_item->'objectives') loop
        if jsonb_typeof(objective_item) is distinct from 'object' then
          raise exception 'An objective must be an object';
        end if;
        perform course_engineering_private.assert_exact_keys(objective_item,
          array['key','description','position'], 'an objective');
        perform course_engineering_private.assert_local_ref(objective_item->'key', 'an objective key');
        perform course_engineering_private.assert_bounded_text(objective_item->'description', 1, 4000, 'An objective description');
        if jsonb_typeof(objective_item->'position') is distinct from 'number' then
          raise exception 'An objective position is required';
        end if;
        if objective_item->>'key' = any(objective_keys) then
          raise exception 'Duplicate objective key within a lesson';
        end if;
        objective_keys := objective_keys || (objective_item->>'key');
        objective_position := (objective_item->>'position')::integer;
        if objective_position <= 0 or objective_position > 10000 or objective_position = any(objective_positions) then
          raise exception 'An objective position is invalid or duplicated within its lesson';
        end if;
        objective_positions := objective_positions || objective_position;
      end loop;
      lesson_objective_map := lesson_objective_map || jsonb_build_object(lesson_item->>'key', to_jsonb(objective_keys));

      if jsonb_typeof(lesson_item->'resources') is distinct from 'array'
        or jsonb_array_length(lesson_item->'resources') > 250 then
        raise exception 'A lesson resources field must be an array of at most 250 items';
      end if;
      resource_keys := array[]::text[];
      resource_positions := array[]::integer[];
      for resource_item in select jsonb_array_elements(lesson_item->'resources') loop
        if jsonb_typeof(resource_item) is distinct from 'object' then
          raise exception 'A learning resource must be an object';
        end if;
        perform course_engineering_private.assert_exact_keys(resource_item,
          array['key','kind','title','body','url','position'], 'a learning resource');
        perform course_engineering_private.assert_local_ref(resource_item->'key', 'a resource key');
        perform course_engineering_private.assert_bounded_text(resource_item->'title', 1, 200, 'A learning resource title');
        perform course_engineering_private.assert_bounded_text_or_null(resource_item->'body', 1, 12000, 'A learning resource body');
        perform course_engineering_private.assert_bounded_text_or_null(resource_item->'url', 1, 2048, 'A learning resource url');
        if coalesce(resource_item->>'kind', '') not in ('LECTURE_NOTE','REFERENCE_LINK')
          or jsonb_typeof(resource_item->'position') is distinct from 'number' then
          raise exception 'A learning resource is missing required fields';
        end if;
        if resource_item->>'key' = any(resource_keys) then
          raise exception 'Duplicate resource key within a lesson';
        end if;
        resource_keys := resource_keys || (resource_item->>'key');
        resource_position := (resource_item->>'position')::integer;
        if resource_position <= 0 or resource_position > 10000 or resource_position = any(resource_positions) then
          raise exception 'A learning resource position is invalid or duplicated within its lesson';
        end if;
        resource_positions := resource_positions || resource_position;
        if resource_item->>'kind' = 'LECTURE_NOTE' then
          if jsonb_typeof(resource_item->'body') is distinct from 'string'
            or jsonb_typeof(resource_item->'url') is distinct from 'null' then
            raise exception 'A lecture-note resource requires body text and no URL';
          end if;
        else
          if jsonb_typeof(resource_item->'url') is distinct from 'string'
            or resource_item->>'url' !~ '^https://\S+$'
            or jsonb_typeof(resource_item->'body') is distinct from 'null' then
            raise exception 'A reference-link resource requires an HTTPS URL and no body text';
          end if;
        end if;
      end loop;

      if jsonb_typeof(lesson_item->'practicalActivities') is distinct from 'array'
        or jsonb_array_length(lesson_item->'practicalActivities') > 250 then
        raise exception 'A lesson practicalActivities field must be an array of at most 250 items';
      end if;
      activity_keys := array[]::text[];
      activity_positions := array[]::integer[];
      for activity_item in select jsonb_array_elements(lesson_item->'practicalActivities') loop
        if jsonb_typeof(activity_item) is distinct from 'object' then
          raise exception 'A practical activity must be an object';
        end if;
        perform course_engineering_private.assert_exact_keys(activity_item,
          array['key','kind','title','instructions','position','objectiveRefs'], 'a practical activity');
        perform course_engineering_private.assert_local_ref(activity_item->'key', 'a practical-activity key');
        perform course_engineering_private.assert_bounded_text(activity_item->'title', 1, 200, 'A practical-activity title');
        perform course_engineering_private.assert_bounded_text(activity_item->'instructions', 1, 12000, 'A practical-activity instructions');
        if coalesce(activity_item->>'kind', '') not in ('EXERCISE','PRACTICAL_LAB')
          or jsonb_typeof(activity_item->'position') is distinct from 'number' then
          raise exception 'A practical activity is missing required fields';
        end if;
        if activity_item->>'key' = any(activity_keys) then
          raise exception 'Duplicate practical-activity key within a lesson';
        end if;
        activity_keys := activity_keys || (activity_item->>'key');
        activity_position := (activity_item->>'position')::integer;
        if activity_position <= 0 or activity_position > 10000 or activity_position = any(activity_positions) then
          raise exception 'A practical-activity position is invalid or duplicated within its lesson';
        end if;
        activity_positions := activity_positions || activity_position;
        if jsonb_typeof(activity_item->'objectiveRefs') is distinct from 'array'
          or jsonb_array_length(activity_item->'objectiveRefs') < 1
          or jsonb_array_length(activity_item->'objectiveRefs') > 50 then
          raise exception 'A practical activity must reference between one and 50 objectives';
        end if;
        for ref_element in select jsonb_array_elements(activity_item->'objectiveRefs') loop
          perform course_engineering_private.assert_local_ref(ref_element, 'a practical-activity objective reference');
        end loop;
        if jsonb_array_length(activity_item->'objectiveRefs') <> (
          select count(distinct value) from jsonb_array_elements_text(activity_item->'objectiveRefs') value
        ) then
          raise exception 'Duplicate objective reference in practical-activity objectiveRefs';
        end if;
        for ref_text in select jsonb_array_elements_text(activity_item->'objectiveRefs') loop
          if not (ref_text = any(objective_keys)) then
            raise exception 'Practical activity references an objective outside its lesson';
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  ------------------------------------------------------------------
  -- ASSIGNMENT TEMPLATES: staged content only (never materialised by this
  -- checkpoint), but still part of the stored package's own truth.
  ------------------------------------------------------------------
  if jsonb_typeof(p_package->'assignmentTemplates') is distinct from 'array'
    or jsonb_array_length(p_package->'assignmentTemplates') > 250 then
    raise exception 'assignmentTemplates must be an array of at most 250 items';
  end if;
  for template_item in select jsonb_array_elements(p_package->'assignmentTemplates') loop
    if jsonb_typeof(template_item) is distinct from 'object' then
      raise exception 'An assignment template must be an object';
    end if;
    perform course_engineering_private.assert_exact_keys(template_item,
      array['key','title','instructions','lessonRef','objectiveRefs','rubric'], 'an assignment template');
    perform course_engineering_private.assert_local_ref(template_item->'key', 'an assignment template key');
    perform course_engineering_private.assert_bounded_text(template_item->'title', 1, 200, 'An assignment template title');
    perform course_engineering_private.assert_bounded_text(template_item->'instructions', 1, 12000, 'An assignment template instructions');
    perform course_engineering_private.assert_local_ref(template_item->'lessonRef', 'an assignment template lessonRef');
    if template_item->>'key' = any(assignment_keys) then
      raise exception 'Duplicate assignment template key';
    end if;
    assignment_keys := assignment_keys || (template_item->>'key');
    if not (template_item->>'lessonRef' = any(lesson_keys)) then
      raise exception 'Assignment template references an unknown lesson';
    end if;
    objective_refs_for_lesson := lesson_objective_map->(template_item->>'lessonRef');
    if jsonb_typeof(template_item->'objectiveRefs') is distinct from 'array'
      or jsonb_array_length(template_item->'objectiveRefs') < 1
      or jsonb_array_length(template_item->'objectiveRefs') > 50 then
      raise exception 'An assignment template must reference between one and 50 objectives';
    end if;
    for ref_element in select jsonb_array_elements(template_item->'objectiveRefs') loop
      perform course_engineering_private.assert_local_ref(ref_element, 'an assignment-template objective reference');
    end loop;
    if jsonb_array_length(template_item->'objectiveRefs') <> (
      select count(distinct value) from jsonb_array_elements_text(template_item->'objectiveRefs') value
    ) then
      raise exception 'Duplicate objective reference in assignment objectiveRefs';
    end if;
    for ref_text in select jsonb_array_elements_text(template_item->'objectiveRefs') loop
      if not (objective_refs_for_lesson ? ref_text) then
        raise exception 'Assignment template references an objective outside its lesson';
      end if;
    end loop;
    if jsonb_typeof(template_item->'rubric') is distinct from 'array'
      or jsonb_array_length(template_item->'rubric') < 1
      or jsonb_array_length(template_item->'rubric') > 50 then
      raise exception 'An assignment template requires between one and 50 rubric criteria';
    end if;
    for rubric_item in select jsonb_array_elements(template_item->'rubric') loop
      if jsonb_typeof(rubric_item) is distinct from 'object' then
        raise exception 'A rubric criterion must be an object';
      end if;
      perform course_engineering_private.assert_exact_keys(rubric_item,
        array['description','maxMarks'], 'a rubric criterion');
      perform course_engineering_private.assert_bounded_text(rubric_item->'description', 1, 500, 'A rubric criterion description');
      if jsonb_typeof(rubric_item->'maxMarks') is distinct from 'number' then
        raise exception 'A rubric criterion maxMarks is required';
      end if;
      if (rubric_item->>'maxMarks')::integer not between 1 and 100 then
        raise exception 'A rubric criterion maxMarks must be an integer between 1 and 100';
      end if;
    end loop;
  end loop;

  ------------------------------------------------------------------
  -- ASSESSMENT TEMPLATES / QUESTIONS: staged content only, with the same
  -- controlled-answer structure the package schema requires.
  ------------------------------------------------------------------
  if jsonb_typeof(p_package->'assessmentTemplates') is distinct from 'array'
    or jsonb_array_length(p_package->'assessmentTemplates') > 100 then
    raise exception 'assessmentTemplates must be an array of at most 100 items';
  end if;
  for template_item in select jsonb_array_elements(p_package->'assessmentTemplates') loop
    if jsonb_typeof(template_item) is distinct from 'object' then
      raise exception 'An assessment template must be an object';
    end if;
    perform course_engineering_private.assert_exact_keys(template_item,
      array['key','title','instructions','lessonRef','durationMinutes','attemptsAllowed','questions'],
      'an assessment template');
    perform course_engineering_private.assert_local_ref(template_item->'key', 'an assessment template key');
    perform course_engineering_private.assert_bounded_text(template_item->'title', 1, 200, 'An assessment template title');
    perform course_engineering_private.assert_bounded_text(template_item->'instructions', 1, 12000, 'An assessment template instructions');
    perform course_engineering_private.assert_local_ref(template_item->'lessonRef', 'an assessment template lessonRef');
    if jsonb_typeof(template_item->'durationMinutes') is distinct from 'number'
      or jsonb_typeof(template_item->'attemptsAllowed') is distinct from 'number' then
      raise exception 'An assessment template is missing required fields';
    end if;
    if (template_item->>'durationMinutes')::integer not between 1 and 360 then
      raise exception 'An assessment template duration must be between 1 and 360 minutes';
    end if;
    if (template_item->>'attemptsAllowed')::integer not between 1 and 5 then
      raise exception 'An assessment template attempts-allowed must be between 1 and 5';
    end if;
    if template_item->>'key' = any(assessment_keys) then
      raise exception 'Duplicate assessment template key';
    end if;
    assessment_keys := assessment_keys || (template_item->>'key');
    if not (template_item->>'lessonRef' = any(lesson_keys)) then
      raise exception 'Assessment template references an unknown lesson';
    end if;
    objective_refs_for_lesson := lesson_objective_map->(template_item->>'lessonRef');

    if jsonb_typeof(template_item->'questions') is distinct from 'array'
      or jsonb_array_length(template_item->'questions') < 1
      or jsonb_array_length(template_item->'questions') > 100 then
      raise exception 'An assessment template requires between one and 100 questions';
    end if;
    objective_positions := array[]::integer[];
    for question_item in select jsonb_array_elements(template_item->'questions') loop
      if jsonb_typeof(question_item) is distinct from 'object' then
        raise exception 'An assessment question must be an object';
      end if;
      perform course_engineering_private.assert_exact_keys(question_item,
        array['position','prompt','maxMarks','expectedAnswer','markingGuidance','objectiveRefs'],
        'an assessment question');
      perform course_engineering_private.assert_bounded_text(question_item->'prompt', 1, 12000, 'An assessment question prompt');
      perform course_engineering_private.assert_bounded_text(question_item->'expectedAnswer', 1, 12000, 'An assessment question expectedAnswer');
      perform course_engineering_private.assert_bounded_text_or_null(question_item->'markingGuidance', 1, 12000, 'An assessment question markingGuidance');
      if jsonb_typeof(question_item->'position') is distinct from 'number'
        or jsonb_typeof(question_item->'maxMarks') is distinct from 'number' then
        raise exception 'An assessment question is missing required fields';
      end if;
      if (question_item->>'maxMarks')::integer not between 1 and 100 then
        raise exception 'An assessment question maxMarks must be between 1 and 100';
      end if;
      question_position := (question_item->>'position')::integer;
      if question_position <= 0 or question_position > 10000 or question_position = any(objective_positions) then
        raise exception 'An assessment question position is invalid or duplicated';
      end if;
      objective_positions := objective_positions || question_position;
      if jsonb_typeof(question_item->'objectiveRefs') is distinct from 'array'
        or jsonb_array_length(question_item->'objectiveRefs') < 1
        or jsonb_array_length(question_item->'objectiveRefs') > 50 then
        raise exception 'An assessment question must reference between one and 50 objectives';
      end if;
      for ref_element in select jsonb_array_elements(question_item->'objectiveRefs') loop
        perform course_engineering_private.assert_local_ref(ref_element, 'an assessment-question objective reference');
      end loop;
      if jsonb_array_length(question_item->'objectiveRefs') <> (
        select count(distinct value) from jsonb_array_elements_text(question_item->'objectiveRefs') value
      ) then
        raise exception 'Duplicate objective reference in assessment-question objectiveRefs';
      end if;
      for ref_text in select jsonb_array_elements_text(question_item->'objectiveRefs') loop
        if not (objective_refs_for_lesson ? ref_text) then
          raise exception 'Assessment question references an objective outside its lesson';
        end if;
      end loop;
    end loop;
  end loop;

  ------------------------------------------------------------------
  -- SCHEDULING DEFAULTS: descriptive package metadata, but still checked
  -- for real shape and a timezone PostgreSQL's own tzdata recognises.
  ------------------------------------------------------------------
  if jsonb_typeof(p_package->'schedulingDefaults') is distinct from 'object' then
    raise exception 'schedulingDefaults must be an object';
  end if;
  perform course_engineering_private.assert_exact_keys(p_package->'schedulingDefaults',
    array['studyDays','localStartTime','timezone'], 'schedulingDefaults');
  study_days := p_package->'schedulingDefaults'->'studyDays';
  if jsonb_typeof(study_days) is distinct from 'array'
    or jsonb_array_length(study_days) < 1
    or jsonb_array_length(study_days) > 7 then
    raise exception 'schedulingDefaults.studyDays must be an array of one to seven days';
  end if;
  day_values := array[]::integer[];
  -- jsonb_array_elements (typed), not jsonb_array_elements_text: the latter
  -- stringifies every element regardless of its real JSON type, so a
  -- studyDays array of JSON strings like ["1","3","5"] would otherwise cast
  -- straight through to integers and be silently accepted even though
  -- coursePackageSchema's z.number().int() requires each element to already
  -- be a JSON number, not a numeric-looking string.
  for day_element in select jsonb_array_elements(study_days) loop
    if jsonb_typeof(day_element) is distinct from 'number' then
      raise exception 'schedulingDefaults.studyDays elements must be numbers';
    end if;
    day_value := (day_element #>> '{}')::integer;
    if day_value not between 1 and 7 or day_value = any(day_values) then
      raise exception 'schedulingDefaults.studyDays contains an invalid or duplicate day';
    end if;
    day_values := day_values || day_value;
  end loop;
  if jsonb_typeof(p_package->'schedulingDefaults'->'localStartTime') is distinct from 'string'
    or p_package->'schedulingDefaults'->>'localStartTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'schedulingDefaults.localStartTime must be a valid HH:mm time';
  end if;
  if jsonb_typeof(p_package->'schedulingDefaults'->'timezone') is distinct from 'string'
    or coalesce(length(trim(p_package->'schedulingDefaults'->>'timezone')), 0) not between 1 and 100 then
    raise exception 'schedulingDefaults.timezone must be bounded text';
  end if;
  if not exists(
    select 1 from pg_catalog.pg_timezone_names where name = p_package->'schedulingDefaults'->>'timezone'
  ) then
    raise exception 'schedulingDefaults.timezone is not a recognised IANA timezone';
  end if;

  ------------------------------------------------------------------
  -- AGENT CONFIGURATION: exactly the five reviewed roles, each checked
  -- against the SQL-side reviewed capability allowlist above and against
  -- the full agentRoleConfigSchema shape (modelProfileRef/
  -- instructionalNotes included, not only enabled/escalationPolicy/
  -- capabilities). A package can never invent a capability outside that
  -- allowlist.
  ------------------------------------------------------------------
  if jsonb_typeof(p_package->'agentConfiguration') is distinct from 'object' then
    raise exception 'agentConfiguration must be an object';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_package->'agentConfiguration') k)
      is distinct from (select array_agg(r order by r) from unnest(role_names) r) then
    raise exception 'agentConfiguration must declare exactly the five reviewed roles';
  end if;
  foreach role_item in array role_names loop
    role_config := p_package->'agentConfiguration'->role_item;
    if jsonb_typeof(role_config) is distinct from 'object' then
      raise exception 'An agent configuration role entry is malformed';
    end if;
    perform course_engineering_private.assert_exact_keys(role_config,
      array['enabled','modelProfileRef','instructionalNotes','capabilities','escalationPolicy'],
      'an agent configuration role entry');
    if jsonb_typeof(role_config->'enabled') is distinct from 'boolean'
      or coalesce(role_config->>'escalationPolicy', '') not in ('NONE','ACADEMIC_REVIEW') then
      raise exception 'An agent configuration role entry is malformed';
    end if;
    if jsonb_typeof(role_config->'modelProfileRef') is distinct from 'null' then
      perform course_engineering_private.assert_bounded_identifier(
        role_config->'modelProfileRef', 100, 'An agent configuration modelProfileRef');
    end if;
    perform course_engineering_private.assert_bounded_text_or_null(
      role_config->'instructionalNotes', 0, 4000, 'An agent configuration instructionalNotes');
    if jsonb_typeof(role_config->'capabilities') is distinct from 'array'
      or jsonb_array_length(role_config->'capabilities') > 50 then
      raise exception 'An agent configuration role entry capabilities must be an array of at most 50 items';
    end if;
    allowed := course_engineering_private.role_capability_allowlist(role_item);
    for ref_element in select jsonb_array_elements(role_config->'capabilities') loop
      perform course_engineering_private.assert_bounded_text(ref_element, 1, 80, 'An agent configuration capability name');
    end loop;
    if jsonb_array_length(role_config->'capabilities') <> (
      select count(distinct value) from jsonb_array_elements_text(role_config->'capabilities') value
    ) then
      raise exception 'Duplicate capability in agent configuration';
    end if;
    for capability_item in select jsonb_array_elements_text(role_config->'capabilities') loop
      if not (capability_item = any(allowed)) then
        raise exception 'Agent configuration capability is outside the reviewed allowlist for its role';
      end if;
    end loop;
  end loop;
end $$;

create function public.import_course_package(
  p_package_key text,
  p_package_revision integer,
  p_schema_version text,
  p_raw_package jsonb,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  existing public.course_package_imports%rowtype;
  result_id uuid;
  computed_hash text;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  if p_package_key is null or p_package_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or length(p_package_key) not between 3 and 80 then
    raise exception 'A valid package key is required';
  end if;
  if p_package_revision is null or p_package_revision < 1 then
    raise exception 'A positive package revision is required';
  end if;
  if p_schema_version is distinct from 'COURSE_PACKAGE_V1' then
    raise exception 'Unsupported course package schema version';
  end if;
  if p_raw_package is null or jsonb_typeof(p_raw_package) is distinct from 'object' then
    raise exception 'Package content must be a JSON object';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded import reason is required';
  end if;

  -- Identity is independently bound to the raw package's own declared
  -- fields. The separate key/revision/schema-version parameters (kept for
  -- efficient lookups and the unique constraint) can never diverge from the
  -- content they claim to describe.
  -- Proven as a JSON string first: ->> stringifies any JSON scalar, so a
  -- raw packageKey of JSON number 123 would otherwise read as the text
  -- '123' and could coincidentally match a caller-supplied p_package_key of
  -- '123', even though coursePackageSchema requires packageKey to be a JSON
  -- string and would reject this raw package outright. Rejecting it here,
  -- at import time, is preferable to waiting for VALIDATED's own recheck
  -- (assert_full_package_valid repeats this same check independently, as
  -- defense in depth, rather than trusting this one never to regress).
  if jsonb_typeof(p_raw_package->'packageKey') is distinct from 'string'
    or p_raw_package->>'packageKey' is distinct from p_package_key then
    raise exception 'Declared package key does not match package content';
  end if;
  if (p_raw_package->>'packageRevision')::integer is distinct from p_package_revision then
    raise exception 'Declared package revision does not match package content';
  end if;
  if p_raw_package->>'schemaVersion' is distinct from p_schema_version then
    raise exception 'Declared schema version does not match package content';
  end if;

  -- Content-integrity hash is always database-derived from the exact stored
  -- jsonb value, never a caller-supplied assertion. Two imports with
  -- semantically identical content always hash identically regardless of
  -- upload key ordering, because jsonb normalises key order internally.
  computed_hash := encode(extensions.digest(p_raw_package::text, 'sha256'), 'hex');

  select * into existing
  from public.course_package_imports
  where package_key = p_package_key and package_revision = p_package_revision
  for update;

  if found then
    if existing.content_hash = computed_hash then
      return existing.id;
    end if;
    raise exception 'A different package already exists for this key and revision' using errcode='23505';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.course_package_imports(
    package_key, package_revision, schema_version, content_hash, raw_package, status, created_by
  ) values (
    p_package_key, p_package_revision, p_schema_version, computed_hash, p_raw_package, 'IMPORTED', actor
  ) returning id into result_id;

  return result_id;
end $$;

create function public.mark_course_package_validated(
  p_import_id uuid,
  p_validation_report jsonb,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_validation_report is null then
    raise exception 'A validation report is required';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded validation reason is required';
  end if;

  select * into import_record from public.course_package_imports where id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status in ('VALIDATED','APPLIED','PUBLISHED') then
    return import_record.id;
  end if;
  if import_record.status <> 'IMPORTED' then
    raise exception 'Only an imported package can be validated';
  end if;

  -- The database independently re-verifies the ENTIRE stored
  -- COURSE_PACKAGE_V1 contract regardless of what the caller-supplied
  -- report claims; see assert_full_package_valid's comment for the exact
  -- trust boundary this state is meant to truthfully guarantee. The report
  -- itself is stored informationally only and can never substitute for
  -- this check.
  perform course_engineering_private.assert_full_package_valid(
    import_record.package_key, import_record.package_revision,
    import_record.schema_version, import_record.raw_package
  );

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.course_package_imports
  set status = 'VALIDATED', validation_report = p_validation_report, validated_at = clock_timestamp()
  where id = p_import_id;

  return p_import_id;
end $$;

create function public.reject_course_package(p_import_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded rejection reason is required';
  end if;

  select * into import_record from public.course_package_imports where id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status = 'REJECTED' then return import_record.id; end if;
  if import_record.status in ('APPLIED','PUBLISHED') then
    raise exception 'An applied or published course package cannot be rejected';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  update public.course_package_imports
  set status = 'REJECTED', rejected_at = clock_timestamp(), rejected_by = actor, rejected_reason = trim(p_reason)
  where id = p_import_id;

  return import_record.id;
end $$;

-- Atomic, idempotent materialisation into the existing Academy OS authority.
-- A new package revision always creates a fresh DRAFT ProgrammeVersion; an
-- already-applied or -published import returns its existing version instead
-- of reapplying, and any failure rolls back the whole tree (single statement
-- = single transaction), so a package can never partially publish.
--
-- programmes.title/examination_body/qualification_name are intentionally
-- the CURRENT description for the whole programme, not a per-version
-- record: migration 006's publish_programme_version snapshots them into
-- title_snapshot/examination_body_snapshot/qualification_name_snapshot at
-- the moment a version is published, and the freeze_content/guard_
-- curriculum_version triggers make that snapshot immutable afterward (see
-- tests/programme-publication.test.ts, "keeps published curriculum content
-- immutable"). Applying a later package revision under the same
-- package_key therefore updates the live description row, but can never
-- rewrite an already-published version's frozen historical snapshot; see
-- tests/course-engineering-workflow.test.ts for an explicit proof.
create function public.apply_course_package(p_import_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
  programme_record public.programmes%rowtype;
  new_version_id uuid;
  module_item jsonb;
  lesson_item jsonb;
  objective_item jsonb;
  resource_item jsonb;
  new_module_id uuid;
  new_lesson_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded apply reason is required';
  end if;

  select * into import_record from public.course_package_imports where id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status in ('APPLIED','PUBLISHED') then
    return import_record.programme_version_id;
  end if;
  if import_record.status <> 'VALIDATED' then
    raise exception 'A course package must be validated before it can be applied';
  end if;

  -- Defense in depth: re-verify independently of the stored VALIDATED
  -- status. A forged or tampered validation state can never reach
  -- institutional materialisation on its own.
  perform course_engineering_private.assert_materializable(import_record.raw_package);

  select * into programme_record from public.programmes where slug = import_record.package_key for update;
  if not found then
    insert into public.programmes(slug, title, examination_body, qualification_name, is_demo)
    values (
      import_record.package_key,
      import_record.raw_package->'programme'->>'title',
      import_record.raw_package->'programme'->>'examinationBody',
      import_record.raw_package->'programme'->>'qualificationName',
      false
    ) returning * into programme_record;
  else
    update public.programmes
    set title = import_record.raw_package->'programme'->>'title',
        examination_body = import_record.raw_package->'programme'->>'examinationBody',
        qualification_name = import_record.raw_package->'programme'->>'qualificationName'
    where id = programme_record.id
    returning * into programme_record;
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);

  begin
    insert into public.programme_versions(programme_id, label, status, is_demo)
    values (
      programme_record.id,
      import_record.raw_package->'curriculumVersion'->>'label',
      'DRAFT', false
    ) returning id into new_version_id;
  exception when unique_violation then
    raise exception 'A programme version with this curriculum label already exists for this programme';
  end;

  for module_item in select jsonb_array_elements(import_record.raw_package->'modules') loop
    insert into public.modules(programme_version_id, title, position)
    values (new_version_id, module_item->>'title', (module_item->>'position')::integer)
    returning id into new_module_id;

    for lesson_item in select jsonb_array_elements(module_item->'lessons') loop
      insert into public.lessons(module_id, programme_version_id, title, position)
      values (new_module_id, new_version_id, lesson_item->>'title', (lesson_item->>'position')::integer)
      returning id into new_lesson_id;

      for objective_item in select jsonb_array_elements(lesson_item->'objectives') loop
        insert into public.lesson_objectives(lesson_id, programme_version_id, description, position)
        values (new_lesson_id, new_version_id, objective_item->>'description', (objective_item->>'position')::integer);
      end loop;

      for resource_item in select jsonb_array_elements(lesson_item->'resources') loop
        insert into public.learning_resources(
          lesson_id, programme_version_id, kind, title, body, url, position, created_by
        ) values (
          new_lesson_id, new_version_id,
          resource_item->>'kind', resource_item->>'title',
          resource_item->>'body', resource_item->>'url',
          (resource_item->>'position')::integer, actor
        );
      end loop;
    end loop;
  end loop;

  update public.course_package_imports
  set status = 'APPLIED', programme_id = programme_record.id, programme_version_id = new_version_id,
      applied_at = clock_timestamp(), applied_by = actor
  where id = p_import_id;

  return new_version_id;
end $$;

-- Publication is a distinct, explicit step that reuses the existing
-- publish_programme_version authority (migration 006) rather than
-- duplicating its content-completeness checks, snapshot or audit.
create function public.publish_course_package(p_import_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
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

  select * into import_record from public.course_package_imports where id = p_import_id for update;
  if not found then raise exception 'Course package import not found'; end if;
  if import_record.status = 'PUBLISHED' then
    return import_record.programme_version_id;
  end if;
  if import_record.status <> 'APPLIED' or import_record.programme_version_id is null then
    raise exception 'A course package must be applied before it can be published';
  end if;

  perform public.publish_programme_version(import_record.programme_version_id, trim(p_reason));

  update public.course_package_imports
  set status = 'PUBLISHED', published_at = clock_timestamp(), published_by = actor
  where id = p_import_id;

  return import_record.programme_version_id;
end $$;

-- Full, unredacted content for the admin authoring/validation workflow only
-- (never the general preview surface below). The authoring ACADEMIC_ADMIN/
-- PLATFORM_ADMIN who staged this not-yet-published package may review
-- exactly what they uploaded, including its draft answer keys; a learner or
-- capability/context construction path never calls this function.
create function public.get_course_package_content(p_import_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  select raw_package into result
  from public.course_package_imports
  where id = p_import_id;
  if not found then raise exception 'Course package import not found'; end if;

  return result;
end $$;

create function public.get_course_package_preview(p_import_id uuid)
returns table(
  id uuid, package_key text, package_revision integer, schema_version text,
  status text, content_hash text, validation_report jsonb,
  programme_id uuid, programme_version_id uuid, preview jsonb
)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  select * into import_record
  from public.course_package_imports
  where public.course_package_imports.id = p_import_id;
  if not found then raise exception 'Course package import not found'; end if;

  return query select
    import_record.id, import_record.package_key, import_record.package_revision, import_record.schema_version,
    import_record.status, import_record.content_hash, import_record.validation_report,
    import_record.programme_id, import_record.programme_version_id,
    course_engineering_private.redact_answer_keys(import_record.raw_package);
end $$;

create function public.list_course_packages()
returns table(
  id uuid, package_key text, package_revision integer, schema_version text, status text,
  content_hash text, programme_id uuid, programme_version_id uuid,
  created_at timestamptz, applied_at timestamptz, published_at timestamptz, rejected_at timestamptz
)
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  return query
  select i.id, i.package_key, i.package_revision, i.schema_version, i.status, i.content_hash,
         i.programme_id, i.programme_version_id, i.created_at, i.applied_at, i.published_at, i.rejected_at
  from public.course_package_imports i
  order by i.created_at desc
  limit 200;
end $$;

-- Reusable per-role academic-agent configuration, shared by every course.
-- A stored row is a requested, reviewed-capability-scoped preference; it is
-- never itself an authorization grant. PROFESSOR capability names reuse the
-- existing PROFESSOR_READ_V2 catalogue (migration 019). TUTOR, LAB_INSTRUCTOR,
-- EXAMINER and COUNSELLOR have no independent server-enforced execution
-- capability today; their allowlists below are a reviewed placeholder
-- boundary, not a new execution path, and must stay byte-for-byte in step
-- with src/domain/academic-capability-policy.ts's roleCapabilityCatalogue
-- (the single source of truth the TypeScript layer uses).
--
-- Configuring a role here does NOT by itself give any course package's
-- apply_course_package() a materialised effect: this checkpoint does not
-- auto-populate academic_agent_configs from a package's agentConfiguration
-- field. set_agent_config remains a separate, explicit admin action; see
-- docs/implementation-progress.md for why that stage stays PARTIAL.
create table public.academic_agent_configs (
  id uuid primary key default gen_random_uuid(),
  programme_version_id uuid not null references public.programme_versions(id),
  role text not null check(role in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR')),
  policy_version text not null default 'ACADEMIC_AGENT_CONFIG_V1' check(policy_version = 'ACADEMIC_AGENT_CONFIG_V1'),
  enabled boolean not null default false,
  model_profile_ref text check(model_profile_ref is null or model_profile_ref ~ '^[A-Za-z0-9_.-]{1,100}$'),
  instructional_notes text check(instructional_notes is null or length(trim(instructional_notes)) between 1 and 4000),
  capabilities text[] not null default '{}',
  escalation_policy text not null default 'NONE' check(escalation_policy in ('NONE','ACADEMIC_REVIEW')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(programme_version_id, role)
);

alter table public.academic_agent_configs enable row level security;
revoke all on public.academic_agent_configs from public, anon, authenticated, service_role;

create function public.guard_agent_config_history() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Agent configuration rows cannot be deleted; disable the role instead';
  end if;
  if NEW.programme_version_id <> OLD.programme_version_id
    or NEW.role <> OLD.role
    or NEW.created_by <> OLD.created_by
    or NEW.created_at <> OLD.created_at then
    raise exception 'Agent configuration identity is immutable';
  end if;
  return NEW;
end $$;

create trigger guard_agent_config_history
before update or delete on public.academic_agent_configs
for each row execute function public.guard_agent_config_history();

create function public.audit_agent_config_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous jsonb;
  following jsonb;
  target uuid;
begin
  if TG_OP <> 'INSERT' then previous := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then following := to_jsonb(NEW); end if;
  previous := previous - 'instructional_notes';
  following := following - 'instructional_notes';
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

create trigger audit_change
after insert or update or delete on public.academic_agent_configs
for each row execute function public.audit_agent_config_change();

create function public.set_agent_config(
  p_programme_version_id uuid,
  p_role text,
  p_enabled boolean,
  p_model_profile_ref text,
  p_instructional_notes text,
  p_capabilities text[],
  p_escalation_policy text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  allowed text[];
  normalized text[];
  result_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_role not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR') then
    raise exception 'Unsupported agent role';
  end if;
  if p_escalation_policy not in ('NONE','ACADEMIC_REVIEW') then
    raise exception 'Unsupported escalation policy';
  end if;
  if p_model_profile_ref is not null and p_model_profile_ref !~ '^[A-Za-z0-9_.-]{1,100}$' then
    raise exception 'Model profile reference must be bounded identifier text';
  end if;
  if p_instructional_notes is not null and length(trim(p_instructional_notes)) not between 1 and 4000 then
    raise exception 'Instructional notes must be bounded text';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded agent configuration reason is required';
  end if;
  if not exists(select 1 from public.programme_versions where id = p_programme_version_id) then
    raise exception 'Programme version not found';
  end if;

  -- Shared with assert_full_package_valid's agent-configuration check, so
  -- the two can never diverge into different copies of the same policy.
  allowed := course_engineering_private.role_capability_allowlist(p_role);

  normalized := coalesce(p_capabilities, array[]::text[]);
  if not (normalized <@ allowed) then
    raise exception 'Requested capability is outside the reviewed allowlist for this role';
  end if;
  if array_length(normalized, 1) is not null
    and array_length(normalized, 1) <> (select count(*) from (select distinct c from unnest(normalized) c) d) then
    raise exception 'Duplicate capability in request';
  end if;

  perform set_config('app.audit_reason', trim(p_reason), true);
  insert into public.academic_agent_configs(
    programme_version_id, role, enabled, model_profile_ref, instructional_notes,
    capabilities, escalation_policy, created_by
  ) values (
    p_programme_version_id, p_role, p_enabled, p_model_profile_ref,
    nullif(trim(coalesce(p_instructional_notes, '')), ''),
    normalized, p_escalation_policy, actor
  )
  on conflict (programme_version_id, role) do update
  set enabled = excluded.enabled,
      model_profile_ref = excluded.model_profile_ref,
      instructional_notes = excluded.instructional_notes,
      capabilities = excluded.capabilities,
      escalation_policy = excluded.escalation_policy,
      updated_at = clock_timestamp()
  returning id into result_id;

  return result_id;
end $$;

create function public.list_agent_configs(p_programme_version_id uuid)
returns table(
  id uuid, programme_version_id uuid, role text, enabled boolean, model_profile_ref text,
  instructional_notes text, capabilities text[], escalation_policy text, updated_at timestamptz
)
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := public.current_app_user();
  if actor is null or not (
    public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')
  ) then
    raise exception 'Access denied' using errcode='42501';
  end if;

  return query
  select c.id, c.programme_version_id, c.role, c.enabled, c.model_profile_ref,
         c.instructional_notes, c.capabilities, c.escalation_policy, c.updated_at
  from public.academic_agent_configs c
  where c.programme_version_id = p_programme_version_id
  order by c.role;
end $$;

-- Narrow learner-scoped read. Configuration absence fails closed to a
-- disabled default rather than an error, so a future role runtime never
-- treats "no row" as an elevated or unspecified capability set.
create function public.get_agent_config_for_enrolment(p_enrolment_id uuid, p_role text)
returns table(enabled boolean, model_profile_ref text, capabilities text[], escalation_policy text)
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  enrolment_record public.enrolments%rowtype;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_role not in ('PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR') then
    raise exception 'Unsupported agent role';
  end if;

  select * into enrolment_record
  from public.enrolments
  where id = p_enrolment_id and student_id = actor;
  if not found then raise exception 'Matching learner enrolment not found'; end if;

  return query
  select c.enabled, c.model_profile_ref, c.capabilities, c.escalation_policy
  from public.academic_agent_configs c
  where c.programme_version_id = enrolment_record.programme_version_id and c.role = p_role;

  if not found then
    return query select false, null::text, array[]::text[], 'NONE';
  end if;
end $$;

-- Explicitly neutralise ambient Supabase default ACLs, including
-- service_role, on every function this migration created (the private
-- schema's and the public RPCs'), then grant EXECUTE back to authenticated
-- only on the reviewed public RPCs below. service_role is never granted
-- EXECUTE on anything in this migration.
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'course_engineering_private'
       or (n.nspname = 'public' and p.proname in (
         'guard_course_package_import_history','audit_course_package_change',
         'guard_agent_config_history','audit_agent_config_change',
         'import_course_package','mark_course_package_validated','reject_course_package',
         'apply_course_package','publish_course_package','get_course_package_content',
         'get_course_package_preview','list_course_packages',
         'set_agent_config','list_agent_configs','get_agent_config_for_enrolment'
       )) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'import_course_package','mark_course_package_validated','reject_course_package',
      'apply_course_package','publish_course_package','get_course_package_content',
      'get_course_package_preview','list_course_packages',
      'set_agent_config','list_agent_configs','get_agent_config_for_enrolment'
    ) loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Table REVOKE alone does not clear pre-existing column-level privileges
-- from Supabase-like broad defaults.
do $$ declare t regclass; columns text; begin
  foreach t in array array['public.course_package_imports'::regclass, 'public.academic_agent_configs'::regclass] loop
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns
      from pg_attribute where attrelid = t and attnum > 0 and not attisdropped;
    execute format(
      'revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns, columns, columns, columns, t
    );
  end loop;
end $$;

-- Effective-ACL acceptance: unexpected inherited privileges fail deployment
-- rather than silently relying on RLS against a BYPASSRLS role. Authenticated
-- access is through only the reviewed public RPCs listed above, each with an
-- operation-specific identity/role check.
do $$ declare t regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['public.course_package_imports'::regclass, 'public.academic_agent_configs'::regclass] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective course-engineering table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r, 'course_engineering_private', 'USAGE,CREATE') then
      raise exception 'Unsafe effective course-engineering schema privileges for %', r;
    end if;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'course_engineering_private'
         or (n.nspname = 'public' and p.proname in (
           'guard_course_package_import_history','audit_course_package_change',
           'guard_agent_config_history','audit_agent_config_change',
           'import_course_package','mark_course_package_validated','reject_course_package',
           'apply_course_package','publish_course_package','get_course_package_content',
           'get_course_package_preview','list_course_packages',
           'set_agent_config','list_agent_configs','get_agent_config_for_enrolment'
         )) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (
        r = 'authenticated' and f.nspname = 'public' and f.proname in (
          'import_course_package','mark_course_package_validated','reject_course_package',
          'apply_course_package','publish_course_package','get_course_package_content',
          'get_course_package_preview','list_course_packages',
          'set_agent_config','list_agent_configs','get_agent_config_for_enrolment'
        )
      ) then
        raise exception 'Unsafe effective course-engineering function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
