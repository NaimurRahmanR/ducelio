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
  REGRADE_POLICY,
  REGRADE_PROTOCOL,
  RegradeDenied,
  regradeRpcSchema,
  regradeDenialSchema,
  type RegradeCapability,
  type RegradeSnapshot,
} from "@/domain/commercial-v1-examiner-regrade";
import { getAuthenticatedActor } from "../identity";
import { createSupabase } from "../supabase";

export async function requireRegradeActor() {
  const actor = await getAuthenticatedActor();
  if (!actor) throw new RegradeDenied("UNAUTHENTICATED");
  if (
    !actor.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new RegradeDenied("FORBIDDEN");
  return actor;
}

type Base = {
  sourceResultRevisionId: string;
  requestReason: string;
  capability: RegradeCapability;
};
export type RegradeCommand = Base &
  (
    | { operation: "AUTHORIZE"; budget: RegradeSnapshot["budget"] }
    | { operation: "START"; snapshot: RegradeSnapshot }
    | { operation: "CONTEXT_READ"; snapshot: RegradeSnapshot }
    | ({
        operation: "FINALIZE";
        snapshot: RegradeSnapshot;
      } & ExaminerFinalizeCommand)
  );

// Only this module sees the controller key. The adapter receives context alone.
// Canonical order is independently transcribed in migration 032 and tests.
async function executeAttested(executionId: string, command: RegradeCommand) {
  const actor = await requireRegradeActor();
  const keyId = z.uuid().safeParse(process.env.ACADEMIC_EXECUTION_KEY_ID);
  const keyHex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .safeParse(process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX);
  if (!keyId.success || !keyHex.success)
    throw new RegradeDenied("SERVICE_UNAVAILABLE");
  const id = z.uuid().parse(executionId).toLowerCase();
  const source = z.uuid().parse(command.sourceResultRevisionId).toLowerCase();
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
    command.capability === "regrade_controlled_assessment"
      ? "ASSESSMENT_ATTEMPT"
      : "LAB_SUBMISSION";
  const issuedAt = Math.floor(Date.now() / 1000),
    expiresAt = issuedAt + 10;
  const uuid = (s: string | null | undefined) => s?.toLowerCase() ?? null;
  const canonical = [
    REGRADE_PROTOCOL,
    REGRADE_POLICY,
    "EXAMINER",
    EXAMINER_RUNTIME_PROFILE_REF,
    keyId.data.toLowerCase(),
    actor.id.toLowerCase(),
    id,
    source,
    Buffer.from(command.requestReason, "utf8").toString("hex"),
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
    ).rpc("govern_commercial_v1_examiner_regrade", {
      p_key_id: keyId.data,
      p_execution_id: id,
      p_source_id: source,
      p_request_reason: command.requestReason,
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
    throw new RegradeDenied("SERVICE_UNAVAILABLE");
  }
  const denial = regradeDenialSchema.safeParse(data);
  if (denial.success)
    throw new RegradeDenied(
      denial.data.code,
      command.operation !== "AUTHORIZE" &&
        denial.data.code === "EXECUTION_TIMEOUT",
    );
  return { data, actorId: actor.id };
}

export async function attestRegradeCommand(
  executionId: string,
  command: Exclude<RegradeCommand, { operation: "CONTEXT_READ" }>,
) {
  const { data, actorId } = await executeAttested(executionId, command);
  const parsed = regradeRpcSchema.safeParse(data);
  if (!parsed.success || !parsed.data.ok)
    throw new RegradeDenied("SERVICE_UNAVAILABLE");
  const s = parsed.data.execution;
  if (
    s.sourceResultRevisionId !== command.sourceResultRevisionId.toLowerCase() ||
    s.capability !== command.capability ||
    (command.operation !== "AUTHORIZE" && s.executionId !== executionId)
  )
    throw new RegradeDenied("CONTEXT_CONFLICT");
  if (command.operation === "AUTHORIZE") {
    if (
      parsed.data.transitioned
        ? s.actorId !== actorId ||
          s.executionId !== executionId ||
          s.state !== "AUTHORIZED"
        : s.state === "AUTHORIZED" || s.state === "RUNNING"
    )
      throw new RegradeDenied("CONTEXT_CONFLICT");
  } else {
    const old = command.snapshot;
    if (
      s.actorId !== actorId ||
      s.actorId !== old.actorId ||
      s.studentId !== old.studentId ||
      s.enrolmentId !== old.enrolmentId ||
      s.activationId !== old.activationId ||
      s.sourceRevisionNumber !== old.sourceRevisionNumber ||
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
      throw new RegradeDenied("CONTEXT_CONFLICT");
  }
  return { snapshot: s, transitioned: parsed.data.transitioned };
}

export async function attestRegradeContext(
  command: Base & { snapshot: RegradeSnapshot },
) {
  return (
    await executeAttested(command.snapshot.executionId, {
      ...command,
      operation: "CONTEXT_READ",
    })
  ).data;
}
