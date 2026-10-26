"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  archiveAcademyOffer,
  enableAcademyPublicSale,
  grantAcademyEntitlement,
  markAcademyLabSubmission,
  prepareAcademyCurriculum,
  publishAcademyCourse,
  rejectAcademyPackage,
  validateAcademyPackage,
} from "@/server/academy-course-engineering";
import {
  ACADEMY_ERROR_TEXT,
  AcademyError,
  academyUploadSizeError,
} from "@/domain/academy-delivery";
import {
  checkUnifiedCoursePackageUpload,
  describeUploadConflict,
  uploadUnifiedCoursePackage as uploadAcademyPackage,
} from "@/server/unified-course-engine";
import { DUCELIO_ORGANISATION } from "@/server/course-organisations";
import { ACADEMY_FORMAT_IDS } from "@/domain/academy-scheduler";

export type AcademyAdminState = {
  error?: string;
  message?: string;
  issues?: string[];
  packageId?: string;
};

const reasonSchema = z.string().trim().min(5).max(300);
const ROUTE = "/admin/course-engineering";

function failure(e: unknown): AcademyAdminState {
  if (e instanceof AcademyError) return { error: ACADEMY_ERROR_TEXT[e.code] };
  if (e instanceof z.ZodError)
    return { error: "Check the details you entered and try again." };
  return { error: ACADEMY_ERROR_TEXT.SERVICE_UNAVAILABLE };
}
const reasonOf = (data: FormData) => reasonSchema.parse(data.get("reason"));

export async function uploadAndValidateAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const reason = reasonOf(data);
    const file = data.get("package");
    if (
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".json") ||
      file.size === 0
    )
      return { error: "Choose a non-empty .json Academy course package." };
    const tooLarge = academyUploadSizeError(file.size);
    if (tooLarge) return { error: tooLarge };
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
      );
    } catch {
      return {
        error: "The file is not valid UTF-8 JSON. Nothing was uploaded.",
      };
    }
    const organisationId = data.get("organisationId")
      ? z.uuid().parse(data.get("organisationId"))
      : DUCELIO_ORGANISATION;
    // Validate and check the revision before anything is stored, so an
    // invalid file or an occupied revision number never creates a record.
    const check = await checkUnifiedCoursePackageUpload(parsed, organisationId);
    if (check.status === "INVALID")
      return {
        error: `The package failed validation with ${check.issues.length} issue${check.issues.length === 1 ? "" : "s"}. Nothing was stored; correct the file and upload it again.`,
        issues: check.issues,
      };
    if (check.status === "REVISION_TAKEN")
      return {
        packageId: check.existingId ?? undefined,
        error: describeUploadConflict(check),
      };
    const packageId =
      check.status === "ALREADY_UPLOADED"
        ? check.packageId
        : await uploadAcademyPackage(parsed, reason, organisationId);
    if (
      check.status === "ALREADY_UPLOADED" &&
      check.packageStatus !== "UPLOADED"
    )
      return {
        packageId,
        message: `This exact file is already stored as revision ${check.revision} (${check.packageStatus.toLowerCase()}). Nothing new was created; open it below.`,
      };
    let result;
    try {
      result = await validateAcademyPackage(packageId, reason);
    } catch {
      revalidatePath(ROUTE);
      return {
        packageId,
        error:
          "The package was stored but its validation could not be recorded. Upload the identical file again to complete it; identical re-uploads create nothing new.",
      };
    }
    revalidatePath(ROUTE);
    if (!result.valid)
      return {
        packageId,
        error: `The stored package failed the server's validation with ${result.errors.length} issue${result.errors.length === 1 ? "" : "s"} and was rejected. Correct it and upload it as a new revision.`,
        issues: result.errors
          .slice(0, 50)
          .map((e) => `${e.path || "package"} — ${e.message}`),
      };
    return {
      packageId,
      message: `Uploaded and structurally validated as revision ${result.package.packageRevision}. ${result.review.warnings.length} warning${result.review.warnings.length === 1 ? "" : "s"}; ${result.review.pendingDecisions.length} academic decision${result.review.pendingDecisions.length === 1 ? "" : "s"} pending. Open it below.`,
    };
  } catch (e) {
    return failure(e);
  }
}

