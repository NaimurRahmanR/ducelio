"use client";
import { useActionState } from "react";
import { Card, EmptyState } from "./ui";
import { SarahIdentity } from "./sarah-identity";
import {
  RATING_FIELDS,
  RATING_QUESTION,
  RATING_SCALE_HINT,
  SESSION_FEEDBACK_MESSAGE,
  isFinalFeedbackOutcome,
  type FeedbackOpportunity,
} from "@/domain/session-feedback";
import {
  submitSessionFeedbackAction,
  type SessionFeedbackActionState,
} from "@/app/student/sarah/feedback-actions";

export type SessionFeedbackPanelState = {
  result: SessionFeedbackActionState;
  requestId: string;
};

// The next prompt state after one submission. A resolved conflict rotates
// to a fresh request UUID, so the learner's next deliberate attempt gets a
// definitive answer (recorded, or already submitted). Only an unresolved
// outcome keeps the UUID, so a retry of the same request replays safely.
// Rotation happens here, in the action result, never during render.
export async function submitSessionFeedback(
  previous: SessionFeedbackPanelState,
  form: FormData,
  send: (
    previous: SessionFeedbackActionState,
    form: FormData,
  ) => Promise<SessionFeedbackActionState> = submitSessionFeedbackAction,
  newKey: () => string = () => crypto.randomUUID(),
): Promise<SessionFeedbackPanelState> {
  try {
    const result = await send(previous.result, form);
    return result.outcome === "REQUEST_CONFLICT"
      ? { result, requestId: newKey() }
      : { result, requestId: previous.requestId };
  } catch {
    return {
      result: { outcome: "UNAVAILABLE" },
      requestId: previous.requestId,
    };
  }
}

export type FeedbackPrompt = FeedbackOpportunity & { requestId: string };

// Fixed locale and time zone, so the server render and hydration agree.
const SESSION_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
function sessionTime(iso: string) {
  return `${SESSION_TIME.format(new Date(iso))} UTC`;
}

function SessionFeedbackForm({ prompt }: { prompt: FeedbackPrompt }) {
  const [panel, formAction, pending] = useActionState<
    SessionFeedbackPanelState,
    FormData
  >((previous, form) => submitSessionFeedback(previous, form), {
    result: {},
    requestId: prompt.requestId,
  });
  const outcome = panel.result.outcome;
  const done = outcome !== undefined && isFinalFeedbackOutcome(outcome);
  return (
    <article className="support-record" aria-label="Session feedback">
      <h3>{prompt.lessonTitle}</h3>
      <p>
        {prompt.programmeTitle} · {prompt.cohortTitle}
      </p>
      <p className="muted">
        <time dateTime={prompt.scheduledStart}>
          {sessionTime(prompt.scheduledStart)}
        </time>{" "}
        · {prompt.instructorName}
      </p>
      {!done && (
        <form action={formAction}>
          <input
            type="hidden"
            name="classSessionId"
            value={prompt.classSessionId}
          />
          <input type="hidden" name="requestId" value={panel.requestId} />
          {RATING_FIELDS.map((field) => (
            <fieldset key={field} disabled={pending}>
              <legend>{RATING_QUESTION[field]}</legend>
              <p className="config-caption">{RATING_SCALE_HINT[field]}</p>
              {[1, 2, 3, 4, 5].map((rating) => (
                <label key={rating} className="engineering-checkbox">
                  <input
                    type="radio"
                    name={field}
                    value={String(rating)}
                    required
                  />
                  {rating}
                </label>
              ))}
            </fieldset>
          ))}
          <button className="button" disabled={pending}>
            {pending ? "Sending…" : "Send feedback"}
          </button>
        </form>
      )}
      <div aria-live="polite">
        {outcome && <p role="status">{SESSION_FEEDBACK_MESSAGE[outcome]}</p>}
      </div>
    </article>
  );
}

// AC-6: Sarah Mitchell asks how a session went. Three structured 1-5
// ratings, no free text. Recording them calls no model and changes no
// academic record. Prompts come from the database's bounded list of the
// learner's own ended, attended, unrated sessions.
export function SarahSessionFeedback({
  prompts,
  showIdentity = false,
}: {
  prompts: FeedbackPrompt[];
  showIdentity?: boolean;
}) {
  return (
    <Card>
      {showIdentity && <SarahIdentity as="h2" />}
      {showIdentity ? (
        <h3>How did that session go?</h3>
      ) : (
        <h2>How did that session go?</h2>
      )}
      <p>
        Sarah asks three quick questions about classes you attended. Choose a
        rating from 1 to 5 for each. It is optional, and it never affects your
        grades, attendance or progress.
      </p>
      <p className="config-caption">
        Academy administrators see only combined results for a session, and only
        once at least 3 learners have answered. Your name and your individual
        answers are not shown to them or to your instructor.
      </p>
      {prompts.length === 0 ? (
        <EmptyState title="Nothing waiting">
          No sessions are waiting for your feedback right now.
        </EmptyState>
      ) : (
        prompts.map((prompt) => (
          <SessionFeedbackForm key={prompt.classSessionId} prompt={prompt} />
        ))
      )}
    </Card>
  );
}
