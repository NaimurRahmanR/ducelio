import { z } from "zod";
import {
  campaignCodeSchema,
  campaignKindSchema,
  deliveryPlanSchema,
} from "./commercial-v1-launch";

// Commercial V1 PR13: commerce, payment, entitlement and customer
// onboarding. Migration 202609160034_commercial_v1_commerce_onboarding.sql.
// Stripe supplies payment EVIDENCE only -- these schemas describe database-
// authoritative projections, never a client-supplied amount, currency,
// learner id, cohort or entitlement.
export const COMMERCIAL_V1_COMMERCE_POLICY =
  "COMMERCIAL_V1_COMMERCE_V1" as const;

export const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Use a 3-letter ISO currency code.")
  .transform((v) => v.toUpperCase());

export const offerSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Enter a valid course slug.")
  .min(3)
  .max(80);

// Independent of commerce entitlement: the CANONICAL academic enrolments
// table's own status for the current viewer's exact cohort (V2 correction,
// finding 4) -- a learner can be legitimately enrolled (a comped/free seat)
// without ever holding an entitlement row, and the UI must never offer
// another purchase in any of these four cases.
export const viewerEnrolmentStatusSchema = z.enum([
  "NONE",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "WITHDRAWN",
]);

// Public/anonymous-safe offer projection -- never protected course
// content, assessment content, agent configuration or private learner
// data. viewerEntitled/viewerEnrolmentId/viewerEnrolmentStatus reflect the
// CURRENT server-authenticated actor only.
export const commercialV1OfferSchema = z.strictObject({
  ok: z.literal(true),
  slug: offerSlugSchema,
  title: z.string(),
  examinationBody: z.string(),
  qualificationName: z.string(),
  priceAmountMinor: z.number().int().min(1),
  currency: currencyCodeSchema,
  summary: z.string().nullable(),
  cohortStartsOn: z.string(),
  deliveryPlan: deliveryPlanSchema.default("STANDARD_6_WEEK"),
  viewerAuthenticated: z.boolean(),
  viewerEntitled: z.boolean(),
  viewerEnrolmentId: z.uuid().nullable(),
  viewerEnrolmentStatus: viewerEnrolmentStatusSchema,
});
export type CommercialV1Offer = z.infer<typeof commercialV1OfferSchema>;

export const commercialV1OfferResultSchema = z.union([
  commercialV1OfferSchema,
  z.strictObject({ ok: z.literal(false), code: z.literal("NOT_FOUND") }),
]);

export const commercialV1OfferSummarySchema = z.strictObject({
  slug: offerSlugSchema,
  title: z.string(),
  examinationBody: z.string(),
  qualificationName: z.string(),
  priceAmountMinor: z.number().int().min(1),
  currency: currencyCodeSchema,
  summary: z.string().nullable(),
  cohortStartsOn: z.string(),
  deliveryPlan: deliveryPlanSchema.default("STANDARD_6_WEEK"),
});
export const commercialV1OfferListSchema = z.array(
  commercialV1OfferSummarySchema,
);
export type CommercialV1OfferSummary = z.infer<
  typeof commercialV1OfferSummarySchema
>;

export const publishCommercialV1OfferInputSchema = z.strictObject({
  activationId: z.uuid(),
  slug: offerSlugSchema,
  priceAmountMinor: z.number().int().min(1).max(100_000_000),
  currency: currencyCodeSchema,
  summary: z.string().trim().min(1).max(500).nullable().optional(),
  deliveryPlan: deliveryPlanSchema.default("STANDARD_6_WEEK"),
  reason: z.string().trim().min(5).max(300),
});
export type PublishCommercialV1OfferInput = z.infer<
  typeof publishCommercialV1OfferInputSchema
>;

export const archiveCommercialV1OfferInputSchema = z.strictObject({
  slug: offerSlugSchema,
  reason: z.string().trim().min(5).max(300),
});

