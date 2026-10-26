import { roleSchema } from "@/domain/academy";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The five admin control-centre pages, rendered through the real pages,
// shell and components. Only the governed server reads are stubbed.
const m = vi.hoisted(() => ({
  actor: {
    id: "60000000-0000-4000-8000-000000000001",
    displayName: "Avery Admin",
    roles: ["ACADEMIC_ADMIN"] as string[],
  },
  dashboard: vi.fn(),
  catalogue: vi.fn(),
  redirect: vi.fn(),
  overview: vi.fn(),
  options: vi.fn(),
  aiConfigured: false,
  offerActivations: vi.fn(),
  campaigns: vi.fn(),
  offersView: vi.fn(),
  live: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    "aria-current"?: string;
    "aria-label"?: string;
  }) => createElement("a", { href, className, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    m.redirect(url);
    throw new Error("REDIRECT:" + url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  unstable_rethrow: () => {},
}));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/server/identity", () => ({
  requireActor: async () => m.actor,
  requireAnyRole: async (roles: string[]) => {
    if (!roles.some((r) => m.actor.roles.includes(r)))
      throw new Error("Access denied");
    return m.actor;
  },
}));
vi.mock("@/server/admin-control-centre", async (original) => ({
  ...(await original<typeof import("@/server/admin-control-centre")>()),
  getDashboardData: m.dashboard,
  getCourseCatalogue: m.catalogue,
}));
vi.mock("@/server/staff", () => ({ getAdminOverview: m.overview }));
vi.mock("@/server/operations-engineer", () => ({
  getOperationOptions: m.options,
  operationsEngineerConfigured: () => m.aiConfigured,
}));
vi.mock("@/app/admin/operations-engineer/actions", () => ({
  prepareOperationAction: vi.fn(),
  interpretRequestAction: vi.fn(),
  executeOperationAction: vi.fn(),
  prepareUnifiedOperationAction: vi.fn(),
  executeUnifiedOperationAction: vi.fn(),
}));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: async () => ({
    actor: m.actor,
    organisations: [],
    allowed: m.actor.roles.includes("ACADEMIC_ADMIN") || m.actor.roles.includes("PLATFORM_ADMIN"),
  }),
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1OfferActivations: m.offerActivations,
  listCommercialV1Campaigns: m.campaigns,
  listCommercialV1Offers: m.live,
}));
vi.mock("@/server/commercial-v1-commerce/operations", () => ({
  listCommerceOperations: m.offersView,
}));
vi.mock("@/app/admin/commerce/actions", () => ({
  commerceOperationAction: vi.fn(),
  publishOfferAction: vi.fn(),
  archiveOfferAction: vi.fn(),
  createCampaignAction: vi.fn(),
  archiveCampaignAction: vi.fn(),
}));

