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
- **`guard_order` re-created from its latest definition (migration 039) with one exception.** A PENDING order may change its bound session **only** to the replacement recorded for the exact bound session. Every other change still raises, including 039's `campaign_redemption_id` immutability (see §3b).
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

### 3a. Independent-review corrections (PR #71)

**Finding 1 (HIGH): checkout stayed stuck while Stripe retained the original idempotency result.**

The first version created a session with the original order key _before_ inspecting the bound session. If Stripe still holds that key, it returns the cached, expired session, so the replacement path never ran.

The checkout now reads the binding first, through a new owner-only RPC `get_my_commercial_v1_checkout_binding(order)`. It is added to the undeployed migration 058, returns `{state, sessionId}` for the caller's own order only, and is granted to `authenticated` only with self-verification. Only then does the checkout choose a path, in a loop bounded to 3 steps:

- **no bound session** → create under the original key `DUCELIO_COMMERCIAL_V1_ORDER:<order>`, attach, then re-verify;
- **bound and Stripe-confirmed `OPEN` + `UNPAID` for this order** → reuse it, with no create call;
- **bound and Stripe-confirmed `EXPIRED` + `UNPAID` for this order** → create under the replacement-generation key `DUCELIO_COMMERCIAL_V1_ORDER:<order>:REPLACES:<expired session>`, attest the replacement, then re-verify. The key is stable across concurrent attempts for one expired session, distinct from the original key and different for every later generation;
- **anything else** (complete, paid, unknown, mismatched, missing evidence, or Stripe unreachable) → `CHECKOUT_UNAVAILABLE`.

A URL is returned only for the database-bound session, freshly retrieved from Stripe as `OPEN` and `UNPAID`. It is never an expired or superseded URL.

**Tests.** `commercial-v1-checkout-session-replacement-server.test.ts` (14) drives the real checkout against a stateful binding model and a fake Stripe adapter that **retains** idempotency keys. Recovery succeeds while the original key still returns the expired session, concurrent attempts converge on one replacement, generations use new keys, an always-expired replacement fails closed, and every refusal path is covered. Four existing server tests and one static pin were updated to the binding-first sequence; their assertions were preserved or strengthened, for example "reuse creates no new session". The database suite gained 3 tests for the binding read.

**Finding 2 (MEDIUM): true concurrency.**

`commercial-v1-checkout-session-replacement-pg-concurrency.test.ts` (5) runs over **independent connections to a real PostgreSQL server**. It applies the same migration chain (`tests/db-helper.ts` now exposes the exact statement list used for PGlite) and gives each scenario its own database copied from one template. A racer is counted as contending only after `pg_stat_activity` shows it blocked on a lock.

| Scenario                                     | Result                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 8 identical concurrent claims                | exactly 1 `REPLACED` and 7 `ALREADY_REPLACED`; one binding, one history row, one audit |
| Conflicting claims                           | one wins; the other gets `SESSION_CHANGED`                                             |
| Another learner's concurrent claim           | `NOT_FOUND_OR_FORBIDDEN`; never touches the order                                      |
| Replacement vs fulfilment of the old session | never both (`INVALID_STATE` or `MISMATCHED_SESSION`)                                   |
| Replay after completion                      | `ALREADY_REPLACED`; history stays append-only                                          |

It ran **5/5 against a disposable local PostgreSQL 17.10** (the `embedded-postgres` binaries, installed outside the repository, loopback only). Without `DUCELIO_TEST_POSTGRES_URL` it is skipped, so CI does not run it.

**Mutation checks: 6/6 killed.**

| Fix | Mutant                      |
| --- | --------------------------- |
| 1   | original key reused         |
| 1   | no re-read before returning |
| 1   | no order-metadata check     |
| 1   | old create-first flow       |
| 2   | no row lock                 |
| 2   | no idempotent path          |

**Remaining.**

- The real-PostgreSQL suite ran on a superuser local cluster, not on the hosted non-superuser `postgres` role.
- CI does not provide PostgreSQL. Adding a service container is a separate, reviewable CI change.
- Hosted concurrency is not run without separate authorisation.

### 3b. Deployment-preparation correction (after review acceptance at `9b16f82`)

**Finding (HIGH, caught before deployment).** The read-only pre-deployment check compared the hosted `guard_order` with the repository. The hosted body is byte-identical to migration **039**, which added `or NEW.campaign_redemption_id is distinct from OLD.campaign_redemption_id` to the immutable financial identity of an order. The reviewed 058 had re-created `guard_order` from migration **034**'s body, so deploying it would have silently dropped that guard. A campaign redemption could then have been re-pointed on an existing order.

**Correction.** 058 now re-creates `guard_order` from 039's definition plus only the provenance exception. Its SHA-256 changes from `51b16834…49f5` to `8da442c8…7a20`. No other object changed. `guard_order` is the only existing object 058 replaces; only 034, 039 and 058 define it.

**Tests.** Two tests were added to the database suite (now 21):

- a structural test: 058's body, with the exception collapsed, equals 039's body;
- a behavioural test: changing an order's `campaign_redemption_id` after the full chain still raises `Commercial order financial identity is immutable`.

Mutation check: dropping the 039 clause fails both tests, and dropping `created_at` immutability fails the structural test. The file was restored with its hash verified.

