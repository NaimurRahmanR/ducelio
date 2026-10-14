import { beforeEach, describe, expect, it, vi } from "vitest";

// LR-03 (migration 058) after independent-review finding 1: checkout reads
// the authoritative bound session FIRST and only then chooses an idempotency
// key. These tests drive the real createCommercialV1Checkout against a
// stateful model of the database binding and the deterministic fake Stripe
// adapter, which RETAINS idempotency keys (the review's failure mode): the
// original order key keeps returning its cached, now-expired session.
const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  client: vi.fn(),
  config: vi.fn(),
  commerceConfig: vi.fn(),
  getCommerceProvider: vi.fn(),
  attestCommerceFulfillment: vi.fn(),
  attestCheckoutSessionReplacement: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({
  config: mocks.config,
  commerceConfig: mocks.commerceConfig,
}));
vi.mock("@/server/commercial-v1-commerce/provider", () => ({
  getCommerceProvider: mocks.getCommerceProvider,
}));
vi.mock("@/server/commercial-v1-commerce/authority", () => ({
  attestCommerceFulfillment: mocks.attestCommerceFulfillment,
}));
vi.mock("@/server/commercial-v1-commerce/operations-authority", () => ({
  attestCheckoutSessionReplacement: mocks.attestCheckoutSessionReplacement,
}));

import { createCommercialV1Checkout } from "@/server/commercial-v1-commerce";
import { FakeCommerceProviderAdapter } from "@/server/commercial-v1-commerce/test-fake-provider";

const learnerId = "10000000-0000-4000-8000-0000000000aa";
const orderId = "10000000-0000-4000-8000-000000000001";
const otherOrderId = "10000000-0000-4000-8000-000000000002";
const ORDER_KEY = "DUCELIO_COMMERCIAL_V1_ORDER:" + orderId;
const SLUG = "cybersecurity-foundations";

let db: { bound: string | null; state: "PENDING" | "FULFILLED" };
let fake: FakeCommerceProviderAdapter;
let keys: string[];

function wire() {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "create_commercial_v1_order")
      return {
        data: {
          ok: true,
          orderId,
          amountMinor: 19900,
          currency: "GBP",
          offerSlug: SLUG,
          activationId: "20000000-0000-4000-8000-000000000001",
          reused: true,
        },
        error: null,
      };
    if (name === "get_commercial_v1_offer")
      return { data: { ok: false, code: "NOT_FOUND" }, error: null };
    if (name === "get_my_commercial_v1_checkout_binding")
      return {
        data: { ok: true, state: db.state, sessionId: db.bound },
        error: null,
      };
    if (name === "attach_commercial_v1_checkout_session") {
      if (db.bound === null) {
        db.bound = String(args?.p_session_id);
        return { data: { ok: true, orderId }, error: null };
      }
      return {
        data: {
          ok: false,
          code: "SESSION_ALREADY_BOUND",
          existingSessionId: db.bound,
        },
        error: null,
      };
    }
    throw new Error("unexpected rpc " + name);
  });
  mocks.client.mockResolvedValue({ rpc });
  const create = fake.createCheckoutSession.bind(fake);
  fake.createCheckoutSession = async (input) => {
    keys.push(input.idempotencyKey);
    return create(input);
  };
  mocks.getCommerceProvider.mockResolvedValue(fake);
  // The attested database replacement (migration 058) under the order lock.
  mocks.attestCheckoutSessionReplacement.mockImplementation(
    async (input: {
      expiredSessionId: string;
      replacementSessionId: string;
    }) => {
      if (db.state !== "PENDING") return { ok: false, code: "INVALID_STATE" };
      if (db.bound === input.replacementSessionId)
        return { ok: true, code: "ALREADY_REPLACED" };
      if (db.bound !== input.expiredSessionId)
        return { ok: false, code: "SESSION_CHANGED" };
      db.bound = input.replacementSessionId;
      return { ok: true, code: "REPLACED" };
    },
  );
}
const checkout = () => createCommercialV1Checkout(SLUG);
const urlOf = (sessionId: string) => `https://checkout.fake.test/${sessionId}`;
const otherSession = (key: string) =>
  fake.createCheckoutSession({
    orderId,
    amountMinor: 19900,
    currency: "GBP",
    offerTitle: "x",
    successUrl: "s",
    cancelUrl: "c",
    idempotencyKey: key,
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireActor.mockResolvedValue({ id: learnerId });
  mocks.config.mockReturnValue({
    configured: true,
    appUrl: "http://127.0.0.1:3000",
  });
  mocks.commerceConfig.mockReturnValue({ configured: true });
  db = { bound: null, state: "PENDING" };
  fake = new FakeCommerceProviderAdapter();
  keys = [];
  wire();
});

