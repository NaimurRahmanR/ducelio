# Phase 2 — Academy OS progress

Branch: `phase-2-academy-os`

LAST COMPLETED CHECKPOINT: 14 — Phase 2 integration hardening
CURRENT PARTIAL CHECKPOINT: 15 — final Phase 2 audit and PR readiness
KNOWN FAILURES: The first PR-ready tree passed local validation and GitHub CI, but manual PR review found three blockers. Corrective migration 020, learner assessment-shell handling and dedicated regression tests are now on the branch and require a fresh exact-tree local/PR gate.
NEXT EXACT ACTION: Pull the final-review correction commits locally; run Node 24 `npm run check`, `npm run build`, `npm run format:check` and confirm a clean synchronized tree. Then verify the updated PR CI on the new head, review the corrected diff, and merge only when all gates are green with no unresolved blocker.

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

## Checkpoint 7 — versioned learning resources and lecture notes — complete

- Migration: `202609090012_phase2_learning_resources.sql`.
- Added curriculum-version-bound LECTURE_NOTE and REFERENCE_LINK resources with draft-only authoring and HTTPS-only external references.
- Resources freeze with published/enrolled curriculum and use the existing version visibility boundary, so enrolled learners see only resources for curriculum versions they are allowed to read.
- Added Administration → Resources authoring/registry and learner-facing Notes & resources.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 98/98 tests in 16 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 8 — deterministic learning evidence collection — complete

- Migration: `202609090013_phase2_learning_evidence.sql`.
- Added append-only learning evidence bound to learner enrolment, class session, lesson objective and exact programme version, with explicit evidence kind, result, provenance reference and idempotency key.
- Evidence can only be recorded through the governed service/RPC path after the class has started, against a matching enrolment/session/objective relationship. Learners cannot create authoritative evidence directly.
- Duplicate retries are idempotent, existing evidence cannot be edited or deleted, and learner/staff reads remain constrained by RLS and institutional relationships.
- Evidence collection does not update objective mastery. It supplies auditable input for the later deterministic mastery policy rather than treating a correct observation, page view or click as mastery.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 105/105 tests in 17 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 9 — deterministic objective mastery — complete

- Migration: `202609090014_phase2_objective_mastery.sql`.
- Added current objective mastery state and append-only transition history bound to learner enrolment, lesson objective and curriculum version.
- `MASTERY_V1` keeps first evidence at DEVELOPING; DEMONSTRATED requires correct evidence across at least two distinct class sessions and two evidence kinds; later partial/incorrect evidence moves a demonstrated objective to NEEDS_REINFORCEMENT; later correct evidence can restore DEMONSTRATED when diversity remains sufficient.
- Evidence insert, mastery evaluation, current-state update, history transition and audit run in one database transaction. Existing evidence is deterministically replayed during migration to reconstruct current state.
- Added RLS read boundaries, admin Evidence workspace mastery/history views, learner Results mastery display and focused mastery transition tests.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 112/112 tests in 18 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 10 — governed assignments — complete

- Migration: `202609090015_phase2_assignments.sql`.
- Added cohort/version/lesson-bound coursework assignments with DRAFT → PUBLISHED → CLOSED lifecycle, draft correction service, immutable published content and audited status changes.
- Added append-only learner submission attempts with active-enrolment, opening/deadline and idempotency enforcement. Learners can read only their own submissions; authorised staff can read coursework for their institutional scope.
- Assignment submissions do not automatically create grades, learning evidence or mastery. Controlled assessments remain a separate module with stricter server-owned firewalls.
- Added admin assignment authoring/lifecycle workspace, learner assignment/submission page, server actions/services and focused workflow tests.
- React render-purity enforcement caught a client-side `Date.now()` call; the assignment window UI was moved to effect-managed state while database timing rules remain authoritative.
- PGlite migration growth pushed suite setup beyond Vitest's default 10-second hook timeout, so `hookTimeout` was raised to 30 seconds without weakening test assertions.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 119/119 tests in 19 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 11 — controlled assessment foundations — complete

