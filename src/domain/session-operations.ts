import { z } from "zod";
export const SESSION_BATCH_REQUEST_LIMIT = 100;
const stamp = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(5).max(300);
export const sessionItemSchema = z
  .strictObject({
    lessonId: z.uuid(),
    scheduledStart: stamp,
    scheduledEnd: stamp,
  })
  .refine((x) => Date.parse(x.scheduledEnd) > Date.parse(x.scheduledStart));
export const rescheduleInputSchema = z.strictObject({
  sessionId: z.uuid(),
  scheduledStart: stamp,
  requestId: z.uuid(),
  reason,
});
export const batchInputSchema = z.strictObject({
  requestId: z.uuid(),
  activationId: z.uuid(),
  instructorId: z.uuid(),
  items: z.array(sessionItemSchema).min(1).max(SESSION_BATCH_REQUEST_LIMIT),
  reason,
});
export const discoveryInputSchema = z
  .strictObject({
    sessionId: z.uuid().optional(),
    cohortId: z.uuid().optional(),
    status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]).optional(),
    from: stamp.optional(),
    until: stamp.optional(),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .refine(
    (x) => !x.from || !x.until || Date.parse(x.until) > Date.parse(x.from),
  );
export const operationOutcomeSchema = z.strictObject({
  requestId: z.uuid(),
  originalId: z.uuid().nullable(),
  replay: z.boolean(),
  sessionIds: z.array(z.uuid()).min(1).max(100),
});
export const discoverySchema = z.strictObject({
  hasMore: z.boolean(),
  rows: z
    .array(
      z.strictObject({
        id: z.uuid(),
        cohortTitle: z.string(),
        cohortStatus: z.enum(["OPEN", "CLOSED", "COMPLETED"]),
        lessonTitle: z.string(),
        instructorName: z.string(),
        programmeTitle: z.string(),
        versionLabel: z.string(),
        scheduledStart: stamp,
        scheduledEnd: stamp,
        status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
        canReschedule: z.boolean(),
        originalId: z.uuid().nullable(),
        replacementId: z.uuid().nullable(),
      }),
    )
    .max(50),
});
export const SESSION_ACTIVATION_PAGE_SIZE = 200;
export const SESSION_LESSON_PAGE_SIZE = 250;
// PostgreSQL integer transport bound; never a count limit on stored schedules.
export const SESSION_OPTIONS_OFFSET_MAX = 2_147_483_647;
const optionOffset = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[0-9]{1,10}$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(0).max(SESSION_OPTIONS_OFFSET_MAX));
export const batchOptionsInputSchema = z.strictObject({
  activationId: z.uuid().optional(),
  activationOffset: optionOffset.default(0),
  lessonOffset: optionOffset.default(0),
});
const activationOptionSchema = z.strictObject({
  id: z.uuid(),
  instructorId: z.uuid(),
  title: z.string(),
  status: z.enum(["OPEN", "CLOSED", "COMPLETED"]),
});
export const batchOptionsSchema = z.strictObject({
  hasMore: z.boolean(),
  lessonsHasMore: z.boolean(),
  activationOffset: z.number().int().min(0).max(SESSION_OPTIONS_OFFSET_MAX),
  lessonOffset: z.number().int().min(0).max(SESSION_OPTIONS_OFFSET_MAX),
  selectedActivation: activationOptionSchema.nullable(),
  activations: z
    .array(activationOptionSchema)
    .max(SESSION_ACTIVATION_PAGE_SIZE),
  lessons: z
    .array(z.strictObject({ id: z.uuid(), title: z.string() }))
    .max(SESSION_LESSON_PAGE_SIZE),
});
export type SessionDiscovery = z.infer<typeof discoverySchema>;
export type BatchOptions = z.infer<typeof batchOptionsSchema>;
export const sessionRefusalMessages = {
  FORBIDDEN: "Academic or Platform Admin authority is required.",
  INVALID_INPUT: "Check the explicit session values and request identifier.",
  INVALID_INTERVAL: "The end instant must be after the start instant.",
  BOUNDED_REASON_REQUIRED: "Provide a reason between 5 and 300 characters.",
  COHORT_COMPLETED:
    "Delivery is finished for this cohort. No new session can be scheduled.",
  COHORT_NOT_FOUND: "The cohort no longer exists.",
  VERSION_NOT_PUBLISHED: "Scheduling requires a published programme version.",
  LESSON_MISMATCH: "The lesson must belong to the cohort programme version.",
  INSTRUCTOR_UNAVAILABLE: "The instructor is unavailable or deactivated.",
  INVALID_INSTRUCTOR: "Choose an active staff member with the INSTRUCTOR role.",
  COHORT_OVERLAP:
    "This interval overlaps another non-cancelled session for the cohort.",
  INSTRUCTOR_OVERLAP:
    "This interval overlaps another non-cancelled session for the instructor.",
  SESSION_NOT_FOUND: "The original session could not be found.",
  SESSION_CLOSED: "Only a scheduled session can be rescheduled.",
  SESSION_STARTED:
    "The original session has already started. Its history cannot be rescheduled.",
  REPLACEMENT_NOT_FUTURE: "The replacement start must be in the future.",
  SESSION_HAS_HISTORY:
    "This session already has institutional history and cannot be replaced.",
  ALREADY_RESCHEDULED:
    "This original already has a replacement. Refresh the register.",
  REQUEST_CONFLICT:
    "This request was previously used with different values. Start a new request.",
  ACTIVATION_NOT_FOUND: "Choose an existing activated course.",
  ACTIVATION_LESSON_MISMATCH:
    "Every lesson must belong to the selected activation.",
  BATCH_INTERNAL_OVERLAP:
    "The batch contains duplicate or overlapping intervals.",
  BATCH_REQUEST_LIMIT:
    "Submit between 1 and 100 sessions per request. Additional batches are permitted.",
  CANCELLED_HISTORY_MATCH:
    "The batch matches cancelled history. It cannot regenerate those sessions.",
  SERVICE_UNAVAILABLE:
    "Session operations are unavailable. No successful operation is claimed. Retry the same request to confirm its outcome.",
} as const;
export type SessionRefusalCode = keyof typeof sessionRefusalMessages;
export class SessionOperationError extends Error {
  constructor(readonly code: SessionRefusalCode) {
    super(code);
  }
}
export function sessionErrorCode(error: {
  message?: string;
  code?: string;
}): SessionRefusalCode {
  const message = error.message ?? "";
  if (Object.hasOwn(sessionRefusalMessages, message))
    return message as SessionRefusalCode;
  const aliases: Record<string, SessionRefusalCode> = {
    "Access denied": "FORBIDDEN",
    STAFF_DEACTIVATED: "INSTRUCTOR_UNAVAILABLE",
    "Cohort not found": "COHORT_NOT_FOUND",
    "Class sessions require a published programme version":
      "VERSION_NOT_PUBLISHED",
    "Lesson must belong to the cohort programme version": "LESSON_MISMATCH",
    "Cohort already has an overlapping class session": "COHORT_OVERLAP",
    "Instructor already has an overlapping class session": "INSTRUCTOR_OVERLAP",
  };
  return (
    (Object.hasOwn(aliases, message) ? aliases[message] : undefined) ??
    (error.code?.startsWith("22") ? "INVALID_INPUT" : "SERVICE_UNAVAILABLE")
  );
}
