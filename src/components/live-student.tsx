import { AcademyShell } from "./academy-shell";
import { Card, EmptyState, Badge, ButtonLink } from "./ui";
import { getStudentAcademy } from "@/server/academy";
import { getStudentClassSessions } from "@/server/class-sessions";
import { getStudentAttendance } from "@/server/attendance";
import { getStudentLessonProgress } from "@/server/lesson-progress";
import { getStudentLearningResources } from "@/server/learning-resources";
import {
  getAssignedCounsellor,
  getStudyPlan,
  getSupportFollowups,
  getStudentSupportProfile,
  getOpenSupportEvents,
} from "@/server/support";
import { SupportForms } from "./support-forms";
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
  ]);
  const attendanceBySession = new Map(
    attendance.map((record) => [record.session_id, record]),
  );
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
            <h2>Programme enrolments</h2>
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
                    will only come from validated learning evidence.
                  </p>
                </div>
              ))
            ) : (
              <EmptyState title="Your next chapter starts here">
                No programme enrolment is recorded yet. Your academy registrar
                will add your programme and curriculum version.
              </EmptyState>
            )}
          </Card>
        )}
        {section === "classes" && (
          <>
            <Card>
              <h2>Your class sessions</h2>
              {sessions.length ? (
                sessions.map((session) => {
                  const attendanceRecord = attendanceBySession.get(session.id);
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
                        {new Date(session.scheduled_start).toLocaleString()} ·{" "}
                        {session.instructor_name}
                      </p>
                      <p className="muted">
                        Ends {new Date(session.scheduled_end).toLocaleString()}
                      </p>
                      {!attendanceRecord && session.status !== "CANCELLED" && (
                        <p className="muted">
                          Attendance has not yet been recorded.
                        </p>
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
                      {new Date(record.updated_at).toLocaleString()}
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
                  {resource.body && <p>{resource.body}</p>}
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
        {(section === "" || section === "support") && (
          <div className="two-column">
            <Card className="counsellor-card">
              <h2>Your counsellor</h2>
              {counsellor ? (
                <>
                  <h3>{counsellor.display_name}</h3>
                  <p className="muted">
                    Your assigned learner support partner.
                  </p>
                </>
              ) : (
                <p className="muted">A counsellor has not yet been assigned.</p>
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
          "classes",
          "notes",
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
