"use server";
import { revalidatePath } from "next/cache";
import {
  cancelCommerceAccess,
  reconcileCommerceOrder,
} from "@/server/commercial-v1-commerce/operations";
import { retryCommerceWebhook } from "@/server/commercial-v1-commerce/webhook-recovery";
import { accessReasonLabels } from "@/domain/commercial-v1-commerce-operations";
import {
  archiveCommercialV1Campaign,
  archiveCommercialV1Offer,
  createCommercialV1Campaign,
  publishCommercialV1Offer,
} from "@/server/commercial-v1-commerce";

export type CommerceAdminState = { error?: string; message?: string };

export async function commerceOperationAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  try {
    const input = { id: data.get("id"), reason: data.get("reason") };
    const kind = data.get("operation");
    if (kind === "revoke" && data.get("confirm") !== "yes")
      return { error: "Confirm the permanent access cancellation first." };
    const result =
      kind === "reconcile"
        ? await reconcileCommerceOrder(input)
        : kind === "revoke"
          ? await cancelCommerceAccess(input)
          : kind === "retry"
            ? await retryCommerceWebhook(input)
            : null;
    if (!result) return { error: "Choose a valid commerce operation." };
    revalidatePath("/admin/commerce");
    revalidatePath("/admin", "layout");
    const labels: Record<string, string> = {
      FULFILLED: "Payment verified and access fulfilled.",
      ALREADY_FULFILLED: "Already fulfilled. Active access confirmed.",
      ACCESS_REVOKED:
        "Access revoked. Financial and academic history retained.",
      ENTITLEMENT_REVOKED:
        "Commercial entitlement revoked. The independently created or historical enrolment status is retained.",
      ALREADY_REVOKED:
        "Entitlement was already revoked; no duplicate transition. Independent academic enrolment status is retained.",
      REFUNDED_NO_LINKED_ENTITLEMENT:
        "Full refund recorded. This order has no entitlement to revoke; future fulfilment is blocked.",
      WEBHOOK_RECONCILED:
        "Webhook reconciled. Inspect the linked order and audit for the outcome.",
      WEBHOOK_REMAINS_UNRESOLVED:
        "The event still needs attention. Its durable diagnostic reason has been refreshed.",
      WEBHOOK_RECOVERY_UNAVAILABLE:
        "Stripe event recovery is unavailable. Try order reconciliation or retry later.",
      NOT_PAID: "Stripe has not confirmed payment. No entitlement was granted.",
      REFUND_PENDING:
        "A Stripe refund is still pending. Access is unchanged; reconcile again after it settles.",
      ENROLMENT_NOT_ACTIVATABLE:
        "Payment is verified but the existing enrolment is not active. Resolve its academic status through the governed workflow; commerce cannot override it.",
      PARTIAL_REFUND_REVIEW:
        "Partial refund verified. Access is unchanged; decide whether to cancel access using the separate governed control.",
      PROVIDER_UNAVAILABLE_OR_SCAN_LIMIT:
        "Stripe is unavailable or the bounded session lookup could not finish. Retry later or investigate the Stripe Dashboard.",
      CHECKOUT_NOT_FOUND:
        "No unique Checkout Session was found. Verify the payment in the Stripe Dashboard.",
    };
    const message =
      labels[result.code] ??
      accessReasonLabels[result.code] ??
      `Operation refused (${result.code}). No access override was applied.`;
    return result.ok ? { message } : { error: message };
  } catch {
    return {
      error:
        "Commerce operation could not be completed. Check your authority, the reason and commerce configuration, then retry.",
    };
  }
}

function numberField(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : undefined;
}

export async function publishOfferAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  const priceAmountMinor = numberField(data.get("priceAmountMinor"));
  try {
    await publishCommercialV1Offer({
      activationId: data.get("activationId"),
      slug: data.get("slug"),
      priceAmountMinor,
      currency: data.get("currency"),
      summary: (data.get("summary") as string | null) || null,
      deliveryPlan: data.get("deliveryPlan") || undefined,
      reason: data.get("reason"),
    });
    revalidatePath("/admin/commerce");
    revalidatePath("/admin", "layout");
    revalidatePath("/courses");
    return {
      message:
        "Offer published. It is now visible on the public course catalogue.",
    };
  } catch {
    return {
      error:
        "The offer could not be published. Check the activation, slug, price, currency, delivery plan and reason, then try again.",
    };
  }
}

export async function archiveOfferAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  try {
    await archiveCommercialV1Offer({
      slug: data.get("slug"),
      reason: data.get("reason"),
    });
    revalidatePath("/admin/commerce");
    revalidatePath("/admin", "layout");
    revalidatePath("/courses");
    return {
      message:
        "Offer archived. It no longer appears on the public catalogue; existing orders/entitlements are unaffected.",
    };
  } catch {
    return {
      error: "The offer could not be archived. Check the slug and reason.",
    };
  }
}

export async function createCampaignAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  const kind = data.get("kind");
  const base = {
    offerSlug: data.get("offerSlug"),
    code: data.get("code"),
    maxRedemptions: numberField(data.get("maxRedemptions")),
    startsAt: data.get("startsAt"),
    endsAt: data.get("endsAt"),
    reason: data.get("reason"),
  };

  try {
    if (kind === "PERCENT_OFF") {
      const percentOff = numberField(data.get("percentOff"));
      if (percentOff === undefined || percentOff < 1 || percentOff > 99)
        return { error: "Promotional percentage discounts must be 1-99%." };
      await createCommercialV1Campaign({
        ...base,
        kind,
        percentOff,
      });
    } else if (kind === "FIXED_PRICE") {
      const fixedPriceAmountMinor = numberField(
        data.get("fixedPriceAmountMinor"),
      );
      if (fixedPriceAmountMinor === undefined || fixedPriceAmountMinor < 1)
        return {
          error:
            "Promotional fixed prices must remain above zero. Use reviewer complimentary for free reviewer access.",
        };
      await createCommercialV1Campaign({
        ...base,
        kind,
        fixedPriceAmountMinor,
      });
    } else if (kind === "REVIEWER_COMPLIMENTARY") {
      await createCommercialV1Campaign({
        ...base,
        kind,
      });
    } else {
      return { error: "Choose a valid campaign kind." };
    }
    revalidatePath("/admin/commerce");
    revalidatePath("/admin", "layout");
    return {
      message:
        "Campaign created. The code can now be redeemed within its configured window and limit.",
    };
  } catch {
    return {
      error:
        "The campaign could not be created. Check the offer, code, pricing, limit, UTC timestamps and reason.",
    };
  }
}

export async function archiveCampaignAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  try {
    await archiveCommercialV1Campaign({
      code: data.get("code"),
      reason: data.get("reason"),
    });
    revalidatePath("/admin/commerce");
    revalidatePath("/admin", "layout");
    return {
      message:
        "Campaign archived. Existing redemptions keep their immutable provenance.",
    };
  } catch {
    return {
      error: "The campaign could not be archived. Check the code and reason.",
    };
  }
}
