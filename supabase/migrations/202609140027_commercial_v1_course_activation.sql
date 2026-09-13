-- Course activation is a transaction over existing Academy OS authoring authorities.
create schema course_activation_private;
revoke all on schema course_activation_private from public,anon,authenticated,service_role;
alter table public.lesson_objectives add constraint activation_objective_identity unique(id,lesson_id,programme_version_id);
alter table public.assignments add constraint activation_assignment_identity unique(id,lesson_id,programme_version_id,cohort_id);
alter table public.assessments add constraint activation_assessment_identity unique(id,lesson_id,programme_version_id,cohort_id);
alter table public.course_package_imports add constraint activation_import_identity unique(id,programme_version_id);
alter table public.lessons add constraint activation_lesson_identity unique(id,module_id,programme_version_id);
create table public.course_activation_versions (
 import_id uuid primary key references public.course_package_imports(id),
 programme_version_id uuid not null unique references public.programme_versions(id),
 unique(import_id,programme_version_id),
 foreign key(import_id,programme_version_id) references public.course_package_imports(id,programme_version_id)
);
create table public.course_activation_lessons (
 import_id uuid not null, programme_version_id uuid not null, local_key text not null,
 module_key text not null, module_id uuid not null, lesson_id uuid not null,
 primary key(import_id,local_key), unique(import_id,lesson_id,programme_version_id),
 foreign key(import_id,programme_version_id) references public.course_activation_versions(import_id,programme_version_id),
 foreign key(module_id,programme_version_id) references public.modules(id,programme_version_id),
 foreign key(lesson_id,module_id,programme_version_id) references public.lessons(id,module_id,programme_version_id),
 foreign key(lesson_id,programme_version_id) references public.lessons(id,programme_version_id)
);
-- COURSE_PACKAGE_V1 scopes objective keys to their owning lesson (two
-- different lessons may both legitimately declare local key "obj-1"), so
-- identity here is lesson-scoped -- never (import_id, local_key) alone,
-- which would incorrectly collide across lessons within the same import.
create table public.course_activation_objectives (
 import_id uuid not null, programme_version_id uuid not null, lesson_id uuid not null,
 local_key text not null, objective_id uuid not null,
 primary key(import_id,lesson_id,local_key), unique(import_id,objective_id,lesson_id,programme_version_id),
 foreign key(import_id,lesson_id,programme_version_id) references public.course_activation_lessons(import_id,lesson_id,programme_version_id),
 foreign key(objective_id,lesson_id,programme_version_id) references public.lesson_objectives(id,lesson_id,programme_version_id)
);
create table public.course_activations (
 id uuid primary key default gen_random_uuid(), import_id uuid not null, programme_version_id uuid not null,
 cohort_id uuid not null unique, instructor_id uuid not null references public.staff_profiles(user_id),
 request_hash text not null check(length(request_hash)=64), state text not null default 'ACTIVATED' check(state='ACTIVATED'),
 created_by uuid not null references public.app_users(id), created_at timestamptz not null default clock_timestamp(),
 foreign key(import_id,programme_version_id) references public.course_activation_versions(import_id,programme_version_id),
 foreign key(cohort_id,programme_version_id) references public.cohorts(id,programme_version_id),
 unique(id,import_id,programme_version_id,cohort_id)
);
-- Practical-activity keys are likewise lesson-scoped in COURSE_PACKAGE_V1
-- (two different lessons may both declare local key "lab"), so uniqueness
-- here is (import_id, lesson_id, local_key) -- never (import_id, local_key)
-- alone.
create table public.course_practicals (
 id uuid primary key default gen_random_uuid(), import_id uuid not null, programme_version_id uuid not null,
 lesson_id uuid not null, local_key text not null, kind text not null check(kind in ('EXERCISE','PRACTICAL_LAB')),
 title text not null check(length(title) between 1 and 200), instructions text not null check(length(instructions) between 1 and 12000),
 position integer not null check(position between 1 and 10000),
 unique(import_id,lesson_id,local_key), unique(import_id,lesson_id,position), unique(id,import_id,lesson_id,programme_version_id),
 foreign key(import_id,lesson_id,programme_version_id) references public.course_activation_lessons(import_id,lesson_id,programme_version_id)
);
create table public.course_practical_objectives (
 practical_id uuid not null, import_id uuid not null, lesson_id uuid not null, programme_version_id uuid not null, objective_id uuid not null,
 primary key(practical_id,objective_id),
 foreign key(practical_id,import_id,lesson_id,programme_version_id) references public.course_practicals(id,import_id,lesson_id,programme_version_id),
 foreign key(import_id,objective_id,lesson_id,programme_version_id) references public.course_activation_objectives(import_id,objective_id,lesson_id,programme_version_id)
);
create table public.course_assignment_bindings (
 assignment_id uuid primary key, activation_id uuid not null, import_id uuid not null, programme_version_id uuid not null,
 cohort_id uuid not null, lesson_id uuid not null, template_key text not null,
 opens_at timestamptz not null, due_at timestamptz not null check(due_at>opens_at),
 unique(activation_id,template_key), unique(assignment_id,import_id,lesson_id,programme_version_id),
 foreign key(activation_id,import_id,programme_version_id,cohort_id) references public.course_activations(id,import_id,programme_version_id,cohort_id),
 foreign key(assignment_id,lesson_id,programme_version_id,cohort_id) references public.assignments(id,lesson_id,programme_version_id,cohort_id),
 foreign key(import_id,lesson_id,programme_version_id) references public.course_activation_lessons(import_id,lesson_id,programme_version_id)
);
create table public.course_assignment_objectives (
 assignment_id uuid not null, import_id uuid not null, lesson_id uuid not null, programme_version_id uuid not null, objective_id uuid not null,
 primary key(assignment_id,objective_id),
 foreign key(assignment_id,import_id,lesson_id,programme_version_id) references public.course_assignment_bindings(assignment_id,import_id,lesson_id,programme_version_id),
 foreign key(import_id,objective_id,lesson_id,programme_version_id) references public.course_activation_objectives(import_id,objective_id,lesson_id,programme_version_id)
);
create table public.course_assignment_rubrics (
 assignment_id uuid not null references public.course_assignment_bindings(assignment_id),
 criterion integer not null check(criterion between 1 and 50), description text not null check(length(description) between 1 and 500),
 max_marks integer not null check(max_marks between 1 and 100), primary key(assignment_id,criterion)
);
create table public.course_assessment_bindings (
 assessment_id uuid primary key, activation_id uuid not null, import_id uuid not null, programme_version_id uuid not null,
 cohort_id uuid not null, lesson_id uuid not null, template_key text not null,
 opens_at timestamptz not null, closes_at timestamptz not null check(closes_at>opens_at),
 unique(activation_id,template_key), unique(assessment_id,import_id,lesson_id,programme_version_id),
 foreign key(activation_id,import_id,programme_version_id,cohort_id) references public.course_activations(id,import_id,programme_version_id,cohort_id),
 foreign key(assessment_id,lesson_id,programme_version_id,cohort_id) references public.assessments(id,lesson_id,programme_version_id,cohort_id),
 foreign key(import_id,lesson_id,programme_version_id) references public.course_activation_lessons(import_id,lesson_id,programme_version_id)
);
create table public.course_assessment_objectives (
 question_id uuid not null, assessment_id uuid not null, import_id uuid not null, lesson_id uuid not null, programme_version_id uuid not null, objective_id uuid not null,
 primary key(question_id,objective_id),
 foreign key(question_id,assessment_id) references public.assessment_questions(id,assessment_id),
 foreign key(assessment_id,import_id,lesson_id,programme_version_id) references public.course_assessment_bindings(assessment_id,import_id,lesson_id,programme_version_id),
 foreign key(import_id,objective_id,lesson_id,programme_version_id) references public.course_activation_objectives(import_id,objective_id,lesson_id,programme_version_id)
);
create function course_activation_private.immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Activation history is immutable'; end $$;
create function course_activation_private.require_admin() returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); begin
 if actor is null or not(public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 return actor;
end $$;
-- Serialize existing config authoring with activation, including the no-row case.
create function course_activation_private.lock_config_version() returns trigger language plpgsql security definer set search_path='' as $$
begin perform 1 from public.programme_versions where id=NEW.programme_version_id for update; return NEW; end $$;
create trigger activation_config_serialization before insert or update on public.academic_agent_configs for each row execute function course_activation_private.lock_config_version();
create function course_activation_private.configs(p_import public.course_package_imports) returns void language plpgsql security definer set search_path='' as $$
declare role_name text; c jsonb; prior public.academic_agent_configs; caps text[]; begin
 foreach role_name in array array['PROFESSOR','TUTOR','LAB_INSTRUCTOR','EXAMINER','COUNSELLOR'] loop
  c:=p_import.raw_package->'agentConfiguration'->role_name;
  caps:=array(select jsonb_array_elements_text(c->'capabilities') order by 1);
  select * into prior from public.academic_agent_configs where programme_version_id=p_import.programme_version_id and role=role_name;
  if found then
   if prior.enabled is distinct from (c->>'enabled')::boolean or prior.model_profile_ref is distinct from c->>'modelProfileRef'
    or prior.instructional_notes is distinct from nullif(trim(c->>'instructionalNotes'),'') or prior.escalation_policy<>c->>'escalationPolicy'
    or array(select unnest(prior.capabilities) order by 1)<>caps then raise exception 'CONFIG_CONFLICT'; end if;
  else
   perform public.set_agent_config(p_import.programme_version_id,role_name,(c->>'enabled')::boolean,c->>'modelProfileRef',nullif(trim(c->>'instructionalNotes'),''),caps,c->>'escalationPolicy','Course activation configuration');
  end if;
 end loop;
end $$;
-- Strict typed JSON array only for explicit schedule bindings. No content or arbitrary payload.
create function course_activation_private.schedule(p_rows jsonb,p_templates jsonb,p_end text) returns jsonb language plpgsql set search_path='' as $$
declare x jsonb; a timestamptz; b timestamptz; result jsonb:='[]'; begin
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>250 then raise exception 'INVALID_INPUT'; end if;
 if jsonb_array_length(p_rows)<>jsonb_array_length(p_templates) then raise exception 'TEMPLATE_MISMATCH'; end if;
 for x in select value from jsonb_array_elements(p_rows) order by value->>'templateKey' loop
  if jsonb_typeof(x)<>'object' or (select count(*) from jsonb_object_keys(x))<>3 or not(x ?& array['templateKey','opensAt',p_end])
   or jsonb_typeof(x->'templateKey')<>'string' or not exists(select 1 from jsonb_array_elements(p_templates) t where t->>'key'=x->>'templateKey')
   or exists(select 1 from jsonb_array_elements(result) t where t->>'templateKey'=x->>'templateKey') then raise exception 'TEMPLATE_MISMATCH'; end if;
  if jsonb_typeof(x->'opensAt')<>'string' or jsonb_typeof(x->p_end)<>'string'
   or (x->>'opensAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
   or (x->>p_end) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'INVALID_INPUT'; end if;
  begin a:=(x->>'opensAt')::timestamptz; b:=(x->>p_end)::timestamptz; exception when others then raise exception 'INVALID_INPUT'; end;
  if not isfinite(a) or not isfinite(b) or a>=b then raise exception 'INVALID_INPUT'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('templateKey',x->>'templateKey','opensAt',a,p_end,b));
 end loop;
 return result;
end $$;
create function public.activate_course_package(p_import_id uuid,p_cohort_id uuid,p_instructor_id uuid,p_assignments jsonb,p_assessments jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; imp public.course_package_imports; prior public.course_activations; cv uuid; aid uuid; lid uuid; mid uuid; oid uuid; rid uuid; qid uuid;
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
   insert into public.course_assessment_objectives select qid,rid,imp.id,lid,cv,b.objective_id from public.course_activation_objectives b where b.import_id=imp.id and b.lesson_id=lid and b.local_key in(select jsonb_array_elements_text(q->'objectiveRefs'));
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
create function course_activation_private.student_enrolment(p_id uuid) returns public.enrolments language plpgsql security definer set search_path='' as $$
declare e public.enrolments; actor uuid:=public.current_app_user(); begin
 if actor is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 perform 1 from public.student_profiles where user_id=actor for update;
 select * into e from public.enrolments where id=p_id and student_id=actor;
 if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 return e;
end $$;
create function public.list_practical_enrolments() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if public.current_app_user() is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN'; end if;
 return (select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',e.id,'title',e.cohort_title_snapshot,'status',e.status) item from public.enrolments e where student_id=public.current_app_user() order by e.id limit 100) v);
end $$;
create function public.list_my_practicals(p_enrolment_id uuid,p_cursor integer default 0) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.enrolments; begin
 e:=course_activation_private.student_enrolment(p_enrolment_id);
 if p_cursor is null or p_cursor<0 or p_cursor>62500 then raise exception 'INVALID_INPUT'; end if;
 perform public.assert_academic_action_allowed('EXPLAIN');
 return (select coalesce(jsonb_agg(v.item),'[]') from (
  select jsonb_build_object('id',p.id,'lessonId',p.lesson_id,'kind',p.kind,'title',p.title,'instructions',p.instructions,'position',p.position,
   'objectiveIds',(select jsonb_agg(objective_id order by objective_id) from public.course_practical_objectives where practical_id=p.id)) item
  from public.course_practicals p where p.programme_version_id=e.programme_version_id
   and exists(select 1 from public.course_activations a where a.import_id=p.import_id and a.cohort_id=e.cohort_id)
  order by p.lesson_id,p.position,p.id limit 20 offset p_cursor) v);
end $$;
create function public.request_practical_support(p_enrolment_id uuid,p_practical_id uuid,p_request_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare e public.enrolments; p public.course_practicals; begin
 e:=course_activation_private.student_enrolment(p_enrolment_id);
 select * into p from public.course_practicals where id=p_practical_id and programme_version_id=e.programme_version_id
  and exists(select 1 from public.course_activations a where a.import_id=course_practicals.import_id and a.cohort_id=e.cohort_id);
 if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 return public.request_delivery_handoff(e.id,p.lesson_id,null,case when p.kind='PRACTICAL_LAB' then 'PRACTICAL_HELP' else 'PRACTICAL_PREREQUISITE' end,p_request_id);
end $$;
create function public.get_course_activation_options(p_import_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare imp public.course_package_imports; begin
 perform course_activation_private.require_admin();
 if p_import_id is not null then
  select * into imp from public.course_package_imports where id=p_import_id and status in ('APPLIED','PUBLISHED') and exists(select 1 from public.programme_versions v where v.id=programme_version_id and v.status='PUBLISHED');
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 end if;
 return jsonb_build_object(
 'packages',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',i.id,'key',i.package_key,'revision',i.package_revision) item from public.course_package_imports i join public.programme_versions p on p.id=i.programme_version_id where i.status in ('APPLIED','PUBLISHED') and p.status='PUBLISHED' order by i.created_at desc,i.id limit 100) v),
 'cohorts',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',c.id,'title',c.title) item from public.cohorts c where programme_version_id=imp.programme_version_id order by c.starts_on,c.id limit 200) v),
 'instructors',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',s.user_id,'name',u.display_name) item from public.staff_profiles s join public.app_users u on u.id=s.user_id where exists(select 1 from public.role_grants g where g.user_id=s.user_id and g.role='INSTRUCTOR') order by u.display_name,s.user_id limit 200) v),
 'assignments',(select coalesce(jsonb_agg(jsonb_build_object('templateKey',x->>'key','title',x->>'title') order by x->>'key'),'[]') from jsonb_array_elements(imp.raw_package->'assignmentTemplates') x),
 'assessments',(select coalesce(jsonb_agg(jsonb_build_object('templateKey',x->>'key','title',x->>'title') order by x->>'key'),'[]') from jsonb_array_elements(imp.raw_package->'assessmentTemplates') x));
end $$;
-- Owned coursework identifiers for existing learner services: staff RLS visibility
-- must never broaden a multi-role user's student UI. No content or actor input.
create function public.my_coursework_scope() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if public.current_app_user() is null or not public.has_role('STUDENT') then raise exception 'FORBIDDEN'; end if;
 return jsonb_build_object('actorId',public.current_app_user(),'cohortIds',(select coalesce(jsonb_agg(cohort_id),'[]') from public.enrolments where student_id=public.current_app_user()));
end $$;
-- Explicit ACLs plus effective privilege acceptance, including column ACLs and
-- inherited service_role grants. Application clients use the learner session.
do $$ declare t regclass; cols text; f regprocedure; r text; begin
 for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
 'course_activation_versions','course_activation_lessons','course_activation_objectives','course_activations','course_practicals','course_practical_objectives','course_assignment_bindings','course_assignment_objectives','course_assignment_rubrics','course_assessment_bindings','course_assessment_objectives') loop
  execute format('alter table %s enable row level security',t);
  execute format('revoke all on %s from public,anon,authenticated,service_role',t);
  select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid=t and attnum>0 and not attisdropped;
  execute format('revoke select(%s),insert(%s),update(%s),references(%s) on %s from public,anon,authenticated,service_role',cols,cols,cols,cols,t);
  execute format('create trigger activation_immutable before update or delete on %s for each row execute function course_activation_private.immutable()',t);
  foreach r in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe activation privileges'; end if;
  end loop;
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='course_activation_private' or (n.nspname='public' and p.proname in ('activate_course_package','get_course_activation_options','list_practical_enrolments','list_my_practicals','request_practical_support','my_coursework_scope')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  if f::text like 'activate_course_package(%' or f::text like 'get_course_activation_options(%' or f::text like 'list_practical_enrolments(%' or f::text like 'list_my_practicals(%' or f::text like 'request_practical_support(%' or f::text like 'my_coursework_scope(%' then execute format('grant execute on function %s to authenticated',f); end if;
 end loop;
 foreach r in array array['anon','authenticated','service_role'] loop
  if has_schema_privilege(r,'course_activation_private','USAGE,CREATE') or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='course_activation_private' and has_function_privilege(r,p.oid,'EXECUTE')) then raise exception 'Unsafe activation privileges'; end if;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('activate_course_package','get_course_activation_options','list_practical_enrolments','list_my_practicals','request_practical_support','my_coursework_scope') loop
   if has_function_privilege(r,f,'EXECUTE') is distinct from (r='authenticated') then raise exception 'Unsafe activation privileges'; end if;
  end loop;
 end loop;
end $$;
-- The existing answer-key table also receives newly materialised protected
-- answers. Neutralize ambient broad-role defaults explicitly, not only RLS.
revoke all on public.assessment_answer_keys from service_role;
do $$ declare cols text; begin
 select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid='public.assessment_answer_keys'::regclass and attnum>0 and not attisdropped;
 execute format('revoke select(%s),insert(%s),update(%s),references(%s) on public.assessment_answer_keys from service_role',cols,cols,cols,cols);
end $$;
-- Effective activation ACL acceptance: separately executable deployment check.
do $$ declare r text; t regclass; f record; begin
 foreach r in array array['anon','authenticated','service_role'] loop
  for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
   'course_activation_versions','course_activation_lessons','course_activation_objectives','course_activations','course_practicals','course_practical_objectives','course_assignment_bindings','course_assignment_objectives','course_assignment_rubrics','course_assessment_bindings','course_assessment_objectives','assessment_answer_keys') loop
   if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Unsafe activation privileges'; end if;
  end loop;
  if has_schema_privilege(r,'course_activation_private','USAGE,CREATE') then raise exception 'Unsafe activation privileges'; end if;
  for f in select p.oid,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='course_activation_private' or (n.nspname='public' and p.proname in ('activate_course_package','get_course_activation_options','list_practical_enrolments','list_my_practicals','request_practical_support','my_coursework_scope')) loop
   if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated' and f.nspname='public') then raise exception 'Unsafe activation privileges'; end if;
  end loop;
 end loop;
end $$;
