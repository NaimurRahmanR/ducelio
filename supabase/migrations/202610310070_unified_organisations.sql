-- One engine, explicit organisation ownership, no external global role grants.
begin;
create table public.course_engine_organisations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 60),
  name text not null check(length(trim(name)) between 3 and 150),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);
insert into public.course_engine_organisations(id,slug,name) values('00000000-0000-4000-8000-000000000001','ducelio','Ducelio');
create table public.course_engine_memberships (
  organisation_id uuid not null references public.course_engine_organisations(id),
  user_id uuid not null references public.app_users(id),
  role text not null check(role in ('OWNER','COURSE_MANAGER','ACADEMIC_REVIEWER')),
  active boolean not null default true,
  primary key(organisation_id,user_id)
);
create index course_engine_memberships_user on public.course_engine_memberships(user_id,organisation_id) where active;
alter table public.course_engine_packages add column organisation_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.course_engine_organisations(id);
alter table public.course_engine_publications add column organisation_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.course_engine_organisations(id);
alter table public.course_engine_coupons add column organisation_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.course_engine_organisations(id);
alter table public.course_engine_coupons drop constraint course_engine_coupons_code_key,
  add constraint course_engine_coupons_org_code unique(organisation_id,code);
create index course_engine_packages_org on public.course_engine_packages(organisation_id,created_at);
create index course_engine_publications_org on public.course_engine_publications(organisation_id);

create function academy_private.can_manage_org(p_org uuid,p_operation text default 'MANAGE') returns boolean
language sql stable security definer set search_path='' as $$
  select public.current_app_user() is not null and p_operation in ('MANAGE','REVIEW','OWNER','READ') and (
    public.has_role('PLATFORM_ADMIN') or
    (p_org='00000000-0000-4000-8000-000000000001' and public.has_role('ACADEMIC_ADMIN')) or
    exists(select 1 from public.course_engine_memberships m where m.organisation_id=p_org
      and m.user_id=public.current_app_user() and m.active and (
        m.role='OWNER' or p_operation='READ' or
        (p_operation='MANAGE' and m.role='COURSE_MANAGER') or
        (p_operation='REVIEW' and m.role='ACADEMIC_REVIEWER')))
  )
$$;
create function academy_private.require_org(p_org uuid,p_operation text default 'MANAGE') returns uuid
language plpgsql stable security definer set search_path='' as $$
begin
  if not academy_private.can_manage_org(p_org,p_operation) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return public.current_app_user();
end $$;
create function academy_private.require_package(p_package uuid,p_operation text default 'MANAGE') returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_org uuid;
begin
  select organisation_id into v_org from public.course_engine_packages where package_id=p_package;
  if found then return academy_private.require_org(v_org,p_operation); end if;
  -- Historical APIs remain restricted to institutional administrators.
  return academy_private.require_course_admin();
