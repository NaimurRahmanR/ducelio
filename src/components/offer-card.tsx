import Link from "next/link";
import { Badge, Card } from "./ui";
import {
  formatCohortStartDate,
  formatOfferPrice,
  type CommercialV1OfferSummary,
} from "@/domain/commercial-v1-commerce";

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

// One published offer, shared by the public homepage and the catalogue so
// both always show the same authoritative projection the same way.
export function OfferCard({ offer }: { offer: CommercialV1OfferSummary }) {
  return (
    <Link href={`/courses/${offer.slug}`} className="course-card">
      <Card>
        <Badge>{offer.examinationBody}</Badge>
        <h3>{offer.title}</h3>
        <p className="muted">{offer.qualificationName}</p>
        {offer.summary && <p>{offer.summary}</p>}
        <p className="course-price">
          {formatOfferPrice(offer.priceAmountMinor, offer.currency)}
        </p>
        <p className="muted">
          <CohortStartDate date={offer.cohortStartsOn} />
        </p>
      </Card>
    </Link>
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
