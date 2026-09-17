import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";

// PR16A: real migration-upgrade coverage for
// supabase/migrations/202609170036_commercial_v1_examiner_config_authority.sql,
// applied directly (via db.exec) against a database built ONLY through
// migration 035 -- mirroring the established precedent in
// tests/commercial-v1-assessment-policy-review.test.ts's "Real migration 028
// to 029 upgrade with existing institutional history". Every scenario here
// is one migration-036 checkpoint requirement (section 15 of the frozen
// design): hard-fail on incompatible VALIDATED/APPLIED/PUBLISHED state,
// never block on incompatible IMPORTED/REJECTED state, apply cleanly for
// compatible state, leave data and old function definitions untouched on
// failure, and keep the publication fingerprint byte-identical across the
// upgrade for compatible state.

const migration036Path = resolve(
  "supabase/migrations/202609170036_commercial_v1_examiner_config_authority.sql",
);

const adminAuth = "92000000-0000-4000-8000-000000000201";
const adminId = "90000000-0000-4000-8000-000000000201";

async function freshDbThrough35(): Promise<PGlite> {
  const db = await testDatabase({ throughMigration: 35 });
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'m36-admin@example.com',now())",
    [adminAuth],
  );
  await db.query(
    "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,'M36 Admin')",
    [adminId, adminAuth],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN')",
    [adminId],
  );
  return db;
}

