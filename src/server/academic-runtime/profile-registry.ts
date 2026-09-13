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
