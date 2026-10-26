import type { AcademyPackageListItem } from "./academy-delivery";

// One stage per stored package revision, derived only from recorded state.
// The curriculum is imported and tested inside publish_unified_course, so a
// validated revision that has no curriculum import is waiting for review or
// publication, not failing.
export type CourseStage =
  | "UPLOADED"
  | "AWAITING_REVIEW"
  | "APPROVED_FOR_PUBLICATION"
  | "PUBLICATION_INCOMPLETE"
  | "PUBLISHED"
  | "FAILED";

export type CourseStageView = {
  stage: CourseStage;
  label: string;
  detail: string;
  tone: "good" | "neutral" | "warn" | "bad";
};

type StageInput = Pick<
  AcademyPackageListItem,
  "status" | "pendingDecisions" | "curriculumImport" | "rejectedReason"
>;

export function courseStage(p: StageInput): CourseStageView {
  if (p.status === "REJECTED")
    return {
      stage: "FAILED",
      label: "Failed validation",
      detail: p.rejectedReason
        ? `${p.rejectedReason} Correct the file and upload it as a new revision.`
        : "Correct the file and upload it as a new revision.",
      tone: "bad",
    };
  if (p.status === "UPLOADED")
    return {
      stage: "UPLOADED",
      label: "Uploaded",
      detail:
        "Stored, but structural validation has not been recorded. Upload the identical file again to record it; identical re-uploads are safe.",
      tone: "warn",
    };
  if (p.status === "PUBLISHED")
    return {
      stage: "PUBLISHED",
      label: "Published",
      detail:
        "Curriculum imported, pre-publication checks passed and the course was created.",
      tone: "good",
    };
  const pending = p.pendingDecisions.length;
  if (pending > 0)
    return {
      stage: "AWAITING_REVIEW",
      label: "Structurally validated · awaiting academic review",
      detail: `${pending} academic decision${pending === 1 ? "" : "s"} must be resolved by an authorised reviewer before publication. The curriculum is imported and tested at publication.`,
      tone: "neutral",
    };
  if (p.curriculumImport && p.curriculumImport.status !== "PUBLISHED")
    return {
      stage: "PUBLICATION_INCOMPLETE",
      label: "Publication checks incomplete",
      detail: `A curriculum import exists in state ${p.curriculumImport.status.toLowerCase()}. Retry publication; completed steps are not repeated.`,
      tone: "warn",
    };
  return {
    stage: "APPROVED_FOR_PUBLICATION",
    label: "Approved for publication",
    detail:
      "No academic decision is pending. Publication imports the curriculum, runs the pre-publication checks and lists the course.",
    tone: "good",
  };
}

// Key order-independent JSON, for comparing a file with a stored revision.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
