import "server-only";
import { z } from "zod";
import {
  activationInput,
  activationOptions,
  commercialV1ActivationListSchema,
  practicalInput,
  practicalSchema,
  practicalSupportInput,
  CourseActivationError,
} from "@/domain/course-activation";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";
const codes = new Set([
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_STATE",
  "INVALID_INSTRUCTOR",
  "TEMPLATE_MISMATCH",
  "NOT_FOUND_OR_FORBIDDEN",
  "ACTIVATION_CONFLICT",
  "CONFIG_CONFLICT",
  "PROVENANCE_CONFLICT",
  "ACTIVITY_BLOCKED",
  "LIMIT_EXCEEDED",
  "POLICY_BLOCKED",
]);
async function rpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
  admin = false,
): Promise<T> {
  try {
    const actor = await getAuthenticatedActor();
    if (
      !actor ||
      !(admin
        ? actor.roles.some(
            (r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN",
          )
        : actor.roles.includes("STUDENT"))
    )
      throw new CourseActivationError("FORBIDDEN");
    const { data, error } = await (await createSupabase()).rpc(name, args);
    if (error)
      throw new CourseActivationError(
        codes.has(error.message) ? error.message : "SERVICE_UNAVAILABLE",
      );
    const result = schema.parse(data);
    const fresh = await getAuthenticatedActor();
    if (
      !fresh ||
      fresh.id !== actor.id ||
      [...fresh.roles].sort().join() !== [...actor.roles].sort().join()
    )
      throw new CourseActivationError("FORBIDDEN");
    return result;
  } catch (e) {
    if (e instanceof CourseActivationError) throw e;
    throw new CourseActivationError("SERVICE_UNAVAILABLE");
  }
}
function input<T>(schema: z.ZodType<T>, value: unknown) {
  const p = schema.safeParse(value);
  if (!p.success) throw new CourseActivationError("INVALID_INPUT");
  return p.data;
}
export async function activateCoursePackage(value: unknown) {
  const p = input(activationInput, value);
  return rpc(
    "activate_course_package",
    {
      p_import_id: p.importId,
      p_cohort_id: p.cohortId,
      p_instructor_id: p.instructorId,
      p_assignments: p.assignments,
      p_assessments: p.assessments,
      p_reason: p.reason,
    },
    z.uuid(),
    true,
  );
}
export async function getCourseActivationOptions(importId: unknown = null) {
  const id = input(z.uuid().nullable(), importId);
  return rpc(
    "get_course_activation_options",
    { p_import_id: id },
    activationOptions,
    true,
  );
}
// Independent-review operational-closure checkpoint (E1): bounded admin
// discovery read so an authorized admin can browse real Commercial V1
// activations by programme/package/cohort instead of already knowing an
// internal UUID. Admin-gated identically to every other read in this file.
export async function listCommercialV1Activations() {
  return rpc(
    "list_commercial_v1_activations",
    {},
    commercialV1ActivationListSchema,
    true,
  );
}

export async function listPracticalEnrolments() {
  return rpc(
    "list_practical_enrolments",
    {},
    z
      .array(
        z.strictObject({ id: z.uuid(), title: z.string(), status: z.string() }),
      )
      .max(100),
  );
}
export async function listMyPracticals(value: unknown) {
  const p = input(practicalInput, value);
  return rpc(
    "list_my_practicals",
    { p_enrolment_id: p.enrolmentId, p_cursor: p.cursor ?? 0 },
    z.array(practicalSchema).max(20),
  );
}
export async function requestPracticalSupport(value: unknown) {
  const p = input(practicalSupportInput, value);
  return rpc(
    "request_practical_support",
    {
      p_enrolment_id: p.enrolmentId,
      p_practical_id: p.practicalId,
      p_request_id: p.requestId,
    },
    z.uuid(),
  );
}
export async function getMyCourseworkScope() {
  return rpc(
    "my_coursework_scope",
    {},
    z.strictObject({
      actorId: z.uuid(),
      cohortIds: z.array(z.uuid()).max(1000),
    }),
  );
}
