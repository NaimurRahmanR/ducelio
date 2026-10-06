import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-6: Sarah's post-session feedback prompt and the admin teaching-quality
// view. Presentation only; the database decides eligibility and privacy
// (session-feedback-db.test.ts) and the server enforces roles
// (session-feedback.test.ts).
const mocks = vi.hoisted(() => ({
  actionState: null as Record<string, unknown> | null,
  feedback: null as unknown,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: (_action: unknown, initial: unknown) => [
      mocks.actionState ?? initial,
      () => undefined,
      false,
    ],
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/student/classes" }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/student/sarah/feedback-actions", () => ({
  submitSessionFeedbackAction: vi.fn(),
}));
vi.mock("@/components/support-forms", () => ({ SupportForms: () => null }));
vi.mock("@/server/session-feedback", () => ({
  listMySessionFeedbackOpportunities: async () => mocks.feedback,
}));
vi.mock("@/server/academy", () => ({
  getStudentAcademy: async () => ({
    actor: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    },
    enrolments: [],
    profile: null,
  }),
}));
vi.mock("@/server/class-sessions", () => ({
  getStudentClassSessions: async () => [],
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
  getStudyPlan: async () => null,
  getSupportFollowups: async () => [],
  getStudentSupportProfile: async () => null,
  getOpenSupportEvents: async () => [],
}));
vi.mock("@/server/professor-classroom", () => ({
  listMyProfessorClassroomSessionIds: async () => new Set<string>(),
}));

import {
  SarahSessionFeedback,
  submitSessionFeedback,
  type FeedbackPrompt,
} from "@/components/sarah-session-feedback";
import { TeachingQualityPanel } from "@/components/teaching-quality-panel";
import { LiveStudent } from "@/components/live-student";
import { adminSectionsForRoles } from "@/components/staff-shell";
import type { TeachingQualityPage } from "@/server/session-feedback";

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const prompt: FeedbackPrompt = {
  classSessionId: SESSION,
  requestId: REQUEST,
  lessonTitle: "Access Control Fundamentals — DEMO",
  cohortTitle: "September 2026 — DEMO",
  programmeTitle: "ISC2 CC — DEMO",
  instructorName: "Qualified teacher",
  scheduledStart: "2026-10-01T09:00:00+00:00",
  scheduledEnd: "2026-10-01T10:00:00+00:00",
};
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const text = (html: string) =>
  decode(
    html
      .replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
const fieldNames = (html: string) =>
  [...new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))].sort();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const render = (prompts: FeedbackPrompt[], showIdentity = false) =>
  renderToStaticMarkup(
    createElement(SarahSessionFeedback, { prompts, showIdentity }),
  );

beforeEach(() => {
  mocks.actionState = null;
  mocks.feedback = { status: "OK", opportunities: [] };
});

