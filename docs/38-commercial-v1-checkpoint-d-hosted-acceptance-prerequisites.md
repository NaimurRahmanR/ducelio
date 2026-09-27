# Commercial V1 Checkpoint D — Hosted Acceptance Prerequisites

## Current status

Checkpoints A–C (`f407526`, `e1f6f0d`, `12fd7f5`, `8cc82fc` on `commercial-v1-grading-completion`) are locally implemented and tested. Checkpoint D is currently:

**BLOCKED_BY_ENVIRONMENT**

This is not an architectural blocker in the grading/recovery/completion chain — every authority Checkpoints A–C compose was already reviewed and locally proven. The current local environment does not provide hosted infrastructure credentials or tooling sufficient to truthfully prove production-like acceptance. No hosted or billable operation is claimed until the prerequisites below are satisfied.

Verified directly in this environment (not assumed): `.env.local` holds only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `APP_URL`, `AUTH_GOOGLE_ENABLED`, `AUTH_LINKEDIN_ENABLED`, and in this session's sandbox those are present but empty placeholders, not real values. No hosted PostgreSQL connection string, no Supabase service-role credential, no `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY`, no `ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX`, no `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`COMMERCE_CONTROLLER_KEY_ID`/`COMMERCE_CONTROLLER_HMAC_KEY_HEX`, no SMTP configuration. No `supabase` CLI on PATH. No linked project reference (`supabase/.temp/project-ref` absent).

**Executable acceptance harness (Checkpoint E2/E3):** this document is now an acceptance _contract_, not the only artifact — `scripts/acceptance/*.mjs` is the executable runner that proves each surface below against real hosted infrastructure once it exists.

- `npm run acceptance:preflight` — reports configured/missing/malformed for every variable named in this document, and nothing else; never prints a value.
- `npm run acceptance:hosted` — runs every surface in the matrix below (HOSTED_DATABASE, MIGRATIONS, RLS_ACL, JWT_POSTGREST, GRADING, INITIAL_RECOVERY, REGRADE, RESULT_PROGRESS_COMPLETION, STRIPE_TEST_MODE, SUPABASE_AUTH_EMAIL, LIVE_PROVIDER, MONITORING, BACKUP_RESTORE, FULL_CUSTOMER_JOURNEY) and prints a PASS/FAIL/BLOCKED/NOT_RUN matrix. A missing prerequisite is always BLOCKED, never a false PASS.
- `npm run acceptance:concurrency` — the true multi-connection PostgreSQL concurrency scenarios from section 2 below, using genuinely independent `pg` connections (never PGlite, never sequential queries dressed up as concurrency).
- `npm run acceptance:examiner-app` — the real-application driver for `EXAMINER_APP:GRADING`, `EXAMINER_APP:INITIAL_RECOVERY` and `EXAMINER_APP:REGRADE` (section 4a below). It never signs anything itself; `acceptance:hosted` is unchanged and still reports these three surfaces as BLOCKED.
- `npm run acceptance:live-provider` — the explicitly double-authorized paid smoke tests `LIVE_PROVIDER:OPENAI_EXAMINER` and `LIVE_PROVIDER:ANTHROPIC_LAB` (section 5 below). It is the only command that may make a billable provider request; `acceptance:hosted` never does.

Three surfaces (`GRADING`, `INITIAL_RECOVERY`, `REGRADE`) are deliberately, permanently `BLOCKED` from this harness by design: the HMAC canonical-message-construction logic for those governance surfaces exists in exactly one place, `src/server/commercial-v1-examiner-*/authority.ts`, and this harness never reimplements that trust-critical protocol outside the application itself. Full acceptance of those three surfaces means driving the real Ducelio application server (configured against the hosted database/provider) over HTTP, mirroring `scripts/smoke.mjs`'s own established pattern — not a parallel script. This is an explicit, reviewed architectural choice, not an oversight.