import DashboardPage from "@/app/admin/page";
import { AdminShell } from "@/components/admin-shell";
import CoursesPage from "@/app/admin/courses/page";
import OperationsPage from "@/app/admin/operations-engineer/page";
import AcademyPage from "@/app/admin/academy/page";
import SalesPage from "@/app/admin/sales/page";
import { deriveCourseLifecycle } from "@/domain/admin-course-lifecycle";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const navHrefs = (html: string) => {
  const nav = html.slice(
    html.indexOf('aria-label="Administration"'),
    html.indexOf("</nav>", html.indexOf('aria-label="Administration"')),
  );
  return [...nav.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
};
const VERSION = "20000000-0000-4000-8000-000000000006";
const securityPlus = () => ({
  packageKey: "security-plus-sy0-701",
  title: "CompTIA Security+ (SY0-701)",
  versionLabel: "Revision 6",
  testRecord: false,
  lifecycle: deriveCourseLifecycle({
    revisions: [
      {
        id: "10000000-0000-4000-8000-000000000006",
        packageKey: "security-plus-sy0-701",
        packageRevision: 6,
        status: "PUBLISHED",
        programmeId: null,
        programmeVersionId: VERSION,
        createdAt: "2026-10-19T10:00:00Z",
        appliedAt: "2026-10-19T11:00:00Z",
        publishedAt: "2026-10-19T12:00:00Z",
        rejectedAt: null,
      },
    ],
    activations: [],
    offerActivations: [],
    liveOfferSlugs: [],
    cohorts: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        title: "Acceptance cohort 1791-security",
        startsOn: "2026-10-13",
        endsOn: null,
        status: "OPEN",
        programmeVersionId: VERSION,
        isDemo: false,
        enrolments: { active: 1, paused: 0, completed: 0, withdrawn: 0 },
        activationId: null,
        publishedOfferSlug: null,
      },
    ],
  }),
});
const allSources = {
  packages: true,
  activations: true,
  offers: true,
  catalogue: true,
  cohorts: true,
};
const dashboard = (over: Record<string, unknown> = {}) => ({
  actor: m.actor,
  courseAdmin: true,
  overview: {
    ok: true,
    data: {
      programmes: 1,
      learners: 12,
      cohorts: 3,
      staff: 4,
      audit: [],
      canAudit: false,
    },
  },
  catalogue: {
    ok: true,
    data: { courses: [securityPlus()], sources: allSources },
  },
  enrolments: {
    ok: true,
    data: {
      active: 9,
      paused: 1,
      completed: 2,
      withdrawn: 0,
      openCohorts: 2,
      cohorts: 2,
    },
  },
  orders: { ok: true, data: { hasMore: false, rows: [] } },
  issues: {
    ok: true,
    data: {
      hasMore: false,
      rows: [{ state: "UNRESOLVED" }, { state: "RESOLVED" }],
    },
  },
  campaigns: { ok: true, data: { active: 1, archived: 0 } },
  testRecords: {
    ok: true,
    data: { courses: 15, cohorts: 15, enrolments: 30, orders: 6, campaigns: 4 },
  },
  agents: [
    {
      ref: "OPERATIONS_ENGINEER_PLATFORM_V1",
      roles: ["Operations Engineer"],
      ready: false,
      credential: "ANTHROPIC_API_KEY",
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.actor.roles = ["ACADEMIC_ADMIN"];
  m.aiConfigured = false;
  m.dashboard.mockResolvedValue(dashboard());
  m.catalogue.mockResolvedValue({
    courses: [securityPlus()],
    sources: allSources,
  });
  m.overview.mockResolvedValue({
    actor: m.actor,
    counts: [1, 12, 3, 4],
    programmes: [],
    audit: [],
  });
  m.options.mockResolvedValue({
    courses: [
      {
        value: "security-plus-sy0-701",
        label: "CompTIA Security+ — revision 6",
      },
    ],
    appliedPackages: [],
    activationsWithoutOffer: [
      {
        value: "a1",
        label: "Security+ — Acceptance cohort (starts 2026-10-13)",
        warning: "Staging or acceptance cohort: not for paying learners.",
      },
    ],
    publishedOffers: [],
    activeCampaigns: [],
    cohorts: [],
  });
  m.offerActivations.mockResolvedValue([]);
  m.campaigns.mockResolvedValue([]);
  m.live.mockResolvedValue([]);
  m.offersView.mockResolvedValue({
    hasMore: false,
    rows: [
      {
        id: "o1",
        title: "Acceptance Run 1791",
        subtitle: "acceptance-run-1791 / Acceptance cohort 1791 / 100 GBP",
        state: "PUBLISHED",
        occurredAt: "2026-10-13T10:00:00Z",
        orderId: null,
        entitlementId: null,
        learnerId: null,
        offerId: "o1",
        reason: null,
      },
    ],
  });
});

describe("navigation and compatibility", () => {
  it("offers the restored review and operations destinations to a course administrator", async () => {
    const html = renderToStaticMarkup(
      AdminShell({
        active: "dashboard",
        name: m.actor.displayName,
        roles: roleSchema.array().parse(m.actor.roles),
        title: "Administration",
        children: "History",
      }),
    );
    expect(navHrefs(html)).toEqual([
      "/admin",
      "/admin/course-engineering",
      "/admin/academic-review",
      "/admin/operations-engineer",
      "/admin/sales",
      "/admin/academy",
    ]);
  });

  it("shows a registrar only the destinations their role can use", async () => {
    m.actor.roles = ["REGISTRAR"];
    m.dashboard.mockResolvedValue(dashboard({ courseAdmin: false }));
    const html = renderToStaticMarkup(
      AdminShell({
        active: "dashboard",
        name: m.actor.displayName,
        roles: roleSchema.array().parse(m.actor.roles),
        title: "Administration",
        children: "History",
      }),
    );
    expect(navHrefs(html)).toEqual(["/admin", "/admin/academy"]);
    expect(html).not.toContain("Ask Operations Engineer");
  });

  it("redirects the former section URLs into Academy Operations, keeping their filters", async () => {
    await expect(
      DashboardPage({
        searchParams: Promise.resolve({
          section: "Sessions",
          tqCohortId: "c1",
        }),
      }),
    ).rejects.toThrow("REDIRECT:");
    expect(m.redirect).toHaveBeenCalledWith(
      "/admin/academy?section=sessions&tqCohortId=c1&tab=teaching",
    );
  });

  it("keeps historical commerce behind the course administrator roles", async () => {
    m.actor.roles = ["REGISTRAR"];
    for (const page of [SalesPage({ searchParams: Promise.resolve({}) })]) {
      const plain = text(renderToStaticMarkup(await page));
      expect(plain).toContain("You do not have access to this workspace");
      expect(plain).toContain("No records from it were loaded");
    }
    expect(m.catalogue).not.toHaveBeenCalled();
    expect(m.offersView).not.toHaveBeenCalled();
    expect(m.options).not.toHaveBeenCalled();
  });
});

describe("retired course creation routes", () => {
  it.each([
    {},
    { tab: "cohort" },
    { filter: "tests" },
    { packageKey: "historical-course" },
  ])(
    "redirects old course filters to the canonical workspace",
    async (params) => {
      await expect(
        CoursesPage({ searchParams: Promise.resolve(params) }),
      ).rejects.toThrow("REDIRECT:/admin/course-engineering");
      expect(m.catalogue).not.toHaveBeenCalled();
    },
  );
  it("restores the governed Operations Engineer workspace without legacy mutation options", async () => {
    const html = renderToStaticMarkup(await OperationsPage());
    expect(html).toContain("Operations Engineer");
    expect(html).toContain("Review request");
    expect(html).toContain("Upload a new course package");
    expect(m.options).not.toHaveBeenCalled();
  });
});

describe("academy operations", () => {
  it("declines to offer organisation management without tenant isolation", async () => {
    const html = renderToStaticMarkup(
      await AcademyPage({
        searchParams: Promise.resolve({ tab: "organisations" }),
      }),
    );
    const plain = text(html);
    expect(plain).toContain("Organisation administration is not available yet");
    expect(plain).toContain("row-level security policies");
    expect(html.slice(html.indexOf("Organisation administration"))).not.toMatch(
      /<form|<button/,
    );
  });

  it("shows AI runtime health without claiming live calls", async () => {
    const plain = text(
      renderToStaticMarkup(
        await AcademyPage({ searchParams: Promise.resolve({ tab: "agents" }) }),
      ),
    );
    expect(plain).toContain("It does not prove a live call succeeded");
    expect(plain).toContain("OPERATIONS_ENGINEER_PLATFORM_V1");
  });
});

describe("commerce history", () => {
  it("directs all new pricing and discounts to the unified authorities", async () => {
    const html = renderToStaticMarkup(
      await SalesPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('href="/admin/course-engineering"');
    expect(html).toContain('href="/admin/course-engineering/coupons"');
    expect(html).not.toContain("Publish a commercial offer");
    expect(html).not.toContain("Create campaign");
  });
});
