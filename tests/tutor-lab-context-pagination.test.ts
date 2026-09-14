import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getStudentLessonContext: vi.fn(),
  getStudentLessonObjectives: vi.fn(),
  getStudentLessonResources: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  client: vi.fn(),
  getAuthenticatedActor: vi.fn(),
}));
vi.mock("@/server/learning-context", () => ({
  getStudentLessonContext: mocks.getStudentLessonContext,
  getStudentLessonObjectives: mocks.getStudentLessonObjectives,
}));
vi.mock("@/server/learning-resources", () => ({
  getStudentLessonResources: mocks.getStudentLessonResources,
}));
vi.mock("@/server/academic-agent-config", () => ({
  getAgentConfigForEnrolment: mocks.getAgentConfigForEnrolment,
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.getAuthenticatedActor,
}));

import {
  buildTutorContext,
  buildLabContext,
} from "@/server/tutor-lab-execution/context";
import type { TutorLabContentRelease } from "@/server/tutor-lab-execution/release";

const enrolmentId = "cccccccc-0000-4000-8000-000000000001";
const lessonId = "dddddddd-0000-4000-8000-000000000001";
const TOTAL_OBJECTIVES = 120; // > OBJECTIVE_PAGE_SIZE (50), across 3 pages.

function objId(position: number) {
  return `40000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
}
function objective(position: number) {
  return {
    objectiveId: objId(position),
    description: `Objective ${position}`,
    position,
  };
}

// Faithfully mirrors getStudentLessonObjectives' real paginated shape:
// 50-item pages, nextAfterPosition null exactly once the lesson's own
// objectives (up to TOTAL_OBJECTIVES, itself under COURSE_PACKAGE_V1's
// reviewed 250-per-lesson maximum) are exhausted.
function pagedObjectives(total: number) {
  return vi.fn(async ({ afterPosition = 0 }: { afterPosition?: number }) => {
    const start = afterPosition + 1;
    const end = Math.min(afterPosition + 50, total);
    const objectives =
      start > total
        ? []
        : Array.from({ length: end - start + 1 }, (_, i) =>
            objective(start + i),
          );
    return {
      enrolmentId,
      programmeVersionId: "aaaaaaaa-0000-4000-8000-000000000001",
      lessonId,
      objectives,
      nextAfterPosition: end < total ? end : null,
    };
  });
}

function tutorRelease(
  overrides: Partial<TutorLabContentRelease> = {},
): TutorLabContentRelease {
  return {
    releaseId: "aaaaaaaa-0000-4000-8000-000000000002",
    studentId: "student-1",
    invocationId: "bbbbbbbb-0000-4000-8000-000000000001",
    role: "TUTOR",
    reasonCode: "OBJECTIVE_REINFORCEMENT",
    enrolmentId,
    lessonId,
    objectiveId: null,
    practicalId: null,
    ...overrides,
  };
}
function labRelease(
  overrides: Partial<TutorLabContentRelease> = {},
): TutorLabContentRelease {
  return tutorRelease({
    role: "LAB_INSTRUCTOR",
    reasonCode: "PRACTICAL_HELP",
    practicalId: "eeeeeeee-0000-4000-8000-000000000001",
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getStudentLessonContext.mockResolvedValue({
    title: "Access Control",
    position: 1,
  });
  mocks.getAgentConfigForEnrolment.mockResolvedValue({
    enabled: true,
    modelProfileRef: null,
    capabilities: ["get_lesson_context", "get_lesson_objectives"],
    escalationPolicy: "NONE",
  });
  mocks.getAuthenticatedActor.mockResolvedValue({ id: "student-1" });
});

describe("Context reasonCode is the authoritative handoff reason, never the role name (Blocker 2 regression)", () => {
  it("buildTutorContext returns release.reasonCode verbatim, for every Tutor reason", async () => {
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    for (const reasonCode of [
      "MISSED_LESSON_PRACTICE",
      "OBJECTIVE_REINFORCEMENT",
      "PRACTICAL_PREREQUISITE",
    ] as const) {
      const release = tutorRelease({
        reasonCode,
        objectiveId: reasonCode === "OBJECTIVE_REINFORCEMENT" ? objId(1) : null,
      });
      const context = await buildTutorContext(release);
      expect(context.reasonCode).toBe(reasonCode);
      expect(context.reasonCode).not.toBe("TUTOR");
    }
  });
  it("buildLabContext returns release.reasonCode verbatim (PRACTICAL_HELP), never LAB_INSTRUCTOR", async () => {
    mocks.client.mockResolvedValue({
      rpc: vi.fn(async () => ({
        data: {
          id: "eeeeeeee-0000-4000-8000-000000000001",
          lessonId,
          kind: "PRACTICAL_LAB",
          title: "Configure access control",
          instructions: "Do the thing.",
          position: 1,
          objectiveIds: [objId(1)],
        },
        error: null,
      })),
    });
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const context = await buildLabContext(labRelease());
    expect(context.reasonCode).toBe("PRACTICAL_HELP");
    expect(context.reasonCode).not.toBe("LAB_INSTRUCTOR");
  });
});

describe("Tutor context: objective resolution beyond the first page (Blocker 4 regression)", () => {
  it("an objective at position 75 (page 2 of a >50-objective lesson) resolves correctly, never null", async () => {
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const release = tutorRelease({ objectiveId: objId(75) });
    const context = await buildTutorContext(release);
    expect(context.requestedObjective).toEqual({ description: "Objective 75" });
  });
  it("an objective at position 115 (page 3) also resolves correctly", async () => {
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const release = tutorRelease({ objectiveId: objId(115) });
    const context = await buildTutorContext(release);
    expect(context.requestedObjective).toEqual({
      description: "Objective 115",
    });
  });
  it("traversal is bounded: at most the pages needed to cover the canonical maximum lesson objective count, never unbounded", async () => {
    const paged = pagedObjectives(TOTAL_OBJECTIVES);
    mocks.getStudentLessonObjectives.mockImplementation(paged);
    const release = tutorRelease({ objectiveId: objId(115) });
    await buildTutorContext(release);
    // 1 bounded overview page + at most 5 pages (250/50) to locate the
    // objective -- never more, and never a loop that could run forever.
    expect(paged.mock.calls.length).toBeLessThanOrEqual(6);
  });
  it("a requested objective that cannot be found anywhere in the lesson fails CONTEXT_CONFLICT, never a null requestedObjective reaching the provider", async () => {
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const release = tutorRelease({ objectiveId: objId(9999) });
    await expect(buildTutorContext(release)).rejects.toMatchObject({
      code: "CONTEXT_CONFLICT",
    });
  });
  it("no objectiveId (e.g. MISSED_LESSON_PRACTICE) does not require full traversal and never fails", async () => {
    const paged = pagedObjectives(TOTAL_OBJECTIVES);
    mocks.getStudentLessonObjectives.mockImplementation(paged);
    const release = tutorRelease({
      reasonCode: "MISSED_LESSON_PRACTICE",
      objectiveId: null,
    });
    const context = await buildTutorContext(release);
    expect(context.requestedObjective).toBeNull();
    // Only the bounded overview page is fetched -- never all 250 objectives
    // merely because they exist.
    expect(paged.mock.calls.length).toBe(1);
  });
  it("the assessment firewall remains enforced during pagination: a blocked page fails the whole context build closed", async () => {
    mocks.getStudentLessonObjectives.mockRejectedValue(
      new Error("Academic action is blocked by the current activity."),
    );
    const release = tutorRelease({ objectiveId: objId(75) });
    await expect(buildTutorContext(release)).rejects.toThrow();
  });
});

describe("Lab context: full objective-set resolution beyond the first page (Blocker 4 regression)", () => {
  function mockPractical(objectiveIds: string[]) {
    mocks.client.mockResolvedValue({
      rpc: vi.fn(async () => ({
        data: {
          id: "eeeeeeee-0000-4000-8000-000000000001",
          lessonId,
          kind: "PRACTICAL_LAB",
          title: "Configure access control",
          instructions: "Do the thing.",
          position: 1,
          objectiveIds,
        },
        error: null,
      })),
    });
  }
  it("mapped objectives scattered across pages 1, 2 and 3 all resolve; set/count equality holds", async () => {
    const mapped = [objId(5), objId(75), objId(115)];
    mockPractical(mapped);
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const release = labRelease();
    const context = await buildLabContext(release);
    expect(context.objectives).toHaveLength(3);
    expect(context.objectives.map((o) => o.description).sort()).toEqual([
      "Objective 115",
      "Objective 5",
      "Objective 75",
    ]);
  });
  it("if any mapped objective cannot be resolved, the whole context build fails closed -- never a partial set", async () => {
    const mapped = [objId(5), objId(9999)];
    mockPractical(mapped);
    mocks.getStudentLessonObjectives.mockImplementation(
      pagedObjectives(TOTAL_OBJECTIVES),
    );
    const release = labRelease();
    await expect(buildLabContext(release)).rejects.toMatchObject({
      code: "CONTEXT_CONFLICT",
    });
  });
  it("traversal is bounded, never unbounded", async () => {
    const mapped = [objId(115)];
    mockPractical(mapped);
    const paged = pagedObjectives(TOTAL_OBJECTIVES);
    mocks.getStudentLessonObjectives.mockImplementation(paged);
    const release = labRelease();
    await buildLabContext(release);
    expect(paged.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
