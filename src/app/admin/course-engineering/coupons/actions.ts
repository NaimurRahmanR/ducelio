"use server";
import { revalidatePath } from "next/cache";
import {
  createCourseCoupon,
  setCourseCouponActive,
} from "@/server/course-coupons";
export type CouponState = { error?: string; message?: string };
const route = "/admin/course-engineering/coupons";
export async function createCouponAction(
  _state: CouponState,
  form: FormData,
): Promise<CouponState> {
  try {
    const expiry = String(form.get("expiresAt") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(expiry))
      return { error: "Enter the expiry in UTC." };
    await createCourseCoupon({
      code: form.get("code"),
      percentOff: Number(form.get("percentOff")),
      expiresAt: expiry + ":00Z",
      redemptionLimit: Number(form.get("redemptionLimit")),
      courseId: form.get("courseId") || null,
      reason: form.get("reason"),
    });
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
          : "Check the coupon, future UTC expiry, limits and course restriction.",
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
