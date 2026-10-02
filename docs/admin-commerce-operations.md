# Commercial V1 admin commerce operations

Branch: `feat/admin-commerce-operations`. Base: `be2cf01bd834f24578a5aa82f8ee89a47686d35b`.

Migration `202610010045_admin_commerce_operations.sql` is reserved for this work. **Deploy after the foundations branch's `202610010044_admin_control_plane_foundations.sql`.** This branch neither copies migration 044 nor replaces its cohort/order/offer/enrolment guards. People, role administration, account lifecycle, Cohorts and shared navigation are owned by that branch. There is no merge in this checkpoint.

## Operator workflow

Open `/admin/commerce` as an Academic Admin or Platform Admin. The local Commerce navigation includes Offers, Orders, Entitlements, Campaign redemptions, Issues / Reconciliation, Learner access and Audit. Existing offer and campaign publication/archive forms remain available below the console.

Lists return at most 25 records plus a `hasMore` flag. Search by display name, course slug, campaign code or displayed reference. Each tab has pagination. Learner access first selects a learner record, then an offer, so diagnosis also works when no order exists. Search is bounded to 100 characters and pagination to offset 100,000; refine the search beyond that bound.

Order/learner diagnosis is a database projection: exact course activation, programme version and cohort; order/payment/fulfilment state; entitlement and its funding order; enrolment status; current active learning access; reconciliation mismatch; up to 50 payment events and 50 audit entries with explicit truncation flags. An independently created ACTIVE academic enrolment can grant access without a commerce entitlement; the projection keeps that fact separate from financial reconciliation. Account unavailability from migration 044 and missing student authority prevent an active-access result. Completed history is preserved and is not described as an active learning enrolment.

**Reconcile payment and access** requires a reason. The database authorises and audits the request before any Stripe read. The server retrieves the order's stored Checkout Session and its captured charge and refunds. For an unbound order it searches Stripe sessions created since the order, capped at 10 pages of 100, and requires an exhausted listing with exactly one match. It never creates a replacement Checkout Session. Ambiguous or capped lookup requires Stripe Dashboard investigation.

Payment/session/order/amount/currency must agree. Missing evidence, unpaid sessions and pending refunds fail closed. A confirmed paid order reuses the original fulfilment function, through an independently authorised and audited admin RPC. Retries retain the existing one-entitlement/one-enrolment constraints. A paused, withdrawn or completed enrolment is never reactivated by commerce: a legitimate academic status issue must be handled through its governed academic workflow. If an already fulfilled order has non-active access, reconciliation reports that state instead of reporting recovery success.

**Cancel course access** requires a reason and explicit confirmation. It permanently revokes the selected entitlement. It does not initiate a financial refund.

## Refund and access policy

