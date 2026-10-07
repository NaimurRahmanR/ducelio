import Link from "next/link";
import { Brand, Badge } from "@/components/ui";
import { Card } from "@/components/ui";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";

export const dynamic = "force-dynamic";

export default async function Page() {
  const offers = await listCommercialV1Offers().catch(() => []);
  return (
    <div className="foundation">
      <header className="courses-header">
        <Brand />
        <nav aria-label="Account" className="courses-nav">
          <Link href="/login" className="button secondary">
            Sign in
          </Link>
          <Link href="/signup" className="button">
            Create account
          </Link>
        </nav>
      </header>
      <div className="foundation-copy">
        <Badge tone="gold">DUCELIO ACADEMY</Badge>
        <h1>Real courses. Real progress.</h1>
        <p>
          Structured, examination-focused programmes with a governed Professor,
          Tutor and Examiner guiding every step, plus a counsellor by your side.
        </p>
      </div>
      <section aria-labelledby="courses-heading" className="section-content">
        <h2 id="courses-heading">Available courses</h2>
        {offers.length === 0 ? (
          <Card>
            <p role="status">
              No courses are open for enrolment right now. Please check back
              soon.
            </p>
          </Card>
        ) : (
          <div className="course-grid">
            {offers.map((offer) => (
              <Link
                key={offer.slug}
                href={`/courses/${offer.slug}`}
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
      </section>
    </div>
  );
}
