import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import { getCourseActivationOptions } from "@/server/course-activation";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { CourseActivationForm } from "@/components/course-activation-form";
import { Card } from "@/components/ui";
import Link from "next/link";
// Rendered per request: the role guard must see the signed-in session.
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ importId?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Course activation"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const { importId } = await searchParams;
  const options = await getCourseActivationOptions(importId ?? null).catch(
    () => null,
  );
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Activation"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <h2>Activate course delivery</h2>
        <p>
          <Link className="text-link" href="/admin/course-engineering">
            Course &amp; Agent Engineering
          </Link>{" "}
          → Activation →{" "}
          <Link className="text-link" href="/admin/commerce">
            Commercial offers
          </Link>
        </p>
        <p>
          Choose a published package and its target cohort. This creates
          practicals, assignments and controlled assessments.
        </p>
        {!options ? (
          <p role="alert">
            Activation options are unavailable. Check access and the selected
            package.
          </p>
        ) : (
          <>
            <form method="get">
              <label>
                Published package
                <select name="importId" defaultValue={importId ?? ""} required>
                  <option value="">Select a package</option>
                  {options.packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.key} · revision {p.revision}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button secondary">
                Load matching cohorts and schedules
              </button>
            </form>
            {!options.packages.length && (
              <p>No applied, published packages are available.</p>
            )}
            {importId && (
              <CourseActivationForm
                key={importId}
                options={options}
                importId={importId}
              />
            )}
          </>
        )}
      </Card>
    </StaffShell>
  );
}
