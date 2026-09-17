import { z } from "zod";
import {
  agentRoleSchema,
  roleCapabilityCatalogue,
} from "./academic-capability-policy";
import { validateRoleModelProfileRef } from "./academic-runtime-profile";

// Commercial V1 Course & Agent Engineering: versioned package/manifest contract.
// Pure domain module: no node/server built-ins, no database access. A package
// describes curriculum content; it never becomes institutional truth on its
// own. Only explicit publication (src/server/course-engineering) creates or
// promotes real Programme/ProgrammeVersion/Module/Lesson/Objective/
// LearningResource rows through the existing Academy OS authority.
export const COURSE_PACKAGE_SCHEMA_VERSION = "COURSE_PACKAGE_V1" as const;

// Stable slug-shaped identity, matching the existing programmes.slug constraint
// so a published package always yields a valid Programme slug.
export const packageKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
// A local reference is a package-internal identifier. It is never a database
// UUID: real identifiers are assigned only when content is actually inserted.
const localRef = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/);
const boundedReason = z.string().trim().min(5).max(300);
const position = z.number().int().positive().max(10000);
const boundedTitle = z.string().trim().min(1).max(200);
const boundedText = z.string().trim().min(1).max(12000);

export const programmeMetadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  examinationBody: z.string().trim().min(1).max(200),
  qualificationName: z.string().trim().min(1).max(200),
});

export const curriculumVersionMetadataSchema = z.strictObject({
  // Maps to programme_versions.label. Distinct from packageRevision: a
  // publisher may re-label a version without implying a new package revision,
  // and a corrective package revision need not change the curriculum label.
  label: z.string().trim().min(1).max(200),
});

const resourceSpecSchema = z
  .strictObject({
    key: localRef,
    kind: z.enum(["LECTURE_NOTE", "REFERENCE_LINK"]),
    title: boundedTitle,
    body: z.string().trim().min(1).max(12000).nullable(),
    url: z.string().trim().min(1).max(2048).nullable(),
    position,
  })
  .superRefine((value, ctx) => {
    if (value.kind === "LECTURE_NOTE") {
      if (!value.body)
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Lecture notes require body text.",
        });
      if (value.url)
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Lecture notes cannot include a reference URL.",
        });
    } else {
      if (value.body)
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Reference links cannot include note body text.",
        });
      if (!value.url || !/^https:\/\/\S+$/i.test(value.url))
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Reference links require an HTTPS URL.",
        });
    }
  });

// Exercises / practical labs are approved package content describing what a
// future Lab Instructor / Tutor may reference. They are not assignments and
// create no database row by themselves; they exist for agent context scoping.
const practicalActivitySchema = z.strictObject({
  key: localRef,
  kind: z.enum(["EXERCISE", "PRACTICAL_LAB"]),
  title: boundedTitle,
  instructions: boundedText,
  position,
  objectiveRefs: z.array(localRef).min(1).max(50),
});

const rubricCriterionSchema = z.strictObject({
  description: z.string().trim().min(1).max(500),
  maxMarks: z.number().int().min(1).max(100),
});

// Governed coursework bound to a future cohort/instructor. Publication stages
// this as validated content; materialising a real assignments row still goes
// through the existing create_assignment workflow once a cohort/instructor
// relationship exists. A package can never fabricate that relationship.
const assignmentTemplateSchema = z.strictObject({
  key: localRef,
  title: boundedTitle,
  instructions: boundedText,
  lessonRef: localRef,
  objectiveRefs: z.array(localRef).min(1).max(50),
  rubric: z.array(rubricCriterionSchema).min(1).max(50),
});

const assessmentQuestionTemplateSchema = z.strictObject({
  position,
  prompt: boundedText,
  maxMarks: z.number().int().min(1).max(100),
  expectedAnswer: boundedText,
  markingGuidance: z.string().trim().min(1).max(12000).nullable(),
  objectiveRefs: z.array(localRef).min(1).max(50),
});

// Controlled-assessment content. Answer keys/marking guidance never leave the
// package/staging layer unredacted toward a learner-readable surface; the
// existing assessment firewall continues to gate release after publication.
const assessmentTemplateSchema = z.strictObject({
  key: localRef,
  title: boundedTitle,
  instructions: boundedText,
  lessonRef: localRef,
  durationMinutes: z.number().int().min(1).max(360),
  attemptsAllowed: z.number().int().min(1).max(5),
  questions: z.array(assessmentQuestionTemplateSchema).min(1).max(100),
});

const objectiveSpecSchema = z.strictObject({
  key: localRef,
  description: z.string().trim().min(1).max(4000),
  position,
});

