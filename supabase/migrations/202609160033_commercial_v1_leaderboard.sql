-- Commercial V1 PR12: immutable leaderboard snapshots, deterministic dense
-- ranking, publication authority and bounded learner-safe projection.
-- Additive only; migrations 001-032 are byte-for-byte unchanged. PR12
-- creates/modifies NO marks: it consumes the authoritative Commercial V1
-- result state PR11A (migration 030)/PR11B1 (031)/PR11B2 (032) already
-- established, and reuses migration 030's own current-result resolution
-- (commercial_v1_private.current_assessment_result / current_lab_result /
-- course_progress) directly rather than reimplementing a competing
-- definition of CURRENT. A malformed highest revision is invisible to a
-- leaderboard for the exact same reason it is invisible to completion:
-- current_assessment_result/current_lab_result already return NULL for it,
-- and course_progress already reports it as PENDING -- this migration adds
-- no parallel validity logic.
--
-- A published snapshot is an immutable institutional record: publication
-- MATERIALIZES the eligible cohort ranking at that moment into append-only
-- snapshot + entry rows. Nothing here recomputes ranks in place when
-- underlying results later change (e.g. a PR11B2 regrade) -- a later
-- institutional process that wants a fresh ranking publishes a NEW,
-- separate snapshot; the old one remains historical truth forever.
--
-- Tie rule (explicit product decision, confirmed with the requester):
-- DENSE ranking (1,2,2,3) -- no rank number is ever skipped by a tie.
--
-- V2 correction pass (independent review): (A) publication now locks its
-- complete eligible-enrolment scope, in deterministic id order, before any
-- score is derived, serializing against a concurrent regrade or enrolment
-- status transition; (B) the ranking population is frozen to ACTIVE,
-- PAUSED and COMPLETED enrolments (WITHDRAWN excluded); (C) publication
-- also fails closed while any bound formal component's real assessment
-- window has not yet closed; (D) the learner projection never discloses a
-- real peer display name or another learner's enrolment id -- only a
-- deterministic pseudonymous label; (E) the learner-read RPC itself
-- enforces current STUDENT authority, self-ownership and snapshot
-- membership, not merely the Next.js page; (F) latest-snapshot selection
-- and lab provenance iteration are both made explicitly deterministic.

-- ==========================================================================
-- Section 1: immutable snapshot + entry storage.
-- ==========================================================================
create table public.commercial_v1_leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  activation_id uuid not null references public.course_activations(id),
  cohort_id uuid not null,
  programme_version_id uuid not null,
  policy_version text not null default 'COMMERCIAL_V1_LEADERBOARD_V1' check(policy_version='COMMERCIAL_V1_LEADERBOARD_V1'),
  entry_count integer not null check(entry_count>0),
  reason text not null check(length(trim(reason)) between 5 and 300),
  published_by uuid not null references public.app_users(id),
  published_at timestamptz not null default clock_timestamp(),
  -- V2 correction (item F): a real, strictly monotonic publication-order
  -- tiebreaker -- never rely on published_at alone, which could in theory
  -- collide. bigserial values are assigned in call order, so ordering by
  -- this column is always a true, deterministic publication order.
  publication_sequence bigserial not null
);
create index leaderboard_snapshots_activation
  on public.commercial_v1_leaderboard_snapshots(activation_id,published_at desc,publication_sequence desc);
alter table public.commercial_v1_leaderboard_snapshots enable row level security;
revoke all on public.commercial_v1_leaderboard_snapshots from public,anon,authenticated,service_role;

create function commercial_v1_private.leaderboard_append_only() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'This Commercial V1 leaderboard record is append-only'; end $$;
revoke all on function commercial_v1_private.leaderboard_append_only() from public,anon,authenticated,service_role;
create trigger leaderboard_snapshots_append_only
before update or delete on public.commercial_v1_leaderboard_snapshots
for each row execute function commercial_v1_private.leaderboard_append_only();

