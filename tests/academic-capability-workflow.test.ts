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
let secondObjective: string;
let anotherObjective: string;
let baseObjective: string;
let historySession: string;
const foreignCohort = "51000000-0000-4000-8000-000000000002";
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
  await db.query(
    "insert into public.learning_resources(lesson_id,programme_version_id,kind,title,body,position,created_by) select $1,$2,'LECTURE_NOTE','Note ' || n,repeat('N',12000),n,$3 from generate_series(1,5) n",
    [secondLesson, secondVersion, adminId],
  );
  await db.query(
    "insert into public.learning_resources(lesson_id,programme_version_id,kind,title,url,position,created_by) values($1,$2,'REFERENCE_LINK','Safe reference','https://example.com/reviewed',6,$3)",
    [secondLesson, secondVersion, adminId],
  );
  await db.query(
    "insert into public.learning_resources(lesson_id,programme_version_id,kind,title,body,position,created_by) values($1,$2,'LECTURE_NOTE','Neighbour note','Neighbour resource sentinel',1,$3)",
    [thirdLesson, secondVersion, adminId],
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
  const objectives = await db.query<{ id: string }>(
    "select id from public.lesson_objectives where lesson_id=$1 order by position",
    [secondLesson],
  );
  secondObjective = objectives.rows[0].id;
  anotherObjective = objectives.rows[1].id;
  baseObjective = (
    await db.query<{ id: string }>(
      "select id from public.lesson_objectives where lesson_id=$1 order by position limit 1",
      [lessonId],
    )
  ).rows[0].id;
  const session = await db.query<{ id: string }>(
    "select public.create_class_session($1,$2,$3,now()-interval '4 hours',now()-interval '3 hours','Evidence history fixture') as id",
    [secondCohort, secondLesson, adminId],
  );
  historySession = session.rows[0].id;
  for (let n = 0; n < 30; n++) {
    await db.query(
      "select public.record_learning_evidence($1,$2,$3,'CLASS_RESPONSE','CORRECT','Private evidence-reference sentinel',$4,'Reviewed fixture evidence')",
      [
        historySession,
        secondEnrolment,
        secondObjective,
        `capability-history-${n}`,
      ],
    );
  }
  await db.query(
    "select public.record_learning_evidence($1,$2,$3,'PRACTICAL_TASK','PARTIAL','Sensitive practical reference','other-objective-evidence','Reviewed other objective')",
    [historySession, secondEnrolment, anotherObjective],
  );
  await db.query(
    "select public.change_class_session_status($1,'COMPLETED','Completed history fixture')",
    [historySession],
  );
  const base = await db.query<{ id: string }>(
    "select public.create_class_session($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Base evidence fixture') as id",
    [cohortId, lessonId, adminId],
  );
  for (const [enrolment, key] of [
    [enrolmentId, "own"],
    [otherEnrolment, "foreign"],
  ]) {
    await db.query(
      "select public.record_learning_evidence($1,$2,$3,'RETRIEVAL_CHECK','INCORRECT','Private base reference',$4,'Reviewed base evidence')",
      [base.rows[0].id, enrolment, baseObjective, `base-history-${key}`],
    );
  }
  await db.query(
    "select public.change_class_session_status($1,'COMPLETED','Completed base fixture')",
    [base.rows[0].id],
  );
  await db.exec("reset role");
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Foreign cohort','2026-09-01')",
    [foreignCohort, versionId],
  );
});

beforeEach(async () => {
  await db.exec("begin");
  state.calls = [];
  state.failTable = undefined;
  state.failRpc = undefined;
  state.beforeRead = undefined;
  state.beforeRpc = undefined;
  state.transformRpc = undefined;
  state.transformRows = undefined;
  mocks.client.mockImplementation(async () => capabilityDbClient(db, state));
  await asUser(studentAuth);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.exec("rollback; reset role");
});
afterAll(async () => {
  await db?.close();
});

