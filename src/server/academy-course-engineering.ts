import "server-only";
import { z } from "zod";
import {
  validateAcademyCoursePackage,
  type AcademyValidationResult,
} from "@/domain/academy-course-package";
import {
  AcademyError,
  academyErrorCode,
  academyPackageListSchema,
  grantInputSchema,
  isMissingDatabaseDependency,
  labReviewListSchema,
  publishInputSchema,
} from "@/domain/academy-delivery";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
import {
  applyCoursePackage,
  importCoursePackage,
  publishCoursePackage,
  runCoursePackageTest,
  validateStagedCoursePackage,
} from "./course-engineering";
import { setAgentConfig } from "./academic-agent-config";
import { agentConfigurationSchema } from "@/domain/course-package";

// Ducelio Academy (B2C) Course Engineering: upload -> validate -> review ->
// publish. Separate from the organisation workflow in course-engineering.ts
// and course-activation.ts, which are reused, not changed: the embedded
// COURSE_PACKAGE_V1 curriculum goes through the existing import, validate,
// apply, agent configuration, pre-publication test and publish authorities.
// Academy publication then needs no cohort, instructor, activation or
// manual assessment/lab setup. Every RPC re-checks the role in the database.
async function adminRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const actor = await getAuthenticatedActor();
  if (
    !actor?.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new AcademyError("FORBIDDEN");
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error && isMissingDatabaseDependency(error)) {
    // Server log only: the RPC name and bounded error code, never the
    // message, arguments or connection details.
    console.warn(
      "[ducelio:academy-readiness]",
      JSON.stringify({ rpc: name, errorCode: error.code }),
    );
    throw new AcademyError("NOT_INSTALLED");
  }
  if (error) throw new AcademyError(academyErrorCode(error.message));
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AcademyError("SERVICE_UNAVAILABLE");
  return parsed.data;
}

export const listAcademyPackages = () =>
  adminRpc("list_academy_course_packages", {}, academyPackageListSchema);

export const getAcademyPackageReview = (packageId: string) =>
  adminRpc(
    "get_academy_course_package_review",
    { p_package_id: z.uuid().parse(packageId) },
    z.object({
      id: z.uuid(),
      status: z.string(),
      review: z.unknown().nullable(),
    }),
  );

export function uploadAcademyPackage(raw: unknown, reason: string) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new AcademyError("MALFORMED_PACKAGE");
  return adminRpc(
    "upload_academy_course_package",
    { p_raw_package: raw, p_reason: reason },
    z.uuid(),
  );
}

// Deterministic: re-reads exactly what was stored and runs the pure domain
// validator over it. A valid package records its review summary (no
// answers); an invalid one is rejected with its first issue, and the full
// actionable issue list is returned to the administrator only.
export async function validateAcademyPackage(
  packageId: string,
  reason: string,
): Promise<AcademyValidationResult> {
  const id = z.uuid().parse(packageId);
  const content = await adminRpc(
    "get_academy_course_package_content",
    { p_package_id: id },
    z.unknown(),
  );
  const result = validateAcademyCoursePackage(content);
  if (result.valid)
    await adminRpc(
      "mark_academy_course_package_validated",
      { p_package_id: id, p_review: result.review, p_reason: reason },
      z.uuid(),
    );
  else
    await adminRpc(
      "reject_academy_course_package",
      {
        p_package_id: id,
        p_reason:
          `Validation failed: ${result.errors[0]?.message ?? "invalid package"}`.slice(
            0,
            300,
          ),
      },
      z.uuid(),
    );
  return result;
}

export const rejectAcademyPackage = (packageId: string, reason: string) =>
  adminRpc(
    "reject_academy_course_package",
    { p_package_id: z.uuid().parse(packageId), p_reason: reason },
    z.uuid(),
  );

