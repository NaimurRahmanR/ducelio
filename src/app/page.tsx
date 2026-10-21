import Link from "next/link";
import { Badge, Brand, Card } from "@/components/ui";
import { OpeningIntro } from "@/components/opening-intro";
import { AiLearningTeam } from "@/components/ai-learning-team";
import { getCurrentActor } from "@/server/identity";
import { workspaceFor } from "@/domain/public-workspace";
import { SiteFooter } from "@/components/site-footer";

export const dynamic = "force-dynamic";

// The public front door. Courses are browsed in the /courses catalogue;
// signed-in visitors get a way back into their own workspace.
export default async function Home() {
  // A visitor whose session cannot be resolved is shown the signed-out page.
  const actor = await getCurrentActor().catch(() => null);
  const workspace = workspaceFor(actor);

  return (
    <div className="launch-home">
      <div className="foundation">
        <OpeningIntro />
        <header className="courses-header">
          <Brand />
          <nav aria-label="Account" className="courses-nav">
            <Link href="/courses" className="button secondary">
              Browse courses
            </Link>
            {workspace ? (
              <Link href={workspace.href} className="button">
                {workspace.label}
              </Link>
            ) : (
              <Link href="/login" className="button">
                Sign in
              </Link>
            )}
          </nav>
        </header>

        <main id="main" tabIndex={-1}>
          <section className="launch-hero" aria-labelledby="home-heading">
            <Badge tone="gold">DUCELIO ACADEMY</Badge>
            <h1 id="home-heading">Your ambition. Guided to mastery.</h1>
            <p>
              Structured, examination-focused courses with scheduled classes,
              guided practice, controlled assessments and clear progress
              records, all in one digital academy.
            </p>
            <div className="launch-actions">
              <Link href="/courses" className="button">
                Explore courses
              </Link>
              {workspace ? (
                <Link href={workspace.href} className="button secondary">
                  {workspace.label}
                </Link>
              ) : (
                <Link href="/signup" className="button secondary">
                  Create an account
                </Link>
              )}
            </div>
          </section>

          <section className="launch-section" aria-labelledby="how-heading">
            <h2 id="how-heading">How Ducelio works</h2>
            <div className="course-grid">
              <Card>
                <h3>A structured course, not a content library</h3>
                <p>
                  Each course follows a published, versioned curriculum with
                  scheduled classes, lessons, notes and practicals, so you
                  always know what comes next.
                </p>
              </Card>
              <Card>
                <h3>AI teaching, clearly labelled</h3>
                <p>
                  In class you learn with Ducelio&apos;s AI Professor, and an AI
                  Tutor and Lab support your practice. AI help pauses
                  automatically while a controlled assessment is in progress.
                </p>
              </Card>
              <Card>
                <h3>Progress you can trust</h3>
                <p>
                  Assessments are graded against published marking rules, and
                  the academy records your results and course completion. Time
                  spent and pages viewed never count as mastery.
                </p>
              </Card>
            </div>
          </section>

          <AiLearningTeam />

          <section className="launch-section" aria-labelledby="steps-heading">
            <h2 id="steps-heading">Getting started</h2>
            <ol className="launch-steps">
              <li>
                <strong>Choose a course.</strong> Compare published courses,
                their format, price and cohort start date.
              </li>
              <li>
                <strong>Create your account and enrol.</strong> Your place is
                confirmed only after payment is verified or a valid reviewer
                code is accepted.
              </li>
              <li>
                <strong>Plan and start learning.</strong> Choose your study
                days, join your classes and follow your progress in your
                academy.
              </li>
            </ol>
          </section>
        </main>
      </div>

      <SiteFooter workspace={workspace} />
    </div>
  );
}
