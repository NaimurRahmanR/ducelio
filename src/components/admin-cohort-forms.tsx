"use client";
import { useActionState } from "react";
import {
  changeCohortStatusAction,
  createCohortAction,
  updateCohortAction,
  type CohortActionState,
} from "@/app/admin/cohorts/actions";
import type {
  CohortStatus,
  CohortSummary,
  CohortWorkspace,
} from "@/domain/admin-control-plane";

function Outcome({ state }: { state: CohortActionState }) {
  return (
    <>
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
    </>
  );
}

function ReasonField({ id, placeholder }: { id: string; placeholder: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Reason (recorded in the audit trail)</label>
      <input
        id={id}
        name="reason"
        minLength={5}
        maxLength={300}
        placeholder={placeholder}
        required
      />
    </div>
  );
}

function ScheduleFields({
  id,
  cohort,
  startLocked = false,
}: {
  id: string;
  cohort?: CohortSummary;
  startLocked?: boolean;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-title`}>Cohort title</label>
        <input
          id={`${id}-title`}
          name="title"
          minLength={1}
          maxLength={200}
          defaultValue={cohort?.title}
          placeholder="January 2027 cohort"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-starts`}>Start date</label>
        <input
          id={`${id}-starts`}
          name="startsOn"
          type="date"
          defaultValue={cohort?.startsOn}
          readOnly={startLocked}
          aria-describedby={startLocked ? `${id}-starts-note` : undefined}
          required
        />
        {startLocked && (
          <small id={`${id}-starts-note`} className="muted">
            Locked: learners are enrolled or the course is activated, and the
            start date drives delivery scheduling.
          </small>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-ends`}>End date (optional)</label>
        <input
          id={`${id}-ends`}
          name="endsOn"
          type="date"
          defaultValue={cohort?.endsOn ?? ""}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-capacity`}>Seat capacity (optional)</label>
        <input
          id={`${id}-capacity`}
          name="capacity"
          type="number"
          min={1}
          max={10000}
          step={1}
          defaultValue={cohort?.capacity ?? ""}
          placeholder="No limit"
        />
      </div>
    </>
  );
}

export function CreateCohortForm({
  versions,
}: {
  versions: CohortWorkspace["versions"];
}) {
  const [state, action, pending] = useActionState<CohortActionState, FormData>(
    createCohortAction,
    {},
  );
  if (!versions.length)
    return (
      <p className="muted">
        No published institutional programme version exists yet. Publish a
        course through Course Engineering first.
      </p>
    );
  return (
    <form action={action} className="support-form">
      <Outcome state={state} />
      <div className="field">
        <label htmlFor="cohort-version">Programme version</label>
        <select id="cohort-version" name="programmeVersionId" required>
          <option value="">Select a published version</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.programmeTitle} · {version.label}
            </option>
          ))}
        </select>
      </div>
      <ScheduleFields id="cohort-new" />
      <ReasonField
        id="cohort-new-reason"
        placeholder="Launch the next intake"
      />
      <button className="button" disabled={pending}>
        {pending ? "Creating…" : "Create cohort"}
      </button>
    </form>
  );
}

export function EditCohortForm({ cohort }: { cohort: CohortSummary }) {
  const [state, action, pending] = useActionState<CohortActionState, FormData>(
    updateCohortAction,
    {},
  );
  const enrolled =
    cohort.enrolments.active +
    cohort.enrolments.paused +
    cohort.enrolments.completed +
    cohort.enrolments.withdrawn;
  return (
    <form action={action} className="support-form">
      <h3>Edit cohort details</h3>
      <Outcome state={state} />
      <input type="hidden" name="cohortId" value={cohort.id} />
      <ScheduleFields
        id={`cohort-${cohort.id}`}
        cohort={cohort}
        startLocked={enrolled > 0 || cohort.activationId !== null}
      />
      <ReasonField
        id={`cohort-${cohort.id}-reason`}
        placeholder="Corrected the cohort title"
      />
      <button className="button secondary" disabled={pending}>
        {pending ? "Saving…" : "Save details"}
      </button>
    </form>
  );
}

const transitions: Record<
  CohortStatus,
  { status: CohortStatus; label: string }[]
> = {
  OPEN: [{ status: "CLOSED", label: "Close to new enrolment" }],
  CLOSED: [
    { status: "OPEN", label: "Reopen for enrolment" },
    { status: "COMPLETED", label: "Mark completed" },
  ],
  COMPLETED: [],
};

export function CohortStatusForm({ cohort }: { cohort: CohortSummary }) {
  const [state, action, pending] = useActionState<CohortActionState, FormData>(
    changeCohortStatusAction,
    {},
  );
  const next = transitions[cohort.status];
  return (
    <form action={action} className="support-form">
      <h3>Lifecycle</h3>
      <p className="muted">
        Closing stops new enrolments, checkouts, offer publication and campaign
        access, and archives the cohort&apos;s published offer. Existing
        enrolments, orders and entitlements are kept. Completion freezes the
        cohort and never changes learner records.
      </p>
      <Outcome state={state} />
      <input type="hidden" name="cohortId" value={cohort.id} />
      <div className="field">
        <label htmlFor={`cohort-${cohort.id}-status`}>Change to</label>
        <select id={`cohort-${cohort.id}-status`} name="status" required>
          <option value="">Select a lifecycle change</option>
          {next.map((option) => (
            <option key={option.status} value={option.status}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <ReasonField
        id={`cohort-${cohort.id}-status-reason`}
        placeholder="Intake closed"
      />
      <button className="button secondary" disabled={pending}>
        {pending ? "Saving…" : "Apply lifecycle change"}
      </button>
    </form>
  );
}
