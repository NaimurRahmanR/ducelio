import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseProgression,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import type { LearnerCourse } from "@/domain/learner-contract";
import { AcademyShell } from "@/components/academy-shell";
import { CourseProgressionView } from "@/components/learner/progression";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ enrolmentId: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { enrolmentId } = await params;
  const [courses, progression] = await Promise.all([
    listMyLearnerCourses().catch(() => null),
    getMyCourseProgression(enrolmentId).catch(() => null),
  ]);
  const course =
    courses?.find((c: LearnerCourse) => c.enrolmentId === enrolmentId) ?? null;
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <CourseProgressionView course={course} progression={progression} />
    </AcademyShell>
  );
}
