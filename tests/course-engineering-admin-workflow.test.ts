import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildPackage } from "./activation-fixture";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  administrator,
} from "./commercial-v1-assessment-policy-fixture";
import { agentRoleSchema } from "@/domain/academic-agent-config";
import { operatorPreviewSchema } from "@/domain/course-engineering-admin";
const mocks = vi.hoisted(() => ({ client: vi.fn(), actor: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.actor,
  requireActor: mocks.actor,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import {
  importPackageAction,
  packageLifecycleAction,
  saveCourseAgentAction,
  runCourseTestAction,
} from "@/app/admin/course-engineering/actions";
import {
  listCoursePackages,
  getCoursePackagePreview,
} from "@/server/course-engineering";
import { listAgentConfigs } from "@/server/academic-agent-config";
let db: PGlite;
beforeAll(async () => {
  const f = await buildAssessmentPolicyFixture({ withLabs: false });
  db = f.db;
  await asPolicyUser(db, 2);
  mocks.actor.mockResolvedValue({
    id: administrator,
    roles: ["ACADEMIC_ADMIN"],
    displayName: "Test admin",
  });
  // PostgREST-shaped adapter only in the test. Actual actions and actual Academy
  // OS services run against the real migrated database and its RLS/RPC checks.
  const allowed = new Set([
    "import_course_package",
    "list_course_packages",
    "get_course_package_preview",
    "get_course_package_content",
    "mark_course_package_validated",
    "reject_course_package",
    "apply_course_package",
    "publish_course_package",
    "set_agent_config",
    "list_agent_configs",
    "run_course_package_test",
    "get_course_package_test_status",
  ]);
  // Functions returning a multi-column `table(...)` (not a single scalar
  // aliased to the function's own name) hand back the whole row, exactly
  // like list_/get_course_package_preview already do below.
  const multiColumn = new Set([
    "run_course_package_test",
    "get_course_package_test_status",
  ]);
  mocks.client.mockResolvedValue({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (!allowed.has(name)) throw new Error("Unexpected authority");
      try {
        const params = Object.entries(args).map(([key, v]) =>
          key === "p_raw_package" || key === "p_validation_report"
            ? JSON.stringify(v)
            : v,
        );
        const result = await db.query(
          `select * from public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")})`,
          params,
        );
        const rows = JSON.parse(JSON.stringify(result.rows));
        return {
          data:
            name.startsWith("list_") ||
            name === "get_course_package_preview" ||
            multiColumn.has(name)
              ? rows
              : rows[0][name],
          error: null,
        };
      } catch {
        return { data: null, error: { message: "Test RPC unavailable" } };
      }
    },
  });
}, 60000);
afterAll(async () => {
  await db?.close();
});
function form(id: string, extra: Record<string, string> = {}) {
  const f = new FormData();
  Object.entries({
    importId: id,
    reason: "Operator workflow test",
    ...extra,
  }).forEach(([k, v]) => f.set(k, v));
  return f;
}
describe("real Course Engineering admin journey", () => {
  it("upload → list → validate → redacted preview → apply → explicit role saves → publish", async () => {
    const pkg = buildPackage({
      packageKey: "operator-workflow-test-only",
      curriculumVersion: { label: "Operator test data" },
    });
    pkg.assessmentTemplates[0].questions[0].expectedAnswer =
      "PRIVATE_EXPECTED_ANSWER_SENTINEL";
    pkg.assessmentTemplates[0].questions[0].markingGuidance =
      "PRIVATE_MARKING_GUIDANCE_SENTINEL";
    const upload = form("");
    upload.set("package", new File([JSON.stringify(pkg)], "test-only.json"));
    const imported = await importPackageAction({}, upload);
    expect(imported.error).toBeUndefined();
    const id = imported.importId!;
    expect(await listCoursePackages()).toContainEqual(
      expect.objectContaining({ id, status: "IMPORTED" }),
    );
    expect(
      await packageLifecycleAction({}, form(id, { operation: "validate" })),
    ).toHaveProperty("message");
    const validationPreview = await getCoursePackagePreview(id);
    expect(validationPreview.status).toBe("VALIDATED");
    expect(JSON.stringify(validationPreview)).not.toMatch(
      /PRIVATE_EXPECTED_ANSWER_SENTINEL|PRIVATE_MARKING_GUIDANCE_SENTINEL/,
    );
    expect(
      operatorPreviewSchema.parse(validationPreview.preview)
        .assessmentTemplates[0].questionCount,
    ).toBe(1);
    expect(
      await packageLifecycleAction({}, form(id, { operation: "apply" })),
    ).toHaveProperty("message");
    const applied = await getCoursePackagePreview(id);
    expect(applied.status).toBe("APPLIED");
    expect(applied.programme_version_id).toBeTruthy();
    expect(await listAgentConfigs(applied.programme_version_id!)).toEqual([]);
    expect(
      await packageLifecycleAction({}, form(id, { operation: "publish" })),
    ).toHaveProperty("error");
    expect((await getCoursePackagePreview(id)).status).toBe("APPLIED");
    for (const role of agentRoleSchema.options) {
      expect(
        await saveCourseAgentAction(
          {},
          form(id, { role, enabled: "false", escalationPolicy: "NONE" }),
        ),
      ).toHaveProperty("message");
    }
    expect(await listAgentConfigs(applied.programme_version_id!)).toHaveLength(
      5,
    );
    // Publish still fails closed -- no pre-publication test has run yet.
    expect(
      await packageLifecycleAction({}, form(id, { operation: "publish" })),
    ).toHaveProperty("error");
    expect((await getCoursePackagePreview(id)).status).toBe("APPLIED");
    const testResult = await runCourseTestAction({}, form(id, {}));
    expect(testResult).toEqual({
      message:
        "Pre-publication test passed for the exact current package, materialised institutional state and agent-configuration state.",
    });
    expect(
      await packageLifecycleAction({}, form(id, { operation: "publish" })),
    ).toHaveProperty("message");
    expect(await listCoursePackages()).toContainEqual(
      expect.objectContaining({
        id,
        status: "PUBLISHED",
        programme_version_id: applied.programme_version_id,
      }),
    );
    expect(
      await packageLifecycleAction({}, form(id, { operation: "reject" })),
    ).toHaveProperty("error");
  });
  it("invalid staged data is rejected by canonical validation without rendering contents", async () => {
    const p = {
      ...buildPackage(),
      packageKey: "invalid-operator-test-only",
      modules: [],
    };
    const f = form("");
    f.set("package", new File([JSON.stringify(p)], "invalid.json"));
    const imported = await importPackageAction({}, f);
    expect(imported.importId).toBeTruthy();
    const result = await packageLifecycleAction(
      {},
      form(imported.importId!, { operation: "validate" }),
    );
    expect(result).toHaveProperty("error");
    expect(
      (await listCoursePackages()).find((p) => p.id === imported.importId)
        ?.status,
    ).toBe("REJECTED");
  });
});
