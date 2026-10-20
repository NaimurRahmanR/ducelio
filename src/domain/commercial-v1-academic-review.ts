import { z } from "zod";
import { objectiveQuestionTypeSchema } from "./assessment-question-types";

// Human academic review / manual first grade (migration
// 202610020047_commercial_v1_human_academic_review.sql). The database is the
// authority: it resolves every target identity and policy value from the case
// id. These contracts only bound what the server layer sends and parses.

export const academicReviewCaseKindSchema = z.enum([
  "INITIAL_ESCALATION",
  "RECOVERY_ESCALATION",
  "RECOVERY_EXHAUSTED",
]);
export type AcademicReviewCaseKind = z.infer<
  typeof academicReviewCaseKindSchema
>;
export const academicReviewCaseKindLabels: Record<
  AcademicReviewCaseKind,
  string
> = {
  INITIAL_ESCALATION: "Initial grading escalated to human review",
  RECOVERY_ESCALATION: "Grade recovery escalated to human review",
  RECOVERY_EXHAUSTED: "Grade recovery used and still ungraded",
};

const targetKind = z.enum(["ASSESSMENT_ATTEMPT", "LAB_SUBMISSION"]);
const timestamp = z.string().min(1);

// Bounded case metadata (no bodies, answer keys, guidance or provider data).
export const academicReviewCaseSummarySchema = z.strictObject({
  caseId: z.uuid(),
  caseKind: academicReviewCaseKindSchema,
  caseState: z.enum([
    "ESCALATED",
    "FAILED",
    "TIMEOUT",
    "BUDGET_BLOCKED",
    "CANCELLED",
  ]),
  caseReasonCode: z.string(),
  caseOpenedAt: timestamp,
  targetKind,
  component: z.string().nullable(),
  targetTitle: z.string().nullable(),
  programmeTitle: z.string().nullable(),
  cohortTitle: z.string().nullable(),
  learnerName: z.string().nullable(),
  studentNumber: z.string().nullable(),
  submittedAt: timestamp.nullable(),
});
export type AcademicReviewCaseSummary = z.infer<
  typeof academicReviewCaseSummarySchema
>;
export const academicReviewCaseListSchema = z.strictObject({
  cases: z.array(academicReviewCaseSummarySchema).max(200),
});

const reviewQuestionSchema = z.strictObject({
  questionId: z.uuid(),
  position: z.number().int(),
  prompt: z.string(),
  maxMarks: z.number().int().positive(),
  expectedAnswer: z.string().nullable(),
  markingGuidance: z.string().nullable(),
  answered: z.boolean(),
  responseBody: z.string().nullable(),
  // CP2 (migration 059): objective questions carry their learner-visible
  // definition and the database scorer's mark. The reviewer cannot change
  // that mark; the database rejects any other value for the question.
  objective: z
    .strictObject({
      questionType: objectiveQuestionTypeSchema,
      interaction: z.unknown(),
      deterministicMarks: z.number().int().min(0),
    })
    .nullable()
    .default(null),
});
export type AcademicReviewQuestion = z.infer<typeof reviewQuestionSchema>;

export const academicReviewAssessmentCaseSchema =
  academicReviewCaseSummarySchema.extend({
    targetKind: z.literal("ASSESSMENT_ATTEMPT"),
    assessment: z.strictObject({
      title: z.string(),
      instructions: z.string().nullable(),
      componentWeightBp: z.number().int().nonnegative().nullable(),
      maxMarksTotal: z.number().int().positive(),
      // No count ceiling here: the database (not this contract) owns the
      // authoritative question set, and the writer validates every question
      // exactly once whatever its size.
      questions: z.array(reviewQuestionSchema).min(1),
    }),
  });
export const academicReviewLabCaseSchema =
  academicReviewCaseSummarySchema.extend({
    targetKind: z.literal("LAB_SUBMISSION"),
    lab: z.strictObject({
      title: z.string().nullable(),
      instructions: z.string().nullable(),
      maxMarks: z.number().int().positive().nullable(),
      contributionBp: z.number().int().nonnegative().nullable(),
      gradingGuidance: z.string().nullable(),
      submissionBody: z.string().nullable(),
      objectives: z.array(z.strictObject({ description: z.string() })),
    }),
  });
export const academicReviewCaseSchema = z.discriminatedUnion("targetKind", [
  academicReviewAssessmentCaseSchema,
  academicReviewLabCaseSchema,
]);
export type AcademicReviewCase = z.infer<typeof academicReviewCaseSchema>;

