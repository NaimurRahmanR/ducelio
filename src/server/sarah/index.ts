import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { zeroUsage, type RuntimeResult } from "@/domain/academic-runtime";
import type { CounsellorMode } from "@/domain/platform-ai-policy";
import {
  SARAH_DB_CEILING,
  SARAH_PROVIDER_CAPABILITY,
  SARAH_PROVIDER_ROLE,
  SARAH_RUNTIME_PROFILE_REF,
  buildSarahProviderContext,
  changedProposalFields,
  mapRuntimeResultToSarahFinalize,
  parseSarahOutput,
  sarahCapabilitiesFor,
  sarahContextResultSchema,
  sarahDecisionRequestSchema,
  sarahDecisionResultSchema,
  sarahInteractionFingerprintMaterial,
  sarahProposalListSchema,
  sarahReservationResultSchema,
  type LearnerSarahProposal,
  type SarahContext,
  type SarahFinalizeCommand,
  type SarahGuideResult,
  type SarahProposal,
  type SarahProposalOutcome,
  type SarahRequest,
  type SupportProfileView,
} from "@/domain/sarah";
import { requireStudentPrincipal } from "../identity";
import { createSupabase } from "../supabase";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
} from "../academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "../academic-runtime/runtime";
import {
  SarahControllerDenied,
  SarahProposalRefused,
  attestSarahExecutionCommand,
  recordSarahProfileProposal,
  type SarahExecutionScope,
} from "./authority";

// AC-5: the single governed entrypoint for Sarah Mitchell, Ducelio's AI
// learner-success counsellor (platform COUNSELLOR, COUNSELLOR_PLATFORM_V1).
//
// It never reads academic agent configuration, behaviour bindings, the
// academic COUNSELLOR row, counsellor assignments as authority, human
// counsellor interactions, or any Professor, Tutor/Lab or Examiner record.
// The learner, mode and profile version are derived by the database; the
// browser supplies only the intent, message and idempotency key. Nothing
// the learner writes and nothing Sarah replies is persisted.

class SarahUnavailable extends Error {}
// The database's bounded new-reservation admission refused this request.
class SarahReservationRateLimited extends Error {}

async function reserveInteraction(request: SarahRequest): Promise<boolean> {
  const requestHash = createHash("sha256")
    .update(
      sarahInteractionFingerprintMaterial(request.intent, request.message),
      "utf8",
    )
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc("reserve_sarah_interaction", {
    p_idempotency_key: request.idempotencyKey,
    p_intent: request.intent,
    p_request_hash: requestHash,
  });
  if (error) throw new SarahUnavailable();
  const parsed = sarahReservationResultSchema.safeParse(data);
  if (!parsed.success) throw new SarahUnavailable();
  // A conflicting reuse of the key (different intent or message) fails
  // closed here, before any provider work. A bounded admission refusal is
  // a calm "try again later", never a provider call.
  if (!parsed.data.ok)
    throw parsed.data.code === "RATE_LIMITED"
      ? new SarahReservationRateLimited()
      : new SarahUnavailable();
  return !parsed.data.duplicate;
}

async function readSarahContext(): Promise<SarahContext> {
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_my_sarah_context");
  if (error) throw new SarahUnavailable();
  const parsed = sarahContextResultSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok) throw new SarahUnavailable();
  return parsed.data;
}

function learnerOutcome(command: SarahFinalizeCommand): SarahGuideResult {
  return command.state === "ABSTAINED"
    ? { status: "UNAVAILABLE" }
    : { status: "RETRY_LATER" };
}

