"use client";
import Link from "next/link";
import { useActionState } from "react";
import {
  importPackageAction,
  packageLifecycleAction,
  saveCourseAgentAction,
  runCourseTestAction,
} from "@/app/admin/course-engineering/actions";
import {
  packageActions,
  describeTestStatus,
  type CourseEngineeringState,
  type TestStatusResult,
} from "@/domain/course-engineering-admin";
import {
  roleCapabilityCatalogue,
  type AgentRole,
  type AgentConfigRecord,
} from "@/domain/academic-agent-config";
import { ROLE_RUNTIME_PROFILE_POLICY } from "@/domain/academic-runtime-profile";
import { ACADEMIC_ROLE_FACTS } from "@/domain/agent-control-plane";

function Result({ state }: { state: CourseEngineeringState }) {
  return (
    <>
      <p role={state.error ? "alert" : "status"}>
        {state.error ?? state.message}
      </p>
      {state.issues && (
        <ul>
          {state.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {state.importId && (
        <Link
          className="text-link"
          href={`/admin/course-engineering?importId=${encodeURIComponent(state.importId)}`}
        >
          Review imported package →
        </Link>
      )}
    </>
  );
}
function Reason() {
  return (
    <label>
      Administrative reason
      <textarea name="reason" minLength={5} maxLength={300} required />
    </label>
  );
}
export function CoursePackageImportForm() {
  const [state, action, pending] = useActionState(importPackageAction, {});
  return (
    <form action={action} className="form-grid">
      <fieldset disabled={pending}>
        <legend>Upload COURSE_PACKAGE_V1</legend>
        <label>
          JSON package (UTF-8, up to 512 KiB)
          <input
            name="package"
            type="file"
            accept=".json,application/json"
            required
          />
        </label>
        <Reason />
        <button className="button">
          {pending ? "Importing…" : "Import package"}
        </button>
      </fieldset>
      <Result state={state} />
    </form>
  );
}
export function CoursePackageLifecycleForm({
  importId,
  status,
  publicationReady,
}: {
  importId: string;
  status: string;
  publicationReady: boolean;
}) {
  const [state, action, pending] = useActionState(packageLifecycleAction, {});
  const actions = packageActions(status, publicationReady);
  if (!actions.length)
    return status === "APPLIED" && !publicationReady ? (
      <p role="status">
        Save all five role configurations exactly as reviewed in the package
        proposal, then run a pre-publication test that passes for the exact
        current state, before publishing.
      </p>
    ) : null;
  const labels = {
    validate: "Validate staged package",
    apply: "Apply curriculum",
    publish: "Publish programme version",
    reject: "Reject package",
  };
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="importId" value={importId} />
      <fieldset disabled={pending}>
        <legend>Package lifecycle</legend>
        <Reason />
        <div className="engineering-actions">
          {actions.map((operation) => (
            <button
              className={operation === "reject" ? "button secondary" : "button"}
              key={operation}
              name="operation"
              value={operation}
            >
              {pending ? "Working…" : labels[operation]}
            </button>
          ))}
        </div>
      </fieldset>
      <Result state={state} />
    </form>
  );
}
export function CourseTestForm({
  importId,
  testStatus,
}: {
  importId: string;
  testStatus: TestStatusResult;
}) {
  const [state, action, pending] = useActionState(runCourseTestAction, {});
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="importId" value={importId} />
      <fieldset disabled={pending}>
        <legend>Pre-publication test</legend>
        <p>
          Status: <strong>{testStatus.status}</strong> —{" "}
          {describeTestStatus(testStatus.status)}
        </p>
        <p>
          This is a deterministic governed integrity/readiness check: it
          independently re-validates the stored package, independently
          re-verifies that the applied programme/version identity and
          materialised course content still match that package exactly, and
          compares the five saved role configurations against the reviewed
          package proposal. It never calls an external model/provider, evaluates
          model output quality or substitutes for hosted/production acceptance.
        </p>
        <Reason />
        <button className="button">
          {pending ? "Testing…" : "Run pre-publication test"}
        </button>
      </fieldset>
      <Result state={state} />
    </form>
  );
}
// Runtime profile: shown, never edited. The server derives the stored
// reference from the package's own proposal (null or this exact role
// profile); provider, model, tariff and budget live only in server code.
function RuntimeProfileDisplay({
  role,
  config,
}: {
  role: AgentRole;
  config?: AgentConfigRecord;
}) {
  const policy = ROLE_RUNTIME_PROFILE_POLICY[role];
  return (
    <div className="field" aria-label="Runtime profile">
      <p>
        <strong>Runtime profile (read-only):</strong>{" "}
        {policy.providerBacked && policy.allowedRef ? (
          <code>{policy.allowedRef}</code>
        ) : (
          "None. This role is not provider-backed."
        )}
      </p>
      <p>
        Fixed by Ducelio server code for this role. Provider, model, budget and
        tariff cannot be chosen here. Stored reference:{" "}
        {config
          ? (config.modelProfileRef ?? "none (role default)")
          : "set from the package proposal when saved"}
        .
      </p>
    </div>
  );
}

export function CourseAgentForm({
  importId,
  role,
  config,
  frozen = false,
}: {
  importId: string;
  role: AgentRole;
  config?: AgentConfigRecord;
  // The programme version is published: academic-semantic fields are fixed
  // by the database (migration 050). This only explains that; the database
  // refuses the change regardless of what this form sends.
  frozen?: boolean;
}) {
  const [state, action, pending] = useActionState(saveCourseAgentAction, {});
  if (role === "COUNSELLOR")
    return (
      <form action={action} className="form-grid">
        <input type="hidden" name="importId" value={importId} />
        <input type="hidden" name="role" value={role} />
        <fieldset disabled={pending}>
          <legend>
            COUNSELLOR —{" "}
            {config ? "proposal recorded" : "proposal not yet recorded"} · NOT
            EXECUTABLE
          </legend>
          <p>
            There is no academic Counsellor execution path. This record exists
            only so the programme version matches its package. It does not
            launch Sarah or any Counsellor AI, and it cannot be edited here: it
            is saved exactly as the package proposes.
          </p>
          <RuntimeProfileDisplay role={role} config={config} />
          <Reason />
          <button className="button">
            {pending
              ? "Recording…"
              : "Record COUNSELLOR package proposal (not executable)"}
          </button>
        </fieldset>
        <Result state={state} />
      </form>
    );
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="importId" value={importId} />
      <input type="hidden" name="role" value={role} />
      <fieldset disabled={pending}>
        <legend>
          {role} —{" "}
          {config
            ? "saved configuration"
            : "not configured (disabled by default)"}
        </legend>
        {frozen && (
          <p className="notice">
            This programme version is published. Instructional notes, the
            profile reference and escalation policy are fixed, and capabilities
            can only be removed. You can still change availability.
          </p>
        )}
        <label>
          Availability
          <select
            name="enabled"
            defaultValue={String(config?.enabled ?? false)}
          >
            <option value="false">Disabled</option>
            <option value="true">Enabled within reviewed runtime scope</option>
          </select>
        </label>
        <RuntimeProfileDisplay role={role} config={config} />
        <label>
          Instructional notes — stored but not used by the current runtime
          <textarea
            name="instructionalNotes"
            maxLength={4000}
            readOnly={frozen}
            aria-describedby={`notes-help-${role}`}
            defaultValue={config?.instructionalNotes ?? ""}
          />
        </label>
        <p id={`notes-help-${role}`}>
          These notes are stored with the programme version but are{" "}
          <strong>not used by the current runtime</strong>. Changing them does
          not change agent behaviour. They must match the package proposal for
          activation.
        </p>
        <fieldset>
          <legend>Reviewed capabilities</legend>
          {roleCapabilityCatalogue[role].map((capability) => (
            <label className="engineering-checkbox" key={capability}>
              <input
                type="checkbox"
                name="capabilities"
                value={capability}
                defaultChecked={
                  config?.capabilities.includes(capability) ?? false
                }
              />
              {capability}
            </label>
          ))}
        </fieldset>
        <label>
          Escalation policy
          <select
            name="escalationPolicy"
            defaultValue={config?.escalationPolicy ?? "NONE"}
            aria-describedby={`escalation-help-${role}`}
          >
            <option value="NONE">None</option>
            <option value="ACADEMIC_REVIEW">Academic review</option>
          </select>
        </label>
        <p id={`escalation-help-${role}`}>
          {ACADEMIC_ROLE_FACTS[role].escalation}
        </p>
        <Reason />
        <button className="button">
          {pending ? "Saving…" : `Save ${role} configuration`}
        </button>
      </fieldset>
      <Result state={state} />
    </form>
  );
}
