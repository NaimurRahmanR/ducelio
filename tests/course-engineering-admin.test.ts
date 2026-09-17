import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildPackage } from "./activation-fixture";
import {
  agentRoleSchema,
  roleCapabilityCatalogue,
  type AgentConfigRecord,
} from "@/domain/academic-agent-config";
import {
  MAX_COURSE_UPLOAD_BYTES,
  agentConfigsMatchProposal,
  operatorPreviewSchema,
  safeValidationIssues,
  packageActions,
} from "@/domain/course-engineering-admin";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  requireAnyRole: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  import: vi.fn(),
  validate: vi.fn(),
  apply: vi.fn(),
  publish: vi.fn(),
  reject: vi.fn(),
  configs: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireAnyRole: mocks.requireAnyRole,
}));
vi.mock("@/server/course-engineering", () => ({
  listCoursePackages: mocks.list,
  getCoursePackagePreview: mocks.preview,
  importCoursePackage: mocks.import,
  validateStagedCoursePackage: mocks.validate,
  applyCoursePackage: mocks.apply,
  publishCoursePackage: mocks.publish,
  rejectCoursePackage: mocks.reject,
}));
vi.mock("@/server/academic-agent-config", () => ({
  listAgentConfigs: mocks.configs,
  setAgentConfig: mocks.save,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }));
vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));
import Page from "@/app/admin/course-engineering/page";
import {
  importPackageAction,
  packageLifecycleAction,
  saveCourseAgentAction,
} from "@/app/admin/course-engineering/actions";
const id = "10000000-0000-4000-8000-000000000091",
  version = "10000000-0000-4000-8000-000000000092";
const metadata = {
  id,
  package_key: "test-package",
  package_revision: 1,
  schema_version: "COURSE_PACKAGE_V1",
  status: "IMPORTED",
  content_hash: "a".repeat(64),
  programme_id: null,
  programme_version_id: null,
  created_at: "2026-09-17T10:00:00Z",
  applied_at: null,
  published_at: null,
  rejected_at: null,
};
function form(extra: Record<string, string> = {}) {
  const data = new FormData();
  for (const [k, v] of Object.entries({
    importId: id,
    reason: "Explicit test review",
    ...extra,
  }))
    data.set(k, v);
  return data;
}
function matchingConfigs(pkg = buildPackage()): AgentConfigRecord[] {
  return agentRoleSchema.options.map((role) => ({
    id,
    programmeVersionId: version,
    role,
    policyVersion: "ACADEMIC_AGENT_CONFIG_V1",
    ...pkg.agentConfiguration[role],
    updatedAt: "2026-09-17T10:00:00Z",
  }));
}
function appliedPackage(pkg = buildPackage()) {
  const row = {
    ...metadata,
    status: "APPLIED",
    programme_version_id: version,
  };
  mocks.list.mockResolvedValue([row]);
  mocks.preview.mockResolvedValue({ ...row, preview: pkg });
  return row;
}

