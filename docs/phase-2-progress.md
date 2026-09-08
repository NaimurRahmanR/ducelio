# Phase 2 — Academy OS progress

Branch: `phase-2-academy-os`

LAST COMPLETED CHECKPOINT: 6 — planned lesson segments and learner progress
CURRENT PARTIAL CHECKPOINT: None
KNOWN FAILURES: None after the final local Node 24 quality gate.
NEXT EXACT ACTION: Checkpoint 7 — versioned learning resources and lecture notes.

## Checkpoint 1 — governed programme publication — complete

- Migration: `202609080006_phase2_programme_publication.sql`.
- Added validated DRAFT → PUBLISHED transition, immutable publication metadata snapshots, publication actor/time, bounded reason, controlled RPC, service/action and admin UI.
- Publication requires at least one module; every module requires a lesson; every lesson requires an objective.
- Existing Phase 1 fictional published version is backfilled safely before the new constraint is enforced.
- Validation at completion: 65/65 tests, lint, typecheck and production build passed under Node 24.20.0.

## Checkpoint 2 — governed enrolment workflow — complete

- Migration: `202609080007_phase2_enrolment_workflow.sql`.
- Added controlled enrolment creation into published cohort versions, immutable cohort snapshots, bounded audited status transitions, server services/actions and admin enrolment workspace.
- Student academy now reads historical programme/cohort snapshots instead of mutable live labels.
- Validation at completion: 70/70 tests, lint, typecheck and production build passed under Node 24.20.0.

## Checkpoint 3 — governed counsellor assignment operations — complete

- Migration: `202609080008_phase2_counsellor_assignment_workspace.sql`.
- Reused the existing audited `assign_counsellor` relationship service rather than creating a parallel assignment system.
- Added constrained discovery of staff who actually hold the COUNSELLOR role, assignment/reassignment UI, and active/historical relationship register.
- Reassignment preserves closed relationship history and existing permission revocation behaviour.
- A TypeScript contract mismatch in nested Supabase relation data was found by the quality gate and fixed by explicitly mapping service data to the UI model.
- Validation at completion: 74/74 tests, lint, typecheck and production build passed under Node 24.20.0.

## Checkpoint 4 — persisted class sessions — complete

- Migration: `202609080009_phase2_class_sessions.sql`.
- Added persisted class sessions bound to cohort, programme version, lesson and instructor.
- Scheduling requires published curriculum, a lesson from the cohort version and staff with INSTRUCTOR role.
- Prevents cohort/instructor overlaps, preserves immutable schedule history, supports controlled completion/cancellation, adds RLS visibility and institutional audit logging.
- Added admin scheduling/lifecycle UI, learner-facing class-session reads and focused workflow tests.
- Final local validation: ESLint passed with no warnings; Next route type generation and TypeScript passed; 80/80 tests in 13 files passed; production webpack build passed; working tree clean and branch synchronized with origin.

## Checkpoint 5 — governed attendance — complete

- Migration: `202609080010_phase2_attendance.sql`.
- Added authoritative attendance records bound to a persisted class session and the learner enrolment that belongs to its cohort/version.
- Attendance statuses are PRESENT, LATE, ABSENT and EXCUSED. Attendance cannot be recorded for cancelled sessions or before a session begins, and the system does not infer absence from page views or inactivity.
- Corrections preserve record identity and are audited rather than deleting history. Students can read only their own attendance through the established identity/RLS boundary; authorised staff record through the controlled RPC/service path.
- Added admin attendance workspace, learner-facing attendance display and focused workflow tests.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 86/86 tests in 14 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 6 — planned lesson segments and learner progress — complete

- Migration: `202609090011_phase2_lesson_progress.sql`.
- Added versioned planned lesson segments and learner progress records bound to enrolment, lesson segment, programme version and a real class session.
- Progress statuses are IN_PROGRESS and COMPLETED. Progress cannot be recorded before a class starts, for a cancelled class, against the wrong lesson/version, or directly by the learner as an authoritative self-report.
- Planned segments freeze with published/enrolled curriculum. Progress is readable within established learner/admin/counsellor/assigned-instructor boundaries and corrections remain audited.
- Student UI labels this measure explicitly as NOT MASTERY; no scrolling, elapsed time, clicks or content viewing can create mastery or progress records.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 92/92 tests in 15 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Scope boundary

Phase 2 remains deterministic Academy OS work. No AI actor receives authoritative database access, no navigation/time signal counts as mastery evidence, and assessment/homework firewalls remain future technical enforcement work. Hosted Supabase/JWT/provider/staging acceptance remains required before production use.
