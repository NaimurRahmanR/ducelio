import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";
import type { CapabilityOutput } from "./academic-capabilities";

export const PROFESSOR_EXECUTION_POLICY = "PROFESSOR_EXECUTION_V1" as const;
export const executionContentCapabilitySchema = z.enum([
  "get_current_learner_context",
  "get_lesson_context",
  "get_lesson_objectives",
  "get_current_class_session",
  "get_learning_resources",
  "get_permitted_learning_history",
  "get_current_mastery_state",
]);
export type ExecutionContentCapability = z.infer<
  typeof executionContentCapabilitySchema
>;

// Reviewed pre-production abuse ceilings. Database migration 022 owns enforcement.
// Changing these is a policy migration, never a learner subscription/quota input.
export const PROFESSOR_ADMISSION_POLICY = Object.freeze({
  maxConcurrent: 1,
  shortWindowSeconds: 60,
  shortWindowRequests: 5,
  longWindowSeconds: 3600,
  longWindowRequests: 30,
  maxLifetimeSeconds: 20,
});
export const executionBudgetSchema = z.strictObject({
  maxProviderCalls: z.literal(0),
  maxInputTokens: z.literal(0),
  maxOutputTokens: z.literal(0),
  maxEstimatedCostMicrousd: z.literal(0),
});
export const NO_PROVIDER_BUDGET = Object.freeze(
  executionBudgetSchema.parse({
    maxProviderCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxEstimatedCostMicrousd: 0,
  }),
);

export const executionReasonSchema = z.enum([
  "ACTIVITY_BLOCKED",
  "CONTENT_RELEASE_UNAVAILABLE",
  "RATE_LIMITED",
  "BUDGET_BLOCKED",
  "EXECUTION_TIMEOUT",
  "OUTPUT_INVALID",
  "POLICY_BLOCKED",
  "ABSTAIN_UNCERTAIN",
  "HUMAN_REVIEW_REQUIRED",
  "INTERNAL_ERROR",
  "CONTROL_PLANE_COMPLETE",
  // Reserved for B2 adapters; migration 022 and the B1 runtime do not emit these.
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_ERROR",
]);
export const executionErrorSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "UNTRUSTED_EXECUTION",
  "REPLAY_REJECTED",
  "SERVICE_UNAVAILABLE",
  "CONTEXT_CONFLICT",
  "ACTIVITY_BLOCKED",
  "CONTENT_RELEASE_UNAVAILABLE",
  "RATE_LIMITED",
  "BUDGET_BLOCKED",
  "EXECUTION_TIMEOUT",
  "POLICY_BLOCKED",
  "INTERNAL_ERROR",
  "OUTPUT_INVALID",
]);
export type ExecutionErrorCode = z.infer<typeof executionErrorSchema>;
export const executionSnapshotSchema = z
  .strictObject({
    executionId: z.uuid(),
    studentId: z.uuid(),
    releaseId: z.uuid(),
    invocationId: z.uuid(),
    agentProfile: z.literal("PROFESSOR"),
    policyVersion: z.literal(PROFESSOR_EXECUTION_POLICY),
    executionKind: z.literal("CONTROL_PLANE_ONLY"),
    state: z.enum([
      "AUTHORIZED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "ABSTAINED",
      "ESCALATED",
      "BLOCKED",
    ]),
    reasonCode: executionReasonSchema.nullable(),
    createdAt: academicTimestampSchema,
    authorizedAt: academicTimestampSchema.nullable(),
    startedAt: academicTimestampSchema.nullable(),
    terminalAt: academicTimestampSchema.nullable(),
    expiresAt: academicTimestampSchema,
    reviewPath: z.literal("ACADEMIC_REVIEW").nullable(),
    budget: executionBudgetSchema,
  })
  .superRefine((value, context) => {
    const created = Date.parse(value.createdAt),
      expires = Date.parse(value.expiresAt);
    const terminal = value.terminalAt ? Date.parse(value.terminalAt) : null;
    const started = value.startedAt ? Date.parse(value.startedAt) : null;
    const active = ["AUTHORIZED", "RUNNING"].includes(value.state);
    const validReasons: Record<string, readonly string[]> = {
      SUCCEEDED: ["CONTROL_PLANE_COMPLETE"],
      FAILED: [
        "EXECUTION_TIMEOUT",
        "INTERNAL_ERROR",
        "OUTPUT_INVALID",
        "POLICY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "ACTIVITY_BLOCKED",
      ],
      ABSTAINED: ["ABSTAIN_UNCERTAIN", "POLICY_BLOCKED"],
      ESCALATED: ["HUMAN_REVIEW_REQUIRED"],
      BLOCKED: ["RATE_LIMITED", "BUDGET_BLOCKED"],
    };
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
      (["RUNNING", "SUCCEEDED", "ABSTAINED", "ESCALATED"].includes(
        value.state,
      ) &&
        started === null) ||
      (value.state === "BLOCKED"
        ? value.authorizedAt !== null ||
          started !== null ||
          terminal !== created
        : value.authorizedAt !== value.createdAt) ||
      (value.state === "ESCALATED"
        ? value.reviewPath !== "ACADEMIC_REVIEW"
        : value.reviewPath !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid execution lifecycle projection.",
      });
  });
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export const executionRpcResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: executionSnapshotSchema,
  }),
  z.strictObject({ ok: z.literal(false), code: executionErrorSchema }),
]);
export type ProfessorExecutionResult =
  | { ok: true; execution: ExecutionSnapshot }
  | { ok: false; error: { code: ExecutionErrorCode; message: string } };

// B2 adapter design port only: no implementation is registered or invoked in B1.
// Raw adapter output is untrusted; it is never an execution outcome or audit command.
export interface AcademicExecutor {
  execute(input: {
    executionId: string;
    capability: ExecutionContentCapability;
    content: CapabilityOutput<ExecutionContentCapability>;
    budget: z.infer<typeof executionBudgetSchema>;
    expiresAt: string;
  }): Promise<unknown>;
}
