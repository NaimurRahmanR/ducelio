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
// An Academy (B2C) course: the Academy package's recorded curriculum import
// is this course's published revision. Published offer, review only.
const ACADEMY_PACKAGE_ID = "ef6b8a49-0000-4000-8000-000000000001";
const academyCourse = () => ({
  packageKey: "cloud-architect-academy",
  title: "Cloud Architect Academy",
  versionLabel: "Revision 2",
  testRecord: false,
  lifecycle: deriveCourseLifecycle({
    revisions: [
      {
        id: "10000000-0000-4000-8000-0000000000a2",
        packageKey: "cloud-architect-academy",
        packageRevision: 2,
        status: "PUBLISHED",
        programmeId: null,
        programmeVersionId: "20000000-0000-4000-8000-0000000000a2",
        createdAt: "2026-10-22T10:00:00Z",
        appliedAt: "2026-10-22T11:00:00Z",
        publishedAt: "2026-10-22T12:00:00Z",
        rejectedAt: null,
      },
    ],
    activations: [],
    offerActivations: [],
    liveOfferSlugs: [],
    cohorts: [],
    academyPackages: [
      {
        id: ACADEMY_PACKAGE_ID,
        packageRevision: 2,
        status: "PUBLISHED",
        pendingDecisions: ["COURSE_PRICE_APPROVAL", "HOSTED_ACCEPTANCE"],
        curriculumImport: {
          id: "10000000-0000-4000-8000-0000000000a2",
          status: "PUBLISHED",
        },
        course: {
          id: "ea000000-0000-4000-8000-000000000001",
          offerId: "1d000000-0000-4000-8000-000000000001",
          slug: "cloud-architect",
          offerState: "PUBLISHED",
          saleMode: "REVIEW_ONLY",
          currency: "GBP",
          formats: [],
        },
      },
    ],
    academyCatalogueSlugs: [],
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
  it("offers exactly the five destinations to a course administrator", async () => {
    const html = renderToStaticMarkup(
      await DashboardPage({ searchParams: Promise.resolve({}) }),
    );
    expect(navHrefs(html)).toEqual([
      "/admin",
      "/admin/courses",
      "/admin/operations-engineer",
      "/admin/sales",
      "/admin/academy",
    ]);
  });

  it("shows a registrar only the destinations their role can use", async () => {
    m.actor.roles = ["REGISTRAR"];
    m.dashboard.mockResolvedValue(dashboard({ courseAdmin: false }));
    const html = renderToStaticMarkup(
      await DashboardPage({ searchParams: Promise.resolve({}) }),
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

  it("keeps course workspaces behind the course administrator roles", async () => {
    m.actor.roles = ["REGISTRAR"];
    for (const page of [
      CoursesPage({ searchParams: Promise.resolve({}) }),
      SalesPage({ searchParams: Promise.resolve({}) }),
      OperationsPage({ searchParams: Promise.resolve({}) }),
    ]) {
      const plain = text(renderToStaticMarkup(await page));
      expect(plain).toContain("You do not have access to this workspace");
      expect(plain).toContain("No records from it were loaded");
    }
    expect(m.catalogue).not.toHaveBeenCalled();
    expect(m.offersView).not.toHaveBeenCalled();
    expect(m.options).not.toHaveBeenCalled();
  });
});

describe("dashboard", () => {
  it("shows real metrics and never invents revenue", async () => {
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("Payment exceptions 1");
    expect(plain).toContain("Active enrolments 9");
    expect(plain).toContain("Settled revenue is not reported");
    expect(plain).toContain(
      "A pending order is a payment attempt, not revenue.",
    );
    expect(plain).not.toMatch(/£\d/);
  });

  it("keeps acceptance-test records out of the business figures and says so", async () => {
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("Courses 1");
    expect(plain).toContain("Demo and acceptance-test cohorts excluded");
    expect(plain).toContain(
      "Acceptance-test and staging records (excluded) Shared-environment test traffic. None of it is counted in the figures above.",
    );
    expect(plain).toContain("Orders (latest 25) 6");
    expect(plain).toContain("The database has no test flag");
    expect(plain).toContain(
      "Learner accounts 12 All learner profiles, including acceptance-test accounts",
    );
  });

  it("never counts an acceptance-test course as a business course", async () => {
    m.dashboard.mockResolvedValue(
      dashboard({
        catalogue: {
          ok: true,
          data: {
            courses: [
              securityPlus(),
              {
                ...securityPlus(),
                packageKey: "acceptance-1791",
                title: "Acceptance Run 1791",
                testRecord: true,
              },
            ],
            sources: allSources,
          },
        },
      }),
    );
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("Courses 1");
    expect(plain).not.toContain("Acceptance Run 1791");
  });

  it("reports an unavailable source instead of a zero", async () => {
    m.dashboard.mockResolvedValue(
      dashboard({ orders: { ok: false }, catalogue: { ok: false } }),
    );
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain(
      "Orders could not be loaded from the governed service",
    );
    expect(plain).toContain("The course register could not be loaded");
    expect(plain).toContain("Courses —");
  });

  it("names the course decision that is waiting", async () => {
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("CompTIA Security+ (SY0-701)");
    expect(plain).toContain("Do not upload the package again");
  });
});

describe("courses", () => {
  it("explains Security+ revision 6 accurately", async () => {
    const plain = text(
      renderToStaticMarkup(
        await CoursesPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("Revision 6");
    expect(plain).toContain("Activate delivery Action needed");
    expect(plain).toContain(
      "staging or acceptance cohort and must not be used for paying learners",
    );
    // It tells the operator no new upload is needed, and never asks for one.
    expect(plain).toContain("Do not upload the package again");
    expect(plain).not.toMatch(/import a (corrected|new) revision|re-?upload/i);
  });

  it("filters the register", async () => {
    const plain = text(
      renderToStaticMarkup(
        await CoursesPage({
          searchParams: Promise.resolve({ filter: "live" }),
        }),
      ),
    );
    expect(plain).toContain("No course matches");
  });

  it("lists acceptance-test courses only under their own labelled filter", async () => {
    m.catalogue.mockResolvedValue({
      courses: [
        securityPlus(),
        {
          ...securityPlus(),
          packageKey: "acceptance-1791",
          title: "Acceptance Run 1791",
          testRecord: true,
        },
      ],
      sources: allSources,
    });
    const register = text(
      renderToStaticMarkup(
        await CoursesPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(register).toContain("All courses 1");
    expect(register).toContain(
      "Acceptance-test records 1 Excluded from every other count",
    );
    expect(register).not.toContain("Acceptance Run 1791");
    const tests = text(
      renderToStaticMarkup(
        await CoursesPage({
          searchParams: Promise.resolve({ filter: "test" }),
        }),
      ),
    );
    expect(tests).toContain("Acceptance Run 1791 Acceptance test");
    expect(tests).not.toContain("CompTIA Security+ (SY0-701)");
    expect(tests).toContain("The database has no test flag");
  });
});

describe("Academy courses in the register", () => {
  beforeEach(() => {
    m.catalogue.mockResolvedValue({
      courses: [securityPlus(), academyCourse()],
      academyInProgress: 1,
      sources: { ...allSources, academy: true, academyCatalogue: true },
    });
  });

  it("labels Academy and Organisation courses and manages the Academy one without a cohort", async () => {
    const html = renderToStaticMarkup(
      await CoursesPage({ searchParams: Promise.resolve({}) }),
    );
    const plain = text(html);
    expect(plain).toContain(
      "Cloud Architect Academy Academy · individual learners (B2C) Review only · not on sale",
    );
    expect(plain).toContain(
      "CompTIA Security+ (SY0-701) Organisation · cohort delivery (B2B)",
    );
    expect(plain).toContain("Approval gates Awaiting approval");
    expect(plain).toContain(
      "Published for review only — not on public sale. 2 pending decisions must be resolved first.",
    );
    expect(html).toContain(
      `href="/admin/academy-course-engineering?packageId=${ACADEMY_PACKAGE_ID}"`,
    );
    expect(plain).toContain(
      "1 Academy package is still in upload, validation or review",
    );
    // The Academy course's own entry has no cohort step or advice.
    const entry = plain.slice(plain.indexOf("Cloud Architect Academy Academy"));
    expect(entry).not.toContain("Activate delivery");
    expect(entry).not.toMatch(/cohort, then activate|delivery cohort/i);
  });

  it("filters and counts by recorded delivery track", async () => {
    const academy = text(
      renderToStaticMarkup(
        await CoursesPage({
          searchParams: Promise.resolve({ filter: "academy" }),
        }),
      ),
    );
    expect(academy).toContain("Academy (B2C) 1");
    expect(academy).toContain("Organisation (B2B) 1");
    expect(academy).toContain("Cloud Architect Academy");
    expect(academy).not.toContain("CompTIA Security+ (SY0-701)");
    const organisation = text(
      renderToStaticMarkup(
        await CoursesPage({
          searchParams: Promise.resolve({ filter: "organisation" }),
        }),
      ),
    );
    expect(organisation).toContain("CompTIA Security+ (SY0-701)");
    expect(organisation).not.toContain("Cloud Architect Academy");
    // A review-only course is never "Live".
    const live = text(
      renderToStaticMarkup(
        await CoursesPage({
          searchParams: Promise.resolve({ filter: "live" }),
        }),
      ),
    );
    expect(live).toContain("No course matches");
  });

  it("never counts a review-only Academy course as live on the dashboard", async () => {
    m.dashboard.mockResolvedValue(
      dashboard({
        catalogue: {
          ok: true,
          data: {
            courses: [securityPlus(), academyCourse()],
            sources: allSources,
          },
        },
      }),
    );
    const plain = text(
      renderToStaticMarkup(
        await DashboardPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain("0 live in the public catalogue");
    expect(plain).toContain("Academy: Approval gates");
  });
});

describe("operations engineer", () => {
  it("says truthfully that AI interpretation is unavailable and keeps every operation usable", async () => {
    const html = renderToStaticMarkup(
      await OperationsPage({ searchParams: Promise.resolve({}) }),
    );
    const plain = text(html);
    expect(plain).toContain("AI interpretation not configured");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(plain).toContain("Inspect a course's lifecycle");
    expect(plain).toContain("Publish a commercial offer");
    expect(plain).toContain("Run SQL or shell commands, or read secrets");
  });

  it("offers no change it cannot protect against duplicates, and says where it went", async () => {
    const html = renderToStaticMarkup(
      await OperationsPage({
        searchParams: Promise.resolve({ action: "archive_offer" }),
      }),
    );
    const chips = [...html.matchAll(/class="oe-chip[^"]*"[^>]*>([^<]+)</g)].map(
      (x) => x[1],
    );
    expect(chips).toContain("Publish a commercial offer");
    expect(chips).not.toContain("Archive a commercial offer");
    expect(chips).not.toContain("Open, close or complete a cohort");
    expect(chips.some((c) => /test/i.test(c))).toBe(false);
    // A link asking for a disabled change opens a safe default instead.
    expect(html).toMatch(/aria-checked="true"[^>]*>Inspect a course/);
    const plain = text(html);
    expect(plain).toContain("Not available here yet.");
    expect(html).toContain('href="/admin/sales?tab=offers"');
    expect(html).toContain('href="/admin/course-engineering"');
    expect(html).toContain('href="/admin/cohorts"');
  });

  it("opens a contextual operation with its record preselected and flags staging cohorts", async () => {
    const html = renderToStaticMarkup(
      await OperationsPage({
        searchParams: Promise.resolve({
          action: "publish_offer",
          activationId: "a1",
        }),
      }),
    );
    expect(html).toContain('aria-checked="true"');
    expect(text(html)).toContain("Publish a commercial offer");
    expect(html).toMatch(/<option value="a1" selected="">[^<]*⚠/);
    expect(html).toContain("Prepare proposal");
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

describe("sales and commerce", () => {
  it("shows exact published prices and separates acceptance-test offers", async () => {
    const testOffer = (await m.offersView()).rows[0];
    m.offersView.mockResolvedValue({
      hasMore: false,
      rows: [
        {
          ...testOffer,
          id: "o2",
          offerId: "o2",
          title: "CompTIA Security+ (SY0-701)",
          subtitle: "security-plus-oct / October 2026 / 24900 GBP",
        },
        testOffer,
      ],
    });
    const plain = text(
      renderToStaticMarkup(
        await SalesPage({ searchParams: Promise.resolve({}) }),
      ),
    );
    expect(plain).toContain(
      "Published offers 1 Business offers · test records excluded",
    );
    expect(plain).toContain("Acceptance-test offers 1 Still published");
    // The test offer is listed only in its own labelled section.
    const business = plain.slice(
      plain.indexOf("Offers and pricing Every"),
      plain.indexOf("Acceptance-test and staging offers Offers created"),
    );
    expect(business).toContain("£249.00");
    expect(business).not.toContain("Acceptance Run 1791");
    expect(plain).toContain("Show 1 acceptance-test and staging offer");
    expect(plain).toContain("£1.00");
    expect(plain).toContain("Archiving them is a deliberate decision");
  });

  it("keeps acceptance-test campaigns out of sales performance", async () => {
    m.campaigns.mockResolvedValue([
      {
        code: "ACCEPT1791",
        offerSlug: "acceptance-run-1791",
        redemptionCount: 3,
        state: "ACTIVE",
      },
    ]);
    const plain = text(
      renderToStaticMarkup(
        await SalesPage({
          searchParams: Promise.resolve({ tab: "performance" }),
        }),
      ),
    );
    expect(plain).toContain("Active campaigns 0 Test campaigns excluded");
    expect(plain).toContain("No business campaigns yet");
    expect(plain).toContain(
      "1 acceptance-test campaigns exist and are not counted.",
    );
    expect(plain).not.toContain("ACCEPT1791");
  });

  it("does not report revenue it cannot substantiate", async () => {
    const plain = text(
      renderToStaticMarkup(
        await SalesPage({
          searchParams: Promise.resolve({ tab: "performance" }),
        }),
      ),
    );
    expect(plain).toContain("Settled revenue is not reported here yet");
    expect(plain).toContain(
      "totals verified PAID payment events minus recorded refunds",
    );
  });
});
