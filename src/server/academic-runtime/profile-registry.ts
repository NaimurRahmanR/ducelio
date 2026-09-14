import "server-only";
import type { ProviderAdapter } from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import { resolveConfiguredProvider } from "./provider";

// Server-owned, code-only registry of reviewed runtime/model profiles. This
// is NOT a database table and NOT reachable from any course-package or
// agent-configuration content: adding a profile here is itself the review
// gate, exactly like adding a migration is for schema. A stored
// `modelProfileRef` is only ever a lookup key into this object; it cannot
// inject a URL, credential or budget of its own (see
// src/domain/academic-runtime-profile.ts).
//
// PROFESSOR_COMMERCIAL_V1 is the one reviewed, code-owned Commercial V1
// production profile: HTTP_JSON (the existing generic, provider-neutral
// adapter -- no vendor SDK, no OpenAI/Anthropic/Google-specific dependency)
// with a deliberately conservative budget policy, comfortably inside
// migration 025's DB-owned V2 hard ceiling (1..3 calls, 1..4000 output
// tokens, 1..200000 micro-USD) so AUTHORIZE never has to narrow it further.
// Adding a profile here IS the review gate, exactly like adding a
// migration is for schema; a stored modelProfileRef is only ever a lookup
// key into this object (src/domain/academic-runtime-profile.ts) and can
// never itself supply a provider endpoint, credential or budget. Whether
// any enrolment's academic-agent configuration actually references this
// ref remains a separate, existing admin decision (set_agent_config); this
// registry only decides what such a reference COULD resolve to.
//
// resolveConfiguredProvider() below still independently fails closed to
// null (NO_PROVIDER_CONFIGURED) whenever ACADEMIC_PROVIDER_BASE_URL or
// ACADEMIC_PROVIDER_API_KEY is missing or malformed -- adding this profile
// does not, by itself, make any live provider call possible.
// TUTOR_COMMERCIAL_V1 / LAB_INSTRUCTOR_COMMERCIAL_V1: the two reviewed
// Commercial V1 production profiles for Tutor/Lab support (migration 028,
// TUTOR_LAB_EXECUTION_V1). Each has its own reviewed role binding and
// budget, deliberately NOT a semantic reuse of PROFESSOR_COMMERCIAL_V1 --
// every value is comfortably inside migration 028's DB-owned ceiling
// (maxProviderCalls fixed at 1; 1..2000 output tokens; 1..100000 micro-USD)
// so AUTHORIZE never has to narrow it further. Conservative and slightly
// tighter than Professor's profile: Tutor/Lab responses are bounded
// learner-support guidance, not a full lesson explanation.
//
// Correction pass (independent review, truth-sync): maxAttempts is 1, not
// 2. runGovernedProviderExecution (src/server/academic-runtime/runtime.ts)
// increments usage.providerCalls on every attempt (success or failure) and
// refuses to start a further attempt once providerCalls>=maxProviderCalls,
// checked BEFORE that attempt's own call -- so with maxProviderCalls fixed
// at 1, a second attempt could never actually reach the provider regardless
// of what maxAttempts said. maxAttempts=1 makes the profile state honestly
// what it does: exactly one provider call, no retry. (PROFESSOR_COMMERCIAL_V1
// above predates this finding and is Professor's own existing, separately
// reviewed profile -- unrelated to this checkpoint and left unchanged.)
const PRODUCTION_PROFILE_REGISTRY: Readonly<Record<string, RuntimeProfile>> =
  Object.freeze({
    PROFESSOR_COMMERCIAL_V1: Object.freeze({
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 2,
        maxInputContextBytes: 16_000,
        maxOutputTokens: 900,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 40_000,
      }),
    }),
    TUTOR_COMMERCIAL_V1: Object.freeze({
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
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
      adapterKind: "HTTP_JSON",
      budgetPolicy: Object.freeze({
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
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

// Resolves the adapter a profile's kind implies. TEST_DETERMINISTIC never
// resolves anything here — a test must inject its own deterministic adapter
// explicitly through the separate executeRoleCapabilityWithTestOverrides
// entrypoint's `resolveAdapter` override (which itself refuses to run
// under NODE_ENV=production) rather than this module ever constructing or
// returning one. executeRoleCapability, the production entrypoint, has no
// such option at all.
export function resolveAdapterForProfile(
  profile: RuntimeProfile,
): ProviderAdapter | null {
  if (profile.adapterKind === "HTTP_JSON") return resolveConfiguredProvider();
  return null;
}
