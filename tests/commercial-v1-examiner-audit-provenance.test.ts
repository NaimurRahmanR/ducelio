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
  recoveryFixture,
  seedOriginalExecution,
  owner,
  value,
  learner,
  administrator,
  type RecoveryFixture,
} from "./commercial-v1-examiner-recovery-fixture";

// ============================================================================
// Independent-review Finding 3: migrations 031, 032 and 040 each classified
// an audit_events row's `source` column using reason_code alone (`case when
// reason_code='EXECUTION_TIMEOUT' then DATABASE_EXECUTION_POLICY else
// ATTESTED_EXECUTION_CONTROLLER end`), conflating two structurally different
// events that both happen to carry that reason code: a genuine DB-owned
// lazy-expiry sweep (state='TIMEOUT') versus a controller-attested FINALIZE
// reporting the runtime/provider itself observed a timeout
// (state='FAILED', reason_code='EXECUTION_TIMEOUT'). Migration
// 202609240041 corrects all three trigger functions to classify on `state`
// instead. These tests exercise the trigger functions directly via raw,
// owner-level inserts satisfying each table's own CHECK constraints exactly
// (the same test-owner technique commercial-v1-examiner-recovery-
// fixture.ts's own seedOriginalExecution already uses) -- deliberately NOT
// the full governed-RPC/HMAC path, since admission/eligibility/replay
// correctness is already proven exhaustively elsewhere and is not what this
// correction changes. No content/privacy field is added to any audit row by
// this correction; these tests also confirm that.
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

async function auditSource(
  targetType: string,
  targetId: string,
  state: string,
) {
  return value<string | null>(
    f.db,
    `select source as v from audit_events
     where target_type=$1 and target_id=$2 and after_state->>'state'=$3
     order by occurred_at desc limit 1`,
    [targetType, targetId, state],
  );
}
async function auditAfterState(
  targetType: string,
  targetId: string,
  state: string,
) {
  return value<Record<string, unknown>>(
    f.db,
    `select after_state as v from audit_events
     where target_type=$1 and target_id=$2 and after_state->>'state'=$3
     order by occurred_at desc limit 1`,
    [targetType, targetId, state],
  );
}

// ----------------------------------------------------------------------------
// Initial grading (commercial_v1_examiner_executions, migration 031's trigger
// -- reuses seedOriginalExecution directly, no new insert helper needed.
// ----------------------------------------------------------------------------
describe("Examiner audit provenance: initial grading", () => {
  it("a DB-owned lazy-expiry TIMEOUT is classified DATABASE_EXECUTION_POLICY", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_2",
      state: "TIMEOUT",
    });
    expect(
      await auditSource("commercial_v1_examiner_executions", id, "TIMEOUT"),
    ).toBe("DATABASE_EXECUTION_POLICY");
  });

  it("a controller-attested FAILED/EXECUTION_TIMEOUT is classified ATTESTED_EXECUTION_CONTROLLER -- never DATABASE_EXECUTION_POLICY (the misclassification this correction fixes)", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_3",
      state: "FAILED",
      reasonCode: "EXECUTION_TIMEOUT",
    });
    expect(
      await auditSource("commercial_v1_examiner_executions", id, "FAILED"),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });

  it("a normal SUCCEEDED transition retains ATTESTED_EXECUTION_CONTROLLER (regression, unaffected by this correction)", async () => {
    const id = await seedOriginalExecution(f, {
      component: "QUIZ_4",
      state: "SUCCEEDED",
    });
    expect(
      await auditSource("commercial_v1_examiner_executions", id, "SUCCEEDED"),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });

  it("a normal FAILED transition with a different reason retains ATTESTED_EXECUTION_CONTROLLER", async () => {
    const id = await seedOriginalExecution(f, {
      component: "FINAL",
      state: "FAILED",
      reasonCode: "PROVIDER_ERROR",
    });
    const after = await auditAfterState(
      "commercial_v1_examiner_executions",
      id,
      "FAILED",
    );
    expect(
      await auditSource("commercial_v1_examiner_executions", id, "FAILED"),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
    // No content/privacy field is introduced by this correction -- the
    // audit content itself is unchanged, only `source` classification is.
    for (const forbidden of [
      "responseBody",
      "expectedAnswer",
      "markingGuidance",
      "prompt",
      "mac",
    ])
      expect(after).not.toHaveProperty(forbidden);
  });
});

// ----------------------------------------------------------------------------
// Regrade (commercial_v1_examiner_regrade_executions, migration 032's
// trigger) -- raw owner-level insert satisfying migration 032's own CHECK
// constraints; no production route can use this raw writer.
// ----------------------------------------------------------------------------
async function insertRegradeRow(
  attemptId: string,
  state: string,
  reasonCode: string,
) {
  await owner(f.db);
  const id = randomUUID();
  const budgetStage = state === "BUDGET_BLOCKED" ? "PRE_CALL" : null;
  const resultRevisionId = state === "SUCCEEDED" ? randomUUID() : null;
  const gradeDigest = state === "SUCCEEDED" ? "a".repeat(64) : null;
  await f.db.query(
    `insert into commercial_v1_examiner_regrade_executions(
      id,actor_id,source_result_revision_id,source_revision_number,request_reason,
      student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
      runtime_profile_ref,state,reason_code,budget_stage,
      created_at,terminal_at,expires_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd,grade_digest,result_revision_id
    ) values ($1,$2,$3,1,'Audit provenance regression test',
      $4,$5,$6,'regrade_controlled_assessment','ASSESSMENT_ATTEMPT',$7,'QUIZ_1',
      'EXAMINER_COMMERCIAL_V1',$8,$9,$10,
      clock_timestamp()-interval '1 minute',clock_timestamp()-interval '50 seconds',clock_timestamp()-interval '40 seconds',
      1,1200,50000,$11,$12)`,
    [
      id,
      administrator,
      randomUUID(),
      learner,
      f.learnerEnrolmentId,
      f.activationId,
      attemptId,
      state,
      reasonCode,
      budgetStage,
      gradeDigest,
      resultRevisionId,
    ],
  );
  return id;
}

