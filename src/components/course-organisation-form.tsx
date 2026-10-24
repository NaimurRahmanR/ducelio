"use client";
import { useActionState } from "react";
import {
  changeOrganisationMember,
  createCourseOrganisation,
} from "@/app/admin/course-engineering/organisation-actions";
export function CreateCourseOrganisationForm() {
  const [state, action, pending] = useActionState(createCourseOrganisation, {});
  return (
    <form action={action} className="acad-form">
      <fieldset disabled={pending}>
        <legend>Host an organisation</legend>
        <label>
          Name
          <input name="name" required minLength={3} maxLength={150} />
        </label>
        <label>
          Organisation address
          <input
            name="slug"
            required
            minLength={3}
            maxLength={60}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
        </label>
        <label>
          Owner account email
          <input name="email" type="email" required maxLength={254} />
        </label>
        <label>
          Reason
          <input name="reason" required minLength={5} maxLength={300} />
        </label>
        <button className="ac-button">Create organisation</button>
      </fieldset>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
export function CourseOrganisationForm({
  organisations,
}: {
  organisations: { id: string; name: string; canOwn: boolean }[];
}) {
  const [state, action, pending] = useActionState(changeOrganisationMember, {});
  const owned = organisations.filter((o) => o.canOwn);
  if (!owned.length) return null;
  return (
    <form action={action} className="acad-form">
      <fieldset disabled={pending}>
        <legend>Organisation permissions</legend>
        <label>
          Organisation
          <select name="organisationId" required>
            {owned.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Verified account email
          <input type="email" name="email" required maxLength={254} />
        </label>
        <label>
          Permission
          <select name="role">
            <option value="COURSE_MANAGER">Course manager</option>
            <option value="ACADEMIC_REVIEWER">Academic reviewer</option>
            <option value="OWNER">Owner</option>
          </select>
        </label>
        <label>
          Membership
          <select name="active">
            <option value="true">Active</option>
            <option value="false">Revoked</option>
          </select>
        </label>
        <label>
          Reason
          <input name="reason" required minLength={5} maxLength={300} />
        </label>
        <button className="ac-button">Save membership</button>
      </fieldset>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
