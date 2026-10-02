import { beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  retrieve: vi.fn(),
  sessions: vi.fn(),
  refunds: vi.fn(),
  event: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class Stripe {
    checkout = { sessions: { retrieve: sdk.retrieve, list: sdk.sessions } };
    refunds = { list: sdk.refunds };
    events = { retrieve: sdk.event };
  },
}));
vi.mock("@/lib/env", () => ({
  commerceConfig: () => ({
    stripeConfigured: true,
    stripeSecretKey: "sk_test_not_real",
  }),
}));
import { StripeCommerceProvider } from "@/server/commercial-v1-commerce/stripe-provider";
beforeEach(() => {
  vi.resetAllMocks();
  sdk.retrieve.mockResolvedValue({
    id: "cs_one",
    payment_status: "paid",
    amount_total: 100,
    currency: "gbp",
    metadata: { orderId: "order" },
    url: null,
    payment_intent: {
      latest_charge: {
        id: "ch_one",
        paid: true,
        captured: true,
        amount_captured: 100,
        amount_refunded: 100,
        currency: "gbp",
      },
    },
  });
  sdk.refunds.mockResolvedValue({ data: [], has_more: false });
});
describe("Stripe operational reads (SDK fake, no network)", () => {
  it("counts only succeeded refunds, not failed or cancelled requests", async () => {
    sdk.refunds.mockResolvedValue({
      data: [
        { id: "re_1", status: "succeeded", amount: 40, currency: "gbp" },
        { id: "re_2", status: "failed", amount: 60, currency: "gbp" },
        { id: "re_3", status: "canceled", amount: 60, currency: "gbp" },
      ],
      has_more: false,
    });
    expect(
      await new StripeCommerceProvider().retrievePayment("cs_one"),
    ).toMatchObject({
      refundedMinor: 40,
      refundPending: false,
      capturedMinor: 100,
    });
  });
  it("marks pending refund evidence separately so callers cannot revoke or fulfil", async () => {
    sdk.refunds.mockResolvedValue({
      data: [
        { id: "re_pending", status: "pending", amount: 100, currency: "gbp" },
      ],
      has_more: false,
    });
    expect(
      await new StripeCommerceProvider().retrievePayment("cs_one"),
    ).toMatchObject({ refundedMinor: 0, refundPending: true });
  });
  it("walks refunds pages before claiming a fully refunded amount", async () => {
    sdk.refunds
      .mockResolvedValueOnce({
        data: [
          { id: "re_1", status: "succeeded", amount: 40, currency: "gbp" },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          { id: "re_2", status: "succeeded", amount: 60, currency: "gbp" },
        ],
        has_more: false,
      });
    expect(
      (await new StripeCommerceProvider().retrievePayment("cs_one"))
        .refundedMinor,
    ).toBe(100);
    expect(sdk.refunds).toHaveBeenLastCalledWith({
      charge: "ch_one",
      limit: 100,
      starting_after: "re_1",
    });
  });
  it("fails closed on an unexhausted refund scan", async () => {
    sdk.refunds.mockResolvedValue({
      data: [
        { id: "re_more", status: "succeeded", amount: 1, currency: "gbp" },
      ],
      has_more: true,
    });
    await expect(
      new StripeCommerceProvider().retrievePayment("cs_one"),
    ).rejects.toThrow("REFUND_SCAN_NOT_EXHAUSTED");
    expect(sdk.refunds).toHaveBeenCalledTimes(10);
  });
  it("does not invent captured payment evidence if expansion is missing", async () => {
    sdk.retrieve.mockResolvedValue({
      id: "cs_one",
      payment_status: "paid",
      amount_total: 100,
      currency: "gbp",
      metadata: { orderId: "order" },
      url: null,
      payment_intent: "pi_unexpanded",
    });
    expect(
      await new StripeCommerceProvider().retrievePayment("cs_one"),
    ).toMatchObject({
      chargeId: null,
      capturedMinor: null,
      refundedMinor: null,
    });
  });
  it("refuses ambiguous session mapping for a payment intent", async () => {
    sdk.sessions.mockResolvedValue({
      data: [{ id: "cs_one" }, { id: "cs_two" }],
      has_more: false,
    });
    expect(
      await new StripeCommerceProvider().findCheckoutForPaymentIntent("pi_one"),
    ).toBeNull();
  });
  it("unbound-order search must exhaust the bounded listing even after finding a match", async () => {
    sdk.sessions
      .mockResolvedValueOnce({
        data: [{ id: "cs_one", metadata: { orderId: "order" } }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "cs_two", metadata: { orderId: "order" } }],
        has_more: false,
      });
    expect(
      await new StripeCommerceProvider().findCheckoutForOrder(
        "order",
        "2026-10-01T00:00:00Z",
      ),
    ).toBeNull();
  });
  it("event retry returns only the bounded authenticated Stripe envelope", async () => {
    sdk.event.mockResolvedValue({
      id: "evt_one",
      type: "refund.updated",
      data: {
        object: {
          id: "re_one",
          charge: "ch_one",
          payment_intent: "pi_one",
          metadata: { secret: "never returned" },
        },
      },
    });
    const event = await new StripeCommerceProvider().retrieveWebhookEvent(
      "evt_one",
    );
    expect(event).toMatchObject({
      eventType: "refund.updated",
      subjectId: "ch_one",
      paymentIntentId: "pi_one",
    });
    expect(JSON.stringify(event)).not.toContain("never returned");
  });
});
