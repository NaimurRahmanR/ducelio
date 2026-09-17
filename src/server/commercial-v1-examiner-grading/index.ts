import "server-only";
import { randomUUID } from "node:crypto";
import {
  EXAMINER_CAPABILITY_TARGET_KIND,
  EXAMINER_EXECUTION_DB_CEILING,
  ExaminerExecutionDenied,
  gradeControlledAssessmentInputSchema,
  gradePracticalLabInputSchema,
  mapExaminerAssessmentRuntimeResultToFinalizeCommand,
  mapExaminerLabRuntimeResultToFinalizeCommand,
  type ExaminerCapability,
  type ExaminerExecutionSnapshot,
  type ExaminerGradingResult,
} from "@/domain/commercial-v1-examiner-grading";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import { requireStudentPrincipal } from "../identity";
import { attestExaminerExecutionCommand } from "./authority";
import { getExaminerAssessmentContext, getExaminerLabContext } from "./context";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";

// Blocker 5 (independent review, V2): every snapshot this function ever
// receives is already terminal (a fresh FINALIZE result, or the existing
// terminal row returned by an AUTHORIZE replay -- migration 031 never
// returns a non-terminal snapshot from either path). 11B1 deliberately has
// no regrade/retry authority, so a terminal FAILED/BUDGET_BLOCKED/TIMEOUT/
// CANCELLED outcome is never reported as a retryable status: RETRY_LATER
// is reserved for genuinely transient PRE-terminal conditions (an active
// claim, admission rate limiting), handled in mapDenialToResult below, not
// here.
function mapSnapshotToResult(
  snapshot: ExaminerExecutionSnapshot,
  isNewClaim: boolean,
): ExaminerGradingResult {
  if (snapshot.state === "SUCCEEDED") {
    return isNewClaim
      ? { status: "GRADED", resultRevisionId: snapshot.resultRevisionId! }
      : {
          status: "ALREADY_GRADED",
          resultRevisionId: snapshot.resultRevisionId,
        };
  }
  if (snapshot.state === "ESCALATED") return { status: "ESCALATED" };
  // FAILED / BUDGET_BLOCKED / TIMEOUT / CANCELLED: honest terminal, no
  // retry authority exists in 11B1.
  return { status: "UNAVAILABLE" };
}

function mapDenialToResult(
  error: ExaminerExecutionDenied,
): ExaminerGradingResult {
  if (error.code === "ALREADY_GRADED")
    return { status: "ALREADY_GRADED", resultRevisionId: null };
  if (
    error.code === "TARGET_NOT_ELIGIBLE" ||
    error.code === "NOT_FOUND_OR_FORBIDDEN"
  )
    return { status: "TARGET_NOT_ELIGIBLE" };
  // Genuinely transient, pre-terminal conditions only: an already-active
  // claim (RATE_LIMITED covers both real admission throttling and "one
  // AUTHORIZED/RUNNING execution per student" — see migration 031) or a
  // lost race against a concurrent AUTHORIZE for the same target
  // (REPLAY_REJECTED while the other claim is still non-terminal).
  if (error.code === "RATE_LIMITED" || error.code === "REPLAY_REJECTED")
    return { status: "RETRY_LATER" };
  // OUT_OF_ENVELOPE is a configuration/policy failure (the admitted budget
  // could never satisfy the DB ceiling), not a transient condition a
  // caller can usefully retry.
  return { status: "UNAVAILABLE" };
}

