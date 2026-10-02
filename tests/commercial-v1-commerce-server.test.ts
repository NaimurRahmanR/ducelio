import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  config: vi.fn(),
  commerceConfig: vi.fn(),
  getCommerceProvider: vi.fn(),
  attestCommerceFulfillment: vi.fn(),
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

import {
  createCommercialV1Checkout,
  reconcileCommercialV1Order,
} from "@/server/commercial-v1-commerce";

const orderId = "10000000-0000-4000-8000-000000000001";
const activationId = "20000000-0000-4000-8000-000000000001";

function configuredCommerce() {
  return {
    stripeSecretKey: "sk_test",
    stripeWebhookSecret: "whsec_test",
    controllerKeyId: "30000000-0000-4000-8000-000000000001",
    controllerKeyHex: "a".repeat(64),
    stripeConfigured: true,
    controllerConfigured: true,
    configured: true,
  };
}

describe("server: createCommercialV1Checkout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireActor.mockResolvedValue({ id: "learner-1" });
    mocks.config.mockReturnValue({
      url: "",
      key: "",
      configured: true,
      appUrl: "http://127.0.0.1:3000",
      google: false,
      linkedin: false,
    });
    mocks.commerceConfig.mockReturnValue(configuredCommerce());
  });

  it("V2 correction (item 2): fails closed WITHOUT ever creating an order or calling Stripe when commerce is not fully configured", async () => {
    mocks.commerceConfig.mockReturnValue({
      ...configuredCommerce(),
      configured: false,
    });
    const rpc = vi.fn();
    mocks.client.mockResolvedValue({ rpc });
    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
    );
    expect(result).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
  });

  it("V2 correction (item 1): passes a deterministic per-order Stripe idempotency key and returns the newly bound session's url on a clean first call", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "create_commercial_v1_order") {
        return {
          data: {
            ok: true,
            orderId,
            amountMinor: 19900,
            currency: "GBP",
            offerSlug: "cybersecurity-foundations",
            activationId,
            reused: false,
          },
          error: null,
        };
      }
      if (name === "get_commercial_v1_offer") {
        return {
          data: {
            ok: true,
            slug: "cybersecurity-foundations",
            title: "Cybersecurity Foundations",
            examinationBody: "ISC2",
            qualificationName: "Certified in Cybersecurity",
            priceAmountMinor: 19900,
            currency: "GBP",
            summary: null,
            cohortStartsOn: "2026-09-01",
            viewerAuthenticated: true,
            viewerEntitled: false,
            viewerEnrolmentId: null,
            viewerEnrolmentStatus: "NONE",
          },
          error: null,
        };
      }
      if (name === "attach_commercial_v1_checkout_session") {
        return { data: { ok: true, orderId }, error: null };
      }
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });
    const createCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_fresh",
      url: "https://checkout.stripe.test/cs_test_fresh",
    });
    mocks.getCommerceProvider.mockResolvedValue({ createCheckoutSession });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
    );

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        amountMinor: 19900,
        currency: "GBP",
        idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:" + orderId,
      }),
    );
    expect(result).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: "https://checkout.stripe.test/cs_test_fresh",
      orderId,
    });
  });

  it("V2 correction (item 1): when the DB reports a DIFFERENT already-bound session, retrieves and returns THAT session's url -- never the newly created session's url", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "create_commercial_v1_order") {
        return {
          data: {
            ok: true,
            orderId,
            amountMinor: 19900,
            currency: "GBP",
            offerSlug: "cybersecurity-foundations",
            activationId,
            reused: true,
          },
          error: null,
        };
      }
      if (name === "get_commercial_v1_offer") {
        return {
          data: {
            ok: true,
            slug: "cybersecurity-foundations",
            title: "Cybersecurity Foundations",
            examinationBody: "ISC2",
            qualificationName: "Certified in Cybersecurity",
            priceAmountMinor: 19900,
            currency: "GBP",
            summary: null,
            cohortStartsOn: "2026-09-01",
            viewerAuthenticated: true,
            viewerEntitled: false,
            viewerEnrolmentId: null,
            viewerEnrolmentStatus: "NONE",
          },
          error: null,
        };
      }
      if (name === "attach_commercial_v1_checkout_session") {
        return {
          data: {
            ok: false,
            code: "SESSION_ALREADY_BOUND",
            existingSessionId: "cs_test_ALREADY_BOUND",
          },
          error: null,
        };
      }
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });
    const createCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_NEW_UNBOUND",
      url: "https://checkout.stripe.test/cs_test_NEW_UNBOUND",
    });
    const retrieveCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_ALREADY_BOUND",
      paymentStatus: "UNPAID",
      amountMinor: 19900,
      currency: "GBP",
      metadataOrderId: orderId,
      url: "https://checkout.stripe.test/cs_test_ALREADY_BOUND",
    });
    mocks.getCommerceProvider.mockResolvedValue({
      createCheckoutSession,
      retrieveCheckoutSession,
    });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
    );

    expect(retrieveCheckoutSession).toHaveBeenCalledWith(
      "cs_test_ALREADY_BOUND",
    );
    expect(result).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: "https://checkout.stripe.test/cs_test_ALREADY_BOUND",
      orderId,
    });
  });

  it("V2 correction (item 1): when the already-bound session can no longer be retrieved with a live url, fails closed rather than exposing the unbound session", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "create_commercial_v1_order") {
        return {
          data: {
            ok: true,
            orderId,
            amountMinor: 19900,
            currency: "GBP",
            offerSlug: "cybersecurity-foundations",
            activationId,
            reused: true,
          },
          error: null,
        };
      }
      if (name === "get_commercial_v1_offer") {
        return {
          data: {
            ok: true,
            slug: "cybersecurity-foundations",
            title: "Course",
            examinationBody: "ISC2",
            qualificationName: "CC",
            priceAmountMinor: 19900,
            currency: "GBP",
            summary: null,
            cohortStartsOn: "2026-09-01",
            viewerAuthenticated: true,
            viewerEntitled: false,
            viewerEnrolmentId: null,
            viewerEnrolmentStatus: "NONE",
          },
          error: null,
        };
      }
      if (name === "attach_commercial_v1_checkout_session") {
        return {
          data: {
            ok: false,
            code: "SESSION_ALREADY_BOUND",
            existingSessionId: "cs_test_EXPIRED",
          },
          error: null,
        };
      }
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });
    const createCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_NEW",
      url: "https://checkout.stripe.test/cs_test_NEW",
    });
    const retrieveCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_EXPIRED",
      paymentStatus: "UNPAID",
      amountMinor: null,
      currency: null,
      metadataOrderId: null,
      url: null,
    });
    mocks.getCommerceProvider.mockResolvedValue({
      createCheckoutSession,
      retrieveCheckoutSession,
    });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
    );
    expect(result).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });
  });
});

