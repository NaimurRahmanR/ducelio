import { z } from "zod";

export const DELIVERY_POLICY = "DELIVERY_V1" as const;
export const enrolmentInput = z.strictObject({ enrolmentId: z.uuid() });
export const deliveryPageInput = enrolmentInput.extend({
  cursor: z.number().int().min(0).max(250).optional(),
});
const studyDays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((v) => new Set(v).size === v.length);
const localStartTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(100);
export const studyPlanInput = enrolmentInput.extend({
  studyDays: studyDays.optional(),
  localStartTime: localStartTime.optional(),
  timezone: timezone.optional(),
});
export const futureScheduleInput = enrolmentInput.extend({
  studyDays,
  localStartTime,
  timezone,
  effectiveOn: z.iso.date(),
});
const timestamp = z.iso.datetime({ offset: true });
export const occurrenceSchema = z
  .strictObject({
    id: z.uuid(),
    lessonId: z.uuid(),
    ordinal: z.number().int().min(1).max(250),
    scheduledAt: timestamp,
    nextScheduledAt: timestamp,
    latestStartAt: timestamp,
    expectedDurationMinutes: z.literal(60),
    transitionAnchor: z.boolean(),
    startedAt: timestamp.nullable(),
    state: z.enum(["UPCOMING", "DUE", "STARTED", "COMPLETED", "MISSED"]),
    completedAt: timestamp.nullable(),
    catchUp: z.enum(["NONE", "REQUIRED", "RESOLVED"]),
  })
  .refine(
    (v) =>
      Date.parse(v.nextScheduledAt) - Date.parse(v.latestStartAt) === 3600000 &&
      Date.parse(v.latestStartAt) >= Date.parse(v.scheduledAt) &&
      (v.startedAt === null ||
        (Date.parse(v.startedAt) >= Date.parse(v.scheduledAt) &&
          Date.parse(v.startedAt) <= Date.parse(v.latestStartAt))) &&
      (v.state !== "STARTED" || v.startedAt !== null) &&
      (v.state === "COMPLETED") === (v.completedAt !== null) &&
      (v.catchUp !== "RESOLVED" || v.completedAt !== null) &&
      (v.catchUp !== "REQUIRED" || v.completedAt === null),
  );
export const deliveryContextSchema = z.strictObject({
  enrolmentId: z.uuid(),
  policyVersion: z.literal(DELIVERY_POLICY),
  serverTime: timestamp,
  enrolmentStatus: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  counsellorMode: z.enum(["PROSPECT", "ACTIVE_COURSE", "POST_COURSE"]),
  academicEligibility: z.enum(["SUBJECT_TO_ACTIVITY", "CLOSED"]),
  effectiveCadence: z.number().int().min(1).max(7).nullable(),
  plan: z
    .strictObject({
      id: z.uuid(),
      state: z.enum(["DRAFT", "CONFIRMED"]),
      cadence: z.number().int().min(1).max(7),
      timezone,
      studyDays,
      localStartTime,
      programmeVersionId: z.uuid(),
      confirmedAt: timestamp.nullable(),
    })
    .nullable(),
  occurrences: z.array(occurrenceSchema).max(25),
  nextCursor: z.number().int().min(1).max(250).nullable(),
  backlogCount: z.number().int().min(0).max(250),
  currentLessonId: z.uuid().nullable(),
  recoveryLessonIds: z.array(z.uuid()).max(250),
  revisions: z
    .array(
      z.strictObject({
        id: z.uuid(),
        revision: z.number().int().min(1).max(50),
        cadence: z.number().int().min(1).max(7),
        studyDays,
        localStartTime,
        timezone,
        effectiveOn: z.iso.date(),
      }),
    )
    .max(50),
});
export type DeliveryContext = z.infer<typeof deliveryContextSchema>;
export const scheduleHistoryInput = enrolmentInput.extend({
  revision: z.number().int().min(1).max(50),
});
export const scheduleHistorySchema = z.strictObject({
  enrolmentId: z.uuid(),
  revision: z.number().int().min(1).max(50),
  occurrences: z
    .array(
      z.strictObject({
        id: z.uuid(),
        lessonId: z.uuid(),
        ordinal: z.number().int().min(1).max(250),
        scheduledAt: timestamp,
        nextScheduledAt: timestamp,
        latestStartAt: timestamp,
        expectedDurationMinutes: z.literal(60),
        transitionAnchor: z.boolean(),
        replacesId: z.uuid().nullable(),
      }),
    )
    .max(250),
});
const availability = z.enum(["AVAILABLE", "CLOSED", "ACTIVITY_BLOCKED"]);
export const agentAccessSchema = z.strictObject({
  enrolmentId: z.uuid(),
  PROFESSOR: availability,
  TUTOR: availability,
  LAB_INSTRUCTOR: availability,
  EXAMINER: z.enum(["ASSESSMENT_CONTROLLED", "CLOSED"]),
  COUNSELLOR: z.literal("AVAILABLE"),
});
export const counsellorLifecycleSchema = z.strictObject({
  mode: z.enum(["PROSPECT", "ACTIVE_COURSE", "POST_COURSE"]),
  available: z.literal(true),
  policyVersion: z.literal("COUNSELLOR_SCOPE_V1"),
});

