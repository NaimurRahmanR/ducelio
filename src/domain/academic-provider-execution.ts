import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";
import {
  executionErrorSchema,
  type ExecutionErrorCode,
} from "./academic-execution";
import type { RuntimeResult } from "./academic-runtime";

// Commercial V1: trusted live Professor provider-backed execution (V2).
// Distinct, separately identifiable governance surface from migration 022's
// historical PROFESSOR_EXECUTION_V1/CONTROL_PLANE_ONLY path (unchanged,
// zero-budget, see src/domain/academic-execution.ts). This module describes
// migration 025's academic_provider_executions/academic_provider_execution_
// usage contract: the DB independently owns and enforces the hard budget
// ceiling below via table CHECK constraints, never a value a browser,
// course package, stored agent configuration or runtime profile can widen.
export const PROFESSOR_EXECUTION_POLICY_V2 = "PROFESSOR_EXECUTION_V2" as const;
export const PROVIDER_BACKED_EXECUTION_KIND = "PROVIDER_BACKED_V1" as const;

// Must stay byte-for-byte in step with migration 025's table CHECK
// constraints on academic_provider_executions (max_provider_calls,
// max_output_tokens, max_estimated_cost_microusd). A runtime profile's own
// budgetPolicy (src/domain/academic-runtime-profile.ts) must independently
// stay within these; the DB re-enforces them regardless at AUTHORIZE time,
// so a compromised/corrupt request can never widen them.
export const PROVIDER_EXECUTION_DB_CEILING = Object.freeze({
  maxProviderCalls: 3,
  maxOutputTokens: 4000,
  maxEstimatedCostMicrousd: 200_000,
});

export const providerExecutionBudgetProposalSchema = z.strictObject({
  maxProviderCalls: z
    .number()
    .int()
    .min(1)
    .max(PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls),
  maxOutputTokens: z
    .number()
    .int()
    .min(1)
    .max(PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens),
  maxEstimatedCostMicrousd: z
    .number()
    .int()
    .min(1)
    .max(PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd),
});
export type ProviderExecutionBudgetProposal = z.infer<
  typeof providerExecutionBudgetProposalSchema
>;

// Matches migration 025's academic_provider_execution_usage table CHECK
// bounds exactly. This is what may actually be persisted; it contains no
// prompt, response, resource body or any other content field — there is
// structurally no field for any of that here or in the table.
export const providerExecutionUsageReportSchema = z.strictObject({
  providerCalls: z.number().int().min(0).max(3),
  attempts: z.number().int().min(0).max(3),
  inputTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  estimatedCostMicrousd: z.number().int().min(0).max(1_000_000_000),
  elapsedMs: z.number().int().min(0).max(60_000),
});
export type ProviderExecutionUsageReport = z.infer<
  typeof providerExecutionUsageReportSchema
>;

export const providerExecutionBudgetStageSchema = z.enum([
  "PRE_CALL",
  "POST_CALL",
]);

export const providerExecutionReasonSchema = z.enum([
  "NONE",
  "PROVIDER_COMPLETE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_REFUSED",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR",
  "OUTPUT_INVALID",
  "POLICY_BLOCKED",
  "CONTENT_RELEASE_UNAVAILABLE",
  "ACTIVITY_BLOCKED",
  "NO_PROVIDER_CONFIGURED",
  "UNKNOWN_MODEL_PROFILE",
  "NO_EXECUTION_PATH",
  "HUMAN_REVIEW_REQUIRED",
  "BUDGET_BLOCKED",
  "EXECUTION_TIMEOUT",
  "CANCELLED",
  "RATE_LIMITED",
  "OUT_OF_ENVELOPE",
]);
export type ProviderExecutionReason = z.infer<
  typeof providerExecutionReasonSchema
>;

const providerExecutionStateSchema = z.enum([
  "AUTHORIZED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ABSTAINED",
  "ESCALATED",
  "BUDGET_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
  "BLOCKED",
]);

export { executionErrorSchema as providerExecutionErrorSchema };
export type ProviderExecutionErrorCode = ExecutionErrorCode;