-- One row per RANKED learner in a published snapshot. score_bp is the exact
-- integer courseScoreBp commercial_v1_private.course_progress already
-- computes (never independently recomputed here); rank is DENSE
-- (1,2,2,3 -- see the migration header). source_provenance is a frozen
-- jsonb array of {kind,component|practicalId,resultRevisionId} identifying
-- EXACTLY which current result revisions produced this score at
-- publication time -- immutable, never re-derived from a later "current"
-- pointer, so a later regrade can never rewrite what this snapshot says was
-- ranked.
create table public.commercial_v1_leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.commercial_v1_leaderboard_snapshots(id),
  enrolment_id uuid not null references public.enrolments(id),
  student_id uuid not null references public.student_profiles(user_id),
  score_bp integer not null check(score_bp between 0 and 10000),
  rank integer not null check(rank>0),
  source_provenance jsonb not null,
  unique(snapshot_id,enrolment_id)
);
create index leaderboard_entries_snapshot
  on public.commercial_v1_leaderboard_entries(snapshot_id,rank);
alter table public.commercial_v1_leaderboard_entries enable row level security;
revoke all on public.commercial_v1_leaderboard_entries from public,anon,authenticated,service_role;
create trigger leaderboard_entries_append_only
before update or delete on public.commercial_v1_leaderboard_entries
for each row execute function commercial_v1_private.leaderboard_append_only();

-- Content-minimised audit trail: identifiers/counts/reason only. There is
-- structurally no column here for a score, a rank, a provenance blob or any
-- protected assessment/lab content.
create function commercial_v1_private.audit_leaderboard_publication() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(NEW.published_by,'COMMERCIAL_V1_LEADERBOARD_PUBLISHED','commercial_v1_leaderboard_snapshots',NEW.id,
    'COMMERCIAL_V1_LEADERBOARD_V1',trim(NEW.reason),
    jsonb_build_object('snapshot_id',NEW.id,'activation_id',NEW.activation_id,'cohort_id',NEW.cohort_id,
      'entry_count',NEW.entry_count,'published_at',NEW.published_at));
  return NEW;
end $$;
revoke all on function commercial_v1_private.audit_leaderboard_publication() from public,anon,authenticated,service_role;
create trigger audit_leaderboard_publication
after insert on public.commercial_v1_leaderboard_snapshots
for each row execute function commercial_v1_private.audit_leaderboard_publication();

