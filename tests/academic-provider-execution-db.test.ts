import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { providerExecutionSnapshotSchema } from "@/domain/academic-provider-execution";
import {
  executionFixture,
  asExecutionUser,
  openExecutionRelease,
  learner,
  foreignLearner,
  type ExecutionFixture,
} from "./execution-fixture";
import {
  signedProviderCommand,
  sendProviderCommand,
} from "./provider-execution-fixture";

let f: ExecutionFixture;
let releaseId: string;
let executionId: string;
beforeAll(async () => {
  f = await executionFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
  await asExecutionUser(f.db, 1);
  releaseId = (await openExecutionRelease(f.db)).release_id;
  executionId = randomUUID();
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});
async function command(
  overrides: Parameters<typeof signedProviderCommand>[1] = {},
) {
  return sendProviderCommand(
    f.db,
    signedProviderCommand(f, { executionId, releaseId, ...overrides }),
  );
}
async function authorize(
  overrides: Parameters<typeof signedProviderCommand>[1] = {},
) {
  return command({ operation: "AUTHORIZE", state: "AUTHORIZED", ...overrides });
}
async function start() {
  return command({
    operation: "START",
    state: "RUNNING",
    maxCalls: 0,
    maxOutput: 0,
    maxCost: 0,
  });
}
async function finalize(
  overrides: Parameters<typeof signedProviderCommand>[1] = {},
) {
  return command({
    operation: "FINALIZE",
    maxCalls: 0,
    maxOutput: 0,
    maxCost: 0,
    ...overrides,
  });
}
async function rows() {
  await f.db.exec("reset role");
  const result = (
    await f.db.query<{
      id: string;
      state: string;
      reason_code: string | null;
      budget_stage: string | null;
      expires_at: Date;
      terminal_at: Date | null;
      max_provider_calls: number;
      max_output_tokens: number;
      max_estimated_cost_microusd: number;
    }>("select * from public.academic_provider_executions where id=$1", [
      executionId,
    ])
  ).rows;
  await f.db.exec("set role authenticated");
  return result;
}
async function usageRow() {
  await f.db.exec("reset role");
  const result = (
    await f.db.query<{
      execution_id: string;
      provider_calls: number;
      attempts: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_microusd: number;
      elapsed_ms: number;
    }>(
      "select * from public.academic_provider_execution_usage where execution_id=$1",
      [executionId],
    )
  ).rows;
  await f.db.exec("set role authenticated");
  return result;
}
async function audit() {
  await f.db.exec("reset role");
  const result = (
    await f.db.query<{
      action: string;
      source: string;
      after_state: Record<string, unknown>;
    }>(
      "select action,source,after_state from public.audit_events where target_type='academic_provider_executions' and target_id=$1 order by occurred_at,id",
      [executionId],
    )
  ).rows;
  await f.db.exec("set role authenticated");
  return result;
}
async function reject(sql: string, args: unknown[] = []) {
  await f.db.exec("savepoint denial");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow();
  } finally {
    await f.db.exec("rollback to savepoint denial; release savepoint denial");
  }
}

