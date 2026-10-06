import "server-only";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { CounsellorMode } from "@/domain/platform-ai-policy";
import {
  SARAH_EXECUTION_POLICY,
  SARAH_PLATFORM_ROLE,
  SARAH_PROPOSAL_POLICY,
  SARAH_RUNTIME_PROFILE_REF,
  sarahGovernResultSchema,
  sarahProposalMaterial,
  sarahProposalRecordResultSchema,
  type SarahExecutionSnapshot,
  type SarahFinalizeCommand,
  type SarahIntent,
  type SarahProposal,
  type SarahProposalRecordRefusal,
} from "@/domain/sarah";
import { getAuthenticatedActor } from "../identity";
import { createSupabase } from "../supabase";

// AC-5: the SARAH_EXECUTION_V1 trusted controller's transport. No generic
// signer, Supabase client, key material, canonical message or MAC ever
// leaves this module.
//
// Trust root (reviewed decision): the EXISTING controller key store
// (migration 022's academic_execution_private.controller_keys, the same
// ACADEMIC_EXECUTION_KEY_ID / ACADEMIC_EXECUTION_HMAC_KEY_HEX the Professor,
// Tutor/Lab, provenance and Tutor-note transports use), verified in the
// database by agent_behaviour_private.verify_mac (10-second freshness,
// constant-time comparison). Sarah's two canonical messages begin with NEW
// protocol tags (DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1 and
// DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1). Every database verifier
// builds its canonical message with its own literal first-line tag, so a
// MAC for one surface can never verify on another: domain separation by tag
// is sufficient, and a second secret would add operational burden with no
// security gain. No historical message format is changed.

export class SarahControllerDenied extends Error {
  constructor(
    readonly code: string,
    readonly databaseTerminal = false,
  ) {
    super("Sarah execution unavailable.");
    this.name = "SarahControllerDenied";
  }
}

function controllerKey() {
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success) return null;
  return { keyId: keyId.data.toLowerCase(), keyHex: keyHex.data };
}

function mac(keyHex: string, canonical: string) {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
}

export type SarahExecutionScope = {
  executionId: string;
  idempotencyKey: string;
  mode: CounsellorMode;
  intent: SarahIntent;
  profileFingerprint: string;
};

type Command =
  | {
      operation: "AUTHORIZE";
      budget: {
        maxProviderCalls: number;
        maxOutputTokens: number;
        maxEstimatedCostMicrousd: number;
      };
    }
  | { operation: "START" }
  | ({ operation: "FINALIZE" } & SarahFinalizeCommand);

