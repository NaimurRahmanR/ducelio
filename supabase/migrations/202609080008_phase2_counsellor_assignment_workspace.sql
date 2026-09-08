-- Phase 2 checkpoint 3: constrained staff discovery for counsellor assignment.
create function public.list_assignable_counsellors()
returns table(user_id uuid, display_name text, title text)
language sql stable security definer set search_path='' as $$
  select s.user_id, u.display_name, s.title
  from public.staff_profiles s
  join public.app_users u on u.id = s.user_id
  join public.role_grants r on r.user_id = s.user_id and r.role = 'COUNSELLOR'
  where public.current_app_user() is not null
    and (
      public.has_role('ACADEMIC_ADMIN') or
      public.has_role('PLATFORM_ADMIN')
    )
  order by u.display_name, s.user_id
$$;

revoke all on function public.list_assignable_counsellors() from public;
grant execute on function public.list_assignable_counsellors() to authenticated;
