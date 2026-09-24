import { describe, it, expect } from "vitest";
import {
  recoveryInputSchema,
  recoverySnapshotSchema,
} from "@/domain/commercial-v1-examiner-recovery";
import {
  examinerAssessmentContextSchema,
  examinerLabContextSchema,
  parseExaminerAssessmentProviderOutput,
  mapExaminerAssessmentRuntimeResultToFinalizeCommand,
  computeExaminerAssessmentGradeDigest,
} from "@/domain/commercial-v1-examiner-grading";
import {
  input,
  snapshot,
  assessmentContext,
  labContext,
  observedUsage,
} from "./commercial-v1-examiner-recovery-test-data";

describe("strict initial-grade recovery contracts and reused B1 parser", () => {
  it("accepts an identifier plus a trimmed bounded recovery reason", () =>
    expect(
      recoveryInputSchema.parse({ ...input, reason: "  review  " }).reason,
    ).toBe("review"));

  it.each([
    "actorId",
    "attemptId",
    "submissionId",
    "marks",
    "score",
    "weight",
    "passFail",
    "previousMarks",
    "provider",
    "model",
    "runtimeProfileRef",
    "usage",
    "studentId",
  ])("rejects caller-supplied %s -- identifier + reason only", (field) =>
    expect(
      recoveryInputSchema.safeParse({ ...input, [field]: 1 }).success,
    ).toBe(false),
  );

  it.each(["", " ", "a".repeat(301)])(
    "rejects invalid recovery reason length %s",
    (reason) =>
      expect(recoveryInputSchema.safeParse({ ...input, reason }).success).toBe(
        false,
      ),
  );

  it("rejects a non-uuid sourceExecutionId", () =>
    expect(
      recoveryInputSchema.safeParse({ ...input, sourceExecutionId: "nope" })
        .success,
    ).toBe(false));

  // Recovery reuses initial grading's exact protected-context contract
  // unchanged -- no recovery-specific field (the recovery reason, the
  // original failure reason, a previous grade) is ever tolerated in it.
  it.each([
    "recoveryReason",
    "previousMarks",
    "originalFailureReason",
    "scoreBp",
    "objectiveOutcomes",
    "gradeDigest",
    "passed",
  ])("context excludes anchoring field %s", (field) => {
    expect(
      examinerAssessmentContextSchema.safeParse({
        ...assessmentContext,
        [field]: "secret",
      }).success,
    ).toBe(false);
    expect(
      examinerLabContextSchema.safeParse({ ...labContext, [field]: "secret" })
        .success,
    ).toBe(false);
  });

  it.each([
    '```json\n{"outcome":"GRADED","marks":[]}\n```',
    '{"outcome":"GRADED","marks":[],"feedback":"secret"}',
    "not json",
  ])("reused strict output refuses %s", (body) =>
    expect(parseExaminerAssessmentProviderOutput(body).ok).toBe(false),
  );

  it("unknown snapshot fields and inconsistent result identity fail closed", () => {
    expect(
      recoverySnapshotSchema.safeParse({ ...snapshot(), secret: "key" })
        .success,
    ).toBe(false);
    expect(
      recoverySnapshotSchema.safeParse(snapshot({ state: "SUCCEEDED" }))
        .success,
    ).toBe(false);
    expect(
      recoverySnapshotSchema.safeParse(
        snapshot({ targetKind: "LAB_SUBMISSION" }),
      ).success,
    ).toBe(false);
  });

  it("a recovery snapshot for a lab target requires lab-shaped identity", () =>
    expect(
      recoverySnapshotSchema.safeParse(
        snapshot({
          targetKind: "LAB_SUBMISSION",
          capability: "grade_practical_lab",
          submissionId: "22222222-0000-4000-8000-000000000010",
          practicalId: "22222222-0000-4000-8000-000000000011",
        }),
      ).success,
    ).toBe(false));

  it("invalid known usage is never converted to zero", () => {
    const result = {
      outcome: "SUCCEEDED" as const,
      usage: { ...observedUsage, providerCalls: 2 },
      response: {
        outputText: '{"outcome":"ESCALATE"}',
        usage: {
          inputTokens: 50,
          outputTokens: 20,
          estimatedCostMicrousd: 100,
        },
      },
    };
    expect(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        result,
        assessmentContext,
      ),
    ).toBeNull();
  });

  it("empty answered set retains deterministic digest", () =>
    expect(computeExaminerAssessmentGradeDigest([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ));
});
