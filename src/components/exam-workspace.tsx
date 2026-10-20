"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  finishControlledAssessment,
  saveControlledAssessmentResponse,
  type AssessmentActionState,
} from "@/app/student/actions";
import {
  QUESTION_TYPE_LABELS,
  SCORING_RULE_DESCRIPTIONS,
  canonicalResponseBody,
  isObjectiveQuestionType,
  parseResponseBody,
  responseIssues,
  scoringRuleOf,
  selectionInstruction,
  type ConfigurationInteraction,
  type MatchingInteraction,
  type MultipleSelectInteraction,
  type ObjectiveQuestionType,
  type OrderingInteraction,
  type QuestionType,
  type SingleSelectInteraction,
} from "@/domain/assessment-question-types";
import { Badge } from "./ui";

export type ExamQuestion = {
  id: string;
  position: number;
  prompt: string;
  max_marks: number;
  question_type: QuestionType;
  interaction: unknown;
  saved_body: string | null;
  revision_count: number;
};

export type ExamAttempt = {
  id: string;
  attempt_number: number;
  expires_at: string;
};

// A draft is the learner's current, possibly unsaved, answer. Free text is
// a string; an objective answer is the structured response object (or null
// before any choice). Drafts live only in this component until saved.
type Draft = string | Record<string, unknown> | null;

function initialDraft(question: ExamQuestion): Draft {
  if (!isObjectiveQuestionType(question.question_type))
    return question.saved_body ?? "";
  const saved = parseResponseBody(question.question_type, question.saved_body);
  if (saved) return saved as Record<string, unknown>;
  // Ordering always holds a complete arrangement, starting from the
  // displayed order; it is not answered until the learner saves it.
  if (question.question_type === "PBQ_ORDERING")
    return {
      order: (question.interaction as OrderingInteraction).steps.map(
        (s) => s.id,
      ),
    };
  return null;
}

// The exact text that would be saved, or null when there is nothing valid
// to save yet. Objective answers use the one canonical serialisation the
// server also applies, so "saved" comparisons are exact.
function bodyFor(question: ExamQuestion, draft: Draft): string | null {
  if (!isObjectiveQuestionType(question.question_type))
    return typeof draft === "string" && draft.trim() ? draft : null;
  if (
    draft === null ||
    typeof draft === "string" ||
    responseIssues(question.question_type, question.interaction, draft).length
  )
    return null;
  return canonicalResponseBody(question.question_type, draft);
}

