import "server-only";
import { z } from "zod";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
import {
  AcademyError,
  academyErrorCode,
  academyPackageListSchema,
} from "@/domain/academy-delivery";
import {
  courseAgentsSchema,
  unifiedPublicationResultSchema,
  unifiedPublicationSchema,
} from "@/domain/unified-course-engine";
import { validateAcademyPackage } from "./academy-course-engineering";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import { academyCatalogueSchema } from "@/domain/academy-delivery";
import { config } from "@/lib/env";

async function clientForAdmin() {
  const actor = await getAuthenticatedActor();
  if (
    !actor?.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new AcademyError("FORBIDDEN");
  return createSupabase();
}

export async function publishUnifiedCourse(input: unknown) {
  const client = await clientForAdmin();
  const p = unifiedPublicationSchema.parse(input);
  const { data, error } = await client.rpc("publish_unified_course", {
    p_package_id: p.packageId,
    p_offer_slug: p.slug,
    p_currency: p.currency,
    p_amount_minor: p.amountMinor,
    p_summary: p.summary,
    p_reason: p.reason,
  });
  if (error) {
    // Only bounded policy codes can reach the operator; no raw SQL or content.
    const code = error.message.split(":")[0];
    if (
      [
        "POLICY_PENDING",
        "RUBRIC_PENDING",
        "TEST_GATE_NOT_SATISFIED",
        "PUBLICATION_CONFLICT",
      ].includes(code)
    )
      throw new Error(code);
    throw new AcademyError(academyErrorCode(code));
  }
  return unifiedPublicationResultSchema.parse(data);
}

export async function uploadUnifiedCoursePackage(raw: unknown, reason: string) {
  const client = await clientForAdmin();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new AcademyError("MALFORMED_PACKAGE");
  const { data, error } = await client.rpc("upload_unified_course_package", {
    p_raw_package: raw,
    p_reason: z.string().trim().min(5).max(300).parse(reason),
  });
  if (error) throw new AcademyError(academyErrorCode(error.message));
  return z.uuid().parse(data);
}

export async function listUnifiedCoursePackages() {
  const client = await clientForAdmin();
  const { data, error } = await client.rpc("list_unified_course_packages");
  if (error) throw new AcademyError(academyErrorCode(error.message));
  return academyPackageListSchema.parse(data);
}

// Package history is immutable. Configuring a draft creates a new revision,
// with its own validation and curriculum/agent fingerprint. Published or
// enrolled configurations are never rewritten.
export async function configureUnifiedCourseAgents(
  packageId: unknown,
  configuration: unknown,
  reason: string,
) {
  const client = await clientForAdmin();
  const id = z.uuid().parse(packageId);
  const agents = courseAgentsSchema.parse(configuration);
  const { data, error } = await client.rpc(
    "get_academy_course_package_content",
    { p_package_id: id },
  );
  if (error) throw new AcademyError(academyErrorCode(error.message));
  const source = validateAcademyCoursePackage(data);
  if (!source.valid) throw new AcademyError("MALFORMED_PACKAGE");
  if (
    JSON.stringify(
      courseAgentsSchema.parse(data.curriculum.agentConfiguration),
    ) === JSON.stringify(agents)
  )
    return id;
  const raw = structuredClone(data) as Record<string, unknown> & {
    packageRevision: number;
    curriculum: Record<string, unknown> & {
      curriculumVersion: Record<string, unknown>;
    };
  };
  raw.packageRevision += 1;
  raw.curriculum.packageRevision = raw.packageRevision;
  raw.curriculum.agentConfiguration = agents;
  raw.curriculum.curriculumVersion.label = `${source.review.title.slice(0, 140)} · revision ${raw.packageRevision}`;
  const checked = validateAcademyCoursePackage(raw);
  if (!checked.valid) throw new AcademyError("MALFORMED_PACKAGE");
  const nextId = await uploadUnifiedCoursePackage(raw, reason);
  const next = await client.rpc("get_academy_course_package_review", {
    p_package_id: nextId,
  });
  if (next.error) throw new AcademyError(academyErrorCode(next.error.message));
  if (next.data?.status === "UPLOADED") {
    const validated = await validateAcademyPackage(nextId, reason);
    if (!validated.valid) throw new AcademyError("MALFORMED_PACKAGE");
  } else if (!["VALIDATED", "PUBLISHED"].includes(next.data?.status))
    throw new AcademyError("INVALID_STATE");
  return nextId;
}

export async function getUnifiedCourseAgents(packageId: string) {
  const client = await clientForAdmin();
  const { data, error } = await client.rpc(
    "get_academy_course_package_content",
    { p_package_id: z.uuid().parse(packageId) },
  );
  if (error) throw new AcademyError(academyErrorCode(error.message));
  return courseAgentsSchema.parse(data?.curriculum?.agentConfiguration);
}

export async function listUnifiedCourseCatalogue() {
  if (!config().configured) throw new AcademyError("SERVICE_UNAVAILABLE");
  const { data, error } = await (
    await createSupabase()
  ).rpc("list_unified_course_catalogue");
  if (error) throw new AcademyError("SERVICE_UNAVAILABLE");
  return academyCatalogueSchema.parse(data);
}
