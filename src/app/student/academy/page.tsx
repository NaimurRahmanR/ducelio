import Link from "next/link";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  getMyAcademyProgress,
  getMyAcademyResults,
  getMyAcademyTimetable,
  listMyAcademyEnrolments,
} from "@/server/academy-delivery";
import { AcademyShell } from "@/components/academy-shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import {
  ScheduleRevision,
  SchedulePlanner,
} from "@/components/academy-schedule-planner";
import {
  LabSubmissionForm,
  StartAssessmentForm,
} from "@/components/academy-learner-forms";
import {
  KIND_LABELS,
  WEEKDAYS,
  percent,
  type AcademyTimetable,
} from "@/domain/academy-delivery";
import { ACADEMY_FORMATS } from "@/domain/academy-scheduler";
import { enterAcademyClassAction } from "./classroom/actions";
import { academyClassDenialText } from "@/server/academy-professor-classroom";
import { openLabSupportAction } from "./support/actions";
import { academySupportDenialText } from "@/server/academy-support";

export const dynamic = "force-dynamic";

const fmt = (iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { ...opts, timeZone }).format(new Date(iso));
const dayHeading = (d: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));
const isoDate = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

function Timetable({
  timetable,
  enrolmentId,
}: {
  timetable: AcademyTimetable;
  enrolmentId: string;
}) {
  const s = timetable.schedule!;
  const now = Date.parse(timetable.serverTime ?? new Date().toISOString());
  const days = new Map<string, AcademyTimetable["items"]>();
  for (const i of timetable.items)
    days.set(i.localDate, [...(days.get(i.localDate) ?? []), i]);
  return (
    <ol className="acad-timetable">
      {[...days].map(([date, items]) => {
        const past = Date.parse(items.at(-1)!.endsAt) < now;
        return (
          <li key={date} className={past ? "past" : ""}>
            <h3>
              {dayHeading(date)}{" "}
              <span className="muted">
                ·{" "}
                {fmt(items[0].startsAt, s.timezone, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </h3>
            <ul>
              {items.map((i) => (
                <li key={i.id} className={`acad-item ${i.kind.toLowerCase()}`}>
                  <Badge
                    tone={
                      i.kind === "ASSESSMENT"
                        ? "gold"
                        : i.kind === "LAB"
                          ? "green"
                          : "blue"
                    }
                  >
                    {KIND_LABELS[i.kind]}
                  </Badge>
                  <div>
                    <p className="acad-item-title">
                      {i.kind === "LESSON" &&
                      i.part === 1 &&
                      Date.parse(i.startsAt) <= now &&
                      !timetable.examActive &&
                      !timetable.accessRevoked ? (
                        <Link
                          href={`/student/academy/lesson?enrolmentId=${enrolmentId}&lesson=${encodeURIComponent(i.ref)}`}
                        >
                          {i.title}
                        </Link>
                      ) : (
                        i.title
                      )}
                      {i.parts > 1 && (
                        <span className="muted">
                          {" "}
                          · part {i.part} of {i.parts}
                        </span>
                      )}
                    </p>
                    <p className="muted">
                      {fmt(i.startsAt, s.timezone, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · {i.minutes} min
                      {i.kind === "LESSON" &&
                        i.classOpened &&
                        " · class opened"}
                      {i.kind === "LESSON" &&
                        (i.teachingTurns ?? 0) > 0 &&
                        ` · ${i.teachingTurns} Professor exchange${i.teachingTurns === 1 ? "" : "s"}`}
                      {i.kind === "ASSESSMENT" &&
                        ` · sitting window until ${fmt(i.closesAt!, s.timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                    </p>
                    {i.kind === "LESSON" &&
                      timetable.status === "ACTIVE" &&
                      !timetable.examActive &&
                      !timetable.accessRevoked &&
                      (Date.parse(i.startsAt) <= now ? (
                        <form action={enterAcademyClassAction}>
                          <input
                            type="hidden"
                            name="enrolmentId"
                            value={enrolmentId}
                          />
                          <input
                            type="hidden"
                            name="scheduleItemId"
                            value={i.id}
                          />
                          <button className="button secondary" type="submit">
                            {i.classOpened
                              ? "Resume AI class"
                              : Date.parse(i.endsAt) < now
                                ? "Catch up with Professor"
                                : "Enter AI class"}
                          </button>
                        </form>
                      ) : (
                        <p className="muted">
                          AI class opens at its scheduled time.
                        </p>
                      ))}
                    {i.kind === "ASSESSMENT" &&
                      (i.attempts ? (
                        <p className="muted">
                          {i.attempts} attempt{i.attempts === 1 ? "" : "s"}{" "}
                          recorded.
                        </p>
                      ) : Date.parse(i.opensAt!) <= now &&
                        now < Date.parse(i.closesAt!) ? (
                        <StartAssessmentForm
                          enrolmentId={enrolmentId}
                          assessmentRef={i.ref}
                          label="Start assessment"
                        />
                      ) : Date.parse(i.opensAt!) > now ? (
                        <p className="muted">
                          Opens{" "}
                          {fmt(i.opensAt!, s.timezone, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          .
                        </p>
                      ) : (
                        <p className="muted">The sitting window has closed.</p>
                      ))}
                    {i.kind === "LAB" &&
                      i.part === 1 &&
                      (i.labSubmitted ? (
                        <p className="muted">Submitted.</p>
                      ) : Date.parse(i.startsAt) <= now ? (
                        <LabSubmissionForm
                          enrolmentId={enrolmentId}
                          labRef={i.ref}
                          title={i.title ?? i.ref}
                        />
                      ) : null)}
                    {i.kind === "LAB" &&
                      timetable.status === "ACTIVE" &&
                      !timetable.examActive &&
                      !timetable.accessRevoked &&
                      Date.parse(i.startsAt) <= now &&
                      (i.labGraded ? (
                        <p className="muted">
                          This practical is assessed, so AI Lab Instructor help
                          is not available for it.
                        </p>
                      ) : (
                        <form action={openLabSupportAction}>
                          <input
                            type="hidden"
                            name="enrolmentId"
                            value={enrolmentId}
                          />
                          <input
                            type="hidden"
                            name="scheduleItemId"
                            value={i.id}
                          />
                          <button className="button secondary" type="submit">
                            Get help from the AI Lab Instructor
                          </button>
                        </form>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    enrolmentId?: string;
    classNotice?: string;
    supportNotice?: string;
  }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const enrolments = await listMyAcademyEnrolments().catch(() => null);
  const selected =
    enrolments?.find((e) => e.enrolmentId === params.enrolmentId) ??
    enrolments?.[0];
  const [timetable, results, progress] = selected?.schedule
    ? await Promise.all([
        getMyAcademyTimetable(selected.enrolmentId).catch(() => null),
        getMyAcademyResults(selected.enrolmentId).catch(() => null),
        getMyAcademyProgress(selected.enrolmentId).catch(() => null),
      ])
    : [null, null, null];
  const format = selected?.formats.find(
    (f) => f.formatId === selected.formatId,
  );

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <p className="eyebrow">DUCELIO ACADEMY</p>
        <h1>My Academy courses</h1>
        <p className="muted">Self-paced courses on a timetable you choose.</p>
      </div>
      <div className="section-content acad-learner">
        {enrolments === null ? (
          <Card>
            <p role="alert">
              Your Academy courses could not be loaded. Nothing has changed; try
              again shortly.
            </p>
          </Card>
        ) : !selected ? (
          <EmptyState title="No Academy courses yet">
            When you have access to an Academy course it appears here, ready for
            you to plan. <Link href="/courses">Browse courses</Link>
          </EmptyState>
        ) : (
          <>
            {enrolments.length > 1 && (
              <form method="get" className="acad-inline-form">
                <label>
                  Course
                  <select
                    name="enrolmentId"
                    defaultValue={selected.enrolmentId}
                  >
                    {enrolments.map((e) => (
                      <option key={e.enrolmentId} value={e.enrolmentId}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button secondary">Open</button>
              </form>
            )}
            <Card>
              <div className="acad-course-head">
                <div>
                  <h2>{selected.title}</h2>
                  <p className="muted">
                    {selected.formatId
                      ? `${ACADEMY_FORMATS[selected.formatId].label} · ${ACADEMY_FORMATS[selected.formatId].weeks} weeks`
                      : "Choose your learning format and timetable to begin."}
                    {selected.schedule &&
                      ` · ${selected.schedule.studyDays.map((d) => WEEKDAYS[d - 1][1]).join(", ")} at ${selected.schedule.localTime} (${selected.schedule.timezone})`}
                  </p>
                </div>
                <Badge
                  tone={selected.status === "COMPLETED" ? "green" : "blue"}
                >
                  {selected.status === "COMPLETED" ? "Completed" : "Active"}
                </Badge>
              </div>
              {!selected.schedule && (
                <SchedulePlanner
                  enrolmentId={selected.enrolmentId}
                  formats={selected.formats}
                  fixedFormatId={selected.fixedFormatId}
                  today={isoDate(0)}
                />
              )}
            </Card>
            {params.classNotice && (
              <Card>
                <p role="status">
                  {academyClassDenialText(params.classNotice)}
                </p>
              </Card>
            )}
            {params.supportNotice && (
              <Card>
                <p role="status">
                  {academySupportDenialText(params.supportNotice)}
                </p>
              </Card>
            )}
            {timetable?.accessRevoked && (
              <Card>
                <p role="status">
                  Access to this course has ended (for example after a refund).
                  Your timetable history and results remain available below.
                </p>
              </Card>
            )}
            {timetable?.examActive && (
              <Card>
                <p role="status">
                  A controlled assessment is in progress. Lessons, practicals
                  and AI explanations are closed until it ends.
                </p>
              </Card>
            )}
            {progress && (
              <Card>
                <h2>Progress</h2>
                <p>
                  {progress.released} of {progress.lessons} lessons released ·{" "}
                  {progress.classesOpened} AI classes opened ·{" "}
                  {progress.teachingInteractions} Professor exchanges ·{" "}
                  {progress.studied} confirmed as studied by you.
                </p>
                <p className="muted">
                  Opening a class, talking with the Professor and confirming
                  study are records of your learning activity. None of them is
                  attendance, a mark or mastery.
                </p>
                <p className="muted">
                  Objective mastery ({progress.policyVersion}) comes only from
                  marked assessments and practicals:{" "}
                  {
                    progress.objectives.filter(
                      (o) => o.state === "DEMONSTRATED",
                    ).length
                  }{" "}
                  demonstrated,{" "}
                  {
                    progress.objectives.filter((o) => o.state === "DEVELOPING")
                      .length
                  }{" "}
                  developing,{" "}
                  {
                    progress.objectives.filter(
                      (o) => o.state === "NEEDS_REINFORCEMENT",
                    ).length
                  }{" "}
                  need reinforcement, of {progress.objectives.length}.
                </p>
              </Card>
            )}
            {results && (
              <Card>
                <h2>Results</h2>
                {results.pendingDecisions.length > 0 && (
                  <p className="notice" role="status">
                    Provisional: this course&apos;s academic policy is still
                    pending approval ({results.pendingDecisions.join(", ")}).
                    Scores are shown, but no official completion can be recorded
                    yet.
                  </p>
                )}
                <p>
                  {results.outcome === "PASSED" &&
                  results.pendingDecisions.length > 0
                    ? `Provisional score ${percent(results.courseScoreBp)} against a proposed ${percent(results.passMarkBp)} pass mark.`
                    : results.outcome === "PASSED"
                      ? `Course completed with ${percent(results.courseScoreBp)} (pass mark ${percent(results.passMarkBp)}).`
                      : results.outcome === "NOT_PASSED"
                        ? `Every component is marked: ${percent(results.courseScoreBp)}, below the ${percent(results.passMarkBp)} pass mark.`
                        : `In progress. The course pass mark is ${percent(results.passMarkBp)}.`}
                </p>
                <ul className="acad-results">
                  {results.components.map((c) => (
                    <li key={c.componentKey}>
                      <span>
                        {c.title ??
                          (c.source === "LABS"
                            ? "Practical work"
                            : c.componentKey)}
                      </span>
                      <span className="muted">
                        weight {percent(c.weightBp)}
                      </span>
                      <strong>
                        {c.status === "GRADED"
                          ? percent(c.scoreBp)
                          : "Not yet marked"}
                      </strong>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Ducelio prepares you for external qualifications; it does not
                  award them.
                </p>
              </Card>
            )}
            {timetable?.schedule && (
              <Card>
                <h2>Your timetable</h2>
                <p className="muted">
                  {dayHeading(timetable.schedule.startOn)} to{" "}
                  {dayHeading(timetable.schedule.endOn)} · revision{" "}
                  {timetable.schedule.revision}. Lesson materials open from your
                  timetable. Each scheduled lesson has an AI class with the
                  Professor, open from its start time.
                </p>
                <Timetable
                  timetable={timetable}
                  enrolmentId={selected.enrolmentId}
                />
              </Card>
            )}
            {selected.schedule && selected.status === "ACTIVE" && format && (
              <Card>
                <details>
                  <summary>Change future dates</summary>
                  <ScheduleRevision
                    enrolmentId={selected.enrolmentId}
                    revision={selected.schedule.revision}
                    format={format}
                    current={selected.schedule}
                    tomorrow={isoDate(1)}
                  />
                </details>
              </Card>
            )}
          </>
        )}
      </div>
    </AcademyShell>
  );
}
