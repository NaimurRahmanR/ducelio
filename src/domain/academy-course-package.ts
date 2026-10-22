import { z } from "zod";
import {
  packageKeySchema,
  validateCoursePackage,
  type ValidatedCoursePackage,
  type ValidationIssue,
} from "./course-package";
import { QUESTION_TYPES, type QuestionType } from "./assessment-question-types";
import {
  ACADEMY_FORMATS,
  ACADEMY_FORMAT_IDS,
  ESTIMATE_START_DATE,
  canonicalStudyDays,
  planSchedule,
  type AcademyFormatId,
  type PlanUnit,
} from "./academy-scheduler";

// Ducelio Academy (B2C) course package: ACADEMY_COURSE_PACKAGE_V1.
//
// A separately versioned contract that EMBEDS an unchanged COURSE_PACKAGE_V1
// body as `curriculum`. The curriculum is validated by the existing
// validateCoursePackage and materialised through the existing Course &
// Agent Engineering pipeline (import -> validate -> apply -> agent
// configuration -> pre-publication test -> publish), so existing V1
// packages and their history are untouched. Everything Academy delivery
// needs on top of the curriculum -- lesson workload, lab scheduling and
// rubrics, assessment placement, preparation, grading and the delivery
// formats -- is declared here once, so publication needs no cohort, no
// instructor and no manual quiz, lab or date setup.
//
// Pure domain module. The database re-checks the delivery invariants it
// relies on (migration 202610220060) and is the scheduling authority.
export const ACADEMY_PACKAGE_SCHEMA_VERSION =
  "ACADEMY_COURSE_PACKAGE_V1" as const;

const localRef = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/);
const title = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
export const componentKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Use an UPPER_SNAKE component key.");

const sourceReferenceSchema = z.strictObject({
  key: localRef,
  title,
  publisher: title,
  version: text(100).nullable(),
  url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https:\/\/\S+$/i, "Source URLs must be HTTPS.")
    .nullable(),
  note: text(1000).nullable(),
});

const courseInformationSchema = z.strictObject({
  description: text(4000),
  // Ducelio prepares learners for external qualifications; it never awards
  // them. A disclaimer is therefore mandatory when one is named.
  qualificationPreparation: z
    .strictObject({
      examinationBody: title,
      qualificationName: title,
      disclaimer: z.string().trim().min(20).max(600),
    })
    .nullable(),
  sourceReferences: z.array(sourceReferenceSchema).min(1).max(50),
  academicPolicies: z
    .array(z.strictObject({ key: localRef, title, statement: text(2000) }))
    .max(20),
  // True for demonstration or seeded preview content, which is labelled as
  // such wherever it is shown.
  demoContent: z.boolean(),
});

const lessonWorkloadSchema = z.strictObject({
  lessonRef: localRef,
  teachingMinutes: z.number().int().min(10).max(600),
  prerequisiteLessonRefs: z.array(localRef).max(50),
});

const rubricCriterionSchema = z.strictObject({
  key: localRef,
  description: text(500),
  maxMarks: z.number().int().min(1).max(100),
});

const labSchema = z.strictObject({
  // A practicalActivities key in the embedded curriculum.
  activityRef: localRef,
  durationMinutes: z.number().int().min(10).max(480),
  // Omitted: immediately after the activity's own lesson.
  afterLessonRef: localRef.optional(),
  graded: z.boolean(),
  rubric: z.array(rubricCriterionSchema).max(20),
  // Protected: never shown to a learner.
  markingGuidance: text(12000).nullable(),
});

export const ASSESSMENT_KINDS = ["QUIZ", "TEST", "MIDTERM", "FINAL"] as const;
const assessmentSchema = z.strictObject({
  // An assessmentTemplates key in the embedded curriculum.
  templateRef: localRef,
  componentKey: componentKeySchema,
  kind: z.enum(ASSESSMENT_KINDS),
  afterLessonRef: localRef,
  requiredLessonRefs: z.array(localRef).min(1).max(250),
  preparation: z.strictObject({
    revisionMinutes: z.number().int().min(0).max(600),
    minimumDaysAfterTeaching: z.number().int().min(0).max(14),
  }),
  sittingWindowHours: z.number().int().min(1).max(336),
  passMarkBp: z.number().int().min(1).max(10000).nullable(),
  attemptScoring: z.enum(["HIGHEST", "LATEST"]),
});

