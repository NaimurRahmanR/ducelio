-- Retire new legacy sales; preserve existing orders/refunds/academic history.
begin;

create or replace function public.create_commercial_v1_order(p_offer_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user();o public.commercial_v1_orders%rowtype;
begin
 if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN');end if;
 select r.* into o from public.commercial_v1_orders r join public.commercial_v1_offers f on f.id=r.offer_id
 where r.learner_id=actor and f.slug=p_offer_slug and r.state='PENDING';
 if found then return jsonb_build_object('ok',true,'orderId',o.id,'amountMinor',o.amount_minor,'currency',o.currency,'offerSlug',p_offer_slug,'activationId',o.activation_id,'reused',true);end if;
 return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
end $$;

create or replace function public.create_academy_order(p_offer_slug text, p_format_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_app_user();o public.academy_orders%rowtype;
begin
 if actor is null or not public.has_role('STUDENT') then return jsonb_build_object('ok',false,'code','FORBIDDEN');end if;
 select r.* into o from public.academy_orders r join public.academy_offers f on f.id=r.offer_id
 where r.learner_id=actor and f.slug=p_offer_slug and r.state='PENDING' and r.format_id=p_format_id;
 if found then return jsonb_build_object('ok',true,'orderId',o.id,'amountMinor',o.amount_minor,'currency',o.currency,'offerSlug',p_offer_slug,'formatId',o.format_id,'reused',true);end if;
 return jsonb_build_object('ok',false,'code','SALE_NOT_OPEN');
end $$;

create or replace function public.redeem_commercial_v1_campaign(
  p_offer_slug text,
  p_code text
) returns jsonb
language plpgsql security definer set search_path='' as $$
begin raise exception 'LEGACY_WORKFLOW_RETIRED';end $$;

create or replace function public.create_commercial_v1_campaign(
  p_offer_slug text,
  p_code text,
  p_kind text,
  p_percent_off smallint,
  p_fixed_price_amount_minor integer,
  p_max_redemptions integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
begin raise exception 'LEGACY_WORKFLOW_RETIRED';end $$;

create or replace function public.publish_commercial_v1_offer(
  p_activation_id uuid,
  p_slug text,
  p_price_amount_minor integer,
  p_currency text,
  p_summary text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
begin raise exception 'LEGACY_WORKFLOW_RETIRED';end $$;

create or replace function public.enable_academy_public_sale(p_offer_id uuid, p_owner_approval_confirmed boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := academy_private.require_offer(p_offer_id); reason text := academy_private.require_reason(p_reason);
  offer public.academy_offers%rowtype; pending jsonb; pkg jsonb;
begin
  if not exists(select 1 from public.academy_offers o join public.academy_courses c on c.id=o.course_id join public.course_engine_packages p on p.package_id=c.package_id where o.id=p_offer_id) then raise exception 'LEGACY_WORKFLOW_RETIRED';end if;
  select * into offer from public.academy_offers where id = p_offer_id for update;
  if not found or offer.state <> 'PUBLISHED' then raise exception 'NOT_FOUND'; end if;
  if offer.sale_mode = 'PUBLIC_SALE' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  pending := academy_private.pending_decisions(offer.course_id);
  if jsonb_array_length(pending) > 0 then
    return jsonb_build_object('ok', false, 'code', 'POLICY_PENDING',
      'pending', (select jsonb_agg(d->>'key') from jsonb_array_elements(pending) d));
  end if;
  select p.raw_package into pkg from public.academy_courses c join public.academy_course_packages p on p.id = c.package_id where c.id = offer.course_id;
  if exists (select 1 from jsonb_array_elements(pkg->'labs') lb where (lb.value->>'graded')::boolean
      and (jsonb_array_length(lb.value->'rubric') = 0 or lb.value->>'markingGuidance' is null)) then
    return jsonb_build_object('ok', false, 'code', 'RUBRIC_PENDING');
  end if;
  if p_owner_approval_confirmed is distinct from true then return jsonb_build_object('ok', false, 'code', 'APPROVAL_REQUIRED'); end if;
  update public.academy_offers set sale_mode = 'PUBLIC_SALE', sale_approved_by = actor, sale_approved_at = clock_timestamp(),
    sale_approval_reason = reason where id = offer.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (actor, 'ACADEMY_PUBLIC_SALE_APPROVED', 'academy_offers', offer.id, 'ACADEMY_COURSE_ENGINEERING_V1', reason,
    jsonb_build_object('owner_approval_confirmed', true));
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

create or replace function public.list_academy_catalogue() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'offerId', o.id, 'slug', o.slug, 'title', c.title, 'summary', o.summary, 'currency', o.currency,
    'description', p.raw_package->'course'->>'description',
    'qualificationPreparation', p.raw_package->'course'->'qualificationPreparation',
    'demoContent', (p.raw_package->'course'->>'demoContent')::boolean,
    'lessons', (select count(*) from public.academy_course_lessons l where l.course_id = c.id),
    'labs', jsonb_array_length(p.raw_package->'labs'),
    'assessments', jsonb_array_length(p.raw_package->'assessments'),
    'formats', (select jsonb_agg(jsonb_build_object('formatId', f.format_id, 'weeks', academy_private.format_weeks(f.format_id),
        'sessionMinutes', f.session_minutes, 'minStudyDays', f.min_study_days, 'maxStudyDays', f.max_study_days,
        'amountMinor', f.price_amount_minor) order by academy_private.format_weeks(f.format_id))
      from public.academy_offer_formats f where f.offer_id = o.id)
  ) order by o.published_at desc), '[]')
  from public.academy_offers o join public.academy_courses c on c.id = o.course_id
  join public.academy_course_packages p on p.id = c.package_id
  where o.state = 'PUBLISHED' and o.sale_mode = 'PUBLIC_SALE' and exists(select 1 from public.course_engine_publications u where u.offer_id=o.id)
$$;

create or replace function public.list_commercial_v1_offers() returns jsonb
language sql security definer stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug',o.slug,'title',p.title,'examinationBody',p.examination_body,'qualificationName',p.qualification_name,
    'priceAmountMinor',o.price_amount_minor,'currency',o.currency,'summary',o.summary,'cohortStartsOn',c.starts_on,
    'deliveryPlan',o.delivery_plan
  ) order by o.published_at desc,o.id),'[]'::jsonb)
  from public.commercial_v1_offers o
  join public.course_activations a on a.id=o.activation_id
  join public.cohorts c on c.id=a.cohort_id
  join public.programme_versions v on v.id=a.programme_version_id
  join public.programmes p on p.id=v.programme_id
  where o.state='PUBLISHED' and public.current_app_user() is not null and (public.has_role('ACADEMIC_ADMIN') or public.has_role('PLATFORM_ADMIN'))
