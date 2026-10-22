import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  type Query,
} from "./academy-fixture";

// Migration 062 under TRUE concurrency on a real, DISPOSABLE PostgreSQL
// server (DUCELIO_TEST_POSTGRES_URL; see tests/academy-pg-concurrency.test.ts).
// Every scenario runs in its own clone of one template. The last scenario
// drives two overlapping Professor requests through the REAL Academy
// runtime against real PostgreSQL, with a deterministic stub provider.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const runId = randomUUID().slice(0, 8);
const TEMPLATE = `ducelio_acad_ai_${runId}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = key.toString("hex");
const learner = people.learnerA;
let enrolment = "";
let lessonItem = "";

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
  const name = `ducelio_acad_ai_s${created.length}_${runId}`;
  const admin = await connect("postgres");
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();
  created.push(name);
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
async function asLearner<T>(database: string, sql: string, args: unknown[]) {
  const client = await connect(database);
  try {
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
      learner.auth,
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
// Hold a row lock, start every racer, prove they all queue on it, release.
async function race<T>(
  database: string,
  lockSql: string,
  lockArgs: unknown[],
  racers: (() => Promise<T>)[],
) {
  const holder = await connect(database);
  await holder.query("begin");
  await holder.query(lockSql, lockArgs);
  const pending = racers.map((r) => r());
  await waitForBlocked(database, racers.length);
  await holder.query("commit");
  await holder.end();
  return Promise.all(pending);
}

// The real runtime's PostgREST transport, over a fresh real connection per
// call, as the signed-in learner.
const m = vi.hoisted(() => ({ database: "" }));
vi.mock("@/server/identity", () => {
  const a = {
    id: "10000000-0000-4000-8000-000000000601",
    roles: ["STUDENT"],
    displayName: "Academy learner",
  };
  return {
    getAuthenticatedActor: async () => a,
    getCurrentActor: async () => a,
    requireStudentPrincipal: async () => a,
    requireActor: async () => a,
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
          [learner.auth],
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

import { executeAcademyProfessorClassroomWithTestOverrides } from "@/server/academic-runtime/academy-professor";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type ProviderAdapter,
} from "@/domain/academic-runtime";

const holdLearner =
  "select 1 from public.student_profiles where user_id=$1 for update";

describe.skipIf(!ADMIN_URL)(
  "Academy AI classes under true PostgreSQL concurrency",
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
          "academy-ai-pg-test",
          approvedTestPackage("academy-ai-pg-test"),
        );
        enrolment = await rpc<string>(
          q,
          people.admin,
          "grant_academy_entitlement",
          [
            course.offerId,
            learner.email,
            null,
            "Concurrency acceptance access",
          ],
        );
        const start = new Date(Date.now() + 2 * 86400000)
          .toISOString()
          .slice(0, 10);
        const confirmed = await rpc<{ ok: boolean }>(
          q,
          learner,
          "confirm_my_academy_schedule",
          [
            enrolment,
            "STANDARD_6W",
            start,
            [1, 3, 5, 6],
            "19:00",
            "Europe/London",
            randomUUID(),
          ],
        );
        if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
        const first = (
          await q(
            `select i.id, i.ref from public.academy_schedule_items i
             where i.enrolment_id = $1 and i.kind = 'LESSON' and i.part = 1 order by i.sequence limit 1`,
            [enrolment],
          )
        ).rows[0] as { id: string; ref: string };
        lessonItem = first.id;
        await releaseNow(q, enrolment, "LESSON", first.ref);
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

    it("parallel entries into one scheduled class create exactly one classroom", async () => {
      const db = await scenario();
      const results = await race(
        db,
        holdLearner,
        [learner.id],
        Array.from(
          { length: 6 },
          () => () =>
            asLearner<{ ok: boolean; classroomId: string; resumed: boolean }>(
              db,
              "select public.open_my_academy_professor_classroom($1,$2) v",
              [enrolment, lessonItem],
            ),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => r.classroomId)).size).toBe(1);
      expect(results.filter((r) => !r.resumed)).toHaveLength(1);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_professor_classrooms",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("parallel submissions of one learner action reserve it exactly once", async () => {
      const db = await scenario();
      const opened = await asLearner<{ classroomId: string }>(
        db,
        "select public.open_my_academy_professor_classroom($1,$2) v",
        [enrolment, lessonItem],
      );
      // Concurrent identical submissions, plus one submission that must
      // wait on another session's uncommitted reservation of its key.
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "insert into public.academy_professor_interaction_reservations(classroom_id, idempotency_key) values ($1,'held')",
        [opened.classroomId],
      );
      const pending = Array.from({ length: 5 }, () =>
        asLearner<{ ok: boolean; duplicate: boolean }>(
          db,
          "select public.reserve_my_academy_professor_interaction($1,'same-action') v",
          [opened.classroomId],
        ),
      );
      const racedOnHeld = asLearner<{ ok: boolean; duplicate: boolean }>(
        db,
        "select public.reserve_my_academy_professor_interaction($1,'held') v",
        [opened.classroomId],
      );
      await waitForBlocked(db, 1);
      await holder.query("rollback");
      await holder.end();
      const same = await Promise.all(pending);
      expect(same.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
      expect(same.filter((r) => r.ok && r.duplicate)).toHaveLength(4);
      expect(await racedOnHeld).toEqual({ ok: true, duplicate: false });
    });

    it("overlapping Professor requests in one class cannot run two governed executions", async () => {
      const db = await scenario();
      m.database = db;
      const opened = await asLearner<{ classroomId: string }>(
        db,
        "select public.open_my_academy_professor_classroom($1,$2) v",
        [enrolment, lessonItem],
      );
      let calls = 0;
      const adapter: ProviderAdapter = {
        name: "academy-pg-stub",
        async generate() {
          calls += 1;
          // Long enough that the other request reaches AUTHORIZE while this
          // execution is still RUNNING.
          await new Promise((r) => setTimeout(r, 2500));
          return {
            outputText: "Let us begin this lesson.",
            usage: {
              inputTokens: 50,
              outputTokens: 20,
              estimatedCostMicrousd: 40,
            },
          };
        },
      };
      const execute = (delay: number) =>
        new Promise((r) => setTimeout(r, delay)).then(() =>
          executeAcademyProfessorClassroomWithTestOverrides(
            {
              classroomId: opened.classroomId,
              interaction: { kind: "BEGIN_LESSON" },
            },
            {
              resolveProfile: (ref) =>
                ref === "PROFESSOR_COMMERCIAL_V1"
                  ? {
                      ref,
                      adapterKind: "TEST_DETERMINISTIC",
                      budgetPolicy: {
                        ...DEFAULT_RUNTIME_BUDGET_POLICY,
                        maxInputContextBytes: 64_000,
                      },
                    }
                  : null,
              resolveAdapter: () => adapter,
            },
          ),
        );
      const results = await Promise.all([execute(0), execute(800)]);
      expect(results.map((r) => r.outcome).sort()).toEqual([
        "ABSTAINED",
        "SUCCEEDED",
      ]);
      expect(calls).toBe(1);
      const executions = await rows(
        db,
        "select state, reason_code from public.academic_provider_executions order by created_at",
      );
      expect(executions).toEqual([
        { state: "SUCCEEDED", reason_code: "PROVIDER_COMPLETE" },
        { state: "BLOCKED", reason_code: "RATE_LIMITED" },
      ]);
      expect(
        await rows(
          db,
          "select turn_number from public.academy_professor_classroom_turns",
        ),
      ).toEqual([{ turn_number: 1 }]);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academic_content_releases where state = 'ACTIVE'",
        ),
      ).toEqual([{ n: 0 }]);
    }, 60000);

    it("a Professor reply record and a concurrent reservation cannot deadlock (migration 065)", async () => {
      const db = await scenario();
      m.database = db;
      const opened = await asLearner<{ classroomId: string }>(
        db,
        "select public.open_my_academy_professor_classroom($1,$2) v",
        [enrolment, lessonItem],
      );
      // A SUCCEEDED, provenance-bound execution whose reply was too long to
      // record, so the writer below has something to record.
      const result = await executeAcademyProfessorClassroomWithTestOverrides(
        {
          classroomId: opened.classroomId,
          interaction: { kind: "BEGIN_LESSON" },
        },
        {
          resolveProfile: (ref) =>
            ref === "PROFESSOR_COMMERCIAL_V1"
              ? {
                  ref,
                  adapterKind: "TEST_DETERMINISTIC",
                  budgetPolicy: {
                    ...DEFAULT_RUNTIME_BUDGET_POLICY,
                    maxInputContextBytes: 64_000,
                  },
                }
              : null,
          resolveAdapter: () => ({
            name: "long-reply-stub",
            generate: async () => ({
              outputText: "x".repeat(12_001),
              usage: {
                inputTokens: 10,
                outputTokens: 10,
                estimatedCostMicrousd: 10,
              },
            }),
          }),
        },
      );
      expect(result).toMatchObject({
        outcome: "SUCCEEDED",
        classroomMemory: "NOT_RECORDED",
      });
      const [x] = await rows(
        db,
        "select id from public.academic_provider_executions where state = 'SUCCEEDED'",
      );
      const iat = Math.floor(Date.now() / 1000);
      const reply = "A short recorded reply.";
      const sha = (t: string) =>
        createHash("sha256").update(t, "utf8").digest("hex");
      const canonical = [
        "DUCELIO_ACADEMY_CLASSROOM_TURN_HMAC_SHA256_V1",
        "PROFESSOR",
        keyId,
        learner.id,
        x.id,
        opened.classroomId,
        "BEGIN_LESSON",
        sha(""),
        sha(reply),
        iat,
        iat + 10,
      ].join("\n");
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "select 1 from public.student_profiles where user_id = $1 for update",
        [learner.id],
      );
      const turn = asLearner<{ ok: boolean; duplicate?: boolean }>(
        db,
        "select public.record_my_academy_professor_turn($1,$2,$3,$4,$5,$6,$7,$8,$9) v",
        [
          keyId,
          x.id,
          opened.classroomId,
          "BEGIN_LESSON",
          null,
          reply,
          iat,
          iat + 10,
          createHmac("sha256", key).update(canonical).digest("hex"),
        ],
      ).then(
        (v) => v,
        (e: Error) => ({ ok: false as const, error: e.message }),
      );
      await waitForBlocked(db, 1);
      // An insert holding a foreign-key share lock on the classroom while the
      // learner-profile lock is held.
      await holder.query(
        "insert into public.academy_professor_interaction_reservations(classroom_id, idempotency_key) values ($1, 'held')",
        [opened.classroomId],
      );
      await holder.query("commit");
      await holder.end();
      expect(await turn).toEqual({ ok: true, duplicate: false });
    }, 60000);
  },
);
