import "server-only";
import { z } from "zod";
import {
  bindCommercialV1ComponentInputSchema,
  publishCommercialV1GradingPolicyInputSchema,
  commercialV1ActiveAttemptSchema,
  recordCommercialV1ResponseInputSchema,
  recordCommercialV1ResponseResultSchema,
  policySetupOptionsSchema,
  type PolicySetupOptions,
} from "@/domain/commercial-v1-assessment-policy";
import { requireActor, requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

// Governed admin surface: only ACADEMIC_ADMIN/PLATFORM_ADMIN may bind a
// formal component or publish a grading policy (mirroring
// src/server/course-activation.ts's own admin gate). Neither wrapper
// accepts (nor forwards) a weight, profile, or lab-presence parameter --
// there is no such field anywhere on the input schemas, so nothing here
// could smuggle one through even if a caller tried.
export async function bindCommercialV1AssessmentComponent(input: unknown) {
  const payload = bindCommercialV1ComponentInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "bind_commercial_v1_assessment_component",
    {
      p_activation_id: payload.activationId,
      p_component: payload.component,
      p_assessment_id: payload.assessmentId,
      p_reason: payload.reason,
    },
  );
  if (error) throw new Error("Commercial V1 component could not be bound.");
  return z.uuid().parse(data);
}

// Independent-review Finding 2: bounded admin read of one activation's real
// assessments/practicals/current policy state, so bindComponentAction/
// setLabPolicyAction can be driven from real selectable options rather than
// a blind-typed internal UUID. Read-only; adds no writing authority.
export async function getCommercialV1PolicySetupOptions(
  activationId: unknown,
): Promise<PolicySetupOptions> {
  const id = z.uuid().parse(activationId);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "get_commercial_v1_policy_setup_options",
    { p_activation_id: id },
  );
  if (error) throw new Error("Policy setup options could not be loaded.");
  return policySetupOptionsSchema.parse(data);
}

export async function publishCommercialV1GradingPolicy(input: unknown) {
  const payload = publishCommercialV1GradingPolicyInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "publish_commercial_v1_grading_policy",
    {
      p_activation_id: payload.activationId,
      p_reason: payload.reason,
    },
  );
  if (error)
    throw new Error("Commercial V1 grading policy could not be published.");
  return z.uuid().parse(data);
}

// Learner-facing resume: bounded, safe fields only (never a question
// prompt, answer key, or marking guidance -- those remain behind the
// existing protected-content release, untouched by this checkpoint).
export async function getCommercialV1ActiveAttempt() {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_commercial_v1_active_attempt");
  if (error) throw new Error("Your active assessment could not be loaded.");
  return commercialV1ActiveAttemptSchema.parse(data);
}

// The dedicated Commercial V1 response surface (independent review
// blocker fix). Deliberately never used for a non-governed attempt --
// record_commercial_v1_assessment_response itself refuses those
// (NOT_COMMERCIAL_V1_GOVERNED) -- and the legacy record_assessment_response
// RPC symmetrically refuses a governed attempt, so neither path can be
// used to bypass the other's semantics. An EXPIRED result here means the
// database ALREADY durably finalized the attempt AUTO_TIMEOUT in this same
// call -- it is not a transient/local value the caller must separately act
// on to make the transition happen.
export async function recordCommercialV1AssessmentResponse(input: unknown) {
  const payload = recordCommercialV1ResponseInputSchema.parse(input);
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "record_commercial_v1_assessment_response",
    {
      p_attempt_id: payload.attemptId,
      p_question_id: payload.questionId,
      p_body: payload.body,
      p_idempotency_key: payload.idempotencyKey,
    },
  );
  if (error) throw new Error("Your response could not be saved.");
  return recordCommercialV1ResponseResultSchema.parse(data);
}
