import { getPeopleWorkspace } from "@/server/people";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { PersonControls } from "@/components/admin-people-forms";
import { Badge, Card, EmptyState } from "@/components/ui";
import {
  staffRoleLabels,
  type PeopleAuditKind,
  type StaffRole,
} from "@/domain/admin-control-plane";

export const dynamic = "force-dynamic";

const auditLabels: Record<PeopleAuditKind, string> = {
  ROLE_GRANTED: "Role granted",
  ROLE_REVOKED: "Role revoked",
  STAFF_PROFILE_CREATED: "Staff profile created",
  STAFF_PROFILE_UPDATED: "Staff title changed",
  ACCOUNT_DEACTIVATED: "Account deactivated",
  ACCOUNT_REACTIVATED: "Account reactivated",
};

function roleName(role: string) {
  return role === "STUDENT"
    ? "Student"
    : (staffRoleLabels[role as StaffRole] ?? role);
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { actor, query, directory, audit } = await getPeopleWorkspace(q);
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="People"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">PEOPLE &amp; STAFF</p>
            <h2>Staff accounts and roles</h2>
          </div>
          <Badge tone="muted">PLATFORM ADMIN · AUDITED</Badge>
        </div>
        <p>
          People create their own Ducelio account by signing up. Find an
          existing account here, give it a staff profile, then grant the staff
          roles it needs. Accounts are never created from this page.
        </p>
        <p className="muted">
          Usable platform administrators: {directory.usablePlatformAdmins}. The
          last usable platform administrator can never be revoked or
          deactivated, and nobody can remove their own administration.
        </p>
        <form method="get" className="support-form" role="search">
          <div className="field">
            <label htmlFor="people-search">
              Find by exact email address or part of a display name
            </label>
            <input
              id="people-search"
              name="q"
              maxLength={100}
              defaultValue={query}
              placeholder="name@example.com"
            />
          </div>
          <button className="button secondary">Search</button>
        </form>
      </Card>

      <Card>
        <h2>
          {query ? `Accounts matching “${query}”` : "Current staff accounts"}
        </h2>
        {directory.people.length ? (
          <div className="admin-people-list">
            {directory.people.map((person) => (
              <details key={person.id} className="admin-person">
                <summary>
                  <strong>{person.displayName}</strong>
                  {person.id === actor.id && (
                    <Badge tone="gold">You</Badge>
                  )}{" "}
                  <Badge
                    tone={person.accountStatus === "ACTIVE" ? "green" : "muted"}
                  >
                    {person.accountStatus === "ACTIVE"
                      ? "Active"
                      : "Deactivated"}
                  </Badge>{" "}
                  <span className="muted">
                    {person.email ?? "No email"}
                    {person.emailConfirmed ? "" : " · email not confirmed"}
                  </span>
                  <div className="muted">
                    {person.staffTitle ?? "No staff profile"} ·{" "}
                    {person.roles.length
                      ? person.roles.map(roleName).join(", ")
                      : "No roles"}
                    {person.liveTeaching > 0 &&
                      ` · ${person.liveTeaching} live teaching`}
                    {person.activeCounselling > 0 &&
                      ` · ${person.activeCounselling} assigned learners`}
                  </div>
                </summary>
                <PersonControls
                  person={person}
                  isSelf={person.id === actor.id}
                />
              </details>
            ))}
          </div>
        ) : (
          <EmptyState title={query ? "No matching account" : "No staff yet"}>
            {query
              ? "Nobody with that email or name has signed up. Ask them to create a Ducelio account first, then search again."
              : "Search for an existing account to appoint staff."}
          </EmptyState>
        )}
      </Card>

      <Card>
        <div className="section-heading">
          <h2>Recent people administration</h2>
          <Badge tone="muted">AUDIT</Badge>
        </div>
        {audit.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Account</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th>When (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {auditLabels[entry.kind]}
                      {entry.role ? ` · ${roleName(entry.role)}` : ""}
                    </td>
                    <td>{entry.targetName}</td>
                    <td>{entry.actorName}</td>
                    <td>{entry.reason}</td>
                    <td>{entry.occurredAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No people changes recorded">
            Staff profile, role and account-status changes appear here.
          </EmptyState>
        )}
      </Card>
    </StaffShell>
  );
}
