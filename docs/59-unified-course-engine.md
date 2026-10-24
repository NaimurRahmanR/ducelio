# Unified Course Engine replacement

This branch implements the shared course lifecycle, checkout/coupons, personal activation/windows, academic revision, tenant authority and legacy retirement. Owner-approved migrations 067-073 are now applied only to ducelio-acceptance; all 11 hosted schema/permission readiness checks pass. Real browser upload-to-personal-timetable acceptance passes, including a corrected preview/reset defect. A real-time hosted examination journey and final regression rerun are running. It is not a production release: live provider/platform-admin credentials are absent, remaining operational acceptance is open and GitHub CI is billing-blocked. The same branch and draft PR #84 are retained; main was reconciled by merge 248851f and the unrelated stash is preserved. Earlier dated verification sections below remain as historical evidence; the latest continuation record at the end supersedes their status.

## Working implementation

Migration `202610280067_unified_course_engine.sql` adds explicit package and publication registers. They start empty, with no legacy import/backfill. The existing historical course, payment, curriculum and audit tables remain intact. All new tables have RLS enabled, no direct client/service-role grants, immutable history and effective ACL assertions under Supabase defaults.

The canonical interface is `/admin/course-engineering`: upload one `ACADEMY_COURSE_PACKAGE_V1` JSON, review validation, enter one course price, configure the Professor, Tutor, Lab Instructor, Examiner and academic support proposal, then publish. Configuration changes create a new immutable validated package revision; they do not rewrite published/enrolled configuration. The academic Counsellor proposal does not launch Sarah, whose support authority remains separate. Instructional notes are accurately labelled as recorded metadata rather than executable prompts. Runtime profiles and capabilities remain subject to the reviewed domain/DB allowlists.

`publish_unified_course` executes the same authorities used by `prepareAcademyCurriculum`: import, full DB validation, apply, agent configuration, pre-publication test and curriculum publication. It then calls the existing `publish_academy_course` and `enable_academy_public_sale`. No cohort, instructor allocation, timetable or manual activation is created. The transaction's package lock serialises publication. A failed gate rolls back materialisation. Identical terms replay; changed price/currency/slug/summary are refused. All declared feasible durations receive the same price, derived from the package in the DB rather than a client list. The initial supported currencies are GBP, USD and EUR, each with two decimal places.

`/courses` and `/courses/[slug]` use only the new published register. The old Academy detail and engineering routes redirect to the canonical routes with validated handles. Migration 073 retires the old course register, activation and Operations Engineer product entrypoints. The root administration page opens the unified editor; new learners land in My Learning. Historical records remain separately accessible. Sarah reads the same unified public catalogue, with actual personal-duration choices and no invented cohort start date, and refuses course guidance during an active purchased course.

Migration `202610290068_unified_course_checkout.sql` adds coupon configuration, immutable reservation/redemption evidence and immutable order terms. Normal and partially discounted purchases use the existing Academy order ledger, Stripe adapter, HMAC fulfilment controller, webhook, signed expired-session replacement and refund/revocation authority. A purchase records no duration. A provenance trigger admits a duration-unselected paid entitlement only for a matching unified order. Historical purchased-format constraints are retained for legacy orders through this guard.

The DB calculates discounts with integer arithmetic and rounds a fractional minor unit upward in the payable amount. A coupon that cannot reduce a tiny price is refused. The browser supplies only course slug and optional code. A bound Stripe URL is checked against the order identity, kind, amount and currency. A 100% coupon atomically creates one coupon-backed entitlement/enrolment and no Stripe order, event or charge. It also works with card commerce disabled. Neither paid nor free access creates a timetable.

`/admin/course-engineering/coupons` supports code creation, UTC expiry, percentage (including 100) or (migration 074) a fixed amount in one currency, redemption limit, one-course/all-unified-course restriction, activation/deactivation and newest-200 reporting. Coupon terms cannot be rewritten; availability changes are audited. Pending orders consume a reserved use. A retry or expired-session recovery reuses the same order and reservation, including after coupon expiry/deactivation. Changing a pending order's coupon is refused. Capacity is deliberately not released while a Stripe session may still pay. Migration 072 adds verified cancellation and released-slot reporting in My Learning; the server retains the slot when a session is paid, uncertain or not yet bound. An unbound checkout can resume first to establish a verifiable provider session.

## Verification and limits

