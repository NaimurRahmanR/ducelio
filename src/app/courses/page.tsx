import {
  loadPublishedOffers,
  OfferCard,
  OfferListStatus,
} from "@/components/offer-card";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { listCommercialV1Offers } from "@/server/commercial-v1-commerce";

export const dynamic = "force-dynamic";

// The public course catalogue: every offer the database reports as
// PUBLISHED, from any publisher on the platform, exactly as published.
export default async function Page() {
  const [catalogue, workspace] = await Promise.all([
    loadPublishedOffers(listCommercialV1Offers),
    visitorWorkspace(),
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
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
