"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { resolveDecisionsAction } from "@/app/admin/course-engineering/review/actions";

// Every control starts empty and unchecked. A decision is recorded only when
// the reviewer selects it and supplies its own evidence and rationale.
export function CourseDecisionReviewForm({
  sourceId,
  pending,
}: {
  sourceId: string;
  pending: { key: string; summary: string }[];
}) {
  const [state, action, busy] = useActionState(resolveDecisionsAction, {});
  const [requestKey] = useState(() => crypto.randomUUID());
  return (
    <form action={action} className="acad-form">
      <fieldset disabled={busy}>
        <legend>Record reviewed decisions</legend>
        <input type="hidden" name="sourceId" value={sourceId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        {pending.map((d) => (
          <fieldset key={d.key}>
            <legend>{d.key}</legend>
            <label>
              <input type="checkbox" name="decision" value={d.key} />
              This decision was reviewed and approved by an authorised person
            </label>
            <label>
              Evidence reference (where the review record is kept)
              <input
                name={`evidence_${d.key}`}
                minLength={10}
                maxLength={300}
              />
            </label>
            <label>
              Review rationale
              <textarea
                name={`rationale_${d.key}`}
                minLength={20}
                maxLength={1000}
                rows={3}
              />
            </label>
          </fieldset>
        ))}
        <label>
          <input type="checkbox" name="attest" />I am authorised to record these
          reviews, and each reference identifies the actual supporting evidence.
        </label>
        <label>
          Reason for the record
          <input name="reason" required minLength={5} maxLength={300} />
        </label>
        <button className="ac-button">Record reviewed decisions</button>
      </fieldset>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
      {state.packageId && (
        <Link
          className="ac-link"
          href={`/admin/course-engineering/review?packageId=${state.packageId}`}
        >
          Open {state.error ? "the latest" : "the new"} revision
        </Link>
      )}
    </form>
  );
}
