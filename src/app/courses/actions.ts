"use server";
import { redirect } from "next/navigation";
import { createCommercialV1Checkout } from "@/server/commercial-v1-commerce";

export type CheckoutState = { error?: string };

export async function startCheckout(
  _state: CheckoutState,
  data: FormData,
): Promise<CheckoutState> {
  const slug = data.get("slug");
  if (typeof slug !== "string" || !slug) {
    return { error: "Choose a course to continue." };
  }
  const rawCode = data.get("campaignCode");
  const campaignCode =
    typeof rawCode === "string" && rawCode.trim() ? rawCode.trim() : undefined;

  let result;
  try {
    result = await createCommercialV1Checkout(slug, campaignCode);
  } catch {
    return { error: "Checkout is unavailable right now. Please try again." };
  }

  if (!result.ok) {
    if (result.code === "ALREADY_ENTITLED")
      return { error: "You already have access to this course." };
    if (result.code === "ALREADY_ENROLLED")
      return { error: "You are already enrolled in this course." };
    if (result.code === "ENROLMENT_REQUIRES_SUPPORT")
      return {
        error:
          "Your previous enrolment needs support review before access can change.",
      };
    if (result.code === "CODE_UNAVAILABLE")
      return {
        error: "That code is unavailable, expired or has reached its limit.",
      };
    if (result.code === "OFFER_ALREADY_REDEEMED")
      return {
        error: "A different campaign code has already been applied to this course.",
      };
    if (result.code === "CHECKOUT_ALREADY_STARTED")
      return {
        error:
          "A checkout has already been started for this course. Remove the code and continue the existing checkout.",
      };
    if (result.code === "CHECKOUT_UNAVAILABLE")
      return {
        error:
          "Card checkout is currently unavailable. Please try again later.",
      };
    return { error: "This course is not available for purchase." };
  }

  if (result.kind === "ACCESS_GRANTED") {
    redirect("/student/programme?access=granted");
  }
  redirect(result.url);
}
