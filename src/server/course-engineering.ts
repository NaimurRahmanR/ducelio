import "server-only";
import { z } from "zod";
import {
  COURSE_PACKAGE_SCHEMA_VERSION,
  packageKeySchema,
  validateCoursePackage,
  type CoursePackageValidationResult,
} from "@/domain/course-package";
import { AccessDenied } from "@/domain/policy";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

// Commercial V1 Course & Agent Engineering: upload -> validate -> preview ->
// (configure agents, see academic-agent-config.ts) -> publish. This module
// stages/validates/applies/publishes package content through the migration
// 024 RPCs; it never writes institutional curriculum rows directly, and
// publication always reuses the existing publish_programme_version authority.
export class CourseEngineeringError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CourseEngineeringError";
  }
}

const KNOWN_ERRORS: Record<string, string> = {
  "Access denied": "FORBIDDEN",
  "Course package import not found": "NOT_FOUND",
  "A different package already exists for this key and revision":
    "REVISION_CONFLICT",
  "A course package must be validated before it can be applied":
    "INVALID_STATE",
  "A course package must be applied before it can be published":
    "INVALID_STATE",
  "A programme version with this curriculum label already exists for this programme":
    "LABEL_CONFLICT",
  "An applied or published course package cannot be rejected": "INVALID_STATE",
  "Only an imported package can be validated": "INVALID_STATE",
  "Declared package key does not match package content": "MALFORMED_PACKAGE",
  "Declared package revision does not match package content":
    "MALFORMED_PACKAGE",
  "Declared schema version does not match package content": "MALFORMED_PACKAGE",
};

// The database's own course_engineering_private.assert_materializable check
// (called from mark_course_package_validated and again from
// apply_course_package) is a defensive backstop, not the primary UX: the
// TypeScript validateCoursePackage() already enforces a strict superset of
// these invariants before this RPC is ever called in the normal flow. These
// prefixes exist so a genuine DB-side rejection still reads as a malformed-
// package error rather than an opaque SERVICE_UNAVAILABLE.
const MATERIALIZATION_ERROR_PREFIXES = [
  "Package content must be",
  "Unsupported or missing package schema version",
  "Package programme metadata",
  "Package curriculum version metadata",
  "Package must declare",
  "A module ",
  "A module is",
  "Every module",
  "A lesson ",
  "A lesson is",
  "Every lesson",
  "An objective",
  "A learning resource",
];

function mapError(error: { message: string }): never {
  const known = KNOWN_ERRORS[error.message];
  const code =
    known ??
    (MATERIALIZATION_ERROR_PREFIXES.some((prefix) =>
      error.message.startsWith(prefix),
    )
      ? "MALFORMED_PACKAGE"
      : "SERVICE_UNAVAILABLE");
  throw new CourseEngineeringError(
    code,
    "The course package operation could not be completed.",
  );
}

async function requireCourseEngineeringAdmin() {
  const actor = await requireActor("admin");
  if (
    !actor.roles.includes("ACADEMIC_ADMIN") &&
    !actor.roles.includes("PLATFORM_ADMIN")
  ) {
    throw new AccessDenied();
  }
  return actor;
}

// Only the four identity fields are checked before staging; full structural
// and cross-reference validation is the separate, explicit validate step.
const minimalIdentitySchema = z.object({
  packageKey: packageKeySchema,
  packageRevision: z.number().int().positive().max(100000),
  schemaVersion: z.literal(COURSE_PACKAGE_SCHEMA_VERSION),
});