- Migration: `202609090016_phase2_controlled_assessments.sql`.
- Added DRAFT → PUBLISHED → CLOSED controlled-assessment metadata, protected questions and answer keys, server-owned ACTIVE/SUBMITTED/VOIDED attempts and append-only response revisions.
- Learners cannot read question or answer-key tables directly. Protected prompts are released only through `get_active_assessment_questions()` while an authenticated learner has an ACTIVE attempt inside the assessment release and expiry window.
- Answer keys and marking guidance are never returned by learner delivery services. Published protected content is immutable.
- ACTIVE attempts drive `current_academic_activity_state()` and the `academic_action_allowed()` / `assert_academic_action_allowed()` technical firewall, blocking normal tutor/practice/final-answer actions while permitting only examiner delivery and counsellor logistics under the current contract.
- Added audited administrative voiding, minimised assessment audit payloads, admin authoring/lifecycle UI, learner controlled-assessment delivery UI and focused firewall tests.
- The quality gate caught a SQL parser issue around the `position` output name, which was corrected without changing the assessment contract. Tests were also corrected to assert direct learner permission denial on protected tables rather than expecting empty rows.
- Automatic marking, grades/results and AI Examiner/Tutor integration remain deliberately outside this checkpoint.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 127/127 tests in 20 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 12 — governed registrar corrections — complete

- Migration: `202609090017_phase2_registrar_corrections.sql`.
- Added append-only `registrar_corrections` history for documented corrections to existing enrolment-status and attendance-status records, including before/after values, bounded reason, actor and timestamp.
- Registrar correction RPCs preserve authoritative record identity while writing immutable correction provenance and the ordinary institutional audit trail.
- Completed enrolments remain outside this correction workflow; academic completion requires a separate academic completion workflow.
- Registrar-only actors are blocked from ordinary academic mutation paths; explicit correction RPCs provide the bounded official-record exception path.
- Academic admins do not automatically receive Registrar correction authority. REGISTRAR or PLATFORM_ADMIN is required for these exception workflows.
- Added dedicated server service/actions, Administration → Registry correction workspace and focused role-boundary/correction-history tests.
- Full integration validation exposed stale enrolment tests that still treated REGISTRAR as the ordinary enrolment operator; those tests were corrected to use ACADEMIC_ADMIN while dedicated Registrar tests preserve the new boundary.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 135/135 tests in 21 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 13 — institutional notifications and deterministic support triggers — complete

- Migration: `202609090018_phase2_notifications_support_triggers.sql`.
- Added immutable-provenance learner notifications with learner-scoped RLS and an idempotent mark-read service. Notifications do not modify their source academic/support records.
- Added explicit `SUPPORT_V1` backend rules for authoritative ABSENT attendance, published assignments due within 48 hours without a submission, overdue planned study items and deterministic `NEEDS_REINFORCEMENT` mastery states.
- Matching support events are idempotently opened/reopened and resolved when their owning authoritative condition no longer holds. The existing `INACTIVITY` value is deliberately not generated by `SUPPORT_V1`.
- Added learner notifications for deterministic support events and open counsellor follow-ups due today or tomorrow. Duplicate scans cannot duplicate notices for the same source.
- Added Administration → Notifications operations, a learner notification page behind the academy bell, server services/actions and focused workflow tests.
- The current evaluator is an authorised ACADEMIC_ADMIN/PLATFORM_ADMIN backend operation. Production scheduling, email and push delivery remain future operational integrations and are not claimed by this checkpoint.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 143/143 tests in 22 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 14 — Phase 2 integration hardening — complete

