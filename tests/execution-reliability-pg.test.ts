import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  approvedTestPackage,
  people,
  publishAcademyCourse,
  releaseNow,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";

// Migration 064 under TRUE PostgreSQL, through the REAL controller
// transports (attestProviderExecutionCommand, attestTutorLabExecutionCommand),
// the REAL reliability commands and the REAL Academy runtimes, on a
// DISPOSABLE local server (DUCELIO_TEST_POSTGRES_URL). The governance under
// test is the shared, enrolment-agnostic migration 025 / 028 governance that
// cohort and Academy executions both use. Only identity, the PostgREST
// transport and the provider (a deterministic stub) are substituted; no paid
// provider is called. Every scenario runs in its own clone of one template.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const runId = randomUUID().slice(0, 8);
const TEMPLATE = `ducelio_reliab_${runId}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = key.toString("hex");
const learnerA = people.learnerA as Person;
const learnerB = people.learnerB as Person;
const enrolments: Record<string, string> = {};
let lessonItem = "";
let lessonRef = "";
let objectiveId = "";

const urlFor = (database: string) => {
  const url = new URL(ADMIN_URL ?? "postgres://localhost/postgres");
  url.pathname = "/" + database;
  return url.toString();
};
async function connect(database: string) {
  const client = new pg.Client({ connectionString: urlFor(database) });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function scenario() {
  const name = `ducelio_reliab_s${created.length}_${runId}`;
  const admin = await connect("postgres");
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();
  created.push(name);
  m.database = name;
  return name;
}
async function rows(database: string, sql: string, args: unknown[] = []) {
  const owner = await connect(database);
  try {
    return (await owner.query(sql, args)).rows;
  } finally {
    await owner.end();
  }
}
async function asLearner<T>(
  database: string,
  person: Person,
  sql: string,
  args: unknown[],
) {
  const client = await connect(database);
  try {
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
      person.auth,
    ]);
    await client.query("set role authenticated");
    return (await client.query(sql, args)).rows[0].v as T;
  } finally {
    await client.end();
  }
}
async function waitForBlocked(database: string, count: number) {
  const admin = await connect("postgres");
  try {
    for (let i = 0; i < 400; i++) {
      const { rows } = await admin.query(
        "select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
        [database],
      );
      if (rows[0].n >= count) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} blocked sessions`);
  } finally {
    await admin.end();
  }
}
// Simulate the passage of time for one execution: shift its own instants
// 25 seconds into the past (the owner disables the history guard for this
// single update only). Its 20-second envelope then lies in the past.
async function age(database: string, table: string, executionId: string) {
  const guard =
    table === "academic_provider_executions"
      ? "guard_provider_execution_history"
      : "guard_tutor_lab_provider_execution_history";
  const owner = await connect(database);
  try {
    await owner.query("begin");
    await owner.query(`alter table public.${table} disable trigger ${guard}`);
    await owner.query(
      `update public.${table} set created_at = created_at - interval '25 seconds',
         authorized_at = authorized_at - interval '25 seconds',
         started_at = started_at - interval '25 seconds',
         expires_at = expires_at - interval '25 seconds' where id = $1`,
      [executionId],
    );
    await owner.query(`alter table public.${table} enable trigger ${guard}`);
    await owner.query("commit");
  } finally {
    await owner.end();
  }
}

