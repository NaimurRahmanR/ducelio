import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { AcademyShell } from "@/components/academy-shell";
import { Badge, Card } from "@/components/ui";
import { AcademySupportPanel } from "@/components/academy-support-panel";
import {
  AcademySupportUnavailable,
  academySupportDenialText,
  getMyAcademySupportRequest,
  getMyAcademySupportTranscript,
} from "@/server/academy-support";

export const dynamic = "force-dynamic";

// One Academy AI Tutor or Lab Instructor conversation. requestId is
// untrusted URL input: the database re-derives ownership, release,
// revocation and the exam firewall before anything renders, and every
// question is re-admitted by the governed runtime.
export default async function Page({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const id = z.uuid().safeParse((await params).requestId);
  if (!id.success) notFound();

  let request: Awaited<ReturnType<typeof getMyAcademySupportRequest>>;
  try {
    request = await getMyAcademySupportRequest(id.data);
  } catch (error) {
    const code =
      error instanceof AcademySupportUnavailable
        ? error.code
        : "SERVICE_UNAVAILABLE";
    if (code === "NOT_FOUND_OR_FORBIDDEN" || code === "FORBIDDEN") notFound();
    return (
      <AcademyShell name={actor.displayName} roles={actor.roles}>
        <div className="page-heading">
          <div>
            <p className="eyebrow">AI SUPPORT</p>
            <h1>Not available</h1>
            <p>{academySupportDenialText(code)}</p>
          </div>
        </div>
        <Link className="button secondary" href="/student/academy">
          ← Back to my timetable
        </Link>
      </AcademyShell>
    );
  }
  const transcript = await getMyAcademySupportTranscript(request.requestId);
  const lab = request.role === "LAB_INSTRUCTOR";
  const agentName = lab ? "Lab Instructor" : "Tutor";

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{lab ? "AI LAB INSTRUCTOR" : "AI TUTOR"}</p>
          <h1>{lab ? request.practical?.title : request.lessonTitle}</h1>
          <p>
            {request.courseTitle} · {request.lessonTitle}
          </p>
        </div>
        <Badge tone={lab ? "green" : "blue"}>{agentName.toUpperCase()}</Badge>
      </div>
      <div className="section-content">
        {lab && request.practical ? (
          <Card>
            <h2>
              {request.practical.kind === "PRACTICAL_LAB"
                ? "Practical lab"
                : "Exercise"}
            </h2>
            <p className="acad-prose">{request.practical.instructions}</p>
            {request.graded && (
              <p className="notice" role="status">
                This practical is assessed. The Lab Instructor guides your
                approach but will not complete the work for you. Lab marking is
                closed until approved rubrics exist.
              </p>
            )}
          </Card>
        ) : (
          <Card>
            <h2>Objective</h2>
            <p>{request.objective}</p>
          </Card>
        )}
        <AcademySupportPanel
          requestId={request.requestId}
          agentName={agentName}
          initialTurns={transcript.turns}
          unrecorded={transcript.unrecordedExchanges > 0}
        />
        <p className="muted">
          This conversation is kept for you. It is not a mark, attendance,
          evidence or mastery, and it does not complete the lesson or course:
          mastery comes only from your marked assessments and practicals.
        </p>
      </div>
      <Link
        className="button secondary"
        href={`/student/academy?enrolmentId=${request.enrolmentId}`}
      >
        ← Back to my timetable
      </Link>
    </AcademyShell>
  );
}
