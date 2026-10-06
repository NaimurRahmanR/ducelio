import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";

// AC-6: Sarah post-session feedback (migration 055). Pure: no server
// built-ins, database or environment.
//
// Sarah Mitchell is the learner-facing persona that asks, but feedback is
// deterministic, structured institutional data: three integer ratings 1-5.
// No model, provider, Sarah execution or AC-5 runtime is involved in
// collecting, storing or aggregating it. Feedback never changes grades,
// marks, mastery, evidence, progress, attendance, session status, agent
// configuration, content, instructor assignment or enrolment, and it is
// never commercial input (AC-7).

export const SESSION_FEEDBACK_POLICY = "SESSION_FEEDBACK_V1" as const;
// Mirror of migration 055: session averages are shown only from this many
// submitted responses.
export const SESSION_FEEDBACK_MIN_RESPONSES = 3;
// Mirror of migration 055: at most this many outstanding prompts.
export const SESSION_FEEDBACK_OPPORTUNITY_LIMIT = 10;
export const TEACHING_QUALITY_PAGE_SIZE = 50;
export const TEACHING_QUALITY_OFFSET_MAX = 100_000;

export const RATING_FIELDS = [
  "clarityRating",
  "paceRating",
  "usefulnessRating",
] as const;
export type RatingField = (typeof RATING_FIELDS)[number];

// Learner wording is friendly; the stored terms stay explicit. Every scale
// is "higher is better"; pace means how well the pace suited the learner.
export const RATING_QUESTION: Readonly<Record<RatingField, string>> =
  Object.freeze({
    clarityRating: "How clear was the session?",
    paceRating: "How was the pace for you?",
    usefulnessRating: "How useful was the session for your learning?",
  });
export const RATING_SCALE_HINT: Readonly<Record<RatingField, string>> =
  Object.freeze({
    clarityRating: "1 = very unclear, 5 = very clear",
    paceRating: "1 = did not suit me at all, 5 = suited me very well",
    usefulnessRating: "1 = not useful, 5 = very useful",
  });
export const RATING_ADMIN_LABEL: Readonly<Record<RatingField, string>> =
  Object.freeze({
    clarityRating: "Clarity",
    paceRating: "Pace",
    usefulnessRating: "Usefulness",
  });

export const ratingSchema = z.number().int().min(1).max(5);

// The complete learner submission. The browser never supplies a learner,
// instructor, cohort, lesson or programme version: the database derives
// them from the authenticated session and the class session.
export const sessionFeedbackSubmissionSchema = z.strictObject({
  classSessionId: z.uuid(),
  requestId: z.uuid(),
  clarityRating: ratingSchema,
  paceRating: ratingSchema,
  usefulnessRating: ratingSchema,
});
export type SessionFeedbackSubmission = z.infer<
  typeof sessionFeedbackSubmissionSchema
>;

// FormData transport: each rating is exactly one digit 1-5.
const ratingFieldSchema = z
  .string()
  .regex(/^[1-5]$/)
  .transform(Number)
  .pipe(ratingSchema);
export const sessionFeedbackFormSchema = z.strictObject({
  classSessionId: z.uuid(),
  requestId: z.uuid(),
  clarityRating: ratingFieldSchema,
  paceRating: ratingFieldSchema,
  usefulnessRating: ratingFieldSchema,
});

// ---------------------------------------------------------------------------
// Learner opportunities (bounded, learner-owned).
// ---------------------------------------------------------------------------

export const feedbackOpportunitySchema = z.strictObject({
  classSessionId: z.uuid(),
  lessonTitle: z.string().max(200),
  cohortTitle: z.string().max(200),
  programmeTitle: z.string().max(200),
  instructorName: z.string().max(100),
  scheduledStart: academicTimestampSchema,
  scheduledEnd: academicTimestampSchema,
});
export type FeedbackOpportunity = z.infer<typeof feedbackOpportunitySchema>;

export const feedbackOpportunitiesResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    opportunities: z
      .array(feedbackOpportunitySchema)
      .max(SESSION_FEEDBACK_OPPORTUNITY_LIMIT),
  }),
  z.strictObject({ ok: z.literal(false), code: z.literal("FORBIDDEN") }),
]);

// ---------------------------------------------------------------------------
// Submission result and safe learner outcomes.
// ---------------------------------------------------------------------------

export const sessionFeedbackRefusals = [
  "FORBIDDEN",
  "INVALID_INPUT",
  "NOT_ELIGIBLE",
  "SESSION_CANCELLED",
  "SESSION_NOT_ENDED",
  "ATTENDANCE_NOT_PRESENT",
  "ALREADY_SUBMITTED",
  "REQUEST_CONFLICT",
] as const;

export const sessionFeedbackResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    outcome: z.enum(["RECORDED", "REPLAYED"]),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(sessionFeedbackRefusals),
  }),
]);
export type SessionFeedbackResult = z.infer<typeof sessionFeedbackResultSchema>;

export type SessionFeedbackOutcome =
  | "RECORDED"
  | "ALREADY_SUBMITTED"
  | "NOT_ELIGIBLE"
  | "SESSION_NOT_ENDED"
  | "SESSION_CANCELLED"
  | "NOT_PRESENT"
  | "REQUEST_CONFLICT"
  | "INVALID"
  | "UNAVAILABLE";

