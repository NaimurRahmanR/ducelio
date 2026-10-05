import { contextBytes } from "./professor-teaching-context";
import { PROFESSOR_TEACHING_RECORD_AWARE_VERSIONS } from "./agent-behaviour";
import {
  PROFESSOR_TEACHING_RECORD_UNAVAILABLE,
  professorTeachingRecordForProvider,
  type ProfessorTeachingRecord,
} from "./professor-academic-handoff";

// AC-2: the Tutor / Lab Instructor provider input (LEVEL 4 and 5 data).
// Pure. It extends the existing governed Tutor/Lab context (built from the
// release-proved identifiers in src/server/tutor-lab-execution/context.ts)
// with explicit, truthful facts and keeps the existing `role` key, which the
// acceptance provider stub routes on.
//
// * Tutor: without a governed AC-3 Professor academic handoff, the context
//   says explicitly that no record of Professor teaching exists. With one,
//   and only when the pinned role version is told what it means
//   (TUTOR_BEHAVIOUR_V2), professorTeachingRecord carries only the
//   minimum-data projection: never a transcript, mastery or evidence.
// * Lab Instructor V2 receives professorTeachingRecord on the same terms;
//   V1 receives no such field, exactly as before AC-3.
// * Lab Instructor: handoff-driven support is not linked to any
//   authoritative class or lab session, so no clock or countdown exists.
//   Expected-duration metadata is never used as a clock.
// * Programme course-context notes are bounded subordinate data, dropped
//   (and reported) before the context could exceed the runtime budget.

type TutorBase = { role: "TUTOR" } & Record<string, unknown>;
type LabBase = { role: "LAB_INSTRUCTOR" } & Record<string, unknown>;

export function buildTutorLabProviderContext(
  base: TutorBase | LabBase,
  learnerMessage: string,
  courseContextNotes: string | null,
  budgetBytes: number,
  // The role behaviour version pinned by the programme version's binding.
  behaviourVersion: string,
  // AC-3: the governed Professor academic handoff projection for this exact
  // release, or null.
  professorTeachingRecord: ProfessorTeachingRecord | null = null,
): Record<string, unknown> & {
  programmeContextNotes: {
    authority: string;
    text: string | null;
    omitted: boolean;
  };
} {
  const aware = PROFESSOR_TEACHING_RECORD_AWARE_VERSIONS.has(behaviourVersion);
  const teachingRecord =
    aware &&
    professorTeachingRecord !== null &&
    professorTeachingRecord.destinationRole === base.role
      ? professorTeachingRecordForProvider(professorTeachingRecord)
      : { ...PROFESSOR_TEACHING_RECORD_UNAVAILABLE };
  const roleFacts =
    base.role === "TUTOR"
      ? { professorTeachingRecord: teachingRecord }
      : {
          // AC-3 decision: Lab timing is still not invented. No handoff is
          // linked to an authoritative lab session.
          sessionTiming: {
            available: false,
            reason: "NO_AUTHORITATIVE_LAB_SESSION",
            remainingMinutes: null,
            note: "This practical support is not linked to an authoritative class or lab session, so no session clock exists.",
          },
          ...(aware ? { professorTeachingRecord: teachingRecord } : {}),
        };
  const context = {
    ...base,
    behaviourVersion,
    ...roleFacts,
    programmeContextNotes: {
      authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
      text: courseContextNotes,
      omitted: false,
    },
    learnerMessage,
  };
  if (courseContextNotes !== null && contextBytes(context) > budgetBytes)
    context.programmeContextNotes = {
      authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
      text: null,
      omitted: true,
    };
  return context;
}
