import Link from "next/link";
import { Badge, Brand, Card } from "@/components/ui";
import {
  loadPublishedOffers,
  OfferCard,
  OfferListStatus,
} from "@/components/offer-card";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";
import { getCurrentActor } from "@/server/identity";
import { canEnter, type Actor } from "@/domain/policy";

export const dynamic = "force-dynamic";

// The public front door. Every course fact comes from the published-offer
// projection; signed-in visitors get a way back into their own workspace.
// Nothing here grants access: each destination enforces its own role.
function workspaceFor(actor: Actor | null) {
  if (!actor) return null;
  if (canEnter(actor, "student"))
    return { href: "/student", label: "Go to your academy" };
  if (canEnter(actor, "admin"))
    return { href: "/admin", label: "Go to administration" };
  if (canEnter(actor, "support"))
    return { href: "/support", label: "Go to the counsellor workspace" };
  return null;
}

export default async function Home() {
  const [catalogue, actor] = await Promise.all([
    loadPublishedOffers(listCommercialV1Offers),
    // A visitor whose session cannot be resolved is shown the signed-out page.
    getCurrentActor().catch(() => null),
  ]);
  const workspace = workspaceFor(actor);
  const featured = catalogue.offers.slice(0, 3);

  return (
    <div className="foundation launch-home">
      <header className="courses-header">
        <Brand />
        <nav aria-label="Account" className="courses-nav">
          <Link href="/courses" className="button secondary">
            Courses
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
            guided practice, controlled assessments and clear progress records,
            all in one digital academy.
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
                scheduled classes, lessons, notes and practicals, so you always
                know what comes next.
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
                Assessments are graded against published marking rules, and the
                academy records your results and course completion. Time spent
                and pages viewed never count as mastery.
              </p>
            </Card>
          </div>
        </section>

        <section className="launch-section" aria-labelledby="steps-heading">
          <h2 id="steps-heading">Getting started</h2>
          <ol className="launch-steps">
            <li>
              <strong>Choose a course.</strong> Compare published courses, their
              format, price and cohort start date.
            </li>
            <li>
              <strong>Create your account and enrol.</strong> Your place is
              confirmed only after payment is verified or a valid reviewer code
              is accepted.
            </li>
            <li>
              <strong>Plan and start learning.</strong> Choose your study days,
              join your classes and follow your progress in your academy.
            </li>
          </ol>
        </section>

        <section className="launch-section" aria-labelledby="courses-heading">
          <h2 id="courses-heading">Available courses</h2>
          <OfferListStatus ok={catalogue.ok} count={featured.length} />
          {featured.length > 0 && (
            <div className="course-grid">
              {featured.map((offer) => (
                <OfferCard key={offer.slug} offer={offer} />
              ))}
            </div>
          )}
          {catalogue.ok && featured.length > 0 && (
            <p className="launch-more">
              <Link href="/courses" className="button secondary">
                View all courses
              </Link>
            </p>
          )}
        </section>
      </main>

      <footer className="launch-footer">
        <p className="muted">
          Ducelio prepares learners for external qualifications. It does not
          award them: qualifications and certifications are awarded only by the
          relevant examination body.
        </p>
        <nav aria-label="Footer" className="courses-nav">
          <Link href="/courses">Courses</Link>
          {!workspace && <Link href="/login">Sign in</Link>}
          {!workspace && <Link href="/signup">Create an account</Link>}
          <Link href="/demo">Demo academy (fictional records)</Link>
        </nav>
      </footer>
    </div>
  );
}
