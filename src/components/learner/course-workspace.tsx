import Link from "next/link";
import type { ReactNode } from "react";
import {
  BookOpenCheck,
  ClipboardCheck,
  FlaskConical,
  GraduationCap,
  LineChart,
  MessageSquareText,
} from "lucide-react";
import { Badge, Progress } from "@/components/ui";
import type { ActivityState, CourseWorkspace } from "@/domain/learner-contract";
import {
  STATE_LABEL,
  STATE_TONE,
  activityTitle,
  courseStatusLabel,
  courseStatusTone,
  formatDateTime,
  ratio,
} from "./learner-format";
import { ProgressionMeasures } from "./progression";
import { ReleasedResultsTable } from "./results-table";
import {
  CheckInForm,
  ElapsedTimer,
  StartAssessmentForm,
  type LearnerFormAction,
  type LearnerFormSubmit,
} from "./workspace-controls";

function durationText(fromIso: string, toIso: string): string | null {
  const minutes = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

function Panel({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="ln-panel ln-wpanel"
      aria-labelledby={`ln-${id}-heading`}
      data-panel={id}
    >
      <h2 id={`ln-${id}-heading`} className="ln-wpanel__title">
        <span className="ln-wpanel__icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Window({
  opensAt,
  closesAt,
  timeZone,
}: {
  opensAt: string | null;
  closesAt: string | null;
  timeZone: string;
}) {
  if (!opensAt || !closesAt) return null;
  const length = durationText(opensAt, closesAt);
  return (
    <div>
      <dt>Available</dt>
      <dd>
        {formatDateTime(opensAt, timeZone)} until{" "}
        {formatDateTime(closesAt, timeZone)}
        {length && <span className="ln-muted"> ({length})</span>}
      </dd>
    </div>
  );
}

const CLASS_CLOSED_TEXT: Partial<Record<ActivityState, string>> = {
  UPCOMING: "Attendance opens at the scheduled start.",
  MISSED:
    "This class closed with no attendance. It is not marked completed; your next class includes a short recap.",
  CLOSED: "The attendance window for this class has closed.",
};

const LAB_BLOCKED_TEXT: Partial<Record<ActivityState, string>> = {
  UPCOMING: "The practical opens at its scheduled start.",
  MISSED: "The practical window closed with no submission.",
  CLOSED: "The practical window has closed.",
  SUBMITTED: "Your practical work is submitted.",
};

// /student/courses/[enrolmentId]: three rows of two panels. Every value
// comes from the learner's own workspace projection; every control posts
// only identifiers to a server action that re-derives ownership, the
// window and the assessment firewall.
export function CourseWorkspaceView({
  workspace,
  serverTime,
  timeZone = "UTC",
  checkInAction,
  enterClassAction,
  openTutorAction,
  startAssessmentAction,
  attendLabAction,
  labEvidenceSlot,
  tutorNotesHref = "/student/tutor-notes",
}: {
  workspace: CourseWorkspace | null;
  serverTime: string;
  timeZone?: string;
  checkInAction: LearnerFormAction;
  enterClassAction?: LearnerFormSubmit;
  openTutorAction: LearnerFormSubmit;
  startAssessmentAction: LearnerFormAction;
  attendLabAction: LearnerFormSubmit;
  labEvidenceSlot?: ReactNode;
  tutorNotesHref?: string;
}) {
  if (!workspace)
    return (
      <div className="ln-page">
        <header className="ln-page__head">
          <h1>Course</h1>
        </header>
        <div className="ln-panel">
          <p role="alert">
            This course could not be loaded. Nothing has changed; try again
            shortly. <Link href="/student/learning">Back to My Learning</Link>
          </p>
        </div>
      </div>
    );
  const { course, currentClass: cls, assessment, lab } = workspace;
  const enrolmentId = course.enrolmentId;
  const covered = cls?.evidence.lessonObjectives.filter(
    (o) => o.covered,
  ).length;
  const objectiveTotal = cls?.evidence.lessonObjectives.length ?? 0;
  const coveredRatio = ratio(covered ?? 0, objectiveTotal);
  return (
    <div className="ln-page ln-workspace">
      <header className="ln-page__head ln-workspace__head">
        <div>
          <p className="ln-eyebrow">{course.provider}</p>
          <h1>{course.title}</h1>
        </div>
        <Badge tone={courseStatusTone(course)}>
          {courseStatusLabel(course)}
        </Badge>
      </header>
      {course.accessRevoked && (
        <p className="ln-banner" role="status">
          Access to this course has ended. Your history and results are
          preserved.
        </p>
      )}
      {!course.accessRevoked && !course.scheduled && (
        <p className="ln-banner" role="status">
          Choose your timetable to begin this course.{" "}
          <Link
            className="ln-textlink"
            href={`/student/academy?enrolmentId=${encodeURIComponent(enrolmentId)}&activate=true`}
          >
            Choose timetable
          </Link>
        </p>
      )}

      <div className="ln-wrow" data-row="1">
        <Panel
          id="classroom"
          title="Professor Classroom"
          icon={<GraduationCap size={18} />}
        >
          {!cls ? (
            <p className="ln-empty-line">
              No class is open or scheduled next.{" "}
              <Link className="ln-textlink" href="/student/timetable">
                See your timetable
              </Link>
            </p>
          ) : (
            <>
              <h3 className="ln-wpanel__item">{activityTitle(cls)}</h3>
              <Badge tone={STATE_TONE[cls.state]}>
                {STATE_LABEL[cls.state]}
              </Badge>
              <dl className="ln-facts">
                <div>
                  <dt>Scheduled start</dt>
                  <dd>{formatDateTime(cls.startsAt, timeZone)}</dd>
                </div>
                <Window
                  opensAt={cls.opensAt}
                  closesAt={cls.closesAt}
                  timeZone={timeZone}
                />
                <div>
                  <dt>Attendance</dt>
                  <dd>
                    {cls.evidence.checkedInAt ? (
                      <>
                        Recorded at{" "}
                        {formatDateTime(cls.evidence.checkedInAt, timeZone)} ·{" "}
                        <ElapsedTimer
                          since={cls.evidence.checkedInAt}
                          serverTime={serverTime}
                        />{" "}
                        <span className="ln-muted">since check-in</span>
                      </>
                    ) : (
                      "Not yet recorded"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Correct in-class answers (judged by the AI Professor)</dt>
                  <dd>{cls.evidence.correctInClassAnswers}</dd>
                </div>
              </dl>
              <div className="ln-measure">
                <div className="ln-measure__row">
                  <span className="ln-measure__label">Objectives covered</span>
                  <span className="ln-measure__value">
                    {objectiveTotal === 0
                      ? "None recorded"
                      : `${covered} of ${objectiveTotal} verified`}
                  </span>
                </div>
                {coveredRatio !== null && (
                  <Progress
                    value={coveredRatio}
                    label="Objectives covered"
                    valueText={`${covered} of ${objectiveTotal} objectives covered`}
                  />
                )}
              </div>
              <div className="ln-actions">
                {!cls.evidence.checkedInAt &&
                  cls.state === "OPEN" &&
                  !course.accessRevoked && (
                    <CheckInForm
                      enrolmentId={enrolmentId}
                      scheduleItemId={cls.itemId}
                      checkInAction={checkInAction}
                    />
                  )}
                {cls.classroomId ? (
                  <Link
                    className="button secondary"
                    href={`/student/academy/classroom/${encodeURIComponent(cls.classroomId)}`}
                  >
                    Enter classroom
                  </Link>
                ) : (
                  enterClassAction &&
                  cls.state === "OPEN" &&
                  !course.accessRevoked && (
                    <form action={enterClassAction} className="ln-inline-form">
                      <input
                        type="hidden"
                        name="enrolmentId"
                        value={enrolmentId}
                      />
                      <input
                        type="hidden"
                        name="scheduleItemId"
                        value={cls.itemId}
                      />
                      <button className="button secondary">
                        Enter classroom
                      </button>
                    </form>
                  )
                )}
              </div>
              {!cls.evidence.checkedInAt && CLASS_CLOSED_TEXT[cls.state] && (
                <p className="ln-muted">{CLASS_CLOSED_TEXT[cls.state]}</p>
              )}
              <p className="ln-note">
                Attendance records that you were present. It is not completion
                or mastery; objectives are mastered only through released
                assessments and practicals.
              </p>
            </>
          )}
        </Panel>

        <Panel
          id="tutor"
          title="AI Tutor"
          icon={<MessageSquareText size={18} />}
        >
          {!workspace.tutorAvailable ? (
            <p className="ln-empty-line" role="status">
              The AI Tutor is closed while a controlled assessment is in
              progress. It opens again when the assessment ends.
            </p>
          ) : (
            <>
              <p className="ln-muted">
                Ask about this course&apos;s content. The Tutor explains and
                summarises; it does not do assessed work for you.
              </p>
              {cls ? (
                <form action={openTutorAction} className="ln-quick-actions">
                  <input type="hidden" name="enrolmentId" value={enrolmentId} />
                  <input
                    type="hidden"
                    name="scheduleItemId"
                    value={cls.itemId}
                  />
                  <input type="hidden" name="lessonRef" value={cls.ref} />
                  <button
                    className="button secondary"
                    name="request"
                    value="CLASS_NOTES"
                  >
                    Give Class Notes
                  </button>
                  <button
                    className="button secondary"
                    name="request"
                    value="EXPLAIN_TOPICS"
                  >
                    Explain Class Topics
                  </button>
                </form>
              ) : (
                <p className="ln-muted">
                  Class notes and topic explanations open once a class is on
                  your timetable.
                </p>
              )}
              <form action={openTutorAction} className="ln-tutor-chat">
                <input type="hidden" name="enrolmentId" value={enrolmentId} />
                {cls && (
                  <>
                    <input
                      type="hidden"
                      name="scheduleItemId"
                      value={cls.itemId}
                    />
                    <input type="hidden" name="lessonRef" value={cls.ref} />
                  </>
                )}
                <input type="hidden" name="request" value="QUESTION" />
                <label htmlFor="ln-tutor-message" className="ln-label">
                  Ask the Tutor
                </label>
                <textarea
                  id="ln-tutor-message"
                  name="message"
                  rows={3}
                  minLength={1}
                  maxLength={1000}
                  required
                />
                <button className="button">Ask the Tutor</button>
              </form>
              <Link className="ln-textlink" href={tutorNotesHref}>
                Previous class notes
              </Link>
            </>
          )}
        </Panel>
      </div>

      <div className="ln-wrow" data-row="2">
        <Panel
          id="assessment"
          title="Assessment Centre"
          icon={<ClipboardCheck size={18} />}
        >
          {!assessment ? (
            <p className="ln-empty-line">
              No assessment is scheduled for this course yet.
            </p>
          ) : (
            <>
              <h3 className="ln-wpanel__item">{assessment.title}</h3>
              <Badge tone={STATE_TONE[assessment.state]}>
                {STATE_LABEL[assessment.state]}
              </Badge>
              <dl className="ln-facts">
                <Window
                  opensAt={assessment.opensAt}
                  closesAt={assessment.closesAt}
                  timeZone={timeZone}
                />
                <div>
                  <dt>Duration</dt>
                  <dd>{assessment.durationMinutes} minutes</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>
                    {assessment.attemptsUsed} of {assessment.attemptsAllowed}{" "}
                    used
                  </dd>
                </div>
              </dl>
              {assessment.activeAttemptId ? (
                <Link
                  className="button"
                  href={`/student/academy/attempt/${encodeURIComponent(assessment.activeAttemptId)}`}
                >
                  Resume {assessment.title}
                </Link>
              ) : assessment.canStart ? (
                <StartAssessmentForm
                  enrolmentId={enrolmentId}
                  assessmentRef={assessment.ref}
                  label={`Take ${assessment.title}`}
                  startAssessmentAction={startAssessmentAction}
                />
              ) : (
                <p className="ln-blocked" role="status">
                  {assessment.reason ??
                    (assessment.state === "RELEASED"
                      ? "Results for this assessment are released below."
                      : "This assessment cannot be started now.")}
                </p>
              )}
              <p className="ln-note">
                Both attempts must start inside the window. An attempt ends when
                its time runs out or the window closes, whichever is first.
                Scores appear only after the window closes.
              </p>
            </>
          )}
        </Panel>

        <Panel id="lab" title="Practical Lab" icon={<FlaskConical size={18} />}>
          {!lab ? (
            <p className="ln-empty-line">
              No practical is scheduled for this course yet.
            </p>
          ) : (
            <>
              <h3 className="ln-wpanel__item">{lab.title}</h3>
              <Badge tone={STATE_TONE[lab.state]}>
                {STATE_LABEL[lab.state]}
              </Badge>
              <dl className="ln-facts">
                <Window
                  opensAt={lab.opensAt}
                  closesAt={lab.closesAt}
                  timeZone={timeZone}
                />
                <div>
                  <dt>Submission</dt>
                  <dd>
                    {lab.graded
                      ? "Submitted and graded"
                      : lab.submitted
                        ? "Submitted, awaiting grading"
                        : "Not submitted"}
                  </dd>
                </div>
              </dl>
              <form action={attendLabAction} className="ln-inline-form">
                <input type="hidden" name="enrolmentId" value={enrolmentId} />
                <input type="hidden" name="scheduleItemId" value={lab.itemId} />
                <button
                  className="button"
                  disabled={!lab.canAttend || course.accessRevoked}
                  aria-describedby={
                    lab.canAttend ? undefined : "ln-lab-blocked"
                  }
                >
                  Attend Practical Class
                </button>
              </form>
              {!lab.canAttend && (
                <p id="ln-lab-blocked" className="ln-blocked">
                  {LAB_BLOCKED_TEXT[lab.state] ??
                    "The practical class is not open right now."}
                </p>
              )}
              {labEvidenceSlot && (
                <div className="ln-lab-evidence">
                  <h3>Practical evidence</h3>
                  {labEvidenceSlot}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>

      <div className="ln-wrow" data-row="3">
        <Panel id="results" title="Results" icon={<BookOpenCheck size={18} />}>
          <ReleasedResultsTable
            results={workspace.results}
            caption={`Released results for ${course.title}`}
            timeZone={timeZone}
            showCourse={false}
          />
        </Panel>
        <Panel
          id="progression"
          title="Course Progression"
          icon={<LineChart size={18} />}
        >
          <ProgressionMeasures
            progression={workspace.progression}
            timeZone={timeZone}
          />
          <Link
            className="ln-textlink"
            href={`/student/courses/${encodeURIComponent(enrolmentId)}/progression`}
          >
            View detailed progression
          </Link>
        </Panel>
      </div>
    </div>
  );
}
