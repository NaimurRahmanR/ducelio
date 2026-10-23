import Link from "next/link";
import { AdminShell, AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import {
  CommerceOperationsConsole,
  type CommerceSearchParams,
} from "@/components/commerce-operations-console";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<CommerceSearchParams>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="sales"
        title="Commerce history"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const history = await CommerceOperationsConsole({
    params: await searchParams,
    basePath: "/admin/sales",
  });
  return (
    <AdminShell
      active="sales"
      name={access.actor.displayName}
      roles={access.actor.roles}
      title="Commerce history"
      description="Preserved payment, refund and reconciliation evidence."
    >
      <p>
        New course prices and publication are managed in{" "}
        <Link href="/admin/course-engineering">Course Engineering</Link>. Create
        and report discounts through{" "}
        <Link href="/admin/course-engineering/coupons">course coupons</Link>.
      </p>
      {history}
    </AdminShell>
  );
}
