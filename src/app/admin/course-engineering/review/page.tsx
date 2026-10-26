import Link from "next/link";
import { z } from "zod";
import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import { Empty, Panel, Pill, Unavailable } from "@/components/admin-ui";
import { CourseDecisionReviewForm } from "@/components/course-decision-review-form";
import { courseEngineeringAccess } from "@/server/course-organisations";
import { COURSE_ADMIN_ROLES } from "@/server/admin-access";
import { getAcademyPackageReview } from "@/server/academy-course-engineering";
import {
  getUnifiedAcademicResolutions,
  listUnifiedCoursePackages,
} from "@/server/unified-course-engine";
import type { AcademyReview } from "@/domain/academy-course-package";
import { courseStage } from "@/domain/unified-course-lifecycle";

export const dynamic = "force-dynamic";

// Course-package academic review: content, sources, assessments, rubrics and
// publication approvals for unified course revisions. Learner-result review
// (escalated grading) is a separate workflow at /admin/academic-review.
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
        active="review"
        title="Course academic review"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const { packageId } = await searchParams;
  const packages = await listUnifiedCoursePackages().catch(() => null);
  const selectedId = z.uuid().safeParse(packageId);
  const selected = selectedId.success
    ? packages?.find((p) => p.id === selectedId.data)
    : undefined;
  const lineage = selected
    ? packages!
        .filter(
          (p) =>
            p.packageKey === selected.packageKey &&
            p.organisationId === selected.organisationId,
        )
        .sort((a, b) => a.packageRevision - b.packageRevision)
    : [];
  const latest = lineage.at(-1);
  let review: AcademyReview | null = null;
  if (selected && selected.status !== "UPLOADED")
    review = await getAcademyPackageReview(selected.id)
      .then((r) => (r.review as AcademyReview | null) ?? null)
      .catch(() => null);
  // Resolutions are recorded on the revision they created, so the decision
  // history of this revision is the union over its lineage up to itself.
  const history = selected
    ? (
        await Promise.all(
          lineage
            .filter((p) => p.packageRevision <= selected.packageRevision)
            .map((p) =>
              getUnifiedAcademicResolutions(p.id).then(
                (rows) =>
                  rows.map((r) => ({ ...r, revision: p.packageRevision })),
                () => null,
              ),
            ),
        )
      ).flat()
    : [];
  const historyUnavailable = history.some((r) => r === null);
  const resolved = history.filter((r) => r !== null);
  const canReview = selected?.organisationId
    ? access.organisations.some(
        (o) => o.id === selected.organisationId && o.canReview,
      )
    : false;
  const isLatest = selected && latest?.id === selected.id;
  const pending = review?.pendingDecisions ?? [];

  return (
    <AdminShell
      active="review"
      name={access.actor.displayName}
      roles={access.actor.roles}
      title="Course academic review"
      description="Review a course package's academic findings and record genuine, evidence-backed decisions. Every decision creates a new revision; earlier revisions are never changed."
      actions={
        <Link href="/admin/academic-review" className="ac-button secondary">
          Learner result review
        </Link>
      }
    >
      <Panel id="packages" title="Course packages">
        {packages === null ? (
          <Unavailable what="The course package register" />
        ) : packages.length === 0 ? (
          <Empty title="No course packages yet" />
        ) : (
          <ul className="acad-list">
            {packages.map((p) => {
              const s = courseStage(p);
              return (
                <li
                  key={p.id}
                  className={p.id === selected?.id ? "selected" : ""}
                >
                  <Link
                    href={`/admin/course-engineering/review?packageId=${p.id}`}
                    className="ac-course-title"
                  >
                    {p.title ?? p.packageKey}
                  </Link>
                  <span className="ac-muted">
                    {p.organisationName ? `${p.organisationName} · ` : ""}
                    {p.packageKey} · revision {p.packageRevision}
                  </span>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {selected && (
        <Panel
          id="review"
          title={`${review?.title ?? selected.packageKey} · revision ${selected.packageRevision}`}
          description={courseStage(selected).detail}
        >
          {!isLatest && latest && (
            <p className="ac-note" role="note">
              This is not the latest revision.{" "}
              <Link
                className="ac-link"
                href={`/admin/course-engineering/review?packageId=${latest.id}`}
              >
                Open revision {latest.packageRevision}
              </Link>{" "}
              to review its decisions.
            </p>
          )}
          {selected.status === "UPLOADED" ? (
            <p>
              Structural validation has not been recorded for this revision, so
              it cannot be reviewed yet.
            </p>
          ) : !review ? (
            <Unavailable what="The review summary" />
          ) : (
            <>
              <p>
                {review.totals.modules} modules · {review.totals.lessons}{" "}
                lessons · {review.labs.length} labs (
                {review.labs.filter((l) => l.graded).length} graded) ·{" "}
                {review.assessments.length} assessments.{" "}
                {review.demoContent && <Pill tone="warn">demo content</Pill>}
              </p>
              <h3 className="acad-h3">Assessments</h3>
              <ul>
                {review.assessments.map((a) => (
                  <li key={a.ref}>
                    {a.title} ({a.kind.toLowerCase()}): {a.questionCount} items,{" "}
                    {a.durationMinutes} minutes, {a.attemptsAllowed} attempt
                    {a.attemptsAllowed === 1 ? "" : "s"}, weight{" "}
                    {a.weightBp / 100}%
                  </li>
                ))}
              </ul>
              <h3 className="acad-h3">Declared primary sources</h3>
              <ul>
                {review.sourceReferences.map((s) => (
                  <li key={s.key}>
                    {s.title} — {s.publisher}
                    {s.version ? ` (${s.version})` : ""}
                  </li>
                ))}
              </ul>
              <h3 className="acad-h3">Academic decisions</h3>
              {pending.length === 0 && resolved.length === 0 ? (
                <p>This package declares no academic decisions.</p>
              ) : (
                <ul className="acad-list">
                  {pending.map((d) => (
                    <li key={d.key}>
                      <strong>{d.key}</strong> <Pill tone="warn">pending</Pill>
                      <p>{d.summary}</p>
                      <p className="ac-muted">
                        Required to resolve: an authorised reviewer with
                        academic review authority in this organisation, a
                        reference to the actual review record (10–300
                        characters) and a rationale (20–1000 characters).
                        Publication stays blocked while it is pending.
                      </p>
                    </li>
                  ))}
                  {resolved.map((r) => (
                    <li key={`${r!.key}-${r!.revision}`}>
                      <strong>{r!.key}</strong>{" "}
                      <Pill tone="good">
                        resolved in revision {r!.revision}
                      </Pill>
                      <p>
                        {r!.rationale} Evidence: {r!.evidenceReference}.
                        Reviewer {r!.reviewedBy}, {r!.reviewedAt}.
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {historyUnavailable && (
                <Unavailable what="Part of the recorded decision history" />
              )}
            </>
          )}
        </Panel>
      )}

      {selected?.status === "VALIDATED" && pending.length > 0 && isLatest && (
        <Panel
          id="resolve"
          title="Record reviewed decisions"
          description="Select only decisions whose review has actually taken place. Unselected decisions stay pending and keep publication blocked."
        >
          {canReview ? (
            <CourseDecisionReviewForm
              sourceId={selected.id}
              pending={pending.map((d) => ({ key: d.key, summary: d.summary }))}
            />
          ) : (
            <p>
              Your account has no academic review authority in this
              course&apos;s organisation, so it cannot record decisions.
            </p>
          )}
        </Panel>
      )}

      {selected && (
        <p>
          <Link
            className="ac-link"
            href={`/admin/course-engineering?packageId=${selected.id}`}
          >
            Open this revision in Course Engineering
          </Link>{" "}
          for content corrections, price and publication.
        </p>
      )}
    </AdminShell>
  );
}
