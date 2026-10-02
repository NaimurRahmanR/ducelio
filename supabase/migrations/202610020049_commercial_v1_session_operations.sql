-- Explicit Session Operations. No recurrence, inferred duration or cohort-date policy.
-- Lock order: request advisory lock -> cohort -> instructor app_users -> staff_profiles -> session.
-- People mutations lock app_users before eligibility/live-teaching decisions (044).
create schema session_operations_private;
revoke all on schema session_operations_private from public,anon,authenticated,service_role;
create function session_operations_private.instructor(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare u public.app_users;
begin
 select * into u from public.app_users where id=p_id for update;
 if not found then raise exception 'INSTRUCTOR_UNAVAILABLE'; end if;
 if u.account_status<>'ACTIVE' then raise exception 'STAFF_DEACTIVATED'; end if;
 perform 1 from public.staff_profiles where user_id=p_id for update;
 if not found or not exists(select 1 from public.role_grants where user_id=p_id and role='INSTRUCTOR') then raise exception 'INVALID_INSTRUCTOR'; end if;
end $$;
create function session_operations_private.reason(p_reason text) returns text
language plpgsql set search_path='' as $$ begin
 if p_reason is null or length(trim(p_reason)) not between 5 and 300 then raise exception 'BOUNDED_REASON_REQUIRED'; end if;
 return trim(p_reason);
end $$;
-- All writers must respect finished delivery. CLOSED still permits delivery.
create function session_operations_private.delivery_guard() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 perform 1 from public.cohorts where id=NEW.cohort_id and status='COMPLETED' for share;
 if found then raise exception 'COHORT_COMPLETED'; end if;
 return NEW;
end $$;
create trigger session_delivery_guard before insert on public.class_sessions for each row execute function session_operations_private.delivery_guard();
-- A stale classroom opener must not insert after reschedule commits cancellation.
-- FOR SHARE conflicts with reschedule FOR UPDATE (unlike the FK's KEY SHARE).
-- The lock is held through the classroom transaction; existing history is untouched.
create function session_operations_private.classroom_parent_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent_status text;
begin
 select status into parent_status from public.class_sessions
 where id=NEW.class_session_id for share;
 if not found or parent_status='CANCELLED' then
   raise exception 'CLASSROOM_PARENT_UNAVAILABLE';
 end if;
 return NEW;
end $$;
create trigger session_classroom_parent_guard
before insert on public.professor_classroom_sessions
for each row execute function session_operations_private.classroom_parent_guard();
-- Replace only the legacy creation body; the immutable-history trigger is unchanged.
create or replace function public.create_class_session(p_cohort_id uuid,p_lesson_id uuid,p_instructor_id uuid,p_scheduled_start timestamptz,p_scheduled_end timestamptz,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; c public.cohorts; result uuid; why text;
begin
 actor:=public.current_app_user();
 if actor is null or not(public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then raise exception 'Access denied' using errcode='42501'; end if;
 why:=session_operations_private.reason(p_reason);
 if p_scheduled_start is null or p_scheduled_end is null or not isfinite(p_scheduled_start) or not isfinite(p_scheduled_end) or p_scheduled_end<=p_scheduled_start then raise exception 'INVALID_INTERVAL'; end if;
 select * into c from public.cohorts where id=p_cohort_id for update;
 if not found then raise exception 'Cohort not found'; end if;
 if c.status='COMPLETED' then raise exception 'COHORT_COMPLETED'; end if;
 if not exists(select 1 from public.programme_versions where id=c.programme_version_id and status='PUBLISHED') then raise exception 'Class sessions require a published programme version'; end if;
 if not exists(select 1 from public.lessons where id=p_lesson_id and programme_version_id=c.programme_version_id) then raise exception 'Lesson must belong to the cohort programme version'; end if;
 perform session_operations_private.instructor(p_instructor_id);
 if exists(select 1 from public.class_sessions where cohort_id=c.id and status<>'CANCELLED' and scheduled_start<p_scheduled_end and scheduled_end>p_scheduled_start) then raise exception 'Cohort already has an overlapping class session'; end if;
 if exists(select 1 from public.class_sessions where instructor_id=p_instructor_id and status<>'CANCELLED' and scheduled_start<p_scheduled_end and scheduled_end>p_scheduled_start) then raise exception 'Instructor already has an overlapping class session'; end if;
 perform set_config('app.audit_reason',why,true);
 insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,created_by)
 values(c.id,c.programme_version_id,p_lesson_id,p_instructor_id,p_scheduled_start,p_scheduled_end,actor) returning id into result;
 return result;
end $$;
-- Effective direct table writes, including column-level inherited defaults, cannot bypass scheduling.
revoke insert,update,delete,truncate,trigger on public.class_sessions from public,anon,authenticated,service_role;
do $$ declare cols text; r text; begin
 select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid='public.class_sessions'::regclass and attnum>0 and not attisdropped;
 foreach r in array array['public','anon','authenticated','service_role'] loop
 execute format('revoke insert (%s), update (%s) on public.class_sessions from %I',cols,cols,r);
 end loop;
end $$;
create table public.class_session_operation_receipts (
 request_id uuid primary key,
 kind text not null check(kind in ('RESCHEDULE','BATCH')),
 fingerprint text not null check(length(fingerprint)=64),
 actor_id uuid not null references public.app_users(id),
 cohort_id uuid not null references public.cohorts(id),
 activation_id uuid references public.course_activations(id),
 original_id uuid unique references public.class_sessions(id),
 reason text not null check(length(trim(reason)) between 5 and 300),
 created_at timestamptz not null default clock_timestamp(),
 check((kind='RESCHEDULE' and original_id is not null and activation_id is null) or (kind='BATCH' and original_id is null and activation_id is not null))
);
create table public.class_session_operation_items (
 request_id uuid not null references public.class_session_operation_receipts(request_id),
 ordinal integer not null check(ordinal between 1 and 100),
 session_id uuid not null unique references public.class_sessions(id),
 primary key(request_id,ordinal)
);
alter table public.class_session_operation_receipts enable row level security;
alter table public.class_session_operation_items enable row level security;
revoke all on public.class_session_operation_receipts,public.class_session_operation_items from public,anon,authenticated,service_role;
create trigger immutable_receipt before update or delete on public.class_session_operation_receipts for each row execute function course_activation_private.immutable();
create trigger immutable_item before update or delete on public.class_session_operation_items for each row execute function course_activation_private.immutable();
create function session_operations_private.outcome(p_request uuid,p_replay boolean) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('requestId',r.request_id,'originalId',r.original_id,'replay',p_replay,'sessionIds',(select jsonb_agg(i.session_id order by i.ordinal) from public.class_session_operation_items i where i.request_id=r.request_id)) from public.class_session_operation_receipts r where request_id=p_request
$$;
create function public.reschedule_class_session(p_session_id uuid,p_scheduled_start timestamptz,p_request_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; s public.class_sessions; prior public.class_session_operation_receipts; replacement uuid; fingerprint text; finish timestamptz; why text; c public.cohorts;
begin
 actor:=course_activation_private.require_admin(); why:=session_operations_private.reason(p_reason);
 if p_request_id is null or p_session_id is null or p_scheduled_start is null or not isfinite(p_scheduled_start) then raise exception 'INVALID_INPUT'; end if;
 fingerprint:=encode(extensions.digest(jsonb_build_object('kind','RESCHEDULE','session',p_session_id,'start',p_scheduled_start)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(49,hashtext(p_request_id::text));
 select * into prior from public.class_session_operation_receipts where request_id=p_request_id;
 if found then
 if prior.fingerprint<>fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
 return session_operations_private.outcome(p_request_id,true);
 end if;
 select * into s from public.class_sessions where id=p_session_id;
 if not found then raise exception 'SESSION_NOT_FOUND'; end if;
 select * into c from public.cohorts where id=s.cohort_id for update;
 if c.status='COMPLETED' then raise exception 'COHORT_COMPLETED'; end if;
 perform session_operations_private.instructor(s.instructor_id);
 select * into s from public.class_sessions where id=p_session_id for update;
 if exists(select 1 from public.class_session_operation_receipts where original_id=s.id) then raise exception 'ALREADY_RESCHEDULED'; end if;
 if s.status<>'SCHEDULED' then raise exception 'SESSION_CLOSED'; end if;
 if s.scheduled_start<=clock_timestamp() then raise exception 'SESSION_STARTED'; end if;
 if p_scheduled_start<=clock_timestamp() then raise exception 'REPLACEMENT_NOT_FUTURE'; end if;
 finish:=p_scheduled_start+(s.scheduled_end-s.scheduled_start);
 -- Child history stays on the original forever, including unexpected provisioned records.
 if exists(select 1 from public.attendance_records where session_id=s.id) or exists(select 1 from public.learning_evidence where session_id=s.id) or exists(select 1 from public.lesson_progress where last_session_id=s.id) or exists(select 1 from public.professor_classroom_sessions where class_session_id=s.id) then raise exception 'SESSION_HAS_HISTORY'; end if;
 perform public.change_class_session_status(s.id,'CANCELLED',why);
 replacement:=public.create_class_session(s.cohort_id,s.lesson_id,s.instructor_id,p_scheduled_start,finish,why);
 insert into public.class_session_operation_receipts values(p_request_id,'RESCHEDULE',fingerprint,actor,s.cohort_id,null,s.id,why,clock_timestamp());
 insert into public.class_session_operation_items values(p_request_id,1,replacement);
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,before_state,after_state)
 values(actor,'CLASS_SESSION_RESCHEDULED','class_sessions',s.id,'SESSION_OPERATIONS_V1',why,jsonb_build_object('scheduled_start',s.scheduled_start,'scheduled_end',s.scheduled_end),jsonb_build_object('request_id',p_request_id,'replacement_id',replacement,'scheduled_start',p_scheduled_start,'scheduled_end',finish));
 return session_operations_private.outcome(p_request_id,false);
end $$;
create function public.generate_class_session_batch(p_request_id uuid,p_activation_id uuid,p_instructor_id uuid,p_items jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare actor uuid; a public.course_activations; c public.cohorts; x jsonb; normalized jsonb; fingerprint text; prior public.class_session_operation_receipts; why text; generated uuid; n integer:=0;
begin
 actor:=course_activation_private.require_admin(); why:=session_operations_private.reason(p_reason);
 if p_request_id is null or p_activation_id is null or p_instructor_id is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
 if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'BATCH_REQUEST_LIMIT'; end if;
 for x in select jsonb_array_elements(p_items) loop
 if jsonb_typeof(x) is distinct from 'object' or (select count(*) from jsonb_object_keys(x))<>3 or not(x ?& array['lessonId','scheduledStart','scheduledEnd']) or jsonb_typeof(x->'lessonId') is distinct from 'string' or jsonb_typeof(x->'scheduledStart') is distinct from 'string' or jsonb_typeof(x->'scheduledEnd') is distinct from 'string' or length(x->>'scheduledStart')>50 or length(x->>'scheduledEnd')>50 or (x->>'scheduledStart') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$' or (x->>'scheduledEnd') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'INVALID_INPUT'; end if;
 if (x->>'scheduledEnd')::timestamptz<=(x->>'scheduledStart')::timestamptz then raise exception 'INVALID_INTERVAL'; end if;
 end loop;
 select jsonb_agg(jsonb_build_object('lessonId',(value->>'lessonId')::uuid,'scheduledStart',(value->>'scheduledStart')::timestamptz,'scheduledEnd',(value->>'scheduledEnd')::timestamptz) order by (value->>'scheduledStart')::timestamptz,(value->>'scheduledEnd')::timestamptz,(value->>'lessonId')::uuid) into normalized from jsonb_array_elements(p_items);
 fingerprint:=encode(extensions.digest(jsonb_build_object('kind','BATCH','activation',p_activation_id,'instructor',p_instructor_id,'items',normalized)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(49,hashtext(p_request_id::text));
 select * into prior from public.class_session_operation_receipts where request_id=p_request_id;
 if found then
 if prior.fingerprint<>fingerprint then raise exception 'REQUEST_CONFLICT'; end if;
 return session_operations_private.outcome(p_request_id,true);
 end if;
 select * into a from public.course_activations where id=p_activation_id;
 if not found then raise exception 'ACTIVATION_NOT_FOUND'; end if;
 select * into c from public.cohorts where id=a.cohort_id for update;
 if c.status='COMPLETED' then raise exception 'COHORT_COMPLETED'; end if;
 perform session_operations_private.instructor(p_instructor_id);
 if exists(select 1 from jsonb_array_elements(normalized) item where not exists(select 1 from public.course_activation_lessons l where l.import_id=a.import_id and l.programme_version_id=a.programme_version_id and l.lesson_id=(item->>'lessonId')::uuid)) then raise exception 'ACTIVATION_LESSON_MISMATCH'; end if;
 if exists(select 1 from jsonb_array_elements(normalized) with ordinality l(x,i),jsonb_array_elements(normalized) with ordinality r(x,i) where l.i<r.i and (l.x->>'scheduledStart')::timestamptz<(r.x->>'scheduledEnd')::timestamptz and (l.x->>'scheduledEnd')::timestamptz>(r.x->>'scheduledStart')::timestamptz) then raise exception 'BATCH_INTERNAL_OVERLAP'; end if;
 if exists(select 1 from jsonb_array_elements(normalized) item join public.class_sessions s on s.cohort_id=c.id and s.lesson_id=(item->>'lessonId')::uuid and s.scheduled_start=(item->>'scheduledStart')::timestamptz and s.scheduled_end=(item->>'scheduledEnd')::timestamptz where s.status='CANCELLED') then raise exception 'CANCELLED_HISTORY_MATCH'; end if;
 -- Preflight every existing interval under the same locks before inserting any result.
 for x in select jsonb_array_elements(normalized) loop
 if exists(select 1 from public.class_sessions where cohort_id=c.id and status<>'CANCELLED' and scheduled_start<(x->>'scheduledEnd')::timestamptz and scheduled_end>(x->>'scheduledStart')::timestamptz) then raise exception 'Cohort already has an overlapping class session'; end if;
 if exists(select 1 from public.class_sessions where instructor_id=p_instructor_id and status<>'CANCELLED' and scheduled_start<(x->>'scheduledEnd')::timestamptz and scheduled_end>(x->>'scheduledStart')::timestamptz) then raise exception 'Instructor already has an overlapping class session'; end if;
 end loop;
 insert into public.class_session_operation_receipts values(p_request_id,'BATCH',fingerprint,actor,c.id,a.id,null,why,clock_timestamp());
 for x in select jsonb_array_elements(normalized) loop
 generated:=public.create_class_session(c.id,(x->>'lessonId')::uuid,p_instructor_id,(x->>'scheduledStart')::timestamptz,(x->>'scheduledEnd')::timestamptz,why); n:=n+1;
 insert into public.class_session_operation_items values(p_request_id,n,generated);
 end loop;
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
 values(actor,'CLASS_SESSION_BATCH_GENERATED','class_session_operation_receipts',p_request_id,'SESSION_OPERATIONS_V1',why,jsonb_build_object('activation_id',a.id,'cohort_id',c.id,'instructor_id',p_instructor_id,'count',n));
 return session_operations_private.outcome(p_request_id,false);
end $$;
create function public.admin_list_class_session_operations(p_cohort_id uuid default null,p_status text default null,p_from timestamptz default null,p_until timestamptz default null,p_offset integer default 0,p_session_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform course_activation_private.require_admin();
 if p_offset is null or p_offset not between 0 and 100000 or (p_status is not null and p_status not in ('SCHEDULED','COMPLETED','CANCELLED')) or (p_from is not null and not isfinite(p_from)) or (p_until is not null and not isfinite(p_until)) or (p_from is not null and p_until is not null and p_until<=p_from) then raise exception 'INVALID_INPUT'; end if;
 with page as (select s.*,c.title cohort_title,c.status cohort_status,l.title lesson_title,u.display_name instructor_name,v.label version_label,coalesce(v.title_snapshot,'Programme') programme_title from public.class_sessions s join public.cohorts c on c.id=s.cohort_id join public.lessons l on l.id=s.lesson_id join public.app_users u on u.id=s.instructor_id join public.programme_versions v on v.id=s.programme_version_id where (p_session_id is null or s.id=p_session_id) and (p_cohort_id is null or s.cohort_id=p_cohort_id) and (p_status is null or s.status=p_status) and (p_from is null or s.scheduled_start>=p_from) and (p_until is null or s.scheduled_start<p_until) order by s.scheduled_start,s.id offset p_offset limit 51)
 select jsonb_build_object('hasMore',(select count(*)>50 from page),'rows',coalesce((select jsonb_agg(item order by stamp,id) from (select p.id,p.scheduled_start stamp,jsonb_build_object('id',p.id,'cohortTitle',p.cohort_title,'cohortStatus',p.cohort_status,'lessonTitle',p.lesson_title,'instructorName',p.instructor_name,'programmeTitle',p.programme_title,'versionLabel',p.version_label,'scheduledStart',p.scheduled_start,'scheduledEnd',p.scheduled_end,'status',p.status,'canReschedule',p.status='SCHEDULED' and p.cohort_status<>'COMPLETED' and p.scheduled_start>statement_timestamp(),'originalId',(select r.original_id from public.class_session_operation_items i join public.class_session_operation_receipts r using(request_id) where i.session_id=p.id),'replacementId',(select i.session_id from public.class_session_operation_receipts r join public.class_session_operation_items i using(request_id) where r.original_id=p.id)) item from page p order by p.scheduled_start,p.id limit 50) q),'[]'::jsonb)) into result;
 return result;
end $$;
-- Page sizes are request bounds, not activation/lesson domain limits.
create function public.admin_class_session_batch_options(
 p_activation_id uuid default null,
 p_activation_offset integer default 0,
 p_lesson_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare selected jsonb; result jsonb;
begin
 perform course_activation_private.require_admin();
 if p_activation_offset is null or p_activation_offset<0
   or p_lesson_offset is null or p_lesson_offset<0 then raise exception 'INVALID_INPUT'; end if;
 select jsonb_build_object('id',a.id,'instructorId',a.instructor_id,
   'title',c.title||' / '||coalesce(v.title_snapshot,'Programme'),'status',c.status)
 into selected from public.course_activations a
 join public.cohorts c on c.id=a.cohort_id
 join public.programme_versions v on v.id=a.programme_version_id
 where a.id=p_activation_id;
 if p_activation_id is not null and not found then raise exception 'ACTIVATION_NOT_FOUND'; end if;
 with activation_page as (
   select a.id,a.created_at,jsonb_build_object('id',a.id,'instructorId',a.instructor_id,
     'title',c.title||' / '||coalesce(v.title_snapshot,'Programme'),'status',c.status) item
   from public.course_activations a join public.cohorts c on c.id=a.cohort_id
   join public.programme_versions v on v.id=a.programme_version_id
   order by a.created_at,a.id offset p_activation_offset limit 201
 ), lesson_page as (
   select x.id,m.position module_position,x.position lesson_position,
     jsonb_build_object('id',l.lesson_id,'title',x.title) item
   from public.course_activation_lessons l join public.lessons x on x.id=l.lesson_id
   join public.modules m on m.id=x.module_id
   join public.course_activations a on a.import_id=l.import_id and a.programme_version_id=l.programme_version_id
   where a.id=p_activation_id
   order by m.position,x.position,x.id offset p_lesson_offset limit 251
 )
 select jsonb_build_object(
   'activationOffset',p_activation_offset,'lessonOffset',p_lesson_offset,
   'selectedActivation',selected,
   'hasMore',(select count(*)>200 from activation_page),
   'activations',coalesce((select jsonb_agg(q.item order by q.created_at,q.id)
     from (select * from activation_page order by created_at,id limit 200) q),'[]'::jsonb),
   'lessonsHasMore',(select count(*)>250 from lesson_page),
   'lessons',coalesce((select jsonb_agg(q.item order by q.module_position,q.lesson_position,q.id)
     from (select * from lesson_page order by module_position,lesson_position,id limit 250) q),'[]'::jsonb)
 ) into result;
 return result;
end $$;
-- Revoke broad inherited function defaults too; private helpers stay unreachable.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='session_operations_private' or (n.nspname='public' and p.proname in ('create_class_session','reschedule_class_session','generate_class_session_batch','admin_list_class_session_operations','admin_class_session_batch_options')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.create_class_session(uuid,uuid,uuid,timestamptz,timestamptz,text),public.reschedule_class_session(uuid,timestamptz,uuid,text),public.generate_class_session_batch(uuid,uuid,uuid,jsonb,text),public.admin_list_class_session_operations(uuid,text,timestamptz,timestamptz,integer,uuid),public.admin_class_session_batch_options(uuid,integer,integer) to authenticated;

-- Fail closed if hosted role inheritance or unexpected ACLs survive the revokes.
-- Compare effective privileges, including column grants and exact RPC signatures.
do $session_operations_acl$
declare r text; t text; f record;
 reviewed oid[]:=array[
   'public.create_class_session(uuid,uuid,uuid,timestamptz,timestamptz,text)'::regprocedure::oid,
   'public.reschedule_class_session(uuid,timestamptz,uuid,text)'::regprocedure::oid,
   'public.generate_class_session_batch(uuid,uuid,uuid,jsonb,text)'::regprocedure::oid,
   'public.admin_list_class_session_operations(uuid,text,timestamptz,timestamptz,integer,uuid)'::regprocedure::oid,
   'public.admin_class_session_batch_options(uuid,integer,integer)'::regprocedure::oid
 ];
begin
 if not has_table_privilege('authenticated','public.class_sessions','SELECT') then
   raise exception 'Required authenticated class-session SELECT is missing';
 end if;
 foreach r in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(r,'public.class_sessions','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
     or has_any_column_privilege(r,'public.class_sessions','INSERT,UPDATE') then
     raise exception 'Unsafe effective class-session write privileges for %',r;
   end if;
   foreach t in array array['public.class_session_operation_receipts','public.class_session_operation_items'] loop
     if has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r,t,'SELECT,INSERT,UPDATE,REFERENCES') then
       raise exception 'Unsafe effective session-operation metadata privileges for % on %',r,t;
     end if;
     if current_setting('server_version_num')::integer>=170000 then
       if has_table_privilege(r,t,'MAINTAIN') then
         raise exception 'Unsafe effective session-operation metadata privileges for % on %',r,t;
       end if;
     end if;
   end loop;
   if has_schema_privilege(r,'session_operations_private','USAGE,CREATE') then
     raise exception 'Unsafe effective session-operation schema privileges for %',r;
   end if;
   for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='session_operations_private'
       or (n.nspname='public' and p.proname in (
         'create_class_session','reschedule_class_session','generate_class_session_batch',
         'admin_list_class_session_operations','admin_class_session_batch_options'
       )) loop
     if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
       (r='authenticated' and f.oid=any(reviewed)) then
       raise exception 'Unsafe effective session-operation function privileges for % on %',r,f.proname;
     end if;
   end loop;
 end loop;
end $session_operations_acl$;
