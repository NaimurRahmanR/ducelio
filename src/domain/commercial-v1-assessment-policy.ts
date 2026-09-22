import { z } from "zod";

// Commercial V1: assessment policy + one-sitting controlled assessment
// lifecycle. Migration 202609140029_commercial_v1_assessment_policy.sql.
// Additive over the existing Phase 2 controlled-assessment foundation
// (migration 016/020, untouched in shape) and the Commercial V1 course-
// activation provenance system (migration 027, untouched).
export const COMMERCIAL_V1_GRADING_POLICY = "COMMERCIAL_V1_GRADING_V1" as const;

// Every Commercial V1 course contains exactly six formal controlled
// assessment components, in this institutionally meaningful order. Never
// inferred from title/template-key/position/package content -- always an
// explicit, governed, post-activation binding (see
// commercial_v1_component_bindings, migration 029).
export const COMMERCIAL_V1_COMPONENTS = [
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
] as const;
export const commercialV1ComponentSchema = z.enum(COMMERCIAL_V1_COMPONENTS);
export type CommercialV1Component = z.infer<typeof commercialV1ComponentSchema>;

export const commercialV1ResolvedProfileSchema = z.enum([
  "WITH_LABS",
  "NO_LABS",
]);
export type CommercialV1ResolvedProfile = z.infer<
  typeof commercialV1ResolvedProfileSchema
>;

// Code-owned, exact, integer basis-point weights (never floating point).
// The profile and the weights are ALWAYS server-derived at publication time
// from actual activated course provenance (PRACTICAL_LAB presence) -- there
// is no schema field anywhere in this module through which a caller could
// choose a profile or supply a custom weight. See
// publish_commercial_v1_grading_policy (migration 029), which accepts only
// an activation id and a bounded administrative reason.
export const COMMERCIAL_V1_WEIGHTS_BP: Readonly<
  Record<
    CommercialV1ResolvedProfile,
    Record<CommercialV1Component | "LABS", number>
  >
> = Object.freeze({
  WITH_LABS: Object.freeze({
    QUIZ_1: 500,
    QUIZ_2: 500,
    MIDTERM: 2000,
    QUIZ_3: 500,
    QUIZ_4: 500,
    LABS: 2000,
    FINAL: 4000,
  }),
  NO_LABS: Object.freeze({
    QUIZ_1: 500,
    QUIZ_2: 500,
    MIDTERM: 2000,
    QUIZ_3: 500,
    QUIZ_4: 500,
    LABS: 0,
    FINAL: 6000,
  }),
});
export const COMMERCIAL_V1_TOTAL_WEIGHT_BP = 10000;

// The published, immutable grading-policy shape a later results/leaderboard
// checkpoint will consume -- never recomputed from current course/package
// state at read time.
export const commercialV1GradingPolicySchema = z.strictObject({
  activationId: z.uuid(),
  cohortId: z.uuid(),
  programmeVersionId: z.uuid(),
  policyVersion: z.literal(COMMERCIAL_V1_GRADING_POLICY),
  resolvedProfile: commercialV1ResolvedProfileSchema,
  quiz1WeightBp: z.literal(500),
  quiz2WeightBp: z.literal(500),
  midtermWeightBp: z.literal(2000),
  quiz3WeightBp: z.literal(500),
  quiz4WeightBp: z.literal(500),
  labsWeightBp: z.union([z.literal(0), z.literal(2000)]),
  finalWeightBp: z.union([z.literal(4000), z.literal(6000)]),
  publishedBy: z.uuid(),
  publishedAt: z.string(),
});
export type CommercialV1GradingPolicy = z.infer<
  typeof commercialV1GradingPolicySchema
>;

