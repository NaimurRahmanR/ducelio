"use client";
import { useActionState } from "react";
import { startCheckout, type CheckoutState } from "@/app/courses/actions";

export function BuyCourseForm({
  slug,
  paymentAvailable,
}: {
  slug: string;
  paymentAvailable: boolean;
}) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    startCheckout,
    {},
  );
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <div className="field">
        <label htmlFor="campaignCode">
          {paymentAvailable ? "Promo or reviewer code" : "Reviewer code"}
        </label>
        <input
          id="campaignCode"
          name="campaignCode"
          autoComplete="off"
          minLength={4}
          maxLength={32}
          pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*"
          placeholder={paymentAvailable ? "Optional" : "Required"}
          required={!paymentAvailable}
        />
        <small className="muted">
          {paymentAvailable
            ? "Optional. A valid discount changes the server-authoritative checkout price."
            : "Card checkout is unavailable; only a valid complimentary code can continue."}
        </small>
      </div>
      {state.error && (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      )}
      <button className="button full" type="submit" disabled={pending}>
        {pending
          ? "Checking access…"
          : paymentAvailable
            ? "Continue to secure checkout"
            : "Apply complimentary code"}{" "}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
