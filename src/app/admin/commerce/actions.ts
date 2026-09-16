"use server";
import {
  publishCommercialV1Offer,
  archiveCommercialV1Offer,
} from "@/server/commercial-v1-commerce";

export type CommerceAdminState = { error?: string; message?: string };

// V2 correction (finding 10): the smallest operational admin path to
// configure/publish and archive a sellable Commercial V1 offer. No new
// role, no duplicated course-authority logic -- both server functions
// reuse course_activation_private.require_admin() exactly like every
// other Commercial V1 publish surface.
export async function publishOfferAction(
  _state: CommerceAdminState,
  data: FormData,
): Promise<CommerceAdminState> {
  const priceInput = data.get("priceAmountMinor");
  const priceAmountMinor =
    typeof priceInput === "string" && priceInput.trim() !== ""
      ? Number(priceInput)
      : NaN;
  try {
    await publishCommercialV1Offer({
      activationId: data.get("activationId"),
      slug: data.get("slug"),
      priceAmountMinor,
      currency: data.get("currency"),
      summary: (data.get("summary") as string | null) || null,
      reason: data.get("reason"),
    });
    return {
      message:
        "Offer published. It is now visible on the public course catalogue.",
    };
  } catch {
    return {
      error:
        "The offer could not be published. Check the activation, slug, price, currency and reason, then try again.",
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