// Governed admin RPC input shapes. Deliberately minimal: the caller names
// only WHICH real assessment fills WHICH formal component slot (bind), or
// simply asks to publish (activationId + a bounded reason) -- never a
// weight, a profile choice, or a lab-presence boolean.
export const bindCommercialV1ComponentInputSchema = z.strictObject({
  activationId: z.uuid(),
  component: commercialV1ComponentSchema,
  assessmentId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export type BindCommercialV1ComponentInput = z.infer<
  typeof bindCommercialV1ComponentInputSchema
>;

export const publishCommercialV1GradingPolicyInputSchema = z.strictObject({
  activationId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export type PublishCommercialV1GradingPolicyInput = z.infer<
  typeof publishCommercialV1GradingPolicyInputSchema
>;

// Persisted, server-derived provenance: on-time learner submit, elapsed deadline,
// or institutional closure. Historical submissions are separately unclassified;
// their original cause cannot be reconstructed truthfully.
export const submissionProvenanceSchema = z.enum([
  "STUDENT_SUBMIT",
  "AUTO_TIMEOUT",
  "ADMIN_CLOSED",
]);
export type SubmissionProvenance = z.infer<typeof submissionProvenanceSchema>;

// The full vocabulary a RAW read of assessment_attempts.submission_provenance
// must expect (unlike submissionProvenanceSchema above, which validates only
// a GOVERNED RPC's own result and therefore never needs to accept the
// legacy sentinel). Not used by any governed RPC result today -- provided
// for a future admin/audit surface that might read the column directly.
export const commercialV1SubmissionProvenanceColumnSchema = z.enum([
  "STUDENT_SUBMIT",
  "AUTO_TIMEOUT",
  "ADMIN_CLOSED",
  "LEGACY_UNCLASSIFIED",
]);
export type CommercialV1SubmissionProvenanceColumn = z.infer<
  typeof commercialV1SubmissionProvenanceColumnSchema
>;

// Result of the dedicated Commercial V1 response RPC
// (record_commercial_v1_assessment_response, migration 029). Never raises
// for the expected EXPIRED-at-deadline case -- returns this deterministic
// shape instead, so a refused write and a durable AUTO_TIMEOUT transition
// can both be reported from the SAME governed call without a rolled-back
// exception undoing the transition.
export const recordCommercialV1ResponseResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), responseId: z.uuid() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("EXPIRED"),
    state: z.literal("SUBMITTED"),
    submittedAt: z.iso.datetime({ offset: true }),
    submissionProvenance: z.literal("AUTO_TIMEOUT"),
  }),
  // The database's "this attempt is not Commercial V1-governed" answer. It is
  // its own union member (rather than one more enum value) so the server's
  // response composition can remove exactly this internal routing signal from
  // the type it hands to callers -- see AssessmentResponseOutcome in
  // src/server/assessments.ts. The accepted wire shapes are unchanged.
  z.strictObject({
    ok: z.literal(false),
    code: z.literal("NOT_COMMERCIAL_V1_GOVERNED"),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      "INVALID_INPUT",
      "NOT_FOUND_OR_FORBIDDEN",
      "ATTEMPT_NOT_ACTIVE",
      "RESPONSE_WINDOW_CLOSED",
      "IDEMPOTENCY_CONFLICT",
    ]),
  }),
]);
export type RecordCommercialV1ResponseResult = z.infer<
  typeof recordCommercialV1ResponseResultSchema
>;

// Input for the dedicated RPC -- identical bounds to the pre-existing
// legacy assessment-response schema (src/server/assessments.ts); no
// timestamp, state, or provenance field exists for a caller to supply.
export const recordCommercialV1ResponseInputSchema = z.strictObject({
  attemptId: z.uuid(),
  questionId: z.uuid(),
  body: z.string().trim().min(1).max(20000),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type RecordCommercialV1ResponseInput = z.infer<
  typeof recordCommercialV1ResponseInputSchema
>;

// The bounded, safe learner-facing resume DTO
// (get_commercial_v1_active_attempt, migration 029): identifiers and
// authoritative timing only. No question prompt, no answer key, no marking
// guidance, no other learner's data, no internal governance identifier.
export const commercialV1ActiveAttemptSchema = z
  .strictObject({
    attemptId: z.uuid(),
    assessmentId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    title: z.string(),
    startedAt: z.string(),
    expiresAt: z.string(),
  })
  .nullable();
export type CommercialV1ActiveAttempt = z.infer<
  typeof commercialV1ActiveAttemptSchema
>;
