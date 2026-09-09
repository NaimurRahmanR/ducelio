import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import { capabilityNameSchema } from "@/domain/academic-capabilities";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
import { invokeProfessorCapability } from "@/server/academic-capabilities";
import { getOwnedStudentEnrolment } from "@/server/academy";

let db: PGlite;
const studentId = "10000000-0000-4000-8000-000000000001";
const adminId = "10000000-0000-4000-8000-000000000002";
const otherStudentId = "10000000-0000-4000-8000-000000000003";
const studentAuth = "81000000-0000-4000-8000-000000000001";
const adminAuth = "81000000-0000-4000-8000-000000000002";
const otherAuth = "81000000-0000-4000-8000-000000000003";
const programmeId = "20000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000002";
const lessonId = "40000000-0000-4000-8000-000000000001";
const cohortId = "50000000-0000-4000-8000-000000000001";
const secondVersion = "21000000-0000-4000-8000-000000000002";
const secondModule = "31000000-0000-4000-8000-000000000001";
const secondLesson = "41000000-0000-4000-8000-000000000001";
const thirdLesson = "41000000-0000-4000-8000-000000000002";
const secondCohort = "51000000-0000-4000-8000-000000000001";
const missingId = "91000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let otherEnrolment: string;
let secondEnrolment: string;
let assessmentId: string;
const state: CapabilityDbState = { authUser: null, calls: [] };

async function asUser(authId: string | null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId ?? "",
  ]);
  state.authUser = authId
    ? { id: authId, email_confirmed_at: "2026-09-01T00:00:00Z" }
    : null;
  await db.exec("set role authenticated");
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  for (const [authId, appId, email] of [
    [studentAuth, studentId, "student"],
    [adminAuth, adminId, "admin"],
    [otherAuth, otherStudentId, "other"],
  ]) {
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [authId, `${email}@capability.test`],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [authId, appId],
    );
  }
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [adminId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Second enrolled version')",
    [secondVersion, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Second module',1)",
    [secondModule, secondVersion],
  );
  await db.query(
    "insert into public.lessons(id,module_id,programme_version_id,title,position) values($1,$2,$3,'Second lesson',1),($4,$2,$3,'Third lesson',2)",
    [secondLesson, secondModule, secondVersion, thirdLesson],
  );
  await db.query(
    "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) select $1,$2,'Bounded objective ' || n,n from generate_series(1,55) n",
    [secondLesson, secondVersion],
  );
  await db.query(
    "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Different lesson objective sentinel',1)",
    [thirdLesson, secondVersion],
  );
  await asUser(adminAuth);
  await db.query(
    "select public.publish_programme_version($1,'Reviewed capability test curriculum')",
    [secondVersion],
  );
  await db.exec("reset role");
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Second cohort','2026-09-01')",
    [secondCohort, secondVersion],
  );
  await asUser(adminAuth);
  const other = await db.query<{ id: string }>(
    "select public.create_enrolment($1,$2,'Other learner fixture') as id",
    [otherStudentId, cohortId],
  );
  otherEnrolment = other.rows[0].id;
  const second = await db.query<{ id: string }>(
    "select public.create_enrolment($1,$2,'Second enrolled version fixture') as id",
    [studentId, secondCohort],
  );
  secondEnrolment = second.rows[0].id;
  const own = await db.query<{ id: string }>(
    "select id from public.enrolments where student_id=$1 and cohort_id=$2",
    [studentId, cohortId],
  );
  enrolmentId = own.rows[0].id;
  const assessment = await db.query<{ id: string }>(
    "select public.create_assessment($1,$2,$3,'Controlled fixture','Independent work',now()-interval '1 hour',now()+interval '2 hours',60,1,'Capability firewall fixture') as id",
    [cohortId, lessonId, adminId],
  );
  assessmentId = assessment.rows[0].id;
  await db.query(
    "select public.add_assessment_question($1,1,'Protected prompt sentinel',10,'Protected answer sentinel','Protected guidance sentinel','Reviewed fixture question')",
    [assessmentId],
  );
  await db.query(
    "select public.change_assessment_status($1,'PUBLISHED','Ready for firewall checks')",
    [assessmentId],
  );
  await db.exec("reset role");
});

beforeEach(async () => {
  await db.exec("begin");
  state.calls = [];
  state.failTable = undefined;
  state.failRpc = undefined;
  mocks.client.mockImplementation(async () => capabilityDbClient(db, state));
  await asUser(studentAuth);
});
afterEach(async () => {
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db?.close();
});

