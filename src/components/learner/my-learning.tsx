import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import type { LearnerCourse } from "@/domain/learner-contract";
import {
  courseStatusLabel,
  courseStatusTone,
  workspaceHref,
} from "./learner-format";

// /student/learning: one full-width row per enrolment. The whole row is the
// link into that course's workspace.
export function MyLearningView({
  courses,
}: {
  courses: LearnerCourse[] | null;
}) {
  return (
    <div className="ln-page">
      <header className="ln-page__head">
        <h1>My Learning</h1>
        <p className="ln-muted">Every course you are enrolled on.</p>
      </header>
      {courses === null ? (
        <div className="ln-panel">
          <p role="alert">
            Your courses could not be loaded. Nothing has changed; try again
            shortly.
          </p>
        </div>
      ) : courses.length === 0 ? (
        <div className="ln-panel">
          <EmptyState title="No courses yet">
            When you enrol on a course it appears here.{" "}
            <Link className="ln-textlink" href="/courses">
              Browse Courses
            </Link>
          </EmptyState>
        </div>
      ) : (
        <ul className="ln-course-rows" aria-label="Your courses">
          {courses.map((c) => (
            <li key={c.enrolmentId}>
              <Link
                className="ln-course-row"
                href={workspaceHref(c.enrolmentId)}
              >
                <span className="ln-course-row__main">
                  <span className="ln-course-row__title">{c.title}</span>
                  <span className="ln-course-row__provider">{c.provider}</span>
                </span>
                <span className="ln-course-row__status">
                  <span className="ln-sr">Enrolment status: </span>
                  <Badge tone={courseStatusTone(c)}>
                    {courseStatusLabel(c)}
                  </Badge>
                </span>
                <ChevronRight
                  className="ln-course-row__chevron"
                  size={20}
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
