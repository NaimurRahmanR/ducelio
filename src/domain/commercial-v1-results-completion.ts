import { z } from "zod";

// Commercial V1 PR11 pass 11A: deterministic results, lab policy/
// submission, objective outcomes, remediation and course completion.
// Migration 202609150030_commercial_v1_results_completion.sql.
//
// Explicitly NOT implemented here: provider-backed Examiner execution, AI
// grading, leaderboards. No writer RPC accepts a caller-supplied mark --
// trusted finalization is 11B, cryptographically/controller-bound to
// Examiner execution.
export const COMMERCIAL_V1_RESULTS_POLICY = "COMMERCIAL_V1_RESULTS_V1" as const;

// Governed admin RPC input shapes -- deliberately minimal, matching the
// exact RPC signatures. No weight/profile/mark field is ever accepted from
// a caller for anything this checkpoint writes.
export const setCommercialV1LabPolicyInputSchema = z.strictObject({
  activationId: z.uuid(),
  practicalId: z.uuid(),
  maxMarks: z.number().int().min(1).max(100),
  contributionBp: z.number().int().min(0).max(2000),
  gradingGuidance: z.string().trim().min(1).max(4000).nullable(),
  reason: z.string().trim().min(5).max(300),
});
export type SetCommercialV1LabPolicyInput = z.infer<
  typeof setCommercialV1LabPolicyInputSchema
>;

// No universal pass mark exists anywhere in Ducelio. pass_mark_bp is
// explicit, bounded, institution-supplied input to this RPC -- never a
// hardcoded default in TypeScript, SQL, or package content.
export const publishCommercialV1ResultPolicyInputSchema = z.strictObject({
  activationId: z.uuid(),
  passMarkBp: z.number().int().min(1).max(10000),
  requireRemediationClearForCompletion: z.boolean(),
  reason: z.string().trim().min(5).max(300),
});
export type PublishCommercialV1ResultPolicyInput = z.infer<
  typeof publishCommercialV1ResultPolicyInputSchema
>;

export const submitCommercialV1LabWorkInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
  practicalId: z.uuid(),
  body: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type SubmitCommercialV1LabWorkInput = z.infer<
  typeof submitCommercialV1LabWorkInputSchema
>;

export const attemptCommercialV1CourseCompletionInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export type AttemptCommercialV1CourseCompletionInput = z.infer<
  typeof attemptCommercialV1CourseCompletionInputSchema
>;

// Objective outcome classification: zero threshold, exact-max threshold,
// otherwise partial. No percentage threshold anywhere.
export const commercialV1ObjectiveOutcomeSchema = z.enum([
  "CORRECT",
  "PARTIAL",
  "INCORRECT",
]);
export type CommercialV1ObjectiveOutcome = z.infer<
  typeof commercialV1ObjectiveOutcomeSchema
>;

// The bounded course-progress projection
// (get_commercial_v1_course_progress). No answer key, prompt, marking
// guidance, raw learner response, provider content or internal execution
// metadata anywhere in this shape.
const componentStatusSchema = z.union([
  z.strictObject({ status: z.literal("PENDING") }),
  z.strictObject({
    status: z.literal("FINALIZED"),
    scoreBp: z.number().int().min(0).max(10000),
    weightedContributionBp: z.number().int().min(0).max(10000),
  }),
]);
const labStatusSchema = z.union([
  z.strictObject({ status: z.literal("PENDING") }),
  z.strictObject({
    status: z.literal("FINALIZED"),
    weightedContributionBp: z.number().int().min(0).max(2000),
  }),
]);
export const commercialV1CourseProgressSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    activationId: z.uuid(),
    gradingPolicyPublished: z.boolean(),
    resultPolicyPublished: z.boolean(),
    passMarkBp: z.number().int().min(1).max(10000).nullable(),
    requireRemediationClearForCompletion: z.boolean().nullable(),
    components: z.record(z.string(), componentStatusSchema),
    labs: z.record(z.string(), labStatusSchema),
    courseScoreBp: z.number().int().min(0).max(10000).nullable(),
    pending: z.array(z.record(z.string(), z.unknown())),
    openRemediationCount: z.number().int().min(0),
    enrolmentStatus: z.string(),
    completed: z.boolean(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("NOT_FOUND_OR_FORBIDDEN"),
  }),
]);
export type CommercialV1CourseProgress = z.infer<
  typeof commercialV1CourseProgressSchema
>;

export const listCommercialV1ObjectiveDiagnosticsInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(10000),
});
export type ListCommercialV1ObjectiveDiagnosticsInput = z.infer<
  typeof listCommercialV1ObjectiveDiagnosticsInputSchema
>;

const commercialV1ComponentSchema = z.enum([
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
]);
const commercialV1ObjectiveDiagnosticItemSchema = z.discriminatedUnion(
  "sourceKind",
  [
    z.strictObject({
      objectiveId: z.uuid(),
      sourceKind: z.literal("ASSESSMENT"),
      component: commercialV1ComponentSchema,
      practicalId: z.null(),
      outcome: commercialV1ObjectiveOutcomeSchema,
      remediationOpen: z.boolean(),
    }),
    z.strictObject({
      objectiveId: z.uuid(),
      sourceKind: z.literal("LAB"),
      component: z.null(),
      practicalId: z.uuid(),
      outcome: commercialV1ObjectiveOutcomeSchema,
      remediationOpen: z.boolean(),
    }),
  ],
);
export const commercialV1ObjectiveDiagnosticsSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    items: z.array(commercialV1ObjectiveDiagnosticItemSchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(10000),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("NOT_FOUND_OR_FORBIDDEN"),
  }),
]);
export type CommercialV1ObjectiveDiagnostics = z.infer<
  typeof commercialV1ObjectiveDiagnosticsSchema
>;

export const attemptCommercialV1CourseCompletionResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    code: z.enum(["COMPLETED", "ALREADY_COMPLETED"]),
    receiptId: z.uuid(),
    courseScoreBp: z.number().int().min(0).max(10000).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "NOT_FOUND_OR_FORBIDDEN",
      "ENROLMENT_NOT_ACTIVE",
      "RESULT_POLICY_REQUIRED",
      "COMPONENTS_INCOMPLETE",
      "BELOW_PASS_MARK",
      "REMEDIATION_NOT_CLEAR",
      "COMPLETION_RECEIPT_MISSING",
    ]),
    pending: z.array(z.record(z.string(), z.unknown())).optional(),
    courseScoreBp: z.number().int().min(0).max(10000).optional(),
    passMarkBp: z.number().int().min(1).max(10000).optional(),
  }),
]);
export type AttemptCommercialV1CourseCompletionResult = z.infer<
  typeof attemptCommercialV1CourseCompletionResultSchema
>;
