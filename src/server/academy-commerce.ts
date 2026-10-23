import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { commerceConfig, config } from "@/lib/env";
import {
  currencyCodeSchema,
  type VerifiedCheckout,
} from "@/domain/commercial-v1-commerce";
import { ACADEMY_FORMAT_IDS } from "@/domain/academy-scheduler";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";
import {
  getCommerceProvider,
  type RetrievedPayment,
} from "./commercial-v1-commerce/provider";
import { CommerceFulfillmentUnavailable } from "./commercial-v1-commerce/authority";

// Ducelio Academy (B2C) checkout on the EXISTING commerce integration: the
// same Stripe provider adapter, webhook route, controller keys and
// verification rules as cohort checkout (src/server/commercial-v1-commerce).
// Academy orders have their own ledger because cohort orders require a
// course activation; their claims use purpose-separated HMAC strings, so a
// cohort claim can never fulfil an Academy order or the reverse. The
// database (migration 061) decides price, ownership, entitlement, format
// and revocation; this module only relays facts it verified from Stripe.
const ACADEMY_FULFILLMENT_PURPOSE =
  "DUCELIO_ACADEMY_FULFILLMENT_HMAC_SHA256_V1";
const ACADEMY_OPERATIONS_PURPOSE =
  "DUCELIO_ACADEMY_COMMERCE_OPERATIONS_HMAC_SHA256_V1";

function controller() {
  const env = commerceConfig();
  const keyId = z.uuid().safeParse(env.controllerKeyId);
  if (!env.controllerConfigured || !keyId.success)
    throw new CommerceFulfillmentUnavailable();
  return {
    keyId: keyId.data.toLowerCase(),
    secret: Buffer.from(env.controllerKeyHex, "hex"),
  };
}

