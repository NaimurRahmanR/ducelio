-- Commercial V1 checkpoint 1: admin control-plane foundations.
--
-- Additive only. Migrations 001-043 are unchanged; no user, cohort, role
-- grant, enrolment or audit row is deleted or rewritten. Every existing
-- account defaults to ACTIVE and every existing cohort to OPEN with no end
-- date and no seat limit, so current behaviour is preserved until an
-- operator deliberately changes it.
--
-- 1. Account status. app_users gains account_status (ACTIVE|DEACTIVATED).
--    public.current_app_user() -- the single identity root every RLS policy,
--    has_role() and governed RPC already derives from -- now resolves only
--    ACTIVE accounts, so a deactivated account holds no database authority
--    anywhere, while its identity, role grants and history are preserved
--    for reactivation and audit.
-- 2. Governed People authority (PLATFORM_ADMIN only): staff profile
--    create/retitle, staff role grant/revoke and account deactivation/
--    reactivation through SECURITY DEFINER RPCs. Initial Supabase Auth user
--    creation is NOT provided here: people sign up (or are provisioned by
--    the identity provider) and migration 002's provisioning trigger creates
--    their app_users row; this migration only manages existing identities.
--    STUDENT is provisioned by identity and is not grantable/revocable here.
-- 3. Last-PLATFORM_ADMIN and self-lockout protection, serialized by one
--    transaction-scoped advisory lock across every people mutation;
--    COUNSELLOR/INSTRUCTOR revocation refused while live relationships
--    still need that person; DEACTIVATED accounts can never become new
--    teaching or counselling targets (existing relationships are kept).
-- 4. Cohort lifecycle (OPEN -> CLOSED -> COMPLETED, CLOSED -> OPEN reopen),
--    optional ends_on and seat capacity, governed create/edit/status RPCs
--    (ACADEMIC_ADMIN or PLATFORM_ADMIN; REGISTRAR correction authority is
--    deliberately excluded), and database guards that keep closed/completed
--    cohorts from receiving new enrolments, orders, offers or activations.
-- 5. Bounded admin projections for the People and Cohorts surfaces.
--
-- Audit reuses existing infrastructure: role_grants and cohorts already
-- carry migration 004/005's audit_change trigger (the RPCs set
-- app.audit_reason), staff_profiles gains the same trigger, and account
-- status changes write one explicit bounded audit_events row. No secrets,
-- emails or free-form payloads enter audit state.

-- ==========================================================================
-- Section 1: account status and the identity root.
-- ==========================================================================
alter table public.app_users
  add column account_status text not null default 'ACTIVE'
    constraint app_users_account_status_check
    check (account_status in ('ACTIVE','DEACTIVATED'));

create or replace function public.current_app_user() returns uuid
language sql stable security definer set search_path='' as $$
 select u.id from public.app_users u join auth.users a on a.id=u.auth_user_id
 where a.id=auth.uid() and a.email_confirmed_at is not null and not u.is_demo
   and u.account_status='ACTIVE'
$$;

-- Lets the application distinguish "deactivated" from "no profile" without
-- granting any authority: returns only the caller's own status.
create function public.current_account_status() returns text
language sql stable security definer set search_path='' as $$
 select u.account_status from public.app_users u join auth.users a on a.id=u.auth_user_id
 where a.id=auth.uid() and a.email_confirmed_at is not null and not u.is_demo
$$;

create trigger audit_change after insert or update or delete on public.staff_profiles
for each row execute function public.audit_institutional_change();

-- ==========================================================================
-- Section 2: private helpers.
-- ==========================================================================
create schema admin_control_private;
revoke all on schema admin_control_private from public,anon,authenticated,service_role;

create function admin_control_private.require_platform_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not public.has_role('PLATFORM_ADMIN') then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return actor;
end $$;

