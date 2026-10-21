import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The public course catalogue and course landing page, rendered through the
// real pages. Only the two published-offer projections, the session, the
// commerce configuration and the client checkout form are stubbed.
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  actor: vi.fn(),
  commerceConfig: vi.fn(),
  notFound: vi.fn(),
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
vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Offers: mocks.list,
  getCommercialV1Offer: mocks.get,
}));
vi.mock("@/server/identity", () => ({ getCurrentActor: mocks.actor }));
vi.mock("@/lib/env", () => ({ commerceConfig: mocks.commerceConfig }));
vi.mock("@/components/buy-course-form", () => ({
  BuyCourseForm: ({
    slug,
    paymentAvailable,
  }: {
    slug: string;
    paymentAvailable: boolean;
  }) => `BUY_FORM_MARKER:${slug}:${paymentAvailable}`,
}));

import CoursesPage from "@/app/courses/page";
import CoursePage from "@/app/courses/[slug]/page";

const summary = (over: Record<string, unknown> = {}) => ({
  slug: "partner-course",
  title: "Partner Course",
  examinationBody: "Partner Organisation",
  qualificationName: "Partner Certificate",
  priceAmountMinor: 12345,
  currency: "EUR",
  summary: "A short, published description.",
  cohortStartsOn: "2036-11-02",
  deliveryPlan: "INTENSIVE_4_WEEK",
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ok: true,
  ...summary(),
  viewerAuthenticated: false,
  viewerEntitled: false,
  viewerEnrolmentId: null,
  viewerEnrolmentStatus: "NONE",
  ...over,
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const catalogue = async () => renderToStaticMarkup(await CoursesPage());
const course = async () =>
  renderToStaticMarkup(
    await CoursePage({ params: Promise.resolve({ slug: "partner-course" }) }),
  );
const student = {
  id: "10000000-0000-4000-8000-000000000001",
  displayName: "Alex Morgan",
  roles: ["STUDENT"],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([summary()]);
  mocks.get.mockResolvedValue(detail());
  mocks.actor.mockResolvedValue(null);
  mocks.commerceConfig.mockReturnValue({ configured: true });
});

describe("course catalogue", () => {
  it("shows every required fact from the published projection", async () => {
    const html = await catalogue();
    const card = text(html.slice(html.indexOf('<article class="offer-card"')));
    expect(card).toContain("Partner Organisation Partner Course");
    expect(card).toContain("A short, published description.");
    expect(card).toContain("Prepares you for Partner Certificate");
    expect(card).toContain("Delivery Cohort course · 4-week Intensive");
    expect(card).toContain("Duration 4 weeks");
    expect(card).toContain("Cohort start date 2 November 2036");
    expect(card).toContain("€123.45 EUR");
  });

  it("gives each card one clearly named View course link to its page", async () => {
    mocks.list.mockResolvedValue([
      summary(),
      summary({ slug: "second-course", title: "Second Course" }),
    ]);
    const html = await catalogue();
    expect(hrefs(html).filter((h) => h.startsWith("/courses/"))).toEqual([
      "/courses/partner-course",
      "/courses/second-course",
    ]);
    expect(html).toContain(
      'View course<span class="sr-only">: Second Course</span>',
    );
  });

  it("shows prices exactly as published, in their own currency", async () => {
    mocks.list.mockResolvedValue([
      summary({ priceAmountMinor: 19900, currency: "GBP" }),
    ]);
    const plain = text(await catalogue());
    expect(plain).toContain("£199.00 GBP");
    expect(plain).not.toContain("€");
  });

  it("omits a summary the publisher did not provide", async () => {
    mocks.list.mockResolvedValue([summary({ summary: null })]);
    expect(await catalogue()).not.toContain("offer-card-summary");
  });

  it("says when no course is open, without inventing one", async () => {
    mocks.list.mockResolvedValue([]);
    const html = await catalogue();
    expect(html).toContain('role="status"');
    expect(html).not.toContain("offer-card");
    expect(text(html)).not.toMatch(/\d+ courses? open/);
  });

  it("never presents an outage as an empty catalogue", async () => {
    mocks.list.mockRejectedValue(new Error("Courses could not be loaded."));
    const html = await catalogue();
    expect(html).toContain('role="alert"');
    expect(text(html)).not.toContain("No courses are open");
    expect(html).not.toContain("offer-card");
  });

  it("uses the one approved footer", async () => {
    const html = await catalogue();
    expect(html.match(/<footer[ >]/g)).toHaveLength(1);
    expect(html).toContain('<footer class="site-footer"');
  });
});

describe("course landing page", () => {
  it("presents the supported sections, drawn only from the offer", async () => {
    const html = await course();
    const plain = text(html);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(plain).toContain("Partner Course");
    expect(plain).toContain("A short, published description.");
    for (const heading of [
      "What you'll achieve",
      "How you'll learn",
      "Course structure",
      "Qualification information",
    ])
      expect(plain).toContain(heading);
    expect(plain).toContain(
      "This course prepares you for the Partner Certificate , awarded by Partner Organisation.",
    );
    expect(plain).toContain("Duration 4 weeks (28 days)");
  });

  it("makes no unsupported promises", async () => {
    const plain = text(await course());
    // No audience data is published, so no audience section.
    expect(plain).not.toContain("Who this course is for");
    expect(plain).not.toMatch(
      /guarantee|pass rate|money.back|limited places|AI Professor|Lab Instructor|\d+ lessons|\d+ modules|\d+ assessments/i,
    );
  });

  it("separates the preparation course from the external award", async () => {
    expect(text(await course())).toContain(
      "Completing it does not award the Partner Certificate: that qualification is awarded only by Partner Organisation",
    );
  });

  it("shows the exact published fee and currency prominently", async () => {
    const html = await course();
    expect(html).toContain('<p class="course-fee-price">€123.45</p>');
    expect(text(html)).toContain("One-time course fee · EUR");
  });

  it("keeps sign-in and sign-up for a signed-out visitor, returning to this course", async () => {
    const links = hrefs(await course());
    expect(links).toContain("/login?next=%2Fcourses%2Fpartner-course");
    expect(links).toContain("/signup?next=%2Fcourses%2Fpartner-course");
    expect(await course()).not.toContain("BUY_FORM_MARKER");
  });

  it("offers the existing checkout and code form to a signed-in learner", async () => {
    mocks.actor.mockResolvedValue(student);
    mocks.get.mockResolvedValue(detail({ viewerAuthenticated: true }));
    const html = await course();
    expect(html).toContain("BUY_FORM_MARKER:partner-course:true");
    expect(hrefs(html)).toContain("/student");
  });

  it("keeps the complimentary-code path when card checkout is unavailable", async () => {
    mocks.commerceConfig.mockReturnValue({ configured: false });
    mocks.get.mockResolvedValue(detail({ viewerAuthenticated: true }));
    const html = await course();
    expect(text(html)).toMatch(/card checkout is temporarily unavailable/i);
    expect(html).toContain("BUY_FORM_MARKER:partner-course:false");
  });

  it.each([
    [{ viewerEntitled: true }, /already have access/i],
    [{ viewerEnrolmentStatus: "ACTIVE" }, /already have access/i],
    [{ viewerEnrolmentStatus: "COMPLETED" }, /already completed/i],
    [{ viewerEnrolmentStatus: "PAUSED" }, /paused/i],
    [{ viewerEnrolmentStatus: "WITHDRAWN" }, /contact support/i],
  ])(
    "never offers a fresh purchase to an existing learner (%o)",
    async (state, message) => {
      mocks.get.mockResolvedValue(
        detail({ viewerAuthenticated: true, ...state }),
      );
      const html = await course();
      expect(text(html)).toMatch(message);
      expect(html).not.toContain("BUY_FORM_MARKER");
    },
  );

  it("is not found for an unknown or unpublished course", async () => {
    mocks.get.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    await expect(course()).rejects.toThrow("NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("puts the fee card before the course content for small screens", async () => {
    const html = await course();
    expect(html.indexOf("course-fee-card")).toBeLessThan(
      html.indexOf('id="course-achieve"'),
    );
    expect(html.match(/<footer[ >]/g)).toHaveLength(1);
  });
});
