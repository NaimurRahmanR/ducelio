import { describe, expect, it } from "vitest";
import { buildTutorLabProviderContext } from "@/domain/tutor-lab-provider-context";
import { contextBytes } from "@/domain/professor-teaching-context";

// AC-2: Tutor and Lab Instructor provider input. Server-derived facts only;
// the Tutor is told plainly that no governed Professor teaching record
// exists (AC-3 adds one), and the Lab Instructor that no authoritative lab
// session clock exists for handoff-driven support.
const tutorBase = {
  role: "TUTOR" as const,
  reasonCode: "MISSED_LESSON_PRACTICE",
  lesson: { title: "Access control", position: 1 },
  objectives: [{ description: "Explain authentication", position: 1 }],
  requestedObjective: null,
  resources: null,
};
const labBase = {
  role: "LAB_INSTRUCTOR" as const,
  reasonCode: "PRACTICAL_HELP",
  lesson: { title: "Access control", position: 1 },
  practical: {
    kind: "PRACTICAL_LAB" as const,
    title: "Configure MFA",
    instructions: "Enable MFA for the test account.",
  },
  objectives: [{ description: "Explain MFA", position: 1 }],
};

describe("Tutor provider context", () => {
  it("keeps the existing role/reason fields and says no Professor teaching record exists", () => {
    const ctx = buildTutorLabProviderContext(
      tutorBase,
      "Explain it differently",
      "Use plain English.",
      12_000,
      "TUTOR_BEHAVIOUR_V1",
    );
    expect(ctx).toMatchObject({
      role: "TUTOR",
      reasonCode: "MISSED_LESSON_PRACTICE",
      behaviourVersion: "TUTOR_BEHAVIOUR_V1",
      learnerMessage: "Explain it differently",
      professorTeachingRecord: {
        available: false,
        reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
      },
      programmeContextNotes: {
        authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
        text: "Use plain English.",
        omitted: false,
      },
    });
    expect(ctx).not.toHaveProperty("sessionTiming");
    expect(JSON.stringify(ctx)).not.toMatch(/classNote|class_note/i);
  });
});

describe("Lab Instructor provider context", () => {
  it("never carries a session clock: timing is explicitly unavailable", () => {
    const ctx = buildTutorLabProviderContext(
      labBase,
      "It failed",
      null,
      12_000,
      "LAB_INSTRUCTOR_BEHAVIOUR_V1",
    );
    expect(ctx).toMatchObject({
      role: "LAB_INSTRUCTOR",
      behaviourVersion: "LAB_INSTRUCTOR_BEHAVIOUR_V1",
      sessionTiming: {
        available: false,
        reason: "NO_AUTHORITATIVE_LAB_SESSION",
        remainingMinutes: null,
      },
    });
    expect(ctx).not.toHaveProperty("professorTeachingRecord");
    expect(JSON.stringify(ctx)).not.toMatch(/scheduledEnd|durationMinutes/);
  });
});

describe("budgeting", () => {
  it("drops programme notes, reported, before ever exceeding the input budget", () => {
    const notes = "n".repeat(2000);
    const roomy = buildTutorLabProviderContext(
      tutorBase,
      "Hi",
      notes,
      12_000,
      "TUTOR_BEHAVIOUR_V1",
    );
    const tight = contextBytes(roomy) - 100;
    const ctx = buildTutorLabProviderContext(
      tutorBase,
      "Hi",
      notes,
      tight,
      "TUTOR_BEHAVIOUR_V1",
    );
    expect(ctx.programmeContextNotes).toEqual({
      authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
      text: null,
      omitted: true,
    });
    expect(contextBytes(ctx)).toBeLessThanOrEqual(tight);
  });
});
