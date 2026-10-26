import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AssessmentLeaderboard,
  ClassEvidence,
  LearnerActivity,
  LearnerCourse,
  LearnerWeek,
} from "@/domain/learner-contract";

// My Learning, My Timetable, Leaderboards and Support & Feedback views
// (docs/61 §2), rendered from typed fixtures.
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

import { MyLearningView } from "@/components/learner/my-learning";
import { TimetableWeekView } from "@/components/learner/timetable-week";
import { LeaderboardsView } from "@/components/learner/leaderboards";
import {
  SUPPORT_DELIVERY_TEXT,
  SupportFormView,
} from "@/components/learner/support-form";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const course = (over: Partial<LearnerCourse> = {}): LearnerCourse => ({
  enrolmentId: "e-1",
  courseId: "c-1",
  title: "Fixture Networking Course",
  provider: "Fixture Provider",
  status: "ACTIVE",
  scheduled: true,
  accessRevoked: false,
  ...over,
});

describe("My Learning", () => {
  it("renders one full-width row per course, each wholly a link to its workspace", () => {
    const html = renderToStaticMarkup(
      createElement(MyLearningView, {
        courses: [
          course(),
          course({
            enrolmentId: "e-2",
            title: "Fixture Security Course",
            provider: "Fixture Org",
            status: "COMPLETED",
          }),
          course({
            enrolmentId: "e-3",
            title: "Fixture Unscheduled",
            scheduled: false,
          }),
          course({
            enrolmentId: "e-4",
            title: "Fixture Revoked",
            accessRevoked: true,
          }),
        ],
      }),
    );
    const rows = [
      ...html.matchAll(
        /<li><a href="([^"]+)" class="ln-course-row">(.*?)<\/a><\/li>/g,
      ),
    ];
    expect(rows.map((r) => r[1])).toEqual([
      "/student/courses/e-1",
      "/student/courses/e-2",
      "/student/courses/e-3",
      "/student/courses/e-4",
    ]);
    expect(text(rows[0][2])).toContain("Fixture Networking Course");
    expect(text(rows[0][2])).toContain("Fixture Provider");
    expect(text(rows[0][2])).toContain("Active");
    expect(text(rows[1][2])).toContain("Completed");
    expect(text(rows[2][2])).toContain("Awaiting timetable");
    expect(text(rows[3][2])).toContain("Access ended");
  });

  it("has an empty state with Browse Courses", () => {
    const html = renderToStaticMarkup(
      createElement(MyLearningView, { courses: [] }),
    );
    expect(text(html)).toContain("No courses yet");
    expect(html).toContain('href="/courses"');
    expect(text(html)).toContain("Browse Courses");
  });
});

function activity(
  id: string,
  startsAt: string,
  over: Partial<LearnerActivity> = {},
): LearnerActivity {
  return {
    itemId: id,
    enrolmentId: "e-1",
    courseTitle: "Fixture Networking Course",
    provider: "Fixture Provider",
    kind: "LESSON",
    ref: id,
    title: `Fixture class ${id}`,
    part: 1,
    parts: 1,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(),
    opensAt: startsAt,
    closesAt: null,
    state: "UPCOMING",
    ...over,
  };
}

const WEEK: LearnerWeek = {
  weekStart: "2026-11-02",
  timezone: "UTC",
  serverTime: "2026-11-05T12:00:00Z",
  activities: [
    activity("a1", "2026-11-02T09:00:00Z", { state: "ATTENDED" }),
    activity("a2", "2026-11-03T09:00:00Z", { state: "MISSED" }),
    activity("a3", "2026-11-04T09:00:00Z", {
      enrolmentId: "e-2",
      courseTitle: "Fixture Security Course",
    }),
  ],
};
const EVIDENCE: Record<string, ClassEvidence> = {
  a1: {
    checkedInAt: "2026-11-02T09:03:00Z",
    correctInClassAnswers: 4,
    lessonObjectives: [
      { ref: "o1", title: "Fixture objective one", covered: true },
      { ref: "o2", title: "Fixture objective two", covered: false },
    ],
    topicsCovered: ["Fixture topic A"],
  },
};

