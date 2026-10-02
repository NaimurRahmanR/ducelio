"use client";
import Link from "next/link";
import { useActionState } from "react";
import {
  completeAcademicEnrolmentAction,
  regradeAcademicResultAction,
  type AcademicResultsActionState,
} from "@/app/admin/academic-results/actions";

function Outcome({ state }: { state: AcademicResultsActionState }) {
  return (
    <>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="notice" role="status">
          {state.message}{" "}
          {state.resultRevisionId && (
            <Link
              className="text-link"
              href={`/admin/academic-results?result=${state.resultRevisionId}`}
            >
              Open the new current revision
            </Link>
          )}
        </p>
      )}
    </>
  );
}

function ReasonField({ id, placeholder }: { id: string; placeholder: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        Institutional reason (recorded in the audit trail)
      </label>
      <textarea
        id={id}
        name="reason"
        minLength={5}
        maxLength={300}
        rows={2}
        required
        placeholder={placeholder}
      />
    </div>
  );
}

// Only rendered for a CURRENT, VALID revision. The form carries just the
// revision id and a reason; the existing regrade authority (migration 032)
// re-resolves everything else and appends the next revision.
export function RegradeResultForm({ resultId }: { resultId: string }) {
  const [state, action, pending] = useActionState<
    AcademicResultsActionState,
    FormData
  >(regradeAcademicResultAction, {});
  return (
    <form action={action} className="support-form">
      <Outcome state={state} />
      <input type="hidden" name="resultId" value={resultId} />
      <ReasonField
        id={`regrade-reason-${resultId}`}
        placeholder="Learner query upheld after academic review of the grade"
      />
      <button className="button" disabled={pending}>
        {pending ? "Regrading…" : "Request institutional regrade"}
      </button>
    </form>
  );
}

// The existing completion authority (migration 030) re-derives every gate;
// a refusal reports its reason and changes nothing.
export function CompleteEnrolmentForm({
  enrolmentId,
}: {
  enrolmentId: string;
}) {
  const [state, action, pending] = useActionState<
    AcademicResultsActionState,
    FormData
  >(completeAcademicEnrolmentAction, {});
  return (
    <form action={action} className="support-form">
      <Outcome state={state} />
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <ReasonField
        id={`completion-reason-${enrolmentId}`}
        placeholder="All components graded; completion confirmed by academic office"
      />
      <button className="button" disabled={pending}>
        {pending ? "Checking…" : "Attempt course completion"}
      </button>
    </form>
  );
}