- Migration: `202609090019_phase2_integration_hardening.sql`.
- Tightened ordinary enrolment and class-session mutation authority to ACADEMIC_ADMIN/PLATFORM_ADMIN while preserving the dedicated Registrar correction path.
- Duplicate ACTIVE enrolment requests are idempotent; PAUSED/WITHDRAWN/COMPLETED history can no longer be silently presented as a newly successful enrolment.
- Class scheduling now locks the instructor row before instructor-overlap checks, closing the cross-cohort concurrent double-booking window for the governed RPC.
- Added `list_my_class_sessions()` as a safe learner-facing projection so timetable rendering no longer depends on nested RLS access to another user's `app_users` identity row.
- Institutional `datetime-local` authoring controls now convert local wall time to an ISO instant in the browser before server validation, avoiding server-timezone interpretation of class, assignment and assessment times.
- Class, assignment and assessment authoring UIs filter lessons by the selected cohort's ProgrammeVersion before submission; database version checks remain authoritative.
- Server role checks now align with database RPC boundaries: assigned INSTRUCTOR operations can reach attendance/progress/evidence/coursework/assessment RPCs, while Registrar-only users do not gain those mutation paths.
- Learner assignment submissions and assessment response revisions now receive internal idempotency references instead of asking learners to invent infrastructure keys.
- Controlled-assessment retry hardening preserves monotonically increasing attempt numbers after VOIDED attempts, serializes attempt starts per learner and adds a composite response-to-attempt identity constraint.
- Learner-support programme context uses the immutable ProgrammeVersion title snapshot rather than the mutable parent Programme title.
- Generic LearningResource audit payloads no longer copy full lecture-note bodies.
- Administration navigation is role-scoped: Registrar-only users get Overview/Registry; Academic Admin does not receive Registry/Audit; Platform Admin retains all sections.
- Removed stale admin placeholder copy and updated the domain/progress documentation to match implemented Phase 2 state.
- Added focused integration-hardening regressions for enrolment history semantics, safe timetable projection, voided assessment retries, response identity, resource audit minimisation and scheduling conflict preservation.
- Final local validation after formatting: ESLint passed with no warnings; Next route type generation and TypeScript passed; 149/149 tests in 23 files passed; production webpack build passed; Prettier format check passed; working tree clean and branch synchronized with origin.

## Checkpoint 15 — final Phase 2 audit and PR readiness — in progress

- Compared `main` with `phase-2-academy-os`; at audit start the feature branch shared the current `main` merge base, was ahead and reported zero commits behind.
- Reconciled README, repository rules, migration/security documentation, future-agent boundary, roadmap and the Phase 2 completion report to the implemented deterministic Academy OS.
- Opened PR #1 and obtained a green Linux/Node 24 GitHub Actions run on the first PR-ready head.
- Manual PR review then found three blockers: an INSTRUCTOR could self-assign arbitrary cohort coursework/assessment creation; support-only follow-up/plan notification detail crossed into Academic Admin notification reads; and expired/closed ACTIVE controlled attempts could remain stale and block the next assessment flow.
- Added forward-only migration `202609090020_phase2_final_review_hardening.sql`: instructor-initiated coursework/assessment creation now requires a real non-cancelled ClassSession relationship; support-follow-up notification titles are minimised and support-only notification kinds stay outside Academic Admin/Platform Admin reads; expired/closed ACTIVE controlled attempts are deterministically finalised before a new start.
- Updated the learner controlled-assessment UI so only server-owned `CONTROLLED_ASSESSMENT_ACTIVE` state renders the active protected-content shell.
- Added `tests/final-review-hardening.test.ts` covering instructor relationship scope, support-notification privacy and expired-attempt finalisation.
- The previous 149/149 local/CI result predates these review corrections. The current head must now pass the fresh local exact-tree gate and updated PR CI before Checkpoint 15 can close.

## Scope boundary

Phase 2 remains deterministic Academy OS work. No AI actor receives authoritative database access, no navigation/time signal counts as mastery evidence, and controlled-assessment firewalls are technically enforced before any academic-agent integration. Homework-specific AI integrity policy remains future work. Hosted Supabase/JWT/PostgREST/provider/staging acceptance remains required before production use.