import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LR-BASELINE-01: the public homepage and catalogue, rendered through the
// real page components. Only the published-offer projection and the
// session lookup are stubbed.
const mocks = vi.hoisted(() => ({
  offers: vi.fn(),
  actor: vi.fn(),
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
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Offers: mocks.offers,
}));
vi.mock("@/server/identity", () => ({ getCurrentActor: mocks.actor }));

import Home from "@/app/page";
import CoursesPage from "@/app/courses/page";
import { formatCohortStartDate } from "@/domain/commercial-v1-commerce";

const offer = (n: number) => ({
  slug: `course-${n}`,
  title: `Course ${n}`,
  examinationBody: "Example Body",
  qualificationName: `Qualification ${n}`,
  priceAmountMinor: 10000,
  currency: "GBP",
  summary: null,
  cohortStartsOn: "2036-11-02",
  deliveryPlan: "STANDARD_6_WEEK",
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
const render = async () => renderToStaticMarkup(await Home());

beforeEach(() => {
  mocks.offers.mockReset();
  mocks.actor.mockReset();
  mocks.offers.mockResolvedValue([1, 2, 3, 4].map(offer));
  mocks.actor.mockResolvedValue(null);
});

describe("public homepage", () => {
  it("is a real landing page with one main landmark for the skip link", async () => {
    const html = await render();
    expect(html.match(/<main id="main"/g)).toHaveLength(1);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    const plain = text(html);
    expect(plain).toContain("Your ambition. Guided to mastery.");
    expect(plain).toContain("How Ducelio works");
    expect(plain).toContain("Getting started");
    expect(plain).toContain("AI Professor");
    expect(plain).toContain(
      "Ducelio prepares learners for external qualifications. It does not award them",
    );
  });

  it("features at most three published offers from the projection", async () => {
    const html = await render();
    const courseLinks = hrefs(html).filter((h) => h.startsWith("/courses/"));
    expect(courseLinks).toEqual([
      "/courses/course-1",
      "/courses/course-2",
      "/courses/course-3",
    ]);
    const plain = text(html);
    expect(plain).toContain("£100.00");
    expect(plain).toContain("Cohort start date: 2 November 2036");
    expect(html).toContain(
      '<time dateTime="2036-11-02">2 November 2036</time>',
    );
    expect(plain).toContain("View all courses");
  });

  it("offers sign-in and sign-up to a signed-out visitor", async () => {
    const links = hrefs(await render());
    expect(links).toContain("/login");
    expect(links).toContain("/signup");
    expect(links).toContain("/demo");
    expect(links).not.toContain("/student");
  });

  it("gives a signed-in learner a way back to their academy", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Alex Morgan",
      roles: ["STUDENT"],
    });
    const html = await render();
    expect(hrefs(html)).toContain("/student");
    expect(hrefs(html)).not.toContain("/login");
    expect(text(html)).toContain("Go to your academy");
  });

  it("sends a staff-only account to its own workspace, never the learner area", async () => {
    mocks.actor.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000002",
      displayName: "Pat Admin",
      roles: ["ACADEMIC_ADMIN"],
    });
    const links = hrefs(await render());
    expect(links).toContain("/admin");
    expect(links).not.toContain("/student");
  });

  it("falls back to the signed-out page when the session cannot be resolved", async () => {
    mocks.actor.mockRejectedValue(new Error("profile unavailable"));
    const links = hrefs(await render());
    expect(links).toContain("/login");
  });

  it("says when no course is open", async () => {
    mocks.offers.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("No courses are open for enrolment right now");
    expect(text(html)).not.toContain("View all courses");
  });

  it("never presents a catalogue outage as an empty catalogue", async () => {
    mocks.offers.mockRejectedValue(new Error("Courses could not be loaded."));
    const html = await render();
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Courses could not be loaded right now");
    expect(text(html)).not.toContain("No courses are open");
  });
});

describe("public catalogue", () => {
  it("has the skip-link target and the shared offer card", async () => {
    const html = renderToStaticMarkup(await CoursesPage());
    expect(html.match(/<main id="main"/g)).toHaveLength(1);
    expect(hrefs(html).filter((h) => h.startsWith("/courses/"))).toHaveLength(
      4,
    );
    expect(text(html)).toContain("Cohort start date: 2 November 2036");
  });

  it("reports an outage distinctly from an empty catalogue", async () => {
    mocks.offers.mockRejectedValue(new Error("Courses could not be loaded."));
    const html = renderToStaticMarkup(await CoursesPage());
    expect(html).toContain('role="alert"');
    expect(text(html)).not.toContain("No courses are open");
  });
});

describe("cohort start date", () => {
  it("is the stored calendar date, unambiguous and independent of the host zone", () => {
    expect(formatCohortStartDate("2026-11-02")).toBe("2 November 2026");
    expect(formatCohortStartDate("2026-01-01")).toBe("1 January 2026");
  });

  it("passes through a value that is not a calendar date", () => {
    expect(formatCohortStartDate("soon")).toBe("soon");
    expect(formatCohortStartDate("2026-13-40")).toBe("2026-13-40");
  });

  it("states the stored day without a past/future claim that depends on the viewer's zone", async () => {
    mocks.offers.mockResolvedValue([
      { ...offer(1), cohortStartsOn: "2020-01-01" },
    ]);
    const html = await render();
    const plain = text(html);
    expect(plain).toContain("Cohort start date: 1 January 2020");
    expect(html).toContain('<time dateTime="2020-01-01">1 January 2020</time>');
    expect(plain).not.toMatch(/next cohort|cohort started|starts soon/i);
  });
});