function savedBodyFor(question: ExamQuestion): string | null {
  if (question.saved_body === null) return null;
  if (!isObjectiveQuestionType(question.question_type))
    return question.saved_body;
  const parsed = parseResponseBody(question.question_type, question.saved_body);
  return parsed
    ? canonicalResponseBody(question.question_type, parsed)
    : question.saved_body;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Status = "SAVED" | "UNSAVED" | "UNANSWERED";

function ActionMessage({ state }: { state: AssessmentActionState }) {
  if (state.error)
    return (
      <p className="notice error" role="alert">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p className="notice" role="status">
        {state.message}
      </p>
    );
  return null;
}

// ---------------------------------------------------------------------------
// Per-type answer inputs. Every control is a native, keyboard-operable form
// element with a programmatic label. No drag-and-drop is required anywhere.
// ---------------------------------------------------------------------------
type InputProps<T> = {
  question: ExamQuestion;
  interaction: T;
  draft: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
};

function SingleSelectInput({
  question,
  interaction,
  draft,
  disabled,
  onChange,
}: InputProps<SingleSelectInteraction>) {
  const selected = (draft as { optionId?: string } | null)?.optionId;
  return (
    <fieldset className="exam-choices" disabled={disabled}>
      <legend className="sr-only">Answer options</legend>
      {interaction.options.map((option) => (
        <label key={option.id} className="exam-choice">
          <input
            type="radio"
            name={`answer-${question.id}`}
            value={option.id}
            checked={selected === option.id}
            onChange={() => onChange({ optionId: option.id })}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function MultipleSelectInput({
  question,
  interaction,
  draft,
  disabled,
  onChange,
}: InputProps<MultipleSelectInteraction>) {
  const selected = (draft as { optionIds?: string[] } | null)?.optionIds ?? [];
  const limit = interaction.requiredSelections;
  const full = limit !== null && selected.length >= limit;
  const countId = `count-${question.id}`;
  return (
    <fieldset className="exam-choices" disabled={disabled}>
      <legend className="sr-only">Answer options</legend>
      <p id={countId} className="muted" aria-live="polite">
        {limit === null
          ? `${selected.length} selected`
          : `${selected.length} of ${limit} selected`}
      </p>
      {interaction.options.map((option) => {
        const checked = selected.includes(option.id);
        return (
          <label key={option.id} className="exam-choice">
            <input
              type="checkbox"
              name={`answer-${question.id}`}
              value={option.id}
              checked={checked}
              disabled={!checked && full}
              aria-describedby={countId}
              onChange={() => {
                const next = checked
                  ? selected.filter((id) => id !== option.id)
                  : [...selected, option.id];
                onChange(next.length ? { optionIds: next } : null);
              }}
            />
            <span>{option.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

function MatchingInput({
  question,
  interaction,
  draft,
  disabled,
  onChange,
}: InputProps<MatchingInteraction>) {
  const matches =
    (draft as { matches?: Record<string, string> } | null)?.matches ?? {};
  return (
    <div className="exam-grid" role="group" aria-label="Matches">
      {interaction.items.map((item) => {
        const fieldId = `match-${question.id}-${item.id}`;
        return (
          <div className="exam-row" key={item.id}>
            <label htmlFor={fieldId}>{item.label}</label>
            <select
              id={fieldId}
              value={matches[item.id] ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const next = { ...matches };
                if (event.target.value) next[item.id] = event.target.value;
                else delete next[item.id];
                onChange(Object.keys(next).length ? { matches: next } : null);
              }}
            >
              <option value="">Choose a target…</option>
              {interaction.targets.map((target) => {
                const usedElsewhere =
                  !interaction.allowTargetReuse &&
                  Object.entries(matches).some(
                    ([other, t]) => other !== item.id && t === target.id,
                  );
                return (
                  <option
                    key={target.id}
                    value={target.id}
                    disabled={usedElsewhere}
                  >
                    {target.label}
                    {usedElsewhere ? " (already used)" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        );
      })}
    </div>
  );
}

function OrderingInput({
  question,
  interaction,
  draft,
  disabled,
  onChange,
}: InputProps<OrderingInteraction>) {
  const order =
    (draft as { order?: string[] } | null)?.order ??
    interaction.steps.map((s) => s.id);
  const [announcement, setAnnouncement] = useState("");
  const label = (id: string) =>
    interaction.steps.find((s) => s.id === id)?.label ?? id;
  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ order: next });
    setAnnouncement(
      `${label(order[index])} moved to position ${target + 1} of ${order.length}.`,
    );
  }
  return (
    <>
      <ol className="exam-order" aria-label="Current order">
        {order.map((id, index) => (
          <li key={id} className="exam-row">
            <span>
              <strong>{index + 1}.</strong> {label(id)}
            </span>
            <span className="exam-order-controls">
              <button
                type="button"
                className="button secondary"
                disabled={disabled || index === 0}
                aria-label={`Move "${label(id)}" up`}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={disabled || index === order.length - 1}
                aria-label={`Move "${label(id)}" down`}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
            </span>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite" id={`order-${question.id}`}>
        {announcement}
      </p>
    </>
  );
}

function ConfigurationInput({
  question,
  interaction,
  draft,
  disabled,
  onChange,
}: InputProps<ConfigurationInteraction>) {
  const values =
    (draft as { values?: Record<string, string> } | null)?.values ?? {};
  return (
    <>
      <div className="exam-scenario">
        <p className="eyebrow">SCENARIO</p>
        <p>{interaction.scenario}</p>
      </div>
      <div className="exam-grid" role="group" aria-label="Configuration">
        {interaction.fields.map((field) => {
          const fieldId = `config-${question.id}-${field.id}`;
          return (
            <div className="exam-row" key={field.id}>
              <label htmlFor={fieldId}>{field.label}</label>
              <select
                id={fieldId}
                value={values[field.id] ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  const next = { ...values };
                  if (event.target.value) next[field.id] = event.target.value;
                  else delete next[field.id];
                  onChange(Object.keys(next).length ? { values: next } : null);
                }}
              >
                <option value="">Choose a setting…</option>
                {field.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </>
  );
}

function FreeTextInput({
  question,
  draft,
  disabled,
  onChange,
}: Omit<InputProps<unknown>, "interaction">) {
  const text = typeof draft === "string" ? draft : "";
  const id = `answer-${question.id}`;
  return (
    <div className="field">
      <label htmlFor={id}>Your answer</label>
      <textarea
        id={id}
        rows={10}
        maxLength={20000}
        value={text}
        disabled={disabled}
        aria-describedby={`${id}-count`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-count`} className="muted">
        {text.length.toLocaleString()} / 20,000 characters
      </p>
    </div>
  );
}

function AnswerInput(props: Omit<InputProps<unknown>, "interaction">) {
  const { question } = props;
  const interaction = question.interaction;
  switch (question.question_type) {
    case "SINGLE_SELECT":
      return (
        <SingleSelectInput
          {...props}
          interaction={interaction as SingleSelectInteraction}
        />
      );
    case "MULTIPLE_SELECT":
      return (
        <MultipleSelectInput
          {...props}
          interaction={interaction as MultipleSelectInteraction}
        />
      );
    case "PBQ_MATCHING":
      return (
        <MatchingInput
          {...props}
          interaction={interaction as MatchingInteraction}
        />
      );
    case "PBQ_ORDERING":
      return (
        <OrderingInput
          {...props}
          interaction={interaction as OrderingInteraction}
        />
      );
    case "PBQ_CONFIGURATION":
      return (
        <ConfigurationInput
          {...props}
          interaction={interaction as ConfigurationInteraction}
        />
      );
    case "FREE_TEXT":
      return <FreeTextInput {...props} />;
  }
}

// One question at a time, with its OWN save state so a save message is only
// ever shown beside the question it belongs to. Keyed by question id.
function QuestionPanel({
  attempt,
  question,
  draft,
  status,
  expired,
  onChange,
}: {
  attempt: ExamAttempt;
  question: ExamQuestion;
  draft: Draft;
  status: Status;
  expired: boolean;
  onChange: (draft: Draft) => void;
}) {
  const [saveState, saveAction, saving] = useActionState<
    AssessmentActionState,
    FormData
  >(saveControlledAssessmentResponse, {});
  const body = bodyFor(question, draft);
  const canSave = !expired && body !== null && body !== savedBodyFor(question);
  const objective = isObjectiveQuestionType(question.question_type)
    ? (question.question_type as ObjectiveQuestionType)
    : null;
  return (
    <>
      <div className="exam-question-head">
        <Badge tone="blue">QUESTION {question.position}</Badge>
        <span className="muted">
          {QUESTION_TYPE_LABELS[question.question_type]} · {question.max_marks}{" "}
          mark{question.max_marks === 1 ? "" : "s"} · {STATUS_TEXT[status]}
        </span>
      </div>
      <h3 className="exam-prompt">{question.prompt}</h3>
      {objective && (
        <>
          <p className="exam-instruction">
            {selectionInstruction(objective, question.interaction)}
          </p>
          <p className="muted">
            Scoring:{" "}
            {
              SCORING_RULE_DESCRIPTIONS[
                scoringRuleOf(objective, question.interaction)
              ]
            }
          </p>
        </>
      )}
      <AnswerInput
        question={question}
        draft={draft}
        disabled={expired || saving}
        onChange={onChange}
      />
      {body === null && question.saved_body !== null && (
        <p className="muted">
          An empty answer cannot be saved. Your previously saved answer remains
          recorded for this question.
        </p>
      )}
      <ActionMessage state={saveState} />
      <form action={saveAction} className="exam-actions">
        <input type="hidden" name="attemptId" value={attempt.id} />
        <input type="hidden" name="questionId" value={question.id} />
        <input
          type="hidden"
          name="questionType"
          value={question.question_type}
        />
        <input type="hidden" name="body" value={body ?? ""} />
        {/* The idempotency key is derived on the server from SHA-256 of the
            exact body (src/server/assessment-save-key.ts); the browser only
            states which revision slot this save answers, so an identical
            retry before the page refreshes reuses the same key. */}
        <input
          type="hidden"
          name="revisionSlot"
          value={question.revision_count + 1}
        />
        <button className="button" disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save answer"}
        </button>
      </form>
    </>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  SAVED: "Answer saved",
  UNSAVED: "Unsaved changes",
  UNANSWERED: "Not answered",
};

export function ExamWorkspace({
  title,
  instructions,
  attempt,
  questions,
  serverNow,
}: {
  title: string;
  instructions: string;
  attempt: ExamAttempt;
  questions: ExamQuestion[];
  serverNow: string;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initialDraft(q)])),
  );
  const [reviewing, setReviewing] = useState(false);
  // Move focus to the confirmation heading when it opens, so keyboard and
  // screen-reader users land on the decision rather than a removed control.
  useEffect(() => {
    if (reviewing) document.getElementById("exam-review-title")?.focus();
  }, [reviewing]);
  const [finishState, finishAction, finishing] = useActionState<
    AssessmentActionState,
    FormData
  >(finishControlledAssessment, {});

  // Countdown display only. The offset aligns this display with server
  // time; the initial render uses serverNow so server and client markup
  // agree. Expiry is enforced by the database regardless of this timer.
  const offset = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    if (offset.current === null)
      offset.current = Date.parse(serverNow) - Date.now();
    const tick = () => setNow(Date.now() + (offset.current ?? 0));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [serverNow]);
  const remaining = Date.parse(attempt.expires_at) - now;
  const expired = remaining <= 0;
  const minutesLeft = Math.ceil(remaining / 60000);
  const warning = !expired && remaining <= 5 * 60000;
  // Derived, not stored: the live region text changes (and is announced)
  // only when entering the 10/5/1-minute marks or expiry.
  const timeAnnouncement = expired
    ? "Time is up."
    : [10, 5, 1].includes(minutesLeft)
      ? `${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} remaining.`
      : "";

  const statuses = useMemo(
    () =>
      Object.fromEntries(
        questions.map((q) => {
          const body = bodyFor(q, drafts[q.id] ?? null);
          const saved = savedBodyFor(q);
          // An untouched ordering question holds its displayed arrangement:
          // that is a savable draft but not yet an answer.
          const untouched =
            saved === null &&
            (body === null || body === bodyFor(q, initialDraft(q)));
          const status: Status =
            saved !== null && body === saved
              ? "SAVED"
              : saved === null && untouched
                ? "UNANSWERED"
                : "UNSAVED";
          return [q.id, status];
        }),
      ) as Record<string, Status>,
    [questions, drafts],
  );
  const answeredCount = questions.filter((q) => q.saved_body !== null).length;
  const unsaved = questions.filter((q) => statuses[q.id] === "UNSAVED");
  const unanswered = questions.filter((q) => q.saved_body === null);

  const question = questions[Math.min(current, questions.length - 1)];
  if (!question)
    return (
      <p className="notice error" role="alert">
        This attempt has no released questions. Contact your institution.
      </p>
    );
  const draft = drafts[question.id] ?? null;

  return (
    <section className="card exam" aria-labelledby="exam-title">
      <div className="exam-header">
        <div>
          <p className="eyebrow">
            CONTROLLED ASSESSMENT · ATTEMPT {attempt.attempt_number}
          </p>
          <h2 id="exam-title">{title}</h2>
        </div>
        <div
          className={`exam-timer${warning ? " warning" : ""}${expired ? " expired" : ""}`}
        >
          <span className="muted">Time remaining</span>
          <strong role="timer" aria-live="off">
            {expired ? "0:00" : formatRemaining(remaining)}
          </strong>
          <span className="muted">
            Ends {new Date(attempt.expires_at).toLocaleTimeString()}
          </span>
        </div>
      </div>
      <p className="sr-only" aria-live="assertive">
        {timeAnnouncement}
      </p>
      <p>{instructions}</p>
      <p className="muted">
        {answeredCount} of {questions.length} answered. Select Save answer after
        answering each question; answers are not saved automatically. Saved
        answers stay with this attempt if you refresh or come back.
      </p>

      {expired && (
        <div className="notice error" role="alert">
          <p>
            Time is up. Answers saved before the deadline are final, and the
            attempt is submitted automatically at its deadline. Unsaved changes
            were not recorded.
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => router.refresh()}
          >
            Refresh attempt status
          </button>
        </div>
      )}

      <div className="exam-layout">
        <nav className="exam-nav" aria-label="Questions">
          <ol>
            {questions.map((q, index) => (
              <li key={q.id}>
                <button
                  type="button"
                  className={`exam-nav-item ${statuses[q.id].toLowerCase()}`}
                  aria-current={index === current ? "step" : undefined}
                  aria-label={`Question ${q.position}: ${STATUS_TEXT[statuses[q.id]]}`}
                  onClick={() => {
                    setCurrent(index);
                    setReviewing(false);
                  }}
                >
                  <span aria-hidden="true">{q.position}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="muted exam-legend" aria-hidden="true">
            ● saved · ◐ unsaved · ○ not answered
          </p>
        </nav>

        <div className="exam-main">
          {reviewing ? (
            <div
              className="exam-review"
              role="region"
              aria-labelledby="exam-review-title"
            >
              <h3 id="exam-review-title" tabIndex={-1}>
                Submit your final answers?
              </h3>
              <p>
                {answeredCount} of {questions.length} questions have a saved
                answer. Only saved answers are submitted. After submitting you
                cannot change any answer.
              </p>
              {unanswered.length > 0 && (
                <p className="notice error">
                  Not answered: question
                  {unanswered.length === 1 ? "" : "s"}{" "}
                  {unanswered.map((q) => q.position).join(", ")}.
                </p>
              )}
              {unsaved.length > 0 && (
                <p className="notice error">
                  Unsaved changes on question
                  {unsaved.length === 1 ? "" : "s"}{" "}
                  {unsaved.map((q) => q.position).join(", ")} will not be
                  submitted.
                </p>
              )}
              <ActionMessage state={finishState} />
              <form action={finishAction} className="exam-actions">
                <input type="hidden" name="attemptId" value={attempt.id} />
                <button className="button" disabled={finishing}>
                  {finishing ? "Submitting…" : "Submit final answers"}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setReviewing(false)}
                >
                  Return to questions
                </button>
              </form>
            </div>
          ) : (
            <>
              <QuestionPanel
                key={question.id}
                attempt={attempt}
                question={question}
                draft={draft}
                status={statuses[question.id]}
                expired={expired}
                onChange={(next) =>
                  setDrafts((all) => ({ ...all, [question.id]: next }))
                }
              />
              <div className="exam-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={current === 0}
                  onClick={() => setCurrent((i) => Math.max(0, i - 1))}
                >
                  Previous question
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={current >= questions.length - 1}
                  onClick={() =>
                    setCurrent((i) => Math.min(questions.length - 1, i + 1))
                  }
                >
                  Next question
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={expired}
                  onClick={() => setReviewing(true)}
                >
                  Review and submit
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
