import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";

// AC-4: supplementary, versioned Tutor class notes (migration 053). Pure.
//
// A Tutor class note is a Tutor support answer the learner chose, before
// sending the request, to keep. Its body is only ever the trusted server's
// copy of a governed, SUCCEEDED Tutor execution's learner-visible output,
// recorded through an attested controller write; the browser never supplies
// note text, a source execution, provenance, role or learner. A note is
// supplementary learner support: it is not published course material, never
// changes curriculum, and is never LearningEvidence, mastery, attendance,
// lesson progress, a grade, an assessment result or completion.

export const TUTOR_CLASS_NOTE_POLICY = "TUTOR_CLASS_NOTE_V1" as const;

// Reviewed bounds (mirror of migration 053's tutor_class_note_private).
export const TUTOR_CLASS_NOTE_BODY_MAX = 8000;
export const TUTOR_CLASS_NOTE_REVISIONS_MAX = 10;
export const TUTOR_CLASS_NOTE_PAGE_SIZE = 5;
export const TUTOR_CLASS_NOTE_PAGE_MAX = 49;

// Length as PostgreSQL counts it (code points), so an over-long body is
// refused here exactly when the database would refuse it.
export function tutorClassNoteBodyLength(body: string): number {
  return Array.from(body).length;
}
export function isStorableTutorClassNoteBody(body: string): boolean {
  const length = tutorClassNoteBodyLength(body);
  return (
    length >= 1 &&
    length <= TUTOR_CLASS_NOTE_BODY_MAX &&
    /\S/.test(body) &&
    !body.includes("\u0000")
  );
}

export const tutorClassNoteRefusalCodes = [
  "FORBIDDEN",
  "INVALID_INPUT",
  "ATTESTATION_INVALID",
  "NOT_FOUND_OR_FORBIDDEN",
  "SOURCE_NOT_ELIGIBLE",
  "CONTEXT_CONFLICT",
  "ENROLMENT_NOT_ACTIVE",
  "PROVENANCE_INVALID",
  "PROVENANCE_MISMATCH",
  "ACTIVITY_BLOCKED",
  "SOURCE_CONFLICT",
  "REVISION_LIMIT_REACHED",
] as const;
export type TutorClassNoteRefusal = (typeof tutorClassNoteRefusalCodes)[number];

export const tutorClassNoteRecordResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    duplicate: z.boolean(),
    revisionNumber: z.number().int().min(1).max(TUTOR_CLASS_NOTE_REVISIONS_MAX),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(tutorClassNoteRefusalCodes),
  }),
]);

// What the learner is told about the note they asked for. Only present on a
// SUCCEEDED Tutor answer the learner asked to keep.
export type TutorClassNoteOutcome =
  | { state: "SAVED"; revisionNumber: number }
  | {
      state: "NOT_SAVED";
      reason: "LIMIT_REACHED" | "TOO_LONG" | "ACTIVITY_BLOCKED" | "UNAVAILABLE";
    };

export function tutorClassNoteOutcomeForRefusal(
  code: TutorClassNoteRefusal | "SERVICE_UNAVAILABLE",
): TutorClassNoteOutcome {
  if (code === "REVISION_LIMIT_REACHED")
    return { state: "NOT_SAVED", reason: "LIMIT_REACHED" };
  if (code === "ACTIVITY_BLOCKED")
    return { state: "NOT_SAVED", reason: "ACTIVITY_BLOCKED" };
  return { state: "NOT_SAVED", reason: "UNAVAILABLE" };
}

export const tutorClassNoteReasonSchema = z.enum([
  "MISSED_LESSON_PRACTICE",
  "OBJECTIVE_REINFORCEMENT",
  "PRACTICAL_PREREQUISITE",
]);

