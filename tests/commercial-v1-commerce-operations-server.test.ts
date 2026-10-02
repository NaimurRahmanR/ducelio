import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  requireAnyRole: vi.fn(),
  rpc: vi.fn(),
  provider: vi.fn(),
  fulfill: vi.fn(),
  operation: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireAnyRole: mocks.requireAnyRole }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/commercial-v1-commerce/provider", () => ({
  getCommerceProvider: mocks.provider,
}));
vi.mock("@/server/commercial-v1-commerce/authority", () => ({
  attestCommerceFulfillment: mocks.fulfill,
}));
vi.mock("@/server/commercial-v1-commerce/operations-authority", () => ({
  attestCommerceOperation: mocks.operation,
}));
import { FakeCommerceProviderAdapter } from "@/server/commercial-v1-commerce/test-fake-provider";
import {
  listCommerceOperations,
  diagnoseCommerceAccess,
  reconcileCommerceOrder,
  cancelCommerceAccess,
} from "@/server/commercial-v1-commerce/operations";
import { retryCommerceWebhook } from "@/server/commercial-v1-commerce/webhook-recovery";
import { POST } from "@/app/api/commerce/stripe-webhook/route";
import {
  commerceSignedOperationSchema,
  type CommerceDiagnosis,
} from "@/domain/commercial-v1-commerce-operations";
const orderId = "10000000-0000-4000-8000-000000000001",
  actorId = "20000000-0000-4000-8000-000000000001",
  entitlementId = "30000000-0000-4000-8000-000000000001";
let provider: FakeCommerceProviderAdapter,
  sessionId: string,
  diagnosis: CommerceDiagnosis;
const input = { id: orderId, reason: "Investigate stranded checkout" };
function request() {
  return new NextRequest("http://localhost/api/commerce/stripe-webhook", {
    method: "POST",
    body: "signed body",
    headers: { "stripe-signature": "test" },
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network allowed in commerce tests");
    }),
  );
  provider = new FakeCommerceProviderAdapter();
  sessionId = (
    await provider.createCheckoutSession({
      orderId,
      amountMinor: 19900,
      currency: "GBP",
      offerTitle: "Course",
      successUrl: "http://localhost/success",
      cancelUrl: "http://localhost/cancel",
      idempotencyKey: orderId,
    })
  ).sessionId;
  provider.setSessionStatus(sessionId, "PAID");
  diagnosis = {
    learnerId: actorId,
    learnerName: "Learner",
    offerId: entitlementId,
    offerSlug: "test-course",
    courseTitle: "Test course",
    versionLabel: "v1",
    programmeVersionId: entitlementId,
    cohortId: entitlementId,
    cohortTitle: "Cohort",
    activationId: entitlementId,
    orderId,
    orderState: "PENDING",
    orderCreatedAt: new Date().toISOString(),
    sessionId,
    amountMinor: 19900,
    currency: "GBP",
    paymentConfirmed: false,
    refunded: false,
    fulfilmentAttempted: false,
    entitlementId: null,
    entitlementState: null,
    entitlementSource: null,
    entitlementOrderId: null,
    revocationReason: null,
    enrolmentId: null,
    enrolmentStatus: null,
    enrolmentOrigin: null,
    hasAccess: true,
    accessReason: "ACCESS_ACTIVE",
    reconciliationState: "NO_CONFIRMED_FULFILMENT",
    payments: [],
    audit: [],
    paymentsTruncated: false,
    auditTruncated: false,
  };
  mocks.requireAnyRole.mockResolvedValue({
    id: actorId,
    roles: ["ACADEMIC_ADMIN"],
  });
  mocks.provider.mockResolvedValue(provider);
  mocks.rpc.mockImplementation(async (name: string) => ({
    data:
      name === "admin_diagnose_commercial_v1_access"
        ? diagnosis
        : name === "admin_list_commercial_v1_operations"
          ? { rows: [], hasMore: false }
          : name === "admin_prepare_commercial_v1_webhook_retry"
            ? "evt_saved"
            : { ok: true, code: "ACCESS_REVOKED" },
    error: null,
  }));
  mocks.fulfill.mockResolvedValue({
    ok: true,
    fulfilled: true,
    replay: false,
    orderId,
    entitlementId,
    enrolmentId: entitlementId,
    activationId: entitlementId,
  });
  mocks.operation.mockResolvedValue({ ok: true, code: "RECORDED" });
});
afterEach(() => vi.unstubAllGlobals());

