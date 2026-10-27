import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  approvedTestPackage,
  people,
  responseBody,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";
import { closeSittingNow } from "./academy-release-fixture";

// Migration 075 under real independent PostgreSQL sessions (never PGlite
// Promise.all): every race first proves that the racers actually contend on
// the learner-profile row lock held by a third session, then releases it.
// Restricted to a disposable LOCAL server.
const endpoint = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !endpoint)
  throw new Error("Disposable PostgreSQL is required but not configured");
if (
  endpoint &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname)
)
  throw new Error(
    "Learner academic races require a disposable LOCAL PostgreSQL server; hosted targets are refused",
  );
const database = `ducelio_learner_races_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const reason = "Synthetic learner academic race fixture";
const { admin, learnerA, learnerB } = people;
let owner: pg.Client;
let q: Query;
const enrol: Record<string, string> = {};

async function connect(name = database) {
  const url = new URL(endpoint!);
  url.pathname = "/" + name;
  const client = new pg.Client({ connectionString: url.toString() });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function call(auth: string, sql: string, args: unknown[]) {
  const c = await connect();
  try {
    await c.query("select set_config('request.jwt.claim.sub',$1,false)", [
      auth,
    ]);
    await c.query("set role authenticated");
    return (await c.query(sql, args)).rows[0].r as Record<string, unknown>;
  } finally {
    await c.end();
  }
}
// Holds the learner-profile row lock in a third session until every racer
// is waiting on a lock, then releases it and collects the results.
async function race(
  learnerId: string,
  racers: (() => Promise<Record<string, unknown>>)[],
) {
  const holder = await connect();
  await holder.query("begin");
  await holder.query(
    "select 1 from public.student_profiles where user_id=$1 for update",
    [learnerId],
  );
  const pending = racers.map((r) =>
    r().then(
      (value) => ({ value, error: null as string | null }),
      (e: Error) => ({ value: null, error: e.message }),
    ),
  );
  const observer = await connect("postgres");
  let blocked = false;
  try {
    for (let n = 0; n < 200; n++) {
      const count = await observer.query(
        "select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
        [database],
      );
      if (count.rows[0].n >= racers.length) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await observer.end();
    await holder.query("rollback");
    await holder.end();
  }
  const results = await Promise.all(pending);
  expect(blocked, "every racer must contend on the held lock").toBe(true);
  for (const r of results) expect(r.error).toBeNull();
  return results.map((r) => r.value!);
}
async function moveItems(
  enrolment: string,
  kind: string,
  ref: string,
  offset: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  try {
    await q(
      `update public.academy_schedule_items i
          set starts_at = now() + $4::interval, ends_at = now() + $4::interval + make_interval(mins => i.minutes),
              opens_at = now() + $4::interval, closes_at = now() + $4::interval + interval '1439 minutes'
        where i.enrolment_id = $1 and i.kind = $2 and i.ref = $3
          and i.schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
      [enrolment, kind, ref, offset],
    );
  } finally {
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
  }
}
const tomorrow = () =>
  new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const confirmSql =
  "select public.confirm_my_academy_schedule($1,'ACCELERATED_2W',$2::date,array[1,2,3,4,5,6,7],$3,'Europe/London',$4) r";

