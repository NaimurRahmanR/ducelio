import { beforeEach, describe, expect, it, vi } from "vitest";

// The Operations Engineer execution plane, end to end through the real
// registry, proposal, confirmation and receipt code. Only the governed
// services it calls (and the AI runtime) are stubbed, so every check below
// is about this layer's own safeguards.
const m = vi.hoisted(() => ({
  requireAnyRole: vi.fn(),
  offerActivations: [] as {
    activationId: string;
    programmeTitle: string;
    cohortTitle: string;
    cohortStartsOn: string;
    publishedOfferSlug: string | null;
  }[],
  publish: vi.fn(),
  archive: vi.fn(),
  createCampaign: vi.fn(),
  archiveCampaign: vi.fn(),
  changeCohortStatus: vi.fn(),
  runTest: vi.fn(),
  offersView: vi.fn(),
  offerRows: [] as { subtitle: string; state: string }[],
  campaigns: [] as Record<string, unknown>[],
  courses: [] as Record<string, unknown>[],
  cohorts: [] as Record<string, unknown>[],
  adapter: null as unknown,
  runtime: vi.fn(),
}));

vi.mock("@/server/identity", () => ({ requireAnyRole: m.requireAnyRole }));
vi.mock("@/server/commercial-v1-commerce", () => ({
  listCommercialV1OfferActivations: async () => m.offerActivations,
  listCommercialV1Offers: async () => [],
  listCommercialV1Campaigns: async () => m.campaigns,
  publishCommercialV1Offer: m.publish,
  archiveCommercialV1Offer: m.archive,
  createCommercialV1Campaign: m.createCampaign,
  archiveCommercialV1Campaign: m.archiveCampaign,
}));
vi.mock("@/server/commercial-v1-commerce/operations", () => ({
  listCommerceOperations: m.offersView,
}));
vi.mock("@/server/course-activation", () => ({
  listCommercialV1Activations: async () => ({
    activations: m.offerActivations.map((a) => ({
      activationId: a.activationId,
      gradingPolicyPublished: true,
      resultPolicyPublished: true,
    })),
  }),
}));
vi.mock("@/server/cohorts", () => ({
  getCohortWorkspace: async () => ({
    workspace: { cohorts: m.cohorts, versions: [] },
  }),
  changeCohortStatus: m.changeCohortStatus,
}));
vi.mock("@/server/course-engineering", () => ({
  listCoursePackages: async () => [],
  getCoursePackageTestStatus: async () => null,
  runCoursePackageTest: m.runTest,
}));
vi.mock("@/server/admin-control-centre", async (original) => ({
  ...(await original<typeof import("@/server/admin-control-centre")>()),
  getCourseCatalogue: async () => ({ courses: m.courses, sources: {} }),
}));
vi.mock("@/server/academic-runtime/profile-registry", () => ({
  resolvePlatformRuntimeProfile: () => ({
    ref: "OPERATIONS_ENGINEER_PLATFORM_V1",
    budgetPolicy: {
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxInputContextBytes: 64000,
      maxOutputTokens: 1200,
      totalDeadlineMs: 20000,
      maxEstimatedCostMicrousd: 100000,
    },
  }),
  resolveAdapterForProfile: () => m.adapter,
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: m.runtime,
}));

import {
  executeOperation,
  getOperationOptions,
  interpretOperationRequest,
  prepareOperation,
  type Proposal,
} from "@/server/operations-engineer";
import { AccessDenied } from "@/domain/policy";
import { deriveCourseLifecycle } from "@/domain/admin-course-lifecycle";
import {
  OPERATIONS_ENGINEER_DISABLED,
  composeOperationsEngineerInstructions,
} from "@/domain/operations-engineer";

// What the database holds after an offer is published (by anyone).
function commitOffer(slug: string, minor = 24900, currency = "GBP") {
  m.offerActivations[0].publishedOfferSlug = slug;
  m.offerRows.push({
    subtitle: `${slug} / Autumn 2026 / ${minor} ${currency}`,
    state: "PUBLISHED",
  });
}

