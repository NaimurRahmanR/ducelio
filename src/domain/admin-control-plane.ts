import { z } from "zod";
import { roleSchema } from "./academy";

// Commercial V1 admin control plane (migration 202610010044). The database
// RPCs are the authority; these contracts only bound what the server layer
// sends and accepts. STUDENT is provisioned by identity and is never a
// grantable/revocable staff role.
export const staffRoleSchema = z.enum([
  "INSTRUCTOR",
  "COUNSELLOR",
  "ACADEMIC_ADMIN",
  "REGISTRAR",
  "PLATFORM_ADMIN",
]);
export type StaffRole = z.infer<typeof staffRoleSchema>;
export const staffRoleLabels: Record<StaffRole, string> = {
  INSTRUCTOR: "Instructor",
  COUNSELLOR: "Counsellor",
  ACADEMIC_ADMIN: "Academic admin",
  REGISTRAR: "Registrar",
  PLATFORM_ADMIN: "Platform admin",
};

const reason = z.string().trim().min(5).max(300);
export const accountStatusSchema = z.enum(["ACTIVE", "DEACTIVATED"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const peopleQuerySchema = z.string().trim().max(100);
export const staffProfileInput = z.strictObject({
  userId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  reason,
});
export const roleChangeInput = z.strictObject({
  userId: z.uuid(),
  role: staffRoleSchema,
  reason,
});
export const accountStatusInput = z.strictObject({
  userId: z.uuid(),
  status: accountStatusSchema,
  reason,
});

export const personSchema = z.strictObject({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  emailConfirmed: z.boolean(),
  accountStatus: accountStatusSchema,
  staffTitle: z.string().nullable(),
  isStudent: z.boolean(),
  roles: z.array(roleSchema),
  // Live relationships that still depend on this person: activations of
  // not-completed cohorts plus scheduled class sessions, and active
  // counsellor assignments. Surfaced so a deactivated person's existing
  // relationships can be reassigned; deactivation never rewrites them.
  liveTeaching: z.number().int().nonnegative(),
  activeCounselling: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Person = z.infer<typeof personSchema>;
export const peopleDirectorySchema = z.strictObject({
  usablePlatformAdmins: z.number().int().nonnegative(),
  people: z.array(personSchema).max(100),
});
export type PeopleDirectory = z.infer<typeof peopleDirectorySchema>;

export const peopleAuditKinds = [
  "ROLE_GRANTED",
  "ROLE_REVOKED",
  "STAFF_PROFILE_CREATED",
  "STAFF_PROFILE_UPDATED",
  "ACCOUNT_DEACTIVATED",
  "ACCOUNT_REACTIVATED",
] as const;
export type PeopleAuditKind = (typeof peopleAuditKinds)[number];
export type PeopleAuditEntry = {
  id: string;
  kind: PeopleAuditKind;
  role: string | null;
  actorName: string;
  targetName: string;
  reason: string;
  occurredAt: string;
};

export const cohortStatusSchema = z.enum(["OPEN", "CLOSED", "COMPLETED"]);
export type CohortStatus = z.infer<typeof cohortStatusSchema>;
const day = z.iso.date();
const cohortFields = {
  title: z.string().trim().min(1).max(200),
  startsOn: day,
  endsOn: day.nullable(),
  capacity: z.number().int().min(1).max(10000).nullable(),
  reason,
};
const endsAfterStart = (value: { startsOn: string; endsOn: string | null }) =>
  value.endsOn === null || value.endsOn >= value.startsOn;
export const cohortCreateInput = z
  .strictObject({ programmeVersionId: z.uuid(), ...cohortFields })
  .refine(endsAfterStart, "The end date must not be before the start date.");
export const cohortUpdateInput = z
  .strictObject({ cohortId: z.uuid(), ...cohortFields })
  .refine(endsAfterStart, "The end date must not be before the start date.");
export const cohortStatusInput = z.strictObject({
  cohortId: z.uuid(),
  status: cohortStatusSchema,
  reason,
});

const count = z.number().int().nonnegative();
export const cohortSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  startsOn: day,
  endsOn: day.nullable(),
  capacity: z.number().int().positive().nullable(),
  status: cohortStatusSchema,
  programmeVersionId: z.uuid(),
  programmeTitle: z.string(),
  versionLabel: z.string(),
  isDemo: z.boolean(),
  enrolments: z.strictObject({
    active: count,
    paused: count,
    completed: count,
    withdrawn: count,
  }),
  activationId: z.uuid().nullable(),
  publishedOfferSlug: z.string().nullable(),
});
export type CohortSummary = z.infer<typeof cohortSummarySchema>;
export const cohortWorkspaceSchema = z.strictObject({
  cohorts: z.array(cohortSummarySchema).max(200),
  versions: z
    .array(
      z.strictObject({
        id: z.uuid(),
        programmeTitle: z.string(),
        label: z.string(),
      }),
    )
    .max(200),
});
export type CohortWorkspace = z.infer<typeof cohortWorkspaceSchema>;
export const cohortRosterSchema = z.strictObject({
  cohortId: z.uuid(),
  title: z.string(),
  status: cohortStatusSchema,
  capacity: z.number().int().positive().nullable(),
  total: count,
  enrolments: z
    .array(
      z.strictObject({
        enrolmentId: z.uuid(),
        studentId: z.uuid(),
        displayName: z.string(),
        studentNumber: z.string(),
        status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "WITHDRAWN"]),
        enrolledAt: z.string(),
      }),
    )
    .max(500),
});
export type CohortRoster = z.infer<typeof cohortRosterSchema>;

