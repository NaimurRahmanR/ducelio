import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, courseStage } from "@/domain/unified-course-lifecycle";

const DUCELIO = "00000000-0000-4000-8000-000000000001";
const REV3 = "10000000-0000-4000-8000-000000000003";
const REV2 = "10000000-0000-4000-8000-000000000002";
const m = vi.hoisted(() => ({
  access: null as unknown,
  packages: [] as Record<string, unknown>[],
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/app/admin/course-engineering/review/actions", () => ({
  resolveDecisionsAction: vi.fn(),
}));
vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: async () => m.access,
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: async () => m.packages,
  getUnifiedAcademicResolutions: async (id: string) =>
    id === REV3
      ? [
          {
            key: "COURSE_PRICE_APPROVAL",
            evidenceReference: "TEST-OWNER-PRICE-0001",
            rationale: "TEST ONLY synthetic owner approval of the price.",
            reviewedBy: "60000000-0000-4000-8000-000000000001",
            reviewedAt: "2026-10-26T10:00:00Z",
          },
        ]
      : [],
}));
vi.mock("@/server/academy-course-engineering", () => ({
  getAcademyPackageReview: async () => ({
    id: REV3,
    status: "VALIDATED",
    review: {
      title: "AWS SAA-C03",
      demoContent: false,
      totals: { modules: 5, lessons: 22 },
      labs: [{ graded: false }],
      assessments: [
        {
          ref: "final",
          title: "Final mock",
          kind: "FINAL",
          questionCount: 65,
          durationMinutes: 130,
          attemptsAllowed: 1,
          weightBp: 5500,
        },
      ],
      sourceReferences: [
        {
          key: "aws-guide",
          title: "AWS exam guide",
          publisher: "AWS",
          version: "SAA-C03",
        },
      ],
      pendingDecisions: [
        {
          key: "EXAM_ITEM_INDEPENDENT_REVIEW",
          summary: "Independently review all assessment items.",
        },
      ],
    },
  }),
}));

import Page from "@/app/admin/course-engineering/review/page";

const pkg = (id: string, revision: number) => ({
  id,
  organisationId: DUCELIO,
  organisationName: "Ducelio",
  packageKey: "aws-saa-c03-architect-academy",
  packageRevision: revision,
  status: "VALIDATED",
  title: "AWS SAA-C03",
  pendingDecisions: ["EXAM_ITEM_INDEPENDENT_REVIEW"],
  rejectedReason: null,
  curriculumImport: null,
  course: null,
});
const render = async (packageId?: string) =>
  renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve({ packageId }) }),
  );
const access = (canReview: boolean) => ({
  actor: { id: "a", displayName: "Avery", roles: ["ACADEMIC_ADMIN"] },
  allowed: true,
  organisations: [
    {
      id: DUCELIO,
      name: "Ducelio",
      slug: "ducelio",
      canManage: true,
      canReview,
      canOwn: false,
    },
  ],
});

beforeEach(() => {
  m.access = access(true);
  m.packages = [pkg(REV3, 3), pkg(REV2, 2)];
});

describe("course academic review workspace", () => {
  it("is its own workspace that shows decisions, never cohort grading", async () => {
    const html = await render(REV3);
    expect(html).toContain("Course academic review");
    expect(html).toContain("EXAM_ITEM_INDEPENDENT_REVIEW");
    expect(html).toContain("pending");
    expect(html).toContain("resolved in revision 3");
    expect(html).toContain("TEST-OWNER-PRICE-0001");
    expect(html).toContain("65 items, 130 minutes, 1 attempt");
    expect(html).toContain("AWS exam guide");
    expect(html).toMatch(
      /href="\/admin\/academic-review"[^>]*>Learner result review/,
    );
    expect(html).not.toMatch(/cohort/i);
  });

  it("offers the decision form only to an organisation reviewer, unchecked", async () => {
    const html = await render(REV3);
    expect(html).toContain("Record reviewed decisions");
    expect(html).not.toMatch(/<input[^>]*checked/);
    m.access = access(false);
    const denied = await render(REV3);
    expect(denied).toContain("has no academic review authority");
    expect(denied).not.toContain('name="decision"');
  });

  it("never resolves on a superseded revision", async () => {
    const html = await render(REV2);
    expect(html).toContain("This is not the latest revision");
    expect(html).not.toContain('name="decision"');
  });

  it("refuses an actor without course access", async () => {
    m.access = {
      actor: { id: "a", displayName: "L", roles: ["STUDENT"] },
      allowed: false,
      organisations: [],
    };
    expect(await render(REV3)).toContain(
      "You do not have access to this workspace",
    );
  });
});

describe("course lifecycle stages", () => {
  const base = {
    rejectedReason: null,
    curriculumImport: null,
    pendingDecisions: [],
  };
  it("labels a validated revision with pending decisions as awaiting review, not failed", () => {
    expect(
      courseStage({
        ...base,
        status: "VALIDATED",
        pendingDecisions: ["A", "B"],
      }),
    ).toMatchObject({
      stage: "AWAITING_REVIEW",
      label: "Structurally validated · awaiting academic review",
    });
  });
  it.each([
    ["UPLOADED", [], null, "UPLOADED"],
    ["VALIDATED", [], null, "APPROVED_FOR_PUBLICATION"],
    [
      "VALIDATED",
      [],
      { id: "i", status: "APPLIED", programmeVersionId: null },
      "PUBLICATION_INCOMPLETE",
    ],
    ["PUBLISHED", [], null, "PUBLISHED"],
    ["REJECTED", [], null, "FAILED"],
  ] as const)(
    "%s → %s",
    (status, pendingDecisions, curriculumImport, stage) => {
      expect(
        courseStage({
          status,
          pendingDecisions: [...pendingDecisions],
          curriculumImport,
          rejectedReason: "x",
        }).stage,
      ).toBe(stage);
    },
  );
  it("compares JSON independent of key order", () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});