describe("V2 provider-backed execution: AUTHORIZE budget envelope", () => {
  it("accepts an admitted, non-zero, DB-ceiling-bounded budget", async () => {
    const result = await authorize({
      maxCalls: 2,
      maxOutput: 2000,
      maxCost: 80_000,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: {
        state: "AUTHORIZED",
        policyVersion: "PROFESSOR_EXECUTION_V2",
        executionKind: "PROVIDER_BACKED_V1",
        budget: {
          maxProviderCalls: 2,
          maxOutputTokens: 2000,
          maxEstimatedCostMicrousd: 80_000,
        },
        usage: null,
      },
    });
    expect(
      providerExecutionSnapshotSchema.safeParse(
        (result as { execution: unknown }).execution,
      ).success,
    ).toBe(true);
  });

  it("rejects a zero provider-call budget as BLOCKED/OUT_OF_ENVELOPE, never RUNNING", async () => {
    const result = await authorize({ maxCalls: 0 });
    // Mirrors migration 022's own V1 pattern exactly: a structured admission
    // refusal is itself a successful RPC call (ok:true) that durably commits
    // BLOCKED and its audit event, rather than raising/rolling back.
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "BLOCKED", reasonCode: "OUT_OF_ENVELOPE" },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      state: "BLOCKED",
      reason_code: "OUT_OF_ENVELOPE",
    });
    expect(row.terminal_at).not.toBeNull();
  });

  it("rejects a signed budget proposal above the DB's representable ceiling before it ever reaches business logic (the protocol cannot even express it)", async () => {
    // p_max_calls/p_max_output/p_max_cost are bounded in verify_command_v2's
    // own MAC-precondition range, set equal to the table's hard ceiling: a
    // proposal above the ceiling fails signature verification outright, a
    // stronger guarantee than a runtime check reached after verification.
    const result = await authorize({ maxCalls: 4 });
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
    expect(await rows()).toHaveLength(0);
  });

  it("rejects an admitted-range-but-still-invalid cost proposal of zero as BLOCKED/OUT_OF_ENVELOPE", async () => {
    const result = await authorize({ maxCost: 0 });
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "BLOCKED", reasonCode: "OUT_OF_ENVELOPE" },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      state: "BLOCKED",
      reason_code: "OUT_OF_ENVELOPE",
    });
  });

  it("provider is never called on failed admission: a BLOCKED row is already terminal and cannot START", async () => {
    await authorize({ maxCalls: 0 });
    const startResult = await start();
    // The execution row is already terminal (BLOCKED, not AUTHORIZED/
    // RUNNING); START cannot find an admittable row for this id at all, so
    // no provider call was ever, or could ever be, reached from here.
    expect(startResult).toMatchObject({ ok: false });
    const [row] = await rows();
    expect(row.state).toBe("BLOCKED");
  });
});

