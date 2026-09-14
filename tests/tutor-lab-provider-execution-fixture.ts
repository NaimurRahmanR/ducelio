import { createHmac, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ExecutionFixture } from "./execution-fixture";
import { learner } from "./execution-fixture";

// Mirrors tests/provider-execution-fixture.ts's signedProviderCommand/
// sendProviderCommand pattern exactly, but for migration 028's generalised
// TUTOR/LAB_INSTRUCTOR governance surface (govern_tutor_lab_provider_
// execution) -- a distinct protocol tag and policy version over the SAME
// controller-key trust root, plus an explicit p_role parameter.
export function signedTutorLabCommand(
  fixture: ExecutionFixture,
  overrides: Partial<{
    role: string;
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
    role: "TUTOR",
    executionId: randomUUID(),
    releaseId: randomUUID(),
    actor: learner,
    operation: "AUTHORIZE",
    state: "AUTHORIZED",
    reason: "NONE",
    budgetStage: "NONE",
    maxCalls: 1,
    maxOutput: 700,
    maxCost: 30_000,
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
    "DUCELIO_EXECUTION_HMAC_TUTOR_LAB_V1",
    "TUTOR_LAB_EXECUTION_V1",
    command.role,
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
    p_role: command.role,
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
export const tutorLabCommandArgNames = [
  "p_role",
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
export async function sendTutorLabCommand(
  db: PGlite,
  args: ReturnType<typeof signedTutorLabCommand>,
) {
  return (
    await db.query<{ value: unknown }>(
      `select public.govern_tutor_lab_provider_execution(${tutorLabCommandArgNames.map((_, i) => `$${i + 1}`).join(",")}) as value`,
      tutorLabCommandArgNames.map((name) => args[name]),
    )
  ).rows[0].value;
}
