"use server";
import { redirect } from "next/navigation";
import { createAcademyCheckout } from "@/server/academy-commerce";

export type AcademyCheckoutState = { error?: string };

const TEXT: Record<string, string> = {
  ALREADY_ENTITLED:
    "You already have access to this course. Open My Academy courses to continue.",
  ACCESS_REVOKED:
    "Your earlier access to this course was refunded or withdrawn. Contact support to review it.",
  SALE_NOT_OPEN: "This course is not open for purchase.",
  INVALID_FORMAT: "Choose one of the learning formats offered for this course.",
  CHECKOUT_UNAVAILABLE:
    "Card checkout is currently unavailable. Please try again later.",
};

// The price, format, ownership and eligibility are decided by the database
// (create_academy_order); the browser only names the course and format.
export async function startAcademyCheckout(
  _state: AcademyCheckoutState,
  data: FormData,
): Promise<AcademyCheckoutState> {
  let url: string;
  try {
    const result = await createAcademyCheckout(
      data.get("slug"),
      data.get("formatId"),
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
