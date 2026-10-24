import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { listUnifiedCourseCatalogue } from "@/server/unified-course-engine";
import { AcademyOfferCard } from "@/components/academy-offer-card";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [catalogue, workspace] = await Promise.all([
    listUnifiedCourseCatalogue().then(
      (offers) => ({ ok: true, offers }),
      () => ({ ok: false, offers: [] }),
    ),
    visitorWorkspace(),
  ]);
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
              One course price. After purchase, activate your course and choose
              a feasible duration, start date and personal timetable.
            </p>
          </section>
          <section aria-labelledby="courses-heading" className="catalogue">
            <h2 id="courses-heading">Available courses</h2>
            {!catalogue.ok ? (
              <p role="alert">
                The catalogue is temporarily unavailable. Please try again
                later.
              </p>
            ) : catalogue.offers.length === 0 ? (
              <p role="status">No courses are published yet.</p>
            ) : (
              <div className="offer-grid">
                {catalogue.offers.map((offer) => (
                  <AcademyOfferCard key={offer.slug} offer={offer} />
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
