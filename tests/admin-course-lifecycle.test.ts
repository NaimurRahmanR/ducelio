import { describe, expect, it } from "vitest";
import {
  cohortPurpose,
  deriveCourseLifecycle,
  type LifecycleCohort,
  type LifecyclePackage,
} from "@/domain/admin-course-lifecycle";

const VERSION = "20000000-0000-4000-8000-000000000006";
const pkg = (
  revision: number,
  status: string,
  over: Partial<LifecyclePackage> = {},
): LifecyclePackage => ({
  id: `10000000-0000-4000-8000-00000000000${revision}`,
  packageKey: "security-plus-sy0-701",
  packageRevision: revision,
  status,
  programmeId: "30000000-0000-4000-8000-000000000001",
  programmeVersionId:
    status === "IMPORTED" || status === "VALIDATED" ? null : VERSION,
  createdAt: "2026-10-19T10:00:00Z",
  appliedAt:
    status === "APPLIED" || status === "PUBLISHED"
      ? "2026-10-19T11:00:00Z"
      : null,
  publishedAt: status === "PUBLISHED" ? "2026-10-19T12:00:00Z" : null,
  rejectedAt: status === "REJECTED" ? "2026-10-19T12:00:00Z" : null,
  ...over,
});
const cohort = (
  title: string,
  over: Partial<LifecycleCohort> = {},
): LifecycleCohort => ({
  id: "40000000-0000-4000-8000-000000000001",
  title,
  startsOn: "2026-10-13",
  endsOn: null,
  status: "OPEN",
  programmeVersionId: VERSION,
  isDemo: false,
  enrolments: { active: 1, paused: 0, completed: 0, withdrawn: 0 },
  activationId: null,
  publishedOfferSlug: null,
  ...over,
});
const stateOf = (life: ReturnType<typeof deriveCourseLifecycle>) =>
  Object.fromEntries(life.stages.map((s) => [s.id, s.state]));
const activation = {
  activationId: "50000000-0000-4000-8000-000000000001",
  packageKey: "security-plus-sy0-701",
  packageRevision: 6,
  cohortTitle: "Autumn 2026",
  cohortStartsOn: "2026-11-02",
  createdAt: "2026-10-20T09:00:00Z",
  gradingPolicyPublished: true,
  resultPolicyPublished: true,
  labPracticalsTotal: 10,
  labPracticalsConfigured: 10,
};

describe("Security+ SY0-701 revision 6 (published curriculum, no activation, no offer)", () => {
  const base = {
    revisions: [pkg(5, "APPLIED"), pkg(6, "PUBLISHED")],
    activations: [],
    offerActivations: [],
    liveOfferSlugs: [],
  };

  it("shows the curriculum as published and never asks for another upload", () => {
    const life = deriveCourseLifecycle({
      ...base,
      cohorts: [cohort("Acceptance cohort 1791-security")],
    });
    expect(life.current.packageRevision).toBe(6);
    expect(stateOf(life)).toEqual({
      import: "complete",
      validate: "complete",
      configure: "complete",
      test: "complete",
      "publish-curriculum": "complete",
      activate: "action",
      "publish-offer": "blocked",
      catalogue: "blocked",
    });
    const activate = life.stages.find((s) => s.id === "activate")!;
    expect(activate.summary).toContain("Revision 6 is published");
    expect(activate.summary).toContain("Do not upload the package again");
    expect(life.stage).toBe("activate");
    expect(life.headline).toBe(activate.summary);
  });

  it("identifies the staging cohort and never offers it for paying learners", () => {
    const life = deriveCourseLifecycle({
      ...base,
      cohorts: [cohort("Acceptance cohort 1791-security")],
    });
    const activate = life.stages.find((s) => s.id === "activate")!;
    expect(activate.summary).toContain(
      "“Acceptance cohort 1791-security” is a staging or acceptance cohort and must not be used for paying learners.",
    );
    // The next step creates a delivery cohort; it never points at the staging one.
    expect(activate.next).toEqual({
      label: "Create a delivery cohort",
      href: "/admin/cohorts",
    });
    expect(JSON.stringify(life.stages)).not.toContain(
      "40000000-0000-4000-8000-000000000001",
    );
    expect(life.cohorts[0].purpose).toBe("LIKELY_STAGING");
  });

  it("never chooses an unverified cohort on the operator's behalf", () => {
    const life = deriveCourseLifecycle({
      ...base,
      cohorts: [cohort("Autumn 2026")],
    });
    const activate = life.stages.find((s) => s.id === "activate")!;
    expect(activate.summary).toContain("Cohort purpose is not recorded");
    expect(activate.summary).toContain("select the delivery cohort explicitly");
    expect(activate.next?.href).toBe("/admin/activation");
  });

  it("asks for a cohort when none is open", () => {
    const life = deriveCourseLifecycle({
      ...base,
      cohorts: [cohort("Spring 2026", { status: "COMPLETED" })],
    });
    expect(life.stages.find((s) => s.id === "activate")!.summary).toContain(
      "No open cohort exists for this curriculum",
    );
  });
});

