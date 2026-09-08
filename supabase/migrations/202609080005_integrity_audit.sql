-- Final consistency audit: immutable relationship history and curriculum locking.
create or replace function public.guard_curriculum_version() returns trigger language plpgsql set search_path='' as $$
declare old_version uuid; new_version uuid;
begin
 if TG_TABLE_NAME='programme_versions' then
  if OLD.status='PUBLISHED' or exists(select 1 from public.enrolments where programme_version_id=OLD.id) then raise exception 'Published or enrolled curriculum is immutable'; end if;
 else
  if TG_OP<>'INSERT' then old_version:=OLD.programme_version_id; end if;
  if TG_OP<>'DELETE' then new_version:=NEW.programme_version_id; end if;
  -- Order locks consistently when moving draft content between versions.
  perform 1 from public.programme_versions where id in(old_version,new_version) order by id for update;
  if exists(select 1 from public.programme_versions v where v.id in(old_version,new_version) and (v.status='PUBLISHED' or exists(select 1 from public.enrolments e where e.programme_version_id=v.id))) then raise exception 'Published or enrolled curriculum is immutable'; end if;
 end if;
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;

create function public.guard_enrolment_history() returns trigger language plpgsql set search_path='' as $$
declare version_status text;
begin
 if TG_OP='UPDATE' and (NEW.student_id<>OLD.student_id or NEW.cohort_id<>OLD.cohort_id or NEW.programme_version_id<>OLD.programme_version_id or NEW.enrolled_at<>OLD.enrolled_at) then
  raise exception 'Enrolment identity and curriculum history are immutable; use a new enrolment';
 end if;
 select status into version_status from public.programme_versions where id=NEW.programme_version_id for share;
 if version_status is distinct from 'PUBLISHED' then raise exception 'Enrolment requires a published programme version'; end if;
 return NEW;
end $$;
revoke all on function public.guard_enrolment_history() from public;
create trigger guard_enrolment before insert or update on public.enrolments for each row execute function public.guard_enrolment_history();

create or replace function public.validate_counsellor_assignment() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='UPDATE' then
  if NEW.student_id<>OLD.student_id or NEW.counsellor_id<>OLD.counsellor_id or NEW.starts_at<>OLD.starts_at then raise exception 'Assignment identity is immutable; create a new relationship'; end if;
  if OLD.ended_at is not null and NEW is distinct from OLD then raise exception 'Closed assignment history is immutable'; end if;
  -- Ending a relationship must remain possible after a staff role is revoked.
  if NEW.ended_at is not null then return NEW; end if;
 end if;
 if not exists(select 1 from public.role_grants where user_id=NEW.counsellor_id and role='COUNSELLOR') then raise exception 'Assigned staff must have COUNSELLOR role'; end if;
 if not exists(select 1 from public.role_grants where user_id=NEW.student_id and role='STUDENT') then raise exception 'Assigned learner must have STUDENT role'; end if;
 return NEW;
end $$;

create or replace function public.audit_institutional_change() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; following jsonb; target uuid;
begin
 if TG_OP<>'INSERT' then previous:=to_jsonb(OLD); end if;
 if TG_OP<>'DELETE' then following:=to_jsonb(NEW); end if;
 target:=coalesce(following->>'id',following->>'user_id',following->>'student_id',previous->>'id',previous->>'user_id',previous->>'student_id')::uuid;
 if TG_TABLE_NAME in ('student_support_profiles','study_plans','study_plan_items','support_followups','counsellor_interactions') then
  previous:=previous-'summary'-'study_goal'-'title';following:=following-'summary'-'study_goal'-'title';
 end if;
 insert into public.audit_events(actor_id,action,target_type,target_id,reason,before_state,after_state)
 values(public.current_app_user(),TG_OP,TG_TABLE_NAME,target,coalesce(nullif(current_setting('app.audit_reason',true),''),'Institutional service or database provisioning'),previous,following);
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
create trigger audit_change after insert or update or delete on public.programmes for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.modules for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.lessons for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.lesson_objectives for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.cohorts for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.study_plans for each row execute function public.audit_institutional_change();
