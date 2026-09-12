import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentAccessSchema,
  counsellorLifecycleSchema,
  deliveryContextSchema,
  deliveryErrorCode,
  DeliveryDenied,
  deliveryPageInput,
  enrolmentInput,
  futureScheduleInput,
  handoffInput,
  handoffSchema,
  studyPlanInput,
  scheduleHistoryInput,
  scheduleHistorySchema,
  startLearningInput,
  startLearningSchema,
  type DeliveryContext,
} from "@/domain/delivery";
import { createSupabase } from "./supabase";
import { getAuthenticatedActor } from "./identity";
import { withValidatedProfessorContent } from "./academic-capabilities";
import { learnerContextSchema } from "@/domain/learning-context";

// No routes/actions or provider tools are added. These ordinary authenticated
// RPCs prove governed learner requests, never autonomous agent execution.
async function call<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const actor = await getAuthenticatedActor();
    if (!actor) throw new DeliveryDenied("UNAUTHENTICATED");
    const { data, error } = await (await createSupabase()).rpc(name, args);
    if (error) {
      const code = deliveryErrorCode.safeParse(error.message);
      throw new DeliveryDenied(
        code.success ? code.data : "SERVICE_UNAVAILABLE",
      );
    }
    const result = schema.parse(data);
    const fresh = await getAuthenticatedActor();
    if (
      !fresh ||
      fresh.id !== actor.id ||
      [...fresh.roles].sort().join() !== [...actor.roles].sort().join()
    )
      throw new DeliveryDenied("CONTEXT_CONFLICT");
    return result;
  } catch (error) {
    if (error instanceof DeliveryDenied) throw error;
    throw new DeliveryDenied("SERVICE_UNAVAILABLE");
  }
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DeliveryDenied("INVALID_INPUT");
  return parsed.data;
}
export function saveDeliveryStudyPlan(value: unknown) {
  const p = input(studyPlanInput, value);
  return call(
    "save_delivery_study_plan",
    {
      p_enrolment_id: p.enrolmentId,
      p_study_days: p.studyDays ?? null,
      p_local_start_time: p.localStartTime ?? null,
      p_timezone: p.timezone ?? null,
    },
    z.uuid(),
  );
}
export function confirmDeliveryStudyPlan(value: unknown) {
  const p = input(enrolmentInput, value);
  return call(
    "confirm_delivery_study_plan",
    { p_enrolment_id: p.enrolmentId },
    z.uuid(),
  );
}
export function changeFutureDeliverySchedule(value: unknown) {
  const p = input(futureScheduleInput, value);
  return call(
    "change_future_delivery_schedule",
    {
      p_enrolment_id: p.enrolmentId,
      p_study_days: p.studyDays,
      p_local_start_time: p.localStartTime,
      p_timezone: p.timezone,
      p_effective_on: p.effectiveOn,
    },
    z.uuid(),
  );
}
export async function startScheduledLearning(value: unknown) {
  const p = input(startLearningInput, value);
  const result = await call(
    "start_scheduled_learning",
    { p_occurrence_id: p.occurrenceId },
    startLearningSchema,
  );
  if (result.occurrenceId !== p.occurrenceId)
    throw new DeliveryDenied("CONTEXT_CONFLICT");
  return result;
}
async function context(value: unknown, staff: boolean) {
  const p = input(deliveryPageInput, value);
  const result = await call(
    staff ? "get_delivery_admin_context" : "get_delivery_context",
    { p_enrolment_id: p.enrolmentId, p_cursor: p.cursor ?? 0 },
    deliveryContextSchema,
  );
  if (result.enrolmentId !== p.enrolmentId)
    throw new DeliveryDenied("CONTEXT_CONFLICT");
  return result;
}
export const getDeliveryContext = (value: unknown) => context(value, false);
export const getDeliveryAdminContext = (value: unknown) => context(value, true);
async function history(value: unknown, staff: boolean) {
  const p = input(scheduleHistoryInput, value);
  const result = await call(
    staff
      ? "get_delivery_admin_schedule_history"
      : "get_delivery_schedule_history",
    { p_enrolment_id: p.enrolmentId, p_revision: p.revision },
    scheduleHistorySchema,
  );
  if (result.enrolmentId !== p.enrolmentId || result.revision !== p.revision)
    throw new DeliveryDenied("CONTEXT_CONFLICT");
  return result;
}
export const getDeliveryScheduleHistory = (value: unknown) =>
  history(value, false);
