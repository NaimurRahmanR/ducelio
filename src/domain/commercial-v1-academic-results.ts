import { z } from "zod";
import type { RegradeResult } from "./commercial-v1-examiner-regrade";
import type { AttemptCommercialV1CourseCompletionResult } from "./commercial-v1-results-completion";

// Academic results operations (migration
// 202610020048_commercial_v1_academic_results_operations.sql). Read-only
// admin projections over the append-only result model. The database owns
// every identity, mark, weight, current/valid state and provenance value;
// these contracts only bound what the server layer sends and parses.

export const ACADEMIC_RESULTS_PAGE_SIZE = 50;
export const ACADEMIC_RESULTS_MAX_OFFSET = 100_000;
// Operational READ bound on one detail response's revision history (the
// newest revisions of the target). Not a limit on how many revisions may
// exist: older revisions stay in the append-only record and in the
// paginated all-revisions listing.
export const ACADEMIC_RESULT_HISTORY_LIMIT = 100;

export const academicResultComponents = [
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
] as const;
const componentSchema = z.enum(academicResultComponents);
const kindSchema = z.enum(["ASSESSMENT", "LAB"]);
export type AcademicResultKind = z.infer<typeof kindSchema>;

export const academicResultOriginSchema = z.enum([
  "EXAMINER_INITIAL",
  "EXAMINER_RECOVERY",
  "EXAMINER_REGRADE",
  "HUMAN_ACADEMIC_REVIEW",
  "UNATTRIBUTED",
]);
export type AcademicResultOrigin = z.infer<typeof academicResultOriginSchema>;
export const academicResultOriginLabels: Record<AcademicResultOrigin, string> =
  {
    EXAMINER_INITIAL: "Examiner grading",
    EXAMINER_RECOVERY: "Examiner grade recovery",
    EXAMINER_REGRADE: "Institutional regrade",
    HUMAN_ACADEMIC_REVIEW: "Human academic review",
    // No governed claim references the revision (for example, seeded or
    // pre-provenance data). Shown truthfully rather than guessed.
    UNATTRIBUTED: "No recorded grading claim",
  };

const timestamp = z.string().min(1);
const marks = z.number().int().nonnegative();
const bp = z.number().int().min(0).max(10000);

// Bounded list row: labels, marks and state only.
export const academicResultSummarySchema = z.strictObject({
  resultId: z.uuid(),
  kind: kindSchema,
  revisionNumber: z.number().int().positive(),
  isCurrent: z.boolean(),
  isValid: z.boolean(),
  origin: academicResultOriginSchema,
  earnedMarks: marks,
  maxMarks: marks,
  scoreBp: bp.nullable(),
  weightBp: bp,
  weightedContributionBp: bp,
  finalizedAt: timestamp,
  component: componentSchema.nullable(),
  practicalId: z.uuid().nullable(),
  targetTitle: z.string().nullable(),
  enrolmentId: z.uuid(),
  enrolmentStatus: z.string(),
  completed: z.boolean(),
  learnerName: z.string().nullable(),
  studentNumber: z.string().nullable(),
  cohortTitle: z.string().nullable(),
  programmeTitle: z.string().nullable(),
  versionLabel: z.string().nullable(),
});
export type AcademicResultSummary = z.infer<typeof academicResultSummarySchema>;

export const academicResultPageSchema = z.strictObject({
  results: z.array(academicResultSummarySchema).max(ACADEMIC_RESULTS_PAGE_SIZE),
  hasMore: z.boolean(),
  offset: z.number().int().min(0).max(ACADEMIC_RESULTS_MAX_OFFSET),
});

const option = z.strictObject({ id: z.uuid(), title: z.string() });
export const academicResultFilterOptionsSchema = z.strictObject({
  cohorts: z.array(option).max(200),
  programmeVersions: z
    .array(
      z.strictObject({ id: z.uuid(), title: z.string(), label: z.string() }),
    )
    .max(200),
  practicals: z.array(option).max(200),
});
export type AcademicResultFilterOptions = z.infer<
  typeof academicResultFilterOptionsSchema
>;

const actorName = z.string().nullable();
export const academicResultProvenanceSchema = z.discriminatedUnion("origin", [
  z.strictObject({
    origin: z.literal("HUMAN_ACADEMIC_REVIEW"),
    decisionId: z.uuid(),
    caseKind: z.string(),
    actorName,
    reason: z.string(),
    decidedAt: timestamp,
  }),
  z.strictObject({
    origin: z.literal("EXAMINER_REGRADE"),
    executionId: z.uuid(),
    sourceResultRevisionId: z.uuid(),
    sourceRevisionNumber: z.number().int().positive(),
    actorName,
    reason: z.string(),
    decidedAt: timestamp.nullable(),
  }),
  z.strictObject({
    origin: z.literal("EXAMINER_RECOVERY"),
    executionId: z.uuid(),
    sourceExecutionId: z.uuid(),
    actorName,
    reason: z.string(),
    decidedAt: timestamp.nullable(),
  }),
  z.strictObject({
    origin: z.literal("EXAMINER_INITIAL"),
    executionId: z.uuid(),
    decidedAt: timestamp.nullable(),
  }),
  z.strictObject({ origin: z.literal("UNATTRIBUTED") }),
]);
export type AcademicResultProvenance = z.infer<
  typeof academicResultProvenanceSchema
