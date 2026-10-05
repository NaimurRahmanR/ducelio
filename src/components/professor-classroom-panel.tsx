"use client";
import { useActionState, useState } from "react";
import {
  beginLessonAction,
  askProfessorAction,
  type ClassroomActionState,
} from "@/app/student/classroom/actions";

type Exchange = { role: "STUDENT" | "PROFESSOR" | "SYSTEM"; text: string };

// AC-2 memory continuity, stated truthfully to the learner. These notices
// describe the learner-visible conversation memory only; it is never a
// record of marks, progress or mastery.
export const MEMORY_FULL_MESSAGE =
  "This classroom's conversation with the Professor has reached its limit of 200 exchanges, so the Professor cannot continue it here. Your earlier conversation remains visible.";
export const MEMORY_NOT_RECORDED_MESSAGE =
  "This reply could not be saved to this classroom's conversation, so the Professor may not remember it later.";
export const MEMORY_DEGRADED_MESSAGE =
  "Some earlier replies in this classroom could not be saved, so the Professor may not remember everything already discussed.";

// ESCALATED only ever arises here from the programme's Professor escalation
// policy (ACADEMIC_REVIEW), which creates no academic-review case, so the
// learner is never told a review exists (AGENT-CONTROL-1).
export const STATUS_MESSAGE: Partial<
  Record<NonNullable<ClassroomActionState["status"]>, string>
> = {
  ACTIVITY_BLOCKED:
    "Professor is unavailable while a controlled assessment is active.",
  UNAVAILABLE: "Professor is currently unavailable for this class.",
  ESCALATED:
    "Professor is not available for this class. No academic review has been opened; ask your instructor if you need help.",
  RETRY_LATER: "Professor could not respond just now. Please try again.",
  DUPLICATE: "That request was already sent.",
  MEMORY_FULL: MEMORY_FULL_MESSAGE,
};

function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

// Learner-facing Professor interaction for a single classroom. Two
// deliberate, explicit user actions only -- BEGIN LESSON never fires
// automatically from rendering/refreshing. AC-2: earlier turns come from the
// server's own stored, learner-visible classroom memory (migration 051),
// never from the browser; this component only displays them, and the
// server never accepts history from here. Plain-text rendering only -- no
// dangerouslySetInnerHTML anywhere in this component.
export type ClassroomPanelTurn = {
  learnerMessage: string | null;
  professorMessage: string;
};
export function ProfessorClassroomPanel({
  classSessionId,
  disabled,
  initialTurns = [],
  memoryDegraded = false,
  memoryFull = false,
}: {
  classSessionId: string;
  disabled: boolean;
  initialTurns?: readonly ClassroomPanelTurn[];
  // Database-derived: shown-but-unrecorded exchanges exist.
  memoryDegraded?: boolean;
  // Database-derived: the classroom memory is at capacity.
  memoryFull?: boolean;
}) {
  const [full, setFull] = useState(memoryFull);
  const [exchanges, setExchanges] = useState<Exchange[]>(() =>
    initialTurns.flatMap((turn): Exchange[] => [
      ...(turn.learnerMessage
        ? [{ role: "STUDENT" as const, text: turn.learnerMessage }]
        : []),
      { role: "PROFESSOR" as const, text: turn.professorMessage },
    ]),
  );
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
      const notRecorded = beginState.memoryNotRecorded;
      setExchanges((prev) => [
        ...prev,
        { role: "PROFESSOR", text },
        ...(notRecorded
          ? [{ role: "SYSTEM" as const, text: MEMORY_NOT_RECORDED_MESSAGE }]
          : []),
      ]);
      setBeginKey(newIdempotencyKey());
    } else if (beginState.status) {
      if (beginState.status === "MEMORY_FULL") setFull(true);
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
      const notRecorded = askState.memoryNotRecorded;
      setExchanges((prev) => [
        ...prev,
        { role: "PROFESSOR", text },
        ...(notRecorded
          ? [{ role: "SYSTEM" as const, text: MEMORY_NOT_RECORDED_MESSAGE }]
          : []),
      ]);
      setAskKey(newIdempotencyKey());
    } else if (askState.status) {
      if (askState.status === "MEMORY_FULL") setFull(true);
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

          {memoryDegraded && (
            <p className="notice" role="status">
              {MEMORY_DEGRADED_MESSAGE}
            </p>
          )}
          {full && (
            <p className="notice" role="status">
              {MEMORY_FULL_MESSAGE}
            </p>
          )}

          {(beginState.error || askState.error) && (
            <p className="notice error" role="alert">
              {beginState.error || askState.error}
            </p>
          )}

          <form action={beginFormAction}>
            <input type="hidden" name="classSessionId" value={classSessionId} />
            <input type="hidden" name="idempotencyKey" value={beginKey} />
            <button
              className="button secondary"
              disabled={busy || full}
              type="submit"
            >
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
                disabled={full}
                required
              />
            </div>
            <button
              className="button"
              disabled={busy || full || draft.trim().length === 0}
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