const lessonSpecSchema = z.strictObject({
  key: localRef,
  title: boundedTitle,
  position,
  objectives: z.array(objectiveSpecSchema).min(1).max(250),
  resources: z.array(resourceSpecSchema).max(250),
  practicalActivities: z.array(practicalActivitySchema).max(250),
});

const moduleSpecSchema = z.strictObject({
  key: localRef,
  title: boundedTitle,
  position,
  lessons: z.array(lessonSpecSchema).min(1).max(250),
});

// A real IANA zone name, validated the same way migration 023's DELIVERY_V1
// policy ultimately relies on database tzdata: Intl throws for any name the
// runtime's timezone database does not recognise. This is descriptive
// package metadata only (see below); it is still validated so a malformed
// value cannot silently pass through to a later consumer.
function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Scheduling defaults are descriptive package metadata only. DELIVERY_V1
// currently fixes the institution default (Mon/Wed/Fri 19:00, 60-minute
// slots); a package cannot override governed delivery policy by itself.
const schedulingDefaultsSchema = z.strictObject({
  studyDays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((v) => new Set(v).size === v.length),
  localStartTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(isValidIanaTimezone, "Timezone must be a recognised IANA name."),
});

// Agent configuration is a requested, reviewed-capability-scoped preference.
// It is validated structurally here, and its capability set is checked
// against the single code-owned role catalogue in academic-capability-
// policy.ts below. Passing this schema is never itself an authorization
// grant; the server always re-authorizes against that same allowlist at
// execution time (src/server/academic-runtime).
const agentRoleConfigSchema = z.strictObject({
  enabled: z.boolean(),
  modelProfileRef: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .nullable(),
  instructionalNotes: z.string().trim().max(4000).nullable(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50),
  escalationPolicy: z.enum(["NONE", "ACADEMIC_REVIEW"]),
});
export const agentConfigurationSchema = z
  .strictObject({
    PROFESSOR: agentRoleConfigSchema,
    TUTOR: agentRoleConfigSchema,
    LAB_INSTRUCTOR: agentRoleConfigSchema,
    EXAMINER: agentRoleConfigSchema,
    COUNSELLOR: agentRoleConfigSchema,
  })
  .superRefine((value, ctx) => {
    for (const role of agentRoleSchema.options) {
      const allowed = new Set(roleCapabilityCatalogue[role]);
      const capabilities = value[role].capabilities;
      capabilities.forEach((capability, i) => {
        if (!allowed.has(capability))
          ctx.addIssue({
            code: "custom",
            path: [role, "capabilities", i],
            message: `Capability is not in the reviewed ${role} allowlist.`,
          });
      });
      if (new Set(capabilities).size !== capabilities.length)
        ctx.addIssue({
          code: "custom",
          path: [role, "capabilities"],
          message: "Duplicate capability name.",
        });
      // PR16A: the shared role/profile/null policy (src/domain/academic-
      // runtime-profile.ts), applied identically to the stored
      // agentConfigInputSchema boundary in academic-agent-config.ts -- a
      // package can never author a cross-role modelProfileRef, or a null
      // ref on an enabled PROFESSOR entry, regardless of what the database's
      // own assert_full_package_valid recheck (migration 036) would
      // separately catch.
      const profileValidation = validateRoleModelProfileRef(
        role,
        value[role].modelProfileRef,
        value[role].enabled,
      );
      if (!profileValidation.ok) {
        ctx.addIssue({
          code: "custom",
          path: [role, "modelProfileRef"],
          message:
            profileValidation.issue === "CROSS_ROLE_REF"
              ? `modelProfileRef must be null or the exact ${role} runtime profile ref.`
              : `modelProfileRef is required while ${role} is enabled.`,
        });
      }
    }
  });
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

export const coursePackageSchema = z.strictObject({
  schemaVersion: z.literal(COURSE_PACKAGE_SCHEMA_VERSION),
  packageKey: packageKeySchema,
  packageRevision: z.number().int().positive().max(100000),
  programme: programmeMetadataSchema,
  curriculumVersion: curriculumVersionMetadataSchema,
  modules: z.array(moduleSpecSchema).min(1).max(250),
  assignmentTemplates: z.array(assignmentTemplateSchema).max(250),
  assessmentTemplates: z.array(assessmentTemplateSchema).max(100),
  schedulingDefaults: schedulingDefaultsSchema,
  agentConfiguration: agentConfigurationSchema,
  reason: boundedReason,
});
export type CoursePackage = z.infer<typeof coursePackageSchema>;

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type CoursePackageValidationReport = {
  packageKey: string;
  packageRevision: number;
  moduleCount: number;
  lessonCount: number;
  objectiveCount: number;
  resourceCount: number;
  practicalActivityCount: number;
  assignmentTemplateCount: number;
  assessmentTemplateCount: number;
};