// Fixed categories are future authorization vocabulary, not inferred intent.
export const counsellorScopes = {
  PROSPECT: [
    "ADMISSIONS",
    "PROFILE_ONBOARDING",
    "COURSE_DISCOVERY",
    "COURSE_RECOMMENDATION",
    "PURCHASE_SUPPORT",
  ],
  ACTIVE_COURSE: [
    "PROFILE_ONBOARDING",
    "STUDY_PLANNING",
    "ACADEMIC_LOGISTICS",
    "MISSED_CLASS_SUPPORT",
    "ROLE_ROUTING",
  ],
  POST_COURSE: [
    "COURSE_COMPLETION_SUPPORT",
    "NEXT_COURSE_GUIDANCE",
    "COURSE_DISCOVERY",
    "COURSE_RECOMMENDATION",
    "PURCHASE_SUPPORT",
  ],
} as const;
export type CounsellorMode = keyof typeof counsellorScopes;
export function counsellorRequestAllowed(
  mode: CounsellorMode,
  category: string,
  conversationState: "ACTIVE" | "COOLDOWN" | "HIBERNATED",
) {
  return (
    conversationState === "ACTIVE" &&
    (counsellorScopes[mode] as readonly string[]).includes(category)
  );
}
// This policy affects only the future Counsellor conversation. No account/access
// mutation and no behavioural inference or persistence exists in checkpoint 2A.
export const optionalProspectProfileSchema = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("SKIP") }),
  z.strictObject({
    choice: z.literal("SHARE"),
    learningGoal: z.string().trim().max(300).optional(),
    experience: z.enum(["NEW", "SOME", "EXPERIENCED"]).optional(),
    courseInterest: z.string().trim().max(100).optional(),
    studyDays: z.number().int().min(1).max(7).optional(),
  }),
]);
export const handoffReason = z.enum([
  "MISSED_LESSON_PRACTICE",
  "OBJECTIVE_REINFORCEMENT",
  "PRACTICAL_PREREQUISITE",
  "PRACTICAL_HELP",
]);
export const handoffInput = enrolmentInput.extend({
  lessonId: z.uuid(),
  objectiveId: z.uuid().nullable().optional(),
  reasonCode: handoffReason,
});
const handoffRoutes = {
  MISSED_LESSON_PRACTICE: [
    "TUTOR",
    "Learner requests practice for missed material.",
  ],
  OBJECTIVE_REINFORCEMENT: [
    "TUTOR",
    "Learner requests objective reinforcement.",
  ],
  PRACTICAL_PREREQUISITE: [
    "TUTOR",
    "Learner requests conceptual preparation for a practical.",
  ],
  PRACTICAL_HELP: ["LAB_INSTRUCTOR", "Learner requests practical support."],
} as const;
export const handoffSchema = z
  .strictObject({
    id: z.uuid(),
    enrolment_id: z.uuid(),
    initiator_kind: z.literal("LEARNER"),
    destination_profile: z.enum(["TUTOR", "LAB_INSTRUCTOR"]),
    reason_code: handoffReason,
    lesson_id: z.uuid(),
    objective_id: z.uuid().nullable(),
    summary: z.string().min(1).max(120),
    priority: z.literal("NORMAL"),
    provenance: z.literal("LEARNER_REQUEST"),
    status: z.literal("OPEN"),
    created_at: timestamp,
  })
  .refine((h) => {
    const route = handoffRoutes[h.reason_code];
    return h.destination_profile === route[0] && h.summary === route[1];
  });

export const deliveryErrorCode = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_LOCAL_TIME",
  "NOT_FOUND_OR_FORBIDDEN",
  "POLICY_BLOCKED",
  "ACTIVITY_BLOCKED",
  "PLAN_FROZEN",
  "PLAN_REQUIRED",
  "NO_ELIGIBLE_LESSONS",
  "LIMIT_EXCEEDED",
  "CONTEXT_CONFLICT",
  "SERVICE_UNAVAILABLE",
]);
export const startLearningInput = z.strictObject({ occurrenceId: z.uuid() });
export const startLearningSchema = z
  .strictObject({
    occurrenceId: z.uuid(),
    decision: z.enum(["STARTED", "ALREADY_STARTED", "NOT_OPEN", "MISSED"]),
    startedAt: timestamp.nullable(),
  })
  .refine(
    (v) =>
      (v.decision === "STARTED" || v.decision === "ALREADY_STARTED") ===
      (v.startedAt !== null),
  );
export class DeliveryDenied extends Error {
  constructor(readonly code: z.infer<typeof deliveryErrorCode>) {
    super(code);
    this.name = "DeliveryDenied";
  }
}
