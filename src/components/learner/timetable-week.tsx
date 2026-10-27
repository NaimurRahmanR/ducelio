import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import type {
  ClassEvidence,
  LearnerActivity,
  LearnerCourse,
  LearnerWeek,
} from "@/domain/learner-contract";
import {
  KIND_LABEL,
  STATE_LABEL,
  STATE_TONE,
  activityTitle,
  dayHeading,
  formatDate,
  formatTime,
  groupByDay,
  localDate,
  shiftDate,
  weekHref,
  weekRangeLabel,
  workspaceHref,
} from "./learner-format";

// What a learner may read about a class they attended or that has closed.
// Display only: attendance, in-class answers and covered objectives are
// records of the session, never mastery.
function ClassEvidenceDetails({
  activity,
  evidence,
  timeZone,
}: {
  activity: LearnerActivity;
  evidence: ClassEvidence;
  timeZone: string;
}) {
  const covered = evidence.lessonObjectives.filter((o) => o.covered);
  return (
    <details className="ln-evidence">
      <summary>Class details</summary>
      <dl className="ln-evidence__list">
        <div>
          <dt>Date</dt>
          <dd>
            {formatDate(activity.startsAt, timeZone)},{" "}
            {formatTime(activity.startsAt, timeZone)} to{" "}
            {formatTime(activity.endsAt, timeZone)}
          </dd>
        </div>
        <div>
          <dt>Course</dt>
          <dd>
            {activity.courseTitle} · {activity.provider}
          </dd>
        </div>
        <div>
          <dt>Attendance</dt>
          <dd>
            {evidence.checkedInAt
              ? `Attended (checked in ${formatTime(evidence.checkedInAt, timeZone)})`
              : "No attendance recorded"}
          </dd>
        </div>
        <div>
          <dt>Correct in-class answers (judged by the AI Professor)</dt>
          <dd>{evidence.correctInClassAnswers}</dd>
        </div>
        <div>
          <dt>Objectives covered</dt>
          <dd>
            {evidence.lessonObjectives.length === 0 ? (
              "No lesson objectives were recorded for this class."
            ) : (
              <>
                {covered.length} of {evidence.lessonObjectives.length} covered
                <ul className="ln-objectives">
                  {evidence.lessonObjectives.map((o) => (
                    <li
                      key={o.ref}
                      className={o.covered ? "is-covered" : undefined}
                    >
                      <span className="ln-objectives__mark" aria-hidden="true">
                        {o.covered ? "✓" : "·"}
                      </span>
                      {o.title}
                      <span className="ln-sr">
                        {o.covered ? " (covered)" : " (not covered)"}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </dd>
        </div>
        {evidence.topicsCovered.length > 0 && (
          <div>
            <dt>Topics covered</dt>
            <dd>{evidence.topicsCovered.join(", ")}</dd>
          </div>
        )}
      </dl>
      <p className="ln-note">
        Attended means you were present. Covered means the topic was taught in
        this class. Neither is a mark or mastery: objectives are mastered only
        through released assessments and practicals.
      </p>
    </details>
  );
}

function ActivityItem({
  activity,
  timeZone,
  evidence,
}: {
  activity: LearnerActivity;
  timeZone: string;
  evidence?: ClassEvidence;
}) {
  const showEvidence =
    evidence &&
    activity.kind === "LESSON" &&
    (activity.state === "ATTENDED" || activity.state === "CLOSED");
  return (
    <li className={`ln-activity ln-activity--${activity.kind.toLowerCase()}`}>
      <p className="ln-activity__time">
        <time dateTime={activity.startsAt}>
          {formatTime(activity.startsAt, timeZone)}
        </time>
        {" to "}
        <time dateTime={activity.endsAt}>
          {formatTime(activity.endsAt, timeZone)}
        </time>
      </p>
      <p className="ln-activity__title">
        <Link href={workspaceHref(activity.enrolmentId)}>
          {activityTitle(activity)}
        </Link>
      </p>
      <p className="ln-activity__meta">
        {KIND_LABEL[activity.kind]} · {activity.courseTitle} ·{" "}
        {activity.provider}
      </p>
      <Badge tone={STATE_TONE[activity.state]}>
        {STATE_LABEL[activity.state]}
      </Badge>
      {activity.kind === "LESSON" && activity.state === "MISSED" && (
        <p className="ln-note">
          Not attended. A missed class is never marked completed.
        </p>
      )}
      {showEvidence && (
        <ClassEvidenceDetails
          activity={activity}
          evidence={evidence}
          timeZone={timeZone}
        />
      )}
    </li>
  );
}

export function WeekNavigation({
  weekStart,
  basePath,
  query = {},
}: {
  weekStart: string;
  basePath: string;
  query?: Record<string, string | null | undefined>;
}) {
  const rest = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) rest.set(k, v);
  const current = rest.size ? `${basePath}?${rest.toString()}` : basePath;
  return (
    <nav className="ln-weeknav" aria-label="Timetable weeks">
      <Link
        className="button secondary"
        href={weekHref(basePath, shiftDate(weekStart, -7), query)}
      >
        <span aria-hidden="true">←</span> Previous week
      </Link>
      <Link className="button secondary" href={current}>
        This week
      </Link>
      <Link
        className="button secondary"
        href={weekHref(basePath, shiftDate(weekStart, 7), query)}
      >
        Next week <span aria-hidden="true">→</span>
      </Link>
    </nav>
  );
}

// Every activity of the week, under its local day, with nothing truncated.
// Seven day columns on wide containers; day groups stacked on narrow ones.
export function WeekTimetable({
  week,
  basePath,
  query,
  evidence,
  courseFilter,
  headingId = "ln-week-heading",
  title = "This week",
}: {
  week: LearnerWeek;
  basePath: string;
  query?: Record<string, string | null | undefined>;
  evidence?: Record<string, ClassEvidence>;
  courseFilter?: string | null;
  headingId?: string;
  title?: string;
}) {
  const activities = courseFilter
    ? week.activities.filter((a) => a.enrolmentId === courseFilter)
    : week.activities;
  const { days, outside } = groupByDay(
    week.weekStart,
    week.timezone,
    activities,
  );
  const today = localDate(week.serverTime, week.timezone);
  return (
    <section className="ln-week" aria-labelledby={headingId}>
      <div className="ln-week__head">
        <div>
          <h2 id={headingId}>{title}</h2>
          <p className="ln-muted">
            {weekRangeLabel(week.weekStart)} · times in {week.timezone} ·{" "}
            {activities.length}{" "}
            {activities.length === 1 ? "activity" : "activities"}
          </p>
        </div>
        <WeekNavigation
          weekStart={week.weekStart}
          basePath={basePath}
          query={query}
        />
      </div>
      <ol className="ln-week__days">
        {days.map((day) => {
          const h = dayHeading(day.date);
          const isToday = day.date === today;
          return (
            <li
              key={day.date}
              className={isToday ? "ln-day is-today" : "ln-day"}
            >
              <h3 className="ln-day__head">
                <span>{h.weekday}</span>
                <span className="ln-day__date">
                  {h.date}
                  {isToday && <span className="ln-day__today">Today</span>}
                </span>
              </h3>
              {day.activities.length === 0 ? (
                <p className="ln-day__empty">Nothing scheduled</p>
              ) : (
                <ul className="ln-day__list">
                  {day.activities.map((a) => (
                    <ActivityItem
                      key={a.itemId}
                      activity={a}
                      timeZone={week.timezone}
                      evidence={evidence?.[a.itemId]}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {outside.length > 0 && (
        <div className="ln-week__outside">
          <h3>Also this week</h3>
          <ul className="ln-day__list">
            {outside.map((a) => (
              <ActivityItem
                key={a.itemId}
                activity={a}
                timeZone={week.timezone}
                evidence={evidence?.[a.itemId]}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// /student/timetable: the full week with an optional course filter.
export function TimetableWeekView({
  week,
  courses,
  courseFilter = null,
  evidence,
}: {
  week: LearnerWeek | null;
  courses: LearnerCourse[];
  courseFilter?: string | null;
  evidence?: Record<string, ClassEvidence>;
}) {
  const filter =
    courseFilter && courses.some((c) => c.enrolmentId === courseFilter)
      ? courseFilter
      : null;
  return (
    <div className="ln-page">
      <header className="ln-page__head">
        <h1>My Timetable</h1>
        <p className="ln-muted">
          Every scheduled class, practical, revision session and assessment, day
          by day.
        </p>
      </header>
      {courses.length > 1 && week && (
        <form method="get" className="ln-filter" aria-label="Filter by course">
          <input type="hidden" name="week" value={week.weekStart} />
          <label htmlFor="ln-course-filter">Course</label>
          <select
            id="ln-course-filter"
            name="course"
            defaultValue={filter ?? ""}
          >
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.enrolmentId} value={c.enrolmentId}>
                {c.title} · {c.provider}
              </option>
            ))}
          </select>
          <button className="button secondary">Apply</button>
        </form>
      )}
      {week === null ? (
        <div className="ln-panel">
          <p role="alert">
            Your timetable could not be loaded. Nothing has changed; try again
            shortly.
          </p>
        </div>
      ) : courses.length === 0 ? (
        <div className="ln-panel">
          <EmptyState title="No timetable yet">
            When you enrol on a course and choose your timetable, every activity
            appears here. <Link href="/courses">Browse Courses</Link>
          </EmptyState>
        </div>
      ) : (
        <div className="ln-panel">
          <WeekTimetable
            week={week}
            basePath="/student/timetable"
            query={{ course: filter }}
            evidence={evidence}
            courseFilter={filter}
            headingId="ln-timetable-heading"
            title="Week"
          />
        </div>
      )}
    </div>
  );
}