end $$;
create function academy_private.require_offer(p_offer uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select academy_private.require_package((select c.package_id from public.academy_offers o join public.academy_courses c on c.id=o.course_id where o.id=p_offer))
$$;
create function academy_private.require_import(p_import uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_package uuid;
begin
  select p.id into v_package from public.course_package_imports i join public.academy_course_packages p
    on p.package_key=i.package_key and p.package_revision=i.package_revision and p.raw_package->'curriculum'=i.raw_package
    join public.course_engine_packages u on u.package_id=p.id where i.id=p_import;
  if found then return academy_private.require_package(v_package); end if;
  return academy_private.require_course_admin();
end $$;
create function academy_private.require_curriculum(p_key text,p_revision integer,p_body jsonb) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_package uuid;
begin
  select p.id into v_package from public.academy_course_packages p join public.course_engine_packages u on u.package_id=p.id
    where p.package_key=p_key and p.package_revision=p_revision and p.raw_package->'curriculum'=p_body;
  if found then return academy_private.require_package(v_package); end if;
  -- An organisation cannot substitute another raw body under a registered key.
  if exists(select 1 from public.academy_course_packages p join public.course_engine_packages u on u.package_id=p.id where p.package_key=p_key) then raise exception 'FORBIDDEN'; end if;
  return academy_private.require_course_admin();
end $$;
create function academy_private.require_version(p_version uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_import uuid;
begin
  select id into v_import from public.course_package_imports where programme_version_id=p_version;
  if found then return academy_private.require_import(v_import); end if;
  return academy_private.require_course_admin();
end $$;
create function academy_private.require_coupon(p_coupon uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select academy_private.require_org((select organisation_id from public.course_engine_coupons where id=p_coupon))
$$;

-- Read policies use a bounded predicate; protected academic and commercial
-- bodies remain RPC-only. No INSERT/UPDATE/DELETE grants to clients.
create function public.can_read_course_organisation(p_organisation_id uuid) returns boolean
language sql stable security definer set search_path='' as $$select academy_private.can_manage_org(p_organisation_id,'READ')$$;
alter table public.course_engine_organisations enable row level security;
alter table public.course_engine_memberships enable row level security;
revoke all on public.course_engine_organisations,public.course_engine_memberships from public,anon,authenticated,service_role;
grant select on public.course_engine_organisations,public.course_engine_memberships to authenticated;
create policy org_read on public.course_engine_organisations for select to authenticated using(public.can_read_course_organisation(id));
create policy member_read on public.course_engine_memberships for select to authenticated using(public.can_read_course_organisation(organisation_id));
create policy package_read on public.course_engine_packages for select to authenticated using(public.can_read_course_organisation(organisation_id));
create policy publication_read on public.course_engine_publications for select to authenticated using(public.can_read_course_organisation(organisation_id));
create trigger organisation_history before update or delete on public.course_engine_organisations for each row execute function academy_private.guard_history();

create function public.create_course_organisation(p_slug text,p_name text,p_owner_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user(); v_id uuid; v_reason text:=academy_private.require_reason(p_reason);
begin
  if actor is null or not public.has_role('PLATFORM_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if not exists(select 1 from public.app_users u join auth.users a on a.id=u.auth_user_id where u.id=p_owner_id and a.email_confirmed_at is not null and u.account_status='ACTIVE' and not u.is_demo) then raise exception 'INVALID_OWNER'; end if;
  insert into public.course_engine_organisations(slug,name,created_by) values(p_slug,trim(p_name),actor) returning id into v_id;
  insert into public.course_engine_memberships(organisation_id,user_id,role) values(v_id,p_owner_id,'OWNER');
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason) values(actor,'COURSE_ORGANISATION_CREATED','course_engine_organisations',v_id,'UNIFIED_COURSE_ENGINE_V1',v_reason);
  return v_id;
end $$;
create function public.set_course_organisation_member(p_organisation_id uuid,p_user_id uuid,p_role text,p_active boolean,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_org(p_organisation_id,'OWNER'); v_reason text:=academy_private.require_reason(p_reason);
begin
  -- Serialise membership changes so concurrent owners cannot remove each other.
  perform 1 from public.course_engine_organisations where id=p_organisation_id for update;
  actor:=academy_private.require_org(p_organisation_id,'OWNER');
  if p_role is null or p_role not in ('OWNER','COURSE_MANAGER','ACADEMIC_REVIEWER') or p_active is null then raise exception 'INVALID_INPUT'; end if;
  if not exists(select 1 from public.app_users u join auth.users a on a.id=u.auth_user_id where u.id=p_user_id and a.email_confirmed_at is not null and u.account_status='ACTIVE' and not u.is_demo) then raise exception 'INVALID_OWNER'; end if;
  if exists(select 1 from public.course_engine_memberships where organisation_id=p_organisation_id and user_id=p_user_id and active and role='OWNER')
    and (not p_active or p_role<>'OWNER') and not exists(select 1 from public.course_engine_memberships where organisation_id=p_organisation_id and user_id<>p_user_id and active and role='OWNER') then raise exception 'LAST_OWNER'; end if;
  insert into public.course_engine_memberships(organisation_id,user_id,role,active) values(p_organisation_id,p_user_id,p_role,p_active)
    on conflict(organisation_id,user_id) do update set role=excluded.role,active=excluded.active;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state) values(actor,'COURSE_MEMBERSHIP_CHANGED','course_engine_organisations',p_organisation_id,'UNIFIED_COURSE_ENGINE_V1',v_reason,jsonb_build_object('user_id',p_user_id,'role',p_role,'active',p_active));
  return p_user_id;
end $$;
create function public.list_my_course_organisations() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'slug',slug,'canManage',academy_private.can_manage_org(id,'MANAGE'),'canReview',academy_private.can_manage_org(id,'REVIEW'),'canOwn',academy_private.can_manage_org(id,'OWNER')) order by name),'[]')
    from public.course_engine_organisations where academy_private.can_manage_org(id,'READ')
$$;

create function academy_private.bind_publication_org() returns trigger
language plpgsql set search_path='' as $$
begin
  select organisation_id into new.organisation_id from public.course_engine_packages where package_id=new.package_id;
  if new.organisation_id is null then raise exception 'INVALID_OWNERSHIP'; end if;
  return new;
end $$;
create trigger publication_org before insert on public.course_engine_publications for each row execute function academy_private.bind_publication_org();

create or replace function academy_private.upload_org_package(p_org uuid,p_raw_package jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_org(p_org); reason text := academy_private.require_reason(p_reason);
  hash text; existing public.academy_course_packages%rowtype; new_id uuid;
begin
  if jsonb_typeof(p_raw_package) is distinct from 'object' or p_raw_package->>'schemaVersion' is distinct from 'ACADEMY_COURSE_PACKAGE_V1'
    or coalesce(p_raw_package->>'packageKey', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or jsonb_typeof(p_raw_package->'packageRevision') is distinct from 'number'
    or (p_raw_package->>'packageRevision') !~ '^[1-9][0-9]{0,5}$' then
    raise exception 'MALFORMED_PACKAGE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ORG_PACKAGE:'||(p_raw_package->>'packageKey'),0));
  hash := encode(extensions.digest(p_raw_package::text, 'sha256'), 'hex');
  select * into existing from public.academy_course_packages
  where package_key = p_raw_package->>'packageKey' and package_revision = (p_raw_package->>'packageRevision')::integer for update;
  if found then
    if existing.content_hash = hash and exists(select 1 from public.course_engine_packages where package_id=existing.id and organisation_id=p_org) then return existing.id; end if;
    raise exception 'REVISION_CONFLICT';
  end if;
  insert into public.academy_course_packages(package_key, package_revision, schema_version, content_hash, raw_package, created_by)
  values (p_raw_package->>'packageKey', (p_raw_package->>'packageRevision')::integer, 'ACADEMY_COURSE_PACKAGE_V1', hash, p_raw_package, actor)
  returning id into new_id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_PACKAGE_UPLOADED', 'academy_course_packages', new_id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('package_key', p_raw_package->>'packageKey', 'package_revision', (p_raw_package->>'packageRevision')::integer, 'content_hash', hash));
  insert into public.course_engine_packages(package_id,created_by,organisation_id) values(new_id,actor,p_org);
  return new_id;
end $$;

create function public.upload_organisation_course_package(p_organisation_id uuid,p_raw_package jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_key text; v_raw jsonb:=p_raw_package;
begin
 perform academy_private.require_org(p_organisation_id);
 if p_organisation_id<>'00000000-0000-4000-8000-000000000001' then
  -- Namespace source keys once. Revisions returned by the editor retain their
  -- registered internal key; source JSON can be reused by different tenants.
  v_key:=p_raw_package->>'packageKey';
  if not exists(select 1 from public.academy_course_packages p join public.course_engine_packages u on u.package_id=p.id where p.package_key=v_key and u.organisation_id=p_organisation_id) then
   if v_key is null or v_key !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_key) not between 3 and 80 then raise exception 'MALFORMED_PACKAGE';end if;
   v_key:='org-'||encode(extensions.digest(p_organisation_id::text||':'||v_key,'sha256'),'hex');
   v_raw:=jsonb_set(jsonb_set(v_raw,'{packageKey}',to_jsonb(v_key)),'{curriculum,packageKey}',to_jsonb(v_key));
  end if;
 end if;
 return academy_private.upload_org_package(p_organisation_id,v_raw,p_reason);
end $$;
create or replace function public.upload_unified_course_package(p_raw_package jsonb,p_reason text) returns uuid
language sql security definer set search_path='' as $$select public.upload_organisation_course_package('00000000-0000-4000-8000-000000000001',p_raw_package,p_reason)$$;


create or replace function public.mark_academy_course_package_validated(p_package_id uuid, p_review jsonb, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_package(p_package_id); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'VALIDATED' then return pkg.id; end if;
  if pkg.status <> 'UPLOADED' then raise exception 'INVALID_STATE'; end if;
  if jsonb_typeof(p_review) is distinct from 'object' or pg_column_size(p_review) > 262144
    or p_review->>'packageKey' is distinct from pkg.package_key then
    raise exception 'INVALID_INPUT';
  end if;
  perform academy_private.assert_package_valid(pkg.raw_package);
  update public.academy_course_packages set status = 'VALIDATED', review = p_review, validated_by = actor, validated_at = clock_timestamp()
  where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_PACKAGE_VALIDATED', 'academy_course_packages', pkg.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return pkg.id;
end $$;

create or replace function public.get_academy_course_package_content(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_package(p_package_id,'READ');
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status not in ('UPLOADED','VALIDATED') then raise exception 'INVALID_STATE'; end if;
  return pkg.raw_package;
end $$;

create or replace function public.get_academy_course_package_review(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_package(p_package_id,'READ');
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('id', pkg.id, 'status', pkg.status, 'review', pkg.review);
end $$;

create or replace function public.get_academy_course_package_curriculum(p_package_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pkg public.academy_course_packages%rowtype;
begin
  perform academy_private.require_package(p_package_id,'READ');
  select * into pkg from public.academy_course_packages where id = p_package_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return pkg.raw_package->'curriculum';
end $$;

create or replace function public.publish_academy_course(
  p_package_id uuid, p_offer_slug text, p_currency text, p_summary text, p_prices jsonb, p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_package(p_package_id); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype; imp public.course_package_imports%rowtype;
  units jsonb; v_course_id uuid; v_offer_id uuid; price jsonb; fmt jsonb; plan jsonb; days integer[]; lesson_count integer;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'PUBLISHED' then
    select c.id into v_course_id from public.academy_courses c join public.academy_offers o on o.course_id = c.id
    where c.package_id = pkg.id and o.slug = p_offer_slug;
    if v_course_id is null then raise exception 'INVALID_STATE'; end if;
    return v_course_id;
  end if;
  if pkg.status <> 'VALIDATED' then raise exception 'INVALID_STATE'; end if;
  if p_offer_slug is null or p_offer_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_offer_slug) not between 3 and 80
    or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or (p_summary is not null and length(trim(p_summary)) not between 1 and 500)
    or jsonb_typeof(p_prices) is distinct from 'array' or jsonb_array_length(p_prices) not between 1 and 5 then
    raise exception 'INVALID_INPUT';
  end if;
  if exists (select 1 from public.commercial_v1_offers where slug = p_offer_slug)
    or exists (select 1 from public.academy_offers where slug = p_offer_slug) then
    raise exception 'SLUG_CONFLICT';
  end if;
  perform academy_private.assert_package_valid(pkg.raw_package);

  select * into imp from public.course_package_imports
  where package_key = pkg.package_key and package_revision = pkg.package_revision for update;
  if not found or imp.status <> 'PUBLISHED' or imp.raw_package <> pkg.raw_package->'curriculum' then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;
  if exists (select 1 from public.programme_versions v where v.id = imp.programme_version_id and v.status <> 'PUBLISHED') then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;

  units := academy_private.build_units(pkg.raw_package);
  insert into public.academy_courses(package_id, curriculum_import_id, programme_version_id, title, units, published_by)
  values (pkg.id, imp.id, imp.programme_version_id, left(pkg.raw_package->'curriculum'->'programme'->>'title', 200), units, actor)
  returning id into v_course_id;

  insert into public.academy_course_lessons(course_id, sequence, lesson_ref, lesson_id)
  select v_course_id, o.idx + 1, o.lesson_key, l.id
  from academy_private.ordered_lessons(pkg.raw_package->'curriculum') o
  join public.modules m on m.programme_version_id = imp.programme_version_id and m.position = o.module_position
  join public.lessons l on l.module_id = m.id and l.position = o.lesson_position;
  get diagnostics lesson_count = row_count;
  if lesson_count <> (select count(*) from academy_private.ordered_lessons(pkg.raw_package->'curriculum')) then
    raise exception 'CURRICULUM_NOT_PUBLISHED';
  end if;

  insert into public.academy_offers(course_id, slug, currency, summary, published_by)
  values (v_course_id, p_offer_slug, p_currency, nullif(trim(p_summary), ''), actor) returning id into v_offer_id;
  for price in select value from jsonb_array_elements(p_prices) loop
    fmt := null;
    select value into fmt from jsonb_array_elements(pkg.raw_package->'deliveryFormats') where value->>'formatId' = price->>'formatId';
    if fmt is null or jsonb_typeof(price->'amountMinor') is distinct from 'number'
      or (price->>'amountMinor') !~ '^[1-9][0-9]{0,8}$' or (price->>'amountMinor')::bigint > 100000000 then
      raise exception 'INVALID_PRICE';
    end if;
    -- Re-check feasibility at the format's maximum weekly days.
    days := array(select x.d from unnest(array[1,3,5,2,4,6,7]) with ordinality x(d, o) where x.o <= (fmt->>'maxStudyDaysPerWeek')::integer order by x.d);
    plan := academy_private.plan_units(units, academy_private.format_weeks(fmt->>'formatId'), (fmt->>'sessionMinutes')::integer,
      date '2027-01-04', days, null, null, 0);
    if not (plan->>'feasible')::boolean then raise exception 'FORMAT_INFEASIBLE'; end if;
    insert into public.academy_offer_formats(offer_id, format_id, session_minutes, min_study_days, max_study_days, price_amount_minor)
    values (v_offer_id, fmt->>'formatId', (fmt->>'sessionMinutes')::integer, (fmt->>'minStudyDaysPerWeek')::integer,
      (fmt->>'maxStudyDaysPerWeek')::integer, (price->>'amountMinor')::integer);
  end loop;

  update public.academy_course_packages set status = 'PUBLISHED', published_by = actor, published_at = clock_timestamp() where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_COURSE_PUBLISHED', 'academy_courses', v_course_id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('package_id', pkg.id, 'offer_id', v_offer_id, 'slug', p_offer_slug, 'currency', p_currency,
      'formats', (select jsonb_agg(jsonb_build_object('formatId', format_id, 'amountMinor', price_amount_minor) order by format_id)
                  from public.academy_offer_formats where academy_offer_formats.offer_id = v_offer_id)));
  return v_course_id;
exception when unique_violation then
  raise exception 'PUBLICATION_CONFLICT';
end $$;

create or replace function public.reject_academy_course_package(p_package_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_package(p_package_id); reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype;
begin
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pkg.status = 'REJECTED' then return pkg.id; end if;
  if pkg.status = 'PUBLISHED' then raise exception 'INVALID_STATE'; end if;
  update public.academy_course_packages set status = 'REJECTED', rejected_by = actor, rejected_at = clock_timestamp(), rejected_reason = reason
  where id = pkg.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_PACKAGE_REJECTED', 'academy_course_packages', pkg.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return pkg.id;
end $$;

create or replace function public.publish_unified_course(
  p_package_id uuid, p_offer_slug text, p_currency text, p_amount_minor integer,
  p_summary text, p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := academy_private.require_package(p_package_id);
  reason text := academy_private.require_reason(p_reason);
  pkg public.academy_course_packages%rowtype;
  existing public.course_engine_publications%rowtype;
  imp public.course_package_imports%rowtype;
  curriculum jsonb; cfg record; test record; prices jsonb; sale jsonb;
  v_import_id uuid; v_version_id uuid; v_course_id uuid; v_offer_id uuid;
begin
  if p_amount_minor is null or p_amount_minor not between 1 and 100000000
    or p_currency is null or p_currency not in ('GBP','USD','EUR') then raise exception 'INVALID_PRICE'; end if;
  select * into pkg from public.academy_course_packages where id = p_package_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not exists(select 1 from public.course_engine_packages where package_id=pkg.id) then raise exception 'INVALID_STATE'; end if;
  select * into existing from public.course_engine_publications where package_id = pkg.id;
  if found then
    if existing.amount_minor <> p_amount_minor or existing.currency <> p_currency
      or not exists(select 1 from public.academy_offers o where o.id = existing.offer_id
        and o.slug = p_offer_slug and o.summary is not distinct from nullif(trim(p_summary),'')) then
      raise exception 'PUBLICATION_CONFLICT';
    end if;
    return jsonb_build_object('courseId',existing.course_id,'offerId',existing.offer_id,'replayed',true);
  end if;
  if pkg.status <> 'VALIDATED' then raise exception 'INVALID_STATE'; end if;
  perform academy_private.assert_package_valid(pkg.raw_package);
  if jsonb_array_length(coalesce(pkg.raw_package->'pendingDecisions','[]')) > 0 then raise exception 'POLICY_PENDING'; end if;
  if exists(select 1 from jsonb_array_elements(pkg.raw_package->'labs') l where (l->>'graded')::boolean
    and (jsonb_array_length(l->'rubric') = 0 or l->>'markingGuidance' is null)) then raise exception 'RUBRIC_PENDING'; end if;
  curriculum := pkg.raw_package->'curriculum';
  v_import_id := public.import_course_package(pkg.package_key, pkg.package_revision,
    curriculum->>'schemaVersion', curriculum, reason);
  select * into imp from public.course_package_imports where id = v_import_id for update;
  if imp.status = 'IMPORTED' then
    -- The Academy validator has already validated this exact embedded body.
    -- The existing DB authority independently asserts materializability.
    perform public.mark_course_package_validated(v_import_id,
      jsonb_build_object('packageKey',pkg.package_key,'packageRevision',pkg.package_revision,
        'source','VALIDATED_ACADEMY_PACKAGE','academyPackageId',pkg.id),reason);
    imp.status := 'VALIDATED';
  end if;
  if imp.status = 'VALIDATED' then
    v_version_id := public.apply_course_package(v_import_id, reason);
  else v_version_id := imp.programme_version_id;
  end if;
  select * into imp from public.course_package_imports where id = v_import_id;
  if imp.status = 'APPLIED' then
    for cfg in select key, value from jsonb_each(curriculum->'agentConfiguration') loop
      perform public.set_agent_config(v_version_id, cfg.key,
        (cfg.value->>'enabled')::boolean, cfg.value->>'modelProfileRef', cfg.value->>'instructionalNotes',
        array(select jsonb_array_elements_text(cfg.value->'capabilities')), cfg.value->>'escalationPolicy', reason);
    end loop;
    select * into test from public.run_course_package_test(v_import_id, reason);
    if test.outcome is distinct from 'PASS' then
      raise exception 'TEST_GATE_NOT_SATISFIED:%',test.failure_code;
    end if;
    perform public.publish_course_package(v_import_id, reason);
  elsif imp.status <> 'PUBLISHED' then raise exception 'INVALID_STATE';
  end if;
  select jsonb_agg(jsonb_build_object('formatId',f->>'formatId','amountMinor',p_amount_minor)) into prices
    from jsonb_array_elements(pkg.raw_package->'deliveryFormats') f;
  v_course_id := public.publish_academy_course(pkg.id,p_offer_slug,p_currency,p_summary,prices,reason);
  select o.id into v_offer_id from public.academy_offers o where o.course_id = v_course_id;
  sale := public.enable_academy_public_sale(v_offer_id,true,reason);
  if sale->>'ok' is distinct from 'true' then raise exception '%',sale->>'code'; end if;
  insert into public.course_engine_publications(course_id,offer_id,package_id,amount_minor,currency,published_by)
    values(v_course_id,v_offer_id,pkg.id,p_amount_minor,p_currency,actor);
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'UNIFIED_COURSE_PUBLISHED','academy_courses',v_course_id,'UNIFIED_COURSE_ENGINE_V1',reason,
      jsonb_build_object('offer_id',v_offer_id,'package_id',pkg.id,'amount_minor',p_amount_minor,'currency',p_currency));
  return jsonb_build_object('courseId',v_course_id,'offerId',v_offer_id,'replayed',false);
end $$;

create or replace function public.enable_academy_public_sale(p_offer_id uuid, p_owner_approval_confirmed boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_offer(p_offer_id); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype; pending jsonb; pkg jsonb;
begin
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found or offer.state <> 'PUBLISHED' then raise exception 'NOT_FOUND'; end if;
  if offer.sale_mode = 'PUBLIC_SALE' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  pending := academy_private.pending_decisions(offer.course_id);
  if jsonb_array_length(pending) > 0 then
    return jsonb_build_object('ok', false, 'code', 'POLICY_PENDING',
      'pending', (select jsonb_agg(d->>'key') from jsonb_array_elements(pending) d));
  end if;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = offer.course_id;
  if exists (select 1 from jsonb_array_elements(pkg->'labs') lb where (lb.value->>'graded')::boolean
      and (jsonb_array_length(lb.value->'rubric') = 0 or lb.value->>'markingGuidance' is null)) then
    return jsonb_build_object('ok', false, 'code', 'RUBRIC_PENDING');
  end if;
  if p_owner_approval_confirmed is distinct from true then return jsonb_build_object('ok', false, 'code', 'APPROVAL_REQUIRED'); end if;
  update public.academy_offers set sale_mode = 'PUBLIC_SALE', sale_approved_by = actor, sale_approved_at = clock_timestamp(),
    sale_approval_reason = reason where id = offer.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_PUBLIC_SALE_APPROVED', 'academy_offers', offer.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('owner_approval_confirmed', true));
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

create or replace function public.archive_academy_offer(p_offer_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_offer(p_offer_id); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype;
begin
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if offer.state = 'ARCHIVED' then return offer.id; end if;
  update public.academy_offers set state = 'ARCHIVED', archived_by = actor, archived_at = clock_timestamp() where id = offer.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason)
  values (actor, 'ACADEMY_OFFER_ARCHIVED', 'academy_offers', offer.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason);
  return offer.id;
end $$;

create or replace function public.import_course_package(
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
  actor := academy_private.require_curriculum(p_package_key,p_package_revision,p_raw_package);

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

create or replace function public.mark_course_package_validated(
  p_import_id uuid,
  p_validation_report jsonb,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
begin
  actor := academy_private.require_import(p_import_id);
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

create or replace function public.apply_course_package(p_import_id uuid, p_reason text) returns uuid
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
  actor := academy_private.require_import(p_import_id);
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

create or replace function public.reject_course_package(p_import_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  import_record public.course_package_imports%rowtype;
begin
  actor := academy_private.require_import(p_import_id);
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

create or replace function public.get_course_package_content(p_import_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := academy_private.require_import(p_import_id);

  select raw_package into result
  from public.course_package_imports
  where id = p_import_id;
  if not found then raise exception 'Course package import not found'; end if;

  return result;
end $$;

create or replace function public.get_course_package_preview(p_import_id uuid)
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
  actor := academy_private.require_import(p_import_id);

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

create or replace function public.run_course_package_test(p_import_id uuid, p_reason text)
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
  actor := academy_private.require_import(p_import_id);
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

create or replace function public.get_course_package_test_status(p_import_id uuid)
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
  actor := academy_private.require_import(p_import_id);

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
  actor := academy_private.require_version(p_programme_version_id);
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

create or replace function public.list_agent_configs(p_programme_version_id uuid)
returns table(
  id uuid, programme_version_id uuid, role text, enabled boolean, model_profile_ref text,
  instructional_notes text, capabilities text[], escalation_policy text, updated_at timestamptz
)
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  actor := academy_private.require_version(p_programme_version_id);

  return query
  select c.id, c.programme_version_id, c.role, c.enabled, c.model_profile_ref,
         c.instructional_notes, c.capabilities, c.escalation_policy, c.updated_at
  from public.academic_agent_configs c
  where c.programme_version_id = p_programme_version_id
  order by c.role;
end $$;

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
  actor := academy_private.require_import(p_import_id);
  perform academy_private.require_reason(p_reason);

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

create or replace function public.list_unified_course_packages() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id,'READ')) then raise exception 'FORBIDDEN';end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'organisationId',(select organisation_id from public.course_engine_packages where package_id=p.id),'organisationName',(select o.name from public.course_engine_packages u join public.course_engine_organisations o on o.id=u.organisation_id where u.package_id=p.id),'id', p.id, 'packageKey', p.package_key, 'packageRevision', p.package_revision, 'status', p.status,
      'contentHash', p.content_hash, 'createdAt', p.created_at, 'validatedAt', p.validated_at,
      'publishedAt', p.published_at, 'rejectedReason', p.rejected_reason,
      'title', coalesce(p.review->>'title', left(p.raw_package->'curriculum'->'programme'->>'title', 200)),
      'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]') from jsonb_array_elements(coalesce(p.raw_package->'pendingDecisions', '[]')) d),
      'curriculumImport', (select jsonb_build_object('id', i.id, 'status', i.status, 'programmeVersionId', i.programme_version_id)
         from public.course_package_imports i
         where i.package_key = p.package_key and i.package_revision = p.package_revision
           and i.raw_package = p.raw_package->'curriculum'),
      'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state, 'saleMode', o.sale_mode)
         from public.academy_courses c left join public.academy_offers o on o.course_id = c.id where c.package_id = p.id)
    ) order by p.created_at desc)
    from (select a.* from public.academy_course_packages a join public.course_engine_packages u on u.package_id=a.id where academy_private.can_manage_org(u.organisation_id,'READ') order by a.created_at desc limit 200) p), '[]');
end $$;

create or replace function public.set_course_coupon_active(p_coupon_id uuid,p_active boolean,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_coupon(p_coupon_id); reason text:=academy_private.require_reason(p_reason); c public.course_engine_coupons%rowtype;
begin
  if p_active is null then raise exception 'INVALID_INPUT'; end if;
  select * into c from public.course_engine_coupons where id=p_coupon_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if c.active=p_active then return c.id; end if;
  update public.course_engine_coupons set active=p_active where id=c.id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COURSE_COUPON_AVAILABILITY_CHANGED','course_engine_coupons',c.id,'UNIFIED_COURSE_ENGINE_V1',reason,jsonb_build_object('active',p_active));
  return c.id;
end $$;

create or replace function public.get_course_coupon_redemptions(p_coupon_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_coupon(p_coupon_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'learnerId',r.learner_id,'courseId',r.course_id,'orderId',r.order_id,
    'listAmountMinor',r.list_amount_minor,'discountAmountMinor',r.discount_amount_minor,'createdAt',r.created_at,
    'state',case when r.order_id is null or o.state='FULFILLED' then 'REDEEMED' else 'RESERVED' end) order by r.created_at desc)
    from (select * from public.course_engine_coupon_redemptions where coupon_id=p_coupon_id order by created_at desc limit 200) r
    left join public.academy_orders o on o.id=r.order_id),'[]');
