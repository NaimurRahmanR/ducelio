import { randomUUID } from "node:crypto";
import { requireActor, requireStudentPrincipal } from "@/server/identity";
import { getMySarahMode, listMySarahProposals } from "@/server/sarah";
import { listMySessionFeedbackOpportunities } from "@/server/session-feedback";
import { AcademyShell } from "@/components/academy-shell";
import { Card } from "@/components/ui";
import { SarahAskPanel, SarahProposals } from "@/components/sarah-guide";
import { SarahIdentity, SARAH_IS_AI_NOTICE } from "@/components/sarah-identity";
import { SarahSessionFeedback } from "@/components/sarah-session-feedback";
import type { CounsellorMode } from "@/domain/platform-ai-policy";

const MODE_HELP: Record<CounsellorMode, string> = {
  PROSPECT:
    "You have no course enrolment yet. Sarah can help you get started and find your way around Ducelio.",
  ACTIVE_COURSE:
    "You are on a course. Sarah can help you find your way around Ducelio and understand your schedule, access and support information.",
  POST_COURSE:
    "Your course has ended. Sarah can help you find your way around Ducelio and understand the support information it holds for you.",
};

// AC-5: Sarah Mitchell, Ducelio's AI learner-success counsellor. Learner
// only. Everything Sarah can see is derived by the database for this
// signed-in learner; the page never sends a learner id.
export default async function Page() {
  await requireActor("student");
  const actor = await requireStudentPrincipal();
  const [mode, proposals, feedback] = await Promise.all([
    getMySarahMode(),
    listMySarahProposals(),
    listMySessionFeedbackOpportunities(),
  ]);
  return (
    <AcademyShell name={actor.displayName} roles={actor.roles}>
      <div className="page-heading">
        <h1>Sarah</h1>
      </div>
      <div className="section-content">
        <Card className="counsellor-card">
          <SarahIdentity as="h2" />
          <p>
            Hello, I&apos;m Sarah, Ducelio&apos;s AI learner guide. I can help
            you get started, find your way around Ducelio, understand your
            schedule and access, and organise your learner-support preferences
            using the information Ducelio already holds for you.
          </p>
          {mode && <p className="muted">{MODE_HELP[mode]}</p>}
          <ul>
            <li>{SARAH_IS_AI_NOTICE}</li>
            <li>
              Sarah does not teach course content, solve labs or practicals,
              help with controlled assessments, or grade work. For course
              content, use your classes and Tutor support.
            </li>
            <li>
              Sarah cannot change your records. Your support preferences change
              only when you confirm a suggestion yourself.
            </li>
            <li>
              After a class you attended, Sarah can ask for three quick ratings
              from 1 to 5. Recording them uses no AI and never changes your
              grades, attendance or progress.
            </li>
            <li>
              Sarah is not a therapist or a crisis service. If you need urgent
              help, contact your local emergency services or your institution.
            </li>
          </ul>
        </Card>
        {/* The first idempotency key is generated here, on the server, so
            the Client Component renders identically during hydration. */}
        <SarahAskPanel initialIdempotencyKey={randomUUID()} />
        {proposals.status === "OK" ? (
          <SarahProposals
            current={proposals.current}
            proposals={proposals.proposals}
          />
        ) : (
          <Card>
            <p role="alert">
              Your support preferences could not be loaded right now.
            </p>
          </Card>
        )}
        {/* AC-6: structured post-session feedback. Deterministic data; no
            model call. Request UUIDs are generated here, on the server, so
            the Client Component renders identically during hydration. */}
        {feedback.status === "OK" ? (
          <SarahSessionFeedback
            prompts={feedback.opportunities.map((opportunity) => ({
              ...opportunity,
              requestId: randomUUID(),
            }))}
          />
        ) : (
          <Card>
            <p role="alert">Session feedback could not be loaded right now.</p>
          </Card>
        )}
      </div>
    </AcademyShell>
  );
}
