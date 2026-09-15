import "server-only";
import { z } from "zod";
import {
  setCommercialV1LabPolicyInputSchema,
  publishCommercialV1ResultPolicyInputSchema,
  submitCommercialV1LabWorkInputSchema,
  attemptCommercialV1CourseCompletionInputSchema,
  commercialV1CourseProgressSchema,
  listCommercialV1ObjectiveDiagnosticsInputSchema,
  commercialV1ObjectiveDiagnosticsSchema,
  attemptCommercialV1CourseCompletionResultSchema,
} from "@/domain/commercial-v1-results-completion";
import { requireActor, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

// Governed admin surface: only ACADEMIC_ADMIN/PLATFORM_ADMIN may configure a
// lab policy or publish the result policy. Neither wrapper accepts a
// caller-supplied mark -- there is no such field anywhere on either input
// schema.
export async function setCommercialV1LabPolicy(input: unknown) {
  const payload = setCommercialV1LabPolicyInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc("set_commercial_v1_lab_policy", {
    p_activation_id: payload.activationId,
    p_practical_id: payload.practicalId,
    p_max_marks: payload.maxMarks,
    p_contribution_bp: payload.contributionBp,
    p_grading_guidance: payload.gradingGuidance,
    p_reason: payload.reason,
  });
  if (error) throw new Error("Commercial V1 lab policy could not be saved.");
  return z.uuid().parse(data);
}

export async function publishCommercialV1ResultPolicy(input: unknown) {
  const payload = publishCommercialV1ResultPolicyInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "publish_commercial_v1_result_policy",
    {
      p_activation_id: payload.activationId,
      p_pass_mark_bp: payload.passMarkBp,
      p_require_remediation_clear_for_completion:
        payload.requireRemediationClearForCompletion,
      p_reason: payload.reason,
    },
  );
  if (error)
    throw new Error("Commercial V1 result policy could not be published.");
  return z.uuid().parse(data);
}

// Learner-owned final lab submission. Text only; grading is deferred to
// 11B's trusted, controller-bound Examiner finalization.
export async function submitCommercialV1LabWork(input: unknown) {
  const payload = submitCommercialV1LabWorkInputSchema.parse(input);
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc("submit_commercial_v1_lab_work", {
    p_enrolment_id: payload.enrolmentId,
    p_practical_id: payload.practicalId,
    p_body: payload.body,
    p_idempotency_key: payload.idempotencyKey,
  });
  if (error) throw new Error("Your lab submission could not be saved.");
  return z.uuid().parse(data);
}

// Bounded projection: self-scoped for the owning learner; an admin may also
// read any enrolment's progress. Never exposes protected content.
export async function getCommercialV1CourseProgress(enrolmentId: unknown) {
  const id = z.uuid().parse(enrolmentId);
  await requireActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_commercial_v1_course_progress",
    { p_enrolment_id: id },
  );
  if (error) throw new Error("Course progress could not be loaded.");
  return commercialV1CourseProgressSchema.parse(data);
}

export async function listCommercialV1ObjectiveDiagnostics(input: unknown) {
  const payload = listCommercialV1ObjectiveDiagnosticsInputSchema.parse(input);
  await requireActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "list_commercial_v1_objective_diagnostics",
    {
      p_enrolment_id: payload.enrolmentId,
      p_limit: payload.limit,
      p_offset: payload.offset,
    },
  );
  if (error) throw new Error("Objective diagnostics could not be loaded.");
  return commercialV1ObjectiveDiagnosticsSchema.parse(data);
}

// Self-scoped (or admin) completion attempt. Deterministic: every gate is
// evaluated server-side from persisted, immutable result/policy state --
// never from a client-supplied score or flag.
export async function attemptCommercialV1CourseCompletion(input: unknown) {
  const payload = attemptCommercialV1CourseCompletionInputSchema.parse(input);
  await requireActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "attempt_commercial_v1_course_completion",
    { p_enrolment_id: payload.enrolmentId, p_reason: payload.reason },
  );
  if (error) throw new Error("Course completion could not be evaluated.");
  return attemptCommercialV1CourseCompletionResultSchema.parse(data);
}
