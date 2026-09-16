import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { COMMERCIAL_V1_COMMERCE_POLICY } from "@/domain/commercial-v1-commerce";
import { commerceConfig } from "@/lib/env";
import { createSupabase } from "../supabase";
import type { VerifiedCheckout } from "@/domain/commercial-v1-commerce";

// This module is the COMMERCIAL_V1_COMMERCE_V1 trusted controller's
// transport, mirroring src/server/commercial-v1-examiner-grading/
// authority.ts's own shape -- but the claim binds ORDER identity, not a
// live learner session (public.current_app_user()), because a Stripe
// webhook delivery has no session at all. Both the webhook route
// (src/app/api/commerce/stripe-webhook/route.ts) and the authenticated
// success-page reconciliation fallback call attestCommerceFulfillment with
// values THEY independently verified from Stripe first -- this module
// never trusts its own caller, it only produces the signed claim and
// relays fulfill_commercial_v1_order's own database-authoritative result.
export class CommerceFulfillmentUnavailable extends Error {
  constructor() {
    super("Commercial V1 commerce fulfillment is not configured.");
    this.name = "CommerceFulfillmentUnavailable";
  }
}

export async function attestCommerceFulfillment(checkout: VerifiedCheckout) {
  const env = commerceConfig();
  const keyId = z.uuid().safeParse(env.controllerKeyId);
  if (!env.controllerConfigured || !keyId.success) {
    throw new CommerceFulfillmentUnavailable();
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60;
  const canonical = [
    "DUCELIO_COMMERCE_FULFILLMENT_HMAC_SHA256_V1",
    COMMERCIAL_V1_COMMERCE_POLICY,
    keyId.data.toLowerCase(),
    checkout.provider,
    checkout.orderId.toLowerCase(),
    checkout.sessionId,
    checkout.eventId,
    String(checkout.amountMinor),
    checkout.currency,
    checkout.status,
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(env.controllerKeyHex, "hex"))
    .update(canonical, "utf8")
    .digest("hex");

  const client = await createSupabase();
  const { data, error } = await client.rpc("fulfill_commercial_v1_order", {
    p_key_id: keyId.data,
    p_order_id: checkout.orderId,
    p_provider: checkout.provider,
    p_session_id: checkout.sessionId,
    p_event_id: checkout.eventId,
    p_amount: checkout.amountMinor,
    p_currency: checkout.currency,
    p_status: checkout.status,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  });
  if (error) throw new CommerceFulfillmentUnavailable();
  return data as unknown;
}
