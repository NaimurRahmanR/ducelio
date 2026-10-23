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
import { DUCELIO_ORGANISATION } from "./course-organisations";
import { config } from "@/lib/env";

async function clientForAdmin() {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AcademyError("FORBIDDEN");
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

export async function uploadUnifiedCoursePackage(
  raw: unknown,
  reason: string,
  organisationId = DUCELIO_ORGANISATION,
) {
  const client = await clientForAdmin();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new AcademyError("MALFORMED_PACKAGE");
  const { data, error } = await client.rpc(
    "upload_organisation_course_package",
    {
      p_organisation_id: z.uuid().parse(organisationId),
      p_raw_package: raw,
      p_reason: z.string().trim().min(5).max(300).parse(reason),
    },
  );
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
  const ownership = await client.rpc("get_unified_package_organisation", {
    p_package_id: id,
  });
  if (ownership.error) throw new AcademyError("FORBIDDEN");
  const nextId = await uploadUnifiedCoursePackage(
    raw,
    reason,
    z.uuid().parse(ownership.data),
  );
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

// Restricted source for the operator's revision editor. Never used by learner
// projections or teaching context builders (it contains protected assessments).
export async function getUnifiedRevisionSource(packageId: string) {
  const client = await clientForAdmin();
  const { data, error } = await client.rpc(
    "get_academy_course_package_content",
    { p_package_id: z.uuid().parse(packageId) },
  );
  if (error) throw new AcademyError(academyErrorCode(error.message));
  return data as Record<string, unknown>;
}
export async function reviseUnifiedCoursePackage(input: unknown) {
  const client = await clientForAdmin();
  const p = z
    .strictObject({
      sourceId: z.uuid(),
      raw: z.unknown(),
      requestKey: z.uuid(),
      reason: z.string().trim().min(5).max(300),
      resolutions: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(80),
            evidenceReference: z.string().trim().min(10).max(300),
            rationale: z.string().trim().min(20).max(1000),
          }),
        )
        .max(50),
    })
    .parse(input);
  const checked = validateAcademyCoursePackage(p.raw);
  if (!checked.valid)
    return {
      valid: false as const,
      issues: checked.errors.slice(0, 50).map((e) => `${e.path}: ${e.message}`),
    };
  const { data, error } = await client.rpc("revise_unified_course_package", {
    p_source_id: p.sourceId,
    p_raw_package: p.raw,
    p_resolutions: p.resolutions,
    p_review: checked.review,
    p_request_key: p.requestKey,
    p_reason: p.reason,
  });
  if (error)
    throw new Error(
      [
        "ACADEMIC_EVIDENCE_REQUIRED",
        "REVISION_CONFLICT",
        "REQUEST_CONFLICT",
      ].includes(error.message)
        ? error.message
        : "REVISION_REFUSED",
    );
  return { valid: true as const, packageId: z.uuid().parse(data) };
}
export async function getUnifiedAcademicResolutions(packageId: string) {
  const client = await clientForAdmin();
  const { data, error } = await client.rpc("get_unified_academic_resolutions", {
    p_package_id: z.uuid().parse(packageId),
  });
  if (error) throw new AcademyError("SERVICE_UNAVAILABLE");
  return z
    .array(
      z.object({
        key: z.string(),
        evidenceReference: z.string(),
        rationale: z.string(),
        reviewedBy: z.uuid(),
        reviewedAt: z.string(),
      }),
    )
    .parse(data);
}

export async function listUnifiedCourseCatalogue() {
  if (!config().configured) throw new AcademyError("SERVICE_UNAVAILABLE");
  const { data, error } = await (
    await createSupabase()
  ).rpc("list_unified_course_catalogue");
  if (error) throw new AcademyError("SERVICE_UNAVAILABLE");
  return academyCatalogueSchema.parse(data);
}
