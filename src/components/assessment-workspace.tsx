"use client";

import { useActionState, useState } from "react";
import {
  addControlledAssessment,
  addProtectedAssessmentQuestion,
  publishOrCloseAssessment,
  type AssessmentActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";
import { LocalDateTimeField } from "./local-datetime-field";

type Assessment = {
  id: string;
  cohort_id: string;
  programme_version_id: string;
  lesson_id: string;
  instructor_id: string;
  title: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  duration_minutes: number;
  attempts_allowed: number;
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  created_at: string;
  cohorts: { title: string };
  lessons: { title: string };
  programme_versions: { label: string; title_snapshot: string | null };
};

type Question = {
  id: string;
  position: number;
  prompt: string;
  max_marks: number;
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
type Cohort = { id: string; title: string; programme_version_id: string };
type Lesson = { id: string; title: string; programme_version_id: string };
type Instructor = { user_id: string; display_name: string; title: string };

function Message({ state }: { state: AssessmentActionState }) {
  if (state.error) return <p className="notice error">{state.error}</p>;
  if (state.message) return <p className="notice">{state.message}</p>;
  return null;
}

export function AssessmentWorkspace({
  assessments,
  attempts,
  questionsByAssessment,
  cohorts,
  lessons,
  instructors,
}: {
  assessments: Assessment[];
  attempts: Attempt[];
  questionsByAssessment: Record<string, Question[]>;
  cohorts: Cohort[];
  lessons: Lesson[];
  instructors: Instructor[];
}) {
  const [createState, createAction, creating] = useActionState<
    AssessmentActionState,
    FormData
  >(addControlledAssessment, {});
  const [questionState, questionAction, addingQuestion] = useActionState<
    AssessmentActionState,
    FormData
  >(addProtectedAssessmentQuestion, {});
  const [statusState, statusAction, changingStatus] = useActionState<
    AssessmentActionState,
    FormData
  >(publishOrCloseAssessment, {});
  const [selectedCohortId, setSelectedCohortId] = useState("");
  const selectedCohort = cohorts.find(
    (cohort) => cohort.id === selectedCohortId,
  );
  const matchingLessons = selectedCohort
    ? lessons.filter(
        (lesson) =>
          lesson.programme_version_id === selectedCohort.programme_version_id,
      )
    : [];

  return (
    <>
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONTROLLED ASSESSMENT</p>
            <h2>Create assessment draft</h2>
          </div>
          <Badge tone="gold">PROTECTED CONTENT</Badge>
        </div>
        <p className="muted">
          Questions and answer keys stay server-controlled. Publishing requires
          protected question content and does not enable automatic grading.
        </p>
        <Message state={createState} />
        <form action={createAction} className="support-form">
          <select
            name="cohortId"
            required
            value={selectedCohortId}
            onChange={(event) => setSelectedCohortId(event.target.value)}
          >
            <option value="" disabled>
              Choose cohort
            </option>
            {cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.title}
              </option>
            ))}
          </select>
          <select
            name="lessonId"
            required
            disabled={!selectedCohort}
            defaultValue=""
            key={selectedCohortId || "no-cohort"}
          >
            <option value="" disabled>
              {selectedCohort ? "Choose lesson" : "Choose cohort first"}
            </option>
            {matchingLessons.map((lesson) => (
              <option key={lesson.id} value={lesson.id}>
                {lesson.title}
              </option>
            ))}
          </select>
          <select name="instructorId" required defaultValue="">
            <option value="" disabled>
              Choose instructor
            </option>
            {instructors.map((instructor) => (
              <option key={instructor.user_id} value={instructor.user_id}>
                {instructor.display_name} · {instructor.title}
              </option>
            ))}
          </select>
          <input
            name="title"
            maxLength={200}
            placeholder="Assessment title"
            required
          />
          <textarea
            name="instructions"
            maxLength={12000}
            rows={5}
            placeholder="Learner instructions"
            required
          />
          <LocalDateTimeField
            id="assessment-opens"
            name="opensAt"
            label="Opens"
          />
          <LocalDateTimeField
            id="assessment-closes"
            name="closesAt"
            label="Closes"
          />
          <input
            type="number"
            name="durationMinutes"
            min={1}
            max={360}
            defaultValue={60}
            required
          />
          <input
            type="number"
            name="attemptsAllowed"
            min={1}
            max={5}
            defaultValue={1}
            required
          />
          <input
            name="reason"
            minLength={5}
            maxLength={300}
            placeholder="Institutional reason"
            required
          />
          <button className="button" disabled={creating}>
            {creating ? "Creating…" : "Create assessment draft"}
          </button>
        </form>
      </Card>

      <Card>
        <h2>Add protected question</h2>
        <Message state={questionState} />
        <form action={questionAction} className="support-form">
          <select name="assessmentId" required defaultValue="">
            <option value="" disabled>
              Choose draft assessment
            </option>
            {assessments
              .filter((a) => a.status === "DRAFT")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
          </select>
          <input
            type="number"
            name="position"
            min={1}
            placeholder="Question position"
            required
          />
          <input
            type="number"
            name="maxMarks"
            min={1}
            max={100}
            placeholder="Maximum marks"
            required
          />
          <textarea
            name="prompt"
            rows={5}
            maxLength={12000}
            placeholder="Protected question prompt"
            required
          />
          <textarea
            name="expectedAnswer"
            rows={5}
            maxLength={12000}
            placeholder="Protected expected answer"
            required
          />
          <textarea
            name="markingGuidance"
            rows={4}
            maxLength={12000}
            placeholder="Optional protected marking guidance"
          />
          <input
            name="reason"
            minLength={5}
            maxLength={300}
            placeholder="Institutional reason"
            required
          />
          <button className="button" disabled={addingQuestion}>
            {addingQuestion ? "Adding…" : "Add protected question"}
          </button>
        </form>
      </Card>

      <Card>
        <h2>Assessment register</h2>
        <Message state={statusState} />
        {assessments.length ? (
          assessments.map((assessment) => {
            const questions = questionsByAssessment[assessment.id] ?? [];
            const relatedAttempts = attempts.filter(
              (attempt) => attempt.assessment_id === assessment.id,
            );
            return (
              <div className="support-record" key={assessment.id}>
                <Badge
                  tone={
                    assessment.status === "PUBLISHED"
                      ? "green"
                      : assessment.status === "DRAFT"
                        ? "blue"
                        : "muted"
                  }
                >
                  {assessment.status}
                </Badge>
                <h3>{assessment.title}</h3>
                <p>
                  {assessment.lessons.title} · {assessment.cohorts.title}
                </p>
                <p className="muted">
                  {assessment.duration_minutes} minutes ·{" "}
                  {assessment.attempts_allowed} attempt
                  {assessment.attempts_allowed === 1 ? "" : "s"} ·{" "}
                  {questions.length} protected question
                  {questions.length === 1 ? "" : "s"} · {relatedAttempts.length}{" "}
                  attempt record{relatedAttempts.length === 1 ? "" : "s"}
                </p>
                {questions.map((question) => (
                  <p className="muted" key={question.id}>
                    Q{question.position}: {question.prompt} ·{" "}
                    {question.max_marks} marks
                  </p>
                ))}
                {assessment.status !== "CLOSED" && (
                  <form
                    action={statusAction}
                    className="support-form compact-form"
                  >
                    <input
                      type="hidden"
                      name="assessmentId"
                      value={assessment.id}
                    />
                    <input
                      type="hidden"
                      name="status"
                      value={
                        assessment.status === "DRAFT" ? "PUBLISHED" : "CLOSED"
                      }
                    />
                    <input
                      name="reason"
                      minLength={5}
                      maxLength={300}
                      placeholder="Lifecycle reason"
                      required
                    />
                    <button
                      className="button secondary"
                      disabled={changingStatus}
                    >
                      {assessment.status === "DRAFT"
                        ? "Publish assessment"
                        : "Close assessment"}
                    </button>
                  </form>
                )}
              </div>
            );
          })
        ) : (
          <EmptyState title="No assessments yet">
            Controlled assessment drafts will appear here.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
