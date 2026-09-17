import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";

// PR15: the governed course test-before-publish gate
// (supabase/migrations/202609170035_commercial_v1_course_prepublication_test.sql).
// This file exercises the gate directly against the database RPCs, never
// through the TS/Next.js layer, mirroring tests/course-engineering-
// workflow.test.ts's own direct-RPC style. It never calls an external
// model/provider: run_course_package_test is a deterministic governed
// integrity/readiness check only.

let db: PGlite;
const adminId = "90000000-0000-4000-8000-000000000101";
const adminAuth = "91000000-0000-4000-8000-000000000101";
const studentId = "10000000-0000-4000-8000-000000000101";
const studentAuth = "81000000-0000-4000-8000-000000000101";

const ROLES = [
  "PROFESSOR",
  "TUTOR",
  "LAB_INSTRUCTOR",
  "EXAMINER",
  "COUNSELLOR",
] as const;

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId,
  ]);
  await db.exec("set role authenticated");
}
async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

function disabledRole() {
  return {
    enabled: false,
    modelProfileRef: null,
    instructionalNotes: null,
    capabilities: [],
    escalationPolicy: "NONE" as const,
  };
}

function buildPackage(overrides: Partial<CoursePackage> = {}): CoursePackage {
  return {
    schemaVersion: "COURSE_PACKAGE_V1",
    packageKey: "prepub-gate-package",
    packageRevision: 1,
    programme: {
      title: "Pre-publication Gate Programme",
      examinationBody: "Ducelio Academy",
      qualificationName: "Gate Certificate",
    },
    curriculumVersion: { label: "Gate test edition" },
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
    reason: "Gate test package",
    ...overrides,
  };
}

async function importPackage(pkg: CoursePackage) {
  await asAuth(adminAuth);
  const result = await db.query<{ id: string }>(
    "select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id",
    [
      pkg.packageKey,
      pkg.packageRevision,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Import gate test package",
    ],
  );
  await resetRole();
  return result.rows[0].id;
}
async function validateImport(pkg: CoursePackage, importId: string) {
  await asAuth(adminAuth);
  const validation = validateCoursePackage(pkg);
  if (!validation.valid) throw new Error("fixture package invalid");
  await db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, JSON.stringify(validation.report), "Validated gate package"],
  );
  await resetRole();
}
async function applyImport(importId: string) {
  await asAuth(adminAuth);
  const result = await db.query<{ apply_course_package: string }>(
    "select public.apply_course_package($1,$2)",
    [importId, "Apply gate package"],
  );
  await resetRole();
  return result.rows[0].apply_course_package;
}
async function setConfig(
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
  await asAuth(adminAuth);
  await db.query("select public.set_agent_config($1,$2,$3,$4,$5,$6,$7,$8)", [
    versionId,
    role,
    opts.enabled ?? false,
    opts.modelProfileRef ?? null,
    opts.instructionalNotes ?? null,
    opts.capabilities ?? [],
    opts.escalationPolicy ?? "NONE",
    "Configure gate test role",
  ]);
  await resetRole();
}
async function setAllDisabled(versionId: string) {
  for (const role of ROLES) await setConfig(versionId, role);
}
async function runTest(importId: string, reason = "Run gate test") {
  await asAuth(adminAuth);
  const result = await db.query<{
    id: string;
    outcome: string;
    failure_code: string | null;
    failed_roles: string[];
    fingerprint: string;
    run_sequence: string;
    run_at: string;
  }>("select * from public.run_course_package_test($1,$2)", [importId, reason]);
  await resetRole();
  return result.rows[0];
}
async function publish(importId: string, reason = "Publish gate package") {
  await asAuth(adminAuth);
  const result = await db.query<{ publish_course_package: string }>(
    "select public.publish_course_package($1,$2)",
    [importId, reason],
  );
  await resetRole();
  return result.rows[0].publish_course_package;
}
// Full end-to-end setup: import, validate, apply, configure all five roles
// disabled and record one PASS. Returns the ids needed for further
// mutation/assertion.
async function readyPackage(packageKey: string) {
  const pkg = buildPackage({ packageKey });
  const importId = await importPackage(pkg);
  await validateImport(pkg, importId);
  const versionId = await applyImport(importId);
  await setAllDisabled(versionId);
  const run = await runTest(importId);
  return { pkg, importId, versionId, run };
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'gate-admin@example.com',now()),($2,'gate-student@example.com',now())",
    [adminAuth, studentAuth],
  );
  await db.query(
    "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,'Gate Admin')",
    [adminId, adminAuth],
  );
  await db.query(
    "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,'Gate Student')",
    [studentId, studentAuth],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN')",
    [adminId],
  );
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'STUDENT')",
    [studentId],
  );
});
afterAll(async () => {
  await db?.close();
});

