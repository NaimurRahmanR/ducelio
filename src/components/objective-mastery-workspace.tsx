import { Badge, Card, EmptyState } from "./ui";

type MasteryState =
  | "NOT_STARTED"
  | "DEVELOPING"
  | "DEMONSTRATED"
  | "NEEDS_REINFORCEMENT";

type Enrolment = {
  id: string;
  student_id: string;
  student_number: string;
  display_name: string;
};

type Mastery = {
  id: string;
  enrolment_id: string;
  student_id: string;
  objective_id: string;
  lesson_id: string;
  state: MasteryState;
  evidence_count: number;
  correct_evidence_count: number;
  correct_session_count: number;
  correct_kind_count: number;
  policy_version: string;
  evaluated_at: string;
  lesson_objectives: { description: string; position: number };
  lessons: { title: string };
};

type History = {
  id: string;
  mastery_id: string;
  from_state: MasteryState;
  to_state: MasteryState;
  trigger_evidence_id: string;
  evidence_count: number;
  correct_evidence_count: number;
  correct_session_count: number;
  correct_kind_count: number;
  policy_version: string;
  changed_at: string;
};

function tone(state: MasteryState): "green" | "gold" | "blue" | "muted" {
  if (state === "DEMONSTRATED") return "green";
  if (state === "NEEDS_REINFORCEMENT") return "gold";
  if (state === "DEVELOPING") return "blue";
  return "muted";
}

export function ObjectiveMasteryWorkspace({
  enrolments,
  mastery,
  history,
}: {
  enrolments: Enrolment[];
  mastery: Mastery[];
  history: History[];
}) {
  return (
    <div className="section-content">
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">DETERMINISTIC ACADEMIC STATE</p>
            <h2>Objective mastery</h2>
          </div>
          <Badge tone="blue">MASTERY_V1</Badge>
        </div>
        <p className="muted">
          A single correct observation does not establish mastery. Demonstrated
          requires correct evidence across at least two class sessions and at
          least two evidence kinds. Later partial or incorrect evidence moves a
          demonstrated objective to needs reinforcement.
        </p>
        {mastery.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Objective</th>
                  <th>State</th>
                  <th>Evidence</th>
                  <th>Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {mastery.map((record) => {
                  const enrolment = enrolments.find(
                    (row) => row.id === record.enrolment_id,
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
                        {record.lesson_objectives.description}
                        <div className="muted">{record.lessons.title}</div>
                      </td>
                      <td>
                        <Badge tone={tone(record.state)}>
                          {record.state.replaceAll("_", " ")}
                        </Badge>
                      </td>
                      <td>
                        {record.evidence_count} total ·{" "}
                        {record.correct_evidence_count} correct
                        <div className="muted">
                          {record.correct_session_count} correct sessions ·{" "}
                          {record.correct_kind_count} evidence kinds
                        </div>
                      </td>
                      <td>
                        {new Date(record.evaluated_at).toLocaleString()}
                        <div className="muted">{record.policy_version}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No mastery state derived yet">
            Mastery appears only after validated learning evidence has been
            processed by the deterministic policy.
          </EmptyState>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Mastery transition history</h2>
          <Badge tone="muted">APPEND ONLY</Badge>
        </div>
        {history.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Objective state</th>
                  <th>Evidence counts</th>
                  <th>Trigger evidence</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Badge tone={tone(record.from_state)}>
                        {record.from_state.replaceAll("_", " ")}
                      </Badge>{" "}
                      →{" "}
                      <Badge tone={tone(record.to_state)}>
                        {record.to_state.replaceAll("_", " ")}
                      </Badge>
                    </td>
                    <td>
                      {record.evidence_count} total ·{" "}
                      {record.correct_evidence_count} correct
                      <div className="muted">
                        {record.correct_session_count} sessions ·{" "}
                        {record.correct_kind_count} kinds
                      </div>
                    </td>
                    <td className="muted">{record.trigger_evidence_id}</td>
                    <td>
                      {new Date(record.changed_at).toLocaleString()}
                      <div className="muted">{record.policy_version}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No mastery transitions recorded">
            State changes will be retained here as immutable academic history.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
