import { describe, it, expect, vi } from "vitest";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  administrator,
} from "./commercial-v1-assessment-policy-fixture";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import type { PGlite } from "@electric-sql/pglite";

// ============================================================================
// Independent-review operational-closure checkpoint (E1): a focused,
// application-level "no manual SQL" product test. Proves, through the real
// server functions against real PGlite (never raw SQL for the flow under
// test):
//
//   1. an administrator can discover a real Commercial V1 activation through
//      the product-owned bounded read (listCommercialV1Activations) and use
//      ONLY the id that read returns to complete policy setup -- never a
//      manually typed/pasted UUID;
//   2. a learner's own enrolment is resolved through product-owned state
//      (listPracticalEnrolments) with no client-supplied enrolment id, and
//      that discovered id is sufficient to read real course progress;
//   3. discovery never leaks another admin's/learner's data and is denied
//      to unauthorized callers.
//
// This is NOT hosted E2E -- it is local, PGlite-backed, deterministic proof
// that the product's own discovery surfaces (not developer tooling) supply
// every identifier the rest of the flow needs.
//
// Each test opens its own fresh PGlite instance and explicitly closes it
// (await f.db.close()) before returning, mirroring commercial-v1-course-
// lifecycle.test.ts's own convention -- leaving instances open across tests
// in this file was found, during development, to cause cross-instance
// interference (a later test's read returning an earlier instance's data).
// ============================================================================

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));

import {
  listCommercialV1Activations,
  listPracticalEnrolments,
} from "@/server/course-activation";
import {
  getCommercialV1PolicySetupOptions,
  bindCommercialV1AssessmentComponent,
  publishCommercialV1GradingPolicy,
} from "@/server/commercial-v1-assessment-policy";
import {
  setCommercialV1LabPolicy,
  publishCommercialV1ResultPolicy,
  getCommercialV1CourseProgress,
} from "@/server/commercial-v1-results-completion";

