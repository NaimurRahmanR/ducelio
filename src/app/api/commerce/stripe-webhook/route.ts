import { NextResponse, type NextRequest } from "next/server";
import { getCommerceProvider } from "@/server/commercial-v1-commerce/provider";
import { processCommerceWebhook } from "@/server/commercial-v1-commerce/webhooks";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  try {
    const provider = await getCommerceProvider();
    const event = await provider.verifyWebhookEvent(rawBody, signature);
    if (!event)
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    const result = await processCommerceWebhook(event, provider);
    // Business/provider failures are durable and recoverable in Commerce.
    // Retry only if persistence failed; never silently acknowledge lost evidence.
    return NextResponse.json({ received: true, ...result });
  } catch {
    return NextResponse.json({ error: "Receipt unavailable" }, { status: 503 });
  }
}
