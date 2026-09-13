"use client";
import { useActionState, useState } from "react";
import {
  beginLessonAction,
  askProfessorAction,
  type ClassroomActionState,
} from "@/app/student/classroom/actions";

type Exchange = { role: "STUDENT" | "PROFESSOR" | "SYSTEM"; text: string };

const STATUS_MESSAGE: Partial<
  Record<NonNullable<ClassroomActionState["status"]>, string>
> = {
  ACTIVITY_BLOCKED:
    "Professor is unavailable while a controlled assessment is active.",
  UNAVAILABLE: "Professor is currently unavailable for this class.",
  ESCALATED: "This has been routed to academic review/support.",
  RETRY_LATER: "Professor could not respond just now. Please try again.",
  DUPLICATE: "That request was already sent.",
};

function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

// Learner-facing Professor interaction for a single classroom. Two
// deliberate, explicit user actions only -- BEGIN LESSON never fires
// automatically from rendering/refreshing. The exchange history exists
// only in this component's own client state for the lifetime of the page;
// nothing here is persisted server-side beyond a bounded per-action
// idempotency key (see src/server/professor-classroom.ts). Plain-text
// rendering only -- no dangerouslySetInnerHTML anywhere in this component.
export function ProfessorClassroomPanel({
  classSessionId,
  disabled,
}: {
  classSessionId: string;
  disabled: boolean;
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [beginKey, setBeginKey] = useState(newIdempotencyKey);
  const [askKey, setAskKey] = useState(newIdempotencyKey);
  const [beginState, beginFormAction, beginPending] = useActionState<
    ClassroomActionState,
    FormData
  >(beginLessonAction, {});
  const [askState, askFormAction, askPending] = useActionState<
    ClassroomActionState,
    FormData
  >(askProfessorAction, {});
  // "Adjusting state when a prop/value changes" during render, the pattern
  // React itself recommends in place of an effect for deriving state from
  // another piece of state that just changed
  // (https://react.dev/learn/you-might-not-need-an-effect): comparing
  // against the last-seen action-result object identity, entirely inside
  // the render body, avoids the extra effect-triggered render a useEffect
  // version of this would otherwise cause.
  const [seenBegin, setSeenBegin] = useState(beginState);
  if (beginState !== seenBegin) {
    setSeenBegin(beginState);
    if (beginState.status === "SUCCEEDED" && beginState.text) {
      const text = beginState.text;
      setExchanges((prev) => [...prev, { role: "PROFESSOR", text }]);
      setBeginKey(newIdempotencyKey());
    } else if (beginState.status) {
      const message = STATUS_MESSAGE[beginState.status];
      if (message)
        setExchanges((prev) => [...prev, { role: "SYSTEM", text: message }]);
      setBeginKey(newIdempotencyKey());
    }
  }

  const [seenAsk, setSeenAsk] = useState(askState);
  if (askState !== seenAsk) {
    setSeenAsk(askState);
    if (askState.status === "SUCCEEDED" && askState.text) {
      const text = askState.text;
      setExchanges((prev) => [...prev, { role: "PROFESSOR", text }]);
      setAskKey(newIdempotencyKey());
    } else if (askState.status) {
      const message = STATUS_MESSAGE[askState.status];
      if (message)
        setExchanges((prev) => [...prev, { role: "SYSTEM", text: message }]);
      setAskKey(newIdempotencyKey());
    }
  }

  const busy = beginPending || askPending;

  return (
    <section className="card professor-panel" aria-label="Professor">
      <h2>Professor</h2>
      {disabled ? (
        <p className="notice" role="status">
          Professor is unavailable right now for this class.
        </p>
      ) : (
        <>
          <div className="professor-transcript" aria-live="polite">
            {exchanges.length === 0 ? (
              <p className="muted">
                Begin the lesson with Professor, or ask a question below.
              </p>
            ) : (
              exchanges.map((exchange, index) => (
                <div
                  className={`professor-exchange ${exchange.role.toLowerCase()}`}
                  key={index}
                >
                  <span className="professor-exchange-role">
                    {exchange.role === "STUDENT"
                      ? "You"
                      : exchange.role === "PROFESSOR"
                        ? "Professor"
                        : "Academy"}
                  </span>
                  <p>{exchange.text}</p>
                </div>
              ))
            )}
          </div>

          {(beginState.error || askState.error) && (
            <p className="notice error" role="alert">
              {beginState.error || askState.error}
            </p>
          )}

          <form action={beginFormAction}>
            <input type="hidden" name="classSessionId" value={classSessionId} />
            <input type="hidden" name="idempotencyKey" value={beginKey} />
            <button className="button secondary" disabled={busy} type="submit">
              {beginPending ? "Starting…" : "Begin with Professor"}
            </button>
          </form>

          <form
            action={askFormAction}
            className="professor-ask-form"
            onSubmit={() => {
              if (draft.trim())
                setExchanges((prev) => [
                  ...prev,
                  { role: "STUDENT", text: draft.trim() },
                ]);
              setDraft("");
            }}
          >
            <input type="hidden" name="classSessionId" value={classSessionId} />
            <input type="hidden" name="idempotencyKey" value={askKey} />
            <div className="field">
              <label htmlFor="professor-question">Ask Professor</label>
              <textarea
                id="professor-question"
                name="message"
                rows={3}
                maxLength={2000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask a question about this lesson…"
                required
              />
            </div>
            <button
              className="button"
              disabled={busy || draft.trim().length === 0}
              type="submit"
            >
              {askPending ? "Sending…" : "Send"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
