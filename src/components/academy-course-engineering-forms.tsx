"use client";
import Link from "next/link";
import { useActionState } from "react";
import {
  archiveAction,
  grantAction,
  markLabAction,
  prepareCurriculumAction,
  publishAction,
  rejectAction,
  uploadAndValidateAction,
  type AcademyAdminState,
} from "@/app/admin/academy-course-engineering/actions";
import {
  ACADEMY_FORMATS,
  type AcademyFormatId,
} from "@/domain/academy-scheduler";

function Outcome({ state }: { state: AcademyAdminState }) {
  if (!state.error && !state.message) return null;
  return (
    <div
      className={state.error ? "acad-outcome error" : "acad-outcome"}
      role={state.error ? "alert" : "status"}
    >
      <p>{state.error ?? state.message}</p>
      {state.issues && (
        <ul className="acad-issues">
          {state.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {state.packageId && !state.error && (
        <Link
          className="ac-link"
          href={`/admin/academy-course-engineering?packageId=${state.packageId}`}
        >
          Open the review →
        </Link>
      )}
    </div>
  );
}
function Reason({ id, placeholder }: { id: string; placeholder: string }) {
  return (
    <label htmlFor={id}>
      Reason for the record
      <input
        id={id}
        name="reason"
        minLength={5}
        maxLength={300}
        required
        placeholder={placeholder}
      />
    </label>
  );
}

export function AcademyUploadForm() {
  const [state, action, pending] = useActionState(uploadAndValidateAction, {});
  return (
    <form action={action} className="acad-form">
      <label htmlFor="academy-package">
        Course package (.json, ACADEMY_COURSE_PACKAGE_V1)
        <input
          id="academy-package"
          name="package"
          type="file"
          accept=".json,application/json"
          required
        />
      </label>
      <Reason
        id="upload-reason"
        placeholder="e.g. Upload Security+ Academy revision 1"
      />
      <button className="ac-button" disabled={pending}>
        {pending ? "Uploading and validating…" : "Upload and validate"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function PrepareCurriculumForm({
  packageId,
  disabled,
}: {
  packageId: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(prepareCurriculumAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="packageId" value={packageId} />
      <Reason
        id="prepare-reason"
        placeholder="e.g. Approve the reviewed curriculum"
      />
      <button className="ac-button" disabled={pending || disabled}>
        {pending
          ? "Running the curriculum pipeline…"
          : "Approve curriculum and run pre-publication test"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function PublishForm({
  packageId,
  formats,
  ready,
}: {
  packageId: string;
  formats: { formatId: AcademyFormatId; summary: string }[];
  ready: boolean;
}) {
  const [state, action, pending] = useActionState(publishAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="packageId" value={packageId} />
      <div className="acad-grid-2">
        <label htmlFor="slug">
          Public course address
          <input
            id="slug"
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            minLength={3}
            maxLength={80}
            placeholder="e.g. security-plus"
          />
        </label>
        <label htmlFor="currency">
          Currency
          <input
            id="currency"
            name="currency"
            required
            pattern="[A-Za-z]{3}"
            maxLength={3}
            defaultValue="GBP"
          />
        </label>
      </div>
      <label htmlFor="summary">
        Catalogue summary (optional)
        <textarea id="summary" name="summary" maxLength={500} rows={2} />
      </label>
      <fieldset className="acad-prices">
        <legend>Learning formats and approved prices</legend>
        {formats.map((f) => (
          <div key={f.formatId} className="acad-price-row">
            <label className="acad-check">
              <input
                type="checkbox"
                name={`offer_${f.formatId}`}
                defaultChecked
              />
              <span>
                <strong>
                  {ACADEMY_FORMATS[f.formatId].label} ·{" "}
                  {ACADEMY_FORMATS[f.formatId].weeks} weeks
                </strong>
                <small>{f.summary}</small>
              </span>
            </label>
            <label htmlFor={`price-${f.formatId}`} className="acad-price">
              Price
              <input
                id={`price-${f.formatId}`}
                name={`price_${f.formatId}`}
                inputMode="decimal"
                pattern="\d{1,7}(\.\d{2})?"
                placeholder="0.00"
              />
            </label>
          </div>
        ))}
      </fieldset>
      <label className="acad-check">
        <input type="checkbox" name="confirm" required />
        <span>
          These prices are approved commercial terms for the selected formats.
        </span>
      </label>
      <Reason
        id="publish-reason"
        placeholder="e.g. Publish approved Academy course"
      />
      <button className="ac-button" disabled={pending || !ready}>
        {pending ? "Publishing…" : "Publish to the Academy catalogue"}
      </button>
      {!ready && (
        <p className="ac-muted">
          Publishing becomes available once the curriculum has passed its
          pre-publication test.
        </p>
      )}
      <Outcome state={state} />
    </form>
  );
}

export function RejectForm({ packageId }: { packageId: string }) {
  const [state, action, pending] = useActionState(rejectAction, {});
  return (
    <form action={action} className="acad-form inline">
      <input type="hidden" name="packageId" value={packageId} />
      <Reason
        id="reject-reason"
        placeholder="Why this revision will not be published"
      />
      <button className="ac-button secondary" disabled={pending}>
        Reject this revision
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function GrantForm({
  offerId,
  formats,
}: {
  offerId: string;
  formats: AcademyFormatId[];
}) {
  const [state, action, pending] = useActionState(grantAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="offerId" value={offerId} />
      <div className="acad-grid-2">
        <label htmlFor="grant-email">
          Learner email
          <input
            id="grant-email"
            name="email"
            type="email"
            required
            maxLength={320}
          />
        </label>
        <label htmlFor="grant-format">
          Learning format
          <select
            id="grant-format"
            name="formatId"
            defaultValue="LEARNER_CHOICE"
          >
            <option value="LEARNER_CHOICE">Learner chooses</option>
            {formats.map((f) => (
              <option key={f} value={f}>
                {ACADEMY_FORMATS[f].label} · {ACADEMY_FORMATS[f].weeks} weeks
              </option>
            ))}
          </select>
        </label>
      </div>
      <Reason
        id="grant-reason"
        placeholder="e.g. Reviewer access approved by …"
      />
      <button className="ac-button secondary" disabled={pending}>
        Grant complimentary access
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function ArchiveForm({ offerId }: { offerId: string }) {
  const [state, action, pending] = useActionState(archiveAction, {});
  return (
    <form action={action} className="acad-form inline">
      <input type="hidden" name="offerId" value={offerId} />
      <Reason id="archive-reason" placeholder="Why the offer is withdrawn" />
      <button className="ac-button secondary" disabled={pending}>
        Archive offer
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function MarkLabForm({
  submissionId,
  rubric,
}: {
  submissionId: string;
  rubric: { key: string; description: string; maxMarks: number }[];
}) {
  const [state, action, pending] = useActionState(markLabAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="submissionId" value={submissionId} />
      {rubric.map((r) => (
        <label key={r.key} htmlFor={`${submissionId}-${r.key}`}>
          {r.description} (0–{r.maxMarks})
          <input
            id={`${submissionId}-${r.key}`}
            name={`mark_${r.key}`}
            type="number"
            min={0}
            max={r.maxMarks}
            required
          />
        </label>
      ))}
      <Reason
        id={`${submissionId}-reason`}
        placeholder="Evaluation note for the record"
      />
      <button className="ac-button secondary" disabled={pending}>
        Record marks
      </button>
      <Outcome state={state} />
    </form>
  );
}
