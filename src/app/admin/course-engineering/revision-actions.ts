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
    // Fails unless the caller can read this revision.
    await getUnifiedRevisionSource(sourceId);
    const text = String(form.get("rawPackage") ?? "");
    const tooLarge = academyUploadSizeError(
      new TextEncoder().encode(text).length,
    );
    if (tooLarge) return { error: tooLarge };
    const raw = JSON.parse(text);
    // Content-only revision: academic decisions are resolved with evidence
    // in Course academic review. Removing one here is refused by the database.
    if (!Array.isArray(raw.pendingDecisions))
      return { error: "Keep pendingDecisions as an array." };
    const result = await reviseUnifiedCoursePackage({
      sourceId,
      raw,
      resolutions: [],
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
        "Validated content revision recorded. Pending academic decisions are unchanged.",
    };
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message === "ACADEMIC_EVIDENCE_REQUIRED"
          ? "A pending academic decision was removed from the JSON. Keep pendingDecisions unchanged here and resolve decisions in Course academic review."
          : "Revision refused. Check the JSON, revision number, review authority, evidence and request details.",
    };
  }
}
