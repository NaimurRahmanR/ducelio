-- Commercial V1 PR21: launch foundation.
-- Forward-only from canonical main after SEC701-B (migration 037).
-- This migration establishes delivery-plan identity, deterministic campaign
-- pricing authority and entitlement provenance for future promotional/reviewer
-- grants. It intentionally does NOT implement learner redemption, checkout
-- bypass or automatic entitlement creation; those remain a later vertical
-- slice so campaign definition cannot silently grant access by itself.

-- ==========================================================================
-- Section 1: delivery-plan identity on immutable commercial offers.
-- Historical/current offers are truthfully backfilled to the pre-existing
-- behaviour: STANDARD_6_WEEK. A later publication surface may explicitly
-- select another plan, but once an offer exists the plan is immutable.
-- ==========================================================================
alter table public.commercial_v1_offers
  add column delivery_plan text not null default 'STANDARD_6_WEEK'
  check(delivery_plan in ('ACCELERATED_2_WEEK','INTENSIVE_4_WEEK','STANDARD_6_WEEK'));

create or replace function commercial_v1_commerce_private.guard_offer() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial offers cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.slug<>OLD.slug or NEW.activation_id<>OLD.activation_id
    or NEW.price_amount_minor<>OLD.price_amount_minor or NEW.currency<>OLD.currency
    or NEW.delivery_plan<>OLD.delivery_plan
    or NEW.created_by<>OLD.created_by or NEW.created_at<>OLD.created_at
    or NEW.published_by<>OLD.published_by or NEW.published_at<>OLD.published_at then
    raise exception 'Commercial offer identity/price/plan/provenance is immutable';
  end if;
  if OLD.state='ARCHIVED' and NEW.state<>'ARCHIVED' then
    raise exception 'An archived commercial offer cannot be republished';
  end if;
  return NEW;
end $$;

-- ==========================================================================
-- Section 2: deterministic campaign definition.
-- Campaigns are commercial authority only; they never mutate academic truth,
-- learner identity, enrolment, assessment state or a historical order.
-- Codes are globally unique and permanently reserved so an old campaign code
-- can never later mean a different financial promise.
-- ==========================================================================
create table public.commercial_v1_campaigns (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.commercial_v1_offers(id),
  code text not null unique,
  kind text not null check(kind in ('PERCENT_OFF','FIXED_PRICE','REVIEWER_COMPLIMENTARY')),
  percent_off smallint,
  fixed_price_amount_minor integer,
  max_redemptions integer not null check(max_redemptions between 1 and 1000000),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'ACTIVE' check(state in ('ACTIVE','ARCHIVED')),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  archived_by uuid references public.app_users(id),
  check(ends_at>starts_at),
  check(
    code=upper(code)
    and length(code) between 4 and 32
    and code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
  ),
  check(
    (kind='PERCENT_OFF' and percent_off is not null and percent_off between 1 and 100 and fixed_price_amount_minor is null)
    or
    (kind='FIXED_PRICE' and percent_off is null and fixed_price_amount_minor is not null and fixed_price_amount_minor between 0 and 100000000)
    or
    (kind='REVIEWER_COMPLIMENTARY' and percent_off is null and fixed_price_amount_minor is not null and fixed_price_amount_minor=0)
  ),
  check(
    (state='ACTIVE' and archived_at is null and archived_by is null)
    or
    (state='ARCHIVED' and archived_at is not null and archived_by is not null)
  ),
  unique(id,offer_id)
);
create index commercial_v1_campaigns_offer on public.commercial_v1_campaigns(offer_id,state,starts_at,ends_at);
alter table public.commercial_v1_campaigns enable row level security;
revoke all on public.commercial_v1_campaigns from public,anon,authenticated,service_role;

create function commercial_v1_commerce_private.guard_campaign() returns trigger
language plpgsql set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Commercial campaigns cannot be deleted'; end if;
  if NEW.id<>OLD.id or NEW.offer_id<>OLD.offer_id or NEW.code<>OLD.code
    or NEW.kind<>OLD.kind or NEW.percent_off is distinct from OLD.percent_off
    or NEW.fixed_price_amount_minor is distinct from OLD.fixed_price_amount_minor
    or NEW.max_redemptions<>OLD.max_redemptions
    or NEW.starts_at<>OLD.starts_at or NEW.ends_at<>OLD.ends_at
    or NEW.created_by<>OLD.created_by or NEW.created_at<>OLD.created_at then
    raise exception 'Commercial campaign identity/pricing/provenance is immutable';
  end if;
  if OLD.state='ARCHIVED' and NEW.state<>'ARCHIVED' then
    raise exception 'An archived commercial campaign cannot be reactivated';
  end if;
  if OLD.state='ACTIVE' and NEW.state='ARCHIVED' then
    if NEW.archived_at is null or NEW.archived_by is null then
      raise exception 'Campaign archival requires provenance';
    end if;
  elsif NEW.state=OLD.state and (
    NEW.archived_at is distinct from OLD.archived_at
    or NEW.archived_by is distinct from OLD.archived_by
  ) then
    raise exception 'Campaign archival provenance is immutable';
  end if;
  return NEW;
