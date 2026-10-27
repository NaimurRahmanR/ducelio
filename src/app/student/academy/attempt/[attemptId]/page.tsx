import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { getMyAcademyAttempt } from "@/server/academy-delivery";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import { AcademyExam } from "@/components/academy-exam";
import {
  describeAnswerKey,
  describeObjectiveResponse,
} from "@/domain/assessment-question-types";

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
  const back = `/student/courses/${attempt.enrolmentId}`;
  const review =
    attempt.state === "SUBMITTED" && attempt.released && attempt.reviewAvailable
      ? (attempt.review ?? [])
      : [];
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
              .
            </p>
            {attempt.released ? (
              <p>
                Result released
                {attempt.releasedAt
                  ? ` ${new Date(attempt.releasedAt).toUTCString()}`
                  : ""}
                {attempt.score !== undefined && attempt.maxScore !== undefined
                  ? `. This attempt scored ${attempt.score} / ${attempt.maxScore}.`
                  : "."}
              </p>
            ) : (
              <p>
                Your result is confidential until this assessment&apos;s window
                closes and grading is final. Scores, correct answers and
                explanations are released together after the deadline.
              </p>
            )}
            <Link className="button secondary" href={back}>
              Back to the course
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
            // Questions arrive in this attempt's own server-chosen order;
            // they are numbered as shown, while answers stay keyed to the
            // authored position (the id).
            questions={attempt.questions.map((q, index) => ({
              id: `q-${q.position}`,
              position: index + 1,
              prompt: q.prompt,
              max_marks: q.maxMarks,
              question_type: q.questionType,
              interaction: q.interaction,
              saved_body: q.response,
              revision_count: q.revisions,
            }))}
          />
        )}
        {review.length > 0 && (
          <Card>
            <h2>Answer review</h2>
            <ol className="acad-review">
              {review.map((q) => {
                const yours = describeObjectiveResponse(
                  q.questionType,
                  q.interaction,
                  q.response,
                );
                const correct = describeAnswerKey(
                  q.questionType,
                  q.interaction,
                  q.correctAnswer,
                );
                return (
                  <li key={q.position}>
                    <p className="acad-prose">{q.prompt}</p>
                    <p>
                      <strong>Your answer:</strong>{" "}
                      {yours.length ? yours.join("; ") : "No answer"}
                    </p>
                    <p>
                      <strong>Correct answer:</strong>{" "}
                      {correct.length
                        ? correct.join("; ")
                        : (q.expectedAnswer ?? "Not available")}
                    </p>
                    <p>
                      <strong>Marks:</strong>{" "}
                      {q.marks === null ? "Not marked" : q.marks} / {q.maxMarks}
                    </p>
                    {q.explanation && (
                      <p className="acad-prose">
                        <strong>Explanation:</strong> {q.explanation}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </Card>
        )}
      </div>
    </AcademyShell>
  );
}
