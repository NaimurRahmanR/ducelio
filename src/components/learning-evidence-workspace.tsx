"use client";

import { useActionState } from "react";
import {
  saveLearningEvidence,
  type LearningEvidenceActionState,
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

type Objective = {
  id: string;
  lesson_id: string;
  programme_version_id: string;
  description: string;
  position: number;
  lessons: { title: string };
};

type Evidence = {
  id: string;
  enrolment_id: string;
  student_id: string;
  objective_id: string;
  lesson_id: string;
  session_id: string;
  evidence_kind:
    "CLASS_RESPONSE" | "RETRIEVAL_CHECK" | "PRACTICAL_TASK" | "DEBUGGING_TASK";
  result: "CORRECT" | "PARTIAL" | "INCORRECT";
  evidence_reference: string;
  idempotency_key: string;
  recorded_at: string;
};

export function LearningEvidenceWorkspace({
  sessions,
  enrolments,
  objectives,
  evidence,
}: {
  sessions: Session[];
  enrolments: Enrolment[];
  objectives: Objective[];
  evidence: Evidence[];
}) {
  const [state, formAction, pending] = useActionState<
    LearningEvidenceActionState,
    FormData
  >(saveLearningEvidence, {});
  const eligibleSessions = sessions.filter(
    (session) => session.status !== "CANCELLED",
  );

  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">VALIDATED LEARNING PROVENANCE</p>
            <h2>Record learning evidence</h2>
          </div>
          <Badge tone="blue">NOT MASTERY</Badge>
        </div>
        <p className="muted">
          Evidence records what was observed against a published objective. It
          does not itself change mastery. Duplicate source events must reuse the
          same idempotency key.
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
        {!eligibleSessions.length ||
        !enrolments.length ||
        !objectives.length ? (
          <EmptyState title="Evidence prerequisites are incomplete">
            A non-cancelled class session, matching learner enrolment and
            published learning objective are required.
          </EmptyState>
        ) : (
          <form action={formAction} className="support-form">
            <div className="field">
              <label htmlFor="evidence-session">Class session</label>
              <select id="evidence-session" name="sessionId" required>
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
              <label htmlFor="evidence-enrolment">Learner enrolment</label>
              <select id="evidence-enrolment" name="enrolmentId" required>
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
              <label htmlFor="evidence-objective">Learning objective</label>
              <select id="evidence-objective" name="objectiveId" required>
                <option value="">Select objective</option>
                {objectives.map((objective) => (
                  <option key={objective.id} value={objective.id}>
                    {objective.lessons.title} · {objective.position}.{" "}
                    {objective.description}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="evidence-kind">Evidence kind</label>
              <select id="evidence-kind" name="evidenceKind" required>
                <option value="CLASS_RESPONSE">CLASS RESPONSE</option>
                <option value="RETRIEVAL_CHECK">RETRIEVAL CHECK</option>
                <option value="PRACTICAL_TASK">PRACTICAL TASK</option>
                <option value="DEBUGGING_TASK">DEBUGGING TASK</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="evidence-result">Observed result</label>
              <select id="evidence-result" name="result" required>
                <option value="CORRECT">CORRECT</option>
                <option value="PARTIAL">PARTIAL</option>
                <option value="INCORRECT">INCORRECT</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="evidence-reference">Evidence reference</label>
              <input
                id="evidence-reference"
                name="evidenceReference"
                minLength={1}
                maxLength={300}
                placeholder="Opaque activity or response reference"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="evidence-idempotency">Idempotency key</label>
              <input
                id="evidence-idempotency"
                name="idempotencyKey"
                minLength={8}
                maxLength={200}
                placeholder="Stable source-event key"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="evidence-reason">Recording reason</label>
              <input
                id="evidence-reason"
                name="reason"
                minLength={5}
                maxLength={300}
                required
              />
            </div>
            <button className="button" disabled={pending}>
              {pending ? "Recording…" : "Record evidence"}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Learning evidence register</h2>
          <Badge tone="muted">APPEND ONLY</Badge>
        </div>
        {evidence.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Objective</th>
                  <th>Evidence</th>
                  <th>Result</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((record) => {
                  const enrolment = enrolments.find(
                    (row) => row.id === record.enrolment_id,
                  );
                  const objective = objectives.find(
                    (row) => row.id === record.objective_id,
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
                        {objective?.description ?? record.objective_id}
                        <div className="muted">
                          {objective?.lessons.title ?? "Lesson"}
                        </div>
                      </td>
                      <td>
                        {record.evidence_kind.replaceAll("_", " ")}
                        <div className="muted">{record.evidence_reference}</div>
                      </td>
                      <td>
                        <Badge
                          tone={
                            record.result === "CORRECT"
                              ? "green"
                              : record.result === "INCORRECT"
                                ? "gold"
                                : "muted"
                          }
                        >
                          {record.result}
                        </Badge>
                      </td>
                      <td>{new Date(record.recorded_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No learning evidence recorded">
            Validated observations will appear here. Evidence remains separate
            from later mastery transitions.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