end $$;
revoke all on function commercial_v1_commerce_private.guard_campaign() from public,anon,authenticated,service_role;
create trigger guard_campaign before update or delete on public.commercial_v1_campaigns
for each row execute function commercial_v1_commerce_private.guard_campaign();

-- One deterministic money rule shared by future preview/redemption surfaces.
-- Percentage discounts use integer minor units and floor the DISCOUNT amount,
-- so the system never grants more than the stated percentage.
create function commercial_v1_commerce_private.calculate_campaign_price(
  p_list_price_amount_minor integer,
  p_kind text,
  p_percent_off smallint,
  p_fixed_price_amount_minor integer
) returns integer
language plpgsql immutable set search_path='' as $$
declare effective bigint;
begin
  if p_list_price_amount_minor is null or p_list_price_amount_minor not between 1 and 100000000 then
    raise exception 'INVALID_LIST_PRICE';
  end if;

  if p_kind='PERCENT_OFF' then
    if p_percent_off is null or p_percent_off not between 1 and 100 or p_fixed_price_amount_minor is not null then
      raise exception 'INVALID_CAMPAIGN_PRICE';
    end if;
    effective := p_list_price_amount_minor::bigint
      - ((p_list_price_amount_minor::bigint * p_percent_off::bigint) / 100);
  elsif p_kind='FIXED_PRICE' then
    if p_percent_off is not null or p_fixed_price_amount_minor is null
      or p_fixed_price_amount_minor not between 0 and p_list_price_amount_minor then
      raise exception 'INVALID_CAMPAIGN_PRICE';
    end if;
    effective := p_fixed_price_amount_minor;
  elsif p_kind='REVIEWER_COMPLIMENTARY' then
    if p_percent_off is not null or p_fixed_price_amount_minor is null or p_fixed_price_amount_minor<>0 then
      raise exception 'INVALID_CAMPAIGN_PRICE';
    end if;
    effective := 0;
  else
    raise exception 'INVALID_CAMPAIGN_KIND';
  end if;

  return effective::integer;
end $$;
revoke all on function commercial_v1_commerce_private.calculate_campaign_price(integer,text,smallint,integer)
  from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 3: append-only campaign redemption provenance.
-- No public redemption function exists in PR21. Future PR24 redemption must
-- lock the campaign row, enforce ACTIVE/time/max/one-per-learner rules and
-- write this table atomically with the resulting order/entitlement path.
-- ==========================================================================
create table public.commercial_v1_campaign_redemptions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  offer_id uuid not null,
  learner_id uuid not null references public.app_users(id),
  entitlement_source text not null check(entitlement_source in ('PROMOTIONAL','REVIEWER')),
  effective_price_amount_minor integer not null check(effective_price_amount_minor between 0 and 100000000),
  redeemed_at timestamptz not null default clock_timestamp(),
  foreign key(campaign_id,offer_id) references public.commercial_v1_campaigns(id,offer_id),
  unique(campaign_id,learner_id)
);
create index commercial_v1_campaign_redemptions_learner
  on public.commercial_v1_campaign_redemptions(learner_id,redeemed_at desc);
alter table public.commercial_v1_campaign_redemptions enable row level security;
revoke all on public.commercial_v1_campaign_redemptions from public,anon,authenticated,service_role;
create trigger campaign_redemptions_append_only
before update or delete on public.commercial_v1_campaign_redemptions
for each row execute function commercial_v1_commerce_private.append_only();

-- ==========================================================================
-- Section 4: entitlement provenance can now represent a future promotion or
-- reviewer grant without inventing a fake paid order. Existing rows remain
-- PAID_ORDER and retain their real order id. Nothing in PR21 writes a
-- promotional entitlement automatically.
-- ==========================================================================
alter table public.commercial_v1_entitlements
  alter column order_id drop not null,
  add column source text not null default 'PAID_ORDER'
    check(source in ('PAID_ORDER','PROMOTIONAL','REVIEWER')),
  add column campaign_redemption_id uuid unique
    references public.commercial_v1_campaign_redemptions(id);

