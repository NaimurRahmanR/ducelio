import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AC-7: the learner course-guidance UI on /student/sarah. Presentation
// only; the database and server decide what exists
// (sarah-course-guidance-db.test.ts, sarah-course-guidance.test.ts).
const mocks = vi.hoisted(() => ({
  actionState: null as Record<string, unknown> | null,
  mode: "PROSPECT" as string | null,
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
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/student/sarah" }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/student/sarah/actions", () => ({
  askSarahAction: vi.fn(),
  decideSarahProposalAction: vi.fn(),
}));
vi.mock("@/app/student/sarah/feedback-actions", () => ({
  submitSessionFeedbackAction: vi.fn(),
}));
vi.mock("@/app/student/sarah/course-guidance-actions", () => ({
  askSarahCourseGuidanceAction: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireActor: async () => ({
    id: "10000000-0000-4000-8000-000000000003",
    displayName: "Jordan Lee",
    roles: ["STUDENT"],
  }),
  requireStudentPrincipal: async () => ({
    id: "10000000-0000-4000-8000-000000000003",
    displayName: "Jordan Lee",
    roles: ["STUDENT"],
  }),
}));
vi.mock("@/server/sarah", () => ({
  getMySarahMode: async () => mocks.mode,
  listMySarahProposals: async () => ({
    status: "OK",
    current: {
      confirmed: false,
      studyGoal: null,
      weeklyHours: null,
      preferredContact: null,
    },
    proposals: [],
  }),
}));
vi.mock("@/server/session-feedback", () => ({
  listMySessionFeedbackOpportunities: async () => ({
    status: "OK",
    opportunities: [],
  }),
}));

import {
  SarahCourseGuidancePanel,
  submitSarahCourseGuidance,
} from "@/components/sarah-course-guidance";
import SarahPage from "@/app/student/sarah/page";
import type { SarahCourseRecommendationCard } from "@/domain/sarah-course-guidance";

const KEY = "55555555-5555-4555-8555-555555555555";
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const text = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
// React's own server-rendered form-replay bootstrap, not page content.
const panel = (mode: "PROSPECT" | "POST_COURSE" = "PROSPECT") =>
  renderToStaticMarkup(
    createElement(SarahCourseGuidancePanel, {
      mode,
      initialIdempotencyKey: KEY,
    }),
  ).replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/g, "");
const succeeded = (
  recommendations: SarahCourseRecommendationCard[],
  extra: Record<string, unknown> = {},
) => {
  mocks.actionState = {
    result: {
      status: "SUCCEEDED",
      reply: "Here are some published options that may suit you.",
      recommendations,
      unavailableRecommendations: 0,
      ...extra,
    },
    idempotencyKey: KEY,
  };
};
const card = (
  slug: string,
  extra: Partial<SarahCourseRecommendationCard> = {},
): SarahCourseRecommendationCard => ({
  slug,
  title: `Course ${slug}`,
  examinationBody: "ISC2",
  qualificationName: "Certified in Cybersecurity",
  priceAmountMinor: 49900,
  currency: "GBP",
  cohortStartsOn: "2026-11-02",
  deliveryPlan: "STANDARD_6_WEEK",
  reason: "Matches the focus you described.",
  ...extra,
});
// Copy that would pressure, promise or claim a commercial action happened.
const PRESSURE_OR_FALSE_CLAIMS =
  /(guarantee|limited time|hurry|act now|don't miss|last chance|only \d+ (places|seats) left|discount|purchased|you are enrolled|you're enrolled|now enrolled|reserved for you|place is reserved|seat is reserved|payment (is )?complete|best course for you)/i;

beforeEach(() => {
  mocks.actionState = null;
  mocks.mode = "PROSPECT";
});

describe("Sarah course guidance on /student/sarah", () => {
  it("offers 'Find a course' to a PROSPECT under Sarah's AI identity, after the AC-5 ask panel", async () => {
    const plain = text(renderToStaticMarkup(await SarahPage()));
    expect(plain).toContain("Sarah Mitchell");
    expect(plain).toContain("Ducelio AI learner-success counsellor");
    expect(plain).toContain("Sarah is AI");
    expect(plain).toContain("Find a course");
    expect(plain).toContain("Tell Sarah what you are looking for");
    // The AC-5 guide remains, with its two needs.
    expect(plain).toContain("Ask Sarah");
    expect(plain).toContain("Suggesting an update to my support preferences");
    expect(plain.indexOf("Find a course")).toBeGreaterThan(
      plain.indexOf("Ask Sarah"),
    );
    // AC-6 feedback stays its own deterministic card, never in this panel.
    const course = plain.slice(
      plain.indexOf("Find a course"),
      plain.indexOf("Suggested changes to your support preferences"),
    );
    expect(course).not.toMatch(/How did that session go|Clarity|1 to 5/i);
  });

  it("offers 'Find a course' to a POST_COURSE learner", async () => {
    mocks.mode = "POST_COURSE";
    const plain = text(renderToStaticMarkup(await SarahPage()));
    expect(plain).toContain("Find a course");
    expect(plain).toContain("Your course has ended");
  });

  it("never offers course guidance during an active course, or when the mode is unknown", async () => {
    for (const mode of ["ACTIVE_COURSE", null]) {
      mocks.mode = mode;
      const html = renderToStaticMarkup(await SarahPage());
      const plain = text(html);
      expect(plain).not.toContain("Find a course");
      expect(plain).not.toMatch(/Ask Sarah about courses|recommend|pricing/i);
      expect(html).not.toContain('value="COURSE_GUIDANCE"');
    }
  });

  it("sends only the fixed intent, a bounded message and the server-provided key", () => {
    const html = panel();
    const names = [
      ...new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1])),
    ].sort();
    expect(names).toEqual(["idempotencyKey", "intent", "message"]);
    expect(html).toContain('name="intent" value="COURSE_GUIDANCE"');
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain('maxLength="1000"');
    expect(html).not.toMatch(/name="(mode|slug|price|offer|studentId)"/);
    expect(panel()).toBe(html);
  });

  it("states the firewall, no memory and no commercial action, without pressure", () => {
    for (const mode of ["PROSPECT", "POST_COURSE"] as const) {
      const plain = text(panel(mode));
      expect(plain).toContain("published course list");
      expect(plain).toContain(
        "does not use your support preferences, support history, session ratings, marks or scores, or payments",
      );
      expect(plain).toContain("cannot buy, enrol or hold a place for you");
      expect(plain).toContain("not saved");
      expect(plain).toContain("Suggestions are optional");
      expect(plain).not.toMatch(PRESSURE_OR_FALSE_CLAIMS);
    }
  });

  it("renders Sarah's reply as escaped text and up to three authoritative cards linking to the read-only course page", () => {
    succeeded(
      [
        card("cyber-foundations", { priceAmountMinor: 52900 }),
        card("cloud-security", {
          deliveryPlan: "INTENSIVE_4_WEEK",
          reason: "A shorter, intensive format that matches your request.",
        }),
        card("network-defence"),
        card("fourth-course"),
      ],
      { reply: "<script>alert(1)</script> Options below." },
    );
    const html = panel();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/<article/g)).toHaveLength(3);
    expect(html).not.toContain("fourth-course");
    const plain = text(html);
    // Price and dates come from the authoritative card data.
    expect(plain).toContain("£529.00");
    expect(plain).toContain("£499.00");
    expect(plain).toContain("Next cohort starts 2 November 2026");
    expect(plain).toContain("4-week Intensive");
    expect(plain).toContain("Certified in Cybersecurity");
    for (const slug of [
      "cyber-foundations",
      "cloud-security",
      "network-defence",
    ])
      expect(html).toContain(`href="/courses/${slug}"`);
    // The model's words are clearly subordinate and labelled as Sarah's.
    expect(plain).toContain(
      "Why Sarah suggested it (AI): A shorter, intensive format that matches your request.",
    );
    expect(plain).toContain("Optional suggestions");
    expect(plain).toContain("Ducelio's current published information");
    // No checkout, order or purchase control exists here.
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(text(html)).not.toMatch(
      /Buy now|Purchase|Pay now|Enrol now|Reserve/i,
    );
    expect(html).not.toMatch(/checkout|create_commercial|\/orders?\b/i);
    expect(html).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?!")/,
    );
  });

  it("carries no support, score or internal data on the cards", () => {
    succeeded([card("cyber-foundations")]);
    const html = panel("POST_COURSE");
    // The caption names what Sarah does NOT use; the cards carry none of it.
    const cards = html.slice(
      html.indexOf('<section aria-label="Courses Sarah suggested">'),
    );
    expect(cards).toContain("<article");
    expect(cards).not.toMatch(
      /study goal|weekly hours|counsellor note|score|pass mark|grade|mastery|activationId|offerId/i,
    );
    expect(html.match(/[0-9a-f]{8}-[0-9a-f]{4}-/g)).toEqual([KEY.slice(0, 14)]);
  });

  it("states truthfully when a suggestion is no longer available, and shows calm failures", () => {
    succeeded([], { unavailableRecommendations: 2 });
    expect(text(panel())).toContain(
      "2 suggested courses are no longer available, so they are not shown.",
    );
    for (const [status, copy] of [
      ["NOT_AVAILABLE_IN_MODE", "available before your first course"],
      ["RETRY_LATER", "Please try again in a moment"],
      ["UNAVAILABLE", "not available right now"],
      ["DUPLICATE", "already sent"],
    ]) {
      mocks.actionState = { result: { status }, idempotencyKey: KEY };
      const plain = text(panel());
      expect(plain).toContain(copy);
      expect(plain).toContain(
        status === "DUPLICATE"
          ? "already sent"
          : "Nothing about your records has changed",
      );
      expect(plain).not.toMatch(
        /OUTPUT_INVALID|CONTEXT_CONFLICT|execution|provider/i,
      );
    }
  });

  it("rotates the key after every resolved response and keeps it while unresolved", async () => {
    const previous = { result: {}, idempotencyKey: KEY };
    const next = await submitSarahCourseGuidance(
      previous,
      new FormData(),
      async () => ({ status: "DUPLICATE" }),
      () => "66666666-6666-4666-8666-666666666666",
    );
    expect(next).toEqual({
      result: { status: "DUPLICATE" },
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    const kept = await submitSarahCourseGuidance(
      previous,
      new FormData(),
      async () => {
        throw new Error("transport");
      },
      () => "77777777-7777-4777-8777-777777777777",
    );
    expect(kept).toEqual({
      result: { status: "RETRY_LATER" },
      idempotencyKey: KEY,
    });
  });
});