end $$;

create or replace function public.create_organisation_course_coupon(p_organisation_id uuid,p_code text,p_percent_off integer,p_expires_at timestamptz,
  p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_org(p_organisation_id); reason text:=academy_private.require_reason(p_reason);
  v_code text:=upper(trim(p_code)); c public.course_engine_coupons%rowtype; v_id uuid;
begin
  if p_course_id is not null and not exists(select 1 from public.course_engine_publications where course_id=p_course_id and organisation_id=p_organisation_id) then raise exception 'FORBIDDEN';end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,39}$' or p_percent_off is null or p_percent_off not between 1 and 100
    or p_expires_at is null or p_redemption_limit is null or p_redemption_limit not between 1 and 1000000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_COUPON:'||p_organisation_id::text||':'||v_code,0));
  select * into c from public.course_engine_coupons where code=v_code and organisation_id=p_organisation_id;
  if found then
    if c.percent_off<>p_percent_off or c.expires_at<>p_expires_at or c.redemption_limit<>p_redemption_limit
      or c.course_id is distinct from p_course_id then raise exception 'COUPON_CONFLICT'; end if;
    return c.id;
  end if;
  if p_expires_at <= clock_timestamp() then raise exception 'INVALID_INPUT'; end if;
  insert into public.course_engine_coupons(code,percent_off,expires_at,redemption_limit,course_id,created_by,organisation_id)
    values(v_code,p_percent_off,p_expires_at,p_redemption_limit,p_course_id,actor,p_organisation_id) returning id into v_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COURSE_COUPON_CREATED','course_engine_coupons',v_id,'UNIFIED_COURSE_ENGINE_V1',reason,
      jsonb_build_object('percent_off',p_percent_off,'redemption_limit',p_redemption_limit,'course_id',p_course_id,'expires_at',p_expires_at));
  return v_id;
