import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  seedResult,
  asPolicyUser,
  owner,
  value,
  learner,
} from "./commercial-v1-examiner-regrade-fixture";
import {
  buildAssessmentPolicyFixture,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
import {
  capabilityDbClient,
  type CapabilityDbState,
} from "./capability-db-client";
import type { PGlite } from "@electric-sql/pglite";

// ============================================================================
// Checkpoint C -- the end-to-end deterministic backend course lifecycle:
// activation -> governed policy publication -> graded work -> progress ->
// diagnostics -> deterministic completion, exercised through the REAL
// server-level functions (never raw SQL for the flow under test) against a
// real PGlite database. How a component's result was PRODUCED is not this
// test's job -- Checkpoints A/B already prove the Examiner atomic-finalizer
// and the submission->grading composition exhaustively -- so results are
// seeded here the same test-owner way commercial-v1-examiner-regrade-
// fixture.ts's own seedResult already does (no live provider exists in this
// test environment to produce one through the full Examiner path). This
// test's job is proving progress/diagnostics/completion compose correctly
// over real, validly-produced results.
// ============================================================================

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));

import {
  setCommercialV1LabPolicy,
  publishCommercialV1ResultPolicy,
  getCommercialV1CourseProgress,
  listCommercialV1ObjectiveDiagnostics,
  attemptCommercialV1CourseCompletion,
} from "@/server/commercial-v1-results-completion";