$$;

create or replace function public.get_commercial_v1_offer(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return jsonb_build_object('ok',false,'code','NOT_FOUND');end $$;

create or replace function sarah_private.learner_mode(p_student uuid) returns text
language sql stable set search_path='' as $$
  select case
    when exists(select 1 from public.academy_enrolments a join public.academy_entitlements t on t.id=a.entitlement_id where a.learner_id=p_student and a.status='ACTIVE' and t.state='ACTIVE') or exists(select 1 from public.enrolments e where e.student_id = p_student and e.status in ('ACTIVE','PAUSED'))
      then 'ACTIVE_COURSE'
    when exists(select 1 from public.academy_enrolments where learner_id=p_student) or exists(select 1 from public.enrolments e where e.student_id = p_student)
      then 'POST_COURSE'
    else 'PROSPECT'
  end
$$;

-- Public selling facts and own enrolment state only. No grades, examination
-- content, orders, discounts, counselling prose or support profiles.
create or replace function sarah_private.commercial_projection(p_student uuid) returns jsonb
language sql stable set search_path='' as $$
 with ctx as (select sarah_private.learner_mode(p_student) mode),
 published as (
 select item,row_number() over(order by item->>'title',item->>'slug') position
 from jsonb_array_elements(public.list_unified_course_catalogue()) item
 ), viewer as (
 select p.*,e.status viewer_status,
 exists(select 1 from public.academy_entitlements t where t.learner_id=p_student and t.course_id=u.course_id) entitled,
 exists(select 1 from public.academy_entitlements t where t.id=e.entitlement_id and t.state='REVOKED') revoked
 from published p join public.course_engine_publications u on u.offer_id=(p.item->>'offerId')::uuid
 left join public.academy_enrolments e on e.course_id=u.course_id and e.learner_id=p_student where p.position<=20
 )
 select jsonb_build_object('mode',(select mode from ctx),
 'offers',coalesce((select jsonb_agg(jsonb_build_object(
 'slug',item->>'slug','title',left(item->>'title',200),
 'examinationBody',left(coalesce(item->'qualificationPreparation'->>'examinationBody','Ducelio'),200),
 'qualificationName',left(coalesce(item->'qualificationPreparation'->>'qualificationName',item->>'title'),200),
 'priceAmountMinor',(item->'formats'->0->>'amountMinor')::integer,'currency',item->>'currency','summary',item->'summary',
 'cohortStartsOn',null,'deliveryPlan',null,'availableDurationsWeeks',(select jsonb_agg(f->'weeks' order by (f->>'weeks')::integer) from jsonb_array_elements(item->'formats') f),
 'viewerStatus',case when revoked then 'WITHDRAWN' else coalesce(viewer_status,'NONE') end,
 'newPurchaseAvailable',viewer_status is null and not entitled
 ) order by position) from viewer),'[]'::jsonb),
 'offersTruncated',(select count(*)>20 from published),
 'completedCourses',case when (select mode from ctx)='POST_COURSE' then coalesce((
 select jsonb_agg(jsonb_build_object('programmeTitle',left(c.title,200),'qualificationName',left(coalesce(p.raw_package->'course'->'qualificationPreparation'->>'qualificationName',c.title),200),'completedOn',to_char(e.completed_at at time zone 'UTC','YYYY-MM-DD')) order by e.completed_at desc,e.id)
 from (select * from public.academy_enrolments where learner_id=p_student and status='COMPLETED' order by completed_at desc,id limit 5) e
 join public.academy_courses c on c.id=e.course_id join public.academy_course_packages p on p.id=c.package_id
 ),'[]'::jsonb) else '[]'::jsonb end)
$$;
create or replace function sarah_private.commercial_digest(p_projection jsonb) returns text
language sql immutable set search_path='' as $$select encode(extensions.digest(convert_to('SARAH_UNIFIED_COMMERCIAL_CONTEXT_V2'||E'\n'||p_projection::text,'UTF8'),'sha256'),'hex')$$;
create or replace function public.publish_commercial_v1_offer(
  p_activation_id uuid,
  p_slug text,
  p_price_amount_minor integer,
  p_currency text,
  p_summary text,
  p_delivery_plan text,
  p_reason text
) returns uuid
language plpgsql security definer set search_path='' as $$
begin raise exception 'LEGACY_WORKFLOW_RETIRED';end $$;
create function public.list_organisation_course_orders() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.course_engine_organisations where academy_private.can_manage_org(id)) then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'courseTitle',c.title,'learnerId',o.learner_id,'state',o.state,'amountMinor',o.amount_minor,'currency',o.currency,'discountAmountMinor',t.discount_amount_minor,
   'paymentConfirmed',exists(select 1 from public.academy_payment_events e where e.order_id=o.id and e.status='PAID'),
   'refundRecorded',exists(select 1 from public.academy_order_refunds r where r.order_id=o.id),'createdAt',o.created_at) order by o.created_at desc)
 from (select a.* from public.academy_orders a join public.course_engine_publications p on p.course_id=a.course_id
 where academy_private.can_manage_org(p.organisation_id) order by a.created_at desc limit 200) o
 join public.course_engine_order_terms t on t.order_id=o.id join public.academy_courses c on c.id=o.course_id),'[]');
