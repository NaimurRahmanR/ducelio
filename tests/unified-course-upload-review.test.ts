import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { approvedTestPackage } from "./academy-fixture";

// Upload, publication preflight and decision-only academic resolution over
// the real validator, with the database RPCs replaced by a recorded model.
// The point is what is (and is not) written before the database decides.
const DUCELIO = "00000000-0000-4000-8000-000000000001";
const EXTERNAL = "00000000-0000-4000-8000-0000000000ee";
const SOURCE = "10000000-0000-4000-8000-000000000001";
const NEW_ID = "10000000-0000-4000-8000-0000000000f1";

const m = vi.hoisted(() => ({
  roles: ["ACADEMIC_ADMIN"] as string[],
  unified: [] as Record<string, unknown>[],
  legacy: [] as Record<string, unknown>[],
  content: new Map<string, unknown>(),
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refusal: null as string | null,
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({
    id: "60000000-0000-4000-8000-000000000001",
    displayName: "Avery Admin",
    roles: m.roles,
  }),
  requireActor: async () => ({ roles: m.roles }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      m.calls.push({ name, args });
      switch (name) {
        case "list_unified_course_packages":
          return { data: m.unified, error: null };
        case "list_academy_course_packages":
          return { data: m.legacy, error: null };
        case "get_academy_course_package_content":
          return {
            data: m.content.get(String(args.p_package_id)),
            error: null,
          };
        case "get_academy_course_package_review":
          return {
            data: { id: args.p_package_id, status: "UPLOADED", review: null },
            error: null,
          };
        case "upload_organisation_course_package":
          m.content.set(NEW_ID, args.p_raw_package);
          return { data: NEW_ID, error: null };
        case "mark_academy_course_package_validated":
        case "reject_academy_course_package":
          return { data: args.p_package_id, error: null };
        case "revise_unified_course_package":
          return m.refusal
            ? { data: null, error: { message: m.refusal } }
            : { data: NEW_ID, error: null };
        default:
          return { data: null, error: { message: "UNEXPECTED_RPC" } };
      }
    },
  }),
}));

import {
  checkUnifiedCoursePackageUpload,
  resolveUnifiedCourseDecisions,
  storedKeyCandidates,
} from "@/server/unified-course-engine";
import { uploadAndValidateAction } from "@/app/admin/academy-course-engineering/actions";
import { publishUnifiedAction } from "@/app/admin/course-engineering/unified-actions";
import { resolveDecisionsAction } from "@/app/admin/course-engineering/review/actions";

const source = () => {
  const p = approvedTestPackage("synthetic-upload-review");
  p.pendingDecisions = [
    { key: "SOURCE_REVIEW", summary: "TEST ONLY source review required." },
    { key: "EXAM_REVIEW", summary: "TEST ONLY exam review required." },
  ];
  return p;
};
const row = (over: Record<string, unknown> = {}) => ({
  organisationId: DUCELIO,
  organisationName: "Ducelio",
  id: SOURCE,
  packageKey: "synthetic-upload-review",
  packageRevision: 1,
  status: "VALIDATED",
  contentHash: "h",
  createdAt: "2026-10-26T10:00:00Z",
  validatedAt: "2026-10-26T10:00:01Z",
  publishedAt: null,
  rejectedReason: null,
  title: "Synthetic",
  pendingDecisions: ["SOURCE_REVIEW", "EXAM_REVIEW"],
  curriculumImport: null,
  course: null,
  ...over,
});
const writes = () =>
  m.calls
    .map((c) => c.name)
    .filter((n) => !n.startsWith("list_") && !n.startsWith("get_"));
const uploadForm = (json: unknown, org?: string) => {
  const f = new FormData();
  f.set("reason", "Synthetic upload test");
  f.set(
    "package",
    new File([JSON.stringify(json)], "course.json", {
      type: "application/json",
    }),
  );
  if (org) f.set("organisationId", org);
  return f;
};

beforeEach(() => {
  m.roles = ["ACADEMIC_ADMIN"];
  m.unified = [];
  m.legacy = [];
  m.content = new Map();
  m.calls = [];
  m.refusal = null;
});

