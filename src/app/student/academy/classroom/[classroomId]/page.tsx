import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { AcademyShell } from "@/components/academy-shell";
import { Badge, Card } from "@/components/ui";
import { ProfessorClassroomPanel } from "@/components/professor-classroom-panel";
import { getMyAcademyLesson } from "@/server/academy-delivery";
import { formatAcademySessionTime } from "@/domain/academy-delivery";
import {
  AcademyClassDenied,
  academyClassDenialText,
  getMyAcademyClass,
  getMyAcademyClassTranscript,
} from "@/server/academy-professor-classroom";
import {
  askAcademyProfessorAction,
  beginAcademyLessonAction,
} from "../actions";

export const dynamic = "force-dynamic";

// One scheduled Academy lesson's AI class. classroomId is untrusted URL
// input: the database re-derives ownership, release, revocation and the
// exam firewall before anything renders, and every Professor request is
// re-admitted by the governed runtime again.
export default async function Page({
  params,
}: {
  params: Promise<{ classroomId: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const raw = (await params).classroomId;
  const id = z.uuid().safeParse(raw);
  if (!id.success) notFound();

  let classroom: Awaited<ReturnType<typeof getMyAcademyClass>>;
  try {
    classroom = await getMyAcademyClass(id.data);
  } catch (error) {
    const code =
      error instanceof AcademyClassDenied ? error.code : "SERVICE_UNAVAILABLE";
    if (code === "NOT_FOUND_OR_FORBIDDEN" || code === "FORBIDDEN") notFound();
    return (
      <AcademyShell name={actor.displayName} roles={actor.roles}>
        <div className="page-heading">
          <div>
            <p className="eyebrow">AI CLASS</p>
            <h1>Not available</h1>
            <p>{academyClassDenialText(code)}</p>
          </div>
        </div>
        <Link className="button secondary" href="/student/academy">
          ← Back to my timetable
        </Link>
      </AcademyShell>
    );
  }
  const { state, view } = classroom;
  const [lesson, transcript] = await Promise.all([
    getMyAcademyLesson(state.enrolmentId, view.lessonRef).catch(() => null),
    getMyAcademyClassTranscript(state.classroomId),
  ]);
  const live = state.mode === "LIVE";
  const schedule = formatAcademySessionTime(
    state.scheduledStart,
    state.scheduledEnd,
    view.timezone,
  );
  const back = `/student/academy?enrolmentId=${state.enrolmentId}`;

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {live ? "AI CLASS · LIVE" : "AI CLASS · CATCH-UP"}
          </p>
          <h1>{state.lessonTitle}</h1>
          <p>
            {view.courseTitle} · {state.moduleTitle}
            {view.parts > 1 && ` · part ${view.part} of ${view.parts}`}
          </p>
        </div>
        <Badge tone={live ? "green" : "gold"}>
          {live ? "LIVE" : "CATCH UP"}
        </Badge>
      </div>
      <div className="section-content">
        <Card>
          <h2>Scheduled class</h2>
          <p>{schedule.text}</p>
          <p className="muted">Times are shown in {schedule.timeZone}.</p>
          <p className="muted">
            {live
              ? "Your scheduled class time is running. The Professor teaches this lesson from its approved content and objectives."
              : "The scheduled time has passed. You can still learn this lesson with the Professor."}
          </p>
        </Card>
        {lesson && (
          <Card>
            <h2>Lesson objectives</h2>
            {lesson.objectives.length ? (
              <ul>
                {lesson.objectives.map((o) => (
                  <li key={o.id}>{o.description}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                No objectives are recorded for this lesson.
              </p>
            )}
            <Link
              className="text-link"
              href={`/student/academy/lesson?enrolmentId=${state.enrolmentId}&lesson=${encodeURIComponent(view.lessonRef)}`}
            >
              Open lesson notes and practical activities →
            </Link>
          </Card>
        )}
        <ProfessorClassroomPanel
          classSessionId={state.classroomId}
          disabled={false}
          initialTurns={transcript.turns}
          memoryDegraded={transcript.unrecordedExchanges > 0}
          memoryFull={transcript.capacityReached}
          actions={{
            begin: beginAcademyLessonAction,
            ask: askAcademyProfessorAction,
          }}
        />
        <p className="muted">
          Your conversation with the Professor in this class is kept for you so
          the Professor can continue it. Opening this class and talking with the
          Professor are not attendance, marks, evidence or mastery: mastery
          comes only from your marked assessments and practicals. Confirm study
          on the lesson page when you have worked through it.
        </p>
        <Card>
          <h2>Practice and labs</h2>
          <p className="muted">
            For more help with one objective, ask the AI Tutor from the lesson
            page. Practical sessions in your timetable have an AI Lab Instructor
            from their start time. Automated lab marking is not available; lab
            marking stays closed until approved rubrics exist.
          </p>
          {lesson && (
            <Link
              className="text-link"
              href={`/student/academy/lesson?enrolmentId=${state.enrolmentId}&lesson=${encodeURIComponent(view.lessonRef)}`}
            >
              Ask the AI Tutor about an objective →
            </Link>
          )}
        </Card>
      </div>
      <Link className="button secondary" href={back}>
        ← Back to my timetable
      </Link>
    </AcademyShell>
  );
}
