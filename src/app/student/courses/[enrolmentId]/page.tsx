import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseWorkspace,
  getMyLearnerWeek,
} from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { CourseWorkspaceView } from "@/components/learner/course-workspace";
import { startAssessmentAction } from "@/app/student/academy/actions";
import { enterAcademyClassAction } from "@/app/student/academy/classroom/actions";
import { openLabSupportAction } from "@/app/student/academy/support/actions";
// INTEGRATION: server actions provided at integration (see docs/61 and the
// Lane A handoff for their form fields).
import {
  checkInMyClassAction,
  openMyTutorAction,
} from "@/app/student/courses/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ enrolmentId: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { enrolmentId } = await params;
  const [workspace, week] = await Promise.all([
    getMyCourseWorkspace(enrolmentId).catch(() => null),
    getMyLearnerWeek().catch(() => null),
  ]);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <CourseWorkspaceView
        workspace={workspace}
        serverTime={week?.serverTime ?? new Date().toISOString()}
        timeZone={week?.timezone}
        checkInAction={checkInMyClassAction}
        enterClassAction={enterAcademyClassAction}
        openTutorAction={openMyTutorAction}
        startAssessmentAction={startAssessmentAction}
        attendLabAction={openLabSupportAction}
        // INTEGRATION: mount Lane C's lab evidence upload form here.
        labEvidenceSlot={null}
      />
    </AcademyShell>
  );
}
