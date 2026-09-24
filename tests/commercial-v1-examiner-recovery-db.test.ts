import { randomUUID, createHash } from "node:crypto";
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
  recoveryFixture,
  seedOriginalExecution,
  seedActiveOriginalExecution,
  asPolicyUser,
  owner,
  value,
  args,
  govern,
  running,
  graded,
  sign,
  learner,
  administrator,
  RECOVERABLE_STATES,
  type RecoveryFixture,
} from "./commercial-v1-examiner-recovery-fixture";
import {
  computeExaminerAssessmentGradeDigest,
  computeExaminerLabGradeDigest,
} from "@/domain/commercial-v1-examiner-grading";

let f: RecoveryFixture;
beforeAll(async () => {
  f = await recoveryFixture();
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

// `scalar` matches this codebase's established `select ... as v` idiom
// (used throughout commercial-v1-*-fixture.ts). `rowObject`/`rowsOf` are for
// plain multi-column SQL with no such wrapping -- kept separate rather than
// overloaded, so a query's own column list is never silently misread.
async function scalar<T = string>(sql: string, params: unknown[] = []) {
  await owner(f.db);
  return value<T>(f.db, sql, params);
}
async function rowObject<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) {
  await owner(f.db);
  return (await f.db.query<T>(sql, params)).rows[0];
}
async function rowsOf<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) {
  await owner(f.db);
  return (await f.db.query<T>(sql, params)).rows;
}
async function originalRow(id: string) {
  return scalar<Record<string, unknown>>(
    "select to_jsonb(t) as v from commercial_v1_examiner_executions t where id=$1",
    [id],
  );
}
async function recoveryCount(sourceId: string) {
  return Number(
    await scalar<string>(
      "select count(*)::text as v from commercial_v1_examiner_recovery_executions where source_execution_id=$1",
      [sourceId],
    ),
  );
}
async function resultCount(component = "QUIZ_1") {
  return Number(
    await scalar<string>(
      "select count(*)::text as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component=$2",
      [f.learnerEnrolmentId, component],
    ),
  );
}

