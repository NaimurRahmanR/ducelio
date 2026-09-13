import { z } from "zod";

// B2 provider-neutral AI runtime foundation. Pure domain module: no node
// built-ins, no vendor SDK, no database access. This describes the shape of
// a bounded, server-governed provider call; it never becomes institutional
// truth on its own and is not yet spliced into the production B1 execution
// RPC (migration 022), whose admitted envelope remains zero provider calls
// until a dedicated, separately reviewed migration raises that ceiling. See
// docs/15-academic-execution-governance.md for why that boundary is
// deliberate, and docs/implementation-progress.md for exactly what remains.
export const ACADEMIC_RUNTIME_POLICY = "ACADEMIC_RUNTIME_V1" as const;

export const providerFailureCodeSchema = z.enum([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_REFUSED",
  "PROVIDER_ERROR",
]);
export type ProviderFailureCode = z.infer<typeof providerFailureCodeSchema>;

// Only transient, plausibly-transient failures are retried. A malformed
// response or an explicit refusal is never retried: retrying cannot fix a
// deterministic response shape, and a refusal is a provider decision, not a
// network blip.
export const RETRYABLE_PROVIDER_FAILURES: ReadonlySet<ProviderFailureCode> =
  new Set([
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_TIMEOUT",
    "PROVIDER_RATE_LIMITED",
  ]);

export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderFailure";
  }
}

// Reviewed, server-owned ceilings for one execution, resolved only from a
// runtime/model profile (src/domain/academic-runtime-profile.ts) — never
// accepted from a browser, a course package, or stored agent configuration.
//
// Pre-call HARD ceilings (enforced before any provider call, because the
// server controls the request it is about to send):
//   - maxProviderCalls, maxAttempts
//   - maxInputContextBytes: a byte-length ceiling on the serialised
//     server-derived context, as a measurable proxy for input size. This is
//     not an exact token count; no tokenizer is wired in yet.
//   - maxOutputTokens: communicated to the adapter as the provider's
//     requested generation ceiling (see ProviderAdapter.generate). The
//     runtime also re-checks it after the call as a safety net, because an
//     adapter/provider is not guaranteed to honour a requested ceiling.
//   - totalDeadlineMs: ONE deadline for the whole execution, shared across
//     every retry attempt. Attempts never multiply this window.
//
// POST-CALL usage RECONCILIATION only (cannot be known before the call):
//   - maxEstimatedCostMicrousd: monetary cost depends on what a provider
//     actually reports; this is reconciled after each call, never promised
//     as a pre-call guarantee. A future profile with deterministic
//     per-token pricing could add a defensible pre-call upper-bound
//     estimate, but none exists yet, so none is claimed.
export const runtimeBudgetPolicySchema = z.strictObject({
  maxProviderCalls: z.number().int().min(0).max(5),
  maxAttempts: z.number().int().min(1).max(3),
  maxInputContextBytes: z.number().int().min(0).max(800000),
  maxOutputTokens: z.number().int().min(0).max(200000),
  totalDeadlineMs: z.number().int().min(1000).max(20000),
  maxEstimatedCostMicrousd: z.number().int().min(0).max(5_000_000),
});
export type RuntimeBudgetPolicy = z.infer<typeof runtimeBudgetPolicySchema>;

// A conservative default mirroring the 20-second B1 execution ceiling
// (migration 022). Used only by tests; production callers always resolve a
// profile-specific policy through the server-owned registry.
export const DEFAULT_RUNTIME_BUDGET_POLICY: RuntimeBudgetPolicy = Object.freeze(
  {
    maxProviderCalls: 1,
    maxAttempts: 2,
    maxInputContextBytes: 16000,
    maxOutputTokens: 1000,
    totalDeadlineMs: 15000,
    maxEstimatedCostMicrousd: 50_000,
  },
);

export const runtimeUsageSchema = z.strictObject({
  providerCalls: z.number().int().min(0),
  attempts: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCostMicrousd: z.number().int().min(0),
  elapsedMs: z.number().int().min(0),
});
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;

export function zeroUsage(): RuntimeUsage {
  return {
    providerCalls: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostMicrousd: 0,
    elapsedMs: 0,
  };
}

export const runtimeOutcomeSchema = z.enum([
  "SUCCEEDED",
  "FAILED",
  "ABSTAINED",
  "ESCALATED",
  "BUDGET_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
]);
export type RuntimeOutcome = z.infer<typeof runtimeOutcomeSchema>;

export const runtimeAbstentionReasonSchema = z.enum([
  "NO_PROVIDER_CONFIGURED",
  "UNKNOWN_MODEL_PROFILE",
  "NO_EXECUTION_PATH",
  "POLICY_BLOCKED",
  "ACTIVITY_BLOCKED",
]);
export type RuntimeAbstentionReason = z.infer<
  typeof runtimeAbstentionReasonSchema
>;

// The provider receives only bounded, server-derived institutional context
// (an existing academic capability's validated output) plus the server-
// owned generation constraints below. It never receives arbitrary caller/
// browser/course-package JSON; the composition boundary in
// src/server/academic-runtime/index.ts is responsible for constructing
// `context` exclusively from a reviewed capability's own output schema.
export type RuntimeProviderRequest = {
  role: string;
  capability: string;
  context: Record<string, unknown>;
  constraints: { maxOutputTokens: number };
};

export type ProviderUsageReport = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrousd: number;
};
export type ProviderResponse = {
  outputText: string;
  usage: ProviderUsageReport;
};

// Provider-neutral adapter port. No vendor SDK is part of this interface:
// an implementation owns its own transport (HTTP, gRPC, a future SDK). The
// server owns admission, budget, timeout, retry and accounting around it;
// the adapter itself never makes an authorization decision.
export interface ProviderAdapter {
  readonly name: string;
  generate(
    request: RuntimeProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderResponse>;
}

export type RuntimeResult =
  | { outcome: "SUCCEEDED"; usage: RuntimeUsage; response: ProviderResponse }
  | { outcome: "FAILED"; usage: RuntimeUsage; reason: ProviderFailureCode }
  | {
      outcome: "ABSTAINED";
      usage: RuntimeUsage;
      reason: RuntimeAbstentionReason;
    }
  | { outcome: "ESCALATED"; usage: RuntimeUsage; reviewPath: "ACADEMIC_REVIEW" }
  // `stage` distinguishes a pre-call hard-admission refusal (no provider
  // call was made) from a post-call usage-reconciliation refusal (a call
  // was made and its usage is recorded even though the response is
  // discarded). Neither is a claim that cost was "prevented" once a call
  // has actually happened; POST_CALL is reconciliation, not prevention.
  | {
      outcome: "BUDGET_BLOCKED";
      usage: RuntimeUsage;
      stage: "PRE_CALL" | "POST_CALL";
    }
  | { outcome: "TIMEOUT"; usage: RuntimeUsage }
  | { outcome: "CANCELLED"; usage: RuntimeUsage };
