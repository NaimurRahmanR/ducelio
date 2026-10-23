import { describe, expect, it } from "vitest";
import {
  academyFormatPrice,
  COHORT_STAGE_IDS,
  deriveCourseLifecycle,
  DELIVERY_LABELS,
  INDIVIDUAL_STAGE_IDS,
  isPubliclyLive,
  OWNERSHIP,
  type LifecycleAcademyPackage,
  type LifecycleCohort,
  type LifecyclePackage,
} from "@/domain/admin-course-lifecycle";

// The admin course lifecycle follows each course's recorded DELIVERY MODEL
// (individual learning, cohort delivery, both, none yet, or unconfirmed),
// never its owner, title, package key or publisher.
const VERSION = "20000000-0000-4000-8000-000000000002";
const IMPORT = "10000000-0000-4000-8000-000000000002";
const ACADEMY_PACKAGE = "ef000000-0000-4000-8000-000000000001";
const PENDING = [
  "OFFICIAL_SOURCE_RECONCILIATION",
  "EXAM_ITEM_INDEPENDENT_REVIEW",
  "ACADEMIC_PASS_POLICY_APPROVAL",
  "DELIVERY_FORMAT_FEASIBILITY",
  "COURSE_PRICE_APPROVAL",
  "HOSTED_ACCEPTANCE",
  "LAB_ASSESSMENT_MODEL",
  "ASSESSMENT_FORM_VARIATION",
];
const FORMATS = [
  ["INTENSIVE_4W", 4, 3000],
  ["STANDARD_6W", 6, 2500],
  ["EXTENDED_8W", 8, 2000],
  ["FLEXIBLE_12W", 12, 2000],
].map(([formatId, weeks, amountMinor]) => ({
  formatId: formatId as string,
  weeks: weeks as number,
  sessionMinutes: 180,
  minStudyDays: 3,
  maxStudyDays: 5,
  amountMinor: amountMinor as number,
}));

const revision = (over: Partial<LifecyclePackage> = {}): LifecyclePackage => ({
  id: IMPORT,
  packageKey: "cloud-architect-academy",
  packageRevision: 2,
  status: "PUBLISHED",
  programmeId: "30000000-0000-4000-8000-000000000001",
  programmeVersionId: VERSION,
  createdAt: "2026-10-22T10:00:00Z",
  appliedAt: "2026-10-22T11:00:00Z",
  publishedAt: "2026-10-22T12:00:00Z",
  rejectedAt: null,
  ...over,
});
const academyPackage = (
  over: Partial<LifecycleAcademyPackage> = {},
  course: Partial<NonNullable<LifecycleAcademyPackage["course"]>> = {},
): LifecycleAcademyPackage => ({
  id: ACADEMY_PACKAGE,
  packageRevision: 2,
  status: "PUBLISHED",
  pendingDecisions: PENDING,
  curriculumImport: { id: IMPORT, status: "PUBLISHED" },
  course: {
    id: "ea000000-0000-4000-8000-000000000001",
    offerId: "1d000000-0000-4000-8000-000000000001",
    slug: "cloud-architect",
    offerState: "PUBLISHED",
    saleMode: "REVIEW_ONLY",
    currency: "GBP",
    formats: FORMATS,
    ...course,
  },
  ...over,
});
const cohort = (over: Partial<LifecycleCohort> = {}): LifecycleCohort => ({
  id: "40000000-0000-4000-8000-000000000001",
  title: "Spring 2027",
  startsOn: "2027-03-01",
  endsOn: null,
  status: "OPEN",
  programmeVersionId: VERSION,
  isDemo: false,
  enrolments: { active: 0, paused: 0, completed: 0, withdrawn: 0 },
  activationId: null,
  publishedOfferSlug: null,
  ...over,
});
const activation = {
  activationId: "50000000-0000-4000-8000-000000000001",
  packageKey: "cloud-architect-academy",
  packageRevision: 2,
  cohortTitle: "Spring 2027",
  cohortStartsOn: "2027-03-01",
  createdAt: "2026-10-23T09:00:00Z",
  gradingPolicyPublished: true,
  resultPolicyPublished: true,
  labPracticalsTotal: 4,
  labPracticalsConfigured: 4,
};
const life = (
  over: Partial<Parameters<typeof deriveCourseLifecycle>[0]> = {},
) =>
  deriveCourseLifecycle({
    revisions: [revision()],
    activations: [],
    offerActivations: [],
    liveOfferSlugs: [],
    cohorts: [],
    academyPackages: [academyPackage()],
    academyCatalogueSlugs: [],
    cohortEvidenceComplete: true,
    ...over,
  });
