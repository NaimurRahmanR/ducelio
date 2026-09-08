-- Supabase owns UserIdentity/provider subjects. One stable application ID per auth user.
create function public.provision_academy_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare app_id uuid;
begin
 insert into public.app_users(auth_user_id,display_name)
 values (NEW.id,coalesce(nullif(left(trim(NEW.raw_user_meta_data->>'display_name'),100),''),'Learner'))
 on conflict(auth_user_id) do update set auth_user_id=excluded.auth_user_id returning id into app_id;
 insert into public.student_profiles(user_id,student_number) values(app_id,'DUC-'||replace(app_id::text,'-','')) on conflict do nothing;
 insert into public.role_grants(user_id,role) values(app_id,'STUDENT') on conflict do nothing;
 return NEW;
end $$;
revoke all on function public.provision_academy_user() from public;
create trigger academy_identity after insert on auth.users for each row execute function public.provision_academy_user();
-- Idempotent backfill for a project with existing Auth users.
insert into public.app_users(auth_user_id,display_name)
 select id,coalesce(nullif(left(trim(raw_user_meta_data->>'display_name'),100),''),'Learner') from auth.users
 on conflict(auth_user_id) do nothing;
insert into public.student_profiles(user_id,student_number)
 select id,'DUC-'||replace(id::text,'-','') from public.app_users where not is_demo on conflict do nothing;
insert into public.role_grants(user_id,role)
 select id,'STUDENT' from public.app_users where not is_demo on conflict do nothing;
