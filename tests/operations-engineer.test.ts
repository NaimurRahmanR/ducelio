import { beforeEach, describe, expect, it, vi } from "vitest";

// The Operations Engineer execution plane, end to end through the real
// registry, proposal, confirmation and receipt code, over the unified Course
// Engine. Only the governed services it calls (and the AI runtime) are
// replaced by an in-memory model of their recorded state, so every check
// below is about this layer's own safeguards.
const DUCELIO = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000aa";
const AWS = "10000000-0000-4000-8000-000000000003";
const READY = "10000000-0000-4000-8000-000000000004";
const FOREIGN = "10000000-0000-4000-8000-000000000009";
const COURSE = "20000000-0000-4000-8000-000000000001";
const COUPON = "30000000-0000-4000-8000-000000000001";

type Pkg = {
  id: string;
  organisationId: string;
  organisationName: string;
  packageKey: string;
  packageRevision: number;
  status: "UPLOADED" | "VALIDATED" | "PUBLISHED" | "REJECTED";
  title: string;
  pendingDecisions: string[];
  rejectedReason: string | null;
  curriculumImport: null | {
    id: string;
    status: string;
    programmeVersionId: null;
  };
  course: null | {
    id: string;
    offerId: string | null;
    slug: string | null;
    offerState: "PUBLISHED" | "ARCHIVED" | null;
    saleMode: "REVIEW_ONLY" | "PUBLIC_SALE" | null;
  };
};
type CouponRow = {
  id: string;
  code: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  expiresAt: string;
  redemptionLimit: number;
  courseId: string | null;
  active: boolean;
  reserved: number;
  redeemed: number;
};

const m = vi.hoisted(() => ({
  access: null as unknown,
  packages: [] as Pkg[],
  stored: new Map<string, string>(),
  coupons: [] as CouponRow[],
  orders: [] as Record<string, unknown>[],
  catalogue: [] as { offerId: string; currency: string }[],
  checkout: false,
  readFails: false,
  reads: [] as string[],
  upload: vi.fn(),
  validate: vi.fn(),
  publish: vi.fn(),
  createCoupon: vi.fn(),
  setActive: vi.fn(),
  adapter: null as unknown,
  runtime: vi.fn(),
}));

const read = vi.hoisted(
  () =>
    <T>(name: string, value: () => T) =>
      vi.fn(async () => {
        m.reads.push(name);
        if (m.readFails) throw new Error("SERVICE_UNAVAILABLE");
        return structuredClone(value());
      }),
);

