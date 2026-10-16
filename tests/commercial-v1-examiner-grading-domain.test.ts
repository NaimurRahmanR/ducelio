import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_V1_EXAMINER_POLICY,
  EXAMINER_EXECUTION_DB_CEILING,
  EXAMINER_RUNTIME_PROFILE_REF,
  computeExaminerAssessmentGradeDigest,
  computeExaminerLabGradeDigest,
  examinerAssessmentContextSchema,
  examinerLabContextSchema,
  gradeControlledAssessmentInputSchema,
  gradePracticalLabInputSchema,
  mapExaminerAssessmentRuntimeResultToFinalizeCommand,
  mapExaminerLabRuntimeResultToFinalizeCommand,
  parseExaminerAssessmentProviderOutput,
  parseExaminerLabProviderOutput,
  validateExaminerAssessmentMarks,
  validateExaminerLabMarks,
  examinerRpcResultSchema,
  type ExaminerFinalizeCommand,
} from "@/domain/commercial-v1-examiner-grading";
import { zeroUsage } from "@/domain/academic-runtime";

const q1 = "aaaaaaaa-0000-4000-8000-000000000001";
const q2 = "bbbbbbbb-0000-4000-8000-000000000001";

// Blocker 3 (independent review, V3): the mapping functions now return
// null when observed usage fails the domain invariant (never a synthetic
// zero-usage command). Every test in this file feeds a valid, in-envelope
// usage object, so a null result here is itself a test failure worth
// surfacing loudly -- this both asserts non-null AND narrows the type for
// every existing assertion below.
function assertCommand(
  command: ExaminerFinalizeCommand | null,
): ExaminerFinalizeCommand {
  expect(command).not.toBeNull();
  return command!;
}

