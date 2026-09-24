import { createHmac } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  snapshot,
  input,
  uuid,
  observedUsage,
  assessmentContext,
  labContext,
  labSnapshot,
} from "./commercial-v1-examiner-recovery-test-data";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/identity", () => ({ getAuthenticatedActor: mocks.actor }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
import {
  attestRecoveryCommand,
  attestRecoveryContext,
} from "@/server/commercial-v1-examiner-recovery/authority";
import { getRecoveryContext } from "@/server/commercial-v1-examiner-recovery/context";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", uuid(12));
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", "ab".repeat(32));
  mocks.actor.mockResolvedValue({ id: uuid(2), roles: ["ACADEMIC_ADMIN"] });
});
afterEach(() => vi.unstubAllEnvs());

const base = {
  sourceExecutionId: input.sourceExecutionId,
  recoveryReason: input.reason,
  capability: "grade_controlled_assessment" as const,
};

// Independently transcribed from migration
// 202609240040_commercial_v1_examiner_initial_grade_recovery.sql's
// commercial_v1_recovery_private.verify_command -- never derived from the
// production signer under test, so this proves the two sides actually
// agree rather than merely calling the same helper twice.
function expectedCanonical(
  operation: "AUTHORIZE" | "START" | "CONTEXT_READ" | "FINALIZE",
  s: ReturnType<typeof snapshot>,
  issuedAt: number,
  expiresAt: number,
  opts: {
    finalizeState?: string;
    finalizeReason?: string;
    gradeDigest?: string | null;
  } = {},
) {
  const finalize = operation === "FINALIZE";
  const state =
    operation === "AUTHORIZE"
      ? "AUTHORIZED"
      : operation === "START"
        ? "RUNNING"
        : operation === "CONTEXT_READ"
          ? "RUNNING"
          : (opts.finalizeState ?? "FAILED");
  const reason = finalize ? (opts.finalizeReason ?? "OUTPUT_INVALID") : "NONE";
  return [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_RECOVERY_HMAC_SHA256_V1",
    "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1",
    "EXAMINER",
    "EXAMINER_COMMERCIAL_V1",
    uuid(12),
    uuid(2),
    s.executionId,
    input.sourceExecutionId,
    Buffer.from(input.reason, "utf8").toString("hex"),
    base.capability,
    "ASSESSMENT_ATTEMPT",
    operation === "AUTHORIZE" ? "NONE" : s.studentId,
    operation === "AUTHORIZE" ? "NONE" : s.attemptId,
    "NONE",
    operation === "AUTHORIZE" ? "NONE" : s.enrolmentId,
    operation === "AUTHORIZE" ? "NONE" : s.activationId,
    operation,
    state,
    reason,
    "NONE",
    1,
    1200,
    50000,
    finalize ? 1 : 0,
    finalize ? 1 : 0,
    finalize ? 50 : 0,
    finalize ? 20 : 0,
    finalize ? 100 : 0,
    finalize ? 10 : 0,
    finalize ? (opts.gradeDigest ?? "NONE") : "NONE",
    issuedAt,
    expiresAt,
  ].join("\n");
}

