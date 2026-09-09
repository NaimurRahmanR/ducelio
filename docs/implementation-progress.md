# Implementation progress

This file is the high-level implementation status. Detailed checkpoint evidence lives in `phase-1-completion-report.md`, `phase-2-progress.md` and `phase-2-completion-report.md`.

LAST COMPLETED CHECKPOINT: Phase 3 checkpoint 1C â€” four additional safe Professor reads on the provider-independent capability boundary; local validation complete
CURRENT PARTIAL CHECKPOINT: None
KNOWN FAILURES: None in the completed local 1C gate: 246/246 tests across 26 files, lint, route/type generation, TypeScript, production build, formatting and git diff --check passed. Phase 3 Checkpoint 1C PR CI/review, hosted acceptance and independent concurrent PostgreSQL acceptance have not been performed.
NEXT EXACT ACTION: Commit and push the reviewed Checkpoint 1C slice on `phase-3-ai-academic-layer`. Then proceed to the separately reviewed Checkpoint 1D security boundary before any provider/model integration.

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

The Checkpoint 1C tree remains on `phase-3-ai-academic-layer`; no Checkpoint 1C commit, PR CI success or merge to `main` is claimed here. Durable capability execution audit and a serialized assessment/content release boundary remain intentionally deferred and must be closed before provider/model execution.

## Current scope boundary

No AI academic actor is integrated. The deterministic backend remains authoritative. `MASTERY_V1` is evidence-based and does not infer mastery from engagement. `SUPPORT_V1` uses reviewed authoritative conditions and does not infer inactivity/motivation/risk from behavioural telemetry. Controlled-assessment protected content is released from server-owned attempt state and future AI tools must call the technical activity firewall.

Formal grading/result publication, pass/fail, academic completion/certification, institutional announcement authoring, production notification scheduling/email/push, payments, uploads/offline/PWA and AI academic actors remain outside Phase 2.

Passing local/PR/main CI does not make Ducelio production-ready. Hosted Supabase/JWT/PostgREST/RPC acceptance, real provider/SMTP tests, true concurrent PostgreSQL scenarios, backups/restore, rate limiting/abuse controls, privacy/support-data governance, monitoring, accessibility/browser/device acceptance and deployment security review remain required before real learners or protected assessments are operated.