describe("admin commerce server", () => {
  it("authorises bounded reads and parses only the reviewed projection", async () => {
    await listCommerceOperations({
      view: "orders",
      query: "Learner",
      offset: 25,
    });
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_list_commercial_v1_operations",
      { p_view: "orders", p_query: "Learner", p_offset: 25 },
    );
  });
  it("unauthorised operators never reach the database or provider", async () => {
    mocks.requireAnyRole.mockRejectedValue(new Error("Access denied"));
    await expect(reconcileCommerceOrder(input)).rejects.toThrow("denied");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("rejects caller payment status, actor and amount overrides", async () => {
    await expect(
      reconcileCommerceOrder({ ...input, status: "PAID", actorId, amount: 0 }),
    ).rejects.toThrow();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("verifies payment through Stripe fake and uses the audited database wrapper", async () => {
    expect(await reconcileCommerceOrder(input)).toEqual({
      ok: true,
      code: "FULFILLED",
    });
    expect(mocks.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        sessionId,
        status: "PAID",
        amountMinor: 19900,
      }),
      input.reason,
    );
  });
  it("recovers an unbound original session without creating another checkout", async () => {
    diagnosis.sessionId = null;
    const create = vi.spyOn(provider, "createCheckoutSession");
    expect(await reconcileCommerceOrder(input)).toMatchObject({ ok: true });
    expect(create).not.toHaveBeenCalled();
  });
  it("audits an unpaid refusal and never attests paid evidence", async () => {
    provider.setSessionStatus(sessionId, "UNPAID");
    await reconcileCommerceOrder(input);
    expect(mocks.fulfill).not.toHaveBeenCalled();
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "OPERATOR_FAILURE",
        actorId,
        code: "NOT_PAID",
      }),
    );
  });
  it("never substitutes missing payment evidence", async () => {
    vi.spyOn(provider, "retrievePayment").mockResolvedValue({
      ...(await provider.retrievePayment(sessionId)),
      capturedMinor: null,
    });
    await reconcileCommerceOrder(input);
    expect(mocks.fulfill).not.toHaveBeenCalled();
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INCOMPLETE_EVIDENCE" }),
    );
  });
  it("rejects a different order's session", async () => {
    vi.spyOn(provider, "retrievePayment").mockResolvedValue({
      ...(await provider.retrievePayment(sessionId)),
      metadataOrderId: actorId,
    });
    await reconcileCommerceOrder(input);
    expect(mocks.fulfill).not.toHaveBeenCalled();
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MISMATCHED_SESSION" }),
    );
  });
  it("full refund attests revocation rather than fulfilment", async () => {
    provider.setRefundedAmount(sessionId, 19900);
    await reconcileCommerceOrder(input);
    expect(mocks.fulfill).not.toHaveBeenCalled();
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "REFUND",
        actorId,
        refundedMinor: 19900,
        orderId,
      }),
    );
  });
  it("partial refund goes to reviewed operator handling", async () => {
    provider.setRefundedAmount(sessionId, 100);
    await reconcileCommerceOrder(input);
    expect(mocks.fulfill).not.toHaveBeenCalled();
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PARTIAL_REFUND_REVIEW" }),
    );
  });
  it("manual cancellation calls an independently authorised database mutation", async () => {
    await cancelCommerceAccess({
      id: entitlementId,
      reason: "Approved access cancellation",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_revoke_commercial_v1_entitlement",
      {
        p_entitlement_id: entitlementId,
        p_reason: "Approved access cancellation",
      },
    );
  });
  it("strict diagnosis refuses an unexpected secret field", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...diagnosis, controllerKey: "secret" },
      error: null,
    });
    await expect(diagnoseCommerceAccess({ orderId })).rejects.toThrow();
  });
});

