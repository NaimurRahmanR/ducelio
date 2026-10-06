import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/acceptance/ac3-handoff-race.mjs: the AC-3 / migration-052 true
// PostgreSQL concurrency acceptance scenario. These are behavioural tests of
// its orchestration and verdicts against in-memory stand-in connections. They
// prove nothing about real PostgreSQL concurrency (PGlite/in-memory cannot);
// only the hosted run can.

type Row = Record<string, unknown>;
type Query = { sql: string; params?: unknown[] };

const LEARNER_AUTH = "aaaaaaaa-0000-4000-8000-000000000001";
const STUDENT = "bbbbbbbb-0000-4000-8000-000000000001";
const HANDOFF = "cccccccc-0000-4000-8000-000000000001";
const OTHER_HANDOFF = "cccccccc-0000-4000-8000-000000000002";
const EXECUTION = "dddddddd-0000-4000-8000-000000000001";
const OBJECTIVE = "eeeeeeee-0000-4000-8000-000000000001";
const fixture = {
  runId: "ac3-test",
  learnerAuthUserId: LEARNER_AUTH,
  studentId: STUDENT,
  enrolmentId: "ffffffff-0000-4000-8000-000000000001",
  programmeVersionId: "ffffffff-0000-4000-8000-000000000002",
  classSessionId: "ffffffff-0000-4000-8000-000000000003",
  classroomId: "ffffffff-0000-4000-8000-000000000004",
  lessonId: "ffffffff-0000-4000-8000-000000000005",
  objectiveId: OBJECTIVE,
  sourceExecutionId: EXECUTION,
};

type Options = {
  pids?: [number, number];
  canSet?: boolean;
  firewall?: boolean | "error";
  setRoleFails?: boolean;
  appUser?: string;
  // Simulated RPC: "correct" serialises on a classroom lock exactly like
  // migration 052; "broken" lets both create; or a fixed result/error.
  rpc?: "correct" | "broken" | Row | Error;
  rpcResults?: [Row, Row];
};

// Two in-memory connections sharing one simulated database. Every
// statement is appended to `log` as `${client}:${kind}`.
function fakeDatabase(options: Options = {}) {
  const log: string[] = [];
  const queries: Query[][] = [[], []];
  let lockHolder: number | null = null;
  const waiters: (() => void)[] = [];
  let created: string | null = null;
  let rpcCalls = 0;
  const pids = options.pids ?? [101, 202];
  const make = (index: number) => ({
    async query(sql: string, params?: unknown[]) {
      queries[index].push({ sql, params });
      const kind = sql.trim().split(/\s+/).slice(0, 3).join(" ");
      if (sql.includes("pg_backend_pid()")) {
        log.push(`${index}:probe`);
        // Answers only the SET-privilege probe (PostgreSQL 16+ distinguishes
        // SET from MEMBER); any other probe yields no can_set and fails closed.
        const asksSet = sql.includes(
          "pg_has_role(current_user, 'authenticated', 'SET') as can_set",
        );
        return {
          rows: [
            {
              pid: pids[index],
              ...(asksSet ? { can_set: options.canSet ?? true } : {}),
            },
          ],
        };
      }
      if (sql.includes("academic_content_release_explain_allowed")) {
        if (options.firewall === "error")
          throw Object.assign(new Error("permission denied"), {
            code: "42501",
          });
        return { rows: [{ allowed: options.firewall ?? true }] };
      }
      if (sql === "set local role authenticated") {
        log.push(`${index}:set-role`);
        if (options.setRoleFails)
          throw Object.assign(new Error("permission denied to set role"), {
            code: "42501",
          });
        return { rows: [] };
      }
      if (sql.includes("current_app_user()")) {
        log.push(`${index}:prepared`);
        return {
          rows: [
            { role: "authenticated", app_user: options.appUser ?? STUDENT },
          ],
        };
      }
      if (sql.includes("request_professor_academic_handoff")) {
        log.push(`${index}:rpc`);
        rpcCalls += 1;
        const rpc = options.rpc ?? "correct";
        if (rpc instanceof Error) throw rpc;
        if (options.rpcResults)
          return { rows: [{ v: options.rpcResults[index] }] };
        if (rpc === "broken")
          return {
            rows: [{ v: { ok: true, duplicate: false, handoffId: HANDOFF } }],
          };
        if (rpc !== "correct") return { rows: [{ v: rpc }] };
        // The classroom FOR UPDATE lock, held until COMMIT.
        if (lockHolder !== null && lockHolder !== index)
          await new Promise<void>((resolveLock) => waiters.push(resolveLock));
        lockHolder = index;
        if (created)
          return {
            rows: [{ v: { ok: true, duplicate: true, handoffId: created } }],
          };
        created = HANDOFF;
        return {
          rows: [{ v: { ok: true, duplicate: false, handoffId: HANDOFF } }],
        };
      }
      if (sql.includes("clock_timestamp()")) {
        log.push(`${index}:clock`);
        return { rows: [{ t: "2026-10-06T00:00:00.000Z" }] };
      }
      if (sql === "commit" || sql === "rollback") {
        log.push(`${index}:${sql}`);
        if (lockHolder === index) {
          lockHolder = null;
          waiters.shift()?.();
        }
        return { rows: [] };
      }
      log.push(`${index}:${kind}`);
      return { rows: [] };
    },
  });
  const clients = [make(0), make(1)];
  return {
    log,
    queries,
    clients,
    rpcCalls: () => rpcCalls,
    connectMany: async (n: number) => {
      log.push(`connectMany:${n}`);
      return {
        clients,
        closeAll: async () => {
          log.push("closeAll");
        },
      };
    },
  };
}

