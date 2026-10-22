"use client";
import { useActionState, useState } from "react";
import {
  startAssessmentAction,
  studiedAction,
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

export function StudiedForm({
  enrolmentId,
  lessonRef,
  studied,
}: {
  enrolmentId: string;
  lessonRef: string;
  studied: boolean;
}) {
  const [state, action, pending] = useActionState<
    AssessmentActionState,
    FormData
  >(studiedAction, {});
  if (studied || state.message)
    return (
      <p role="status">
        {state.message ?? "You have recorded this lesson as studied."}
      </p>
    );
  return (
    <form action={action} className="acad-inline-form">
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="lessonRef" value={lessonRef} />
      <button className="button secondary" disabled={pending}>
        {pending ? "Saving…" : "I have studied this lesson"}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