end $$;

create or replace function public.create_course_coupon(p_code text,p_percent_off integer,p_expires_at timestamptz,p_redemption_limit integer,p_course_id uuid,p_reason text) returns uuid
language sql security definer set search_path='' as $$select public.create_organisation_course_coupon(coalesce((select organisation_id from public.course_engine_publications where course_id=p_course_id),'00000000-0000-4000-8000-000000000001'),p_code,p_percent_off,p_expires_at,p_redemption_limit,p_course_id,p_reason)$$;

create or replace function public.create_unified_course_order(p_offer_slug text,p_coupon_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=academy_private.require_student(); o public.academy_offers%rowtype; p public.course_engine_publications%rowtype;
  c public.course_engine_coupons%rowtype; prior public.academy_orders%rowtype; ent public.academy_entitlements%rowtype;
  v_code text:=nullif(upper(trim(p_coupon_code)),''); v_amount integer; v_order uuid; v_redemption uuid; v_ent uuid; v_enrol uuid;
begin
  if v_code is not null and (length(v_code)>40 or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,39}$') then
    return jsonb_build_object('ok',false,'code','COUPON_UNAVAILABLE');
  end if;
  select * into o from public.academy_offers where slug=p_offer_slug;
  if not found then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  select * into p from public.course_engine_publications where course_id=o.course_id and offer_id=o.id;
  if not found then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_ORDER:'||actor::text||':'||p.course_id::text,0));
  -- Existing order first, learner second: matches signed fulfilment's lock order.
  select * into prior from public.academy_orders where learner_id=actor and course_id=p.course_id and state='PENDING' and format_id is null for update;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;
  select * into ent from public.academy_entitlements where learner_id=actor and course_id=p.course_id;
  if found then
    if ent.state='REVOKED' then return jsonb_build_object('ok',false,'code','ACCESS_REVOKED'); end if;
    select id into v_enrol from public.academy_enrolments where entitlement_id=ent.id;
    return jsonb_build_object('ok',true,'accessGranted',true,'enrolmentId',v_enrol,'reused',true);
  end if;
  if o.state<>'PUBLISHED' or o.sale_mode<>'PUBLIC_SALE' then return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN'); end if;
  if prior.id is not null then
    if v_code is distinct from (select cp.code from public.course_engine_order_terms t
        join public.course_engine_coupon_redemptions r on r.id=t.redemption_id
        join public.course_engine_coupons cp on cp.id=r.coupon_id where t.order_id=prior.id) then
      return jsonb_build_object('ok',false,'code','CHECKOUT_TERMS_LOCKED');
    end if;
    return jsonb_build_object('ok',true,'accessGranted',false,'orderId',prior.id,'amountMinor',prior.amount_minor,'currency',prior.currency,'offerSlug',o.slug,'formatId',null,'reused',true);
  end if;
  v_amount:=p.amount_minor;
  if v_code is not null then
    select * into c from public.course_engine_coupons where code=v_code and organisation_id=p.organisation_id for update;
    if not found or not c.active or c.expires_at<=clock_timestamp() or (c.course_id is not null and c.course_id<>p.course_id)
      or (select count(*) from public.course_engine_coupon_redemptions where coupon_id=c.id)>=c.redemption_limit then
      return jsonb_build_object('ok',false,'code','COUPON_UNAVAILABLE');
    end if;
    v_amount:=((p.amount_minor::bigint*(100-c.percent_off)+99)/100)::integer;
    if v_amount=p.amount_minor then return jsonb_build_object('ok',false,'code','COUPON_NO_DISCOUNT'); end if;
  end if;
  if v_amount>0 then
    insert into public.academy_orders(learner_id,offer_id,course_id,format_id,amount_minor,currency)
      values(actor,o.id,p.course_id,null,v_amount,p.currency) returning id into v_order;
  end if;
  if c.id is not null then
    insert into public.course_engine_coupon_redemptions(coupon_id,learner_id,course_id,order_id,list_amount_minor,discount_amount_minor)
      values(c.id,actor,p.course_id,v_order,p.amount_minor,p.amount_minor-v_amount) returning id into v_redemption;
  end if;
  if v_order is not null then
    insert into public.course_engine_order_terms(order_id,list_amount_minor,discount_amount_minor,redemption_id)
      values(v_order,p.amount_minor,p.amount_minor-v_amount,v_redemption);
  else
    insert into public.academy_entitlements(learner_id,offer_id,course_id,format_id,source,reason,coupon_redemption_id)
      values(actor,o.id,p.course_id,null,'COUPON','Verified full-discount course coupon',v_redemption) returning id into v_ent;
    insert into public.academy_enrolments(entitlement_id,learner_id,course_id,programme_version_id)
      select v_ent,actor,p.course_id,programme_version_id from public.academy_courses where id=p.course_id returning id into v_enrol;
  end if;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'UNIFIED_COURSE_CHECKOUT_CREATED','academy_courses',p.course_id,'UNIFIED_COURSE_ENGINE_V1','Learner started course checkout',
      jsonb_build_object('order_id',v_order,'redemption_id',v_redemption,'amount_minor',v_amount,'currency',p.currency,'entitlement_id',v_ent));
  if v_order is null then return jsonb_build_object('ok',true,'accessGranted',true,'enrolmentId',v_enrol,'reused',false); end if;
  return jsonb_build_object('ok',true,'accessGranted',false,'orderId',v_order,'amountMinor',v_amount,'currency',p.currency,'offerSlug',o.slug,'formatId',null,'reused',false);
