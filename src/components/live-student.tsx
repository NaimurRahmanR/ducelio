import { AcademyShell } from "./academy-shell";
import { Card, EmptyState, Badge, ButtonLink } from "./ui";
import { getStudentAcademy } from "@/server/academy";
import { getStudentClassSessions } from "@/server/class-sessions";
import { getStudentAttendance } from "@/server/attendance";
import { getStudentLessonProgress } from "@/server/lesson-progress";
import { getStudentLearningResources } from "@/server/learning-resources";
import { getStudentLearningEvidence } from "@/server/learning-evidence";
import { getStudentObjectiveMastery } from "@/server/objective-mastery";
import {
  getAssignedCounsellor,
  getStudyPlan,
  getSupportFollowups,
  getStudentSupportProfile,
  getOpenSupportEvents,
} from "@/server/support";
import { listMyProfessorClassroomSessionIds } from "@/server/professor-classroom";
import { previewClassroomEligibility } from "@/domain/professor-classroom";
import { SupportForms } from "./support-forms";
import { SarahIdentity, SARAH_IS_AI_NOTICE } from "./sarah-identity";
import { AiLearningTeamCard } from "./ai-learning-team";
import { randomUUID } from "node:crypto";
import { listMySessionFeedbackOpportunities } from "@/server/session-feedback";
import { SarahSessionFeedback } from "./sarah-session-feedback";
import {
  formatLearnerDateTime,
  learnerDisplayTimeZone,
} from "@/domain/learner-time";
import { LearnerTimeRange } from "./learner-time-range";

function sessionTone(status: string) {
  return status === "SCHEDULED"
    ? "green"
    : status === "CANCELLED"
      ? "gold"
      : "muted";
}

