// Historical creation protocol through 072. Current cutover and retained-order
// verification run in unified-legacy-retirement-db.test.ts against 073.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  academyPackage,
  people,
  publishAcademyCourse,
  releaseNow,
  rpc,
  seedPeople,
  type Query,
} from "./academy-fixture";

// Migration 061 Academy checkout on the existing commerce controller keys:
// learner-owned orders at the approved per-format price, HMAC-attested
// fulfilment (purpose-separated from cohort claims), purchased-format
// persistence, verified-refund revocation and expired-session replacement.
let db: PGlite;
let q: Query;
let offerSlug: string;
let prices: { formatId: string; amountMinor: number }[];
const keyId = randomUUID();
const key = randomBytes(32);
const { learnerA, learnerB, learnerC, admin } = people;
const now = () => Math.floor(Date.now() / 1000);

function fulfilArgs(
  o: {
    orderId: string;
    sessionId: string;
    eventId: string;
    amount: number;
    currency: string;
    status?: string;
  },
  purpose = "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1",
) {
  const iat = now();
  const exp = iat + 60;
  const status = o.status ?? "PAID";
  const canonical = [
    purpose,
    "ACADEMY_COMMERCE_V1",
    keyId,
    "STRIPE",
    o.orderId,
    o.sessionId,
    o.eventId,
    String(o.amount),
    o.currency,
    status,
    String(iat),
    String(exp),
  ].join("\n");
  const mac = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  return [
    keyId,
    o.orderId,
    "STRIPE",
    o.sessionId,
    o.eventId,
    o.amount,
    o.currency,
    status,
    iat,
    exp,
    mac,
  ];
}
function operation(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const iat = now();
  const exp = iat + 30;
  const mac = createHmac("sha256", key)
    .update(
      [
        "DUCELIO_ACADEMY_COMMERCE_OPERATIONS_HMAC_SHA256_V1",
        keyId,
        body,
        String(iat),
        String(exp),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  return [keyId, body, iat, exp, mac];
}
type Order = {
  ok: boolean;
  code?: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  formatId: string;
  reused: boolean;
};
type Fulfilled = {
  ok: boolean;
  code?: string;
  fulfilled?: boolean;
  replay?: boolean;
  enrolmentId?: string;
  entitlementId?: string;
};

beforeAll(async () => {
  db = await testDatabase({ throughMigration: 72 });
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  await q(
    "select commercial_v1_commerce_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  const course = await publishAcademyCourse(
    q,
    "academy-commerce-test",
    approvedTestPackage(),
  );
  offerSlug = "academy-commerce-test";
  prices = course.prices;
  await rpc(q, admin, "enable_academy_public_sale", [
    course.offerId,
    true,
    "Owner approved test policy",
  ]);
  // A second, review-only course built from the real artefact.
  await publishAcademyCourse(q, "academy-review-only", academyPackage());
}, 240000);
afterAll(async () => {
  await db?.close();
});

describe("Academy checkout", () => {
  let order: Order;
  const sessionId = "cs_test_academy_1";

  it("snapshots the approved price of the chosen format and reuses a pending order", async () => {
    order = await rpc<Order>(q, learnerA, "create_academy_order", [
      offerSlug,
      "STANDARD_6W",
    ]);
    const price = prices.find((p) => p.formatId === "STANDARD_6W")!;
    expect(order).toMatchObject({
      ok: true,
      amountMinor: price.amountMinor,
      currency: "GBP",
      formatId: "STANDARD_6W",
      reused: false,
    });
    expect(
      await rpc(q, learnerA, "create_academy_order", [
        offerSlug,
        "STANDARD_6W",
      ]),
    ).toMatchObject({ orderId: order.orderId, reused: true });
    expect(
      await rpc(q, learnerA, "create_academy_order", [offerSlug, "WEEKEND_1W"]),
    ).toMatchObject({ ok: false, code: "INVALID_FORMAT" });
    expect(
      await rpc(q, learnerA, "create_academy_order", [
        "academy-review-only",
        "STANDARD_6W",
      ]),
    ).toMatchObject({ ok: false, code: "SALE_NOT_OPEN" });
    await expect(
      rpc(q, null, "create_academy_order", [offerSlug, "STANDARD_6W"]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rpc(q, admin, "create_academy_order", [offerSlug, "STANDARD_6W"]),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(
      await rpc(q, learnerB, "get_my_academy_order", [order.orderId]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("binds one checkout session to the order", async () => {
    expect(
      await rpc(q, learnerA, "attach_academy_checkout_session", [
        order.orderId,
        sessionId,
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await rpc(q, learnerA, "attach_academy_checkout_session", [
        order.orderId,
        "cs_test_other",
      ]),
    ).toMatchObject({ ok: false, code: "SESSION_ALREADY_BOUND" });
    expect(
      await rpc(q, learnerB, "attach_academy_checkout_session", [
        order.orderId,
        sessionId,
      ]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("refuses untrusted, mismatched and unpaid claims without granting access", async () => {
    const good = {
      orderId: order.orderId,
      sessionId,
      eventId: "evt_1",
      amount: order.amountMinor,
      currency: "GBP",
    };
    const forged = fulfilArgs(good);
    forged[10] = "0".repeat(64);
    expect(await rpc(q, null, "fulfill_academy_order", forged)).toMatchObject({
      ok: false,
      code: "UNTRUSTED_CLAIM",
    });
    // A cohort-purpose claim never fulfils an Academy order.
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        fulfilArgs(good, "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1"),
      ),
    ).toMatchObject({ code: "UNTRUSTED_CLAIM" });
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        fulfilArgs({ ...good, amount: 1 }),
      ),
    ).toMatchObject({ ok: false, code: "MISMATCHED_AMOUNT" });
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        fulfilArgs({ ...good, sessionId: "cs_test_x" }),
      ),
    ).toMatchObject({ ok: false, code: "MISMATCHED_SESSION" });
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        fulfilArgs({ ...good, status: "UNPAID" }),
      ),
    ).toMatchObject({ ok: true, fulfilled: false, code: "NOT_PAID" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_entitlements where learner_id=$1",
          [learnerA.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("fulfils a verified payment exactly once, persisting the purchased format", async () => {
    const good = {
      orderId: order.orderId,
      sessionId,
      eventId: "evt_2",
      amount: order.amountMinor,
      currency: "GBP",
    };
    const first = await rpc<Fulfilled>(
      q,
      null,
      "fulfill_academy_order",
      fulfilArgs(good),
    );
    expect(first).toMatchObject({ ok: true, fulfilled: true, replay: false });
    const replay = await rpc<Fulfilled>(
      q,
      null,
      "fulfill_academy_order",
      fulfilArgs({ ...good, eventId: "SESSION_VERIFY:" + sessionId }),
    );
    expect(replay).toMatchObject({
      ok: true,
      fulfilled: true,
      replay: true,
      enrolmentId: first.enrolmentId,
    });
    const ent = (
      await q(
        "select source, format_id, state from public.academy_entitlements where learner_id=$1",
        [learnerA.id],
      )
    ).rows;
    expect(ent).toEqual([
      { source: "PURCHASE", format_id: "STANDARD_6W", state: "ACTIVE" },
    ]);
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_enrolments where learner_id=$1",
          [learnerA.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await rpc(q, learnerA, "create_academy_order", [
        offerSlug,
        "FLEXIBLE_12W",
      ]),
    ).toMatchObject({ ok: false, code: "ALREADY_ENTITLED" });
    // The paid format cannot be changed at scheduling.
    const plan = await rpc(q, learnerA, "preview_my_academy_schedule", [
      first.enrolmentId,
      "FLEXIBLE_12W",
      new Date().toISOString().slice(0, 10),
      [1, 3, 5],
      "19:00",
      "Europe/London",
    ]);
    expect(plan).toMatchObject({ feasible: false, code: "FORMAT_FIXED" });
    await expect(
      q(
        "update public.academy_entitlements set format_id='FLEXIBLE_12W' where learner_id=$1",
        [learnerA.id],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
    await expect(
      q("update public.academy_orders set amount_minor=1 where id=$1", [
        order.orderId,
      ]),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("revokes only the refunded payment's access on a verified full refund, keeping history", async () => {
    const enrolmentId = (
      await q("select id from public.academy_enrolments where learner_id=$1", [
        learnerA.id,
      ])
    ).rows[0].id as string;
    await rpc(q, learnerA, "confirm_my_academy_schedule", [
      enrolmentId,
      "STANDARD_6W",
      new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      [1, 3, 5, 6],
      "19:00",
      "Europe/London",
      randomUUID(),
    ]);
    await releaseNow(q, enrolmentId, "LESSON", "lesson-1-1");
    expect(
      await rpc(q, learnerA, "get_my_academy_lesson", [
        enrolmentId,
        "lesson-1-1",
      ]),
    ).toBeTruthy();
    const refund = {
      kind: "REFUND",
      orderId: order.orderId,
      sessionId,
      eventId: "evt_refund",
      chargeId: "ch_1",
      amountMinor: order.amountMinor,
      currency: "GBP",
    };
    expect(
      await rpc(
        q,
        null,
        "apply_academy_commerce_operation",
        operation({ ...refund, refundedMinor: 100 }),
      ),
    ).toMatchObject({ ok: false, code: "PARTIAL_REFUND_REVIEW" });
    expect(
      await rpc(
        q,
        null,
        "apply_academy_commerce_operation",
        operation({ ...refund, amountMinor: 1, refundedMinor: 1 }),
      ),
    ).toMatchObject({ ok: false, code: "REFUND_MISMATCH" });
    const forged = operation({ ...refund, refundedMinor: order.amountMinor });
    forged[4] = "f".repeat(64);
    await expect(
      rpc(q, null, "apply_academy_commerce_operation", forged),
    ).rejects.toThrow(/UNTRUSTED_CLAIM/);
    expect(
      await rpc(
        q,
        null,
        "apply_academy_commerce_operation",
        operation({ ...refund, refundedMinor: order.amountMinor }),
      ),
    ).toMatchObject({ ok: true, code: "ACCESS_REVOKED" });
    expect(
      await rpc(
        q,
        null,
        "apply_academy_commerce_operation",
        operation({ ...refund, refundedMinor: order.amountMinor }),
      ),
    ).toMatchObject({ ok: true, code: "ALREADY_REVOKED" });
    await expect(
      rpc(q, learnerA, "get_my_academy_lesson", [enrolmentId, "lesson-1-1"]),
    ).rejects.toThrow(/ACCESS_REVOKED/);
    await expect(
      rpc(q, learnerA, "start_my_academy_assessment", [enrolmentId, "quiz-1"]),
    ).rejects.toThrow(/ACCESS_REVOKED/);
    const timetable = await rpc<{ accessRevoked: boolean; items: unknown[] }>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolmentId],
    );
    expect(timetable).toMatchObject({ accessRevoked: true });
    expect(timetable.items.length).toBeGreaterThan(0);
    expect(
      await rpc(q, learnerA, "get_my_academy_results", [enrolmentId]),
    ).toMatchObject({ enrolmentId });
    // Neither a replayed payment nor a new order restores refunded access.
    expect(
      await rpc(
        q,
        null,
        "fulfill_academy_order",
        fulfilArgs({
          orderId: order.orderId,
          sessionId,
          eventId: "evt_3",
          amount: order.amountMinor,
          currency: "GBP",
        }),
      ),
    ).toMatchObject({ ok: false, code: "ORDER_REFUNDED" });
    expect(
      await rpc(q, learnerA, "create_academy_order", [
        offerSlug,
        "STANDARD_6W",
      ]),
    ).toMatchObject({ ok: false, code: "ACCESS_REVOKED" });
  });

  it("never lets a refund revoke complimentary access", async () => {
    const offerId = (
      await q("select id from public.academy_offers where slug=$1", [offerSlug])
    ).rows[0].id;
    await rpc(q, admin, "grant_academy_entitlement", [
      offerId,
      learnerC.email,
      null,
      "Reviewer access",
    ]);
    const orderC = await rpc<Order>(q, learnerC, "create_academy_order", [
      offerSlug,
      "STANDARD_6W",
    ]);
    expect(orderC).toMatchObject({ ok: false, code: "ALREADY_ENTITLED" });
    expect(
      (
        await q(
          "select state from public.academy_entitlements where learner_id=$1",
          [learnerC.id],
        )
      ).rows[0].state,
    ).toBe("ACTIVE");
  });

  it("replaces only an expired session of the caller's own pending order", async () => {
    const orderB = await rpc<Order>(q, learnerB, "create_academy_order", [
      offerSlug,
      "INTENSIVE_4W",
    ]);
    await rpc(q, learnerB, "attach_academy_checkout_session", [
      orderB.orderId,
      "cs_test_expired",
    ]);
    const replace = {
      kind: "CHECKOUT_REPLACEMENT",
      learnerId: learnerB.id,
      orderId: orderB.orderId,
      expiredSessionId: "cs_test_expired",
      replacementSessionId: "cs_test_fresh",
    };
    expect(
      await rpc(
        q,
        learnerA,
        "apply_academy_commerce_operation",
        operation({ ...replace }),
      ),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(
      await rpc(
        q,
        learnerB,
        "apply_academy_commerce_operation",
        operation(replace),
      ),
    ).toMatchObject({ ok: true, code: "REPLACED" });
    expect(
      await rpc(
        q,
        learnerB,
        "apply_academy_commerce_operation",
        operation(replace),
      ),
    ).toMatchObject({ ok: true, code: "ALREADY_REPLACED" });
    expect(
      await rpc(
        q,
        learnerB,
        "apply_academy_commerce_operation",
        operation({ ...replace, replacementSessionId: "cs_test_third" }),
      ),
    ).toMatchObject({ ok: false, code: "SESSION_CHANGED" });
    await expect(
      q(
        "update public.academy_orders set provider_session_id='cs_test_rogue' where id=$1",
        [orderB.orderId],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
    expect(
      await rpc(q, learnerB, "get_my_academy_order", [orderB.orderId]),
    ).toMatchObject({
      ok: true,
      order: { sessionId: "cs_test_fresh", state: "PENDING" },
    });
  });
});
