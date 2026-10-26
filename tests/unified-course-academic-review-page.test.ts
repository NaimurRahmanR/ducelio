import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  packages: vi.fn(),
  review: vi.fn(),
  source: vi.fn(),
  decisions: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: m.access,
}));
vi.mock("@/server/academy-course-engineering", () => ({
  getAcademyPackageReview: m.review,
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: m.packages,
  getUnifiedAcademicResolutions: m.decisions,
  getUnifiedRevisionSource: m.source,
}));

import ReviewPage from "@/app/admin/academic-review/page";

const id = "10000000-0000-4000-8000-000000000101";
beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({
    allowed: true,
    actor: {
      id,
      displayName: "Academic reviewer",
      roles: ["ACADEMIC_ADMIN"],
    },
    organisations: [],
  });
  m.packages.mockResolvedValue([
    {
      id,
      packageKey: "aws-saa-c03",
      packageRevision: 3,
      title: "AWS SAA-C03",
      status: "VALIDATED",
      organisationId: null,
      pendingDecisions: ["OFFICIAL_SOURCE_RECONCILIATION"],
    },
  ]);
  m.review.mockResolvedValue({
    review: {
      pendingDecisions: [
        {
          key: "OFFICIAL_SOURCE_RECONCILIATION",
          summary: "Independent review required before sale.",
        },
      ],
    },
  });
  m.source.mockResolvedValue(null);
  m.decisions.mockResolvedValue([]);
});

it("opens a dedicated course-package review page, not the cohort grader", async () => {
  const html = renderToStaticMarkup(
    await ReviewPage({ searchParams: Promise.resolve({ packageId: id }) }),
  );
  expect(html).toContain("Course packages requiring review");
  expect(html).toContain("Outstanding academic decisions");
  expect(html).toContain("Independent review required before sale");
  expect(html).toContain(`/admin/course-engineering?packageId=${id}`);
  expect(html).toContain("/admin/academic-review/results");
  expect(html).not.toContain("Course · cohort");
  expect(html).not.toContain("Results awaiting human academic review");
});

it("never provides cross-course answer content from a summary-only review", async () => {
  const html = renderToStaticMarkup(
    await ReviewPage({ searchParams: Promise.resolve({ packageId: id }) }),
  );
  expect(html).not.toContain("PRIVATE_ASSESSMENT_KEY");
});

it("handles a nonexistent course selection without a fallback to other courses", async () => {
  const html = renderToStaticMarkup(
    await ReviewPage({
      searchParams: Promise.resolve({
        packageId: "20000000-0000-4000-8000-000000000202",
      }),
    }),
  );
  expect(html).toContain("Course packages requiring review");
  expect(html).not.toContain("Outstanding academic decisions");
  expect(m.review).not.toHaveBeenCalled();
  expect(m.source).not.toHaveBeenCalled();
});
