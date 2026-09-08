import { StaffShell, adminSections } from "@/components/staff-shell";
import { AdminWorkspace } from "@/components/admin-workspace";
import { ProgrammePublication } from "@/components/programme-publication";
import { EnrolmentWorkspace } from "@/components/enrolment-workspace";
import { getAdminOverview } from "@/server/staff";
import { getProgrammeVersions } from "@/server/programmes";
import { getEnrolmentWorkspace } from "@/server/enrolments";
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
    </StaffShell>
  );
}
