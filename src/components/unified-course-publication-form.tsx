"use client";
import { useActionState } from "react";
import Link from "next/link";
import { publishUnifiedAction } from "@/app/admin/course-engineering/unified-actions";
import type { AgentConfiguration } from "@/domain/course-package";
import type { AcademyAdminState } from "@/app/admin/academy-course-engineering/actions";

export function UnifiedCoursePublicationForm({
  packageId,
  agents,
}: {
  packageId: string;
  agents: AgentConfiguration;
}) {
  const [state, action, pending] = useActionState<AcademyAdminState, FormData>(
    publishUnifiedAction,
    {},
  );
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="packageId" value={packageId} />
      <fieldset disabled={pending}>
        <legend>Set one course price</legend>
        <label htmlFor="unified-slug">
          Public course address
          <input
            id="unified-slug"
            name="slug"
            required
            minLength={3}
            maxLength={80}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
        </label>
        <label htmlFor="unified-price">
          Selling price
          <input
            id="unified-price"
            name="price"
            required
            inputMode="decimal"
            pattern="[0-9]{1,7}(\.[0-9]{1,2})?"
            placeholder="99.00"
          />
        </label>
        <label htmlFor="unified-currency">
          Currency
          <select id="unified-currency" name="currency" defaultValue="GBP">
            <option>GBP</option>
            <option>USD</option>
            <option>EUR</option>
          </select>
        </label>
        <p>
          The price stays the same for every feasible duration. Timetable
          selection happens after purchase.
        </p>
        <label htmlFor="unified-summary">
          Catalogue summary
          <textarea id="unified-summary" name="summary" maxLength={500} />
        </label>
      </fieldset>
      <fieldset disabled={pending}>
        <legend>Configure agents</legend>
        <p>
          Profiles and capabilities use the reviewed runtime catalogue. Package
          changes create a new immutable revision. Support agents retain their
          separate permission boundaries.
        </p>
        {(Object.keys(agents) as (keyof AgentConfiguration)[]).map((role) => (
          <fieldset key={role}>
            <legend>{role.replaceAll("_", " ")}</legend>
            <label className="acad-check">
              <input
                name={`${role}_enabled`}
                type="checkbox"
                defaultChecked={agents[role].enabled}
              />
              Enabled within reviewed scope
            </label>
            <label htmlFor={`${role}-profile`}>
              Runtime profile
              <input
                id={`${role}-profile`}
                name={`${role}_profile`}
                defaultValue={agents[role].modelProfileRef ?? ""}
                maxLength={100}
              />
            </label>
            <label htmlFor={`${role}-notes`}>
              Recorded instructional notes
              <textarea
                id={`${role}-notes`}
                name={`${role}_notes`}
                defaultValue={agents[role].instructionalNotes ?? ""}
                maxLength={4000}
              />
            </label>
            <p className="ac-muted">
              Notes are recorded with the course; current runtimes use their
              reviewed behaviour instructions.
            </p>
            {agents[role].capabilities.map((c) => (
              <label key={c} className="acad-check">
                <input
                  type="checkbox"
                  name={`${role}_capability_${c}`}
                  defaultChecked
                />
                {c}
              </label>
            ))}
            {role === "COUNSELLOR" && (
              <p className="ac-muted">
                This academic proposal does not launch Sarah. Sarah uses her
                separate platform support authority.
              </p>
            )}
          </fieldset>
        ))}
      </fieldset>
      <label className="acad-check">
        <input type="checkbox" name="confirm" required />I approve the academic
        policy, agent configuration and selling price for publication.
      </label>
      <label htmlFor="unified-reason">
        Reason for the record
        <input
          id="unified-reason"
          name="reason"
          required
          minLength={5}
          maxLength={300}
        />
      </label>
      <button className="ac-button" disabled={pending}>
        {pending ? "Checking and publishing…" : "Publish course"}
      </button>
      <p>
        Curriculum, assessment, agent and scheduling checks run automatically.
        Any failed check keeps the course out of the catalogue.
      </p>
      {(state.error || state.message) && (
        <div role={state.error ? "alert" : "status"}>
          <p>{state.error ?? state.message}</p>
          {state.issues && (
            <ul>
              {state.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          {state.packageId && (
            <Link
              href={`/admin/course-engineering?packageId=${state.packageId}`}
            >
              Open published course
            </Link>
          )}
        </div>
      )}
    </form>
  );
}
