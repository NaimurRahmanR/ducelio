import { createHash } from "node:crypto";
import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";
import type { RuntimeResult } from "./academic-runtime";

// Commercial V1 PR11B1: governed Examiner execution and trusted atomic
// initial-grade finalization. Migration
// 202609160031_commercial_v1_examiner_grading.sql. A separate, distinctly
// identifiable governance surface from Professor/Tutor/Lab
// (PROFESSOR_EXECUTION_V2/TUTOR_LAB_EXECUTION_V1, untouched):
// COMMERCIAL_V1_EXAMINER_V1, constrained to EXAMINER only. Does NOT add
// EXAMINER to ROLES_WITH_REVIEWED_EXECUTION_PATH (src/server/academic-
// runtime/index.ts, unmodified) -- that generic role runtime remains
// fail-closed for EXAMINER. Regrade/supersession is out of scope: this
// checkpoint produces revision 1 only.
export const COMMERCIAL_V1_EXAMINER_POLICY =
  "COMMERCIAL_V1_EXAMINER_V1" as const;
export const COMMERCIAL_V1_EXAMINER_EXECUTION_KIND =
  "PROVIDER_BACKED_V1" as const;
export const EXAMINER_RUNTIME_PROFILE_REF = "EXAMINER_COMMERCIAL_V1" as const;

export const examinerCapabilitySchema = z.enum([
  "grade_controlled_assessment",
  "grade_practical_lab",
]);
export type ExaminerCapability = z.infer<typeof examinerCapabilitySchema>;

export const examinerTargetKindSchema = z.enum([
  "ASSESSMENT_ATTEMPT",
  "LAB_SUBMISSION",
]);
export type ExaminerTargetKind = z.infer<typeof examinerTargetKindSchema>;

export const EXAMINER_CAPABILITY_TARGET_KIND: Readonly<
  Record<ExaminerCapability, ExaminerTargetKind>
> = Object.freeze({
  grade_controlled_assessment: "ASSESSMENT_ATTEMPT",
  grade_practical_lab: "LAB_SUBMISSION",
});

// Must stay byte-for-byte in step with migration 031's table CHECK
// constraints on commercial_v1_examiner_executions.
export const EXAMINER_EXECUTION_DB_CEILING = Object.freeze({
  maxProviderCalls: 1,
  maxOutputTokens: 1200,
  maxEstimatedCostMicrousd: 50_000,
});

export const examinerBudgetProposalSchema = z.strictObject({
  maxProviderCalls: z.literal(EXAMINER_EXECUTION_DB_CEILING.maxProviderCalls),
  maxOutputTokens: z
    .number()
    .int()
    .min(1)
    .max(EXAMINER_EXECUTION_DB_CEILING.maxOutputTokens),
  maxEstimatedCostMicrousd: z
    .number()
    .int()
    .min(1)
    .max(EXAMINER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd),
});
export type ExaminerBudgetProposal = z.infer<
  typeof examinerBudgetProposalSchema
>;

// The only two public entrypoint inputs (section 5 of the checkpoint brief):
// identifiers only. No marks, scores, weights, expected answers, marking
// guidance, provider output, revision numbers, provenance, component
// weights, lab contribution values or objective outcomes can ever be
// supplied by a caller.
export const gradeControlledAssessmentInputSchema = z.strictObject({
  attemptId: z.uuid(),
});
export const gradePracticalLabInputSchema = z.strictObject({
  submissionId: z.uuid(),
});

// ---------------------------------------------------------------------------
// Provider output contract (section 9). Parsed from response.outputText via
// JSON.parse -- a markdown fence, prose prefix/suffix or any non-JSON text
// therefore already fails to parse before schema validation is even
// reached. z.strictObject rejects unknown keys (no rationale/feedback/
// answer-key-echo field is ever tolerated).
// ---------------------------------------------------------------------------
export const examinerAssessmentMarkSchema = z.strictObject({
  questionId: z.uuid(),
  marksAwarded: z.number().int().min(0),
});
export const examinerAssessmentProviderOutputSchema = z.union([
  z.strictObject({
    outcome: z.literal("GRADED"),
    // The exact answered-question set may legitimately be empty (an
    // attempt submitted with nothing answered): marks:[] is a valid GRADED
    // response, not malformed. No arbitrary upper bound is imposed here
    // either -- there is no immutable institutional assessment-question-
    // count limit to enforce, and the provider response text itself is
    // already bounded by the reviewed HTTP_JSON adapter's own
    // outputText.max(20000) (src/server/academic-runtime/provider.ts).
    marks: z.array(examinerAssessmentMarkSchema),
  }),
  z.strictObject({ outcome: z.literal("ESCALATE") }),
]);
export type ExaminerAssessmentProviderOutput = z.infer<
  typeof examinerAssessmentProviderOutputSchema