**Consequence.** The reviewed head `9b16f82` must not be deployed. The correction needs independent re-review.

### 3c. Codex continuation: local correction and verifier review (2026-10-13)

The existing four-file correction was preserved. Review compared the complete 039 and 058 `guard_order` definitions, including trigger return type, PL/pgSQL, empty `search_path` and execution revocations. All earlier guards remain: order/learner/offer/activation/cohort/programme identity, amount/currency/provider/creation time, null-safe campaign redemption identity, deletion refusal, bound-session protection and fulfilled-order reopening refusal. The only exception is the exact recorded session replacement on an order whose old and new states are both PENDING. The attested RPC retains authenticated ownership, freshness/MAC checks, row locking, idempotency and atomic provenance/audit writes. Migrations 001–057 and application code are unchanged. The structural regression helper now fails explicitly if its definition marker or body delimiters are missing.

**Verifier crash investigation.** The historical Claude log contains `12/12 checks passed` followed by `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94` and `EXIT=127`. That execution is **not a clean pass**. On the installed Node 24.19.0, a credential-free loopback HTTP reproduction crashed in 5/5 forced-exit runs (Windows status `3221226505`, `0xC0000409`); the corresponding 5/5 natural-teardown runs exited 0. Import-only control runs did not crash. This supports removing `process.exit()`; it does not establish a clean hosted run or conclusively identify the internal Node race. See [Node's shutdown guidance](https://nodejs.org/docs/latest-v24.x/api/process.html#processexitcode) and the [upstream issue](https://github.com/nodejs/undici/issues/5680).

**External files corrected locally:** `C:\Users\naimu\OneDrive\Desktop\lr-058-verify.mjs` and `lr-058-acceptance-procedure.md`. Originals were backed up under ignored `work/058-review/`. The verifier now uses `process.exitCode` and natural teardown; SQL_ONLY is the default, and hosted Auth/refusal probes require a separate explicit `--authorize-auth-probes` flag. Hash/project/marker failures stop execution. Target validation binds the acceptance project to its HTTPS origin and session-pooler user/host/database, requires certificate-verifying TLS, and refuses the insecure-TLS override. Snapshots use exclusive creation and version/project/migration binding; the order digest now includes every order column. The procedure requires the complete expected check summary **and normal exit 0**, classifies the historical crashed run as diagnostic evidence, and requires a fresh snapshot.

**Offline verification:** 12/12 scenarios passed with actual expected exit codes (success 0, invalid arguments 2, failed preconditions 1). Default-mode tests refuse any Auth-module import. Simulated SQL_ONLY pre/post runs report 11/11 and 21/21; explicitly opted-in mock Auth runs report 12/12 and 25/25. These are stubs proving control flow, refusals and shutdown, **not hosted PostgreSQL/JWT/PostgREST acceptance**. Evidence and harnesses are in ignored `work/058-review/` and `.session-058-*.log` files.

**Deployment safety findings:** the procedure's legacy `--db-url "$DBURL"` examples put credentials in process arguments; output masking cannot prevent that exposure, and the referenced mask was not supplied. Those steps are now explicitly blocked pending an independently reviewed, CLI-supported credential-safe invocation and target binding. The hosted harness also signs into Auth and must not be called read-only. Remaining verifier limitations: ledger normalisation is not byte-identical SQL comparison inside quoted strings, and privilege snapshots do not cover all column/schema privileges or all existing function bodies. No hosted verifier, Auth sign-in, deployment, Stripe call, key provisioning, commit, push or merge was performed in this continuation.

**Final local gates (Node 24.19.0, npm 10.5.0, Windows):**

| Gate                                       | Result                                                                                                                    | Exit |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---- |
| `VITEST_MAX_WORKERS=2 npm run check`       | lint and typecheck passed; 4,276 tests passed in 176 files; optional PostgreSQL file / 5 tests skipped in this invocation | 0    |
| Optional PostgreSQL concurrency suite      | 5/5 passed on a fresh isolated PostgreSQL 17.10 cluster, loopback only; server shut down cleanly                          | 0    |
| `npm run build`                            | production build passed, no environment override                                                                          | 0    |
| `npm run format:check`                     | all matched files passed                                                                                                  | 0    |
| `git diff --check`                         | clean                                                                                                                     | 0    |
| External verifier syntax and offline cases | syntax passed; 12/12 offline cases passed, with expected success/refusal exit statuses                                    | 0    |

The first full-check attempt was interrupted without a completed result; it is not counted as a pass. No duplicate full-test job was started while it was running. The two-worker rerun completed in 812.30 seconds. An initial optional-concurrency wrapper attempt could not find the packaged readiness utility; it shut down its own cluster and ran no tests. Readiness was then checked through `pg`, and the suite passed in 16.11 seconds. No repository test/configuration change was needed for either issue.

Migration 058 SHA-256: `8da442c8841074f3d8d809c6b837ad949f2501d6e131d89023402c64afab7a20`. Final external verifier SHA-256: `c59ea0963951601bbe683eb73de7435886bd7ebaff59828672c446d7b2996071`. The only additional test edit beyond Claude's preserved correction is explicit marker/delimiter validation in the structural helper. No unrelated source, dependency, lockfile or earlier migration edits were introduced. HEAD remains `9b16f823c93696c9db255be2df0bbeb34722d307`; all changes remain local and uncommitted for independent review.

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
