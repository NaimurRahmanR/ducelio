import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock3 } from "lucide-react";
import { Card, Badge, ButtonLink, Progress, EmptyState } from "./ui";
import { NextClass, CounsellorCard } from "./student-dashboard";
import { demo } from "@/demo/academy";
export const demoSections = [
  "programme",
  "calendar",
  "classes",
  "assignments",
  "assessments",
  "notes",
  "results",
  "support",
  "profile",
  "study-plan",
  "announcements",
  "lecture",
] as const;
export type DemoSectionName = (typeof demoSections)[number];
const titles: Record<DemoSectionName, string> = {
  programme: "Your programme",
  calendar: "Your academy calendar",
  classes: "Your classes",
  assignments: "Assignments",
  assessments: "Assessments",
  notes: "Your notes & resources",
  results: "Your results",
  support: "Your Support Centre",
  profile: "Your academy profile",
  "study-plan": "Your study plan",
  announcements: "Academy noticeboard",
  lecture: "Lecture Hall",
};
export function DemoSection({ section }: { section: DemoSectionName }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACADEMY</p>
          <h1>{titles[section]}</h1>
          <p>
            {section === "lecture"
              ? "Today’s lesson. One clear focus."
              : "A clear view of your next steps."}
          </p>
        </div>
        <ButtonLink href="/demo" secondary>
          <ArrowLeft size={15} />
          Back to Home
        </ButtonLink>
      </div>
      <div className="section-content">
        {section === "programme" && (
          <>
            <Card>
              <Badge tone="gold">DEMO PROGRAMME</Badge>
              <h2 className="detail-title">{demo.programme.title}</h2>
              <p>
                {demo.programme.version} · {demo.programme.cohort}
              </p>
              <p className="muted">
                Illustrative content for product demonstration. This blueprint
                is not official or validated by ISC2.
              </p>
              <Progress value={36} label="Illustrative programme progress" />
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Programme outline</h2>
                <Badge>5 DEMO MODULES</Badge>
              </div>
              {[
                "Security principles",
                "Business continuity & resilience",
                "Access control",
                "Network security",
                "Security operations",
              ].map((m, i) => (
                <div className="outline-row" key={m}>
                  <span className="outline-number">0{i + 1}</span>
                  <div>
                    <h3>{m}</h3>
                    <span className="muted">
                      {i === 0
                        ? "Access Control Fundamentals · 5 fixed objectives"
                        : "Programme outline preview"}
                    </span>
                  </div>
                  {i === 0 ? (
                    <ButtonLink href="/demo/lecture" secondary>
                      View lesson <ArrowRight size={15} />
                    </ButtonLink>
                  ) : (
                    <Badge tone="muted">Preview</Badge>
                  )}
                </div>
              ))}
            </Card>
          </>
        )}
        {section === "classes" && (
          <>
            <NextClass />
            <Card>
              <EmptyState title="A focused place to learn">
                Open the demo Lecture Hall to inspect the fixed objectives,
                lesson progress and evidence-based mastery distinction. Live
                classes are a later milestone.
              </EmptyState>
            </Card>
          </>
        )}
        {section === "calendar" && (
          <Card>
            <div className="section-heading">
              <h2>September 2026</h2>
              <Badge>DEMO WEEK</Badge>
            </div>
            {[
              [
                "08",
                "TUE",
                "Access Control Fundamentals",
                "18:00–19:00 · Europe/London",
                "/demo/lecture",
              ],
              [
                "10",
                "THU",
                "Study-routine review",
                "Personal study-plan reminder",
                "/demo/support",
              ],
              [
                "11",
                "FRI",
                "Least privilege in everyday systems",
                "Illustrative assignment due date",
                "/demo/assignments",
              ],
              [
                "14",
                "MON",
                "Security principles knowledge check",
                "Illustrative assessment",
                "/demo/assessments",
              ],
            ].map(([day, dow, title, meta, href]) => (
              <Link className="agenda-row" href={href} key={day}>
                <div className="agenda-date">
                  <strong>{day}</strong>
                  <span>{dow}</span>
                </div>
                <div>
                  <h3>{title}</h3>
                  <span className="muted">{meta}</span>
                </div>
                <ArrowRight size={17} />
              </Link>
            ))}
          </Card>
        )}
        {section === "study-plan" && (
          <div className="two-column">
            <Card>
              <div className="section-heading">
                <h2>Your September plan</h2>
                <Badge tone="green">DEMO PLAN</Badge>
              </div>
              <p className="muted">
                Small, specific steps. A rhythm you can sustain.
              </p>
              {demo.tasks.map((task) => (
                <div className="task-row" key={task.title}>
                  <span
                    className={task.done ? "task-check done" : "task-check"}
                  >
                    {task.done && <Check size={13} />}
                  </span>
                  <div>
                    <h3>{task.title}</h3>
                    <span>
                      {task.meta} · {task.due}
                    </span>
                  </div>
                  <Badge tone={task.done ? "green" : "muted"}>
                    {task.done ? "Complete" : "Planned"}
                  </Badge>
                </div>
              ))}
              <p className="notice">
                This demo plan is read-only. Signed-in learners with an active
                study plan can add their own items.
              </p>
            </Card>
            <CounsellorCard />
          </div>
        )}
        {section === "assignments" && (
          <Card>
            <Badge tone="gold">DEMO ASSIGNMENT</Badge>
            <h2 className="detail-title">{demo.assignments[0].title}</h2>
            <p className="muted">Security principles · Due Fri, 11 Sep</p>
            <p>
              Reflect on an everyday situation where limiting access could
              reduce risk. This is an illustrative brief for the academy
              preview.
            </p>
            <button className="button" disabled>
              Submissions are not open
            </button>
            <p className="config-caption">
              Assignment submission and grading are not implemented in Phase 1.
            </p>
          </Card>
        )}
        {section === "assessments" && (
          <Card>
            <Badge>DEMO ASSESSMENT</Badge>
            <h2 className="detail-title">{demo.assessments[0].title}</h2>
            <p className="muted">{demo.assessments[0].detail} · Mon, 14 Sep</p>
            <p>
              A preview of how upcoming assessments appear in your academy. No
              examination or result is generated here.
            </p>
            <button className="button" disabled>
              Assessment delivery coming later
            </button>
          </Card>
        )}
        {section === "notes" && (
          <Card>
            <Badge>DEMO REFERENCE NOTE</Badge>
            <h2 className="detail-title">
              Identity, access and least privilege
            </h2>
            <p>
              <strong>Authentication</strong> establishes identity.{" "}
              <strong>Authorisation</strong> determines permitted actions.{" "}
              <strong>Least privilege</strong> limits access to what a task
              requires.
            </p>
            <p className="muted">
              Use these concepts to prepare for your demo lesson. This short
              note is illustrative, not official ISC2 teaching material.
            </p>
            <ButtonLink href="/demo/lecture" secondary>
              <BookOpen size={16} />
              Open related lesson
            </ButtonLink>
          </Card>
        )}
        {section === "results" && (
          <Card>
            <EmptyState title="No published results yet">
              Your verified assessment results will appear here when the
              assessment and registry services are available. Viewing lessons
              does not create grades or mastery.
            </EmptyState>
          </Card>
        )}
        {section === "support" && (
          <div className="two-column">
            <Card>
              <Badge tone="gold">SUPPORT WITH CONTINUITY</Badge>
              <h2 className="detail-title">
                Your ambition, with someone alongside.
              </h2>
              <p>{demo.counsellor.goal}</p>
              <div className="support-record">
                <h3>Open follow-up</h3>
                <p>
                  {demo.followups[0].title} · {demo.followups[0].due}
                </p>
                <Badge tone="gold">Open</Badge>
              </div>
              <div className="support-record">
                <h3>{demo.events[0].title}</h3>
                <p>{demo.events[0].detail}</p>
              </div>
              <ButtonLink href="/demo/study-plan">
                View your study plan <ArrowRight size={16} />
              </ButtonLink>
              <p className="config-caption">
                Non-conversational demo. No messages are sent and no AI is
                connected. In the signed-in academy, Sarah Mitchell is
                Ducelio&apos;s AI learner-success counsellor.
              </p>
            </Card>
            <CounsellorCard />
          </div>
        )}
        {section === "profile" && (
          <Card>
            <Badge tone="gold">FICTIONAL DEMO PROFILE</Badge>
            <h2 className="detail-title">{demo.student.name}</h2>
            <dl className="profile-list">
              <div>
                <dt>Student number</dt>
                <dd>{demo.student.number}</dd>
              </div>
              <div>
                <dt>Academy role</dt>
                <dd>Student</dd>
              </div>
              <div>
                <dt>Programme</dt>
                <dd>{demo.programme.title}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>Europe/London</dd>
              </div>
            </dl>
            <p className="notice">
              Student numbers identify academic records. They are never used to
              sign in.
            </p>
            <ButtonLink href="/login" secondary>
              Sign in to your own account
            </ButtonLink>
          </Card>
        )}
        {section === "announcements" && (
          <div className="announcement-list">
            {demo.announcements.map((a) => (
              <Card key={a.title}>
                <Badge>
                  {a.tag} · {a.date}
                </Badge>
                <h2 className="detail-title">{a.title}</h2>
                <p>{a.body}</p>
              </Card>
            ))}
          </div>
        )}
        {section === "lecture" && (
          <>
            <Card className="lecture-heading">
              <Badge tone="gold">DEMO LESSON · READ-ONLY PREVIEW</Badge>
              <p className="eyebrow lecture-context">
                SECURITY PRINCIPLES / LESSON 01
              </p>
              <h2>{demo.lesson.title}</h2>
              <p className="muted">
                ISC2 Certified in Cybersecurity (CC) · {demo.programme.version}
              </p>
              <div className="lesson-metrics">
                <div>
                  <span>
                    <Clock3 size={15} />
                    Class time
                  </span>
                  <strong>00:38:12</strong>
                  <small>Illustrative elapsed time</small>
                </div>
                <div>
                  <span>Lesson progress</span>
                  <strong>
                    72<span>%</span>
                  </strong>
                  <small>Planned lesson structure</small>
                </div>
                <div>
                  <span>Today’s mastery</span>
                  <strong>
                    3 <span>/ 5</span>
                  </strong>
                  <small>Illustrative evidence-backed state</small>
                </div>
              </div>
            </Card>
            <div className="two-column">
              <Card>
                <h2>Today’s fixed objectives</h2>
                {demo.lesson.objectives.map((objective, i) => (
                  <div className="objective-row" key={objective}>
                    <span className="outline-number">0{i + 1}</span>
                    <div>
                      <h3>{objective}</h3>
                      <Badge tone={i < 3 ? "green" : "muted"}>
                        {i < 3 ? "Demonstrated · demo evidence" : "Developing"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </Card>
              <Card>
                <h2>Understanding access</h2>
                <p>
                  Begin with three questions: who is requesting access, what are
                  they permitted to do, and what access do they actually need?
                </p>
                <p className="muted">
                  This preview separates time spent, lesson structure and
                  objective mastery. None of the figures change as you browse.
                </p>
                <div className="notice">
                  Mastery requires valid learning evidence. Time, scrolling and
                  lesson completion do not establish it.
                </div>
                <ButtonLink href="/demo/notes" secondary>
                  Read the demo reference note
                </ButtonLink>
              </Card>
            </div>
          </>
        )}
      </div>
      <p className="demo-disclaimer">
        Fictional demo records. Ducelio prepares learners for external
        examinations and does not award the external qualification.
      </p>
    </>
  );
}
