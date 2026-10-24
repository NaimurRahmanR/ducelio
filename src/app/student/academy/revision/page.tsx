import { getMyRevision } from "@/server/unified-course-activation";
import { requireActor } from "@/server/identity";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string; itemId?: string }>;
}) {
  const actor = await requireActor("student");
  const p = await searchParams;
  const revision = await getMyRevision(
    p.enrolmentId ?? "",
    p.itemId ?? "",
  ).catch(() => null);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <Card>
        {revision ? (
          <>
            <h1>{revision.title}</h1>
            <p>
              Review the taught objectives below. Protected assessment prompts
              and answer keys remain unavailable.
            </p>
            <ul>
              {revision.objectives.map((o, i) => (
                <li key={i}>
                  <strong>{o.title}</strong>
                  <p>{o.description}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="alert">
            This revision activity is unavailable outside its approved window or
            while a controlled assessment is active.
          </p>
        )}
      </Card>
    </AcademyShell>
  );
}
