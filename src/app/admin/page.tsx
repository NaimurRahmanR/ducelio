import { StaffShell, adminSections } from "@/components/staff-shell";
import { AdminWorkspace } from "@/components/admin-workspace";
import { ProgrammePublication } from "@/components/programme-publication";
import { EnrolmentWorkspace } from "@/components/enrolment-workspace";
import { CounsellorAssignmentWorkspace } from "@/components/counsellor-assignment-workspace";
import { ClassSessionWorkspace } from "@/components/class-session-workspace";
import { AttendanceWorkspace } from "@/components/attendance-workspace";
import { getAdminOverview } from "@/server/staff";
import { getProgrammeVersions } from "@/server/programmes";
import { getEnrolmentWorkspace } from "@/server/enrolments";
import { getCounsellorAssignmentWorkspace } from "@/server/counsellor-assignments";
import { getClassSessionWorkspace } from "@/server/class-sessions";
import { getAttendanceWorkspace } from "@/server/attendance";
import { notFound } from "next/navigation";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const data = await getAdminOverview();
  const params = await searchParams;
  const section = adminSections.find(
    (s) => s.toLowerCase() === (params.section ?? "overview"),
  );
  if (!section) notFound();

  const versions = section === "Programmes" ? await getProgrammeVersions() : [];
  const enrolmentWorkspace =
    section === "Students" ? await getEnrolmentWorkspace() : null;
  const counsellorWorkspace =
    section === "Counsellors" ? await getCounsellorAssignmentWorkspace() : null;
  const classSessionWorkspace =
    section === "Sessions" ? await getClassSessionWorkspace() : null;
  const attendanceWorkspace =
    section === "Sessions" ? await getAttendanceWorkspace() : null;
  const canPublish = data.actor.roles.some(
    (role) => role === "ACADEMIC_ADMIN" || role === "PLATFORM_ADMIN",
  );

  return (
    <StaffShell kind="admin" name={data.actor.displayName} section={section}>
      <AdminWorkspace
        section={section}
        counts={data.counts}
        programmes={data.programmes}
        audit={data.audit}
        canAudit={data.actor.roles.includes("PLATFORM_ADMIN")}
      />
      {section === "Programmes" && (
        <ProgrammePublication versions={versions} canPublish={canPublish} />
      )}
      {section === "Students" && enrolmentWorkspace && (
        <EnrolmentWorkspace
          learners={enrolmentWorkspace.learners}
          cohorts={enrolmentWorkspace.cohorts}
          enrolments={enrolmentWorkspace.enrolments}
        />
      )}
      {section === "Counsellors" && counsellorWorkspace && (
        <CounsellorAssignmentWorkspace
          learners={counsellorWorkspace.learners}
          counsellors={counsellorWorkspace.counsellors}
          assignments={counsellorWorkspace.assignments}
        />
      )}
      {section === "Sessions" && classSessionWorkspace && (
        <ClassSessionWorkspace
          cohorts={classSessionWorkspace.cohorts}
          lessons={classSessionWorkspace.lessons}
          instructors={classSessionWorkspace.instructors}
          sessions={classSessionWorkspace.sessions}
        />
      )}
      {section === "Sessions" && attendanceWorkspace && (
        <AttendanceWorkspace
          sessions={attendanceWorkspace.sessions}
          enrolments={attendanceWorkspace.enrolments}
          attendance={attendanceWorkspace.attendance}
        />
      )}
    </StaffShell>
  );
}
