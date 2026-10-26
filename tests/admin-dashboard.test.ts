import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DUCELIO = "00000000-0000-4000-8000-000000000001";
const m = vi.hoisted(() => ({
  roles: ["ACADEMIC_ADMIN"] as string[],
  allowed: true,
  packages: vi.fn(),
  orders: vi.fn(),
  coupons: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    m.redirect(url);
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: async () => ({
    actor: { id: "a", displayName: "Avery", roles: m.roles },
    allowed: m.allowed,
    organisations: [],
  }),
}));
vi.mock("@/server/staff", () => ({
  getAdminOverview: async () => ({ counts: [1, 42, 0, 3], audit: [] }),
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: m.packages,
}));
vi.mock("@/server/course-coupons", () => ({
  listOrganisationCourseOrders: m.orders,
  listCourseCoupons: m.coupons,
}));

import Page from "@/app/admin/page";

const pkg = (over: Record<string, unknown>) => ({
  id: "10000000-0000-4000-8000-000000000003",
  organisationId: DUCELIO,
  organisationName: "Ducelio",
  packageKey: "aws-saa-c03-architect-academy",
  packageRevision: 3,
  status: "VALIDATED",
  title: "AWS SAA-C03",
  pendingDecisions: Array.from({ length: 8 }, (_, i) => `D${i}`),
  rejectedReason: null,
  curriculumImport: null,
  course: null,
  ...over,
});
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = async () =>
  renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.roles = ["ACADEMIC_ADMIN"];
  m.allowed = true;
  m.packages.mockResolvedValue([
    pkg({}),
    // An earlier revision of the same course is not counted again.
    pkg({
      id: "10000000-0000-4000-8000-000000000002",
      packageRevision: 2,
      pendingDecisions: [],
    }),
    pkg({
      id: "10000000-0000-4000-8000-000000000009",
      packageKey: "acceptance-unified-x",
      title: "TEST ONLY Unified x",
      status: "PUBLISHED",
      pendingDecisions: [],
    }),
  ]);
  m.orders.mockResolvedValue([
    {
      id: "o1",
      courseTitle: "TEST ONLY Unified x",
      learnerId: "l",
      state: "FULFILLED",
      amountMinor: 100,
      currency: "GBP",
      discountAmountMinor: 0,
      paymentConfirmed: true,
      refundRecorded: false,
      createdAt: "2026-10-25T10:00:00Z",
    },
  ]);
  m.coupons.mockResolvedValue([
    {
      id: "c1",
      code: "SPRING",
      percentOff: 10,
      amountOffMinor: null,
      currency: null,
      expiresAt: "2031-01-01T00:00:00Z",
      redemptionLimit: 5,
      courseId: null,
      active: true,
      reserved: 0,
      redeemed: 0,
    },
    {
      id: "c2",
      code: "OLD",
      percentOff: 10,
      amountOffMinor: null,
      currency: null,
      expiresAt: "2020-01-01T00:00:00Z",
      redemptionLimit: 5,
      courseId: null,
      active: true,
      reserved: 0,
      redeemed: 0,
    },
  ]);
});

describe("admin dashboard", () => {
  it("is a dashboard, not a redirect to Course Engineering", async () => {
    const html = await render();
    expect(m.redirect).not.toHaveBeenCalled();
    expect(text(html)).toContain("Dashboard");
    expect(html).toContain("<h1>Dashboard</h1>");
    expect(html).toContain('<a href="/admin">Dashboard</a></nav>');
  });

  it("counts each course once at its latest revision and excludes test records", async () => {
    const plain = text(await render());
    expect(plain).toMatch(/Courses 1 0 published/);
    expect(plain).toMatch(/Awaiting academic review 1/);
    expect(plain).toContain("Test courses 1");
    expect(plain).toContain("Test-course orders 1");
    expect(plain).toMatch(/Active coupons 1/);
    expect(plain).toMatch(/Learner accounts 42/);
  });

  it("lists AWS as needing a decision, linked to its academic review", async () => {
    const html = await render();
    expect(html).toContain(
      'href="/admin/course-engineering/review?packageId=10000000-0000-4000-8000-000000000003"',
    );
    expect(text(html)).toContain("8 academic decisions must be resolved");
  });

  it("never reports revenue, and shows an unavailable source as unavailable", async () => {
    m.orders.mockRejectedValue(new Error("FORBIDDEN"));
    const plain = text(await render());
    expect(plain).toContain("Recognised revenue is not reported");
    expect(plain).toMatch(
      /Payment-confirmed orders — Order report unavailable/,
    );
  });

  it("keeps routing registrars and learners to their own homes", async () => {
    m.allowed = false;
    m.roles = ["REGISTRAR"];
    await expect(render()).rejects.toThrow("REDIRECT:/admin/academy");
    m.roles = ["STUDENT"];
    await expect(render()).rejects.toThrow("REDIRECT:/student/academy");
    expect(m.packages).not.toHaveBeenCalled();
  });
});
