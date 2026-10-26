import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssessmentCentre,
  CourseWorkspace,
  PracticalLab,
} from "@/domain/learner-contract";

// The course workspace (docs/61 §2): three rows of two panels, rendered
// from a typed workspace projection. Fixtures only; every control posts to
// an action prop that the page wires to a server action.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));

import { CourseWorkspaceView } from "@/components/learner/course-workspace";

const FIXTURE_ASSESSMENT: NonNullable<AssessmentCentre> = {
  itemId: "item-a",
  ref: "midterm",
  title: "Fixture Midterm",
  opensAt: "2026-11-04T09:00:00Z",
  closesAt: "2026-11-05T08:59:00Z",
  durationMinutes: 60,
  attemptsUsed: 0,
  attemptsAllowed: 2,
  activeAttemptId: null,
  state: "OPEN",
  canStart: true,
  reason: null,
};
const FIXTURE_LAB: NonNullable<PracticalLab> = {
  itemId: "item-l",
  ref: "lab-1",
  title: "Fixture Practical",
  opensAt: "2026-11-06T09:00:00Z",
  closesAt: "2026-11-07T08:59:00Z",
  state: "UPCOMING",
  canAttend: false,
  submitted: false,
  graded: false,
};

function fixtureWorkspace(
  overrides: Partial<CourseWorkspace> = {},
): CourseWorkspace {
  return {
    course: {
      enrolmentId: "e-1",
      courseId: "c-1",
      title: "Fixture Networking Course",
      provider: "Fixture Provider",
      status: "ACTIVE",
      scheduled: true,
      accessRevoked: false,
    },
    currentClass: {
      itemId: "item-c",
      enrolmentId: "e-1",
      courseTitle: "Fixture Networking Course",
      provider: "Fixture Provider",
      kind: "LESSON",
      ref: "lesson-3",
      title: "Fixture Lesson Three",
      part: 1,
      parts: 1,
      startsAt: "2026-11-04T09:00:00Z",
      endsAt: "2026-11-04T10:00:00Z",
      opensAt: "2026-11-04T09:00:00Z",
      closesAt: "2026-11-05T08:59:00Z",
      state: "OPEN",
      classroomId: null,
      evidence: {
        checkedInAt: null,
        correctInClassAnswers: 3,
        lessonObjectives: [
          { ref: "o1", title: "Fixture objective one", covered: true },
          { ref: "o2", title: "Fixture objective two", covered: true },
          { ref: "o3", title: "Fixture objective three", covered: false },
          { ref: "o4", title: "Fixture objective four", covered: false },
        ],
        topicsCovered: ["Fixture topic"],
      },
    },
    tutorAvailable: true,
    assessment: FIXTURE_ASSESSMENT,
    lab: FIXTURE_LAB,
    results: [],
    progression: {
      enrolmentId: "e-1",
      classes: { total: 12, attended: 2, missed: 0 },
      objectives: { total: 30, demonstrated: 0 },
      practicals: { total: 3, submitted: 0, graded: 0 },
      assessments: { total: 2, released: 0 },
      completion: { completed: false, completedAt: null },
    },
    ...overrides,
  };
}

