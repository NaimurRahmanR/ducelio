import type { PGlite } from "@electric-sql/pglite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { localPostgresDatabase } from "./local-postgres-database";
import {
  approvedTestPackage,
  as,
  people,
  publishAcademyCourse,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";
import { sarahCommercialContextResultSchema } from "@/domain/sarah-course-guidance";
let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>,
  q: Query,
  oldOffer: string,
  oldOrder: string,
  oldCourse: string;
const keyId = randomUUID(),
  secret = randomBytes(32),
  reason = "TEST ONLY legacy retirement migration rehearsal";
let usersBefore: number, auditsBefore: number;
beforeAll(async () => {
  // Build genuine historical evidence BEFORE cutover, then exercise the
  // current migration. No trigger is disabled or production data touched.
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase({ throughMigration: 72 })
    : await testDatabase({
        throughMigration: 72,
        supabaseDefaultPrivileges: true,
      });
  q = (sql, args) => db.query(sql, args) as ReturnType<Query>;
  await seedPeople(q);
  await q(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, secret],
  );
  const raw = approvedTestPackage("retired-historical-test");
  raw.course.demoContent = true;
  const c = await publishAcademyCourse(q, "retired-historical-test", raw);
  oldOffer = c.offerId;
  oldCourse = c.courseId;
  await rpc(q, people.admin, "enable_academy_public_sale", [
    oldOffer,
    true,
    reason,
  ]);
  const order = await rpc<{ orderId: string }>(
    q,
    people.learnerA,
    "create_academy_order",
    ["retired-historical-test", "EXTENDED_8W"],
  );
  oldOrder = order.orderId;
  usersBefore = Number(
    (await q("select count(*) n from public.app_users")).rows[0].n,
  );
  auditsBefore = Number(
    (await q("select count(*) n from public.audit_events")).rows[0].n,
  );
  await db.exec(
    await readFile(
      "supabase/migrations/202611030073_unified_legacy_retirement.sql",
      "utf8",
    ),
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});
it("starts the unified catalogue empty while preserving accounts, pending orders and audit history", async () => {
  expect(await rpc(q, null, "list_unified_course_catalogue")).toEqual([]);
  expect(await rpc(q, null, "list_academy_catalogue")).toEqual([]);
  expect(await rpc(q, null, "list_commercial_v1_offers")).toEqual([]);
  expect(
    Number((await q("select count(*) n from public.app_users")).rows[0].n),
  ).toBe(usersBefore);
  expect(
    Number((await q("select count(*) n from public.audit_events")).rows[0].n),
  ).toBe(auditsBefore);
  expect(
    (await q("select state from public.academy_orders where id=$1", [oldOrder]))
      .rows[0].state,
  ).toBe("PENDING");
});
it("refuses new duration-priced orders but preserves recovery of an already pending order", async () => {
  expect(
    await rpc(q, people.learnerB, "create_academy_order", [
      "retired-historical-test",
      "EXTENDED_8W",
    ]),
  ).toMatchObject({ ok: false, code: "SALE_NOT_OPEN" });
  expect(
    await rpc(q, people.learnerA, "create_academy_order", [
      "retired-historical-test",
      "EXTENDED_8W",
    ]),
  ).toMatchObject({ ok: true, orderId: oldOrder, reused: true });
  await expect(
    rpc(q, people.admin, "enable_academy_public_sale", [
      oldOffer,
      true,
      reason,
    ]),
  ).rejects.toThrow("LEGACY_WORKFLOW_RETIRED");
  expect(
    (
      await q(
        "select count(*)::int n from public.academy_orders where course_id=$1",
        [oldCourse],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("closes all old cohort publication and campaign overloads", async () => {
  for (const name of [
    "publish_commercial_v1_offer",
    "create_commercial_v1_campaign",
    "redeem_commercial_v1_campaign",
  ]) {
    const signatures = await q(
      "select array(select format_type(t,null) from unnest(proargtypes) t) types from pg_proc where pronamespace='public'::regnamespace and proname=$1",
      [name],
    );
    expect(signatures.rows.length).toBeGreaterThan(0);
    for (const row of signatures.rows)
      await expect(
        as(
          q,
          people.admin,
          `select public.${name}(${(row.types as string[]).map((t) => `null::${t}`).join(",")})`,
        ),
      ).rejects.toThrow("LEGACY_WORKFLOW_RETIRED");
  }
  expect(
    await rpc(q, people.learnerB, "get_commercial_v1_offer", [
      "retired-historical-test",
    ]),
  ).toMatchObject({ ok: false, code: "NOT_FOUND" });
});
it("still verifies and fulfils a historical payment without rewriting its purchased format", async () => {
  const row = (
    await q(
      "select amount_minor,currency from public.academy_orders where id=$1",
      [oldOrder],
    )
  ).rows[0];
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60,
    session = "cs_historical_retirement_test",
    event = "evt_historical_retirement_test";
  const fields = [
    "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1",
    "ACADEMY_COMMERCE_V1",
    keyId,
    "STRIPE",
    oldOrder,
    session,
    event,
    String(row.amount_minor),
    String(row.currency),
    "PAID",
    String(issued),
    String(expires),
  ];
  const mac = createHmac("sha256", secret)
    .update(fields.join("\n"))
    .digest("hex");
  const result = await rpc(q, null, "fulfill_academy_order", [
    keyId,
    oldOrder,
    "STRIPE",
    session,
    event,
    row.amount_minor,
    row.currency,
    "PAID",
    issued,
    expires,
    mac,
  ]);
  expect(result).toMatchObject({ ok: true, fulfilled: true, replay: false });
  expect(
    (
      await q(
        "select format_id from public.academy_entitlements where order_id=$1",
        [oldOrder],
      )
    ).rows[0].format_id,
  ).toBe("EXTENDED_8W");
});
it("publishes and sells a new course through the sole catalogue, with truthful personal-timetable guidance", async () => {
  const c = await publishUnifiedTestCourse(q, "unified-retirement-new-test");
  const catalogue = await rpc<{ slug: string }[]>(
    q,
    null,
    "list_unified_course_catalogue",
  );
  expect(catalogue.map((c) => c.slug)).toEqual(["unified-retirement-new-test"]);
  expect(await rpc(q, null, "list_academy_catalogue")).toEqual(catalogue);
  const context = sarahCommercialContextResultSchema.parse(
    await rpc(q, people.learnerB, "get_my_sarah_commercial_context"),
  );
  expect(context.ok).toBe(true);
  if (!context.ok) throw new Error("Context refused");
  expect(context.offers).toHaveLength(1);
  expect(context.offers[0]).toMatchObject({
    slug: "unified-retirement-new-test",
    deliveryPlan: null,
    cohortStartsOn: null,
    availableDurationsWeeks: [2, 4, 6, 8, 12],
    newPurchaseAvailable: true,
  });
  await rpc(q, people.admin, "create_course_coupon", [
    "RETIREMENT-FREE",
    100,
    new Date(Date.now() + 86400000).toISOString(),
    1,
    c.courseId,
    reason,
  ]);
  expect(
    await rpc(q, people.learnerB, "create_unified_course_order", [
      "unified-retirement-new-test",
      "RETIREMENT-FREE",
    ]),
  ).toMatchObject({ ok: true, accessGranted: true });
  expect(
    await rpc(q, people.learnerB, "get_my_sarah_commercial_context"),
  ).toMatchObject({ ok: false, code: "NOT_AVAILABLE_IN_MODE" });
  expect(
    (
      await q(
        "select count(*)::int n from public.academy_schedules s join public.academy_enrolments e on e.id=s.enrolment_id where e.course_id=$1",
        [c.courseId],
      )
    ).rows[0].n,
  ).toBe(0);
});