describe("durable commerce webhook route", () => {
  it("invalid signature cannot create a receipt", async () => {
    expect((await POST(request())).status).toBe(400);
    expect(mocks.operation).not.toHaveBeenCalled();
  });
  it("valid incomplete evidence leaves a receipt and durable unresolved reason, acknowledged without retries", async () => {
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue(
      provider.fakeIncompleteWebhookEventFor(sessionId),
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reconciled: false });
    expect(mocks.operation.mock.calls.map((c) => c[0].kind)).toEqual([
      "WEBHOOK_RECEIVED",
      "WEBHOOK_RESULT",
    ]);
    expect(mocks.operation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "UNRESOLVED",
        reason: "INCOMPLETE_EVIDENCE",
      }),
    );
  });
  it("persists receipt before a provider failure and acknowledges durable failure", async () => {
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue(
      provider.fakeWebhookEventFor(sessionId),
    );
    vi.spyOn(provider, "retrievePayment").mockRejectedValue(
      new Error("Provider unavailable"),
    );
    expect((await POST(request())).status).toBe(200);
    expect(mocks.operation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "UNRESOLVED",
        reason: "PROVIDER_UNAVAILABLE",
      }),
    );
  });
  it("database refusal of valid payment is visible instead of discarded", async () => {
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue(
      provider.fakeWebhookEventFor(sessionId),
    );
    mocks.fulfill.mockResolvedValue({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVATABLE",
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.operation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "UNRESOLVED",
        reason: "ENROLMENT_NOT_ACTIVATABLE",
      }),
    );
  });
  it("cannot acknowledge a lost receipt", async () => {
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue(
      provider.fakeWebhookEventFor(sessionId),
    );
    mocks.operation.mockRejectedValue(new Error("Database offline"));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it("duplicate delivery retains the same provider event identity", async () => {
    const event = provider.fakeWebhookEventFor(sessionId);
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue(event);
    await POST(request());
    await POST(request());
    expect(mocks.fulfill.mock.calls.map((c) => c[0].eventId)).toEqual([
      event.eventId,
      event.eventId,
    ]);
  });
  it("full refund events resolve by payment intent then fresh charge evidence", async () => {
    provider.setRefundedAmount(sessionId, 19900);
    vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue({
      eventId: "evt_refund",
      eventType: "charge.refunded",
      subjectId: "ch_fake_" + sessionId,
      paymentIntentId: "pi_fake_" + sessionId,
      sessionId: "",
      paymentStatus: "UNPAID",
      amountMinor: null,
      currency: null,
      metadataOrderId: null,
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.operation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "REFUND",
        orderId,
        refundedMinor: 19900,
      }),
    );
    expect(mocks.fulfill).not.toHaveBeenCalled();
  });
  it.each(["payment_intent.created", "v2.core.account.updated"])(
    "signed unsupported %s events are durably ignored without raw payloads",
    async (eventType) => {
      vi.spyOn(provider, "verifyWebhookEvent").mockResolvedValue({
        eventId: "evt_other",
        eventType,
        sessionId: "",
        paymentStatus: "UNPAID",
        amountMinor: null,
        currency: null,
        metadataOrderId: null,
      });
      expect((await POST(request())).status).toBe(200);
      expect(
        commerceSignedOperationSchema.parse(mocks.operation.mock.calls[0][0]),
      ).toMatchObject({ kind: "WEBHOOK_RECEIVED", eventType });
      expect(mocks.operation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "IGNORED",
          reason: "UNSUPPORTED_EVENT",
        }),
      );
    },
  );
  it("operator retry uses the stored event ID and records authority before Stripe retrieval", async () => {
    const event = {
      ...provider.fakeWebhookEventFor(sessionId),
      eventId: "evt_saved",
    };
    vi.spyOn(provider, "retrieveWebhookEvent").mockResolvedValue(event);
    expect(await retryCommerceWebhook(input)).toMatchObject({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_prepare_commercial_v1_webhook_retry",
      { p_receipt_id: orderId, p_reason: input.reason },
    );
    expect(provider.retrieveWebhookEvent).toHaveBeenCalledWith("evt_saved");
  });
});
