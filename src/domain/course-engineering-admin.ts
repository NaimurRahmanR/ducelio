import { z } from "zod";
import { coursePackageSchema, type AgentConfiguration } from "./course-package";
import {
  agentRoleSchema,
  type AgentConfigRecord,
} from "./academic-agent-config";

export const MAX_COURSE_UPLOAD_BYTES = 512 * 1024;
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
        }),
      )
      .max(100),
  })
  .transform(({ questions, ...metadata }) => ({
    ...metadata,
    questionCount: questions.length,
    totalMarks: questions.reduce((n, q) => n + q.maxMarks, 0),
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
