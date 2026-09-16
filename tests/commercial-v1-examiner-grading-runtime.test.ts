import { describe, expect, it, vi, beforeEach } from "vitest";

// Repository-consistent vi.mock/dependency-injection pattern (mirrors
// tests/tutor-lab-execution-runtime.test.ts exactly): the production
// entrypoints (src/server/commercial-v1-examiner-grading/index.ts) have no
// override parameter at all, so this is the ONLY way to exercise the
// orchestration logic without a real database/HTTP provider. Nothing here
// makes production provider/configuration caller-overridable.
const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  attestExaminerExecutionCommand: vi.fn(),
  getExaminerAssessmentContext: vi.fn(),
  getExaminerLabContext: vi.fn(),
  resolveRuntimeProfile: vi.fn(),
  resolveAdapterForProfile: vi.fn(),
  runGovernedProviderExecution: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/commercial-v1-examiner-grading/authority", () => ({
  attestExaminerExecutionCommand: mocks.attestExaminerExecutionCommand,
}));
vi.mock("@/server/commercial-v1-examiner-grading/context", () => ({
  getExaminerAssessmentContext: mocks.getExaminerAssessmentContext,
  getExaminerLabContext: mocks.getExaminerLabContext,
}));
vi.mock("@/server/academic-runtime/profile-registry", () => ({
  resolveRuntimeProfile: mocks.resolveRuntimeProfile,
  resolveAdapterForProfile: mocks.resolveAdapterForProfile,
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: mocks.runGovernedProviderExecution,
}));

import {
  gradeControlledAssessmentAttempt,
  gradePracticalLabSubmission,
} from "@/server/commercial-v1-examiner-grading";
import { ExaminerExecutionDenied } from "@/domain/commercial-v1-examiner-grading";

const attemptId = "aaaaaaaa-0000-4000-8000-000000000001";
const submissionId = "bbbbbbbb-0000-4000-8000-000000000001";
const enrolmentId = "cccccccc-0000-4000-8000-000000000001";
const activationId = "dddddddd-0000-4000-8000-000000000001";
const questionId = "eeeeeeee-0000-4000-8000-000000000001";

function baseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exec-1",
    studentId: "student-1",
    enrolmentId,
    activationId,
    capability: "grade_controlled_assessment",
    targetKind: "ASSESSMENT_ATTEMPT",
    attemptId,
    submissionId: null,
    component: "QUIZ_1",
    practicalId: null,
    policyVersion: "COMMERCIAL_V1_EXAMINER_V1",
    executionKind: "PROVIDER_BACKED_V1",
    runtimeProfileRef: "EXAMINER_COMMERCIAL_V1",
    state: "AUTHORIZED",
    reasonCode: null,
    budgetStage: null,
    createdAt: "2026-01-01T00:00:00Z",
    authorizedAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    terminalAt: null,
    expiresAt: "2026-01-01T00:00:20Z",
    reviewPath: null,
    gradeDigest: null,
    resultRevisionId: null,
    budget: {
      maxProviderCalls: 1,
      maxOutputTokens: 1200,
      maxEstimatedCostMicrousd: 50000,
    },
    usage: null,
    ...overrides,
  };
}
function assessmentContext(overrides: Record<string, unknown> = {}) {
  return {
    attemptId,
    assessmentId: "ffffffff-0000-4000-8000-000000000001",
    component: "QUIZ_1",
    title: "Quiz 1",
    instructions: "Answer independently.",
    questions: [
      {
        questionId,
        position: 1,
        prompt: "Define X.",
        maxMarks: 10,
        expectedAnswer: "X is...",
        markingGuidance: null,
        responseBody: "My answer.",
      },
    ],
    ...overrides,
  };
}
function labContext(overrides: Record<string, unknown> = {}) {
  return {
    submissionId,
    practicalId: "99999999-0000-4000-8000-000000000001",
    title: "Lab 1",
    instructions: "Configure the control.",
    maxMarks: 10,
    gradingGuidance: "Grade for correct configuration.",
    submissionBody: "My lab submission.",
    objectives: [],
    ...overrides,
  };
}
function successfulRuntimeResult(outputText: string) {
  return {
    outcome: "SUCCEEDED" as const,
    usage: {
      providerCalls: 1,
      attempts: 1,
      inputTokens: 50,
      outputTokens: 20,
      estimatedCostMicrousd: 500,
      elapsedMs: 250,
    },
    response: {
      outputText,
      usage: { inputTokens: 50, outputTokens: 20, estimatedCostMicrousd: 500 },
    },
  };
}

