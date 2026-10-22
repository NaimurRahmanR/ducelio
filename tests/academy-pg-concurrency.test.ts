import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  openSittingNow,
  people,
  publishAcademyCourse,
  responseBody,
  academyPackage,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";

// Migration 202610220060 under TRUE concurrency: independent connections to
// a real, DISPOSABLE PostgreSQL server (never PGlite, never hosted):
//
//   DUCELIO_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:<port>/postgres
//
// Skipped without it, unless DUCELIO_REQUIRE_PG_CONCURRENCY=1, which fails
// instead of producing a false green. Contention is proven: every race
// waits until pg_stat_activity shows the racers blocked on the held lock.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const DB = `ducelio_academy_${randomUUID().slice(0, 8)}`;
const urlFor = (database: string) => {
  const url = new URL(ADMIN_URL!);
  url.pathname = "/" + database;
  return url.toString();
};
async function connect(database = DB) {
  const client = new pg.Client({ connectionString: urlFor(database) });
  // DROP DATABASE ... WITH (FORCE) at teardown terminates idle sessions.
  client.on("error", () => {});
  await client.connect();
  return client;
}
let owner: pg.Client;
let q: Query;
let offerId: string;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);

async function learnerClient(person: Person) {
  const client = await connect();
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
    person.auth,
  ]);
  await client.query("set role authenticated");
  return client;
}
async function waitForBlocked(count: number) {
  const admin = await connect("postgres");
  try {
    for (let i = 0; i < 400; i++) {
      const { rows } = await admin.query(
        "select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
        [DB],
      );
      if (rows[0].n >= count) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} blocked sessions`);
  } finally {
    await admin.end();
  }
}
// Hold a row lock, start every racer, prove they are blocked, release.
async function race<T>(
  lockSql: string,
  lockArgs: unknown[],
  racers: (() => Promise<T>)[],
) {
  const holder = await connect();
  await holder.query("begin");
  await holder.query(lockSql, lockArgs);
  const pending = racers.map((r) => r());
  await waitForBlocked(racers.length);
  await holder.query("commit");
  await holder.end();
  return Promise.all(pending);
}

describe.skipIf(!ADMIN_URL)(
  "Academy B2C under true PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      const admin = await connect("postgres");
      await admin.query(`create database ${DB}`);
      await admin.end();
      owner = await connect();
      for (const sql of await testDatabaseStatements()) await owner.query(sql);
      q = (sql, params) => owner.query(sql, params as unknown[]);
      await seedPeople(q);
      offerId = (await publishAcademyCourse(q)).offerId;
    }, 240000);
    afterAll(async () => {
      await owner?.end();
      if (!ADMIN_URL) return;
      const admin = await connect("postgres");
      await admin.query(`drop database if exists ${DB} with (force)`);
      await admin.end();
    });

    it("concurrent first confirmations with different keys create exactly one timetable", async () => {
      const enrolment = await rpc<string>(
        q,
        people.learnerA,
        "grant_academy_entitlement",
        [offerId, people.learnerA.email, null, "Race"],
      ).catch(() => null);
      expect(enrolment).toBeNull(); // learners cannot grant themselves access
      const id = await rpc<string>(
        q,
        people.admin,
        "grant_academy_entitlement",
        [offerId, people.learnerA.email, null, "Concurrency acceptance"],
      );
      const clients = await Promise.all(
        [1, 2, 3, 4].map(() => learnerClient(people.learnerA)),
      );
      const results = await race(
        "select 1 from public.academy_enrolments where id=$1 for update",
        [id],
        clients.map(
          (c, i) => async () =>
            (
              await c.query(
                "select public.confirm_my_academy_schedule($1,$2,$3::date,$4::int[],$5,$6,$7) r",
                [
                  id,
                  i % 2 ? "STANDARD_6W" : "FLEXIBLE_12W",
                  addDays(today(), 2),
                  i % 2 ? [1, 3, 5, 6] : [1, 3, 5],
                  "19:00",
                  "Europe/London",
                  randomUUID(),
                ],
              )
            ).rows[0].r,
        ),
      );
      await Promise.all(clients.map((c) => c.end()));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.code === "PLAN_EXISTS")).toHaveLength(3);
      const rows = (
        await q(
          "select count(*)::int n, min(format_id) f from public.academy_schedules where enrolment_id=$1",
          [id],
        )
      ).rows[0];
      expect(rows.n).toBe(1);
      expect(
        (
          await q(
            "select format_id from public.academy_enrolments where id=$1",
            [id],
          )
        ).rows[0].format_id,
      ).toBe(rows.f);
    }, 60000);

    it("concurrent retries of one confirmation are idempotent", async () => {
      const id = await rpc<string>(
        q,
        people.admin,
        "grant_academy_entitlement",
        [offerId, people.learnerB.email, null, "Concurrency acceptance"],
      );
      const key = randomUUID();
      const clients = await Promise.all(
        [1, 2, 3].map(() => learnerClient(people.learnerB)),
      );
      const results = await race(
        "select 1 from public.academy_enrolments where id=$1 for update",
        [id],
        clients.map(
          (c) => async () =>
            (
              await c.query(
                "select public.confirm_my_academy_schedule($1,'STANDARD_6W',$2::date,'{1,3,5,6}'::int[],'07:30','Asia/Kolkata',$3) r",
                [id, addDays(today(), 2), key],
              )
            ).rows[0].r,
        ),
      );
      await Promise.all(clients.map((c) => c.end()));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        (
          await q(
            "select count(*)::int n from public.academy_schedules where enrolment_id=$1",
            [id],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 60000);

    it("concurrent starts open one attempt and concurrent submits score it once", async () => {
      const id = (
        await q(
          "select id from public.academy_enrolments where learner_id=$1",
          [people.learnerA.id],
        )
      ).rows[0].id as string;
      await openSittingNow(q, id, "quiz-1");
      const clients = await Promise.all(
        [1, 2, 3].map(() => learnerClient(people.learnerA)),
      );
      const starts = await race(
        "select 1 from public.academy_enrolments where id=$1 for update",
        [id],
        clients.map(
          (c) => async () =>
            (
              await c.query(
                "select public.start_my_academy_assessment($1,'quiz-1') r",
                [id],
              )
            ).rows[0].r,
        ),
      );
      expect(new Set(starts.map((s) => s.attemptId)).size).toBe(1);
      expect(starts.filter((s) => s.resumed === false)).toHaveLength(1);
      const attemptId = starts[0].attemptId as string;
      const quiz = academyPackage().curriculum.assessmentTemplates[0];
      for (const question of quiz.questions)
        await clients[0].query(
          "select public.record_my_academy_response($1,$2,$3,$4)",
          [
            attemptId,
            question.position,
            responseBody(question),
            `race-${question.position}-key`,
          ],
        );
      const submits = await race(
        "select 1 from public.academy_assessment_attempts where id=$1 for update",
        [attemptId],
        clients.map(
          (c) => async () =>
            (
              await c.query("select public.submit_my_academy_attempt($1) r", [
                attemptId,
              ])
            ).rows[0].r,
        ),
      );
      await Promise.all(clients.map((c) => c.end()));
      expect(new Set(submits.map((s) => JSON.stringify(s))).size).toBe(1);
      expect(
        (
          await q(
            "select count(*)::int n from public.academy_question_marks where attempt_id=$1",
            [attemptId],
          )
        ).rows[0].n,
      ).toBe(quiz.questions.length);
      expect(
        (
          await q(
            "select count(*)::int n from public.audit_events where action='ACADEMY_ASSESSMENT_STARTED' and target_id=$1",
            [attemptId],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 60000);
  },
);
