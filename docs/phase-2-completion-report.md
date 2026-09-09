# Ducelio Phase 2 completion report

Delivery date: 9 September 2026  
Source branch: `phase-2-academy-os`  
Merged target: `main`  
Status: **COMPLETE AND MERGED**

This report records the deterministic Academy OS delivered in Phase 2 and the boundary between completed repository work and production/deployment work that remains outside the phase. Phase 2 is merged and repository-validated; this does not mean Ducelio is production-ready for real learners or protected examinations.

## 1. Phase 2 delivery

Phase 2 adds fourteen implementation/hardening checkpoints on top of the Phase 1 foundation, followed by the final Checkpoint 15 audit/review gate:

1. governed ProgrammeVersion publication;
2. governed Enrolment creation/lifecycle;
3. governed Counsellor assignment/reassignment;
4. persisted ClassSession scheduling/lifecycle;
5. authoritative AttendanceRecord workflows;
6. versioned LessonSegment planning and LessonProgress;
7. versioned LearningResource delivery;
8. append-only LearningEvidence collection;
9. deterministic ObjectiveMastery under `MASTERY_V1` with immutable transition history;
10. governed Assignment authoring and append-only learner submissions;
11. controlled Assessment foundations, protected content release and server-owned activity firewalls;
12. governed Registrar corrections and immutable correction provenance;
13. learner Notification records and deterministic `SUPPORT_V1` support triggers;
14. cross-checkpoint integration hardening for authorization, concurrency, timezone handling, idempotency, safe projections, assessment identity and audit minimisation;
15. final documentation/security/PR review, including forward-only correction of review findings.

The repository contains **20 ordered migrations** in total: the five Phase 1/foundation migrations plus fifteen Phase 2 migrations (`006` through `020`). Migration `020` is the final-review corrective migration. The executable migrations and tests remain the source of truth; `06-database-schema.md` is the human-readable ledger.

## 2. Deterministic authority and identity

Ducelio remains an Academy Operating System rather than a chatbot-first system. Authenticated Supabase identity maps to a stable Ducelio user ID. Typed Student IDs, client metadata and client-supplied actor/role values do not authenticate or grant authority.

Institutional truth remains in deterministic services/PostgreSQL. Server actions call server-only services, database RPCs repeat operation-specific authorization, and RLS protects direct reads. No application service-role key is required in ordinary flows.

No AI academic actor is integrated in Phase 2. Future Professor, Tutor, Practical Instructor, Practice Coach, Examiner or AI Counsellor capabilities must call reviewed permissioned tools/APIs and must not receive unrestricted database credentials.

## 3. Curriculum, enrolment and institutional history

ProgrammeVersion publication is governed and validates curriculum completeness. Published/enrolled curriculum history is immutable; amendments use new versions rather than rewriting enrolled content.

Enrolments bind the learner, cohort and ProgrammeVersion with historical cohort/version snapshots. Duplicate ACTIVE creation is idempotent, while PAUSED/WITHDRAWN/COMPLETED history is not silently presented as a new successful enrolment. Ordinary enrolment mutation belongs to academic/platform authority; Registrar-only users use the dedicated correction workflow for existing official records.

Counsellor assignment is a persistent relationship across programmes. Reassignment closes the previous relationship and preserves history. Private support prose remains permission-separated from academic/admin access by default.

## 4. Teaching, timetable and attendance

ClassSession records bind cohort, ProgrammeVersion, lesson and instructor. Session schedule identity is immutable; completion/cancellation uses governed lifecycle transitions. Scheduling prevents cohort/instructor overlaps, and Checkpoint 14 serializes the governed path on both cohort and instructor records to close the cross-cohort instructor double-booking race.

Learner timetable reads use a safe projection that returns only the instructor identity fields needed for display rather than depending on nested read access to another user's identity record.

Browser `datetime-local` controls for class, assignment and assessment authoring are converted to ISO instants before server validation, avoiding server-host timezone interpretation.