const ACTIVATION = "50000000-0000-4000-8000-000000000001";
const admin = {
  id: "60000000-0000-4000-8000-000000000001",
  displayName: "Avery Admin",
  roles: ["ACADEMIC_ADMIN"],
};
const raw = {
  activationId: ACTIVATION,
  slug: "security-plus-autumn-2026",
  price: "249.00",
  currency: "GBP",
  deliveryPlan: "STANDARD_6_WEEK",
  summary: "",
  reason: "Launch the autumn cohort",
};

async function proposal(input = raw): Promise<Proposal> {
  const result = await prepareOperation("publish_offer", input);
  if (result.status !== "PROPOSAL") throw new Error(result.status);
  return result.proposal;
}
const confirm = (p: Proposal, over: Record<string, unknown> = {}) =>
  executeOperation({
    actionId: p.actionId,
    raw: p.raw,
    issuedAt: p.issuedAt,
    nonce: p.nonce,
    proposalId: p.proposalId,
    confirmed: true,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAnyRole.mockResolvedValue(admin);
  m.offerActivations = [
    {
      activationId: ACTIVATION,
      programmeTitle: "CompTIA Security+ (SY0-701)",
      cohortTitle: "Autumn 2026",
      cohortStartsOn: "2026-11-02",
      publishedOfferSlug: null,
    },
  ];
  m.offerRows = [];
  m.campaigns = [];
  m.courses = [];
  m.cohorts = [];
  m.offersView.mockImplementation(async () => ({
    hasMore: false,
    rows: m.offerRows,
  }));
  m.publish.mockImplementation(
    async (input: {
      slug: string;
      priceAmountMinor: number;
      currency: string;
    }) => {
      commitOffer(input.slug, input.priceAmountMinor, input.currency);
      return "70000000-0000-4000-8000-000000000001";
    },
  );
  m.adapter = null;
});

