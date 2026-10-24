import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";
import { AcademyFormatTable } from "@/components/academy-offer-card";
import { listUnifiedCourseCatalogue } from "@/server/unified-course-engine";
import { getAuthenticatedActor } from "@/server/identity";
import { commerceConfig } from "@/lib/env";
import { AcademyBuyForm } from "@/components/academy-buy-form";

export const dynamic = "force-dynamic";

// Public page of one Ducelio Academy offer. Every statement and price comes
// from the published offer; only PUBLIC_SALE offers are listed. Purchase uses
// the existing Stripe checkout through src/server/academy-commerce.ts.
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [catalogue, workspace, actor] = await Promise.all([
    listUnifiedCourseCatalogue().catch(() => null),
    visitorWorkspace(),
    getAuthenticatedActor().catch(() => null),
  ]);
  const offer = catalogue?.find((o) => o.slug === slug);
  if (!offer) notFound();
  const checkoutAvailable = commerceConfig().configured;
  const next = `/courses/${offer.slug}`;
  return (
    <div className="launch-home">
      <div className="foundation">
        <PublicHeader workspace={workspace} catalogueLink />
        <main id="main" tabIndex={-1} className="course-page">
          <section className="course-hero" aria-labelledby="course-title">
            <p className="course-hero-provider">DUCELIO ACADEMY · SELF-PACED</p>
            <h1 id="course-title">{offer.title}</h1>
            <p className="course-hero-intro">
              {offer.summary ?? offer.description}
            </p>
          </section>
          <div className="section-content acad-learner">
            <Card>
              <h2>Choose your pace</h2>
              <p className="muted">
                Every format teaches the same {offer.lessons} lessons,{" "}
                {offer.labs} practical activities and {offer.assessments}{" "}
                assessments to the same standard. After purchase, you choose a
                feasible duration, your start date, your study days and your
                class time; your assessments are scheduled from your own
                timetable.
              </p>
              <AcademyFormatTable offer={offer} />
            </Card>
            <Card>
              <h2>About this course</h2>
              <p>{offer.description}</p>
              {offer.qualificationPreparation && (
                <p className="muted">
                  {offer.qualificationPreparation.disclaimer}
                </p>
              )}
              {offer.demoContent && (
                <p className="badge muted">Demonstration content</p>
              )}
            </Card>
            <Card>
              <h2>How to join</h2>
              {!checkoutAvailable && (
                <p role="status">
                  Card checkout is currently unavailable. A valid full-discount
                  coupon can still grant access.
                </p>
              )}
              {!actor ? (
                <>
                  <p className="muted">
                    Sign in or create a free account to buy this course.
                  </p>
                  <Link
                    href={`/login?next=${encodeURIComponent(next)}`}
                    className="button full"
                  >
                    Sign in to continue <span aria-hidden="true">→</span>
                  </Link>
                  <Link
                    href={`/signup?next=${encodeURIComponent(next)}`}
                    className="button secondary full"
                  >
                    Create an account
                  </Link>
                </>
              ) : !actor.roles.includes("STUDENT") ? (
                <p role="status">Purchases are made from a learner account.</p>
              ) : (
                <AcademyBuyForm
                  slug={offer.slug}
                  currency={offer.currency}
                  formats={offer.formats}
                />
              )}
            </Card>
          </div>
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
