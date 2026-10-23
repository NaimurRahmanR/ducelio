"use server";
import { startAcademyCheckout } from "../academy/actions";
export type CheckoutState = { error?: string };
// Old links and bookmarked forms use the same unified authority.
export async function startCheckout(
  _state: CheckoutState,
  data: FormData,
): Promise<CheckoutState> {
  if (!data.get("couponCode") && data.get("campaignCode"))
    data.set("couponCode", String(data.get("campaignCode")));
  return startAcademyCheckout(_state, data);
}
