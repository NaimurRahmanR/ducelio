import { localPostgresDatabase } from "./local-postgres-database";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { as, people, rpc, seedPeople, type Query } from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";

let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>;
let q: Query;
const { admin, learnerA, learnerB, learnerC, instructor } = people;
const org = "00000000-0000-4000-8000-000000000001";
const reason = "Synthetic fixed-amount coupon test";
const expiry = new Date(Date.now() + 86400000).toISOString();
let standard: { courseId: string }, small: { courseId: string };
let dollars: { courseId: string };
type Order = {
  ok: boolean;
  code?: string;
  orderId?: string;
  amountMinor?: number;
  accessGranted?: boolean;
  enrolmentId?: string;
  reused?: boolean;
};
const buy = (
  who: typeof learnerA | typeof learnerB | typeof learnerC,
  slug: string,
  code: string | null,
) => rpc<Order>(q, who, "create_unified_course_order", [slug, code]);
const amountCoupon = (
  code: string,
  amount: number | null,
  currency: string | null,
  courseId: string | null = null,
  limit = 10,
  who: typeof admin | typeof learnerA | typeof instructor = admin,
) =>
  rpc<string>(q, who, "create_organisation_course_amount_coupon", [
    org,
    code,
    amount,
    currency,
    expiry,
    limit,
    courseId,
    reason,
  ]);
const redemptions = async (couponId: string) =>
  (
    await q(
      "select list_amount_minor, discount_amount_minor, order_id from public.course_engine_coupon_redemptions where coupon_id=$1",
      [couponId],
    )
  ).rows;

beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, params) => db.query(sql, params) as ReturnType<Query>;
  await seedPeople(q);
  standard = await publishUnifiedTestCourse(q, "fixed-coupon-standard");
  small = await publishUnifiedTestCourse(q, "fixed-coupon-small", 2000);
  dollars = await publishUnifiedTestCourse(
    q,
    "fixed-coupon-dollars",
    10001,
    "USD",
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});