// The runtime's PostgREST transport over a fresh real connection per call,
// as whichever learner is signed in.
const m = vi.hoisted(() => ({
  database: "",
  person: null as null | { id: string; auth: string },
}));
vi.mock("@/server/identity", () => {
  const actor = () =>
    m.person
      ? { id: m.person.id, roles: ["STUDENT"], displayName: "Learner" }
      : null;
  return {
    getAuthenticatedActor: async () => actor(),
    getCurrentActor: async () => actor(),
    requireStudentPrincipal: async () => {
      const a = actor();
      if (!a) throw new Error("unauthenticated");
      return a;
    },
    requireActor: async () => actor(),
  };
});
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const client = await connect(m.database);
      try {
        const sig = await client.query(
          `select p.proargnames names, array(select format_type(t,null) from unnest(p.proargtypes) t) types
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,
          [name],
        );
        const { names, types } = sig.rows[0] as {
          names: string[] | null;
          types: string[];
        };
        const used = (names ?? [])
          .map((n, i) => ({ n, t: types[i] }))
          .filter((p) => p.n in args);
        await client.query(
          "select set_config('request.jwt.claim.sub',$1,false)",
          [m.person?.auth ?? ""],
        );
        await client.query("set role authenticated");
        const r = await client.query(
          `select public.${name}(${used.map((p, i) => `${p.n} => $${i + 1}::${p.t}`).join(",")}) v`,
          used.map((p) =>
            p.t === "jsonb" && args[p.n] != null
              ? JSON.stringify(args[p.n])
              : args[p.n],
          ),
        );
        return { data: r.rows[0].v, error: null };
      } catch (e) {
        const err = e as { message: string; code?: string };
        return { data: null, error: { message: err.message, code: err.code } };
      } finally {
        await client.end();
      }
    },
  }),
}));

import { attestProviderExecutionCommand } from "@/server/academic-provider-execution/authority";
import { attestTutorLabExecutionCommand } from "@/server/tutor-lab-execution/authority";
import {
  abandonUnstartedProviderExecution,
  recordLateProviderUsage,
} from "@/server/provider-execution-reliability";
import { executeAcademyProfessorClassroomWithTestOverrides } from "@/server/academic-runtime/academy-professor";
import { executeAcademySupportWithTestOverrides } from "@/server/tutor-lab-execution/academy";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type ProviderAdapter,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

const usage = {
  providerCalls: 1,
  attempts: 1,
  inputTokens: 120,
  outputTokens: 40,
  estimatedCostMicrousd: 90,
  elapsedMs: 900,
};
const budget = {
  maxProviderCalls: 1,
  maxOutputTokens: 500,
  maxEstimatedCostMicrousd: 10_000,
};
const profile = (ref: string, deadline = 15_000): RuntimeProfile => ({
  ref,
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: {
    ...DEFAULT_RUNTIME_BUDGET_POLICY,
    maxProviderCalls: 1,
    maxAttempts: 1,
    maxInputContextBytes: 64_000,
    totalDeadlineMs: deadline,
  },
});

// A learner's own Professor content release (migration 021).
async function professorRelease(person: Person) {
  m.person = person;
  return asLearner<{
    ok: true;
    release_id: string;
    student_id: string;
    invocation_id: string;
  }>(
    m.database,
    person,
    "select public.begin_academic_content_release($1,'get_lesson_context','PROFESSOR_READ_V2') v",
    [randomUUID()],
  );
}
// An AUTHORIZED and STARTED Professor execution.
async function runningProfessorExecution(person: Person) {
  const release = await professorRelease(person);
  const executionId = randomUUID();
  m.person = person;
  await attestProviderExecutionCommand(executionId, release, {
    operation: "AUTHORIZE",
    budget,
  });
  await attestProviderExecutionCommand(executionId, release, {
    operation: "START",
  });
  return { executionId, release };
}
// A raw, correctly signed late-usage command for negative cases.
function lateUsageMac(
  kind: string,
  actor: string,
  executionId: string,
  releaseId: string,
  u: typeof usage,
) {
  const iat = Math.floor(Date.now() / 1000);
  const canonical = [
    "DUCELIO_LATE_PROVIDER_USAGE_HMAC_SHA256_V1",
    kind,
    keyId,
    actor,
    executionId,
    releaseId,
    u.providerCalls,
    u.attempts,
    u.inputTokens,
    u.outputTokens,
    u.estimatedCostMicrousd,
    u.elapsedMs,
    iat,
    iat + 10,
  ].join("\n");
  return {
    iat,
    mac: createHmac("sha256", key).update(canonical).digest("hex"),
  };
}
const rawLate = (
  database: string,
  person: Person,
  kind: string,
  executionId: string,
  releaseId: string,
  u: typeof usage,
  signer: Person = person,
) => {
  const { iat, mac } = lateUsageMac(kind, signer.id, executionId, releaseId, u);
  return asLearner<{ ok: boolean; code?: string }>(
    database,
    person,
    `select public.record_late_provider_execution_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) v`,
    [
      kind,
      keyId,
      executionId,
      releaseId,
      u.providerCalls,
      u.attempts,
      u.inputTokens,
      u.outputTokens,
      u.estimatedCostMicrousd,
      u.elapsedMs,
      iat,
      iat + 10,
      mac,
    ],
  );
};

describe.skipIf(!ADMIN_URL)(
  "Shared AI execution reliability under true PostgreSQL",
  () => {
    beforeAll(async () => {
      const admin = await connect("postgres");
      await admin.query(`create database ${TEMPLATE}`);
      await admin.end();
      created.push(TEMPLATE);
      const client = await connect(TEMPLATE);
      try {
        for (const sql of await testDatabaseStatements({
          supabaseDefaultPrivileges: true,
        }))
          await client.query(sql);
        const q: Query = (sql, params) =>
          client.query(sql, params as unknown[]);
        await seedPeople(q);
        await q(
          "select academic_execution_private.install_controller_key($1,$2::bytea)",
          [keyId, key],
        );
        const course = await publishAcademyCourse(
          q,
          "reliability-pg-test",
          approvedTestPackage("reliability-pg-test"),
        );
        for (const p of [learnerA, learnerB]) {
          enrolments[p.id] = await rpc<string>(
            q,
            people.admin,
            "grant_academy_entitlement",
            [course.offerId, p.email, null, "Reliability acceptance access"],
          );
          const start = new Date(Date.now() + 2 * 86400000)
            .toISOString()
            .slice(0, 10);
          const confirmed = await rpc<{ ok: boolean }>(
            q,
            p,
            "confirm_my_academy_schedule",
            [
              enrolments[p.id],
              "STANDARD_6W",
              start,
              [1, 3, 5, 6],
              "19:00",
              "Europe/London",
              randomUUID(),
            ],
          );
          if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
        }
        const first = (
          await q(
            `select i.id, i.ref, (select o.id from public.lesson_objectives o
               join public.academy_course_lessons cl on cl.lesson_id = o.lesson_id
               where cl.course_id = $2 and cl.lesson_ref = i.ref order by o.position limit 1) objective
             from public.academy_schedule_items i
             where i.enrolment_id = $1 and i.kind = 'LESSON' and i.part = 1 order by i.sequence limit 1`,
            [enrolments[learnerA.id], course.courseId],
          )
        ).rows[0] as { id: string; ref: string; objective: string };
        lessonItem = first.id;
        lessonRef = first.ref;
        objectiveId = first.objective;
        for (const p of [learnerA, learnerB])
          await releaseNow(q, enrolments[p.id], "LESSON", lessonRef);
      } finally {
        await client.end();
      }
    }, 600000);
    afterAll(async () => {
      const admin = await connect("postgres");
      for (const name of created.reverse())
        await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    });

    it("records the real usage of a Professor reply that completes after expiry, without reviving it", async () => {
      const db = await scenario();
      m.person = learnerA;
      const opened = await asLearner<{ classroomId: string }>(
        db,
        learnerA,
        "select public.open_my_academy_professor_classroom($1,$2) v",
        [enrolments[learnerA.id], lessonItem],
      );
      const adapter: ProviderAdapter = {
        name: "late-stub",
        async generate() {
          // While the provider is "answering", the execution's 20 seconds
          // run out.
          const [running] = await rows(
            db,
            "select id from public.academic_provider_executions where state = 'RUNNING'",
          );
          await age(db, "academic_provider_executions", running.id);
          return {
            outputText: "A reply that arrives too late.",
            usage: {
              inputTokens: 210,
              outputTokens: 55,
              estimatedCostMicrousd: 130,
            },
          };
        },
      };
      const result = await executeAcademyProfessorClassroomWithTestOverrides(
        {
          classroomId: opened.classroomId,
          interaction: { kind: "BEGIN_LESSON" },
        },
        {
          resolveProfile: (ref) => profile(ref ?? "PROFESSOR_COMMERCIAL_V1"),
          resolveAdapter: () => adapter,
        },
      );
      // The late output never becomes a success, and the real usage is
      // still returned to the caller.
      expect(result).toMatchObject({
        outcome: "ABSTAINED",
        usage: { providerCalls: 1, outputTokens: 55 },
      });
      expect(
        await rows(
          db,
          `select x.state, x.reason_code, u.provider_calls, u.input_tokens, u.output_tokens, u.estimated_cost_microusd::int estimated_cost_microusd,
             (select count(*)::int from public.provider_execution_late_usage l where l.professor_execution_id = x.id) late,
             (select count(*)::int from public.audit_events a where a.target_id = x.id
               and a.action = 'PROVIDER_EXECUTION_LATE_USAGE_RECORDED') audited
           from public.academic_provider_executions x
           join public.academic_provider_execution_usage u on u.execution_id = x.id`,
        ),
      ).toEqual([
        {
          state: "TIMEOUT",
          reason_code: "EXECUTION_TIMEOUT",
          provider_calls: 1,
          input_tokens: 210,
          output_tokens: 55,
          estimated_cost_microusd: 130,
          late: 1,
          audited: 1,
        },
      ]);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_professor_classroom_turns",
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("records the real usage of a Tutor reply that completes after expiry, without reviving it", async () => {
      const db = await scenario();
      m.person = learnerA;
      const request = await asLearner<{ requestId: string }>(
        db,
        learnerA,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolments[learnerA.id], lessonRef, objectiveId],
      );
      const adapter: ProviderAdapter = {
        name: "late-tutor-stub",
        async generate() {
          const [running] = await rows(
            db,
            "select id from public.tutor_lab_provider_executions where state = 'RUNNING'",
          );
          await age(db, "tutor_lab_provider_executions", running.id);
          return {
            outputText: "A Tutor reply that arrives too late.",
            usage: {
              inputTokens: 80,
              outputTokens: 30,
              estimatedCostMicrousd: 60,
            },
          };
        },
      };
      expect(
        await executeAcademySupportWithTestOverrides(
          {
            requestId: request.requestId,
            message: "Explain this objective.",
            idempotencyKey: randomUUID(),
          },
          {
            resolveProfile: (ref) => profile(ref),
            resolveAdapter: () => adapter,
          },
        ),
      ).toEqual({ status: "RETRY_LATER" });
      expect(
        await rows(
          db,
          `select x.state, u.provider_calls, u.output_tokens,
             (select count(*)::int from public.provider_execution_late_usage l where l.tutor_lab_execution_id = x.id) late
           from public.tutor_lab_provider_executions x
           join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id`,
        ),
      ).toEqual([
        { state: "TIMEOUT", provider_calls: 1, output_tokens: 30, late: 1 },
      ]);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_support_turns",
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("records the usage of a provider call cut off by the runtime deadline after expiry (wall clock)", async () => {
      const db = await scenario();
      m.person = learnerA;
      const opened = await asLearner<{ classroomId: string }>(
        db,
        learnerA,
        "select public.open_my_academy_professor_classroom($1,$2) v",
        [enrolments[learnerA.id], lessonItem],
      );
      const hang: ProviderAdapter = {
        name: "hang-stub",
        generate: (_request, signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      };
      const result = await executeAcademyProfessorClassroomWithTestOverrides(
        {
          classroomId: opened.classroomId,
          interaction: { kind: "BEGIN_LESSON" },
        },
        {
          // The maximum reviewed runtime deadline equals the execution
          // envelope, so the FINALIZE reporting the cut-off call always
          // arrives after the execution expired.
          resolveProfile: (ref) =>
            profile(ref ?? "PROFESSOR_COMMERCIAL_V1", 20_000),
          resolveAdapter: () => hang,
        },
      );
      expect(result.outcome).toBe("ABSTAINED");
      const [execution] = await rows(
        db,
        `select x.state, u.provider_calls, u.attempts, u.elapsed_ms
         from public.academic_provider_executions x
         join public.academic_provider_execution_usage u on u.execution_id = x.id`,
      );
      expect(execution).toMatchObject({
        state: "TIMEOUT",
        provider_calls: 1,
        attempts: 1,
      });
      expect(execution.elapsed_ms).toBeGreaterThanOrEqual(19_000);
    }, 60000);

    it("accepts exactly one late usage report, even under true concurrency", async () => {
      const db = await scenario();
      const { executionId, release } =
        await runningProfessorExecution(learnerA);
      await age(db, "academic_provider_executions", executionId);
      // The governance's own sweep marks it TIMEOUT on the next command.
      await rows(
        db,
        `update public.academic_provider_executions set state = 'TIMEOUT', reason_code = 'EXECUTION_TIMEOUT',
           terminal_at = expires_at where id = $1`,
        [executionId],
      );
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "select 1 from public.student_profiles where user_id = $1 for update",
        [learnerA.id],
      );
      m.person = learnerA;
      const pending = Array.from({ length: 6 }, () =>
        recordLateProviderUsage(
          "PROFESSOR",
          executionId,
          release.release_id,
          usage,
        ),
      );
      await waitForBlocked(db, 6);
      await holder.query("commit");
      await holder.end();
      const outcomes = await Promise.all(pending);
      expect(outcomes.filter((o) => o === "RECORDED")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "ALREADY_RECORDED")).toHaveLength(5);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academic_provider_execution_usage where execution_id = $1",
          [executionId],
        ),
      ).toEqual([{ n: 1 }]);
      // A later FINALIZE (a retry, or a replay) is still refused and never
      // revives the execution or adds usage.
      await expect(
        attestProviderExecutionCommand(executionId, release, {
          operation: "FINALIZE",
          state: "SUCCEEDED",
          reason: "PROVIDER_COMPLETE",
          budgetStage: null,
          usage,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
      expect(
        await rows(
          db,
          `select x.state, (select count(*)::int from public.academic_provider_execution_usage u where u.execution_id = x.id) n
           from public.academic_provider_executions x where x.id = $1`,
          [executionId],
        ),
      ).toEqual([{ state: "TIMEOUT", n: 1 }]);
    });

    it("refuses late usage for another learner, a forged or stale report, a wrong kind and an unstarted or finalized execution", async () => {
      const db = await scenario();
      const { executionId, release } =
        await runningProfessorExecution(learnerA);
      await age(db, "academic_provider_executions", executionId);
      await rows(
        db,
        `update public.academic_provider_executions set state = 'TIMEOUT', reason_code = 'EXECUTION_TIMEOUT',
           terminal_at = expires_at where id = $1`,
        [executionId],
      );
      // Another learner, even with a correctly signed report naming them.
      expect(
        await rawLate(
          db,
          learnerB,
          "PROFESSOR",
          executionId,
          release.release_id,
          usage,
        ),
      ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
      // A report signed for one learner and submitted by another.
      expect(
        await rawLate(
          db,
          learnerB,
          "PROFESSOR",
          executionId,
          release.release_id,
          usage,
          learnerA,
        ),
      ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
      // The wrong governance kind, and more calls than were admitted.
      expect(
        await rawLate(
          db,
          learnerA,
          "TUTOR",
          executionId,
          release.release_id,
          usage,
        ),
      ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
      expect(
        await rawLate(
          db,
          learnerA,
          "PROFESSOR",
          executionId,
          release.release_id,
          {
            ...usage,
            providerCalls: 2,
            attempts: 2,
          },
        ),
      ).toEqual({ ok: false, code: "INVALID_INPUT" });
      // Outside the five-minute window after expiry.
      const owner = await connect(db);
      await owner.query("begin");
      await owner.query(
        "alter table public.academic_provider_executions disable trigger guard_provider_execution_history",
      );
      await owner.query(
        `update public.academic_provider_executions set created_at = created_at - interval '10 minutes',
           authorized_at = authorized_at - interval '10 minutes', started_at = started_at - interval '10 minutes',
           expires_at = expires_at - interval '10 minutes', terminal_at = terminal_at - interval '10 minutes'
         where id = $1`,
        [executionId],
      );
      await owner.query(
        "alter table public.academic_provider_executions enable trigger guard_provider_execution_history",
      );
      await owner.query("commit");
      await owner.end();
      expect(
        await rawLate(
          db,
          learnerA,
          "PROFESSOR",
          executionId,
          release.release_id,
          usage,
        ),
      ).toEqual({ ok: false, code: "LATE_USAGE_WINDOW_CLOSED" });

      // An execution that timed out before it ever STARTED had no provider
      // call, so there is nothing late to record.
      const unstartedRelease = await professorRelease(learnerA);
      const unstarted = randomUUID();
      m.person = learnerA;
      await attestProviderExecutionCommand(unstarted, unstartedRelease, {
        operation: "AUTHORIZE",
        budget,
      });
      await age(db, "academic_provider_executions", unstarted);
      await rows(
        db,
        `update public.academic_provider_executions set state = 'TIMEOUT', reason_code = 'EXECUTION_TIMEOUT',
           terminal_at = expires_at where id = $1`,
        [unstarted],
      );
      expect(
        await rawLate(
          db,
          learnerA,
          "PROFESSOR",
          unstarted,
          unstartedRelease.release_id,
          usage,
        ),
      ).toEqual({ ok: false, code: "INVALID_STATE" });

      // A finalized execution already has its usage.
      const finalized = await runningProfessorExecution(learnerA);
      await attestProviderExecutionCommand(
        finalized.executionId,
        finalized.release,
        {
          operation: "FINALIZE",
          state: "FAILED",
          reason: "PROVIDER_REFUSED",
          budgetStage: null,
          usage,
        },
      );
      expect(
        await rawLate(
          db,
          learnerA,
          "PROFESSOR",
          finalized.executionId,
          finalized.release.release_id,
          usage,
        ),
      ).toEqual({ ok: false, code: "ALREADY_RECORDED" });
      // Nothing above wrote usage for a refused report; the table is
      // unreadable to the learner.
      expect(
        await rows(
          db,
          "select count(*)::int n from public.provider_execution_late_usage",
        ),
      ).toEqual([{ n: 0 }]);
      await expect(
        asLearner(
          db,
          learnerA,
          "select count(*) v from public.provider_execution_late_usage",
          [],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("abandons an AUTHORIZED execution that cannot START, at once and only once", async () => {
      const db = await scenario();
      const release = await professorRelease(learnerA);
      const executionId = randomUUID();
      m.person = learnerA;
      await attestProviderExecutionCommand(executionId, release, {
        operation: "AUTHORIZE",
        budget,
      });
      // Another learner cannot close it.
      m.person = learnerB;
      expect(
        await abandonUnstartedProviderExecution(
          "PROFESSOR",
          executionId,
          release.release_id,
          "INTERNAL_ERROR",
        ),
      ).toBe("UNAVAILABLE");
      m.person = learnerA;
      expect(
        await abandonUnstartedProviderExecution(
          "PROFESSOR",
          executionId,
          release.release_id,
          "POLICY_BLOCKED",
        ),
      ).toBe("ABANDONED");
      expect(
        await abandonUnstartedProviderExecution(
          "PROFESSOR",
          executionId,
          release.release_id,
          "POLICY_BLOCKED",
        ),
      ).toBe("ALREADY_TERMINAL");
      expect(
        await rows(
          db,
          `select state, reason_code, (select count(*)::int from public.academic_provider_execution_usage u
             where u.execution_id = x.id) usage from public.academic_provider_executions x where id = $1`,
          [executionId],
        ),
      ).toEqual([{ state: "FAILED", reason_code: "POLICY_BLOCKED", usage: 0 }]);
      // START is now refused, and the learner's next execution is admitted
      // immediately rather than RATE_LIMITED by a dangling active one.
      await expect(
        attestProviderExecutionCommand(executionId, release, {
          operation: "START",
        }),
      ).rejects.toMatchObject({ code: "REPLAY_REJECTED" });
      const next = await professorRelease(learnerA);
      const snapshot = await attestProviderExecutionCommand(
        randomUUID(),
        next,
        {
          operation: "AUTHORIZE",
          budget,
        },
      );
      expect(snapshot.state).toBe("AUTHORIZED");
      // A RUNNING execution can never be abandoned: only FINALIZE closes it.
      const running = await runningProfessorExecution(learnerB);
      m.person = learnerB;
      expect(
        await abandonUnstartedProviderExecution(
          "PROFESSOR",
          running.executionId,
          running.release.release_id,
          "INTERNAL_ERROR",
        ),
      ).toBe("RUNNING");
    });

    it("lets exactly one of a racing START and abandonment win", async () => {
      const db = await scenario();
      const release = await professorRelease(learnerA);
      const executionId = randomUUID();
      m.person = learnerA;
      await attestProviderExecutionCommand(executionId, release, {
        operation: "AUTHORIZE",
        budget,
      });
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "select 1 from public.student_profiles where user_id = $1 for update",
        [learnerA.id],
      );
      const start = attestProviderExecutionCommand(executionId, release, {
        operation: "START",
      }).then(
        () => "STARTED",
        () => "START_REFUSED",
      );
      const abandon = abandonUnstartedProviderExecution(
        "PROFESSOR",
        executionId,
        release.release_id,
        "INTERNAL_ERROR",
      );
      await waitForBlocked(db, 2);
      await holder.query("commit");
      await holder.end();
      const [started, abandoned] = await Promise.all([start, abandon]);
      const [{ state }] = await rows(
        db,
        "select state from public.academic_provider_executions where id = $1",
        [executionId],
      );
      if (started === "STARTED") {
        expect(abandoned).toBe("RUNNING");
        expect(state).toBe("RUNNING");
      } else {
        expect(abandoned).toBe("ABANDONED");
        expect(state).toBe("FAILED");
      }
    });

    it("abandons and late-records Tutor/Lab executions under the same rules", async () => {
      const db = await scenario();
      m.person = learnerA;
      const request = await asLearner<{ requestId: string }>(
        db,
        learnerA,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolments[learnerA.id], lessonRef, objectiveId],
      );
      const grant = async () => {
        const g = await asLearner<{
          release_id: string;
          student_id: string;
          invocation_id: string;
          enrolment_id: string;
          lesson_id: string;
          objective_id: string | null;
        }>(
          db,
          learnerA,
          "select public.begin_my_academy_support_release($1,$2) v",
          [randomUUID(), request.requestId],
        );
        return {
          releaseId: g.release_id,
          studentId: g.student_id,
          invocationId: g.invocation_id,
          role: "TUTOR" as const,
          reasonCode: "OBJECTIVE_REINFORCEMENT" as const,
          enrolmentId: g.enrolment_id,
          lessonId: g.lesson_id,
          objectiveId: g.objective_id,
          practicalId: null,
        };
      };
      const tlBudget = {
        maxProviderCalls: 1,
        maxOutputTokens: 500,
        maxEstimatedCostMicrousd: 10_000,
      } as const;
      // Abandon an unstarted Tutor execution; the next is admitted at once.
      const first = await grant();
      const firstId = randomUUID();
      await attestTutorLabExecutionCommand("TUTOR", firstId, first, {
        operation: "AUTHORIZE",
        budget: tlBudget,
      });
      expect(
        await abandonUnstartedProviderExecution(
          "LAB_INSTRUCTOR",
          firstId,
          first.releaseId,
          "INTERNAL_ERROR",
        ),
      ).toBe("UNAVAILABLE");
      expect(
        await abandonUnstartedProviderExecution(
          "TUTOR",
          firstId,
          first.releaseId,
          "INTERNAL_ERROR",
        ),
      ).toBe("ABANDONED");
      // A started one that expires: the late FINALIZE records its usage once.
      const second = await grant();
      const secondId = randomUUID();
      await attestTutorLabExecutionCommand("TUTOR", secondId, second, {
        operation: "AUTHORIZE",
        budget: tlBudget,
      });
      await attestTutorLabExecutionCommand("TUTOR", secondId, second, {
        operation: "START",
      });
      await age(db, "tutor_lab_provider_executions", secondId);
      await expect(
        attestTutorLabExecutionCommand("TUTOR", secondId, second, {
          operation: "FINALIZE",
          state: "SUCCEEDED",
          reason: "PROVIDER_COMPLETE",
          budgetStage: null,
          usage,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
      expect(
        await recordLateProviderUsage(
          "TUTOR",
          secondId,
          second.releaseId,
          usage,
        ),
      ).toBe("ALREADY_RECORDED");
      expect(
        await rows(
          db,
          `select x.id = $1 id_matches, x.state, x.reason_code, u.provider_calls, u.output_tokens
           from public.tutor_lab_provider_executions x
           join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id`,
          [secondId],
        ),
      ).toEqual([
        {
          id_matches: true,
          state: "TIMEOUT",
          reason_code: "EXECUTION_TIMEOUT",
          provider_calls: 1,
          output_tokens: 40,
        },
      ]);
      expect(
        await rows(
          db,
          `select state from public.tutor_lab_provider_executions where id = $1`,
          [firstId],
        ),
      ).toEqual([{ state: "FAILED" }]);
    });
  },
);