async function asAdmin(db: PGlite) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    adminAuth,
  ]);
  await db.exec("set role authenticated");
}
async function resetRole(db: PGlite) {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

async function apply036(db: PGlite): Promise<void> {
  await db.exec(await readFile(migration036Path, "utf8"));
}

function disabledRole() {
  return {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [] as string[],
    escalationPolicy: "NONE" as const,
  };
}

// EXAMINER enabled under the OLD (pre-036) reviewed catalogue -- valid
// against migrations 001-035's assert_full_package_valid/set_agent_config,
// but incompatible with migration 036's corrected allowlist
// (grade_controlled_assessment/grade_practical_lab).
function oldExaminerRole() {
  return {
    enabled: true,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: ["get_current_learner_context", "get_lesson_context"],
    escalationPolicy: "NONE" as const,
  };
}

function buildPackage(overrides: Partial<CoursePackage> = {}): CoursePackage {
  return {
    schemaVersion: "COURSE_PACKAGE_V1",
    packageKey: "m36-upgrade-package",
    packageRevision: 1,
    programme: {
      title: "Migration 036 Upgrade Programme",
      examinationBody: "Ducelio Academy",
      qualificationName: "Upgrade Certificate",
    },
    curriculumVersion: { label: "Upgrade edition" },
    modules: [
      {
        key: "module-1",
        title: "Module One",
        position: 1,
        lessons: [
          {
            key: "lesson-1",
            title: "Lesson One",
            position: 1,
            objectives: [
              { key: "obj-1", description: "Objective one", position: 1 },
            ],
            resources: [],
            practicalActivities: [],
          },
        ],
      },
    ],
    assignmentTemplates: [],
    assessmentTemplates: [],
    schedulingDefaults: {
      studyDays: [1, 3],
      localStartTime: "18:00",
      timezone: "Europe/London",
    },
    agentConfiguration: {
      PROFESSOR: disabledRole(),
      TUTOR: disabledRole(),
      LAB_INSTRUCTOR: disabledRole(),
      EXAMINER: disabledRole(),
      COUNSELLOR: disabledRole(),
    },
    reason: "Migration 036 upgrade fixture package",
    ...overrides,
  };
}

async function importPackage(db: PGlite, pkg: CoursePackage) {
  await asAdmin(db);
  const result = await db.query<{ id: string }>(
    "select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id",
    [
      pkg.packageKey,
      pkg.packageRevision,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Import upgrade fixture package",
    ],
  );
  await resetRole(db);
  return result.rows[0].id;
}
async function validateImport(
  db: PGlite,
  pkg: CoursePackage,
  importId: string,
) {
  await asAdmin(db);
  const validation = validateCoursePackage(pkg);
  if (!validation.valid) throw new Error("fixture package invalid");
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [
      importId,
      JSON.stringify(validation.report),
      "Validated upgrade fixture package",
    ],
  );
  await resetRole(db);
}
// For adversarial fixtures using EXAMINER's OLD (pre-036) capability
// catalogue: the CURRENT src/domain/course-package.ts's TS validator always
// enforces the CURRENT (already-corrected) allowlist, so it would reject
// these fixtures before they even reach the database -- but the point of
// these fixtures is that the OLD, pre-036 SQL assert_full_package_valid
// (the actual gate mark_course_package_validated enforces) accepted them.
// Skips the TS pre-check and calls mark_course_package_validated directly;
// the caller-supplied report is recorded for information only and can never
// substitute for the database's own independent assert_full_package_valid
// re-check (migration 024's own documented invariant).
async function validateImportRaw(db: PGlite, importId: string) {
  await asAdmin(db);
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, "{}", "Validated upgrade fixture package (raw)"],
  );
  await resetRole(db);
}
async function applyImport(db: PGlite, importId: string) {
  await asAdmin(db);
  const result = await db.query<{ apply_course_package: string }>(
    "select public.apply_course_package($1,$2)",
    [importId, "Apply upgrade fixture package"],
  );
  await resetRole(db);
  return result.rows[0].apply_course_package;
}
async function setConfig(
  db: PGlite,
  versionId: string,
  role: string,
  opts: {
    enabled?: boolean;
    modelProfileRef?: string | null;
    instructionalNotes?: string | null;
    capabilities?: string[];
    escalationPolicy?: string;
  } = {},
) {
  await asAdmin(db);
  await db.query("select public.set_agent_config($1,$2,$3,$4,$5,$6,$7,$8)", [
    versionId,
    role,
    opts.enabled ?? false,
    opts.modelProfileRef ?? null,
    opts.instructionalNotes ?? null,
    opts.capabilities ?? [],
    opts.escalationPolicy ?? "NONE",
    "Configure upgrade fixture role",
  ]);
  await resetRole(db);
}
async function runTest(db: PGlite, importId: string) {
  await asAdmin(db);
  const result = await db.query<{
    id: string;
    outcome: string;
    failure_code: string | null;
    fingerprint: string;
    run_sequence: string;
  }>(
    "select id,outcome,failure_code,fingerprint,run_sequence from public.run_course_package_test($1,$2)",
    [importId, "Run upgrade fixture test"],
  );
  await resetRole(db);
  return result.rows[0];
}
async function testStatus(db: PGlite, importId: string) {
  await asAdmin(db);
  const result = await db.query<{
    status: string;
    outcome: string | null;
    fingerprint: string | null;
    run_sequence: string | null;
  }>("select * from public.get_course_package_test_status($1)", [importId]);
  await resetRole(db);
  return result.rows[0];
}
async function publish(db: PGlite, importId: string) {
  await asAdmin(db);
  const result = await db.query<{ publish_course_package: string }>(
    "select public.publish_course_package($1,$2)",
    [importId, "Publish upgrade fixture package"],
  );
  await resetRole(db);
  return result.rows[0].publish_course_package;
}
// Both course_engineering_private (no schema USAGE grant, even to
// ACADEMIC_ADMIN) and public.course_package_imports (no direct table
// access at all, even for admins -- migration 024's own comment: raw_package
// can embed controlled-assessment answer keys) are readable only by the
// base/owner connection, never through the `authenticated` role.
async function oldExaminerAllowlist(db: PGlite): Promise<string[]> {
  await db.exec("reset role");
  const result = await db.query<{ v: string[] }>(
    "select course_engineering_private.role_capability_allowlist('EXAMINER') as v",
  );
  return result.rows[0].v;
}
async function importRow(db: PGlite, importId: string) {
  await db.exec("reset role");
  const result = await db.query<{
    status: string;
    raw_package: unknown;
  }>(
    "select status,raw_package from public.course_package_imports where id=$1",
    [importId],
  );
  return result.rows[0];
}

