import "server-only";
import { z } from "zod";
import {
  COURSE_PACKAGE_SCHEMA_VERSION,
  packageKeySchema,
  validateCoursePackage,
  type CoursePackageValidationResult,
} from "@/domain/course-package";
import {
  testRunResultSchema,
  testStatusResultSchema,
  type TestRunResult,
  type TestStatusResult,
} from "@/domain/course-engineering-admin";
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
  "A course package must be applied before a pre-publication test can be run":
    "INVALID_STATE",
  "The bound programme version is no longer awaiting publication":
    "INVALID_STATE",
  "A current passing pre-publication test does not exist for this exact package, materialised institutional state and agent-configuration state":
    "TEST_GATE_NOT_SATISFIED",
  "This programme version is governed by a course package; publish it through the course-package publication authority":
    "PACKAGE_GOVERNED_VERSION",
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

// Deterministic governed integrity/readiness check only: independently
// re-validates the immutable stored package, independently re-verifies the
// current materialised institutional state (programme/version identity and
// content) still corresponds exactly to that package, and compares the five
// saved academic_agent_configs rows against the package's own reviewed
// proposal. It never calls an external model/provider, never evaluates model output,
// and is not hosted/production acceptance -- see docs/18 and docs/29 for
// those separate Commercial V1 release gates. The database itself derives
// PASS/FAIL and the fingerprint; this layer only forwards importId/reason
// and returns the safe, already-persisted result.
export async function runCoursePackageTest(
  importId: string,
  reason: string,
): Promise<TestRunResult> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("run_course_package_test", {
    p_import_id: z.uuid().parse(importId),
    p_reason: reason,
  });
  if (error) mapError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return testRunResultSchema.parse({
    id: row.id,
    outcome: row.outcome,
    failureCode: row.failure_code,
    failedRoles: row.failed_roles ?? [],
    fingerprint: row.fingerprint,
    runSequence: row.run_sequence,
    runAt: row.run_at,
  });
}

// Read-only, display-only projection of the current test readiness state.
// The database recomputes the current fingerprint fresh on every call;
// publication enforcement never depends on this function -- publish_
// course_package re-derives and re-checks everything itself.
export async function getCoursePackageTestStatus(
  importId: string,
): Promise<TestStatusResult> {
  await requireCourseEngineeringAdmin();
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_course_package_test_status", {
    p_import_id: z.uuid().parse(importId),
  });
  if (error) mapError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return testStatusResultSchema.parse({
    status: row.status,
    outcome: row.outcome,
    failureCode: row.failure_code,
    failedRoles: row.failed_roles ?? [],
    fingerprint: row.fingerprint,
    runSequence: row.run_sequence,
    runAt: row.run_at,
  });
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
