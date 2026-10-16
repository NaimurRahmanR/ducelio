import "server-only";
import { randomUUID } from "node:crypto";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import {
  examinerProviderContext,
  examinerRequiresProvider,
  examinerUsageReportSchema,
  mapExaminerAssessmentRuntimeResultToFinalizeCommand,
  mapExaminerDeterministicAssessmentToFinalizeCommand,
  mapExaminerLabRuntimeResultToFinalizeCommand,
} from "@/domain/commercial-v1-examiner-grading";
import {
  recoveryInputSchema,
  RecoveryDenied,
  type RecoveryCapability,
  type RecoveryResult,
  type RecoverySnapshot,
} from "@/domain/commercial-v1-examiner-recovery";
import { attestRecoveryCommand, requireRecoveryActor } from "./authority";
import { getRecoveryContext } from "./context";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";

function outcome(s: RecoverySnapshot, replay: boolean): RecoveryResult {
  if (s.state === "SUCCEEDED" && s.resultRevisionId)
    return {
      status: replay ? "ALREADY_RECOVERED" : "RECOVERED",
      resultRevisionId: s.resultRevisionId,
    };
  if (s.state === "ESCALATED") return { status: "ESCALATED" };
  // FAILED / BUDGET_BLOCKED / TIMEOUT / CANCELLED: honest terminal, no
  // further automatic retry -- the recovery ceiling is exactly one claim.
  return { status: "UNAVAILABLE" };
}
function denial(error: unknown): RecoveryResult {
  if (error instanceof RecoveryDenied) {
    if (error.code === "REPLAY_REJECTED" || error.code === "RATE_LIMITED")
      return { status: "RETRY_LATER" };
    if (
      error.code === "TARGET_NOT_ELIGIBLE" ||
      error.code === "NOT_FOUND_OR_FORBIDDEN"
    )
      return { status: "TARGET_NOT_ELIGIBLE" };
  }
  return { status: "UNAVAILABLE" };
}

