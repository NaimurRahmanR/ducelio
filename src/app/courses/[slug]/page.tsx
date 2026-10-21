import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, ButtonLink } from "@/components/ui";
import { BuyCourseForm } from "@/components/buy-course-form";
import { getCommercialV1Offer } from "@/server/commercial-v1-commerce";
import { commerceConfig } from "@/lib/env";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";
import { CohortDate } from "@/components/offer-card";
import { PublicHeader, visitorWorkspace } from "@/components/public-header";
import { SiteFooter } from "@/components/site-footer";

export const dynamic = "force-dynamic";

// A course's public landing page. Every statement is drawn from the
// published offer (get_commercial_v1_offer): title, summary, qualification,
// examination body, delivery plan, cohort start date and price. Learning
// outcomes, teaching methods, audience and curriculum are not part of the
// public offer contract yet, so none is claimed here. Enrolment reuses the
// existing sign-in, checkout, code and enrolment-status handling unchanged.
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [offer, workspace] = await Promise.all([
    getCommercialV1Offer(slug).catch(() => ({
      ok: false as const,
      code: "NOT_FOUND" as const,
    })),
    visitorWorkspace(),
  ]);
  if (!offer.ok) notFound();

  const checkoutAvailable = commerceConfig().configured;
  const next = "/courses/" + offer.slug;
  const deliveryPlan = DELIVERY_PLAN_DEFINITIONS[offer.deliveryPlan];

  return (
    <div className="launch-home">
      <div className="foundation">
        <PublicHeader workspace={workspace} catalogueLink />
        <main id="main" tabIndex={-1} className="course-page">
          <section className="course-hero" aria-labelledby="course-title">
            <p className="course-hero-provider">{offer.examinationBody}</p>
            <h1 id="course-title">{offer.title}</h1>
            {offer.summary && (
              <p className="course-hero-intro">{offer.summary}</p>
            )}
            <ul className="course-hero-facts" aria-label="Course at a glance">
              <li>{deliveryPlan.label}</li>
              <li>{deliveryPlan.weeks} weeks</li>
              <li>
                Starts <CohortDate date={offer.cohortStartsOn} />
              </li>
            </ul>
          </section>

          <div className="course-layout">
            <aside className="course-enrol" aria-labelledby="course-fee">
              <Card className="course-fee-card">
                <h2 id="course-fee" className="course-fee-label">
                  Course fee
                </h2>
                <p className="course-fee-price">
                  {formatOfferPrice(offer.priceAmountMinor, offer.currency)}
                </p>
                <p className="muted">One-time course fee · {offer.currency}</p>
                {offer.viewerEntitled ||
                offer.viewerEnrolmentStatus === "ACTIVE" ? (
                  <>
                    <p role="status">You already have access to this course.</p>
                    <ButtonLink href="/student/study-plan">
                      Continue learning <span aria-hidden="true">→</span>
                    </ButtonLink>
                  </>
                ) : offer.viewerEnrolmentStatus === "COMPLETED" ? (
                  <p role="status">
                    You have already completed this course. Visit your results
                    for a full record.
                  </p>
                ) : offer.viewerEnrolmentStatus === "PAUSED" ? (
                  <p role="status">
                    Your enrolment in this course is currently paused. Contact
                    support to resume it -- no new purchase is needed.
                  </p>
                ) : offer.viewerEnrolmentStatus === "WITHDRAWN" ? (
                  <p role="status">
                    You have a previous enrolment in this course. Contact
                    support to review it -- a new purchase cannot reactivate it
                    automatically.
                  </p>
                ) : !offer.viewerAuthenticated ? (
                  <>
                    <p className="muted">
                      Sign in or create a free account to purchase this course
                      or use a reviewer code.
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
                ) : (
                  <>
                    {!checkoutAvailable && (
                      <p className="notice" role="status">
                        Card checkout is temporarily unavailable. Only a valid
                        complimentary reviewer code can grant access without
                        card payment.
                      </p>
                    )}
                    <BuyCourseForm
                      slug={offer.slug}
                      paymentAvailable={checkoutAvailable}
                    />
                  </>
                )}
                <p className="config-caption">
                  Scheduling opens after payment is verified or complimentary
                  access is granted and your enrolment is confirmed.
                </p>
              </Card>
            </aside>

            <div className="course-content">
              <section aria-labelledby="course-achieve">
                <h2 id="course-achieve">What you&apos;ll achieve</h2>
                <p>
                  This course prepares you for the{" "}
                  <strong>{offer.qualificationName}</strong>, awarded by{" "}
                  {offer.examinationBody}.
                </p>
              </section>

              <section aria-labelledby="course-learn">
                <h2 id="course-learn">How you&apos;ll learn</h2>
                <ul className="course-list">
                  <li>
                    A cohort course: your place is in the cohort starting{" "}
                    <CohortDate date={offer.cohortStartsOn} />.
                  </li>
                  <li>
                    Once your enrolment is confirmed, you choose your study days
                    and follow your progress in your academy.
                  </li>
                </ul>
              </section>

              <section aria-labelledby="course-structure">
                <h2 id="course-structure">Course structure</h2>
                <dl className="course-facts">
                  <div>
                    <dt>Delivery plan</dt>
                    <dd>{deliveryPlan.label}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {deliveryPlan.weeks} weeks ({deliveryPlan.durationDays}{" "}
                      days)
                    </dd>
                  </div>
                  <div>
                    <dt>Cohort start date</dt>
                    <dd>
                      <CohortDate date={offer.cohortStartsOn} />
                    </dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="course-qualification">
                <h2 id="course-qualification">Qualification information</h2>
                <p>
                  This is a preparation course delivered on Ducelio. Completing
                  it does not award the {offer.qualificationName}: that
                  qualification is awarded only by {offer.examinationBody},
                  under its own requirements.
                </p>
              </section>
            </div>
          </div>
        </main>
      </div>
      <SiteFooter workspace={workspace} />
    </div>
  );
}
