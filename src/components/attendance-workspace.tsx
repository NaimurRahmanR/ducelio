"use client";

import { useActionState } from "react";
import {
  saveAttendance,
  type AttendanceActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Session = {
  id: string;
  cohort_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  lessons: { title: string };
  cohorts: { title: string };
};

type Enrolment = {
  id: string;
  student_id: string;
  cohort_id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "WITHDRAWN";
  student_number: string;
  display_name: string;
};

type Attendance = {
  id: string;
  session_id: string;
  enrolment_id: string;
  student_id: string;
  status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
  updated_at: string;
};

export function AttendanceWorkspace({
  sessions,
  enrolments,
  attendance,
}: {
  sessions: Session[];
  enrolments: Enrolment[];
  attendance: Attendance[];
}) {
  const [state, formAction, pending] = useActionState<
    AttendanceActionState,
    FormData
  >(saveAttendance, {});
  const eligibleSessions = sessions.filter(
    (session) => session.status !== "CANCELLED",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">AUTHORITATIVE ATTENDANCE</p>
            <h2>Record attendance</h2>
          </div>
          <Badge tone="blue">PHASE 2</Badge>
        </div>
        <p className="muted">
          Attendance is an institutional record. Ducelio does not infer absence
          merely because a learner did not open a page or join a client view.
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
        {!eligibleSessions.length || !enrolments.length ? (
          <EmptyState title="Attendance prerequisites are incomplete">
            At least one non-cancelled class session and an enrolment in its
            cohort are required.
          </EmptyState>
        ) : (
          <form action={formAction} className="support-form">
            <div className="field">
              <label htmlFor="attendance-session">Class session</label>
              <select id="attendance-session" name="sessionId" required>
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
              <label htmlFor="attendance-enrolment">Learner enrolment</label>
              <select id="attendance-enrolment" name="enrolmentId" required>
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
              <label htmlFor="attendance-status">Attendance status</label>
              <select id="attendance-status" name="status" required>
                <option value="">Select status</option>
                <option value="PRESENT">PRESENT</option>
                <option value="LATE">LATE</option>
                <option value="ABSENT">ABSENT</option>
                <option value="EXCUSED">EXCUSED</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="attendance-reason">
                Recording or correction reason
              </label>
              <input
                id="attendance-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={pending}>
              {pending ? "Saving…" : "Save attendance"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Attendance register</h2>
          <Badge tone="muted">AUDITED CORRECTIONS</Badge>
        </div>
        {attendance.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Class</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {attendance.map((record) => {
                  const enrolment = enrolments.find(
                    (row) => row.id === record.enrolment_id,
                  );
                  const session = sessions.find(
                    (row) => row.id === record.session_id,
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
                        {session?.lessons.title ?? "Class session"}
                        <div className="muted">
                          {session
                            ? `${session.cohorts.title} · ${new Date(session.scheduled_start).toLocaleString()}`
                            : record.session_id}
                        </div>
                      </td>
                      <td>
                        <Badge
                          tone={
                            record.status === "PRESENT"
                              ? "green"
                              : record.status === "ABSENT"
                                ? "gold"
                                : "muted"
                          }
                        >
                          {record.status}
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
          <EmptyState title="No attendance recorded">
            Attendance appears only after an authorised staff member records it
            for a class session.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