// THE single governed entrypoint for Commercial V1 Examiner initial-grade
// recovery. Identifier-only input (sourceExecutionId + bounded reason);
// every other value is derived and validated entirely server-side. Mirrors
// gradeExaminerTarget's (src/server/commercial-v1-examiner-grading/index.ts)
// config-aware profile-resolution ordering exactly: the pre-AUTHORIZE
// proposal below only ever bounds the PROPOSED budget envelope (it can never
// itself widen what the database actually admits); the runtime profile
// actually used to execute is re-resolved strictly from the DB-admitted
// snapshot's own immutable runtimeProfileRef after AUTHORIZE returns.
async function recover(
  input: unknown,
  capability: RecoveryCapability,
): Promise<RecoveryResult> {
  const parsed = recoveryInputSchema.safeParse(input);
  if (!parsed.success) return { status: "UNAVAILABLE" };
  const identity = {
    sourceExecutionId: parsed.data.sourceExecutionId,
    recoveryReason: parsed.data.reason,
    capability,
  };
  let snapshot: RecoverySnapshot | null = null;
  let providerResult: RuntimeResult | null = null;
  let started = false;
  // providerEntered distinguishes "the provider call was never attempted"
  // (zero usage is truthful) from "the provider call was attempted but threw
  // before runGovernedProviderExecution could return a structured result"
  // (usage is genuinely UNKNOWN -- never invented as zero). Returning null
  // here means the caller skips the cleanup FINALIZE entirely and leaves the
  // execution to the existing DB-owned 20-second expiry safety mechanism,
  // rather than risk fabricating a truthful-looking but wrong usage record.
  let providerEntered = false;
  function lastKnownUsage() {
    if (providerResult) return providerResult.usage;
    return providerEntered ? null : zeroUsage();
  }
  try {
    await requireRecoveryActor();
    const proposalProfile = resolveRoleBoundRuntimeProfile("EXAMINER", null);
    if (!proposalProfile) return { status: "UNAVAILABLE" };
    const proposedId = randomUUID();
    const admitted = await attestRecoveryCommand(proposedId, {
      ...identity,
      operation: "AUTHORIZE",
      budget: {
        maxProviderCalls: 1,
        maxOutputTokens: proposalProfile.budgetPolicy.maxOutputTokens,
        maxEstimatedCostMicrousd:
          proposalProfile.budgetPolicy.maxEstimatedCostMicrousd,
      },
    });
    // A pre-existing claim (possibly terminal) already occupies this exact
    // original execution -- idempotent replay, no provider call is ever
    // made here.
    if (!admitted.transitioned || admitted.snapshot.executionId !== proposedId)
      return outcome(admitted.snapshot, true);
    snapshot = admitted.snapshot;
    // A direct config-governed ESCALATED claim (escalationPolicy=
    // ACADEMIC_REVIEW) returns here, before any profile re-resolution,
    // START or provider call -- no usage row is ever written for it.
    if (snapshot.state === "ESCALATED") return outcome(snapshot, false);

    const profile = resolveRoleBoundRuntimeProfile(
      "EXAMINER",
      snapshot.runtimeProfileRef,
    );
    if (!profile) return { status: "UNAVAILABLE" };

    snapshot = (
      await attestRecoveryCommand(snapshot.executionId, {
        ...identity,
        operation: "START",
        snapshot,
      })
    ).snapshot;
    started = true;
    const protectedContext = await getRecoveryContext(
      snapshot,
      identity.recoveryReason,
    );
    // CP2: objective marks are DB-computed; with no free-text answer to
    // judge, recovery finalizes without any provider call.
    if (
      protectedContext.kind === "ASSESSMENT" &&
      !examinerRequiresProvider(protectedContext.context)
    )
      return outcome(
        (
          await attestRecoveryCommand(snapshot.executionId, {
            ...identity,
            operation: "FINALIZE",
            snapshot,
            ...mapExaminerDeterministicAssessmentToFinalizeCommand(
              protectedContext.context,
            ),
          })
        ).snapshot,
        false,
      );
    const adapter = resolveAdapterForProfile(profile);
    providerEntered = true;
    providerResult = await runGovernedProviderExecution(
      adapter,
      {
        role: "EXAMINER",
        capability,
        context:
          protectedContext.kind === "ASSESSMENT"
            ? examinerProviderContext(protectedContext.context)
            : protectedContext.context,
      },
      profile.budgetPolicy,
    );
    const finalize =
      protectedContext.kind === "ASSESSMENT"
        ? mapExaminerAssessmentRuntimeResultToFinalizeCommand(
            providerResult,
            protectedContext.context,
          )
        : mapExaminerLabRuntimeResultToFinalizeCommand(
            providerResult,
            protectedContext.context,
          );
    // Unknown/malformed observed usage must never be invented as zero -- no
    // FINALIZE call is made at all; the execution is left to the existing
    // DB-owned 20-second expiry safety mechanism.
    if (!finalize) return { status: "UNAVAILABLE" };
    return outcome(
      (
        await attestRecoveryCommand(snapshot.executionId, {
          ...identity,
          operation: "FINALIZE",
          snapshot,
          ...finalize,
        })
      ).snapshot,
      false,
    );
  } catch (error) {
    if (
      snapshot &&
      started &&
      !(error instanceof RecoveryDenied && error.databaseTerminal)
    ) {
      const usage = lastKnownUsage();
      if (usage && examinerUsageReportSchema.safeParse(usage).success) {
        try {
          await attestRecoveryCommand(snapshot.executionId, {
            ...identity,
            operation: "FINALIZE",
            snapshot,
            state: "FAILED",
            reason: "INTERNAL_ERROR",
            budgetStage: null,
            usage: examinerUsageReportSchema.parse(usage),
            gradeDigest: null,
            assessmentMarks: null,
            labMarksAwarded: null,
          });
        } catch {
          // Lazy DB-owned expiry remains the backstop.
        }
      }
    }
    return denial(error);
  }
}

export async function recoverControlledAssessmentGrade(input: unknown) {
  return recover(input, "grade_controlled_assessment");
}
export async function recoverPracticalLabGrade(input: unknown) {
  return recover(input, "grade_practical_lab");
}
