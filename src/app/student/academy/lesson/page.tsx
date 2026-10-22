import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { getMyAcademyLesson } from "@/server/academy-delivery";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import { StudiedForm } from "@/components/academy-learner-forms";
import {
  ACADEMY_ERROR_TEXT,
  AcademyError,
  type AcademyErrorCode,
} from "@/domain/academy-delivery";

export const dynamic = "force-dynamic";

// Lesson material from the published, materialised curriculum. Rendered as
// text only; no package HTML is ever injected.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string; lesson?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const { lesson, refusal } = await getMyAcademyLesson(
    params.enrolmentId,
    params.lesson,
  ).then(
    (lesson) => ({ lesson, refusal: null as AcademyErrorCode | null }),
    (e: unknown) => ({
      lesson: null,
      refusal: (e instanceof AcademyError
        ? e.code
        : "SERVICE_UNAVAILABLE") as AcademyErrorCode | null,
    }),
  );
  if (
    !lesson &&
    (refusal === "NOT_FOUND_OR_FORBIDDEN" || refusal === "FORBIDDEN")
  )
    notFound();
  if (!lesson)
    return (
      <AcademyShell name={actor.displayName} roles={actor.roles}>
        <div className="section-content">
          <Card>
            <p role="status">
              {ACADEMY_ERROR_TEXT[refusal ?? "SERVICE_UNAVAILABLE"]}
            </p>
            <Link
              className="text-link"
              href={`/student/academy?enrolmentId=${params.enrolmentId ?? ""}`}
            >
              ← Back to my timetable
            </Link>
          </Card>
        </div>
      </AcademyShell>
    );
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <p className="eyebrow">LESSON {lesson.sequence}</p>
        <h1>{lesson.title}</h1>
        <Link
          className="text-link"
          href={`/student/academy?enrolmentId=${params.enrolmentId}`}
        >
          ← Back to my timetable
        </Link>
      </div>
      <div className="section-content acad-learner">
        <Card>
          <StudiedForm
            enrolmentId={params.enrolmentId ?? ""}
            lessonRef={lesson.lessonRef}
            studied={lesson.studied}
          />
        </Card>
        <Card>
          <h2>Learning objectives</h2>
          <ul>
            {lesson.objectives.map((o) => (
              <li key={o.id}>{o.description}</li>
            ))}
          </ul>
        </Card>
        {lesson.resources.map((r, i) => (
          <Card key={i}>
            <h2>{r.title}</h2>
            {r.kind === "LECTURE_NOTE" ? (
              <p className="acad-prose">{r.body}</p>
            ) : (
              <a
                className="text-link"
                href={r.url ?? undefined}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open reference ↗
              </a>
            )}
          </Card>
        ))}
        {lesson.practicalActivities.map((a) => (
          <Card key={a.ref}>
            <h2>
              {a.kind === "PRACTICAL_LAB" ? "Practical lab" : "Exercise"}:{" "}
              {a.title}
            </h2>
            <p className="acad-prose">{a.instructions}</p>
            <p className="muted">
              Submit your work from the practical session in your timetable.
            </p>
          </Card>
        ))}
      </div>
    </AcademyShell>
  );
}
