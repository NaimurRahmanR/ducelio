import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";
import {
  executionErrorSchema,
  type ExecutionErrorCode,
} from "./academic-execution";
import { handoffReason as deliveryHandoffReasonSchema } from "./delivery";
import type { RuntimeResult } from "./academic-runtime";

// Commercial V1: governed Tutor / Lab Instructor provider-backed execution.
// Migration 202609140028_commercial_v1_tutor_lab_execution.sql. A separate,
// distinctly identifiable governance surface from Professor's
// PROFESSOR_EXECUTION_V2/PROVIDER_BACKED_V1 (migration 025, untouched):
// TUTOR_LAB_EXECUTION_V1, generalised across exactly TUTOR and
// LAB_INSTRUCTOR. Examiner and Counsellor never reach this contract.
export const TUTOR_LAB_EXECUTION_POLICY = "TUTOR_LAB_EXECUTION_V1" as const;
export const TUTOR_LAB_EXECUTION_KIND = "PROVIDER_BACKED_V1" as const;

export const tutorLabRoleSchema = z.enum(["TUTOR", "LAB_INSTRUCTOR"]);
export type TutorLabRole = z.infer<typeof tutorLabRoleSchema>;

// Correction pass (independent review, Blocker 2): the strict, reused
// handoff-reason vocabulary (src/domain/delivery.ts's own reviewed
// catalogue, never a second divergent copy). This is the value provider
// context must carry as its reason -- never a role name -- and it is always
// read from the authoritative delivery_handoffs row via
// begin_tutor_lab_content_release, never inferred or browser-supplied.
export const tutorLabHandoffReasonSchema = deliveryHandoffReasonSchema;
export type TutorLabHandoffReason = z.infer<typeof tutorLabHandoffReasonSchema>;

// The exact, reviewed role -> allowed-reason(s) binding migration 028's
// begin_tutor_lab_content_release already enforces server-side; re-asserted
// here as a defense-in-depth, code-owned check at the TypeScript context
// boundary too, so a wrong role/reason combination can never silently reach
// a provider even under a future refactor of the SQL gate.
export const TUTOR_LAB_ALLOWED_REASONS: Readonly<
  Record<TutorLabRole, readonly TutorLabHandoffReason[]>
> = Object.freeze({
  TUTOR: Object.freeze([
    "MISSED_LESSON_PRACTICE",
    "OBJECTIVE_REINFORCEMENT",
    "PRACTICAL_PREREQUISITE",
  ] as const),
  LAB_INSTRUCTOR: Object.freeze(["PRACTICAL_HELP"] as const),
});

// PR16A: the independently-owned TUTOR_LAB_ROLE_PROFILE_REF role->profile
// map that used to live here has been removed. Tutor/Lab role-bound profile
// resolution is now owned entirely by the shared, DOMAIN-level
// ROLE_RUNTIME_PROFILE_POLICY (src/domain/academic-runtime-profile.ts),
// consulted through src/server/academic-runtime/profile-registry.ts's
// resolveRoleBoundRuntimeProfile -- the same mechanism PROFESSOR and
// EXAMINER now use, so there is exactly one editable role->profile
// authority for all provider-backed roles, never two independently
// drifting copies.

// Must stay byte-for-byte in step with migration 028's table CHECK
// constraints on tutor_lab_provider_executions. Deliberately tighter than
// Professor's V2 ceiling (migration 025): exactly one provider call per
// execution (no demonstrated need for more), a smaller output-token/cost
// ceiling appropriate for bounded learner-support guidance rather than a
// full lesson explanation.
export const TUTOR_LAB_EXECUTION_DB_CEILING = Object.freeze({
  maxProviderCalls: 1,
  maxOutputTokens: 2000,
  maxEstimatedCostMicrousd: 100_000,
});

export const tutorLabBudgetProposalSchema = z.strictObject({
  maxProviderCalls: z.literal(TUTOR_LAB_EXECUTION_DB_CEILING.maxProviderCalls),
  maxOutputTokens: z
    .number()
    .int()
    .min(1)
    .max(TUTOR_LAB_EXECUTION_DB_CEILING.maxOutputTokens),
  maxEstimatedCostMicrousd: z
    .number()
    .int()
    .min(1)
    .max(TUTOR_LAB_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd),
});
export type TutorLabBudgetProposal = z.infer<
  typeof tutorLabBudgetProposalSchema
>;

// The one reviewed bounded contract for learner prose reaching Tutor/Lab:
// string only, trimmed, 1..2000 characters -- the same bound already
// reviewed for the Professor classroom's learner question. No arbitrary
// JSON, no browser-selected role/provider/model/capability/budget: the
// destination role and every institutional identifier are derived entirely
// server-side from the owning handoff (src/server/tutor-lab-execution).
export const learnerSupportMessageSchema = z.string().trim().min(1).max(2000);

export const tutorLabSupportRequestSchema = z.strictObject({
  handoffId: z.uuid(),
  message: learnerSupportMessageSchema,
  idempotencyKey: z.uuid(),
});
export type TutorLabSupportRequest = z.infer<
  typeof tutorLabSupportRequestSchema
>;

export const tutorLabUsageReportSchema = z.strictObject({
  providerCalls: z.number().int().min(0).max(1),
  attempts: z.number().int().min(0).max(3),
  inputTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  estimatedCostMicrousd: z.number().int().min(0).max(1_000_000_000),
  elapsedMs: z.number().int().min(0).max(60_000),
});
export type TutorLabUsageReport = z.infer<typeof tutorLabUsageReportSchema>;

export const tutorLabBudgetStageSchema = z.enum(["PRE_CALL", "POST_CALL"]);