>;

export const examinerLabProviderOutputSchema = z.union([
  z.strictObject({
    outcome: z.literal("GRADED"),
    marksAwarded: z.number().int().min(0),
  }),
  z.strictObject({ outcome: z.literal("ESCALATE") }),
]);
export type ExaminerLabProviderOutput = z.infer<
  typeof examinerLabProviderOutputSchema
>;

export type ExaminerProviderParseResult<T> =
  { ok: true; output: T } | { ok: false };

// Strict parse: any JSON.parse failure, any schema mismatch (extra keys,
// wrong types, prose) fails closed with no partial/lenient recovery.
export function parseExaminerAssessmentProviderOutput(
  outputText: string,
): ExaminerProviderParseResult<ExaminerAssessmentProviderOutput> {
  let json: unknown;
  try {
    json = JSON.parse(outputText);
  } catch {
    return { ok: false };
  }
  const parsed = examinerAssessmentProviderOutputSchema.safeParse(json);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false };
}
export function parseExaminerLabProviderOutput(
  outputText: string,
): ExaminerProviderParseResult<ExaminerLabProviderOutput> {
  let json: unknown;
  try {
    json = JSON.parse(outputText);
  } catch {
    return { ok: false };
  }
  const parsed = examinerLabProviderOutputSchema.safeParse(json);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false };
}

// ---------------------------------------------------------------------------
// Protected context (section 6/8). Server-only, never returned to a
// browser: the composition boundary consumes this and hands only the
// bounded provider request forward. answeredQuestions is exactly the
// authoritative answered-question set for the submitted attempt (unanswered
// questions never appear here and are never sent to the provider -- the
// trusted finalizer adds their deterministic zero, see migration 031).
// ---------------------------------------------------------------------------
export const examinerAssessmentContextSchema = z.strictObject({
  attemptId: z.uuid(),
  assessmentId: z.uuid(),
  component: z.string(),
  title: z.string(),
  instructions: z.string(),
  questions: z.array(
    z.strictObject({
      questionId: z.uuid(),
      position: z.number().int(),
      prompt: z.string(),
      maxMarks: z.number().int(),
      expectedAnswer: z.string(),
      markingGuidance: z.string().nullable(),
      responseBody: z.string(),
    }),
  ),
});
export type ExaminerAssessmentContext = z.infer<
  typeof examinerAssessmentContextSchema
>;

export const examinerLabContextSchema = z.strictObject({
  submissionId: z.uuid(),
  practicalId: z.uuid(),
  title: z.string(),
  instructions: z.string(),
  maxMarks: z.number().int(),
  gradingGuidance: z.string().nullable(),
  submissionBody: z.string(),
  objectives: z.array(
    z.strictObject({ objectiveId: z.uuid(), description: z.string() }),
  ),
});
export type ExaminerLabContext = z.infer<typeof examinerLabContextSchema>;

// Server-side, independent re-validation of provider marks against the
// SAME authoritative context sent to the provider (never against caller
// input) -- redundant with, but not a substitute for, the database's own
// independent re-validation inside the atomic finalizer.
export function validateExaminerAssessmentMarks(
  context: ExaminerAssessmentContext,
  marks: readonly { questionId: string; marksAwarded: number }[],
): boolean {
  const byId = new Map(
    context.questions.map((q) => [q.questionId, q.maxMarks]),
  );
  if (marks.length !== byId.size) return false;
  const seen = new Set<string>();
  for (const mark of marks) {
    if (seen.has(mark.questionId)) return false;
    seen.add(mark.questionId);
    const max = byId.get(mark.questionId);
    if (max === undefined) return false;
    if (mark.marksAwarded > max) return false;
  }
  return seen.size === byId.size;
}
export function validateExaminerLabMarks(
  context: ExaminerLabContext,
  marksAwarded: number,
): boolean {
  return (
    Number.isInteger(marksAwarded) &&
    marksAwarded >= 0 &&
    marksAwarded <= context.maxMarks
  );
}

