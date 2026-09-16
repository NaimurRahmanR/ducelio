# Commercial V1 PR13 — Commerce, Payment, Entitlement & Customer Onboarding

## Scope

PR13 starts from canonical base `bedfcf905cc9e424753a2bf6240997464eaac16c`
(the merged PR12 leaderboard head, PR #14) on `commercial-v1-commerce-onboarding`.
Migrations 001-033 are byte-for-byte unchanged; the only migration this
checkpoint adds is `202609160034_commercial_v1_commerce_onboarding.sql`.

PR13 delivers the real customer journey **public course → account/verified
identity → checkout → server-verified payment → entitlement → enrolment →
existing scheduling/student experience**. It is a production-shaped vertical
slice: a real Stripe production adapter, deterministic database authority,
and a fake/injected provider that exists only in tests and is structurally
unreachable in production. No payment success is ever fabricated.

This document also records the **V2 correction pass**: an independent
review of the V1 patch found twelve issues (five critical), all corrected
here in the same migration/source files, never as a parallel or competing
implementation.

## Payment authority model

Stripe supplies **payment evidence only**. It never owns identity,
entitlement, enrolment, curriculum, scheduling, academic state, grades,
mastery or completion. The database is the sole authority for
financial/institutional truth. The following are never trusted as proof of
anything: a browser success-page redirect, Stripe metadata, a client-
supplied amount/currency/learner/cohort/entitlement/role.

All financial values are integer minor units (`amount_minor`/
`price_amount_minor`, `check(... between 1 and 100000000)`). No
floating-point money arithmetic exists anywhere in this checkpoint.

## Public offer / catalogue model

`public.commercial_v1_offers` binds: a stable id, a unique public `slug`,
the exact sellable `activation_id` (therefore the exact cohort and
programme version — `course_activations.cohort_id` is itself unique),
integer `price_amount_minor`, uppercase 3-letter `currency`, a bounded
optional commercial `summary` (never academic truth), `state`
(`PUBLISHED`/`ARCHIVED`, one-way), and creation/publication provenance.
Identity/price/provenance are immutable once created (`guard_offer`
trigger); an archived offer can never be republished. At most one
`PUBLISHED` offer may exist per activation at a time (partial unique
index) — re-pricing means archive the old offer and publish a new one; the
old offer, and every historical order/entitlement that references it,
remains untouched.

Learner-facing title/metadata (programme title, examination body,
qualification name, cohort start date) is **derived** at read time from the
existing authoritative `programmes`/`programme_versions`/`cohorts` join —
never duplicated into the offer row.

**Launch-readiness signal** (a deliberately narrow, honest limitation): the
only deterministic signal `publish_commercial_v1_offer` checks is that a
real `course_activations` row exists for the given activation id — itself
proof of a validated `COURSE_PACKAGE_V1` import, a real instructor, a real
cohort and a `PUBLISHED` programme version (migration 027's own
`activate_course_package` invariants). This does **not** verify Commercial
V1 grading/result/lab policy readiness, content completeness beyond schema
validation, or instructor availability — no such deterministic signal
exists yet in the repository.

Two anon-safe read RPCs cross this surface: `list_commercial_v1_offers()`
(catalogue) and `get_commercial_v1_offer(slug)` (detail, plus bounded
viewer state for the current session — see "Existing-enrolment purchase
prevention" below). Neither ever exposes protected course content,
assessment content, agent configuration or private learner data.

## Order lifecycle

`public.commercial_v1_orders`: `learner_id` (the AUTHENTICATED actor at
creation time, never browser-supplied), `offer_id`, and a **snapshot** of
`activation_id`/`cohort_id`/`programme_version_id`/`amount_minor`/
`currency` taken at order creation — a later offer re-price or archival
never rewrites a historical order (`guard_order` trigger enforces financial
identity immutability). `state` is `PENDING`→`FULFILLED` only, one-way.
`provider_session_id` may be set exactly once (from null) and never
subsequently replaced.

Bounded idempotency: a learner retrying checkout for the same offer while
an order is still `PENDING` reuses that exact order (partial unique index
`(learner_id, offer_id) where state='PENDING'`) — no client-supplied
idempotency token is needed or trusted.

## Server-enforced checkout readiness (V2 correction, item 2)

`createCommercialV1Checkout` checks `commerceConfig().configured` —
**both** valid Stripe configuration **and** valid commerce-controller
configuration — before creating an order or contacting Stripe at all, never
relying on the page merely hiding the buy button. `readCommerceConfig`
requires `COMMERCE_CONTROLLER_KEY_ID` to be a syntactically valid UUID and
`COMMERCE_CONTROLLER_HMAC_KEY_HEX` to be exactly 64 hex characters — a
malformed non-empty value never makes checkout appear production-ready.

## Stripe card-only V1 scope (V2 correction, item 7)

Commercial V1 launch scope is deliberately **one-time card checkout only**.
`StripeCommerceProvider.createCheckoutSession` explicitly sets
`payment_method_types: ["card"]` rather than relying on Stripe's
dashboard-configured dynamic payment-method selection, which could
otherwise offer an asynchronous/delayed-settlement method this checkpoint's
webhook handling does not reason about. No Klarna, bank transfer, other
async methods, subscriptions or installment logic exists in PR13.

## Provider boundary

`src/server/commercial-v1-commerce/provider.ts` defines a narrow,
provider-neutral interface (`createCheckoutSession`, `retrieveCheckoutSession`,
`verifyWebhookEvent`). No page/action/route calls the Stripe SDK directly.
`getCommerceProvider()` is the **only** production entrypoint and always
resolves to the code-owned `StripeCommerceProvider`
(`stripe-provider.ts`) — there is no parameter, environment switch or
override that lets production code reach a test adapter.

`FakeCommerceProviderAdapter` (`test-fake-provider.ts`) is TEST-ONLY,
mirroring `src/server/academic-runtime/test-fake-provider.ts`'s exact
production-refusal shape: its constructor throws under
`NODE_ENV=production`. No production code path imports this module.

The database/domain use only bounded provider-safe concepts
(`provider='STRIPE'`) — no Stripe dependency exists in domain logic or the
schema beyond that identifier.

## Stripe idempotency behaviour (V2 correction, item 1 — critical)

**Invariant: one Ducelio order must never lead the customer to multiple
independent payable Stripe Checkout Sessions.**

`createCommercialV1Checkout` passes Stripe's own idempotency mechanism on
session creation: `{idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:" + orderId}`
(no PII). Retrying checkout creation for the same order — a double-click, a
reused `PENDING` order across two tabs, a transient network retry — makes
Stripe itself return the same session object, never a second one.

Defensively, `attach_commercial_v1_checkout_session` now also reports the
already-bound session id (`existingSessionId`) on a `SESSION_ALREADY_BOUND`
denial. If the DB-bound session differs from the one just
created/retrieved, `createCommercialV1Checkout` **never returns the newly
created session's URL** — it retrieves the DB-bound session's own live URL
and returns that instead, or fails closed with `CHECKOUT_UNAVAILABLE` if
that session can no longer be retrieved with a live URL. A customer can
therefore never be routed to a Stripe session the database will later
reject as mismatched.

## Server/session binding behaviour

Required shape: learner chooses a published offer → server creates/reuses
a deterministic order → server calls Stripe using the server secret,
price/currency read from the authoritative persisted order (never request
input) → server binds the resulting Checkout Session id onto that exact
order (`attach_commercial_v1_checkout_session`) → the browser receives only
the hosted redirect URL.

## Webhook verification

Preferred production path: Stripe sends a signed
`checkout.session.completed` webhook to `POST /api/commerce/stripe-webhook`
→ `StripeCommerceProvider.verifyWebhookEvent` verifies the signature via
`stripe.webhooks.constructEvent` using `STRIPE_WEBHOOK_SECRET` (the raw
request body is read as text, never JSON-parsed first, since the signature
covers the exact bytes delivered) → only a genuinely verified
`checkout.session.completed` event proceeds → the route attests a
fulfillment claim and relays the database's own result. The route always
returns `200` once the signature verifies (per Stripe's own guidance); the
database's fulfillment result (matched/mismatched/not-paid/replay) is
institutional truth, never re-litigated or exposed to the unauthenticated
caller.

## Success-page reconciliation (never trusts the redirect)

`/checkout/success` always performs **server-side reconciliation**
(`reconcileCommercialV1Order`) before ever saying a word about payment:
authenticated owner → retrieve the real Stripe Checkout Session
server-side → independently confirm it references the **same order**
(`session.metadataOrderId === orderId`) → converge on the **same**
`fulfill_commercial_v1_order` authority the webhook uses. Whichever path
arrives first, the outcome shown is database-authoritative, never
duplicated (see "Entitlement"/"Atomic enrolment fulfillment" below).

### V2 correction, item 6 (high) — no synthetic provenance for an unconfirmed payment

Previously, reconciliation would attest even a non-`PAID` observation,
creating a `SESSION_VERIFY:<sessionId>` payment-event row for an `UNPAID`
fact — a later reload that then observed `PAID` reused the same event id
(already consumed by the earlier `UNPAID` row's unique constraint) while
still being allowed to proceed to fulfillment, leaving a fulfilled order
without the `PAID` provenance row that actually justified it. Corrected:
`reconcileCommercialV1Order` returns `{ok:true, fulfilled:false,
code:'NOT_PAID'}` directly whenever `session.paymentStatus !== 'PAID'` —
`attestCommerceFulfillment` is **never called** for a non-PAID observation.
The synthetic `SESSION_VERIFY:` provenance identity is created only once
Stripe has independently returned `PAID` with complete evidence, keeping it
immutable and meaningful. Webhook provenance remains its own distinct
Stripe event id regardless.

## Payment evidence semantics (V2 correction, item 3 — critical)

**Fail-closed rule: missing provider evidence is never synthesised from
the database's own expectation.**

Previously, `reconcileCommercialV1Order` used
`session.amountMinor ?? status.order.amountMinor` (and the equivalent for
currency) — if the provider omitted amount/currency, the database order's
own value silently stood in, meaning an incomplete provider response could
still attest as if the provider had confirmed those values. Corrected:
`session.amountMinor === null || session.currency === null` now returns a
bounded `{ok:false, code:'INCOMPLETE_EVIDENCE'}` result **before** any
attestation attempt. The DB order's own amount/currency are used only to
**compare** against complete provider evidence (`MISMATCHED_AMOUNT` /
`MISMATCHED_CURRENCY`), never to replace missing evidence.

## Controller/HMAC boundary

`fulfill_commercial_v1_order` is the **one** fulfillment authority both the
webhook route and the authenticated success-page reconciliation fallback
converge on — never two competing implementations. It is reachable by
`anon` (a Stripe webhook has no Ducelio session at all) and `authenticated`
(the success-page fallback runs as the owning learner) alike, gated
entirely by a cryptographically signed claim, never by role.

This mirrors the architecture of migration 022's
`academic_execution_private` controller-key pattern (bounded canonical
message, fixed-key store, fixed-length MAC comparison, distinct
protocol/policy tag) but is **deliberately a separate key store and
canonical shape**: that pattern binds identity via `current_app_user()` (a
live learner session), which a webhook never has. This claim instead binds
the exact values needed to prevent tampering with a fulfillment fact —
`provider`, `order_id`, `session_id`, `event_id`, `amount`, `currency`,
`status`, `issued_at`/`expires_at` (a 5-minute bounded window, wider than
the live-session surfaces' 10-second window to tolerate real webhook
delivery/network latency, never open-ended) — regardless of which trusted
entrypoint produced it. `commercial_v1_commerce_private.controller_keys`
is provisioned only via `install_controller_key`, database-owner only, no
secret in migration/seed/source. There is no signing oracle, no generic
HMAC verifier, no arbitrary payload writer: a valid claim can only ever
invoke `fulfill_commercial_v1_order`.

Configuration: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`COMMERCE_CONTROLLER_KEY_ID`, `COMMERCE_CONTROLLER_HMAC_KEY_HEX` (see
`.env.example`). The controller key id/secret is a **separate trust root**
from `ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX` — never
reused across these two structurally different governance surfaces.

## Immutable payment verification evidence

`public.commercial_v1_payment_events`: bounded, append-only. Columns:
`order_id`, `provider`, `provider_event_id` (unique per provider — a
duplicate/replayed webhook event id is swallowed as a replay, not a new
fact), `session_id`, `amount_minor`, `currency`,
`status` (`PAID`/`UNPAID`/`NO_PAYMENT_REQUIRED` — Stripe's own vocabulary,
verbatim uppercased, never invented), `verified_at`. No raw webhook body,
signature, secret, full customer object or card data is ever stored.

## Entitlement

`public.commercial_v1_entitlements`: `learner_id`, `offer_id`,
`activation_id`, `order_id` (unique — the one order that produced this
entitlement), `enrolment_id`, `state` (`ACTIVE` only in V1, a forward-
extension point, never an unused complexity), `created_at`. Append-only.
`unique(learner_id, activation_id)` — one active entitlement per learner
per sellable **course**, never per offer (so a re-priced offer cannot let
the same learner accumulate a second entitlement to the same course).
Payment success never equals enrolment merely because a browser says so —
only `fulfill_commercial_v1_order` ever writes this table, after
independently verifying a trusted, DB-matched payment fact.

## Atomic entitlement/enrolment fulfillment

`fulfill_commercial_v1_order`, in one PL/pgSQL function body (commits
atomically or not at all):

1. verify the trusted claim (fail closed otherwise);
2. lock the order row `FOR UPDATE` first (serializes a webhook and a
   success-page reconciliation racing for the same order, and serializes
   two webhook deliveries);
3. bind (once, immutably) or verify the provider session id;
4. verify amount/currency exactly match the persisted order;
5. idempotently record payment evidence (a duplicate event id is a
   replay, swallowed);
6. if already `FULFILLED`, return the existing fulfilled projection
   idempotently;
7. if not `PAID`, return `{fulfilled:false, code:'NOT_PAID'}` without
   creating any entitlement/enrolment;
8. reproduce (never weaken or call with borrowed authority)
   `create_enrolment`'s own invariant checks — `create_enrolment` itself
   remains admin-only and is **never redefined or called by fulfillment**;
   the `enrolments` table's own `prepare_enrolment_record`/
   `guard_enrolment_history` BEFORE INSERT triggers (migration 007)
   independently re-verify cohort/programme-version identity and
   `PUBLISHED` status regardless of caller, so those checks are not
   duplicated here;
9. create/reuse the entitlement and mark the order `FULFILLED`, writing
   bounded audit metadata.

### V2 correction, item 5 (critical) — fulfillment reactivation scope narrowed

The original rule accepted an existing `ACTIVE`, `PAUSED` **or**
`COMPLETED` enrolment as safe to associate. Because order creation now
independently blocks purchase whenever _any_ existing enrolment already
exists for that cohort (see below), reaching fulfillment with a
pre-existing, non-`ACTIVE` enrolment can now only happen through a genuine
race with a concurrent academic action. The rule is now strictly: a fresh
insert is always `ACTIVE` (safe); an existing enrolment must be
`ACTIVE` to associate; `PAUSED`/`COMPLETED`/`WITHDRAWN` all fail closed
with `ENROLMENT_NOT_ACTIVATABLE` — the order is **not** marked fulfilled
and no entitlement is created, even though the payment-evidence row above
already stands as bounded proof of the verified payment for manual
reconciliation. WITHDRAWN is never silently reactivated by a fresh
purchase.

### V2 correction, item 11 (defensive) — replay never returns a null id

A second, genuinely duplicate payment for a course the learner already
holds a _different_ entitlement for reuses that existing entitlement
(never a second entitlement/enrolment row) and still marks its own order
`FULFILLED`. A later replay of _that same order_ now correctly falls back
to the stable `(learner_id, activation_id)` lookup when no entitlement is
keyed directly to it — the fix prevents a replay from ever returning a
null `entitlementId`/`enrolmentId` (which would previously have failed
Zod parsing on the TypeScript side). No refund behaviour is invented in
PR13; this is documented as a known limitation requiring manual
admin/support handling.

## Existing-enrolment purchase prevention (V2 correction, item 4 — critical)

**Both** the projection and the authoritative order-creation layer now
independently check the **canonical** `public.enrolments` table, not only
commerce entitlement — a learner can be legitimately enrolled (e.g. a
comped/free seat an admin created directly via `create_enrolment`) without
ever holding an entitlement row, and the entitlement-only check alone
would miss that case entirely.

- `get_commercial_v1_offer` returns `viewerEnrolmentStatus`
  (`NONE`/`ACTIVE`/`PAUSED`/`COMPLETED`/`WITHDRAWN`), derived from
  `enrolments` for the current viewer's exact cohort, independent of
  `viewerEntitled`. The `/courses/[slug]` page never offers a fresh
  purchase when this is anything but `NONE`: `ACTIVE`/entitled → "Continue
  learning"; `COMPLETED` → "already completed"; `PAUSED` → "paused,
  contact support"; `WITHDRAWN` → "contact support, cannot reactivate
  automatically".
- `create_commercial_v1_order` checks entitlement first (`ALREADY_ENTITLED`),
  then the canonical enrolment for the exact cohort:
  `ACTIVE`/`PAUSED`/`COMPLETED` → `ALREADY_ENROLLED`; `WITHDRAWN` →
  `ENROLMENT_REQUIRES_SUPPORT` (never silently reactivated). Never derived
  from browser input.

## Auth return allowlist (V2 correction, item 9 — high)

`safeAuthDestination` (`src/domain/auth.ts`) preserves a commercial
purchase's selected course/checkout destination through
signup/login/email verification, but is now a **bounded allowlist**, not
an arbitrary same-origin path (being same-origin is necessary, never
sufficient). Two layers: (1) `parseSameOriginPath` rejects every
open-redirect shape (absolute URL, protocol-relative `//host`, backslash
tricks, encoded tricks, a `javascript:`-shaped scheme) by resolving the
candidate against a fixed dummy origin via the WHATWG URL parser and
requiring the result to still be that same origin; (2) the resulting
pathname is checked against exactly `/student` (default), `/reset-password`
(the existing recovery destination), `/courses`, and `/courses/<valid
offer slug>` — any other same-origin path (`/admin`, `/api/...`, an
internal route, an unrecognised path) falls back to `/student`. Query/hash
are dropped, never passed through unexamined. All call sites
(`login`/`signup`/`oauth` server actions, `AuthPage`, the callback/confirm
routes) go through this one function.

## Public checkout journey

`/` redirects to `/courses` (public entry). `/courses` lists published
offers (public-safe fields only). `/courses/[slug]` shows the detail and
handles: anonymous → sign in/create account (with `next=` preserved);
authenticated + `NONE` enrolment status + not entitled → buy (or a
truthful unavailable notice when commerce is not configured); any other
enrolment/entitlement state → the appropriate non-buy message (see above).
`/checkout/success` reconciles server-side and shows one of: payment
confirmed (first time) / already confirmed (replay) / payment not
confirmed / a support-required note (`ENROLMENT_NOT_ACTIVATABLE`) / a
denied/mismatched note / a missing-details note / a configuration-
unavailable note. `/checkout/cancel` never claims an authoritative
financial fact.

### V2 correction, item 8 (high) — cancel page truthfulness

The cancel page previously said "You were not charged" — an authoritative
financial claim derived only from visiting `cancel_url`. Corrected to:
"Ducelio has not confirmed a completed payment from this page. If you
believe a payment was taken, contact support." No order/payment state is
read or written on this page.

### V2 correction, item 12 (truthful customer copy)

Reviewed and softened: the success page now says "your course access has
been set up" (not "your enrolment is active", which overstated a specific
current-tense guarantee); the course detail page's caption now says
"Scheduling opens as soon as your purchase is verified and your enrolment
is confirmed" (not "opens immediately").

## Admin offer operations (V2 correction, item 10 — required)

`/admin/commerce` (linked from `/admin`'s Overview, mirroring
`/admin/activation`'s own pattern — no new `adminSections` entry, no new
role). Two forms:

- **Publish**: `activationId` (chosen from
  `list_commercial_v1_offer_activations()` — a new admin-only read that
  lists activations and which already have a published offer slug, the
  smallest read an admin needs to actually use the publish RPC), `slug`,
  `priceAmountMinor`, `currency`, an optional bounded `summary`, and a
  bounded `reason`.
- **Archive**: takes the public `slug` (not an internal id — the smallest
  input an admin actually has on hand) and a bounded `reason`.

Both reuse `course_activation_private.require_admin()` — the exact same
`ACADEMIC_ADMIN`/`PLATFORM_ADMIN` authority every other Commercial V1
publish RPC already uses. No new role; no duplicated course-authority
logic; no broad commercial analytics.

## RLS/ACL model

No direct table access is ever granted on `commercial_v1_offers`,
`commercial_v1_orders`, `commercial_v1_payment_events`,
`commercial_v1_entitlements` or `commercial_v1_commerce_private.controller_keys`
— every read/write goes through the governed RPCs, mirroring migrations
022/027/029/030/031/032/033 exactly (column-level revokes plus an
effective-ACL acceptance block for `anon`/`authenticated`/`service_role`).
Exactly three functions are `anon`-executable
(`list_commercial_v1_offers`, `get_commercial_v1_offer`,
`fulfill_commercial_v1_order`) — each individually reviewed and bounded;
every other governed RPC is `authenticated`-only, gated internally by
STUDENT/admin/self-ownership checks. `create_enrolment` itself is
untouched and remains admin-only.

`tests/database.test.ts`'s repo-wide "no anon-executable SECURITY DEFINER
function" regression assertion predates any legitimate public-anonymous
surface in this codebase; it is updated to allowlist exactly these three
reviewed PR13 functions rather than removed or loosened generally — any
other anon-executable security-definer function remains exactly as
forbidden as before this checkpoint.

## Tests

137 focused tests across seven files (plus the full-suite regression run):

- `tests/commercial-v1-commerce-db.test.ts` — **45 tests**. Real PGlite
  migration/RPC/RLS behaviour: migration-integrity regression; public
  catalogue projection and protected-content absence; publication
  authority and one-published-offer-per-activation; offer/order
  immutability (price, session binding, append-only payment events/
  entitlements); order-creation authority (anonymous denial, arity proof,
  DB-authoritative amount/currency, cohort fixing, bounded idempotent
  reuse); existing-enrolment/entitlement purchase prevention across all
  four enrolment statuses; controller/HMAC verification (invalid
  signature, expired claim, revoked key, direct-UPDATE denial); atomic
  fulfillment matching (exact-match success, mismatched
  session/amount/currency denial, UNPAID-never-entitles, duplicate-event
  idempotency, webhook+reconciliation convergent idempotency, no
  reactivation of PAUSED/WITHDRAWN discovered at fulfillment time,
  duplicate-payment replay never nulls an id); learner/foreign-learner
  self-or-admin scoping; no direct broad table privileges (including
  service_role); existing-system regression (`create_enrolment`
  untouched, `MASTERY_V1`/leaderboard functions present).
- `tests/commercial-v1-commerce-domain.test.ts` — **25 tests**. Schema
  bounds (currency/slug), offer/order/fulfillment/reconciliation contract
  shapes including the new `viewerEnrolmentStatus` enum and
  `ALREADY_ENROLLED`/`ENROLMENT_REQUIRES_SUPPORT`/`INCOMPLETE_EVIDENCE`
  codes, and static-source proofs (no protected-content column, no
  `create_enrolment` redefinition, `fulfill_commercial_v1_order`'s exact
  anon+authenticated grant, the strict-ACTIVE fulfillment condition, the
  enrolments-table order-creation check, the `existingSessionId` fix, the
  card-only payment-method pin, the idempotency-key plumbing, the exact
  set of authenticated/anon grants).
- `tests/commercial-v1-commerce-provider.test.ts` — **15 tests**.
  `FakeCommerceProviderAdapter`'s production refusal and deterministic
  round-trip/idempotency/close behaviour; the **real**
  `StripeCommerceProvider.verifyWebhookEvent` tested with the installed
  Stripe SDK's own local `generateTestHeaderString` signing helper (pure
  HMAC verification, no network call) — accepts a genuinely signed event,
  rejects a forged signature/missing header/wrong event type, and proves
  `createCheckoutSession`/`retrieveCheckoutSession` fail closed without
  attempting a network call when Stripe is not configured.
- `tests/commercial-v1-commerce-server.test.ts` — **12 tests**. The
  checkout-creation configuration gate; the idempotency-key/same-session
  replay/mismatched-bound-session-retrieval/fail-closed paths; the
  reconciliation flow's FULFILLED short-circuit, mismatched-session
  denial, never-attest-on-UNPAID, never-synthesise-missing-evidence
  (amount and currency separately), mismatched-amount/currency denial
  without attesting, and the full PAID+matching attest-and-relay path.
- `tests/commercial-v1-commerce-page.test.ts` — **19 tests**. The
  catalogue/detail/success/cancel pages and the `startCheckout` action,
  including every `viewerEnrolmentStatus` branch, the configuration-
  unavailable notice, the truthful-copy assertions, and the cancel page's
  non-claim.
- `tests/auth.test.ts` — **7 tests** (2 pre-existing + 5 new). The new
  bounded-allowlist bypass/allow tests for `safeAuthDestination`.
- `tests/auth-actions.test.ts` — **4 tests** (unchanged, still green,
  confirming the pre-existing absolute-URL rejection and normal-flow
  behaviour are preserved).

Full `npm run check`: **1673/1673 tests across 75 files**, lint clean,
typecheck clean. Production build: clean, all new routes
(`/courses`, `/courses/[slug]`, `/checkout/success`, `/checkout/cancel`,
`/admin/commerce`, `/api/commerce/stripe-webhook`) present and correctly
static/dynamic. `git diff --check`: clean. Migrations 001-033: zero diff
from canonical base.

## Production configuration required

`.env.local` (never committed):

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
COMMERCE_CONTROLLER_KEY_ID=<a real UUID>
COMMERCE_CONTROLLER_HMAC_KEY_HEX=<64 hex chars / 32 random bytes>
```

Plus, separately, a database-owner-only provisioning call installing a
matching row in `commercial_v1_commerce_private.controller_keys` with the
**same** key id and the raw 32 bytes the hex above encodes — exactly the
same operational shape as `academic_execution_private.controller_keys`
already requires for the academic runtime. No secret is ever committed to
migration/seed/source. A Stripe webhook endpoint must be configured in the
Stripe Dashboard pointing at `POST /api/commerce/stripe-webhook`,
subscribed to `checkout.session.completed`.

## Known limitations

- **Hosted Supabase/Stripe acceptance is unproven.** All tests run against
  PGlite and the installed Stripe SDK's own local signing helper — no real
  network call to Stripe or a hosted Supabase instance was made anywhere
  in this checkpoint.
- **True multi-connection PostgreSQL concurrency is unproven.** PGlite is
  a single-connection embedded engine; the row-locking design
  (`FOR UPDATE` on the order row, first, before any other read) is present
  in the SQL and exercised sequentially (webhook-shaped call followed by
  reconciliation-shaped call for the same order, both idempotent), which
  is the strongest proof available inside PGlite. True concurrent-
  connection blocking under a real hosted PostgreSQL instance remains an
  explicit hosted-acceptance gap, exactly as documented for every prior
  Commercial V1 checkpoint.
- **Abandoned/expired Stripe sessions are not actively reconciled.** A
  learner who starts checkout and never completes it leaves their order
  `PENDING` indefinitely; retrying checkout for the same offer reuses that
  order (a fresh Stripe session is created and re-bound via the idempotent
  attach path). No background job expires stale `PENDING` orders in this
  checkpoint — an operator can always identify them via `created_at` for
  manual review if ever needed.
- **No automatic refund for an accidental duplicate purchase.** The rare
  edge case of two successful payments for the same course (item 11)
  correctly avoids a second entitlement/enrolment and marks both orders
  fulfilled against the one entitlement, but issuing a refund for the
  duplicate charge requires manual admin/support handling — refunds are
  explicitly out of scope for PR13 (see below).
- **No subscriptions, installment plans, coupons, advanced tax engine,
  multi-currency conversion, refunds workflow, disputes workflow or
  affiliate payouts.** All explicitly deferred; the database design does
  not foreclose adding them later (e.g. `commercial_v1_entitlements.state`
  already exists as a single-value-today forward-extension column).
- Do not claim PR13 closed: this V2 correction pass is implemented
  locally, uncommitted and unpushed, pending independent review of
  `pr13-commerce-onboarding-review-v2.patch`.
