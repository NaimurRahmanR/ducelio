import "server-only";
import {
  ProviderFailure,
  RETRYABLE_PROVIDER_FAILURES,
  runtimeBudgetPolicySchema,
  zeroUsage,
  type ProviderAdapter,
  type ProviderFailureCode,
  type RuntimeBudgetPolicy,
  type RuntimeResult,
  type RuntimeUsage,
} from "@/domain/academic-runtime";
import {
  isBehaviourRole,
  roleBaselineFor,
  type EffectiveAgentBehaviour,
} from "@/domain/agent-behaviour";

export type GovernedExecutionRequest = {
  role: string;
  capability: string;
  // Bounded, server-derived institutional context only — never arbitrary
  // caller/browser/course-package JSON. See src/server/academic-runtime/
  // index.ts for where this is actually constructed.
  context: Record<string, unknown>;
  // AC-2: server-resolved effective behaviour for teaching roles.
  behaviour?: EffectiveAgentBehaviour;
};

// Provider-neutral execution harness: admission, a single total deadline
// shared across every retry attempt, a pre-call hard ceiling on input
// context size, a requested (and post-call re-checked) output-token
// ceiling, bounded retry, cancellation, and usage accounting. A null
// adapter (no provider configured) fails closed to
// ABSTAINED/NO_PROVIDER_CONFIGURED before any network call. This function
// never authorizes a capability by itself; callers must independently
// authorize role/capability/activity/profile before invoking it (see
// executeRoleCapability in ./index.ts), and it is not yet composed into the
// production migration-022 execution RPC (see docs/15-academic-execution-
// governance.md for why raising that DB ceiling is a separate checkpoint).
//
// Monetary cost (maxEstimatedCostMicrousd) can only be known after a call
// returns, so its enforcement below is POST-CALL usage reconciliation, not
// a pre-call spending guarantee; a discarded over-budget response still had
// its real cost recorded, never hidden or "refunded".
export async function runGovernedProviderExecution(
  adapter: ProviderAdapter | null,
  request: GovernedExecutionRequest,
  policy: RuntimeBudgetPolicy,
  externalSignal?: AbortSignal,
): Promise<RuntimeResult> {
  const validPolicy = runtimeBudgetPolicySchema.parse(policy);
  const usage: RuntimeUsage = zeroUsage();
  const startedAt = Date.now();
  const deadlineAt = startedAt + validPolicy.totalDeadlineMs;
  const elapsed = () => Date.now() - startedAt;

  if (!adapter)
    return { outcome: "ABSTAINED", usage, reason: "NO_PROVIDER_CONFIGURED" };
  // AC-2: a teaching role executes only with the programme version's frozen
  // behaviour binding whose pinned role behaviour version this code has
  // reviewed text for. There is no fallback to the current code default.
  if (
    isBehaviourRole(request.role) &&
    (!request.behaviour ||
      !roleBaselineFor(request.role, request.behaviour.behaviourVersion))
  )
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  if (validPolicy.maxProviderCalls < 1)
    return { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" };

  // Pre-call hard ceiling: the size of the context we are about to send is
  // fully under server control, so it is enforced BEFORE any network call,
  // not discovered afterward.
  const contextBytes = Buffer.byteLength(
    JSON.stringify(request.context ?? {}),
    "utf8",
  );
  if (contextBytes > validPolicy.maxInputContextBytes)
    return { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" };

  if (externalSignal?.aborted) return { outcome: "CANCELLED", usage };

  let lastFailureCode: ProviderFailureCode | undefined;

  for (let attempt = 1; attempt <= validPolicy.maxAttempts; attempt++) {
    usage.attempts = attempt;
    if (usage.providerCalls >= validPolicy.maxProviderCalls) {
      usage.elapsedMs = elapsed();
      return { outcome: "BUDGET_BLOCKED", usage, stage: "PRE_CALL" };
    }
    if (externalSignal?.aborted) {
      usage.elapsedMs = elapsed();
      return { outcome: "CANCELLED", usage };
    }

    // One total deadline across every attempt: a retry only ever gets the
    // time remaining in the original window, never a fresh full window.
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      usage.elapsedMs = elapsed();
      return { outcome: "TIMEOUT", usage };
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await adapter.generate(
        {
          role: request.role,
          capability: request.capability,
          context: request.context,
          constraints: { maxOutputTokens: validPolicy.maxOutputTokens },
          ...(request.behaviour ? { behaviour: request.behaviour } : {}),
        },
        controller.signal,
      );
      usage.providerCalls += 1;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.estimatedCostMicrousd += response.usage.estimatedCostMicrousd;
      usage.elapsedMs = elapsed();

      // Post-call safety net: a provider is not guaranteed to honour the
      // requested output-token ceiling communicated above, and monetary
      // cost can only ever be known after the call. Usage is still
      // recorded for reconciliation even though the response itself is
      // discarded: an over-budget answer is never returned to a caller,
      // but its cost is never hidden either.
      if (
        response.usage.outputTokens > validPolicy.maxOutputTokens ||
        usage.estimatedCostMicrousd > validPolicy.maxEstimatedCostMicrousd
      ) {
        return { outcome: "BUDGET_BLOCKED", usage, stage: "POST_CALL" };
      }
      return { outcome: "SUCCEEDED", usage, response };
    } catch (error) {
      usage.providerCalls += 1;
      usage.elapsedMs = elapsed();
      if (externalSignal?.aborted) return { outcome: "CANCELLED", usage };
      if (controller.signal.aborted) return { outcome: "TIMEOUT", usage };
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure(
              "PROVIDER_ERROR",
              "Unexpected provider adapter failure.",
            );
      lastFailureCode = failure.code;
      if (
        !RETRYABLE_PROVIDER_FAILURES.has(failure.code) ||
        attempt >= validPolicy.maxAttempts ||
        deadlineAt - Date.now() <= 0
      ) {
        return { outcome: "FAILED", usage, reason: failure.code };
      }
      // Retryable, attempts remain and time remains: fall through to retry.
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
  return {
    outcome: "FAILED",
    usage,
    reason: lastFailureCode ?? "PROVIDER_ERROR",
  };
}
