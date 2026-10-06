import Link from "next/link";
import {
  getAgentControlPlane,
  parseAgentControlCursor,
  type ProfileView,
  type VersionView,
} from "@/server/agent-control-plane";
import { StaffShell, adminSectionsForRoles } from "@/components/staff-shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import {
  EVIDENCE_LEVELS,
  type ConfigurationState,
  type CredentialReadiness,
  type EvidenceLevel,
  type ResolvedEvidenceStatus,
} from "@/domain/agent-control-plane";

export const dynamic = "force-dynamic";

// AGENT-CONTROL-1: read-only operator view of every academic and platform
// AI role. CONFIGURED, READY, TESTED and PRODUCTION-PROVEN are shown as four
// separate facts and are never combined into one "healthy" status. This
// page has no form, no Server Action and no mutation; it never calls a
// provider and never renders anything derived from a credential value.
type Params = Record<string, string | string[] | undefined>;

const credentialLabel: Record<string, string> = {
  OPENAI_API_KEY: "OPENAI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  ACADEMIC_PROVIDER_LEGACY:
    "ACADEMIC_PROVIDER_* (legacy generic HTTP_JSON gateway)",
};
const credentialText: Record<CredentialReadiness, string> = {
  PRESENT: "PRESENT — a value is set on the server (validity not checked)",
  ABSENT: "ABSENT — profiles needing it fail closed",
  NOT_USED: "NOT_USED — no current production profile uses it",
};
const evidenceLevelLabel: Record<EvidenceLevel, string> = {
  LOCAL_DETERMINISTIC: "Local / deterministic",
  HOSTED: "Hosted",
  LIVE_PROVIDER: "Live provider",
};
const evidenceTone: Record<
  ResolvedEvidenceStatus,
  "green" | "gold" | "muted" | "blue"
> = {
  RECORDED: "green",
  PARTIAL: "gold",
  NONE: "muted",
  NOT_CURRENT: "gold",
};
const configurationText: Record<ConfigurationState, string> = {
  NOT_CONFIGURED: "NOT CONFIGURED (fails closed as disabled)",
  DISABLED: "DISABLED",
  ENABLED: "ENABLED",
  INVALID: "INVALID",
};

function money(microusd: number) {
  return `${microusd.toLocaleString("en-GB")} µUSD`;
}

function ProfileCard({ profile }: { profile: ProfileView }) {
  return (
    <article className="engineering-role" aria-labelledby={`p-${profile.ref}`}>
      <h3 id={`p-${profile.ref}`}>
        <code>{profile.ref}</code>
      </h3>
      <dl className="detail-list">
        <dt>Used by</dt>
        <dd>{profile.roles.join("; ")}</dd>
        <dt>Adapter</dt>
        <dd>{profile.adapterKind}</dd>
        <dt>Model</dt>
        <dd>
          <code>{profile.model ?? "—"}</code>
        </dd>
        <dt>Reasoning</dt>
        <dd>{profile.reasoningEffort ?? "Not sent by this adapter"}</dd>
        <dt>Reviewed budget</dt>
        <dd>
          {profile.budget.maxProviderCalls} call · {profile.budget.maxAttempts}{" "}
          attempt ·{" "}
          {profile.budget.maxInputContextBytes.toLocaleString("en-GB")} context
          bytes · {profile.budget.maxOutputTokens} output tokens ·{" "}
          {profile.budget.totalDeadlineMs / 1000}s ·{" "}
          {money(profile.budget.maxEstimatedCostMicrousd)}
        </dd>
        <dt>Database ceiling</dt>
        <dd>
          {profile.dbCeiling
            ? `${profile.dbCeiling.maxProviderCalls} call · ${profile.dbCeiling.maxOutputTokens} output tokens · ${money(profile.dbCeiling.maxEstimatedCostMicrousd)}`
            : "None: no governed execution plane"}
        </dd>
        {profile.tariff && (
          <>
            <dt>Reviewed tariff</dt>
            <dd>
              {money(profile.tariff.inputMicrousdPerMillionTokens)} input /{" "}
              {money(profile.tariff.outputMicrousdPerMillionTokens)} output per
              million tokens (reviewed {profile.tariff.reviewedAt})
            </dd>
          </>
        )}
        <dt>READY</dt>
        <dd>
          <Badge
            tone={profile.readiness === "CREDENTIAL_PRESENT" ? "blue" : "muted"}
          >
            {profile.readiness === "CREDENTIAL_PRESENT"
              ? "CREDENTIAL PRESENT"
              : "CREDENTIAL ABSENT"}
          </Badge>{" "}
          {profile.credential ?? "No credential"}. Presence is not validity.
        </dd>
        <dt>TESTED</dt>
        <dd>
          <ul>
            {EVIDENCE_LEVELS.map((level) => (
              <li key={level}>
                <strong>{evidenceLevelLabel[level]}:</strong>{" "}
                <Badge
                  tone={evidenceTone[profile.evidence.levels[level].status]}
                >
                  {profile.evidence.levels[level].status.replace("_", " ")}
                </Badge>{" "}
                {profile.evidence.levels[level].scope}
              </li>
            ))}
          </ul>
          {profile.evidence.reviewedAt && (
            <p>Evidence reviewed {profile.evidence.reviewedAt}.</p>
          )}
        </dd>
        <dt>PRODUCTION-PROVEN</dt>
        <dd>
          <Badge tone="muted">NOT PROVEN</Badge> No role is production-proven.
        </dd>
        <dt>Profile fingerprint</dt>
        <dd>
          <code>{profile.fingerprint}</code>
        </dd>
      </dl>
    </article>
  );
}

