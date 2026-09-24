"use client";
import { useActionState } from "react";
import {
  recoverExaminerTargetAction,
  type RecoveryActionState,
} from "@/app/admin/activation/recovery/actions";

const STATUS_MESSAGE: Partial<
  Record<NonNullable<RecoveryActionState["status"]>, string>
> = {
  RECOVERED: "Recovered. A result now exists for this target.",
  ALREADY_RECOVERED: "This target was already recovered.",
  ESCALATED: "This has been passed to academic review.",
  UNAVAILABLE: "Recovery is not available for this target right now.",
  RETRY_LATER: "Please try again in a moment.",
  TARGET_NOT_ELIGIBLE: "This target is no longer eligible for recovery.",
  TARGET_NOT_FOUND: "This target could not be found.",
};

// sourceExecutionId is a hidden field populated from the server-rendered
// list this form is always shown alongside -- never typed or copied out of
// a log by the admin. Exactly one governed recovery attempt is ever
// admitted per source (see the recoveryStatus this row was rendered under);
// a repeat submission after ELIGIBLE is safely idempotent, never a second
// provider claim.
export function ExaminerRecoveryForm({
  sourceExecutionId,
}: {
  sourceExecutionId: string;
}) {
  const [state, formAction, pending] = useActionState(
    recoverExaminerTargetAction,
    {},
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="sourceExecutionId" value={sourceExecutionId} />
      <label>
        Recovery reason
        <textarea
          name="reason"
          minLength={1}
          maxLength={300}
          required
          rows={2}
          disabled={pending}
        />
      </label>
      <button className="button secondary" disabled={pending}>
        {pending ? "Recovering…" : "Recover this target"}
      </button>
      <p role="status">
        {state.error ?? (state.status ? STATUS_MESSAGE[state.status] : "")}
      </p>
    </form>
  );
}
