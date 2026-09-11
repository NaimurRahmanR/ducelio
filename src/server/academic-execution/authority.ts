import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  PROFESSOR_EXECUTION_POLICY,
  executionRpcResultSchema,
  type ExecutionErrorCode,
} from "@/domain/academic-execution";
import { getAuthenticatedActor } from "../identity";
import { AuthenticationRequired, AccessDenied } from "@/domain/policy";
import { createSupabase } from "../supabase";
import type { AcademicContentRelease } from "../academic-content-release";

export class ExecutionDenied extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly databaseTerminal = false,
  ) {
    super("Professor execution unavailable.");
  }
}

const commandSchema = z.union([
  z.strictObject({
    operation: z.literal("AUTHORIZE"),
    state: z.literal("AUTHORIZED"),
    reason: z.literal("NONE"),
  }),
  z.strictObject({
    operation: z.literal("START"),
    state: z.literal("RUNNING"),
    reason: z.literal("NONE"),
  }),
  z.strictObject({
    operation: z.literal("FINALIZE"),
    state: z.literal("ABSTAINED"),
    reason: z.enum(["ABSTAIN_UNCERTAIN", "POLICY_BLOCKED"]),
  }),
  z.strictObject({
    operation: z.literal("FINALIZE"),
    state: z.literal("ESCALATED"),
    reason: z.literal("HUMAN_REVIEW_REQUIRED"),
  }),
  z.strictObject({
    operation: z.literal("FINALIZE"),
    state: z.literal("FAILED"),
    reason: z.enum([
      "INTERNAL_ERROR",
      "OUTPUT_INVALID",
      "POLICY_BLOCKED",
      "CONTENT_RELEASE_UNAVAILABLE",
      "ACTIVITY_BLOCKED",
    ]),
  }),
  z.strictObject({
    operation: z.literal("FINALIZE"),
    state: z.literal("SUCCEEDED"),
    reason: z.literal("CONTROL_PLANE_COMPLETE"),
  }),
]);
type Command = z.infer<typeof commandSchema>;

// This module is the trusted controller's transport, never an adapter dependency.
// No generic signer, Supabase client, key material or MAC is returned to callers.
export async function attestExecutionCommand(
  executionId: string,
  release: AcademicContentRelease,
  untrustedCommand: Command,
) {
  const command = commandSchema.parse(untrustedCommand);
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  if (command.operation !== "FINALIZE" && !actor.roles.includes("STUDENT"))
    throw new AccessDenied();
  if (actor.id !== release.student_id)
    throw new ExecutionDenied("CONTEXT_CONFLICT");
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new ExecutionDenied("SERVICE_UNAVAILABLE");
  const id = z.uuid().parse(executionId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_EXECUTION_HMAC_SHA256_V1",
    PROFESSOR_EXECUTION_POLICY,
    "PROFESSOR",
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id.toLowerCase(),
    z.uuid().parse(release.release_id).toLowerCase(),
    command.operation,
    command.state,
    command.reason,
    "0",
    "0",
    "0",
    "0",
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc("govern_professor_execution", {
    p_key_id: keyId.data,
    p_execution_id: id,
    p_release_id: release.release_id,
    p_operation: command.operation,
    p_state: command.state,
    p_reason: command.reason,
    p_calls: 0,
    p_input: 0,
    p_output: 0,
    p_cost: 0,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  });
  if (error) throw new ExecutionDenied("SERVICE_UNAVAILABLE");
  const result = executionRpcResultSchema.safeParse(data);
  if (!result.success) throw new ExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) {
    // For an admitted, immutable execution/release binding, these START/FINALIZE
    // responses mean the DB committed FAILED (or found its timeout terminal).
    // A transport/schema failure supplies no such evidence. AUTHORIZE denials
    // likewise never establish a terminal execution for cleanup purposes.
    const databaseTerminal =
      command.operation !== "AUTHORIZE" &&
      [
        "POLICY_BLOCKED",
        "ACTIVITY_BLOCKED",
        "CONTENT_RELEASE_UNAVAILABLE",
        "EXECUTION_TIMEOUT",
      ].includes(result.data.code);
    throw new ExecutionDenied(result.data.code, databaseTerminal);
  }
  const snapshot = result.data.execution;
  if (
    snapshot.executionId !== id ||
    snapshot.studentId !== actor.id ||
    snapshot.releaseId !== release.release_id ||
    snapshot.invocationId !== release.invocation_id
  )
    throw new ExecutionDenied("CONTEXT_CONFLICT");
  if (snapshot.state === "BLOCKED")
    throw new ExecutionDenied(
      snapshot.reasonCode === "RATE_LIMITED"
        ? "RATE_LIMITED"
        : "BUDGET_BLOCKED",
    );
  if (
    snapshot.state !== command.state ||
    snapshot.reasonCode !== (command.reason === "NONE" ? null : command.reason)
  )
    throw new ExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.transitioned) throw new ExecutionDenied("REPLAY_REJECTED");
  return snapshot;
}
