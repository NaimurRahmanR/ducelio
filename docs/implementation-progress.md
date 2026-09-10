# Implementation progress

This file is the high-level implementation status. Detailed checkpoint evidence lives in `phase-1-completion-report.md`, `phase-2-progress.md` and `phase-2-completion-report.md`.

LAST COMPLETED CHECKPOINT: Phase 3 checkpoint 1D-B1 — provider-neutral trusted execution governance; local validation and final second review passed; approved for feature-branch checkpointing. PR CI, merge and hosted/production acceptance remain outstanding.
CURRENT PARTIAL CHECKPOINT: None
COMPLETED ITEMS: HMAC-authenticated controller commands, migration 022, metadata-only execution/audit lifecycle, replay rejection, admission ceilings, zero-provider budget, bounded timeout, server-only composition with 1D-A, security/regression tests and documentation.
INCOMPLETE ITEMS: Feature-branch checkpoint/PR CI; production provisioning/hosted acceptance; B2 provider execution, isolation, usage reconciliation, latency/cancellation, retention and human-review delivery decisions.
KNOWN FAILURES: None in the corrected local B1 gate: 438/438 tests across 29 files, lint, route/type generation, TypeScript, production build, formatting and git diff --check passed. Final second review passed. Production/true-concurrency acceptance is not established. No provider exists.
NEXT EXACT ACTION: Checkpoint the reviewed B1 tree on `phase-3-ai-academic-layer`, push it, then verify GitHub/PR CI status before beginning separately reviewed B2 provider integration.

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

No additional dependency, credential or environment configuration was needed for 1D-A. Migration 021 was applied only to local test databases in that checkpoint; hosted deployment/acceptance is not claimed. Checkpoint 1D-A is committed and pushed at `902e915` (`feat: serialize academic content release`) on the feature branch. Local validation and second review passed. PR CI was not run and it is not merged to main; hosted/true-concurrency acceptance remains outstanding.

## Phase 3 checkpoint 1D-B1 â€” provider-neutral trusted execution governance

The interrupted B1 working tree was resumed in place at `902e915`, preserving the prior implementation. Migration `202609100022_phase3_trusted_execution_governance.sql` adds `academic_execution_private.controller_keys`, `academic_executions`, constrained `govern_professor_execution` commands and dedicated metadata-only audit/immutability triggers. It uses Node and pgcrypto HMAC-SHA256 instead of introducing a service-role credential or a new application SQL connection. No dependency or provider was added.

The authenticated human STUDENT session and an independently verified controller attestation are both required. The database derives learner identity, fixes PROFESSOR/policy, verifies the owned ACTIVE academic release and its immutable invocation, and independently enforces state, budget and admission rules. The canonical protocol binds key/learner/execution/release, operation, outcome/reason, budget and issuance/expiry. Attestations expire after ten seconds with at most five seconds of tolerated forward server-clock skew; DB time is authoritative and verification repeats after the shared learner lock. Captured AUTHORIZE/START/terminal commands cannot create a second transition. Migration 021's 30-second release and all nine V2 capability contracts remain unchanged.

Execution states distinguish AUTHORIZED, RUNNING, SUCCEEDED, FAILED, ABSTAINED, ESCALATED and admission BLOCKED. The B1 runtime deliberately records ABSTAINED/POLICY_BLOCKED and returns metadata only; SUCCEEDED is exercised solely by explicit control-plane lifecycle fixtures. Security ceilings are one concurrent execution, five admissions per 60 seconds and 30 per hour, with a maximum 20-second execution capped by the bound release expiry. B1 budgets are zero provider calls, zero input/output tokens and zero estimated micro-USD; no actual usage/cost is recorded. These are pre-production abuse ceilings, not subscription quotas.

The existing gateway admits controller composition only for the seven validated content reads inside their release. It preserves exact self/enrolment/version checks, fresh principal validation and EXPLAIN enforcement. Invalid/malformed/audit-failed transitions and release-close failures discard the result. Terminal execution history and identity are immutable, deletion is forbidden, and authenticated users cannot directly read/mutate execution/key tables or forge institutional audit writes.

The trust claim is narrow: a valid MAC proves that a holder of the Ducelio controller secret authorized the exact command; DB audit records the permitted resulting control-plane lifecycle. It does not prove provider execution, model correctness or content delivery. RPCs remain directly authenticated-callable but additionally require the MAC; they are never described as gateway-only. No standalone generic verifier, signing oracle or arbitrary payload writer is exposed. The govern_professor_execution RPC necessarily validates a MAC only for its fixed, typed execution-governance protocol. Prompts, outputs, academic/support/assessment prose, evidence references, learner responses, credentials, MACs and sensitive-content hashes do not enter execution/audit rows. Exact metadata-retention duration remains a production governance decision.

