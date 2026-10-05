import { describe, expect, it } from "vitest";
import { runGovernedProviderExecution } from "@/server/academic-runtime/runtime";
import { DeterministicFakeProviderAdapter } from "@/server/academic-runtime/test-fake-provider";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type RuntimeBudgetPolicy,
} from "@/domain/academic-runtime";
import { defaultEffectiveBehaviour } from "@/domain/agent-behaviour";

const request = {
  role: "PROFESSOR",
  capability: "get_lesson_context",
  context: { lessonTitle: "Access Control" },
  behaviour: defaultEffectiveBehaviour("PROFESSOR"),
};

function successResponse(
  overrides: Partial<{
    inputTokens: number;
    outputTokens: number;
    estimatedCostMicrousd: number;
  }> = {},
) {
  return {
    kind: "success" as const,
    response: {
      outputText: "A deterministic test answer.",
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        estimatedCostMicrousd: 1000,
        ...overrides,
      },
    },
  };
}

describe("runGovernedProviderExecution", () => {
  it("refuses a teaching role without a reviewed frozen behaviour before any provider call (AC-2)", async () => {
    for (const behaviour of [
      undefined,
      { ...request.behaviour, behaviourVersion: "PROFESSOR_BEHAVIOUR_V2" },
      { ...request.behaviour, behaviourVersion: "TUTOR_BEHAVIOUR_V1" },
    ]) {
      const adapter = new DeterministicFakeProviderAdapter([successResponse()]);
      const result = await runGovernedProviderExecution(
        adapter,
        { ...request, behaviour },
        DEFAULT_RUNTIME_BUDGET_POLICY,
      );
      expect(result).toMatchObject({
        outcome: "ABSTAINED",
        reason: "POLICY_BLOCKED",
      });
      expect(result.usage.providerCalls).toBe(0);
    }
  });

  it("fails closed to ABSTAINED when no provider is configured", async () => {
    const result = await runGovernedProviderExecution(
      null,
      request,
      DEFAULT_RUNTIME_BUDGET_POLICY,
    );
    expect(result.outcome).toBe("ABSTAINED");
    if (result.outcome === "ABSTAINED")
      expect(result.reason).toBe("NO_PROVIDER_CONFIGURED");
  });

  it("succeeds through a deterministic test adapter and accounts usage", async () => {
    const adapter = new DeterministicFakeProviderAdapter([successResponse()]);
    const result = await runGovernedProviderExecution(
      adapter,
      request,
      DEFAULT_RUNTIME_BUDGET_POLICY,
    );
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.usage.providerCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(100);
    expect(result.usage.estimatedCostMicrousd).toBe(1000);
  });

  it("communicates the server-owned output-token ceiling to the adapter", async () => {
    const adapter = new DeterministicFakeProviderAdapter([successResponse()]);
    await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxOutputTokens: 321,
    });
    expect(adapter.lastRequest?.constraints.maxOutputTokens).toBe(321);
  });

  it("times out a hanging provider call", async () => {
    const adapter = new DeterministicFakeProviderAdapter([{ kind: "hang" }]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      totalDeadlineMs: 1000,
      maxAttempts: 1,
    });
    expect(result.outcome).toBe("TIMEOUT");
  }, 10000);

  it("reports CANCELLED when the caller aborts", async () => {
    const adapter = new DeterministicFakeProviderAdapter([{ kind: "hang" }]);
    const controller = new AbortController();
    const promise = runGovernedProviderExecution(
      adapter,
      request,
      DEFAULT_RUNTIME_BUDGET_POLICY,
      controller.signal,
    );
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe("CANCELLED");
  });

  it("retries a retryable failure and then succeeds", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      { kind: "failure", code: "PROVIDER_UNAVAILABLE" },
      successResponse(),
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxAttempts: 2,
      maxProviderCalls: 2,
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.usage.attempts).toBe(2);
    expect(result.usage.providerCalls).toBe(2);
  });

  it("never retries a non-retryable failure", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      { kind: "failure", code: "PROVIDER_INVALID_RESPONSE" },
      successResponse(),
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxAttempts: 3,
      maxProviderCalls: 3,
    });
    expect(result.outcome).toBe("FAILED");
    if (result.outcome === "FAILED")
      expect(result.reason).toBe("PROVIDER_INVALID_RESPONSE");
    expect(adapter.callCount).toBe(1);
  });

  it("exhausts bounded retries and reports the last failure", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      { kind: "failure", code: "PROVIDER_RATE_LIMITED" },
      { kind: "failure", code: "PROVIDER_RATE_LIMITED" },
      { kind: "failure", code: "PROVIDER_RATE_LIMITED" },
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxAttempts: 3,
      maxProviderCalls: 3,
    });
    expect(result.outcome).toBe("FAILED");
    if (result.outcome === "FAILED")
      expect(result.reason).toBe("PROVIDER_RATE_LIMITED");
    expect(adapter.callCount).toBe(3);
  });

  it("blocks pre-call admission when the budget allows zero provider calls", async () => {
    const adapter = new DeterministicFakeProviderAdapter([successResponse()]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxProviderCalls: 0,
    });
    expect(result.outcome).toBe("BUDGET_BLOCKED");
    if (result.outcome === "BUDGET_BLOCKED")
      expect(result.stage).toBe("PRE_CALL");
    expect(adapter.callCount).toBe(0);
  });

  it("blocks pre-call admission when the serialised context exceeds the hard byte ceiling", async () => {
    const adapter = new DeterministicFakeProviderAdapter([successResponse()]);
    const hugeRequest = {
      ...request,
      context: { blob: "x".repeat(20000) },
    };
    const result = await runGovernedProviderExecution(adapter, hugeRequest, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxInputContextBytes: 1000,
    });
    expect(result.outcome).toBe("BUDGET_BLOCKED");
    if (result.outcome === "BUDGET_BLOCKED")
      expect(result.stage).toBe("PRE_CALL");
    expect(adapter.callCount).toBe(0);
  });

  it("reconciles (post-call) when a response exceeds the output-token ceiling, keeping usage", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      successResponse({ outputTokens: 50000 }),
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxOutputTokens: 1000,
    });
    expect(result.outcome).toBe("BUDGET_BLOCKED");
    if (result.outcome === "BUDGET_BLOCKED")
      expect(result.stage).toBe("POST_CALL");
    // The over-budget call still happened once; usage reconciliation must
    // never silently drop the cost of a call whose answer was discarded.
    expect(result.usage.providerCalls).toBe(1);
    expect(result.usage.outputTokens).toBe(50000);
  });

  it("reconciles (post-call) the monetary cost budget, never a pre-call guarantee", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      successResponse({ estimatedCostMicrousd: 10_000_000 }),
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxEstimatedCostMicrousd: 50_000,
    });
    expect(result.outcome).toBe("BUDGET_BLOCKED");
    if (result.outcome === "BUDGET_BLOCKED")
      expect(result.stage).toBe("POST_CALL");
    expect(result.usage.estimatedCostMicrousd).toBe(10_000_000);
  });

  it("accumulates usage across retried attempts for reconciliation", async () => {
    const adapter = new DeterministicFakeProviderAdapter([
      { kind: "failure", code: "PROVIDER_TIMEOUT" },
      successResponse({
        inputTokens: 20,
        outputTokens: 30,
        estimatedCostMicrousd: 40,
      }),
    ]);
    const result = await runGovernedProviderExecution(adapter, request, {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      maxAttempts: 2,
      maxProviderCalls: 2,
    });
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.usage.providerCalls).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
  });

  it("uses one total deadline across every retry attempt rather than multiplying it", async () => {
    // Each attempt hangs for 700ms; with a 1000ms total deadline and up to
    // 3 attempts, a per-attempt (not shared) timeout would allow roughly
    // 2100ms total. The shared deadline must bound this to ~1000ms.
    const adapter = new DeterministicFakeProviderAdapter([
      { kind: "failure", code: "PROVIDER_UNAVAILABLE", delayMs: 700 },
      { kind: "failure", code: "PROVIDER_UNAVAILABLE", delayMs: 700 },
      { kind: "failure", code: "PROVIDER_UNAVAILABLE", delayMs: 700 },
    ]);
    const policy: RuntimeBudgetPolicy = {
      ...DEFAULT_RUNTIME_BUDGET_POLICY,
      totalDeadlineMs: 1000,
      maxAttempts: 3,
      maxProviderCalls: 3,
    };
    const started = Date.now();
    const result = await runGovernedProviderExecution(adapter, request, policy);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1600);
    expect(["FAILED", "TIMEOUT"]).toContain(result.outcome);
  }, 10000);
});
