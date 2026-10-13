import "server-only";
import { z } from "zod";
import {
  commercialV1OfferResultSchema,
  commercialV1OfferListSchema,
  publishCommercialV1OfferInputSchema,
  archiveCommercialV1OfferInputSchema,
  commercialV1OfferActivationListSchema,
  createCommercialV1OrderResultSchema,
  commercialV1OrderProjectionSchema,
  fulfillCommercialV1OrderResultSchema,
  reconcileCommercialV1OrderResultSchema,
  offerSlugSchema,
  currencyCodeSchema,
  commercialV1CampaignPreviewSchema,
  commercialV1CampaignRedemptionSchema,
  commercialV1CampaignAdminListSchema,
} from "@/domain/commercial-v1-commerce";
import {
  archiveCommercialV1CampaignInputSchema,
  campaignCodeSchema,
  createCommercialV1CampaignInputSchema,
} from "@/domain/commercial-v1-launch";
import { requireActor } from "../identity";
import { createSupabase } from "../supabase";
import { config, commerceConfig } from "@/lib/env";
import { getCommerceProvider } from "./provider";
import { attestCommerceFulfillment } from "./authority";
import { attestCheckoutSessionReplacement } from "./operations-authority";

export async function listCommercialV1Offers() {
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_commercial_v1_offers");
  if (error) throw new Error("Courses could not be loaded.");
  return commercialV1OfferListSchema.parse(data);
}

export async function getCommercialV1Offer(slug: unknown) {
  const parsedSlug = offerSlugSchema.parse(slug);
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_commercial_v1_offer", {
    p_slug: parsedSlug,
  });
  if (error) throw new Error("Course could not be loaded.");
  return commercialV1OfferResultSchema.parse(data);
}

// Governed admin surface: only ACADEMIC_ADMIN/PLATFORM_ADMIN may publish
// (course_activation_private.require_admin() inside the RPC). No caller-
// supplied score/rank/entitlement field exists on this input schema.
export async function publishCommercialV1Offer(input: unknown) {
  const payload = publishCommercialV1OfferInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("publish_commercial_v1_offer", {
    p_activation_id: payload.activationId,
    p_slug: payload.slug,
    p_price_amount_minor: payload.priceAmountMinor,
    p_currency: payload.currency,
    p_summary: payload.summary ?? null,
    p_delivery_plan: payload.deliveryPlan,
    p_reason: payload.reason,
  });
  if (error) throw new Error("The course offer could not be published.");
  return z.uuid().parse(data);
}

export async function archiveCommercialV1Offer(input: unknown) {
  const payload = archiveCommercialV1OfferInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("archive_commercial_v1_offer", {
    p_slug: payload.slug,
    p_reason: payload.reason,
  });
  if (error) throw new Error("The course offer could not be archived.");
  return z.uuid().parse(data);
}

// V2 correction (finding 10): the smallest operational admin read needed to
// actually use publishCommercialV1Offer.
export async function listCommercialV1OfferActivations() {
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_commercial_v1_offer_activations",
  );
  if (error) throw new Error("Activations could not be loaded.");
  return commercialV1OfferActivationListSchema.parse(data);
}

export async function listCommercialV1Campaigns() {
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_commercial_v1_campaigns");
  if (error) throw new Error("Campaigns could not be loaded.");
  return commercialV1CampaignAdminListSchema.parse(data);
}

export async function createCommercialV1Campaign(input: unknown) {
  const payload = createCommercialV1CampaignInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const percentOff = payload.kind === "PERCENT_OFF" ? payload.percentOff : null;
  const fixedPriceAmountMinor =
    payload.kind === "FIXED_PRICE"
      ? payload.fixedPriceAmountMinor
      : payload.kind === "REVIEWER_COMPLIMENTARY"
        ? 0
        : null;
  const { data, error } = await client.rpc("create_commercial_v1_campaign", {
    p_offer_slug: payload.offerSlug,
    p_code: payload.code,
    p_kind: payload.kind,
    p_percent_off: percentOff,
    p_fixed_price_amount_minor: fixedPriceAmountMinor,
    p_max_redemptions: payload.maxRedemptions,
    p_starts_at: payload.startsAt,
    p_ends_at: payload.endsAt,
    p_reason: payload.reason,
  });
  if (error) throw new Error("The campaign could not be created.");
  return z.uuid().parse(data);
}

export async function archiveCommercialV1Campaign(input: unknown) {
  const payload = archiveCommercialV1CampaignInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("archive_commercial_v1_campaign", {
    p_code: payload.code,
    p_reason: payload.reason,
  });
  if (error) throw new Error("The campaign could not be archived.");
  return z.uuid().parse(data);
}

export async function getCommercialV1OrderStatus(orderId: unknown) {
  const id = z.uuid().parse(orderId);
  await requireActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_commercial_v1_order", {
    p_order_id: id,
  });
  if (error) throw new Error("The order could not be loaded.");
  return commercialV1OrderProjectionSchema.parse(data);
}

