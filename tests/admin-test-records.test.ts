import { beforeEach, describe, expect, it, vi } from "vitest";

// Business figures versus acceptance-test records. The governed reads are
// stubbed with a shared environment's mix of real and acceptance records; the
// real aggregation decides what counts as business.
const m = vi.hoisted(() => ({
  actor: {
    id: "60000000-0000-4000-8000-000000000001",
    displayName: "Avery Admin",
    roles: ["ACADEMIC_ADMIN"] as string[],
  },
  packages: vi.fn(),
  cohorts: vi.fn(),
  operations: vi.fn(),
  campaigns: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/identity", () => ({
  requireActor: async () => m.actor,
  requireAnyRole: async () => m.actor,
}));
vi.mock("@/server/staff", () => ({
  getAdminOverview: async () => ({
    counts: [2, 40, 20, 3],
    programmes: [],
    audit: [],
  }),
}));
vi.mock("@/server/course-engineering", () => ({
  listCoursePackages: m.packages,
  getCoursePackageTestStatus: async () => ({ status: null }),
  getCoursePackagePreview: vi.fn(),
}));
vi.mock("@/server/academic-agent-config", () => ({
  listAgentConfigs: vi.fn(),
}));
vi.mock("@/server/course-activation", () => ({
  listCommercialV1Activations: async () => ({ activations: [] }),
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1Campaigns: m.campaigns,
  listCommercialV1OfferActivations: async () => [],
  listCommercialV1Offers: async () => [],
}));
vi.mock("@/server/commercial-v1-commerce/operations", () => ({
  listCommerceOperations: m.operations,
}));
vi.mock("@/server/cohorts", () => ({ getCohortWorkspace: m.cohorts }));
vi.mock("@/server/agent-control-plane", () => ({
  describeProductionProfiles: () => [],
  providerCredentialReadiness: () => ({}),
}));

import { getDashboardData } from "@/server/admin-control-centre";
import {
  isAcceptanceCourse,
  isAcceptanceOffer,
  isNonBusinessCohort,
} from "@/domain/admin-test-records";

const pkg = (key: string, n: number) => ({
  id: `10000000-0000-4000-8000-00000000000${n}`,
  package_key: key,
  package_revision: 1,
  status: "PUBLISHED",
  programme_id: null,
  programme_version_id: null,
  created_at: "2026-10-01T00:00:00Z",
  applied_at: "2026-10-01T00:00:00Z",
  published_at: "2026-10-01T00:00:00Z",
  rejected_at: null,
});
const cohort = (title: string, active: number, isDemo = false) => ({
  id: crypto.randomUUID(),
  title,
  startsOn: "2026-10-13",
  endsOn: null,
  status: "OPEN",
  programmeVersionId: null,
  isDemo,
  enrolments: { active, paused: 0, completed: 0, withdrawn: 0 },
  activationId: null,
  publishedOfferSlug: null,
});
const order = (slug: string, state: string) => ({
  id: crypto.randomUUID(),
  title: "Learner",
  subtitle: slug,
  state,
  occurredAt: "2026-10-14T10:00:00Z",
  orderId: null,
  entitlementId: null,
  learnerId: null,
  offerId: null,
  reason: null,
});

beforeEach(() => {
  m.packages.mockResolvedValue([
    pkg("security-plus-sy0-701", 1),
    pkg("acceptance-1791", 2),
    pkg("acceptance-1792", 3),
  ]);
  m.cohorts.mockResolvedValue({
    workspace: {
      versions: [],
      cohorts: [
        cohort("October 2026", 7),
        cohort("Acceptance cohort 1791", 2),
        cohort("Staging rehearsal", 1),
        cohort("Demo cohort", 50, true),
      ],
    },
  });
  m.operations.mockImplementation(async ({ view }: { view: string }) => ({
    hasMore: false,
    rows:
      view === "orders"
        ? [
            order("security-plus-oct", "FULFILLED"),
            order("acceptance-journey-1791", "FULFILLED"),
            order("acceptance-revocation-1791", "PENDING"),
          ]
        : [],
  }));
  m.campaigns.mockResolvedValue([
    { code: "LAUNCH", offerSlug: "security-plus-oct", state: "ACTIVE" },
    { code: "ACC1", offerSlug: "acceptance-journey-1791", state: "ACTIVE" },
  ]);
});

describe("recognising acceptance-test records", () => {
  it("matches the acceptance harness's naming and nothing else", () => {
    expect(
      isAcceptanceCourse({ packageKey: "acceptance-1791", title: "X" }),
    ).toBe(true);
    expect(
      isAcceptanceCourse({ packageKey: "x", title: "Acceptance Run 1791" }),
    ).toBe(true);
    expect(
      isAcceptanceCourse({
        packageKey: "security-plus-sy0-701",
        title: "CompTIA Security+ (SY0-701)",
      }),
    ).toBe(false);
    // A real course that merely mentions acceptance is not a test record.
    expect(
      isAcceptanceCourse({
        packageKey: "user-acceptance-testing",
        title: "User Acceptance Testing Fundamentals",
      }),
    ).toBe(false);
    expect(
      isAcceptanceOffer({
        slug: "security-plus-oct",
        course: "CompTIA Security+",
        cohort: "October 2026",
      }),
    ).toBe(false);
    expect(
      isAcceptanceOffer({
        slug: "security-plus-oct",
        course: "CompTIA Security+",
        cohort: "Acceptance cohort 1791-security",
      }),
    ).toBe(true);
    expect(isNonBusinessCohort({ title: "October 2026", isDemo: false })).toBe(
      false,
    );
    expect(isNonBusinessCohort({ title: "Any", isDemo: true })).toBe(true);
  });
});

describe("dashboard business figures", () => {
  it("excludes acceptance-test records and counts them separately", async () => {
    const data = await getDashboardData();
    expect(data.enrolments).toEqual({
      ok: true,
      data: {
        active: 7,
        paused: 0,
        completed: 0,
        withdrawn: 0,
        openCohorts: 1,
        cohorts: 1,
      },
    });
    expect(
      data.orders.ok && data.orders.data.rows.map((r) => r.subtitle),
    ).toEqual(["security-plus-oct"]);
    expect(data.campaigns).toEqual({
      ok: true,
      data: { active: 1, archived: 0 },
    });
    expect(
      data.catalogue.ok &&
        data.catalogue.data.courses.map((c) => [c.packageKey, c.testRecord]),
    ).toEqual(
      expect.arrayContaining([
        ["security-plus-sy0-701", false],
        ["acceptance-1791", true],
        ["acceptance-1792", true],
      ]),
    );
    // Demo cohorts are excluded but are not acceptance-test records.
    expect(data.testRecords).toEqual({
      ok: true,
      data: {
        courses: 2,
        cohorts: 2,
        enrolments: 3,
        orders: 2,
        campaigns: 1,
      },
    });
  });

  it("reports an unreadable source as unknown, not as zero test records", async () => {
    m.operations.mockRejectedValue(new Error("unavailable"));
    m.campaigns.mockRejectedValue(new Error("unavailable"));
    const data = await getDashboardData();
    expect(data.orders.ok).toBe(false);
    expect(data.testRecords.ok && data.testRecords.data.orders).toBeNull();
    expect(data.testRecords.ok && data.testRecords.data.campaigns).toBeNull();
  });
});
