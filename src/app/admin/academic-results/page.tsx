import Link from "next/link";
import {
  getAcademicResultsWorkspace,
  parseAcademicResultFilters,
} from "@/server/commercial-v1-academic-results";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import {
  CompleteEnrolmentForm,
  RegradeResultForm,
} from "@/components/academic-results-forms";
import {
  academicResultComponents,
  academicResultOriginLabels,
  academicResultsRefusalMessage,
  completionOutcomeMessages,
  formatBp,
  type AcademicResultDetail,
  type AcademicResultFilters,
  type AcademicResultSummary,
} from "@/domain/commercial-v1-academic-results";

export const dynamic = "force-dynamic";

// Academic results operations: bounded discovery of assessment and lab
// result revisions, their provenance and revision history, the learner's
// canonical progress and completion state. Corrections go only through the
// existing institutional regrade; results are never edited or voided here.
type Params = Record<string, string | string[] | undefined>;

function href(
  filters: AcademicResultFilters,
  overrides: Partial<AcademicResultFilters>,
) {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  const query = params.toString();
  return `/admin/academic-results${query ? `?${query}` : ""}`;
}

function workLabel(
  r: Pick<AcademicResultSummary, "kind" | "component" | "targetTitle">,
) {
  return r.kind === "ASSESSMENT"
    ? `Assessment · ${r.component ?? ""}`
    : `Practical lab · ${r.targetTitle ?? ""}`;
}

function RevisionBadges({
  isCurrent,
  isValid,
}: {
  isCurrent: boolean;
  isValid: boolean;
}) {
  return (
    <>
      <Badge tone={isCurrent ? "green" : "muted"}>
        {isCurrent ? "CURRENT" : "HISTORICAL"}
      </Badge>
      {!isValid && <Badge tone="gold">FAILS INTEGRITY CHECK</Badge>}
    </>
  );
}

function Provenance({ detail }: { detail: AcademicResultDetail }) {
  const p = detail.provenance;
  return (
    <dl className="detail-list">
      <dt>Origin</dt>
      <dd>{academicResultOriginLabels[p.origin]}</dd>
      {p.origin === "HUMAN_ACADEMIC_REVIEW" && (
        <>
          <dt>Reviewed by</dt>
          <dd>{p.actorName ?? "Unknown reviewer"}</dd>
          <dt>Review case</dt>
          <dd>{p.caseKind}</dd>
          <dt>Reason</dt>
          <dd>{p.reason}</dd>
          <dt>Decided (UTC)</dt>
          <dd>{p.decidedAt}</dd>
        </>
      )}
      {p.origin === "EXAMINER_REGRADE" && (
        <>
          <dt>Requested by</dt>
          <dd>{p.actorName ?? "Unknown administrator"}</dd>
          <dt>Regraded from</dt>
          <dd>
            <Link
              className="text-link"
              href={`/admin/academic-results?result=${p.sourceResultRevisionId}`}
            >
              Revision {p.sourceRevisionNumber}
            </Link>
          </dd>
          <dt>Reason</dt>
          <dd>{p.reason}</dd>
          <dt>Completed (UTC)</dt>
          <dd>{p.decidedAt ?? "—"}</dd>
        </>
      )}
      {p.origin === "EXAMINER_RECOVERY" && (
        <>
          <dt>Recovery requested by</dt>
          <dd>{p.actorName ?? "Unknown administrator"}</dd>
          <dt>Reason</dt>
          <dd>{p.reason}</dd>
          <dt>Completed (UTC)</dt>
          <dd>{p.decidedAt ?? "—"}</dd>
        </>
      )}
      {p.origin === "EXAMINER_INITIAL" && (
        <>
          <dt>Completed (UTC)</dt>
          <dd>{p.decidedAt ?? "—"}</dd>
        </>
      )}
    </dl>
  );
}

