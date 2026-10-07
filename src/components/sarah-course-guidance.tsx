"use client";
import Link from "next/link";
import { useActionState } from "react";
import { Badge, Card } from "./ui";
import { SARAH_MESSAGE_MAX, SARAH_PERSONA } from "@/domain/sarah";
import {
  SARAH_COURSE_GUIDANCE_INTENT,
  SARAH_COURSE_GUIDANCE_STATUS_MESSAGE,
  SARAH_RECOMMENDATIONS_MAX,
  type SarahCourseGuidanceMode,
  type SarahCourseRecommendationCard,
} from "@/domain/sarah-course-guidance";
import { formatOfferPrice } from "@/domain/commercial-v1-commerce";
import { DELIVERY_PLAN_DEFINITIONS } from "@/domain/commercial-v1-launch";
import {
  askSarahCourseGuidanceAction,
  type SarahCourseGuidanceActionState,
} from "@/app/student/sarah/course-guidance-actions";

export type SarahCourseGuidancePanelState = {
  result: SarahCourseGuidanceActionState;
  idempotencyKey: string;
};

// The same key discipline as the AC-5 ask panel: every resolved response,
// including DUPLICATE, rotates to a fresh key for the next deliberate
// message; only an unresolved transport failure keeps it, so a retry of the
// same request stays a safe duplicate. Rotation happens in the action
// result, never during render.
export async function submitSarahCourseGuidance(
  previous: SarahCourseGuidancePanelState,
  form: FormData,
  send: (
    previous: SarahCourseGuidanceActionState,
    form: FormData,
  ) => Promise<SarahCourseGuidanceActionState> = askSarahCourseGuidanceAction,
  newKey: () => string = () => crypto.randomUUID(),
): Promise<SarahCourseGuidancePanelState> {
  try {
    const result = await send(previous.result, form);
    return { result, idempotencyKey: newKey() };
  } catch {
    return {
      result: { status: "RETRY_LATER" },
      idempotencyKey: previous.idempotencyKey,
    };
  }
}

const MODE_INTRO: Record<SarahCourseGuidanceMode, string> = {
  PROSPECT:
    "Tell Sarah what you are looking for. She can explain Ducelio's published courses, their format and price, and suggest options if any fit. Suggestions are optional.",
  POST_COURSE:
    "Your course has ended. Sarah can explain which published Ducelio courses are open now and how a new enrolment and its price work, and suggest options if any fit. Suggestions are optional.",
};

// Calendar date of the authoritative cohort start, independent of the
// viewer's time zone.
function formatStartDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

// Every fact on the card comes from Ducelio's current published course
// projection, resolved by the validated slug. Only the short reason is
// Sarah's own words, shown as clearly subordinate.
function RecommendationCard({ card }: { card: SarahCourseRecommendationCard }) {
  const plan = DELIVERY_PLAN_DEFINITIONS[card.deliveryPlan];
  return (
    <article className="support-record" aria-label={card.title}>
      <Badge tone="gold">{card.examinationBody}</Badge>{" "}
      <Badge tone="blue">{plan.label}</Badge>
      <h4>{card.title}</h4>
      <p className="muted">{card.qualificationName}</p>
      <p className="course-price">
        {formatOfferPrice(card.priceAmountMinor, card.currency)}
      </p>
      <p className="muted">
        Next cohort starts {formatStartDate(card.cohortStartsOn)} · structured
        over {plan.weeks} weeks.
      </p>
      <p className="config-caption">
        Why Sarah suggested it (AI): {card.reason}
      </p>
      <Link href={`/courses/${card.slug}`} className="button secondary">
        View course details <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

// AC-7: course guidance with Sarah Mitchell. Rendered only when the
// database-derived mode is PROSPECT or POST_COURSE; never during an active
// course. Sarah suggests at most three published courses; she cannot buy,
// enrol, reserve a place, apply a code or change a price.
export function SarahCourseGuidancePanel({
  mode,
  initialIdempotencyKey,
}: {
  mode: SarahCourseGuidanceMode;
  initialIdempotencyKey: string;
}) {
  const [panel, formAction, pending] = useActionState<
    SarahCourseGuidancePanelState,
    FormData
  >((previous, form) => submitSarahCourseGuidance(previous, form), {
    result: {},
    idempotencyKey: initialIdempotencyKey,
  });
  const state = panel.result;
  // At most three, already enforced by the server contract; capped again
  // here so the page can never show more.
  const cards = (state.recommendations ?? []).slice(
    0,
    SARAH_RECOMMENDATIONS_MAX,
  );
  const unavailable = state.unavailableRecommendations ?? 0;
  return (
    <Card>
      <h2>Find a course</h2>
      <p>{MODE_INTRO[mode]}</p>
      <form action={formAction}>
        <input
          type="hidden"
          name="idempotencyKey"
          value={panel.idempotencyKey}
        />
        <input
          type="hidden"
          name="intent"
          value={SARAH_COURSE_GUIDANCE_INTENT}
        />
        <label>
          What are you looking for?
          <textarea
            name="message"
            maxLength={SARAH_MESSAGE_MAX}
            minLength={1}
            required
            rows={3}
            disabled={pending}
          />
        </label>
        <button className="button" disabled={pending}>
          {pending ? "Sarah is replying…" : "Ask Sarah about courses"}
        </button>
        <p className="config-caption">
          For this, Sarah sees only Ducelio&apos;s published course list, your
          enrolment status on those courses and, after a course, which courses
          you completed. She does not use your support preferences, support
          history, session ratings, marks or scores, or payments. She cannot
          buy, enrol or hold a place for you. Your message and her reply are not
          saved.
        </p>
      </form>
      <div aria-live="polite">
        {state.error && <p role="alert">{state.error}</p>}
        {state.status && state.status !== "SUCCEEDED" && (
          <p role="status">
            {SARAH_COURSE_GUIDANCE_STATUS_MESSAGE[state.status]}
          </p>
        )}
        {state.status === "SUCCEEDED" && state.reply && (
          <div className="support-record">
            <h3>{SARAH_PERSONA.name} (AI)</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.reply}</p>
            {cards.length > 0 && (
              <section aria-label="Courses Sarah suggested">
                <p className="muted">
                  Optional suggestions. Course details and prices are
                  Ducelio&apos;s current published information.
                </p>
                {cards.map((card) => (
                  <RecommendationCard key={card.slug} card={card} />
                ))}
              </section>
            )}
            {unavailable > 0 && (
              <p role="status">
                {unavailable === 1
                  ? "One suggested course is no longer available, so it is not shown."
                  : `${unavailable} suggested courses are no longer available, so they are not shown.`}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
