import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import Link from "next/link";
import { getCohortWorkspace } from "@/server/cohorts";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import {
  CohortStatusForm,
  CreateCohortForm,
  EditCohortForm,
} from "@/components/admin-cohort-forms";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { CohortStatus } from "@/domain/admin-control-plane";

export const dynamic = "force-dynamic";

const statusTone: Record<CohortStatus, "green" | "gold" | "muted"> = {
  OPEN: "green",
  CLOSED: "gold",
  COMPLETED: "muted",
};
const statusLabel: Record<CohortStatus, string> = {
  OPEN: "Open",
  CLOSED: "Closed",
  COMPLETED: "Completed",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Cohorts"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const { cohort: selectedId } = await searchParams;
  const { actor, workspace, roster } = await getCohortWorkspace(selectedId);
  const selected = workspace.cohorts.find((c) => c.id === selectedId) ?? null;
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Cohorts"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">COHORTS</p>
            <h2>Create a cohort</h2>
          </div>
          <Badge tone="muted">GOVERNED · AUDITED</Badge>
        </div>
        <p>
          A cohort is one intake of a published programme version. Its learners
          stay tied to that exact version. After creating it, activate course
          delivery for it and publish its commercial offer.
        </p>
        <CreateCohortForm versions={workspace.versions} />
      </Card>

      <Card>
        <h2>Cohort register</h2>
        {workspace.cohorts.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Programme · version</th>
                  <th>Dates</th>
                  <th>Seats</th>
                  <th>Status</th>
                  <th>Delivery &amp; offer</th>
                  <th>Roster</th>
                </tr>
              </thead>
              <tbody>
                {workspace.cohorts.map((c) => {
                  const seated = c.enrolments.active + c.enrolments.paused;
                  return (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.title}</strong>
                        {c.isDemo && (
                          <div>
                            <Badge tone="gold">Demo</Badge>
                          </div>
                        )}
                      </td>
                      <td>
                        {c.programmeTitle}
                        <div className="muted">{c.versionLabel}</div>
                      </td>
                      <td>
                        {c.startsOn}
                        {c.endsOn ? ` → ${c.endsOn}` : ""}
                      </td>
                      <td>
                        {seated + c.enrolments.completed}
                        {c.capacity ? ` / ${c.capacity}` : ""}
                        {c.enrolments.withdrawn > 0 && (
                          <div className="muted">
                            {c.enrolments.withdrawn} withdrawn
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={statusTone[c.status]}>
                          {statusLabel[c.status]}
                        </Badge>
                      </td>
                      <td>
                        {c.activationId ? "Activated" : "Not activated"}
                        <div className="muted">
                          {c.publishedOfferSlug
                            ? `Offer: ${c.publishedOfferSlug}`
                            : "No published offer"}
                        </div>
                      </td>
                      <td>
                        <Link
                          className="text-link"
                          href={`/admin/cohorts?cohort=${c.id}`}
                          aria-current={
                            c.id === selectedId ? "true" : undefined
                          }
                        >
                          View roster
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No cohorts yet">
            Create the first cohort for a published programme version above.
          </EmptyState>
        )}
      </Card>

      {selectedId && !selected && (
        <Card>
          <p className="notice error" role="alert">
            That cohort could not be found.
          </p>
        </Card>
      )}

      {selected && (
        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">COHORT</p>
              <h2>{selected.title}</h2>
            </div>
            <Badge tone={statusTone[selected.status]}>
              {statusLabel[selected.status]}
            </Badge>
          </div>
          <p className="muted">
            {selected.programmeTitle} · {selected.versionLabel}
          </p>
          <h3>Roster</h3>
          {!roster ? (
            <p className="notice error" role="alert">
              The roster could not be loaded. Nothing was changed; try again.
            </p>
          ) : roster.enrolments.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Learner</th>
                    <th>Student number</th>
                    <th>Enrolment status</th>
                    <th>Enrolled (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.enrolments.map((e) => (
                    <tr key={e.enrolmentId}>
                      <td>{e.displayName}</td>
                      <td>{e.studentNumber}</td>
                      <td>{e.status}</td>
                      <td>{e.enrolledAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {roster.total > roster.enrolments.length && (
                <p className="muted">
                  Showing the first {roster.enrolments.length} of {roster.total}{" "}
                  enrolments.
                </p>
              )}
            </div>
          ) : (
            <EmptyState title="No learners enrolled">
              Learners appear here once they buy the cohort&apos;s offer or are
              enrolled from Students.
            </EmptyState>
          )}
          {selected.status === "COMPLETED" ? (
            <p className="muted">
              This cohort is completed. Its details and lifecycle are frozen;
              learner records are preserved.
            </p>
          ) : (
            <div className="admin-person-controls">
              <EditCohortForm key={`edit-${selected.id}`} cohort={selected} />
              <CohortStatusForm
                key={`status-${selected.id}-${selected.status}`}
                cohort={selected}
              />
            </div>
          )}
        </Card>
      )}
    </StaffShell>
  );
}
