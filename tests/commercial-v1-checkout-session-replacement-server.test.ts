import { beforeEach, describe, expect, it, vi } from "vitest";

// LR-03: the server-side decision that precedes migration 058's attested
// replacement. Only Stripe's own EXPIRED + UNPAID report for a session of
// THIS order may lead to an attestation; every other closed or unknown state
// keeps the existing fail-closed CHECKOUT_UNAVAILABLE.
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
const EXPIRED = "cs_test_EXPIRED";
const NEW = "cs_test_NEW";

function rpcWithBoundSession(bound: string) {
  return vi.fn(async (name: string) => {
    if (name === "create_commercial_v1_order")
      return {
        data: {
          ok: true,
          orderId,
          amountMinor: 19900,
          currency: "GBP",
          offerSlug: "cybersecurity-foundations",
          activationId: "20000000-0000-4000-8000-000000000001",
          reused: true,
        },
        error: null,
      };
    if (name === "get_commercial_v1_offer")
      return { data: { ok: false, code: "NOT_FOUND" }, error: null };
    if (name === "attach_commercial_v1_checkout_session")
      return {
        data: {
          ok: false,
          code: "SESSION_ALREADY_BOUND",
          existingSessionId: bound,
        },
        error: null,
      };
    throw new Error("unexpected rpc " + name);
  });
}
function provider(bound: Record<string, unknown>) {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({
      sessionId: NEW,
      url: "https://checkout.stripe.test/new",
    }),
    retrieveCheckoutSession: vi.fn().mockResolvedValue({
      sessionId: EXPIRED,
      paymentStatus: "UNPAID",
      amountMinor: 19900,
      currency: "GBP",
      metadataOrderId: orderId,
      url: null,
      status: "EXPIRED",
      ...bound,
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireActor.mockResolvedValue({ id: learnerId });
  mocks.config.mockReturnValue({
    configured: true,
    appUrl: "http://127.0.0.1:3000",
  });
  mocks.commerceConfig.mockReturnValue({ configured: true });
  mocks.client.mockResolvedValue({ rpc: rpcWithBoundSession(EXPIRED) });
});

describe("expired checkout session replacement (server decision)", () => {
  it("replaces an expired unpaid session of this order and returns the new checkout", async () => {
    mocks.getCommerceProvider.mockResolvedValue(provider({}));
    mocks.attestCheckoutSessionReplacement.mockResolvedValue({
      ok: true,
      code: "REPLACED",
    });
    expect(
      await createCommercialV1Checkout("cybersecurity-foundations"),
    ).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: "https://checkout.stripe.test/new",
      orderId,
    });
    expect(
      mocks.attestCheckoutSessionReplacement,
    ).toHaveBeenCalledExactlyOnceWith({
      learnerId,
      orderId,
      expiredSessionId: EXPIRED,
      replacementSessionId: NEW,
    });
  });

  it.each([
    ["the session completed", { status: "COMPLETE", paymentStatus: "PAID" }],
    ["an expired session reported as paid", { paymentStatus: "PAID" }],
    ["an expired session of another order", { metadataOrderId: otherOrderId }],
    ["no lifecycle status", { status: null }],
    ["a still-open session without a URL", { status: "OPEN" }],
  ])("never attests when %s", async (_label, bound) => {
    mocks.getCommerceProvider.mockResolvedValue(provider(bound));
    expect(
      await createCommercialV1Checkout("cybersecurity-foundations"),
    ).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
    expect(mocks.attestCheckoutSessionReplacement).not.toHaveBeenCalled();
  });

  it("returns the open bound session without any replacement", async () => {
    mocks.getCommerceProvider.mockResolvedValue(
      provider({ url: "https://checkout.stripe.test/bound", status: "OPEN" }),
    );
    expect(
      await createCommercialV1Checkout("cybersecurity-foundations"),
    ).toMatchObject({
      ok: true,
      url: "https://checkout.stripe.test/bound",
    });
    expect(mocks.attestCheckoutSessionReplacement).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the database refuses",
      () =>
        mocks.attestCheckoutSessionReplacement.mockResolvedValue({
          ok: false,
          code: "SESSION_CHANGED",
        }),
    ],
    [
      "the attestation is unavailable",
      () =>
        mocks.attestCheckoutSessionReplacement.mockRejectedValue(
          new Error("unavailable"),
        ),
    ],
  ])("fails closed when %s", async (_label, arrange) => {
    mocks.getCommerceProvider.mockResolvedValue(provider({}));
    arrange();
    expect(
      await createCommercialV1Checkout("cybersecurity-foundations"),
    ).toEqual({
      ok: false,
      code: "CHECKOUT_UNAVAILABLE",
    });
  });
});

describe("fake provider models the real-world sequence", () => {
  it("creates a new session for the same order once Stripe forgets the key, and reports the old one EXPIRED", async () => {
    const fake = new FakeCommerceProviderAdapter();
    const input = {
      orderId,
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "http://127.0.0.1:3000/checkout/success",
      cancelUrl: "http://127.0.0.1:3000/checkout/cancel",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:" + orderId,
    };
    const first = await fake.createCheckoutSession(input);
    expect((await fake.createCheckoutSession(input)).sessionId).toBe(
      first.sessionId,
    );
    fake.expireSession(first.sessionId);
    fake.forgetIdempotencyKey(input.idempotencyKey);
    const second = await fake.createCheckoutSession(input);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await fake.retrieveCheckoutSession(first.sessionId)).toMatchObject({
      url: null,
      status: "EXPIRED",
      paymentStatus: "UNPAID",
      metadataOrderId: orderId,
    });
    expect((await fake.retrieveCheckoutSession(second.sessionId)).status).toBe(
      "OPEN",
    );
  });
});
