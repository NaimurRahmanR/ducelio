"use client";
import { useActionState } from "react";
import {
  addPlanItem,
  addFollowup,
  addInteraction,
  type SupportActionState,
} from "@/app/support/actions";
export function SupportForms({
  kind,
  studentId,
  planId,
}: {
  kind: "plan" | "followup" | "interaction";
  studentId: string;
  planId?: string;
}) {
  const action =
    kind === "plan"
      ? addPlanItem
      : kind === "followup"
        ? addFollowup
        : addInteraction;
  const [state, formAction, pending] = useActionState<
    SupportActionState,
    FormData
  >(action, {});
  const title =
    kind === "plan"
      ? "Add a study step"
      : kind === "followup"
        ? "Create a follow-up"
        : "Record a private interaction";
  return (
    <form action={formAction} className="support-form">
      <h3>{title}</h3>
      <input type="hidden" name="studentId" value={studentId} />
      {planId && <input type="hidden" name="planId" value={planId} />}
      {state.error && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="notice" role="status">
          {state.message}
        </p>
      )}
      {kind === "interaction" ? (
        <div className="field">
          <label htmlFor="summary">Brief interaction summary</label>
          <textarea
            id="summary"
            name="summary"
            maxLength={2000}
            rows={4}
            required
          />
          <small className="muted">
            Private to assigned support staff. Avoid unnecessary sensitive
            details.
          </small>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor={kind + "-title"}>Title</label>
            <input id={kind + "-title"} name="title" maxLength={200} required />
          </div>
          <div className="field">
            <label htmlFor={kind + "-due"}>Planned date</label>
            <input id={kind + "-due"} name="dueOn" type="date" required />
          </div>
        </>
      )}
      <button className="button" disabled={pending}>
        {pending ? "Saving…" : title}
      </button>
    </form>
  );
}
