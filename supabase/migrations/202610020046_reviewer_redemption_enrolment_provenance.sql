-- Reviewer-complimentary redemption enrolment provenance. Deploy AFTER
-- 202610010045_admin_commerce_operations.sql. Migrations 039 and 045 are not
-- modified.
--
-- Migration 045 added immutable commercial_v1_entitlements.enrolment_origin
-- (default UNKNOWN, reserved for genuinely unclassified historical rows) and
-- set it in paid fulfilment, but redeem_commercial_v1_campaign (migration 039)
-- was not updated, so every NEW reviewer-complimentary entitlement silently
-- became UNKNOWN. Revoking such access then left the enrolment that
-- redemption itself created ACTIVE.
--
-- This replaces the function with its exact 039 body plus only:
--   * enrolment_origin = COMMERCE when the redemption's enrolment
--     INSERT RETURNING created the row, ACADEMIC when an existing ACTIVE row
--     was reused (the same ownership rule as paid fulfilment);
--   * that value written to the entitlement and to the existing
--     COMMERCIAL_V1_CAMPAIGN_ACCESS_GRANTED audit metadata.
-- Signature, return shapes, learner lock, ALREADY_ENTITLED/ALREADY_ENROLLED
-- pre-checks, campaign row lock and cap, CHECKOUT_ALREADY_STARTED, paid
-- campaign path, idempotent replay, audit and ACL are unchanged. The
-- enrolment INSERT still runs every migration 044 cohort/capacity guard.
-- Existing entitlements are not rewritten: no historical ownership is
-- guessed. Revocation of a COMMERCE reviewer entitlement now withdraws its
-- ACTIVE/PAUSED enrolment through the unchanged 045 revoke_entitlement.