// V2 correction (finding 10): the smallest operational admin read needed to
// actually use publishCommercialV1Offer -- an admin has no other way to
// discover a real activation id.
export const commercialV1OfferActivationSchema = z.strictObject({
  activationId: z.uuid(),
  programmeTitle: z.string(),
  cohortTitle: z.string(),
  cohortStartsOn: z.string(),
  publishedOfferSlug: offerSlugSchema.nullable(),
});
export const commercialV1OfferActivationListSchema = z.array(
  commercialV1OfferActivationSchema,
);
export type CommercialV1OfferActivation = z.infer<
  typeof commercialV1OfferActivationSchema
>;

const orderDenialCode = z.enum([
  "FORBIDDEN",
  "NOT_FOUND_OR_FORBIDDEN",
  "ALREADY_ENTITLED",
  // V2 correction (finding 4): derived from the CANONICAL academic
  // enrolments table, independent of commerce entitlement.
  "ALREADY_ENROLLED",
  "ENROLMENT_REQUIRES_SUPPORT",
]);
export const createCommercialV1OrderResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    orderId: z.uuid(),
    amountMinor: z.number().int().min(1),
    currency: currencyCodeSchema,
    offerSlug: offerSlugSchema,
    activationId: z.uuid(),
    reused: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), code: orderDenialCode }),
]);
export type CreateCommercialV1OrderResult = z.infer<
  typeof createCommercialV1OrderResultSchema
>;

export const campaignPurchaseDenialCodeSchema = z.enum([
  "FORBIDDEN",
  "NOT_FOUND_OR_FORBIDDEN",
  "CODE_UNAVAILABLE",
  "OFFER_ALREADY_REDEEMED",
  "CHECKOUT_ALREADY_STARTED",
  "ALREADY_ENTITLED",
  "ALREADY_ENROLLED",
  "ENROLMENT_REQUIRES_SUPPORT",
]);
export type CampaignPurchaseDenialCode = z.infer<
  typeof campaignPurchaseDenialCodeSchema
>;

export const commercialV1CampaignPreviewSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    effectivePriceAmountMinor: z.number().int().min(0).max(100_000_000),
    currency: currencyCodeSchema,
    kind: campaignKindSchema,
    reused: z.boolean(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: campaignPurchaseDenialCodeSchema,
  }),
]);
export type CommercialV1CampaignPreview = z.infer<
  typeof commercialV1CampaignPreviewSchema
>;

export const commercialV1CampaignRedemptionSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    path: z.literal("PAID_CHECKOUT"),
    reused: z.boolean(),
    orderId: z.uuid(),
    offerSlug: offerSlugSchema,
    activationId: z.uuid(),
    effectivePriceAmountMinor: z.number().int().min(1).max(100_000_000),
    currency: currencyCodeSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    path: z.literal("ACCESS_GRANTED"),
    reused: z.boolean(),
    offerSlug: offerSlugSchema,
    activationId: z.uuid(),
    effectivePriceAmountMinor: z.literal(0),
    currency: currencyCodeSchema,
    entitlementId: z.uuid(),
    enrolmentId: z.uuid(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: campaignPurchaseDenialCodeSchema,
  }),
]);
export type CommercialV1CampaignRedemption = z.infer<
  typeof commercialV1CampaignRedemptionSchema
>;

export const commercialV1CampaignAdminSchema = z.strictObject({
  code: campaignCodeSchema,
  offerSlug: offerSlugSchema,
  kind: campaignKindSchema,
  effectivePriceAmountMinor: z.number().int().min(0).max(100_000_000),
  currency: currencyCodeSchema,
  maxRedemptions: z.number().int().min(1),
  redemptionCount: z.number().int().min(0),
  startsAt: z.string(),
  endsAt: z.string(),
  state: z.enum(["ACTIVE", "ARCHIVED"]),
});
export const commercialV1CampaignAdminListSchema = z.array(
  commercialV1CampaignAdminSchema,
);
export type CommercialV1CampaignAdmin = z.infer<
  typeof commercialV1CampaignAdminSchema
>;