end $$;
revoke all on function public.list_organisation_course_orders() from public,anon,authenticated,service_role;
grant execute on function public.list_organisation_course_orders() to authenticated;
-- These retained read endpoints expose no legacy shopping catalogue. Preserve
-- their established transport ACL explicitly, including Supabase defaults.
revoke all on function public.list_commercial_v1_offers(),public.get_commercial_v1_offer(text) from public,anon,authenticated,service_role;
grant execute on function public.list_commercial_v1_offers() to anon,authenticated;
grant execute on function public.get_commercial_v1_offer(text) to anon,authenticated;
create or replace function public.fulfill_academy_order(
  p_key_id uuid, p_order_id uuid, p_provider text, p_session_id text, p_event_id text,
  p_amount integer, p_currency text, p_status text, p_issued_at bigint, p_expires_at bigint, p_mac text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.academy_orders%rowtype; ent public.academy_entitlements%rowtype; enrolment uuid; version_id uuid;
begin
  if p_provider is distinct from 'STRIPE' or p_order_id is null or p_session_id is null or length(p_session_id) not between 1 and 200
    or p_event_id is null or length(p_event_id) not between 1 and 200 or p_amount is null or p_amount not between 1 and 100000000
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_status is null or p_status not in ('PAID','UNPAID','NO_PAYMENT_REQUIRED')
    or not academy_private.verify_claim(p_key_id, concat_ws(E'\n', 'DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1', 'ACADEMY_COMMERCE_V1',
      p_key_id::text, p_provider, p_order_id::text, p_session_id, p_event_id, p_amount::text, p_currency, p_status,
      p_issued_at::text, p_expires_at::text), p_issued_at, p_expires_at, p_mac, 300) then
    return jsonb_build_object('ok', false, 'code', 'UNTRUSTED_CLAIM');
  end if;
  -- One provider event cannot attest two orders or contradict an earlier fact.
  perform pg_advisory_xact_lock(hashtextextended('ACADEMY_PAYMENT_EVENT:'||p_provider||':'||p_event_id,0));
  if exists(select 1 from public.academy_payment_events e where e.provider=p_provider and e.provider_event_id=p_event_id and
    (e.order_id<>p_order_id or e.session_id<>p_session_id or e.amount_minor<>p_amount or e.currency<>p_currency or e.status<>p_status)) then return jsonb_build_object('ok',false,'code','PAYMENT_EVENT_CONFLICT');end if;
  -- Lock order: the order, then the learner profile (as the cohort path).
  select * into o from public.academy_orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  perform 1 from public.student_profiles where user_id = o.learner_id for update;
  if exists (select 1 from public.academy_order_refunds where order_id = o.id) then return jsonb_build_object('ok', false, 'code', 'ORDER_REFUNDED'); end if;
  if exists (select 1 from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id and state = 'REVOKED') then
    return jsonb_build_object('ok', false, 'code', 'ACCESS_REVOKED');
  end if;
  if o.amount_minor <> p_amount then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_AMOUNT'); end if;
  if o.currency <> p_currency then return jsonb_build_object('ok', false, 'code', 'MISMATCHED_CURRENCY'); end if;
  if o.provider_session_id is null then
    update public.academy_orders set provider_session_id = p_session_id where id = o.id;
  elsif o.provider_session_id <> p_session_id then
    return jsonb_build_object('ok', false, 'code', 'MISMATCHED_SESSION');
  end if;
  insert into public.academy_payment_events(order_id, provider, provider_event_id, session_id, amount_minor, currency, status)
  values (o.id, p_provider, p_event_id, p_session_id, p_amount, p_currency, p_status) on conflict (provider, provider_event_id) do nothing;
  if o.state='CANCELLED' then return jsonb_build_object('ok',false,'code',case when p_status='PAID' then 'CANCELLED_PAYMENT_REVIEW' else 'ORDER_CANCELLED' end);end if;
  if o.state = 'FULFILLED' then
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
    return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', true, 'orderId', o.id, 'entitlementId', ent.id,
      'enrolmentId', (select id from public.academy_enrolments where entitlement_id = ent.id));
  end if;
  if p_status <> 'PAID' then return jsonb_build_object('ok', true, 'fulfilled', false, 'code', 'NOT_PAID', 'orderId', o.id); end if;
  if not exists (select 1 from public.role_grants where user_id = o.learner_id and role = 'STUDENT') then
    return jsonb_build_object('ok', false, 'code', 'LEARNER_NOT_STUDENT');
  end if;
  insert into public.academy_entitlements(learner_id, offer_id, course_id, format_id, source, order_id, reason)
  values (o.learner_id, o.offer_id, o.course_id, o.format_id, 'PURCHASE', o.id, 'Verified Stripe payment')
  on conflict (learner_id, course_id) do nothing returning * into ent;
  if ent.id is null then
    -- A second payment for a course already held: never a second
    -- entitlement; reconciliation is a support decision (as for cohorts).
    select * into ent from public.academy_entitlements where learner_id = o.learner_id and course_id = o.course_id;
  else
    select programme_version_id into version_id from public.academy_courses where id = o.course_id;
    insert into public.academy_enrolments(entitlement_id, learner_id, course_id, programme_version_id)
    values (ent.id, o.learner_id, o.course_id, version_id);
  end if;
  update public.academy_orders set state = 'FULFILLED', fulfilled_at = clock_timestamp() where id = o.id;
  select id into enrolment from public.academy_enrolments where entitlement_id = ent.id;
  insert into public.audit_events(actor_id, action, target_type, target_id, source, reason, after_state)
  values (o.learner_id, 'ACADEMY_ORDER_FULFILLED', 'academy_orders', o.id, 'ACADEMY_COMMERCE_V1', 'Verified payment fulfilled',
    jsonb_build_object('entitlement_id', ent.id, 'enrolment_id', enrolment, 'format_id', o.format_id, 'amount_minor', p_amount,
      'currency', p_currency, 'duplicate', ent.order_id is distinct from o.id));
  return jsonb_build_object('ok', true, 'fulfilled', true, 'replay', false, 'orderId', o.id, 'entitlementId', ent.id,
    'enrolmentId', enrolment, 'duplicate', ent.order_id is distinct from o.id);
end $$;
commit;
