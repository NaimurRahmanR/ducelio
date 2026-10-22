import {
  loadPublishedOffers,
  OfferCard,
  OfferListStatus,
} from "@/components/offer-card";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";
import { listAcademyCatalogue } from "@/server/academy-delivery";
import { AcademyOfferCard } from "@/components/academy-offer-card";

export const dynamic = "force-dynamic";

// The public course catalogue: every offer the database reports as
// PUBLISHED, from any publisher on the platform, exactly as published.
export default async function Page() {
  const [catalogue, workspace, academy] = await Promise.all([
    loadPublishedOffers(listCommercialV1Offers),
    visitorWorkspace(),
    // Ducelio Academy (self-paced) offers. A failed read hides only this
    // section; it never alters the cohort catalogue above.
    listAcademyCatalogue().catch(() => []),
  ]);
  const count = catalogue.offers.length;
  return (
    <div className="launch-home">
      <div className="foundation">
        <PublicHeader workspace={workspace} />
        <main id="main" tabIndex={-1}>
          <section
            className="catalogue-hero"
            aria-labelledby="catalogue-heading"
          >
            <p className="catalogue-eyebrow">COURSE CATALOGUE</p>
            <h1 id="catalogue-heading">Find your next course</h1>
            <p>
              Each course shows its published price, delivery plan and cohort
              start date. Open a course to see its full details and how to
              enrol.
            </p>
          </section>
          <section aria-labelledby="courses-heading" className="catalogue">
            <div className="catalogue-heading">
              <h2 id="courses-heading">Available courses</h2>
              {catalogue.ok && count > 0 && (
                <p className="muted">
                  {count} {count === 1 ? "course" : "courses"} open for
                  enrolment
                </p>
              )}
            </div>
            <OfferListStatus ok={catalogue.ok} count={count} />
            {count > 0 && (
              <div className="offer-grid">
                {catalogue.offers.map((offer) => (
                  <OfferCard key={offer.slug} offer={offer} />
                ))}
              </div>
            )}
          </section>
          {academy.length > 0 && (
            <section aria-labelledby="academy-heading" className="catalogue">
              <div className="catalogue-heading">
                <h2 id="academy-heading">
                  Ducelio Academy · learn on your own timetable
                </h2>
                <p className="muted">
                  Choose a format from 2 to 12 weeks, your start date and your
                  study days.
                </p>
              </div>
              <div className="offer-grid">
                {academy.map((offer) => (
                  <AcademyOfferCard key={offer.slug} offer={offer} />
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
