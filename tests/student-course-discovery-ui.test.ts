import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Course discovery and the AI learning team inside the signed-in academy,
// rendered through the real LiveStudent and AcademyShell. Only the learner's
// own server projections are stubbed.
const mocks = vi.hoisted(() => ({
  pathname: "/student",
  enrolments: [] as unknown[],
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => createElement("a", { href, className }, children),
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
    enrolments: mocks.enrolments,
    profile: { student_number: "S-0001", timezone: "UTC" },
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

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const browseLinks = (html: string) =>
  html.match(/<a href="\/courses" class="nav-link">.*?Browse Courses<\/a>/g) ??
  [];
const render = async (section = "") =>
  renderToStaticMarkup(await LiveStudent({ section }));

beforeEach(() => {
  mocks.pathname = "/student";
  mocks.enrolments = [];
});

describe("academy navigation", () => {
  it("offers Browse Courses in both the desktop sidebar and the mobile menu", () => {
    const html = renderToStaticMarkup(
      createElement(
        AcademyShell,
        { name: "Alex Morgan" } as Parameters<typeof AcademyShell>[0],
        "content",
      ),
    );
    expect(browseLinks(html)).toHaveLength(2);
    const sidebar = html.slice(
      html.indexOf('aria-label="Academy navigation"'),
      html.indexOf("sidebar-bottom"),
    );
    const mobile = html.slice(
      html.indexOf('aria-label="Mobile academy navigation"'),
    );
    expect(browseLinks(sidebar)).toHaveLength(1);
    expect(browseLinks(mobile)).toHaveLength(1);
  });

  it("offers My Learning and keeps earlier records and Sarah reachable outside the main navigation", () => {
    const html = renderToStaticMarkup(
      createElement(
        AcademyShell,
        { name: "Alex Morgan" } as Parameters<typeof AcademyShell>[0],
        "content",
      ),
    );
    const sidebar = html.slice(
      html.indexOf('aria-label="Academy navigation"'),
      html.indexOf("sidebar-bottom"),
    );
    expect(sidebar).toContain('href="/student/learning"');
    // The compatibility course route and the legacy records stay reachable
    // (My Learning rows and quiet secondary links), not as main items.
    for (const href of ["/student/programme", "/student/sarah"]) {
      expect(sidebar).not.toContain(`href="${href}"`);
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain("Historical programmes");
  });
});

describe("student dashboard course discovery", () => {
  it("links to the public catalogue, needing no cohort assignment", async () => {
    const html = await render();
    expect(html).toContain(
      '<a href="/courses" class="button secondary">Explore more courses</a>',
    );
    expect(text(html)).toContain("Explore the published courses to enrol");
  });

  it("keeps showing the learner's existing enrolments", async () => {
    mocks.enrolments = [
      {
        id: "e-1",
        status: "ACTIVE",
        cohort_title_snapshot: "Autumn cohort",
        cohort_starts_on_snapshot: "2026-11-02",
        programme_versions: {
          title_snapshot: "Existing Programme",
          label: "Edition 1",
          is_demo: false,
        },
      },
    ];
    const plain = text(await render());
    expect(plain).toContain("Existing Programme");
    expect(plain).toContain("Explore more courses");
    expect(plain).not.toContain("No programme enrolment is recorded yet");
  });
});

describe("dashboard AI learning team", () => {
  it("introduces each named AI character, labelled as AI, linking only to existing pages", async () => {
    const html = await render();
    const card = html.slice(html.indexOf('class="card ai-team-card"'));
    const plain = text(card.slice(0, card.indexOf("</section>")));
    expect(plain).toContain("Your AI learning team");
    expect(plain).toContain("Professor Atlas AI AI Professor.");
    expect(plain).toContain("Dr. Forge AI AI Lab Instructor.");
    expect(plain).toContain("Sarah Mitchell AI AI Learner Guide.");
    const hrefs = [...card.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1])
      .slice(0, 3);
    expect(hrefs).toEqual([
      "/student/classes",
      "/student/practicals",
      "/student/sarah",
    ]);
  });

  it("appears only on the dashboard home", async () => {
    expect(await render("calendar")).not.toContain("ai-team-card");
  });
});