export async function attestSarahExecutionCommand(
  scope: SarahExecutionScope,
  command: Command,
): Promise<SarahExecutionSnapshot> {
  const actor = await getAuthenticatedActor();
  if (!actor || !actor.roles.includes("STUDENT"))
    throw new SarahControllerDenied("FORBIDDEN");
  const key = controllerKey();
  if (!key) throw new SarahControllerDenied("SERVICE_UNAVAILABLE");
  const executionId = z.uuid().parse(scope.executionId).toLowerCase();
  const idempotencyKey = z.uuid().parse(scope.idempotencyKey).toLowerCase();
  const fingerprint = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(scope.profileFingerprint);

  const state =
    command.operation === "AUTHORIZE"
      ? "AUTHORIZED"
      : command.operation === "START"
        ? "RUNNING"
        : command.state;
  const reason = command.operation === "FINALIZE" ? command.reason : "NONE";
  const budgetStage =
    command.operation === "FINALIZE" ? (command.budgetStage ?? "NONE") : "NONE";
  const budget =
    command.operation === "AUTHORIZE"
      ? command.budget
      : {
          maxProviderCalls: 0,
          maxOutputTokens: 0,
          maxEstimatedCostMicrousd: 0,
        };
  const usage =
    command.operation === "FINALIZE"
      ? command.usage
      : {
          providerCalls: 0,
          attempts: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicrousd: 0,
          elapsedMs: 0,
        };
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_SARAH_EXECUTION_HMAC_SHA256_V1",
    SARAH_EXECUTION_POLICY,
    SARAH_PLATFORM_ROLE,
    SARAH_RUNTIME_PROFILE_REF,
    key.keyId,
    actor.id.toLowerCase(),
    executionId,
    idempotencyKey,
    command.operation,
    scope.mode,
    scope.intent,
    fingerprint,
    state,
    reason,
    budgetStage,
    String(budget.maxProviderCalls),
    String(budget.maxOutputTokens),
    String(budget.maxEstimatedCostMicrousd),
    String(usage.providerCalls),
    String(usage.attempts),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.estimatedCostMicrousd),
    String(usage.elapsedMs),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const client = await createSupabase();
  const { data, error } = await client.rpc("govern_sarah_execution", {
    p_key_id: key.keyId,
    p_platform_role: SARAH_PLATFORM_ROLE,
    p_runtime_profile_ref: SARAH_RUNTIME_PROFILE_REF,
    p_execution_id: executionId,
    p_idempotency_key: idempotencyKey,
    p_operation: command.operation,
    p_mode: scope.mode,
    p_intent: scope.intent,
    p_profile_fingerprint: fingerprint,
    p_state: state,
    p_reason: reason,
    p_budget_stage: budgetStage,
    p_max_calls: budget.maxProviderCalls,
    p_max_output: budget.maxOutputTokens,
    p_max_cost: budget.maxEstimatedCostMicrousd,
    p_calls: usage.providerCalls,
    p_attempts: usage.attempts,
    p_input: usage.inputTokens,
    p_output: usage.outputTokens,
    p_cost: usage.estimatedCostMicrousd,
    p_elapsed: usage.elapsedMs,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac(key.keyHex, canonical),
  });
  if (error) throw new SarahControllerDenied("SERVICE_UNAVAILABLE");
  const result = sarahGovernResultSchema.safeParse(data);
  if (!result.success) throw new SarahControllerDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok)
    throw new SarahControllerDenied(
      result.data.code,
      command.operation !== "AUTHORIZE" &&
        result.data.code === "EXECUTION_TIMEOUT",
    );
  const snapshot = result.data.execution;
  if (
    snapshot.executionId !== executionId ||
    snapshot.studentId !== actor.id ||
    snapshot.mode !== scope.mode ||
    snapshot.intent !== scope.intent
  )
    throw new SarahControllerDenied("CONTEXT_CONFLICT");
  if (snapshot.state === "BLOCKED")
    throw new SarahControllerDenied(snapshot.reasonCode ?? "BLOCKED", true);
  if (
    snapshot.state !== state ||
    snapshot.reasonCode !== (reason === "NONE" ? null : reason)
  )
    throw new SarahControllerDenied("SERVICE_UNAVAILABLE");
  return snapshot;
}

export class SarahProposalRefused extends Error {
  constructor(
    readonly code: SarahProposalRecordRefusal | "SERVICE_UNAVAILABLE",
  ) {
    super("Sarah proposal was not recorded.");
    this.name = "SarahProposalRefused";
  }
}

// The trusted controller's proposal write: called only after the database
// confirmed FINALIZE SUCCEEDED for this server's own execution id, with the
// strictly validated structured proposal from that same provider response.
// The MAC covers the SHA-256 of the canonical proposal material.
export async function recordSarahProfileProposal(input: {
  executionId: string;
  proposal: SarahProposal;
}): Promise<{ duplicate: boolean }> {
  const actor = await getAuthenticatedActor();
  if (!actor || !actor.roles.includes("STUDENT"))
    throw new SarahProposalRefused("FORBIDDEN");
  const key = controllerKey();
  if (!key) throw new SarahProposalRefused("SERVICE_UNAVAILABLE");
  const executionId = z.uuid().parse(input.executionId).toLowerCase();
  const digest = createHash("sha256")
    .update(sarahProposalMaterial(input.proposal), "utf8")
    .digest("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_SARAH_PROFILE_PROPOSAL_HMAC_SHA256_V1",
    SARAH_PROPOSAL_POLICY,
    SARAH_PLATFORM_ROLE,
    key.keyId,
    actor.id.toLowerCase(),
    executionId,
    digest,
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const client = await createSupabase();
  const { data, error } = await client.rpc("record_sarah_profile_proposal", {
    p_key_id: key.keyId,
    p_execution_id: executionId,
    p_study_goal: input.proposal.studyGoal ?? null,
    p_weekly_hours: input.proposal.weeklyHours ?? null,
    p_preferred_contact: input.proposal.preferredContact ?? null,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac(key.keyHex, canonical),
  });
  if (error) throw new SarahProposalRefused("SERVICE_UNAVAILABLE");
  const parsed = sarahProposalRecordResultSchema.safeParse(data);
  if (!parsed.success) throw new SarahProposalRefused("SERVICE_UNAVAILABLE");
  if (!parsed.data.ok) throw new SarahProposalRefused(parsed.data.code);
  return { duplicate: parsed.data.duplicate };
}
