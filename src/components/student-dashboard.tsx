import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  Clock3,
  FileText,
  GraduationCap,
  HeartHandshake,
  Play,
  Target,
} from "lucide-react";
import { Card, Badge, ButtonLink, Progress } from "./ui";
import { demo } from "@/demo/academy";
export function CounsellorCard() {
  return (
    <Card className="counsellor-card">
      <div className="section-heading">
        <h2>Your counsellor</h2>
        <HeartHandshake size={20} />
      </div>
      <div className="counsellor-person">
        <div className="avatar counsellor-avatar">SM</div>
        <div>
          <h3>{demo.counsellor.name}</h3>
          <span className="muted">Your learner success partner</span>
        </div>
      </div>
      <p className="support-copy">
        A familiar face. A clear next step.
        <br />
        Support throughout your academy journey.
      </p>
      <div className="checkin">
        <CalendarDays size={18} />
        <div>
          <span>YOUR NEXT CHECK-IN</span>
          <strong>{demo.counsellor.checkin}</strong>
        </div>
      </div>
      <ButtonLink href="/demo/study-plan" secondary>
        View study plan <ArrowRight size={16} />
      </ButtonLink>
      <Link className="text-link centred" href="/demo/support">
        Visit the Support Centre <ArrowUpRight size={15} />
      </Link>
    </Card>
  );
}
export function NextClass() {
  return (
    <section className="next-class" aria-labelledby="next-class-title">
      <div className="next-class-top">
        <span className="class-kicker">
          <span />
          YOUR NEXT CLASS
        </span>
        <span>Today · 18:00</span>
      </div>
      <p className="class-module">
        MODULE 01 <span> / </span> SECURITY PRINCIPLES
      </p>
      <h2 id="next-class-title">{demo.lesson.title}</h2>
      <p className="class-description">
        Understand who has access, and why it matters.
      </p>
      <div className="class-bottom">
        <div className="class-meta">
          <span>
            <Clock3 size={16} />
            60 minutes
          </span>
          <span>
            <BookOpen size={16} />5 learning objectives
          </span>
        </div>
        <Link className="button gold-button" href="/demo/lecture">
          <Play size={15} fill="currentColor" />
          Enter Lecture Hall <ArrowUpRight size={16} />
        </Link>
      </div>
      <div className="class-footnote">Demo lesson preview · Europe/London</div>
    </section>
  );
}
export function StudentDashboard() {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TUESDAY, 8 SEPTEMBER 2026</p>
          <h1>
            Good evening, Alex<span className="gold-text">.</span>
          </h1>
          <p>A little focus today. A step closer to your ambition.</p>
        </div>
        <Link href="/demo/calendar" className="calendar-link">
          <CalendarDays size={17} />
          My calendar <ArrowUpRight size={15} />
        </Link>
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <Card className="programme-card">
            <div className="programme-top">
              <div className="programme-icon">
                <GraduationCap size={27} />
              </div>
              <div>
                <span className="eyebrow">YOUR PROGRAMME</span>
                <h2>{demo.programme.shortTitle}</h2>
                <p>
                  ISC2 CC <span>·</span> {demo.programme.version}
                </p>
              </div>
              <Badge tone="green">In progress</Badge>
            </div>
            <div className="programme-progress">
              <span>
                Programme progress <strong>{demo.programme.progress}%</strong>
              </span>
              <Progress
                value={demo.programme.progress}
                label="Illustrative programme progress"
              />
              <div>
                <small>2 of 5 demo modules completed</small>
                <Link href="/demo/programme">
                  View programme <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </Card>
          <NextClass />
          <Card className="today-card">
            <div className="section-heading">
              <h2>Today, with intention</h2>
              <Badge tone="muted">1 TO FOCUS ON</Badge>
            </div>
            <p className="section-caption">
              A manageable plan for a meaningful day.
            </p>
            <div className="task-list">
              {demo.tasks.slice(0, 2).map((task) => (
                <Link
                  href="/demo/study-plan"
                  key={task.title}
                  className="task-row"
                >
                  <span
                    className={task.done ? "task-check done" : "task-check"}
                  >
                    {task.done && <Check size={13} />}
                  </span>
                  <div>
                    <h3 className={task.done ? "task-done" : ""}>
                      {task.title}
                    </h3>
                    <span>{task.meta}</span>
                  </div>
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
            <Link href="/demo/study-plan" className="text-link">
              See your full study plan <ArrowRight size={15} />
            </Link>
          </Card>
          <div className="upcoming-grid">
            <Card>
              <div className="section-heading">
                <h2>Assignments</h2>
                <FileText size={19} />
              </div>
              <Badge tone="gold">DUE THIS WEEK</Badge>
              <h3 className="upcoming-title">{demo.assignments[0].title}</h3>
              <p className="section-caption">Security principles</p>
              <div className="card-bottom">
                <span>Fri, 11 Sep</span>
                <Link className="text-link" href="/demo/assignments">
                  View <ArrowUpRight size={15} />
                </Link>
              </div>
            </Card>
            <Card>
              <div className="section-heading">
                <h2>Assessments</h2>
                <Target size={19} />
              </div>
              <Badge>COMING UP</Badge>
              <h3 className="upcoming-title">
                Security principles
                <br />
                knowledge check
              </h3>
              <p className="section-caption">15 questions · Demo assessment</p>
              <div className="card-bottom">
                <span>Mon, 14 Sep</span>
                <Link className="text-link" href="/demo/assessments">
                  View <ArrowUpRight size={15} />
                </Link>
              </div>
            </Card>
          </div>
        </div>
        <div className="dashboard-rail">
          <CounsellorCard />
          <Card className="weekly-plan">
            <div className="section-heading">
              <h2>Your weekly rhythm</h2>
              <span className="weekly-icon">
                <Clock3 size={18} />
              </span>
            </div>
            <div className="weekly-number">
              3.5 <span>/ 6 hours</span>
            </div>
            <p className="section-caption">Study time planned this week</p>
            <Progress
              value={58}
              label="Illustrative weekly planned study time"
            />
            <div
              className="week-days"
              aria-label="Demo study days: Monday, Tuesday, Thursday and Saturday"
            >
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <span
                  key={i}
                  className={[0, 1, 3, 5].includes(i) ? "planned" : ""}
                >
                  {d}
                </span>
              ))}
            </div>
            <p className="rhythm-note">
              Consistency creates confidence.
              <br />
              Make your plan work for you.
            </p>
            <Link href="/demo/study-plan" className="text-link">
              Open study plan <ArrowRight size={15} />
            </Link>
          </Card>
          <Card className="announcement-card">
            <div className="section-heading">
              <h2>Academy noticeboard</h2>
              <span className="noticeboard-dot" />
            </div>
            {demo.announcements.map((a) => (
              <Link
                key={a.title}
                href="/demo/announcements"
                className="announcement"
              >
                <span>
                  {a.tag} <span>· {a.date}</span>
                </span>
                <h3>{a.title}</h3>
                <ArrowUpRight size={15} />
              </Link>
            ))}
          </Card>
        </div>
      </div>
      <p className="demo-disclaimer">
        Academic content and progress are illustrative demo data, not an
        official or validated ISC2 curriculum.
      </p>
    </>
  );
}