// The learner-safe projection, by name. No execution, provenance, handoff,
// series, runtime-profile, behaviour or audit field exists here, and a
// response carrying one is refused (strict objects).
export const learnerTutorClassNoteRevisionSchema = z.strictObject({
  revisionNumber: z.number().int().min(1).max(TUTOR_CLASS_NOTE_REVISIONS_MAX),
  current: z.boolean(),
  body: z
    .string()
    .min(1)
    .max(TUTOR_CLASS_NOTE_BODY_MAX * 2),
  createdAt: academicTimestampSchema,
});
export const learnerTutorClassNoteSchema = z
  .strictObject({
    lessonTitle: z.string().min(1).max(2000),
    objectiveDescription: z.string().min(1).max(4000).nullable(),
    reasonCode: tutorClassNoteReasonSchema,
    createdAt: academicTimestampSchema,
    revisionCount: z.number().int().min(1).max(TUTOR_CLASS_NOTE_REVISIONS_MAX),
    revisions: z
      .array(learnerTutorClassNoteRevisionSchema)
      .min(1)
      .max(TUTOR_CLASS_NOTE_REVISIONS_MAX),
  })
  .refine(
    (note) =>
      note.revisions.length === note.revisionCount &&
      note.revisions.every(
        (revision, index) =>
          revision.revisionNumber === note.revisionCount - index &&
          revision.current === (index === 0) &&
          tutorClassNoteBodyLength(revision.body) <= TUTOR_CLASS_NOTE_BODY_MAX,
      ) &&
      (note.reasonCode !== "OBJECTIVE_REINFORCEMENT" ||
        note.objectiveDescription !== null),
  );
export type LearnerTutorClassNote = z.infer<typeof learnerTutorClassNoteSchema>;

export const learnerTutorClassNoteListSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    page: z.number().int().min(0).max(TUTOR_CLASS_NOTE_PAGE_MAX),
    pageSize: z.literal(TUTOR_CLASS_NOTE_PAGE_SIZE),
    hasMore: z.boolean(),
    notes: z.array(learnerTutorClassNoteSchema).max(TUTOR_CLASS_NOTE_PAGE_SIZE),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

export const tutorClassNoteListRequestSchema = z.strictObject({
  enrolmentId: z.uuid(),
  page: z.number().int().min(0).max(TUTOR_CLASS_NOTE_PAGE_MAX),
});

// ---------------------------------------------------------------------------
// Learner copy. Notes are always labelled as supplementary Tutor support,
// distinct from published course material, and never as a record.
// ---------------------------------------------------------------------------
export const TUTOR_CLASS_NOTE_LABEL = "Supplementary Tutor note";
export const TUTOR_CLASS_NOTE_DISCLOSURE =
  "These are Tutor answers you chose to keep. They are supplementary support, not published course material, and they never change your curriculum. A Tutor note is not a mark, attendance, progress, completion or mastery record.";
export const TUTOR_CLASS_NOTE_OPT_IN_LABEL =
  "Keep this Tutor answer as a supplementary Tutor note (not course material)";
export const TUTOR_CLASS_NOTE_ACTIVITY_BLOCKED =
  "Tutor notes are not available while a controlled assessment is active.";
export const TUTOR_CLASS_NOTE_UNAVAILABLE =
  "Your Tutor notes are not available right now.";

export const TUTOR_CLASS_NOTE_REASON_LABEL: Readonly<
  Record<z.infer<typeof tutorClassNoteReasonSchema>, string>
> = Object.freeze({
  MISSED_LESSON_PRACTICE: "Practice for missed material",
  OBJECTIVE_REINFORCEMENT: "Objective reinforcement",
  PRACTICAL_PREREQUISITE: "Preparation for a practical",
});

export function tutorClassNoteOutcomeMessage(
  outcome: TutorClassNoteOutcome,
): string {
  if (outcome.state === "SAVED")
    return `Kept as a supplementary Tutor note (revision ${outcome.revisionNumber}). It is not published course material.`;
  switch (outcome.reason) {
    case "LIMIT_REACHED":
      return `This answer was not kept as a Tutor note: this support topic already has the maximum of ${TUTOR_CLASS_NOTE_REVISIONS_MAX} note revisions.`;
    case "TOO_LONG":
      return `This answer was not kept as a Tutor note because it is longer than the ${TUTOR_CLASS_NOTE_BODY_MAX.toLocaleString("en-GB")}-character note limit.`;
    case "ACTIVITY_BLOCKED":
      return "This answer was not kept as a Tutor note because a controlled assessment is active.";
    case "UNAVAILABLE":
      return "This answer could not be kept as a Tutor note right now.";
  }
}