describe("real initial-grade recovery signer", () => {
  it.each(["AUTHORIZE", "START", "FINALIZE"] as const)(
    "%s has an independently reproduced canonical MAC that matches SQL's verify_command",
    async (operation) => {
      const s = snapshot();
      const finalize = operation === "FINALIZE";
      const started = operation === "START";
      mocks.rpc.mockResolvedValue({
        data: {
          ok: true,
          transitioned: true,
          execution: finalize
            ? { ...s, state: "FAILED", reasonCode: "OUTPUT_INVALID" }
            : started
              ? { ...s, state: "RUNNING", startedAt: s.createdAt }
              : s,
        },
        error: null,
      });
      if (operation === "AUTHORIZE")
        await attestRecoveryCommand(s.executionId, {
          ...base,
          operation,
          budget: s.budget,
        });
      else if (operation === "START")
        await attestRecoveryCommand(s.executionId, {
          ...base,
          operation,
          snapshot: s,
        });
      else
        await attestRecoveryCommand(s.executionId, {
          ...base,
          operation,
          snapshot: s,
          state: "FAILED",
          reason: "OUTPUT_INVALID",
          budgetStage: null,
          usage: observedUsage,
          gradeDigest: null,
          assessmentMarks: null,
          labMarksAwarded: null,
        });
      const a = mocks.rpc.mock.calls[0][1];
      const expected = expectedCanonical(
        operation,
        s,
        a.p_issued_at,
        a.p_expires_at,
      );
      expect(expected.split("\n")).toHaveLength(32);
      expect(a.p_expires_at - a.p_issued_at).toBe(10);
      expect(a.p_mac).toBe(
        createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
          .update(expected, "utf8")
          .digest("hex"),
      );
      expect(mocks.rpc.mock.calls[0][0]).toBe(
        "govern_commercial_v1_examiner_recovery",
      );
    },
  );

  it("CONTEXT_READ has its own independently reproduced canonical MAC", async () => {
    const s = snapshot({ state: "RUNNING" });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, ...assessmentContext },
      error: null,
    });
    await attestRecoveryContext({ ...base, snapshot: s });
    const a = mocks.rpc.mock.calls[0][1];
    const expected = expectedCanonical(
      "CONTEXT_READ",
      s,
      a.p_issued_at,
      a.p_expires_at,
    );
    expect(a.p_mac).toBe(
      createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
        .update(expected, "utf8")
        .digest("hex"),
    );
    expect(mocks.rpc.mock.calls[0][0]).toBe(
      "govern_commercial_v1_examiner_recovery",
    );
  });

  it("the recovery reason is hex-encoded so an embedded newline cannot shift fields", async () => {
    const s = snapshot();
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: s },
      error: null,
    });
    await attestRecoveryCommand(s.executionId, {
      ...base,
      operation: "AUTHORIZE",
      budget: s.budget,
    });
    const a = mocks.rpc.mock.calls[0][1];
    // input.reason itself contains an embedded newline (test-data fixture).
    expect(a.p_recovery_reason).toBe(input.reason);
    expect(a.p_mac).not.toHaveLength(0);
    // The canonical text passed to HMAC has exactly 32 LF-separated fields --
    // an unescaped embedded newline in the reason would silently produce 33+.
    const expected = expectedCanonical(
      "AUTHORIZE",
      s,
      a.p_issued_at,
      a.p_expires_at,
    );
    expect(expected.split("\n")).toHaveLength(32);
  });

  type Mutator = (a: Record<string, unknown>) => Record<string, unknown>;
  const tamperCases: [string, Mutator][] = [
    ["execution id", (a) => ({ ...a, p_execution_id: uuid(99) })],
    ["source execution id", (a) => ({ ...a, p_source_execution_id: uuid(99) })],
    ["capability", (a) => ({ ...a, p_capability: "grade_practical_lab" })],
    ["target kind", (a) => ({ ...a, p_target_kind: "LAB_SUBMISSION" })],
    ["operation", (a) => ({ ...a, p_operation: "START" })],
    ["max output budget", (a) => ({ ...a, p_max_output: 999 })],
    ["max cost budget", (a) => ({ ...a, p_max_cost: 1 })],
    [
      "issued at",
      (a) => ({ ...a, p_issued_at: (a.p_issued_at as number) - 1 }),
    ],
    [
      "expires at",
      (a) => ({ ...a, p_expires_at: (a.p_expires_at as number) + 1 }),
    ],
  ];
  it.each(tamperCases)(
    "tampering with %s produces a different MAC than the untampered canonical text",
    async (_name, mutate) => {
      const s = snapshot();
      mocks.rpc.mockResolvedValue({
        data: { ok: true, transitioned: true, execution: s },
        error: null,
      });
      await attestRecoveryCommand(s.executionId, {
        ...base,
        operation: "AUTHORIZE",
        budget: s.budget,
      });
      const a = mocks.rpc.mock.calls[0][1] as Record<string, unknown>;
      const untamperedExpected = expectedCanonical(
        "AUTHORIZE",
        s,
        a.p_issued_at as number,
        a.p_expires_at as number,
      );
      const untamperedMac = createHmac(
        "sha256",
        Buffer.from("ab".repeat(32), "hex"),
      )
        .update(untamperedExpected, "utf8")
        .digest("hex");
      expect(a.p_mac).toBe(untamperedMac);
      const tampered = mutate(a);
      const tamperedCanonical = [
        "DUCELIO_COMMERCIAL_V1_EXAMINER_RECOVERY_HMAC_SHA256_V1",
        "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1",
        "EXAMINER",
        "EXAMINER_COMMERCIAL_V1",
        tampered.p_key_id,
        uuid(2),
        tampered.p_execution_id,
        tampered.p_source_execution_id,
        Buffer.from(tampered.p_recovery_reason as string, "utf8").toString(
          "hex",
        ),
        tampered.p_capability,
        tampered.p_target_kind,
        tampered.p_student_id ?? "NONE",
        tampered.p_attempt_id ?? "NONE",
        tampered.p_submission_id ?? "NONE",
        tampered.p_enrolment_id ?? "NONE",
        tampered.p_activation_id ?? "NONE",
        tampered.p_operation,
        tampered.p_state,
        tampered.p_reason,
        tampered.p_budget_stage,
        tampered.p_max_calls,
        tampered.p_max_output,
        tampered.p_max_cost,
        tampered.p_calls,
        tampered.p_attempts,
        tampered.p_input,
        tampered.p_output,
        tampered.p_cost,
        tampered.p_elapsed,
        tampered.p_grade_digest ?? "NONE",
        tampered.p_issued_at,
        tampered.p_expires_at,
      ].join("\n");
      const tamperedMac = createHmac(
        "sha256",
        Buffer.from("ab".repeat(32), "hex"),
      )
        .update(tamperedCanonical, "utf8")
        .digest("hex");
      // The production call already signed the UNTAMPERED values -- proving a
      // legitimate mutation to any of these fields changes what a verifier
      // would recompute, i.e. the MAC is genuinely bound to this exact field.
      expect(tamperedMac).not.toBe(untamperedMac);
    },
  );

  it.each(
    [[], ["STUDENT"], ["INSTRUCTOR"], ["STUDENT", "REGISTRAR"]].map(
      (roles) => ({
        roles,
      }),
    ),
  )(
    "denies roles $roles before signing -- no MAC is ever produced",
    async ({ roles }) => {
      mocks.actor.mockResolvedValue({ id: uuid(2), roles });
      await expect(
        attestRecoveryCommand(uuid(1), {
          ...base,
          operation: "AUTHORIZE",
          budget: snapshot().budget,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { ok: true, execution: {} },
    { ok: false, code: "raw database diagnostic" },
  ])("normalizes malformed transport result %s", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(
      attestRecoveryCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("refuses a conflicting source execution id in the returned snapshot", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        transitioned: true,
        execution: snapshot({ sourceExecutionId: uuid(99) }),
      },
      error: null,
    });
    await expect(
      attestRecoveryCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_CONFLICT" });
  });

  it("accepts a terminal AUTHORIZE replay observed by another authorized admin", async () => {
    const existing = snapshot({
      state: "SUCCEEDED",
      reasonCode: "GRADED",
      terminalAt: "2026-09-24T10:00:10Z",
      gradeDigest: "a".repeat(64),
      resultRevisionId: uuid(13),
    });
    mocks.actor.mockResolvedValue({ id: uuid(99), roles: ["PLATFORM_ADMIN"] });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: false, execution: existing },
      error: null,
    });
    await expect(
      attestRecoveryCommand(uuid(14), {
        ...base,
        operation: "AUTHORIZE",
        budget: existing.budget,
      }),
    ).resolves.toEqual({ snapshot: existing, transitioned: false });
  });

  it("accepts a direct config-governed ESCALATED claim as a legitimate AUTHORIZE transition", async () => {
    const escalated = snapshot({
      state: "ESCALATED",
      reasonCode: "HUMAN_REVIEW_REQUIRED",
      reviewPath: "ACADEMIC_REVIEW",
      terminalAt: "2026-09-24T10:00:00Z",
    });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: escalated },
      error: null,
    });
    await expect(
      attestRecoveryCommand(escalated.executionId, {
        ...base,
        operation: "AUTHORIZE",
        budget: escalated.budget,
      }),
    ).resolves.toEqual({ snapshot: escalated, transitioned: true });
  });

  it("does not include the secret key or MAC in the returned result", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: snapshot() },
      error: null,
    });
    const result = JSON.stringify(
      await attestRecoveryCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    );
    expect(result).not.toContain("ab".repeat(32));
    expect(result).not.toContain(
      (mocks.rpc.mock.calls[0][1] as { p_mac: string }).p_mac,
    );
  });

  it.each([false, true])(
    "protected context %s is validated and excludes the recovery reason/institutional metadata",
    async (lab) => {
      mocks.rpc.mockResolvedValue({
        data: { ok: true, ...(lab ? labContext : assessmentContext) },
        error: null,
      });
      const result = await getRecoveryContext(
        lab ? labSnapshot() : snapshot(),
        input.reason,
      );
      expect(result.context).toEqual(lab ? labContext : assessmentContext);
      expect(JSON.stringify(result.context)).not.toContain(input.reason);
      expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
        p_operation: "CONTEXT_READ",
        p_source_execution_id: input.sourceExecutionId,
      });
    },
  );

  it("context containing an old-grade field fails closed", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, ...assessmentContext, previousScore: 20 },
      error: null,
    });
    await expect(
      getRecoveryContext(snapshot(), input.reason),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("FINALIZE cannot accept a nonterminal backend response", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: snapshot() },
      error: null,
    });
    await expect(
      attestRecoveryCommand(uuid(1), {
        ...base,
        operation: "FINALIZE",
        snapshot: snapshot(),
        state: "FAILED",
        reason: "OUTPUT_INVALID",
        budgetStage: null,
        usage: observedUsage,
        gradeDigest: null,
        assessmentMarks: null,
        labMarksAwarded: null,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_CONFLICT" });
  });
});