Node 24.19.0; lockfile dependencies installed using `npm.cmd ci --cache ./work/npm-cache --no-audit --no-fund` (420 packages). No dependency or lockfile changes were introduced. The default-cache CLI request failed EACCES; sandboxed migration generation then failed EPERM writing `.supabase/telemetry.json.tmp`. Approved execution of the pinned CLI with the local cache generated the empty files, subsequently named 067/068 to follow repository ordering. No global security settings changed.

- A: focused regression, 12 files, 321/321 passed; after explicit register exclusion, publication + readiness tests 41/41; publication + Sarah list update 44/44. Later full-suite results supersede these counts.
- B: `npm.cmd test -- tests/unified-course-checkout-db.test.ts tests/academy-commerce-server.test.ts tests/unified-course-coupons-ui.test.ts tests/academy-readiness-contract.test.ts --maxWorkers=1`: 55/55 across 4 files, exit 0. Uses real migrations, real server/controller/webhook logic and a test Stripe adapter. Corrected the adapter to generate Stripe-compatible session IDs; production validation was retained.
- The initial full run: 4,910 passed, 4 failed, 42 skipped; 5 files failed (including hook failures), 214 passed, 7 skipped. Delivery and assessment-policy suites timed out under overlapping work. Static migration/anonymous-function expectations were updated for the new reviewed catalogue RPC. A six-file isolated rerun passed 250/251, including both previously timed-out suites; its remaining test-adapter recovery failure was corrected and is covered by B's passing run above. The final full rerun passed: `npm.cmd test -- --maxWorkers=2`, exit 0, 4,950 passed / 39 skipped (4,989 total), 222 files passed / 7 skipped (229 total), 937.83 seconds. No failed tests. Skips include environment-dependent acceptance/concurrency cases; they are not acceptance passes.
- `npm.cmd run lint`: exit 0. `npm.cmd run typecheck`: exit 0. `npm.cmd run build`: exit 0 with process-only `APP_URL=https://ducelio.invalid`; `.env.local` untouched.
- `npm.cmd run format:check`: final exit 0. Its initial run flagged four CRLF course JSON checkouts: `objective-breadth-audit.json`, `objective-coverage.json`, `package.json`, `sources.json` under `content/courses/security-plus-sy0-701/`. Normalised those four checkouts to the existing LF policy, verified equality of parsed JSON before/after, and confirmed no Git text diff. No course JSON values changed and no course file was deleted. Changed source/tests were formatted.
- `git diff --check`: exit 0.

The Supabase connector identified `ducelio-acceptance`, ref `blqaomssojfxaxskcyxd`. A read-only transaction confirmed ledger 66, latest `202610270066`, no unified publication/coupon tables, three historical Academy packages and one offer. Migrations 067/068 are **not applied**. This is schema discovery, not hosted acceptance. No hosted mutation or provider charge was performed. That was the initial baseline. A pinned portable PostgreSQL 18.4 toolchain is now installed only under ignored work/, listening on localhost:55484. Nine real publication/coupon/activation/membership/cancellation races have passed; the complete 13-file PostgreSQL gate is running. No local test result is hosted acceptance.

## Controlled acceptance clean slate

The default procedure is non-destructive: migration 067 creates empty active registers. Old AWS, Security+, test and draft packages do not enter them. Therefore an empty new catalogue does not require deleting protected history.

1. Independently confirm the project name and ref above, and that the app uses that same project. Keep production out of this procedure. Run [the read-only review SQL](../scripts/acceptance/unified-clean-slate-review.sql) and save its counts in the private operator evidence store.
2. Before any operator proposes deletion, take a complete custom-format PostgreSQL backup through the existing approved secure connection mechanism. Keep credentials out of argv, logs and Git; keep the dump outside the repository in restricted storage. Record timestamp, project ref, server/tool versions and SHA-256. `pg_restore --list` alone is not verification.
3. Restore that exact backup to an isolated disposable PostgreSQL instance, check restore exit status, schema/constraints, account/role counts, both commerce ledgers, payment/refund receipts, entitlements and audit history against the captured baseline. Record the backup hash and restore verification receipt. Check private assessment/support data only within that restricted environment. A failed or unperformed restore means **no verified backup** and blocks any deletion.
4. Review/apply the additive migrations through the normal approval process, then verify the ledger and effective ACLs. Do not execute the retired draft under `scripts/`. Before owner uploads, `list_unified_course_catalogue()` and `list_unified_course_packages()` must return empty lists. Perform authenticated and anonymous/JWT checks on the actual app deployment.
5. If new-engine acceptance test offers later need removal from sale, propose the exact offer IDs for review and archive them through the existing audited archive authority. Preserve packages, entitlements, learner records and commerce evidence. Recheck preserved counts (audit count can increase), ownership and public catalogue results.
6. Any physical purge is a separate proposal requiring the exact row/dependency manifest, verified backup/restore receipt and explicit owner approval. No delete/truncate/reset executor is included or authorised here. Local JSON and historical migrations remain intact.