export const providerExecutionSnapshotSchema = z
  .strictObject({
    executionId: z.uuid(),
    studentId: z.uuid(),
    releaseId: z.uuid(),
    invocationId: z.uuid(),
    agentProfile: z.literal("PROFESSOR"),
    policyVersion: z.literal(PROFESSOR_EXECUTION_POLICY_V2),
    executionKind: z.literal(PROVIDER_BACKED_EXECUTION_KIND),
    state: providerExecutionStateSchema,
    reasonCode: providerExecutionReasonSchema.nullable(),
    budgetStage: providerExecutionBudgetStageSchema.nullable(),
    createdAt: academicTimestampSchema,
    authorizedAt: academicTimestampSchema.nullable(),
    startedAt: academicTimestampSchema.nullable(),
    terminalAt: academicTimestampSchema.nullable(),
    expiresAt: academicTimestampSchema,
    reviewPath: z.literal("ACADEMIC_REVIEW").nullable(),
    budget: providerExecutionBudgetProposalSchema,
    usage: providerExecutionUsageReportSchema.nullable(),
  })
  .superRefine((value, context) => {
    const created = Date.parse(value.createdAt),
      expires = Date.parse(value.expiresAt);
    const terminal = value.terminalAt ? Date.parse(value.terminalAt) : null;
    const started = value.startedAt ? Date.parse(value.startedAt) : null;
    const active = ["AUTHORIZED", "RUNNING"].includes(value.state);
    const validReasons: Record<string, readonly string[]> = {
      SUCCEEDED: ["PROVIDER_COMPLETE"],
      FAILED: [
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_TIMEOUT",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_INVALID_RESPONSE",
        "PROVIDER_REFUSED",
        "PROVIDER_ERROR",
        "INTERNAL_ERROR",
        "OUTPUT_INVALID",
        "POLICY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "ACTIVITY_BLOCKED",
        // A genuine controller-observed runtime deadline (RuntimeResult
        // outcome TIMEOUT), reported truthfully via a normal FINALIZE from
        // RUNNING. Distinct from the TIMEOUT state below, reserved for the
        // DB's own lazy-expiry sweep of a stale AUTHORIZED/RUNNING row.
        "EXECUTION_TIMEOUT",
      ],
      ABSTAINED: [
        "NO_PROVIDER_CONFIGURED",
        "UNKNOWN_MODEL_PROFILE",
        "NO_EXECUTION_PATH",
        "POLICY_BLOCKED",
        "ACTIVITY_BLOCKED",
      ],
      ESCALATED: ["HUMAN_REVIEW_REQUIRED"],
      BUDGET_BLOCKED: ["BUDGET_BLOCKED"],
      TIMEOUT: ["EXECUTION_TIMEOUT"],
      CANCELLED: ["CANCELLED"],
      BLOCKED: ["RATE_LIMITED", "OUT_OF_ENVELOPE"],
    };
    const requiresStart = [
      "SUCCEEDED",
      "ABSTAINED",
      "ESCALATED",
      "BUDGET_BLOCKED",
      "CANCELLED",
    ];
    if (
      expires <= created ||
      expires - created > 20000 ||
      (started !== null && (started < created || started >= expires)) ||
      (terminal !== null && terminal < (started ?? created)) ||
      (active
        ? terminal !== null || value.reasonCode !== null
        : terminal === null ||
          !validReasons[value.state]?.includes(value.reasonCode ?? "")) ||
      (value.state === "AUTHORIZED" && started !== null) ||
      (["RUNNING", ...requiresStart].includes(value.state) &&
        started === null) ||
      (value.state === "BLOCKED"
        ? value.authorizedAt !== null ||
          started !== null ||
          terminal !== created
        : value.authorizedAt !== value.createdAt) ||
      (value.state === "ESCALATED"
        ? value.reviewPath !== "ACADEMIC_REVIEW"
        : value.reviewPath !== null) ||
      (value.state === "BUDGET_BLOCKED"
        ? value.budgetStage === null
        : value.budgetStage !== null) ||
      // Usage is present only once FINALIZE has actually run (SUCCEEDED/
      // ABSTAINED/ESCALATED/BUDGET_BLOCKED/CANCELLED are reachable only
      // from RUNNING, which always records it). FAILED can occur either
      // before RUNNING (no usage) or via FINALIZE from RUNNING (usage
      // present), so it is deliberately unconstrained either way.
      (requiresStart.includes(value.state) && value.usage === null) ||
      (["TIMEOUT", "AUTHORIZED", "RUNNING", "BLOCKED"].includes(value.state) &&
        value.usage !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid provider execution lifecycle projection.",
      });
  });
