import Link from "next/link";
import { z } from "zod";
import { Card } from "./ui";
import { CommerceOperationForm } from "./commerce-operation-form";
import {
  commerceViewSchema,
  accessReasonLabels,
  type CommerceDiagnosis,
} from "@/domain/commercial-v1-commerce-operations";
import {
  diagnoseCommerceAccess,
  listCommerceOperations,
} from "@/server/commercial-v1-commerce/operations";

export type CommerceSearchParams = Record<
  string,
  string | string[] | undefined
>;
// The console is shown both at /admin/commerce and inside Sales & Commerce;
// links keep the user on whichever page embeds it (per render, no shared
// module state).
function hrefFor(
  path: string,
  base: Record<string, string>,
  params: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams(base);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) query.set(k, String(v));
  return path + "?" + query.toString();
}
function Diagnosis({ data: d }: { data: CommerceDiagnosis }) {
  const items = [
    ["Learner", d.learnerName],
    ["Course", `${d.courseTitle} (${d.versionLabel})`],
    ["Offer", d.offerSlug],
    ["Cohort", d.cohortTitle],
    ["Order", d.orderId ?? "Not created"],
    ["Order status", d.orderState ?? "None"],
    [
      "Price",
      d.amountMinor === null
        ? "No paid order"
        : `${(d.amountMinor / 100).toFixed(2)} ${d.currency}`,
    ],
    [
      "Payment received",
      d.paymentConfirmed
        ? "Verified payment recorded"
        : "No verified payment recorded",
    ],
    [
      "Fulfilment attempted",
      d.fulfilmentAttempted ? "Yes" : "No recorded attempt",
    ],
    ["Full refund", d.refunded ? "Verified" : "Not recorded"],
    ["Entitlement", d.entitlementState ?? "Not created"],
    ["Entitlement source", d.entitlementSource ?? "None"],
    ["Enrolment", d.enrolmentId ?? "Not created"],
    ["Enrolment status", d.enrolmentStatus ?? "None"],
    ["Enrolment origin", d.enrolmentOrigin ?? "None"],
    ["Current learning access", d.hasAccess ? "Active" : "Not active"],
    ["Reconciliation state", d.reconciliationState],
  ];
  return (
    <Card>
      <h2>Access diagnosis</h2>
      <dl>
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p role="status">
        {accessReasonLabels[d.accessReason] ?? d.accessReason}
      </p>
      {d.revocationReason && <p>Revocation reason: {d.revocationReason}</p>}
      {d.entitlementOrderId && d.entitlementOrderId !== d.orderId && (
        <p>
          This course entitlement belongs to a different order. Refunding this
          order will not revoke that separately funded access.
        </p>
      )}
      <details>
        <summary>Linked record references</summary>
        <p>
          Learner: {d.learnerId}
          <br />
          Entitlement: {d.entitlementId ?? "None"}
          <br />
          Programme version: {d.programmeVersionId}
          <br />
          Cohort: {d.cohortId}
          <br />
          Activation: {d.activationId}
          <br />
          Checkout Session: {d.sessionId ?? "Not bound"}
        </p>
      </details>
      {d.orderId && (
        <>
          <h3>Reconciliation</h3>
          <p>
            Re-check Stripe payment and refund evidence. Retries use the
            governed fulfilment rules. Paused, withdrawn or completed academic
            records are never reopened here.
          </p>
          <CommerceOperationForm id={d.orderId} operation="reconcile" />
        </>
      )}
      {d.entitlementId && d.entitlementState === "ACTIVE" && (
        <>
          <h3>Access cancellation</h3>
          <p>
            Financial refunds are initiated in the Stripe Dashboard. Use
            reconciliation after a full refund; use cancellation for a
            separately approved access withdrawal.
          </p>
          <CommerceOperationForm id={d.entitlementId} operation="revoke" />
        </>
      )}
      <h3>Payment events</h3>
      {d.payments.length ? (
        <ul>
          {d.payments.map((p) => (
            <li key={p.eventId}>
              {p.status} · {(p.amountMinor / 100).toFixed(2)} {p.currency} ·{" "}
              {p.verifiedAt} · {p.eventId}
            </li>
          ))}
        </ul>
      ) : (
        <p>No payment events recorded.</p>
      )}
      {d.paymentsTruncated && <p>Showing the latest 50 payment events.</p>}
      <h3>Audit evidence</h3>
      {d.audit.length ? (
        <ul>
          {d.audit.map((a, i) => (
            <li key={i}>
              {a.at} · {a.actor} · {a.action} · {a.reason}
            </li>
          ))}
        </ul>
      ) : (
        <p>No matching audit events recorded.</p>
      )}
      {d.auditTruncated && (
        <p>
          Showing the latest 50 audit events. Browse the Audit section for older
          commerce actions.
        </p>
      )}
    </Card>
  );
}
export async function CommerceOperationsConsole({
  params,
  basePath = "/admin/commerce",
  baseParams = {},
}: {
  params: CommerceSearchParams;
  basePath?: string;
  baseParams?: Record<string, string>;
}) {
  const href = (params: Record<string, string | number | undefined>) =>
    hrefFor(basePath, baseParams, params);
  const view = commerceViewSchema.catch("orders").parse(params.view);
  const query = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .catch(0)
    .parse(params.offset ?? 0);
  const learner = z.uuid().safeParse(params.learner),
    offer = z.uuid().safeParse(params.offer),
    order = z.uuid().safeParse(params.order);
  const records = await listCommerceOperations({ view, query, offset });
  let diagnosis: CommerceDiagnosis | undefined,
    diagnosticError = false;
  if (order.success || (learner.success && offer.success)) {
    try {
      diagnosis = await diagnoseCommerceAccess(
        order.success
          ? { orderId: order.data }
          : { learnerId: learner.data!, offerId: offer.data! },
      );
    } catch {
      diagnosticError = true;
    }
  }
  const tabs = {
    orders: "Orders",
    entitlements: "Entitlements",
    redemptions: "Campaign redemptions",
    issues: "Issues / Reconciliation",
    offers: "Offers",
    learners: "Learner access",
    audit: "Audit",
  };
  return (
    <>
      <Card>
        <h2>Commerce operations</h2>
        <nav aria-label="Commerce sections">
          {Object.entries(tabs).map(([key, label]) => (
            <Link
              key={key}
              href={href({ view: key })}
              aria-current={view === key ? "page" : undefined}
              style={{ marginRight: "1rem" }}
            >
              {label}
            </Link>
          ))}
        </nav>
        <p>
          Find records by learner name, course slug or reference. Records are
          shown in pages of 25.
        </p>
        {view === "issues" && (
          <p>
            RECEIVED means processing did not finish. UNRESOLVED includes the
            bounded failure reason. Retry re-reads the real Stripe event and
            payment; no payment status is entered here.
          </p>
        )}
        {view === "offers" && learner.success && (
          <p>
            Choose a course to diagnose the selected learner’s access, including
            a missing order.
          </p>
        )}
        <form method="get" action={basePath}>
          {Object.entries(baseParams).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input type="hidden" name="view" value={view} />
          {learner.success && (
            <input type="hidden" name="learner" value={learner.data} />
          )}
          <label htmlFor="commerce-search">
            Search {tabs[view].toLowerCase()}
          </label>
          <input
            id="commerce-search"
            name="q"
            defaultValue={query}
            maxLength={100}
          />
          <button className="button" type="submit">
            Search
          </button>
        </form>
        {!records.rows.length ? (
          <p>No matching records.</p>
        ) : (
          <ul>
            {records.rows.map((row) => (
              <li key={row.id}>
                <h3>{row.title}</h3>
                <p>
                  {row.subtitle} · {row.state}
                  {row.occurredAt ? ` · ${row.occurredAt}` : ""}
                </p>
                {row.reason && (
                  <p>{accessReasonLabels[row.reason] ?? row.reason}</p>
                )}
                {row.orderId ? (
                  <Link
                    href={href({ view, q: query, offset, order: row.orderId })}
                  >
                    Inspect order and access
                  </Link>
                ) : row.learnerId && row.offerId ? (
                  <Link
                    href={href({
                      view,
                      q: query,
                      offset,
                      learner: row.learnerId,
                      offer: row.offerId,
                    })}
                  >
                    Inspect entitlement and access
                  </Link>
                ) : view === "learners" && row.learnerId ? (
                  <Link href={href({ view: "offers", learner: row.learnerId })}>
                    Choose course for diagnosis
                  </Link>
                ) : view === "offers" && learner.success && row.offerId ? (
                  <Link
                    href={href({
                      view,
                      q: query,
                      offset,
                      learner: learner.data,
                      offer: row.offerId,
                    })}
                  >
                    Diagnose access to this course
                  </Link>
                ) : null}
                {view === "issues" &&
                  (row.state === "RECEIVED" || row.state === "UNRESOLVED") && (
                    <CommerceOperationForm id={row.id} operation="retry" />
                  )}
              </li>
            ))}
          </ul>
        )}
        <nav aria-label="Commerce result pages">
          {offset > 0 && (
            <Link
              href={href({
                view,
                q: query,
                offset: Math.max(0, offset - 25),
                learner: learner.success ? learner.data : undefined,
              })}
            >
              Previous page
            </Link>
          )}{" "}
          {records.hasMore && offset < 100000 && (
            <Link
              href={href({
                view,
                q: query,
                offset: offset + 25,
                learner: learner.success ? learner.data : undefined,
              })}
            >
              Next page
            </Link>
          )}
          {records.hasMore && offset >= 100000 && (
            <p>Refine the search to inspect additional records.</p>
          )}
        </nav>
      </Card>
      {diagnosticError && (
        <Card>
          <p role="alert">
            The selected record could not be diagnosed. Check the reference and
            your access, then retry.
          </p>
        </Card>
      )}
      {diagnosis && <Diagnosis data={diagnosis} />}
    </>
  );
}
