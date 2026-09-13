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
// No profile ships enabled by default. Commercial V1 has not made a
// provider choice; this intentionally stays empty until a real provider has
// been separately reviewed, provisioned and added here under its own
// change. Until then every modelProfileRef fails closed.
const PRODUCTION_PROFILE_REGISTRY: Readonly<Record<string, RuntimeProfile>> =
  Object.freeze({});

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
