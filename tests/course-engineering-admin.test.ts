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
  describeTestFailure,
  testRunResultSchema,
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
  testStatus: vi.fn(),
  runTest: vi.fn(),
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
  getCoursePackageTestStatus: mocks.testStatus,
  runCoursePackageTest: mocks.runTest,
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
  runCourseTestAction,
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
  mocks.testStatus.mockResolvedValue({
    status: "NOT_TESTED",
    outcome: null,
    failureCode: null,
    failedRoles: [],
    fingerprint: null,
    runSequence: null,
    runAt: null,
  });
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
  it("publish fails closed until the database reports a current passing pre-publication test", async () => {
    appliedPackage();

    // Never tested: a forged direct Server Action call still fails closed.
    mocks.testStatus.mockResolvedValue({
      status: "NOT_TESTED",
      outcome: null,
      failureCode: null,
      failedRoles: [],
      fingerprint: null,
      runSequence: null,
      runAt: null,
    });
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // A failed latest test for the current state still blocks publication.
    mocks.testStatus.mockResolvedValue({
      status: "FAILED",
      outcome: "FAIL",
      failureCode: "CONFIGURATION_MISMATCH",
      failedRoles: ["PROFESSOR"],
      fingerprint: "a".repeat(64),
      runSequence: 2,
      runAt: "2026-09-17T10:00:00Z",
    });
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // A stale PASS (state changed since the last passing test) still blocks.
    mocks.testStatus.mockResolvedValue({
      status: "PASSED_STALE",
      outcome: null,
      failureCode: null,
      failedRoles: [],
      fingerprint: null,
      runSequence: null,
      runAt: null,
    });
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("error");
    expect(mocks.publish).not.toHaveBeenCalled();

    // Only a current PASS allows the Server Action to delegate to the
    // database publication authority, which is the real gate.
    mocks.testStatus.mockResolvedValue({
      status: "PASSED_CURRENT",
      outcome: "PASS",
      failureCode: null,
      failedRoles: [],
      fingerprint: "b".repeat(64),
      runSequence: 3,
      runAt: "2026-09-17T10:05:00Z",
    });
    expect(
      await packageLifecycleAction({}, form({ operation: "publish" })),
    ).toHaveProperty("message");
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(id, "Explicit test review");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("agentConfigsMatchProposal preserves migration 027's exact comparison semantics", () => {
    // Migration 027 compares capabilities canonically and treats trimmed
    // empty instructional notes as NULL; this operator-workflow helper
    // (still used for the informational proposal display) must match those
    // semantics exactly, even though it no longer gates publication.
    const base = buildPackage();
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
    const equivalent = matchingConfigs(normalized);
    const professor = equivalent.find((c) => c.role === "PROFESSOR")!;
    professor.instructionalNotes = null;
    professor.capabilities = [...professor.capabilities].reverse();
    expect(
      agentConfigsMatchProposal(normalized.agentConfiguration, equivalent),
    ).toBe(true);
    const mismatch = matchingConfigs(base);
    mismatch[0] = { ...mismatch[0], enabled: !mismatch[0].enabled };
    expect(agentConfigsMatchProposal(base.agentConfiguration, mismatch)).toBe(
      false,
    );
    expect(
      agentConfigsMatchProposal(
        base.agentConfiguration,
        matchingConfigs(base).slice(0, 4),
      ),
    ).toBe(false);
  });
  it("runCourseTestAction relays the database's PASS/FAIL verdict without calculating it locally", async () => {
    appliedPackage();
    mocks.runTest.mockResolvedValue({
      id: "20000000-0000-4000-8000-000000000001",
      outcome: "PASS",
      failureCode: null,
      failedRoles: [],
      fingerprint: "c".repeat(64),
      runSequence: 1,
      runAt: "2026-09-17T10:00:00Z",
    });
    expect(await runCourseTestAction({}, form({}))).toEqual({
      message:
        "Pre-publication test passed for the exact current package, materialised institutional state and agent-configuration state.",
    });
    expect(mocks.runTest).toHaveBeenCalledWith(id, "Explicit test review");

    mocks.runTest.mockResolvedValue({
      id: "20000000-0000-4000-8000-000000000002",
      outcome: "FAIL",
      failureCode: "CONFIGURATION_INCOMPLETE",
      failedRoles: ["TUTOR", "COUNSELLOR"],
      fingerprint: "d".repeat(64),
      runSequence: 2,
      runAt: "2026-09-17T10:01:00Z",
    });
    const failed = await runCourseTestAction({}, form({}));
    expect(failed.error).toContain("Tutor");
    expect(failed.error).toContain("Counsellor");
    expect(failed).not.toHaveProperty("message");
  });
  it("describeTestFailure gives MATERIALIZED_STATE_MISMATCH a bounded, specific message, never the generic default", () => {
    const message = describeTestFailure("MATERIALIZED_STATE_MISMATCH", []);
    expect(message).not.toBe("The pre-publication test did not pass.");
    expect(message.length).toBeLessThanOrEqual(400);
  });
  it("a real MATERIALIZED_STATE_MISMATCH database result parses and produces its bounded operator message, never the generic catch path", async () => {
    // testRunResultSchema is exactly what src/server/course-engineering.ts
    // parses the run_course_package_test RPC row into. This proves the
    // schema accepts the DB's real failure code -- migration
    // 202609170035_commercial_v1_course_prepublication_test.sql's
    // course_package_test_runs.failure_code CHECK constraint includes
    // 'MATERIALIZED_STATE_MISMATCH' -- rather than rejecting it.
    const row = {
      id: "20000000-0000-4000-8000-000000000003",
      outcome: "FAIL",
      failureCode: "MATERIALIZED_STATE_MISMATCH",
      failedRoles: [],
      fingerprint: "e".repeat(64),
      runSequence: 3,
      runAt: "2026-09-17T10:02:00Z",
    };
    expect(() => testRunResultSchema.parse(row)).not.toThrow();

    appliedPackage();
    mocks.runTest.mockResolvedValue(row);
    const result = await runCourseTestAction({}, form({}));
    expect(result).not.toHaveProperty("message");
    // A bounded, specific operator message -- not describeTestFailure's
    // generic default ("The pre-publication test did not pass."), and never
    // raw SQL/exception content.
    expect(result.error).not.toBe("The pre-publication test did not pass.");
    expect(result.error).toContain("no longer matches");
    expect(result.error).not.toMatch(
      /SQLSTATE|PostgREST|relation ".*" does not exist/,
    );
  });
  it.each(["STUDENT", "REGISTRAR", "INSTRUCTOR", "COUNSELLOR"])(
    "%s cannot run the pre-publication test",
    async (role) => {
      mocks.actor.mockResolvedValue({ roles: [role] });
      expect(await runCourseTestAction({}, form({}))).toHaveProperty("error");
      expect(mocks.runTest).not.toHaveBeenCalled();
    },
  );
  it("test errors never reveal backend content", async () => {
    mocks.runTest.mockRejectedValue(
      new Error("PostgREST secret PROTECTED ANSWER"),
    );
    expect(JSON.stringify(await runCourseTestAction({}, form({})))).not.toMatch(
      /PostgREST|secret|PROTECTED/,
    );
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
  it("a successfully published package exposes activation without recomputing pre-publication readiness -- PUBLISHED status is itself the proof the database gate already passed", async () => {
    // Realistic post-publication state: publish_course_package's own
    // fingerprint binds programme_versions.status, so a pre-publication PASS
    // (necessarily recorded while status was DRAFT) can never still match
    // the current fingerprint once status is PUBLISHED. get_course_package_
    // test_status is therefore never even called for a PUBLISHED package --
    // it would report PASSED_STALE, and the page must not gate activation on
    // it. Leaving mocks.testStatus at its impossible-for-PUBLISHED
    // beforeEach default (NOT_TESTED) here is deliberate: it proves
    // activation exposure does not depend on that mock at all.
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
    expect(mocks.testStatus).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("an APPLIED package never exposes activation handoff, regardless of test status -- only Publish itself gates on readiness", async () => {
    mocks.list.mockResolvedValue([
      { ...metadata, status: "APPLIED", programme_version_id: version },
    ]);
    mocks.testStatus.mockResolvedValue({
      status: "PASSED_CURRENT",
      outcome: "PASS",
      failureCode: null,
      failedRoles: [],
      fingerprint: "e".repeat(64),
      runSequence: 1,
      runAt: "2026-09-17T10:00:00Z",
    });
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ importId: id }) }),
    );
    expect(html).not.toContain(`/admin/activation?importId=${id}`);
    expect(html).toContain("not configured");
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