const goodVerification = {
  projectionRows: [
    {
      handoff_id: HANDOFF,
      destination_role: "TUTOR",
      reason_code: "OBJECTIVE_REINFORCEMENT",
      scope_key: `OBJECTIVE:${OBJECTIVE}`,
      objective_id: OBJECTIVE,
      source_professor_execution_id: EXECUTION,
    },
  ],
  deliveryRows: [
    {
      id: HANDOFF,
      destination_profile: "TUTOR",
      reason_code: "OBJECTIVE_REINFORCEMENT",
      objective_id: OBJECTIVE,
    },
  ],
};

async function load() {
  return import("../scripts/acceptance/ac3-handoff-race.mjs");
}

async function run(
  db: ReturnType<typeof fakeDatabase>,
  overrides: Record<string, unknown> = {},
) {
  const m = await load();
  return m.scenarioAc3ProfessorHandoffDuplicate("ac3-test", {
    seedFixture: async () => fixture,
    connectMany: db.connectMany,
    assertAllWriteAuthorized: async () => {
      db.log.push("write-gate");
    },
    readVerification: async () => goodVerification,
    ...overrides,
  });
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("AC3_PROFESSOR_HANDOFF_DUPLICATE: orchestration", () => {
  it("PASSes on two independent connections with distinct backend pids, gated, prepared, then released together", async () => {
    const db = fakeDatabase();
    const result = await run(db);
    expect(result.status).toBe("PASS");
    expect(result.surface).toBe(
      "POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE",
    );
    expect(result.reason).toContain("pg_backend_pid 101 and 202");
    expect(result.reason).toContain("separate from the Commercial V1");
    expect(result.reason).toContain("not evidence of Professor HMAC");
    // Exactly two connections, write-gated before any statement.
    expect(db.log[0]).toBe("connectMany:2");
    expect(db.log[1]).toBe("write-gate");
    // Both connections fully prepared before either RPC is dispatched.
    const firstRpc = db.log.findIndex((e) => e.endsWith(":rpc"));
    const prepared = db.log
      .map((e, i) => (e.endsWith(":prepared") ? i : -1))
      .filter((i) => i >= 0);
    expect(prepared).toHaveLength(2);
    expect(Math.max(...prepared)).toBeLessThan(firstRpc);
    expect(db.rpcCalls()).toBe(2);
    expect(db.log.at(-1)).toBe("closeAll");
  });

  it("establishes the learner context independently on each connection via request-JWT GUCs and SET LOCAL ROLE authenticated, then calls only the governed RPC", async () => {
    const db = fakeDatabase();
    await run(db);
    for (const queries of db.queries) {
      const sql = queries.map((q) => q.sql);
      const claims = queries.find((q) => q.sql.includes("request.jwt.claims"));
      expect(claims?.params).toEqual([
        JSON.stringify({
          sub: LEARNER_AUTH,
          role: "authenticated",
          aud: "authenticated",
        }),
        LEARNER_AUTH,
      ]);
      expect(sql).toContain("begin");
      expect(sql).toContain("set local role authenticated");
      expect(sql.indexOf("set local role authenticated")).toBeLessThan(
        sql.findIndex((s) => s.includes("request_professor_academic_handoff")),
      );
      const rpc = queries.find((q) =>
        q.sql.includes("request_professor_academic_handoff"),
      );
      expect(rpc?.params).toEqual([
        fixture.classSessionId,
        "OBJECTIVE_REINFORCEMENT",
        OBJECTIVE,
      ]);
      // No direct write to the projection or delivery tables, no service
      // role and no destructive statement.
      for (const statement of sql) {
        expect(statement).not.toMatch(
          /insert into public\.(professor_academic_handoffs|delivery_handoffs)|service_role|truncate|drop |delete /i,
        );
      }
    }
  });

  it("releases both contenders from one shared start gate", async () => {
    const db = fakeDatabase();
    const gates: { parties: number; arrivals: number }[] = [];
    const m = await import("../scripts/acceptance/concurrency-app-races.mjs");
    const result = await run(db, {
      createStartGate: (parties: number) => {
        const record = { parties, arrivals: 0 };
        gates.push(record);
        const gate = m.createStartGate(parties);
        return {
          arrive() {
            record.arrivals += 1;
            return gate.arrive();
          },
        };
      },
    });
    expect(result.status).toBe("PASS");
    expect(gates).toEqual([{ parties: 2, arrivals: 2 }]);
  });
});

describe("AC3_PROFESSOR_HANDOFF_DUPLICATE: verdicts", () => {
  it("FAILs when both contenders share one backend process", async () => {
    const result = await run(fakeDatabase({ pids: [7, 7] }));
    expect(result.status).toBe("FAIL");
    expect(result.reason).toMatch(/two distinct backend processes/);
  });

  it("FAILs when both requests create (no duplicate) -- the lock/idempotency failed", async () => {
    const result = await run(fakeDatabase({ rpc: "broken" }));
    expect(result.status).toBe("FAIL");
    expect(result.reason).toMatch(/one duplicate=false and one duplicate=true/);
  });

  it("requires the same handoffId", async () => {
    const result = await run(
      fakeDatabase({
        rpcResults: [
          { ok: true, duplicate: false, handoffId: HANDOFF },
          { ok: true, duplicate: true, handoffId: OTHER_HANDOFF },
        ],
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.reason).toMatch(/different handoffIds/);
  });

  it.each([
    [
      "two projection rows",
      {
        ...goodVerification,
        projectionRows: [
          ...goodVerification.projectionRows,
          ...goodVerification.projectionRows,
        ],
      },
      /exactly one professor_academic_handoffs row/,
    ],
    [
      "no delivery handoff",
      { ...goodVerification, deliveryRows: [] },
      /exactly one matching delivery_handoffs row/,
    ],
    [
      "a wrong destination",
      {
        ...goodVerification,
        projectionRows: [
          {
            ...goodVerification.projectionRows[0],
            destination_role: "LAB_INSTRUCTOR",
          },
        ],
      },
      /expected handoff\/destination\/reason\/scope\/source/,
    ],
    [
      "a different source execution",
      {
        ...goodVerification,
        projectionRows: [
          {
            ...goodVerification.projectionRows[0],
            source_professor_execution_id: OTHER_HANDOFF,
          },
        ],
      },
      /expected handoff\/destination\/reason\/scope\/source/,
    ],
    [
      "a delivery handoff with another id",
      {
        ...goodVerification,
        deliveryRows: [
          { ...goodVerification.deliveryRows[0], id: OTHER_HANDOFF },
        ],
      },
      /does not match the projection/,
    ],
  ])("FAILs on %s", async (_label, verification, pattern) => {
    const result = await run(fakeDatabase(), {
      readVerification: async () => verification,
    });
    expect(result.status).toBe("FAIL");
    expect(result.reason).toMatch(pattern);
  });

  it("FAILs on an unexpected RPC result, never PASS", async () => {
    for (const rpc of [
      { ok: false, code: "NO_SOURCE_EXECUTION" },
      { ok: false, code: "DESTINATION_BEHAVIOUR_UNSUPPORTED" },
      { ok: true, duplicate: "no", handoffId: HANDOFF },
      { ok: true, duplicate: false, handoffId: "not-a-uuid" },
    ]) {
      const result = await run(fakeDatabase({ rpc }));
      expect(result.status).toBe("FAIL");
    }
  });

  it("FAILs on an unrelated database or network error during the race", async () => {
    const result = await run(
      fakeDatabase({ rpc: new Error("Connection terminated unexpectedly") }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.details).toContain("Connection terminated unexpectedly");
  });

  it("FAILs when the fixture setup itself errors unexpectedly", async () => {
    const result = await run(fakeDatabase(), {
      seedFixture: async () => {
        throw new Error("create_class_session failed: overlap");
      },
    });
    expect(result.status).toBe("FAIL");
  });

  it("reports BLOCKED when both requests hit the controlled-assessment firewall", async () => {
    const result = await run(
      fakeDatabase({ rpc: { ok: false, code: "ACTIVITY_BLOCKED" } }),
    );
    expect(result.status).toBe("BLOCKED");
  });
});

describe("AC3_PROFESSOR_HANDOFF_DUPLICATE: fails closed", () => {
  it("is BLOCKED, with no statement issued, when write authorization is missing (real db.mjs gate)", async () => {
    delete process.env.ACCEPTANCE_WRITE_ENABLED;
    const db = fakeDatabase();
    const result = await run(db, { assertAllWriteAuthorized: undefined });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/ACCEPTANCE_WRITE_ENABLED/);
    expect(db.queries.flat()).toHaveLength(0);
    expect(db.rpcCalls()).toBe(0);
  });

  it("is BLOCKED when the write gate rejects the database marker", async () => {
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const db = fakeDatabase();
    const result = await run(db, {
      assertAllWriteAuthorized: async () => {
        throw new AcceptanceWriteNotAuthorizedError("marker mismatch");
      },
    });
    expect(result.status).toBe("BLOCKED");
    expect(db.rpcCalls()).toBe(0);
  });

  it.each([
    [
      "the connection lacks SET permission for authenticated (pg_has_role SET = false)",
      { canSet: false },
      /does not have permission to SET ROLE authenticated/,
    ],
    [
      "SET LOCAL ROLE authenticated is refused",
      { setRoleFails: true },
      /SET LOCAL ROLE authenticated was refused/,
    ],
    [
      "the JWT context resolves to a different app user",
      { appUser: "99999999-0000-4000-8000-000000000009" },
      /did not resolve to the acceptance learner/,
    ],
    [
      "the learner has an active controlled assessment",
      { firewall: false },
      /active controlled assessment/,
    ],
  ])(
    "is BLOCKED, never bypassed, when %s",
    async (_label, options, pattern) => {
      const db = fakeDatabase(options as Options);
      const result = await run(db);
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toMatch(pattern);
      expect(db.rpcCalls()).toBe(0);
      expect(db.log).toContain("closeAll");
    },
  );

  it("does not abort the transaction when the firewall pre-check cannot be called", async () => {
    const db = fakeDatabase({ firewall: "error" });
    const result = await run(db);
    expect(result.status).toBe("PASS");
    for (const queries of db.queries)
      expect(queries.map((q) => q.sql)).toContain(
        "rollback to savepoint ac3_firewall_check",
      );
  });

  it("is BLOCKED by its own preconditions when the hosted configuration is absent", async () => {
    delete process.env.ACCEPTANCE_DATABASE_URL;
    const m = await load();
    expect(m.ac3Preconditions()).toMatchObject({ status: "BLOCKED" });
  });

  it("is BLOCKED when the fixture finds no AC-3-aware Tutor binding", async () => {
    const m = await load();
    const result = await run(fakeDatabase(), {
      seedFixture: async () => {
        throw new m.Ac3ContextUnavailable(
          "frozen Tutor binding is TUTOR_BEHAVIOUR_V1",
        );
      },
    });
    expect(result.status).toBe("BLOCKED");
  });
});

describe("integration with acceptance:concurrency", () => {
  it("runs as a separate, separately summarised scenario after the Commercial V1 summary", () => {
    const source = readFileSync(
      resolve("scripts/acceptance/concurrency.mjs"),
      "utf8",
    );
    const commercialSummary = source.indexOf(
      'printSummary(results, "Commercial V1 true-PostgreSQL-concurrency acceptance");\n\n',
    );
    const ac3 = source.indexOf("scenarioAc3ProfessorHandoffDuplicate(`ac3-");
    expect(commercialSummary).toBeGreaterThan(0);
    expect(ac3).toBeGreaterThan(commercialSummary);
    expect(source).toContain(
      'printSummary([ac3], "AC-3 true-PostgreSQL-concurrency acceptance")',
    );
  });
});
