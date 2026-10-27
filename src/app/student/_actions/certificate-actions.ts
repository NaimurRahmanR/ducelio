"use server";
import { revalidatePath } from "next/cache";
import { issueMyCertificate } from "@/server/learner-certificates";
import { issueReceiptForOrder } from "@/server/learner-receipts";

export type CertificateActionState = {
  ok?: boolean;
  error?: string;
  certificateId?: string;
  verificationCode?: string;
  emailDelivery?: "QUEUED" | "SENT" | "FAILED" | "NOT_QUEUED";
};

// Form field: enrolmentId. Idempotent: a second submit returns the same
// certificate and queues no second email.
export async function issueCertificateAction(
  _previous: CertificateActionState,
  form: FormData,
): Promise<CertificateActionState> {
  try {
    const result = await issueMyCertificate(form.get("enrolmentId"));
    if (!result.ok)
      return {
        ok: false,
        error:
          result.code === "NOT_COMPLETED"
            ? "A certificate is available once your course completion is recorded."
            : "The certificate could not be issued.",
      };
    revalidatePath("/student/profile");
    return {
      ok: true,
      certificateId: result.certificate.certificateId,
      verificationCode: result.certificate.verificationCode,
      emailDelivery: result.certificate.emailDelivery,
    };
  } catch {
    return {
      ok: false,
      error: "The certificate could not be issued. Try again later.",
    };
  }
}

// Form field: orderId. Issues (or returns) the receipt for a verified paid
// order the learner owns; NOT_ELIGIBLE otherwise.
export async function issueReceiptAction(
  _previous: { ok?: boolean; error?: string; receiptId?: string },
  form: FormData,
): Promise<{ ok?: boolean; error?: string; receiptId?: string }> {
  try {
    const result = await issueReceiptForOrder(form.get("orderId"));
    if (!result.ok)
      return {
        ok: false,
        error: "A receipt is available once payment is verified.",
      };
    return { ok: true, receiptId: result.receipt.receiptId };
  } catch {
    return {
      ok: false,
      error: "The receipt could not be issued. Try again later.",
    };
  }
}
