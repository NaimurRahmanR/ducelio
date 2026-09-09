"use client";

import { useActionState } from "react";
import {
  correctAttendanceRecord,
  correctEnrolmentRecord,
  type RegistrarActionState,
} from "@/app/admin/registrar-actions";
import { Badge, Card, EmptyState } from "./ui";

type Enrolment = {
  id: string;
  student_id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "WITHDRAWN";
  cohort_title_snapshot: string;
  cohort_starts_on_snapshot: string;
  student_profiles: {
    student_number: string;
    app_users: { display_name: string };
  };
};

type Attendance = {
  id: string;
  student_id: string;
  enrolment_id: string;
  session_id: string;
  status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
  updated_at: string;
  class_sessions: {
    scheduled_start: string;
    lessons: { title: string };
  };
};

type Correction = {
  id: string;
  student_id: string;
  correction_kind: "ENROLMENT_STATUS" | "ATTENDANCE_STATUS";
  enrolment_id: string | null;
  attendance_record_id: string | null;
  before_value: string;
  after_value: string;
  reason: string;
  corrected_by: string;
  corrected_at: string;
};

function EnrolmentCorrectionForm({ enrolment }: { enrolment: Enrolment }) {
  const [state, action, pending] = useActionState<RegistrarActionState, FormData>(
    correctEnrolmentRecord,
    {},
  );
  const options = ["ACTIVE", "PAUSED", "WITHDRAWN"].filter(
    (status) => status !== enrolment.status,
  );

  if (enrolment.status === "COMPLETED") {
    return (
      <p className="muted">
        Completed enrolments are locked from registrar correction in this checkpoint.
      </p>
    );
  }

  return (
    <form action={action} className="support-form">
      <input type="hidden" name="enrolmentId" value={enrolment.id} />
      <div className="field">
        <label htmlFor={`enrolment-status-${enrolment.id}`}>Correct status</label>
        <select id={`enrolment-status-${enrolment.id}`} name="status" required>
          {options.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`enrolment-reason-${enrolment.id}`}>Correction reason</label>
        <textarea
          id={`enrolment-reason-${enrolment.id}`}
          name="reason"
          rows={2}
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      {state.error && <p className="notice error">{state.error}</p>}
      {state.message && <p className="notice">{state.message}</p>}
      <button className="button" disabled={pending}>
        {pending ? "Recording…" : "Record correction"}
      </button>
    </form>
  );
}

function AttendanceCorrectionForm({ attendance }: { attendance: Attendance }) {
  const [state, action, pending] = useActionState<RegistrarActionState, FormData>(
    correctAttendanceRecord,
    {},
  );
  const options = ["PRESENT", "LATE", "ABSENT", "EXCUSED"].filter(
    (status) => status !== attendance.status,
  );

  return (
    <form action={action} className="support-form">
      <input type="hidden" name="attendanceRecordId" value={attendance.id} />
      <div className="field">
        <label htmlFor={`attendance-status-${attendance.id}`}>Correct status</label>
        <select id={`attendance-status-${attendance.id}`} name="status" required>
          {options.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`attendance-reason-${attendance.id}`}>Correction reason</label>
        <textarea
          id={`attendance-reason-${attendance.id}`}
          name="reason"
          rows={2}
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      {state.error && <p className="notice error">{state.error}</p>}
      {state.message && <p className="notice">{state.message}</p>}
      <button className="button" disabled={pending}>
        {pending ? "Recording…" : "Record correction"}
      </button>
    </form>
  );
}

export function RegistrarWorkspace({
  enrolments,
  attendance,
  corrections,
}: {
  enrolments: Enrolment[];
  attendance: Attendance[];
  corrections: Correction[];
}) {
  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <Badge tone="gold">OFFICIAL RECORDS</Badge>
            <h2>Registrar corrections</h2>
          </div>
        </div>
        <p>
          Correct existing official enrolment and attendance records with a bounded
          reason. This workspace does not grant curriculum, evidence, mastery,
          assessment or teaching authority.
        </p>
      </Card>

      <Card>
        <h2>Enrolment status corrections</h2>
        {enrolments.length ? (
          <div className="support-records">
            {enrolments.map((enrolment) => (
              <div className="support-record" key={enrolment.id}>
                <Badge tone="blue">{enrolment.status}</Badge>
                <h3>{enrolment.student_profiles.app_users.display_name}</h3>
                <p>
                  {enrolment.student_profiles.student_number} · {enrolment.cohort_title_snapshot}
                </p>
                <p className="muted">
                  Cohort started {enrolment.cohort_starts_on_snapshot}
                </p>
                <EnrolmentCorrectionForm enrolment={enrolment} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No enrolment records available">
            Existing official enrolments will appear here for authorised registrar review.
          </EmptyState>
        )}
      </Card>

      <Card>
        <h2>Attendance corrections</h2>
        {attendance.length ? (
          <div className="support-records">
            {attendance.map((record) => (
              <div className="support-record" key={record.id}>
                <Badge tone="blue">{record.status}</Badge>
                <h3>{record.class_sessions.lessons.title}</h3>
                <p>{new Date(record.class_sessions.scheduled_start).toLocaleString()}</p>
                <p className="muted">Last updated {new Date(record.updated_at).toLocaleString()}</p>
                <AttendanceCorrectionForm attendance={record} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No attendance records available">
            Existing official attendance records will appear here for authorised registrar review.
          </EmptyState>
        )}
      </Card>

      <Card>
        <h2>Immutable correction history</h2>
        {corrections.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Reason</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {corrections.map((correction) => (
                  <tr key={correction.id}>
                    <td>{correction.correction_kind}</td>
                    <td>{correction.before_value}</td>
                    <td>{correction.after_value}</td>
                    <td>{correction.reason}</td>
                    <td>{new Date(correction.corrected_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No registrar corrections recorded">
            Reviewed changes will appear here without rewriting correction history.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
