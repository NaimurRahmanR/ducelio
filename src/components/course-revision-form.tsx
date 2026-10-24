"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { reviseCourseAction } from "@/app/admin/course-engineering/revision-actions";
export function CourseRevisionForm({
  sourceId,
  raw,
  pending,
}: {
  sourceId: string;
  raw: string;
  pending: { key: string; summary: string }[];
}) {
  const [state, action, busy] = useActionState(reviseCourseAction, {});
  const [key] = useState(() => crypto.randomUUID());
  return (
    <details>
      <summary>Correct academic findings and record a new revision</summary>
      <p>
        Update the package policy, rubrics or content below. Resolve a decision
        only after the required human review has happened. Retain unresolved
        decisions; publication remains blocked while any remain. Existing
        published and enrolled history is preserved.
      </p>
      <form action={action} className="acad-form">
        <fieldset disabled={busy}>
          <legend>Reviewed course revision</legend>
          <input type="hidden" name="sourceId" value={sourceId} />
          <input type="hidden" name="requestKey" value={key} />
          <label>
            Revised course JSON
            <textarea
              name="rawPackage"
              defaultValue={raw}
              rows={16}
              required
              spellCheck={false}
            />
          </label>
          {pending.map((d) => (
            <fieldset key={d.key}>
              <legend>{d.key}</legend>
              <p>{d.summary}</p>
              <label>
                <input type="checkbox" name={`resolve_${d.key}`} />
                This decision has human approval
              </label>
              <label>
                Evidence reference
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
          {pending.length > 0 && (
            <label>
              <input type="checkbox" name="attest" />I am authorised to record
              these actual human approvals and the references identify their
              supporting evidence.
            </label>
          )}
          <label>
            Reason for this revision
            <input name="reason" required minLength={5} maxLength={300} />
          </label>
          <button className="ac-button">Validate and record revision</button>
        </fieldset>
        {(state.error || state.message) && (
          <p role={state.error ? "alert" : "status"}>
            {state.error ?? state.message}
          </p>
        )}
        {state.issues && (
          <ul>
            {state.issues.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
        {state.packageId && (
          <Link
            className="ac-link"
            href={`/admin/course-engineering?packageId=${state.packageId}`}
          >
            Open revised course
          </Link>
        )}
      </form>
    </details>
  );
}
