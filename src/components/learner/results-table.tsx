import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReleasedResult } from "@/domain/learner-contract";
import { formatDate, scoreText } from "./learner-format";

const OUTCOME: (passed: boolean | null) => string = (passed) =>
  passed === null ? "No pass mark" : passed ? "Passed" : "Not passed";

// Released results only. The server returns an assessment here only after
// its window has closed and no attempt is active (docs/61 §3); nothing
// unreleased has a row, a score or an outcome. A row with the learner's own
// reviewable attempt opens that attempt's released review (score, correct
// answers, explanations); the whole row is that one link.
export function ReleasedResultsTable({
  results,
  caption,
  timeZone = "UTC",
  showCourse = true,
}: {
  results: ReleasedResult[];
  caption: string;
  timeZone?: string;
  showCourse?: boolean;
}) {
  if (results.length === 0)
    return <p className="ln-empty-line">No results to show yet.</p>;
  return (
    <div className="ln-table-wrap">
      <table className="ln-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {showCourse && <th scope="col">Course</th>}
            <th scope="col">Assessment</th>
            <th scope="col">Type</th>
            <th scope="col">Released</th>
            <th scope="col">Best score</th>
            <th scope="col">Attempts</th>
            <th scope="col">Outcome</th>
            <th scope="col">
              <span className="ln-sr">Review</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr
              key={`${r.enrolmentId}:${r.assessmentRef}`}
              className={r.reviewAttemptId ? "ln-rowlink" : undefined}
            >
              {showCourse && <td data-label="Course">{r.courseTitle}</td>}
              <th scope="row" data-label="Assessment">
                {r.assessmentTitle}
              </th>
              <td data-label="Type">{r.kind}</td>
              <td data-label="Released">
                <time dateTime={r.releasedAt}>
                  {formatDate(r.releasedAt, timeZone)}
                </time>
              </td>
              <td data-label="Best score" className="ln-score">
                {scoreText(r.bestScore, r.maxScore)}
              </td>
              <td data-label="Attempts">{r.attemptsUsed}</td>
              <td data-label="Outcome">{OUTCOME(r.passed)}</td>
              <td data-label="Review">
                {r.reviewAttemptId ? (
                  <Link
                    className="ln-rowlink__link"
                    href={`/student/academy/attempt/${encodeURIComponent(r.reviewAttemptId)}`}
                  >
                    View results
                    <span className="ln-sr">: {r.assessmentTitle}</span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="ln-muted">Not attempted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
