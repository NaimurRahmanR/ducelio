import { localPostgresDatabase } from "./local-postgres-database";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { people, rpc, seedPeople, type Query } from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";

let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>;
let q: Query;
let course: Awaited<ReturnType<typeof publishUnifiedTestCourse>>;
const keyId = randomUUID(),
  secret = randomBytes(32);
const { admin, learnerA, learnerB, learnerC, instructor, registrar } = people;
const reason = "Synthetic coupon acceptance test";
const expiry = new Date(Date.now() + 86400000).toISOString();
type Order = {
  ok: boolean;
  code?: string;
  orderId: string;
  amountMinor: number;
  enrolmentId: string;
  accessGranted: boolean;
  reused: boolean;
  formatId: null;
};
const buy = (
  who: typeof learnerA | typeof learnerB | typeof learnerC,
  code: string | null = null,
  slug = "unified-commerce-test",
) => rpc<Order>(q, who, "create_unified_course_order", [slug, code]);
const coupon = (
  code: string,
  percent = 50,
  limit = 10,
  courseId: string | null = null,
) =>
  rpc<string>(q, admin, "create_course_coupon", [
    code,
    percent,
    expiry,
    limit,
    courseId,
    reason,
  ]);
function signed(
  orderId: string,
  amount: number,
  status = "PAID",
  session = "cs_unified_test",
  event = "evt_unified_test",
) {
  const issued = Math.floor(Date.now() / 1000),
    expires = issued + 60;
  const canonical = [
    "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1",
    "ACADEMY_COMMERCE_V1",
    keyId,
    "STRIPE",
    orderId,
    session,
    event,
    String(amount),
    "GBP",
    status,
    String(issued),
    String(expires),
  ].join("\n");
  return [
    keyId,
    orderId,
    "STRIPE",
    session,
    event,
    amount,
    "GBP",
    status,
    issued,
    expires,
    createHmac("sha256", secret).update(canonical).digest("hex"),
  ];
}
beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, params) => db.query(sql, params) as ReturnType<Query>;
  await seedPeople(q);
  await q(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, secret],
  );
  course = await publishUnifiedTestCourse(q, "unified-commerce-test");
}, 180000);
afterAll(async () => {
  await db?.close();
});
describe("unified course commerce on the real signed payment authority", () => {
  let discounted: Order;
  it("creates a normal one-price order with no purchased duration", async () => {
    const o = await buy(learnerA);
    expect(o).toMatchObject({
      ok: true,
      accessGranted: false,
      amountMinor: 10001,
      formatId: null,
      reused: false,
    });
    expect(await buy(learnerA)).toMatchObject({
      orderId: o.orderId,
      reused: true,
      amountMinor: 10001,
    });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_entitlements where learner_id=$1",
          [learnerA.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("calculates discounts in the backend and reserves one slot on identical replay", async () => {
    await coupon("HALF-TEST", 50, 1, course.courseId);
    discounted = await buy(learnerB, "half-test");
    expect(discounted).toMatchObject({
      ok: true,
      amountMinor: 5001,
      formatId: null,
    });
    expect(await buy(learnerB, "HALF-TEST")).toMatchObject({
      orderId: discounted.orderId,
      reused: true,
    });
    expect(await buy(learnerC, "HALF-TEST")).toMatchObject({
      ok: false,
      code: "COUPON_UNAVAILABLE",
    });
    expect(await buy(learnerB)).toMatchObject({
      ok: false,
      code: "CHECKOUT_TERMS_LOCKED",
    });
    const rows = await rpc<
      { code: string; reserved: number; redeemed: number }[]
    >(q, admin, "list_course_coupons");
    expect(rows.find((c) => c.code === "HALF-TEST")).toMatchObject({
      reserved: 1,
      redeemed: 0,
    });
  });
  it("refuses an unsigned or wrong-price payment without access", async () => {
    const args = signed(discounted.orderId, discounted.amountMinor);
    args[args.length - 1] = "0".repeat(64);
    expect(await rpc(q, null, "fulfill_academy_order", args)).toMatchObject({
      ok: false,
      code: "UNTRUSTED_CLAIM",
    });
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        signed(discounted.orderId, 1),
      ),
    ).toMatchObject({ ok: false, code: "MISMATCHED_AMOUNT" });
    expect(
      (
        await q(
          "select provider_session_id from public.academy_orders where id=$1",
          [discounted.orderId],
        )
      ).rows[0].provider_session_id,
    ).toBeNull();
  });
  it("fulfils a discounted verified payment exactly once and leaves timetable activation to the learner", async () => {
    const args = signed(discounted.orderId, discounted.amountMinor);
    expect(await rpc(q, null, "fulfill_academy_order", args)).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: false,
    });
    expect(await rpc(q, null, "fulfill_academy_order", args)).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: true,
    });
    const ent = (
      await q(
        "select e.id,e.format_id,n.format_id chosen,(select count(*)::int from public.academy_schedules s where s.enrolment_id=n.id) schedules from public.academy_entitlements e join public.academy_enrolments n on n.entitlement_id=e.id where e.order_id=$1",
        [discounted.orderId],
      )
    ).rows;
    expect(ent).toHaveLength(1);
    expect(ent[0]).toMatchObject({
      format_id: null,
      chosen: null,
      schedules: 0,
    });
    const report = await rpc<
      { code: string; reserved: number; redeemed: number }[]
    >(q, admin, "list_course_coupons");
    expect(report.find((c) => c.code === "HALF-TEST")).toMatchObject({
      reserved: 0,
      redeemed: 1,
    });
  });
  it("grants a 100% coupon without a payment order, Stripe event, or timetable, and replays the same access", async () => {
    const id = await coupon("FULL-TEST", 100, 1, course.courseId);
    const before = (
      await q(
        "select (select count(*) from public.academy_orders)::int orders,(select count(*) from public.academy_payment_events)::int events",
      )
    ).rows;
    const free = await buy(learnerC, "FULL-TEST");
    expect(free).toMatchObject({
      ok: true,
      accessGranted: true,
      reused: false,
    });
    expect(await buy(learnerC, "FULL-TEST")).toMatchObject({
      ok: true,
      enrolmentId: free.enrolmentId,
      reused: true,
    });
    expect(
      (
        await q(
          "select (select count(*) from public.academy_orders)::int orders,(select count(*) from public.academy_payment_events)::int events",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await q("select format_id from public.academy_enrolments where id=$1", [
          free.enrolmentId,
        ])
      ).rows[0].format_id,
    ).toBeNull();
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_schedules where enrolment_id=$1",
          [free.enrolmentId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      await rpc(q, admin, "get_course_coupon_redemptions", [id]),
    ).toMatchObject([
      { learnerId: learnerC.id, state: "REDEEMED", orderId: null },
    ]);
  });
  it("does not retarget, edit or delete an issued coupon; availability changes are audited", async () => {
    const id = await coupon("TOGGLE-TEST");
    expect(await coupon("toggle-test")).toBe(id);
    await expect(coupon("TOGGLE-TEST", 60)).rejects.toThrow("COUPON_CONFLICT");
    await expect(
      q("update public.course_engine_coupons set percent_off=100 where id=$1", [
        id,
      ]),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await expect(
      q("delete from public.course_engine_coupons where id=$1", [id]),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await rpc(q, admin, "set_course_coupon_active", [id, false, reason]);
    const other = await publishUnifiedTestCourse(q, "unified-other-test");
    expect(
      await buy(learnerA, "TOGGLE-TEST", "unified-other-test"),
    ).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });
    await rpc(q, admin, "set_course_coupon_active", [id, true, reason]);
    expect(
      await buy(learnerA, "TOGGLE-TEST", "unified-other-test"),
    ).toMatchObject({ ok: true, amountMinor: 5001 });
    expect(other.courseId).not.toBe(course.courseId);
  });
  it("enforces course restrictions, expiry, revoked access and ownership", async () => {
    await coupon("RESTRICT-TEST", 100, 10, course.courseId);
    expect(
      await buy(learnerC, "RESTRICT-TEST", "unified-other-test"),
    ).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });
    await expect(
      rpc(q, admin, "create_course_coupon", [
        "EXPIRED-TEST",
        100,
        "2020-01-01",
        1,
        null,
        reason,
      ]),
    ).rejects.toThrow("INVALID_INPUT");
    const held = await buy(learnerC);
    expect(held.accessGranted).toBe(true);
    const ent = (
      await q(
        "select id from public.academy_entitlements where learner_id=$1 and course_id=$2",
        [learnerC.id, course.courseId],
      )
    ).rows[0].id;
    await rpc(q, admin, "admin_revoke_academy_entitlement", [ent, reason]);
    expect(await buy(learnerC, "FULL-TEST")).toMatchObject({
      ok: false,
      code: "ACCESS_REVOKED",
    });
    for (const who of [instructor, registrar, learnerA]) {
      await expect(
        rpc(q, who, "create_course_coupon", [
          "FORGED-TEST",
          100,
          expiry,
          1,
          null,
          reason,
        ]),
      ).rejects.toThrow("FORBIDDEN");
      await expect(rpc(q, who, "list_course_coupons")).rejects.toThrow(
        "FORBIDDEN",
      );
    }
    await expect(
      rpc(q, null, "create_unified_course_order", [
        "unified-commerce-test",
        null,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
  it("closes direct coupon, redemption and order-term table access even under broad hosted defaults", async () => {
    for (const table of [
      "course_engine_coupons",
      "course_engine_coupon_redemptions",
      "course_engine_order_terms",
    ])
      for (const role of ["anon", "authenticated", "service_role"])
        expect(
          (
            await q(
              "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p,has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') c",
              [role, `public.${table}`],
            )
          ).rows[0],
        ).toEqual({ p: false, c: false });
  });
});

it("refuses reusing one verified provider event for a different order without binding or granting it", async () => {
  const c = await publishUnifiedTestCourse(q, "unified-payment-event-test");
  const a = await buy(learnerA, null, "unified-payment-event-test"),
    b = await buy(learnerB, null, "unified-payment-event-test");
  expect(
    await rpc(
      q,
      null,
      "fulfill_academy_order",
      signed(
        a.orderId,
        a.amountMinor,
        "PAID",
        "cs_event_owner_one",
        "evt_one_payment_fact",
      ),
    ),
  ).toMatchObject({ ok: true, fulfilled: true });
  expect(
    await rpc(
      q,
      null,
      "fulfill_academy_order",
      signed(
        b.orderId,
        b.amountMinor,
        "PAID",
        "cs_event_owner_two",
        "evt_one_payment_fact",
      ),
    ),
  ).toMatchObject({ ok: false, code: "PAYMENT_EVENT_CONFLICT" });
  expect(
    (
      await q(
        "select provider_session_id from public.academy_orders where id=$1",
        [b.orderId],
      )
    ).rows[0].provider_session_id,
  ).toBeNull();
  expect(
    (
      await q(
        "select count(*)::int n from public.academy_entitlements where learner_id=$1 and course_id=$2",
        [learnerB.id, c.courseId],
      )
    ).rows[0].n,
  ).toBe(0);
});

describe("verified abandoned checkout and coupon release", () => {
  let pending: Order;
  const slug = "unified-cancellation-test",
    session = "cs_cancelled_synthetic";
  function operation(overrides: Record<string, unknown> = {}) {
    const payload = JSON.stringify({
      kind: "CANCEL_UNIFIED_CHECKOUT",
      learnerId: learnerA.id,
      orderId: pending.orderId,
      sessionId: session,
      amountMinor: pending.amountMinor,
      currency: "GBP",
      sessionStatus: "EXPIRED",
      paymentStatus: "UNPAID",
      ...overrides,
    });
    const issued = Math.floor(Date.now() / 1000),
      expires = issued + 60;
    const mac = createHmac("sha256", secret)
      .update(
        [
          "DUCELIO_ACADEMY_COMMERCE_OPERATIONS_HMAC_SHA256_V1",
          keyId,
          payload,
          String(issued),
          String(expires),
        ].join("\n"),
      )
      .digest("hex");
    return [keyId, payload, issued, expires, mac];
  }
  it("retains reservations on unsigned, foreign, payable or mismatched cancellation claims", async () => {
    const c = await publishUnifiedTestCourse(q, slug);
    await coupon("CANCEL-HALF", 50, 1, c.courseId);
    pending = await buy(learnerA, "CANCEL-HALF", slug);
    await rpc(q, learnerA, "attach_academy_checkout_session", [
      pending.orderId,
      session,
    ]);
    const bad = operation();
    bad[4] = "0".repeat(64);
    await expect(
      rpc(q, learnerA, "apply_academy_commerce_operation", bad),
    ).rejects.toThrow("UNTRUSTED_CLAIM");
    expect(
      await rpc(q, learnerB, "apply_academy_commerce_operation", operation()),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    for (const overrides of [
      { sessionStatus: "OPEN" },
      { paymentStatus: "PAID" },
      { sessionId: "cs_other_synthetic" },
      { amountMinor: 1 },
      { currency: "USD" },
    ])
      expect(
        await rpc(
          q,
          learnerA,
          "apply_academy_commerce_operation",
          operation(overrides),
        ),
      ).toMatchObject({ ok: false, code: "CANCELLATION_MISMATCH" });
    expect(await buy(learnerB, "CANCEL-HALF", slug)).toMatchObject({
      ok: false,
      code: "COUPON_UNAVAILABLE",
    });
  });
  it("cancels atomically, replays once and preserves immutable release evidence", async () => {
    expect(
      await rpc(q, learnerA, "apply_academy_commerce_operation", operation()),
    ).toMatchObject({ ok: true, code: "CANCELLED" });
    expect(
      await rpc(q, learnerA, "apply_academy_commerce_operation", operation()),
    ).toMatchObject({ ok: true, code: "ALREADY_CANCELLED" });
    expect(
      (
        await q("select state from public.academy_orders where id=$1", [
          pending.orderId,
        ])
      ).rows[0].state,
    ).toBe("CANCELLED");
    await expect(
      q("delete from public.course_engine_checkout_cancellations"),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await expect(
      q("update public.academy_orders set state='PENDING' where id=$1", [
        pending.orderId,
      ]),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
  });
  it("allows a fresh reservation while retaining the released commercial record", async () => {
    const next = await buy(learnerA, "CANCEL-HALF", slug);
    expect(next.ok).toBe(true);
    expect(next.orderId).not.toBe(pending.orderId);
    expect(await buy(learnerB, "CANCEL-HALF", slug)).toMatchObject({
      ok: false,
      code: "COUPON_UNAVAILABLE",
    });
    const couponId = (
      await q(
        "select id from public.course_engine_coupons where code='CANCEL-HALF'",
      )
    ).rows[0].id;
    const reports = await rpc<{ state: string }[]>(
      q,
      admin,
      "get_course_coupon_redemptions",
      [couponId],
    );
    expect(reports.map((r) => r.state).sort()).toEqual([
      "RELEASED",
      "RESERVED",
    ]);
    const orders = await rpc<{ id: string; state: string }[]>(
      q,
      learnerA,
      "list_my_unified_course_orders",
    );
    expect(orders.find((o) => o.id === pending.orderId)?.state).toBe(
      "CANCELLED",
    );
    expect(
      (
        await rpc<{ id: string }[]>(
          q,
          learnerB,
          "list_my_unified_course_orders",
        )
      ).some((o) => o.id === pending.orderId),
    ).toBe(false);
  });
  it("never grants access from a cancelled order, retaining late payment evidence for reconciliation", async () => {
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        signed(
          pending.orderId,
          pending.amountMinor,
          "PAID",
          session,
          "evt_cancelled_payment_synthetic",
        ),
      ),
    ).toMatchObject({ ok: false, code: "CANCELLED_PAYMENT_REVIEW" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_entitlements where order_id=$1",
          [pending.orderId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_payment_events where order_id=$1 and status='PAID'",
          [pending.orderId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
