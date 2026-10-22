# Implementation progress

This file is the high-level implementation status. Detailed checkpoint evidence lives in the checkpoint documents below.

CURRENT CHECKPOINT (PARTIAL): ACADEMY-RECOVERY-1, Academy course activation recovery on staging, branch `fix/academy-activation-recovery` from `main` `6704f08`. See [docs/58](58-academy-activation-recovery.md).

- LAST COMPLETED CHECKPOINT: RELIABILITY-1 (merged through PR #82, `6704f08`).
- COMPLETED ITEMS:
  - **Root cause.** `ducelio-staging` (Production deployment of `6704f08`) was proven to use `ducelio-acceptance` (`blqaomssojfxaxskcyxd`): a staging sign-in created that project's `auth.sessions` row. Migrations 060–065 had never been applied there, so every Academy RPC returned PostgREST `PGRST202`, which the application mapped to the generic `SERVICE_UNAVAILABLE`.
  - **Migration review.** 060–065 were reviewed and rehearsed in a rolled-back transaction on the hosted data.
  - **Migration deployment.** 060–065 were applied to `ducelio-acceptance` **only** (pinned CLI 2.120.0 through the linked wrapper, 2026-10-22 17:27Z, exit 0). The hosted ledger now matches all 65 repository versions, and no production project was touched.
  - **Hosted checks.**
    - `acceptance:academy-readiness`: 11/11 PASS.
    - `acceptance:hosted`: `MIGRATIONS`, `RLS_ACL` and `HOSTED_DATABASE` PASS, 0 FAIL.
    - PostgREST role probes: anon, learner and unrelated staff are refused on admin RPCs.
    - The staging admin page loads its Academy register and evaluation queue.
  - **Code.** The administrator-only `NOT_INSTALLED` message for missing database dependencies; learner paths are unchanged. Plus the read-only readiness guard `npm run acceptance:academy-readiness`, with contract tests and a mutation check.
- INCOMPLETE ITEMS:
  - Steps 4–5 are **BLOCKED**: AWS SAA-C03 upload, validation, curriculum pre-publication test, REVIEW_ONLY publication and learner activation. The genuine `Ducelio_AWS_SAA_C03_Academy_Commercial_Draft_v1.json` is not on this machine or in the owner's Google Drive. The pilot JSON in `Downloads` declares itself "Not an uploadable Academy package" and was not substituted.
  - REVIEW_ONLY publication also needs owner-approved per-format prices; the publish form requires that attestation.
  - Timed assessments open only at their scheduled sitting (Quiz 1 sits after Lesson 6), so a same-day hosted sitting is not reachable without altering server-owned schedule state.
  - Whether the AI Professor, Tutor and Lab can execute on staging depends on Vercel server variables (`ACADEMIC_EXECUTION_*` and a provider key), which could not be inspected from here.
- MIGRATIONS: none new. 060–065 are now applied to `ducelio-acceptance`; production is not touched. CONFIGURATION: none new.
- KNOWN FAILURES: none in the local gates. A pre-existing baseline item: `current_academic_activity_state` remains executable by `service_role` (the phase 1–2 grant left for review by migration 057); the readiness contract records it as a baseline.
- NEXT EXACT ACTION: obtain the genuine AWS package path and owner prices, then run steps 4–5 on staging through the real UI. Owner review and merge of the recovery PR.

PREVIOUS CHECKPOINT RECORD (RELIABILITY-1, merged through PR #82):

CURRENT CHECKPOINT (implemented locally on `claude/sleepy-brahmagupta-pt0g9d`; NOT reviewed, merged or deployed): RELIABILITY-1, shared AI execution reliability and the independent review of migration 063. See [docs/57 §12](57-academy-b2c-course-engineering.md#12-checkpoint-reliability-1-migrations-064-and-065-shared-ai-execution-reliability-and-independent-review).

- COMPLETED ITEMS: migration `202610260064_shared_execution_reliability.sql` (attested late-usage recording for executions whose FINALIZE arrives after expiry, exactly once and without reviving them; attested abandonment of AUTHORIZED executions that cannot START), used by the cohort and Academy Professor and Tutor/Lab runtimes through both controller transports; migration `202610260065_academy_ai_hardening.sql` (graded practicals refused for AI Lab help; deadlock-free reply-record lock order; profile lock on context reads; admission re-proven on reply records; reservation ceilings under a row lock; release-to-request schema binding).
- INCOMPLETE ITEMS: owner decision on AI assistance for graded practicals; Examiner-assisted lab grading (`LAB_RUBRICS` pending); the seven Security+ pending decisions; hosted acceptance with a real provider; authenticated browser journey; independent review of migrations 064–065.
- MIGRATIONS: 060–065. Not applied to any hosted project. CONFIGURATION: none new.
- KNOWN FAILURES: none in the local gates (see the final report). The previous late-usage production blocker is resolved by migration 064; remaining limitation: usage of a call whose controller dies before any FINALIZE cannot be recorded.
- NEXT EXACT ACTION: owner review of the branch; then, only if approved, a PR with CI.

PREVIOUS CHECKPOINT RECORD (ACADEMY-B2C-4, superseded by the above):

CURRENT CHECKPOINT (implemented locally on `claude/sleepy-brahmagupta-pt0g9d`; NOT reviewed, merged or deployed): ACADEMY-B2C-4, AI Tutor and AI Lab Instructor for individual Academy enrolments. See [docs/57 §11](57-academy-b2c-course-engineering.md#11-checkpoint-academy-b2c-4-migration-063-ai-tutor-and-lab-instructor).

- COMPLETED ITEMS: migration `202610250063_academy_tutor_lab.sql`; `academy_support_requests` as the cohort-free admission source (Tutor per released objective, Lab per started practical session); `tutor_lab_content_releases` generalised to one source per row, so migration 028's governance, execution table, usage ledger and audit are reused unchanged; Academy provenance from the frozen behaviour binding; single-use context reads in the cohort Tutor/Lab context shapes; idempotent reservations; attested reply records; lesson-page Tutor and timetable Lab entry points and the support page.
- INCOMPLETE ITEMS: Examiner-assisted lab grading (disabled: `LAB_RUBRICS` pending; no rubric invented); Tutor class notes for Academy requests; the seven Security+ pending decisions; hosted acceptance with a real provider; authenticated browser journey; independent review.
- MIGRATIONS: 060–063. Not applied to any hosted project. CONFIGURATION: none new.
- KNOWN FAILURES: none in the local gates (see the final report). PRODUCTION BLOCKER (shared, unchanged): a FINALIZE after the 20-second execution expiry records TIMEOUT without usage in migration 025 (Professor) and migration 028 (Tutor/Lab) governance alike.
- NEXT EXACT ACTION: owner review of the branch; then, only if approved, a PR with CI.

PREVIOUS CHECKPOINT RECORD (ACADEMY-B2C-3/3a, superseded by the above):

CURRENT CHECKPOINT (implemented locally on `claude/sleepy-brahmagupta-pt0g9d`; NOT reviewed, merged or deployed): ACADEMY-B2C-3, AI Professor classes for individual Academy enrolments. See [docs/57 §10](57-academy-b2c-course-engineering.md#10-checkpoint-academy-b2c-3-migration-062-ai-professor-classes).

- COMPLETED ITEMS: migration `202610240062_academy_ai_teaching.sql` (001–061 unchanged except two learner projections replaced with the same signatures); "Enter AI class" from the learner's own timetable, admitted by the database only for the learner's own ACTIVE unrevoked enrolment, a current-timetable LESSON whose start has passed and no active controlled assessment; the governed Academy Professor execution reusing migration 021 content releases, migration 025 provider governance and usage ledger, the stored agent configuration and frozen behaviour binding, the teaching-context builder and the provider runtime, with Academy-tagged attested provenance and memory; idempotent learner actions; resume across timetable revisions; class opened and Professor exchanges shown separately from study, grades and mastery; the Academy classroom page reusing the cohort classroom panel.
- INCOMPLETE ITEMS: Tutor and Lab Instructor for Academy enrolments (blocked: the Tutor/Lab runtime is admitted by DELIVERY_V1 handoffs bound to cohort `enrolments`/`delivery_handoffs`; needs its own reviewed Academy handoff and release authority); Examiner practical grading (disabled: `LAB_RUBRICS` pending, no rubric invented); the seven Security+ pending decisions; hosted acceptance with a real provider; authenticated browser journey; independent review.
- MIGRATIONS: 060, 061 and 062. Not applied to any hosted project. CONFIGURATION: none new (reuses `ACADEMIC_EXECUTION_KEY_ID`/`ACADEMIC_EXECUTION_HMAC_KEY_HEX` and the existing Professor runtime profile).
- AUDIT CORRECTIONS (ACADEMY-B2C-3a, [docs/57 §10.1](57-academy-b2c-course-engineering.md#101-audit-corrections-academy-b2c-3a)): classroom times render in the learner's timetable timezone (DST-safe); an execution refused after AUTHORIZE is terminalised; admission is re-proven after the provider call; inner release failures abort enclosing releases; two-way cohort/Academy provenance exclusion; bounded reservations; exam firewall on the agent read. Remaining limitation shared with the cohort path: a FINALIZE after the 20-second execution expiry records TIMEOUT without usage (migration 025).
- KNOWN FAILURES: none in the local gates (see the final report).
- NEXT EXACT ACTION: owner review of the branch; then, only if approved, a PR with CI.

PREVIOUS CHECKPOINT RECORD (ACADEMY-B2C-2, superseded by the above):

CURRENT CHECKPOINT (implemented locally on `claude/sleepy-brahmagupta-pt0g9d`; NOT reviewed, merged or deployed): ACADEMY-B2C-2, Academy academic controls, policy gate, checkout, evidence and mastery. See [docs/57 §9](57-academy-b2c-course-engineering.md#9-checkpoint-academy-b2c-2-migration-061).

- COMPLETED ITEMS: migration `202610230061_academy_controls_commerce_evidence.sql` (001–060 unchanged); one controlled assessment at a time across the Academy and institutional exam systems through the existing learner-profile lock and activity firewall; lesson release from the learner's own schedule and closed during any controlled sitting; `pendingDecisions` policy gate (review-only offers, no unapproved sale or official completion); Security+ Academy artefact revision 2 with the published 20% lab weight and rubrics declared pending; Academy checkout on the existing Stripe/webhook/controller-key integration with purchased-format persistence, refund revocation and expired-session replacement; MASTERY_V1 evidence from scored sittings and lab marks; learner-confirmed study progress.
- INCOMPLETE ITEMS (at the time): AI Professor/Tutor/Lab Instructor/Examiner for Academy enrolments (blocked: cohort `enrolments`/`class_sessions` foreign keys across the AI execution authorities; needs a reviewed enrolment abstraction); owner decisions on the seven Security+ pending items; admin entitlement list and revocation UI; hosted acceptance; live Stripe test-mode acceptance of the Academy branch; authenticated browser journey; independent review.
- MIGRATIONS: 060 and 061. Not applied to any hosted project. CONFIGURATION: none new (reuses the existing Stripe and commerce controller settings).
- KNOWN FAILURES: none in the local gates (see the final report).
- NEXT EXACT ACTION: owner review of the branch and of the pending academic decisions; then, only if approved, a PR with CI.

PREVIOUS CHECKPOINT RECORD (ACADEMY-B2C-1, superseded by the above):

CURRENT CHECKPOINT (implemented locally on `claude/sleepy-brahmagupta-pt0g9d` from `main` `9ee85f2`; NOT reviewed, merged or deployed): ACADEMY-B2C-1, the new Academy (direct-to-learner) Course Engineering workflow and individual, cohort-free delivery. See [docs/57](57-academy-b2c-course-engineering.md).

- COMPLETED ITEMS: `ACADEMY_COURSE_PACKAGE_V1` contract and validator (embeds an unchanged `COURSE_PACKAGE_V1`); five stable formats (2/4/6/8/12 weeks) with feasibility proven per package; deterministic planner in SQL (authority) mirrored in TypeScript with a 90-case parity test; migration `202610220060_academy_course_engineering.sql` (001–059 unchanged) with learner-scoped entitlement, enrolment, timetable revisions, server-owned sittings reusing migration 059's validators and scorer, lab submissions and human rubric marking, results and completion; `/admin/academy-course-engineering` (upload → validate → review → publish through the existing curriculum pipeline and pre-publication test, explicit per-format prices, authorised access, lab evaluation); `/student/academy` (format, start date, weekdays, time and timezone with preview, timetable, lessons, practicals, sittings via the existing exam workspace, results, revision of future dates); Academy section on `/courses` and `/academy/<slug>`; Security+ Academy conversion artefact `academy-b2c-rev1.json` with a reproducible builder.
- INCOMPLETE ITEMS: Stripe checkout for Academy formats (only authorised/complimentary entitlement exists); AI teaching/Examiner/Counsellor execution for Academy enrolments; Examiner-assisted lab grading; missed-sitting policy; mastery/progress records for Academy enrolments; authenticated browser journey (needs Supabase Auth/PostgREST); hosted acceptance; independent review; owner approval of the Security+ delivery proposals (workload, placement, pass mark, formats).
- MIGRATIONS: 060 only. Not applied to any hosted project.
- CONFIGURATION: none new.
- KNOWN FAILURES: none. `npm run check` 4,792/4,792 (207 files, real-PostgreSQL suites included), build and format check pass; six migration-integrity tests need full git history (`git fetch --unshallow`) in shallow clones.
- NEXT EXACT ACTION: owner review of the branch diff and the Security+ delivery proposals; then, only if approved, a PR with CI (including the dedicated real-PostgreSQL job).

PREVIOUS CHECKPOINT RECORD (CP2, unchanged below):

CURRENT CHECKPOINT (implemented locally, awaiting independent review; NOT committed, pushed or deployed): CP2 interactive examination engine, on branch `feat/cp2-interactive-exam-engine` from `main` `dd5e27a` (which includes the merged CP1 dependency-security fix, PR #72; post-merge main CI green). See [docs/53](53-cp2-interactive-examination-engine.md).

- COMPLETED ITEMS: migration `202610160059_interactive_examination_engine.sql` (001–058 unchanged); five deterministically scored objective types (single select, multiple select, PBQ matching, PBQ ordering, PBQ configuration) alongside unchanged free text; additive `COURSE_PACKAGE_V1` question extension validated in TypeScript and SQL; protected definition/key storage with no role privileges; gated learner release; response validation in both writers; one grading chain with a table guard binding all five mark writers; Examiner provider context excludes objective questions; human review locked to deterministic marks; learner exam workspace; staff authoring editor; new tests (domain, PGlite + real orchestrator, UI/actions).
- CP2B ITEMS: real-PostgreSQL concurrency suite (8 scenarios) passing locally on a disposable PostgreSQL 16.14 server together with the existing 5 (13/13, three consecutive runs); one PostgreSQL-only defect fixed in migration 059 (deferred key-presence trigger now SECURITY DEFINER); dedicated `postgres-concurrency` CI job added with false-green protection (not yet run in GitHub Actions); real-Chrome component harness verification 42/42 (not an authenticated end-to-end journey).
- CP2C ITEMS: the collision-prone 32-bit browser save checksum was replaced by a server-derived SHA-256 key over the exact body; regressions at unit, action, PGlite and real-PostgreSQL levels; database idempotency rule and migration 059 unchanged.
- CP2D ITEMS (reconciliation with `main` `79c16a2`, local and uncommitted): the merge of `main` into PR #73's head `6394982` is resolved as recorded in [docs/54](54-cp2-deployment-bridge.md#reconciliation-with-cp2-local-uncommitted). CP2 supersedes the bridge's compatibility layer, including the three silently merged Examiner context readers. The learner pagination is kept, and the page-independent active-assessment defect is fixed with a regression test. The bridge-only test and its duplicate copy of migration 059 are retired after the canonical migration was verified byte-identical. Local gates with `OPENAI_API_KEY` unset: typecheck, lint, format check and build exit 0; full suite 4,366 passed and 14 skipped (the PostgreSQL-URL suites).
- CP2F ITEMS (hosted-acceptance tooling on `5dd0358`): the read-only migration 059 pre/post verifier and its contract, the pinned linked Supabase CLI wrapper and the 11-surface `exam-engine.mjs` harness are carried onto the reconciled head, with their tests. See [docs/56](56-cp2f-hosted-acceptance-readiness.md), renumbered from docs/55 to avoid `docs/55-certification-blueprint-academic-gate.md`. A new test proves the harness's app server runs from its own checkout. Hosted (read-only, 2026-10-19): migration 059 is applied on `ducelio-acceptance` (ledger 001–059, no catalogue drift); post-phase 26/28, where both failures are data written by earlier acceptance runs, not drift. Containment of those runs is outstanding.
- INCOMPLETE ITEMS: independent review; hosted acceptance (A2) of `5dd0358` and containment (A4) of earlier and new runs; backup/PITR confirmation; an authenticated end-to-end browser journey (needs Supabase Auth/PostgREST); axe/device audit.
- KNOWN FAILURES: none in the local gates at the time of writing (see the checkpoint report for exact results).
- NEXT EXACT ACTION: independent review of the local CP2 diff; then, only if approved, commit, push, open a PR and require green CI. The final Security+ course package must not be generated without the exact separate approval.

PREVIOUS CHECKPOINT RECORDS (historical, unchanged):

LAST COMPLETED CHECKPOINT: LR-BASELINE-01, merged through PRs #66–#70 (final `main` `0e21fdf0cb450f3a12e928c0c0cf49eab638ce9b`). Migration 057 is deployed to `ducelio-acceptance` (22/22 post-deployment checks; ledger 57). The independently verified FULL_CUSTOMER_JOURNEY run `1791863337177-6fr8jg` passed 10/0 (reviewer-entitlement access). See [docs/51](51-lr-baseline-01-hosted-baseline-and-ui-audit.md).

CURRENT CHECKPOINT (implemented, hosted acceptance passed, awaiting independent review and merge): LR-03 + UX-02, paid customer journey and commercial website readiness, on branch `lr03/paid-journey-ux02` (draft PR #71) from `0e21fdf`. Code head `3ec5c7ec3a70c3a307ea2015f8f62da0747dd53b`, with GitHub CI green; this record is updated by a later docs-only commit. **Not production-ready.** See [docs/52](52-lr03-paid-journey-and-commercial-ux.md).

- COMPLETED ITEMS:
  - payment-safety source review;
  - a HIGH defect fixed (a learner could never pay again after an abandoned checkout expired), through migration `202610130058_commercial_v1_expired_checkout_replacement.sql` (attested, provenance-recorded replacement of an expired, unpaid session; 001–057 unchanged), with regression tests and mutation checks (docs/52 §3);
  - independent-review corrections: binding-first idempotency and a real-PostgreSQL concurrency suite (docs/52 §3a);
  - historical deployment-preparation correction: the reviewed 058 at `9b16f82` would have dropped migration 039's `campaign_redemption_id` immutability from `guard_order`. It was corrected before any deployment, with regression tests, committed as `4116885` and pushed (docs/52 §3b–3c);
  - real-browser UX-02 audit in installed Chrome at three viewports, with five confirmed defects fixed: skip-link focus, checkout landmarks, footer contrast, target size, and the signed-out Stripe return keeping its order through login. After the fixes, 0 axe violations across 54 page audits (docs/52 §4);
  - migration 058 (SHA-256 `8da442c8…7a20`) deployed to the dedicated Supabase acceptance project `ducelio-acceptance` **only**; hosted migration ledger 58/58;
  - hosted Stripe TEST-mode paid acceptance: `acceptance:stripe` 7/7 PASS (operator-run; docs/52 §5b);
  - hosted expired-checkout recovery, 14 October 2026: **73/73 PASS, exit 0** (docs/52 §5a):
    - the existing PENDING order `fee16194-0c99-4d6b-bf74-de6f98404764` was safely rebound from an expired, unpaid Stripe test session to a new open, unpaid session for the same order;
    - exactly one provenance record and one audit event were written, and the order's financial identity was unchanged;
    - the idempotent retry reused the new session and wrote nothing;
    - foreign-learner access and impersonation were denied;
    - the three previously fulfilled orders were unaffected;
    - no payment, entitlement or enrolment resulted;
    - evidence file `lr03-recovery-20261014-004229.json` is retained locally outside the repository;
  - local verification: full suite 4,277 passed after `3ec5c7e`; real-PostgreSQL concurrency suite 5/5 passed (local, isolated); GitHub CI green on `3ec5c7e`.
- INCOMPLETE ITEMS:
  - independent review of PR #71 and the merge decision;
  - public Stripe network webhook delivery (needs a deployed staging endpoint; webhook evidence so far is locally signed);
  - live payment acceptance (only Stripe TEST mode has run);
  - real refund verification: no real Stripe test-mode refund harness exists (gap); `acceptance:commerce-revocation` still needs approval;
  - hosted concurrency (local PostgreSQL evidence only);
  - production deployment of migration 058 and the application, through a reviewed, credential-safe procedure;
  - real iOS/Android device and screen-reader QA;
  - LR-09 support channel and favicon asset.
- KNOWN FAILURES / LIMITATIONS:
  - historical audit evidence records the same two pre-existing high advisories as `main` (`sharp`, `source-map-js`), tracked under LR-06;
  - no production-readiness claim is made: network webhook delivery, live payments, real refunds and production deployment remain unverified.
- NEXT EXACT ACTION: independent review of PR #71 at its docs-reconciled head, then the operator's merge decision. Do not merge before that review.

PREVIOUS CHECKPOINT RECORD: AC-6, Sarah post-session feedback and the admin teaching-quality surface (migration 055), independently reviewed and merged through PR #60 (merge `b33da08b3ce4bd9e918230bf7940c5f1bfb58889` on `main`). See [AC-6 design and evidence](48-agent-behaviour-ac6-sarah-feedback.md).

AC-7 RECORD (as written before its merge): AC-7, Sarah course guidance with a hard learner-support / commercial data firewall, on `feat/ac7-sarah-course-guidance` from base `b33da08b3ce4bd9e918230bf7940c5f1bfb58889`. Migration `202610070056_sarah_course_guidance.sql` (001–055 unchanged). **Implemented and locally validated, independently reviewed and approved for commit/PR; still uncommitted and unmerged at this point. Migration 056 is not deployed, and neither are 054 and 055. No hosted or live-provider AC-7 evidence exists. Not production-ready.** See [AC-7 design and evidence](49-agent-behaviour-ac7-sarah-course-guidance.md).

AC-7 is the **final** checkpoint of the AC-1 → AC-7 Agent / Model control and Governed Academic Agent Behaviour workstream. Once it is merged, the workstream is **implemented** (locally validated, reviewed and merged). That is **not** a claim that the platform is production-proven: the hosted, live-provider, concurrency, browser/accessibility and retention items of every checkpoint remain outstanding (see INCOMPLETE ITEMS below and each checkpoint record).

COMPLETED ITEMS (AC-7, local):

- Architecture:
  - one new intent, `COURSE_GUIDANCE` (provider capability `sarah_course_guidance`, behaviour `SARAH_COMMERCIAL_BEHAVIOUR_V1`), on the unchanged platform `COUNSELLOR` / `COUNSELLOR_PLATFORM_V1` / `SARAH_EXECUTION_V1` plane;
  - provider, model, reasoning, one attempt, 500 tokens, 10,000 µUSD, deadline and lease are unchanged;
  - `GUIDE` / `SUPPORT_PROFILE` are unchanged (`SARAH_BEHAVIOUR_V1` still forbids selling);
  - a physically separate code path (`src/domain/sarah-course-guidance.ts`, `src/server/sarah/course-guidance.ts`, its own Server Action and component). `COURSE_GUIDANCE` is not an AC-5 `SarahIntent`.
- Mode boundary: PROSPECT and POST_COURSE only. ACTIVE_COURSE is refused at the page, reservation, context, AUTHORIZE, START and table CHECK, before any provider work.
- Capabilities:
  - executable (`SARAH_AC7_EXECUTABLE_CAPABILITIES`): PROSPECT `read_public_course_catalogue`, `explain_duration_pricing_format`, `help_choose_course`; POST_COURSE `read_owned_completion_summary`, `explain_next_course_options`, `explain_reenrolment_and_pricing`; ACTIVE_COURSE none;
  - non-executable: `explain_course_prerequisites` ("No authoritative prerequisite field is currently published."), `capture_optional_prospect_preferences` (no approved persistent model; preferences stay ephemeral), `coordinate_progression` (navigation only).
- Firewall:
  - `get_my_sarah_commercial_context()` (self-scoped, STUDENT only, no argument) reads only published offers (≤ 20 plus a truncation flag) with the learner's own `viewerStatus` and `newPurchaseAvailable`, and in POST_COURSE ≤ 5 completed course identities with `completedOn`;
  - `newPurchaseAvailable` mirrors `create_commercial_v1_order` eligibility, and conservatively requires an OPEN, not-full cohort;
  - no support, proposal, counsellor, AC-6 feedback, assessment/lab result rows or result-detail data, score, pass-mark, mark, outcome, mastery, remediation, order, payment or campaign data (static test of every 056 body plus behavioural twins). The only completion-receipt field consumed is `completed_at` (structurally tested).
- Fingerprint:
  - `SARAH_COMMERCIAL_CONTEXT_V1` over the exact deterministic projection, with no actor identity;
  - `source_commercial_sha256` on the execution, with an explicit cross-field CHECK (support intents: profile version only; course guidance: commercial version only, PROSPECT/POST_COURSE, commercial behaviour);
  - historical rows stay valid.
- Lifecycle:
  - the new attested `govern_sarah_course_guidance` (`DUCELIO_SARAH_COURSE_GUIDANCE_HMAC_SHA256_V1`, the existing trust root);
  - AUTHORIZE and START re-check mode and commercial fingerprint, and a stale START is `FAILED`/`POLICY_BLOCKED` with no provider call;
  - **post-provider re-check (review correction 1):** before any successful FINALIZE or learner output, the context is re-read (even with zero recommendations) and must match the START-admitted mode and fingerprint. Otherwise all provider prose is suppressed and the execution is `FAILED`/`POLICY_BLOCKED` with real usage (`INTERNAL_ERROR` if the re-read fails), with no second provider call and no lock across the network call;
  - the shared Sarah admission and budget envelope;
  - the 054 `govern_sarah_execution` is not replaced;
  - reservation material `SARAH_AC7_COURSE_GUIDANCE_V1`, with AC-5's unchanged.
- Output: strict `{reply, recommendations[≤3]{slug, reason}}`, with unique slugs, each an exact `newPurchaseAvailable` slug of the authorised context. Everything else is `OUTPUT_INVALID`, with no repair.
- Cards: built by slug from the verified post-provider projection, never from model text. `formatOfferPrice` is shared with the public course pages.
- UI: "Find a course" on `/student/sarah` (PROSPECT/POST_COURSE only), with firewall and no-pressure copy, ≤ 3 cards linking to `/courses/<slug>`, and no buy, order or reserve control.
- No commercial mutation, and no persistence of message, reply, reasons, recommendations or preferences.
- Audit: intent-aware wording with the 054 source classifier unchanged; no fingerprint or content.
- ACL: eight `authenticated`-only RPCs, closed private helpers, column privileges revoked, migration-time self-verification.
- Truth-sync:
  - `PLATFORM_ROLE_FACTS.COUNSELLOR`, the COUNSELLOR evidence scope (AC-5 + AC-7 deterministic; HOSTED NONE with 054/056 undeployed), `/admin/agents` copy;
  - docs 43 (AC-6 merged, AC-7 status), 47 (status and section 21), 48 (merged status and the firewall), and the new 49.
- Tests:
  - new: `sarah-course-guidance-db` 38, `sarah-course-guidance` 27, `sarah-course-guidance-ui` 9;
  - updated: `sarah` (capability truth, migration list), `sarah-db` (eight RPCs, a retitled 054 intent test; the other 42 unchanged and passing), `sarah-ui` (action mock).

AC-7 local gates (Node 24.19.0, Windows):

- Focused suites (AC-7 plus `sarah-db`, `sarah`, `sarah-ui`): 6 files, 166/166 (AC-7 74, AC-5 `sarah-db` 43).
- `npm run check`, exactly as defined, after the review corrections: lint and type check passed; **4,196/4,196 across 171 files, exit 0** (4,190 before the corrections).
- `npm run build`:
  - with `.env.local` as-is: exit 1 at the known `/admin` prerender "Configured production authentication requires an HTTPS APP_URL";
  - with the process-level `APP_URL=https://ducelio.invalid` override (`.env.local` untouched): exit 0. `/student/sarah`, `/courses` and `/courses/[slug]` compile as dynamic routes.
- `npm run format:check`: only the six unchanged pre-existing files (`.github/workflows/ci.yml`, `package.json`, four `content/courses/security-plus-sy0-701/*.json`). Not touched.
- `git diff --check HEAD`: clean. Untracked files have no CR or trailing whitespace.
- `npm audit --omit=dev`: the same 2 pre-existing highs (`sharp`, `source-map-js`). `package.json` and the lockfile are unchanged; `npm audit fix` was not run.
- Mutation checks (temporary edits, each restored byte-identically and verified by SHA-256), re-run in full after the review corrections: **29 safeguards, all killed**.
  - Firewall and mode:
    - ACTIVE_COURSE denial in the context RPC, the reservation gate, the AUTHORIZE policy mode check and the page mode gate;
    - the support-context firewall (the projection reading `student_support_profiles`) and the feedback firewall (the projection reading `session_teaching_feedback`);
    - actor identity in the fingerprint;
    - the TS firewall (the course-guidance path calling `get_my_sarah_context`).
  - Stale state:
    - the stale commercial fingerprint at START and at AUTHORIZE;
    - **post-provider (review correction 1):** fingerprint comparison bypassed, re-check result ignored entirely, re-check skipped when there are zero recommendations, drift recorded with zero usage, a mode change exposed as a plain retry, and a re-read failure treated as success.
  - Output and catalogue:
    - unknown slug accepted, duplicate slugs accepted, max 3 → 4, recommendable ignoring availability;
    - no commercial mutation (an order created after success);
    - `newPurchaseAvailable` ignoring viewer status, and ignoring the closed/full cohort;
    - catalogue bound 20 → 21; a completion summary leaking the score.
  - Regression and audit:
    - old-intent regression (GUIDE routed to commercial instructions; the shape CHECK allowing GUIDE with a commercial version);
    - the course-guidance audit wording;
    - the commercial version made mutable in the guard trigger. This one first **survived** in the original pass, because that test's update was also an invalid transition. The test now makes an otherwise valid AUTHORIZED → RUNNING transition with a control update, and the mutation is killed.
  - Retired: the earlier "cards from the authorised instead of the current context" mutation is now an **equivalent mutant**. Cards are built only when the post-provider fingerprint equals the START-admitted one, so both contexts are identical. The new post-provider mutations cover the guarantee instead.

INCOMPLETE ITEMS (AC-7, and the workstream's outstanding acceptance):

- Independent review: **done, approved for commit/PR**. Commit, push, PR with green CI and merge are still to do (no stage, commit or push has been made).
- Hosted:
  - deploy 054, 055 and then 056, verify the ledger, and run the ACL/RLS smoke (four Sarah tables, eight RPCs);
  - the true-PostgreSQL races in [AC-7 section 12](49-agent-behaviour-ac7-sarah-course-guidance.md): catalogue change racing START, enrolment racing START, same-key and double AUTHORIZE, and cross-intent admission.
- JWT/PostgREST (still BLOCKED independently), and browser/accessibility acceptance of `/student/sarah` including "Find a course".
- Live-provider behavioural evaluation of `SARAH_COMMERCIAL_BEHAVIOUR_V1`: grounding quality, contract compliance, adversarial refusals and no pressure. LIVE_PROVIDER evidence for `COUNSELLOR_PLATFORM_V1` remains NONE.
- **Production items:**
  - retention and purge policy for Sarah execution, usage and reservation metadata (AC-5/AC-7);
  - AC-6 feedback retention and window policy;
  - live-model commercial grounding quality;
  - catalogue breadth (with one or few published courses, guidance is thin; more than 20 are truncated);
  - an authoritative prerequisite field (none exists; the capability stays non-executable);
  - review of the shared 5-per-minute / 30-per-hour admission envelope at production scale.
- All earlier checkpoint hosted and production items listed in their records below remain open.

KNOWN FAILURES (AC-7): no AC-7 functional failure locally. Pre-existing environment items are recorded with the gates.

NEXT EXACT ACTION: stage the independently reviewed AC-7 file set, verify the staged diff, commit, push, open the PR and require green CI. Do not deploy 054/055/056 or start Operations Engineer work without instruction.

### AC-6 record (merged through PR #60)

COMPLETED ITEMS (AC-6, local):

- Architecture: Sarah Mitchell is the learner-facing persona. The feedback is deterministic, structured institutional data with **no model, provider, `COUNSELLOR_PLATFORM_V1` or AC-5 execution call**. The AC-5 runtime, behaviour instructions and profile fingerprint are unchanged.
- Eligibility, owned by `submit_my_session_feedback`: the caller is an authenticated STUDENT, and the session is an existing `class_sessions` row with all of the following:
  - the caller's own ACTIVE, PAUSED or COMPLETED enrolment is in its cohort and programme version;
  - it is not CANCELLED;
  - `scheduled_end <= clock_timestamp()`;
  - the caller's attendance for it is exactly PRESENT.

  A session still SCHEDULED after its end is eligible. The browser supplies only the session handle, a request UUID and three ratings.

- Fields: `clarity_rating`, `pace_rating` and `usefulness_rating` (integers 1–5, higher is better), plus id, session, learner (database-derived), request id, policy version and `submitted_at`. There is no free text.
- Persistence and idempotency:
  - `unique(student_id, class_session_id)` and `unique(student_id, request_id)`;
  - an immutable row (UPDATE and DELETE refused, even for the owner) and an eligibility backstop on insert;
  - same UUID and same submission gives `REPLAYED`; a changed submission gives `REQUEST_CONFLICT`; a new UUID gives `ALREADY_SUBMITTED`.
- Learner UI:
  - `/student/sarah` always shows the "How did that session go?" card;
  - `/student/classes` shows it with the Sarah identity when a session is listed;
  - three required 1–5 radio groups and no text field;
  - truthful outcome copy;
  - server-generated request UUIDs and a fixed UTC time format, so hydration is stable;
  - a bounded opportunity list (10 most recent eligible, unrated sessions).
- Admin teaching quality (`/admin?section=Sessions`):
  - ACADEMIC_ADMIN and PLATFORM_ADMIN only, checked by explicit role, not `is_academic_admin()`, which admits REGISTRAR;
  - filters for instructor, cohort and date window, 50 per page;
  - per-session present count, response count and three averages;
  - averages only from 3 responses ("Insufficient responses for scores" below that);
  - the summary averages only threshold-meeting sessions, so no differencing;
  - cancelled sessions excluded; no learner identity, individual rating or submission time.
- Audit: one `SESSION_FEEDBACK_SUBMITTED` row with a **NULL actor** and `{feedback_id, class_session_id, action, submitted_at}` only. No ratings and no learner.
- ACL: RLS on, with every table and column privilege revoked, including `service_role`. The private schema is closed. Three `authenticated`-only RPCs, and migration-time effective-privilege self-verification.
- Concurrency: learner `student_profiles` FOR UPDATE, then enrolment FOR SHARE, then session FOR SHARE, then attendance FOR SHARE. The unique index is the final backstop.
- Truth-sync:
  - `PLATFORM_ROLE_FACTS.COUNSELLOR` and `/admin/agents`: AC-6 is deterministic and not on the Sarah plane;
  - comments in `sarah.ts` and `platform-ai-policy.ts`;
  - docs 43 (stale AC-1 and AC-5 status corrected, AC-6 status), 47 (merged status) and the new 48.
- Tests:
  - new: `session-feedback-db` 27 (real migration chain), `session-feedback` 19 (domain, server, Server Action, no provider), `session-feedback-ui` 13;
  - updated: `sarah` (054 is now followed only by 055) and `sarah-ui` (the feedback server is mocked, and "no feedback" now applies outside the deterministic card; the forbidden-claims list is unchanged).
- Mutation checks (temporary edits, each restored byte-identically and verified by SHA-256): **19 safeguards, all killed**.
  - Killed on the first run (17), each by the DB suite unless noted:
    - RPC: the PRESENT check, the ended check, the cancelled check, the withdrawn-enrolment check, the STUDENT role check, the learner `FOR UPDATE` lock, and replay rating comparison;
    - guard: UPDATE immutability;
    - admin: explicit roles replaced by `is_academic_admin()`, row threshold 3→2 (2 failures), summary over all sessions, and cancelled exclusion;
    - audit: the NULL actor;
    - opportunities: the PRESENT filter and the bound 10→20;
    - TypeScript (server suite, 2 failures each): the row privacy refine and the strict submission schema.
  - Killed after a test fix (1): the `ALREADY_SUBMITTED` pre-check first **survived**, because the unique-index backstop returns the same code. A test now pins that a session cancelled after rating still answers `ALREADY_SUBMITTED` (and `REPLAYED` for the original key), and the re-run mutation is killed.
  - Killed (1): a smuggled dynamic runtime-profile call in submission, caught by the no-provider spy.

AC-6 local gates (Node 24.19.0, Windows):

- Focused AC-6 suites: 3 files, 59/59 (plus `sarah` and `sarah-ui` updated and passing).
- `npm run check`, exactly as defined: lint and type check passed; **4,122/4,122 across 168 files, exit 0**. The first run stopped at type check on a test-helper parameter type (`submit(null, …)`); that was fixed before this run.
- `npm run build`:
  - with `.env.local` as-is: exit 1 at the known `/admin` prerender "Configured production authentication requires an HTTPS APP_URL";
  - with the process-level `APP_URL=https://ducelio.invalid` override (`.env.local` untouched): exit 0. `/admin`, `/student/[section]` and `/student/sarah` compile as dynamic routes.
- `npm run format:check`: only the six unchanged CRLF-checkout files.
- `git diff --check HEAD`: clean. Untracked files have no CR or trailing whitespace.
- `npm audit --omit=dev`: the same 2 pre-existing highs (`sharp`, `source-map-js`). `package.json` and the lockfile are unchanged; `npm audit fix` was not run.

INCOMPLETE ITEMS (AC-6):

- Independent review of the uncommitted patch, then commit, PR CI and merge (not done; no commit, stage or push was made).
- Hosted: deploy 054 then 055, verify the ledger, run the ACL/RLS smoke, and the true-PostgreSQL races in [AC-6 section 11](48-agent-behaviour-ac6-sarah-feedback.md):
  - double submit;
  - cancellation, attendance correction and withdrawal racing submission;
  - deadlock absence.
- JWT/PostgREST (still BLOCKED independently), and browser/accessibility acceptance of `/student/sarah`, `/student/classes` and `/admin?section=Sessions`.
- **Production items:**
  - a feedback retention and export decision;
  - a review of the temporal-differencing residual (one response arriving between two admin reads), with options such as release after a feedback window;
  - whether LATE attendance should be eligible.

KNOWN FAILURES (AC-6): no AC-6 functional failure locally. Pre-existing environment items are recorded with the gates.

AC-6 status at review time: implemented and locally validated, uncommitted; it was then independently reviewed and merged through PR #60 (`b33da08`).

### AC-5 record (merged through PR #59)

COMPLETED ITEMS (AC-5, local):

- Identity:
  - Sarah Mitchell is Ducelio's AI learner-success counsellor and learner guide. Her technical role is the platform `COUNSELLOR`, on the fixed, unchanged `COUNSELLOR_PLATFORM_V1` profile, under `SARAH_EXECUTION_V1` / `SARAH_BEHAVIOUR_V1`.
  - She is not the historical academic COUNSELLOR row (still non-executable), and not a human staff account: no user account row, role grant or assignment, and no `is_assigned_counsellor()`.
- Capabilities:
  - Two learner intents, `GUIDE` and `SUPPORT_PROFILE`.
  - The code-owned `SARAH_AC5_EXECUTABLE_CAPABILITIES` per mode, plus two new narrow capabilities (`guide_learner_journey`, `propose_support_profile_update`).
  - Every AC-7 commercial capability, academic handoff coordination and follow-up recording stay non-executable. AC-6 is absent.
- Execution: reservation (hash only) before any provider work, then AUTHORIZE / START / FINALIZE attested under the new tag `DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1`, with the existing controller key store via `agent_behaviour_private.verify_mac` and no historical format changed.
  - The database derives learner, mode and confirmed-profile version.
  - One execution per reservation; rate limit and envelope.
  - DB ceiling of 1 call / 500 tokens / 10,000 µUSD, equal to the profile.
  - Strict transitions; immutable terminal history.
- Context: `get_my_sarah_context()` is an owner-only, bounded projection, further filtered by capability before the provider. It never includes human counsellor notes, follow-up or plan titles, transcripts, Tutor notes, assessment content, grades, payments or audit.
- Output and proposals:
  - One provider response, parsed as strict JSON `{reply, proposal|null}`. No prose scraping. Malformed output is `FAILED`/`OUTPUT_INVALID`.
  - Proposals are recorded only after a confirmed SUCCEEDED `SUPPORT_PROFILE` FINALIZE, through the new attested RPC (`DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1`). Content is immutable; `PENDING → CONFIRMED | DECLINED | STALE`; at most 3 pending.
  - Only the learner confirms or declines. Confirmation is under the learner lock and fingerprint-checked (`STALE_PROPOSAL`, no last-write-wins), and applies exactly the proposed fields to `student_support_profiles`.
- No Sarah memory: no learner message, reply, prompt or payload is persisted.
- RLS on, no table grants, six `authenticated`-only RPCs, and migration-time privilege self-verification. Audit holds ids, states and changed field names only.
- UI and demo:
  - `/student/sarah` (persona, honest limits, ask panel, proposal review with current vs suggested values and explicit Confirm/Decline), with nav "Sarah (AI guide)" for signed-in learners.
  - The demo persona is truth-synced (Sarah Mitchell as AI), and the staff workspace preview uses a distinct fictional human.
  - Seed: the fictional human COUNSELLOR staff user is renamed from "Sarah Mitchell".
- Control plane:
  - Sarah Mitchell is the executable platform COUNSELLOR, with a DB ceiling.
  - `COUNSELLOR_PLATFORM_V1` local evidence is RECORDED; hosted and live are NONE; production-proven is false; the fingerprint is unchanged.
  - Operations Engineer stays non-executable.
- Docs: new `docs/47-agent-behaviour-ac5-sarah.md`. Truth-synced docs 08, 43, 44 (collision note) and 46 (merged AC-4 status).
- Independent-review corrections (first review):
  1. **Bounded reservation admission.** The reservation RPC locks the learner first. Existing keys still replay or conflict. A NEW reservation is admitted only below 5 per 60 s and 30 per hour (`RATE_LIMITED`, with no row written), indexed on `(student_id, reserved_at)`. The server maps the refusal to `RETRY_LATER` with no provider call.
  2. **One attempt.** Usage `attempts` is 0–1 in the table CHECK, the RPC and the TypeScript schema, matching `COUNSELLOR_PLATFORM_V1`, which is unchanged.
  3. **Seed fixture repair.** Migration 054 renames the one known previously seeded fictional human "Sarah Mitchell" fixture to "Jamie Carter" under an exact guard: fixed demo id, `is_demo`, the old name and a COUNSELLOR grant. It is a no-op otherwise.
  4. **Absent profile.** An absent support profile is never treated as confirmed defaults. `NO_CHANGE` applies only against an existing confirmed row, in SQL and in TypeScript.
  5. **Truthful audit source per state.** `PENDING` is attested controller; `CONFIRMED`/`DECLINED` are learner decision; `STALE` is `DATABASE_STALE_POLICY`.
  6. **`profileFingerprint` boundary.** It stays in the learner-callable self-context as an opaque, authority-free version token. The docs now state exactly this; it is excluded from provider context and UI, and never audited.
  7. **Hydration-safe ask panel.** The server generates the first idempotency key. The key rotates in the action result after every resolved response, including `DUPLICATE`, and is kept only while the outcome is unresolved.
  8. **Adversarial assessment-help regression.** The message stays data, the instructions are unchanged and forbid it, and no assessment content reaches the provider. Live refusal remains unproven.
  9. **START re-check.** START re-checks mode and profile version under the learner lock; on change the execution is closed `FAILED`/`POLICY_BLOCKED` before any provider call.
  10. **Execution audit source (final re-review).** The source follows the resulting shape: `BLOCKED`, `TIMEOUT` and `FAILED/POLICY_BLOCKED` with null `started_at` are `DATABASE_EXECUTION_POLICY`; everything else, including a controller-finalized `FAILED/EXECUTION_TIMEOUT` after START, is `ATTESTED_EXECUTION_CONTROLLER`. The state machine is unchanged. One migration-chain test covers all seven required cases plus a started `FAILED/POLICY_BLOCKED`. Five classifier mutations were run and all were killed (restored byte-identically).
- Tests: `sarah-db` 43 (real migration chain plus the real TS controller end to end, plus a genuine pre-054 fixture-repair database), `sarah` 34, `sarah-ui` 15. Updated: control-plane server and UI, and integration-hardening (seed name).
- Correction mutation checks (each restored byte-identically and SHA-256 verified): all 8 killed.
  - Killed on the first run (7): reservation admission bound, attempts gate (RPC and CHECK), attempts in the TypeScript schema, absent-profile distinction (SQL and TypeScript), `STALE` audit source, START re-check.
  - Killed after a test fix (1): the reservation learner lock first **survived**. The xid probe cannot tell `FOR UPDATE` from the foreign key's key-share lock, so a structural pin on the live definition was added, and the re-run mutation is killed.
- Mutation checks (temporary edits, each restored byte-identically and verified by SHA-256), 15 safeguards, all killed:
  - **DB suite:**
    - role/profile `POLICY_BLOCKED`: 1 failure;
    - decision owner filter: 1;
    - record owner filter: 1;
    - SUCCEEDED source (RPC and guard): 1;
    - human-counsellor note exclusion: 5;
    - creation never applies the profile: 7;
    - stale guard: 1;
    - content immutability: 1;
    - one execution per reservation: 1;
    - decision learner lock: 1.
  - **Combined suites:**
    - reservation conflict: 2;
    - GUIDE-never-proposes: 2.
  - **Server suite:**
    - AC-7 `help_choose_course` executable: 1;
    - proposal before a confirmed FINALIZE: 1;
    - Sarah profile pin: 1. This one first **survived**, because the adapter mock did not observe the profile. The test now asserts the adapter is resolved from exactly `COUNSELLOR_PLATFORM_V1`, and the re-run mutation is killed.

AC-5 local gates: (Node 24.19.0, Windows, 16 logical processors.) **After the final re-review correction (execution audit source):**

- Focused AC-5 plus neighbouring suites: 22 files, **499/499**.
- `npm run check`, exactly as defined, at the default worker count: lint and type check passed; **4,063/4,063 across 165 files, exit 0**.
- `npm run build`: `.env.local` as-is gives exit 1 at the known `/admin` HTTPS `APP_URL` validation. With the process-level `APP_URL=https://ducelio.invalid` override: exit 0, and `/student/sarah` compiles.
- `npm run format:check`: only the six unchanged CRLF-checkout files.
- `git diff --check HEAD`: clean; untracked files have no CR or trailing whitespace.
- `npm audit --omit=dev`: the same 2 pre-existing highs (`sharp`, `source-map-js`). The package and lockfile are unchanged; `npm audit fix` was not run.

**After the first review corrections** (superseded):

- Focused AC-5 plus neighbouring suites: 22 files, **498/498** (adds `admin-control-plane-db`).
- `npm run check`, exactly as defined, at the default worker count: lint and type check passed; **4,062/4,062 across 165 files, exit 0** (+18 correction tests).
- `npm run build`: `.env.local` as-is gives exit 1 at the known `/admin` HTTPS `APP_URL` validation. With the process-level `APP_URL=https://ducelio.invalid` override: exit 0, and `/student/sarah` compiles.
- `npm run format:check`: only the six unchanged CRLF-checkout files.
- `git diff --check HEAD`: clean; untracked files have no CR or trailing whitespace.
- `npm audit --omit=dev`: the same 2 pre-existing highs (`sharp`, `source-map-js`). The package and lockfile are unchanged; `npm audit fix` was not run.

**Before the review corrections** (superseded):

- Focused AC-5 plus neighbouring suites: 21 files, 451/451. This covers Sarah DB, server and UI; platform policy; control-plane server and UI; provider and behaviour instructions; profile registry; production safety; native routing; integration hardening; counsellor assignment; support page; Tutor-note DB; Tutor/Lab runtime; database; RLS; course-engineering admin; admin control plane UI; and AC-2 DB.
- `npm run check`, exactly as defined, at Vitest's default worker count: lint and type check passed, **4,044/4,044 tests across 165 files, exit 0**. The pre-existing load-sensitive `commercial-v1-results-completion-db` timeout did not occur in this run. Timeouts and worker settings are unchanged.
- `npm run build`:
  - With this workstation's `.env.local` as-is: exit 1 at the known `/admin` prerender check "Configured production authentication requires an HTTPS APP_URL". This is environment validation on a page AC-5 does not touch.
  - With a process-level `APP_URL=https://ducelio.invalid` override (`.env.local` untouched): exit 0, and `/student/sarah` compiles as a dynamic route.
- `npm run format:check`: exit 1 only on the six unchanged CRLF-checkout files (`.github/workflows/ci.yml`, `package.json` and four `content/courses/security-plus-sy0-701/*.json`). These are Prettier-clean as committed. Every AC-5 file is clean.
- `git diff --check HEAD`: clean. The untracked AC-5 files have no CR line endings or trailing whitespace.
- `npm audit --omit=dev`: 2 high, both pre-existing and identical to the AC-4 record: `sharp` (GHSA-wq5f-xc86-pv6w) and `source-map-js@1.2.1` (GHSA-68fv-2mgg-jv7q). `package.json` and the lockfile are unchanged. `npm audit fix` was not run.

INCOMPLETE ITEMS (AC-5):

- Independent review, commit, PR CI and merge: done (PR #59, merge `f6ab664`).
- Hosted: deploy 054, verify the ledger through 054 (including the fixture repair on the hosted seed), run the ACL smoke, and the true-PostgreSQL races in [AC-5 section 13](47-agent-behaviour-ac5-sarah.md). These include the fresh-key reservation bound under concurrency and authority changes racing START.
- JWT/PostgREST (still BLOCKED independently), and browser/accessibility acceptance of `/student/sarah`.
- Live-provider evaluation of `SARAH_BEHAVIOUR_V1` (persona, AI disclosure, refusals, contract compliance, proposal precision).
- **Production item:** retention and purge of proposals, reservation hashes and execution metadata, plus a learner export decision. The free-text proposed study goal can hold sensitive content that deterministic validation cannot classify. Also a rate-limit and abuse review.

KNOWN FAILURES (AC-5): no AC-5 functional failure locally. Pre-existing environment items are recorded with the gates.

AC-5 was subsequently reviewed and merged through PR #59; its hosted items above remain open.

### AC-4 record (merged through PR #58)

COMPLETED ITEMS (AC-4, local):

- Creation semantic: the learner opts in on the Tutor support form, before sending, to keep a Tutor answer as a supplementary Tutor note.
  - The body is only the trusted server's copy of a SUCCEEDED Tutor execution's learner-visible output.
  - It is recorded at the single creation point after the release closed COMPLETED and FINALIZE was confirmed SUCCEEDED.
  - No second provider call is made and no browser text is accepted.
- Trust: a new attested RPC `record_tutor_class_note` under the new tag `DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1`, using the existing controller key store, with the MAC over the body's SHA-256. No existing HMAC format changed.
- The database derives and verifies the whole chain:
  - TUTOR only; SUCCEEDED/`PROVIDER_COMPLETE`; COMPLETED release;
  - the learner's own TUTOR handoff, with enrolment, lesson, objective and version agreement; ACTIVE enrolment;
  - AC-2 provenance equal to the frozen binding, fingerprint, runtime profile and baseline;
  - a final firewall recheck before any write.
- Schema: an immutable series per Tutor handoff, and append-only revisions.
  - Revision numbers are database-allocated under the series lock, with `unique(series, revision)`, a unique source execution and a unique provenance.
  - Bounds: body ≤ 8,000 characters (never truncated), ≤ 10 revisions per note.
  - UPDATE/DELETE refused for every writer; no delete RPC.
  - Nothing is written to curriculum or `learning_resources`.
- Learner read `list_my_tutor_class_notes`: owner-only, firewall-gated, 5 notes per page with current/earlier revisions and no internal identifiers. There is no staff, Sarah, Counsellor, Lab or Professor read.
- UI:
  - the Tutor-only opt-in and outcome message on the existing support panel;
  - `/student/tutor-notes`, labelled "Supplementary Tutor note" and "NOT COURSE MATERIAL", linked from Notes & resources.
- RLS on, no table grants, two `authenticated`-only RPCs, and migration-time effective-privilege self-verification. Audit is identifiers, role and revision only.
- Behaviour: `TUTOR_BEHAVIOUR_V2` kept, with no V3, because note keeping changes neither the Tutor's instructions, input nor output. Notes work for V1-pinned versions too (tested).
- Retention decision: deliberate learner-kept artifacts, retained immutable until a reviewed retention policy exists. The Professor transcript rule is not applied automatically.
- Independent-review corrections ([AC-4 section 20](46-agent-behaviour-ac4.md)):
  1. Firewall locking contract: both RPCs lock `student_profiles … FOR UPDATE` before the firewall. Creation then locks the enrolment `FOR UPDATE` before the ACTIVE check, the same order `start_assessment_attempt` uses. The read is no longer STABLE.
  2. The note choice is part of the reservation fingerprint. Omitted and false keep the exact historical hash; true is domain-separated with a prefix, which a learner message cannot collide with. Migration 028 is unchanged.
  3. The revision trigger also requires a COMPLETED TUTOR release of the series' learner, handoff, enrolment, lesson and objective. The docs separate the trigger (structural backstop) from the attested RPC (full authority).
  4. Learner-projection timestamps use the existing `academicTimestampSchema`.
- Tests (gates below):
  - new: `tutor-class-notes-db` 54 (real migration chain, including the real TypeScript recorder end to end and 9 review-correction tests), `tutor-class-notes-v1-db` 1, `tutor-class-notes` 19, `tutor-class-notes-ui` 11;
  - `tutor-lab-execution-runtime` +21;
  - mutation checks recorded in the AC-4 document; each correction's removal is caught.
- Local gates before the review correction (superseded by the post-correction gates below; kept for the base reproduction). Node 24.19.0, Windows, 16 logical processors:
  - Focused AC-4 set plus neighbouring Tutor/Lab, AC-2, AC-3, database and RLS suites: 19 files, 464/464.
  - `npm run check`, exactly as defined: lint and type check passed. Vitest at its default worker count **failed twice** (exit 1), each time 3,951/3,952 across 162 files. The single failure both times was a 30-second wall-clock timeout in `commercial-v1-results-completion-db` ("rejects pass_mark_bp of 0 and 10001…"), which builds three complete migration-chain fixtures in one test.
    - That file passes 56/56 alone; the test takes 11.1 s alone.
    - **The same timeout reproduces on unmodified base `1e82373`** at default parallelism on this workstation (temporary detached worktree, since removed): 3,864/3,865 across 158 files. It is pre-existing and load-sensitive, not an AC-4 regression.
    - With `--maxWorkers=8`: **3,952/3,952 across 162 files**, exit 0 (+87 AC-4 tests over base).
    - CI on Linux remains the authoritative gate.
  - `npm run build`: with this workstation's `.env.local` (an `http` `APP_URL`) it fails prerendering `/admin` with "Configured production authentication requires an HTTPS APP_URL". That is environment validation on a page AC-4 does not touch; the base build was not run with that file. With a process-level `APP_URL=https://ducelio.invalid` override (`.env.local` untouched) the build passes, and `/student/tutor-notes` compiles as a dynamic route.
  - `npm run format:check`: exit 1, only on the six unchanged CRLF-checkout files (`.github/workflows/ci.yml`, `package.json`, four `content/courses/security-plus-sy0-701/*.json`). Each is Prettier-clean as committed (checked from `HEAD`). Every AC-4 file is clean.
  - `git diff --check HEAD` is clean. The untracked new files have no trailing whitespace or CR line endings.
  - `npm audit --omit=dev`: 1 high (`source-map-js@1.2.1`, GHSA-68fv-2mgg-jv7q). Pre-existing, recorded on base after AC-3; `package.json` and the lockfile are unchanged. `npm audit fix` was not run.

- Local gates after the review correction (same workstation):
  - Focused AC-4 plus neighbouring suites (Tutor/Lab DB, runtime, domain, context, actions; content-release; capability workflow; assessment workflow; AC-2; AC-3; database; RLS; customer-journey route): 21 files, 489/489.
  - `npm run check`, exactly as defined: lint and type check passed. Vitest at its default worker count: **exit 1, 3,970/3,971 across 162 files**. The single failure is again the 30-second timeout in `commercial-v1-results-completion-db` ("rejects pass_mark_bp…"), the same failure already reproduced on unmodified base `1e82373`. It is **not** AC-4 passing; it is a pre-existing load-sensitive timeout. Supplementary `--maxWorkers=8`: **3,971/3,971**, exit 0 (+19 correction tests). Timeouts and worker settings are unchanged.
  - `npm run build`: with `.env.local` as-is, exit 1 at the known `/admin` "requires an HTTPS APP_URL" validation. With the process-level `APP_URL=https://ducelio.invalid` override (`.env.local` untouched): exit 0, and `/student/tutor-notes` compiles.
  - `npm run format:check`: only the six unchanged CRLF-checkout files (Prettier-clean as committed). Every AC-4 file is clean.
  - `git diff --check HEAD` is clean; the untracked AC-4 files have no trailing whitespace.
  - `npm audit --omit=dev`: 2 high.
    - `source-map-js@1.2.1` (GHSA-68fv-2mgg-jv7q): pre-existing.
    - `sharp <0.35.5` (GHSA-wq5f-xc86-pv6w, librsvg CVE-2026-96889): newly reported since this morning's audit, against an existing transitive dependency.
    - `package.json` and the lockfile are byte-identical to base, so neither is an AC-4 regression. `npm audit fix` was not run.

INCOMPLETE ITEMS (AC-4):

- Independent review, commit, PR CI and merge: done (PR #58).
- Hosted: deploy 053, verify the ledger through 053, ACL smoke, and dedicated true-PostgreSQL AC-4 concurrency scenarios:
  - the same-source execution materialisation race;
  - the two-execution same-series revision allocation race;
  - protected-assessment start vs note creation serialisation;
  - assessment start vs note read (property defined in AC-4 section 17).

  PGlite proves sequential idempotency and that the lock is taken, not the races.

- **Production item:** a reviewed retention period and governed purge mechanism for learner-kept Tutor notes, plus a learner deletion/export decision.
- Browser/accessibility and live-provider acceptance.

(The AC-4 review and merge are done: PR #58.)

Previous checkpoint: AC-2, Governed Academic Agent Behaviour (migration 051), merged through PR #55 (merge `7a7d5b8842f9c8fb3c39df8aefb0df708a14dc5c`). Its hosted status, as reported by the operator:

- MIGRATIONS PASS exactly through 051; the sensitive ACL sample passes.
- The existing Commercial V1 true PostgreSQL concurrency rerun is 4 PASS / 0 FAIL / 2 BLOCKED. The two blocked cases need Examiner HMAC credentials.
- JWT/PostgREST is blocked only by the absence of a genuinely expired, previously valid learner JWT.
- AC-1/AC-2 dedicated real-concurrency scenarios remain a tracked hardening gap.

See [AC-2 design and evidence](44-agent-behaviour-ac2.md).

### AC-3 hosted concurrency record (merged through PR #57)

AC-3 hosted concurrency acceptance, on `test/ac3-hosted-concurrency` from base `0d52fa6` (AC-3 merged through PR #56, merge `0d52fa601ad5b238556ad28aa53d852dcebf2c32`), merged through PR #57 (merge `1e8237353ee5b961764875952b41088c658c3468`).

- Migration `202610050052_professor_academic_handoffs.sql` has been deployed to the dedicated hosted acceptance database. The operator-reported hosted acceptance after deployment:
  - HOSTED_DATABASE PASS (PostgreSQL 17.6);
  - MIGRATIONS PASS, exactly 52 local and hosted migrations through 052;
  - RLS_ACL PASS (existing sensitive-table sample);
  - 0 FAIL;
  - JWT_POSTGREST BLOCKED (no `ACCEPTANCE_EXPIRED_LEARNER_JWT`).
- This checkpoint adds the separately named hosted scenario `POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE` (`scripts/acceptance/ac3-handoff-race.mjs`, also run by `npm run acceptance:concurrency` after, and reported apart from, the Commercial V1 scenarios). It passed independent code review (commits `47e7d1c`, `d00f5ed`). See [AC-3 section 10](45-agent-behaviour-ac3.md).
- **Hosted result (operator-reported): PASS.** Acceptance run `ac3-1791251699086-aelhec`, at branch head `d00f5ed`, against the dedicated hosted acceptance PostgreSQL:
  - two independent sessions, `pg_backend_pid` 1090742 and 1090751, for the same acceptance learner, each with the request-JWT GUC context plus `SET LOCAL ROLE authenticated`, released from one start gate;
  - both called the real `public.request_professor_academic_handoff`: one returned `duplicate=false`, the other `duplicate=true`, with the same `handoffId` `9cc6423d-987c-45ca-b8f2-eec93218cc35`;
  - exactly one `professor_academic_handoffs` projection and exactly one matching delivery handoff;
  - 1 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN.
- **AC-3 implementation and its dedicated hosted concurrency acceptance are complete for this checkpoint.**
- Evidence boundaries. The run proves hosted PostgreSQL migration-052 concurrency and idempotency for this exact handoff surface: two distinct backends, database `authenticated`-role semantics for the real acceptance learner, the actual governed RPC, and the classroom-lock/idempotency outcome observed in this race. It does **not** prove:
  - Supabase JWT signature or expiry enforcement, or PostgREST token enforcement (JWT_POSTGREST stays BLOCKED independently);
  - Professor HMAC acceptance (the execution/provenance prerequisite rows were acceptance fixtures);
  - every possible interleaving;
  - Tutor/Lab live-provider quality;
  - production readiness.
- `npm audit --omit=dev` reports 1 high advisory (`source-map-js@1.2.1`, GHSA-68fv-2mgg-jv7q, via `next` → `postcss`). It is pre-existing on base `0d52fa6`, not a regression from this branch: `package.json` and the lockfile are unchanged. Dependencies are to be addressed separately.
- **Not production-ready.**

COMPLETED ITEMS (AC-3):

- A learner-initiated Professor follow-up (`request_professor_academic_handoff`) composes the unmodified learner delivery handoff RPCs: Tutor `OBJECTIVE_REINFORCEMENT`, or Lab Instructor `PRACTICAL_HELP` for a lab practical of the lesson.
  - The database derives the learner, classroom, enrolment, version and lesson.
  - It verifies the source: the most recent SUCCEEDED, provenance-bound Professor execution of that classroom.
  - It records an immutable minimum-data projection (`professor_academic_handoffs`): identifiers, two fixed reason codes, a CHECK-pinned code-owned summary and no free text.
  - Creation is idempotent per classroom and scope, serialised on the classroom row, firewall-gated and audited (ids and codes only).
- An objective is accepted only when provably in the source's governed teaching context (manifest plus AC-2's complete-objective rule; more than 50 objectives gives `OBJECTIVE_SCOPE_UNPROVEN`). Prose is never parsed.
- Tutor/Lab receive `professorTeachingRecord.available = true` only through `get_professor_academic_handoff_for_release`:
  - only for their own ACTIVE release of that exact handoff, firewall-gated, with destination and scope cross-checked;
  - only when the pinned role version is the new reviewed `TUTOR_BEHAVIOUR_V2` / `LAB_INSTRUCTOR_BEHAVIOUR_V2`, which state that the record is not a transcript, mastery, evidence, a grade or proof of understanding.
- Level 2 versions:
  - V1 text is unchanged (hash-pinned to the AC-2 merge), and V1-pinned versions behave exactly as in AC-2.
  - New publications freeze Tutor/Lab V2. Migration 052 widens the reviewed version lists.
- Learner classroom UI: a disclosure of exactly what is shared, two closed forms, and a list of the learner's own follow-ups with the existing Tutor/Lab support panel. Execution and provenance ids are not shown, and the transcript is never shared.
- Decisions documented:
  - Professor transcript retention policy: deletion at the earlier of 12 months after the class or 90 days after the enrolment leaves ACTIVE; text only, never audit or provenance. The purge mechanism is deferred, and no delete RPC was added.
  - Lab timing is still not invented.
- Correction (independent review): creation now requires the destination role's **frozen** AC-2 binding to be the AC-3-aware V2.
  - Otherwise `DESTINATION_BEHAVIOUR_UNSUPPORTED`, refused before any delivery handoff or projection is written. The learner sees "Professor follow-up is not available for this course version."
  - The classroom page hides unsupported destinations, using the existing learner-scoped behaviour read.
  - V1 (pre-052) programme versions keep their ordinary learner Tutor/Lab handoffs. A new programme version is required for AC-3 continuity.
  - The objective-scope wording is tightened: the release rows themselves carry no lesson selector.
- Tests:
  - New: `professor-academic-handoff-db` 20 (real migration chain), `professor-academic-handoff-v1-db` 5 (a genuine pre-052 V1 publication: both refusals, no partial writes, ordinary handoffs still work), and `professor-academic-handoff` 22 (server, action, UI).
  - Extended: behaviour contract (V1 hash pins, V2 diff, 052 mirrors), Tutor/Lab provider context (V1/V2 × record matrix), Tutor/Lab runtime (record use, V1 non-read, fail closed), and AC-2 DB, Tutor/Lab DB and control-plane assertions moved to the V2 version for versions published after 052.
  - Mutation checks: removing the SUCCEEDED source requirement, the consumption firewall or the destination behaviour gate fails the DB suites.
  - After the correction: focused AC-3 set 11 files, 269/269.
  - `npm run check`, exactly as defined: **3,838/3,838 across 156 files**, exit 0. Before the correction it was 3,830/3,830 across 155 files.
  - `npm run build` passed. `npm run format:check` is clean. `npm audit --omit=dev` reports 0 vulnerabilities. `git diff --check HEAD` is clean.

INCOMPLETE ITEMS (carried, AC-3 and earlier):

- Hosted JWT/PostgREST evidence (needs `ACCEPTANCE_EXPIRED_LEARNER_JWT`) and browser/accessibility acceptance remain open. Other Commercial V1 hosted blockers are unchanged.
- **Production blocker:** a governed purge mechanism for Professor classroom transcripts implementing the AC-3 retention policy.
- Carried from AC-2:
  - a reviewed design for lessons with more than 50 objectives;
  - a repair procedure for corrupt behaviour bindings;
  - live-provider evaluation of instructional behaviour (now including Tutor/Lab V2);
  - AC-1/AC-2 dedicated real-concurrency scenarios.
- At AC-4 time, AC-5 to AC-7 were not started. (Superseded: AC-5 and AC-6 are merged, and AC-7 is implemented, independently reviewed and approved for commit/PR; see the current checkpoint above. Lab timing is still not implemented.)

KNOWN FAILURES: no local functional blocker. PGlite does not prove real multi-connection behaviour. There is no live-provider evidence for the new behaviour. Hosted acceptance blockers are listed above.

### AC-2 record (merged)

COMPLETED ITEMS (AC-2):

- Code-owned, versioned behaviour contract keyed by role, never by model:
  - Level 1: `DUCELIO_INSTITUTIONAL_BASELINE_V1`.
  - Level 2: `PROFESSOR_BEHAVIOUR_V1`, `TUTOR_BEHAVIOUR_V1`, `LAB_INSTRUCTOR_BEHAVIOUR_V1`.
  - Explicit precedence 1 > 2 > 3 > 4 > 5. The provider is told its role.
  - Course context notes, runtime facts and learner prose reach the provider only as subordinate input data.
  - The Examiner's instructions are byte-for-byte unchanged.
- Level 3, `AGENT_BEHAVIOUR_CONFIG_V1`, in a separate table:
  - four typed enums plus bounded notes;
  - admin-only and audited (no note text in the audit);
  - frozen by the database once the version is PUBLISHED or enrolled, for a first insert exactly as for an update, under the shared programme-version row lock, and never deleted.
  - Its own `AGENT_BEHAVIOUR_FINGERPRINT_V1` over the actual effective semantic values (pinned role version, source, config version, the four values and notes, including a default's concrete values), shown to admins and recorded in provenance. The migration-035 package fingerprint does not cover behaviour and is unchanged.
  - A draft without a row resolves to the versioned default `AGENT_BEHAVIOUR_DEFAULT_V1`.
  - Historical default drift is closed, fail-closed:
    - **Publication materialises behaviour.** Inside the publication transaction the database freezes an immutable `academic_agent_behaviour_bindings` row per teaching role (the effective values, including a default's concrete V1 values, and the pinned Level-2 role behaviour version), and publication cannot commit without all three verified bindings.
    - **Migration 051 performs the one-time legacy backfill** of versions already published before AC-2 (`MIGRATION_BACKFILL`, idempotent, no invented actor).
    - **Enrolment only verifies frozen behaviour** and never repairs or materialises a missing binding. A missing or corrupt binding, or an unrecognised role/config version, refuses the enrolment (`AGENT_BEHAVIOUR_BINDING_MISSING` / `_INVALID`) and blocks execution; nothing is written.
    - Runtime reads only the binding; there is no fallback to the current code default anywhere.
  - **Level 1 may evolve institutionally**, but its applied version (`institutional_baseline_version`) is recorded on every Professor/Tutor/Lab execution-provenance row alongside the pinned Level-2 version, Level-3 source/version/fingerprint, runtime profile and programme version.
  - Level-2 role baselines are kept in a versioned registry (`roleBaselineFor`); instructions, provenance and context use the pinned version.
  - Course Engineering has a typed draft-only form, read-only when bound. `/admin/agents` and Course Engineering show the database-resolved effective behaviour (pinned version, source, values, frozen/draft) and a missing/invalid binding as "execution refused".
  - There is no prompt editor and no model or provider field.
- Professor teaching context through nested reviewed `PROFESSOR_READ_V2` releases, with deterministic context budgeting:
  - lesson and the complete objective set, which is mandatory: an incomplete set or one that cannot fit is refused before any execution;
  - authorised resources and authoritative mastery;
  - server-clock timing (LIVE remaining minutes; CATCH_UP none);
  - bounded learner-visible classroom memory.

  A classroom interaction now requires its server-opened classroom.

- Professor classroom memory (`professor_classroom_turns`):
  - server-attested (`DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1`);
  - owner-only and firewall-gated;
  - non-authoritative, bounded, immutable;
  - shown to the learner on the classroom page;
  - continuity derived by the database: an unrecorded exchange is reported to the learner and to later turns as degraded memory;
  - an explicit 200-turn capacity state refused before any execution.
- Tutor: no claimed Professor teaching history and no protected-assessment help. Lab: no fabricated execution and no session clock (null timing).
- Execution provenance (`academic_agent_execution_provenance`):
  - Tutor/Lab is derived by the database in a trigger.
  - Professor is recorded through a new attested RPC (`DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1`) before START, with every claim re-derived by the database, including an attested, database-verified manifest of every contributing content release (ids and capabilities only).
- Tests (after the final drift correction):
  - AC-2 suites: behaviour contract 17, behaviour DB 44 (all need migration 051; 9 binding tests and 13 enrolment-verification, publication and institutional-baseline tests), behaviour config server read 14, Professor provenance attestation 1, provider instructions 5, teaching context 15, Tutor/Lab context 3, classroom teaching runtime 35, real-database nested releases 4 (in the capability workflow suite, 33 total).
  - Extended suites: Course Engineering admin 55 and real-DB workflow 2, Tutor/Lab DB 46 and runtime, classroom domain 24 and actions 23, control-plane UI 20 and server 22, runtime harness 15, native provider adapters, live-provider acceptance driver.
  - `npm run check`, exactly as defined: **3,780/3,780 across 153 files**, exit 0.
  - `npm run build` passed. `npm run format:check` is clean. `npm audit --omit=dev` reports 0 vulnerabilities. `git diff --check HEAD` is clean.

### AC-1 record (merged)

COMPLETED ITEMS (AC-1):

- Migration 050 binds academic-semantic agent configuration to the programme version once it is PUBLISHED or enrolled. It refuses note, profile-reference, capability-widening and escalation changes, except EXAMINER NONE→ACADEMIC_REVIEW. The enabled kill switch and capability narrowing stay available as audited operational controls. A first binding of a missing role on a PUBLISHED, unenrolled version is allowed only when it exactly matches the version's single immutable published course-package proposal. The database derives that proposal from `course_package_imports` itself (independent-review correction), which preserves course activation. A first binding is refused once learners are enrolled.
- Audit records changed field categories without any note text or note hash.
- A bounded admin-only scope read backs the new read-only `/admin/agents`. It shows CONFIGURED / READY / TESTED / PRODUCTION-PROVEN separately, credential presence only, and evidence keyed to each profile's SHA-256 fingerprint.
- The Course Engineering form no longer edits `modelProfileRef` (the server derives it from the package proposal). It labels instructional notes as stored but unused, and records the academic COUNSELLOR only as a non-executable package proposal.
- Professor and Tutor/Lab learner copy no longer claims an academic review that does not exist.
- Focused tests (after the first-binding correction): 15 files, 497/497. Governance DB 38/38: 23 of the original 29 failed against migrations 001–049, and 7 of 38 failed against the uncorrected 050 first-binding rule. Control-plane server 22/22; control-plane UI 14/14.
- `npm run check`, exactly as defined:
  - failed once before the correction (exit 1; 12 wall-clock timeouts, 116 skips, zero assertion failures);
  - then passed (3,603/3,603);
  - passed after the correction: **3,614/3,614 across 145 files**.
- Build passed. `npm audit --omit=dev` reports 0 vulnerabilities. Evidence is in docs/43.

### Previously recorded hosted acceptance (unchanged historical scope)

COMPLETED ACCEPTANCE EVIDENCE: hosted migrations previously passed through 043. Earlier hosted JWT/PostgREST, provider, concurrency and Stripe TEST-mode evidence remains historical evidence only and does not establish hosted acceptance of migrations 044–050 or production readiness.

## Phase 1 â€” complete

Phase 1 established the engineering and institutional foundation: Next.js/React/TypeScript, Supabase/PostgreSQL migrations, authentication and stable identity, backend RBAC/RLS, versioned programme structure, audited Counsellor services, student academy UI, Counsellor workspace, Administration shell, fictional previews, automated tests and architecture/security documentation.

The eight-checkpoint Phase 1 record remains in `phase-1-completion-report.md`. Hosted Auth/OAuth/SMTP acceptance was outside that historical local delivery.

## Phase 2 â€” complete and merged

The deterministic Academy Operating System now includes:

1. governed ProgrammeVersion publication;
2. governed Enrolment creation/lifecycle;
3. governed Counsellor assignment/reassignment;
4. persisted ClassSession scheduling/lifecycle;
5. authoritative AttendanceRecord workflows;
6. versioned LessonSegment planning and LessonProgress;
7. versioned LearningResource / lecture-note delivery;
8. append-only LearningEvidence collection;
9. deterministic ObjectiveMastery and immutable transition history under `MASTERY_V1`;
10. governed Assignment authoring and append-only learner submissions;
11. controlled Assessment foundations, protected content release and technical academic-activity firewalls;
12. governed Registrar corrections with explicit official-record boundaries;
13. learner Notification records and deterministic `SUPPORT_V1` support triggers;
14. cross-checkpoint authorization, concurrency, timezone, idempotency, projection and audit hardening;
15. final PR/security review hardening and merge closure.

The final review found and corrected three additional blockers before merge:

- INSTRUCTOR-only actors could self-select as assignment/assessment instructor for an arbitrary known cohort without an existing relationship;
- support-only plan/follow-up notification detail crossed into Academic Admin notification reads even though the source support records were separately permissioned;
- expired/closed controlled-assessment attempts could remain state `ACTIVE`, leaving stale lifecycle/UI state and blocking a later assessment start.

Migration `202609090020_phase2_final_review_hardening.sql` closes those findings by requiring instructor-initiated coursework/assessment creation to match a real non-cancelled ClassSession relationship, minimising Counsellor follow-up notification content and keeping support-only notification kinds outside Academic Admin/Platform Admin reads, and deterministically finalising expired/closed ACTIVE assessment attempts before another start. The learner controlled-assessment UI renders an active protected-content shell only when server-owned activity state is actually `CONTROLLED_ASSESSMENT_ACTIVE`.

The corrected final Phase 2 gate passed ESLint, route/type generation, TypeScript, **152/152 tests across 24 files**, production webpack build and Prettier locally. The corrected PR-head GitHub Actions run passed on Linux/Node 24. PR #1 was then merged into `main` at `9b902e742dd8557d51b1c31e0b6a4f522c07982a`, and the post-merge `main` CI run also passed.

## Phase 3 checkpoint 1A/1B â€” local implementation complete

The first provider-independent capability boundary exposes exactly five server-only reads: `get_actor_context`, `get_activity_permissions`, `get_current_learner_context`, `get_lesson_context` and `get_lesson_objectives`. The contracts and limitations are documented in `14-academic-capabilities.md`.

All five require the authenticated human principal to hold STUDENT. PROFESSOR is a fixed server-selected capability profile, not a RoleGrant or database principal. Multi-role users receive only their own STUDENT enrolment scope. New narrow Academy OS read services enforce explicit ownership and exact enrolled programme-version relationships alongside existing RLS; historical enrolment reads do not acquire a generic current-publication filter.

The gateway orchestrates Academy OS services, validates strict bounded input/output contracts and returns stable errors plus metadata-only provenance for successes and denials. Academic-content reads use the existing server-owned EXPLAIN firewall before retrieval and before return. Permission snapshots remain informational. No evidence/mastery/handoff write, provider SDK, model call, chat UI or public capability endpoint was added.

No new migration, database grants, dependencies or environment configuration were needed. Provenance is returned in the result envelope; a durable capability execution audit is not implemented or claimed. Separate activity checks do not constitute a transaction or a concurrency lock spanning delivery. Durable audit, concurrent release review, hosted acceptance, rate/cost controls, retention, homework integrity and human review/escalation remain required before external academic-agent rollout.

Validation on 2026-09-09 with Node 24.19.0 on PATH:

- Relevant capability suites: **66/66 tests passed**.
- `npm run check`: ESLint, route/type generation, TypeScript and **218/218 tests across 26 files passed**, preserving all 152 Phase 2 regression tests.
- `npm run build`: production webpack build passed; no new application routes.
- `npm run format:check`: passed.
- `git diff --check`: passed.

This progress entry was updated only after the implementation passed the local checkpoint gates. The changes remain on the Phase 3 feature branch; no merge to `main` or Phase 3 PR CI success is claimed.

## Phase 3 checkpoint 1C â€” additional safe Professor reads

Checkpoint 1C extends the same server-only gateway from five to exactly nine allowlisted Professor capabilities and bumps the strict contract to `PROFESSOR_READ_V2`. The four additions are `get_current_class_session`, `get_learning_resources`, `get_permitted_learning_history` and `get_current_mastery_state`.

All four additions remain authenticated-STUDENT/self-scope only, including for multi-role users. They derive scope from the owned Enrolment and its historical ProgrammeVersion rather than accepting actor, role, cohort or version overrides. They use the fixed EXPLAIN firewall before retrieval and before release; an active controlled assessment blocks them before protected academic data is selected.

The current-session read uses server time and exact owned cohort/version scope, excludes cancelled/completed sessions by selecting SCHEDULED rows only, and returns explicit CURRENT, UPCOMING or NONE. Resource reads are exact lesson/version, ordered and paginated at five items. Permitted learning history is deliberately privacy-minimised and omits evidence references, recorder identity, idempotency keys and free-text/private prose while using a deterministic recorded-at/UUID cursor. Mastery reads expose only persisted ObjectiveMastery state/counters for the exact owned lesson/version; they perform no recalculation, evidence write or policy mutation and fail closed on an oversized non-paginated projection.

No migration, provider/model SDK, prompt/chat surface, public capability route, evidence write, mastery-evaluation request or handoff was added. The test-only PGlite/PostgREST adapter was extended for the reviewed query subset; a row-alias collision found by the new history integration test was fixed in the adapter without changing the production history service.

Local validation on 2026-09-09 using bundled Node 24.20.0:

- Capability suites: **94/94 tests passed** (72 contract/gateway + 22 database-backed workflow).
- `npm run check`: ESLint, route/type generation, TypeScript and **246/246 tests across 26 files passed**.
- `npm run build`: production webpack build passed; no new application routes.
- `git diff --check`: passed before documentation cleanup.
- Final `format:check` and `git diff --check` passed after the documentation update.

Checkpoint 1C is committed on `phase-3-ai-academic-layer` at `f21755b` (`feat: extend professor academic reads`), the clean starting tree verified for 1D-A. This entry does not claim 1C PR CI success or merge to main. At 1C completion, durable capability execution audit and a serialized assessment/content release boundary were deferred.

## Phase 3 checkpoint 1D-A â€” serialized release authorization and audit

Migration `202609090021_phase3_academic_content_release.sql` adds the minimal `academic_content_releases` lifecycle and begin/close RPCs. The database derives the authenticated learner, fixes PROFESSOR, validates the exact seven academic reads and V2 contract, and uses a non-renewable 30-second DB-clock expiry. Identity is immutable, terminal states cannot be rewritten, deletes are forbidden, RLS is enabled and authenticated users receive no direct release-table privileges. Existing `audit_events` and its Platform Admin read policy provide the institutional audit surface.

Release begin/close and assessment start take the same learner `student_profiles` FOR UPDATE lock. Begin checks EXPLAIN and conservatively checks live-clock attempts after lock acquisition. Assessment start refuses while any valid ACTIVE release exists. After removing the inserted exclusion block, the replacement start function was verified identical to migration 020; all existing governed Phase 2 behavior is preserved.

The existing gateway obtains one release before content service execution and holds it through strict output/context checks, principal revalidation and final EXPLAIN enforcement. It finalizes before successful return, aborts service/validation failures, rejects expired or replayed completion, and discards content if closure/audit fails. Database unavailability can leave an ACTIVE lease until its bounded expiry. The two introspection capabilities do not lease. All nine external JSON contracts stay `PROFESSOR_READ_V2`; no owning academic read service or mastery policy is replaced.

Durable audit is **release authorization lifecycle metadata only**, atomically recorded with ACTIVE/COMPLETED/ABORTED/EXPIRED/BLOCKED transitions. BLOCKED returns a structured denial so its audit commits. Events include only learner/profile/capability/version, invocation/release identifiers and lifecycle times/state. The dedicated trigger ignores caller audit reasons and stores no content, resource bodies, objective/evidence prose, assessment prompts/answers/guidance, support prose, response bodies, credentials or arbitrary payloads.

Authenticated users can directly invoke both release RPCs using their session. They are not gateway-only: a COMPLETED event means the authenticated owner closed a release authorization, and does not prove gateway validation, content delivery or AI execution. Trusted provider execution identity/audit remains 1D-B, together with rate/cost/retention and failure/abstention/escalation controls. No provider/model integration, SDK, prompt/chat UI, public endpoint, academic write, evidence/mastery mutation or handoff was added. Provider integration remains blocked.

Validation on 2026-09-10 using bundled Node **24.19.0**:

- Focused suites: **171/171** (116 capability/gateway, 29 real-service/RLS workflow, 26 release lifecycle). All prior 94 capability tests remain passing.
- `npm run check`: lint, route/type generation, TypeScript and **323/323 tests across 27 files** passed, preserving all earlier Phase 1/2/3 tests.
- `npm run build`: production webpack build passed; no routes added.
- `npm run format:check` and `git diff --check`: passed; repeated after documentation changes.

Local PGlite tests exercise actual SQL locks, sequential assessment/release exclusion, expiry, terminal immutability, direct-call ownership/privileges, committed denial audit, audit-failure rollback and real gateway finalization/replay failures. **No two independent concurrent PostgreSQL connections were tested.** Hosted Supabase/JWT/PostgREST acceptance and true concurrency acceptance remain production prerequisites. Release authorization ordering does not retract network bytes or guarantee response arrival precedes a later assessment start.

No additional dependency, credential or environment configuration was needed for 1D-A. Migration 021 was applied only to local test databases in that checkpoint; hosted deployment/acceptance is not claimed. Checkpoint 1D-A is committed and pushed at `902e915` (`feat: serialize academic content release`) on the feature branch. Local validation and second review passed. Standalone PR CI was not run at that checkpoint. It is now included in merged PR #2 at `52720f5`; hosted/true-concurrency acceptance remains outstanding.

## Phase 3 checkpoint 1D-B1 â€” provider-neutral trusted execution governance

The interrupted B1 working tree was resumed in place at `902e915`, preserving the prior implementation. Migration `202609100022_phase3_trusted_execution_governance.sql` adds `academic_execution_private.controller_keys`, `academic_executions`, constrained `govern_professor_execution` commands and dedicated metadata-only audit/immutability triggers. It uses Node and pgcrypto HMAC-SHA256 instead of introducing a service-role credential or a new application SQL connection. No dependency or provider was added.

The authenticated human STUDENT session and an independently verified controller attestation are both required. The database derives learner identity, fixes PROFESSOR/policy, verifies the owned ACTIVE academic release and its immutable invocation, and independently enforces state, budget and admission rules. The canonical protocol binds key/learner/execution/release, operation, outcome/reason, budget and issuance/expiry. Attestations expire after ten seconds with at most five seconds of tolerated forward server-clock skew; DB time is authoritative and verification repeats after the shared learner lock. Captured AUTHORIZE/START/terminal commands cannot create a second transition. Migration 021's 30-second release and all nine V2 capability contracts remain unchanged.

Execution states distinguish AUTHORIZED, RUNNING, SUCCEEDED, FAILED, ABSTAINED, ESCALATED and admission BLOCKED. The B1 runtime deliberately records ABSTAINED/POLICY_BLOCKED and returns metadata only; SUCCEEDED is exercised solely by explicit control-plane lifecycle fixtures. Security ceilings are one concurrent execution, five admissions per 60 seconds and 30 per hour, with a maximum 20-second execution capped by the bound release expiry. B1 budgets are zero provider calls, zero input/output tokens and zero estimated micro-USD; no actual usage/cost is recorded. These are pre-production abuse ceilings, not subscription quotas.

The existing gateway admits controller composition only for the seven validated content reads inside their release. It preserves exact self/enrolment/version checks, fresh principal validation and EXPLAIN enforcement. Invalid/malformed/audit-failed transitions and release-close failures discard the result. Terminal execution history and identity are immutable, deletion is forbidden, and authenticated users cannot directly read/mutate execution/key tables or forge institutional audit writes.

The trust claim is narrow: a valid MAC proves that a holder of the Ducelio controller secret authorized the exact command; DB audit records the permitted resulting control-plane lifecycle. It does not prove provider execution, model correctness or content delivery. RPCs remain directly authenticated-callable but additionally require the MAC; they are never described as gateway-only. No standalone generic verifier, signing oracle or arbitrary payload writer is exposed. The govern_professor_execution RPC necessarily validates a MAC only for its fixed, typed execution-governance protocol. Prompts, outputs, academic/support/assessment prose, evidence references, learner responses, credentials, MACs and sensitive-content hashes do not enter execution/audit rows. Exact metadata-retention duration remains a production governance decision.

No production secret was provisioned. The private DB key store starts empty; the server requires matching server-only secret-manager environment values. Operator provisioning, rotation, backup/log protection and hosted pgcrypto/RPC grants must be accepted separately. The full design, canonical format, alternatives, failure policy and B2 prerequisites are in `15-academic-execution-governance.md`.

Initial B1 validation on 2026-09-10 using bundled Node **v24.19.0**:

- Focused suites: **265/265 tests across five files** Ã¢â‚¬â€ 56 execution DB, 38 execution workflow, 116 capability/gateway, 29 capability/RLS workflow and 26 release lifecycle tests.
- `npm run check`: lint, route/type generation, TypeScript and **417/417 tests across 29 files** passed, preserving all prior 323 tests. A missing generic type argument found on the first typecheck was corrected before the passing run.
- `npm run build`: production webpack build passed; no new routes.
- `npm run format:check` and `git diff --check`: passed, including the final documentation update.

Tests use actual Node HMAC and PGlite pgcrypto, RLS/privileges, committed replay checks, DB admission/state constraints, release exclusion, privacy and audit-failure rollback. PGlite does not establish two-connection PostgreSQL concurrency, multi-process distributed admission, hosted Supabase/Auth/JWT/PostgREST acceptance, production provisioning, process/network isolation or provider acceptance. These remain outstanding. B2 must review external-call latency/lease expiry, provider evidence/isolation, nonzero budgets and reconciliation, retention decisions and failure/abstention/escalation/human-review delivery policy. Provider integration remains blocked.

Second-review corrections preserve the architecture and add explicit service_role revocations for execution/release tables and RPCs, private schema/key/helpers, and audit mutation while preserving existing audit SELECT. Column-level mutation grants are removed too. Migration 022 now fails if effective/inherited privileges still permit the protected operations. A BYPASSRLS fixture deliberately grants broad object defaults and pre-existing audit/release column rights; tests prove those grants are closed, authenticated entry points remain available, and unsafe inherited rights fail deployment acceptance.

The authority now distinguishes validated DB-terminal START/FINALIZE denials from transport/schema uncertainty. POLICY_BLOCKED, CONTENT_RELEASE_UNAVAILABLE, ACTIVITY_BLOCKED and EXECUTION_TIMEOUT retain their outward codes without a redundant INTERNAL_ERROR transition. Uncertain admitted failures still attempt cleanup and fail closed if terminal cleanup cannot be established. No read-back RPC, canonical change or terminal-history rewrite was introduced.

Corrected validation with bundled **v24.19.0**: focused B1 DB/workflow suites passed **115/115** (68 DB + 47 workflow); `npm run check` passed lint, route/type generation, TypeScript and **438/438 tests across 29 files**. Build, formatting and `git diff --check` passed. The 21 net additional cases include 12 service-role privilege cases and an expanded eight-case START/FINALIZE terminal-code matrix plus two transport/cleanup cases. Activity and deadline changes use privileged fault-injection fixtures; they do not claim ordinary assessment start can bypass the unchanged release exclusion.

Verifier wording now distinguishes the inaccessible private raw verifier from the public fixed-protocol MAC validation result. Roadmap/progress headings have proper UTF-8 em dashes without unrelated prose rewrites. Historical controller-key UUID attribution is explicitly deferred: audit proves some active key verified the command, not which key authorized each transition. Hosted ACL/default/membership/ownership acceptance, production secret provisioning and all earlier production/B2 limitations remain outstanding.

The corrected B1 implementation passed final second review, was committed/pushed at `85d3b85`, and PR #2 CI passed on that head. Phase 3 through B1 is now merged at `52720f5`; post-merge main CI passed. Hosted/production acceptance remains outstanding; B2 has not begun.

## Phase 3 checkpoint 2A â€” institutional delivery lifecycle

Starting branch `phase-3-delivery-lifecycle` was clean at exact SHA `52720f51848bfdcf93d03d709820b44d788911d9`. The bundled Node v24.19.0 baseline passed 438 tests across 29 files. No existing Phase 1/2/3 implementation was discarded.

Migration 023 adds separate enrolment StudyPlans, immutable schedule/revision records, start receipts, catch-up requirements and bounded handoffs. The corrected DELIVERY_V1 policy accepts learner-selected ISO weekdays, local start time and an IANA timezone; latest start is the next scheduled slot minus 60 minutes, including a hypothetical final next slot. It is an inclusive start boundary, not a response/completion deadline. DST, historical changes, valid starts completing later and late first progress are tested. Existing LessonProgress governs planned-segment completion; mastery remains exclusively MASTERY_V1 over validated evidence.

Academic-role access closes after course completion while historical materials and continuing Counsellor access remain available. Explicit staff metadata projections retain existing RBAC/privacy boundaries. Handoffs have fixed generated summaries and LEARNER_REQUEST provenance, never fabricated agent execution. Cooldown and optional prospect profile are domain-only, with storage/enforcement deferred. No provider, public AI endpoint, academic write capability or new credential was added. Full policy, rationale, limits and the 15 September display-UI work remaining are in `16-institutional-delivery-lifecycle.md`.

Final corrected local validation used Node **v24.20.0** and npm **11.19.0**. `npm run check` passed ESLint, route/type generation, TypeScript and **622 tests across 31 files**, preserving the 438-test baseline. The delivery suites comprise **184 tests**: 151 delivery-workflow tests and 33 delivery-server tests. `npm run build`, `npm run format:check` and `git diff --check` passed. The original midnight-UTC/fixed-24-hour draft was corrected before commit. Final second review completed before implementation commit `afc6ba2`, which was pushed on `phase-3-delivery-lifecycle` and entered PR #3. Hosted Supabase, true-concurrency and production acceptance remain outstanding.

## Commercial V1 â€” Course & Agent Engineering and B2 runtime foundation

Starting branch `commercial-v1-course-agent-runtime` was clean at exact SHA `ccfb8c8ae0a2ab172286b5f97c8305e9386d9eb7`, merged main through the commercial V1 contract checkpoint. Full detail, rationale and exact limitations are in `18-course-agent-engineering.md`, including finding-by-finding tables mapping two rounds of independent security/architecture review (16 findings, then 3 further findings) to their fixes; this entry summarises the **corrected** implementation.

Migration `202609120024_commercial_v1_course_agent_engineering.sql` is additive only and adds: `course_package_imports` (a staged, immutable-once-recorded package with a strict `IMPORTED â†’ VALIDATED â†’ APPLIED â†’ PUBLISHED`/`REJECTED` lifecycle, idempotent on `(package_key,package_revision)` plus a **database-derived** content hash, with no direct table grant to `public`/`anon`/`authenticated`/`service_role` â€” access is RPC-only because staged content can embed controlled-assessment answer keys, and `service_role`'s `BYPASSRLS` means this is an explicit ACL revoke, not reliance on RLS); the governed RPCs `import_course_package` (independently binds declared key/revision/schema-version to the embedded content and derives the hash itself via `extensions.digest`), `mark_course_package_validated` (gated by the new `course_engineering_private.assert_full_package_valid`, which independently re-verifies the **entire** stored `COURSE_PACKAGE_V1` â€” not only its curriculum subset â€” so a caller-supplied report or a direct authenticated-admin RPC call bypassing the TypeScript validator can never force `VALIDATED`) and `apply_course_package` (retains the narrower `assert_materializable` as a defense-in-depth recheck immediately before its institutional writes), `reject_course_package` and `publish_course_package`; the admin reads `get_course_package_content` (unredacted, authoring-only), `get_course_package_preview` (answer keys redacted) and `list_course_packages`; and `academic_agent_configs` with `set_agent_config`, `list_agent_configs` and the learner-scoped, fail-closed `get_agent_config_for_enrolment`. The per-role capability allowlist now has exactly one SQL definition (`course_engineering_private.role_capability_allowlist`), shared by `set_agent_config` and the full-package validator. Every table, the private schema and all functions this migration defines are explicitly revoked from `public,anon,authenticated,service_role` with EXECUTE granted back to `authenticated` only on the eleven public RPCs, closed by an effective-ACL assertion block that fails deployment on any unsafe inherited privilege â€” mirroring migrations 022/023 exactly, since `service_role`'s `BYPASSRLS` means RLS alone never protects these objects. `apply_course_package` atomically inserts a brand-new DRAFT `programme_versions` row plus its modules/lessons/objectives/resources into the exact tables migrations 001/006/012 already made authoritative; `publish_course_package` reuses the existing `publish_programme_version` (migration 006) rather than re-implementing its checks. A unique-label collision mid-apply rolls back the whole statement with no orphan rows (tested); re-applying or publishing an already-applied/published import is idempotent; publishing a new revision never rewrites a prior published version's frozen snapshot even when the live programme row's metadata changes (tested explicitly); seven direct-RPC adversarial tests prove an authenticated admin bypassing TypeScript validation cannot reach `VALIDATED` with a broken assignment/assessment reference, an invalid agent capability, a duplicate reference, a malformed schedule or an unrecognised timezone, including one test proving the narrower `assert_materializable` alone would have missed the capability defect.

`src/domain/course-package.ts` is the versioned `COURSE_PACKAGE_V1` manifest contract with a pure, deterministic `validateCoursePackage` (structural + cross-reference validation: duplicate module/lesson/objective/resource/practical-activity keys and positions, duplicate references within any single `objectiveRefs` array, IANA-timezone validation, and agent-configuration capability allowlisting against the single shared catalogue below) and a key-order-independent canonical string for TypeScript-side use. The validated package is reachable only through `validateCoursePackage`'s own success branch â€” there is no separate exported cast/escape-hatch function. Assignment/controlled-assessment templates and practical activities are validated and staged but **not** materialised into real `assignments`/`assessments` rows at apply time (those require a cohort/instructor that a package cannot itself invent); that remains a manual follow-up through the existing `create_assignment`/`create_assessment` RPCs. `src/domain/academic-capability-policy.ts` is now the single source of truth for agent-role vocabulary and the per-role capability allowlist (extracted specifically to avoid a circular import between course-package.ts and academic-agent-config.ts); `src/domain/academic-agent-config.ts` re-exports from it and defines the stored-configuration schema. PROFESSOR's capability allowlist reuses the existing nine-name `PROFESSOR_READ_V2` catalogue exactly; the other four roles get a reviewed placeholder allowlist (no independent server-enforced execution exists for them yet). A stored configuration only ever narrows what may be requested â€” the server independently re-checks, at execution time, both that a capability is in the code-owned catalogue **and** that the stored configuration actually requested it.

The B2 runtime (`src/domain/academic-runtime.ts`, `src/domain/academic-runtime-profile.ts`, `src/server/academic-runtime/*`) is a complete, standalone, fully tested provider-neutral harness: a `ProviderAdapter` port with no vendor SDK; a fail-closed, HTTPS-only, userinfo-rejecting, non-redirecting `resolveConfiguredProvider()`; a **code-only runtime/model-profile registry** (ships empty â€” no provider choice has been made â€” so a stored `modelProfileRef` is only ever a lookup key that fails closed before any provider call, including a URL- or credential-shaped value); and `runGovernedProviderExecution`, which is explicit about pre-call **hard** ceilings (admission, a byte-length context-size ceiling, and one `totalDeadlineMs` shared across every retry attempt so attempts can never multiply a nominal execution window) versus post-call usage **reconciliation** (output-token and monetary-cost overage, which a call may still incur even though its response is discarded â€” a `BUDGET_BLOCKED` result's `stage` field distinguishes the two). `executeRoleCapability(request)` â€” the **production entrypoint, with no override parameter at all** â€” composes authenticated-STUDENT identity, the existing 2A institutional delivery-agent-access lifecycle (`getDeliveryAgentAccess`, not a parallel activity check), stored agent configuration, code-owned capability authorization and profile resolution, then â€” for PROFESSOR only â€” calls the existing `PROFESSOR_READ_V2` gateway's release-aware `withValidatedProfessorContent` and runs the provider call **inside that gateway's own consumer callback, while its content-release lease is still open**. Any already-captured provider output is discarded if the gateway's own final principal/activity recheck fails or its release finalization fails afterward, and zero provider calls occur if the gateway denies the capability/release before the callback ever runs. Every role other than PROFESSOR fails closed with `NO_EXECUTION_PATH`: no bounded, correctly-provenanced context builder exists for TUTOR/LAB_INSTRUCTOR/EXAMINER/COUNSELLOR yet, so a placeholder catalogue entry is never treated as a live execution path. Dependency injection for tests is isolated in a separate `executeRoleCapabilityWithTestOverrides` entrypoint, which itself refuses to run under `NODE_ENV=production` before touching any injected adapter/profile resolver â€” so an injected dependency is structurally unreachable in production, not merely discouraged by convention. A `DeterministicFakeProviderAdapter` exists **only** for tests, likewise refuses to construct under `NODE_ENV=production`, and is never returned by the production resolver or registry.

This runtime is deliberately **not** spliced into `executeProfessorRead`/`govern_professor_execution` (migration 022) in this checkpoint: that RPC's admitted envelope is zero provider calls by explicit, previously reviewed design (`15-academic-execution-governance.md`), and raising it is its own separately reviewed migration, not a side effect of adding an adapter interface. Building the harness standalone first, and composing it into the live execution RPC as an explicit next step, was a deliberate Secure-Checkpoint-Rule decision rather than an oversight.

Local validation after the round-two corrections: ESLint, route/type generation and TypeScript all pass; `npm run build` passed with no new routes; `npm run format:check` and `git diff --check` passed. `vitest run` reported **758 tests across 40 files**, of which **749 passed**; the remaining **9 failures were in `tests/delivery-workflow.test.ts`**, an unrelated Phase 3 2A file this checkpoint never touched. At the time, these were reported as reproducing identically before any change in this correction pass and attributed to the session's wall-clock date advancing past a fixture's relative-date assumption â€” that attribution was a hypothesis, not yet verified; the next paragraph corrects it with the actual, verified mechanism. Every test this checkpoint added or touched passed, including 27 in the rebuilt composition suite and 7 new in the production-safety suite.

A third correction pass fixed both the delivery-workflow failures above and a separate checkpoint blocker, with no change to approved content-release, production-DI or delivery-lifecycle production behaviour. **`tests/delivery-workflow.test.ts`**: re-verifying rather than assuming the prior paragraph's date-rollover guess, repeated full-suite runs at the unchanged calendar date disproved it outright (758/758 passed with zero date change). The real mechanism was wall-clock time-of-day, not date: the `historical()` fixture anchored its daily-cadence schedule at a fixed `'00:00'` UTC local start time, so "today's" own occurrence deadline (`next slot âˆ’ 60 minutes`) fell exactly at `23:00` UTC â€” DELIVERY_V1 correctly marking it `MISSED` in the last UTC hour of any day, which broke fixtures that assumed "today" was always still open; a second, independent fixture bug computed a schedule-change boundary from the session's UTC `current_date` instead of the target `Europe/London` timezone's own date, tripping `change_future_delivery_schedule`'s "after today" check specifically during BST. Both were test-fixture/wall-clock defects, not production defects; DELIVERY_V1's policy was behaving exactly as specified in every case. The fix makes the whole file deterministic rather than merely less likely to flake: `historical()` now anchors at a fixed, literal UTC noon (`'12:00'`, 12 hours from either day boundary) instead of `'00:00'` or a live-captured time, the predecessor-deadline test derives its boundary from `Europe/London`'s own date, and the file freezes the system clock for its entire `beforeAll`/`afterAll` lifetime at a fixed UTC noon instant (`vi.useFakeTimers({toFake:["Date"]})` + `vi.setSystemTime`, verified to deterministically drive PGlite's own `clock_timestamp()`/`now()`, which read the JS `Date` object) â€” the same fake-timer pattern already used in `tests/academic-capability-workflow.test.ts`. No production delivery code changed. **`course_engineering_private.assert_full_package_valid`**: an independent review found this function, despite its comment's claim of re-verifying the complete `COURSE_PACKAGE_V1` contract, actually omitted most of `src/domain/course-package.ts`'s bounds and shape constraints â€” the top-level `reason` and `packageRevision` maximum were never checked; every `localRef`-typed key/reference was checked for non-emptiness only, not its `1..80`/`[A-Za-z0-9_.-]+` shape; almost every bounded string/array had no upper bound enforced at all (titles, descriptions, instructions, prompts, rubric/question/template/objectiveRefs counts); assignment rubric criteria were never individually validated; assessment `markingGuidance` and the agent-role `modelProfileRef`/`instructionalNotes` fields were entirely unchecked; no nested object rejected an unrecognised extra key, unlike the TypeScript contract's `z.strictObject`; and three existing `... not in (...)` enum checks (`resource.kind`, `activity.kind`, `escalationPolicy`) were not null-safe, so an entirely missing field silently passed. All of these are now enforced, via four new small shared SQL helpers (`assert_bounded_identifier`, `assert_local_ref`, `assert_bounded_text`/`assert_bounded_text_or_null`, `assert_exact_keys`) used consistently at every call site so the check and its bound live in one place rather than risking independently drifting copies; `assert_materializable` (the narrower apply-time defense-in-depth check) and `mark_course_package_validated`'s gating by the full validator are both unchanged. 16 new table-driven adversarial tests in `tests/course-engineering-workflow.test.ts` each assert that a mutation is rejected by **both** `coursePackageSchema.safeParse()` and a direct, authenticated `mark_course_package_validated` RPC call bypassing TypeScript entirely, so future drift between the two is visible rather than silent. `vitest run` now reports **772 tests across 40 files, all passing** (758 baseline + 16 new parity tests); `npm run check`, `npm run format:check`, `npm run build` and `git diff --check` all pass. The implementation remains uncommitted on the feature branch pending review.

## Commercial V1 â€” Live Professor Provider-Backed Execution

Starting branch `commercial-v1-live-professor-execution` was clean at the verified, merged `2a3cb013b5a79a4e2b814c15398b62ddb182a698` (PR #5). Full design, ordering guarantees and the critical-success-rule proof are in `19-live-professor-execution.md`; this entry summarises it.

This checkpoint composes the previously-standalone B2 runtime harness into `executeRoleCapability` (`src/server/academic-runtime/index.ts`), the single existing composition boundary â€” no second Professor authorization architecture was built. It does this **without editing migration 022**: a brand-new migration, `202609130025_commercial_v1_live_professor_execution.sql`, introduces a separately identifiable `PROFESSOR_EXECUTION_V2`/`PROVIDER_BACKED_V1` governance surface (`public.academic_provider_executions`, `public.academic_provider_execution_usage`) with its own DB-owned nonzero budget ceiling (`max_provider_calls` 1..3, `max_output_tokens` 1..4000, `max_estimated_cost_microusd` 1..200000 micro-USD) enforced by table CHECK constraints independent of whatever a runtime profile, course package or stored agent configuration proposes. Migration 022's historical `PROFESSOR_EXECUTION_V1`/`CONTROL_PLANE_ONLY` table, RPC and zero-budget meaning are byte-for-byte unchanged; V2 reuses only the existing `academic_execution_private.controller_keys` HMAC trust root, under a distinct canonical-message protocol tag so a V1 attestation can never authorize a V2 transition or vice versa.

The composition order inside `executeRoleCapability` is: authenticate â†’ 2A delivery access â†’ agent configuration/capability authorization â†’ runtime/model profile resolution â†’ the existing `withValidatedProfessorContent` gateway begins its own academic-content release â†’ **inside that release's still-open callback**, AUTHORIZE then START the V2 execution, then run the provider (`runGovernedProviderExecution`) with an effective runtime policy built from the profile but with `maxProviderCalls`/`maxOutputTokens`/`maxEstimatedCostMicrousd` replaced by the exact capped/admitted proposal, capturing its `RuntimeResult` â†’ return from the callback (no FINALIZE yet, the execution is left `RUNNING`) â†’ only once the gateway itself has performed its final principal/activity recheck and closed the release successfully is FINALIZE called, durably reconciling the actual usage and terminalizing the V2 execution in one trusted transaction. A `SUCCEEDED` response escapes to the caller only once that FINALIZE call is itself confirmed by the database with a terminal state matching exactly what was requested; any release/gateway/FINALIZE failure discards the response (returns `ABSTAINED`), and the returned `RuntimeResult` still carries the real usage a provider call actually consumed rather than a zero placeholder â€” though that usage is durably persisted only when the FINALIZE call itself is confirmed; if FINALIZE cannot be confirmed, the row instead resolves later under the DB's own timeout/reconciliation handling. `mapRuntimeResultToFinalizeCommand` (`src/domain/academic-provider-execution.ts`) is a pure function honestly mapping every `RuntimeResult` outcome (`SUCCEEDED`/`FAILED`/`ABSTAINED`/`ESCALATED`/`BUDGET_BLOCKED` with `PRE_CALL`/`POST_CALL` stage/`TIMEOUT`/`CANCELLED`) onto this bounded vocabulary, strictly validating the real usage against the durable ledger's own bounded schema rather than silently clamping it.

`public.academic_provider_execution_usage` closes the previously-documented durable-usage-ledger gap: exactly one immutable row per execution (provider calls, attempts, input/output tokens, estimated cost, elapsed time only â€” no prompt, response or any other content field exists anywhere in the schema), written once by FINALIZE and permanently guarded against update/delete. Only the reviewed `govern_professor_provider_execution` RPC (SECURITY DEFINER, MAC-verified, authenticated-learner-scoped) can ever write either table; both are revoked from `public`/`anon`/`authenticated`/`service_role` directly, closed by the same effective-ACL assertion pattern as migrations 022/024.

42 new tests (23 direct-RPC database tests in `tests/academic-provider-execution-db.test.ts`, 19 composition-boundary tests in `tests/academic-provider-execution-workflow.test.ts`) prove: the DB-owned ceiling rejects a zero or out-of-envelope budget before any provider call, and a proposal above the ceiling fails MAC verification outright; replay/forgery/controller-key-revocation all fail closed; usage is persisted exactly once and tied immutably to its execution, including for discarded (budget-blocked/failed/cancelled) outcomes; a foreign learner and service_role/anon cannot read or forge either table; terminal history and usage rows are both immutable; the composition boundary never calls the provider on a failed admission, runs it only while the release is `ACTIVE`, discards a genuine provider success on release-finalization failure, on the gateway's own final `ACTIVITY_BLOCKED` recheck, and on FINALIZE's own persistence failure or state mismatch (in every such case returning the provider's real usage, never zero); and TUTOR/LAB_INSTRUCTOR/EXAMINER/COUNSELLOR remain `NO_EXECUTION_PATH` regardless of stored configuration. Two pre-existing test files needed updating as a direct, honest consequence of this composition (not a weakening): `tests/academic-execution-db.test.ts`'s function-count assertion for the shared `academic_execution_private` schema grew from 12 to 17 (the 5 new V2 private functions, all correctly revoked); `tests/academic-runtime-composition.test.ts` needed a pass-through mock of the new `attestProviderExecutionCommand` dependency so its existing assertions about the underlying gateway/adapter composition continue to hold unchanged. `vitest run` reports **816 tests across 42 files, all passing**; `npm run check`, `npm run format:check`, `npm run build` and `git diff --check` all pass. The implementation remains uncommitted on the feature branch pending review.

No provider secret, endpoint or vendor SDK was added. The code-owned production runtime/model-profile registry (`src/server/academic-runtime/profile-registry.ts`) remains deliberately empty â€” no provider choice has been made â€” so in production every stored `modelProfileRef` still fails closed to `ABSTAINED`/`UNKNOWN_MODEL_PROFILE` before any of this governance is even reached. This checkpoint makes the execution _path_ real and independently testable with deterministic fake adapters; it does not claim hosted provider acceptance.

**Correction pass** (same uncommitted checkpoint): an independent review approved the overall V2 architecture, HMAC design, V1/V2 separation, ACL approach, provider ordering and the critical success rule, and found three concrete implementation blockers, all now fixed in migration 025 and the composition boundary (not a redesign):

1. `runGovernedProviderExecution` was still invoked with the runtime profile's own, uncapped `budgetPolicy` even though AUTHORIZE correctly proposed the DB-capped envelope â€” a generous profile could be admitted for the small V2 ceiling while the provider harness itself still enforced the profile's much larger one. Fixed by constructing an effective runtime policy from the profile with `maxProviderCalls`/`maxOutputTokens`/`maxEstimatedCostMicrousd` replaced by the exact admitted proposal (`maxAttempts`/`maxInputContextBytes`/`totalDeadlineMs` still come from the profile).
2. A genuine controller-observed runtime timeout (`RuntimeResult` outcome `TIMEOUT`) was mapped to `FAILED`/`EXECUTION_TIMEOUT`, but `EXECUTION_TIMEOUT` was not actually a valid `FAILED` reason in either the table's lifecycle `CHECK`, the FINALIZE reason whitelist, or the TypeScript snapshot schema's own `FAILED` reason list â€” so this exact, intended path would have been rejected with `INVALID_INPUT`, leaving the execution stuck `RUNNING` until the unrelated DB lazy-expiry sweep eventually caught it. Fixed by adding `EXECUTION_TIMEOUT` to all three, keeping the DB's own separate lazy-expiry `TIMEOUT` state unchanged.
3. The discarded-output failure paths (release-finalization failure, the gateway's final recheck failure, a FINALIZE state mismatch, FINALIZE persistence/transport uncertainty) correctly discarded the provider's response, but returned an `ABSTAINED` `RuntimeResult` carrying the zero-usage placeholder instead of the real usage a provider call may already have consumed. Fixed to return the actual captured usage in every case; a `clampUsageReport` helper that silently reduced out-of-range numbers was replaced with strict schema validation (`ImpossibleUsageError` on failure, treated as a FINALIZE-confirmation failure) so the durable ledger is never silently falsified either.

4 new regression tests were added (2 proving the runtime policy is actually capped â€” including that the adapter itself receives the 4,000-token DB ceiling rather than a generous profile's larger value, and that an over-ceiling post-call cost becomes `BUDGET_BLOCKED`/`POST_CALL` rather than a nominal `SUCCEEDED`; 1 database test proving a `RUNNING` execution can FINALIZE as `FAILED`/`EXECUTION_TIMEOUT` with real usage; 1 composition test exercising a genuine `RuntimeResult` `TIMEOUT`, not the DB's lazy sweep), and the four existing discarded-output tests were extended with usage assertions. `vitest run` now reports **816 tests across 42 files, all passing** (previously 812/42); `npm run check`, `npm run format:check`, `npm run build` and `git diff --check` all pass. Migrations 001â€“024 remain byte-for-byte unchanged; migration 025 is corrected in place (still uncommitted, no migration 026 created).

## Commercial V1 â€” Learner-Facing Professor Classroom

Starting branch `commercial-v1-professor-classroom` was clean at the verified, merged `7d8b96bf18a248ca743edef2f885eb80620b921f` (PR #6). Full design, eligibility rules and the invariant list are in `20-professor-classroom.md`; this entry summarises it.

This checkpoint gives the Professor governance built in the prior checkpoint an actual learner-facing surface, extending the existing Academy Operating System rather than building a parallel demo: from `/student`, an authenticated learner sees, per `ClassSession`, a server-derived CTA (`Starts atâ€¦` for a future class; `Start class`/`Resume class` for a current one; `Start catch-up`/`Resume catch-up` for a past, non-cancelled one; nothing for a cancelled or foreign one) and can follow it to a dedicated `/student/classroom/[classSessionId]` page. Eligibility is computed from server/database time against the exact same `class_sessions` ownership join migration 019's `list_my_class_sessions` already uses (cohort + programme version, not the unrelated 2A delivery-occurrence schedule): `CANCELLED` overrides everything; strictly before `scheduled_start` is `FUTURE` (blocked, `NOT_YET_STARTED`); `scheduled_start <= now <= scheduled_end` (inclusive both ends) is `LIVE`; strictly after `scheduled_end` is `CATCH_UP`. A brand-new, additive-only migration, `202609130026_commercial_v1_professor_classroom.sql`, was required because "resume the same classroom state" needs a durable, learner-owned row across visits/devices that a client-supplied ID alone cannot safely provide â€” it adds `public.professor_classroom_sessions` (one row per `(student_id, class_session_id)`: enrolment/programme-version/lesson identity, `LIVE`/`CATCH_UP` mode, first/last-opened timestamps) and `public.professor_classroom_interaction_reservations` (one row per `(classroom_id, idempotency_key)`, a durable idempotency reservation ledger â€” see the correction-pass paragraph below), plus three SECURITY DEFINER RPCs (`open_professor_classroom`, `record_professor_classroom_interaction`, `list_my_professor_classroom_session_ids`), all independently re-deriving ownership rather than trusting any client-supplied relationship, mirroring migrations 022/024/025's ACL-hardening pattern (explicit `revoke all` from `public,anon,authenticated,service_role` at table/schema/function/column level, `grant execute` back to `authenticated` only on the three RPCs, closed by an effective-ACL assertion block). Neither table is an institutional academic record: neither can or does mark attendance, write `learning_evidence`, change `objective_mastery`/`lesson_progress`, or grade anything â€” proven directly by DB tests asserting zero rows appear in any of those tables (or `audit_events`) as a result of classroom interactions.

The classroom page reuses the existing reviewed reads verbatim â€” `getStudentLessonObjectives`, `getStudentLessonResources`, `getStudentLessonMastery` â€” each of which independently re-enforces the controlled-assessment explanation firewall itself; when `CONTROLLED_ASSESSMENT_ACTIVE` (or any other Academy OS block) is in effect, all of them throw together and the classroom shows an unavailable state with no Professor interaction offered and no provider call made â€” no "assessment help" exception was added. The two learner-facing Professor actions are **Begin lesson** (a deliberate button press constructing a fixed `{kind:"BEGIN_LESSON"}` interaction â€” never fired merely by the page rendering or refreshing) and **Ask Professor** (a plain-text `<textarea>` with a real `<label>`, validated server-side as trimmed, 1â€“2,000 characters, no arbitrary JSON, before any classroom lookup or provider call). Both submit through one shared Server Action helper (`src/app/student/classroom/actions.ts`) that: requires an authenticated STUDENT; re-derives the classroom via `openProfessorClassroom` from `classSessionId` alone (ignoring any `enrolmentId`/`role`/`capability`/`provider`/`model`/budget fields a form might additionally carry â€” proven by an explicit test asserting the exact key-set reaching `executeRoleCapability`); enforces one-provider-call-per-intended-action via a durable, server-validated idempotency reservation (see the correction-pass paragraph below) â€” a repeated key returns `DUPLICATE` without a second `executeRoleCapability` call; and calls `executeRoleCapability` â€” the existing, single composition boundary, narrowly extended for this checkpoint rather than left unmodified â€” with a server-chosen `role: "PROFESSOR"`, a server-chosen `capability: "get_lesson_context"`, and the interaction, inside a narrow try/catch mapping any unexpected exception to a safe `RETRY_LATER` result. `executeRoleCapability`'s own request schema (`src/server/academic-runtime/index.ts`) was extended by exactly one optional, closed field: `interaction: professorClassroomInteractionSchema` â€” a `z.discriminatedUnion` of the two `z.strictObject` shapes above, never `z.unknown()` â€” threaded into the provider context only when present (proven backward-compatible: a request without `interaction` produces a context object with no `interaction` property at all, so every pre-existing V2 test continues to pass unchanged). No second provider runtime, no second authorization boundary and no LLM-based capability router were built; 2A delivery access, agent-configuration/capability authorization, migration-025's AUTHORIZEâ†’STARTâ†’providerâ†’release-closureâ†’FINALIZE governance and the academic-content release all still run exactly as before, unaware of anything beyond one new optional field in the context they already assemble.

`src/server/academic-runtime/profile-registry.ts`'s previously-empty `PRODUCTION_PROFILE_REGISTRY` now has exactly one reviewed entry, `PROFESSOR_COMMERCIAL_V1` (`HTTP_JSON` adapter, `maxProviderCalls:1`, `maxAttempts:2`, `maxInputContextBytes:16000`, `maxOutputTokens:900`, `totalDeadlineMs:15000`, `maxEstimatedCostMicrousd:40000`) â€” every value conservatively inside migration 025's DB hard ceiling (1..3 calls, 1..4000 output tokens, 1..200000 micro-USD). No vendor SDK, hardcoded provider dependency or credential was added; `resolveAdapterForProfile` still returns null and production execution still fails closed as `NO_PROVIDER_CONFIGURED` when `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` are absent or invalid, exactly as before. Runtime outcomes are mapped to five safe learner-facing states (`SUCCEEDED` shows the response text; `ABSTAINED`/`ACTIVITY_BLOCKED` and `ABSTAINED`/other reasons map to distinct calm "unavailable" states; `ESCALATED` maps to an academic-review message; `BUDGET_BLOCKED`/`TIMEOUT`/`FAILED`/`CANCELLED` all map to one `RETRY_LATER` state) â€” no raw provider error, HMAC detail, controller key, usage number or internal DB ID is ever rendered.

78 new tests were added across four new files plus one existing file this checkpoint touches (`tests/professor-classroom-domain.test.ts` â€” 22 pure unit tests for eligibility/outcome-mapping/schemas; `tests/professor-classroom-db.test.ts` â€” 19 DB-backed tests for ownership, foreign/cancelled/future denial, resume, idempotency, immutability, ACL and non-leakage into institutional tables; `tests/professor-classroom-actions.test.ts` â€” 19 mocked Server Action tests proving server-selected context, bounded-message validation, idempotency and safe outcome mapping; `tests/professor-classroom-runtime.test.ts` â€” 16 composition-level tests proving `interaction` reaches provider context safely without weakening any existing governance; and 1 further test added to `tests/academic-runtime-profile-registry.test.ts` for the new profile). `vitest run` reported **894 tests across 46 files, all passing** (816 baseline + 78 new/changed) at that point.

**Correction pass** (same uncommitted checkpoint, same branch, same base): an independent review approved the overall classroom architecture directionally and found three concrete blockers, all fixed in migration 026 (corrected in place, no migration 027) and the composition/Server-Action boundaries, not a redesign. (1) **Idempotency did not survive out-of-order replay**: the original design compared a submitted key only against the classroom row's single most-recently-seen key, so `K1` (accepted) then `K2` (accepted) then a replayed `K1` would have been wrongly re-admitted. Fixed by giving every spent key durable, per-classroom uniqueness: a new table this same migration adds, `public.professor_classroom_interaction_reservations`, holds one row per `(classroom_id, idempotency_key)` as its `PRIMARY KEY`, written once via a single atomic `insert ... on conflict do nothing`; metadata only (no learner prose, provider response, prompt or token payload), revoked from `public`/`anon`/`authenticated`/`service_role` exactly like `professor_classroom_sessions`, and made permanently immutable by its own guard trigger. The required sequence `K1 -> proceed; K2 -> proceed; K1 replayed -> duplicate` is now directly tested, along with proof that the same key value is independently reservable per learner (never a global key namespace). (2) **A classroom `interaction` was accepted independent of capability**: `executeRoleCapabilityCore` now enforces, before `capabilityInput` is even assembled and long before `withValidatedProfessorContent`/the provider adapter/migration 025's AUTHORIZE-START-FINALIZE governance are reached, that an `interaction` is semantically valid only for role `PROFESSOR` plus capability exactly `get_lesson_context` plus a present `lessonId` plus an absent `objectiveId` (never an alternate selector); every other combination fails closed with zero provider calls and zero execution attestation, tested for all eight other Professor capabilities plus the alternate-selector and missing-selector cases. (3) **An unexpected `executeRoleCapability` exception was not caught** at the Server Action boundary: `requestProfessorClassroom` now wraps that call in a narrow try/catch mapping any unexpected throw to the same safe `RETRY_LATER` learner state, with no raw exception text, no secret-looking substring and no automatic second call; the already-reserved idempotency key stays consumed, tested with a deliberately sensitive-looking rejected error. This pass added 16 further tests (3 in `tests/professor-classroom-db.test.ts`, bringing it to 22; 11 in `tests/professor-classroom-runtime.test.ts`, bringing it to 27; 2 in `tests/professor-classroom-actions.test.ts`, bringing it to 21) and truth-synced this document and `20-professor-classroom.md` to stop describing `executeRoleCapability` as "unmodified" (it is the existing, single boundary, narrowly extended) and to fix a migration-026 header comment that still said "two RPCs" when there are three. `vitest run` now reports **910 tests across 46 files, all passing** (894 + 16); `npm run check`, `npm run format:check`, `npm run build` (still proving the new route compiles) and `git diff --check` all pass. Migrations 001â€“025 remain byte-for-byte unchanged; migration 026 is still the only migration this checkpoint adds, corrected in place.

No live provider call was attempted: `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` were not set in this session. **HOSTED PROVIDER ACCEPTANCE: PENDING.** The implementation remains uncommitted on `commercial-v1-professor-classroom` pending review.

## Commercial V1 â€” Backend Integrity Correction

Starting branch `commercial-v1-backend-integrity` at the closed-green PR24 merge `0c20eaa96fb74788616abea1eee6b62d27c715d8`. This checkpoint is backend/integration correctness only: no UI, branding, migration, provider or commerce change. Migrations 001â€“039 are byte-for-byte unchanged (`git diff -- supabase` is empty).

**Defect 1 â€” wrong assessment response authority (confirmed and fixed).** The learner action `saveControlledAssessmentResponse` called `recordAssessmentResponse`, which invoked only the legacy `public.record_assessment_response`. Migration 029 makes that function refuse every Commercial V1-governed attempt, so a governed learner could start an assessment but never save an answer. This was reproduced before the fix: 18 of the new 22 database-backed tests failed against the unmodified source.

`recordAssessmentResponse` in `src/server/assessments.ts` is now the single server-owned composition boundary. It always calls the governed `record_commercial_v1_assessment_response` first and routes to the legacy writer only on that RPC's explicit `NOT_COMMERCIAL_V1_GOVERNED` answer. Every other outcome (success, `EXPIRED`, `RESPONSE_WINDOW_CLOSED`, `ATTEMPT_NOT_ACTIVE`, `NOT_FOUND_OR_FORBIDDEN`, `IDEMPOTENCY_CONFLICT`, `INVALID_INPUT`), a transport error or an unrecognised result is final and never falls back. The legacy writer is now a private function with exactly one call site. The routing signal is removed from the returned type, and the browser supplies only the four existing form fields (a hostile `isCommercialV1`/`writer` field is ignored and never forwarded). Governed-first is side-effect safe by migration 029's own structure: for a non-governed attempt the governed RPC proves ownership and returns before any finalisation, insert or audit write, and a non-owner only ever sees `NOT_FOUND_OR_FORBIDDEN`. An attempt's governed status cannot change once it exists, because publishing a grading policy is refused while any attempt history exists on a bound assessment and published policies/bindings are immutable; if it ever did, the legacy RPC would refuse, failing closed. The action now maps `EXPIRED`, `RESPONSE_WINDOW_CLOSED` and `ATTEMPT_NOT_ACTIVE` to specific messages and revalidates on every structured outcome, since a governed `EXPIRED` refusal has already durably committed `AUTO_TIMEOUT`. `src/domain/commercial-v1-assessment-policy.ts` splits `NOT_COMMERCIAL_V1_GOVERNED` into its own union member so the type system, not convention, keeps it inside the boundary; the accepted wire shapes are unchanged. Neither migration 029 boundary was weakened.

**Risk 2 â€” stale ACTIVE governed attempt (confirmed and fixed).** `getStudentAssessments` never called the finalizer, so an expired or administratively closed governed attempt was returned with `state: "ACTIVE"` until some other learner action happened to finalise it (the clock-based `activityState` already reported it as not active, so the UI hid the protected content, but the attempt list was wrong). It now calls the existing `finalize_expired_commercial_v1_attempts` RPC before reading and fails closed if that call fails. That RPC is database-clock only, self-scoped, restricted to bound assessments under a published policy, anchors `submitted_at` to the attempt's own `expires_at` and is idempotent; legacy attempts are untouched (proven). No client-clock logic was added. There is still no scheduler: an attempt is finalised only when a learner request reaches the database.

**Surface classification** (evidence: wrapper/RPC signatures compared, wrapper zod schemas parsed against real RPC output in PGlite, and a search for callers). Backend-complete and callable, with no page, action or route composing them: `bindCommercialV1AssessmentComponent`, `publishCommercialV1GradingPolicy`, `setCommercialV1LabPolicy`, `publishCommercialV1ResultPolicy`, `submitCommercialV1LabWork`, `getCommercialV1CourseProgress`, `attemptCommercialV1CourseCompletion`, `getCommercialV1ActiveAttempt`. `gradeControlledAssessmentAttempt` and `gradePracticalLabSubmission` are backend-complete but not composed, and deliberately must not be auto-wired yet (recovery blocker below). None was found incorrect. The wrappers have no TypeScript-level tests of their own (only the SQL and the grading orchestrator are tested).

**Remaining backend blocker â€” Examiner initial-grade recovery.** `commercial_v1_examiner_executions` has a plain unique index on `attempt_id` and on `submission_id`, so an admitted initial claim occupies its target permanently; a terminal `FAILED`/`TIMEOUT`/`BUDGET_BLOCKED`/`CANCELLED` (and `ESCALATED`) outcome has no result revision, and regrade (migration 032) requires an existing source result. Pre-provider failures such as `NO_PROVIDER_CONFIGURED` also burn the target at zero provider cost, because the adapter is resolved after AUTHORIZE. Automatic submit-to-Examiner orchestration must not be added until a governed recovery authority exists.

Validation (bundled Node v24.19.0): `npm run check` passed lint, route/type generation, TypeScript and **1,972 tests across 93 files**. That is 61 net new tests in three new files (22 database-backed composition, 30 routing/static-guard, 9 action-mapping) on top of the prior 1,911 tests across 90 files (arithmetic, not a separate run). Every pre-existing test still passes; the only pre-existing test file edited is `tests/course-activation-server.test.ts`, whose hand-maintained RPC whitelist gained the two RPCs the composition now reaches. PGlite exercises sequential database behaviour, not independent concurrent connections; hosted acceptance is not claimed.

**Closure (truth-synced from PR25 evidence):** this checkpoint was committed at `7286c65` on `commercial-v1-backend-integrity`, opened as PR #25, passed PR-head CI (`35676062246`) and was merged into `main` at `6b47aa366b77f3aac8166576363fa7edec80dbb7`; post-main CI (`35677545793`) also passed. Both facts independently verified via `gh pr view 25` / `gh pr checks 25` / `gh run list --branch main`, not assumed. The remaining backend blocker (Examiner initial-grade recovery) and the surface classification above stand as this checkpoint's honest handoff to the next one.

## Commercial V1 â€” Examiner Initial-Grade Failure Recovery (Checkpoint A)

Starting branch `commercial-v1-grading-completion`, clean at exact `origin/main` `6b47aa366b77f3aac8166576363fa7edec80dbb7` (PR #25 closed green, independently verified via `gh pr checks 25`/`gh run list --branch main`). Migrations 001â€“039 are byte-for-byte unchanged; the only migration this checkpoint adds is `202609240040_commercial_v1_examiner_initial_grade_recovery.sql`. Full design, the explicit eligibility policy and the Option A/B rejection rationale are in `docs/35-commercial-v1-examiner-initial-grade-recovery.md`; this entry summarises it.

**The problem closed:** migration 031's `commercial_v1_examiner_executions` admits exactly one claim per target, by design. A terminal `FAILED`/`TIMEOUT`/`BUDGET_BLOCKED`/`CANCELLED` initial execution therefore permanently strands its target with no result revision, and migration 032's regrade cannot recover it â€” regrade's source resolver requires an _existing_ result to supersede, and there is none.

**Design:** a separate, dedicated authority (`commercial_v1_examiner_recovery_executions`, `govern_commercial_v1_examiner_recovery`, policy `COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1`), not an extension of regrade â€” reusing the shared reviewed primitives (the controller-key HMAC trust root, migration 030's atomic-finalizer/result-integrity helpers) while keeping identity, protocol tag and unique-claim semantics fully separate from both initial grading and regrade. Eligibility is explicit, not inferred: `FAILED`/`TIMEOUT`/`BUDGET_BLOCKED`/`CANCELLED` originals with no existing result are RECOVERABLE; `ESCALATED` (an explicit human-review determination), `AUTHORIZED`/`RUNNING` (still active) and `SUCCEEDED` (already has a result â€” regrade's job) are NOT RECOVERABLE. Exactly one recovery claim is ever admitted per original execution (`examiner_recovery_one_per_source`, a single-column unique index) â€” if that one attempt also terminates without a result, the target is a durably auditable known-stranded state requiring a future, separately reviewed mechanism, never a second automatic recovery. Recovery reuses the _same_ programme-version `academic_agent_configs` EXAMINER config gate migration 036 added to initial grading (deliberately not regrade's unconditional admin-override model): a disabled/unconfigured capability correctly blocks both initial grading and its recovery through the one toggle an admin controls, and a direct `ESCALATED` claim is created when `escalationPolicy=ACADEMIC_REVIEW`, zero provider calls. Authority is `ACADEMIC_ADMIN`/`PLATFORM_ADMIN` only, re-verified server-side before and after the enrolment lock; recovery accepts only `{sourceExecutionId, reason}` â€” no marks, score, weight, provider/model choice or learner-identity override exists on the input schema. The original failed execution is never mutated; the recovery reason is stored on the protected execution row only, never in generic audit JSON, never in provider context.

`src/server/commercial-v1-examiner-recovery/{authority,context,index}.ts` mirror regrade's module shape for HMAC/table plumbing but `index.ts`'s AUTHORIZE/profile-resolution ordering mirrors initial grading's config-aware `gradeExaminerTarget`: a pre-AUTHORIZE budget proposal never widens what the DB actually admits, and the runtime profile actually executed is re-resolved strictly from the DB-admitted snapshot's own immutable `runtimeProfileRef`. A `providerEntered` flag (found missing during this checkpoint's own runtime tests, then added) distinguishes "the provider was never attempted" (zero usage is truthful) from "the provider was attempted but threw before returning a structured result" (usage is genuinely unknown, so no cleanup FINALIZE is attempted, relying on the DB's own 20-second expiry) â€” closing a real gap where the first implementation would have invented a synthetic zero-usage record for an uncertain provider call.

133 focused tests across four new test files (50 database â€” admission/authority including MAC tampering and anon/service_role ACL denial, target eligibility for every classified terminal state plus config governance, immutability, replay/the one-claim ceiling, finalization for both assessment and lab targets, audit privacy; 32 domain; 29 authority â€” independently transcribing the real 32-field canonical message from the migration's own `verify_command`, never derived from the production signer under test; 22 runtime/orchestration). All pre-existing initial-grading and regrade tests continue to pass unmodified.

Validation (bundled Node v24.19.0): `npm run check` passed lint, route/type generation, TypeScript and **2,105 tests across 97 files** (133 net new on top of the prior 1,972 across 93 files). `npm run build` and `git diff --check` both passed. `format:check` reported only the three pre-existing untouched CRLF-only working-copy files (verified zero diff against `HEAD`), unchanged from the PR25 checkpoint's own documented explanation. PGlite exercises sequential database behaviour and proves the unique-index/replay-ordering guarantees directly; true multi-connection PostgreSQL concurrency remains a Checkpoint D requirement, unchanged from every prior Examiner checkpoint's own documented limitation.

**Remaining backend blockers:** no admin discovery/listing surface exists yet for finding eligible stranded targets (left to a later checkpoint composing the full grading/results chain); automatic submit-to-Examiner orchestration (Checkpoint B) does not exist yet; the results/progress/completion chain (Checkpoint C) is not yet composed with recovery; hosted acceptance (Checkpoint D) is untouched. No hosted provider call was made or attempted.

## Commercial V1 â€” Safe Submission â†’ Examiner Orchestration (Checkpoint B)

Same branch, built directly on Checkpoint A's committed `f407526`. No new migration; this checkpoint composes the existing, already-tested `gradeControlledAssessmentAttempt`/`gradePracticalLabSubmission` initial-grading authorities (backend-complete since PR25 but never called from a submission path) with the existing `submitAssessmentAttempt`/`submitCommercialV1LabWork` submission RPCs. Full design and rationale are in `docs/36-commercial-v1-submission-grading-composition.md`; this entry summarises it.

**The non-negotiable invariant:** a learner's final submission and its Examiner grading are two separate authority boundaries, never one pseudo-transaction. `src/server/commercial-v1-submission-grading.ts`'s `submitControlledAssessmentAndGrade`/`submitPracticalLabWorkAndGrade` always call the existing governed submission RPC first and commit it durably; grading is then attempted as a strictly subsequent, independently-failable step. A learner's submission is never lost, rolled back or left implicit because the Examiner or its provider call fails, times out or is unconfigured â€” proven directly by database tests that force each grading failure mode and assert the submission row still exists, unchanged, afterward.

`orchestrateInitialExaminerGrading` maps the full `ExaminerGradingResult` vocabulary onto exactly four learner-facing outcomes: `GRADED` (fresh or already-graded, replay-safe), `ESCALATED` (a policy-directed human-review determination), `GRADING_PENDING` (a transient `RETRY_LATER`), and `GRADING_UNAVAILABLE` â€” deliberately subsuming both "not configured" and "terminally failed, eligible for admin recovery" because `ExaminerGradingResult` gives no field to distinguish them at this learner-scoped boundary; inventing a distinction the type doesn't honestly carry would have been fabrication, not precision. `GRADING_UNAVAILABLE` never names Examiner, the provider, recovery or any internal state to the learner. Idempotency/replay is proven directly: resubmission attempts and interrupted-then-retried grading never produce a second Examiner claim, relying on the existing one-claim-per-target unique index rather than any new locking.

`src/app/student/actions.ts`'s `finishControlledAssessment` and the new `src/app/student/practicals/actions.ts`'s `submitPracticalLabWorkAction` (plus `src/components/practical-support.tsx`'s new `LabWorkSubmission` component, wired into `src/app/student/practicals/page.tsx`) compose these two functions and append one calm, fixed sentence per non-`GRADED` outcome â€” never a raw Examiner/provider code. The lab submission client uses a deterministic idempotency key (`lab:${enrolmentId}:${practicalId}`) so a duplicate click cannot create a second submission attempt.

**A test-authoring defect found and fixed in this checkpoint (not a production defect):** the mocked FINALIZE handler in `tests/commercial-v1-submission-grading-runtime.test.ts` initially echoed a hardcoded `finalState` regardless of the actual finalize command's `state`/`reason`/`gradeDigest`, which would have let a "malformed provider output" test wrongly pass as a fabricated `SUCCEEDED`. Fixed by making the mock echo the real command's fields, so the test now actually exercises the failure path it claims to.

36 new focused tests: 14 database-backed (`tests/commercial-v1-submission-grading-db.test.ts` â€” submission durability under no-provider/transport-failure grading, replay/idempotency, interruption-recovery, `AUTO_TIMEOUT` preservation, foreign-learner denial, and proof that Tutor/Lab support creates no final-submission row), 9 composition/runtime (`tests/commercial-v1-submission-grading-runtime.test.ts`, mocked at the same boundary as the existing Examiner grading runtime tests), 13 Server Action message-mapping and hostile-extra-field-rejection tests (`tests/commercial-v1-submission-grading-action.test.ts`).

Validation (bundled Node v24.19.0): this checkpoint's own 36 new focused tests pass in isolation. Because Checkpoint C was developed in the same working session before either checkpoint was committed, the full `npm run check` runs used to gate this work were taken with both checkpoints' changes present in the tree simultaneously: lint, route/type generation, TypeScript and **2,146 tests across 101 files**, all passing â€” 41 net new over Checkpoint A's own committed 2,105 across 97 (36 from this checkpoint, 5 from Checkpoint C, committed separately immediately after, see below). `npm run build` passed with the two new/changed practical routes still compiling; `npm run format:check` and `git diff --check` both passed for the combined tree at that point.

**Corrective forward commit (not part of this checkpoint's own scope, reported here for traceability):** building Checkpoint C's fixtures under heavy system load exposed a genuine, reproducible bug in Checkpoint A's already-committed test-only fixture (`tests/commercial-v1-examiner-recovery-fixture.ts`): `seedOriginalExecution`/`seedActiveOriginalExecution` called `clock_timestamp()` separately for `created_at`/`authorized_at` in one INSERT, which migration 031's `check(authorized_at is null or authorized_at=created_at)` requires to be exactly equal; the two evaluations can genuinely diverge under load. Per instruction this was fixed in a dedicated new commit (`e1f6f0d`) rather than by rewriting/amending `f407526`, using a `with stamp as (select clock_timestamp() as t)` CTE to capture one shared timestamp â€” the same pattern the production SQL functions already use. Test-fixture-only; no production code affected; verified 50/50 in isolation and the full 2,146-test suite green afterward.

No admin discovery/listing surface, no hosted provider call and no Checkpoint C composition were added in this checkpoint.

## Commercial V1 â€” Result â†’ Progress â†’ Completion Composition (Checkpoint C)

Same branch, built directly on Checkpoint B's committed `12fd7f5`. No new migration; this checkpoint closes the missing server/action composition around already-backend-complete, already-tested authorities identified by PR25's own surface classification: `bindCommercialV1AssessmentComponent`, `publishCommercialV1GradingPolicy`, `setCommercialV1LabPolicy`, `publishCommercialV1ResultPolicy`, `getCommercialV1CourseProgress`, `listCommercialV1ObjectiveDiagnostics`, `attemptCommercialV1CourseCompletion`. Full design is in `docs/37-commercial-v1-course-lifecycle-completion.md`; this entry summarises it.

None of the audited authorities was found incorrect. No universal pass mark, lab weighting or fuzzy component mapping was invented anywhere in this composition â€” every bound RPC call still takes only the exact same institution-supplied values (`passMarkBp`, `contributionBp`, an explicit `component` enum value) the underlying functions already required.

`src/app/admin/activation/policy-actions.ts` adds four thin Server Actions (`bindComponentAction`, `publishGradingPolicyAction`, `setLabPolicyAction`, `publishResultPolicyAction`) composing the four policy-publication authorities. **Corrected in the independent-review checkpoint below**: at this checkpoint's original completion these were unreferenced by any page and untested as Server Actions -- both since fixed (see that section). `src/app/student/progress/page.tsx` (new route) and `src/app/student/progress/actions.ts` compose the learner-facing side: a minimal progress page rendering the bounded `getCommercialV1CourseProgress`/`listCommercialV1ObjectiveDiagnostics` projection (component/lab FINALIZED-or-PENDING status, weighted contribution, course score, published pass mark, open remediation count), plus `src/components/course-completion-form.tsx` wrapping the new `attemptCourseCompletionAction`, which composes the existing deterministic `attemptCommercialV1CourseCompletion` gate â€” every eligibility check (all six components graded, published pass mark, remediation clearance if required) is evaluated server-side from persisted, immutable state; the browser supplies only the enrolment id, and repeated presses on an already-completed enrolment return the existing receipt rather than erroring or duplicating it.

`tests/commercial-v1-course-lifecycle.test.ts` (5 tests) proves result/progress/diagnostics/completion integration over valid, authoritative result state through the real server functions against real PGlite: a fully graded course reaches `courseScoreBp: 10000` and `attemptCommercialV1CourseCompletion` returns `COMPLETED` with a receipt, then idempotently `ALREADY_COMPLETED` with the identical receipt on replay (exactly one `commercial_v1_completion_receipts` row); `COMPONENTS_INCOMPLETE` when any component/lab lacks a current result; `BELOW_PASS_MARK` when the score is under the published threshold, leaving the enrolment `ACTIVE`; a foreign learner is denied both progress reads and completion attempts with the same bounded `NOT_FOUND_OR_FORBIDDEN`, never leaking existence; an admin can read another learner's progress via the existing staff-read allowance. How each component's result was produced is deliberately out of this test's scope (Checkpoints A and B already prove the Examiner finalizer and submissionâ†’grading composition exhaustively, each in its own dedicated suite, and no live provider exists in this environment) â€” results are seeded the same test-owner way `commercial-v1-examiner-regrade-fixture.ts`'s own `seedResult` already does, an established pattern in this codebase. **This is not a single integrated submit â†’ Examiner grade â†’ progress â†’ completion traversal across Checkpoints A/B/C** â€” no such test exists; this test's job is proving progress/diagnostics/completion compose correctly over real, validly-produced results.

Validation (bundled Node v24.19.0): this checkpoint's own 5 new course-lifecycle tests pass in isolation. A full `npm run check` re-run on the complete tree (now including this checkpoint's own remaining changes) again passed lint, route/type generation, TypeScript and **2,146 tests across 101 files** â€” unchanged from the count above, since this checkpoint's one new test file was already present in the working tree for that measurement (developed in the same session before either checkpoint was committed). `npm run build` passed with the new `/student/progress` route compiling; `npm run format:check` and `git diff --check` both passed.

**Known limitations at this checkpoint's original completion (corrected below):** no admin picker UI for binding components/practicals (the four Server Actions existed but had no TypeScript-level test of their own -- only the underlying RPCs and grading orchestrator were tested -- and no page referenced them; see the independent-review correction checkpoint). Still true: no learner UI showing individual question-level detail, only the bounded progress/diagnostics projection; remediation resolution/reconciliation itself is unchanged (migration 030's existing authority) â€” this checkpoint only reads the resulting open-remediation count; no hosted provider call was made or attempted.

## Commercial V1 â€” Independent-Review Correction Checkpoint

Same branch, built directly on Checkpoint C's committed `8cc82fc`. An independent review of the complete `origin/main...HEAD` patch found the Checkpoint A/B/C core architecture sound enough to preserve unchanged (separate INITIAL_RECOVERY authority, one recovery claim per original execution, immutable original failed execution, distinct HMAC protocol, same EXAMINER config governance, no arbitrary marks/admin score input, atomic revision-1 result finalization, durable submission before provider-backed grading, grading failure cannot roll back submission, replay recovers submissionâ†’grading interruption, no automatic initial-grade recovery by learner, deterministic result/progress/completion) but found four concrete issues that had to be corrected before push/PR. Migrations 001â€“040 remain byte-for-byte unchanged; the only migration this checkpoint adds is `202609240041_commercial_v1_grading_chain_review_corrections.sql`. Commits `f407526`, `e1f6f0d`, `12fd7f5`, `8cc82fc` were not amended.

**Finding 1 â€” recovery authority was not operationally reachable.** `recoverControlledAssessmentGrade`/`recoverPracticalLabGrade` (migration 040) existed and were fully governed, but no bounded admin discovery surface existed for finding an eligible stranded target, and no application/admin action invoked either entrypoint â€” an ACADEMIC_ADMIN/PLATFORM_ADMIN could not actually recover a real failed target without database access. Closed by: a private view (`commercial_v1_recovery_private.stranded_targets`) joining terminal-eligible original executions to any existing recovery claim, exposed through two admin-gated, MAC-free read RPCs (`list_commercial_v1_examiner_recovery_targets`, `get_commercial_v1_examiner_recovery_target`) returning bounded operational metadata only (identifiers, target kind/capability/component-or-practical, original terminal state/reason/timestamp, and a five-value `recoveryStatus`: `ELIGIBLE`/`RECOVERY_IN_PROGRESS`/`RECOVERED`/`RECOVERY_ESCALATED`/`RECOVERY_EXHAUSTED` â€” never a learner response body, answer key, marking guidance, provider output, the recovery claim's own stored reason text, or a MAC); `src/server/commercial-v1-examiner-recovery/operations.ts`'s `recoverExaminerTarget` â€” the ONE composed institutional recovery action, accepting only `{sourceExecutionId, reason}` (the exact same `recoveryInputSchema` Checkpoint A already validated, reused verbatim) â€” resolves the target's capability/targetKind strictly from a fresh `get_commercial_v1_examiner_recovery_target` read and dispatches internally to the correct existing entrypoint; the browser has no field through which to choose targetKind/capability/provider/model/marks, and even a caller bypassing the schema in TypeScript could not smuggle one through, since routing is read only from that one authoritative lookup. A minimal admin page (`src/app/admin/activation/recovery/page.tsx` + `actions.ts` + `src/components/examiner-recovery-form.tsx`) lists eligible/stranded targets with safe status metadata, lets an admin supply a bounded reason and trigger the one allowed recovery, and shows the resulting safe status â€” no manual SQL, no copying internal IDs out of an audit log (the source id is a hidden form field populated from the server-rendered list). Linked from `/admin` ("Examiner grade recovery").

**Finding 2 â€” the four Checkpoint C policy Server Actions were unreferenced.** `bindComponentAction`/`publishGradingPolicyAction`/`setLabPolicyAction`/`publishResultPolicyAction` (`src/app/admin/activation/policy-actions.ts`) had no importing page, and the file's own comment referenced a nonexistent "accompanying page"; the prior claim that they were "reachable without manual SQL" was not yet true, and they had no TypeScript-level test of their own. Closed with the minimal operational surface (the review's preferred path over merely walking the claim back): a new bounded read, `get_commercial_v1_policy_setup_options` (migration 202609240041), returns one activation's real, materialised assessments (with any current component binding), practicals (with any current lab policy), and grading/result policy publication state â€” so an admin never types an assessment/practical UUID blind â€” and a new admin page (`src/app/admin/activation/policy/page.tsx` + `src/components/policy-setup-forms.tsx`) drives all four actions from real `<select>` options. No weight, pass mark, or component identity is inferred anywhere; every value the four RPCs already required is still the only thing the browser supplies. The activation id itself is still typed once into the page (identical to how `importId` already works on `/admin/activation`) â€” a full activation picker is out of this checkpoint's scope, since the existing, separately-reviewed activation flow does not itself surface a new activation's id anywhere yet; documented honestly as a remaining, unrelated gap rather than silently absorbed into this correction. `tests/commercial-v1-policy-setup-db.test.ts` (7 tests) exercises the actual Server Actions end to end against real PGlite â€” bind â†’ publish grading policy â†’ set lab policy â†’ publish result policy â€” plus a hostile foreign-assessment-id denial and a learner-denial case, not merely their underlying RPCs. Linked from `/admin` ("Commercial V1 policy setup").

**Finding 3 â€” execution-timeout audit source was misclassified.** Migrations 031, 032 and 040 each classified an `audit_events` row's `source` column as `case when reason_code='EXECUTION_TIMEOUT' then DATABASE_EXECUTION_POLICY else ATTESTED_EXECUTION_CONTROLLER end` â€” conflating two structurally different events that both happen to carry that reason code: a genuine DB-owned lazy-expiry sweep (`state='TIMEOUT'`, correctly `DATABASE_EXECUTION_POLICY`) versus a controller-attested FINALIZE reporting the runtime/provider itself observed a timeout (`state='FAILED'`, `reason_code='EXECUTION_TIMEOUT'` â€” a MAC-verified transition exactly like every other FINALIZE outcome, wrongly classified as database-only). Migration 202609240041 `create or replace`s all three trigger functions (`commercial_v1_examiner_private.audit_execution`, `commercial_v1_regrade_private.audit_execution`, `commercial_v1_recovery_private.audit_execution`) to classify on `state` instead of `reason_code`; `create or replace` preserves each function's OID, so the existing triggers pick up the correction with no trigger DDL. Forward-only: no historical `audit_events` row is rewritten, and no content/privacy field is added anywhere. 10 new regression tests (`tests/commercial-v1-examiner-audit-provenance.test.ts`) prove, for all three tables: a DB-owned lazy-expiry TIMEOUT â†’ `DATABASE_EXECUTION_POLICY`; a controller-attested FAILED/EXECUTION_TIMEOUT â†’ `ATTESTED_EXECUTION_CONTROLLER` (the exact case that was wrong before); a normal SUCCEEDED/FAILED transition retains `ATTESTED_EXECUTION_CONTROLLER` (regression, unaffected).

**Finding 4 â€” test/documentation wording overclaims, corrected with no behaviour change.** (A) `tests/commercial-v1-examiner-recovery-db.test.ts`'s test named "a genuinely concurrent AUTHORIZE for the same source never creates two rows" actually performs two sequential inserts under PGlite's single connection; renamed to "the unique source-claim index rejects a second recovery row for the same source", with an explicit comment that true concurrency remains a Checkpoint D requirement. (B) `tests/commercial-v1-course-lifecycle.test.ts` and `docs/37-...md` described the Checkpoint C integration test as "the end-to-end deterministic backend course lifecycle" / "the full deterministic backend chain" â€” reworded, in the test file, `docs/37-...md` and this file, to "result/progress/diagnostics/completion integration over valid, authoritative result state", with an explicit sentence that this is **not** a single integrated submit â†’ Examiner grade â†’ progress â†’ completion traversal across Checkpoints A/B/C (no such test exists). (C) The claim that the four policy Server Actions were "tested"/"reachable" is corrected above (Finding 2) now that they actually are, with a real test exercising the actions themselves. (D) Docs 35â€“38 and this file were re-read for statements affected by these four findings only; no unrelated history was rewritten.

**Validation** (bundled Node v24.19.0): 53 new focused tests across four new files â€” 20 database-backed admin recovery-read tests (`tests/commercial-v1-examiner-recovery-operations-db.test.ts`: admission/authority, eligibility agreement with the governed policy, recovery-claim status distinguishing `ELIGIBLE`/`RECOVERY_IN_PROGRESS`/`RECOVERED`/`RECOVERY_ESCALATED`/`RECOVERY_EXHAUSTED`, and privacy minimisation including an exact-key-set assertion), 16 composition tests (`tests/commercial-v1-examiner-recovery-operations-action.test.ts`: input contract, hostile-field rejection, server-owned routing dispatch to the correct existing entrypoint, replay), 10 audit-provenance regression tests, 7 policy-setup tests exercising the actual Server Actions. `npm run check` passed lint, route/type generation, TypeScript and **2,199 tests across 105 files** (53 net new on top of Checkpoint C's 2,146 across 101). `npm run build` passed with both new admin routes (`/admin/activation/policy`, `/admin/activation/recovery`) compiling. `npm run format:check` and `git diff --check` both passed (only the same three pre-existing, untouched CRLF-only files warn, unchanged since the PR25 checkpoint).

**This checkpoint does not itself claim CLOSED GREEN.** Per its own instruction, it is at most **LOCAL REVIEW GREEN**: all corrections and full local gates pass, but PR-head CI, merge and post-main CI have not run. No hosted or billable operation was attempted. No migration 001â€“040 was rewritten; no prior commit was amended.

## Commercial V1 â€” Live Provider Acceptance Harness

Branch `commercial-v1-live-provider-acceptance` from `origin/main` `6827ddd`. Builds the harness only: **zero real OpenAI/Anthropic requests were made**, zero migrations were added or modified, and no production profile, model id, tariff, budget policy, provider endpoint, HMAC protocol, grant/RLS, grading/finalization rule or existing Examiner acceptance behaviour was changed.

**What exists.** `npm run acceptance:live-provider` (`scripts/acceptance/live-provider.mjs`) reports exactly two surfaces, `LIVE_PROVIDER:OPENAI_EXAMINER` (`EXAMINER_COMMERCIAL_V1` / `OPENAI_RESPONSES` / `gpt-5.6-luna`, `EXAMINER` / `grade_controlled_assessment`) and `LIVE_PROVIDER:ANTHROPIC_LAB` (`LAB_INSTRUCTOR_COMMERCIAL_V1` / `ANTHROPIC_MESSAGES` / `claude-sonnet-5`, `LAB_INSTRUCTOR` / `tutor_lab_support`). A billable request requires BOTH `ACCEPTANCE_LIVE_PROVIDER_OPT_IN` exactly `true` AND the `--authorize-live-provider` flag; without both, no server starts and zero requests are made. With both, a surface whose own key is absent BLOCKS alone. Each authorized surface is requested once (no script retry, no probe; provider retry only as the production profile allows, `maxAttempts` 1).

**Why a real Next.js route rather than an MJS reimplementation.** OpenAI/Anthropic request construction, response schemas, tariffs, failure mapping, budget/deadline enforcement and Examiner parsing/validation already have production owners in TypeScript. The script therefore builds no provider request: it starts `next dev` on loopback and calls the acceptance-only route, whose server driver reaches `resolveRoleBoundRuntimeProfile` â†’ `resolveAdapterForProfile` â†’ `runGovernedProviderExecution`, then the existing `parseExaminerAssessmentProviderOutput`/`validateExaminerAssessmentMarks`. The route accepts only `{operation: OPENAI_EXAMINER_SMOKE | ANTHROPIC_LAB_SMOKE}` (strict; provider/model/profile/endpoint/key/budget/context/role/capability/prompt fields are 400). The expected profile/adapter/model, OpenAI reasoning effort and exact execution envelope are pinned (the envelope pin was added by correction V2 below); a drift in any of them fails closed as `PROFILE_MISMATCH` before any call. The Lab smoke uses the production profile's budget directly; the production Tutor/Lab path clamps that budget to `TUTOR_LAB_EXECUTION_DB_CEILING`, which is the identity for this profile (a test pins that).

**Gate** (`liveProviderAcceptanceRequestAllowed`, before the body is read; 404 otherwise): driver-enabled flag, fresh per-run 64-hex token with constant-time comparison, non-production `NODE_ENV`, opt-in exactly `true`, propagated operator authorization, no examiner-app driver/stub-redirect marker in the process (stubbed traffic can never be reported as live), loopback `APP_URL` and Host, no `Origin`/`Sec-Fetch-Site`. It does not reuse or modify the examiner-app redirect-attestation gate.

**Child secret minimisation** (`buildLiveProviderChildEnv`): refuses to build without double authorization; blanks the acceptance DB URL/write flag/environment id, identities, `ACADEMIC_EXECUTION_*`, `STRIPE_*`, `COMMERCE_CONTROLLER_*`, legacy `ACADEMIC_PROVIDER_*`, Supabase URL/keys, `NODE_OPTIONS`, every other inherited credential-shaped name, and every name defined in any `.env*` file Next.js could load (empty strings are never overridden by Next's loader â€” verified in `@next/env`); passes only the key(s) for the authorized, key-present surfaces. Child output is not forwarded.

**Evidence** is metadata only (adapter/profile/model, runtime outcome + bounded code, Examiner `GRADED`/`ESCALATE`, strict-parse and marks-validation booleans, Lab output length, calls/attempts/tokens/estimated cost/elapsed, within-envelope). The driver re-validates every field against a closed vocabulary before printing and prints the total provider requests made. Raw model output, provider bodies, synthetic answer/guidance, parsed marks and keys are never returned or printed. A PASS establishes LIVE-PROVIDER-TESTED for that surface only â€” not production readiness or model quality.

**Stale-assumption corrections.** docs/38 section 5, `scripts/acceptance/env.mjs` and `surfaces.mjs` described `ACADEMIC_PROVIDER_BASE_URL`/`ACADEMIC_PROVIDER_API_KEY` as the Commercial V1 provider configuration; that has been untrue since PR22. Preflight now knows `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` and labels `ACADEMIC_PROVIDER_*` as the legacy `HTTP_JSON` gateway (kept: `resolveConfiguredProvider` still legitimately exists). `liveProviderOptedIn()` now means only "opt-in exactly `true`" (keys play no part). `acceptance:hosted`'s `LIVE_PROVIDER` row is always BLOCKED and points at the dedicated command; it no longer reads `--authorize-live-provider` and can never make a paid request.

**Validation** (bundled Node v24.19.0): `npm run check` passed lint, route/type generation, TypeScript and **2,606 tests across 114 files** â€” 73 new tests in two new files (`tests/acceptance-live-provider-route.test.ts` 52: gate refusals incl. body-not-read, strict input, exact profile resolution, mocked OpenAI/Anthropic through the real adapters/runtime, strict parse/marks/ESCALATE, bounded failures without retry, post-call budget block, per-provider key BLOCK, no-leak, static no-duplication guard; `tests/acceptance-live-provider-driver.test.ts` 21: double authorization, per-surface key blocking, fake-app runs with exactly one request per surface, evidence sanitisation, child-env minimisation, env-file names, and a real unauthorized CLI spawn), plus one net new test in `tests/acceptance-harness.test.ts`, whose live-provider gating block was rewritten for the native keys. All tests use fakes; none reaches a vendor. `npm run build` passed (`/api/acceptance/live-provider` compiles as a dynamic route). `git diff --check` passed, and every file this checkpoint changed or added passes Prettier. `npm run format:check` itself exits 1 in this worktree only because of six untouched files (`.github/workflows/ci.yml`, `tsconfig.json` and four `content/courses/security-plus-sy0-701/*.json`) whose committed blobs are LF and pass Prettier but whose working copies were checked out with CRLF (`core.autocrlf=true` with `text=auto`); they are unchanged relative to HEAD and were deliberately not touched. `npm run acceptance:live-provider` (unauthorized) returned both surfaces BLOCKED / `EXPLICIT_AUTHORIZATION_REQUIRED` with "Provider requests made by this invocation: 0" and started no server. An additional zero-traffic check against a real `next dev` child built by the driver's own env builder with NO provider key confirmed the gate admits the driver's token, refuses a wrong token and a browser `Origin` (404), rejects an extra `model` field (400), and returns BLOCKED `RUNTIME_ABSTAINED_NO_PROVIDER_CONFIGURED` with `providerCalls=0` on the exact production profiles for both operations.

**Independent-review correction V2** (same uncommitted checkpoint): (1) V1 pinned only profile ref/adapter/model, so a registry drift such as `maxAttempts` 2 could have allowed a second billable request before the harness noticed, contradicting the "drift fails before any call" statement. Each plan now also pins the OpenAI reasoning effort and the exact execution envelope (`maxProviderCalls` 1, `maxAttempts` 1, `maxOutputTokens`, `maxEstimatedCostMicrousd`, `totalDeadlineMs`); any mismatch returns `PROFILE_MISMATCH` / `NOT_EXECUTED` / `providerCalls=0` before `resolveAdapterForProfile` or `runGovernedProviderExecution`. Tariffs remain unpinned and registry-owned. (2) A PASS must now prove exactly one provider request: `providerCalls === 1` and `attempts === 1`, enforced at the server verdict boundary and independently in the MJS evidence consumer (V1 only rejected more than one). (3) The synthetic Lab context used the Tutor-only reason `PRACTICAL_PREREQUISITE`; it now uses `PRACTICAL_HELP`, typed against the existing `TUTOR_LAB_ALLOWED_REASONS.LAB_INSTRUCTOR` authority (no second allowlist). (4) `readEnvFileNames` silently skipped an unreadable env file; it now throws `EnvFileInspectionError` (file name only) when an existing `.env*` file cannot be read or decoded as strict UTF-8, and the authorized run BLOCKS as `ENV_FILE_NOT_INSPECTABLE` before Next.js starts, with zero provider requests. It also enumerates dotenv's `export NAME=` / `NAME: value` line forms, which Next.js accepts but `node:util` `parseEnv` may not (over-matching only blanks an extra name). No production file changed. V2 validation: 26 new tests (18 in `tests/acceptance-live-provider-route.test.ts`: envelope pins equal the current registry, eight drift cases incl. `maxAttempts`/`maxProviderCalls` 2 and OpenAI reasoning effort proven to reach no adapter/runtime/provider, PASS with `providerCalls`=0 or `attempts`=0 is FAIL, 1/1 PASS, >1 FAIL, `PRACTICAL_HELP` tied to `TUTOR_LAB_ALLOWED_REASONS`; 8 in `tests/acceptance-live-provider-driver.test.ts`: consumer PASS 0/0/1/>1 rules, readable env names incl. colon/export forms blanked, a directory `.env.local` and a non-UTF-8 `.env.development` each BLOCK before startup with zero requests and no contents reported). `npm run check` passed with **2,632 tests across 114 files**; `npm run build` passed; `git diff --check` passed (including new files); `npm run format:check` still fails only on the same six untouched CRLF-checkout files; unauthorized `npm run acceptance:live-provider` again reported both surfaces BLOCKED with 0 provider requests.

**Limitations.** Not executed: the authorized paid run. Running `next dev` (this harness or `acceptance:examiner-app`) regenerates the tracked `next-env.d.ts`; restore it with `git checkout -- next-env.d.ts` afterwards. No configuration was persisted; keys are never written to any file.

## Commercial V1 â€” Stripe Test-Mode Acceptance Harness

Branch `commercial-v1-stripe-test-acceptance` from `main` `e592691`. Builds the harness only: **zero real Stripe requests and zero payments were made**, zero migrations were added or modified, and no commerce authority, fulfillment/entitlement semantics, payment-event schema, campaign pricing, reviewer-complimentary semantics, Stripe endpoint/API choice, card-only scope, provider idempotency key, public webhook behaviour, HMAC protocol, RLS or auth was changed. No production commerce source file was modified.

Status: **STRIPE TEST MODE â€” 7 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN.** Merged by PR #36 (`ec5eb71`). The authorized operator run of `npm run acceptance:stripe -- --authorize-stripe-test` passed all seven surfaces: `STRIPE_TEST:CHECKOUT_BINDING`, `STRIPE_TEST:REDIRECT_NOT_PAYMENT_PROOF`, `STRIPE_TEST:SIGNED_WEBHOOK_FULFILLMENT`, `STRIPE_TEST:DUPLICATE_WEBHOOK_IDEMPOTENCY`, `STRIPE_TEST:RECONCILIATION_REPLAY`, `STRIPE_TEST:REVIEWER_COMPLIMENTARY` and `STRIPE_TEST:ZERO_PRICE_PROMO_GUARD`. Evidence boundary: a genuine Stripe TEST-mode Checkout Session for the synthetic GBP 1.00 amount with `livemode=false`; the unpaid redirect granted no access; the genuine `checkout.session.completed` test-mode event was retrieved; missing/invalid signatures were rejected and the validly signed event was accepted through the unchanged production webhook route; the order became FULFILLED with exactly one PAID payment event, one `PAID_ORDER` entitlement and one ACTIVE enrolment; duplicate-event and reconciliation replays were idempotent; reviewer complimentary access created no commercial order/payment event; non-reviewer zero-price campaign forms were rejected. This is not live-money acceptance, public Stripe webhook network-delivery evidence, production deployment evidence, refund/dispute/subscription evidence or production readiness. The paragraphs below describe the harness as built and are otherwise unchanged; `acceptance:hosted`'s `STRIPE_TEST_MODE` row deliberately still never calls Stripe and points at this dedicated command.

**What exists.** `scripts/acceptance/stripe.mjs` reports seven surfaces â€” `STRIPE_TEST:CHECKOUT_BINDING`, `:REDIRECT_NOT_PAYMENT_PROOF`, `:SIGNED_WEBHOOK_FULFILLMENT`, `:DUPLICATE_WEBHOOK_IDEMPOTENCY`, `:RECONCILIATION_REPLAY`, `:REVIEWER_COMPLIMENTARY`, `:ZERO_PRICE_PROMO_GUARD` (docs/38 section 6). A run requires BOTH `ACCEPTANCE_STRIPE_TEST_OPT_IN` exactly `true` AND `--authorize-stripe-test`; no other argument is accepted; a live-mode-shaped key is refused regardless of flags; Stripe must report `livemode=false` before any write. It starts `next dev` on loopback and reaches the EXISTING `createCommercialV1Checkout` / `reconcileCommercialV1Order` through the new acceptance-only route `src/app/api/acceptance/stripe-app/route.ts` (strict `SIGN_IN` / `CREATE_CHECKOUT` / `RECONCILE_ORDER`) behind its own fail-closed gate `src/server/stripe-acceptance-driver.ts`; webhook legs POST to the unchanged production `/api/commerce/stripe-webhook`. The operator makes one manual Stripe-hosted sandbox payment with a documented test card; the genuine `checkout.session.completed` test-mode event is then retrieved from Stripe and signed locally with stripe-node's `generateTestHeaderString`, so the run proves the application webhook boundary, not Stripe's network delivery to a deployed endpoint. Fixtures reuse `seedAcceptanceCourse` unchanged (the foreign synthetic learner is the seeded enrollee; the acceptance learner is the unenrolled buyer). The commerce controller key is verified read-only (probe MAC) and never provisioned.

**Broad matrix.** `acceptance:hosted`'s `STRIPE_TEST_MODE` no longer passes on `balance.retrieve()` connectivity: it is always `BLOCKED`, never calls Stripe, and points at the dedicated command. `env.mjs` gains `ACCEPTANCE_STRIPE_TEST_OPT_IN` and `stripeTestOptedIn()`; `ACCEPTANCE_STRIPE_LIVE_OPT_IN` remains reserved and never authorizes the new command.

**Validation** (bundled Node v24.19.0): 159 new focused tests â€” `tests/acceptance-stripe-driver.test.ts` (95: double authorization, live-key refusal, argument fail-closed without echo, child-env minimisation, uninspectable `.env*` BLOCK, controller-key ABSENT/MISMATCH, an honest in-memory production-semantics backend passing all seven surfaces with one operator prompt, and dishonest variants proving each surface FAILs or BLOCKs â€” second session, amount/livemode drift, unpaid access, unsigned/forged signature acceptance, duplicate event, reviewer order, accepted zero-price promo, partial (unexhausted) session/event listings, unconfirmed/unobserved payment, external fulfillment â€” plus Stripe object/event validators, the official signing helper, operator prompt and CLI behaviour), `tests/acceptance-stripe-route.test.ts` (61: every gate refusal with body unread, strict-schema rejection of caller-supplied amount/currency/ids/provider/key/HMAC/URL/function, only the two production entrypoints called), and 3 net new cases in `tests/acceptance-harness.test.ts` (the broad surface never calls Stripe). `npm run check`: lint, route/type generation, TypeScript and **2,849 tests across 116 files** passed. `npm run build` passed.

**Independent-review correction V2** (same uncommitted checkpoint): (1) the Checkout Session duplicate check and (2) the completion-event lookup now walk Stripe's `starting_after` cursor (100 per page, at most 10 pages, same code-owned `created>=` bound) and may claim "exactly one" only from an exhausted listing (`has_more=false`); a cap reached with `has_more` still true BLOCKS (`CHECKOUT_SESSION_SCAN_NOT_EXHAUSTED` / `COMPLETION_EVENT_SCAN_NOT_EXHAUSTED`) and a duplicate on any page FAILs; (3) the stale "no hosted provider has passed live acceptance" wording in the scope boundary below is corrected to the reconciled evidence; (4) the broad `STRIPE_TEST_MODE` row reports only the `sk_test_`/`sk_live_` prefix, not a strict test-key shape; (5) `GITHUB_PAT` is withheld from the child by name; (6) sandbox instructions require synthetic, non-personal customer details; (7) reviewer-complimentary evidence claims only the absence of commerce order/payment rows, not an independently observed absence of Stripe sessions.

**Limitations.** The authorized operator run has since been executed (status above). Stripe cannot reach a loopback app, so public webhook delivery remains production deployment/operational acceptance. A browser signed in to the local app as the buyer, or a Stripe webhook endpoint delivering to an app bound to the acceptance database, would fulfil the order first; the driver then reports `BLOCKED` (`ORDER_FULFILLED_OUTSIDE_THIS_RUN`) rather than claiming evidence. Each run permanently adds two run-tagged acceptance courses/offers, one reviewer campaign and the resulting institutional history to the acceptance database.

## Commercial V1 â€” Concurrency Race Harness (LATE_INITIAL / REGRADE_VS_COMPLETION)

Branch `commercial-v1-concurrency-race-harness` from `main` `ec5eb71`. Replaces the two honest `NOT_RUN` placeholders in `npm run acceptance:concurrency` with real implementations. Status: merged by PR #37 (`0e43d54`) and **HOSTED-TESTED** â€” hosted acceptance run `1790606638430-8qftcb` produced **6 PASS / 0 FAIL / 0 BLOCKED / 0 NOT_RUN** (observed `REGRADE_VS_COMPLETION` serial order: `COMPLETION_FIRST`; client-side simultaneous release with a valid resulting state, not proof of simultaneous server-transaction overlap). No migration, production source file (`src/**`), authority module, HMAC protocol, RLS/grant, the 20-second Examiner execution lease, enrolment/completion locking, regrade/recovery eligibility, provider budget or commerce semantics changed; no live provider request was made.

**Why they are distinct from `NEVER_TWO_REVISION_ONES`.** That scenario races two raw privileged transactions against the revision-number unique index. The new `scripts/acceptance/concurrency-app-races.mjs` drives the real Ducelio app server (the section 4a acceptance route, loopback deterministic provider stub and genuine hosted sessions), so every AUTHORIZE/START/CONTEXT_READ/FINALIZE transition is attested only by the unmodified `src/server/commercial-v1-examiner-*/authority.ts`; the scripts sign nothing and write no race row directly. `LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE` exercises the execution state machine (lease expiry â†’ replay-driven lazy `TIMEOUT` â†’ refused late FINALIZE) against the one-claim-per-source recovery authority; `REGRADE_VS_COMPLETION` exercises the real regrade FINALIZE against the real completion RPC on one enrolment and accepts only the two legitimate serial orders (details in docs/38 section 2).

**Hold points (acceptance tooling only).** `examiner-provider-stub.mjs` gains explicit one-shot holds (`holdNextProviderResponse()`, `holdNextContextRead()`: arrival promise, explicit release, settled outcome `RESPONDED`/`CLIENT_ABORTED`/`CANCELLED`; teardown cancels every hold so neither the driver nor a parked request can hang; a hold cancelled before arrival never captures a later request). With no hold armed the stub answers exactly as before, and `planFailure()` is unchanged. Source inspection showed the `EXAMINER_COMMERCIAL_V1` profile's provider deadline (`totalDeadlineMs` 15,000) is shorter than migration 031's DB lease (20 s): a provider-only hold would make the runtime abort and FINALIZE `FAILED` while the lease was still live, so the late-FINALIZE race could never be reached that way. The preload therefore gains an optional, driver-only hold on delivery of the already-served `get_commercial_v1_examiner_assessment_context` response (asked of a per-run-token loopback control endpoint after the RPC completes; the response is never read or altered). It is enabled only when the concurrency driver sets both `ACCEPTANCE_CONTEXT_HOLD_URL`/`_TOKEN` in its own child (`buildAppChildEnv` forces both empty otherwise, and the preload refuses a half configuration). The only timed wait is for the genuine DB lease to pass.

**Admission windows (independent-review correction).** The initial-grading, recovery and regrade authorities each refuse a fresh admission once the learner has 5 claims in the last 60 s or 30 in the last hour, and both races reuse the one synthetic acceptance learner, so recent acceptance activity can legitimately exhaust a window. Waiting for live leases (`waitForStudentLeasesClear`, unchanged) does not cover that. Each race now reads the exact production window counts for the families it needs (late-initial: initial + recovery; regrade-vs-completion: initial + regrade) against the hosted database clock before any fresh grading, and re-reads the recovery/regrade family immediately before that admission. An exhausted window reports the race **BLOCKED** with the family and count/window â€” never FAIL, never an hour-long wait. The check is read-only; admission history is never reset, deleted, backdated or bypassed, and the production limits are unchanged.

**Reuse.** `examiner-app.mjs`'s startup (prerequisites, controller-key check, stub, fail-closed child, readiness, app sign-ins) is extracted into `openExaminerAppSession()`, used by both `runExaminerAppAcceptance` (behaviour and messages unchanged) and the races. `seedAcceptanceResults` gains `excludeComponents` so the regrade source is a real graded QUIZ_1 result with real answered responses, never a response-less seeded attempt. `createStartGate` moved to the race module and is re-exported by `concurrency.mjs`.

**Validation** (bundled Node v24.19.0): 61 new tests in `tests/acceptance-concurrency-app-races.test.ts` (stub hold arrival/release, one-shot and pre-release semantics, teardown without hanging, client abort, unchanged default and `planFailure()` behaviour, the context-hold control token, wrapper exactness with no provider escape, preload configuration, child-env forcing, BLOCKED/FAIL mapping of an unavailable session, both pure verdicts across coherent and torn states, and behavioural orchestration of both races through the real stub holds with in-memory app/database stand-ins, including dishonest variants that must FAIL), 11 more for the admission-window correction (the exact production SQL and 5/30 thresholds; each family exhausted up front or at the re-check reports BLOCKED before any fresh grading, recovery or regrade; counts just below both limits still PASS; only read-only queries are issued), and 5 new route-refusal cases in `tests/acceptance-examiner-app-route.test.ts` (race/hold fields and operations are rejected 400). `npm run check`: lint, route/type generation, TypeScript and **2,926 tests across 117 files** passed (one earlier full run hit a single timing-sensitive failure in the untouched `tests/commercial-v1-examiner-audit-provenance.test.ts`, which passed 3/3 in isolation and in the next full run). `npm run build` passed with the Supabase pair neutralised for the build process (see KNOWN FAILURES above). Not run: the hosted mutating concurrency acceptance.

**Limitations.** The late-initial race necessarily waits ~20 s for the real lease; a slow `next dev` first compile is covered by bounded (90 s) arrival waits that FAIL rather than hang. Evidence that the late original FINALIZE was attempted is indirect (its provider response was delivered after the lease and the invocation returned `GRADING_UNAVAILABLE` while the database kept `TIMEOUT`); the refused FINALIZE itself leaves no row. Each run permanently adds two more run-tagged acceptance courses and their institutional history.

## Commercial V1 â€” FULL_CUSTOMER_JOURNEY hosted staged acceptance harness

Branch `commercial-v1-full-customer-journey` from `main` `0e43d54`. Replaces the misleading `acceptance:hosted` placeholder (which inferred FULL_CUSTOMER_JOURNEY from other surfaces' statuses) with a dedicated, explicit, operator-run, mutating command, `npm run acceptance:journey` (`scripts/acceptance/customer-journey.mjs`). `acceptance:hosted` now always reports `FULL_CUSTOMER_JOURNEY` as `NOT_RUN` with a pointer to that command. Status: **IMPLEMENTED / LOCAL-TESTED; NOT YET RUN HOSTED.** No migration, production authority, HMAC protocol, RLS/grant, lease, rate limit, idempotency, completion, grading, Stripe/commerce or provider-governance rule changed; the concurrency harness (`concurrency-app-races.mjs`) is untouched and evidence-frozen.

**Architecture.** The journey reuses the section 4a real-application session (`openExaminerAppSession({ journey: true })`): the real Next.js app on loopback, genuine hosted Supabase sessions for the learner, a foreign learner and the admin held as the app's own SSR cookies, a deterministic loopback provider stub attested live per request, and every other AI-vendor request refused in the app process. Journey mode (all opt-in; defaults unchanged for examiner-app/concurrency) adds: stub answers for the Professor classroom read, Tutor support, Lab Instructor support over the Anthropic Messages contract (the redirect forwards the exact Anthropic URL to the same loopback stub only when the journey child sets `ACCEPTANCE_JOURNEY_DRIVER_ENABLED`) and Examiner lab grading; `planZeroMarks()`/`clearPlans()` one-shot controls; journey fixture options (reviewed Professor/Tutor/Lab/Examiner configurations, 2-minute durations, strictly sequential 3-minute windows via a separate `journeyAssessmentWindows`). A new acceptance-only route, `src/app/api/acceptance/customer-journey/route.ts`, gated by `src/server/acceptance-journey-driver.ts` (journey marker + the unchanged examiner-app gate), exposes a finite strict union of thin hops into existing production entrypoints: `createCommercialV1Checkout` (the driver supplies only the REVIEWER_COMPLIMENTARY code it provisioned, and the app child withholds Stripe/commerce credentials, so no Stripe request is made or claimed â€” the route schema itself does not establish campaign kind), `src/server/delivery.ts`, `openProfessorClassroom` + the learner Professor Server Actions, `requestDeliveryHandoff`/`requestPracticalSupportAction`/`requestTutorLabSupportAction`, `startAssessmentAttempt`/`getStudentAssessments` (ids and max marks only)/`recordAssessmentResponse`, `submitPracticalLabWorkAndGrade`, `getCommercialV1CourseProgress`, `attemptCommercialV1CourseCompletion`. Sign-in, controlled-assessment submission/grading and recovery reuse the examiner-app route unchanged.

**Evidence rules.** Access is the reviewer-entitlement variant (a governed `REVIEWER_COMPLIMENTARY` campaign); paid checkout/webhook replay stay separate STRIPE TEST MODE evidence. No entitlement, enrolment, attempt, response, submission, execution, revision, receipt or audit row is written directly for the journey learner, and `seedAcceptanceResults` is not used; `seedAcceptanceCourse`'s single enrolment is the foreign learner's (negative paths only). Every surface is verified read-only against the hosted database. Nine `FULL_JOURNEY:*` surfaces plus the `FULL_CUSTOMER_JOURNEY` aggregate (PASS only if all PASS; FAIL if any FAIL; else BLOCKED). The positive stages are strictly chained â€” ACCESS â†’ DELIVERY â†’ CLASSROOM â†’ TUTOR_LAB â†’ ASSESSMENTS â†’ RECOVERY â†’ LAB â†’ PROGRESS_COMPLETION â€” so any non-PASS stage leaves every later positive stage BLOCKED and unexecuted, and a broken journey writes no further assessment, lab or completion history; RECOVERY only reports the result captured when ASSESSMENTS reached `MIDTERM` (BLOCKED if never reached), and NEGATIVE_REPLAY evaluates the accumulated ledger at the end. Negative/replay coverage: access/classroom/Tutor-Lab/response/submission/lab/completion replay, foreign-learner denial on delivery, Tutor handoff, response, submission, lab, progress and completion, incomplete-result and below-pass completion refusal (the foreign learner's genuinely graded zero-score result set), provider-unavailable fail-closed, and a terminal initial grade recovered by an institutional admin. Production admission-window refusals are observed as the product reports them (Examiner: `GRADING_PENDING` with no claim; Professor/Tutor/Lab: a persisted `BLOCKED/RATE_LIMITED` row) and reported BLOCKED â€” no capacity is pre-computed.

**First hosted run (`1790630225143-vf2w0i`) and correction.** ACCESS, DELIVERY and CLASSROOM PASSed; FULL_JOURNEY:TUTOR_LAB FAILed and every later positive stage was correctly BLOCKED. Root cause (a production defect, not a harness artefact): `public.request_delivery_handoff` (migration 023) accepted `OBJECTIVE_REINFORCEMENT` with a NULL objective and persisted a learner-owned TUTOR handoff, but migration 028's `begin_tutor_lab_content_release` correctly refuses that shape with `INVALID_INPUT`, so the owner's Tutor support ended `UNAVAILABLE` before any provider execution or provider call. Correction: migration `202609280043_delivery_objective_reinforcement_handoff_invariant.sql` replaces the RPC (same signature, body, idempotency, limits, destinations, summaries and ACL) adding only `INVALID_INPUT` for `OBJECTIVE_REINFORCEMENT` without an objective, before any handoff row is created; the domain `handoffInput` enforces the same rule. No table CHECK was added and the immutable invalid acceptance handoff from that run is untouched (it remains unconsumable, as before). The journey now resolves the fixture lesson's one real objective read-only during setup and requests the Tutor handoff with it, asserting lesson and objective on the durable row. The same run's harness also falsely reported that the foreign learner reached the Tutor handoff: that check had counted the owner's own missing execution as a foreign breach. `FOREIGN_TUTOR_LAB_DENIED` now snapshots the handoff's reservations/executions before and after the foreign probe and fails only on the probe's own status or rows it added (or any non-owner row), with evidence-specific wording.

**Hosted run #2 (`1790635594309-jz55ep`) and correction.** With migration 043 applied hosted, ACCESS, DELIVERY, CLASSROOM and TUTOR_LAB PASSed (the migration 043 correction is hosted-tested). FULL_JOURNEY:ASSESSMENTS FAILed. Read-only forensics: the journey learner's only ACTIVE attempt was this run's QUIZ_1 attempt (created 22:52:50 UTC, 0 responses, now expired and still ACTIVE because nothing has read or finalised it since; untouched); no stale or legacy attempt existed; all six bindings were PUBLISHED with one question each; every constituent SELECT of `getStudentAssessments` succeeds under the learner's RLS. Root cause, proven by an anonymous zero-row PostgREST probe: `assessments` has no foreign key to `programme_versions` (only composite FKs to cohorts and lessons), so hosted PostgREST refuses `getStudentAssessments`' select with `HTTP 400 PGRST200`; every call failed and the acceptance route answered `500 OPERATION_FAILED`. The harness mislabelled the failed pre-start read as a question release (no release occurred) and collapsed the post-start failure into one generic mismatch. Corrections: `getStudentAssessments` selects `programme_version_id` and reads `programme_versions(id,label,title_snapshot)` separately under RLS, failing closed if a snapshot is missing; while the server reports `CONTROLLED_ASSESSMENT_ACTIVE`, a protected-question read error now fails closed instead of rendering a submittable attempt with no questions; the harness distinguishes route failure, unexpected active attempt and genuine question release before start, and reports each post-start mismatch separately (bounded HTTP status and route code only). Local test doubles never resolved embeds like PostgREST, which is why this was not caught; a new test checks every embed `getStudentAssessments` requests against the real migrated FK graph. The same unresolvable `programme_versions` embed exists in `getAssessmentWorkspace`, the assignments reads and several `learning-resources` reads (hosted-probed PGRST200 for `assignments` and `lessons`); those are out of this correction's scope and need their own reviewed fix. Also noted, unchanged: `getStudentAssessments` lists at most the 100 earliest-opening in-scope assessments, so a learner with more than 100 (the synthetic acceptance learner has 120) does not see their newest course's assessments in that list.

**Limitations.** No hosted PASS yet; a run takes roughly half an hour because the six assessment windows must be strictly sequential, and a setup that overruns the first window reports BLOCKED. The delivery study plan has no learner Server Action in the product today, so that step calls the governed `src/server/delivery.ts` functions directly. The classroom is a just-past ClassSession (`CATCH_UP`) to reduce â€” not eliminate â€” the risk of colliding with another run's session for the shared acceptance instructor; a fast rerun after an interrupted run can still overlap, and the governed scheduling RPC's refusal is then reported BLOCKED. Professor/Tutor/Lab/Examiner output is stubbed â€” not live-provider or quality evidence. Each run permanently adds one run-tagged course, offer, reviewer campaign, class session and the resulting institutional history.

## Dependency security remediation (2026-10-01)

Branch `security/dependency-advisories-oct-2026` from `main` `b504d6a`. Dependency-only change; no application source, migration, RLS, auth or configuration change.

- `next` 16.3.4 â†’ 16.3.8 (production) and `eslint-config-next` 16.3.4 â†’ 16.3.8 (dev), exact pins. Motivated by critical advisory GHSA-vcvr-r3jv-pc5j (Remote Code Execution in `next/og` `ImageResponse`, affected `16.2.0 - 16.3.5`). No currently identified application path uses the affected API: the repository has no `ImageResponse`, `next/og`, `opengraph-image`, `twitter-image`, `generateImageMetadata` or `icon`/`apple-icon` metadata route, and the built server app references no `ImageResponse`. The framework was upgraded regardless.
- `brace-expansion` (high: GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p), dev-only transitive: 1.1.18 â†’ 1.1.21 (via `eslint` / `minimatch@3.1.5`) and 5.0.9 â†’ 5.0.12 (via `typescript-eslint` â†’ `@typescript-eslint/typescript-estree` â†’ `minimatch@10.2.6`), resolved within the parents' existing ranges with `npm update brace-expansion`; no override, new direct dependency or `--force`.
- `npm audit`: 2 vulnerabilities (1 high, 1 critical) â†’ 0. `npm audit --omit=dev`: 1 critical â†’ 0.

Local validation with Node 24.19.0: `npm run check` passed (lint, route/type generation, TypeScript, 3166/3166 tests across 124 files); `npm run build` passed on Next.js 16.3.8 (webpack, proxy compiled); `git diff --check` passed. `npm run format:check` locally flags seven files only because `core.autocrlf=true` checks them out with CRLF; all are LF in git, the six not touched here are unchanged, and the LF-normalised `package.json`/`package-lock.json` pass Prettier. PR CI is still required. Next action: complete PR review/CI, then continue performance benchmarking on the patched framework.

## Commercial V1 checkpoint 1 â€” admin control-plane foundations (2026-10-01)

Branch `feat/admin-control-plane-foundations` from `main` `be2cf01`. First checkpoint of the backend-first roadmap. Migration `202610010044_admin_control_plane_foundations.sql` (the next free number; additive, no row deleted or rewritten). Full design, RPC table and limitations: docs/39.

**Implemented.** People (PLATFORM_ADMIN only): `admin_list_people`, `admin_set_staff_profile`, `admin_grant_role`, `admin_revoke_role`, `admin_set_account_status`. Staff roles only (INSTRUCTOR, COUNSELLOR, ACADEMIC_ADMIN, REGISTRAR, PLATFORM_ADMIN); STUDENT stays signup-provisioned; a staff profile is required first. `app_users.account_status` (default ACTIVE) and `current_app_user()` now resolve ACTIVE accounts only, so deactivation removes all RLS/RPC authority while preserving identity, grants and history; the app identity layer treats it as signed out (`/login?error=account-inactive`). Database-enforced refusals: last usable PLATFORM_ADMIN (`LAST_PLATFORM_ADMIN`), self-lockout (`SELF_LOCKOUT`), COUNSELLOR revoke with active assignments; one advisory lock serializes people mutations. Cohorts (ACADEMIC_ADMIN/PLATFORM_ADMIN, never REGISTRAR): `status` OPEN/CLOSED/COMPLETED, optional `ends_on`/`capacity`; `admin_create_cohort` (published non-demo versions, idempotent), `admin_update_cohort` (start date locked once enrolled/activated), `admin_change_cohort_status` (closing archives published offers atomically), `admin_cohort_workspace`, `admin_cohort_roster`; triggers keep closed/completed cohorts from new enrolments/orders/offers (honouring still-PENDING paid orders) and completed cohorts from activation, and freeze completed cohorts for every writer. Audit uses the existing `audit_change` trigger (now also on `staff_profiles`) plus bounded explicit account-status and close-driven offer-archive rows. UI: `/admin/people`, `/admin/cohorts` (replacing the Cohorts placeholder), grouped role-filtered admin navigation (Academy records / Control plane); the Announcements placeholder is gone. The acceptance fixture now creates its cohort through `admin_create_cohort` instead of privileged SQL.

**Independent-review corrections (2026-10-02, amended into migration 044 before any hosted application).** (1) The enrolment guard no longer honours any `PENDING` order: only verified paid fulfilment passes, via a transaction-local marker set by an `AFTER INSERT` trigger on `commercial_v1_payment_events` (written only by `fulfill_commercial_v1_order` after HMAC verification) plus durable PAID evidence matching the order's session/amount/currency, for the same learner/cohort/version. A negative control (marker disabled) makes both paid-fulfilment tests fail with `COHORT_NOT_OPEN`/`COHORT_FULL`. (2) A `DEACTIVATED` account can no longer become a new instructor (activation, class session, assignment, assessment) or counsellor target for any writer (`STAFF_DEACTIVATED`); existing relationships are untouched and the People directory reports live teaching / active counselling counts for reassignment; `list_assignable_instructors`, `list_assignable_counsellors` and `get_course_activation_options` offer ACTIVE staff only (the latter also omits completed cohorts). (3) `INSTRUCTOR` revocation is refused while the person is the activation instructor of a non-completed cohort or holds a scheduled session of one (`ACTIVE_TEACHING_ASSIGNMENTS`); completed history does not block it and a refusal writes no audit row.

**Ordinary workflows that still need SQL.** Only the very first PLATFORM_ADMIN bootstrap of a new environment. Auth-user creation remains self-signup / identity-provider provisioning by design (no service-role use in application code).

**Validation** (Node 24.19.0): new `tests/admin-control-plane-db.test.ts` (29: People authority, RPC-only tables, last-admin/self-lockout, deactivation/reactivation authority and preserved history, cohort authority/validation/capacity/start-lock/lifecycle/audit, real commerce close/archive/order/offer guards, verified-paid-only fulfilment exception (unpaid pending, spoofed marker, unrelated learner, UNPAID claim, closed and full cohorts, idempotent replay), completed-activation guard, deactivated-staff target refusal/reactivation/kept history, INSTRUCTOR continuity, end-to-end 14-step workflow), `tests/admin-control-plane-ui.test.ts` (25: pages, controls, Server Actions through the real server layer, refusal surfacing, navigation exposes only real routes), `tests/identity-account-status.test.ts` (3); `tests/acceptance-harness.test.ts` updated (direct-SQL cohort assertions replaced by governed-RPC assertions). `npm run check`: lint, route/type generation, TypeScript and **3222/3222 tests across 127 files** passed (after the independent-review corrections). `npm run build` passed (no `.env.local`). `npm audit`: 0 vulnerabilities. `git diff --check` passed. `npm run format:check` flags only the same seven untouched files as before (`git ls-files --eol`: `i/lf w/crlf`; their committed blobs pass Prettier); every changed file passes.

**Configuration / deployment.** Apply migration 044 to the hosted acceptance project before the next `acceptance:*` run (the fixture calls `admin_create_cohort`). No new environment variable, dependency or secret.

**Limitations.** See docs/39: no Auth-user creation; deactivation does not revoke live refresh tokens (the session just resolves to no actor); no reassignment workflow exists for an activation's instructor (activations are immutable), so revoking that INSTRUCTOR requires completing the cohort; assignment/assessment instructor references are not counted as live teaching; a verified paid checkout started while open is honoured after close/complete and may exceed capacity (reconciliation/seat reservation is the later commerce checkpoint); completion does not yet block other workflows from scheduling new sessions/coursework for that cohort; hosted acceptance of migration 044 not run. Unrelated findings were not fixed here.

## P0 Academic Operations — human academic review / manual first grade (2026-10-02)

Branch `feat/academic-review-operations` from `main` `339b28e`. Migration `202610020047_commercial_v1_human_academic_review.sql`, additive; migrations 001–046 unchanged. Design, eligibility, authority, provenance and limitations: docs/40.

**Implemented.** A separate institutional authority for result-free targets the automated chain cannot grade: initial `ESCALATED` Examiner executions, escalated recoveries and exhausted recoveries. Only a fresh `ACADEMIC_ADMIN`/`PLATFORM_ADMIN` may list cases, read one protected case context, and record a manual first grade (per-question assessment marks, or one lab mark, plus a bounded reason). The database resolves every identity and policy value from the case id. It locks the learner then the enrolment, re-checks authority, self-review and result-freeness under lock, and writes revision 1 through the unchanged migration 030 guards, derivation helpers and validators. It records an append-only `commercial_v1_academic_review_decisions` row and a `HUMAN_ACADEMIC_REVIEW` audit event. Repeat or late submissions return `ALREADY_RESOLVED`; no second revision 1 is possible. The result provenance CHECK is not weakened, and no Examiner/recovery execution row is mutated. The recovery worklist now reports `RESOLVED_BY_ACADEMIC_REVIEW` for a human-resolved recovery; this is a view-only change. `/admin/academic-review` is in the control-plane navigation, and the recovery page links escalated and exhausted rows to their case.

**Validation** (Node 24.19.0). Focused suites:

- `tests/commercial-v1-academic-review-db.test.ts` (15): worklist eligibility/exclusions, protected context, role ACL including anon/service_role, self-review refusal, every assessment mark refusal, exact authoritative revision 1, provenance/audit, idempotent repeat, database backstops, append-only decisions, downstream progress, regrade source acceptance, lab grading, recovery status truth and immutable executions.
- `tests/commercial-v1-academic-review-ui.test.ts` (13): page, actions and server layer through the real server code.
- `tests/admin-control-plane-ui.test.ts`: navigation list updated.
- Independent-review correction: the TypeScript contracts no longer cap questions, marks or lab objectives at 100 (only the SQL-backed 200-case worklist bound remains). 101-item regressions cover the contracts and server path. `tests/commercial-v1-academic-review-policy-db.test.ts` (3) proves the authoritative 100-question bound, exact per-question validation at that maximum, and the explicit post-withdrawal first-grade policy (result valid, enrolment stays WITHDRAWN, completion refused `ENROLMENT_NOT_ACTIVE`).

`npm run check`: lint, route/type generation, TypeScript and **3368/3368 tests across 137 files** passed. `npm run build` passed (no `.env.local`). `npm audit`: 0 vulnerabilities. `git diff --check` passed. `npm run format:check` flags only the same seven untouched CRLF-checkout files (`i/lf w/crlf`); every changed file passes.

**Limitations.** Deterministic single-connection (PGlite) tests only; no multi-connection PostgreSQL race and no hosted acceptance of migration 047 was run. The review is not blind. No reviewer assignment, moderation or second-marker workflow exists. Corrections after the first grade use the existing regrade authority.

## Commercial V1 Academic Results Operations (2026-10-02)

Branch `feat/academic-results-operations` from `main` `5179822`. Migration `202610020048_commercial_v1_academic_results_operations.sql`, additive; migrations 001–047 unchanged. Design, authority, provenance, correction semantics and limitations: docs/41.

**Implemented.** `/admin/academic-results`, for `ACADEMIC_ADMIN`/`PLATFORM_ADMIN` only, in the control-plane navigation after Academic review.

- **Read RPCs (database-owned).** Bounded, server-filtered discovery of assessment and lab result revisions:
  - 50 per page;
  - filters: learner name/number, kind, cohort, programme version, component, practical, current vs historical, completion.
  - Result detail: marks, score, weight, contribution, current/valid state, per-question marks (positions only), objective outcomes and remediation, revision history bounded to the newest 100 revisions (`historyHasMore`; older revisions remain in the paginated all-revisions listing), the revision's existing outgoing regrade claim (`regradeClaim`, bounded metadata only), and truthful provenance. Provenance covers human academic review (047), regrade (032), recovery (040), initial Examiner (031), or `UNATTRIBUTED` when no claim references the revision.
  - Enrolment record with the completion receipt.
  - The reads return no prompts, answer keys, guidance, responses, submission bodies, digests, MACs, budgets or audit JSON.
- **Reused authorities.** Progress is the canonical `get_commercial_v1_course_progress`. Correction reuses the existing regrade (id + reason only; kind, current and valid state re-read from the database). Completion reuses the existing `attempt_commercial_v1_course_completion`.
- **Prohibited operations.** Voiding or excluding a current result is prohibited: an invalid or excluded highest revision makes the target PENDING with no authority able to fill it. No correction-request table was added.
- **Own record.** A learner-admin cannot see or act on their own record (`SELF_RECORD_FORBIDDEN`). A new insert guard refuses any regrade execution whose actor is the learner (`SELF_REGRADE_FORBIDDEN`), which tightens migration 032.
- **Indexes.** Partial indexes on the three execution tables' `result_revision_id`.

**Validation** (Node 24.19.0). Focused suites:

- `tests/commercial-v1-academic-results-db.test.ts` (32), primary fixtures use real governed paths: recovery → revision 1, a real HMAC-attested regrade → revision 2, a 047 human review, and an initial-claim invalid revision. Covered:
  - role ACL, including INSTRUCTOR/COUNSELLOR/REGISTRAR/STUDENT/learner/unauthenticated/deactivated admin, anon/service_role privileges and the closed private schema;
  - every filter and bound, and malformed input;
  - provenance for all four origins, revision history and current/historical state;
  - an invalid current revision staying PENDING in canonical progress;
  - protected-content non-leakage;
  - append-only refusals for the owner and admin sessions;
  - regrade replay and invalid-source refusal;
  - learner-admin self-record and self-regrade refusal;
  - independent-review correction: a 102-revision legitimate lab-chain stress fixture, constructed by the DB-owner test harness through the unchanged migration-030 result insert guards and objective derivation, returns exactly the newest 100 with `historyHasMore`; no guard or validator is disabled or weakened; the 100-revision boundary returns `historyHasMore=false`; revision 1 still loads; every revision stays listed, present and valid;
  - outgoing regrade claims through the real regrade governance: none, SUCCEEDED (linked to the produced revision), RUNNING, terminal FAILED and terminal ESCALATED. Terminal claims stay visible after reload with bounded fields only, and a direct replay creates no second execution or revision;
  - ACTIVE/PAUSED enrolment truth, and that a read never completes;
  - admin completion refusal.
- `tests/commercial-v1-academic-results-ui.test.ts` (29): page, actions and server layer through the real server code and the real progress/completion wrappers, with stubbed identity/transport/regrade orchestration. Covered:
  - navigation;
  - filter parsing;
  - which controls render for current/historical/invalid/PAUSED/completed states;
  - id-and-reason-only regrade posting, ignoring forged fields;
  - assessment vs lab routing;
  - refusals;
  - completion delegation;
  - strict-schema rejection of protected fields;
  - static migration boundaries;
  - truncated-history notice and refusal of an over-bound history payload;
  - regrade form only when no claim exists; RUNNING, expired RUNNING, FAILED, ESCALATED and BUDGET_BLOCKED claims show durable state without a form or a false human-resolution path; SUCCEEDED links the produced revision; the action refuses an existing claim (`REGRADE_CLAIM_EXISTS`) without calling regrade;
  - the `APPEND-ONLY RESULTS · GOVERNED OPERATIONS` label.
- `tests/admin-control-plane-ui.test.ts`: navigation list updated.

Focused total: 86/86. The existing regrade (74) and academic-review suites (DB 15, policy 3, UI 13) also pass with migration 048's regrade-table guard. `npm run check`: lint, route/type generation, TypeScript and **3429/3429 tests across 139 files** passed. `npm run build` passed (no `.env.local`), including `/admin/academic-results`. `npm audit`: 0 vulnerabilities. `git diff --check` passed, and the new untracked files have no trailing whitespace or CR line endings. `npm run format:check` flags only the same seven untouched CRLF-checkout files (`i/lf w/crlf`); every changed file passes.

**Limitations.** Deterministic single-connection (PGlite) tests only. No multi-connection PostgreSQL concurrency acceptance and no hosted Supabase/PostgREST acceptance of migration 048 was run. Discovery is not load-tested. Regrade remains provider-backed and keeps its one-claim-per-source semantics: a current revision whose claim failed or escalated cannot be regraded again, and no authority resolves an escalated regrade (shown truthfully, not fixed here). Detail history is read-bounded to the newest 100 revisions. Operators see learner names (not blind).

## Commercial V1 Academic Session Operations (2026-10-02)

Branch `feat/academic-session-operations` from `main` `da6e4bb`. Migration `202610020049_commercial_v1_session_operations.sql`, additive; migrations 001–048 unchanged. Design, authority and limitations: docs/42.

**Implemented.**

- Immutable, atomic cancel-and-replace rescheduling.
- Activation-scoped explicit session batches: 100 items per request, with additional requests permitted.
- The independent-review corrections:
  - a private classroom BEFORE INSERT parent lock and recheck that refuses missing or CANCELLED sessions;
  - closing effective-ACL assertions on table, column, schema/helper and public-RPC privileges;
  - navigable 200-activation and 250-lesson pages with an independent selected-activation projection.
- OPEN and CLOSED cohorts are allowed and COMPLETED is refused. Cohort dates remain metadata.

**Closure.** Independently reviewed; committed as `380d6ab`; merged by PR #53 into `main` at `d6bf283`. PR CI passed (run 37046895265) and post-merge `main` CI passed (run 37049593392).

**Validation (pre-merge, local).**

- Focused tests 105/105 (64 DB, 34 server/action, 7 UI).
- Regressions 277/277 across 17 suites.
- Full check: lint, types and 3,534 tests across 142 files.
- Production build passed.

**Limitations.** Hosted effective-ACL / JWT / PostgREST acceptance, real PostgreSQL multi-connection concurrency (including the original-start/classroom boundary), browser/accessibility acceptance and hosted pagination/session-operation acceptance have not run. Recurrence and cohort-date teaching constraints remain out of scope.

## Agent / Model control: AGENT-CONTROL-1 (2026-10-05)

Branch `feat/agent-model-control` from `main` `d6bf283`. Migration `202610050050_agent_configuration_governance.sql`, additive; migrations 001–049 unchanged. Design, policy, evidence and the approved follow-on checkpoints (AC-2 to AC-7): docs/43.

AC-1 is foundation work only. It makes the current agent and model state truthful and stops published or enrolled academic configuration from being silently rewritten. It adds no AI behaviour, prompt, handoff, class note, classroom memory or Sarah runtime, and changes no provider or model assignment. Agent / Model and Behaviour work is not complete.

## Admin control centre, corrective checkpoint and local release qualification (2026-10-21)

Branch `feat/admin-control-centre` from `main` `040bce6`. **Uncommitted; awaiting review.** No migration, hosted database change, credential or payment configuration change. The public website is unchanged.

**Control centre.** Five workspaces: Dashboard `/admin`, Courses `/admin/courses` (with `/admin/courses/[packageKey]`), Operations Engineer `/admin/operations-engineer`, Sales & Commerce `/admin/sales` and Academy Operations `/admin/academy`. The former `/admin?section=…` URLs redirect into Academy Operations with their filters. Every figure comes from an existing governed read; a failed source is shown as unavailable, never as zero.

**Corrective checkpoint.**

- **Access.** The failed People refusal was a genuine, correct authorisation refusal (service and database both deny an academic administrator), shown as an error page.
  - Every sensitive admin page now starts with `adminWorkspaceAccess` (`src/server/admin-access.ts`) before reading anything:
    - signed out: redirected to `/login`;
    - no administrative role: redirected to `/login?error=forbidden`;
    - an administrator without the page's role: an in-shell refusal that loads nothing.
  - Services and RLS still enforce independently.
  - The activation pages are now `force-dynamic`, so the guard runs per request.
- **Sign-in destination.**
  - Without an explicit destination, password and callback sign-in send administrators to `/admin`, learners to `/student` and counsellor-only accounts to `/support`. This is chosen from the account's own role grants (`src/server/sign-in-home.ts`).
  - The return-destination allowlist is unchanged and still rejects `/admin`.
- **Operations Engineer execution.**
  - When `perform()` throws, the outcome is decided by re-reading the records:
    - change confirmed: SUCCEEDED, "not applied twice";
    - change confirmed absent: FAILED;
    - re-read itself fails: UNCERTAIN, with "do not retry yet".
  - The in-memory guards are documented as per-instance only, not idempotency. Each proposal states its cross-instance duplicate protection.
- **Test records.**
  - Dashboard, Courses, Sales and Operations Engineer lists separate acceptance-test and staging records from business figures, and show the excluded counts with the naming rule (`src/domain/admin-test-records.ts`).
  - The orders and exceptions registers are labelled as operational registers that include test traffic.
  - Settled revenue is still not reported.

**Local release qualification.**

- **Operations Engineer duplicate protection, checked against each governed RPC.**
  - Database-protected, enabled:
    - publish offer: unique index on one published offer per activation, and unique slug;
    - create campaign: unique code;
    - archive campaign: row lock, and the campaign must be ACTIVE.
  - Only partly protected, now **disabled in the Operations Engineer** (`OPERATIONS_ENGINEER_DISABLED`):
    - `archive_commercial_v1_offer` takes no row lock, so two simultaneous calls each write an audit event;
    - `run_course_package_test` inserts a run on every call;
    - cohort status (`admin_change_cohort_status`): stale-proposal replay, below.
  - For each disabled change, prepare and execute both refuse before any state read, the AI interpreter is not offered it, and the console links to its dedicated form, which is unchanged.
  - An invariant test ties the disabled set to the "partial" protection level.
- **Cohort status stale-proposal replay (fixed by disabling).**
  - A close proposal bound only to the current status became executable again after OPEN → CLOSED → OPEN within its 15-minute lifetime. A temporary test, removed after the run, reproduced it against the previous code: the same proposal, confirmed again on a fresh instance after a reopen, executed a second time.
  - No reliable revision exists without a migration:
    - `cohorts` has no version, `updated_at` or status-change timestamp, and `admin_cohort_workspace` exposes none;
    - the per-update audit events are readable by platform administrators only (RLS), so academic administrators cannot use them as change evidence without widening that boundary;
    - archiving a cohort's offer on close is monotonic, but only when the cohort has a published offer.
  - Cohort status is therefore disabled in the Operations Engineer. The Cohorts workspace (`/admin/cohorts`, `admin_change_cohort_status`) is unchanged.
  - Regression tests cover: no proposal and no read; OPEN → CLOSED → OPEN replay on a fresh instance; repeated confirmation with altered contents in every state; a stale proposal refused before any check; and no AI path.
- **"Already applied" is now exact.**
  - Publish offer matches the delivery, slug, price and currency.
  - Create campaign matches the offer, kind, limit, window and price.
  - A different offer or campaign that won a race is reported as FAILED, never as this proposal's success.
- **Operations Engineer choice lists** put real records first and label acceptance-test records.
- **Course detail section bar** wraps instead of hiding sections in a sideways scroll. It is no longer sticky below 960 px.

**Validation (local).**

- **`npm run check`:** lint and typecheck clean; 4,693 tests passed and 14 skipped, across 200 files.
  - The 14 skipped are the two real-PostgreSQL concurrency suites.
  - The suite includes the access matrix (112 cases: 7 actor kinds × 16 pages, each refusal checked to load nothing), sign-in destination, test-record split, and the Operations Engineer failure modes:
    - unauthorised actor, missing or invalid input, unsupported action;
    - altered, stale and expired proposals;
    - duplicate and simultaneous confirmation;
    - cross-instance replay and race, race lost to a different record;
    - partial failure, verification-read failure, unreadable state;
    - missing AI provider, and disabled actions.
- **`npm run format:check`:** passed.
- **`npm run build`:** compiled. In this worktree the build also loads an untracked, gitignored `.env.local` (acceptance-environment values, not created by this work), whose `APP_URL` is plain HTTP.
  - With that file present, prerendering `/student` stops at the existing production guard "Configured production authentication requires an HTTPS APP_URL" (`src/lib/env.ts`, unchanged from `main`).
  - With an HTTPS `APP_URL` in the process environment, as on a hosted deployment, the build passes and all 16 admin routes are dynamic.
- **Real PostgreSQL concurrency: NOT RUN.** No local PostgreSQL server, Docker or WSL distribution is installed, and installing one was out of scope. `DUCELIO_TEST_POSTGRES_URL` is therefore unset and the two suites (14 tests) skipped.
- **Browser runs against the hosted acceptance backend, read-only.** No operation was confirmed and no hosted record was changed.
  - Development server: 116/116 checks.
  - Production build (`next start` behind a local TLS front, HTTPS `APP_URL`): 125/125 checks, covering:
    - anonymous, learner and non-admin staff refusals on 16 admin routes;
    - sign-in destinations, safe return destinations, session persistence, and Secure/HttpOnly/SameSite=Lax session cookies;
    - six learner pages;
    - all workspaces, tabs and technical pages;
    - the People refusal, not-found and empty states;
    - the Security+ SY0-701 revision 6 lifecycle;
    - the six Operations Engineer reads, and one proposal prepared and discarded unconfirmed;
    - keyboard focus and keyboard selection;
    - layout at 1366, 820 and 390 px, with no console errors.
  - Only the acceptance ADMIN (academic administrator), LEARNER and UNRELATED_STAFF accounts exist. Registrar, platform administrator, instructor and counsellor are covered by the unit matrix only.
- **Security+ SY0-701 revision 6** (read-only) shows exactly the expected state:
  - Import, validation, configuration, test and curriculum publication complete;
  - delivery activation is the next action;
  - offer and public catalogue blocked;
  - its only cohort ("ecurity+ SY0-701 — Staging Acceptance", a hosted data typo) is flagged staging/acceptance;
  - no re-upload is requested.

**Required before production (not done here).**

- **Durable cross-instance at-most-once execution** (required to re-enable archive offer and course test runs in the Operations Engineer).
  - The table: `operations_engineer_executions`, holding `proposal_id` (unique), `actor_id`, `action_id`, `input_hash`, `status` (PENDING/DONE/FAILED), `claimed_at` and `finished_at`.
  - Two RPCs, admin-only, under RLS:
    - a claim RPC (`INSERT … ON CONFLICT DO NOTHING RETURNING`) called before execution;
    - a finish RPC, with a recovery path for stale PENDING claims.
  - Acceptance tests: two simultaneous claims on real PostgreSQL produce exactly one execution and one audit event; a stale claim is recovered; RLS denies other roles.
- **Proposal binding.** The proposal ID is an unkeyed integrity hash. It stops altered or stale confirmations, but it is not an authorisation token. Authority is the server-side role check plus re-validation.
- **Cohort status revision** (required to re-enable cohort status in the Operations Engineer; not created).
  - The migration: `cohorts.status_revision bigint not null default 0`, incremented by the existing `guard_cohort_lifecycle` trigger path on every status change.
  - It must be exposed in `admin_cohort_workspace`, and `admin_change_cohort_status` needs an optional `p_expected_revision` that refuses `STALE_REVISION` when it does not match. The row is already locked `FOR UPDATE`.
  - The proposal fingerprint would include the revision.
  - Tests: the revision is monotonic across OPEN → CLOSED → OPEN; a stale revision is refused in the database; a concurrent change on real PostgreSQL refuses the loser.
- **Missing database support.**
  - A recorded test/purpose flag for programmes, cohorts and offers, to replace the naming rule.
  - A reviewed settled-revenue aggregate: verified PAID payment events minus refunds, per currency and period.
  - Organisation tenancy.
- **Not yet exercised.**
  - The AI interpretation path. It needs `ANTHROPIC_API_KEY` on the server; no local key exists. Without it the page states "AI interpretation not configured" and every typed operation still works.
  - Hosted environment values (Vercel): there is no `vercel.json` or `.vercel` locally, and no new environment variable is required by this work.
  - REGISTRAR and PLATFORM_ADMIN in the browser (no acceptance accounts exist; covered by the unit matrix).
- **Hosted state, left unchanged as instructed.** The 15 published acceptance-test offers remain published and visible in the public catalogue.

**Next action.** Owner review of the local diff. On approval: commit, open the release PR and run CI, including the dedicated real-PostgreSQL concurrency job.

## Current scope boundary

**Correction pass (independent review):** this section previously stated "No AI academic actor is integrated," which is no longer accurate now that a real, governed PROFESSOR execution path, a real learner-facing classroom UI and a real reviewed production runtime profile (`PROFESSOR_COMMERCIAL_V1`) all exist and are wired together end to end. Its later wording "no hosted provider has yet passed live acceptance" is also stale. Since PR22, Commercial V1 routes natively through `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (the `ACADEMIC_PROVIDER_*` pair is only the legacy generic gateway, used by no current production profile); without a key `resolveAdapterForProfile` returns `null` and execution fails closed to `NO_PROVIDER_CONFIGURED`. As recorded in the 2026-09-27 evidence reconciliation (docs/38 section 5), exactly three surfaces are **LIVE-PROVIDER-TESTED**, each through one explicitly authorized `npm run acceptance:live-provider` request: OpenAI Examiner (`EXAMINER_COMMERCIAL_V1` / `gpt-5.6-luna`), Anthropic Lab (`LAB_INSTRUCTOR_COMMERCIAL_V1` / `claude-sonnet-5`) and Anthropic Operations Engineer (`OPERATIONS_ENGINEER_PLATFORM_V1` / `claude-opus-5-5`). Professor, Tutor and Counsellor have **not** been individually live-provider-tested. None of these is **PRODUCTION-PROVEN**, and a live smoke is not evidence of grading or instructional quality. The deterministic backend remains authoritative regardless: PROFESSOR's own output is never written into any institutional record. `MASTERY_V1` is evidence-based and does not infer mastery from engagement. `SUPPORT_V1` uses reviewed authoritative conditions and does not infer inactivity/motivation/risk from behavioural telemetry. Controlled-assessment protected content is released from server-owned attempt state and every AI tool (PROFESSOR now live-composed, and any future role) must call the technical activity firewall.

Formal grading/result publication, pass/fail, academic completion/certification, institutional announcement authoring, production notification scheduling/email/push, payments, uploads/offline/PWA and live-provider AI academic actors remain outside this checkpoint. The Course & Agent Engineering staging/publication boundary, the B2 runtime harness, the live Professor provider-backed execution path and the learner-facing Professor classroom described above are now implemented and composed into `executeRoleCapability`, with one reviewed production runtime profile (`PROFESSOR_COMMERCIAL_V1`) now populating the previously-empty registry. Live-provider evidence is limited to the three surfaces named in the previous paragraph; Professor, Tutor and Counsellor have not been individually live-provider-tested.

Passing local/PR/main CI does not make Ducelio production-ready. Hosted Supabase/JWT/PostgREST/RPC acceptance, real provider/SMTP tests, true concurrent PostgreSQL scenarios, backups/restore, rate limiting/abuse controls, privacy/support-data governance, monitoring, accessibility/browser/device acceptance and deployment security review remain required before real learners or protected assessments are operated.