describe("Sarah session-feedback prompt", () => {
  it("comes from Sarah Mitchell, clearly AI, and asks exactly three 1-5 questions with no free text", () => {
    const html = render([prompt], true);
    const plain = text(html);
    expect(plain).toContain("Sarah Mitchell");
    expect(plain).toContain("Ducelio AI learner-success counsellor");
    expect(plain).toMatch(/\bAI\b/);
    expect(plain).toContain("How did that session go?");
    expect(plain).toContain("How clear was the session?");
    expect(plain).toContain("How was the pace for you?");
    expect(plain).toContain("How useful was the session for your learning?");
    expect(fieldNames(html)).toEqual([
      "clarityRating",
      "classSessionId",
      "paceRating",
      "requestId",
      "usefulnessRating",
    ]);
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    for (const field of ["clarityRating", "paceRating", "usefulnessRating"]) {
      const radios = inputs.filter(
        (x) => x.includes('type="radio"') && x.includes(`name="${field}"`),
      );
      expect(radios.map((x) => /value="(\d)"/.exec(x)?.[1])).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
      expect(radios.every((x) => x.includes("required"))).toBe(true);
    }
    expect(html).not.toMatch(/<textarea|type="text"|contenteditable/i);
    expect(plain).toContain("Send feedback");
  });

  it("shows the session, never internal ids, and states privacy honestly", () => {
    const html = render([prompt]);
    const plain = text(html);
    expect(plain).toContain("Access Control Fundamentals — DEMO");
    expect(plain).toContain("1 Oct 2026, 09:00 UTC");
    expect(plain).not.toMatch(UUID);
    expect(plain).toContain("only once at least 3 learners have answered");
    expect(plain).toContain(
      "never affects your grades, attendance or progress",
    );
    expect(plain).not.toMatch(
      /Sarah (has )?(reviewed|read)|instructor has seen|will (act|review|improve)|immediately/i,
    );
  });

  it("shows nothing to rate when no eligible session is listed", () => {
    const html = render([]);
    expect(text(html)).toContain(
      "No sessions are waiting for your feedback right now.",
    );
    expect(html).not.toContain("<form");
  });

  it("confirms a recorded submission and closes the prompt", () => {
    mocks.actionState = {
      result: { outcome: "RECORDED" },
      requestId: REQUEST,
    };
    const html = render([prompt]);
    expect(text(html)).toContain("Thanks — your feedback has been recorded.");
    expect(html).not.toContain("<form");
  });

  it("reports an already-submitted session and closes the prompt", () => {
    mocks.actionState = {
      result: { outcome: "ALREADY_SUBMITTED" },
      requestId: REQUEST,
    };
    const html = render([prompt]);
    expect(text(html)).toContain(
      "You have already shared feedback for this session.",
    );
    expect(html).not.toContain("<form");
  });

  it("keeps the prompt open after a recoverable failure, with no internal detail", () => {
    for (const outcome of ["UNAVAILABLE", "INVALID", "REQUEST_CONFLICT"]) {
      mocks.actionState = { result: { outcome }, requestId: REQUEST };
      const html = render([prompt]);
      expect(html).toContain("<form");
      const region = html.slice(html.indexOf('aria-live="polite"'));
      expect(text(region)).not.toMatch(/SQL|exception|FORBIDDEN|[0-9a-f]{8}-/);
    }
  });
});

describe("feedback request UUID rotation (hydration-safe)", () => {
  const previous = { result: {}, requestId: REQUEST };
  it("keeps the request UUID for every outcome except a resolved conflict", async () => {
    for (const outcome of ["RECORDED", "ALREADY_SUBMITTED", "UNAVAILABLE"]) {
      const next = await submitSessionFeedback(
        previous,
        new FormData(),
        async () => ({ outcome: outcome as "RECORDED" }),
        () => "fresh",
      );
      expect(next).toEqual({ result: { outcome }, requestId: REQUEST });
    }
    expect(
      await submitSessionFeedback(
        previous,
        new FormData(),
        async () => ({ outcome: "REQUEST_CONFLICT" }),
        () => "fresh",
      ),
    ).toEqual({ result: { outcome: "REQUEST_CONFLICT" }, requestId: "fresh" });
  });

  it("keeps the UUID after a transport failure, so a retry replays safely", async () => {
    expect(
      await submitSessionFeedback(
        previous,
        new FormData(),
        async () => {
          throw new Error("network");
        },
        () => "fresh",
      ),
    ).toEqual({ result: { outcome: "UNAVAILABLE" }, requestId: REQUEST });
  });
});

describe("classes view", () => {
  it("shows Sarah's prompt only for listed eligible sessions", async () => {
    mocks.feedback = { status: "OK", opportunities: [prompt] };
    const withPrompt = text(
      renderToStaticMarkup(await LiveStudent({ section: "classes" })),
    );
    expect(withPrompt).toContain("How did that session go?");
    expect(withPrompt).toContain("Sarah Mitchell");
    mocks.feedback = { status: "OK", opportunities: [] };
    const without = text(
      renderToStaticMarkup(await LiveStudent({ section: "classes" })),
    );
    expect(without).not.toContain("How did that session go?");
    mocks.feedback = { status: "UNAVAILABLE" };
    expect(
      text(renderToStaticMarkup(await LiveStudent({ section: "classes" }))),
    ).not.toContain("How did that session go?");
  });
});

