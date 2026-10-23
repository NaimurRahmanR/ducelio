-- Ducelio Academy (B2C) admin course lifecycle: the administrator's course
-- package list also returns each Academy offer's currency and its priced
-- learning formats, so the admin Courses lifecycle can show the published
-- commercial terms without reading the audit log. Additive and read-only:
-- CREATE OR REPLACE keeps the signature and the reviewed ACL (authenticated
-- callers, re-checked by academy_private.require_course_admin()), and the
-- body is migration 061's body with only 'currency' and 'formats' added to
-- the 'course' object. No table, policy, grant or row changes.
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
      'course', (select jsonb_build_object('id', c.id, 'offerId', o.id, 'slug', o.slug, 'offerState', o.state, 'saleMode', o.sale_mode,
           'currency', o.currency,
           'formats', coalesce((select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
               'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days,
               'amountMinor', f.price_amount_minor) order by academy_private.format_weeks(f.format_id))
             from public.academy_offer_formats f where f.offer_id = o.id), '[]'))
         from public.academy_courses c left join public.academy_offers o on o.course_id = c.id where c.package_id = p.id)
    ) order by p.created_at desc)
    from (select * from public.academy_course_packages order by created_at desc limit 100) p), '[]');
end $$;
