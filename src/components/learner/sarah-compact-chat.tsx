"use client";
import Link from "next/link";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Badge } from "@/components/ui";
import { submitSarahMessage } from "@/components/sarah-guide";
import { SARAH_IS_AI_NOTICE } from "@/components/sarah-identity";
import {
  SARAH_MESSAGE_MAX,
  SARAH_PERSONA,
  SARAH_PROPOSAL_MESSAGE,
  SARAH_STATUS_MESSAGE,
} from "@/domain/sarah";
import type { SarahActionState } from "@/app/student/sarah/actions";

export type SarahExchange = {
  id: number;
  message: string;
  result: SarahActionState;
};

export type SarahChatState = {
  idempotencyKey: string;
  exchanges: SarahExchange[];
};

// One exchange per submission, through Sarah's existing ask action and its
// idempotency-key rotation (src/components/sarah-guide.tsx). Sarah answers
// each message on its own; the list lives only in this page's memory, is
// never saved and clears when the learner leaves or refreshes.
export async function nextSarahChatState(
  previous: SarahChatState,
  form: FormData,
  send?: Parameters<typeof submitSarahMessage>[2],
): Promise<SarahChatState> {
  const message = String(form.get("message") ?? "");
  const panel = await submitSarahMessage(
    { result: {}, idempotencyKey: previous.idempotencyKey },
    form,
    send,
  );
  return {
    idempotencyKey: panel.idempotencyKey,
    exchanges: [
      ...previous.exchanges,
      {
        id: (previous.exchanges.at(-1)?.id ?? 0) + 1,
        message,
        result: panel.result,
      },
    ],
  };
}

function Reply({ result }: { result: SarahActionState }) {
  if (result.error) return <p role="alert">{result.error}</p>;
  if (result.status && result.status !== "SUCCEEDED")
    return <p role="status">{SARAH_STATUS_MESSAGE[result.status]}</p>;
  if (result.status === "SUCCEEDED" && result.reply)
    return (
      <>
        <p className="ln-sarah__reply">{result.reply}</p>
        {result.proposal && result.proposal !== "NONE" && (
          <p role="status">
            {SARAH_PROPOSAL_MESSAGE[result.proposal]}{" "}
            <Link href="/student/sarah">Review suggestions</Link>
          </p>
        )}
      </>
    );
  return null;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"])';

// The dashboard's compact Sarah panel. The expand button (or a double-click
// on Sarah's icon) shows the same panel full screen: one component, one
// conversation state, so nothing is lost between sizes.
export function SarahCompactChat({
  initialIdempotencyKey,
}: {
  initialIdempotencyKey: string;
}) {
  const [chat, formAction, pending] = useActionState<SarahChatState, FormData>(
    (previous, form) => nextSarahChatState(previous, form),
    { idempotencyKey: initialIdempotencyKey, exchanges: [] },
  );
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLOListElement>(null);

  const close = useCallback(() => {
    setExpanded(false);
    requestAnimationFrame(() => toggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.exchanges.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!expanded) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = [
      ...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {expanded && (
        <div className="ln-sarah-backdrop" aria-hidden="true" onClick={close} />
      )}
      <div
        ref={panelRef}
        className={expanded ? "ln-sarah is-full" : "ln-sarah"}
        role={expanded ? "dialog" : "region"}
        aria-modal={expanded ? true : undefined}
        aria-labelledby="ln-sarah-title"
        onKeyDown={onKeyDown}
      >
        <div className="ln-sarah__head">
          <span
            className="ln-sarah__icon"
            aria-hidden="true"
            title="Double-click to open Sarah full screen"
            onDoubleClick={() => (expanded ? close() : setExpanded(true))}
          >
            {SARAH_PERSONA.initials}
          </span>
          <div className="ln-sarah__who">
            <h2 id="ln-sarah-title">{SARAH_PERSONA.name}</h2>
            <span className="ln-muted">
              {SARAH_PERSONA.title} <Badge tone="muted">AI</Badge>
            </span>
          </div>
          <button
            ref={toggleRef}
            type="button"
            className="ln-iconbutton"
            aria-label={
              expanded ? "Close full screen Sarah" : "Open Sarah full screen"
            }
            aria-expanded={expanded}
            onClick={() => (expanded ? close() : setExpanded(true))}
          >
            {expanded ? (
              <Minimize2 size={18} aria-hidden="true" />
            ) : (
              <Maximize2 size={18} aria-hidden="true" />
            )}
          </button>
        </div>
        <p className="ln-sarah__notice">{SARAH_IS_AI_NOTICE}</p>
        <ol
          ref={logRef}
          className="ln-sarah__log"
          aria-live="polite"
          aria-label="Conversation with Sarah"
        >
          {chat.exchanges.length === 0 ? (
            <li className="ln-sarah__hint">
              Ask Sarah about getting started, finding your way around Ducelio,
              your schedule or your support preferences.
            </li>
          ) : (
            chat.exchanges.map((x) => (
              <li key={x.id} className="ln-sarah__exchange">
                <p className="ln-sarah__you">
                  <span className="ln-sr">You: </span>
                  {x.message}
                </p>
                <div className="ln-sarah__answer">
                  <span className="ln-sarah__by">
                    {SARAH_PERSONA.name} (AI)
                  </span>
                  <Reply result={x.result} />
                </div>
              </li>
            ))
          )}
          {pending && (
            <li className="ln-sarah__hint" role="status">
              Sarah is replying…
            </li>
          )}
        </ol>
        <form action={formAction} className="ln-sarah__form">
          <input
            type="hidden"
            name="idempotencyKey"
            value={chat.idempotencyKey}
          />
          <label htmlFor="ln-sarah-intent" className="ln-label">
            What would you like help with?
          </label>
          <select
            id="ln-sarah-intent"
            name="intent"
            defaultValue="GUIDE"
            disabled={pending}
          >
            <option value="GUIDE">Finding my way and my schedule</option>
            <option value="SUPPORT_PROFILE">
              Updating my support preferences
            </option>
          </select>
          <label htmlFor="ln-sarah-message" className="ln-label">
            Your message
          </label>
          <textarea
            id="ln-sarah-message"
            name="message"
            maxLength={SARAH_MESSAGE_MAX}
            minLength={1}
            required
            rows={expanded ? 4 : 2}
            disabled={pending}
          />
          <div className="ln-sarah__actions">
            <button className="button" disabled={pending}>
              {pending ? "Sarah is replying…" : "Send to Sarah"}
            </button>
            <Link className="button secondary" href="/student/sarah">
              Open Sarah&apos;s page
            </Link>
          </div>
          <p className="ln-sarah__privacy">
            Sarah answers each message on its own and does not remember earlier
            messages. Your message and her reply are not saved; this
            conversation clears when you leave or refresh the page.
          </p>
        </form>
      </div>
    </>
  );
}
