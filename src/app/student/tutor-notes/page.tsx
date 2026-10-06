import Link from "next/link";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listPracticalEnrolments } from "@/server/course-activation";
import { listMyTutorClassNotes } from "@/server/tutor-class-notes";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import { TutorClassNotes } from "@/components/tutor-class-notes";
import { TUTOR_CLASS_NOTE_PAGE_MAX } from "@/domain/tutor-class-notes";

// AC-4: the learner's own supplementary Tutor notes, per enrolment.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string; page?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const enrolments = await listPracticalEnrolments().catch(() => []);
  const selected = enrolments.find(
    (e) => e.id === (params.enrolmentId ?? enrolments[0]?.id),
  );
  const requested = Number(params.page ?? 0);
  const page =
    Number.isInteger(requested) &&
    requested >= 0 &&
    requested <= TUTOR_CLASS_NOTE_PAGE_MAX
      ? requested
      : 0;
  const notes = selected
    ? await listMyTutorClassNotes({ enrolmentId: selected.id, page })
    : null;
  const href = (target: number) =>
    "/student/tutor-notes?enrolmentId=" + selected?.id + "&page=" + target;
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <h1>Tutor notes</h1>
      </div>
      <div className="section-content">
        <Card>
          <form method="get">
            <label>
              Course
              <select name="enrolmentId" defaultValue={selected?.id} required>
                {enrolments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary" disabled={!enrolments.length}>
              View Tutor notes
            </button>
          </form>
          <p>
            Published lecture notes and references are under{" "}
            <Link className="text-link" href="/student/notes">
              Notes &amp; resources
            </Link>
            .
          </p>
        </Card>
        {notes ? (
          <TutorClassNotes page={notes} />
        ) : (
          <Card>
            <p>No course enrolment is available.</p>
          </Card>
        )}
        {notes?.status === "OK" && page > 0 && (
          <Link href={href(page - 1)}>Newer notes</Link>
        )}
        {notes?.status === "OK" &&
          notes.hasMore &&
          page < TUTOR_CLASS_NOTE_PAGE_MAX && (
            <Link href={href(page + 1)}>Older notes</Link>
          )}
      </div>
    </AcademyShell>
  );
}
