"use client";
import { useActionState } from "react";
import {
  grantRoleAction,
  revokeRoleAction,
  saveStaffProfileAction,
  setAccountStatusAction,
  type PeopleActionState,
} from "@/app/admin/people/actions";
import {
  staffRoleLabels,
  staffRoleSchema,
  type Person,
  type StaffRole,
} from "@/domain/admin-control-plane";

function Outcome({ state }: { state: PeopleActionState }) {
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

const staffRoles = staffRoleSchema.options;

function StaffProfileForm({ person }: { person: Person }) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    saveStaffProfileAction,
    {},
  );
  const id = `profile-${person.id}`;
  return (
    <form action={action} className="support-form">
      <h3>{person.staffTitle ? "Staff profile" : "Create staff profile"}</h3>
      <Outcome state={state} />
      <input type="hidden" name="userId" value={person.id} />
      <div className="field">
        <label htmlFor={`${id}-title`}>Staff title</label>
        <input
          id={`${id}-title`}
          name="title"
          minLength={1}
          maxLength={120}
          defaultValue={person.staffTitle ?? ""}
          placeholder="Cybersecurity instructor"
          required
        />
      </div>
      <ReasonField id={`${id}-reason`} placeholder="Appointed to staff" />
      <button className="button secondary" disabled={pending}>
        {pending
          ? "Saving…"
          : person.staffTitle
            ? "Update staff title"
            : "Create staff profile"}
      </button>
    </form>
  );
}

function GrantRoleForm({
  person,
  available,
}: {
  person: Person;
  available: StaffRole[];
}) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    grantRoleAction,
    {},
  );
  const id = `grant-${person.id}`;
  return (
    <form action={action} className="support-form">
      <h3>Grant a staff role</h3>
      <Outcome state={state} />
      <input type="hidden" name="userId" value={person.id} />
      <div className="field">
        <label htmlFor={`${id}-role`}>Role</label>
        <select id={`${id}-role`} name="role" required>
          <option value="">Select a role</option>
          {available.map((role) => (
            <option key={role} value={role}>
              {staffRoleLabels[role]}
            </option>
          ))}
        </select>
      </div>
      <ReasonField id={`${id}-reason`} placeholder="Approved appointment" />
      <button className="button secondary" disabled={pending}>
        {pending ? "Granting…" : "Grant role"}
      </button>
    </form>
  );
}

function RevokeRoleForm({
  person,
  revocable,
}: {
  person: Person;
  revocable: StaffRole[];
}) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    revokeRoleAction,
    {},
  );
  const id = `revoke-${person.id}`;
  return (
    <form action={action} className="support-form">
      <h3>Revoke a staff role</h3>
      <Outcome state={state} />
      <input type="hidden" name="userId" value={person.id} />
      <div className="field">
        <label htmlFor={`${id}-role`}>Role</label>
        <select id={`${id}-role`} name="role" required>
          <option value="">Select a role</option>
          {revocable.map((role) => (
            <option key={role} value={role}>
              {staffRoleLabels[role]}
            </option>
          ))}
        </select>
      </div>
      <ReasonField id={`${id}-reason`} placeholder="Appointment ended" />
      <button className="button secondary" disabled={pending}>
        {pending ? "Revoking…" : "Revoke role"}
      </button>
    </form>
  );
}

function AccountStatusForm({ person }: { person: Person }) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    setAccountStatusAction,
    {},
  );
  const deactivate = person.accountStatus === "ACTIVE";
  const id = `status-${person.id}`;
  return (
    <form action={action} className="support-form">
      <h3>{deactivate ? "Deactivate account" : "Reactivate account"}</h3>
      <p className="muted">
        {deactivate
          ? "Deactivation removes all application authority immediately. Identity, roles and history are kept so the account can be reactivated."
          : "Reactivation restores the account's existing roles."}
      </p>
      <Outcome state={state} />
      <input type="hidden" name="userId" value={person.id} />
      <input
        type="hidden"
        name="status"
        value={deactivate ? "DEACTIVATED" : "ACTIVE"}
      />
      <ReasonField
        id={`${id}-reason`}
        placeholder={deactivate ? "Left the academy" : "Returned to duty"}
      />
      <button className="button secondary" disabled={pending}>
        {pending
          ? "Saving…"
          : deactivate
            ? "Deactivate account"
            : "Reactivate account"}
      </button>
    </form>
  );
}

// Controls mirror the database rules so operators are not offered actions
// that cannot succeed, but the database remains the authority: every rule
// shown here (staff profile prerequisite, last administrator, self-lockout)
// is independently enforced by migration 044 and explained on refusal.
export function PersonControls({
  person,
  isSelf,
}: {
  person: Person;
  isSelf: boolean;
}) {
  const active = person.accountStatus === "ACTIVE";
  const held = staffRoles.filter((role) => person.roles.includes(role));
  const available = staffRoles.filter((role) => !person.roles.includes(role));
  const revocable = held.filter(
    (role) => !(isSelf && role === "PLATFORM_ADMIN"),
  );
  const dependants = person.liveTeaching + person.activeCounselling;
  return (
    <div className="admin-person-controls">
      {!active && dependants > 0 && (
        <p className="notice error" role="status">
          This deactivated account still has {person.liveTeaching} live teaching
          and {person.activeCounselling} active counselling relationship
          {dependants === 1 ? "" : "s"}. They are kept intact; reassign them
          through the class session and counsellor workflows.
        </p>
      )}
      {active ? (
        <StaffProfileForm person={person} />
      ) : (
        <p className="muted">
          Reactivate this account before changing its staff profile or roles.
        </p>
      )}
      {active &&
        (!person.staffTitle ? (
          <p className="muted">
            A staff profile is required before any staff role can be granted.
          </p>
        ) : available.length ? (
          <GrantRoleForm person={person} available={available} />
        ) : (
          <p className="muted">Every staff role is already held.</p>
        ))}
      {revocable.length > 0 && (
        <RevokeRoleForm person={person} revocable={revocable} />
      )}
      {isSelf && held.includes("PLATFORM_ADMIN") && (
        <p className="muted">
          You cannot remove your own platform administration. Another platform
          administrator must do it.
        </p>
      )}
      {isSelf ? (
        <p className="muted">You cannot deactivate your own account.</p>
      ) : (
        <AccountStatusForm person={person} />
      )}
    </div>
  );
}
