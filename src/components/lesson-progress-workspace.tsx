"use client";

import { useActionState } from "react";
import {
  saveLessonProgress,
  type LessonProgressActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Session = {
  id: string;
  cohort_id: string;
  lesson_id: string;
  programme_version_id: string;
  scheduled_start: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  lessons: { title: string };
  cohorts: { title: string };
};

type Enrolment = {
  id: string;
  student_id: string;
  cohort_id: string;
  programme_version_id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "WITHDRAWN";
  student_number: string;
  display_name: string;
};

type Segment = {
  id: string;
  lesson_id: string;
  programme_version_id: string;
  title: string;
  position: number;
  lessons: { title: string };
};

type Progress = {
  id: string;
  enrolment_id: string;
  student_id: string;
  segment_id: string;
  lesson_id: string;
  last_session_id: string;
  status: "IN_PROGRESS" | "COMPLETED";
  updated_at: string;
};

export function LessonProgressWorkspace({
  sessions,
  enrolments,
  segments,
  progress,
}: {
  sessions: Session[];
  enrolments: Enrolment[];
  segments: Segment[];
  progress: Progress[];
}) {
  const [state, formAction, pending] = useActionState<
    LessonProgressActionState,
    FormData
  >(saveLessonProgress, {});
  const eligibleSessions = sessions.filter(
    (session) => session.status !== "CANCELLED",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">LESSON PROGRESS</p>
            <h2>Record planned-segment progress</h2>
          </div>
          <Badge tone="blue">PHASE 2</Badge>
        </div>
        <p className="muted">
          Progress records which planned lesson segments were reached. It is not
          evidence of objective mastery and is never inferred from scrolling,
          elapsed time or opening a page.
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
        {!eligibleSessions.length || !enrolments.length || !segments.length ? (
          <EmptyState title="Progress prerequisites are incomplete">
            A non-cancelled class session, matching learner enrolment and planned
            segment are required.
          </EmptyState>
        ) : (
          <form action={formAction} className="support-form">
            <div className="field">
              <label htmlFor="progress-session">Class session</label>
              <select id="progress-session" name="sessionId" required>
                <option value="">Select session</option>
                {eligibleSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.lessons.title} · {session.cohorts.title} ·{" "}
                    {new Date(session.scheduled_start).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="progress-enrolment">Learner enrolment</label>
              <select id="progress-enrolment" name="enrolmentId" required>
                <option value="">Select learner</option>
                {enrolments.map((enrolment) => (
                  <option key={enrolment.id} value={enrolment.id}>
                    {enrolment.display_name} · {enrolment.student_number} ·{" "}
                    {enrolment.status}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="progress-segment">Planned segment</label>
              <select id="progress-segment" name="segmentId" required>
                <option value="">Select segment</option>
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.lessons.title} · {segment.position}. {segment.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="progress-status">Progress state</label>
              <select id="progress-status" name="status" required>
                <option value="">Select state</option>
                <option value="IN_PROGRESS">IN PROGRESS</option>
                <option value="COMPLETED">COMPLETED</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="progress-reason">Recording or correction reason</label>
              <input
                id="progress-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={pending}>
              {pending ? "Saving…" : "Save lesson progress"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Lesson progress register</h2>
          <Badge tone="muted">NOT MASTERY</Badge>
        </div>
        {progress.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Segment</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {progress.map((record) => {
                  const enrolment = enrolments.find(
                    (row) => row.id === record.enrolment_id,
                  );
                  const segment = segments.find(
                    (row) => row.id === record.segment_id,
                  );
                  return (
                    <tr key={record.id}>
                      <td>
                        <strong>{enrolment?.display_name ?? "Learner"}</strong>
                        <div className="muted">
                          {enrolment?.student_number ?? record.student_id}
                        </div>
                      </td>
                      <td>
                        {segment?.title ?? "Planned segment"}
                        <div className="muted">
                          {segment?.lessons.title ?? record.lesson_id}
                        </div>
                      </td>
                      <td>
                        <Badge
                          tone={record.status === "COMPLETED" ? "green" : "muted"}
                        >
                          {record.status.replace("_", " ")}
                        </Badge>
                      </td>
                      <td>{new Date(record.updated_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No lesson progress recorded">
            Progress appears only after authorised staff record a learner’s
            position within planned lesson segments.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
