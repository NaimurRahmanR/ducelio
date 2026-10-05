import { contextBytes } from "./professor-teaching-context";

// AC-2: the Tutor / Lab Instructor provider input (LEVEL 4 and 5 data).
// Pure. It extends the existing governed Tutor/Lab context (built from the
// release-proved identifiers in src/server/tutor-lab-execution/context.ts)
// with explicit, truthful facts and keeps the existing `role` key, which the
// acceptance provider stub routes on.
//
// * Tutor: no governed record of what the Professor taught exists before
//   AC-3, so the context says so explicitly; the Tutor must not claim it.
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
): Record<string, unknown> & {
  programmeContextNotes: {
    authority: string;
    text: string | null;
    omitted: boolean;
  };
} {
  const roleFacts =
    base.role === "TUTOR"
      ? {
          professorTeachingRecord: {
            available: false,
            reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
            note: "No governed record of what the Professor taught is available. Support the learner from the published curriculum only.",
          },
        }
      : {
          sessionTiming: {
            available: false,
            reason: "NO_AUTHORITATIVE_LAB_SESSION",
            remainingMinutes: null,
            note: "This practical support is not linked to an authoritative class or lab session, so no session clock exists.",
          },
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
