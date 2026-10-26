import Link from "next/link";
import { Progress } from "@/components/ui";
import type {
  CourseProgression,
  LearnerCourse,
} from "@/domain/learner-contract";
import { formatDate, ratio } from "./learner-format";

function Measure({
  label,
  part,
  total,
  unit,
  detail,
}: {
  label: string;
  part: number;
  total: number;
  unit: string;
  detail?: string;
}) {
  const value = ratio(part, total);
  const text = `${part} of ${total} ${unit}`;
  return (
    <div className="ln-measure">
      <div className="ln-measure__row">
        <span className="ln-measure__label">{label}</span>
        <span className="ln-measure__value">
          {total === 0 ? `None scheduled yet` : text}
        </span>
      </div>
      {value !== null && (
        <Progress value={value} label={label} valueText={text} />
      )}
      {detail && <p className="ln-measure__detail">{detail}</p>}
    </div>
  );
}

// Counts the server holds for an enrolment. Bars are ratios of those real
// counts and nothing else: there is no invented percentage.
export function ProgressionMeasures({
  progression,
  timeZone = "UTC",
}: {
  progression: CourseProgression;
  timeZone?: string;
}) {
  const p = progression;
  return (
    <div className="ln-measures">
      <Measure
        label="Classes attended"
        part={p.classes.attended}
        total={p.classes.total}
        unit="classes"
        detail={p.classes.missed > 0 ? `${p.classes.missed} missed` : undefined}
      />
      <Measure
        label="Objectives demonstrated"
        part={p.objectives.demonstrated}
        total={p.objectives.total}
        unit="objectives"
        detail="From released assessments and practicals only."
      />
      <Measure
        label="Practicals submitted"
        part={p.practicals.submitted}
        total={p.practicals.total}
        unit="practicals"
        detail={
          p.practicals.total > 0 ? `${p.practicals.graded} graded` : undefined
        }
      />
      <Measure
        label="Assessments released"
        part={p.assessments.released}
        total={p.assessments.total}
        unit="assessments"
      />
      <p className="ln-measure__completion">
        {p.completion.completed
          ? p.completion.completedAt
            ? `Course completed on ${formatDate(p.completion.completedAt, timeZone)}.`
            : "Course completed."
          : "Not yet completed."}
      </p>
    </div>
  );
}

export function ProgressionCard({
  course,
  progression,
  headingLevel = "h3",
  detailsHref,
  timeZone,
}: {
  course: Pick<LearnerCourse, "title" | "provider">;
  progression: CourseProgression;
  headingLevel?: "h2" | "h3";
  detailsHref?: string;
  timeZone?: string;
}) {
  const Heading = headingLevel;
  return (
    <article className="ln-progress-card">
      <Heading className="ln-progress-card__title">{course.title}</Heading>
      <p className="ln-muted ln-progress-card__provider">{course.provider}</p>
      <ProgressionMeasures progression={progression} timeZone={timeZone} />
      {detailsHref && (
        <Link className="ln-textlink" href={detailsHref}>
          View course progression
        </Link>
      )}
    </article>
  );
}

// /student/courses/[enrolmentId]/progression
export function CourseProgressionView({
  course,
  progression,
  timeZone,
}: {
  course: LearnerCourse | null;
  progression: CourseProgression | null;
  timeZone?: string;
}) {
  return (
    <div className="ln-page">
      <header className="ln-page__head">
        <p className="ln-eyebrow">Course progression</p>
        <h1>{course?.title ?? "Course progression"}</h1>
        {course && <p className="ln-muted">{course.provider}</p>}
      </header>
      <div className="ln-panel">
        {!course || !progression ? (
          <p role="alert">
            This course&apos;s progression could not be loaded. Nothing has
            changed; try again shortly.
          </p>
        ) : (
          <>
            <ProgressionMeasures
              progression={progression}
              timeZone={timeZone}
            />
            <p className="ln-note">
              Attending a class records that you were present. It is not
              completion or mastery. Objectives are demonstrated only through
              released assessment and practical evidence.
            </p>
            <Link
              className="button secondary"
              href={`/student/courses/${encodeURIComponent(course.enrolmentId)}`}
            >
              Back to course
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
