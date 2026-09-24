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
  administrator,
  type RecoveryFixture,
} from "./commercial-v1-examiner-recovery-fixture";

// ============================================================================
// Independent-review Finding 1: the bounded admin discovery read surface
// added by migration 202609240041 --
// list_commercial_v1_examiner_recovery_targets and
// get_commercial_v1_examiner_recovery_target. These are plain reads (no
// controller MAC, no state transition); admission/eligibility/HMAC
// correctness itself remains proven exhaustively by
// commercial-v1-examiner-recovery-db.test.ts. This file's job is proving
// the LISTING surface agrees with that eligibility policy, distinguishes
// every recovery-claim status correctly, is properly access-controlled, and
// leaks no protected content.
// ============================================================================

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

async function listTargets() {
  return value<{ targets: Record<string, unknown>[] }>(
    f.db,
    "select list_commercial_v1_examiner_recovery_targets() as v",
  );
}
async function getTarget(sourceExecutionId: string) {
  return value<Record<string, unknown>>(
    f.db,
    "select get_commercial_v1_examiner_recovery_target($1) as v",
    [sourceExecutionId],
  );
}
function targetFor(list: { targets: Record<string, unknown>[] }, id: string) {
  return list.targets.find((t) => t.sourceExecutionId === id);
}

describe("Examiner recovery operations: admission and authority", () => {
  it("an ACADEMIC_ADMIN can list eligible stranded targets", async () => {
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    const row = targetFor(list, f.assessmentOriginal);
    expect(row).toMatchObject({
      sourceExecutionId: f.assessmentOriginal,
      targetKind: "ASSESSMENT_ATTEMPT",
      capability: "grade_controlled_assessment",
      component: "QUIZ_1",
      originalState: "FAILED",
      recoveryStatus: "ELIGIBLE",
      recoveryExecutionId: null,
    });
  });

  it("a PLATFORM_ADMIN can also list", async () => {
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await f.db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      administrator,
    ]);
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, f.assessmentOriginal)).toBeTruthy();
  });

  it.each([1, 3, null])(
    "denies STUDENT/foreign/unauthenticated %s for both list and get-target",
    async (n) => {
      await asPolicyUser(f.db, n);
      await expect(listTargets()).rejects.toThrow();
      await expect(getTarget(f.assessmentOriginal)).rejects.toThrow();
    },
  );

  it("denies an unrelated staff role (INSTRUCTOR, no admin grant)", async () => {
    await f.db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [administrator],
    );
    await asPolicyUser(f.db, 2);
    await expect(listTargets()).rejects.toThrow();
  });

  it("anon and service_role cannot call either RPC or read the underlying view", async () => {
    async function denied(sql: string) {
      await f.db.exec("savepoint acl_denial");
      try {
        await expect(f.db.query(sql)).rejects.toThrow();
      } finally {
        await f.db.exec(
          "rollback to savepoint acl_denial; release savepoint acl_denial",
        );
      }
    }
    for (const r of ["anon", "service_role"]) {
      await f.db.exec(`set role ${r}`);
      await denied("select list_commercial_v1_examiner_recovery_targets()");
      await denied(
        `select get_commercial_v1_examiner_recovery_target('${f.assessmentOriginal}')`,
      );
      await denied(
        "select 1 from commercial_v1_recovery_private.stranded_targets",
      );
    }
    await owner(f.db);
  });
});

