# Commercial V1 PR24 — Commerce & Launch UX

## Scope

PR24 starts exactly from CLOSED GREEN PR23 at
`c526157e3d8a6b024856a0a6ce8f8e2f3f53dde8`.

The slice closes the launch-commerce gap left deliberately by PR21:

- customer campaign-code redemption;
- paid discounted checkout without mutating an existing order;
- zero-price reviewer/promotional access without fabricating payment;
- delivery-plan publication and customer display;
- operator campaign create/list/archive controls;
- founding-launch offer UX, with £29.99 / GBP as an admin-form default rather
  than a fabricated global price.

PR24 does not change the academic assessment, mastery or provider-routing
authority.

## Transaction model

Campaign preview is read-only. It exists so server code can decide whether a
redemption requires the configured Stripe/controller path before consuming a
campaign place.

`redeem_commercial_v1_campaign` is the database authority. It repeats all
validation under locks:

- authenticated current STUDENT only;
- exact published offer;
- normalized campaign code;
- ACTIVE campaign;
- current campaign time window;
- maximum redemption count;
- one campaign redemption per learner and offer;
- no existing entitlement;
- no existing ACTIVE/PAUSED/COMPLETED enrolment;
- WITHDRAWN remains a support case;
- no already-started pending checkout.

The learner's student-profile row serializes redemption against normal checkout
creation for that learner. The campaign row is locked before cap consumption,
so separate learners cannot independently consume the same final campaign
place.

## Paid campaign path

A campaign that leaves a positive effective price creates:

1. one immutable campaign-redemption record; and
2. one new PENDING commercial order whose amount is the database-calculated
   effective price.

The order has immutable `campaign_redemption_id` provenance. Existing order
price is never rewritten. A full-price checkout that was already started
therefore cannot later be repriced by applying a code.

Stripe still receives only the persisted order amount/currency. The browser
never supplies the charged amount.

A same-code retry reuses the same redemption/order. A different second code for
the same learner and offer is rejected rather than stacked.

For paid codes, the redemption is consumed when the durable discounted order is
created, not when payment later succeeds. An abandoned PENDING discounted order
therefore retains that redemption until a later lifecycle/expiry mechanism is
implemented. This is deliberate launch semantics for PR24 and is not described
as a completed paid sale.

## Zero-price path

Only a `REVIEWER_COMPLIMENTARY` campaign may have a zero effective price.
Percentage and fixed-price promotional campaigns are rejected if they would
make the course free. Reviewer complimentary access never creates a commercial
order or payment event.

The transaction instead creates/reuses the exact ACTIVE academic enrolment,
writes the campaign redemption, and creates a promotional/reviewer entitlement
whose existing composite provenance constraints bind it to the same learner,
offer and source.

This path does not require Stripe configuration because no payment is being
claimed.

## Delivery plans and launch price

PR21 made offer delivery-plan identity immutable. PR24 exposes that identity in
publication and public offer projections:

- 2-week Accelerated;
- 4-week Intensive;
- 6-week Standard.

The admin publication form defaults to 2,999 pence / GBP for the Security+
founding launch and explicitly identifies that as a launch default that may be
changed when another approved offer is intended. The database remains the
financial authority; the customer page renders whatever immutable published
offer actually exists.

## Operator campaign controls

The admin commerce surface can create, inspect and archive campaigns through
the existing ACADEMIC_ADMIN / PLATFORM_ADMIN authority. It never receives
direct campaign-table access.

Campaign creation supports percentage, fixed-price and reviewer-complimentary
definitions with the existing deterministic pricing rules, UTC windows and
bounded redemption limits.

## Customer UX

An eligible authenticated learner sees one purchase/access form:

- with configured card commerce, a code is optional and paid promotional
  discounts continue to hosted Stripe Checkout;
- without configured card commerce, the form requires a code and only a valid
  reviewer-complimentary campaign can proceed;
- direct complimentary access redirects into the learner programme;
- existing entitlement/enrolment states continue to suppress duplicate
  purchasing.

The course page shows its immutable delivery plan and one-time published fee.

## Stripe boundary

PR24 does not replace the reviewed Stripe adapter. Paid checkout still uses
server-created hosted Checkout Sessions, card-only one-time payment,
order-derived `price_data`, deterministic per-order idempotency,
server-side session binding, signed-webhook verification and success-page
reconciliation through the same database fulfillment authority.

## Acceptance and non-claims

PR24 repository/CI acceptance must establish:

- migration 039 applies on the real migration chain;
- historical migrations 001–038 remain unchanged;
- preview is non-consuming;
- paid discount creates exactly one discounted order with provenance;
- zero-price access creates no order;
- campaign caps and no-stacking rules hold;
- an existing checkout cannot be repriced;
- free access bypasses Stripe;
- paid checkout uses the database effective price;
- learner/admin UI contracts compile and render;
- full repository tests, formatting and production build pass.

PR24 does **not** establish:

- hosted Supabase/PostgreSQL migration deployment;
- true multi-connection production concurrency;
- a live Stripe payment or refund;
- live webhook delivery;
- tax/VAT correctness;
- browser/mobile/accessibility acceptance;
- production readiness.
