import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listMyLeaderboards } from "@/server/learner-academics";
import { AcademyShell } from "@/components/academy-shell";
import { LeaderboardsView } from "@/components/learner/leaderboards";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const { month } = await searchParams;
  const boards = await listMyLeaderboards().catch(() => null);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <LeaderboardsView
        boards={boards}
        month={typeof month === "string" ? month : null}
      />
    </AcademyShell>
  );
}
