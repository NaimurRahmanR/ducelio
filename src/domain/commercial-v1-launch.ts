import { z } from "zod";

export const COMMERCIAL_V1_LAUNCH_POLICY =
  "COMMERCIAL_V1_LAUNCH_V1" as const;

export const deliveryPlanSchema = z.enum([
  "ACCELERATED_2_WEEK",
  "INTENSIVE_4_WEEK",
  "STANDARD_6_WEEK",
]);
export type DeliveryPlan = z.infer<typeof deliveryPlanSchema>;

export const DELIVERY_PLAN_DEFINITIONS = {
  ACCELERATED_2_WEEK: {
    weeks: 2,
    durationDays: 14,
    label: "2-week Accelerated",
  },
  INTENSIVE_4_WEEK: {
    weeks: 4,
    durationDays: 28,
    label: "4-week Intensive",
  },
  STANDARD_6_WEEK: {
    weeks: 6,
    durationDays: 42,
    label: "6-week Standard",
  },
} as const satisfies Record<
  DeliveryPlan,
  { weeks: number; durationDays: number; label: string }
>;

export const campaignCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4)
  .max(32)
  .regex(
    /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
    "Use 4-32 uppercase letters/numbers with optional internal hyphens.",
  );

export const campaignKindSchema = z.enum([
  "PERCENT_OFF",
  "FIXED_PRICE",
  "REVIEWER_COMPLIMENTARY",
]);
export type CampaignKind = z.infer<typeof campaignKindSchema>;

export const commercialV1EntitlementSourceSchema = z.enum([
  "PAID_ORDER",
  "PROMOTIONAL",
  "REVIEWER",
]);
export type CommercialV1EntitlementSource = z.infer<
  typeof commercialV1EntitlementSourceSchema
>;

const priceMinorSchema = z.number().int().min(0).max(100_000_000);
const listPriceMinorSchema = z.number().int().min(1).max(100_000_000);

export const campaignPricingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("PERCENT_OFF"),
    percentOff: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("FIXED_PRICE"),
    fixedPriceAmountMinor: priceMinorSchema,
  }),
  z.strictObject({
    kind: z.literal("REVIEWER_COMPLIMENTARY"),
  }),
]);
export type CampaignPricing = z.infer<typeof campaignPricingSchema>;

export function calculateCampaignPrice(
  listPriceAmountMinor: number,
  pricing: CampaignPricing,
) {
  const listPrice = listPriceMinorSchema.parse(listPriceAmountMinor);
  const parsed = campaignPricingSchema.parse(pricing);

  if (parsed.kind === "PERCENT_OFF") {
    // All money remains integer minor units. The discount itself is rounded
    // down, so the campaign never discounts by more than the stated percent.
    const discount = Math.floor((listPrice * parsed.percentOff) / 100);
    return listPrice - discount;
  }

  if (parsed.kind === "FIXED_PRICE") {
    if (parsed.fixedPriceAmountMinor > listPrice) {
      throw new Error("A campaign cannot increase the offer price.");
    }
    return parsed.fixedPriceAmountMinor;
  }

  return 0;
}

const boundedTimestampSchema = z
  .string()
  .trim()
  .min(10)
  .max(50)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Use a valid timestamp.",
  );

const commonCampaignFields = {
  offerSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(3)
    .max(80),
  code: campaignCodeSchema,
  maxRedemptions: z.number().int().min(1).max(1_000_000),
  startsAt: boundedTimestampSchema,
  endsAt: boundedTimestampSchema,
  reason: z.string().trim().min(5).max(300),
};

export const createCommercialV1CampaignInputSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...commonCampaignFields,
      kind: z.literal("PERCENT_OFF"),
      percentOff: z.number().int().min(1).max(100),
    }),
    z.strictObject({
      ...commonCampaignFields,
      kind: z.literal("FIXED_PRICE"),
      fixedPriceAmountMinor: priceMinorSchema,
    }),
    z.strictObject({
      ...commonCampaignFields,
      kind: z.literal("REVIEWER_COMPLIMENTARY"),
    }),
  ])
  .superRefine((value, ctx) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Campaign end must be after campaign start.",
      });
    }
  });

export type CreateCommercialV1CampaignInput = z.infer<
  typeof createCommercialV1CampaignInputSchema
>;

export const archiveCommercialV1CampaignInputSchema = z.strictObject({
  code: campaignCodeSchema,
  reason: z.string().trim().min(5).max(300),
});
