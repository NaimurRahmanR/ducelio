"use client";

import { useActionState } from "react";
import {
  addEnrolment,
  updateEnrolmentStatus,
  type EnrolmentActionState,
} from "@/app/admin/actions";
import { Badge, Card, EmptyState } from "./ui";

type Learner = {
  user_id: string;
  student_number: string;
  display_name: string;
};
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
type Enrolment = {
  id: string;
  student_id: string;
  cohort_id: string;
  programme_version_id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "WITHDRAWN";
  enrolled_at: string;
  cohort_title_snapshot: string;
  cohort_starts_on_snapshot: string;
  display_name: string;
  programme_versions: {
    label: string;
    title_snapshot: string | null;
  };
};

export function EnrolmentWorkspace({
  learners,
  cohorts,
  enrolments,
}: {
  learners: Learner[];
  cohorts: Cohort[];
  enrolments: Enrolment[];
}) {
  const [createState, createAction, createPending] = useActionState<
    EnrolmentActionState,
    FormData
  >(addEnrolment, {});
  const [statusState, statusAction, statusPending] = useActionState<
    EnrolmentActionState,
    FormData
  >(updateEnrolmentStatus, {});
  const publishedCohorts = cohorts.filter(
    (cohort) => cohort.programme_versions.status === "PUBLISHED",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">GOVERNED ENROLMENT</p>
            <h2>Enrol a learner</h2>
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
        {!learners.length || !publishedCohorts.length ? (
          <EmptyState title="Enrolment prerequisites are incomplete">
            At least one learner and one cohort tied to a published programme
            version are required.
          </EmptyState>
        ) : (
          <form action={createAction} className="support-form">
            <div className="field">
              <label htmlFor="enrolment-student">Learner</label>
              <select id="enrolment-student" name="studentId" required>
                <option value="">Select learner</option>
                {learners.map((learner) => (
                  <option key={learner.user_id} value={learner.user_id}>
                    {learner.display_name} · {learner.student_number}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="enrolment-cohort">Cohort</label>
              <select id="enrolment-cohort" name="cohortId" required>
                <option value="">Select cohort</option>
                {publishedCohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.programme_versions.title_snapshot ??
                      "Published programme"}{" "}
                    · {cohort.programme_versions.label} · {cohort.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="enrolment-reason">Enrolment reason</label>
              <input
                id="enrolment-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                placeholder="Approved learner registration"
                required
              />
            </div>
            <button className="button" disabled={createPending}>
              {createPending ? "Enrolling…" : "Enrol learner"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Enrolment register</h2>
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
        {enrolments.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Programme</th>
                  <th>Cohort snapshot</th>
                  <th>Status</th>
                  <th>Governed change</th>
                </tr>
              </thead>
              <tbody>
                {enrolments.map((enrolment) => (
                  <tr key={enrolment.id}>
                    <td>
                      <strong>{enrolment.display_name}</strong>
                    </td>
                    <td>
                      {enrolment.programme_versions.title_snapshot ??
                        "Programme"}
                      <div className="muted">
                        {enrolment.programme_versions.label}
                      </div>
                    </td>
                    <td>
                      {enrolment.cohort_title_snapshot}
                      <div className="muted">
                        Starts {enrolment.cohort_starts_on_snapshot}
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          enrolment.status === "ACTIVE"
                            ? "green"
                            : enrolment.status === "WITHDRAWN"
                              ? "gold"
                              : "muted"
                        }
                      >
                        {enrolment.status}
                      </Badge>
                    </td>
                    <td>
                      {enrolment.status === "ACTIVE" ||
                      enrolment.status === "PAUSED" ? (
                        <form action={statusAction} className="support-form">
                          <input
                            type="hidden"
                            name="enrolmentId"
                            value={enrolment.id}
                          />
                          <label htmlFor={`status-${enrolment.id}`}>
                            New status
                          </label>
                          <select
                            id={`status-${enrolment.id}`}
                            name="status"
                            defaultValue=""
                            required
                          >
                            <option value="" disabled>
                              Select status
                            </option>
                            {enrolment.status === "ACTIVE" && (
                              <option value="PAUSED">PAUSED</option>
                            )}
                            {enrolment.status === "PAUSED" && (
                              <option value="ACTIVE">ACTIVE</option>
                            )}
                            <option value="WITHDRAWN">WITHDRAWN</option>
                          </select>
                          <label htmlFor={`status-reason-${enrolment.id}`}>
                            Reason
                          </label>
                          <input
                            id={`status-reason-${enrolment.id}`}
                            name="reason"
                            minLength={5}
                            maxLength={300}
                            required
                          />
                          <button
                            className="button secondary"
                            disabled={statusPending}
                          >
                            {statusPending ? "Updating…" : "Update status"}
                          </button>
                        </form>
                      ) : (
                        <span className="muted">
                          Historical record is closed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No enrolments recorded">
            Authorised enrolments will appear here with their preserved
            curriculum and cohort history.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
