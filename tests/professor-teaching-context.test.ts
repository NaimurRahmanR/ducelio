import { describe, expect, it } from "vitest";
import {
  TEACHING_CONTEXT_LIMITS,
  buildProfessorTeachingContext,
  contextBytes,
  deriveTiming,
  type ClassroomTurn,
  type TeachingContextInput,
} from "@/domain/professor-teaching-context";

// AC-2: the Professor's server-derived LEVEL-4 context. Deterministic,
// bounded, priority-ordered (identity/timing/learner message, then
// objectives, then memory, then supplementary resources), and labelled
// authoritative vs non-authoritative.
const E = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const L = "33333333-3333-4333-8333-333333333333";
const objectiveId = (n: number) =>
  `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const resourceId = (n: number) =>
  `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;

function input(over: Partial<TeachingContextInput> = {}): TeachingContextInput {
  return {
    classroom: {
      classroomId: "66666666-6666-4666-8666-666666666666",
      classSessionId: "77777777-7777-4777-8777-777777777777",
      enrolmentId: E,
      programmeVersionId: V,
      lessonId: L,
      lessonTitle: "Access control",
      lessonPosition: 1,
      moduleTitle: "Security principles",
      scheduledStart: "2026-10-06T09:00:00+00:00",
      scheduledEnd: "2026-10-06T10:00:00+00:00",
      serverNow: "2026-10-06T09:37:30.500+00:00",
      mode: "LIVE",
    },
    objectives: {
      enrolmentId: E,
      programmeVersionId: V,
      lessonId: L,
      objectives: [1, 2, 3].map((n) => ({
        objectiveId: objectiveId(n),
        description: `Explain concept ${n}`,
        position: n,
      })),
      nextAfterPosition: null,
    },
    mastery: {
      enrolmentId: E,
      programmeVersionId: V,
      lessonId: L,
      persistedOnly: true,
      records: [
        {
          objectiveId: objectiveId(2),
          state: "NEEDS_REINFORCEMENT",
          policyVersion: "MASTERY_V1",
          evaluatedAt: "2026-10-05T09:00:00+00:00",
          evidenceCount: 2,
          correctEvidenceCount: 0,
          correctSessionCount: 0,
          correctKindCount: 0,
        } as never,
      ],
    },
    resources: {
      enrolmentId: E,
      programmeVersionId: V,
      lessonId: L,
      resources: [
        {
          resourceId: resourceId(1),
          title: "Lecture note",
          position: 1,
          kind: "LECTURE_NOTE",
          body: "Least privilege means…",
          url: null,
        },
      ],
      nextCursor: null,
    },
    turns: [],
    totalTurns: 0,
    unrecordedExchanges: 0,
    courseContextNotes: "Use CompTIA terminology.",
    behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
    interaction: {
      kind: "LEARNER_QUESTION",
      learnerMessage: "Go step by step",
    },
    ...over,
  };
}
function turns(n: number): ClassroomTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    turnNumber: i + 1,
    interactionKind: "LEARNER_QUESTION" as const,
    learnerMessage: `Question ${i + 1}`,
    professorMessage: `Answer ${i + 1}`,
    recordedAt: "2026-10-06T09:10:00+00:00",
  }));
}
type Ctx = {
  serverContext: {
    objectives: {
      objectiveId: string;
      description: string;
      authoritativeMasteryState: string;
    }[];
    objectiveListComplete: boolean;
    resources: { excerpt: string | null }[];
    timing: { remainingMinutes: number | null; mode: string };
    authoritativeMastery: { available: boolean };
  };
  classroomMemory: {
    continuity: string;
    unrecordedExchanges: number;
    turns: { turnNumber: number; learnerMessage: string }[];
  };
  programmeContextNotes: { text: string | null; omitted: boolean };
  learnerInteraction: unknown;
  role: string;
};
function built(over: Partial<TeachingContextInput> = {}, budget = 16_000) {
  const result = buildProfessorTeachingContext(input(over), budget);
  if (!result.ok) throw new Error(result.reason);
  return { ...result, ctx: result.context as unknown as Ctx };
}