describe("admin teaching quality", () => {
  const ok: TeachingQualityPage = {
    status: "OK",
    data: {
      minimumResponses: 3,
      offset: 0,
      hasMore: true,
      summary: {
        sessionCount: 2,
        responseCount: 5,
        scoredSessionCount: 1,
        scoredResponseCount: 3,
        clarityAverage: 4,
        paceAverage: 3.33,
        usefulnessAverage: 2.67,
      },
      rows: [
        {
          sessionId: SESSION,
          lessonTitle: "Scored lesson",
          cohortTitle: "Cohort A",
          instructorName: "Qualified teacher",
          programmeTitle: "Programme",
          versionLabel: "2026",
          scheduledStart: "2026-10-01T09:00:00+00:00",
          scheduledEnd: "2026-10-01T10:00:00+00:00",
          status: "COMPLETED",
          presentCount: 4,
          responseCount: 3,
          scoresAvailable: true,
          clarityAverage: 4,
          paceAverage: 3.33,
          usefulnessAverage: 2.67,
        },
        {
          sessionId: "33333333-3333-4333-8333-333333333333",
          lessonTitle: "Sparse lesson",
          cohortTitle: "Cohort A",
          instructorName: "Qualified teacher",
          programmeTitle: "Programme",
          versionLabel: "2026",
          scheduledStart: "2026-10-02T09:00:00+00:00",
          scheduledEnd: "2026-10-02T10:00:00+00:00",
          status: "SCHEDULED",
          presentCount: 2,
          responseCount: 2,
          scoresAvailable: false,
          clarityAverage: null,
          paceAverage: null,
          usefulnessAverage: null,
        },
      ],
    },
  };
  const panel = (page: TeachingQualityPage) =>
    renderToStaticMarkup(
      createElement(TeachingQualityPanel, {
        page,
        instructors: [{ user_id: SESSION, display_name: "Qualified teacher" }],
        cohorts: [{ id: SESSION, title: "Cohort A" }],
        filters: { tqCohortId: SESSION },
      }),
    );

  it("shows aggregate scores from 3 responses and hides them below", () => {
    const plain = text(panel(ok));
    expect(plain).toContain("Teaching quality");
    expect(plain).toContain("AGGREGATE ONLY");
    expect(plain).toContain("Scored lesson");
    expect(plain).toContain("4.00");
    expect(plain).toContain("3.33");
    expect(plain).toContain("2.67");
    const sparse = plain.slice(plain.indexOf("Sparse lesson"));
    expect(sparse).toContain("Insufficient responses for scores");
    expect(sparse).not.toMatch(/\d\.\d\d/);
    expect(plain).toContain(
      "Scores for a session appear only from 3 responses",
    );
  });

  it("never shows learner names, numbers, individual ratings or submission times", () => {
    const html = panel(ok);
    expect(text(html)).not.toMatch(
      /Alex Morgan|DUC-|student number|submitted at|learner id/i,
    );
    expect(fieldNames(html)).toEqual([
      "section",
      "tqCohortId",
      "tqFrom",
      "tqInstructorId",
      "tqUntil",
    ]);
    expect(html).toContain('href="/admin?section=Sessions&amp;tqCohortId=');
    expect(html).toContain("tqOffset=50");
  });

  it("degrades safely on invalid filters or an unavailable service", () => {
    expect(text(panel({ status: "INVALID_FILTERS" }))).toContain(
      "filters are not valid",
    );
    expect(text(panel({ status: "UNAVAILABLE" }))).toContain(
      "could not be loaded right now",
    );
  });

  it("is reachable only from the admin Sessions section, which only Academic and Platform Admin see", () => {
    for (const role of ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const)
      expect(adminSectionsForRoles([role])).toContain("Sessions");
    for (const role of [
      "INSTRUCTOR",
      "COUNSELLOR",
      "REGISTRAR",
      "STUDENT",
    ] as const)
      expect(adminSectionsForRoles([role])).not.toContain("Sessions");
    const page = readFileSync(resolve("src/app/admin/page.tsx"), "utf8");
    expect(page).toMatch(
      /section === "Sessions"\s*\?\s*await getTeachingQuality\(/,
    );
    expect(page).toMatch(/section === "Sessions" && teachingQuality/);
  });
});