// The existing outgoing regrade claim for this revision (migration 032 allows
// exactly one per source revision). Truthful durable state only: there is no
// retry or human regrade-resolution authority.
function RegradeClaim({
  claim,
}: {
  claim: NonNullable<AcademicResultDetail["regradeClaim"]>;
}) {
  const active = claim.state === "AUTHORIZED" || claim.state === "RUNNING";
  return (
    <>
      <h4>Regrade claim for this revision</h4>
      <dl className="detail-list">
        <dt>State</dt>
        <dd>
          {claim.state}
          {claim.reasonCode ? ` · ${claim.reasonCode}` : ""}
        </dd>
        <dt>Requested by</dt>
        <dd>{claim.actorName ?? "Unknown administrator"}</dd>
        <dt>Request reason</dt>
        <dd>{claim.requestReason}</dd>
        <dt>Requested (UTC)</dt>
        <dd>{claim.createdAt}</dd>
        <dt>Ended (UTC)</dt>
        <dd>{claim.terminalAt ?? "—"}</dd>
      </dl>
      {active && !claim.expired && (
        <p className="notice" role="status">
          A regrade of this revision is already in progress. Another regrade
          cannot be requested for this revision.
        </p>
      )}
      {active && claim.expired && (
        <p className="notice" role="status">
          This regrade claim passed its execution window without finishing. The
          regrade authority records it as TIMEOUT on its next check. It still
          uses this revision&apos;s one regrade claim, so another regrade cannot
          be requested for this revision.
        </p>
      )}
      {claim.state === "SUCCEEDED" && claim.producedResultRevisionId && (
        <p>
          This regrade produced a new revision.{" "}
          <Link
            className="text-link"
            href={`/admin/academic-results?result=${claim.producedResultRevisionId}`}
          >
            Open the revision this regrade produced
          </Link>
        </p>
      )}
      {claim.state === "ESCALATED" && (
        <p className="notice" role="status">
          The regrade was escalated for human judgment and produced no new
          revision. No authority currently resolves an escalated regrade
          (academic review covers ungraded first grades only), and the current
          one-claim policy does not permit another regrade claim for this
          revision. The recorded result is unchanged.
        </p>
      )}
      {(claim.state === "FAILED" ||
        claim.state === "BUDGET_BLOCKED" ||
        claim.state === "TIMEOUT" ||
        claim.state === "CANCELLED") && (
        <p className="notice" role="status">
          The regrade ended without producing a new revision. The current
          one-claim policy does not permit another regrade claim for this
          revision. The recorded result is unchanged.
        </p>
      )}
    </>
  );
}