vi.mock("@/server/course-organisations", () => ({
  courseEngineeringAccess: async () => m.access,
}));
vi.mock("@/lib/env", async (original) => ({
  ...(await original<typeof import("@/lib/env")>()),
  commerceConfig: () => ({ configured: m.checkout }),
}));
vi.mock("@/server/unified-course-engine", () => ({
  listUnifiedCoursePackages: read("packages", () => m.packages),
  listUnifiedCourseCatalogue: read("catalogue", () => m.catalogue),
  getUnifiedAcademicResolutions: async () => [],
  getUnifiedPublicationGate: async (id: string) => {
    m.reads.push("gate");
    if (m.readFails) throw new Error("SERVICE_UNAVAILABLE");
    const p = structuredClone(m.packages.find((x) => x.id === id));
    if (!p) return { ok: false, code: "NOT_FOUND" };
    if (p.status === "PUBLISHED")
      return { ok: true, package: p, published: true };
    if (p.status !== "VALIDATED")
      return { ok: false, code: "INVALID_STATE", package: p };
    if (p.pendingDecisions.length)
      return {
        ok: false,
        code: "POLICY_PENDING",
        package: p,
        pending: p.pendingDecisions,
      };
    return { ok: true, package: p, published: false };
  },
  checkUnifiedCoursePackageUpload: async (
    json: {
      schemaVersion?: string;
      packageKey: string;
      packageRevision: number;
    },
    org: string,
  ) => {
    m.reads.push("upload-check");
    if (json?.schemaVersion !== "ACADEMY_COURSE_PACKAGE_V1")
      return {
        status: "INVALID",
        issues: ["schemaVersion — must be ACADEMY_COURSE_PACKAGE_V1"],
      };
    const same = m.packages.find(
      (p) =>
        p.organisationId === org &&
        p.packageKey === json.packageKey &&
        p.packageRevision === json.packageRevision,
    );
    if (same && m.stored.get(same.id) === JSON.stringify(json))
      return {
        status: "ALREADY_UPLOADED",
        packageId: same.id,
        packageKey: same.packageKey,
        revision: same.packageRevision,
        packageStatus: same.status,
      };
    if (same)
      return {
        status: "REVISION_TAKEN",
        packageKey: same.packageKey,
        revision: same.packageRevision,
        existingStatus: same.status,
        existingId: same.id,
        latestRevision: same.packageRevision,
        nextRevision: same.packageRevision + 1,
      };
    return {
      status: "READY",
      packageKey: json.packageKey,
      revision: json.packageRevision,
      title: "Synthetic course",
      pendingDecisions: 2,
      latestRevision: null,
    };
  },
  describeUploadConflict: (c: { revision: number; nextRevision: number }) =>
    `Revision ${c.revision} already exists; use ${c.nextRevision}.`,
  uploadUnifiedCoursePackage: m.upload,
  publishUnifiedCourse: m.publish,
}));
vi.mock("@/server/academy-course-engineering", () => ({
  getAcademyPackageReview: async () => ({
    id: AWS,
    status: "VALIDATED",
    review: {
      totals: { modules: 5, lessons: 22 },
      labs: [{ graded: false }],
      assessments: [{ kind: "FINAL", questionCount: 65, durationMinutes: 130 }],
      pendingDecisions: [
        { key: "EXAM_ITEM_INDEPENDENT_REVIEW", summary: "Review items." },
      ],
    },
  }),
  validateAcademyPackage: m.validate,
}));
vi.mock("@/server/course-coupons", () => ({
  listCourseCoupons: read("coupons", () => m.coupons),
  listOrganisationCourseOrders: read("orders", () => m.orders),
  createCourseCoupon: m.createCoupon,
  setCourseCouponActive: m.setActive,
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
  readAttachment,
  type Attachment,
  type Proposal,
} from "@/server/operations-engineer";
import { AccessDenied } from "@/domain/policy";

const admin = {
  id: "60000000-0000-4000-8000-000000000001",
  displayName: "Avery Admin",
  roles: ["ACADEMIC_ADMIN"],
};
const org = (id: string, name: string, canManage = true) => ({
  id,
  name,
  slug: name.toLowerCase(),
  canManage,
  canReview: canManage,
  canOwn: false,
});
const pkg = (over: Partial<Pkg>): Pkg => ({
  id: AWS,
  organisationId: DUCELIO,
  organisationName: "Ducelio",
  packageKey: "aws-saa-c03-architect-academy",
  packageRevision: 3,
  status: "VALIDATED",
  title: "AWS Solutions Architect – Associate (SAA-C03) Exam Preparation",
  pendingDecisions: [],
  rejectedReason: null,
  curriculumImport: null,
  course: null,
  ...over,
});
const reason = "Synthetic operations test";
const synthetic = {
  schemaVersion: "ACADEMY_COURSE_PACKAGE_V1",
  packageKey: "synthetic-course",
  packageRevision: 1,
};
const file = (json: unknown, name = "course.json") =>
  readAttachment(new File([JSON.stringify(json)], name));

async function proposal(
  id: string,
  raw: Record<string, string>,
  attachment: Attachment | null = null,
  now?: Date,
): Promise<Proposal> {
  const result = await prepareOperation(id, raw, attachment, now);
  if (result.status !== "PROPOSAL")
    throw new Error(`${result.status} ${JSON.stringify(result)}`);
  return result.proposal;
}
const confirm = (
  p: Proposal,
  attachment: Attachment | null = null,
  over: Record<string, unknown> = {},
  now?: Date,
) =>
  executeOperation(
    {
      actionId: p.actionId,
      raw: p.raw,
      issuedAt: p.issuedAt,
      nonce: p.nonce,
      proposalId: p.proposalId,
      confirmed: true,
      ...over,
    },
    attachment,
    now,
  );
const publishRaw = {
  packageId: READY,
  slug: "synthetic-ready",
  price: "249.00",
  currency: "GBP",
  summary: "",
  reason,
};
const blocking = (p: Proposal) =>
  p.checks.filter((c) => c.blocking).map((c) => c.text);

beforeEach(() => {
  vi.clearAllMocks();
  m.access = {
    actor: admin,
    allowed: true,
    organisations: [
      org(DUCELIO, "Ducelio"),
      org(OTHER_ORG, "Other Org", false),
    ],
  };
  m.packages = [
    pkg({
      pendingDecisions: [
        "OFFICIAL_SOURCE_RECONCILIATION",
        "EXAM_ITEM_INDEPENDENT_REVIEW",
      ],
    }),
    pkg({
      id: READY,
      packageKey: "synthetic-ready",
      packageRevision: 1,
      title: "Synthetic ready course",
    }),
    pkg({
      id: FOREIGN,
      organisationId: OTHER_ORG,
      organisationName: "Other Org",
      packageKey: "org-foreign",
      packageRevision: 1,
      title: "Other organisation course",
    }),
  ];
  m.stored = new Map();
  m.coupons = [
    {
      id: COUPON,
      code: "SPRING-10",
      percentOff: 10,
      amountOffMinor: null,
      currency: null,
      expiresAt: "2031-01-01T00:00:00.000Z",
      redemptionLimit: 100,
      courseId: null,
      active: true,
      reserved: 1,
      redeemed: 4,
    },
  ];
  m.orders = [];
  m.catalogue = [];
  m.checkout = false;
  m.readFails = false;
  m.reads = [];
  m.adapter = null;
  m.upload.mockImplementation(
    async (
      json: { packageKey: string; packageRevision: number },
      _r: string,
      o: string,
    ) => {
      const id = "10000000-0000-4000-8000-0000000000f1";
      m.packages.push(
        pkg({
          id,
          organisationId: o,
          packageKey: json.packageKey,
          packageRevision: json.packageRevision,
          status: "UPLOADED",
          title: "Synthetic course",
        }),
      );
      m.stored.set(id, JSON.stringify(json));
      return id;
    },
  );
  m.validate.mockImplementation(async (id: string) => {
    m.packages.find((p) => p.id === id)!.status = "VALIDATED";
    return {
      valid: true,
      package: { packageRevision: 1 },
      review: { pendingDecisions: [{}, {}], warnings: [] },
    };
  });
  m.publish.mockImplementation(
    async (input: { packageId: string; slug: string }) => {
      const p = m.packages.find((x) => x.id === input.packageId)!;
      p.status = "PUBLISHED";
      p.course = {
        id: COURSE,
        offerId: "40000000-0000-4000-8000-000000000001",
        slug: input.slug,
        offerState: "PUBLISHED",
        saleMode: "PUBLIC_SALE",
      };
      return { courseId: COURSE, offerId: p.course.offerId, replayed: false };
    },
  );
  m.createCoupon.mockImplementation(async (input: Record<string, unknown>) => {
    m.coupons.push({
      id: "30000000-0000-4000-8000-0000000000f2",
      code: String(input.code),
      percentOff: (input.percentOff as number) ?? null,
      amountOffMinor: (input.amountOffMinor as number) ?? null,
      currency: (input.currency as string) ?? null,
      expiresAt: String(input.expiresAt),
      redemptionLimit: Number(input.redemptionLimit),
      courseId: (input.courseId as string) ?? null,
      active: true,
      reserved: 0,
      redeemed: 0,
    });
    return "30000000-0000-4000-8000-0000000000f2";
  });
  m.setActive.mockImplementation(async (id: string, active: boolean) => {
    m.coupons.find((c) => c.id === id)!.active = active;
    return id;
  });
});

describe("authority and organisation scope", () => {
  it("refuses an actor without course-engineering access before reading any state", async () => {
    m.access = { actor: admin, allowed: false, organisations: [] };
    for (const run of [
      () => prepareOperation("list_courses", {}),
      () => getOperationOptions(),
      () => interpretOperationRequest("list the courses"),
      () =>
        executeOperation({
          actionId: "set_coupon_active",
          raw: { couponId: COUPON, active: "false", reason },
          issuedAt: new Date().toISOString(),
          nonce: "n",
          proposalId: "p",
          confirmed: true,
        }),
    ])
      await expect(run()).rejects.toBeInstanceOf(AccessDenied);
    expect(m.reads).toEqual([]);
    expect(m.setActive).not.toHaveBeenCalled();
  });

  it("keeps platform runtime health behind platform course-administrator roles", async () => {
    m.access = {
      actor: { ...admin, roles: ["STUDENT"] },
      allowed: true,
      organisations: [org(OTHER_ORG, "Other Org")],
    };
    await expect(
      prepareOperation("check_agent_health", {}),
    ).rejects.toBeInstanceOf(AccessDenied);
    expect((await prepareOperation("list_courses", {})).status).toBe(
      "READ_RESULT",
    );
  });

  it("rejects retired and unknown operations outright", async () => {
    for (const retired of [
      "publish_offer",
      "create_campaign",
      "change_cohort_status",
      "drop_table",
    ])
      await expect(prepareOperation(retired, {})).rejects.toThrow();
  });

  it("offers only organisations the administrator manages", async () => {
    const options = await getOperationOptions();
    expect(options.organisations).toEqual([
      { value: DUCELIO, label: "Ducelio" },
    ]);
    expect(options.publishablePackages.map((o) => o.value)).toEqual([
      AWS,
      READY,
    ]);
  });

  it("refuses changes inside an organisation the administrator does not manage", async () => {
    const upload = await proposal(
      "upload_course_package",
      { organisationId: OTHER_ORG, reason },
      await file(synthetic),
    );
    expect(blocking(upload)).toContain(
      "You do not manage course packages for this organisation.",
    );
    const publish = await proposal("publish_course", {
      ...publishRaw,
      packageId: FOREIGN,
      slug: "foreign-course",
    });
    expect(blocking(publish)).toContain(
      "You do not manage this course's organisation.",
    );
    const coupon = await proposal("create_coupon", {
      organisationId: OTHER_ORG,
      code: "FOREIGN-10",
      discountKind: "PERCENT",
      percentOff: "10",
      expiresAt: "2031-01-01T09:00",
      redemptionLimit: "5",
      reason,
    });
    expect(blocking(coupon)).toContain(
      "You do not manage coupons for this organisation.",
    );
    for (const p of [upload, publish, coupon])
      expect((await confirm(p, await file(synthetic))).status).toBe("REFUSED");
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
    expect(m.createCoupon).not.toHaveBeenCalled();
  });
});

describe("read-only inspections", () => {
  it("list courses with explicit lifecycle stages, not raw pipeline states", async () => {
    const result = await prepareOperation("list_courses", {});
    if (result.status !== "READ_RESULT") throw new Error(result.status);
    const aws = result.table.rows.find((r) => r[0].startsWith("AWS"))!;
    expect(aws[3]).toBe("Structurally validated · awaiting academic review");
    expect(aws[4]).toBe("2");
    expect(JSON.stringify(result.table)).not.toContain("not started");
  });

  it("inspect one revision with its decisions, gate explanation and review links", async () => {
    const result = await prepareOperation("inspect_course", { packageId: AWS });
    if (result.status !== "READ_RESULT") throw new Error(result.status);
    const text = JSON.stringify(result.table);
    expect(text).toContain("Pending: EXAM_ITEM_INDEPENDENT_REVIEW");
    expect(text).toContain("imported and tested at publication");
    expect(text).toContain("65 items/130 min");
    expect(result.table.links?.[0]).toEqual({
      label: "Open in Course academic review",
      href: `/admin/course-engineering/review?packageId=${AWS}`,
    });
  });

  it("report sales without presenting order amounts as recognised revenue", async () => {
    m.orders = [
      {
        id: "o1",
        courseTitle: "C",
        learnerId: "l",
        state: "FULFILLED",
        amountMinor: 20000,
        currency: "GBP",
        discountAmountMinor: 5000,
        paymentConfirmed: true,
        refundRecorded: true,
        createdAt: "2026-10-25T10:00:00Z",
      },
      {
        id: "o2",
        courseTitle: "C",
        learnerId: "l",
        state: "PENDING",
        amountMinor: 10000,
        currency: "GBP",
        discountAmountMinor: 0,
        paymentConfirmed: false,
        refundRecorded: false,
        createdAt: "2026-10-25T11:00:00Z",
      },
    ];
    const result = await prepareOperation("sales_report", {});
    if (result.status !== "READ_RESULT") throw new Error(result.status);
    const summary = Object.fromEntries(
      result.table.summary!.map((d) => [d.label, d.value]),
    );
    expect(summary["GBP orders"]).toBe(
      "2: 1 fulfilled, 1 pending, 0 cancelled",
    );
    expect(summary["GBP fulfilled order totals"]).toContain("£200.00");
    expect(summary["GBP fulfilled order totals"]).toContain(
      "not settled revenue",
    );
    expect(summary["GBP refunds recorded"]).toContain("1 orders");
    expect(summary["Recognised revenue"]).toMatch(/^Not reported/);
    // No learner identifier is exposed in the report rows.
    expect(JSON.stringify(result.table.rows)).not.toContain('"l"');
  });

  it("cannot be executed as a change", async () => {
    const receipt = await executeOperation({
      actionId: "list_courses",
      raw: {},
      issuedAt: new Date().toISOString(),
      nonce: "n",
      proposalId: "p",
      confirmed: true,
    });
    expect(receipt.status).toBe("REFUSED");
  });
});

describe("course package upload", () => {
  it("never pretends a file was supplied", async () => {
    const p = await proposal("upload_course_package", {
      organisationId: DUCELIO,
      reason,
    });
    expect(blocking(p)).toContain(
      "Attach the course package JSON file. Nothing has been uploaded.",
    );
    expect((await confirm(p)).status).toBe("REFUSED");
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("stops invalid or non-JSON files before anything is stored", async () => {
    const invalid = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      await file({ schemaVersion: "OTHER" }),
    );
    expect(blocking(invalid)[0]).toMatch(/failed validation with 1 issue/);
    const notJson = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      await readAttachment(new File(["{not json"], "course.json")),
    );
    expect(blocking(notJson)[0]).toMatch(/not valid UTF-8 JSON/);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("explains an occupied revision instead of overwriting history", async () => {
    m.stored.set(READY, "different");
    const p = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      await file({ ...synthetic, packageKey: "synthetic-ready" }),
    );
    expect(blocking(p)).toEqual(["Revision 1 already exists; use 2."]);
  });

  it("stores and validates a confirmed file once, under the administrator, and verifies it", async () => {
    const attachment = await file(synthetic);
    const p = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      attachment,
    );
    expect(p.blocked).toBe(false);
    expect(p.display.find((d) => d.label === "File")?.value).toContain(
      attachment!.sha256.slice(0, 16),
    );
    const receipt = await confirm(p, attachment);
    expect(receipt).toMatchObject({ status: "SUCCEEDED", verified: true });
    expect(m.upload).toHaveBeenCalledOnce();
    expect(m.upload.mock.calls[0][1]).toMatch(
      new RegExp(`^${reason} · Ops Engineer ref ${p.proposalId.slice(0, 8)}$`),
    );
    expect(m.upload.mock.calls[0][2]).toBe(DUCELIO);
    expect(m.validate).toHaveBeenCalledOnce();
    expect(receipt.links?.[0].href).toBe(
      "/admin/course-engineering/review?packageId=10000000-0000-4000-8000-0000000000f1",
    );
    // A repeat on this server is refused; elsewhere the records show it done.
    expect((await confirm(p, attachment)).status).toBe("DUPLICATE");
    expect(m.upload).toHaveBeenCalledOnce();
  });

  it("refuses a confirmation that carries a different file", async () => {
    const p = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      await file(synthetic),
    );
    const receipt = await confirm(
      p,
      await file({ ...synthetic, packageRevision: 2 }),
    );
    expect(receipt.status).toBe("STATE_CHANGED");
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("reports an upload completed elsewhere from the records alone", async () => {
    const attachment = await file(synthetic);
    const p = await proposal(
      "upload_course_package",
      { organisationId: DUCELIO, reason },
      attachment,
    );
    await m.upload(synthetic, reason, DUCELIO);
    await m.validate("10000000-0000-4000-8000-0000000000f1");
    m.upload.mockClear();
    expect((await confirm(p, attachment)).status).toBe("ALREADY_DONE");
    expect(m.upload).not.toHaveBeenCalled();
  });
});

describe("publication", () => {
  it("is blocked while academic decisions are pending and points to the review", async () => {
    const p = await proposal("publish_course", {
      ...publishRaw,
      packageId: AWS,
      slug: "aws-saa-c03",
    });
    expect(blocking(p)).toEqual([
      "2 academic decision(s) are pending (OFFICIAL_SOURCE_RECONCILIATION, EXAM_ITEM_INDEPENDENT_REVIEW). They must be resolved by an authorised reviewer in Course academic review before publication.",
    ]);
    expect((await confirm(p)).status).toBe("REFUSED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("publishes an approved revision with the exact governed input and verifies it", async () => {
    const p = await proposal("publish_course", publishRaw);
    expect(p.blocked).toBe(false);
    expect(p.checks.map((c) => c.text)).toContain(
      "Card checkout is not configured in this deployment: learners can join only with a coupon until it is.",
    );
    const receipt = await confirm(p);
    expect(receipt).toMatchObject({ status: "SUCCEEDED", verified: true });
    expect(m.publish).toHaveBeenCalledExactlyOnceWith({
      packageId: READY,
      slug: "synthetic-ready",
      currency: "GBP",
      amountMinor: 24900,
      summary: null,
      reason: `${reason} · Ops Engineer ref ${p.proposalId.slice(0, 8)}`,
    });
  });

  it("refuses an address another course already uses", async () => {
    m.packages[0].course = {
      id: COURSE,
      offerId: null,
      slug: "synthetic-ready",
      offerState: "PUBLISHED",
      saleMode: "PUBLIC_SALE",
    };
    const p = await proposal("publish_course", publishRaw);
    expect(blocking(p)[0]).toMatch(/already used by AWS/);
  });

  it("reports a service refusal with its policy code and no change", async () => {
    m.publish.mockRejectedValueOnce(new Error("TEST_GATE_NOT_SATISFIED"));
    const receipt = await confirm(await proposal("publish_course", publishRaw));
    expect(receipt.status).toBe("FAILED");
    expect(receipt.outcome).toContain("(TEST_GATE_NOT_SATISFIED)");
    expect(receipt.outcome).toContain("not applied");
  });

  it("reports a publication committed before its reply was lost as done, from the records", async () => {
    m.publish.mockImplementationOnce(
      async (input: { packageId: string; slug: string }) => {
        const p = m.packages.find((x) => x.id === input.packageId)!;
        p.status = "PUBLISHED";
        p.course = {
          id: COURSE,
          offerId: null,
          slug: input.slug,
          offerState: "PUBLISHED",
          saleMode: "PUBLIC_SALE",
        };
        throw new Error("fetch failed");
      },
    );
    const receipt = await confirm(await proposal("publish_course", publishRaw));
    expect(receipt).toMatchObject({ status: "SUCCEEDED", verified: true });
  });

  it("never guesses when the outcome cannot be re-read", async () => {
    m.publish.mockImplementationOnce(async () => {
      m.readFails = true;
      throw new Error("fetch failed");
    });
    const receipt = await confirm(await proposal("publish_course", publishRaw));
    expect(receipt.status).toBe("UNCERTAIN");
  });
});

describe("discount codes", () => {
  const percent = {
    organisationId: DUCELIO,
    code: "launch-25",
    discountKind: "PERCENT",
    percentOff: "25",
    expiresAt: "2031-01-01T09:00",
    redemptionLimit: "50",
    reason,
  };

  it("creates a confirmed coupon through the coupon authority, scoped to its organisation", async () => {
    const p = await proposal("create_coupon", percent);
    expect(p.blocked).toBe(false);
    expect((await confirm(p)).status).toBe("SUCCEEDED");
    expect(m.createCoupon).toHaveBeenCalledExactlyOnceWith(
      {
        code: "LAUNCH-25",
        expiresAt: "2031-01-01T09:00:00.000Z",
        redemptionLimit: 50,
        courseId: null,
        percentOff: 25,
        reason: `${reason} · Ops Engineer ref ${p.proposalId.slice(0, 8)}`,
      },
      DUCELIO,
    );
  });

  it("warns that a 100% coupon is free access and refuses a fixed amount in the wrong currency", async () => {
    const free = await proposal("create_coupon", {
      ...percent,
      percentOff: "100",
    });
    expect(
      free.checks.some((c) => !c.ok && c.text.includes("without any payment")),
    ).toBe(true);
    m.packages[1].status = "PUBLISHED";
    m.packages[1].course = {
      id: COURSE,
      offerId: "40000000-0000-4000-8000-000000000001",
      slug: "synthetic-ready",
      offerState: "PUBLISHED",
      saleMode: "PUBLIC_SALE",
    };
    m.catalogue = [
      { offerId: "40000000-0000-4000-8000-000000000001", currency: "GBP" },
    ];
    const wrong = await proposal("create_coupon", {
      ...percent,
      code: "TEN-DOLLARS",
      discountKind: "AMOUNT",
      amountOff: "10.00",
      currency: "USD",
      courseId: COURSE,
    });
    expect(blocking(wrong)).toEqual([
      "This course is priced in GBP; a fixed amount must use GBP.",
    ]);
  });

  it("never rewrites an existing code's terms", async () => {
    const p = await proposal("create_coupon", {
      ...percent,
      code: "SPRING-10",
    });
    expect(blocking(p)).toEqual([
      "This code already exists with different terms. Coupon terms cannot be changed; choose a new code.",
    ]);
    expect((await confirm(p)).status).toBe("REFUSED");
    expect(m.createCoupon).not.toHaveBeenCalled();
  });

  it("changes availability after confirmation and verifies it", async () => {
    const p = await proposal("set_coupon_active", {
      couponId: COUPON,
      active: "false",
      reason,
    });
    expect(p.display.find((d) => d.label === "Availability")?.value).toBe(
      "Active → Inactive",
    );
    expect(await confirm(p)).toMatchObject({
      status: "SUCCEEDED",
      verified: true,
    });
    expect(m.setActive).toHaveBeenCalledExactlyOnceWith(
      COUPON,
      false,
      `${reason} · Ops Engineer ref ${p.proposalId.slice(0, 8)}`,
    );
  });

  it("gives a partially protected change a shorter confirmation window", async () => {
    const t0 = new Date("2030-06-01T10:00:00Z");
    const toggle = await proposal(
      "set_coupon_active",
      { couponId: COUPON, active: "false", reason },
      null,
      t0,
    );
    const create = await proposal("create_coupon", percent, null, t0);
    expect(Date.parse(toggle.expiresAt) - t0.getTime()).toBe(5 * 60_000);
    expect(Date.parse(create.expiresAt) - t0.getTime()).toBe(15 * 60_000);
    const later = new Date(t0.getTime() + 6 * 60_000);
    expect((await confirm(toggle, null, {}, later)).status).toBe("EXPIRED");
    expect(m.setActive).not.toHaveBeenCalled();
  });
});

describe("confirmation and execution", () => {
  it("never executes without explicit confirmation", async () => {
    const p = await proposal("publish_course", publishRaw);
    expect((await confirm(p, null, { confirmed: false })).status).toBe(
      "REFUSED",
    );
    expect((await confirm(p, null, { confirmed: "true" })).status).toBe(
      "REFUSED",
    );
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses an altered proposal or input, re-validating at execution", async () => {
    const p = await proposal("publish_course", publishRaw);
    expect(
      (await confirm(p, null, { raw: { ...p.raw, price: "1.00" } })).status,
    ).toBe("STATE_CHANGED");
    expect(
      (await confirm(p, null, { raw: { ...p.raw, price: "free" } })).status,
    ).toBe("REFUSED");
    expect(
      (await confirm(p, null, { proposalId: "0".repeat(64) })).status,
    ).toBe("STATE_CHANGED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses when the records changed since the proposal", async () => {
    const p = await proposal("publish_course", publishRaw);
    m.packages[1].pendingDecisions = ["NEW_DECISION"];
    expect((await confirm(p)).status).toBe("STATE_CHANGED");
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("refuses an expired proposal", async () => {
    const t0 = new Date("2030-06-01T10:00:00Z");
    const p = await proposal("publish_course", publishRaw, null, t0);
    const later = new Date(t0.getTime() + 16 * 60_000);
    expect((await confirm(p, null, {}, later)).status).toBe("EXPIRED");
  });

  it("runs only one of two simultaneous confirmations on this server", async () => {
    let release!: () => void;
    m.publish.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) => (release = () => resolve({ replayed: false })),
        ),
    );
    const p = await proposal("publish_course", publishRaw);
    const first = confirm(p);
    await vi.waitFor(() => expect(m.publish).toHaveBeenCalledOnce());
    expect((await confirm(p)).status).toBe("DUPLICATE");
    release();
    await first;
    expect(m.publish).toHaveBeenCalledOnce();
  });

  it("prepares nothing when the current state cannot be read", async () => {
    m.readFails = true;
    expect((await prepareOperation("publish_course", publishRaw)).status).toBe(
      "UNAVAILABLE",
    );
  });
});

describe("natural-language interpretation", () => {
  it("says so truthfully when no AI provider is configured", async () => {
    const result = await interpretOperationRequest(
      "Why can't AWS be published?",
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
          action: "publish_course",
          arguments: publishRaw,
          explanation: "This publishes the ready course at £249.",
        }),
      },
    });
    const result = await interpretOperationRequest(
      "Put the ready course on sale at 249 pounds",
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
    // Reference data comes from the administrator's own authorised reads.
    expect(request.context.referenceData.organisations).toEqual([
      { value: DUCELIO, label: "Ducelio" },
    ]);
  });

  it("prepares an interpreted upload without a file, asking for the attachment", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {},
      response: {
        outputText: JSON.stringify({
          action: "upload_course_package",
          arguments: { organisationId: DUCELIO, reason },
          explanation: "Uploads the attached package.",
        }),
      },
    });
    const result = await interpretOperationRequest(
      "Upload the attached AWS package",
    );
    if (
      result.status !== "INTERPRETED" ||
      result.prepared.status !== "PROPOSAL"
    )
      throw new Error("expected a proposal");
    expect(result.prepared.proposal.blocked).toBe(true);
    expect(blocking(result.prepared.proposal)).toContain(
      "Attach the course package JSON file. Nothing has been uploaded.",
    );
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("discards an answer naming a retired or unknown operation", async () => {
    m.adapter = { name: "fake" };
    for (const action of ["publish_offer", "drop_table"]) {
      m.runtime.mockResolvedValue({
        outcome: "SUCCEEDED",
        usage: {},
        response: {
          outputText: JSON.stringify({
            action,
            arguments: {},
            explanation: "x",
          }),
        },
      });
      expect((await interpretOperationRequest("do it")).status).toBe(
        "AI_FAILED",
      );
    }
  });

  it("reports a failed model call without changing anything", async () => {
    m.adapter = { name: "fake" };
    m.runtime.mockResolvedValue({ outcome: "TIMEOUT", usage: {} });
    expect((await interpretOperationRequest("list coupons")).status).toBe(
      "AI_FAILED",
    );
    expect(m.createCoupon).not.toHaveBeenCalled();
  });
});
