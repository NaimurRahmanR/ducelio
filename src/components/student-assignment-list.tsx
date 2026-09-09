"use client";

import { useActionState } from "react";
import {
  submitCoursework,
  type AssignmentSubmissionActionState,
} from "@/app/student/actions";
import { Badge, EmptyState } from "./ui";

type Assignment = {
  id: string;
  title: string;
  instructions: string;
  opens_at: string;
  due_at: string;
  status: "PUBLISHED" | "CLOSED";
  lessons: { title: string };
  programme_versions: { label: string; title_snapshot: string | null };
};

type Submission = {
  id: string;
  assignment_id: string;
  attempt_number: number;
  submitted_at: string;
};

function AssignmentItem({
  assignment,
  submissions,
}: {
  assignment: Assignment;
  submissions: Submission[];
}) {
  const [state, formAction, pending] = useActionState<
    AssignmentSubmissionActionState,
    FormData
  >(submitCoursework, {});
  const now = Date.now();
  const isOpen =
    assignment.status === "PUBLISHED" &&
    now >= new Date(assignment.opens_at).getTime() &&
    now <= new Date(assignment.due_at).getTime();
  const attempts = submissions.filter(
    (submission) => submission.assignment_id === assignment.id,
  );

  return (
    <div className="support-record">
      <Badge tone={assignment.status === "PUBLISHED" ? "green" : "muted"}>
        {assignment.status}
      </Badge>
      <h3>{assignment.title}</h3>
      <p>
        {assignment.lessons.title} · {assignment.programme_versions.label}
      </p>
      <p>{assignment.instructions}</p>
      <p className="muted">
        Opens {new Date(assignment.opens_at).toLocaleString()} · Due{" "}
        {new Date(assignment.due_at).toLocaleString()}
      </p>
      <p className="muted">
        {attempts.length
          ? `${attempts.length} submission attempt${attempts.length === 1 ? "" : "s"} recorded.`
          : "No submission recorded yet."}
      </p>
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
      {isOpen ? (
        <form action={formAction} className="support-form">
          <input type="hidden" name="assignmentId" value={assignment.id} />
          <div className="field">
            <label htmlFor={`assignment-body-${assignment.id}`}>Your response</label>
            <textarea
              id={`assignment-body-${assignment.id}`}
              name="body"
              rows={8}
              maxLength={20000}
              required
            />
          </div>
          <div className="field">
            <label htmlFor={`assignment-key-${assignment.id}`}>
              Submission reference
            </label>
            <input
              id={`assignment-key-${assignment.id}`}
              name="idempotencyKey"
              minLength={8}
              maxLength={200}
              placeholder="Use a new stable reference for each attempt"
              required
            />
          </div>
          <button className="button" disabled={pending}>
            {pending ? "Submitting…" : "Submit assignment"}
          </button>
        </form>
      ) : (
        <p className="muted">This assignment is not currently open for submission.</p>
      )}
    </div>
  );
}

export function StudentAssignmentList({
  assignments,
  submissions,
}: {
  assignments: Assignment[];
  submissions: Submission[];
}) {
  if (!assignments.length) {
    return (
      <EmptyState title="No assignments available">
        Published coursework for your enrolled cohort will appear here.
      </EmptyState>
    );
  }

  return assignments.map((assignment) => (
    <AssignmentItem
      key={assignment.id}
      assignment={assignment}
      submissions={submissions}
    />
  ));
}
