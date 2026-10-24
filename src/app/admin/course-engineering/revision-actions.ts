"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  getUnifiedRevisionSource,
  reviseUnifiedCoursePackage,
} from "@/server/unified-course-engine";
import { academyUploadSizeError } from "@/domain/academy-delivery";
import type { AcademyAdminState } from "../academy-course-engineering/actions";
export async function reviseCourseAction(
  _state: AcademyAdminState,
  form: FormData,
): Promise<AcademyAdminState> {
  try {
    const sourceId = z.uuid().parse(form.get("sourceId"));
    const source = await getUnifiedRevisionSource(sourceId);
    const text = String(form.get("rawPackage") ?? "");
    const tooLarge = academyUploadSizeError(
      new TextEncoder().encode(text).length,
    );
    if (tooLarge) return { error: tooLarge };
    const raw = JSON.parse(text);
    const pending = z
      .array(z.object({ key: z.string(), summary: z.string() }))
      .parse(source.pendingDecisions);
    const selected = pending.filter(
      (d) => form.get(`resolve_${d.key}`) === "on",
    );
    if (selected.length && form.get("attest") !== "on")
      return {
        error:
          "Attest that the named decisions were actually reviewed and approved by an authorised human.",
      };
    const resolutions = selected.map((d) => ({
      key: d.key,
      evidenceReference: form.get(`evidence_${d.key}`),
      rationale: form.get(`rationale_${d.key}`),
    }));
    if (!Array.isArray(raw.pendingDecisions))
      return { error: "Keep pendingDecisions as an array." };
    raw.pendingDecisions = raw.pendingDecisions.filter(
      (d: { key: string }) => !selected.some((s) => s.key === d.key),
    );
    const result = await reviseUnifiedCoursePackage({
      sourceId,
      raw,
      resolutions,
      requestKey: form.get("requestKey"),
      reason: form.get("reason"),
    });
    if (!result.valid)
      return {
        error:
          "The revised package failed validation. Correct these findings; nothing was published.",
        issues: result.issues,
      };
    revalidatePath("/admin/course-engineering");
    return {
      packageId: result.packageId,
      message:
        "Validated revision recorded with human review evidence. Review its price and agents before publishing.",
    };
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message === "ACADEMIC_EVIDENCE_REQUIRED"
          ? "Every removed decision requires recorded human evidence and rationale."
          : "Revision refused. Check the JSON, revision number, review authority, evidence and request details.",
    };
  }
}
