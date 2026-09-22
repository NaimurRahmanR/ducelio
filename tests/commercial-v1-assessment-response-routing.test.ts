import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/identity", () => ({
  requireActor: async () => ({ id: "actor", displayName: "A", roles: [] }),
  requireStudentPrincipal: async () => ({
    id: "actor",
    displayName: "A",
    roles: ["STUDENT"],
  }),
  requireAnyRole: async () => ({ id: "actor", displayName: "A", roles: [] }),
}));

import { recordAssessmentResponse } from "@/server/assessments";

const GOVERNED = "record_commercial_v1_assessment_response";
const LEGACY = "record_assessment_response";
const attemptId = "11111111-1111-4111-8111-111111111111";
const questionId = "22222222-2222-4222-8222-222222222222";
const responseId = "33333333-3333-4333-8333-333333333333";
const input = {
  attemptId,
  questionId,
  body: "An answer",
  idempotencyKey: "assessment-key-0001",
};
const expiredResult = {
  ok: false,
  code: "EXPIRED",
  state: "SUBMITTED",
  submittedAt: "2026-09-22T00:31:13.492001+00:00",
  submissionProvenance: "AUTO_TIMEOUT",
};

// Script the two writers; anything else the composition might call is a bug.
function script(governed: unknown, legacy?: unknown) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === GOVERNED)
      return governed instanceof Error
        ? { data: null, error: { message: governed.message } }
        : { data: governed, error: null };
    if (name === LEGACY)
      return legacy instanceof Error
        ? { data: null, error: { message: legacy.message } }
        : { data: legacy ?? responseId, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
}
const called = () => mocks.rpc.mock.calls.map(([name]) => name as string);

beforeEach(() => {
  // A block body on purpose: Vitest treats a function RETURNED from
  // beforeEach as a cleanup hook, and mockReset() returns the mock itself.
  mocks.rpc.mockReset();
});

