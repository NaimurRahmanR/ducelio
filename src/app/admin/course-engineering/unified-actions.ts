"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  configureUnifiedCourseAgents,
  getUnifiedCourseAgents,
  publishUnifiedCourse,
} from "@/server/unified-course-engine";
import {
  parseCoursePrice,
  unifiedPublicationSchema,
} from "@/domain/unified-course-engine";
import { AcademyError, ACADEMY_ERROR_TEXT } from "@/domain/academy-delivery";
import type { AcademyAdminState } from "../academy-course-engineering/actions";

export async function publishUnifiedAction(
  _state: AcademyAdminState,
  form: FormData,
): Promise<AcademyAdminState> {
  try {
    const summary = String(form.get("summary") ?? "").trim();
    const input = unifiedPublicationSchema.parse({
      packageId: form.get("packageId"),
      slug: form.get("slug"),
      currency: form.get("currency"),
      amountMinor: parseCoursePrice(form.get("price")),
      summary: summary || null,
      reason: form.get("reason"),
    });
    if (form.get("confirm") !== "on")
      return {
        error:
          "Confirm the course policy, agent configuration and selling price before publishing.",
      };
    const agents = await getUnifiedCourseAgents(input.packageId);
    for (const role of Object.keys(agents) as (keyof typeof agents)[]) {
      agents[role].enabled = form.get(`${role}_enabled`) === "on";
      agents[role].modelProfileRef =
        String(form.get(`${role}_profile`) ?? "").trim() || null;
      agents[role].instructionalNotes =
        String(form.get(`${role}_notes`) ?? "").trim() || null;
      // Capabilities stay within the package's reviewed proposal and may be
      // narrowed here. The domain and DB independently enforce their allowlist.
      agents[role].capabilities = agents[role].capabilities.filter(
        (c) => form.get(`${role}_capability_${c}`) === "on",
      );
    }
    const packageId = await configureUnifiedCourseAgents(
      input.packageId,
      agents,
      input.reason,
    );
    const result = await publishUnifiedCourse({ ...input, packageId });
    revalidatePath("/admin/course-engineering");
    revalidatePath("/courses");
    return {
      packageId,
      message: result.replayed
        ? "This course was already published with these exact terms."
        : "Course published. One price applies to every supported duration; learners choose their timetable after purchase.",
    };
  } catch (error) {
    if (error instanceof AcademyError)
      return { error: ACADEMY_ERROR_TEXT[error.code] };
    if (error instanceof z.ZodError)
      return {
        error: "Check the price, currency and agent profiles.",
        issues: error.issues
          .slice(0, 10)
          .map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    const messages: Record<string, string> = {
      POLICY_PENDING:
        "Resolve the pending academic decisions in the course package and upload a revised package.",
      RUBRIC_PENDING:
        "A graded practical needs an approved rubric and marking guidance in the course package.",
      TEST_GATE_NOT_SATISFIED:
        "The curriculum and agent pre-publication checks failed. Review the package agent profiles and capabilities before retrying.",
      PUBLICATION_CONFLICT:
        "This revision was already published with different commercial terms. Use its recorded terms or upload a new revision.",
      INVALID_PRICE: "Enter a positive price with at most two decimal places.",
    };
    return {
      error:
        messages[error instanceof Error ? error.message : ""] ??
        "Publication could not be completed. Reload the course to check its current state before retrying.",
    };
  }
}
