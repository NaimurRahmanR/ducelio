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
export function assertMatchingVersion(
  enrolmentVersion: string,
  cohortVersion: string,
) {
  if (enrolmentVersion !== cohortVersion)
    throw new Error("Enrolment and cohort must share a programme version.");
}
