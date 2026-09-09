"use client";

import { useActionState } from "react";
import {
  addAssignment,
  publishOrCloseAssignment,
  type AssignmentActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Assignment = {
  id: string;
  cohort_id: string;
  programme_version_id: string;
  lesson_id: string;
  instructor_id: string;
  title: string;
  instructions: string;
  opens_at: string;
  due_at: string;
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  created_at: string;
  published_at: string | null;
  closed_at: string | null;
  cohorts: { title: string };
  lessons: { title: string };
  programme_versions: { label: string; title_snapshot: string | null };
};

type Submission = {
  id: string;
  assignment_id: string;
  enrolment_id: string;
  student_id: string;
  attempt_number: number;
  submitted_at: string;
};

type Cohort = { id: string; title: string; programme_version_id: string };
type Lesson = { id: string; title: string; programme_version_id: string };
type Instructor = { user_id: string; display_name: string; title: string };

export function AssignmentWorkspace({
  assignments,
  submissions,
  cohorts,
  lessons,
  instructors,
}: {
  assignments: Assignment[];
  submissions: Submission[];
  cohorts: Cohort[];
  lessons: Lesson[];
  instructors: Instructor[];
}) {
  const [createState, createAction, creating] = useActionState<
    AssignmentActionState,
    FormData
  >(addAssignment, {});
  const [statusState, statusAction, changing] = useActionState<
    AssignmentActionState,
    FormData
  >(publishOrCloseAssignment, {});

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">GOVERNED COURSEWORK</p>
            <h2>Create assignment</h2>
          </div>
          <Badge tone="blue">NOT ASSESSMENT</Badge>
        </div>
        <p className="muted">
          Assignments are ordinary coursework. Submission does not automatically
          create learning evidence, mastery or a grade.
        </p>
        {createState.error && (
          <p className="notice error">{createState.error}</p>
        )}
        {createState.message && <p className="notice">{createState.message}</p>}
        {!cohorts.length || !lessons.length || !instructors.length ? (
          <EmptyState title="Assignment prerequisites are incomplete">
            A published cohort, matching lesson and instructor are required.
          </EmptyState>
        ) : (
          <form action={createAction} className="support-form">
            <div className="field">
              <label htmlFor="assignment-cohort">Cohort</label>
              <select id="assignment-cohort" name="cohortId" required>
                <option value="">Select cohort</option>
                {cohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="assignment-lesson">Lesson</label>
              <select id="assignment-lesson" name="lessonId" required>
                <option value="">Select lesson</option>
                {lessons.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="assignment-instructor">Instructor</label>
              <select id="assignment-instructor" name="instructorId" required>
                <option value="">Select instructor</option>
                {instructors.map((instructor) => (
                  <option key={instructor.user_id} value={instructor.user_id}>
                    {instructor.display_name} · {instructor.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="assignment-title">Title</label>
              <input
                id="assignment-title"
                name="title"
                maxLength={200}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="assignment-instructions">Instructions</label>
              <textarea
                id="assignment-instructions"
                name="instructions"
                rows={8}
                maxLength={12000}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="assignment-opens">Opens at</label>
              <input
                id="assignment-opens"
                name="opensAt"
                type="datetime-local"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="assignment-due">Due at</label>
              <input
                id="assignment-due"
                name="dueAt"
                type="datetime-local"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="assignment-reason">Creation reason</label>
              <input
                id="assignment-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={creating}>
              {creating ? "Creating…" : "Create draft"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Assignment register</h2>
          <Badge tone="muted">AUDITED</Badge>
        </div>
        {statusState.error && (
          <p className="notice error">{statusState.error}</p>
        )}
        {statusState.message && <p className="notice">{statusState.message}</p>}
        {assignments.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Lesson</th>
                  <th>Window</th>
                  <th>Submissions</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => {
                  const count = submissions.filter(
                    (submission) => submission.assignment_id === assignment.id,
                  ).length;
                  return (
                    <tr key={assignment.id}>
                      <td>
                        <strong>{assignment.title}</strong>
                        <div className="muted">{assignment.cohorts.title}</div>
                      </td>
                      <td>{assignment.lessons.title}</td>
                      <td>
                        {new Date(assignment.opens_at).toLocaleString()}
                        <div className="muted">
                          Due {new Date(assignment.due_at).toLocaleString()}
                        </div>
                      </td>
                      <td>{count}</td>
                      <td>
                        <Badge
                          tone={
                            assignment.status === "PUBLISHED"
                              ? "green"
                              : assignment.status === "CLOSED"
                                ? "muted"
                                : "blue"
                          }
                        >
                          {assignment.status}
                        </Badge>
                      </td>
                      <td>
                        {assignment.status !== "CLOSED" ? (
                          <form action={statusAction} className="inline-form">
                            <input
                              type="hidden"
                              name="assignmentId"
                              value={assignment.id}
                            />
                            <input
                              type="hidden"
                              name="status"
                              value={
                                assignment.status === "DRAFT"
                                  ? "PUBLISHED"
                                  : "CLOSED"
                              }
                            />
                            <input
                              name="reason"
                              minLength={5}
                              maxLength={300}
                              placeholder="Reason"
                              required
                            />
                            <button
                              className="button secondary"
                              disabled={changing}
                            >
                              {assignment.status === "DRAFT"
                                ? "Publish"
                                : "Close"}
                            </button>
                          </form>
                        ) : (
                          <span className="muted">Closed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No assignments yet">
            Create the first governed coursework assignment.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