// Stable refusal codes raised by migration 044's RPCs, plus the two the
// server layer itself produces. Anything else is SERVICE_UNAVAILABLE.
export const adminRefusalMessages = {
  FORBIDDEN: "You do not have authority for this operation.",
  INVALID_INPUT:
    "Check the fields: a reason of 5–300 characters is required and dates, titles and capacity must be valid.",
  NOT_FOUND: "That record no longer exists.",
  DEMO_ACCOUNT:
    "Fictional demo accounts cannot sign in and cannot be given authority.",
  ACCOUNT_DEACTIVATED:
    "This account is deactivated. Reactivate it before changing its staff profile or roles.",
  STAFF_PROFILE_REQUIRED:
    "Create a staff profile for this person before granting a staff role.",
  UNSUPPORTED_ROLE:
    "Only staff roles can be granted or revoked here. The student role is provisioned by sign-up.",
  LAST_PLATFORM_ADMIN:
    "Refused: this is the last usable platform administrator. Grant PLATFORM_ADMIN to another active, confirmed account first.",
  SELF_LOCKOUT:
    "Refused: you cannot remove your own platform administration or deactivate your own account. Ask another platform administrator.",
  ACTIVE_COUNSELLOR_ASSIGNMENTS:
    "Refused: this counsellor still has assigned learners. Reassign them before revoking the role.",
  ACTIVE_TEACHING_ASSIGNMENTS:
    "Refused: this instructor still teaches live delivery (an activated cohort that is not completed, or a scheduled class session). Reassign the sessions or complete the cohort first.",
  STAFF_DEACTIVATED:
    "Refused: a deactivated account cannot be given new teaching or counselling assignments.",
  VERSION_NOT_FOUND: "That programme version does not exist.",
  VERSION_NOT_PUBLISHED:
    "Cohorts can only be created for a published programme version.",
  DEMO_VERSION:
    "Demo programme versions are previews and cannot receive institutional cohorts.",
  COHORT_CONFLICT:
    "A cohort with this title and start date already exists for this version with different settings.",
  COHORT_COMPLETED:
    "Refused: this cohort is completed. Its record is preserved and can no longer change.",
  INVALID_TRANSITION:
    "That lifecycle change is not allowed. Close an open cohort before completing it.",
  STARTS_ON_LOCKED:
    "Refused: the start date drives delivery scheduling and is locked once learners are enrolled or the course is activated.",
  CAPACITY_BELOW_ENROLMENT:
    "Refused: capacity cannot be lower than the number of current (non-withdrawn) enrolments.",
  SERVICE_UNAVAILABLE:
    "The operation could not be completed. Nothing was changed; try again.",
} as const;
export type AdminRefusalCode = keyof typeof adminRefusalMessages;
export function isAdminRefusalCode(value: unknown): value is AdminRefusalCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(adminRefusalMessages, value)
  );
}
export class AdminControlError extends Error {
  constructor(readonly code: AdminRefusalCode) {
    super(code);
    this.name = "AdminControlError";
  }
}
export function adminRefusalMessage(error: unknown) {
  return adminRefusalMessages[
    error instanceof AdminControlError ? error.code : "SERVICE_UNAVAILABLE"
  ];
}
