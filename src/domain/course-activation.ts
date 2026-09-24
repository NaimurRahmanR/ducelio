import { z } from "zod";
const key = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/);
const stamp = z.iso.datetime({ offset: true });
const assignmentWindow = z
  .strictObject({ templateKey: key, opensAt: stamp, dueAt: stamp })
  .refine((x) => Date.parse(x.opensAt) < Date.parse(x.dueAt));
const assessmentWindow = z
  .strictObject({ templateKey: key, opensAt: stamp, closesAt: stamp })
  .refine((x) => Date.parse(x.opensAt) < Date.parse(x.closesAt));
export const activationInput = z
  .strictObject({
    importId: z.uuid(),
    cohortId: z.uuid(),
    instructorId: z.uuid(),
    assignments: z.array(assignmentWindow).max(250),
    assessments: z.array(assessmentWindow).max(250),
    reason: z.string().trim().min(5).max(300),
  })
  .refine(
    (x) =>
      new Set(x.assignments.map((w) => w.templateKey)).size ===
        x.assignments.length &&
      new Set(x.assessments.map((w) => w.templateKey)).size ===
        x.assessments.length,
  );
export type ActivationInput = z.infer<typeof activationInput>;
const template = z.strictObject({
  templateKey: key,
  title: z.string().min(1).max(200),
});
export const activationOptions = z.strictObject({
  packages: z
    .array(
      z.strictObject({
        id: z.uuid(),
        key: z.string().max(80),
        revision: z.number().int().positive(),
      }),
    )
    .max(100),
  cohorts: z
    .array(z.strictObject({ id: z.uuid(), title: z.string() }))
    .max(200),
  instructors: z
    .array(z.strictObject({ id: z.uuid(), name: z.string() }))
    .max(200),
  assignments: z.array(template).max(250),
  assessments: z.array(template).max(250),
});
export type ActivationOptions = z.infer<typeof activationOptions>;

// Bounded admin activation-discovery read (list_commercial_v1_activations,
// migration 202609250042): closes the operational gap where an admin had to
// already know a real activation's UUID to reach policy setup or otherwise
// identify it. Display fields only -- programme/package/cohort identity and
// policy-publication status, never protected assessment/lab content or any
// learner-identifying field.
export const commercialV1ActivationSummarySchema = z.strictObject({
  activationId: z.uuid(),
  programmeTitle: z.string(),
  versionLabel: z.string(),
  packageKey: z.string(),
  packageRevision: z.number().int().positive(),
  cohortTitle: z.string(),
  cohortStartsOn: z.string(),
  activationState: z.literal("ACTIVATED"),
  createdAt: z.string(),
  gradingPolicyPublished: z.boolean(),
  resultPolicyPublished: z.boolean(),
  labPracticalsTotal: z.number().int().min(0),
  labPracticalsConfigured: z.number().int().min(0),
});
export type CommercialV1ActivationSummary = z.infer<
  typeof commercialV1ActivationSummarySchema
>;
export const commercialV1ActivationListSchema = z.strictObject({
  activations: z.array(commercialV1ActivationSummarySchema).max(200),
});

export const practicalInput = z.strictObject({
  enrolmentId: z.uuid(),
  cursor: z.number().int().min(0).max(62500).optional(),
});
export const practicalSupportInput = z.strictObject({
  enrolmentId: z.uuid(),
  practicalId: z.uuid(),
  requestId: z.uuid(),
});
export const practicalSchema = z.strictObject({
  id: z.uuid(),
  lessonId: z.uuid(),
  kind: z.enum(["EXERCISE", "PRACTICAL_LAB"]),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(12000),
  position: z.number().int().positive().max(10000),
  objectiveIds: z.array(z.uuid()).min(1).max(50),
});
export type Practical = z.infer<typeof practicalSchema>;
export class CourseActivationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CourseActivationError";
  }
}