// A branded type: only validateCoursePackage's own successful branch can
// produce one (no separate exported cast/escape-hatch function exists).
// This makes an unvalidated package structurally unrepresentable as
// publishable content.
export type ValidatedCoursePackage = CoursePackage & {
  readonly __brand: "ValidatedCoursePackage";
};

export type CoursePackageValidationResult =
  | {
      valid: true;
      report: CoursePackageValidationReport;
      package: ValidatedCoursePackage;
    }
  | { valid: false; errors: ValidationIssue[] };

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

// Deterministic structural + cross-reference validation. Pure function: same
// input always yields the same result, with no I/O and no partial mutation.
// Fails closed: any issue yields valid:false and no ValidatedCoursePackage.
export function validateCoursePackage(
  input: unknown,
): CoursePackageValidationResult {
  const parsed = coursePackageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) =>
        issue(i.path.join("."), "SCHEMA_INVALID", i.message),
      ),
    };
  }
  const pkg = parsed.data;
  const errors: ValidationIssue[] = [];

  const moduleKeys = new Set<string>();
  const modulePositions = new Set<number>();
  const lessonKeys = new Set<string>();
  const objectiveKeysByLesson = new Map<string, Set<string>>();
  let lessonCount = 0,
    objectiveCount = 0,
    resourceCount = 0,
    practicalActivityCount = 0;

  pkg.modules.forEach((module, mi) => {
    const modulePath = `modules[${mi}]`;
    if (moduleKeys.has(module.key))
      errors.push(
        issue(`${modulePath}.key`, "DUPLICATE_KEY", "Duplicate module key."),
      );
    moduleKeys.add(module.key);
    if (modulePositions.has(module.position))
      errors.push(
        issue(
          `${modulePath}.position`,
          "DUPLICATE_POSITION",
          "Duplicate module position within the package.",
        ),
      );
    modulePositions.add(module.position);
    const lessonPositions = new Set<number>();
    module.lessons.forEach((lesson, li) => {
      lessonCount++;
      const lessonPath = `${modulePath}.lessons[${li}]`;
      if (lessonKeys.has(lesson.key))
        errors.push(
          issue(
            `${lessonPath}.key`,
            "DUPLICATE_KEY",
            "Duplicate lesson key across the package.",
          ),
        );
      lessonKeys.add(lesson.key);
      if (lessonPositions.has(lesson.position))
        errors.push(
          issue(
            `${lessonPath}.position`,
            "DUPLICATE_POSITION",
            "Duplicate lesson position within a module.",
          ),
        );
      lessonPositions.add(lesson.position);

      const objectiveKeys = new Set<string>();
      const objectivePositions = new Set<number>();
      lesson.objectives.forEach((objective, oi) => {
        objectiveCount++;
        const objectivePath = `${lessonPath}.objectives[${oi}]`;
        if (objectiveKeys.has(objective.key))
          errors.push(
            issue(
              `${objectivePath}.key`,
              "DUPLICATE_KEY",
              "Duplicate objective key within a lesson.",
            ),
          );
        objectiveKeys.add(objective.key);
        if (objectivePositions.has(objective.position))
          errors.push(
            issue(
              `${objectivePath}.position`,
              "DUPLICATE_POSITION",
              "Duplicate objective position within a lesson.",
            ),
          );
        objectivePositions.add(objective.position);
      });
      objectiveKeysByLesson.set(lesson.key, objectiveKeys);

      const resourceKeys = new Set<string>();
      const resourcePositions = new Set<number>();
      lesson.resources.forEach((resource, ri) => {
        resourceCount++;
        const resourcePath = `${lessonPath}.resources[${ri}]`;
        if (resourceKeys.has(resource.key))
          errors.push(
            issue(
              `${resourcePath}.key`,
              "DUPLICATE_KEY",
              "Duplicate resource key within a lesson.",
            ),
          );
        resourceKeys.add(resource.key);
        if (resourcePositions.has(resource.position))
          errors.push(
            issue(
              `${resourcePath}.position`,
              "DUPLICATE_POSITION",
              "Duplicate resource position within a lesson.",
            ),
          );
        resourcePositions.add(resource.position);
      });

      const activityKeys = new Set<string>();
      const activityPositions = new Set<number>();
      lesson.practicalActivities.forEach((activity, ai) => {
        practicalActivityCount++;
        const activityPath = `${lessonPath}.practicalActivities[${ai}]`;
        if (activityKeys.has(activity.key))
          errors.push(
            issue(
              `${activityPath}.key`,
              "DUPLICATE_KEY",
              "Duplicate practical-activity key within a lesson.",
            ),
          );
        activityKeys.add(activity.key);
        if (activityPositions.has(activity.position))
          errors.push(
            issue(
              `${activityPath}.position`,
              "DUPLICATE_POSITION",
              "Duplicate practical-activity position within a lesson.",
            ),
          );
        activityPositions.add(activity.position);
        if (hasDuplicates(activity.objectiveRefs))
          errors.push(
            issue(
              `${activityPath}.objectiveRefs`,
              "DUPLICATE_REFERENCE",
              "Duplicate objective reference in practical-activity objectiveRefs.",
            ),
          );
        activity.objectiveRefs.forEach((ref, ri) => {
          if (!objectiveKeys.has(ref))
            errors.push(
              issue(
                `${activityPath}.objectiveRefs[${ri}]`,
                "INVALID_REFERENCE",
                "Practical activity references an objective outside its lesson.",
              ),
            );
        });
      });
    });
  });

  const lessonRefIndex = new Map<string, string>();
  pkg.modules.forEach((module) =>
    module.lessons.forEach((lesson) =>
      lessonRefIndex.set(lesson.key, lesson.key),
    ),
  );
  const assignmentKeys = new Set<string>();
  pkg.assignmentTemplates.forEach((template, ti) => {
    const path = `assignmentTemplates[${ti}]`;
    if (assignmentKeys.has(template.key))
      errors.push(
        issue(`${path}.key`, "DUPLICATE_KEY", "Duplicate assignment key."),
      );
    assignmentKeys.add(template.key);
    if (!lessonRefIndex.has(template.lessonRef)) {
      errors.push(
        issue(
          `${path}.lessonRef`,
          "INVALID_REFERENCE",
          "Assignment template references an unknown lesson.",
        ),
      );
    } else {
      if (hasDuplicates(template.objectiveRefs))
        errors.push(
          issue(
            `${path}.objectiveRefs`,
            "DUPLICATE_REFERENCE",
            "Duplicate objective reference in assignment objectiveRefs.",
          ),
        );
      const objectives = objectiveKeysByLesson.get(template.lessonRef);
      template.objectiveRefs.forEach((ref, ri) => {
        if (!objectives?.has(ref))
          errors.push(
            issue(
              `${path}.objectiveRefs[${ri}]`,
              "INVALID_REFERENCE",
              "Assignment template references an objective outside its lesson.",
            ),
          );
      });
    }
  });

  const assessmentKeys = new Set<string>();
  pkg.assessmentTemplates.forEach((template, ti) => {
    const path = `assessmentTemplates[${ti}]`;
    if (assessmentKeys.has(template.key))
      errors.push(
        issue(`${path}.key`, "DUPLICATE_KEY", "Duplicate assessment key."),
      );
    assessmentKeys.add(template.key);
    const positions = new Set<number>();
    if (!lessonRefIndex.has(template.lessonRef)) {
      errors.push(
        issue(
          `${path}.lessonRef`,
          "INVALID_REFERENCE",
          "Assessment template references an unknown lesson.",
        ),
      );
      return;
    }
    const objectives = objectiveKeysByLesson.get(template.lessonRef);
    template.questions.forEach((question, qi) => {
      const questionPath = `${path}.questions[${qi}]`;
      if (positions.has(question.position))
        errors.push(
          issue(
            `${questionPath}.position`,
            "DUPLICATE_POSITION",
            "Duplicate question position within an assessment.",
          ),
        );
      positions.add(question.position);
      if (hasDuplicates(question.objectiveRefs))
        errors.push(
          issue(
            `${questionPath}.objectiveRefs`,
            "DUPLICATE_REFERENCE",
            "Duplicate objective reference in assessment-question objectiveRefs.",
          ),
        );
      question.objectiveRefs.forEach((ref, ri) => {
        if (!objectives?.has(ref))
          errors.push(
            issue(
              `${questionPath}.objectiveRefs[${ri}]`,
              "INVALID_REFERENCE",
              "Assessment question references an objective outside its lesson.",
            ),
          );
      });
    });
  });

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    package: pkg as ValidatedCoursePackage,
    report: {
      packageKey: pkg.packageKey,
      packageRevision: pkg.packageRevision,
      moduleCount: pkg.modules.length,
      lessonCount,
      objectiveCount,
      resourceCount,
      practicalActivityCount,
      assignmentTemplateCount: pkg.assignmentTemplates.length,
      assessmentTemplateCount: pkg.assessmentTemplates.length,
    },
  };
}

// Deterministic canonical serialisation for content-integrity hashing.
// Object keys are sorted recursively so the canonical form is independent of
// upload key ordering; arrays keep their meaningful, validated order. The
// same validated package content always yields the same canonical string.
// Exported so the server layer can compute the same stable content-integrity
// string for both a freshly uploaded (possibly invalid) payload and an
// already-validated package, without duplicating the canonicalisation rule.
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys)
      result[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}
export function canonicalizeCoursePackage(pkg: CoursePackage): string {
  return JSON.stringify(canonicalizeJson(pkg));
}