const stateOf = (stages: { id: string; state: string }[]) =>
  Object.fromEntries(stages.map((s) => [s.id, s.state]));
const asksForCohort = (l: ReturnType<typeof life>) =>
  /\/admin\/cohorts|\/admin\/activation|create a (dedicated )?delivery cohort|choose a delivery cohort/i.test(
    JSON.stringify(l.stages),
  );

describe("1 · individual learning (published, review only) — the AWS shape", () => {
  it("uses the individual-learning lifecycle and never asks for a cohort", () => {
    const l = life();
    expect(l.delivery).toBe("INDIVIDUAL");
    expect(DELIVERY_LABELS[l.delivery]).toBe("Individual learning");
    expect(l.stages.map((s) => s.id)).toEqual([...INDIVIDUAL_STAGE_IDS]);
    expect(l.cohortStages).toBeNull();
    expect(l.evidenceNote).toBeNull();
    expect(asksForCohort(l)).toBe(false);
    expect(stateOf(l.stages)).toEqual({
      "academy-upload": "complete",
      "academy-validate": "complete",
      "academy-review": "complete",
      "academy-curriculum": "complete",
      "academy-publish": "complete",
      "academy-access": "complete",
      "academy-gates": "approval",
      "academy-sale": "blocked",
    });
    expect(l.headline).toBe(
      "Published for review only — not on public sale. 8 pending decisions must be resolved first.",
    );
    const access = l.stages.find((s) => s.id === "academy-access");
    expect(access?.summary).toMatch(
      /No cohort, instructor or delivery activation/,
    );
  });

  it("shows the offer, its four priced formats, every pending decision and the record link", () => {
    const l = life();
    const a = l.individual!;
    expect(a).toMatchObject({
      slug: "cloud-architect",
      offerState: "PUBLISHED",
      saleMode: "REVIEW_ONLY",
      listed: false,
      publicSale: false,
      href: `/admin/academy-course-engineering?packageId=${ACADEMY_PACKAGE}`,
    });
    expect(a.formats?.map((f) => academyFormatPrice(f, a.currency))).toEqual([
      "GBP 30.00",
      "GBP 25.00",
      "GBP 20.00",
      "GBP 20.00",
    ]);
    expect(a.pendingDecisions).toEqual(PENDING);
    const gates = l.stages.find((s) => s.id === "academy-gates");
    for (const key of PENDING) expect(gates?.summary).toContain(key);
    expect(gates?.next?.href).toBe(a.href);
  });

  it("separates publication from public sale: never live while review only", () => {
    const l = life({ academyCatalogueSlugs: ["cloud-architect"] });
    expect(l.individual?.publicSale).toBe(false);
    expect(isPubliclyLive(l)).toBe(false);
    expect(JSON.stringify(l)).not.toMatch(/Live in the (public )?catalogue/);
  });
});

describe("delivery model is independent of owner, title and package key", () => {
  it("classifies identically whatever the key or title suggests", () => {
    for (const packageKey of [
      "aws-saa-c03-architect-academy",
      "acme-corporation-onboarding",
      "partner-org-cohort-programme",
    ]) {
      const linked = life({ revisions: [revision({ packageKey })] });
      expect(linked.delivery).toBe("INDIVIDUAL");
      const unlinked = life({
        revisions: [revision({ packageKey })],
        academyPackages: [],
      });
      expect(unlinked.delivery).toBe("NONE");
    }
  });

  it("does not attach an Academy package linked to a different curriculum import", () => {
    const l = life({
      academyPackages: [
        academyPackage({
          curriculumImport: {
            id: "10000000-0000-4000-8000-0000000000ff",
            status: "PUBLISHED",
          },
        }),
      ],
    });
    expect(l.delivery).toBe("NONE");
    expect(l.individual).toBeNull();
  });

  it("links an Academy package attached to an earlier revision of the same course", () => {
    const l = life({
      revisions: [
        revision(),
        revision({
          id: "10000000-0000-4000-8000-000000000003",
          packageRevision: 3,
          status: "APPLIED",
        }),
      ],
    });
    expect(l.delivery).toBe("INDIVIDUAL");
    expect(l.individual?.packageId).toBe(ACADEMY_PACKAGE);
  });

  it("states ownership separately from the delivery model", () => {
    expect(OWNERSHIP.kind).toBe("DUCELIO");
    expect(OWNERSHIP.basis).toMatch(
      /does not yet record organisation ownership/,
    );
    expect(Object.values(DELIVERY_LABELS).join(" ")).not.toMatch(
      /B2B|B2C|organisation|Academy/i,
    );
  });
});

