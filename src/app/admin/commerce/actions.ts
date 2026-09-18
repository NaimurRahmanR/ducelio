"use server";
import {
  archiveCommercialV1Campaign,
  archiveCommercialV1Offer,
  createCommercialV1Campaign,
  publishCommercialV1Offer,
} from "@/server/commercial-v1-commerce";

export type CommerceAdminState = { error?: string; message?: string };

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
      deliveryPlan: data.get("deliveryPlan"),
      reason: data.get("reason"),
    });
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
      await createCommercialV1Campaign({
        ...base,
        kind,
        percentOff: numberField(data.get("percentOff")),
      });
    } else if (kind === "FIXED_PRICE") {
      await createCommercialV1Campaign({
        ...base,
        kind,
        fixedPriceAmountMinor: numberField(data.get("fixedPriceAmountMinor")),
      });
    } else {
      await createCommercialV1Campaign({
        ...base,
        kind: "REVIEWER_COMPLIMENTARY",
      });
    }
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
