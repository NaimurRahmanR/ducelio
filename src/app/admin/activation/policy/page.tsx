import { requireAnyRole } from "@/server/identity";
import { getCommercialV1PolicySetupOptions } from "@/server/commercial-v1-assessment-policy";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Card, Badge } from "@/components/ui";
import {
  BindComponentForm,
  PublishGradingPolicyForm,
  SetLabPolicyForm,
  PublishResultPolicyForm,
} from "@/components/policy-setup-forms";

// Independent-review Finding 2: the smallest usable admin surface driving
// the four existing, already-governed policy Server Actions
// (src/app/admin/activation/policy-actions.ts) from an activation's own
// real, materialised assessments/practicals -- never a blind-typed internal
// UUID for those. The activation itself is still identified by id here
// (typed once, exactly like `importId` on /admin/activation already is);
// building a full activation picker is a materially larger, unrelated
// product surface (the existing activation flow does not itself surface a
// new activation's id anywhere yet) and is out of this correction
// checkpoint's scope -- see docs/implementation-progress.md.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ activationId?: string }>;
}) {
  const actor = await requireAnyRole(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"]);
  const { activationId } = await searchParams;
  const options = activationId
    ? await getCommercialV1PolicySetupOptions(activationId).catch(() => null)
    : null;
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Programmes"
      sections={adminSectionsForRoles(actor.roles)}
    >
      <Card>
        <h2>Commercial V1 policy setup</h2>
        <form method="get">
          <label>
            Activation ID
            <input
              name="activationId"
              defaultValue={activationId ?? ""}
              required
              pattern="[0-9a-fA-F-]{36}"
            />
          </label>
          <button className="button secondary">Load</button>
        </form>
        {activationId && !options && (
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