describe("Professor reads through Academy OS services and PostgreSQL RLS", () => {
  const releaseRequests = [
    "get_current_learner_context",
    "get_lesson_context",
    "get_lesson_objectives",
    "get_current_class_session",
    "get_learning_resources",
    "get_permitted_learning_history",
    "get_current_mastery_state",
  ].map((capability) => () => ({
    capability,
    input: {
      enrolmentId,
      ...([
        "get_current_learner_context",
        "get_current_class_session",
        "get_permitted_learning_history",
      ].includes(capability)
        ? {}
        : { lessonId }),
    },
  }));

  it("keeps a real DB release active through each of the seven services and closes before success", async () => {
    for (const request of releaseRequests) {
      let inspected = false;
      state.beforeRead = async (table) => {
        if (table !== "enrolments" || inspected) return;
        inspected = true;
        await db.exec("reset role");
        expect(
          (
            await db.query(
              "select id from public.academic_content_releases where student_id=$1 and state='ACTIVE'",
              [studentId],
            )
          ).rows,
        ).toHaveLength(1);
        await db.exec("set role authenticated; savepoint release_exclusion");
        await expect(
          db.query("select public.start_assessment_attempt($1)", [
            assessmentId,
          ]),
        ).rejects.toThrow("Academic activity is busy. Retry shortly.");
        await db.exec(
          "rollback to savepoint release_exclusion; release savepoint release_exclusion",
        );
      };
      const result = await invokeProfessorCapability(request());
      expect(result.ok).toBe(true);
      expect(inspected).toBe(true);
      await db.exec("reset role");
      const release = (
        await db.query<{ id: string; state: string }>(
          "select id,state from public.academic_content_releases where invocation_id=$1",
          [result.provenance.invocation_id],
        )
      ).rows[0];
      expect(release.state).toBe("COMPLETED");
      const audit = (
        await db.query<{ action: string; after_state: unknown }>(
          "select action,after_state from public.audit_events where target_type='academic_content_releases' and target_id=$1 order by occurred_at,id",
          [release.id],
        )
      ).rows;
      expect(audit.map((e) => e.action)).toEqual([
        "CONTENT_RELEASE_ACTIVE",
        "CONTENT_RELEASE_COMPLETED",
      ]);
      expect(JSON.stringify(audit)).not.toMatch(
        /sentinel|evidence_reference|recorded_by|body|description|prompt|answer|guidance|summary/,
      );
      await db.exec("set role authenticated");
    }
  });
  it("persists ABORTED for actual service failures and malformed projections", async () => {
    for (const malformed of [false, true]) {
      state.failTable = malformed ? undefined : "lessons";
      state.transformRows = (table, rows) =>
        malformed && table === "lessons"
          ? rows.map((row) => ({ ...row, title: null }))
          : rows;
      const result = await invokeProfessorCapability({
        capability: "get_lesson_context",
        input: { enrolmentId, lessonId },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      await db.exec("reset role");
      expect(
        (
          await db.query<{ state: string }>(
            "select state from public.academic_content_releases where invocation_id=$1",
            [result.provenance.invocation_id],
          )
        ).rows[0].state,
      ).toBe("ABORTED");
      await db.exec("set role authenticated");
    }
  });
  it("discards loaded content if closure fails and leaves only a bounded ACTIVE lease", async () => {
    state.failRpc = "close_academic_content_release";
    const result = await invokeProfessorCapability({
      capability: "get_learning_resources",
      input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(result).not.toHaveProperty("data");
    await db.exec("reset role");
    expect(
      (
        await db.query<{ state: string; seconds: number }>(
          "select state,extract(epoch from expires_at-started_at)::int as seconds from public.academic_content_releases where invocation_id=$1",
          [result.provenance.invocation_id],
        )
      ).rows[0],
    ).toEqual({ state: "ACTIVE", seconds: 30 });
  });
  it("rejects a prematurely completed direct RPC lease even after the final firewall passed", async () => {
    state.beforeRpc = async (name, args) => {
      if (name !== "close_academic_content_release") return;
      await db.query("select public.close_academic_content_release($1,true)", [
        args!.p_release_id,
      ]);
      await db.query("select public.start_assessment_attempt($1)", [
        assessmentId,
      ]);
    };
    const result = await invokeProfessorCapability({
      capability: "get_lesson_context",
      input: { enrolmentId, lessonId },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(result).not.toHaveProperty("data");
  });
  it("the database refuses completion when STUDENT is revoked after the final principal check", async () => {
    state.beforeRpc = async (name) => {
      if (name !== "close_academic_content_release") return;
      await db.exec("reset role");
      await db.query(
        "delete from public.role_grants where user_id=$1 and role='STUDENT'",
        [studentId],
      );
      await db.exec("set role authenticated");
    };
    expect(
      await invokeProfessorCapability({
        capability: "get_lesson_context",
        input: { enrolmentId, lessonId },
      }),
    ).toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
    await db.exec("reset role");
    expect(
      (
        await db.query<{ state: string }>(
          "select state from public.academic_content_releases where student_id=$1",
          [studentId],
        )
      ).rows.map((row) => row.state),
    ).toEqual(["ABORTED"]);
  });
  it.each(["begin_academic_content_release", "close_academic_content_release"])(
    "fails closed on malformed %s backend output",
    async (target) => {
      state.transformRpc = (name, data) =>
        name === target
          ? { ...(data as object), support_prose: "private-sentinel" }
          : data;
      const result = await invokeProfessorCapability({
        capability: "get_lesson_context",
        input: { enrolmentId, lessonId },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(result).not.toHaveProperty("data");
      expect(JSON.stringify(result)).not.toContain("private-sentinel");
      if (target === "begin_academic_content_release")
        expect(state.calls.some((call) => call.table === "lessons")).toBe(
          false,
        );
    },
  );
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

  it("Checkpoint 1C selects CURRENT, UPCOMING and NONE deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));

    await db.exec("reset role");
    const current = await db.query<{ id: string }>(
      "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,status,created_by) values($1,$2,$3,$4,'2030-01-01T11:30:00Z','2030-01-01T12:30:00Z','SCHEDULED',$4) returning id",
      [secondCohort, secondVersion, secondLesson, adminId],
    );
    const upcoming = await db.query<{ id: string }>(
      "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,status,created_by) values($1,$2,$3,$4,'2030-01-01T13:00:00Z','2030-01-01T14:00:00Z','SCHEDULED',$4) returning id",
      [secondCohort, secondVersion, secondLesson, adminId],
    );
    await db.query(
      "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,status,created_by) values($1,$2,$3,$4,'2030-01-01T11:00:00Z','2030-01-01T12:15:00Z','CANCELLED',$4)",
      [secondCohort, secondVersion, secondLesson, adminId],
    );
    await asUser(studentAuth);

    const active = await invokeProfessorCapability({
      capability: "get_current_class_session",
      input: { enrolmentId: secondEnrolment },
    });
    expect(active).toMatchObject({
      ok: true,
      data: {
        selection: "CURRENT",
        session: { sessionId: current.rows[0].id, lessonId: secondLesson },
      },
    });

    await db.exec("reset role");
    await db.query("update public.enrolments set status='PAUSED' where id=$1", [
      secondEnrolment,
    ]);
    await asUser(studentAuth);
    vi.setSystemTime(new Date("2030-01-01T12:45:00.000Z"));

    const paused = await invokeProfessorCapability({
      capability: "get_current_class_session",
      input: { enrolmentId: secondEnrolment },
    });
    expect(paused).toMatchObject({
      ok: true,
      data: {
        selection: "UPCOMING",
        session: { sessionId: upcoming.rows[0].id },
      },
    });

    await db.exec("reset role");
    await db.query(
      "update public.enrolments set status='WITHDRAWN' where id=$1",
      [secondEnrolment],
    );
    await asUser(studentAuth);

    expect(
      await invokeProfessorCapability({
        capability: "get_current_class_session",
        input: { enrolmentId: secondEnrolment },
      }),
    ).toMatchObject({
      ok: true,
      data: { selection: "NONE", session: null },
    });
  });

  it("Checkpoint 1C pages exact-version learning resources and fails closed on oversized content", async () => {
    const first = await invokeProfessorCapability({
      capability: "get_learning_resources",
      input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first resource page");
    expect(first.data.resources).toHaveLength(5);
    expect(first.data.nextCursor).toEqual({ afterPosition: 5 });
    expect(
      first.data.resources.every(
        (resource) =>
          resource.kind === "LECTURE_NOTE" && resource.body.length === 12000,
      ),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Neighbour resource sentinel");

    const second = await invokeProfessorCapability({
      capability: "get_learning_resources",
      input: {
        enrolmentId: secondEnrolment,
        lessonId: secondLesson,
        cursor: first.data.nextCursor!,
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected second resource page");
    expect(second.data.resources).toHaveLength(1);
    expect(second.data.resources[0]).toMatchObject({
      kind: "REFERENCE_LINK",
      position: 6,
      url: "https://example.com/reviewed",
    });
    expect(second.data.nextCursor).toBeNull();

    expect(
      await invokeProfessorCapability({
        capability: "get_learning_resources",
        input: { enrolmentId, lessonId: secondLesson },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND_OR_FORBIDDEN" },
    });

    state.transformRows = (table, rows) =>
      table === "learning_resources"
        ? rows.map((row, index) =>
            index === 0 ? { ...row, body: "X".repeat(12001) } : row,
          )
        : rows;
    expect(
      await invokeProfessorCapability({
        capability: "get_learning_resources",
        input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("Checkpoint 1C returns privacy-minimized learning history with stable cursor pagination", async () => {
    const first = await invokeProfessorCapability({
      capability: "get_permitted_learning_history",
      input: { enrolmentId: secondEnrolment, objectiveId: secondObjective },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first history page");
    expect(first.data.events).toHaveLength(25);
    expect(first.data.nextCursor).not.toBeNull();
    expect(
      first.data.events.every((event) => event.objectiveId === secondObjective),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(
      /Private evidence-reference sentinel|Sensitive practical reference|recorded_by|idempotency_key|evidence_reference/,
    );

    const second = await invokeProfessorCapability({
      capability: "get_permitted_learning_history",
      input: {
        enrolmentId: secondEnrolment,
        objectiveId: secondObjective,
        cursor: first.data.nextCursor!,
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected second history page");
    expect(second.data.events).toHaveLength(5);
    expect(second.data.nextCursor).toBeNull();

    const ids = [
      ...first.data.events.map((event) => event.evidenceId),
      ...second.data.events.map((event) => event.evidenceId),
    ];
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);

    const otherObjective = await invokeProfessorCapability({
      capability: "get_permitted_learning_history",
      input: { enrolmentId: secondEnrolment, objectiveId: anotherObjective },
    });
    expect(otherObjective).toMatchObject({
      ok: true,
      data: {
        objectiveId: anotherObjective,
        events: [
          {
            objectiveId: anotherObjective,
            evidenceKind: "PRACTICAL_TASK",
            result: "PARTIAL",
          },
        ],
      },
    });
  });

  it("Checkpoint 1C reads only persisted lesson mastery and fails on overflow", async () => {
    state.calls = [];
    const result = await invokeProfessorCapability({
      capability: "get_current_mastery_state",
      input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected persisted mastery");
    expect(result.data.persistedOnly).toBe(true);
    expect(result.data.records).toHaveLength(2);

    const primary = result.data.records.find(
      (record) => record.objectiveId === secondObjective,
    );
    expect(primary).toMatchObject({
      state: "DEVELOPING",
      policyVersion: "MASTERY_V1",
      evidenceCount: 30,
      correctEvidenceCount: 30,
      correctSessionCount: 1,
      correctKindCount: 1,
    });
    expect(
      state.calls
        .filter((call) => call.rpc)
        .every((call) =>
          [
            "assert_academic_action_allowed",
            "begin_academic_content_release",
            "close_academic_content_release",
          ].includes(call.rpc!),
        ),
    ).toBe(true);

    const empty = await invokeProfessorCapability({
      capability: "get_current_mastery_state",
      input: { enrolmentId: secondEnrolment, lessonId: thirdLesson },
    });
    expect(empty).toMatchObject({
      ok: true,
      data: { persistedOnly: true, records: [] },
    });

    state.transformRows = (table, rows) =>
      table === "objective_mastery" && rows.length
        ? Array.from({ length: 201 }, () => ({ ...rows[0] }))
        : rows;
    expect(
      await invokeProfessorCapability({
        capability: "get_current_mastery_state",
        input: { enrolmentId: secondEnrolment, lessonId: secondLesson },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("Checkpoint 1C keeps all four new reads self-scoped even for a multi-role STUDENT", async () => {
    const foreignRequests = [
      {
        capability: "get_current_class_session",
        input: { enrolmentId: otherEnrolment },
      },
      {
        capability: "get_learning_resources",
        input: { enrolmentId: otherEnrolment, lessonId },
      },
      {
        capability: "get_permitted_learning_history",
        input: { enrolmentId: otherEnrolment },
      },
      {
        capability: "get_current_mastery_state",
        input: { enrolmentId: otherEnrolment, lessonId },
      },
    ] as const;

    for (const request of foreignRequests) {
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND_OR_FORBIDDEN" },
      });
    }

    await db.exec("reset role");
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'PLATFORM_ADMIN'),($1,'REGISTRAR'),($1,'INSTRUCTOR'),($1,'COUNSELLOR')",
      [studentId],
    );
    await asUser(studentAuth);

    for (const request of foreignRequests) {
      expect(await invokeProfessorCapability(request)).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND_OR_FORBIDDEN" },
      });
    }
  });

  it("Checkpoint 1C blocks all four new reads before content access during a controlled attempt", async () => {
    await db.query("select public.start_assessment_attempt($1)", [
      assessmentId,
    ]);

    const protectedRequests = [
      {
        capability: "get_current_class_session",
        input: { enrolmentId },
      },
      {
        capability: "get_learning_resources",
        input: { enrolmentId, lessonId },
      },
      {
        capability: "get_permitted_learning_history",
        input: { enrolmentId },
      },
      {
        capability: "get_current_mastery_state",
        input: { enrolmentId, lessonId },
      },
    ] as const;

    for (const request of protectedRequests) {
      state.calls = [];
      const result = await invokeProfessorCapability(request);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "ACTIVITY_BLOCKED" },
      });
      expect(
        state.calls.some((call) =>
          [
            "class_sessions",
            "learning_resources",
            "learning_evidence",
            "objective_mastery",
          ].includes(call.table ?? ""),
        ),
      ).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(
        /Protected prompt sentinel|Protected answer sentinel|Protected guidance sentinel/,
      );
    }
  });
});
