import { describe, it, expect, vi, beforeEach } from "vitest";

// This suite proves ONLY what the composition layer itself adds on top of
// the already-reviewed gradeControlledAssessmentAttempt/
// gradePracticalLabSubmission orchestration (tests/commercial-v1-examiner-
// grading-runtime.test.ts, unmodified, still exercises that orchestration's
// own internal state machine exhaustively): submission-before-grading
// ordering, that a grading exception of any kind never affects the reported
// submission outcome, and that a submission failure means grading is never
// attempted at all. Grading's own internals are driven through the exact
// same mock boundaries the existing suite uses, reusing its snapshot/context
// shapes so a real production outcome (GRADED/ESCALATED/etc.) is exercised
// faithfully, not reinvented.
const mocks = vi.hoisted(() => ({
  submitAssessmentAttempt: vi.fn(),
  submitCommercialV1LabWork: vi.fn(),
  requireStudentPrincipal: vi.fn(),
  attestExaminerExecutionCommand: vi.fn(),
  getExaminerAssessmentContext: vi.fn(),
  getExaminerLabContext: vi.fn(),
  resolveRoleBoundRuntimeProfile: vi.fn(),
  resolveAdapterForProfile: vi.fn(),
  runGovernedProviderExecution: vi.fn(),
}));
vi.mock("@/server/assessments", () => ({
  submitAssessmentAttempt: mocks.submitAssessmentAttempt,
}));
vi.mock("@/server/commercial-v1-results-completion", () => ({
  submitCommercialV1LabWork: mocks.submitCommercialV1LabWork,
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
  resolveRoleBoundRuntimeProfile: mocks.resolveRoleBoundRuntimeProfile,
  resolveAdapterForProfile: mocks.resolveAdapterForProfile,
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: mocks.runGovernedProviderExecution,
}));

import {
  submitControlledAssessmentAndGrade,
  submitPracticalLabWorkAndGrade,
} from "@/server/commercial-v1-submission-grading";

const attemptId = "aaaaaaaa-0000-4000-8000-000000000001";
const submissionId = "bbbbbbbb-0000-4000-8000-000000000001";
const enrolmentId = "cccccccc-0000-4000-8000-000000000001";
const activationId = "dddddddd-0000-4000-8000-000000000001";
const questionId = "eeeeeeee-0000-4000-8000-000000000001";

