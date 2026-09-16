import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Blocker 1 (independent review, V3): this file exercises the REAL
// attestExaminerExecutionCommand implementation -- it is never mocked here.
// Only authenticated identity and the Supabase RPC transport are mocked, so
// this test independently proves the production TypeScript command signer
// produces a MAC that matches migration 031's own
// commercial_v1_examiner_private.verify_command_ex1 canonical text,
// INCLUDING the runtime profile ref field. tests/commercial-v1-examiner-
// grading-runtime.test.ts mocks the authority module wholesale to test a
// DIFFERENT boundary (orchestration logic); this file exists specifically
// because that boundary can never catch a canonical-message mismatch
// between the TypeScript signer and the SQL verifier.
const mocks = vi.hoisted(() => ({
  getAuthenticatedActor: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: mocks.getAuthenticatedActor,
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));

import {
  attestExaminerExecutionCommand,
  attestExaminerContextRead,
} from "@/server/commercial-v1-examiner-grading/authority";

const keyId = "11111111-0000-4000-8000-000000000001";
const keyHex = "a".repeat(64);
const studentId = "22222222-0000-4000-8000-000000000001";
const executionId = "33333333-0000-4000-8000-000000000001";
const attemptId = "44444444-0000-4000-8000-000000000001";
const enrolmentId = "66666666-0000-4000-8000-000000000001";
const activationId = "77777777-0000-4000-8000-000000000001";
const questionId = "88888888-0000-4000-8000-000000000001";
const resultRevisionId = "99999999-0000-4000-8000-000000000001";

function expectedHmac(fields: readonly string[]): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(fields.join("\n"), "utf8")
    .digest("hex");
}

function fakeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    executionId,
    studentId,
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

let capturedRpcArgs: Record<string, unknown> | undefined;
function mockClient(responseData: unknown) {
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    capturedRpcArgs = args;
    return { data: responseData, error: null };
  });
  mocks.client.mockResolvedValue({ rpc });
}

beforeEach(() => {
  vi.resetAllMocks();
  capturedRpcArgs = undefined;
  process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
  process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = keyHex;
  mocks.getAuthenticatedActor.mockResolvedValue({
    id: studentId,
    displayName: "Student",
    roles: ["STUDENT"],
  });
});

describe("attestExaminerExecutionCommand: real canonical message matches migration 031", () => {
  it("AUTHORIZE: p_mac equals an independently computed HMAC over the full migration-031 canonical text, including EXAMINER_COMMERCIAL_V1 immediately after EXAMINER", async () => {
    mockClient({
      ok: true,
      transitioned: true,
      execution: fakeSnapshot({ state: "AUTHORIZED" }),
    });
    await attestExaminerExecutionCommand(executionId, {
      operation: "AUTHORIZE",
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      budget: {
        maxProviderCalls: 1,
        maxOutputTokens: 1200,
        maxEstimatedCostMicrousd: 50000,
      },
    });
    expect(capturedRpcArgs).toBeDefined();
    const args = capturedRpcArgs!;
    // Independently authored (never imported from authority.ts): this is
    // migration 031's own field order, transcribed directly from the
    // migration's verify_command_ex1 canonical construction, not derived
    // from the implementation under test. A reordering, insertion or
    // removal on EITHER side makes this comparison fail.
    const expectedCanonical = [
      "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
      "COMMERCIAL_V1_EXAMINER_V1",
      "EXAMINER",
      "EXAMINER_COMMERCIAL_V1",
      keyId.toLowerCase(),
      studentId.toLowerCase(),
      executionId.toLowerCase(),
      "grade_controlled_assessment",
      "ASSESSMENT_ATTEMPT",
      attemptId.toLowerCase(),
      "NONE", // submission_id
      "NONE", // enrolment_id (unknown at AUTHORIZE)
      "NONE", // activation_id (unknown at AUTHORIZE)
      "AUTHORIZE",
      "AUTHORIZED",
      "NONE", // reason
      "NONE", // budget_stage
      "1", // max_calls
      "1200", // max_output
      "50000", // max_cost
      "0",
      "0",
      "0",
      "0",
      "0",
      "0", // usage x6, zero for AUTHORIZE
      "NONE", // grade_digest
      String(args.p_issued_at),
      String(args.p_expires_at),
    ];
    expect(args.p_mac).toBe(expectedHmac(expectedCanonical));
  });

  it("FINALIZE(SUCCEEDED): p_mac still matches independently, including real usage/grade digest fields and the profile ref", async () => {
    mockClient({
      ok: true,
      transitioned: true,
      execution: fakeSnapshot({
        state: "SUCCEEDED",
        reasonCode: "GRADED",
        resultRevisionId,
        gradeDigest: "b".repeat(64),
      }),
    });
    const marks = [{ questionId, marksAwarded: 7 }];
    await attestExaminerExecutionCommand(executionId, {
      operation: "FINALIZE",
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      enrolmentId,
      activationId,
      state: "SUCCEEDED",
      reason: "GRADED",
      budgetStage: null,
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 123,
        outputTokens: 45,
        estimatedCostMicrousd: 999,
        elapsedMs: 321,
      },
      gradeDigest: "b".repeat(64),
      assessmentMarks: marks,
      labMarksAwarded: null,
    });
    expect(capturedRpcArgs).toBeDefined();
    const args = capturedRpcArgs!;
    const expectedCanonical = [
      "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
      "COMMERCIAL_V1_EXAMINER_V1",
      "EXAMINER",
      "EXAMINER_COMMERCIAL_V1",
      keyId.toLowerCase(),
      studentId.toLowerCase(),
      executionId.toLowerCase(),
      "grade_controlled_assessment",
      "ASSESSMENT_ATTEMPT",
      attemptId.toLowerCase(),
      "NONE",
      enrolmentId.toLowerCase(),
      activationId.toLowerCase(),
      "FINALIZE",
      "SUCCEEDED",
      "GRADED",
      "NONE",
      "0", // max_calls (only AUTHORIZE proposes a budget)
      "0", // max_output
      "0", // max_cost
      "1", // provider_calls
      "1", // attempts
      "123", // input_tokens
      "45", // output_tokens
      "999", // estimated_cost_microusd
      "321", // elapsed_ms
      "b".repeat(64), // grade_digest
      String(args.p_issued_at),
      String(args.p_expires_at),
    ];
    expect(args.p_mac).toBe(expectedHmac(expectedCanonical));
    expect(args.p_assessment_marks).toEqual(marks);
  });
});

describe("attestExaminerContextRead: real canonical message (unchanged shape, still verified here)", () => {
  it("produces a p_mac matching the independently computed CONTEXT_READ canonical text", async () => {
    const attestation = await attestExaminerContextRead(executionId, {
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      enrolmentId,
      activationId,
    });
    const expectedCanonical = [
      "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
      "COMMERCIAL_V1_EXAMINER_V1",
      "EXAMINER",
      "EXAMINER_COMMERCIAL_V1",
      keyId.toLowerCase(),
      studentId.toLowerCase(),
      executionId.toLowerCase(),
      "grade_controlled_assessment",
      "ASSESSMENT_ATTEMPT",
      attemptId.toLowerCase(),
      "NONE",
      enrolmentId.toLowerCase(),
      activationId.toLowerCase(),
      "CONTEXT_READ",
      String(attestation.p_issued_at),
      String(attestation.p_expires_at),
    ];
    expect(attestation.p_mac).toBe(expectedHmac(expectedCanonical));
  });
});