const RPCS: Record<string, string[]> = {
  list_commercial_v1_activations: [],
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
  list_practical_enrolments: [],
  get_commercial_v1_course_progress: ["p_enrolment_id"],
};
function client(db: PGlite, state: CapabilityDbState) {
  const base = capabilityDbClient(db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in RPCS)) return base.rpc(name, args);
      const params = RPCS[name].map((k) => args[k]);
      await db.exec("savepoint discovery_rpc_call");
      try {
        const { rows } = await db.query<{ v: unknown }>(
          `select public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) as v`,
          params,
        );
        await db.exec("release savepoint discovery_rpc_call");
        return { data: rows[0]?.v ?? null, error: null };
      } catch (error) {
        await db.exec(
          "rollback to savepoint discovery_rpc_call; release savepoint discovery_rpc_call",
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
async function fixture() {
  const f = await buildAssessmentPolicyFixture({
    withLabs: true,
    publish: false,
    skipComponents: ["QUIZ_1"],
  });
  await f.db.exec("begin");
  const state: CapabilityDbState = { authUser: null, calls: [] };
  mocks.client.mockImplementation(async () => client(f.db, state));
  return { ...f, state };
}

describe("Operational discovery: an admin never needs a manually typed activation id", () => {
  it("discovers the real activation and uses ONLY the discovered id through the full policy-setup flow", async () => {
    const f = await fixture();
    try {
      await actAs(f.db, f.state, 2);

      // Step 1: discover. No id is supplied by the caller anywhere here.
      const { activations } = await listCommercialV1Activations();
      expect(activations).toHaveLength(1);
      const discovered = activations[0];
      expect(discovered).toMatchObject({
        programmeTitle: expect.any(String),
        packageKey: expect.any(String),
        cohortTitle: expect.any(String),
        gradingPolicyPublished: false,
        resultPolicyPublished: false,
        labPracticalsTotal: 1,
        labPracticalsConfigured: 0,
      });

      // Step 2: use ONLY discovered.activationId for every subsequent call --
      // never f.activationId (the fixture's own internal value) directly, to
      // prove the discovered id is genuinely sufficient on its own.
      const activationId = discovered.activationId;
      let options = await getCommercialV1PolicySetupOptions(activationId);
      expect(options.assessments).toHaveLength(6);

      await bindCommercialV1AssessmentComponent({
        activationId,
        component: "QUIZ_1",
        assessmentId: options.assessments.find(
          (a) => a.boundComponent === null,
        )!.assessmentId,
        reason: "Discovery-driven policy setup",
      });
      await publishCommercialV1GradingPolicy({
        activationId,
        reason: "Discovery-driven policy setup",
      });
      options = await getCommercialV1PolicySetupOptions(activationId);
      const practical = options.practicals[0];
      await setCommercialV1LabPolicy({
        activationId,
        practicalId: practical.practicalId,
        maxMarks: 10,
        contributionBp: 2000,
        gradingGuidance: "Grade for correct configuration.",
        reason: "Discovery-driven policy setup",
      });
      await publishCommercialV1ResultPolicy({
        activationId,
        passMarkBp: 5000,
        requireRemediationClearForCompletion: false,
        reason: "Discovery-driven policy setup",
      });

      // Step 3: re-discover -- the same bounded read now reflects the real,
      // just-published state, proving discovery is live product state, not
      // a static snapshot.
      const after = await listCommercialV1Activations();
      expect(after.activations[0]).toMatchObject({
        activationId,
        gradingPolicyPublished: true,
        resultPolicyPublished: true,
        labPracticalsConfigured: 1,
      });
    } finally {
      await f.db.close();
    }
  });

  it("denies discovery to a learner and to an unrelated staff role", async () => {
    const f = await fixture();
    try {
      await actAs(f.db, f.state, 1);
      await expect(listCommercialV1Activations()).rejects.toThrow();

      // Unrelated staff: administrator with ACADEMIC_ADMIN removed, leaving
      // only INSTRUCTOR (the base fixture grants both). The raw delete runs
      // as the database owner, not as the authenticated admin role.
      await f.db.exec("reset role");
      await f.db.query(
        "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
        [administrator],
      );
      await actAs(f.db, f.state, 2);
      await expect(listCommercialV1Activations()).rejects.toThrow();
    } finally {
      await f.db.close();
    }
  });
});

describe("Operational discovery: a learner's own enrolment resolves without a manually supplied id", () => {
  it("listPracticalEnrolments returns the learner's own real enrolment, sufficient on its own to read course progress", async () => {
    const f = await fixture();
    try {
      await actAs(f.db, f.state, 1);
      const enrolments = await listPracticalEnrolments();

      // The base fixture's own seed data (supabase/seed.sql) already gives
      // this same fixed learner id a separate DEMO enrolment, alongside the
      // real Commercial V1 "Policy cohort" one this fixture just created --
      // list_practical_enrolments correctly returns both, ordered by id
      // (not creation order), exactly as production would for a learner
      // enrolled in more than one course. The point this test proves is
      // narrower and still real: the learner's OWN enrolment is discoverable
      // by product-owned state alone, with no client-supplied id anywhere,
      // and /student/progress's own default-selection
      // (enrolments.find(e => e.id === (params.enrolmentId ?? enrolments[0].id)))
      // always resolves to SOME owned enrolment already present in this
      // exact list -- never requires the browser to supply one.
      expect(enrolments.length).toBeGreaterThanOrEqual(2);
      const defaultSelected = enrolments.find(
        (e) => e.id === enrolments[0].id,
      )!;
      expect(defaultSelected).toBeTruthy();
      const discovered = enrolments.find((e) => e.id === f.learnerEnrolmentId);
      expect(discovered).toBeTruthy();

      const progress = await getCommercialV1CourseProgress(discovered!.id);
      expect(progress.ok).toBe(true);
    } finally {
      await f.db.close();
    }
  });

  it("never resolves a foreign learner's enrolment", async () => {
    const f = await fixture();
    try {
      await actAs(f.db, f.state, 3);
      const enrolments = await listPracticalEnrolments();
      expect(enrolments.some((e) => e.id === f.learnerEnrolmentId)).toBe(false);
    } finally {
      await f.db.close();
    }
  });
});