export const academyFulfilmentResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    fulfilled: z.literal(true),
    replay: z.boolean(),
    orderId: z.uuid(),
    enrolmentId: z.uuid().nullable(),
  }),
  z.object({
    ok: z.literal(true),
    fulfilled: z.literal(false),
    code: z.literal("NOT_PAID"),
    orderId: z.uuid(),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

export async function attestAcademyFulfillment(checkout: VerifiedCheckout) {
  const { keyId, secret } = controller();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60;
  const mac = createHmac("sha256", secret)
    .update(
      [
        ACADEMY_FULFILLMENT_PURPOSE,
        "ACADEMY_COMMERCE_V1",
        keyId,
        checkout.provider,
        checkout.orderId.toLowerCase(),
        checkout.sessionId,
        checkout.eventId,
        String(checkout.amountMinor),
        checkout.currency,
        checkout.status,
        String(issuedAt),
        String(expiresAt),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  const { data, error } = await (
    await createSupabase()
  ).rpc("fulfill_academy_order", {
    p_key_id: keyId,
    p_order_id: checkout.orderId,
    p_provider: checkout.provider,
    p_session_id: checkout.sessionId,
    p_event_id: checkout.eventId,
    p_amount: checkout.amountMinor,
    p_currency: checkout.currency,
    p_status: checkout.status,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  });
  if (error) throw new CommerceFulfillmentUnavailable();
  return academyFulfilmentResultSchema.parse(data);
}

const operationSchema = z.union([
  z.strictObject({
    kind: z.literal("REFUND"),
    orderId: z.uuid(),
    sessionId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    chargeId: z.string().min(1).max(200),
    amountMinor: z.number().int().positive(),
    refundedMinor: z.number().int().min(0),
    currency: currencyCodeSchema,
  }),
  z.strictObject({
    kind: z.literal("CHECKOUT_REPLACEMENT"),
    learnerId: z.uuid(),
    orderId: z.uuid(),
    expiredSessionId: z.string().min(1).max(200),
    replacementSessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,197}$/),
  }),
]);
// Server-only; never exposed as a Server Action.
export async function attestAcademyOperation(
  input: z.input<typeof operationSchema>,
) {
  const payload = JSON.stringify(operationSchema.parse(input));
  const { keyId, secret } = controller();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60;
  const mac = createHmac("sha256", secret)
    .update(
      [
        ACADEMY_OPERATIONS_PURPOSE,
        keyId,
        payload,
        String(issuedAt),
        String(expiresAt),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  const { data, error } = await (
    await createSupabase()
  ).rpc("apply_academy_commerce_operation", {
    p_key_id: keyId,
    p_payload: payload,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_mac: mac,
  });
  if (error) throw new CommerceFulfillmentUnavailable();
  return z.object({ ok: z.boolean(), code: z.string() }).parse(data);
}

const createdOrderSchema = z.union([
  z.object({
    ok: z.literal(true),
    orderId: z.uuid(),
    amountMinor: z.number().int().positive(),
    currency: currencyCodeSchema,
    offerSlug: z.string(),
    formatId: z.enum(ACADEMY_FORMAT_IDS as [string, ...string[]]).nullable(),
    reused: z.boolean(),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
const bindingSchema = z.union([
  z.object({
    ok: z.literal(true),
    order: z
      .object({
        id: z.uuid(),
        state: z.enum(["PENDING", "FULFILLED"]),
        sessionId: z.string().nullable(),
      })
      .passthrough(),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export const academyOrderSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    order: z.strictObject({
      id: z.uuid(),
      state: z.enum(["PENDING", "FULFILLED"]),
      amountMinor: z.number().int(),
      currency: z.string(),
      formatId: z.string().nullable(),
      sessionId: z.string().nullable(),
      offerSlug: z.string(),
      title: z.string(),
      orderRefunded: z.boolean(),
      accessRevoked: z.boolean(),
      enrolmentId: z.uuid().nullable(),
    }),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string() }),
]);

export type AcademyCheckoutResult =
  { ok: true; url: string; orderId: string } | { ok: false; code: string };

// Same safety rules as the cohort checkout: one order per learner, course
// and format at a time; the URL returned is only ever the database-bound
// session, freshly confirmed by Stripe as OPEN and UNPAID for this order; an
// EXPIRED unpaid session is replaced through the signed, learner-bound
// operation (the LR-03 recovery); anything unexpected fails closed.
export async function createAcademyCheckout(
  offerSlug: unknown,
  formatId: unknown,
): Promise<AcademyCheckoutResult> {
  const slug = z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(80)
    .parse(offerSlug);
  const format = z
    .enum(ACADEMY_FORMAT_IDS as [string, ...string[]])
    .parse(formatId);
  const actor = await requireActor("student");
  if (!commerceConfig().configured)
    return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_academy_order", {
    p_offer_slug: slug,
    p_format_id: format,
  });
  if (error) return { ok: false, code: "CHECKOUT_UNAVAILABLE" };
  const order = createdOrderSchema.parse(data);
  if (!order.ok) return order;

  return openAcademyOrderCheckout(actor, client, order);
}

export async function createUnifiedCourseCheckout(
  offerSlug: unknown,
  couponCode: unknown,
) {
  const slug = z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .parse(offerSlug);
  const coupon = z
    .string()
    .trim()
    .max(40)
    .transform((s) => s.toUpperCase())
    .parse(couponCode ?? "");
  const actor = await requireActor("student");
  const client = await createSupabase();
  const { data, error } = await client.rpc("create_unified_course_order", {
    p_offer_slug: slug,
    p_coupon_code: coupon || null,
  });
  if (error) return { ok: false as const, code: "CHECKOUT_UNAVAILABLE" };
  const access = z
    .strictObject({
      ok: z.literal(true),
      accessGranted: z.literal(true),
      enrolmentId: z.uuid(),
      reused: z.boolean(),
    })
    .safeParse(data);
  if (access.success)
    return {
      ok: true as const,
      url: `/student/academy?enrolmentId=${access.data.enrolmentId}`,
    };
  const order = createdOrderSchema.parse(data);
  if (!order.ok) return order;
  // Full-discount access above requires no Stripe credentials or provider.
  if (!commerceConfig().configured)
    return { ok: false as const, code: "CHECKOUT_UNAVAILABLE" };
  return openAcademyOrderCheckout(actor, client, order);
}

async function openAcademyOrderCheckout(
  actor: { id: string },
  client: Awaited<ReturnType<typeof createSupabase>>,
  order: Extract<z.infer<typeof createdOrderSchema>, { ok: true }>,
): Promise<AcademyCheckoutResult> {
  const env = config();
  const successUrl = `${env.appUrl}/academy/checkout/success?order=${order.orderId}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.appUrl}/courses/${order.offerSlug}`;
  const provider = await getCommerceProvider();
  const orderKey = "DUCELIO_ACADEMY_ORDER:" + order.orderId;
  const sessionInput = (idempotencyKey: string) => ({
    orderId: order.orderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    offerTitle: "Ducelio Academy course",
    successUrl,
    cancelUrl,
    idempotencyKey,
    orderKind: "ACADEMY" as const,
  });
  const unavailable = { ok: false as const, code: "CHECKOUT_UNAVAILABLE" };
  for (let step = 0; step < 3; step++) {
    const { data: bindingData, error: bindingError } = await client.rpc(
      "get_my_academy_order",
      { p_order_id: order.orderId },
    );
    if (bindingError) return unavailable;
    const binding = bindingSchema.parse(bindingData);
    if (!binding.ok || binding.order.state !== "PENDING") return unavailable;
    if (!binding.order.sessionId) {
      let created: { sessionId: string; url: string };
      try {
        created = await provider.createCheckoutSession(sessionInput(orderKey));
      } catch {
        return unavailable;
      }
      const { data: attached, error: attachError } = await client.rpc(
        "attach_academy_checkout_session",
        {
          p_order_id: order.orderId,
          p_session_id: created.sessionId,
        },
      );
      if (attachError) return unavailable;
      const parsed = z
        .object({ ok: z.boolean(), code: z.string().optional() })
        .parse(attached);
      if (!parsed.ok && parsed.code !== "SESSION_ALREADY_BOUND")
        return unavailable;
      continue;
    }
    let bound;
    try {
      bound = await provider.retrieveCheckoutSession(binding.order.sessionId);
    } catch {
      return unavailable;
    }
    if (
      bound.sessionId !== binding.order.sessionId ||
      bound.metadataOrderId !== order.orderId ||
      bound.metadataOrderKind !== "ACADEMY" ||
      bound.amountMinor !== order.amountMinor ||
      bound.currency !== order.currency
    )
      return unavailable;
    if (
      bound.status === "OPEN" &&
      bound.paymentStatus === "UNPAID" &&
      bound.url
    )
      return { ok: true, url: bound.url, orderId: order.orderId };
    if (bound.status !== "EXPIRED" || bound.paymentStatus !== "UNPAID")
      return unavailable;
    let replacement: { sessionId: string; url: string };
    try {
      replacement = await provider.createCheckoutSession(
        sessionInput(orderKey + ":REPLACES:" + binding.order.sessionId),
      );
    } catch {
      return unavailable;
    }
    if (replacement.sessionId === binding.order.sessionId) return unavailable;
    try {
      const replaced = await attestAcademyOperation({
        kind: "CHECKOUT_REPLACEMENT",
        learnerId: actor.id,
        orderId: order.orderId,
        expiredSessionId: binding.order.sessionId,
        replacementSessionId: replacement.sessionId,
      });
      if (!replaced.ok && replaced.code !== "SESSION_CHANGED")
        return unavailable;
    } catch {
      return unavailable;
    }
  }
  return unavailable;
}

export async function getMyAcademyOrder(orderId: unknown) {
  await requireActor("student");
  const { data, error } = await (
    await createSupabase()
  ).rpc("get_my_academy_order", { p_order_id: z.uuid().parse(orderId) });
  if (error) throw new Error("The order could not be loaded.");
  return academyOrderSchema.parse(data);
}

// Success-page fallback: never trusts the redirect. Retrieves the real
// session from Stripe, requires it to reference this Academy order, PAID,
// with complete amount and currency matching the order, then converges on
// the same database fulfilment authority as the webhook.
export async function reconcileAcademyOrder(input: {
  orderId: unknown;
  sessionId: unknown;
}) {
  const orderId = z.uuid().parse(input.orderId);
  const sessionId = z.string().min(1).max(200).parse(input.sessionId);
  const status = await getMyAcademyOrder(orderId);
  if (!status.ok) return status;
  if (status.order.orderRefunded)
    return { ok: false as const, code: "ORDER_REFUNDED" };
  if (status.order.accessRevoked)
    return { ok: false as const, code: "ACCESS_REVOKED" };
  if (status.order.state === "FULFILLED")
    return {
      ok: true as const,
      fulfilled: true as const,
      enrolmentId: status.order.enrolmentId,
    };
  const provider = await getCommerceProvider();
  let session;
  try {
    session = await provider.retrieveCheckoutSession(sessionId);
  } catch {
    return { ok: false as const, code: "PROVIDER_UNAVAILABLE" };
  }
  if (
    session.metadataOrderId !== orderId ||
    session.metadataOrderKind !== "ACADEMY"
  )
    return { ok: false as const, code: "MISMATCHED_SESSION" };
  if (session.paymentStatus !== "PAID")
    return { ok: true as const, fulfilled: false as const, code: "NOT_PAID" };
  if (session.amountMinor === null || session.currency === null)
    return { ok: false as const, code: "INCOMPLETE_EVIDENCE" };
  if (
    session.amountMinor !== status.order.amountMinor ||
    session.currency !== status.order.currency
  )
    return { ok: false as const, code: "MISMATCHED_AMOUNT" };
  try {
    const result = await attestAcademyFulfillment({
      provider: "STRIPE",
      sessionId: session.sessionId,
      eventId: "SESSION_VERIFY:" + session.sessionId,
      orderId,
      amountMinor: session.amountMinor,
      currency: currencyCodeSchema.parse(session.currency),
      status: "PAID",
    });
    if (!result.ok) return { ok: false as const, code: result.code };
    if (!result.fulfilled)
      return { ok: true as const, fulfilled: false as const, code: "NOT_PAID" };
    return {
      ok: true as const,
      fulfilled: true as const,
      enrolmentId: result.enrolmentId,
    };
  } catch {
    return { ok: false as const, code: "CONFIGURATION_UNAVAILABLE" };
  }
}

// Webhook branch for an Academy-marked payment (called by the existing
// processCommerceWebhook after it verified and retrieved the payment and
// ran the shared evidence checks). Returns the receipt state and reason.
export async function processAcademyPayment(
  payment: RetrievedPayment,
  context: {
    orderId: string;
    sessionId: string;
    eventId: string;
    isRefund: boolean;
  },
): Promise<{ state: "RESOLVED" | "UNRESOLVED"; reason: string }> {
  if (payment.refundedMinor! > 0) {
    if (payment.refundedMinor !== payment.amountMinor)
      return { state: "UNRESOLVED", reason: "PARTIAL_REFUND_REVIEW" };
    const result = await attestAcademyOperation({
      kind: "REFUND",
      orderId: context.orderId,
      sessionId: context.sessionId,
      eventId: context.eventId,
      chargeId: payment.chargeId!,
      amountMinor: payment.amountMinor!,
      refundedMinor: payment.refundedMinor!,
      currency: currencyCodeSchema.parse(payment.currency),
    });
    return {
      state: result.ok ? "RESOLVED" : "UNRESOLVED",
      reason: result.code,
    };
  }
  if (context.isRefund)
    return { state: "UNRESOLVED", reason: "REFUND_NOT_CONFIRMED" };
  const result = await attestAcademyFulfillment({
    provider: "STRIPE",
    sessionId: context.sessionId,
    eventId: context.eventId,
    orderId: context.orderId,
    amountMinor: payment.amountMinor!,
    currency: currencyCodeSchema.parse(payment.currency),
    status: payment.paymentStatus,
  });
  if (result.ok && result.fulfilled)
    return { state: "RESOLVED", reason: "FULFILLED" };
  return { state: "UNRESOLVED", reason: result.code };
}
