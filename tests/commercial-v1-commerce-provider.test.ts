import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Stripe from "stripe";
const mocks = vi.hoisted(() => ({ commerceConfig: vi.fn() }));
vi.mock("@/lib/env", () => ({ commerceConfig: mocks.commerceConfig }));
import { FakeCommerceProviderAdapter } from "@/server/commercial-v1-commerce/test-fake-provider";
import { StripeCommerceProvider } from "@/server/commercial-v1-commerce/stripe-provider";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;
function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = value;
}
afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

describe("FakeCommerceProviderAdapter must never run in production", () => {
  it("constructs freely outside production", () => {
    setNodeEnv("test");
    expect(() => new FakeCommerceProviderAdapter()).not.toThrow();
  });
  it("refuses to construct under NODE_ENV=production", () => {
    setNodeEnv("production");
    expect(() => new FakeCommerceProviderAdapter()).toThrow(
      "must never run in production",
    );
  });
});

describe("FakeCommerceProviderAdapter deterministic behaviour", () => {
  it("round-trips a created session as UNPAID with a live url", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const created = await provider.createCheckoutSession({
      orderId: "order-1",
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Cybersecurity Foundations",
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-1",
    });
    const retrieved = await provider.retrieveCheckoutSession(created.sessionId);
    expect(retrieved.paymentStatus).toBe("UNPAID");
    expect(retrieved.amountMinor).toBe(19900);
    expect(retrieved.currency).toBe("GBP");
    expect(retrieved.metadataOrderId).toBe("order-1");
    expect(retrieved.url).toBe(created.url);
  });

  it("setSessionStatus/closeSession update PAID status and null the url once closed", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const created = await provider.createCheckoutSession({
      orderId: "order-2",
      amountMinor: 5000,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-2",
    });
    provider.setSessionStatus(created.sessionId, "PAID");
    let retrieved = await provider.retrieveCheckoutSession(created.sessionId);
    expect(retrieved.paymentStatus).toBe("PAID");
    expect(retrieved.url).not.toBeNull();
    provider.closeSession(created.sessionId);
    retrieved = await provider.retrieveCheckoutSession(created.sessionId);
    expect(retrieved.url).toBeNull();
  });

  it("V2 correction (item 1): a repeated createCheckoutSession call with the SAME idempotency key returns the SAME session, never a second one", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const input = {
      orderId: "order-3",
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-3",
    };
    const first = await provider.createCheckoutSession(input);
    const second = await provider.createCheckoutSession(input);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.url).toBe(first.url);
  });

  it("a DIFFERENT idempotency key always produces a DIFFERENT session", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const base = {
      orderId: "order-4",
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    };
    const first = await provider.createCheckoutSession({
      ...base,
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-4",
    });
    const second = await provider.createCheckoutSession({
      ...base,
      orderId: "order-5",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-5",
    });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("retrieving an unknown session id fails closed (UNPAID, no evidence, no url) rather than throwing", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const retrieved = await provider.retrieveCheckoutSession("cs_unknown");
    expect(retrieved).toEqual({
      sessionId: "cs_unknown",
      paymentStatus: "UNPAID",
      amountMinor: null,
      currency: null,
      metadataOrderId: null,
      url: null,
      status: null,
    });
  });

  it("fakeWebhookEventFor/fakeIncompleteWebhookEventFor mirror a real webhook delivery's shape", async () => {
    const provider = new FakeCommerceProviderAdapter();
    const created = await provider.createCheckoutSession({
      orderId: "order-6",
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-6",
    });
    provider.setSessionStatus(created.sessionId, "PAID");
    const event = provider.fakeWebhookEventFor(created.sessionId);
    expect(event).toMatchObject({
      sessionId: created.sessionId,
      paymentStatus: "PAID",
      amountMinor: 19900,
      currency: "GBP",
      metadataOrderId: "order-6",
    });
    const incomplete = provider.fakeIncompleteWebhookEventFor(
      created.sessionId,
    );
    expect(incomplete.amountMinor).toBeNull();
    expect(incomplete.currency).toBeNull();
  });

  it("verifyWebhookEvent always returns null (no real signature exists in tests) -- forged-signature behaviour is proven against the real adapter below", async () => {
    const provider = new FakeCommerceProviderAdapter();
    expect(await provider.verifyWebhookEvent("{}", "sig")).toBeNull();
  });
});

