"use client";

import { useActionState } from "react";
import {
  beginControlledAssessment,
  finishControlledAssessment,
  saveControlledAssessmentResponse,
  type AssessmentActionState,
} from "@/app/student/actions";
import { Badge, Card, EmptyState } from "./ui";

type Assessment = {
  id: string;
  title: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  duration_minutes: number;
  attempts_allowed: number;
  status: "PUBLISHED" | "CLOSED";
  lessons: { title: string };
  programme_versions: { label: string; title_snapshot: string | null };
};

type Attempt = {
  id: string;
  assessment_id: string;
  attempt_number: number;
  state: "ACTIVE" | "SUBMITTED" | "VOIDED";
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
};

type Question = {
  id: string;
  position: number;
  prompt: string;
  max_marks: number;
};
type Response = {
  id: string;
  attempt_id: string;
  question_id: string;
  revision_number: number;
  recorded_at: string;
};

function ActionMessage({ state }: { state: AssessmentActionState }) {
  if (state.error) return <p className="notice error">{state.error}</p>;
  if (state.message) return <p className="notice">{state.message}</p>;
  return null;
}

function AssessmentResponseForm({
  attempt,
  question,
  responses,
}: {
  attempt: Attempt;
  question: Question;
  responses: Response[];
}) {
  const [state, action, pending] = useActionState<
    AssessmentActionState,
    FormData
  >(saveControlledAssessmentResponse, {});
  const revisions = responses.filter(
    (response) =>
      response.attempt_id === attempt.id &&
      response.question_id === question.id,
  );
  return (
    <div className="support-record">
      <Badge tone="blue">QUESTION {question.position}</Badge>
      <h3>{question.prompt}</h3>
      <p className="muted">
        Maximum {question.max_marks} marks · {revisions.length} saved revision
        {revisions.length === 1 ? "" : "s"}
      </p>
      <ActionMessage state={state} />
      <form action={action} className="support-form">
        <input type="hidden" name="attemptId" value={attempt.id} />
        <input type="hidden" name="questionId" value={question.id} />
        <textarea
          name="body"
          rows={8}
          maxLength={20000}
          placeholder="Your assessment response"
          required
        />
        <input
          name="idempotencyKey"
          minLength={8}
          maxLength={200}
          placeholder="Stable save reference for this revision"
          required
        />
        <button className="button" disabled={pending}>
          {pending ? "Saving…" : "Save response revision"}
        </button>
      </form>
    </div>
  );
}

export function StudentAssessments({
  assessments,
  attempts,
  responses,
  activityState,
  activeQuestions,
}: {
  assessments: Assessment[];
  attempts: Attempt[];
  responses: Response[];
  activityState: "NORMAL" | "CONTROLLED_ASSESSMENT_ACTIVE";
  activeQuestions: Question[];
}) {
  const [startState, startAction, starting] = useActionState<
    AssessmentActionState,
    FormData
  >(beginControlledAssessment, {});
  const [finishState, finishAction, finishing] = useActionState<
    AssessmentActionState,
    FormData
  >(finishControlledAssessment, {});
  const activeAttempt = attempts.find((attempt) => attempt.state === "ACTIVE");

  return (
    <>
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">SERVER-CONTROLLED ACTIVITY STATE</p>
            <h2>Assessments</h2>
          </div>
          <Badge
            tone={
              activityState === "CONTROLLED_ASSESSMENT_ACTIVE"
                ? "gold"
                : "muted"
            }
          >
            {activityState.replaceAll("_", " ")}
          </Badge>
        </div>
        <p className="muted">
          Protected questions are released only after the backend creates an
          active attempt. During that attempt, normal academic-help actions are
          restricted by the deterministic activity firewall.
        </p>
        <ActionMessage state={startState} />
        {assessments.length ? (
          assessments.map((assessment) => {
            const ownAttempts = attempts.filter(
              (attempt) => attempt.assessment_id === assessment.id,
            );
            return (
              <div className="support-record" key={assessment.id}>
                <Badge
                  tone={assessment.status === "PUBLISHED" ? "green" : "muted"}
                >
                  {assessment.status}
                </Badge>
                <h3>{assessment.title}</h3>
                <p>
                  {assessment.lessons.title} ·{" "}
                  {assessment.programme_versions.label}
                </p>
                <p>{assessment.instructions}</p>
                <p className="muted">
                  {assessment.duration_minutes} minutes · up to{" "}
                  {assessment.attempts_allowed} attempt
                  {assessment.attempts_allowed === 1 ? "" : "s"} · opens{" "}
                  {new Date(assessment.opens_at).toLocaleString()} · closes{" "}
                  {new Date(assessment.closes_at).toLocaleString()}
                </p>
                <p className="muted">
                  {ownAttempts.length} attempt record
                  {ownAttempts.length === 1 ? "" : "s"}
                </p>
                {assessment.status === "PUBLISHED" && !activeAttempt && (
                  <form action={startAction}>
                    <input
                      type="hidden"
                      name="assessmentId"
                      value={assessment.id}
                    />
                    <button className="button" disabled={starting}>
                      {starting ? "Starting…" : "Start controlled assessment"}
                    </button>
                  </form>
                )}
              </div>
            );
          })
        ) : (
          <EmptyState title="No controlled assessments available">
            Published assessments for your enrolled cohort will appear here.
          </EmptyState>
        )}
      </Card>

      {activeAttempt && (
        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">ACTIVE ATTEMPT</p>
              <h2>Protected assessment content</h2>
            </div>
            <Badge tone="gold">ATTEMPT {activeAttempt.attempt_number}</Badge>
          </div>
          <p className="muted">
            Attempt expires{" "}
            {new Date(activeAttempt.expires_at).toLocaleString()}. Response
            saves are append-only revisions; only the latest submitted academic
            record should later be interpreted by a grading workflow.
          </p>
          {activeQuestions.map((question) => (
            <AssessmentResponseForm
              key={question.id}
              attempt={activeAttempt}
              question={question}
              responses={responses}
            />
          ))}
          <ActionMessage state={finishState} />
          <form action={finishAction}>
            <input type="hidden" name="attemptId" value={activeAttempt.id} />
            <button className="button" disabled={finishing}>
              {finishing ? "Submitting…" : "Submit assessment attempt"}
            </button>
          </form>
        </Card>
      )}
    </>
  );
}
