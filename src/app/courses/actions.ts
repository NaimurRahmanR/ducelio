"use server";
import { redirect } from "next/navigation";
import { createCommercialV1Checkout } from "@/server/commercial-v1-commerce";

export type CheckoutState = { error?: string };

// Server action behind the public course page's "Buy now" form. Never
// simulates success -- either redirects to the real Stripe-hosted checkout
// URL the server just created, or returns a truthful error.
export async function startCheckout(
  _state: CheckoutState,
  data: FormData,
): Promise<CheckoutState> {
  const slug = data.get("slug");
  if (typeof slug !== "string" || !slug) {
    return { error: "Choose a course to continue." };
  }
  let result;
  try {
    result = await createCommercialV1Checkout(slug);
  } catch {
    return { error: "Checkout is unavailable right now. Please try again." };
  }
  if (!result.ok) {
    if (result.code === "ALREADY_ENTITLED")
      return { error: "You already have access to this course." };
    if (result.code === "CHECKOUT_UNAVAILABLE")
      return {
        error: "Checkout is currently unavailable. Please try again later.",
      };
    return { error: "This course is not available for purchase." };
  }
  redirect(result.url);
}
