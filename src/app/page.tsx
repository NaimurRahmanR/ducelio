import Link from "next/link";
import { Badge, Brand, Card } from "@/components/ui";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";

export const dynamic = "force-dynamic";

export default async function Home() {
  const offers = await listCommercialV1Offers().catch(() => []);

  return (
    <div className="foundation">
      <header className="courses-header">
        <Brand />
        <nav aria-label="Account" className="courses-nav">
          <Link href="/courses" className="button secondary">
            Explore courses
          </Link>
          <Link href="/login" className="button">
            Sign in
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="foundation-copy" aria-labelledby="home-heading">
          <Badge tone="gold">DUCELIO ACADEMY</Badge>
          <h1 id="home-heading">Your ambition. Guided to mastery.</h1>
          <p>
            Learn through structured lessons, practical exercises, guided AI
            teaching and meaningful progress — all in one place.
          </p>
          <p>
            <Link href="/courses" className="button">
              Explore available courses
            </Link>
            {" "}
            <Link href="/signup" className="button secondary">
              Create an account
            </Link>
          </p>
        </section>

        <section className="section-content" aria-labelledby="how-heading">
          <div className="section-heading">
            <h2 id="how-heading">A clearer way to learn</h2>
          </div>
          <div className="course-grid">
            <Card>
              <h3>Follow a structured course</h3>
              <p>
                Study a defined curriculum with organised lessons and resources,
                rather than searching for the next thing to learn.
              </p>
            </Card>
            <Card>
              <h3>Get support as you practise</h3>
              <p>
                Use the Professor, Tutor and practical support experiences
                available within your course.
              </p>
            </Card>
            <Card>
              <h3>Understand your progress</h3>
              <p>
                Complete assessments and review your results and progress in
                your learner account.
              </p>
            </Card>
          </div>
        </section>

        <section className="section-content" aria-labelledby="courses-heading">
          <div className="section-heading">
            <h2 id="courses-heading">Available courses</h2>
          </div>
          {offers.length === 0 ? (
            <Card>
              <p role="status">
                No courses are open for enrolment right now. Please check back
                soon.
              </p>
            </Card>
          ) : (
            <div className="course-grid">
              {offers.slice(0, 3).map((offer) => (
                <Link
                  key={offer.slug}
                  href={"/courses/" + offer.slug}
                  className="course-card"
                >
                  <Card>
                    <Badge>{offer.examinationBody}</Badge>
                    <h3>{offer.title}</h3>
                    <p className="muted">{offer.qualificationName}</p>
                    {offer.summary && <p>{offer.summary}</p>}
                    <p className="course-price">
                      {formatOfferPrice(offer.priceAmountMinor, offer.currency)}
                    </p>
                    <p className="muted">
                      Next cohort starts{" "}
                      {new Date(offer.cohortStartsOn).toLocaleDateString()}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          )}
          <p>
            <Link href="/courses" className="button secondary">
              View all courses
            </Link>
          </p>
        </section>
      </main>

      <footer className="section-content">
        <p className="muted">
          Ducelio is an independent learning platform. Examination-preparation
          courses do not themselves award third-party certifications.
        </p>
        <nav aria-label="Footer" className="courses-nav">
          <Link href="/courses">Courses</Link>
          <Link href="/login">Sign in</Link>
        </nav>
      </footer>
    </div>
  );
}