describe("Grade digest: independently reproducible, deterministic ordering", () => {
  it("is stable regardless of input mark order", () => {
    const a = computeExaminerAssessmentGradeDigest([
      { questionId: q1, marksAwarded: 5 },
      { questionId: q2, marksAwarded: 10 },
    ]);
    const b = computeExaminerAssessmentGradeDigest([
      { questionId: q2, marksAwarded: 10 },
      { questionId: q1, marksAwarded: 5 },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes when a mark changes", () => {
    const a = computeExaminerAssessmentGradeDigest([
      { questionId: q1, marksAwarded: 5 },
    ]);
    const b = computeExaminerAssessmentGradeDigest([
      { questionId: q1, marksAwarded: 6 },
    ]);
    expect(a).not.toBe(b);
  });
  it("the empty (all-unanswered) marks list has a defined digest", () => {
    expect(computeExaminerAssessmentGradeDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
  it("lab digest is a pure function of the single integer", () => {
    expect(computeExaminerLabGradeDigest(7)).toBe(
      computeExaminerLabGradeDigest(7),
    );
    expect(computeExaminerLabGradeDigest(7)).not.toBe(
      computeExaminerLabGradeDigest(8),
    );
  });
});

describe("Strict provider output parsing (section 9)", () => {
  it("rejects markdown fences, prose and any non-JSON text", () => {
    for (const text of [
      '```json\n{"outcome":"GRADED","marks":[]}\n```',
      'Here is the grade: {"outcome":"GRADED","marks":[]}',
      "not json at all",
      "",
    ]) {
      expect(parseExaminerAssessmentProviderOutput(text).ok).toBe(false);
    }
  });
  it("rejects unknown/extra keys (no rationale/feedback/answer-key-echo field tolerated)", () => {
    const withExtra = JSON.stringify({
      outcome: "GRADED",
      marks: [{ questionId: q1, marksAwarded: 5 }],
      rationale: "I graded this because...",
    });
    expect(parseExaminerAssessmentProviderOutput(withExtra).ok).toBe(false);
  });
  it("Blocker 3: marks:[] is a VALID GRADED response (the answered-question set may legitimately be empty), with no arbitrary upper bound", () => {
    const empty = parseExaminerAssessmentProviderOutput(
      JSON.stringify({ outcome: "GRADED", marks: [] }),
    );
    expect(empty.ok).toBe(true);
    if (empty.ok)
      expect(empty.output).toEqual({ outcome: "GRADED", marks: [] });
    // A large-but-plausible marks array is not rejected by an invented
    // count limit -- the only reviewed bound is the provider adapter's own
    // outputText.max(20000) (src/server/academic-runtime/provider.ts).
    const many = Array.from({ length: 250 }, (_, i) => ({
      questionId: q1,
      marksAwarded: i % 2,
    }));
    expect(
      parseExaminerAssessmentProviderOutput(
        JSON.stringify({ outcome: "GRADED", marks: many }),
      ).ok,
    ).toBe(true);
  });

  it("accepts the exact reviewed GRADED and ESCALATE shapes only", () => {
    expect(
      parseExaminerAssessmentProviderOutput(
        JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId: q1, marksAwarded: 5 }],
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseExaminerAssessmentProviderOutput(
        JSON.stringify({ outcome: "ESCALATE" }),
      ).ok,
    ).toBe(true);
    expect(
      parseExaminerLabProviderOutput(
        JSON.stringify({ outcome: "GRADED", marksAwarded: 5 }),
      ).ok,
    ).toBe(true);
    expect(
      parseExaminerLabProviderOutput(JSON.stringify({ outcome: "ESCALATE" }))
        .ok,
    ).toBe(true);
  });
  it("rejects negative or non-integer marks", () => {
    expect(
      parseExaminerAssessmentProviderOutput(
        JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId: q1, marksAwarded: -1 }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseExaminerLabProviderOutput(
        JSON.stringify({ outcome: "GRADED", marksAwarded: 3.5 }),
      ).ok,
    ).toBe(false);
  });
});

describe("Server-side independent mark validation against authoritative context", () => {
  const context = {
    attemptId: q1,
    assessmentId: q2,
    component: "QUIZ_1",
    title: "t",
    instructions: "i",
    questions: [
      {
        questionId: q1,
        position: 1,
        prompt: "p",
        maxMarks: 10,
        expectedAnswer: "a",
        markingGuidance: null,
        responseBody: "r",
      },
    ],
    objectiveMarks: [],
    objectiveQuestionCount: 0,
  };
  it("rejects marks for a foreign question id", () => {
    expect(
      validateExaminerAssessmentMarks(context, [
        { questionId: q2, marksAwarded: 5 },
      ]),
    ).toBe(false);
  });
  it("rejects marks exceeding the real question max", () => {
    expect(
      validateExaminerAssessmentMarks(context, [
        { questionId: q1, marksAwarded: 11 },
      ]),
    ).toBe(false);
  });
  it("rejects a duplicate question id", () => {
    expect(
      validateExaminerAssessmentMarks(context, [
        { questionId: q1, marksAwarded: 5 },
        { questionId: q1, marksAwarded: 3 },
      ]),
    ).toBe(false);
  });
  it("rejects a partial (not exactly the answered-question) set", () => {
    expect(validateExaminerAssessmentMarks(context, [])).toBe(false);
  });
  it("accepts an exact, bounded match", () => {
    expect(
      validateExaminerAssessmentMarks(context, [
        { questionId: q1, marksAwarded: 10 },
      ]),
    ).toBe(true);
  });
  it("lab marks are bounded by the policy max", () => {
    const labContext = {
      submissionId: q1,
      practicalId: q2,
      title: "t",
      instructions: "i",
      maxMarks: 10,
      gradingGuidance: null,
      submissionBody: "b",
      objectives: [],
    };
    expect(validateExaminerLabMarks(labContext, 10)).toBe(true);
    expect(validateExaminerLabMarks(labContext, 11)).toBe(false);
    expect(validateExaminerLabMarks(labContext, -1)).toBe(false);
  });
});

describe("RuntimeResult -> FINALIZE command mapping", () => {
  const context = {
    attemptId: q1,
    assessmentId: q2,
    component: "QUIZ_1",
    title: "t",
    instructions: "i",
    questions: [
      {
        questionId: q1,
        position: 1,
        prompt: "p",
        maxMarks: 10,
        expectedAnswer: "a",
        markingGuidance: null,
        responseBody: "r",
      },
    ],
    objectiveMarks: [],
    objectiveQuestionCount: 0,
  };
  it("Blocker 3: an out-of-envelope known usage (already observed, never fabricated) produces NO finalize command -- never a synthetic zero-usage one", () => {
    const outOfEnvelopeUsage = {
      providerCalls: 1,
      attempts: 1,
      // Exceeds examinerUsageReportSchema's own bound (max 1_000_000): a
      // real invariant failure, not a legitimate reason to zero it out.
      inputTokens: 5_000_000,
      outputTokens: 20,
      estimatedCostMicrousd: 500,
      elapsedMs: 250,
    };
    const command = mapExaminerAssessmentRuntimeResultToFinalizeCommand(
      {
        outcome: "SUCCEEDED",
        usage: outOfEnvelopeUsage,
        response: {
          outputText: JSON.stringify({
            outcome: "GRADED",
            marks: [{ questionId: q1, marksAwarded: 7 }],
          }),
          usage: {
            inputTokens: 5_000_000,
            outputTokens: 20,
            estimatedCostMicrousd: 500,
          },
        },
      },
      context,
    );
    expect(command).toBeNull();
  });
  it("Blocker 3: a malformed known usage object (wrong shape entirely) also produces NO finalize command, never a zero-usage fallback", () => {
    const command = mapExaminerAssessmentRuntimeResultToFinalizeCommand(
      {
        outcome: "FAILED",
        // @ts-expect-error -- deliberately malformed to prove the domain
        // function itself fails closed at runtime, not merely via types.
        usage: { providerCalls: "not-a-number" },
        reason: "PROVIDER_ERROR",
      },
      context,
    );
    expect(command).toBeNull();
  });
  it("no provider configuration fails closed to FAILED/NO_PROVIDER_CONFIGURED -- never a fabricated result", () => {
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "ABSTAINED",
          usage: zeroUsage(),
          reason: "NO_PROVIDER_CONFIGURED",
        },
        context,
      ),
    );
    expect(command.state).toBe("FAILED");
    expect(command.reason).toBe("NO_PROVIDER_CONFIGURED");
    expect(command.assessmentMarks).toBeNull();
    expect(command.gradeDigest).toBeNull();
  });
  it("a malformed SUCCEEDED provider response maps to FAILED/OUTPUT_INVALID with no marks", () => {
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: "not json",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        context,
      ),
    );
    expect(command).toMatchObject({
      state: "FAILED",
      reason: "OUTPUT_INVALID",
      assessmentMarks: null,
      gradeDigest: null,
    });
  });
  it("an ESCALATE provider response maps to ESCALATED with no marks", () => {
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: JSON.stringify({ outcome: "ESCALATE" }),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        context,
      ),
    );
    expect(command).toMatchObject({
      state: "ESCALATED",
      reason: "HUMAN_REVIEW_REQUIRED",
      assessmentMarks: null,
    });
  });
  it("a valid GRADED provider response maps to SUCCEEDED with the exact marks and matching digest", () => {
    const marks = [{ questionId: q1, marksAwarded: 7 }];
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: JSON.stringify({ outcome: "GRADED", marks }),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        context,
      ),
    );
    expect(command.state).toBe("SUCCEEDED");
    expect(command.assessmentMarks).toEqual(marks);
    expect(command.gradeDigest).toBe(
      computeExaminerAssessmentGradeDigest(marks),
    );
  });
  it("Blocker 3: an all-unanswered attempt (zero authoritative questions in context) reaches the finalizer with an empty marks array, not a failure", () => {
    const allUnansweredContext = { ...context, questions: [] };
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: JSON.stringify({ outcome: "GRADED", marks: [] }),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        allUnansweredContext,
      ),
    );
    expect(command.state).toBe("SUCCEEDED");
    expect(command.assessmentMarks).toEqual([]);
    expect(command.gradeDigest).toBe(computeExaminerAssessmentGradeDigest([]));
  });
  it("marks exceeding the real max in an otherwise well-formed response are rejected as OUTPUT_INVALID (server-side re-validation, independent of the DB)", () => {
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: JSON.stringify({
              outcome: "GRADED",
              marks: [{ questionId: q1, marksAwarded: 999 }],
            }),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        context,
      ),
    );
    expect(command).toMatchObject({
      state: "FAILED",
      reason: "OUTPUT_INVALID",
    });
  });
  it("a provider timeout maps to FAILED/EXECUTION_TIMEOUT", () => {
    const command = assertCommand(
      mapExaminerAssessmentRuntimeResultToFinalizeCommand(
        { outcome: "TIMEOUT", usage: zeroUsage() },
        context,
      ),
    );
    expect(command).toMatchObject({
      state: "FAILED",
      reason: "EXECUTION_TIMEOUT",
    });
  });
  it("lab: a malformed response maps to FAILED/OUTPUT_INVALID", () => {
    const labContext = {
      submissionId: q1,
      practicalId: q2,
      title: "t",
      instructions: "i",
      maxMarks: 10,
      gradingGuidance: null,
      submissionBody: "b",
      objectives: [],
    };
    const command = assertCommand(
      mapExaminerLabRuntimeResultToFinalizeCommand(
        {
          outcome: "SUCCEEDED",
          usage: zeroUsage(),
          response: {
            outputText: "{}",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicrousd: 0,
            },
          },
        },
        labContext,
      ),
    );
    expect(command).toMatchObject({
      state: "FAILED",
      reason: "OUTPUT_INVALID",
    });
  });
});

