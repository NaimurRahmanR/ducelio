"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import {
  TUTOR_CLASS_NOTE_OPT_IN_LABEL,
  tutorClassNoteOutcomeMessage,
} from "@/domain/tutor-class-notes";
import {
  requestPracticalSupportAction,
  requestTutorLabSupportAction,
  submitPracticalLabWorkAction,
  type LabWorkSubmissionActionState,
  type TutorLabSupportActionState,
} from "@/app/student/practicals/actions";

// Browser-only UUID generation (crypto.randomUUID is available in every
// currently-supported browser); the server independently validates this as
// a strict UUID (tutorLabSupportRequestSchema) regardless.
function newIdempotencyKey() {
  return crypto.randomUUID();
}

// Tutor/Lab support never creates an academic-review case, so ESCALATED
// support never claims one (AGENT-CONTROL-1). Lab work grading below is
// Examiner grading, whose ESCALATED outcome is a real review case.
export const STATUS_MESSAGE: Partial<
  Record<NonNullable<TutorLabSupportActionState["status"]>, string>
> = {
  ACTIVITY_BLOCKED:
    "Support is not available while a controlled assessment is active.",
  UNAVAILABLE: "Support is unavailable right now.",
  ESCALATED:
    "Support is not available for this request. No academic review has been opened.",
  RETRY_LATER: "Please try again in a moment.",
  DUPLICATE: "This request was already sent.",
};

// Never lets the browser choose a role: the label ("Tutor"/"Lab Instructor")
// is cosmetic only, driven by which kind of handoff was just created; the
// actual destination is re-derived server-side from the handoff itself
// (src/server/tutor-lab-execution). Calm product wording: never implies
// "completed"/"passed"/"mastered"/"verified" from an AI conversation.
export function TutorLabSupportPanel({
  handoffId,
  lab,
}: {
  handoffId: string;
  lab: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    requestTutorLabSupportAction,
    {},
  );
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.status && state.status !== "DUPLICATE")
      setIdempotencyKey(newIdempotencyKey());
  }
  const label = lab ? "Lab Instructor" : "Tutor";
  return (
    <form action={formAction} style={{ marginTop: "0.75rem" }}>
      <input type="hidden" name="handoffId" value={handoffId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label>
        Ask {label} support
        <textarea
          name="message"
          maxLength={2000}
          minLength={1}
          required
          rows={3}
          disabled={pending}
        />
      </label>
      {/* AC-4: Tutor only. The learner chooses before sending; the note body
          is the governed Tutor answer itself, never text from this form. */}
      {!lab && (
        <label className="engineering-checkbox">
          <input type="checkbox" name="saveAsClassNote" disabled={pending} />{" "}
          {TUTOR_CLASS_NOTE_OPT_IN_LABEL}
        </label>
      )}
      <button className="button secondary" disabled={pending}>
        {pending ? "Sending…" : "Send to " + label}
      </button>
      <p role="status">
        {state.status === "SUCCEEDED"
          ? `${state.role === "LAB_INSTRUCTOR" ? "Lab Instructor" : "Tutor"}: ${state.text}`
          : state.error
            ? state.error
            : state.status
              ? STATUS_MESSAGE[state.status]
              : ""}
      </p>
      {state.status === "SUCCEEDED" &&
        state.role === "TUTOR" &&
        state.classNote && (
          <p className="muted">
            {tutorClassNoteOutcomeMessage(state.classNote)}
            {state.classNote.state === "SAVED" && (
              <>
                {" "}
                <Link className="text-link" href="/student/tutor-notes">
                  View your Tutor notes
                </Link>
              </>
            )}
          </p>
        )}
    </form>
  );
}

const GRADING_STATUS_MESSAGE: Partial<
  Record<NonNullable<LabWorkSubmissionActionState["grading"]>, string>
> = {
  ESCALATED: " This has been sent for academic review.",
  GRADING_PENDING: " Grading is in progress; check back shortly.",
  GRADING_UNAVAILABLE:
    " Grading is not currently available for this submission.",
};

// THE final, governed lab submission -- distinct from PracticalSupport's
// conversational Tutor/Lab Instructor assistance below, which never records
// institutional work. The idempotency key is derived deterministically from
// (enrolmentId, practicalId) -- not randomly regenerated per render -- so a
// resubmission after an interrupted request (a refresh, a lost response)
// safely replays to the same governed submission rather than being treated
// as a new one.
export function LabWorkSubmission({
  enrolmentId,
  practicalId,
}: {
  enrolmentId: string;
  practicalId: string;
}) {
  const [state, formAction, pending] = useActionState(
    submitPracticalLabWorkAction,
    {},
  );
  const idempotencyKey = `lab:${enrolmentId}:${practicalId}`;
  const submitted = state.status === "SUBMITTED";
  return (
    <form action={formAction} style={{ marginTop: "0.75rem" }}>
      <input type="hidden" name="enrolmentId" value={enrolmentId} />
      <input type="hidden" name="practicalId" value={practicalId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label>
        Final lab submission
        <textarea
          name="body"
          maxLength={20000}
          minLength={1}
          required
          rows={6}
          disabled={pending || submitted}
        />
      </label>
      <button className="button" disabled={pending || submitted}>
        {pending
          ? "Submitting…"
          : submitted
            ? "Submitted"
            : "Submit final lab work"}
      </button>
      <p role="status">
        {state.error
          ? state.error
          : submitted
            ? "Lab work submitted." +
              (state.grading && state.grading !== "GRADED"
                ? GRADING_STATUS_MESSAGE[state.grading]
                : "")
            : ""}
      </p>
    </form>
  );
}

export function PracticalSupport({
  enrolmentId,
  practicalId,
  requestId,
  lab,
}: {
  enrolmentId: string;
  practicalId: string;
  requestId: string;
  lab: boolean;
}) {
  const [state, setState] = useState<"IDLE" | "PENDING" | "DONE" | "ERROR">(
    "IDLE",
  );
  const [handoffId, setHandoffId] = useState<string | null>(null);
  return (
    <div>
      <button
        className="button secondary"
        disabled={state === "PENDING" || state === "DONE"}
        onClick={async () => {
          setState("PENDING");
          try {
            const result = await requestPracticalSupportAction({
              enrolmentId,
              practicalId,
              requestId,
            });
            setState(result.ok ? "DONE" : "ERROR");
            if (result.ok && result.handoffId) setHandoffId(result.handoffId);
          } catch {
            setState("ERROR");
          }
        }}
      >
        {state === "PENDING"
          ? "Recording request…"
          : "Request " + (lab ? "Lab" : "Tutor") + " support"}
      </button>
      <p role="status">
        {state === "DONE"
          ? "Support request recorded. This has not started an AI session."
          : state === "ERROR"
            ? "Support is unavailable. Your course or assessment state may restrict this request."
            : ""}
      </p>
      {state === "DONE" && handoffId && (
        <TutorLabSupportPanel handoffId={handoffId} lab={lab} />
      )}
    </div>
  );
}
