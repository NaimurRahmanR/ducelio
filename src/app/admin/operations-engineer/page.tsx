import Link from "next/link";
import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import { AcademyUploadForm } from "@/components/academy-course-engineering-forms";
import { UnifiedOperationsConsole } from "@/components/unified-operations-console";
import { Panel } from "@/components/admin-ui";
import { COURSE_ADMIN_ROLES } from "@/server/admin-access";
import { courseEngineeringAccess } from "@/server/course-organisations";

export const dynamic = "force-dynamic";
export default async function Page() {
  const access = await courseEngineeringAccess();
  const canOperate =
    access.organisations.some((o) => o.canManage) ||
    access.actor.roles.some(
      (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
    );
  if (!access.allowed || !canOperate)
    return (
      <AdminForbidden
        actor={access.actor}
        active="operations"
        title="Operations Engineer"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  return (
    <AdminShell
      active="operations"
      name={access.actor.displayName}
      roles={access.actor.roles}
      title="Operations Engineer"
      description="Inspect unified courses, orders and coupons. Review and confirm each supported change."
    >
      <UnifiedOperationsConsole />
      <Panel title="Upload a new course package">
        <p>
          Uploads use the same validated, organisation-scoped Course Engineering
          pipeline. This does not publish the course or override academic review.
        </p>
        <AcademyUploadForm organisations={access.organisations} />
      </Panel>
      <Panel title="Other governed workflows">
        <p>
          <Link className="ac-link" href="/admin/academic-review">
            Academic course review
          </Link>
          {" · "}
          <Link className="ac-link" href="/admin/course-engineering">
            Course Engineering and publication
          </Link>
          {" · "}
          <Link className="ac-link" href="/admin/course-engineering/coupons">
            Coupon management
          </Link>
          {" · "}
          <Link className="ac-link" href="/admin/sales">
            Commerce history
          </Link>
        </p>
        <p>
          Natural-language AI interpretation and additional write operations
          require separate reviewed integration with the new tenant authorities.
          The retired legacy cohort and commercial mutation paths are not restored.
        </p>
      </Panel>
    </AdminShell>
  );
}
