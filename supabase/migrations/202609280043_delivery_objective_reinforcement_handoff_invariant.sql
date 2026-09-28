-- Delivery -- OBJECTIVE_REINFORCEMENT handoffs require an objective.
-- Forward-only; no historical migration is modified and no existing row is
-- touched.
--
-- Defect this closes (found by the first hosted FULL_CUSTOMER_JOURNEY
-- acceptance run, 1790630225143-vf2w0i): migration 023's
-- public.request_delivery_handoff accepted reason_code
-- 'OBJECTIVE_REINFORCEMENT' with a NULL p_objective_id and persisted a
-- learner-owned TUTOR handoff, but migration 028's
-- begin_tutor_lab_content_release -- the only execution path for a TUTOR
-- handoff -- correctly refuses exactly that shape with INVALID_INPUT. The
-- handoff was therefore unconsumable: the learner's Tutor support request
-- could only ever end UNAVAILABLE, before any provider execution.
--
-- Fix: the authoritative RPC now refuses that shape with INVALID_INPUT
-- before any handoff row is created (the application-domain handoffInput
-- schema enforces the same rule). Everything else is byte-for-byte the
-- migration 023 body: ownership derivation, the EXPLAIN/activity firewall,
-- lesson/objective ownership validation, idempotency identity and replay,
-- limits, destination derivation, summaries and the ACL.
--
-- Deliberately NOT added: a validated table CHECK on delivery_handoffs.
-- Immutable historical rows of this shape already exist (the hosted
-- acceptance run above created one), and they must not be rewritten or
-- deleted; such rows remain unconsumable by the Tutor authority exactly as
-- before, and no new one can be created.
create or replace function public.request_delivery_handoff(p_enrolment_id uuid,p_lesson_id uuid,p_objective_id uuid,p_reason_code text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.enrolments; prior public.delivery_handoffs; result uuid; destination text; summary text;
begin
  e:=delivery_private.enrolment(p_enrolment_id,false,true);
  if not public.academic_content_release_explain_allowed() then raise exception 'ACTIVITY_BLOCKED'; end if;
  if p_request_id is null or p_reason_code is null or p_reason_code not in ('MISSED_LESSON_PRACTICE','OBJECTIVE_REINFORCEMENT','PRACTICAL_PREREQUISITE','PRACTICAL_HELP') then raise exception 'INVALID_INPUT'; end if;
  -- Migration 043: an objective-reinforcement handoff names its objective.
  if p_reason_code='OBJECTIVE_REINFORCEMENT' and p_objective_id is null then raise exception 'INVALID_INPUT'; end if;
  if not exists(select 1 from public.lessons where id=p_lesson_id and programme_version_id=e.programme_version_id)
    or (p_objective_id is not null and not exists(select 1 from public.lesson_objectives where id=p_objective_id and lesson_id=p_lesson_id and programme_version_id=e.programme_version_id)) then
    raise exception 'NOT_FOUND_OR_FORBIDDEN' using errcode='42501'; end if;
  select * into prior from public.delivery_handoffs where requested_by=e.student_id and request_id=p_request_id;
  if prior.id is not null then
    if prior.enrolment_id=e.id and prior.lesson_id=p_lesson_id and prior.objective_id is not distinct from p_objective_id and prior.reason_code=p_reason_code then return prior.id; end if;
    raise exception 'CONTEXT_CONFLICT';
  end if;
  if (select count(*) from public.delivery_handoffs where enrolment_id=e.id and status='OPEN')>=20
    or (select count(*) from public.delivery_handoffs where enrolment_id=e.id)>=250 then raise exception 'LIMIT_EXCEEDED'; end if;
  destination:=case when p_reason_code='PRACTICAL_HELP' then 'LAB_INSTRUCTOR' else 'TUTOR' end;
  summary:=case p_reason_code when 'MISSED_LESSON_PRACTICE' then 'Learner requests practice for missed material.'
    when 'OBJECTIVE_REINFORCEMENT' then 'Learner requests objective reinforcement.'
    when 'PRACTICAL_PREREQUISITE' then 'Learner requests conceptual preparation for a practical.' else 'Learner requests practical support.' end;
  insert into public.delivery_handoffs(enrolment_id,requested_by,request_id,initiator_kind,destination_profile,reason_code,lesson_id,objective_id,summary)
  values(e.id,e.student_id,p_request_id,'LEARNER',destination,p_reason_code,p_lesson_id,p_objective_id,summary) returning id into result;
  return result;
end $$;
revoke all on function public.request_delivery_handoff(uuid,uuid,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_delivery_handoff(uuid,uuid,uuid,text,uuid) to authenticated;

-- Effective-privilege acceptance, mirroring migration 023's own check for
-- this function (authenticated only).
do $$ declare r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='request_delivery_handoff' loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from (r='authenticated') then
        raise exception 'Unsafe effective delivery handoff function privileges for %', r;
      end if;
    end loop;
  end loop;
end $$;
