import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LR-BASELINE-01 (corrects PR #65): the learner Calendar, class times and
// the Results bridge, rendered through the real LiveStudent and
// AcademyShell. Only the learner's own server projections are stubbed.
const mocks = vi.hoisted(() => ({
  pathname: "/student/calendar",
  timezone: "America/New_York" as string,
  sessions: [] as unknown[],
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/student/sarah/feedback-actions", () => ({
  submitSessionFeedbackAction: vi.fn(),
}));
vi.mock("@/components/support-forms", () => ({ SupportForms: () => null }));
vi.mock("@/server/session-feedback", () => ({
  listMySessionFeedbackOpportunities: async () => ({
    status: "OK",
    opportunities: [],
  }),
}));
vi.mock("@/server/academy", () => ({
  getStudentAcademy: async () => ({
    actor: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    },
    enrolments: [],
    profile: { student_number: "S-0001", timezone: mocks.timezone },
  }),
}));
vi.mock("@/server/class-sessions", () => ({
  getStudentClassSessions: async () => mocks.sessions,
}));
vi.mock("@/server/attendance", () => ({
  getStudentAttendance: async () => [],
}));
vi.mock("@/server/lesson-progress", () => ({
  getStudentLessonProgress: async () => [],
}));
vi.mock("@/server/learning-resources", () => ({
  getStudentLearningResources: async () => [],
}));
vi.mock("@/server/learning-evidence", () => ({
  getStudentLearningEvidence: async () => [],
}));
vi.mock("@/server/objective-mastery", () => ({
  getStudentObjectiveMastery: async () => [],
}));
vi.mock("@/server/support", () => ({
  getAssignedCounsellor: async () => null,
  getStudyPlan: async () => ({ plan: null, items: [] }),
  getSupportFollowups: async () => [],
  getStudentSupportProfile: async () => null,
  getOpenSupportEvents: async () => [],
}));
vi.mock("@/server/professor-classroom", () => ({
  listMyProfessorClassroomSessionIds: async () => new Set<string>(),
}));

import { LiveStudent } from "@/components/live-student";
import { AcademyShell } from "@/components/academy-shell";
import { learnerRangeParts } from "@/domain/learner-time";

const session = (
  id: string,
  lesson: string,
  start: string,
  end: string,
  status = "SCHEDULED",
) => ({
  id,
  scheduled_start: start,
  scheduled_end: end,
  status,
  cohort_title: "Autumn cohort",
  lesson_title: lesson,
  instructor_name: "Qualified teacher",
  instructor_title: null,
  programme_title: "Example programme",
  programme_version_label: "Edition 1",
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const render = async (section: string) =>
  renderToStaticMarkup(await LiveStudent({ section }));

beforeEach(() => {
  mocks.pathname = "/student/calendar";
  mocks.timezone = "America/New_York";
  mocks.sessions = [
    session(
      "11111111-1111-4111-8111-000000000001",
      "Past lesson A",
      "2020-03-02T14:00:00Z",
      "2020-03-02T15:00:00Z",
    ),
    session(
      "11111111-1111-4111-8111-000000000002",
      "Later lesson",
      "2031-01-20T14:00:00Z",
      "2031-01-20T15:00:00Z",
    ),
    session(
      "11111111-1111-4111-8111-000000000003",
      "Sooner lesson",
      "2030-01-15T14:00:00Z",
      "2030-01-15T15:00:00Z",
    ),
    session(
      "11111111-1111-4111-8111-000000000004",
      "Past lesson B",
      "2021-03-02T14:00:00Z",
      "2021-03-02T15:00:00Z",
      "CANCELLED",
    ),
  ];
});

describe("learner calendar", () => {
  it("is an implemented agenda, not the later-milestone placeholder", async () => {
    const plain = text(await render("calendar"));
    expect(plain).toContain("Class calendar");
    expect(plain).not.toContain("planned for a later academy milestone");
    expect(await render("calendar")).toContain('href="/student/classes"');
  });

  it("lists upcoming classes soonest first, then past classes most recent first", async () => {
    const plain = text(await render("calendar"));
    const order = [
      "Upcoming",
      "Sooner lesson",
      "Later lesson",
      "Past",
      "Past lesson B",
      "Past lesson A",
    ].map((label) => plain.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(plain).toContain("CANCELLED");
  });

  it("marks up start and end as two machine-readable instants", async () => {
    const html = await render("calendar");
    expect(html).toContain(
      '<time dateTime="2030-01-15T14:00:00.000Z">15 Jan 2030, 09:00</time>',
    );
    expect(html).toContain(
      '<time dateTime="2030-01-15T15:00:00.000Z">10:00</time>',
    );
    // No single <time> claims the whole range as one instant.
    expect(html).not.toMatch(/<time[^>]*>[^<]*–[^<]*<\/time>/);
  });

  it("shows times in the learner's profile time zone", async () => {
    const plain = text(await render("calendar"));
    expect(plain).toContain(
      "Times are shown in your profile time zone (America/New_York).",
    );
    expect(plain).toContain("15 Jan 2030, 09:00 – 10:00");
  });

  it("falls back to UTC, and says so, for an unusable profile time zone", async () => {
    mocks.timezone = "Not/AZone";
    const plain = text(await render("calendar"));
    expect(plain).toContain(
      "Times are shown in UTC because your profile time zone could not be used.",
    );
    expect(plain).toContain("15 Jan 2030, 14:00 – 15:00");
  });

  it("shows an empty state with no sessions", async () => {
    mocks.sessions = [];
    expect(text(await render("calendar"))).toContain(
      "No class sessions scheduled",
    );
  });
});

describe("learner classes", () => {
  it("uses the same profile time zone as the calendar", async () => {
    mocks.pathname = "/student/classes";
    const plain = text(await render("classes"));
    expect(plain).toContain("15 Jan 2030, 09:00 – 10:00");
    expect(plain).toContain("Starts at 15 Jan 2030, 09:00");
  });
});

describe("learner results", () => {
  it("separates formal graded results from objective mastery", async () => {
    mocks.pathname = "/student/results";
    const html = await render("results");
    const plain = text(html);
    expect(plain).toContain("Formal assessment results");
    expect(html).toContain('href="/student/progress"');
    expect(plain.indexOf("Formal assessment results")).toBeLessThan(
      plain.indexOf("Your mastery"),
    );
  });
});

describe("learner shell breadcrumb", () => {
  it.each([
    ["/student/calendar", "Calendar"],
    ["/student/tutor-notes", "Tutor notes"],
    ["/student/classroom/11111111-1111-4111-8111-000000000001", "Classroom"],
    ["/student/study-plan", "Study plan"],
    ["/student/unknown", "My academy"],
  ])("names %s as %s", (pathname, label) => {
    mocks.pathname = pathname;
    const html = renderToStaticMarkup(
      createElement(
        AcademyShell,
        { name: "Alex Morgan" } as Parameters<typeof AcademyShell>[0],
        null,
      ),
    );
    expect(html).toContain(`<strong>${label}</strong>`);
  });
});

describe("learner time range", () => {
  it("repeats the date when a class ends on another day in the learner's zone", () => {
    expect(
      learnerRangeParts("2030-01-15T23:30:00Z", "2030-01-16T00:30:00Z", "UTC"),
    ).toEqual({ start: "15 Jan 2030, 23:30", end: "16 Jan 2030, 00:30" });
    expect(
      learnerRangeParts("2030-01-15T14:00:00Z", "2030-01-15T15:00:00Z", "UTC"),
    ).toEqual({ start: "15 Jan 2030, 14:00", end: "15:00" });
  });
});
