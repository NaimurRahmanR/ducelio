import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  coursePackageSchema,
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";

let db: PGlite;
const adminId = "90000000-0000-4000-8000-000000000001";
const adminAuth = "91000000-0000-4000-8000-000000000001";
const studentId = "10000000-0000-4000-8000-000000000001"; // seeded STUDENT
const studentAuth = "81000000-0000-4000-8000-000000000009";

// Direct table reads are intentionally ungranted to `authenticated` (course
// package content can embed controlled-assessment answer keys; see the
// migration's comment on course_package_imports). Every verification read
// below therefore runs after resetRole(), as the underlying superuser
// connection, mirroring tests/programme-publication.test.ts.
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
    packageKey: "cyber-foundations-workflow",
    packageRevision: 1,
    programme: {
      title: "Cybersecurity Foundations",
      examinationBody: "Ducelio Academy",
      qualificationName: "Cybersecurity Foundations Certificate",
    },
    curriculumVersion: { label: "Workflow test edition" },
    modules: [
      {
        key: "module-1",
        title: "Security Principles",
        position: 1,
        lessons: [
          {
            key: "lesson-1",
            title: "Access Control",
            position: 1,
            objectives: [
              {
                key: "obj-1",
                description: "Explain authentication",
                position: 1,
              },
            ],
            resources: [
              {
                key: "res-1",
                kind: "LECTURE_NOTE",
                title: "Access control notes",
                body: "Authentication verifies identity.",
                url: null,
                position: 1,
              },
            ],
            practicalActivities: [],
          },
        ],
      },
    ],
    assignmentTemplates: [],
    assessmentTemplates: [
      {
        key: "assess-1",
        title: "Module 1 checkpoint",
        instructions: "Answer under exam conditions.",
        lessonRef: "lesson-1",
        durationMinutes: 30,
        attemptsAllowed: 1,
        questions: [
          {
            position: 1,
            prompt: "Define authentication.",
            maxMarks: 5,
            expectedAnswer: "The process of verifying identity.",
            markingGuidance: null,
            objectiveRefs: ["obj-1"],
          },
        ],
      },
    ],
    schedulingDefaults: {
      studyDays: [1, 3, 5],
      localStartTime: "19:00",
      timezone: "Europe/London",
    },
    agentConfiguration: {
      PROFESSOR: disabledRole(),
      TUTOR: disabledRole(),
      LAB_INSTRUCTOR: disabledRole(),
      EXAMINER: disabledRole(),
      COUNSELLOR: disabledRole(),
    },
    reason: "Workflow test package",
    ...overrides,
  };
}

// Runs the full admin sequence (auth -> RPC calls -> resetRole) and returns
// the import id, so call sites can continue with unprivileged verification
// reads immediately afterward. The content hash is never computed
// client-side: the database derives it from the exact stored jsonb.
async function importPackage(pkg: CoursePackage) {
  await asAuth(adminAuth);
  const result = await db.query<{ id: string }>(
    `select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id`,
    [
      pkg.packageKey,
      pkg.packageRevision,
      pkg.schemaVersion,
      JSON.stringify(pkg),
      "Import workflow test package",
    ],
  );
  await resetRole();
  return result.rows[0].id;
}

async function validateImport(importId: string) {
  await asAuth(adminAuth);
  const contentResult = await db.query<{
    get_course_package_content: unknown;
  }>("select public.get_course_package_content($1)", [importId]);
  const staged = contentResult.rows[0].get_course_package_content;
  const validation = validateCoursePackage(staged);
  if (validation.valid) {
    await db.query(
      "select public.mark_course_package_validated($1,$2::jsonb,$3)",
      [importId, JSON.stringify(validation.report), "Validated by test"],
    );
  }
  await resetRole();
  return validation;
}

async function applyImport(importId: string, reason: string) {
  await asAuth(adminAuth);
  const result = await db.query<{ apply_course_package: string }>(
    "select public.apply_course_package($1,$2)",
    [importId, reason],
  );
  await resetRole();
  return result.rows[0].apply_course_package;
}

