import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalResponseBody } from "@/domain/assessment-question-types";
import { testDatabaseStatements } from "./db-helper";
import {
  administrator,
  asPolicyUser,
  buildAssessmentPolicyFixture,
  foreignLearner,
  learner,
  learnerAuth,
} from "./commercial-v1-assessment-policy-fixture";
import {
  FREE_TEXT_QUESTION,
  packageQuestions,
  syntheticObjectiveQuestions,
} from "./interactive-exam-fixture";
import { answerSaveIdempotencyKey } from "@/server/assessment-save-key";

// CP2 (migration 059) under TRUE concurrency: independent connections to a
// real PostgreSQL server, never PGlite. Requires a DISPOSABLE server:
//
//   DUCELIO_TEST_POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres
//
// (a superuser on an isolated local/CI cluster, never a hosted or shared
// database). Without it the suite is skipped -- unless
// DUCELIO_REQUIRE_PG_CONCURRENCY=1 (set by the dedicated CI job), in which
// case a missing server FAILS the run instead of producing a false green.
//
// Every scenario runs in its own database copied from a migrated template.
// Contention is PROVEN, not assumed: each race waits until pg_stat_activity
// shows the racers blocked on a lock before the holder releases it.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const run = randomUUID().slice(0, 8);
const BASE = `ducelio_cp2_base_${run}`;
const REVIEW_BASE = `ducelio_cp2_review_${run}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
const questions = syntheticObjectiveQuestions();
const QUESTIONS = [
  ...packageQuestions(questions.slice(0, 2)),
  { ...FREE_TEXT_QUESTION, position: 3 },
];
// Assessment ids differ per template (the fixture generates them), so every
// scenario database remembers which template it was cloned from.
const quiz1ByTemplate = new Map<string, string>();
const templateOf = new Map<string, string>();
const quiz1 = (database: string) =>
  quiz1ByTemplate.get(templateOf.get(database) ?? database)!;

// ---------------------------------------------------------------------------
// Real orchestrator wiring: every createSupabase() call made inside
// connection.run(client, ...) executes on THAT independent pg connection.
// ---------------------------------------------------------------------------
const connection = new AsyncLocalStorage<pg.Client>();
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
// TypeScript-level session checks only; the DATABASE identity of every
// racing request is its own connection's JWT subject and role.
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({ id: learner, roles: ["STUDENT"] }),
  getCurrentActor: async () => ({ id: learner, roles: ["STUDENT"] }),
  requireStudentPrincipal: async () => ({ id: learner, roles: ["STUDENT"] }),
  requireActor: async () => ({ id: learner, roles: ["STUDENT"] }),
  requireAnyRole: async () => ({ id: learner, roles: ["STUDENT"] }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => pgRpcClient(connection.getStore()!),
}));
vi.mock("@/server/academic-runtime/runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/academic-runtime/runtime")>();
  return {
    ...actual,
    runGovernedProviderExecution: (...args: unknown[]) =>
      mocks.provider(...args) ??
      (actual.runGovernedProviderExecution as (...a: unknown[]) => unknown)(
        ...args,
      ),
  };
});
import { gradeControlledAssessmentAttempt } from "@/server/commercial-v1-examiner-grading";

// Named-argument RPC calls with every parameter cast to its declared type,
// derived from pg_proc (no hand-maintained signature list).
const signatures = new Map<string, { name: string; type: string }[]>();
function pgRpcClient(client: pg.Client) {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      try {
        let params = signatures.get(name);
        if (!params) {
          const { rows } = await client.query<{
            names: string[];
            types: string[];
          }>(
            `select p.proargnames as names,
               array(select format_type(t,null) from unnest(p.proargtypes) t) as types
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname=$1`,
            [name],
          );
          if (rows.length !== 1) throw new Error(`unknown rpc ${name}`);
          params = rows[0].names.map((n, i) => ({
            name: n,
            type: rows[0].types[i],
          }));
          signatures.set(name, params);
        }
        const used = params.filter((p) => p.name in args);
        const values = used.map((p) => {
          const v = args[p.name];
          return p.type === "jsonb" && v !== null && v !== undefined
            ? JSON.stringify(v)
            : (v ?? null);
        });
        const call = used
          .map((p, i) => `${p.name} => $${i + 1}::${p.type}`)
          .join(",");
        const result = await client.query(
          `select public.${name}(${call}) as v`,
          values,
        );
        return { data: result.rows[0]?.v ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
function urlFor(database: string) {
  const url = new URL(ADMIN_URL!);
  url.pathname = "/" + database;
  return url.toString();
}
async function connect(database: string) {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  return client;
}
async function as(database: string, n: number) {
  const client = await connect(database);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
    learnerAuth(n),
  ]);
  await client.query("set role authenticated");
  return client;
}
async function scenarioDatabase(template = BASE) {
  const name = `ducelio_cp2_s${created.length}_${run}`;
  const admin = await connect("postgres");
  await admin.query(`create database ${name} template ${template}`);
  await admin.end();
  created.push(name);
  templateOf.set(name, template);
  return name;
}
// Proof of overlap: `count` sessions in `database` are waiting on a lock.
async function waitForBlocked(database: string, count: number) {
  const admin = await connect("postgres");
  try {
    for (let i = 0; i < 400; i++) {
      const { rows } = await admin.query(
        "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
        [database],
      );
      if (rows[0].n >= count) return rows[0].n as number;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} blocked sessions in ${database}`);
  } finally {
    await admin.end();
  }
}
async function value<T = unknown>(
  database: string,
  sql: string,
  args: unknown[] = [],
) {
  const owner = await connect(database);
  try {
    return (await owner.query(sql, args)).rows[0]?.v as T;
  } finally {
    await owner.end();
  }
}
async function rows<T = Record<string, unknown>>(
  database: string,
  sql: string,
  args: unknown[] = [],
) {
  const owner = await connect(database);
  try {
    return (await owner.query(sql, args)).rows as T[];
  } finally {
    await owner.end();
  }
}
async function questionIds(database: string) {
  return (
    await rows<{ id: string }>(
      database,
      "select id from assessment_questions where assessment_id=$1 order by position",
      [quiz1(database)],
    )
  ).map((r) => r.id);
}
const START = "select public.start_assessment_attempt($1) as v";
const SAVE =
  "select public.record_commercial_v1_assessment_response($1,$2,$3,$4) as v";
