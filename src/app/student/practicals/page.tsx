import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import {
  listMyPracticals,
  listPracticalEnrolments,
} from "@/server/course-activation";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import {
  PracticalSupport,
  LabWorkSubmission,
} from "@/components/practical-support";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string; cursor?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const enrolments = await listPracticalEnrolments();
  const selected = enrolments.find(
    (e) => e.id === (params.enrolmentId ?? enrolments[0]?.id),
  );
  const cursor = Number(params.cursor ?? 0);
  const rows = selected
    ? await listMyPracticals({ enrolmentId: selected.id, cursor }).catch(
        () => null,
      )
    : [];
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <h1>Practicals</h1>
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
              View practicals
            </button>
          </form>
          <p>
            Reading or requesting support does not record academic progress or
            completion.
          </p>
        </Card>
        {rows === null ? (
          <Card>
            <p role="alert">
              Practical content is unavailable. An active controlled assessment
              blocks learning help.
            </p>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <p>No practicals are available for this course selection.</p>
          </Card>
        ) : (
          rows.map((p) => (
            <Card key={p.id}>
              <h2>{p.title}</h2>
              <p>{p.kind === "PRACTICAL_LAB" ? "Practical lab" : "Exercise"}</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{p.instructions}</p>
              {selected?.status === "ACTIVE" && (
                <>
                  <PracticalSupport
                    enrolmentId={selected.id}
                    practicalId={p.id}
                    requestId={randomUUID()}
                    lab={p.kind === "PRACTICAL_LAB"}
                  />
                  {p.kind === "PRACTICAL_LAB" && (
                    <LabWorkSubmission
                      enrolmentId={selected.id}
                      practicalId={p.id}
                    />
                  )}
                </>
              )}
            </Card>
          ))
        )}
        {selected && cursor > 0 && (
          <Link
            href={
              "/student/practicals?enrolmentId=" +
              selected.id +
              "&cursor=" +
              Math.max(0, cursor - 20)
            }
          >
            Previous page
          </Link>
        )}
        {selected && rows?.length === 20 && cursor < 62500 && (
          <Link
            href={
              "/student/practicals?enrolmentId=" +
              selected.id +
              "&cursor=" +
              (cursor + 20)
            }
          >
            Next page
          </Link>
        )}
      </div>
    </AcademyShell>
  );
}