create or replace function public.redeem_commercial_v1_campaign(
  p_offer_slug text,
  p_code text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  o public.commercial_v1_offers%rowtype;
  c public.commercial_v1_campaigns%rowtype;
  prior public.commercial_v1_campaign_redemptions%rowtype;
  prior_campaign public.commercial_v1_campaigns%rowtype;
  existing_order public.commercial_v1_orders%rowtype;
  entitlement public.commercial_v1_entitlements%rowtype;
  normalized text;
  effective integer;
  source_kind text;
  used_count bigint;
  a_cohort uuid;
  a_version uuid;
  enrolment_id uuid;
  enrolment_status text;
  redemption_id uuid;
  order_id uuid;
  enrolment_origin text := 'ACADEMIC';
begin
  actor := public.current_app_user();
  if actor is null or not public.has_role('STUDENT') then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;

  -- Serialize this learner's commerce state against normal checkout/fulfillment.
  perform 1 from public.student_profiles
  where user_id=actor
  for update;
  if not found then
    return jsonb_build_object('ok',false,'code','FORBIDDEN');
  end if;

  normalized := upper(trim(coalesce(p_code,'')));
  if length(normalized) not between 4 and 32
    or normalized !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  select * into o
  from public.commercial_v1_offers
  where slug=lower(trim(p_offer_slug)) and state='PUBLISHED'
  for share;
  if not found then
    return jsonb_build_object('ok',false,'code','NOT_FOUND_OR_FORBIDDEN');
  end if;

  -- One campaign redemption per learner+offer. A genuine retry of the same
  -- code resolves the existing durable result; a second code cannot stack.
  select * into prior
  from public.commercial_v1_campaign_redemptions
  where learner_id=actor and offer_id=o.id;

  if found then
    select * into prior_campaign
    from public.commercial_v1_campaigns
    where id=prior.campaign_id;

    if prior_campaign.code<>normalized then
      return jsonb_build_object('ok',false,'code','OFFER_ALREADY_REDEEMED');
    end if;

    select * into entitlement
    from public.commercial_v1_entitlements
    where campaign_redemption_id=prior.id;

    if found then
      return jsonb_build_object(
        'ok',true,
        'path','ACCESS_GRANTED',
        'reused',true,
        'offerSlug',o.slug,
        'activationId',o.activation_id,
        'effectivePriceAmountMinor',0,
        'currency',o.currency,
        'entitlementId',entitlement.id,
        'enrolmentId',entitlement.enrolment_id
      );
    end if;

    select * into existing_order
    from public.commercial_v1_orders
    where campaign_redemption_id=prior.id;

    if found then
      return jsonb_build_object(
        'ok',true,
        'path','PAID_CHECKOUT',
        'reused',true,
        'orderId',existing_order.id,
        'offerSlug',o.slug,
        'activationId',existing_order.activation_id,
        'effectivePriceAmountMinor',existing_order.amount_minor,
        'currency',existing_order.currency
      );
    end if;

    raise exception 'INCOMPLETE_CAMPAIGN_REDEMPTION';
  end if;

  if exists(
    select 1 from public.commercial_v1_entitlements
    where learner_id=actor and activation_id=o.activation_id
  ) then
    return jsonb_build_object('ok',false,'code','ALREADY_ENTITLED');
  end if;

  select a.cohort_id,a.programme_version_id
  into a_cohort,a_version
  from public.course_activations a
  where a.id=o.activation_id;

  select status into enrolment_status
  from public.enrolments
  where student_id=actor and cohort_id=a_cohort;

  if found then
    if enrolment_status in ('ACTIVE','PAUSED','COMPLETED') then
      return jsonb_build_object('ok',false,'code','ALREADY_ENROLLED');
    end if;
    return jsonb_build_object('ok',false,'code','ENROLMENT_REQUIRES_SUPPORT');
  end if;

  -- Lock the campaign row before cap counting/consumption.
  select * into c
  from public.commercial_v1_campaigns
  where offer_id=o.id and code=normalized
  for update;

  if not found
    or c.state<>'ACTIVE'
    or clock_timestamp()<c.starts_at
    or clock_timestamp()>c.ends_at then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  select count(*) into used_count
  from public.commercial_v1_campaign_redemptions
  where campaign_id=c.id;

  if used_count>=c.max_redemptions then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  -- A full-price pending checkout may never be repriced after the fact.
  select * into existing_order
  from public.commercial_v1_orders
  where learner_id=actor and offer_id=o.id and state='PENDING';

  if found then
    return jsonb_build_object('ok',false,'code','CHECKOUT_ALREADY_STARTED');
  end if;

  effective := commercial_v1_commerce_private.calculate_campaign_price(
    o.price_amount_minor,
    c.kind,
    c.percent_off,
    c.fixed_price_amount_minor
  );

  if effective=0 and c.kind<>'REVIEWER_COMPLIMENTARY' then
    return jsonb_build_object('ok',false,'code','CODE_UNAVAILABLE');
  end if;

  source_kind := case
    when c.kind='REVIEWER_COMPLIMENTARY' then 'REVIEWER'
    else 'PROMOTIONAL'
  end;

  if effective>0 then
    insert into public.commercial_v1_campaign_redemptions(
      campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
    ) values(
      c.id,o.id,actor,source_kind,effective
    )
    returning id into redemption_id;

    insert into public.commercial_v1_orders(
      learner_id,offer_id,activation_id,cohort_id,programme_version_id,
      amount_minor,currency,campaign_redemption_id
    ) values(
      actor,o.id,o.activation_id,a_cohort,a_version,
      effective,o.currency,redemption_id
    )
    returning id into order_id;

    insert into public.audit_events(
      actor_id,action,target_type,target_id,source,reason,after_state
    ) values(
      actor,
      'COMMERCIAL_V1_CAMPAIGN_REDEEMED',
      'commercial_v1_campaign_redemptions',
      redemption_id,
      'COMMERCIAL_V1_LAUNCH_V1',
      'Learner applied campaign code',
      jsonb_build_object(
        'campaign_id',c.id,
        'offer_id',o.id,
        'effective_price_amount_minor',effective,
        'path','PAID_CHECKOUT'
      )
    );

    return jsonb_build_object(
      'ok',true,
      'path','PAID_CHECKOUT',
      'reused',false,
      'orderId',order_id,
      'offerSlug',o.slug,
      'activationId',o.activation_id,
      'effectivePriceAmountMinor',effective,
      'currency',o.currency
    );
  end if;

  -- Reviewer complimentary access creates enrolment + entitlement directly.
  -- No order/payment record is fabricated.
  insert into public.enrolments(
    student_id,cohort_id,programme_version_id
  ) values(
    actor,a_cohort,a_version
  )
  on conflict(student_id,cohort_id) do nothing
  returning id into enrolment_id;

  -- Provenance (policy B, as paid fulfilment): COMMERCE iff this INSERT
  -- RETURNING created the enrolment; ACADEMIC iff an existing ACTIVE row was
  -- reused (defensive: the learner lock and the ALREADY_ENROLLED pre-check
  -- above make reuse unreachable through governed paths).
  if enrolment_id is not null then
    enrolment_origin := 'COMMERCE';
  end if;

  if enrolment_id is null then
    select id,status into enrolment_id,enrolment_status
    from public.enrolments
    where student_id=actor and cohort_id=a_cohort;

    if enrolment_status<>'ACTIVE' then
      return jsonb_build_object(
        'ok',false,
        'code','ENROLMENT_REQUIRES_SUPPORT'
      );
    end if;
  end if;

  insert into public.commercial_v1_campaign_redemptions(
    campaign_id,offer_id,learner_id,entitlement_source,effective_price_amount_minor
  ) values(
    c.id,o.id,actor,'REVIEWER',0
  )
  returning id into redemption_id;

  insert into public.commercial_v1_entitlements(
    learner_id,offer_id,activation_id,order_id,enrolment_id,source,campaign_redemption_id,enrolment_origin
  ) values(
    actor,o.id,o.activation_id,null,enrolment_id,'REVIEWER',redemption_id,enrolment_origin
  )
  returning * into entitlement;

  insert into public.audit_events(
    actor_id,action,target_type,target_id,source,reason,after_state
  ) values(
    actor,
    'COMMERCIAL_V1_CAMPAIGN_ACCESS_GRANTED',
    'commercial_v1_campaign_redemptions',
    redemption_id,
    'COMMERCIAL_V1_LAUNCH_V1',
    'Learner applied reviewer complimentary code',
    jsonb_build_object(
      'campaign_id',c.id,
      'offer_id',o.id,
      'source','REVIEWER',
      'path','ACCESS_GRANTED',
      'enrolment_origin',enrolment_origin
    )
  );

  return jsonb_build_object(
    'ok',true,
    'path','ACCESS_GRANTED',
    'reused',false,
    'offerSlug',o.slug,
    'activationId',o.activation_id,
    'effectivePriceAmountMinor',0,
    'currency',o.currency,
    'entitlementId',entitlement.id,
    'enrolmentId',enrolment_id
  );
end $$;
revoke all on function public.redeem_commercial_v1_campaign(text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.redeem_commercial_v1_campaign(text,text)
  to authenticated;
