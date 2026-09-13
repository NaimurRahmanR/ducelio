import { createHmac, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ExecutionFixture } from "./execution-fixture";
import { learner } from "./execution-fixture";

// Mirrors tests/execution-fixture.ts's signedExecutionCommand/
// sendExecutionCommand pattern exactly, but for migration 025's V2
// governance surface (govern_professor_provider_execution). Reuses the same
// ExecutionFixture (db/keyId/key/enrolmentId/assessmentId) — V2 shares the
// same controller-key trust root as V1, just a distinct protocol tag.
export function signedProviderCommand(
  fixture: ExecutionFixture,
  overrides: Partial<{
    executionId: string;
    releaseId: string;
    actor: string;
    operation: string;
    state: string;
    reason: string;
    budgetStage: string;
    maxCalls: number;
    maxOutput: number;
    maxCost: number;
    calls: number;
    attempts: number;
    input: number;
    output: number;
    cost: number;
    elapsed: number;
    issuedAt: number;
    expiresAt: number;
    keyId: string;
  }> = {},
) {
  const command = {
    executionId: randomUUID(),
    releaseId: randomUUID(),
    actor: learner,
    operation: "AUTHORIZE",
    state: "AUTHORIZED",
    reason: "NONE",
    budgetStage: "NONE",
    maxCalls: 1,
    maxOutput: 1000,
    maxCost: 50_000,
    calls: 0,
    attempts: 0,
    input: 0,
    output: 0,
    cost: 0,
    elapsed: 0,
    issuedAt: Math.floor(Date.now() / 1000),
    keyId: fixture.keyId,
    ...overrides,
  };
  const expiresAt = overrides.expiresAt ?? command.issuedAt + 10;
  const canonical = [
    "DUCELIO_EXECUTION_HMAC_SHA256_V2",
    "PROFESSOR_EXECUTION_V2",
    "PROFESSOR",
    command.keyId,
    command.actor,
    command.executionId,
    command.releaseId,
    command.operation,
    command.state,
    command.reason,
    command.budgetStage,
    command.maxCalls,
    command.maxOutput,
    command.maxCost,
    command.calls,
    command.attempts,
    command.input,
    command.output,
    command.cost,
    command.elapsed,
    command.issuedAt,
    expiresAt,
  ].join("\n");
  return {
    p_key_id: command.keyId,
    p_execution_id: command.executionId,
    p_release_id: command.releaseId,
    p_operation: command.operation,
    p_state: command.state,
    p_reason: command.reason,
    p_budget_stage: command.budgetStage,
    p_max_calls: command.maxCalls,
    p_max_output: command.maxOutput,
    p_max_cost: command.maxCost,
    p_calls: command.calls,
    p_attempts: command.attempts,
    p_input: command.input,
    p_output: command.output,
    p_cost: command.cost,
    p_elapsed: command.elapsed,
    p_issued_at: command.issuedAt,
    p_expires_at: expiresAt,
    p_mac: createHmac("sha256", fixture.key).update(canonical).digest("hex"),
  };
}
export const providerCommandArgNames = [
  "p_key_id",
  "p_execution_id",
  "p_release_id",
  "p_operation",
  "p_state",
  "p_reason",
  "p_budget_stage",
  "p_max_calls",
  "p_max_output",
  "p_max_cost",
  "p_calls",
  "p_attempts",
  "p_input",
  "p_output",
  "p_cost",
  "p_elapsed",
  "p_issued_at",
  "p_expires_at",
  "p_mac",
] as const;
export async function sendProviderCommand(
  db: PGlite,
  args: ReturnType<typeof signedProviderCommand>,
) {
  return (
    await db.query<{ value: unknown }>(
      `select public.govern_professor_provider_execution(${providerCommandArgNames.map((_, i) => `$${i + 1}`).join(",")}) as value`,
      providerCommandArgNames.map((name) => args[name]),
    )
  ).rows[0].value;
}