end $$;

create or replace function public.list_course_coupons() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id,'MANAGE')) then raise exception 'FORBIDDEN';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'percentOff',c.percent_off,'expiresAt',c.expires_at,
    'redemptionLimit',c.redemption_limit,'courseId',c.course_id,'active',c.active,
    'reserved',(select count(*) from public.course_engine_coupon_redemptions r join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and o.state='PENDING'),
    'redeemed',(select count(*) from public.course_engine_coupon_redemptions r left join public.academy_orders o on o.id=r.order_id where r.coupon_id=c.id and (o.state='FULFILLED' or r.order_id is null))
  ) order by c.created_at desc) from (select * from public.course_engine_coupons where academy_private.can_manage_org(organisation_id) order by created_at desc limit 200) c),'[]');
end $$;

create function academy_private.require_course_review(p_course uuid) returns uuid
language sql stable security definer set search_path='' as $$select academy_private.require_package((select package_id from public.academy_courses where id=p_course),'REVIEW')$$;
create function academy_private.can_review_course(p_course uuid) returns boolean
language sql stable security definer set search_path='' as $$select academy_private.can_manage_org(coalesce((select u.organisation_id from public.academy_courses c join public.course_engine_packages u on u.package_id=c.package_id where c.id=p_course),'00000000-0000-4000-8000-000000000001'),'REVIEW')$$;

