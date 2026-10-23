import { z } from "zod";
import { ACADEMY_FORMAT_IDS, type AcademyFormatId } from "./academy-scheduler";

// Response and input contracts for the Ducelio Academy (B2C) RPCs
// (migration 202610220060). Every database response is parsed before use;
// none of these shapes can carry an answer key, expected answer or marking
// guidance, and the learner schemas are strict so a new field is refused
// rather than silently rendered.
const formatId = z.enum(
  ACADEMY_FORMAT_IDS as [AcademyFormatId, ...AcademyFormatId[]],
);
const stamp = z.string().min(1);
const day = z.iso.date();

export const ACADEMY_ERROR_CODES = [
  "FORBIDDEN",
  "NOT_FOUND",
  "NOT_FOUND_OR_FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_STATE",
  "MALFORMED_PACKAGE",
  "REVISION_CONFLICT",
  "SLUG_CONFLICT",
  "PUBLICATION_CONFLICT",
  "CURRICULUM_NOT_PUBLISHED",
  "FORMAT_INFEASIBLE",
  "INVALID_PRICE",
  "INVALID_FORMAT",
  "LEARNER_NOT_FOUND",
  "ENTITLEMENT_EXISTS",
  "ALREADY_MARKED",
  "PLAN_REQUIRED",
  "ACCESS_REVOKED",
  "NOT_RELEASED",
  "ACTIVITY_BLOCKED",
  "RUBRIC_PENDING",
] as const;
// NOT_INSTALLED is raised only by the administrator RPC path: the database
// lacks an Academy function, table or schema (a migration was not applied,
// or the API schema cache is stale). Learner paths keep SERVICE_UNAVAILABLE.
export type AcademyErrorCode =
  | (typeof ACADEMY_ERROR_CODES)[number]
  | "SERVICE_UNAVAILABLE"
  | "NOT_INSTALLED";
export class AcademyError extends Error {
  constructor(readonly code: AcademyErrorCode) {
    super(code);
    this.name = "AcademyError";
  }
}
export function academyErrorCode(message: string): AcademyErrorCode {
  if (message.startsWith("ACADEMY_PACKAGE_INVALID")) return "MALFORMED_PACKAGE";
  return (ACADEMY_ERROR_CODES as readonly string[]).includes(message)
    ? (message as AcademyErrorCode)
    : "SERVICE_UNAVAILABLE";
}

// Academy packages embed a full curriculum, so the upload limit is larger
// than the institutional package limit. Shared by the upload form (checked
// before sending) and the server action; next.config.ts sets the Server
// Action body limit above this value plus multipart overhead, so an
// oversized file always receives this message instead of failing silently.
export const MAX_ACADEMY_UPLOAD_BYTES = 1024 * 1024;
export const ACADEMY_UPLOAD_TOO_LARGE =
  "Academy course packages must be no larger than 1 MiB.";
export const academyUploadSizeError = (bytes: number) =>
  bytes > MAX_ACADEMY_UPLOAD_BYTES ? ACADEMY_UPLOAD_TOO_LARGE : null;

// PostgREST "function/table not in the schema cache" and PostgreSQL
// undefined function, table and schema.
const MISSING_DEPENDENCY_CODES = new Set([
  "PGRST202",
  "PGRST205",
  "42883",
  "42P01",
  "3F000",
]);
export function isMissingDatabaseDependency(error: { code?: unknown }) {
  return (
    typeof error.code === "string" && MISSING_DEPENDENCY_CODES.has(error.code)
  );
}