describe("authoritative timing", () => {
  it("derives remaining minutes from the database scheduled end and clock in a LIVE class", () => {
    expect(deriveTiming(input().classroom)).toMatchObject({
      mode: "LIVE",
      remainingMinutes: 22,
      authority: "AUTHORITATIVE_DATABASE_CLOCK",
    });
  });
  it("never invents a countdown for catch-up", () => {
    const timing = deriveTiming({
      ...input().classroom,
      mode: "CATCH_UP",
      serverNow: "2026-10-06T12:00:00+00:00",
    });
    expect(timing.remainingMinutes).toBeNull();
    expect(timing.note).toMatch(/no class clock/);
  });
  it("never reports negative time remaining", () => {
    expect(
      deriveTiming({
        ...input().classroom,
        serverNow: "2026-10-06T10:00:00+00:00",
      }).remainingMinutes,
    ).toBe(0);
  });
});

describe("curriculum context", () => {
  it("carries role, lesson, published objectives with labelled authoritative mastery, and the learner interaction", () => {
    const { ctx } = built();
    expect(ctx.role).toBe("PROFESSOR");
    expect(ctx.serverContext.objectives.map((o) => o.objectiveId)).toEqual([
      objectiveId(1),
      objectiveId(2),
      objectiveId(3),
    ]);
    expect(
      ctx.serverContext.objectives.map((o) => o.authoritativeMasteryState),
    ).toEqual(["NO_RECORD", "NEEDS_REINFORCEMENT", "NO_RECORD"]);
    expect(ctx.learnerInteraction).toEqual({
      kind: "LEARNER_QUESTION",
      learnerMessage: "Go step by step",
    });
    expect(ctx.programmeContextNotes).toMatchObject({
      text: "Use CompTIA terminology.",
      omitted: false,
    });
  });
  it("states plainly when mastery is not authorised rather than guessing", () => {
    const { ctx } = built({ mastery: null });
    expect(ctx.serverContext.authoritativeMastery.available).toBe(false);
    expect(
      ctx.serverContext.objectives.every(
        (o) => o.authoritativeMasteryState === "NOT_AVAILABLE",
      ),
    ).toBe(true);
  });
  it("fails closed when the lesson has no published objectives", () => {
    expect(
      buildProfessorTeachingContext(
        input({
          objectives: { ...input().objectives, objectives: [] },
        }),
        16_000,
      ),
    ).toEqual({ ok: false, reason: "NO_OBJECTIVES" });
  });
});