create or replace function public.mark_academy_lab_submission(p_submission_id uuid, p_criterion_marks jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; reason text := academy_private.require_reason(p_reason);
  s public.academy_lab_submissions%rowtype; e public.academy_enrolments%rowtype; spec jsonb; crit jsonb; total integer := 0; max_total integer := 0; v jsonb;
  lesson_ref text; objective_key text;
begin
  select * into s from public.academy_lab_submissions where id = p_submission_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  actor:=academy_private.require_course_review((select course_id from public.academy_enrolments where id=s.enrolment_id));
  if actor=(select learner_id from public.academy_enrolments where id=s.enrolment_id) then raise exception 'FORBIDDEN';end if;
  if exists (select 1 from public.academy_lab_marks where submission_id = s.id) then raise exception 'ALREADY_MARKED'; end if;
  select * into e from public.academy_enrolments where id = s.enrolment_id;
  select lb.value into spec from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
    jsonb_array_elements(p.raw_package->'labs') lb where c.id = e.course_id and lb.value->>'activityRef' = s.lab_ref;
  if spec is null or not (spec->>'graded')::boolean or jsonb_typeof(p_criterion_marks) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
  -- No rubric means no approved marking basis: never invent one.
  if jsonb_array_length(spec->'rubric') = 0 or spec->>'markingGuidance' is null then raise exception 'RUBRIC_PENDING'; end if;
  if (select count(*) from jsonb_object_keys(p_criterion_marks)) <> jsonb_array_length(spec->'rubric') then raise exception 'INVALID_INPUT'; end if;
  for crit in select value from jsonb_array_elements(spec->'rubric') loop
    v := p_criterion_marks->(crit->>'key');
    if v is null or jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,3}$' or (v #>> '{}')::integer > (crit->>'maxMarks')::integer then
      raise exception 'INVALID_INPUT';
    end if;
    total := total + (v #>> '{}')::integer;
    max_total := max_total + (crit->>'maxMarks')::integer;
  end loop;
  insert into public.academy_lab_marks(submission_id, criterion_marks, marks, max_marks, marked_by, reason)
  values (s.id, p_criterion_marks, total, max_total, actor, reason);
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_LAB_MARKED', 'academy_lab_submissions', s.id, 'ACADEMY_DELIVERY_V1', reason,
    jsonb_build_object('marks', total, 'max_marks', max_total));
  -- One PRACTICAL_TASK observation per objective the practical addresses.
  for lesson_ref, objective_key in
    select o.lesson_key, r.value #>> '{}' from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id,
      academy_private.ordered_lessons(p.raw_package->'curriculum') o, jsonb_array_elements(o.lesson->'practicalActivities') pa,
      jsonb_array_elements(pa.value->'objectiveRefs') r
    where c.id = e.course_id and pa.value->>'key' = s.lab_ref
  loop
    perform academy_private.record_evidence(e.id, academy_private.objective_id(e.course_id, lesson_ref, objective_key),
      'LAB_MARK', s.id, 'PRACTICAL_TASK', total, max_total);
  end loop;
  perform academy_private.evaluate_completion(e.id);
  return jsonb_build_object('ok', true, 'marks', total, 'maxMarks', max_total);
