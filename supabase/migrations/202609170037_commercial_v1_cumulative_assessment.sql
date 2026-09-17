-- SEC701-B: backwards-compatible COURSE_PACKAGE_V1 cumulative questions.
-- Existing lesson_id remains the assessment anchor; objective_lesson_id is
-- the objective source. No historical package/content/assessment is rewritten.
begin;
lock table public.course_assessment_objectives in access exclusive mode;
alter table public.course_assessment_objectives add column objective_lesson_id uuid;
-- The only user trigger on this table is activation_immutable (verified on 036).
-- Suspend only this history guard for one metadata-only backfill, transactionally.
alter table public.course_assessment_objectives disable trigger activation_immutable;
update public.course_assessment_objectives set objective_lesson_id=lesson_id;
alter table public.course_assessment_objectives enable trigger activation_immutable;
alter table public.course_assessment_objectives alter column objective_lesson_id set not null;
alter table public.course_assessment_objectives
 drop constraint course_assessment_objectives_import_id_objective_id_lesson_fkey;
alter table public.course_assessment_objectives
 add constraint course_assessment_objective_source_fkey
 foreign key(import_id,objective_id,objective_lesson_id,programme_version_id)
 references public.course_activation_objectives(import_id,objective_id,lesson_id,programme_version_id);
comment on column public.course_assessment_objectives.lesson_id is 'Assessment anchor lesson; not necessarily the objective source lesson.';
comment on column public.course_assessment_objectives.objective_lesson_id is 'Actual source lesson of objective_id within the same import and programme version.';

-- Derived from the live 036 validator, preserving its role/profile/null policy.
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
      perform course_engineering_private.assert_exact_keys(question_item - 'lessonRef',
        array['position','prompt','maxMarks','expectedAnswer','markingGuidance','objectiveRefs'],
        'an assessment question');
      -- Optional V1 extension; a present null/non-string is not omission.
      if question_item ? 'lessonRef' then
        perform course_engineering_private.assert_local_ref(question_item->'lessonRef', 'an assessment question lessonRef');
      end if;
      if not (coalesce(question_item->>'lessonRef', template_item->>'lessonRef') = any(lesson_keys)) then
        raise exception 'Assessment question references an unknown lesson';
      end if;
      objective_refs_for_lesson := lesson_objective_map->coalesce(question_item->>'lessonRef', template_item->>'lessonRef');
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

