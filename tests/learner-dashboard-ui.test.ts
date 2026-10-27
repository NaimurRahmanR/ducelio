import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityKind,
  ActivityState,
  CourseProgression,
  LearnerActivity,
  LearnerCourse,
  LearnerWeek,
  ReleasedResult,
} from "@/domain/learner-contract";

// The learner dashboard (docs/61 §2): four rows rendered from typed
// projections. Test fixtures only; the views never hold data of their own.
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
const sarah = vi.hoisted(() => ({ askSarahAction: vi.fn() }));
vi.mock("@/app/student/sarah/actions", () => ({
  askSarahAction: sarah.askSarahAction,
  decideSarahProposalAction: vi.fn(),
}));

import { LearnerDashboardView } from "@/components/learner/dashboard";
import {
  nextSarahChatState,
  type SarahChatState,
} from "@/components/learner/sarah-compact-chat";
import { groupByDay } from "@/components/learner/learner-format";

const FIXTURE_COURSE: LearnerCourse = {
  enrolmentId: "e-1",
  courseId: "c-1",
  title: "Fixture Networking Course",
  provider: "Fixture Provider",
  status: "ACTIVE",
  scheduled: true,
  accessRevoked: false,
};
const FIXTURE_COURSE_2: LearnerCourse = {
  ...FIXTURE_COURSE,
  enrolmentId: "e-2",
  courseId: "c-2",
  title: "Fixture Security Course",
};

let seq = 0;
function fixtureActivity(
  day: string,
  hour: number,
  kind: ActivityKind = "LESSON",
  state: ActivityState = "UPCOMING",
  course: LearnerCourse = FIXTURE_COURSE,
): LearnerActivity {
  seq += 1;
  const start = `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
  const end = `${day}T${String(hour + 1).padStart(2, "0")}:00:00Z`;
  return {
    itemId: `item-${seq}`,
    enrolmentId: course.enrolmentId,
    courseTitle: course.title,
    provider: course.provider,
    kind,
    ref: `ref-${seq}`,
    title: `Fixture activity ${seq}`,
    part: 1,
    parts: 1,
    startsAt: start,
    endsAt: end,
    opensAt: start,
    closesAt: null,
    state,
  };
}

// Fourteen activities over all seven days, five on one day, two courses.
function fixtureWeek(): LearnerWeek {
  seq = 0;
  const days = [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-07",
    "2026-11-08",
  ];
  const activities = [
    ...days.map((d) => fixtureActivity(d, 9)),
    fixtureActivity("2026-11-04", 11, "LAB", "OPEN"),
    fixtureActivity("2026-11-04", 13, "ASSESSMENT", "SUBMITTED"),
    fixtureActivity("2026-11-04", 15, "REVISION", "UPCOMING"),
    fixtureActivity("2026-11-04", 17, "LESSON", "UPCOMING", FIXTURE_COURSE_2),
    fixtureActivity("2026-11-06", 12, "LESSON", "MISSED", FIXTURE_COURSE_2),
    fixtureActivity("2026-11-06", 14, "LESSON", "ATTENDED"),
    fixtureActivity("2026-11-08", 18, "ASSESSMENT", "RELEASED"),
  ];
  return {
    weekStart: "2026-11-02",
    timezone: "UTC",
    serverTime: "2026-11-04T10:00:00Z",
    // Deliberately unsorted: the view orders by start time.
    activities: activities.reverse(),
  };
}

const FIXTURE_PROGRESSION: CourseProgression = {
  enrolmentId: "e-1",
  classes: { total: 10, attended: 4, missed: 1 },
  objectives: { total: 20, demonstrated: 5 },
  practicals: { total: 4, submitted: 2, graded: 1 },
  assessments: { total: 3, released: 1 },
  completion: { completed: false, completedAt: null },
};

const FIXTURE_RESULT: ReleasedResult = {
  enrolmentId: "e-1",
  courseTitle: FIXTURE_COURSE.title,
  assessmentRef: "quiz-1",
  assessmentTitle: "Fixture Quiz One",
  kind: "QUIZ",
  releasedAt: "2026-11-01T12:00:00Z",
  bestScore: 72,
  maxScore: 100,
  attemptsUsed: 2,
  passed: true,
  reviewAttemptId: "a-1",
};

type Props = Parameters<typeof LearnerDashboardView>[0];
const render = (overrides: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(LearnerDashboardView, {
      courses: [FIXTURE_COURSE, FIXTURE_COURSE_2],
      nextActivity: fixtureActivity("2026-11-04", 11, "LAB", "OPEN"),
      week: fixtureWeek(),
      progressions: [
        { course: FIXTURE_COURSE, progression: FIXTURE_PROGRESSION },
      ],
      results: [FIXTURE_RESULT],
      sarahIdempotencyKey: "00000000-0000-4000-8000-000000000001",
      ...overrides,
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const panelRow = (html: string, row: string) => {
  const start = html.indexOf(`data-row="${row}"`);
  const next = html.indexOf("data-row=", start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
const panel = (html: string, name: string) => {
  const start = html.indexOf(`data-panel="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("data-panel=", start + 10);
  return html.slice(start, next === -1 ? undefined : next);
};

