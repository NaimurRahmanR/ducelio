import "server-only";
import { createHash } from "node:crypto";
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
import {
  listAcademyPackages,
  validateAcademyPackage,
} from "./academy-course-engineering";
import type { AcademyPackageListItem } from "@/domain/academy-delivery";
import { canonicalJson } from "@/domain/unified-course-lifecycle";
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
// upload_organisation_course_package (migration 070) namespaces an external
// organisation's source key on its first upload; these are the stored keys a
// file's key can occupy within that organisation.
export function storedKeyCandidates(sourceKey: string, organisationId: string) {
  if (organisationId === DUCELIO_ORGANISATION) return [sourceKey];
  return [
    sourceKey,
    "org-" +
      createHash("sha256")
        .update(`${organisationId}:${sourceKey}`)
        .digest("hex"),
  ];
}

export type UploadCheck =
  | { status: "INVALID"; issues: string[] }
  | {
      status: "ALREADY_UPLOADED";
      packageId: string;
      packageKey: string;
      revision: number;
      packageStatus: AcademyPackageListItem["status"];
    }
  | {
      status: "REVISION_TAKEN";
      packageKey: string;
      revision: number;
      existingStatus: string;
      existingId: string | null;
      latestRevision: number;
      nextRevision: number;
    }
  | {
      status: "READY";
      packageKey: string;
      revision: number;
      title: string;
      pendingDecisions: number;
      latestRevision: number | null;
    };

// Pre-write upload check: the authoritative validator plus the caller's own
// registers, so an invalid file or an occupied revision creates no record.
// The database still decides; this only prevents avoidable failed records
// and explains a conflict with the revisions that actually exist.
export async function checkUnifiedCoursePackageUpload(
  raw: unknown,
  organisationId: string,
): Promise<UploadCheck> {
  const org = z.uuid().parse(organisationId);
  const checked = validateAcademyCoursePackage(raw);
  if (!checked.valid)
    return {
      status: "INVALID",
      issues: checked.errors
        .slice(0, 50)
        .map((e) => `${e.path || "package"} — ${e.message}`),
    };
  const pkg = checked.package;
  const keys = storedKeyCandidates(pkg.packageKey, org);
  const unified = (await listUnifiedCoursePackages()).filter(
    (p) => p.organisationId === org && keys.includes(p.packageKey),
  );
  // Revisions stored before organisation ownership (for example a legacy
  // published revision) are visible to course administrators only.
  const legacy =
    org === DUCELIO_ORGANISATION
      ? (await listAcademyPackages().catch(() => [])).filter(
          (p) =>
            p.packageKey === pkg.packageKey &&
            !unified.some((u) => u.id === p.id),
        )
      : [];
  const all = [...unified, ...legacy];
  const latest = all.length
    ? Math.max(...all.map((p) => p.packageRevision))
    : null;
  const same = all.find((p) => p.packageRevision === pkg.packageRevision);
  if (same) {
    if (unified.some((u) => u.id === same.id)) {
      const stored = await getUnifiedRevisionSource(same.id);
      const candidate =
        same.packageKey === pkg.packageKey
          ? raw
          : {
              ...pkg,
              packageKey: same.packageKey,
              curriculum: { ...pkg.curriculum, packageKey: same.packageKey },
            };
      if (canonicalJson(stored) === canonicalJson(candidate))
        return {
          status: "ALREADY_UPLOADED",
          packageId: same.id,
          packageKey: same.packageKey,
          revision: same.packageRevision,
          packageStatus: same.status,
        };
    }
    return {
      status: "REVISION_TAKEN",
      packageKey: same.packageKey,
      revision: same.packageRevision,
      existingStatus: same.status,
      existingId: unified.some((u) => u.id === same.id) ? same.id : null,
      latestRevision: latest!,
      nextRevision: latest! + 1,
    };
  }
  return {
    status: "READY",
    packageKey: pkg.packageKey,
    revision: pkg.packageRevision,
    title: checked.review.title,
    pendingDecisions: checked.review.pendingDecisions.length,
    latestRevision: latest,
  };
}

export const describeUploadConflict = (
  c: Extract<UploadCheck, { status: "REVISION_TAKEN" }>,
) =>
  `Revision ${c.revision} of ${c.packageKey} already exists (${c.existingStatus.toLowerCase()}) with different content. Stored revisions are never overwritten. The latest revision is ${c.latestRevision}: set "packageRevision" to ${c.nextRevision} in the file and upload it again, or correct the course through its review.`;

// Publication preconditions read from the recorded package, before anything
// is written. publish_unified_course enforces the same rules itself.
export async function getUnifiedPublicationGate(packageId: string) {
  const id = z.uuid().parse(packageId);
  const p = (await listUnifiedCoursePackages()).find((x) => x.id === id);
  if (!p) return { ok: false as const, code: "NOT_FOUND" as const };
  if (p.status === "PUBLISHED")
    return { ok: true as const, package: p, published: true };
  if (p.status !== "VALIDATED")
    return { ok: false as const, code: "INVALID_STATE" as const, package: p };
  if (p.pendingDecisions.length)
    return {
      ok: false as const,
      code: "POLICY_PENDING" as const,
      package: p,
      pending: p.pendingDecisions,
    };
  return { ok: true as const, package: p, published: false };
}

// Decision-only academic resolution: the next revision is derived on the
// server from the stored revision with only the named decisions removed, so
// no content changes and the browser never sends the package back. Authority
// (organisation REVIEW), evidence and immutability are enforced by
// revise_unified_course_package.
export async function resolveUnifiedCourseDecisions(input: unknown) {
  const p = z
    .strictObject({
      sourceId: z.uuid(),
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
        .min(1)
        .max(50),
    })
    .parse(input);
  const register = await listUnifiedCoursePackages();
  const source = register.find((x) => x.id === p.sourceId);
  if (!source) throw new AcademyError("NOT_FOUND");
  const newer = register
    .filter(
      (x) =>
        x.packageKey === source.packageKey &&
        x.organisationId === source.organisationId &&
        x.packageRevision > source.packageRevision,
    )
    .sort((a, b) => b.packageRevision - a.packageRevision)[0];
  if (newer) return { ok: false as const, code: "NEWER_REVISION", newer };
  const stored = validateAcademyCoursePackage(
    await getUnifiedRevisionSource(source.id),
  );
  if (!stored.valid) throw new AcademyError("MALFORMED_PACKAGE");
  const pending = new Set(stored.package.pendingDecisions.map((d) => d.key));
  const keys = p.resolutions.map((r) => r.key);
  if (new Set(keys).size !== keys.length || keys.some((k) => !pending.has(k)))
    throw new AcademyError("INVALID_INPUT");
  const raw = structuredClone(stored.package);
  raw.packageRevision += 1;
  raw.curriculum.packageRevision = raw.packageRevision;
  raw.pendingDecisions = raw.pendingDecisions.filter(
    (d) => !keys.includes(d.key),
  );
  const result = await reviseUnifiedCoursePackage({
    sourceId: source.id,
    raw,
    resolutions: p.resolutions,
    requestKey: p.requestKey,
    reason: p.reason,
  });
  if (!result.valid) throw new AcademyError("MALFORMED_PACKAGE");
  return { ok: true as const, packageId: result.packageId };
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