No backup has been taken or verified in this session, and no destructive reset/delete has been executed. After the owner's explicit acceptance approval, labelled synthetic test offers are archived through the audited authority and their coupons deactivated; all evidence is retained.

## Release and rollback assessment

Do not deploy this as production-ready. Remaining release blockers are the final complete regression/build gates, hosted JWT/PostgREST/schema acceptance, live Stripe and AI provider journeys, browser/mobile/accessibility and operational/security review, backup/restore verification and CI/human review. C and organisation isolation now have actual PostgreSQL evidence, described below. Genuine AWS approvals remain with authorised human reviewers; none has been invented.

Deploy migrations before matching application code only in the approved acceptance environment, with checkout disabled until acceptance succeeds. Rollback should disable new sales and retain both additive migrations and all new evidence. An old application build may reject duration-null unified orders and would restore old catalogue UI, so a blind application rollback is unsafe: retain compatible checkout/webhook/reconciliation adapters or use maintenance mode while preparing a reviewed corrective release. Never drop coupon/order/entitlement/audit rows as a rollback. No production deploy, merge or production mutation is authorised.

## Final review record (2026-10-23 before owner review)

Draft [PR #84](https://github.com/NaimurRahmanR/ducelio/pull/84) targets `main` from the requested feature branch. A is commit `0288b35`; B is `f7f8f44`. The final verification/race-test record is a later commit on the same branch. The unrelated named acceptance stash remains intact and unpopped; `desktop.ini` is unrelated and unstaged.

Added `tests/unified-course-pg-concurrency.test.ts`: four actual multi-connection PostgreSQL scenarios, with observed lock contention before release, isolated database clones and verified-name cleanup. Targets outside localhost are refused. Cases cover publication replay, the last full-discount slot, same-learner paid-order replay, and the last paid-discount slot. The CI disposable-PostgreSQL job includes this file and now requires at least 43 executed passing cases with no skips. Local targeted execution correctly reports four skipped cases without `DUCELIO_TEST_POSTGRES_URL`; type checking passes. This is executable coverage, **not actual race acceptance evidence**.

GitHub Actions run `40005640692` failed before either job started (zero steps). The check annotation states: "The job was not started because recent account payments have failed or your spending limit needs to be increased." No green CI, PostgreSQL race evidence or independent approval is claimed. Restoring runner/billing availability and rerunning the required jobs is a release blocker. The workflow checks were extended, not bypassed.

Final local gates: lint exit 0, typecheck exit 0, build exit 0 (process-only HTTPS APP_URL override), format:check exit 0, diff whitespace check exit 0. Full test result above is the actual completed run. The concurrency test source and workflow were added while that run was underway; they were separately typechecked and run locally (four skips), and still require their CI execution. No new runtime code or migration followed the passing B verification snapshot.

NEXT EXACT ACTION: restore CI runner/billing availability, execute the new PostgreSQL races and require review; implement C's explicit Activate Course flow and server-owned 23h59m windows with governed recovery. Then finish D retirement and E tenant authority plus real isolation tests. Do not treat this draft as the completed replacement or approve production operation.

## Continuation: personal activation and activity windows (069)

Migration 069 keeps purchase separate from activation, reuses the existing five-duration planner and adds request-key conflict detection. My Learning exposes Activate Course for eligible purchases. All newly confirmed unified activities (classes, labs, revision and assessments) receive exact server-owned 1439-minute windows. Professor, Tutor, Lab Instructor, submissions, revision reads and examination admission enforce the window; examination attempts retain their independent duration and latest-start checks. Historical courses keep their previous policy.

A missed activity can receive one reviewed replacement window. Requests and decisions are immutable, authenticated, audited and ownership checked; approval cannot reset progress, submissions, grades or attempted examinations. The public API has no clock override. Revision content contains taught objectives and titles, not protected examination questions or keys.

Local evidence: eight migration-level activation tests passed; 61/61 targeted AI/teaching/UI/regression checks; 51/51 activation/support/readiness checks. Lint, typecheck and build passed. Four actual PostgreSQL publication/coupon contention tests passed (18.4, isolated localhost cluster, 26.98s, no skips). Hosted 067-069 remain unapplied and unapproved; local tests are not hosted acceptance. Organisation scope, academic resolution, abandoned reservations and full retirement remain outstanding. Main reconciled through merge 248851f without losing implementation or the unrelated stash.

## Continuation: shared organisation authority (070)

Organisation ownership belongs to each new-engine package, publication and coupon. External source keys are namespaced deterministically; two organisations can upload the same course source without sharing curriculum identity. Published material and enrolled history stay immutable. The Ducelio organisation is seeded, with no historical courses imported. Platform administration can provision an organisation for an existing verified account; owners manage verified-account memberships in Course Engineering. Members do not receive global role grants. Owners manage and review; course managers author/publish/manage commerce; academic reviewers grade and review recovery. A reviewer cannot author prices or coupons, and nobody can grade their own submission or review their own recovery.

The existing materialisation, configuration, test, publication, offer, coupon, marking and recovery RPCs now derive tenant authority from the referenced entity. Legacy listing endpoints exclude foreign tenant rows. Direct metadata reads require RLS; academic bodies, payments and support remain under their existing protected boundaries. Coupon code uniqueness is per selling organisation, including all-course coupons. Complimentary access to new courses uses the same coupon checkout, leaving duration unchosen.

Actual local PostgreSQL evidence: six cross-tenant tests exercise positive publication for two organisations and negative raw reads, publish/configure, coupon restriction/reporting, RLS reads/writes, membership escalation, revoked membership, institutional-versus-external authority, grading and recovery. Eight activation/AI-window/examination/recovery tests also passed on PostgreSQL. Seven real contention tests passed, including conflicting activation and last-owner protection. No hosted result or live Stripe/provider result is implied.

## Continuation: academic findings in the same interface (071)

The Course Engineering review now includes a validated JSON revision editor and per-decision human evidence references/rationale. Unselected decisions remain pending. Removing a decision requires management and academic review authority in the owning organisation, plus explicit human attestation in the UI. A deferred database constraint prevents a direct re-upload from silently dropping prior pending decisions. Requests are idempotent and reject changed replay payloads. Every resolution and revision request is immutable history; validation, lab rubric requirements and publication gates remain enforced. Published/enrolled curriculum is not edited.

Five academic review cases passed on actual PostgreSQL, including direct-upload bypass refusal, exact evidence requirements, partial approval remaining blocked, replay conflict, missing rubric refusal and publication after the synthetic fixture decisions are recorded. Combined UI/readiness run: 50/50 passed. AWS's genuine eight review requirements remain unresolved: this implementation enables an authorised human to record actual evidence and corrections rather than manufacturing approval or adopting the historical AWS package. A fresh owner upload is still required for the active system.

## Continuation: abandoned checkout and reservation recovery (072)

My Learning lists unfinished purchases with resume and verified cancellation. The production Stripe adapter uses [the expiry API](https://docs.stripe.com/api/checkout/sessions/expire), then re-reads the session. The server checks bound identity, Academy kind, amount, currency and expired/unpaid state before signing a purpose-separated cancellation claim. The DB rechecks learner ownership, immutable order terms, session identity, current state and payment evidence under order/learner/coupon locks. Uncertain, paid or unbound sessions cannot release capacity; an unbound checkout can be resumed to establish its session first. A provider outage leaves the reservation intact.

Cancellation creates immutable evidence and a terminal order state. Released redemption records remain visible as RELEASED; a subsequent checkout may reserve a fresh use under the same coupon's lock. Cancelled orders never create entitlements, including on a late signed payment. Such payment evidence remains available for reconciliation/refund. Nine genuine PostgreSQL contention cases passed, including replayed cancellation and cancellation versus fulfilment. Targeted commerce/readiness 53/53 and UI 18/18 passed. Production Stripe and AI credentials are absent locally, so these adapter tests are not live provider acceptance.

## Continuation: retirement and safe clean slate (073)

New duration-priced Academy orders and new cohort orders are refused; an already pending historical order can still be recovered and fulfilled. All cohort offer publication overloads and campaign creation/redemption are retired. Existing payment/refund, enrolment, grading, completion and audit records are not removed or rewritten. Historical public catalogues no longer sell legacy courses. The canonical catalogue and its Academy alias return only explicit unified publications. Administrative and learner entrypoints lead to the shared engine; historical programmes and financial reconciliation stay accessible separately.

Sarah's commercial projection uses those same public courses and the learner's own enrolment state, with no payment, assessment, grade or counselling data. A new fingerprint tag makes changed projection snapshots stale. Organisation-scoped order reporting shows only managed-tenant commercial facts and verified payment/refund flags. The upgrade test creates historical evidence before 073, applies the current migration, verifies an empty fresh catalogue, rejects new legacy purchases and overload bypasses, fulfils an existing historical payment and then publishes/purchases a new unified course. It passed on actual PostgreSQL.

Historical protocol creation suites explicitly test through 072; they continue to exercise their original security/replay invariants. Current cutover tests build those records before applying 073 and verify the retained-order and refusal paths afterward. Removed UI assertions for cohort launch controls are replaced with canonical-route and retirement checks; domain lifecycle/history tests remain. Complete latest-migration unified tests and real PostgreSQL gates are required alongside this historical coverage.

The full local test run currently has a readiness-contract failure observed before the retained endpoints' existing transport ACLs were made explicit. That correction passed the focused rerun (58/58). No full-suite green result is claimed yet. The hosted project was reconfirmed read-only at migration 066 on this continuation; no new schema, synthetic course, provider charge or reset has been applied there.

## Release verification log (continuation)

The first full continuation run: exit 1, 4,932 passed / 51 failed / 48 skipped, 8 files failed / 221 passed / 8 skipped (237 total), 1032.22s. The failures were stale route/access expectations, legacy reviewer-acquisition setup, bounded refusal text and the retained-read-ACL contract. Their eight-suite repair run passed 300/300 (50.01s), including the expanded real-identity page matrix with external membership. No negative permission check was removed. The complete final rerun remains required.

The complete local PostgreSQL run passed 84/84 in 13 files, no skips (399.74s); the repository JSON guard accepted it. A final payment audit then added one event-reuse test: a contradictory signed event cannot fulfil another order or bind its session. The success-page fallback now reuses the existing captured-payment/refund checker from a shared module and records a pre-fulfilment full refund without granting access. That hardening plus upgrade run passed 29/29. All 85 required PG cases must be rerun for the final source. Lint, typecheck and format:check pass; the latest build is running. No green CI, live provider acceptance or hosted migration result is claimed.

The final build passed with a process-only HTTPS APP_URL override; lint, typecheck and format:check passed. The clean full-suite rerun and final 85-case real-PostgreSQL rerun are in progress. Release approval remains open. The source is preserved as a draft feature checkpoint rather than represented as production-ready.

## Approved acceptance continuation and browser correction

The owner explicitly approved applying 067-073 and running labelled synthetic acceptance fixtures on **ducelio-acceptance**, ref **blqaomssojfxaxskcyxd**, with audited archival afterward. The project was reconfirmed ACTIVE_HEALTHY (PostgreSQL 17.6). The pinned CLI dry run listed exactly those seven migrations; its subsequent approved application exited 0. Post-application `acceptance:academy-readiness` passes **11/11** migration/RPC/ACL/search-path/RLS checks. No production deployment or production mutation occurred.

The direct connection initially refused `ACCEPTANCE_TLS_CA_REQUIRED`. The existing Supabase Root 2021 CA was verified against the repository's recorded SHA-256 fingerprint (80:70:25:AD…CA:FA), supplied with process-local `CP2F_CA_FILE`, and the existing helper retained `rejectUnauthorized: true` plus its authorised-TLS-socket assertion. No TLS/global security setting or `.env.local` value was changed.

The real ordinary-browser journey uses the repository's existing dependency-free Chrome CDP driver, real sign-in and ordinary app Server Actions against acceptance. No test HTTP route, service role, synthetic payment or signed academic result is used. Its first sign-in attempts failed because the local app process lacked network permission; restarting only that local process with approved network access fixed this without an authentication change. Chrome outer-window size did not ensure the intended viewport on Windows; the driver now sets CSS device metrics and asserts 390px. Temporary profile removal verifies its absolute parent/name and refuses symlinks.

Visual browser inspection found a real defect: React's successful-action form reset changed the displayed date/timezone after preview, and edits could leave an old preview confirmable. Both initial and revised timetable forms now preserve their controls, invalidate previews on changes and disable confirmation while a new preview is pending. The strengthened browser journey verifies the exact confirmed start date, time and timezone, plus refusal to confirm edited choices without a fresh preview. The Course Engineering review now describes the authoritative 23h59m window rather than the package's legacy sitting-window metadata.

The **eight browser surfaces pass**, exit 0: administrator sign-in; JSON upload/validation; price plus immutable agent-configuration revision/publication; coupon creation; mobile 100% purchase and Activate Course; preview/confirmation; zero browser runtime errors; audited fixture archival. Screenshots were inspected locally at an actual 390px viewport with no document overflow. Private evidence stays under ignored `work/unified-browser/`; it is not committed. Test offers are archived and coupons deactivated, while packages, enrolments, results and audit history remain.

The new synthetic constructor reuses only the existing generic acceptance constructor and reviewed agent settings. It reads no historical AWS or Security+ JSON. Its single lesson, lab, two revision activities and six one-minute objective assessments are explicitly TEST ONLY / demo content and award no external qualification. The separate real JWT/PostgREST journey waits for future scheduled timestamps (~30 minutes), without clock overrides, backdating or direct academic writes. Publication, protected-table/malformed-JWT refusal, concurrent coupon replay and all-duration/idempotent activation passed; classroom/assessment/timeout verification is currently running. A prior past-time attempt was correctly refused by the scheduler and corrected in the harness.

Hosted organisation provisioning is explicitly **BLOCKED/SKIPPED**: the existing acceptance academic admin is not a PLATFORM_ADMIN, and no separate `ACCEPTANCE_PLATFORM_ADMIN_EMAIL` / `ACCEPTANCE_PLATFORM_ADMIN_PASSWORD` is configured. No role was granted to pass a test. The six actual local PostgreSQL tenant-isolation cases remain valid evidence; they do not substitute for hosted organisation provisioning. Stripe test-mode, native AI and controller credentials are also absent. The owner requested continuation with the currently available credentials. No live Stripe/AI acceptance, genuine expired-JWT test, SMTP, verified backup/restore or comprehensive accessibility/device/security acceptance is claimed. Existing cohort-oriented acceptance commands are historical tools, not evidence for the replacement; provider verification must use the canonical unified checkout/classroom once acceptance credentials are configured.

Executed commands (the CA path and opt-in variables were process-local):

```powershell
node --env-file=.env.local scripts/acceptance/supabase-linked-cli.mjs --cli=./work/npm-cache/_npx/0e23c24576954b26 --workdir=. -- db push --linked --skip-vault --dry-run
# exit 0: exactly 067-073; no writes
node --env-file=.env.local scripts/acceptance/supabase-linked-cli.mjs --cli=./work/npm-cache/_npx/0e23c24576954b26 --workdir=. -- db push --linked --skip-vault --yes
# owner approved; exit 0, acceptance only
npm.cmd run acceptance:academy-readiness
# exit 0: 11/11 after application

$env:ACCEPTANCE_WRITE_ENABLED='true'
node --env-file=.env.local scripts/acceptance/unified-browser.mjs
# exit 0: eight browser surfaces, audited archive/deactivation
$env:DUCELIO_RUN_UNIFIED_HOSTED_ACCEPTANCE='true'
npm.cmd test -- tests/unified-course-hosted-acceptance.test.ts --maxWorkers=1 --reporter=verbose --reporter=json --outputFile.json=work/unified-hosted-acceptance-final.json
# real-time journey running; missing platform identity is an explicit skip
```

Do not persist the opt-in flags globally or run the hosted test without owner approval. It independently checks both the TLS-verified database marker and the authenticated Supabase environment marker, exact project hostname and pooler username before fixture operations. Its default test invocation skips all hosted mutations. Archival uses only offers from that run; no destructive cleanup exists. Accounts/cohorts and both payment/refund ledgers are snapshotted for preservation; audit history may grow.

The completed pre-browser full regression is **5,001 passed / 48 skipped / zero failures** (229 files passed / 8 skipped, 732.66s). The completed real PostgreSQL 18.4 gate is **85/85 in 13 required files, zero skips**, 323.47s; `assert-pg-concurrency-report.mjs` passed. The disposable localhost cluster has been stopped. Lint, typecheck, build (process-only HTTPS APP_URL), format and whitespace checks pass after the browser correction. The focused browser-fix regression passed **20/20 across four files**. A fresh full regression including the new harness files is running with:

```powershell
npm.cmd test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=work/unified-release-after-browser-tests.json
```

Checkpoint `e79343b` is pushed to the same draft PR #84. Main is reconciled; the named unrelated stash is untouched and `desktop.ini` stays unstaged. Latest inspected CI run **40029700680** again failed before both jobs started (zero steps): its actual annotation says recent account payments failed or the spending limit must be increased. The Ubuntu runner-image notice is separate from that failure. No green CI or human review is claimed. Release remains blocked pending the remaining actual acceptance and independent review; rollback must preserve all additive schema/evidence and compatible unified-order readers/controllers.

## Hosted examination failure diagnosis, fixed-amount coupons and release audit (2026-10-23 continuation)

**Hosted `start_my_academy_assessment` failure: actual cause.** The failing run reported only `start_my_academy_assessment: ` (an empty code) at about 21:57:01 UTC, one second after quiz_4 opened. A read-only, certificate-verified query of ducelio-acceptance showed that the learner's quiz_1, quiz_2, midterm and quiz_3 attempts had started, submitted and scored 10/10. quiz_4 has **no attempt row and no `ACADEMY_ASSESSMENT_STARTED` audit event**, so the request never committed, and no competing active attempt existed. With the repository's supabase-js 2.116 against local endpoints, an empty `code` occurs only when `fetch` throws (HTTP status 0, `TypeError: fetch failed`, e.g. a reset or refused socket). A PostgREST/SQL refusal carries its SQLSTATE or policy code, and a gateway 5xx without JSON prints `undefined`. The hosted gateway (Cloudflare) sends no `Keep-Alive: timeout` hint, so Node 24's undici discards idle sockets after its 4-second default. Each request after the journey's ~60-second waits therefore opens a fresh TCP/TLS connection; that setup failed once. The exact socket cause (DNS, reset or TLS) cannot be recovered: the old harness discarded it, and no Supabase management/API-log credential is configured. The cause was a client-side transport failure. It was not a database, RLS, scheduling or firewall defect.

**Correction (harness only; no server, RLS or authentication change).** `scripts/acceptance/hosted-rpc.mjs` reports bounded diagnostics: the RPC name plus an uppercase policy code, SQLSTATE, `HTTP_<status>` or `TRANSPORT_FAILURE(<cause code>)`. It never prints bodies, sessions or credentials. It retries a transport failure (no HTTP response at all) at most three times, with backoff and each retry logged, and only for RPCs that are idempotent on the server:

- `start_my_academy_assessment` resumes the same ACTIVE attempt;
- `record_my_academy_response` replays by its idempotency key;
- `submit_my_academy_attempt` returns the final attempt;
- the rest are reads.

Orders, coupons, schedule confirmation and publication, whose concurrency is under test, are never retried. Neither is any server refusal. `tests/acceptance-hosted-rpc.test.ts` covers all of these cases.

**Proof.** The owner-approved hosted journey was rerun with the corrected harness: **exit 0, 6 passed / 1 skipped, 1703.13s**.

- The previously failing classroom/lab/revision/examination case passed in 1696.1s on real scheduled timestamps (no clock override), including all six sittings and the PASSED/10000 bp/COMPLETED result.
- The one-minute independent timer expiry passed.
- afterAll archival plus order/payment/refund ledger preservation passed.
- `TRANSPORT_RETRIES 0`: the transient failure did not recur, so the retry path itself was **not** exercised on hosted.
- Organisation provisioning remains **BLOCKED/SKIPPED**: no PLATFORM_ADMIN acceptance identity exists.

Evidence is in `work/unified-hosted-acceptance-rerun.{log,json}` (ignored).

**Codex browser correction preserved.** The hydration guard in `signInThroughUi` was already committed (`e79343b`). The uncommitted regression test, which refuses to type or submit before React binds the form, is kept and passes.

**Fixed-amount coupons (migration 074, `202611040074_unified_fixed_amount_coupons.sql`).**

- Each coupon has exactly one discount kind, enforced by the `course_engine_coupons_one_discount` constraint: a percentage, or `amount_off_minor` bound to one currency (GBP/USD/EUR).
- New `create_organisation_course_amount_coupon` RPC (authenticated only; organisation MANAGE authority). The percent and fixed creators share a private `create_unified_coupon`. It validates terms and checks a course-restricted coupon's currency against the course's. Identical terms replay idempotently, null-safe comparisons now apply to both kinds, and any other terms return `COUPON_CONFLICT`. Its audit payload records only the chosen kind.
- `create_unified_course_order` applies a fixed amount only to a course priced in that currency (otherwise `COUPON_UNAVAILABLE`) and never goes below zero. A fixed amount covering the whole price grants access without payment, like a 100% coupon.
- New `COUPON_BELOW_MINIMUM_CHARGE` refusal for percent and fixed coupons alike: a partial discount leaving less than Stripe's minimum (GBP 30, USD 50, EUR 50 minor units) is refused before any reservation. This stops a coupon use being held by an order that can never be paid. Previously a 99% coupon could create such an order.
- Coupon terms remain immutable (`guard_unified_coupon`), and the deploy-time ACL assertions are extended.
- Admin UI: a discount-type selector; the fixed amount is entered in major units and converted exactly, without floats; a currency selector; the register shows "£25.00 off (GBP courses only)". The learner sees a specific message for the new refusal.
- Tests:
  - `tests/unified-fixed-amount-coupons-db.test.ts`: 7 cases on PGlite and real PostgreSQL, covering validation, authority, idempotency/conflict, immutability, audit, RLS, discounting, full cover, the minimum charge (including exactly-minimum), currency isolation and the redemption limit.
  - A new real multi-connection race for the last fixed-amount slot.
  - UI/server tests for mapping, strict union input and exact amount parsing.
  - An opt-in hosted case that probes for 074 first and skips as BLOCKED, publishing nothing, until 074 is applied. It uses only order-free outcomes, so the hosted ledger snapshot stays exact.

**074 is NOT applied to ducelio-acceptance.** It needs explicit owner approval, after which `acceptance:academy-readiness` and the hosted case should be rerun. Until then hosted readiness will correctly report 074 as missing.

**A latent PostgreSQL test-fixture bug, found and fixed.** In the first 14-file gate one case failed: `tests/academy-tutor-lab-pg-concurrency.test.ts`, "reply record and concurrent release insert". The table requires `expires_at = started_at + 30 seconds` exactly, but the fixture used two separate `clock_timestamp()` calls, which differ by microseconds under load. It now derives both columns from one timestamp. The product constraint is unchanged.

**Security audit.**

- A new permanent `tests/security-inventory-db.test.ts` asserts, over the whole migrated schema under Supabase defaults:
  - every application SECURITY DEFINER function pins `search_path`;
  - no private-schema function or schema is usable by anon/authenticated/service_role;
  - anon has no table privileges;
  - authenticated has no write privilege on any course/academy table, and only the organisation and membership registers are readable, through their `can_read_course_organisation` policies.
- Payment: the Stripe webhook verifies its signature (`constructEvent`). Fulfilment additionally requires the HMAC controller claim (300-second window) and checks amount, currency, session and event-reuse binding to the order; fixed-coupon orders use the same path.
- Secrets/AI: client components import no secrets or provider keys. Provider-key reads are server-only, and the admin agents page shows variable names only.
- Organisation isolation keeps its six real-PostgreSQL cases. Hosted organisation provisioning remains blocked as above.
- Not newly audited in depth this pass: AI prompt/context contents and the controlled-assessment firewall. These rely on the existing suites, and Professor/Tutor/Counsellor remain not live-provider-tested.

**Gates (this source).**

- Real PostgreSQL 18.4, CI list plus the new file (14 files): **93/93 passed, none skipped, 341.78s**, and `assert-pg-concurrency-report.mjs … 93` passed. CI's minimum is raised from 85 to 93.
- `npm run lint`, `npm run typecheck` (`next typegen && tsc`) and `npm run format:check`: exit 0.
- `npm run build`: exit 0 with process-only `APP_URL=https://ducelio.invalid`.
- Full regression: the first run was **5,030 passed / 1 failed / 57 skipped** (742.24s). The single failure was the pinned Sarah migration list, which now includes 074 (34/34). The clean rerun passed: **exit 0, 5,031 passed / 57 skipped / 0 failed; 234 files passed / 9 skipped; 666.76s**. The skips are the opt-in hosted and real-PostgreSQL suites, which ran separately above.

**Remaining production blockers (unchanged unless stated).**

- PR CI has not run green: earlier runs failed before starting, for billing/spending limits.
- 074 is not applied to acceptance.
- There is no PLATFORM_ADMIN acceptance identity, so hosted organisation provisioning is blocked.
- There is no Stripe test-mode, native AI or controller credential, so there are no live payment or AI journeys.
- Still outstanding: SMTP, verified backup/restore, rate limiting/abuse controls, privacy/support-data governance, comprehensive accessibility/device acceptance, deployment security review and independent human review.
- Genuine AWS academic review decisions remain unresolved.

**This branch is not production-ready.**