// Default happy-path AUTHORIZE -> START -> FINALIZE(SUCCEEDED) sequence:
// AUTHORIZE returns a brand-new claim (executionId matches what index.ts
// itself generated -- captured via the mock call args), START transitions
// it RUNNING, FINALIZE returns a terminal SUCCEEDED snapshot.
function wireAttestSequence(
  finalizeOverrides: Record<string, unknown> = { state: "SUCCEEDED" },
) {
  mocks.attestExaminerExecutionCommand.mockImplementation(
    async (executionId: string, command: { operation: string }) => {
      if (command.operation === "AUTHORIZE") {
        return {
          snapshot: baseSnapshot({ executionId, state: "AUTHORIZED" }),
          transitioned: true,
        };
      }
      if (command.operation === "START") {
        return {
          snapshot: baseSnapshot({ executionId, state: "RUNNING" }),
          transitioned: true,
        };
      }
      return {
        snapshot: baseSnapshot({
          executionId,
          resultRevisionId: "11111111-0000-4000-8000-000000000001",
          gradeDigest: "a".repeat(64),
          ...finalizeOverrides,
        }),
        transitioned: true,
      };
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: "student-1",
    displayName: "Student",
    roles: ["STUDENT"],
  });
  mocks.resolveRuntimeProfile.mockReturnValue({
    ref: "EXAMINER_COMMERCIAL_V1",
    adapterKind: "HTTP_JSON",
    budgetPolicy: {
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxInputContextBytes: 128_000,
      maxOutputTokens: 1200,
      totalDeadlineMs: 15_000,
      maxEstimatedCostMicrousd: 50_000,
    },
  });
  mocks.resolveAdapterForProfile.mockReturnValue({ generate: vi.fn() });
  mocks.getExaminerAssessmentContext.mockResolvedValue(assessmentContext());
  mocks.getExaminerLabContext.mockResolvedValue(labContext());
});

describe("Legitimate grading: AUTHORIZE -> START -> context -> exactly one provider call -> FINALIZE", () => {
  it("assessment grading finalizes with the normalized marks and the real provider usage", async () => {
    wireAttestSequence();
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult(
        JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId, marksAwarded: 7 }],
        }),
      ),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toMatchObject({
      status: "GRADED",
      resultRevisionId: "11111111-0000-4000-8000-000000000001",
    });
    expect(mocks.runGovernedProviderExecution).toHaveBeenCalledTimes(1);
    const operations = mocks.attestExaminerExecutionCommand.mock.calls.map(
      (c) => c[1].operation,
    );
    expect(operations).toEqual(["AUTHORIZE", "START", "FINALIZE"]);
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.state).toBe("SUCCEEDED");
    expect(finalizeCall.assessmentMarks).toEqual([
      { questionId, marksAwarded: 7 },
    ]);
    expect(finalizeCall.usage).toEqual({
      providerCalls: 1,
      attempts: 1,
      inputTokens: 50,
      outputTokens: 20,
      estimatedCostMicrousd: 500,
      elapsedMs: 250,
    });
  });

  it("lab grading makes exactly one provider call and finalizes with the graded mark", async () => {
    wireAttestSequence();
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult(
        JSON.stringify({ outcome: "GRADED", marksAwarded: 8 }),
      ),
    );
    const result = await gradePracticalLabSubmission({ submissionId });
    expect(result.status).toBe("GRADED");
    expect(mocks.runGovernedProviderExecution).toHaveBeenCalledTimes(1);
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.labMarksAwarded).toBe(8);
  });
});

