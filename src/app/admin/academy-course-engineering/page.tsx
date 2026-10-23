import Link from "next/link";
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
  GrantForm,
  MarkLabForm,
  PrepareCurriculumForm,
  PublishForm,
  RejectForm,
} from "@/components/academy-course-engineering-forms";
import {
  adminWorkspaceAccess,
  COURSE_ADMIN_ROLES,
} from "@/server/admin-access";
import {
  getAcademyPackageReview,
  listAcademyLabSubmissions,
  listAcademyPackages,
} from "@/server/academy-course-engineering";
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

const STEPS = ["Upload", "Validate", "Review", "Publish"] as const;
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
          `${a.sittingWindowHours} h`,
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
  searchParams: Promise<{ packageId?: string }>;
}) {
  const access = await adminWorkspaceAccess(COURSE_ADMIN_ROLES);
  if (!access.allowed)
    return (
      <AdminForbidden
        actor={access.actor}
        active="courses"
        title="Academy Course Engineering"
        requires={COURSE_ADMIN_ROLES}
      />
    );
  const actor = access.actor;
  const params = await searchParams;
  const register = await listAcademyPackages().then(
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
      title="Academy Course Engineering"
      description="Direct-to-learner courses: upload one complete package, review it and publish. No cohorts, instructors or manual quiz and lab setup."
      actions={
        <Link href="/admin/course-engineering" className="ac-button secondary">
          Organisation Course Engineering
        </Link>
      }
    >
      <Stepper step={step} />
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
        <AcademyUploadForm />
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
                  href={`/admin/academy-course-engineering?packageId=${p.id}`}
                  className="ac-course-title"
                >
                  {p.title ?? p.packageKey}
                </Link>
                <span className="ac-muted">
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
            <Review review={review} />
          ) : (
            <Unavailable what="The review summary" />
          )}
        </Panel>
      )}

      {selected?.status === "VALIDATED" && review && (
        <Panel
          id="publish"
          title="Approve and publish"
          description="Publication is a separate, explicit decision. The curriculum first passes the existing curriculum publication pipeline and pre-publication test, unchanged."
        >
          <p className="ac-note">
            Curriculum pipeline:{" "}
            <strong>
              {selected.curriculumImport?.status.toLowerCase() ?? "not started"}
            </strong>
          </p>
          <PrepareCurriculumForm
            packageId={selected.id}
            disabled={curriculumPublished}
          />
          <PublishForm
            packageId={selected.id}
            ready={curriculumPublished}
            formats={review.formats.map((f) => ({
              formatId: f.formatId,
              summary: `${f.sessionsRequired} classes of ${f.sessionMinutes} min · ${f.minStudyDaysPerWeek}–${f.maxStudyDaysPerWeek} days a week`,
            }))}
          />
          <RejectForm packageId={selected.id} />
        </Panel>
      )}

      {selected?.status === "PUBLISHED" && selected.course?.offerId && (
        <Panel id="offer" title="Published offer">
          <p>
            <Link className="ac-link" href={`/academy/${selected.course.slug}`}>
              /academy/{selected.course.slug}
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
              buy a format through Stripe checkout.
            </p>
          ) : selected.course.offerState === "PUBLISHED" ? (
            <EnableSaleForm
              offerId={selected.course.offerId}
              pending={selected.pendingDecisions}
            />
          ) : null}
          <h3 className="acad-h3">Authorised access</h3>
          <p className="ac-muted">
            Complimentary or reviewer access creates an individual enrolment,
            including for review-only courses.
          </p>
          <GrantForm
            offerId={selected.course.offerId}
            formats={(review?.formats ?? []).map((f) => f.formatId)}
          />
          {selected.course.offerState === "PUBLISHED" && (
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
