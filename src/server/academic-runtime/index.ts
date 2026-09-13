import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  zeroUsage,
  type ProviderAdapter,
  type RuntimeBudgetPolicy,
  type RuntimeResult,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import {
  PROVIDER_EXECUTION_DB_CEILING,
  providerExecutionBudgetProposalSchema,
  mapRuntimeResultToFinalizeCommand,
} from "@/domain/academic-provider-execution";
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
import { professorClassroomInteractionSchema } from "@/domain/professor-classroom";
import { requireStudentPrincipal } from "../identity";
import { getAgentConfigForEnrolment } from "../academic-agent-config";
import { getDeliveryAgentAccess } from "../delivery";
import { withValidatedProfessorContent } from "../academic-capabilities";
import type { AcademicContentRelease } from "../academic-content-release";
import {
  attestProviderExecutionCommand,
  ProviderExecutionDenied,
} from "../academic-provider-execution/authority";
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
  // Narrow, reviewed extension for the Commercial V1 Professor classroom
  // (src/server/professor-classroom.ts): an OPTIONAL, strictly-typed
  // interaction descriptor. This is not a general "extra JSON" escape
  // hatch — professorClassroomInteractionSchema is a closed
  // z.discriminatedUnion of exactly two shapes (BEGIN_LESSON, or
  // LEARNER_QUESTION carrying only the one reviewed bounded-plain-text
  // learnerMessage field), so arbitrary caller JSON still can never reach
  // provider context. Every other existing caller (that never supplies
  // this field) is completely unaffected: it is appended to the provider
  // context only when present, alongside the capability's own validated
  // output, never in place of it.
  interaction: professorClassroomInteractionSchema.optional(),
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
// The ONLY role+capability combination a classroom `interaction` may ever
// be attached to (src/server/professor-classroom.ts never constructs a
// request with `interaction` for anything else, but this boundary does not
// trust that -- it re-derives and enforces the constraint itself,
// independent of any caller). This is deliberately not a second classroom
// capability: it is the single existing, reviewed get_lesson_context read,
// with lessonId as its only selector -- objectiveId must be absent, since
// it is never a valid selector for this capability and its presence would
// mean a caller is trying to use it as an alternate one.
const CLASSROOM_INTERACTION_CAPABILITY: CapabilityName = "get_lesson_context";

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

  // Correction pass (independent review): a classroom `interaction` is
  // semantically valid ONLY for role PROFESSOR, capability EXACTLY
  // get_lesson_context, with lessonId present and objectiveId absent (never
  // used as an alternate selector). This is checked and refused HERE,
  // before capabilityInput is even assembled and long before
  // withValidatedProfessorContent, the provider adapter, or migration 025's
  // AUTHORIZE/START/FINALIZE governance are ever reached — an interaction
  // supplied against any other capability fails closed with zero provider
  // calls and zero execution attestation, not merely a refusal deep inside
  // that path.
  if (payload.interaction) {
    const boundToReviewedClassroomCapability =
      payload.role === "PROFESSOR" &&
      capabilityName.data === CLASSROOM_INTERACTION_CAPABILITY &&
      payload.lessonId !== undefined &&
      payload.objectiveId === undefined;
    if (!boundToReviewedClassroomCapability) {
      return { outcome: "ABSTAINED", usage, reason: "NO_EXECUTION_PATH" };
    }
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

  // The DB-owned V2 hard ceiling (migration 025) always wins: propose the
  // SMALLER of what this profile's own budgetPolicy allows and what the
  // database will ever admit. This can only narrow a request, never widen
  // one — the database independently re-enforces these same maximums as
  // table CHECK constraints regardless of what is proposed here, so a
  // compromised/corrupt request can never raise the admitted envelope.
  const proposedBudget = {
    maxProviderCalls: Math.min(
      profile.budgetPolicy.maxProviderCalls,
      PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls,
    ),
    maxOutputTokens: Math.min(
      profile.budgetPolicy.maxOutputTokens,
      PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
    ),
    maxEstimatedCostMicrousd: Math.min(
      profile.budgetPolicy.maxEstimatedCostMicrousd,
      PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    ),
  };
  // A profile that itself admits zero of any of these (a valid, if
  // degenerate, runtimeBudgetPolicySchema shape) can never satisfy V2's
  // AUTHORIZE, which structurally requires a nonzero bounded budget
  // (migration 025). Recognising that here avoids an avoidable DB
  // round-trip; the outcome is identical to what AUTHORIZE would itself
  // report (BUDGET_BLOCKED, PRE_CALL — no provider call was made).
  const budgetParsed =
    proposedBudget.maxProviderCalls >= 1 &&
    proposedBudget.maxOutputTokens >= 1 &&
    proposedBudget.maxEstimatedCostMicrousd >= 1
      ? providerExecutionBudgetProposalSchema.safeParse(proposedBudget)
      : null;

  // Provider execution happens INSIDE the consumer callback, while the
  // original academic-content release this exact gateway call begins is
  // still open — never after it closes, and never a second release.
  // AUTHORIZE and START (migration 025's DB-owned V2 governance) also
  // happen in here, strictly before any provider call, so a failed
  // admission never reaches the provider at all. The outcome is captured
  // in this closure; it is trusted only once the surrounding gateway call
  // (final principal/activity recheck AND release finalization, both of
  // which happen strictly after this callback returns) has itself
  // succeeded — see the checks immediately below. Crucially, FINALIZE
  // (which durably reconciles usage and terminalizes the V2 execution) is
  // deliberately NOT called in here: it only happens after this callback
  // returns and the release has already closed, so SUCCEEDED can never be
  // persisted before that closure succeeds (the Critical Success Rule).
  let providerResult: RuntimeResult | null = null;
  let providerExecutionId: string | null = null;
  let providerExecutionStarted = false;
  let providerExecutionAuthorized = false;
  let capturedRelease: AcademicContentRelease | null = null;
  // Real providerCalls/tokens/cost already consumed must not disappear from
  // the returned RuntimeResult merely because the response itself is
  // discarded on a later failure path: this always reflects the actual
  // provider usage captured so far, never the zero placeholder, once a
  // provider call may have happened.
  function lastKnownUsage() {
    return providerResult ? providerResult.usage : usage;
  }
  const outcome = await withValidatedProfessorContent(
    { capability: capabilityName.data, input: capabilityInput },
    async ({ release, data }) => {
      capturedRelease = release;
      if (!budgetParsed || !budgetParsed.success) {
        providerResult = {
          outcome: "BUDGET_BLOCKED",
          usage,
          stage: "PRE_CALL",
        };
        return;
      }
      providerExecutionId = randomUUID();
      try {
        await attestProviderExecutionCommand(providerExecutionId, release, {
          operation: "AUTHORIZE",
          budget: budgetParsed.data,
        });
        providerExecutionAuthorized = true;
        await attestProviderExecutionCommand(providerExecutionId, release, {
          operation: "START",
        });
        providerExecutionStarted = true;
        // The provider context is the capability's own validated, bounded
        // output — never payload/browser/course-package JSON — with the
        // caller's optional, strictly-typed interaction descriptor appended
        // only when present (see requestSchema above). This is the only
        // place in the whole boundary where "context" is assembled.
        const context = {
          capability: capabilityName.data,
          data,
          ...(payload.interaction ? { interaction: payload.interaction } : {}),
        };
        // The runtime harness must never be given more room than the V2
        // execution was actually admitted for: reuse the profile's own
        // budgetPolicy for everything NOT re-negotiated at AUTHORIZE
        // (maxAttempts, maxInputContextBytes, totalDeadlineMs), but replace
        // maxProviderCalls/maxOutputTokens/maxEstimatedCostMicrousd with the
        // exact capped values the DB just admitted (`budgetParsed.data`) —
        // never the profile's own, possibly larger, originals. A generous
        // profile can therefore never cause the provider to be asked for
        // more output tokens, calls or cost headroom than
        // academic_provider_executions actually recorded as admitted.
        const effectiveRuntimePolicy: RuntimeBudgetPolicy = {
          ...profile.budgetPolicy,
          maxProviderCalls: budgetParsed.data.maxProviderCalls,
          maxOutputTokens: budgetParsed.data.maxOutputTokens,
          maxEstimatedCostMicrousd: budgetParsed.data.maxEstimatedCostMicrousd,
        };
        providerResult = await runGovernedProviderExecution(
          adapter,
          { role: payload.role, capability: payload.capability, context },
          effectiveRuntimePolicy,
        );
      } catch (error) {
        // AUTHORIZE/START denials are ordinary, bounded outcomes here
        // (rate limits, an out-of-envelope proposal, an activity/policy
        // change mid-flight, expiry) — never an exception that should abort
        // an otherwise-valid content release. A genuinely unexpected error
        // (not ProviderExecutionDenied) is rethrown below unchanged.
        if (!(error instanceof ProviderExecutionDenied)) throw error;
        providerResult = {
          outcome: "ABSTAINED",
          usage,
          reason:
            error.code === "ACTIVITY_BLOCKED"
              ? "ACTIVITY_BLOCKED"
              : "POLICY_BLOCKED",
        };
        // If AUTHORIZE itself was admitted but a later step failed without
        // the database already having closed the execution out on its own
        // (databaseTerminal), the row would otherwise dangle AUTHORIZED
        // until it lazily expires. Best-effort cleanup; a failure here is
        // not itself surfaced, since the DB-owned timeout policy remains
        // the backstop (never a fabricated terminal success).
        if (providerExecutionAuthorized && !error.databaseTerminal) {
          try {
            await attestProviderExecutionCommand(providerExecutionId, release, {
              operation: "FINALIZE",
              state: "FAILED",
              reason: "INTERNAL_ERROR",
              budgetStage: null,
              usage: zeroUsage(),
            });
          } catch {
            // Lazy DB-owned expiry remains the backstop.
          }
        }
      }
    },
  );

  // Best-effort cleanup used only by the two release/gateway failure paths
  // below, where a V2 execution may have reached RUNNING (a real provider
  // call may have happened) but the surrounding release itself did not
  // survive to let the normal FINALIZE path run. Swallows its own failure:
  // the DB-owned timeout policy remains the backstop either way, and both
  // call sites already return ABSTAINED regardless of whether this cleanup
  // succeeds.
  async function finalizeProviderExecutionAfterRelease(
    state: "FAILED",
    reason:
      "CONTENT_RELEASE_UNAVAILABLE" | "ACTIVITY_BLOCKED" | "POLICY_BLOCKED",
  ) {
    if (!providerExecutionStarted || !providerExecutionId || !capturedRelease)
      return;
    try {
      await attestProviderExecutionCommand(
        providerExecutionId,
        capturedRelease,
        {
          operation: "FINALIZE",
          state,
          reason,
          budgetStage: null,
          usage: lastKnownUsage(),
        },
      );
    } catch {
      // Lazy DB-owned expiry remains the backstop.
    }
  }

  // Release finalization failure discards any provider output outright,
  // even if the provider call itself succeeded inside the callback above.
  // The execution's own real usage (if a provider call actually happened)
  // is still durably reconciled below — never hidden — but no success can
  // escape this boundary. The RETURNED RuntimeResult must also carry that
  // same real usage rather than the zero placeholder: real providerCalls/
  // tokens/cost already consumed must not disappear merely because the
  // response itself is discarded.
  if (outcome.releaseFinalizationFailed) {
    await finalizeProviderExecutionAfterRelease(
      "FAILED",
      "CONTENT_RELEASE_UNAVAILABLE",
    );
    return {
      outcome: "ABSTAINED",
      usage: lastKnownUsage(),
      reason: "POLICY_BLOCKED",
    };
  }
  // The gateway's own final principal/activity recheck (which runs after
  // the callback returns and before the release closes) failing also
  // discards any provider output, for the same reason: content validity is
  // re-proven only up to that recheck, not merely at the moment the
  // callback captured it. Same usage-preservation rule as above.
  if (!outcome.result.ok) {
    const activityBlocked = outcome.result.error.code === "ACTIVITY_BLOCKED";
    await finalizeProviderExecutionAfterRelease(
      "FAILED",
      activityBlocked ? "ACTIVITY_BLOCKED" : "POLICY_BLOCKED",
    );
    return {
      outcome: "ABSTAINED",
      usage: lastKnownUsage(),
      reason: activityBlocked ? "ACTIVITY_BLOCKED" : "POLICY_BLOCKED",
    };
  }
  // The callback never produced a result at all (should not happen once
  // outcome.result.ok is true, but fail closed rather than assume).
  if (!providerResult) {
    return { outcome: "ABSTAINED", usage, reason: "POLICY_BLOCKED" };
  }
  // No V2 execution was ever authorized/started (admission was denied, or
  // the profile's own budget could never satisfy AUTHORIZE) — nothing to
  // durably terminalize; the bounded abstention captured above is already
  // the whole truth.
  if (!providerExecutionStarted || !providerExecutionId || !capturedRelease) {
    return providerResult;
  }

  // Durably reconcile the ACTUAL captured usage and terminalize the V2
  // execution now — strictly after the release above has already closed
  // successfully. This is the only place a SUCCEEDED provider response can
  // ever escape this boundary, and only once this FINALIZE call itself is
  // confirmed by the database. mapRuntimeResultToFinalizeCommand strictly
  // validates the real usage against the durable ledger's own schema
  // (never silently clamping it) and is deliberately called INSIDE this
  // try block: an impossible usage value must fail this FINALIZE attempt
  // exactly like any other persistence uncertainty below, never send a
  // falsified number, and never fabricate a terminal success either way.
  try {
    const finalizeCommand = mapRuntimeResultToFinalizeCommand(providerResult);
    const snapshot = await attestProviderExecutionCommand(
      providerExecutionId,
      capturedRelease,
      { operation: "FINALIZE", ...finalizeCommand },
    );
    if (snapshot.state !== finalizeCommand.state) {
      // The database did not confirm the exact outcome requested (it may
      // have independently forced a different terminal state, e.g. a
      // lazily-discovered timeout). Never let a mismatched success escape,
      // but the RETURNED usage still reflects what the provider actually
      // consumed — it does not vanish because the outcome is uncertain.
      return {
        outcome: "ABSTAINED",
        usage: lastKnownUsage(),
        reason: "POLICY_BLOCKED",
      };
    }
  } catch {
    // FINALIZE itself could not be durably confirmed: fail closed rather
    // than fabricate a terminal success. The row may still resolve later
    // under the DB-owned timeout policy; no successful response escapes
    // under this uncertainty, even though a real provider call already
    // happened and consumed real usage — which the returned RuntimeResult
    // still truthfully carries, even though it was never durably persisted.
    return {
      outcome: "ABSTAINED",
      usage: lastKnownUsage(),
      reason: "POLICY_BLOCKED",
    };
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
