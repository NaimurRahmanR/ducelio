-- Admin course lifecycle: delivery-model evidence for the course register.
--
-- The admin Courses lifecycle must know, for every curriculum revision it
-- lists, whether an individual-learning (Academy) package is attached to it.
-- It previously read list_academy_course_packages, which returns only the
-- 100 newest Academy packages, so a course whose package fell outside that
-- window would have lost its individual-learning classification.
--
-- get_academy_delivery_evidence takes the register's own curriculum import
-- ids and resolves them in one set-based query, with no listing window:
--  - a published Academy course is linked by academy_courses.curriculum_
--    import_id (unique, recorded at publication);
--  - an unpublished Academy package is linked exactly as migration 061 does:
--    same package key and revision (unique on both tables) and an identical
--    embedded curriculum.
-- It also returns each linked offer's currency and priced formats, and the
-- number of Academy packages not yet linked to any curriculum.
--
-- Additive and read-only: one new admin function; no table, row, policy or
-- existing function changes. Course administrators only, re-checked in the
-- database. The input is bounded per call (the server sends the register in
-- batches), which bounds request size without omitting any course.
create function public.get_academy_delivery_evidence(p_import_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform academy_private.require_course_admin();
  if p_import_ids is null or cardinality(p_import_ids) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'curriculumImportId', i.id,
        'curriculumStatus', i.status,
        'packageId', p.id,
        'packageRevision', p.package_revision,
        'status', p.status,
        'pendingDecisions', (select coalesce(jsonb_agg(d->>'key'), '[]')
          from jsonb_array_elements(coalesce(p.raw_package->'pendingDecisions', '[]')) d),
        'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state,
             'saleMode', o.sale_mode, 'currency', o.currency,
             'formats', coalesce((select jsonb_agg(jsonb_build_object('formatId', f.format_id,
                 'weeks', academy_private.format_weeks(f.format_id), 'sessionMinutes', f.session_minutes,
                 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days,
                 'amountMinor', f.price_amount_minor) order by academy_private.format_weeks(f.format_id))
               from public.academy_offer_formats f where f.offer_id = o.id), '[]'))
           from public.academy_courses c left join public.academy_offers o on o.course_id = c.id
           where c.package_id = p.id)
      ) order by i.id)
      from public.course_package_imports i
      left join public.academy_courses linked on linked.curriculum_import_id = i.id
      join public.academy_course_packages p on p.id = coalesce(linked.package_id, (
        select q.id from public.academy_course_packages q
        where q.package_key = i.package_key and q.package_revision = i.package_revision
          and q.raw_package->'curriculum' = i.raw_package))
      where i.id = any(p_import_ids)), '[]'),
    'packagesWithoutCurriculum', (
      select count(*)::int from public.academy_course_packages p
      where p.status <> 'REJECTED'
        and not exists (select 1 from public.academy_courses c where c.package_id = p.id)
        and not exists (select 1 from public.course_package_imports i
          where i.package_key = p.package_key and i.package_revision = p.package_revision
            and i.raw_package = p.raw_package->'curriculum')));
end $$;

revoke all on function public.get_academy_delivery_evidence(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_academy_delivery_evidence(uuid[]) to authenticated;