describe("V2 provider-backed execution: full lifecycle and durable usage", () => {
  it("AUTHORIZE -> START -> FINALIZE(SUCCEEDED) persists exactly the reported usage, tied immutably to the execution", async () => {
    await authorize({ maxCalls: 2, maxOutput: 1000, maxCost: 50_000 });
    const startResult = await start();
    expect(startResult).toMatchObject({
      ok: true,
      execution: { state: "RUNNING" },
    });

    const result = await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      attempts: 1,
      input: 400,
      output: 250,
      cost: 15_000,
      elapsed: 900,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: {
        state: "SUCCEEDED",
        reasonCode: "PROVIDER_COMPLETE",
        usage: {
          providerCalls: 1,
          attempts: 1,
          inputTokens: 400,
          outputTokens: 250,
          estimatedCostMicrousd: 15_000,
          elapsedMs: 900,
        },
      },
    });
    const [usage] = await usageRow();
    expect(usage).toMatchObject({
      execution_id: executionId,
      provider_calls: 1,
      attempts: 1,
      input_tokens: 400,
      output_tokens: 250,
      estimated_cost_microusd: 15_000,
      elapsed_ms: 900,
    });
    const events = await audit();
    expect(events.map((e) => e.action)).toEqual([
      "PROVIDER_EXECUTION_AUTHORIZED",
      "PROVIDER_EXECUTION_RUNNING",
      "PROVIDER_EXECUTION_SUCCEEDED",
    ]);
    const terminalAudit = events.at(-1)!;
    expect(terminalAudit.after_state.usage).toMatchObject({
      providerCalls: 1,
      inputTokens: 400,
      outputTokens: 250,
      estimatedCostMicrousd: 15_000,
    });
    // No prompt/response/content field exists anywhere in the audited state.
    expect(JSON.stringify(terminalAudit.after_state)).not.toMatch(
      /prompt|response|outputText|body|answer/i,
    );
  });

  it("rejects FINALIZE claiming SUCCEEDED with usage exceeding this execution's own admitted ceiling", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    const result = await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      output: 9000, // exceeds admitted maxOutput=500
      cost: 5000,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await usageRow()).toHaveLength(0);
    const [row] = await rows();
    expect(row.state).toBe("RUNNING");
  });

  it("rejects FINALIZE reporting more provider calls than were ever admitted, regardless of outcome", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    const result = await finalize({
      state: "FAILED",
      reason: "PROVIDER_ERROR",
      budgetStage: "NONE",
      calls: 2, // signable (0..3) but exceeds this row's admitted max of 1
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await usageRow()).toHaveLength(0);
  });

  it("persists real usage even for a discarded POST_CALL budget-block outcome", async () => {
    await authorize({ maxCalls: 1, maxOutput: 100, maxCost: 10_000 });
    await start();
    const result = await finalize({
      state: "BUDGET_BLOCKED",
      reason: "BUDGET_BLOCKED",
      budgetStage: "POST_CALL",
      calls: 1,
      attempts: 1,
      input: 300,
      output: 5000, // over ceiling -- this is WHY it's budget-blocked
      cost: 1000,
      elapsed: 700,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "BUDGET_BLOCKED", budgetStage: "POST_CALL" },
    });
    const [usage] = await usageRow();
    expect(usage).toMatchObject({ provider_calls: 1, output_tokens: 5000 });
  });

  it("persists real usage for FAILED/CANCELLED/ABSTAINED/ESCALATED terminal outcomes", async () => {
    const cases: Array<{ state: string; reason: string; budgetStage: string }> =
      [
        {
          state: "FAILED",
          reason: "PROVIDER_UNAVAILABLE",
          budgetStage: "NONE",
        },
        { state: "CANCELLED", reason: "CANCELLED", budgetStage: "NONE" },
        {
          state: "ABSTAINED",
          reason: "NO_PROVIDER_CONFIGURED",
          budgetStage: "NONE",
        },
        {
          state: "ESCALATED",
          reason: "HUMAN_REVIEW_REQUIRED",
          budgetStage: "NONE",
        },
      ];
    for (const finalState of cases) {
      executionId = randomUUID();
      releaseId = (await openExecutionRelease(f.db)).release_id;
      await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
      await start();
      const result = await finalize({ ...finalState, calls: 1, elapsed: 250 });
      expect(result).toMatchObject({
        ok: true,
        execution: { state: finalState.state },
      });
      expect(await usageRow()).toHaveLength(1);
    }
  });

  it("BLOCKER 2: a RUNNING execution can FINALIZE as FAILED/EXECUTION_TIMEOUT with nonzero truthful usage, persisting one immutable usage row and a terminal FAILED/EXECUTION_TIMEOUT row", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    // Before this correction, EXECUTION_TIMEOUT was not a valid FAILED
    // reason in either the table's own lifecycle CHECK or this FINALIZE
    // whitelist, so a genuine controller-observed runtime deadline could
    // never be recorded here at all -- only INVALID_INPUT, leaving the row
    // stuck RUNNING until the DB's own separate lazy-expiry sweep (a
    // different mechanism entirely, exercised by the "stale AUTHORIZED
    // execution lazily expires" test above, not this one).
    const result = await finalize({
      state: "FAILED",
      reason: "EXECUTION_TIMEOUT",
      budgetStage: "NONE",
      calls: 1,
      attempts: 1,
      input: 120,
      output: 40,
      cost: 500,
      elapsed: 999,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "FAILED", reasonCode: "EXECUTION_TIMEOUT" },
    });
    const [usage] = await usageRow();
    expect(usage).toMatchObject({
      execution_id: executionId,
      provider_calls: 1,
      attempts: 1,
      input_tokens: 120,
      output_tokens: 40,
      estimated_cost_microusd: 500,
      elapsed_ms: 999,
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      state: "FAILED",
      reason_code: "EXECUTION_TIMEOUT",
    });
    expect(row.terminal_at).not.toBeNull();
  });

  it("replay cannot duplicate usage: a second FINALIZE for the same execution is rejected and leaves exactly one usage row", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      output: 100,
      cost: 100,
    });
    const replay = await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      output: 999,
      cost: 999,
    });
    expect(replay).toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    const usage = await usageRow();
    expect(usage).toHaveLength(1);
    expect(usage[0].output_tokens).toBe(100);
  });

  it("FINALIZE is not gated by the release still being ACTIVE (it is expected to run after release closure)", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    await f.db.query("select public.close_academic_content_release($1,true)", [
      releaseId,
    ]);
    const result = await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      output: 50,
      cost: 50,
    });
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
  });

  it("FINALIZE requires correct learner/release/execution identity: a mismatched release id is denied", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    const result = await finalize({ releaseId: randomUUID() });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("V2 provider-backed execution: timeout, replay, forgery", () => {
  it("a stale AUTHORIZED execution lazily expires to TIMEOUT/EXECUTION_TIMEOUT on the next command, never a fabricated success", async () => {
    await authorize();
    await f.db.exec(
      "reset role; alter table public.academic_provider_executions disable trigger guard_provider_execution_history",
    );
    // created_at/authorized_at/expires_at must move together to preserve
    // the table's own expires_at>created_at (and <=+20s) invariant.
    await f.db.query(
      "update public.academic_provider_executions set created_at=clock_timestamp()-interval '21 seconds',authorized_at=clock_timestamp()-interval '21 seconds',expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [executionId],
    );
    await f.db.exec(
      "alter table public.academic_provider_executions enable trigger guard_provider_execution_history; set role authenticated",
    );
    const result = await start();
    expect(result).toMatchObject({ ok: false, code: "EXECUTION_TIMEOUT" });
    const [row] = await rows();
    expect(row).toMatchObject({
      state: "TIMEOUT",
      reason_code: "EXECUTION_TIMEOUT",
    });
  });

  it("rejects an invalid MAC", async () => {
    const args = signedProviderCommand(f, { executionId, releaseId });
    args.p_mac = "0".repeat(64);
    expect(await sendProviderCommand(f.db, args)).toMatchObject({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a replayed AUTHORIZE for the same execution/release", async () => {
    await authorize();
    const replay = await authorize();
    expect(replay).toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
  });

  it("fails closed once the controller key is revoked, even with an otherwise-valid MAC", async () => {
    await f.db.exec("reset role");
    await f.db.query(
      "update academic_execution_private.controller_keys set revoked_at=clock_timestamp() where id=$1",
      [f.keyId],
    );
    await f.db.exec("set role authenticated");
    const result = await authorize();
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
    await f.db.exec("reset role");
    await f.db.query(
      "update academic_execution_private.controller_keys set revoked_at=null where id=$1",
      [f.keyId],
    );
    await f.db.exec("set role authenticated");
  });
});

describe("V2 provider-backed execution: immutability and ACL hardening", () => {
  it("terminal execution history cannot be updated or deleted", async () => {
    await authorize({ maxCalls: 0 }); // immediately BLOCKED (terminal)
    await f.db.exec("reset role");
    await reject(
      "update public.academic_provider_executions set state='SUCCEEDED' where id=$1",
      [executionId],
    );
    await reject(
      "delete from public.academic_provider_executions where id=$1",
      [executionId],
    );
    await f.db.exec("set role authenticated");
  });

  it("provider execution usage is append-only: no update or delete is ever accepted", async () => {
    await authorize({ maxCalls: 1, maxOutput: 500, maxCost: 10_000 });
    await start();
    await finalize({
      state: "SUCCEEDED",
      reason: "PROVIDER_COMPLETE",
      budgetStage: "NONE",
      calls: 1,
      output: 10,
      cost: 10,
    });
    await f.db.exec("reset role");
    await reject(
      "update public.academic_provider_execution_usage set output_tokens=999999 where execution_id=$1",
      [executionId],
    );
    await reject(
      "delete from public.academic_provider_execution_usage where execution_id=$1",
      [executionId],
    );
    await f.db.exec("set role authenticated");
  });

  it("denies direct authenticated table access to executions and usage", async () => {
    await reject("select * from public.academic_provider_executions");
    await reject("select * from public.academic_provider_execution_usage");
    await reject(
      "insert into public.academic_provider_executions(id,student_id,release_id,invocation_id,state,reason_code,created_at,authorized_at,expires_at,terminal_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd) values($1,$2,$3,$3,'AUTHORIZED',null,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 seconds',null,1,100,100)",
      [randomUUID(), learner, randomUUID()],
    );
  });

  it("denies service_role and anon access to the tables, private schema functions and the public RPC", async () => {
    await f.db.exec("reset role");
    for (const role of ["service_role", "anon"]) {
      await f.db.exec(`set role ${role}`);
      await reject("select * from public.academic_provider_executions");
      await reject("select * from public.academic_provider_execution_usage");
      await reject(
        "select academic_execution_private.verify_command_v2(null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null)",
      );
      await reject(
        `select public.govern_professor_provider_execution(${Array.from({ length: 19 }, (_, i) => `$${i + 1}`).join(",")})`,
        signedProviderCommand(f) as unknown as unknown[],
      );
      await f.db.exec("reset role");
    }
    await f.db.exec("set role authenticated");
  });

  it("a foreign (non-owning) learner cannot read or affect this execution", async () => {
    await authorize();
    await asExecutionUser(f.db, 3); // foreignLearner
    const result = await start();
    expect(result).toMatchObject({ ok: false });
    await f.db.exec("reset role");
    const [row] = await f.db
      .query<{ student_id: string }>(
        "select student_id from public.academic_provider_executions where id=$1",
        [executionId],
      )
      .then((r) => r.rows);
    expect(row.student_id).toBe(learner);
    expect(row.student_id).not.toBe(foreignLearner);
    await f.db.exec("set role authenticated");
  });
});
