"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveUnifiedCourseDecisions } from "@/server/unified-course-engine";
import { AcademyError, ACADEMY_ERROR_TEXT } from "@/domain/academy-delivery";

export type DecisionReviewState = {
  error?: string;
  message?: string;
  packageId?: string;
};

// Records human resolutions for selected pending decisions as a new revision.
// Nothing is pre-selected or inferred: each decision needs its own explicit
// selection, evidence reference and rationale, plus the reviewer's
// attestation. The database requires organisation REVIEW authority.
export async function resolveDecisionsAction(
  _state: DecisionReviewState,
  form: FormData,
): Promise<DecisionReviewState> {
  try {
    const keys = form
      .getAll("decision")
      .map(String)
      .filter((k) => k.length > 0);
    if (!keys.length)
      return { error: "Select at least one decision that has been reviewed." };
    if (form.get("attest") !== "on")
      return {
        error:
          "Attest that each selected decision was actually reviewed and approved by an authorised person. Nothing was recorded.",
      };
    const result = await resolveUnifiedCourseDecisions({
      sourceId: form.get("sourceId"),
      requestKey: form.get("requestKey"),
      reason: form.get("reason"),
      resolutions: keys.map((key) => ({
        key,
        evidenceReference: String(form.get(`evidence_${key}`) ?? ""),
        rationale: String(form.get(`rationale_${key}`) ?? ""),
      })),
    });
    if (!result.ok)
      return {
        packageId: result.newer.id,
        error: `Revision ${result.newer.packageRevision} of this course already exists. Review decisions on the latest revision; earlier revisions are never changed.`,
      };
    revalidatePath("/admin/course-engineering", "layout");
    return {
      packageId: result.packageId,
      message: `Recorded ${keys.length} reviewed decision${keys.length === 1 ? "" : "s"} as a new revision. Its content is unchanged apart from the resolved decisions.`,
    };
  } catch (e) {
    if (e instanceof z.ZodError)
      return {
        error:
          "Each selected decision needs an evidence reference of 10–300 characters and a rationale of 20–1000 characters, plus a reason for the record.",
      };
    if (e instanceof AcademyError)
      return {
        error:
          e.code === "INVALID_INPUT"
            ? "Only decisions pending on this revision can be resolved. Reload the review."
            : ACADEMY_ERROR_TEXT[e.code],
      };
    const code = e instanceof Error ? e.message : "";
    return {
      error:
        code === "ACADEMIC_EVIDENCE_REQUIRED"
          ? "The database refused the resolution: your account needs academic review authority in this organisation, and every decision needs evidence and rationale."
          : code === "REQUEST_CONFLICT"
            ? "This form was already submitted with different details. Reload the review before trying again."
            : code === "REVISION_CONFLICT"
              ? "A newer revision of this course already exists. Reload the review and use the latest revision."
              : "The resolution was refused and nothing was recorded. Reload the review to check its current state.",
    };
  }
}
