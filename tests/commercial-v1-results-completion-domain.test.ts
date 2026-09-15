import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMMERCIAL_V1_RESULTS_POLICY,
  setCommercialV1LabPolicyInputSchema,
  publishCommercialV1ResultPolicyInputSchema,
  submitCommercialV1LabWorkInputSchema,
  attemptCommercialV1CourseCompletionInputSchema,
  commercialV1ObjectiveOutcomeSchema,
  commercialV1CourseProgressSchema,
  listCommercialV1ObjectiveDiagnosticsInputSchema,
  commercialV1ObjectiveDiagnosticsSchema,
  attemptCommercialV1CourseCompletionResultSchema,
} from "@/domain/commercial-v1-results-completion";

describe("Result/lab policy input contracts forbid caller-supplied marks/scores", () => {
  it("publishCommercialV1ResultPolicyInputSchema requires an explicit pass mark -- no default exists", () => {
    const valid = {
      activationId: "aaaaaaaa-0000-4000-8000-000000000001",
      passMarkBp: 5000,
      requireRemediationClearForCompletion: false,
      reason: "Publish the Commercial V1 result policy",
    };
    expect(
      publishCommercialV1ResultPolicyInputSchema.safeParse(valid).success,
    ).toBe(true);
    const { passMarkBp: _omit, ...missingPassMark } = valid;
    void _omit;
    expect(
      publishCommercialV1ResultPolicyInputSchema.safeParse(missingPassMark)
        .success,
    ).toBe(false);
    for (const bad of [0, 10001, -1, 1.5]) {
      expect(
        publishCommercialV1ResultPolicyInputSchema.safeParse({
          ...valid,
          passMarkBp: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("setCommercialV1LabPolicyInputSchema bounds contributionBp to 0..2000 -- never the full 10000", () => {
    const valid = {
      activationId: "aaaaaaaa-0000-4000-8000-000000000001",
      practicalId: "bbbbbbbb-0000-4000-8000-000000000001",
      maxMarks: 10,
      contributionBp: 500,
      gradingGuidance: "Grade for correct configuration.",
      reason: "Configure the lab policy",
    };
    expect(setCommercialV1LabPolicyInputSchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      setCommercialV1LabPolicyInputSchema.safeParse({
        ...valid,
        contributionBp: 2001,
      }).success,
    ).toBe(false);
    expect(
      setCommercialV1LabPolicyInputSchema.safeParse({
        ...valid,
        contributionBp: -1,
      }).success,
    ).toBe(false);
  });

  it("submitCommercialV1LabWorkInputSchema is text-only, bounded, no file/attachment field", () => {
    const valid = {
      enrolmentId: "aaaaaaaa-0000-4000-8000-000000000001",
      practicalId: "bbbbbbbb-0000-4000-8000-000000000001",
      body: "My lab submission.",
      idempotencyKey: "idempotency-key-12345",
    };
    expect(submitCommercialV1LabWorkInputSchema.safeParse(valid).success).toBe(
      true,
    );
    for (const extra of [
      { fileUrl: "https://example.com/file" },
      { attachment: "base64data" },
      { marksAwarded: 10 },
    ]) {
      expect(
        submitCommercialV1LabWorkInputSchema.safeParse({ ...valid, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("attemptCommercialV1CourseCompletionInputSchema has no score/pass-mark override field", () => {
    const valid = {
      enrolmentId: "aaaaaaaa-0000-4000-8000-000000000001",
      reason: "Attempt completion",
    };
    expect(
      attemptCommercialV1CourseCompletionInputSchema.safeParse(valid).success,
    ).toBe(true);
    for (const extra of [
      { courseScoreBp: 10000 },
      { passMarkBp: 1 },
      { force: true },
    ]) {
      expect(
        attemptCommercialV1CourseCompletionInputSchema.safeParse({
          ...valid,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("Objective outcome classification", () => {
  it("is exactly CORRECT/PARTIAL/INCORRECT -- no percentage threshold value", () => {
    expect(commercialV1ObjectiveOutcomeSchema.options).toEqual([
      "CORRECT",
      "PARTIAL",
      "INCORRECT",
    ]);
  });
});

describe("Policy identity", () => {
  it("policy_version is the fixed COMMERCIAL_V1_RESULTS_V1 string", () => {
    expect(COMMERCIAL_V1_RESULTS_POLICY).toBe("COMMERCIAL_V1_RESULTS_V1");
  });
});

describe("Course progress projection redaction", () => {
  it("rejects a payload carrying protected content fields", () => {
    const base = {
      ok: true as const,
      activationId: "aaaaaaaa-0000-4000-8000-000000000001",
      gradingPolicyPublished: true,
      resultPolicyPublished: true,
      passMarkBp: 5000,
      requireRemediationClearForCompletion: false,
      components: {},
      labs: {},
      courseScoreBp: null,
      pending: [],
      openRemediationCount: 0,
      enrolmentStatus: "ACTIVE",
      completed: false,
    };
    expect(commercialV1CourseProgressSchema.safeParse(base).success).toBe(true);
    for (const extra of [
      { expectedAnswer: "leak" },
      { markingGuidance: "leak" },
      { responseBody: "leak" },
    ]) {
      expect(
        commercialV1CourseProgressSchema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("a denied projection carries only ok/code, no partial data leak", () => {
    expect(
      commercialV1CourseProgressSchema.safeParse({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
      }).success,
    ).toBe(true);
  });

  it("a denied course-progress payload rejects success-only enrolment metadata", () => {
    expect(
      commercialV1CourseProgressSchema.safeParse({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
        enrolmentStatus: "ACTIVE",
        completed: false,
      }).success,
    ).toBe(false);
  });
});

describe("Objective diagnostics contract", () => {
  it("requires bounded pagination and accepts redacted source-level outcomes", () => {
    expect(
      listCommercialV1ObjectiveDiagnosticsInputSchema.safeParse({
        enrolmentId: "aaaaaaaa-0000-4000-8000-000000000001",
        limit: 25,
        offset: 0,
      }).success,
    ).toBe(true);
    expect(
      listCommercialV1ObjectiveDiagnosticsInputSchema.safeParse({
        enrolmentId: "aaaaaaaa-0000-4000-8000-000000000001",
        limit: 101,
        offset: 0,
      }).success,
    ).toBe(false);
    expect(
      commercialV1ObjectiveDiagnosticsSchema.safeParse({
        ok: true,
        items: [
          {
            objectiveId: "bbbbbbbb-0000-4000-8000-000000000001",
            sourceKind: "ASSESSMENT",
            component: "QUIZ_1",
            practicalId: null,
            outcome: "PARTIAL",
            remediationOpen: true,
          },
        ],
        limit: 25,
        offset: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects protected content in a diagnostics payload", () => {
    expect(
      commercialV1ObjectiveDiagnosticsSchema.safeParse({
        ok: true,
        items: [
          {
            objectiveId: "bbbbbbbb-0000-4000-8000-000000000001",
            sourceKind: "LAB",
            component: null,
            practicalId: "cccccccc-0000-4000-8000-000000000001",
            outcome: "INCORRECT",
            remediationOpen: true,
            responseBody: "secret",
          },
        ],
        limit: 25,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});

describe("Completion result contract", () => {
  it("accepts every documented code and rejects an invented one", () => {
    for (const code of [
      "NOT_FOUND_OR_FORBIDDEN",
      "ENROLMENT_NOT_ACTIVE",
      "RESULT_POLICY_REQUIRED",
      "COMPONENTS_INCOMPLETE",
      "BELOW_PASS_MARK",
      "REMEDIATION_NOT_CLEAR",
      "COMPLETION_RECEIPT_MISSING",
    ]) {
      expect(
        attemptCommercialV1CourseCompletionResultSchema.safeParse({
          ok: false,
          code,
        }).success,
      ).toBe(true);
    }
    expect(
      attemptCommercialV1CourseCompletionResultSchema.safeParse({
        ok: false,
        code: "MADE_UP_CODE",
      }).success,
    ).toBe(false);
  });
});

describe("No provider/model call and no leaderboard in this checkpoint (static source-text proof)", () => {
  it("migration 030 never references a provider adapter, model call, or leaderboard table", () => {
    const migration = readFileSync(
      "supabase/migrations/202609150030_commercial_v1_results_completion.sql",
      "utf8",
    );
    // Comments are free to explain what this checkpoint deliberately does
    // NOT build; the structural check requires an actual schema-qualified
    // table/function reference, which none of these ever have here.
    expect(migration).not.toMatch(
      /create table public\.leaderboard|public\.academic_provider_executions|public\.tutor_lab_provider_executions|has_role\('EXAMINER'\)/,
    );
  });
  it("no server module in this checkpoint imports the academic runtime/provider adapter", () => {
    const server = readFileSync(
      "src/server/commercial-v1-results-completion.ts",
      "utf8",
    );
    expect(server).not.toMatch(/academic-runtime|ProviderAdapter/);
  });
});
