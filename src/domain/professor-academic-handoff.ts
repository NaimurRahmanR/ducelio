import { z } from "zod";

// AC-3: the minimum-data governed academic handoff from a learner's own
// Professor classroom to the Tutor or Lab Instructor (migration 052). Pure.
//
// The handoff carries NO transcript, learner question, Professor answer,
// provider output, prompt, reasoning or free text. Its only prose is one of
// the fixed, code-owned summaries below (mirrored by the database CHECK). It
// is non-authoritative teaching continuity: never mastery, evidence, a
// grade, progress or completion.

export const PROFESSOR_ACADEMIC_HANDOFF_POLICY =
  "PROFESSOR_ACADEMIC_HANDOFF_V1" as const;

// The smallest reviewed vocabulary the existing Tutor/Lab authority can
// consume (migration 028): objective reinforcement goes to the Tutor,
// practical help to the Lab Instructor.
export const professorHandoffReasonSchema = z.enum([
  "OBJECTIVE_REINFORCEMENT",
  "PRACTICAL_HELP",
]);
export type ProfessorHandoffReason = z.infer<
  typeof professorHandoffReasonSchema
>;

export const PROFESSOR_HANDOFF_DESTINATION: Readonly<
  Record<ProfessorHandoffReason, "TUTOR" | "LAB_INSTRUCTOR">
> = Object.freeze({
  OBJECTIVE_REINFORCEMENT: "TUTOR",
  PRACTICAL_HELP: "LAB_INSTRUCTOR",
});

// Mirror of migration 052's professor_handoff_private.summary.
export const PROFESSOR_HANDOFF_SUMMARY: Readonly<
  Record<ProfessorHandoffReason, string>
> = Object.freeze({
  OBJECTIVE_REINFORCEMENT:
    "After a Professor lesson, the learner asked the Tutor to reinforce this objective.",
  PRACTICAL_HELP:
    "After a Professor lesson, the learner asked the Lab Instructor for help with this practical.",
});

// Learner input: the class session plus exactly one scope. No summary,
// destination, execution, lesson, enrolment or version is accepted.
export const professorHandoffRequestSchema = z.discriminatedUnion(
  "reasonCode",
  [
    z.strictObject({
      classSessionId: z.uuid(),
      reasonCode: z.literal("OBJECTIVE_REINFORCEMENT"),
      objectiveId: z.uuid(),
    }),
    z.strictObject({
      classSessionId: z.uuid(),
      reasonCode: z.literal("PRACTICAL_HELP"),
      practicalId: z.uuid(),
    }),
  ],
);
export type ProfessorHandoffRequest = z.infer<
  typeof professorHandoffRequestSchema
>;

export const professorHandoffRefusalCodes = [
  "FORBIDDEN",
  "INVALID_INPUT",
  "NOT_FOUND_OR_FORBIDDEN",
  "ACTIVITY_BLOCKED",
  "NO_SOURCE_EXECUTION",
  "OBJECTIVE_SCOPE_UNPROVEN",
  // The destination role's frozen behaviour binding is not the AC-3-aware
  // version (for example a programme version published before AC-3).
  "DESTINATION_BEHAVIOUR_UNSUPPORTED",
  "LIMIT_EXCEEDED",
  "CONTEXT_CONFLICT",
  "POLICY_BLOCKED",
] as const;
export type ProfessorHandoffRefusal =
  (typeof professorHandoffRefusalCodes)[number];

export const professorHandoffCreateResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    duplicate: z.boolean(),
    handoffId: z.uuid(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(professorHandoffRefusalCodes),
  }),
]);

// What the learner sees: exactly the minimum projection, by name.
export const learnerProfessorHandoffSchema = z
  .strictObject({
    handoffId: z.uuid(),
    destinationRole: z.enum(["TUTOR", "LAB_INSTRUCTOR"]),
    reasonCode: professorHandoffReasonSchema,
    lessonTitle: z.string().min(1).max(2000),
    objectiveDescription: z.string().min(1).max(4000).nullable(),
    practicalTitle: z.string().min(1).max(200).nullable(),
    summary: z.string(),
    createdAt: z.string(),
  })
  .refine(
    (h) =>
      h.destinationRole === PROFESSOR_HANDOFF_DESTINATION[h.reasonCode] &&
      h.summary === PROFESSOR_HANDOFF_SUMMARY[h.reasonCode] &&
      (h.reasonCode === "OBJECTIVE_REINFORCEMENT"
        ? h.objectiveDescription !== null && h.practicalTitle === null
        : h.practicalTitle !== null && h.objectiveDescription === null),
  );
export type LearnerProfessorHandoff = z.infer<
  typeof learnerProfessorHandoffSchema
>;
export const learnerProfessorHandoffListSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    handoffs: z.array(learnerProfessorHandoffSchema).max(20),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

// The projection the Tutor/Lab runtime receives for its own ACTIVE release.
export const professorTeachingRecordSchema = z
  .strictObject({
    policy: z.literal(PROFESSOR_ACADEMIC_HANDOFF_POLICY),
    sourceRole: z.literal("PROFESSOR"),
    destinationRole: z.enum(["TUTOR", "LAB_INSTRUCTOR"]),
    reasonCode: professorHandoffReasonSchema,
    scope: z.enum(["OBJECTIVE", "PRACTICAL"]),
    summary: z.string(),
    recordedAt: z.string(),
  })
  .refine(
    (r) =>
      r.destinationRole === PROFESSOR_HANDOFF_DESTINATION[r.reasonCode] &&
      r.summary === PROFESSOR_HANDOFF_SUMMARY[r.reasonCode] &&
      r.scope ===
        (r.reasonCode === "OBJECTIVE_REINFORCEMENT"
          ? "OBJECTIVE"
          : "PRACTICAL"),
  );
export type ProfessorTeachingRecord = z.infer<
  typeof professorTeachingRecordSchema
>;
export const professorTeachingRecordReadSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    available: z.literal(true),
    record: professorTeachingRecordSchema,
  }),
  z.strictObject({ ok: z.literal(true), available: z.literal(false) }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

// Provider-facing form (LEVEL 4 data). Identifiers are deliberately omitted:
// the Tutor/Lab context already names the lesson/objective/practical from
// the same governed release.
export const PROFESSOR_TEACHING_RECORD_UNAVAILABLE = Object.freeze({
  available: false as const,
  reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD" as const,
  note: "No governed record of what the Professor taught is available. Support the learner from the published curriculum only.",
});
export function professorTeachingRecordForProvider(
  record: ProfessorTeachingRecord,
) {
  return {
    available: true as const,
    authority: "NON_AUTHORITATIVE_TEACHING_CONTINUITY" as const,
    policy: record.policy,
    sourceRole: record.sourceRole,
    reasonCode: record.reasonCode,
    scope: record.scope,
    summary: record.summary,
    recordedAt: record.recordedAt,
    note: "This only records that the learner asked for this follow-up after a Professor lesson. It is not a transcript, mastery, evidence, a grade, completion or proof of understanding.",
  };
}

// Learner-safe wording when Professor follow-up is not offered for this
// course version. Never names behaviour versions.
export const PROFESSOR_FOLLOW_UP_UNSUPPORTED =
  "Professor follow-up is not available for this course version.";
