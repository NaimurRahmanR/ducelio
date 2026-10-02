import "server-only";
import { requireAnyRole } from "./identity";
import { createSupabase } from "./supabase";
import {
  rescheduleInputSchema,
  batchInputSchema,
  discoveryInputSchema,
  operationOutcomeSchema,
  discoverySchema,
  batchOptionsSchema,
  batchOptionsInputSchema,
  SessionOperationError,
  sessionErrorCode,
} from "@/domain/session-operations";
const roles = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;
async function rpc(name: string, args: Record<string, unknown>) {
  const client = await createSupabase();
  const { data, error } = await client.rpc(name, args);
  if (error) throw new SessionOperationError(sessionErrorCode(error));
  return data;
}
export async function rescheduleClassSession(value: unknown) {
  await requireAnyRole(roles);
  const x = rescheduleInputSchema.parse(value);
  return operationOutcomeSchema.parse(
    await rpc("reschedule_class_session", {
      p_session_id: x.sessionId,
      p_scheduled_start: x.scheduledStart,
      p_request_id: x.requestId,
      p_reason: x.reason,
    }),
  );
}
export async function generateClassSessionBatch(value: unknown) {
  await requireAnyRole(roles);
  const x = batchInputSchema.parse(value);
  return operationOutcomeSchema.parse(
    await rpc("generate_class_session_batch", {
      p_request_id: x.requestId,
      p_activation_id: x.activationId,
      p_instructor_id: x.instructorId,
      p_items: x.items,
      p_reason: x.reason,
    }),
  );
}
export async function listSessionOperations(value: unknown) {
  await requireAnyRole(roles);
  const x = discoveryInputSchema.parse(value);
  return discoverySchema.parse(
    await rpc("admin_list_class_session_operations", {
      p_cohort_id: x.cohortId ?? null,
      p_status: x.status ?? null,
      p_from: x.from ?? null,
      p_until: x.until ?? null,
      p_offset: x.offset,
      p_session_id: x.sessionId ?? null,
    }),
  );
}
export async function getSessionBatchOptions(value: unknown = {}) {
  await requireAnyRole(roles);
  const x = batchOptionsInputSchema.parse(value);
  return batchOptionsSchema.parse(
    await rpc("admin_class_session_batch_options", {
      p_activation_id: x.activationId ?? null,
      p_activation_offset: x.activationOffset,
      p_lesson_offset: x.lessonOffset,
    }),
  );
}