-- ==========================================================================
-- Section 2: publication authority. Institutional-privileged
-- (ACADEMIC_ADMIN/PLATFORM_ADMIN, reusing course_activation_private.
-- require_admin() -- the same authority migration 029/030/031 already use
-- for publish_commercial_v1_grading_policy/publish_commercial_v1_result_
-- policy/set_commercial_v1_lab_policy; no new role is introduced). The
-- caller supplies only activation_id and a bounded reason -- never a score,
-- rank, enrolment list or result revision. Every ranked value is derived
-- entirely from authoritative database state inside this one atomic
-- transaction.
--
-- Ranking scope (V2, item B): every enrolment in the activation's cohort
-- with status ACTIVE, PAUSED or COMPLETED. A PAUSED learner is still
-- institutionally enrolled -- pausing delivery does not erase academic
-- standing -- so only WITHDRAWN is excluded (no new eligibility field or
-- status is introduced; enrolments.status already exists unmodified since
-- migration 001). Publication readiness reuses PR11A's OWN "pending"
-- signal (commercial_v1_private.course_progress) for EVERY enrolment in
-- scope: publication fails closed unless every one of them reports zero
-- pending requirements.
--
-- Formal window closure (V2, item C): course_progress().pending=[] is
-- necessary but not sufficient. Publication also fails closed while any of
-- the six formal components bound via migration 029's own
-- commercial_v1_component_bindings still has a real assessment window that
-- closes in the future -- reusing that existing institutional binding/
-- window data directly, never a second calendar or a caller-supplied date.
-- Labs remain governed exclusively by their own result-policy readiness
-- (folded into course_progress already); no separate lab calendar exists.
--
-- Serialization (V2 item A, completed by V3 independent review): the
-- activation row is locked FOR UPDATE first, so two publish calls for the
-- SAME activation serialize on one row. The owning cohort row is then
-- locked FOR UPDATE before membership is captured. Canonical
-- create_enrolment (migration 007) takes FOR SHARE OF c,v on that same
-- cohort row before inserting an enrolment, so a concurrent cohort-member
-- insert either completes before this publication captures membership or
-- waits until publication commits. The COMPLETE eligible-enrolment set is
-- then locked, in deterministic id order, in its own dedicated pass BEFORE
-- any course_progress/current_assessment_result/current_lab_result read.
-- change_enrolment_status (migration 007) and PR11B2 regrade finalization
-- (migration 032) already take the same per-row FOR UPDATE lock on
-- public.enrolments before mutating state/results. True multi-connection
-- blocking remains a hosted/PostgreSQL acceptance fact, but every required
-- serialization lock lives in database SQL, never application code.
-- ==========================================================================
create function public.publish_commercial_v1_leaderboard_snapshot(
  p_activation_id uuid,p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; activation public.course_activations%rowtype; rp public.commercial_v1_result_policies%rowtype;
  gp public.commercial_v1_grading_policies%rowtype;
  locked record; progress jsonb; snapshot_id uuid;
  comp text; lab record; result public.commercial_v1_assessment_result_revisions%rowtype;
  lab_result public.commercial_v1_lab_result_revisions%rowtype; provenance jsonb;
  staged_enrolment_id uuid[] := '{}'; staged_student_id uuid[] := '{}';
  staged_score_bp integer[] := '{}'; staged_provenance jsonb[] := '{}';
  n integer;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded publication reason is required';
  end if;

  -- Serializes same-activation publication, then freezes cohort membership
  -- against canonical create_enrolment's conflicting FOR SHARE lock.
  select * into activation from public.course_activations where id=p_activation_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  perform 1 from public.cohorts where id=activation.cohort_id for update;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  select * into gp from public.commercial_v1_grading_policies where activation_id=p_activation_id;
  if not found then raise exception 'GRADING_POLICY_REQUIRED'; end if;
  select * into rp from public.commercial_v1_result_policies where activation_id=p_activation_id;
  if not found then raise exception 'RESULT_POLICY_REQUIRED'; end if;

  -- Pass 1 (item A): lock the COMPLETE eligible-enrolment scope, in
  -- deterministic id order, in its own loop whose body does nothing but
  -- stage the id/student_id already returned by the lock query itself --
  -- no course_progress or result read happens until this loop has fully
  -- run and every row in scope is locked. Mirrors the same acquire-all-
  -- locks-in-a-stable-order-before-any-further-check pattern migration 029
  -- already uses for its own six assessment rows.
  for locked in
    select id,student_id from public.enrolments
    where cohort_id=activation.cohort_id and status in ('ACTIVE','PAUSED','COMPLETED')
    order by id
    for update
  loop
    staged_enrolment_id := array_append(staged_enrolment_id,locked.id);
    staged_student_id := array_append(staged_student_id,locked.student_id);
  end loop;

  if coalesce(array_length(staged_enrolment_id,1),0)=0 then
    raise exception 'NO_ELIGIBLE_LEARNERS';
  end if;

  -- Formal window closure (item C), checked only after the complete cohort
  -- membership/enrolment lock boundary has been established.
  if exists(
    select 1 from public.commercial_v1_component_bindings b
    join public.assessments a on a.id=b.assessment_id
    where b.activation_id=p_activation_id and a.closes_at>clock_timestamp()
  ) then
    raise exception 'FORMAL_WINDOW_OPEN';
  end if;

  -- Pass 2: derive readiness/score/provenance now that the full scope is
  -- already locked. Any enrolment with an incomplete course_progress
  -- aborts the ENTIRE publication -- never a partial snapshot ranking only
  -- the finished subset.
  for n in 1..array_length(staged_enrolment_id,1) loop
    progress := commercial_v1_private.course_progress(staged_enrolment_id[n]);
    if coalesce((progress->>'ok')::boolean,false)=false then
      raise exception 'RESULT_STATE_UNAVAILABLE';
    end if;
    if jsonb_array_length(progress->'pending')>0 then
      raise exception 'COHORT_NOT_READY';
    end if;

    provenance := '[]'::jsonb;
    foreach comp in array array['QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL'] loop
      result := commercial_v1_private.current_assessment_result(staged_enrolment_id[n],comp);
      if result.id is not null then
        provenance := provenance || jsonb_build_array(
          jsonb_build_object('kind','ASSESSMENT','component',comp,'resultRevisionId',result.id));
      end if;
    end loop;
    if gp.resolved_profile='WITH_LABS' then
      -- Deterministic lab iteration order (item F): practical identity
      -- order, never insertion/random order, so equivalent state always
      -- produces canonical provenance ordering.
      for lab in
        select practical_id from public.commercial_v1_lab_policies
        where activation_id=p_activation_id and contribution_bp>0
        order by practical_id
      loop
        lab_result := commercial_v1_private.current_lab_result(staged_enrolment_id[n],lab.practical_id);
        if lab_result.id is not null then
          provenance := provenance || jsonb_build_array(
            jsonb_build_object('kind','LAB','practicalId',lab.practical_id,'resultRevisionId',lab_result.id));
        end if;
      end loop;
    end if;

    staged_score_bp := array_append(staged_score_bp,(progress->>'courseScoreBp')::integer);
    staged_provenance := array_append(staged_provenance,provenance);
  end loop;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_leaderboard_snapshots(
    activation_id,cohort_id,programme_version_id,entry_count,reason,published_by
  ) values (
    p_activation_id,activation.cohort_id,activation.programme_version_id,
    array_length(staged_enrolment_id,1),trim(p_reason),actor
  ) returning id into snapshot_id;

  -- Dense rank (1,2,2,3), materialised in one set-based INSERT. The window
  -- orders ONLY by authoritative score_bp: there is no academic secondary
  -- tiebreaker. Final SELECT ordering by enrolment id is display/storage
  -- determinism only and cannot alter dense_rank(). Entries remain
  -- append-only: no rank UPDATE is required after insertion.
  insert into public.commercial_v1_leaderboard_entries(
    snapshot_id,enrolment_id,student_id,score_bp,rank,source_provenance
  )
  select
    snapshot_id,
    staged_enrolment_id[i],
    staged_student_id[i],
    staged_score_bp[i],
    dense_rank() over(order by staged_score_bp[i] desc)::integer,
    staged_provenance[i]
  from generate_subscripts(staged_enrolment_id,1) as g(i)
  order by staged_enrolment_id[i];

  return snapshot_id;
end $$;
revoke all on function public.publish_commercial_v1_leaderboard_snapshot(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.publish_commercial_v1_leaderboard_snapshot(uuid,text) to authenticated;

-- ==========================================================================
-- Section 3: bounded learner-safe projection.
--
-- Authorization (V2, item E), enforced HERE in the RPC itself, never only
-- by the Next.js page: a learner read is allowed only when the
-- AUTHENTICATED actor currently holds STUDENT authority (public.has_role
-- re-checks role_grants live -- a removed STUDENT grant loses access
-- immediately even though the old enrolment row still references the same
-- user id) AND the requested enrolment belongs to that actor AND the
-- enrolment is a MEMBER of the latest published snapshot selected by this
-- RPC (an enrolment excluded from that snapshot's own entries is never a
-- gateway to its peer data -- membership is read from immutable entries,
-- never inferred from CURRENT enrolment status). A learner who participated
-- in that latest snapshot may still read it after later withdrawal; PR12
-- does not introduce arbitrary historical-snapshot navigation. ACADEMIC_ADMIN/
-- PLATFORM_ADMIN retain a separate institutional read path, unbound by the
-- membership check, exactly as before.
--
-- Peer identity (V2, item D): no real public.app_users.display_name and no
-- peer enrolment id is ever returned. Each entry instead carries a
-- deterministic, non-academic, rank-independent pseudonymous label (12 hex
-- characters derived from the immutable snapshot id + enrolment id -- fixed
-- for a given published snapshot and never derived from rank). It is a
-- friendly pseudonymous identifier, not a cryptographic anonymity boundary;
-- the caller's own row is always labelled
-- "You". selfEnrolmentId remains at the TOP LEVEL only (the caller's own
-- state), never per peer entry.
--
-- Determinism (V2, item F): the latest snapshot is selected by
-- published_at desc THEN publication_sequence desc (a true monotonic
-- tiebreaker), never published_at alone.
-- ==========================================================================
create function public.get_commercial_v1_leaderboard(p_enrolment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; e public.enrolments%rowtype; activation public.course_activations%rowtype;
  snap public.commercial_v1_leaderboard_snapshots%rowtype; self_entry record; better_count integer; tied_count integer;
  is_privileged boolean; is_member boolean;
begin
  actor := public.current_app_user();
  if actor is null then return jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); end if;

  select * into e from public.enrolments where id=p_enrolment_id;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;

  is_privileged := public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN');
  if not is_privileged and not (e.student_id=actor and public.has_role('STUDENT')) then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;

  activation := commercial_v1_private.enrolment_activation(p_enrolment_id);
  if activation.id is null then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;

  select * into snap from public.commercial_v1_leaderboard_snapshots
  where activation_id=activation.id order by published_at desc,publication_sequence desc limit 1;
  if not found then return jsonb_build_object('ok',true,'published',false); end if;

  is_member := exists(
    select 1 from public.commercial_v1_leaderboard_entries
    where snapshot_id=snap.id and enrolment_id=p_enrolment_id
  );
  if not is_privileged and not is_member then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;

  select rank,score_bp into self_entry from public.commercial_v1_leaderboard_entries
  where snapshot_id=snap.id and enrolment_id=p_enrolment_id;

  -- Bounded, deterministic nudge (section 11): derived ONLY from this
  -- published snapshot and the learner's own permitted rank/score -- never
  -- a fabricated AI judgment, never another learner's protected detail.
  if found then
    select count(*) into better_count from public.commercial_v1_leaderboard_entries
    where snapshot_id=snap.id and rank<self_entry.rank;
    select count(*) into tied_count from public.commercial_v1_leaderboard_entries
    where snapshot_id=snap.id and rank=self_entry.rank and enrolment_id<>p_enrolment_id;
  end if;

  return jsonb_build_object(
    'ok',true,'published',true,'snapshotId',snap.id,'publishedAt',snap.published_at,'entryCount',snap.entry_count,
    'selfEnrolmentId',p_enrolment_id,
    'selfRank',case when found then self_entry.rank else null end,
    'selfScoreBp',case when found then self_entry.score_bp else null end,
    'nudge',case
      when not found then null
      when better_count=0 and tied_count=0 then 'You are rank 1 -- the only learner at the top score.'
      when better_count=0 then 'You are tied for rank 1 with '||tied_count||' other learner(s).'
      when tied_count>0 then better_count||' learner(s) rank above you; you are tied for your rank with '||tied_count||' other learner(s).'
      else better_count||' learner(s) rank above you.'
    end,
    'entries',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'rank',en.rank,'scoreBp',en.score_bp,
        'label',case when en.enrolment_id=p_enrolment_id then 'You'
          else 'Learner '||upper(substr(md5(en.snapshot_id::text||en.enrolment_id::text),1,12)) end,
        'isSelf',en.enrolment_id=p_enrolment_id
      ) order by en.rank,en.enrolment_id),'[]'::jsonb)
      from public.commercial_v1_leaderboard_entries en
      where en.snapshot_id=snap.id
    )
  );
