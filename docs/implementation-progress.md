# Implementation progress

This file is the high-level implementation status. Detailed checkpoint evidence lives in `phase-1-completion-report.md`, `phase-2-progress.md` and `phase-2-completion-report.md`.

LAST COMPLETED CHECKPOINT: Phase 2 checkpoint 14 — integration hardening
CURRENT PARTIAL CHECKPOINT: Phase 2 checkpoint 15 — final audit and PR readiness
KNOWN FAILURES: The first PR-ready Checkpoint 15 tree passed local validation and GitHub CI, but manual PR review found three blockers. Forward-only migration 020, a controlled-assessment UI correction and dedicated regression tests now address them; the corrected head still requires a fresh exact-tree local gate and updated PR CI before merge.
NEXT EXACT ACTION: Pull the final-review correction commits, run the exact Node 24 gate (`npm run check`, `npm run build`, `npm run format:check`, clean git status), then verify PR #1 CI on the same head and merge only after the corrected diff has no unresolved blocker.

## Phase 1 — complete

Phase 1 established the engineering and institutional foundation: Next.js/React/TypeScript, Supabase/PostgreSQL migrations, authentication and stable identity, backend RBAC/RLS, versioned programme structure, audited Counsellor services, student academy UI, Counsellor workspace, Administration shell, fictional previews, automated tests and architecture/security documentation.

The eight-checkpoint Phase 1 record remains in `phase-1-completion-report.md`. Hosted Auth/OAuth/SMTP acceptance was outside that historical local delivery.

## Phase 2 — implementation complete through Checkpoint 14

The deterministic Academy Operating System includes:

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
14. cross-checkpoint authorization, concurrency, timezone, idempotency, projection and audit hardening.

Checkpoint 14's final local Node 24 gate passed ESLint, route/type generation and TypeScript, **149/149 tests across 23 files**, production webpack build and Prettier; the working tree was clean and synchronized at that checkpoint.

## Checkpoint 15 — final audit and PR readiness — in progress

Checkpoint 15 reviewed the feature branch against `main`, reconciled current architecture/security documentation, opened PR #1 and obtained an initial green Linux/Node 24 GitHub Actions run. The manual PR security review then found three issues that required code changes rather than a rubber-stamp merge:

- INSTRUCTOR-only actors could self-select as assignment/assessment instructor for an arbitrary known cohort without an existing relationship;
- support-only plan/follow-up notification detail crossed into Academic Admin notification reads even though the source support records were separately permissioned;
- expired/closed controlled-assessment attempts could remain state `ACTIVE`, leaving stale lifecycle/UI state and blocking a later assessment start.

The corrected branch now adds migration `202609090020_phase2_final_review_hardening.sql`, making 20 ordered migrations in total. It requires instructor-initiated coursework/assessment creation to match a real non-cancelled ClassSession relationship, minimises Counsellor follow-up notification content and keeps support-only notification kinds outside Academic Admin/Platform Admin reads, and deterministically finalises expired/closed ACTIVE assessment attempts before another start. The student controlled-assessment UI now renders an active protected-content shell only when the server-owned activity state is actually `CONTROLLED_ASSESSMENT_ACTIVE`.

`tests/final-review-hardening.test.ts` adds focused regression coverage for all three review findings. The previous **149/149** result predates these changes; the corrected expected suite is **152 tests across 24 files**, subject to the required fresh quality gate.

## Current scope boundary

No AI academic actor is integrated. The deterministic backend remains authoritative. `MASTERY_V1` is evidence-based and does not infer mastery from engagement. `SUPPORT_V1` uses reviewed authoritative conditions and does not infer inactivity/motivation/risk from behavioural telemetry. Controlled-assessment protected content is released from server-owned attempt state and future AI tools must call the technical activity firewall.

Formal grading/result publication, pass/fail, academic completion/certification, institutional announcement authoring, production notification scheduling/email/push, payments, uploads/offline/PWA and AI academic actors remain outside Phase 2.

Passing local/PR CI does not make Ducelio production-ready. Hosted Supabase/JWT/PostgREST/RPC acceptance, real provider/SMTP tests, true concurrent PostgreSQL scenarios, backups/restore, rate limiting/abuse controls, privacy/support-data governance, monitoring, accessibility/browser/device acceptance and deployment security review remain required before real learners or protected assessments are operated.