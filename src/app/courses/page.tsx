import Link from "next/link";
import { Brand, Badge } from "@/components/ui";
import {
  loadPublishedOffers,
  OfferCard,
  OfferListStatus,
} from "@/components/offer-card";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";

export const dynamic = "force-dynamic";

export default async function Page() {
  const catalogue = await loadPublishedOffers(listCommercialV1Offers);
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
      <main id="main">
        <div className="foundation-copy">
          <Badge tone="gold">DUCELIO ACADEMY</Badge>
          <h1>Real courses. Real progress.</h1>
          <p>
            Structured, examination-focused programmes with a governed
            Professor, Tutor and Examiner guiding every step, plus a counsellor
            by your side.
          </p>
        </div>
        <section aria-labelledby="courses-heading" className="section-content">
          <h2 id="courses-heading">Available courses</h2>
          <OfferListStatus ok={catalogue.ok} count={catalogue.offers.length} />
          {catalogue.offers.length > 0 && (
            <div className="course-grid">
              {catalogue.offers.map((offer) => (
                <OfferCard key={offer.slug} offer={offer} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
