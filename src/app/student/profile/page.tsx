import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyCourseProgression,
  listMyLearnerCourses,
} from "@/server/learner-academics";
import type { LearnerCourse } from "@/domain/learner-contract";
import { AcademyShell } from "@/components/academy-shell";
import { LearnerRecords } from "@/components/learner/learner-records";
import { getMyCertificates } from "@/server/learner-certificates";
import { formatMoney, listMyPaymentReceipts } from "@/server/learner-receipts";
import { issueCertificateAction } from "@/app/student/_actions/certificate-actions";
import {
  ProfileFormView,
  type LearnerProfile,
} from "@/components/learner/profile-form";
// INTEGRATION: Lane C's profile read and server actions.
import {
  getMyLearnerProfile,
  getMyPendingEmailChange,
} from "@/server/learner-profile";
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
  const [stored, pendingEmail, courses, certificates, receipts] =
    await Promise.all([
      getMyLearnerProfile().catch(() => null),
      getMyPendingEmailChange().catch(() => null),
      listMyLearnerCourses().catch(() => []),
      getMyCertificates().catch(() => null),
      listMyPaymentReceipts().catch(() => null),
    ]);
  // The service's view carries raw RPC fields too; the form takes only its
  // own shape. A missing name falls back to the empty field, not a guess.
  const profile: LearnerProfile | null = stored && {
    firstName: stored.firstName ?? "",
    lastName: stored.lastName ?? "",
    email: stored.email ?? "",
    pendingEmail,
    photoUrl: stored.photoUrl,
    education: stored.education.map((e) => ({
      institution: e.institution,
      qualification: e.qualification,
      fieldOfStudy: e.fieldOfStudy ?? "",
      startDate: e.startDate,
      endDate: e.endDate,
      current: e.current,
    })),
    experience: stored.experience.map((e) => ({
      organisation: e.organisation,
      title: e.title,
      startDate: e.startDate,
      endDate: e.endDate,
      current: e.current,
    })),
  };
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
      <div className="ln-page">
        <LearnerRecords
          certificates={
            certificates?.certificates.map((c) => ({
              certificateId: c.certificateId,
              courseTitle: c.courseTitle,
              issuerName: c.issuerName,
              verificationCode: c.verificationCode,
              issuedAt: c.issuedAt,
              revoked: c.revoked,
            })) ?? null
          }
          eligible={certificates?.eligible ?? []}
          receipts={
            receipts?.map((r) => ({
              receiptId: r.receiptId,
              receiptNumber: r.receiptNumber,
              courseTitle: r.courseTitle,
              amount: formatMoney(r.amountMinor, r.currency),
              issuedAt: r.issuedAt,
              refunded: r.refund !== null,
            })) ?? null
          }
          issueCertificateAction={issueCertificateAction}
        />
      </div>
    </AcademyShell>
  );
}
