import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  list: vi.fn(),
  actor: vi.fn(),
  commerce: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCourseCatalogue: m.list,
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: m.actor,
  getCurrentActor: m.actor,
}));
vi.mock("@/lib/env", () => ({ commerceConfig: m.commerce }));
vi.mock("@/components/academy-buy-form", () => ({
  AcademyBuyForm: () => "BUY_FORM_MARKER",
}));
import CoursesPage from "@/app/courses/page";
import CoursePage from "@/app/courses/[slug]/page";
const offer = {
  offerId: "10000000-0000-4000-8000-000000000101",
  slug: "synthetic-course",
  title: "Synthetic Course",
  summary: "Published synthetic summary",
  description: "Published synthetic description",
  currency: "GBP",
  qualificationPreparation: {
    examinationBody: "Example Body",
    qualificationName: "Example Qualification",
    disclaimer:
      "This preparation course does not award the external qualification.",
  },
  demoContent: true,
  lessons: 2,
  labs: 1,
  assessments: 1,
  formats: [
    {
      formatId: "STANDARD_6W",
      weeks: 6,
      sessionMinutes: 60,
      minStudyDays: 2,
      maxStudyDays: 7,
      amountMinor: 12345,
    },
  ],
};
const catalogue = async () => renderToStaticMarkup(await CoursesPage());
const course = async () =>
  renderToStaticMarkup(
    await CoursePage({ params: Promise.resolve({ slug: offer.slug }) }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  m.list.mockResolvedValue([offer]);
  m.actor.mockResolvedValue(null);
  m.commerce.mockReturnValue({ configured: true });
});
describe("unified public catalogue and course pages", () => {
  it("uses the same published register and one-price cards", async () => {
    const html = await catalogue();
    expect(html).toContain("Synthetic Course");
    expect(html).toContain("\u00a3123.45");
    expect(html).toContain('href="/courses/synthetic-course"');
    expect(html).not.toMatch(/cohort|From ?/i);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html.match(/<footer[ >]/g)).toHaveLength(1);
  });
  it("distinguishes the empty catalogue from an outage", async () => {
    m.list.mockResolvedValue([]);
    expect(await catalogue()).toContain("No courses are published yet.");
    m.list.mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    const html = await catalogue();
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/PRIVATE_SENTINEL|No courses are published yet/);
  });
  it("renders uploaded facts as text and labels synthetic content", async () => {
    m.list.mockResolvedValue([
      { ...offer, title: "<script>alert(1)</script>" },
    ]);
    const html = await catalogue();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Demonstration content");
  });
  it("shows the published content, qualification disclaimer and personal timetable choices", async () => {
    const html = await course();
    expect(html).toContain(offer.description);
    expect(html).toContain(offer.qualificationPreparation.disclaimer);
    expect(html).toContain("Demonstration content");
    expect(html).not.toMatch(/cohort|guaranteed pass|limited places/i);
  });
  it("preserves course return URLs for sign-in and sign-up", async () => {
    const html = await course();
    expect(html).toContain("/login?next=%2Fcourses%2Fsynthetic-course");
    expect(html).toContain("/signup?next=%2Fcourses%2Fsynthetic-course");
    expect(html).not.toContain("BUY_FORM_MARKER");
  });
  it("only offers purchase to a learner account", async () => {
    m.actor.mockResolvedValue({ roles: ["INSTRUCTOR"] });
    expect(await course()).not.toContain("BUY_FORM_MARKER");
    m.actor.mockResolvedValue({ roles: ["STUDENT"] });
    expect(await course()).toContain("BUY_FORM_MARKER");
  });
  it("does not fabricate checkout availability", async () => {
    m.commerce.mockReturnValue({ configured: false });
    m.actor.mockResolvedValue({ roles: ["STUDENT"] });
    expect(await course()).toContain("Card checkout is currently unavailable");
  });
  it("refuses unknown and unpublished slugs", async () => {
    m.list.mockResolvedValue([]);
    await expect(course()).rejects.toThrow("NOT_FOUND");
  });
});
