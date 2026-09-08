import { z } from "zod";
export const roleSchema = z.enum([
  "STUDENT",
  "INSTRUCTOR",
  "COUNSELLOR",
  "ACADEMIC_ADMIN",
  "REGISTRAR",
  "PLATFORM_ADMIN",
]);
export type Role = z.infer<typeof roleSchema>;
export const studyPlanItemSchema = z.object({
  planId: z.uuid(),
  studentId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  dueOn: z.iso.date(),
});
export const followupSchema = z.object({
  studentId: z.uuid(),
  eventId: z.uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  dueOn: z.iso.date(),
});
export const assignmentSchema = z
  .object({
    studentId: z.uuid(),
    counsellorId: z.uuid(),
    reason: z.string().trim().min(5).max(300),
  })
  .refine(
    (v) => v.studentId !== v.counsellorId,
    "A student cannot be their own counsellor.",
  );
export const programmePublicationSchema = z.object({
  programmeVersionId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export const enrolmentCreationSchema = z.object({
  studentId: z.uuid(),
  cohortId: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export const enrolmentStatusSchema = z.object({
  enrolmentId: z.uuid(),
  status: z.enum(["ACTIVE", "PAUSED", "WITHDRAWN"]),
  reason: z.string().trim().min(5).max(300),
});
export const classSessionCreationSchema = z
  .object({
    cohortId: z.uuid(),
    lessonId: z.uuid(),
    instructorId: z.uuid(),
    scheduledStart: z.iso.datetime({ offset: true }),
    scheduledEnd: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(5).max(300),
  })
  .refine(
    (value) =>
      new Date(value.scheduledEnd).getTime() >
      new Date(value.scheduledStart).getTime(),
    "Class session end must be after its start.",
  );
export const classSessionStatusSchema = z.object({
  sessionId: z.uuid(),
  status: z.enum(["COMPLETED", "CANCELLED"]),
  reason: z.string().trim().min(5).max(300),
});
export const attendanceRecordSchema = z.object({
  sessionId: z.uuid(),
  enrolmentId: z.uuid(),
  status: z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"]),
  reason: z.string().trim().min(5).max(300),
});
export const lessonSegmentSchema = z.object({
  lessonId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  position: z.coerce.number().int().positive(),
  reason: z.string().trim().min(5).max(300),
});
export const lessonProgressSchema = z.object({
  sessionId: z.uuid(),
  enrolmentId: z.uuid(),
  segmentId: z.uuid(),
  status: z.enum(["IN_PROGRESS", "COMPLETED"]),
  reason: z.string().trim().min(5).max(300),
});
export const learningResourceSchema = z
  .object({
    lessonId: z.uuid(),
    kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(12000).nullable(),
    url: z.string().trim().nullable(),
    position: z.coerce.number().int().positive(),
    reason: z.string().trim().min(5).max(300),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "LECTURE_NOTE") {
      if (!value.body) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Lecture notes require body text.",
        });
      }
      if (value.url) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Lecture notes cannot include a reference URL.",
        });
      }
    } else {
      if (value.body) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Reference links cannot include note body text.",
        });
      }
      if (!value.url || !/^https:\/\/\S+$/i.test(value.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Reference links require an HTTPS URL.",
        });
      }
    }
  });
export const learningEvidenceSchema = z.object({
  sessionId: z.uuid(),
  enrolmentId: z.uuid(),
  objectiveId: z.uuid(),
  evidenceKind: z.enum([
    "CLASS_RESPONSE",
    "RETRIEVAL_CHECK",
    "PRACTICAL_TASK",
    "DEBUGGING_TASK",
  ]),
  result: z.enum(["CORRECT", "PARTIAL", "INCORRECT"]),
  evidenceReference: z.string().trim().min(1).max(300),
  idempotencyKey: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(5).max(300),
});
export function assertMatchingVersion(
  enrolmentVersion: string,
  cohortVersion: string,
) {
  if (enrolmentVersion !== cohortVersion)
    throw new Error("Enrolment and cohort must share a programme version.");
}
