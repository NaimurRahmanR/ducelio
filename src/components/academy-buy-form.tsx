"use client";
import { useActionState, useState } from "react";
import {
  startAcademyCheckout,
  type AcademyCheckoutState,
} from "@/app/academy/actions";
import { formatMoney } from "@/domain/academy-delivery";
import {
  ACADEMY_FORMATS,
  type AcademyFormatId,
} from "@/domain/academy-scheduler";

export function AcademyBuyForm({
  slug,
  currency,
  formats,
}: {
  slug: string;
  currency: string;
  formats: { formatId: AcademyFormatId; amountMinor: number }[];
}) {
  const [formatId, setFormatId] = useState<AcademyFormatId>(
    formats[0].formatId,
  );
  const [state, action, pending] = useActionState<
    AcademyCheckoutState,
    FormData
  >(startAcademyCheckout, {});
  return (
    <form action={action} className="acad-planner">
      <input type="hidden" name="slug" value={slug} />
      <fieldset className="acad-formats">
        <legend>Choose your learning format</legend>
        {formats.map((f) => (
          <label
            key={f.formatId}
            className={
              f.formatId === formatId ? "acad-format on" : "acad-format"
            }
          >
            <input
              type="radio"
              name="formatId"
              value={f.formatId}
              checked={f.formatId === formatId}
              onChange={() => setFormatId(f.formatId)}
            />
            <strong>{ACADEMY_FORMATS[f.formatId].label}</strong>
            <span>{ACADEMY_FORMATS[f.formatId].weeks} weeks</span>
            <small>{formatMoney(f.amountMinor, currency)}</small>
          </label>
        ))}
      </fieldset>
      <p className="muted">
        Your format is fixed by your purchase. You choose your start date and
        study days after payment.
      </p>
      <button className="button" disabled={pending}>
        {pending ? "Opening secure checkout…" : "Continue to secure payment"}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
