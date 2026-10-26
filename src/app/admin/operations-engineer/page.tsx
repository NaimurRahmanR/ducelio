import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import { courseEngineeringAccess } from "@/server/course-organisations";
import { COURSE_ADMIN_ROLES } from "@/server/admin-access";
import {
  getOperationOptions,
  operationsEngineerConfigured,
} from "@/server/operations-engineer";
import { Panel, Pill } from "@/components/admin-ui";
import { OperationsEngineerConsole } from "@/components/operations-engineer-console";
import {
  OPERATION_ACTIONS,
  operationActionIdSchema,
} from "@/domain/operations-engineer";

export const dynamic = "force-dynamic";

// Field values that contextual links may prefill. They are only defaults in
// the form; the server re-validates everything.
const PREFILL = ["packageId", "couponId", "organisationId", "slug", "code"];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await courseEngineeringAccess();
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="operations"
        title="Operations Engineer"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const params = await searchParams;
  const action = operationActionIdSchema.safeParse(params.action);
  const initialValues = Object.fromEntries(
    PREFILL.filter((k) => typeof params[k] === "string").map((k) => [
      k,
      String(params[k]).slice(0, 200),
    ]),
  );
  const options = await getOperationOptions();
  const aiConfigured = operationsEngineerConfigured();

  return (
    <AdminShell
      active="operations"
      name={actor.displayName}
      roles={actor.roles}
      title="Operations Engineer"
      description="Inspect courses, sales and coupons, and prepare governed changes. Nothing changes until you review the exact proposal and confirm it."
      actions={
        aiConfigured ? (
          <Pill tone="good">AI interpretation configured</Pill>
        ) : (
          <Pill tone="warn">AI interpretation not configured</Pill>
        )
      }
    >
      <OperationsEngineerConsole
        options={options}
        aiConfigured={aiConfigured}
        initialAction={action.success ? action.data : undefined}
        initialValues={initialValues}
      />
      <Panel
        id="boundaries"
        title="What the Operations Engineer can and cannot do"
      >
        <div className="ac-grid-2 oe-boundaries">
          <div>
            <h3>Can</h3>
            <ul>
              {Object.values(OPERATION_ACTIONS).map((a) => (
                <li key={a.id}>
                  {a.title}
                  {a.kind === "READ" ? " (read-only)" : ""}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Cannot</h3>
            <ul>
              <li>Run SQL or shell commands, or read secrets</li>
              <li>Act without your confirmation, or under its own authority</li>
              <li>
                Approve or resolve academic decisions: those need an authorised
                reviewer and evidence in Course academic review
              </li>
              <li>Refund payments, change grades, enrolments or attendance</li>
              <li>See or act on another organisation&apos;s records</li>
              <li>Deploy, merge or change configuration</li>
            </ul>
            <p className="ac-muted">
              Every change runs through the same governed service as its
              workspace form, as you, with its own database checks and audit
              record.
            </p>
          </div>
        </div>
      </Panel>
    </AdminShell>
  );
}
