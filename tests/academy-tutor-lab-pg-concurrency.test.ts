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

// Migration 063 under TRUE concurrency on a real, DISPOSABLE PostgreSQL
// server (DUCELIO_TEST_POSTGRES_URL; see tests/academy-pg-concurrency.test.ts).
// Every scenario runs in its own clone of one template. The last scenario
// drives overlapping Tutor and Lab Instructor requests for the same learner
// through the REAL Academy runtime against real PostgreSQL, with a
// deterministic stub provider.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const runId = randomUUID().slice(0, 8);
const TEMPLATE = `ducelio_acad_tl_${runId}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = key.toString("hex");
const learner = people.learnerA;
let enrolment = "";
let lessonRef = "";
let objectiveId = "";
let labItem = "";

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
  const name = `ducelio_acad_tl_s${created.length}_${runId}`;
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

import { executeAcademySupportWithTestOverrides } from "@/server/tutor-lab-execution/academy";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type ProviderAdapter,
} from "@/domain/academic-runtime";

const holdLearner =
  "select 1 from public.student_profiles where user_id=$1 for update";

describe.skipIf(!ADMIN_URL)(
  "Academy Tutor and Lab Instructor under true PostgreSQL concurrency",
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
        const pkg = approvedTestPackage("academy-tl-pg-test");
        const course = await publishAcademyCourse(q, "academy-tl-pg-test", pkg);
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
            `select cl.lesson_ref, (select o.id from public.lesson_objectives o where o.lesson_id = cl.lesson_id
               order by o.position limit 1) objective
             from public.academy_course_lessons cl where cl.course_id = $1 order by cl.sequence limit 1`,
            [course.courseId],
          )
        ).rows[0] as { lesson_ref: string; objective: string };
        lessonRef = first.lesson_ref;
        objectiveId = first.objective;
        const lab = (
          await q(
            `select i.id, i.ref from public.academy_schedule_items i
             where i.enrolment_id = $1 and i.kind = 'LAB' and i.part = 1 order by i.sequence limit 1`,
            [enrolment],
          )
        ).rows[0] as { id: string; ref: string };
        labItem = lab.id;
        const labLesson = (
          pkg.curriculum.modules.flatMap(
            (mm: { lessons: unknown[] }) => mm.lessons,
          ) as { key: string; practicalActivities?: { key: string }[] }[]
        ).find((l) =>
          l.practicalActivities?.some((a) => a.key === lab.ref),
        )!.key;
        await releaseNow(q, enrolment, "LESSON", lessonRef);
        await releaseNow(q, enrolment, "LESSON", labLesson);
        await releaseNow(q, enrolment, "LAB");
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

    it("parallel requests for one objective create exactly one Tutor thread", async () => {
      const db = await scenario();
      const results = await race(
        db,
        holdLearner,
        [learner.id],
        Array.from(
          { length: 6 },
          () => () =>
            asLearner<{ ok: boolean; requestId: string; resumed: boolean }>(
              db,
              "select public.open_my_academy_tutor_support($1,$2,$3) v",
              [enrolment, lessonRef, objectiveId],
            ),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => r.requestId)).size).toBe(1);
      expect(results.filter((r) => !r.resumed)).toHaveLength(1);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_support_requests",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("parallel identical submissions reserve exactly once", async () => {
      const db = await scenario();
      const opened = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolment, lessonRef, objectiveId],
      );
      const key = randomUUID();
      const hash = "a".repeat(64);
      // An uncommitted reservation of the same key holds its primary key;
      // every racer queues on it, and once it rolls back exactly one racer
      // reserves while the rest see that reservation as a duplicate.
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "insert into public.academy_support_reservations(learner_id, idempotency_key, request_id, request_hash) values ($1,$2,$3,$4)",
        [learner.id, key, opened.requestId, hash],
      );
      const pending = Array.from({ length: 5 }, () =>
        asLearner<{ ok: boolean; duplicate: boolean }>(
          db,
          "select public.reserve_my_academy_support_interaction($1,$2,$3) v",
          [opened.requestId, key, hash],
        ),
      );
      await waitForBlocked(db, 5);
      await holder.query("rollback");
      await holder.end();
      const results = await Promise.all(pending);
      expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
      expect(results.filter((r) => r.ok && r.duplicate)).toHaveLength(4);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_support_reservations",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("overlapping Tutor and Lab requests for one learner run exactly one governed execution", async () => {
      const db = await scenario();
      m.database = db;
      const tutor = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolment, lessonRef, objectiveId],
      );
      const lab = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_lab_support($1,$2) v",
        [enrolment, labItem],
      );
      let calls = 0;
      const adapter: ProviderAdapter = {
        name: "academy-tl-pg-stub",
        async generate() {
          calls += 1;
          // Long enough that the other request reaches AUTHORIZE while this
          // execution is still RUNNING.
          await new Promise((r) => setTimeout(r, 2500));
          return {
            outputText: "Here is a way to approach it.",
            usage: {
              inputTokens: 40,
              outputTokens: 15,
              estimatedCostMicrousd: 30,
            },
          };
        },
      };
      const execute = (requestId: string, delay: number) =>
        new Promise((r) => setTimeout(r, delay)).then(() =>
          executeAcademySupportWithTestOverrides(
            {
              requestId,
              message: "How should I start?",
              idempotencyKey: randomUUID(),
            },
            {
              resolveProfile: (ref) => ({
                ref,
                adapterKind: "TEST_DETERMINISTIC",
                budgetPolicy: {
                  ...DEFAULT_RUNTIME_BUDGET_POLICY,
                  maxProviderCalls: 1,
                  maxAttempts: 1,
                  maxInputContextBytes: 64_000,
                },
              }),
              resolveAdapter: () => adapter,
            },
          ),
        );
      const results = await Promise.all([
        execute(tutor.requestId, 0),
        execute(lab.requestId, 800),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "SUCCEEDED",
        "UNAVAILABLE",
      ]);
      expect(calls).toBe(1);
      expect(
        await rows(
          db,
          "select agent_profile, state, reason_code from public.tutor_lab_provider_executions order by created_at",
        ),
      ).toEqual([
        {
          agent_profile: "TUTOR",
          state: "SUCCEEDED",
          reason_code: "PROVIDER_COMPLETE",
        },
        {
          agent_profile: "LAB_INSTRUCTOR",
          state: "BLOCKED",
          reason_code: "RATE_LIMITED",
        },
      ]);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_support_turns",
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        await rows(
          db,
          "select count(*)::int n from public.tutor_lab_content_releases where state = 'ACTIVE'",
        ),
      ).toEqual([{ n: 0 }]);
    }, 60000);

    // A SUCCEEDED, provenance-bound Tutor execution whose reply was not
    // recorded (it exceeded the record bound), for the writers below.
    async function unrecordedTutorExecution(db: string) {
      m.database = db;
      const request = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolment, lessonRef, objectiveId],
      );
      const result = await executeAcademySupportWithTestOverrides(
        {
          requestId: request.requestId,
          message: "Explain it please.",
          idempotencyKey: randomUUID(),
        },
        {
          resolveProfile: (ref) => ({
            ref,
            adapterKind: "TEST_DETERMINISTIC",
            budgetPolicy: {
              ...DEFAULT_RUNTIME_BUDGET_POLICY,
              maxProviderCalls: 1,
              maxAttempts: 1,
              maxInputContextBytes: 64_000,
            },
          }),
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
        status: "SUCCEEDED",
        record: "NOT_RECORDED",
      });
      const [x] = await rows(
        db,
        "select id from public.tutor_lab_provider_executions where state = 'SUCCEEDED'",
      );
      return { requestId: request.requestId, executionId: x.id as string };
    }
    function signedTurn(executionId: string, requestId: string, reply: string) {
      const iat = Math.floor(Date.now() / 1000);
      const sha = (t: string) =>
        createHash("sha256").update(t, "utf8").digest("hex");
      const canonical = [
        "DUCELIO_ACADEMY_SUPPORT_TURN_HMAC_SHA256_V1",
        keyId,
        learner.id,
        executionId,
        requestId,
        sha("Explain it please."),
        sha(reply),
        iat,
        iat + 10,
      ].join("\n");
      return [
        keyId,
        executionId,
        requestId,
        "Explain it please.",
        reply,
        iat,
        iat + 10,
        createHmac("sha256", key).update(canonical).digest("hex"),
      ];
    }

    it("a reply record and a concurrent release insert on the same thread cannot deadlock (migration 065)", async () => {
      const db = await scenario();
      const { requestId, executionId } = await unrecordedTutorExecution(db);
      const [request] = await rows(
        db,
        "select learner_id, lesson_id, objective_id from public.academy_support_requests where id = $1",
        [requestId],
      );
      // The release/execution admission order: the learner-profile lock,
      // then an insert holding a foreign-key share lock on the thread.
      const holder = await connect(db);
      await holder.query("begin");
      await holder.query(
        "select 1 from public.student_profiles where user_id = $1 for update",
        [learner.id],
      );
      const turn = asLearner<{ ok: boolean; duplicate?: boolean }>(
        db,
        "select public.record_my_academy_support_turn($1,$2,$3,$4,$5,$6,$7,$8) v",
        signedTurn(executionId, requestId, "A short recorded reply."),
      ).then(
        (v) => v,
        (e: Error) => ({ ok: false as const, error: e.message }),
      );
      await waitForBlocked(db, 1);
      // One timestamp for both columns: the schema requires
      // expires_at = started_at + 30 seconds exactly, and two separate
      // clock_timestamp() calls differ by microseconds under load.
      await holder.query(
        `insert into public.tutor_lab_content_releases(student_id, invocation_id, agent_profile, academy_request_id,
           lesson_id, objective_id, state, started_at, expires_at)
         select $1, gen_random_uuid(), 'TUTOR', $2, $3, $4, 'ACTIVE', t.ts, t.ts + interval '30 seconds'
           from (select clock_timestamp() ts) t`,
        [
          request.learner_id,
          requestId,
          request.lesson_id,
          request.objective_id,
        ],
      );
      await holder.query("commit");
      await holder.end();
      expect(await turn).toEqual({ ok: true, duplicate: false });
      expect(
        await rows(
          db,
          "select count(*)::int n from public.academy_support_turns",
        ),
      ).toEqual([{ n: 1 }]);
    }, 60000);

    it("concurrent reservations cannot exceed the per-thread ceiling (migration 065)", async () => {
      const db = await scenario();
      const opened = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolment, lessonRef, objectiveId],
      );
      const results = await race(
        db,
        "select 1 from public.academy_support_requests where id = $1 for update",
        [opened.requestId],
        Array.from(
          { length: 25 },
          (_, i) => () =>
            asLearner<{ ok: boolean; code?: string }>(
              db,
              "select public.reserve_my_academy_support_interaction($1,$2,$3) v",
              [opened.requestId, randomUUID(), String(i % 10).repeat(64)],
            ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(20);
      expect(
        results.filter((r) => !r.ok && r.code === "RATE_LIMITED"),
      ).toHaveLength(5);
    }, 60000);

    it("a release row that disagrees with its request is refused by the schema (migration 065)", async () => {
      const db = await scenario();
      const opened = await asLearner<{ requestId: string }>(
        db,
        "select public.open_my_academy_tutor_support($1,$2,$3) v",
        [enrolment, lessonRef, objectiveId],
      );
      await expect(
        rows(
          db,
          `insert into public.tutor_lab_content_releases(student_id, invocation_id, agent_profile, academy_request_id,
             lesson_id, objective_id, state, started_at, expires_at)
           select learner_id, gen_random_uuid(), 'LAB_INSTRUCTOR', id, lesson_id, null, 'ACTIVE', clock_timestamp(),
             clock_timestamp() + interval '30 seconds' from public.academy_support_requests where id = $1`,
          [opened.requestId],
        ),
      ).rejects.toThrow(/ACADEMY_RELEASE_REQUEST_MISMATCH/);
    });
  },
);