const gradingComponentSchema = z.strictObject({
  componentKey: componentKeySchema,
  source: z.enum(["ASSESSMENT", "LABS"]),
  weightBp: z.number().int().min(1).max(10000),
});

const deliveryFormatSchema = z.strictObject({
  formatId: z.enum(
    ACADEMY_FORMAT_IDS as [AcademyFormatId, ...AcademyFormatId[]],
  ),
  sessionMinutes: z.number().int().min(30).max(480),
  minStudyDaysPerWeek: z.number().int().min(1).max(7),
  maxStudyDaysPerWeek: z.number().int().min(1).max(7),
});

export const academyCoursePackageSchema = z.strictObject({
  schemaVersion: z.literal(ACADEMY_PACKAGE_SCHEMA_VERSION),
  packageKey: packageKeySchema,
  packageRevision: z.number().int().positive().max(100000),
  course: courseInformationSchema,
  // An unchanged COURSE_PACKAGE_V1 body; validated by validateCoursePackage.
  curriculum: z.record(z.string(), z.unknown()),
  workload: z.strictObject({
    lessons: z.array(lessonWorkloadSchema).min(1).max(1000),
  }),
  labs: z.array(labSchema).max(250),
  assessments: z.array(assessmentSchema).min(1).max(100),
  grading: z.strictObject({
    components: z.array(gradingComponentSchema).min(1).max(50),
  }),
  completion: z.strictObject({
    coursePassMarkBp: z.number().int().min(1).max(10000),
    requireEveryComponentPassMark: z.boolean(),
  }),
  deliveryFormats: z.array(deliveryFormatSchema).min(1).max(5),
  // Academic settings the owner has NOT yet approved. While any remains,
  // the database keeps the offer review-only (no public sale, no checkout,
  // no official completion record). Never used to invent a missing value.
  pendingDecisions: z
    .array(
      z.strictObject({
        key: componentKeySchema,
        summary: z.string().trim().min(10).max(500),
      }),
    )
    .max(30),
  reason: z.string().trim().min(5).max(300),
});
export type AcademyCoursePackage = z.infer<typeof academyCoursePackageSchema>;

export type AcademyValidationWarning = {
  path: string;
  code: string;
  message: string;
};

export type AcademyFormatEstimate = {
  formatId: AcademyFormatId;
  label: string;
  weeks: number;
  sessionMinutes: number;
  minStudyDaysPerWeek: number;
  maxStudyDaysPerWeek: number;
  // Fewest weekly study days (spread pattern) that complete the course.
  minimumFeasibleStudyDays: number;
  sessionsRequired: number;
  classesPerWeek: number;
  weeklyMinutesPeak: number;
};

export type AcademyReview = {
  packageKey: string;
  packageRevision: number;
  title: string;
  curriculumLabel: string;
  description: string;
  qualificationPreparation: AcademyCoursePackage["course"]["qualificationPreparation"];
  demoContent: boolean;
  sourceReferences: {
    key: string;
    title: string;
    publisher: string;
    version: string | null;
  }[];
  modules: {
    key: string;
    title: string;
    lessons: {
      key: string;
      title: string;
      objectives: number;
      teachingMinutes: number;
    }[];
  }[];
  totals: {
    modules: number;
    lessons: number;
    objectives: number;
    teachingMinutes: number;
    labMinutes: number;
    revisionMinutes: number;
    assessmentMinutes: number;
  };
  labs: {
    ref: string;
    title: string;
    kind: string;
    afterLessonRef: string;
    durationMinutes: number;
    graded: boolean;
    rubricMaxMarks: number;
  }[];
  assessments: {
    ref: string;
    title: string;
    componentKey: string;
    kind: string;
    afterLessonRef: string;
    durationMinutes: number;
    attemptsAllowed: number;
    questionCount: number;
    totalMarks: number;
    questionTypes: Partial<Record<QuestionType, number>>;
    revisionMinutes: number;
    minimumDaysAfterTeaching: number;
    sittingWindowHours: number;
    passMarkBp: number | null;
    weightBp: number;
  }[];
  grading: { componentKey: string; source: string; weightBp: number }[];
  completion: AcademyCoursePackage["completion"];
  formats: AcademyFormatEstimate[];
  pendingDecisions: AcademyCoursePackage["pendingDecisions"];
  warnings: AcademyValidationWarning[];
};