alter table public.commercial_v1_entitlements
  add constraint commercial_v1_entitlements_source_provenance
  check(
    (source='PAID_ORDER' and order_id is not null and campaign_redemption_id is null)
    or
    (source in ('PROMOTIONAL','REVIEWER') and order_id is null and campaign_redemption_id is not null)
  );

revoke all on public.commercial_v1_entitlements from public,anon,authenticated,service_role;

-- ==========================================================================
-- Section 5: admin campaign definition authority.
-- AI may eventually prepare a proposal, but only authenticated existing
-- ACADEMIC_ADMIN/PLATFORM_ADMIN authority can create/archive the deterministic
-- campaign record. These functions do not redeem codes or grant access.
-- ==========================================================================
create function public.create_commercial_v1_campaign(
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
declare
  actor uuid;
  offer_record public.commercial_v1_offers%rowtype;
  normalized_code text;
  campaign_id uuid;
  ignored_effective_price integer;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded campaign reason is required';
  end if;
  if p_offer_slug is null then raise exception 'INVALID_OFFER'; end if;
  select * into offer_record from public.commercial_v1_offers
  where slug=lower(trim(p_offer_slug)) and state='PUBLISHED' for share;
  if not found then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  normalized_code := upper(trim(p_code));
  if normalized_code is null or length(normalized_code) not between 4 and 32
    or normalized_code !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' then
    raise exception 'INVALID_CAMPAIGN_CODE';
  end if;
  if p_max_redemptions is null or p_max_redemptions not between 1 and 1000000 then
    raise exception 'INVALID_REDEMPTION_LIMIT';
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at<=p_starts_at then
    raise exception 'INVALID_CAMPAIGN_WINDOW';
  end if;

  ignored_effective_price := commercial_v1_commerce_private.calculate_campaign_price(
    offer_record.price_amount_minor,p_kind,p_percent_off,p_fixed_price_amount_minor
  );

  perform set_config('app.audit_reason',trim(p_reason),true);
  insert into public.commercial_v1_campaigns(
    offer_id,code,kind,percent_off,fixed_price_amount_minor,max_redemptions,
    starts_at,ends_at,created_by
  ) values(
    offer_record.id,normalized_code,p_kind,p_percent_off,p_fixed_price_amount_minor,
    p_max_redemptions,p_starts_at,p_ends_at,actor
  ) returning id into campaign_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(
    actor,'COMMERCIAL_V1_CAMPAIGN_CREATED','commercial_v1_campaigns',campaign_id,
    'COMMERCIAL_V1_LAUNCH_V1',trim(p_reason),
    jsonb_build_object(
      'campaign_id',campaign_id,'offer_id',offer_record.id,'code',normalized_code,
      'kind',p_kind,'max_redemptions',p_max_redemptions,
      'effective_price_amount_minor',ignored_effective_price
    )
  );
  return campaign_id;
end $$;
revoke all on function public.create_commercial_v1_campaign(text,text,text,smallint,integer,integer,timestamptz,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_commercial_v1_campaign(text,text,text,smallint,integer,integer,timestamptz,timestamptz,text)
  to authenticated;

create function public.archive_commercial_v1_campaign(p_code text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; campaign_id uuid; normalized_code text;
begin
  actor := course_activation_private.require_admin();
  if p_reason is null or length(trim(p_reason)) not between 5 and 300 then
    raise exception 'A bounded campaign archive reason is required';
  end if;
  normalized_code := upper(trim(p_code));
  select id into campaign_id from public.commercial_v1_campaigns
  where code=normalized_code and state='ACTIVE' for update;
  if campaign_id is null then raise exception 'NOT_FOUND_OR_FORBIDDEN'; end if;

  perform set_config('app.audit_reason',trim(p_reason),true);
  update public.commercial_v1_campaigns
  set state='ARCHIVED',archived_at=clock_timestamp(),archived_by=actor
  where id=campaign_id;

  insert into public.audit_events(actor_id,action,target_type,target_id,source,reason,after_state)
  values(
    actor,'COMMERCIAL_V1_CAMPAIGN_ARCHIVED','commercial_v1_campaigns',campaign_id,
    'COMMERCIAL_V1_LAUNCH_V1',trim(p_reason),
    jsonb_build_object('campaign_id',campaign_id,'code',normalized_code)
  );
  return campaign_id;
end $$;
revoke all on function public.archive_commercial_v1_campaign(text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.archive_commercial_v1_campaign(text,text)
  to authenticated;