// PR15: publish_course_package now requires a current passing
// pre-publication test. Every existing successful-publish call site in this
// file is exercising curriculum-lifecycle behavior, not agent-configuration
// semantics, so this shared helper saves all five roles explicitly disabled
// (the same default CourseAgentForm starts from) and runs the governed test
// before delegating to publish. Tests that specifically exercise the gate
// itself (a missing/failed/stale test) call the RPCs directly instead of
// through this helper -- see "pre-publication test gate" below.
async function runTest(importId: string, reason: string) {
  await asAuth(adminAuth);
  const result = await db.query<{
    outcome: string;
    failure_code: string | null;
    failed_roles: string[];
    fingerprint: string;
  }>("select * from public.run_course_package_test($1,$2)", [importId, reason]);
  await resetRole();
  return result.rows[0];
}
async function publishImport(importId: string, reason: string) {
  await asAuth(adminAuth);
  // course_package_imports has no direct SELECT grant even for authenticated
  // admins (migration 024); go through the reviewed preview RPC instead.
  const versionRow = await db.query<{ programme_version_id: string | null }>(
    "select programme_version_id from public.get_course_package_preview($1)",
    [importId],
  );
  const versionId = versionRow.rows[0]?.programme_version_id;
  if (versionId) {
    for (const role of [
      "PROFESSOR",
      "TUTOR",
      "LAB_INSTRUCTOR",
      "EXAMINER",
      "COUNSELLOR",
    ]) {
      await db.query(
        "select public.set_agent_config($1,$2,false,null,null,'{}',$3,$4)",
        [versionId, role, "NONE", "Workflow fixture agent configuration"],
      );
    }
  }
  await resetRole();
  const testRun = await runTest(
    importId,
    "Workflow fixture pre-publication test",
  );
  if (testRun.outcome !== "PASS")
    throw new Error(
      `Workflow fixture pre-publication test did not pass: ${testRun.outcome} ${testRun.failure_code}`,
    );
  await asAuth(adminAuth);
  const result = await db.query<{ publish_course_package: string }>(
    "select public.publish_course_package($1,$2)",
    [importId, reason],
  );
  await resetRole();
  return result.rows[0].publish_course_package;
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'course-admin@example.com',now()),($2,'course-student@example.com',now())",
    [adminAuth, studentAuth],
  );
  await db.query(
    "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,'Course Admin')",
    [adminId, adminAuth],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN')",
    [adminId],
  );
  // Bind the seeded demo student to a real auth user so the learner-scoped
  // agent-config read can be exercised with an authenticated session.
  // current_app_user() excludes is_demo rows, so it must be cleared too.
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [studentAuth, studentId],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("course package import", () => {
  it("denies import to a non-admin actor", async () => {
    await asAuth(studentAuth);
    const pkg = buildPackage({ packageKey: "denied-package" });
    await expect(
      db.query(`select public.import_course_package($1,$2,$3,$4::jsonb,$5)`, [
        pkg.packageKey,
        pkg.packageRevision,
        pkg.schemaVersion,
        JSON.stringify(pkg),
        "Attempted import",
      ]),
    ).rejects.toThrow("FORBIDDEN");
    await resetRole();
  });

  it("imports a new package as an admin", async () => {
    const id = await importPackage(buildPackage());
    expect(id).toBeTruthy();
    const row = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [id],
    );
    expect(row.rows[0].status).toBe("IMPORTED");
  });

  it("is idempotent for the same key, revision and content", async () => {
    const pkg = buildPackage({ packageKey: "idempotent-package" });
    const first = await importPackage(pkg);
    const second = await importPackage(pkg);
    expect(second).toBe(first);
  });

  it("rejects a conflicting revision with different content", async () => {
    const pkg = buildPackage({ packageKey: "conflict-package" });
    await importPackage(pkg);
    const changed = buildPackage({
      packageKey: "conflict-package",
      curriculumVersion: { label: "Different edition" },
    });
    await asAuth(adminAuth);
    await expect(
      db.query(`select public.import_course_package($1,$2,$3,$4::jsonb,$5)`, [
        changed.packageKey,
        changed.packageRevision,
        changed.schemaVersion,
        JSON.stringify(changed),
        "Import workflow test package",
      ]),
    ).rejects.toThrow("A different package already exists");
    await resetRole();
  });

  it("rejects an unsupported schema version", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        `select public.import_course_package($1,1,'COURSE_PACKAGE_V2','{}'::jsonb,$2)`,
        ["bad-schema-package", "Attempted import with unsupported schema"],
      ),
    ).rejects.toThrow("Unsupported course package schema version");
    await resetRole();
  });

  it("rejects a declared package key that does not match the raw package content", async () => {
    await asAuth(adminAuth);
    const pkg = buildPackage({ packageKey: "mismatched-key-package" });
    await expect(
      db.query(`select public.import_course_package($1,$2,$3,$4::jsonb,$5)`, [
        "a-totally-different-key",
        pkg.packageRevision,
        pkg.schemaVersion,
        JSON.stringify(pkg),
        "Attempted identity mismatch",
      ]),
    ).rejects.toThrow("Declared package key does not match package content");
    await resetRole();
  });

  it("rejects a declared package revision that does not match the raw package content", async () => {
    await asAuth(adminAuth);
    const pkg = buildPackage({ packageKey: "mismatched-revision-package" });
    await expect(
      db.query(`select public.import_course_package($1,$2,$3,$4::jsonb,$5)`, [
        pkg.packageKey,
        pkg.packageRevision + 1,
        pkg.schemaVersion,
        JSON.stringify(pkg),
        "Attempted identity mismatch",
      ]),
    ).rejects.toThrow(
      "Declared package revision does not match package content",
    );
    await resetRole();
  });

  it("rejects a declared schema version that does not match the raw package content", async () => {
    await asAuth(adminAuth);
    const pkg = buildPackage({ packageKey: "mismatched-schema-package" });
    // p_schema_version is a valid COURSE_PACKAGE_V1 (passing the earlier
    // "unsupported schema version" check), but the embedded content claims
    // something else, so only the identity-binding check can catch this.
    const tamperedContent = JSON.stringify({
      ...pkg,
      schemaVersion: "SOMETHING_ELSE",
    });
    await expect(
      db.query(
        `select public.import_course_package($1,$2,'COURSE_PACKAGE_V1',$3::jsonb,$4)`,
        [
          pkg.packageKey,
          pkg.packageRevision,
          tamperedContent,
          "Attempted identity mismatch",
        ],
      ),
    ).rejects.toThrow("Declared schema version does not match package content");
    await resetRole();
  });

  it("derives content hash independently from the stored content, ignoring top-level upload key order", async () => {
    const pkg = buildPackage({ packageKey: "hash-independence-package" });
    const importId = await importPackage(pkg);

    // A shallow top-level key reorder of semantically identical content:
    // Postgres normalises jsonb key order internally, so the
    // database-derived hash must be identical either way.
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(pkg).reverse()) {
      reordered[key] = (pkg as unknown as Record<string, unknown>)[key];
    }

    await asAuth(adminAuth);
    const reorderedResult = await db.query<{ id: string }>(
      `select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id`,
      [
        pkg.packageKey,
        pkg.packageRevision,
        pkg.schemaVersion,
        JSON.stringify(reordered),
        "Reordered re-import",
      ],
    );
    await resetRole();
    expect(reorderedResult.rows[0].id).toBe(importId);
  });
});