export type ValidatedAcademyPackage = AcademyCoursePackage & {
  readonly __brand: "ValidatedAcademyPackage";
};

export type AcademyValidationResult =
  | {
      valid: true;
      package: ValidatedAcademyPackage;
      curriculum: ValidatedCoursePackage;
      units: PlanUnit[];
      review: AcademyReview;
    }
  | { valid: false; errors: ValidationIssue[] };

const issue = (
  path: string,
  code: string,
  message: string,
): ValidationIssue => ({
  path,
  code,
  message,
});

type Curriculum = ValidatedCoursePackage;
type Lesson = Curriculum["modules"][number]["lessons"][number];
type Activity = Lesson["practicalActivities"][number];

// Fixed curriculum order: modules by position, lessons by position.
export function orderedLessons(curriculum: Curriculum): Lesson[] {
  return [...curriculum.modules]
    .sort((a, b) => a.position - b.position)
    .flatMap((m) => [...m.lessons].sort((a, b) => a.position - b.position));
}

// The single, ordered unit sequence every format plans from. Mirrored by
// academy_private.build_units (migration 202610220060).
export function buildPlanUnits(
  pkg: AcademyCoursePackage,
  curriculum: Curriculum,
): PlanUnit[] {
  const lessons = orderedLessons(curriculum);
  const lessonIndex = new Map(lessons.map((l, i) => [l.key, i]));
  const minutes = new Map(
    pkg.workload.lessons.map((w) => [w.lessonRef, w.teachingMinutes]),
  );
  const activityLesson = new Map<
    string,
    { lesson: number; position: number }
  >();
  lessons.forEach((l, i) =>
    l.practicalActivities.forEach((a) =>
      activityLesson.set(a.key, { lesson: i, position: a.position }),
    ),
  );
  const labsAfter = new Map<number, typeof pkg.labs>();
  for (const lab of pkg.labs) {
    const at = lab.afterLessonRef
      ? lessonIndex.get(lab.afterLessonRef)!
      : activityLesson.get(lab.activityRef)!.lesson;
    labsAfter.set(at, [...(labsAfter.get(at) ?? []), lab]);
  }
  const templates = new Map(
    curriculum.assessmentTemplates.map((t) => [t.key, t]),
  );
  const units: PlanUnit[] = [];
  lessons.forEach((lesson, i) => {
    units.push({
      kind: "LESSON",
      ref: lesson.key,
      minutes: minutes.get(lesson.key)!,
    });
    const labs = [...(labsAfter.get(i) ?? [])].sort((a, b) => {
      const x = activityLesson.get(a.activityRef)!;
      const y = activityLesson.get(b.activityRef)!;
      return x.lesson - y.lesson || x.position - y.position;
    });
    for (const lab of labs)
      units.push({
        kind: "LAB",
        ref: lab.activityRef,
        minutes: lab.durationMinutes,
      });
    for (const a of pkg.assessments.filter(
      (a) => a.afterLessonRef === lesson.key,
    )) {
      if (a.preparation.revisionMinutes > 0)
        units.push({
          kind: "REVISION",
          ref: a.templateRef,
          minutes: a.preparation.revisionMinutes,
        });
      units.push({
        kind: "ASSESSMENT",
        ref: a.templateRef,
        minutes: templates.get(a.templateRef)!.durationMinutes,
        minimumDaysAfterTeaching: a.preparation.minimumDaysAfterTeaching,
      });
    }
  });
  return units;
}

export function estimateFormat(
  units: readonly PlanUnit[],
  f: AcademyCoursePackage["deliveryFormats"][number],
): AcademyFormatEstimate | null {
  const weeks = ACADEMY_FORMATS[f.formatId].weeks;
  let best: AcademyFormatEstimate | null = null;
  for (let k = f.maxStudyDaysPerWeek; k >= 1; k--) {
    const plan = planSchedule(
      units,
      { weeks, sessionMinutes: f.sessionMinutes },
      {
        startDate: ESTIMATE_START_DATE,
        studyDays: canonicalStudyDays(k),
      },
    );
    if (!plan.feasible) break;
    best = {
      formatId: f.formatId,
      label: ACADEMY_FORMATS[f.formatId].label,
      weeks,
      sessionMinutes: f.sessionMinutes,
      minStudyDaysPerWeek: f.minStudyDaysPerWeek,
      maxStudyDaysPerWeek: f.maxStudyDaysPerWeek,
      minimumFeasibleStudyDays: k,
      sessionsRequired: plan.sessions.length,
      classesPerWeek: Math.round((plan.sessions.length / weeks) * 10) / 10,
      weeklyMinutesPeak: Math.max(...plan.weeklyMinutes),
    };
  }
  return best;
}

