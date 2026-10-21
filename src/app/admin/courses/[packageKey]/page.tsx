import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot, ExternalLink } from "lucide-react";
import { getCourseDetail } from "@/server/admin-control-centre";
import { AdminShell } from "@/components/admin-shell";
import {
  Advanced,
  DataTable,
  Empty,
  LifecycleStepper,
  Panel,
  Pill,
  StatePill,
  Unavailable,
} from "@/components/admin-ui";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import type { DeliveryPlan } from "@/domain/commercial-v1-launch";
import { describeTestFailure } from "@/domain/course-engineering-admin";
import { TEST_RECORD_NOTE } from "@/domain/admin-test-records";
import {
  QUESTION_TYPE_LABELS,
  type QuestionType,
} from "@/domain/assessment-question-types";

export const dynamic = "force-dynamic";

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SECTIONS = [
  ["overview", "Overview"],
  ["curriculum", "Curriculum & versions"],
  ["readiness", "Validation & readiness"],
  ["agents", "Agent configuration"],
  ["delivery", "Cohorts & delivery"],
  ["assessments", "Assessments"],
  ["pricing", "Price & publication"],
  ["history", "Operational history"],
] as const;

function day(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(d);
}

const ROLE_NAMES: Record<string, string> = {
  PROFESSOR: "Professor",
  TUTOR: "Tutor",
  LAB_INSTRUCTOR: "Lab instructor",
  EXAMINER: "Examiner",
  COUNSELLOR: "Counsellor",
};

