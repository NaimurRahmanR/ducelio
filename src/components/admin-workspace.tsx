import { Card, Badge, EmptyState, ButtonLink } from "./ui";
type Programme = {
  id: string;
  title: string;
  examination_body: string;
  is_demo: boolean;
};
type Audit = {
  id: string;
  action: string;
  target_type: string;
  occurred_at: string;
  source: string;
};
export function AdminWorkspace({
  section,
  counts,
  programmes,
  audit,
  canAudit,
  demo = false,
}: {
  section: string;
  counts: number[];
  programmes: Programme[];
  audit: Audit[];
  canAudit: boolean;
  demo?: boolean;
}) {
  const descriptions: Record<string, string> = {
    Students:
      "Learner registry and enrolment workflows will be added through authorised institutional services.",
    Cohorts:
      "Cohort operations will preserve each learner’s enrolled curriculum version.",
    Counsellors:
      "Counsellor assignment services are implemented. The institutional assignment editor is a later workflow.",
    Sessions:
      "Class scheduling and attendance operations are planned for a later milestone.",
    Assignments:
      "Assignment authoring, submission and grading are not yet enabled.",
    Assessments:
      "Controlled assessment delivery will be added with technical assessment firewalls.",
    Announcements:
      "Institutional announcement publishing is a later milestone.",
    Registry:
      "Official-record corrections, extensions and enrolment changes require reviewed, auditable workflows.",
  };
  return (
    <div className="section-content">
      {section === "Overview" && (
        <>
          <div className="stat-grid">
            {["Programmes", "Students", "Cohorts", "Staff profiles"].map(
              (label, i) => (
                <Card key={label}>
                  <span className="eyebrow">{label}</span>
                  <strong className="stat-number">{counts[i]}</strong>
                  <span className="muted">
                    {demo ? "Fictional demo records" : "Registered records"}
                  </span>
                </Card>
              ),
            )}
          </div>
          <Card className="admin-principle">
            <Badge tone="gold">ACADEMY OS · PHASE 1</Badge>
            <h2 className="detail-title">Built on institutional truth.</h2>
            <p>
              Identity, programme versions, learner relationships and
              permissions form the foundation. Academic operations will grow
              through controlled services.
            </p>
            <div className="admin-boundaries">
              <div>
                <h3>Versioned programmes</h3>
                <p>Enrolments remain tied to their curriculum version.</p>
              </div>
              <div>
                <h3>Support with boundaries</h3>
                <p>
                  Private support records stay within the assigned relationship.
                </p>
              </div>
              <div>
                <h3>Auditable changes</h3>
                <p>Institutional writes carry provenance and an audit trail.</p>
              </div>
            </div>
          </Card>
        </>
      )}
      {(section === "Overview" || section === "Programmes") && (
        <Card>
          <div className="section-heading">
            <h2>Programme registry</h2>
            <Badge tone="muted">READ-ONLY</Badge>
          </div>
          {programmes.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Programme</th>
                    <th>Examination body</th>
                    <th>Content</th>
                  </tr>
                </thead>
                <tbody>
                  {programmes.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.title}</strong>
                      </td>
                      <td>{p.examination_body}</td>
                      <td>
                        <Badge tone={p.is_demo ? "gold" : "blue"}>
                          {p.is_demo ? "Demo" : "Institutional"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No programmes registered">
              The programme publishing workflow is a later milestone. Add
              records only through approved institutional processes.
            </EmptyState>
          )}
        </Card>
      )}
      {section === "Audit" && (
        <Card>
          <h2>Institutional audit</h2>
          {!canAudit ? (
            <EmptyState title="Audit access is restricted">
              The platform administrator role is required to view institutional
              audit events.
            </EmptyState>
          ) : audit.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Record</th>
                    <th>Source</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td>{a.action}</td>
                      <td>{a.target_type}</td>
                      <td>{a.source}</td>
                      <td>{a.occurred_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title={demo ? "Audit preview" : "No audit events available"}
            >
              {demo
                ? "No real audit records are exposed in this preview."
                : "Audited changes will appear here as institutional records are created."}
            </EmptyState>
          )}
          <p className="muted">
            Support-note prose is excluded from audit payloads.
          </p>
        </Card>
      )}
      {descriptions[section] && (
        <Card>
          <EmptyState title={section + " workspace"}>
            {descriptions[section]}
          </EmptyState>
          {section === "Counsellors" && demo && (
            <ButtonLink href="/demo/counsellor" secondary>
              Explore the counsellor workspace
            </ButtonLink>
          )}
        </Card>
      )}
    </div>
  );
}