export const ACADEMY_ERROR_TEXT: Record<AcademyErrorCode, string> = {
  FORBIDDEN: "You do not have permission for this action.",
  NOT_FOUND: "That record was not found.",
  NOT_FOUND_OR_FORBIDDEN: "That record was not found.",
  INVALID_INPUT: "Check the details you entered and try again.",
  INVALID_STATE: "This step is not available in the package's current state.",
  MALFORMED_PACKAGE: "The package failed the database's own integrity checks.",
  REVISION_CONFLICT:
    "A different package already uses this key and revision. Upload it as a new revision.",
  SLUG_CONFLICT: "That public course address is already in use.",
  PUBLICATION_CONFLICT: "This course has already been published.",
  CURRICULUM_NOT_PUBLISHED:
    "The curriculum has not passed the publication pipeline yet.",
  FORMAT_INFEASIBLE: "A priced format cannot complete the course.",
  INVALID_PRICE:
    "Every price must be a whole amount for a format the package supports.",
  INVALID_FORMAT: "That learning format is not offered for this course.",
  LEARNER_NOT_FOUND:
    "No active, verified learner account uses that email address.",
  ENTITLEMENT_EXISTS:
    "That learner already has access to this course with different terms.",
  ALREADY_MARKED: "This submission has already been marked.",
  PLAN_REQUIRED: "Confirm a timetable first.",
  ACCESS_REVOKED:
    "Access to this course has ended. Your history and results remain available.",
  NOT_RELEASED: "This lesson opens at its scheduled session.",
  ACTIVITY_BLOCKED:
    "Learning materials are closed while a controlled assessment is in progress.",
  RUBRIC_PENDING:
    "This practical has no approved rubric yet, so it cannot be marked.",
  SERVICE_UNAVAILABLE:
    "The Academy service is unavailable. Nothing was changed.",
  NOT_INSTALLED:
    "The Academy database components are not installed in this environment, so nothing was changed. A platform operator must apply the pending Academy database migrations before this workspace can be used.",
};

export const academyPackageListSchema = z.array(
  z.object({
    organisationId: z.uuid().optional(),
    organisationName: z.string().optional(),
    id: z.uuid(),
    packageKey: z.string(),
    packageRevision: z.number().int(),
    status: z.enum(["UPLOADED", "VALIDATED", "PUBLISHED", "REJECTED"]),
    contentHash: z.string(),
    createdAt: stamp,
    validatedAt: stamp.nullable(),
    publishedAt: stamp.nullable(),
    rejectedReason: z.string().nullable(),
    title: z.string().nullable(),
    pendingDecisions: z.array(z.string()),
    curriculumImport: z
      .object({
        id: z.uuid(),
        status: z.enum([
          "IMPORTED",
          "VALIDATED",
          "APPLIED",
          "PUBLISHED",
          "REJECTED",
        ]),
        programmeVersionId: z.uuid().nullable(),
      })
      .nullable(),
    course: z
      .object({
        id: z.uuid(),
        offerId: z.uuid().nullable(),
        slug: z.string().nullable(),
        offerState: z.enum(["PUBLISHED", "ARCHIVED"]).nullable(),
        saleMode: z.enum(["REVIEW_ONLY", "PUBLIC_SALE"]).nullable(),
      })
      .nullable(),
  }),
);
export type AcademyPackageListItem = z.infer<
  typeof academyPackageListSchema
>[number];

