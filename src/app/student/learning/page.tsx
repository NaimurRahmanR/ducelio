import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listMyLearnerCourses } from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { MyLearningView } from "@/components/learner/my-learning";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const courses = await listMyLearnerCourses().catch(() => null);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <MyLearningView courses={courses} />
    </AcademyShell>
  );
}
