-- Commercial V1 PR24: governed campaign redemption and launch checkout UX.
-- Forward-only from CLOSED GREEN PR23 (migration 038 already present).
-- No historical migration is modified.

-- Paid promotional orders need immutable provenance back to the exact
-- campaign redemption that determined their price. Zero-price redemptions
-- continue to point directly from entitlement -> redemption, with no fake
-- order.
alter table public.commercial_v1_campaign_redemptions
  add constraint commercial_v1_campaign_redemptions_identity
  unique(id,learner_id,offer_id);

alter table public.commercial_v1_orders
  add column campaign_redemption_id uuid unique;

alter table public.commercial_v1_orders
  add constraint commercial_v1_orders_campaign_provenance
  foreign key(campaign_redemption_id,learner_id,offer_id)
  references public.commercial_v1_campaign_redemptions(id,learner_id,offer_id);

create or replace function commercial_v1_commerce_private.guard_order() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial orders cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.learner_id<>OLD.learner_id or NEW.offer_id<>OLD.offer_id
    or NEW.activation_id<>OLD.activation_id or NEW.cohort_id<>OLD.cohort_id
    or NEW.programme_version_id<>OLD.programme_version_id or NEW.amount_minor<>OLD.amount_minor
    or NEW.currency<>OLD.currency or NEW.provider<>OLD.provider or NEW.created_at<>OLD.created_at
    or NEW.campaign_redemption_id is distinct from OLD.campaign_redemption_id then
    raise exception 'Commercial order financial identity is immutable';
  end if;
  if OLD.provider_session_id is not null and NEW.provider_session_id is distinct from OLD.provider_session_id then
    raise exception 'A bound Stripe checkout session cannot be replaced';
  end if;
  if OLD.state='FULFILLED' and NEW.state<>'FULFILLED' then
    raise exception 'A fulfilled order cannot be reopened';
  end if;
  return NEW;
end $$;

-- Surface immutable delivery-plan truth on public offer projections.
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
  where o.state='PUBLISHED'
$$;

create or replace function public.get_commercial_v1_offer(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  o public.commercial_v1_offers%rowtype; p_title text; p_body text; p_qual text; starts date; a_cohort uuid;
  actor uuid; entitled boolean:=false; enrolment uuid; viewer_status text:='NONE';
begin
  select * into o from public.commercial_v1_offers where slug=p_slug and state='PUBLISHED';
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
  select p.title,p.examination_body,p.qualification_name,c.starts_on,a.cohort_id
  into p_title,p_body,p_qual,starts,a_cohort
  from public.course_activations a
  join public.cohorts c on c.id=a.cohort_id
  join public.programme_versions v on v.id=a.programme_version_id
  join public.programmes p on p.id=v.programme_id
  where a.id=o.activation_id;

  actor := public.current_app_user();
  if actor is not null and public.has_role('STUDENT') then
    select e.enrolment_id into enrolment from public.commercial_v1_entitlements e
    where e.learner_id=actor and e.activation_id=o.activation_id;
    entitled := enrolment is not null;
    select status into viewer_status from public.enrolments where student_id=actor and cohort_id=a_cohort;
    viewer_status := coalesce(viewer_status,'NONE');
  end if;

  return jsonb_build_object('ok',true,'slug',o.slug,'title',p_title,'examinationBody',p_body,'qualificationName',p_qual,
    'priceAmountMinor',o.price_amount_minor,'currency',o.currency,'summary',o.summary,'cohortStartsOn',starts,
    'deliveryPlan',o.delivery_plan,'viewerAuthenticated',actor is not null,'viewerEntitled',entitled,
    'viewerEnrolmentId',enrolment,'viewerEnrolmentStatus',viewer_status);
end $$;

-- New seven-argument publication surface selects delivery-plan identity.
-- The historical six-argument signature remains as a backward-compatible
-- STANDARD_6_WEEK wrapper for existing callers/tests.
create function public.publish_commercial_v1_offer(
  p_activation_id uuid,p_slug text,p_price_amount_minor integer,p_currency text,p_summary text,
  p_delivery_plan text,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid; activation public.course_activations%rowtype; offer_id uuid;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded publication reason is required';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) not between 3 and 80 then
    raise exception 'INVALID_SLUG';
  end if;
  if p_price_amount_minor is null or p_price_amount_minor not between 1 and 100000000 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_currency is null or upper(p_currency) !~ '^[A-Z]{3}$' then raise exception 'INVALID_CURRENCY'; end if;
  if p_summary is not null and length(p_summary) not between 1 and 500 then raise exception 'INVALID_SUMMARY'; end if;
  if p_delivery_plan is null or p_delivery_plan not in ('ACCELERATED_2_WEEK','INTENSIVE_4_WEEK','STANDARD_6_WEEK') then
    raise exception 'INVALID_DELIVERY_PLAN';
  end if;

  select * into activation from public.course_activations where id=p_activation_id for share;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists(select 1 from public.commercial_v1_offers where activation_id=p_activation_id and state='PUBLISHED') then
    raise exception 'ALREADY_PUBLISHED';
  end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_offers(
    slug,activation_id,price_amount_minor,currency,summary,delivery_plan,created_by,published_by
  ) values(
    p_slug,p_activation_id,p_price_amount_minor,upper(p_currency),nullif(trim(p_summary),''),
    p_delivery_plan,actor,actor
  ) returning id into offer_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_OFFER_PUBLISHED','commercial_v1_offers',offer_id,'COMMERCIAL_V1_LAUNCH_V1',trim(p_reason),
    jsonb_build_object('offer_id',offer_id,'activation_id',p_activation_id,'slug',p_slug,
      'price_amount_minor',p_price_amount_minor,'currency',upper(p_currency),'delivery_plan',p_delivery_plan));
  return offer_id;
end $$;
revoke all on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text,text)
  to authenticated;

