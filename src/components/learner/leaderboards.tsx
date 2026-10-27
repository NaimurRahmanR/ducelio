import Link from "next/link";
import { EmptyState } from "@/components/ui";
import type { AssessmentLeaderboard } from "@/domain/learner-contract";
import { monthLabel, scoreText } from "./learner-format";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Monthly leaderboards: per course, per assessment, for one UTC month.
// Released best scores only, top 10, pseudonymous labels; the server marks
// the learner's own row (docs/61 §3).
export function LeaderboardsView({
  boards,
  month,
}: {
  boards: AssessmentLeaderboard[] | null;
  month?: string | null;
}) {
  const months = [...new Set((boards ?? []).map((b) => b.month))]
    .filter((m) => MONTH.test(m))
    .sort()
    .reverse();
  const selected = month && months.includes(month) ? month : months[0];
  const shown = (boards ?? []).filter((b) => b.month === selected);
  const courses = [...new Set(shown.map((b) => b.courseTitle))];
  return (
    <div className="ln-page">
      <header className="ln-page__head">
        <h1>Leaderboards</h1>
        <p className="ln-muted">
          Best released scores for each assessment on your courses, by the month
          of the first attempt. Names are pseudonymous; your own row reads
          &ldquo;You&rdquo;.
        </p>
      </header>
      {boards === null ? (
        <div className="ln-panel">
          <p role="alert">
            Leaderboards could not be loaded. Nothing has changed; try again
            shortly.
          </p>
        </div>
      ) : months.length === 0 ? (
        <div className="ln-panel">
          <EmptyState title="No leaderboards yet">
            Leaderboards appear after an assessment on one of your courses has
            released results.{" "}
            <Link className="ln-textlink" href="/student/learning">
              My Learning
            </Link>
          </EmptyState>
        </div>
      ) : (
        <>
          <form method="get" className="ln-filter" aria-label="Choose month">
            <label htmlFor="ln-month">Month</label>
            <select id="ln-month" name="month" defaultValue={selected}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
            <button className="button secondary">Show</button>
          </form>
          {courses.map((courseTitle) => (
            <section
              key={courseTitle}
              className="ln-panel"
              aria-label={courseTitle}
            >
              <h2>{courseTitle}</h2>
              {shown
                .filter((b) => b.courseTitle === courseTitle)
                .map((b) => (
                  <div key={b.assessmentRef} className="ln-board">
                    <h3>{b.assessmentTitle}</h3>
                    {b.entries.length === 0 ? (
                      <p className="ln-empty-line">
                        No released scores for {monthLabel(b.month)} yet.
                      </p>
                    ) : (
                      <div className="ln-table-wrap">
                        <table className="ln-table">
                          <caption>
                            Top {Math.min(10, b.entries.length)} for{" "}
                            {b.assessmentTitle}, {monthLabel(b.month)}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">Rank</th>
                              <th scope="col">Learner</th>
                              <th scope="col">Best score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.entries.slice(0, 10).map((e) => (
                              <tr
                                key={`${e.rank}:${e.label}`}
                                className={e.isMe ? "is-me" : undefined}
                                aria-current={e.isMe ? "true" : undefined}
                              >
                                <td data-label="Rank">{e.rank}</td>
                                <th scope="row" data-label="Learner">
                                  {e.isMe ? "You" : e.label}
                                </th>
                                <td data-label="Best score">
                                  {scoreText(e.bestScore, e.maxScore)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