export async function LiveStudent({ section = "" }: { section?: string }) {
  const { actor, enrolments, profile } = await getStudentAcademy();
  const [
    counsellor,
    study,
    followups,
    support,
    events,
    sessions,
    attendance,
    lessonProgress,
    resources,
    evidence,
    mastery,
    openedClassroomSessionIds,
  ] = await Promise.all([
    getAssignedCounsellor(actor.id),
    getStudyPlan(actor.id),
    getSupportFollowups(actor.id),
    getStudentSupportProfile(actor.id),
    getOpenSupportEvents(actor.id),
    getStudentClassSessions(),
    getStudentAttendance(),
    getStudentLessonProgress(),
    getStudentLearningResources(),
    getStudentLearningEvidence(),
    getStudentObjectiveMastery(),
    listMyProfessorClassroomSessionIds(),
  ]);
  // AC-6: Sarah's structured post-session feedback prompts, only on the
  // classes view and only when the database lists an eligible session.
  const feedback =
    section === "classes" ? await listMySessionFeedbackOpportunities() : null;
  const attendanceBySession = new Map(
    attendance.map((record) => [record.session_id, record]),
  );
  const now = new Date();
  const zone = learnerDisplayTimeZone(profile?.timezone);
  const zoneNotice =
    zone === profile?.timezone
      ? `Times are shown in your profile time zone (${zone}).`
      : "Times are shown in UTC because your profile time zone could not be used.";
  const byStart = [...sessions].sort(
    (a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start),
  );
  // Upcoming first (soonest at the top), then past classes, most recent first.
  const sessionGroups = [
    {
      label: "Upcoming",
      sessions: byStart.filter(
        (session) => Date.parse(session.scheduled_end) >= now.getTime(),
      ),
    },
    {
      label: "Past",
      sessions: byStart
        .filter((session) => Date.parse(session.scheduled_end) < now.getTime())
        .reverse(),
    },
  ];
  const titles: Record<string, string> = {
    "": "Your academy",
    programme: "Your programme",
    support: "Your Support Centre",
    "study-plan": "Your study plan",
    profile: "Your profile",
    calendar: "Calendar",
    classes: "Classes",
    assignments: "Assignments",
    assessments: "Assessments",
    notes: "Notes & resources",
    results: "Results",
    announcements: "Academy noticeboard",
  };
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACADEMY</p>
          <h1>
            {section
              ? titles[section]
              : "Welcome, " + actor.displayName.split(" ")[0] + "."}
          </h1>
          <p>Your programme, your plan, your next step.</p>
        </div>
      </div>
      <div className="section-content">
        {(section === "" || section === "programme") && (
          <Card>
            <div className="section-heading">
              <h2>Programme enrolments</h2>
              {/* The public catalogue: offer detail, checkout and enrolment
                  keep their own rules; browsing needs no cohort assignment. */}
              <ButtonLink href="/courses" secondary>
                Explore more courses
              </ButtonLink>
            </div>
            {enrolments.length ? (
              enrolments.map((e) => (
                <div className="support-record" key={e.id}>
                  <Badge tone="green">{e.status}</Badge>
                  <h3>{e.programme_versions.title_snapshot}</h3>
                  <p>
                    {e.programme_versions.label} · {e.cohort_title_snapshot}
                  </p>
                  <p className="muted">
                    Cohort start: {e.cohort_starts_on_snapshot}
                  </p>
                  {e.programme_versions.is_demo && (
                    <Badge tone="gold">DEMO CURRICULUM</Badge>
                  )}
                  <p className="muted">
                    Lesson progress and objective mastery are separate. Mastery
                    comes only from validated learning evidence processed by the
                    deterministic policy.
                  </p>
                </div>
              ))
            ) : (
              <EmptyState title="Your next chapter starts here">
                No programme enrolment is recorded yet. Explore the published
                courses to enrol, or your academy registrar can add your
                programme.
              </EmptyState>
            )}
          </Card>
        )}
        {section === "calendar" && (
          <Card>
            <div className="section-heading">
              <div>
                <p className="eyebrow">YOUR SCHEDULE</p>
                <h2>Class calendar</h2>
              </div>
              <Badge tone="muted">ALL SESSIONS</Badge>
            </div>
            <p className="muted">
              {zoneNotice} Cancelled sessions remain visible for your records.
            </p>
            {sessions.length ? (
              sessionGroups.map(
                (group) =>
                  group.sessions.length > 0 && (
                    <section
                      key={group.label}
                      aria-label={`${group.label} classes`}
                    >
                      <h3>{group.label}</h3>
                      {group.sessions.map((session) => (
                        <div className="support-record" key={session.id}>
                          <Badge tone={sessionTone(session.status)}>
                            {session.status}
                          </Badge>
                          <h4>{session.lesson_title}</h4>
                          <p>
                            {session.programme_title} · {session.cohort_title}
                          </p>
                          <p>
                            <LearnerTimeRange
                              start={session.scheduled_start}
                              end={session.scheduled_end}
                              zone={zone}
                            />
                          </p>
                          <p className="muted">
                            Instructor: {session.instructor_name}
                          </p>
                        </div>
                      ))}
                    </section>
                  ),
              )
            ) : (
              <EmptyState title="No class sessions scheduled">
                Your class dates will appear here when sessions are scheduled
                for your cohort.
              </EmptyState>
            )}
            <ButtonLink href="/student/classes" secondary>
              Open classes and lesson access
            </ButtonLink>
          </Card>
        )}
        {section === "classes" && (
          <>
            {feedback?.status === "OK" && feedback.opportunities.length > 0 && (
              <SarahSessionFeedback
                showIdentity
                prompts={feedback.opportunities.map((opportunity) => ({
                  ...opportunity,
                  requestId: randomUUID(),
                }))}
              />
            )}
            <Card>
              <h2>Your class sessions</h2>
              <p className="muted">{zoneNotice}</p>
              {sessions.length ? (
                sessions.map((session) => {
                  const attendanceRecord = attendanceBySession.get(session.id);
                  const preview = previewClassroomEligibility(
                    {
                      status: session.status,
                      scheduledStart: session.scheduled_start,
                      scheduledEnd: session.scheduled_end,
                    },
                    now,
                  );
                  const alreadyOpened = openedClassroomSessionIds.has(
                    session.id,
                  );
                  return (
                    <div className="support-record" key={session.id}>
                      <Badge
                        tone={
                          session.status === "SCHEDULED"
                            ? "green"
                            : session.status === "CANCELLED"
                              ? "gold"
                              : "muted"
                        }
                      >
                        {session.status}
                      </Badge>
                      {attendanceRecord && (
                        <Badge
                          tone={
                            attendanceRecord.status === "PRESENT"
                              ? "green"
                              : attendanceRecord.status === "ABSENT"
                                ? "gold"
                                : "muted"
                          }
                        >
                          {attendanceRecord.status}
                        </Badge>
                      )}
                      <h3>{session.lesson_title}</h3>
                      <p>
                        {session.programme_title} · {session.cohort_title}
                      </p>
                      <p>
                        <LearnerTimeRange
                          start={session.scheduled_start}
                          end={session.scheduled_end}
                          zone={zone}
                        />{" "}
                        · {session.instructor_name}
                      </p>
                      {!attendanceRecord && session.status !== "CANCELLED" && (
                        <p className="muted">
                          Attendance has not yet been recorded.
                        </p>
                      )}
                      {preview.kind === "CANCELLED" && (
                        <p className="muted">
                          This class is cancelled and cannot be entered.
                        </p>
                      )}
                      {preview.kind === "FUTURE" && (
                        <p className="muted">
                          Starts at{" "}
                          <time
                            dateTime={new Date(
                              session.scheduled_start,
                            ).toISOString()}
                          >
                            {formatLearnerDateTime(
                              session.scheduled_start,
                              zone,
                            )}
                          </time>
                        </p>
                      )}
                      {preview.kind === "LIVE" && (
                        <ButtonLink href={`/student/classroom/${session.id}`}>
                          {alreadyOpened ? "Resume class" : "Start class"}
                        </ButtonLink>
                      )}
                      {preview.kind === "CATCH_UP" && (
                        <ButtonLink
                          href={`/student/classroom/${session.id}`}
                          secondary
                        >
                          {alreadyOpened ? "Resume catch-up" : "Start catch-up"}
                        </ButtonLink>
                      )}
                    </div>
                  );
                })
              ) : (
                <EmptyState title="No class sessions scheduled">
                  Your scheduled academy classes will appear here when they are
                  created for your cohort.
                </EmptyState>
              )}
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Your lesson progress</h2>
                <Badge tone="muted">NOT MASTERY</Badge>
              </div>
              {lessonProgress.length ? (
                lessonProgress.map((record) => (
                  <div className="support-record" key={record.id}>
                    <Badge
                      tone={record.status === "COMPLETED" ? "green" : "muted"}
                    >
                      {record.status.replace("_", " ")}
                    </Badge>
                    <h3>{record.lesson_segments.title}</h3>
                    <p>{record.lessons.title}</p>
                    <p className="muted">
                      Segment {record.lesson_segments.position} · updated{" "}
                      {formatLearnerDateTime(record.updated_at, zone)}
                    </p>
                  </div>
                ))
              ) : (
                <EmptyState title="No lesson progress recorded">
                  Planned-segment progress will appear here when authorised
                  teaching staff record it. Progress alone does not establish
                  mastery.
                </EmptyState>
              )}
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Your learning evidence</h2>
                <Badge tone="muted">INPUT TO MASTERY</Badge>
              </div>
              {evidence.length ? (
                evidence.map((record) => (
                  <div className="support-record" key={record.id}>
                    <Badge
                      tone={
                        record.result === "CORRECT"
                          ? "green"
                          : record.result === "INCORRECT"
                            ? "gold"
                            : "muted"
                      }
                    >
                      {record.result}
                    </Badge>
                    <h3>{record.lesson_objectives.description}</h3>
                    <p>{record.lessons.title}</p>
                    <p className="muted">
                      {record.evidence_kind.replaceAll("_", " ")} ·{" "}
                      {record.evidence_reference}
                    </p>
                    <p className="muted">
                      Recorded {formatLearnerDateTime(record.recorded_at, zone)}
                      . Evidence is evaluated by policy before mastery changes.
                    </p>
                  </div>
                ))
              ) : (
                <EmptyState title="No learning evidence recorded">
                  Validated observations against your learning objectives will
                  appear here.
                </EmptyState>
              )}
            </Card>
          </>
        )}
        {section === "notes" && (
          <Card>
            <div className="section-heading">
              <h2>Notes & resources</h2>
              <Badge tone="muted">VERSIONED CURRICULUM</Badge>
            </div>
            {resources.length ? (
              resources.map((resource) => (
                <div className="support-record" key={resource.id}>
                  <Badge
                    tone={resource.kind === "LECTURE_NOTE" ? "blue" : "muted"}
                  >
                    {resource.kind.replace("_", " ")}
                  </Badge>
                  <h3>{resource.title}</h3>
                  <p className="muted">
                    {resource.lessons.title} ·{" "}
                    {resource.programme_versions.label}
                  </p>
                  {resource.body && (
                    <div className="lesson-resource-body">{resource.body}</div>
                  )}
                  {resource.url && (
                    <a
                      className="text-link"
                      href={resource.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open approved reference →
                    </a>
                  )}
                </div>
              ))
            ) : (
              <EmptyState title="No learning resources available">
                Lecture notes and approved references for your enrolled
                curriculum will appear here after publication.
              </EmptyState>
            )}
          </Card>
        )}
        {section === "notes" && (
          <Card>
            <h2>Supplementary Tutor notes</h2>
            <p className="muted">
              Tutor answers you chose to keep are stored separately from the
              published course material above and never change it.
            </p>
            <ButtonLink href="/student/tutor-notes" secondary>
              Open your Tutor notes
            </ButtonLink>
          </Card>
        )}
        {section === "results" && (
          <Card>
            <h2>Formal assessment results</h2>
            <p className="muted">
              See your graded course components, pending results and official
              completion status in Course progress. The objective mastery
              records below are separate from your formal course grades.
            </p>
            <ButtonLink href="/student/progress" secondary>
              View graded results and course completion
            </ButtonLink>
          </Card>
        )}
        {section === "results" && (
          <Card>
            <div className="section-heading">
              <div>
                <p className="eyebrow">DETERMINISTIC OBJECTIVE STATE</p>
                <h2>Your mastery</h2>
              </div>
              <Badge tone="blue">MASTERY_V1</Badge>
            </div>
            <p className="muted">
              Demonstrated requires correct evidence across at least two class
              sessions and at least two evidence kinds. A later partial or
              incorrect observation can move an objective to needs
              reinforcement.
            </p>
            {mastery.length ? (
              mastery.map((record) => (
                <div className="support-record" key={record.id}>
                  <Badge
                    tone={
                      record.state === "DEMONSTRATED"
                        ? "green"
                        : record.state === "NEEDS_REINFORCEMENT"
                          ? "gold"
                          : record.state === "DEVELOPING"
                            ? "blue"
                            : "muted"
                    }
                  >
                    {record.state.replaceAll("_", " ")}
                  </Badge>
                  <h3>{record.lesson_objectives.description}</h3>
                  <p>{record.lessons.title}</p>
                  <p className="muted">
                    {record.evidence_count} evidence records ·{" "}
                    {record.correct_session_count} correct sessions ·{" "}
                    {record.correct_kind_count} correct evidence kinds
                  </p>
                  <p className="muted">
                    Evaluated {formatLearnerDateTime(record.evaluated_at, zone)}{" "}
                    · {record.policy_version}
                  </p>
                </div>
              ))
            ) : (
              <EmptyState title="No objective mastery state yet">
                Your mastery state appears only after validated learning
                evidence has been processed by the academy policy.
              </EmptyState>
            )}
          </Card>
        )}
        {(section === "" || section === "support") && (
          <div className="two-column">
            <Card className="counsellor-card">
              <h2>Your assigned counsellor</h2>
              {counsellor ? (
                <>
                  <h3>{counsellor.display_name}</h3>
                  <p className="muted">
                    Your assigned learner support partner.
                  </p>
                </>
              ) : (
                <p className="muted">
                  A human counsellor has not yet been assigned.
                </p>
              )}
              {support && <p>{support.study_goal}</p>}
              <ButtonLink href="/student/study-plan" secondary>
                View study plan
              </ButtonLink>
            </Card>
            <Card>
              <h2>Open follow-ups</h2>
              {followups.length ? (
                followups.map((f) => (
                  <div className="support-record" key={f.id}>
                    <h3>{f.title}</h3>
                    <p>
                      {f.due_on} · {f.status}
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted">No open follow-ups.</p>
              )}
            </Card>
          </div>
        )}
        {section === "" && <AiLearningTeamCard />}
        {(section === "" || section === "support") && (
          <Card className="counsellor-card">
            <SarahIdentity as="h2" />
            <p>
              Sarah helps you get started, find your way around Ducelio,
              understand your schedule and access, and organise your support
              preferences. {SARAH_IS_AI_NOTICE}
            </p>
            <ButtonLink href="/student/sarah" secondary>
              Ask Sarah
            </ButtonLink>
          </Card>
        )}
        {section === "support" && (
          <Card>
            <h2>Support events</h2>
            {events.length ? (
              events.map((e) => (
                <div className="support-record" key={e.id}>
                  <h3>{e.kind.replaceAll("_", " ").toLowerCase()}</h3>
                  <p>{e.status}</p>
                </div>
              ))
            ) : (
              <p className="muted">No open support events.</p>
            )}
          </Card>
        )}
        {(section === "" || section === "study-plan") && (
          <Card>
            <h2>{study.plan?.title ?? "Your study plan"}</h2>
            {study.plan ? (
              <>
                {study.items.map((i) => (
                  <div className="support-record" key={i.id}>
                    <Badge tone={i.status === "DONE" ? "green" : "muted"}>
                      {i.status}
                    </Badge>
                    <h3>{i.title}</h3>
                    <p>{i.due_on}</p>
                  </div>
                ))}
                <SupportForms
                  kind="plan"
                  studentId={actor.id}
                  planId={study.plan.id}
                />
              </>
            ) : (
              <p className="muted">
                Your counsellor will help establish an active study plan.
              </p>
            )}
          </Card>
        )}
        {section === "profile" && (
          <Card>
            <h2>{actor.displayName}</h2>
            <dl className="profile-list">
              <div>
                <dt>Student number</dt>
                <dd>{profile.student_number}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{actor.roles.join(", ")}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>{profile.timezone}</dd>
              </div>
            </dl>
            <ButtonLink href="/forgot-password" secondary>
              Request a password reset
            </ButtonLink>
          </Card>
        )}
        {![
          "",
          "programme",
          "support",
          "study-plan",
          "profile",
          "calendar",
          "classes",
          "notes",
          "results",
        ].includes(section) && (
          <Card>
            <EmptyState
              title={
                "No " +
                (titles[section] ?? "records").toLowerCase() +
                " available yet"
              }
            >
              This module is planned for a later academy milestone. Your
              academic records will appear here when its institutional service
              is available.
            </EmptyState>
          </Card>
        )}
      </div>
    </AcademyShell>
  );
}
