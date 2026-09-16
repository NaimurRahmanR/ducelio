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
} from "./commercial-v1-examiner-regrade-test-data";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/identity", () => ({ getAuthenticatedActor: mocks.actor }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
import {
  attestRegradeCommand,
  attestRegradeContext,
} from "@/server/commercial-v1-examiner-regrade/authority";
import { getRegradeContext } from "@/server/commercial-v1-examiner-regrade/context";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", uuid(12));
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", "ab".repeat(32));
  mocks.actor.mockResolvedValue({ id: uuid(2), roles: ["ACADEMIC_ADMIN"] });
});
afterEach(() => vi.unstubAllEnvs());
const base = {
  sourceResultRevisionId: input.resultRevisionId,
  requestReason: input.reason,
  capability: "regrade_controlled_assessment" as const,
};
describe("real regrade signer", () => {
  it.each(["AUTHORIZE", "FINALIZE", "CONTEXT_READ"] as const)(
    "%s has independently reproduced 32-field SQL canonical MAC",
    async (operation) => {
      const s = snapshot();
      const finalize = operation === "FINALIZE";
      mocks.rpc.mockResolvedValue({
        data: {
          ok: true,
          transitioned: true,
          execution: finalize
            ? { ...s, state: "FAILED", reasonCode: "OUTPUT_INVALID" }
            : s,
        },
        error: null,
      });
      if (operation === "AUTHORIZE")
        await attestRegradeCommand(s.executionId, {
          ...base,
          operation,
          budget: s.budget,
        });
      else if (operation === "CONTEXT_READ")
        await attestRegradeContext({ ...base, snapshot: s });
      else
        await attestRegradeCommand(s.executionId, {
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
      const expected = [
        "DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1",
        "COMMERCIAL_V1_EXAMINER_REGRADE_V1",
        "EXAMINER",
        "EXAMINER_COMMERCIAL_V1",
        uuid(12),
        uuid(2),
        s.executionId,
        input.resultRevisionId,
        Buffer.from(input.reason, "utf8").toString("hex"),
        base.capability,
        "ASSESSMENT_ATTEMPT",
        operation === "AUTHORIZE" ? "NONE" : s.studentId,
        operation === "AUTHORIZE" ? "NONE" : s.attemptId,
        "NONE",
        operation === "AUTHORIZE" ? "NONE" : s.enrolmentId,
        operation === "AUTHORIZE" ? "NONE" : s.activationId,
        operation,
        operation === "AUTHORIZE"
          ? "AUTHORIZED"
          : finalize
            ? "FAILED"
            : "RUNNING",
        finalize ? "OUTPUT_INVALID" : "NONE",
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
        "NONE",
        a.p_issued_at,
        a.p_expires_at,
      ].join("\n");
      expect(expected.split("\n")).toHaveLength(32);
      expect(a.p_expires_at - a.p_issued_at).toBe(10);
      expect(a.p_mac).toBe(
        createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
          .update(expected, "utf8")
          .digest("hex"),
      );
      expect(mocks.rpc.mock.calls[0][0]).toBe(
        "govern_commercial_v1_examiner_regrade",
      );
    },
  );
  it.each(
    [[], ["STUDENT"], ["INSTRUCTOR"], ["STUDENT", "REGISTRAR"]].map(
      (roles) => ({ roles }),
    ),
  )("denies roles $roles before signing", async ({ roles }) => {
    mocks.actor.mockResolvedValue({ id: uuid(2), roles });
    await expect(
      attestRegradeCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ok: true, execution: {} },
    { ok: false, code: "raw database diagnostic" },
  ])("normalizes malformed transport result %s", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(
      attestRegradeCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("refuses conflicting source in returned snapshot", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        transitioned: true,
        execution: snapshot({ sourceResultRevisionId: uuid(99) }),
      },
      error: null,
    });
    await expect(
      attestRegradeCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_CONFLICT" });
  });
  it("accepts a terminal institutional AUTHORIZE replay initiated by another authorized admin", async () => {
    const existing = snapshot({
      state: "SUCCEEDED",
      reasonCode: "GRADED",
      terminalAt: "2026-09-16T10:00:10Z",
      gradeDigest: "a".repeat(64),
      resultRevisionId: uuid(13),
    });

    mocks.actor.mockResolvedValue({
      id: uuid(99),
      roles: ["PLATFORM_ADMIN"],
    });

    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        transitioned: false,
        execution: existing,
      },
      error: null,
    });

    await expect(
      attestRegradeCommand(uuid(14), {
        ...base,
        operation: "AUTHORIZE",
        budget: existing.budget,
      }),
    ).resolves.toEqual({
      snapshot: existing,
      transitioned: false,
    });
  });
  it("does not include secret or MAC in result", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: snapshot() },
      error: null,
    });
    const result = JSON.stringify(
      await attestRegradeCommand(uuid(1), {
        ...base,
        operation: "AUTHORIZE",
        budget: snapshot().budget,
      }),
    );
    expect(result).not.toContain("ab".repeat(32));
    expect(result).not.toContain(mocks.rpc.mock.calls[0][1].p_mac);
  });
  it.each([false, true])(
    "protected context %s is validated and excludes institutional reason",
    async (lab) => {
      mocks.rpc.mockResolvedValue({
        data: { ok: true, ...(lab ? labContext : assessmentContext) },
        error: null,
      });
      expect(
        (
          await getRegradeContext(
            lab ? labSnapshot() : snapshot(),
            input.reason,
          )
        ).context,
      ).toEqual(lab ? labContext : assessmentContext);
      expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
        p_operation: "CONTEXT_READ",
        p_source_id: input.resultRevisionId,
      });
    },
  );
  it("context containing old-grade fields fails closed", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, ...assessmentContext, previousScore: 20 },
      error: null,
    });
    await expect(
      getRegradeContext(snapshot(), input.reason),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("FINALIZE cannot accept a nonterminal backend response", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, transitioned: true, execution: snapshot() },
      error: null,
    });
    await expect(
      attestRegradeCommand(uuid(1), {
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
