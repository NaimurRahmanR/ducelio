import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import {
  SARAH_DB_CEILING,
  SARAH_PROVIDER_ROLE,
  SARAH_RUNTIME_PROFILE_REF,
  mapRuntimeResultToSarahFinalize,
  sarahReservationResultSchema,
  type SarahFinalizeCommand,
} from "@/domain/sarah";
import {
  SARAH_COURSE_GUIDANCE_CAPABILITY,
  buildSarahCourseGuidanceProviderContext,
  parseSarahCourseGuidanceOutput,
  resolveRecommendationCards,
  sarahCommercialContextResultSchema,
  sarahCourseGuidanceCapabilitiesFor,
  sarahCourseGuidanceFingerprintMaterial,
  type SarahCommercialContext,
  type SarahCourseGuidanceRequest,
  type SarahCourseGuidanceResult,
} from "@/domain/sarah-course-guidance";
import { requireStudentPrincipal } from "../identity";
import { createSupabase } from "../supabase";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";
import {
  SarahControllerDenied,
  attestSarahCourseGuidanceCommand,
  type SarahCourseGuidanceScope,
} from "./authority";

// AC-7: Sarah Mitchell course guidance. A PHYSICALLY SEPARATE path from the
// AC-5 learner-support guide (./index.ts): it reads only the commercial
// context projection (get_my_sarah_commercial_context) and never calls
// get_my_sarah_context, the proposal RPCs, or any support, counsellor,
// feedback, assessment/lab result, score or payment reader. The learner,
// mode, catalogue, prices, the learner's own enrolment state per offer and
// the commercial-context version are derived by the database.
//
// AUTHORIZE snapshot -> START re-check -> one provider call -> POST-PROVIDER
// re-check -> successful FINALIZE -> learner output. Provider text reaches
// the learner only when the commercial context is unchanged since START.
//
// Sarah only explains and suggests: this module calls no order, checkout,
// campaign, entitlement, enrolment or offer RPC. Recommendation cards are
// rendered from the verified authoritative projection by validated slug, and
// links go to the existing read-only course page. Nothing the learner writes
// and nothing Sarah replies or recommends is persisted.

class CourseGuidanceUnavailable extends Error {}
class CourseGuidanceRateLimited extends Error {}
class CourseGuidanceNotInMode extends Error {}

async function reserveCourseGuidance(
  request: SarahCourseGuidanceRequest,
): Promise<boolean> {
  const requestHash = createHash("sha256")
    .update(sarahCourseGuidanceFingerprintMaterial(request.message), "utf8")
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc("reserve_sarah_interaction", {
    p_idempotency_key: request.idempotencyKey,
    p_intent: request.intent,
    p_request_hash: requestHash,
  });
  if (error) throw new CourseGuidanceUnavailable();
  const parsed = sarahReservationResultSchema.safeParse(data);
  if (!parsed.success) throw new CourseGuidanceUnavailable();
  if (!parsed.data.ok)
    throw parsed.data.code === "RATE_LIMITED"
      ? new CourseGuidanceRateLimited()
      : parsed.data.code === "NOT_AVAILABLE_IN_MODE"
        ? new CourseGuidanceNotInMode()
        : new CourseGuidanceUnavailable();
  return !parsed.data.duplicate;
}

async function readSarahCommercialContext(): Promise<SarahCommercialContext> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_my_sarah_commercial_context");
  if (error) throw new CourseGuidanceUnavailable();
  const parsed = sarahCommercialContextResultSchema.safeParse(data);
  if (!parsed.success) throw new CourseGuidanceUnavailable();
  if (!parsed.data.ok)
    throw parsed.data.code === "NOT_AVAILABLE_IN_MODE"
      ? new CourseGuidanceNotInMode()
      : new CourseGuidanceUnavailable();
  return parsed.data;
}

function failureOutcome(error: unknown): SarahCourseGuidanceResult {
  if (error instanceof CourseGuidanceNotInMode)
    return { status: "NOT_AVAILABLE_IN_MODE" };
  if (error instanceof CourseGuidanceRateLimited)
    return { status: "RETRY_LATER" };
  return { status: "UNAVAILABLE" };
}

