import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Independent-review Finding 1: proves what src/server/commercial-v1-
// examiner-recovery/operations.ts itself adds on top of the already-tested
// recoverControlledAssessmentGrade/recoverPracticalLabGrade entrypoints
// (tests/commercial-v1-examiner-recovery-runtime.test.ts, unmodified) --
// that the composed action accepts ONLY {sourceExecutionId, reason}, that
// server-owned routing dispatches to the correct existing entrypoint
// strictly from a fresh authoritative database read (never from caller
// input), and that a hostile/malformed request is refused before any
// dispatch happens at all.
// ============================================================================
const mocks = vi.hoisted(() => ({
  requireRecoveryActor: vi.fn(),
  client: vi.fn(),
  recoverControlledAssessmentGrade: vi.fn(),
  recoverPracticalLabGrade: vi.fn(),
}));
vi.mock("@/server/commercial-v1-examiner-recovery/authority", () => ({
  requireRecoveryActor: mocks.requireRecoveryActor,
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/commercial-v1-examiner-recovery/index", () => ({
  recoverControlledAssessmentGrade: mocks.recoverControlledAssessmentGrade,
  recoverPracticalLabGrade: mocks.recoverPracticalLabGrade,
}));

import {
  recoverExaminerTarget,
  listRecoverableExaminerTargets,
} from "@/server/commercial-v1-examiner-recovery/operations";

const SOURCE_ID = "10000000-0000-4000-8000-0000000000aa";

function rpcOk(data: unknown) {
  mocks.client.mockResolvedValue({
    rpc: vi.fn().mockResolvedValue({ data, error: null }),
  });
}
function rpcError() {
  mocks.client.mockResolvedValue({
    rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } }),
  });
}
const assessmentTarget = {
  sourceExecutionId: SOURCE_ID,
  targetKind: "ASSESSMENT_ATTEMPT",
  capability: "grade_controlled_assessment",
  studentId: "10000000-0000-4000-8000-000000000001",
  enrolmentId: "10000000-0000-4000-8000-000000000002",
  activationId: "10000000-0000-4000-8000-000000000003",
  component: "QUIZ_1",
  practicalId: null,
  originalState: "FAILED",
  originalReasonCode: "PROVIDER_UNAVAILABLE",
  terminalAt: "2026-01-01T00:00:00Z",
  recoveryExecutionId: null,
  recoveryState: null,
  recoveryStatus: "ELIGIBLE",
};
const labTarget = {
  ...assessmentTarget,
  targetKind: "LAB_SUBMISSION",
  capability: "grade_practical_lab",
  component: null,
  practicalId: "10000000-0000-4000-8000-000000000004",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRecoveryActor.mockResolvedValue({
    id: "10000000-0000-4000-8000-000000000009",
    roles: ["ACADEMIC_ADMIN"],
  });
  mocks.recoverControlledAssessmentGrade.mockResolvedValue({
    status: "RECOVERED",
    resultRevisionId: "10000000-0000-4000-8000-000000000099",
  });
  mocks.recoverPracticalLabGrade.mockResolvedValue({
    status: "RECOVERED",
    resultRevisionId: "10000000-0000-4000-8000-000000000098",
  });
});

