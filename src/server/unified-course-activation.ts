import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
import { AccessDenied } from "@/domain/policy";

const outcome = z.object({
  ok: z.boolean(),
  requestId: z.uuid().optional(),
  state: z.string(),
  replayed: z.boolean(),
});
const recovery = z.strictObject({
  id: z.uuid(),
  itemId: z.uuid(),
  state: z.enum(["PENDING", "APPROVED", "DENIED"]),
  opensAt: z.string(),
  closesAt: z.string(),
  reasonCode: z.string(),
});
async function call<T>(
  role: "student" | "admin",
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
) {
  const actor = await requireActor(role === "student" ? "student" : undefined);
  if (!actor) throw new AccessDenied();
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error)
    throw new Error(
      [
        "NOT_RELEASED",
        "ACTIVITY_BLOCKED",
        "RECOVERY_NOT_ELIGIBLE",
        "INVALID_RECOVERY_TIME",
        "RECOVERY_ALREADY_REQUESTED",
        "REQUEST_CONFLICT",
      ].includes(error.message)
        ? error.message
        : "RECOVERY_UNAVAILABLE",
    );
  return schema.parse(data);
}
export const listMyRecoveries = (id: string) =>
  call(
    "student",
    "list_my_course_recoveries",
    { p_enrolment_id: z.uuid().parse(id) },
    z.array(recovery),
  );
export function requestMyRecovery(input: unknown) {
  const p = z
    .strictObject({
      enrolmentId: z.uuid(),
      itemId: z.uuid(),
      opensAt: z.iso.datetime(),
      reasonCode: z.enum(["MISSED_WINDOW", "TECHNICAL_ISSUE"]),
      requestKey: z.uuid(),
    })
    .parse(input);
  return call(
    "student",
    "request_my_course_recovery",
    {
      p_enrolment_id: p.enrolmentId,
      p_item_id: p.itemId,
      p_opens_at: p.opensAt,
      p_reason_code: p.reasonCode,
      p_request_key: p.requestKey,
    },
    outcome,
  );
}
export const listCourseRecoveries = () =>
  call(
    "admin",
    "list_course_recoveries",
    {},
    z.array(recovery.extend({ enrolmentId: z.uuid() })),
  );
export const reviewCourseRecovery = (
  id: unknown,
  approve: boolean,
  reason: unknown,
) =>
  call(
    "admin",
    "review_course_recovery",
    {
      p_request_id: z.uuid().parse(id),
      p_approve: z.boolean().parse(approve),
      p_reason: z.string().trim().min(5).max(300).parse(reason),
    },
    outcome,
  );
export const getMyRevision = (enrolmentId: string, itemId: string) =>
  call(
    "student",
    "get_my_unified_revision",
    {
      p_enrolment_id: z.uuid().parse(enrolmentId),
      p_item_id: z.uuid().parse(itemId),
    },
    z.strictObject({
      title: z.string(),
      objectives: z.array(
        z.strictObject({ title: z.string(), description: z.string() }),
      ),
    }),
  );
