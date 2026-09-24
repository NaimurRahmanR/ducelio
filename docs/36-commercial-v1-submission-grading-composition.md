# Commercial V1 — Safe Submission → Examiner Grading Composition

## Scope

Checkpoint B of the Commercial V1 grading/recovery/completion chain, starting from Checkpoint A's local commit `f407526` (uncommitted-in-main, branch `commercial-v1-grading-completion`). No migration is added; this checkpoint is pure server/Server-Action composition over existing, unmodified governed authorities: `submitAssessmentAttempt`/`submitCommercialV1LabWork` (institutional submission truth) and `gradeControlledAssessmentAttempt`/`gradePracticalLabSubmission` (the existing, already learner-self-scoped, migration 031/036 initial-grading authority).

## The problem this closes

Before this checkpoint, a learner's submission and Examiner grading were composed nowhere: `finishControlledAssessment` called only `submitAssessmentAttempt`, and no learner-facing Server Action existed for the final lab-submission RPC at all (only Tutor/Lab Instructor _conversational_ assistance was wired). A submitted attempt or lab work therefore sat SUBMITTED forever unless something else happened to call the grading entrypoint — nothing did.

## Non-negotiable invariant

A valid learner submission must never be lost, rolled back or reported as failed because Examiner/provider grading fails. These are two separate authority boundaries, never one pseudo-transaction:

- **Transaction 1** — `submitAssessmentAttempt` / `submitCommercialV1LabWork` (unmodified). Once it returns, the work is durably institutional truth.
- **Transaction 2+** — `gradeControlledAssessmentAttempt` / `gradePracticalLabSubmission` (unmodified), invoked only after Transaction 1 commits, using only the server-derived id it returned.

`src/server/commercial-v1-submission-grading.ts`'s `orchestrateInitialExaminerGrading` wraps the ENTIRE grading call in a try/catch that converts any exception — including one the grading entrypoint's own internal `ExaminerExecutionDenied`-only catch would otherwise rethrow — to the safe `GRADING_UNAVAILABLE` outcome. This is deliberately more defensive than `gradeExaminerTarget`'s own catch (which rethrows a non-`ExaminerExecutionDenied` error): a composition boundary whose entire job is "never let this affect the submission" cannot rely on the callee to have anticipated every failure mode.

## Idempotency and interruption recovery

No new idempotency mechanism is introduced; both non-negotiable behaviours are inherited entirely from the two existing governed authorities:

- **Replay after a resolved outcome** (success or terminal failure): `submitAssessmentAttempt`/`submitCommercialV1LabWork` are themselves idempotent (a `SUBMITTED` attempt returns its own id; an identical-body/key lab resubmission returns the existing submission id). Migration 031's exact-target-first AUTHORIZE ordering then returns the existing (possibly terminal) claim rather than ever admitting a second provider call — proven directly: calling the composition twice creates exactly one `commercial_v1_examiner_executions` row.
- **Interruption between submission and grading admission** (the request dies after Transaction 1 commits but before Transaction 2 is ever reached): the next explicit resubmission naturally discovers the already-SUBMITTED/already-inserted target and gives grading its first real admission attempt. No separate "retry" surface was built — the same submit action, called again, is itself the safe replay path. Proven directly with a test that calls the underlying submission RPC alone (simulating the interruption), then calls the composition function and confirms exactly one grading claim is created, with no duplicate submission.
- **A terminal unsuccessful execution is never automatically retried** — by construction (migration 031's one-claim-per-target guarantee, unchanged) and confirmed directly.

## Outcome contract — deliberately coarser than the underlying authority

`SubmissionGradingOutcome = "GRADED" | "ESCALATED" | "GRADING_PENDING" | "GRADING_UNAVAILABLE"`. `ExaminerGradingResult`'s `GRADED`/`ALREADY_GRADED` both map to `GRADED` (the learner never needs to know which); `RETRY_LATER` maps to `GRADING_PENDING`; `TARGET_NOT_ELIGIBLE` and `UNAVAILABLE` both map to `GRADING_UNAVAILABLE`. This last collapse is deliberate, not a missing feature: `gradeControlledAssessmentAttempt`/`gradePracticalLabSubmission` are themselves learner-self-scoped and never surface execution-row internals (reason codes, config state), so there is no field available at this boundary to distinguish "not configured for this course" from "terminally failed, eligible for Checkpoint A's institutional recovery" — inventing that distinction here would mean inferring it from information the reviewed entrypoint deliberately does not expose to a STUDENT-scoped caller. Both cases correctly look identical to the learner: "your work is submitted; grading has not produced a result." Recovery itself remains `ACADEMIC_ADMIN`/`PLATFORM_ADMIN`-only and is never named, selected or hinted at in any learner-facing message.

## Server Actions

`finishControlledAssessment` (`src/app/student/actions.ts`) now calls `submitControlledAssessmentAndGrade` instead of the raw submission wrapper, appending one calm, fixed sentence per non-`GRADED` outcome to the existing "Assessment submitted." message — never a reason code, provider detail or the word "recovery." `submitPracticalLabWorkAction` (`src/app/student/practicals/actions.ts`) is new: the first learner-facing Server Action for the governed FINAL lab submission, structurally distinct from `requestTutorLabSupportAction`'s conversational assistance (proven directly: a support request creates no `commercial_v1_lab_submissions` row). Its idempotency key is derived deterministically from `(enrolmentId, practicalId)` in the UI layer (`LabWorkSubmission` in `src/components/practical-support.tsx`) rather than randomly regenerated per render, so a genuine resubmission after a lost response reuses the same key. Both actions accept only the fields already on the underlying governed input schemas; neither the assessment nor the lab action has any field through which a browser could select a capability, provider, model, marks or a recovery path — proven directly by asserting the exact argument object each composition function receives, ignoring hostile extra form fields.

## Tests

72 focused tests across four new files: 14 database-level (`tests/commercial-v1-submission-grading-db.test.ts` — real PGlite end-to-end through the actual production HMAC signer and migration 031's real AUTHORIZE→START→CONTEXT_READ→FINALIZE chain, no provider configured; submission durability under a real no-provider outcome and under a simulated RPC transport failure; interruption-recovery for both assessment and lab targets; replay creates no second claim; AUTO_TIMEOUT provenance preserved; foreign-learner denial; Tutor/Lab support creates no final-submission row); 9 runtime-level (`tests/commercial-v1-submission-grading-runtime.test.ts`, fully mocked at the same boundaries `tests/commercial-v1-examiner-grading-runtime.test.ts` already uses — proves a real `GRADED`/`ESCALATED` outcome, that a grading exception of any kind never affects the reported submission, and that a submission failure means grading is never attempted at all; a first draft of this suite's own mock silently swallowed a real assertion gap — see below); 13 action-level (`tests/commercial-v1-submission-grading-action.test.ts` — safe message mapping, no internal vocabulary leaked, hostile extra fields ignored). All pre-existing assessment/practicals/examiner-grading/recovery/regrade/results-completion tests continue to pass unmodified (434 tests across 14 files re-run as a direct regression check).

**A test-authoring defect found and fixed in this checkpoint (not a production defect):** the runtime suite's own mock of the grading authority's FINALIZE operation initially echoed a fixed outcome regardless of what the real finalize command actually requested, which would have silently passed a "malformed output" test as if it produced a fabricated `SUCCEEDED` grade. Caught immediately by the test itself failing, fixed by making the mock echo the real requested `state`/`reason`/`gradeDigest`, exactly as a real RPC confirms.

## Known limitations

- No admin-facing "check grading status" or "retry" surface exists; recovery from a terminal no-result target still requires Checkpoint A's own admin-only authority.
- No results/grade-viewing UI exists yet for the learner (Checkpoint C).
- Deliberately minimal lab-submission form styling — functional, not final UX, per this checkpoint's explicit scope.
- No hosted provider call was made or attempted.
