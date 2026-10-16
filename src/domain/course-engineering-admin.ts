import { z } from "zod";
import { coursePackageSchema, type AgentConfiguration } from "./course-package";
import {
  questionTypeSchema,
  type QuestionType,
} from "./assessment-question-types";
import {
  agentRoleSchema,
  type AgentConfigRecord,
} from "./academic-agent-config";

export const MAX_COURSE_UPLOAD_BYTES = 512 * 1024;

// Governed pre-publication test (PR15). This identity is fixed and stored
// on every test run and inside the database's own publication fingerprint;
// see supabase/migrations/202609170035_commercial_v1_course_prepublication_test.sql.
// A future stronger V2 test implementation gets its own new policy version
// rather than silently reinterpreting an old V1 PASS as current.
export const COURSE_PREPUBLICATION_TEST_POLICY_VERSION =
  "COURSE_PREPUBLICATION_TEST_V1" as const;

export const testFailureCodeSchema = z.enum([
  "PACKAGE_REVALIDATION_FAILED",
  "MATERIALIZED_STATE_MISMATCH",
  "CONFIGURATION_INCOMPLETE",
  "CONFIGURATION_MISMATCH",
]);
export type TestFailureCode = z.infer<typeof testFailureCodeSchema>;

// The result of a single run_course_package_test call: the database's own
// PASS/FAIL verdict, never a caller-supplied outcome.
export const testRunResultSchema = z.strictObject({
  id: z.uuid(),
  outcome: z.enum(["PASS", "FAIL"]),
  failureCode: testFailureCodeSchema.nullable(),
  failedRoles: z.array(agentRoleSchema).max(5),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  runSequence: z.number().int(),
  runAt: z.iso.datetime({ offset: true }),
});
export type TestRunResult = z.infer<typeof testRunResultSchema>;

// Safe, display-only readiness projection. NEVER used by the database to
// decide whether publication may proceed -- publish_course_package
// recomputes and re-checks the current fingerprint itself, independently,
// every time. This exists only so the admin surface can show a truthful
// state without the browser calculating authority.
export const testStatusSchema = z.enum([
  "NOT_TESTED",
  "FAILED",
  "PASSED_CURRENT",
  "PASSED_STALE",
]);
export type TestStatus = z.infer<typeof testStatusSchema>;

