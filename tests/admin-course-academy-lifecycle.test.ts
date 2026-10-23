import { describe, expect, it } from "vitest";
import {
  ACADEMY_STAGE_IDS,
  academyFormatPrice,
  deriveCourseLifecycle,
  isPubliclyLive,
  ORGANISATION_STAGE_IDS,
  type LifecycleAcademyPackage,
  type LifecycleCohort,
  type LifecyclePackage,
} from "@/domain/admin-course-lifecycle";

// The Academy (B2C) track of the admin course lifecycle. The course type is
// derived only from recorded relationships (the Academy package's recorded
// curriculum import), never from a title, key or vendor name.
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
  ["INTENSIVE_4W", 4, 30000],
  ["STANDARD_6W", 6, 35000],
  ["EXTENDED_8W", 8, 40000],
  ["FLEXIBLE_12W", 12, 45000],
].map(([formatId, weeks, amountMinor]) => ({
  formatId: formatId as string,
  weeks: weeks as number,
  sessionMinutes: 90,
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
    ...over,
  });
const stateOf = (l: ReturnType<typeof life>) =>
  Object.fromEntries(l.stages.map((s) => [s.id, s.state]));

describe("Academy (B2C) course classification", () => {
  it("manages a published review-only Academy course through the individual-learning lifecycle", () => {
    const l = life();
    expect(l.delivery).toBe("ACADEMY");
    expect(l.stages.map((s) => s.id)).toEqual([...ACADEMY_STAGE_IDS]);
    expect(l.organisationStages).toBeNull();
    expect(stateOf(l)).toEqual({
      "academy-upload": "complete",
      "academy-validate": "complete",
      "academy-review": "complete",
      "academy-curriculum": "complete",
      "academy-publish": "complete",
      "academy-access": "complete",
      "academy-gates": "approval",
      "academy-sale": "blocked",
    });
    expect(l.stage).toBe("academy-gates");
    expect(l.stageState).toBe("approval");
    expect(l.headline).toBe(
      "Published for review only — not on public sale. 8 pending decisions must be resolved first.",
    );
  });

  it("never gives cohort or activation advice for an Academy course", () => {
    const text = JSON.stringify(life());
    expect(text).not.toMatch(/\/admin\/cohorts|\/admin\/activation/);
    expect(text).not.toMatch(/create a (delivery )?cohort/i);
    expect(text).not.toContain("Activate delivery");
    expect(text).not.toContain("An offer needs an activated delivery first");
    const access = life().stages.find((s) => s.id === "academy-access");
    expect(access?.summary).toMatch(/personal schedule/);
    expect(access?.summary).toMatch(
      /No cohort, instructor or delivery activation/,
    );
  });

  it("shows the published offer, its four priced formats and every pending decision", () => {
    const a = life().academy;
    expect(a).toMatchObject({
      slug: "cloud-architect",
      offerState: "PUBLISHED",
      saleMode: "REVIEW_ONLY",
      currency: "GBP",
      listed: false,
      publicSale: false,
    });
    expect(a?.formats?.map((f) => academyFormatPrice(f, a.currency))).toEqual([
      "GBP 300.00",
      "GBP 350.00",
      "GBP 400.00",
      "GBP 450.00",
    ]);
    expect(a?.pendingDecisions).toEqual(PENDING);
    const gates = life().stages.find((s) => s.id === "academy-gates");
    for (const key of PENDING) expect(gates?.summary).toContain(key);
    const publish = life().stages.find((s) => s.id === "academy-publish");
    expect(publish?.summary).toContain("4 priced formats");
  });

  it("links to the Academy Course Engineering record by its recorded package id", () => {
    const l = life();
    const href = `/admin/academy-course-engineering?packageId=${ACADEMY_PACKAGE}`;
    expect(l.academy?.href).toBe(href);
    expect(l.stages.find((s) => s.id === "academy-gates")?.next?.href).toBe(
      href,
    );
  });

  it("separates publication from public sale: never live while review-only", () => {
    const l = life({ academyCatalogueSlugs: ["cloud-architect"] });
    // Even a (wrongly) listed slug does not make a review-only offer live.
    expect(l.academy?.publicSale).toBe(false);
    expect(isPubliclyLive(l)).toBe(false);
    expect(JSON.stringify(l)).not.toMatch(/Live in the (public )?catalogue/);
  });

  it("is live only on PUBLIC_SALE confirmed in the Academy catalogue", () => {
    const open = (slugs: string[] | null) =>
      life({
        academyPackages: [
          academyPackage({ pendingDecisions: [] }, { saleMode: "PUBLIC_SALE" }),
        ],
        academyCatalogueSlugs: slugs,
      });
    const listed = open(["cloud-architect"]);
    expect(stateOf(listed)["academy-sale"]).toBe("complete");
    expect(listed.headline).toBe("On public sale in the Academy catalogue");
    expect(isPubliclyLive(listed)).toBe(true);
    expect(listed.stages.at(-1)?.next?.href).toBe("/academy/cloud-architect");
    expect(stateOf(open([]))["academy-sale"]).toBe("attention");
    expect(isPubliclyLive(open([]))).toBe(false);
    const unreadable = open(null);
    expect(stateOf(unreadable)["academy-sale"]).toBe("attention");
    expect(unreadable.academy?.listed).toBeNull();
  });

  it("asks the owner, not a cohort, once decisions are resolved but sale is closed", () => {
    const l = life({
      academyPackages: [academyPackage({ pendingDecisions: [] })],
    });
    expect(stateOf(l)["academy-gates"]).toBe("complete");
    expect(stateOf(l)["academy-sale"]).toBe("approval");
    expect(l.headline).toMatch(
      /^Published for review only — not on public sale/,
    );
  });

  it("says when the offer prices could not be read instead of inventing them", () => {
    const l = life({
      academyPackages: [
        academyPackage({}, { formats: undefined, currency: undefined }),
      ],
    });
    expect(l.academy?.formats).toBeNull();
    expect(l.stages.find((s) => s.id === "academy-publish")?.summary).toContain(
      "could not be read",
    );
  });

  it("shows an Academy package before its offer is published as awaiting a pricing decision", () => {
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
            formats: undefined,
          },
        ),
      ],
    });
    expect(stateOf(l)["academy-publish"]).toBe("approval");
    expect(stateOf(l)["academy-access"]).toBe("blocked");
    expect(l.academy?.formats).toEqual([]);
  });

  it("flags an archived Academy offer", () => {
    const l = life({
      academyPackages: [academyPackage({}, { offerState: "ARCHIVED" })],
    });
    expect(stateOf(l)["academy-publish"]).toBe("attention");
    expect(l.stageState).toBe("attention");
  });
});