describe("course package validation, apply and publish", () => {
  it("runs the full lifecycle through to a published curriculum", async () => {
    const pkg = buildPackage({ packageKey: "lifecycle-package" });
    const importId = await importPackage(pkg);

    const validation = await validateImport(importId);
    expect(validation.valid).toBe(true);
    const status = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(status.rows[0].status).toBe("VALIDATED");

    const versionId = await applyImport(importId, "Apply reviewed content");
    expect(versionId).toBeTruthy();

    const version = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [versionId],
    );
    expect(version.rows[0].status).toBe("DRAFT");

    const moduleCount = await db.query<{ count: string }>(
      "select count(*) from public.modules where programme_version_id=$1",
      [versionId],
    );
    expect(Number(moduleCount.rows[0].count)).toBe(1);

    // Reapplying an already-applied import is idempotent, not a duplicate tree.
    const reapplied = await applyImport(importId, "Reapply attempt");
    expect(reapplied).toBe(versionId);
    const moduleCountAfter = await db.query<{ count: string }>(
      "select count(*) from public.modules where programme_version_id=$1",
      [versionId],
    );
    expect(Number(moduleCountAfter.rows[0].count)).toBe(1);

    const published = await publishImport(
      importId,
      "Publication reviewed and approved",
    );
    expect(published).toBe(versionId);

    const publishedVersion = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [versionId],
    );
    expect(publishedVersion.rows[0].status).toBe("PUBLISHED");

    const finalStatus = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(finalStatus.rows[0].status).toBe("PUBLISHED");
  });

  it("refuses to apply a package that has not been validated", async () => {
    const importId = await importPackage(
      buildPackage({ packageKey: "unvalidated-package" }),
    );
    await asAuth(adminAuth);
    await expect(
      db.query("select public.apply_course_package($1,$2)", [
        importId,
        "Attempted premature apply",
      ]),
    ).rejects.toThrow("must be validated before it can be applied");
    await resetRole();
  });

  it("refuses to publish a package that has not been applied", async () => {
    const importId = await importPackage(
      buildPackage({ packageKey: "unapplied-package" }),
    );
    await validateImport(importId);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_course_package($1,$2)", [
        importId,
        "Attempted premature publish",
      ]),
    ).rejects.toThrow("must be applied before it can be published");
    await resetRole();
  });

  it("never partially applies content when the version insert fails", async () => {
    const key = "atomic-rollback-package";
    const firstImportId = await importPackage(
      buildPackage({ packageKey: key, packageRevision: 1 }),
    );
    await validateImport(firstImportId);
    await applyImport(firstImportId, "Apply revision 1");

    // Same package key (same underlying programme) and the same curriculum
    // label collide on the programme_versions unique(programme_id,label)
    // constraint, forcing apply_course_package to fail mid-transaction.
    const collidingImportId = await importPackage(
      buildPackage({ packageKey: key, packageRevision: 2 }),
    );
    await validateImport(collidingImportId);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.apply_course_package($1,$2)", [
        collidingImportId,
        "Apply colliding revision 2",
      ]),
    ).rejects.toThrow("curriculum label already exists");
    await resetRole();

    const importRow = await db.query<{
      status: string;
      programme_version_id: string | null;
    }>(
      "select status,programme_version_id from public.course_package_imports where id=$1",
      [collidingImportId],
    );
    expect(importRow.rows[0].status).toBe("VALIDATED");
    expect(importRow.rows[0].programme_version_id).toBeNull();

    const programme = await db.query<{ id: string }>(
      "select id from public.programmes where slug=$1",
      [key],
    );
    const versionCount = await db.query<{ count: string }>(
      "select count(*) from public.programme_versions where programme_id=$1",
      [programme.rows[0].id],
    );
    // Only the first, successfully applied version exists; the failed
    // second attempt left no orphan version, module, lesson or objective.
    expect(Number(versionCount.rows[0].count)).toBe(1);
  });

  it("records an explicit rejection and refuses to reject published content", async () => {
    const importId = await importPackage(
      buildPackage({ packageKey: "rejectable-package" }),
    );
    await asAuth(adminAuth);
    await db.query("select public.reject_course_package($1,$2)", [
      importId,
      "Superseded by a corrected upload",
    ]);
    await resetRole();
    const status = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(status.rows[0].status).toBe("REJECTED");

    const publishedImportId = await importPackage(
      buildPackage({ packageKey: "published-then-reject" }),
    );
    await validateImport(publishedImportId);
    await applyImport(publishedImportId, "Apply");
    await publishImport(publishedImportId, "Publish");
    await asAuth(adminAuth);
    await expect(
      db.query("select public.reject_course_package($1,$2)", [
        publishedImportId,
        "Attempted rejection after publication",
      ]),
    ).rejects.toThrow("cannot be rejected");
    await resetRole();
  });

  it("preserves a previously published version when a new revision is applied", async () => {
    const key = "historical-package";
    const firstImportId = await importPackage(
      buildPackage({ packageKey: key, packageRevision: 1 }),
    );
    await validateImport(firstImportId);
    const firstVersionId = await applyImport(firstImportId, "Apply revision 1");
    await publishImport(firstImportId, "Publish revision 1");

    const secondImportId = await importPackage(
      buildPackage({
        packageKey: key,
        packageRevision: 2,
        curriculumVersion: { label: "Revision 2 edition" },
      }),
    );
    await validateImport(secondImportId);
    const secondVersionId = await applyImport(
      secondImportId,
      "Apply revision 2",
    );

    expect(secondVersionId).not.toBe(firstVersionId);
    const firstVersionStillPublished = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [firstVersionId],
    );
    expect(firstVersionStillPublished.rows[0].status).toBe("PUBLISHED");
    const secondVersionStillDraft = await db.query<{ status: string }>(
      "select status from public.programme_versions where id=$1",
      [secondVersionId],
    );
    expect(secondVersionStillDraft.rows[0].status).toBe("DRAFT");
  });
});

