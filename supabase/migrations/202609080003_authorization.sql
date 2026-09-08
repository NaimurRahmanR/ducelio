-- Backend and direct REST use identical relationship boundaries.
create function public.current_app_user() returns uuid language sql stable security definer set search_path='' as $$
 select u.id from public.app_users u join auth.users a on a.id=u.auth_user_id where a.id=auth.uid() and a.email_confirmed_at is not null and not u.is_demo
$$;
create function public.has_role(wanted public.platform_role) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.role_grants where user_id=public.current_app_user() and role=wanted)
$$;
create function public.is_academic_admin() returns boolean language sql stable security definer set search_path='' as $$
 select public.has_role('ACADEMIC_ADMIN') or public.has_role('REGISTRAR') or public.has_role('PLATFORM_ADMIN')
$$;
create function public.is_assigned_counsellor(learner uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.has_role('COUNSELLOR') and exists(select 1 from public.counsellor_assignments where student_id=learner and counsellor_id=public.current_app_user() and starts_at<=now() and ended_at is null)
$$;
create function public.can_support(learner uuid) returns boolean language sql stable security definer set search_path='' as $$
 select (learner=public.current_app_user() and public.has_role('STUDENT')) or public.is_assigned_counsellor(learner)
$$;
create function public.can_read_student(learner uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.can_support(learner) or public.is_academic_admin()
$$;
create function public.can_read_version(version_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.is_academic_admin() or (public.has_role('INSTRUCTOR') and exists(select 1 from public.programme_versions where id=version_id and status='PUBLISHED')) or exists(select 1 from public.enrolments where programme_version_id=version_id and public.can_read_student(student_id))
$$;
create function public.can_read_identity(target uuid) returns boolean language sql stable security definer set search_path='' as $$
 select target=public.current_app_user() or public.is_academic_admin() or public.is_assigned_counsellor(target) or exists(select 1 from public.counsellor_assignments where student_id=public.current_app_user() and counsellor_id=target and starts_at<=now() and ended_at is null)
$$;
revoke all on function public.current_app_user() from public;
grant execute on function public.current_app_user() to authenticated;
revoke all on function public.has_role(public.platform_role) from public;
grant execute on function public.has_role(public.platform_role) to authenticated;
revoke all on function public.is_academic_admin() from public;
grant execute on function public.is_academic_admin() to authenticated;
revoke all on function public.is_assigned_counsellor(uuid) from public;
grant execute on function public.is_assigned_counsellor(uuid) to authenticated;
revoke all on function public.can_support(uuid) from public;
grant execute on function public.can_support(uuid) to authenticated;
revoke all on function public.can_read_student(uuid) from public;
grant execute on function public.can_read_student(uuid) to authenticated;
revoke all on function public.can_read_version(uuid) from public;
grant execute on function public.can_read_version(uuid) to authenticated;
revoke all on function public.can_read_identity(uuid) from public;
grant execute on function public.can_read_identity(uuid) to authenticated;
grant select on public.app_users to authenticated;
create policy read_permitted on public.app_users for select to authenticated using (public.can_read_identity(id));
grant select on public.role_grants to authenticated;
create policy read_permitted on public.role_grants for select to authenticated using (user_id=public.current_app_user());
grant select on public.student_profiles to authenticated;
create policy read_permitted on public.student_profiles for select to authenticated using (public.can_read_student(user_id));
grant select on public.staff_profiles to authenticated;
create policy read_permitted on public.staff_profiles for select to authenticated using (public.can_read_identity(user_id));
grant select on public.programmes to authenticated;
create policy read_permitted on public.programmes for select to authenticated using (exists(select 1 from public.programme_versions v where v.programme_id=programmes.id and public.can_read_version(v.id)));
grant select on public.programme_versions to authenticated;
create policy read_permitted on public.programme_versions for select to authenticated using (public.can_read_version(id));
grant select on public.modules to authenticated;
create policy read_permitted on public.modules for select to authenticated using (public.can_read_version(programme_version_id));
grant select on public.lessons to authenticated;
create policy read_permitted on public.lessons for select to authenticated using (public.can_read_version(programme_version_id));
grant select on public.lesson_objectives to authenticated;
create policy read_permitted on public.lesson_objectives for select to authenticated using (public.can_read_version(programme_version_id));
grant select on public.cohorts to authenticated;
create policy read_permitted on public.cohorts for select to authenticated using (public.can_read_version(programme_version_id));
grant select on public.enrolments to authenticated;
create policy read_permitted on public.enrolments for select to authenticated using (public.can_read_student(student_id));
grant select on public.counsellor_assignments to authenticated;
create policy read_permitted on public.counsellor_assignments for select to authenticated using (public.can_read_student(student_id));
grant select on public.student_support_profiles to authenticated;
create policy read_permitted on public.student_support_profiles for select to authenticated using (public.can_support(student_id));
grant select on public.study_plans to authenticated;
create policy read_permitted on public.study_plans for select to authenticated using (public.can_support(student_id));
grant select on public.study_plan_items to authenticated;
create policy read_permitted on public.study_plan_items for select to authenticated using (public.can_support(student_id));
grant select on public.support_events to authenticated;
create policy read_permitted on public.support_events for select to authenticated using (public.can_support(student_id));
grant select on public.support_followups to authenticated;
create policy read_permitted on public.support_followups for select to authenticated using (public.can_support(student_id));
grant select on public.counsellor_interactions to authenticated;
create policy read_permitted on public.counsellor_interactions for select to authenticated using (public.is_assigned_counsellor(student_id));
grant select on public.audit_events to authenticated;
create policy read_permitted on public.audit_events for select to authenticated using (public.has_role('PLATFORM_ADMIN'));