describe("course lifecycle stages", () => {
  // Complete evidence: no activation, offer, cohort or individual-learning
  // (Academy) package recorded for these courses.
  const none = {
    activations: [],
    offerActivations: [],
    liveOfferSlugs: [],
    cohorts: [],
    academyPackages: [],
  };

  it("starts with validation for a staged import", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(1, "IMPORTED")],
    });
    expect(stateOf(life).validate).toBe("action");
    expect(stateOf(life).configure).toBe("blocked");
  });

  it("flags a rejected revision for attention", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(1, "REJECTED")],
    });
    expect(stateOf(life).validate).toBe("attention");
  });

  it("needs a test before publication, then an explicit publication decision", () => {
    const failed = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(2, "APPLIED")],
      testReadiness: "FAILED",
    });
    expect(stateOf(failed).test).toBe("action");
    expect(stateOf(failed)["publish-curriculum"]).toBe("blocked");
    const passed = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(2, "APPLIED")],
      testReadiness: "PASSED_CURRENT",
    });
    expect(stateOf(passed).test).toBe("complete");
    expect(stateOf(passed)["publish-curriculum"]).toBe("approval");
  });

  it("treats a price as an administrator decision once delivery is activated", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(6, "PUBLISHED")],
      activations: [activation],
      offerActivations: [
        { activationId: activation.activationId, publishedOfferSlug: null },
      ],
    });
    expect(stateOf(life).activate).toBe("complete");
    expect(stateOf(life)["publish-offer"]).toBe("approval");
  });

  it("flags an activation whose policies are not published", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(6, "PUBLISHED")],
      activations: [{ ...activation, resultPolicyPublished: false }],
    });
    expect(stateOf(life).activate).toBe("attention");
  });

  it("is live when the offer appears in the public catalogue", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(6, "PUBLISHED")],
      activations: [activation],
      offerActivations: [
        {
          activationId: activation.activationId,
          publishedOfferSlug: "security-plus-autumn",
        },
      ],
      liveOfferSlugs: ["security-plus-autumn"],
    });
    expect(Object.values(stateOf(life)).every((s) => s === "complete")).toBe(
      true,
    );
    expect(life.headline).toBe("Live in the catalogue");
  });

  it("never claims a listing when the catalogue could not be read", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(6, "PUBLISHED")],
      activations: [activation],
      offerActivations: [
        {
          activationId: activation.activationId,
          publishedOfferSlug: "security-plus-autumn",
        },
      ],
      liveOfferSlugs: null,
    });
    expect(stateOf(life).catalogue).toBe("attention");
    expect(life.stages.at(-1)!.summary).toContain("could not be read");
  });

  it("ignores activations of a different revision", () => {
    const life = deriveCourseLifecycle({
      ...none,
      revisions: [pkg(6, "PUBLISHED")],
      activations: [{ ...activation, packageRevision: 5 }],
    });
    // The other revision's activation is not this revision's delivery, so
    // no delivery model is recorded for revision 6 (never assumed cohort).
    expect(stateOf(life).activate).toBe("approval");
    expect(life.delivery).toBe("NONE");
  });
});

describe("cohort purpose", () => {
  it.each([
    ["Acceptance cohort 1791929690309", "LIKELY_STAGING"],
    ["Staging — Security+", "LIKELY_STAGING"],
    ["QA dry run", "LIKELY_STAGING"],
    ["Test cohort A", "LIKELY_STAGING"],
    ["Autumn 2026", "UNVERIFIED"],
    ["Software Testing — Autumn", "UNVERIFIED"],
  ])("%s → %s", (title, purpose) => {
    expect(cohortPurpose({ title, isDemo: false })).toBe(purpose);
  });

  it("marks demo cohorts", () => {
    expect(cohortPurpose({ title: "Autumn 2026", isDemo: true })).toBe("DEMO");
  });
});
