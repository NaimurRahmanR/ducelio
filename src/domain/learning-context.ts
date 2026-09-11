import { z } from "zod";

export const enrolmentContextInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
});
export const lessonContextInputSchema = enrolmentContextInputSchema.extend({
  lessonId: z.uuid(),
});
export const lessonObjectivesInputSchema = lessonContextInputSchema.extend({
  afterPosition: z.number().int().min(0).max(2147483647).optional(),
});

export const learnerContextSchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  cohortId: z.uuid(),
  enrolmentStatus: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
  programmeTitle: z.string().max(500),
  programmeVersionLabel: z.string().max(200),
  cohortTitle: z.string().max(500),
  cohortStartsOn: z.iso.date(),
});

export const lessonContextSchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  moduleId: z.uuid(),
  title: z.string().max(500),
  position: z.number().int().positive(),
});

export const lessonObjectiveSchema = z.strictObject({
  objectiveId: z.uuid(),
  description: z.string().max(4000),
  position: z.number().int().positive(),
});
export const OBJECTIVE_PAGE_SIZE = 50;
export const lessonObjectivesSchema = z.strictObject({
  enrolmentId: z.uuid(),
  programmeVersionId: z.uuid(),
  lessonId: z.uuid(),
  objectives: z.array(lessonObjectiveSchema).max(OBJECTIVE_PAGE_SIZE),
  nextAfterPosition: z.number().int().positive().nullable(),
});

// Read-service failures carry no database messages or requested foreign identities.
export class AcademicContextUnavailable extends Error {
  constructor() {
    super("Academic context is unavailable");
    this.name = "AcademicContextUnavailable";
  }
}
