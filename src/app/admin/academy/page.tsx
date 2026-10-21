import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminOverview } from "@/server/staff";
import { adminSectionsForRoles } from "@/components/staff-shell";
import { AdminShell } from "@/components/admin-shell";
import {
  AcademyRecords,
  type AcademyRecordsParams,
} from "@/components/academy-records";
import {
  LinkTabs,
  Panel,
  Pill,
  StatCard,
  DataTable,
} from "@/components/admin-ui";
import {
  describeProductionProfiles,
  providerCredentialReadiness,
} from "@/server/agent-control-plane";
import { ACADEMY_TABS, tabForSection } from "@/domain/admin-academy-tabs";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<AcademyRecordsParams & { tab?: string }>;
}) {
  const data = await getAdminOverview();
  const params = await searchParams;
  const roles = data.actor.roles;
  const allowed = adminSectionsForRoles(roles);
  const tab =
    ACADEMY_TABS.find((t) => t.id === params.tab) ??
    ACADEMY_TABS.find((t) => t.id === tabForSection(params.section ?? "")) ??
    ACADEMY_TABS[0];
  const sections = tab.sections.filter((s) =>
    (allowed as readonly string[]).includes(s),
  );
  const requested = params.section?.toLowerCase();
  const section = requested
    ? sections.find((s) => s.toLowerCase() === requested)
    : sections[0];
  if (requested && !section) notFound();
  const courseAdmin = roles.some(
    (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
  );
  const links = tab.links.filter((l) => l.roles.some((r) => roles.includes(r)));

  return (
    <AdminShell
      active="academy"
      name={data.actor.displayName}
      roles={roles}
      title="Academy Operations"
      description="Learners, assessment, teaching, AI agents and staff, through the academy's existing governed workspaces."
    >
      <LinkTabs
        label="Academy operations areas"
        active={tab.id}
        tabs={ACADEMY_TABS.map((t) => ({
          id: t.id,
          label: t.label,
          href: `/admin/academy?tab=${t.id}`,
        }))}
      />
      <p className="ac-tab-intro">{tab.intro}</p>

      {(sections.length > 1 || links.length > 0) && (
        <div className="ac-subnav">
          {sections.length > 1 && (
            <nav aria-label={`${tab.label} workspaces`} className="ac-chips">
              {sections.map((s) => (
                <Link
                  key={s}
                  href={`/admin/academy?tab=${tab.id}&section=${s.toLowerCase()}`}
                  className={s === section ? "ac-chip active" : "ac-chip"}
                  aria-current={s === section ? "page" : undefined}
                >
                  {s}
                </Link>
              ))}
            </nav>
          )}
        </div>
      )}

      {links.length > 0 && (
        <div className="ac-link-grid">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="ac-link-card">
              <strong>{l.label} →</strong>
              <span>{l.description}</span>
            </Link>
          ))}
        </div>
      )}

      {tab.id === "agents" &&
        (courseAdmin ? (
          <AgentHealth />
        ) : (
          <Panel>
            <p className="ac-muted">
              AI agent settings and runtime health are available to academic and
              platform administrators.
            </p>
          </Panel>
        ))}

      {tab.id === "permissions" && (
        <div className="ac-stat-grid">
          <StatCard label="Staff profiles" value={data.counts[3]} />
          <StatCard label="Learner profiles" value={data.counts[1]} />
          {!roles.includes("PLATFORM_ADMIN") && (
            <p className="ac-muted">
              Role and account management requires the platform administrator
              role.
            </p>
          )}
        </div>
      )}

      {tab.id === "organisations" && (
        <Panel title="Organisation administration is not available yet">
          <p>
            Ducelio does not yet record which organisation owns a course,
            cohort, learner or staff account, and the database has no
            organisation-level permission boundary. Managing organisations here
            would therefore not be isolated from other organisations, so no
            organisation controls are offered.
          </p>
          <p className="ac-muted">
            Required first: an organisation table, ownership columns on
            programmes and cohorts, organisation-scoped staff roles, and
            row-level security policies that enforce them. All staff today act
            for the whole academy.
          </p>
        </Panel>
      )}

      {section && (
        <div className="ac-records">
          <AcademyRecords section={section} params={params} data={data} />
        </div>
      )}
      {!section && tab.sections.length > 0 && sections.length === 0 && (
        <Panel>
          <p className="ac-muted">
            Your roles do not include the workspaces in this area.
          </p>
        </Panel>
      )}
    </AdminShell>
  );
}

function AgentHealth() {
  const profiles = describeProductionProfiles(providerCredentialReadiness());
  return (
    <Panel
      title="AI runtime profiles"
      description="Configured means the provider key is present in this deployment. It does not prove a live call succeeded."
    >
      <DataTable
        caption="AI runtime profiles and credential status"
        columns={["Profile", "Used by", "Model", "Status"]}
        rows={profiles.map((p) => [
          <span key="ref" className="ac-strong">
            {p.ref}
          </span>,
          p.roles.join(", "),
          p.model ?? "—",
          p.readiness === "CREDENTIAL_PRESENT" ? (
            <Pill key="s" tone="good">
              Configured
            </Pill>
          ) : (
            <Pill key="s" tone="warn">
              Not configured
            </Pill>
          ),
        ])}
      />
    </Panel>
  );
}
