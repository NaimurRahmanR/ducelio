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
      <summary>Correct course content and record a new revision</summary>
      <p>
        Update the package policy, rubrics or content below. Keep
        &quot;pendingDecisions&quot; unchanged: academic decisions are resolved
        only in{" "}
        <Link
          className="ac-link"
          href={`/admin/course-engineering/review?packageId=${sourceId}`}
        >
          Course academic review
        </Link>
        , with recorded evidence.{" "}
        {pending.length > 0 &&
          `${pending.length} decision${pending.length === 1 ? " remains" : "s remain"} pending; publication stays blocked until they are resolved. `}
        Existing published and enrolled history is preserved.
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