export async function executeSarahGuide(
  request: SarahRequest,
): Promise<SarahGuideResult> {
  await requireStudentPrincipal();

  let proceed: boolean;
  try {
    proceed = await reserveInteraction(request);
  } catch (error) {
    return error instanceof SarahReservationRateLimited
      ? { status: "RETRY_LATER" }
      : { status: "UNAVAILABLE" };
  }
  if (!proceed) return { status: "DUPLICATE" };

  let context: SarahContext;
  try {
    context = await readSarahContext();
  } catch {
    return { status: "UNAVAILABLE" };
  }

  // The ONLY profile Sarah can execute with: the platform role's fixed
  // reference, resolved through the shared server-owned registry. The
  // academic role-bound resolver is never consulted.
  const profile = resolvePlatformRuntimeProfile("COUNSELLOR");
  if (!profile || profile.ref !== SARAH_RUNTIME_PROFILE_REF)
    return { status: "UNAVAILABLE" };
  if (sarahCapabilitiesFor(context.mode, request.intent).length === 0)
    return { status: "UNAVAILABLE" };

  const scope: SarahExecutionScope = {
    executionId: randomUUID(),
    idempotencyKey: request.idempotencyKey,
    mode: context.mode,
    intent: request.intent,
    profileFingerprint: context.profileFingerprint,
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
    await attestSarahExecutionCommand(scope, {
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
    await attestSarahExecutionCommand(scope, { operation: "START" });
  } catch (error) {
    // START re-checks mode and the confirmed-profile version; a change
    // since AUTHORIZE closes the execution FAILED/POLICY_BLOCKED in the
    // database and no provider call is made. Any other refusal leaves the
    // database-owned expiry to close an AUTHORIZED execution.
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
        capability: SARAH_PROVIDER_CAPABILITY[request.intent],
        context: buildSarahProviderContext(
          context,
          request.intent,
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

  // Strict, machine-verifiable output. A SUCCEEDED call whose output does
  // not match the contract is recorded as FAILED/OUTPUT_INVALID.
  const output =
    result.outcome === "SUCCEEDED"
      ? parseSarahOutput(result.response.outputText, request.intent)
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
  try {
    await attestSarahExecutionCommand(scope, {
      operation: "FINALIZE",
      ...finalize,
    });
  } catch {
    // No reply escapes unless the database confirmed the terminal state.
    return { status: "RETRY_LATER" };
  }
  if (finalize.state !== "SUCCEEDED" || !output)
    return learnerOutcome(finalize);

  let proposal: SarahProposalOutcome = "NONE";
  if (request.intent === "SUPPORT_PROFILE" && output.proposal) {
    const changed = changedProposalFields(
      output.proposal,
      context.supportProfile,
    );
    if (changed) proposal = await keepProposal(scope.executionId, changed);
  }
  return { status: "SUCCEEDED", reply: output.reply, proposal };
}

async function keepProposal(
  executionId: string,
  proposal: SarahProposal,
): Promise<SarahProposalOutcome> {
  try {
    await recordSarahProfileProposal({ executionId, proposal });
    return "PENDING_CONFIRMATION";
  } catch (error) {
    const code = error instanceof SarahProposalRefused ? error.code : "";
    if (code === "STALE_PROPOSAL") return "NOT_RECORDED_STALE";
    if (code === "PROPOSAL_LIMIT_REACHED") return "NOT_RECORDED_LIMIT";
    return "NOT_RECORDED";
  }
}

// The learner's lifecycle mode for page copy only. Null when unavailable.
export async function getMySarahMode(): Promise<CounsellorMode | null> {
  await requireStudentPrincipal();
  try {
    return (await readSarahContext()).mode;
  } catch {
    return null;
  }
}

export type SarahProposalPage =
  | {
      status: "OK";
      current: SupportProfileView;
      proposals: LearnerSarahProposal[];
    }
  | { status: "UNAVAILABLE" };

export async function listMySarahProposals(): Promise<SarahProposalPage> {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc("list_my_sarah_profile_proposals");
  if (error) return { status: "UNAVAILABLE" };
  const parsed = sarahProposalListSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok) return { status: "UNAVAILABLE" };
  return {
    status: "OK",
    current: parsed.data.current,
    proposals: parsed.data.proposals,
  };
}

export type SarahDecisionOutcome =
  "CONFIRMED" | "DECLINED" | "STALE" | "ALREADY_DECIDED" | "UNAVAILABLE";

// Only the authenticated learner decides, on their own proposal; the
// database derives ownership from the session, never from the browser.
export async function decideSarahProposal(
  input: unknown,
): Promise<SarahDecisionOutcome> {
  await requireStudentPrincipal();
  const request = sarahDecisionRequestSchema.safeParse(input);
  if (!request.success) return "UNAVAILABLE";
  const client = await createSupabase();
  const { data, error } = await client.rpc("decide_sarah_profile_proposal", {
    p_proposal_id: request.data.proposalId,
    p_decision: request.data.decision,
  });
  if (error) return "UNAVAILABLE";
  const parsed = sarahDecisionResultSchema.safeParse(data);
  if (!parsed.success) return "UNAVAILABLE";
  if (parsed.data.ok) {
    const expected =
      request.data.decision === "CONFIRM" ? "CONFIRMED" : "DECLINED";
    return parsed.data.state === expected ? expected : "UNAVAILABLE";
  }
  if (parsed.data.code === "STALE_PROPOSAL") return "STALE";
  if (parsed.data.code === "PROPOSAL_DECIDED") return "ALREADY_DECIDED";
  return "UNAVAILABLE";
}
