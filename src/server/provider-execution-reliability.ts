import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { RuntimeUsage } from "@/domain/academic-runtime";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";

// Shared AI execution reliability (migration 064) for the Professor
// (migration 025) and Tutor/Lab Instructor (migration 028) governance, in
// the cohort and Academy runtimes alike. Two controller-attested commands,
// each with its own protocol tag over the existing controller key:
//
// * recordLateProviderUsage: a FINALIZE that arrived after the execution
//   expired is refused (EXECUTION_TIMEOUT) and writes no usage. This
//   records that call's real usage once, without changing the TIMEOUT state
//   (the late output never becomes a success).
// * abandonUnstartedProviderExecution: closes an AUTHORIZED execution that
//   could not START, so it no longer holds the learner's single active
//   execution until expiry. A RUNNING execution is refused: only FINALIZE,
//   with its real usage, may close it.
//
// No key material, MAC or canonical message leaves this module.

export type GovernedExecutionKind = "PROFESSOR" | "TUTOR" | "LAB_INSTRUCTOR";

function signer() {
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success) return null;
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    keyId: keyId.data.toLowerCase(),
    issuedAt,
    expiresAt: issuedAt + 10,
    sign: (canonical: string) =>
      createHmac("sha256", Buffer.from(keyHex.data, "hex"))
        .update(canonical, "utf8")
        .digest("hex"),
  };
}
const resultSchema = z.union([
  z.strictObject({ ok: z.literal(true), state: z.string().max(40) }),
  z.strictObject({
    ok: z.literal(true),
    state: z.string().max(40),
    transitioned: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(64) }),
]);

export type LateUsageOutcome =
  "RECORDED" | "ALREADY_RECORDED" | "NOT_APPLICABLE" | "UNAVAILABLE";

export async function recordLateProviderUsage(
  kind: GovernedExecutionKind,
  executionId: string,
  releaseId: string,
  usage: RuntimeUsage,
): Promise<LateUsageOutcome> {
  const actor = await getAuthenticatedActor();
  const c = signer();
  if (!actor || !c) return "UNAVAILABLE";
  const id = z.uuid().parse(executionId).toLowerCase();
  const release = z.uuid().parse(releaseId).toLowerCase();
  const canonical = [
    "DUCELIO_LATE_PROVIDER_USAGE_HMAC_SHA256_V1",
    kind,
    c.keyId,
    actor.id.toLowerCase(),
    id,
    release,
    String(usage.providerCalls),
    String(usage.attempts),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.estimatedCostMicrousd),
    String(usage.elapsedMs),
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const { data, error } = await (
    await createSupabase()
  ).rpc("record_late_provider_execution_usage", {
    p_kind: kind,
    p_key_id: c.keyId,
    p_execution_id: id,
    p_release_id: release,
    p_calls: usage.providerCalls,
    p_attempts: usage.attempts,
    p_input: usage.inputTokens,
    p_output: usage.outputTokens,
    p_cost: usage.estimatedCostMicrousd,
    p_elapsed: usage.elapsedMs,
    p_issued_at: c.issuedAt,
    p_expires_at: c.expiresAt,
    p_mac: c.sign(canonical),
  });
  if (error) return "UNAVAILABLE";
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) return "UNAVAILABLE";
  if (parsed.data.ok) return "RECORDED";
  if (parsed.data.code === "ALREADY_RECORDED") return "ALREADY_RECORDED";
  return parsed.data.code === "INVALID_STATE"
    ? "NOT_APPLICABLE"
    : "UNAVAILABLE";
}

export type AbandonOutcome =
  "ABANDONED" | "ALREADY_TERMINAL" | "RUNNING" | "UNAVAILABLE";

export async function abandonUnstartedProviderExecution(
  kind: GovernedExecutionKind,
  executionId: string,
  releaseId: string,
  reason:
    | "INTERNAL_ERROR"
    | "POLICY_BLOCKED"
    | "ACTIVITY_BLOCKED"
    | "CONTENT_RELEASE_UNAVAILABLE",
): Promise<AbandonOutcome> {
  const actor = await getAuthenticatedActor();
  const c = signer();
  if (!actor || !c) return "UNAVAILABLE";
  const id = z.uuid().parse(executionId).toLowerCase();
  const release = z.uuid().parse(releaseId).toLowerCase();
  const canonical = [
    "DUCELIO_ABANDON_PROVIDER_EXECUTION_HMAC_SHA256_V1",
    kind,
    c.keyId,
    actor.id.toLowerCase(),
    id,
    release,
    reason,
    String(c.issuedAt),
    String(c.expiresAt),
  ].join("\n");
  const { data, error } = await (
    await createSupabase()
  ).rpc("abandon_unstarted_provider_execution", {
    p_kind: kind,
    p_key_id: c.keyId,
    p_execution_id: id,
    p_release_id: release,
    p_reason: reason,
    p_issued_at: c.issuedAt,
    p_expires_at: c.expiresAt,
    p_mac: c.sign(canonical),
  });
  if (error) return "UNAVAILABLE";
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) return "UNAVAILABLE";
  if (!parsed.data.ok)
    return parsed.data.code === "EXECUTION_RUNNING" ? "RUNNING" : "UNAVAILABLE";
  return "transitioned" in parsed.data && parsed.data.transitioned
    ? "ABANDONED"
    : "ALREADY_TERMINAL";
}
