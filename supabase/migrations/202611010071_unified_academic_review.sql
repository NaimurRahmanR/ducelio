-- Evidence-backed human resolution, immutable revisions, no inferred approvals.
begin;
create table public.course_engine_academic_resolutions (
  target_package_id uuid not null references public.course_engine_packages(package_id),
  source_package_id uuid not null references public.course_engine_packages(package_id),
  decision_key text not null check(length(decision_key) between 1 and 80),
  evidence_reference text not null check(length(trim(evidence_reference)) between 10 and 300),
  rationale text not null check(length(trim(rationale)) between 20 and 1000),
  reviewed_by uuid not null references public.app_users(id),
  reviewed_at timestamptz not null default clock_timestamp(),
  primary key(target_package_id,decision_key),
  check(target_package_id<>source_package_id)
);
create index course_resolution_source on public.course_engine_academic_resolutions(source_package_id);
create index course_resolution_reviewer on public.course_engine_academic_resolutions(reviewed_by);
create table public.course_engine_revision_requests (
  source_package_id uuid not null references public.course_engine_packages(package_id),
  request_key uuid not null,
  target_package_id uuid not null references public.course_engine_packages(package_id),
  request_hash text not null,
  primary key(source_package_id,request_key)
);
create index course_revision_target on public.course_engine_revision_requests(target_package_id);
do $$ declare t text;begin
 foreach t in array array['course_engine_academic_resolutions','course_engine_revision_requests'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 execute format('create trigger immutable_history before update or delete on public.%I for each row execute function academy_private.guard_history()',t);
 end loop;
end $$;

create function academy_private.require_resolved_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare target public.academy_course_packages%rowtype; source public.academy_course_packages%rowtype; d jsonb;
begin
 select * into target from public.academy_course_packages where id=new.package_id;
 select p.* into source from public.academy_course_packages p join public.course_engine_packages u on u.package_id=p.id
  where p.package_key=target.package_key and p.package_revision<target.package_revision and u.organisation_id=new.organisation_id
  order by p.package_revision desc limit 1;
 if not found then return new;end if;
 for d in select value from jsonb_array_elements(source.raw_package->'pendingDecisions') loop
  if not exists(select 1 from jsonb_array_elements(target.raw_package->'pendingDecisions') n where n->>'key'=d->>'key')
   and not exists(select 1 from public.course_engine_academic_resolutions r where r.source_package_id=source.id and r.target_package_id=target.id and r.decision_key=d->>'key') then
   raise exception 'ACADEMIC_EVIDENCE_REQUIRED';
  end if;
 end loop;
 return new;
end $$;
create constraint trigger reviewed_pending_removal after insert on public.course_engine_packages
 deferrable initially deferred for each row execute function academy_private.require_resolved_revision();

create function public.revise_unified_course_package(p_source_id uuid,p_raw_package jsonb,p_resolutions jsonb,p_review jsonb,p_request_key uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_package(p_source_id); reason text:=academy_private.require_reason(p_reason);
 source public.academy_course_packages%rowtype; v_org uuid; v_id uuid; existing public.course_engine_revision_requests%rowtype;
 hash text; d jsonb; r jsonb; removed text[]:=array[]::text[];
begin
 select organisation_id into v_org from public.course_engine_packages where package_id=p_source_id;
 if not found then raise exception 'INVALID_STATE';end if;
 select * into source from public.academy_course_packages where id=p_source_id for update;
 perform pg_advisory_xact_lock(hashtextextended('ORG_PACKAGE:'||source.package_key,0));
 if source.status not in ('UPLOADED','VALIDATED','REJECTED') or p_request_key is null then raise exception 'INVALID_STATE';end if;
 if jsonb_typeof(p_resolutions) is distinct from 'array' or jsonb_array_length(p_resolutions)>50 then raise exception 'INVALID_INPUT';end if;
 hash:=encode(extensions.digest(jsonb_build_array(p_raw_package,p_resolutions,p_review)::text,'sha256'),'hex');
 select * into existing from public.course_engine_revision_requests where source_package_id=source.id and request_key=p_request_key;
 if found then
  if existing.request_hash<>hash then raise exception 'REQUEST_CONFLICT';end if;
  return existing.target_package_id;
 end if;
 if p_raw_package->>'packageKey' is distinct from source.package_key or p_raw_package->>'packageRevision' is distinct from (source.package_revision+1)::text then raise exception 'REVISION_CONFLICT';end if;
 perform academy_private.assert_package_valid(p_raw_package);
 if not exists(select 1 from jsonb_array_elements(p_raw_package->'pendingDecisions') pd where pd->>'key'='LAB_RUBRICS') and exists(select 1 from jsonb_array_elements(p_raw_package->'labs') l where (l->>'graded')::boolean and (jsonb_array_length(l->'rubric')=0 or nullif(trim(l->>'markingGuidance'),'') is null)) then raise exception 'RUBRIC_PENDING';end if;
 for d in select value from jsonb_array_elements(source.raw_package->'pendingDecisions') loop
  if not exists(select 1 from jsonb_array_elements(p_raw_package->'pendingDecisions') n where n->>'key'=d->>'key') then
   removed:=array_append(removed,d->>'key');
  end if;
 end loop;
 if cardinality(removed)>0 then perform academy_private.require_org(v_org,'REVIEW');end if;
 if (select count(*) from jsonb_array_elements(p_resolutions))<>cardinality(removed)
  or (select count(distinct x->>'key') from jsonb_array_elements(p_resolutions) x)<>cardinality(removed) then raise exception 'ACADEMIC_EVIDENCE_REQUIRED';end if;
 for r in select value from jsonb_array_elements(p_resolutions) loop
  if r->>'key' is null or not (r->>'key'=any(removed)) or length(trim(coalesce(r->>'evidenceReference',''))) not between 10 and 300
   or length(trim(coalesce(r->>'rationale',''))) not between 20 and 1000 then raise exception 'ACADEMIC_EVIDENCE_REQUIRED';end if;
 end loop;
 v_id:=academy_private.upload_org_package(v_org,p_raw_package,reason);
 for r in select value from jsonb_array_elements(p_resolutions) loop
  insert into public.course_engine_academic_resolutions(target_package_id,source_package_id,decision_key,evidence_reference,rationale,reviewed_by)
   values(v_id,source.id,r->>'key',trim(r->>'evidenceReference'),trim(r->>'rationale'),actor);
 end loop;
 perform public.mark_academy_course_package_validated(v_id,p_review,reason);
 insert into public.course_engine_revision_requests(source_package_id,request_key,target_package_id,request_hash) values(source.id,p_request_key,v_id,hash);
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COURSE_ACADEMIC_REVISION_REVIEWED','academy_course_packages',v_id,'UNIFIED_COURSE_ENGINE_V1',reason,jsonb_build_object('source_id',source.id,'resolved_keys',to_jsonb(removed)));
 return v_id;
end $$;
create function public.get_unified_academic_resolutions(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform academy_private.require_package(p_package_id,'READ');
 return coalesce((select jsonb_agg(jsonb_build_object('key',decision_key,'evidenceReference',evidence_reference,'rationale',rationale,'reviewedBy',reviewed_by,'reviewedAt',reviewed_at) order by decision_key) from public.course_engine_academic_resolutions where target_package_id=p_package_id),'[]');
end $$;
revoke all on function academy_private.require_resolved_revision() from public,anon,authenticated,service_role;
revoke all on function public.revise_unified_course_package(uuid,jsonb,jsonb,jsonb,uuid,text),public.get_unified_academic_resolutions(uuid) from public,anon,authenticated,service_role;
grant execute on function public.revise_unified_course_package(uuid,jsonb,jsonb,jsonb,uuid,text),public.get_unified_academic_resolutions(uuid) to authenticated;
commit;
