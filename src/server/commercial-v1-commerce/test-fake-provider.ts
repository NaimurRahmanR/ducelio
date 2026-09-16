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
      amountMinor: number;
      currency: string;
      status: PaymentStatus;
      open: boolean;
    }
  >();
  // V2 correction (finding 1): mirrors Stripe's own idempotency-key
  // behaviour -- a repeated createCheckoutSession call with the SAME
  // idempotencyKey returns the SAME session, never a second one.
  #idempotency = new Map<string, string>();

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
    const sessionId = `cs_test_fake_${randomUUID()}`;
    this.#sessions.set(sessionId, {
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "UNPAID",
      open: true,
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
      };
    }
    return {
      sessionId,
      paymentStatus: session.status,
      amountMinor: session.amountMinor,
      currency: session.currency,
      metadataOrderId: session.orderId,
      url: session.open ? `https://checkout.fake.test/${sessionId}` : null,
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