describe("Professor reads through Academy OS services and PostgreSQL RLS", () => {
  it("returns only the authenticated learner's own version-bound context", async () => {
    expect(await getOwnedStudentEnrolment({ enrolmentId })).toMatchObject({
      enrolmentId,
    });
    const result = await invokeProfessorCapability({
      capability: "get_current_learner_context",
      input: { enrolmentId },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        enrolmentId,
        programmeVersionId: versionId,
        cohortId,
        enrolmentStatus: "ACTIVE",
      },
      provenance: {
        actor_user_id: studentId,
        authorized_scope: {
          student_user_id: studentId,
          enrolment_id: enrolmentId,
          programme_version_id: versionId,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /student_number|preferred_contact|study_goal|auth_user_id|recorded_by/,
    );
  });

  it("loads matching lesson and objectives without neighbouring lesson content", async () => {
    const lesson = await invokeProfessorCapability({
      capability: "get_lesson_context",
      input: { enrolmentId, lessonId },
    });
    expect(lesson).toMatchObject({
      ok: true,
      data: { lessonId, programmeVersionId: versionId },
    });
    const objectives = await invokeProfessorCapability({
      capability: "get_lesson_objectives",
      input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
    });
    expect(objectives.ok).toBe(true);
    expect(JSON.stringify(objectives)).not.toContain(
      "Different lesson objective sentinel",
    );
    expect(
      state.calls
        .filter((call) => call.rpc === "assert_academic_action_allowed")
        .every((call) => call.args?.p_action === "EXPLAIN"),
    ).toBe(true);
  });

  it("pages objectives in stable bounded position order", async () => {
    const first = await invokeProfessorCapability({
      capability: "get_lesson_objectives",
      input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected objective page");
    expect(first.data.objectives).toHaveLength(50);
    expect(first.data.nextAfterPosition).toBe(50);
    const second = await invokeProfessorCapability({
      capability: "get_lesson_objectives",
      input: {
        enrolmentId: secondEnrolment,
        lessonId: secondLesson,
        afterPosition: first.data.nextAfterPosition!,
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected final page");
    expect(
      second.data.objectives.map((objective) => objective.position),
    ).toEqual([51, 52, 53, 54, 55]);
    expect(second.data.nextAfterPosition).toBeNull();
  });

  it("denies foreign and missing enrolments identically", async () => {
    for (const target of [otherEnrolment, missingId]) {
      for (const capability of [
        "get_current_learner_context",
        "get_lesson_context",
        "get_lesson_objectives",
      ]) {
        const result = await invokeProfessorCapability({
          capability,
          input: {
            enrolmentId: target,
            ...(capability === "get_current_learner_context"
              ? {}
              : { lessonId }),
          },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "NOT_FOUND_OR_FORBIDDEN" },
        });
        expect(JSON.stringify(result)).not.toContain(target);
      }
    }
  });

  it("does not inherit administrator visibility for a multi-role STUDENT", async () => {
    await db.exec("reset role");
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'PLATFORM_ADMIN'),($1,'REGISTRAR'),($1,'INSTRUCTOR'),($1,'COUNSELLOR')",
      [studentId],
    );
    await asUser(studentAuth);
    expect(
      (
        await db.query("select id from public.enrolments where id=$1", [
          otherEnrolment,
        ])
      ).rows,
    ).toHaveLength(1);
    const own = await invokeProfessorCapability({
      capability: "get_actor_context",
      input: {},
    });
    expect(own).toMatchObject({
      ok: true,
      data: {
        actor_user_id: studentId,
        effective_institutional_role: "STUDENT",
      },
    });
    for (const capability of [
      "get_current_learner_context",
      "get_lesson_context",
      "get_lesson_objectives",
    ]) {
      expect(
        await invokeProfessorCapability({
          capability,
          input: {
            enrolmentId: otherEnrolment,
            ...(capability === "get_current_learner_context"
              ? {}
              : { lessonId }),
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND_OR_FORBIDDEN" } });
    }
  });

  it("rejects a lesson from another version even when the learner owns both enrolments", async () => {
    for (const capability of ["get_lesson_context", "get_lesson_objectives"]) {
      for (const pair of [
        { enrolmentId, lessonId: secondLesson },
        { enrolmentId: secondEnrolment, lessonId },
      ]) {
        expect(
          await invokeProfessorCapability({ capability, input: pair }),
        ).toMatchObject({
          ok: false,
          error: { code: "NOT_FOUND_OR_FORBIDDEN" },
        });
      }
    }
  });

  it("cannot supply an objective or version to override the owned lesson relationship", async () => {
    const foreignObjective = await db.query<{ id: string }>(
      "select id from public.lesson_objectives where lesson_id=$1",
      [thirdLesson],
    );
    for (const extra of [
      { objectiveId: foreignObjective.rows[0].id },
      { programmeVersionId: secondVersion },
    ]) {
      expect(
        await invokeProfessorCapability({
          capability: "get_lesson_objectives",
          input: { enrolmentId, lessonId, ...extra },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it.each(["PAUSED", "WITHDRAWN", "COMPLETED"])(
    "preserves curriculum reads for own %s enrolment history",
    async (status) => {
      await db.exec("reset role");
      await db.query("update public.enrolments set status=$1 where id=$2", [
        status,
        enrolmentId,
      ]);
      await asUser(studentAuth);
      expect(
        await invokeProfessorCapability({
          capability: "get_current_learner_context",
          input: { enrolmentId },
        }),
      ).toMatchObject({
        ok: true,
        data: { enrolmentStatus: status, programmeVersionId: versionId },
      });
      expect(
        (
          await invokeProfessorCapability({
            capability: "get_lesson_objectives",
            input: { enrolmentId, lessonId },
          })
        ).ok,
      ).toBe(true);
    },
  );

  it("keeps published/enrolled objectives immutable", async () => {
    await db.exec("reset role; savepoint curriculum_guard");
    await expect(
      db.query(
        "update public.lesson_objectives set description='Changed objective' where lesson_id=$1",
        [lessonId],
      ),
    ).rejects.toThrow("immutable");
    await db.exec("rollback to savepoint curriculum_guard");
  });

  it("blocks all academic-content reads during an actual controlled attempt, including multi-role users", async () => {
    await db.exec("reset role");
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [studentId],
    );
    await asUser(studentAuth);
    await db.query("select public.start_assessment_attempt($1)", [
      assessmentId,
    ]);
    for (const capability of [
      "get_current_learner_context",
      "get_lesson_context",
      "get_lesson_objectives",
    ]) {
      state.calls = [];
      const result = await invokeProfessorCapability({
        capability,
        input: {
          enrolmentId,
          ...(capability === "get_current_learner_context" ? {} : { lessonId }),
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      expect(
        state.calls.some((call) =>
          ["enrolments", "lessons", "lesson_objectives"].includes(
            call.table ?? "",
          ),
        ),
      ).toBe(false);
    }
    expect(
      (
        await invokeProfessorCapability({
          capability: "get_actor_context",
          input: {},
        })
      ).ok,
    ).toBe(true);
    const permissions = await invokeProfessorCapability({
      capability: "get_activity_permissions",
      input: {},
    });
    expect(permissions).toMatchObject({
      ok: true,
      data: {
        activity_state: "CONTROLLED_ASSESSMENT_ACTIVE",
        informational_only: true,
        permissions: {
          get_lesson_context: false,
          get_lesson_objectives: false,
          get_current_learner_context: false,
        },
      },
    });
    expect(JSON.stringify(permissions)).not.toMatch(
      /Protected|assessment_id|prompt|answer/,
    );
  });

  it("rechecks an earlier allowed snapshot after an assessment starts", async () => {
    expect(
      await invokeProfessorCapability({
        capability: "get_activity_permissions",
        input: {},
      }),
    ).toMatchObject({
      ok: true,
      data: { permissions: { get_lesson_context: true } },
    });
    await db.query("select public.start_assessment_attempt($1)", [
      assessmentId,
    ]);
    expect(
      await invokeProfessorCapability({
        capability: "get_lesson_context",
        input: { enrolmentId, lessonId },
      }),
    ).toMatchObject({ ok: false, error: { code: "ACTIVITY_BLOCKED" } });
  });

  it("normalizes actual read/RPC failures without leaking database details", async () => {
    for (const table of [
      "app_users",
      "role_grants",
      "enrolments",
      "lessons",
      "lesson_objectives",
    ]) {
      state.failTable = table;
      const result = await invokeProfessorCapability({
        capability: "get_lesson_objectives",
        input: { enrolmentId, lessonId },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(result)).not.toContain(
        "Private database error sentinel",
      );
    }
    state.failTable = undefined;
    state.failRpc = "assert_academic_action_allowed";
    expect(
      await invokeProfessorCapability({
        capability: "get_lesson_context",
        input: { enrolmentId, lessonId },
      }),
    ).toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("rejects unauthenticated, unverified and non-student principals using the real identity service", async () => {
    await asUser(null);
    expect(
      await invokeProfessorCapability({
        capability: "get_actor_context",
        input: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    await asUser(studentAuth);
    state.authUser!.email_confirmed_at = null;
    expect(
      await invokeProfessorCapability({
        capability: "get_actor_context",
        input: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    await asUser(adminAuth);
    for (const capability of capabilityNameSchema.options) {
      expect(
        await invokeProfessorCapability({ capability, input: {} }),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("does not retain a revoked STUDENT role across invocations", async () => {
    expect(
      (
        await invokeProfessorCapability({
          capability: "get_actor_context",
          input: {},
        })
      ).ok,
    ).toBe(true);
    await db.exec("reset role");
    await db.query(
      "delete from public.role_grants where user_id=$1 and role='STUDENT'",
      [studentId],
    );
    await asUser(studentAuth);
    expect(
      await invokeProfessorCapability({
        capability: "get_actor_context",
        input: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
