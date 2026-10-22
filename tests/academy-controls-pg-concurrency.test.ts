import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  buildAssessmentPolicyFixture,
  learnerAuth,
  learner as institutionalLearnerId,
} from "./commercial-v1-assessment-policy-fixture";
import {
  approvedTestPackage,
  openSittingNow,
  people,
  publishAcademyCourse,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";

// Migration 061 under TRUE concurrency on a real, DISPOSABLE PostgreSQL
// server (DUCELIO_TEST_POSTGRES_URL; see tests/academy-pg-concurrency.test.ts).
// One template holds a real institutional Commercial V1 assessment and an
// Academy enrolment for the SAME learner; every scenario runs in its own
// clone. Contention is proven through pg_stat_activity before release.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !ADMIN_URL)
  throw new Error(
    "DUCELIO_REQUIRE_PG_CONCURRENCY=1 but DUCELIO_TEST_POSTGRES_URL is not set",
  );

const run = randomUUID().slice(0, 8);
const TEMPLATE = `ducelio_acad_ctl_${run}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
let quiz1Institutional = "";
let enrolment = "";
let offerSlug = "";
const learnerAuthId = learnerAuth(1);

const urlFor = (database: string) => {
  const url = new URL(ADMIN_URL!);
  url.pathname = "/" + database;
  return url.toString();
};
async function connect(database: string) {
  const client = new pg.Client({ connectionString: urlFor(database) });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function as(database: string, auth: string | null) {
  const client = await connect(database);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
    auth ?? "",
  ]);
  await client.query(auth ? "set role authenticated" : "set role anon");
  return client;
}
async function scenario() {
  const name = `ducelio_acad_s${created.length}_${run}`;
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
async function race<T>(
  database: string,
  lockSql: string,
  lockArgs: unknown[],
  racers: (() => Promise<T>)[],
) {
  const holder = await connect(database);
  await holder.query("begin");
  await holder.query(lockSql, lockArgs);
  const pending = racers.map((r) =>
    r().then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    ),
  );
  await waitForBlocked(database, racers.length);
  await holder.query("commit");
  await holder.end();
  return Promise.all(pending);
}
const holdLearner =
  "select 1 from public.student_profiles where user_id=$1 for update";

describe.skipIf(!ADMIN_URL)(
  "Academy controls and checkout under true PostgreSQL concurrency",
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
        const db = {
          query: q,
          exec: (sql: string) => client.query(sql),
        } as unknown as PGlite;
        await client.query(
          "alter table auth.users disable trigger academy_identity",
        );
        for (const [n, id] of [
          [1, institutionalLearnerId],
          [2, "10000000-0000-4000-8000-000000000002"],
          [3, "10000000-0000-4000-8000-000000000003"],
        ] as const) {
          await client.query(
            "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
            [learnerAuth(n), `acadrace${n}@test.example`],
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
          ["10000000-0000-4000-8000-000000000002"],
        );
        const fixture = await buildAssessmentPolicyFixture({
          db,
          withLabs: true,
        });
        await client.query("reset role");
        quiz1Institutional = fixture.assessmentIds.QUIZ_1;
        await seedPeople(q);
        const course = await publishAcademyCourse(
          q,
          "academy-race-test",
          approvedTestPackage("academy-race-test"),
        );
        offerSlug = "academy-race-test";
        await rpc(q, people.admin, "enable_academy_public_sale", [
          course.offerId,
          true,
          "Owner approved test policy",
        ]);
        enrolment = await rpc<string>(
          q,
          people.admin,
          "grant_academy_entitlement",
          [
            course.offerId,
            "acadrace1@test.example",
            null,
            "Race acceptance access",
          ],
        );
        const learner = {
          id: institutionalLearnerId,
          auth: learnerAuthId,
          email: "acadrace1@test.example",
          role: "STUDENT",
        } as const;
        const start = new Date(Date.now() + 2 * 86400000)
          .toISOString()
          .slice(0, 10);
        await rpc(q, learner, "confirm_my_academy_schedule", [
          enrolment,
          "STANDARD_6W",
          start,
          [1, 3, 5, 6],
          "19:00",
          "Europe/London",
          randomUUID(),
        ]);
        for (const ref of ["quiz-1", "quiz-2"])
          await openSittingNow(q, enrolment, ref);
        await client.query(
          "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
          [keyId, key],
        );
      } finally {
        await client.end();
      }
    }, 300000);
    afterAll(async () => {
      if (!ADMIN_URL) return;
      const admin = await connect("postgres");
      for (const name of created.reverse())
        await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    });

    it("an institutional start and an Academy start racing for the same learner admit exactly one controlled attempt", async () => {
      const database = await scenario();
      const institutional = await as(database, learnerAuthId);
      const academy = await as(database, learnerAuthId);
      const results = await race(
        database,
        holdLearner,
        [institutionalLearnerId],
        [
          async () =>
            (
              await institutional.query(
                "select public.start_assessment_attempt($1) v",
                [quiz1Institutional],
              )
            ).rows[0].v,
          async () =>
            (
              await academy.query(
                "select public.start_my_academy_assessment($1,'quiz-1') v",
                [enrolment],
              )
            ).rows[0].v,
        ],
      );
      await Promise.all([institutional.end(), academy.end()]);
      const active = await rows(
        database,
        `select (select count(*) from public.assessment_attempts where student_id=$1 and state='ACTIVE')::int
      + (select count(*) from public.academy_assessment_attempts where learner_id=$1 and state='ACTIVE')::int n`,
        [institutionalLearnerId],
      );
      expect(active[0].n).toBe(1);
      const admitted = results.filter(
        (r) => r.ok && (typeof r.v === "string" || (r.v as { ok: boolean }).ok),
      );
      expect(admitted).toHaveLength(1);
      const refused = results.find((r) => r !== admitted[0])!;
      expect(
        refused.ok ? (refused.v as { code: string }).code : refused.error,
      ).toMatch(
        /ANOTHER_ASSESSMENT_ACTIVE|Another controlled assessment attempt is already active/,
      );
    }, 60000);

    it("two Academy sittings for different assessments racing admit exactly one", async () => {
      const database = await scenario();
      const a = await as(database, learnerAuthId);
      const b = await as(database, learnerAuthId);
      const results = await race(
        database,
        holdLearner,
        [institutionalLearnerId],
        [
          async () =>
            (
              await a.query(
                "select public.start_my_academy_assessment($1,'quiz-1') v",
                [enrolment],
              )
            ).rows[0].v,
          async () =>
            (
              await b.query(
                "select public.start_my_academy_assessment($1,'quiz-2') v",
                [enrolment],
              )
            ).rows[0].v,
        ],
      );
      await Promise.all([a.end(), b.end()]);
      const values = results.map((r) => (r.ok ? r.v : r.error)) as {
        ok: boolean;
        code?: string;
      }[];
      expect(values.filter((v) => v.ok)).toHaveLength(1);
      expect(
        values.filter((v) => v.code === "ANOTHER_ASSESSMENT_ACTIVE"),
      ).toHaveLength(1);
      expect(
        (
          await rows(
            database,
            "select count(*)::int n from public.academy_assessment_attempts where state='ACTIVE'",
          )
        )[0].n,
      ).toBe(1);
    }, 60000);

    it("an Academy start racing an AI content release never leaves both open", async () => {
      const database = await scenario();
      const exam = await as(database, learnerAuthId);
      const ai = await as(database, learnerAuthId);
      const results = await race(
        database,
        holdLearner,
        [institutionalLearnerId],
        [
          async () =>
            (
              await exam.query(
                "select public.start_my_academy_assessment($1,'quiz-1') v",
                [enrolment],
              )
            ).rows[0].v,
          async () =>
            (
              await ai.query(
                "select public.begin_academic_content_release($1,'get_lesson_context','PROFESSOR_READ_V2') v",
                [randomUUID()],
              )
            ).rows[0].v,
        ],
      );
      await Promise.all([exam.end(), ai.end()]);
      const [examResult, release] = results.map((r) =>
        r.ok ? r.v : r.error,
      ) as { ok: boolean; code?: string }[];
      // Whichever acquired the learner lock first wins; the other refuses.
      expect([examResult.ok, release.ok].filter(Boolean)).toHaveLength(1);
      expect(examResult.ok ? release.code : examResult.code).toMatch(
        /ACTIVITY_BLOCKED|ACTIVITY_BUSY/,
      );
      const open = await rows(
        database,
        `select (select count(*) from public.academic_content_releases where student_id=$1 and state='ACTIVE')::int a,
      (select count(*) from public.academy_assessment_attempts where learner_id=$1 and state='ACTIVE')::int b`,
        [institutionalLearnerId],
      );
      expect(open[0].a + open[0].b).toBe(1);
    }, 60000);

    it("a webhook and a success-page reconciliation racing for one paid order fulfil it exactly once", async () => {
      const database = await scenario();
      const buyer = await as(database, people.learnerB.auth);
      const order = (
        await buyer.query(
          "select public.create_academy_order($1,'INTENSIVE_4W') v",
          [offerSlug],
        )
      ).rows[0].v;
      await buyer.query(
        "select public.attach_academy_checkout_session($1,'cs_test_race')",
        [order.orderId],
      );
      await buyer.end();
      const claim = (eventId: string) => {
        const iat = Math.floor(Date.now() / 1000);
        const exp = iat + 60;
        const mac = createHmac("sha256", key)
          .update(
            [
              "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1",
              "ACADEMY_COMMERCE_V1",
              keyId,
              "STRIPE",
              order.orderId,
              "cs_test_race",
              eventId,
              String(order.amountMinor),
              order.currency,
              "PAID",
              String(iat),
              String(exp),
            ].join("\n"),
            "utf8",
          )
          .digest("hex");
        return [
          keyId,
          order.orderId,
          "STRIPE",
          "cs_test_race",
          eventId,
          order.amountMinor,
          order.currency,
          "PAID",
          iat,
          exp,
          mac,
        ];
      };
      const webhook = await as(database, null);
      const success = await as(database, people.learnerB.auth);
      const sql =
        "select public.fulfill_academy_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v";
      const results = await race(
        database,
        "select 1 from public.academy_orders where id=$1 for update",
        [order.orderId],
        [
          async () =>
            (await webhook.query(sql, claim("evt_race_webhook"))).rows[0].v,
          async () =>
            (await success.query(sql, claim("SESSION_VERIFY:cs_test_race")))
              .rows[0].v,
        ],
      );
      await Promise.all([webhook.end(), success.end()]);
      const values = results.map((r) => (r.ok ? r.v : { error: r.error })) as {
        fulfilled: boolean;
        replay: boolean;
        enrolmentId: string;
      }[];
      expect(values.every((v) => v.fulfilled)).toBe(true);
      expect(values.filter((v) => v.replay)).toHaveLength(1);
      expect(new Set(values.map((v) => v.enrolmentId)).size).toBe(1);
      const facts = (
        await rows(
          database,
          `select (select count(*) from public.academy_entitlements where learner_id=$1)::int ents,
      (select count(*) from public.academy_enrolments where learner_id=$1)::int enrols,
      (select count(*) from public.academy_payment_events where order_id=$2)::int events,
      (select format_id from public.academy_entitlements where learner_id=$1) format`,
          [people.learnerB.id, order.orderId],
        )
      )[0];
      expect(facts).toEqual({
        ents: 1,
        enrols: 1,
        events: 2,
        format: "INTENSIVE_4W",
      });
    }, 60000);
  },
);