// Deterministic structural, cross-reference, grading and feasibility
// validation. Fails closed with actionable, path-addressed issues. It never
// fills in a missing academic requirement.
export function validateAcademyCoursePackage(
  input: unknown,
): AcademyValidationResult {
  const parsed = academyCoursePackageSchema.safeParse(input);
  if (!parsed.success)
    return {
      valid: false,
      errors: parsed.error.issues.map((i) =>
        issue(i.path.join("."), "SCHEMA_INVALID", i.message),
      ),
    };
  const pkg = parsed.data;
  const curriculumResult = validateCoursePackage(pkg.curriculum);
  if (!curriculumResult.valid)
    return {
      valid: false,
      errors: curriculumResult.errors.map((e) => ({
        ...e,
        path: e.path ? `curriculum.${e.path}` : "curriculum",
      })),
    };
  const curriculum = curriculumResult.package;
  const errors: ValidationIssue[] = [];
  const warnings: AcademyValidationWarning[] = [];

  if (curriculum.packageKey !== pkg.packageKey)
    errors.push(
      issue(
        "curriculum.packageKey",
        "IDENTITY_MISMATCH",
        "The embedded curriculum packageKey must equal the Academy packageKey.",
      ),
    );
  if (curriculum.packageRevision !== pkg.packageRevision)
    errors.push(
      issue(
        "curriculum.packageRevision",
        "IDENTITY_MISMATCH",
        "The embedded curriculum packageRevision must equal the Academy packageRevision.",
      ),
    );

  const lessons = orderedLessons(curriculum);
  const lessonIndex = new Map(lessons.map((l, i) => [l.key, i]));
  const sourceKeys = new Set<string>();
  pkg.course.sourceReferences.forEach((s, i) => {
    if (sourceKeys.has(s.key))
      errors.push(
        issue(
          `course.sourceReferences[${i}].key`,
          "DUPLICATE_KEY",
          "Duplicate source reference key.",
        ),
      );
    sourceKeys.add(s.key);
  });

  // Workload: every lesson exactly once; prerequisites taught earlier.
  const seenWorkload = new Set<string>();
  pkg.workload.lessons.forEach((w, i) => {
    const path = `workload.lessons[${i}]`;
    if (!lessonIndex.has(w.lessonRef))
      errors.push(
        issue(
          `${path}.lessonRef`,
          "INVALID_REFERENCE",
          `Lesson "${w.lessonRef}" is not in the curriculum.`,
        ),
      );
    if (seenWorkload.has(w.lessonRef))
      errors.push(
        issue(
          `${path}.lessonRef`,
          "DUPLICATE_REFERENCE",
          `Lesson "${w.lessonRef}" has more than one workload entry.`,
        ),
      );
    seenWorkload.add(w.lessonRef);
    w.prerequisiteLessonRefs.forEach((p, pi) => {
      const at = lessonIndex.get(p);
      if (at === undefined)
        errors.push(
          issue(
            `${path}.prerequisiteLessonRefs[${pi}]`,
            "INVALID_REFERENCE",
            `Prerequisite lesson "${p}" is not in the curriculum.`,
          ),
        );
      else if (at >= (lessonIndex.get(w.lessonRef) ?? -1))
        errors.push(
          issue(
            `${path}.prerequisiteLessonRefs[${pi}]`,
            "PREREQUISITE_ORDER",
            `Prerequisite "${p}" must be taught before "${w.lessonRef}" in curriculum order.`,
          ),
        );
    });
  });
  for (const l of lessons)
    if (!seenWorkload.has(l.key))
      errors.push(
        issue(
          "workload.lessons",
          "MISSING_WORKLOAD",
          `Lesson "${l.key}" has no teachingMinutes; every lesson needs a declared workload.`,
        ),
      );

  // Labs: every practical activity scheduled exactly once.
  const activities = new Map<string, { activity: Activity; lesson: number }>();
  lessons.forEach((l, i) =>
    l.practicalActivities.forEach((a) =>
      activities.set(a.key, { activity: a, lesson: i }),
    ),
  );
  const seenLabs = new Set<string>();
  pkg.labs.forEach((lab, i) => {
    const path = `labs[${i}]`;
    const found = activities.get(lab.activityRef);
    if (!found) {
      errors.push(
        issue(
          `${path}.activityRef`,
          "INVALID_REFERENCE",
          `Practical activity "${lab.activityRef}" is not in the curriculum.`,
        ),
      );
      return;
    }
    if (seenLabs.has(lab.activityRef))
      errors.push(
        issue(
          `${path}.activityRef`,
          "DUPLICATE_REFERENCE",
          `Practical activity "${lab.activityRef}" is scheduled more than once.`,
        ),
      );
    seenLabs.add(lab.activityRef);
    if (lab.afterLessonRef !== undefined) {
      const at = lessonIndex.get(lab.afterLessonRef);
      if (at === undefined)
        errors.push(
          issue(
            `${path}.afterLessonRef`,
            "INVALID_REFERENCE",
            `Lesson "${lab.afterLessonRef}" is not in the curriculum.`,
          ),
        );
      else if (at < found.lesson)
        errors.push(
          issue(
            `${path}.afterLessonRef`,
            "PLACEMENT_BEFORE_TEACHING",
            `"${lab.activityRef}" cannot be placed before its own lesson is taught.`,
          ),
        );
    }
    // A graded lab may lack its rubric and guidance only while that is a
    // declared pending decision; it then cannot be marked or sold.
    const rubricPending = pkg.pendingDecisions.some(
      (d) => d.key === "LAB_RUBRICS",
    );
    if (lab.graded && lab.rubric.length === 0 && !rubricPending)
      errors.push(
        issue(
          `${path}.rubric`,
          "MISSING_RUBRIC",
          "A graded lab needs at least one rubric criterion.",
        ),
      );
    if (!lab.graded && lab.rubric.length > 0)
      errors.push(
        issue(
          `${path}.rubric`,
          "UNGRADED_RUBRIC",
          "An ungraded activity cannot declare rubric marks.",
        ),
      );
    if (lab.graded && !lab.markingGuidance && !rubricPending)
      errors.push(
        issue(
          `${path}.markingGuidance`,
          "MISSING_MARKING_GUIDANCE",
          "A graded lab needs marking guidance for its evaluator.",
        ),
      );
    if (new Set(lab.rubric.map((r) => r.key)).size !== lab.rubric.length)
      errors.push(
        issue(
          `${path}.rubric`,
          "DUPLICATE_KEY",
          "Duplicate rubric criterion key.",
        ),
      );
  });
  for (const key of activities.keys())
    if (!seenLabs.has(key))
      errors.push(
        issue(
          "labs",
          "MISSING_LAB",
          `Practical activity "${key}" has no scheduling entry; every practical activity must be scheduled.`,
        ),
      );

  // Assessments: every template scheduled once, taught before it is sat.
  const templates = new Map(
    curriculum.assessmentTemplates.map((t) => [t.key, t]),
  );
  const seenTemplates = new Set<string>();
  const componentOf = new Map<string, string>();
  pkg.assessments.forEach((a, i) => {
    const path = `assessments[${i}]`;
    const template = templates.get(a.templateRef);
    if (!template) {
      errors.push(
        issue(
          `${path}.templateRef`,
          "INVALID_REFERENCE",
          `Assessment template "${a.templateRef}" is not in the curriculum.`,
        ),
      );
      return;
    }
    if (seenTemplates.has(a.templateRef))
      errors.push(
        issue(
          `${path}.templateRef`,
          "DUPLICATE_REFERENCE",
          `Assessment "${a.templateRef}" is scheduled more than once.`,
        ),
      );
    seenTemplates.add(a.templateRef);
    if ([...componentOf.values()].includes(a.componentKey))
      errors.push(
        issue(
          `${path}.componentKey`,
          "DUPLICATE_KEY",
          `Component "${a.componentKey}" is used by more than one assessment.`,
        ),
      );
    componentOf.set(a.templateRef, a.componentKey);
    const anchor = lessonIndex.get(a.afterLessonRef);
    if (anchor === undefined) {
      errors.push(
        issue(
          `${path}.afterLessonRef`,
          "INVALID_REFERENCE",
          `Lesson "${a.afterLessonRef}" is not in the curriculum.`,
        ),
      );
      return;
    }
    const required = new Set(a.requiredLessonRefs);
    if (required.size !== a.requiredLessonRefs.length)
      errors.push(
        issue(
          `${path}.requiredLessonRefs`,
          "DUPLICATE_REFERENCE",
          "Duplicate required lesson.",
        ),
      );
    a.requiredLessonRefs.forEach((r, ri) => {
      const at = lessonIndex.get(r);
      if (at === undefined)
        errors.push(
          issue(
            `${path}.requiredLessonRefs[${ri}]`,
            "INVALID_REFERENCE",
            `Lesson "${r}" is not in the curriculum.`,
          ),
        );
      else if (at > anchor)
        errors.push(
          issue(
            `${path}.requiredLessonRefs[${ri}]`,
            "PLACEMENT_BEFORE_TEACHING",
            `"${a.templateRef}" requires "${r}", which is taught after the assessment is placed.`,
          ),
        );
    });
    const covered = new Set([
      template.lessonRef,
      ...template.questions.map((q) => q.lessonRef ?? template.lessonRef),
    ]);
    for (const lessonRef of covered)
      if (!required.has(lessonRef))
        errors.push(
          issue(
            `${path}.requiredLessonRefs`,
            "COVERAGE_GAP",
            `"${a.templateRef}" assesses lesson "${lessonRef}", which is not in requiredLessonRefs.`,
          ),
        );
    template.questions.forEach((q, qi) => {
      if ((q.questionType ?? "FREE_TEXT") === "FREE_TEXT")
        errors.push(
          issue(
            `curriculum.assessmentTemplates.${a.templateRef}.questions[${qi}]`,
            "UNSUPPORTED_QUESTION_TYPE",
            "Academy delivery grades deterministically scored question types only; free-text answers need governed Examiner grading, which is not yet available for Academy enrolments.",
          ),
        );
    });
    if (a.sittingWindowHours * 60 < template.durationMinutes)
      errors.push(
        issue(
          `${path}.sittingWindowHours`,
          "WINDOW_TOO_SHORT",
          `The sitting window is shorter than the ${template.durationMinutes}-minute assessment.`,
        ),
      );
    if (
      a.preparation.revisionMinutes === 0 &&
      (a.kind === "MIDTERM" || a.kind === "FINAL")
    )
      warnings.push({
        path: `${path}.preparation.revisionMinutes`,
        code: "NO_REVISION",
        message: `${a.kind} "${a.templateRef}" has no scheduled revision time.`,
      });
  });
  for (const key of templates.keys())
    if (!seenTemplates.has(key))
      errors.push(
        issue(
          "assessments",
          "MISSING_ASSESSMENT",
          `Assessment template "${key}" has no scheduling entry; every assessment must be placed.`,
        ),
      );
  const finals = pkg.assessments.filter((a) => a.kind === "FINAL");
  if (finals.length > 1)
    errors.push(
      issue(
        "assessments",
        "MULTIPLE_FINALS",
        "A course can declare at most one FINAL assessment.",
      ),
    );
  if (finals.length === 1) {
    const last = Math.max(
      ...pkg.assessments.map((a) => lessonIndex.get(a.afterLessonRef) ?? -1),
    );
    if ((lessonIndex.get(finals[0].afterLessonRef) ?? -1) < last)
      errors.push(
        issue(
          "assessments",
          "FINAL_NOT_LAST",
          "The FINAL assessment must be placed after every other assessment.",
        ),
      );
  }

  if (
    new Set(pkg.pendingDecisions.map((d) => d.key)).size !==
    pkg.pendingDecisions.length
  )
    errors.push(
      issue(
        "pendingDecisions",
        "DUPLICATE_KEY",
        "Each pending decision key may appear once.",
      ),
    );

  // Grading distribution.
  const components = pkg.grading.components;
  const weightTotal = components.reduce((n, c) => n + c.weightBp, 0);
  if (weightTotal !== 10000)
    errors.push(
      issue(
        "grading.components",
        "WEIGHTS_NOT_100",
        `Component weights total ${weightTotal / 100}%; they must total exactly 100%.`,
      ),
    );
  if (new Set(components.map((c) => c.componentKey)).size !== components.length)
    errors.push(
      issue(
        "grading.components",
        "DUPLICATE_KEY",
        "Duplicate grading component key.",
      ),
    );
  const assessmentComponents = new Set(componentOf.values());
  components.forEach((c, i) => {
    if (c.source === "ASSESSMENT" && !assessmentComponents.has(c.componentKey))
      errors.push(
        issue(
          `grading.components[${i}]`,
          "INVALID_REFERENCE",
          `No assessment fills component "${c.componentKey}".`,
        ),
      );
  });
  for (const key of assessmentComponents)
    if (
      !components.some(
        (c) => c.source === "ASSESSMENT" && c.componentKey === key,
      )
    )
      errors.push(
        issue(
          "grading.components",
          "UNWEIGHTED_COMPONENT",
          `Assessment component "${key}" has no grading weight.`,
        ),
      );
  const labComponents = components.filter((c) => c.source === "LABS");
  const gradedLabs = pkg.labs.filter((l) => l.graded);
  if (labComponents.length > 1)
    errors.push(
      issue(
        "grading.components",
        "MULTIPLE_LAB_COMPONENTS",
        "Declare at most one LABS grading component.",
      ),
    );
  if (gradedLabs.length > 0 && labComponents.length === 0)
    errors.push(
      issue(
        "grading.components",
        "UNWEIGHTED_COMPONENT",
        "Graded labs exist but no LABS grading component carries their weight.",
      ),
    );
  if (gradedLabs.length === 0 && labComponents.length > 0)
    errors.push(
      issue(
        "grading.components",
        "EMPTY_COMPONENT",
        "A LABS component is weighted but no lab is graded.",
      ),
    );

  // Delivery formats.
  const seenFormats = new Set<string>();
  pkg.deliveryFormats.forEach((f, i) => {
    const path = `deliveryFormats[${i}]`;
    if (seenFormats.has(f.formatId))
      errors.push(
        issue(
          `${path}.formatId`,
          "DUPLICATE_KEY",
          `Format ${f.formatId} is declared more than once.`,
        ),
      );
    seenFormats.add(f.formatId);
    if (f.minStudyDaysPerWeek > f.maxStudyDaysPerWeek)
      errors.push(
        issue(
          path,
          "INVALID_RANGE",
          "minStudyDaysPerWeek cannot exceed maxStudyDaysPerWeek.",
        ),
      );
    for (const lab of pkg.labs)
      if (lab.durationMinutes > f.sessionMinutes)
        errors.push(
          issue(
            `${path}.sessionMinutes`,
            "SESSION_TOO_SHORT",
            `${f.formatId}: lab "${lab.activityRef}" (${lab.durationMinutes} min) does not fit a ${f.sessionMinutes}-minute session.`,
          ),
        );
    for (const t of curriculum.assessmentTemplates)
      if (t.durationMinutes > f.sessionMinutes)
        errors.push(
          issue(
            `${path}.sessionMinutes`,
            "SESSION_TOO_SHORT",
            `${f.formatId}: assessment "${t.key}" (${t.durationMinutes} min) does not fit a ${f.sessionMinutes}-minute session.`,
          ),
        );
  });

  if (errors.length) return { valid: false, errors };

  const units = buildPlanUnits(pkg, curriculum);
  const formats: AcademyFormatEstimate[] = [];
  pkg.deliveryFormats.forEach((f, i) => {
    const estimate = estimateFormat(units, f);
    if (!estimate) {
      errors.push(
        issue(
          `deliveryFormats[${i}]`,
          "FORMAT_INFEASIBLE",
          `${f.formatId} cannot complete the course in ${ACADEMY_FORMATS[f.formatId].weeks} weeks even with ${f.maxStudyDaysPerWeek} study days a week of ${f.sessionMinutes} minutes. Remove the format or change its session length.`,
        ),
      );
      return;
    }
    if (estimate.minimumFeasibleStudyDays > f.minStudyDaysPerWeek)
      errors.push(
        issue(
          `deliveryFormats[${i}].minStudyDaysPerWeek`,
          "FORMAT_INFEASIBLE",
          `${f.formatId} needs at least ${estimate.minimumFeasibleStudyDays} study days a week; raise minStudyDaysPerWeek to ${estimate.minimumFeasibleStudyDays} so no learner is offered an impossible choice.`,
        ),
      );
    formats.push(estimate);
  });
  if (errors.length) return { valid: false, errors };
  formats.sort((a, b) => a.weeks - b.weeks);

  const workload = new Map(
    pkg.workload.lessons.map((w) => [w.lessonRef, w.teachingMinutes]),
  );
  const weightOf = new Map(components.map((c) => [c.componentKey, c.weightBp]));
  const review: AcademyReview = {
    packageKey: pkg.packageKey,
    packageRevision: pkg.packageRevision,
    title: curriculum.programme.title,
    curriculumLabel: curriculum.curriculumVersion.label,
    description: pkg.course.description,
    qualificationPreparation: pkg.course.qualificationPreparation,
    demoContent: pkg.course.demoContent,
    sourceReferences: pkg.course.sourceReferences.map(
      ({ key, title, publisher, version }) => ({
        key,
        title,
        publisher,
        version,
      }),
    ),
    modules: [...curriculum.modules]
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        key: m.key,
        title: m.title,
        lessons: [...m.lessons]
          .sort((a, b) => a.position - b.position)
          .map((l) => ({
            key: l.key,
            title: l.title,
            objectives: l.objectives.length,
            teachingMinutes: workload.get(l.key)!,
          })),
      })),
    totals: {
      modules: curriculum.modules.length,
      lessons: lessons.length,
      objectives: lessons.reduce((n, l) => n + l.objectives.length, 0),
      teachingMinutes: units
        .filter((u) => u.kind === "LESSON")
        .reduce((n, u) => n + u.minutes, 0),
      labMinutes: units
        .filter((u) => u.kind === "LAB")
        .reduce((n, u) => n + u.minutes, 0),
      revisionMinutes: units
        .filter((u) => u.kind === "REVISION")
        .reduce((n, u) => n + u.minutes, 0),
      assessmentMinutes: units
        .filter((u) => u.kind === "ASSESSMENT")
        .reduce((n, u) => n + u.minutes, 0),
    },
    labs: pkg.labs.map((lab) => {
      const { activity, lesson } = activities.get(lab.activityRef)!;
      return {
        ref: lab.activityRef,
        title: activity.title,
        kind: activity.kind,
        afterLessonRef: lab.afterLessonRef ?? lessons[lesson].key,
        durationMinutes: lab.durationMinutes,
        graded: lab.graded,
        rubricMaxMarks: lab.rubric.reduce((n, r) => n + r.maxMarks, 0),
      };
    }),
    assessments: pkg.assessments.map((a) => {
      const t = templates.get(a.templateRef)!;
      const questionTypes: Partial<Record<QuestionType, number>> = {};
      for (const q of t.questions) {
        const type = q.questionType ?? "FREE_TEXT";
        questionTypes[type] = (questionTypes[type] ?? 0) + 1;
      }
      return {
        ref: a.templateRef,
        title: t.title,
        componentKey: a.componentKey,
        kind: a.kind,
        afterLessonRef: a.afterLessonRef,
        durationMinutes: t.durationMinutes,
        attemptsAllowed: t.attemptsAllowed,
        questionCount: t.questions.length,
        totalMarks: t.questions.reduce((n, q) => n + q.maxMarks, 0),
        questionTypes,
        revisionMinutes: a.preparation.revisionMinutes,
        minimumDaysAfterTeaching: a.preparation.minimumDaysAfterTeaching,
        sittingWindowHours: a.sittingWindowHours,
        passMarkBp: a.passMarkBp,
        weightBp: weightOf.get(a.componentKey)!,
      };
    }),
    grading: components.map(({ componentKey, source, weightBp }) => ({
      componentKey,
      source,
      weightBp,
    })),
    completion: pkg.completion,
    pendingDecisions: pkg.pendingDecisions,
    formats,
    warnings,
  };
  // Only list the known question types (guards against a future type
  // silently appearing in a review without a label).
  for (const a of review.assessments)
    for (const type of Object.keys(a.questionTypes))
      if (!(QUESTION_TYPES as readonly string[]).includes(type))
        throw new Error("Unknown question type in review.");
  return {
    valid: true,
    package: pkg as ValidatedAcademyPackage,
    curriculum,
    units,
    review,
  };
}

export const academyReviewFormatLabel = (id: AcademyFormatId) =>
  `${ACADEMY_FORMATS[id].label} · ${ACADEMY_FORMATS[id].weeks} weeks`;
