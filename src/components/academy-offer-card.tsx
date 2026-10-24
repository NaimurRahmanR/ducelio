import Link from "next/link";
import {
  formatMoney,
  type AcademyCatalogueOffer,
} from "@/domain/academy-delivery";
import { ACADEMY_FORMATS } from "@/domain/academy-scheduler";

// One published Academy (direct-to-learner) offer. Every fact and price
// comes from list_academy_catalogue; learners choose their own pace and
// start date, so no cohort date is shown or implied.
export function AcademyOfferCard({ offer }: { offer: AcademyCatalogueOffer }) {
  const from = Math.min(...offer.formats.map((f) => f.amountMinor));
  return (
    <article className="offer-card">
      <p className="offer-card-provider">
        {offer.qualificationPreparation?.examinationBody ?? "Ducelio Academy"}
      </p>
      <h3>{offer.title}</h3>
      {offer.demoContent && (
        <p className="badge muted">Demonstration content</p>
      )}
      <p className="offer-card-summary">{offer.summary ?? offer.description}</p>
      <dl className="offer-card-facts">
        <div>
          <dt>Delivery</dt>
          <dd>Self-paced · your own timetable</dd>
        </div>
        <div>
          <dt>Formats</dt>
          <dd>{offer.formats.map((f) => `${f.weeks} wk`).join(" · ")}</dd>
        </div>
        <div>
          <dt>Includes</dt>
          <dd>
            {offer.lessons} lessons · {offer.labs} practicals ·{" "}
            {offer.assessments} assessments
          </dd>
        </div>
      </dl>
      <div className="offer-card-footer">
        <p className="offer-card-price">
          {formatMoney(from, offer.currency)}
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

export function AcademyFormatTable({
  offer,
}: {
  offer: AcademyCatalogueOffer;
}) {
  return (
    <ul className="acad-format-prices">
      {offer.formats.map((f) => (
        <li key={f.formatId}>
          <span>
            <strong>{ACADEMY_FORMATS[f.formatId].label}</strong> · {f.weeks}{" "}
            weeks
          </span>
          <span className="muted">
            {f.minStudyDays === f.maxStudyDays
              ? f.minStudyDays
              : `${f.minStudyDays}–${f.maxStudyDays}`}{" "}
            study days a week, classes up to {f.sessionMinutes} min
          </span>
          <strong>{formatMoney(f.amountMinor, offer.currency)}</strong>
        </li>
      ))}
    </ul>
  );
}
