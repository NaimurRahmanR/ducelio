import "server-only";
import type { RetrievedPayment } from "./commercial-v1-commerce/provider";

// Shared verified capture/refund facts. No cohort, actor or price authority.
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