describe("upload pre-check", () => {
  it("rejects an invalid package with specific findings before any record exists", async () => {
    const bad = source();
    bad.packageRevision = 0;
    const check = await checkUnifiedCoursePackageUpload(bad, DUCELIO);
    expect(check.status).toBe("INVALID");
    if (check.status === "INVALID")
      expect(check.issues.join(" ")).toMatch(/packageRevision/);
    expect(writes()).toEqual([]);
  });

  it("is ready for a new revision and reports the latest stored one", async () => {
    const next = source();
    next.packageRevision = 2;
    next.curriculum.packageRevision = 2;
    m.unified = [row()];
    expect(await checkUnifiedCoursePackageUpload(next, DUCELIO)).toMatchObject({
      status: "READY",
      revision: 2,
      latestRevision: 1,
      pendingDecisions: 2,
    });
  });

  it("recognises an identical re-upload regardless of key order", async () => {
    const pkg = source();
    m.unified = [row()];
    const reordered = Object.fromEntries(Object.entries(pkg).reverse());
    m.content.set(SOURCE, reordered);
    expect(await checkUnifiedCoursePackageUpload(pkg, DUCELIO)).toMatchObject({
      status: "ALREADY_UPLOADED",
      packageId: SOURCE,
    });
  });

  it("explains a conflicting revision, including one stored before organisation ownership", async () => {
    const pkg = source();
    m.unified = [row()];
    m.content.set(SOURCE, { ...pkg, reason: "different content" });
    expect(await checkUnifiedCoursePackageUpload(pkg, DUCELIO)).toMatchObject({
      status: "REVISION_TAKEN",
      revision: 1,
      nextRevision: 2,
      existingId: SOURCE,
    });
    m.unified = [];
    m.legacy = [
      row({
        id: "10000000-0000-4000-8000-000000000002",
        organisationId: undefined,
        packageRevision: 1,
        status: "PUBLISHED",
      }),
      row({
        id: "10000000-0000-4000-8000-000000000003",
        organisationId: undefined,
        packageRevision: 2,
        status: "VALIDATED",
      }),
    ];
    expect(await checkUnifiedCoursePackageUpload(pkg, DUCELIO)).toMatchObject({
      status: "REVISION_TAKEN",
      existingStatus: "PUBLISHED",
      existingId: null,
      latestRevision: 2,
      nextRevision: 3,
    });
  });

  it("finds an external organisation's namespaced key, exactly as the database stores it", async () => {
    const stored =
      "org-" +
      createHash("sha256")
        .update(`${EXTERNAL}:synthetic-upload-review`)
        .digest("hex");
    expect(storedKeyCandidates("synthetic-upload-review", EXTERNAL)).toEqual([
      "synthetic-upload-review",
      stored,
    ]);
    const pkg = source();
    m.unified = [row({ organisationId: EXTERNAL, packageKey: stored })];
    m.content.set(SOURCE, {
      ...pkg,
      packageKey: stored,
      curriculum: { ...pkg.curriculum, packageKey: stored },
    });
    expect(await checkUnifiedCoursePackageUpload(pkg, EXTERNAL)).toMatchObject({
      status: "ALREADY_UPLOADED",
    });
    // The legacy register is a Ducelio-only concept.
    expect(m.calls.map((c) => c.name)).not.toContain(
      "list_academy_course_packages",
    );
  });
});

describe("Course Engineering upload action", () => {
  it("stores nothing for an invalid package and lists its findings", async () => {
    const bad = source();
    bad.packageRevision = 0;
    const state = await uploadAndValidateAction({}, uploadForm(bad));
    expect(state.error).toMatch(/Nothing was stored/);
    expect(state.issues?.length).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });

  it("refuses an occupied revision with the next free number and stores nothing", async () => {
    const pkg = source();
    m.unified = [row()];
    m.content.set(SOURCE, { ...pkg, reason: "different content" });
    const state = await uploadAndValidateAction({}, uploadForm(pkg));
    expect(state.error).toContain('set "packageRevision" to 2');
    expect(state.packageId).toBe(SOURCE);
    expect(writes()).toEqual([]);
  });

  it("uploads then validates a new revision, and reports its pending decisions", async () => {
    const state = await uploadAndValidateAction({}, uploadForm(source()));
    expect(writes()).toEqual([
      "upload_organisation_course_package",
      "mark_academy_course_package_validated",
    ]);
    expect(state).toMatchObject({ packageId: NEW_ID });
    expect(state.message).toContain("2 academic decisions pending");
  });

  it("creates nothing for an identical re-upload of a validated revision", async () => {
    const pkg = source();
    m.unified = [row()];
    m.content.set(SOURCE, pkg);
    const state = await uploadAndValidateAction({}, uploadForm(pkg));
    expect(state.message).toMatch(/already stored as revision 1/);
    expect(writes()).toEqual([]);
  });
});

describe("publication preflight", () => {
  it("writes nothing, not even an agent revision, while decisions are pending", async () => {
    m.unified = [row()];
    m.content.set(SOURCE, source());
    const f = new FormData();
    for (const [k, v] of Object.entries({
      packageId: SOURCE,
      slug: "synthetic-upload-review",
      currency: "GBP",
      price: "99.00",
      reason: "Synthetic publication test",
      confirm: "on",
    }))
      f.set(k, v);
    const state = await publishUnifiedAction({}, f);
    expect(state.error).toContain("SOURCE_REVIEW, EXAM_REVIEW");
    expect(state.error).toContain("nothing was changed");
    expect(writes()).toEqual([]);
    expect(m.calls.map((c) => c.name)).not.toContain(
      "get_academy_course_package_content",
    );
  });
});