describe("3 · cohort delivery (existing cohort-managed courses unchanged)", () => {
  it("keeps the cohort lifecycle for an activated delivery", () => {
    const l = life({ activations: [activation], academyPackages: [] });
    expect(l.delivery).toBe("COHORT");
    expect(l.stages.map((s) => s.id)).toEqual([...COHORT_STAGE_IDS]);
    expect(stateOf(l.stages)).toMatchObject({
      activate: "complete",
      "publish-offer": "approval",
    });
    expect(l.individual).toBeNull();
  });

  it("still guides the cohort workflow when a cohort exists but is not activated", () => {
    const l = life({ cohorts: [cohort()], academyPackages: [] });
    expect(l.delivery).toBe("COHORT");
    expect(stateOf(l.stages).activate).toBe("action");
    expect(l.stages.find((s) => s.id === "activate")?.next?.href).toBe(
      "/admin/activation",
    );
  });

  it("does not treat a demo cohort as cohort delivery", () => {
    const l = life({
      cohorts: [cohort({ isDemo: true })],
      academyPackages: [],
    });
    expect(l.delivery).toBe("NONE");
  });
});

describe("4 · shared curriculum with both delivery models", () => {
  it("shows both models independently, neither gating the other", () => {
    const l = life({ activations: [activation] });
    expect(l.delivery).toBe("BOTH");
    expect(DELIVERY_LABELS.BOTH).toBe("Both delivery models");
    expect(l.stages.map((s) => s.id)).toEqual([...INDIVIDUAL_STAGE_IDS]);
    expect(l.cohortStages?.map((s) => s.id)).toEqual([...COHORT_STAGE_IDS]);
    expect(stateOf(l.cohortStages!)).toMatchObject({ activate: "complete" });
    expect(l.stage).toBe("academy-gates");
  });

  it("keeps each model's public listing on its own track", () => {
    const l = life({
      activations: [activation],
      offerActivations: [
        { activationId: activation.activationId, publishedOfferSlug: "b2b" },
      ],
      liveOfferSlugs: ["b2b"],
    });
    expect(l.liveSlugs).toEqual(["b2b"]);
    expect(l.individual?.publicSale).toBe(false);
    expect(isPubliclyLive(l)).toBe(true);
    expect(life({ cohorts: [cohort()] }).delivery).toBe("BOTH");
  });
});

describe("5 · newly uploaded or unpublished courses", () => {
  it("asks for a pricing decision, not a cohort, before the individual offer exists", () => {
    const l = life({
      academyPackages: [
        academyPackage(
          { status: "VALIDATED" },
          {
            offerId: null,
            slug: null,
            offerState: null,
            saleMode: null,
            currency: null,
            formats: [],
          },
        ),
      ],
    });
    expect(l.delivery).toBe("INDIVIDUAL");
    expect(stateOf(l.stages)["academy-publish"]).toBe("approval");
    expect(stateOf(l.stages)["academy-access"]).toBe("blocked");
    expect(asksForCohort(l)).toBe(false);
  });

  it("asks for a delivery model, not a cohort, when no model is recorded", () => {
    const l = life({ academyPackages: [] });
    expect(l.delivery).toBe("NONE");
    expect(asksForCohort(l)).toBe(false);
    const activate = l.stages.find((s) => s.id === "activate");
    expect(activate?.state).toBe("approval");
    expect(activate?.summary).toMatch(/no delivery model is recorded/);
    expect(activate?.next?.href).toBe(
      "/admin/courses/cloud-architect-academy#delivery",
    );
    expect(l.stages.find((s) => s.id === "publish-offer")?.summary).toBe(
      "An offer follows the delivery model chosen for this course.",
    );
  });

  it("leaves an unpublished curriculum's own stages unchanged", () => {
    const l = life({
      revisions: [revision({ status: "VALIDATED", programmeVersionId: null })],
      academyPackages: [],
    });
    expect(stateOf(l.stages)).toMatchObject({
      configure: "action",
      activate: "blocked",
    });
  });
});