end $$;

create or replace function public.review_course_recovery(p_request_id uuid,p_approve boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid;reason text:=academy_private.require_reason(p_reason);
 r public.course_engine_recoveries%rowtype;e public.academy_enrolments%rowtype;i public.academy_schedule_items%rowtype;
begin
 select * into r from public.course_engine_recoveries where id=p_request_id;
 if not found then raise exception 'NOT_FOUND';end if;
 select * into e from public.academy_enrolments where id=r.enrolment_id;
 actor:=academy_private.require_course_review(e.course_id);
 -- Shared learner lock first; never recovery -> enrolment in the opposite order.
 perform 1 from public.student_profiles where user_id=e.learner_id for update;
 select * into e from public.academy_enrolments where id=r.enrolment_id for update;
 select * into r from public.course_engine_recoveries where id=p_request_id for update;
 if actor=e.learner_id or p_approve is null then raise exception 'FORBIDDEN';end if;
 if r.state<>'PENDING' then
  if (r.state='APPROVED') is distinct from p_approve then raise exception 'REQUEST_CONFLICT';end if;
  return jsonb_build_object('ok',true,'state',r.state,'replayed',true);
 end if;
 if p_approve then
  select * into i from public.academy_schedule_items where enrolment_id=e.id and schedule_id=(academy_private.current_schedule(e.id)).id
    and academy_private.root_schedule_item(id)=r.root_item_id;
  if not found or e.status<>'ACTIVE' or exists(select 1 from public.academy_entitlements where id=e.entitlement_id and state<>'ACTIVE')
    or not academy_private.recovery_eligible(e,i) then raise exception 'RECOVERY_NOT_ELIGIBLE';end if;
  if r.opens_at<clock_timestamp()+interval '5 minutes' then raise exception 'INVALID_RECOVERY_TIME';end if;
 end if;
 update public.course_engine_recoveries set state=case when p_approve then 'APPROVED' else 'DENIED' end,
  reviewed_by=actor,reviewed_at=clock_timestamp(),review_reason=reason where id=r.id;
 insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
 values(actor,'COURSE_RECOVERY_REVIEWED','course_engine_recoveries',r.id,'UNIFIED_RECOVERY_V1',reason,jsonb_build_object('approved',p_approve));
 return jsonb_build_object('ok',true,'state',case when p_approve then 'APPROVED' else 'DENIED' end,'replayed',false);
end $$;

create or replace function public.list_academy_lab_submissions_for_review() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id,'REVIEW')) then raise exception 'FORBIDDEN';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('submissionId', s.id, 'courseTitle', c.title, 'labRef', s.lab_ref,
      'title', academy_private.unit_title(p.raw_package, 'LAB', s.lab_ref), 'body', s.body, 'submittedAt', s.submitted_at,
      'rubric', lb.value->'rubric', 'markingGuidance', lb.value->>'markingGuidance') order by s.submitted_at)
    from public.academy_lab_submissions s join public.academy_enrolments e on e.id = s.enrolment_id
    join public.academy_courses c on c.id = e.course_id join public.academy_course_packages p on p.id = c.package_id
    join lateral jsonb_array_elements(p.raw_package->'labs') lb on lb.value->>'activityRef' = s.lab_ref
    where academy_private.can_review_course(c.id) and (lb.value->>'graded')::boolean and not exists (select 1 from public.academy_lab_marks m where m.submission_id = s.id)
    limit 200), '[]');
end $$;

create or replace function public.list_course_recoveries() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id,'REVIEW')) then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'enrolmentId',r.enrolment_id,'itemId',r.root_item_id,
  'state',r.state,'opensAt',r.opens_at,'closesAt',r.opens_at+interval '1439 minutes','reasonCode',r.reason_code) order by r.requested_at)
 from (select * from public.course_engine_recoveries where state='PENDING' and academy_private.can_review_course((select course_id from public.academy_enrolments where id=enrolment_id)) order by requested_at limit 100) r),'[]');
