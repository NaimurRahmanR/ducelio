# Implementation progress

This file is the high-level implementation status. Detailed checkpoint evidence lives in `phase-1-completion-report.md` and `phase-2-progress.md`.

LAST COMPLETED CHECKPOINT: Phase 2 checkpoint 13 — institutional notifications and deterministic support triggers
CURRENT PARTIAL CHECKPOINT: Phase 2 checkpoint 14 — integration hardening
KNOWN FAILURES: Checkpoint 14 has not yet passed the local Node 24 quality gate.
NEXT EXACT ACTION: Pull the checkpoint-14 hardening changes and run the focused hardening tests followed by lint, typecheck, the full test suite, production build and Prettier check. Do not mark Phase 2 complete until the final audit/PR checkpoint also passes.

## Phase 1 — complete

Phase 1 established the local engineering and institutional foundation: Next.js/React/TypeScript, Supabase/PostgreSQL migrations, authentication and stable identity, backend RBAC and RLS, versioned programme structure, audited Counsellor services, student academy UI, Counsellor workspace, Administration shell, fictional previews, automated tests and architecture/security documentation.

The full eight-checkpoint Phase 1 ledger, validation evidence, limitations and external configuration requirements are preserved in `phase-1-completion-report.md`. Hosted Supabase/Auth/OAuth/SMTP acceptance remains external to the local implementation.

## Phase 2 — checkpoints 1–13 complete

Phase 2 has implemented the deterministic Academy Operating System through:

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
13. institutional Notification records and deterministic `SUPPORT_V1` support triggers.

The exact migrations, tests, local gate results and checkpoint-specific boundaries are recorded in `phase-2-progress.md`.

## Checkpoint 14 — integration hardening — in progress

The hardening checkpoint is resolving accumulated cross-checkpoint correctness and contract issues before the final Phase 2 audit. Current work includes:

- explicit academic-vs-Registrar mutation boundaries at both server and database layers;
- consistent server access for assigned INSTRUCTOR operations already permitted by their database RPCs;
- safer duplicate-enrolment semantics that do not silently treat PAUSED/WITHDRAWN/COMPLETED history as a new successful enrolment;
- instructor-row serialization before class-session overlap checks;
- a safe learner class-session projection that does not depend on nested access to another user's identity row;
- browser-timezone conversion of `datetime-local` values before class/assignment/assessment timestamps reach server validation;
- cohort-version-filtered lesson selectors in authoring workspaces;
- automatic internal idempotency references for learner assignment submissions and assessment response revisions;
- monotonic controlled-assessment attempt numbering after VOIDED attempts plus stronger response/attempt identity constraints;
- use of ProgrammeVersion title snapshots in learner-support programme context;
- minimisation of large LearningResource note bodies from generic audit payloads;
- role-scoped Administration navigation/workspaces;
- current domain/progress documentation and focused regression tests.

Checkpoint 14 is not complete until its focused tests and the complete Node 24 quality gate pass locally.

## Remaining Phase 2 closure

After checkpoint 14 passes, Phase 2 requires a final integration/audit checkpoint: review residual limitations, update all completion documentation, run the exact clean quality gates, review the branch diff/security posture, then open/review the pull request so GitHub CI runs against `main` before merge.

Passing local tests does not make Ducelio production-ready. Hosted JWT/RLS/Auth/provider checks, SMTP, backups, rate limiting/abuse controls, privacy/support-data governance, accessibility/browser/device acceptance and security review remain required before real learners or protected assessments are operated in production.