const SUBMIT = "select public.submit_assessment_attempt($1) as v";
const body = (i: number, response: unknown) =>
  canonicalResponseBody(questions[i].questionType, response);
async function startAttempt(database: string) {
  const c = await as(database, 1);
  try {
    return (await c.query(START, [quiz1(database)])).rows[0].v as string;
  } finally {
    await c.end();
  }
}
async function saveAs(
  database: string,
  attempt: string,
  question: string,
  text: string,
) {
  const c = await as(database, 1);
  try {
    return (await c.query(SAVE, [attempt, question, text, randomUUID()]))
      .rows[0].v;
  } finally {
    await c.end();
  }
}
async function submitAs(database: string, attempt: string) {
  const c = await as(database, 1);
  try {
    await c.query(SUBMIT, [attempt]);
  } finally {
    await c.end();
  }
}
// Holds the learner's profile row lock -- the first serialisation point of
// every learner start/save/submit and of Examiner AUTHORIZE -- so racing
// orchestrations provably queue on the authoritative lock together.
async function holdLearner(database: string) {
  const owner = await connect(database);
  await owner.query("begin");
  await owner.query(
    "select 1 from student_profiles where user_id=$1 for update",
    [learner],
  );
  return async () => {
    await owner.query("commit");
    await owner.end();
  };
}
function grade(client: pg.Client, attemptId: string) {
  return connection.run(client, () =>
    gradeControlledAssessmentAttempt({ attemptId }),
  );
}
async function gradingFacts(database: string, attempt: string) {
  return {
    executions: await rows<{ state: string; reason_code: string }>(
      database,
      "select state,reason_code from commercial_v1_examiner_executions where attempt_id=$1",
      [attempt],
    ),
    revisions: await rows<{ id: string; earned: number; max: number }>(
      database,
      "select id,earned_marks_total as earned,max_marks_total as max from commercial_v1_assessment_result_revisions where attempt_id=$1",
      [attempt],
    ),
    providerCalls: Number(
      await value(
        database,
        "select coalesce(sum(u.provider_calls),0)::int as v from commercial_v1_examiner_execution_usage u join commercial_v1_examiner_executions x on x.id=u.execution_id where x.attempt_id=$1",
        [attempt],
      ),
    ),
  };
}
async function marksOf(database: string, revision: string, ids: string[]) {
  const marks = await rows<{ question_id: string; marks_awarded: number }>(
    database,
    "select question_id,marks_awarded from commercial_v1_assessment_question_marks where result_revision_id=$1",
    [revision],
  );
  return ids.map(
    (id) => marks.find((m) => m.question_id === id)?.marks_awarded,
  );
}
const providerGrades = (freeTextQuestion: string, mark: number) => async () => {
  // Hold the winning execution in its provider phase long enough for the
  // competing request to reach AUTHORIZE against the live claim.
  await new Promise((r) => setTimeout(r, 400));
  return {
    outcome: "SUCCEEDED",
    usage: {
      providerCalls: 1,
      attempts: 1,
      inputTokens: 40,
      outputTokens: 20,
      estimatedCostMicrousd: 100,
      elapsedMs: 400,
    },
    response: {
      outputText: JSON.stringify({
        outcome: "GRADED",
        marks: [{ questionId: freeTextQuestion, marksAwarded: mark }],
      }),
      usage: { inputTokens: 40, outputTokens: 20, estimatedCostMicrousd: 100 },
    },
  };
};

