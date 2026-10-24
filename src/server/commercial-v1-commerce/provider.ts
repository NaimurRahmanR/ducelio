import "server-only";
import type { PaymentStatus } from "@/domain/commercial-v1-commerce";

// Provider-neutral commerce boundary (PR13, section 14). Stripe is the
// launch provider, but no page/action/route calls a Stripe SDK directly --
// every caller goes through this narrow interface. The domain/database use
// only bounded provider-safe concepts (provider='STRIPE'); no Stripe
// dependency exists in domain logic or the database schema beyond that
// identifier.
export type CreateCheckoutInput = {
  orderId: string;
  amountMinor: number;
  currency: string;
  offerTitle: string;
  successUrl: string;
  cancelUrl: string;
  // V2 correction (finding 1): a deterministic idempotency key derived
  // ONLY from Ducelio order identity (no PII) -- see
  // src/server/commercial-v1-commerce/index.ts. Retrying checkout creation
  // for the SAME order must make the provider return the SAME payable
  // session, never a second independent one.
  idempotencyKey: string;
  // Academy (B2C) orders live in their own ledger; the marker routes the
  // verified payment to the Academy fulfilment authority. Absent for cohort
  // orders, whose behaviour is unchanged.
  orderKind?: "ACADEMY";
};
export type CreateCheckoutResult = { sessionId: string; url: string };

export type RetrievedCheckout = {
  sessionId: string;
  paymentStatus: PaymentStatus;
  amountMinor: number | null;
  currency: string | null;
  metadataOrderId: string | null;
  metadataOrderKind?: "ACADEMY" | null;
  // Null once the session is no longer open/payable (expired, completed
  // and closed, etc.) -- never fabricated.
  url: string | null;
  // The provider's own session lifecycle. Only an EXPIRED, unpaid session
  // may be replaced (LR-03, migration 058); null when not reported.
  status: CheckoutSessionStatus | null;
};
export type CheckoutSessionStatus = "OPEN" | "COMPLETE" | "EXPIRED";

export type VerifiedWebhookEvent = {
  eventType?: string;
  subjectId?: string;
  paymentIntentId?: string | null;
  eventId: string;
  sessionId: string;
  paymentStatus: PaymentStatus;
  amountMinor: number | null;
  currency: string | null;
  metadataOrderId: string | null;
};

export type RetrievedPayment = RetrievedCheckout & {
  chargeId: string | null;
  capturedMinor: number | null;
  refundedMinor: number | null;
  refundPending: boolean;
};

export interface CommerceProvider {
  createCheckoutSession(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult>;
  retrieveCheckoutSession(sessionId: string): Promise<RetrievedCheckout>;
  expireCheckoutSession?(sessionId: string): Promise<RetrievedCheckout>;
  retrievePayment(sessionId: string): Promise<RetrievedPayment>;
  findCheckoutForPaymentIntent(paymentIntentId: string): Promise<string | null>;
  findCheckoutForOrder(
    orderId: string,
    createdAt: string,
  ): Promise<string | null>;
  retrieveWebhookEvent(eventId: string): Promise<VerifiedWebhookEvent>;
  // Returns null when the payload/signature does not verify as a genuine
  // Stripe checkout-completion event -- callers must treat null as "no
  // trusted fact", never fall back to trusting the payload anyway.
  verifyWebhookEvent(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<VerifiedWebhookEvent | null>;
}

// The ONLY production entrypoint. Always resolves to the code-owned Stripe
// adapter reading real configuration -- there is no parameter, environment
// switch or override that lets production code reach a test/fake adapter.
// Tests inject a fake adapter exclusively through
// tests/commercial-v1-commerce-fixture.ts's own explicit call sites, never
// through this function.
export async function getCommerceProvider(): Promise<CommerceProvider> {
  const { StripeCommerceProvider } = await import("./stripe-provider");
  return new StripeCommerceProvider();
}
