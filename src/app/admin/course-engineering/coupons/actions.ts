"use server";
import { revalidatePath } from "next/cache";
import {
  createCourseCoupon,
  setCourseCouponActive,
} from "@/server/course-coupons";
export type CouponState = { error?: string; message?: string };
const route = "/admin/course-engineering/coupons";
// "25" or "25.50" in major units -> 2500 / 2550 minor units, without floats.
// GBP, USD and EUR all use two decimal places.
function parseMajorAmount(value: unknown) {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}
export async function createCouponAction(
  _state: CouponState,
  form: FormData,
): Promise<CouponState> {
  try {
    const expiry = String(form.get("expiresAt") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiry))
      return { error: "Enter the expiry in UTC." };
    const kind = String(form.get("discountKind") ?? "PERCENT");
    let discount: Record<string, unknown>;
    if (kind === "AMOUNT") {
      const amountOffMinor = parseMajorAmount(form.get("amountOff"));
      if (!amountOffMinor)
        return {
          error: "Enter the fixed discount as an amount such as 25.00.",
        };
      discount = { amountOffMinor, currency: form.get("currency") };
    } else if (kind === "PERCENT")
      discount = { percentOff: Number(form.get("percentOff")) };
    else return { error: "Choose a percentage or fixed-amount discount." };
    await createCourseCoupon(
      {
        code: form.get("code"),
        ...discount,
        expiresAt: expiry + ":00Z",
        redemptionLimit: Number(form.get("redemptionLimit")),
        courseId: form.get("courseId") || null,
        reason: form.get("reason"),
      },
      form.get("organisationId")
        ? String(form.get("organisationId"))
        : undefined,
    );
    revalidatePath(route);
    return {
      message:
        "Coupon created. Its terms are fixed; availability can be changed below.",
    };
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message === "COUPON_CONFLICT"
          ? "This code already has different terms. Use a new code."
          : "Check the coupon, discount, future UTC expiry, limits and course restriction. A fixed amount must use the restricted course's currency.",
    };
  }
}
export async function toggleCouponAction(
  _state: CouponState,
  form: FormData,
): Promise<CouponState> {
  try {
    const value = String(form.get("active"));
    if (value !== "true" && value !== "false")
      return { error: "Invalid availability." };
    await setCourseCouponActive(
      form.get("couponId"),
      value === "true",
      String(form.get("reason") ?? ""),
    );
    revalidatePath(route);
    return {
      message:
        "Coupon availability updated. Reserved checkout terms and redemption evidence are preserved.",
    };
  } catch {
    return { error: "Coupon availability could not be changed." };
  }
}