describe("direct publication surface correction", () => {
  it("a package-linked version cannot publish through publish_programme_version even with no test at all", async () => {
    const { versionId } = {
      versionId: await applyImport(
        await (async () => {
          const pkg = buildPackage({ packageKey: "surface-no-test" });
          const importId = await importPackage(pkg);
          await validateImport(pkg, importId);
          return importId;
        })(),
      ),
    };
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_programme_version($1,$2)", [
        versionId,
        "Attempted direct publish",
      ]),
    ).rejects.toThrow("governed by a course package");
    await resetRole();
  });
  it("a package-linked version cannot publish through publish_programme_version even after a valid current PASS", async () => {
    const { importId, versionId, run } =
      await readyPackage("surface-with-pass");
    expect(run.outcome).toBe("PASS");
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_programme_version($1,$2)", [
        versionId,
        "Attempted direct publish despite PASS",
      ]),
    ).rejects.toThrow("governed by a course package");
    await resetRole();
    // The course_package_imports row must remain APPLIED -- never PUBLISHED
    // through the bypassed path -- and publish_course_package still works.
    await asAuth(adminAuth);
    const preview = await db.query<{ status: string }>(
      "select status from public.get_course_package_preview($1)",
      [importId],
    );
    await resetRole();
    expect(preview.rows[0].status).toBe("APPLIED");
    const published = await publish(importId);
    expect(published).toBe(versionId);
  });
  it("a non-package ProgrammeVersion retains standalone publish_programme_version behavior, unaffected by the gate", async () => {
    const programmeId = randomUUID();
    const versionId = randomUUID();
    const moduleId = randomUUID();
    const lessonId = randomUUID();
    await db.query(
      `insert into public.programmes(id,slug,title,examination_body,qualification_name)
       values($1,'standalone-gate-programme','Standalone Programme','Standalone Body','Standalone Qualification')`,
      [programmeId],
    );
    await db.query(
      "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Standalone draft')",
      [versionId, programmeId],
    );
    await db.query(
      "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module',1)",
      [moduleId, versionId],
    );
    await db.query(
      "insert into public.lessons(id,module_id,programme_version_id,title,position) values($1,$2,$3,'Lesson',1)",
      [lessonId, moduleId, versionId],
    );
    await db.query(
      "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Objective',1)",
      [lessonId, versionId],
    );
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      "select public.publish_programme_version($1,'Standalone publication reviewed') as id",
      [versionId],
    );
    await resetRole();
    expect(result.rows[0].id).toBe(versionId);
    const status = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [versionId],
    );
    expect(status.rows[0].status).toBe("PUBLISHED");
  });
  it("publish_course_package with a current PASS publishes both authoritative states atomically", async () => {
    const { importId, versionId } = await readyPackage("atomic-publish");
    await publish(importId);
    const versionStatus = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [versionId],
    );
    expect(versionStatus.rows[0].status).toBe("PUBLISHED");
    await asAuth(adminAuth);
    const preview = await db.query<{
      status: string;
      programme_version_id: string;
    }>(
      "select status,programme_version_id from public.get_course_package_preview($1)",
      [importId],
    );
    await resetRole();
    expect(preview.rows[0].status).toBe("PUBLISHED");
    expect(preview.rows[0].programme_version_id).toBe(versionId);
  });
});

describe("FAIL ledger transaction semantics", () => {
  it("persists an immutable FAIL row and returns normally -- not a raised exception -- for incomplete configuration", async () => {
    const pkg = buildPackage({ packageKey: "fail-incomplete" });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    await applyImport(importId);
    // No configs saved at all.
    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("CONFIGURATION_INCOMPLETE");
    expect(new Set(result.failed_roles)).toEqual(new Set(ROLES));
    const persisted = await db.query<{ outcome: string; failure_code: string }>(
      "select outcome,failure_code from public.course_package_test_runs where id=$1",
      [result.id],
    );
    expect(persisted.rows[0]).toEqual({
      outcome: "FAIL",
      failure_code: "CONFIGURATION_INCOMPLETE",
    });
  });
  it("persists an immutable FAIL row and returns normally for a semantic configuration mismatch", async () => {
    const pkg = buildPackage({ packageKey: "fail-mismatch" });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    const versionId = await applyImport(importId);
    await setAllDisabled(versionId);
    // The proposal has PROFESSOR disabled; save it enabled instead.
    await setConfig(versionId, "PROFESSOR", { enabled: true });
    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("CONFIGURATION_MISMATCH");
    expect(result.failed_roles).toEqual(["PROFESSOR"]);
    const persisted = await db.query<{ outcome: string }>(
      "select outcome from public.course_package_test_runs where id=$1",
      [result.id],
    );
    expect(persisted.rows[0].outcome).toBe("FAIL");
  });
  it("FAIL output never contains raw SQL/PostgREST/internal exception text (package revalidation failure)", async () => {
    // Constructs a synthetic APPLIED import whose stored raw_package is
    // structurally invalid -- unreachable through the normal import/
    // validate/apply flow (mark_course_package_validated already requires
    // assert_full_package_valid to pass, and raw_package is immutable
    // thereafter), so this defense-in-depth path is exercised directly at
    // the row level, as the base connection, exactly as an adversarial
    // structural regression.
    const programmeId = randomUUID();
    const versionId = randomUUID();
    const importId = randomUUID();
    await db.query(
      `insert into public.programmes(id,slug,title,examination_body,qualification_name)
       values($1,'synthetic-invalid-programme','Synthetic','Synthetic Body','Synthetic Qualification')`,
      [programmeId],
    );
    await db.query(
      "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Synthetic draft')",
      [versionId, programmeId],
    );
    await db.query(
      `insert into public.course_package_imports(
         id,package_key,package_revision,schema_version,content_hash,raw_package,
         validation_report,status,programme_id,programme_version_id,created_by,applied_at,applied_by
       ) values($1,'synthetic-invalid-package',1,'COURSE_PACKAGE_V1',$2,$3::jsonb,
         '{}'::jsonb,'APPLIED',$4,$5,$6,clock_timestamp(),$6)`,
      [
        importId,
        "e".repeat(64),
        JSON.stringify({
          schemaVersion: "COURSE_PACKAGE_V1",
          packageKey: "synthetic-invalid-package",
          packageRevision: 1,
        }),
        programmeId,
        versionId,
        adminId,
      ],
    );
    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("PACKAGE_REVALIDATION_FAILED");
    expect(result.failed_roles).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /syntax error|relation|column|constraint|SQLSTATE|pg_|postgres|PostgREST/i,
    );
  });
});

