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
  Unavailable,
} from "@/components/admin-ui";
import { tabForSection } from "@/domain/admin-academy-tabs";
import { courseEngineeringAccess } from "@/server/course-organisations";
import {
  getUnifiedDashboardData,
  NEEDS_ATTENTION,
} from "@/server/admin-dashboard";
import type { CourseStage } from "@/domain/unified-course-lifecycle";

export const dynamic = "force-dynamic";

const STAGES: { id: CourseStage; label: string }[] = [
  { id: "UPLOADED", label: "Uploaded, validation not recorded" },
  { id: "AWAITING_REVIEW", label: "Awaiting academic review" },
  { id: "APPROVED_FOR_PUBLICATION", label: "Approved for publication" },
  { id: "PUBLICATION_INCOMPLETE", label: "Publication checks incomplete" },
  { id: "PUBLISHED", label: "Published" },
  { id: "FAILED", label: "Failed validation" },
];

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
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const access = await courseEngineeringAccess();
  const roles = access.actor.roles;
  // Compatibility: the former section workspaces live in the historical
  // academic records. Every query parameter (filters, cursors) is preserved.
  const params = (await searchParams) ?? {};
  if (
    typeof params.section === "string" &&
    roles.some(
      (r) =>
        r === "REGISTRAR" || r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
    )
  ) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (typeof value === "string" && value.length < 200)
        query.set(key, key === "section" ? value.toLowerCase() : value);
    query.set("tab", tabForSection(params.section));
    redirect("/admin/academy?" + query.toString());
  }
  if (!access.allowed)
    redirect(
      roles.includes("REGISTRAR") ? "/admin/academy" : "/student/academy",
    );

  const data = await getUnifiedDashboardData(access);
  const courses = data.courses.ok ? data.courses.real : [];
  const count = (stage: CourseStage) =>
    courses.filter((c) => c.stage.stage === stage).length;
  const needing = courses
    .filter((c) => NEEDS_ATTENTION.includes(c.stage.stage))
    .sort(
      (a, b) =>
        NEEDS_ATTENTION.indexOf(a.stage.stage) -
        NEEDS_ATTENTION.indexOf(b.stage.stage),
    );
  const orders = data.orders.ok ? data.orders.rows : [];
  const confirmed = orders.filter((o) => o.paymentConfirmed).length;

  return (
    <AdminShell
      active="dashboard"
      name={access.actor.displayName}
      roles={roles}
      title="Dashboard"
      description="The academy at a glance, from its governed records."
      actions={
        <Link href="/admin/operations-engineer" className="ac-button">
          <Bot size={16} aria-hidden="true" /> Ask Operations Engineer
        </Link>
      }
    >
      <div className="ac-stat-grid">
        {data.staff &&
          (data.overview.ok ? (
            <StatCard
              label="Learner accounts"
              value={data.overview.data.learners}
              detail="All learner profiles, including acceptance-test accounts"
            />
          ) : (
            <Unavailable what="Academy totals" />
          ))}
        <StatCard
          label="Courses"
          value={data.courses.ok ? courses.length : "—"}
          detail={
            data.courses.ok
              ? `${count("PUBLISHED")} published · test records excluded`
              : "Course register unavailable"
          }
          href="/admin/course-engineering"
        />
        <StatCard
          label="Awaiting academic review"
          value={data.courses.ok ? count("AWAITING_REVIEW") : "—"}
          detail="Courses whose latest revision has pending decisions"
          tone={count("AWAITING_REVIEW") > 0 ? "attention" : "default"}
          href="/admin/course-engineering/review"
        />
        <StatCard
          label="Payment-confirmed orders"
          value={data.orders.ok ? confirmed : "—"}
          detail={
            data.orders.ok
              ? `Of ${orders.length} recent course orders · test courses excluded`
              : "Order report unavailable"
          }
          href="/admin/operations-engineer?action=sales_report"
        />
        <StatCard
          label="Active coupons"
          value={data.coupons.ok ? data.coupons.active : "—"}
          detail="Active and unexpired · may include test codes"
          href="/admin/course-engineering/coupons"
        />
      </div>

      <div className="ac-grid-2">
        <Panel
          id="pipeline"
          title="Course pipeline"
          description="Each course counted once, at the stage of its latest revision. Test records are not counted."
          actions={
            <Link href="/admin/course-engineering" className="ac-link">
              Course Engineering →
            </Link>
          }
        >
          {!data.courses.ok ? (
            <Unavailable what="The course register" />
          ) : courses.length ? (
            <BarList
              label="Courses by lifecycle stage"
              items={STAGES.map((s) => ({
                label: s.label,
                value: count(s.id),
              }))}
            />
          ) : (
            <Empty title="No course packages yet">
              Upload a course package to start its lifecycle.
            </Empty>
          )}
        </Panel>
        <Panel
          id="sales"
          title="Orders"
          actions={
            <Link
              href="/admin/operations-engineer?action=sales_report"
              className="ac-link"
            >
              Sales statistics →
            </Link>
          }
        >
          {data.orders.ok ? (
            <>
              <div className="ac-mini-stats">
                <div>
                  <strong>
                    {orders.filter((o) => o.state === "FULFILLED").length}
                  </strong>
                  <span>Fulfilled</span>
                </div>
                <div>
                  <strong>
                    {orders.filter((o) => o.state === "PENDING").length}
                  </strong>
                  <span>Pending</span>
                </div>
                <div>
                  <strong>
                    {orders.filter((o) => o.refundRecorded).length}
                  </strong>
                  <span>Refund recorded</span>
                </div>
              </div>
              <p className="ac-muted">
                The newest {data.orders.total} paid-checkout orders you can see
                {data.orders.test
                  ? `, of which ${data.orders.test} for test courses are excluded`
                  : ""}
                . Free coupon access creates no order. A pending order is a
                payment attempt, not revenue.
              </p>
            </>
          ) : (
            <Unavailable what="Orders" />
          )}
          <p className="ac-note">
            Recognised revenue is not reported: there is no settled-revenue
            ledger, and summing order amounts would overstate it.
          </p>
        </Panel>
      </div>

      <Panel
        id="attention"
        title="Courses needing a decision"
        description="The next step for each course that is not yet published."
      >
        {!data.courses.ok ? (
          <Unavailable what="The course register" />
        ) : needing.length === 0 ? (
          <Empty title="Nothing is waiting">
            Every course is published or has no next step.
          </Empty>
        ) : (
          <ul className="ac-action-list">
            {needing.slice(0, 8).map((c) => (
              <li key={c.latest.id}>
                <div>
                  <Link
                    href={
                      c.stage.stage === "AWAITING_REVIEW"
                        ? `/admin/course-engineering/review?packageId=${c.latest.id}`
                        : `/admin/course-engineering?packageId=${c.latest.id}`
                    }
                    className="ac-strong"
                  >
                    {c.latest.title ?? c.latest.packageKey}
                  </Link>
                  <span className="ac-muted">
                    {" "}
                    · revision {c.latest.packageRevision}
                    {c.latest.organisationName
                      ? ` · ${c.latest.organisationName}`
                      : ""}
                  </span>
                  <p>{c.stage.detail}</p>
                </div>
                <Pill tone={c.stage.tone}>{c.stage.label}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="ac-grid-2">
        {data.staff && (
          <Panel
            id="agents"
            title="AI agent services"
            description="Provider keys present in this deployment. Presence is not a live call."
            actions={
              <Link href="/admin/agents" className="ac-link">
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
        )}
        <Panel
          id="test-records"
          title="Test records (excluded)"
          description="Shared-environment test traffic, recognised by its naming. None of it is counted above."
        >
          <dl className="ac-mini-stats">
            <div>
              <dt>Test courses</dt>
              <dd>
                <strong>{data.courses.ok ? data.courses.test : "—"}</strong>
              </dd>
            </div>
            <div>
              <dt>Test-course orders</dt>
              <dd>
                <strong>{data.orders.ok ? data.orders.test : "—"}</strong>
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      {data.staff && (
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
      )}
    </AdminShell>
  );
}
