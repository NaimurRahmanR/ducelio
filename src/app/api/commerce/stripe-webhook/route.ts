import { NextResponse, type NextRequest } from "next/server";
import { getCommerceProvider } from "@/server/commercial-v1-commerce/provider";
import {
  attestCommerceFulfillment,
  CommerceFulfillmentUnavailable,
} from "@/server/commercial-v1-commerce/authority";
import { currencyCodeSchema } from "@/domain/commercial-v1-commerce";

// Preferred production path (PR13, section 6): Stripe signed webhook ->
// signature verification (StripeCommerceProvider.verifyWebhookEvent, using
// STRIPE_WEBHOOK_SECRET) -> the SAME trusted fulfillment authority the
// authenticated success-page fallback converges on. This route accepts an
// UNAUTHENTICATED request by design (Stripe has no Ducelio session) --
// nothing privileged happens unless the Stripe signature verifies AND the
// resulting database-side HMAC claim verifies AND the order it names truly
// matches. The raw request body is read as text (never JSON-parsed first)
// because Stripe's signature covers the exact bytes delivered.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const provider = await getCommerceProvider();
  const event = await provider.verifyWebhookEvent(rawBody, signature);
  if (!event) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (!event.metadataOrderId || event.amountMinor === null || !event.currency) {
    // A genuinely Stripe-signed event this route does not have enough
    // bounded fact to reconcile. Fail closed and surface reconciliation
    // need rather than guessing -- never invent entitlement behaviour.
    return NextResponse.json({ received: true, reconciled: false });
  }
  const currency = currencyCodeSchema.safeParse(event.currency);
  if (!currency.success) {
    return NextResponse.json({ received: true, reconciled: false });
  }
  try {
    await attestCommerceFulfillment({
      provider: "STRIPE",
      sessionId: event.sessionId,
      eventId: event.eventId,
      orderId: event.metadataOrderId,
      amountMinor: event.amountMinor,
      currency: currency.data,
      status: event.paymentStatus,
    });
  } catch (error) {
    if (error instanceof CommerceFulfillmentUnavailable) {
      return NextResponse.json({ error: "Not configured" }, { status: 503 });
    }
    // A malformed orderId (e.g. tampered/forged metadata) fails zod
    // validation inside attestCommerceFulfillment's own RPC call chain --
    // this is never treated as a retryable server error.
    return NextResponse.json({ received: true, reconciled: false });
  }
  // Always 200 once the signature verifies, per Stripe's own webhook
  // guidance -- the database result (matched/mismatched/not-paid/replay)
  // is institutional truth, not something this route re-litigates or
  // exposes back to an unauthenticated caller.
  return NextResponse.json({ received: true });
}