async function buildTemplate(name: string, escalate: boolean) {
  const admin = await connect("postgres");
  await admin.query(`create database ${name}`);
  await admin.end();
  created.push(name);
  const client = await connect(name);
  try {
    for (const sql of await testDatabaseStatements({
      supabaseDefaultPrivileges: true,
    }))
      await client.query(sql);
    const db = {
      query: (sql: string, args?: unknown[]) => client.query(sql, args),
      exec: (sql: string) => client.query(sql),
    } as unknown as PGlite;
    await client.query(
      "alter table auth.users disable trigger academy_identity",
    );
    for (const [n, id] of [
      [1, learner],
      [2, administrator],
      [3, foreignLearner],
    ] as const) {
      await client.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [learnerAuth(n), `cp2race${n}@test.example`],
      );
      await client.query(
        "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
        [learnerAuth(n), id],
      );
    }
    await client.query(
      "alter table auth.users enable trigger academy_identity",
    );
    await client.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR') on conflict do nothing",
      [administrator],
    );
    const f = await buildAssessmentPolicyFixture({
      db,
      withLabs: true,
      quiz1Questions: QUESTIONS,
      examinerAgentConfig: {
        capabilities: ["grade_controlled_assessment", "grade_practical_lab"],
        escalationPolicy: escalate ? "ACADEMIC_REVIEW" : "NONE",
      },
    });
    await client.query("reset role");
    const practical = (
      await client.query(
        "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
        [f.importId],
      )
    ).rows[0].v;
    await asPolicyUser(db, 2);
    await client.query(
      "select set_commercial_v1_lab_policy($1,$2,10,2000,'Synthetic grading guidance','CP2 concurrency lab policy')",
      [f.activationId, practical],
    );
    await client.query(
      "select publish_commercial_v1_result_policy($1,1,false,'CP2 concurrency result policy')",
      [f.activationId],
    );
    await client.query("reset role");
    await client.query(
      "select academic_execution_private.install_controller_key($1,$2::bytea)",
      [keyId, key],
    );
    quiz1ByTemplate.set(name, f.assessmentIds.QUIZ_1);
  } finally {
    await client.end();
  }
}

