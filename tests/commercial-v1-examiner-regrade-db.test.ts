import { randomUUID } from "node:crypto";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import {
  regradeFixture,
  asPolicyUser,
  owner,
  value,
  args,
  bound,
  govern,
  running,
  graded,
  seedResult,
  sign,
  learner,
  administrator,
  type RegradeFixture,
} from "./commercial-v1-examiner-regrade-fixture";
import {
  computeExaminerAssessmentGradeDigest,
  computeExaminerLabGradeDigest,
} from "@/domain/commercial-v1-examiner-grading";
import { COMPONENTS } from "./commercial-v1-assessment-policy-fixture";
let f: RegradeFixture;
const secondAdministrator = "10000000-0000-4000-8000-000000000003";
beforeAll(async () => {
  f = await regradeFixture();
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await owner(f.db);
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
  await owner(f.db);
});
describe("regrade authority", () => {
  it("admits the admin, starts, reads independent work, atomically appends revision 2", async () => {
    const a = await running(f);
    const context = await govern(f, { ...a, p_operation: "CONTEXT_READ" });
    expect(context).toMatchObject({
      ok: true,
      attemptId: f.assessment.attempt,
    });
    expect(context).not.toHaveProperty("requestReason");
    expect(context).not.toHaveProperty("scoreBp");
    const result = await govern(f, graded(f, a));
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED", sourceRevisionNumber: 1 },
    });
    await owner(f.db);
    const rows = (
      await f.db.query<{ id: string; revision_number: number }>(
        "select id,revision_number from commercial_v1_assessment_result_revisions order by revision_number",
      )
    ).rows;
    expect(rows.map((r) => r.revision_number)).toEqual([1, 2]);
    expect(
      await value(
        f.db,
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [rows[1].id],
      ),
    ).toBe(true);
  });
  it.each([1, 3, null])(
    "denies learner/foreign/unauthenticated %s even with controller MAC",
    async (n) => {
      await asPolicyUser(f.db, n);
      expect(
        await govern(f, args(f), {
          actor:
            n === 1
              ? learner
              : n === 3
                ? "10000000-0000-4000-8000-000000000003"
                : administrator,
        }),
      ).toEqual({
        ok: false,
        code: n === null ? "UNAUTHENTICATED" : "FORBIDDEN",
      });
    },
  );
  it("denies a non-admin instructor", async () => {
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toEqual({ ok: false, code: "FORBIDDEN" });
  });
  it("platform admin can claim and regrade the same lab submission", async () => {
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await f.db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      administrator,
    ]);
    const a = await running(f, true);
    const context = await govern(f, { ...a, p_operation: "CONTEXT_READ" });
    expect(context).toMatchObject({
      ok: true,
      submissionId: f.submission,
      practicalId: f.practical,
      maxMarks: 10,
    });
    expect(Object.keys(context).sort()).toEqual(
      [
        "gradingGuidance",
        "instructions",
        "maxMarks",
        "objectives",
        "ok",
        "practicalId",
        "submissionBody",
        "submissionId",
        "title",
      ].sort(),
    );
    expect(await govern(f, graded(f, a, 7))).toMatchObject({
      ok: true,
      execution: {
        state: "SUCCEEDED",
        runtimeProfileRef: "EXAMINER_COMMERCIAL_V1",
      },
    });
    await owner(f.db);
    const row = (
      await f.db.query<{ id: string }>(
        "select * from commercial_v1_lab_result_revisions where revision_number=2",
      )
    ).rows[0];
    expect(row).toMatchObject({
      submission_id: f.submission,
      earned_marks: 7,
      max_marks: 10,
      contribution_bp: 2000,
    });
    expect(
      await value(
        f.db,
        "select commercial_v1_private.lab_result_is_valid($1) as v",
        [row.id],
      ),
    ).toBe(true);
  });
  it.each([
    "bad",
    "expired",
    "key",
    "operation",
    "source",
    "budget",
    "actor",
    "namespace",
  ])("rejects %s MAC tampering", async (mode) => {
    const a = args(f);
    await asPolicyUser(f.db, 2);
    let mac = sign(a, f.key);
    if (mode === "bad") mac = "0".repeat(64);
    if (mode === "expired") {
      a.p_issued_at -= 20;
      a.p_expires_at -= 20;
      mac = sign(a, f.key);
    }
    if (mode === "key") {
      a.p_key_id = randomUUID();
      mac = sign(a, f.key);
    }
    if (mode === "operation") a.p_operation = "START";
    if (mode === "source") a.p_source_id = f.lab;
    if (mode === "budget") a.p_max_output = 1000;
    if (mode === "actor") mac = sign(a, f.key, learner);
    if (mode === "namespace") mac = computeExaminerLabGradeDigest(1);
    expect(await govern(f, a, { mac })).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
  });
  it("only identifier-based AUTHORIZE can derive source scope", async () => {
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_student_id: learner })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
  it("unknown source fails without existence detail", async () => {
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_id: randomUUID() })).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });
  it("rejects older source and invalid highest with no fallback", async () => {
    const newest = await copyAssessment(false);
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "NOT_CURRENT_RESULT",
    });
    expect(await govern(f, { ...args(f), p_source_id: newest })).toEqual({
      ok: false,
      code: "CURRENT_RESULT_INVALID",
    });
  });
  it("another authorized admin sees an active institutional claim as replay without a second execution", async () => {
    await running(f);

    await owner(f.db);
    await f.db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      secondAdministrator,
    ]);
    await asPolicyUser(f.db, 3);

    expect(await govern(f, args(f), { actor: secondAdministrator })).toEqual({
      ok: false,
      code: "REPLAY_REJECTED",
    });

    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_examiner_regrade_executions",
      ),
    ).toBe(1);
    expect(
      await value(
        f.db,
        "select actor_id::text as v from commercial_v1_examiner_regrade_executions",
      ),
    ).toBe(administrator);
  });
  it("active claim replay cannot create a second execution", async () => {
    const a = await running(f);
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "REPLAY_REJECTED",
    });
    expect(await govern(f, a)).toEqual({ ok: false, code: "REPLAY_REJECTED" });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_examiner_regrade_executions",
      ),
    ).toBe(1);
  });
  it("another authorized admin receives the same successful institutional replay without a second result", async () => {
    const a = await running(f);
    const done = await govern(f, graded(f, a));

    await owner(f.db);
    await f.db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      secondAdministrator,
    ]);
    await asPolicyUser(f.db, 3);

    const replay = await govern(f, args(f), {
      actor: secondAdministrator,
    });

    expect(replay).toMatchObject({
      ...done,
      transitioned: false,
      execution: {
        ...(done.execution as Record<string, unknown>),
        actorId: administrator,
      },
    });

    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_examiner_regrade_executions",
      ),
    ).toBe(1);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions where revision_number=2",
      ),
    ).toBe(1);
  });
  it("successful replay returns identical result and later source supports revision 3", async () => {
    const a = await running(f);
    const done = await govern(f, graded(f, a));
    const replay = await govern(f, args(f));
    expect(replay).toMatchObject({ ...done, transitioned: false });
    const ex = done.execution as { resultRevisionId: string };
    const next = { ...args(f), p_source_id: ex.resultRevisionId };
    expect(await govern(f, next)).toMatchObject({ ok: true });
    const start = bound(f, next);
    expect(await govern(f, start)).toMatchObject({ ok: true });
    expect(await govern(f, graded(f, start))).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED", sourceRevisionNumber: 2 },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select max(revision_number) as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(3);
  });
  it.each(["FAILED", "ESCALATED", "BUDGET_BLOCKED", "CANCELLED"])(
    "%s creates no result and permanently occupies source claim",
    async (state) => {
      const a = await running(f);
      const terminal = {
        ...a,
        p_operation: "FINALIZE",
        p_state: state,
        p_reason:
          state === "FAILED"
            ? "NO_PROVIDER_CONFIGURED"
            : state === "ESCALATED"
              ? "HUMAN_REVIEW_REQUIRED"
              : state,
        p_budget_stage: state === "BUDGET_BLOCKED" ? "PRE_CALL" : "NONE",
      };
      expect(await govern(f, terminal)).toMatchObject({
        ok: true,
        execution: { state },
      });
      expect(await govern(f, args(f))).toMatchObject({
        ok: true,
        transitioned: false,
        execution: { state },
      });
      expect(await govern(f, terminal)).toEqual({
        ok: false,
        code: "REPLAY_REJECTED",
      });
      await owner(f.db);
      expect(
        await value(
          f.db,
          "select count(*)::int as v from commercial_v1_assessment_result_revisions",
        ),
      ).toBe(1);
    },
  );
  it.each(["activation", "enrolment", "student", "attempt", "source"])(
    "START refuses a cross-scope %s binding",
    async (field) => {
      const a = args(f);
      await asPolicyUser(f.db, 2);
      await govern(f, a);
      const s = bound(f, a);
      if (field === "activation") s.p_activation_id = randomUUID();
      if (field === "enrolment") s.p_enrolment_id = randomUUID();
      if (field === "student") s.p_student_id = administrator;
      if (field === "attempt") s.p_attempt_id = randomUUID();
      if (field === "source") s.p_source_id = f.lab;
      expect(await govern(f, s)).toMatchObject({ ok: false });
    },
  );
  it.each([false, true])(
    "protected context %s requires a fresh operation-bound MAC",
    async (lab) => {
      const a = await running(f, lab);
      const c = { ...a, p_operation: "CONTEXT_READ" };
      expect(await govern(f, c, { mac: sign(a, f.key) })).toEqual({
        ok: false,
        code: "UNTRUSTED_EXECUTION",
      });
      expect(await govern(f, c)).toMatchObject({ ok: true });
    },
  );
  it("AUTHORIZED context cannot be read before START", async () => {
    const a = args(f);
    await asPolicyUser(f.db, 2);
    await govern(f, a);
    expect(
      await govern(f, { ...bound(f, a), p_operation: "CONTEXT_READ" }),
    ).toEqual({ ok: false, code: "EXECUTION_UNAVAILABLE" });
  });
  it("a genuinely past RUNNING execution expires deterministically before context", async () => {
    const a = args(f);
    // Test-owner insert of a valid execution representing an earlier admission;
    // no clock sleeps and no disabled production guards.
    await f.db.query(
      `insert into commercial_v1_examiner_regrade_executions(id,actor_id,source_result_revision_id,source_revision_number,request_reason,
      student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,state,created_at,authorized_at,started_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd)
      values($1,$2,$3,1,$4,$5,$6,$7,$8,'ASSESSMENT_ATTEMPT',$9,'QUIZ_1','RUNNING',now()-interval '40 seconds',now()-interval '40 seconds',now()-interval '39 seconds',now()-interval '20 seconds',1,1200,50000)`,
      [
        a.p_execution_id,
        administrator,
        a.p_source_id,
        a.p_request_reason,
        learner,
        f.learnerEnrolmentId,
        f.activationId,
        a.p_capability,
        f.assessment.attempt,
      ],
    );
    await asPolicyUser(f.db, 2);
    expect(
      await govern(f, { ...bound(f, a), p_operation: "CONTEXT_READ" }),
    ).toEqual({ ok: false, code: "EXECUTION_TIMEOUT" });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select state as v from commercial_v1_examiner_regrade_executions",
      ),
    ).toBe("TIMEOUT");
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(1);
  });
  it("no provider cleanup can terminalize an uncertain AUTHORIZED claim", async () => {
    const a = args(f);
    await asPolicyUser(f.db, 2);
    await govern(f, a);
    expect(
      await govern(f, {
        ...bound(f, a),
        p_operation: "FINALIZE",
        p_state: "FAILED",
        p_reason: "INTERNAL_ERROR",
      }),
    ).toMatchObject({
      ok: true,
      execution: { state: "FAILED", usage: { providerCalls: 0 } },
    });
  });
  it("concurrent execution ceiling spans assessment and lab sources", async () => {
    await running(f);
    expect(await govern(f, args(f, true))).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
  });
  it("five admitted revisions exhaust the 60-second security ceiling", async () => {
    let source = f.assessment.result;
    for (let n = 0; n < 5; n++) {
      const a = { ...args(f), p_source_id: source };
      await asPolicyUser(f.db, 2);
      expect(await govern(f, a)).toMatchObject({ ok: true });
      const s = bound(f, a);
      await govern(f, s);
      const done = await govern(f, graded(f, s));
      expect(done).toMatchObject({
        ok: true,
        execution: { state: "SUCCEEDED" },
      });
      source = (done.execution as { resultRevisionId: string })
        .resultRevisionId;
    }
    expect(await govern(f, { ...args(f), p_source_id: source })).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
  });
  it("thirty past successful claims exhaust the hourly ceiling without triggering short-window limits", async () => {
    // Owner-only historical fixture: a valid same-work chain of 31 revisions,
    // with 30 completed claims from ten minutes ago. No sleeps or guard bypass.
    let source = f.assessment.result;
    for (let n = 1; n <= 30; n++) {
      const produced = await copyAssessment(true, source);
      await f.db.query(
        `insert into commercial_v1_examiner_regrade_executions(id,actor_id,source_result_revision_id,source_revision_number,request_reason,
        student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,state,created_at,authorized_at,started_at,terminal_at,expires_at,
        max_provider_calls,max_output_tokens,max_estimated_cost_microusd,reason_code,grade_digest,result_revision_id)
        values(gen_random_uuid(),$1,$2,$3,'Past review',$4,$5,$6,'regrade_controlled_assessment','ASSESSMENT_ATTEMPT',$7,'QUIZ_1','SUCCEEDED',
          now()-interval '10 minutes',now()-interval '10 minutes',now()-interval '599 seconds',now()-interval '598 seconds',now()-interval '580 seconds',
          1,1200,50000,'GRADED',$8,$9)`,
        [
          administrator,
          source,
          n,
          learner,
          f.learnerEnrolmentId,
          f.activationId,
          f.assessment.attempt,
          computeExaminerAssessmentGradeDigest([
            { questionId: f.assessment.questionId, marksAwarded: 0 },
          ]),
          produced,
        ],
      );
      source = produced;
    }
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_id: source })).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
  });
  it("revoked administrator cannot START an admitted claim", async () => {
    const a = args(f);
    await asPolicyUser(f.db, 2);
    await govern(f, a);
    await owner(f.db);
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, bound(f, a))).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
  });
  it("known over-budget consumption persists without a result", async () => {
    const a = await running(f);
    expect(
      await govern(f, {
        ...a,
        p_operation: "FINALIZE",
        p_state: "BUDGET_BLOCKED",
        p_reason: "BUDGET_BLOCKED",
        p_budget_stage: "POST_CALL",
        p_calls: 1,
        p_attempts: 1,
        p_input: 30,
        p_output: 1500,
        p_cost: 60000,
        p_elapsed: 10,
      }),
    ).toMatchObject({
      ok: true,
      execution: {
        state: "BUDGET_BLOCKED",
        usage: { outputTokens: 1500, estimatedCostMicrousd: 60000 },
      },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(1);
  });
  it("remediation resolves only when no negative current result remains", async () => {
    const a = await running(f);
    await govern(f, graded(f, a, f.assessment.max));
    const lab = await running(f, true);
    await govern(f, graded(f, lab, 10));
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_remediation_items where state='OPEN'",
      ),
    ).toBe(0);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_remediation_items where resolved_reason='SUPERSEDED_RESULT'",
      ),
    ).toBeGreaterThan(0);
  });
  it.each([
    "digest",
    "marks",
    "duplicate",
    "foreign",
    "missing",
    "above-max",
    "extra-key",
  ])("%s invalid marks rollback every result-side write", async (mode) => {
    const a = await running(f);
    const g = graded(f, a);
    let marks = [{ questionId: f.assessment.questionId, marksAwarded: 1 }];
    if (mode === "digest") g.p_grade_digest = "0".repeat(64);
    if (mode === "marks") marks[0].marksAwarded = 0;
    if (mode === "duplicate") marks.push({ ...marks[0] });
    if (mode === "foreign") marks[0].questionId = randomUUID();
    if (mode === "missing") marks = [];
    if (mode === "above-max") marks[0].marksAwarded = f.assessment.max + 1;
    if (mode !== "digest" && mode !== "marks")
      g.p_grade_digest = computeExaminerAssessmentGradeDigest(marks);
    g.p_assessment_marks =
      mode === "extra-key"
        ? marks.map((m) => ({ ...m, feedback: "not allowed" }))
        : marks;
    expect(await govern(f, g)).toMatchObject({
      ok: true,
      execution: {
        state: "FAILED",
        reasonCode: "RESULT_INTEGRITY_FAILED",
        resultRevisionId: null,
      },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(1);
    expect(
      await value(
        f.db,
        "select provider_calls as v from commercial_v1_examiner_regrade_usage",
      ),
    ).toBe(1);
  });
  it("over-max lab refuses result and retains observed usage", async () => {
    const a = await running(f, true);
    expect(await govern(f, graded(f, a, 11))).toMatchObject({
      ok: true,
      execution: {
        state: "FAILED",
        reasonCode: "RESULT_INTEGRITY_FAILED",
        usage: { providerCalls: 1, estimatedCostMicrousd: 50 },
      },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_lab_result_revisions",
      ),
    ).toBe(1);
  });
  it("all-unanswered work receives zero for every real question", async () => {
    const source = await seedResult(f, "QUIZ_2");
    const other = { ...f, assessment: source };
    const a = await running(other);
    const g = {
      ...graded(other, a),
      p_assessment_marks: [],
      p_grade_digest: computeExaminerAssessmentGradeDigest([]),
    };
    expect(await govern(other, g)).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select earned_marks_total as v from commercial_v1_assessment_result_revisions where revision_number=2",
      ),
    ).toBe(0);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_question_marks m join commercial_v1_assessment_result_revisions r on r.id=m.result_revision_id where r.revision_number=2 and m.marks_awarded=0",
      ),
    ).toBe(1);
  });
  it("mixed answered/unanswered context omits the unanswered question; DB writes both marks", async () => {
    const other = await regradeFixture(true);
    try {
      const a = await running(other);
      const context = await govern(other, {
        ...a,
        p_operation: "CONTEXT_READ",
      });
      expect(context.questions).toHaveLength(1);
      const done = await govern(other, graded(other, a, other.assessment.max));
      expect(done).toMatchObject({
        ok: true,
        execution: { state: "SUCCEEDED" },
      });
      await owner(other.db);
      const rows = (
        await other.db.query<{ marks_awarded: number }>(
          "select marks_awarded from commercial_v1_assessment_question_marks m join commercial_v1_assessment_result_revisions r on r.id=m.result_revision_id where r.revision_number=2 order by marks_awarded",
        )
      ).rows;
      expect(rows.map((r) => r.marks_awarded)).toEqual([0, 10]);
      expect(
        await value(
          other.db,
          "select component_weight_bp as v from commercial_v1_assessment_result_revisions where revision_number=2",
        ),
      ).toBe(500);
    } finally {
      await other.db.close();
    }
  });
  it("completion winning before admission rejects regrade", async () => {
    await f.db.query("update enrolments set status='COMPLETED' where id=$1", [
      f.learnerEnrolmentId,
    ]);
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "TARGET_NOT_ELIGIBLE",
    });
  });
  it("completion winning before FINALIZE leaves no new revision", async () => {
    const a = await running(f);
    await owner(f.db);
    await f.db.query("update enrolments set status='COMPLETED' where id=$1", [
      f.learnerEnrolmentId,
    ]);
    await asPolicyUser(f.db, 2);
    expect(await govern(f, graded(f, a))).toEqual({
      ok: false,
      code: "TARGET_NOT_ELIGIBLE",
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(1);
  });
  it("FINALIZE rechecks highest revision under completion lock", async () => {
    const a = await running(f);
    await owner(f.db);
    await copyAssessment(true);
    await asPolicyUser(f.db, 2);
    expect(await govern(f, graded(f, a))).toEqual({
      ok: false,
      code: "NOT_CURRENT_RESULT",
    });
  });
  it("atomic integrity failure rolls back inserted header and objective outcomes", async () => {
    const a = await running(f);
    await owner(f.db);
    await f.db.exec(
      "create function public.test_regrade_failure() returns trigger language plpgsql as $$ begin raise exception 'test fault'; end $$; create trigger test_regrade_failure before insert on commercial_v1_assessment_objective_outcomes for each row execute function public.test_regrade_failure()",
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, graded(f, a))).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "RESULT_INTEGRITY_FAILED" },
    });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select count(*)::int as v from commercial_v1_assessment_result_revisions",
      ),
    ).toBe(1);
  });
  it("regrade reconciles diagnostics; completion consumes revision 2 without mastery mutation", async () => {
    for (const component of COMPONENTS.slice(1)) await seedResult(f, component);
    const old = await value(
      f.db,
      "select to_jsonb(r) as v from commercial_v1_assessment_result_revisions r where id=$1",
      [f.assessment.result],
    );
    const evidence = await value(
      f.db,
      "select count(*)::int as v from learning_evidence",
    );
    const mastery = await value(
      f.db,
      "select coalesce(jsonb_agg(m),'[]') as v from objective_mastery m",
    );
    await asPolicyUser(f.db, 2);
    expect(
      await value(
        f.db,
        "select attempt_commercial_v1_course_completion($1,'Check prerequisites') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({ code: "BELOW_PASS_MARK" });
    const a = await running(f);
    expect(await govern(f, graded(f, a, f.assessment.max))).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    const progress = await value(
      f.db,
      "select get_commercial_v1_course_progress($1) as v",
      [f.learnerEnrolmentId],
    );
    expect(progress).toMatchObject({
      enrolmentStatus: "ACTIVE",
      components: { QUIZ_1: { scoreBp: 10000, weightedContributionBp: 500 } },
    });
    const diagnostics = await value(
      f.db,
      "select list_commercial_v1_objective_diagnostics($1,100,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(JSON.stringify(diagnostics)).toContain('"outcome":"CORRECT"');
    expect(
      await value(
        f.db,
        "select attempt_commercial_v1_course_completion($1,'Complete after regrade') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({ code: "COMPLETED", courseScoreBp: 500 });
    await owner(f.db);
    expect(
      await value(
        f.db,
        "select to_jsonb(r) as v from commercial_v1_assessment_result_revisions r where id=$1",
        [f.assessment.result],
      ),
    ).toEqual(old);
    expect(
      await value(f.db, "select count(*)::int as v from learning_evidence"),
    ).toBe(evidence);
    expect(
      await value(
        f.db,
        "select coalesce(jsonb_agg(m),'[]') as v from objective_mastery m",
      ),
    ).toEqual(mastery);
  });
  it("audit and execution metadata exclude protected content and signatures", async () => {
    const a = await running(f);
    await govern(f, graded(f, a));
    await owner(f.db);
    const dump = JSON.stringify(
      await value(
        f.db,
        "select jsonb_build_object('executions',(select jsonb_agg(e) from commercial_v1_examiner_regrade_executions e),'audit',(select jsonb_agg(a) from audit_events a where action like 'COMMERCIAL_V1_EXAMINER_REGRADE_%')) as v",
      ),
    );
    for (const secret of [
      "Protected learner response sentinel",
      "Protected lab submission sentinel",
      "Protected grading guidance sentinel",
      f.key.toString("hex"),
      sign(a, f.key),
      "expectedAnswer",
      "responseBody",
    ])
      expect(dump).not.toContain(secret);
    expect(dump).toContain("EXAMINER_COMMERCIAL_V1");
    expect(dump).toContain(f.assessment.result);
  });
  it.each([
    "actor_id",
    "student_id",
    "enrolment_id",
    "activation_id",
    "source_result_revision_id",
    "attempt_id",
    "submission_id",
    "practical_id",
    "component",
    "runtime_profile_ref",
    "source_revision_number",
    "request_reason",
  ])("identity %s cannot change even as owner", async (field) => {
    await running(f);
    await owner(f.db);
    const replacement =
      field === "source_revision_number"
        ? "2"
        : field === "component" ||
            field === "request_reason" ||
            field === "runtime_profile_ref"
          ? "'changed'"
          : "gen_random_uuid()";
    await expect(
      f.db.exec(
        `update commercial_v1_examiner_regrade_executions set ${field}=${replacement}`,
      ),
    ).rejects.toThrow(/immutable/);
  });
  it.each(["update", "delete"])("terminal %s is forbidden", async (op) => {
    const a = await running(f);
    await govern(f, graded(f, a));
    await owner(f.db);
    await expect(
      f.db.exec(
        op === "delete"
          ? "delete from commercial_v1_examiner_regrade_executions"
          : "update commercial_v1_examiner_regrade_executions set reason_code='INTERNAL_ERROR'",
      ),
    ).rejects.toThrow(/immutable|deleted/);
  });
  it.each(["anon", "authenticated", "service_role"])(
    "%s has no direct writers or private verifier access",
    async (role) => {
      for (const table of [
        "commercial_v1_examiner_regrade_executions",
        "commercial_v1_examiner_regrade_usage",
        "commercial_v1_assessment_result_revisions",
        "commercial_v1_lab_result_revisions",
      ]) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE"])
          expect(
            await value(f.db, "select has_table_privilege($1,$2,$3) as v", [
              role,
              table,
              privilege,
            ]),
          ).toBe(false);
      }
      expect(
        await value(
          f.db,
          "select has_schema_privilege($1,'commercial_v1_regrade_private','USAGE') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value(
          f.db,
          "select bool_or(has_function_privilege($1,p.oid,'EXECUTE')) as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='commercial_v1_regrade_private'",
          [role],
        ),
      ).toBe(false);
      expect(
        await value(
          f.db,
          "select has_function_privilege($1,p.oid,'EXECUTE') as v from pg_proc p where proname='govern_commercial_v1_examiner_regrade'",
          [role],
        ),
      ).toBe(role === "authenticated");
      await f.db.exec(`set role ${role}`);
      await expect(
        f.db.exec(
          "insert into commercial_v1_examiner_regrade_executions(id) values(gen_random_uuid())",
        ),
      ).rejects.toThrow(/permission denied/);
    },
  );
});
async function copyAssessment(valid: boolean, source = f.assessment.result) {
  const id = await value(
    f.db,
    `insert into commercial_v1_assessment_result_revisions(activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp)
    select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number+1,earned_marks_total,max_marks_total,component_weight_bp from commercial_v1_assessment_result_revisions where id=$1 returning id as v`,
    [source],
  );
  if (valid) {
    await f.db.query(
      "insert into commercial_v1_assessment_question_marks select $1,question_id,marks_awarded,max_marks_snapshot from commercial_v1_assessment_question_marks where result_revision_id=$2",
      [id, source],
    );
    await f.db.query(
      "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
      [id],
    );
  }
  return id;
}