describe("fixed-amount course coupons", () => {
  it("validates the single discount kind, currency and course currency", async () => {
    for (const [amount, currency, courseId] of [
      [0, "GBP", null],
      [100000001, "GBP", null],
      [500, "JPY", null],
      [500, null, null],
      [null, "GBP", null],
      [500, "USD", "standard"],
    ] as const)
      await expect(
        amountCoupon(
          "BAD-AMOUNT",
          amount,
          currency,
          courseId ? standard.courseId : null,
        ),
      ).rejects.toThrow("INVALID_INPUT");
    await expect(
      rpc(q, admin, "create_organisation_course_coupon", [
        org,
        "BAD-PERCENT",
        null,
        expiry,
        1,
        null,
        reason,
      ]),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      q(
        "insert into public.course_engine_coupons(code,percent_off,amount_off_minor,currency,expires_at,redemption_limit,created_by) values('BOTH-KINDS',10,500,'GBP',$1,1,$2)",
        [expiry, admin.id],
      ),
    ).rejects.toThrow(/course_engine_coupons_one_discount/);
  });

  it("is organisation-authorised, idempotent for identical terms and immutable", async () => {
    for (const who of [learnerA, instructor])
      await expect(
        amountCoupon("NOT-ALLOWED", 500, "GBP", null, 1, who),
      ).rejects.toThrow("FORBIDDEN");
    const id = await amountCoupon(
      "TWENTY-FIVE",
      2500,
      "GBP",
      standard.courseId,
    );
    expect(
      await amountCoupon("TWENTY-FIVE", 2500, "GBP", standard.courseId),
    ).toBe(id);
    await expect(
      amountCoupon("TWENTY-FIVE", 2400, "GBP", standard.courseId),
    ).rejects.toThrow("COUPON_CONFLICT");
    await expect(
      rpc(q, admin, "create_organisation_course_coupon", [
        org,
        "TWENTY-FIVE",
        25,
        expiry,
        10,
        standard.courseId,
        reason,
      ]),
    ).rejects.toThrow("COUPON_CONFLICT");
    await expect(
      q(
        "update public.course_engine_coupons set amount_off_minor=1 where id=$1",
        [id],
      ),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    const audit = (
      await q(
        "select after_state from public.audit_events where target_id=$1 and action='COURSE_COUPON_CREATED'",
        [id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after_state).toMatchObject({
      amount_off_minor: 2500,
      currency: "GBP",
    });
    expect(audit[0].after_state).not.toHaveProperty("percent_off");
    const listed = (
      await rpc<Record<string, unknown>[]>(q, admin, "list_course_coupons")
    ).find((c) => c.id === id);
    expect(listed).toMatchObject({
      percentOff: null,
      amountOffMinor: 2500,
      currency: "GBP",
    });
    for (const who of [null, learnerA])
      await expect(
        as(q, who, "select * from public.course_engine_coupons"),
      ).rejects.toThrow(/permission denied/);
  });

  it("discounts the backend price by the fixed amount and reserves one use", async () => {
    const id = (
      await rpc<{ id: string; code: string }[]>(q, admin, "list_course_coupons")
    ).find((c) => c.code === "TWENTY-FIVE")!.id;
    const order = await buy(learnerA, "fixed-coupon-standard", "twenty-five");
    expect(order).toMatchObject({
      ok: true,
      accessGranted: false,
      amountMinor: 7501,
      reused: false,
    });
    expect(
      await buy(learnerA, "fixed-coupon-standard", "TWENTY-FIVE"),
    ).toMatchObject({
      orderId: order.orderId,
      reused: true,
      amountMinor: 7501,
    });
    expect(await redemptions(id)).toEqual([
      {
        list_amount_minor: 10001,
        discount_amount_minor: 2500,
        order_id: order.orderId,
      },
    ]);
    expect(
      (
        await q(
          "select amount_minor, currency from public.academy_orders where id=$1",
          [order.orderId],
        )
      ).rows[0],
    ).toEqual({ amount_minor: 7501, currency: "GBP" });
  });

  it("grants access without payment when the fixed amount covers the price", async () => {
    const id = await amountCoupon("COVERS-ALL", 5000, "GBP", small.courseId);
    const access = await buy(learnerA, "fixed-coupon-small", "COVERS-ALL");
    expect(access).toMatchObject({ ok: true, accessGranted: true });
    expect(await redemptions(id)).toEqual([
      { list_amount_minor: 2000, discount_amount_minor: 2000, order_id: null },
    ]);
    expect(
      (
        await q(
          "select source from public.academy_entitlements where learner_id=$1 and course_id=$2",
          [learnerA.id, small.courseId],
        )
      ).rows,
    ).toEqual([{ source: "COUPON" }]);
  });

  it("refuses a partial discount below the minimum card charge before reserving", async () => {
    const fixed = await amountCoupon("LEAVES-PENNIES", 1990, "GBP");
    await rpc(q, admin, "create_organisation_course_coupon", [
      org,
      "NINETY-NINE",
      99,
      expiry,
      10,
      small.courseId,
      reason,
    ]);
    expect(await buy(learnerB, "fixed-coupon-small", "LEAVES-PENNIES")).toEqual(
      { ok: false, code: "COUPON_BELOW_MINIMUM_CHARGE" },
    );
    expect(await buy(learnerB, "fixed-coupon-small", "NINETY-NINE")).toEqual({
      ok: false,
      code: "COUPON_BELOW_MINIMUM_CHARGE",
    });
    expect(await redemptions(fixed)).toEqual([]);
    // Exactly the minimum is chargeable.
    await amountCoupon("LEAVES-MINIMUM", 1970, "GBP");
    expect(
      await buy(learnerB, "fixed-coupon-small", "LEAVES-MINIMUM"),
    ).toMatchObject({ ok: true, accessGranted: false, amountMinor: 30 });
  });

  it("applies an organisation-wide fixed coupon only in its own currency", async () => {
    const pounds = await amountCoupon("POUNDS-ONLY", 1000, "GBP");
    expect(await buy(learnerC, "fixed-coupon-dollars", "POUNDS-ONLY")).toEqual({
      ok: false,
      code: "COUPON_UNAVAILABLE",
    });
    expect(await redemptions(pounds)).toEqual([]);
    await amountCoupon("DOLLARS-OFF", 1000, "USD");
    expect(
      await buy(learnerC, "fixed-coupon-dollars", "DOLLARS-OFF"),
    ).toMatchObject({ ok: true, amountMinor: 9001 });
    expect(
      (
        await q(
          "select currency from public.academy_orders where learner_id=$1 and course_id=$2",
          [learnerC.id, dollars.courseId],
        )
      ).rows,
    ).toEqual([{ currency: "USD" }]);
  });

  it("keeps the redemption limit for fixed coupons", async () => {
    await amountCoupon("ONE-FIXED", 1000, "GBP", standard.courseId, 1);
    expect(
      await buy(learnerB, "fixed-coupon-standard", "ONE-FIXED"),
    ).toMatchObject({ ok: true, amountMinor: 9001 });
    expect(await buy(learnerC, "fixed-coupon-standard", "ONE-FIXED")).toEqual({
      ok: false,
      code: "COUPON_UNAVAILABLE",
    });
  });
});
