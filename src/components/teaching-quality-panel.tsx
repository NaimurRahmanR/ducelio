import { Badge, Card } from "./ui";
import { LocalDateTimeField } from "./local-datetime-field";
import {
  RATING_ADMIN_LABEL,
  RATING_FIELDS,
  TEACHING_QUALITY_PAGE_SIZE,
  formatAverage,
  type TeachingQualityRow,
  type TeachingQualitySummary,
} from "@/domain/session-feedback";
import type { TeachingQualityPage } from "@/server/session-feedback";

export type TeachingQualityFilters = {
  tqInstructorId?: string;
  tqCohortId?: string;
  tqFrom?: string;
  tqUntil?: string;
  tqOffset?: string;
};

const averageKey = {
  clarityRating: "clarityAverage",
  paceRating: "paceAverage",
  usefulnessRating: "usefulnessAverage",
} as const;

function Scores({
  value,
}: {
  value: TeachingQualityRow | TeachingQualitySummary;
}) {
  return (
    <>
      {RATING_FIELDS.map((field) => (
        <td key={field}>{formatAverage(value[averageKey[field]])}</td>
      ))}
    </>
  );
}

// AC-6: the admin teaching-quality view (Academic Admin and Platform Admin;
// the database refuses every other role). Aggregate only: no learner name,
// number, id, individual rating or submission time ever reaches this view.
// Scores need at least the minimum number of responses per session.
export function TeachingQualityPanel({
  page,
  instructors,
  cohorts,
  filters,
}: {
  page: TeachingQualityPage;
  instructors: { user_id: string; display_name: string }[];
  cohorts: { id: string; title: string }[];
  filters: TeachingQualityFilters;
}) {
  function pageLink(offset: number) {
    const q = new URLSearchParams({ section: "Sessions" });
    for (const [key, value] of Object.entries(filters))
      if (value && key !== "tqOffset") q.set(key, value);
    q.set("tqOffset", String(offset));
    return "/admin?" + q.toString();
  }
  const offset = page.status === "OK" ? page.data.offset : 0;
  return (
    <Card>
      <div className="section-heading">
        <h2>Teaching quality</h2>
        <Badge tone="muted">AGGREGATE ONLY</Badge>
      </div>
      <p>
        Learners who were recorded as present at an ended session can give three
        optional 1–5 ratings (higher is better): clarity, pace (how well it
        suited them) and usefulness. Cancelled sessions are excluded.
      </p>
      <p className="config-caption">
        Scores for a session appear only from 3 responses. The summary averages
        only sessions that meet that threshold. Learner names, numbers,
        individual ratings and submission times are never shown. Feedback is
        observational: it changes no grade, attendance, progress, session or
        instructor assignment.
      </p>
      <form method="get">
        <input type="hidden" name="section" value="Sessions" />
        <label>
          Instructor
          <select
            name="tqInstructorId"
            defaultValue={filters.tqInstructorId ?? ""}
          >
            <option value="">All instructors</option>
            {instructors.map((x) => (
              <option key={x.user_id} value={x.user_id}>
                {x.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cohort
          <select name="tqCohortId" defaultValue={filters.tqCohortId ?? ""}>
            <option value="">All cohorts</option>
            {cohorts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        </label>
        <LocalDateTimeField
          id="tq-from"
          name="tqFrom"
          label="Sessions starting from (inclusive)"
          required={false}
        />
        <LocalDateTimeField
          id="tq-until"
          name="tqUntil"
          label="Sessions starting before (exclusive)"
          required={false}
        />
        <button className="button secondary">Show teaching quality</button>
        <a href="/admin?section=Sessions">Clear filters</a>
      </form>
      {page.status === "INVALID_FILTERS" && (
        <p role="alert">
          These teaching-quality filters are not valid. Clear them and try
          again.
        </p>
      )}
      {page.status === "UNAVAILABLE" && (
        <p role="alert">Teaching quality could not be loaded right now.</p>
      )}
      {page.status === "OK" && (
        <>
          <h3>Summary for these filters</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Ended sessions</th>
                  <th scope="col">Responses</th>
                  <th scope="col">Sessions with scores</th>
                  {RATING_FIELDS.map((field) => (
                    <th scope="col" key={field}>
                      {RATING_ADMIN_LABEL[field]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{page.data.summary.sessionCount}</td>
                  <td>{page.data.summary.responseCount}</td>
                  <td>
                    {page.data.summary.scoredSessionCount} (
                    {page.data.summary.scoredResponseCount} responses)
                  </td>
                  <Scores value={page.data.summary} />
                </tr>
              </tbody>
            </table>
          </div>
          <h3>Sessions</h3>
          {page.data.rows.length === 0 ? (
            <p>No ended sessions match these filters.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Present</th>
                    <th scope="col">Responses</th>
                    {RATING_FIELDS.map((field) => (
                      <th scope="col" key={field}>
                        {RATING_ADMIN_LABEL[field]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.data.rows.map((row) => (
                    <tr key={row.sessionId}>
                      <td>
                        {row.lessonTitle}
                        <br />
                        {row.cohortTitle} · {row.instructorName}
                        <br />
                        {row.programmeTitle} / {row.versionLabel}
                        <br />
                        {row.scheduledStart} ({row.status})
                      </td>
                      <td>{row.presentCount}</td>
                      <td>{row.responseCount}</td>
                      {row.scoresAvailable ? (
                        <Scores value={row} />
                      ) : (
                        <td colSpan={RATING_FIELDS.length}>
                          Insufficient responses for scores
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            Up to {TEACHING_QUALITY_PAGE_SIZE} sessions per page, most recent
            first.{" "}
            {page.data.hasMore
              ? "More matching sessions are available."
              : "End of matching sessions."}
          </p>
          {offset > 0 && (
            <a
              href={pageLink(Math.max(0, offset - TEACHING_QUALITY_PAGE_SIZE))}
            >
              Previous teaching-quality page
            </a>
          )}{" "}
          {page.data.hasMore && (
            <a href={pageLink(offset + TEACHING_QUALITY_PAGE_SIZE)}>
              Next teaching-quality page
            </a>
          )}
        </>
      )}
    </Card>
  );
}