describe("binding-first checkout", () => {
  it("binds and returns the first session under the original order key", async () => {
    const result = await checkout();
    expect(db.bound).toMatch(/^cs_test_fake_/);
    expect(result).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: urlOf(db.bound!),
      orderId,
    });
    expect(keys).toEqual([ORDER_KEY]);
  });

  it("reuses an open bound session without creating any new Stripe session", async () => {
    await checkout();
    const first = db.bound!;
    keys = [];
    expect(await checkout()).toMatchObject({ ok: true, url: urlOf(first) });
    expect(keys).toEqual([]);
    expect(mocks.attestCheckoutSessionReplacement).not.toHaveBeenCalled();
  });
});

describe("recovery while Stripe still retains the original idempotency result", () => {
  it("replaces the expired session under a replacement-generation key, never the cached one", async () => {
    await checkout();
    const expired = db.bound!;
    fake.expireSession(expired);
    // Stripe still returns the cached, expired session for the order key.
    expect((await otherSession(ORDER_KEY)).sessionId).toBe(expired);
    keys = [];

    const result = await checkout();

    expect(db.bound).not.toBe(expired);
    expect(result).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: urlOf(db.bound!),
      orderId,
    });
    expect(keys).toEqual([ORDER_KEY + ":REPLACES:" + expired]);
    expect(
      mocks.attestCheckoutSessionReplacement,
    ).toHaveBeenCalledExactlyOnceWith({
      learnerId,
      orderId,
      expiredSessionId: expired,
      replacementSessionId: db.bound,
    });
    // Server-owned amount, currency and order identity are preserved.
    expect(await fake.retrieveCheckoutSession(db.bound!)).toMatchObject({
      amountMinor: 19900,
      currency: "GBP",
      metadataOrderId: orderId,
      status: "OPEN",
    });
  });

  it("gives concurrent attempts the same replacement for the same expired session", async () => {
    await checkout();
    const expired = db.bound!;
    fake.expireSession(expired);
    keys = [];
    const [a, b] = await Promise.all([checkout(), checkout()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, url: urlOf(db.bound!) });
    expect(new Set(keys)).toEqual(
      new Set([ORDER_KEY + ":REPLACES:" + expired]),
    );
    const outcomes = await Promise.all(
      mocks.attestCheckoutSessionReplacement.mock.results.map((r) => r.value),
    );
    expect(outcomes.filter((o) => o.code === "REPLACED")).toHaveLength(1);
  });

  it("uses a new key for every later generation", async () => {
    await checkout();
    const first = db.bound!;
    fake.expireSession(first);
    await checkout();
    const second = db.bound!;
    fake.expireSession(second);
    keys = [];
    const result = await checkout();
    const third = db.bound!;
    expect(new Set([first, second, third]).size).toBe(3);
    expect(keys).toEqual([ORDER_KEY + ":REPLACES:" + second]);
    expect(result).toMatchObject({ ok: true, url: urlOf(third) });
  });

  it("never returns an expired replacement and fails closed within the loop bound", async () => {
    await checkout();
    fake.expireSession(db.bound!);
    // Every new session is already expired when Stripe is asked about it.
    const create = fake.createCheckoutSession.bind(fake);
    fake.createCheckoutSession = async (input) => {
      const created = await create(input);
      fake.expireSession(created.sessionId);
      return created;
    };
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
  });
});

describe("never replace anything but a confirmed expired, unpaid session of this order", () => {
  it.each([
    [
      "a completed and paid session",
      (id: string) => {
        fake.setSessionStatus(id, "PAID");
        fake.closeSession(id);
      },
    ],
    [
      "an expired session reported as paid",
      (id: string) => {
        fake.setSessionStatus(id, "PAID");
        fake.expireSession(id);
      },
    ],
    [
      "a session Stripe does not know (missing evidence)",
      () => {
        db.bound = "cs_test_unknown";
      },
    ],
  ])("fails closed for %s", async (_label, arrange) => {
    await checkout();
    arrange(db.bound!);
    keys = [];
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
    expect(keys).toEqual([]);
    expect(mocks.attestCheckoutSessionReplacement).not.toHaveBeenCalled();
  });

  it("fails closed for a bound session of another order", async () => {
    const created = await fake.createCheckoutSession({
      orderId: otherOrderId,
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "x",
      successUrl: "s",
      cancelUrl: "c",
      idempotencyKey: "other-order",
    });
    fake.expireSession(created.sessionId);
    db.bound = created.sessionId;
    keys = [];
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
    expect(keys).toEqual([]);
  });

  it("fails closed when Stripe cannot be reached for the bound session", async () => {
    await checkout();
    fake.retrieveCheckoutSession = vi.fn().mockRejectedValue(new Error("down"));
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
  });

  it.each([
    ["the database refuses", { ok: false, code: "INVALID_STATE" }],
    ["the attestation is unavailable", new Error("unavailable")],
  ])("fails closed when %s", async (_label, outcome) => {
    await checkout();
    fake.expireSession(db.bound!);
    if (outcome instanceof Error)
      mocks.attestCheckoutSessionReplacement.mockRejectedValue(outcome);
    else mocks.attestCheckoutSessionReplacement.mockResolvedValue(outcome);
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
  });

  it("does not start checkout for an order that is no longer pending", async () => {
    db.state = "FULFILLED";
    expect(await checkout()).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
    expect(keys).toEqual([]);
  });
});
