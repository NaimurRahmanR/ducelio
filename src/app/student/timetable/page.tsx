import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyLearnerWeek,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { TimetableWeekView } from "@/components/learner/timetable-week";
import { isIsoDate } from "@/components/learner/learner-format";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; course?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const week = isIsoDate(params.week) ? params.week : undefined;
  const [courses, learnerWeek] = await Promise.all([
    listMyLearnerCourses().catch(() => null),
    getMyLearnerWeek(week).catch(() => null),
  ]);
  // INTEGRATION: pass `evidence` (Record<itemId, ClassEvidence>) once the
  // academic loader exposes per-class evidence for the week.
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <TimetableWeekView
        week={courses === null ? null : learnerWeek}
        courses={courses ?? []}
        courseFilter={typeof params.course === "string" ? params.course : null}
      />
    </AcademyShell>
  );
}