No production secret was provisioned. The private DB key store starts empty; the server requires matching server-only secret-manager environment values. Operator provisioning, rotation, backup/log protection and hosted pgcrypto/RPC grants must be accepted separately. The full design, canonical format, alternatives, failure policy and B2 prerequisites are in `15-academic-execution-governance.md`.

Initial B1 validation on 2026-09-10 using bundled Node **v24.19.0**:

- Focused suites: **265/265 tests across five files** â€” 56 execution DB, 38 execution workflow, 116 capability/gateway, 29 capability/RLS workflow and 26 release lifecycle tests.
- `npm run check`: lint, route/type generation, TypeScript and **417/417 tests across 29 files** passed, preserving all prior 323 tests. A missing generic type argument found on the first typecheck was corrected before the passing run.
- `npm run build`: production webpack build passed; no new routes.
- `npm run format:check` and `git diff --check`: passed, including the final documentation update.

Tests use actual Node HMAC and PGlite pgcrypto, RLS/privileges, committed replay checks, DB admission/state constraints, release exclusion, privacy and audit-failure rollback. PGlite does not establish two-connection PostgreSQL concurrency, multi-process distributed admission, hosted Supabase/Auth/JWT/PostgREST acceptance, production provisioning, process/network isolation or provider acceptance. These remain outstanding. B2 must review external-call latency/lease expiry, provider evidence/isolation, nonzero budgets and reconciliation, retention decisions and failure/abstention/escalation/human-review delivery policy. Provider integration remains blocked.

Second-review corrections preserve the architecture and add explicit service_role revocations for execution/release tables and RPCs, private schema/key/helpers, and audit mutation while preserving existing audit SELECT. Column-level mutation grants are removed too. Migration 022 now fails if effective/inherited privileges still permit the protected operations. A BYPASSRLS fixture deliberately grants broad object defaults and pre-existing audit/release column rights; tests prove those grants are closed, authenticated entry points remain available, and unsafe inherited rights fail deployment acceptance.

The authority now distinguishes validated DB-terminal START/FINALIZE denials from transport/schema uncertainty. POLICY_BLOCKED, CONTENT_RELEASE_UNAVAILABLE, ACTIVITY_BLOCKED and EXECUTION_TIMEOUT retain their outward codes without a redundant INTERNAL_ERROR transition. Uncertain admitted failures still attempt cleanup and fail closed if terminal cleanup cannot be established. No read-back RPC, canonical change or terminal-history rewrite was introduced.

Corrected validation with bundled **v24.19.0**: focused B1 DB/workflow suites passed **115/115** (68 DB + 47 workflow); `npm run check` passed lint, route/type generation, TypeScript and **438/438 tests across 29 files**. Build, formatting and `git diff --check` passed. The 21 net additional cases include 12 service-role privilege cases and an expanded eight-case START/FINALIZE terminal-code matrix plus two transport/cleanup cases. Activity and deadline changes use privileged fault-injection fixtures; they do not claim ordinary assessment start can bypass the unchanged release exclusion.

Verifier wording now distinguishes the inaccessible private raw verifier from the public fixed-protocol MAC validation result. Roadmap/progress headings have proper UTF-8 em dashes without unrelated prose rewrites. Historical controller-key UUID attribution is explicitly deferred: audit proves some active key verified the command, not which key authorized each transition. Hosted ACL/default/membership/ownership acceptance, production secret provisioning and all earlier production/B2 limitations remain outstanding.

The corrected B1 implementation passed final second review and is approved for feature-branch checkpointing. PR CI, merge and hosted/production acceptance are not claimed; B2 has not begun.

## Current scope boundary

No AI academic actor is integrated. The deterministic backend remains authoritative. `MASTERY_V1` is evidence-based and does not infer mastery from engagement. `SUPPORT_V1` uses reviewed authoritative conditions and does not infer inactivity/motivation/risk from behavioural telemetry. Controlled-assessment protected content is released from server-owned attempt state and future AI tools must call the technical activity firewall.

Formal grading/result publication, pass/fail, academic completion/certification, institutional announcement authoring, production notification scheduling/email/push, payments, uploads/offline/PWA and AI academic actors remain outside Phase 2.

Passing local/PR/main CI does not make Ducelio production-ready. Hosted Supabase/JWT/PostgREST/RPC acceptance, real provider/SMTP tests, true concurrent PostgreSQL scenarios, backups/restore, rate limiting/abuse controls, privacy/support-data governance, monitoring, accessibility/browser/device acceptance and deployment security review remain required before real learners or protected assessments are operated.
