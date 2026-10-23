"use server";
import { redirect } from "next/navigation";
import { createUnifiedCourseCheckout } from "@/server/academy-commerce";

export type AcademyCheckoutState = { error?: string };

const TEXT: Record<string, string> = {
  ALREADY_ENTITLED:
    "You already have access to this course. Open My Learning to continue.",
  ACCESS_REVOKED:
    "Your earlier access to this course was refunded or withdrawn. Contact support to review it.",
  SALE_NOT_OPEN: "This course is not open for purchase.",
  INVALID_FORMAT: "Choose one of the learning formats offered for this course.",
  CHECKOUT_UNAVAILABLE:
    "Card checkout is currently unavailable. Please try again later.",
  COUPON_UNAVAILABLE:
    "This coupon is invalid, expired, inactive, fully reserved or not valid for this course.",
  COUPON_NO_DISCOUNT:
    "This coupon cannot reduce this course's price in the selected currency.",
  COUPON_BELOW_MINIMUM_CHARGE:
    "This coupon would leave less than the minimum card payment for this course. It cannot be used here.",
  CHECKOUT_TERMS_LOCKED:
    "A checkout already exists for this course. Resume it or verify and cancel the unpaid checkout in My Learning before changing its terms.",
};

// The database calculates price, discount, ownership and eligibility. The
// browser supplies only a course slug and optional coupon.
export async function startAcademyCheckout(
  _state: AcademyCheckoutState,
  data: FormData,
): Promise<AcademyCheckoutState> {
  let url: string;
  try {
    const result = await createUnifiedCourseCheckout(
      data.get("slug"),
      data.get("couponCode"),
    );
    if (!result.ok)
      return {
        error:
          TEXT[result.code] ?? "This course is not available for purchase.",
      };
    url = result.url;
  } catch {
    return { error: TEXT.CHECKOUT_UNAVAILABLE };
  }
  redirect(url);
}