describe("test-policy identity", () => {
  it("every run stores the fixed COURSE_PREPUBLICATION_TEST_V1 policy identity", async () => {
    const { run } = await readyPackage("policy-identity");
    const stored = await db.query<{ test_policy_version: string }>(
      "select test_policy_version from public.course_package_test_runs where id=$1",
      [run.id],
    );
    expect(stored.rows[0].test_policy_version).toBe(
      "COURSE_PREPUBLICATION_TEST_V1",
    );
  });
  it("no other policy-version identity is accepted -- the column is a closed, protected identity", async () => {
    await expect(
      db.query(
        `insert into public.course_package_test_runs(
           id,import_id,programme_version_id,test_policy_version,fingerprint,outcome,run_by
         ) select gen_random_uuid(),import_id,programme_version_id,'COURSE_PREPUBLICATION_TEST_V2',
           'f'||repeat('0',63),'PASS',run_by
         from public.course_package_test_runs limit 1`,
      ),
    ).rejects.toThrow();
  });
});

describe("fingerprint semantics", () => {
  it("changes when any publication-relevant semantic config field changes", async () => {
    const { importId, versionId, run } =
      await readyPackage("fingerprint-change");
    // Still a deliberate mismatch against the proposal (escalationPolicy
    // NONE), so the second run is FAIL -- but the fingerprint must still
    // differ, because fingerprint reflects current stored state, not the
    // readiness verdict.
    await setConfig(versionId, "TUTOR", {
      enabled: false,
      escalationPolicy: "ACADEMIC_REVIEW",
    });
    const second = await runTest(importId);
    expect(second.fingerprint).not.toBe(run.fingerprint);
  });
  it("capability ordering alone does not change the fingerprint", async () => {
    const pkg = buildPackage({
      agentConfiguration: {
        PROFESSOR: {
          ...disabledRole(),
          capabilities: [
            "get_actor_context",
            "get_activity_permissions",
            "get_current_learner_context",
          ],
        },
        TUTOR: disabledRole(),
        LAB_INSTRUCTOR: disabledRole(),
        EXAMINER: disabledRole(),
        COUNSELLOR: disabledRole(),
      },
      packageKey: "fingerprint-capability-order",
    });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    const versionId = await applyImport(importId);
    await setConfig(versionId, "PROFESSOR", {
      capabilities: [
        "get_actor_context",
        "get_activity_permissions",
        "get_current_learner_context",
      ],
    });
    for (const role of ROLES.filter((r) => r !== "PROFESSOR"))
      await setConfig(versionId, role);
    const first = await runTest(importId);
    expect(first.outcome).toBe("PASS");

    // Re-save PROFESSOR with the exact same capability set, reversed order.
    await setConfig(versionId, "PROFESSOR", {
      capabilities: [
        "get_current_learner_context",
        "get_activity_permissions",
        "get_actor_context",
      ],
    });
    const second = await runTest(importId);
    expect(second.outcome).toBe("PASS");
    expect(second.fingerprint).toBe(first.fingerprint);
  });
  it("empty-string proposal instructional notes normalize identically to migration 027 (trim, empty -> NULL) against a saved NULL", async () => {
    // coursePackageSchema's instructionalNotes is z.string().trim().max(4000)
    // .nullable() -- an empty string is a distinct, valid proposal value
    // from null. set_agent_config itself rejects a non-null,
    // trims-to-empty value as invalid input (its own bounded-text check),
    // so the only way to persist "no notes" is an explicit NULL. Migration
    // 027's exact comparison semantics (nullif(trim(...),'')) must
    // therefore normalize the PROPOSAL's "" to NULL for comparison, so a
    // saved NULL correctly matches rather than reading as a mismatch.
    const pkg = buildPackage({
      packageKey: "notes-normalization",
      agentConfiguration: {
        PROFESSOR: { ...disabledRole(), instructionalNotes: "" },
        TUTOR: disabledRole(),
        LAB_INSTRUCTOR: disabledRole(),
        EXAMINER: disabledRole(),
        COUNSELLOR: disabledRole(),
      },
    });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    const versionId = await applyImport(importId);
    await setAllDisabled(versionId);
    const result = await runTest(importId);
    expect(result.outcome).toBe("PASS");
  });
});

describe("latest-current-result rule", () => {
  it("a later FAIL for an identical fingerprint overrides an earlier PASS (structural regression: latest run_sequence wins, not any historical PASS)", async () => {
    const { importId, versionId, run } = await readyPackage(
      "latest-wins-override",
    );
    expect(run.outcome).toBe("PASS");
    // Publication would succeed right now.
    // Directly append a later row under the SAME fingerprint with FAIL --
    // unreachable through the normal RPC surface (the readiness check is
    // deterministic over unchanged state), so constructed at the row level
    // to prove the "latest, not any historical PASS" rule structurally.
    await db.query(
      `insert into public.course_package_test_runs(
         id,import_id,programme_version_id,test_policy_version,fingerprint,
         outcome,failure_code,failed_roles,run_by
       ) values(gen_random_uuid(),$1,$2,'COURSE_PREPUBLICATION_TEST_V1',$3,
         'FAIL','CONFIGURATION_MISMATCH',array['PROFESSOR'],$4)`,
      [importId, versionId, run.fingerprint, adminId],
    );
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after a later FAIL for the same state",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
  it("exact state restoration reuses the prior PASS only while it remains latest for that fingerprint -- no re-test required", async () => {
    const { importId, versionId, run } = await readyPackage(
      "restore-reuses-pass",
    );
    const originalFingerprint = run.fingerprint;

    // Mutate PROFESSOR to a mismatching state -- fingerprint changes, and
    // the current state now fails.
    await setConfig(versionId, "PROFESSOR", { enabled: true });
    const mismatched = await runTest(importId);
    expect(mismatched.outcome).toBe("FAIL");
    expect(mismatched.fingerprint).not.toBe(originalFingerprint);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish against the mutated, untested state",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();

    // Restore PROFESSOR to the EXACT original semantic state (disabled,
    // null profile/notes, no capabilities, NONE escalation).
    await setConfig(versionId, "PROFESSOR");
    await asAuth(adminAuth);
    const restoredStatus = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId],
    );
    await resetRole();
    // No new test run against the restored state -- yet the database
    // reports the original PASS as current again, because the fingerprint
    // reverted to exactly what it was when that PASS was recorded and no
    // later run exists under that fingerprint.
    expect(restoredStatus.rows[0].status).toBe("PASSED_CURRENT");
    const published = await publish(
      importId,
      "Publish after exact state restoration, no re-test",
    );
    expect(published).toBe(versionId);
  });
});

