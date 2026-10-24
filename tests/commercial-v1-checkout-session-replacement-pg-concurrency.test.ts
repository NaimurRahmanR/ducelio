// Historical creation protocol through 072. Current cutover and retained-order
// verification run in unified-legacy-retirement-db.test.ts against 073.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  administrator,
  asPolicyUser,
  buildCommerceFixture,
  foreignLearner,
  learner,
  learnerAuth,
} from "./commercial-v1-commerce-fixture";

// LR-03 review finding 2: TRUE concurrency for migration 058's replacement
// function, over independent connections to a real PostgreSQL server.
// PGlite is single-connection, so this suite needs a DISPOSABLE local server:
//
//   DUCELIO_TEST_POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres
//
// (a superuser on an isolated local cluster, never a hosted or shared
// database). Without it the suite is skipped. Every scenario runs in its own
// database copied from one migrated template, so each starts from the same
// PENDING order bound to the same expired session.
const ADMIN_URL = process.env.DUCELIO_TEST_POSTGRES_URL;
const run = randomUUID().slice(0, 8);
const BASE = `ducelio_lr03_base_${run}`;
const created: string[] = [];
const keyId = randomUUID();
const key = randomBytes(32);
const PRICE = 19900;
const EXPIRED = "cs_test_expired_original";
let orderId = "";

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
// A learner/admin session exactly as the RLS tests use it: JWT subject plus
// the authenticated role, on its OWN connection.
async function as(database: string, n: number) {
  const client = await connect(database);
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [
    learnerAuth(n),
  ]);
  await client.query("set role authenticated");
  return client;
}
function signedReplacement(payload: Record<string, unknown>) {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 60;
  const text = JSON.stringify(payload);
  const mac = createHmac("sha256", key)
    .update(
      [
        "DUCELIO_COMMERCE_CHECKOUT_REBIND_HMAC_SHA256_V1",
        keyId,
        text,
        String(issued),
        String(expires),
      ].join("\n"),
    )
    .digest("hex");
  return [keyId, text, issued, expires, mac];
}
const replacement = (to: string, learnerId = learner) =>
  signedReplacement({
    learnerId,
    orderId,
    expiredSessionId: EXPIRED,
    replacementSessionId: to,
  });
const REPLACE =
  "select public.replace_expired_commercial_v1_checkout_session($1,$2,$3,$4,$5) as v";
function fulfilment(sessionId: string) {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 60;
  const eventId = "evt_" + sessionId;
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    "COMMERCIAL_V1_COMMERCE_V1",
    keyId,
    "STRIPE",
    orderId,
    sessionId,
    eventId,
    String(PRICE),
    "GBP",
    "PAID",
    String(issued),
    String(expires),
  ].join("\n");
  return [
    keyId,
    orderId,
    sessionId,
    eventId,
    PRICE,
    issued,
    expires,
    createHmac("sha256", key).update(canonical).digest("hex"),
  ];
}
const FULFIL =
  "select public.fulfill_commercial_v1_order($1,$2,'STRIPE',$3,$4,$5,'GBP','PAID',$6,$7,$8) as v";

