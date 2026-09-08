-- Serialize support writes and reassignment on the learner row.
create function public.validate_counsellor_assignment() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.role_grants where user_id=NEW.counsellor_id and role='COUNSELLOR') then raise exception 'Assigned staff must have COUNSELLOR role'; end if;
 if not exists(select 1 from public.role_grants where user_id=NEW.student_id and role='STUDENT') then raise exception 'Assigned learner must have STUDENT role'; end if;
 return NEW;
end $$;
revoke all on function public.validate_counsellor_assignment() from public;
create trigger validate_counsellor before insert or update on public.counsellor_assignments for each row execute function public.validate_counsellor_assignment();

create function public.audit_institutional_change() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; following jsonb; target uuid;
begin
 if TG_OP<>'INSERT' then previous:=to_jsonb(OLD); end if;
 if TG_OP<>'DELETE' then following:=to_jsonb(NEW); end if;
 target:=coalesce(following->>'id',following->>'user_id',following->>'student_id',previous->>'id',previous->>'user_id',previous->>'student_id')::uuid;
 if TG_TABLE_NAME in ('student_support_profiles','study_plan_items','support_followups','counsellor_interactions') then
  previous:=previous-'summary'-'study_goal'-'title';following:=following-'summary'-'study_goal'-'title';
 end if;
 insert into public.audit_events(actor_id,action,target_type,target_id,reason,before_state,after_state)
 values(public.current_app_user(),TG_OP,TG_TABLE_NAME,target,coalesce(nullif(current_setting('app.audit_reason',true),''),'Institutional service or database provisioning'),previous,following);
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
revoke all on function public.audit_institutional_change() from public;

create function public.create_study_plan_item(p_plan_id uuid,p_student_id uuid,p_title text,p_due_on date) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 perform 1 from public.student_profiles where user_id=p_student_id for update;
 if not public.can_support(p_student_id) then raise exception 'Access denied' using errcode='42501'; end if;
 if not exists(select 1 from public.study_plans where id=p_plan_id and student_id=p_student_id and status='ACTIVE') then raise exception 'An active study plan is required'; end if;
 perform set_config('app.audit_reason','Study plan item created',true);
 insert into public.study_plan_items(plan_id,student_id,title,due_on,created_by)
 values(p_plan_id,p_student_id,trim(p_title),p_due_on,public.current_app_user()) returning id into result;
 return result;
end $$;
create function public.create_support_followup(p_student_id uuid,p_event_id uuid,p_title text,p_due_on date) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 perform 1 from public.student_profiles where user_id=p_student_id for update;
 if not public.is_assigned_counsellor(p_student_id) then raise exception 'Access denied' using errcode='42501'; end if;
 perform set_config('app.audit_reason','Counsellor follow-up created',true);
 insert into public.support_followups(student_id,event_id,title,due_on,created_by) values(p_student_id,p_event_id,trim(p_title),p_due_on,public.current_app_user()) returning id into result;
 return result;
end $$;
create function public.record_counsellor_interaction(p_student_id uuid,p_summary text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 perform 1 from public.student_profiles where user_id=p_student_id for update;
 if not public.is_assigned_counsellor(p_student_id) then raise exception 'Access denied' using errcode='42501'; end if;
 perform set_config('app.audit_reason','Counsellor interaction recorded',true);
 insert into public.counsellor_interactions(student_id,counsellor_id,summary) values(p_student_id,public.current_app_user(),trim(p_summary)) returning id into result;
 return result;
end $$;
create function public.assign_counsellor(p_student_id uuid,p_counsellor_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 if not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then raise exception 'Access denied' using errcode='42501'; end if;
 if length(trim(p_reason)) not between 5 and 300 or p_reason is null then raise exception 'A bounded assignment reason is required'; end if;
 perform 1 from public.student_profiles where user_id=p_student_id for update;
 if not found then raise exception 'Learner not found'; end if;
 select id into result from public.counsellor_assignments where student_id=p_student_id and counsellor_id=p_counsellor_id and starts_at<=now() and ended_at is null;
 if result is not null then return result; end if;
 perform set_config('app.audit_reason',p_reason,true);
 update public.counsellor_assignments set ended_at=now() where student_id=p_student_id and ended_at is null;
 insert into public.counsellor_assignments(student_id,counsellor_id) values(p_student_id,p_counsellor_id) returning id into result;
 return result;
end $$;
create trigger audit_change after insert or update or delete on public.role_grants for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.enrolments for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.programme_versions for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.counsellor_assignments for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.student_support_profiles for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.study_plan_items for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.support_events for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.support_followups for each row execute function public.audit_institutional_change();
create trigger audit_change after insert or update or delete on public.counsellor_interactions for each row execute function public.audit_institutional_change();
revoke all on function public.create_study_plan_item(uuid,uuid,text,date) from public;
grant execute on function public.create_study_plan_item(uuid,uuid,text,date) to authenticated;
revoke all on function public.create_support_followup(uuid,uuid,text,date) from public;
grant execute on function public.create_support_followup(uuid,uuid,text,date) to authenticated;
revoke all on function public.record_counsellor_interaction(uuid,text) from public;
grant execute on function public.record_counsellor_interaction(uuid,text) to authenticated;
revoke all on function public.assign_counsellor(uuid,uuid,text) from public;
grant execute on function public.assign_counsellor(uuid,uuid,text) to authenticated;