export const testStatusResultSchema = z.strictObject({
  status: testStatusSchema,
  outcome: z.enum(["PASS", "FAIL"]).nullable(),
  failureCode: testFailureCodeSchema.nullable(),
  failedRoles: z.array(agentRoleSchema).max(5),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  runSequence: z.number().int().nullable(),
  runAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TestStatusResult = z.infer<typeof testStatusResultSchema>;

const ROLE_LABELS: Record<string, string> = {
  PROFESSOR: "Professor",
  TUTOR: "Tutor",
  LAB_INSTRUCTOR: "Lab instructor",
  EXAMINER: "Examiner",
  COUNSELLOR: "Counsellor",
};

// Bounded, closed-vocabulary formatting only: failureCode and failedRoles
// are already safe enum values (never raw DB/exception text), so this is
// purely a presentation helper, not a sanitizer.
export function describeTestFailure(
  failureCode: TestFailureCode | null,
  failedRoles: readonly string[],
): string {
  const roles = failedRoles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
  switch (failureCode) {
    case "PACKAGE_REVALIDATION_FAILED":
      return "The staged package no longer passes independent structural validation. Correct the file and import a new revision.";
    case "MATERIALIZED_STATE_MISMATCH":
      return "The applied course content, or its programme/version binding, no longer matches exactly what this package tested. This can happen if a later revision under the same package key changed shared programme details, or if institutional content changed outside this package. Investigate before retesting; do not publish until the drift is resolved.";
    case "CONFIGURATION_INCOMPLETE":
      return `Explicit configuration is missing for: ${roles}. Save every role before testing again.`;
    case "CONFIGURATION_MISMATCH":
      return `Saved configuration does not match the reviewed package proposal for: ${roles}. Update the saved configuration or correct the package.`;
    default:
      return "The pre-publication test did not pass.";
  }
}

export function describeTestStatus(status: TestStatus): string {
  switch (status) {
    case "NOT_TESTED":
      return "Not yet tested.";
    case "FAILED":
      return "Latest pre-publication test for the current state failed.";
    case "PASSED_CURRENT":
      return "Pre-publication test passed for the exact current package, materialised institutional state and agent-configuration state.";
    case "PASSED_STALE":
      return "A prior test passed, but the package, materialised institutional state or agent configuration has changed since. Run the test again.";
  }
}
export const packageStatusSchema = z.enum([
  "IMPORTED",
  "VALIDATED",
  "APPLIED",
  "PUBLISHED",
  "REJECTED",
]);
export const packageOperationSchema = z.enum([
  "validate",
  "apply",
  "publish",
  "reject",
]);
export const packageActionInputSchema = z.strictObject({
  importId: z.uuid(),
  operation: packageOperationSchema,
  reason: z.string().trim().min(5).max(300),
});
export function packageActions(status: string, publicationReady = true) {
  switch (status) {
    case "IMPORTED":
      return ["validate", "reject"] as const;
    case "VALIDATED":
      return ["apply", "reject"] as const;
    case "APPLIED":
      return publicationReady ? (["publish"] as const) : ([] as const);
    default:
      return [];
  }
}

function normalizeInstructionalNotes(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length ? trimmed : null;
}

function sameCapabilities(
  actual: readonly string[],
  expected: readonly string[],
) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((capability, index) => capability === b[index]);
}

// Operator-workflow readiness only. The database remains authoritative at
// activation time; this prevents the admin surface from publishing a package
// whose explicit saved configuration is missing or already known to conflict
// with the reviewed package proposal.
export function agentConfigsMatchProposal(
  proposal: AgentConfiguration,
  configs: readonly AgentConfigRecord[],
): boolean {
  if (configs.length !== agentRoleSchema.options.length) return false;
  return agentRoleSchema.options.every((role) => {
    const matches = configs.filter((config) => config.role === role);
    if (matches.length !== 1) return false;
    const actual = matches[0];
    const expected = proposal[role];
    return (
      actual.enabled === expected.enabled &&
      actual.modelProfileRef === expected.modelProfileRef &&
      normalizeInstructionalNotes(actual.instructionalNotes) ===
        normalizeInstructionalNotes(expected.instructionalNotes) &&
      actual.escalationPolicy === expected.escalationPolicy &&
      sameCapabilities(actual.capabilities, expected.capabilities)
    );
  });
}

// A second, explicit presentation allowlist after the canonical redacted RPC.
// Never stringify the RPC's unknown preview/report or a validation result.
const template = coursePackageSchema.shape.assessmentTemplates.element;
const safeAssessment = template
  .omit({ questions: true })
  .strip()
  .extend({
    questions: z
      .array(
        z.object({
          position: z.number().int(),
          maxMarks: z.number().int(),
          objectiveRefs: z.array(z.string()),
          // CP2: the type is not protected; definitions/keys never pass here.
          questionType: questionTypeSchema.optional(),
        }),
      )
      .max(100),
  })
  .transform(({ questions, ...metadata }) => ({
    ...metadata,
    questionCount: questions.length,
    totalMarks: questions.reduce((n, q) => n + q.maxMarks, 0),
    questionTypeCounts: questions.reduce<Partial<Record<QuestionType, number>>>(
      (counts, q) => {
        const type = q.questionType ?? "FREE_TEXT";
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      },
      {},
    ),
  }));
export const operatorPreviewSchema = coursePackageSchema
  .omit({ reason: true, assessmentTemplates: true })
  .strip()
  .extend({
    assessmentTemplates: z.array(safeAssessment).max(100),
  });
export type OperatorPreview = z.infer<typeof operatorPreviewSchema>;
export type CourseEngineeringState = {
  error?: string;
  message?: string;
  importId?: string;
  issues?: string[];
};

// Values/messages/unknown field names from an invalid upload are never echoed.
// Numeric locations and known structural names remain useful to the author.
export function safeValidationIssues(
  issues: readonly { path: string; code: string }[],
) {
  const fields = new Set([
    "modules",
    "lessons",
    "objectives",
    "resources",
    "practicalActivities",
    "assignmentTemplates",
    "assessmentTemplates",
    "questions",
    "programme",
    "curriculumVersion",
    "schedulingDefaults",
    "agentConfiguration",
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
    "key",
    "position",
    "title",
    "description",
    "body",
    "url",
    "kind",
    "objectiveRefs",
    "lessonRef",
    "capabilities",
    "enabled",
    "modelProfileRef",
    "instructionalNotes",
    "escalationPolicy",
    "label",
    "studyDays",
    "localStartTime",
    "timezone",
    "expectedAnswer",
    "markingGuidance",
    "questionType",
    "interaction",
    "answerKey",
    "options",
    "items",
    "targets",
    "steps",
    "fields",
    "scenario",
    "requiredSelections",
    "scoringRule",
    "allowTargetReuse",
    "correctOptionId",
    "correctOptionIds",
    "mapping",
    "correctOrder",
    "values",
    "id",
    "prompt",
    "maxMarks",
    "durationMinutes",
    "attemptsAllowed",
    "schemaVersion",
    "packageKey",
    "packageRevision",
    "reason",
  ]);
  return issues.slice(0, 20).map((issue) => {
    const parts = issue.path.replace(/\[(\d+)\]/g, ".$1").split(".");
    const path =
      parts.length <= 12 &&
      parts.every((p) => fields.has(p) || /^\d{1,5}$/.test(p))
        ? parts.join(".")
        : "package";
    const hint =
      issue.code === "DUPLICATE_KEY"
        ? "Duplicate key"
        : issue.code === "DUPLICATE_POSITION"
          ? "Duplicate position"
          : issue.code === "UNKNOWN_REFERENCE"
            ? "Unknown reference"
            : "Invalid structure or reference";
    return `${path}: ${hint}. Check the COURSE_PACKAGE_V1 contract.`;
  });
}