export async function importCoursePackage(
  rawPackage: unknown,
  reason: string,
): Promise<string> {
  await requireCourseEngineeringAdmin();
  if (
    typeof rawPackage !== "object" ||
    rawPackage === null ||
    Array.isArray(rawPackage)
  ) {
    throw new CourseEngineeringError(
      "MALFORMED_PACKAGE",
      "Package content must be a JSON object.",
    );
  }
  const identity = minimalIdentitySchema.safeParse(rawPackage);
  if (!identity.success) {
    throw new CourseEngineeringError(
      "MALFORMED_PACKAGE",
      "A valid package key, positive revision and COURSE_PACKAGE_V1 schema version are required.",
    );
  }
  const client = await createSupabase();
  const { data, error } = await client.rpc("import_course_package", {
    p_package_key: identity.data.packageKey,
    p_package_revision: identity.data.packageRevision,
    p_schema_version: identity.data.schemaVersion,
    p_raw_package: rawPackage,
    p_reason: reason,
  });
  if (error) mapError(error);
  return z.uuid().parse(data);
}

// Deterministic: re-reads exactly what was staged and runs the pure domain
// validator over it, then records a content-free pass/fail on the package's
// own lifecycle. The full issue list is returned to the caller directly and
// is never persisted (it can reference, but never reveal, protected
// assessment answer-key text).
export async function validateStagedCoursePackage(
  importId: string,
  reason: string,
): Promise<CoursePackageValidationResult> {
  await requireCourseEngineeringAdmin();
  const id = z.uuid().parse(importId);
  const client = await createSupabase();
  const { data: content, error: readError } = await client.rpc(
    "get_course_package_content",
    { p_import_id: id },
  );
  if (readError) mapError(readError);
  const result = validateCoursePackage(content);
  if (result.valid) {
    const { error } = await client.rpc("mark_course_package_validated", {
      p_import_id: id,
      p_validation_report: result.report,
      p_reason: reason,
    });
    if (error) mapError(error);
  } else {
    const firstMessage = result.errors[0]?.message ?? "invalid package";
    const { error } = await client.rpc("reject_course_package", {
      p_import_id: id,
      p_reason: `Validation failed: ${firstMessage}`.slice(0, 300),
    });
    if (error) mapError(error);
  }
  return result;
}

export async function applyCoursePackage(
  importId: string,
  reason: string,
): Promise<string> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("apply_course_package", {
    p_import_id: z.uuid().parse(importId),
    p_reason: reason,
  });
  if (error) mapError(error);
  return z.uuid().parse(data);
}

export async function publishCoursePackage(
  importId: string,
  reason: string,
): Promise<string> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("publish_course_package", {
    p_import_id: z.uuid().parse(importId),
    p_reason: reason,
  });
  if (error) mapError(error);
  return z.uuid().parse(data);
}

export async function rejectCoursePackage(
  importId: string,
  reason: string,
): Promise<string> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("reject_course_package", {
    p_import_id: z.uuid().parse(importId),
    p_reason: reason,
  });
  if (error) mapError(error);
  return z.uuid().parse(data);
}

const previewRowSchema = z.object({
  id: z.uuid(),
  package_key: z.string(),
  package_revision: z.number().int(),
  schema_version: z.string(),
  status: z.string(),
  content_hash: z.string(),
  validation_report: z.unknown().nullable(),
  programme_id: z.uuid().nullable(),
  programme_version_id: z.uuid().nullable(),
  preview: z.unknown(),
});
export type CoursePackagePreview = z.infer<typeof previewRowSchema>;

export async function getCoursePackagePreview(
  importId: string,
): Promise<CoursePackagePreview> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_course_package_preview", {
    p_import_id: z.uuid().parse(importId),
  });
  if (error) mapError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return previewRowSchema.parse(row);
}

const listItemSchema = z.object({
  id: z.uuid(),
  package_key: z.string(),
  package_revision: z.number().int(),
  schema_version: z.string(),
  status: z.string(),
  content_hash: z.string(),
  programme_id: z.uuid().nullable(),
  programme_version_id: z.uuid().nullable(),
  created_at: z.string(),
  applied_at: z.string().nullable(),
  published_at: z.string().nullable(),
  rejected_at: z.string().nullable(),
});
export type CoursePackageListItem = z.infer<typeof listItemSchema>;

export async function listCoursePackages(): Promise<CoursePackageListItem[]> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_course_packages");
  if (error) mapError(error);
  return z.array(listItemSchema).parse(data ?? []);
}