Attendance is authoritative and bound to a class session plus matching enrolment. Corrections preserve record identity and audit provenance. Registrar correction history stores before/after status, bounded reason, actor and timestamp rather than replacing history.

The final PR review also tightened instructor authoring scope: an INSTRUCTOR cannot create coursework or a controlled assessment for an arbitrary known cohort merely by assigning themselves. Instructor-initiated creation now requires a real non-cancelled ClassSession relationship for the same cohort/lesson; Academic Admin or Platform Admin may still create and explicitly assign an instructor.

## 5. Learning evidence and mastery

LessonProgress is explicitly separate from mastery. Navigation, elapsed time, attendance, resource consumption and page views are not mastery inputs.

LearningEvidence is append-only and binds learner, enrolment/version, objective, class session, evidence kind, result, provenance and idempotency reference.

`MASTERY_V1` is the first explicit deterministic mastery policy. First evidence creates DEVELOPING; DEMONSTRATED requires correct evidence across at least two distinct class sessions and two evidence kinds; later partial/incorrect evidence can move a previously demonstrated objective to NEEDS_REINFORCEMENT; later correct evidence can restore DEMONSTRATED when diversity remains sufficient. Policy/version/evidence counts and transition history remain auditable.

This is an explicit Ducelio policy contract, not a universal claim that two observations prove educational mastery.

## 6. Coursework and controlled assessments

Assignments are ordinary coursework with DRAFT → PUBLISHED → CLOSED lifecycle and append-only learner submissions. Submission does not automatically create a grade, LearningEvidence or ObjectiveMastery. Learner-facing idempotency infrastructure is generated internally rather than asking learners to invent technical keys.

Controlled assessments are a separate stricter module. Question and answer-key tables are not learner-readable. Protected prompts are released only through the controlled delivery service while the learner has a server-owned ACTIVE attempt inside the assessment and attempt-expiry window. Answer keys and marking guidance are never returned by learner delivery.

`current_academic_activity_state()`, `academic_action_allowed()` and `assert_academic_action_allowed()` form the technical activity firewall. During an active controlled assessment, normal explanation/hint/critique/final-answer/submission-generation/practice actions are denied by the current contract; examiner delivery and Counsellor logistics remain permitted.

Assessment responses are append-only revisions. Checkpoint 14 database-binds response identity to attempt, assessment and learner, serializes attempt starts for a learner, and preserves monotonic attempt numbering after an administrator VOIDED an earlier attempt.

Checkpoint 15 additionally closes stale ACTIVE-attempt lifecycle behavior. Before a learner starts a new controlled attempt, an expired ACTIVE attempt or one whose assessment was administratively closed is deterministically finalized as SUBMITTED and remains attempt-consuming rather than silently VOIDED. The learner UI keys its active-attempt shell to the server-owned activity state so an expired shell does not block the next valid start action.

Phase 2 does not implement automatic grading, gradebook/result publication or pass/fail decisions.

## 7. Registrar, support and notifications

Registrar correction authority is intentionally narrower than academic authority. Registrar-only actors do not gain curriculum publication, teaching, class scheduling, ordinary attendance/evidence operations, assessment authoring, protected-answer access or grading authority.

`SUPPORT_V1` derives support events only from explicit authoritative conditions: ABSENT attendance, eligible published assignment due within 48 hours without a submission, overdue PLANNED study item, or ObjectiveMastery in NEEDS_REINFORCEMENT. It does not generate INACTIVITY from clicks, page views, time-on-page, prompt sentiment or inferred motivation.

Notification records are learner-visible projections with immutable source provenance and learner-controlled read state. Re-evaluation is idempotent and does not alter source academic/support records. Production scheduler, email and push delivery are not implemented.

The final review found that the initial notification operations RLS was broader than the source support-data boundary. Migration `020` corrects that: Academic Admin/Platform Admin notification reads are limited to academic-origin notification kinds they are already authorised to operate, while personal plan-overdue and Counsellor follow-up notices remain learner-only in the notification table. Counsellor-authored follow-up titles are no longer copied into the cross-boundary notification projection.