async function scenarioDatabase() {
  const name = `ducelio_lr03_s${created.length}_${run}`;
  const admin = await connect("postgres");
  await admin.query(`create database ${name} template ${BASE}`);
  await admin.end();
  created.push(name);
  return name;
}
// Wait until `count` sessions in `database` are blocked on a lock: proof the
// racers really contend for the order row instead of running one by one.
async function waitForBlocked(database: string, count: number) {
  const admin = await connect("postgres");
  try {
    for (let i = 0; i < 200; i++) {
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
async function facts(database: string) {
  const client = await connect(database);
  try {
    const one = async (sql: string) =>
      (await client.query(sql, [orderId])).rows[0];
    return {
      bound: (
        await one(
          "select provider_session_id as v from public.commercial_v1_orders where id=$1",
        )
      ).v as string,
      state: (
        await one(
          "select state as v from public.commercial_v1_orders where id=$1",
        )
      ).v as string,
      history: (
        await client.query(
          "select superseded_session_id, replacement_session_id from public.commercial_v1_checkout_session_replacements where order_id=$1",
          [orderId],
        )
      ).rows,
      audits: (
        await one(
          "select count(*)::int as v from public.audit_events where action='COMMERCIAL_V1_CHECKOUT_SESSION_REPLACED' and target_id=$1",
        )
      ).v as number,
      entitlements: (
        await one(
          "select count(*)::int as v from public.commercial_v1_entitlements where order_id=$1",
        )
      ).v as number,
    };
  } finally {
    await client.end();
  }
}

describe.skipIf(!ADMIN_URL)(
  "checkout session replacement under true PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      const admin = await connect("postgres");
      await admin.query(`create database ${BASE}`);
      await admin.end();
      created.push(BASE);
      const client = await connect(BASE);
      try {
        for (const sql of await testDatabaseStatements({
          throughMigration: 72,
          supabaseDefaultPrivileges: true,
        }))
          await client.query(sql);
        // The fixture's PGlite surface is query/exec; pg provides both.
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
            [learnerAuth(n), `race${n}@test.example`],
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
        const fixture = await buildCommerceFixture({ db });
        await client.query(
          "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
          [keyId, key],
        );
        await asPolicyUser(db, 2);
        await client.query(
          "select public.publish_commercial_v1_offer($1,'race-course',$2,'GBP','Race course','STANDARD_6_WEEK','Concurrency fixture')",
          [fixture.activationId, PRICE],
        );
        await asPolicyUser(db, 1);
        orderId = (
          await client.query(
            "select public.create_commercial_v1_order('race-course') as v",
          )
        ).rows[0].v.orderId;
        await client.query(
          "select public.attach_commercial_v1_checkout_session($1,$2)",
          [orderId, EXPIRED],
        );
      } finally {
        await client.end();
      }
    }, 300000);

    afterAll(async () => {
      const admin = await connect("postgres");
      for (const name of created.reverse())
        await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    }, 120000);

    it("eight identical concurrent claims: one REPLACED, the rest ALREADY_REPLACED, one binding, one history row", async () => {
      const database = await scenarioDatabase();
      const holder = await as(database, 1);
      const racers = await Promise.all(
        Array.from({ length: 7 }, () => as(database, 1)),
      );
      try {
        await holder.query("begin");
        const first = (
          await holder.query(REPLACE, replacement("cs_test_winner"))
        ).rows[0].v;
        const pending = racers.map((c) =>
          c.query(REPLACE, replacement("cs_test_winner")),
        );
        expect(await waitForBlocked(database, 7)).toBeGreaterThanOrEqual(7);
        await holder.query("commit");
        const rest = (await Promise.all(pending)).map((r) => r.rows[0].v);
        expect(first).toEqual({ ok: true, code: "REPLACED" });
        expect(rest).toEqual(
          Array(7).fill({ ok: true, code: "ALREADY_REPLACED" }),
        );
        expect(await facts(database)).toMatchObject({
          bound: "cs_test_winner",
          state: "PENDING",
          history: [
            {
              superseded_session_id: EXPIRED,
              replacement_session_id: "cs_test_winner",
            },
          ],
          audits: 1,
        });
      } finally {
        await Promise.all([holder, ...racers].map((c) => c.end()));
      }
    }, 120000);

    it("conflicting concurrent claims: exactly one replacement wins, the other sees SESSION_CHANGED", async () => {
      const database = await scenarioDatabase();
      const a = await as(database, 1);
      const b = await as(database, 1);
      try {
        await a.query("begin");
        const won = (await a.query(REPLACE, replacement("cs_test_a"))).rows[0]
          .v;
        const late = b.query(REPLACE, replacement("cs_test_b"));
        await waitForBlocked(database, 1);
        await a.query("commit");
        expect(won).toEqual({ ok: true, code: "REPLACED" });
        expect((await late).rows[0].v).toEqual({
          ok: false,
          code: "SESSION_CHANGED",
        });
        const after = await facts(database);
        expect(after.bound).toBe("cs_test_a");
        expect(after.history).toHaveLength(1);
        expect(after.audits).toBe(1);
      } finally {
        await Promise.all([a.end(), b.end()]);
      }
    }, 120000);

    it("a concurrent claim by another learner never touches the owner's order", async () => {
      const database = await scenarioDatabase();
      const owner = await as(database, 1);
      const foreign = await as(database, 3);
      try {
        await owner.query("begin");
        await owner.query(REPLACE, replacement("cs_test_owner"));
        const intruder = (
          await foreign.query(
            REPLACE,
            replacement("cs_test_intruder", foreignLearner),
          )
        ).rows[0].v;
        expect(intruder).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
        await owner.query("commit");
        const after = await facts(database);
        expect(after.bound).toBe("cs_test_owner");
        expect(after.history).toHaveLength(1);
      } finally {
        await Promise.all([owner.end(), foreign.end()]);
      }
    }, 120000);

    it("replacement racing fulfilment of the old session: never both", async () => {
      // Fulfilment commits first: the replacement is refused.
      let database = await scenarioDatabase();
      let payer = await as(database, 1);
      let replacer = await as(database, 1);
      try {
        await payer.query("begin");
        expect(
          (await payer.query(FULFIL, fulfilment(EXPIRED))).rows[0].v,
        ).toMatchObject({ ok: true, fulfilled: true });
        const refused = replacer.query(REPLACE, replacement("cs_test_late"));
        await waitForBlocked(database, 1);
        await payer.query("commit");
        expect((await refused).rows[0].v).toEqual({
          ok: false,
          code: "INVALID_STATE",
        });
        expect(await facts(database)).toMatchObject({
          bound: EXPIRED,
          state: "FULFILLED",
          history: [],
          entitlements: 1,
        });
      } finally {
        await Promise.all([payer.end(), replacer.end()]);
      }

      // Replacement commits first: the old session can no longer fulfil.
      database = await scenarioDatabase();
      payer = await as(database, 1);
      replacer = await as(database, 1);
      try {
        await replacer.query("begin");
        await replacer.query(REPLACE, replacement("cs_test_new"));
        const stale = payer.query(FULFIL, fulfilment(EXPIRED));
        await waitForBlocked(database, 1);
        await replacer.query("commit");
        expect((await stale).rows[0].v).toMatchObject({
          ok: false,
          code: "MISMATCHED_SESSION",
        });
        expect(await facts(database)).toMatchObject({
          bound: "cs_test_new",
          state: "PENDING",
          entitlements: 0,
        });
      } finally {
        await Promise.all([payer.end(), replacer.end()]);
      }
    }, 120000);

    it("a replayed claim after completion is idempotent and history stays append-only", async () => {
      const database = await scenarioDatabase();
      const first = await as(database, 1);
      const replay = await as(database, 1);
      const owner = await connect(database);
      try {
        await first.query(REPLACE, replacement("cs_test_once"));
        expect(
          (await replay.query(REPLACE, replacement("cs_test_once"))).rows[0].v,
        ).toEqual({ ok: true, code: "ALREADY_REPLACED" });
        await expect(
          owner.query(
            "update public.commercial_v1_checkout_session_replacements set replacement_session_id='cs_test_x'",
          ),
        ).rejects.toThrow(
          "Checkout session replacement history is append-only",
        );
        await expect(
          owner.query(
            "delete from public.commercial_v1_checkout_session_replacements",
          ),
        ).rejects.toThrow(
          "Checkout session replacement history is append-only",
        );
        expect((await facts(database)).history).toHaveLength(1);
      } finally {
        await Promise.all([first.end(), replay.end(), owner.end()]);
      }
    }, 120000);
  },
);