describe("Examiner recovery operations: eligibility agreement with the governed policy", () => {
  it("an ESCALATED original does not appear as recoverable", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_2",
      state: "ESCALATED",
    });
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, id)).toBeUndefined();
    await expect(getTarget(id)).rejects.toThrow();
  });

  it("a SUCCEEDED (result-bearing) original does not appear as recoverable", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_3",
      state: "SUCCEEDED",
    });
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, id)).toBeUndefined();
    await expect(getTarget(id)).rejects.toThrow();
  });

  it("an active (RUNNING) initial execution does not appear as recoverable", async () => {
    const id = await seedActiveOriginalExecution(f, "QUIZ_4");
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, id)).toBeUndefined();
    await expect(getTarget(id)).rejects.toThrow();
  });

  it.each(["FAILED", "TIMEOUT", "BUDGET_BLOCKED", "CANCELLED"] as const)(
    "a terminal %s original with no result appears ELIGIBLE",
    async (state) => {
      const id = await seedOriginalExecution(f, {
        component: "FINAL",
        state,
      });
      await asPolicyUser(f.db, 2);
      const list = await listTargets();
      expect(targetFor(list, id)).toMatchObject({
        originalState: state,
        recoveryStatus: "ELIGIBLE",
      });
      const single = await getTarget(id);
      expect(single).toMatchObject({ recoveryStatus: "ELIGIBLE" });
    },
  );
});

describe("Examiner recovery operations: recovery-claim status distinguishes correctly", () => {
  it("a source with an AUTHORIZED/RUNNING recovery claim shows RECOVERY_IN_PROGRESS and cannot be listed as ELIGIBLE", async () => {
    await running(f);
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, f.assessmentOriginal)).toMatchObject({
      recoveryStatus: "RECOVERY_IN_PROGRESS",
    });
  });

  it("a source whose recovery SUCCEEDED shows RECOVERED, distinct from never-attempted ELIGIBLE", async () => {
    const a = await running(f);
    await govern(f, graded(f, a));
    await asPolicyUser(f.db, 2);
    const list = await listTargets();
    expect(targetFor(list, f.assessmentOriginal)).toMatchObject({
      recoveryStatus: "RECOVERED",
    });
  });

  it("a source whose recovery itself ESCALATED shows RECOVERY_ESCALATED", async () => {
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.set_agent_config($1,'EXAMINER',true,null,null,array['grade_controlled_assessment','grade_practical_lab'],'ACADEMIC_REVIEW','Escalation policy for operations test')",
      [f.programmeVersionId],
    );
    await govern(f, args(f));
    const list = await listTargets();
    expect(targetFor(list, f.assessmentOriginal)).toMatchObject({
      recoveryStatus: "RECOVERY_ESCALATED",
    });
  });

  it("a source whose ONE recovery claim terminally failed shows RECOVERY_EXHAUSTED -- the ceiling is used, never a second claim", async () => {
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
    const list = await listTargets();
    expect(targetFor(list, f.assessmentOriginal)).toMatchObject({
      recoveryStatus: "RECOVERY_EXHAUSTED",
    });
    const single = await getTarget(f.assessmentOriginal);
    expect(single).toMatchObject({ recoveryStatus: "RECOVERY_EXHAUSTED" });
  });
});

describe("Examiner recovery operations: privacy minimisation", () => {
  it("the projection contains only bounded operational metadata -- no protected content, MAC or secret", async () => {
    await asPolicyUser(f.db, 2);
    const single = await getTarget(f.assessmentOriginal);
    expect(Object.keys(single).sort()).toEqual(
      [
        "activationId",
        "capability",
        "component",
        "enrolmentId",
        "originalReasonCode",
        "originalState",
        "practicalId",
        "recoveryExecutionId",
        "recoveryState",
        "recoveryStatus",
        "sourceExecutionId",
        "studentId",
        "targetKind",
        "terminalAt",
      ].sort(),
    );
    for (const forbidden of [
      "responseBody",
      "expectedAnswer",
      "markingGuidance",
      "recoveryReason",
      "recovery_reason",
      "mac",
      "questions",
      "submissionBody",
    ]) {
      expect(single).not.toHaveProperty(forbidden);
    }
  });

  it("a nonexistent source execution id is NOT_FOUND_OR_FORBIDDEN, never leaking existence", async () => {
    await asPolicyUser(f.db, 2);
    await expect(
      getTarget("00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow();
  });
});
