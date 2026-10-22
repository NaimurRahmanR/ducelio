import "server-only";
import Stripe from "stripe";
import { commerceConfig } from "@/lib/env";
import type {
  CheckoutSessionStatus,
  CommerceProvider,
  CreateCheckoutInput,
  CreateCheckoutResult,
  RetrievedCheckout,
  VerifiedWebhookEvent,
  RetrievedPayment,
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

function mapSessionStatus(
  status: Stripe.Checkout.Session.Status | null,
): CheckoutSessionStatus | null {
  if (status === "open") return "OPEN";
  if (status === "complete") return "COMPLETE";
  if (status === "expired") return "EXPIRED";
  return null;
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
        metadata: input.orderKind
          ? { orderId: input.orderId, orderKind: input.orderKind }
          : { orderId: input.orderId },
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
      metadataOrderKind:
        session.metadata?.orderKind === "ACADEMY" ? "ACADEMY" : null,
      url: session.url,
      status: mapSessionStatus(session.status),
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
    return this.#mapEvent(event);
  }

  async retrieveWebhookEvent(eventId: string): Promise<VerifiedWebhookEvent> {
    return this.#mapEvent(await this.#stripe().events.retrieve(eventId));
  }

  #mapEvent(event: Stripe.Event): VerifiedWebhookEvent {
    if (
      event.type === "refund.updated" ||
      event.type === "refund.created" ||
      event.type === "refund.failed"
    ) {
      const refund = event.data.object as Stripe.Refund;
      return {
        eventId: event.id,
        eventType: event.type,
        subjectId:
          typeof refund.charge === "string" ? refund.charge : refund.charge?.id,
        paymentIntentId:
          typeof refund.payment_intent === "string"
            ? refund.payment_intent
            : (refund.payment_intent?.id ?? null),
        sessionId: "",
        paymentStatus: "UNPAID",
        amountMinor: null,
        currency: null,
        metadataOrderId: null,
      };
    }
    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      return {
        eventId: event.id,
        eventType: event.type,
        subjectId: charge.id,
        paymentIntentId:
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null),
        sessionId: "",
        paymentStatus: "UNPAID",
        amountMinor: null,
        currency: null,
        metadataOrderId: null,
      };
    }
    if (event.type !== "checkout.session.completed")
      return {
        eventId: event.id,
        eventType: event.type,
        sessionId: "",
        paymentStatus: "UNPAID",
        amountMinor: null,
        currency: null,
        metadataOrderId: null,
      };
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

  async retrievePayment(sessionId: string): Promise<RetrievedPayment> {
    const stripe = this.#stripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.latest_charge"],
    });
    const intent = session.payment_intent;
    const charge =
      intent && typeof intent !== "string" ? intent.latest_charge : null;
    const verifiedCharge =
      charge &&
      typeof charge !== "string" &&
      charge.paid &&
      charge.captured &&
      charge.currency === session.currency
        ? charge
        : null;
    let refundedMinor: number | null = null;
    let refundPending = false;
    if (verifiedCharge) {
      let cursor: string | undefined;
      let total = 0;
      for (let page = 0; page < 10; page++) {
        const refunds = await stripe.refunds.list({
          charge: verifiedCharge.id,
          limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
        });
        for (const refund of refunds.data) {
          if (refund.currency !== session.currency)
            throw new Error("REFUND_CURRENCY_MISMATCH");
          if (refund.status === "succeeded") total += refund.amount;
          else if (refund.status !== "failed" && refund.status !== "canceled")
            refundPending = true;
        }
        if (!refunds.has_more) {
          refundedMinor = total;
          break;
        }
        cursor = refunds.data.at(-1)?.id;
        if (!cursor) break;
      }
      if (refundedMinor === null) throw new Error("REFUND_SCAN_NOT_EXHAUSTED");
    }
    return {
      sessionId: session.id,
      paymentStatus: mapPaymentStatus(session.payment_status),
      amountMinor: session.amount_total,
      currency: session.currency?.toUpperCase() ?? null,
      metadataOrderId:
        session.metadata?.orderId ?? session.client_reference_id ?? null,
      metadataOrderKind:
        session.metadata?.orderKind === "ACADEMY" ? "ACADEMY" : null,
      url: session.url,
      status: mapSessionStatus(session.status),
      chargeId: verifiedCharge?.id ?? null,
      capturedMinor: verifiedCharge?.amount_captured ?? null,
      refundedMinor,
      refundPending,
    };
  }

  async findCheckoutForPaymentIntent(
    paymentIntentId: string,
  ): Promise<string | null> {
    const sessions = await this.#stripe().checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 2,
    });
    return !sessions.has_more && sessions.data.length === 1
      ? sessions.data[0].id
      : null;
  }

  async findCheckoutForOrder(
    orderId: string,
    createdAt: string,
  ): Promise<string | null> {
    let cursor: string | undefined;
    const matches: string[] = [];
    for (let page = 0; page < 10; page++) {
      const sessions = await this.#stripe().checkout.sessions.list({
        limit: 100,
        created: { gte: Math.floor(new Date(createdAt).getTime() / 1000) - 60 },
        ...(cursor ? { starting_after: cursor } : {}),
      });
      for (const session of sessions.data)
        if (
          (session.metadata?.orderId ?? session.client_reference_id) === orderId
        )
          matches.push(session.id);
      if (!sessions.has_more) return matches.length === 1 ? matches[0] : null;
      cursor = sessions.data.at(-1)?.id;
      if (!cursor) break;
    }
    throw new Error("SESSION_SCAN_NOT_EXHAUSTED");
  }
}
