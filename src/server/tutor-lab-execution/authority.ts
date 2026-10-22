import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  TUTOR_LAB_EXECUTION_POLICY,
  tutorLabRpcResultSchema,
  TutorLabExecutionDenied,
  type TutorLabBudgetProposal,
  type TutorLabFinalizeCommand,
  type TutorLabRole,
} from "@/domain/tutor-lab-execution";
import { getAuthenticatedActor } from "../identity";
import { AuthenticationRequired, AccessDenied } from "@/domain/policy";
import { createSupabase } from "../supabase";
import type { TutorLabContentRelease } from "./release";
import {
  abandonUnstartedProviderExecution,
  recordLateProviderUsage,
} from "../provider-execution-reliability";

type Command =
  | { operation: "AUTHORIZE"; budget: TutorLabBudgetProposal }
  | { operation: "START" }
  | ({ operation: "FINALIZE" } & TutorLabFinalizeCommand);

// This module is the TUTOR_LAB_EXECUTION_V1 trusted controller's transport,
// never an adapter dependency: no generic signer, Supabase client, key
// material or MAC is returned to callers. Reuses the exact same controller
// secret as migrations 022/025's transports (the trust root is the key
// store, not a protocol-version-specific secret); the distinct
// 'TUTOR_LAB_EXECUTION_V1' policy tag and 'DUCELIO_EXECUTION_HMAC_TUTOR_LAB_V1'
// protocol tag baked into the canonical message make a Professor V2
// attestation structurally unable to authorize a Tutor/Lab transition and
// vice versa, without needing a second key.
export async function attestTutorLabExecutionCommand(
  role: TutorLabRole,
  executionId: string,
  release: TutorLabContentRelease,
  command: Command,
) {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  if (command.operation !== "FINALIZE" && !actor.roles.includes("STUDENT"))
    throw new AccessDenied();
  if (actor.id !== release.studentId)
    throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
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
    "DUCELIO_EXECUTION_HMAC_TUTOR_LAB_V1",
    TUTOR_LAB_EXECUTION_POLICY,
    role,
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id.toLowerCase(),
    z.uuid().parse(release.releaseId).toLowerCase(),
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
    "govern_tutor_lab_provider_execution",
    {
      p_role: role,
      p_key_id: keyId.data,
      p_execution_id: id,
      p_release_id: release.releaseId,
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
  if (error) throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  const result = tutorLabRpcResultSchema.safeParse(data);
  if (!result.success) throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) {
    const databaseTerminal =
      command.operation !== "AUTHORIZE" &&
      [
        "POLICY_BLOCKED",
        "ACTIVITY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "EXECUTION_TIMEOUT",
      ].includes(result.data.code);
    // Late FINALIZE after expiry: record the real usage once (migration
    // 064); the execution stays TIMEOUT.
    if (
      command.operation === "FINALIZE" &&
      result.data.code === "EXECUTION_TIMEOUT"
    )
      await recordLateProviderUsage(
        role,
        id,
        release.releaseId,
        command.usage,
      ).catch(() => "UNAVAILABLE");
    throw new TutorLabExecutionDenied(result.data.code, databaseTerminal);
  }
  const snapshot = result.data.execution;
  if (
    snapshot.executionId !== id ||
    snapshot.studentId !== actor.id ||
    snapshot.releaseId !== release.releaseId ||
    snapshot.invocationId !== release.invocationId ||
    snapshot.agentProfile !== role
  )
    throw new TutorLabExecutionDenied("CONTEXT_CONFLICT");
  if (snapshot.state === "BLOCKED")
    throw new TutorLabExecutionDenied(
      snapshot.reasonCode === "RATE_LIMITED"
        ? "RATE_LIMITED"
        : "BUDGET_BLOCKED",
    );
  if (
    snapshot.state !== state ||
    snapshot.reasonCode !== (reason === "NONE" ? null : reason)
  )
    throw new TutorLabExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.transitioned)
    throw new TutorLabExecutionDenied("REPLAY_REJECTED");
  return snapshot;
}

// Pre-START cleanup (migration 064), as for the Professor: abandon an
// AUTHORIZED execution that could not START; if START did commit, FINALIZE
// it FAILED with zero usage (no provider call was made by this controller).
export async function closeUnstartedTutorLabExecution(
  role: TutorLabRole,
  executionId: string,
  release: TutorLabContentRelease,
  reason: "INTERNAL_ERROR" | "POLICY_BLOCKED" | "ACTIVITY_BLOCKED",
): Promise<void> {
  try {
    const outcome = await abandonUnstartedProviderExecution(
      role,
      executionId,
      release.releaseId,
      reason,
    );
    if (outcome === "RUNNING")
      await attestTutorLabExecutionCommand(role, executionId, release, {
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
