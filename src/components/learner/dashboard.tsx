import Link from "next/link";
import { ArrowRight, Compass } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import type {
  CourseProgression,
  LearnerActivity,
  LearnerCourse,
  LearnerWeek,
  ReleasedResult,
} from "@/domain/learner-contract";
import {
  KIND_LABEL,
  STATE_LABEL,
  STATE_TONE,
  activityTitle,
  formatDate,
  formatTime,
  workspaceHref,
} from "./learner-format";
import { ProgressionCard } from "./progression";
import { ReleasedResultsTable } from "./results-table";
import { SarahCompactChat } from "./sarah-compact-chat";
import { WeekTimetable } from "./timetable-week";

export type DashboardProgression = {
  course: LearnerCourse;
  progression: CourseProgression | null;
};

function accessLabel(a: LearnerActivity): string {
  if (a.kind === "ASSESSMENT") return "Open Assessment Centre";
  if (a.kind === "LAB") return "Open Practical Lab";
  if (a.kind === "LESSON" && a.state === "OPEN") return "Go to class";
  return "Open course";
}

export function NextActivityCard({
  activity,
  timeZone,
  hasCourses,
}: {
  activity: LearnerActivity | null;
  timeZone: string;
  hasCourses: boolean;
}) {
  return (
    <section
      className="ln-panel ln-next"
      aria-labelledby="ln-next-heading"
      data-panel="next-activity"
    >
      <p className="ln-eyebrow">Next activity</p>
      {activity ? (
        <>
          <h2 id="ln-next-heading" className="ln-next__title">
            {activityTitle(activity)}
          </h2>
          <p className="ln-next__course">
            {activity.courseTitle}
            <span className="ln-muted"> · {activity.provider}</span>
          </p>
          <dl className="ln-next__facts">
            <div>
              <dt>Type</dt>
              <dd>{KIND_LABEL[activity.kind]}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>
                <time dateTime={activity.startsAt}>
                  {formatDate(activity.startsAt, timeZone)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>
                {formatTime(activity.startsAt, timeZone)} to{" "}
                {formatTime(activity.endsAt, timeZone)}{" "}
                <span className="ln-muted">({timeZone})</span>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Badge tone={STATE_TONE[activity.state]}>
                  {STATE_LABEL[activity.state]}
                </Badge>
              </dd>
            </div>
          </dl>
          <Link className="button" href={workspaceHref(activity.enrolmentId)}>
            {accessLabel(activity)} <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </>
      ) : (
        <>
          <h2 id="ln-next-heading" className="ln-next__title">
            Nothing scheduled next
          </h2>
          <p className="ln-muted">
            {hasCourses
              ? "No upcoming activity is on your timetable. Your courses and their timetables are in My Learning."
              : "When you enrol on a course and choose your timetable, your next activity appears here."}
          </p>
          <div className="ln-actions">
            <Link className="button" href="/courses">
              Browse Courses
            </Link>
            {hasCourses && (
              <Link className="button secondary" href="/student/learning">
                My Learning
              </Link>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// /student: the learner's dashboard, exactly four rows (docs/61 §2).
export function LearnerDashboardView({
  courses,
  nextActivity,
  week,
  progressions,
  results,
  sarahIdempotencyKey,
}: {
  courses: LearnerCourse[] | null;
  nextActivity: LearnerActivity | null;
  week: LearnerWeek | null;
  progressions: DashboardProgression[];
  results: ReleasedResult[] | null;
  sarahIdempotencyKey: string;
}) {
  const timeZone = week?.timezone ?? "UTC";
  const hasCourses = (courses?.length ?? 0) > 0;
  return (
    <div className="ln-dashboard">
      <h1 className="ln-sr">Dashboard</h1>
      <div className="ln-row ln-row--intro" data-row="1">
        <div className="ln-panel ln-panel--flush" data-panel="sarah">
          <SarahCompactChat initialIdempotencyKey={sarahIdempotencyKey} />
        </div>
        <NextActivityCard
          activity={nextActivity}
          timeZone={timeZone}
          hasCourses={hasCourses}
        />
      </div>

      {hasCourses && (
        <div className="ln-row" data-row="2">
          <Link className="ln-explore" href="/courses">
            <Compass size={20} aria-hidden="true" />
            <span>
              <strong>Explore more courses</strong>
              <span className="ln-muted">
                Browse the published catalogue when you are ready for your next
                course.
              </span>
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      )}

      <div className="ln-row ln-row--week" data-row="3">
        <div className="ln-panel" data-panel="timetable">
          {courses === null || week === null ? (
            <>
              <h2>This week</h2>
              <p role="alert">
                Your timetable could not be loaded. Nothing has changed; try
                again shortly.
              </p>
            </>
          ) : !hasCourses ? (
            <>
              <h2>This week</h2>
              <EmptyState title="No timetable yet">
                When you enrol on a course and choose your timetable, every
                activity of the week appears here.
              </EmptyState>
            </>
          ) : (
            <WeekTimetable week={week} basePath="/student" />
          )}
        </div>
        <section
          className="ln-panel"
          aria-labelledby="ln-progress-heading"
          data-panel="progression"
        >
          <h2 id="ln-progress-heading">Course progression</h2>
          {progressions.length === 0 ? (
            <p className="ln-empty-line">
              {hasCourses
                ? "Progression appears once your course timetable is confirmed."
                : "No courses yet."}
            </p>
          ) : (
            <div className="ln-progress-list">
              {progressions.map(({ course, progression }) =>
                progression ? (
                  <ProgressionCard
                    key={course.enrolmentId}
                    course={course}
                    progression={progression}
                    timeZone={timeZone}
                    detailsHref={`${workspaceHref(course.enrolmentId)}/progression`}
                  />
                ) : (
                  <article
                    key={course.enrolmentId}
                    className="ln-progress-card"
                  >
                    <h3 className="ln-progress-card__title">{course.title}</h3>
                    <p className="ln-muted">
                      Progression could not be loaded right now.
                    </p>
                  </article>
                ),
              )}
            </div>
          )}
        </section>
      </div>

      <div className="ln-row" data-row="4">
        <section
          className="ln-panel"
          aria-labelledby="ln-results-heading"
          data-panel="results"
        >
          <h2 id="ln-results-heading">Released results</h2>
          {results === null ? (
            <p role="alert">
              Your results could not be loaded. Nothing has changed; try again
              shortly.
            </p>
          ) : (
            <ReleasedResultsTable
              results={results}
              caption="Released assessment results across your courses"
              timeZone={timeZone}
            />
          )}
          <p className="ln-note">
            Results appear only after an assessment&apos;s window has closed.
            Ducelio prepares you for external qualifications; it does not award
            them.
          </p>
        </section>
      </div>
    </div>
  );
}