export type CommercialV1CheckoutResult =
  | { ok: true; kind: "CHECKOUT"; url: string; orderId: string }
  | {
      ok: true;
      kind: "ACCESS_GRANTED";
      entitlementId: string;
      enrolmentId: string;
      offerSlug: string;
    }
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "NOT_FOUND_OR_FORBIDDEN"
        | "ALREADY_ENTITLED"
        | "ALREADY_ENROLLED"
        | "ENROLMENT_REQUIRES_SUPPORT"
        | "CODE_UNAVAILABLE"
        | "OFFER_ALREADY_REDEEMED"
        | "CHECKOUT_ALREADY_STARTED"
        | "CHECKOUT_UNAVAILABLE";
    };

const attachResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), orderId: z.uuid() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string(),
    existingSessionId: z.string().optional(),
  }),
]);

export async function createCommercialV1Checkout(
  offerSlug: unknown,
  campaignCode?: unknown,
): Promise<CommercialV1CheckoutResult> {
  const slug = offerSlugSchema.parse(offerSlug);
  const actor = await requireActor("student");
  const client = await createSupabase();

  let order:
    | {
        orderId: string;
        amountMinor: number;
        currency: string;
        offerSlug: string;
        activationId: string;
        reused: boolean;
      }
    | undefined;

  const rawCode = typeof campaignCode === "string" ? campaignCode.trim() : "";
  if (rawCode) {
    const parsedCode = campaignCodeSchema.safeParse(rawCode);
    if (!parsedCode.success) {
      return { ok: false, code: "CODE_UNAVAILABLE" };
    }

    const { data: previewData, error: previewError } = await client.rpc(
      "preview_commercial_v1_campaign",
      { p_offer_slug: slug, p_code: parsedCode.data },
    );
    if (previewError) throw new Error("Campaign could not be checked.");
    const preview = commercialV1CampaignPreviewSchema.parse(previewData);
    if (!preview.ok) return preview;

    // A zero-price reviewer-complimentary path never depends on Stripe. Any path
    // that will charge money fails before consuming its redemption when the
    // payment/controller integration is unavailable.
    if (preview.effectivePriceAmountMinor > 0 && !commerceConfig().configured) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
    }

    const { data: redemptionData, error: redemptionError } = await client.rpc(
      "redeem_commercial_v1_campaign",
      { p_offer_slug: slug, p_code: parsedCode.data },
    );
    if (redemptionError) throw new Error("Campaign could not be redeemed.");
    const redemption =
      commercialV1CampaignRedemptionSchema.parse(redemptionData);
    if (!redemption.ok) return redemption;
    if (redemption.path === "ACCESS_GRANTED") {
      return {
        ok: true,
        kind: "ACCESS_GRANTED",
        entitlementId: redemption.entitlementId,
        enrolmentId: redemption.enrolmentId,
        offerSlug: redemption.offerSlug,
      };
    }
    order = {
      orderId: redemption.orderId,
      amountMinor: redemption.effectivePriceAmountMinor,
      currency: redemption.currency,
      offerSlug: redemption.offerSlug,
      activationId: redemption.activationId,
      reused: redemption.reused,
    };
  } else {
    if (!commerceConfig().configured) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
    }
    const { data, error } = await client.rpc("create_commercial_v1_order", {
      p_offer_slug: slug,
    });
    if (error) throw new Error("Checkout could not be started.");
    const created = createCommercialV1OrderResultSchema.parse(data);
    if (!created.ok) return created;
    order = created;
  }

  if (!order) {
    return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  }

  const env = config();
  const successUrl =
    env.appUrl +
    "/checkout/success?order=" +
    order.orderId +
    "&session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = env.appUrl + "/checkout/cancel?order=" + order.orderId;
  const offer = await getCommercialV1Offer(order.offerSlug);
  const offerTitle = offer.ok ? offer.title : "Ducelio course";

  const provider = await getCommerceProvider();
  let checkout: { sessionId: string; url: string };
  try {
    checkout = await provider.createCheckoutSession({
      orderId: order.orderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      offerTitle,
      successUrl,
      cancelUrl,
      idempotencyKey: "DUCELIO_COMMERCIAL_V1_ORDER:" + order.orderId,
    });
  } catch {
    return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  }

  const { data: attachData, error: attachError } = await client.rpc(
    "attach_commercial_v1_checkout_session",
    { p_order_id: order.orderId, p_session_id: checkout.sessionId },
  );
  if (attachError) throw new Error("Checkout could not be bound to the order.");
  const attachResult = attachResultSchema.parse(attachData);
  if (attachResult.ok) {
    return {
      ok: true,
      kind: "CHECKOUT",
      url: checkout.url,
      orderId: order.orderId,
    };
  }
  if (
    attachResult.code === "SESSION_ALREADY_BOUND" &&
    attachResult.existingSessionId
  ) {
    if (attachResult.existingSessionId === checkout.sessionId) {
      return {
        ok: true,
        kind: "CHECKOUT",
        url: checkout.url,
        orderId: order.orderId,
      };
    }
    try {
      const bound = await provider.retrieveCheckoutSession(
        attachResult.existingSessionId,
      );
      if (bound.url) {
        return {
          ok: true,
          kind: "CHECKOUT",
          url: bound.url,
          orderId: order.orderId,
        };
      }
      // LR-03 (migration 058): Stripe expired the bound session unpaid and
      // has since forgotten its idempotency key, so the call above created a
      // new session for this order. Only Stripe's own EXPIRED + UNPAID report
      // for a session of THIS order lets the attested replacement rebind the
      // order to the new session; every other closed state still fails
      // closed below.
      if (
        bound.status === "EXPIRED" &&
        bound.paymentStatus === "UNPAID" &&
        bound.metadataOrderId === order.orderId
      ) {
        const replaced = await attestCheckoutSessionReplacement({
          learnerId: actor.id,
          orderId: order.orderId,
          expiredSessionId: attachResult.existingSessionId,
          replacementSessionId: checkout.sessionId,
        });
        if (replaced.ok) {
          return {
            ok: true,
            kind: "CHECKOUT",
            url: checkout.url,
            orderId: order.orderId,
          };
        }
      }
    } catch {
      /* fail closed below */
    }
  }
  return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
}