describe("Examiner audit provenance: regrade", () => {
  it("a DB-owned lazy-expiry TIMEOUT is classified DATABASE_EXECUTION_POLICY", async () => {
    const id = await insertRegradeRow(
      f.attemptId,
      "TIMEOUT",
      "EXECUTION_TIMEOUT",
    );
    expect(
      await auditSource(
        "commercial_v1_examiner_regrade_executions",
        id,
        "TIMEOUT",
      ),
    ).toBe("DATABASE_EXECUTION_POLICY");
  });

  it("a controller-attested FAILED/EXECUTION_TIMEOUT is classified ATTESTED_EXECUTION_CONTROLLER", async () => {
    const id = await insertRegradeRow(
      f.attemptId,
      "FAILED",
      "EXECUTION_TIMEOUT",
    );
    expect(
      await auditSource(
        "commercial_v1_examiner_regrade_executions",
        id,
        "FAILED",
      ),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });

  it("a normal SUCCEEDED transition retains ATTESTED_EXECUTION_CONTROLLER", async () => {
    const id = await insertRegradeRow(f.attemptId, "SUCCEEDED", "GRADED");
    expect(
      await auditSource(
        "commercial_v1_examiner_regrade_executions",
        id,
        "SUCCEEDED",
      ),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });
});

// ----------------------------------------------------------------------------
// Initial-grade recovery (commercial_v1_examiner_recovery_executions,
// migration 040's trigger) -- raw owner-level insert satisfying migration
// 040's own CHECK constraints, mirroring the recovery-db test file's own
// "race" raw-insert technique.
// ----------------------------------------------------------------------------
async function insertRecoveryRow(
  sourceExecutionId: string,
  attemptId: string,
  state: string,
  reasonCode: string,
) {
  await owner(f.db);
  const id = randomUUID();
  const budgetStage = state === "BUDGET_BLOCKED" ? "PRE_CALL" : null;
  const resultRevisionId = state === "SUCCEEDED" ? randomUUID() : null;
  const gradeDigest = state === "SUCCEEDED" ? "a".repeat(64) : null;
  await f.db.query(
    `insert into commercial_v1_examiner_recovery_executions(
      id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,
      capability,target_kind,attempt_id,component,runtime_profile_ref,state,reason_code,budget_stage,
      created_at,terminal_at,expires_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd,grade_digest,result_revision_id
    ) values ($1,$2,$3,'Audit provenance regression test',$4,$5,$6,
      'grade_controlled_assessment','ASSESSMENT_ATTEMPT',$7,'QUIZ_1','EXAMINER_COMMERCIAL_V1',$8,$9,$10,
      clock_timestamp()-interval '1 minute',clock_timestamp()-interval '50 seconds',clock_timestamp()-interval '40 seconds',
      1,1200,50000,$11,$12)`,
    [
      id,
      administrator,
      sourceExecutionId,
      learner,
      f.learnerEnrolmentId,
      f.activationId,
      attemptId,
      state,
      reasonCode,
      budgetStage,
      gradeDigest,
      resultRevisionId,
    ],
  );
  return id;
}
async function attemptIdOfOriginal(id: string) {
  return value<string>(
    f.db,
    "select attempt_id::text as v from commercial_v1_examiner_executions where id=$1",
    [id],
  );
}

describe("Examiner audit provenance: initial-grade recovery", () => {
  it("a DB-owned lazy-expiry TIMEOUT is classified DATABASE_EXECUTION_POLICY", async () => {
    const original = await seedOriginalExecution(f, {
      component: "QUIZ_2",
      state: "FAILED",
    });
    const attemptId = await attemptIdOfOriginal(original);
    const id = await insertRecoveryRow(
      original,
      attemptId,
      "TIMEOUT",
      "EXECUTION_TIMEOUT",
    );
    expect(
      await auditSource(
        "commercial_v1_examiner_recovery_executions",
        id,
        "TIMEOUT",
      ),
    ).toBe("DATABASE_EXECUTION_POLICY");
  });

  it("a controller-attested FAILED/EXECUTION_TIMEOUT is classified ATTESTED_EXECUTION_CONTROLLER -- never DATABASE_EXECUTION_POLICY", async () => {
    const original = await seedOriginalExecution(f, {
      component: "QUIZ_3",
      state: "FAILED",
    });
    const attemptId = await attemptIdOfOriginal(original);
    const id = await insertRecoveryRow(
      original,
      attemptId,
      "FAILED",
      "EXECUTION_TIMEOUT",
    );
    expect(
      await auditSource(
        "commercial_v1_examiner_recovery_executions",
        id,
        "FAILED",
      ),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });

  it("a normal SUCCEEDED transition retains ATTESTED_EXECUTION_CONTROLLER", async () => {
    const original = await seedOriginalExecution(f, {
      component: "QUIZ_4",
      state: "FAILED",
    });
    const attemptId = await attemptIdOfOriginal(original);
    const id = await insertRecoveryRow(
      original,
      attemptId,
      "SUCCEEDED",
      "GRADED",
    );
    expect(
      await auditSource(
        "commercial_v1_examiner_recovery_executions",
        id,
        "SUCCEEDED",
      ),
    ).toBe("ATTESTED_EXECUTION_CONTROLLER");
  });
});
