"use client";
import { useActionState } from "react";
import {
  submitAssessmentReviewAction,
  submitLabReviewAction,
  type AcademicReviewActionState,
} from "@/app/admin/academic-review/actions";
import type { AcademicReviewQuestion } from "@/domain/commercial-v1-academic-review";

function Outcome({ state }: { state: AcademicReviewActionState }) {
  return (
    <>
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="notice" role="status">
          {state.message}
        </p>
      )}
    </>
  );
}

function ReasonField({ id }: { id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        Institutional reason (recorded in the audit trail)
      </label>
      <textarea
        id={id}
        name="reason"
        minLength={5}
        maxLength={300}
        rows={2}
        required
        placeholder="Escalated grade reviewed by the academic team"
      />
    </div>
  );
}

// Authoritative max marks are shown for the reviewer's judgment but are
// never submitted: the database reads them from the assessment itself. An
// unanswered question can only receive 0 (the Examiner finalizer's own
// rule), so it is rendered as a fixed, explained 0 rather than an input.
export function AssessmentReviewForm({
  caseId,
  questions,
}: {
  caseId: string;
  questions: AcademicReviewQuestion[];
}) {
  const [state, action, pending] = useActionState<
    AcademicReviewActionState,
    FormData
  >(submitAssessmentReviewAction, {});
  return (
    <form action={action} className="support-form">
      <Outcome state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      {questions.map((q) => (
        <fieldset key={q.questionId} className="card">
          <legend>
            Question {q.position} · out of {q.maxMarks}
          </legend>
          <p>{q.prompt}</p>
          <p className="muted">Learner response:</p>
          <p>{q.answered ? q.responseBody : "No response submitted."}</p>
          {q.expectedAnswer && (
            <>
              <p className="muted">Expected answer:</p>
              <p>{q.expectedAnswer}</p>
            </>
          )}
          {q.markingGuidance && (
            <>
              <p className="muted">Marking guidance:</p>
              <p>{q.markingGuidance}</p>
            </>
          )}
          {q.answered ? (
            <div className="field">
              <label htmlFor={`mark-${q.questionId}`}>
                Marks awarded (0–{q.maxMarks})
              </label>
              <input
                id={`mark-${q.questionId}`}
                name={`mark:${q.questionId}`}
                type="number"
                min={0}
                max={q.maxMarks}
                step={1}
                required
              />
            </div>
          ) : (
            <>
              <input type="hidden" name={`mark:${q.questionId}`} value="0" />
              <p className="muted">Recorded as 0: no response was submitted.</p>
            </>
          )}
        </fieldset>
      ))}
      <ReasonField id={`reason-${caseId}`} />
      <button className="button" disabled={pending}>
        {pending ? "Recording…" : "Record first grade"}
      </button>
    </form>
  );
}

export function LabReviewForm({
  caseId,
  maxMarks,
}: {
  caseId: string;
  maxMarks: number;
}) {
  const [state, action, pending] = useActionState<
    AcademicReviewActionState,
    FormData
  >(submitLabReviewAction, {});
  return (
    <form action={action} className="support-form">
      <Outcome state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <div className="field">
        <label htmlFor={`lab-mark-${caseId}`}>
          Marks awarded (0–{maxMarks})
        </label>
        <input
          id={`lab-mark-${caseId}`}
          name="marksAwarded"
          type="number"
          min={0}
          max={maxMarks}
          step={1}
          required
        />
      </div>
      <ReasonField id={`reason-${caseId}`} />
      <button className="button" disabled={pending}>
        {pending ? "Recording…" : "Record first grade"}
      </button>
    </form>
  );
}
