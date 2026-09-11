import { z } from "zod";
import {
  enrolmentContextInputSchema,
  lessonContextInputSchema,
} from "./learning-context";

export const academicTimestampSchema = z.iso.datetime({ offset: true });
const positionSchema = z.number().int().positive().max(2147483647);
export const RESOURCE_PAGE_SIZE = 5;
export const HISTORY_PAGE_SIZE = 25;
export const MASTERY_ROW_LIMIT = 200;

const sessionSchema = z
  .strictObject({
    sessionId: z.uuid(),
    lessonId: z.uuid(),
    scheduledStart: academicTimestampSchema,
    scheduledEnd: academicTimestampSchema,
  })
  .refine(
    (value) =>
      Date.parse(value.scheduledEnd) > Date.parse(value.scheduledStart),
  );
const sessionContext = {
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  cohortId: z.uuid(),
  selectedAt: academicTimestampSchema,
};
export const currentClassSessionSchema = z.discriminatedUnion("selection", [
  z.strictObject({
    ...sessionContext,
    selection: z.literal("NONE"),
    session: z.null(),
  }),
  z.strictObject({
    ...sessionContext,
    selection: z.literal("CURRENT"),
    session: sessionSchema,
  }),
  z.strictObject({
    ...sessionContext,
    selection: z.literal("UPCOMING"),
    session: sessionSchema,
  }),
]);

export const resourceCursorSchema = z.strictObject({
  afterPosition: positionSchema,
});
export const learningResourcesInputSchema = lessonContextInputSchema.extend({
  cursor: resourceCursorSchema.optional(),
});
const resourceIdentity = {
  resourceId: z.uuid(),
  title: z.string().min(1).max(200),
  position: positionSchema,
};
export const permittedResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...resourceIdentity,
    kind: z.literal("LECTURE_NOTE"),
    body: z.string().min(1).max(12000),
    url: z.null(),
  }),
  z.strictObject({
    ...resourceIdentity,
    kind: z.literal("REFERENCE_LINK"),
    body: z.null(),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
  }),
]);
export const learningResourcesPageSchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  resources: z.array(permittedResourceSchema).max(RESOURCE_PAGE_SIZE),
  nextCursor: resourceCursorSchema.nullable(),
});

export const historyCursorSchema = z.strictObject({
  beforeRecordedAt: academicTimestampSchema,
  beforeId: z.uuid(),
});
export const learningHistoryInputSchema = enrolmentContextInputSchema.extend({
  objectiveId: z.uuid().optional(),
  cursor: historyCursorSchema.optional(),
});
export const learningHistoryItemSchema = z.strictObject({
  evidenceId: z.uuid(),
  objectiveId: z.uuid(),
  sessionId: z.uuid(),
  evidenceKind: z.enum([
    "CLASS_RESPONSE",
    "RETRIEVAL_CHECK",
    "PRACTICAL_TASK",
    "DEBUGGING_TASK",
  ]),
  result: z.enum(["CORRECT", "PARTIAL", "INCORRECT"]),
  recordedAt: academicTimestampSchema,
});
export const learningHistoryPageSchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  objectiveId: z.uuid().nullable(),
  events: z.array(learningHistoryItemSchema).max(HISTORY_PAGE_SIZE),
  nextCursor: historyCursorSchema.nullable(),
});

export const persistedMasteryItemSchema = z
  .strictObject({
    objectiveId: z.uuid(),
    state: z.enum([
      "NOT_STARTED",
      "DEVELOPING",
      "DEMONSTRATED",
      "NEEDS_REINFORCEMENT",
    ]),
    policyVersion: z.string().min(1).max(80),
    evaluatedAt: academicTimestampSchema,
    evidenceCount: z.number().int().nonnegative().max(2147483647),
    correctEvidenceCount: z.number().int().nonnegative().max(2147483647),
    correctSessionCount: z.number().int().nonnegative().max(2147483647),
    correctKindCount: z.number().int().min(0).max(4),
  })
  .refine(
    (value) =>
      value.correctEvidenceCount <= value.evidenceCount &&
      value.correctSessionCount <= value.correctEvidenceCount &&
      value.correctKindCount <= value.correctEvidenceCount,
  );
export const currentMasterySchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  persistedOnly: z.literal(true),
  records: z.array(persistedMasteryItemSchema).max(MASTERY_ROW_LIMIT),
});