export const commercialV1OrderStateSchema = z.enum(["PENDING", "FULFILLED"]);
export const commercialV1OrderProjectionSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    order: z.strictObject({
      id: z.uuid(),
      state: commercialV1OrderStateSchema,
      accessRevoked: z.boolean().default(false),
      orderRefunded: z.boolean().default(false),
      offerSlug: offerSlugSchema.nullable(),
      activationId: z.uuid(),
      amountMinor: z.number().int().min(1),
      currency: currencyCodeSchema,
      fulfilledAt: z.string().nullable(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["UNAUTHENTICATED", "NOT_FOUND_OR_FORBIDDEN"]),
  }),
]);
export type CommercialV1OrderProjection = z.infer<
  typeof commercialV1OrderProjectionSchema
>;

// Bounded Stripe-vocabulary payment status -- verbatim mapped from Stripe's
// own Checkout Session payment_status field, uppercased. Never a custom
// invented status vocabulary.
export const paymentStatusSchema = z.enum([
  "PAID",
  "UNPAID",
  "NO_PAYMENT_REQUIRED",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

const fulfillmentDenialCode = z.enum([
  "ORDER_REFUNDED",
  "ACCESS_REVOKED",
  "UNTRUSTED_CLAIM",
  "ORDER_NOT_FOUND",
  "MISMATCHED_SESSION",
  "MISMATCHED_AMOUNT",
  "MISMATCHED_CURRENCY",
  "LEARNER_NOT_FOUND",
  "LEARNER_NOT_STUDENT",
  "ENROLMENT_NOT_ACTIVATABLE",
]);
export const fulfillCommercialV1OrderResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    fulfilled: z.literal(true),
    replay: z.boolean(),
    orderId: z.uuid(),
    entitlementId: z.uuid(),
    enrolmentId: z.uuid(),
    activationId: z.uuid(),
  }),
  z.strictObject({
    ok: z.literal(true),
    fulfilled: z.literal(false),
    code: z.literal("NOT_PAID"),
    orderId: z.uuid(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: fulfillmentDenialCode,
    orderId: z.uuid().optional(),
    enrolmentId: z.uuid().optional(),
  }),
]);
export type FulfillCommercialV1OrderResult = z.infer<
  typeof fulfillCommercialV1OrderResultSchema
>;

// A narrow, provider-neutral shape a Stripe (or future provider) adapter
// resolves a checkout session down to -- never a raw provider SDK object
// crossing into domain/database code.
export const verifiedCheckoutSchema = z.strictObject({
  provider: z.literal("STRIPE"),
  sessionId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200),
  orderId: z.uuid(),
  amountMinor: z.number().int().min(1),
  currency: currencyCodeSchema,
  status: paymentStatusSchema,
});
export type VerifiedCheckout = z.infer<typeof verifiedCheckoutSchema>;

// Authenticated success-page reconciliation result (PR13 section 6/13).
// V2 correction (findings 3 & 6): "fulfilled:true" only when the database
// fulfillment authority itself confirmed it -- reconciliation never
// synthesises missing provider amount/currency, and never attests a
// non-PAID observation at all.
const reconcileDenialCode = z.enum([
  "ORDER_REFUNDED",
  "ACCESS_REVOKED",
  "UNAUTHENTICATED",
  "NOT_FOUND_OR_FORBIDDEN",
  "MISMATCHED_SESSION",
  "INCOMPLETE_EVIDENCE",
  "MISMATCHED_AMOUNT",
  "MISMATCHED_CURRENCY",
  "CONFIGURATION_UNAVAILABLE",
  "UNTRUSTED_CLAIM",
  "ORDER_NOT_FOUND",
  "LEARNER_NOT_FOUND",
  "LEARNER_NOT_STUDENT",
  "ENROLMENT_NOT_ACTIVATABLE",
]);
export const reconcileCommercialV1OrderResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    fulfilled: z.literal(true),
    replay: z.boolean(),
    orderId: z.uuid(),
  }),
  z.strictObject({
    ok: z.literal(true),
    fulfilled: z.literal(false),
    code: z.literal("NOT_PAID"),
    orderId: z.uuid(),
  }),
  z.strictObject({ ok: z.literal(false), code: reconcileDenialCode }),
]);
export type ReconcileCommercialV1OrderResult = z.infer<
  typeof reconcileCommercialV1OrderResultSchema
>;
