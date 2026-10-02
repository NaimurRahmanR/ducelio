"use client";
import { useActionState, useId } from "react";
import {
  commerceOperationAction,
  type CommerceAdminState,
} from "@/app/admin/commerce/actions";

export function CommerceOperationForm({
  id,
  operation,
}: {
  id: string;
  operation: "reconcile" | "revoke" | "retry";
}) {
  const [state, action, pending] = useActionState<CommerceAdminState, FormData>(
    commerceOperationAction,
    {},
  );
  const controlId = useId();
  const label =
    operation === "reconcile"
      ? "Reconcile payment and access"
      : operation === "retry"
        ? "Retry verified webhook"
        : "Cancel course access";
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="operation" value={operation} />
      <div className="field">
        <label htmlFor={controlId}>Reason for {label.toLowerCase()}</label>
        <input
          id={controlId}
          name="reason"
          minLength={5}
          maxLength={300}
          required
          placeholder="Bounded operational reason; no payment or sensitive details"
        />
      </div>
      {operation === "revoke" && (
        <label>
          <input type="checkbox" name="confirm" value="yes" required />{" "}
          Permanently revoke this entitlement and withdraw any commerce-owned
          active or paused enrolment. This does not issue a financial refund.
        </label>
      )}
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Processing…" : label}
      </button>
      {state.error && (
        <p role="alert" className="notice error">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="notice">
          {state.message}
        </p>
      )}
    </form>
  );
}