A new acceptance-tooling-only variable, `ACCEPTANCE_DATABASE_URL` (a direct, privileged `postgres://`/`postgresql://` connection string to a dedicated staging/acceptance database — never production, never the application's own runtime credential, which has none; validated against a database-specific scheme check, distinct from and never weakening the `http(s)://`-only validation used for `NEXT_PUBLIC_SUPABASE_URL`/`ACADEMIC_PROVIDER_BASE_URL`), plus `ACCEPTANCE_ENVIRONMENT_ID`, `ACCEPTANCE_DATABASE_INSECURE_TLS`, `ACCEPTANCE_ADMIN_EMAIL`/`ACCEPTANCE_ADMIN_PASSWORD`, `ACCEPTANCE_LEARNER_EMAIL`/`ACCEPTANCE_LEARNER_PASSWORD`, `ACCEPTANCE_FOREIGN_LEARNER_EMAIL`/`ACCEPTANCE_FOREIGN_LEARNER_PASSWORD` (real synthetic hosted Supabase Auth identities — the foreign-learner pair is a **hard prerequisite** for `JWT_POSTGREST`, not optional, per the correction below), `ACCEPTANCE_LIVE_PROVIDER_OPT_IN` and `ACCEPTANCE_STRIPE_LIVE_OPT_IN` are introduced for this harness alone; none is read by `src/**`. See `scripts/acceptance/env.mjs` for the authoritative list and validation rules.

**Same-environment binding (independent-review finding 1):** `ACCEPTANCE_DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` are two independent network paths (a direct PostgreSQL connection versus PostgREST/Supabase Auth) with no structural proof, on their own, that they point at the same environment — a staging database URL alongside a production Supabase project URL is otherwise indistinguishable from a correctly-matched pair. `ACCEPTANCE_ENVIRONMENT_ID` (a UUID the operator chooses once) is the single identifier both sides must independently attest to holding:

- **Direct-database marker** (`scripts/acceptance/db.mjs`): a table `public._ducelio_acceptance_marker(marker text primary key, environment_id uuid not null)`, holding one row `('DUCELIO_ACCEPTANCE_ENVIRONMENT_V1', '<ACCEPTANCE_ENVIRONMENT_ID>')`. Never created automatically — an operator provisions it once, by hand, directly against their dedicated staging/acceptance database, using the exact statement `scripts/acceptance/db.mjs`'s `acceptanceMarkerProvisioningSql(environmentId)` generates for their chosen id.
- **Hosted Supabase marker** (`scripts/acceptance/supabase.mjs`): a narrowly-scoped, manually-provisioned RPC, `public.get_ducelio_acceptance_environment_id()`, returning only the same UUID — granted to `authenticated` only (never `anon`), never a Ducelio migration, created once by hand directly against the dedicated acceptance Supabase project. It exposes no secret and no privileged database metadata, only the environment's own declared identity.

`assertAcceptanceDatabaseWriteAuthorized(client)` (direct-DB gate) requires ALL of: `ACCEPTANCE_WRITE_ENABLED === "true"`; a configured, well-formed `ACCEPTANCE_ENVIRONMENT_ID`; and a marker row whose `environment_id` exactly matches it. `assertAcceptanceSupabaseWriteAuthorized(client)` (Supabase gate) requires the RPC to exist, be callable, and return exactly `ACCEPTANCE_ENVIRONMENT_ID`. `seedAcceptanceCourse` (`scripts/acceptance/fixtures.mjs`) — the only function that writes through the Supabase path — calls the Supabase gate first (fully testable without a live database connection) and the direct-DB gate second; **either failing, or the two disagreeing, means BLOCKED before a single product write RPC is ever called.** `seedAcceptanceResults` and every concurrency race (`scripts/acceptance/concurrency.mjs`) write only through the direct `pg` connection and so need only the direct-DB gate — but independent-review finding 2 additionally requires it on **every** writing connection a scenario opens (`assertAllAcceptanceDatabaseWriteAuthorized`), not merely the first of several. Read-only preflight/introspection (`HOSTED_DATABASE`, `MIGRATIONS`, `RLS_ACL`) never calls either gate and remains available with `ACCEPTANCE_DATABASE_URL` alone.

**TLS (independent-review finding 4):** the direct database connection no longer unconditionally disables certificate verification. By default it relies entirely on `ACCEPTANCE_DATABASE_URL`'s own TLS parameters; the insecure, certificate-skipping mode is available only behind the separately-named `ACCEPTANCE_DATABASE_INSECURE_TLS` opt-in, which also appears as its own clearly-labelled `WARNING` in `npm run acceptance:preflight` when set.

---

## 1. Hosted Supabase / PostgreSQL

**Blocker:** no hosted PostgreSQL connection string, no Supabase service-role credential, no Supabase CLI, no linked project. Cannot independently verify hosted migration application, real PostgreSQL behaviour, real hosted RPC execution, hosted RLS/ACL behaviour, hosted JWT/PostgREST behaviour, or true multi-connection concurrency.

**Prerequisites:** a dedicated non-production acceptance Supabase project, with `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, hosted PostgreSQL connection information suitable for migration/concurrency testing, and — only where a reviewed administrative acceptance operation genuinely requires it — a service-role credential; note this repository's application code has no service-role credential anywhere in its runtime architecture today (deliberate RLS/RPC-only design), so any service-role use here is CLI/acceptance-tooling only, never application code. Supabase CLI and project reference if CLI-based migration/status verification is used. A PostgreSQL client capable of opening at least two genuinely independent connections. Secrets stay outside source control, are never logged, never embedded in test fixtures, never returned to browser code.

**Acceptance required:** migrations 001–040 apply in order; no historical migration requires rewriting; all expected Commercial V1 RPCs/functions exist; RLS is enabled where expected; authenticated learner access is correctly scoped; foreign-learner reads/writes are denied; anon access is denied where required; service-role access does not bypass reviewed authority through public application surfaces; assessment writer behaviour matches local acceptance; Examiner initial grading, initial-grade recovery, and result/progress/completion all work under hosted PostgreSQL.

Status until proven: **HOSTED DATABASE MIGRATIONS — BLOCKED**, **HOSTED RLS/ACL — BLOCKED**, **HOSTED JWT/POSTGREST — BLOCKED**.

---

## 2. True PostgreSQL concurrency

**Blocker:** PGlite is single-connection for the relevant repository tests. Strong deterministic/sequential coverage, but cannot prove real PostgreSQL blocking/race behaviour across concurrent sessions. Status: **NOT RUN**.

**Prerequisite:** a real PostgreSQL environment permitting multiple simultaneous connections — prefer the dedicated hosted acceptance database over production.

**Required race tests** (independent connections/processes):

- **Examiner initial grading:** two simultaneous initial AUTHORIZE attempts for the same target → exactly one durable initial claim, no duplicate provider authority, no duplicate result.
- **Initial grading vs recovery:** race a late initial execution/finalization against institutional recovery admission → never two revision-1 results; one side deterministically loses according to database authority.
- **Recovery vs recovery:** two simultaneous recovery admissions for the same source → exactly one recovery execution, one bounded replay/denial, no duplicate provider-call authority. This directly exercises `examiner_recovery_one_per_source` under real concurrent contention, not just PGlite's sequential unique-index proof.
- **Grading finalization vs completion:** completion never sees an impossible partially-finalized result; either grading commits first and completion evaluates it, or completion refuses because authoritative grading remains incomplete.
- **Regrade vs completion:** where the current authority permits the operation, current result revision and completion remain transactionally consistent; completion cannot silently use a superseded revision.
- **Duplicate course completion:** two simultaneous completion attempts on the same enrolment → one durable completion result/receipt, deterministic idempotent replay, no duplicate institutional completion record. This directly exercises `attemptCommercialV1CourseCompletion`'s replay guarantee under real concurrent contention, not just PGlite's sequential proof from Checkpoint C's own tests.

Successful acceptance permits: **TRUE POSTGRES CONCURRENCY — PASS**.

---

## 3. Hosted Auth / JWT / PostgREST

**Blocker:** no hosted authenticated acceptance session has been exercised. Local tests emulate/verify the authority model but do not prove the complete Supabase Auth → JWT → PostgREST → RLS path.

**Prerequisites:** a hosted acceptance project with Supabase Auth enabled, at least one isolated synthetic test learner, at least one authorized institutional admin, (independent-review finding 3: no longer optional) a second, unrelated synthetic learner for foreign-principal denial tests, (JWT_POSTGREST completion pass: no longer optional) a third, unrelated non-admin institutional staff identity for the recovery role-gate denial test, and (JWT_POSTGREST completion pass) a genuinely expired, previously valid synthetic learner JWT — a malformed token alone is never evidence that expiry enforcement itself works. `scripts/acceptance/surfaces.mjs`'s `checkJwtPostgrest` BLOCKS rather than PASSes if any of these is absent or incomplete, and independently re-verifies the unrelated-staff identity against the real hosted role model rather than trusting how it is labelled, so this surface can never PASS without actually proving foreign-learner isolation, the institutional recovery role gate, and genuine JWT expiry.

**Acceptance required:** learner JWT resolves to the correct authenticated identity; learner cannot override actor/student IDs; learner sees only owned enrolment/work/results; learner cannot invoke admin recovery; an authorized `ACADEMIC_ADMIN`/`PLATFORM_ADMIN` reaches past the recovery role gate to the HMAC-attestation boundary — this proves JWT/role authority only and is **not** proof of successful recovery, which remains the separate, still-BLOCKED-by-design surface in Section 4/`INITIAL_RECOVERY` (real HMAC attestation against provisioned key material, driven through the actual application server, never reimplemented by this harness); unrelated non-admin staff roles cannot cross the recovery role gate; expired/invalid JWT fails closed against the real hosted Supabase/PostgREST endpoint, never a local decoder standing in for it; PostgREST/RPC calls enforce the same DB authority as local tests; no protected assessment data crosses the learner API boundary.

Successful acceptance permits: **HOSTED JWT/POSTGREST — PASS**.

---

## 4. Examiner controller/HMAC provisioning

**Blocker:** Checkpoint A reuses Ducelio's reviewed controller HMAC trust root, but production/hosted controller keys have not been provisioned or accepted.

**Prerequisites:** provision matching server-side and database-side controller key material per the existing `academic_execution_private.controller_keys` design. Confirmed exact environment variable names already used by this repository's source (`src/server/academic-provider-execution/authority.ts`, `src/server/commercial-v1-examiner-{grading,regrade,recovery}/authority.ts`, `src/server/tutor-lab-execution/authority.ts`, `src/server/academic-execution/authority.ts`): `ACADEMIC_EXECUTION_KEY_ID`, `ACADEMIC_EXECUTION_HMAC_KEY_HEX`. This single key pair is shared across every governance surface (initial grading, regrade, recovery, tutor/lab, Professor execution); each surface's own distinct canonical-message protocol tag is what keeps one attestation from authorizing another surface's transition, not a separate key.

**Operational requirements:** key material lives in a secret manager/environment, never source; rotation procedure documented; inactive/old keys behave per existing DB policy; logs never print MAC/key material; backups protect the private key tables; server and database provisioning agree exactly.

**Acceptance required:** valid AUTHORIZE MAC accepted; tampered MAC rejected; expired MAC rejected; wrong operation rejected; wrong actor rejected; wrong execution/target rejected; recovery protocol cannot be authorized by an initial/regrade MAC; initial/regrade protocols cannot consume recovery attestations. (All of this is already proven locally per-surface via PGlite — this row proves the same holds against the real, hosted, provisioned key material, not the design.)

## 4a. Real-application examiner acceptance (`npm run acceptance:examiner-app`)

`scripts/acceptance/examiner-app.mjs` starts the real Ducelio app locally (`next dev`, loopback only) against the hosted acceptance project and drives the existing production entrypoints over HTTP through the acceptance-only route `src/app/api/acceptance/examiner-app/route.ts`: learner `submitControlledAssessmentAndGrade` → `gradeControlledAssessmentAttempt`, admin `recoverExaminerTarget`, admin `regradeControlledAssessment`. Every HMAC is produced by the existing `authority.ts` modules; the route and driver construct none.

- **Route gate (404 unless all hold):** `ACCEPTANCE_APP_DRIVER_ENABLED=true`, a per-run 64-hex `ACCEPTANCE_APP_DRIVER_TOKEN` presented by the caller, `NODE_ENV` not production, loopback `APP_URL` and request Host, no browser `Origin`/`Sec-Fetch-Site`, and `ACCEPTANCE_ENVIRONMENT_ID` both configured and returned by the hosted `get_ducelio_acceptance_environment_id()` for the caller's real session. The driver sets these new variables (plus `ACCEPTANCE_PROVIDER_STUB_URL` and `ACCEPTANCE_PROVIDER_REDIRECT_TOKEN`) in its own child process only; operators never configure them, and the tokens are never printed.
- **Identity:** genuine hosted Supabase Auth sessions (learner, admin, and unrelated staff when configured) held as the app's own SSR cookies; the route accepts no actor/student/capability/provider/model/marks input.
- **Provider:** a deterministic loopback stub speaking the OpenAI Responses contract; the child app gets only a per-run stub key and a preload that sends the one Responses URL to the stub and refuses every other AI-vendor request. Passing that preload through `NODE_OPTIONS` is **not** treated as sufficient: the installed wrapper is marked with a second per-run secret (`ACCEPTANCE_PROVIDER_REDIRECT_TOKEN`), and the route gate itself — per request, inside the exact process serving it, before the body is read or anyone is signed in — calls the CURRENT `globalThis.fetch` with an in-process sentinel request that only that marked wrapper answers with its marker. This passes through Next.js's own fetch patching and proves the wrapper is in the fetch chain the production provider adapter uses; if the redirect is absent or fetch was replaced, the route answers 404, readiness reports `GATE_REFUSED` and every surface is BLOCKED before any sign-in or fixture write (the sentinel's `.invalid` host can never resolve, so no HTTP connection is possible).
- **Evidence boundary:** a successful run establishes only the named hosted application surfaces `EXAMINER_APP:GRADING`, `EXAMINER_APP:INITIAL_RECOVERY` and `EXAMINER_APP:REGRADE`. It is never LIVE_PROVIDER evidence, and it does not execute section 4's adversarial MAC cases (tampered, expired, wrong operation/actor/target, cross-protocol); those remain the existing local PGlite evidence until separately exercised against the hosted key.
- **Fixtures:** two permanent run-id-tagged courses (`<runId>-examiner-grade`, `<runId>-examiner-recovery`) via `seedAcceptanceCourse` with the EXAMINER role enabled; the recoverable execution is produced by the real grading path (stub HTTP 503 → FAILED/PROVIDER_UNAVAILABLE), never written directly.
- **Operator prerequisites for the hosted run:** everything `acceptance:concurrency` needs (`ACCEPTANCE_DATABASE_URL`, `ACCEPTANCE_WRITE_ENABLED=true`, `ACCEPTANCE_ENVIRONMENT_ID` + marker row + hosted RPC, admin/learner identities), plus `ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX` (64 lowercase hex) with the SAME key installed and unrevoked in the hosted `academic_execution_private.controller_keys` (the driver checks presence read-only and never provisions keys). No other `next dev` may be running in the same checkout.

---

## 5. Live AI provider acceptance (`npm run acceptance:live-provider`)

**Correction (live-provider acceptance checkpoint):** an earlier version of this section named `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` as the Commercial V1 provider configuration. That has been stale since PR22's native AI routing (`docs/32-commercial-v1-native-ai-routing.md`).

**Current configuration.** Commercial V1 production profiles route natively. The only provider credentials are the server-only `OPENAI_API_KEY` (every `OPENAI_RESPONSES` profile, including `EXAMINER_COMMERCIAL_V1`) and `ANTHROPIC_API_KEY` (every `ANTHROPIC_MESSAGES` profile: `LAB_INSTRUCTOR_COMMERCIAL_V1` and, since the Operations Engineer routing correction, the internal `OPERATIONS_ENGINEER_PLATFORM_V1` / `claude-opus-5-5` profile, which the live-provider harness below does not exercise). Endpoints, model ids, tariffs and budget policies stay code-owned in `src/server/academic-runtime/provider.ts` and `src/server/academic-runtime/profile-registry.ts`; no environment variable, browser, course package or stored agent configuration can choose them. Without the relevant key, `resolveAdapterForProfile` returns `null` and execution fails closed to `NO_PROVIDER_CONFIGURED` before any network call.

`ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` configure only the **legacy** generic `HTTP_JSON` adapter (`resolveConfiguredProvider`), kept for backward compatibility. No current Commercial V1 production profile routes through it, so it is not required for Commercial V1 and is not a live-provider acceptance target.

**Explicit double authorization.** A key existing — in `.env.local` or the shell — is never permission to spend. `npm run acceptance:live-provider` makes a provider request only when BOTH `ACCEPTANCE_LIVE_PROVIDER_OPT_IN` is exactly `true` AND the operator passes `--authorize-live-provider` (`npm run acceptance:live-provider -- --authorize-live-provider`). Without both, every surface reports `BLOCKED` (`EXPLICIT_AUTHORIZATION_REQUIRED`), no server starts and zero provider requests are made. With both, a surface whose own key is absent BLOCKS on its own and the other still runs. `npm run acceptance:hosted` never makes a paid request: its `LIVE_PROVIDER` row is always `BLOCKED` and points at the dedicated command.

**Surfaces (exactly two).**

| Surface                         | Production profile             | Adapter / model                          | Role / capability                          |
| ------------------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------ |
| `LIVE_PROVIDER:OPENAI_EXAMINER` | `EXAMINER_COMMERCIAL_V1`       | `OPENAI_RESPONSES` / `gpt-5.6-luna`      | `EXAMINER` / `grade_controlled_assessment` |
| `LIVE_PROVIDER:ANTHROPIC_LAB`   | `LAB_INSTRUCTOR_COMMERCIAL_V1` | `ANTHROPIC_MESSAGES` / `claude-sonnet-5` | `LAB_INSTRUCTOR` / `tutor_lab_support`     |

Each is requested exactly once per authorized invocation: at most one OpenAI and one Anthropic request, no script-level retry and no probe call; the only provider retry is what the production profile permits (`maxAttempts` 1).

**How it runs.** `scripts/acceptance/live-provider.mjs` builds no provider request. It starts the real app locally (`next dev`, loopback only) and calls the acceptance-only route `src/app/api/acceptance/live-provider/route.ts`, which accepts exactly `{ "operation": "OPENAI_EXAMINER_SMOKE" | "ANTHROPIC_LAB_SMOKE" }` — any other field (provider, model, profile, endpoint, key, budget, context, role, capability, prompt/instructions) is rejected with 400. `src/server/live-provider-acceptance-driver.ts` then reaches the existing production path: `resolveRoleBoundRuntimeProfile` → `resolveAdapterForProfile` → `runGovernedProviderExecution` (the same adapters, request construction, response schemas, tariffs, failure vocabulary and budget/deadline enforcement the product uses). Each plan pins the expected profile ref, adapter, model, OpenAI reasoning effort (`medium` for the Examiner) and the exact execution envelope (`maxProviderCalls` 1, `maxAttempts` 1, `maxOutputTokens` 1200/700, `maxEstimatedCostMicrousd` 50000/40000, `totalDeadlineMs` 15000). Drift in any pinned value — e.g. `maxAttempts` 2, which could otherwise allow a second billable request — fails closed as `PROFILE_MISMATCH` / `NOT_EXECUTED` / `providerCalls=0` before the adapter is resolved or the runtime runs. Tariffs are not pinned (they stay owned by the registry/adapter and only affect the reported cost, which the pinned cost ceiling bounds). The Examiner smoke applies the existing strict `parseExaminerAssessmentProviderOutput` and, for `GRADED`, `validateExaminerAssessmentMarks` against its synthetic context; a valid `ESCALATE` is a valid fail-safe outcome. The Lab smoke relies on the production adapter's bounded output parser; its synthetic reason is `PRACTICAL_HELP`, typed against the existing `TUTOR_LAB_ALLOWED_REASONS.LAB_INSTRUCTOR` authority. A PASS additionally requires the evidence to show exactly one provider request (`providerCalls === 1` and `attempts === 1`), enforced at the server verdict and again by the driver's evidence consumer. Both contexts are tiny, hard-coded, labelled synthetic demo content with fixed UUID-shaped identifiers, no real learner or course data and no personal data. This harness uses no database, no HMAC attestation and no database clock; only the normal provider/runtime deadline applies.

- **Route gate (404 unless all hold, checked before the body is read):** `ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED=true`; a fresh per-run 64-hex `ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN` presented in `x-ducelio-live-provider-driver` (constant-time comparison); `NODE_ENV` not production; `ACCEPTANCE_LIVE_PROVIDER_OPT_IN=true`; `ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED=true` (the driver's propagation of `--authorize-live-provider`); no examiner-app driver/provider-stub redirect marker in the process (so stubbed traffic can never be reported as live evidence); loopback `APP_URL` and request Host; no `Origin`/`Sec-Fetch-Site`. The driver sets these only in its own child process; operators never configure them. This gate deliberately does not reuse, and does not change, the examiner-app redirect-attestation gate (section 4a).
- **Child secret minimisation:** the child receives the per-run gate settings, a loopback `APP_URL` and only the provider key(s) for the authorized, key-present surfaces. The acceptance database URL and write flag, acceptance identities, `ACADEMIC_EXECUTION_*`, `STRIPE_*`, `COMMERCE_CONTROLLER_*`, the legacy `ACADEMIC_PROVIDER_*` pair, Supabase URL/keys, `NODE_OPTIONS`, any other inherited credential-shaped name and every name defined in any `.env*` file Next.js could load are forced to empty strings (which Next.js's `.env` loader never overrides). Name enumeration fails closed: if such a file exists but cannot be read or decoded as UTF-8, the authorized run is `BLOCKED` (`ENV_FILE_NOT_INSPECTABLE`, naming only the file) before the app starts, with zero provider requests. Child output is never forwarded; keys are never written to any file.
- **Evidence (metadata only):** provider family, adapter kind, profile ref, model id, runtime outcome and bounded detail code, parsed Examiner outcome (`GRADED`/`ESCALATE`), strict-parse and marks-validation booleans, Lab output length, `providerCalls`, `attempts`, input/output tokens, estimated cost (micro-USD, production tariff), elapsed ms, and whether usage fits the exact production profile envelope. The driver re-validates every field against a closed vocabulary before printing and reports the total provider requests made. Raw model output, provider request/response bodies, the synthetic expected answer/marking guidance, parsed marks, headers and keys are never returned, printed or stored. **No raw provider or model content is acceptance evidence.**

A successful run establishes **LIVE-PROVIDER-TESTED** for the named surface(s) only — one authorized request through the current production adapter/runtime returned a result that passed the existing strict parsing/validation inside the production budget envelope. It never establishes **PRODUCTION-PROVEN**, production readiness, or any claim about grading or instructional quality.

Current status: **LIVE_PROVIDER_ACCEPTANCE_PENDING_AUTHORIZATION** — the harness exists and its unauthorized invocation is verified to make zero provider requests; no authorized run has been performed.

---

## 6. Stripe test-mode acceptance

**Blocker:** no Stripe configuration exists in this environment. Confirmed exact environment variable names (`src/lib/env.ts`'s `readCommerceConfig`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, plus this repository's separate `COMMERCE_CONTROLLER_KEY_ID`/`COMMERCE_CONTROLLER_HMAC_KEY_HEX` (a distinct controller trust root from `ACADEMIC_EXECUTION_*` above — commerce and academic execution are deliberately separate authorities). None are set; `commerceConfig().configured` is false, so checkout fails closed truthfully today rather than simulating success.

Current status: **BLOCKED**.

**Prerequisites:** Stripe test-mode credentials only — server secret key, publishable key where required client-side, webhook signing secret, a configured test webhook endpoint.

**Acceptance required:** checkout session uses server-owned amount/currency; browser cannot override amount/currency; success redirect does not itself grant entitlement; a signed webhook/reconciliation grants paid access; a duplicate webhook is idempotent; replay cannot create duplicate fulfilment; promotional/campaign pricing remains server-owned; `REVIEWER_COMPLIMENTARY` creates access without a fake payment/order; a paid promo cannot accidentally produce unauthorized zero-price access. No real card charge is required.

Successful acceptance: **STRIPE TEST MODE — PASS** — never described as live-payment production acceptance.

---

## 7. SMTP / transactional email

**Blocker:** this repository has no application-level SMTP/mail-provider environment variable anywhere in `src` today — confirmed by direct search, not assumed. Signup/verification/reset email currently rides entirely on Supabase Auth's own hosted email delivery (configured, if at all, in the Supabase project dashboard, not as a Ducelio app secret). If launch requires custom transactional email (e.g. non-auth notifications), that is itself unbuilt application scope, not merely an unconfigured credential — document which is actually true before writing acceptance criteria against it.

**If using Supabase Auth's built-in email:** verify, per hosted project, that the signup/verification and password-reset emails are actually deliverable from the project's configured sender, with a non-production recipient/domain where possible, and that failure behaviour (undeliverable, rate-limited) fails closed rather than silently.

**If a custom SMTP integration is later built:** apply the same acceptance discipline as every other surface here — a dedicated environment variable set, secrets server-only, a real send/failure acceptance test, no secret in logs — before ever calling it PASS.

Successful acceptance: **SMTP — PASS**, scoped to whichever of the two paths above is actually true for the launch plan.

---

## 8. Monitoring and operational visibility

**Blocker:** no hosted target exists from which to prove production monitoring.

**Prerequisites:** application error monitoring; hosted database health visibility; provider failure/error-rate visibility; Examiner execution failure/timeout visibility; payment/webhook failure visibility; background/operational job visibility where applicable; usage/cost observation; a named alert destination/owner.

**Never log:** learner assessment response bodies, answer keys, provider secrets, HMAC values, raw authentication tokens — consistent with every governance surface's own reviewed audit-privacy design (metadata-only audit rows throughout this codebase already enforce this at the database layer; monitoring must not reintroduce a leak the database layer deliberately closed).

**Acceptance:** trigger controlled non-sensitive failures and verify they are visible/actionable. Successful acceptance: **MONITORING — PASS**.

---

## 9. Backup and restore

**Blocker:** no hosted database target exists in the present environment.

**Prerequisites:** for the intended production Supabase/PostgreSQL environment — backup policy, retention, restore procedure, a responsible operator, secret/private-schema protection.

**Acceptance:** a backup feature being merely enabled is not sufficient proof. Before production acceptance, perform or obtain credible evidence of restoration into an isolated environment and verify critical Ducelio records survive coherently: enrolments, programme/course versions, assessment attempts/responses, lab submissions, Examiner execution/result history, recovery/regrade history, current result revisions, completion receipts, commerce entitlement/payment provenance.

Successful evidence: **BACKUP/RESTORE — PASS**.

---

## 10. Required hosted acceptance environment

A dedicated Ducelio staging/acceptance environment, never production learner records, with: a separate hosted Supabase project/database; synthetic users; current migrations 001–040; dedicated controller/HMAC keys (`ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX`, `COMMERCE_CONTROLLER_KEY_ID`/`COMMERCE_CONTROLLER_HMAC_KEY_HEX`); native provider credentials (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`) plus explicit double authorization for the provider smoke test (section 5); Stripe test-mode credentials (`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`); a confirmed email-delivery path (Supabase Auth's own, or a built custom SMTP integration); monitoring enabled.

---

## 11. Recommended execution order

1. Provision hosted Supabase/PostgreSQL.
2. Apply/verify migrations 001–040.
3. Verify RLS/ACL and JWT/PostgREST.
4. Provision controller/HMAC trust (`ACADEMIC_EXECUTION_*`).
5. Run real multi-connection PostgreSQL concurrency tests (Section 2).
6. Run hosted grading/recovery/result/completion acceptance using mocked/no-provider execution first.
7. Perform one explicitly authorized bounded live-provider smoke test (`npm run acceptance:live-provider -- --authorize-live-provider` with `ACCEPTANCE_LIVE_PROVIDER_OPT_IN=true`).
8. Run Stripe test-mode acceptance.
9. Confirm the email-delivery path.
10. Verify monitoring.
11. Verify backup/restore procedure.
12. Run the complete staged customer journey (Section 12).

Do not skip deterministic/database acceptance merely because a provider smoke test succeeds.

---

## 12. Final hosted customer-journey acceptance

Before Commercial V1 is described as production-ready, prove one isolated end-to-end staged learner journey: public course → account/authentication → test-mode payment or reviewer entitlement → enrolment → delivery plan → classroom → Tutor/Lab activity → controlled assessment → durable assessment submission → Examiner grading → explicit recovery where intentionally injected/tested → final lab submission → authoritative result → progress/diagnostics → course completion → completion receipt. The journey must require no manual SQL repair.

Negative-path acceptance must also include at least: provider unavailable; terminal initial grade requiring institutional recovery; duplicate submission/replay; foreign learner attempt; payment/webhook replay; incomplete result set; below published pass requirement; completion replay.

---

## Evidence classification

Used strictly throughout this and every prior checkpoint document:

- **IMPLEMENTED** — exists in repository source.
- **LOCAL-TESTED** — passed local deterministic/PGlite/unit/integration gates.
- **HOSTED-TESTED** — actually exercised against the configured hosted environment.
- **LIVE-PROVIDER-TESTED** — actually made an authorized live provider request.
- **PRODUCTION-PROVEN** — production environment and operational acceptance have independently satisfied the required launch criteria.

Never infer a stronger status from a weaker one.

## Current Checkpoint D matrix

| Surface                     | Current status                                                                          | Requirement to unblock                                                           |
| --------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Hosted DB migrations        | BLOCKED                                                                                 | Hosted DB + migration access                                                     |
| Hosted RLS/ACL              | BLOCKED                                                                                 | Hosted Supabase/PostgreSQL                                                       |
| Hosted JWT/PostgREST        | BLOCKED                                                                                 | Hosted Auth + synthetic identities                                               |
| True PostgreSQL concurrency | NOT RUN                                                                                 | Multiple real DB connections                                                     |
| Hosted grading/recovery     | BLOCKED                                                                                 | DB + controller key provisioning, then `npm run acceptance:examiner-app`         |
| Hosted result/completion    | BLOCKED                                                                                 | Hosted DB/auth acceptance                                                        |
| Live provider               | PENDING AUTHORIZATION (harness built; zero-request unauthorized run verified)           | `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` + explicit double authorization (section 5) |
| Stripe                      | BLOCKED                                                                                 | `STRIPE_*`/`COMMERCE_CONTROLLER_*` test-mode keys/webhook                        |
| SMTP / email delivery       | BLOCKED (or N/A if Supabase Auth's built-in email is the accepted path — confirm which) | Mail provider configuration, or acceptance test of Supabase Auth's own delivery  |
| Monitoring                  | BLOCKED                                                                                 | Hosted deployment + monitoring                                                   |
| Backup/restore              | BLOCKED                                                                                 | Hosted DB + backup/restore procedure                                             |

Checkpoint D becomes complete only when the required rows are supported by actual acceptance evidence, never configuration assumptions.