Financial refunds remain a Stripe Dashboard operation. Ducelio reads current Stripe evidence; neither an operator's input nor the original event payload can assert refund success. Only `succeeded` refund amounts count. Refund lists must be exhausted (maximum 1,000 records); pending/unknown statuses block automatic reconciliation. These choices use Stripe's [refund status semantics](https://docs.stripe.com/api/refunds/object) and [refund events](https://docs.stripe.com/refunds).

A verified full refund records an immutable order refund and transitions its entitlement `ACTIVE -> REVOKED`. Only an enrolment created by paid commerce fulfilment becomes `WITHDRAWN` from ACTIVE or PAUSED. A reused independent academic enrolment keeps its governed status and access. Existing entitlements have UNKNOWN provenance: their enrolment status is preserved, but their revoked commercial content access is blocked. Completed enrolments stay `COMPLETED`. No order, payment event, redemption, enrolment, evidence, grade or completion history is deleted. Refund-before-fulfilment creates a persistent barrier, so later checkout delivery cannot grant access. A duplicate payment's refund does not revoke an entitlement funded by another order or a complimentary grant. Partial refunds are visible as `PARTIAL_REFUND_REVIEW`; an operator can separately approve access cancellation.

Revocation is terminal. Future fulfilment cannot restore that entitlement. Academic reactivation cannot reopen commerce-owned or UNKNOWN revoked access; independently governed academic enrolments retain their original academic rules. Learner checkout confirmation and offer entitlement flags respect revocation. Restrictive RLS closes ordinary course-content reads; protected assessment, practical and delivery SECURITY DEFINER reads independently check revocation. Already-open assessment question reads, response writes and learner submission also check revocation; original grading and automatic deadline finalisation rules remain intact. For COMMERCE or UNKNOWN provenance, in-flight generic academic content leases are conservatively aborted for the learner so a previously opened lease cannot complete after revocation. Independently funded academic enrolments are not affected. Already delivered content cannot be retracted. Existing attempts, responses, evidence and results remain stored.

## Independent review corrections

The learner order projection separates `orderRefunded` (immutable financial refund evidence for this order) from `accessRevoked` (actual revocation of commerce-dependent course access). A redundant refunded order reports `orderRefunded=true`, `accessRevoked=false` while another order funds an ACTIVE entitlement. Checkout success explains the payment refund without claiming that course access was revoked. Both the server and database still reject late fulfilment of the refunded order; a genuinely revoked commerce-dependent entitlement reports `accessRevoked=true`.

Enrolment ownership follows policy B: immutable entitlement `enrolment_origin` is COMMERCE only when fulfilment's INSERT RETURNING created the enrolment, ACADEMIC when it reused an existing ACTIVE enrolment, and UNKNOWN for retained records without trustworthy provenance. The existing learner profile lock serialises academic creation and fulfilment. If academic creation happens after order creation but before fulfilment, refund revokes the paid entitlement without withdrawing or blocking that independently governed enrolment. If commerce inserts first, a subsequent idempotent academic create does not transfer ownership. No historical ownership is guessed and no 044 cohort guard is bypassed.

`get_student_retained_learning_history(kind)` is an authenticated STUDENT-only, actor-owned, maximum-500-row database projection for evidence, mastery and progress. It joins only curriculum labels attached to that learner's retained records and returns the existing renderable history shapes. It exposes lesson titles, objective descriptions/positions and segment titles/positions, plus already-readable historical record fields. It does not expose lesson bodies, resource content/URLs, assessment prompts, answer keys or unrelated curriculum. The three student server readers use this projection rather than relationship embeds that restrictive content RLS can hide. The restrictive content policies remain in force.

**Required hosted/PostgREST acceptance:** after a genuine test refund/revocation, use the learner's actual JWT to exercise all three server history readers and the RPC through PostgREST. Verify evidence, mastery and progress still render with labels; direct restricted curriculum/resource reads remain inaccessible, including hidden/null relationship embeds; another learner receives none of these records; a non-STUDENT cannot invoke the projection; and no substantive content or secret fields are returned. PGlite covers database rules and the server contract but cannot establish hosted relationship-embed behaviour. Also run real PostgreSQL concurrent academic-enrolment-versus-fulfilment/refund acceptance for both serial outcomes and verify immutable provenance/status results.

## Webhook durability and recovery

Keep the existing Stripe signing secret. Configure the endpoint for `checkout.session.completed`, `charge.refunded`, `refund.created`, `refund.updated` and `refund.failed`. Unsupported, genuinely signed events are recorded as ignored. Invalid signatures are rejected without trusted state writes.

After signature verification, a controller-attested receipt commits **before** external retrieval or fulfilment. It stores only event/type/subject identifiers, a matched order when known, timestamps, state and a bounded diagnostic code. No raw event, customer/card data, signature, key or environment value is persisted or rendered.

Receipts are idempotent by event ID. Crashes leave `RECEIVED`; business failures become `UNRESOLVED`; successful reconciliation becomes `RESOLVED`. Business/provider failures receive HTTP 200 after durable recording, avoiding repeated Stripe delivery for an unrecoverable business condition. Failure to persist diagnostic evidence receives HTTP 503; no success is claimed for a lost event. Normal Stripe delivery retries still apply to that infrastructure failure.

An operator can retry a selected non-terminal receipt. The database rejects retries of RESOLVED or IGNORED receipts before audit or provider retrieval. Database authority and audit precede retrieval of that exact event through authenticated Stripe API access, followed by fresh payment/refund verification. Stripe event retention/provider outages can prevent event retrieval; use the linked order reconciliation where available. Missing or conflicting provider mappings are deliberately not overridden by SQL or a typed payment status.

## Authority and audit

Every new commerce operator server read/action requires `ACADEMIC_ADMIN` or `PLATFORM_ADMIN`. The database independently calls `course_activation_private.require_admin()`. Registrar, Instructor, Counsellor and learner roles do not inherit commerce operator authority. All protected commerce tables retain RLS and no direct application-role table privileges.

The original fulfilment HMAC protocol is unchanged. Its implementation is retained in the private schema with only enrolment INSERT provenance added, behind a public wrapper that prevents refunded/revoked access from being re-granted. A distinct `DUCELIO_COMMERCE_OPERATIONS_HMAC_SHA256_V1` protocol, with the existing controller key and a maximum 60-second claim lifetime, authenticates bounded receipt/refund operations. Operator envelopes bind the authenticated actor; the database checks that identity and role again. No service-role key or signing endpoint is exposed to clients.

Audit records cover reconciliation request/outcome, access cancellation, entitlement revocation, full-refund reconciliation and operator webhook recovery. They contain actor (NULL for Stripe automation), action, target, bounded reason, timestamp and allowlisted state metadata. The Commerce Audit tab provides access to this commerce-only projection without opening unrelated audit/support records.

## Validation and remaining acceptance

New suites cover database authority/RLS, paid/unpaid recovery and replay, signed observations, durable unresolved receipts, revocation/history, duplicate-payment refunds, practical/lease boundaries, campaign detail, account status with upstream 044, bounded pagination, server orchestration, local webhook routing, real local Stripe signature verification, Stripe SDK fakes and console rendering. Tests never call live Stripe.

The commerce database suite applies repository migration 044 automatically when it exists. Before the upstream rebase, the optional `COMMERCE_FOUNDATIONS_MIGRATION` test environment variable can point to the actual parallel 044 file for local compatibility acceptance; it is not a runtime flag and no production bypass exists. The default suite explicitly skips the upstream-only account-status test when 044 is absent. The separately run upstream compatibility suite executes it. Final full validation remains pending rebasing onto merged PR #48; reading a parallel worktree file does not establish that merge or its CI result.

Required before deployment: reviewed/merged upstream 044 and then reviewed 045, PR CI, hosted Supabase/JWT/PostgREST/RLS acceptance, real PostgreSQL concurrency acceptance for refund versus fulfilment/cancellation, public webhook delivery and Stripe TEST-mode refund lifecycle acceptance, and browser/accessibility acceptance. No production readiness or live-money evidence is claimed.

Normal covered commerce recovery is available in the product. Remaining manual operations are initiating financial refunds in Stripe Dashboard, investigating missing/ambiguous/over-limit provider mappings, resolving legitimate academic pauses through the governed academic workflow, and normal migration/controller-key provisioning. Corrupt historical financial/academic links require a separately reviewed correction; this console intentionally has no generic database repair power.

## Local validation record (2026-10-02)

Base: `be2cf01bd834f24578a5aa82f8ee89a47686d35b`; branch: `feat/admin-commerce-operations`. Work is uncommitted for independent review.

| Gate                                        | Result                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused commerce/authority/acceptance tests | 296/296 across twelve files, applying actual parallel 044 before corrected 045                                                              |
| `npm.cmd run check`                         | PASS: lint, type checking, 3,253 passed / three upstream-only skips, 129 files                                                              |
| `npm.cmd run build`                         | PASS, Next.js 16.3.8                                                                                                                        |
| `npm.cmd run format:check`                  | Seven unchanged baseline CRLF files flagged; LF-normalised content passes Prettier for every flagged file and all seven git diffs are empty |
| `npm.cmd audit`                             | PASS, zero vulnerabilities                                                                                                                  |
| `git diff --check`                          | PASS                                                                                                                                        |

The correction full check used `VITEST_MAX_WORKERS=2` with normal test coverage and timeout limits and passed in 586.60 seconds. All three upstream-only tests pass in the focused run with actual 044 supplied. Five new suites contain 85 test cases (44 database, 22 operator server, six console, eight Stripe adapter and five retained-history). Existing provider/server/checkout-page suites add five more cases, for 90 added cases in this checkpoint, including 18 in this correction pass. These cover refund/access separation, enrolment ownership and immutability, terminal receipt retry, retained history and authority. No live Stripe requests were made. All correction gates are recorded above. A final wording adjustment for repeated entitlement revocation also passed focused server/page suites (50/50) and ESLint.

The tested parallel 044 SHA256 is `c4dad7aaa233129615c1ace09efd30eacedf8e832061a9ba6beac40872f1087c`. This is focused compatibility evidence, not a merged-branch or hosted acceptance claim. Final full validation after rebasing onto merged PR #48 remains required.

The unchanged CRLF files are `.github/workflows/ci.yml`, `package.json`, `tsconfig.json`, and `content/courses/security-plus-sy0-701/{objective-breadth-audit.json,objective-coverage.json,package.json,sources.json}`. No unrelated formatting changes were made.

## Review file inventory

- `docs/admin-commerce-operations.md`
- `docs/implementation-progress.md`
- `src/app/admin/commerce/actions.ts`
- `src/app/admin/commerce/page.tsx`
- `src/app/api/commerce/stripe-webhook/route.ts`
- `src/app/checkout/success/page.tsx`
- `src/components/commerce-operation-form.tsx`
- `src/components/commerce-operations-console.tsx`
- `src/domain/commercial-v1-commerce-operations.ts`
- `src/domain/commercial-v1-commerce.ts`
- `src/server/commercial-v1-commerce/authority.ts`
- `src/server/commercial-v1-commerce/index.ts`
- `src/server/commercial-v1-commerce/operations-authority.ts`
- `src/server/commercial-v1-commerce/operations.ts`
- `src/server/commercial-v1-commerce/provider.ts`
- `src/server/commercial-v1-commerce/stripe-provider.ts`
- `src/server/commercial-v1-commerce/test-fake-provider.ts`
- `src/server/commercial-v1-commerce/webhook-recovery.ts`
- `src/server/commercial-v1-commerce/webhooks.ts`
- `supabase/migrations/202610010045_admin_commerce_operations.sql`
- `tests/acceptance-stripe-driver.test.ts`
- `tests/commercial-v1-commerce-operations-db.test.ts`
- `tests/commercial-v1-commerce-operations-page.test.ts`
- `tests/commercial-v1-commerce-operations-server.test.ts`
- `tests/commercial-v1-commerce-provider.test.ts`
- `tests/commercial-v1-commerce-stripe-operations.test.ts`
- `tests/database.test.ts`

- `src/server/learning-evidence.ts`
- `src/server/lesson-progress.ts`
- `src/server/objective-mastery.ts`
- `tests/commercial-v1-commerce-fixture.ts`
- `tests/commercial-v1-commerce-page.test.ts`
- `tests/commercial-v1-commerce-server.test.ts`
- `tests/commercial-v1-commerce-retained-history.test.ts`
- `tests/student-postgrest-projections.test.ts`
