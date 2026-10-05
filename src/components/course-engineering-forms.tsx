"use client";
import Link from "next/link";
import { useActionState } from "react";
import {
  importPackageAction,
  packageLifecycleAction,
  saveCourseAgentAction,
  saveAgentBehaviourAction,
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
import {
  COURSE_CONTEXT_NOTES_MAX,
  type AgentBehaviourConfig,
  type BehaviourRole,
} from "@/domain/agent-behaviour";

// The database-resolved effective behaviour of one role (migration 051):
// DRAFT is the live resolution; BOUND is the binding frozen at publication.
export type CourseEffectiveBehaviour =
  | {
      state: "DRAFT" | "BOUND";
      behaviourVersion: string;
      source: "EXPLICIT" | "DEFAULT";
      configVersion: string;
      config: AgentBehaviourConfig;
    }
  | { state: "BEHAVIOUR_BINDING_MISSING" | "BEHAVIOUR_BINDING_INVALID" };

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

// AC-2 LEVEL-3 options. Labels only: each value maps to a fixed, reviewed
// instruction sentence in code, never to free text sent to a provider.
const BEHAVIOUR_FIELDS = [
  {
    name: "responseDepth",
    label: "Response depth",
    options: [
      ["CONCISE", "Concise"],
      ["STANDARD", "Standard"],
      ["DETAILED", "Detailed"],
    ],
  },
  {
    name: "teachingApproach",
    label: "Teaching approach",
    options: [
      ["CONCEPT_FIRST", "Concept first"],
      ["WORKED_EXAMPLE_FIRST", "Worked example first"],
      ["GUIDED_QUESTIONING", "Guided questioning"],
    ],
  },
  {
    name: "understandingCheckFrequency",
    label: "Understanding check frequency",
    options: [
      ["LOW", "Low"],
      ["STANDARD", "Standard"],
      ["HIGH", "High"],
    ],
  },
  {
    name: "challengeLevel",
    label: "Challenge level",
    options: [
      ["FOUNDATION", "Foundation"],
      ["STANDARD", "Standard"],
      ["ADVANCED", "Advanced"],
    ],
  },
] as const;

export function CourseBehaviourForm({
  importId,
  role,
  behaviour,
  frozen,
}: {
  importId: string;
  role: BehaviourRole;
  // The effective behaviour resolved by the database for this role.
  behaviour: CourseEffectiveBehaviour;
  // Published or enrolled: the database refuses every change (migration
  // 051), so no editable control is rendered.
  frozen: boolean;
}) {
  const [state, action, pending] = useActionState(saveAgentBehaviourAction, {});
  if (!("config" in behaviour))
    return (
      <section aria-label={`${role} behaviour`}>
        <h3>Behaviour</h3>
        <p role="alert">
          {behaviour.state === "BEHAVIOUR_BINDING_MISSING"
            ? "This version's frozen behaviour binding is missing"
            : "This version's frozen behaviour binding does not verify"}
          , so every {role} execution for it is refused. It cannot be repaired
          here.
        </p>
      </section>
    );
  const effective = behaviour.config;
  const source =
    behaviour.source === "EXPLICIT"
      ? `Programme configuration (${behaviour.configVersion})`
      : `Versioned default (${behaviour.configVersion}): no programme configuration recorded`;
  const frozenNote =
    behaviour.state === "BOUND"
      ? "These values and the role behaviour version were frozen when this version was published; later code defaults do not change them."
      : "Publishing this version freezes these values and the current role behaviour version.";
  const notesHelp = (
    <p id={`behaviour-notes-help-${role}`}>
      Course context notes reach the agent only as subordinate data inside its
      input, never as instructions, and the learner can read them. Do not
      include private, assessment or answer-key material.
    </p>
  );
  if (frozen)
    return (
      <section aria-label={`${role} behaviour`}>
        <h3>Behaviour ({behaviour.behaviourVersion})</h3>
        <p className="notice">
          This programme version is published or has enrolments, so its
          behaviour configuration is fixed. Use a new programme version to
          change it.
        </p>
        <p>{source}</p>
        <p>{frozenNote}</p>
        <dl>
          {BEHAVIOUR_FIELDS.map((field) => (
            <div key={field.name}>
              <dt>{field.label}</dt>
              <dd>
                {
                  field.options.find(
                    ([value]) => value === effective[field.name],
                  )?.[1]
                }
              </dd>
            </div>
          ))}
          <div>
            <dt>Course context notes</dt>
            <dd>{effective.courseContextNotes ?? "None"}</dd>
          </div>
        </dl>
      </section>
    );
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="importId" value={importId} />
      <input type="hidden" name="role" value={role} />
      <fieldset disabled={pending}>
        <legend>
          {role} behaviour ({behaviour.behaviourVersion}) — {source}
        </legend>
        <p>{frozenNote}</p>
        <p>
          The institutional baseline and the {role} role baseline are owned by
          code and always take precedence. These options only adjust teaching
          style within them. They cannot change the model, provider, budget or
          any permission.
        </p>
        {BEHAVIOUR_FIELDS.map((field) => (
          <label key={field.name}>
            {field.label}
            <select name={field.name} defaultValue={effective[field.name]}>
              {field.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Course context notes (optional, up to {COURSE_CONTEXT_NOTES_MAX}{" "}
          characters)
          <textarea
            name="courseContextNotes"
            maxLength={COURSE_CONTEXT_NOTES_MAX}
            aria-describedby={`behaviour-notes-help-${role}`}
            defaultValue={effective.courseContextNotes ?? ""}
          />
        </label>
        {notesHelp}
        <Reason />
        <button className="button">
          {pending ? "Saving…" : `Save ${role} behaviour`}
        </button>
      </fieldset>
      <Result state={state} />
    </form>
  );
}