describe("course package preview redaction", () => {
  it("never returns controlled-assessment answer keys through preview", async () => {
    const importId = await importPackage(
      buildPackage({ packageKey: "preview-redaction-package" }),
    );
    await asAuth(adminAuth);
    const preview = await db.query<{ preview: unknown }>(
      "select preview from public.get_course_package_preview($1)",
      [importId],
    );
    await resetRole();
    const serialized = JSON.stringify(preview.rows[0].preview);
    expect(serialized).not.toContain("process of verifying identity");
    expect(serialized).toContain("Module 1 checkpoint");
  });
});

describe("reusable academic-agent configuration", () => {
  it("rejects a capability outside the reviewed allowlist for a role", async () => {
    await asAuth(adminAuth);
    const versionId = "20000000-0000-4000-8000-000000000002"; // seeded published version
    await expect(
      db.query(
        "select public.set_agent_config($1,'COUNSELLOR',true,null,null,array['get_current_mastery_state'],'NONE',$2)",
        [versionId, "Attempted capability escalation"],
      ),
    ).rejects.toThrow("outside the reviewed allowlist");
    await resetRole();
  });

  it("refuses a first binding on a version that already has enrolments (migration 050)", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        "select public.set_agent_config($1,'PROFESSOR',true,'PROFESSOR_COMMERCIAL_V1',null,array['get_lesson_context'],'NONE',$2)",
        [
          "20000000-0000-4000-8000-000000000002", // seeded, published, enrolled
          "Enable Professor for the seeded demo course",
        ],
      ),
    ).rejects.toThrow("AGENT_CONFIG_BINDING_CLOSED");
    await resetRole();
  });

  it("stores a configuration within the allowlist and is readable by the owning learner", async () => {
    // Real lifecycle order: configure while DRAFT, publish, then enrol.
    const versionId = (
      await db.query<{ id: string }>(
        "insert into public.programme_versions(programme_id,label) values('20000000-0000-4000-8000-000000000001','Agent config read version') returning id",
      )
    ).rows[0].id;
    const moduleId = (
      await db.query<{ id: string }>(
        "insert into public.modules(programme_version_id,title,position) values($1,'Module',1) returning id",
        [versionId],
      )
    ).rows[0].id;
    const lessonId = (
      await db.query<{ id: string }>(
        "insert into public.lessons(module_id,programme_version_id,title,position) values($1,$2,'Lesson',1) returning id",
        [moduleId, versionId],
      )
    ).rows[0].id;
    await db.query(
      "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Explain configuration',1)",
      [lessonId, versionId],
    );
    await asAuth(adminAuth);
    await db.query(
      "select public.set_agent_config($1,'PROFESSOR',true,'PROFESSOR_COMMERCIAL_V1',null,array['get_lesson_context'],'NONE',$2)",
      [versionId, "Enable Professor before publication"],
    );
    await resetRole();
    await db.query(
      "update public.programme_versions set status='PUBLISHED' where id=$1",
      [versionId],
    );
    const cohortId = (
      await db.query<{ id: string }>(
        "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Agent config cohort','2026-11-01') returning id",
        [versionId],
      )
    ).rows[0].id;
    const enrolment = await db.query<{ id: string }>(
      "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3) returning id",
      [studentId, cohortId, versionId],
    );

    await asAuth(studentAuth);
    const result = await db.query<{
      enabled: boolean;
      capabilities: string[];
    }>(
      "select enabled,capabilities from public.get_agent_config_for_enrolment($1,'PROFESSOR')",
      [enrolment.rows[0].id],
    );
    await resetRole();
    expect(result.rows[0].enabled).toBe(true);
    expect(result.rows[0].capabilities).toEqual(["get_lesson_context"]);
  });

  it("fails closed to a disabled default when no configuration exists", async () => {
    const enrolment = await db.query<{ id: string }>(
      "select id from public.enrolments where student_id=$1",
      [studentId],
    );

    await asAuth(studentAuth);
    const result = await db.query<{
      enabled: boolean;
      capabilities: string[];
      escalation_policy: string;
    }>(
      "select enabled,capabilities,escalation_policy from public.get_agent_config_for_enrolment($1,'LAB_INSTRUCTOR')",
      [enrolment.rows[0].id],
    );
    await resetRole();
    expect(result.rows[0].enabled).toBe(false);
    expect(result.rows[0].capabilities).toEqual([]);
    expect(result.rows[0].escalation_policy).toBe("NONE");
  });

  it("denies a learner reading agent configuration for an enrolment they do not own", async () => {
    await asAuth(studentAuth);
    await expect(
      db.query(
        "select public.get_agent_config_for_enrolment('00000000-0000-4000-8000-000000000000','PROFESSOR')",
      ),
    ).rejects.toThrow("Matching learner enrolment not found");
    await resetRole();
  });
});