describe("Public entrypoint input contracts -- identifiers only", () => {
  it("assessment grading accepts only attemptId; no marks/scores/weights field is tolerated", () => {
    expect(
      gradeControlledAssessmentInputSchema.safeParse({ attemptId: q1 }).success,
    ).toBe(true);
    for (const extra of [
      { marks: [] },
      { score: 10 },
      { componentWeightBp: 500 },
      { expectedAnswer: "x" },
    ]) {
      expect(
        gradeControlledAssessmentInputSchema.safeParse({
          attemptId: q1,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
  it("lab grading accepts only submissionId; no marksAwarded/contributionBp field is tolerated", () => {
    expect(
      gradePracticalLabInputSchema.safeParse({ submissionId: q1 }).success,
    ).toBe(true);
    for (const extra of [
      { marksAwarded: 7 },
      { contributionBp: 2000 },
      { gradingGuidance: "x" },
    ]) {
      expect(
        gradePracticalLabInputSchema.safeParse({ submissionId: q1, ...extra })
          .success,
      ).toBe(false);
    }
  });
});

describe("Protected context schemas never carry provider/execution metadata beyond bounded fields", () => {
  it("the assessment context schema rejects an unknown extra field", () => {
    const base = {
      attemptId: q1,
      assessmentId: q2,
      component: "QUIZ_1",
      title: "t",
      instructions: "i",
      questions: [],
      objectiveMarks: [],
      objectiveQuestionCount: 0,
    };
    expect(examinerAssessmentContextSchema.safeParse(base).success).toBe(true);
    expect(
      examinerAssessmentContextSchema.safeParse({
        ...base,
        providerPrompt: "leak",
      }).success,
    ).toBe(false);
  });
  it("the lab context schema rejects an unknown extra field", () => {
    const base = {
      submissionId: q1,
      practicalId: q2,
      title: "t",
      instructions: "i",
      maxMarks: 10,
      gradingGuidance: null,
      submissionBody: "b",
      objectives: [],
    };
    expect(examinerLabContextSchema.safeParse(base).success).toBe(true);
    expect(
      examinerLabContextSchema.safeParse({
        ...base,
        rawProviderResponse: "leak",
      }).success,
    ).toBe(false);
  });
});

describe("Execution RPC result contract", () => {
  it("round-trips a SUCCEEDED snapshot and rejects an unknown state", () => {
    const okShape = {
      ok: true,
      transitioned: true,
      execution: {
        executionId: q1,
        studentId: q2,
        enrolmentId: q1,
        activationId: q2,
        capability: "grade_controlled_assessment",
        targetKind: "ASSESSMENT_ATTEMPT",
        attemptId: q1,
        submissionId: null,
        component: "QUIZ_1",
        practicalId: null,
        policyVersion: COMMERCIAL_V1_EXAMINER_POLICY,
        executionKind: "PROVIDER_BACKED_V1",
        runtimeProfileRef: EXAMINER_RUNTIME_PROFILE_REF,
        state: "SUCCEEDED",
        reasonCode: "GRADED",
        budgetStage: null,
        createdAt: "2026-01-01T00:00:00Z",
        authorizedAt: "2026-01-01T00:00:00Z",
        startedAt: "2026-01-01T00:00:01Z",
        terminalAt: "2026-01-01T00:00:02Z",
        expiresAt: "2026-01-01T00:00:20Z",
        reviewPath: null,
        gradeDigest: "a".repeat(64),
        resultRevisionId: q1,
        budget: {
          maxProviderCalls: 1,
          maxOutputTokens: 1200,
          maxEstimatedCostMicrousd: 50000,
        },
        usage: {
          providerCalls: 1,
          attempts: 1,
          inputTokens: 10,
          outputTokens: 10,
          estimatedCostMicrousd: 100,
          elapsedMs: 500,
        },
      },
    };
    expect(examinerRpcResultSchema.safeParse(okShape).success).toBe(true);
    expect(
      examinerRpcResultSchema.safeParse({
        ...okShape,
        execution: { ...okShape.execution, state: "MADE_UP" },
      }).success,
    ).toBe(false);
  });
  it("accepts a bounded denial", () => {
    expect(
      examinerRpcResultSchema.safeParse({
        ok: false,
        code: "TARGET_NOT_ELIGIBLE",
      }).success,
    ).toBe(true);
    expect(
      examinerRpcResultSchema.safeParse({ ok: false, code: "MADE_UP" }).success,
    ).toBe(false);
  });
});

describe("Runtime profile and generic role runtime boundary (static source proof)", () => {
  it("EXAMINER_COMMERCIAL_V1 is code-owned, HTTP_JSON only, and inside migration 031's own DB ceiling", () => {
    const registry = readFileSync(
      "src/server/academic-runtime/profile-registry.ts",
      "utf8",
    );
    expect(registry).toMatch(/EXAMINER_COMMERCIAL_V1/);
    const migration = readFileSync(
      "supabase/migrations/202609160031_commercial_v1_examiner_grading.sql",
      "utf8",
    );
    expect(migration).toMatch(
      /max_output_tokens integer not null check\(max_output_tokens between 1 and 1200\)/,
    );
    expect(EXAMINER_EXECUTION_DB_CEILING).toEqual({
      maxProviderCalls: 1,
      maxOutputTokens: 1200,
      maxEstimatedCostMicrousd: 50000,
    });
    expect(EXAMINER_RUNTIME_PROFILE_REF).toBe("EXAMINER_COMMERCIAL_V1");
  });
  it("ROLES_WITH_REVIEWED_EXECUTION_PATH in the generic role runtime is not widened to include EXAMINER", () => {
    const runtime = readFileSync(
      "src/server/academic-runtime/index.ts",
      "utf8",
    );
    expect(runtime).toMatch(
      /ROLES_WITH_REVIEWED_EXECUTION_PATH[^;]*new Set\(\[\s*"PROFESSOR",?\s*\]\)/,
    );
  });
  it("migration 031 never mentions leaderboards or widens generic learner execution", () => {
    const migration = readFileSync(
      "supabase/migrations/202609160031_commercial_v1_examiner_grading.sql",
      "utf8",
    );
    expect(migration).not.toMatch(/create table public\.leaderboard/);
  });
  it("no server module under commercial-v1-examiner-grading persists raw provider output or reads assessment_answer_keys outside the two dedicated context RPCs", () => {
    for (const path of [
      "src/server/commercial-v1-examiner-grading/authority.ts",
      "src/server/commercial-v1-examiner-grading/index.ts",
    ]) {
      const text = readFileSync(path, "utf8");
      expect(text).not.toMatch(
        /assessment_answer_keys|expectedAnswer|markingGuidance/,
      );
    }
  });
});