describe.skipIf(!ADMIN_URL)(
  "CP2 interactive examination engine under true PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", keyId);
      vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", key.toString("hex"));
      await buildTemplate(BASE, false);
      await buildTemplate(REVIEW_BASE, true);
    }, 600000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      if (!ADMIN_URL) return;
      const admin = await connect("postgres");
      for (const name of created.reverse())
        await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    }, 180000);

    it("two simultaneous starts of the same assessment create exactly one attempt", async () => {
      const database = await scenarioDatabase();
      const holder = await as(database, 1);
      const racer = await as(database, 1);
      try {
        await holder.query("begin");
        const first = (await holder.query(START, [quiz1(database)])).rows[0].v;
        const second = racer.query(START, [quiz1(database)]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect((await second).rows[0].v).toBe(first);
        expect(
          await rows(
            database,
            "select state from assessment_attempts where assessment_id=$1",
            [quiz1(database)],
          ),
        ).toEqual([{ state: "ACTIVE" }]);
        expect(
          await value(
            database,
            "select count(*)::int as v from audit_events where target_type='assessment_attempts' and action='INSERT'",
          ),
        ).toBe(1);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
    }, 120000);

    it("concurrent saves with the same idempotency key and answer record one response", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const [q1] = await questionIds(database);
      const holder = await as(database, 1);
      const racer = await as(database, 1);
      const keyText = randomUUID();
      try {
        await holder.query("begin");
        const first = (
          await holder.query(SAVE, [
            attempt,
            q1,
            body(0, { optionId: "o2" }),
            keyText,
          ])
        ).rows[0].v;
        const second = racer.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o2" }),
          keyText,
        ]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect(first.ok).toBe(true);
        expect((await second).rows[0].v).toEqual(first);
        expect(
          await rows(
            database,
            "select revision_number,body from assessment_responses where attempt_id=$1",
            [attempt],
          ),
        ).toEqual([{ revision_number: 1, body: body(0, { optionId: "o2" }) }]);
        expect(
          await value(
            database,
            "select count(*)::int as v from audit_events where target_type='assessment_responses' and action='INSERT'",
          ),
        ).toBe(1);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
    }, 120000);

    it("conflicting concurrent saves: a reused key is refused; distinct keys serialise into ordered revisions and the last answer is scored", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const [q1] = await questionIds(database);
      const keyText = randomUUID();
      let holder = await as(database, 1);
      let racer = await as(database, 1);
      try {
        await holder.query("begin");
        await holder.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o1" }),
          keyText,
        ]);
        const conflicting = racer.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o3" }),
          keyText,
        ]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect((await conflicting).rows[0].v).toEqual({
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
        });
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
      holder = await as(database, 1);
      racer = await as(database, 1);
      try {
        await holder.query("begin");
        await holder.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o3" }),
          randomUUID(),
        ]);
        const later = racer.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o2" }),
          randomUUID(),
        ]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect((await later).rows[0].v.ok).toBe(true);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
      expect(
        await rows(
          database,
          "select revision_number,body from assessment_responses where attempt_id=$1 order by revision_number",
          [attempt],
        ),
      ).toEqual([
        { revision_number: 1, body: body(0, { optionId: "o1" }) },
        { revision_number: 2, body: body(0, { optionId: "o3" }) },
        { revision_number: 3, body: body(0, { optionId: "o2" }) },
      ]);
      expect(
        await value(
          database,
          "select assessment_interaction_private.objective_marks($1,$2) as v",
          [attempt, q1],
        ),
      ).toBe(2);
    }, 120000);

    it("CP2C: concurrent distinct answers in the same revision slot stay separate and earlier history is preserved", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const [, , freeText] = await questionIds(database);
      const keyFor = (body: string, revisionSlot: number) =>
        answerSaveIdempotencyKey({
          attemptId: attempt,
          questionId: freeText,
          revisionSlot,
          body,
        });
      // Existing history: revision 1 is already recorded.
      const earlier = "Synthetic earlier answer";
      const c = await as(database, 1);
      try {
        expect(
          (
            await c.query(SAVE, [
              attempt,
              freeText,
              earlier,
              keyFor(earlier, 1),
            ])
          ).rows[0].v.ok,
        ).toBe(true);
      } finally {
        await c.end();
      }
      // Two different answers that shared a 32-bit FNV-1a checksum, both
      // answering slot 2 at the same time.
      const [a, b] = ["d27g1xbhlordy", "rae2hl0i00jow"];
      expect(keyFor(a, 2)).not.toBe(keyFor(b, 2));
      const holder = await as(database, 1);
      const racer = await as(database, 1);
      let first;
      try {
        await holder.query("begin");
        first = (await holder.query(SAVE, [attempt, freeText, a, keyFor(a, 2)]))
          .rows[0].v;
        const second = racer.query(SAVE, [attempt, freeText, b, keyFor(b, 2)]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        const secondResult = (await second).rows[0].v;
        expect(first.ok).toBe(true);
        expect(secondResult.ok).toBe(true);
        expect(secondResult.responseId).not.toBe(first.responseId);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
      // Identical retries replay; nothing new is written.
      const retry = await as(database, 1);
      try {
        expect(
          (await retry.query(SAVE, [attempt, freeText, a, keyFor(a, 2)]))
            .rows[0].v,
        ).toEqual(first);
      } finally {
        await retry.end();
      }
      expect(
        await rows(
          database,
          "select revision_number,body from assessment_responses where attempt_id=$1 and question_id=$2 order by revision_number",
          [attempt, freeText],
        ),
      ).toEqual([
        { revision_number: 1, body: earlier },
        { revision_number: 2, body: a },
        { revision_number: 3, body: b },
      ]);
      expect(
        await value(
          database,
          "select count(*)::int as v from audit_events where target_type='assessment_responses' and action='INSERT'",
        ),
      ).toBe(3);
    }, 120000);

    it("a response save racing final submission: whichever commits first wins, never both halves", async () => {
      // Submission first: the save is refused and writes nothing.
      let database = await scenarioDatabase();
      let attempt = await startAttempt(database);
      let [q1] = await questionIds(database);
      let holder = await as(database, 1);
      let racer = await as(database, 1);
      try {
        await holder.query("begin");
        await holder.query(SUBMIT, [attempt]);
        const late = racer.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o2" }),
          randomUUID(),
        ]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect((await late).rows[0].v).toEqual({
          ok: false,
          code: "ATTEMPT_NOT_ACTIVE",
        });
        expect(
          await value(
            database,
            "select count(*)::int as v from assessment_responses where attempt_id=$1",
            [attempt],
          ),
        ).toBe(0);
        expect(
          await rows(
            database,
            "select state,submission_provenance from assessment_attempts where id=$1",
            [attempt],
          ),
        ).toEqual([
          { state: "SUBMITTED", submission_provenance: "STUDENT_SUBMIT" },
        ]);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }

      // Save first: submission waits, then submits WITH the saved answer.
      database = await scenarioDatabase();
      attempt = await startAttempt(database);
      [q1] = await questionIds(database);
      holder = await as(database, 1);
      racer = await as(database, 1);
      try {
        await holder.query("begin");
        await holder.query(SAVE, [
          attempt,
          q1,
          body(0, { optionId: "o2" }),
          randomUUID(),
        ]);
        const submit = racer.query(SUBMIT, [attempt]);
        await waitForBlocked(database, 1);
        await holder.query("commit");
        expect((await submit).rows[0].v).toBe(attempt);
        expect(
          await value(
            database,
            "select assessment_interaction_private.objective_marks($1,$2) as v",
            [attempt, q1],
          ),
        ).toBe(2);
        expect(
          await rows(
            database,
            "select state from assessment_attempts where id=$1",
            [attempt],
          ),
        ).toEqual([{ state: "SUBMITTED" }]);
      } finally {
        await Promise.all([holder.end(), racer.end()]);
      }
    }, 120000);

    it("concurrent saves racing attempt expiry finalise AUTO_TIMEOUT exactly once and record nothing", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const [q1] = await questionIds(database);
      const owner = await connect(database);
      await owner.query(
        "alter table assessment_attempts disable trigger guard_assessment_attempt_history",
      );
      await owner.query(
        "update assessment_attempts set expires_at=started_at+interval '1 microsecond' where id=$1",
        [attempt],
      );
      await owner.query(
        "alter table assessment_attempts enable trigger guard_assessment_attempt_history",
      );
      await owner.end();
      // The forced deadline above is itself an audited UPDATE; measure from it.
      const auditBaseline = Number(
        await value(
          database,
          "select count(*)::int as v from audit_events where target_type='assessment_attempts' and action='UPDATE' and target_id=$1",
          [attempt],
        ),
      );
      const holder = await as(database, 1);
      const racers = await Promise.all([as(database, 1), as(database, 1)]);
      try {
        await holder.query("begin");
        const first = (
          await holder.query(SAVE, [
            attempt,
            q1,
            body(0, { optionId: "o2" }),
            randomUUID(),
          ])
        ).rows[0].v;
        const late = racers.map((c) =>
          c.query(SAVE, [
            attempt,
            q1,
            body(0, { optionId: "o1" }),
            randomUUID(),
          ]),
        );
        await waitForBlocked(database, 2);
        await holder.query("commit");
        expect(first).toMatchObject({ ok: false, code: "EXPIRED" });
        for (const r of await Promise.all(late))
          expect(r.rows[0].v).toMatchObject({ ok: false, code: "EXPIRED" });
        expect(
          await rows(
            database,
            "select state,submission_provenance,submitted_at=expires_at as anchored from assessment_attempts where id=$1",
            [attempt],
          ),
        ).toEqual([
          {
            state: "SUBMITTED",
            submission_provenance: "AUTO_TIMEOUT",
            anchored: true,
          },
        ]);
        expect(
          await value(
            database,
            "select count(*)::int as v from assessment_responses where attempt_id=$1",
            [attempt],
          ),
        ).toBe(0);
        expect(
          await value(
            database,
            "select count(*)::int as v from audit_events where target_type='assessment_attempts' and action='UPDATE' and target_id=$1",
            [attempt],
          ),
        ).toBe(auditBaseline + 1);
      } finally {
        await Promise.all([holder.end(), ...racers.map((c) => c.end())]);
      }
    }, 120000);

    it("two simultaneous grading requests for an objective attempt create one claim and one deterministic result", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const ids = await questionIds(database);
      await saveAs(database, attempt, ids[0], body(0, { optionId: "o2" })); // 2
      await saveAs(
        database,
        attempt,
        ids[1],
        body(1, { optionIds: ["o1", "o2"] }),
      ); // 0
      await submitAs(database, attempt);
      mocks.provider.mockReset();
      const racers = await Promise.all([as(database, 1), as(database, 1)]);
      const release = await holdLearner(database);
      try {
        const pending = racers.map((c) => grade(c, attempt));
        expect(await waitForBlocked(database, 2)).toBeGreaterThanOrEqual(2);
        await release();
        const results = (await Promise.all(pending)).map((r) => r.status);
        expect(results).toContain("GRADED");
        for (const status of results)
          expect(["GRADED", "ALREADY_GRADED", "RETRY_LATER"]).toContain(status);
        expect(mocks.provider).not.toHaveBeenCalled();
        const facts = await gradingFacts(database, attempt);
        expect(facts.executions).toEqual([
          { state: "SUCCEEDED", reason_code: "GRADED" },
        ]);
        expect(facts.providerCalls).toBe(0);
        expect(facts.revisions).toHaveLength(1);
        expect(await marksOf(database, facts.revisions[0].id, ids)).toEqual([
          2, 0, 0,
        ]);
      } finally {
        await Promise.all(racers.map((c) => c.end()));
      }
    }, 120000);

    it("mixed free-text/objective grading under simultaneous requests: one provider call, one combined result", async () => {
      const database = await scenarioDatabase();
      const attempt = await startAttempt(database);
      const ids = await questionIds(database);
      await saveAs(database, attempt, ids[0], body(0, { optionId: "o2" })); // 2
      await saveAs(database, attempt, ids[1], body(1, { optionIds: ["o3"] })); // 2
      await saveAs(database, attempt, ids[2], "Synthetic free-text answer.");
      await submitAs(database, attempt);
      mocks.provider.mockReset();
      mocks.provider.mockImplementation(providerGrades(ids[2], 4));
      const racers = await Promise.all([as(database, 1), as(database, 1)]);
      const release = await holdLearner(database);
      try {
        const pending = racers.map((c) => grade(c, attempt));
        expect(await waitForBlocked(database, 2)).toBeGreaterThanOrEqual(2);
        await release();
        const results = (await Promise.all(pending)).map((r) => r.status);
        expect(results).toContain("GRADED");
        for (const status of results)
          expect(["GRADED", "ALREADY_GRADED", "RETRY_LATER"]).toContain(status);
        expect(mocks.provider).toHaveBeenCalledTimes(1);
        const sent = JSON.stringify(mocks.provider.mock.calls[0][1]);
        expect(sent).not.toContain("Synthetic option");
        expect(sent).not.toContain("objectiveMarks");
        const facts = await gradingFacts(database, attempt);
        expect(facts.executions).toEqual([
          { state: "SUCCEEDED", reason_code: "GRADED" },
        ]);
        expect(facts.providerCalls).toBe(1);
        expect(facts.revisions).toEqual([
          expect.objectContaining({ earned: 8, max: 11 }),
        ]);
        expect(await marksOf(database, facts.revisions[0].id, ids)).toEqual([
          2, 2, 4,
        ]);
        // A later replay never re-grades.
        const replay = await as(database, 1);
        try {
          expect((await grade(replay, attempt)).status).toBe("ALREADY_GRADED");
        } finally {
          await replay.end();
        }
        expect((await gradingFacts(database, attempt)).revisions).toHaveLength(
          1,
        );
      } finally {
        await Promise.all(racers.map((c) => c.end()));
      }
    }, 120000);

    it("competing human reviews: a forged objective mark never lands and one result keeps the deterministic marks", async () => {
      async function escalatedCase() {
        const database = await scenarioDatabase(REVIEW_BASE);
        const attempt = await startAttempt(database);
        const ids = await questionIds(database);
        await saveAs(database, attempt, ids[0], body(0, { optionId: "o2" })); // 2
        await saveAs(database, attempt, ids[1], body(1, { optionIds: ["o3"] })); // 2
        await saveAs(database, attempt, ids[2], "Synthetic free-text answer.");
        await submitAs(database, attempt);
        const learnerConn = await as(database, 1);
        try {
          expect((await grade(learnerConn, attempt)).status).toBe("ESCALATED");
        } finally {
          await learnerConn.end();
        }
        const reviewer = await as(database, 2);
        const cases = (
          await reviewer.query(
            "select public.list_commercial_v1_academic_review_cases() as v",
          )
        ).rows[0].v.cases as { caseId: string }[];
        await reviewer.end();
        expect(cases).toHaveLength(1);
        return { database, attempt, ids, caseId: cases[0].caseId };
      }
      const GRADE =
        "select public.submit_commercial_v1_academic_review_assessment_grade($1,$2::jsonb,$3) as v";
      const marks = (ids: string[], m: number[]) =>
        JSON.stringify(
          ids.map((questionId, i) => ({ questionId, marksAwarded: m[i] })),
        );

      // Forged reviewer holds the locks, fails, rolls back; the honest
      // reviewer are released together from the learner's profile lock (the
      // review writer's first serialisation point). Whatever the grant order,
      // the forged mark is refused and the honest review records the result.
      let s = await escalatedCase();
      let forged = await as(s.database, 2);
      let honest = await as(s.database, 2);
      try {
        const release = await holdLearner(s.database);
        const forgedOutcome = forged
          .query(GRADE, [
            s.caseId,
            marks(s.ids, [2, 4, 5]),
            "Forged objective mark",
          ])
          .then(
            (r) => ({ ok: true as const, v: r.rows[0].v }),
            (e: Error) => ({ ok: false as const, message: e.message }),
          );
        const honestOutcome = honest.query(GRADE, [
          s.caseId,
          marks(s.ids, [2, 2, 5]),
          "Synthetic escalated attempt reviewed",
        ]);
        expect(await waitForBlocked(s.database, 2)).toBeGreaterThanOrEqual(2);
        await release();
        // Granted first: refused by the mark guard. Granted second: the case
        // is already resolved and nothing new is created. Never a result.
        const refused = await forgedOutcome;
        if (refused.ok) expect(refused.v.code).not.toBe("RESULT_CREATED");
        else expect(refused.message).toMatch(/OBJECTIVE_MARKS_MISMATCH/);
        expect((await honestOutcome).rows[0].v).toMatchObject({
          ok: true,
          code: "RESULT_CREATED",
        });
      } finally {
        await Promise.all([forged.end(), honest.end()]);
      }
      let facts = await gradingFacts(s.database, s.attempt);
      expect(facts.revisions).toEqual([
        expect.objectContaining({ earned: 9, max: 11 }),
      ]);
      expect(await marksOf(s.database, facts.revisions[0].id, s.ids)).toEqual([
        2, 2, 5,
      ]);

      // Honest reviewer commits first; a racing forged submission cannot
      // create a second result or alter the deterministic marks.
      s = await escalatedCase();
      honest = await as(s.database, 2);
      forged = await as(s.database, 2);
      try {
        await honest.query("begin");
        await honest.query(GRADE, [
          s.caseId,
          marks(s.ids, [2, 2, 3]),
          "Synthetic escalated attempt reviewed",
        ]);
        const late = forged
          .query(GRADE, [
            s.caseId,
            marks(s.ids, [0, 4, 5]),
            "Forged objective mark",
          ])
          .then(
            (r) => ({ ok: true as const, v: r.rows[0].v }),
            (e: Error) => ({ ok: false as const, message: e.message }),
          );
        await waitForBlocked(s.database, 1);
        await honest.query("commit");
        const outcome = await late;
        if (outcome.ok) expect(outcome.v.code).not.toBe("RESULT_CREATED");
      } finally {
        await Promise.all([honest.end(), forged.end()]);
      }
      facts = await gradingFacts(s.database, s.attempt);
      expect(facts.revisions).toHaveLength(1);
      expect(await marksOf(s.database, facts.revisions[0].id, s.ids)).toEqual([
        2, 2, 3,
      ]);
      expect(
        await value(
          s.database,
          "select count(*)::int as v from audit_events where action='COMMERCIAL_V1_ACADEMIC_REVIEW_FIRST_GRADE'",
        ),
      ).toBe(1);
    }, 300000);
  },
);