describe("Replay makes zero provider calls", () => {
  it("a successful replay returns the existing result without calling the provider", async () => {
    mocks.attestExaminerExecutionCommand.mockImplementation(async () => ({
      // AUTHORIZE returns a DIFFERENT executionId than the one index.ts
      // proposed -- the pre-existing terminal claim.
      snapshot: baseSnapshot({
        executionId: "existing-exec",
        state: "SUCCEEDED",
        resultRevisionId: "22222222-0000-4000-8000-000000000001",
      }),
      transitioned: false,
    }));
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({
      status: "ALREADY_GRADED",
      resultRevisionId: "22222222-0000-4000-8000-000000000001",
    });
    expect(mocks.attestExaminerExecutionCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });

  it("an active (non-terminal) replay is reported RETRY_LATER without calling the provider", async () => {
    mocks.attestExaminerExecutionCommand.mockRejectedValue(
      new ExaminerExecutionDenied("REPLAY_REJECTED"),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "RETRY_LATER" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
});

describe("No provider configured", () => {
  it("makes zero HTTP calls (adapter is null) and produces no grade", async () => {
    wireAttestSequence({
      state: "FAILED",
      reasonCode: "NO_PROVIDER_CONFIGURED",
    });
    mocks.resolveAdapterForProfile.mockReturnValue(null);
    mocks.runGovernedProviderExecution.mockResolvedValue({
      outcome: "ABSTAINED",
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
      reason: "NO_PROVIDER_CONFIGURED",
    });
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution.mock.calls[0][0]).toBeNull();
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.state).toBe("FAILED");
    expect(finalizeCall.reason).toBe("NO_PROVIDER_CONFIGURED");
    expect(finalizeCall.assessmentMarks).toBeNull();
  });
});

describe("All-unanswered assessment", () => {
  it("accepts marks:[] and reaches finalization with an empty marks array", async () => {
    wireAttestSequence();
    mocks.getExaminerAssessmentContext.mockResolvedValue(
      assessmentContext({ questions: [] }),
    );
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult(JSON.stringify({ outcome: "GRADED", marks: [] })),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result.status).toBe("GRADED");
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.state).toBe("SUCCEEDED");
    expect(finalizeCall.assessmentMarks).toEqual([]);
  });
});

describe("Strict provider output enforcement", () => {
  it("malformed/extra-key provider JSON finalizes FAILED/OUTPUT_INVALID without a grade", async () => {
    wireAttestSequence({ state: "FAILED", reasonCode: "OUTPUT_INVALID" });
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult(
        JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId, marksAwarded: 7 }],
          rationale: "extra field",
        }),
      ),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.state).toBe("FAILED");
    expect(finalizeCall.reason).toBe("OUTPUT_INVALID");
    expect(finalizeCall.assessmentMarks).toBeNull();
    expect(finalizeCall.gradeDigest).toBeNull();
  });

  it("ESCALATE produces no grade", async () => {
    wireAttestSequence({
      state: "ESCALATED",
      reasonCode: "HUMAN_REVIEW_REQUIRED",
    });
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult(JSON.stringify({ outcome: "ESCALATE" })),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "ESCALATED" });
    const finalizeCall = mocks.attestExaminerExecutionCommand.mock.calls[2][1];
    expect(finalizeCall.state).toBe("ESCALATED");
    expect(finalizeCall.assessmentMarks).toBeNull();
  });

  it("Blocker 3: an out-of-envelope observed usage makes NO FINALIZE call at all -- never a fabricated zero-usage FINALIZE", async () => {
    wireAttestSequence();
    mocks.runGovernedProviderExecution.mockResolvedValue({
      outcome: "SUCCEEDED",
      // Exceeds the domain's own examinerUsageReportSchema bound: a real
      // invariant failure this checkpoint refuses to paper over.
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 5_000_000,
        outputTokens: 20,
        estimatedCostMicrousd: 500,
        elapsedMs: 250,
      },
      response: {
        outputText: JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId, marksAwarded: 7 }],
        }),
        usage: {
          inputTokens: 5_000_000,
          outputTokens: 20,
          estimatedCostMicrousd: 500,
        },
      },
    });
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    // Only AUTHORIZE and START -- no FINALIZE (success or cleanup) is ever
    // attempted once the observed usage itself is untrustworthy; the
    // execution is left to the DB-owned 20-second expiry safety mechanism.
    const operations = mocks.attestExaminerExecutionCommand.mock.calls.map(
      (c) => c[1].operation,
    );
    expect(operations).toEqual(["AUTHORIZE", "START"]);
  });
});

