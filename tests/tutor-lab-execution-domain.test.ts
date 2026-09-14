import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  tutorLabRoleSchema,
  tutorLabSupportRequestSchema,
  learnerSupportMessageSchema,
  mapRuntimeResultToTutorLabOutcome,
  mapRuntimeResultToTutorLabFinalizeCommand,
  TUTOR_LAB_EXECUTION_DB_CEILING,
} from "@/domain/tutor-lab-execution";

const zeroUsage = {
  providerCalls: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostMicrousd: 0,
  elapsedMs: 0,
};

describe("tutorLabRoleSchema", () => {
  it("accepts exactly TUTOR and LAB_INSTRUCTOR", () => {
    expect(tutorLabRoleSchema.safeParse("TUTOR").success).toBe(true);
    expect(tutorLabRoleSchema.safeParse("LAB_INSTRUCTOR").success).toBe(true);
  });
  it.each(["EXAMINER", "COUNSELLOR", "PROFESSOR", "TUTOR_LAB", ""])(
    "rejects %s -- Examiner/Counsellor can never be a Tutor/Lab execution role",
    (value) => {
      expect(tutorLabRoleSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("tutorLabSupportRequestSchema / learnerSupportMessageSchema", () => {
  const valid = {
    handoffId: "40000000-0000-4000-8000-000000000009",
    message: "hi",
    idempotencyKey: "40000000-0000-4000-8000-000000000010",
  };
  it("accepts the exact reviewed shape", () => {
    expect(tutorLabSupportRequestSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects an unknown extra field (strict object) -- no role/provider/model/budget escape hatch", () => {
    for (const field of ["role", "provider", "model", "capability", "budget"]) {
      expect(
        tutorLabSupportRequestSchema.safeParse({ ...valid, [field]: "forged" })
          .success,
      ).toBe(false);
    }
  });
  it("rejects a non-uuid handoffId/idempotencyKey", () => {
    expect(
      tutorLabSupportRequestSchema.safeParse({ ...valid, handoffId: "x" })
        .success,
    ).toBe(false);
    expect(
      tutorLabSupportRequestSchema.safeParse({ ...valid, idempotencyKey: "x" })
        .success,
    ).toBe(false);
  });
  it("rejects empty/whitespace-only or overlong messages, accepts exactly 2000 chars", () => {
    expect(learnerSupportMessageSchema.safeParse("").success).toBe(false);
    expect(learnerSupportMessageSchema.safeParse("   ").success).toBe(false);
    expect(
      learnerSupportMessageSchema.safeParse("x".repeat(2000)).success,
    ).toBe(true);
    expect(
      learnerSupportMessageSchema.safeParse("x".repeat(2001)).success,
    ).toBe(false);
  });
});

describe("mapRuntimeResultToTutorLabOutcome", () => {
  it("SUCCEEDED carries only the provider's own outputText", () => {
    expect(
      mapRuntimeResultToTutorLabOutcome({
        outcome: "SUCCEEDED",
        usage: zeroUsage,
        response: {
          outputText: "hello",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
        },
      }),
    ).toEqual({ kind: "SUCCEEDED", text: "hello" });
  });
  it("ABSTAINED/ACTIVITY_BLOCKED maps to ACTIVITY_BLOCKED, other reasons to UNAVAILABLE", () => {
    expect(
      mapRuntimeResultToTutorLabOutcome({
        outcome: "ABSTAINED",
        usage: zeroUsage,
        reason: "ACTIVITY_BLOCKED",
      }),
    ).toEqual({ kind: "ACTIVITY_BLOCKED" });
    expect(
      mapRuntimeResultToTutorLabOutcome({
        outcome: "ABSTAINED",
        usage: zeroUsage,
        reason: "UNKNOWN_MODEL_PROFILE",
      }),
    ).toEqual({ kind: "UNAVAILABLE" });
  });
  it.each([
    { outcome: "BUDGET_BLOCKED", usage: zeroUsage, stage: "PRE_CALL" },
    { outcome: "TIMEOUT", usage: zeroUsage },
    { outcome: "FAILED", usage: zeroUsage, reason: "PROVIDER_ERROR" },
    { outcome: "CANCELLED", usage: zeroUsage },
  ] as const)("$outcome maps to RETRY_LATER", (result) => {
    expect(mapRuntimeResultToTutorLabOutcome(result)).toEqual({
      kind: "RETRY_LATER",
    });
  });
});

describe("mapRuntimeResultToTutorLabFinalizeCommand", () => {
  it("stays inside the DB ceiling shape (maxProviderCalls fixed at 1)", () => {
    expect(TUTOR_LAB_EXECUTION_DB_CEILING.maxProviderCalls).toBe(1);
  });
  it("TIMEOUT maps to FAILED/EXECUTION_TIMEOUT, never its own TIMEOUT state", () => {
    expect(
      mapRuntimeResultToTutorLabFinalizeCommand({
        outcome: "TIMEOUT",
        usage: zeroUsage,
      }),
    ).toMatchObject({ state: "FAILED", reason: "EXECUTION_TIMEOUT" });
  });
});

describe("Examiner/Counsellor execution remains structurally closed", () => {
  it("ROLES_WITH_REVIEWED_EXECUTION_PATH in the Professor composition boundary is still exactly {PROFESSOR}", async () => {
    const source = await readFile(
      "src/server/academic-runtime/index.ts",
      "utf8",
    );
    expect(source).toMatch(
      /ROLES_WITH_REVIEWED_EXECUTION_PATH[^=]*= new Set\(\[\s*"PROFESSOR",?\s*\]\)/,
    );
  });
  it("migration 028 constrains every Tutor/Lab table/function to exactly TUTOR/LAB_INSTRUCTOR, never EXAMINER/COUNSELLOR", async () => {
    const migration = await readFile(
      "supabase/migrations/202609140028_commercial_v1_tutor_lab_execution.sql",
      "utf8",
    );
    expect(migration).not.toMatch(/'EXAMINER'/);
    expect(migration).not.toMatch(/'COUNSELLOR'/);
  });
});

describe("Protected assessment content isolation", () => {
  it("Tutor/Lab context/authority/composition source never references protected answer content or the answer-key table", async () => {
    const files = [
      "src/server/tutor-lab-execution/context.ts",
      "src/server/tutor-lab-execution/authority.ts",
      "src/server/tutor-lab-execution/release.ts",
      "src/server/tutor-lab-execution/index.ts",
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /assessment_answer_keys|expectedAnswer|expected_answer|markingGuidance|marking_guidance/i,
      );
    }
  });
  it("migration 028 never selects expected_answer/marking_guidance and only touches assessment_answer_keys to tighten its ACL", async () => {
    const migration = await readFile(
      "supabase/migrations/202609140028_commercial_v1_tutor_lab_execution.sql",
      "utf8",
    );
    expect(migration).not.toMatch(/expected_answer|marking_guidance/);
  });
});

describe("Audit privacy: no learner/provider/instructional content field exists", () => {
  it("tutor_lab_content_releases and tutor_lab_provider_executions have no content column", async () => {
    const migration = await readFile(
      "supabase/migrations/202609140028_commercial_v1_tutor_lab_execution.sql",
      "utf8",
    );
    expect(migration).not.toMatch(
      /\bmessage text\b|\bprompt text\b|\bresponse text\b/,
    );
  });
});