// A replay of the learner's own recorded submission is, to the learner,
// simply "recorded". Foreign, missing and withdrawn sessions collapse into
// one NOT_ELIGIBLE outcome, so no other session's existence is revealed.
export function sessionFeedbackOutcome(
  result: SessionFeedbackResult,
): SessionFeedbackOutcome {
  if (result.ok) return "RECORDED";
  switch (result.code) {
    case "ALREADY_SUBMITTED":
      return "ALREADY_SUBMITTED";
    case "SESSION_NOT_ENDED":
      return "SESSION_NOT_ENDED";
    case "SESSION_CANCELLED":
      return "SESSION_CANCELLED";
    case "ATTENDANCE_NOT_PRESENT":
      return "NOT_PRESENT";
    case "REQUEST_CONFLICT":
      return "REQUEST_CONFLICT";
    case "INVALID_INPUT":
      return "INVALID";
    case "NOT_ELIGIBLE":
      return "NOT_ELIGIBLE";
    case "FORBIDDEN":
      return "UNAVAILABLE";
  }
}

// Truthful copy only: no claim that Sarah reviewed it, that the instructor
// has seen it, or that anyone will act on it.
export const SESSION_FEEDBACK_MESSAGE: Readonly<
  Record<SessionFeedbackOutcome, string>
> = Object.freeze({
  RECORDED: "Thanks — your feedback has been recorded.",
  ALREADY_SUBMITTED: "You have already shared feedback for this session.",
  NOT_ELIGIBLE: "Feedback is not available for this session.",
  SESSION_NOT_ENDED:
    "This session has not ended yet. You can share feedback after it ends.",
  SESSION_CANCELLED:
    "This session was cancelled, so feedback is not available.",
  NOT_PRESENT:
    "Feedback is available only for sessions where your attendance is recorded as present.",
  REQUEST_CONFLICT:
    "This feedback was already sent with different answers. Please try again.",
  INVALID: "Choose a rating from 1 to 5 for each question.",
  UNAVAILABLE: "Your feedback could not be sent right now. Please try again.",
});

// Outcomes after which this session's prompt is finished.
export function isFinalFeedbackOutcome(outcome: SessionFeedbackOutcome) {
  return !["REQUEST_CONFLICT", "INVALID", "UNAVAILABLE"].includes(outcome);
}

// ---------------------------------------------------------------------------
// Admin teaching quality (aggregate only; never learner-identifying).
// ---------------------------------------------------------------------------

const stamp = z.iso.datetime({ offset: true });
export const teachingQualityInputSchema = z
  .strictObject({
    instructorId: z.uuid().optional(),
    cohortId: z.uuid().optional(),
    from: stamp.optional(),
    until: stamp.optional(),
    offset: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^[0-9]{1,6}$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(0).max(TEACHING_QUALITY_OFFSET_MAX))
      .default(0),
  })
  .refine(
    (x) => !x.from || !x.until || Date.parse(x.until) > Date.parse(x.from),
  );
export type TeachingQualityInput = z.input<typeof teachingQualityInputSchema>;

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const averageSchema = z.number().min(1).max(5);

const averagesShape = {
  clarityAverage: averageSchema.nullable(),
  paceAverage: averageSchema.nullable(),
  usefulnessAverage: averageSchema.nullable(),
};
type Averages = {
  clarityAverage: number | null;
  paceAverage: number | null;
  usefulnessAverage: number | null;
};
const allNull = (x: Averages) =>
  x.clarityAverage === null &&
  x.paceAverage === null &&
  x.usefulnessAverage === null;
const allPresent = (x: Averages) =>
  x.clarityAverage !== null &&
  x.paceAverage !== null &&
  x.usefulnessAverage !== null;

// The privacy threshold is enforced again at this boundary: averages below
// the minimum response count are refused, so the UI can never render them.
export const teachingQualityRowSchema = z
  .strictObject({
    sessionId: z.uuid(),
    lessonTitle: z.string(),
    cohortTitle: z.string(),
    instructorName: z.string(),
    programmeTitle: z.string(),
    versionLabel: z.string(),
    scheduledStart: stamp,
    scheduledEnd: stamp,
    status: z.enum(["SCHEDULED", "COMPLETED"]),
    presentCount: countSchema,
    responseCount: countSchema,
    scoresAvailable: z.boolean(),
    ...averagesShape,
  })
  .refine((x) =>
    x.responseCount >= SESSION_FEEDBACK_MIN_RESPONSES
      ? x.scoresAvailable && allPresent(x)
      : !x.scoresAvailable && allNull(x),
  );
export type TeachingQualityRow = z.infer<typeof teachingQualityRowSchema>;

export const teachingQualitySummarySchema = z
  .strictObject({
    sessionCount: countSchema,
    responseCount: countSchema,
    scoredSessionCount: countSchema,
    scoredResponseCount: countSchema,
    ...averagesShape,
  })
  .refine(
    (x) =>
      x.scoredResponseCount <= x.responseCount &&
      x.scoredSessionCount <= x.sessionCount &&
      (x.scoredSessionCount === 0
        ? x.scoredResponseCount === 0 && allNull(x)
        : x.scoredResponseCount >=
            x.scoredSessionCount * SESSION_FEEDBACK_MIN_RESPONSES &&
          allPresent(x)),
  );
export type TeachingQualitySummary = z.infer<
  typeof teachingQualitySummarySchema
>;

export const teachingQualitySchema = z.strictObject({
  minimumResponses: z.literal(SESSION_FEEDBACK_MIN_RESPONSES),
  offset: z.number().int().min(0).max(TEACHING_QUALITY_OFFSET_MAX),
  hasMore: z.boolean(),
  summary: teachingQualitySummarySchema,
  rows: z.array(teachingQualityRowSchema).max(TEACHING_QUALITY_PAGE_SIZE),
});
export type TeachingQuality = z.infer<typeof teachingQualitySchema>;

export function formatAverage(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}
