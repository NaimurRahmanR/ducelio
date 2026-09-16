import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  COMMERCIAL_V1_EXAMINER_POLICY,
  EXAMINER_RUNTIME_PROFILE_REF,
  examinerRpcResultSchema,
  ExaminerExecutionDenied,
  type ExaminerBudgetProposal,
  type ExaminerCapability,
  type ExaminerFinalizeCommand,
  type ExaminerTargetKind,
} from "@/domain/commercial-v1-examiner-grading";
import { getAuthenticatedActor } from "../identity";
import { AuthenticationRequired, AccessDenied } from "@/domain/policy";
import { createSupabase } from "../supabase";

type IdentityHint = { enrolmentId: string | null; activationId: string | null };

type Command =
  | {
      operation: "AUTHORIZE";
      capability: ExaminerCapability;
      targetKind: ExaminerTargetKind;
      attemptId: string | null;
      submissionId: string | null;
      budget: ExaminerBudgetProposal;
    }
  | ({
      operation: "START";
      capability: ExaminerCapability;
      targetKind: ExaminerTargetKind;
      attemptId: string | null;
      submissionId: string | null;
    } & IdentityHint)
  | ({
      operation: "FINALIZE";
      capability: ExaminerCapability;
      targetKind: ExaminerTargetKind;
      attemptId: string | null;
      submissionId: string | null;
    } & IdentityHint &
      ExaminerFinalizeCommand);

// This module is the COMMERCIAL_V1_EXAMINER_V1 trusted controller's
// transport, never an adapter dependency: no generic signer, Supabase
// client, key material or MAC is returned to callers. Reuses the exact same
// controller secret as migrations 022/025/028's transports (the trust root
// is the key store, not a protocol-version-specific secret); the distinct
// 'COMMERCIAL_V1_EXAMINER_V1' policy tag and
// 'DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1' protocol tag baked into
// the canonical message make no other surface's attestation able to
// authorize an Examiner transition and vice versa, without needing a
// second key.
export async function attestExaminerExecutionCommand(
  executionId: string,
  command: Command,
) {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  if (command.operation === "AUTHORIZE" && !actor.roles.includes("STUDENT"))
    throw new AccessDenied();
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
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
  const gradeDigest =
    command.operation === "FINALIZE" ? command.gradeDigest : null;
  const enrolmentId =
    command.operation === "AUTHORIZE" ? null : command.enrolmentId;
  const activationId =
    command.operation === "AUTHORIZE" ? null : command.activationId;

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
    COMMERCIAL_V1_EXAMINER_POLICY,
    "EXAMINER",
    // Blocker 1 (independent review, V3): this field was missing entirely
    // -- the production signer never matched migration 031's own
    // verify_command_ex1 canonical text, so no real production command
    // MAC could ever verify. Must occur immediately after "EXAMINER" and
    // before key id, exactly like the CONTEXT_READ signer below (which
    // already had this right).
    EXAMINER_RUNTIME_PROFILE_REF,
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id.toLowerCase(),
    command.capability,
    command.targetKind,
    command.attemptId?.toLowerCase() ?? "NONE",
    command.submissionId?.toLowerCase() ?? "NONE",
    enrolmentId?.toLowerCase() ?? "NONE",
    activationId?.toLowerCase() ?? "NONE",
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
    gradeDigest ?? "NONE",
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "govern_commercial_v1_examiner_execution",
    {
      p_key_id: keyId.data,
      p_execution_id: id,
      p_capability: command.capability,
      p_target_kind: command.targetKind,
      p_attempt_id: command.attemptId,
      p_submission_id: command.submissionId,
      p_enrolment_id: enrolmentId,
      p_activation_id: activationId,
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
      p_grade_digest: gradeDigest,
      p_issued_at: issuedAt,
      p_expires_at: expiresAt,
      p_mac: mac,
      p_assessment_marks:
        command.operation === "FINALIZE" ? command.assessmentMarks : null,
      p_lab_marks_awarded:
        command.operation === "FINALIZE" ? command.labMarksAwarded : null,
    },
  );
  if (error) throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
  const result = examinerRpcResultSchema.safeParse(data);
  if (!result.success) throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
  if (!result.data.ok) {
    // Blocker 5 (independent review, V2): databaseTerminal means the
    // database has actually committed/found a terminal outcome as a SIDE
    // EFFECT of this exact denial -- not merely "the database said no".
    // Only EXECUTION_TIMEOUT does that here (migration 031's lazy-timeout
    // path writes state='TIMEOUT' before returning it). CONTEXT_CONFLICT
    // and EXECUTION_UNAVAILABLE are pure read-time refusals that mutate
    // nothing, so treating them as databaseTerminal would wrongly skip a
    // legitimate best-effort FAILED cleanup attempt.
    const databaseTerminal =
      command.operation !== "AUTHORIZE" &&
      result.data.code === "EXECUTION_TIMEOUT";
    throw new ExaminerExecutionDenied(result.data.code, databaseTerminal);
  }
  const snapshot = result.data.execution;
  if (
    snapshot.studentId !== actor.id ||
    snapshot.capability !== command.capability
  )
    throw new ExaminerExecutionDenied("CONTEXT_CONFLICT");
  // AUTHORIZE against a target that already has a (possibly terminal) claim
  // returns THAT existing execution's own id/state, deliberately different
  // from the id this caller proposed -- see migration 031's own comment.
  // Every other operation must exactly match the execution id it was
  // called with.
  if (command.operation !== "AUTHORIZE" && snapshot.executionId !== id)
    throw new ExaminerExecutionDenied("CONTEXT_CONFLICT");
  return { snapshot, transitioned: result.data.transitioned };
}

// Blocker 1 (independent review, V2): a FRESH, dedicated controller
// attestation for reading protected assessment/lab context. Knowing a
// RUNNING execution UUID is never sufficient on its own -- only the
// trusted server (holder of the controller secret) can produce this
// signature. Distinct canonical operation ('CONTEXT_READ') under the SAME
// policy/protocol tag as the main command surface, deliberately with a
// lighter parameter set (no state/reason/budget/usage/grade-digest exists
// for a read) -- see commercial_v1_examiner_private.verify_context_read_ex1
// (migration 031). Returns the exact bound RPC parameters the caller
// (./context.ts) must pass to get_commercial_v1_examiner_assessment_context
// / get_commercial_v1_examiner_lab_context -- never a raw MAC or key
// exposed to any other caller.
export async function attestExaminerContextRead(
  executionId: string,
  target: {
    capability: ExaminerCapability;
    targetKind: ExaminerTargetKind;
    attemptId: string | null;
    submissionId: string | null;
    enrolmentId: string;
    activationId: string;
  },
) {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new AuthenticationRequired();
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
  const id = z.uuid().parse(executionId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
    COMMERCIAL_V1_EXAMINER_POLICY,
    "EXAMINER",
    EXAMINER_RUNTIME_PROFILE_REF,
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id.toLowerCase(),
    target.capability,
    target.targetKind,
    target.attemptId?.toLowerCase() ?? "NONE",
    target.submissionId?.toLowerCase() ?? "NONE",
    target.enrolmentId.toLowerCase(),
    target.activationId.toLowerCase(),
    "CONTEXT_READ",
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  return {
    p_key_id: keyId.data,
    p_execution_id: id,
    p_enrolment_id: target.enrolmentId,
    p_activation_id: target.activationId,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  };
}