>;

const historyItem = z.strictObject({
  resultId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  isCurrent: z.boolean(),
  isValid: z.boolean(),
  origin: academicResultOriginSchema,
  earnedMarks: marks,
  maxMarks: marks,
  scoreBp: bp.nullable(),
  weightedContributionBp: bp,
  finalizedAt: timestamp,
});
const objectiveOutcome = z.strictObject({
  objectiveId: z.uuid(),
  description: z.string(),
  earnedMarks: marks,
  maxMarks: marks,
  outcome: z.enum(["CORRECT", "PARTIAL", "INCORRECT"]),
  remediationOpen: z.boolean(),
});
// The existing outgoing regrade claim for a revision (migration 032 admits
// at most one per source revision). Bounded operational metadata only: no
// digest, MAC/controller data, provider output, budget, usage or protected
// context.
export const regradeClaimStateSchema = z.enum([
  "AUTHORIZED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ESCALATED",
  "BUDGET_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
]);
export type RegradeClaimState = z.infer<typeof regradeClaimStateSchema>;
export const academicResultRegradeClaimSchema = z.strictObject({
  executionId: z.uuid(),
  state: regradeClaimStateSchema,
  reasonCode: z.string().nullable(),
  requestReason: z.string(),
  actorName: z.string().nullable(),
  createdAt: timestamp,
  terminalAt: timestamp.nullable(),
  producedResultRevisionId: z.uuid().nullable(),
  // AUTHORIZED/RUNNING past its execution window: the regrade authority
  // records it as TIMEOUT on its next check.
  expired: z.boolean(),
});
export type AcademicResultRegradeClaim = z.infer<
  typeof academicResultRegradeClaimSchema
>;

const detailBase = academicResultSummarySchema.extend({
  activationId: z.uuid(),
  provenance: academicResultProvenanceSchema,
  // Newest revisions of the target, ascending, never more than the read
  // bound. historyHasMore says older revisions exist outside this window.
  history: z.array(historyItem).min(1).max(ACADEMIC_RESULT_HISTORY_LIMIT),
  historyHasMore: z.boolean(),
  historyLimit: z.literal(ACADEMIC_RESULT_HISTORY_LIMIT),
  regradeClaim: academicResultRegradeClaimSchema.nullable(),
  objectiveOutcomes: z.array(objectiveOutcome),
});
export const academicResultDetailSchema = z.discriminatedUnion("kind", [
  detailBase.extend({
    kind: z.literal("ASSESSMENT"),
    assessmentId: z.uuid(),
    attemptId: z.uuid(),
    attemptSubmittedAt: timestamp.nullable(),
    // Positions and marks only: no prompt, answer key, guidance or response.
    questionMarks: z.array(
      z.strictObject({
        questionId: z.uuid(),
        position: z.number().int(),
        marksAwarded: marks,
        maxMarks: marks,
      }),
    ),
  }),
  detailBase.extend({
    kind: z.literal("LAB"),
    submissionId: z.uuid(),
    submissionSubmittedAt: timestamp.nullable(),
  }),
]);
export type AcademicResultDetail = z.infer<typeof academicResultDetailSchema>;

export const academicEnrolmentRecordSchema = z.strictObject({
  enrolmentId: z.uuid(),
  enrolmentStatus: z.string(),
  learnerName: z.string().nullable(),
  studentNumber: z.string().nullable(),
  cohortTitle: z.string().nullable(),
  programmeTitle: z.string().nullable(),
  versionLabel: z.string().nullable(),
  receipt: z
    .strictObject({
      receiptId: z.uuid(),
      finalCourseScoreBp: bp,
      passMarkBp: bp,
      completedAt: timestamp,
      completedByName: z.string().nullable(),
    })
    .nullable(),
});
export type AcademicEnrolmentRecord = z.infer<
  typeof academicEnrolmentRecordSchema
>;

