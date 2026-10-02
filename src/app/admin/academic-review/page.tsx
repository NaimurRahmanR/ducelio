import Link from "next/link";
import { getAcademicReviewWorkspace } from "@/server/commercial-v1-academic-review";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import {
  AssessmentReviewForm,
  LabReviewForm,
} from "@/components/academic-review-forms";
import {
  academicReviewCaseKindLabels,
  academicReviewRefusalMessage,
} from "@/domain/commercial-v1-academic-review";

export const dynamic = "force-dynamic";

// Human academic review: the institutional path for result-free targets the
// automated grading chain deliberately cannot grade (initial escalations,
// escalated recoveries and exhausted recoveries). Minimal operational
// surface; final visual polish is a later checkpoint.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ case?: string }>;
}) {
  const { case: caseId } = await searchParams;
  const { actor, cases, selected, selectedError } =
    await getAcademicReviewWorkspace(caseId);
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Academic review"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACADEMIC REVIEW</p>
            <h2>Results awaiting human academic review</h2>
          </div>
          <Badge tone="muted">GOVERNED · AUDITED</Badge>
        </div>
        <p>
          These submissions have no result and cannot be graded automatically:
          Examiner grading escalated them to human review, or their one
          automated recovery attempt escalated or was used up. Recording a first
          grade creates the learner&apos;s first result, which then counts
          towards progress and completion like any other result and can later be
          regraded through the normal regrade process.
        </p>
        {cases.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Work</th>
                  <th>Learner</th>
                  <th>Course · cohort</th>
                  <th>Since (UTC)</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.caseId}>
                    <td>
                      <Badge
                        tone={
                          c.caseKind === "INITIAL_ESCALATION" ? "gold" : "muted"
                        }
                      >
                        {academicReviewCaseKindLabels[c.caseKind]}
                      </Badge>
                    </td>
                    <td>
                      {c.targetKind === "ASSESSMENT_ATTEMPT"
                        ? `Assessment · ${c.component}`
                        : "Practical lab"}
                      <div className="muted">{c.targetTitle}</div>
                    </td>
                    <td>
                      {c.learnerName ?? "Learner"}
                      <div className="muted">{c.studentNumber}</div>
                    </td>
                    <td>
                      {c.programmeTitle}
                      <div className="muted">{c.cohortTitle}</div>
                    </td>
                    <td>{c.caseOpenedAt}</td>
                    <td>
                      <Link
                        className="text-link"
                        href={`/admin/academic-review?case=${c.caseId}`}
                        aria-current={c.caseId === caseId ? "true" : undefined}
                      >
                        Open review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Nothing awaiting academic review">
            Escalated and exhausted grading cases appear here until a first
            grade is recorded.
          </EmptyState>
        )}
      </Card>

      {caseId && selectedError && (
        <Card>
          <p className="notice error" role="alert">
            {academicReviewRefusalMessage(selectedError)}
          </p>
        </Card>
      )}

      {selected && (
        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {academicReviewCaseKindLabels[selected.caseKind]}
              </p>
              <h2>{selected.targetTitle ?? "Review case"}</h2>
            </div>
            <Badge tone="muted">{selected.caseReasonCode}</Badge>
          </div>
          <p className="muted">
            {selected.learnerName ?? "Learner"} · {selected.studentNumber} ·{" "}
            {selected.programmeTitle} · {selected.cohortTitle}
          </p>
          {selected.targetKind === "ASSESSMENT_ATTEMPT" ? (
            <>
              <p>
                {selected.component} · {selected.assessment.maxMarksTotal} marks
                in total
                {selected.assessment.componentWeightBp !== null
                  ? ` · weight ${selected.assessment.componentWeightBp / 100}%`
                  : ""}
              </p>
              {selected.assessment.instructions && (
                <p className="muted">{selected.assessment.instructions}</p>
              )}
              <AssessmentReviewForm
                key={selected.caseId}
                caseId={selected.caseId}
                questions={selected.assessment.questions}
              />
            </>
          ) : (
            <>
              {selected.lab.instructions && (
                <p className="muted">{selected.lab.instructions}</p>
              )}
              <p className="muted">Learner submission:</p>
              <p>{selected.lab.submissionBody ?? "No submission body."}</p>
              {selected.lab.gradingGuidance && (
                <>
                  <p className="muted">Grading guidance:</p>
                  <p>{selected.lab.gradingGuidance}</p>
                </>
              )}
              {selected.lab.objectives.length > 0 && (
                <ul>
                  {selected.lab.objectives.map((o, i) => (
                    <li key={i}>{o.description}</li>
                  ))}
                </ul>
              )}
              {selected.lab.maxMarks === null ? (
                <p className="notice error" role="alert">
                  This lab has no published lab policy, so it cannot be graded
                  yet.
                </p>
              ) : (
                <>
                  <p>
                    Out of {selected.lab.maxMarks}
                    {selected.lab.contributionBp !== null
                      ? ` · contributes ${selected.lab.contributionBp / 100}%`
                      : ""}
                  </p>
                  <LabReviewForm
                    key={selected.caseId}
                    caseId={selected.caseId}
                    maxMarks={selected.lab.maxMarks}
                  />
                </>
              )}
            </>
          )}
        </Card>
      )}
    </StaffShell>
  );
}
