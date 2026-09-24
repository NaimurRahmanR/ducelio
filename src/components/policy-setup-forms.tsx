"use client";
import { useActionState } from "react";
import {
  bindComponentAction,
  publishGradingPolicyAction,
  setLabPolicyAction,
  publishResultPolicyAction,
  type PolicyActionState,
} from "@/app/admin/activation/policy-actions";
import type {
  CommercialV1Component,
  PolicySetupOptions,
} from "@/domain/commercial-v1-assessment-policy";

const COMPONENTS: CommercialV1Component[] = [
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
];

function Status({ state }: { state: PolicyActionState }) {
  return <p role="status">{state.error ?? state.message ?? ""}</p>;
}

// Component identity is always an explicit admin-chosen <select> value from
// the fixed six-component vocabulary -- never inferred from an assessment's
// title. The assessment itself is chosen from this activation's own real,
// materialised assessments (options), never a typed UUID.
export function BindComponentForm({
  activationId,
  options,
}: {
  activationId: string;
  options: PolicySetupOptions["assessments"];
}) {
  const [state, formAction, pending] = useActionState(bindComponentAction, {});
  return (
    <form action={formAction}>
      <input type="hidden" name="activationId" value={activationId} />
      <label>
        Component
        <select name="component" required disabled={pending}>
          {COMPONENTS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        Assessment
        <select name="assessmentId" required disabled={pending}>
          <option value="">Select an assessment</option>
          {options.map((a) => (
            <option key={a.assessmentId} value={a.assessmentId}>
              {a.title}
              {a.boundComponent ? ` (currently ${a.boundComponent})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <input
          name="reason"
          minLength={5}
          maxLength={300}
          required
          disabled={pending}
        />
      </label>
      <button className="button secondary" disabled={pending}>
        {pending ? "Binding…" : "Bind component"}
      </button>
      <Status state={state} />
    </form>
  );
}

// No weight/profile/lab-presence field exists here -- the published policy
// is always server-derived from the activation's own bindings/content.
export function PublishGradingPolicyForm({
  activationId,
}: {
  activationId: string;
}) {
  const [state, formAction, pending] = useActionState(
    publishGradingPolicyAction,
    {},
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="activationId" value={activationId} />
      <label>
        Reason
        <input
          name="reason"
          minLength={5}
          maxLength={300}
          required
          disabled={pending}
        />
      </label>
      <button className="button secondary" disabled={pending}>
        {pending ? "Publishing…" : "Publish grading policy"}
      </button>
      <Status state={state} />
    </form>
  );
}

export function SetLabPolicyForm({
  activationId,
  options,
}: {
  activationId: string;
  options: PolicySetupOptions["practicals"];
}) {
  const [state, formAction, pending] = useActionState(setLabPolicyAction, {});
  return (
    <form action={formAction}>
      <input type="hidden" name="activationId" value={activationId} />
      <label>
        Practical
        <select name="practicalId" required disabled={pending}>
          <option value="">Select a practical</option>
          {options.map((p) => (
            <option key={p.practicalId} value={p.practicalId}>
              {p.title}
              {p.hasLabPolicy ? " (policy set)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Max marks
        <input
          name="maxMarks"
          type="number"
          min={1}
          max={100}
          required
          disabled={pending}
        />
      </label>
      <label>
        Contribution (basis points, max 2000)
        <input
          name="contributionBp"
          type="number"
          min={0}
          max={2000}
          required
          disabled={pending}
        />
      </label>
      <label>
        Grading guidance
        <textarea
          name="gradingGuidance"
          maxLength={4000}
          rows={3}
          disabled={pending}
        />
      </label>
      <label>
        Reason
        <input
          name="reason"
          minLength={5}
          maxLength={300}
          required
          disabled={pending}
        />
      </label>
      <button className="button secondary" disabled={pending}>
        {pending ? "Saving…" : "Save lab policy"}
      </button>
      <Status state={state} />
    </form>
  );
}

// passMarkBp is explicit, bounded, institution-supplied input -- there is no
// hardcoded default pass mark anywhere in Ducelio.
export function PublishResultPolicyForm({
  activationId,
}: {
  activationId: string;
}) {
  const [state, formAction, pending] = useActionState(
    publishResultPolicyAction,
    {},
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="activationId" value={activationId} />
      <label>
        Pass mark (basis points, e.g. 5000 = 50%)
        <input
          name="passMarkBp"
          type="number"
          min={0}
          max={10000}
          required
          disabled={pending}
        />
      </label>
      <label>
        <input
          type="checkbox"
          name="requireRemediationClear"
          disabled={pending}
        />
        Require remediation clearance for completion
      </label>
      <label>
        Reason
        <input
          name="reason"
          minLength={5}
          maxLength={300}
          required
          disabled={pending}
        />
      </label>
      <button className="button secondary" disabled={pending}>
        {pending ? "Publishing…" : "Publish result policy"}
      </button>
      <Status state={state} />
    </form>
  );
}
