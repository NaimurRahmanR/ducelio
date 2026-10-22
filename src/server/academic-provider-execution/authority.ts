import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  PROFESSOR_EXECUTION_POLICY_V2,
  providerExecutionRpcResultSchema,
  type ProviderExecutionBudgetProposal,
  type ProviderExecutionFinalizeCommand,
  type ProviderExecutionErrorCode,
} from "@/domain/academic-provider-execution";
import { getAuthenticatedActor } from "../identity";
import { AuthenticationRequired, AccessDenied } from "@/domain/policy";
import { createSupabase } from "../supabase";
import type { AcademicContentRelease } from "../academic-content-release";
import {
  abandonUnstartedProviderExecution,
  recordLateProviderUsage,
} from "../provider-execution-reliability";

export class ProviderExecutionDenied extends Error {
  constructor(
    readonly code: ProviderExecutionErrorCode,
    readonly databaseTerminal = false,
  ) {
    super("Professor provider-backed execution unavailable.");
  }
}

type Command =
  | { operation: "AUTHORIZE"; budget: ProviderExecutionBudgetProposal }
  | { operation: "START" }
  | ({ operation: "FINALIZE" } & ProviderExecutionFinalizeCommand);

// This module is the V2 trusted controller's transport, never an adapter
// dependency: no generic signer, Supabase client, key material or MAC is
// returned to callers. Reuses the exact same controller secret as migration
// 022's V1 transport (the trust root is the key store, not a protocol-
// version-specific secret); the distinct 'PROFESSOR_EXECUTION_V2' policy tag
// baked into the canonical message makes a V1 attestation structurally
// unable to authorize a V2 transition and vice versa.
export async function attestProviderExecutionCommand(
  executionId: string,
  release: AcademicContentRelease,
  command: Command,
) {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  if (command.operation !== "FINALIZE" && !actor.roles.includes("STUDENT"))
    throw new AccessDenied();
  if (actor.id !== release.student_id)
    throw new ProviderExecutionDenied("CONTEXT_CONFLICT");
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new ProviderExecutionDenied("SERVICE_UNAVAILABLE");
  const id = z.uuid().parse(executionId);

  const state =
    command.operation === "AUTHORIZE"
      ? "AUTHORIZED"
      : command.operation === "START"
        ? "RUNNING"
        : command.state;
  const reason = command.operation === "FINALIZE" ? command.reason : "NONE";
  const budgetStage =
    command.operation === "FINALIZE" ? (command.budgetStage ?? "NONE") : "NONE";
  const maxCalls =
    command.operation === "AUTHORIZE" ? command.budget.maxProviderCalls : 0;
  const maxOutput =
    command.operation === "AUTHORIZE" ? command.budget.maxOutputTokens : 0;
  const maxCost =
    command.operation === "AUTHORIZE"
      ? command.budget.maxEstimatedCostMicrousd
      : 0;
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
    "DUCELIO_EXECUTION_HMAC_SHA256_V2",
    PROFESSOR_EXECUTION_POLICY_V2,
    "PROFESSOR",
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id.toLowerCase(),
    z.uuid().parse(release.release_id).toLowerCase(),
    command.operation,
    state,
    reason,
    budgetStage,
    String(maxCalls),
    String(maxOutput),
    String(maxCost),
    String(usage.providerCalls),
    String(usage.attempts),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.estimatedCostMicrousd),
    String(usage.elapsedMs),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "govern_professor_provider_execution",
    {
      p_key_id: keyId.data,
      p_execution_id: id,
      p_release_id: release.release_id,
      p_operation: command.operation,
      p_state: state,
      p_reason: reason,
      p_budget_stage: budgetStage,
      p_max_calls: maxCalls,
      p_max_output: maxOutput,
      p_max_cost: maxCost,
      p_calls: usage.providerCalls,
      p_attempts: usage.attempts,
      p_input: usage.inputTokens,
      p_output: usage.outputTokens,
      p_cost: usage.estimatedCostMicrousd,
      p_elapsed: usage.elapsedMs,
      p_issued_at: issuedAt,
      p_expires_at: expiresAt,
      p_mac: mac,
    },
  );
  if (error) throw new ProviderExecutionDenied("SERVICE_UNAVAILABLE");
  const result = providerExecutionRpcResultSchema.safeParse(data);
  if (!result.success) throw new ProviderExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) {
    // For an admitted, immutable execution/release binding, a START/FINALIZE
    // denial below means the DB committed a terminal state (or found its own
    // timeout terminal). A transport/schema failure supplies no such
    // evidence, and AUTHORIZE denials never establish a terminal execution.
    const databaseTerminal =
      command.operation !== "AUTHORIZE" &&
      [
        "POLICY_BLOCKED",
        "ACTIVITY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "EXECUTION_TIMEOUT",
      ].includes(result.data.code);
    // A FINALIZE that reached the database after the execution expired is
    // refused, and the governance writes no usage for it. Its real usage is
    // recorded once through the late-usage command (migration 064); the
    // execution stays TIMEOUT and nothing here becomes a success.
    if (
      command.operation === "FINALIZE" &&
      result.data.code === "EXECUTION_TIMEOUT"
    )
      await recordLateProviderUsage(
        "PROFESSOR",
        id,
        release.release_id,
        command.usage,
      ).catch(() => "UNAVAILABLE");
    throw new ProviderExecutionDenied(result.data.code, databaseTerminal);
  }
  const snapshot = result.data.execution;
  if (
    snapshot.executionId !== id ||
    snapshot.studentId !== actor.id ||
    snapshot.releaseId !== release.release_id ||
    snapshot.invocationId !== release.invocation_id
  )
    throw new ProviderExecutionDenied("CONTEXT_CONFLICT");
  if (snapshot.state === "BLOCKED")
    throw new ProviderExecutionDenied(
      snapshot.reasonCode === "RATE_LIMITED"
        ? "RATE_LIMITED"
        : "BUDGET_BLOCKED",
    );
  if (
    snapshot.state !== state ||
    snapshot.reasonCode !== (reason === "NONE" ? null : reason)
  )
    throw new ProviderExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.transitioned)
    throw new ProviderExecutionDenied("REPLAY_REJECTED");
  return snapshot;
}

// Pre-START cleanup (migration 064). FINALIZE is accepted only from
// RUNNING, so an execution that was AUTHORIZED but could not START is
// abandoned instead, at once, rather than holding the learner's single
// active execution until expiry. If START did in fact commit (its response
// was lost), the execution is RUNNING and no provider call was made by this
// controller, so it is FINALIZEd FAILED with zero usage. Best effort: the
// database-owned expiry remains the backstop.
export async function closeUnstartedProviderExecution(
  executionId: string,
  release: AcademicContentRelease,
  reason: "INTERNAL_ERROR" | "POLICY_BLOCKED" | "ACTIVITY_BLOCKED",
): Promise<void> {
  try {
    const outcome = await abandonUnstartedProviderExecution(
      "PROFESSOR",
      executionId,
      release.release_id,
      reason,
    );
    if (outcome === "RUNNING")
      await attestProviderExecutionCommand(executionId, release, {
        operation: "FINALIZE",
        state: "FAILED",
        reason,
        budgetStage: null,
        usage: {
          providerCalls: 0,
          attempts: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicrousd: 0,
          elapsedMs: 0,
        },
      });
  } catch {
    // Lazy DB-owned expiry remains the backstop.
  }
}
