"use client";
import { useActionState, useState } from "react";
import {
  askAcademySupportAction,
  type AcademySupportActionState,
} from "@/app/student/academy/support/actions";

// Academy AI Tutor / Lab Instructor conversation for one support request.
// Earlier exchanges come from the server's own record; nothing here is a
// mark, attendance, progress or mastery. Plain-text rendering only.
export const ACADEMY_SUPPORT_STATUS_MESSAGE: Partial<
  Record<NonNullable<AcademySupportActionState["status"]>, string>
> = {
  ACTIVITY_BLOCKED:
    "AI support is closed while a controlled assessment is active.",
  UNAVAILABLE: "AI support is not available for this request right now.",
  ESCALATED: "AI support is not available for this request.",
  RETRY_LATER: "That could not be answered just now. Please try again.",
  DUPLICATE: "That question was already sent.",
};
export const ACADEMY_SUPPORT_NOT_RECORDED =
  "This reply could not be saved to this conversation's record.";
export const ACADEMY_SUPPORT_DEGRADED =
  "Some earlier replies here could not be saved, so they are not shown.";

type Exchange = { role: "LEARNER" | "AGENT" | "SYSTEM"; text: string };

export function AcademySupportPanel({
  requestId,
  agentName,
  initialTurns,
  unrecorded,
}: {
  requestId: string;
  agentName: string;
  initialTurns: readonly { learnerMessage: string; agentMessage: string }[];
  unrecorded: boolean;
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>(() =>
    initialTurns.flatMap((t): Exchange[] => [
      { role: "LEARNER", text: t.learnerMessage },
      { role: "AGENT", text: t.agentMessage },
    ]),
  );
  const [draft, setDraft] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(
    askAcademySupportAction,
    {},
  );
  // Derive from each new action result during render (no effect needed).
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.status === "SUCCEEDED" && state.text) {
      const text = state.text;
      const notRecorded = state.notRecorded;
      setExchanges((prev) => [
        ...prev,
        { role: "AGENT", text },
        ...(notRecorded
          ? [{ role: "SYSTEM" as const, text: ACADEMY_SUPPORT_NOT_RECORDED }]
          : []),
      ]);
    } else if (state.status) {
      const message = ACADEMY_SUPPORT_STATUS_MESSAGE[state.status];
      if (message)
        setExchanges((prev) => [...prev, { role: "SYSTEM", text: message }]);
    }
    if (state.status && state.status !== "DUPLICATE")
      setKey(crypto.randomUUID());
  }

  return (
    <section className="card professor-panel" aria-label={agentName}>
      <h2>{agentName}</h2>
      <div className="professor-transcript" aria-live="polite">
        {exchanges.length === 0 ? (
          <p className="muted">Ask a question to get started.</p>
        ) : (
          exchanges.map((exchange, index) => (
            <div
              className={`professor-exchange ${exchange.role === "LEARNER" ? "student" : exchange.role === "AGENT" ? "professor" : "system"}`}
              key={index}
            >
              <span className="professor-exchange-role">
                {exchange.role === "LEARNER"
                  ? "You"
                  : exchange.role === "AGENT"
                    ? agentName
                    : "Academy"}
              </span>
              <p>{exchange.text}</p>
            </div>
          ))
        )}
      </div>
      {unrecorded && (
        <p className="notice" role="status">
          {ACADEMY_SUPPORT_DEGRADED}
        </p>
      )}
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      <form
        action={formAction}
        className="professor-ask-form"
        onSubmit={() => {
          if (draft.trim())
            setExchanges((prev) => [
              ...prev,
              { role: "LEARNER", text: draft.trim() },
            ]);
          setDraft("");
        }}
      >
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="idempotencyKey" value={key} />
        <div className="field">
          <label htmlFor="academy-support-question">Ask {agentName}</label>
          <textarea
            id="academy-support-question"
            name="message"
            rows={3}
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            required
          />
        </div>
        <button
          className="button"
          disabled={pending || draft.trim().length === 0}
          type="submit"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