function ResultDetail({ detail }: { detail: AcademicResultDetail }) {
  const current = detail.history.find((h) => h.isCurrent);
  const regradeable =
    detail.isCurrent &&
    detail.isValid &&
    detail.enrolmentStatus === "ACTIVE" &&
    detail.regradeClaim === null;
  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{workLabel(detail)}</p>
          <h2>
            {detail.targetTitle ?? "Result"} · revision {detail.revisionNumber}
          </h2>
        </div>
        <div>
          <RevisionBadges
            isCurrent={detail.isCurrent}
            isValid={detail.isValid}
          />
        </div>
      </div>
      <p className="muted">
        {detail.learnerName ?? "Learner"} · {detail.studentNumber} ·{" "}
        {detail.programmeTitle} {detail.versionLabel} · {detail.cohortTitle} ·
        enrolment {detail.enrolmentStatus}
      </p>
      <dl className="detail-list">
        <dt>Marks</dt>
        <dd>
          {detail.earnedMarks} / {detail.maxMarks}
        </dd>
        {detail.kind === "ASSESSMENT" && (
          <>
            <dt>Score</dt>
            <dd>{formatBp(detail.scoreBp)}</dd>
          </>
        )}
        <dt>
          {detail.kind === "ASSESSMENT"
            ? "Component weight"
            : "Lab contribution"}
        </dt>
        <dd>{formatBp(detail.weightBp)}</dd>
        <dt>Weighted contribution</dt>
        <dd>{formatBp(detail.weightedContributionBp)}</dd>
        <dt>Finalized (UTC)</dt>
        <dd>{detail.finalizedAt}</dd>
        {detail.kind === "ASSESSMENT" ? (
          <>
            <dt>Attempt submitted (UTC)</dt>
            <dd>{detail.attemptSubmittedAt ?? "—"}</dd>
          </>
        ) : (
          <>
            <dt>Lab submitted (UTC)</dt>
            <dd>{detail.submissionSubmittedAt ?? "—"}</dd>
          </>
        )}
      </dl>
      {!detail.isValid && (
        <p className="notice error" role="alert">
          This revision fails the institutional result integrity checks. While
          it is the highest revision, the target counts as pending: progress
          never falls back to an earlier revision.
        </p>
      )}

      <h3>Provenance</h3>
      <Provenance detail={detail} />

      {detail.kind === "ASSESSMENT" && detail.questionMarks.length > 0 && (
        <>
          <h3>Per-question marks</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Awarded</th>
                  <th>Maximum</th>
                </tr>
              </thead>
              <tbody>
                {detail.questionMarks.map((m) => (
                  <tr key={m.questionId}>
                    <td>Question {m.position}</td>
                    <td>{m.marksAwarded}</td>
                    <td>{m.maxMarks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Objective outcomes</h3>
      {detail.objectiveOutcomes.length ? (
        <ul>
          {detail.objectiveOutcomes.map((o) => (
            <li key={o.objectiveId}>
              {o.description} — {o.outcome} ({o.earnedMarks}/{o.maxMarks})
              {o.remediationOpen && " · remediation open"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No objective outcomes are recorded for this revision.
        </p>
      )}

      <h3>Revision history</h3>
      {detail.historyHasMore && (
        <p className="notice" role="status">
          Showing the newest {detail.historyLimit} revisions of this work. Older
          revisions remain on the record: list them with &ldquo;Include
          historical (superseded) revisions&rdquo; in the results filter.
        </p>
      )}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Revision</th>
              <th>State</th>
              <th>Origin</th>
              <th>Marks</th>
              <th>Contribution</th>
              <th>Finalized (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {detail.history.map((h) => (
              <tr key={h.resultId}>
                <td>
                  {h.resultId === detail.resultId ? (
                    <strong aria-current="true">
                      Revision {h.revisionNumber}
                    </strong>
                  ) : (
                    <Link
                      className="text-link"
                      href={`/admin/academic-results?result=${h.resultId}`}
                    >
                      Revision {h.revisionNumber}
                    </Link>
                  )}
                </td>
                <td>
                  <RevisionBadges isCurrent={h.isCurrent} isValid={h.isValid} />
                </td>
                <td>{academicResultOriginLabels[h.origin]}</td>
                <td>
                  {h.earnedMarks} / {h.maxMarks}
                </td>
                <td>{formatBp(h.weightedContributionBp)}</td>
                <td>{h.finalizedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Correction</h3>
      <p className="muted">
        Results are append-only: a revision is never edited, deleted or voided.
        A disputed grade is corrected by an institutional regrade, which adds
        the next revision and makes it current while this one stays in the
        history.
      </p>
      {detail.regradeClaim && <RegradeClaim claim={detail.regradeClaim} />}
      {regradeable ? (
        <RegradeResultForm key={detail.resultId} resultId={detail.resultId} />
      ) : !detail.isCurrent ? (
        <p>
          This is a historical revision.{" "}
          {current && (
            <Link
              className="text-link"
              href={`/admin/academic-results?result=${current.resultId}`}
            >
              Open the current revision {current.revisionNumber}
            </Link>
          )}
        </p>
      ) : !detail.isValid ? (
        <p>
          A revision that fails the integrity checks cannot be regraded. Refer
          it to a platform administrator.
        </p>
      ) : detail.regradeClaim ? null : (
        <p>
          Regrade is available only while the enrolment is ACTIVE (this
          enrolment is {detail.enrolmentStatus}).
        </p>
      )}
    </Card>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const filters = parseAcademicResultFilters(await searchParams);
  const { actor, page, options, pageSize, selected, record, progress } =
    await getAcademicResultsWorkspace(filters);
  const offset = filters.offset ?? 0;
  const practicalTitle = new Map(
    options.practicals.map((p) => [p.id, p.title]),
  );
  const rec = record?.value;
  const okProgress = progress && progress.ok ? progress : null;
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Academic results"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACADEMIC RESULTS</p>
            <h2>Assessment and lab results</h2>
          </div>
          <Badge tone="muted">APPEND-ONLY RESULTS · GOVERNED OPERATIONS</Badge>
        </div>
        <p>
          Find a learner&apos;s results, see where each grade came from and how
          it was revised, and check course progress and completion. Grades are
          corrected only by institutional regrade; nothing here edits or removes
          a result.
        </p>
        <form method="get" className="support-form" role="search">
          <div className="field">
            <label htmlFor="results-q">Learner name or student number</label>
            <input
              id="results-q"
              name="q"
              maxLength={100}
              defaultValue={filters.q ?? ""}
            />
          </div>
          <div className="field">
            <label htmlFor="results-kind">Result kind</label>
            <select
              id="results-kind"
              name="kind"
              defaultValue={filters.kind ?? ""}
            >
              <option value="">Assessments and labs</option>
              <option value="ASSESSMENT">Assessments</option>
              <option value="LAB">Practical labs</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="results-component">Assessment component</label>
            <select
              id="results-component"
              name="component"
              defaultValue={filters.component ?? ""}
            >
              <option value="">Any component</option>
              {academicResultComponents.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="results-practical">Practical lab</label>
            <select
              id="results-practical"
              name="practical"
              defaultValue={filters.practical ?? ""}
            >
              <option value="">Any practical</option>
              {options.practicals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="results-cohort">Cohort</label>
            <select
              id="results-cohort"
              name="cohort"
              defaultValue={filters.cohort ?? ""}
            >
              <option value="">Any cohort</option>
              {options.cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="results-version">Programme version</label>
            <select
              id="results-version"
              name="version"
              defaultValue={filters.version ?? ""}
            >
              <option value="">Any programme version</option>
              {options.programmeVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} · {v.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="results-completion">Course completion</label>
            <select
              id="results-completion"
              name="completion"
              defaultValue={filters.completion ?? ""}
            >
              <option value="">Completed or not</option>
              <option value="COMPLETED">Completed (receipt recorded)</option>
              <option value="NOT_COMPLETED">Not completed</option>
            </select>
          </div>
          <div className="field">
            <label>
              <input
                type="checkbox"
                name="history"
                value="1"
                defaultChecked={filters.history === "1"}
              />{" "}
              Include historical (superseded) revisions
            </label>
          </div>
          <button className="button secondary">Filter results</button>
        </form>
      </Card>

      <Card>
        <h2>
          {filters.history === "1" ? "All revisions" : "Current results"}
          {offset > 0 ? ` · from ${offset + 1}` : ""}
        </h2>
        {page.results.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>Work</th>
                  <th>Revision</th>
                  <th>Marks</th>
                  <th>Contribution</th>
                  <th>Origin</th>
                  <th>Finalized (UTC)</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {page.results.map((r) => (
                  <tr key={r.resultId}>
                    <td>
                      {r.learnerName ?? "Learner"}
                      <div className="muted">{r.studentNumber}</div>
                      <div className="muted">
                        {r.cohortTitle} · {r.enrolmentStatus}
                      </div>
                    </td>
                    <td>
                      {workLabel(r)}
                      {r.kind === "ASSESSMENT" && (
                        <div className="muted">{r.targetTitle}</div>
                      )}
                    </td>
                    <td>
                      {r.revisionNumber}{" "}
                      <RevisionBadges
                        isCurrent={r.isCurrent}
                        isValid={r.isValid}
                      />
                    </td>
                    <td>
                      {r.earnedMarks} / {r.maxMarks}
                    </td>
                    <td>{formatBp(r.weightedContributionBp)}</td>
                    <td>{academicResultOriginLabels[r.origin]}</td>
                    <td>{r.finalizedAt}</td>
                    <td>
                      <Link
                        className="text-link"
                        href={href(filters, {
                          result: r.resultId,
                          enrolment: undefined,
                        })}
                        aria-current={
                          r.resultId === filters.result ? "true" : undefined
                        }
                      >
                        Open result
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No results match these filters">
            Results appear here once a grade has been recorded.
          </EmptyState>
        )}
        {(offset > 0 || page.hasMore) && (
          <nav className="pagination" aria-label="Result pages">
            {offset > 0 && (
              <Link
                className="text-link"
                href={href(filters, {
                  offset: Math.max(0, offset - pageSize) || undefined,
                  result: undefined,
                })}
              >
                Previous {pageSize}
              </Link>
            )}{" "}
            {page.hasMore && (
              <Link
                className="text-link"
                href={href(filters, {
                  offset: offset + pageSize,
                  result: undefined,
                })}
              >
                Next {pageSize}
              </Link>
            )}
          </nav>
        )}
      </Card>

      {selected?.error && (
        <Card>
          <p className="notice error" role="alert">
            {academicResultsRefusalMessage(selected.error)}
          </p>
        </Card>
      )}
      {selected?.value && <ResultDetail detail={selected.value} />}

      {record?.error && !selected?.error && (
        <Card>
          <p className="notice error" role="alert">
            {academicResultsRefusalMessage(record.error)}
          </p>
        </Card>
      )}
      {rec && (
        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">LEARNER RECORD</p>
              <h2>
                {rec.learnerName ?? "Learner"} · {rec.studentNumber}
              </h2>
            </div>
            <Badge tone={rec.enrolmentStatus === "ACTIVE" ? "blue" : "gold"}>
              ENROLMENT {rec.enrolmentStatus}
            </Badge>
          </div>
          <p className="muted">
            {rec.programmeTitle} {rec.versionLabel} · {rec.cohortTitle}
          </p>
          {rec.enrolmentStatus !== "ACTIVE" &&
            rec.enrolmentStatus !== "COMPLETED" && (
              <p className="notice" role="status">
                This enrolment is {rec.enrolmentStatus}. Its results stay on the
                record, but it cannot be regraded or completed unless it becomes
                ACTIVE again through the enrolment workflow.
              </p>
            )}
          <h3>Course progress</h3>
          {okProgress ? (
            <>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Requirement</th>
                      <th>Status</th>
                      <th>Score</th>
                      <th>Weighted contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(okProgress.components).map(
                      ([component, c]) => (
                        <tr key={component}>
                          <td>{component}</td>
                          <td>{c.status}</td>
                          <td>
                            {c.status === "FINALIZED"
                              ? formatBp(c.scoreBp)
                              : "—"}
                          </td>
                          <td>
                            {c.status === "FINALIZED"
                              ? formatBp(c.weightedContributionBp)
                              : "—"}
                          </td>
                        </tr>
                      ),
                    )}
                    {Object.entries(okProgress.labs).map(([practicalId, l]) => (
                      <tr key={practicalId}>
                        <td>
                          Lab · {practicalTitle.get(practicalId) ?? "Practical"}
                        </td>
                        <td>{l.status}</td>
                        <td>—</td>
                        <td>
                          {l.status === "FINALIZED"
                            ? formatBp(l.weightedContributionBp)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="detail-list">
                <dt>Course score</dt>
                <dd>
                  {okProgress.courseScoreBp === null
                    ? `Not yet available (${okProgress.pending.length} pending)`
                    : formatBp(okProgress.courseScoreBp)}
                </dd>
                <dt>Pass mark</dt>
                <dd>
                  {okProgress.passMarkBp === null
                    ? "No result policy published"
                    : formatBp(okProgress.passMarkBp)}
                </dd>
                <dt>Open remediation items</dt>
                <dd>{okProgress.openRemediationCount}</dd>
              </dl>
            </>
          ) : (
            <p className="muted">
              Course progress is not available for this enrolment.
            </p>
          )}
          <h3>Completion</h3>
          {rec.receipt ? (
            <dl className="detail-list">
              <dt>Completed (UTC)</dt>
              <dd>{rec.receipt.completedAt}</dd>
              <dt>Final course score</dt>
              <dd>{formatBp(rec.receipt.finalCourseScoreBp)}</dd>
              <dt>Pass mark</dt>
              <dd>{formatBp(rec.receipt.passMarkBp)}</dd>
              <dt>Completed by</dt>
              <dd>{rec.receipt.completedByName ?? "—"}</dd>
              <dt>Receipt</dt>
              <dd>{rec.receipt.receiptId}</dd>
            </dl>
          ) : rec.enrolmentStatus === "COMPLETED" ? (
            <p className="notice error" role="alert">
              {completionOutcomeMessages.COMPLETION_RECEIPT_MISSING}
            </p>
          ) : rec.enrolmentStatus === "ACTIVE" ? (
            <>
              <p className="muted">
                Not completed. Viewing never completes a course. Attempting
                completion re-checks every requirement and reports why it is
                refused.
              </p>
              <CompleteEnrolmentForm enrolmentId={rec.enrolmentId} />
            </>
          ) : (
            <p className="muted">
              Not completed. Completion requires an ACTIVE enrolment.
            </p>
          )}
        </Card>
      )}
    </StaffShell>
  );
}
