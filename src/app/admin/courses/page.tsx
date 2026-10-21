import { AdminForbidden } from "@/components/admin-shell";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import Link from "next/link";
import { Bot, Upload } from "lucide-react";
import { getCourseCatalogue } from "@/server/admin-control-centre";
import { AdminShell } from "@/components/admin-shell";
import {
  Empty,
  LifecycleStepper,
  Panel,
  Pill,
  StatCard,
  StatePill,
  Unavailable,
} from "@/components/admin-ui";
import { STAGE_LABELS, type StageState } from "@/domain/admin-course-lifecycle";
import { TEST_RECORD_NOTE } from "@/domain/admin-test-records";

export const dynamic = "force-dynamic";

// Every filter except "test" covers real courses only; acceptance-test
// records are listed only under their own filter.
const FILTERS: {
  id: string;
  label: string;
  states: StageState[] | null;
  test?: true;
}[] = [
  { id: "all", label: "All courses", states: null },
  { id: "action", label: "Needs action", states: ["action", "attention"] },
  { id: "approval", label: "Awaiting approval", states: ["approval"] },
  { id: "live", label: "Live", states: ["complete"] },
  { id: "test", label: "Acceptance-test records", states: null, test: true },
];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Courses"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const params = await searchParams;
  const catalogue = await getCourseCatalogue();
  const q = (params.q ?? "").trim().toLowerCase().slice(0, 100);
  const filter = FILTERS.find((f) => f.id === params.filter) ?? FILTERS[0];
  const inSet = (f: (typeof FILTERS)[number]) =>
    catalogue.courses.filter(
      (c) =>
        c.testRecord === Boolean(f.test) &&
        (!f.states || f.states.includes(c.lifecycle.stageState)),
    );
  const courses = inSet(filter).filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.packageKey.includes(q),
  );
  const count = (f: (typeof FILTERS)[number]) => inSet(f).length;
  const missing = Object.entries(catalogue.sources)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return (
    <AdminShell
      active="courses"
      name={actor.displayName}
      roles={actor.roles}
      title="Courses"
      description="Every course package from import to the public catalogue, with what each one needs next."
      actions={
        <>
          <Link
            href="/admin/course-engineering"
            className="ac-button secondary"
          >
            <Upload size={16} aria-hidden="true" /> Import a course package
          </Link>
          <Link
            href="/admin/operations-engineer?action=inspect_course"
            className="ac-button"
          >
            <Bot size={16} aria-hidden="true" /> Ask Operations Engineer
          </Link>
        </>
      }
    >
      {missing.length > 0 && (
        <Unavailable
          what={`Part of the course register (${missing.join(", ")})`}
        />
      )}

      <div className="ac-stat-grid">
        {FILTERS.map((f) => (
          <StatCard
            key={f.id}
            label={f.label}
            value={count(f)}
            detail={f.test ? "Excluded from every other count" : undefined}
            href={`/admin/courses?filter=${f.id}`}
            tone={f.id === "action" && count(f) > 0 ? "attention" : "default"}
          />
        ))}
      </div>

      <Panel
        id="register"
        title={filter.test ? "Acceptance-test records" : "Course register"}
        description={
          filter.test
            ? "Courses created by the acceptance harness. They are not business courses and are not counted elsewhere."
            : undefined
        }
      >
        {filter.test && <p className="ac-note">{TEST_RECORD_NOTE}</p>}
        <form className="ac-toolbar" role="search" action="/admin/courses">
          <label htmlFor="course-search" className="sr-only">
            Search courses
          </label>
          <input
            id="course-search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search by course name or package key"
            maxLength={100}
          />
          <label htmlFor="course-filter" className="sr-only">
            Filter
          </label>
          <select id="course-filter" name="filter" defaultValue={filter.id}>
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button className="ac-button secondary" type="submit">
            Apply
          </button>
        </form>

        {!catalogue.sources.packages ? (
          <Unavailable what="The course package register" />
        ) : courses.length === 0 ? (
          <Empty
            title={
              catalogue.courses.length
                ? "No course matches"
                : "No course packages yet"
            }
            action={
              catalogue.courses.length ? (
                <Link href="/admin/courses" className="ac-link">
                  Clear filters
                </Link>
              ) : (
                <Link href="/admin/course-engineering" className="ac-link">
                  Import a course package →
                </Link>
              )
            }
          />
        ) : (
          <ul className="ac-course-list">
            {courses.map((c) => (
              <li key={c.packageKey} className="ac-course">
                <div className="ac-course-head">
                  <div>
                    <Link
                      href={`/admin/courses/${encodeURIComponent(c.packageKey)}`}
                      className="ac-course-title"
                    >
                      {c.title}
                    </Link>
                    {c.testRecord && (
                      <Pill tone="neutral">Acceptance test</Pill>
                    )}
                    <p className="ac-muted">
                      Revision {c.lifecycle.current.packageRevision}
                      {c.versionLabel ? ` · ${c.versionLabel}` : ""} ·{" "}
                      {c.lifecycle.revisions.length} revision
                      {c.lifecycle.revisions.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="ac-course-state">
                    <span className="ac-muted">
                      {c.lifecycle.stageState === "complete"
                        ? "Live"
                        : STAGE_LABELS[c.lifecycle.stage]}
                    </span>
                    <StatePill state={c.lifecycle.stageState} />
                  </div>
                </div>
                <LifecycleStepper stages={c.lifecycle.stages} compact />
                <p className="ac-course-next">{c.lifecycle.headline}</p>
                <div className="ac-course-actions">
                  <Link
                    href={`/admin/courses/${encodeURIComponent(c.packageKey)}`}
                    className="ac-button secondary small"
                  >
                    Open course
                  </Link>
                  <Link
                    href={`/admin/operations-engineer?action=inspect_course&packageKey=${encodeURIComponent(c.packageKey)}`}
                    className="ac-link"
                  >
                    Ask Operations Engineer about this course
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminShell>
  );
}
