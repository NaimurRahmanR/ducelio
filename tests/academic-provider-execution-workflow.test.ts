import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  getDeliveryAgentAccess: vi.fn(),
  withValidatedProfessorContent: vi.fn(),
  attestProviderExecutionCommand: vi.fn(),
  closeUnstartedProviderExecution: vi.fn(),
}));
// AC-2: the learner-scoped Level-3 behaviour read resolves to the
// code-owned default here; its own authority is tested in
// agent-behaviour-db.test.ts.
vi.mock("@/server/agent-behaviour-config", async () => {
  const behaviour = await import("@/domain/agent-behaviour");
  return {
    getAgentBehaviourForEnrolment: vi.fn(
      async (
        _enrolmentId: string,
        role: "PROFESSOR" | "TUTOR" | "LAB_INSTRUCTOR",
      ) => behaviour.defaultEffectiveBehaviour(role),
    ),
  };
});
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/academic-agent-config", () => ({
  getAgentConfigForEnrolment: mocks.getAgentConfigForEnrolment,
}));
vi.mock("@/server/delivery", () => ({
  getDeliveryAgentAccess: mocks.getDeliveryAgentAccess,
}));
vi.mock("@/server/academic-capabilities", () => ({
  withValidatedProfessorContent: mocks.withValidatedProfessorContent,
}));
vi.mock("@/server/academic-provider-execution/authority", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/academic-provider-execution/authority")
  >("@/server/academic-provider-execution/authority");
  return {
    ProviderExecutionDenied: actual.ProviderExecutionDenied,
    attestProviderExecutionCommand: mocks.attestProviderExecutionCommand,
    closeUnstartedProviderExecution: mocks.closeUnstartedProviderExecution,
  };
});

import { executeRoleCapabilityWithTestOverrides } from "@/server/academic-runtime";
import { DeterministicFakeProviderAdapter } from "@/server/academic-runtime/test-fake-provider";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import { ProviderExecutionDenied } from "@/server/academic-provider-execution/authority";
import { PROVIDER_EXECUTION_DB_CEILING } from "@/domain/academic-provider-execution";

const enrolmentId = "00000000-0000-4000-8000-000000000001";
const lessonId = "00000000-0000-4000-8000-000000000002";
const fakeRelease = {
  release_id: "release-1",
  student_id: "student-1",
  invocation_id: "invocation-1",
};

// PR16A: Professor's role-bound resolution now requires the exact code-owned
// ref (domain ROLE_RUNTIME_PROFILE_POLICY.PROFESSOR.allowedRef) before this
// test-injected resolveProfile callback is ever reached at all -- see
// src/server/academic-runtime/profile-registry.ts's
// resolveRoleBoundRuntimeProfile. Every profile/config fixture below is
// therefore keyed under this exact literal; the fixture's own budgetPolicy
// (not its ref string) is what each test actually varies.
const testProfile: RuntimeProfile = {
  ref: "PROFESSOR_COMMERCIAL_V1",
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
};
const testRegistry = { PROFESSOR_COMMERCIAL_V1: testProfile };
function resolveTestProfile(ref: string | null) {
  return ref ? (testRegistry[ref as keyof typeof testRegistry] ?? null) : null;
}

function availableAccess() {
  return {
    enrolmentId,
    PROFESSOR: "AVAILABLE" as const,
    TUTOR: "AVAILABLE" as const,
    LAB_INSTRUCTOR: "AVAILABLE" as const,
    EXAMINER: "ASSESSMENT_CONTROLLED" as const,
    COUNSELLOR: "AVAILABLE" as const,
  };
}
function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
    capabilities: ["get_lesson_context"],
    escalationPolicy: "NONE",
    ...overrides,
  };
}
function successAdapter() {
  return new DeterministicFakeProviderAdapter([
    {
      kind: "success",
      response: {
        outputText: "ok",
        usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicrousd: 10 },
      },
    },
  ]);
}
const request = () => ({
  enrolmentId,
  role: "PROFESSOR" as const,
  capability: "get_lesson_context",
  lessonId,
});

