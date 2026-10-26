import { CourseRevisionForm } from "@/components/course-revision-form";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import {
  CourseOrganisationForm,
  CreateCourseOrganisationForm,
} from "@/components/course-organisation-form";
import { courseEngineeringAccess } from "@/server/course-organisations";
import Link from "next/link";
import { listCourseRecoveries } from "@/server/unified-course-activation";
import { ReviewRecoveryForm } from "@/components/course-recovery-forms";
import { z } from "zod";
import { AdminForbidden, AdminShell } from "@/components/admin-shell";
import {
  DataTable,
  Empty,
  Panel,
  Pill,
  StatCard,
  Unavailable,
} from "@/components/admin-ui";
import {
  AcademyUploadForm,
  EnableSaleForm,
  ArchiveForm,
  MarkLabForm,
  RejectForm,
} from "@/components/academy-course-engineering-forms";
import { COURSE_ADMIN_ROLES } from "@/server/admin-access";
import {
  getAcademyPackageReview,
  listAcademyLabSubmissions,
} from "@/server/academy-course-engineering";
import { UnifiedCoursePublicationForm } from "@/components/unified-course-publication-form";
import {
  getUnifiedCourseAgents,
  getUnifiedRevisionSource,
  getUnifiedAcademicResolutions,
  listUnifiedCoursePackages,
} from "@/server/unified-course-engine";
import type { AcademyReview } from "@/domain/academy-course-package";
import { ACADEMY_FORMATS } from "@/domain/academy-scheduler";
import {
  ACADEMY_ERROR_TEXT,
  AcademyError,
  percent,
} from "@/domain/academy-delivery";
import {
  QUESTION_TYPE_LABELS,
  type QuestionType,
} from "@/domain/assessment-question-types";

export const dynamic = "force-dynamic";

const STEPS = [
  "Upload JSON",
  "Set price",
  "Configure agents",
  "Publish",
] as const;
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;
const reviewShape = z.object({
  packageKey: z.string(),
  title: z.string(),
  totals: z.object({ lessons: z.number() }),
  formats: z.array(z.object({ formatId: z.string() })),
  assessments: z.array(z.object({ ref: z.string() })),
});

