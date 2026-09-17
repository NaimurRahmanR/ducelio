import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import { buildPackage } from "./activation-fixture";
import {
  validateCoursePackage,
  type CoursePackage,
} from "@/domain/course-package";
import { operatorPreviewSchema } from "@/domain/course-engineering-admin";
const real: CoursePackage = JSON.parse(
  readFileSync("content/courses/security-plus-sy0-701/package.json", "utf8"),
);
const migration = readFileSync(
  "supabase/migrations/202609170037_commercial_v1_cumulative_assessment.sql",
  "utf8",
);
const admin = "10000000-0000-4000-8000-000000000002";
const auth = "84000000-0000-4000-8000-000000000002";
async function user(db: PGlite) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [auth]);
  await db.exec("set role authenticated");
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function rpc<T = string>(db: PGlite, sql: string, args: unknown[] = []) {
  await user(db);
  return value<T>(db, sql, args);
}
async function setup(db: PGlite) {
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'sec701-admin@test.example',now())",
    [auth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [auth, admin],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [admin],
  );
}
async function imported(db: PGlite, p: CoursePackage) {
  return rpc(
    db,
    "select public.import_course_package($1,$2,$3,$4::jsonb,'SEC701 integration import') as v",
    [p.packageKey, p.packageRevision, p.schemaVersion, JSON.stringify(p)],
  );
}
async function validate(db: PGlite, id: string, p: CoursePackage) {
  const v = validateCoursePackage(p);
  if (!v.valid) throw new Error("Invalid fixture");
  await rpc(
    db,
    "select public.mark_course_package_validated($1,$2::jsonb,'SEC701 validation') as v",
    [id, JSON.stringify(v.report)],
  );
}
async function configure(
  db: PGlite,
  version: string,
  p: CoursePackage,
  notes?: string,
) {
  for (const [role, c] of Object.entries(p.agentConfiguration))
    await rpc(
      db,
      "select public.set_agent_config($1,$2,$3,$4,$5,$6::text[],$7,'SEC701 explicit approval') as v",
      [
        version,
        role,
        c.enabled,
        c.modelProfileRef,
        notes ?? c.instructionalNotes,
        c.capabilities,
        c.escalationPolicy,
      ],
    );
}
async function testRun(db: PGlite, id: string) {
  return rpc(
    db,
    "select outcome as v from public.run_course_package_test($1,'SEC701 readiness test')",
    [id],
  );
}
async function publish(db: PGlite, id: string) {
  return rpc(
    db,
    "select public.publish_course_package($1,'SEC701 publication') as v",
    [id],
  );
}
async function status(db: PGlite, id: string) {
  await owner(db);
  return value(
    db,
    "select status as v from public.course_package_imports where id=$1",
    [id],
  );
}
async function activate(
  db: PGlite,
  id: string,
  version: string,
  p: CoursePackage,
) {
  await owner(db);
  const cohort = randomUUID();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'SEC701 acceptance cohort','2040-01-01')",
    [cohort, version],
  );
  const assignments = p.assignmentTemplates.map((t) => ({
    templateKey: t.key,
    opensAt: "2040-01-01T00:00:00Z",
    dueAt: "2040-12-01T00:00:00Z",
  }));
  const assessments = p.assessmentTemplates.map((t, i) => ({
    templateKey: t.key,
    opensAt: `2040-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    closesAt: `2040-02-${String(i + 1).padStart(2, "0")}T23:00:00Z`,
  }));
  const args = [
    id,
    cohort,
    admin,
    JSON.stringify(assignments),
    JSON.stringify(assessments),
  ];
  const sql =
    "select public.activate_course_package($1,$2,$3,$4::jsonb,$5::jsonb,'SEC701 governed activation') as v";
  const receipt = await rpc(db, sql, args);
  expect(await rpc(db, sql, args)).toBe(receipt);
  return receipt;
}

describe("SEC701-B real Security+ governed lifecycle", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await testDatabase();
    await setup(db);
  });
  afterAll(async () => {
    await db?.close();
  });
  it("imports, validates, previews, applies, explicitly configures, tests, publishes, activates and publishes component/result policies", async () => {
    const id = await imported(db, real);
    expect(await status(db, id)).toBe("IMPORTED");
    await validate(db, id, real);
    expect(await status(db, id)).toBe("VALIDATED");
    await user(db);
    const preview = (
      await db.query<{ preview: unknown }>(
        "select * from public.get_course_package_preview($1)",
        [id],
      )
    ).rows[0].preview;
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("expectedAnswer");
    expect(serialized).not.toContain("markingGuidance");
    const safe = JSON.stringify(operatorPreviewSchema.parse(preview));
    for (const q of real.assessmentTemplates.flatMap((t) => t.questions)) {
      expect(serialized).not.toContain(q.expectedAnswer);
      expect(safe).not.toContain(q.prompt);
    }
    const version = await rpc(
      db,
      "select public.apply_course_package($1,'SEC701 apply') as v",
      [id],
    );
    expect(await status(db, id)).toBe("APPLIED");
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.academic_agent_configs where programme_version_id=$1",
        [version],
      ),
    ).toBe(0);
    await expect(publish(db, id)).rejects.toThrow(
      "passing pre-publication test",
    );
    await configure(db, version, real);
    expect(await testRun(db, id)).toBe("PASS");
    await owner(db);
    const courseModule = (
      await db.query<{ id: string; title: string }>(
        "select id,title from public.modules where programme_version_id=$1 order by position limit 1",
        [version],
      )
    ).rows[0];
    await db.query(
      "update public.modules set title='Local drift test' where id=$1",
      [courseModule.id],
    );
    expect(
      await rpc(
        db,
        "select status as v from public.get_course_package_test_status($1)",
        [id],
      ),
    ).toBe("PASSED_STALE");
    await expect(publish(db, id)).rejects.toThrow(
      "passing pre-publication test",
    );
    expect(await testRun(db, id)).toBe("FAIL");
    await owner(db);
    await db.query("update public.modules set title=$1 where id=$2", [
      courseModule.title,
      courseModule.id,
    ]);
    // Uploaded package identity/content is immutable, rather than mutable drift.
    await expect(
      db.query(
        "update public.course_package_imports set raw_package=jsonb_set(raw_package,'{assessmentTemplates,5,questions,0,lessonRef}',to_jsonb('lesson-5-6'::text)) where id=$1",
        [id],
      ),
    ).rejects.toThrow();
    // The exact existing semantic fingerprint rule: drift makes PASS stale;
    // restoring the exact saved state makes the original PASS current again.
    await configure(db, version, real, "Deliberate local configuration drift");
    expect(
      await rpc(
        db,
        "select status as v from public.get_course_package_test_status($1)",
        [id],
      ),
    ).toBe("PASSED_STALE");
    await expect(publish(db, id)).rejects.toThrow(
      "passing pre-publication test",
    );
    await configure(db, version, real);
    expect(
      await rpc(
        db,
        "select status as v from public.get_course_package_test_status($1)",
        [id],
      ),
    ).toBe("PASSED_CURRENT");
    await publish(db, id);
    expect(await status(db, id)).toBe("PUBLISHED");
    const activation = await activate(db, id, version, real);
    await owner(db);
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.modules where programme_version_id=$1",
        [version],
      ),
    ).toBe(5);
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.course_activation_lessons where import_id=$1 and programme_version_id=$2",
        [id, version],
      ),
    ).toBe(28);
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.course_practicals where import_id=$1",
        [id],
      ),
    ).toBe(14);
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.course_assignment_bindings where activation_id=$1",
        [activation],
      ),
    ).toBe(3);
    const assessments = (
      await db.query<{ assessment_id: string; template_key: string }>(
        "select assessment_id,template_key from public.course_assessment_bindings where activation_id=$1",
        [activation],
      )
    ).rows;
    expect(assessments).toHaveLength(6);
    const final = assessments.find(
      (a) => a.template_key === "final",
    )!.assessment_id;
    const provenance = await db.query<{
      anchor: string;
      source: string;
      module_key: string;
      objective_key: string;
      position: number;
    }>(
      `select a.local_key anchor,s.local_key source,s.module_key,o.local_key objective_key,q.position
    from public.course_assessment_objectives co
    join public.course_activation_lessons a on a.import_id=co.import_id and a.lesson_id=co.lesson_id
    join public.course_activation_lessons s on s.import_id=co.import_id and s.lesson_id=co.objective_lesson_id
    join public.course_activation_objectives o on o.import_id=co.import_id and o.objective_id=co.objective_id and o.lesson_id=co.objective_lesson_id
    join public.assessment_questions q on q.id=co.question_id
    where co.assessment_id=$1 order by q.position`,
      [final],
    );
    expect(provenance.rows).toHaveLength(10);
    expect(new Set(provenance.rows.map((r) => r.source)).size).toBe(10);
    expect(new Set(provenance.rows.map((r) => r.module_key)).size).toBe(5);
    for (const row of provenance.rows) {
      const q = real.assessmentTemplates.find((t) => t.key === "final")!
        .questions[row.position - 1];
      expect(row.anchor).toBe("lesson-5-6");
      expect(row.source).toBe(q.lessonRef);
      expect(q.objectiveRefs).toContain(row.objective_key);
    }
    // Relational adversaries: preserve the anchor, exact source and question scope.
    const mappings = (
      await db.query<{
        question_id: string;
        assessment_id: string;
        import_id: string;
        lesson_id: string;
        programme_version_id: string;
        objective_id: string;
        objective_lesson_id: string;
      }>(
        "select co.* from public.course_assessment_objectives co join public.assessment_questions q on q.id=co.question_id where co.assessment_id=$1 order by q.position",
        [final],
      )
    ).rows;
    const a = mappings[0],
      b = mappings[1];
    const insert =
      "insert into public.course_assessment_objectives(question_id,assessment_id,import_id,lesson_id,programme_version_id,objective_id,objective_lesson_id) values($1,$2,$3,$4,$5,$6,$7)";
    await expect(
      db.query(insert, [
        a.question_id,
        final,
        id,
        a.lesson_id,
        version,
        b.objective_id,
        a.objective_lesson_id,
      ]),
    ).rejects.toThrow("course_assessment_objective_source_fkey");
    await expect(
      db.query(insert, [
        a.question_id,
        final,
        id,
        a.objective_lesson_id,
        version,
        b.objective_id,
        b.objective_lesson_id,
      ]),
    ).rejects.toThrow(
      "course_assessment_objectives_assessment_id_import_id_lesso_fkey",
    );
    await expect(
      db.query(insert, [
        randomUUID(),
        final,
        id,
        a.lesson_id,
        version,
        b.objective_id,
        b.objective_lesson_id,
      ]),
    ).rejects.toThrow(
      "course_assessment_objectives_question_id_assessment_id_fkey",
    );
    const keys = (
      await db.query<{ expected_answer: string; marking_guidance: string }>(
        "select k.expected_answer,k.marking_guidance from public.assessment_answer_keys k join public.assessment_questions q on q.id=k.question_id where q.assessment_id=$1 order by q.position",
        [final],
      )
    ).rows;
    expect(keys.map((k) => k.expected_answer)).toEqual(
      real.assessmentTemplates
        .find((t) => t.key === "final")!
        .questions.map((q) => q.expectedAnswer),
    );
    const before = await value(
      db,
      "select jsonb_agg(to_jsonb(co) order by question_id,objective_id) as v from public.course_assessment_objectives co where assessment_id=$1",
      [final],
    );
    const components = [
      "QUIZ_1",
      "QUIZ_2",
      "MIDTERM",
      "QUIZ_3",
      "QUIZ_4",
      "FINAL",
    ];
    for (let i = 0; i < components.length; i++) {
      const key = ["quiz-1", "quiz-2", "midterm", "quiz-3", "quiz-4", "final"][
        i
      ];
      await rpc(
        db,
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,'SEC701 explicit component binding') as v",
        [
          activation,
          components[i],
          assessments.find((a) => a.template_key === key)!.assessment_id,
        ],
      );
    }
    await rpc(
      db,
      "select public.publish_commercial_v1_grading_policy($1,'SEC701 grading policy') as v",
      [activation],
    );
    await owner(db);
    const policy = (
      await db.query<{
        resolved_profile: string;
        final_weight_bp: number;
        labs_weight_bp: number;
      }>(
        "select * from public.commercial_v1_grading_policies where activation_id=$1",
        [activation],
      )
    ).rows[0];
    expect(policy.resolved_profile).toBe("WITH_LABS");
    expect(policy.final_weight_bp).toBe(4000);
    expect(policy.labs_weight_bp).toBe(2000);
    const labs = (
      await db.query<{ id: string }>(
        "select id from public.course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
        [id],
      )
    ).rows;
    expect(labs).toHaveLength(10);
    for (const lab of labs)
      await rpc(
        db,
        "select public.set_commercial_v1_lab_policy($1,$2,10,200,'Local test rubric only','SEC701 local lab policy') as v",
        [activation, lab.id],
      );
    await rpc(
      db,
      "select public.publish_commercial_v1_result_policy($1,7000,true,'SEC701 local result policy') as v",
      [activation],
    );
    await owner(db);
    expect(
      await value<number>(
        db,
        "select count(*)::int as v from public.commercial_v1_result_policies where activation_id=$1",
        [activation],
      ),
    ).toBe(1);
    expect(
      await value(
        db,
        "select jsonb_agg(to_jsonb(co) order by question_id,objective_id) as v from public.course_assessment_objectives co where assessment_id=$1",
        [final],
      ),
    ).toEqual(before);
    // Learner JWT uses real identity provisioning; no table grant or staff scope.
    const studentAuth = randomUUID();
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'sec701-student@test.example',now())",
      [studentAuth],
    );
    const studentId = await value(
      db,
      "select id as v from public.app_users where auth_user_id=$1",
      [studentAuth],
    );
    const cohort = await value(
      db,
      "select cohort_id as v from public.course_activations where id=$1",
      [activation],
    );
    await rpc(
      db,
      "select public.create_enrolment($1,$2,'SEC701 owned student enrolment') as v",
      [studentId, cohort],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      studentAuth,
    ]);
    await db.exec("set role authenticated");
    for (const table of [
      "assessment_answer_keys",
      "course_package_imports",
      "course_assessment_objectives",
    ])
      await expect(db.query(`select * from public.${table}`)).rejects.toThrow(
        "permission denied",
      );
    await expect(
      db.query("select * from public.get_course_package_preview($1)", [id]),
    ).rejects.toThrow();
    await expect(
      db.query("select * from public.get_active_assessment_questions($1)", [
        final,
      ]),
    ).rejects.toThrow();
    // PGlite uses JS Date: simulate the real final window without a sleep or
    // rewriting institutional timestamps. No provider executes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2040-02-06T01:00:00Z"));
    try {
      const attempt = await value(
        db,
        "select public.start_assessment_attempt($1) as v",
        [final],
      );
      expect(attempt).toBeTruthy();
      const questions = await db.query(
        "select * from public.get_active_assessment_questions($1)",
        [final],
      );
      expect(questions.rows).toHaveLength(10);
      const learnerView = JSON.stringify(questions.rows);
      expect(learnerView).not.toContain("expected_answer");
      expect(learnerView).not.toContain("marking_guidance");
      for (const key of keys) {
        expect(learnerView).not.toContain(key.expected_answer);
        expect(learnerView).not.toContain(key.marking_guidance);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("migration 037 staged upgrade and independent DB validation", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await testDatabase({ throughMigration: 36 });
    await setup(db);
  });
  afterAll(async () => {
    await db?.close();
  });
  it("backfills real historical activation rows without altering old fields/content and restores immutability", async () => {
    const p = buildPackage();
    const id = await imported(db, p);
    await validate(db, id, p);
    const version = await rpc(
      db,
      "select public.apply_course_package($1,'Legacy apply') as v",
      [id],
    );
    await configure(db, version, p);
    expect(await testRun(db, id)).toBe("PASS");
    await publish(db, id);
    await activate(db, id, version, p);
    await owner(db);
    const before = (
      await db.query(
        "select * from public.course_assessment_objectives order by question_id,objective_id",
      )
    ).rows;
    expect(before.length).toBeGreaterThan(0);
    const raw = await value(
      db,
      "select raw_package as v from public.course_package_imports where id=$1",
      [id],
    );
    const keys = (
      await db.query(
        "select * from public.assessment_answer_keys order by question_id",
      )
    ).rows;
    const draft = buildPackage({ packageKey: "legacy-stored-draft" });
    const draftId = await imported(db, draft);
    await owner(db);
    await db.exec(migration);
    await validate(db, draftId, draft);
    expect(await status(db, draftId)).toBe("VALIDATED");
    const after = (
      await db.query<{ lesson_id: string; objective_lesson_id: string }>(
        "select * from public.course_assessment_objectives order by question_id,objective_id",
      )
    ).rows;
    expect(
      after.map(({ objective_lesson_id, ...old }) => {
        expect(objective_lesson_id).toBe(old.lesson_id);
        return old;
      }),
    ).toEqual(before);
    expect(
      (
        await db.query(
          "select * from public.assessment_answer_keys order by question_id",
        )
      ).rows,
    ).toEqual(keys);
    expect(
      await value(
        db,
        "select raw_package as v from public.course_package_imports where id=$1",
        [id],
      ),
    ).toEqual(raw);
    await db.query(
      "select course_engineering_private.assert_full_package_valid($1,1,'COURSE_PACKAGE_V1',$2::jsonb)",
      [p.packageKey, JSON.stringify(raw)],
    );
    expect(
      await value(
        db,
        "select tgenabled as v from pg_trigger where tgrelid='public.course_assessment_objectives'::regclass and tgname='activation_immutable'",
      ),
    ).toBe("O");
    await expect(
      db.exec(
        "update public.course_assessment_objectives set objective_lesson_id=lesson_id",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.exec("delete from public.course_assessment_objectives"),
    ).rejects.toThrow("immutable");
  });
  it.each([
    "unknown-lesson",
    "wrong-objective",
    "omitted-source",
    "duplicate",
    "null",
    "extra-field",
    "cross-role",
    "professor-null",
  ])("DB independently rejects %s", async (kind) => {
    const p = structuredClone(real);
    const q = p.assessmentTemplates.find((t) => t.key === "final")!
      .questions[0];
    if (kind === "unknown-lesson") q.lessonRef = "missing";
    if (kind === "wrong-objective") q.lessonRef = "lesson-5-6";
    if (kind === "omitted-source") delete q.lessonRef;
    if (kind === "duplicate") q.objectiveRefs.push(q.objectiveRefs[0]);
    if (kind === "null") Object.assign(q, { lessonRef: null });
    if (kind === "extra-field") Object.assign(q, { unreviewed: true });
    if (kind === "cross-role")
      p.agentConfiguration.EXAMINER.modelProfileRef = "TUTOR_COMMERCIAL_V1";
    if (kind === "professor-null")
      p.agentConfiguration.PROFESSOR.modelProfileRef = null;
    await owner(db);
    await expect(
      db.query(
        "select course_engineering_private.assert_full_package_valid($1,$2,$3,$4::jsonb)",
        [p.packageKey, p.packageRevision, p.schemaVersion, JSON.stringify(p)],
      ),
    ).rejects.toThrow();
  });
  it("materialises cumulative questions against lesson-scoped reused keys without conflating UUIDs", async () => {
    const p = buildPackage({ packageKey: "reused-cumulative-keys" });
    const second = structuredClone(p.modules[0].lessons[0]);
    second.key = "lesson-2";
    second.position = 2;
    second.objectives[0].description =
      "Different objective with the same local key";
    p.modules[0].lessons.push(second);
    p.assessmentTemplates[0].questions.push({
      ...structuredClone(p.assessmentTemplates[0].questions[0]),
      position: 2,
      lessonRef: "lesson-2",
    });
    const id = await imported(db, p);
    await validate(db, id, p);
    const version = await rpc(
      db,
      "select public.apply_course_package($1,'Reused keys apply') as v",
      [id],
    );
    await configure(db, version, p);
    expect(await testRun(db, id)).toBe("PASS");
    await publish(db, id);
    await activate(db, id, version, p);
    await owner(db);
    const rows = (
      await db.query<{
        lesson_id: string;
        objective_lesson_id: string;
        objective_id: string;
      }>(
        "select * from public.course_assessment_objectives where import_id=$1",
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.lesson_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.objective_lesson_id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.objective_id)).size).toBe(2);
  });
  it("preserves effective table/column ACLs and public/private function execution rights", async () => {
    await owner(db);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await value<boolean>(
          db,
          "select has_table_privilege($1,'public.course_assessment_objectives','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value<boolean>(
          db,
          "select has_any_column_privilege($1,'public.course_assessment_objectives','SELECT,INSERT,UPDATE,REFERENCES') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value<boolean>(
          db,
          "select has_function_privilege($1,'course_engineering_private.assert_full_package_valid(text,integer,text,jsonb)','EXECUTE') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value<boolean>(
          db,
          "select has_function_privilege($1,'public.activate_course_package(uuid,uuid,uuid,jsonb,jsonb,text)','EXECUTE') as v",
          [role],
        ),
      ).toBe(role === "authenticated");
    }
  });
});
