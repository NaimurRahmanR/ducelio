import { describe, it, expect } from "vitest";
import {
  regradeInputSchema,
  regradeSnapshotSchema,
} from "@/domain/commercial-v1-examiner-regrade";
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
} from "./commercial-v1-examiner-regrade-test-data";
describe("strict regrade contracts and reused B1 parser", () => {
  it("accepts identifiers and trimmed bounded institutional reason", () =>
    expect(
      regradeInputSchema.parse({ ...input, reason: "  review  " }).reason,
    ).toBe("review"));
  it.each([
    "actorId",
    "attemptId",
    "submissionId",
    "revisionNumber",
    "marks",
    "score",
    "runtimeProfileRef",
    "usage",
  ])("rejects caller %s", (field) =>
    expect(regradeInputSchema.safeParse({ ...input, [field]: 1 }).success).toBe(
      false,
    ),
  );
  it.each(["", " ", "a".repeat(301)])(
    "rejects invalid reason length %s",
    (reason) =>
      expect(regradeInputSchema.safeParse({ ...input, reason }).success).toBe(
        false,
      ),
  );
  it.each([
    "previousMarks",
    "scoreBp",
    "objectiveOutcomes",
    "gradeDigest",
    "passed",
    "requestReason",
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
      regradeSnapshotSchema.safeParse({ ...snapshot(), secret: "key" }).success,
    ).toBe(false);
    expect(
      regradeSnapshotSchema.safeParse(snapshot({ state: "SUCCEEDED" })).success,
    ).toBe(false);
    expect(
      regradeSnapshotSchema.safeParse(
        snapshot({ targetKind: "LAB_SUBMISSION" }),
      ).success,
    ).toBe(false);
  });
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