function Stepper({ step }: { step: number }) {
  return (
    <ol className="acad-steps" aria-label="Academy publication steps">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={i < step ? "done" : i === step ? "current" : ""}
          aria-current={i === step ? "step" : undefined}
        >
          <span aria-hidden="true">{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function Review({ review }: { review: AcademyReview }) {
  return (
    <>
      <div className="ac-stat-grid">
        <StatCard label="Modules" value={review.totals.modules} />
        <StatCard
          label="Lessons"
          value={review.totals.lessons}
          detail={`${review.totals.objectives} objectives`}
        />
        <StatCard
          label="Teaching"
          value={hours(review.totals.teachingMinutes)}
          detail={`+ ${hours(review.totals.labMinutes)} practicals`}
        />
        <StatCard
          label="Assessments"
          value={review.assessments.length}
          detail={`${hours(review.totals.revisionMinutes)} preparation`}
        />
      </div>
      {review.demoContent && (
        <p className="acad-banner">
          Demonstration content — labelled as such to learners.
        </p>
      )}
      {review.qualificationPreparation && (
        <p className="ac-note">
          Prepares for {review.qualificationPreparation.qualificationName} (
          {review.qualificationPreparation.examinationBody}).{" "}
          {review.qualificationPreparation.disclaimer}
        </p>
      )}
      {(review.pendingDecisions ?? []).length > 0 && (
        <div className="acad-outcome warn" role="note">
          <p>
            Pending academic decisions (not approved; this course stays
            review-only and cannot record official completions):
          </p>
          <ul className="acad-issues">
            {review.pendingDecisions.map((d) => (
              <li key={d.key}>
                <strong>{d.key}</strong> — {d.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.warnings.length > 0 && (
        <div className="acad-outcome warn" role="note">
          <p>Validation warnings</p>
          <ul className="acad-issues">
            {review.warnings.map((w, i) => (
              <li key={i}>
                {w.path} — {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3 className="acad-h3">Delivery formats the blueprint supports</h3>
      <DataTable
        caption="Supported learning formats with estimated weekly load"
        columns={[
          "Format",
          "Class length",
          "Study days a week",
          "Classes needed",
          "Classes a week",
          "Peak week",
        ]}
        rows={review.formats.map((f) => [
          `${f.label} · ${f.weeks} weeks`,
          `${f.sessionMinutes} min`,
          `${f.minStudyDaysPerWeek}–${f.maxStudyDaysPerWeek}`,
          String(f.sessionsRequired),
          String(f.classesPerWeek),
          hours(f.weeklyMinutesPeak),
        ])}
      />
      <h3 className="acad-h3">Assessments and grading</h3>
      <DataTable
        caption="Assessments scheduled automatically from the package"
        columns={[
          "Assessment",
          "Component",
          "Placed after",
          "Duration",
          "Questions",
          "Preparation",
          "Window",
          "Weight",
        ]}
        rows={review.assessments.map((a) => [
          a.title,
          a.componentKey,
          a.afterLessonRef,
          `${a.durationMinutes} min · ${a.attemptsAllowed} attempt${a.attemptsAllowed === 1 ? "" : "s"}`,
          `${a.questionCount} (${Object.entries(a.questionTypes)
            .map(
              ([t, n]) =>
                `${n} ${QUESTION_TYPE_LABELS[t as QuestionType] ?? t}`,
            )
            .join(", ")})`,
          `${a.revisionMinutes} min, ${a.minimumDaysAfterTeaching} day gap`,
          "23 h 59 min",
          percent(a.weightBp),
        ])}
      />
      <p className="ac-muted">
        Pass mark {percent(review.completion.coursePassMarkBp)}
        {review.completion.requireEveryComponentPassMark
          ? " and every component pass mark"
          : ""}
        . Weights:{" "}
        {review.grading
          .map((g) => `${g.componentKey} ${percent(g.weightBp)}`)
          .join(" · ")}
        .
      </p>
      <h3 className="acad-h3">Practical activities</h3>
      <DataTable
        caption="Practical activities scheduled automatically"
        columns={["Activity", "Kind", "After lesson", "Duration", "Graded"]}
        rows={review.labs.map((l) => [
          l.title,
          l.kind === "PRACTICAL_LAB" ? "Lab" : "Exercise",
          l.afterLessonRef,
          `${l.durationMinutes} min`,
          l.graded ? `Yes (${l.rubricMaxMarks} marks)` : "No",
        ])}
      />
      <h3 className="acad-h3">Curriculum</h3>
      <ol className="acad-modules">
        {review.modules.map((m) => (
          <li key={m.key}>
            <strong>{m.title}</strong>
            <ol>
              {m.lessons.map((l) => (
                <li key={l.key}>
                  {l.title}{" "}
                  <span className="ac-muted">· {l.teachingMinutes} min</span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      <p className="ac-muted">
        Sources:{" "}
        {review.sourceReferences
          .map(
            (s) =>
              `${s.title} (${s.publisher}${s.version ? ` v${s.version}` : ""})`,
          )
          .join("; ")}
        .
      </p>
    </>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ packageId?: string; importId?: string }>;
}) {
  const access = await courseEngineeringAccess();
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Course Engineering"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const recoveryQueue = await listCourseRecoveries().catch(() => null);
  const params = await searchParams;
  const register = await listUnifiedCoursePackages().then(
    (list) => ({ list, failure: null }),
    (failure: unknown) => ({ list: null, failure }),
  );
  const packages = register.list;
  const notInstalled =
    register.failure instanceof AcademyError &&
    register.failure.code === "NOT_INSTALLED";
  const labs = await listAcademyLabSubmissions().catch(() => null);
  const selectedId = z.uuid().safeParse(params.packageId);
  const selected = selectedId.success
    ? packages?.find((p) => p.id === selectedId.data)
    : undefined;
  let review: AcademyReview | null = null;
  if (
    selected &&
    selected.status !== "UPLOADED" &&
    selected.status !== "REJECTED"
  ) {
    const row = await getAcademyPackageReview(selected.id).catch(() => null);
    if (row && reviewShape.safeParse(row.review).success)
      review = row.review as AcademyReview;
  }
  const agents =
    selected?.status === "VALIDATED"
      ? await getUnifiedCourseAgents(selected.id).catch(() => null)
      : null;
  const canManageSelected = selected?.organisationId
    ? access.organisations.some(
        (o) => o.id === selected.organisationId && o.canManage,
      )
    : actor.roles.some(
        (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
      ) || access.organisations.some((o) => o.canManage);
  let revisedJson: string | null = null;
  if (
    selected &&
    canManageSelected &&
    ["VALIDATED", "UPLOADED"].includes(selected.status)
  ) {
    const source = await getUnifiedRevisionSource(selected.id).catch(
      () => null,
    );
    const checked = validateAcademyCoursePackage(source);
    if (checked.valid) {
      const raw = structuredClone(checked.package);
      raw.packageRevision += 1;
      raw.curriculum.packageRevision = raw.packageRevision;
      revisedJson = JSON.stringify(raw, null, 2);
    }
  }
  const resolutions = selected
    ? await getUnifiedAcademicResolutions(selected.id).catch(() => [])
    : [];
  const curriculumPublished =
    selected?.curriculumImport?.status === "PUBLISHED";
  const step = !selected
    ? 0
    : selected.status === "PUBLISHED"
      ? 4
      : selected.status === "VALIDATED"
        ? curriculumPublished
          ? 3
          : 2
        : 1;

  return (
    <AdminShell
      active="courses"
      name={actor.displayName}
      roles={actor.roles}
      title="Course Engineering"
      description="Upload JSON, set one price, configure agents and publish. Academic checks run automatically in this workspace."
      actions={
        <Link
          href="/admin/course-engineering/coupons"
          className="ac-button secondary"
        >
          Manage coupons
        </Link>
      }
    >
      <Stepper step={step} />
      {actor.roles.includes("PLATFORM_ADMIN") && (
        <CreateCourseOrganisationForm />
      )}
      <CourseOrganisationForm organisations={access.organisations} />
      <Panel title="Missed-activity recovery reviews (oldest 100)">
        {recoveryQueue === null ? (
          <Unavailable what="The recovery review queue" />
        ) : recoveryQueue.length === 0 ? (
          <p>No pending recovery requests.</p>
        ) : (
          <ul>
            {recoveryQueue.map((r) => (
              <li key={r.id}>
                <p>
                  Enrolment {r.enrolmentId}; activity {r.itemId}; {r.reasonCode}
                  . Proposed {new Date(r.opensAt).toISOString()} to{" "}
                  {new Date(r.closesAt).toISOString()} (UTC).
                </p>
                <ReviewRecoveryForm id={r.id} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {packages === null && (
        <Unavailable
          what="The Academy package register"
          message={notInstalled ? ACADEMY_ERROR_TEXT.NOT_INSTALLED : undefined}
        />
      )}

      <Panel
        id="upload"
        title="Upload and validate"
        description="One versioned ACADEMY_COURSE_PACKAGE_V1 file: curriculum, labs, assessments, grading and delivery formats."
      >
        <AcademyUploadForm organisations={access.organisations} />
      </Panel>

      <Panel id="packages" title="Academy packages">
        {!packages?.length ? (
          <Empty title="No Academy packages yet" />
        ) : (
          <ul className="acad-list">
            {packages.map((p) => (
              <li
                key={p.id}
                className={p.id === selected?.id ? "selected" : ""}
              >
                <Link
                  href={`/admin/course-engineering?packageId=${p.id}`}
                  className="ac-course-title"
                >
                  {p.title ?? p.packageKey}
                </Link>
                <span className="ac-muted">
                  {p.organisationName ? `${p.organisationName} · ` : ""}
                  {p.packageKey} · revision {p.packageRevision}
                </span>
                <Pill
                  tone={
                    p.status === "PUBLISHED"
                      ? "good"
                      : p.status === "REJECTED"
                        ? "bad"
                        : "neutral"
                  }
                >
                  {p.status.toLowerCase()}
                </Pill>
                {p.rejectedReason && (
                  <small className="ac-muted">{p.rejectedReason}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selected && (
        <Panel
          id="review"
          title={`Review · ${review?.title ?? selected.packageKey} (revision ${selected.packageRevision})`}
        >
          {selected.status === "REJECTED" ? (
            <p>This revision was rejected: {selected.rejectedReason}</p>
          ) : review ? (
            <>
              <Review review={review} />
              {resolutions.length > 0 && (
                <>
                  <h3>Recorded human decisions</h3>
                  <ul>
                    {resolutions.map((r) => (
                      <li key={r.key}>
                        <strong>{r.key}</strong>: {r.rationale} Evidence:{" "}
                        {r.evidenceReference}. Reviewer {r.reviewedBy},{" "}
                        {r.reviewedAt}.
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <Unavailable what="The review summary" />
          )}
        </Panel>
      )}

      {selected && revisedJson && (
        <Panel title="Resolve academic findings">
          <CourseRevisionForm
            sourceId={selected.id}
            raw={revisedJson}
            pending={review?.pendingDecisions ?? []}
          />
        </Panel>
      )}

      {selected?.status === "VALIDATED" && review && canManageSelected && (
        <Panel
          id="publish"
          title="Approve and publish"
          description="Review the package, set the selling price and configure agents. Publish runs the existing curriculum and security checks automatically."
        >
          {review.pendingDecisions.length > 0 ? (
            <div className="ac-note" role="status">
              <p>
                Academic review required: {review.pendingDecisions.length} decision
                {review.pendingDecisions.length === 1 ? "" : "s"} remain open.
                This package is validated and saved, but not yet approved for sale.
              </p>
              <p>
                The curriculum pipeline has not started because publication is
                correctly blocked until review is complete.
              </p>
              <Link
                className="ac-link"
                href={`/admin/academic-review?packageId=${selected.id}`}
              >
                Open academic review for this course
              </Link>
            </div>
          ) : (
            <>
              <p className="ac-note">
                Curriculum pipeline:{" "}
                <strong>
                  {selected.curriculumImport?.status.toLowerCase() ??
                    "awaiting publication"}
                </strong>
              </p>
              {agents ? (
                <UnifiedCoursePublicationForm
                  packageId={selected.id}
                  agents={agents}
                />
              ) : (
                <Unavailable what="The package agent configuration" />
              )}
            </>
          )}
          <RejectForm packageId={selected.id} />
        </Panel>
      )}

      {selected?.status === "PUBLISHED" && selected.course?.offerId && (
        <Panel id="offer" title="Published offer">
          <p>
            <Link className="ac-link" href={`/courses/${selected.course.slug}`}>
              /courses/{selected.course.slug}
            </Link>{" "}
            <Pill
              tone={
                selected.course.offerState === "PUBLISHED" ? "good" : "neutral"
              }
            >
              {selected.course.offerState?.toLowerCase() ?? ""}
            </Pill>
          </p>
          <h3 className="acad-h3">Public sale</h3>
          {selected.course.saleMode === "PUBLIC_SALE" ? (
            <p>
              <Pill tone="good">public sale</Pill> In the catalogue; learners
              buy access through secure checkout and activate their own
              timetable.
            </p>
          ) : canManageSelected &&
            selected.course.offerState === "PUBLISHED" ? (
            <EnableSaleForm
              offerId={selected.course.offerId}
              pending={selected.pendingDecisions}
            />
          ) : null}
          <p className="ac-muted">
            Use a 100% course coupon for authorised complimentary access. The
            learner activates their own timetable.
          </p>
          {canManageSelected && selected.course.offerState === "PUBLISHED" && (
            <ArchiveForm offerId={selected.course.offerId} />
          )}
        </Panel>
      )}

      <Panel
        id="labs"
        title="Practical evaluations"
        description="Graded practical submissions awaiting a human academic evaluation against the package rubric."
      >
        {labs === null ? (
          <Unavailable what="The practical evaluation queue" />
        ) : labs.length === 0 ? (
          <Empty title="Nothing awaiting evaluation" />
        ) : (
          <ul className="acad-list">
            {labs.map((l) => (
              <li key={l.submissionId}>
                <strong>{l.title ?? l.labRef}</strong>{" "}
                <span className="ac-muted">· {l.courseTitle}</span>
                <p className="acad-submission">{l.body}</p>
                {l.markingGuidance && (
                  <p className="ac-note">
                    Marking guidance: {l.markingGuidance}
                  </p>
                )}
                {l.rubric.length && l.markingGuidance ? (
                  <MarkLabForm
                    submissionId={l.submissionId}
                    rubric={l.rubric}
                  />
                ) : (
                  <p className="ac-muted">
                    No approved rubric yet: this practical cannot be marked.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="ac-muted">
        Formats:{" "}
        {Object.values(ACADEMY_FORMATS)
          .map((f) => `${f.label} ${f.weeks} weeks`)
          .join(" · ")}
        . A course offers only the formats its blueprint can complete.
      </p>
    </AdminShell>
  );
}
