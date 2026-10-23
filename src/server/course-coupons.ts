import "server-only";
import { z } from "zod";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
import { AccessDenied } from "@/domain/policy";

export const couponInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{3,39}$/),
  percentOff: z.number().int().min(1).max(100),
  expiresAt: z.iso.datetime(),
  redemptionLimit: z.number().int().min(1).max(1000000),
  courseId: z.uuid().nullable(),
  reason: z.string().trim().min(5).max(300),
});
const couponSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  percentOff: z.number().int(),
  expiresAt: z.string(),
  redemptionLimit: z.number().int(),
  courseId: z.uuid().nullable(),
  active: z.boolean(),
  reserved: z.number().int(),
  redeemed: z.number().int(),
});
const redemptionSchema = z.strictObject({
  id: z.uuid(),
  learnerId: z.uuid(),
  courseId: z.uuid(),
  orderId: z.uuid().nullable(),
  listAmountMinor: z.number().int(),
  discountAmountMinor: z.number().int(),
  createdAt: z.string(),
  state: z.enum(["RESERVED", "REDEEMED"]),
});
async function couponRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const actor = await requireActor("admin");
  if (
    !actor.roles.some((r) => r === "ACADEMIC_ADMIN" || r === "PLATFORM_ADMIN")
  )
    throw new AccessDenied();
  const { data, error } = await (await createSupabase()).rpc(name, args);
  if (error)
    throw new Error(
      ["INVALID_INPUT", "NOT_FOUND", "COUPON_CONFLICT"].includes(error.message)
        ? error.message
        : "COUPON_SERVICE_UNAVAILABLE",
    );
  return schema.parse(data);
}
export async function createCourseCoupon(input: unknown) {
  const p = couponInputSchema.parse(input);
  return couponRpc(
    "create_course_coupon",
    {
      p_code: p.code,
      p_percent_off: p.percentOff,
      p_expires_at: p.expiresAt,
      p_redemption_limit: p.redemptionLimit,
      p_course_id: p.courseId,
      p_reason: p.reason,
    },
    z.uuid(),
  );
}
export const listCourseCoupons = () =>
  couponRpc("list_course_coupons", {}, z.array(couponSchema));
export const getCourseCouponRedemptions = (id: unknown) =>
  couponRpc(
    "get_course_coupon_redemptions",
    { p_coupon_id: z.uuid().parse(id) },
    z.array(redemptionSchema),
  );
export const setCourseCouponActive = (
  id: unknown,
  active: boolean,
  reason: string,
) =>
  couponRpc(
    "set_course_coupon_active",
    {
      p_coupon_id: z.uuid().parse(id),
      p_active: z.boolean().parse(active),
      p_reason: z.string().trim().min(5).max(300).parse(reason),
    },
    z.uuid(),
  );
