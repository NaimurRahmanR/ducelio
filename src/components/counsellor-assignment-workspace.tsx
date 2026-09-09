"use client";

import { useActionState } from "react";
import {
  assignLearnerCounsellor,
  type CounsellorAssignmentActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Learner = {
  user_id: string;
  student_number: string;
  display_name: string;
};

type Counsellor = {
  user_id: string;
  display_name: string;
  title: string;
};

type Assignment = {
  id: string;
  student_id: string;
  counsellor_id: string;
  starts_at: string;
  ended_at: string | null;
  learner_name: string;
  student_number: string;
  counsellor_name: string;
  counsellor_title: string;
};

export function CounsellorAssignmentWorkspace({
  learners,
  counsellors,
  assignments,
}: {
  learners: Learner[];
  counsellors: Counsellor[];
  assignments: Assignment[];
}) {
  const [state, formAction, pending] = useActionState<
    CounsellorAssignmentActionState,
    FormData
  >(assignLearnerCounsellor, {});
  const activeAssignments = new Map(
    assignments
      .filter((assignment) => assignment.ended_at === null)
      .map((assignment) => [assignment.student_id, assignment]),
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">LEARNER SUPPORT CONTINUITY</p>
            <h2>Assign a counsellor</h2>
          </div>
          <Badge tone="blue">PHASE 2</Badge>
        </div>

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

        {!learners.length || !counsellors.length ? (
          <EmptyState title="Assignment prerequisites are incomplete">
            At least one learner and one staff member with the COUNSELLOR role
            are required.
          </EmptyState>
        ) : (
          <form action={formAction} className="support-form">
            <div className="field">
              <label htmlFor="assignment-student">Learner</label>
              <select id="assignment-student" name="studentId" required>
                <option value="">Select learner</option>
                {learners.map((learner) => {
                  const current = activeAssignments.get(learner.user_id);
                  return (
                    <option key={learner.user_id} value={learner.user_id}>
                      {learner.display_name} · {learner.student_number}
                      {current ? ` · currently ${current.counsellor_name}` : ""}
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="field">
              <label htmlFor="assignment-counsellor">Counsellor</label>
              <select id="assignment-counsellor" name="counsellorId" required>
                <option value="">Select counsellor</option>
                {counsellors.map((counsellor) => (
                  <option key={counsellor.user_id} value={counsellor.user_id}>
                    {counsellor.display_name} · {counsellor.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="assignment-reason">Assignment reason</label>
              <input
                id="assignment-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                placeholder="Learner support allocation reviewed"
                required
              />
            </div>

            <button className="button" disabled={pending}>
              {pending ? "Assigning…" : "Assign counsellor"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Counsellor assignment history</h2>
          <Badge tone="muted">AUDITED</Badge>
        </div>

        {assignments.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Counsellor</th>
                  <th>Started</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr key={assignment.id}>
                    <td>
                      <strong>{assignment.learner_name}</strong>
                      <div className="muted">{assignment.student_number}</div>
                    </td>
                    <td>
                      <strong>{assignment.counsellor_name}</strong>
                      <div className="muted">{assignment.counsellor_title}</div>
                    </td>
                    <td>{new Date(assignment.starts_at).toLocaleString()}</td>
                    <td>
                      <Badge
                        tone={assignment.ended_at === null ? "green" : "muted"}
                      >
                        {assignment.ended_at === null ? "ACTIVE" : "ENDED"}
                      </Badge>
                      {assignment.ended_at && (
                        <div className="muted">
                          Ended {new Date(assignment.ended_at).toLocaleString()}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No counsellor assignments recorded">
            Assignments and later reassignments will appear here as preserved
            institutional relationship history.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