// get_academy_delivery_evidence (migration 066): the individual-learning
// (Academy) package attached to each requested curriculum import, found by
// recorded relationships, with its offer terms; plus the number of Academy
// packages not yet attached to any curriculum.
export const ACADEMY_EVIDENCE_BATCH = 500;
const offerFormatSchema = z.object({
  formatId,
  weeks: z.number().int(),
  sessionMinutes: z.number().int(),
  minStudyDays: z.number().int(),
  maxStudyDays: z.number().int(),
  amountMinor: z.number().int().positive(),
});
export const academyDeliveryEvidenceSchema = z.object({
  links: z.array(
    z.object({
      curriculumImportId: z.uuid(),
      curriculumStatus: z.enum([
        "IMPORTED",
        "VALIDATED",
        "APPLIED",
        "PUBLISHED",
        "REJECTED",
      ]),
      packageId: z.uuid(),
      packageRevision: z.number().int(),
      status: z.enum(["UPLOADED", "VALIDATED", "PUBLISHED", "REJECTED"]),
      pendingDecisions: z.array(z.string()),
      course: z
        .object({
          id: z.uuid(),
          offerId: z.uuid().nullable(),
          slug: z.string().nullable(),
          offerState: z.enum(["PUBLISHED", "ARCHIVED"]).nullable(),
          saleMode: z.enum(["REVIEW_ONLY", "PUBLIC_SALE"]).nullable(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
          formats: z.array(offerFormatSchema),
        })
        .nullable(),
    }),
  ),
  packagesWithoutCurriculum: z.number().int().nonnegative(),
});
export type AcademyDeliveryEvidence = z.infer<
  typeof academyDeliveryEvidenceSchema
>;

export const catalogueFormatSchema = z.strictObject({
  formatId,
  weeks: z.number().int(),
  sessionMinutes: z.number().int(),
  minStudyDays: z.number().int(),
  maxStudyDays: z.number().int(),
  amountMinor: z.number().int().positive(),
});
export const academyCatalogueSchema = z.array(
  z.strictObject({
    offerId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    summary: z.string().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    description: z.string(),
    qualificationPreparation: z
      .strictObject({
        examinationBody: z.string(),
        qualificationName: z.string(),
        disclaimer: z.string(),
      })
      .nullable(),
    demoContent: z.boolean(),
    lessons: z.number().int(),
    labs: z.number().int(),
    assessments: z.number().int(),
    formats: z.array(catalogueFormatSchema).min(1),
  }),
);
export type AcademyCatalogueOffer = z.infer<
  typeof academyCatalogueSchema
>[number];

const offeredFormat = catalogueFormatSchema.omit({ amountMinor: true });
export const myAcademyEnrolmentsSchema = z.array(
  z.strictObject({
    enrolmentId: z.uuid(),
    courseId: z.uuid(),
    title: z.string(),
    status: z.enum(["ACTIVE", "COMPLETED"]),
    formatId: formatId.nullable(),
    fixedFormatId: formatId.nullable(),
    accessRevoked: z.boolean().default(false),
    offerSlug: z.string(),
    formats: z.array(offeredFormat),
    schedule: z
      .strictObject({
        revision: z.number().int(),
        startOn: day,
        endOn: day,
        studyDays: z.array(z.number().int()),
        localTime: z.string(),
        timezone: z.string(),
      })
      .nullable(),
    completedAt: stamp.nullable(),
  }),
);
export type MyAcademyEnrolment = z.infer<
  typeof myAcademyEnrolmentsSchema
>[number];

const kind = z.enum(["LESSON", "LAB", "REVISION", "ASSESSMENT"]);
const planItem = z.strictObject({
  kind,
  ref: z.string(),
  part: z.number().int(),
  parts: z.number().int(),
  sessionIndex: z.number().int(),
  localDate: day,
  startsAt: stamp,
  endsAt: stamp,
  minutes: z.number().int(),
  opensAt: stamp.nullable(),
  closesAt: stamp.nullable(),
  carried: z.boolean(),
  title: z.string().nullable(),
});
export type AcademyPlanItem = z.infer<typeof planItem>;
const alternative = z.strictObject({
  kind: z.enum(["STUDY_DAYS", "FORMAT"]),
  formatId,
  studyDays: z.array(z.number().int()),
});
export const academyPlanSchema = z.union([
  z.object({
    feasible: z.literal(true),
    formatId,
    weeks: z.number().int(),
    sessionMinutes: z.number().int(),
    startOn: day,
    endOn: day,
    finishOn: day.nullable(),
    studyDays: z.array(z.number().int()),
    localTime: z.string(),
    timezone: z.string(),
    effectiveOn: day.nullable(),
    items: z.array(planItem),
    weeklyMinutes: z.array(z.number().int()),
  }),
  z.object({
    feasible: z.literal(false),
    code: z.string(),
    message: z.string(),
    alternatives: z.array(alternative).optional(),
  }),
]);
export type AcademyPlan = z.infer<typeof academyPlanSchema>;

export const scheduleWriteSchema = z.union([
  z.object({
    ok: z.literal(true),
    scheduleId: z.uuid(),
    revision: z.number().int(),
    replayed: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string().optional(),
    alternatives: z.array(alternative).optional(),
  }),
]);

export const timetableSchema = z.strictObject({
  enrolmentId: z.uuid(),
  title: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED"]).optional(),
  serverTime: stamp.optional(),
  accessRevoked: z.boolean(),
  examActive: z.boolean().optional(),
  schedule: z
    .strictObject({
      revision: z.number().int(),
      formatId,
      startOn: day,
      endOn: day,
      studyDays: z.array(z.number().int()),
      localTime: z.string(),
      timezone: z.string(),
      sessionMinutes: z.number().int(),
    })
    .nullable(),
  items: z.array(
    planItem.omit({ carried: true }).extend({
      id: z.uuid(),
      sequence: z.number().int(),
      carried: z.boolean(),
      attempts: z.number().int().nullable(),
      labSubmitted: z.boolean().nullable(),
      // An assessed practical: no AI Lab Instructor help (migration 065).
      labGraded: z.boolean().nullable(),
      studied: z.boolean().nullable(),
      // Distinct from studied/mastery: the learner opened this scheduled AI
      // class, and how many Professor exchanges were recorded in it.
      classOpened: z.boolean().nullable(),
      teachingTurns: z.number().int().nullable(),
    }),
  ),
});
export type AcademyTimetable = z.infer<typeof timetableSchema>;

export const academyLessonSchema = z.strictObject({
  lessonRef: z.string(),
  sequence: z.number().int(),
  title: z.string(),
  studied: z.boolean(),
  objectives: z.array(
    z.strictObject({ id: z.uuid(), description: z.string() }),
  ),
  resources: z.array(
    z.strictObject({
      kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
      title: z.string(),
      body: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
  practicalActivities: z.array(
    z.strictObject({
      ref: z.string(),
      kind: z.string(),
      title: z.string(),
      instructions: z.string(),
    }),
  ),
});

export const startAttemptSchema = z.union([
  z.object({ ok: z.literal(true), attemptId: z.uuid(), resumed: z.boolean() }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    opensAt: stamp.optional(),
    closesAt: stamp.optional(),
  }),
]);

const question = z.strictObject({
  position: z.number().int(),
  prompt: z.string(),
  questionType: z.enum([
    "SINGLE_SELECT",
    "MULTIPLE_SELECT",
    "PBQ_MATCHING",
    "PBQ_ORDERING",
    "PBQ_CONFIGURATION",
  ]),
  interaction: z.record(z.string(), z.unknown()),
  maxMarks: z.number().int(),
  response: z.string().nullable(),
  revisions: z.number().int(),
});
export const attemptSchema = z.union([
  z.strictObject({
    attemptId: z.uuid(),
    enrolmentId: z.uuid(),
    assessmentRef: z.string(),
    title: z.string(),
    instructions: z.string(),
    state: z.literal("ACTIVE"),
    startedAt: stamp,
    expiresAt: stamp,
    serverTime: stamp,
    durationMinutes: z.number().int(),
    attemptNumber: z.number().int(),
    attemptsAllowed: z.number().int(),
    questions: z.array(question),
  }),
  z.strictObject({
    attemptId: z.uuid(),
    enrolmentId: z.uuid(),
    assessmentRef: z.string(),
    title: z.string(),
    state: z.literal("SUBMITTED"),
    submission: z.enum(["STUDENT_SUBMIT", "AUTO_TIMEOUT"]),
    submittedAt: stamp,
    score: z.number().int(),
    maxScore: z.number().int(),
    attemptNumber: z.number().int(),
    attemptsAllowed: z.number().int(),
  }),
]);
export type AcademyAttempt = z.infer<typeof attemptSchema>;

export const responseWriteSchema = z.union([
  z.object({ ok: z.literal(true), replayed: z.boolean() }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export const submitAttemptSchema = z.object({
  ok: z.literal(true),
  state: z.literal("SUBMITTED"),
  submission: z.enum(["STUDENT_SUBMIT", "AUTO_TIMEOUT"]),
  score: z.number().int(),
  maxScore: z.number().int(),
});
export const labWriteSchema = z.union([
  z.object({
    ok: z.literal(true),
    submissionId: z.uuid(),
    replayed: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    opensAt: stamp.optional(),
  }),
]);

export const resultsSchema = z.strictObject({
  enrolmentId: z.uuid(),
  status: z.enum(["ACTIVE", "COMPLETED"]),
  components: z.array(
    z.strictObject({
      componentKey: z.string(),
      source: z.enum(["ASSESSMENT", "LABS"]),
      weightBp: z.number().int(),
      status: z.enum(["PENDING", "GRADED"]),
      scoreBp: z.number().int().nullable(),
      passMarkBp: z.number().int().nullable(),
      assessmentRef: z.string().nullable(),
      title: z.string().nullable(),
    }),
  ),
  allComponentsGraded: z.boolean(),
  courseScoreBp: z.number().int().nullable(),
  passMarkBp: z.number().int(),
  outcome: z.enum(["IN_PROGRESS", "PASSED", "NOT_PASSED"]),
  pendingDecisions: z.array(z.string()),
  completion: z
    .strictObject({ completedAt: stamp, courseScoreBp: z.number().int() })
    .nullable(),
});
export type AcademyResults = z.infer<typeof resultsSchema>;

export const progressSchema = z.strictObject({
  enrolmentId: z.uuid(),
  lessons: z.number().int(),
  released: z.number().int(),
  classesOpened: z.number().int(),
  teachingInteractions: z.number().int(),
  studied: z.number().int(),
  policyVersion: z.literal("MASTERY_V1"),
  objectives: z.array(
    z.strictObject({
      objectiveId: z.uuid(),
      lessonRef: z.string(),
      description: z.string(),
      state: z.enum([
        "NOT_STARTED",
        "DEVELOPING",
        "DEMONSTRATED",
        "NEEDS_REINFORCEMENT",
      ]),
      evidence: z.number().int(),
    }),
  ),
});
export type AcademyProgress = z.infer<typeof progressSchema>;

export const labReviewListSchema = z.array(
  z.strictObject({
    submissionId: z.uuid(),
    courseTitle: z.string(),
    labRef: z.string(),
    title: z.string().nullable(),
    body: z.string(),
    submittedAt: stamp,
    rubric: z.array(
      z.strictObject({
        key: z.string(),
        description: z.string(),
        maxMarks: z.number().int(),
      }),
    ),
    markingGuidance: z.string().nullable(),
  }),
);

// Form inputs.
const reason = z.string().trim().min(5).max(300);
export const publishInputSchema = z.strictObject({
  packageId: z.uuid(),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(3)
    .max(80),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/),
  summary: z.string().trim().max(500).nullable(),
  prices: z
    .array(
      z.strictObject({
        formatId,
        amountMinor: z.number().int().min(1).max(100000000),
      }),
    )
    .min(1)
    .max(5),
  reason,
});
export const grantInputSchema = z.strictObject({
  offerId: z.uuid(),
  email: z.email().max(320),
  formatId: formatId.nullable(),
  reason,
});
export const scheduleInputSchema = z.strictObject({
  enrolmentId: z.uuid(),
  formatId,
  startOn: day,
  studyDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
});
export const revisionInputSchema = scheduleInputSchema
  .omit({ formatId: true, startOn: true })
  .extend({
    effectiveOn: day,
    expectedRevision: z.number().int().min(1).max(50),
  });

export const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;
export const KIND_LABELS: Record<z.infer<typeof kind>, string> = {
  LESSON: "Lesson",
  LAB: "Practical",
  REVISION: "Preparation",
  ASSESSMENT: "Assessment",
};
export function formatMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(
    amountMinor / 100,
  );
}
export const percent = (bp: number | null) =>
  bp === null ? "—" : `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

// A scheduled Academy session, rendered in the learner's authoritative
// timetable timezone (never the server's). Each instant is converted on its
// own, so a session that spans a daylight-saving change shows the correct
// offset at each end (for example "00:30 GMT – 03:30 BST"). An unknown zone
// falls back to an explicitly labelled UTC rather than the host timezone.
export function formatAcademySessionTime(
  startsAt: string,
  endsAt: string,
  timeZone: string,
) {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: zone,
    }).format(new Date(iso));
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
      timeZone: zone,
    }).format(new Date(iso));
  const text =
    day(startsAt) === day(endsAt)
      ? `${day(startsAt)}, ${time(startsAt)} – ${time(endsAt)}`
      : `${day(startsAt)}, ${time(startsAt)} – ${day(endsAt)}, ${time(endsAt)}`;
  return { timeZone: zone, text };
}