// The single governed entrypoint for Commercial V1 Examiner grading.
// Identifier-only input (attemptId/submissionId); every other value
// (marks, weights, expected answers, provenance, revision numbers) is
// derived and validated entirely server-side. Preserves the same critical
// guarantee documented in migration 031 and docs/25-commercial-v1-examiner-
// grading.md: the institutional result and the execution's SUCCEEDED state
// are written atomically, inside the database's own single FINALIZE
// transaction, under the same enrolment row lock
// attempt_commercial_v1_course_completion uses -- never orchestrated across
// separate TypeScript-level steps the way the Professor/Tutor/Lab release
// lifecycle is.
async function gradeExaminerTarget(
  capability: ExaminerCapability,
  target: { attemptId: string | null; submissionId: string | null },
): Promise<ExaminerGradingResult> {
  await requireStudentPrincipal();
  const targetKind = EXAMINER_CAPABILITY_TARGET_KIND[capability];
  // PR16A: this pre-AUTHORIZE resolution exists ONLY to propose a bounded
  // budget envelope -- EXAMINER's frozen role policy (src/domain/academic-
  // runtime-profile.ts's ROLE_RUNTIME_PROFILE_POLICY.EXAMINER,
  // DEFAULT_TO_ROLE_PROFILE) means a null ref always resolves to this exact
  // same profile, so proposing against it here can never itself widen what
  // AUTHORIZE actually admits. It is NOT what the provider call executes
  // with -- see the re-resolution from snapshot.runtimeProfileRef below,
  // which is the actual DB-admitted authority (frozen chain: current DB
  // config -> DB AUTHORIZE -> immutable execution.runtime_profile_ref ->
  // snapshot.runtimeProfileRef -> role-bound server profile resolution).
  const proposalProfile = resolveRoleBoundRuntimeProfile("EXAMINER", null);
  if (!proposalProfile) return { status: "UNAVAILABLE" };

  const proposedExecutionId = randomUUID();
  let authorizeResult;
  try {
    authorizeResult = await attestExaminerExecutionCommand(
      proposedExecutionId,
      {
        operation: "AUTHORIZE",
        capability,
        targetKind,
        attemptId: target.attemptId,
        submissionId: target.submissionId,
        budget: {
          maxProviderCalls: EXAMINER_EXECUTION_DB_CEILING.maxProviderCalls,
          maxOutputTokens: Math.min(
            proposalProfile.budgetPolicy.maxOutputTokens,
            EXAMINER_EXECUTION_DB_CEILING.maxOutputTokens,
          ),
          maxEstimatedCostMicrousd: Math.min(
            proposalProfile.budgetPolicy.maxEstimatedCostMicrousd,
            EXAMINER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
          ),
        },
      },
    );
  } catch (error) {
    if (error instanceof ExaminerExecutionDenied)
      return mapDenialToResult(error);
    throw error;
  }

  const { snapshot } = authorizeResult;
  // A pre-existing claim (possibly terminal) already occupies this exact
  // target -- idempotent replay, no provider call is ever made here.
  if (snapshot.executionId !== proposedExecutionId) {
    return mapSnapshotToResult(snapshot, false);
  }
  // PR16A: AUTHORIZE itself may now durably create a terminal ESCALATED
  // claim (programme-version EXAMINER config escalationPolicy=
  // ACADEMIC_REVIEW) -- a direct escalation returns here, before any
  // profile resolution, START or provider call. No usage row is ever
  // written for it (migration 036).
  if (snapshot.state === "ESCALATED") {
    return mapSnapshotToResult(snapshot, true);
  }
  // The actual execution authority: re-resolve strictly from the DB-
  // admitted snapshot's own immutable runtimeProfileRef, never re-defaulted
  // from null and never the pre-AUTHORIZE proposalProfile above.
  const profile = resolveRoleBoundRuntimeProfile(
    "EXAMINER",
    snapshot.runtimeProfileRef,
  );
  if (!profile) return { status: "UNAVAILABLE" };

  const identity = {
    capability,
    targetKind,
    attemptId: target.attemptId,
    submissionId: target.submissionId,
    enrolmentId: snapshot.enrolmentId,
    activationId: snapshot.activationId,
  } as const;

  let started = false;
  // Blocker 4 (independent review, V2): once a provider call/runtime
  // execution has actually happened, its REAL usage must never be lost.
  // lastKnownUsage() is the single source of truth for every cleanup path
  // below -- zeroUsage() is correct ONLY before any provider execution has
  // consumed usage; it is never used to paper over a later failure that
  // happened after a real (possibly non-zero) usage was already observed.
  let providerResult: RuntimeResult | null = null;
  function lastKnownUsage() {
    return providerResult ? providerResult.usage : zeroUsage();
  }
  try {
    await attestExaminerExecutionCommand(snapshot.executionId, {
      operation: "START",
      ...identity,
    });
    started = true;
    const adapter = resolveAdapterForProfile(profile);

    if (capability === "grade_controlled_assessment") {
      const context = await getExaminerAssessmentContext(snapshot.executionId, {
        attemptId: target.attemptId!,
        enrolmentId: snapshot.enrolmentId!,
        activationId: snapshot.activationId!,
      });
      providerResult = await runGovernedProviderExecution(
        adapter,
        { role: "EXAMINER", capability, context },
        profile.budgetPolicy,
      );
      const finalizeCommand =
        mapExaminerAssessmentRuntimeResultToFinalizeCommand(
          providerResult,
          context,
        );
      // Blocker 3 (independent review, V3): a null finalizeCommand means
      // the observed usage itself failed the domain invariant (never a
      // legitimate reason to invent zero usage). No FINALIZE call is made
      // at all here -- the execution is left to the existing DB-owned
      // 20-second expiry safety mechanism rather than risk fabricating an
      // institutional usage record.
      if (!finalizeCommand) return { status: "UNAVAILABLE" };
      const finalized = await attestExaminerExecutionCommand(
        snapshot.executionId,
        {
          operation: "FINALIZE",
          ...identity,
          ...finalizeCommand,
        },
      );
      return mapSnapshotToResult(finalized.snapshot, true);
    }

    const context = await getExaminerLabContext(snapshot.executionId, {
      submissionId: target.submissionId!,
      enrolmentId: snapshot.enrolmentId!,
      activationId: snapshot.activationId!,
    });
    providerResult = await runGovernedProviderExecution(
      adapter,
      { role: "EXAMINER", capability, context },
      profile.budgetPolicy,
    );
    const finalizeCommand = mapExaminerLabRuntimeResultToFinalizeCommand(
      providerResult,
      context,
    );
    if (!finalizeCommand) return { status: "UNAVAILABLE" };
    const finalized = await attestExaminerExecutionCommand(
      snapshot.executionId,
      {
        operation: "FINALIZE",
        ...identity,
        ...finalizeCommand,
      },
    );
    return mapSnapshotToResult(finalized.snapshot, true);
  } catch (error) {
    if (!(error instanceof ExaminerExecutionDenied)) throw error;
    if (started && !error.databaseTerminal) {
      try {
        await attestExaminerExecutionCommand(snapshot.executionId, {
          operation: "FINALIZE",
          ...identity,
          state: "FAILED",
          reason: "INTERNAL_ERROR",
          budgetStage: null,
          // The real usage already consumed (if any provider call
          // happened) must survive this cleanup FINALIZE -- never
          // silently coerced or erased to zero merely because a LATER
          // step (e.g. the success FINALIZE transport call itself)
          // failed.
          usage: lastKnownUsage(),
          gradeDigest: null,
          assessmentMarks: null,
          labMarksAwarded: null,
        });
      } catch {
        // Lazy DB-owned expiry remains the backstop.
      }
    }
    return { status: "UNAVAILABLE" };
  }
}

export async function gradeControlledAssessmentAttempt(
  input: unknown,
): Promise<ExaminerGradingResult> {
  const { attemptId } = gradeControlledAssessmentInputSchema.parse(input);
  return gradeExaminerTarget("grade_controlled_assessment", {
    attemptId,
    submissionId: null,
  });
}

export async function gradePracticalLabSubmission(
  input: unknown,
): Promise<ExaminerGradingResult> {
  const { submissionId } = gradePracticalLabInputSchema.parse(input);
  return gradeExaminerTarget("grade_practical_lab", {
    attemptId: null,
    submissionId,
  });
}
