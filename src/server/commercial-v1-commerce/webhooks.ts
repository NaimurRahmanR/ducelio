import "server-only";
import { z } from "zod";
import {
  fulfillCommercialV1OrderResultSchema,
  verifiedCheckoutSchema,
} from "@/domain/commercial-v1-commerce";
import { attestCommerceOperation } from "./operations-authority";
import { attestCommerceFulfillment } from "./authority";
import { paymentEvidenceProblem } from "./operations";
import type { CommerceProvider, VerifiedWebhookEvent } from "./provider";
import { processAcademyPayment } from "../academy-commerce";

export async function processCommerceWebhook(
  event: VerifiedWebhookEvent,
  provider: CommerceProvider,
) {
  const type = event.eventType ?? "checkout.session.completed";
  const isRefund = [
    "charge.refunded",
    "refund.created",
    "refund.updated",
    "refund.failed",
  ].includes(type);
  const hint = z.uuid().safeParse(event.metadataOrderId);
  let orderId = hint.success ? hint.data : null;
  // Commit minimal evidence before external calls. A crash leaves RECEIVED visible.
  await attestCommerceOperation({
    kind: "WEBHOOK_RECEIVED",
    eventId: event.eventId,
    eventType: type,
    subjectId: event.subjectId ?? (event.sessionId || null),
    orderId,
  });
  const finish = async (
    state: "RESOLVED" | "UNRESOLVED" | "IGNORED",
    reason: string,
  ) => {
    await attestCommerceOperation({
      kind: "WEBHOOK_RESULT",
      eventId: event.eventId,
      orderId,
      state,
      reason,
    });
    return { reconciled: state === "RESOLVED" };
  };
  if (type !== "checkout.session.completed" && !isRefund)
    return finish("IGNORED", "UNSUPPORTED_EVENT");
  let sessionId = event.sessionId;
  let payment;
  try {
    if (isRefund) {
      if (!event.paymentIntentId)
        return finish("UNRESOLVED", "MISSING_PAYMENT_INTENT");
      sessionId =
        (await provider.findCheckoutForPaymentIntent(event.paymentIntentId)) ??
        "";
    } else if (!orderId || event.amountMinor === null || !event.currency) {
      return finish("UNRESOLVED", "INCOMPLETE_EVIDENCE");
    }
    if (!sessionId) return finish("UNRESOLVED", "CHECKOUT_NOT_FOUND");
    payment = await provider.retrievePayment(sessionId);
  } catch {
    return finish("UNRESOLVED", "PROVIDER_UNAVAILABLE");
  }
  const parsedOrder = z.uuid().safeParse(payment.metadataOrderId);
  if (!parsedOrder.success)
    return finish("UNRESOLVED", "INVALID_ORDER_REFERENCE");
  if (orderId && orderId !== parsedOrder.data)
    return finish("UNRESOLVED", "MISMATCHED_SESSION");
  orderId = parsedOrder.data;
  const problem = paymentEvidenceProblem(
    payment,
    orderId,
    sessionId,
    type === "checkout.session.completed"
      ? event.amountMinor!
      : (payment.amountMinor ?? 0),
    type === "checkout.session.completed"
      ? event.currency!
      : (payment.currency ?? ""),
  );
  if (problem) return finish("UNRESOLVED", problem);
  if (isRefund && payment.chargeId !== event.subjectId)
    return finish("UNRESOLVED", "REFUND_MISMATCH");
  // Academy (B2C) orders: same verified evidence, Academy authority.
  if (payment.metadataOrderKind === "ACADEMY") {
    try {
      const academy = await processAcademyPayment(payment, {
        orderId,
        sessionId,
        eventId: event.eventId,
        isRefund,
      });
      return finish(academy.state, academy.reason);
    } catch {
      return finish("UNRESOLVED", "FULFILMENT_UNAVAILABLE");
    }
  }
  try {
    if (payment.refundedMinor! > 0) {
      if (payment.refundedMinor !== payment.amountMinor)
        return finish("UNRESOLVED", "PARTIAL_REFUND_REVIEW");
      const result = await attestCommerceOperation({
        kind: "REFUND",
        actorId: null,
        reason: "Verified full Stripe refund",
        orderId,
        sessionId,
        eventId: event.eventId,
        chargeId: payment.chargeId!,
        amountMinor: payment.amountMinor!,
        refundedMinor: payment.refundedMinor!,
        currency: payment.currency!,
      });
      return finish(result.ok ? "RESOLVED" : "UNRESOLVED", result.code);
    }
    if (isRefund) return finish("UNRESOLVED", "REFUND_NOT_CONFIRMED");
    const evidence = verifiedCheckoutSchema.safeParse({
      provider: "STRIPE",
      sessionId,
      eventId: event.eventId,
      orderId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.paymentStatus,
    });
    if (!evidence.success) return finish("UNRESOLVED", "INCOMPLETE_EVIDENCE");
    const result = fulfillCommercialV1OrderResultSchema.parse(
      await attestCommerceFulfillment(evidence.data),
    );
    return finish(
      result.ok && result.fulfilled ? "RESOLVED" : "UNRESOLVED",
      result.ok && result.fulfilled ? "FULFILLED" : result.code,
    );
  } catch {
    return finish("UNRESOLVED", "FULFILMENT_UNAVAILABLE");
  }
}