const reason = z.string().trim().min(5).max(300);
const mark = z.number().int().min(0).max(999_999);
export const academicReviewAssessmentGradeInput = z.strictObject({
  caseId: z.uuid(),
  marks: z
    .array(z.strictObject({ questionId: z.uuid(), marksAwarded: mark }))
    .min(1),
  reason,
});
export const academicReviewLabGradeInput = z.strictObject({
  caseId: z.uuid(),
  marksAwarded: mark,
  reason,
});

export const academicReviewGradeResultSchema = z.strictObject({
  ok: z.literal(true),
  code: z.enum(["RESULT_CREATED", "ALREADY_RESOLVED"]),
  decisionId: z.uuid(),
  resultRevisionId: z.uuid(),
  revisionNumber: z.literal(1),
  earnedMarks: z.number().int().optional(),
  maxMarks: z.number().int().optional(),
});
export type AcademicReviewGradeResult = z.infer<
  typeof academicReviewGradeResultSchema
>;

// Bounded refusal vocabulary raised by migration 047, plus result-integrity
// guard codes from migration 030 that a write can surface. Anything else is
// SERVICE_UNAVAILABLE so raw database text never reaches the browser.
export const academicReviewRefusalMessages = {
  FORBIDDEN:
    "Only an Academic Admin or Platform Admin can perform academic review.",
  INVALID_INPUT:
    "Check the marks and the reason (5–300 characters), then try again.",
  INVALID_REASON: "A reason of 5–300 characters is required.",
  CASE_NOT_FOUND: "This review case no longer exists.",
  SELF_REVIEW_FORBIDDEN: "You cannot review or grade your own work.",
  CASE_NOT_OPEN:
    "This case is no longer awaiting review: the target already has a result or is not eligible for human review.",
  TARGET_KIND_MISMATCH:
    "This case needs a different kind of grade. Reload the case and try again.",
  INVALID_MARKS:
    "Each mark must be a whole number for a question in this case.",
  MARKS_BELOW_ZERO: "Marks cannot be negative.",
  MARKS_EXCEED_MAX: "A mark exceeds the authoritative maximum for that item.",
  DUPLICATE_QUESTION: "A question was marked more than once.",
  FOREIGN_QUESTION: "A mark was given for a question outside this assessment.",
  INCOMPLETE_QUESTION_MARKS:
    "Every question must receive a mark (unanswered questions are recorded as 0).",
  UNANSWERED_QUESTION_GRADED:
    "An unanswered question can only receive 0 marks.",
  LAB_POLICY_REQUIRED:
    "This lab has no published lab policy, so it cannot be graded yet.",
  RESULT_INTEGRITY_FAILED:
    "The result failed the institutional integrity checks. Nothing was saved.",
  SERVICE_UNAVAILABLE:
    "The review could not be completed. Nothing was saved; try again.",
} as const;
export type AcademicReviewRefusalCode =
  keyof typeof academicReviewRefusalMessages;

// Migration 030 result-guard codes that indicate the target's authoritative
// policy/identity state does not admit a result (no partial write remains).
const RESULT_GUARD_CODES = [
  "RESULT_POLICY_REQUIRED",
  "INVALID_ASSESSMENT_RESULT_IDENTITY",
  "INVALID_ASSESSMENT_RESULT_ACTIVATION",
  "INVALID_ASSESSMENT_RESULT_COMPONENT",
  "INVALID_ASSESSMENT_RESULT_ATTEMPT",
  "INVALID_COMPONENT_WEIGHT",
  "INVALID_ASSESSMENT_MAX_TOTAL",
  "INVALID_RESULT_REVISION_SEQUENCE",
  "INVALID_LAB_RESULT_IDENTITY",
  "INVALID_LAB_RESULT_ACTIVATION",
  "INVALID_LAB_RESULT_SUBMISSION",
  "LAB_MAX_MARKS_MISMATCH",
  "LAB_CONTRIBUTION_MISMATCH",
];

export function academicReviewRefusalCode(
  message: unknown,
): AcademicReviewRefusalCode {
  const text = typeof message === "string" ? message : "";
  if (Object.prototype.hasOwnProperty.call(academicReviewRefusalMessages, text))
    return text as AcademicReviewRefusalCode;
  if (RESULT_GUARD_CODES.includes(text)) return "RESULT_INTEGRITY_FAILED";
  return "SERVICE_UNAVAILABLE";
}

export class AcademicReviewError extends Error {
  constructor(readonly code: AcademicReviewRefusalCode) {
    super(code);
    this.name = "AcademicReviewError";
  }
}
export function academicReviewRefusalMessage(error: unknown) {
  return academicReviewRefusalMessages[
    error instanceof AcademicReviewError ? error.code : "SERVICE_UNAVAILABLE"
  ];
}