// =============================================================================
// ADMISSION / AUTHORITY
// =============================================================================
describe("Examiner initial-grade recovery: admission and authority", () => {
  it("an ACADEMIC_ADMIN admits recovery for an eligible FAILED target with no result", async () => {
    await asPolicyUser(f.db, 2);
    const result = await govern(f, args(f));
    expect(result).toMatchObject({
      ok: true,
      transitioned: true,
      execution: {
        state: "AUTHORIZED",
        sourceExecutionId: f.assessmentOriginal,
        studentId: learner,
        capability: "grade_controlled_assessment",
        runtimeProfileRef: "EXAMINER_COMMERCIAL_V1",
        policyVersion: "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1",
        executionKind: "PROVIDER_BACKED_RECOVERY_V1",
      },
    });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(1);
  });

  it("a PLATFORM_ADMIN can also admit recovery", async () => {
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await f.db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      administrator,
    ]);
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toMatchObject({ ok: true });
  });

  it.each([1, 3, null])(
    "denies STUDENT/foreign/unauthenticated %s even with a controller MAC",
    async (n) => {
      await asPolicyUser(f.db, n);
      const result = await govern(f, args(f), {
        actor:
          n === 1
            ? learner
            : n === 3
              ? "10000000-0000-4000-8000-000000000003"
              : administrator,
      });
      expect(result).toEqual({
        ok: false,
        code: n === null ? "UNAUTHENTICATED" : "FORBIDDEN",
      });
    },
  );

  it("denies an unrelated staff role (INSTRUCTOR, no admin grant)", async () => {
    // The base fixture already grants both ACADEMIC_ADMIN and INSTRUCTOR to
    // `administrator` -- removing only the former leaves a genuine
    // INSTRUCTOR-only actor.
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("anon and service_role cannot call the RPC or read either table directly", async () => {
    async function denied(sql: string, params: unknown[] = []) {
      await f.db.exec("savepoint acl_denial");
      try {
        await expect(f.db.query(sql, params)).rejects.toThrow();
      } finally {
        await f.db.exec(
          "rollback to savepoint acl_denial; release savepoint acl_denial",
        );
      }
    }
    await asPolicyUser(f.db, 2);
    const a = args(f);
    const values = Object.values({ ...a, p_mac: sign(a, f.key) }).map((v, i) =>
      i === 28 ? JSON.stringify(v) : v,
    );
    if (a.p_assessment_marks === null) values[28] = null;
    const rpcSql = `select govern_commercial_v1_examiner_recovery(${values
      .map((_, i) => `$${i + 1}${i === 28 ? "::jsonb" : ""}`)
      .join(",")})`;
    for (const r of ["anon", "service_role"]) {
      await f.db.exec(`set role ${r}`);
      await denied(rpcSql, values);
      await denied("select 1 from commercial_v1_examiner_recovery_executions");
      await denied("select 1 from commercial_v1_examiner_recovery_usage");
    }
    await owner(f.db);
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
    if (mode === "source") a.p_source_execution_id = f.labOriginal!;
    if (mode === "budget") a.p_max_output = 1000;
    if (mode === "actor") mac = sign(a, f.key, learner);
    if (mode === "namespace") mac = computeExaminerLabGradeDigest(1);
    expect(await govern(f, a, { mac })).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
  });

  it("an oversized recovery reason fails closed before any claim is created", async () => {
    const a = { ...args(f), p_recovery_reason: "x".repeat(301) };
    await asPolicyUser(f.db, 2);
    expect(await govern(f, a)).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(0);
  });

  it("caller-supplied identity on AUTHORIZE is rejected as malicious extra input", async () => {
    const a = { ...args(f), p_student_id: learner };
    await asPolicyUser(f.db, 2);
    expect(await govern(f, a)).toEqual({ ok: false, code: "INVALID_INPUT" });
  });

  it("a foreign/nonexistent source_execution_id is indistinguishable from a target-kind mismatch", async () => {
    await asPolicyUser(f.db, 2);
    const nonexistent = await govern(f, {
      ...args(f),
      p_source_execution_id: randomUUID(),
    });
    const wrongKind = await govern(f, {
      ...args(f),
      p_target_kind: "LAB_SUBMISSION",
      p_capability: "grade_practical_lab",
    });
    expect(nonexistent).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(wrongKind).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

// =============================================================================
// TARGET ELIGIBILITY
// =============================================================================
describe("Examiner initial-grade recovery: target eligibility", () => {
  it.each(RECOVERABLE_STATES)(
    "a terminal %s original with no result is eligible",
    async (state) => {
      const id = await seedOriginalExecution(f, { component: "QUIZ_2", state });
      await asPolicyUser(f.db, 2);
      expect(
        await govern(f, { ...args(f), p_source_execution_id: id }),
      ).toMatchObject({
        ok: true,
        execution: { state: "AUTHORIZED" },
      });
    },
  );

  it("an ESCALATED original is not recoverable -- it needs human review, not automated re-grading", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_3",
      state: "ESCALATED",
    });
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_execution_id: id })).toEqual({
      ok: false,
      code: "TARGET_NOT_ELIGIBLE",
    });
  });

  it("an active (RUNNING) original is not recoverable", async () => {
    const id = await seedActiveOriginalExecution(f, "QUIZ_4");
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_execution_id: id })).toEqual({
      ok: false,
      code: "TARGET_NOT_ELIGIBLE",
    });
  });

  it("a SUCCEEDED original is not recoverable -- regrade is the correct authority for a dispute", async () => {
    const id = await seedOriginalExecution(f, {
      component: "FINAL",
      state: "SUCCEEDED",
    });
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_execution_id: id })).toEqual({
      ok: false,
      code: "TARGET_NOT_ELIGIBLE",
    });
  });

  it("a target that already has a result is denied ALREADY_GRADED (defense in depth)", async () => {
    const id = await seedOriginalExecution(f, {
      component: "MIDTERM",
      state: "FAILED",
    });
    const attemptId = await scalar<string>(
      "select attempt_id::text as v from commercial_v1_examiner_executions where id=$1",
      [id],
    );
    await f.db.query(
      `insert into commercial_v1_assessment_result_revisions(activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp)
       values($1,$2,$3,'MIDTERM',$4,$5,1,0,10,commercial_v1_private.expected_component_weight($1,'MIDTERM'))`,
      [
        f.activationId,
        f.learnerEnrolmentId,
        learner,
        attemptId,
        f.assessmentIds.MIDTERM,
      ],
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, { ...args(f), p_source_execution_id: id })).toEqual({
      ok: false,
      code: "ALREADY_GRADED",
    });
  });

  it("a disabled EXAMINER configuration denies POLICY_BLOCKED and creates no claim", async () => {
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.set_agent_config($1,'EXAMINER',false,null,null,array['grade_controlled_assessment','grade_practical_lab'],'NONE','Disable EXAMINER for eligibility test')",
      [f.programmeVersionId],
    );
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "POLICY_BLOCKED",
    });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(0);
  });

  it("a capability removed from configuration denies POLICY_BLOCKED", async () => {
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.set_agent_config($1,'EXAMINER',true,null,null,array['grade_practical_lab'],'NONE','Restrict capability for eligibility test')",
      [f.programmeVersionId],
    );
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "POLICY_BLOCKED",
    });
  });

  it("an unknown/cross-role stored model profile ref denies UNKNOWN_MODEL_PROFILE", async () => {
    // set_agent_config itself rejects an invalid ref for EXAMINER at write
    // time (role_profile_ref_is_valid) -- unreachable through the governed
    // writer, exactly like migration 036's own equivalent defense. Proven
    // the same way migration 036's own suite must: a direct owner-level
    // UPDATE bypassing the governed writer.
    await f.db.query(
      "update academic_agent_configs set model_profile_ref='PROFESSOR_COMMERCIAL_V1' where programme_version_id=$1 and role='EXAMINER'",
      [f.programmeVersionId],
    );
    await asPolicyUser(f.db, 2);
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "UNKNOWN_MODEL_PROFILE",
    });
  });

  it("escalationPolicy=ACADEMIC_REVIEW creates a durable ESCALATED recovery claim with zero provider usage", async () => {
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.set_agent_config($1,'EXAMINER',true,null,null,array['grade_controlled_assessment','grade_practical_lab'],'ACADEMIC_REVIEW','Escalation policy for eligibility test')",
      [f.programmeVersionId],
    );
    const result = await govern(f, args(f));
    expect(result).toMatchObject({
      ok: true,
      transitioned: true,
      execution: {
        state: "ESCALATED",
        reasonCode: "HUMAN_REVIEW_REQUIRED",
        reviewPath: "ACADEMIC_REVIEW",
        resultRevisionId: null,
      },
    });
    const execId = (result as { execution: { executionId: string } }).execution
      .executionId;
    expect(
      Number(
        await scalar<string>(
          "select count(*)::text as v from commercial_v1_examiner_recovery_usage where execution_id=$1",
          [execId],
        ),
      ),
    ).toBe(0);
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it.each(["PAUSED", "WITHDRAWN"])(
    "a %s (non-ACTIVE) enrolment denies TARGET_NOT_ELIGIBLE",
    async (status) => {
      await f.db.query("update enrolments set status=$1 where id=$2", [
        status,
        f.learnerEnrolmentId,
      ]);
      await asPolicyUser(f.db, 2);
      expect(await govern(f, args(f))).toEqual({
        ok: false,
        code: "TARGET_NOT_ELIGIBLE",
      });
    },
  );
});

