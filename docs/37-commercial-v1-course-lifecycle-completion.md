# Commercial V1 — Result → Progress → Completion Composition

## Scope

Checkpoint C of the Commercial V1 grading/recovery/completion chain, built on Checkpoint B's local commit. No migration is added; this checkpoint closes the missing server/action composition around already-backend-complete, already-tested authorities: `bindCommercialV1AssessmentComponent`, `publishCommercialV1GradingPolicy`, `setCommercialV1LabPolicy`, `publishCommercialV1ResultPolicy`, `getCommercialV1CourseProgress`, `listCommercialV1ObjectiveDiagnostics`, `attemptCommercialV1CourseCompletion` — every one of these existed, correctly implemented, since PR11A/the PR25 backend-integrity checkpoint, with no page, action or route composing them (confirmed by that checkpoint's own audit).

## Surface classification (re-verified against current code)

| Surface                                                                   | Classification                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `bindCommercialV1AssessmentComponent`, `publishCommercialV1GradingPolicy` | Backend-complete; now composed via `src/app/admin/activation/policy-actions.ts` |
| `setCommercialV1LabPolicy`, `publishCommercialV1ResultPolicy`             | Backend-complete; now composed via the same file                                |
| `getCommercialV1CourseProgress`, `listCommercialV1ObjectiveDiagnostics`   | Backend-complete; now composed via `src/app/student/progress/page.tsx`          |
| `attemptCommercialV1CourseCompletion`                                     | Backend-complete; now composed via `src/app/student/progress/actions.ts`        |

None was found incorrect. No universal pass mark, lab weighting or fuzzy component mapping was invented anywhere in this composition — every bound RPC call still takes only the exact same institution-supplied values (`passMarkBp`, `contributionBp`, an explicit `component` enum value) the underlying functions already required; nothing here adds a default.

## Admin composition

`src/app/admin/activation/policy-actions.ts` adds four thin Server Actions (`bindComponentAction`, `publishGradingPolicyAction`, `setLabPolicyAction`, `publishResultPolicyAction`), each requiring only the activation-scoped fields the underlying RPCs already accept, with no weight/profile/mark field anywhere. **Corrected in the independent-review checkpoint** (`docs/implementation-progress.md`'s "Independent-Review Correction Checkpoint" section): these were initially unreferenced by any page, and the claim that they were "reachable without manual SQL" was not yet true. They are now wired into a real admin page (`src/app/admin/activation/policy/page.tsx`), driven by a new bounded read (`get_commercial_v1_policy_setup_options`, migration 202609240041) that lists the activation's own real assessments/practicals so an admin never types an assessment/practical UUID blind, and are directly tested as actual Server Actions (`tests/commercial-v1-policy-setup-db.test.ts`), not merely through their underlying RPCs. The activation id itself is still typed once into the page (consistent with how `importId` already works on `/admin/activation`); a full activation picker remains out of scope, since the existing activation flow does not itself surface a new activation's id anywhere yet.

## Learner composition

`src/app/student/progress/page.tsx` (new route) reads `getCommercialV1CourseProgress`/`listCommercialV1ObjectiveDiagnostics` for the learner's own selected enrolment and renders the bounded, already-privacy-reviewed projection those functions return (component/lab FINALIZED-or-PENDING status, weighted contribution, course score, published pass mark, open remediation count, objective diagnostics) — no protected question, answer key or marking guidance is in that projection to begin with. `src/components/course-completion-form.tsx` + `src/app/student/progress/actions.ts`'s `attemptCourseCompletionAction` compose the existing `attemptCommercialV1CourseCompletion` deterministic gate: every eligibility check (all six components graded, the published pass mark, remediation clearance if required) is evaluated server-side from persisted, immutable state; the browser supplies only the enrolment id. Safe to press repeatedly — an already-completed enrolment returns its existing receipt rather than erroring or creating a duplicate. Deliberately minimal styling, matching this checkpoint's own scope boundary.

## The result/progress/diagnostics/completion integration test

`tests/commercial-v1-course-lifecycle.test.ts` proves result/progress/diagnostics/completion integration over valid, authoritative result state — lab/result policy publication → six graded formal components + one graded lab already present → progress → objective diagnostics → deterministic completion receipt — through the real server-level functions (`setCommercialV1LabPolicy`, `publishCommercialV1ResultPolicy`, `getCommercialV1CourseProgress`, `listCommercialV1ObjectiveDiagnostics`, `attemptCommercialV1CourseCompletion`) against a real PGlite database, never raw SQL for the flow under test. How each component's result was produced is deliberately out of this test's scope: Checkpoints A and B already prove the Examiner atomic-finalizer and the submission→grading composition exhaustively, and no live provider exists in this test environment to produce a result through the full Examiner path — so results are seeded the same test-owner way `commercial-v1-examiner-regrade-fixture.ts`'s own `seedResult` already does, an established, reviewed pattern in this codebase. This is deliberately **not** a single integrated submit → Examiner grade → progress → completion traversal across Checkpoints A/B/C — no such test exists in this codebase. This test's job is proving progress/diagnostics/completion compose correctly over real, validly-produced results, including:

- a fully graded course reaches `courseScoreBp: 10000`, `pending: []`, and `attemptCommercialV1CourseCompletion` returns `COMPLETED` with a receipt, then `ALREADY_COMPLETED` with the identical receipt on replay (idempotent, no duplicate receipt row, exactly one `commercial_v1_completion_receipts` row);
- `COMPONENTS_INCOMPLETE` when any component or the lab lacks a current result, leaving the enrolment `ACTIVE`;
- `BELOW_PASS_MARK` when the deterministic score is under the published threshold, leaving the enrolment `ACTIVE`;
- a foreign learner is denied both progress reads and completion attempts with the same bounded `NOT_FOUND_OR_FORBIDDEN`, never leaking existence, and mutates nothing;
- an admin can read another learner's progress (the existing staff-read allowance) without mutating anything.

## A real defect found and fixed during this checkpoint (Checkpoint A test fixture, not production)

Building this checkpoint's fixtures surfaced a genuine bug in Checkpoint A's own test-owner seeding helpers (`seedOriginalExecution`/`seedActiveOriginalExecution`, `tests/commercial-v1-examiner-recovery-fixture.ts`): the raw INSERT into `commercial_v1_examiner_executions` called `clock_timestamp()` separately for `created_at` and `authorized_at`, which migration 031's own `check(authorized_at is null or authorized_at=created_at)` requires to be **exactly** equal. Two separate `clock_timestamp()` evaluations in the same statement normally round to the same microsecond under fast execution, but genuinely diverged under heavy system load during this session's own full-suite run, producing a real (if load-dependent) CHECK-constraint failure that skipped all 50 of that file's tests. Fixed by capturing `clock_timestamp()` once via a `with stamp as (select clock_timestamp() as t)` CTE and deriving every timestamp column from that single captured value — exactly how the production SQL functions themselves capture one `stamp := clock_timestamp()` and reuse it. This is a test-fixture defect only; no production migration or runtime code was affected, and Checkpoint A's own reported test totals and gate results are otherwise unchanged.

## Known limitations

- No admin picker UI for binding components/practicals (Server Actions exist and are tested; the interactive page does not).
- No learner UI showing individual question-level detail, only the bounded progress/diagnostics projection.
- Remediation resolution/reconciliation itself is unchanged (migration 030's existing authority); this checkpoint only reads the resulting open-remediation count.
- No hosted provider call was made or attempted; no hosted Supabase acceptance is claimed.
