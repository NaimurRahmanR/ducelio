# Commercial V1 — Course Activation & Cohort Delivery Materialisation

## Starting state and scope

Started from clean `commercial-v1-course-activation` at `e269076bd1527d68d8cc98d193837cc825a26bad`, the PR #7 Professor Classroom merge. Post-merge Ducelio CI #32 passed (user-confirmed). The local baseline was 910 tests across 46 files on bundled Node v24.19.0. This implementation is uncommitted and requires independent review.

This checkpoint connects a validated, applied package and published ProgrammeVersion to a cohort's institutional delivery. It adds no provider execution, grading, evidence, mastery, completion, entitlement or certification authority. Existing Professor execution and classroom behaviour remain unchanged. Hosted Professor provider acceptance remains **PENDING**; no hosted provider call was made here.

**Correction pass (independent review):** the initial implementation passed its own local gates but an independent review of the actual patch found two confirmed blockers and one acceptance correction, all fixed in place (migration 027 is still uncommitted, so it was corrected rather than superseded by a new migration): (1) `course_activation_objectives`/`course_practicals` incorrectly scoped local-key uniqueness to the whole import rather than to the owning lesson, narrowing what COURSE_PACKAGE_V1 itself permits (two different lessons legitimately reusing the same objective/practical key); (2) `getStudentAssignments`/`getStudentAssessments` could construct `.in("cohort_id", [])` for a legitimate zero-enrolment STUDENT, which real Supabase/PostgREST does not guarantee behaves like the local test double's `= ANY('{}')`; (3) the successful `COURSE_ACTIVATED` audit event discarded the administrator's own bounded activation reason and stored a hardcoded string instead. See "Package key provenance", "Zero-enrolment learner coursework" and "Admin and privacy" below for the corrected behaviour, and "Validation and remaining work" for the updated test counts.

## Activation boundary

`src/domain/course-activation.ts` defines the strict request:

```ts
{
  importId: UUID,
  cohortId: UUID,
  instructorId: UUID,
  assignments: [{ templateKey, opensAt, dueAt }],
  assessments: [{ templateKey, opensAt, closesAt }],
  reason: string // trimmed, 5–300 characters
}
```

Arrays contain at most 250 entries each. UUIDs, timestamp offsets, strict field allowlists, duplicate keys and increasing windows are checked in TypeScript. The database independently requires exactly one schedule per stored package template, rejects extra/missing/unknown fields and keys, checks finite timestamps and increasing windows, and revalidates the entire stored package through migration 024's validator. Assignment and assessment dates are explicitly supplied; none are inferred from study cadence or invented by an agent. The UI labels its date inputs UTC. Direct RPC timestamps require an explicit offset.

Only an authenticated ACADEMIC_ADMIN or PLATFORM_ADMIN may activate. An instructor is a validated institutional assignee, not the caller's asserted identity. REGISTRAR, INSTRUCTOR, COUNSELLOR and STUDENT alone cannot activate. An import must be APPLIED or PUBLISHED and its exact applied ProgrammeVersion must already be PUBLISHED. The cohort must reference that exact version. Activation never publishes curriculum or selects a latest version.

## Migration 027 and institutional storage

`202609140027_commercial_v1_course_activation.sql` is additive. Migrations 001–026 remain unchanged.

New tables, all RLS-enabled with no direct browser/service-role access:

- `course_activation_versions`: immutable import/version binding; one materialisation per version.
- `course_activation_lessons`: package lesson/module keys bound to actual module/lesson/version UUIDs.
- `course_activation_objectives`: package objective keys bound to actual objective/lesson/version UUIDs.
- `course_activations`: immutable ACTIVATED receipt, actor, import/version/cohort/instructor, DB timestamp and schedule identity digest; one activation per cohort.
- `course_practicals`, `course_practical_objectives`: version-level EXERCISE/PRACTICAL_LAB content and exact objective mappings.
- `course_assignment_bindings`, `course_assignment_objectives`, `course_assignment_rubrics`: canonical assignment provenance, explicit schedule, exact objectives and ordered rubric criteria (description/max marks).
- `course_assessment_bindings`, `course_assessment_objectives`: canonical assessment schedule/provenance and question/objective mappings.

