-- CP2: interactive examination engine. Additive over the controlled-assessment
-- foundation (016), Commercial V1 policy/results/Examiner chain (029-048) and
-- course activation (027/037). Migrations 001-058 are byte-for-byte unchanged.
--
-- Adds five deterministically scored objective question types alongside the
-- existing FREE_TEXT type: SINGLE_SELECT, MULTIPLE_SELECT, PBQ_MATCHING,
-- PBQ_ORDERING and PBQ_CONFIGURATION. See
-- docs/53-cp2-interactive-examination-engine.md.
--
--   * A question WITHOUT an objective definition is FREE_TEXT, exactly as
--     before. No historical question, response or result is reinterpreted.
--   * The learner-visible definition (assessment_question_interactions) and
--     the protected answer key (assessment_question_objective_keys) are
--     separate tables. No role has any privilege on either; the learner
--     reads definitions only through get_active_assessment_exam_state,
--     gated exactly like get_active_assessment_questions. Keys are read only
--     by the private scorer.
--   * Responses keep using assessment_responses.body (append-only,
--     idempotent, attempt-owned) as canonical JSON text, validated against
--     the published definition before either existing writer runs.
--   * Marks: there is still exactly one grading chain. Every writer of
--     commercial_v1_assessment_question_marks (Examiner initial grade,
--     regrade, recovery, human academic review) is bound by a table guard:
--     an objective question's mark must equal the database scorer's result
--     for the attempt's final response. Examiner provider context no longer
--     contains objective questions; it carries their DB-computed marks
--     instead, so the provider never sees an objective key or response.

create schema assessment_interaction_private;
revoke all on schema assessment_interaction_private from public, anon, authenticated, service_role;

