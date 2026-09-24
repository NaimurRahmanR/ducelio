import "server-only";
import type { ExaminerGradingResult } from "@/domain/commercial-v1-examiner-grading";
import { submitAssessmentAttempt } from "./assessments";
import { submitCommercialV1LabWork } from "./commercial-v1-results-completion";
import {
  gradeControlledAssessmentAttempt,
  gradePracticalLabSubmission,
} from "./commercial-v1-examiner-grading";

// ============================================================================
// Commercial V1 -- safe composition of an authoritative learner submission
// with the existing (learner-self-scoped) Examiner initial-grading entrypoint.
//
// TWO SEPARATE AUTHORITY BOUNDARIES, deliberately never one pseudo-
// transaction:
//   TRANSACTION 1 -- submitAssessmentAttempt / submitCommercialV1LabWork
//     (unmodified, existing governed RPCs). This is the institutional truth:
//     once it returns, the learner's work is durably SUBMITTED/final,
//     independent of anything that happens next.
//   TRANSACTION 2+ -- gradeControlledAssessmentAttempt / gradePracticalLabSubmission
//     (unmodified, existing migration-031/036 AUTHORIZE-START-FINALIZE
//     machinery, including its own one-claim-per-target uniqueness). Invoked
//     ONLY after Transaction 1 has durably committed, using ONLY the
//     server-derived id it returned -- never a client-supplied identifier,
//     capability, provider, model or recovery selector.
//
// A grading failure -- of any kind, including an unexpected exception this
// module has never seen before -- can never unwind, hide or falsify
// Transaction 1's outcome. The functions below always resolve with the real
// submitted id; grading status is reported as separate, additional
// information, never as a reason the submission itself "failed".
//
// Idempotency/replay is inherited entirely from the two existing governed
// authorities, not reimplemented here: a resubmission with the same
// idempotency key/body replays Transaction 1 to the same id (or, for a
// controlled assessment, submit_assessment_attempt is itself already
// idempotent once SUBMITTED); a repeated call into Transaction 2 against the
// same target either finds no existing Examiner claim yet (interrupted-
// request recovery: exactly one admission is attempted) or finds one
// already admitted/terminal (replay-safe: no second provider call, per
// migration 031's own exact-target-first AUTHORIZE ordering).
// ============================================================================

// The only status vocabulary ever returned to a learner-facing caller.
// Deliberately coarser than ExaminerGradingResult: GRADED subsumes a fresh
// grade and an idempotent replay of an existing one (the learner never
// needs to know which); GRADING_UNAVAILABLE subsumes every terminal/
// ineligible/configuration denial the underlying entrypoint can report --
// including a case a staff admin could recover -- because ExaminerGradingResult
// itself carries no field distinguishing "needs institutional recovery" from
// "not configured for this course" (by design: gradeControlledAssessmentAttempt/
// gradePracticalLabSubmission are learner-self-scoped and never surface
// execution-row internals). Recovery is a separate, ACADEMIC_ADMIN/
// PLATFORM_ADMIN-only action (Checkpoint A) that a learner never triggers,
// selects or is told about by name.
export type SubmissionGradingOutcome =
  "GRADED" | "ESCALATED" | "GRADING_PENDING" | "GRADING_UNAVAILABLE";

function mapGradingResult(
  result: ExaminerGradingResult,
): SubmissionGradingOutcome {
  switch (result.status) {
    case "GRADED":
    case "ALREADY_GRADED":
      return "GRADED";
    case "ESCALATED":
      return "ESCALATED";
    case "RETRY_LATER":
      return "GRADING_PENDING";
    case "TARGET_NOT_ELIGIBLE":
    case "UNAVAILABLE":
      return "GRADING_UNAVAILABLE";
  }
}

type GradingTarget =
  | { kind: "ASSESSMENT_ATTEMPT"; attemptId: string }
  | { kind: "LAB_SUBMISSION"; submissionId: string };

// Best-effort only: any exception here (transport, an unforeseen provider
// condition, anything not already normalised into ExaminerGradingResult by
// the grading entrypoint itself) is swallowed and reported as
// GRADING_UNAVAILABLE. It is never rethrown -- the caller's own durable
// submission id, captured before this function is ever invoked, is already
// final regardless of what happens here.
async function orchestrateInitialExaminerGrading(
  target: GradingTarget,
): Promise<SubmissionGradingOutcome> {
  try {
    const result =
      target.kind === "ASSESSMENT_ATTEMPT"
        ? await gradeControlledAssessmentAttempt({
            attemptId: target.attemptId,
          })
        : await gradePracticalLabSubmission({
            submissionId: target.submissionId,
          });
    return mapGradingResult(result);
  } catch {
    return "GRADING_UNAVAILABLE";
  }
}

export type SubmissionGradingResult<Id extends string> = {
  grading: SubmissionGradingOutcome;
} & Record<Id, string>;

// Submits the controlled-assessment attempt (Transaction 1, unmodified),
// then -- only once that has durably committed -- attempts the existing
// initial Examiner grading admission for the exact id it returned
// (Transaction 2+). Safe to call again for an already-SUBMITTED attempt: the
// submission RPC is itself idempotent once SUBMITTED, and a repeated grading
// attempt either discovers no claim yet (recovers a request that was
// interrupted before admission) or the existing one (replay-safe).
export async function submitControlledAssessmentAndGrade(
  attemptId: unknown,
): Promise<SubmissionGradingResult<"attemptId">> {
  const submittedAttemptId = await submitAssessmentAttempt(attemptId);
  const grading = await orchestrateInitialExaminerGrading({
    kind: "ASSESSMENT_ATTEMPT",
    attemptId: submittedAttemptId,
  });
  return { attemptId: submittedAttemptId, grading };
}

// Submits the final practical/lab work (Transaction 1, unmodified -- this is
// the governed FINAL submission, structurally distinct from Tutor/Lab
// Instructor conversational assistance), then attempts initial Examiner
// grading for the exact submission id returned. submitCommercialV1LabWork is
// itself submit-once/idempotent-on-identical-replay per practical.
export async function submitPracticalLabWorkAndGrade(
  input: unknown,
): Promise<SubmissionGradingResult<"submissionId">> {
  const submissionId = await submitCommercialV1LabWork(input);
  const grading = await orchestrateInitialExaminerGrading({
    kind: "LAB_SUBMISSION",
    submissionId,
  });
  return { submissionId, grading };
}
