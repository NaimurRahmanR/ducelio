import Link from "next/link";
import { notFound } from "next/navigation";
import { Brand, Badge, Card, ButtonLink } from "@/components/ui";
import { BuyCourseForm } from "@/components/buy-course-form";
import { getCommercialV1Offer } from "@/server/commercial-v1-commerce";
import { commerceConfig } from "@/lib/env";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const offer = await getCommercialV1Offer(slug).catch(() => ({
    ok: false as const,
    code: "NOT_FOUND" as const,
  }));
  if (!offer.ok) notFound();

  const checkoutAvailable = commerceConfig().configured;
  const next = "/courses/" + offer.slug;
  const deliveryPlan = DELIVERY_PLAN_DEFINITIONS[offer.deliveryPlan];

  return (
    <div className="foundation">
      <header className="courses-header">
        <Brand />
        <nav aria-label="Account" className="courses-nav">
          <Link href="/courses">All courses</Link>
        </nav>
      </header>
      <div className="course-detail">
        <div className="course-detail-main">
          <div className="section-heading">
            <Badge tone="gold">{offer.examinationBody}</Badge>
            <Badge tone="blue">{deliveryPlan.label}</Badge>
          </div>
          <h1>{offer.title}</h1>
          <p className="muted">{offer.qualificationName}</p>
          {offer.summary && <p>{offer.summary}</p>}
          <p className="muted">
            Next cohort starts{" "}
            {new Date(offer.cohortStartsOn).toLocaleDateString()} · structured
            over {deliveryPlan.weeks} weeks.
          </p>
        </div>
        <Card className="course-buy-card">
          <p className="course-price">
            {formatOfferPrice(offer.priceAmountMinor, offer.currency)}
          </p>
          <p className="muted">One-time course fee</p>
          {offer.viewerEntitled || offer.viewerEnrolmentStatus === "ACTIVE" ? (
            <>
              <p role="status">You already have access to this course.</p>
              <ButtonLink href="/student/study-plan">
                Continue learning <span aria-hidden="true">→</span>
              </ButtonLink>
            </>
          ) : offer.viewerEnrolmentStatus === "COMPLETED" ? (
            <p role="status">
              You have already completed this course. Visit your results for a
              full record.
            </p>
          ) : offer.viewerEnrolmentStatus === "PAUSED" ? (
            <p role="status">
              Your enrolment in this course is currently paused. Contact support
              to resume it -- no new purchase is needed.
            </p>
          ) : offer.viewerEnrolmentStatus === "WITHDRAWN" ? (
            <p role="status">
              You have a previous enrolment in this course. Contact support to
              review it -- a new purchase cannot reactivate it automatically.
            </p>
          ) : !offer.viewerAuthenticated ? (
            <>
              <p className="muted">
                Sign in or create a free account to purchase this course or use
                a reviewer code.
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
                  complimentary reviewer code can grant access without card
                  payment.
                </p>
              )}
              <BuyCourseForm
                slug={offer.slug}
                paymentAvailable={checkoutAvailable}
              />
            </>
          )}
          <p className="config-caption">
            Scheduling opens after payment is verified or complimentary access
            is granted and your enrolment is confirmed.
          </p>
        </Card>
      </div>
    </div>
  );
}
