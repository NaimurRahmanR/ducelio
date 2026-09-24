import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listPracticalEnrolments } from "@/server/course-activation";
import {
  getCommercialV1CourseProgress,
  listCommercialV1ObjectiveDiagnostics,
} from "@/server/commercial-v1-results-completion";
import { AcademyShell } from "@/components/academy-shell";
import { Card, Badge } from "@/components/ui";
import { CourseCompletionForm } from "@/components/course-completion-form";

// Deliberately minimal: this page composes the existing bounded
// progress/diagnostics reads and the completion action so a real learner can
// reach course completion without manual database access. It is not final
// visual polish -- that remains a later checkpoint.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const enrolments = await listPracticalEnrolments();
  const selected = enrolments.find(
    (e) => e.id === (params.enrolmentId ?? enrolments[0]?.id),
  );
  const progress = selected
    ? await getCommercialV1CourseProgress(selected.id).catch(() => null)
    : null;
  const diagnostics =
    selected && progress?.ok
      ? await listCommercialV1ObjectiveDiagnostics({
          enrolmentId: selected.id,
          limit: 50,
          offset: 0,
        }).catch(() => null)
      : null;

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <h1>Course progress</h1>
      </div>
      <div className="section-content">
        <Card>
          <form method="get">
            <label>
              Course
              <select name="enrolmentId" defaultValue={selected?.id} required>
                {enrolments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary" disabled={!enrolments.length}>
              View progress
            </button>
          </form>
        </Card>
        {!progress || !progress.ok ? (
          <Card>
            <p role="alert">
              Course progress is not currently available for this course.
            </p>
          </Card>
        ) : (
          <>
            <Card>
              <h2>Formal components</h2>
              {Object.entries(progress.components).map(
                ([component, status]) => (
                  <p key={component}>
                    <Badge
                      tone={status.status === "FINALIZED" ? "green" : "muted"}
                    >
                      {component}
                    </Badge>{" "}
                    {status.status === "FINALIZED"
                      ? `${(status.scoreBp / 100).toFixed(1)}% (weighted ${(status.weightedContributionBp / 100).toFixed(1)}%)`
                      : "Pending"}
                  </p>
                ),
              )}
              {Object.entries(progress.labs).map(([practicalId, status]) => (
                <p key={practicalId}>
                  <Badge
                    tone={status.status === "FINALIZED" ? "green" : "muted"}
                  >
                    Lab
                  </Badge>{" "}
                  {status.status === "FINALIZED"
                    ? `weighted ${(status.weightedContributionBp / 100).toFixed(1)}%`
                    : "Pending"}
                </p>
              ))}
              <p className="muted">
                Course score:{" "}
                {progress.courseScoreBp === null
                  ? "not yet available"
                  : (progress.courseScoreBp / 100).toFixed(1) + "%"}
                {progress.passMarkBp !== null &&
                  ` · pass mark ${(progress.passMarkBp / 100).toFixed(1)}%`}
              </p>
              {progress.openRemediationCount > 0 && (
                <p role="alert">
                  {progress.openRemediationCount} open remediation item
                  {progress.openRemediationCount === 1 ? "" : "s"}.
                </p>
              )}
            </Card>
            {diagnostics && diagnostics.ok && diagnostics.items.length > 0 && (
              <Card>
                <h2>Objective diagnostics</h2>
                {diagnostics.items.map((item) => (
                  <p key={item.objectiveId + item.sourceKind}>
                    <Badge
                      tone={
                        item.outcome === "CORRECT"
                          ? "green"
                          : item.outcome === "PARTIAL"
                            ? "gold"
                            : "muted"
                      }
                    >
                      {item.outcome}
                    </Badge>{" "}
                    {item.sourceKind}
                    {item.remediationOpen ? " · remediation open" : ""}
                  </p>
                ))}
              </Card>
            )}
            <Card>
              <h2>Completion</h2>
              {progress.completed ? (
                <p>This course is completed.</p>
              ) : (
                <CourseCompletionForm enrolmentId={selected!.id} />
              )}
            </Card>
          </>
        )}
      </div>
    </AcademyShell>
  );
}
