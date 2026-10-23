"use client";
import { useActionState } from "react";
import {
  cancelUnifiedCheckoutAction,
  resumeUnifiedCheckoutAction,
} from "@/app/student/academy/checkout-actions";
export function CourseCheckoutRecovery({ orderId }: { orderId: string }) {
  const [state, action, busy] = useActionState(cancelUnifiedCheckoutAction, {});
  return (
    <div>
      <form action={resumeUnifiedCheckoutAction}>
        <input type="hidden" name="orderId" value={orderId} />
        <button className="button secondary">Resume checkout</button>
      </form>
      <form action={action}>
        <input type="hidden" name="orderId" value={orderId} />
        <label>
          <input name="confirm" type="checkbox" required />
          Cancel this unpaid checkout
        </label>
        <button className="button secondary" disabled={busy}>
          Verify and cancel checkout
        </button>
      </form>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}
