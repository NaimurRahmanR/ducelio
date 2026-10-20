import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  executionFixture,
  asExecutionUser,
  learner,
  administrator,
  foreignLearner,
  type ExecutionFixture,
} from "./execution-fixture";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import { buildPackage } from "./activation-fixture";
import { postgrestSelectQuery } from "./postgrest-select-query";
import { validateCoursePackage } from "@/domain/course-package";
const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
import {
  activateCoursePackage,
  listMyPracticals,
  requestPracticalSupport,
  getCourseActivationOptions,
} from "@/server/course-activation";
import { getStudentAssignments, submitAssignment } from "@/server/assignments";
import {
  getStudentAssessments,
  startAssessmentAttempt,
  recordAssessmentResponse,
  submitAssessmentAttempt,
} from "@/server/assessments";
let f: ExecutionFixture,
  importId: string,
  cohortId: string,
  enrolmentId: string;
const state: CapabilityDbState = { authUser: null, calls: [] };
let corrupt = false,
  transport = false;
const rpcKeys: Record<string, string[]> = {
  current_academic_activity_state: [],
  activate_course_package: [
    "p_import_id",
    "p_cohort_id",
    "p_instructor_id",
    "p_assignments",
    "p_assessments",
    "p_reason",
  ],
  get_course_activation_options: ["p_import_id"],
  list_my_practicals: ["p_enrolment_id", "p_cursor"],
  request_practical_support: [
    "p_enrolment_id",
    "p_practical_id",
    "p_request_id",
  ],
  my_coursework_scope: [],
  start_assessment_attempt: ["p_assessment_id"],
  get_active_assessment_questions: ["p_assessment_id"],
  // CP2: the learner exam state (type, learner-visible definition, own
  // latest saved answer), gated exactly like the protected questions.
  get_active_assessment_exam_state: ["p_assessment_id"],
  // recordAssessmentResponse now probes the Commercial V1 governed writer
  // first (a non-governed activation like this fixture's answers
  // NOT_COMMERCIAL_V1_GOVERNED) and only then uses the legacy writer; the
  // learner read also runs the governed lazy finalizer first.
  record_commercial_v1_assessment_response: [
    "p_attempt_id",
    "p_question_id",
    "p_body",
    "p_idempotency_key",
  ],
  record_assessment_response: [
    "p_attempt_id",
    "p_question_id",
    "p_body",
    "p_idempotency_key",
  ],
  finalize_expired_commercial_v1_attempts: [],
  submit_assessment_attempt: ["p_attempt_id"],
  submit_assignment: ["p_assignment_id", "p_body", "p_idempotency_key"],
};
function client() {
  const base = capabilityDbClient(f.db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in rpcKeys)) return base.rpc(name, args);
      if (transport)
        return { data: null, error: { message: "SQL credential sentinel" } };
      await f.db.exec("savepoint activation_rpc");
      try {
        const params = rpcKeys[name].map((k) =>
          k === "p_assignments" || k === "p_assessments"
            ? JSON.stringify(args[k])
            : args[k],
        );
        const question =
          name === "get_active_assessment_questions" ||
          name === "get_active_assessment_exam_state";
        const result = await f.db.query<{ data: unknown }>(
          "select " +
            (question ? "row_to_json(q)" : "q") +
            " as data from public." +
            name +
            "(" +
            params.map((_, i) => "$" + (i + 1)).join(",") +
            ") q",
          params,
        );
        await f.db.exec("release savepoint activation_rpc");
        let data = question
          ? result.rows.map((r) => r.data)
          : result.rows[0].data;
        if (corrupt && name === "list_my_practicals")
          data = [
            { ...(data as object[])[0], expectedAnswer: "Protected sentinel" },
          ];
        return { data, error: null };
      } catch (e) {
        await f.db.exec(
          "rollback to savepoint activation_rpc;release savepoint activation_rpc",
        );
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from(table: string) {
      if (
        ![
          "assignments",
          "assignment_submissions",
          "assessments",
          "assessment_attempts",
          "assessment_responses",
          "programme_versions",
        ].includes(table)
      )
        return base.from(table);
      return postgrestSelectQuery({
        db: f.db,
        table,
        columns: (
          {
            assignments:
              "t.id,t.title,t.instructions,t.opens_at,t.due_at,t.status,t.programme_version_id,json_build_object('title',l.title) as lessons",
            assessments:
              "t.id,t.title,t.instructions,t.opens_at,t.closes_at,t.duration_minutes,t.attempts_allowed,t.status,t.programme_version_id,json_build_object('title',l.title) as lessons",
            programme_versions: "t.id,t.label,t.title_snapshot",
            assignment_submissions:
              "t.id,t.assignment_id,t.attempt_number,t.submitted_at",
            assessment_attempts:
              "t.id,t.assessment_id,t.attempt_number,t.state,t.started_at,t.expires_at,t.submitted_at",
            assessment_responses:
              "t.id,t.attempt_id,t.question_id,t.revision_number,t.recorded_at",
          } as Record<string, string>
        )[table],
        join:
          table === "assignments" || table === "assessments"
            ? " join public.lessons l on l.id=t.lesson_id and l.programme_version_id=t.programme_version_id"
            : "",
        filterColumns: [
          "cohort_id",
          "status",
          "id",
          "assessment_id",
          "student_id",
          "state",
          "attempt_id",
        ],
      });
    },
  };
}
function input() {
  return {
    importId,
    cohortId,
    instructorId: administrator,
    assignments: [
      {
        templateKey: "a",
        opensAt: "2026-01-01T00:00:00Z",
        dueAt: "2030-01-01T00:00:00Z",
      },
    ],
    assessments: [
      {
        templateKey: "assess-1",
        opensAt: "2026-01-01T00:00:00Z",
        closesAt: "2030-01-01T00:00:00Z",
      },
    ],
    reason: "Reviewed course activation",
  };
}
beforeAll(async () => {
  f = await executionFixture();
  const p = buildPackage();
  p.packageKey = "activation-server-fixture";
  p.assignmentTemplates = [
    {
      key: "a",
      lessonRef: "lesson-1",
      title: "Materialised assignment",
      instructions: "Assignment fixture",
      objectiveRefs: ["obj-1"],
      rubric: [{ description: "Criterion", maxMarks: 5 }],
    },
  ];
  p.modules[0].lessons[0].practicalActivities = [
    {
      key: "p",
      kind: "EXERCISE",
      title: "Practice",
      instructions: "Practice fixture",
      position: 1,
      objectiveRefs: ["obj-1"],
    },
  ];
  const report = validateCoursePackage(p);
  if (!report.valid) throw new Error("fixture invalid");
  importId = (
    await f.db.query<{ id: string }>(
      "select public.import_course_package($1,1,$2,$3::jsonb,$4) as id",
      [
        p.packageKey,
        p.schemaVersion,
        JSON.stringify(p),
        "Server fixture package",
      ],
    )
  ).rows[0].id;
  await f.db.query(
    "select public.mark_course_package_validated($1,$2::jsonb,$3)",
    [importId, JSON.stringify(report.report), "Validated package fixture"],
  );
  const v = (
    await f.db.query<{ id: string }>(
      "select public.apply_course_package($1,$2) as id",
      [importId, "Apply package fixture"],
    )
  ).rows[0].id;
  // PR15: publish_course_package now requires a current passing
  // pre-publication test. This fixture does not exercise agent
  // configuration semantics, so every role is saved explicitly disabled
  // (the same default CourseAgentForm starts from) purely to satisfy the
  // governed test gate.
  for (const role of [
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
  ]) {
    await f.db.query(
      "select public.set_agent_config($1,$2,false,null,null,'{}',$3,$4)",
      [v, role, "NONE", "Server fixture agent configuration"],
    );
  }
  const testRun = (
    await f.db.query<{ outcome: string }>(
      "select outcome from public.run_course_package_test($1,$2)",
      [importId, "Server fixture pre-publication test"],
    )
  ).rows[0].outcome;
  if (testRun !== "PASS")
    throw new Error(
      `Server fixture pre-publication test did not pass: ${testRun}`,
    );
  await f.db.query("select public.publish_course_package($1,$2)", [
    importId,
    "Publish package fixture",
  ]);
  await f.db.exec("reset role");
  cohortId = randomUUID();
  await f.db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Server cohort',current_date)",
    [cohortId, v],
  );
  await asExecutionUser(f.db, 2);
  enrolmentId = (
    await f.db.query<{ id: string }>(
      "select public.create_enrolment($1,$2,'Server enrolment fixture') as id",
      [learner, cohortId],
    )
  ).rows[0].id;
  await f.db.exec("reset role");
});
beforeEach(async () => {
  await f.db.exec("begin");
  await asExecutionUser(f.db, 2, state);
  corrupt = false;
  transport = false;
  mocks.client.mockImplementation(async () => client());
});
afterEach(async () => {
  await f.db.exec("rollback;reset role");
});
afterAll(async () => {
  await f.db?.close();
});
describe("course activation real server/DB composition", () => {
  it("existing learner assignment/assessment services deliver materialised coursework and canonical submissions", async () => {
    await activateCoursePackage(input());
    await asExecutionUser(f.db, 1, state);
    const assignments = await getStudentAssignments();
    expect(assignments.assignments).toHaveLength(1);
    await submitAssignment({
      assignmentId: assignments.assignments[0].id,
      body: "Learner submission",
      idempotencyKey: randomUUID(),
    });
    expect((await getStudentAssignments()).submissions).toHaveLength(1);
    const assessments = await getStudentAssessments();
    const assessment = assessments.assessments.find(
      (a) => a.title === "Module 1 checkpoint",
    )!;
    expect(assessment).toBeDefined();
    const attempt = await startAssessmentAttempt(assessment.id);
    const active = await getStudentAssessments();
    expect(active.activeQuestions).toHaveLength(1);
    expect(JSON.stringify(active)).not.toMatch(
      /expectedAnswer|expected_answer|markingGuidance|marking_guidance|process of verifying identity/,
    );
    await recordAssessmentResponse({
      attemptId: attempt,
      questionId: active.activeQuestions[0].id,
      body: "Response",
      idempotencyKey: randomUUID(),
    });
    await submitAssessmentAttempt(attempt);
  });
  it("multi-role student services exclude staff-visible foreign coursework", async () => {
    await activateCoursePackage(input());
    await f.db.exec("reset role");
    await f.db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [foreignLearner],
    );
    await asExecutionUser(f.db, 3, state);
    expect((await getStudentAssignments()).assignments).toHaveLength(0);
    expect(
      (await getStudentAssessments()).assessments.some(
        (a) => a.title === "Module 1 checkpoint",
      ),
    ).toBe(false);
    await expect(listMyPracticals({ enrolmentId })).rejects.toMatchObject({
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });
  // Blocker 2 correction: a legitimate STUDENT with zero enrolments (e.g.
  // entitlement/payment not yet completed) must never cause
  // `.in("cohort_id", [])` to be constructed at all -- the fake adapter
  // above now throws if that ever happens, so this test would fail loudly
  // if the production short-circuit regressed. foreignLearner genuinely has
  // no enrolment anywhere in this fixture (a real "not yet entitled"
  // STUDENT), not a role-based override of an otherwise-enrolled account.
  it("a STUDENT with zero enrolments gets safe empty coursework state without an unsafe empty .in() filter", async () => {
    await activateCoursePackage(input());
    await asExecutionUser(f.db, 3, state);
    const assignments = await getStudentAssignments();
    expect(assignments).toEqual({ assignments: [], submissions: [] });
    const assessments = await getStudentAssessments();
    expect(assessments).toEqual({
      assessments: [],
      activeAssessment: null,
      attempts: [],
      responses: [],
      activityState: "NORMAL",
      activeQuestions: [],
      serverNow: expect.any(String),
      pagination: {
        page: 1,
        pageSize: 25,
        hasPreviousPage: false,
        hasNextPage: false,
      },
    });
  });
  it("rejects malformed inputs before any RPC and normalizes transport failure", async () => {
    await expect(
      activateCoursePackage({ ...input(), role: "ACADEMIC_ADMIN" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    transport = true;
    await expect(activateCoursePackage(input())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "SERVICE_UNAVAILABLE",
    });
  });
  it("unknown sensitive backend fields fail strict output parsing", async () => {
    await activateCoursePackage(input());
    await asExecutionUser(f.db, 1, state);
    corrupt = true;
    await expect(listMyPracticals({ enrolmentId })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
  it("admin metadata is safe and learner role cannot activate", async () => {
    const options = await getCourseActivationOptions(importId);
    expect(options.assignments[0].templateKey).toBe("a");
    expect(JSON.stringify(options)).not.toMatch(
      /expectedAnswer|markingGuidance|prompt/,
    );
    await asExecutionUser(f.db, 1, state);
    await expect(activateCoursePackage(input())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("support uses fixed institutional routing, rejects profile/role overrides", async () => {
    await activateCoursePackage(input());
    await asExecutionUser(f.db, 1, state);
    const p = (await listMyPracticals({ enrolmentId }))[0];
    await expect(
      requestPracticalSupport({
        enrolmentId,
        practicalId: p.id,
        requestId: randomUUID(),
        destination: "EXAMINER",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await requestPracticalSupport({
        enrolmentId,
        practicalId: p.id,
        requestId: randomUUID(),
      }),
    ).toMatch(/^[a-f0-9-]{36}$/);
  });
});
