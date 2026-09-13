import "server-only";
import { z } from "zod";
import {
  zeroUsage,
  type ProviderAdapter,
  type RuntimeResult,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import {
  agentRoleSchema,
  isCapabilityAuthorized,
  type AgentRole,
} from "@/domain/academic-agent-config";
import {
  capabilityNameSchema,
  type CapabilityName,
} from "@/domain/academic-capabilities";
import { DeliveryDenied } from "@/domain/delivery";
import { requireStudentPrincipal } from "../identity";
import { getAgentConfigForEnrolment } from "../academic-agent-config";
import { getDeliveryAgentAccess } from "../delivery";
import { withValidatedProfessorContent } from "../academic-capabilities";
import {
  resolveAdapterForProfile,
  resolveRuntimeProfile,
} from "./profile-registry";
import { runGovernedProviderExecution } from "./runtime";

// The reusable composition boundary for a future role runtime:
// authenticated learner -> Academy OS authority (existing 2A delivery
// agent-access lifecycle) -> validated role/course configuration ->
// code-owned capability authorization (catalogue AND configuration) ->
// server-owned runtime/model profile -> the existing academic-capability
// gateway, which begins ITS OWN content release, retrieves bounded
// Academy OS data, and hands it to a consumer callback -> provider
// execution happens INSIDE that callback, while the release is still
// active -> the gateway rechecks principal/activity and finalizes the
// release -> only once all of that succeeds does provider output escape
// this module. It never forwards arbitrary caller JSON as provider
// context, writes no LearningEvidence/mastery/grade/institutional record,
// and is NOT invoked by any route, Server Action or UI surface in this
// checkpoint — see docs/implementation-progress.md for why composing this
// into the live migration-022 execution RPC remains a separate checkpoint.
//
// Only PROFESSOR has a reviewed, bounded, server-owned capability/context
// builder today (the existing PROFESSOR_READ_V2 gateway). TUTOR,
// LAB_INSTRUCTOR, EXAMINER and COUNSELLOR have no such builder with correct
// provenance yet, so every request for those roles fails closed with
// NO_EXECUTION_PATH regardless of stored configuration — a placeholder
// capability-catalogue entry is never treated as a live execution path.
const requestSchema = z.strictObject({
  enrolmentId: z.uuid(),
  role: agentRoleSchema,
  capability: z.string().trim().min(1).max(80),
  // The only other caller-supplied selectors this boundary accepts, both
  // bounded identifiers rather than free-form content. Which (if either) a
  // given capability actually requires is fixed, reviewed vocabulary below
  // — never inferred from arbitrary caller JSON.
  lessonId: z.uuid().optional(),
  objectiveId: z.uuid().optional(),
});
export type RoleCapabilityRequest = z.infer<typeof requestSchema>;

const ROLES_WITH_REVIEWED_EXECUTION_PATH: ReadonlySet<AgentRole> = new Set([
  "PROFESSOR",
]);
// get_actor_context/get_activity_permissions are not academicRead: the
// existing gateway has no content release to hold open for them (it would
// itself refuse a consumer callback here), so there is no reviewed
// execution path for provider generation built on them. This check is
// explicit rather than relying on the gateway's own refusal as the primary
// signal.
const EMPTY_INPUT_CAPABILITIES: ReadonlySet<CapabilityName> = new Set([
  "get_actor_context",
  "get_activity_permissions",
]);
const LESSON_SCOPED_CAPABILITIES: ReadonlySet<CapabilityName> = new Set([
  "get_lesson_context",
  "get_lesson_objectives",
  "get_learning_resources",
  "get_current_mastery_state",
]);

type ProfileResolver = (ref: string | null) => RuntimeProfile | null;
type AdapterResolver = (profile: RuntimeProfile) => ProviderAdapter | null;

// Internal core. Deliberately not exported: the only two ways to reach it
// are the production entrypoint below (which always wires the code-owned
// registry, with no override parameter at all) and the test-only
// entrypoint (which is itself fail-closed under NODE_ENV=production). No
// caller can reach this function, or its `deps`, any other way.
async function executeRoleCapabilityCore(
  request: unknown,
  deps: { resolveProfile: ProfileResolver; resolveAdapter: AdapterResolver },
): Promise<RuntimeResult> {
  await requireStudentPrincipal();
  const payload = requestSchema.parse(request);
  const usage = zeroUsage();

  if (!ROLES_WITH_REVIEWED_EXECUTION_PATH.has(payload.role)) {
    return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
  }

  // 2A institutional delivery lifecycle is the authority on whether this
  // role may operate for this enrolment at all (ACTIVE vs
  // paused/withdrawn/completed, and the existing controlled-assessment
  // activity firewall). This is the same check getProfessorDeliveryContext
  // already performs; it is not a parallel lifecycle invented here.
  let access;
  try {
    access = await getDeliveryAgentAccess({ enrolmentId: payload.enrolmentId });
  } catch (error) {
    if (error instanceof DeliveryDenied && error.code === "ACTIVITY_BLOCKED")
      return { outcome: "ABSTAINED", usage, reason: "ACTIVITY_BLOCKED" };
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  if (access.PROFESSOR === "ACTIVITY_BLOCKED")
    return { outcome: "ABSTAINED", usage, reason: "ACTIVITY_BLOCKED" };
  if (access.PROFESSOR !== "AVAILABLE")
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };

  const config = await getAgentConfigForEnrolment(
    payload.enrolmentId,
    payload.role,
  );
  if (!config.enabled) {
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  // Both the code-owned role catalogue AND the stored configuration must
  // independently permit this exact capability. Neither source alone is
  // ever sufficient, so a stale/over-broad configuration row can never
  // widen execution beyond the current reviewed catalogue.
  if (
    !isCapabilityAuthorized(
      payload.role,
      payload.capability,
      config.capabilities,
    )
  ) {
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  if (config.escalationPolicy === "ACADEMIC_REVIEW") {
    return { outcome: "ESCALATED", usage, reviewPath: "ACADEMIC_REVIEW" };
  }

  // A missing, null or unknown model profile fails closed before any
  // provider call. A course/agent configuration can only reference a
  // profile by name; it cannot itself define a provider endpoint,
  // credential or budget (src/domain/academic-runtime-profile.ts).
  const profile = deps.resolveProfile(config.modelProfileRef);
  if (!profile) {
    return { outcome: "ABSTAINED", usage, reason: "UNKNOWN_MODEL_PROFILE" };
  }

  const capabilityName = capabilityNameSchema.safeParse(payload.capability);
  if (!capabilityName.success) {
    return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
  }
  if (EMPTY_INPUT_CAPABILITIES.has(capabilityName.data)) {
    return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
  }

  // The capability's own input schema — never a generic caller-supplied
  // JSON blob — decides exactly which bounded selector fields it receives.
  let capabilityInput: Record<string, unknown>;
  if (LESSON_SCOPED_CAPABILITIES.has(capabilityName.data)) {
    if (!payload.lessonId)
      return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
    capabilityInput = {
      enrolmentId: payload.enrolmentId,
      lessonId: payload.lessonId,
    };
  } else if (capabilityName.data === "get_permitted_learning_history") {
    capabilityInput = payload.objectiveId
      ? { enrolmentId: payload.enrolmentId, objectiveId: payload.objectiveId }
      : { enrolmentId: payload.enrolmentId };
  } else {
    // get_current_learner_context, get_current_class_session
    capabilityInput = { enrolmentId: payload.enrolmentId };
  }

  const adapter = deps.resolveAdapter(profile);

  // Provider execution happens INSIDE the consumer callback, while the
  // original academic-content release this exact gateway call begins is
  // still open — never after it closes, and never a second release. The
  // outcome is captured in this closure; it is trusted only once the
  // surrounding gateway call (final principal/activity recheck AND release
  // finalization, both of which happen strictly after this callback
  // returns) has itself succeeded. See the checks immediately below.
  let providerResult: RuntimeResult | null = null;
  const outcome = await withValidatedProfessorContent(
    { capability: capabilityName.data, input: capabilityInput },
    async ({ data }) => {
      // The provider context is the capability's own validated, bounded
      // output — never payload/browser/course-package JSON. This is the
      // only place in the whole boundary where "context" is assembled.
      const context = { capability: capabilityName.data, data };
      providerResult = await runGovernedProviderExecution(
        adapter,
        { role: payload.role, capability: payload.capability, context },
        profile.budgetPolicy,
      );
    },
  );

  // Release finalization failure discards any provider output outright,
  // even if the provider call itself succeeded inside the callback above.
  if (outcome.releaseFinalizationFailed) {
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  // The gateway's own final principal/activity recheck (which runs after
  // the callback returns and before the release closes) failing also
  // discards any provider output, for the same reason: content validity is
  // re-proven only up to that recheck, not merely at the moment the
  // callback captured it.
  if (!outcome.result.ok) {
    if (outcome.result.error.code === "ACTIVITY_BLOCKED")
      return { outcome: "ABSTAINED", usage, reason: "ACTIVITY_BLOCKED" };
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  // The callback never ran (capability/release denied before reaching it,
  // e.g. CONTEXT_CONFLICT surfaced some other way): zero provider calls,
  // nothing to return.
  if (!providerResult) {
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  return providerResult;
}

// PRODUCTION entrypoint. This signature has no override parameter at all —
// dependency injection is structurally impossible to reach here, not
// merely discouraged by convention. It always resolves through the
// code-owned runtime/model-profile registry
// (src/server/academic-runtime/profile-registry.ts).
export async function executeRoleCapability(
  request: unknown,
): Promise<RuntimeResult> {
  return executeRoleCapabilityCore(request, {
    resolveProfile: resolveRuntimeProfile,
    resolveAdapter: resolveAdapterForProfile,
  });
}

// TEST-ONLY entrypoint. Refuses to run under NODE_ENV=production — exactly
// like DeterministicFakeProviderAdapter (./test-fake-provider.ts) — so an
// injected adapter/profile resolver can never take effect in production
// even if some future code path mistakenly imported and called this
// outside a test. This is enforced at call time, not merely by naming or
// comment convention.
export async function executeRoleCapabilityWithTestOverrides(
  request: unknown,
  overrides: {
    resolveProfile?: ProfileResolver;
    resolveAdapter?: AdapterResolver;
  } = {},
): Promise<RuntimeResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "executeRoleCapabilityWithTestOverrides must never run in production.",
    );
  }
  return executeRoleCapabilityCore(request, {
    resolveProfile: overrides.resolveProfile ?? resolveRuntimeProfile,
    resolveAdapter: overrides.resolveAdapter ?? resolveAdapterForProfile,
  });
}

export { resolveConfiguredProvider } from "./provider";
export { runGovernedProviderExecution } from "./runtime";
export {
  resolveAdapterForProfile,
  resolveRuntimeProfile,
} from "./profile-registry";
