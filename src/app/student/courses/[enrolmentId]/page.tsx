import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseWorkspace,
  getMyLearnerWeek,
} from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { CourseWorkspaceView } from "@/components/learner/course-workspace";
import { LabEvidenceForm } from "@/components/learner/lab-evidence-form";
import {
  getMyLabEvidence,
  listMyUnattachedLabFiles,
} from "@/server/learner-files";
import {
  removeLabEvidenceFileAction,
  submitLabEvidenceAction,
  uploadLabEvidenceFileAction,
} from "@/app/student/_actions/lab-artifact-actions";
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

// Why the AI Tutor could not be opened from this workspace (set by
// openMyTutorAction). Unknown values render nothing.
const TUTOR_NOTICE_TEXT: Record<string, string> = {
  NO_CLASS:
    "The AI Tutor opens on a class from your timetable. Confirm your timetable first.",
  NOT_RELEASED: "This class's material is not available to the Tutor yet.",
  NO_OBJECTIVES: "This class has no learning objectives for the Tutor to use.",
  INVALID_MESSAGE: "Enter a question between 1 and 2,000 characters.",
  UNAVAILABLE:
    "The AI Tutor is not available for this class right now. Try again later.",
};

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ enrolmentId: string }>;
  searchParams?: Promise<{ tutorNotice?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { enrolmentId } = await params;
  const { tutorNotice } = (await searchParams) ?? {};
  const notice = tutorNotice ? TUTOR_NOTICE_TEXT[tutorNotice] : undefined;
  const [workspace, week] = await Promise.all([
    getMyCourseWorkspace(enrolmentId).catch(() => null),
    getMyLearnerWeek().catch(() => null),
  ]);
  // The practical's evidence: the submitted record, or the learner's own
  // uploads not yet attached (so an abandoned form resumes). A read failure
  // shows no form rather than an empty one that could mislead.
  const lab = workspace?.lab ?? null;
  const labEvidence = lab
    ? await Promise.all([
        getMyLabEvidence(enrolmentId, lab.ref),
        listMyUnattachedLabFiles(enrolmentId),
      ]).catch(() => null)
    : null;
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      {notice && (
        <p className="ln-feedback is-error" role="alert">
          {notice}
        </p>
      )}
      <CourseWorkspaceView
        workspace={workspace}
        serverTime={week?.serverTime ?? new Date().toISOString()}
        timeZone={week?.timezone}
        checkInAction={checkInMyClassAction}
        enterClassAction={enterAcademyClassAction}
        openTutorAction={openMyTutorAction}
        startAssessmentAction={startAssessmentAction}
        attendLabAction={openLabSupportAction}
        labEvidenceSlot={
          lab && workspace && labEvidence ? (
            <LabEvidenceForm
              key={lab.itemId}
              enrolmentId={enrolmentId}
              labRef={lab.ref}
              canSubmit={
                lab.state !== "UPCOMING" && !workspace.course.accessRevoked
              }
              alreadySubmitted={lab.submitted}
              evidence={labEvidence[0]}
              unattached={labEvidence[1]}
              timeZone={week?.timezone}
              uploadAction={uploadLabEvidenceFileAction}
              removeAction={removeLabEvidenceFileAction}
              submitAction={submitLabEvidenceAction}
            />
          ) : null
        }
      />
    </AcademyShell>
  );
}