Additive composite unique constraints on existing imports, lessons, objectives, assignments and assessments support relational foreign keys. No historical row is rewritten. New rows cannot be updated or deleted; future corrections need a separately reviewed workflow. Existing assignment/assessment status authority can still close canonical coursework without rewriting the activation receipt.

The new private schema contains authorization, strict schedule validation, configuration comparison, learner scope, immutable-history and version-lock helpers. Public RPCs are `activate_course_package`, `get_course_activation_options`, `list_practical_enrolments`, `list_my_practicals`, `request_practical_support` and `my_coursework_scope`.

## Atomicity, idempotency and concurrency

One `activate_course_package` SECURITY DEFINER statement performs all writes. Exceptions propagate to roll back the transaction, including late configuration conflicts and audit failures. There is no application sequence of separate materialisation commits.

The lock order is import row → exact ProgrammeVersion row → cohort row. A unique cohort activation and unique import/version/template bindings prevent duplicate sets. The version lock serializes different cohort activations sharing practicals/configuration. A new BEFORE INSERT/UPDATE trigger makes the existing agent-config writer acquire the same ProgrammeVersion lock, including its INSERT/ON CONFLICT path, so concurrent config authoring cannot race a no-row check.

Schedule entries are sorted by template key and timestamps normalized under UTC before computing a DB-owned SHA-256 digest of identifiers, instructor and schedule metadata. The digest contains no academic content. Reason text is not activation identity: repeating the same materialisation with a different administrative explanation remains idempotent, and that replay does not rewrite the original activation's audit reason (see "Admin and privacy" below) — the first successful activation's reason is the durable one. Equivalent timestamp offsets reuse the same receipt. An incompatible cohort/import/instructor/schedule fails with ACTIVATION_CONFLICT. Identical replay rechecks configuration and returns the existing activation without new objects or audit events.

Local PGlite tests prove sequential exclusion, uniqueness, replay and atomic rollback. Lock clauses and constraints are inspected directly. **Two independent concurrent PostgreSQL connections have not been tested**; hosted concurrency/deadlock/retry acceptance remains required. A deadlock or transaction failure must be retried as the same complete activation, never as separate partial writes.

## Package key provenance

Migration 024 created curriculum rows at package-defined unique positions. Activation resolves module → lesson → objective through those exact structural positions within the applied version, verifies the stored titles/descriptions and per-level counts, and persists the package-local keys alongside UUIDs. It performs no fuzzy title matching, AI inference or caller-selected mapping. Composite foreign keys constrain import/version, module/lesson/version, objective/lesson/version and coursework/cohort/version relationships. A mismatched published structure fails PROVENANCE_CONFLICT; it is not silently rebound.