export const getDeliveryAdminScheduleHistory = (value: unknown) =>
  history(value, true);
export async function getDeliveryAgentAccess(value: unknown) {
  const p = input(enrolmentInput, value);
  const result = await call(
    "get_delivery_agent_access",
    { p_enrolment_id: p.enrolmentId },
    agentAccessSchema,
  );
  if (result.enrolmentId !== p.enrolmentId)
    throw new DeliveryDenied("CONTEXT_CONFLICT");
  return result;
}
export const getCounsellorLifecycle = () =>
  call("get_counsellor_lifecycle", {}, counsellorLifecycleSchema);
export function requestDeliveryHandoff(value: unknown) {
  const p = input(handoffInput, value);
  return call(
    "request_delivery_handoff",
    {
      p_enrolment_id: p.enrolmentId,
      p_lesson_id: p.lessonId,
      p_objective_id: p.objectiveId ?? null,
      p_reason_code: p.reasonCode,
      p_request_id: randomUUID(),
    },
    z.uuid(),
  );
}
async function handoffs(value: unknown, staff: boolean) {
  const p = input(deliveryPageInput, value);
  const result = await call(
    staff ? "list_delivery_admin_handoffs" : "list_delivery_handoffs",
    { p_enrolment_id: p.enrolmentId, p_cursor: p.cursor ?? 0 },
    z.array(handoffSchema).max(20),
  );
  if (result.some((h) => h.enrolment_id !== p.enrolmentId))
    throw new DeliveryDenied("CONTEXT_CONFLICT");
  return result;
}
export const listDeliveryHandoffs = (value: unknown) => handoffs(value, false);
export const listDeliveryAdminHandoffs = (value: unknown) =>
  handoffs(value, true);

// Scheduling references only, within the existing release/validation boundary.
// The nine JSON capabilities are unchanged. Future Professor orchestration can
// page the backlog and fetch each lesson/objective via existing reviewed reads.
export async function getProfessorDeliveryContext(
  value: unknown,
): Promise<DeliveryContext> {
  const p = input(deliveryPageInput, value);
  let result: DeliveryContext | undefined;
  let failure: DeliveryDenied | undefined;
  const outcome = await withValidatedProfessorContent(
    {
      capability: "get_current_learner_context",
      input: { enrolmentId: p.enrolmentId },
    },
    async ({ data }) => {
      try {
        const access = await getDeliveryAgentAccess({
          enrolmentId: p.enrolmentId,
        });
        if (access.PROFESSOR !== "AVAILABLE")
          throw new DeliveryDenied(
            access.PROFESSOR === "ACTIVITY_BLOCKED"
              ? "ACTIVITY_BLOCKED"
              : "POLICY_BLOCKED",
          );
        result = await getDeliveryContext(p);
        const enrolment = learnerContextSchema.parse(data);
        if (
          result.plan &&
          result.plan.programmeVersionId !== enrolment.programmeVersionId
        )
          throw new DeliveryDenied("CONTEXT_CONFLICT");
        const finalAccess = await getDeliveryAgentAccess({
          enrolmentId: p.enrolmentId,
        });
        if (finalAccess.PROFESSOR !== "AVAILABLE")
          throw new DeliveryDenied("POLICY_BLOCKED");
      } catch (error) {
        if (error instanceof DeliveryDenied) failure = error;
        throw error;
      }
    },
  );
  if (outcome.releaseFinalizationFailed)
    throw new DeliveryDenied("SERVICE_UNAVAILABLE");
  if (failure) throw failure;
  if (!outcome.result.ok) {
    const code = deliveryErrorCode.safeParse(outcome.result.error.code);
    throw new DeliveryDenied(code.success ? code.data : "SERVICE_UNAVAILABLE");
  }
  if (!result) throw new DeliveryDenied("SERVICE_UNAVAILABLE");
  return result;
}