end $$;
revoke all on function public.get_commercial_v1_leaderboard(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_commercial_v1_leaderboard(uuid) to authenticated;

-- ==========================================================================
-- Section 4: RLS/ACL hardening, mirroring migrations 022/025/028/030/031/032
-- exactly. No direct table access is ever granted; every read/write goes
-- through the two governed RPCs above.
-- ==========================================================================
do $$ declare protected_table regclass; columns text; begin
  foreach protected_table in array array[
    'public.commercial_v1_leaderboard_snapshots'::regclass,'public.commercial_v1_leaderboard_entries'::regclass
  ] loop
    select string_agg(quote_ident(attname),', ' order by attnum) into columns
      from pg_attribute where attrelid=protected_table and attnum>0 and not attisdropped;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table %s from public, anon, authenticated, service_role',
      columns,columns,columns,columns,protected_table);
  end loop;
end $$;

do $$ declare protected_table regclass; r text; f record; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach protected_table in array array[
      'public.commercial_v1_leaderboard_snapshots'::regclass,'public.commercial_v1_leaderboard_entries'::regclass
    ] loop
      if has_table_privilege(r,protected_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,protected_table,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unsafe effective leaderboard table privileges for %', r;
      end if;
    end loop;
    for f in select p.oid,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='commercial_v1_private' and p.proname in ('leaderboard_append_only','audit_leaderboard_publication'))
         or (n.nspname='public' and p.proname in (
           'publish_commercial_v1_leaderboard_snapshot','get_commercial_v1_leaderboard'
         )) loop
      if has_function_privilege(r,f.oid,'EXECUTE') is distinct from
        (r='authenticated' and f.nspname='public' and f.proname in (
          'publish_commercial_v1_leaderboard_snapshot','get_commercial_v1_leaderboard'
        )) then
        raise exception 'Unsafe effective leaderboard function privileges for % on %', r, f.proname;
      end if;
    end loop;
  end loop;
end $$;