describe("run_course_package_test lifecycle state", () => {
  it("is refused before Apply (IMPORTED)", async () => {
    const pkg = buildPackage({ packageKey: "lifecycle-imported-only" });
    const importId = await importPackage(pkg);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.run_course_package_test($1,$2)", [
        importId,
        "Attempted premature test",
      ]),
    ).rejects.toThrow(
      "must be applied before a pre-publication test can be run",
    );
    await resetRole();
  });
  it("is refused before Apply (VALIDATED)", async () => {
    const pkg = buildPackage({ packageKey: "lifecycle-validated-only" });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.run_course_package_test($1,$2)", [
        importId,
        "Attempted premature test",
      ]),
    ).rejects.toThrow(
      "must be applied before a pre-publication test can be run",
    );
    await resetRole();
  });
  it("PUBLISHED cannot run another pre-publication test", async () => {
    const { importId } = await readyPackage("lifecycle-published-locked");
    await publish(importId);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.run_course_package_test($1,$2)", [
        importId,
        "Attempted test after publication",
      ]),
    ).rejects.toThrow(
      "must be applied before a pre-publication test can be run",
    );
    await resetRole();
  });
  it("the RPC signature accepts no caller-supplied outcome, fingerprint or other extra argument", async () => {
    const { importId } = await readyPackage("no-caller-supplied-outcome");
    await asAuth(adminAuth);
    await expect(
      db.query("select public.run_course_package_test($1,$2,$3,$4)", [
        importId,
        "Forged outcome attempt",
        "PASS",
        "0".repeat(64),
      ]),
    ).rejects.toThrow();
    await resetRole();
  });
});

