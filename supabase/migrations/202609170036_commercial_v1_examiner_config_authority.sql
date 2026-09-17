-- PR16A: Generic Academic Role Configuration / Runtime Binding Authority.
-- Additive only; migrations 001-035 are byte-for-byte unchanged. This is
-- the only migration this checkpoint introduces (no 037).
--
-- Closes two confirmed generic Commercial V1 defects:
--   A. Professor accepted any existing runtime profile ref from the flat
--      production registry instead of a role-bound Professor profile
--      (closed in TypeScript: src/domain/academic-runtime-profile.ts's
--      ROLE_RUNTIME_PROFILE_POLICY + src/server/academic-runtime/profile-
--      registry.ts's resolveRoleBoundRuntimeProfile, wired into
--      src/server/academic-runtime/index.ts and src/server/tutor-lab-
--      execution/index.ts).
--   B. Normal learner-initiated Examiner grading ignored the programme-
--      version EXAMINER academic_agent_configs row entirely (closed here,
--      inside govern_commercial_v1_examiner_execution's AUTHORIZE branch).
--
-- Scope discipline: does NOT touch migration 031/032's claim uniqueness,
-- HMAC protocol, CONTEXT_READ protection, grade digest, usage accounting,
-- FINALIZE transaction, result validation or regrade authority. Does NOT
-- touch the administrative regrade plane (migration 032,
-- commercial_v1_regrade_private / govern_commercial_v1_examiner_regrade) at
-- all -- it remains fixed-profile, ACADEMIC_ADMIN/PLATFORM_ADMIN controlled,
-- out of this checkpoint's scope. Does NOT touch
-- COURSE_PREPUBLICATION_TEST_V1's fingerprint/pass semantics
-- (compute_publication_fingerprint is not modified by this migration).

-- ==========================================================================
-- Section A: shared role/profile/null policy helpers (course_engineering_
-- private, the schema that already owns role_capability_allowlist). Must
-- stay byte-for-byte in semantic step with src/domain/academic-runtime-
-- profile.ts's ROLE_RUNTIME_PROFILE_POLICY and
-- validateRoleModelProfileRef -- a change to one without the other is
-- itself a defect. No permanent public helper API: every function here is
-- created in the private schema and explicitly stripped of ambient
-- Supabase default ACLs below (Section G), exactly like every other
-- private-schema helper in this codebase.
-- ==========================================================================
create function course_engineering_private.role_profile_allowed_ref(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'PROFESSOR' then 'PROFESSOR_COMMERCIAL_V1'
    when 'TUTOR' then 'TUTOR_COMMERCIAL_V1'
    when 'LAB_INSTRUCTOR' then 'LAB_INSTRUCTOR_COMMERCIAL_V1'
    when 'EXAMINER' then 'EXAMINER_COMMERCIAL_V1'
    when 'COUNSELLOR' then null
    else null
  end
$$;

create function course_engineering_private.role_profile_null_behavior(p_role text) returns text
language sql immutable set search_path='' as $$
  select case p_role
    when 'PROFESSOR' then 'REJECT'
    when 'TUTOR' then 'DEFAULT_TO_ROLE_PROFILE'
    when 'LAB_INSTRUCTOR' then 'DEFAULT_TO_ROLE_PROFILE'
    when 'EXAMINER' then 'DEFAULT_TO_ROLE_PROFILE'
    when 'COUNSELLOR' then 'ONLY_NULL'
    else null
  end
$$;

-- Pure authoring/storage-time validation, mirroring src/domain/academic-
-- runtime-profile.ts's validateRoleModelProfileRef exactly: ANY non-null
-- ref that is not the exact role's allowed ref is invalid regardless of
-- p_enabled (this also covers COUNSELLOR, whose allowed ref is null: any
-- non-null ref fails here); PROFESSOR additionally requires a non-null ref
-- whenever p_enabled=true.
create function course_engineering_private.role_profile_ref_is_valid(
  p_role text, p_ref text, p_enabled boolean
) returns boolean
language plpgsql immutable set search_path='' as $$
declare allowed text; behavior text;
begin
  allowed := course_engineering_private.role_profile_allowed_ref(p_role);
  behavior := course_engineering_private.role_profile_null_behavior(p_role);
  if p_ref is not null and p_ref is distinct from allowed then return false; end if;
  if p_ref is null and behavior = 'REJECT' and coalesce(p_enabled, false) then return false; end if;
  return true;
end $$;

-- Runtime resolution: the effective ref an ENABLED role's stored config
-- would execute with, or NULL to fail closed (unresolvable/cross-role, or a
-- role -- COUNSELLOR -- with no provider-backed profile at all). Mirrors
-- resolveRoleBoundRuntimeProfile's domain-policy half
-- (src/server/academic-runtime/profile-registry.ts) -- never itself a
-- runtime/model profile registry lookup, only which ref (if any) is
-- admitted.
create function course_engineering_private.resolve_role_profile_ref(p_role text, p_ref text) returns text
language plpgsql immutable set search_path='' as $$
declare allowed text; behavior text;
begin
  allowed := course_engineering_private.role_profile_allowed_ref(p_role);
  behavior := course_engineering_private.role_profile_null_behavior(p_role);
  if behavior = 'ONLY_NULL' then return null; end if;
  if p_ref is null then
    if behavior = 'DEFAULT_TO_ROLE_PROFILE' then return allowed; end if;
    return null;
  end if;
  if p_ref = allowed then return p_ref; end if;
  return null;
end $$;

-- ==========================================================================
-- Section B: corrected EXAMINER capability allowlist. Replaces the old
-- context-read placeholder (get_current_learner_context/get_lesson_context)
-- with EXAMINER's real, live execution authorities
-- (grade_controlled_assessment/grade_practical_lab), matching src/domain/
-- academic-capability-policy.ts's roleCapabilityCatalogue.EXAMINER. Every
-- other role's allowlist is byte-for-byte unchanged from migration 024.
-- ==========================================================================
create or replace function course_engineering_private.role_capability_allowlist(p_role text) returns text[]
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
      'grade_controlled_assessment','grade_practical_lab'
    ]
    when 'COUNSELLOR' then array['get_current_learner_context']
    else null
  end
$$;

-- ==========================================================================
-- Section C: tightened assert_full_package_valid. Byte-for-byte identical
-- to migration 024's original except for the single new role/profile/null
-- policy check added to the AGENT CONFIGURATION block below (marked
-- PR16A). Every other check -- curriculum, practicals, assignment/
-- assessment templates, scheduling defaults, capability-allowlist
-- membership -- is unchanged.
-- ==========================================================================
create or replace function course_engineering_private.assert_full_package_valid(
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
    -- PR16A (migration 036): the shared role/profile/null policy applies at
    -- this authoring boundary too -- a cross-role modelProfileRef, or a
    -- null ref on an enabled PROFESSOR entry, can never validate.
    if not course_engineering_private.role_profile_ref_is_valid(
      role_item,
      case when jsonb_typeof(role_config->'modelProfileRef') is distinct from 'null'
        then role_config->>'modelProfileRef' else null end,
      (role_config->>'enabled')::boolean
    ) then
      raise exception 'An agent configuration modelProfileRef is invalid for its role or null policy';
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

-- ==========================================================================
-- Section D: tightened set_agent_config. Byte-for-byte identical to
-- migration 024's original except for the single new role/profile/null
-- policy check added below (marked PR16A).
-- ==========================================================================
create or replace function public.set_agent_config(
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
  -- PR16A (migration 036): role/profile/null policy enforcement, shared
  -- with assert_full_package_valid's identical check so the two can never
  -- diverge into different copies of the same policy.
  if not course_engineering_private.role_profile_ref_is_valid(p_role, p_model_profile_ref, p_enabled) then
    raise exception 'Model profile reference is invalid for this role or null policy';
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

-- ==========================================================================
-- Section E: migration-036 compatibility preflight. Runs NOW, inside this
-- same migration transaction, against real current database state -- never
-- against a caller-supplied hash/report. See the checkpoint's frozen
-- status semantics:
--   VALIDATED/APPLIED/PUBLISHED raw_package incompatible with the new
--     policy -> HARD FAIL (raises, rolling back this entire migration).
--   IMPORTED raw_package incompatible -> bounded NOTICE only, never blocks.
--   REJECTED -> ignored entirely (cannot re-enter the lifecycle).
--   ANY incompatible persisted academic_agent_configs row -> HARD FAIL,
--     regardless of package linkage/status.
-- Because this migration file is one transaction, a RAISE EXCEPTION here
-- leaves data unchanged and restores the OLD (pre-036) function
-- definitions the CREATE OR REPLACE statements above would otherwise have
-- installed -- no partial migration-036 authority is ever left installed.
-- ==========================================================================
do $$
declare
  pkg record;
  cfg record;
  allowed_caps text[];
begin
  for pkg in
    select package_key, status, package_revision, schema_version, raw_package
    from public.course_package_imports
    where status in ('VALIDATED','APPLIED','PUBLISHED')
  loop
    begin
      perform course_engineering_private.assert_full_package_valid(
        pkg.package_key, pkg.package_revision, pkg.schema_version, pkg.raw_package
      );
    exception when others then
      raise exception 'Migration 036 preflight: course package % (status %) is incompatible with the new role/profile/capability policy and cannot be safely installed', pkg.package_key, pkg.status;
    end;
  end loop;

  for pkg in
    select package_key, status, package_revision, schema_version, raw_package
    from public.course_package_imports
    where status = 'IMPORTED'
  loop
    begin
      perform course_engineering_private.assert_full_package_valid(
        pkg.package_key, pkg.package_revision, pkg.schema_version, pkg.raw_package
      );
    exception when others then
      raise notice 'Migration 036 preflight: IMPORTED draft package % is incompatible with the new policy and will correctly fail its own later validation; this does not block migration', pkg.package_key;
    end;
  end loop;

  for cfg in select role, model_profile_ref, enabled, capabilities, programme_version_id from public.academic_agent_configs loop
    allowed_caps := course_engineering_private.role_capability_allowlist(cfg.role);
    if not (coalesce(cfg.capabilities, array[]::text[]) <@ allowed_caps) then
      raise exception 'Migration 036 preflight: a stored agent configuration for role % (programme version %) has a capability outside the new reviewed allowlist and cannot be safely installed', cfg.role, cfg.programme_version_id;
    end if;
    if not course_engineering_private.role_profile_ref_is_valid(cfg.role, cfg.model_profile_ref, cfg.enabled) then
      raise exception 'Migration 036 preflight: a stored agent configuration for role % (programme version %) has an invalid model profile reference under the new role/profile/null policy and cannot be safely installed', cfg.role, cfg.programme_version_id;
    end if;
  end loop;
end $$;

-- ==========================================================================
-- Section F: corrected govern_commercial_v1_examiner_execution. Byte-for-
-- byte identical to migration 031's original except for the new config-
-- governed admission block added to AUTHORIZE (marked PR16A) in both
-- capability branches, immediately before the (now two-way) execution-row
-- insert. Every other section -- controller attestation reuse, the exact-
-- target replay lookup, rate/budget-envelope checks, target ownership/
-- eligibility resolution, START, CONTEXT_READ (unaffected, defined
-- separately by migration 031 and untouched here), and the entire FINALIZE
-- transaction (grade digest recomputation, result-integrity validation,
-- the Critical Success Rule) -- is unchanged.
-- ==========================================================================
create or replace function public.govern_commercial_v1_examiner_execution(
  p_key_id uuid,p_execution_id uuid,p_capability text,p_target_kind text,p_attempt_id uuid,p_submission_id uuid,
  p_enrolment_id uuid,p_activation_id uuid,p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,
  p_assessment_marks jsonb,p_lab_marks_awarded integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid; stamp timestamptz; execution_record public.commercial_v1_examiner_executions%rowtype;
  attempt public.assessment_attempts%rowtype; e public.enrolments%rowtype; activation public.course_activations%rowtype;
  binding public.commercial_v1_component_bindings%rowtype; submission public.commercial_v1_lab_submissions%rowtype;
  inserted_count integer; existing public.commercial_v1_examiner_executions%rowtype; denied text;
  computed_digest text; marks_text text; expected_weight integer; max_total integer; result_id uuid;
  mark_elem jsonb; qid uuid; mark integer; qmax integer; answered_count integer; marks_count integer;
  q_row record; lp record;
  -- PR16A (migration 036): the programme-version EXAMINER configuration
  -- AUTHORIZE reads, and the role-bound runtime profile ref it resolves.
  agent_config public.academic_agent_configs%rowtype; resolved_profile_ref text;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;
  if not commercial_v1_examiner_private.verify_command_ex1(p_key_id,p_execution_id,p_capability,p_target_kind,p_attempt_id,p_submission_id,
    p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
    p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  if not commercial_v1_examiner_private.verify_command_ex1(p_key_id,p_execution_id,p_capability,p_target_kind,p_attempt_id,p_submission_id,
    p_enrolment_id,p_activation_id,p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
    p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,p_grade_digest,p_issued_at,p_expires_at,p_mac) then
    return jsonb_build_object('ok',false,'code','UNTRUSTED_EXECUTION');
  end if;
  stamp := clock_timestamp();
  -- Lazily timeout any stale AUTHORIZED/RUNNING execution for this student
  -- (backstop, mirrors migrations 025/028; the terminal row remains the
  -- ONE row ever created for its own target -- no retry follows).
  update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=expires_at
  where student_id=actor and state in ('AUTHORIZED','RUNNING') and expires_at<=stamp;

  if p_operation='AUTHORIZE' then
    if not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
    if p_state<>'AUTHORIZED' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0
      or p_grade_digest is not null or p_enrolment_id is not null or p_activation_id is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;

    -- Blocker 2 (independent review, V3): check for an existing Examiner
    -- execution CLAIM for this EXACT target FIRST -- strictly before the
    -- student's generic new-admission rate limits, budget-envelope
    -- validation and fresh-target eligibility checks below. Otherwise a
    -- prior SUCCEEDED target could incorrectly surface as RATE_LIMITED
    -- merely because another target is currently active, or because the
    -- student's 5/60s or 30/1h admission counters are exhausted -- neither
    -- of which has anything to do with a target that was already resolved.
    -- A same-target replay must always observe its OWN execution's outcome
    -- (preserving, for a prior SUCCEEDED grade, the exact resultRevisionId,
    -- or PR16A's own durable ESCALATED claim) rather than a generic
    -- ALREADY_GRADED denial or an unrelated admission-limit denial that
    -- would both discard it. ALREADY_GRADED remains reachable below, but
    -- only once this checkpoint's own execution history has nothing to say
    -- about the target -- i.e. only for a production result that predates
    -- (or exists independent of) any Examiner execution for it.
    -- Actor-safe by construction: the lookup is filtered to
    -- student_id=actor, so a caller probing with a foreign attempt/
    -- submission id observes nothing here (falls through to the ordinary
    -- ownership check below, which returns the same bounded
    -- NOT_FOUND_OR_FORBIDDEN it always has) -- never another student's
    -- execution projection, state or resultRevisionId.
    if p_capability='grade_controlled_assessment' then
      select * into existing from public.commercial_v1_examiner_executions where attempt_id=p_attempt_id and student_id=actor;
    else
      select * into existing from public.commercial_v1_examiner_executions where submission_id=p_submission_id and student_id=actor;
    end if;
    if found then
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      return commercial_v1_examiner_private.execution_projection(existing.id,false);
    end if;

    -- Only reached when NO exact-target claim exists for this actor: new-
    -- admission rate limiting, budget-envelope validation and fresh-target
    -- eligibility checks now apply.
    if exists(select 1 from public.commercial_v1_examiner_executions where student_id=actor and state in ('AUTHORIZED','RUNNING'))
      or (select count(*) from public.commercial_v1_examiner_executions where student_id=actor and created_at>stamp-interval '60 seconds')>=5
      or (select count(*) from public.commercial_v1_examiner_executions where student_id=actor and created_at>stamp-interval '1 hour')>=30 then
      return jsonb_build_object('ok',false,'code','RATE_LIMITED');
    end if;
    if p_max_calls<>1 or p_max_output<1 or p_max_output>1200 or p_max_cost<1 or p_max_cost>50000 then
      return jsonb_build_object('ok',false,'code','OUT_OF_ENVELOPE');
    end if;

    if p_capability='grade_controlled_assessment' then
      select * into attempt from public.assessment_attempts where id=p_attempt_id;
      if not found or attempt.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      if attempt.state<>'SUBMITTED' then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      select * into e from public.enrolments where id=attempt.enrolment_id;
      if not found or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select a.* into activation from public.course_activations a where a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id;
      if not found then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      select * into binding from public.commercial_v1_component_bindings where activation_id=activation.id and assessment_id=attempt.assessment_id;
      if not found then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      if not exists(select 1 from public.commercial_v1_result_policies where activation_id=activation.id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      -- No Examiner execution exists for this target (checked above), but a
      -- production result already does -- historical/external result state
      -- (e.g. a future manual/service-authored result). Fail closed rather
      -- than create a second execution claim that could never produce a
      -- second revision anyway (guard_assessment_result_insert, migration
      -- 030, refuses revision 1 once one already exists).
      if exists(select 1 from public.commercial_v1_assessment_result_revisions where enrolment_id=e.id and component=binding.component) then
        return jsonb_build_object('ok',false,'code','ALREADY_GRADED');
      end if;

      -- ==================================================================
      -- PR16A (migration 036): AUTHORIZE is the configuration-snapshot
      -- boundary. Same programme_versions serialization authority set_
      -- agent_config/lock_config_version already uses (migration 027's
      -- activation_config_serialization trigger takes this exact row FOR
      -- UPDATE before every academic_agent_configs write) -- FOR SHARE here
      -- guarantees a config write committed before this point is observed,
      -- and a racing config write holding FOR UPDATE makes this AUTHORIZE
      -- wait. No lock is held across the external provider network call:
      -- this function returns to its TypeScript caller (and this
      -- transaction commits or rolls back) long before any HTTP provider
      -- call happens.
      -- ==================================================================
      perform 1 from public.programme_versions where id=activation.programme_version_id for share;
      select * into agent_config from public.academic_agent_configs
        where programme_version_id=activation.programme_version_id and role='EXAMINER';
      if not found or not agent_config.enabled then
        return jsonb_build_object('ok',false,'code','POLICY_BLOCKED');
      end if;
      if not (p_capability = any(agent_config.capabilities)) then
        return jsonb_build_object('ok',false,'code','POLICY_BLOCKED');
      end if;
      resolved_profile_ref := course_engineering_private.resolve_role_profile_ref('EXAMINER', agent_config.model_profile_ref);
      if resolved_profile_ref is null then
        return jsonb_build_object('ok',false,'code','UNKNOWN_MODEL_PROFILE');
      end if;

      if agent_config.escalation_policy = 'ACADEMIC_REVIEW' then
        -- Durable direct ESCALATED claim: exactly one Examiner execution
        -- row, terminal on creation, zero provider calls, no usage row.
        insert into public.commercial_v1_examiner_executions(
          id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
          runtime_profile_ref,state,reason_code,terminal_at,review_path,
          created_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
        ) values (
          p_execution_id,actor,e.id,activation.id,p_capability,'ASSESSMENT_ATTEMPT',p_attempt_id,binding.component,
          resolved_profile_ref,'ESCALATED','HUMAN_REVIEW_REQUIRED',stamp,'ACADEMIC_REVIEW',
          stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
        ) on conflict (attempt_id) where attempt_id is not null do nothing;
      else
        insert into public.commercial_v1_examiner_executions(
          id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
          runtime_profile_ref,
          state,created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
        ) values (
          p_execution_id,actor,e.id,activation.id,p_capability,'ASSESSMENT_ATTEMPT',p_attempt_id,binding.component,
          resolved_profile_ref,
          'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
        ) on conflict (attempt_id) where attempt_id is not null do nothing;
      end if;
    else
      select * into submission from public.commercial_v1_lab_submissions where id=p_submission_id;
      if not found or submission.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select * into e from public.enrolments where id=submission.enrolment_id;
      if not found or e.student_id<>actor then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;
      select a.* into activation from public.course_activations a where a.cohort_id=e.cohort_id and a.programme_version_id=e.programme_version_id;
      if not found or activation.id<>submission.activation_id then return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE'); end if;
      if not exists(select 1 from public.commercial_v1_lab_policies where activation_id=activation.id and practical_id=submission.practical_id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      if not exists(select 1 from public.commercial_v1_result_policies where activation_id=activation.id) then
        return jsonb_build_object('ok',false,'code','TARGET_NOT_ELIGIBLE');
      end if;
      if exists(select 1 from public.commercial_v1_lab_result_revisions where enrolment_id=e.id and practical_id=submission.practical_id) then
        return jsonb_build_object('ok',false,'code','ALREADY_GRADED');
      end if;

      -- PR16A (migration 036): identical config-governance block as the
      -- assessment branch above.
      perform 1 from public.programme_versions where id=activation.programme_version_id for share;
      select * into agent_config from public.academic_agent_configs
        where programme_version_id=activation.programme_version_id and role='EXAMINER';
      if not found or not agent_config.enabled then
        return jsonb_build_object('ok',false,'code','POLICY_BLOCKED');
      end if;
      if not (p_capability = any(agent_config.capabilities)) then
        return jsonb_build_object('ok',false,'code','POLICY_BLOCKED');
      end if;
      resolved_profile_ref := course_engineering_private.resolve_role_profile_ref('EXAMINER', agent_config.model_profile_ref);
      if resolved_profile_ref is null then
        return jsonb_build_object('ok',false,'code','UNKNOWN_MODEL_PROFILE');
      end if;

      if agent_config.escalation_policy = 'ACADEMIC_REVIEW' then
        insert into public.commercial_v1_examiner_executions(
          id,student_id,enrolment_id,activation_id,capability,target_kind,submission_id,practical_id,
          runtime_profile_ref,state,reason_code,terminal_at,review_path,
          created_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
        ) values (
          p_execution_id,actor,e.id,activation.id,p_capability,'LAB_SUBMISSION',p_submission_id,submission.practical_id,
          resolved_profile_ref,'ESCALATED','HUMAN_REVIEW_REQUIRED',stamp,'ACADEMIC_REVIEW',
          stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
        ) on conflict (submission_id) where submission_id is not null do nothing;
      else
        insert into public.commercial_v1_examiner_executions(
          id,student_id,enrolment_id,activation_id,capability,target_kind,submission_id,practical_id,
          runtime_profile_ref,
          state,created_at,authorized_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd
        ) values (
          p_execution_id,actor,e.id,activation.id,p_capability,'LAB_SUBMISSION',p_submission_id,submission.practical_id,
          resolved_profile_ref,
          'AUTHORIZED',stamp,stamp,stamp+interval '20 seconds',1,p_max_output,p_max_cost
        ) on conflict (submission_id) where submission_id is not null do nothing;
      end if;
    end if;
    get diagnostics inserted_count = row_count;
    if inserted_count=0 then
      -- Concurrency backstop: another request for this SAME actor's SAME
      -- target won the insert race between the pre-check above and here
      -- (a foreign actor can never reach this point at all -- the
      -- eligibility checks just above already required this target to
      -- belong to `actor`). Still filtered by student_id=actor for
      -- defense-in-depth consistency with the pre-check.
      if p_capability='grade_controlled_assessment' then
        select * into existing from public.commercial_v1_examiner_executions where attempt_id=p_attempt_id and student_id=actor;
      else
        select * into existing from public.commercial_v1_examiner_executions where submission_id=p_submission_id and student_id=actor;
      end if;
      if existing.state in ('AUTHORIZED','RUNNING') then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
      -- A pre-existing TERMINAL row for this exact target: return its own
      -- outcome unchanged, never a second provider call for it.
      return commercial_v1_examiner_private.execution_projection(existing.id,false);
    end if;
    return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
  end if;

  select * into execution_record from public.commercial_v1_examiner_executions where id=p_execution_id and student_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','EXECUTION_UNAVAILABLE'); end if;
  if execution_record.capability<>p_capability or execution_record.target_kind<>p_target_kind
    or execution_record.attempt_id is distinct from p_attempt_id or execution_record.submission_id is distinct from p_submission_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;
  if execution_record.state not in ('AUTHORIZED','RUNNING') then
    return jsonb_build_object('ok',false,'code',
      case when execution_record.reason_code='EXECUTION_TIMEOUT' then 'EXECUTION_TIMEOUT' else 'REPLAY_REJECTED' end);
  end if;
  if stamp>=execution_record.expires_at then
    update public.commercial_v1_examiner_executions set state='TIMEOUT',reason_code='EXECUTION_TIMEOUT',terminal_at=execution_record.expires_at
    where id=p_execution_id;
    return jsonb_build_object('ok',false,'code','EXECUTION_TIMEOUT');
  end if;
  if p_enrolment_id<>execution_record.enrolment_id or p_activation_id<>execution_record.activation_id then
    return jsonb_build_object('ok',false,'code','CONTEXT_CONFLICT');
  end if;

  if p_operation='START' then
    if p_state<>'RUNNING' or p_reason<>'NONE' or p_budget_stage<>'NONE'
      or p_calls<>0 or p_attempts<>0 or p_input<>0 or p_output<>0 or p_cost<>0 or p_elapsed<>0 or p_grade_digest is not null then
      return jsonb_build_object('ok',false,'code','INVALID_INPUT');
    end if;
    if execution_record.state='RUNNING' then return jsonb_build_object('ok',false,'code','REPLAY_REJECTED'); end if;
    update public.commercial_v1_examiner_executions set state='RUNNING',started_at=stamp where id=p_execution_id;
    return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
  end if;

  -- FINALIZE
  if execution_record.state<>'RUNNING' then return jsonb_build_object('ok',false,'code','INVALID_INPUT'); end if;
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
  if p_state='SUCCEEDED' and (p_output>execution_record.max_output_tokens or p_cost>execution_record.max_estimated_cost_microusd) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  insert into public.commercial_v1_examiner_execution_usage(
    execution_id,provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms
  ) values(p_execution_id,p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed);

  if p_state='SUCCEEDED' then
    -- ============================================================
    -- CRITICAL SUCCESS RULE: the SAME enrolment row lock
    -- attempt_commercial_v1_course_completion uses, acquired before any
    -- current-result observation or write. Everything below -- the
    -- authoritative result insert, the question marks (assessment) or
    -- earned/max/contribution (lab), the existing PR11A derivation helper,
    -- PR11A's own assessment_result_is_valid/lab_result_is_valid check, and
    -- the execution row's own transition to SUCCEEDED -- happens inside
    -- this single PL/pgSQL function invocation, which is one PostgreSQL
    -- transaction: it either all commits together, or (on any exception,
    -- caught below) none of the result-side writes survive and the
    -- execution is instead durably recorded FAILED/RESULT_INTEGRITY_FAILED.
    -- A result can therefore never exist while its Examiner execution
    -- remains non-successful, and this row can never become SUCCEEDED
    -- while its result is missing or invalid.
    -- ============================================================
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
          execution_record.attempt_id,(select assessment_id from public.assessment_attempts where id=execution_record.attempt_id),1,
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
          execution_record.submission_id,1,p_lab_marks_awarded,lp.max_marks,lp.contribution_bp
        ) returning id into result_id;

        perform commercial_v1_private.derive_and_insert_lab_objective_outcomes(result_id);
        if not commercial_v1_private.lab_result_is_valid(result_id) then raise exception 'RESULT_INTEGRITY_FAILED'; end if;
      end if;
      update public.commercial_v1_examiner_executions
      set state='SUCCEEDED',reason_code='GRADED',terminal_at=stamp,result_revision_id=result_id,grade_digest=p_grade_digest
      where id=p_execution_id;
    exception when others then
      denied := 'RESULT_INTEGRITY_FAILED';
    end;
    if denied is not null then
      update public.commercial_v1_examiner_executions
      set state='FAILED',reason_code=denied,terminal_at=stamp where id=p_execution_id;
    end if;
  else
    update public.commercial_v1_examiner_executions
    set state=p_state,reason_code=p_reason,budget_stage=nullif(p_budget_stage,'NONE'),terminal_at=stamp,
      review_path=case when p_state='ESCALATED' then 'ACADEMIC_REVIEW' else null end
    where id=p_execution_id;
  end if;
  return commercial_v1_examiner_private.execution_projection(p_execution_id,true);
end $$;

-- ==========================================================================
-- Section G: ACL hardening. Explicitly neutralise ambient Supabase default
-- ACLs, including service_role, on every NEW function this migration
-- created (Section A's private helpers). The five CREATE OR REPLACE
-- statements above (role_capability_allowlist, assert_full_package_valid,
-- set_agent_config, govern_commercial_v1_examiner_execution) each preserve
-- whatever ACL that function already had (migrations 024/031's own reviewed
-- grants), so they are not re-listed here.
-- ==========================================================================
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'course_engineering_private' and p.proname in (
      'role_profile_allowed_ref','role_profile_null_behavior',
      'role_profile_ref_is_valid','resolve_role_profile_ref'
    ) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;

-- Closing safety assertion (mirrors migrations 022/024/025/028/031/035's own
-- pattern): no role outside the reviewed set may ever hold EXECUTE on the
-- new private-schema helpers, and the schema itself already has no USAGE
-- grant to any of these roles (migration 024).
do $$ declare r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(r,'course_engineering_private','USAGE,CREATE') then
      raise exception 'Unsafe effective course_engineering_private schema privileges for %', r;
    end if;
    for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='course_engineering_private' and p.proname in (
        'role_profile_allowed_ref','role_profile_null_behavior',
        'role_profile_ref_is_valid','resolve_role_profile_ref'
      ) loop
      if has_function_privilege(r,f.oid,'EXECUTE') then
        raise exception 'Unsafe effective course_engineering_private function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
