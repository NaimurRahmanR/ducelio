import Link from "next/link";
import { redirect } from "next/navigation";
import { Bot } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import {
  BarList,
  DataTable,
  Empty,
  Panel,
  Pill,
  StatCard,
  StatePill,
  Unavailable,
} from "@/components/admin-ui";
import { getDashboardData } from "@/server/admin-control-centre";
import { tabForSection } from "@/domain/admin-academy-tabs";
import {
  ACADEMY_STAGE_IDS,
  isPubliclyLive,
  ORGANISATION_STAGE_IDS,
  STAGE_LABELS,
} from "@/domain/admin-course-lifecycle";
import { TEST_RECORD_NOTE } from "@/domain/admin-test-records";

export const dynamic = "force-dynamic";

const STAGE_ORDER = [...ORGANISATION_STAGE_IDS, ...ACADEMY_STAGE_IDS];
const ACADEMY_STAGES = new Set<string>(ACADEMY_STAGE_IDS);

function words(action: string) {
  const text = action
    .replace(/^COMMERCIAL_V1_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function when(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(d) + " UTC";
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Compatibility: the former section workspaces now live in Academy
  // Operations. Every query parameter (filters, cursors) is preserved.
  const params = await searchParams;
  if (params.section && params.section.toLowerCase() !== "overview") {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) next.set(k, k === "section" ? v.toLowerCase() : v);
    next.set("tab", tabForSection(params.section));
    redirect(`/admin/academy?${next.toString()}`);
  }

  const data = await getDashboardData();
  const { actor, courseAdmin } = data;
  // Business figures: acceptance-test courses are counted separately below.
  const courses = data.catalogue.ok
    ? data.catalogue.data.courses.filter((c) => !c.testRecord)
    : [];
  // Organisation stages are always listed; an Academy stage only when a
  // course is waiting on it, labelled so the two tracks never merge.
  const byStage = STAGE_ORDER.map((id) => ({
    id,
    label: ACADEMY_STAGES.has(id)
      ? `Academy: ${STAGE_LABELS[id]}`
      : STAGE_LABELS[id],
    value: courses.filter(
      (c) => c.lifecycle.stage === id && c.lifecycle.stageState !== "complete",
    ).length,
  }))
    .filter((s) => !ACADEMY_STAGES.has(s.id) || s.value > 0)
    .map(({ label, value }) => ({ label, value }));
  const live = courses.filter((c) => isPubliclyLive(c.lifecycle)).length;
  const needing = courses.filter((c) =>
    ["action", "attention", "approval"].includes(c.lifecycle.stageState),
  );
  const orders = data.orders.ok ? data.orders.data.rows : [];
  const fulfilled = orders.filter((o) => o.state === "FULFILLED").length;
  const pending = orders.filter((o) => o.state === "PENDING").length;
  const flagged = orders.filter((o) => o.reason).length;
  const unresolved = data.issues.ok
    ? data.issues.data.rows.filter((r) => r.state === "UNRESOLVED").length
    : 0;

  return (
    <AdminShell
      active="dashboard"
      name={actor.displayName}
      roles={actor.roles}
      title="Dashboard"
      description="The academy at a glance, from its governed records."
      actions={
        courseAdmin ? (
          <Link href="/admin/operations-engineer" className="ac-button">
            <Bot size={16} aria-hidden="true" /> Ask Operations Engineer
          </Link>
        ) : undefined
      }
    >
      <div className="ac-stat-grid">
        {data.overview.ok ? (
          <>
            <StatCard
              label="Learner accounts"
              value={data.overview.data.learners}
              detail="All learner profiles, including acceptance-test accounts"
              href="/admin/academy?tab=learners"
            />
            <StatCard
              label="Cohorts"
              value={
                data.enrolments.ok
                  ? data.enrolments.data.cohorts
                  : data.overview.data.cohorts
              }
              detail={
                data.enrolments.ok
                  ? `${data.enrolments.data.openCohorts} open for enrolment · demo and acceptance excluded`
                  : "All cohort records"
              }
              href={courseAdmin ? "/admin/cohorts" : undefined}
            />
          </>
        ) : (
          <Unavailable what="Academy totals" />
        )}
        {courseAdmin && (
          <>
            <StatCard
              label="Courses"
              value={data.catalogue.ok ? courses.length : "—"}
              detail={
                data.catalogue.ok
                  ? `${live} live in the public catalogue`
                  : "Course register unavailable"
              }
              href="/admin/courses"
            />
            <StatCard
              label="Active enrolments"
              value={data.enrolments.ok ? data.enrolments.data.active : "—"}
              detail="Demo and acceptance-test cohorts excluded"
              href="/admin/academy?tab=learners"
            />
            <StatCard
              label="Payment exceptions"
              value={data.issues.ok ? unresolved : "—"}
              detail={
                data.issues.ok
                  ? "Unresolved, in the latest 25 payment events (may include test traffic)"
                  : "Issue queue unavailable"
              }
              tone={unresolved > 0 ? "attention" : "default"}
              href="/admin/sales?tab=exceptions"
            />
            <StatCard
              label="Active campaigns"
              value={data.campaigns.ok ? data.campaigns.data.active : "—"}
              detail="Discount and reviewer codes · acceptance excluded"
              href="/admin/sales?tab=campaigns"
            />
          </>
        )}
      </div>

      {courseAdmin && (
        <div className="ac-grid-2">
          <Panel
            id="pipeline"
            title="Course pipeline"
            description="Where each course's next step is. Courses fully live and acceptance-test courses are not counted here."
            actions={
              <Link href="/admin/courses" className="ac-link">
                All courses →
              </Link>
            }
          >
            {data.catalogue.ok ? (
              courses.length ? (
                <BarList
                  label="Courses by their next lifecycle stage"
                  items={byStage}
                />
              ) : (
                <Empty title="No course packages yet">
                  Import a course package to start its lifecycle.
                </Empty>
              )
            ) : (
              <Unavailable what="The course register" />
            )}
          </Panel>
          <Panel
            id="enrolments"
            title="Enrolments"
            description="Canonical enrolment records, excluding demo and acceptance-test cohorts."
          >
            {data.enrolments.ok ? (
              <BarList
                label="Enrolments by status"
                items={[
                  { label: "Active", value: data.enrolments.data.active },
                  { label: "Paused", value: data.enrolments.data.paused },
                  { label: "Completed", value: data.enrolments.data.completed },
                  { label: "Withdrawn", value: data.enrolments.data.withdrawn },
                ]}
              />
            ) : (
              <Unavailable what="Enrolment totals" />
            )}
          </Panel>
        </div>
      )}

      {courseAdmin && (
        <Panel
          id="attention"
          title="Courses needing a decision"
          description="The next step for each course that is not yet live."
        >
          {!data.catalogue.ok ? (
            <Unavailable what="The course register" />
          ) : needing.length === 0 ? (
            <Empty title="Nothing is waiting">
              Every course is live or blocked on an earlier stage.
            </Empty>
          ) : (
            <ul className="ac-action-list">
              {needing.slice(0, 8).map((c) => (
                <li key={c.packageKey}>
                  <div>
                    <Link
                      href={`/admin/courses/${encodeURIComponent(c.packageKey)}`}
                      className="ac-strong"
                    >
                      {c.title}
                    </Link>
                    <span className="ac-muted">
                      {" "}
                      · revision {c.lifecycle.current.packageRevision} ·{" "}
                      {c.lifecycle.academy ? "Academy: " : ""}
                      {STAGE_LABELS[c.lifecycle.stage]}
                    </span>
                    <p>{c.lifecycle.headline}</p>
                  </div>
                  <StatePill state={c.lifecycle.stageState} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {courseAdmin && (
        <div className="ac-grid-2">
          <Panel
            id="sales"
            title="Orders and revenue"
            actions={
              <Link href="/admin/sales" className="ac-link">
                Sales & Commerce →
              </Link>
            }
          >
            {data.orders.ok ? (
              <>
                <div className="ac-mini-stats">
                  <div>
                    <strong>{fulfilled}</strong>
                    <span>Fulfilled</span>
                  </div>
                  <div>
                    <strong>{pending}</strong>
                    <span>Pending</span>
                  </div>
                  <div>
                    <strong>{flagged}</strong>
                    <span>Flagged</span>
                  </div>
                </div>
                <p className="ac-muted">
                  {orders.length} business orders among the latest 25 order
                  records
                  {data.orders.data.hasMore ? " (older orders exist)" : ""};
                  acceptance-test orders are excluded. A pending order is a
                  payment attempt, not revenue.
                </p>
              </>
            ) : (
              <Unavailable what="Orders" />
            )}
            <p className="ac-note">
              Settled revenue is not reported: no authoritative settled-payment
              and refund total exists yet, and summing order attempts would
              overstate it.
            </p>
          </Panel>
          <Panel
            id="agents"
            title="AI agent services"
            description="Provider keys present in this deployment. Presence is not a live call."
            actions={
              <Link href="/admin/academy?tab=agents" className="ac-link">
                Details →
              </Link>
            }
          >
            <ul className="ac-health">
              {data.agents.map((a) => (
                <li key={a.ref}>
                  <span>
                    <span className="ac-strong">{a.roles[0] ?? a.ref}</span>
                    {a.roles.length > 1 && (
                      <span className="ac-muted"> +{a.roles.length - 1}</span>
                    )}
                  </span>
                  {a.ready ? (
                    <Pill tone="good">Configured</Pill>
                  ) : (
                    <Pill tone="warn">Not configured</Pill>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      {courseAdmin && data.testRecords.ok && (
        <Panel
          id="test-records"
          title="Acceptance-test and staging records (excluded)"
          description="Shared-environment test traffic. None of it is counted in the figures above."
        >
          <dl className="ac-mini-stats">
            {(
              [
                ["Courses", data.testRecords.data.courses],
                ["Cohorts", data.testRecords.data.cohorts],
                ["Active enrolments", data.testRecords.data.enrolments],
                ["Orders (latest 25)", data.testRecords.data.orders],
                ["Campaigns", data.testRecords.data.campaigns],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <strong>{value ?? "—"}</strong>
                </dd>
              </div>
            ))}
          </dl>
          <p className="ac-note">{TEST_RECORD_NOTE}</p>
        </Panel>
      )}

      <Panel id="activity" title="Recent administrative activity">
        {!data.overview.ok ? (
          <Unavailable what="The audit trail" />
        ) : !data.overview.data.canAudit ? (
          <p className="ac-muted">
            The audit trail is visible to platform administrators.
          </p>
        ) : (
          <DataTable
            caption="Recent audit events"
            columns={["When", "Change", "Record", "Source"]}
            rows={data.overview.data.audit.map((a) => [
              when(a.occurred_at),
              words(a.action),
              a.target_type.replace(/_/g, " "),
              a.source.replace(/_/g, " ").toLowerCase(),
            ])}
            empty={<Empty title="No audited changes yet" />}
          />
        )}
      </Panel>

      {!courseAdmin && (
        <Panel title="Your workspaces">
          <p>
            Your role gives access to official-record correction in{" "}
            <Link
              href="/admin/academy?tab=learners&section=registry"
              className="ac-link"
            >
              Academy Operations
            </Link>
            . Course, sales and operations workspaces require an academic or
            platform administrator.
          </p>
        </Panel>
      )}
    </AdminShell>
  );
}
