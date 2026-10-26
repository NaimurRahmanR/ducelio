import { randomUUID } from "node:crypto";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseProgression,
  getMyLearnerWeek,
  getMyNextActivity,
  getMyReleasedResults,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import type { LearnerCourse } from "@/domain/learner-contract";
import { AcademyShell } from "@/components/academy-shell";
import { LearnerDashboardView } from "@/components/learner/dashboard";
import { isIsoDate } from "@/components/learner/learner-format";

export const dynamic = "force-dynamic";

// The learner's post-login landing (docs/61 §2). Every value is read for the
// signed-in learner by the server; the page sends no learner identifier.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { week: weekParam } = await searchParams;
  const week = isIsoDate(weekParam) ? weekParam : undefined;
  const [courses, learnerWeek, nextActivity, results] = await Promise.all([
    listMyLearnerCourses().catch(() => null),
    getMyLearnerWeek(week).catch(() => null),
    getMyNextActivity().catch(() => null),
    getMyReleasedResults().catch(() => null),
  ]);
  const progressions = await Promise.all(
    (courses ?? [])
      .filter((c: LearnerCourse) => c.scheduled)
      .map(async (course: LearnerCourse) => ({
        course,
        progression: await getMyCourseProgression(course.enrolmentId).catch(
          () => null,
        ),
      })),
  );
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <LearnerDashboardView
        courses={courses}
        nextActivity={nextActivity}
        week={learnerWeek}
        progressions={progressions}
        results={results}
        // Generated on the server so render and hydration agree.
        sarahIdempotencyKey={randomUUID()}
      />
    </AcademyShell>
  );
}