// Drives the embedded curriculum through the existing, unchanged pipeline.
// Each step is idempotent and resumes from the curriculum's recorded state,
// so a retry after a partial failure repeats nothing that already happened.
export async function prepareAcademyCurriculum(
  packageId: string,
  reason: string,
) {
  const id = z.uuid().parse(packageId);
  const find = async () =>
    (await listAcademyPackages()).find((p) => p.id === id);
  const pkg = await find();
  if (!pkg || pkg.status !== "VALIDATED")
    throw new AcademyError("INVALID_STATE");
  const curriculum = await adminRpc(
    "get_academy_course_package_curriculum",
    { p_package_id: id },
    z.record(z.string(), z.unknown()),
  );
  let state = pkg.curriculumImport;
  let importId = state?.id;
  if (!importId) importId = await importCoursePackage(curriculum, reason);
  if (!state || state.status === "IMPORTED") {
    const validation = await validateStagedCoursePackage(importId, reason);
    if (!validation.valid) throw new AcademyError("MALFORMED_PACKAGE");
  }
  state = (await find())?.curriculumImport ?? null;
  if (state?.status === "VALIDATED") await applyCoursePackage(importId, reason);
  state = (await find())?.curriculumImport ?? null;
  if (state?.status === "APPLIED" && state.programmeVersionId) {
    const agents = agentConfigurationSchema.parse(
      curriculum.agentConfiguration,
    );
    for (const [role, cfg] of Object.entries(agents))
      await setAgentConfig({
        programmeVersionId: state.programmeVersionId,
        role,
        enabled: cfg.enabled,
        modelProfileRef: cfg.modelProfileRef,
        instructionalNotes: cfg.instructionalNotes,
        capabilities: cfg.capabilities,
        escalationPolicy: cfg.escalationPolicy,
        reason,
      });
    const test = await runCoursePackageTest(importId, reason);
    if (test.outcome !== "PASS")
      return {
        ok: false as const,
        failureCode: test.failureCode,
        failedRoles: test.failedRoles,
      };
    await publishCoursePackage(importId, reason);
  }
  state = (await find())?.curriculumImport ?? null;
  return state?.status === "PUBLISHED"
    ? { ok: true as const }
    : {
        ok: false as const,
        failureCode: state?.status ?? null,
        failedRoles: [],
      };
}

export function publishAcademyCourse(input: unknown) {
  const p = publishInputSchema.parse(input);
  return adminRpc(
    "publish_academy_course",
    {
      p_package_id: p.packageId,
      p_offer_slug: p.slug,
      p_currency: p.currency,
      p_summary: p.summary,
      p_prices: p.prices,
      p_reason: p.reason,
    },
    z.uuid(),
  );
}

export const archiveAcademyOffer = (offerId: string, reason: string) =>
  adminRpc(
    "archive_academy_offer",
    { p_offer_id: z.uuid().parse(offerId), p_reason: reason },
    z.uuid(),
  );

export function grantAcademyEntitlement(input: unknown) {
  const p = grantInputSchema.parse(input);
  return adminRpc(
    "grant_academy_entitlement",
    {
      p_offer_id: p.offerId,
      p_learner_email: p.email,
      p_format_id: p.formatId,
      p_reason: p.reason,
    },
    z.uuid(),
  );
}

export const listAcademyLabSubmissions = () =>
  adminRpc("list_academy_lab_submissions_for_review", {}, labReviewListSchema);

export const markAcademyLabSubmission = (
  submissionId: string,
  marks: Record<string, number>,
  reason: string,
) =>
  adminRpc(
    "mark_academy_lab_submission",
    {
      p_submission_id: z.uuid().parse(submissionId),
      p_criterion_marks: marks,
      p_reason: reason,
    },
    z.object({
      ok: z.literal(true),
      marks: z.number().int(),
      maxMarks: z.number().int(),
    }),
  );

export const enableAcademyPublicSale = (
  offerId: string,
  confirmed: boolean,
  reason: string,
) =>
  adminRpc(
    "enable_academy_public_sale",
    {
      p_offer_id: z.uuid().parse(offerId),
      p_owner_approval_confirmed: confirmed,
      p_reason: reason,
    },
    z.object({
      ok: z.boolean(),
      code: z.string().optional(),
      pending: z.array(z.string()).optional(),
      replayed: z.boolean().optional(),
    }),
  );

export const revokeAcademyEntitlement = (
  entitlementId: string,
  reason: string,
) =>
  adminRpc(
    "admin_revoke_academy_entitlement",
    { p_entitlement_id: z.uuid().parse(entitlementId), p_reason: reason },
    z.object({ ok: z.boolean(), code: z.string() }),
  );