describe("authority", () => {
  it("refuses before reading state or calling any service", async () => {
    m.requireAnyRole.mockRejectedValue(new AccessDenied());
    await expect(prepareOperation("publish_offer", raw)).rejects.toThrow(
      AccessDenied,
    );
    await expect(
      executeOperation({
        actionId: "publish_offer",
        raw,
        issuedAt: "",
        nonce: "",
        proposalId: "x",
        confirmed: true,
      }),
    ).rejects.toThrow(AccessDenied);
    expect(m.offersView).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
    expect(m.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
  });

  it("rejects an action outside the registry", async () => {
    await expect(prepareOperation("run_sql", {})).rejects.toThrow();
    await expect(
      executeOperation({
        actionId: "deploy_production",
        raw: {},
        issuedAt: "",
        nonce: "",
        proposalId: "",
        confirmed: true,
      }),
    ).rejects.toThrow();
  });
});

describe("read-only inspections", () => {
  it("run immediately and change nothing", async () => {
    const result = await prepareOperation("list_offers", {});
    expect(result.status).toBe("READ_RESULT");
    if (result.status === "READ_RESULT")
      expect(result.table.rows[0]).toEqual([
        "CompTIA Security+ (SY0-701)",
        "Autumn 2026 (starts 2026-11-02)",
        "No offer",
        "—",
      ]);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("inspects an Academy course as individual learning, with no cohort advice", async () => {
    const importId = "10000000-0000-4000-8000-0000000000a2";
    const packageId = "ef6b8a49-0000-4000-8000-000000000001";
    m.courses = [
      {
        packageKey: "cloud-architect-academy",
        title: "Cloud Architect Academy",
        testRecord: false,
        lifecycle: deriveCourseLifecycle({
          revisions: [
            {
              id: importId,
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
              id: packageId,
              packageRevision: 2,
              status: "PUBLISHED",
              pendingDecisions: ["COURSE_PRICE_APPROVAL"],
              curriculumImport: { id: importId, status: "PUBLISHED" },
              course: {
                id: "ea000000-0000-4000-8000-000000000001",
                offerId: "1d000000-0000-4000-8000-000000000001",
                slug: "cloud-architect",
                offerState: "PUBLISHED",
                saleMode: "REVIEW_ONLY",
                currency: "GBP",
                formats: [
                  {
                    formatId: "STANDARD_6W",
                    weeks: 6,
                    sessionMinutes: 90,
                    minStudyDays: 3,
                    maxStudyDays: 5,
                    amountMinor: 35000,
                  },
                ],
              },
            },
          ],
          academyCatalogueSlugs: [],
        }),
      },
    ];
    const result = await prepareOperation("inspect_course", {
      packageKey: "cloud-architect-academy",
    });
    expect(result.status).toBe("READ_RESULT");
    if (result.status !== "READ_RESULT") return;
    expect(result.table.title).toContain("Academy · individual learners (B2C)");
    expect(result.table.rows.map((r) => r[0])).toContain(
      "Academy: Approval gates",
    );
    const all = JSON.stringify(result.table);
    expect(all).not.toMatch(
      /No cohort exists|Activate delivery|\/admin\/cohorts/,
    );
    expect(result.table.note).toContain("review only, not on public sale");
    expect(result.table.note).toContain("STANDARD_6W 6 weeks GBP 350.00");
    expect(result.table.note).toContain(
      `/admin/academy-course-engineering?packageId=${packageId}`,
    );
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("cannot be 'executed' as a change", async () => {
    const receipt = await executeOperation({
      actionId: "list_offers",
      raw: {},
      issuedAt: new Date().toISOString(),
      nonce: "",
      proposalId: "x",
      confirmed: true,
    });
    expect(receipt.status).toBe("REFUSED");
  });
});

describe("proposals", () => {
  it("shows the exact change with business-friendly values and passing checks", async () => {
    const p = await proposal();
    expect(p.display).toEqual(
      expect.arrayContaining([
        { label: "Public URL", value: "/courses/security-plus-autumn-2026" },
        { label: "Price", value: "£249.00" },
        { label: "Delivery plan", value: "6-week Standard" },
      ]),
    );
    expect(p.blocked).toBe(false);
    expect(p.proposalId).toMatch(/^[0-9a-f]{64}$/);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("rejects invalid input before reading state", async () => {
    const result = await prepareOperation("publish_offer", {
      ...raw,
      price: "twelve",
    });
    expect(result).toMatchObject({ status: "INVALID" });
    expect(m.offersView).not.toHaveBeenCalled();
  });

  it("blocks a second offer for the same delivery", async () => {
    m.offerActivations[0].publishedOfferSlug = "existing-offer";
    const p = await proposal();
    expect(p.blocked).toBe(true);
    expect(p.checks.find((c) => c.blocking)?.text).toContain(
      "already has a published offer",
    );
  });

  it("blocks selling a place in a staging or acceptance cohort", async () => {
    m.offerActivations[0].cohortTitle = "Acceptance cohort 1791-security";
    const p = await proposal();
    expect(p.blocked).toBe(true);
    expect(
      p.checks.some(
        (c) => c.blocking && c.text.includes("staging or acceptance cohort"),
      ),
    ).toBe(true);
    const receipt = await confirm(p);
    expect(receipt.status).toBe("REFUSED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("blocks a slug already used by another offer", async () => {
    m.offersView.mockResolvedValue({
      hasMore: false,
      rows: [{ subtitle: "security-plus-autumn-2026 / Old / 100 GBP" }],
    });
    expect((await proposal()).blocked).toBe(true);
  });
});

describe("confirmation and execution", () => {
  it("never executes without explicit confirmation", async () => {
    const p = await proposal();
    const receipt = await confirm(p, { confirmed: false });
    expect(receipt.status).toBe("REFUSED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("executes the confirmed proposal once, as the administrator, with audit provenance, and verifies it", async () => {
    const p = await proposal();
    const receipt = await confirm(p);
    expect(receipt.status).toBe("SUCCEEDED");
    expect(m.publish).toHaveBeenCalledTimes(1);
    const sent = m.publish.mock.calls[0][0];
    expect(sent).toMatchObject({
      activationId: ACTIVATION,
      slug: "security-plus-autumn-2026",
      priceAmountMinor: 24900,
      currency: "GBP",
    });
    expect(sent.reason).toBe(
      `Launch the autumn cohort · Ops Engineer ref ${p.proposalId.slice(0, 8)}`,
    );
    expect(receipt.verified).toBe(true);
    expect(receipt.reference).toBe(p.proposalId.slice(0, 8));
  });

  it("refuses to run the same proposal twice", async () => {
    const p = await proposal();
    await confirm(p);
    const again = await confirm(p);
    expect(again.status).toBe("DUPLICATE");
    expect(m.publish).toHaveBeenCalledTimes(1);
  });

  it("reports an operation already completed elsewhere instead of repeating it", async () => {
    const p = await proposal();
    // Another administrator (or instance) publishes the same offer first.
    commitOffer("security-plus-autumn-2026");
    const receipt = await confirm(p);
    expect(receipt.status).toBe("ALREADY_DONE");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses when the records changed since the proposal", async () => {
    const p = await proposal();
    m.offerActivations[0].publishedOfferSlug = "a-different-offer";
    const receipt = await confirm(p);
    expect(receipt.status).toBe("STATE_CHANGED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses an altered proposal", async () => {
    const p = await proposal();
    const receipt = await confirm(p, { raw: { ...p.raw, price: "1.00" } });
    expect(receipt.status).toBe("STATE_CHANGED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses an expired proposal", async () => {
    const p = await proposal();
    const receipt = await executeOperation(
      {
        actionId: p.actionId,
        raw: p.raw,
        issuedAt: p.issuedAt,
        nonce: p.nonce,
        proposalId: p.proposalId,
        confirmed: true,
      },
      new Date(Date.now() + 16 * 60 * 1000),
    );
    expect(receipt.status).toBe("EXPIRED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("reports a service refusal with recovery guidance and allows a corrected retry", async () => {
    m.publish.mockRejectedValueOnce(
      new Error("The course offer could not be published."),
    );
    const p = await proposal();
    const failed = await confirm(p);
    expect(failed.status).toBe("FAILED");
    // The claim is based on a fresh read, not assumed from the error.
    expect(failed.outcome).toContain(
      "re-reading the records confirms the change was not applied",
    );
    expect(failed.recovery).toContain("Prepare the proposal again");
    const retry = await confirm(await proposal());
    expect(retry.status).toBe("SUCCEEDED");
  });

  it("reports a change committed before its reply was lost as done, from the records", async () => {
    m.publish.mockImplementationOnce(async (input: { slug: string }) => {
      commitOffer(input.slug);
      throw new Error("network reset after commit");
    });
    const p = await proposal();
    const receipt = await confirm(p);
    expect(receipt.status).toBe("SUCCEEDED");
    expect(receipt.verified).toBe(true);
    expect(receipt.outcome).toContain("it was not applied twice");
    // Not repeated: the same proposal is now refused on this server, and
    // the records no longer match it anywhere.
    expect((await confirm(p)).status).toBe("DUPLICATE");
    expect(m.publish).toHaveBeenCalledTimes(1);
  });

  it("never guesses when the outcome cannot be re-read", async () => {
    const p = await proposal();
    m.publish.mockImplementationOnce(async () => {
      m.offersView.mockRejectedValue(new Error("records unavailable"));
      throw new Error("timeout");
    });
    const receipt = await confirm(p);
    expect(receipt.status).toBe("UNCERTAIN");
    expect(receipt.recovery).toContain("Do not retry yet");
  });

  it("runs only one of two simultaneous confirmations on this server", async () => {
    let release: () => void = () => {};
    m.publish.mockImplementationOnce(async (input: { slug: string }) => {
      await new Promise<void>((r) => (release = r));
      commitOffer(input.slug);
    });
    const p = await proposal();
    const first = confirm(p);
    await new Promise((r) => setTimeout(r, 10));
    const second = await confirm(p);
    release();
    expect(second.status).toBe("DUPLICATE");
    expect((await first).status).toBe("SUCCEEDED");
    expect(m.publish).toHaveBeenCalledTimes(1);
  });
});

describe("duplicate protection across server instances", () => {
  // A fresh module has empty per-instance guards: it stands for a different
  // server instance receiving the same confirmed proposal.
  async function otherInstance() {
    vi.resetModules();
    return import("@/server/operations-engineer");
  }

  it("refuses a proposal already executed elsewhere, from the records alone", async () => {
    const p = await proposal();
    expect((await confirm(p)).status).toBe("SUCCEEDED");
    const second = await otherInstance();
    const receipt = await second.executeOperation({
      actionId: p.actionId,
      raw: p.raw,
      issuedAt: p.issuedAt,
      nonce: p.nonce,
      proposalId: p.proposalId,
      confirmed: true,
    });
    expect(receipt.status).toBe("ALREADY_DONE");
    expect(m.publish).toHaveBeenCalledTimes(1);
  });

  it("relies on the database when two instances race past the record check", async () => {
    const p = await proposal();
    const second = await otherInstance();
    // Both instances passed the record check. Instance one commits first;
    // when instance two's call reaches the database, the unique index on
    // one published offer per activation refuses it.
    m.publish.mockImplementationOnce(async (input: { slug: string }) => {
      commitOffer(input.slug); // instance one
      throw new Error("ALREADY_PUBLISHED"); // instance two's refusal
    });
    const receipt = await second.executeOperation({
      actionId: p.actionId,
      raw: p.raw,
      issuedAt: p.issuedAt,
      nonce: p.nonce,
      proposalId: p.proposalId,
      confirmed: true,
    });
    // Reported from the records: the offer exists once, not twice.
    expect(receipt.status).toBe("SUCCEEDED");
    expect(receipt.outcome).toContain("it was not applied twice");
    expect(m.offerActivations.filter((a) => a.publishedOfferSlug).length).toBe(
      1,
    );
  });

  it("states each action's database guarantee on its proposal", async () => {
    const p = await proposal();
    expect(p.duplicateProtection).toContain(
      "one published offer per activation",
    );
  });

  it("re-validates the input server-side at execution", async () => {
    const p = await proposal();
    const receipt = await confirm(p, { raw: { ...p.raw, reason: "no" } });
    expect(receipt.status).toBe("REFUSED");
    expect(m.publish).not.toHaveBeenCalled();
  });
});

describe("further failure modes", () => {
  it("rejects missing arguments before reading state", async () => {
    const { slug: _slug, ...missing } = raw;
    void _slug;
    const result = await prepareOperation("publish_offer", missing);
    expect(result.status).toBe("INVALID");
    expect(m.offersView).not.toHaveBeenCalled();
  });

  it("does not report another offer that won a race for the slug as its own success", async () => {
    const p = await proposal();
    // A simultaneous, different publication (another price) takes the slug;
    // this confirmation is then refused by the database.
    m.publish.mockImplementationOnce(async () => {
      commitOffer("security-plus-autumn-2026", 9900);
      throw new Error("SLUG_TAKEN");
    });
    const receipt = await confirm(p);
    expect(receipt.status).toBe("FAILED");
    expect(receipt.status).not.toBe("SUCCEEDED");
  });

  it("does not report a different campaign that took the code as its own success", async () => {
    m.offerActivations[0].publishedOfferSlug = "security-plus-autumn-2026";
    const campaign = {
      offerSlug: "security-plus-autumn-2026",
      code: "AUTUMN25",
      kind: "FIXED_PRICE",
      fixedPrice: "199.00",
      maxRedemptions: "50",
      startsAt: "2026-11-01T00:00",
      endsAt: "2026-11-30T00:00",
      reason: "Autumn launch campaign",
    };
    const prepared = await prepareOperation("create_campaign", campaign);
    if (prepared.status !== "PROPOSAL") throw new Error(prepared.status);
    m.createCampaign.mockImplementationOnce(async () => {
      // Someone else created AUTUMN25 at another price first.
      m.campaigns.push({
        code: "AUTUMN25",
        offerSlug: "security-plus-autumn-2026",
        kind: "FIXED_PRICE",
        effectivePriceAmountMinor: 100,
        currency: "GBP",
        maxRedemptions: 50,
        redemptionCount: 0,
        startsAt: "2026-11-01T00:00:00.000Z",
        endsAt: "2026-11-30T00:00:00.000Z",
        state: "ACTIVE",
      });
      throw new Error("CODE_TAKEN");
    });
    const receipt = await confirm(prepared.proposal);
    expect(receipt.status).toBe("FAILED");
  });

  it("reports a lost campaign reply as done only when the exact campaign exists", async () => {
    m.offerActivations[0].publishedOfferSlug = "security-plus-autumn-2026";
    const prepared = await prepareOperation("create_campaign", {
      offerSlug: "security-plus-autumn-2026",
      code: "AUTUMN25",
      kind: "FIXED_PRICE",
      fixedPrice: "199.00",
      maxRedemptions: "50",
      startsAt: "2026-11-01T00:00",
      endsAt: "2026-11-30T00:00",
      reason: "Autumn launch campaign",
    });
    if (prepared.status !== "PROPOSAL") throw new Error(prepared.status);
    m.createCampaign.mockImplementationOnce(async () => {
      m.campaigns.push({
        code: "AUTUMN25",
        offerSlug: "security-plus-autumn-2026",
        kind: "FIXED_PRICE",
        effectivePriceAmountMinor: 19900,
        currency: "GBP",
        maxRedemptions: 50,
        redemptionCount: 0,
        startsAt: "2026-11-01T00:00:00.000Z",
        endsAt: "2026-11-30T00:00:00.000Z",
        state: "ACTIVE",
      });
      throw new Error("network reset after commit");
    });
    const receipt = await confirm(prepared.proposal);
    expect(receipt.status).toBe("SUCCEEDED");
    expect(receipt.verified).toBe(true);
    expect(m.createCampaign).toHaveBeenCalledTimes(1);
  });

  it("says so when a successful change cannot be verified by re-reading", async () => {
    const p = await proposal();
    m.publish.mockImplementationOnce(async (input: { slug: string }) => {
      commitOffer(input.slug);
      m.offersView.mockRejectedValue(new Error("records unavailable"));
    });
    const receipt = await confirm(p);
    expect(receipt.status).toBe("SUCCEEDED");
    expect(receipt.verified).toBeNull();
    expect(receipt.verification).toContain("could not be re-read");
  });

  it("prepares nothing when the current state cannot be read", async () => {
    m.offersView.mockRejectedValue(new Error("records unavailable"));
    const result = await prepareOperation("publish_offer", raw);
    expect(result.status).toBe("UNAVAILABLE");
    expect(m.publish).not.toHaveBeenCalled();
  });
});

describe("cohort status changes and stale-proposal replay", () => {
  const COHORT = "40000000-0000-4000-8000-000000000009";
  const setStatus = (status: string) => {
    m.cohorts = [
      {
        id: COHORT,
        title: "Autumn 2026",
        programmeTitle: "CompTIA Security+ (SY0-701)",
        versionLabel: "Revision 6",
        status,
        startsOn: "2026-11-02",
        endsOn: null,
        isDemo: false,
        enrolments: { active: 0, paused: 0, completed: 0, withdrawn: 0 },
        activationId: null,
        publishedOfferSlug: null,
      },
    ];
  };
  const closeRequest = (over: Record<string, unknown> = {}) => ({
    actionId: "change_cohort_status",
    raw: { cohortId: COHORT, status: "CLOSED", reason: "Close the intake" },
    issuedAt: new Date().toISOString(),
    nonce: "n-1",
    proposalId: "a".repeat(64),
    confirmed: true,
    ...over,
  });
  beforeEach(() => {
    setStatus("OPEN");
    m.changeCohortStatus.mockImplementation(
      async (input: { status: string }) => {
        setStatus(input.status);
        return { status: input.status, archivedOfferIds: [] };
      },
    );
  });

  it("prepares no cohort status proposal and reads nothing", async () => {
    const result = await prepareOperation("change_cohort_status", {
      cohortId: COHORT,
      status: "CLOSED",
      reason: "Close the intake",
    });
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status === "UNAVAILABLE")
      expect(result.message).toContain("Cohorts");
    expect(m.changeCohortStatus).not.toHaveBeenCalled();
  });

  it("never replays a close after the cohort was reopened (OPEN → CLOSED → OPEN)", async () => {
    // The status alone cannot tell the original OPEN from the reopened one,
    // so a close confirmed again must never be carried out.
    expect((await executeOperation(closeRequest())).status).toBe("REFUSED");
    setStatus("CLOSED"); // closed through the manual Cohorts workflow
    setStatus("OPEN"); // and reopened, within the 15-minute window
    vi.resetModules();
    const otherInstance = await import("@/server/operations-engineer");
    const replay = await otherInstance.executeOperation(closeRequest());
    expect(replay.status).toBe("REFUSED");
    expect(m.changeCohortStatus).not.toHaveBeenCalled();
    expect(m.cohorts[0].status).toBe("OPEN");
  });

  it("refuses repeated confirmation and any proposal contents, in every state", async () => {
    for (const status of ["OPEN", "CLOSED", "OPEN"]) {
      setStatus(status);
      for (const over of [
        {},
        { proposalId: "b".repeat(64), nonce: "n-2" },
        { raw: { cohortId: COHORT, status: "COMPLETED", reason: "Done" } },
      ]) {
        const receipt = await executeOperation(closeRequest(over));
        expect(receipt.status).toBe("REFUSED");
        expect(receipt.outcome).toContain("dedicated form");
      }
    }
    expect(m.changeCohortStatus).not.toHaveBeenCalled();
  });

  it("refuses a stale proposal before any expiry or record check", async () => {
    const receipt = await executeOperation(
      closeRequest({ issuedAt: "2020-01-01T00:00:00.000Z" }),
    );
    // Refused as disabled, not merely as expired: no state is consulted.
    expect(receipt.status).toBe("REFUSED");
    expect(m.changeCohortStatus).not.toHaveBeenCalled();
  });

  it("is not offered to the AI interpreter, and a model naming it gets no proposal", async () => {
    expect(composeOperationsEngineerInstructions()).not.toContain(
      "- change_cohort_status",
    );
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {},
      response: {
        outputText: JSON.stringify({
          action: "change_cohort_status",
          arguments: { cohortId: COHORT, status: "CLOSED", reason: "Close" },
          explanation: "Closes the intake.",
        }),
      },
    });
    const result = await interpretOperationRequest("close the autumn cohort");
    expect(result.status).toBe("INTERPRETED");
    if (result.status === "INTERPRETED")
      expect(result.prepared.status).toBe("UNAVAILABLE");
    expect(m.changeCohortStatus).not.toHaveBeenCalled();
  });
});

describe("choice lists", () => {
  it("lead with real records and label acceptance-test records", async () => {
    const course = (
      packageKey: string,
      title: string,
      testRecord: boolean,
    ) => ({
      packageKey,
      title,
      testRecord,
      lifecycle: { current: { packageRevision: 1 } },
    });
    m.courses = [
      course("acceptance-1791", "Acceptance Run 1791", true),
      course("security-plus-sy0-701", "CompTIA Security+ SY0-701", false),
    ];
    m.offerActivations.push({
      activationId: "50000000-0000-4000-8000-000000000002",
      programmeTitle: "Acceptance Run 1791",
      cohortTitle: "Acceptance cohort 1791",
      cohortStartsOn: "2026-10-13",
      publishedOfferSlug: "acceptance-journey-1791",
    });
    m.offerActivations[0].publishedOfferSlug = "security-plus-autumn-2026";
    const options = await getOperationOptions();
    expect(options.courses.map((o) => o.label)).toEqual([
      "CompTIA Security+ SY0-701 — revision 1",
      "Acceptance Run 1791 — revision 1 (acceptance test)",
    ]);
    expect(options.publishedOffers.map((o) => o.value)).toEqual([
      "security-plus-autumn-2026",
      "acceptance-journey-1791",
    ]);
    expect(options.publishedOffers[1].label).toContain("(acceptance test)");
  });
});

describe("changes without full duplicate protection are disabled", () => {
  it("disables exactly the partially protected changes", () => {
    expect(Object.keys(OPERATIONS_ENGINEER_DISABLED).sort()).toEqual([
      "archive_offer",
      "change_cohort_status",
      "run_course_test",
    ]);
  });

  it("neither prepares nor reads anything for a disabled change", async () => {
    for (const [actionId, input] of [
      ["archive_offer", { slug: "security-plus-autumn-2026", reason: "Ends" }],
      ["run_course_test", { importId: ACTIVATION, reason: "Retest now" }],
    ] as const) {
      const result = await prepareOperation(actionId, input);
      expect(result.status).toBe("UNAVAILABLE");
      if (result.status === "UNAVAILABLE")
        expect(result.message).toContain("dedicated form");
    }
    expect(m.offersView).not.toHaveBeenCalled();
  });

  it("refuses a hand-made confirmation of a disabled change", async () => {
    for (const actionId of ["archive_offer", "run_course_test"]) {
      const receipt = await executeOperation({
        actionId,
        raw: { slug: "security-plus-autumn-2026", reason: "Ends now" },
        issuedAt: new Date().toISOString(),
        nonce: "n",
        proposalId: "f".repeat(64),
        confirmed: true,
      });
      expect(receipt.status).toBe("REFUSED");
    }
    expect(m.archive).not.toHaveBeenCalled();
    expect(m.runTest).not.toHaveBeenCalled();
  });

  it("does not offer disabled changes to the AI interpreter", () => {
    const instructions = composeOperationsEngineerInstructions();
    expect(instructions).not.toContain("- archive_offer");
    expect(instructions).not.toContain("- run_course_test");
    expect(instructions).toContain("- publish_offer");
  });

  it("turns a model answer naming a disabled change into no proposal", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {},
      response: {
        outputText: JSON.stringify({
          action: "archive_offer",
          arguments: { slug: "security-plus-autumn-2026", reason: "Ends" },
          explanation: "Archives the offer.",
        }),
      },
    });
    const result = await interpretOperationRequest("archive the autumn offer");
    expect(result.status).toBe("INTERPRETED");
    if (result.status === "INTERPRETED")
      expect(result.prepared.status).toBe("UNAVAILABLE");
    expect(m.archive).not.toHaveBeenCalled();
  });
});

describe("natural-language interpretation", () => {
  it("says so truthfully when no AI provider is configured", async () => {
    const result = await interpretOperationRequest(
      "Publish Security+ for £249",
    );
    expect(result.status).toBe("AI_NOT_CONFIGURED");
    expect(m.runtime).not.toHaveBeenCalled();
  });

  it("turns a model answer into a proposal only; nothing is executed", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {},
      response: {
        outputText: JSON.stringify({
          action: "publish_offer",
          arguments: raw,
          explanation: "This publishes the autumn delivery at £249.",
        }),
      },
    });
    const result = await interpretOperationRequest(
      "Put Security+ autumn on sale at 249 pounds",
    );
    expect(result.status).toBe("INTERPRETED");
    if (result.status === "INTERPRETED")
      expect(result.prepared.status).toBe("PROPOSAL");
    expect(m.publish).not.toHaveBeenCalled();
    const request = m.runtime.mock.calls[0][1];
    expect(request).toMatchObject({
      role: "OPERATIONS_ENGINEER",
      capability: "interpret_operations_request",
    });
    expect(request.context.administratorRequest).toBe(
      "Put Security+ autumn on sale at 249 pounds",
    );
  });

  it("discards an answer naming an operation outside the registry", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {},
      response: {
        outputText: JSON.stringify({
          action: "drop_table",
          arguments: {},
          explanation: "x",
        }),
      },
    });
    expect((await interpretOperationRequest("delete everything")).status).toBe(
      "AI_FAILED",
    );
  });

  it("reports a failed model call without changing anything", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({ outcome: "TIMEOUT", usage: {} });
    const result = await interpretOperationRequest("list offers");
    expect(result.status).toBe("AI_FAILED");
    expect(m.publish).not.toHaveBeenCalled();
  });
});
