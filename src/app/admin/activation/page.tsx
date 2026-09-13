import { requireAnyRole } from "@/server/identity";
import { getCourseActivationOptions } from "@/server/course-activation";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { CourseActivationForm } from "@/components/course-activation-form";
import { Card } from "@/components/ui";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ importId?: string }>;
}) {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const { importId } = await searchParams;
  const options = await getCourseActivationOptions(importId ?? null).catch(
    () => null,
  );
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Programmes"
      sections={adminSectionsForRoles(actor.roles)}
    >
      <Card>
        <h2>Activate course delivery</h2>
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
