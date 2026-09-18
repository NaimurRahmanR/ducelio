"use client";
import { useActionState } from "react";
import {
  archiveCampaignAction,
  archiveOfferAction,
  createCampaignAction,
  publishOfferAction,
  type CommerceAdminState,
} from "@/app/admin/commerce/actions";
import type {
  CommercialV1CampaignAdmin,
  CommercialV1OfferActivation,
} from "@/domain/commercial-v1-commerce";

function CampaignState({ state }: { state: CommerceAdminState }) {
  return (
    <>
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
    </>
  );
}

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
      <CampaignState state={state} />
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
          placeholder="security-plus-sy0-701"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          minLength={3}
          maxLength={80}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="priceAmountMinor">Price (minor units)</label>
        <input
          id="priceAmountMinor"
          name="priceAmountMinor"
          type="number"
          min={1}
          max={100_000_000}
          step={1}
          defaultValue={2999}
          required
        />
        <small className="muted">
          Security+ founding launch default: 2999 pence (£29.99). Change only
          when a different approved offer is intended.
        </small>
      </div>
      <div className="field">
        <label htmlFor="currency">Currency</label>
        <input
          id="currency"
          name="currency"
          defaultValue="GBP"
          pattern="[A-Za-z]{3}"
          maxLength={3}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="deliveryPlan">Delivery plan</label>
        <select
          id="deliveryPlan"
          name="deliveryPlan"
          defaultValue="STANDARD_6_WEEK"
          required
        >
          <option value="ACCELERATED_2_WEEK">2-week Accelerated</option>
          <option value="INTENSIVE_4_WEEK">4-week Intensive</option>
          <option value="STANDARD_6_WEEK">6-week Standard</option>
        </select>
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
      <CampaignState state={state} />
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

export function CreateCampaignForm({
  publishedOfferSlugs,
}: {
  publishedOfferSlugs: string[];
}) {
  const [state, action, pending] = useActionState<CommerceAdminState, FormData>(
    createCampaignAction,
    {},
  );
  return (
    <form action={action}>
      <CampaignState state={state} />
      <div className="field">
        <label htmlFor="campaign-offer">Published offer</label>
        <select id="campaign-offer" name="offerSlug" required>
          <option value="">Select an offer</option>
          {publishedOfferSlugs.map((slug) => (
            <option value={slug} key={slug}>
              {slug}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="campaign-code">Code</label>
        <input
          id="campaign-code"
          name="code"
          placeholder="FOUNDING-20"
          minLength={4}
          maxLength={32}
          pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="campaign-kind">Kind</label>
        <select id="campaign-kind" name="kind" required>
          <option value="PERCENT_OFF">Percent off</option>
          <option value="FIXED_PRICE">Fixed price</option>
          <option value="REVIEWER_COMPLIMENTARY">Reviewer complimentary</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="percentOff">Percent off (percent campaigns only)</label>
        <input
          id="percentOff"
          name="percentOff"
          type="number"
          min={1}
          max={99}
          step={1}
        />
      </div>
      <div className="field">
        <label htmlFor="fixedPriceAmountMinor">
          Fixed price in minor units (fixed-price campaigns only)
        </label>
        <input
          id="fixedPriceAmountMinor"
          name="fixedPriceAmountMinor"
          type="number"
          min={1}
          max={100_000_000}
          step={1}
        />
      </div>
      <div className="field">
        <label htmlFor="maxRedemptions">Maximum redemptions</label>
        <input
          id="maxRedemptions"
          name="maxRedemptions"
          type="number"
          min={1}
          max={1_000_000}
          step={1}
          defaultValue={50}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="startsAt">Starts at (ISO timestamp with zone)</label>
        <input
          id="startsAt"
          name="startsAt"
          placeholder="2026-09-20T00:00:00Z"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="endsAt">Ends at (ISO timestamp with zone)</label>
        <input
          id="endsAt"
          name="endsAt"
          placeholder="2026-10-20T00:00:00Z"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="campaign-reason">Reason</label>
        <input
          id="campaign-reason"
          name="reason"
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}

export function ArchiveCampaignForm() {
  const [state, action, pending] = useActionState<CommerceAdminState, FormData>(
    archiveCampaignAction,
    {},
  );
  return (
    <form action={action}>
      <CampaignState state={state} />
      <div className="field">
        <label htmlFor="archive-campaign-code">Campaign code</label>
        <input
          id="archive-campaign-code"
          name="code"
          minLength={4}
          maxLength={32}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="archive-campaign-reason">Reason</label>
        <input
          id="archive-campaign-reason"
          name="reason"
          minLength={5}
          maxLength={300}
          required
        />
      </div>
      <button className="button secondary" type="submit" disabled={pending}>
        {pending ? "Archiving…" : "Archive campaign"}
      </button>
    </form>
  );
}

export function CampaignList({
  campaigns,
}: {
  campaigns: CommercialV1CampaignAdmin[];
}) {
  if (!campaigns.length)
    return <p className="muted">No campaigns have been configured yet.</p>;
  return (
    <div>
      {campaigns.map((campaign) => (
        <div className="support-record" key={campaign.code}>
          <strong>{campaign.code}</strong>
          <p>
            {campaign.offerSlug} · {campaign.kind.replaceAll("_", " ")} ·{" "}
            {new Intl.NumberFormat("en-GB", {
              style: "currency",
              currency: campaign.currency,
            }).format(campaign.effectivePriceAmountMinor / 100)}
          </p>
          <p className="muted">
            {campaign.redemptionCount}/{campaign.maxRedemptions} redeemed ·{" "}
            {campaign.state} · {campaign.startsAt} → {campaign.endsAt}
          </p>
        </div>
      ))}
    </div>
  );
}