describe("decision-only academic resolution", () => {
  const resolution = {
    key: "SOURCE_REVIEW",
    evidenceReference: "TEST-REVIEW-RECORD-0001",
    rationale: "TEST ONLY synthetic reviewer confirmed the sources.",
  };

  it("derives the next revision on the server with only the resolved decision removed", async () => {
    const pkg = source();
    m.unified = [row()];
    m.content.set(SOURCE, pkg);
    const requestKey = crypto.randomUUID();
    expect(
      await resolveUnifiedCourseDecisions({
        sourceId: SOURCE,
        requestKey,
        reason: "Synthetic review",
        resolutions: [resolution],
      }),
    ).toEqual({ ok: true, packageId: NEW_ID });
    const call = m.calls.find(
      (c) => c.name === "revise_unified_course_package",
    )!;
    const raw = call.args.p_raw_package as typeof pkg;
    expect(raw.packageRevision).toBe(2);
    expect(raw.curriculum.packageRevision).toBe(2);
    expect(raw.pendingDecisions.map((d: { key: string }) => d.key)).toEqual([
      "EXAM_REVIEW",
    ]);
    // Nothing else in the package changed.
    expect({
      ...raw,
      packageRevision: 1,
      curriculum: { ...raw.curriculum, packageRevision: 1 },
      pendingDecisions: pkg.pendingDecisions,
    }).toEqual(pkg);
    expect(call.args.p_resolutions).toEqual([resolution]);
    expect(call.args.p_request_key).toBe(requestKey);
  });

  it("refuses to resolve on a superseded revision, or a decision that is not pending", async () => {
    m.unified = [
      row(),
      row({ id: "10000000-0000-4000-8000-000000000002", packageRevision: 2 }),
    ];
    m.content.set(SOURCE, source());
    const base = {
      sourceId: SOURCE,
      requestKey: crypto.randomUUID(),
      reason: "Synthetic review",
    };
    expect(
      await resolveUnifiedCourseDecisions({
        ...base,
        resolutions: [resolution],
      }),
    ).toMatchObject({ ok: false, code: "NEWER_REVISION" });
    m.unified = [row()];
    await expect(
      resolveUnifiedCourseDecisions({
        ...base,
        resolutions: [{ ...resolution, key: "NOT_PENDING" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(writes()).toEqual([]);
  });

  it("requires an explicit selection, attestation and evidence before any write", async () => {
    m.unified = [row()];
    m.content.set(SOURCE, source());
    const form = (values: Record<string, string | string[]>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(values))
        for (const x of [v].flat()) f.append(k, x);
      return f;
    };
    const base = {
      sourceId: SOURCE,
      requestKey: crypto.randomUUID(),
      reason: "Synthetic review",
      evidence_SOURCE_REVIEW: resolution.evidenceReference,
      rationale_SOURCE_REVIEW: resolution.rationale,
    };
    expect(
      (await resolveDecisionsAction({}, form({ ...base, attest: "on" }))).error,
    ).toMatch(/Select at least one/);
    expect(
      (
        await resolveDecisionsAction(
          {},
          form({ ...base, decision: "SOURCE_REVIEW" }),
        )
      ).error,
    ).toMatch(/Attest/);
    expect(
      (
        await resolveDecisionsAction(
          {},
          form({
            ...base,
            decision: "SOURCE_REVIEW",
            attest: "on",
            evidence_SOURCE_REVIEW: "short",
          }),
        )
      ).error,
    ).toMatch(/evidence reference of 10–300/);
    expect(writes()).toEqual([]);
  });

  it("reports the database's refusal for a reviewer without authority", async () => {
    m.unified = [row()];
    m.content.set(SOURCE, source());
    m.refusal = "ACADEMIC_EVIDENCE_REQUIRED";
    const f = new FormData();
    for (const [k, v] of Object.entries({
      sourceId: SOURCE,
      requestKey: crypto.randomUUID(),
      reason: "Synthetic review",
      decision: "SOURCE_REVIEW",
      attest: "on",
      evidence_SOURCE_REVIEW: resolution.evidenceReference,
      rationale_SOURCE_REVIEW: resolution.rationale,
    }))
      f.set(k, v);
    expect((await resolveDecisionsAction({}, f)).error).toMatch(
      /needs academic review authority/,
    );
  });
});