-- Existing 027 activation with question-scoped objective resolution only.
create or replace function public.activate_course_package(p_import_id uuid,p_cohort_id uuid,p_instructor_id uuid,p_assignments jsonb,p_assessments jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; imp public.course_package_imports; prior public.course_activations; cv uuid; aid uuid; lid uuid; mid uuid; oid uuid; rid uuid; qid uuid; objective_lid uuid; mapped_count integer;
 m jsonb; l jsonb; o jsonb; t jsonb; q jsonb; r jsonb; win jsonb; a_windows jsonb; e_windows jsonb; fingerprint text; first_version boolean; idx integer;
begin
 actor:=course_activation_private.require_admin();
 if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'INVALID_INPUT'; end if;
 select * into imp from public.course_package_imports where id=p_import_id for update;
 if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 if imp.status not in ('APPLIED','PUBLISHED') then raise exception 'INVALID_STATE'; end if;
 -- Lock order: import -> version -> cohort. Every cohort activation sharing a
 -- version serializes here; config authoring uses this same version row lock.
 perform 1 from public.programme_versions where id=imp.programme_version_id and status='PUBLISHED' for update;
 if not found then raise exception 'INVALID_STATE'; end if;
 select programme_version_id into cv from public.cohorts where id=p_cohort_id for update;
 if cv is distinct from imp.programme_version_id then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 perform 1 from public.role_grants where user_id=p_instructor_id and role='INSTRUCTOR' for share;
 if not found or not exists(select 1 from public.staff_profiles where user_id=p_instructor_id) then raise exception 'INVALID_INSTRUCTOR'; end if;
 perform course_engineering_private.assert_full_package_valid(imp.package_key,imp.package_revision,imp.schema_version,imp.raw_package);
 a_windows:=course_activation_private.schedule(p_assignments,imp.raw_package->'assignmentTemplates','dueAt');
 e_windows:=course_activation_private.schedule(p_assessments,imp.raw_package->'assessmentTemplates','closesAt');
 fingerprint:=encode(extensions.digest(jsonb_build_object('import',p_import_id,'cohort',p_cohort_id,'instructor',p_instructor_id,'assignments',a_windows,'assessments',e_windows)::text,'sha256'),'hex');
 select * into prior from public.course_activations where cohort_id=p_cohort_id;
 if found then
  if prior.request_hash<>fingerprint then raise exception 'ACTIVATION_CONFLICT'; end if;
  perform course_activation_private.configs(imp);
  return prior.id;
 end if;
 first_version:=not exists(select 1 from public.course_activation_versions where import_id=imp.id);
 if first_version then
  insert into public.course_activation_versions values(imp.id,cv);
  for m in select jsonb_array_elements(imp.raw_package->'modules') loop
   select id into mid from public.modules where programme_version_id=cv and position=(m->>'position')::integer and title=m->>'title';
   if mid is null then raise exception 'PROVENANCE_CONFLICT'; end if;
   for l in select jsonb_array_elements(m->'lessons') loop
    select id into lid from public.lessons where module_id=mid and programme_version_id=cv and position=(l->>'position')::integer and title=l->>'title';
    if lid is null then raise exception 'PROVENANCE_CONFLICT'; end if;
    insert into public.course_activation_lessons values(imp.id,cv,l->>'key',m->>'key',mid,lid);
    for o in select jsonb_array_elements(l->'objectives') loop
     select id into oid from public.lesson_objectives where lesson_id=lid and programme_version_id=cv and position=(o->>'position')::integer and description=o->>'description';
     if oid is null then raise exception 'PROVENANCE_CONFLICT'; end if;
     insert into public.course_activation_objectives values(imp.id,cv,lid,o->>'key',oid);
    end loop;
    if (select count(*) from public.lesson_objectives where lesson_id=lid)<>jsonb_array_length(l->'objectives') then raise exception 'PROVENANCE_CONFLICT'; end if;
    for t in select jsonb_array_elements(l->'practicalActivities') loop
     insert into public.course_practicals(import_id,programme_version_id,lesson_id,local_key,kind,title,instructions,position)
      values(imp.id,cv,lid,t->>'key',t->>'kind',t->>'title',t->>'instructions',(t->>'position')::integer) returning id into rid;
     insert into public.course_practical_objectives select rid,imp.id,lid,cv,b.objective_id from public.course_activation_objectives b where b.import_id=imp.id and b.lesson_id=lid and b.local_key in(select jsonb_array_elements_text(t->'objectiveRefs'));
    end loop;
   end loop;
   if (select count(*) from public.lessons where module_id=mid)<>jsonb_array_length(m->'lessons') then raise exception 'PROVENANCE_CONFLICT'; end if;
  end loop;
  if (select count(*) from public.modules where programme_version_id=cv)<>jsonb_array_length(imp.raw_package->'modules') then raise exception 'PROVENANCE_CONFLICT'; end if;
 end if;
 insert into public.course_activations(import_id,programme_version_id,cohort_id,instructor_id,request_hash,created_by) values(imp.id,cv,p_cohort_id,p_instructor_id,fingerprint,actor) returning id into aid;
 for t in select jsonb_array_elements(imp.raw_package->'assignmentTemplates') loop
  select lesson_id into strict lid from public.course_activation_lessons where import_id=imp.id and local_key=t->>'lessonRef';
  select value into win from jsonb_array_elements(a_windows) where value->>'templateKey'=t->>'key';
  rid:=public.create_assignment(p_cohort_id,lid,p_instructor_id,t->>'title',t->>'instructions',(win->>'opensAt')::timestamptz,(win->>'dueAt')::timestamptz,'Course activation assignment');
  insert into public.course_assignment_bindings values(rid,aid,imp.id,cv,p_cohort_id,lid,t->>'key',(win->>'opensAt')::timestamptz,(win->>'dueAt')::timestamptz);
  insert into public.course_assignment_objectives select rid,imp.id,lid,cv,b.objective_id from public.course_activation_objectives b where b.import_id=imp.id and b.lesson_id=lid and b.local_key in(select jsonb_array_elements_text(t->'objectiveRefs'));
  idx:=0;
  for r in select jsonb_array_elements(t->'rubric') loop idx:=idx+1; insert into public.course_assignment_rubrics values(rid,idx,r->>'description',(r->>'maxMarks')::integer); end loop;
  perform public.change_assignment_status(rid,'PUBLISHED','Course activation publication');
 end loop;
 for t in select jsonb_array_elements(imp.raw_package->'assessmentTemplates') loop
  select lesson_id into strict lid from public.course_activation_lessons where import_id=imp.id and local_key=t->>'lessonRef';
  select value into win from jsonb_array_elements(e_windows) where value->>'templateKey'=t->>'key';
  rid:=public.create_assessment(p_cohort_id,lid,p_instructor_id,t->>'title',t->>'instructions',(win->>'opensAt')::timestamptz,(win->>'closesAt')::timestamptz,(t->>'durationMinutes')::integer,(t->>'attemptsAllowed')::integer,'Course activation assessment');
  insert into public.course_assessment_bindings values(rid,aid,imp.id,cv,p_cohort_id,lid,t->>'key',(win->>'opensAt')::timestamptz,(win->>'closesAt')::timestamptz);
  for q in select jsonb_array_elements(t->'questions') loop
   qid:=public.add_assessment_question(rid,(q->>'position')::integer,q->>'prompt',(q->>'maxMarks')::integer,q->>'expectedAnswer',q->>'markingGuidance','Course activation question');
   select lesson_id into strict objective_lid from public.course_activation_lessons
    where import_id=imp.id and programme_version_id=cv
      and local_key=coalesce(q->>'lessonRef',t->>'lessonRef');
   insert into public.course_assessment_objectives
    (question_id,assessment_id,import_id,lesson_id,programme_version_id,objective_id,objective_lesson_id)
    select qid,rid,imp.id,lid,cv,b.objective_id,objective_lid
    from public.course_activation_objectives b
    where b.import_id=imp.id and b.programme_version_id=cv and b.lesson_id=objective_lid
      and b.local_key in(select jsonb_array_elements_text(q->'objectiveRefs'));
   get diagnostics mapped_count = row_count;
   if mapped_count <> jsonb_array_length(q->'objectiveRefs') then raise exception 'PROVENANCE_CONFLICT'; end if;
  end loop;
  perform public.change_assessment_status(rid,'PUBLISHED','Course activation publication');
 end loop;
 -- Late configuration conflict rolls back all preceding materialisation.
 perform course_activation_private.configs(imp);
 -- The bounded administrative reason supplied at activation time is the
 -- durable institutional rationale for this receipt; it is stored only in
 -- audit_events.reason (never after_state, which stays content-minimised
 -- identifiers/state/counts) and is never rewritten by a later idempotent
 -- replay of this same activation (replay returns above, before this insert
 -- is ever reached again).
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
 values(actor,'COURSE_ACTIVATED','course_activations',aid,'COURSE_ACTIVATION_V1',trim(p_reason),jsonb_build_object('activation_id',aid,'import_id',imp.id,'package_revision',imp.package_revision,'programme_version_id',cv,'cohort_id',p_cohort_id,'instructor_id',p_instructor_id,'state','ACTIVATED','assignment_count',jsonb_array_length(a_windows),'assessment_count',jsonb_array_length(e_windows),'practical_count',(select count(*) from public.course_practicals where import_id=imp.id)));
 return aid;
end $$;

-- CREATE OR REPLACE preserves reviewed ACLs; no new execution grant.
commit;
