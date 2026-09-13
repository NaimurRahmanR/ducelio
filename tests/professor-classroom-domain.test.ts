import { describe, expect, it } from "vitest";
import {
  previewClassroomEligibility,
  mapRuntimeResultToClassroomOutcome,
  professorClassroomInteractionSchema,
  learnerMessageSchema,
} from "@/domain/professor-classroom";
import type { RuntimeResult } from "@/domain/academic-runtime";

const zeroUsage = {
  providerCalls: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostMicrousd: 0,
  elapsedMs: 0,
};

describe("previewClassroomEligibility", () => {
  const session = {
    status: "SCHEDULED",
    scheduledStart: "2026-06-01T10:00:00.000Z",
    scheduledEnd: "2026-06-01T11:00:00.000Z",
  };
  it("is FUTURE strictly before scheduled_start", () => {
    expect(
      previewClassroomEligibility(
        session,
        new Date("2026-06-01T09:59:59.999Z"),
      ),
    ).toEqual({ kind: "FUTURE" });
  });
  it("is LIVE at scheduled_start, throughout the window and exactly at scheduled_end", () => {
    expect(
      previewClassroomEligibility(
        session,
        new Date("2026-06-01T10:00:00.000Z"),
      ),
    ).toEqual({ kind: "LIVE" });
    expect(
      previewClassroomEligibility(
        session,
        new Date("2026-06-01T10:30:00.000Z"),
      ),
    ).toEqual({ kind: "LIVE" });
    expect(
      previewClassroomEligibility(
        session,
        new Date("2026-06-01T11:00:00.000Z"),
      ),
    ).toEqual({ kind: "LIVE" });
  });
  it("is CATCH_UP strictly after scheduled_end", () => {
    expect(
      previewClassroomEligibility(
        session,
        new Date("2026-06-01T11:00:00.001Z"),
      ),
    ).toEqual({ kind: "CATCH_UP" });
  });
  it("is CANCELLED regardless of time, overriding any window", () => {
    expect(
      previewClassroomEligibility(
        { ...session, status: "CANCELLED" },
        new Date("2026-06-01T10:30:00.000Z"),
      ),
    ).toEqual({ kind: "CANCELLED" });
  });
});

describe("mapRuntimeResultToClassroomOutcome", () => {
  it("SUCCEEDED carries only the provider's own outputText", () => {
    const result: RuntimeResult = {
      outcome: "SUCCEEDED",
      usage: zeroUsage,
      response: {
        outputText: "hello",
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
      },
    };
    expect(mapRuntimeResultToClassroomOutcome(result)).toEqual({
      kind: "SUCCEEDED",
      text: "hello",
    });
  });
  it("ABSTAINED/ACTIVITY_BLOCKED maps to ACTIVITY_BLOCKED", () => {
    expect(
      mapRuntimeResultToClassroomOutcome({
        outcome: "ABSTAINED",
        usage: zeroUsage,
        reason: "ACTIVITY_BLOCKED",
      }),
    ).toEqual({ kind: "ACTIVITY_BLOCKED" });
  });
  it.each([
    "POLICY_BLOCKED",
    "NO_PROVIDER_CONFIGURED",
    "UNKNOWN_MODEL_PROFILE",
    "NO_EXECUTION_PATH",
  ] as const)("ABSTAINED/%s maps to UNAVAILABLE", (reason) => {
    expect(
      mapRuntimeResultToClassroomOutcome({
        outcome: "ABSTAINED",
        usage: zeroUsage,
        reason,
      }),
    ).toEqual({ kind: "UNAVAILABLE" });
  });
  it("ESCALATED maps to ESCALATED", () => {
    expect(
      mapRuntimeResultToClassroomOutcome({
        outcome: "ESCALATED",
        usage: zeroUsage,
        reviewPath: "ACADEMIC_REVIEW",
      }),
    ).toEqual({ kind: "ESCALATED" });
  });
  it.each([
    { outcome: "BUDGET_BLOCKED", usage: zeroUsage, stage: "PRE_CALL" },
    { outcome: "TIMEOUT", usage: zeroUsage },
    { outcome: "FAILED", usage: zeroUsage, reason: "PROVIDER_ERROR" },
    { outcome: "CANCELLED", usage: zeroUsage },
  ] as const)("$outcome maps to RETRY_LATER", (result) => {
    expect(mapRuntimeResultToClassroomOutcome(result)).toEqual({
      kind: "RETRY_LATER",
    });
  });
});

describe("professorClassroomInteractionSchema / learnerMessageSchema", () => {
  it("accepts BEGIN_LESSON with no other field", () => {
    expect(
      professorClassroomInteractionSchema.safeParse({ kind: "BEGIN_LESSON" })
        .success,
    ).toBe(true);
  });
  it("rejects BEGIN_LESSON with an extra field (strict object)", () => {
    expect(
      professorClassroomInteractionSchema.safeParse({
        kind: "BEGIN_LESSON",
        extra: 1,
      }).success,
    ).toBe(false);
  });
  it("accepts LEARNER_QUESTION with a bounded trimmed message", () => {
    const parsed = professorClassroomInteractionSchema.safeParse({
      kind: "LEARNER_QUESTION",
      learnerMessage: "  hi  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "LEARNER_QUESTION")
      expect(parsed.data.learnerMessage).toBe("hi");
  });
  it("rejects an empty (or whitespace-only) learner message", () => {
    expect(learnerMessageSchema.safeParse("").success).toBe(false);
    expect(learnerMessageSchema.safeParse("   ").success).toBe(false);
  });
  it("accepts exactly 2000 characters and rejects 2001", () => {
    expect(learnerMessageSchema.safeParse("x".repeat(2000)).success).toBe(true);
    expect(learnerMessageSchema.safeParse("x".repeat(2001)).success).toBe(
      false,
    );
  });
  it("rejects a non-string value outright (no arbitrary JSON)", () => {
    expect(learnerMessageSchema.safeParse(12345).success).toBe(false);
    expect(learnerMessageSchema.safeParse({ text: "hi" }).success).toBe(false);
  });
  it("rejects an unknown interaction kind", () => {
    expect(
      professorClassroomInteractionSchema.safeParse({ kind: "FREEFORM" })
        .success,
    ).toBe(false);
  });
});
