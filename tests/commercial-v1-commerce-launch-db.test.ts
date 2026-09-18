import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  asPolicyUser,
  buildCommerceFixture,
  learner,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";

const CANONICAL_PR23_MAIN = "c526157e3d8a6b024856a0a6ce8f8e2f3f53dde8";
const databases: PGlite[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

async function fixture() {
  const f = await buildCommerceFixture({ throughMigration: 39 });
  databases.push(f.db);
  return f;
}

async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}

async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}
async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}
async function asForeignLearner(db: PGlite) {
  await asPolicyUser(db, 3);
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}

async function publishOffer(
  f: CommerceFixture,
  deliveryPlan = "STANDARD_6_WEEK",
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_offer($1,$2,$3,$4,$5,$6,$7) as v",
    [
      f.activationId,
      "security-plus-sy0-701",
      2999,
      "GBP",
      "Security+ founding cohort",
      deliveryPlan,
      "Publish Security+ founding offer",
    ],
  );
}

async function createCampaign(
  f: CommerceFixture,
  input: {
    code: string;
    kind: "PERCENT_OFF" | "FIXED_PRICE" | "REVIEWER_COMPLIMENTARY";
    percentOff?: number | null;
    fixedPriceAmountMinor?: number | null;
    maxRedemptions?: number;
  },
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    `select public.create_commercial_v1_campaign(
       $1,$2,$3,$4,$5,$6,
       clock_timestamp()-interval '1 hour',
       clock_timestamp()+interval '1 day',
       $7
     ) as v`,
    [
      "security-plus-sy0-701",
      input.code,
      input.kind,
      input.percentOff ?? null,
      input.kind === "REVIEWER_COMPLIMENTARY"
        ? 0
        : (input.fixedPriceAmountMinor ?? null),
      input.maxRedemptions ?? 50,
      "PR24 campaign acceptance",
    ],
  );
}

describe("PR24 migration integrity", () => {
  it("leaves migrations 001-038 unchanged from CLOSED GREEN PR23", () => {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", CANONICAL_PR23_MAIN, "--", "supabase/migrations"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 38;
    });
    expect(historical).toEqual([]);
  });
});

describe("PR24 launch offer projection", () => {
  it("publishes and surfaces immutable delivery-plan identity", async () => {
    const f = await fixture();
    await publishOffer(f, "INTENSIVE_4_WEEK");

    await asLearner(f.db);
    const detail = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_offer($1) as v",
      ["security-plus-sy0-701"],
    );
    expect(detail).toMatchObject({
      ok: true,
      priceAmountMinor: 2999,
      currency: "GBP",
      deliveryPlan: "INTENSIVE_4_WEEK",
    });

    const list = await value<Record<string, unknown>[]>(
      f.db,
      "select public.list_commercial_v1_offers() as v",
    );
    expect(list[0]).toMatchObject({
      slug: "security-plus-sy0-701",
      deliveryPlan: "INTENSIVE_4_WEEK",
    });
  });
});