describe("publication gate", () => {
  it("publish fails closed with no test at all", async () => {
    const pkg = buildPackage({ packageKey: "gate-no-test" });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    await applyImport(importId);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish with no test",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
  it("publish fails closed with a stale PASS (config mutated after the test ran)", async () => {
    const { importId, versionId } = await readyPackage("gate-stale-pass");
    await setConfig(versionId, "COUNSELLOR", { enabled: true });
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish against a stale PASS",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
  it("publish succeeds with the latest exact-fingerprint PASS", async () => {
    const { importId, versionId } = await readyPackage("gate-latest-pass");
    const published = await publish(importId);
    expect(published).toBe(versionId);
  });
});

describe("immutability and ACL", () => {
  it("denies UPDATE and DELETE against test-run history unconditionally, even for the base connection", async () => {
    const { run } = await readyPackage("immutable-history");
    await expect(
      db.query(
        "update public.course_package_test_runs set outcome='FAIL' where id=$1",
        [run.id],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("delete from public.course_package_test_runs where id=$1", [
        run.id,
      ]),
    ).rejects.toThrow("immutable");
  });
  it("denies anon direct table access to course_package_test_runs", async () => {
    await db.exec("set role anon");
    await expect(
      db.query("select * from public.course_package_test_runs limit 1"),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into public.course_package_test_runs(id,import_id,programme_version_id,test_policy_version,fingerprint,outcome,run_by) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'COURSE_PREPUBLICATION_TEST_V1','${"a".repeat(64)}','PASS',gen_random_uuid())`,
      ),
    ).rejects.toThrow();
    await db.exec("reset role");
  });
  it("denies service_role direct table access to course_package_test_runs (BYPASSRLS does not bypass object ACLs)", async () => {
    await db.exec("set role service_role");
    await expect(
      db.query("select * from public.course_package_test_runs limit 1"),
    ).rejects.toThrow();
    await db.exec("reset role");
  });
  it("denies anon and service_role EXECUTE on run_course_package_test, get_course_package_test_status, publish_course_package and publish_programme_version", async () => {
    for (const role of ["anon", "service_role"]) {
      await db.exec(`set role ${role}`);
      await expect(
        db.query("select public.run_course_package_test($1,$2)", [
          randomUUID(),
          "Denied",
        ]),
      ).rejects.toThrow();
      await expect(
        db.query("select public.get_course_package_test_status($1)", [
          randomUUID(),
        ]),
      ).rejects.toThrow();
      await expect(
        db.query("select public.publish_course_package($1,$2)", [
          randomUUID(),
          "Denied",
        ]),
      ).rejects.toThrow();
      await expect(
        db.query("select public.publish_programme_version($1,$2)", [
          randomUUID(),
          "Denied",
        ]),
      ).rejects.toThrow();
      await db.exec("reset role");
    }
  });
});

// V2 correction: the package content_hash alone (raw uploaded JSON) never
// bound what apply_course_package actually MATERIALISED into institutional
// tables, and migration 024's apply_course_package updates the SHARED
// `programmes` row on every later revision of the same package_key, while
// migration 006's prepare_programme_publication reads that CURRENT live
// row at publish time rather than a per-version snapshot taken at Apply.
// These regressions prove that gap is closed.
describe("shared-programme divergence across revisions", () => {
  it("a later revision's Apply invalidates an earlier revision's PASS and blocks its publication until the shared programme metadata is restored", async () => {
    const packageKey = "shared-programme-divergence";
    const metadataA = {
      title: "Programme Metadata A",
      examinationBody: "Examination Body A",
      qualificationName: "Qualification A",
    };
    const metadataB = {
      title: "Programme Metadata B",
      examinationBody: "Examination Body B",
      qualificationName: "Qualification B",
    };
    const pkg1 = buildPackage({
      packageKey,
      packageRevision: 1,
      programme: metadataA,
      curriculumVersion: { label: "Revision 1 edition" },
    });
    const importId1 = await importPackage(pkg1);
    await validateImport(pkg1, importId1);
    const versionId1 = await applyImport(importId1);
    await setAllDisabled(versionId1);
    const run1 = await runTest(importId1);
    expect(run1.outcome).toBe("PASS");

    await asAuth(adminAuth);
    const statusBefore = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId1],
    );
    await resetRole();
    expect(statusBefore.rows[0].status).toBe("PASSED_CURRENT");

    // Import/validate/apply revision 2 under the SAME package key, with
    // DIFFERENT programme metadata -- apply_course_package updates the
    // shared programmes row that revision 1 also points to.
    const pkg2 = buildPackage({
      packageKey,
      packageRevision: 2,
      programme: metadataB,
      curriculumVersion: { label: "Revision 2 edition" },
    });
    const importId2 = await importPackage(pkg2);
    await validateImport(pkg2, importId2);
    await applyImport(importId2);

    const programmeRow = await db.query<{
      title: string;
      examination_body: string;
      qualification_name: string;
    }>(
      "select title,examination_body,qualification_name from public.programmes where slug=$1",
      [packageKey],
    );
    expect(programmeRow.rows[0]).toEqual({
      title: metadataB.title,
      examination_body: metadataB.examinationBody,
      qualification_name: metadataB.qualificationName,
    });

    // Revision 1's old PASS is no longer current -- the materialised-state
    // component of its fingerprint now differs (shared programme changed).
    await asAuth(adminAuth);
    const statusAfter = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId1],
    );
    await resetRole();
    expect(statusAfter.rows[0].status).toBe("PASSED_STALE");

    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId1,
        "Attempted publish against divergent shared programme metadata",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();

    // Revision 1 remains APPLIED/DRAFT -- publication never succeeded, so
    // no incorrect metadata B was ever snapshotted into it.
    await asAuth(adminAuth);
    const preview1 = await db.query<{ status: string }>(
      "select status from public.get_course_package_preview($1)",
      [importId1],
    );
    await resetRole();
    expect(preview1.rows[0].status).toBe("APPLIED");
    const version1Status = await db.query<{
      status: string;
      title_snapshot: string | null;
    }>(
      "select status,title_snapshot from public.programme_versions where id=$1",
      [versionId1],
    );
    expect(version1Status.rows[0].status).toBe("DRAFT");
    expect(version1Status.rows[0].title_snapshot).toBeNull();

    // Documented recovery semantics: the fingerprint is a pure function of
    // current state (never sequence/history), so restoring the shared
    // programme row to EXACTLY metadata A makes revision 1's original PASS
    // current again, with no re-test required -- the identical
    // "restoration reuses the prior PASS" rule already proven for agent
    // configuration in V1, now also holding for materialised state.
    await db.query(
      "update public.programmes set title=$1,examination_body=$2,qualification_name=$3 where slug=$4",
      [
        metadataA.title,
        metadataA.examinationBody,
        metadataA.qualificationName,
        packageKey,
      ],
    );
    await asAuth(adminAuth);
    const statusRestored = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId1],
    );
    await resetRole();
    expect(statusRestored.rows[0].status).toBe("PASSED_CURRENT");

    const published1 = await publish(
      importId1,
      "Publish revision 1 after restoring shared programme metadata",
    );
    expect(published1).toBe(versionId1);

    const finalSnapshot = await db.query<{
      title_snapshot: string;
      examination_body_snapshot: string;
      qualification_name_snapshot: string;
    }>(
      "select title_snapshot,examination_body_snapshot,qualification_name_snapshot from public.programme_versions where id=$1",
      [versionId1],
    );
    expect(finalSnapshot.rows[0]).toEqual({
      title_snapshot: metadataA.title,
      examination_body_snapshot: metadataA.examinationBody,
      qualification_name_snapshot: metadataA.qualificationName,
    });
  });
});

// Privileged-harness-only regressions: these mutate DRAFT materialised
// content directly at the row level, unreachable through any browser or
// governed RPC surface (no such mutation RPC exists), to prove defense
// against accidental privileged/backend drift between what was tested and
// what would actually publish -- not a browser authorization path.
describe("privileged materialised-tree drift regression", () => {
  it("a direct module-title mutation after PASS changes the materialised hash, makes the PASS stale, and blocks publication", async () => {
    const { importId, versionId, run } = await readyPackage(
      "materialized-drift-module",
    );
    expect(run.outcome).toBe("PASS");

    const moduleRow = await db.query<{ id: string }>(
      "select id from public.modules where programme_version_id=$1 limit 1",
      [versionId],
    );
    await db.query("update public.modules set title=$1 where id=$2", [
      "Privileged drift mutation",
      moduleRow.rows[0].id,
    ]);

    await asAuth(adminAuth);
    const status = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId],
    );
    await resetRole();
    expect(status.rows[0].status).toBe("PASSED_STALE");

    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after privileged module drift",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
  it("a direct lesson-objective description mutation after PASS blocks publication", async () => {
    const { importId, versionId } = await readyPackage(
      "materialized-drift-objective",
    );
    const objectiveRow = await db.query<{ id: string }>(
      "select id from public.lesson_objectives where programme_version_id=$1 limit 1",
      [versionId],
    );
    await db.query(
      "update public.lesson_objectives set description=$1 where id=$2",
      ["Privileged drift mutation", objectiveRow.rows[0].id],
    );
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after privileged objective drift",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
  it("a direct learning-resource body mutation after PASS blocks publication", async () => {
    const pkg = buildPackage({
      packageKey: "materialized-drift-resource",
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
              resources: [
                {
                  key: "res-1",
                  kind: "LECTURE_NOTE",
                  title: "Resource title",
                  body: "Original body text.",
                  url: null,
                  position: 1,
                },
              ],
              practicalActivities: [],
            },
          ],
        },
      ],
    });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    const versionId = await applyImport(importId);
    await setAllDisabled(versionId);
    const run = await runTest(importId);
    expect(run.outcome).toBe("PASS");

    const resourceRow = await db.query<{ id: string }>(
      "select id from public.learning_resources where programme_version_id=$1 limit 1",
      [versionId],
    );
    await db.query("update public.learning_resources set body=$1 where id=$2", [
      "Privileged drift mutation",
      resourceRow.rows[0].id,
    ]);

    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after privileged resource drift",
      ]),
    ).rejects.toThrow("current passing pre-publication test");
    await resetRole();
  });
});

// V3 correction: content equality alone cannot detect a privileged mutation
// that repoints the bound programme_version at a different (but otherwise
// valid) programme, or repoints the shared programmes row's slug away from
// the import's package_key, because module/lesson/objective/resource
// content is keyed by programme_version_id, never by programme_id or slug --
// such drift leaves the content-only hash completely unchanged.
// evaluate_materialized_readiness and publish_course_package both now
// independently re-verify the identity bindings themselves.
describe("privileged identity-binding drift regression", () => {
  it("a direct programme_version.programme_id repoint after PASS reports MATERIALIZED_STATE_MISMATCH, blocks publication, snapshots no foreign metadata, and restores deterministically", async () => {
    const { importId, versionId, run } = await readyPackage(
      "identity-drift-programme-id",
    );
    expect(run.outcome).toBe("PASS");

    const originalProgramme = await db.query<{ programme_id: string }>(
      "select programme_id from public.course_package_imports where id=$1",
      [importId],
    );
    const foreignProgrammeId = randomUUID();
    await db.query(
      `insert into public.programmes(id,slug,title,examination_body,qualification_name)
       values($1,'identity-drift-foreign-programme','Foreign Programme','Foreign Body','Foreign Qualification')`,
      [foreignProgrammeId],
    );
    await db.query(
      "update public.programme_versions set programme_id=$1 where id=$2",
      [foreignProgrammeId, versionId],
    );

    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("MATERIALIZED_STATE_MISMATCH");
    const persisted = await db.query<{ outcome: string; failure_code: string }>(
      "select outcome,failure_code from public.course_package_test_runs where id=$1",
      [result.id],
    );
    expect(persisted.rows[0]).toEqual({
      outcome: "FAIL",
      failure_code: "MATERIALIZED_STATE_MISMATCH",
    });

    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after privileged programme_id repoint",
      ]),
    ).rejects.toThrow("identity no longer matches");
    await resetRole();

    // Publication never proceeded far enough to snapshot any metadata --
    // never mind the WRONG, foreign programme's metadata.
    const versionRow = await db.query<{
      status: string;
      title_snapshot: string | null;
    }>(
      "select status,title_snapshot from public.programme_versions where id=$1",
      [versionId],
    );
    expect(versionRow.rows[0].status).toBe("DRAFT");
    expect(versionRow.rows[0].title_snapshot).toBeNull();

    // Deterministic restoration: repointing the version back to its exact
    // original programme_id makes the original PASS current again, with no
    // re-test required -- the same restoration rule already proven for
    // agent configuration (V1) and shared programme metadata (V2) also
    // holds for identity binding (V3).
    await db.query(
      "update public.programme_versions set programme_id=$1 where id=$2",
      [originalProgramme.rows[0].programme_id, versionId],
    );
    await asAuth(adminAuth);
    const restoredStatus = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId],
    );
    await resetRole();
    expect(restoredStatus.rows[0].status).toBe("PASSED_CURRENT");
    const published = await publish(
      importId,
      "Publish after restoring identity binding",
    );
    expect(published).toBe(versionId);
  });

  it("a direct programme.slug repoint away from the bound package_key reports MATERIALIZED_STATE_MISMATCH, blocks publication, and restores deterministically", async () => {
    const packageKey = "identity-drift-slug";
    const { importId, versionId, run } = await readyPackage(packageKey);
    expect(run.outcome).toBe("PASS");

    await db.query("update public.programmes set slug=$1 where slug=$2", [
      "identity-drift-slug-renamed",
      packageKey,
    ]);

    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("MATERIALIZED_STATE_MISMATCH");
    const persisted = await db.query<{ outcome: string; failure_code: string }>(
      "select outcome,failure_code from public.course_package_test_runs where id=$1",
      [result.id],
    );
    expect(persisted.rows[0]).toEqual({
      outcome: "FAIL",
      failure_code: "MATERIALIZED_STATE_MISMATCH",
    });

    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted publish after privileged slug repoint",
      ]),
    ).rejects.toThrow("identity no longer matches");
    await resetRole();
    const versionRow = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [versionId],
    );
    expect(versionRow.rows[0].status).toBe("DRAFT");

    // Restoring the exact original slug reverts the fingerprint to what it
    // was at PASS time, so the original PASS becomes current again with no
    // re-test required.
    await db.query("update public.programmes set slug=$1 where slug=$2", [
      packageKey,
      "identity-drift-slug-renamed",
    ]);
    await asAuth(adminAuth);
    const restoredStatus = await db.query<{ status: string }>(
      "select * from public.get_course_package_test_status($1)",
      [importId],
    );
    await resetRole();
    expect(restoredStatus.rows[0].status).toBe("PASSED_CURRENT");
    const published = await publish(
      importId,
      "Publish after restoring slug binding",
    );
    expect(published).toBe(versionId);
  });
});

describe("snapshot correctness", () => {
  it("a successful publication snapshots exactly the tested package's programme metadata", async () => {
    const { pkg, importId, versionId } = await readyPackage(
      "snapshot-correctness",
    );
    await publish(importId);
    const snapshot = await db.query<{
      title_snapshot: string;
      examination_body_snapshot: string;
      qualification_name_snapshot: string;
    }>(
      "select title_snapshot,examination_body_snapshot,qualification_name_snapshot from public.programme_versions where id=$1",
      [versionId],
    );
    expect(snapshot.rows[0]).toEqual({
      title_snapshot: pkg.programme.title,
      examination_body_snapshot: pkg.programme.examinationBody,
      qualification_name_snapshot: pkg.programme.qualificationName,
    });
  });
});

describe("materialized-state-mismatch readiness code", () => {
  it("run_course_package_test itself reports MATERIALIZED_STATE_MISMATCH (not merely publish failing) when materialised content has drifted", async () => {
    const { importId, versionId } = await readyPackage(
      "materialized-mismatch-code",
    );
    const moduleRow = await db.query<{ id: string }>(
      "select id from public.modules where programme_version_id=$1 limit 1",
      [versionId],
    );
    await db.query("update public.modules set title=$1 where id=$2", [
      "Drift before re-test",
      moduleRow.rows[0].id,
    ]);
    const result = await runTest(importId);
    expect(result.outcome).toBe("FAIL");
    expect(result.failure_code).toBe("MATERIALIZED_STATE_MISMATCH");
    expect(result.failed_roles).toEqual([]);
    const persisted = await db.query<{ outcome: string; failure_code: string }>(
      "select outcome,failure_code from public.course_package_test_runs where id=$1",
      [result.id],
    );
    expect(persisted.rows[0]).toEqual({
      outcome: "FAIL",
      failure_code: "MATERIALIZED_STATE_MISMATCH",
    });
  });
});

// V4 correction: run_course_package_test/publish_course_package lock the
// owning programme_versions row before reading/recomputing the
// materialised-state projection sourced from modules/lessons/
// lesson_objectives/learning_resources. For that lock to be an actual
// snapshot boundary, every privileged/backend write to those four tables
// must itself take the identical programme_versions lock, and re-check
// PUBLISHED/enrolled status only AFTER acquiring it -- never relying on a
// check performed before a wait. course_engineering_private.
// lock_materialized_curriculum_version is a dedicated, migration-035-owned
// trigger on all four tables proving exactly this.
//
// PGlite is a single embedded instance with no genuine concurrent
// sessions -- a probe against this harness (two overlapping `begin; select
// ... for update` sequences issued concurrently on the one PGlite
// connection) confirmed the second acquires the "locked" row immediately
// instead of blocking on the first's uncommitted transaction, so PGlite
// cannot faithfully exercise two independent transactions contending for
// the same row lock. These tests therefore prove the trigger is installed
// on all four tables and that it fails closed once the version is
// PUBLISHED (the same outcome true concurrent contention would produce,
// once the winning transaction commits). Genuine concurrent-transaction
// blocking/wake behavior is not claimed here and remains part of hosted
// PostgreSQL acceptance, not local PGlite coverage.
describe("materialised curriculum write serialization (V4 correction)", () => {
  it("the dedicated serialization trigger is installed on all four materialised curriculum tables, wired to the correct function", async () => {
    const rows = await db.query<{ table_name: string; function_name: string }>(
      `select c.relname as table_name, p.proname as function_name
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where t.tgname = 'materialized_curriculum_serialization'
         and not t.tgisinternal
         and n.nspname = 'public'
       order by c.relname`,
    );
    expect(rows.rows).toEqual([
      {
        table_name: "learning_resources",
        function_name: "lock_materialized_curriculum_version",
      },
      {
        table_name: "lesson_objectives",
        function_name: "lock_materialized_curriculum_version",
      },
      {
        table_name: "lessons",
        function_name: "lock_materialized_curriculum_version",
      },
      {
        table_name: "modules",
        function_name: "lock_materialized_curriculum_version",
      },
    ]);
  });

  it("module: direct writes remain allowed while DRAFT, and fail closed (INSERT/UPDATE/DELETE) once PUBLISHED", async () => {
    const { importId, versionId } = await readyPackage("serialization-module");
    // DRAFT: still allowed, exactly like apply_course_package's own writes.
    const inserted = await db.query<{ id: string }>(
      `insert into public.modules(programme_version_id,title,position)
       values($1,'Draft-inserted module',2) returning id`,
      [versionId],
    );
    await db.query("update public.modules set title=$1 where id=$2", [
      "Draft-updated module",
      inserted.rows[0].id,
    ]);
    await db.query("delete from public.modules where id=$1", [
      inserted.rows[0].id,
    ]);

    await publish(importId);

    await expect(
      db.query(
        `insert into public.modules(programme_version_id,title,position)
         values($1,'Post-publish module',3)`,
        [versionId],
      ),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    const moduleRow = await db.query<{ id: string }>(
      "select id from public.modules where programme_version_id=$1 limit 1",
      [versionId],
    );
    await expect(
      db.query("update public.modules set title=$1 where id=$2", [
        "Post-publish rename",
        moduleRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    await expect(
      db.query("delete from public.modules where id=$1", [
        moduleRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
  });

  it("lesson: direct writes remain allowed while DRAFT, and fail closed (INSERT/UPDATE/DELETE) once PUBLISHED", async () => {
    const { importId, versionId } = await readyPackage("serialization-lesson");
    const moduleRow = await db.query<{ id: string }>(
      "select id from public.modules where programme_version_id=$1 limit 1",
      [versionId],
    );
    const inserted = await db.query<{ id: string }>(
      `insert into public.lessons(module_id,programme_version_id,title,position)
       values($1,$2,'Draft-inserted lesson',2) returning id`,
      [moduleRow.rows[0].id, versionId],
    );
    await db.query("update public.lessons set title=$1 where id=$2", [
      "Draft-updated lesson",
      inserted.rows[0].id,
    ]);
    await db.query("delete from public.lessons where id=$1", [
      inserted.rows[0].id,
    ]);

    await publish(importId);

    await expect(
      db.query(
        `insert into public.lessons(module_id,programme_version_id,title,position)
         values($1,$2,'Post-publish lesson',3)`,
        [moduleRow.rows[0].id, versionId],
      ),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    const lessonRow = await db.query<{ id: string }>(
      "select id from public.lessons where programme_version_id=$1 limit 1",
      [versionId],
    );
    await expect(
      db.query("update public.lessons set title=$1 where id=$2", [
        "Post-publish rename",
        lessonRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    await expect(
      db.query("delete from public.lessons where id=$1", [
        lessonRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
  });

  it("lesson_objective: direct writes remain allowed while DRAFT, and fail closed (INSERT/UPDATE/DELETE) once PUBLISHED", async () => {
    const { importId, versionId } = await readyPackage(
      "serialization-objective",
    );
    const lessonRow = await db.query<{ id: string }>(
      "select id from public.lessons where programme_version_id=$1 limit 1",
      [versionId],
    );
    const inserted = await db.query<{ id: string }>(
      `insert into public.lesson_objectives(lesson_id,programme_version_id,description,position)
       values($1,$2,'Draft-inserted objective',2) returning id`,
      [lessonRow.rows[0].id, versionId],
    );
    await db.query(
      "update public.lesson_objectives set description=$1 where id=$2",
      ["Draft-updated objective", inserted.rows[0].id],
    );
    await db.query("delete from public.lesson_objectives where id=$1", [
      inserted.rows[0].id,
    ]);

    await publish(importId);

    await expect(
      db.query(
        `insert into public.lesson_objectives(lesson_id,programme_version_id,description,position)
         values($1,$2,'Post-publish objective',3)`,
        [lessonRow.rows[0].id, versionId],
      ),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    const objectiveRow = await db.query<{ id: string }>(
      "select id from public.lesson_objectives where programme_version_id=$1 limit 1",
      [versionId],
    );
    await expect(
      db.query(
        "update public.lesson_objectives set description=$1 where id=$2",
        ["Post-publish rewording", objectiveRow.rows[0].id],
      ),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    await expect(
      db.query("delete from public.lesson_objectives where id=$1", [
        objectiveRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
  });

  it("learning_resource: direct writes remain allowed while DRAFT, and fail closed (INSERT/UPDATE/DELETE) once PUBLISHED", async () => {
    const pkg = buildPackage({
      packageKey: "serialization-resource",
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
              resources: [
                {
                  key: "res-1",
                  kind: "LECTURE_NOTE",
                  title: "Resource title",
                  body: "Original body text.",
                  url: null,
                  position: 1,
                },
              ],
              practicalActivities: [],
            },
          ],
        },
      ],
    });
    const importId = await importPackage(pkg);
    await validateImport(pkg, importId);
    const versionId = await applyImport(importId);
    await setAllDisabled(versionId);
    const run = await runTest(importId);
    expect(run.outcome).toBe("PASS");

    const lessonRow = await db.query<{ id: string }>(
      "select id from public.lessons where programme_version_id=$1 limit 1",
      [versionId],
    );
    const inserted = await db.query<{ id: string }>(
      `insert into public.learning_resources(lesson_id,programme_version_id,kind,title,body,position,created_by)
       values($1,$2,'LECTURE_NOTE','Draft-inserted resource','Draft body',2,$3) returning id`,
      [lessonRow.rows[0].id, versionId, adminId],
    );
    await db.query("update public.learning_resources set body=$1 where id=$2", [
      "Draft-updated body",
      inserted.rows[0].id,
    ]);
    await db.query("delete from public.learning_resources where id=$1", [
      inserted.rows[0].id,
    ]);

    await publish(importId);

    await expect(
      db.query(
        `insert into public.learning_resources(lesson_id,programme_version_id,kind,title,body,position,created_by)
         values($1,$2,'LECTURE_NOTE','Post-publish resource','Post-publish body',3,$3)`,
        [lessonRow.rows[0].id, versionId, adminId],
      ),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    const resourceRow = await db.query<{ id: string }>(
      "select id from public.learning_resources where programme_version_id=$1 limit 1",
      [versionId],
    );
    await expect(
      db.query("update public.learning_resources set body=$1 where id=$2", [
        "Post-publish rewrite",
        resourceRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
    await expect(
      db.query("delete from public.learning_resources where id=$1", [
        resourceRow.rows[0].id,
      ]),
    ).rejects.toThrow("Published or enrolled curriculum is immutable");
  });
});