-- ==========================================================================
-- Section 1: pure validation and scoring primitives. Boolean, never raising,
-- never echoing content. Mirrors src/domain/assessment-question-types.ts.
-- ==========================================================================
create function assessment_interaction_private.int_value(p_value jsonb) returns integer
language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return null; end if;
  n := (p_value #>> '{}')::numeric;
  if n <> trunc(n) or n < -2147483648 or n > 2147483647 then return null; end if;
  return n::integer;
end $$;

create function assessment_interaction_private.is_choice_id(p_value jsonb) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^[a-z0-9][a-z0-9_-]{0,39}$', false)
$$;

create function assessment_interaction_private.label_ok(p_value jsonb, p_max integer) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value) = 'string'
    and length(regexp_replace(p_value #>> '{}', '^\s+|\s+$', '', 'g')) between 1 and p_max, false)
$$;

create function assessment_interaction_private.string_in(p_value jsonb, p_allowed text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') = any(p_allowed), false)
$$;

create function assessment_interaction_private.keys_are(p_value jsonb, p_keys text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value) = 'object'
    and (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_value) k)
      = (select array_agg(k order by k) from unnest(p_keys) k), false)
$$;

-- Ids of a bounded choice array ({id,label} objects with unique ids), or
-- NULL when the array is malformed.
create function assessment_interaction_private.choice_ids(p_value jsonb, p_min integer, p_max integer) returns text[]
language plpgsql immutable set search_path='' as $$
declare elem jsonb; result text[] := array[]::text[];
begin
  if jsonb_typeof(p_value) is distinct from 'array'
    or jsonb_array_length(p_value) not between p_min and p_max then return null; end if;
  for elem in select value from jsonb_array_elements(p_value) loop
    if not assessment_interaction_private.keys_are(elem, array['id','label'])
      or not assessment_interaction_private.is_choice_id(elem->'id')
      or not assessment_interaction_private.label_ok(elem->'label', 500)
      or (elem->>'id') = any(result) then return null; end if;
    result := result || (elem->>'id');
  end loop;
  return result;
end $$;

-- A bounded array of choice-id strings (duplicates are the caller's check).
create function assessment_interaction_private.id_array(p_value jsonb, p_min integer, p_max integer) returns text[]
language plpgsql immutable set search_path='' as $$
declare elem jsonb; result text[] := array[]::text[];
begin
  if jsonb_typeof(p_value) is distinct from 'array'
    or jsonb_array_length(p_value) not between p_min and p_max then return null; end if;
  for elem in select value from jsonb_array_elements(p_value) loop
    if not assessment_interaction_private.is_choice_id(elem) then return null; end if;
    result := result || (elem #>> '{}');
  end loop;
  return result;
end $$;

create function assessment_interaction_private.same_set(p_a text[], p_b text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(cardinality(p_a) = cardinality(p_b)
    and (select count(distinct v) from unnest(p_a) v) = cardinality(p_a)
    and p_a <@ p_b and p_b <@ p_a, false)
$$;

create function assessment_interaction_private.field_options(p_definition jsonb, p_field_id text) returns text[]
language sql immutable set search_path='' as $$
  select assessment_interaction_private.choice_ids(f->'options', 2, 10)
  from jsonb_array_elements(p_definition->'fields') f where f->>'id' = p_field_id limit 1
$$;

create function assessment_interaction_private.interaction_is_valid(p_type text, p_definition jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare opts text[]; items text[]; targets text[]; field jsonb; field_ids text[] := array[]::text[]; required integer;
begin
  if jsonb_typeof(p_definition) is distinct from 'object' then return false; end if;
  case p_type
  when 'SINGLE_SELECT' then
    return assessment_interaction_private.keys_are(p_definition, array['options'])
      and assessment_interaction_private.choice_ids(p_definition->'options', 2, 10) is not null;
  when 'MULTIPLE_SELECT' then
    if not assessment_interaction_private.keys_are(p_definition, array['options','requiredSelections','scoringRule'])
      or not assessment_interaction_private.string_in(p_definition->'scoringRule', array['ALL_OR_NOTHING','NET_PROPORTIONAL']) then
      return false;
    end if;
    opts := assessment_interaction_private.choice_ids(p_definition->'options', 3, 12);
    if opts is null then return false; end if;
    if jsonb_typeof(p_definition->'requiredSelections') = 'null' then return true; end if;
    required := assessment_interaction_private.int_value(p_definition->'requiredSelections');
    return coalesce(required between 1 and 11 and required < cardinality(opts), false);
  when 'PBQ_MATCHING' then
    if not assessment_interaction_private.keys_are(p_definition, array['items','targets','allowTargetReuse','scoringRule'])
      or jsonb_typeof(p_definition->'allowTargetReuse') is distinct from 'boolean'
      or not assessment_interaction_private.string_in(p_definition->'scoringRule', array['ALL_OR_NOTHING','PER_ITEM_PROPORTIONAL']) then
      return false;
    end if;
    items := assessment_interaction_private.choice_ids(p_definition->'items', 2, 12);
    targets := assessment_interaction_private.choice_ids(p_definition->'targets', 2, 12);
    if items is null or targets is null then return false; end if;
    return (p_definition->>'allowTargetReuse')::boolean or cardinality(targets) >= cardinality(items);
  when 'PBQ_ORDERING' then
    return assessment_interaction_private.keys_are(p_definition, array['steps','scoringRule'])
      and assessment_interaction_private.string_in(p_definition->'scoringRule', array['ALL_OR_NOTHING','PER_POSITION_PROPORTIONAL'])
      and assessment_interaction_private.choice_ids(p_definition->'steps', 3, 10) is not null;
  when 'PBQ_CONFIGURATION' then
    if not assessment_interaction_private.keys_are(p_definition, array['scenario','fields','scoringRule'])
      or not assessment_interaction_private.label_ok(p_definition->'scenario', 4000)
      or not assessment_interaction_private.string_in(p_definition->'scoringRule', array['ALL_OR_NOTHING','PER_FIELD_PROPORTIONAL'])
      or jsonb_typeof(p_definition->'fields') is distinct from 'array'
      or jsonb_array_length(p_definition->'fields') not between 1 and 12 then
      return false;
    end if;
    for field in select value from jsonb_array_elements(p_definition->'fields') loop
      if not assessment_interaction_private.keys_are(field, array['id','label','options'])
        or not assessment_interaction_private.is_choice_id(field->'id')
        or not assessment_interaction_private.label_ok(field->'label', 500)
        or assessment_interaction_private.choice_ids(field->'options', 2, 10) is null
        or (field->>'id') = any(field_ids) then
        return false;
      end if;
      field_ids := field_ids || (field->>'id');
    end loop;
    return true;
  else
    return false;
  end case;
end $$;

create function assessment_interaction_private.answer_key_is_valid(p_type text, p_definition jsonb, p_key jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare opts text[]; correct text[]; items text[]; targets text[]; steps text[]; field jsonb; field_ids text[] := array[]::text[];
  entry record; required integer;
begin
  if not assessment_interaction_private.interaction_is_valid(p_type, p_definition) then return false; end if;
  case p_type
  when 'SINGLE_SELECT' then
    return assessment_interaction_private.keys_are(p_key, array['correctOptionId'])
      and assessment_interaction_private.string_in(p_key->'correctOptionId',
        assessment_interaction_private.choice_ids(p_definition->'options', 2, 10));
  when 'MULTIPLE_SELECT' then
    if not assessment_interaction_private.keys_are(p_key, array['correctOptionIds']) then return false; end if;
    opts := assessment_interaction_private.choice_ids(p_definition->'options', 3, 12);
    correct := assessment_interaction_private.id_array(p_key->'correctOptionIds', 1, 11);
    if correct is null or (select count(distinct v) from unnest(correct) v) <> cardinality(correct)
      or not (correct <@ opts) or cardinality(correct) >= cardinality(opts) then
      return false;
    end if;
    required := assessment_interaction_private.int_value(p_definition->'requiredSelections');
    return required is null or required = cardinality(correct);
  when 'PBQ_MATCHING' then
    if not assessment_interaction_private.keys_are(p_key, array['mapping'])
      or jsonb_typeof(p_key->'mapping') is distinct from 'object' then return false; end if;
    items := assessment_interaction_private.choice_ids(p_definition->'items', 2, 12);
    targets := assessment_interaction_private.choice_ids(p_definition->'targets', 2, 12);
    if not assessment_interaction_private.same_set(
      (select coalesce(array_agg(k), '{}') from jsonb_object_keys(p_key->'mapping') k), items) then return false; end if;
    for entry in select key, value from jsonb_each(p_key->'mapping') loop
      if not assessment_interaction_private.string_in(entry.value, targets) then return false; end if;
    end loop;
    return (p_definition->>'allowTargetReuse')::boolean
      or (select count(distinct value) from jsonb_each_text(p_key->'mapping')) = cardinality(items);
  when 'PBQ_ORDERING' then
    if not assessment_interaction_private.keys_are(p_key, array['correctOrder']) then return false; end if;
    steps := assessment_interaction_private.choice_ids(p_definition->'steps', 3, 10);
    correct := assessment_interaction_private.id_array(p_key->'correctOrder', 3, 10);
    return correct is not null
      and assessment_interaction_private.same_set(correct, steps)
      and correct is distinct from steps;
  when 'PBQ_CONFIGURATION' then
    if not assessment_interaction_private.keys_are(p_key, array['values'])
      or jsonb_typeof(p_key->'values') is distinct from 'object' then return false; end if;
    for field in select value from jsonb_array_elements(p_definition->'fields') loop
      field_ids := field_ids || (field->>'id');
    end loop;
    if not assessment_interaction_private.same_set(
      (select coalesce(array_agg(k), '{}') from jsonb_object_keys(p_key->'values') k), field_ids) then return false; end if;
    for entry in select key, value from jsonb_each(p_key->'values') loop
      if not assessment_interaction_private.string_in(entry.value,
        assessment_interaction_private.field_options(p_definition, entry.key)) then return false; end if;
    end loop;
    return true;
  else
    return false;
  end case;
end $$;

-- Response validity against the PUBLISHED definition. Never raises: a
-- non-JSON or hostile body is simply invalid.
create function assessment_interaction_private.response_is_valid(p_type text, p_definition jsonb, p_body text) returns boolean
language plpgsql immutable set search_path='' as $$
declare r jsonb; opts text[]; selected text[]; items text[]; targets text[]; steps text[]; entry record; required integer;
begin
  if p_body is null or length(p_body) > 20000 then return false; end if;
  begin
    r := p_body::jsonb;
  exception when others then
    return false;
  end;
  if not assessment_interaction_private.interaction_is_valid(p_type, p_definition) then return false; end if;
  case p_type
  when 'SINGLE_SELECT' then
    return assessment_interaction_private.keys_are(r, array['optionId'])
      and assessment_interaction_private.string_in(r->'optionId',
        assessment_interaction_private.choice_ids(p_definition->'options', 2, 10));
  when 'MULTIPLE_SELECT' then
    if not assessment_interaction_private.keys_are(r, array['optionIds']) then return false; end if;
    opts := assessment_interaction_private.choice_ids(p_definition->'options', 3, 12);
    selected := assessment_interaction_private.id_array(r->'optionIds', 1, 12);
    if selected is null or (select count(distinct v) from unnest(selected) v) <> cardinality(selected)
      or not (selected <@ opts) then return false; end if;
    required := assessment_interaction_private.int_value(p_definition->'requiredSelections');
    return required is null or cardinality(selected) <= required;
  when 'PBQ_MATCHING' then
    if not assessment_interaction_private.keys_are(r, array['matches'])
      or jsonb_typeof(r->'matches') is distinct from 'object'
      or (select count(*) from jsonb_object_keys(r->'matches')) < 1 then return false; end if;
    items := assessment_interaction_private.choice_ids(p_definition->'items', 2, 12);
    targets := assessment_interaction_private.choice_ids(p_definition->'targets', 2, 12);
    for entry in select key, value from jsonb_each(r->'matches') loop
      if not (entry.key = any(items)) or not assessment_interaction_private.string_in(entry.value, targets) then
        return false;
      end if;
    end loop;
    return (p_definition->>'allowTargetReuse')::boolean
      or (select count(distinct value) = count(*) from jsonb_each_text(r->'matches'));
  when 'PBQ_ORDERING' then
    if not assessment_interaction_private.keys_are(r, array['order']) then return false; end if;
    steps := assessment_interaction_private.choice_ids(p_definition->'steps', 3, 10);
    selected := assessment_interaction_private.id_array(r->'order', 3, 10);
    return selected is not null and assessment_interaction_private.same_set(selected, steps);
  when 'PBQ_CONFIGURATION' then
    if not assessment_interaction_private.keys_are(r, array['values'])
      or jsonb_typeof(r->'values') is distinct from 'object'
      or (select count(*) from jsonb_object_keys(r->'values')) < 1 then return false; end if;
    for entry in select key, value from jsonb_each(r->'values') loop
      if not assessment_interaction_private.string_in(entry.value,
        assessment_interaction_private.field_options(p_definition, entry.key)) then return false; end if;
    end loop;
    return true;
  else
    return false;
  end case;
end $$;

-- The documented, institution-selected scoring policy (docs/53 section 4).
-- Integer arithmetic only; proportional rules round DOWN; never negative;
-- never above max marks. An invalid response scores 0.
create function assessment_interaction_private.score_response(
  p_type text, p_definition jsonb, p_key jsonb, p_max_marks integer, p_body text
) returns integer
language plpgsql immutable set search_path='' as $$
declare r jsonb; rule text; correct text[]; selected text[]; right_count integer := 0; wrong_count integer := 0;
  total integer; item jsonb; idx integer;
begin
  if not assessment_interaction_private.response_is_valid(p_type, p_definition, p_body)
    or not assessment_interaction_private.answer_key_is_valid(p_type, p_definition, p_key) then
    return 0;
  end if;
  r := p_body::jsonb;
  rule := coalesce(p_definition->>'scoringRule', 'ALL_OR_NOTHING');
  case p_type
  when 'SINGLE_SELECT' then
    return case when r->>'optionId' = p_key->>'correctOptionId' then p_max_marks else 0 end;
  when 'MULTIPLE_SELECT' then
    correct := assessment_interaction_private.id_array(p_key->'correctOptionIds', 1, 11);
    selected := assessment_interaction_private.id_array(r->'optionIds', 1, 12);
    select count(*) filter (where v = any(correct)), count(*) filter (where not (v = any(correct)))
      into right_count, wrong_count from unnest(selected) v;
    total := cardinality(correct);
    if rule = 'ALL_OR_NOTHING' then
      return case when right_count = total and wrong_count = 0 then p_max_marks else 0 end;
    end if;
    return (p_max_marks * greatest(0, right_count - wrong_count)) / total;
  when 'PBQ_MATCHING' then
    total := jsonb_array_length(p_definition->'items');
    for item in select value from jsonb_array_elements(p_definition->'items') loop
      if r->'matches'->>(item->>'id') is not null
        and r->'matches'->>(item->>'id') = p_key->'mapping'->>(item->>'id') then
        right_count := right_count + 1;
      end if;
    end loop;
  when 'PBQ_ORDERING' then
    total := jsonb_array_length(p_key->'correctOrder');
    for idx in 0..total - 1 loop
      if r->'order'->>idx = p_key->'correctOrder'->>idx then right_count := right_count + 1; end if;
    end loop;
  when 'PBQ_CONFIGURATION' then
    total := jsonb_array_length(p_definition->'fields');
    for item in select value from jsonb_array_elements(p_definition->'fields') loop
      if r->'values'->>(item->>'id') is not null
        and r->'values'->>(item->>'id') = p_key->'values'->>(item->>'id') then
        right_count := right_count + 1;
      end if;
    end loop;
  else
    return 0;
  end case;
  if rule = 'ALL_OR_NOTHING' then
    return case when right_count = total then p_max_marks else 0 end;
  end if;
  return (p_max_marks * right_count) / total;
end $$;

-- ==========================================================================
-- Section 2: the two protected tables. Append-only; insertable only while
-- the parent assessment is DRAFT (so a published definition or key can never
-- change, mirroring migration 016's question/key freeze); validated at the
-- table boundary so even an owner-level insert cannot store a malformed
-- definition or a key that disagrees with its definition.
-- ==========================================================================
create table public.assessment_question_interactions (
  question_id uuid primary key references public.assessment_questions(id),
  assessment_id uuid not null,
  question_type text not null check (question_type in
    ('SINGLE_SELECT','MULTIPLE_SELECT','PBQ_MATCHING','PBQ_ORDERING','PBQ_CONFIGURATION')),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 65536),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (question_id, assessment_id) references public.assessment_questions(id, assessment_id)
);
create index assessment_question_interactions_assessment
  on public.assessment_question_interactions(assessment_id);

create table public.assessment_question_objective_keys (
  question_id uuid primary key references public.assessment_question_interactions(question_id),
  answer_key jsonb not null check (jsonb_typeof(answer_key) = 'object' and pg_column_size(answer_key) <= 16384),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);

create function assessment_interaction_private.guard_interaction() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP <> 'INSERT' then raise exception 'Objective question definitions are append-only'; end if;
  if (select a.status from public.assessment_questions q join public.assessments a on a.id = q.assessment_id
      where q.id = NEW.question_id and q.assessment_id = NEW.assessment_id) is distinct from 'DRAFT' then
    raise exception 'Objective question definitions can only be added to a draft assessment';
  end if;
  if not assessment_interaction_private.interaction_is_valid(NEW.question_type, NEW.definition) then
    raise exception 'OBJECTIVE_DEFINITION_INVALID';
  end if;
  return NEW;
end $$;
create trigger guard_interaction before insert or update or delete on public.assessment_question_interactions
for each row execute function assessment_interaction_private.guard_interaction();

create function assessment_interaction_private.guard_objective_key() returns trigger
language plpgsql set search_path='' as $$
declare i public.assessment_question_interactions;
begin
  if TG_OP <> 'INSERT' then raise exception 'Objective question answer keys are append-only'; end if;
  select * into i from public.assessment_question_interactions where question_id = NEW.question_id;
  if not found or (select a.status from public.assessments a where a.id = i.assessment_id) is distinct from 'DRAFT' then
    raise exception 'Objective question answer keys can only be added to a draft assessment';
  end if;
  if not assessment_interaction_private.answer_key_is_valid(i.question_type, i.definition, NEW.answer_key) then
    raise exception 'OBJECTIVE_KEY_INVALID';
  end if;
  return NEW;
end $$;
create trigger guard_objective_key before insert or update or delete on public.assessment_question_objective_keys
for each row execute function assessment_interaction_private.guard_objective_key();

-- An objective definition never commits without its key. SECURITY DEFINER
-- because a deferred constraint trigger fires at COMMIT, after the definer
-- RPC that inserted the row has returned, i.e. as the calling role (which
-- has no privilege on the key table). It only checks existence and returns
-- nothing. (Found by the real-PostgreSQL concurrency suite; PGlite did not
-- reproduce the deferred-firing role.)
create function assessment_interaction_private.require_objective_key() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists (select 1 from public.assessment_question_objective_keys where question_id = NEW.question_id) then
    raise exception 'OBJECTIVE_KEY_REQUIRED';
  end if;
  return null;
end $$;
create constraint trigger require_objective_key after insert on public.assessment_question_interactions
deferrable initially deferred for each row execute function assessment_interaction_private.require_objective_key();

-- Content-minimised audit: identifiers and type only, never the definition
-- or the key (migration 016's audit_assessment_change strips prompts and
-- expected answers the same way).
create function assessment_interaction_private.audit_objective_definition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id, action, target_type, target_id, reason, before_state, after_state)
  values (
    public.current_app_user(), TG_OP, TG_TABLE_NAME, NEW.question_id,
    coalesce(nullif(current_setting('app.audit_reason', true), ''), 'Governed objective assessment question'),
    null, to_jsonb(NEW) - 'definition' - 'answer_key'
  );
  return NEW;
end $$;
create trigger audit_change after insert on public.assessment_question_interactions
for each row execute function assessment_interaction_private.audit_objective_definition();
create trigger audit_change after insert on public.assessment_question_objective_keys
for each row execute function assessment_interaction_private.audit_objective_definition();

-- The authoritative mark for one objective question of one attempt: the
-- score of the attempt's FINAL saved response (responses are accepted only
-- while the attempt is ACTIVE, so the final revision is the submitted
-- answer), or 0 when unanswered. NULL for a FREE_TEXT question.
create function assessment_interaction_private.objective_marks(p_attempt_id uuid, p_question_id uuid) returns integer
language plpgsql stable set search_path='' as $$
declare i public.assessment_question_interactions; k jsonb; max_marks integer; latest text;
begin
  select * into i from public.assessment_question_interactions where question_id = p_question_id;
  if not found then return null; end if;
  select answer_key into k from public.assessment_question_objective_keys where question_id = p_question_id;
  select q.max_marks into max_marks from public.assessment_questions q where q.id = p_question_id;
  select body into latest from public.assessment_responses
    where attempt_id = p_attempt_id and question_id = p_question_id
    order by revision_number desc limit 1;
  if not found then return 0; end if;
  return assessment_interaction_private.score_response(i.question_type, i.definition, k, max_marks, latest);
end $$;

-- ==========================================================================
-- Section 3: one grading chain, deterministic objective marks. A BEFORE
-- INSERT guard on the single per-question mark table binds every existing
-- and future result writer (031/036 initial grade, 032 regrade, 040
-- recovery, 047 human review). A writer that disagrees with the scorer
-- fails; the Examiner FINALIZE handler already converts that into a durable
-- FAILED/RESULT_INTEGRITY_FAILED execution with no partial result.
-- ==========================================================================
create function assessment_interaction_private.guard_objective_question_mark() returns trigger
language plpgsql set search_path='' as $$
declare attempt uuid; expected integer;
begin
  select attempt_id into attempt from public.commercial_v1_assessment_result_revisions where id = NEW.result_revision_id;
  expected := assessment_interaction_private.objective_marks(attempt, NEW.question_id);
  if expected is not null and NEW.marks_awarded <> expected then
    raise exception 'OBJECTIVE_MARKS_MISMATCH';
  end if;
  return NEW;
end $$;
create trigger guard_objective_question_mark before insert on public.commercial_v1_assessment_question_marks
for each row execute function assessment_interaction_private.guard_objective_question_mark();

-- ==========================================================================
-- Section 4: governed authoring, learner release and response validation.
-- ==========================================================================
create function assessment_interaction_private.attach(
  p_question_id uuid, p_assessment_id uuid, p_type text, p_definition jsonb, p_key jsonb, p_actor uuid
) returns void
language plpgsql set search_path='' as $$
begin
  insert into public.assessment_question_interactions(question_id, assessment_id, question_type, definition, created_by)
  values (p_question_id, p_assessment_id, p_type, p_definition, p_actor);
  insert into public.assessment_question_objective_keys(question_id, answer_key, created_by)
  values (p_question_id, p_key, p_actor);
end $$;

-- Manual authoring: reuses add_assessment_question for authority (admin or
-- the assigned instructor), DRAFT-only, bounds and audit, then attaches the
-- validated definition and key in the same transaction. Errors never echo
-- submitted content.
create function public.add_objective_assessment_question(
  p_assessment_id uuid, p_position integer, p_prompt text, p_max_marks integer,
  p_question_type text, p_interaction jsonb, p_answer_key jsonb,
  p_expected_answer text, p_marking_guidance text, p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; qid uuid;
begin
  actor := public.current_app_user();
  if actor is null then raise exception 'Access denied' using errcode = '42501'; end if;
  if p_question_type is null or p_question_type not in
    ('SINGLE_SELECT','MULTIPLE_SELECT','PBQ_MATCHING','PBQ_ORDERING','PBQ_CONFIGURATION') then
    raise exception 'Unsupported objective question type';
  end if;
  if not assessment_interaction_private.interaction_is_valid(p_question_type, p_interaction) then
    raise exception 'Objective question interaction is invalid';
  end if;
  if not assessment_interaction_private.answer_key_is_valid(p_question_type, p_interaction, p_answer_key) then
    raise exception 'Objective question answer key is invalid';
  end if;
  qid := public.add_assessment_question(p_assessment_id, p_position, p_prompt, p_max_marks,
    p_expected_answer, p_marking_guidance, p_reason);
  perform assessment_interaction_private.attach(qid, p_assessment_id, p_question_type, p_interaction, p_answer_key, actor);
  return qid;
end $$;

-- Learner release: exactly the gate of get_active_assessment_questions
-- (STUDENT, published, inside the window, own unexpired ACTIVE attempt,
-- commercial access not revoked), evaluated first and raising on refusal.
-- Then, for the caller's OWN active attempt only, each question's type,
-- learner-visible definition (never the key) and the caller's latest saved
-- answer, so a refreshed page resumes exactly. FREE_TEXT questions have a
-- NULL definition.
create function public.get_active_assessment_exam_state(p_assessment_id uuid)
returns table(question_id uuid, question_type text, definition jsonb, saved_body text, revision_count integer)
language plpgsql security definer set search_path='' as $$
declare attempt uuid;
begin
  perform 1 from public.get_active_assessment_questions(p_assessment_id);
  select t.id into attempt from public.assessment_attempts t
  where t.assessment_id = p_assessment_id and t.student_id = public.current_app_user() and t.state = 'ACTIVE';
  if not found then raise exception 'Protected assessment content requires an active attempt'; end if;
  return query
  select q.id, coalesce(i.question_type, 'FREE_TEXT'), i.definition, latest.body,
    (select count(*)::integer from public.assessment_responses r where r.attempt_id = attempt and r.question_id = q.id)
  from public.assessment_questions q
  left join public.assessment_question_interactions i on i.question_id = q.id
  left join lateral (
    select r.body from public.assessment_responses r
    where r.attempt_id = attempt and r.question_id = q.id
    order by r.revision_number desc limit 1
  ) latest on true
  where q.assessment_id = p_assessment_id
  order by q.position;
end $$;

-- Staff authoring view: same authority as list_assessment_authoring_questions.
create function public.list_assessment_authoring_interactions(p_assessment_id uuid)
returns table(question_id uuid, question_type text, definition jsonb)
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.list_assessment_authoring_questions(p_assessment_id);
  return query
  select i.question_id, i.question_type, i.definition
  from public.assessment_question_interactions i
  join public.assessment_questions q on q.id = i.question_id
  where q.assessment_id = p_assessment_id
  order by q.position;
end $$;

-- True unless this is the caller's own attempt, the question is an
-- objective question of that attempt's assessment, and the body is invalid.
-- Every other case is left to the original writer's own (unchanged)
-- ownership/state/deadline errors, so nothing new is revealed.
create function assessment_interaction_private.response_acceptable(p_attempt_id uuid, p_question_id uuid, p_body text)
returns boolean
language plpgsql stable security definer set search_path='' as $$
declare i public.assessment_question_interactions;
begin
  select ii.* into i
  from public.assessment_question_interactions ii
  join public.assessment_attempts t on t.assessment_id = ii.assessment_id
  where ii.question_id = p_question_id and t.id = p_attempt_id and t.student_id = public.current_app_user();
  if not found then return true; end if;
  return assessment_interaction_private.response_is_valid(i.question_type, i.definition, trim(p_body));
end $$;

-- Migration 045's public wrappers, re-created with one added check before
-- the unchanged private writers run.
create or replace function public.record_assessment_response(p_attempt_id uuid,p_question_id uuid,p_body text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  perform commercial_v1_commerce_private.require_attempt_access(p_attempt_id);
  if not assessment_interaction_private.response_acceptable(p_attempt_id, p_question_id, p_body) then
    raise exception 'A valid structured assessment response is required';
  end if;
  return commercial_v1_commerce_private.record_assessment_response(p_attempt_id,p_question_id,p_body,p_idempotency_key);
end $$;

create or replace function public.record_commercial_v1_assessment_response(p_attempt_id uuid,p_question_id uuid,p_body text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform commercial_v1_commerce_private.require_attempt_access(p_attempt_id);
  if not assessment_interaction_private.response_acceptable(p_attempt_id, p_question_id, p_body) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  end if;
  return commercial_v1_commerce_private.record_commercial_v1_assessment_response(p_attempt_id,p_question_id,p_body,p_idempotency_key);
end $$;

-- ==========================================================================
-- Section 5: Examiner provider context. The three context-returning
-- functions are moved, unchanged, behind same-signature wrappers. For a
-- successful assessment context the wrapper removes objective questions
-- from `questions` (the provider never sees their prompt, key or response)
-- and adds their DB-computed `objectiveMarks` plus `objectiveQuestionCount`.
-- Free-text questions are passed through byte-for-byte; every other result
-- (lab context, lifecycle projections, refusals) is returned untouched.
-- ==========================================================================
create function assessment_interaction_private.examiner_context(p_result jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare attempt uuid; free_text jsonb; marks jsonb; objective_count integer;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result->>'ok') is distinct from 'true'
    or jsonb_typeof(p_result->'questions') is distinct from 'array' or not (p_result ? 'attemptId') then
    return p_result;
  end if;
  attempt := (p_result->>'attemptId')::uuid;
  select coalesce(jsonb_agg(q order by o), '[]'::jsonb) into free_text
  from jsonb_array_elements(p_result->'questions') with ordinality x(q, o)
  where not exists (select 1 from public.assessment_question_interactions i where i.question_id = (q->>'questionId')::uuid);
  select coalesce(jsonb_agg(jsonb_build_object(
      'questionId', q->>'questionId',
      'marksAwarded', assessment_interaction_private.objective_marks(attempt, (q->>'questionId')::uuid)
    ) order by o), '[]'::jsonb) into marks
  from jsonb_array_elements(p_result->'questions') with ordinality x(q, o)
  where exists (select 1 from public.assessment_question_interactions i where i.question_id = (q->>'questionId')::uuid);
  select count(*)::integer into objective_count
  from public.assessment_question_interactions i
  join public.assessment_attempts t on t.assessment_id = i.assessment_id
  where t.id = attempt;
  return p_result || jsonb_build_object('questions', free_text, 'objectiveMarks', marks, 'objectiveQuestionCount', objective_count);
end $$;

alter function public.get_commercial_v1_examiner_assessment_context(uuid,uuid,uuid,uuid,uuid,bigint,bigint,text)
  set schema assessment_interaction_private;
create function public.get_commercial_v1_examiner_assessment_context(
  p_key_id uuid,p_execution_id uuid,p_attempt_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_issued_at bigint,p_expires_at bigint,p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  return assessment_interaction_private.examiner_context(
    assessment_interaction_private.get_commercial_v1_examiner_assessment_context(
      p_key_id,p_execution_id,p_attempt_id,p_enrolment_id,p_activation_id,p_issued_at,p_expires_at,p_mac));
end $$;

alter function public.govern_commercial_v1_examiner_regrade(
  uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) set schema assessment_interaction_private;
create function public.govern_commercial_v1_examiner_regrade(p_key_id uuid,p_execution_id uuid,p_source_id uuid,p_request_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,p_assessment_marks jsonb,p_lab_marks_awarded integer)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return assessment_interaction_private.examiner_context(
    assessment_interaction_private.govern_commercial_v1_examiner_regrade(p_key_id,p_execution_id,p_source_id,p_request_reason,p_capability,p_target_kind,
      p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,
      p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
      p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,
      p_grade_digest,p_issued_at,p_expires_at,p_mac,p_assessment_marks,p_lab_marks_awarded));
end $$;

alter function public.govern_commercial_v1_examiner_recovery(
  uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,bigint,
  integer,integer,integer,integer,bigint,integer,text,bigint,bigint,text,jsonb,integer
) set schema assessment_interaction_private;
create function public.govern_commercial_v1_examiner_recovery(
  p_key_id uuid,p_execution_id uuid,p_source_execution_id uuid,p_recovery_reason text,p_capability text,p_target_kind text,
  p_student_id uuid,p_attempt_id uuid,p_submission_id uuid,p_enrolment_id uuid,p_activation_id uuid,
  p_operation text,p_state text,p_reason text,p_budget_stage text,
  p_max_calls integer,p_max_output integer,p_max_cost bigint,
  p_calls integer,p_attempts integer,p_input integer,p_output integer,p_cost bigint,p_elapsed integer,
  p_grade_digest text,p_issued_at bigint,p_expires_at bigint,p_mac text,p_assessment_marks jsonb,p_lab_marks_awarded integer
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return assessment_interaction_private.examiner_context(
    assessment_interaction_private.govern_commercial_v1_examiner_recovery(p_key_id,p_execution_id,p_source_execution_id,p_recovery_reason,p_capability,p_target_kind,
      p_student_id,p_attempt_id,p_submission_id,p_enrolment_id,p_activation_id,
      p_operation,p_state,p_reason,p_budget_stage,p_max_calls,p_max_output,p_max_cost,
      p_calls,p_attempts,p_input,p_output,p_cost,p_elapsed,
      p_grade_digest,p_issued_at,p_expires_at,p_mac,p_assessment_marks,p_lab_marks_awarded));
end $$;

-- Human academic review (047): annotate each question with its objective
-- definition and locked deterministic mark (staff reviewers only; the
-- original's reviewer authority and self-review refusal run first).
alter function public.get_commercial_v1_academic_review_case(uuid) set schema assessment_interaction_private;
create function public.get_commercial_v1_academic_review_case(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; attempt uuid;
begin
  result := assessment_interaction_private.get_commercial_v1_academic_review_case(p_case_id);
  if jsonb_typeof(result->'assessment') is distinct from 'object'
    or jsonb_typeof(result->'assessment'->'questions') is distinct from 'array' then
    return result;
  end if;
  select c.attempt_id into attempt from commercial_v1_review_private.open_cases c where c.case_id = p_case_id;
  return jsonb_set(result, '{assessment,questions}', (
    select coalesce(jsonb_agg(q || jsonb_build_object('objective', (
        select jsonb_build_object('questionType', i.question_type, 'interaction', i.definition,
          'deterministicMarks', assessment_interaction_private.objective_marks(attempt, i.question_id))
        from public.assessment_question_interactions i where i.question_id = (q->>'questionId')::uuid
      )) order by o), '[]'::jsonb)
    from jsonb_array_elements(result->'assessment'->'questions') with ordinality x(q, o)));
end $$;

-- ==========================================================================
-- Section 6: COURSE_PACKAGE_V1 additive question extension. The live 037
-- validator is retained unchanged under a new name and receives the package
-- with only the three extension keys removed, so every legacy package is
-- checked exactly as before; the extension is then validated on its own.
-- ==========================================================================
create function course_engineering_private.without_objective_question_extensions(p_package jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_package->'assessmentTemplates') = 'array' then
    jsonb_set(p_package, '{assessmentTemplates}', coalesce((
      select jsonb_agg(case
        when jsonb_typeof(t) = 'object' and jsonb_typeof(t->'questions') = 'array' then
          jsonb_set(t, '{questions}', coalesce((
            select jsonb_agg(case when jsonb_typeof(q) = 'object'
              then q - 'questionType' - 'interaction' - 'answerKey' else q end order by qo)
            from jsonb_array_elements(t->'questions') with ordinality qx(q, qo)), '[]'::jsonb))
        else t end order by tord)
      from jsonb_array_elements(p_package->'assessmentTemplates') with ordinality tx(t, tord)), '[]'::jsonb))
  else p_package end
$$;

create function course_engineering_private.assert_objective_question_extensions(p_package jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare t jsonb; q jsonb; question_type text;
begin
  if jsonb_typeof(p_package->'assessmentTemplates') is distinct from 'array' then return; end if;
  for t in select value from jsonb_array_elements(p_package->'assessmentTemplates') loop
    continue when jsonb_typeof(t) is distinct from 'object' or jsonb_typeof(t->'questions') is distinct from 'array';
    for q in select value from jsonb_array_elements(t->'questions') loop
      continue when jsonb_typeof(q) is distinct from 'object';
      if q ? 'questionType' then
        if not assessment_interaction_private.string_in(q->'questionType', array[
          'FREE_TEXT','SINGLE_SELECT','MULTIPLE_SELECT','PBQ_MATCHING','PBQ_ORDERING','PBQ_CONFIGURATION']) then
          raise exception 'An objective question type is unsupported';
        end if;
        question_type := q->>'questionType';
      else
        question_type := 'FREE_TEXT';
      end if;
      if question_type = 'FREE_TEXT' then
        if q ? 'interaction' or q ? 'answerKey' then
          raise exception 'An objective question extension is not permitted on a free-text question';
        end if;
      else
        if not (q ? 'interaction') or not (q ? 'answerKey') then
          raise exception 'An objective question requires an interaction and an answer key';
        end if;
        if not assessment_interaction_private.interaction_is_valid(question_type, q->'interaction') then
          raise exception 'An objective question interaction is invalid';
        end if;
        if not assessment_interaction_private.answer_key_is_valid(question_type, q->'interaction', q->'answerKey') then
          raise exception 'An objective question answer key is invalid';
        end if;
      end if;
    end loop;
  end loop;
end $$;

alter function course_engineering_private.assert_full_package_valid(text,integer,text,jsonb)
  rename to assert_full_package_valid_v037;
create function course_engineering_private.assert_full_package_valid(
  p_package_key text, p_package_revision integer, p_schema_version text, p_package jsonb
) returns void
language plpgsql set search_path='' as $$
begin
  perform course_engineering_private.assert_full_package_valid_v037(p_package_key, p_package_revision, p_schema_version,
    course_engineering_private.without_objective_question_extensions(p_package));
  perform course_engineering_private.assert_objective_question_extensions(p_package);
end $$;

-- Preview redaction (024) additionally strips the protected answerKey.
create or replace function course_engineering_private.redact_answer_keys(p_package jsonb) returns jsonb
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
            select jsonb_agg(question - 'expectedAnswer' - 'markingGuidance' - 'answerKey')
            from jsonb_array_elements(template->'questions') as question
          ), '[]'::jsonb)
        )
      )
      from jsonb_array_elements(p_package->'assessmentTemplates') as template
    ), '[]'::jsonb)
  )
$$;

-- ==========================================================================
-- Section 7: course activation. Migration 037's activate_course_package,
-- re-created verbatim except for the three lines that attach an objective
-- question's validated definition and key immediately after
-- add_assessment_question (still DRAFT, before publication). CREATE OR
-- REPLACE preserves the reviewed ACL.
-- ==========================================================================
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
   if coalesce(q->>'questionType','FREE_TEXT')<>'FREE_TEXT' then
    perform assessment_interaction_private.attach(qid,rid,q->>'questionType',q->'interaction',q->'answerKey',actor);
   end if;
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

-- ==========================================================================
-- Section 8: ACLs. Deny by default; assert the effective result (including
-- Supabase-style broad defaults for service_role), mirroring 029/031/040.
-- ==========================================================================
do $$ declare t regclass; cols text; f regprocedure; begin
  foreach t in array array['public.assessment_question_interactions'::regclass,'public.assessment_question_objective_keys'::regclass] loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on table %s from public, anon, authenticated, service_role', t);
    select string_agg(quote_ident(attname), ',') into cols from pg_attribute where attrelid = t and attnum > 0 and not attisdropped;
    execute format('revoke select(%s), insert(%s), update(%s), references(%s) on %s from public, anon, authenticated, service_role', cols, cols, cols, cols, t);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'assessment_interaction_private'
       or (n.nspname = 'course_engineering_private' and p.proname in
         ('assert_full_package_valid','assert_full_package_valid_v037','without_objective_question_extensions',
          'assert_objective_question_extensions','redact_answer_keys'))
       or (n.nspname = 'public' and p.proname in
         ('add_objective_assessment_question','get_active_assessment_exam_state','list_assessment_authoring_interactions',
          'record_assessment_response','record_commercial_v1_assessment_response',
          'get_commercial_v1_examiner_assessment_context','govern_commercial_v1_examiner_regrade',
          'govern_commercial_v1_examiner_recovery','get_commercial_v1_academic_review_case')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('add_objective_assessment_question','get_active_assessment_exam_state','list_assessment_authoring_interactions',
       'record_assessment_response','record_commercial_v1_assessment_response',
       'get_commercial_v1_examiner_assessment_context','govern_commercial_v1_examiner_regrade',
       'govern_commercial_v1_examiner_recovery','get_commercial_v1_academic_review_case') loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

do $$ declare r text; t regclass; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['public.assessment_question_interactions'::regclass,'public.assessment_question_objective_keys'::regclass] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe objective assessment table privileges for %', r;
      end if;
    end loop;
    if has_schema_privilege(r, 'assessment_interaction_private', 'USAGE,CREATE') then
      raise exception 'Unsafe objective assessment schema privileges for %', r;
    end if;
    for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'assessment_interaction_private'
         or (n.nspname = 'course_engineering_private' and p.proname in
           ('assert_full_package_valid','assert_full_package_valid_v037','without_objective_question_extensions',
            'assert_objective_question_extensions','redact_answer_keys'))
         or (n.nspname = 'public' and p.proname in
           ('add_objective_assessment_question','get_active_assessment_exam_state','list_assessment_authoring_interactions',
            'record_assessment_response','record_commercial_v1_assessment_response',
            'get_commercial_v1_examiner_assessment_context','govern_commercial_v1_examiner_regrade',
            'govern_commercial_v1_examiner_recovery','get_commercial_v1_academic_review_case')) loop
      if has_function_privilege(r, f.oid, 'EXECUTE') is distinct from (r = 'authenticated' and f.nspname = 'public') then
        raise exception 'Unsafe objective assessment function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