// Search-param filters. Unknown or malformed values are dropped (the page
// still renders the bounded default listing); the database re-validates.
const optionalUuid = z.uuid().optional().catch(undefined);
export const academicResultFiltersSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  kind: kindSchema.optional().catch(undefined),
  cohort: optionalUuid,
  version: optionalUuid,
  component: componentSchema.optional().catch(undefined),
  practical: optionalUuid,
  history: z.literal("1").optional().catch(undefined),
  completion: z
    .enum(["COMPLETED", "NOT_COMPLETED"])
    .optional()
    .catch(undefined),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(ACADEMIC_RESULTS_MAX_OFFSET)
    .optional()
    .catch(undefined),
  result: optionalUuid,
  enrolment: optionalUuid,
});
export type AcademicResultFilters = z.infer<typeof academicResultFiltersSchema>;

const reason = z.string().trim().min(5).max(300);
// The browser names only the revision it is looking at plus a reason. The
// kind, current/valid state, learner, enrolment, activation, target, weights,
// max marks, revision number, model/provider and budgets are all resolved by
// the database (and the existing regrade authority) from that id.
export const academicResultRegradeInput = z.strictObject({
  resultId: z.uuid(),
  reason,
});
export const academicEnrolmentCompletionInput = z.strictObject({
  enrolmentId: z.uuid(),
  reason,
});

export const academicResultsRefusalMessages = {
  FORBIDDEN:
    "Only an Academic Admin or Platform Admin can use academic results operations.",
  INVALID_INPUT: "Check the request and the reason (5–300 characters).",
  NOT_FOUND: "That result or enrolment no longer exists.",
  SELF_RECORD_FORBIDDEN:
    "You cannot view or act on your own academic record here.",
  NOT_CURRENT_RESULT:
    "Only the current revision can be regraded. Earlier revisions are history.",
  CURRENT_RESULT_INVALID:
    "This revision failed the result integrity checks, so it cannot be regraded.",
  REGRADE_CLAIM_EXISTS:
    "This revision already has its one regrade claim. The current policy does not permit another claim for the same revision.",
  SERVICE_UNAVAILABLE: "The request could not be completed. Try again.",
} as const;
export type AcademicResultsRefusalCode =
  keyof typeof academicResultsRefusalMessages;

export function academicResultsRefusalCode(
  message: unknown,
): AcademicResultsRefusalCode {
  const text = typeof message === "string" ? message : "";
  if (text === "INVALID_INPUT" || text === "FORBIDDEN" || text === "NOT_FOUND")
    return text;
  if (text === "SELF_RECORD_FORBIDDEN") return text;
  return "SERVICE_UNAVAILABLE";
}

export class AcademicResultsError extends Error {
  constructor(readonly code: AcademicResultsRefusalCode) {
    super(code);
    this.name = "AcademicResultsError";
  }
}
export function academicResultsRefusalMessage(error: unknown) {
  return academicResultsRefusalMessages[
    error instanceof AcademicResultsError ? error.code : "SERVICE_UNAVAILABLE"
  ];
}

export const regradeOutcomeMessages: Record<RegradeResult["status"], string> = {
  REGRADED:
    "Regrade recorded as a new revision. It is now the current result; the earlier revision remains in the history.",
  ALREADY_REGRADED:
    "This revision was already regraded. The existing regrade outcome was kept.",
  ESCALATED:
    "The regrade was escalated for human judgment. No new revision was created; the current result is unchanged.",
  UNAVAILABLE:
    "The regrade could not be completed. No new revision was created; the current result is unchanged.",
  RETRY_LATER:
    "A regrade for this learner is already running or the regrade limit was reached. Try again shortly.",
  TARGET_NOT_ELIGIBLE:
    "This learner's enrolment is not eligible for regrade (only ACTIVE enrolments can be regraded).",
  NOT_CURRENT_RESULT: academicResultsRefusalMessages.NOT_CURRENT_RESULT,
  CURRENT_RESULT_INVALID: academicResultsRefusalMessages.CURRENT_RESULT_INVALID,
};

type CompletionCode = AttemptCommercialV1CourseCompletionResult["code"];
export const completionOutcomeMessages: Record<CompletionCode, string> = {
  COMPLETED: "Course completed. The completion receipt has been recorded.",
  ALREADY_COMPLETED: "This enrolment was already completed.",
  NOT_FOUND_OR_FORBIDDEN: "This enrolment is not available for completion.",
  ENROLMENT_NOT_ACTIVE:
    "Only an ACTIVE enrolment can be completed. The enrolment state was not changed.",
  RESULT_POLICY_REQUIRED:
    "No result policy (pass mark) is published for this course, so completion is unavailable.",
  COMPONENTS_INCOMPLETE:
    "Not every graded component has a current valid result yet.",
  BELOW_PASS_MARK: "The final course score is below the published pass mark.",
  REMEDIATION_NOT_CLEAR:
    "The result policy requires all remediation to be resolved before completion.",
  COMPLETION_RECEIPT_MISSING:
    "The enrolment is marked completed but has no completion receipt. Refer this to a platform administrator.",
};

export function formatBp(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${(value / 100).toFixed(2)}%`;
}