export type ProviderExecutionSnapshot = z.infer<
  typeof providerExecutionSnapshotSchema
>;

export const providerExecutionRpcResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: providerExecutionSnapshotSchema,
  }),
  z.strictObject({ ok: z.literal(false), code: executionErrorSchema }),
]);

export type ProfessorProviderExecutionOutcome =
  | { ok: true; execution: ProviderExecutionSnapshot }
  | { ok: false; error: { code: ProviderExecutionErrorCode; message: string } };

// Pure mapping from the provider-neutral RuntimeResult (src/domain/academic-
// runtime.ts) onto migration 025's bounded FINALIZE vocabulary. No I/O, no
// database access: this is exactly what src/server/academic-runtime/index.ts
// hands to the V2 controller once the surrounding academic-content release
// has already closed successfully -- never before. A RuntimeResult carries
// no prompt/response text into this mapping; only its own bounded usage
// counters do.
export type ProviderExecutionFinalizeCommand = {
  state:
    | "SUCCEEDED"
    | "FAILED"
    | "ABSTAINED"
    | "ESCALATED"
    | "BUDGET_BLOCKED"
    | "CANCELLED";
  reason: ProviderExecutionReason;
  budgetStage: "PRE_CALL" | "POST_CALL" | null;
  usage: ProviderExecutionUsageReport;
};
// Thrown by mapRuntimeResultToFinalizeCommand when a RuntimeUsage value does
// not fit the durable ledger's own bounded schema. This should not happen in
// practice: runGovernedProviderExecution's own accounting is bounded by real
// provider-reported values plus the (now correctly V2-capped) effective
// runtime policy, so a legitimate RuntimeUsage should always already fit.
// It exists as a fail-closed backstop, never a silent correction: the
// durable ledger must represent the actual numbers RuntimeResult supplied,
// so an impossible value is refused outright rather than quietly reduced to
// something FINALIZE would accept.
export class ImpossibleUsageError extends Error {
  constructor(readonly issues: string) {
    super(`RuntimeUsage does not fit the durable ledger schema: ${issues}`);
  }
}

export function mapRuntimeResultToFinalizeCommand(
  result: RuntimeResult,
): ProviderExecutionFinalizeCommand {
  const parsed = providerExecutionUsageReportSchema.safeParse(result.usage);
  if (!parsed.success) {
    throw new ImpossibleUsageError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const usage = parsed.data;
  switch (result.outcome) {
    case "SUCCEEDED":
      return {
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        budgetStage: null,
        usage,
      };
    case "FAILED":
      return {
        state: "FAILED",
        reason: result.reason,
        budgetStage: null,
        usage,
      };
    case "ABSTAINED":
      return {
        state: "ABSTAINED",
        reason: result.reason,
        budgetStage: null,
        usage,
      };
    case "ESCALATED":
      return {
        state: "ESCALATED",
        reason: "HUMAN_REVIEW_REQUIRED",
        budgetStage: null,
        usage,
      };
    case "BUDGET_BLOCKED":
      return {
        state: "BUDGET_BLOCKED",
        reason: "BUDGET_BLOCKED",
        budgetStage: result.stage,
        usage,
      };
    case "TIMEOUT":
      // TIMEOUT is not a valid FINALIZE state on its own (migration 025
      // reserves it for the DB's own lazy-expiry sweep, matching the
      // pre-existing V1 pattern): a runtime-observed deadline is reported
      // as FAILED/EXECUTION_TIMEOUT instead, an equally honest outcome.
      return {
        state: "FAILED",
        reason: "EXECUTION_TIMEOUT",
        budgetStage: null,
        usage,
      };
    case "CANCELLED":
      return {
        state: "CANCELLED",
        reason: "CANCELLED",
        budgetStage: null,
        usage,
      };
  }
}
