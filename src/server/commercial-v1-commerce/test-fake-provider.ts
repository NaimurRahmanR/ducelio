import "server-only";
import { randomUUID } from "node:crypto";
import type {
  CommerceProvider,
  CreateCheckoutInput,
  CreateCheckoutResult,
  RetrievedCheckout,
  VerifiedWebhookEvent,
} from "./provider";
import type { PaymentStatus } from "@/domain/commercial-v1-commerce";

// TEST-ONLY deterministic fake, mirroring src/server/academic-runtime/
// test-fake-provider.ts's exact production-refusal shape: this class must
// be structurally unreachable in production. No production code path ever
// imports this module -- only test files do, and only through this
// explicit constructor (never through getCommerceProvider(), which always
// resolves to the real Stripe adapter).
export class FakeCommerceProviderAdapter implements CommerceProvider {
  #sessions = new Map<
    string,
    {
      orderId: string;
      orderKind: "ACADEMY" | null;
      amountMinor: number;
      currency: string;
      status: PaymentStatus;
      open: boolean;
      expired: boolean;
    }
  >();
  // V2 correction (finding 1): mirrors Stripe's own idempotency-key
  // behaviour -- a repeated createCheckoutSession call with the SAME
  // idempotencyKey returns the SAME session, never a second one.
  #idempotency = new Map<string, string>();
  #refunds = new Map<string, number>();

  setRefundedAmount(sessionId: string, amountMinor: number) {
    if (!this.#sessions.has(sessionId)) throw new Error("Unknown fake session");
    this.#refunds.set(sessionId, amountMinor);
  }

  async retrievePayment(sessionId: string) {
    const session = await this.retrieveCheckoutSession(sessionId);
    return {
      ...session,
      chargeId:
        session.paymentStatus === "PAID" ? "ch_fake_" + sessionId : null,
      capturedMinor:
        session.paymentStatus === "PAID" ? session.amountMinor : null,
      refundedMinor: this.#refunds.get(sessionId) ?? 0,
      refundPending: false,
    };
  }

  async findCheckoutForPaymentIntent(paymentIntentId: string) {
    const sessionId = paymentIntentId.replace(/^pi_fake_/, "");
    return this.#sessions.has(sessionId) ? sessionId : null;
  }
  async findCheckoutForOrder(orderId: string, _createdAt: string) {
    void _createdAt;
    const matches = [...this.#sessions].filter(
      ([, session]) => session.orderId === orderId,
    );
    return matches.length === 1 ? matches[0][0] : null;
  }
  async retrieveWebhookEvent(_eventId: string): Promise<VerifiedWebhookEvent> {
    void _eventId;
    throw new Error("Use a test event fixture");
  }

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "FakeCommerceProviderAdapter must never run in production.",
      );
    }
  }

  // Test helper: mark a session paid/unpaid as if Stripe had settled it,
  // without any network call.
  setSessionStatus(sessionId: string, status: PaymentStatus) {
    const existing = this.#sessions.get(sessionId);
    if (!existing) throw new Error(`Unknown fake session ${sessionId}`);
    existing.status = status;
  }

  // Test helper: simulate a session that is no longer open/payable
  // (expired, or already completed and closed by Stripe) -- retrieval
  // still succeeds but url becomes null, exactly like a real closed
  // Stripe session.
  closeSession(sessionId: string) {
    const existing = this.#sessions.get(sessionId);
    if (!existing) throw new Error(`Unknown fake session ${sessionId}`);
    existing.open = false;
  }

  // Test helper: simulate Stripe expiring an unpaid session (default 24
  // hours after creation): no URL, lifecycle status EXPIRED.
  expireSession(sessionId: string) {
    const existing = this.#sessions.get(sessionId);
    if (!existing) throw new Error(`Unknown fake session ${sessionId}`);
    existing.open = false;
    existing.expired = true;
  }

  async expireCheckoutSession(sessionId: string) {
    const current = await this.retrieveCheckoutSession(sessionId);
    if (current.status !== "OPEN" || current.paymentStatus !== "UNPAID")
      throw new Error("Not expirable");
    this.expireSession(sessionId);
    return this.retrieveCheckoutSession(sessionId);
  }

  // Test helper: simulate Stripe pruning an idempotency key (about 24
  // hours), after which the same key creates a NEW session.
  forgetIdempotencyKey(idempotencyKey: string) {
    this.#idempotency.delete(idempotencyKey);
  }

  async createCheckoutSession(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const reused = this.#idempotency.get(input.idempotencyKey);
    if (reused) {
      const session = this.#sessions.get(reused);
      if (session) {
        return {
          sessionId: reused,
          url: `https://checkout.fake.test/${reused}`,
        };
      }
    }
    const sessionId = `cs_test_fake_${randomUUID().replaceAll("-", "")}`;
    this.#sessions.set(sessionId, {
      orderId: input.orderId,
      orderKind: input.orderKind ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "UNPAID",
      open: true,
      expired: false,
    });
    this.#idempotency.set(input.idempotencyKey, sessionId);
    return { sessionId, url: `https://checkout.fake.test/${sessionId}` };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<RetrievedCheckout> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return {
        sessionId,
        paymentStatus: "UNPAID",
        amountMinor: null,
        currency: null,
        metadataOrderId: null,
        url: null,
        status: null,
      };
    }
    return {
      sessionId,
      paymentStatus: session.status,
      amountMinor: session.amountMinor,
      currency: session.currency,
      metadataOrderId: session.orderId,
      metadataOrderKind: session.orderKind,
      url: session.open ? `https://checkout.fake.test/${sessionId}` : null,
      status: session.open ? "OPEN" : session.expired ? "EXPIRED" : "COMPLETE",
    };
  }

  // Test helper: simulate a Stripe webhook delivery for a session already
  // created via createCheckoutSession. Ignores rawBody/signatureHeader
  // entirely (there is no real signature in tests) -- callers that need to
  // prove signature-rejection behaviour test the REAL StripeCommerceProvider
  // directly with a forged signature instead (see
  // tests/commercial-v1-commerce-provider.test.ts).
  async verifyWebhookEvent(
    _rawBody: string,
    _signatureHeader: string | null,
  ): Promise<VerifiedWebhookEvent | null> {
    void _rawBody;
    void _signatureHeader;
    return null;
  }

  // Test helper mirroring a real webhook delivery's shape, used directly by
  // fixtures instead of going through verifyWebhookEvent (which has no
  // real signature to check in tests).
  fakeWebhookEventFor(sessionId: string): VerifiedWebhookEvent {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fake session ${sessionId}`);
    return {
      eventId: `evt_test_fake_${randomUUID()}`,
      sessionId,
      paymentStatus: session.status,
      amountMinor: session.amountMinor,
      currency: session.currency,
      metadataOrderId: session.orderId,
    };
  }

  // Test helper: an event that is missing amount/currency, simulating a
  // provider response with incomplete payment evidence.
  fakeIncompleteWebhookEventFor(sessionId: string): VerifiedWebhookEvent {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fake session ${sessionId}`);
    return {
      eventId: `evt_test_fake_${randomUUID()}`,
      sessionId,
      paymentStatus: session.status,
      amountMinor: null,
      currency: null,
      metadataOrderId: session.orderId,
    };
  }
}
