-- Checkpoint A: one atomic, cohort-free publication and one-price catalogue.
-- Additive, no backfill, deletion, hosted execution or historical SQL changes.
begin;
-- Only explicitly uploaded new-engine packages enter the administration
-- register. Existing drafts and published packages remain historical.
create table public.course_engine_packages (
  package_id uuid primary key references public.academy_course_packages(id),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index course_engine_packages_creator on public.course_engine_packages(created_by);
alter table public.course_engine_packages enable row level security;
revoke all on public.course_engine_packages from public,anon,authenticated,service_role;
create trigger course_engine_package_immutable before update or delete on public.course_engine_packages
  for each row execute function academy_private.guard_history();

create function public.upload_unified_course_package(p_raw_package jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_course_admin(); v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('UNIFIED_PACKAGE:' || coalesce(p_raw_package->>'packageKey',''),0));
  if exists(select 1 from public.academy_course_packages p
    where p.package_key=p_raw_package->>'packageKey' and p.package_revision::text=p_raw_package->>'packageRevision'
      and not exists(select 1 from public.course_engine_packages u where u.package_id=p.id)) then
    raise exception 'REVISION_CONFLICT';
  end if;
  v_id := public.upload_academy_course_package(p_raw_package,p_reason);
  -- An existing historical package cannot be silently adopted by re-upload.
  if not exists(select 1 from public.course_engine_packages where package_id=v_id)
    and exists(select 1 from public.academy_course_packages p where p.id=v_id and p.status <> 'UPLOADED') then
    raise exception 'INVALID_STATE';
  end if;
  insert into public.course_engine_packages(package_id,created_by) values(v_id,actor) on conflict do nothing;
  return v_id;
end $$;
revoke all on function public.upload_unified_course_package(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.upload_unified_course_package(jsonb,text) to authenticated;
create table public.course_engine_publications (
  course_id uuid primary key references public.academy_courses(id),
  offer_id uuid not null unique references public.academy_offers(id),
  package_id uuid not null unique references public.academy_course_packages(id),
  amount_minor integer not null check (amount_minor between 1 and 100000000),
  currency text not null check (currency in ('GBP','USD','EUR')),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp()
);
create index course_engine_publications_publisher on public.course_engine_publications(published_by);
alter table public.course_engine_publications enable row level security;
revoke all on public.course_engine_publications from public, anon, authenticated, service_role;
create trigger course_engine_publication_immutable before update or delete on public.course_engine_publications
  for each row execute function academy_private.guard_history();

-- This is the only new publication authority. Every nested authority retains
-- its own role, package, profile, content, test and immutability checks.
-- The package lock serialises double publication; a failed gate rolls back
-- all materialisation, including a curriculum publication.
create function public.publish_unified_course(
  p_package_id uuid, p_offer_slug text, p_currency text, p_amount_minor integer,
  p_summary text, p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := academy_private.require_course_admin();
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
revoke all on function public.publish_unified_course(uuid,text,text,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.publish_unified_course(uuid,text,text,integer,text,text) to authenticated;

-- A fresh register, never a backfill of legacy AWS/Security+/draft courses.
-- Uses the proven safe public projection; protected package bodies stay private.
create function public.list_unified_course_catalogue() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(item order by item->>'title'),'[]')
  from jsonb_array_elements(public.list_academy_catalogue()) item
  where exists(select 1 from public.course_engine_publications u where u.offer_id = (item->>'offerId')::uuid)
$$;
revoke all on function public.list_unified_course_catalogue() from public,anon,authenticated,service_role;
grant execute on function public.list_unified_course_catalogue() to anon,authenticated;

create function public.list_unified_course_packages() returns jsonb
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
    from (select a.* from public.academy_course_packages a join public.course_engine_packages u on u.package_id=a.id order by a.created_at desc limit 200) p), '[]');
end $$;

revoke all on function public.list_unified_course_packages() from public,anon,authenticated,service_role;
grant execute on function public.list_unified_course_packages() to authenticated;

-- Effective ACL checks include Supabase's explicit role defaults, not just
-- PUBLIC grants. Protected bodies and the publication register are RPC-only.
do $$ declare r text; p text; t text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['course_engine_packages','course_engine_publications'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege(r,'public.' || t,p) then
        raise exception 'Unexpected course engine table privilege';
      end if;
    end loop;
    if has_any_column_privilege(r,'public.' || t,'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Unexpected course engine column privilege';
    end if;
    end loop;
    if has_function_privilege(r,'public.publish_unified_course(uuid,text,text,integer,text,text)','EXECUTE') <> (r = 'authenticated')
      or has_function_privilege(r,'public.upload_unified_course_package(jsonb,text)','EXECUTE') <> (r = 'authenticated')
      or has_function_privilege(r,'public.list_unified_course_packages()','EXECUTE') <> (r = 'authenticated')
      or has_function_privilege(r,'public.list_unified_course_catalogue()','EXECUTE') <> (r in ('anon','authenticated')) then
      raise exception 'Unexpected course engine function privilege';
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
