import "server-only";
import Stripe from "stripe";
import { commerceConfig } from "@/lib/env";
import type {
  CommerceProvider,
  CreateCheckoutInput,
  CreateCheckoutResult,
  RetrievedCheckout,
  VerifiedWebhookEvent,
} from "./provider";
import type { PaymentStatus } from "@/domain/commercial-v1-commerce";

// Code-owned production adapter (PR13, section 14). Never constructed by
// test code -- tests inject FakeCommerceProviderAdapter
// (./test-fake-provider.ts) directly, never this class. No apiVersion is
// pinned here: stripe-node (v12+) aligns outbound requests to the API
// version current when the installed package version was released, which
// is the SDK's own recommended default behaviour (docs.stripe.com/api/
// versioning) -- pinning a hand-typed version string here would risk
// silently drifting from what the installed SDK's TypeScript types
// actually describe.
function mapPaymentStatus(
  status: Stripe.Checkout.Session.PaymentStatus,
): PaymentStatus {
  if (status === "paid") return "PAID";
  if (status === "no_payment_required") return "NO_PAYMENT_REQUIRED";
  return "UNPAID";
}

export class StripeCommerceProvider implements CommerceProvider {
  #client: Stripe | null = null;

  #stripe(): Stripe {
    const env = commerceConfig();
    if (!env.stripeConfigured) {
      throw new Error("Stripe is not configured.");
    }
    if (!this.#client) this.#client = new Stripe(env.stripeSecretKey);
    return this.#client;
  }

  async createCheckoutSession(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const stripe = this.#stripe();
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        // V2 correction (finding 7): Commercial V1 launch scope is
        // deliberately ONE-TIME CARD CHECKOUT ONLY -- no Klarna, bank
        // transfer, other asynchronous/delayed-settlement methods,
        // subscriptions or installment logic. Explicit rather than relying
        // on Stripe's dashboard-configured dynamic payment-method
        // selection, which could otherwise offer a method whose webhook
        // behaviour this checkpoint does not handle.
        payment_method_types: ["card"],
        client_reference_id: input.orderId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // Opaque reconciliation hint only -- never trusted as sole proof of
        // identity/amount/entitlement/course mapping. The database order row
        // (looked up by client_reference_id / metadata.orderId) remains
        // authoritative for those.
        metadata: { orderId: input.orderId },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: input.offerTitle },
            },
          },
        ],
      },
      // V2 correction (finding 1): Stripe's own idempotency mechanism --
      // retrying checkout creation for the SAME order (double-click,
      // reused PENDING order across tabs, a transient network retry)
      // returns the SAME session object from Stripe itself, never a
      // second independent payable session.
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return { sessionId: session.id, url: session.url };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<RetrievedCheckout> {
    const stripe = this.#stripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      sessionId: session.id,
      paymentStatus: mapPaymentStatus(session.payment_status),
      amountMinor: session.amount_total,
      currency: session.currency ? session.currency.toUpperCase() : null,
      metadataOrderId:
        session.metadata?.orderId ?? session.client_reference_id ?? null,
      url: session.url,
    };
  }

  async verifyWebhookEvent(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<VerifiedWebhookEvent | null> {
    const env = commerceConfig();
    if (!env.stripeConfigured || !signatureHeader) return null;
    const stripe = this.#stripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        env.stripeWebhookSecret,
      );
    } catch {
      return null;
    }
    if (event.type !== "checkout.session.completed") return null;
    const session = event.data.object as Stripe.Checkout.Session;
    return {
      eventId: event.id,
      sessionId: session.id,
      paymentStatus: mapPaymentStatus(session.payment_status),
      amountMinor: session.amount_total,
      currency: session.currency ? session.currency.toUpperCase() : null,
      metadataOrderId:
        session.metadata?.orderId ?? session.client_reference_id ?? null,
    };
  }
}
