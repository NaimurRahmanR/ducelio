"use client";
import { useActionState, useState } from "react";
import {
  requestPracticalSupportAction,
  requestTutorLabSupportAction,
  type TutorLabSupportActionState,
} from "@/app/student/practicals/actions";

// Browser-only UUID generation (crypto.randomUUID is available in every
// currently-supported browser); the server independently validates this as
// a strict UUID (tutorLabSupportRequestSchema) regardless.
function newIdempotencyKey() {
  return crypto.randomUUID();
}

const STATUS_MESSAGE: Partial<
  Record<NonNullable<TutorLabSupportActionState["status"]>, string>
> = {
  ACTIVITY_BLOCKED:
    "Support is not available while a controlled assessment is active.",
  UNAVAILABLE: "Support is unavailable right now.",
  ESCALATED: "This has been passed to academic review.",
  RETRY_LATER: "Please try again in a moment.",
  DUPLICATE: "This request was already sent.",
};

// Never lets the browser choose a role: the label ("Tutor"/"Lab Instructor")
// is cosmetic only, driven by which kind of handoff was just created; the
// actual destination is re-derived server-side from the handoff itself
// (src/server/tutor-lab-execution). Calm product wording: never implies
// "completed"/"passed"/"mastered"/"verified" from an AI conversation.
function TutorLabSupportPanel({
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
