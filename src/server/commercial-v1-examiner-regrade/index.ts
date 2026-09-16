import "server-only";
import { randomUUID } from "node:crypto";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import {
  EXAMINER_RUNTIME_PROFILE_REF,
  examinerUsageReportSchema,
  mapExaminerAssessmentRuntimeResultToFinalizeCommand,
  mapExaminerLabRuntimeResultToFinalizeCommand,
} from "@/domain/commercial-v1-examiner-grading";
import {
  regradeInputSchema,
  RegradeDenied,
  type RegradeCapability,
  type RegradeResult,
  type RegradeSnapshot,
} from "@/domain/commercial-v1-examiner-regrade";
import { attestRegradeCommand, requireRegradeActor } from "./authority";
import { getRegradeContext } from "./context";
import {
  resolveRuntimeProfile,
  resolveAdapterForProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";

function outcome(s: RegradeSnapshot, replay = false): RegradeResult {
  if (s.state === "SUCCEEDED" && s.resultRevisionId)
    return {
      status: replay ? "ALREADY_REGRADED" : "REGRADED",
      executionId: s.executionId,
      resultRevisionId: s.resultRevisionId,
    };
  return { status: s.state === "ESCALATED" ? "ESCALATED" : "UNAVAILABLE" };
}
function denial(error: unknown): RegradeResult {
  if (error instanceof RegradeDenied) {
    if (error.code === "REPLAY_REJECTED" || error.code === "RATE_LIMITED")
      return { status: "RETRY_LATER" };
    if (
      error.code === "NOT_CURRENT_RESULT" ||
      error.code === "CURRENT_RESULT_INVALID" ||
      error.code === "TARGET_NOT_ELIGIBLE"
    )
      return { status: error.code };
  }
  return { status: "UNAVAILABLE" };
}
async function regrade(
  input: unknown,
  capability: RegradeCapability,
): Promise<RegradeResult> {
  const parsed = regradeInputSchema.safeParse(input);
  if (!parsed.success) return { status: "UNAVAILABLE" };
  const identity = {
    sourceResultRevisionId: parsed.data.resultRevisionId,
    requestReason: parsed.data.reason,
    capability,
  };
  let snapshot: RegradeSnapshot | null = null;
  let providerResult: RuntimeResult | null = null;
  let providerEntered = false;
  try {
    await requireRegradeActor();
    const profile = resolveRuntimeProfile(EXAMINER_RUNTIME_PROFILE_REF);
    if (!profile) return { status: "UNAVAILABLE" };
    const proposedId = randomUUID();
    const admitted = await attestRegradeCommand(proposedId, {
      ...identity,
      operation: "AUTHORIZE",
      budget: {
        maxProviderCalls: 1,
        maxOutputTokens: profile.budgetPolicy.maxOutputTokens,
        maxEstimatedCostMicrousd: profile.budgetPolicy.maxEstimatedCostMicrousd,
      },
    });
    if (!admitted.transitioned || admitted.snapshot.executionId !== proposedId)
      return outcome(admitted.snapshot, true);
    snapshot = admitted.snapshot;
    snapshot = (
      await attestRegradeCommand(snapshot.executionId, {
        ...identity,
        operation: "START",
        snapshot,
      })
    ).snapshot;
    const protectedContext = await getRegradeContext(
      snapshot,
      identity.requestReason,
    );
    providerEntered = true;
    providerResult = await runGovernedProviderExecution(
      resolveAdapterForProfile(profile),
      { role: "EXAMINER", capability, context: protectedContext.context },
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
    if (!finalize) return { status: "UNAVAILABLE" }; // Unknown usage must never be invented as zero.
    return outcome(
      (
        await attestRegradeCommand(snapshot.executionId, {
          ...identity,
          operation: "FINALIZE",
          snapshot,
          ...finalize,
        })
      ).snapshot,
    );
  } catch (error) {
    const usage =
      providerResult?.usage ?? (providerEntered ? null : zeroUsage());
    if (
      snapshot &&
      !(error instanceof RegradeDenied && error.databaseTerminal) &&
      examinerUsageReportSchema.safeParse(usage).success
    ) {
      try {
        await attestRegradeCommand(snapshot.executionId, {
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
        return { status: "UNAVAILABLE" };
      } // DB expiry remains backstop; never deliver a grade.
    }
    return denial(error);
  }
}
export async function regradeControlledAssessment(input: unknown) {
  return regrade(input, "regrade_controlled_assessment");
}
export async function regradePracticalLab(input: unknown) {
  return regrade(input, "regrade_practical_lab");
}
