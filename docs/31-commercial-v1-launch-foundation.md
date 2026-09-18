# Commercial V1 PR21 — Launch Foundation

## Scope

PR21 starts from canonical main `90699d88067b0790ce38d5b205a838c757407503`,
the CLOSED GREEN SEC701-B merge. It is deliberately a pre-spend checkpoint:
no hosted Supabase/Vercel acceptance, no live model API call and no live
payment is required or claimed.

This checkpoint establishes three commercial foundations needed before the
customer-grade launch slices:

1. immutable delivery-plan identity for the 2-week, 4-week and 6-week routes;
2. deterministic, admin-authorised campaign pricing definitions;
3. explicit entitlement provenance for paid, promotional and reviewer access.

It does **not** implement learner coupon redemption, bypass Stripe, or
automatically grant a promotional entitlement.

## Delivery plans

The fixed Commercial V1 identities are:

- `ACCELERATED_2_WEEK` — 14 days;
- `INTENSIVE_4_WEEK` — 28 days;
- `STANDARD_6_WEEK` — 42 days.

Migration 038 adds `delivery_plan` to the immutable commercial offer. Existing
offers and the existing six-argument publication RPC preserve historical
behaviour by defaulting to `STANDARD_6_WEEK`. A later launch UX/publication
slice may expose explicit plan selection; once an offer exists its plan cannot
be rewritten.

The delivery plan changes pace, not academic standard. It does not change
course objectives, assessment authority, mastery policy or completion rules.

## Campaign authority

`commercial_v1_campaigns` stores a globally unique, permanently reserved
uppercase code and one of three price rules:

- `PERCENT_OFF`;
- `FIXED_PRICE`;
- `REVIEWER_COMPLIMENTARY`.

All prices remain integer minor units. Percentage campaigns floor the discount
amount, so the effective price never receives more than the stated percentage
discount. A fixed-price campaign may lower a list price to zero but may never
increase it. Reviewer complimentary pricing is exactly zero.

The campaign row records a bounded active window, a configured redemption cap,
immutable pricing terms and creator/archive provenance. PR24 is responsible for
transactionally enforcing that cap when redemption becomes reachable. Archival is
one-way.

Only the existing Academy/Platform admin authority can call
`create_commercial_v1_campaign` or `archive_commercial_v1_campaign`.
This makes a future backend-AI workflow safe to design as
**AI proposes → admin approves → deterministic backend persists**. PR21 does
not give an AI model direct commercial authority.

## Redemption and reviewer entitlement foundation

`commercial_v1_campaign_redemptions` is append-only and protected by RLS.
There is intentionally no public redemption RPC in PR21.

The existing entitlement table gains explicit `source` provenance:

- `PAID_ORDER` requires a real `order_id` and forbids campaign provenance;
- `PROMOTIONAL` requires a campaign redemption and forbids a fake order;
- `REVIEWER` requires a campaign redemption and forbids a fake order.

A composite foreign key also requires promotional/reviewer entitlements to
match the exact redemption learner, offer and entitlement source. A valid
redemption id from another learner, offer or source cannot be attached.

Historical entitlements remain `PAID_ORDER`. Existing Stripe fulfillment
continues to create paid-order entitlements through the existing function and
default.

PR24 must implement the actual transactional redemption path. That path must
lock the campaign, validate state/time/code/offer/current learner, enforce the
redemption cap and one-redemption-per-learner rule, calculate the effective
price using the same deterministic rule, and atomically select either the paid
checkout path or the zero-price promotional/reviewer entitlement path.

## Non-claims

PR21 does not prove or claim:

- hosted PostgreSQL/Supabase behaviour;
- true multi-connection concurrency;
- live Stripe acceptance;
- live OpenAI/Anthropic acceptance;
- customer browser/mobile/accessibility acceptance;
- production readiness.

Those remain later launch gates.