## 8. Audit and data minimisation

Institutional mutations use audit provenance where defined. Protected assessment prompts/answer keys/marking guidance and learner response bodies are excluded from assessment audit payloads. Private support narrative is not copied into generic audit records. Phase 2 hardening also removes full lecture-note bodies from generic LearningResource audit payloads; authoritative content remains in the resource record.

Database-owner credentials remain a privileged operational trust boundary because owners can bypass RLS. They require external access control/logging/review in production.

## 9. Validation evidence

The corrected final Phase 2 tree passed the exact local Node 24 gate:

- ESLint: PASS;
- Next route type generation + TypeScript: PASS;
- Vitest/PostgreSQL workflow suite: **152/152 tests across 24 files PASS**;
- production `next build --webpack`: PASS;
- Prettier format check: PASS;
- working tree: clean;
- feature branch synchronized with origin before merge.

The corrected PR head then passed GitHub Actions on Linux/Node 24, including `npm ci`, `npm run check`, `npm run format:check` and `npm run build`. The three manual-review blockers were considered closed before merge.

PR #1 was merged into `main` as commit `9b902e742dd8557d51b1c31e0b6a4f522c07982a`. A subsequent CI run triggered by the merge commit on `main` also passed the complete quality, formatting and production-build workflow.

## 10. Final branch audit

The Phase 2 audit compared `main` with `phase-2-academy-os` rather than trusting checkpoint summaries alone. At the start of Checkpoint 15, GitHub reported the feature branch directly ahead of the then-current `main` merge base with 0 commits behind.

Cross-cutting issues discovered during development were resolved before the initial PR, including stale Registrar mutation assumptions, duplicate-enrolment semantics, instructor scheduling serialization, learner timetable identity projection, server-timezone parsing of `datetime-local`, version-mismatched lesson selection, server/DB role-contract mismatch, learner-visible infrastructure idempotency keys, VOID retry attempt numbering, assessment response identity, mutable support programme labels, large resource audit payloads and stale Phase 1 documentation.

The PR review then added three further corrections: explicit instructor-to-class authoring scope, support-notification privacy minimisation, and expired/closed controlled-attempt finalisation.

## 11. Known limitations / non-production items

The following are not blockers to the completed Phase 2 repository delivery, but are blockers or required work before appropriate production use:

- hosted Supabase Auth/JWT/PostgREST/RPC/RLS acceptance with real users;
- Google/LinkedIn provider and SMTP/email-flow acceptance;
- true independent concurrent PostgreSQL tests for key locking/idempotency paths;
- backups plus tested restore procedures;
- rate limiting, abuse controls and any corresponding CAPTCHA UI/integration;
- production monitoring/alerting and log-data minimisation review;
- privacy, retention, deletion/export and support-case transfer/escalation policies;
- formal accessibility/browser/device acceptance rather than local sanity checks;
- pagination/operational search for bounded staff/admin lists before scale;
- explicit multi-institution tenant-isolation design before claiming multi-tenant service;
- formal grading/result publication, pass/fail and academic completion/certification;
- institutional announcement authoring;
- production support-trigger scheduling and email/push delivery;
- payments, uploads and offline/PWA synchronisation;
- AI academic actor/tool integration and provider/cost/provenance controls.

Protected controlled-assessment foundations must not be marketed as production-ready exam delivery until hosted security/concurrency/accessibility acceptance and later grading/result controls are complete.

## 12. Checkpoint 15 release gate — complete

Phase 2 closed after this sequence completed:

1. final review-correction commits were pulled and validated locally;
2. the exact Node 24 gate passed on the corrected tree;
3. the working tree was clean and synchronized;
4. PR #1 represented the corrected head;
5. updated PR GitHub CI passed;
6. the corrected diff was reviewed with no unresolved blocker remaining;
7. PR #1 merged to `main` at `9b902e742dd8557d51b1c31e0b6a4f522c07982a`;
8. post-merge `main` CI passed.

**Phase 2 is complete and merged.** Future work starts from the merged `main` baseline on a new feature branch.
