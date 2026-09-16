"use client";
import { useActionState } from "react";
import { startCheckout, type CheckoutState } from "@/app/courses/actions";

export function BuyCourseForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    startCheckout,
    {},
  );
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      {state.error && (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      )}
      <button className="button full" type="submit" disabled={pending}>
        {pending ? "Starting checkout…" : "Buy now"}{" "}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
