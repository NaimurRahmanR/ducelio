"use client";
import { useActionState } from "react";
import {
  publishOfferAction,
  archiveOfferAction,
  type CommerceAdminState,
} from "@/app/admin/commerce/actions";
import type { CommercialV1OfferActivation } from "@/domain/commercial-v1-commerce";

export function PublishOfferForm({
  activations,
}: {
  activations: CommercialV1OfferActivation[];
}) {
  const [state, action, pending] = useActionState<CommerceAdminState, FormData>(
    publishOfferAction,
    {},
  );
  const sellable = activations.filter((a) => !a.publishedOfferSlug);
  return (
    <form action={action}>
      {state.error && (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      )}
      {state.message && (
        <div className="notice" role="status">
          {state.message}
        </div>
      )}
      <div className="field">
        <label htmlFor="activationId">Course activation</label>
        <select id="activationId" name="activationId" required>
          <option value="">Select an activation</option>
          {sellable.map((a) => (
            <option key={a.activationId} value={a.activationId}>
              {a.programmeTitle} · {a.cohortTitle} ({a.cohortStartsOn})
            </option>
          ))}
        </select>
        {!sellable.length && (
          <small className="muted">
            Every activation already has a published offer.
          </small>
        )}
      </div>
      <div className="field">
        <label htmlFor="slug">Public URL slug</label>
        <input
          id="slug"
          name="slug"
          placeholder="cybersecurity-foundations"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          minLength={3}
          maxLength={80}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="priceAmountMinor">
          Price (minor units, e.g. pence)
        </label>
        <input
          id="priceAmountMinor"
          name="priceAmountMinor"
          type="number"
          min={1}
          max={100_000_000}
          step={1}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="currency">Currency</label>
        <input
          id="currency"
          name="currency"
          placeholder="GBP"
          pattern="[A-Za-z]{3}"
          maxLength={3}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="summary">Summary (optional)</label>
        <input id="summary" name="summary" maxLength={500} />
      </div>
      <div className="field">
        <label htmlFor="publish-reason">Reason</label>
        <input
          id="publish-reason"
          name="reason"
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Publishing…" : "Publish offer"}
      </button>
    </form>
  );
}

export function ArchiveOfferForm() {
  const [state, action, pending] = useActionState<CommerceAdminState, FormData>(
    archiveOfferAction,
    {},
  );
  return (
    <form action={action}>
      {state.error && (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      )}
      {state.message && (
        <div className="notice" role="status">
          {state.message}
        </div>
      )}
      <div className="field">
        <label htmlFor="archive-slug">Published offer slug</label>
        <input id="archive-slug" name="slug" required />
      </div>
      <div className="field">
        <label htmlFor="archive-reason">Reason</label>
        <input
          id="archive-reason"
          name="reason"
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      <button className="button secondary" type="submit" disabled={pending}>
        {pending ? "Archiving…" : "Archive offer"}
      </button>
    </form>
  );
}
