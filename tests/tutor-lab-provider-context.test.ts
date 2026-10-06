import { describe, expect, it } from "vitest";
import { buildTutorLabProviderContext } from "@/domain/tutor-lab-provider-context";
import { contextBytes } from "@/domain/professor-teaching-context";
import {
  PROFESSOR_HANDOFF_SUMMARY,
  type ProfessorTeachingRecord,
} from "@/domain/professor-academic-handoff";

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

describe("AC-3 professorTeachingRecord", () => {
  const record = (
    destinationRole: "TUTOR" | "LAB_INSTRUCTOR",
  ): ProfessorTeachingRecord => ({
    policy: "PROFESSOR_ACADEMIC_HANDOFF_V1",
    sourceRole: "PROFESSOR",
    destinationRole,
    reasonCode:
      destinationRole === "TUTOR"
        ? "OBJECTIVE_REINFORCEMENT"
        : "PRACTICAL_HELP",
    scope: destinationRole === "TUTOR" ? "OBJECTIVE" : "PRACTICAL",
    summary:
      PROFESSOR_HANDOFF_SUMMARY[
        destinationRole === "TUTOR"
          ? "OBJECTIVE_REINFORCEMENT"
          : "PRACTICAL_HELP"
      ],
    recordedAt: "2026-10-06T09:30:00+00:00",
  });
  const build = (
    base: typeof tutorBase | typeof labBase,
    version: string,
    r: ProfessorTeachingRecord | null,
  ) => buildTutorLabProviderContext(base, "Hi", null, 12_000, version, r);

  it("a V2 Tutor with a governed record receives only the bounded, non-authoritative projection", () => {
    const ctx = build(tutorBase, "TUTOR_BEHAVIOUR_V2", record("TUTOR"));
    expect(ctx.professorTeachingRecord).toEqual({
      available: true,
      authority: "NON_AUTHORITATIVE_TEACHING_CONTINUITY",
      policy: "PROFESSOR_ACADEMIC_HANDOFF_V1",
      sourceRole: "PROFESSOR",
      reasonCode: "OBJECTIVE_REINFORCEMENT",
      scope: "OBJECTIVE",
      summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
      recordedAt: "2026-10-06T09:30:00+00:00",
      note: expect.stringMatching(
        /not a transcript, mastery, evidence, a grade, completion or proof of understanding/,
      ),
    });
    // No identifiers, transcript or mastery fields.
    expect(JSON.stringify(ctx.professorTeachingRecord)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-|transcript"|mastery"|grade"|learnerMessage|professorMessage/,
    );
  });

  it("without a record, a V2 Tutor gets exactly the AC-2 unavailable shape", () => {
    expect(
      build(tutorBase, "TUTOR_BEHAVIOUR_V2", null).professorTeachingRecord,
    ).toEqual(
      build(tutorBase, "TUTOR_BEHAVIOUR_V1", null).professorTeachingRecord,
    );
  });

  it("a Tutor pinned to V1 never receives a record, even if one is supplied", () => {
    expect(
      build(tutorBase, "TUTOR_BEHAVIOUR_V1", record("TUTOR"))
        .professorTeachingRecord,
    ).toMatchObject({
      available: false,
      reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
    });
  });

  it("a V2 Lab Instructor receives a Lab record alongside the unchanged no-clock timing; V1 Lab has no such field", () => {
    const v2 = build(
      labBase,
      "LAB_INSTRUCTOR_BEHAVIOUR_V2",
      record("LAB_INSTRUCTOR"),
    );
    expect(v2.professorTeachingRecord).toMatchObject({
      available: true,
      reasonCode: "PRACTICAL_HELP",
      scope: "PRACTICAL",
    });
    expect(v2.sessionTiming).toEqual(
      build(labBase, "LAB_INSTRUCTOR_BEHAVIOUR_V1", null).sessionTiming,
    );
    expect(
      build(labBase, "LAB_INSTRUCTOR_BEHAVIOUR_V1", record("LAB_INSTRUCTOR")),
    ).not.toHaveProperty("professorTeachingRecord");
  });

  it("never gives one destination's record to the other role", () => {
    expect(
      build(tutorBase, "TUTOR_BEHAVIOUR_V2", record("LAB_INSTRUCTOR"))
        .professorTeachingRecord,
    ).toMatchObject({ available: false });
    expect(
      build(labBase, "LAB_INSTRUCTOR_BEHAVIOUR_V2", record("TUTOR"))
        .professorTeachingRecord,
    ).toMatchObject({ available: false });
  });
});