describe("7 · individual learning on public sale", () => {
  const open = (slugs: string[] | null) =>
    life({
      academyPackages: [
        academyPackage({ pendingDecisions: [] }, { saleMode: "PUBLIC_SALE" }),
      ],
      academyCatalogueSlugs: slugs,
    });
  it("is live only when confirmed in the Academy catalogue", () => {
    const listed = open(["cloud-architect"]);
    expect(stateOf(listed.stages)["academy-sale"]).toBe("complete");
    expect(listed.headline).toBe("On public sale in the Academy catalogue");
    expect(isPubliclyLive(listed)).toBe(true);
    expect(stateOf(open([]).stages)["academy-sale"]).toBe("attention");
    expect(stateOf(open(null).stages)["academy-sale"]).toBe("attention");
    expect(open(null).individual?.listed).toBeNull();
  });

  it("asks the owner, not a cohort, once decisions are resolved but sale is closed", () => {
    const l = life({
      academyPackages: [academyPackage({ pendingDecisions: [] })],
    });
    expect(stateOf(l.stages)["academy-gates"]).toBe("complete");
    expect(stateOf(l.stages)["academy-sale"]).toBe("approval");
  });
});

describe("8 · archived and rejected", () => {
  it("flags an archived individual-learning offer", () => {
    const l = life({
      academyPackages: [academyPackage({}, { offerState: "ARCHIVED" })],
    });
    expect(l.delivery).toBe("INDIVIDUAL");
    expect(stateOf(l.stages)["academy-publish"]).toBe("attention");
    expect(l.stageState).toBe("attention");
    expect(isPubliclyLive(l)).toBe(false);
  });

  it("flags a rejected Academy package without falling back to cohort delivery", () => {
    const l = life({
      academyPackages: [
        academyPackage(
          { status: "REJECTED" },
          { offerId: null, slug: null, offerState: null, saleMode: null },
        ),
      ],
    });
    expect(l.delivery).toBe("INDIVIDUAL");
    expect(stateOf(l.stages)["academy-validate"]).toBe("attention");
    expect(stateOf(l.stages)["academy-publish"]).toBe("blocked");
    expect(asksForCohort(l)).toBe(false);
  });

  it("flags a rejected curriculum revision", () => {
    const l = life({
      revisions: [revision({ status: "REJECTED", programmeVersionId: null })],
      academyPackages: [],
    });
    expect(stateOf(l.stages).validate).toBe("attention");
  });
});

describe("unavailable or incomplete classification evidence", () => {
  it("never defaults to cohort delivery when individual-learning evidence is unreadable", () => {
    for (const academyPackages of [null, undefined]) {
      const l = life({ academyPackages });
      expect(l.delivery).toBe("UNCONFIRMED");
      expect(asksForCohort(l)).toBe(false);
      expect(l.evidenceNote).toMatch(/individual-learning \(Academy\)/);
      expect(stateOf(l.stages).activate).toBe("attention");
    }
  });

  it("never defaults to cohort delivery when cohort evidence is unreadable", () => {
    const l = life({ academyPackages: [], cohortEvidenceComplete: false });
    expect(l.delivery).toBe("UNCONFIRMED");
    expect(asksForCohort(l)).toBe(false);
    expect(l.evidenceNote).toMatch(/cohort-delivery/);
  });

  it("keeps a recorded model but says the other could not be checked", () => {
    const individual = life({ cohortEvidenceComplete: false });
    expect(individual.delivery).toBe("INDIVIDUAL");
    expect(individual.evidenceNote).toMatch(/cohort-delivery/);
    const cohortOnly = life({
      activations: [activation],
      academyPackages: null,
    });
    expect(cohortOnly.delivery).toBe("COHORT");
    expect(cohortOnly.evidenceNote).toMatch(/individual-learning/);
  });
});

describe("scale: more than 100 individual-learning courses", () => {
  it("classifies every course from one evidence set, with no listing window", () => {
    const n = 250;
    const id = (i: number, base: string) =>
      `${base}${i.toString(16).padStart(12, "0")}`;
    const evidence = Array.from({ length: n }, (_, i) =>
      academyPackage({
        id: id(i, "ef000000-0000-4000-8000-"),
        curriculumImport: {
          id: id(i, "10000000-0000-4000-8000-"),
          status: "PUBLISHED",
        },
      }),
    );
    const deliveries = Array.from(
      { length: n },
      (_, i) =>
        life({
          revisions: [
            revision({
              id: id(i, "10000000-0000-4000-8000-"),
              packageKey: `course-${i}`,
            }),
          ],
          academyPackages: evidence,
        }).delivery,
    );
    expect(deliveries.filter((d) => d === "INDIVIDUAL")).toHaveLength(n);
  });
});
