"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  cancelMyUnifiedCheckout,
  resumeMyUnifiedCheckout,
} from "@/server/academy-commerce";
export async function resumeUnifiedCheckoutAction(form: FormData) {
  let url: string | null = null;
  try {
    const r = await resumeMyUnifiedCheckout(
      z.uuid().parse(form.get("orderId")),
    );
    if (r.ok) url = r.url;
  } catch {}
  if (url) redirect(url);
  redirect("/student/academy?checkoutNotice=resume-unavailable");
}
export async function cancelUnifiedCheckoutAction(
  _state: { error?: string; message?: string },
  form: FormData,
): Promise<{ error?: string; message?: string }> {
  try {
    if (form.get("confirm") !== "on")
      return { error: "Confirm that you want to cancel this unpaid checkout." };
    const r = await cancelMyUnifiedCheckout(
      z.uuid().parse(form.get("orderId")),
    );
    if (!r.ok)
      return {
        error:
          r.code === "CHECKOUT_NOT_BOUND"
            ? "Resume this checkout first so its payment session can be verified before cancellation."
            : "Cancellation was refused. If payment is in progress or confirmed, wait for reconciliation or contact support.",
      };
    revalidatePath("/student/academy");
    revalidatePath("/admin/course-engineering/coupons");
    return {
      message:
        "Unpaid checkout cancelled. Any reserved coupon use has been released; payment and audit history are preserved.",
    };
  } catch {
    return {
      error:
        "Cancellation could not be verified. The reservation has been retained. Retry or contact support.",
    };
  }
}
