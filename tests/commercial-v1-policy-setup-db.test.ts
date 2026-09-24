import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
} from "./commercial-v1-assessment-policy-fixture";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import type { PGlite } from "@electric-sql/pglite";

// ============================================================================
// Independent-review Finding 2: the actual Checkpoint C policy Server
// Actions (src/app/admin/activation/policy-actions.ts) driven through the
// real /admin/activation/policy composition (getCommercialV1PolicySetupOptions
// + the four actions themselves), against a real PGlite database -- not just
// their underlying server functions. This is the test the independent
// review found missing: the prior claim that these actions were "tested"
// referred only to the RPCs and grading orchestrator underneath them.
// ============================================================================

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCommercialV1PolicySetupOptions } from "@/server/commercial-v1-assessment-policy";
import {
  bindComponentAction,
  publishGradingPolicyAction,
  setLabPolicyAction,
  publishResultPolicyAction,
} from "@/app/admin/activation/policy-actions";

const RPCS: Record<string, string[]> = {
  get_commercial_v1_policy_setup_options: ["p_activation_id"],
  bind_commercial_v1_assessment_component: [
    "p_activation_id",
    "p_component",
    "p_assessment_id",
    "p_reason",
  ],
  publish_commercial_v1_grading_policy: ["p_activation_id", "p_reason"],
  set_commercial_v1_lab_policy: [
    "p_activation_id",
    "p_practical_id",
    "p_max_marks",
    "p_contribution_bp",
    "p_grading_guidance",
    "p_reason",
  ],
  publish_commercial_v1_result_policy: [
    "p_activation_id",
    "p_pass_mark_bp",
    "p_require_remediation_clear_for_completion",
    "p_reason",
  ],
};
function client(db: PGlite, state: CapabilityDbState) {
  const base = capabilityDbClient(db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in RPCS)) return base.rpc(name, args);
      const params = RPCS[name].map((k) => args[k]);
      // These RPCs raise a real Postgres exception (e.g. NOT_FOUND_OR_FORBIDDEN)
      // rather than returning a structured {ok:false} result -- a savepoint
      // is required so a deliberately-triggered denial doesn't abort the
      // whole outer test transaction, mirroring capabilityDbClient's own
      // reply() wrapper.
      await db.exec("savepoint policy_setup_rpc_call");
      try {
        const { rows } = await db.query<{ v: unknown }>(
          `select public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) as v`,
          params,
        );
        await db.exec("release savepoint policy_setup_rpc_call");
        return { data: rows[0]?.v ?? null, error: null };
      } catch (error) {
        await db.exec(
          "rollback to savepoint policy_setup_rpc_call; release savepoint policy_setup_rpc_call",
        );
        return {
          data: null,
          error: {
            code:
              typeof error === "object" && error && "code" in error
                ? String((error as { code: unknown }).code)
                : "TEST_FAILURE",
            message: "Private database error sentinel",
          },
        };
      }
    },
  };
}
async function actAs(db: PGlite, state: CapabilityDbState, n: number | null) {
  await asPolicyUser(db, n);
  state.authUser = n
    ? {
        id: `84000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        email_confirmed_at: "2026-01-01T00:00:00Z",
      }
    : null;
}
function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

async function policySetupFixture() {
  const f = await buildAssessmentPolicyFixture({
    withLabs: true,
    skipComponents: ["QUIZ_1"],
    publish: false,
  });
  // capabilityDbClient's rpc() wraps every call in a savepoint, which
  // requires an outer transaction; this fixture instance is single-use and
  // simply closed at the end.
  await f.db.exec("begin");
  const state: CapabilityDbState = { authUser: null, calls: [] };
  mocks.client.mockImplementation(async () => client(f.db, state));
  return { ...f, state };
}

describe("Commercial V1 policy setup: bounded admin read", () => {
  it("returns the activation's real assessments/practicals/bindings, privacy-bounded", async () => {
    const f = await policySetupFixture();
    await actAs(f.db, f.state, 2);
    const options = await getCommercialV1PolicySetupOptions(f.activationId);
    expect(options.activationId).toBe(f.activationId);
    expect(options.assessments).toHaveLength(6);
    const quiz1 = options.assessments.find(
      (a) => a.assessmentId === f.assessmentIds.QUIZ_1,
    );
    expect(quiz1?.boundComponent).toBeNull();
    const midterm = options.assessments.find(
      (a) => a.assessmentId === f.assessmentIds.MIDTERM,
    );
    expect(midterm?.boundComponent).toBe("MIDTERM");
    expect(options.practicals).toHaveLength(1);
    expect(options.practicals[0]).toMatchObject({
      hasLabPolicy: false,
      maxMarks: null,
      contributionBp: null,
    });
    expect(options.gradingPolicyPublished).toBe(false);
    expect(options.resultPolicyPublished).toBe(false);
    // Privacy-minimised: no question prompt, answer key, marking guidance,
    // learner response or any other protected content field anywhere in
    // this projection -- the strict zod schema already enforces this at
    // parse time (an extra key would fail parsing), so a passing parse is
    // itself the proof.
  });

  it("denies a learner (non-admin)", async () => {
    const f = await policySetupFixture();
    await actAs(f.db, f.state, 1);
    await expect(
      getCommercialV1PolicySetupOptions(f.activationId),
    ).rejects.toThrow();
  });

  it.each(["not-a-uuid", "00000000-0000-4000-8000-000000000000"])(
    "rejects an invalid/nonexistent activation id (%s)",
    async (id) => {
      const f = await policySetupFixture();
      await actAs(f.db, f.state, 2);
      await expect(getCommercialV1PolicySetupOptions(id)).rejects.toThrow();
    },
  );
});

describe("Commercial V1 policy setup: the actual Server Actions", () => {
  it("binds a component, publishes grading policy, sets a lab policy and publishes result policy end to end", async () => {
    const f = await policySetupFixture();
    await actAs(f.db, f.state, 2);
    const before = await getCommercialV1PolicySetupOptions(f.activationId);
    const quiz1 = before.assessments.find(
      (a) => a.assessmentId === f.assessmentIds.QUIZ_1,
    )!;
    expect(quiz1.boundComponent).toBeNull();

    const bindResult = await bindComponentAction(
      {},
      form({
        activationId: f.activationId,
        component: "QUIZ_1",
        assessmentId: quiz1.assessmentId,
        reason: "Bind QUIZ_1 through the actual Server Action",
      }),
    );
    expect(bindResult).toEqual({ message: "Component bound." });

    const publishGrading = await publishGradingPolicyAction(
      {},
      form({
        activationId: f.activationId,
        reason: "Publish grading policy through the actual Server Action",
      }),
    );
    expect(publishGrading).toEqual({ message: "Grading policy published." });

    const afterGrading = await getCommercialV1PolicySetupOptions(
      f.activationId,
    );
    expect(afterGrading.gradingPolicyPublished).toBe(true);
    expect(
      afterGrading.componentBindings.find((b) => b.component === "QUIZ_1")
        ?.assessmentId,
    ).toBe(quiz1.assessmentId);

    const practical = afterGrading.practicals[0];
    const labResult = await setLabPolicyAction(
      {},
      form({
        activationId: f.activationId,
        practicalId: practical.practicalId,
        maxMarks: "10",
        contributionBp: "2000",
        gradingGuidance: "Grade for correct configuration.",
        reason: "Set lab policy through the actual Server Action",
      }),
    );
    expect(labResult).toEqual({ message: "Lab policy saved." });

    const resultPolicy = await publishResultPolicyAction(
      {},
      form({
        activationId: f.activationId,
        passMarkBp: "5000",
        reason: "Publish result policy through the actual Server Action",
      }),
    );
    expect(resultPolicy).toEqual({ message: "Result policy published." });

    const after = await getCommercialV1PolicySetupOptions(f.activationId);
    expect(after.resultPolicyPublished).toBe(true);
    expect(after.practicals[0]).toMatchObject({
      hasLabPolicy: true,
      maxMarks: 10,
      contributionBp: 2000,
    });
  });

  it("bindComponentAction never lets the browser choose an unbounded assessment id", async () => {
    const f = await policySetupFixture();
    await actAs(f.db, f.state, 2);
    const result = await bindComponentAction(
      {},
      form({
        activationId: f.activationId,
        component: "QUIZ_1",
        assessmentId: randomUUID(),
        reason: "Foreign assessment id should be refused",
      }),
    );
    expect(result.error).toBeTruthy();
    const options = await getCommercialV1PolicySetupOptions(f.activationId);
    expect(
      options.assessments.find((a) => a.assessmentId === f.assessmentIds.QUIZ_1)
        ?.boundComponent,
    ).toBeNull();
  });

  it("a learner cannot bind a component or publish any policy", async () => {
    const f = await policySetupFixture();
    await actAs(f.db, f.state, 1);
    const result = await bindComponentAction(
      {},
      form({
        activationId: f.activationId,
        component: "QUIZ_1",
        assessmentId: f.assessmentIds.QUIZ_1,
        reason: "Learner attempt should be refused",
      }),
    );
    expect(result.error).toBeTruthy();
    const resultPolicy = await publishResultPolicyAction(
      {},
      form({
        activationId: f.activationId,
        passMarkBp: "5000",
        reason: "Learner attempt should be refused",
      }),
    );
    expect(resultPolicy.error).toBeTruthy();
  });
});