describe("server: reconcileCommercialV1Order", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireActor.mockResolvedValue({ id: "learner-1" });
  });

  function orderRpc(
    overrides: Partial<{
      state: string;
      orderRefunded: boolean;
      accessRevoked: boolean;
    }> = {},
  ) {
    return vi.fn(async (name: string) => {
      if (name === "get_commercial_v1_order") {
        return {
          data: {
            ok: true,
            order: {
              id: orderId,
              state: overrides.state ?? "PENDING",
              orderRefunded: overrides.orderRefunded ?? false,
              accessRevoked: overrides.accessRevoked ?? false,
              offerSlug: "cybersecurity-foundations",
              activationId,
              amountMinor: 19900,
              currency: "GBP",
              fulfilledAt: null,
            },
          },
          error: null,
        };
      }
      throw new Error("unexpected rpc " + name);
    });
  }

  it.each([false, true])(
    "refunded order with accessRevoked=%s is refused before fulfilled replay or payment attestation",
    async (accessRevoked) => {
      mocks.client.mockResolvedValue({
        rpc: orderRpc({
          state: "FULFILLED",
          orderRefunded: true,
          accessRevoked,
        }),
      });
      expect(
        await reconcileCommercialV1Order({ orderId, sessionId: "cs_refunded" }),
      ).toEqual({
        ok: false,
        code: accessRevoked ? "ACCESS_REVOKED" : "ORDER_REFUNDED",
      });
      expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
      expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
    },
  );

  it("an order already FULFILLED short-circuits without ever calling the provider or attesting again", async () => {
    const rpc = orderRpc({ state: "FULFILLED" });
    mocks.client.mockResolvedValue({ rpc });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({
      ok: true,
      fulfilled: true,
      replay: true,
      orderId,
    });
    expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("a mismatched provider session (different metadata order id) is denied without attesting", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: 19900,
        currency: "GBP",
        metadataOrderId: "some-other-order-id",
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({ ok: false, code: "MISMATCHED_SESSION" });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("V2 correction (item 6): an UNPAID observation returns NOT_PAID and NEVER calls attestCommerceFulfillment (no synthetic payment-event provenance for an unconfirmed payment)", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "UNPAID",
        amountMinor: 19900,
        currency: "GBP",
        metadataOrderId: orderId,
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({
      ok: true,
      fulfilled: false,
      code: "NOT_PAID",
      orderId,
    });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("V2 correction (item 3): a PAID observation with a NULL amount never synthesises the DB order's own amount -- fails closed as INCOMPLETE_EVIDENCE without attesting", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: null,
        currency: "GBP",
        metadataOrderId: orderId,
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({ ok: false, code: "INCOMPLETE_EVIDENCE" });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("V2 correction (item 3): a PAID observation with a NULL currency also fails closed without attesting", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: 19900,
        currency: null,
        metadataOrderId: orderId,
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({ ok: false, code: "INCOMPLETE_EVIDENCE" });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("a PAID observation whose amount differs from the DB order is denied MISMATCHED_AMOUNT without attesting", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: 1,
        currency: "GBP",
        metadataOrderId: orderId,
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({ ok: false, code: "MISMATCHED_AMOUNT" });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("a PAID observation whose currency differs from the DB order is denied MISMATCHED_CURRENCY without attesting", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: 19900,
        currency: "USD",
        metadataOrderId: orderId,
        url: null,
      }),
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(result).toEqual({ ok: false, code: "MISMATCHED_CURRENCY" });
    expect(mocks.attestCommerceFulfillment).not.toHaveBeenCalled();
  });

  it("a complete PAID observation matching the order attests using the SESSION's own evidence, and returns the DB fulfillment authority's own result", async () => {
    const rpc = orderRpc();
    mocks.client.mockResolvedValue({ rpc });
    mocks.getCommerceProvider.mockResolvedValue({
      retrieveCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: "cs_test_1",
        paymentStatus: "PAID",
        amountMinor: 19900,
        currency: "GBP",
        metadataOrderId: orderId,
        url: null,
      }),
    });
    mocks.attestCommerceFulfillment.mockResolvedValue({
      ok: true,
      fulfilled: true,
      replay: false,
      orderId,
      entitlementId: "40000000-0000-4000-8000-000000000001",
      enrolmentId: "50000000-0000-4000-8000-000000000001",
      activationId,
    });
    const result = await reconcileCommercialV1Order({
      orderId,
      sessionId: "cs_test_1",
    });
    expect(mocks.attestCommerceFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "STRIPE",
        sessionId: "cs_test_1",
        orderId,
        amountMinor: 19900,
        currency: "GBP",
        status: "PAID",
        eventId: "SESSION_VERIFY:cs_test_1",
      }),
    );
    expect(result).toEqual({
      ok: true,
      fulfilled: true,
      replay: false,
      orderId,
    });
  });
});

