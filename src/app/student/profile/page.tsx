import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseProgression,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import type { LearnerCourse } from "@/domain/learner-contract";
import { AcademyShell } from "@/components/academy-shell";
import { ProfileFormView } from "@/components/learner/profile-form";
// INTEGRATION: Lane C's profile read and server actions.
import { getMyLearnerProfile } from "@/server/learner-profile";
import {
  removeMyProfilePhotoAction,
  requestMyEmailChangeAction,
  saveMyProfileAction,
  uploadMyProfilePhotoAction,
} from "@/app/student/profile/actions";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const [profile, courses] = await Promise.all([
    getMyLearnerProfile().catch(() => null),
    listMyLearnerCourses().catch(() => []),
  ]);
  const enrolled = await Promise.all(
    courses.map(async (course: LearnerCourse) => ({
      course,
      completion: course.scheduled
        ? ((await getMyCourseProgression(course.enrolmentId).catch(() => null))
            ?.completion ?? null)
        : null,
    })),
  );
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <ProfileFormView
        profile={profile}
        enrolled={enrolled}
        saveProfileAction={saveMyProfileAction}
        uploadPhotoAction={uploadMyProfilePhotoAction}
        removePhotoAction={removeMyProfilePhotoAction}
        requestEmailChangeAction={requestMyEmailChangeAction}
      />
    </AcademyShell>
  );
}