export const tutorLabReasonSchema = z.enum([
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
export type TutorLabReason = z.infer<typeof tutorLabReasonSchema>;

const tutorLabStateSchema = z.enum([
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

export { executionErrorSchema as tutorLabExecutionErrorSchema };
export type TutorLabExecutionErrorCode =
  ExecutionErrorCode | "DUPLICATE_KEY_CONFLICT";

export const tutorLabExecutionSnapshotSchema = z.strictObject({
  executionId: z.uuid(),
  studentId: z.uuid(),
  releaseId: z.uuid(),
  invocationId: z.uuid(),
  agentProfile: tutorLabRoleSchema,
  policyVersion: z.literal(TUTOR_LAB_EXECUTION_POLICY),
  executionKind: z.literal(TUTOR_LAB_EXECUTION_KIND),
  state: tutorLabStateSchema,
  reasonCode: tutorLabReasonSchema.nullable(),
  budgetStage: tutorLabBudgetStageSchema.nullable(),
  createdAt: academicTimestampSchema,
  authorizedAt: academicTimestampSchema.nullable(),
  startedAt: academicTimestampSchema.nullable(),
  terminalAt: academicTimestampSchema.nullable(),
  expiresAt: academicTimestampSchema,
  reviewPath: z.literal("ACADEMIC_REVIEW").nullable(),
  budget: tutorLabBudgetProposalSchema,
  usage: tutorLabUsageReportSchema.nullable(),
});
export type TutorLabExecutionSnapshot = z.infer<
  typeof tutorLabExecutionSnapshotSchema
>;

export const tutorLabRpcResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: tutorLabExecutionSnapshotSchema,
  }),
  z.strictObject({ ok: z.literal(false), code: executionErrorSchema }),
]);

// The bounded context open_tutor_lab_content_release-equivalent flow yields:
// exact learner-owned identifiers only, never a capability the caller chose.
export const tutorLabReleaseContextSchema = z.strictObject({
  releaseId: z.uuid(),
  invocationId: z.uuid(),
  role: tutorLabRoleSchema,
  reasonCode: tutorLabHandoffReasonSchema,
  enrolmentId: z.uuid(),
  lessonId: z.uuid(),
  objectiveId: z.uuid().nullable(),
  practicalId: z.uuid().nullable(),
});
export type TutorLabReleaseContext = z.infer<
  typeof tutorLabReleaseContextSchema
>;

export const tutorLabOpenRpcResultSchema = z.union([
  z
    .strictObject({ ok: z.literal(true) })
    .extend(tutorLabReleaseContextSchema.shape),
  z.strictObject({ ok: z.literal(false), code: z.string() }),
]);

export const tutorLabReservationRpcResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), duplicate: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: z.string() }),
]);

export type TutorLabFinalizeCommand = {
  state:
    | "SUCCEEDED"
    | "FAILED"
    | "ABSTAINED"
    | "ESCALATED"
    | "BUDGET_BLOCKED"
    | "CANCELLED";
  reason: TutorLabReason;
  budgetStage: "PRE_CALL" | "POST_CALL" | null;
  usage: TutorLabUsageReport;
};

export class ImpossibleTutorLabUsageError extends Error {
  constructor(readonly issues: string) {
    super(`RuntimeUsage does not fit the tutor/lab ledger schema: ${issues}`);
  }
}

// Pure mapping, identical shape to Professor's mapRuntimeResultToFinalizeCommand
// (src/domain/academic-provider-execution.ts) -- deliberately re-declared here
// rather than imported, since this is a structurally separate governance
// surface with its own (tighter) usage bounds, never Professor's.
export function mapRuntimeResultToTutorLabFinalizeCommand(
  result: RuntimeResult,
): TutorLabFinalizeCommand {
  const parsed = tutorLabUsageReportSchema.safeParse(result.usage);
  if (!parsed.success) {
    throw new ImpossibleTutorLabUsageError(
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

// Learner-safe outcome vocabulary. Only SUCCEEDED ever carries content, and
// only the provider's own outputText -- never a raw provider/network
// payload, reason code, execution/usage identifier, HMAC or controller
// detail. Identical shape to the Professor classroom's
// ClassroomProfessorOutcome (src/domain/professor-classroom.ts),
// deliberately re-declared for this structurally separate surface.
export type TutorLabSupportOutcome =
  | { kind: "SUCCEEDED"; text: string }
  | { kind: "ACTIVITY_BLOCKED" }
  | { kind: "UNAVAILABLE" }
  | { kind: "ESCALATED" }
  | { kind: "RETRY_LATER" };

export function mapRuntimeResultToTutorLabOutcome(
  result: RuntimeResult,
): TutorLabSupportOutcome {
  switch (result.outcome) {
    case "SUCCEEDED":
      return { kind: "SUCCEEDED", text: result.response.outputText };
    case "ABSTAINED":
      return result.reason === "ACTIVITY_BLOCKED"
        ? { kind: "ACTIVITY_BLOCKED" }
        : { kind: "UNAVAILABLE" };
    case "ESCALATED":
      return { kind: "ESCALATED" };
    case "BUDGET_BLOCKED":
    case "TIMEOUT":
    case "FAILED":
    case "CANCELLED":
      return { kind: "RETRY_LATER" };
  }
}

export class TutorLabExecutionDenied extends Error {
  constructor(
    readonly code: TutorLabExecutionErrorCode,
    readonly databaseTerminal = false,
  ) {
    super("Tutor/Lab support execution unavailable.");
    this.name = "TutorLabExecutionDenied";
  }
}
