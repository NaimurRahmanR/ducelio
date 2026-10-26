"use client";
import Link from "next/link";
import { useActionState } from "react";
import {
  prepareUnifiedOperationAction,
  executeUnifiedOperationAction,
  type UnifiedOperationState,
} from "@/app/admin/operations-engineer/actions";

export function UnifiedOperationsConsole() {
  const [prepared, prepare, preparing] = useActionState<UnifiedOperationState, FormData>(
    prepareUnifiedOperationAction,
    {},
  );
  const [executed, execute, executing] = useActionState<UnifiedOperationState, FormData>(
    executeUnifiedOperationAction,
    {},
  );
  return (
    <section className="ac-panel">
      <h2>Ask Operations Engineer</h2>
      <p>
        Use an operational request to inspect your authorised courses, sales
        or coupons. Reviewed availability changes produce a proposal and
        require your explicit confirmation. Arbitrary AI tool execution is
        not enabled in this deployment.
      </p>
      <form action={prepare} className="acad-form">
        <label>
          Operational request
          <textarea
            name="request"
            minLength={3}
            maxLength={2000}
            rows={3}
            required
            placeholder="Show courses, show sales, list coupons, or deactivate coupon CODE"
          />
        </label>
        <button className="ac-button" disabled={preparing}>
          {preparing ? "Inspecting…" : "Review request"}
        </button>
      </form>
      {prepared.error && <p role="alert" className="acad-outcome error">{prepared.error}</p>}
      {prepared.title && <h3>{prepared.title}</h3>}
      {prepared.message && <p role="status">{prepared.message}</p>}
      {prepared.lines && (
        <ul className="acad-issues">
          {prepared.lines.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {prepared.href && (
        <p><Link className="ac-link" href={prepared.href}>Open governed workspace</Link></p>
      )}
      {prepared.proposal && (
        <form action={execute} className="acad-form">
          <input type="hidden" name="couponId" value={prepared.proposal.couponId} />
          <input type="hidden" name="code" value={prepared.proposal.code} />
          <input
            type="hidden"
            name="currentlyActive"
            value={String(prepared.proposal.currentlyActive)}
          />
          <input type="hidden" name="makeActive" value={String(prepared.proposal.makeActive)} />
          <label>
            Reason recorded in the audit log
            <textarea name="reason" minLength={5} maxLength={300} required rows={2} />
          </label>
          <label className="acad-check">
            <input type="checkbox" name="confirm" required />
            I reviewed this exact coupon change and authorise its execution.
          </label>
          <button className="ac-button" disabled={executing}>
            {executing ? "Executing…" : "Confirm and execute change"}
          </button>
        </form>
      )}
      {executed.error && <p role="alert" className="acad-outcome error">{executed.error}</p>}
      {executed.message && <p role="status">{executed.message}</p>}
    </section>
  );
}
