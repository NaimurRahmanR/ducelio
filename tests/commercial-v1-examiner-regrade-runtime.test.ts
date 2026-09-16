import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  snapshot,
  labSnapshot,
  assessmentContext,
  labContext,
  input,
  observedUsage,
  uuid,
} from "./commercial-v1-examiner-regrade-test-data";
import { RegradeDenied } from "@/domain/commercial-v1-examiner-regrade";
import type { RegradeCommand } from "@/server/commercial-v1-examiner-regrade/authority";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  command: vi.fn(),
  context: vi.fn(),
  runtime: vi.fn(),
  profile: vi.fn(),
  adapter: vi.fn(),
}));
vi.mock("@/server/commercial-v1-examiner-regrade/authority", () => ({
  requireRegradeActor: mocks.actor,
  attestRegradeCommand: mocks.command,
}));
vi.mock("@/server/commercial-v1-examiner-regrade/context", () => ({
  getRegradeContext: mocks.context,
}));
vi.mock("@/server/academic-runtime/profile-registry", () => ({
  resolveRuntimeProfile: mocks.profile,
  resolveAdapterForProfile: mocks.adapter,
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: mocks.runtime,
}));
import {
  regradeControlledAssessment,
  regradePracticalLab,
} from "@/server/commercial-v1-examiner-regrade";
const events: string[] = [];
function response(outputText: string) {
  return {
    outcome: "SUCCEEDED",
    usage: observedUsage,
    response: {
      outputText,
      usage: { inputTokens: 50, outputTokens: 20, estimatedCostMicrousd: 100 },
    },
  };
}
function wire(s = snapshot()) {
  mocks.command.mockImplementation(async (id: string, c: RegradeCommand) => {
    events.push(c.operation);
    return {
      transitioned: true,
      snapshot: {
        ...s,
        executionId: id,
        state:
          c.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : c.operation === "START"
              ? "RUNNING"
              : c.operation === "FINALIZE"
                ? c.state
                : "RUNNING",
        resultRevisionId:
          c.operation === "FINALIZE" && c.state === "SUCCEEDED"
            ? uuid(20)
            : null,
      },
    };
  });
  mocks.context.mockImplementation(async () => {
    events.push("CONTEXT_READ");
    return s.targetKind === "ASSESSMENT_ATTEMPT"
      ? { kind: "ASSESSMENT", context: assessmentContext }
      : { kind: "LAB", context: labContext };
  });
  mocks.runtime.mockImplementation(async () => {
    events.push("PROVIDER");
    return response(
      s.targetKind === "ASSESSMENT_ATTEMPT"
        ? JSON.stringify({
            outcome: "GRADED",
            marks: [{ questionId: uuid(9), marksAwarded: 3 }],
          })
        : '{"outcome":"GRADED","marksAwarded":7}',
    );
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  events.length = 0;
  mocks.actor.mockResolvedValue({ id: uuid(2), roles: ["ACADEMIC_ADMIN"] });
  mocks.profile.mockReturnValue({
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
  mocks.adapter.mockReturnValue({});
  wire();
});
describe("dedicated regrade orchestrator", () => {
  it.each([false, true])(
    "%s uses exactly one provider phase after attested context",
    async (lab) => {
      wire(lab ? labSnapshot() : snapshot());
      expect(
        await (lab ? regradePracticalLab : regradeControlledAssessment)(input),
      ).toMatchObject({ status: "REGRADED", resultRevisionId: uuid(20) });
      expect(events).toEqual([
        "AUTHORIZE",
        "START",
        "CONTEXT_READ",
        "PROVIDER",
        "FINALIZE",
      ]);
      expect(mocks.runtime).toHaveBeenCalledTimes(1);
      const providerInput = mocks.runtime.mock.calls[0][1];
      expect(providerInput.context).toEqual(
        lab ? labContext : assessmentContext,
      );
      expect(JSON.stringify(providerInput)).not.toContain(input.reason);
      expect(providerInput).not.toHaveProperty("snapshot");
      expect(mocks.command.mock.calls[2][1]).toMatchObject({
        usage: observedUsage,
      });
    },
  );
  it("successful replay returns original result without provider", async () => {
    mocks.command.mockResolvedValue({
      transitioned: false,
      snapshot: snapshot({
        state: "SUCCEEDED",
        resultRevisionId: uuid(20),
        gradeDigest: "a".repeat(64),
      }),
    });
    expect(await regradeControlledAssessment(input)).toMatchObject({
      status: "ALREADY_REGRADED",
      resultRevisionId: uuid(20),
    });
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("active claim replay makes zero provider calls", async () => {
    mocks.command.mockRejectedValue(new RegradeDenied("REPLAY_REJECTED"));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "RETRY_LATER",
    });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("absent provider follows zero-call terminal failure", async () => {
    mocks.adapter.mockReturnValue(null);
    mocks.runtime.mockResolvedValue({
      outcome: "ABSTAINED",
      reason: "NO_PROVIDER_CONFIGURED",
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
    });
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.runtime.mock.calls[0][0]).toBeNull();
    expect(mocks.command.mock.calls[2][1]).toMatchObject({
      state: "FAILED",
      reason: "NO_PROVIDER_CONFIGURED",
      usage: { providerCalls: 0 },
    });
  });
  it.each([
    "malformed",
    '{"outcome":"GRADED","marks":[],"rationale":"secret"}',
    '{"outcome":"GRADED","marks":[]}',
  ])("strict malformed output %s cannot succeed", async (body) => {
    mocks.runtime.mockResolvedValue(response(body));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.command.mock.calls[2][1]).toMatchObject({
      state: "FAILED",
      reason: "OUTPUT_INVALID",
      usage: observedUsage,
    });
  });
  it("ESCALATE is first-class and creates no result", async () => {
    mocks.runtime.mockResolvedValue(response('{"outcome":"ESCALATE"}'));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "ESCALATED",
    });
    expect(mocks.command.mock.calls[2][1]).toMatchObject({
      state: "ESCALATED",
      gradeDigest: null,
      assessmentMarks: null,
    });
  });
  it("all-unanswered accepts marks [] through FINALIZE", async () => {
    mocks.context.mockResolvedValue({
      kind: "ASSESSMENT",
      context: { ...assessmentContext, questions: [] },
    });
    mocks.runtime.mockResolvedValue(
      response('{"outcome":"GRADED","marks":[]}'),
    );
    expect(await regradeControlledAssessment(input)).toMatchObject({
      status: "REGRADED",
    });
    expect(mocks.command.mock.calls[2][1]).toMatchObject({
      assessmentMarks: [],
    });
  });
  it("malformed known usage produces no invented zero finalize", async () => {
    mocks.runtime.mockResolvedValue({
      ...response('{"outcome":"ESCALATE"}'),
      usage: { ...observedUsage, providerCalls: 4 },
    });
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });
  it("context failure precedes provider and persists zero-usage cleanup", async () => {
    mocks.context.mockRejectedValue(new RegradeDenied("CONTEXT_CONFLICT"));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.command.mock.calls[2][1]).toMatchObject({
      state: "FAILED",
      usage: { providerCalls: 0 },
    });
  });
  it("post-provider transport failure cleanup preserves exact observed usage", async () => {
    const original = mocks.command.getMockImplementation()!;
    let first = true;
    mocks.command.mockImplementation(async (id: string, c: RegradeCommand) => {
      if (c.operation === "FINALIZE" && first) {
        first = false;
        throw new RegradeDenied("SERVICE_UNAVAILABLE");
      }
      return original(id, c);
    });
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.command.mock.calls[3][1]).toMatchObject({
      state: "FAILED",
      reason: "INTERNAL_ERROR",
      usage: observedUsage,
    });
  });
  it("runtime throwing without known usage cannot invent accounting", async () => {
    mocks.runtime.mockRejectedValue(new Error("transport"));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.command).toHaveBeenCalledTimes(2);
  });
  it("terminal cleanup failure remains unavailable", async () => {
    mocks.context.mockRejectedValue(new RegradeDenied("CONTEXT_CONFLICT"));
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(async (id: string, c: RegradeCommand) => {
      if (c.operation === "FINALIZE")
        throw new RegradeDenied("SERVICE_UNAVAILABLE");
      return original(id, c);
    });
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("rejects caller-selected marks before authorization", async () => {
    expect(await regradeControlledAssessment({ ...input, marks: [] })).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.actor).not.toHaveBeenCalled();
  });
  it("non-admin cannot reach provider or authority", async () => {
    mocks.actor.mockRejectedValue(new RegradeDenied("FORBIDDEN"));
    expect(await regradeControlledAssessment(input)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