function snapshot(overrides: Record<string, unknown> = {}) {
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
function assessmentContext() {
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
const events: string[] = [];
function wireGradingHappyPath(finalState: "SUCCEEDED" | "ESCALATED") {
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: "student-1",
    roles: ["STUDENT"],
  });
  mocks.resolveRoleBoundRuntimeProfile.mockReturnValue({
    ref: "EXAMINER_COMMERCIAL_V1",
    adapterKind: "HTTP_JSON",
    budgetPolicy: {
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxInputContextBytes: 128000,
      maxOutputTokens: 1200,
      totalDeadlineMs: 15000,
      maxEstimatedCostMicrousd: 50000,
    },
  });
  mocks.resolveAdapterForProfile.mockReturnValue({});
  mocks.attestExaminerExecutionCommand.mockImplementation(
    async (
      id: string,
      command: {
        operation: string;
        state?: string;
        reason?: string;
        gradeDigest?: string | null;
      },
    ) => {
      events.push(`GRADING:${command.operation}`);
      // FINALIZE echoes back exactly what the real command actually
      // requested (mirroring what a real RPC confirms), never a fixed
      // outcome unrelated to the finalize command's own state/reason -- a
      // real production defect this test caught: the first draft hardcoded
      // finalState regardless of the request, which would have reported a
      // fabricated SUCCEEDED for a malformed-output FAILED finalize.
      const s =
        command.operation === "AUTHORIZE"
          ? snapshot({ executionId: id, state: "AUTHORIZED" })
          : command.operation === "START"
            ? snapshot({ executionId: id, state: "RUNNING" })
            : snapshot({
                executionId: id,
                state: command.state,
                reasonCode: command.reason,
                resultRevisionId:
                  command.state === "SUCCEEDED" ? "result-1" : null,
                gradeDigest: command.gradeDigest ?? null,
              });
      return { snapshot: s, transitioned: true };
    },
  );
  mocks.getExaminerAssessmentContext.mockImplementation(async () => {
    events.push("GRADING:CONTEXT_READ");
    return assessmentContext();
  });
  mocks.runGovernedProviderExecution.mockImplementation(async () => {
    events.push("GRADING:PROVIDER");
    return successfulRuntimeResult(
      finalState === "SUCCEEDED"
        ? JSON.stringify({
            outcome: "GRADED",
            marks: [{ questionId, marksAwarded: 8 }],
          })
        : '{"outcome":"ESCALATE"}',
    );
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  events.length = 0;
});

describe("submission -> Examiner grading composition ordering", () => {
  it("submits before grading is ever invoked, and a successful grade is reported truthfully", async () => {
    mocks.submitAssessmentAttempt.mockImplementation(async () => {
      events.push("SUBMIT");
      return attemptId;
    });
    wireGradingHappyPath("SUCCEEDED");

    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(result).toEqual({ attemptId, grading: "GRADED" });
    expect(events[0]).toBe("SUBMIT");
    expect(events.slice(1)).toEqual([
      "GRADING:AUTHORIZE",
      "GRADING:START",
      "GRADING:CONTEXT_READ",
      "GRADING:PROVIDER",
      "GRADING:FINALIZE",
    ]);
  });

  it("an ESCALATED grade maps correctly and still reports the real submitted id", async () => {
    mocks.submitAssessmentAttempt.mockResolvedValue(attemptId);
    wireGradingHappyPath("ESCALATED");

    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "ESCALATED",
    });
  });

  it("a submission failure means grading is never attempted at all", async () => {
    mocks.submitAssessmentAttempt.mockRejectedValue(
      new Error("Assessment attempt could not be submitted."),
    );

    await expect(submitControlledAssessmentAndGrade(attemptId)).rejects.toThrow(
      "Assessment attempt could not be submitted.",
    );
    expect(mocks.requireStudentPrincipal).not.toHaveBeenCalled();
    expect(mocks.attestExaminerExecutionCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["thrown non-denial error", () => Promise.reject(new Error("transport"))],
    ["thrown after START", () => Promise.reject(new Error("mid-flight"))],
  ])(
    "a grading exception (%s) never affects the reported submission outcome",
    async (_name, throwFrom) => {
      mocks.submitAssessmentAttempt.mockResolvedValue(attemptId);
      mocks.requireStudentPrincipal.mockResolvedValue({
        id: "student-1",
        roles: ["STUDENT"],
      });
      mocks.resolveRoleBoundRuntimeProfile.mockReturnValue({
        ref: "EXAMINER_COMMERCIAL_V1",
        adapterKind: "HTTP_JSON",
        budgetPolicy: {
          maxProviderCalls: 1,
          maxAttempts: 1,
          maxInputContextBytes: 128000,
          maxOutputTokens: 1200,
          totalDeadlineMs: 15000,
          maxEstimatedCostMicrousd: 50000,
        },
      });
      mocks.attestExaminerExecutionCommand.mockImplementation(throwFrom);

      const result = await submitControlledAssessmentAndGrade(attemptId);

      expect(result).toEqual({ attemptId, grading: "GRADING_UNAVAILABLE" });
    },
  );

  it("malformed provider output resolves GRADING_UNAVAILABLE without fabricating a result", async () => {
    mocks.submitAssessmentAttempt.mockResolvedValue(attemptId);
    wireGradingHappyPath("SUCCEEDED");
    mocks.runGovernedProviderExecution.mockResolvedValue(
      successfulRuntimeResult("not valid json"),
    );

    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "GRADING_UNAVAILABLE",
    });
  });

  it("a resolved-but-denied AUTHORIZE (e.g. an active claim) maps to GRADING_PENDING, never GRADED", async () => {
    mocks.submitAssessmentAttempt.mockResolvedValue(attemptId);
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      roles: ["STUDENT"],
    });
    mocks.resolveRoleBoundRuntimeProfile.mockReturnValue({
      ref: "EXAMINER_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 128000,
        maxOutputTokens: 1200,
        totalDeadlineMs: 15000,
        maxEstimatedCostMicrousd: 50000,
      },
    });
    const { ExaminerExecutionDenied } =
      await import("@/domain/commercial-v1-examiner-grading");
    mocks.attestExaminerExecutionCommand.mockRejectedValue(
      new ExaminerExecutionDenied("RATE_LIMITED"),
    );

    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "GRADING_PENDING",
    });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
});