const RPCS: Record<string, string[]> = {
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
  get_commercial_v1_course_progress: ["p_enrolment_id"],
  list_commercial_v1_objective_diagnostics: [
    "p_enrolment_id",
    "p_limit",
    "p_offset",
  ],
  attempt_commercial_v1_course_completion: ["p_enrolment_id", "p_reason"],
};
function client(db: PGlite, state: CapabilityDbState) {
  const base = capabilityDbClient(db, state);
  return {
    ...base,
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (!(name in RPCS)) return base.rpc(name, args);
      const params = RPCS[name].map((k) => args[k]);
      const { rows } = await db.query<{ v: unknown }>(
        `select public.${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) as v`,
        params,
      );
      return { data: rows[0]?.v ?? null, error: null };
    },
  };
}
async function actAs(db: PGlite, state: CapabilityDbState, n: number) {
  await asPolicyUser(db, n);
  // asPolicyUser sets the PGlite role/JWT claim from a distinct auth-user id
  // per n (commercial-v1-assessment-policy-fixture.ts); capabilityDbClient's
  // base resolves the acting app_user from that same auth identity via a
  // real app_users lookup, so state.authUser only needs a matching auth id.
  state.authUser = {
    id: `84000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}

async function fullyGradedFixture(opts: {
  passMarkBp: number;
  allCorrect: boolean;
  requireRemediationClear?: boolean;
}) {
  const f = await buildAssessmentPolicyFixture({ withLabs: true });
  await owner(f.db);
  const practical = await value<string>(
    f.db,
    "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
    [f.importId],
  );
  // capabilityDbClient's rpc() wraps every call in a savepoint, which
  // requires an outer transaction; each fixture instance is single-use and
  // simply closed at the end, so nothing here is ever rolled back or
  // committed explicitly.
  await f.db.exec("begin");

  // The result policy (guard_assessment_result_insert/guard_lab_result_insert,
  // migration 030) must be published BEFORE any result row can ever be
  // inserted -- so policy publication comes first, well before any
  // attempt/submission/result exists, exactly like a real institution
  // configuring a course before any learner work happens.
  const state: CapabilityDbState = { authUser: null, calls: [] };
  mocks.client.mockImplementation(async () => client(f.db, state));
  await actAs(f.db, state, 2);
  await setCommercialV1LabPolicy({
    activationId: f.activationId,
    practicalId: practical,
    maxMarks: 10,
    contributionBp: 2000,
    gradingGuidance: "Grade for correct configuration.",
    reason: "Lifecycle test lab policy",
  });
  await publishCommercialV1ResultPolicy({
    activationId: f.activationId,
    passMarkBp: opts.passMarkBp,
    requireRemediationClearForCompletion: opts.requireRemediationClear ?? false,
    reason: "Lifecycle test result policy",
  });

  for (const component of [
    "QUIZ_1",
    "QUIZ_2",
    "MIDTERM",
    "QUIZ_3",
    "QUIZ_4",
    "FINAL",
  ] as const) {
    await seedResult(f, component, opts.allCorrect ? 10 : 0, true);
  }
  await asPolicyUser(f.db, 1);
  const submissionId = await value<string>(
    f.db,
    "select submit_commercial_v1_lab_work($1,$2,'Final lab work',$3) as v",
    [f.learnerEnrolmentId, practical, randomUUID()],
  );
  await owner(f.db);
  const labResultId = await value<string>(
    f.db,
    `insert into commercial_v1_lab_result_revisions(activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp)
     values($1,$2,$3,$4,$5,1,$6,10,2000) returning id as v`,
    [
      f.activationId,
      f.learnerEnrolmentId,
      learner,
      practical,
      submissionId,
      opts.allCorrect ? 10 : 0,
    ],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
    [labResultId],
  );

  return { f, practical, state };
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  mocks.client.mockReset();
});

async function enrolmentStatus(f: AssessmentPolicyFixture) {
  await owner(f.db);
  return (
    await f.db.query<{ status: string }>(
      "select status from enrolments where id=$1",
      [f.learnerEnrolmentId],
    )
  ).rows[0].status;
}

describe("Commercial V1 course lifecycle: activation through completion", () => {
  it("a real learner progresses from graded work to a deterministic completion receipt", async () => {
    const { f, state } = await fullyGradedFixture({
      passMarkBp: 4000,
      allCorrect: true,
    });
    try {
      await actAs(f.db, state, 1);

      const progress = await getCommercialV1CourseProgress(
        f.learnerEnrolmentId,
      );
      expect(progress).toMatchObject({
        ok: true,
        gradingPolicyPublished: true,
        resultPolicyPublished: true,
        passMarkBp: 4000,
        pending: [],
        courseScoreBp: 10000,
        completed: false,
      });
      if (!progress.ok) throw new Error("expected ok progress");
      expect(
        Object.values(progress.components).every(
          (c) => c.status === "FINALIZED",
        ),
      ).toBe(true);
      expect(
        Object.values(progress.labs).every((l) => l.status === "FINALIZED"),
      ).toBe(true);

      const diagnostics = await listCommercialV1ObjectiveDiagnostics({
        enrolmentId: f.learnerEnrolmentId,
        limit: 50,
        offset: 0,
      });
      expect(diagnostics).toMatchObject({ ok: true });
      if (diagnostics.ok) {
        expect(diagnostics.items.length).toBeGreaterThan(0);
        expect(diagnostics.items.every((i) => i.outcome === "CORRECT")).toBe(
          true,
        );
        expect(JSON.stringify(diagnostics)).not.toMatch(
          /protected answer|expected_answer|marking_guidance/i,
        );
      }

      const first = await attemptCommercialV1CourseCompletion({
        enrolmentId: f.learnerEnrolmentId,
        reason: "Lifecycle test completion",
      });
      expect(first).toMatchObject({
        ok: true,
        code: "COMPLETED",
        courseScoreBp: 10000,
      });

      // Replay is idempotent: the same receipt, never a second one.
      const replay = await attemptCommercialV1CourseCompletion({
        enrolmentId: f.learnerEnrolmentId,
        reason: "Lifecycle test completion replay",
      });
      expect(replay).toMatchObject({
        ok: true,
        code: "ALREADY_COMPLETED",
        receiptId: first.ok ? first.receiptId : undefined,
      });

      await owner(f.db);
      const receiptCount = Number(
        (
          await f.db.query<{ v: string }>(
            "select count(*)::text as v from commercial_v1_completion_receipts where enrolment_id=$1",
            [f.learnerEnrolmentId],
          )
        ).rows[0].v,
      );
      expect(receiptCount).toBe(1);
      expect(await enrolmentStatus(f)).toBe("COMPLETED");
    } finally {
      await f.db.close();
    }
  });

  it("completion is refused with COMPONENTS_INCOMPLETE while any component/lab lacks a current result", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    try {
      await owner(f.db);
      const practical = await value<string>(
        f.db,
        "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
        [f.importId],
      );
      await f.db.exec("begin");
      const state: CapabilityDbState = { authUser: null, calls: [] };
      mocks.client.mockImplementation(async () => client(f.db, state));
      await actAs(f.db, state, 2);
      await setCommercialV1LabPolicy({
        activationId: f.activationId,
        practicalId: practical,
        maxMarks: 10,
        contributionBp: 2000,
        gradingGuidance: "Guidance",
        reason: "Incomplete lifecycle test lab policy",
      });
      await publishCommercialV1ResultPolicy({
        activationId: f.activationId,
        passMarkBp: 1,
        requireRemediationClearForCompletion: false,
        reason: "Incomplete lifecycle test result policy",
      });

      // Only five of six components graded; the lab is never submitted.
      for (const component of [
        "QUIZ_1",
        "QUIZ_2",
        "MIDTERM",
        "QUIZ_3",
        "QUIZ_4",
      ] as const) {
        await seedResult(f, component, 10, true);
      }
      await actAs(f.db, state, 1);

      const progress = await getCommercialV1CourseProgress(
        f.learnerEnrolmentId,
      );
      expect(progress).toMatchObject({ ok: true, completed: false });
      if (progress.ok) expect(progress.pending.length).toBeGreaterThan(0);

      const result = await attemptCommercialV1CourseCompletion({
        enrolmentId: f.learnerEnrolmentId,
        reason: "Incomplete lifecycle test completion",
      });
      expect(result).toMatchObject({
        ok: false,
        code: "COMPONENTS_INCOMPLETE",
      });
      expect(await enrolmentStatus(f)).toBe("ACTIVE");
    } finally {
      await f.db.close();
    }
  });

  it("completion is refused with BELOW_PASS_MARK when the deterministic score is under the published threshold", async () => {
    const { f, state } = await fullyGradedFixture({
      passMarkBp: 9000,
      allCorrect: false,
    });
    try {
      await actAs(f.db, state, 1);
      const result = await attemptCommercialV1CourseCompletion({
        enrolmentId: f.learnerEnrolmentId,
        reason: "Below pass mark lifecycle test",
      });
      expect(result).toMatchObject({
        ok: false,
        code: "BELOW_PASS_MARK",
        courseScoreBp: 0,
        passMarkBp: 9000,
      });
      expect(await enrolmentStatus(f)).toBe("ACTIVE");
    } finally {
      await f.db.close();
    }
  });

  it("a foreign learner cannot read progress or attempt completion for another learner's enrolment, without leaking existence", async () => {
    const { f, state } = await fullyGradedFixture({
      passMarkBp: 4000,
      allCorrect: true,
    });
    try {
      await actAs(f.db, state, 3);

      const progress = await getCommercialV1CourseProgress(
        f.learnerEnrolmentId,
      );
      expect(progress).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });

      const completion = await attemptCommercialV1CourseCompletion({
        enrolmentId: f.learnerEnrolmentId,
        reason: "Foreign learner lifecycle test",
      });
      expect(completion).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
      expect(await enrolmentStatus(f)).toBe("ACTIVE");
    } finally {
      await f.db.close();
    }
  });

  it("an admin can read another learner's progress (staff read access), never mutate it", async () => {
    const { f, state } = await fullyGradedFixture({
      passMarkBp: 4000,
      allCorrect: true,
    });
    try {
      await actAs(f.db, state, 2);
      const progress = await getCommercialV1CourseProgress(
        f.learnerEnrolmentId,
      );
      expect(progress).toMatchObject({ ok: true, completed: false });
    } finally {
      await f.db.close();
    }
  });
});
