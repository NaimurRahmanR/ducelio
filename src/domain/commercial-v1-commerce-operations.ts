import { z } from "zod";

export const commerceViewSchema = z.enum([
  "orders",
  "entitlements",
  "redemptions",
  "issues",
  "offers",
  "learners",
  "audit",
]);
export const commerceSearchSchema = z.strictObject({
  view: commerceViewSchema.default("orders"),
  query: z.string().trim().max(100).default(""),
  offset: z.number().int().min(0).max(100000).default(0),
});
export const commerceOperationInputSchema = z.strictObject({
  id: z.uuid(),
  reason: z.string().trim().min(5).max(300),
});
export const commerceOperationResultSchema = z.strictObject({
  ok: z.boolean(),
  code: z.string().regex(/^[A-Z_]{1,80}$/),
});
export const commerceListSchema = z.strictObject({
  hasMore: z.boolean(),
  rows: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        title: z.string(),
        subtitle: z.string(),
        state: z.string(),
        occurredAt: z.string().nullable(),
        orderId: z.uuid().nullable(),
        entitlementId: z.uuid().nullable(),
        learnerId: z.uuid().nullable(),
        offerId: z.uuid().nullable(),
        reason: z.string().nullable(),
      }),
    )
    .max(25),
});
export type CommerceList = z.infer<typeof commerceListSchema>;

export const commerceDiagnosisSchema = z.strictObject({
  learnerId: z.uuid(),
  learnerName: z.string(),
  offerId: z.uuid(),
  offerSlug: z.string(),
  courseTitle: z.string(),
  versionLabel: z.string(),
  programmeVersionId: z.uuid(),
  cohortId: z.uuid(),
  cohortTitle: z.string(),
  activationId: z.uuid(),
  orderId: z.uuid().nullable(),
  orderState: z.enum(["PENDING", "FULFILLED"]).nullable(),
  orderCreatedAt: z.string().nullable(),
  sessionId: z.string().max(200).nullable(),
  amountMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  paymentConfirmed: z.boolean(),
  refunded: z.boolean(),
  fulfilmentAttempted: z.boolean().nullable(),
  entitlementId: z.uuid().nullable(),
  entitlementState: z.enum(["ACTIVE", "REVOKED"]).nullable(),
  entitlementSource: z.string().nullable(),
  entitlementOrderId: z.uuid().nullable(),
  revocationReason: z.string().nullable(),
  enrolmentId: z.uuid().nullable(),
  enrolmentStatus: z.string().nullable(),
  enrolmentOrigin: z
    .enum(["COMMERCE", "ACADEMIC", "UNKNOWN"])
    .nullable()
    .default(null),
  hasAccess: z.boolean(),
  accessReason: z.string(),
  reconciliationState: z.string(),
  payments: z
    .array(
      z.strictObject({
        eventId: z.string(),
        status: z.string(),
        amountMinor: z.number().int(),
        currency: z.string(),
        verifiedAt: z.string(),
      }),
    )
    .max(50),
  audit: z
    .array(
      z.strictObject({
        action: z.string(),
        actor: z.string(),
        reason: z.string().nullable(),
        at: z.string(),
      }),
    )
    .max(50),
  paymentsTruncated: z.boolean(),
  auditTruncated: z.boolean(),
});
export type CommerceDiagnosis = z.infer<typeof commerceDiagnosisSchema>;

const providerId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const operator = {
  actorId: z.uuid().nullable(),
  reason: z.string().trim().min(5).max(300),
};
export const commerceSignedOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("WEBHOOK_RECEIVED"),
    eventId: providerId,
    eventType: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9._]+$/),
    subjectId: providerId.nullable(),
    orderId: z.uuid().nullable(),
  }),
  z.strictObject({
    kind: z.literal("WEBHOOK_RESULT"),
    eventId: providerId,
    orderId: z.uuid().nullable(),
    state: z.enum(["RESOLVED", "UNRESOLVED", "IGNORED"]),
    reason: z.string().regex(/^[A-Z_]{1,80}$/),
  }),
  z.strictObject({
    kind: z.literal("OPERATOR_FAILURE"),
    ...operator,
    actorId: z.uuid(),
    orderId: z.uuid(),
    code: z.string().regex(/^[A-Z_]{1,80}$/),
  }),
  z.strictObject({
    kind: z.literal("REFUND"),
    ...operator,
    orderId: z.uuid(),
    sessionId: providerId,
    eventId: providerId,
    chargeId: providerId,
    amountMinor: z.number().int().min(1).max(100000000),
    refundedMinor: z.number().int().min(1).max(100000000),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
]);
export type CommerceSignedOperation = z.infer<
  typeof commerceSignedOperationSchema
>;

export const accessReasonLabels: Record<string, string> = {
  ACCOUNT_UNAVAILABLE:
    "The learner account is deactivated or lacks a confirmed authenticated identity.",
  LEARNER_NOT_STUDENT:
    "The learner does not currently hold the required student authority.",
  ACCESS_ACTIVE: "Active enrolment and no commercial access revocation.",
  ENTITLEMENT_REVOKED:
    "Commercial access was revoked. Reconciliation cannot restore it.",
  ORDER_REFUNDED: "Payment was fully refunded before access was granted.",
  ENROLMENT_PAUSED:
    "The enrolment is paused. Commerce cannot override the academic status workflow.",
  ENROLMENT_WITHDRAWN:
    "The enrolment is withdrawn. Commerce cannot reopen this historical record.",
  ENROLMENT_COMPLETED:
    "The enrolment is completed; there is no active learning enrolment.",
  ENTITLEMENT_ENROLMENT_MISMATCH:
    "The entitlement does not match the learner's enrolment. Institutional review is required.",
  FULFILLED_WITHOUT_ENTITLEMENT:
    "The fulfilled order has no entitlement. Institutional integrity review is required.",
  PAID_AWAITING_FULFILMENT:
    "Payment evidence exists but fulfilment has not granted entitlement. Reconcile to retry the governed workflow.",
  NO_ORDER_OR_ENROLMENT:
    "No order or enrolment exists for this learner and offer.",
  CHECKOUT_NOT_BOUND:
    "The order has no bound Checkout Session. Reconciliation can recover the original session from Stripe.",
  PAYMENT_NOT_CONFIRMED:
    "No confirmed payment is recorded. Reconciliation checks Stripe; it cannot mark an unpaid order paid.",
};