// service_role has BYPASSRLS in this project's Supabase-like test setup
// (tests/db-helper.ts), so these prove the *object ACL* hardening itself —
// RLS alone is not relied on, matching the migration 022/023 pattern.
describe("service_role ACL hardening", () => {
  async function asServiceRole() {
    await db.exec("set role service_role");
  }

  it("cannot directly read course_package_imports (raw_package may hold answer keys)", async () => {
    await asServiceRole();
    await expect(
      db.query("select * from public.course_package_imports limit 1"),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });

  it("cannot directly write course_package_imports", async () => {
    await asServiceRole();
    await expect(
      db.query(
        "update public.course_package_imports set status='REJECTED' where true",
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });

  it("cannot directly read or write academic_agent_configs", async () => {
    await asServiceRole();
    await expect(
      db.query("select * from public.academic_agent_configs limit 1"),
    ).rejects.toThrow("permission denied");
    await expect(
      db.query(
        "insert into public.academic_agent_configs(programme_version_id,role,created_by) values ('00000000-0000-4000-8000-000000000000','PROFESSOR','00000000-0000-4000-8000-000000000000')",
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });

  it("cannot execute any course-engineering or agent-config RPC", async () => {
    await asServiceRole();
    await expect(
      db.query(
        "select public.import_course_package('service-role-package',1,'COURSE_PACKAGE_V1','{}'::jsonb,'Attempted service-role import')",
      ),
    ).rejects.toThrow("permission denied");
    await expect(
      db.query("select public.list_course_packages()"),
    ).rejects.toThrow("permission denied");
    await expect(
      db.query(
        "select public.set_agent_config('00000000-0000-4000-8000-000000000000','PROFESSOR',true,null,null,array[]::text[],'NONE','Attempted service-role write')",
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });

  it("cannot reach the private course_engineering_private schema or its functions", async () => {
    await asServiceRole();
    await expect(
      db.query(
        "select course_engineering_private.assert_materializable('{}'::jsonb)",
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });
});

// The database independently re-verifies materialisability; a direct,
// authenticated RPC call can never forge institutional validation just by
// supplying a report that claims success.
describe("database-side validation cannot be forged", () => {
  it("refuses to mark a structurally invalid package VALIDATED even with a forged success report", async () => {
    await asAuth(adminAuth);
    // Valid in every other respect (including the fields
    // assert_full_package_valid checks before reaching modules: reason,
    // assignmentTemplates, assessmentTemplates, schedulingDefaults,
    // agentConfiguration) so this test isolates exactly the one deliberate
    // violation it names: "at least one module".
    const malformedRaw = buildPackage({
      packageKey: "forged-validation-package",
      modules: [],
    });
    const importResult = await db.query<{ id: string }>(
      `select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id`,
      [
        malformedRaw.packageKey,
        malformedRaw.packageRevision,
        malformedRaw.schemaVersion,
        JSON.stringify(malformedRaw),
        "Import deliberately malformed package",
      ],
    );
    const importId = importResult.rows[0].id;

    // A direct authenticated admin call supplying a forged "valid" report,
    // bypassing the TypeScript validator entirely.
    await expect(
      db.query("select public.mark_course_package_validated($1,$2::jsonb,$3)", [
        importId,
        JSON.stringify({ valid: true, report: { moduleCount: 99 } }),
        "Forged validation claim",
      ]),
    ).rejects.toThrow("Package must declare between one and 250 modules");
    await resetRole();

    const status = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(status.rows[0].status).toBe("IMPORTED");
  });

  it("defends in depth at apply time even if a VALIDATED row were somehow tampered", async () => {
    // Construct a package that is materialisable (passes
    // assert_materializable) so it can genuinely reach VALIDATED. raw_package
    // is ordinarily immutable (guard_course_package_import_history); this
    // test deliberately bypasses that guard, the way only a privileged
    // operator action could, to prove apply_course_package's own re-check
    // is a real second line of defense and not merely decorative.
    const pkg = buildPackage({ packageKey: "tamper-defense-package" });
    const importId = await importPackage(pkg);
    await validateImport(importId);

    await db.exec(
      "alter table public.course_package_imports disable trigger guard_course_package_import_history",
    );
    await db.query(
      "update public.course_package_imports set raw_package = raw_package - 'modules' where id=$1",
      [importId],
    );
    await db.exec(
      "alter table public.course_package_imports enable trigger guard_course_package_import_history",
    );

    await asAuth(adminAuth);
    await expect(
      db.query("select public.apply_course_package($1,$2)", [
        importId,
        "Attempted apply of tampered content",
      ]),
    ).rejects.toThrow("Package must declare at least one module");
    await resetRole();

    const status = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(status.rows[0].status).toBe("VALIDATED");
  });
});

describe("historical programme metadata", () => {
  it("never rewrites an already-published version's frozen title snapshot when a later revision updates live programme metadata", async () => {
    const key = "metadata-immutability-package";
    const firstImportId = await importPackage(
      buildPackage({
        packageKey: key,
        packageRevision: 1,
        programme: {
          title: "Original Programme Title",
          examinationBody: "Original Body",
          qualificationName: "Original Qualification",
        },
      }),
    );
    await validateImport(firstImportId);
    const firstVersionId = await applyImport(firstImportId, "Apply revision 1");
    await publishImport(firstImportId, "Publish revision 1");

    const firstSnapshotBefore = await db.query<{ title_snapshot: string }>(
      "select title_snapshot from public.programme_versions where id=$1",
      [firstVersionId],
    );
    expect(firstSnapshotBefore.rows[0].title_snapshot).toBe(
      "Original Programme Title",
    );

    const secondImportId = await importPackage(
      buildPackage({
        packageKey: key,
        packageRevision: 2,
        curriculumVersion: { label: "Revision 2 metadata edition" },
        programme: {
          title: "Renamed Programme Title",
          examinationBody: "Renamed Body",
          qualificationName: "Renamed Qualification",
        },
      }),
    );
    await validateImport(secondImportId);
    await applyImport(secondImportId, "Apply revision 2");

    // The live programmes row now reflects revision 2's description...
    const programme = await db.query<{ title: string }>(
      "select title from public.programmes where slug=$1",
      [key],
    );
    expect(programme.rows[0].title).toBe("Renamed Programme Title");

    // ...but revision 1's already-published, frozen snapshot is untouched.
    const firstSnapshotAfter = await db.query<{ title_snapshot: string }>(
      "select title_snapshot from public.programme_versions where id=$1",
      [firstVersionId],
    );
    expect(firstSnapshotAfter.rows[0].title_snapshot).toBe(
      "Original Programme Title",
    );
  });
});

// An authenticated ACADEMIC_ADMIN bypassing the TypeScript validator
// entirely and calling mark_course_package_validated directly, with a
// forged report, must still be refused by the database's OWN full
// COURSE_PACKAGE_V1 validator. Every package below is otherwise a normal,
// materialisable buildPackage() with exactly one defect, so a pass here
// proves the COMPLETE validator caught it — not merely the narrower
// materialisation-only check apply_course_package also runs.
describe("full COURSE_PACKAGE_V1 validation cannot be bypassed", () => {
  async function expectDirectValidationRejected(
    pkg: CoursePackage,
    expectedMessage: string,
  ) {
    const importId = await importPackage(pkg);
    await asAuth(adminAuth);
    await expect(
      db.query("select public.mark_course_package_validated($1,$2::jsonb,$3)", [
        importId,
        JSON.stringify({ valid: true, report: { forged: true } }),
        "Forged validation claim bypassing TypeScript",
      ]),
    ).rejects.toThrow(expectedMessage);
    await resetRole();
    const status = await db.query<{ status: string }>(
      "select status from public.course_package_imports where id=$1",
      [importId],
    );
    expect(status.rows[0].status).toBe("IMPORTED");
    return importId;
  }

  it("1. rejects a broken assignment-template lessonRef", async () => {
    await expectDirectValidationRejected(
      buildPackage({
        packageKey: "adversarial-assignment-lessonref",
        assignmentTemplates: [
          {
            key: "assign-1",
            title: "Access control essay",
            instructions: "Write a short essay on access control models.",
            lessonRef: "lesson-does-not-exist",
            objectiveRefs: ["obj-1"],
            rubric: [{ description: "Covers the topic", maxMarks: 10 }],
          },
        ],
      }),
      "Assignment template references an unknown lesson",
    );
  });

  it("2. rejects a broken assessment-question objectiveRef", async () => {
    const pkg = buildPackage({
      packageKey: "adversarial-assessment-objectiveref",
    });
    pkg.assessmentTemplates[0].questions[0].objectiveRefs = [
      "objective-does-not-exist",
    ];
    await expectDirectValidationRejected(
      pkg,
      "Assessment question references an objective outside its lesson",
    );
  });

  it("3. rejects an invalid agent role/capability combination", async () => {
    const pkg = buildPackage({ packageKey: "adversarial-agent-capability" });
    pkg.agentConfiguration.COUNSELLOR = {
      enabled: true,
      modelProfileRef: null,
      instructionalNotes: null,
      // get_current_mastery_state is PROFESSOR-only, never COUNSELLOR's.
      capabilities: ["get_current_mastery_state"],
      escalationPolicy: "NONE",
    };
    await expectDirectValidationRejected(
      pkg,
      "Agent configuration capability is outside the reviewed allowlist for its role",
    );
  });

  it("4. rejects a duplicate objective reference inside one objectiveRefs array", async () => {
    const pkg = buildPackage({
      packageKey: "adversarial-duplicate-objectiveref",
    });
    pkg.assessmentTemplates[0].questions[0].objectiveRefs = ["obj-1", "obj-1"];
    await expectDirectValidationRejected(
      pkg,
      "Duplicate objective reference in assessment-question objectiveRefs",
    );
  });

  it("5. rejects malformed scheduling defaults (empty studyDays)", async () => {
    const pkg = buildPackage({ packageKey: "adversarial-malformed-schedule" });
    // Zod's inferred type does not encode the runtime min(1) length
    // constraint, so this assigns cleanly; it is deliberately invalid at
    // the runtime boundary, to prove the database (not just the zod
    // schema) rejects it directly.
    pkg.schedulingDefaults.studyDays = [];
    await expectDirectValidationRejected(
      pkg,
      "schedulingDefaults.studyDays must be an array of one to seven days",
    );
  });

  it("6. rejects an unrecognised IANA timezone", async () => {
    const pkg = buildPackage({ packageKey: "adversarial-invalid-timezone" });
    pkg.schedulingDefaults.timezone = "Not/A_Real_Zone";
    await expectDirectValidationRejected(
      pkg,
      "schedulingDefaults.timezone is not a recognised IANA timezone",
    );
  });

  it("7. the narrower materialisation-only check alone would NOT have caught the capability defect, proving the full validator is doing genuinely more", async () => {
    const pkg = buildPackage({ packageKey: "adversarial-narrow-check-proof" });
    pkg.agentConfiguration.COUNSELLOR = {
      enabled: true,
      modelProfileRef: null,
      instructionalNotes: null,
      capabilities: ["get_current_mastery_state"],
      escalationPolicy: "NONE",
    };
    const importId = await importPackage(pkg);

    // assert_materializable only looks at modules/lessons/objectives/
    // resources, so this otherwise-materialisable curriculum passes it
    // even though the package as a whole is invalid.
    await db.query(
      "select course_engineering_private.assert_materializable(raw_package) from public.course_package_imports where id=$1",
      [importId],
    );

    await asAuth(adminAuth);
    await expect(
      db.query("select public.mark_course_package_validated($1,$2::jsonb,$3)", [
        importId,
        JSON.stringify({ valid: true }),
        "Forged validation claim",
      ]),
    ).rejects.toThrow(
      "Agent configuration capability is outside the reviewed allowlist for its role",
    );
    await resetRole();
  });

  // Table-driven parity check: every row is a single mutation away from
  // buildPackage()'s otherwise-valid fixture, chosen to exercise a field or
  // constraint family that assert_full_package_valid previously omitted.
  // Each row asserts BOTH that src/domain/course-package.ts's own
  // coursePackageSchema.safeParse() already rejects it (so a row can never
  // silently test nothing) AND that a direct, authenticated RPC call
  // bypassing the TypeScript validator entirely is rejected by the database
  // with a matching reason. A future field added to one side without the
  // other shows up here as a newly-passing coursePackageSchema assertion
  // (this table drifting from the real contract) or a DB call that stops
  // throwing (assert_full_package_valid drifting from the real contract),
  // rather than staying invisible.
  describe("table-driven parity: representative contract violations rejected by both coursePackageSchema and assert_full_package_valid", () => {
    type ParityCase = {
      name: string;
      packageKey: string;
      mutate: (pkg: Record<string, unknown>) => void;
      expectedMessage: string;
      // Set when the violation is one import_course_package's own identity
      // binding now catches before a row is even inserted (a stricter, but
      // equally valid, place to reject it than waiting for
      // mark_course_package_validated). The full-validator check that would
      // otherwise catch it later is retained regardless, as defense in
      // depth — see the case's own comment.
      rejectsAtImport?: boolean;
    };
    const PARITY_CASES: ParityCase[] = [
      {
        name: "rubric criterion description is empty",
        packageKey: "adversarial-parity-rubric-empty-description",
        mutate: (pkg) => {
          pkg.assignmentTemplates = [
            {
              key: "assign-1",
              title: "Checkpoint essay",
              instructions: "Write 500 words on the topic.",
              lessonRef: "lesson-1",
              objectiveRefs: ["obj-1"],
              rubric: [{ description: "", maxMarks: 10 }],
            },
          ];
        },
        expectedMessage: "A rubric criterion description",
      },
      {
        name: "rubric criterion maxMarks is 999 (exceeds 100)",
        packageKey: "adversarial-parity-rubric-max-marks",
        mutate: (pkg) => {
          pkg.assignmentTemplates = [
            {
              key: "assign-1",
              title: "Checkpoint essay",
              instructions: "Write 500 words on the topic.",
              lessonRef: "lesson-1",
              objectiveRefs: ["obj-1"],
              rubric: [{ description: "Clear argument", maxMarks: 999 }],
            },
          ];
        },
        expectedMessage:
          "A rubric criterion maxMarks must be an integer between 1 and 100",
      },
      {
        name: "agent modelProfileRef is a number, not a string or null",
        packageKey: "adversarial-parity-model-ref-type",
        mutate: (pkg) => {
          const agentConfiguration = pkg.agentConfiguration as Record<
            string,
            Record<string, unknown>
          >;
          agentConfiguration.PROFESSOR.modelProfileRef = 12345;
        },
        expectedMessage:
          "An agent configuration modelProfileRef must be a string",
      },
      {
        name: "agent modelProfileRef is overlong",
        packageKey: "adversarial-parity-model-ref-overlong",
        mutate: (pkg) => {
          const agentConfiguration = pkg.agentConfiguration as Record<
            string,
            Record<string, unknown>
          >;
          agentConfiguration.PROFESSOR.modelProfileRef = "x".repeat(101);
        },
        expectedMessage:
          "An agent configuration modelProfileRef must be a bounded identifier",
      },
      {
        name: "agent instructionalNotes is a number, not a string or null",
        packageKey: "adversarial-parity-notes-type",
        mutate: (pkg) => {
          const agentConfiguration = pkg.agentConfiguration as Record<
            string,
            Record<string, unknown>
          >;
          agentConfiguration.TUTOR.instructionalNotes = 42;
        },
        expectedMessage:
          "An agent configuration instructionalNotes must be a string",
      },
      {
        name: "assessment question markingGuidance is a number",
        packageKey: "adversarial-parity-marking-guidance-type",
        mutate: (pkg) => {
          const assessmentTemplates = pkg.assessmentTemplates as Record<
            string,
            unknown
          >[];
          const questions = assessmentTemplates[0].questions as Record<
            string,
            unknown
          >[];
          questions[0].markingGuidance = 5;
        },
        expectedMessage:
          "An assessment question markingGuidance must be a string",
      },
      {
        name: "assessment question markingGuidance is an empty string",
        packageKey: "adversarial-parity-marking-guidance-empty",
        mutate: (pkg) => {
          const assessmentTemplates = pkg.assessmentTemplates as Record<
            string,
            unknown
          >[];
          const questions = assessmentTemplates[0].questions as Record<
            string,
            unknown
          >[];
          questions[0].markingGuidance = "";
        },
        expectedMessage:
          "An assessment question markingGuidance must be between 1 and 12000 characters",
      },
      {
        name: "top-level reason is missing",
        packageKey: "adversarial-parity-reason-missing",
        mutate: (pkg) => {
          delete pkg.reason;
        },
        expectedMessage: "Package reason must be a string",
      },
      {
        name: "top-level reason is too short",
        packageKey: "adversarial-parity-reason-short",
        mutate: (pkg) => {
          pkg.reason = "hi";
        },
        expectedMessage: "Package reason must be between 5 and 300 characters",
      },
      {
        name: "packageRevision exceeds the maximum of 100000",
        packageKey: "adversarial-parity-revision-max",
        mutate: (pkg) => {
          pkg.packageRevision = 100001;
        },
        expectedMessage: "Package revision exceeds the maximum of 100000",
      },
      {
        name: "a module key does not match the local-reference format",
        packageKey: "adversarial-parity-module-key-format",
        mutate: (pkg) => {
          const modules = pkg.modules as Record<string, unknown>[];
          modules[0].key = "bad key!";
        },
        expectedMessage: "a module key must be a bounded identifier",
      },
      {
        name: "a module position exceeds the maximum of 10000",
        packageKey: "adversarial-parity-module-position-range",
        mutate: (pkg) => {
          const modules = pkg.modules as Record<string, unknown>[];
          modules[0].position = 10001;
        },
        expectedMessage: "A module position is invalid or duplicated",
      },
      {
        name: "an assignment template's objectiveRefs array exceeds the maximum of 50",
        packageKey: "adversarial-parity-objective-refs-max",
        mutate: (pkg) => {
          pkg.assignmentTemplates = [
            {
              key: "assign-1",
              title: "Checkpoint essay",
              instructions: "Write 500 words on the topic.",
              lessonRef: "lesson-1",
              objectiveRefs: Array.from({ length: 51 }, () => "obj-1"),
              rubric: [{ description: "Clear argument", maxMarks: 10 }],
            },
          ];
        },
        expectedMessage:
          "An assignment template must reference between one and 50 objectives",
      },
      {
        name: "the package declares an unexpected top-level field",
        packageKey: "adversarial-parity-unexpected-field",
        mutate: (pkg) => {
          pkg.unexpectedField = "should never be accepted";
        },
        expectedMessage: 'Unexpected field "unexpectedField"',
      },
      {
        // packageKey must be a JSON string. The ->> operator stringifies
        // any JSON scalar, so a raw packageKey of JSON number 123 reads as
        // the text '123' — identical to the text a legitimate string
        // packageKey of "123" would produce — and the node-postgres driver
        // sends this case's numeric p_package_key parameter as that same
        // text '123', so only an explicit jsonb_typeof check (not the text
        // comparison) tells the two apart. import_course_package's own
        // identity binding now rejects this before a row is even inserted
        // (package-key format is otherwise satisfied: digits alone match
        // the slug regex), which is why this case is marked
        // rejectsAtImport — see assert_full_package_valid's matching check,
        // retained as defense in depth for a row that somehow bypassed it.
        name: "packageKey is a JSON number, not a string",
        packageKey: "123",
        mutate: (pkg) => {
          pkg.packageKey = 123;
        },
        expectedMessage: "Declared package key does not match package content",
        rejectsAtImport: true,
      },
      {
        // studyDays elements must be JSON numbers. jsonb_array_elements_text
        // stringifies every element regardless of its real type, so
        // ["1","3","5"] would otherwise cast straight through to integers
        // and be silently accepted even though coursePackageSchema's
        // z.number().int() requires each element to already be a number.
        name: "schedulingDefaults.studyDays elements are strings, not numbers",
        packageKey: "adversarial-parity-studydays-string-elements",
        mutate: (pkg) => {
          const schedulingDefaults = pkg.schedulingDefaults as Record<
            string,
            unknown
          >;
          schedulingDefaults.studyDays = ["1", "3", "5"];
        },
        expectedMessage:
          "schedulingDefaults.studyDays elements must be numbers",
      },
    ];

    it.each(PARITY_CASES)(
      "rejects both in TypeScript and via direct DB validation: $name",
      async ({ packageKey, mutate, expectedMessage, rejectsAtImport }) => {
        const pkg = JSON.parse(
          JSON.stringify(buildPackage({ packageKey })),
        ) as Record<string, unknown>;
        mutate(pkg);

        // This is what keeps the table a genuine parity check rather than
        // two independently maintained lists that can silently drift apart:
        // every row must be a mutation the TypeScript contract itself
        // already rejects.
        expect(coursePackageSchema.safeParse(pkg).success).toBe(false);

        await asAuth(adminAuth);
        const importSql = `select public.import_course_package($1,$2,$3,$4::jsonb,$5) as id`;
        const importParams = [
          pkg.packageKey,
          pkg.packageRevision,
          pkg.schemaVersion,
          JSON.stringify(pkg),
          "Import deliberately mutated package",
        ];

        if (rejectsAtImport) {
          // A stricter, equally valid place to reject this mutation: no row
          // is ever inserted, so there is nothing to drive toward VALIDATED
          // at all. import_course_package's own identity-binding check is
          // rejecting it, not assert_full_package_valid.
          await expect(db.query(importSql, importParams)).rejects.toThrow(
            expectedMessage,
          );
          await resetRole();
          return;
        }

        const importResult = await db.query<{ id: string }>(
          importSql,
          importParams,
        );
        const importId = importResult.rows[0].id;

        await expect(
          db.query(
            "select public.mark_course_package_validated($1,$2::jsonb,$3)",
            [
              importId,
              JSON.stringify({ valid: true, report: { forged: true } }),
              "Forged validation claim bypassing TypeScript",
            ],
          ),
        ).rejects.toThrow(expectedMessage);
        await resetRole();

        const status = await db.query<{ status: string }>(
          "select status from public.course_package_imports where id=$1",
          [importId],
        );
        expect(status.rows[0].status).toBe("IMPORTED");
      },
    );
  });
});