create function admin_control_private.require_cohort_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := public.current_app_user();
begin
  if actor is null or not (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN')) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return actor;
end $$;

create function admin_control_private.reason(p_reason text) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'INVALID_INPUT';
  end if;
  return trim(p_reason);
end $$;

-- One lock serializes every role/status mutation, so two administrators
-- cannot concurrently remove each other and leave zero PLATFORM_ADMINs.
create function admin_control_private.lock_people() returns void
language sql volatile set search_path='' as $$
  select pg_advisory_xact_lock(2026100144::bigint)
$$;

-- A usable PLATFORM_ADMIN can actually sign in and act: non-demo, ACTIVE,
-- linked to a confirmed Auth identity, holding the grant.
create function admin_control_private.usable_platform_admins(p_excluding uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select count(*) from public.role_grants g
  join public.app_users u on u.id=g.user_id
  join auth.users a on a.id=u.auth_user_id
  where g.role='PLATFORM_ADMIN' and u.account_status='ACTIVE' and not u.is_demo
    and a.email_confirmed_at is not null
    and (p_excluding is null or g.user_id<>p_excluding)
$$;

create function admin_control_private.staff_role(p_role text) returns public.platform_role
language plpgsql immutable set search_path='' as $$
begin
  if p_role is null or p_role not in ('INSTRUCTOR','COUNSELLOR','ACADEMIC_ADMIN','REGISTRAR','PLATFORM_ADMIN') then
    raise exception 'UNSUPPORTED_ROLE';
  end if;
  return p_role::public.platform_role;
end $$;

create function admin_control_private.lock_person(p_user_id uuid) returns public.app_users
language plpgsql volatile security definer set search_path='' as $$
declare target public.app_users;
begin
  select * into target from public.app_users where id=p_user_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if target.is_demo then raise exception 'DEMO_ACCOUNT'; end if;
  return target;
end $$;

-- ==========================================================================
-- Section 3: governed People RPCs (PLATFORM_ADMIN only).
-- ==========================================================================
create function public.admin_set_staff_profile(p_user_id uuid,p_title text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; v_title text; target public.app_users; prior text; created boolean;
begin
  actor := admin_control_private.require_platform_admin();
  why := admin_control_private.reason(p_reason);
  v_title := trim(coalesce(p_title,''));
  if length(v_title) not between 1 and 120 then raise exception 'INVALID_INPUT'; end if;
  perform admin_control_private.lock_people();
  target := admin_control_private.lock_person(p_user_id);
  if target.account_status<>'ACTIVE' then raise exception 'ACCOUNT_DEACTIVATED'; end if;
  select s.title into prior from public.staff_profiles s where s.user_id=p_user_id for update;
  created := not found;
  if not created and prior=v_title then
    return jsonb_build_object('userId',p_user_id,'title',v_title,'created',false,'changed',false);
  end if;
  perform set_config('app.audit_reason',why,true);
  if created then
    insert into public.staff_profiles(user_id,title) values(p_user_id,v_title);
  else
    update public.staff_profiles set title=v_title where user_id=p_user_id;
  end if;
  return jsonb_build_object('userId',p_user_id,'title',v_title,'created',created,'changed',true);
end $$;

create function public.admin_grant_role(p_user_id uuid,p_role text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; wanted public.platform_role; target public.app_users; inserted integer;
begin
  actor := admin_control_private.require_platform_admin();
  why := admin_control_private.reason(p_reason);
  wanted := admin_control_private.staff_role(p_role);
  perform admin_control_private.lock_people();
  target := admin_control_private.lock_person(p_user_id);
  if target.account_status<>'ACTIVE' then raise exception 'ACCOUNT_DEACTIVATED'; end if;
  -- Staff relationships (counsellor assignments, activation instructors)
  -- reference staff_profiles, so a staff role requires a staff profile.
  if not exists(select 1 from public.staff_profiles where user_id=p_user_id) then
    raise exception 'STAFF_PROFILE_REQUIRED';
  end if;
  perform set_config('app.audit_reason',why,true);
  insert into public.role_grants(user_id,role) values(p_user_id,wanted) on conflict do nothing;
  get diagnostics inserted = row_count;
  return jsonb_build_object('userId',p_user_id,'role',wanted,'changed',inserted>0);
end $$;

create function public.admin_revoke_role(p_user_id uuid,p_role text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; wanted public.platform_role; target public.app_users;
begin
  actor := admin_control_private.require_platform_admin();
  why := admin_control_private.reason(p_reason);
  wanted := admin_control_private.staff_role(p_role);
  perform admin_control_private.lock_people();
  target := admin_control_private.lock_person(p_user_id);
  if not exists(select 1 from public.role_grants where user_id=p_user_id and role=wanted) then
    return jsonb_build_object('userId',p_user_id,'role',wanted,'changed',false);
  end if;
  if wanted='PLATFORM_ADMIN' then
    if admin_control_private.usable_platform_admins(p_user_id)=0 then
      raise exception 'LAST_PLATFORM_ADMIN';
    end if;
    if p_user_id=actor then raise exception 'SELF_LOCKOUT'; end if;
  end if;
  -- Live delivery needs its instructor's authority: an activation of a
  -- not-yet-COMPLETED cohort, or a still-SCHEDULED class session of one.
  -- Completed/cancelled history never blocks revocation.
  if wanted='INSTRUCTOR' and admin_control_private.live_teaching(p_user_id)>0 then
    raise exception 'ACTIVE_TEACHING_ASSIGNMENTS';
  end if;
  -- An active counselling relationship needs its counsellor's authority;
  -- reassign learners first (counsellor assignment workflow).
  if wanted='COUNSELLOR' and exists(
    select 1 from public.counsellor_assignments where counsellor_id=p_user_id and ended_at is null
  ) then
    raise exception 'ACTIVE_COUNSELLOR_ASSIGNMENTS';
  end if;
  perform set_config('app.audit_reason',why,true);
  delete from public.role_grants where user_id=p_user_id and role=wanted;
  return jsonb_build_object('userId',p_user_id,'role',wanted,'changed',true);
end $$;

create function public.admin_set_account_status(p_user_id uuid,p_status text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; target public.app_users;
begin
  actor := admin_control_private.require_platform_admin();
  why := admin_control_private.reason(p_reason);
  if p_status is null or p_status not in ('ACTIVE','DEACTIVATED') then raise exception 'INVALID_INPUT'; end if;
  perform admin_control_private.lock_people();
  target := admin_control_private.lock_person(p_user_id);
  if target.account_status=p_status then
    return jsonb_build_object('userId',p_user_id,'status',p_status,'changed',false);
  end if;
  if p_status='DEACTIVATED' then
    if exists(select 1 from public.role_grants where user_id=p_user_id and role='PLATFORM_ADMIN')
      and admin_control_private.usable_platform_admins(p_user_id)=0 then
      raise exception 'LAST_PLATFORM_ADMIN';
    end if;
    if p_user_id=actor then raise exception 'SELF_LOCKOUT'; end if;
  end if;
  update public.app_users set account_status=p_status where id=p_user_id;
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,before_state,after_state)
  values(actor,case when p_status='DEACTIVATED' then 'ACCOUNT_DEACTIVATED' else 'ACCOUNT_REACTIVATED' end,
    'app_users',p_user_id,'ADMIN_PEOPLE_V1',why,
    jsonb_build_object('account_status',target.account_status),jsonb_build_object('account_status',p_status));
  return jsonb_build_object('userId',p_user_id,'status',p_status,'changed',true);
end $$;

-- Bounded People projection. With no query: every non-demo user holding a
-- staff profile or a non-STUDENT role. With a query: display-name substring
-- or exact (case-insensitive) email match. Email is returned only to
-- PLATFORM_ADMIN so an operator can tell same-named accounts apart; no
-- support, learner-record or credential data is included.
create function public.admin_list_people(p_query text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare q text;
begin
  perform admin_control_private.require_platform_admin();
  q := nullif(trim(coalesce(p_query,'')),'');
  if q is not null and length(q)>100 then raise exception 'INVALID_INPUT'; end if;
  return jsonb_build_object(
    'usablePlatformAdmins',admin_control_private.usable_platform_admins(null),
    'people',(select coalesce(jsonb_agg(v.item order by v.name,v.id),'[]') from (
      select u.id,u.display_name name,jsonb_build_object(
        'id',u.id,'displayName',u.display_name,'email',a.email,
        'emailConfirmed',a.email_confirmed_at is not null,
        'accountStatus',u.account_status,
        'staffTitle',(select s.title from public.staff_profiles s where s.user_id=u.id),
        'isStudent',exists(select 1 from public.student_profiles p where p.user_id=u.id),
        'roles',(select coalesce(jsonb_agg(g.role::text order by g.role::text),'[]') from public.role_grants g where g.user_id=u.id),
        'liveTeaching',admin_control_private.live_teaching(u.id),
        'activeCounselling',(select count(*) from public.counsellor_assignments ca where ca.counsellor_id=u.id and ca.ended_at is null),
        'createdAt',u.created_at) item
      from public.app_users u join auth.users a on a.id=u.auth_user_id
      where not u.is_demo and (
        case when q is null then
          exists(select 1 from public.staff_profiles s where s.user_id=u.id)
          or exists(select 1 from public.role_grants g where g.user_id=u.id and g.role<>'STUDENT')
        else
          position(lower(q) in lower(u.display_name))>0 or lower(coalesce(a.email,''))=lower(q)
        end)
      order by u.display_name,u.id limit 100) v));
end $$;

-- ==========================================================================
-- Section 4: cohort lifecycle.
-- ==========================================================================
alter table public.cohorts
  add column status text not null default 'OPEN'
    constraint cohorts_status_check check (status in ('OPEN','CLOSED','COMPLETED')),
  add column ends_on date,
  add column capacity integer
    constraint cohorts_capacity_check check (capacity is null or capacity between 1 and 10000),
  add constraint cohorts_ends_after_start check (ends_on is null or ends_on>=starts_on);

-- Live delivery relationships that still need this instructor.
create function admin_control_private.live_teaching(p_user_id uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select (select count(*) from public.course_activations a join public.cohorts c on c.id=a.cohort_id
          where a.instructor_id=p_user_id and c.status<>'COMPLETED')
       + (select count(*) from public.class_sessions s join public.cohorts c on c.id=s.cohort_id
          where s.instructor_id=p_user_id and s.status='SCHEDULED' and c.status<>'COMPLETED')
$$;

-- Applies to every writer, including privileged ones: identity and
-- curriculum version never move, lifecycle only moves forward (plus an
-- explicit reopen of a CLOSED cohort), and a COMPLETED cohort is frozen.
create function admin_control_private.guard_cohort() returns trigger
language plpgsql set search_path='' as $$
begin
  if NEW.id<>OLD.id or NEW.programme_version_id<>OLD.programme_version_id then
    raise exception 'Cohort identity and programme version are immutable';
  end if;
  if OLD.status='COMPLETED' and NEW is distinct from OLD then
    raise exception 'COHORT_COMPLETED';
  end if;
  if NEW.status<>OLD.status and not (
    (OLD.status='OPEN' and NEW.status='CLOSED') or
    (OLD.status='CLOSED' and NEW.status in ('OPEN','COMPLETED'))
  ) then
    raise exception 'INVALID_TRANSITION';
  end if;
  return NEW;
end $$;
create trigger guard_cohort_lifecycle before update on public.cohorts
for each row execute function admin_control_private.guard_cohort();

-- Verified paid fulfilment marker. fulfill_commercial_v1_order (migration
-- 034) is the ONLY writer of commercial_v1_payment_events, and it writes a
-- row only after its signed (HMAC) payment claim verified and the session,
-- amount and currency matched the order -- and before its enrolment insert.
-- This AFTER trigger turns that verified PAID evidence into a transaction-
-- local marker naming the order. A failed or duplicate insert never fires
-- it, and the marker ends with the transaction, so an ordinary admin
-- enrolment (its own transaction) can never carry it. Any later change to
-- fulfill_commercial_v1_order must keep recording PAID evidence before the
-- enrolment insert (tests/admin-control-plane-db.test.ts enforces this).
create function admin_control_private.mark_verified_paid_order() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if NEW.status='PAID' then
    perform set_config('admin_control.verified_paid_order',NEW.order_id::text,true);
  end if;
  return NEW;
end $$;
create trigger mark_verified_paid_order after insert on public.commercial_v1_payment_events
for each row execute function admin_control_private.mark_verified_paid_order();

-- New enrolments need an OPEN cohort with a free seat. The only exception
-- is verified paid fulfilment of an order that began while the cohort was
-- OPEN with a free seat (orders cannot be created otherwise, guard below):
-- refusing it would roll back the verified payment evidence. The exception
-- requires BOTH this transaction's verified-payment marker for an order of
-- this exact learner, cohort and version AND durable PAID evidence matching
-- that order's session, amount and currency. A pending, unpaid checkout
-- grants nothing. An idempotent replay of an existing enrolment is left to
-- the caller's ON CONFLICT handling.
create function admin_control_private.guard_cohort_enrolment() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.cohorts; seats bigint; marker text;
begin
  if exists(select 1 from public.enrolments where student_id=NEW.student_id and cohort_id=NEW.cohort_id) then
    return NEW;
  end if;
  -- Share lock first (conflicts with a concurrent status change), then the
  -- per-cohort seat lock, matching create_enrolment's own lock order.
  select * into c from public.cohorts where id=NEW.cohort_id for share;
  if not found then return NEW; end if;
  perform pg_advisory_xact_lock(44,hashtext(NEW.cohort_id::text));
  marker := current_setting('admin_control.verified_paid_order',true);
  if marker ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists(
    select 1 from public.commercial_v1_orders o
    where o.id=marker::uuid and o.learner_id=NEW.student_id and o.cohort_id=NEW.cohort_id
      and o.programme_version_id=NEW.programme_version_id and o.state='PENDING'
      and exists(select 1 from public.commercial_v1_payment_events pe
        where pe.order_id=o.id and pe.status='PAID' and pe.session_id=o.provider_session_id
          and pe.amount_minor=o.amount_minor and pe.currency=o.currency)
  ) then
    return NEW;
  end if;
  if c.status<>'OPEN' then raise exception 'COHORT_NOT_OPEN'; end if;
  if c.capacity is not null then
    select count(*) into seats from public.enrolments where cohort_id=NEW.cohort_id and status<>'WITHDRAWN';
    if seats>=c.capacity then raise exception 'COHORT_FULL'; end if;
  end if;
  return NEW;
end $$;
create trigger guard_cohort_enrolment before insert on public.enrolments
for each row execute function admin_control_private.guard_cohort_enrolment();

create function admin_control_private.guard_cohort_order() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.cohorts; seats bigint;
begin
  select * into c from public.cohorts where id=NEW.cohort_id for share;
  if not found then return NEW; end if;
  if c.status<>'OPEN' then raise exception 'COHORT_NOT_OPEN'; end if;
  if c.capacity is not null then
    select count(*) into seats from public.enrolments where cohort_id=NEW.cohort_id and status<>'WITHDRAWN';
    if seats>=c.capacity then raise exception 'COHORT_FULL'; end if;
  end if;
  return NEW;
end $$;
create trigger guard_cohort_order before insert on public.commercial_v1_orders
for each row execute function admin_control_private.guard_cohort_order();

create function admin_control_private.guard_cohort_offer() returns trigger
language plpgsql security definer set search_path='' as $$
declare cohort_status text;
begin
  select c.status into cohort_status from public.course_activations a
  join public.cohorts c on c.id=a.cohort_id where a.id=NEW.activation_id for share of c;
  if cohort_status is distinct from 'OPEN' then raise exception 'COHORT_NOT_OPEN'; end if;
  return NEW;
end $$;
create trigger guard_cohort_offer before insert on public.commercial_v1_offers
for each row execute function admin_control_private.guard_cohort_offer();

-- A CLOSED cohort may still be activated for its existing learners; a
-- COMPLETED cohort's delivery is over.
create function admin_control_private.guard_cohort_activation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.cohorts where id=NEW.cohort_id and status='COMPLETED') then
    raise exception 'COHORT_COMPLETED';
  end if;
  return NEW;
end $$;
create trigger guard_cohort_activation before insert on public.course_activations
for each row execute function admin_control_private.guard_cohort_activation();

create function admin_control_private.cohort_fields(p_title text,p_starts_on date,p_ends_on date,p_capacity integer) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_title is null or length(trim(p_title)) not between 1 and 200 or p_starts_on is null
    or (p_ends_on is not null and p_ends_on<p_starts_on)
    or (p_capacity is not null and p_capacity not between 1 and 10000) then
    raise exception 'INVALID_INPUT';
  end if;
  return trim(p_title);
end $$;

-- A DEACTIVATED account keeps its grants for history and reactivation but
-- must never become a NEW teaching or counselling target. Applies to every
-- writer. Existing relationships are never rewritten by deactivation; they
-- stay intact and are surfaced on the People page for reassignment.
create function admin_control_private.guard_active_staff_target() returns trigger
language plpgsql security definer set search_path='' as $$
declare target uuid := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
begin
  if TG_OP='UPDATE' and target is not distinct from (to_jsonb(OLD)->>TG_ARGV[0])::uuid then
    return NEW;
  end if;
  if exists(select 1 from public.app_users where id=target and account_status<>'ACTIVE') then
    raise exception 'STAFF_DEACTIVATED';
  end if;
  return NEW;
end $$;
create trigger guard_active_instructor before insert or update of instructor_id on public.course_activations
for each row execute function admin_control_private.guard_active_staff_target('instructor_id');
create trigger guard_active_instructor before insert or update of instructor_id on public.class_sessions
for each row execute function admin_control_private.guard_active_staff_target('instructor_id');
create trigger guard_active_instructor before insert or update of instructor_id on public.assignments
for each row execute function admin_control_private.guard_active_staff_target('instructor_id');
create trigger guard_active_instructor before insert or update of instructor_id on public.assessments
for each row execute function admin_control_private.guard_active_staff_target('instructor_id');
create trigger guard_active_counsellor before insert or update of counsellor_id on public.counsellor_assignments
for each row execute function admin_control_private.guard_active_staff_target('counsellor_id');

-- Bounded pickers used by existing admin workflows offer ACTIVE staff only
-- (same signatures, authority and ordering as migrations 008/009/027).
create or replace function public.list_assignable_counsellors()
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
    and u.account_status = 'ACTIVE'
  order by u.display_name, s.user_id
$$;

create or replace function public.list_assignable_instructors()
returns table(user_id uuid, display_name text, title text)
language sql stable security definer set search_path='' as $$
  select s.user_id, u.display_name, s.title
  from public.staff_profiles s
  join public.app_users u on u.id = s.user_id
  join public.role_grants r on r.user_id = s.user_id and r.role = 'INSTRUCTOR'
  where public.current_app_user() is not null
    and public.is_academic_admin()
    and u.account_status = 'ACTIVE'
  order by u.display_name, s.user_id
$$;

-- Also omits COMPLETED cohorts, which refuse activation.
create or replace function public.get_course_activation_options(p_import_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare imp public.course_package_imports; begin
 perform course_activation_private.require_admin();
 if p_import_id is not null then
  select * into imp from public.course_package_imports where id=p_import_id and status in ('APPLIED','PUBLISHED') and exists(select 1 from public.programme_versions v where v.id=programme_version_id and v.status='PUBLISHED');
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
 end if;
 return jsonb_build_object(
 'packages',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',i.id,'key',i.package_key,'revision',i.package_revision) item from public.course_package_imports i join public.programme_versions p on p.id=i.programme_version_id where i.status in ('APPLIED','PUBLISHED') and p.status='PUBLISHED' order by i.created_at desc,i.id limit 100) v),
 'cohorts',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',c.id,'title',c.title) item from public.cohorts c where programme_version_id=imp.programme_version_id and c.status<>'COMPLETED' order by c.starts_on,c.id limit 200) v),
 'instructors',(select coalesce(jsonb_agg(v.item),'[]') from (select jsonb_build_object('id',s.user_id,'name',u.display_name) item from public.staff_profiles s join public.app_users u on u.id=s.user_id where exists(select 1 from public.role_grants g where g.user_id=s.user_id and g.role='INSTRUCTOR') and u.account_status='ACTIVE' order by u.display_name,s.user_id limit 200) v),
 'assignments',(select coalesce(jsonb_agg(jsonb_build_object('templateKey',x->>'key','title',x->>'title') order by x->>'key'),'[]') from jsonb_array_elements(imp.raw_package->'assignmentTemplates') x),
 'assessments',(select coalesce(jsonb_agg(jsonb_build_object('templateKey',x->>'key','title',x->>'title') order by x->>'key'),'[]') from jsonb_array_elements(imp.raw_package->'assessmentTemplates') x));
end $$;

-- ==========================================================================
-- Section 5: governed cohort RPCs (ACADEMIC_ADMIN or PLATFORM_ADMIN).
-- ==========================================================================
create function public.admin_create_cohort(
  p_programme_version_id uuid,p_title text,p_starts_on date,p_ends_on date,p_capacity integer,p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; v_title text; v public.programme_versions; prior public.cohorts; result uuid;
begin
  actor := admin_control_private.require_cohort_admin();
  why := admin_control_private.reason(p_reason);
  v_title := admin_control_private.cohort_fields(p_title,p_starts_on,p_ends_on,p_capacity);
  select * into v from public.programme_versions where id=p_programme_version_id for share;
  if not found then raise exception 'VERSION_NOT_FOUND'; end if;
  if v.status<>'PUBLISHED' then raise exception 'VERSION_NOT_PUBLISHED'; end if;
  if v.is_demo then raise exception 'DEMO_VERSION'; end if;
  -- Idempotent replay: the same version/title/start is the same cohort.
  perform pg_advisory_xact_lock(45,hashtext(p_programme_version_id::text));
  select * into prior from public.cohorts c
  where c.programme_version_id=p_programme_version_id and lower(c.title)=lower(v_title) and c.starts_on=p_starts_on
  order by c.id limit 1;
  if found then
    if prior.ends_on is distinct from p_ends_on or prior.capacity is distinct from p_capacity then
      raise exception 'COHORT_CONFLICT';
    end if;
    return prior.id;
  end if;
  perform set_config('app.audit_reason',why,true);
  insert into public.cohorts(programme_version_id,title,starts_on,ends_on,capacity)
  values(p_programme_version_id,v_title,p_starts_on,p_ends_on,p_capacity) returning id into result;
  return result;
end $$;

-- Title, end date and capacity stay editable until completion (enrolments
-- keep their own title/start snapshots). The start date drives delivery
-- scheduling, so it is frozen once any enrolment or activation exists.
create function public.admin_update_cohort(
  p_cohort_id uuid,p_title text,p_starts_on date,p_ends_on date,p_capacity integer,p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; v_title text; c public.cohorts; seats bigint;
begin
  actor := admin_control_private.require_cohort_admin();
  why := admin_control_private.reason(p_reason);
  v_title := admin_control_private.cohort_fields(p_title,p_starts_on,p_ends_on,p_capacity);
  select * into c from public.cohorts where id=p_cohort_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if c.status='COMPLETED' then raise exception 'COHORT_COMPLETED'; end if;
  if p_starts_on<>c.starts_on and (
    exists(select 1 from public.enrolments where cohort_id=p_cohort_id)
    or exists(select 1 from public.course_activations where cohort_id=p_cohort_id)
  ) then
    raise exception 'STARTS_ON_LOCKED';
  end if;
  if p_capacity is not null then
    select count(*) into seats from public.enrolments where cohort_id=p_cohort_id and status<>'WITHDRAWN';
    if p_capacity<seats then raise exception 'CAPACITY_BELOW_ENROLMENT'; end if;
  end if;
  if c.title=v_title and c.starts_on=p_starts_on and c.ends_on is not distinct from p_ends_on
    and c.capacity is not distinct from p_capacity then
    return p_cohort_id;
  end if;
  perform set_config('app.audit_reason',why,true);
  update public.cohorts set title=v_title,starts_on=p_starts_on,ends_on=p_ends_on,capacity=p_capacity
  where id=p_cohort_id;
  return p_cohort_id;
end $$;

-- Closing ends new commercial/enrolment activity: the cohort's published
-- offers are archived in the same transaction (orders, entitlements and
-- enrolments are untouched). Completion never alters learner records.
create function public.admin_change_cohort_status(p_cohort_id uuid,p_status text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; why text; c public.cohorts; archived uuid[] := '{}'; offer record;
begin
  actor := admin_control_private.require_cohort_admin();
  why := admin_control_private.reason(p_reason);
  if p_status is null or p_status not in ('OPEN','CLOSED','COMPLETED') then raise exception 'INVALID_INPUT'; end if;
  select * into c from public.cohorts where id=p_cohort_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if c.status=p_status then
    return jsonb_build_object('cohortId',p_cohort_id,'status',p_status,'changed',false,'archivedOfferIds','[]'::jsonb);
  end if;
  if c.status='COMPLETED' then raise exception 'COHORT_COMPLETED'; end if;
  if not ((c.status='OPEN' and p_status='CLOSED') or (c.status='CLOSED' and p_status in ('OPEN','COMPLETED'))) then
    raise exception 'INVALID_TRANSITION';
  end if;
  perform set_config('app.audit_reason',why,true);
  if p_status='CLOSED' then
    for offer in
      update public.commercial_v1_offers o set state='ARCHIVED'
      where o.state='PUBLISHED' and o.activation_id in (select a.id from public.course_activations a where a.cohort_id=p_cohort_id)
      returning o.id,o.slug
    loop
      archived := archived||offer.id;
      insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
      values(actor,'COMMERCIAL_V1_OFFER_ARCHIVED','commercial_v1_offers',offer.id,'ADMIN_COHORTS_V1',why,
        jsonb_build_object('offer_id',offer.id,'slug',offer.slug,'cohort_id',p_cohort_id,'trigger','COHORT_CLOSED'));
    end loop;
  end if;
  update public.cohorts set status=p_status where id=p_cohort_id;
  return jsonb_build_object('cohortId',p_cohort_id,'status',p_status,'changed',true,'archivedOfferIds',to_jsonb(archived));
end $$;

-- Bounded Cohorts projection: lifecycle, linkage and enrolment counts only.
create function public.admin_cohort_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform admin_control_private.require_cohort_admin();
  return jsonb_build_object(
    'cohorts',(select coalesce(jsonb_agg(v.item order by v.starts_on desc,v.id),'[]') from (
      select c.id,c.starts_on,jsonb_build_object(
        'id',c.id,'title',c.title,'startsOn',c.starts_on,'endsOn',c.ends_on,'capacity',c.capacity,'status',c.status,
        'programmeVersionId',c.programme_version_id,
        'programmeTitle',coalesce(pv.title_snapshot,p.title),'versionLabel',pv.label,'isDemo',pv.is_demo,
        'enrolments',jsonb_build_object(
          'active',(select count(*) from public.enrolments e where e.cohort_id=c.id and e.status='ACTIVE'),
          'paused',(select count(*) from public.enrolments e where e.cohort_id=c.id and e.status='PAUSED'),
          'completed',(select count(*) from public.enrolments e where e.cohort_id=c.id and e.status='COMPLETED'),
          'withdrawn',(select count(*) from public.enrolments e where e.cohort_id=c.id and e.status='WITHDRAWN')),
        'activationId',(select a.id from public.course_activations a where a.cohort_id=c.id),
        'publishedOfferSlug',(select o.slug from public.commercial_v1_offers o join public.course_activations a on a.id=o.activation_id
          where a.cohort_id=c.id and o.state='PUBLISHED' order by o.published_at desc limit 1)) item
      from public.cohorts c join public.programme_versions pv on pv.id=c.programme_version_id
      join public.programmes p on p.id=pv.programme_id
      order by c.starts_on desc,c.id limit 200) v),
    'versions',(select coalesce(jsonb_agg(v.item order by v.name,v.label,v.id),'[]') from (
      select pv.id,coalesce(pv.title_snapshot,p.title) name,pv.label,jsonb_build_object(
        'id',pv.id,'programmeTitle',coalesce(pv.title_snapshot,p.title),'label',pv.label) item
      from public.programme_versions pv join public.programmes p on p.id=pv.programme_id
      where pv.status='PUBLISHED' and not pv.is_demo
      order by 2,pv.label,pv.id limit 200) v));
end $$;

-- Roster from the canonical enrolments table (no second source of truth).
create function public.admin_cohort_roster(p_cohort_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.cohorts;
begin
  perform admin_control_private.require_cohort_admin();
  select * into c from public.cohorts where id=p_cohort_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object(
    'cohortId',c.id,'title',c.title,'status',c.status,'capacity',c.capacity,
    'total',(select count(*) from public.enrolments e where e.cohort_id=c.id),
    'enrolments',(select coalesce(jsonb_agg(v.item order by v.enrolled_at,v.id),'[]') from (
      select e.id,e.enrolled_at,jsonb_build_object(
        'enrolmentId',e.id,'studentId',e.student_id,'displayName',u.display_name,
        'studentNumber',s.student_number,'status',e.status,'enrolledAt',e.enrolled_at) item
      from public.enrolments e join public.student_profiles s on s.user_id=e.student_id
      join public.app_users u on u.id=e.student_id
      where e.cohort_id=c.id order by e.enrolled_at,e.id limit 500) v));
end $$;

-- ==========================================================================
-- Section 6: explicit ACLs and effective-privilege acceptance.
-- ==========================================================================
do $$ declare f regprocedure; t regclass; r text; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='admin_control_private'
      or (n.nspname='public' and p.proname in ('current_account_status','admin_set_staff_profile','admin_grant_role',
        'admin_revoke_role','admin_set_account_status','admin_list_people','admin_create_cohort','admin_update_cohort',
        'admin_change_cohort_status','admin_cohort_workspace','admin_cohort_roster')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('current_account_status','admin_set_staff_profile','admin_grant_role',
      'admin_revoke_role','admin_set_account_status','admin_list_people','admin_create_cohort','admin_update_cohort',
      'admin_change_cohort_status','admin_cohort_workspace','admin_cohort_roster') loop
    execute format('grant execute on function %s to authenticated',f);
  end loop;
  -- Mutation remains RPC-only: no client role may write these tables.
  foreach t in array array['public.app_users','public.role_grants','public.staff_profiles','public.cohorts',
    'public.enrolments','public.audit_events']::regclass[] loop
    foreach r in array array['anon','authenticated'] loop
      if has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE') then
        raise exception 'Unsafe admin control-plane privileges on %',t;
      end if;
    end loop;
  end loop;
end $$;
