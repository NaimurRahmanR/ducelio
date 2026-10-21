import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import { listCommercialV1Activations } from "@/server/course-activation";
import { getCommercialV1PolicySetupOptions } from "@/server/commercial-v1-assessment-policy";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Card, Badge } from "@/components/ui";
import {
  BindComponentForm,
  PublishGradingPolicyForm,
  SetLabPolicyForm,
  PublishResultPolicyForm,
} from "@/components/policy-setup-forms";

// Independent-review operational-closure checkpoint (E1): the activation
// itself is now chosen from a real, server-owned <select> of Commercial V1
// activations (listCommercialV1Activations, migration 202609250042) --
// closing the one remaining manual-ID gap this checkpoint's own prior
// commit (docs/implementation-progress.md) documented honestly. An admin
// never types or pastes an activation UUID anywhere on this page; the
// selected activation's real id is carried as an opaque value in the GET
// query string, exactly like `importId` already works on /admin/activation.
// Rendered per request: the role guard must see the signed-in session.
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ activationId?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Grading and result policy setup"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const { activationId } = await searchParams;
  const { activations } = await listCommercialV1Activations().catch(() => ({
    activations: [],
  }));
  const selectedId = activationId ?? activations[0]?.activationId;
  const options = selectedId
    ? await getCommercialV1PolicySetupOptions(selectedId).catch(() => null)
    : null;
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Policy setup"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <h2>Commercial V1 policy setup</h2>
        {activations.length === 0 ? (
          <p role="alert">
            No activated Commercial V1 courses are available yet. Activate a
            course first.
          </p>
        ) : (
          <form method="get">
            <label>
              Activation
              <select name="activationId" defaultValue={selectedId} required>
                {activations.map((a) => (
                  <option key={a.activationId} value={a.activationId}>
                    {a.programmeTitle} · {a.packageKey} rev {a.packageRevision}{" "}
                    · {a.cohortTitle}
                    {a.resultPolicyPublished
                      ? " (result policy published)"
                      : a.gradingPolicyPublished
                        ? " (grading policy published)"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary">View policy setup</button>
          </form>
        )}
        {selectedId && !options && (
          <p role="alert">
            Policy setup options are unavailable for this activation.
          </p>
        )}
      </Card>
      {options && (
        <>
          <Card>
            <h3>Bind formal component</h3>
            <BindComponentForm
              activationId={options.activationId}
              options={options.assessments}
            />
            {options.componentBindings.length > 0 && (
              <ul>
                {options.componentBindings.map((b) => (
                  <li key={b.component}>
                    <Badge tone="muted">{b.component}</Badge>{" "}
                    {b.assessmentTitle}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h3>Publish grading policy</h3>
            <p>
              <Badge tone={options.gradingPolicyPublished ? "green" : "muted"}>
                {options.gradingPolicyPublished ? "Published" : "Not published"}
              </Badge>
            </p>
            {!options.gradingPolicyPublished && (
              <PublishGradingPolicyForm activationId={options.activationId} />
            )}
          </Card>
          <Card>
            <h3>Lab policy</h3>
            <SetLabPolicyForm
              activationId={options.activationId}
              options={options.practicals}
            />
          </Card>
          <Card>
            <h3>Publish result policy</h3>
            <p>
              <Badge tone={options.resultPolicyPublished ? "green" : "muted"}>
                {options.resultPolicyPublished ? "Published" : "Not published"}
              </Badge>
            </p>
            {!options.resultPolicyPublished && (
              <PublishResultPolicyForm activationId={options.activationId} />
            )}
          </Card>
        </>
      )}
    </StaffShell>
  );
}
