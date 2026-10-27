"use client";
import Link from "next/link";
import { useActionState } from "react";
import { formatDate } from "./learner-format";

// Certificates and payment receipts on the profile page (docs/61 §4). A
// certificate exists only after a recorded course completion; it confirms a
// Ducelio preparation course and is not an official certification from the
// examination body. Receipts exist only for verified paid orders.
export type CertificateSummary = {
  certificateId: string;
  courseTitle: string;
  issuerName: string;
  verificationCode: string;
  issuedAt: string;
  revoked: boolean;
};
export type EligibleCompletion = {
  enrolmentId: string;
  courseTitle: string;
  completedAt: string;
};
export type ReceiptSummary = {
  receiptId: string;
  receiptNumber: string;
  courseTitle: string;
  amount: string; // formatted on the server
  issuedAt: string;
  refunded: boolean;
};
type IssueState = { ok?: boolean; error?: string; certificateId?: string };
type IssueAction = (
  previous: IssueState,
  form: FormData,
) => Promise<IssueState>;

function IssueCertificate({
  completion,
  issueAction,
  timeZone,
}: {
  completion: EligibleCompletion;
  issueAction: IssueAction;
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(issueAction, {});
  return (
    <li>
      <span>
        <strong>{completion.courseTitle}</strong> · completed{" "}
        {formatDate(completion.completedAt, timeZone)}
      </span>
      <form action={action}>
        <input
          type="hidden"
          name="enrolmentId"
          value={completion.enrolmentId}
        />
        <button className="button secondary" disabled={pending}>
          {pending ? "Issuing…" : "Issue certificate"}
        </button>
      </form>
      {state.error && (
        <p className="ln-feedback is-error" role="alert">
          {state.error}
        </p>
      )}
    </li>
  );
}

export function LearnerRecords({
  certificates,
  eligible,
  receipts,
  timeZone = "UTC",
  issueCertificateAction,
}: {
  certificates: CertificateSummary[] | null; // null when unreadable
  eligible: EligibleCompletion[];
  receipts: ReceiptSummary[] | null;
  timeZone?: string;
  issueCertificateAction: IssueAction;
}) {
  return (
    <>
      <section className="ln-panel" aria-labelledby="ln-certificates-heading">
        <h2 id="ln-certificates-heading">Certificates</h2>
        <p className="ln-muted">
          A certificate confirms completion of a Ducelio preparation course. It
          is not an official certification from the examination body.
        </p>
        {certificates === null ? (
          <p role="status">Your certificates could not be loaded.</p>
        ) : certificates.length === 0 && eligible.length === 0 ? (
          <p className="ln-empty-line">
            Certificates become available when a course completion is recorded.
          </p>
        ) : (
          <ul className="ln-record-list">
            {certificates.map((c) => (
              <li key={c.certificateId}>
                <span>
                  <strong>{c.courseTitle}</strong> · issued by {c.issuerName} ·{" "}
                  {formatDate(c.issuedAt, timeZone)}
                  <br />
                  <span className="ln-muted">
                    Verification code {c.verificationCode}
                    {c.revoked ? " · revoked" : ""}
                  </span>
                </span>
                <span className="ln-quick-actions">
                  {!c.revoked && (
                    <a
                      className="button secondary"
                      href={`/api/learner/certificates/${c.certificateId}`}
                    >
                      Download PDF
                    </a>
                  )}
                  <Link
                    className="ln-textlink"
                    href={`/verify?code=${encodeURIComponent(c.verificationCode)}`}
                  >
                    Verify
                  </Link>
                </span>
              </li>
            ))}
            {eligible.map((e) => (
              <IssueCertificate
                key={e.enrolmentId}
                completion={e}
                issueAction={issueCertificateAction}
                timeZone={timeZone}
              />
            ))}
          </ul>
        )}
      </section>
      <section className="ln-panel" aria-labelledby="ln-receipts-heading">
        <h2 id="ln-receipts-heading">Payment receipts</h2>
        {receipts === null ? (
          <p role="status">Your receipts could not be loaded.</p>
        ) : receipts.length === 0 ? (
          <p className="ln-empty-line">No paid orders yet.</p>
        ) : (
          <ul className="ln-record-list">
            {receipts.map((r) => (
              <li key={r.receiptId}>
                <span>
                  <strong>{r.receiptNumber}</strong> · {r.courseTitle} ·{" "}
                  {r.amount} · {formatDate(r.issuedAt, timeZone)}
                  {r.refunded ? " · refunded" : ""}
                </span>
                <a
                  className="button secondary"
                  href={`/api/learner/receipts/${r.receiptId}`}
                >
                  Download PDF
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
