import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssessmentLeaderboard,
  CourseProgression,
  LearnerActivity,
  LearnerWeek,
  ReleasedResult,
} from "@/domain/learner-contract";

// Premium pass: every meaningful card opens a real destination (docs/61 §2).
// Rendered from typed fixtures; the routes themselves re-derive access.
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

import { WeekTimetable } from "@/components/learner/timetable-week";
import { ReleasedResultsTable } from "@/components/learner/results-table";
import { ProgressionCard } from "@/components/learner/progression";
import { LeaderboardsView } from "@/components/learner/leaderboards";
import {
  activityHref,
  activityStateClass,
} from "@/components/learner/learner-format";

const activity = (over: Partial<LearnerActivity>): LearnerActivity => ({
  itemId: `i-${over.kind ?? "LESSON"}`,
  enrolmentId: "e-1",
  courseTitle: "Fixture Course",
  provider: "Fixture Provider",
  kind: "LESSON",
  ref: "ref-1",
  title: `Fixture ${over.kind ?? "LESSON"}`,
  part: 1,
  parts: 1,
  startsAt: "2026-11-04T09:00:00Z",
  endsAt: "2026-11-04T10:00:00Z",
  opensAt: null,
  closesAt: null,
  state: "UPCOMING",
  ...over,
});

describe("timetable activity cards", () => {
  it("open each activity's own workspace panel, as one stretched link per card", () => {
    const week: LearnerWeek = {
      weekStart: "2026-11-02",
      timezone: "UTC",
      serverTime: "2026-11-04T08:00:00Z",
      activities: [
        activity({ kind: "LESSON", state: "OPEN" }),
        activity({ kind: "LAB" }),
        activity({ kind: "ASSESSMENT", state: "RELEASED" }),
        activity({ kind: "REVISION", state: "MISSED" }),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(WeekTimetable, { week, basePath: "/student" }),
    );
    for (const [kind, href] of [
      ["LESSON", "/student/courses/e-1#classroom"],
      ["LAB", "/student/courses/e-1#lab"],
      ["ASSESSMENT", "/student/courses/e-1#assessment"],
      ["REVISION", "/student/courses/e-1"],
    ])
      expect(html).toContain(
        `<a href="${href}" class="ln-clickable__link">Fixture ${kind}</a>`,
      );
    expect(html.match(/ln-clickable__link/g)).toHaveLength(4);
    // Colour is never the only signal: the kind and state are written.
    for (const label of ["Class", "Practical", "Assessment", "Revision"])
      expect(html).toContain(`<p class="ln-activity__kind">${label}</p>`);
    expect(html).toContain("Open now");
    expect(html).toContain("Results released");
  });

  it("maps states to their visual treatment without inventing any", () => {
    expect(activityStateClass("OPEN")).toBe("is-open");
    expect(activityStateClass("RELEASED")).toBe("is-done");
    expect(activityStateClass("MISSED")).toBe("is-past");
    expect(activityStateClass("UPCOMING")).toBe("");
    expect(activityHref({ enrolmentId: "a b", kind: "LAB" })).toBe(
      "/student/courses/a%20b#lab",
    );
  });
});

describe("released results", () => {
  const result = (over: Partial<ReleasedResult> = {}): ReleasedResult => ({
    enrolmentId: "e-1",
    courseTitle: "Fixture Course",
    assessmentRef: "quiz-1",
    assessmentTitle: "Fixture Quiz",
    kind: "QUIZ",
    releasedAt: "2026-11-01T12:00:00Z",
    bestScore: 7,
    maxScore: 10,
    attemptsUsed: 1,
    passed: null,
    reviewAttemptId: "11111111-1111-4111-8111-111111111111",
    ...over,
  });

  it("open the learner's own released review, and only when one exists", () => {
    const html = renderToStaticMarkup(
      createElement(ReleasedResultsTable, {
        results: [
          result(),
          result({
            assessmentRef: "quiz-2",
            assessmentTitle: "Unattempted Quiz",
            reviewAttemptId: null,
          }),
        ],
        caption: "Fixture results",
      }),
    );
    expect(html).toContain(
      'href="/student/academy/attempt/11111111-1111-4111-8111-111111111111"',
    );
    expect(html.match(/class="ln-rowlink"/g)).toHaveLength(1);
    expect(html).toContain("Not attempted");
  });
});

describe("progression cards", () => {
  const progression: CourseProgression = {
    enrolmentId: "e-1",
    classes: { total: 4, attended: 1, missed: 0 },
    objectives: { total: 2, demonstrated: 0 },
    practicals: { total: 1, submitted: 0, graded: 0 },
    assessments: { total: 1, released: 0 },
    completion: { completed: false, completedAt: null },
  };
  it("open detailed progression when a destination is given, otherwise stay static", () => {
    const linked = renderToStaticMarkup(
      createElement(ProgressionCard, {
        course: { title: "Fixture Course", provider: "Fixture Provider" },
        progression,
        detailsHref: "/student/courses/e-1/progression",
      }),
    );
    expect(linked).toContain("ln-progress-card ln-clickable");
    expect(linked).toContain(
      'href="/student/courses/e-1/progression" class="ln-go ln-clickable__link"',
    );
    const plain = renderToStaticMarkup(
      createElement(ProgressionCard, {
        course: { title: "Fixture Course", provider: "Fixture Provider" },
        progression,
      }),
    );
    expect(plain).not.toContain("ln-clickable");
    expect(plain).not.toContain("<a ");
  });
});

describe("leaderboards", () => {
  it("show medal ranks with their numbers and the learner's own position", () => {
    const board: AssessmentLeaderboard = {
      courseTitle: "Fixture Course",
      assessmentRef: "quiz-1",
      assessmentTitle: "Fixture Quiz",
      month: "2026-11",
      entries: [
        {
          rank: 1,
          label: "Learner 7",
          bestScore: 9,
          maxScore: 10,
          isMe: false,
        },
        { rank: 2, label: "You", bestScore: 8, maxScore: 10, isMe: true },
        {
          rank: 3,
          label: "Learner 2",
          bestScore: 7,
          maxScore: 10,
          isMe: false,
        },
        {
          rank: 4,
          label: "Learner 9",
          bestScore: 6,
          maxScore: 10,
          isMe: false,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(LeaderboardsView, { boards: [board], month: "2026-11" }),
    );
    expect(html).toContain('<span class="ln-rank ln-rank--1">1</span>');
    expect(html).toContain('<span class="ln-rank ln-rank--3">3</span>');
    expect(html).toContain('<span class="ln-rank">4</span>');
    expect(html).toContain("Your position: 2nd");
    expect(html).not.toContain("learner-");
  });
});