describe("My Timetable", () => {
  const render = (courseFilter: string | null = null) =>
    renderToStaticMarkup(
      createElement(TimetableWeekView, {
        week: WEEK,
        courses: [
          course(),
          course({ enrolmentId: "e-2", title: "Fixture Security Course" }),
        ],
        courseFilter,
        evidence: EVIDENCE,
      }),
    );

  it("expands an attended class into its evidence, worded as attendance and coverage, not mastery", () => {
    const html = render();
    const details = html.slice(
      html.indexOf('<details class="ln-evidence">'),
      html.indexOf("</details>"),
    );
    const plain = text(details);
    expect(plain).toContain("Class details");
    expect(plain).toMatch(/Mon,? 2 Nov 2026, 09:00 to 10:00/);
    expect(plain).toContain("Fixture Networking Course · Fixture Provider");
    expect(plain).toContain("Attended (checked in 09:03)");
    expect(plain).toContain("Correct in-class answers 4");
    expect(plain).toContain("1 of 2 covered");
    expect(plain).toContain("Fixture objective one (covered)");
    expect(plain).toContain("Fixture objective two (not covered)");
    expect(plain).toContain("Neither is a mark or mastery");
    expect(plain).not.toMatch(/\bMastered\b/);
    // Only the attended class has an expandable record.
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(text(html)).toContain("A missed class is never marked completed.");
  });

  it("filters by course and keeps the filter across week links", () => {
    const html = render("e-2");
    expect(text(html)).toContain("Fixture class a3");
    expect(text(html)).not.toContain("Fixture class a1");
    expect(html).toContain(
      'href="/student/timetable?week=2026-10-26&amp;course=e-2"',
    );
    expect(html).toContain(
      'href="/student/timetable?week=2026-11-09&amp;course=e-2"',
    );
    expect(html).toMatch(/<select id="ln-course-filter" name="course">/);
    expect(html).toContain('<option value="e-2" selected="">');
  });

  it("ignores a filter for a course that is not the learner's", () => {
    const html = render("someone-else");
    expect(text(html)).toContain("Fixture class a1");
    expect(text(html)).toContain("Fixture class a3");
  });

  it("explains an empty or unavailable timetable", () => {
    expect(
      text(
        renderToStaticMarkup(
          createElement(TimetableWeekView, { week: WEEK, courses: [] }),
        ),
      ),
    ).toContain("No timetable yet");
    expect(
      text(
        renderToStaticMarkup(
          createElement(TimetableWeekView, { week: null, courses: [course()] }),
        ),
      ),
    ).toContain("could not be loaded");
  });
});

function board(
  assessmentRef: string,
  month: string,
  entries: AssessmentLeaderboard["entries"],
  courseTitle = "Fixture Networking Course",
): AssessmentLeaderboard {
  return {
    courseTitle,
    assessmentRef,
    assessmentTitle: `Fixture ${assessmentRef}`,
    month,
    entries,
  };
}

describe("Leaderboards", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    rank: i + 1,
    label: i === 2 ? "You" : `Learner ${String.fromCharCode(65 + i)}`,
    bestScore: 100 - i * 5,
    maxScore: 100,
    isMe: i === 2,
  }));
  const boards = [
    board("quiz-1", "2026-10", entries),
    board("quiz-2", "2026-10", [], "Fixture Security Course"),
    board("quiz-1", "2026-09", entries.slice(0, 3)),
  ];

  it("shows the latest month by default, per course and assessment, top 10 with You highlighted", () => {
    const html = renderToStaticMarkup(
      createElement(LeaderboardsView, { boards }),
    );
    expect(html).toContain('<option value="2026-10" selected="">');
    const plain = text(html);
    expect(plain).toContain("Fixture Networking Course");
    expect(plain).toContain("Fixture Security Course");
    expect(plain).toContain("Top 10 for Fixture quiz-1, October 2026");
    expect(html.match(/<tr class="is-me" aria-current="true">/g)).toHaveLength(
      1,
    );
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(rows.match(/<tr/g)).toHaveLength(10);
    expect(text(rows)).toContain("90 / 100");
    expect(plain).toContain("No released scores for October 2026 yet.");
  });

  it("switches month", () => {
    const html = renderToStaticMarkup(
      createElement(LeaderboardsView, { boards, month: "2026-09" }),
    );
    expect(html).toContain('<option value="2026-09" selected="">');
    expect(text(html)).toContain("Top 3 for Fixture quiz-1, September 2026");
    expect(text(html)).not.toContain("Fixture Security Course");
  });

  it("has an empty state", () => {
    const plain = text(
      renderToStaticMarkup(createElement(LeaderboardsView, { boards: [] })),
    );
    expect(plain).toContain("No leaderboards yet");
  });
});

describe("Support & Feedback", () => {
  it("asks for a category, subject, message and an optional course", () => {
    const html = renderToStaticMarkup(
      createElement(SupportFormView, {
        courses: [course()],
        sendSupportAction: vi.fn(async () => ({})),
      }),
    );
    expect(html).toMatch(
      /<select id="ln-support-category" name="category" required="">/,
    );
    expect(html).toMatch(/<select id="ln-support-course" name="enrolmentId">/);
    expect(html).toContain(
      '<option value="" selected="">Not about a specific course</option>',
    );
    expect(html).toMatch(
      /<input id="ln-support-subject"(?=[^>]*name="subject")(?=[^>]*required="")/,
    );
    expect(html).toMatch(
      /<textarea id="ln-support-message" name="message" required=""/,
    );
    expect(text(html)).toContain("Send message");
  });

  it("never reports a queued message as sent", () => {
    expect(SUPPORT_DELIVERY_TEXT.QUEUED).toMatch(/pending/);
    expect(SUPPORT_DELIVERY_TEXT.QUEUED).not.toMatch(/was sent/);
    expect(SUPPORT_DELIVERY_TEXT.FAILED).toMatch(/could not be delivered/);
  });
});