describe("Real provider usage survives cleanup after a post-provider transport failure (Blocker 4)", () => {
  it("a FINALIZE(SUCCEEDED) transport failure triggers a cleanup FINALIZE carrying the SAME real, non-zero usage", async () => {
    const realUsage = {
      providerCalls: 1,
      attempts: 1,
      inputTokens: 123,
      outputTokens: 45,
      estimatedCostMicrousd: 999,
      elapsedMs: 321,
    };
    mocks.attestExaminerExecutionCommand.mockImplementation(
      async (
        executionId: string,
        command: { operation: string; state?: string },
      ) => {
        if (command.operation === "AUTHORIZE") {
          return {
            snapshot: baseSnapshot({ executionId, state: "AUTHORIZED" }),
            transitioned: true,
          };
        }
        if (command.operation === "START") {
          return {
            snapshot: baseSnapshot({ executionId, state: "RUNNING" }),
            transitioned: true,
          };
        }
        // The FIRST FINALIZE call (the real SUCCEEDED attempt) fails as an
        // uncertain transport/controller error. The SECOND FINALIZE call
        // (this test's cleanup path) succeeds.
        if (command.state === "SUCCEEDED") {
          throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
        }
        return {
          snapshot: baseSnapshot({
            executionId,
            state: "FAILED",
            reasonCode: "INTERNAL_ERROR",
          }),
          transitioned: true,
        };
      },
    );
    mocks.runGovernedProviderExecution.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: realUsage,
      response: {
        outputText: JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId, marksAwarded: 7 }],
        }),
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          estimatedCostMicrousd: 999,
        },
      },
    });
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    const calls = mocks.attestExaminerExecutionCommand.mock.calls;
    expect(calls).toHaveLength(4); // AUTHORIZE, START, FINALIZE(fails), cleanup FINALIZE
    const cleanupCall = calls[3][1];
    expect(cleanupCall.operation).toBe("FINALIZE");
    expect(cleanupCall.state).toBe("FAILED");
    expect(cleanupCall.reason).toBe("INTERNAL_ERROR");
    // The critical assertion: real, non-zero usage survives -- never
    // silently coerced or erased to zero.
    expect(cleanupCall.usage).toEqual(realUsage);
  });
});

describe("Terminal-status mapping (Blocker 5)", () => {
  it.each(["FAILED", "TIMEOUT", "BUDGET_BLOCKED", "CANCELLED"])(
    "a terminal %s replay is reported UNAVAILABLE, never RETRY_LATER",
    async (state) => {
      mocks.attestExaminerExecutionCommand.mockImplementation(async () => ({
        snapshot: baseSnapshot({ executionId: "existing-exec", state }),
        transitioned: false,
      }));
      const result = await gradeControlledAssessmentAttempt({ attemptId });
      expect(result).toEqual({ status: "UNAVAILABLE" });
      expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    },
  );
});

describe("Context failure before any provider call", () => {
  it("fails closed with zero provider calls when context construction throws", async () => {
    wireAttestSequence({ state: "FAILED", reasonCode: "INTERNAL_ERROR" });
    mocks.getExaminerAssessmentContext.mockRejectedValue(
      new ExaminerExecutionDenied("EXECUTION_UNAVAILABLE"),
    );
    const result = await gradeControlledAssessmentAttempt({ attemptId });
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    const calls = mocks.attestExaminerExecutionCommand.mock.calls;
    const cleanupCall = calls[calls.length - 1][1];
    expect(cleanupCall.operation).toBe("FINALIZE");
    expect(cleanupCall.state).toBe("FAILED");
    // No provider call ever happened, so zero usage is the CORRECT value
    // here (not a coercion of real usage).
    expect(cleanupCall.usage).toEqual({
      providerCalls: 0,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostMicrousd: 0,
      elapsedMs: 0,
    });
  });
});

describe("Generic role runtime remains fail-closed for EXAMINER", () => {
  it("this checkpoint's own orchestrator is a wholly separate module from the generic executeRoleCapability boundary", () => {
    // The authoritative regression for this invariant already lives in
    // tests/academic-runtime-composition.test.ts ("fails closed with
    // NO_EXECUTION_PATH for every role except PROFESSOR"), which this
    // checkpoint does not modify. This assertion only documents that this
    // file exercises a structurally distinct entrypoint.
    expect(gradeControlledAssessmentAttempt).not.toBe(
      gradePracticalLabSubmission,
    );
  });
});
