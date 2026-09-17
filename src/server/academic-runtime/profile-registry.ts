import "server-only";
import type { ProviderAdapter } from "@/domain/academic-runtime";
import type { AgentRole } from "@/domain/academic-capability-policy";
import {
  ROLE_RUNTIME_PROFILE_POLICY,
  type RuntimeProfile,
} from "@/domain/academic-runtime-profile";
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
    // EXAMINER_COMMERCIAL_V1: the one reviewed, code-owned Commercial V1
    // production profile for governed Examiner grading (PR11B1, migration
    // 202609160031, COMMERCIAL_V1_EXAMINER_V1). A structurally separate
    // surface from Professor/Tutor/Lab -- HTTP_JSON only, no vendor SDK.
    // PR16A (migration 036): normal learner-initiated INITIAL Examiner
    // grading now reads the programme-version EXAMINER academic_agent_configs
    // row at the database's own AUTHORIZE boundary -- but EXAMINER's role
    // policy (src/domain/academic-runtime-profile.ts,
    // ROLE_RUNTIME_PROFILE_POLICY.EXAMINER) fixes allowedRef to exactly this
    // ref with DEFAULT_TO_ROLE_PROFILE null behavior, so a stored config can
    // only ever admit this exact entry (null defaults to it; any other
    // non-null ref fails closed as UNKNOWN_MODEL_PROFILE) -- never a
    // different role's profile. The regrade plane
    // (src/server/commercial-v1-examiner-regrade) remains fixed-profile and
    // out of PR16A's scope; it still always uses this exact entry directly.
    EXAMINER_COMMERCIAL_V1: Object.freeze({
      ref: "EXAMINER_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
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

// PR16A: the single reviewed role-bound resolution mechanism. Consults the
// DOMAIN-owned ROLE_RUNTIME_PROFILE_POLICY (src/domain/academic-runtime-
// profile.ts) to reject a cross-role ref and apply the role's own null
// semantics BEFORE ever touching the registry, then resolves only the
// role's permitted ref through it -- registry ownership of adapterKind/
// budgetPolicy is unchanged; this function only decides WHICH ref (if any)
// the registry may be asked to resolve for this role. Returns null for
// COUNSELLOR unconditionally (providerBacked=false: no Counsellor provider
// execution is ever added by this function). `resolveInRegistry` defaults
// to the real code-owned registry lookup but stays overridable so the
// existing DI seam (src/server/academic-runtime/index.ts's ProfileResolver)
// keeps working unchanged: role-binding is decided here, purely, before the
// injected/production registry lookup ever runs.
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
