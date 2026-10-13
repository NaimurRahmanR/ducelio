# LR-03 + UX-02 — paid customer journey and commercial website readiness

Status: **implemented locally, uncommitted, awaiting independent review.**

- **Branch:** `lr03/paid-journey-ux02` (worktree `../ducelio-lr03`), from `main` `0e21fdf0cb450f3a12e928c0c0cf49eab638ce9b`.
- **Migration:** proposes 058. It is **not** deployed; the hosted ledger is still 57.
- **Not run:** no Stripe API call, no hosted write, no key installation.

Historical evidence is kept separate from evidence executed in this checkpoint.

## 1. Baseline and environment

- **Staging web deployment: none found.** GitHub records 0 deployments and 0 environments, and the Vercel inventory in #62 lists 0 projects. Real **network-delivered** Stripe webhooks therefore cannot be tested: there is no public HTTPS endpoint. Locally signed deliveries (the existing harness) prove the application webhook boundary only.
- **Hosted (read-only, 2026-10-13):**
  - one active commerce controller key, installed 2026-09-28 for the earlier Stripe run (its secret is not in any local store);
  - two active academic controller keys;
  - two commercial orders.
- **Local configuration:** missing `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`, `COMMERCE_CONTROLLER_KEY_ID`/`_HMAC_KEY_HEX` and `ACCEPTANCE_STRIPE_TEST_OPT_IN`.
- **Historical (not re-run):** `acceptance:stripe` 7/7 PASS (PR #36 era, docs/38 §6), and FULL_CUSTOMER_JOURNEY run `1791863337177-6fr8jg` 10 PASS / 0 FAIL (reviewer-entitlement access).

## 2. Payment-safety review (source)

| Property                                   | Finding                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-owned price/currency                | The `create_commercial_v1_order` RPC snapshots amount/currency from the published offer; Checkout uses only the order's values. OK                                                         |
| Test-mode checkout and order binding       | `client_reference_id` and `metadata.orderId` are set, card-only. `attach_commercial_v1_checkout_session` binds one session per order (guard trigger). OK                                   |
| Signature-verified webhooks                | `stripe.webhooks.constructEvent`; an invalid or missing signature → 400 with no state change; events are re-verified by retrieving the session from Stripe. OK                             |
| Unpaid redirect grants nothing             | The success page reconciles server-side; `NOT_PAID` changes nothing. OK                                                                                                                    |
| Idempotent fulfilment                      | Unique provider event ids; the order is locked first; webhook and reconciliation converge on one authority. OK                                                                             |
| Exactly one paid entitlement and enrolment | Database-enforced; previously evidenced by STRIPE_TEST 7/7 (historical). OK                                                                                                                |
| Failed or cancelled payments               | No fulfilment without `paid`; the cancel page makes no payment claim. OK                                                                                                                   |
| Refunds                                    | Only a **full** verified refund revokes, through the attested REFUND operation; partial refunds → `PARTIAL_REFUND_REVIEW`; history retained (migration 045). OK, unit-tested only (see §5) |
| **Retry after an abandoned checkout**      | **DEFECT (HIGH), fixed below**                                                                                                                                                             |

## 3. Defect: a learner can never pay after an abandoned checkout expires (fixed)

**Cause:**

- A learner has one PENDING order per offer, reused on every attempt.
- Migration 034's `guard_order` forbids replacing the bound Stripe session.
- Stripe expires a Checkout Session (default 24 hours) and forgets the idempotency key (about 24 hours).
- On a later attempt Stripe creates a new session, `attach` returns `SESSION_ALREADY_BOUND`, and the bound session has no URL. Checkout therefore failed closed with "Card checkout is currently unavailable" **for that course, permanently**.

**Hosted evidence that the state occurs:** order `acceptance-stripe-paid-1790562535691-4e5750` has been PENDING for 374 hours, bound to an expired `cs_test_` session. It was left untouched.

**Fix (migration `202610130058_commercial_v1_expired_checkout_replacement.sql`, 001–057 unchanged):**

- **Append-only provenance:** `commercial_v1_checkout_session_replacements`, with unique superseded and unique replacement session ids, RLS on, and every API privilege revoked.
- **`guard_order` re-created with one exception.** A PENDING order may change its bound session **only** to the replacement recorded for the exact bound session. Every other change still raises.
- **New attested RPC `replace_expired_commercial_v1_checkout_session`:**
  - HMAC-attested with the existing commerce controller key store, under its own tag `DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1` and the same freshness window;
  - strict payload (`learnerId`, `orderId`, `expiredSessionId`, `replacementSessionId`), with the learner bound to `current_app_user()` and ownership of the PENDING order required;
  - idempotent (`ALREADY_REPLACED`) and audited (`COMMERCIAL_V1_CHECKOUT_SESSION_REPLACED`);
  - granted to `authenticated` only, with migration-time self-verification.
- **Server:** the RPC is attested **only** when Stripe itself reports the bound session `EXPIRED`, `UNPAID` and carrying this order's metadata. Every other closed or unknown state keeps the reviewed fail-closed `CHECKOUT_UNAVAILABLE`. The provider contract gains the session lifecycle `status`.
- **Unchanged:** fulfilment, reconciliation and refund still accept only the currently bound session.

**Tests:**

- `commercial-v1-checkout-session-replacement-db.test.ts` (16, full chain). Covers:
  - the guard is still intact without provenance;
  - the happy path with provenance and audit;
  - idempotency;
  - a second replacement, a wrong bound session, a fulfilled order;
  - tampered, foreign-tag and stale MACs;
  - actor binding and foreign learners;
  - malformed payloads;
  - ACLs and append-only history;
  - **after a replacement, only the new session fulfils**.
- `commercial-v1-checkout-session-replacement-server.test.ts` (10): the server decision matrix and the fake-provider expiry sequence.
- **Mutation checks: 10/10 killed**:

  | Layer  | Mutant (survives only if the tests miss it) |
  | ------ | ------------------------------------------- |
  | DB     | guard without provenance                    |
  | DB     | no ownership filter                         |
  | DB     | no actor binding                            |
  | DB     | operations tag accepted                     |
  | DB     | no bound-session check                      |
  | DB     | no audit row                                |
  | Server | replace without EXPIRED                     |
  | Server | replace a paid session                      |
  | Server | replace another order's session             |
  | Server | wrong learner                               |

**Reviewer decisions required.** This reverses the reviewed V2 choice to fail closed on any closed bound session (the old test still passes because every non-EXPIRED case remains fail-closed). It relaxes migration 034's invariant only through recorded provenance. It must be deployed to `ducelio-acceptance` and then production before the paid journey on new code relies on it.

## 4. UX-02: real-browser evidence (executed)

**How it ran:**

- **Browser:** installed Chrome 155, driven headless by `playwright-core` 1.64 (installed outside the repository), against `next dev` on this branch.
- **Data:** the hosted acceptance catalogue, read-only.
- **Identity:** the synthetic acceptance learner (sign-in only).
- **Stripe:** no Stripe keys, so checkout shows its truthful unavailable state.
- **Viewports:** desktop 1440×900, iPhone-class 390×844 (touch) and Android-class 360×800 (touch); 54 page audits and 58 screenshots.
- **Per page:** axe-core 4.13 WCAG 2.1 A/AA, horizontal overflow, landmarks, a keyboard skip-link check, console errors and touch-target size.

**Before the fixes (confirmed in the browser):**

1. The skip link set `#main` but left focus on the link, on every page.
2. `/checkout/success` and `/checkout/cancel` had no `main` landmark.
3. The learner footer text failed colour contrast (axe, serious) on every student page.
4. The auth "Create an account"/"Back to sign in" links and the success-page "Back to courses" were under 24 px tall.
5. A signed-out buyer returning from Stripe went to `/login` and lost the order.

**Fixes:**

- `tabIndex={-1}` on every `main#main`, with no ring on the programmatically focused landmark.
- The cancel and success pages are wrapped in `main#main`.
- The footer uses the `--muted` token (about 5.2:1 contrast).
- The auth links are padded, and "Back to courses" is a secondary button.
- `loading.tsx` is no longer a second `main#main` (the duplicate observed during streaming).
- `safeAuthDestination` accepts exactly `/checkout/success?order=<uuid>&session_id=cs_(test|live)_…`, rebuilt canonically. Every other query is still dropped; 11 hostile shapes are tested.
- A signed-out success visit redirects to `/login?next=<that>`.

**After the fixes:**

- **0 axe violations** in 54 page audits.
- **Skip link moves focus into `main`: 39/39.**
- Exactly one `#main` on every 200 page.
- **No horizontal overflow** at 360, 390 or 1440 px.
- Sign-in works at all three viewports.
- An expired session sends `/student` to login.
- **End-to-end continuity:** signed-out Stripe return → login → back on the exact `/checkout/success?order=…&session_id=…`.

**Verified correct:** the catalogue outage and empty states, offer cards, cohort dates, the signed-in "already have access → Continue learning" state, the "Card checkout is temporarily unavailable" state, and the denial state for an unknown order.

**Not verified:**

- A real iOS Safari or Android device; touch emulation in desktop Chrome is not a device.
- Screen-reader output, zoom/reflow at 400 %, slow-network loading and Stripe-hosted Checkout pages.

**Remaining, out of code scope:**

- There is no favicon asset (a 404 on `/favicon.ico`).
- Auth pages carry two `h1`s (the brand story and the form).
- The checkout copy says "contact support" and "check your email for a receipt", but no public support channel exists and Stripe receipts depend on dashboard settings (LR-09).

## 5. Hosted paid acceptance: prerequisites and approvals (NOT executed)

| Item                                                                 | State                                                                                                                                                          | Needed                                                                                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY` (`sk_test_`), `STRIPE_WEBHOOK_SECRET` (`whsec_`) | missing                                                                                                                                                        | operator-supplied Stripe **test-mode** sandbox secrets in an operator-controlled file outside the repository/OneDrive                                                       |
| Commerce controller key                                              | 1 hosted key (2026-09-28); its secret is unavailable                                                                                                           | the operator supplies the original, or approves installing a **new commerce-only** key via `commercial_v1_commerce_private.install_controller_key` (never the academic key) |
| `ACCEPTANCE_STRIPE_TEST_OPT_IN=true` + `--authorize-stripe-test`     | missing                                                                                                                                                        | explicit approval of the Stripe test run, its fixtures and one manual sandbox payment                                                                                       |
| `ACCEPTANCE_WRITE_ENABLED=true`                                      | missing                                                                                                                                                        | explicit approval of the permanent run-tagged fixture writes                                                                                                                |
| Interactive terminal                                                 | the agent shell is not a TTY                                                                                                                                   | **the operator runs `npm run acceptance:stripe -- --authorize-stripe-test`** and completes the payment with Stripe's documented test card in a private window               |
| Migration 058                                                        | not deployed                                                                                                                                                   | review, then deploy to `ducelio-acceptance` before testing the new retry path hosted                                                                                        |
| Refund/revocation                                                    | `acceptance:commerce-revocation` covers **admin access revocation** through the same `revoke_entitlement` helper a full refund uses; it makes no Stripe refund | approval to run it (writes). There is **no existing harness for a real Stripe test-mode refund event**: refund webhook handling is unit-tested only (gap)                   |
| Network-delivered webhooks                                           | no staging deployment                                                                                                                                          | a deployed HTTPS staging app bound to `ducelio-acceptance` with a Stripe test webhook endpoint                                                                              |
