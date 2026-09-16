import { z } from "zod";
import {
  examinerExecutionSnapshotSchema,
  examinerExecutionErrorSchema,
} from "./commercial-v1-examiner-grading";

export const REGRADE_POLICY = "COMMERCIAL_V1_EXAMINER_REGRADE_V1";
export const REGRADE_PROTOCOL =
  "DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1";
export const regradeInputSchema = z.strictObject({
  resultRevisionId: z.uuid(),
  reason: z.string().trim().min(1).max(300),
});
export const regradeCapabilitySchema = z.enum([
  "regrade_controlled_assessment",
  "regrade_practical_lab",
]);
export type RegradeCapability = z.infer<typeof regradeCapabilitySchema>;
export const regradeSnapshotSchema = examinerExecutionSnapshotSchema
  .extend({
    actorId: z.uuid(),
    sourceResultRevisionId: z.uuid(),
    sourceRevisionNumber: z.number().int().positive(),
    studentId: z.uuid(),
    enrolmentId: z.uuid(),
    activationId: z.uuid(),
    capability: regradeCapabilitySchema,
    policyVersion: z.literal(REGRADE_POLICY),
    executionKind: z.literal("PROVIDER_BACKED_REGRADE_V1"),
  })
  .refine(
    (s) =>
      (s.targetKind === "ASSESSMENT_ATTEMPT"
        ? s.capability === "regrade_controlled_assessment" &&
          s.attemptId !== null &&
          s.component !== null &&
          s.submissionId === null &&
          s.practicalId === null
        : s.capability === "regrade_practical_lab" &&
          s.submissionId !== null &&
          s.practicalId !== null &&
          s.attemptId === null &&
          s.component === null) &&
      (s.state === "SUCCEEDED") === (s.resultRevisionId !== null) &&
      (s.state === "SUCCEEDED") === (s.gradeDigest !== null),
    "Inconsistent regrade identity or terminal result",
  );
export type RegradeSnapshot = z.infer<typeof regradeSnapshotSchema>;
export const regradeErrorSchema = z.enum([
  ...examinerExecutionErrorSchema.options,
  "NOT_CURRENT_RESULT",
  "CURRENT_RESULT_INVALID",
]);
export const regradeDenialSchema = z.strictObject({
  ok: z.literal(false),
  code: regradeErrorSchema,
});
export const regradeRpcSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    transitioned: z.boolean(),
    execution: regradeSnapshotSchema,
  }),
  regradeDenialSchema,
]);
export class RegradeDenied extends Error {
  constructor(
    readonly code: z.infer<typeof regradeErrorSchema> | "SERVICE_UNAVAILABLE",
    readonly databaseTerminal = false,
  ) {
    super("Examiner regrade unavailable.");
    this.name = "RegradeDenied";
  }
}
export type RegradeResult =
  | {
      status: "REGRADED" | "ALREADY_REGRADED";
      executionId: string;
      resultRevisionId: string;
    }
  | {
      status:
        | "ESCALATED"
        | "UNAVAILABLE"
        | "RETRY_LATER"
        | "TARGET_NOT_ELIGIBLE"
        | "NOT_CURRENT_RESULT"
        | "CURRENT_RESULT_INVALID";
    };
