import "server-only";
import { z } from "zod";
import { requireAnyRole } from "../identity";
import { createSupabase } from "../supabase";
import {
  commerceSearchSchema,
  commerceListSchema,
  commerceDiagnosisSchema,
  commerceOperationInputSchema,
  commerceOperationResultSchema,
} from "@/domain/commercial-v1-commerce-operations";
import {
  fulfillCommercialV1OrderResultSchema,
  verifiedCheckoutSchema,
} from "@/domain/commercial-v1-commerce";
import { getCommerceProvider, type RetrievedPayment } from "./provider";
import { attestCommerceFulfillment } from "./authority";
import { attestCommerceOperation } from "./operations-authority";

const roles = ["ACADEMIC_ADMIN", "PLATFORM_ADMIN"] as const;
export async function listCommerceOperations(input: unknown) {
  await requireAnyRole(roles);
  const parsed = commerceSearchSchema.parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "admin_list_commercial_v1_operations",
    { p_view: parsed.view, p_query: parsed.query, p_offset: parsed.offset },
  );
  if (error) throw new Error("Commerce records could not be loaded.");
  return commerceListSchema.parse(data);
}
export async function diagnoseCommerceAccess(input: unknown) {
  await requireAnyRole(roles);
  const parsed = z
    .union([
      z.strictObject({ orderId: z.uuid() }),
      z.strictObject({ learnerId: z.uuid(), offerId: z.uuid() }),
    ])
    .parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "admin_diagnose_commercial_v1_access",
    {
      p_order_id: "orderId" in parsed ? parsed.orderId : null,
      p_learner_id: "learnerId" in parsed ? parsed.learnerId : null,
      p_offer_id: "offerId" in parsed ? parsed.offerId : null,
    },
  );
  if (error) throw new Error("Access diagnosis could not be loaded.");
  return commerceDiagnosisSchema.parse(data);
}
export function paymentEvidenceProblem(
  payment: RetrievedPayment,
  orderId: string,
  sessionId: string,
  amount: number,
  currency: string,
): string | null {
  if (payment.sessionId !== sessionId || payment.metadataOrderId !== orderId)
    return "MISMATCHED_SESSION";
  if (payment.paymentStatus !== "PAID") return "NOT_PAID";
  if (payment.refundPending) return "REFUND_PENDING";
  if (
    payment.amountMinor === null ||
    payment.currency === null ||
    payment.chargeId === null ||
    payment.capturedMinor === null ||
    payment.refundedMinor === null
  )
    return "INCOMPLETE_EVIDENCE";
  if (payment.amountMinor !== amount || payment.capturedMinor !== amount)
    return "MISMATCHED_AMOUNT";
  if (payment.currency !== currency) return "MISMATCHED_CURRENCY";
  if (
    !Number.isInteger(payment.refundedMinor) ||
    payment.refundedMinor < 0 ||
    payment.refundedMinor > amount
  )
    return "INCOMPLETE_EVIDENCE";
  return null;
}
export async function reconcileCommerceOrder(input: unknown) {
  const actor = await requireAnyRole(roles);
  const { id, reason } = commerceOperationInputSchema.parse(input);
  const order = await diagnoseCommerceAccess({ orderId: id });
  const client = await createSupabase();
  const { error: auditError } = await client.rpc(
    "admin_prepare_commercial_v1_reconciliation",
    { p_order_id: id, p_reason: reason },
  );
  if (auditError)
    throw new Error("Reconciliation audit could not be recorded.");
  const failure = (code: string) =>
    attestCommerceOperation({
      kind: "OPERATOR_FAILURE",
      actorId: actor.id,
      orderId: id,
      reason,
      code,
    });
  let payment: RetrievedPayment;
  let sessionId = order.sessionId;
  try {
    const provider = await getCommerceProvider();
    if (!sessionId && order.orderCreatedAt)
      sessionId = await provider.findCheckoutForOrder(id, order.orderCreatedAt);
    if (!sessionId) return await failure("CHECKOUT_NOT_FOUND");
    payment = await provider.retrievePayment(sessionId);
  } catch {
    return failure("PROVIDER_UNAVAILABLE_OR_SCAN_LIMIT");
  }
  const problem = paymentEvidenceProblem(
    payment,
    id,
    sessionId,
    order.amountMinor!,
    order.currency!,
  );
  if (problem) return failure(problem);
  if (payment.refundedMinor! > 0) {
    if (payment.refundedMinor !== payment.amountMinor)
      return failure("PARTIAL_REFUND_REVIEW");
    // Missing binding is handled by the signed refund RPC after verifying order
    // scope/amount/currency, without briefly granting already-refunded access.
    return attestCommerceOperation({
      kind: "REFUND",
      actorId: actor.id,
      reason,
      orderId: id,
      sessionId,
      eventId: "REFUND_VERIFY:" + payment.chargeId,
      chargeId: payment.chargeId!,
      amountMinor: payment.amountMinor!,
      refundedMinor: payment.refundedMinor!,
      currency: payment.currency!,
    });
  }
  const result = fulfillCommercialV1OrderResultSchema.parse(
    await attestCommerceFulfillment(
      verifiedCheckoutSchema.parse({
        provider: "STRIPE",
        orderId: id,
        sessionId,
        eventId: "SESSION_VERIFY:" + sessionId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        status: "PAID",
      }),
      reason,
    ),
  );
  if (!result.ok) return { ok: false, code: result.code };
  if (!result.fulfilled) return { ok: false, code: result.code };
  const final = await diagnoseCommerceAccess({ orderId: id });
  return {
    ok: final.hasAccess,
    code: final.hasAccess
      ? result.replay
        ? "ALREADY_FULFILLED"
        : "FULFILLED"
      : final.accessReason,
  };
}
export async function cancelCommerceAccess(input: unknown) {
  await requireAnyRole(roles);
  const { id, reason } = commerceOperationInputSchema.parse(input);
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "admin_revoke_commercial_v1_entitlement",
    { p_entitlement_id: id, p_reason: reason },
  );
  if (error) throw new Error("Access could not be revoked.");
  return commerceOperationResultSchema.parse(data);
}