end $$;

create function public.create_course_organisation_by_email(p_slug text,p_name text,p_owner_email text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_owner uuid;
begin
 if public.current_app_user() is null or not public.has_role('PLATFORM_ADMIN') then raise exception 'FORBIDDEN';end if;
 if p_owner_email is null or length(p_owner_email)>254 then raise exception 'INVALID_INPUT';end if;
 select u.id into v_owner from public.app_users u join auth.users a on a.id=u.auth_user_id where lower(a.email)=lower(trim(p_owner_email)) and a.email_confirmed_at is not null and u.account_status='ACTIVE' and not u.is_demo;
 if v_owner is null then raise exception 'INVALID_OWNER';end if;
 return public.create_course_organisation(p_slug,p_name,v_owner,p_reason);
end $$;
create function public.get_unified_package_organisation(p_package_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
begin
 perform academy_private.require_package(p_package_id);
 return (select organisation_id from public.course_engine_packages where package_id=p_package_id);
end $$;
create function public.set_course_organisation_member_by_email(p_organisation_id uuid,p_email text,p_role text,p_active boolean,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
 perform academy_private.require_org(p_organisation_id,'OWNER');
 if p_email is null or length(p_email)>254 then raise exception 'INVALID_INPUT';end if;
 select u.id into v_user from public.app_users u join auth.users a on a.id=u.auth_user_id
 where lower(a.email)=lower(trim(p_email)) and a.email_confirmed_at is not null and u.account_status='ACTIVE' and not u.is_demo;
 if v_user is null then raise exception 'INVALID_OWNER';end if;
 return public.set_course_organisation_member(p_organisation_id,v_user,p_role,p_active,p_reason);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure sig from pg_proc where pronamespace='academy_private'::regnamespace loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);end loop;
 for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname in ('create_course_organisation_by_email','get_unified_package_organisation','set_course_organisation_member_by_email','can_read_course_organisation','create_course_organisation','set_course_organisation_member','list_my_course_organisations','upload_organisation_course_package','create_organisation_course_coupon') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 execute format('grant execute on function %s to authenticated',f.sig);end loop;
end $$;
create or replace function public.list_academy_course_packages() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'packageKey', p.package_key, 'packageRevision', p.package_revision, 'status', p.status,
      'contentHash', p.content_hash, 'createdAt', p.created_at, 'validatedAt', p.validated_at,
      'publishedAt', p.published_at, 'rejectedReason', p.rejected_reason,
      'title', coalesce(p.review->>'title', left(p.raw_package->'curriculum'->'programme'->>'title', 200)),
      'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]') from jsonb_array_elements(coalesce(p.raw_package->'pendingDecisions', '[]')) d),
      'curriculumImport', (select jsonb_build_object('id', i.id, 'status', i.status, 'programmeVersionId', i.programme_version_id)
         from public.course_package_imports i
         where i.package_key = p.package_key and i.package_revision = p.package_revision
           and i.raw_package = p.raw_package->'curriculum'),
      'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state, 'saleMode', o.sale_mode)
         from public.academy_courses c left join public.academy_offers o on o.course_id = c.id where c.package_id = p.id)
    ) order by p.created_at desc)
    from (select * from public.academy_course_packages a where not exists(select 1 from public.course_engine_packages u where u.package_id=a.id and not academy_private.can_manage_org(u.organisation_id,'READ')) order by created_at desc limit 100) p), '[]');
end $$;
create or replace function public.list_course_packages()
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
  where not exists(select 1 from public.academy_course_packages p join public.course_engine_packages u on u.package_id=p.id where p.package_key=i.package_key and p.package_revision=i.package_revision and not academy_private.can_manage_org(u.organisation_id,'READ'))
  order by i.created_at desc
  limit 200;
end $$;
create or replace function public.admin_set_agent_behaviour_config(
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
  actor := academy_private.require_version(p_programme_version_id);
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
create or replace function public.admin_list_agent_behaviour_configs(p_programme_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_version(p_programme_version_id);
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
create or replace function public.grant_academy_entitlement(p_offer_id uuid, p_learner_email text, p_format_id text, p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_offer(p_offer_id); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype; learner uuid; ent public.academy_entitlements%rowtype; enrolment uuid; version_id uuid;
begin
  if exists(select 1 from public.course_engine_publications where offer_id=p_offer_id) then raise exception 'USE_UNIFIED_CHECKOUT';end if;
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found or offer.state <> 'PUBLISHED' then raise exception 'NOT_FOUND'; end if;
  if p_format_id is not null and not exists (select 1 from public.academy_offer_formats f where f.offer_id = offer.id and f.format_id = p_format_id) then
    raise exception 'INVALID_FORMAT';
  end if;
  select u.id into learner from public.app_users u join auth.users a on a.id = u.auth_user_id
  where lower(a.email) = lower(trim(p_learner_email)) and a.email_confirmed_at is not null and not u.is_demo and u.account_status = 'ACTIVE'
    and exists (select 1 from public.role_grants g where g.user_id = u.id and g.role = 'STUDENT');
  if learner is null then raise exception 'LEARNER_NOT_FOUND'; end if;
  select * into ent from public.academy_entitlements where learner_id = learner and course_id = offer.course_id;
  if found then
    if ent.format_id is distinct from p_format_id then raise exception 'ENTITLEMENT_EXISTS'; end if;
    select id into enrolment from public.academy_enrolments where entitlement_id = ent.id;
    return enrolment;
  end if;
  insert into public.academy_entitlements(learner_id, offer_id, course_id, format_id, source, granted_by, reason)
  values (learner, offer.id, offer.course_id, p_format_id, 'COMPLIMENTARY_GRANT', actor, reason) returning * into ent;
  select programme_version_id into version_id from public.academy_courses where id = offer.course_id;
  insert into public.academy_enrolments(entitlement_id, learner_id, course_id, programme_version_id)
  values (ent.id, learner, offer.course_id, version_id) returning id into enrolment;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_ENTITLEMENT_GRANTED', 'academy_entitlements', ent.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('enrolment_id', enrolment, 'offer_id', offer.id, 'format_id', p_format_id, 'source', 'COMPLIMENTARY_GRANT'));
  return enrolment;
end $$;
create or replace function public.admin_revoke_academy_entitlement(p_entitlement_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_offer((select offer_id from public.academy_entitlements where id=p_entitlement_id)); reason text := academy_private.require_reason(p_reason);
begin
  return academy_private.revoke_entitlement(p_entitlement_id, actor, reason);
end $$;
commit;