// Authenticated success-page reconciliation fallback (section 6). NEVER
// trusts the redirect alone: retrieves the REAL Stripe checkout session
// server-side, independently confirms it references the SAME order, then
// converges on the exact same fulfillment authority the webhook uses.
//
// V2 correction (findings 3 & 6): never synthesises missing provider
// amount/currency (the DB order's own values are used only to COMPARE, not
// to replace missing evidence), and never attests a non-PAID observation --
// a synthetic SESSION_VERIFY provenance identity is created only once
// Stripe has independently returned PAID with complete evidence.
export async function reconcileCommercialV1Order(input: {
  orderId: unknown;
  sessionId: unknown;
}) {
  const orderId = z.uuid().parse(input.orderId);
  const sessionId = z.string().min(1).max(200).parse(input.sessionId);
  await requireActor();

  const status = await getCommercialV1OrderStatus(orderId);
  if (!status.ok) return status;
  if (status.order.accessRevoked)
    return { ok: false as const, code: "ACCESS_REVOKED" as const };
  if (status.order.orderRefunded)
    return { ok: false as const, code: "ORDER_REFUNDED" as const };
  if (status.order.state === "FULFILLED") {
    // A webhook (or an earlier reconciliation) already fulfilled this
    // order -- distinct UI wording from a first-time confirmation.
    return {
      ok: true as const,
      fulfilled: true as const,
      replay: true as const,
      orderId,
    };
  }

  const provider = await getCommerceProvider();
  const session = await provider.retrieveCheckoutSession(sessionId);
  if (session.metadataOrderId !== orderId) {
    return { ok: false as const, code: "MISMATCHED_SESSION" as const };
  }
  if (session.paymentStatus !== "PAID") {
    // Never call attestCommerceFulfillment for a non-PAID observation --
    // no synthetic payment-event provenance is ever created for a payment
    // that has not actually been confirmed.
    return {
      ok: true as const,
      fulfilled: false as const,
      code: "NOT_PAID" as const,
      orderId,
    };
  }
  if (session.amountMinor === null || session.currency === null) {
    // Fail-closed: the provider did not supply complete payment evidence.
    // The DB order's own amount/currency are never substituted in.
    return { ok: false as const, code: "INCOMPLETE_EVIDENCE" as const };
  }
  const currency = currencyCodeSchema.parse(session.currency);
  if (session.amountMinor !== status.order.amountMinor) {
    return { ok: false as const, code: "MISMATCHED_AMOUNT" as const };
  }
  if (currency !== status.order.currency) {
    return { ok: false as const, code: "MISMATCHED_CURRENCY" as const };
  }

  let attested;
  try {
    attested = await attestCommerceFulfillment({
      provider: "STRIPE",
      sessionId: session.sessionId,
      // The success page has no discrete webhook event id -- this
      // synthetic, session-scoped identifier still gives payment_events
      // its own idempotency key (a retried page load/reload reuses the
      // SAME identifier now that it is only ever created for a confirmed
      // PAID observation), while a later real webhook delivery for the
      // same session gets its OWN distinct event id, which is fine:
      // fulfillment itself is idempotent at the ORDER level regardless of
      // how many distinct provenance rows independently confirm the same
      // payment.
      eventId: "SESSION_VERIFY:" + session.sessionId,
      orderId,
      amountMinor: session.amountMinor,
      currency,
      status: session.paymentStatus,
    });
  } catch {
    return { ok: false as const, code: "CONFIGURATION_UNAVAILABLE" as const };
  }
  const result = fulfillCommercialV1OrderResultSchema.parse(attested);
  if (!result.ok) return { ok: false as const, code: result.code };
  if (!result.fulfilled)
    return {
      ok: true as const,
      fulfilled: false as const,
      code: result.code,
      orderId,
    };
  return reconcileCommercialV1OrderResultSchema.parse({
    ok: true,
    fulfilled: true,
    replay: result.replay,
    orderId: result.orderId,
  });
}