create or replace function public.publish_commercial_v1_offer(
  p_activation_id uuid,p_slug text,p_price_amount_minor integer,p_currency text,p_summary text,p_reason text
) returns uuid language sql security definer set search_path='' as $$
  select public.publish_commercial_v1_offer(
    p_activation_id,p_slug,p_price_amount_minor,p_currency,p_summary,'STANDARD_6_WEEK',p_reason
  )
$$;
revoke all on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.publish_commercial_v1_offer(uuid,text,integer,text,text,text)
  to authenticated;

-- Read-only code preview. This is used only to decide whether Stripe
-- configuration is required before consuming a redemption. The redeem RPC
-- repeats every authority/window/cap check under locks and is authoritative.
create function public.preview_commercial_v1_campaign(p_offer_slug text,p_code text) returns jsonb
language plpgsql security definer stable set search_path='' as $$
declare
  actor uuid; o public.commercial_v1_offers%rowtype; c public.commercial_v1_campaigns%rowtype;
  r public.commercial_v1_campaign_redemptions%rowtype; normalized text; effective integer; used_count bigint;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;
  normalized := upper(trim(coalesce(p_code,'')));
  if length(normalized) not between 4 and 32 or normalized !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;
  select * into o from public.commercial_v1_offers where slug=lower(trim(p_offer_slug)) and state='PUBLISHED';
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;

  select rr.* into r from public.commercial_v1_campaign_redemptions rr
  where rr.learner_id=actor and rr.offer_id=o.id;
  if found then
    select * into c from public.commercial_v1_campaigns where id=r.campaign_id;
    if c.code<>normalized then return jsonb_build_object('ok',false,'code','OFFER_ALREADY_REDEEMED'); end if;
    return jsonb_build_object('ok',true,'effectivePriceAmountMinor',r.effective_price_amount_minor,
      'currency',o.currency,'kind',c.kind,'reused',true);
  end if;

  select * into c from public.commercial_v1_campaigns
  where offer_id=o.id and code=normalized;
  if not found or c.state<>'ACTIVE' or clock_timestamp()<c.starts_at or clock_timestamp()>c.ends_at then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;
  select count(*) into used_count from public.commercial_v1_campaign_redemptions where campaign_id=c.id;
  if used_count>=c.max_redemptions then return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE'); end if;

  effective := commercial_v1_commerce_private.calculate_campaign_price(
    o.price_amount_minor,c.kind,c.percent_off,c.fixed_price_amount_minor
  );
  return jsonb_build_object('ok',true,'effectivePriceAmountMinor',effective,
    'currency',o.currency,'kind',c.kind,'reused',false);
