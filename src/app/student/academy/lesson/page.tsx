import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { getMyAcademyLesson } from "@/server/academy-delivery";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";

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
  const lesson = await getMyAcademyLesson(
    params.enrolmentId,
    params.lesson,
  ).catch(() => null);
  if (!lesson) notFound();
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