describe("PR24 campaign redemption authority", () => {
  it("preview is read-only; reviewer redemption grants access without any order", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "REVIEWER-50",
      kind: "REVIEWER_COMPLIMENTARY",
    });

    await asLearner(f.db);
    const preview = await value<Record<string, unknown>>(
      f.db,
      "select public.preview_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "reviewer-50"],
    );
    expect(preview).toMatchObject({
      ok: true,
      effectivePriceAmountMinor: 0,
      kind: "REVIEWER_COMPLIMENTARY",
      reused: false,
    });

    await owner(f.db);
    expect(
      await value<number>(
        f.db,
        "select count(*)::int as v from public.commercial_v1_campaign_redemptions",
      ),
    ).toBe(0);

    await asLearner(f.db);
    const redeemed = await value<Record<string, unknown>>(
      f.db,
      "select public.redeem_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "reviewer-50"],
    );
    expect(redeemed).toMatchObject({
      ok: true,
      path: "ACCESS_GRANTED",
      effectivePriceAmountMinor: 0,
      reused: false,
    });

    await owner(f.db);
    expect(
      await value<number>(
        f.db,
        "select count(*)::int as v from public.commercial_v1_orders",
      ),
    ).toBe(0);
    const entitlement = (
      await f.db.query<{
        source: string;
        order_id: string | null;
        campaign_redemption_id: string | null;
      }>(
        "select source,order_id,campaign_redemption_id from public.commercial_v1_entitlements where learner_id=$1",
        [learner],
      )
    ).rows[0];
    expect(entitlement.source).toBe("REVIEWER");
    expect(entitlement.order_id).toBeNull();
    expect(entitlement.campaign_redemption_id).toBeTruthy();

    await asLearner(f.db);
    const replay = await value<Record<string, unknown>>(
      f.db,
      "select public.redeem_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "REVIEWER-50"],
    );
    expect(replay).toMatchObject({
      ok: true,
      path: "ACCESS_GRANTED",
      reused: true,
    });
  });

  it("a paid percentage campaign creates one discounted immutable order with redemption provenance", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "FOUNDING-20",
      kind: "PERCENT_OFF",
      percentOff: 20,
    });

    await asLearner(f.db);
    const redeemed = await value<Record<string, unknown>>(
      f.db,
      "select public.redeem_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "founding-20"],
    );
    expect(redeemed).toMatchObject({
      ok: true,
      path: "PAID_CHECKOUT",
      effectivePriceAmountMinor: 2400,
      currency: "GBP",
      reused: false,
    });
    const orderId = redeemed.orderId as string;

    const baseRetry = await value<Record<string, unknown>>(
      f.db,
      "select public.create_commercial_v1_order($1) as v",
      ["security-plus-sy0-701"],
    );
    expect(baseRetry).toMatchObject({
      ok: true,
      orderId,
      amountMinor: 2400,
      reused: true,
    });

    await owner(f.db);
    const order = (
      await f.db.query<{
        amount_minor: number;
        campaign_redemption_id: string | null;
      }>(
        "select amount_minor,campaign_redemption_id from public.commercial_v1_orders where id=$1",
        [orderId],
      )
    ).rows[0];
    expect(order.amount_minor).toBe(2400);
    expect(order.campaign_redemption_id).toBeTruthy();
    await expect(
      f.db.query(
        "update public.commercial_v1_orders set amount_minor=2999 where id=$1",
        [orderId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("reserves zero-price access for reviewer campaigns only", async () => {
    const f = await fixture();
    await publishOffer(f);

    await expect(
      createCampaign(f, {
        code: "PROMO-100",
        kind: "PERCENT_OFF",
        percentOff: 100,
      }),
    ).rejects.toThrow(/ZERO_PRICE_RESERVED_FOR_REVIEWERS/);

    await expect(
      createCampaign(f, {
        code: "FIXED-ZERO",
        kind: "FIXED_PRICE",
        fixedPriceAmountMinor: 0,
      }),
    ).rejects.toThrow(/ZERO_PRICE_RESERVED_FOR_REVIEWERS/);

    await owner(f.db);
    expect(
      await value<number>(
        f.db,
        "select count(*)::int as v from public.commercial_v1_campaigns",
      ),
    ).toBe(0);
  });

  it("enforces the campaign cap under two different learners", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "ONE-SEAT",
      kind: "PERCENT_OFF",
      percentOff: 10,
      maxRedemptions: 1,
    });

    await asLearner(f.db);
    expect(
      await value<Record<string, unknown>>(
        f.db,
        "select public.redeem_commercial_v1_campaign($1,$2) as v",
        ["security-plus-sy0-701", "ONE-SEAT"],
      ),
    ).toMatchObject({ ok: true, path: "PAID_CHECKOUT" });

    await asForeignLearner(f.db);
    expect(
      await value<Record<string, unknown>>(
        f.db,
        "select public.redeem_commercial_v1_campaign($1,$2) as v",
        ["security-plus-sy0-701", "ONE-SEAT"],
      ),
    ).toEqual({ ok: false, code: "CODE_UNAVAILABLE" });
  });

  it("does not let a code rewrite an already-started full-price checkout", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "LATE-20",
      kind: "PERCENT_OFF",
      percentOff: 20,
    });

    await asLearner(f.db);
    const order = await value<Record<string, unknown>>(
      f.db,
      "select public.create_commercial_v1_order($1) as v",
      ["security-plus-sy0-701"],
    );
    expect(order).toMatchObject({ ok: true, amountMinor: 2999 });

    const redeemed = await value<Record<string, unknown>>(
      f.db,
      "select public.redeem_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "LATE-20"],
    );
    expect(redeemed).toEqual({
      ok: false,
      code: "CHECKOUT_ALREADY_STARTED",
    });

    await owner(f.db);
    expect(
      await value<number>(
        f.db,
        "select count(*)::int as v from public.commercial_v1_campaign_redemptions",
      ),
    ).toBe(0);
  });

  it("prevents stacking a second campaign on the same learner and offer", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "FIRST-10",
      kind: "PERCENT_OFF",
      percentOff: 10,
    });
    await createCampaign(f, {
      code: "SECOND-20",
      kind: "PERCENT_OFF",
      percentOff: 20,
    });

    await asLearner(f.db);
    expect(
      await value<Record<string, unknown>>(
        f.db,
        "select public.redeem_commercial_v1_campaign($1,$2) as v",
        ["security-plus-sy0-701", "FIRST-10"],
      ),
    ).toMatchObject({ ok: true, path: "PAID_CHECKOUT" });

    expect(
      await value<Record<string, unknown>>(
        f.db,
        "select public.redeem_commercial_v1_campaign($1,$2) as v",
        ["security-plus-sy0-701", "SECOND-20"],
      ),
    ).toEqual({ ok: false, code: "OFFER_ALREADY_REDEEMED" });
  });

  it("admin campaign list is bounded and shows redemption usage", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "FIXED-1999",
      kind: "FIXED_PRICE",
      fixedPriceAmountMinor: 1999,
      maxRedemptions: 5,
    });

    await asLearner(f.db);
    await value(
      f.db,
      "select public.redeem_commercial_v1_campaign($1,$2) as v",
      ["security-plus-sy0-701", "FIXED-1999"],
    );

    await asAdmin(f.db);
    const campaigns = await value<Record<string, unknown>[]>(
      f.db,
      "select public.list_commercial_v1_campaigns() as v",
    );
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      code: "FIXED-1999",
      effectivePriceAmountMinor: 1999,
      maxRedemptions: 5,
      redemptionCount: 1,
      state: "ACTIVE",
    });
  });
});

describe("PR24 campaign access-control boundary", () => {
  it("learner can preview/redeem but cannot use the admin campaign listing", async () => {
    const f = await fixture();
    await publishOffer(f);
    await createCampaign(f, {
      code: "BOUNDARY-10",
      kind: "PERCENT_OFF",
      percentOff: 10,
    });

    await asLearner(f.db);
    expect(
      await value<Record<string, unknown>>(
        f.db,
        "select public.preview_commercial_v1_campaign($1,$2) as v",
        ["security-plus-sy0-701", "BOUNDARY-10"],
      ),
    ).toMatchObject({ ok: true, effectivePriceAmountMinor: 2700 });

    await expect(
      f.db.query("select public.list_commercial_v1_campaigns()"),
    ).rejects.toThrow();
  });

  it("new provenance columns/tables remain inaccessible through direct learner table access", async () => {
    const f = await fixture();
    await publishOffer(f);
    await asLearner(f.db);

    await expect(
      f.db.query(
        "select campaign_redemption_id from public.commercial_v1_orders",
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query("select * from public.commercial_v1_campaign_redemptions"),
    ).rejects.toThrow();
  });
});