end $$;
revoke all on function public.preview_commercial_v1_campaign(text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.preview_commercial_v1_campaign(text,text) to authenticated;

-- Atomic redemption authority. Campaign row lock serializes cap consumption;
-- student_profile lock serializes this path with normal order creation and
-- payment fulfillment for the same learner.
create function public.redeem_commercial_v1_campaign(p_offer_slug text,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; o public.commercial_v1_offers%rowtype; c public.commercial_v1_campaigns%rowtype;
  prior public.commercial_v1_campaign_redemptions%rowtype;
  prior_campaign public.commercial_v1_campaigns%rowtype;
  existing_order public.commercial_v1_orders%rowtype;
  entitlement public.commercial_v1_entitlements%rowtype;
  normalized text; effective integer; source_kind text; used_count bigint;
  a_cohort uuid; a_version uuid; enrolment_id uuid; enrolment_status text;
  redemption_id uuid; order_id uuid;
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;
  perform 1 from public.student_profiles where user_id=actor for update;
  if not found then return jsonb_build_object('ok',false,'code','FORBIDDEN'); end if;

  normalized := upper(trim(coalesce(p_code,'')));
  if length(normalized) not between 4 and 32 or normalized !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  select * into o from public.commercial_v1_offers
  where slug=lower(trim(p_offer_slug)) and state='PUBLISHED' for share;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN'); end if;

  -- One campaign redemption per learner+offer. Genuine retry of the SAME
  -- code resolves the original durable result; a second code cannot stack.
  select * into prior from public.commercial_v1_campaign_redemptions
  where learner_id=actor and offer_id=o.id;
  if found then
    select * into prior_campaign from public.commercial_v1_campaigns where id=prior.campaign_id;
    if prior_campaign.code<>normalized then
      return jsonb_build_object('ok',false,'code','OFFER_ALREADY_REDEEMED');
    end if;
    select * into entitlement from public.commercial_v1_entitlements
    where campaign_redemption_id=prior.id;
    if found then
      return jsonb_build_object('ok',true,'path','ACCESS_GRANTED','reused',true,
        'offerSlug',o.slug,'activationId',o.activation_id,'effectivePriceAmountMinor',0,
        'currency',o.currency,'entitlementId',entitlement.id,'enrolmentId',entitlement.enrolment_id);
    end if;
    select * into existing_order from public.commercial_v1_orders
    where campaign_redemption_id=prior.id;
    if found then
      return jsonb_build_object('ok',true,'path','PAID_CHECKOUT','reused',true,
        'orderId',existing_order.id,'offerSlug',o.slug,'activationId',existing_order.activation_id,
        'effectivePriceAmountMinor',existing_order.amount_minor,'currency',existing_order.currency);
    end if;
    raise exception 'INCOMPLETE_CAMPAIGN_REDEMPTION';
  end if;

  if exists(select 1 from public.commercial_v1_entitlements where learner_id=actor and activation_id=o.activation_id) then
    return jsonb_build_object('ok',false,'code','ALREADY_ENTITLED');
  end if;

  select a.cohort_id,a.programme_version_id into a_cohort,a_version
  from public.course_activations a where a.id=o.activation_id;

  select status into enrolment_status from public.enrolments
  where student_id=actor and cohort_id=a_cohort;
  if found then
    if enrolment_status in ('ACTIVE','PAUSED','COMPLETED') then
      return jsonb_build_object('ok',false,'code','ALREADY_ENROLLED');
    end if;
    return jsonb_build_object('ok',false,'code','ENROLMENT_REQUIRES_SUPPORT');
  end if;

  select * into c from public.commercial_v1_campaigns
  where offer_id=o.id and code=normalized for update;
  if not found or c.state<>'ACTIVE' or clock_timestamp()<c.starts_at or clock_timestamp()>c.ends_at then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  select count(*) into used_count from public.commercial_v1_campaign_redemptions where campaign_id=c.id;
  if used_count>=c.max_redemptions then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  select * into existing_order from public.commercial_v1_orders
  where learner_id=actor and offer_id=o.id and state='PENDING';
  if found then
    return jsonb_build_object('ok',false,'code','CHECKOUT_ALREADY_STARTED');
  end if;

  effective := commercial_v1_commerce_private.calculate_campaign_price(
    o.price_amount_minor,c.kind,c.percent_off,c.fixed_price_amount_minor
  );
  source_kind := case when c.kind='REVIEWER_COMPLIMENTARY' then 'REVIEWER' else 'PROMOTIONAL' end;

  if effective>0 then
    insert into public.commercial_v1_campaign_redemptions(
      campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
    ) values(c.id,o.id,actor,source_kind,effective)
    returning id into redemption_id;

    insert into public.commercial_v1_orders(
      learner_id,offer_id,activation_id,cohort_id,programme_version_id,amount_minor,currency,campaign_redemption_id
    ) values(actor,o.id,o.activation_id,a_cohort,a_version,effective,o.currency,redemption_id)
    returning id into order_id;

    insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
    values(actor,'COMMERCIAL_V1_CAMPAIGN_REDEEMED','commercial_v1_campaign_redemptions',redemption_id,
      'COMMERCIAL_V1_LAUNCH_V1','Learner applied campaign code',
      jsonb_build_object('campaign_id',c.id,'offer_id',o.id,'effective_price_amount_minor',effective,'path','PAID_CHECKOUT'));

    return jsonb_build_object('ok',true,'path','PAID_CHECKOUT','reused',false,'orderId',order_id,
      'offerSlug',o.slug,'activationId',o.activation_id,'effectivePriceAmountMinor',effective,'currency',o.currency);
  end if;

  -- Complimentary/promo-zero access creates academic enrolment and
  -- commercial entitlement directly. No order/payment row is fabricated.
  insert into public.enrolments(student_id,cohort_id,programme_version_id)
  values(actor,a_cohort,a_version)
  on conflict(student_id,cohort_id) do nothing
  returning id into enrolment_id;

  if enrolment_id is null then
    select id,status into enrolment_id,enrolment_status from public.enrolments
    where student_id=actor and cohort_id=a_cohort;
    if enrolment_status<>'ACTIVE' then
      return jsonb_build_object('ok',false,'code','ENROLMENT_REQUIRES_SUPPORT');
    end if;
  end if;

  insert into public.commercial_v1_campaign_redemptions(
    campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
  ) values(c.id,o.id,actor,source_kind,0)
  returning id into redemption_id;

  insert into public.commercial_v1_entitlements(
    learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id
  ) values(actor,o.id,o.activation_id,null,enrolment_id,source_kind,redemption_id)
  returning * into entitlement;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(actor,'COMMERCIAL_V1_CAMPAIGN_ACCESS_GRANTED','commercial_v1_campaign_redemptions',redemption_id,
    'COMMERCIAL_V1_LAUNCH_V1','Learner applied zero-price campaign code',
    jsonb_build_object('campaign_id',c.id,'offer_id',o.id,'source',source_kind,'path','ACCESS_GRANTED'));

  return jsonb_build_object('ok',true,'path','ACCESS_GRANTED','reused',false,
    'offerSlug',o.slug,'activationId',o.activation_id,'effectivePriceAmountMinor',0,'currency',o.currency,
    'entitlementId',entitlement.id,'enrolmentId',enrolment_id);
end $$;
revoke all on function public.redeem_commercial_v1_campaign(text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.redeem_commercial_v1_campaign(text,text) to authenticated;

-- Minimal admin read for operating campaign codes without direct table access.
create function public.list_commercial_v1_campaigns() returns jsonb
language plpgsql security definer stable set search_path='' as $$
begin
  perform course_activation_private.require_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'code',c.code,'offerSlug',o.slug,'kind',c.kind,
      'effectivePriceAmountMinor',commercial_v1_commerce_private.calculate_campaign_price(
        o.price_amount_minor,c.kind,c.percent_off,c.fixed_price_amount_minor
      ),
      'currency',o.currency,'maxRedemptions',c.max_redemptions,
      'redemptionCount',(select count(*) from public.commercial_v1_campaign_redemptions r where r.campaign_id=c.id),
      'startsAt',c.starts_at,'endsAt',c.ends_at,'state',c.state
    ) order by c.created_at desc,c.id),'[]'::jsonb)
    from public.commercial_v1_campaigns c
    join public.commercial_v1_offers o on o.id=c.offer_id
  );
end $$;
revoke all on function public.list_commercial_v1_campaigns()
  from public,anon,authenticated,service_role;
grant execute on function public.list_commercial_v1_campaigns() to authenticated;