describe("server: PR24 campaign checkout branching", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireActor.mockResolvedValue({ id: "learner-1" });
    mocks.config.mockReturnValue({
      url: "",
      key: "",
      configured: true,
      appUrl: "http://127.0.0.1:3000",
      google: false,
      linkedin: false,
    });
    mocks.commerceConfig.mockReturnValue(configuredCommerce());
  });

  it("grants a zero-price reviewer redemption without requiring or calling Stripe", async () => {
    mocks.commerceConfig.mockReturnValue({
      ...configuredCommerce(),
      configured: false,
      stripeConfigured: false,
    });
    const entitlementId = "40000000-0000-4000-8000-000000000001";
    const enrolmentId = "50000000-0000-4000-8000-000000000001";
    const rpc = vi.fn(async (name: string) => {
      if (name === "preview_commercial_v1_campaign")
        return {
          data: {
            ok: true,
            effectivePriceAmountMinor: 0,
            currency: "GBP",
            kind: "REVIEWER_COMPLIMENTARY",
            reused: false,
          },
          error: null,
        };
      if (name === "redeem_commercial_v1_campaign")
        return {
          data: {
            ok: true,
            path: "ACCESS_GRANTED",
            reused: false,
            offerSlug: "cybersecurity-foundations",
            activationId,
            effectivePriceAmountMinor: 0,
            currency: "GBP",
            entitlementId,
            enrolmentId,
          },
          error: null,
        };
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
      "reviewer-50",
    );
    expect(result).toEqual({
      ok: true,
      kind: "ACCESS_GRANTED",
      entitlementId,
      enrolmentId,
      offerSlug: "cybersecurity-foundations",
    });
    expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
  });

  it("does not consume a paid campaign when commerce is unavailable", async () => {
    mocks.commerceConfig.mockReturnValue({
      ...configuredCommerce(),
      configured: false,
    });
    const rpc = vi.fn(async (name: string) => {
      if (name === "preview_commercial_v1_campaign")
        return {
          data: {
            ok: true,
            effectivePriceAmountMinor: 2400,
            currency: "GBP",
            kind: "PERCENT_OFF",
            reused: false,
          },
          error: null,
        };
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
      "FOUNDING-20",
    );
    expect(result).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });
    expect(
      rpc.mock.calls.some(([name]) => name === "redeem_commercial_v1_campaign"),
    ).toBe(false);
    expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
  });

  it("uses the database-redemption price for paid campaign checkout", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "preview_commercial_v1_campaign")
        return {
          data: {
            ok: true,
            effectivePriceAmountMinor: 2400,
            currency: "GBP",
            kind: "PERCENT_OFF",
            reused: false,
          },
          error: null,
        };
      if (name === "redeem_commercial_v1_campaign")
        return {
          data: {
            ok: true,
            path: "PAID_CHECKOUT",
            reused: false,
            orderId,
            offerSlug: "cybersecurity-foundations",
            activationId,
            effectivePriceAmountMinor: 2400,
            currency: "GBP",
          },
          error: null,
        };
      if (name === "get_commercial_v1_offer")
        return {
          data: {
            ok: true,
            slug: "cybersecurity-foundations",
            title: "Cybersecurity Foundations",
            examinationBody: "CompTIA",
            qualificationName: "Security+ SY0-701",
            priceAmountMinor: 2999,
            currency: "GBP",
            summary: null,
            cohortStartsOn: "2026-10-01",
            viewerAuthenticated: true,
            viewerEntitled: false,
            viewerEnrolmentId: null,
            viewerEnrolmentStatus: "NONE",
          },
          error: null,
        };
      if (name === "attach_commercial_v1_checkout_session")
        return { data: { ok: true, orderId }, error: null };
      throw new Error("unexpected rpc " + name);
    });
    mocks.client.mockResolvedValue({ rpc });
    const createCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: "cs_test_discounted",
      url: "https://checkout.stripe.test/cs_test_discounted",
    });
    mocks.getCommerceProvider.mockResolvedValue({ createCheckoutSession });

    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
      "FOUNDING-20",
    );
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        amountMinor: 2400,
        currency: "GBP",
      }),
    );
    expect(result).toEqual({
      ok: true,
      kind: "CHECKOUT",
      url: "https://checkout.stripe.test/cs_test_discounted",
      orderId,
    });
  });

  it("rejects malformed campaign codes before preview/redemption", async () => {
    const rpc = vi.fn();
    mocks.client.mockResolvedValue({ rpc });
    const result = await createCommercialV1Checkout(
      "cybersecurity-foundations",
      "bad code!",
    );
    expect(result).toEqual({ ok: false, code: "CODE_UNAVAILABLE" });
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.getCommerceProvider).not.toHaveBeenCalled();
  });
});