describe("assessment response routing: the governed writer decides", () => {
  it.each([
    ["success", { ok: true, responseId }],
    ["EXPIRED", expiredResult],
    ["RESPONSE_WINDOW_CLOSED", { ok: false, code: "RESPONSE_WINDOW_CLOSED" }],
    ["ATTEMPT_NOT_ACTIVE", { ok: false, code: "ATTEMPT_NOT_ACTIVE" }],
    ["NOT_FOUND_OR_FORBIDDEN", { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" }],
    ["IDEMPOTENCY_CONFLICT", { ok: false, code: "IDEMPOTENCY_CONFLICT" }],
    ["INVALID_INPUT", { ok: false, code: "INVALID_INPUT" }],
  ])(
    "%s is final: returned as-is and the legacy writer is never called",
    async (_name, governed) => {
      script(governed);

      const outcome = await recordAssessmentResponse(input);

      expect(outcome).toEqual(governed);
      expect(called()).toEqual([GOVERNED]);
    },
  );

  it("NOT_COMMERCIAL_V1_GOVERNED is the only condition that routes to the legacy writer, with identical arguments", async () => {
    script({ ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" });

    const outcome = await recordAssessmentResponse(input);

    expect(outcome).toEqual({ ok: true, responseId });
    expect(called()).toEqual([GOVERNED, LEGACY]);
    const [governedCall, legacyCall] = mocks.rpc.mock.calls;
    expect(legacyCall[1]).toEqual(governedCall[1]);
    expect(legacyCall[1]).toEqual({
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_body: "An answer",
      p_idempotency_key: "assessment-key-0001",
    });
  });

  it("the internal routing signal never escapes the boundary", async () => {
    script({ ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" });

    const outcome = await recordAssessmentResponse(input);

    expect(JSON.stringify(outcome)).not.toContain("NOT_COMMERCIAL_V1_GOVERNED");
    expect(outcome).not.toHaveProperty("code");
  });

  it("a legacy refusal after the governed probe throws and is never retried or re-routed", async () => {
    script(
      { ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" },
      new Error("Assessment attempt has expired"),
    );

    await expect(recordAssessmentResponse(input)).rejects.toThrow(
      "Assessment response could not be saved.",
    );
    expect(called()).toEqual([GOVERNED, LEGACY]);
  });

  it("a governed transport/RPC error throws and never falls back to the legacy writer", async () => {
    script(new Error("connection reset"));

    await expect(recordAssessmentResponse(input)).rejects.toThrow(
      "Your response could not be saved.",
    );
    expect(called()).toEqual([GOVERNED]);
  });

  it.each([
    ["null", null],
    ["an unknown code", { ok: false, code: "SOMETHING_NEW" }],
    ["no code", { ok: false }],
    ["success without an id", { ok: true }],
    ["success with a non-uuid id", { ok: true, responseId: "nope" }],
    ["EXPIRED missing its terminal fields", { ok: false, code: "EXPIRED" }],
    [
      "EXPIRED with a foreign provenance",
      { ...expiredResult, submissionProvenance: "STUDENT_SUBMIT" },
    ],
    [
      "the routing signal carrying an extra field",
      { ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED", detail: "x" },
    ],
    [
      "success carrying an extra field",
      { ok: true, responseId, expectedAnswer: "leak" },
    ],
  ])(
    "an unrecognised governed result (%s) throws and never falls back",
    async (_name, governed) => {
      script(governed);

      await expect(recordAssessmentResponse(input)).rejects.toThrow();
      expect(called()).toEqual([GOVERNED]);
    },
  );

  it.each([
    ["a non-uuid attempt", { ...input, attemptId: "nope" }],
    ["a non-uuid question", { ...input, questionId: "nope" }],
    ["an empty body", { ...input, body: "   " }],
    ["an oversized body", { ...input, body: "x".repeat(20001) }],
    ["a short idempotency key", { ...input, idempotencyKey: "short" }],
    ["a missing field", { attemptId, questionId, body: "x" }],
  ])("%s is rejected before any RPC is issued", async (_name, bad) => {
    script({ ok: true, responseId });

    await expect(recordAssessmentResponse(bad)).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("caller-supplied routing hints are not forwarded to either writer", async () => {
    script({ ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" });

    await recordAssessmentResponse({
      ...input,
      isCommercialV1: false,
      governed: false,
      rpc: LEGACY,
      studentId: "44444444-4444-4444-8444-444444444444",
    });

    for (const [, args] of mocks.rpc.mock.calls)
      expect(Object.keys(args as object).sort()).toEqual([
        "p_attempt_id",
        "p_body",
        "p_idempotency_key",
        "p_question_id",
      ]);
  });
});

// A source-level tripwire, in the repository's existing static-guard style:
// the legacy writer must stay reachable only through the composition.
describe("assessment response composition: static guards", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry) ? [path] : [];
    });
  }
  const src = resolve("src");

  it("only src/server/assessments.ts references the legacy response RPC", () => {
    const offenders = sourceFiles(src).filter(
      (file) =>
        /["'`]record_assessment_response["'`]/.test(
          readFileSync(file, "utf8"),
        ) && !file.endsWith(join("server", "assessments.ts")),
    );
    expect(offenders).toEqual([]);
  });

  it("the legacy writer is private to assessments.ts and has exactly one call site", () => {
    const source = readFileSync(resolve("src/server/assessments.ts"), "utf8");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+recordLegacyAssessmentResponse/,
    );
    expect(source.match(/["']record_assessment_response["']/g)).toHaveLength(1);
    expect(source.match(/recordLegacyAssessmentResponse\(/g)).toHaveLength(2);
    // The single fallback is guarded by the explicit governed-negative code.
    expect(source).toMatch(
      /governed\.ok\s*\|\|\s*governed\.code\s*!==\s*"NOT_COMMERCIAL_V1_GOVERNED"\s*\)\s*return governed;/,
    );
  });

  it("the learner Server Action neither names a writer nor issues an RPC", () => {
    const source = readFileSync(resolve("src/app/student/actions.ts"), "utf8");
    expect(source).not.toMatch(/\.rpc\(/);
    expect(source).not.toMatch(/recordCommercialV1AssessmentResponse/);
    expect(source).not.toMatch(/record_assessment_response/);
    expect(source).not.toMatch(/isCommercialV1/);
  });
});
