import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyClassEvidence,
  getMyLearnerWeek,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import { listMyUpcomingReminders } from "@/server/learner-push";
import { learnerServicesConfig } from "@/lib/env";
import { AcademyShell } from "@/components/academy-shell";
import { TimetableWeekView } from "@/components/learner/timetable-week";
import { ActivityReminders } from "@/components/learner/activity-reminders";
import { isIsoDate } from "@/components/learner/learner-format";
import {
  subscribePushAction,
  unsubscribePushAction,
} from "@/app/student/_actions/push-actions";

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
  const [courses, learnerWeek, reminders] = await Promise.all([
    listMyLearnerCourses().catch(() => null),
    getMyLearnerWeek(week).catch(() => null),
    listMyUpcomingReminders(7).catch(() => null),
  ]);
  // Display-only class evidence (attendance, in-class answers, covered
  // objectives) for the week shown; never mastery. A failed read shows the
  // timetable without it.
  const evidence = learnerWeek
    ? await getMyClassEvidence(undefined, learnerWeek.weekStart).catch(
        () => undefined,
      )
    : undefined;
  const push = learnerServicesConfig().push;
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <TimetableWeekView
        week={courses === null ? null : learnerWeek}
        courses={courses ?? []}
        courseFilter={typeof params.course === "string" ? params.course : null}
        evidence={evidence}
      />
      <div className="ln-page">
        <ActivityReminders
          publicKey={push.configured ? push.publicKey : null}
          upcoming={reminders?.items ?? null}
          timeZone={learnerWeek?.timezone}
          subscribeAction={subscribePushAction}
          unsubscribeAction={unsubscribePushAction}
        />
      </div>
    </AcademyShell>
  );
}