**Local-key scope matches the canonical package contract exactly.** `src/domain/course-package.ts` validates module and lesson keys as unique _across the whole package_, but objective and practical-activity keys as unique only _within their owning lesson_ — two different lessons may legitimately both declare objective key `obj-1` and practical key `lab`. `course_activation_lessons` therefore keeps package-wide key identity (`primary key(import_id, local_key)`, matching lesson keys' own package-wide uniqueness), while `course_activation_objectives` and `course_practicals` are lesson-scoped (`primary key(import_id, lesson_id, local_key)` and `unique(import_id, lesson_id, local_key)` respectively) — a correction from an initial version that incorrectly scoped both to the import alone, which would have rejected a valid package reusing an objective/practical key across lessons. Every resolution query that maps a template's `objectiveRefs` onto `course_activation_objectives` was already filtering by `lesson_id` in its `WHERE` clause (never local key alone), so the fix is the constraint shape itself — no query logic changed. `tests/course-activation-workflow.test.ts`'s "multi-lesson reused local keys" suite proves this end to end with two lessons each declaring objective key `obj-1` and practical key `lab`: both validate, apply, publish and activate successfully; two provenance rows exist for each reused key, one per lesson; each provenance row and each dependent practical/assignment/assessment objective mapping resolves to its own lesson's institutional UUID, never the other lesson's, even though the local key text is identical.

Practical content is materialised once per version. A second activated cohort reuses it and the five configs while receiving its own assignments, assessments, questions and rubric/objective mappings. Learner runtime reads institutional practical rows only, never `course_package_imports.raw_package`.

## Coursework and protected assessment content

Assignments use `create_assignment` → relational metadata → `change_assignment_status(PUBLISHED)`. Assessments use `create_assessment` → `add_assessment_question` for every question → relational objective mappings → `change_assessment_status(PUBLISHED)`. All existing authoring checks, instructor rules, publication validation and institutional audit triggers execute inside the activation transaction.

`expectedAnswer` and `markingGuidance` go only into the existing `assessment_answer_keys` authority via `add_assessment_question`. Questions remain behind existing controlled-attempt release. Neither options nor practical RPCs select protected fields. Migration 027 also explicitly revokes ambient service_role privileges on the existing answer-key table, including column privileges, because this table now receives materialised package answers. There is no service-role application client.

The existing `getStudentAssignments`/`getStudentAssessments` and learner components remain the assignment/assessment experience. Their reads now use `my_coursework_scope`, deriving the authenticated student's own cohort IDs and filtering submissions/attempts/responses by that principal. This closes staff RLS visibility inheritance in multi-role learner views without removing staff's legitimate authoring visibility. Canonical submit/start/respond/submit-attempt services are unchanged.

**Zero-enrolment learner coursework (correction pass).** A legitimate STUDENT can have zero enrolments (entitlement/payment not yet completed), giving `my_coursework_scope` an empty `cohortIds` array. Both services now short-circuit on `scope.cohortIds.length === 0` and return safe empty state — `{assignments: [], submissions: []}` and `{assessments: [], attempts: [], responses: [], activityState: "NORMAL", activeQuestions: []}` respectively — **before** any query is issued, rather than constructing `.in("cohort_id", [])`. Real Supabase/PostgREST does not guarantee that an empty `.in()` array behaves like the `= ANY('{}')` a local test double might emulate, so this case is never sent to the query builder at all. `NORMAL` is honest, not a fabricated default: no valid controlled-assessment attempt can exist without an enrolment. `tests/course-activation-server.test.ts`'s fake PostgREST adapter now itself throws if `.in()` is ever called with an empty array, acting as a permanent regression guard against this exact shape of bug recurring; a dedicated test exercises a real zero-enrolment STUDENT (`foreignLearner`, who has no enrolment anywhere in the fixture) through both services and asserts the exact empty shapes above.

## Five-role configuration

Activation compares each package config with the existing version/role row. Exact semantic equality (including capability set order normalization) is accepted without updating timestamps or rewriting history. Missing configuration is applied through `set_agent_config`, preserving the shared SQL capability policy and existing audit. Any incompatible row aborts the whole activation. Cohort 2 cannot overwrite cohort 1's reviewed version-level configuration.

Configuration is not execution authority. The code-owned execution-path set still contains only PROFESSOR. TUTOR, LAB_INSTRUCTOR, EXAMINER and COUNSELLOR remain fail closed with NO_EXECUTION_PATH. No provider adapter receives a database client, new capabilities or arbitrary JSON.

## Practicals, support and assessment firewall

`/student/practicals` uses authenticated STUDENT ownership, exact cohort/version activation and bounded 20-item pages. A multi-role student receives only their own enrolments. Historical material remains readable in its preserved version; support requests still require the existing ACTIVE delivery state.

Practical reads lock the authenticated learner's `student_profiles` row and call fixed EXPLAIN before selecting content. This orders that database statement against assessment start. It does not extend migration 021's lease or claim that response bytes can be retracted, nor does it grant continuing provider/runtime access. Existing Professor release/execution/classroom guarantees are unchanged.

EXERCISE support routes to TUTOR using the existing fixed PRACTICAL_PREREQUISITE reason; PRACTICAL_LAB routes to LAB_INSTRUCTOR using PRACTICAL_HELP. The RPC derives the lesson and route from the authorized practical, then calls `request_delivery_handoff`. Browser role/destination overrides are not accepted. Request IDs support duplicate submission idempotency. Success means only that an OPEN learner referral was recorded, not that a Tutor/Lab AI session occurred. Opening, reading or requesting support never creates attendance, progress, evidence, mastery or grades.

## Admin and privacy

`/admin/activation`, linked from the existing Programmes workspace for academic/platform admins, provides package selection, matching cohort/instructor selection, explicit UTC schedule fields and one activation action. Options are bounded metadata projections: no question prompt, answer, marking guidance, package JSON, practical body or assignment instructions. Unknown backend errors become SERVICE_UNAVAILABLE; UI actions show bounded feedback and no raw SQL/provider text.

Audit uses existing institutional infrastructure. The final receipt records IDs, package revision, state and materialised counts; existing authoring/config triggers retain their content-minimised audit. No arbitrary caller audit JSON is accepted. Prompt, support, resource, rubric and learner-response prose are not copied into activation audit.

**Activation reason (correction pass).** The bounded (5–300 character) administrative `reason` an operator supplies at activation time is stored, trimmed, in `audit_events.reason` for the successful `COURSE_ACTIVATED` receipt only — never in `after_state`, which stays content-minimised identifiers/state/counts. An initial version of this migration validated `p_reason` but then discarded it, writing a hardcoded `"Governed cohort activation"` string instead; this is corrected to `trim(p_reason)`. The nested mechanical authoring operations the transaction performs internally (`create_assignment`, `change_assignment_status`, `create_assessment`, `add_assessment_question`, `change_assessment_status`, `set_agent_config`) keep their own existing fixed operational reasons, since those calls are not the operator-facing activation receipt and rewriting their established audit conventions was not part of this fix. An idempotent replay of an identical activation (same import/cohort/instructor/schedule fingerprint, which does not include the reason) never rewrites the original receipt's reason, even when supplied with a different reason string on replay — replay returns the existing activation before the audit insert is ever reached again, so the first successful activation's reason remains the durable institutional rationale for that receipt. Both behaviours are directly tested.

Explicit table/function/schema and column revocations are followed by effective privilege checks for anon/authenticated/service_role. Unexpected inherited privileges cause migration failure. Authenticated users retain only the narrow public RPC grants; private raw helpers are not callable. Hosted Supabase ACL/default-privilege/JWT/PostgREST acceptance remains outstanding.

## Validation and remaining work

Focused database/server tests exercise activation roles, schedule validation, provenance FKs, immutable history, replay, second cohorts, late-stage rollback, metadata privacy, effective ACLs/inherited grants, self-scope/multi-role isolation, existing learner coursework services, assignment submission, controlled question release/responses/submission, practical firewall and deterministic referrals. The correction pass added: a multi-lesson reused-local-key regression suite (three tests proving two different lessons may share an objective/practical key and never cross-resolve); two audit-reason tests (the bounded reason is stored trimmed in `audit_events.reason`, never `after_state`, and an idempotent replay with a different reason never rewrites the original); and a zero-enrolment coursework test (a real STUDENT with no enrolments gets safe empty state from both `getStudentAssignments`/`getStudentAssessments`, with the fake PostgREST test adapter itself now throwing on an empty `.in()` filter as a permanent regression guard). Final local validation on Node v24.19.0: **68 focused tests** (61 DB workflow + 7 real server/DB composition), **978 full tests across 48 files**, passing lint/type checks, format check, production build and `git diff --check`. All 910 baseline tests remain green. Migrations 001–026 have zero diff.

Deferred: true concurrent hosted PostgreSQL acceptance; hosted Supabase/auth/browser/accessibility acceptance; large-catalogue pagination beyond bounded selection lists; separate governed reactivation/correction workflows; real cybersecurity content; grading/results/completion; actual Tutor/Lab/Examiner/Counsellor execution; payments/entitlements; production deployment/SMTP/backups/monitoring. This is the minimum activation UI, not the full Course Builder. Hosted Professor provider acceptance remains PENDING.
