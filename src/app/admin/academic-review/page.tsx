import Link from "next/link";
import { z } from "zod";
import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import { CourseRevisionForm } from "@/components/course-revision-form";
import { Panel, Pill, Unavailable } from "@/components/admin-ui";
import { courseEngineeringAccess } from "@/server/course-organisations";
import { COURSE_ADMIN_ROLES } from "@/server/admin-access";
import { getAcademyPackageReview } from "@/server/academy-course-engineering";
import {
  getUnifiedAcademicResolutions,
  getUnifiedRevisionSource,
  listUnifiedCoursePackages,
} from "@/server/unified-course-engine";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";

export const dynamic = "force-dynamic";

// Course-package review is separate from historical learner grading.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ packageId?: string }>;
}) {
  const access = await courseEngineeringAccess();
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Academic review"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const packages = await listUnifiedCoursePackages().catch(() => null);
  const requested = z.uuid().safeParse((await searchParams).packageId);
  const selected = requested.success
    ? packages?.find((p) => p.id === requested.data)
    : undefined;
  const canManage = selected?.organisationId
    ? access.organisations.some(
        (o) => o.id === selected.organisationId && o.canManage,
      )
    : access.actor.roles.some(
        (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
      );
  const record = selected
    ? await getAcademyPackageReview(selected.id).catch(() => null)
    : null;
  const review = record?.review;
  const decisions = selected
    ? await getUnifiedAcademicResolutions(selected.id).catch(() => [])
    : [];
  const source = selected && canManage && selected.status === "VALIDATED"
    ? await getUnifiedRevisionSource(selected.id).catch(() => null)
    : null;
  const validation = source ? validateAcademyCoursePackage(source) : null;
  let revisedJson: string | null = null;
  if (validation?.valid) {
    const raw = structuredClone(validation.package);
    raw.packageRevision += 1;
    raw.curriculum.packageRevision = raw.packageRevision;
    revisedJson = JSON.stringify(raw, null, 2);
  }

  return (
    <AdminShell
      active="courses"
      name={access.actor.displayName}
      roles={access.actor.roles}
      title="Academic review"
      description="Review validated course packages and retain evidence for every academic decision before publication."
    >
      <Panel title="Course packages requiring review">
        {packages === null ? (
          <Unavailable what="The course review register" />
        ) : packages.length === 0 ? (
          <p>No course packages have been uploaded.</p>
        ) : (
          <ul className="acad-list">
            {packages.map((p) => (
              <li key={p.id} className={p.id === selected?.id ? "selected" : ""}>
                <Link className="ac-course-title" href={`/admin/academic-review?packageId=${p.id}`}>
                  {p.title ?? p.packageKey}
                </Link>
                <span className="ac-muted">
                  {p.organisationName ? `${p.organisationName} · ` : ""}
                  Revision {p.packageRevision} · {p.status.toLowerCase()} ·
                  {" "}{p.pendingDecisions.length} pending academic decision(s)
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {selected && (
        <Panel title={`Review · ${selected.title ?? selected.packageKey} · revision ${selected.packageRevision}`}>
          <p>
            <Pill tone={selected.status === "PUBLISHED" ? "good" : "neutral"}>
              {selected.status.toLowerCase()}
            </Pill>
          </p>
          {(review?.pendingDecisions ?? []).length ? (
            <>
              <h3>Outstanding academic decisions</h3>
              <ul className="acad-issues">
                {review.pendingDecisions.map((d: {key: string; summary: string}) => (
                  <li key={d.key}>
                    <strong>{d.key}</strong> — {d.summary}
                  </li>
                ))}
              </ul>
              <p>
                Pending decisions prevent public publication. Record an actual
                authorised review with supporting evidence; never remove a
                finding solely to bypass the gate.
              </p>
            </>
          ) : (
            <p>No pending academic decisions are recorded in this package.</p>
          )}
          {decisions.length > 0 && (
            <>
              <h3>Recorded decisions</h3>
              <ul className="acad-issues">
                {decisions.map((d) => (
                  <li key={d.key}>
                    <strong>{d.key}</strong> — {d.rationale}. Evidence: {d.evidenceReference}
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link className="ac-link" href={`/admin/course-engineering?packageId=${selected.id}`}>
            Open this course in Course Engineering
          </Link>
          {canManage && selected.status === "VALIDATED" && revisedJson && (
            <CourseRevisionForm
              sourceId={selected.id}
              raw={revisedJson}
              pending={review?.pendingDecisions ?? []}
            />
          )}
        </Panel>
      )}
      <Panel title="Historical learner-grading reviews">
        <p>Escalated examination and practical marking cases are separate from course-package approval.</p>
        <Link className="ac-link" href="/admin/academic-review/results">
          Open historical grading cases
        </Link>
      </Panel>
    </AdminShell>
  );
}