describe.skipIf(!endpoint)(
  "learner academic policies under actual PostgreSQL lock contention",
  () => {
    beforeAll(async () => {
      const adminClient = await connect("postgres");
      try {
        await adminClient.query(`create database ${database}`);
      } finally {
        await adminClient.end();
      }
      owner = await connect();
      for (const sql of await testDatabaseStatements({
        supabaseDefaultPrivileges: true,
      }))
        await owner.query(sql);
      q = (sql, args) => owner.query(sql, args);
      await seedPeople(q);
      for (const key of ["race-course-a", "race-course-b"]) {
        const { courseId } = await publishUnifiedTestCourse(q, key);
        await rpc(q, admin, "create_course_coupon", [
          `${key.toUpperCase()}-FREE`,
          100,
          new Date(Date.now() + 86400000).toISOString(),
          10,
          courseId,
          reason,
        ]);
      }
      const join = async (p: Person, key: string) =>
        (
          await rpc<{ enrolmentId: string }>(
            q,
            p,
            "create_unified_course_order",
            [key, `${key.toUpperCase()}-FREE`],
          )
        ).enrolmentId;
      enrol.aA = await join(learnerA, "race-course-a");
      enrol.aB = await join(learnerA, "race-course-b");
      enrol.bA = await join(learnerB, "race-course-a");
      const ok = await rpc<{ ok: boolean }>(
        q,
        learnerB,
        "confirm_my_academy_schedule",
        [
          enrol.bA,
          "ACCELERATED_2W",
          tomorrow(),
          [1, 2, 3, 4, 5, 6, 7],
          "09:00",
          "Europe/London",
          randomUUID(),
        ],
      );
      if (!ok.ok) throw new Error(JSON.stringify(ok));
    }, 600000);
    afterAll(async () => {
      await owner?.end();
      const adminClient = await connect("postgres");
      try {
        await adminClient.query(
          `drop database if exists ${database} with (force)`,
        );
      } finally {
        await adminClient.end();
      }
    });

    it("admits exactly one of two simultaneous activations with overlapping occupied intervals", async () => {
      const results = await race(learnerA.id, [
        () =>
          call(learnerA.auth, confirmSql, [
            enrol.aA,
            tomorrow(),
            "09:00",
            randomUUID(),
          ]),
        () =>
          call(learnerA.auth, confirmSql, [
            enrol.aB,
            tomorrow(),
            "10:00",
            randomUUID(),
          ]),
      ]);
      expect(results.filter((r) => r.ok === true)).toHaveLength(1);
      const refused = results.filter((r) => r.ok === false);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ code: "SCHEDULE_CONFLICT" });
      expect(
        (
          await q(
            "select count(*)::int n from public.academy_schedules where enrolment_id = any($1::uuid[])",
            [[enrol.aA, enrol.aB]],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 120000);

    it("creates one attempt from simultaneous duplicate starts", async () => {
      await moveItems(enrol.bA, "ASSESSMENT", "quiz-1", "-1 hour");
      const sql = "select public.start_my_academy_assessment($1,'quiz-1') r";
      const starts = await race(learnerB.id, [
        () => call(learnerB.auth, sql, [enrol.bA]),
        () => call(learnerB.auth, sql, [enrol.bA]),
        () => call(learnerB.auth, sql, [enrol.bA]),
      ]);
      expect(starts.every((s) => s.ok === true)).toBe(true);
      expect(new Set(starts.map((s) => s.attemptId)).size).toBe(1);
      expect(starts.filter((s) => s.resumed === false)).toHaveLength(1);
      expect(new Set(starts.map((s) => s.expiresAt)).size).toBe(1);
      expect(
        (
          await q(
            "select count(*)::int n from public.academy_assessment_attempts where enrolment_id=$1",
            [enrol.bA],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 120000);

    it("finalises once when a submission races the lazy expiry, with no score before release", async () => {
      const attemptId = (
        await q(
          "select id from public.academy_assessment_attempts where enrolment_id=$1 and state='ACTIVE'",
          [enrol.bA],
        )
      ).rows[0].id as string;
      const quiz = approvedTestPackage().curriculum.assessmentTemplates.find(
        (t: { key: string }) => t.key === "quiz-1",
      );
      for (const question of quiz.questions.slice(0, 3))
        await call(
          learnerB.auth,
          "select public.record_my_academy_response($1,$2,$3,$4) r",
          [
            attemptId,
            question.position,
            responseBody(question),
            `race-${randomUUID()}`,
          ],
        );
      await q(
        "alter table public.academy_assessment_attempts disable trigger guard_history",
      );
      await q(
        "update public.academy_assessment_attempts set started_at = now() - interval '30 minutes', expires_at = now() - interval '1 second' where id=$1",
        [attemptId],
      );
      await q(
        "alter table public.academy_assessment_attempts enable trigger guard_history",
      );
      const [submitted, viewed] = await race(learnerB.id, [
        () =>
          call(learnerB.auth, "select public.submit_my_academy_attempt($1) r", [
            attemptId,
          ]),
        () =>
          call(learnerB.auth, "select public.get_my_academy_attempt($1) r", [
            attemptId,
          ]),
      ]);
      expect(submitted).toEqual({
        ok: true,
        state: "SUBMITTED",
        submission: "AUTO_TIMEOUT",
      });
      expect(viewed).toMatchObject({
        state: "SUBMITTED",
        submission: "AUTO_TIMEOUT",
        released: false,
      });
      expect(viewed).not.toHaveProperty("score");
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
            "select state, submission from public.academy_assessment_attempts where id=$1",
            [attemptId],
          )
        ).rows[0],
      ).toEqual({ state: "SUBMITTED", submission: "AUTO_TIMEOUT" });
    }, 120000);

    it("processes a release exactly once under concurrent refreshes", async () => {
      await closeSittingNow(q, enrol.bA, "quiz-1");
      const sql = "select public.refresh_my_academy_releases($1) r";
      const results = await race(learnerB.id, [
        () => call(learnerB.auth, sql, [enrol.bA]),
        () => call(learnerB.auth, sql, [enrol.bA]),
      ]);
      for (const r of results) expect(r.released).toEqual(["quiz-1"]);
      const evidence = (
        await q(
          `select count(*)::int n, count(distinct (source_id, objective_id))::int d
             from public.academy_objective_evidence where enrolment_id=$1`,
          [enrol.bA],
        )
      ).rows[0];
      expect(evidence.n).toBeGreaterThan(0);
      expect(evidence.n).toBe(evidence.d);
      expect(
        (
          await q(
            "select count(*)::int n from public.academy_assessment_releases where enrolment_id=$1",
            [enrol.bA],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await q(
            "select count(*)::int n from public.audit_events where action='ACADEMY_ASSESSMENT_RELEASED' and target_id=$1",
            [enrol.bA],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 120000);
  },
);
