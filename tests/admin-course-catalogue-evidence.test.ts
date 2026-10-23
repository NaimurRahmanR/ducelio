import { beforeEach, describe, expect, it, vi } from "vitest";

// getCourseCatalogue's delivery-model evidence, through the real server
// aggregation and lifecycle. Only the governed reads are stubbed.
const IMPORT = "50b5809a-e04d-46e5-8d28-4030e4e15091";
const PACKAGE = "ef6b8a49-849f-4488-84e6-0ebcaa2644f8";
const OTHER_IMPORT = "10000000-0000-4000-8000-0000000000b1";
const m = vi.hoisted(() => ({
  evidence: vi.fn(),
  list: vi.fn(),
  activations: vi.fn(),
  cohorts: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireAnyRole: async () => ({ id: "admin", roles: ["ACADEMIC_ADMIN"] }),
  requireActor: async () => ({ id: "admin", roles: ["ACADEMIC_ADMIN"] }),
}));
vi.mock("@/server/staff", () => ({
  getAdminOverview: async () => ({ programmes: [] }),
}));
vi.mock("@/server/course-engineering", () => ({
  listCoursePackages: async () =>
    [
      [IMPORT, "aws-saa-c03-architect-academy"],
      [OTHER_IMPORT, "other-curriculum"],
    ].map(([id, key]) => ({
      id,
      package_key: key,
      package_revision: 2,
      status: "PUBLISHED",
      programme_id: null,
      programme_version_id: `${id.slice(0, 35)}9`,
      created_at: "2026-10-22T10:00:00Z",
      applied_at: "2026-10-22T11:00:00Z",
      published_at: "2026-10-22T12:00:00Z",
      rejected_at: null,
    })),
  getCoursePackageTestStatus: async () => null,
  getCoursePackagePreview: async () => null,
}));
vi.mock("@/server/course-activation", () => ({
  listCommercialV1Activations: m.activations,
}));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1OfferActivations: async () => [],
  listCommercialV1Offers: async () => [],
  listCommercialV1Campaigns: async () => [],
}));
vi.mock("@/server/commercial-v1-commerce/operations", () => ({
  listCommerceOperations: async () => ({ rows: [], hasMore: false }),
}));
vi.mock("@/server/cohorts", () => ({ getCohortWorkspace: m.cohorts }));
vi.mock("@/server/academic-agent-config", () => ({
  listAgentConfigs: async () => [],
}));
vi.mock("@/server/academy-course-engineering", () => ({
  getAcademyDeliveryEvidence: m.evidence,
  listAcademyPackages: m.list,
}));
vi.mock("@/server/academy-delivery", () => ({
  listAcademyCatalogue: async () => [],
}));

import { getCourseCatalogue } from "@/server/admin-control-centre";
import { AcademyError } from "@/domain/academy-delivery";

