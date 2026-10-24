import { z } from "zod";
import { agentConfigurationSchema } from "./course-package";

export const unifiedPublicationSchema = z.strictObject({
  packageId: z.uuid(),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  currency: z.enum(["GBP", "USD", "EUR"]),
  amountMinor: z.number().int().min(1).max(100000000),
  summary: z.string().trim().min(1).max(500).nullable(),
  reason: z.string().trim().min(5).max(300),
});

// These currencies all use two decimal places. Reject fractional pennies
// and exponential notation rather than silently rounding a commercial term.
export function parseCoursePrice(value: FormDataEntryValue | null): number {
  const price = String(value ?? "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(price)) throw new Error("INVALID_PRICE");
  const [whole, fraction = ""] = price.split(".");
  return z
    .number()
    .int()
    .min(1)
    .max(100000000)
    .parse(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}

export const courseAgentsSchema = agentConfigurationSchema;
export const unifiedPublicationResultSchema = z.strictObject({
  courseId: z.uuid(),
  offerId: z.uuid(),
  replayed: z.boolean(),
});