describe("recoverExaminerTarget: input contract", () => {
  it("rejects a request missing sourceExecutionId/reason -- no auth check, no dispatch", async () => {
    const result = await recoverExaminerTarget({});
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.requireRecoveryActor).not.toHaveBeenCalled();
    expect(mocks.recoverControlledAssessmentGrade).not.toHaveBeenCalled();
    expect(mocks.recoverPracticalLabGrade).not.toHaveBeenCalled();
  });

  it.each([
    { sourceExecutionId: SOURCE_ID, reason: "x", targetKind: "LAB_SUBMISSION" },
    {
      sourceExecutionId: SOURCE_ID,
      reason: "x",
      capability: "grade_practical_lab",
    },
    { sourceExecutionId: SOURCE_ID, reason: "x", provider: "OPENAI" },
    { sourceExecutionId: SOURCE_ID, reason: "x", model: "gpt-x" },
    { sourceExecutionId: SOURCE_ID, reason: "x", marksAwarded: 10 },
    { sourceExecutionId: SOURCE_ID, reason: "x", studentId: "foreign" },
  ])(
    "rejects a hostile extra field %o -- structurally impossible to smuggle routing/marks/identity",
    async (input) => {
      const result = await recoverExaminerTarget(input);
      expect(result).toEqual({ status: "UNAVAILABLE" });
      expect(mocks.recoverControlledAssessmentGrade).not.toHaveBeenCalled();
      expect(mocks.recoverPracticalLabGrade).not.toHaveBeenCalled();
    },
  );

  it("denies when the caller is not an authorized admin, before any target lookup", async () => {
    mocks.requireRecoveryActor.mockRejectedValue(new Error("FORBIDDEN"));
    const result = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("returns TARGET_NOT_FOUND when the authoritative lookup finds nothing, without ever guessing a capability", async () => {
    rpcError();
    const result = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(result).toEqual({ status: "TARGET_NOT_FOUND" });
    expect(mocks.recoverControlledAssessmentGrade).not.toHaveBeenCalled();
    expect(mocks.recoverPracticalLabGrade).not.toHaveBeenCalled();
  });
});

describe("recoverExaminerTarget: server-owned routing", () => {
  it("dispatches an ASSESSMENT_ATTEMPT target to recoverControlledAssessmentGrade only, with exactly {sourceExecutionId, reason}", async () => {
    rpcOk(assessmentTarget);
    const result = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(mocks.recoverControlledAssessmentGrade).toHaveBeenCalledTimes(1);
    expect(mocks.recoverControlledAssessmentGrade).toHaveBeenCalledWith({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(mocks.recoverPracticalLabGrade).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "RECOVERED",
      resultRevisionId: "10000000-0000-4000-8000-000000000099",
    });
  });

  it("dispatches a LAB_SUBMISSION target to recoverPracticalLabGrade only -- routing is never taken from caller input", async () => {
    rpcOk(labTarget);
    const result = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(mocks.recoverPracticalLabGrade).toHaveBeenCalledTimes(1);
    expect(mocks.recoverPracticalLabGrade).toHaveBeenCalledWith({
      sourceExecutionId: SOURCE_ID,
      reason: "A bounded institutional reason",
    });
    expect(mocks.recoverControlledAssessmentGrade).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "RECOVERED",
      resultRevisionId: "10000000-0000-4000-8000-000000000098",
    });
  });

  it("a replayed recovery (already terminal) is dispatched identically -- idempotent, no second claim invented here", async () => {
    rpcOk(assessmentTarget);
    mocks.recoverControlledAssessmentGrade.mockResolvedValue({
      status: "ALREADY_RECOVERED",
      resultRevisionId: "10000000-0000-4000-8000-000000000099",
    });
    const first = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "First",
    });
    const second = await recoverExaminerTarget({
      sourceExecutionId: SOURCE_ID,
      reason: "Second (replay)",
    });
    expect(mocks.recoverControlledAssessmentGrade).toHaveBeenCalledTimes(2);
    expect(first.status).toBe("ALREADY_RECOVERED");
    expect(second.status).toBe("ALREADY_RECOVERED");
  });
});

describe("listRecoverableExaminerTargets", () => {
  it("requires an authorized admin before ever calling the RPC", async () => {
    mocks.requireRecoveryActor.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(listRecoverableExaminerTargets()).rejects.toThrow();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("parses the RPC result through the strict bounded schema", async () => {
    rpcOk({ targets: [assessmentTarget, labTarget] });
    const targets = await listRecoverableExaminerTargets();
    expect(targets).toHaveLength(2);
    expect(targets[0].sourceExecutionId).toBe(SOURCE_ID);
  });

  it("throws on a malformed/unexpected RPC shape rather than returning it uncritically", async () => {
    rpcOk({
      targets: [{ ...assessmentTarget, extraField: "should not exist" }],
    });
    await expect(listRecoverableExaminerTargets()).rejects.toThrow();
  });

  it("throws when the RPC itself errors", async () => {
    rpcError();
    await expect(listRecoverableExaminerTargets()).rejects.toThrow();
  });
});