beforeEach(() => {
  vi.resetAllMocks();
  const actor = {
    id: "admin",
    displayName: "Admin",
    roles: ["ACADEMIC_ADMIN"],
  };
  mocks.actor.mockResolvedValue(actor);
  mocks.requireAnyRole.mockResolvedValue(actor);
  mocks.list.mockResolvedValue([metadata]);
  mocks.preview.mockResolvedValue({ ...metadata, preview: buildPackage() });
  mocks.import.mockResolvedValue(id);
  mocks.configs.mockResolvedValue([]);
});
describe("Course Engineering operator actions", () => {
  it.each(["STUDENT", "REGISTRAR", "INSTRUCTOR", "COUNSELLOR"])(
    "%s cannot import",
    async (role) => {
      mocks.actor.mockResolvedValue({ roles: [role] });
      const f = form();
      f.set("package", new File(["{}"], "test.json"));
      expect(await importPackageAction({}, f)).toHaveProperty("error");
      expect(mocks.import).not.toHaveBeenCalled();
    },
  );
  it("valid file calls the canonical import without automatic agent grants", async () => {
    const f = form();
    const pkg = buildPackage();
    f.set("package", new File([JSON.stringify(pkg)], "course.json"));
    expect(await importPackageAction({}, f)).toMatchObject({ importId: id });
    expect(mocks.import).toHaveBeenCalledWith(pkg, "Explicit test review");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["{broken", "[not json]", ""])(
    "rejects malformed upload %s without returning contents",
    async (body) => {
      const f = form();
      f.set("package", new File([body], "course.json"));
      expect(await importPackageAction({}, f)).toHaveProperty("error");
      expect(mocks.import).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized uploads", async () => {
    const f = form();
    f.set(
      "package",
      new File(["x".repeat(MAX_COURSE_UPLOAD_BYTES + 1)], "course.json"),
    );
    expect(await importPackageAction({}, f)).toMatchObject({
      error: expect.stringContaining("512 KiB"),
    });
    expect(mocks.import).not.toHaveBeenCalled();
  });
  it("rejects filesystem paths and invalid UTF-8", async () => {
    const f = form();
    f.set("package", "C:\\private.json");
    expect(await importPackageAction({}, f)).toHaveProperty("error");
    f.set("package", new File([new Uint8Array([0xff])], "file.json"));
    expect(await importPackageAction({}, f)).toHaveProperty("error");
    expect(mocks.import).not.toHaveBeenCalled();
  });
  it.each(["apply", "reject"])(
    "%s uses its existing authority",
    async (operation) => {
      mocks.list.mockResolvedValue([
        {
          ...metadata,
          status: operation === "apply" ? "VALIDATED" : "IMPORTED",
        },
      ]);
      expect(
        await packageLifecycleAction({}, form({ operation })),
      ).toHaveProperty("message");
      expect(mocks[operation as "apply" | "reject"]).toHaveBeenCalledWith(
        id,
        "Explicit test review",
      );
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );
  it("publish fails closed until all five saved configs match the proposal", async () => {
    const base = buildPackage();
    appliedPackage(base);

    // Zero saved rows: a forged direct Server Action call still fails closed.
    mocks.configs.mockResolvedValue([]);
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // Four of five rows is still incomplete.
    mocks.configs.mockResolvedValue(matchingConfigs(base).slice(0, 4));
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // One semantic mismatch must block publication.
    const mismatch = matchingConfigs(base);
    mismatch[0] = { ...mismatch[0], enabled: !mismatch[0].enabled };
    mocks.configs.mockResolvedValue(mismatch);
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // Migration 027 compares capabilities canonically and treats trimmed empty
    // instructional notes as NULL. The operator guard must match those semantics.
    const capabilities = roleCapabilityCatalogue.PROFESSOR.slice(0, 2);
    expect(capabilities).toHaveLength(2);
    const normalized = buildPackage({
      agentConfiguration: {
        ...base.agentConfiguration,
        PROFESSOR: {
          ...base.agentConfiguration.PROFESSOR,
          instructionalNotes: "",
          capabilities,
        },
      },
    });
    appliedPackage(normalized);
    const equivalent = matchingConfigs(normalized);
    const professor = equivalent.find((c) => c.role === "PROFESSOR")!;
    professor.instructionalNotes = null;
    professor.capabilities = [...professor.capabilities].reverse();
    expect(
      agentConfigsMatchProposal(normalized.agentConfiguration, equivalent),
    ).toBe(true);
    mocks.configs.mockResolvedValue(equivalent);
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("message");
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(id, "Explicit test review");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("validation discards the success package containing protected content", async () => {
    mocks.validate.mockResolvedValue({
      valid: true,
      package: buildPackage(),
      report: {},
    });
    const result = await packageLifecycleAction(
      {},
      form({ operation: "validate" }),
    );
    expect(result).toEqual({
      message: "Validation passed. The package is ready to apply.",
    });
    expect(mocks.validate).toHaveBeenCalledWith(id, "Explicit test review");
  });
  it("validation failure is useful but never echoes arbitrary error content", async () => {
    mocks.validate.mockResolvedValue({
      valid: false,
      errors: [
        {
          path: "assessmentTemplates.0.questions.0.expectedAnswer",
          code: "SCHEMA_INVALID",
          message: "PROTECTED ANSWER",
        },
        { path: "PROTECTED GUIDANCE", code: "bad", message: "secret" },
      ],
    });
    const result = await packageLifecycleAction(
      {},
      form({ operation: "validate" }),
    );
    expect(result.error).toContain("rejected");
    expect(result.issues?.[0]).toContain(
      "assessmentTemplates.0.questions.0.expectedAnswer",
    );
    expect(JSON.stringify(result)).not.toMatch(/PROTECTED|secret/);
  });
  it.each(["PUBLISHED", "REJECTED"])(
    "server rejects stale lifecycle commands for %s",
    async (status) => {
      mocks.list.mockResolvedValue([{ ...metadata, status }]);
      expect(
        await packageLifecycleAction({}, form({ operation: "apply" })),
      ).toHaveProperty("error");
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );
  it("unknown operation cannot act as an arbitrary RPC proxy", async () => {
    expect(
      await packageLifecycleAction({}, form({ operation: "arbitrary_sql" })),
    ).toHaveProperty("error");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("missing/foreign import fails closed", async () => {
    mocks.list.mockResolvedValue([]);
    expect(
      await packageLifecycleAction({}, form({ operation: "apply" })),
    ).toHaveProperty("error");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("explicit config derives its programme version from package metadata", async () => {
    mocks.list.mockResolvedValue([
      { ...metadata, status: "APPLIED", programme_version_id: version },
    ]);
    const f = form({
      role: "TUTOR",
      enabled: "false",
      escalationPolicy: "NONE",
      programmeVersionId: "forged",
    });
    f.append("capabilities", "get_lesson_context");
    expect(await saveCourseAgentAction({}, f)).toHaveProperty("message");
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        programmeVersionId: version,
        role: "TUTOR",
        enabled: false,
        capabilities: ["get_lesson_context"],
      }),
    );
  });
  it("config outside allowlist or before Apply is refused", async () => {
    const f = form({
      role: "COUNSELLOR",
      enabled: "true",
      escalationPolicy: "NONE",
    });
    f.append("capabilities", "record_learning_evidence");
    expect(await saveCourseAgentAction({}, f)).toHaveProperty("error");
    mocks.list.mockResolvedValue([
      { ...metadata, status: "APPLIED", programme_version_id: version },
    ]);
    expect(await saveCourseAgentAction({}, f)).toHaveProperty("error");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("errors do not reveal backend content", async () => {
    mocks.apply.mockRejectedValue(
      new Error("PostgREST secret PROTECTED ANSWER"),
    );
    mocks.list.mockResolvedValue([{ ...metadata, status: "VALIDATED" }]);
    expect(
      JSON.stringify(
        await packageLifecycleAction({}, form({ operation: "apply" })),
      ),
    ).not.toMatch(/PostgREST|secret|PROTECTED/);
  });
});
describe("operator page and safe projections", () => {
  it("enforces the administrative gate before reads", async () => {
    mocks.requireAnyRole.mockRejectedValue(new Error("denied"));
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "denied",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("renders list and safe preview without protected values even from an unredacted mock", async () => {
    const pkg = buildPackage();
    pkg.assessmentTemplates[0].questions[0].expectedAnswer =
      "ANSWER_SENTINEL_PRIVATE";
    pkg.assessmentTemplates[0].questions[0].markingGuidance =
      "GUIDANCE_SENTINEL_PRIVATE";
    mocks.preview.mockResolvedValue({
      ...metadata,
      preview: { ...pkg, unknownKey: "UNKNOWN_PRIVATE" },
    });
    const node = await Page({
      searchParams: Promise.resolve({ importId: id }),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("test-package");
    expect(html).toContain("Safe course preview");
    expect(html).not.toMatch(
      /ANSWER_SENTINEL|GUIDANCE_SENTINEL|UNKNOWN_PRIVATE/,
    );
    expect(
      JSON.stringify(node, (key, value) =>
        key === "type" || key.startsWith("_") ? undefined : value,
      ),
    ).not.toMatch(/ANSWER_SENTINEL|GUIDANCE_SENTINEL|UNKNOWN_PRIVATE/);
    expect(mocks.requireAnyRole).toHaveBeenCalledWith([
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
    ]);
  });
  it("invalid preview never gets dumped; validation remains available", async () => {
    mocks.preview.mockResolvedValue({
      ...metadata,
      preview: { expectedAnswer: "SECRET" },
    });
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ importId: id }) }),
    );
    expect(html).toContain("structured preview is unavailable");
    expect(html).toContain("Validate staged package");
    expect(html).not.toContain("SECRET");
  });
  it("published package with explicitly saved roles gets safe activation and commerce links", async () => {
    const p = {
      ...metadata,
      status: "PUBLISHED",
      programme_version_id: version,
    };
    mocks.list.mockResolvedValue([p]);
    mocks.preview.mockResolvedValue({ ...p, preview: buildPackage() });
    mocks.configs.mockResolvedValue(matchingConfigs());
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ importId: id }) }),
    );
    expect(html).toContain(`/admin/activation?importId=${id}`);
    expect(html).toContain("/admin/commerce");
    expect(mocks.configs).toHaveBeenCalledWith(version);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("unconfigured roles do not produce activation handoff", async () => {
    mocks.list.mockResolvedValue([
      { ...metadata, status: "PUBLISHED", programme_version_id: version },
    ]);
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ importId: id }) }),
    );
    expect(html).not.toContain(`/admin/activation?importId=${id}`);
    expect(html).toContain("not configured");

    const pkg = buildPackage();
    const mismatch = matchingConfigs(pkg);
    mismatch[0] = { ...mismatch[0], enabled: !mismatch[0].enabled };
    mocks.configs.mockResolvedValue(mismatch);
    mocks.preview.mockResolvedValue({
      ...metadata,
      status: "PUBLISHED",
      programme_version_id: version,
      preview: pkg,
    });
    const mismatchedHtml = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ importId: id }) }),
    );
    expect(mismatchedHtml).not.toContain(`/admin/activation?importId=${id}`);
  });
  it("listing failure is not reported as empty success", async () => {
    mocks.list.mockRejectedValue(new Error("DB SECRET"));
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("listing is unavailable");
    expect(html).not.toContain("DB SECRET");
  });
  it("malicious query identifiers are not rendered or used in RPC calls", async () => {
    const html = renderToStaticMarkup(
      await Page({
        searchParams: Promise.resolve({ importId: "javascript:alert(1)" }),
      }),
    );
    expect(html).not.toContain("javascript:alert(1)");
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("projection strips protected fields recursively at the assessment boundary", () => {
    const p = operatorPreviewSchema.parse(buildPackage());
    expect(JSON.stringify(p)).not.toContain("verifying identity");
    expect(p.assessmentTemplates[0]).toMatchObject({
      questionCount: 1,
      totalMarks: 5,
    });
    expect(p.assessmentTemplates[0]).not.toHaveProperty("questions");
  });
  it("bounded validation reporting and lifecycle choices", () => {
    expect(
      safeValidationIssues(
        Array.from({ length: 100 }, () => ({ path: "unknown", code: "bad" })),
      ),
    ).toHaveLength(20);
    expect(packageActions("bogus")).toEqual([]);
    expect(packageActions("VALIDATED")).toEqual(["apply", "reject"]);
    expect(packageActions("APPLIED", false)).toEqual([]);
    expect(packageActions("APPLIED", true)).toEqual(["publish"]);
  });
});