function VersionTable({ version }: { version: VersionView }) {
  return (
    <details className="engineering-role">
      <summary>
        {version.programmeTitle} · {version.versionLabel} ·{" "}
        {version.versionStatus}
        {version.isDemo ? " · DEMO" : ""}
        {version.hasEnrolments ? " · learners enrolled" : ""}
        {version.semanticConfigFrozen
          ? " · academic configuration fixed"
          : " · editable draft"}
      </summary>
      <p>
        {version.semanticConfigFrozen
          ? "This version is published or has enrolments. Instructional notes, profile reference, capability widening and escalation policy are fixed. Only availability, capability narrowing and the Examiner move to academic review can change."
          : "This version is an unenrolled draft. Its configuration can still be changed in Course Engineering."}
      </p>
      {version.behaviourFingerprint ? (
        <p>
          Behaviour fingerprint (AGENT_BEHAVIOUR_FINGERPRINT_V1):{" "}
          <code>{version.behaviourFingerprint}</code>. It covers the actual
          effective behaviour values and pinned role behaviour version of every
          role and is{" "}
          {version.semanticConfigFrozen
            ? "fixed, because behaviour was frozen when this version was published."
            : "changed by any draft behaviour edit."}{" "}
          The course package publication fingerprint does not cover behaviour.
        </p>
      ) : (
        <p role="alert">
          This version&apos;s frozen behaviour binding is missing or does not
          verify, so no behaviour fingerprint exists and every Professor, Tutor
          and Lab Instructor execution for it is refused.
        </p>
      )}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">CONFIGURED</th>
              <th scope="col">Execution</th>
              <th scope="col">Runtime profile</th>
              <th scope="col">Capabilities</th>
              <th scope="col">Escalation</th>
              <th scope="col">Instructional notes</th>
              <th scope="col">Behaviour</th>
              <th scope="col">READY</th>
            </tr>
          </thead>
          <tbody>
            {version.roles.map((r) => (
              <tr key={r.role}>
                <th scope="row">{r.displayName}</th>
                <td>
                  <Badge
                    tone={
                      r.state === "ENABLED"
                        ? "green"
                        : r.state === "INVALID"
                          ? "gold"
                          : "muted"
                    }
                  >
                    {configurationText[r.state]}
                  </Badge>
                  {r.issues.map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                  {r.state === "ENABLED" &&
                    r.missingRequiredCapabilities.length > 0 && (
                      <p>
                        Enabled but cannot run: missing{" "}
                        {r.missingRequiredCapabilities.join(", ")}.
                      </p>
                    )}
                </td>
                <td>
                  {r.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}
                  <p>{r.executionDescription}</p>
                </td>
                <td>
                  {r.effectiveProfileRef ? (
                    <code>{r.effectiveProfileRef}</code>
                  ) : (
                    "None"
                  )}
                  {r.state !== "NOT_CONFIGURED" && (
                    <p>
                      Stored reference:{" "}
                      {r.storedProfileRef
                        ? r.storedProfileRef
                        : "none (role default)"}
                    </p>
                  )}
                </td>
                <td>
                  {r.effectiveCapabilities.length
                    ? r.effectiveCapabilities.join(", ")
                    : "None"}
                  {r.configuredCapabilities.length !==
                    r.effectiveCapabilities.length && (
                    <p>Configured: {r.configuredCapabilities.join(", ")}</p>
                  )}
                </td>
                <td>
                  {r.escalationPolicy ?? "—"}
                  <p>{r.escalationSemantics}</p>
                </td>
                <td>
                  {r.hasInstructionalNotes
                    ? "Stored but not used by the current runtime"
                    : "None"}
                </td>
                <td>
                  {r.behaviour && "summary" in r.behaviour ? (
                    <>
                      <code>{r.behaviour.behaviourVersion}</code>
                      <p>
                        {r.behaviour.source === "EXPLICIT"
                          ? `Programme configuration (${r.behaviour.configVersion})`
                          : `Versioned default (${r.behaviour.configVersion}): no programme configuration recorded`}
                        {r.behaviour.state === "BOUND"
                          ? " · frozen at publication"
                          : " · draft, not yet frozen"}
                      </p>
                      <p>{r.behaviour.summary}</p>
                      {r.behaviour.hasCourseContextNotes && (
                        <p>Course context notes stored (used as data)</p>
                      )}
                    </>
                  ) : r.behaviour ? (
                    <Badge tone="gold">
                      {r.behaviour.state === "BEHAVIOUR_BINDING_MISSING"
                        ? "Behaviour binding missing: execution refused"
                        : "Behaviour binding invalid: execution refused"}
                    </Badge>
                  ) : (
                    "Not applicable"
                  )}
                </td>
                <td>
                  {r.readiness === "NOT_APPLICABLE"
                    ? "Not applicable"
                    : r.readiness === "CREDENTIAL_PRESENT"
                      ? "Credential present"
                      : "Credential absent"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const cursor = parseAgentControlCursor(await searchParams);
  const { actor, plane } = await getAgentControlPlane(cursor);
  const next = plane.page.nextCursor;
  return (
    <StaffShell
      kind="admin"
      name={actor.displayName}
      section="Agents"
      sections={adminSectionsForRoles(actor.roles)}
      roles={actor.roles}
    >
      <Card>
        <div className="section-heading">
          <div>
            <p className="eyebrow">AGENT CONTROL PLANE</p>
            <h2>Agents and models</h2>
          </div>
          <Badge tone="muted">READ-ONLY · SERVER-OWNED PROFILES</Badge>
        </div>
        <p>
          Which AI role runs with which reviewed runtime profile, and what is
          actually known about it. Four separate facts are shown and never
          combined: <strong>CONFIGURED</strong> (stored programme
          configuration), <strong>READY</strong> (whether the server credential
          is present), <strong>TESTED</strong> (reviewed evidence for the exact
          profile) and <strong>PRODUCTION-PROVEN</strong> (not claimed for any
          role).
        </p>
        <p>
          Providers, models, budgets and tariffs are fixed in server code. No
          browser, course package or stored configuration can choose them, and
          nothing on this page changes them. Professor, Tutor and Lab Instructor
          follow the governed behaviour contract, keyed by role and never by
          model. Sarah Mitchell, the AI learner-success counsellor, runs on the
          separate platform COUNSELLOR plane (AC-5: learner guide and
          learner-confirmed support-profile proposals). Agent behaviour work is
          not complete: Sarah post-session feedback (AC-6) and course guidance
          (AC-7) are later checkpoints.
        </p>
      </Card>

      <Card>
        <h2>Provider credentials</h2>
        <p>
          Presence only. PRESENT means a value is set on the server; it does not
          mean the key is valid, funded or authorised. No provider is called to
          produce this page, and no part of any value is shown.
        </p>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Server credential</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(plane.credentials).map(([name, status]) => (
                <tr key={name}>
                  <th scope="row">{credentialLabel[name]}</th>
                  <td>{credentialText[status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2>Reviewed runtime profiles</h2>
        <p>
          Evidence is recorded against each profile&apos;s exact definition. If
          a profile&apos;s model, adapter, reasoning, tariff or budget changes,
          its evidence shows NOT CURRENT until it is re-reviewed.
        </p>
        {plane.profiles.map((profile) => (
          <ProfileCard key={profile.ref} profile={profile} />
        ))}
      </Card>

      <Card>
        <h2>Platform roles</h2>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Execution</th>
                <th scope="col">Runtime profile</th>
              </tr>
            </thead>
            <tbody>
              {plane.platformRoles.map((role) => (
                <tr key={role.role}>
                  <th scope="row">{role.displayName}</th>
                  <td>
                    {role.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}
                    <p>{role.executionDescription}</p>
                  </td>
                  <td>
                    <code>{role.profileRef}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2>Academic roles by programme version</h2>
        <p>
          Configuration is bound to a programme version. Published or enrolled
          versions keep their academic configuration; change it only through a
          new programme version. Instructional notes are listed as stored or
          not; their text is never shown here and is not used by the current
          runtime.
        </p>
        {plane.page.versions.length === 0 ? (
          <EmptyState title="No programme versions">
            There are no programme versions on this page.
          </EmptyState>
        ) : (
          plane.page.versions.map((version) => (
            <VersionTable key={version.programmeVersionId} version={version} />
          ))
        )}
        <nav aria-label="Programme version pages" className="pagination">
          {cursor && (
            <Link className="button secondary" href="/admin/agents">
              First page
            </Link>
          )}
          {plane.page.hasMore && next && (
            <Link
              className="button secondary"
              href={`/admin/agents?${new URLSearchParams({ after: next.createdAt, afterId: next.id }).toString()}`}
            >
              Next {plane.page.pageSize} versions
            </Link>
          )}
        </nav>
      </Card>
    </StaffShell>
  );
}
