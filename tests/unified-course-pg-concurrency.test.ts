import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseStatements } from "./db-helper";
import {
  approvedTestPackage,
  people,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";

// Real independent PostgreSQL sessions, never PGlite Promise.all. This suite
// is restricted to a disposable LOCAL server (including CI's service).
const endpoint = process.env.DUCELIO_TEST_POSTGRES_URL;
if (process.env.DUCELIO_REQUIRE_PG_CONCURRENCY === "1" && !endpoint)
  throw new Error("Disposable PostgreSQL is required but not configured");
if (
  endpoint &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname)
)
  throw new Error(
    "Unified races require a disposable LOCAL PostgreSQL server; hosted targets are refused",
  );
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const template = `ducelio_unified_template_${suffix}`;
const created: string[] = [];
let freeCoupon: string, halfCoupon: string, packageId: string;
const reason = "Synthetic real PostgreSQL race fixture";
async function connect(database: string) {
  const url = new URL(endpoint!);
  url.pathname = "/" + database;
  const client = new pg.Client({ connectionString: url.toString() });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function query(database: string, sql: string, args: unknown[] = []) {
  const c = await connect(database);
  try {
    return (await c.query(sql, args)).rows;
  } finally {
    await c.end();
  }
}
async function clone() {
  const name = `ducelio_unified_s${created.length}_${suffix}`;
  const c = await connect("postgres");
  try {
    await c.query(`create database ${name} template ${template}`);
    created.push(name);
    return name;
  } finally {
    await c.end();
  }
}
async function call(
  database: string,
  auth: string,
  sql: string,
  args: unknown[],
) {
  const c = await connect(database);
  try {
    await c.query("select set_config('request.jwt.claim.sub',$1,false)", [
      auth,
    ]);
    await c.query("set role authenticated");
    return (await c.query(sql, args)).rows[0].r;
  } finally {
    await c.end();
  }
}
async function race(
  database: string,
  lock: string,
  args: unknown[],
  racers: (() => Promise<unknown>)[],
) {
  const holder = await connect(database);
  await holder.query("begin");
  await holder.query(lock, args);
  const pending = racers.map((r) =>
    r().then(
      (value) => ({ value, error: null }),
      () => ({ value: null, error: "Race RPC failed" }),
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
  expect(
    blocked,
    "both real database sessions must contend before release",
  ).toBe(true);
  for (const r of results) expect(r.error).toBeNull();
  return results.map((r) => r.value) as Record<string, unknown>[];
}
describe.skipIf(!endpoint)(
  "unified authority under actual PostgreSQL lock contention",
  () => {
    beforeAll(async () => {
      const admin = await connect("postgres");
      try {
        await admin.query(`create database ${template}`);
        created.push(template);
      } finally {
        await admin.end();
      }
      const db = await connect(template);
      try {
        for (const sql of await testDatabaseStatements({
          supabaseDefaultPrivileges: true,
        }))
          await db.query(sql);
        const q: Query = (sql, args) => db.query(sql, args);
        await seedPeople(q);
        const course = await publishUnifiedTestCourse(q, "unified-race-test");
        const expiry = new Date(Date.now() + 86400000).toISOString();
        freeCoupon = await rpc<string>(
          q,
          people.admin,
          "create_course_coupon",
          ["RACE-FREE", 100, expiry, 1, course.courseId, reason],
        );
        halfCoupon = await rpc<string>(
          q,
          people.admin,
          "create_course_coupon",
          ["RACE-HALF", 50, expiry, 1, course.courseId, reason],
        );
        const pkg = approvedTestPackage("unified-publish-race");
        pkg.course.demoContent = true;
        const checked = validateAcademyCoursePackage(pkg);
        if (!checked.valid) throw new Error("Invalid synthetic race fixture");
        packageId = await rpc<string>(
          q,
          people.admin,
          "upload_unified_course_package",
          [JSON.stringify(pkg), reason],
        );
        await rpc(q, people.admin, "mark_academy_course_package_validated", [
          packageId,
          JSON.stringify(checked.review),
          reason,
        ]);
      } finally {
        await db.end();
      }
    }, 180000);
    afterAll(async () => {
      if (!created.length) return;
      const c = await connect("postgres");
      try {
        for (const name of created.toReversed()) {
          if (
            !new RegExp(
              `^ducelio_unified_(?:template|s[0-9]+)_${suffix}$`,
            ).test(name)
          )
            throw new Error("Unsafe disposable database name");
          await c.query(`drop database if exists ${name} with (force)`);
        }
      } finally {
        await c.end();
      }
    }, 60000);
    it("publishes one package exactly once across two administrator sessions", async () => {
      const db = await clone();
      const sql = "select public.publish_unified_course($1,$2,$3,$4,$5,$6) r";
      const args = [
        packageId,
        "unified-publish-race",
        "GBP",
        1999,
        null,
        reason,
      ];
      const result = await race(
        db,
        "select id from public.academy_course_packages where id=$1 for update",
        [packageId],
        [
          () => call(db, people.admin.auth, sql, args),
          () => call(db, people.admin.auth, sql, args),
        ],
      );
      expect(new Set(result.map((r) => r.courseId)).size).toBe(1);
      expect(result.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(
        (
          await query(
            db,
            "select count(*)::int n from public.course_engine_publications where package_id=$1",
            [packageId],
          )
        )[0].n,
      ).toBe(1);
    });
    it("uses a last full-discount slot once across different learners", async () => {
      const db = await clone();
      const sql =
        "select public.create_unified_course_order('unified-race-test','RACE-FREE') r";
      const results = await race(
        db,
        "select id from public.course_engine_coupons where id=$1 for update",
        [freeCoupon],
        [
          () => call(db, people.learnerA.auth, sql, []),
          () => call(db, people.learnerB.auth, sql, []),
        ],
      );
      expect(results.filter((r) => r.ok === true)).toHaveLength(1);
      expect(
        results.filter((r) => r.code === "COUPON_UNAVAILABLE"),
      ).toHaveLength(1);
      expect(
        (
          await query(
            db,
            "select count(*)::int n from public.course_engine_coupon_redemptions where coupon_id=$1",
            [freeCoupon],
          )
        )[0].n,
      ).toBe(1);
    });
    it("reuses one discounted order and reservation across concurrent identical learner requests", async () => {
      const db = await clone();
      const sql =
        "select public.create_unified_course_order('unified-race-test','RACE-HALF') r";
      const results = await race(
        db,
        "select id from public.course_engine_coupons where id=$1 for update",
        [halfCoupon],
        [
          () => call(db, people.learnerA.auth, sql, []),
          () => call(db, people.learnerA.auth, sql, []),
        ],
      );
      expect(results.every((r) => r.ok === true)).toBe(true);
      expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
      expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
      expect(
        (
          await query(
            db,
            "select count(*)::int n from public.course_engine_coupon_redemptions where coupon_id=$1",
            [halfCoupon],
          )
        )[0].n,
      ).toBe(1);
    });
    it("reserves the last paid-discount slot once across different learners", async () => {
      const db = await clone();
      const sql =
        "select public.create_unified_course_order('unified-race-test','RACE-HALF') r";
      const results = await race(
        db,
        "select id from public.course_engine_coupons where id=$1 for update",
        [halfCoupon],
        [
          () => call(db, people.learnerA.auth, sql, []),
          () => call(db, people.learnerB.auth, sql, []),
        ],
      );
      expect(results.filter((r) => r.ok === true)).toHaveLength(1);
      expect(
        results.filter((r) => r.code === "COUPON_UNAVAILABLE"),
      ).toHaveLength(1);
      expect(
        (
          await query(
            db,
            "select count(*)::int n from public.course_engine_order_terms",
          )
        )[0].n,
      ).toBe(1);
    });
  },
);