export default async function Page({
  params,
}: {
  params: Promise<{ packageKey: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Course"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const { packageKey } = await params;
  const detail = await getCourseDetail(decodeURIComponent(packageKey));
  if (!detail) notFound();
  const { row, preview } = detail;
  const life = row.lifecycle;
  const current = life.current;
  const engineering = `/admin/course-engineering?importId=${current.id}`;
  const ask = (action: string, extra = "") =>
    `/admin/operations-engineer?action=${action}${extra}`;
  const p = preview.ok ? preview.data : null;
  const lessons = p ? p.modules.reduce((n, m) => n + m.lessons.length, 0) : 0;
  const practicals = p
    ? p.modules.reduce(
        (n, m) =>
          n + m.lessons.reduce((k, l) => k + l.practicalActivities.length, 0),
        0,
      )
    : 0;

  const history = [
    ...life.revisions.flatMap((r) => [
      { at: r.createdAt, text: `Revision ${r.packageRevision} imported` },
      ...(r.appliedAt
        ? [
            {
              at: r.appliedAt,
              text: `Revision ${r.packageRevision} applied as a draft`,
            },
          ]
        : []),
      ...(r.publishedAt
        ? [
            {
              at: r.publishedAt,
              text: `Revision ${r.packageRevision} published as curriculum`,
            },
          ]
        : []),
      ...(r.rejectedAt
        ? [{ at: r.rejectedAt, text: `Revision ${r.packageRevision} rejected` }]
        : []),
    ]),
    ...detail.activations.map((a) => ({
      at: a.createdAt,
      text: `Delivery activated for “${a.cohortTitle}”`,
    })),
    ...(detail.testReadiness.ok && detail.testReadiness.data?.runAt
      ? [
          {
            at: detail.testReadiness.data.runAt,
            text: `Pre-publication test run ${detail.testReadiness.data.runSequence}: ${detail.testReadiness.data.outcome === "PASS" ? "passed" : "failed"}`,
          },
        ]
      : []),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <AdminShell
      active="courses"
      name={actor.displayName}
      roles={actor.roles}
      title={row.title}
      description={`Revision ${current.packageRevision}${row.versionLabel ? ` · ${row.versionLabel}` : ""} · ${life.stageState === "complete" ? "Live in the public catalogue" : life.headline}`}
      actions={
        <Link
          href={ask(
            "inspect_course",
            `&packageKey=${encodeURIComponent(life.packageKey)}`,
          )}
          className="ac-button"
        >
          <Bot size={16} aria-hidden="true" /> Ask Operations Engineer
        </Link>
      }
    >
      {row.testRecord && (
        <p className="ac-alert" role="note">
          This is an acceptance-test course, not a business course. It is
          excluded from every dashboard and sales figure. {TEST_RECORD_NOTE}
        </p>
      )}
      <nav aria-label="Course sections" className="ac-anchor-nav">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <Panel
        id="overview"
        title="Lifecycle"
        actions={<StatePill state={life.stageState} />}
      >
        <LifecycleStepper stages={life.stages} />
      </Panel>

      <Panel
        id="curriculum"
        title="Curriculum and versions"
        actions={
          <Link href={engineering} className="ac-link">
            Open in course engineering →
          </Link>
        }
      >
        {!preview.ok ? (
          <Unavailable what="The curriculum preview" />
        ) : p ? (
          <>
            <div className="ac-mini-stats">
              <div>
                <strong>{p.modules.length}</strong>
                <span>Modules</span>
              </div>
              <div>
                <strong>{lessons}</strong>
                <span>Lessons</span>
              </div>
              <div>
                <strong>{practicals}</strong>
                <span>Practicals</span>
              </div>
              <div>
                <strong>{p.assignmentTemplates.length}</strong>
                <span>Assignments</span>
              </div>
              <div>
                <strong>{p.assessmentTemplates.length}</strong>
                <span>Assessments</span>
              </div>
            </div>
            <p className="ac-muted">
              {p.programme.title} · {p.programme.qualificationName} · prepared
              for {p.programme.examinationBody}&apos;s external examination
            </p>
            <ol className="ac-module-list">
              {p.modules.map((m) => (
                <li key={m.key}>
                  <strong>{m.title}</strong>
                  <span className="ac-muted">
                    {" "}
                    · {m.lessons.length} lessons
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="ac-muted">
            A curriculum preview is available once the package passes
            validation.
          </p>
        )}
        <h3 className="ac-subhead">Revisions</h3>
        <DataTable
          caption="Course package revisions"
          columns={["Revision", "Status", "Imported", "Applied", "Published"]}
          rows={life.revisions.map((r) => [
            `Revision ${r.packageRevision}${r.id === current.id ? " (current)" : ""}`,
            <Pill
              key="s"
              tone={
                r.status === "PUBLISHED"
                  ? "good"
                  : r.status === "REJECTED"
                    ? "bad"
                    : "neutral"
              }
            >
              {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
            </Pill>,
            day(r.createdAt),
            day(r.appliedAt),
            day(r.publishedAt),
          ])}
        />
        <Advanced>
          <dl className="ac-dl">
            <dt>Package key</dt>
            <dd>{life.packageKey}</dd>
            <dt>Current import</dt>
            <dd>{current.id}</dd>
            <dt>Programme version</dt>
            <dd>{current.programmeVersionId ?? "Not applied"}</dd>
          </dl>
        </Advanced>
      </Panel>

      <Panel id="readiness" title="Validation and readiness">
        <ul className="ac-checklist">
          {life.stages.slice(1, 5).map((s) => (
            <li key={s.id}>
              <StatePill state={s.state} /> <strong>{s.label}.</strong>{" "}
              {s.summary}
              {s.next && (
                <>
                  {" "}
                  <Link href={s.next.href} className="ac-link">
                    {s.next.label} →
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
        {detail.testReadiness.ok &&
          detail.testReadiness.data?.status === "FAILED" && (
            <p className="ac-note">
              {describeTestFailure(
                detail.testReadiness.data.failureCode,
                detail.testReadiness.data.failedRoles,
              )}
            </p>
          )}
        {current.status === "APPLIED" && (
          <Link
            href={`/admin/course-engineering?importId=${encodeURIComponent(current.id)}`}
            className="ac-link"
          >
            Run the pre-publication test in course engineering →
          </Link>
        )}
      </Panel>

      <Panel
        id="agents"
        title="Agent configuration"
        description="Saved settings for this curriculum version. Edits stay in course engineering, where the governed save checks run."
        actions={
          <Link href={engineering} className="ac-link">
            Edit agent settings →
          </Link>
        }
      >
        {!detail.agents.ok ? (
          <Unavailable what="Agent configuration" />
        ) : detail.agents.data.length === 0 ? (
          <Empty
            title={
              current.programmeVersionId
                ? "No agent settings saved"
                : "Available after the package is applied"
            }
          />
        ) : (
          <DataTable
            caption="Agent configuration by role"
            columns={[
              "Role",
              "Status",
              "Runtime profile",
              "Capabilities",
              "Escalation",
            ]}
            rows={detail.agents.data.map((a) => [
              ROLE_NAMES[a.role] ?? a.role,
              a.enabled ? (
                <Pill key="e" tone="good">
                  Enabled
                </Pill>
              ) : (
                <Pill key="e">Disabled</Pill>
              ),
              a.modelProfileRef ?? "None (not AI-backed)",
              String(a.capabilities.length),
              a.escalationPolicy === "ACADEMIC_REVIEW"
                ? "Academic review"
                : "None",
            ])}
          />
        )}
      </Panel>

      <Panel
        id="delivery"
        title="Cohorts and delivery schedule"
        actions={
          <Link href="/admin/cohorts" className="ac-link">
            Manage cohorts →
          </Link>
        }
      >
        {life.cohorts.length === 0 ? (
          <Empty title="No cohort for this curriculum version">
            A delivery cohort is needed before the course can be activated.
          </Empty>
        ) : (
          <DataTable
            caption="Cohorts for this curriculum version"
            columns={[
              "Cohort",
              "Purpose",
              "Status",
              "Dates",
              "Learners",
              "Delivery",
            ]}
            rows={life.cohorts.map((c) => [
              <span key="t" className="ac-strong">
                {c.title}
              </span>,
              c.purpose === "LIKELY_STAGING" ? (
                <Pill key="p" tone="bad">
                  Staging / acceptance
                </Pill>
              ) : c.purpose === "DEMO" ? (
                <Pill key="p" tone="warn">
                  Demo
                </Pill>
              ) : (
                <Pill key="p">Purpose not recorded</Pill>
              ),
              c.status.charAt(0) + c.status.slice(1).toLowerCase(),
              `${c.startsOn}${c.endsOn ? ` → ${c.endsOn}` : ""}`,
              String(c.enrolments.active + c.enrolments.paused),
              c.activationId ? "Activated" : "Not activated",
            ])}
          />
        )}
        {life.cohorts.some((c) => c.purpose === "LIKELY_STAGING") && (
          <p className="ac-note">
            A staging or acceptance cohort is never offered to paying learners
            from this workspace. Create a dedicated delivery cohort for real
            learners.
          </p>
        )}
        {p && (
          <p className="ac-muted">
            Package scheduling defaults (descriptive only):{" "}
            {p.schedulingDefaults.studyDays.map((d) => DAYS[d]).join(", ")} at{" "}
            {p.schedulingDefaults.localStartTime} (
            {p.schedulingDefaults.timezone}). The academy&apos;s governed
            delivery policy decides the actual timetable.
          </p>
        )}
      </Panel>

      <Panel
        id="assessments"
        title="Assessment configuration"
        description="Counts and marks only. Questions and answer keys stay protected."
      >
        {!p ? (
          <p className="ac-muted">
            Available once the package passes validation.
          </p>
        ) : p.assessmentTemplates.length === 0 ? (
          <Empty title="This course has no assessments" />
        ) : (
          <DataTable
            caption="Assessments in this course"
            columns={[
              "Assessment",
              "Duration",
              "Attempts",
              "Questions",
              "Marks",
              "Question types",
            ]}
            rows={p.assessmentTemplates.map((a) => [
              a.title,
              `${a.durationMinutes} min`,
              String(a.attemptsAllowed),
              String(a.questionCount),
              String(a.totalMarks),
              Object.entries(a.questionTypeCounts)
                .map(
                  ([t, n]) =>
                    `${QUESTION_TYPE_LABELS[t as QuestionType] ?? t} ×${n}`,
                )
                .join(", "),
            ])}
          />
        )}
        {detail.activations.map((a) => (
          <p key={a.activationId} className="ac-muted">
            Delivery “{a.cohortTitle}”: grading policy{" "}
            {a.gradingPolicyPublished ? "published" : "not published"}, result
            policy {a.resultPolicyPublished ? "published" : "not published"},
            lab practicals configured {a.labPracticalsConfigured} of{" "}
            {a.labPracticalsTotal}.{" "}
            <Link
              href={`/admin/activation/policy?activationId=${a.activationId}`}
              className="ac-link"
            >
              Policy setup →
            </Link>
          </p>
        ))}
      </Panel>

      <Panel
        id="pricing"
        title="Price and publication"
        actions={
          <Link href="/admin/sales" className="ac-link">
            Sales & Commerce →
          </Link>
        }
      >
        {detail.offers.length > 0 ? (
          <DataTable
            caption="Published offers for this course"
            columns={["Offer", "Price", "Delivery plan", "Public page"]}
            rows={detail.offers.map((o) => [
              o.slug,
              formatOfferPrice(o.priceAmountMinor, o.currency),
              DELIVERY_PLAN_DEFINITIONS[o.deliveryPlan as DeliveryPlan]
                ?.label ?? o.deliveryPlan,
              <Link key="v" href={`/courses/${o.slug}`} className="ac-link">
                View <ExternalLink size={13} aria-hidden="true" />
              </Link>,
            ])}
          />
        ) : life.offerSlugs.length > 0 ? (
          <p>
            Offer {life.offerSlugs.join(", ")} is published but not in the
            public catalogue projection.
          </p>
        ) : (
          <Empty title="No commercial offer">
            {detail.activations.length > 0
              ? "This course is activated and ready for a price."
              : "An offer can only be published after delivery is activated."}
          </Empty>
        )}
        {detail.activations.length > 0 && life.offerSlugs.length === 0 && (
          <Link
            href={ask(
              "publish_offer",
              `&activationId=${detail.activations[0].activationId}`,
            )}
            className="ac-link"
          >
            Prepare an offer with the Operations Engineer →
          </Link>
        )}
      </Panel>

      <Panel
        id="history"
        title="Operational history"
        description="Lifecycle events recorded on this course's packages, activations and tests."
      >
        {history.length === 0 ? (
          <Empty title="No recorded events" />
        ) : (
          <ol className="ac-timeline">
            {history.map((h, i) => (
              <li key={i}>
                <time dateTime={h.at}>{day(h.at)}</time>
                <span>{h.text}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </AdminShell>
  );
}
