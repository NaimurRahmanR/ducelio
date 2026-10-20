import type { RecoverySnapshot } from "@/domain/commercial-v1-examiner-recovery";
export const uuid = (n: number) =>
  `12222222-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function snapshot(
  overrides: Partial<RecoverySnapshot> = {},
): RecoverySnapshot {
  return {
    executionId: uuid(1),
    actorId: uuid(2),
    studentId: uuid(3),
    enrolmentId: uuid(4),
    activationId: uuid(5),
    sourceExecutionId: uuid(6),
    capability: "grade_controlled_assessment",
    targetKind: "ASSESSMENT_ATTEMPT",
    attemptId: uuid(7),
    submissionId: null,
    component: "QUIZ_1",
    practicalId: null,
    policyVersion: "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1",
    executionKind: "PROVIDER_BACKED_RECOVERY_V1",
    runtimeProfileRef: "EXAMINER_COMMERCIAL_V1",
    state: "AUTHORIZED",
    reasonCode: null,
    budgetStage: null,
    createdAt: "2026-09-24T10:00:00Z",
    authorizedAt: "2026-09-24T10:00:00Z",
    startedAt: null,
    terminalAt: null,
    expiresAt: "2026-09-24T10:00:20Z",
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
export const assessmentContext = {
  attemptId: uuid(7),
  assessmentId: uuid(8),
  component: "QUIZ_1" as const,
  title: "Test quiz",
  instructions: "Answer",
  questions: [
    {
      questionId: uuid(9),
      position: 1,
      prompt: "Protected prompt",
      maxMarks: 5,
      expectedAnswer: "Protected key",
      markingGuidance: null,
      responseBody: "Protected response",
    },
  ],
  objectiveMarks: [],
  objectiveQuestionCount: 0,
};
export const labContext = {
  submissionId: uuid(10),
  practicalId: uuid(11),
  title: "Test lab",
  instructions: "Configure",
  maxMarks: 10,
  gradingGuidance: "Protected guidance",
  submissionBody: "Protected work",
  objectives: [],
};
export const observedUsage = {
  providerCalls: 1,
  attempts: 1,
  inputTokens: 50,
  outputTokens: 20,
  estimatedCostMicrousd: 100,
  elapsedMs: 10,
};
export const input = {
  sourceExecutionId: uuid(6),
  reason: "Independent institutional recovery review\nwith a second line",
};
export const labSnapshot = () =>
  snapshot({
    capability: "grade_practical_lab",
    targetKind: "LAB_SUBMISSION",
    attemptId: null,
    component: null,
    submissionId: uuid(10),
    practicalId: uuid(11),
  });