describe("deterministic context budgeting", () => {
  it("never exceeds the runtime input budget", () => {
    const long = "x".repeat(12_000);
    for (const budget of [3_000, 6_000, 16_000]) {
      const result = buildProfessorTeachingContext(
        input({
          turns: turns(40),
          totalTurns: 40,
          resources: {
            ...input().resources!,
            resources: [1, 2, 3, 4, 5].map((n) => ({
              resourceId: resourceId(n),
              title: `Note ${n}`,
              position: n,
              kind: "LECTURE_NOTE" as const,
              body: long,
              url: null,
            })),
          },
        }),
        budget,
      );
      if (result.ok)
        expect(contextBytes(result.context)).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps objectives before memory, and memory before supplementary resources", () => {
    const big = "y".repeat(2000);
    const { ctx, report } = built(
      {
        turns: turns(12).map((t) => ({ ...t, professorMessage: big })),
        totalTurns: 12,
        resources: {
          ...input().resources!,
          resources: [
            {
              resourceId: resourceId(1),
              title: "Lecture note",
              position: 1,
              kind: "LECTURE_NOTE",
              body: big,
              url: null,
            },
          ],
        },
      },
      6_000,
    );
    expect(ctx.serverContext.objectives).toHaveLength(3);
    expect(report.memoryTurnsIncluded).toBeGreaterThan(0);
    expect(report.memoryTurnsIncluded).toBeLessThan(12);
    // the newest turns win and keep chronological order
    const numbers = ctx.classroomMemory.turns.map((t) => t.turnNumber);
    expect(numbers.at(-1)).toBe(12);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    // The resource's excerpt never displaces memory: at most its cheap
    // identity is listed with whatever room remains.
    expect(ctx.serverContext.resources.every((r) => r.excerpt === null)).toBe(
      true,
    );
    expect(report.resourceExcerptsTruncated).toBe(
      ctx.serverContext.resources.length > 0,
    );
  });

  it("drops optional programme notes first, and fails closed when the mandatory core cannot fit", () => {
    const notes = "n".repeat(2000);
    const { ctx, report } = built({ courseContextNotes: notes }, 3_000);
    expect(report.courseContextNotesOmitted).toBe(true);
    expect(ctx.programmeContextNotes).toEqual({
      authority: "PROGRAMME_AUTHORED_SUBORDINATE_DATA",
      text: null,
      omitted: true,
    });
    expect(buildProfessorTeachingContext(input(), 500)).toEqual({
      ok: false,
      reason: "MANDATORY_CONTEXT_EXCEEDS_BUDGET",
    });
  });

  it("caps memory to the most recent turns and bounds every message", () => {
    const { ctx } = built(
      {
        turns: turns(30).map((t) => ({
          ...t,
          learnerMessage: "q".repeat(2000),
        })),
        totalTurns: 30,
        resources: null,
      },
      64_000,
    );
    expect(ctx.classroomMemory.turns).toHaveLength(
      TEACHING_CONTEXT_LIMITS.memoryTurns,
    );
    expect(ctx.classroomMemory.turns[0].turnNumber).toBe(19);
    for (const turn of ctx.classroomMemory.turns)
      expect(Array.from(turn.learnerMessage).length).toBeLessThanOrEqual(
        TEACHING_CONTEXT_LIMITS.memoryMessageChars + 1,
      );
  });

  const manyObjectives = (count: number, chars: number) => ({
    ...input().objectives,
    objectives: Array.from({ length: count }, (_, i) => ({
      objectiveId: objectiveId(i + 1),
      description: `${i + 1}:${"d".repeat(chars)}`,
      position: i + 1,
    })),
    nextAfterPosition: null,
  });

  it("always carries the complete objective set, untruncated, whenever it proceeds", () => {
    const objectives = manyObjectives(50, 120);
    const { ctx, report } = built(
      {
        objectives,
        turns: turns(12),
        totalTurns: 12,
        courseContextNotes: "n".repeat(2000),
      },
      16_000,
    );
    expect(report.objectivesIncluded).toBe(50);
    expect(ctx.serverContext.objectiveListComplete).toBe(true);
    expect(ctx.serverContext.objectives.map((o) => o.description)).toEqual(
      objectives.objectives.map((o) => o.description),
    );
    // Optional context gave way instead of any objective.
    expect(contextBytes(ctx)).toBeLessThanOrEqual(16_000);
  });

  it("refuses rather than drop or truncate objectives when they cannot all fit", () => {
    for (const budget of [3_000, 16_000])
      expect(
        buildProfessorTeachingContext(
          input({ objectives: manyObjectives(50, 4000), resources: null }),
          budget,
        ),
      ).toEqual({ ok: false, reason: "MANDATORY_CONTEXT_EXCEEDS_BUDGET" });
  });

  it("refuses an incomplete objective set even when the loaded page would fit", () => {
    const exactlyFull = manyObjectives(50, 10);
    expect(
      built({ objectives: exactlyFull }, 16_000).report.objectivesIncluded,
    ).toBe(50);
    expect(
      buildProfessorTeachingContext(
        input({ objectives: { ...exactlyFull, nextAfterPosition: 50 } }),
        16_000,
      ),
    ).toEqual({ ok: false, reason: "OBJECTIVES_INCOMPLETE" });
  });
});

describe("classroom memory continuity", () => {
  it("tells the Professor plainly when earlier exchanges were not recorded", () => {
    expect(built().ctx.classroomMemory).toMatchObject({
      continuity: "COMPLETE",
      unrecordedExchanges: 0,
    });
    const { context, ctx } = built({
      turns: turns(2),
      totalTurns: 2,
      unrecordedExchanges: 1,
    });
    expect(ctx.classroomMemory).toMatchObject({
      continuity: "DEGRADED",
      unrecordedExchanges: 1,
    });
    expect(JSON.stringify(context)).toContain("could not be recorded");
  });
});

describe("authority labelling and data minimisation", () => {
  it("labels authoritative and non-authoritative parts and carries no protected or psychological fields", () => {
    const { context } = built({ turns: turns(2), totalTurns: 2 });
    const text = JSON.stringify(context);
    expect(text).toContain("AUTHORITATIVE_SERVER_DERIVED");
    expect(text).toContain("NON_AUTHORITATIVE_LEARNER_VISIBLE_TRANSCRIPT");
    expect(text).toContain("PROGRAMME_AUTHORED_SUBORDINATE_DATA");
    expect(text).not.toMatch(
      /expectedAnswer|markingGuidance|answerKey|personality|intelligence|mentalHealth|motivation|learningStyle/i,
    );
  });
});
