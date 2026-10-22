"use client";
import { useActionState, useState } from "react";
import {
  startAssessmentAction,
  submitLabAction,
} from "@/app/student/academy/actions";
import type { AssessmentActionState } from "@/app/student/actions";

export function StartAssessmentForm({
  enrolmentId,
  assessmentRef,
  label,
}: {
  enrolmentId: string;
  assessmentRef: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<
    AssessmentActionState,
    FormData
  >(startAssessmentAction, {});
  return (
    <form action={action} className="acad-inline-form">
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="assessmentRef" value={assessmentRef} />
      <button className="button" disabled={pending}>
        {pending ? "Opening…" : label}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}

export function LabSubmissionForm({
  enrolmentId,
  labRef,
  title,
}: {
  enrolmentId: string;
  labRef: string;
  title: string;
}) {
  const [state, action, pending] = useActionState<
    AssessmentActionState,
    FormData
  >(submitLabAction, {});
  const [requestKey] = useState(() => crypto.randomUUID());
  if (state.message) return <p role="status">{state.message}</p>;
  return (
    <details className="acad-lab">
      <summary>Submit your work for “{title}”</summary>
      <form action={action}>
        <input type="hidden" name="enrolmentId" value={enrolmentId} />
        <input type="hidden" name="labRef" value={labRef} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <label>
          Your findings
          <textarea
            name="body"
            required
            minLength={1}
            maxLength={20000}
            rows={6}
          />
        </label>
        <button className="button secondary" disabled={pending}>
          {pending ? "Submitting…" : "Submit practical"}
        </button>
        {state.error && <p role="alert">{state.error}</p>}
      </form>
    </details>
  );
}
