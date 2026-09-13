import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  executionSnapshotSchema,
  NO_PROVIDER_BUDGET,
} from "@/domain/academic-execution";
import {
  executionFixture,
  asExecutionUser,
  openExecutionRelease,
  signedExecutionCommand,
  sendExecutionCommand,
  learner,
  foreignLearner,
  type ExecutionFixture,
} from "./execution-fixture";

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
  operation = "AUTHORIZE",
  state = "AUTHORIZED",
  reason = "NONE",
) {
  return sendExecutionCommand(
    f.db,
    signedExecutionCommand(f, {
      executionId,
      releaseId,
      operation,
      state,
      reason,
    }),
  );
}
async function rows() {
  await f.db.exec("reset role");
  const result = (
    await f.db.query<{
      id: string;
      state: string;
      reason_code: string;
      expires_at: Date;
      terminal_at: Date;
    }>("select * from public.academic_executions where id=$1", [executionId])
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
      "select action,source,after_state from public.audit_events where target_type='academic_executions' and target_id=$1 order by occurred_at,id",
      [executionId],
    )
  ).rows;
  await f.db.exec("set role authenticated");
  return result;
}
async function reject(
  sql: string,
  params: unknown[] = [],
  match = "permission denied",
) {
  await f.db.exec("savepoint execution_denial");
  await expect(f.db.query(sql, params)).rejects.toThrow(match);
  await f.db.exec(
    "rollback to savepoint execution_denial; release savepoint execution_denial",
  );
}
async function historicalExecutions(count: number, secondsAgo: number) {
  // Privileged fixture timestamps; no production clock override/renewal API.
  await f.db.exec("reset role");
  for (let i = 0; i < count; i++) {
    const rid = randomUUID(),
      invocation = randomUUID();
    await f.db.query(
      `insert into public.academic_content_releases(id,student_id,invocation_id,capability_name,capability_contract_version,state,started_at,expires_at,terminal_at)
      values($1,$2,$3,'get_lesson_context','PROFESSOR_READ_V2','COMPLETED',now()-$4*interval '1 second',now()-$4*interval '1 second'+interval '30 seconds',now()-$4*interval '1 second'+interval '2 seconds')`,
      [rid, learner, invocation, secondsAgo],
    );
    await f.db.query(
      `insert into public.academic_executions(id,student_id,release_id,invocation_id,state,reason_code,created_at,authorized_at,started_at,terminal_at,expires_at)
      values($1,$2,$3,$4,'ABSTAINED','POLICY_BLOCKED',now()-$5*interval '1 second',now()-$5*interval '1 second',now()-$5*interval '1 second'+interval '1 second',now()-$5*interval '1 second'+interval '2 seconds',now()-$5*interval '1 second'+interval '20 seconds')`,
      [randomUUID(), learner, rid, invocation, secondsAgo],
    );
  }
  await f.db.exec("set role authenticated");
}
describe("B1 attested execution database governance", () => {
  it("deployment ACL acceptance rejects unsafe inherited service-role mutation rights", async () => {
    const migration = await readFile(
      "supabase/migrations/202609100022_phase3_trusted_execution_governance.sql",
      "utf8",
    );
    const acceptance = migration.slice(
      migration.indexOf("-- Effective-ACL acceptance:"),
    );
    expect(acceptance).toContain("do $$");
    await f.db.exec(
      "reset role; create role unsafe_execution_writer; grant update on public.audit_events to unsafe_execution_writer; grant unsafe_execution_writer to service_role",
    );
    await reject(
      acceptance,
      [],
      "Unsafe effective service-role execution privileges",
    );
  });
  it("explicit ACLs defeat broad service-role defaults while preserving authenticated entry points and audit reads", async () => {
    await f.db.exec("reset role");
    expect(
      (
        await f.db.query<{ rolbypassrls: boolean }>(
          "select rolbypassrls from pg_roles where rolname='service_role'",
        )
      ).rows[0].rolbypassrls,
    ).toBe(true);
    for (const table of [
      "public.academic_executions",
      "public.academic_content_releases",
      "public.audit_events",
      "academic_execution_private.controller_keys",
    ]) {
      for (const privilege of [
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        expect(
          (
            await f.db.query<{ allowed: boolean }>(
              "select has_table_privilege('service_role',$1,$2) as allowed",
              [table, privilege],
            )
          ).rows[0].allowed,
        ).toBe(false);
      }
      for (const privilege of ["INSERT", "UPDATE", "REFERENCES"])
        expect(
          (
            await f.db.query<{ allowed: boolean }>(
              "select has_any_column_privilege('service_role',$1,$2) as allowed",
              [table, privilege],
            )
          ).rows[0].allowed,
        ).toBe(false);
    }
    expect(
      (
        await f.db.query<{ allowed: boolean }>(
          "select has_table_privilege('service_role','public.audit_events','SELECT') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(true);
    for (const privilege of ["USAGE", "CREATE"])
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_schema_privilege('service_role','academic_execution_private',$1) as allowed",
            [privilege],
          )
        ).rows[0].allowed,
      ).toBe(false);
    const functions = (
      await f.db.query<{
        proname: string;
        service: boolean;
        learner: boolean;
      }>(`select p.proname,has_function_privilege('service_role',p.oid,'EXECUTE') as service,has_function_privilege('authenticated',p.oid,'EXECUTE') as learner
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='academic_execution_private' or
      (n.nspname='public' and p.proname in ('govern_professor_execution','begin_academic_content_release','close_academic_content_release','expire_my_academic_content_releases','academic_content_release_explain_allowed','guard_academic_content_release','audit_academic_content_release'))`)
    ).rows;
    // 12 from migration 022, plus migration 025's 5 additional private V2
    // functions in the same academic_execution_private schema (guard_
    // provider_execution, guard_provider_execution_usage, audit_provider_
    // execution, verify_command_v2, provider_execution_projection) -- all
    // must still be revoked from both service_role and authenticated below.
    expect(functions).toHaveLength(17);
    for (const fn of functions) {
      expect(fn.service).toBe(false);
      expect(fn.learner).toBe(
        [
          "govern_professor_execution",
          "begin_academic_content_release",
          "close_academic_content_release",
        ].includes(fn.proname),
      );
    }
  });
  it.each([
    "insert into public.academic_executions default values",
    "update public.academic_executions set state='SUCCEEDED'",
    "delete from public.academic_executions",
    "insert into public.audit_events(actor_id,action,target_type,target_id,source) select actor_id,'EXECUTION_SUCCEEDED','academic_executions',target_id,'ATTESTED_EXECUTION_CONTROLLER' from public.audit_events limit 1",
    "update public.audit_events set source='ATTESTED_EXECUTION_CONTROLLER'",
    "delete from public.audit_events",
    "insert into public.academic_content_releases default values",
    "update public.academic_content_releases set state='COMPLETED'",
    "delete from public.academic_content_releases",
  ])("service role cannot mutate trusted evidence via %s", async (sql) => {
    await command();
    await f.db.exec("set role service_role");
    await reject(sql);
  });
  it("service role cannot access keys, private helpers, release RPCs or even a valid signed execution command", async () => {
    const signed = signedExecutionCommand(f, { executionId, releaseId });
    await f.db.exec("set role service_role");
    for (const sql of [
      "select * from academic_execution_private.controller_keys",
      "select academic_execution_private.install_controller_key(null,null)",
      "select academic_execution_private.verify_command(null,null,null,null,null,null,null,null,null,null,null,null,null)",
      "select academic_execution_private.execution_projection(null,true)",
      "select public.begin_academic_content_release(null,null,null)",
      "select public.close_academic_content_release(null,false)",
      "select public.expire_my_academic_content_releases()",
      "select public.academic_content_release_explain_allowed()",
      "select public.audit_academic_content_release()",
    ])
      await reject(sql);
    await f.db.exec("savepoint forbidden_signed_command");
    await expect(sendExecutionCommand(f.db, signed)).rejects.toThrow(
      "permission denied",
    );
    await f.db.exec(
      "rollback to savepoint forbidden_signed_command; release savepoint forbidden_signed_command",
    );
  });
  it("admits a valid authenticated controller attestation with a bounded zero-provider envelope", async () => {
    const result = await command();
    expect(result).toMatchObject({
      ok: true,
      transitioned: true,
      execution: {
        executionId,
        studentId: learner,
        releaseId,
        state: "AUTHORIZED",
        budget: NO_PROVIDER_BUDGET,
        executionKind: "CONTROL_PLANE_ONLY",
      },
    });
    expect(
      executionSnapshotSchema.safeParse(
        (result as { execution: unknown }).execution,
      ).success,
    ).toBe(true);
    expect((await audit()).map((e) => e.action)).toEqual([
      "EXECUTION_AUTHORIZED",
    ]);
  });
  it.each([
    ["START", "RUNNING", "NONE"],
    ["FINALIZE", "SUCCEEDED", "CONTROL_PLANE_COMPLETE"],
    ["FINALIZE", "ABSTAINED", "ABSTAIN_UNCERTAIN"],
    ["FINALIZE", "ESCALATED", "HUMAN_REVIEW_REQUIRED"],
    ["FINALIZE", "FAILED", "INTERNAL_ERROR"],
  ])("browser cannot forge %s/%s", async (operation, state, reason) => {
    await command();
    const forged = {
      ...signedExecutionCommand(f, {
        executionId,
        releaseId,
        operation,
        state,
        reason,
      }),
      p_mac: "0".repeat(64),
    };
    expect(await sendExecutionCommand(f.db, forged)).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
    expect((await rows())[0].state).toBe("AUTHORIZED");
    expect(await audit()).toHaveLength(1);
  });
  it.each([
    "p_execution_id",
    "p_release_id",
    "p_operation",
    "p_state",
    "p_reason",
    "p_calls",
    "p_input",
    "p_output",
    "p_cost",
    "p_issued_at",
    "p_key_id",
  ])("rejects tampering with signed %s", async (field) => {
    const args = signedExecutionCommand(f, { executionId, releaseId });
    const replacement: Record<string, unknown> = {
      p_execution_id: randomUUID(),
      p_release_id: randomUUID(),
      p_operation: "START",
      p_state: "RUNNING",
      p_reason: "POLICY_BLOCKED",
      p_calls: 1,
      p_input: 1,
      p_output: 1,
      p_cost: 1,
      p_issued_at: args.p_issued_at + 1,
      p_key_id: randomUUID(),
    };
    expect(
      await sendExecutionCommand(f.db, {
        ...args,
        [field]: replacement[field],
      }),
    ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
    expect(await rows()).toHaveLength(0);
  });
  it.each([-30, 15])(
    "rejects stale/future attestation timestamp (%s seconds)",
    async (offset) => {
      expect(
        await sendExecutionCommand(
          f.db,
          signedExecutionCommand(f, {
            executionId,
            releaseId,
            issuedAt: Math.floor(Date.now() / 1000) + offset,
          }),
        ),
      ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
    },
  );
  it("rejects expiry tampering even when the replacement remains inside the time window", async () => {
    const args = signedExecutionCommand(f, { executionId, releaseId });
    expect(
      await sendExecutionCommand(f.db, {
        ...args,
        p_issued_at: args.p_issued_at + 1,
        p_expires_at: args.p_expires_at + 1,
      }),
    ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });
  it.each([9, 11])(
    "rejects a signed %s-second lifetime; the database fixes exactly ten seconds",
    async (lifetime) => {
      const issuedAt = Math.floor(Date.now() / 1000);
      expect(
        await sendExecutionCommand(
          f.db,
          signedExecutionCommand(f, {
            executionId,
            releaseId,
            issuedAt,
            expiresAt: issuedAt + lifetime,
          }),
        ),
      ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
    },
  );
  it("accepts bounded controller clock skew without using a caller-controlled DB clock", async () => {
    expect(
      await sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, {
          executionId,
          releaseId,
          issuedAt: Math.floor(Date.now() / 1000) + 4,
        }),
      ),
    ).toMatchObject({ ok: true, execution: { state: "AUTHORIZED" } });
  });
  it("rejects the exact captured AUTHORIZE, START and FINALIZE packets after their first committed transition", async () => {
    // Separate fixture uses actual autocommit, outside the per-test rollback.
    const committed = await executionFixture();
    try {
      await asExecutionUser(committed.db, 1);
      const ownRelease = await openExecutionRelease(committed.db);
      for (const [operation, state, reason] of [
        ["AUTHORIZE", "AUTHORIZED", "NONE"],
        ["START", "RUNNING", "NONE"],
        ["FINALIZE", "ABSTAINED", "POLICY_BLOCKED"],
      ]) {
        const packet = signedExecutionCommand(committed, {
          executionId,
          releaseId: ownRelease.release_id,
          operation,
          state,
          reason,
        });
        expect(await sendExecutionCommand(committed.db, packet)).toMatchObject({
          ok: true,
          transitioned: true,
        });
        expect(await sendExecutionCommand(committed.db, packet)).toEqual({
          ok: false,
          code: "REPLAY_REJECTED",
        });
      }
      await committed.db.exec("reset role");
      expect(
        (
          await committed.db.query(
            "select action from public.audit_events where target_type='academic_executions'",
          )
        ).rows,
      ).toHaveLength(3);
    } finally {
      await committed.db.close();
    }
  });
  it("cannot reuse a START signature for a successful terminal command", async () => {
    await command();
    const start = signedExecutionCommand(f, {
      executionId,
      releaseId,
      operation: "START",
      state: "RUNNING",
    });
    await sendExecutionCommand(f.db, start);
    expect(
      await sendExecutionCommand(f.db, {
        ...start,
        p_operation: "FINALIZE",
        p_state: "SUCCEEDED",
        p_reason: "CONTROL_PLANE_COMPLETE",
      }),
    ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
    expect((await rows())[0].state).toBe("RUNNING");
  });
  it("does not expose the private raw verifier", async () => {
    await reject(
      "select academic_execution_private.verify_command(null,null,null,null,null,null,null,null,null,null,null,null,null)",
    );
  });
  it("derives immutable invocation correlation and caps execution lifetime at the existing release expiry", async () => {
    await f.db.exec(
      "reset role; alter table public.academic_content_releases disable trigger guard_release_history",
    );
    await f.db.query(
      "update public.academic_content_releases set started_at=now()-interval '20 seconds',expires_at=now()+interval '10 seconds' where id=$1",
      [releaseId],
    );
    await f.db.exec(
      "alter table public.academic_content_releases enable trigger guard_release_history; set role authenticated",
    );
    const admitted = (await command()) as {
      execution: { expiresAt: string; invocationId: string };
    };
    await f.db.exec("reset role");
    const release = (
      await f.db.query<{ expires_at: Date; invocation_id: string }>(
        "select expires_at,invocation_id from public.academic_content_releases where id=$1",
        [releaseId],
      )
    ).rows[0];
    expect(Date.parse(admitted.execution.expiresAt)).toBe(
      new Date(release.expires_at).getTime(),
    );
    expect(admitted.execution.invocationId).toBe(release.invocation_id);
    await reject(
      "update public.academic_executions set invocation_id=$1 where id=$2",
      [randomUUID(), executionId],
      "immutable",
    );
    await reject(
      "update public.academic_executions set max_provider_calls=1 where id=$1",
      [executionId],
      "immutable",
    );
  });
  it("database constraints reject NULL terminal reason or timestamp", async () => {
    await command();
    await command("START", "RUNNING");
    await f.db.exec("reset role");
    await reject(
      "update public.academic_executions set state='ABSTAINED',terminal_at=clock_timestamp() where id=$1",
      [executionId],
      "check constraint",
    );
    await reject(
      "update public.academic_executions set state='ABSTAINED',reason_code='POLICY_BLOCKED' where id=$1",
      [executionId],
      "check constraint",
    );
  });
  it("revocation disables a key and keys cannot be provisioned/read by authenticated actors", async () => {
    await reject("select * from academic_execution_private.controller_keys");
    await reject(
      "select academic_execution_private.install_controller_key($1,$2::bytea)",
      [randomUUID(), f.key],
    );
    await f.db.exec("reset role");
    await f.db.query(
      "update academic_execution_private.controller_keys set revoked_at=clock_timestamp() where id=$1",
      [f.keyId],
    );
    await f.db.exec("set role authenticated");
    expect(await command()).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });
  it("binds the signature to DB-derived identity, with no actor parameter to override it", async () => {
    const signed = signedExecutionCommand(f, { executionId, releaseId });
    await asExecutionUser(f.db, 3);
    expect(await sendExecutionCommand(f.db, signed)).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
    expect(
      await sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, {
          executionId,
          releaseId,
          actor: foreignLearner,
        }),
      ),
    ).toEqual({ ok: false, code: "CONTENT_RELEASE_UNAVAILABLE" });
  });
  it("multi-role STUDENT has no additional signing or table authority", async () => {
    await f.db.exec("reset role");
    await f.db.query(
      "insert into public.role_grants values($1,'PLATFORM_ADMIN'),($1,'ACADEMIC_ADMIN')",
      [learner],
    );
    await f.db.exec("set role authenticated");
    expect(
      await sendExecutionCommand(f.db, {
        ...signedExecutionCommand(f, { executionId, releaseId }),
        p_mac: "f".repeat(64),
      }),
    ).toEqual({ ok: false, code: "UNTRUSTED_EXECUTION" });
    await reject("select * from public.academic_executions");
    await reject("select * from academic_execution_private.controller_keys");
  });
  it("non-STUDENT and unauthenticated principals cannot admit execution", async () => {
    await asExecutionUser(f.db, 2);
    expect(
      await sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, {
          executionId,
          releaseId,
          actor: "10000000-0000-4000-8000-000000000002",
        }),
      ),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    await asExecutionUser(f.db, null);
    expect(await command()).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });
  it.each([
    ["SUCCEEDED", "CONTROL_PLANE_COMPLETE"],
    ["FAILED", "INTERNAL_ERROR"],
    ["ABSTAINED", "ABSTAIN_UNCERTAIN"],
    ["ESCALATED", "HUMAN_REVIEW_REQUIRED"],
  ])(
    "simulates trusted control-plane %s lifecycle without any provider",
    async (state, reason) => {
      await command();
      expect(await command("START", "RUNNING")).toMatchObject({
        ok: true,
        execution: { state: "RUNNING" },
      });
      expect(await command("FINALIZE", state, reason)).toMatchObject({
        ok: true,
        transitioned: true,
        execution: {
          state,
          reasonCode: reason,
          reviewPath: state === "ESCALATED" ? "ACADEMIC_REVIEW" : null,
        },
      });
      expect(await command("FINALIZE", state, reason)).toEqual({
        ok: false,
        code: "REPLAY_REJECTED",
      });
      expect((await audit()).map((e) => e.action)).toEqual([
        "EXECUTION_AUTHORIZED",
        "EXECUTION_RUNNING",
        `EXECUTION_${state}`,
      ]);
      await f.db.exec("reset role");
      await reject(
        "update public.academic_executions set reason_code='INTERNAL_ERROR' where id=$1",
        [executionId],
        "immutable",
      );
      await reject(
        "delete from public.academic_executions where id=$1",
        [executionId],
        "cannot be deleted",
      );
    },
  );
  it("rejects duplicate admission, START replay, and replacing terminal outcomes", async () => {
    await command();
    expect(await command()).toEqual({ ok: false, code: "REPLAY_REJECTED" });
    expect(
      await sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, { releaseId }),
      ),
    ).toEqual({ ok: false, code: "REPLAY_REJECTED" });
    await command("START", "RUNNING");
    expect(await command("START", "RUNNING")).toEqual({
      ok: false,
      code: "REPLAY_REJECTED",
    });
    await command("FINALIZE", "ABSTAINED", "POLICY_BLOCKED");
    expect(
      await command("FINALIZE", "SUCCEEDED", "CONTROL_PLANE_COMPLETE"),
    ).toEqual({ ok: false, code: "REPLAY_REJECTED" });
  });
  it("rejects skipping RUNNING and unsupported state/reason pairs", async () => {
    await command();
    expect(
      await command("FINALIZE", "SUCCEEDED", "CONTROL_PLANE_COMPLETE"),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(await command("FINALIZE", "SUCCEEDED", "INTERNAL_ERROR")).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await command("FINALIZE", "FAILED", "PROVIDER_ERROR")).toEqual({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });
  });
  it("denies direct lifecycle/audit mutations and a private projection bypass", async () => {
    await command();
    for (const sql of [
      "insert into public.academic_executions default values",
      "update public.academic_executions set state='SUCCEEDED'",
      "delete from public.academic_executions",
      "insert into public.audit_events default values",
      "update public.audit_events set source='ATTESTED_EXECUTION_CONTROLLER'",
      "delete from public.audit_events",
      "select academic_execution_private.execution_projection(null,true)",
    ])
      await reject(sql);
  });
  it("enforces the one-execution concurrency ceiling and commits admission denial metadata", async () => {
    await command();
    const second = await openExecutionRelease(f.db);
    const response = await sendExecutionCommand(
      f.db,
      signedExecutionCommand(f, { releaseId: second.release_id }),
    );
    expect(response).toMatchObject({
      ok: true,
      execution: { state: "BLOCKED", reasonCode: "RATE_LIMITED" },
    });
  });
  it.each([
    [5, 40],
    [30, 120],
  ])(
    "enforces the %s-event window ceiling using DB accounting",
    async (count, age) => {
      await historicalExecutions(count, age);
      expect(await command()).toMatchObject({
        ok: true,
        execution: { state: "BLOCKED", reasonCode: "RATE_LIMITED" },
      });
    },
  );
  it("admissions outside both windows do not consume the current security ceiling", async () => {
    await historicalExecutions(30, 3700);
    expect(await command()).toMatchObject({
      ok: true,
      execution: { state: "AUTHORIZED" },
    });
  });
  it.each(["calls", "input", "output", "cost"])(
    "cannot raise the B1 zero-provider %s budget even with a signed proposal",
    async (field) => {
      expect(
        await sendExecutionCommand(
          f.db,
          signedExecutionCommand(f, { executionId, releaseId, [field]: 1 }),
        ),
      ).toMatchObject({
        ok: true,
        execution: {
          state: "BLOCKED",
          reasonCode: "BUDGET_BLOCKED",
          budget: NO_PROVIDER_BUDGET,
        },
      });
    },
  );
  it("deterministically finalizes timed-out execution before a new admission", async () => {
    await command();
    await f.db.exec(
      "reset role; alter table public.academic_executions disable trigger guard_execution_history",
    );
    await f.db.query(
      "update public.academic_executions set created_at=now()-interval '21 seconds',authorized_at=now()-interval '21 seconds',expires_at=now()-interval '1 second' where id=$1",
      [executionId],
    );
    await f.db.exec(
      "alter table public.academic_executions enable trigger guard_execution_history; set role authenticated",
    );
    expect(await command("START", "RUNNING")).toEqual({
      ok: false,
      code: "EXECUTION_TIMEOUT",
    });
    const timedOut = (await rows())[0];
    expect(timedOut.state).toBe("FAILED");
    expect(timedOut.terminal_at).toEqual(timedOut.expires_at);
    expect((await audit()).at(-1)).toMatchObject({
      action: "EXECUTION_FAILED",
      source: "DATABASE_EXECUTION_POLICY",
    });
    const second = await openExecutionRelease(f.db);
    expect(
      await sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, { releaseId: second.release_id }),
      ),
    ).toMatchObject({ ok: true, execution: { state: "AUTHORIZED" } });
  });
  it.each(["COMPLETED", "ABORTED", "EXPIRED", "BLOCKED"])(
    "rejects %s release correlation",
    async (state) => {
      if (state === "COMPLETED" || state === "ABORTED")
        await f.db.query(
          "select public.close_academic_content_release($1,$2)",
          [releaseId, state === "COMPLETED"],
        );
      else {
        await f.db.exec("reset role");
        const rid = randomUUID();
        await f.db.query(
          `insert into public.academic_content_releases(id,student_id,invocation_id,capability_name,capability_contract_version,state,started_at,expires_at,terminal_at)
        values($1,$2,$3,'get_lesson_context','PROFESSOR_READ_V2',$4,now()-interval '40 seconds',now()-interval '10 seconds',case when $4='EXPIRED' then now()-interval '10 seconds' else now()-interval '40 seconds' end)`,
          [rid, learner, randomUUID(), state],
        );
        releaseId = rid;
        await f.db.exec("set role authenticated");
      }
      expect(await command()).toEqual({
        ok: false,
        code: "CONTENT_RELEASE_UNAVAILABLE",
      });
    },
  );
  it("assessment cannot start during the bound release and invalidates execution after premature closure", async () => {
    await command();
    await command("START", "RUNNING");
    await reject(
      "select public.start_assessment_attempt($1)",
      [f.assessmentId],
      "Academic activity is busy",
    );
    await f.db.query("select public.close_academic_content_release($1,true)", [
      releaseId,
    ]);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    expect(
      await command("FINALIZE", "SUCCEEDED", "CONTROL_PLANE_COMPLETE"),
    ).toEqual({ ok: false, code: "CONTENT_RELEASE_UNAVAILABLE" });
    expect((await rows())[0].state).toBe("FAILED");
  });
  it("introspection cannot create a release that authorizes an execution", async () => {
    expect(
      (
        await f.db.query<{ value: unknown }>(
          "select public.begin_academic_content_release($1,'get_actor_context','PROFESSOR_READ_V2') as value",
          [randomUUID()],
        )
      ).rows[0].value,
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
  });
  it("audit persistence failure rolls back admission and terminal updates", async () => {
    await command();
    await command("START", "RUNNING");
    await f.db
      .exec(`reset role;create function public.fail_execution_audit() returns trigger language plpgsql as $$begin if NEW.target_type='academic_executions' then raise exception 'Audit persistence unavailable'; end if;return NEW;end$$;
      create trigger fail_execution_audit before insert on public.audit_events for each row execute function public.fail_execution_audit();set role authenticated;savepoint broken_audit`);
    await expect(
      command("FINALIZE", "ABSTAINED", "POLICY_BLOCKED"),
    ).rejects.toThrow("Audit persistence unavailable");
    await f.db.exec(
      "rollback to savepoint broken_audit; release savepoint broken_audit",
    );
    expect((await rows())[0].state).toBe("RUNNING");
    expect(await audit()).toHaveLength(2);
    const newRelease = await openExecutionRelease(f.db);
    await f.db.exec("savepoint broken_admission");
    await expect(
      sendExecutionCommand(
        f.db,
        signedExecutionCommand(f, { releaseId: newRelease.release_id }),
      ),
    ).rejects.toThrow("Audit persistence unavailable");
    await f.db.exec(
      "rollback to savepoint broken_admission; release savepoint broken_admission",
    );
  });
  it("persisted execution/audit metadata exclude content, credentials, signatures and arbitrary reasons", async () => {
    await f.db.query("select set_config('app.audit_reason',$1,true)", [
      "prompt resource body objective prose evidence_reference expected_answer marking_guidance learner answer support prose",
    ]);
    const args = signedExecutionCommand(f, { executionId, releaseId });
    await sendExecutionCommand(f.db, args);
    await command("START", "RUNNING");
    await command("FINALIZE", "ESCALATED", "HUMAN_REVIEW_REQUIRED");
    const metadata = JSON.stringify([await rows(), await audit()]);
    expect(metadata).not.toMatch(
      /prompt|resource body|objective prose|evidence_reference|expected_answer|marking_guidance|learner answer|support prose|secret|p_mac|signature/i,
    );
    expect(metadata).not.toContain(f.key.toString("hex"));
    expect(metadata).not.toContain(args.p_mac);
    for (const event of await audit())
      expect(Object.keys(event.after_state).sort()).toEqual(
        [
          "execution_id",
          "student_id",
          "release_id",
          "invocation_id",
          "agent_profile",
          "policy_version",
          "execution_kind",
          "state",
          "reason_code",
          "created_at",
          "authorized_at",
          "started_at",
          "terminal_at",
          "expires_at",
          "review_path",
          "max_provider_calls",
          "max_input_tokens",
          "max_output_tokens",
          "max_estimated_cost_microusd",
        ].sort(),
      );
  });
});
