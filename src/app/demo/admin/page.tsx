import { StaffShell, adminSections } from "@/components/staff-shell";
import { AdminWorkspace } from "@/components/admin-workspace";
import { demo } from "@/demo/academy";
import { notFound } from "next/navigation";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const params = await searchParams;
  const section = adminSections.find(
    (s) => s.toLowerCase() === (params.section ?? "overview"),
  );
  if (!section) notFound();
  return (
    <StaffShell
      kind="admin"
      demo
      name="Administration preview"
      section={section}
    >
      <AdminWorkspace
        section={section}
        counts={[1, 2, 1, 1]}
        programmes={[
          {
            id: "demo",
            title: demo.programme.title,
            examination_body: "ISC2",
            is_demo: true,
          },
        ]}
        audit={[]}
        canAudit
        demo
      />
    </StaffShell>
  );
}
