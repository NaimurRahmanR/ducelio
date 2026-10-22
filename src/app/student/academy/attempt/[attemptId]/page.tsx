import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { getMyAcademyAttempt } from "@/server/academy-delivery";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import { AcademyExam } from "@/components/academy-exam";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { attemptId } = await params;
  const attempt = await getMyAcademyAttempt(attemptId).catch(() => null);
  if (!attempt) notFound();
  const back = `/student/academy?enrolmentId=${attempt.enrolmentId}`;
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <p className="eyebrow">ACADEMY ASSESSMENT</p>
        <h1>{attempt.title}</h1>
        <p className="muted">
          Attempt {attempt.attemptNumber} of {attempt.attemptsAllowed}
        </p>
      </div>
      <div className="section-content">
        {attempt.state === "SUBMITTED" ? (
          <Card>
            <p role="status">
              Submitted
              {attempt.submission === "AUTO_TIMEOUT"
                ? " automatically when time ran out"
                : ""}
              . Score: {attempt.score} / {attempt.maxScore}.
            </p>
            <Link className="button secondary" href={back}>
              Back to my timetable
            </Link>
          </Card>
        ) : (
          <AcademyExam
            title={attempt.title}
            instructions={attempt.instructions}
            attempt={{
              id: attempt.attemptId,
              attempt_number: attempt.attemptNumber,
              expires_at: attempt.expiresAt,
            }}
            serverNow={attempt.serverTime}
            questions={attempt.questions.map((q) => ({
              id: `q-${q.position}`,
              position: q.position,
              prompt: q.prompt,
              max_marks: q.maxMarks,
              question_type: q.questionType,
              interaction: q.interaction,
              saved_body: q.response,
              revision_count: q.revisions,
            }))}
          />
        )}
      </div>
    </AcademyShell>
  );
}
