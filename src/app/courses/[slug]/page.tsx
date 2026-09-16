import Link from "next/link";
import { notFound } from "next/navigation";
import { Brand, Badge, Card, ButtonLink } from "@/components/ui";
import { BuyCourseForm } from "@/components/buy-course-form";
import { getCommercialV1Offer } from "@/server/commercial-v1-commerce";
import { commerceConfig } from "@/lib/env";

export const dynamic = "force-dynamic";

function formatPrice(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

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
          <Badge tone="gold">{offer.examinationBody}</Badge>
          <h1>{offer.title}</h1>
          <p className="muted">{offer.qualificationName}</p>
          {offer.summary && <p>{offer.summary}</p>}
          <p className="muted">
            Next cohort starts{" "}
            {new Date(offer.cohortStartsOn).toLocaleDateString()}
          </p>
        </div>
        <Card className="course-buy-card">
          <p className="course-price">
            {formatPrice(offer.priceAmountMinor, offer.currency)}
          </p>
          {
            // V2 correction (finding 4): an existing ACADEMIC enrolment --
            // independent of commerce entitlement -- must also stop a fresh
            // purchase from ever being offered. ACTIVE/PAUSED/COMPLETED all
            // mean real access already exists; WITHDRAWN means a prior
            // enrolment exists that a fresh purchase must not paper over.
            offer.viewerEntitled || offer.viewerEnrolmentStatus === "ACTIVE" ? (
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
                Your enrolment in this course is currently paused. Contact
                support to resume it -- no new purchase is needed.
              </p>
            ) : offer.viewerEnrolmentStatus === "WITHDRAWN" ? (
              <p role="status">
                You have a previous enrolment in this course. Contact support to
                review it -- a new purchase cannot reactivate it automatically.
              </p>
            ) : !offer.viewerAuthenticated ? (
              <>
                <p className="muted">
                  Sign in or create a free account to purchase this course.
                </p>
                <Link
                  href={`/login?next=${encodeURIComponent(next)}`}
                  className="button full"
                >
                  Sign in to buy <span aria-hidden="true">→</span>
                </Link>
                <Link
                  href={`/signup?next=${encodeURIComponent(next)}`}
                  className="button secondary full"
                >
                  Create an account
                </Link>
              </>
            ) : !checkoutAvailable ? (
              <p className="notice" role="alert">
                Checkout is temporarily unavailable. Please try again shortly.
              </p>
            ) : (
              <BuyCourseForm slug={offer.slug} />
            )
          }
          <p className="config-caption">
            Scheduling opens as soon as your purchase is verified and your
            enrolment is confirmed.
          </p>
        </Card>
      </div>
    </div>
  );
}