// ---------------------------------------------------------------------------
// Grade digest: the DB independently recomputes this exact value from the
// normalized grade payload at FINALIZE and refuses any mismatch (migration
// 031). Never the raw marks themselves -- a fixed-length sha256 hex digest,
// safe to sign, log and audit.
// ---------------------------------------------------------------------------
export function computeExaminerAssessmentGradeDigest(
  marks: readonly { questionId: string; marksAwarded: number }[],
): string {
  const text = [...marks]
    .sort((a, b) =>
      a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0,
    )
    .map((m) => `${m.questionId}:${m.marksAwarded}`)
    .join(";");
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function computeExaminerLabGradeDigest(marksAwarded: number): string {
  return createHash("sha256")
    .update(`marksAwarded:${marksAwarded}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Execution lifecycle vocabulary/schemas, mirroring tutor-lab-execution.ts's
// shape for this structurally separate surface.
// ---------------------------------------------------------------------------
export const examinerReasonSchema = z.enum([
  "NONE",
  "GRADED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_REFUSED",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR",
  "OUTPUT_INVALID",
  "RESULT_INTEGRITY_FAILED",
  "NO_PROVIDER_CONFIGURED",
  "HUMAN_REVIEW_REQUIRED",
  "BUDGET_BLOCKED",
  "EXECUTION_TIMEOUT",
  "CANCELLED",
]);
export type ExaminerReason = z.infer<typeof examinerReasonSchema>;

const examinerStateSchema = z.enum([
  "AUTHORIZED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ESCALATED",
  "BUDGET_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
]);
export const examinerBudgetStageSchema = z.enum(["PRE_CALL", "POST_CALL"]);

// This checkpoint's own, dedicated error vocabulary -- deliberately NOT a
// reuse of Professor's executionErrorSchema (src/domain/academic-
// execution.ts): that enum lacks several codes migration 031's RPC actually
// returns (NOT_FOUND_OR_FORBIDDEN, TARGET_NOT_ELIGIBLE, ALREADY_GRADED,
// OUT_OF_ENVELOPE, EXECUTION_UNAVAILABLE) and carries several Professor/
// content-release-specific ones this surface never emits.
export const examinerExecutionErrorSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "UNTRUSTED_EXECUTION",
  "REPLAY_REJECTED",
  "CONTEXT_CONFLICT",
  "NOT_FOUND_OR_FORBIDDEN",
  "TARGET_NOT_ELIGIBLE",
  "ALREADY_GRADED",
  "RATE_LIMITED",
  "OUT_OF_ENVELOPE",
  "EXECUTION_UNAVAILABLE",
  "EXECUTION_TIMEOUT",
  // PR16A: bounded governance denials from AUTHORIZE's new programme-version
  // EXAMINER academic_agent_configs admission (migration 036) -- no config
  // row / disabled / missing the exact invoked grading capability
  // (POLICY_BLOCKED), or an invalid/cross-role stored runtime profile
  // (UNKNOWN_MODEL_PROFILE). Both write no execution row and make no
  // provider call; both map to learner-facing UNAVAILABLE
  // (mapDenialToResult's default fallback in
  // src/server/commercial-v1-examiner-grading/index.ts), never exposing
  // configuration detail to the browser.
  "POLICY_BLOCKED",
  "UNKNOWN_MODEL_PROFILE",
]);
// SERVICE_UNAVAILABLE is a TS-transport-only code (RPC error, unparseable
// response) -- never something the database itself returns as `code`, so it
// is deliberately not part of the zod schema above (which parses only the
// database's own {ok:false,code:...} shape), but ExaminerExecutionDenied
// may still be thrown with it.
export type ExaminerExecutionErrorCode =
  z.infer<typeof examinerExecutionErrorSchema> | "SERVICE_UNAVAILABLE";

export const examinerUsageReportSchema = z.strictObject({
  providerCalls: z.number().int().min(0).max(1),
  attempts: z.number().int().min(0).max(3),
  inputTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  estimatedCostMicrousd: z.number().int().min(0).max(1_000_000_000),
  elapsedMs: z.number().int().min(0).max(60_000),
});
export type ExaminerUsageReport = z.infer<typeof examinerUsageReportSchema>;

export const examinerExecutionSnapshotSchema = z.strictObject({
  executionId: z.uuid(),
  studentId: z.uuid(),
  enrolmentId: z.uuid().nullable(),
  activationId: z.uuid().nullable(),
  capability: examinerCapabilitySchema,
  targetKind: examinerTargetKindSchema,
  attemptId: z.uuid().nullable(),
  submissionId: z.uuid().nullable(),
  component: z.string().nullable(),
  practicalId: z.uuid().nullable(),
  policyVersion: z.literal(COMMERCIAL_V1_EXAMINER_POLICY),
  executionKind: z.literal(COMMERCIAL_V1_EXAMINER_EXECUTION_KIND),
  // Persisted, immutable, code-owned -- never accepted from the learner/
  // browser. Proves which reviewed runtime/model profile this execution
  // was actually admitted under (migration 031, Blocker 6).
  runtimeProfileRef: z.literal(EXAMINER_RUNTIME_PROFILE_REF),
  state: examinerStateSchema,
  reasonCode: examinerReasonSchema.nullable(),
  budgetStage: examinerBudgetStageSchema.nullable(),
  createdAt: academicTimestampSchema,
  authorizedAt: academicTimestampSchema.nullable(),
  startedAt: academicTimestampSchema.nullable(),
  terminalAt: academicTimestampSchema.nullable(),
  expiresAt: academicTimestampSchema,
  reviewPath: z.literal("ACADEMIC_REVIEW").nullable(),
  gradeDigest: z.string().nullable(),
  resultRevisionId: z.uuid().nullable(),
  budget: examinerBudgetProposalSchema,
  usage: examinerUsageReportSchema.nullable(),
});
export type ExaminerExecutionSnapshot = z.infer<
  typeof examinerExecutionSnapshotSchema
>;

export const examinerRpcResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: examinerExecutionSnapshotSchema,
  }),
  z.strictObject({ ok: z.literal(false), code: examinerExecutionErrorSchema }),
]);
export type ExaminerRpcResult = z.infer<typeof examinerRpcResultSchema>;

export type ExaminerFinalizeCommand =
  | {
      state: "SUCCEEDED";
      reason: "GRADED";
      budgetStage: null;
      usage: ExaminerUsageReport;
      gradeDigest: string;
      assessmentMarks: { questionId: string; marksAwarded: number }[] | null;
      labMarksAwarded: number | null;
    }
  | {
      state: "FAILED" | "ESCALATED" | "BUDGET_BLOCKED" | "CANCELLED";
      reason: ExaminerReason;
      budgetStage: "PRE_CALL" | "POST_CALL" | null;
      usage: ExaminerUsageReport;
      gradeDigest: null;
      assessmentMarks: null;
      labMarksAwarded: null;
    };

// Blocker 3 (independent review, V3): the current reviewed HTTP_JSON
// provider bounds (profile budget + migration 031's own DB ceiling) mean
// real, legitimate usage always fits examinerUsageReportSchema. A schema
// failure here therefore represents an INTERNAL INVARIANT failure (a bug,
// or a provider that reported something impossible), never a legitimate
// reason to invent zero institutional usage. Returns null -- never a
// synthetic zero-usage object -- so the caller can refuse to construct ANY
// FINALIZE command and instead fall back to the existing DB-owned 20-
// second expiry safety mechanism (see src/server/commercial-v1-examiner-
// grading/index.ts).
function parseKnownUsage(usage: unknown): ExaminerUsageReport | null {
  const parsed = examinerUsageReportSchema.safeParse(usage);
  return parsed.success ? parsed.data : null;
}

// Maps a completed RuntimeResult (SUCCEEDED means the HTTP call itself
// succeeded and returned parseable JSON in the reviewed shape -- ESCALATE
// is a legitimate GRADED-provider-output outcome, not a RuntimeResult
// outcome of its own) to the FINALIZE command this checkpoint's atomic
// database finalizer expects. Only ever called with a context/marks pairing
// the caller has already independently validated
// (validateExaminerAssessmentMarks/validateExaminerLabMarks). Returns null
// when the observed usage itself fails to validate -- see parseKnownUsage.
export function mapExaminerAssessmentRuntimeResultToFinalizeCommand(
  result: RuntimeResult,
  context: ExaminerAssessmentContext,
): ExaminerFinalizeCommand | null {
  const usage = parseKnownUsage(result.usage);
  if (!usage) return null;
  if (result.outcome === "SUCCEEDED") {
    const parsed = parseExaminerAssessmentProviderOutput(
      result.response.outputText,
    );
    if (!parsed.ok) {
      return {
        state: "FAILED",
        reason: "OUTPUT_INVALID",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    if (parsed.output.outcome === "ESCALATE") {
      return {
        state: "ESCALATED",
        reason: "HUMAN_REVIEW_REQUIRED",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    if (!validateExaminerAssessmentMarks(context, parsed.output.marks)) {
      return {
        state: "FAILED",
        reason: "OUTPUT_INVALID",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    return {
      state: "SUCCEEDED",
      reason: "GRADED",
      budgetStage: null,
      usage,
      gradeDigest: computeExaminerAssessmentGradeDigest(parsed.output.marks),
      assessmentMarks: parsed.output.marks,
      labMarksAwarded: null,
    };
  }
  return mapNonSucceededOutcome(result, usage);
}

export function mapExaminerLabRuntimeResultToFinalizeCommand(
  result: RuntimeResult,
  context: ExaminerLabContext,
): ExaminerFinalizeCommand | null {
  const usage = parseKnownUsage(result.usage);
  if (!usage) return null;
  if (result.outcome === "SUCCEEDED") {
    const parsed = parseExaminerLabProviderOutput(result.response.outputText);
    if (!parsed.ok) {
      return {
        state: "FAILED",
        reason: "OUTPUT_INVALID",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    if (parsed.output.outcome === "ESCALATE") {
      return {
        state: "ESCALATED",
        reason: "HUMAN_REVIEW_REQUIRED",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    if (!validateExaminerLabMarks(context, parsed.output.marksAwarded)) {
      return {
        state: "FAILED",
        reason: "OUTPUT_INVALID",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    }
    return {
      state: "SUCCEEDED",
      reason: "GRADED",
      budgetStage: null,
      usage,
      gradeDigest: computeExaminerLabGradeDigest(parsed.output.marksAwarded),
      assessmentMarks: null,
      labMarksAwarded: parsed.output.marksAwarded,
    };
  }
  return mapNonSucceededOutcome(result, usage);
}

function mapNonSucceededOutcome(
  result: Exclude<RuntimeResult, { outcome: "SUCCEEDED" }>,
  usage: ExaminerUsageReport,
): ExaminerFinalizeCommand {
  switch (result.outcome) {
    case "FAILED":
      return {
        state: "FAILED",
        reason: result.reason,
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    case "ABSTAINED":
      // The only abstention this checkpoint's simplified orchestrator can
      // actually reach is NO_PROVIDER_CONFIGURED (no per-course Examiner
      // configuration/capability catalogue is consulted here -- see
      // docs/25-commercial-v1-examiner-grading.md, "known limitations").
      return {
        state: "FAILED",
        reason: "NO_PROVIDER_CONFIGURED",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    case "ESCALATED":
      return {
        state: "ESCALATED",
        reason: "HUMAN_REVIEW_REQUIRED",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    case "BUDGET_BLOCKED":
      return {
        state: "BUDGET_BLOCKED",
        reason: "BUDGET_BLOCKED",
        budgetStage: result.stage,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    case "TIMEOUT":
      return {
        state: "FAILED",
        reason: "EXECUTION_TIMEOUT",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
    case "CANCELLED":
      return {
        state: "CANCELLED",
        reason: "CANCELLED",
        budgetStage: null,
        usage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      };
  }
}

// Learner/caller-safe outcome vocabulary for the orchestrator's return
// value. Never carries marks, provider text, or any protected content --
// only enough to know what happened. The actual grade lives in the PR11A
// result-storage tables and is read back only through PR11A's own bounded
// projections (get_commercial_v1_course_progress /
// list_commercial_v1_objective_diagnostics), never from this surface.
export type ExaminerGradingResult =
  | { status: "GRADED"; resultRevisionId: string }
  | { status: "ALREADY_GRADED"; resultRevisionId: string | null }
  | { status: "ESCALATED" }
  | { status: "TARGET_NOT_ELIGIBLE" }
  | { status: "UNAVAILABLE" }
  | { status: "RETRY_LATER" };

export class ExaminerExecutionDenied extends Error {
  constructor(
    readonly code: ExaminerExecutionErrorCode,
    readonly databaseTerminal = false,
  ) {
    super("Examiner grading execution unavailable.");
    this.name = "ExaminerExecutionDenied";
  }
}
