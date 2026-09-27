import "server-only";
import type { ProviderAdapter } from "@/domain/academic-runtime";
import type { AgentRole } from "@/domain/academic-capability-policy";
import {
  PLATFORM_ROLE_PROFILE_REF,
  type PlatformAgentRole,
} from "@/domain/platform-ai-policy";
import {
  ROLE_RUNTIME_PROFILE_POLICY,
  type RuntimeProfile,
} from "@/domain/academic-runtime-profile";
import {
  resolveAnthropicMessagesProvider,
  resolveConfiguredProvider,
  resolveOpenAIResponsesProvider,
} from "./provider";

// PR22 keeps the already-reviewed role/profile references and all database
// admission contracts unchanged. Only this server-owned registry decides
// which provider/model/tariff an admitted profile resolves to. A course,
// learner, browser or stored agent configuration can reference the permitted
// profile id only; none can select a vendor, model, endpoint, key or tariff.
const PRODUCTION_PROFILE_REGISTRY: Readonly<Record<string, RuntimeProfile>> =
  Object.freeze({
    PROFESSOR_COMMERCIAL_V1: Object.freeze({
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: Object.freeze({
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 2_000_000,
          outputMicrousdPerMillionTokens: 12_000_000,
          reviewedAt: "2026-09-18",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 16_000,
        maxOutputTokens: 900,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 50_000,
      }),
    }),
    TUTOR_COMMERCIAL_V1: Object.freeze({
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: Object.freeze({
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 200_000,
          outputMicrousdPerMillionTokens: 1_200_000,
          reviewedAt: "2026-09-18",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
      }),
    }),
    LAB_INSTRUCTOR_COMMERCIAL_V1: Object.freeze({
      ref: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      adapterKind: "ANTHROPIC_MESSAGES",
      providerConfig: Object.freeze({
        model: "claude-sonnet-5",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 2_000_000,
          outputMicrousdPerMillionTokens: 10_000_000,
          reviewedAt: "2026-09-18",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 40_000,
      }),
    }),
    COUNSELLOR_PLATFORM_V1: Object.freeze({
      ref: "COUNSELLOR_PLATFORM_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: Object.freeze({
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 200_000,
          outputMicrousdPerMillionTokens: 1_200_000,
          reviewedAt: "2026-09-18",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 500,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 10_000,
      }),
    }),
    OPERATIONS_ENGINEER_PLATFORM_V1: Object.freeze({
      ref: "OPERATIONS_ENGINEER_PLATFORM_V1",
      adapterKind: "ANTHROPIC_MESSAGES",
      providerConfig: Object.freeze({
        model: "claude-opus-5-5",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 4_000_000,
          outputMicrousdPerMillionTokens: 20_000_000,
          reviewedAt: "2026-09-27",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 64_000,
        maxOutputTokens: 1200,
        totalDeadlineMs: 20_000,
        maxEstimatedCostMicrousd: 100_000,
      }),
    }),
    EXAMINER_COMMERCIAL_V1: Object.freeze({
      ref: "EXAMINER_COMMERCIAL_V1",
      adapterKind: "OPENAI_RESPONSES",
      providerConfig: Object.freeze({
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        tariff: Object.freeze({
          inputMicrousdPerMillionTokens: 200_000,
          outputMicrousdPerMillionTokens: 1_200_000,
          reviewedAt: "2026-09-18",
        }),
      }),
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 128_000,
        maxOutputTokens: 1200,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 50_000,
      }),
    }),
  });

export function resolveRuntimeProfile(
  ref: string | null,
  registry: Readonly<
    Record<string, RuntimeProfile>
  > = PRODUCTION_PROFILE_REGISTRY,
): RuntimeProfile | null {
  if (!ref) return null;
  return registry[ref] ?? null;
}

export function resolveAdapterForProfile(
  profile: RuntimeProfile,
): ProviderAdapter | null {
  switch (profile.adapterKind) {
    case "OPENAI_RESPONSES":
      return resolveOpenAIResponsesProvider(profile.providerConfig);
    case "ANTHROPIC_MESSAGES":
      return resolveAnthropicMessagesProvider(profile.providerConfig);
    case "HTTP_JSON":
      return resolveConfiguredProvider();
    case "TEST_DETERMINISTIC":
      return null;
  }
}

export function resolveRoleBoundRuntimeProfile(
  role: AgentRole,
  ref: string | null,
  resolveInRegistry: (ref: string) => RuntimeProfile | null = (r) =>
    resolveRuntimeProfile(r),
): RuntimeProfile | null {
  const policy = ROLE_RUNTIME_PROFILE_POLICY[role];
  if (!policy.providerBacked) return null;
  let effectiveRef: string;
  if (ref === null) {
    if (policy.nullBehavior !== "DEFAULT_TO_ROLE_PROFILE" || !policy.allowedRef)
      return null;
    effectiveRef = policy.allowedRef;
  } else if (ref === policy.allowedRef) {
    effectiveRef = ref;
  } else {
    return null;
  }
  return resolveInRegistry(effectiveRef);
}

export function resolvePlatformRuntimeProfile(
  role: PlatformAgentRole,
  resolveInRegistry: (ref: string) => RuntimeProfile | null = (ref) =>
    resolveRuntimeProfile(ref),
): RuntimeProfile | null {
  return resolveInRegistry(PLATFORM_ROLE_PROFILE_REF[role]);
}
