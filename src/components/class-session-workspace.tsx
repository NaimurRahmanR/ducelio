"use client";

import { useActionState } from "react";
import {
  addClassSession,
  updateClassSessionStatus,
  type ClassSessionActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Cohort = {
  id: string;
  title: string;
  starts_on: string;
  programme_version_id: string;
  programme_versions: {
    label: string;
    status: "DRAFT" | "PUBLISHED";
    title_snapshot: string | null;
  };
};
type Lesson = {
  id: string;
  programme_version_id: string;
  title: string;
  position: number;
  modules: { title: string; position: number };
};
type Instructor = { user_id: string; display_name: string; title: string };
type Session = {
  id: string;
  cohort_id: string;
  programme_version_id: string;
  lesson_id: string;
  instructor_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  cohort_title: string;
  lesson_title: string;
  instructor_name: string;
  instructor_title: string;
  programme_title: string;
  programme_version_label: string;
};

export function ClassSessionWorkspace({
  cohorts,
  lessons,
  instructors,
  sessions,
}: {
  cohorts: Cohort[];
  lessons: Lesson[];
  instructors: Instructor[];
  sessions: Session[];
}) {
  const [createState, createAction, createPending] = useActionState<
    ClassSessionActionState,
    FormData
  >(addClassSession, {});
  const [statusState, statusAction, statusPending] = useActionState<
    ClassSessionActionState,
    FormData
  >(updateClassSessionStatus, {});
  const publishedCohorts = cohorts.filter(
    (cohort) => cohort.programme_versions.status === "PUBLISHED",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">GOVERNED SCHEDULING</p>
            <h2>Schedule a class session</h2>
          </div>
          <Badge tone="blue">PHASE 2</Badge>
        </div>
        {createState.error && (
          <p className="notice error" role="alert">
            {createState.error}
          </p>
        )}
        {createState.message && (
          <p className="notice" role="status">
            {createState.message}
          </p>
        )}
        {!publishedCohorts.length || !lessons.length || !instructors.length ? (
          <EmptyState title="Scheduling prerequisites are incomplete">
            A published cohort, matching lesson and staff member with the
            INSTRUCTOR role are required.
          </EmptyState>
        ) : (
          <form action={createAction} className="support-form">
            <div className="field">
              <label htmlFor="session-cohort">Cohort</label>
              <select id="session-cohort" name="cohortId" required>
                <option value="">Select cohort</option>
                {publishedCohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.programme_versions.title_snapshot ?? "Programme"} ·{" "}
                    {cohort.programme_versions.label} · {cohort.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="session-lesson">Lesson</label>
              <select id="session-lesson" name="lessonId" required>
                <option value="">Select lesson</option>
                {lessons.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.modules.title} · {lesson.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="session-instructor">Instructor</label>
              <select id="session-instructor" name="instructorId" required>
                <option value="">Select instructor</option>
                {instructors.map((instructor) => (
                  <option key={instructor.user_id} value={instructor.user_id}>
                    {instructor.display_name} · {instructor.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="session-start">Start</label>
              <input
                id="session-start"
                name="scheduledStart"
                type="datetime-local"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="session-end">End</label>
              <input
                id="session-end"
                name="scheduledEnd"
                type="datetime-local"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="session-reason">Scheduling reason</label>
              <input
                id="session-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={createPending}>
              {createPending ? "Scheduling…" : "Schedule class"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Class session register</h2>
          <Badge tone="muted">AUDITED</Badge>
        </div>
        {statusState.error && (
          <p className="notice error" role="alert">
            {statusState.error}
          </p>
        )}
        {statusState.message && (
          <p className="notice" role="status">
            {statusState.message}
          </p>
        )}
        {sessions.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Instructor</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <strong>{session.lesson_title}</strong>
                      <div className="muted">
                        {session.programme_title} · {session.cohort_title}
                      </div>
                    </td>
                    <td>
                      {session.instructor_name}
                      <div className="muted">{session.instructor_title}</div>
                    </td>
                    <td>
                      {new Date(session.scheduled_start).toLocaleString()}
                      <div className="muted">
                        to {new Date(session.scheduled_end).toLocaleString()}
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          session.status === "SCHEDULED"
                            ? "green"
                            : session.status === "CANCELLED"
                              ? "gold"
                              : "muted"
                        }
                      >
                        {session.status}
                      </Badge>
                    </td>
                    <td>
                      {session.status === "SCHEDULED" ? (
                        <form action={statusAction} className="support-form">
                          <input
                            type="hidden"
                            name="sessionId"
                            value={session.id}
                          />
                          <select name="status" defaultValue="" required>
                            <option value="" disabled>
                              Select status
                            </option>
                            <option value="COMPLETED">COMPLETED</option>
                            <option value="CANCELLED">CANCELLED</option>
                          </select>
                          <input
                            name="reason"
                            minLength={5}
                            maxLength={300}
                            placeholder="Reason"
                            required
                          />
                          <button
                            className="button secondary"
                            disabled={statusPending}
                          >
                            {statusPending ? "Updating…" : "Update"}
                          </button>
                        </form>
                      ) : (
                        <span className="muted">Closed historical record</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No class sessions scheduled">
            Scheduled sessions will appear here with their cohort, lesson,
            instructor and lifecycle state.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