// V2 correction: test the REAL Stripe webhook verification adapter's
// signature-checking behaviour using the installed SDK's own local test
// helper (stripe.webhooks.generateTestHeaderString) -- pure HMAC
// verification, no network call. createCheckoutSession/
// retrieveCheckoutSession are NEVER exercised here (those would require a
// real network call) -- only verifyWebhookEvent's local signature check.
describe("StripeCommerceProvider webhook signature verification (real adapter, no network)", () => {
  const webhookSecret = "whsec_test_deterministic_secret_for_pr13";

  beforeEach(() => {
    mocks.commerceConfig.mockReturnValue({
      stripeSecretKey: "sk_test_deterministic",
      stripeWebhookSecret: webhookSecret,
      controllerKeyId: "11111111-0000-4000-8000-000000000001",
      controllerKeyHex: "a".repeat(64),
      stripeConfigured: true,
      controllerConfigured: true,
      configured: true,
    });
  });

  function signedPayload(body: unknown) {
    const payload = JSON.stringify(body);
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });
    return { payload, header };
  }

  it("accepts a genuinely, locally-signed checkout.session.completed event and maps its fields", async () => {
    const provider = new StripeCommerceProvider();
    const { payload, header } = signedPayload({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 19900,
          currency: "gbp",
          metadata: { orderId: "order-1" },
          client_reference_id: "order-1",
        },
      },
    });
    const event = await provider.verifyWebhookEvent(payload, header);
    expect(event).toEqual({
      eventId: "evt_test_123",
      sessionId: "cs_test_123",
      paymentStatus: "PAID",
      amountMinor: 19900,
      currency: "GBP",
      metadataOrderId: "order-1",
    });
  });

  it("rejects a forged/invalid signature", async () => {
    const provider = new StripeCommerceProvider();
    const payload = JSON.stringify({
      id: "evt_test_forged",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_forged", payment_status: "paid" } },
    });
    const event = await provider.verifyWebhookEvent(
      payload,
      "t=1,v1=0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(event).toBeNull();
  });

  it("rejects a missing signature header", async () => {
    const provider = new StripeCommerceProvider();
    expect(await provider.verifyWebhookEvent("{}", null)).toBeNull();
  });

  it("retains only a bounded envelope for a valid unsupported event so it can be durably ignored", async () => {
    const provider = new StripeCommerceProvider();
    const { payload, header } = signedPayload({
      id: "evt_test_other",
      type: "payment_intent.created",
      data: { object: { id: "pi_test", object: "payment_intent" } },
    });
    expect(await provider.verifyWebhookEvent(payload, header)).toEqual({
      eventId: "evt_test_other",
      eventType: "payment_intent.created",
      sessionId: "",
      paymentStatus: "UNPAID",
      amountMinor: null,
      currency: null,
      metadataOrderId: null,
    });
  });

  it("verifies a full or partial charge.refunded event without exposing raw charge data", async () => {
    const provider = new StripeCommerceProvider();
    const { payload, header } = signedPayload({
      id: "evt_refunded",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund",
          payment_intent: "pi_refund",
          amount_refunded: 19900,
          billing_details: { email: "never-render@example.test" },
        },
      },
    });
    const event = await provider.verifyWebhookEvent(payload, header);
    expect(event).toMatchObject({
      eventId: "evt_refunded",
      eventType: "charge.refunded",
      subjectId: "ch_refund",
      paymentIntentId: "pi_refund",
    });
    expect(JSON.stringify(event)).not.toContain("never-render");
    expect(event?.amountMinor).toBeNull();
  });

  it("when Stripe is not configured, verification returns null without attempting verification", async () => {
    mocks.commerceConfig.mockReturnValue({
      stripeSecretKey: "",
      stripeWebhookSecret: "",
      controllerKeyId: "",
      controllerKeyHex: "",
      stripeConfigured: false,
      controllerConfigured: false,
      configured: false,
    });
    const provider = new StripeCommerceProvider();
    const { payload, header } = signedPayload({
      id: "evt_x",
      type: "checkout.session.completed",
      data: { object: { id: "cs_x", payment_status: "paid" } },
    });
    expect(await provider.verifyWebhookEvent(payload, header)).toBeNull();
  });

  it("when Stripe is not configured, createCheckoutSession/retrieveCheckoutSession fail closed WITHOUT ever attempting a network call", async () => {
    mocks.commerceConfig.mockReturnValue({
      stripeSecretKey: "",
      stripeWebhookSecret: "",
      controllerKeyId: "",
      controllerKeyHex: "",
      stripeConfigured: false,
      controllerConfigured: false,
      configured: false,
    });
    const provider = new StripeCommerceProvider();
    await expect(
      provider.createCheckoutSession({
        orderId: "order-1",
        amountMinor: 19900,
        currency: "GBP",
        offerTitle: "Course",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/cancel",
        idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:order-1",
      }),
    ).rejects.toThrow("Stripe is not configured.");
    await expect(provider.retrieveCheckoutSession("cs_test_1")).rejects.toThrow(
      "Stripe is not configured.",
    );
  });
});