// Mirrors tests/academic-runtime-composition.test.ts's mockGateway helper:
// simulates withValidatedProfessorContent's real contract (does the callback
// run at all? what does the gateway's own final result/
// releaseFinalizationFailed end up being once the callback returns?).
function mockGateway(options: {
  callsConsume: boolean;
  data?: unknown;
  resultOk: boolean;
  errorCode?: string;
  releaseFinalizationFailed?: boolean;
  events?: string[];
}) {
  return vi.fn(
    async (_request: unknown, consume?: (ctx: unknown) => Promise<void>) => {
      options.events?.push("gateway-release-open");
      if (options.callsConsume && consume) {
        await consume({ release: fakeRelease, data: options.data });
      }
      options.events?.push("gateway-release-close");
      return {
        result: options.resultOk
          ? { ok: true, data: options.data, provenance: {} }
          : {
              ok: false,
              error: {
                code: options.errorCode ?? "POLICY_BLOCKED",
                message: "denied",
              },
              provenance: {},
            },
        releaseFinalizationFailed: options.releaseFinalizationFailed ?? false,
      };
    },
  );
}

describe("V2 provider-backed execution composition (executeRoleCapabilityWithTestOverrides)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      displayName: "Student",
      roles: ["STUDENT"],
    });
    mocks.getDeliveryAgentAccess.mockResolvedValue(availableAccess());
  });

  it("AUTHORIZE and START happen inside the release callback, strictly before the provider is called; FINALIZE happens strictly after the gateway call returns", async () => {
    const events: string[] = [];
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => {
        events.push(`attest-${command.operation.toLowerCase()}`);
        return {
          state:
            command.operation === "AUTHORIZE"
              ? "AUTHORIZED"
              : command.operation === "START"
                ? "RUNNING"
                : "SUCCEEDED",
        };
      },
    );
    const adapter = successAdapter();
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId, content: "x" },
        resultOk: true,
        events,
      }),
    );

    const originalGenerate = adapter.generate.bind(adapter);
    adapter.generate = (async (
      ...args: Parameters<typeof originalGenerate>
    ) => {
      events.push("provider-call");
      return originalGenerate(...args);
    }) as typeof adapter.generate;

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => adapter,
    });

    expect(result.outcome).toBe("SUCCEEDED");
    expect(events).toEqual([
      "gateway-release-open",
      "attest-authorize",
      "attest-start",
      "provider-call",
      "gateway-release-close",
      "attest-finalize",
    ]);
  });

  it("provider is never called on failed admission (AUTHORIZE denied)", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => {
        if (command.operation === "AUTHORIZE")
          throw new ProviderExecutionDenied("BUDGET_BLOCKED");
        throw new Error("should not reach " + command.operation);
      },
    );
    const adapter = successAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => adapter,
    });

    expect(generateSpy).not.toHaveBeenCalled();
    // A definitive AUTHORIZE refusal admitted nothing, so nothing is
    // abandoned (migration 064).
    expect(mocks.closeUnstartedProviderExecution).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    // Only AUTHORIZE was ever attempted -- no FINALIZE cleanup call, since
    // AUTHORIZE's own denial already commits a fully terminal BLOCKED row.
    expect(mocks.attestProviderExecutionCommand).toHaveBeenCalledTimes(1);
  });

  it("a profile whose own budgetPolicy requests zero provider calls never even reaches AUTHORIZE", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    const adapter = successAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const zeroCallsRegistry = {
      PROFESSOR_COMMERCIAL_V1: {
        ...testProfile,
        ref: "PROFESSOR_COMMERCIAL_V1",
        budgetPolicy: { ...DEFAULT_RUNTIME_BUDGET_POLICY, maxProviderCalls: 0 },
      },
    };
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: (ref) =>
        ref
          ? ((zeroCallsRegistry as Record<string, RuntimeProfile>)[ref] ?? null)
          : null,
      resolveAdapter: () => adapter,
    });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "BUDGET_BLOCKED",
      stage: "PRE_CALL",
    });
  });

  it("clamps a profile's proposed budget to the DB-owned hard ceiling rather than ever proposing more", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
    );
    const generousProfile: RuntimeProfile = {
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: {
        ...DEFAULT_RUNTIME_BUDGET_POLICY,
        maxProviderCalls: 5,
        maxOutputTokens: 200_000,
        maxEstimatedCostMicrousd: 5_000_000,
      },
    };
    let proposedBudget: unknown;
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string; budget?: unknown },
      ) => {
        if (command.operation === "AUTHORIZE") proposedBudget = command.budget;
        return {
          state:
            command.operation === "AUTHORIZE"
              ? "AUTHORIZED"
              : command.operation === "START"
                ? "RUNNING"
                : "SUCCEEDED",
        };
      },
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );

    await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: (ref) =>
        ref === "PROFESSOR_COMMERCIAL_V1" ? generousProfile : null,
      resolveAdapter: () => successAdapter(),
    });

    expect(proposedBudget).toEqual({
      maxProviderCalls: PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls,
      maxOutputTokens: PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
      maxEstimatedCostMicrousd:
        PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    });
  });

  it("BLOCKER 1: the provider adapter itself is asked for the DB-capped output-token ceiling, never a generous profile's own larger value", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
    );
    const generousProfile: RuntimeProfile = {
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: {
        ...DEFAULT_RUNTIME_BUDGET_POLICY,
        maxProviderCalls: 5,
        maxOutputTokens: 200_000,
        maxEstimatedCostMicrousd: 5_000_000,
      },
    };
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => ({
        state:
          command.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : command.operation === "START"
              ? "RUNNING"
              : "SUCCEEDED",
      }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const adapter = successAdapter();

    await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: (ref) =>
        ref === "PROFESSOR_COMMERCIAL_V1" ? generousProfile : null,
      resolveAdapter: () => adapter,
    });

    // Not the profile's own 200,000 -- the DB-admitted 4,000 ceiling, exactly
    // what AUTHORIZE proposed and the database actually admitted for this
    // execution. The runtime harness, not just the AUTHORIZE proposal, must
    // be bounded by the admitted V2 envelope.
    expect(adapter.lastRequest?.constraints.maxOutputTokens).toBe(
      PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
    );
    expect(adapter.lastRequest?.constraints.maxOutputTokens).not.toBe(
      generousProfile.budgetPolicy.maxOutputTokens,
    );
  });

  it("BLOCKER 1: a post-call cost within a generous profile's own ceiling but above the admitted V2 ceiling is BUDGET_BLOCKED/POST_CALL with truthful usage, never a nominal SUCCEEDED", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
    );
    const generousProfile: RuntimeProfile = {
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: {
        ...DEFAULT_RUNTIME_BUDGET_POLICY,
        maxProviderCalls: 3,
        maxOutputTokens: 4000,
        // Comfortably above PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd
        // (200,000): if runGovernedProviderExecution were still given this
        // profile's own policy (the pre-fix bug), a reported cost of
        // 250,000 would be accepted as SUCCEEDED, because it is still under
        // this profile's own 5,000,000 ceiling.
        maxEstimatedCostMicrousd: 5_000_000,
      },
    };
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => ({
        state:
          command.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : command.operation === "START"
              ? "RUNNING"
              : "BUDGET_BLOCKED",
      }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const overBudgetAdapter = new DeterministicFakeProviderAdapter([
      {
        kind: "success",
        response: {
          outputText: "expensive",
          usage: {
            inputTokens: 50,
            outputTokens: 100,
            estimatedCostMicrousd: 250_000, // over the DB's 200,000 ceiling
          },
        },
      },
    ]);

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: (ref) =>
        ref === "PROFESSOR_COMMERCIAL_V1" ? generousProfile : null,
      resolveAdapter: () => overBudgetAdapter,
    });

    expect(result).toMatchObject({
      outcome: "BUDGET_BLOCKED",
      stage: "POST_CALL",
      usage: {
        providerCalls: 1,
        inputTokens: 50,
        outputTokens: 100,
        estimatedCostMicrousd: 250_000,
      },
    });
    expect(result).not.toHaveProperty("response");
    const finalizeCall = mocks.attestProviderExecutionCommand.mock.calls.find(
      ([, , command]) => command.operation === "FINALIZE",
    );
    expect(finalizeCall?.[2]).toMatchObject({
      state: "BUDGET_BLOCKED",
      budgetStage: "POST_CALL",
      usage: { estimatedCostMicrousd: 250_000 },
    });
  });

  it("critical success rule: a release-finalization failure discards a genuinely SUCCEEDED provider response", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => ({
        state:
          command.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : command.operation === "START"
              ? "RUNNING"
              : "FAILED",
      }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
        releaseFinalizationFailed: true,
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => successAdapter(),
    });

    expect(result.outcome).not.toBe("SUCCEEDED");
    expect(result).not.toHaveProperty("response");
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
      // BLOCKER 3: real providerCalls/tokens/cost already consumed by the
      // successAdapter() call above must not disappear from the returned
      // RuntimeResult merely because the response itself is discarded.
      usage: {
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 10,
      },
    });
    const finalizeCall = mocks.attestProviderExecutionCommand.mock.calls.find(
      ([, , command]) => command.operation === "FINALIZE",
    );
    expect(finalizeCall?.[2]).toMatchObject({
      operation: "FINALIZE",
      state: "FAILED",
      reason: "CONTENT_RELEASE_UNAVAILABLE",
      usage: { providerCalls: 1, inputTokens: 10, outputTokens: 10 },
    });
  });

  it("critical success rule: the gateway's own final ACTIVITY_BLOCKED recheck discards a genuinely SUCCEEDED provider response", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => ({
        state:
          command.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : command.operation === "START"
              ? "RUNNING"
              : "FAILED",
      }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: false,
        errorCode: "ACTIVITY_BLOCKED",
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => successAdapter(),
    });

    expect(result).not.toHaveProperty("response");
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "ACTIVITY_BLOCKED",
      // BLOCKER 3: same usage-preservation rule as the release-finalization
      // failure case above.
      usage: {
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 10,
      },
    });
    const finalizeCall = mocks.attestProviderExecutionCommand.mock.calls.find(
      ([, , command]) => command.operation === "FINALIZE",
    );
    expect(finalizeCall?.[2]).toMatchObject({
      state: "FAILED",
      reason: "ACTIVITY_BLOCKED",
      usage: { providerCalls: 1, inputTokens: 10, outputTokens: 10 },
    });
  });

  it("critical success rule: FINALIZE persistence failure discards a genuinely SUCCEEDED provider response rather than fabricating success", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => {
        if (command.operation === "FINALIZE")
          throw new ProviderExecutionDenied("SERVICE_UNAVAILABLE");
        return {
          state: command.operation === "AUTHORIZE" ? "AUTHORIZED" : "RUNNING",
        };
      },
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => successAdapter(),
    });

    // The provider itself genuinely succeeded, but the durable FINALIZE
    // confirmation could not be established -- fail closed, never a
    // fabricated success. BLOCKER 3: the real usage it consumed is still
    // truthfully returned even though it was never durably persisted.
    expect(result).not.toHaveProperty("response");
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
      usage: {
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 10,
      },
    });
  });

  it("critical success rule: a FINALIZE that returns a different confirmed state than requested discards success", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => {
        if (command.operation === "FINALIZE")
          // The DB independently decided TIMEOUT instead of the requested SUCCEEDED.
          return { state: "TIMEOUT" };
        return {
          state: command.operation === "AUTHORIZE" ? "AUTHORIZED" : "RUNNING",
        };
      },
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => successAdapter(),
    });

    expect(result.outcome).not.toBe("SUCCEEDED");
    expect(result).not.toHaveProperty("response");
    // BLOCKER 3: the mismatch case preserves real usage too.
    expect(result).toMatchObject({
      usage: {
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 10,
      },
    });
  });

  it("only once FINALIZE durably confirms SUCCEEDED does the real provider response escape", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string },
      ) => ({
        state:
          command.operation === "AUTHORIZE"
            ? "AUTHORIZED"
            : command.operation === "START"
              ? "RUNNING"
              : "SUCCEEDED",
      }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => successAdapter(),
    });

    expect(result).toMatchObject({
      outcome: "SUCCEEDED",
      response: { outputText: "ok" },
    });
  });

  it("BLOCKER 2: a genuine RuntimeResult TIMEOUT (not the DB's lazy-expiry sweep) is truthfully FINALIZEd as FAILED/EXECUTION_TIMEOUT rather than leaving the execution stuck RUNNING", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "PROFESSOR_COMMERCIAL_V1" }),
    );
    const fastDeadlineProfile: RuntimeProfile = {
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      // The schema's own minimum (runtimeBudgetPolicySchema requires
      // totalDeadlineMs >= 1000): short enough to genuinely elapse in this
      // test without an artificial clock override, forcing
      // runGovernedProviderExecution to itself produce outcome "TIMEOUT"
      // (never reachable via the DB's separate lazy-expiry sweep, which
      // this test does not exercise at all).
      budgetPolicy: { ...DEFAULT_RUNTIME_BUDGET_POLICY, totalDeadlineMs: 1000 },
    };
    const finalizeCalls: unknown[] = [];
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string; state?: string },
      ) => {
        if (command.operation === "FINALIZE") finalizeCalls.push(command);
        return {
          state:
            command.operation === "AUTHORIZE"
              ? "AUTHORIZED"
              : command.operation === "START"
                ? "RUNNING"
                : // Confirms exactly what was requested -- FAILED, not a
                  // rejection -- proving the FINALIZE call is accepted
                  // (never INVALID_INPUT) rather than leaving the row RUNNING.
                  command.state,
        };
      },
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const hangingAdapter = new DeterministicFakeProviderAdapter([
      { kind: "hang" },
    ]);

    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: (ref) =>
        ref === "PROFESSOR_COMMERCIAL_V1" ? fastDeadlineProfile : null,
      resolveAdapter: () => hangingAdapter,
    });

    // The RETURNED RuntimeResult preserves the real TS-level outcome...
    expect(result.outcome).toBe("TIMEOUT");
    expect(result).not.toHaveProperty("response");
    // ...while the DB-facing FINALIZE call truthfully reports it using
    // migration 025's own bounded vocabulary (FAILED/EXECUTION_TIMEOUT,
    // never a bare, unmapped "TIMEOUT" state FINALIZE does not accept).
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]).toMatchObject({
      operation: "FINALIZE",
      state: "FAILED",
      reason: "EXECUTION_TIMEOUT",
      budgetStage: null,
    });
  }, 10000);

  it.each(["TUTOR", "LAB_INSTRUCTOR", "EXAMINER", "COUNSELLOR"] as const)(
    "%s still has no reviewed V2 execution path regardless of stored configuration",
    async (role) => {
      mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
      const result = await executeRoleCapabilityWithTestOverrides(
        { ...request(), role },
        {
          resolveProfile: resolveTestProfile,
          resolveAdapter: () => successAdapter(),
        },
      );
      expect(result).toMatchObject({
        outcome: "ABSTAINED",
        reason: "NO_EXECUTION_PATH",
      });
      expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
      expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
    },
  );

  it("paused/withdrawn/completed delivery lifecycle still prevents any V2 admission or provider call", async () => {
    mocks.getDeliveryAgentAccess.mockResolvedValue({
      ...availableAccess(),
      PROFESSOR: "ACTIVITY_BLOCKED",
    });
    const adapter = successAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");
    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => adapter,
    });
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "ACTIVITY_BLOCKED",
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
  });

  it("unknown model profile fails before any provider call or V2 admission", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ modelProfileRef: "does-not-exist" }),
    );
    const adapter = successAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");
    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => adapter,
    });
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "UNKNOWN_MODEL_PROFILE",
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
  });

  it("a disabled agent configuration fails before any provider call or V2 admission", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ enabled: false }),
    );
    const adapter = successAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");
    const result = await executeRoleCapabilityWithTestOverrides(request(), {
      resolveProfile: resolveTestProfile,
      resolveAdapter: () => adapter,
    });
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
  });
});