export async function prepareCurriculumAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const packageId = z.uuid().parse(data.get("packageId"));
    const result = await prepareAcademyCurriculum(packageId, reasonOf(data));
    revalidatePath(ROUTE);
    if (!result.ok)
      return {
        packageId,
        error: `The curriculum pre-publication test did not pass (${result.failureCode ?? "unknown"}${result.failedRoles.length ? `: ${result.failedRoles.join(", ")}` : ""}). Nothing was published.`,
      };
    return {
      packageId,
      message:
        "Curriculum, agent configuration and pre-publication test passed. The course can now be published.",
    };
  } catch (e) {
    return failure(e);
  }
}

export async function publishAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const packageId = z.uuid().parse(data.get("packageId"));
    const prices = ACADEMY_FORMAT_IDS.flatMap((formatId) => {
      if (data.get(`offer_${formatId}`) !== "on") return [];
      const major = String(data.get(`price_${formatId}`) ?? "").trim();
      if (!/^\d{1,7}(\.\d{2})?$/.test(major)) throw new z.ZodError([]);
      return [{ formatId, amountMinor: Math.round(Number(major) * 100) }];
    });
    if (!prices.length)
      return {
        error: "Offer at least one learning format with an approved price.",
      };
    if (data.get("confirm") !== "on")
      return {
        error: "Confirm that the prices are approved commercial terms.",
      };
    const summary = String(data.get("summary") ?? "").trim();
    await publishAcademyCourse({
      packageId,
      slug: String(data.get("slug") ?? "").trim(),
      currency: String(data.get("currency") ?? "")
        .trim()
        .toUpperCase(),
      summary: summary || null,
      prices,
      reason: reasonOf(data),
    });
    revalidatePath(ROUTE);
    revalidatePath("/courses");
    return { packageId, message: "Published to the Academy catalogue." };
  } catch (e) {
    return failure(e);
  }
}

export async function rejectAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    await rejectAcademyPackage(
      z.uuid().parse(data.get("packageId")),
      reasonOf(data),
    );
    revalidatePath(ROUTE);
    return { message: "Package revision rejected." };
  } catch (e) {
    return failure(e);
  }
}

export async function archiveAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    await archiveAcademyOffer(
      z.uuid().parse(data.get("offerId")),
      reasonOf(data),
    );
    revalidatePath(ROUTE);
    revalidatePath("/courses");
    return {
      message:
        "Offer archived. Existing learners keep their access and history.",
    };
  } catch (e) {
    return failure(e);
  }
}

export async function grantAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const format = String(data.get("formatId") ?? "");
    await grantAcademyEntitlement({
      offerId: data.get("offerId"),
      email: String(data.get("email") ?? "").trim(),
      formatId: format === "LEARNER_CHOICE" ? null : format,
      reason: reasonOf(data),
    });
    return {
      message: "Access granted. The learner can now choose their timetable.",
    };
  } catch (e) {
    return failure(e);
  }
}

export async function markLabAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const marks: Record<string, number> = {};
    for (const [key, value] of data.entries())
      if (key.startsWith("mark_"))
        marks[key.slice(5)] = z.coerce
          .number()
          .int()
          .min(0)
          .max(100)
          .parse(value);
    const result = await markAcademyLabSubmission(
      z.uuid().parse(data.get("submissionId")),
      marks,
      reasonOf(data),
    );
    revalidatePath(ROUTE);
    return { message: `Marked ${result.marks}/${result.maxMarks}.` };
  } catch (e) {
    return failure(e);
  }
}

export async function enableSaleAction(
  _s: AcademyAdminState,
  data: FormData,
): Promise<AcademyAdminState> {
  try {
    const result = await enableAcademyPublicSale(
      z.uuid().parse(data.get("offerId")),
      data.get("ownerApproved") === "on",
      reasonOf(data),
    );
    revalidatePath(ROUTE);
    revalidatePath("/courses");
    if (result.ok)
      return {
        message:
          "Public sale is open. The course is in the catalogue and can be bought.",
      };
    if (result.code === "POLICY_PENDING")
      return {
        error: `Academic decisions are still pending: ${(result.pending ?? []).join(", ")}. Publish a revision that resolves them first.`,
      };
    if (result.code === "RUBRIC_PENDING")
      return { error: "A graded practical has no approved rubric yet." };
    return {
      error:
        "Confirm that the owner approved this course's academic policy and prices.",
    };
  } catch (e) {
    return failure(e);
  }
}
