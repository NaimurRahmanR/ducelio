import "server-only";
import { z } from "zod";
import {
  examinerAssessmentContextSchema,
  examinerLabContextSchema,
  ExaminerExecutionDenied,
  type ExaminerAssessmentContext,
  type ExaminerLabContext,
} from "@/domain/commercial-v1-examiner-grading";
import { createSupabase } from "../supabase";
import { attestExaminerContextRead } from "./authority";

const denialSchema = z.strictObject({ ok: z.literal(false), code: z.string() });
const assessmentResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    ...examinerAssessmentContextSchema.shape,
  }),
  denialSchema,
]);
const labResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), ...examinerLabContextSchema.shape }),
  denialSchema,
]);

// Blocker 1 (independent review, V2): reads the protected assessment
// context ONLY after producing a fresh CONTEXT_READ controller attestation
// -- ownership plus a RUNNING execution UUID is never sufficient on its
// own. The database independently re-verifies the MAC and additionally
// re-checks the execution is RUNNING and unexpired at read time (migration
// 031). Never returned to a browser: this module is imported only by the
// server-only orchestrator (./index.ts), which forwards a bounded provider
// request, never this raw object, further.
export async function getExaminerAssessmentContext(
  executionId: string,
  target: { attemptId: string; enrolmentId: string; activationId: string },
): Promise<ExaminerAssessmentContext> {
  const attestation = await attestExaminerContextRead(executionId, {
    capability: "grade_controlled_assessment",
    targetKind: "ASSESSMENT_ATTEMPT",
    attemptId: target.attemptId,
    submissionId: null,
    enrolmentId: target.enrolmentId,
    activationId: target.activationId,
  });
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_commercial_v1_examiner_assessment_context",
    { ...attestation, p_attempt_id: target.attemptId },
  );
  if (error) throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
  const result = assessmentResultSchema.parse(data);
  if (!result.ok) throw new ExaminerExecutionDenied("EXECUTION_UNAVAILABLE");
  const { ok: _ok, ...context } = result;
  void _ok;
  return context;
}

export async function getExaminerLabContext(
  executionId: string,
  target: { submissionId: string; enrolmentId: string; activationId: string },
): Promise<ExaminerLabContext> {
  const attestation = await attestExaminerContextRead(executionId, {
    capability: "grade_practical_lab",
    targetKind: "LAB_SUBMISSION",
    attemptId: null,
    submissionId: target.submissionId,
    enrolmentId: target.enrolmentId,
    activationId: target.activationId,
  });
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_commercial_v1_examiner_lab_context",
    { ...attestation, p_submission_id: target.submissionId },
  );
  if (error) throw new ExaminerExecutionDenied("SERVICE_UNAVAILABLE");
  const result = labResultSchema.parse(data);
  if (!result.ok) throw new ExaminerExecutionDenied("EXECUTION_UNAVAILABLE");
  const { ok: _ok, ...context } = result;
  void _ok;
  return context;
}