export async function executeSarahCourseGuidance(
  request: SarahCourseGuidanceRequest,
): Promise<SarahCourseGuidanceResult> {
  await requireStudentPrincipal();

  let proceed: boolean;
  try {
    proceed = await reserveCourseGuidance(request);
  } catch (error) {
    return failureOutcome(error);
  }
  if (!proceed) return { status: "DUPLICATE" };

  let context: SarahCommercialContext;
  try {
    context = await readSarahCommercialContext();
  } catch (error) {
    return failureOutcome(error);
  }

  // The same single platform profile as AC-5: no new model, budget or
  // retry because course guidance exists.
  const profile = resolvePlatformRuntimeProfile("COUNSELLOR");
  if (!profile || profile.ref !== SARAH_RUNTIME_PROFILE_REF)
    return { status: "UNAVAILABLE" };
  if (sarahCourseGuidanceCapabilitiesFor(context.mode).length === 0)
    return { status: "NOT_AVAILABLE_IN_MODE" };

  const scope: SarahCourseGuidanceScope = {
    executionId: randomUUID(),
    idempotencyKey: request.idempotencyKey,
    mode: context.mode,
    commercialFingerprint: context.commercialFingerprint,
  };
  const budget = {
    maxProviderCalls: SARAH_DB_CEILING.maxProviderCalls,
    maxOutputTokens: Math.min(
      profile.budgetPolicy.maxOutputTokens,
      SARAH_DB_CEILING.maxOutputTokens,
    ),
    maxEstimatedCostMicrousd: Math.min(
      profile.budgetPolicy.maxEstimatedCostMicrousd,
      SARAH_DB_CEILING.maxEstimatedCostMicrousd,
    ),
  };

  try {
    await attestSarahCourseGuidanceCommand(scope, {
      operation: "AUTHORIZE",
      budget,
    });
  } catch (error) {
    const code = error instanceof SarahControllerDenied ? error.code : "";
    return ["RATE_LIMITED", "CONTEXT_CONFLICT"].includes(code)
      ? { status: "RETRY_LATER" }
      : { status: "UNAVAILABLE" };
  }
  try {
    await attestSarahCourseGuidanceCommand(scope, { operation: "START" });
  } catch (error) {
    // START re-checks mode and the commercial-context version; a changed
    // catalogue, price, enrolment state or completion closes the execution
    // FAILED/POLICY_BLOCKED in the database and no provider call is made.
    return error instanceof SarahControllerDenied &&
      error.code === "CONTEXT_CONFLICT"
      ? { status: "RETRY_LATER" }
      : { status: "UNAVAILABLE" };
  }

  let result: RuntimeResult;
  try {
    result = await runGovernedProviderExecution(
      resolveAdapterForProfile(profile),
      {
        role: SARAH_PROVIDER_ROLE,
        capability: SARAH_COURSE_GUIDANCE_CAPABILITY,
        context: buildSarahCourseGuidanceProviderContext(
          context,
          request.message,
        ),
      },
      {
        ...profile.budgetPolicy,
        maxProviderCalls: budget.maxProviderCalls,
        maxOutputTokens: budget.maxOutputTokens,
        maxEstimatedCostMicrousd: budget.maxEstimatedCostMicrousd,
      },
    );
  } catch {
    result = {
      outcome: "FAILED",
      usage: zeroUsage(),
      reason: "PROVIDER_ERROR",
    };
  }

  // Strict, grounded output: every slug must be an offer the authorised
  // context showed as available for a new purchase. Anything else is
  // FAILED/OUTPUT_INVALID; nothing is repaired or fuzzily matched.
  const output =
    result.outcome === "SUCCEEDED"
      ? parseSarahCourseGuidanceOutput(result.response.outputText, context)
      : null;
  let finalize: SarahFinalizeCommand;
  try {
    finalize = mapRuntimeResultToSarahFinalize(result, output !== null);
  } catch {
    finalize = {
      state: "FAILED",
      reason: "INTERNAL_ERROR",
      budgetStage: null,
      usage: zeroUsage(),
    };
  }

  // Post-provider re-check (independent review, correction 1). Before any
  // successful FINALIZE and before any provider text can reach the learner,
  // the commercial context is read again, even when Sarah recommended
  // nothing. It must still be exactly the context START admitted: the same
  // course-guidance mode and the same commercial fingerprint. Otherwise the
  // whole answer (reply, reasons and cards) is suppressed and the
  // already-started execution is closed FAILED with the provider's real
  // usage: POLICY_BLOCKED for a changed context or mode, INTERNAL_ERROR when
  // the context cannot be read. No database lock is held across the
  // provider call, and no second provider call is made.
  let verified: SarahCommercialContext | null = null;
  let suppressed: SarahCourseGuidanceResult | null = null;
  if (finalize.state === "SUCCEEDED") {
    try {
      const fresh = await readSarahCommercialContext();
      if (
        fresh.mode === scope.mode &&
        fresh.commercialFingerprint === scope.commercialFingerprint
      )
        verified = fresh;
      else {
        suppressed = { status: "RETRY_LATER" };
        finalize = { ...finalize, state: "FAILED", reason: "POLICY_BLOCKED" };
      }
    } catch (error) {
      if (error instanceof CourseGuidanceNotInMode) {
        suppressed = { status: "NOT_AVAILABLE_IN_MODE" };
        finalize = { ...finalize, state: "FAILED", reason: "POLICY_BLOCKED" };
      } else {
        suppressed = { status: "RETRY_LATER" };
        finalize = { ...finalize, state: "FAILED", reason: "INTERNAL_ERROR" };
      }
    }
  }

  try {
    await attestSarahCourseGuidanceCommand(scope, {
      operation: "FINALIZE",
      ...finalize,
    });
  } catch {
    // No reply escapes unless the database confirmed the terminal state.
    return { status: "RETRY_LATER" };
  }
  if (suppressed) return suppressed;
  if (finalize.state !== "SUCCEEDED" || !output || !verified)
    return finalize.state === "ABSTAINED"
      ? { status: "UNAVAILABLE" }
      : { status: "RETRY_LATER" };

  // Authoritative cards from the VERIFIED post-provider projection, by
  // validated slug; never from model text.
  const { cards, unavailable } = resolveRecommendationCards(
    output.recommendations,
    verified,
  );
  return {
    status: "SUCCEEDED",
    reply: output.reply,
    recommendations: cards,
    unavailableRecommendations: unavailable,
  };
}
