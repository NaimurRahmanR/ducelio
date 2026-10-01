import { Card, Badge, EmptyState } from "./ui";
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
            <Badge tone="gold">ACADEMY OS · PHASE 2</Badge>
            <h2 className="detail-title">Built on institutional truth.</h2>
            <p>
              Programme publication, enrolment, learner support relationships
              and class scheduling grow through governed, auditable services.
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
                <h3>Auditable operations</h3>
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
            <Badge tone="muted">REGISTER</Badge>
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
              Create programme records only through approved institutional
              processes.
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
            Support-note prose and large protected/learning-content bodies are
            excluded from the relevant audit payloads.
          </p>
        </Card>
      )}
    </div>
  );
}