describe("classification uses recorded relationships only", () => {
  it("does not treat a same-key Academy package linked to a different import as this course", () => {
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
    expect(l.delivery).toBe("ORGANISATION");
    expect(l.academy).toBeNull();
  });

  it("does not infer Academy delivery from a vendor or 'academy' in the key or title", () => {
    const l = life({
      revisions: [revision({ packageKey: "aws-saa-c03-architect-academy" })],
      academyPackages: [],
    });
    expect(l.delivery).toBe("ORGANISATION");
    expect(l.stages.map((s) => s.id)).toEqual([...ORGANISATION_STAGE_IDS]);
    // The unchanged organisation lifecycle: a published curriculum without a
    // delivery still asks for a cohort.
    expect(stateOf(l).activate).toBe("action");
    expect(l.stages.find((s) => s.id === "activate")?.next?.href).toBe(
      "/admin/cohorts",
    );
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
    expect(l.delivery).toBe("ACADEMY");
    expect(l.academy?.packageId).toBe(ACADEMY_PACKAGE);
  });

  it("does not turn an unreadable Academy register into cohort advice", () => {
    const l = life({ academyPackages: null });
    expect(l.delivery).toBe("ORGANISATION");
    const activate = l.stages.find((s) => s.id === "activate");
    expect(activate?.state).toBe("attention");
    expect(activate?.summary).toMatch(/unconfirmed/);
    expect(activate?.next?.href).not.toBe("/admin/cohorts");
  });
});

describe("shared curriculum with independent Academy and Organisation tracks", () => {
  it("shows both tracks when an organisation activation exists for the same curriculum", () => {
    const l = life({ activations: [activation] });
    expect(l.delivery).toBe("BOTH");
    expect(l.stages.map((s) => s.id)).toEqual([...ACADEMY_STAGE_IDS]);
    expect(l.organisationStages?.map((s) => s.id)).toEqual([
      ...ORGANISATION_STAGE_IDS,
    ]);
    expect(
      Object.fromEntries(l.organisationStages!.map((s) => [s.id, s.state])),
    ).toMatchObject({ activate: "complete", "publish-offer": "approval" });
    // The organisation track does not gate the Academy one.
    expect(l.stage).toBe("academy-gates");
  });

  it("counts a non-demo cohort as organisation delivery, but not a demo one", () => {
    expect(life({ cohorts: [cohort()] }).delivery).toBe("BOTH");
    expect(life({ cohorts: [cohort({ isDemo: true })] }).delivery).toBe(
      "ACADEMY",
    );
  });

  it("keeps an organisation offer's public listing on the organisation track", () => {
    const l = life({
      activations: [activation],
      offerActivations: [
        { activationId: activation.activationId, publishedOfferSlug: "b2b" },
      ],
      liveOfferSlugs: ["b2b"],
    });
    expect(l.liveSlugs).toEqual(["b2b"]);
    expect(isPubliclyLive(l)).toBe(true);
    expect(l.academy?.publicSale).toBe(false);
  });
});