const course = {
  id: "eaa1f7ba-8a20-42a5-a455-1c94ae2f256b",
  offerId: "1d61a29a-ea1e-4bf6-beec-6de79048dfb8",
  slug: "aws-solutions-architect-associate",
  offerState: "PUBLISHED" as const,
  saleMode: "REVIEW_ONLY" as const,
};
const awsListRow = {
  id: PACKAGE,
  packageKey: "aws-saa-c03-architect-academy",
  packageRevision: 2,
  status: "PUBLISHED",
  pendingDecisions: ["COURSE_PRICE_APPROVAL"],
  curriculumImport: {
    id: IMPORT,
    status: "PUBLISHED",
    programmeVersionId: null,
  },
  course,
};
const filler = (i: number) => ({
  ...awsListRow,
  id: `ef000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
  packageKey: `filler-${i}`,
  curriculumImport: {
    id: `10000000-0000-4000-8000-${(1000 + i).toString(16).padStart(12, "0")}`,
    status: "PUBLISHED",
    programmeVersionId: null,
  },
  course: null,
});
const byKey = async () =>
  Object.fromEntries(
    (await getCourseCatalogue()).courses.map((c) => [
      c.packageKey,
      c.lifecycle,
    ]),
  );

beforeEach(() => {
  m.activations.mockResolvedValue({ activations: [] });
  m.cohorts.mockResolvedValue({ workspace: { cohorts: [], versions: [] } });
  m.list.mockReset();
  m.evidence.mockReset();
  m.evidence.mockResolvedValue({
    links: [
      {
        curriculumImportId: IMPORT,
        curriculumStatus: "PUBLISHED",
        packageId: PACKAGE,
        packageRevision: 2,
        status: "PUBLISHED",
        pendingDecisions: ["COURSE_PRICE_APPROVAL"],
        course: {
          ...course,
          currency: "GBP",
          formats: [
            {
              formatId: "STANDARD_6W",
              weeks: 6,
              sessionMinutes: 240,
              minStudyDays: 3,
              maxStudyDays: 5,
              amountMinor: 2500,
            },
          ],
        },
      },
    ],
    packagesWithoutCurriculum: 2,
  });
});

describe("course catalogue delivery evidence", () => {
  it("classifies from the evidence read for exactly the listed imports", async () => {
    const catalogue = await getCourseCatalogue();
    expect(m.evidence).toHaveBeenCalledTimes(1);
    expect(m.evidence.mock.calls[0][0]).toEqual([IMPORT, OTHER_IMPORT]);
    expect(m.list).not.toHaveBeenCalled();
    const life = Object.fromEntries(
      catalogue.courses.map((c) => [c.packageKey, c.lifecycle]),
    );
    expect(life["aws-saa-c03-architect-academy"].delivery).toBe("INDIVIDUAL");
    expect(life["aws-saa-c03-architect-academy"].individual?.formats).toEqual([
      expect.objectContaining({ amountMinor: 2500 }),
    ]);
    expect(life["other-curriculum"].delivery).toBe("NONE");
    expect(catalogue.academyInProgress).toBe(2);
    expect(catalogue.sources.academy).toBe(true);
  });

  it("falls back to the register list on a database without migration 066", async () => {
    m.evidence.mockRejectedValue(new AcademyError("NOT_INSTALLED"));
    m.list.mockResolvedValue([awsListRow]);
    const life = await byKey();
    expect(life["aws-saa-c03-architect-academy"].delivery).toBe("INDIVIDUAL");
    // Prices are not in the list: shown as unreadable, never invented.
    expect(life["aws-saa-c03-architect-academy"].individual?.formats).toBe(
      null,
    );
    // The short list is complete, so the other course has no model yet.
    expect(life["other-curriculum"].delivery).toBe("NONE");
  });

  it("never treats a full 100-row fallback window as proof of 'not individual'", async () => {
    m.evidence.mockRejectedValue(new AcademyError("NOT_INSTALLED"));
    m.list.mockResolvedValue([
      awsListRow,
      ...Array.from({ length: 99 }, (_, i) => filler(i)),
    ]);
    const catalogue = await getCourseCatalogue();
    const life = Object.fromEntries(
      catalogue.courses.map((c) => [c.packageKey, c.lifecycle]),
    );
    expect(life["aws-saa-c03-architect-academy"].delivery).toBe("INDIVIDUAL");
    expect(life["other-curriculum"].delivery).toBe("UNCONFIRMED");
    expect(JSON.stringify(life["other-curriculum"].stages)).not.toMatch(
      /\/admin\/cohorts|create a (dedicated )?delivery cohort/i,
    );
    expect(catalogue.academyInProgress).toBeNull();
  });

  it("marks every course without recorded cohort delivery unconfirmed when the evidence read fails", async () => {
    m.evidence.mockRejectedValue(new AcademyError("SERVICE_UNAVAILABLE"));
    const catalogue = await getCourseCatalogue();
    expect(m.list).not.toHaveBeenCalled();
    expect(catalogue.sources.academy).toBe(false);
    expect(catalogue.courses.map((c) => c.lifecycle.delivery).sort()).toEqual([
      "UNCONFIRMED",
      "UNCONFIRMED",
    ]);
  });

  it("marks a course unconfirmed when a cohort-delivery read fails", async () => {
    m.cohorts.mockRejectedValue(new Error("unavailable"));
    const life = await byKey();
    expect(life["aws-saa-c03-architect-academy"].delivery).toBe("INDIVIDUAL");
    expect(life["aws-saa-c03-architect-academy"].evidenceNote).toMatch(
      /cohort-delivery/,
    );
    expect(life["other-curriculum"].delivery).toBe("UNCONFIRMED");
  });
});