// =============================================================================
// IMMUTABILITY
// =============================================================================
describe("Examiner initial-grade recovery: immutability", () => {
  it("the original failed execution is completely unchanged by a successful recovery", async () => {
    const before = await originalRow(f.assessmentOriginal);
    const a = await running(f);
    await govern(f, graded(f, a));
    expect(await originalRow(f.assessmentOriginal)).toEqual(before);
  });

  it("recovery execution identity cannot be mutated directly, even by the owning role", async () => {
    await asPolicyUser(f.db, 2);
    const admitted = await govern(f, args(f));
    const id = (admitted as { execution: { executionId: string } }).execution
      .executionId;
    await owner(f.db);
    await expect(
      f.db.query(
        "update commercial_v1_examiner_recovery_executions set source_execution_id=$1 where id=$2",
        [randomUUID(), id],
      ),
    ).rejects.toThrow("immutable");
  });

  it("a terminal recovery execution is immutable and cannot be deleted", async () => {
    const a = await running(f);
    const result = await govern(f, graded(f, a));
    const id = (result as { execution: { executionId: string } }).execution
      .executionId;
    await owner(f.db);
    await f.db.exec("savepoint mutate");
    try {
      await expect(
        f.db.query(
          "update commercial_v1_examiner_recovery_executions set state='FAILED' where id=$1",
          [id],
        ),
      ).rejects.toThrow("immutable");
    } finally {
      await f.db.exec("rollback to savepoint mutate; release savepoint mutate");
    }
    await expect(
      f.db.query(
        "delete from commercial_v1_examiner_recovery_executions where id=$1",
        [id],
      ),
    ).rejects.toThrow("cannot be deleted");
  });

  it("recovery usage is append-only", async () => {
    const a = await running(f);
    await govern(f, graded(f, a));
    await owner(f.db);
    const usageId = await scalar<string>(
      "select execution_id::text as v from commercial_v1_examiner_recovery_usage limit 1",
      [],
    );
    await expect(
      f.db.query(
        "update commercial_v1_examiner_recovery_usage set provider_calls=0 where execution_id=$1",
        [usageId],
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query(
        "delete from commercial_v1_examiner_recovery_usage where execution_id=$1",
        [usageId],
      ),
    ).rejects.toThrow();
  });
});

// =============================================================================
// REPLAY / BOUNDING -- exactly one recovery claim ever, per original target.
// =============================================================================
describe("Examiner initial-grade recovery: replay and the recovery ceiling", () => {
  it("a second AUTHORIZE for the same source while active is REPLAY_REJECTED, not a second row", async () => {
    await asPolicyUser(f.db, 2);
    await govern(f, args(f));
    expect(await govern(f, args(f))).toEqual({
      ok: false,
      code: "REPLAY_REJECTED",
    });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(1);
  });

  it("a successful recovery replays to the identical result without a second provider row", async () => {
    const a = await running(f);
    const first = await govern(f, graded(f, a));
    await asPolicyUser(f.db, 2);
    const replay = await govern(f, {
      ...args(f),
      p_execution_id: randomUUID(),
    });
    expect(replay).toMatchObject({
      ok: true,
      transitioned: false,
      execution: { state: "SUCCEEDED" },
    });
    expect(replay).toEqual({ ...(first as object), transitioned: false });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(1);
    expect(await resultCount("QUIZ_1")).toBe(1);
  });

  it("a genuinely concurrent AUTHORIZE for the same source never creates two rows (unique constraint)", async () => {
    await owner(f.db);
    const id1 = randomUUID(),
      id2 = randomUUID();
    const insert = (id: string) =>
      f.db.query(
        `insert into commercial_v1_examiner_recovery_executions(
          id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,capability,target_kind,
          attempt_id,component,runtime_profile_ref,state,created_at,authorized_at,expires_at,
          max_provider_calls,max_output_tokens,max_estimated_cost_microusd
        ) values ($1,$2,$3,'Race test',$4,$5,$6,'grade_controlled_assessment','ASSESSMENT_ATTEMPT',
          $7,'QUIZ_1','EXAMINER_COMMERCIAL_V1','AUTHORIZED',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '20 seconds',
          1,1200,50000)`,
        [
          id,
          administrator,
          f.assessmentOriginal,
          learner,
          f.learnerEnrolmentId,
          f.activationId,
          f.attemptId,
        ],
      );
    await insert(id1);
    await f.db.exec("savepoint race");
    try {
      await expect(insert(id2)).rejects.toThrow();
    } finally {
      await f.db.exec("rollback to savepoint race; release savepoint race");
    }
    expect(await recoveryCount(f.assessmentOriginal)).toBe(1);
  });

  it("a recovery that itself terminally fails is never automatically retried -- the ceiling is exactly one claim", async () => {
    const a = await running(f);
    await govern(f, {
      ...a,
      p_operation: "FINALIZE",
      p_state: "FAILED",
      p_reason: "PROVIDER_ERROR",
      p_calls: 1,
      p_attempts: 1,
      p_input: 10,
      p_output: 5,
      p_cost: 20,
      p_elapsed: 3,
    });
    await asPolicyUser(f.db, 2);
    const second = await govern(f, {
      ...args(f),
      p_execution_id: randomUUID(),
    });
    expect(second).toMatchObject({
      ok: true,
      transitioned: false,
      execution: { state: "FAILED" },
    });
    expect(await recoveryCount(f.assessmentOriginal)).toBe(1);
    expect(await resultCount("QUIZ_1")).toBe(0);
  });
});

// =============================================================================
// FINALIZATION
// =============================================================================
describe("Examiner initial-grade recovery: finalization", () => {
  it("a successful assessment recovery creates exactly one valid revision-1 result", async () => {
    const a = await running(f);
    const context = await govern(f, { ...a, p_operation: "CONTEXT_READ" });
    expect(context).toMatchObject({ ok: true, attemptId: f.attemptId });
    expect(context).not.toHaveProperty("recoveryReason");
    const result = await govern(f, graded(f, a, 8));
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED", reasonCode: "GRADED" },
    });
    const rows = await rowsOf<{ id: string; revision_number: number }>(
      "select id,revision_number from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
      [f.learnerEnrolmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revision_number).toBe(1);
    expect(
      await value(
        f.db,
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [rows[0].id],
      ),
    ).toBe(true);
  });

  it("a successful lab recovery creates exactly one valid revision-1 result", async () => {
    const a = await running(f, true);
    const result = await govern(f, graded(f, a, 6));
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    const rows = await rowsOf<{
      id: string;
      earned_marks: number;
      contribution_bp: number;
    }>(
      "select id,earned_marks,contribution_bp from commercial_v1_lab_result_revisions where enrolment_id=$1 and practical_id=$2",
      [f.learnerEnrolmentId, f.practical],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ earned_marks: 6, contribution_bp: 2000 });
    expect(
      await value(
        f.db,
        "select commercial_v1_private.lab_result_is_valid($1) as v",
        [rows[0].id],
      ),
    ).toBe(true);
  });

  it("malformed marks (unknown key) are rejected and create no result", async () => {
    const a = await running(f);
    const bad = {
      ...graded(f, a),
      p_assessment_marks: [
        { questionId: f.questionId, marksAwarded: 1, rationale: "x" },
      ],
    };
    expect(await govern(f, bad)).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "RESULT_INTEGRITY_FAILED" },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it("over-max marks are rejected and create no result", async () => {
    const a = await running(f);
    const bad = {
      ...graded(f, a),
      p_assessment_marks: [{ questionId: f.questionId, marksAwarded: 999 }],
      p_grade_digest: graded(f, a, 999).p_grade_digest,
    };
    expect(await govern(f, bad)).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "RESULT_INTEGRITY_FAILED" },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it("a foreign question in the marks payload is rejected and creates no result", async () => {
    const a = await running(f);
    const foreign = randomUUID();
    const marks = [{ questionId: foreign, marksAwarded: 1 }];
    const bad = {
      ...a,
      p_operation: "FINALIZE",
      p_state: "SUCCEEDED",
      p_reason: "GRADED",
      p_calls: 1,
      p_attempts: 1,
      p_input: 10,
      p_output: 5,
      p_cost: 20,
      p_elapsed: 3,
      p_assessment_marks: marks,
      p_grade_digest: computeExaminerAssessmentGradeDigest(marks),
    };
    expect(await govern(f, bad)).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "RESULT_INTEGRITY_FAILED" },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it("a grade-digest mismatch is rejected and creates no result", async () => {
    const a = await running(f);
    const bad = { ...graded(f, a), p_grade_digest: "c".repeat(64) };
    expect(await govern(f, bad)).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "RESULT_INTEGRITY_FAILED" },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it("ESCALATE from a genuinely RUNNING recovery creates no result", async () => {
    const a = await running(f);
    const result = await govern(f, {
      ...a,
      p_operation: "FINALIZE",
      p_state: "ESCALATED",
      p_reason: "HUMAN_REVIEW_REQUIRED",
    });
    expect(result).toMatchObject({
      ok: true,
      execution: {
        state: "ESCALATED",
        reviewPath: "ACADEMIC_REVIEW",
        resultRevisionId: null,
      },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
  });

  it("a genuine provider/runtime failure creates no fabricated result and preserves truthful usage", async () => {
    const a = await running(f);
    const failure = {
      ...a,
      p_operation: "FINALIZE",
      p_state: "FAILED",
      p_reason: "PROVIDER_TIMEOUT",
      p_calls: 1,
      p_attempts: 2,
      p_input: 80,
      p_output: 0,
      p_cost: 30,
      p_elapsed: 15000,
    };
    const result = await govern(f, failure);
    expect(result).toMatchObject({
      ok: true,
      execution: {
        state: "FAILED",
        reasonCode: "PROVIDER_TIMEOUT",
        resultRevisionId: null,
      },
    });
    expect(await resultCount("QUIZ_1")).toBe(0);
    const usage = await rowObject<{
      provider_calls: number;
      attempts: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_microusd: number;
      elapsed_ms: number;
    }>(
      "select provider_calls,attempts,input_tokens,output_tokens,estimated_cost_microusd,elapsed_ms from commercial_v1_examiner_recovery_usage where execution_id=$1",
      [
        (result as { execution: { executionId: string } }).execution
          .executionId,
      ],
    );
    expect(usage).toEqual({
      provider_calls: 1,
      attempts: 2,
      input_tokens: 80,
      output_tokens: 0,
      estimated_cost_microusd: 30,
      elapsed_ms: 15000,
    });
  });

  it("all-unanswered assessment work is a legitimate GRADED response (marks:[])", async () => {
    // seedOriginalExecution creates a real, fresh SUBMITTED attempt for
    // QUIZ_2 -- deliberately never answered, mirroring "a learner submitted
    // the assessment having answered nothing".
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_2",
      state: "FAILED",
    });
    const unansweredAttempt = await scalar<string>(
      "select attempt_id::text as v from commercial_v1_examiner_executions where id=$1",
      [id],
    );

    await asPolicyUser(f.db, 2);
    const a = { ...args(f), p_source_execution_id: id };
    const admitted = await govern(f, a);
    expect(admitted).toMatchObject({ ok: true });
    const startArgs = {
      ...a,
      p_student_id: learner,
      p_attempt_id: unansweredAttempt,
      p_enrolment_id: f.learnerEnrolmentId,
      p_activation_id: f.activationId,
      p_operation: "START",
      p_state: "RUNNING",
    };
    expect(await govern(f, startArgs)).toMatchObject({ ok: true });
    const digest = createHash("sha256").update("", "utf8").digest("hex");
    const result = await govern(f, {
      ...startArgs,
      p_operation: "FINALIZE",
      p_state: "SUCCEEDED",
      p_reason: "GRADED",
      p_calls: 1,
      p_attempts: 1,
      p_input: 10,
      p_output: 5,
      p_cost: 10,
      p_elapsed: 2,
      p_assessment_marks: [],
      p_grade_digest: digest,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    const rows = await rowsOf<{ marks_awarded: number }>(
      `select marks_awarded from commercial_v1_assessment_question_marks where result_revision_id=(
         select id from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_2')`,
      [f.learnerEnrolmentId],
    );
    expect(rows.every((r) => r.marks_awarded === 0)).toBe(true);
  });
});

// =============================================================================
// AUDIT / PRIVACY
// =============================================================================
describe("Examiner initial-grade recovery: audit privacy", () => {
  it("the audit event for a terminal recovery excludes the reason, protected content and any secret/MAC", async () => {
    const a = await running(f);
    const result = await govern(f, graded(f, a));
    const execId = (result as { execution: { executionId: string } }).execution
      .executionId;
    const event = await rowObject<{
      reason: string;
      after_state: Record<string, unknown>;
    }>(
      "select reason,after_state from audit_events where target_id=$1 order by occurred_at desc limit 1",
      [execId],
    );
    expect(event.reason).not.toMatch(/institutional recovery review/i);
    const json = JSON.stringify(event);
    expect(json).not.toContain("Independent institutional recovery review");
    expect(json).not.toContain("Protected learner response sentinel");
    expect(json).not.toContain(f.key.toString("hex"));
    expect(Object.keys(event.after_state).sort()).toEqual(
      [
        "actor_id",
        "activation_id",
        "attempt_id",
        "budget_stage",
        "capability",
        "component",
        "enrolment_id",
        "execution_id",
        "grade_digest",
        "practical_id",
        "reason_code",
        "result_revision_id",
        "runtime_profile_ref",
        "source_execution_id",
        "state",
        "student_id",
        "submission_id",
        "target_kind",
        "usage",
      ].sort(),
    );
  });
});