const actions = {
  checkInAction: vi.fn(async () => ({})),
  enterClassAction: vi.fn(async () => undefined),
  openTutorAction: vi.fn(async () => undefined),
  startAssessmentAction: vi.fn(async () => ({})),
  attendLabAction: vi.fn(async () => undefined),
};
const render = (
  workspace: CourseWorkspace | null = fixtureWorkspace(),
  extra: Partial<Parameters<typeof CourseWorkspaceView>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(CourseWorkspaceView, {
      workspace,
      serverTime: "2026-11-04T09:20:00Z",
      timeZone: "UTC",
      ...actions,
      ...extra,
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const panel = (html: string, name: string) => {
  const start = html.indexOf(`data-panel="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("data-panel=", start + 10);
  return html.slice(start, next === -1 ? undefined : next);
};

describe("workspace layout", () => {
  it("renders six panels in three rows of two", () => {
    const html = render();
    const rows = [...html.matchAll(/data-row="(\d)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["1", "2", "3"]);
    const panels = [...html.matchAll(/data-panel="([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(panels).toEqual([
      "classroom",
      "tutor",
      "assessment",
      "lab",
      "results",
      "progression",
    ]);
    const plain = text(html);
    for (const title of [
      "Professor Classroom",
      "AI Tutor",
      "Assessment Centre",
      "Practical Lab",
      "Results",
      "Course Progression",
    ])
      expect(plain).toContain(title);
  });

  it("explains a workspace that could not be loaded", () => {
    expect(text(render(null))).toContain("This course could not be loaded");
  });

  it("points a learner without a timetable to the activation flow", () => {
    const ws = fixtureWorkspace();
    const html = render({ ...ws, course: { ...ws.course, scheduled: false } });
    expect(html).toContain(
      'href="/student/academy?enrolmentId=e-1&amp;activate=true"',
    );
  });
});

describe("Professor Classroom", () => {
  it("shows the schedule, the availability window and a Give attendance form", () => {
    const html = panel(render(), "classroom");
    const plain = text(html);
    expect(plain).toContain("Fixture Lesson Three");
    expect(plain).toMatch(/Scheduled start .*4 Nov 2026, 09:00/);
    expect(plain).toContain("(23 h 59 min)");
    expect(html).toContain('name="scheduleItemId" value="item-c"');
    expect(plain).toContain("Give attendance");
    expect(plain).toContain("Correct in-class answers 3");
    expect(plain).toContain("2 of 4 verified");
    expect(html).toContain('aria-valuenow="50"');
    // No classroom yet: the existing enter-class flow is offered.
    expect(html).not.toContain("/student/academy/classroom/");
    expect(plain).toContain("Enter classroom");
  });

  it("states that attendance is not completion or mastery", () => {
    const plain = text(panel(render(), "classroom"));
    expect(plain).toContain(
      "Attendance records that you were present. It is not completion or mastery",
    );
    expect(plain).not.toMatch(/\bmastered\b(?! only)/);
  });

  it("shows the elapsed time on the server clock once checked in, with no second check-in", () => {
    const ws = fixtureWorkspace();
    const html = panel(
      render({
        ...ws,
        currentClass: {
          ...ws.currentClass!,
          state: "ATTENDED",
          classroomId: "room-1",
          evidence: {
            ...ws.currentClass!.evidence,
            checkedInAt: "2026-11-04T09:14:30Z",
          },
        },
      }),
      "classroom",
    );
    expect(html).toContain('role="timer"');
    // serverTime 09:20:00 minus check-in 09:14:30.
    expect(text(html)).toContain("00:05:30");
    expect(text(html)).not.toContain("Give attendance");
    expect(html).toContain('href="/student/academy/classroom/room-1"');
  });

  it("offers no attendance before the class opens", () => {
    const ws = fixtureWorkspace();
    const plain = text(
      panel(
        render({
          ...ws,
          currentClass: { ...ws.currentClass!, state: "UPCOMING" },
        }),
        "classroom",
      ),
    );
    expect(plain).not.toContain("Give attendance");
    expect(plain).toContain("Attendance opens at the scheduled start.");
  });

  it("has an empty state", () => {
    expect(
      text(
        panel(render(fixtureWorkspace({ currentClass: null })), "classroom"),
      ),
    ).toContain("No class is open or scheduled next.");
  });
});

describe("AI Tutor", () => {
  it("offers class notes and topic explanations through the Tutor action", () => {
    const html = panel(render(), "tutor");
    expect(html).toMatch(
      /<button(?=[^>]*name="request")(?=[^>]*value="CLASS_NOTES")[^>]*>Give Class Notes<\/button>/,
    );
    expect(html).toMatch(
      /<button(?=[^>]*name="request")(?=[^>]*value="EXPLAIN_TOPICS")[^>]*>Explain Class Topics<\/button>/,
    );
    expect(html).toContain('name="lessonRef" value="lesson-3"');
    expect(html).toContain('href="/student/tutor-notes"');
  });

  it("is closed during an active examination", () => {
    const html = panel(
      render(fixtureWorkspace({ tutorAvailable: false })),
      "tutor",
    );
    expect(text(html)).toContain("The AI Tutor is closed");
    expect(html).not.toContain("<form");
  });
});

describe("Assessment Centre", () => {
  it('shows "Take {title}" only when the assessment can start', () => {
    const html = panel(render(), "assessment");
    expect(text(html)).toContain("Take Fixture Midterm");
    expect(text(html)).toContain("0 of 2 used");
    expect(html).toContain('name="assessmentRef" value="midterm"');
  });

  it("shows the reason instead when it cannot start", () => {
    const html = panel(
      render(
        fixtureWorkspace({
          assessment: {
            ...FIXTURE_ASSESSMENT,
            attemptsUsed: 2,
            canStart: false,
            reason: "You have used every permitted attempt.",
          },
        }),
      ),
      "assessment",
    );
    expect(text(html)).not.toContain("Take Fixture Midterm");
    expect(text(html)).toContain("You have used every permitted attempt.");
    expect(text(html)).toContain("2 of 2 used");
  });

  it("resumes the active attempt instead of starting another", () => {
    const html = panel(
      render(
        fixtureWorkspace({
          assessment: {
            ...FIXTURE_ASSESSMENT,
            attemptsUsed: 1,
            activeAttemptId: "att-1",
          },
        }),
      ),
      "assessment",
    );
    expect(html).toContain('href="/student/academy/attempt/att-1"');
    expect(text(html)).toContain("Resume Fixture Midterm");
    expect(text(html)).not.toContain("Take Fixture Midterm");
  });

  it("never shows a score before release and has an empty state", () => {
    const plain = text(panel(render(), "assessment"));
    expect(plain).not.toMatch(/best score|\d+\s*\/\s*\d+|%|passed/i);
    expect(plain).toContain("Scores appear only after the window closes.");
    expect(
      text(panel(render(fixtureWorkspace({ assessment: null })), "assessment")),
    ).toContain("No assessment is scheduled for this course yet.");
  });
});

describe("Practical Lab", () => {
  it("disables Attend Practical Class when the learner cannot attend", () => {
    const html = panel(render(), "lab");
    expect(html).toMatch(
      /<button class="button" disabled="" aria-describedby="ln-lab-blocked">Attend Practical Class<\/button>/,
    );
    expect(text(html)).toContain("The practical opens at its scheduled start.");
  });

  it("enables it when the learner can attend and mounts the evidence slot", () => {
    const html = panel(
      render(
        fixtureWorkspace({
          lab: { ...FIXTURE_LAB, state: "OPEN", canAttend: true },
        }),
        {
          labEvidenceSlot: createElement(
            "p",
            null,
            "Fixture evidence upload slot",
          ),
        },
      ),
      "lab",
    );
    expect(html).toMatch(
      /<button class="button">Attend Practical Class<\/button>/,
    );
    expect(html).toContain('name="scheduleItemId" value="item-l"');
    expect(text(html)).toContain("Fixture evidence upload slot");
    expect(text(html)).toContain("Not submitted");
  });

  it("has an empty state", () => {
    expect(
      text(panel(render(fixtureWorkspace({ lab: null })), "lab")),
    ).toContain("No practical is scheduled for this course yet.");
  });
});

describe("results and progression", () => {
  it('says "No results to show yet." and links detailed progression', () => {
    const html = render();
    expect(text(panel(html, "results"))).toContain("No results to show yet.");
    const progression = panel(html, "progression");
    expect(text(progression)).toContain("2 of 12 classes");
    expect(progression).toContain('href="/student/courses/e-1/progression"');
  });

  it("lists this course's released results without a course column", () => {
    const html = panel(
      render(
        fixtureWorkspace({
          results: [
            {
              enrolmentId: "e-1",
              courseTitle: "Fixture Networking Course",
              assessmentRef: "quiz-1",
              assessmentTitle: "Fixture Quiz",
              kind: "QUIZ",
              releasedAt: "2026-11-01T12:00:00Z",
              bestScore: 8,
              maxScore: 10,
              attemptsUsed: 1,
              passed: null,
            },
          ],
        }),
      ),
      "results",
    );
    expect(text(html)).toContain("8 / 10");
    expect(text(html)).toContain("No pass mark");
    expect(html).not.toContain('<th scope="col">Course</th>');
  });
});
