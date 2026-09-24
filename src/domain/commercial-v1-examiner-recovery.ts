import { z } from "zod";
import {
  examinerExecutionErrorSchema,
  examinerExecutionSnapshotSchema,
  type ExaminerCapability,
} from "./commercial-v1-examiner-grading";

// Commercial V1 -- Examiner initial-grade failure recovery.
// Migration 202609240040_commercial_v1_examiner_initial_grade_recovery.sql.
// A separate, distinctly identifiable governance surface from both initial
// grading (COMMERCIAL_V1_EXAMINER_V1) and regrade
// (COMMERCIAL_V1_EXAMINER_REGRADE_V1): recovery gives a stranded target --
// a terminal initial execution that produced NO result revision -- its one
// legitimate additional governed attempt. It is not regrade: regrade
// requires an EXISTING result to supersede; recovery requires the opposite
// (no result exists yet).
export const RECOVERY_POLICY = "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1";
export const RECOVERY_PROTOCOL =
  "DUCELIO_COMMERCIAL_V1_EXAMINER_RECOVERY_HMAC_SHA256_V1";
export const RECOVERY_EXECUTION_KIND = "PROVIDER_BACKED_RECOVERY_V1" as const;

// Recovery reuses the exact same capability vocabulary as initial grading
// (grade_controlled_assessment/grade_practical_lab), never a separate
// regrade_* pair -- it is config-governed by the SAME programme-version
// EXAMINER academic_agent_configs row/capability set migration 036 already
// added to initial grading's own AUTHORIZE. See migration 202609240040's
// header comment for why this composition was chosen over reusing regrade's
// unconditional admin-override model.
export type RecoveryCapability = ExaminerCapability;

// Identifier-only, bounded-reason input. Deliberately excludes marks,
// score, weight, pass/fail, a previous proposed grade, provider/model
// choice, learner identity or any grading instruction -- there is no field
// anywhere on this schema through which a caller could supply one.
export const recoveryInputSchema = z.strictObject({
  sourceExecutionId: z.uuid(),
  reason: z.string().trim().min(1).max(300),
});
export type RecoveryInput = z.infer<typeof recoveryInputSchema>;

export const recoverySnapshotSchema = examinerExecutionSnapshotSchema
  .extend({
    actorId: z.uuid(),
    sourceExecutionId: z.uuid(),
    policyVersion: z.literal(RECOVERY_POLICY),
    executionKind: z.literal(RECOVERY_EXECUTION_KIND),
  })
  .refine(
    (s) =>
      (s.targetKind === "ASSESSMENT_ATTEMPT"
        ? s.capability === "grade_controlled_assessment" &&
          s.attemptId !== null &&
          s.component !== null &&
          s.submissionId === null &&
          s.practicalId === null
        : s.capability === "grade_practical_lab" &&
          s.submissionId !== null &&
          s.practicalId !== null &&
          s.attemptId === null &&
          s.component === null) &&
      (s.state === "SUCCEEDED") === (s.resultRevisionId !== null) &&
      (s.state === "SUCCEEDED") === (s.gradeDigest !== null),
    "Inconsistent recovery identity or terminal result",
  );
export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;

// No new error codes: every denial recovery's AUTHORIZE can produce
// (TARGET_NOT_ELIGIBLE covers an ineligible original terminal state, an
// active/non-terminal original, or an inactive enrolment; ALREADY_GRADED
// covers a target that already has a result; POLICY_BLOCKED/
// UNKNOWN_MODEL_PROFILE cover config governance) already exists in initial
// grading's own vocabulary.
export const recoveryErrorSchema = examinerExecutionErrorSchema;
export const recoveryDenialSchema = z.strictObject({
  ok: z.literal(false),
  code: recoveryErrorSchema,
});
export const recoveryRpcSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: recoverySnapshotSchema,
  }),
  recoveryDenialSchema,
]);
export class RecoveryDenied extends Error {
  constructor(
    readonly code: z.infer<typeof recoveryErrorSchema> | "SERVICE_UNAVAILABLE",
    readonly databaseTerminal = false,
  ) {
    super("Examiner initial-grade recovery unavailable.");
    this.name = "RecoveryDenied";
  }
}

// Caller-safe outcome vocabulary. Never carries marks, provider text or any
// protected content -- the actual grade lives in PR11A's result-storage
// tables, read back only through their own bounded projections.
export type RecoveryResult =
  | { status: "RECOVERED" | "ALREADY_RECOVERED"; resultRevisionId: string }
  | {
      status:
        "ESCALATED" | "UNAVAILABLE" | "RETRY_LATER" | "TARGET_NOT_ELIGIBLE";
    };
