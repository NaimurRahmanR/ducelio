import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { listPracticalEnrolments } from "@/server/course-activation";
import { getCommercialV1Leaderboard } from "@/server/commercial-v1-leaderboard";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ enrolmentId?: string }>;
}) {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const params = await searchParams;
  const enrolments = await listPracticalEnrolments();
  const selected = enrolments.find(
    (e) => e.id === (params.enrolmentId ?? enrolments[0]?.id),
  );
  const leaderboard = selected
    ? await getCommercialV1Leaderboard(selected.id).catch(() => null)
    : null;

  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <h1>Leaderboard</h1>
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
              View leaderboard
            </button>
          </form>
          <p>
            Rankings reflect only published, fully finalised course results.
            Viewing does not affect your grades.
          </p>
        </Card>
        {!leaderboard || !leaderboard.ok ? (
          <Card>
            <p role="alert">The leaderboard is unavailable right now.</p>
          </Card>
        ) : !leaderboard.published ? (
          <Card>
            <p>No leaderboard has been published for this course yet.</p>
          </Card>
        ) : (
          <>
            <Card>
              <p>
                Your rank:{" "}
                <strong>{leaderboard.selfRank ?? "not yet ranked"}</strong> of{" "}
                {leaderboard.entryCount}
              </p>
              {leaderboard.nudge && <p>{leaderboard.nudge}</p>}
              <p>
                Published{" "}
                {new Date(leaderboard.publishedAt).toLocaleDateString()}
              </p>
            </Card>
            <Card>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Learner</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.entries.map((entry, index) => (
                    <tr
                      key={`${entry.rank}-${index}`}
                      aria-current={entry.isSelf ? "true" : undefined}
                    >
                      <td>{entry.rank}</td>
                      <td>{entry.label}</td>
                      <td>{(entry.scoreBp / 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </AcademyShell>
  );
}
