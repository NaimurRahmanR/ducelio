"use client";
import { useActionState, useEffect, useState } from "react";

// The state every learner form action returns (useActionState house
// pattern, src/components/course-coupon-forms.tsx). `message` is a
// confirmation, `error` a refusal; both are plain text.
export type LearnerActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export type LearnerFormAction = (
  previous: LearnerActionState,
  form: FormData,
) => Promise<LearnerActionState>;

export type LearnerFormSubmit = (form: FormData) => void | Promise<void>;

export function ActionFeedback({ state }: { state: LearnerActionState }) {
  return (
    <div aria-live="polite">
      {state.error && (
        <p className="ln-feedback is-error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="ln-feedback" role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Time since check-in, on the server's clock: the first render uses the
// server time the page was rendered with, then ticks from the offset
// between that server time and this device's clock, so a wrong device clock
// does not change the figure.
export function ElapsedTimer({
  since,
  serverTime,
}: {
  since: string;
  serverTime: string;
}) {
  const start = Date.parse(since);
  const [elapsed, setElapsed] = useState(() => Date.parse(serverTime) - start);
  useEffect(() => {
    const offset = Date.parse(serverTime) - Date.now();
    const id = window.setInterval(
      () => setElapsed(Date.now() + offset - start),
      1000,
    );
    return () => window.clearInterval(id);
  }, [serverTime, start]);
  return (
    <span className="ln-timer" role="timer" aria-label="Time since check-in">
      {clock(elapsed)}
    </span>
  );
}

export function CheckInForm({
  enrolmentId,
  scheduleItemId,
  checkInAction,
}: {
  enrolmentId: string;
  scheduleItemId: string;
  checkInAction: LearnerFormAction;
}) {
  const [state, action, pending] = useActionState<LearnerActionState, FormData>(
    checkInAction,
    {},
  );
  return (
    <form action={action} className="ln-inline-form">
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="scheduleItemId" value={scheduleItemId} />
      <button className="button" disabled={pending || state.ok === true}>
        {pending ? "Recording…" : "Give attendance"}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}

export function StartAssessmentForm({
  enrolmentId,
  assessmentRef,
  label,
  startAssessmentAction,
}: {
  enrolmentId: string;
  assessmentRef: string;
  label: string;
  startAssessmentAction: LearnerFormAction;
}) {
  const [state, action, pending] = useActionState<LearnerActionState, FormData>(
    startAssessmentAction,
    {},
  );
  return (
    <form action={action} className="ln-inline-form">
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="assessmentRef" value={assessmentRef} />
      <button className="button" disabled={pending}>
        {pending ? "Opening…" : label}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}