describe("Migration 036 staged upgrade (PR16A)", () => {
  it("1. an incompatible VALIDATED package (EXAMINER using the old capability catalogue) makes migration 036 fail atomically", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({
        packageKey: "m36-incompatible-validated",
        agentConfiguration: {
          ...buildPackage().agentConfiguration,
          EXAMINER: oldExaminerRole(),
        },
      });
      const importId = await importPackage(db, pkg);
      await validateImportRaw(db, importId);
      const before = await importRow(db, importId);
      expect(before.status).toBe("VALIDATED");

      await expect(apply036(db)).rejects.toThrow();

      // Data unchanged.
      const after = await importRow(db, importId);
      expect(after).toEqual(before);
      // Old function definitions restored -- the failed CREATE OR REPLACE
      // never survives the rolled-back transaction.
      expect(await oldExaminerAllowlist(db)).toEqual([
        "get_current_learner_context",
        "get_lesson_context",
      ]);
    } finally {
      await db.close();
    }
  });

  it("2. an incompatible APPLIED package makes migration 036 fail atomically", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({
        packageKey: "m36-incompatible-applied",
        agentConfiguration: {
          ...buildPackage().agentConfiguration,
          EXAMINER: oldExaminerRole(),
        },
      });
      const importId = await importPackage(db, pkg);
      await validateImportRaw(db, importId);
      const versionId = await applyImport(db, importId);
      await setConfig(db, versionId, "EXAMINER", oldExaminerRole());
      const before = await importRow(db, importId);
      expect(before.status).toBe("APPLIED");

      await expect(apply036(db)).rejects.toThrow();

      const after = await importRow(db, importId);
      expect(after).toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("3. an incompatible persisted academic_agent_configs row (independent of the package's own proposal) makes migration 036 fail atomically", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({ packageKey: "m36-incompatible-config" });
      const importId = await importPackage(db, pkg);
      await validateImport(db, pkg, importId);
      const versionId = await applyImport(db, importId);
      // The package itself proposes EXAMINER disabled, but an admin
      // separately saved it enabled under the OLD catalogue -- migration
      // 036's stored-config preflight must catch this independently of
      // package content.
      await setConfig(db, versionId, "EXAMINER", oldExaminerRole());

      await expect(apply036(db)).rejects.toThrow();
      expect(await oldExaminerAllowlist(db)).toEqual([
        "get_current_learner_context",
        "get_lesson_context",
      ]);
    } finally {
      await db.close();
    }
  });

  it("4. a compatible historical package/config applies migration 036 cleanly", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({ packageKey: "m36-compatible" });
      const importId = await importPackage(db, pkg);
      await validateImport(db, pkg, importId);
      await applyImport(db, importId);

      await expect(apply036(db)).resolves.not.toThrow();
      expect(
        await oldExaminerAllowlist(db), // same function, now the NEW allowlist
      ).toEqual(["grade_controlled_assessment", "grade_practical_lab"]);
    } finally {
      await db.close();
    }
  });

  it("5. an incompatible IMPORTED draft does not block migration 036, is left unchanged, and correctly fails its own later validation", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({
        packageKey: "m36-incompatible-imported",
        agentConfiguration: {
          ...buildPackage().agentConfiguration,
          EXAMINER: oldExaminerRole(),
        },
      });
      const importId = await importPackage(db, pkg);
      const before = await importRow(db, importId);
      expect(before.status).toBe("IMPORTED");

      await expect(apply036(db)).resolves.not.toThrow();

      const after = await importRow(db, importId);
      expect(after).toEqual(before);

      // Now correctly fails validation under the new policy.
      await asAdmin(db);
      const validation = validateCoursePackage(pkg);
      await expect(
        db.query(
          "select public.mark_course_package_validated($1,$2::jsonb,$3)",
          [
            importId,
            JSON.stringify(
              validation.valid
                ? validation.report
                : { packageKey: pkg.packageKey },
            ),
            "Attempted post-036 validation of an incompatible draft",
          ],
        ),
      ).rejects.toThrow();
      await resetRole(db);
    } finally {
      await db.close();
    }
  });

  it("6. an incompatible REJECTED historical package does not block migration 036", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({
        packageKey: "m36-incompatible-rejected",
        agentConfiguration: {
          ...buildPackage().agentConfiguration,
          EXAMINER: oldExaminerRole(),
        },
      });
      const importId = await importPackage(db, pkg);
      await asAdmin(db);
      await db.query("select public.reject_course_package($1,$2)", [
        importId,
        "Rejected before migration 036 upgrade",
      ]);
      await resetRole(db);
      const before = await importRow(db, importId);
      expect(before.status).toBe("REJECTED");

      await expect(apply036(db)).resolves.not.toThrow();

      const after = await importRow(db, importId);
      expect(after).toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("7. the publication fingerprint is byte-identical before and after migration 036 for compatible unchanged state", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({ packageKey: "m36-fingerprint-stability" });
      const importId = await importPackage(db, pkg);
      await validateImport(db, pkg, importId);
      const versionId = await applyImport(db, importId);
      for (const role of [
        "PROFESSOR",
        "TUTOR",
        "LAB_INSTRUCTOR",
        "EXAMINER",
        "COUNSELLOR",
      ])
        await setConfig(db, versionId, role);
      const before = await runTest(db, importId);
      expect(before.outcome).toBe("PASS");

      await apply036(db);

      const after = await runTest(db, importId);
      expect(after.outcome).toBe("PASS");
      expect(after.fingerprint).toBe(before.fingerprint);
    } finally {
      await db.close();
    }
  });

  it("8. strongest backward-compatibility proof: the historical pre-036 PASS itself (never a fresh post-036 PASS) remains valid, current and directly publishable", async () => {
    const db = await freshDbThrough35();
    try {
      const pkg = buildPackage({ packageKey: "m36-full-lifecycle" });
      const importId = await importPackage(db, pkg);
      await validateImport(db, pkg, importId);
      const versionId = await applyImport(db, importId);
      for (const role of [
        "PROFESSOR",
        "TUTOR",
        "LAB_INSTRUCTOR",
        "EXAMINER",
        "COUNSELLOR",
      ])
        await setConfig(db, versionId, role);
      // Record identity, not merely outcome: the exact pre-036 run row
      // (id/run_sequence), not just an equal-looking fingerprint value.
      const preUpgrade = await runTest(db, importId);
      expect(preUpgrade.outcome).toBe("PASS");

      await apply036(db);

      // Deliberately NO run_course_package_test call here: a fresh PASS
      // would trivially satisfy the gate under migration 036's own new
      // policy without proving anything about the HISTORICAL pre-036 run.
      // get_course_package_test_status never mutates state -- it recomputes
      // the current fingerprint fresh and looks up whichever historical run
      // (if any) already matches it.
      const status = await testStatus(db, importId);
      expect(status.status).toBe("PASSED_CURRENT");
      expect(status.outcome).toBe("PASS");
      // The SAME historical run row is what's being reused -- identity, not
      // merely an equal fingerprint value that could coincidentally match a
      // different row.
      expect(status.run_sequence).toBe(preUpgrade.run_sequence);
      expect(status.fingerprint).toBe(preUpgrade.fingerprint);

      // Publication succeeds using that pre-existing PASS directly -- no
      // intervening test run of any kind between the migration 036 upgrade
      // and this publish call.
      await publish(db, importId);
      const published = await importRow(db, importId);
      expect(published.status).toBe("PUBLISHED");

      // Activation succeeds under migration 036 (never attempted while
      // merely APPLIED -- only after this PUBLISHED transition above).
      const cohortId = "c0000000-0000-4000-8000-000000000001";
      const instructorAuth = "93000000-0000-4000-8000-000000000201";
      const instructorId = "94000000-0000-4000-8000-000000000201";
      await db.exec("alter table auth.users disable trigger academy_identity");
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,'m36-instructor@example.com',now())",
        [instructorAuth],
      );
      await db.query(
        "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,'M36 Instructor')",
        [instructorId, instructorAuth],
      );
      await db.exec("alter table auth.users enable trigger academy_identity");
      await db.query(
        "insert into public.role_grants(user_id,role) values($1,'INSTRUCTOR')",
        [instructorId],
      );
      await db.query(
        "insert into public.staff_profiles(user_id,title) values($1,'Instructor')",
        [instructorId],
      );
      await db.exec("reset role");
      await db.query(
        "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Upgrade cohort',current_date)",
        [cohortId, versionId],
      );
      await asAdmin(db);
      const activationId = await db.query<{ v: string }>(
        "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,$6) as v",
        [
          importId,
          cohortId,
          instructorId,
          JSON.stringify([]),
          JSON.stringify([]),
          "Activate after migration 036 upgrade",
        ],
      );
      await resetRole(db);
      expect(activationId.rows[0].v).toMatch(/^[a-f0-9-]{36}$/);
    } finally {
      await db.close();
    }
  });
});
