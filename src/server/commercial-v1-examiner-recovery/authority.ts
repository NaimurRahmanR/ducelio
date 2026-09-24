import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { zeroUsage } from "@/domain/academic-runtime";
import {
  EXAMINER_RUNTIME_PROFILE_REF,
  examinerUsageReportSchema,
  type ExaminerFinalizeCommand,
} from "@/domain/commercial-v1-examiner-grading";
import {
  RECOVERY_POLICY,
  RECOVERY_PROTOCOL,
  RecoveryDenied,
  recoveryRpcSchema,
  recoveryDenialSchema,
  type RecoveryCapability,
  type RecoverySnapshot,
} from "@/domain/commercial-v1-examiner-recovery";
import { getAuthenticatedActor } from "../identity";
import { createSupabase } from "../supabase";

export async function requireRecoveryActor() {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new RecoveryDenied("UNAUTHENTICATED");
  if (
    !actor.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new RecoveryDenied("FORBIDDEN");
  return actor;
}

type Base = {
  sourceExecutionId: string;
  recoveryReason: string;
  capability: RecoveryCapability;
};
export type RecoveryCommand = Base &
  (
    | { operation: "AUTHORIZE"; budget: RecoverySnapshot["budget"] }
    | { operation: "START"; snapshot: RecoverySnapshot }
    | { operation: "CONTEXT_READ"; snapshot: RecoverySnapshot }
    | ({
        operation: "FINALIZE";
        snapshot: RecoverySnapshot;
      } & ExaminerFinalizeCommand)
  );

// Only this module sees the controller key. The adapter receives context
// alone. Canonical order is independently transcribed in migration
// 202609240040 and in tests -- reusing the exact same
// academic_execution_private.controller_keys trust root as initial grading
// (migration 031) and regrade (migration 032), under RECOVERY_PROTOCOL's own
// distinct protocol/policy tags so neither of those attestations can ever
// authorize a recovery transition, and vice versa.
async function executeAttested(executionId: string, command: RecoveryCommand) {
  const actor = await requireRecoveryActor();
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new RecoveryDenied("SERVICE_UNAVAILABLE");
  const id = z.uuid().parse(executionId).toLowerCase();
  const source = z.uuid().parse(command.sourceExecutionId).toLowerCase();
  const snapshot = command.operation === "AUTHORIZE" ? null : command.snapshot;
  const budget =
    command.operation === "AUTHORIZE"
      ? command.budget
      : command.snapshot.budget;
  const usage = examinerUsageReportSchema.parse(
    command.operation === "FINALIZE" ? command.usage : zeroUsage(),
  );
  const state =
    command.operation === "AUTHORIZE"
      ? "AUTHORIZED"
      : command.operation === "FINALIZE"
        ? command.state
        : "RUNNING";
  const reason = command.operation === "FINALIZE" ? command.reason : "NONE";
  const stage =
    command.operation === "FINALIZE" ? (command.budgetStage ?? "NONE") : "NONE";
  const digest = command.operation === "FINALIZE" ? command.gradeDigest : null;
  const targetKind =
    command.capability === "grade_controlled_assessment"
      ? "ASSESSMENT_ATTEMPT"
      : "LAB_SUBMISSION";
  const issuedAt = Math.floor(Date.now() / 1000),
    expiresAt = issuedAt + 10;
  const uuid = (s: string | null | undefined) => s?.toLowerCase() ?? null;
  const canonical = [
    RECOVERY_PROTOCOL,
    RECOVERY_POLICY,
    "EXAMINER",
    EXAMINER_RUNTIME_PROFILE_REF,
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id,
    source,
    Buffer.from(command.recoveryReason, "utf8").toString("hex"),
    command.capability,
    targetKind,
    uuid(snapshot?.studentId) ?? "NONE",
    uuid(snapshot?.attemptId) ?? "NONE",
    uuid(snapshot?.submissionId) ?? "NONE",
    uuid(snapshot?.enrolmentId) ?? "NONE",
    uuid(snapshot?.activationId) ?? "NONE",
    command.operation,
    state,
    reason,
    stage,
    String(budget.maxProviderCalls),
    String(budget.maxOutputTokens),
    String(budget.maxEstimatedCostMicrousd),
    String(usage.providerCalls),
    String(usage.attempts),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.estimatedCostMicrousd),
    String(usage.elapsedMs),
    digest ?? "NONE",
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", Buffer.from(keyHex.data, "hex"))
    .update(canonical, "utf8")
    .digest("hex");
  let data: unknown;
  try {
    const response = await (
      await createSupabase()
    ).rpc("govern_commercial_v1_examiner_recovery", {
      p_key_id: keyId.data,
      p_execution_id: id,
      p_source_execution_id: source,
      p_recovery_reason: command.recoveryReason,
      p_capability: command.capability,
      p_target_kind: targetKind,
      p_student_id: uuid(snapshot?.studentId),
      p_attempt_id: uuid(snapshot?.attemptId),
      p_submission_id: uuid(snapshot?.submissionId),
      p_enrolment_id: uuid(snapshot?.enrolmentId),
      p_activation_id: uuid(snapshot?.activationId),
      p_operation: command.operation,
      p_state: state,
      p_reason: reason,
      p_budget_stage: stage,
      p_max_calls: budget.maxProviderCalls,
      p_max_output: budget.maxOutputTokens,
      p_max_cost: budget.maxEstimatedCostMicrousd,
      p_calls: usage.providerCalls,
      p_attempts: usage.attempts,
      p_input: usage.inputTokens,
      p_output: usage.outputTokens,
      p_cost: usage.estimatedCostMicrousd,
      p_elapsed: usage.elapsedMs,
      p_grade_digest: digest,
      p_issued_at: issuedAt,
      p_expires_at: expiresAt,
      p_mac: mac,
      p_assessment_marks:
        command.operation === "FINALIZE" ? command.assessmentMarks : null,
      p_lab_marks_awarded:
        command.operation === "FINALIZE" ? command.labMarksAwarded : null,
    });
    if (response.error) throw new Error();
    data = response.data;
  } catch {
    throw new RecoveryDenied("SERVICE_UNAVAILABLE");
  }
  const denial = recoveryDenialSchema.safeParse(data);
  if (denial.success)
    throw new RecoveryDenied(
      denial.data.code,
      command.operation !== "AUTHORIZE" &&
        denial.data.code === "EXECUTION_TIMEOUT",
    );
  return { data, actorId: actor.id };
}

export async function attestRecoveryCommand(
  executionId: string,
  command: Exclude<RecoveryCommand, { operation: "CONTEXT_READ" }>,
) {
  const { data, actorId } = await executeAttested(executionId, command);
  const parsed = recoveryRpcSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok)
    throw new RecoveryDenied("SERVICE_UNAVAILABLE");
  const s = parsed.data.execution;
  if (
    s.sourceExecutionId !== command.sourceExecutionId.toLowerCase() ||
    s.capability !== command.capability ||
    (command.operation !== "AUTHORIZE" && s.executionId !== executionId)
  )
    throw new RecoveryDenied("CONTEXT_CONFLICT");
  if (command.operation === "AUTHORIZE") {
    if (
      parsed.data.transitioned
        ? s.actorId !== actorId ||
          s.executionId !== executionId ||
          // Unlike regrade, a fresh recovery AUTHORIZE can itself directly
          // create a durable ESCALATED claim (programme-version EXAMINER
          // config escalationPolicy=ACADEMIC_REVIEW, migration 036's own
          // pattern, reused verbatim in migration 202609240040) -- zero
          // provider calls, terminal on creation.
          (s.state !== "AUTHORIZED" && s.state !== "ESCALATED")
        : s.state === "AUTHORIZED" || s.state === "RUNNING"
    )
      throw new RecoveryDenied("CONTEXT_CONFLICT");
  } else {
    const old = command.snapshot;
    if (
      s.actorId !== actorId ||
      s.actorId !== old.actorId ||
      s.studentId !== old.studentId ||
      s.enrolmentId !== old.enrolmentId ||
      s.activationId !== old.activationId ||
      s.attemptId !== old.attemptId ||
      s.submissionId !== old.submissionId ||
      s.component !== old.component ||
      s.practicalId !== old.practicalId ||
      s.budget.maxProviderCalls !== old.budget.maxProviderCalls ||
      s.budget.maxOutputTokens !== old.budget.maxOutputTokens ||
      s.budget.maxEstimatedCostMicrousd !==
        old.budget.maxEstimatedCostMicrousd ||
      (command.operation === "START"
        ? s.state !== "RUNNING"
        : s.state === "RUNNING" || s.state === "AUTHORIZED")
    )
      throw new RecoveryDenied("CONTEXT_CONFLICT");
  }
  return { snapshot: s, transitioned: parsed.data.transitioned };
}

export async function attestRecoveryContext(
  command: Base & { snapshot: RecoverySnapshot },
) {
  return (
    await executeAttested(command.snapshot.executionId, {
      ...command,
      operation: "CONTEXT_READ",
    })
  ).data;
}
