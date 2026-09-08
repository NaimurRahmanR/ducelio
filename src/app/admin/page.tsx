import { StaffShell, adminSections } from "@/components/staff-shell";
import { AdminWorkspace } from "@/components/admin-workspace";
import { getAdminOverview } from "@/server/staff";
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
  return (
    <StaffShell kind="admin" name={data.actor.displayName} section={section}>
      <AdminWorkspace
        section={section}
        counts={data.counts}
        programmes={data.programmes}
        audit={data.audit}
        canAudit={data.actor.roles.includes("PLATFORM_ADMIN")}
      />
    </StaffShell>
  );
}