beforeEach(() => {
  sarah.askSarahAction.mockReset();
});

describe("dashboard layout", () => {
  it("renders exactly four rows in order", () => {
    const html = render();
    const rows = [...html.matchAll(/data-row="(\d)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["1", "2", "3", "4"]);
    const row1 = html.slice(
      html.indexOf('data-row="1"'),
      html.indexOf('data-row="2"'),
    );
    expect(row1.indexOf('data-panel="sarah"')).toBeLessThan(
      row1.indexOf('data-panel="next-activity"'),
    );
    const row3 = html.slice(
      html.indexOf('data-row="3"'),
      html.indexOf('data-row="4"'),
    );
    expect(row3.indexOf('data-panel="timetable"')).toBeLessThan(
      row3.indexOf('data-panel="progression"'),
    );
    expect(html.slice(html.indexOf('data-row="4"'))).toContain(
      'data-panel="results"',
    );
  });

  it("shows the Explore more courses banner only to a learner with a course", () => {
    // The whole banner is one link to Browse Courses, with a solid indigo
    // call to action inside it (decorative; the link carries the name).
    const html = render();
    expect(html).toContain(
      '<a href="/courses" class="ln-explore ln-clickable">',
    );
    expect(text(panelRow(html, "2"))).toContain("Explore More Courses");
    const none = render({ courses: [], progressions: [], results: [] });
    expect(none).not.toContain('data-row="2"');
    expect(none).not.toContain("Explore more courses");
  });
});

describe("Sarah compact panel", () => {
  it("keeps Sarah's AI identity and privacy notice, with an accessible expand control", () => {
    const html = panel(render(), "sarah");
    const plain = text(html);
    expect(plain).toContain("Sarah Mitchell");
    expect(plain).toContain(
      "Sarah is AI. She is not a human member of staff and not your assigned counsellor.",
    );
    expect(plain).toContain("Your message and her reply are not saved");
    expect(html).toMatch(
      /<button type="button" class="ln-iconbutton" aria-label="Open Sarah full screen" aria-expanded="false">/,
    );
    expect(html).toContain('title="Double-click to open Sarah full screen"');
    expect(html).toContain(
      'name="idempotencyKey" value="00000000-0000-4000-8000-000000000001"',
    );
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
  });

  it("keeps one conversation across exchanges, rotating the key only once resolved", async () => {
    const start: SarahChatState = {
      idempotencyKey: "k-0",
      exchanges: [],
    };
    const form = (message: string) => {
      const f = new FormData();
      f.set("message", message);
      f.set("intent", "GUIDE");
      return f;
    };
    sarah.askSarahAction.mockResolvedValueOnce({
      status: "SUCCEEDED",
      reply: "First reply",
      proposal: "NONE",
    });
    const one = await nextSarahChatState(start, form("Hello"));
    expect(one.exchanges).toHaveLength(1);
    expect(one.exchanges[0]).toMatchObject({
      message: "Hello",
      result: { status: "SUCCEEDED", reply: "First reply" },
    });
    expect(one.idempotencyKey).not.toBe("k-0");
    sarah.askSarahAction.mockRejectedValueOnce(new Error("transport"));
    const two = await nextSarahChatState(one, form("Again"));
    expect(two.exchanges.map((x) => x.message)).toEqual(["Hello", "Again"]);
    expect(two.exchanges[1].result).toEqual({ status: "RETRY_LATER" });
    // An unresolved request keeps its key, so a retry stays a duplicate.
    expect(two.idempotencyKey).toBe(one.idempotencyKey);
  });
});

describe("next activity", () => {
  it("shows title, course, provider, date, time, state and an access action", () => {
    const html = panel(render(), "next-activity");
    const plain = text(html);
    expect(plain).toContain("Fixture Networking Course · Fixture Provider");
    expect(plain).toMatch(/Wed,? 4 Nov 2026/);
    expect(plain).toContain("11:00 to 12:00");
    expect(plain).toContain("Open now");
    // The whole card opens the activity's own workspace panel.
    expect(render()).toContain(
      'class="ln-panel ln-next ln-accented ln-clickable ln-tone-teal"',
    );
    expect(html).toContain(
      '<a href="/student/courses/e-1#lab" class="ln-cta ln-clickable__link">',
    );
    expect(plain).toContain("Open Practical Lab");
  });

  it("offers Browse Courses when nothing is next", () => {
    const html = panel(render({ nextActivity: null }), "next-activity");
    expect(text(html)).toContain("Nothing scheduled next");
    expect(html).toContain(
      '<a href="/courses" class="button">Browse Courses</a>',
    );
    const fresh = panel(
      render({ nextActivity: null, courses: [], progressions: [] }),
      "next-activity",
    );
    expect(fresh).toContain('href="/courses"');
    expect(fresh).not.toContain('href="/student/learning"');
  });
});

describe("weekly timetable", () => {
  it("renders all seven days and every activity, with none truncated", () => {
    const week = fixtureWeek();
    expect(week.activities.length).toBeGreaterThan(10);
    const html = panel(render({ week }), "timetable");
    expect(html.match(/<li class="ln-day( is-today)?">/g)).toHaveLength(7);
    expect(html.match(/<li class="ln-activity /g)).toHaveLength(
      week.activities.length,
    );
    for (const a of week.activities) expect(html).toContain(`>${a.title}<`);
    const plain = text(html);
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ])
      expect(plain).toContain(day);
    expect(plain).toContain(`${week.activities.length} activities`);
    expect(plain).toContain("Fixture Security Course");
    expect(html).toContain("is-today");
  });

  it("lists several activities on one day in start order", () => {
    const week = fixtureWeek();
    const { days } = groupByDay(week.weekStart, week.timezone, week.activities);
    const wednesday = days[2];
    expect(wednesday.activities.map((a) => a.startsAt.slice(11, 16))).toEqual([
      "09:00",
      "11:00",
      "13:00",
      "15:00",
      "17:00",
    ]);
  });

  it("links the previous, current and next weeks", () => {
    const html = panel(render(), "timetable");
    expect(html).toContain('href="/student?week=2026-10-26"');
    expect(html).toContain('href="/student"');
    expect(html).toContain('href="/student?week=2026-11-09"');
  });

  it("never shows a score on the timetable, released or not", () => {
    const html = panel(render(), "timetable");
    const plain = text(html);
    expect(plain).toContain("Submitted, results not released");
    expect(plain).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(plain).not.toMatch(/score|%/i);
  });

  it("explains an empty or unavailable timetable", () => {
    expect(
      text(panel(render({ courses: [], progressions: [] }), "timetable")),
    ).toContain("No timetable yet");
    expect(text(panel(render({ week: null }), "timetable"))).toContain(
      "Your timetable could not be loaded",
    );
  });
});

describe("course progression", () => {
  it("shows counts and ratio bars of real counts only", () => {
    const html = panel(render(), "progression");
    const plain = text(html);
    expect(plain).toContain("4 of 10 classes");
    expect(plain).toContain("1 missed");
    expect(plain).toContain("5 of 20 objectives");
    expect(plain).toContain("2 of 4 practicals");
    expect(plain).toContain("1 of 3 assessments");
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('aria-valuetext="4 of 10 classes"');
    expect(html).toContain('href="/student/courses/e-1/progression"');
  });

  it("draws no bar when there is nothing to count", () => {
    const empty: CourseProgression = {
      ...FIXTURE_PROGRESSION,
      classes: { total: 0, attended: 0, missed: 0 },
      objectives: { total: 0, demonstrated: 0 },
      practicals: { total: 0, submitted: 0, graded: 0 },
      assessments: { total: 0, released: 0 },
    };
    const html = panel(
      render({
        progressions: [{ course: FIXTURE_COURSE, progression: empty }],
      }),
      "progression",
    );
    expect(html).not.toContain('role="progressbar"');
    expect(text(html)).toContain("None scheduled yet");
  });
});

describe("released results", () => {
  it("lists released results in a captioned table", () => {
    const html = panel(render(), "results");
    expect(html).toContain("<caption>");
    expect(html).toContain('<th scope="col">Best score</th>');
    const plain = text(html);
    expect(plain).toContain("Fixture Quiz One");
    expect(plain).toContain("72 / 100");
    expect(plain).toContain("Passed");
  });

  it('says "No results to show yet." when there are none', () => {
    const html = panel(render({ results: [] }), "results");
    expect(text(html)).toContain("No results to show yet.");
    expect(html).not.toContain("<table");
  });
});
