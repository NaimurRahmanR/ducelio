-- Commercial V1 -- bounded admin activation-discovery read.
-- Forward-only from CLOSED GREEN PR26 (migration 041 already present, merged
-- at 5965cbcc4399943b5bf25b2b2237b3f4740d2251). No historical migration is
-- modified.
--
-- Problem this closes: PR26 documented one remaining operational gap --
-- /admin/activation/policy required an admin to already know/type a real
-- activation's internal UUID, because no read anywhere let an admin browse
-- existing Commercial V1 activations. activate_course_package (migration
-- 027) returns a new activation's id directly to its caller, but nothing
-- ever surfaced it back to the admin afterward, and there was no way to
-- rediscover an activation created in an earlier session. This migration
-- adds exactly one bounded, admin-gated read closing that gap generally --
-- not just for a just-created activation.
--
-- Design: reuses course_activation_private.require_admin() (migration 027)
-- for identical admin gating to every other read in that family
-- (get_course_activation_options, bind_commercial_v1_assessment_component,
-- ...). No new schema, no new table -- this is a pure read composing
-- already-authoritative tables (course_activations, course_package_imports,
-- programme_versions, programmes, cohorts, commercial_v1_grading_policies,
-- commercial_v1_result_policies, commercial_v1_lab_policies,
-- course_practicals). Display fields are exactly what an admin needs to
-- recognise the right activation (programme/course title, package key and
-- revision, cohort title, activation created timestamp, and whether
-- grading/result/lab policy already exist) -- never any protected
-- assessment/lab content, never a learner-identifying field.
create function public.list_commercial_v1_activations() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform course_activation_private.require_admin();
  return jsonb_build_object('activations',(
    select coalesce(jsonb_agg(jsonb_build_object(
      'activationId',a.id,
      'programmeTitle',p.title,
      'versionLabel',pv.label,
      'packageKey',i.package_key,
      'packageRevision',i.package_revision,
      'cohortTitle',c.title,
      'cohortStartsOn',c.starts_on,
      'activationState',a.state,
      'createdAt',a.created_at,
      'gradingPolicyPublished',exists(
        select 1 from public.commercial_v1_grading_policies gp where gp.activation_id=a.id),
      'resultPolicyPublished',exists(
        select 1 from public.commercial_v1_result_policies rp where rp.activation_id=a.id),
      'labPracticalsTotal',(
        select count(*)::integer from public.course_practicals pr
        where pr.import_id=a.import_id and pr.programme_version_id=a.programme_version_id and pr.kind='PRACTICAL_LAB'),
      'labPracticalsConfigured',(
        select count(*)::integer from public.course_practicals pr
        join public.commercial_v1_lab_policies lp on lp.activation_id=a.id and lp.practical_id=pr.id
        where pr.import_id=a.import_id and pr.programme_version_id=a.programme_version_id and pr.kind='PRACTICAL_LAB')
    ) order by a.created_at desc,a.id),'[]'::jsonb)
    from (
      select * from public.course_activations order by created_at desc limit 200
    ) a
    join public.course_package_imports i on i.id=a.import_id
    join public.programme_versions pv on pv.id=a.programme_version_id
    join public.programmes p on p.id=pv.programme_id
    join public.cohorts c on c.id=a.cohort_id
  ));
end $$;
revoke all on function public.list_commercial_v1_activations() from public, anon, authenticated, service_role;
grant execute on function public.list_commercial_v1_activations() to authenticated;

-- Effective-privilege acceptance, mirroring every other reviewed migration
-- in this codebase (031/032/040/041's own pattern).
do $$ declare r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='list_commercial_v1_activations' loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated') then
        raise exception 'Unsafe effective activation-discovery function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
