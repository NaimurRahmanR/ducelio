"use client";
import { useActionState, useState } from "react";
import {
  requestRecoveryAction,
  reviewRecoveryAction,
} from "@/app/student/academy/recovery-actions";
export function RequestRecoveryForm({
  enrolmentId,
  itemId,
}: {
  enrolmentId: string;
  itemId: string;
}) {
  const [requestKey] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useActionState(requestRecoveryAction, {});
  return (
    <details>
      <summary>Request missed-activity recovery</summary>
      <form action={action} className="acad-form">
        <input type="hidden" name="enrolmentId" value={enrolmentId} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <label>
          Proposed start (UTC)
          <input name="opensAt" type="datetime-local" required />
        </label>
        <label>
          Reason
          <select name="reasonCode">
            <option value="MISSED_WINDOW">Missed window</option>
            <option value="TECHNICAL_ISSUE">Technical issue</option>
          </select>
        </label>
        <p>
          One approved recovery per activity, lasting 23 hours 59 minutes.
          Academic review is required. This does not reset attempts,
          submissions, grades or progress.
        </p>
        <button className="button secondary" disabled={pending}>
          Request recovery
        </button>
        {(state.error || state.message) && (
          <p role={state.error ? "alert" : "status"}>
            {state.error ?? state.message}
          </p>
        )}
      </form>
    </details>
  );
}
export function ReviewRecoveryForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(reviewRecoveryAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="requestId" value={id} />
      <label>
        Review reason
        <input name="reason" required minLength={5} maxLength={300} />
      </label>
      <button
        className="ac-button"
        name="approve"
        value="true"
        disabled={pending}
      >
        Approve proposed recovery
      </button>
      <button
        className="ac-button secondary"
        name="approve"
        value="false"
        disabled={pending}
      >
        Deny recovery
      </button>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