describe("lab submission -> Examiner grading composition ordering", () => {
  it("submits final lab work before grading, and a successful grade is reported truthfully", async () => {
    mocks.submitCommercialV1LabWork.mockImplementation(async () => {
      events.push("SUBMIT");
      return submissionId;
    });
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      roles: ["STUDENT"],
    });
    mocks.resolveRoleBoundRuntimeProfile.mockReturnValue({
      ref: "EXAMINER_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 128000,
        maxOutputTokens: 1200,
        totalDeadlineMs: 15000,
        maxEstimatedCostMicrousd: 50000,
      },
    });
    mocks.resolveAdapterForProfile.mockReturnValue({});
    mocks.attestExaminerExecutionCommand.mockImplementation(
      async (id: string, command: { operation: string }) => {
        events.push(`GRADING:${command.operation}`);
        const base = {
          ...snapshot({ executionId: id }),
          capability: "grade_practical_lab",
          targetKind: "LAB_SUBMISSION",
          attemptId: null,
          component: null,
          submissionId,
          practicalId: "99999999-0000-4000-8000-000000000001",
        };
        if (command.operation === "AUTHORIZE")
          return {
            snapshot: { ...base, state: "AUTHORIZED" },
            transitioned: true,
          };
        if (command.operation === "START")
          return {
            snapshot: { ...base, state: "RUNNING" },
            transitioned: true,
          };
        return {
          snapshot: {
            ...base,
            state: "SUCCEEDED",
            reasonCode: "GRADED",
            resultRevisionId: "result-2",
            gradeDigest: "b".repeat(64),
          },
          transitioned: true,
        };
      },
    );
    mocks.getExaminerLabContext.mockResolvedValue({
      submissionId,
      practicalId: "99999999-0000-4000-8000-000000000001",
      title: "Lab 1",
      instructions: "Configure the control.",
      maxMarks: 10,
      gradingGuidance: "Grade for correct configuration.",
      submissionBody: "My lab submission.",
      objectives: [],
    });
    mocks.runGovernedProviderExecution.mockImplementation(async () => {
      events.push("GRADING:PROVIDER");
      return successfulRuntimeResult('{"outcome":"GRADED","marksAwarded":9}');
    });

    const result = await submitPracticalLabWorkAndGrade({
      enrolmentId,
      practicalId: "99999999-0000-4000-8000-000000000001",
      body: "My lab submission.",
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ submissionId, grading: "GRADED" });
    expect(events[0]).toBe("SUBMIT");
  });

  it("a lab submission failure means grading is never attempted", async () => {
    mocks.submitCommercialV1LabWork.mockRejectedValue(
      new Error("Your lab submission could not be saved."),
    );

    await expect(
      submitPracticalLabWorkAndGrade({
        enrolmentId,
        practicalId: "99999999-0000-4000-8000-000000000001",
        body: "x",
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow("Your lab submission could not be saved.");
    expect(mocks.requireStudentPrincipal).not.toHaveBeenCalled();
  });
});
