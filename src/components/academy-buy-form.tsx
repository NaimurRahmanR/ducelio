"use client";
import { useActionState } from "react";
import {
  startAcademyCheckout,
  type AcademyCheckoutState,
} from "@/app/academy/actions";
import { formatMoney } from "@/domain/academy-delivery";
import type { AcademyFormatId } from "@/domain/academy-scheduler";

export function AcademyBuyForm({
  slug,
  currency,
  formats,
}: {
  slug: string;
  currency: string;
  formats: { formatId: AcademyFormatId; amountMinor: number }[];
}) {
  const [state, action, pending] = useActionState<
    AcademyCheckoutState,
    FormData
  >(startAcademyCheckout, {});
  return (
    <form action={action} className="acad-planner">
      <input type="hidden" name="slug" value={slug} />
      <p>
        {formatMoney(formats[0].amountMinor, currency)} {currency}: one course
        price.
      </p>
      <label htmlFor="course-coupon">
        Coupon code (optional)
        <input
          id="course-coupon"
          name="couponCode"
          autoComplete="off"
          maxLength={40}
        />
      </label>
      <p className="muted">
        After purchase, activate your course and choose a feasible 2, 4, 6, 8 or
        12 week timetable. Duration does not change the price. A valid 100%
        coupon grants access without a card charge.
      </p>
      <button className="button" disabled={pending}>
        {pending ? "Opening secure checkout…" : "Continue"}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
