import Link from "next/link";
import { Card } from "./ui";
import {
  formatCohortStartDate,
  formatOfferPrice,
  type CommercialV1OfferSummary,
} from "@/domain/commercial-v1-commerce";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";

// The stored cohort start day, stated as a fact. No "next"/"started" claim:
// a published offer can outlive its cohort's start, and whether a day has
// passed depends on the viewer's own clock and time zone, which the server
// does not know.
export function CohortStartDate({ date }: { date: string }) {
  const text = formatCohortStartDate(date);
  return (
    <>
      Cohort start date:{" "}
      {text === date ? text : <time dateTime={date}>{text}</time>}
    </>
  );
}

export function CohortDate({ date }: { date: string }) {
  const text = formatCohortStartDate(date);
  return text === date ? <>{text}</> : <time dateTime={date}>{text}</time>;
}

// One published offer in the catalogue. Every fact comes from the published
// offer projection (list_commercial_v1_offers); nothing here is marketing
// copy the publisher did not provide. The whole card is one link, the
// "View course" action, stretched over the card so it has a single, clearly
// named target.
export function OfferCard({ offer }: { offer: CommercialV1OfferSummary }) {
  const plan = DELIVERY_PLAN_DEFINITIONS[offer.deliveryPlan];
  return (
    <article className="offer-card">
      <p className="offer-card-provider">{offer.examinationBody}</p>
      <h3>{offer.title}</h3>
      {offer.summary && <p className="offer-card-summary">{offer.summary}</p>}
      <dl className="offer-card-facts">
        <div>
          <dt>Prepares you for</dt>
          <dd>{offer.qualificationName}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>Cohort course · {plan.label}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{plan.weeks} weeks</dd>
        </div>
        <div>
          <dt>Cohort start date</dt>
          <dd>
            <CohortDate date={offer.cohortStartsOn} />
          </dd>
        </div>
      </dl>
      <div className="offer-card-footer">
        <p className="offer-card-price">
          {formatOfferPrice(offer.priceAmountMinor, offer.currency)}
          <span>{offer.currency}</span>
        </p>
        <Link href={`/courses/${offer.slug}`} className="offer-card-link">
          View course<span className="sr-only">: {offer.title}</span>{" "}
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

// A catalogue that could not be read is not the same as an empty one: an
// outage must never be presented as "no courses are open".
export async function loadPublishedOffers(
  list: () => Promise<CommercialV1OfferSummary[]>,
) {
  try {
    return { ok: true as const, offers: await list() };
  } catch {
    return { ok: false as const, offers: [] };
  }
}

export function OfferListStatus({ ok, count }: { ok: boolean; count: number }) {
  if (!ok)
    return (
      <Card>
        <p role="alert">
          Courses could not be loaded right now. Please try again shortly.
        </p>
      </Card>
    );
  if (count === 0)
    return (
      <Card>
        <p role="status">
          No courses are open for enrolment right now. Please check back soon.
        </p>
      </Card>
    );
  return null;
}
