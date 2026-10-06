"use client";
import { useActionState } from "react";
import {
  requestProfessorFollowUpAction,
  type ProfessorFollowUpActionState,
} from "@/app/student/classroom/actions";
import { TutorLabSupportPanel } from "@/components/practical-support";
import {
  PROFESSOR_FOLLOW_UP_UNSUPPORTED,
  type LearnerProfessorHandoff,
} from "@/domain/professor-academic-handoff";

// AC-3: the learner asks for a Tutor or Lab Instructor follow-up after a
// Professor lesson, and sees exactly what is handed off. The learner never
// chooses a role, summary or source: the destination follows from the
// reviewed reason, and the database derives and verifies everything else.
export const FOLLOW_UP_DISCLOSURE =
  "Only this is shared: that you asked for this follow-up after a Professor lesson, the lesson, and the objective or practical you choose. Your conversation with the Professor is not shared, and this is not a mark, progress or mastery record.";

const STATUS_TEXT: Record<
  NonNullable<ProfessorFollowUpActionState["status"]>,
  string
> = {
  REQUESTED: "Follow-up requested.",
  ALREADY_REQUESTED: "You already requested this follow-up.",
};

function FollowUpForm({
  classSessionId,
  reasonCode,
  field,
  label,
  options,
  button,
  disabled,
}: {
  classSessionId: string;
  reasonCode: "OBJECTIVE_REINFORCEMENT" | "PRACTICAL_HELP";
  field: "objectiveId" | "practicalId";
  label: string;
  options: { id: string; text: string }[];
  button: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(
    requestProfessorFollowUpAction,
    {},
  );
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="classSessionId" value={classSessionId} />
      <input type="hidden" name="reasonCode" value={reasonCode} />
      <label>
        {label}
        <select name={field} required disabled={disabled || pending}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.text}
            </option>
          ))}
        </select>
      </label>
      <button className="button secondary" disabled={disabled || pending}>
        {pending ? "Requesting…" : button}
      </button>
      <p role="status">
        {state.error ?? (state.status ? STATUS_TEXT[state.status] : "")}
      </p>
    </form>
  );
}

export function ProfessorFollowUp({
  classSessionId,
  objectives,
  labPracticals,
  handoffs,
  disabled,
  tutorAvailable,
  labAvailable,
}: {
  classSessionId: string;
  objectives: { id: string; text: string }[];
  labPracticals: { id: string; text: string }[];
  // null when the learner's own follow-ups cannot be read right now.
  handoffs: LearnerProfessorHandoff[] | null;
  disabled: boolean;
  // Whether this course version's Tutor / Lab Instructor can receive a
  // Professor follow-up. Presentation only: the database refuses creation
  // regardless (DESTINATION_BEHAVIOUR_UNSUPPORTED).
  tutorAvailable: boolean;
  labAvailable: boolean;
}) {
  return (
    <section aria-labelledby="professor-follow-up-heading">
      <h2 id="professor-follow-up-heading">Follow up with Tutor or Lab</h2>
      {tutorAvailable || labAvailable ? (
        <p>{FOLLOW_UP_DISCLOSURE}</p>
      ) : (
        <p>{PROFESSOR_FOLLOW_UP_UNSUPPORTED}</p>
      )}
      {tutorAvailable && objectives.length > 0 && (
        <FollowUpForm
          classSessionId={classSessionId}
          reasonCode="OBJECTIVE_REINFORCEMENT"
          field="objectiveId"
          label="Objective for the Tutor to reinforce"
          options={objectives}
          button="Ask the Tutor to reinforce this objective"
          disabled={disabled}
        />
      )}
      {labAvailable && labPracticals.length > 0 && (
        <FollowUpForm
          classSessionId={classSessionId}
          reasonCode="PRACTICAL_HELP"
          field="practicalId"
          label="Lab practical for the Lab Instructor"
          options={labPracticals}
          button="Ask the Lab Instructor for help with this practical"
          disabled={disabled}
        />
      )}
      <h3>Your follow-ups from this class</h3>
      {handoffs === null ? (
        <p className="muted">Your follow-ups are not available right now.</p>
      ) : handoffs.length === 0 ? (
        <p className="muted">You have not requested a follow-up yet.</p>
      ) : (
        handoffs.map((handoff) => (
          <div className="support-record" key={handoff.handoffId}>
            <h4>
              {handoff.destinationRole === "TUTOR" ? "Tutor" : "Lab Instructor"}
              : {handoff.objectiveDescription ?? handoff.practicalTitle}
            </h4>
            <p>{handoff.summary}</p>
            <p className="muted">
              Lesson: {handoff.lessonTitle} · Requested{" "}
              {new Date(handoff.createdAt).toLocaleString()}
            </p>
            {!disabled && (
              <TutorLabSupportPanel
                handoffId={handoff.handoffId}
                lab={handoff.destinationRole === "LAB_INSTRUCTOR"}
              />
            )}
          </div>
        ))
      )}
    </section>
  );
}
