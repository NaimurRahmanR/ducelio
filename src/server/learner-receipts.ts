import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { z } from "zod";
import { learnerServicesConfig } from "@/lib/env";
import { callLearnerRpc } from "./learner-profile";
import {
  DUCELIO_INDIGO,
  formatDate,
  pdfSafeText,
  wrapText,
} from "./learner-certificates";

// Payment receipts (docs/61 section 4). The database issues a receipt only
// for a FULFILLED academy order with a verified PAID payment event, once per
// order (a webhook replay or a second call returns the same receipt). Every
// amount, date and title comes from the authoritative order rows; seller
// identity comes from configuration and is never invented.
export const receiptSchema = z.object({
  receiptId: z.uuid(),
  receiptNumber: z.string().regex(/^DUC-R-\d{4}-\d{6,}$/),
  issuedAt: z.string(),
  orderId: z.uuid(),
  courseTitle: z.string(),
  provider: z.string(),
  learnerName: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  listAmountMinor: z.number().int().nullable(),
  discountMinor: z.number().int().nullable(),
  paidAt: z.string().nullable(),
  refund: z
    .object({
      amountMinor: z.number().int(),
      currency: z.string(),
      refundedAt: z.string(),
    })
    .nullable(),
  emailDelivery: z.enum(["QUEUED", "SENT", "FAILED", "NOT_QUEUED"]),
});
export type PaymentReceipt = z.infer<typeof receiptSchema>;

export type SellerIdentity = {
  legalName: string;
  address: string;
  taxId: string;
  configured: boolean;
};
export const SELLER_NOT_CONFIGURED = "Seller details not configured";

// Integration point for the fulfilment path when a learner session exists
// (e.g. the checkout success page after reconcileAcademyOrder). Webhook-only
// fulfilment needs no call: migration 076 issues the receipt in the same
// transaction that marks the order FULFILLED. Safe to call repeatedly.
export async function issueReceiptForOrder(orderId: unknown) {
  return z
    .union([
      z.object({ ok: z.literal(true), receipt: receiptSchema }),
      z.object({ ok: z.literal(false), code: z.string() }),
    ])
    .parse(
      await callLearnerRpc("issue_my_payment_receipt", {
        p_order_id: z.uuid().parse(orderId),
      }),
    );
}

// Also backfills receipts for the learner's earlier verified paid orders.
export async function listMyPaymentReceipts() {
  return z
    .array(receiptSchema)
    .parse(await callLearnerRpc("list_my_payment_receipts"));
}

export async function getMyPaymentReceipt(receiptId: unknown) {
  return receiptSchema.parse(
    await callLearnerRpc("get_my_payment_receipt", {
      p_receipt_id: z.uuid().parse(receiptId),
    }),
  );
}

export function formatMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

export function sellerIdentity(): SellerIdentity {
  return learnerServicesConfig().seller;
}

export async function renderReceiptPdf(
  receipt: PaymentReceipt,
  seller: SellerIdentity,
): Promise<Uint8Array> {
  const r = receiptSchema.parse(receipt);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payment receipt ${r.receiptNumber}`);
  pdf.setSubject(`Ducelio receipt ${r.receiptNumber}`);
  pdf.setCreator("Ducelio");
  pdf.setProducer("Ducelio");
  const page = pdf.addPage([595.28, 841.89]); // A4 portrait
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.13, 0.18);
  const muted = rgb(0.4, 0.4, 0.47);
  const { width, height } = page.getSize();
  const left = 56;
  const text = (
    p: PDFPage,
    value: string,
    x: number,
    y: number,
    size = 10.5,
    useBold = false,
    color = ink,
  ) => {
    const f = useBold ? bold : font;
    p.drawText(pdfSafeText(f, value), { x, y, size, font: f, color });
  };
  const right = (value: string, y: number, size = 10.5, useBold = false) => {
    const f = useBold ? bold : font;
    const safe = pdfSafeText(f, value);
    page.drawText(safe, {
      x: width - left - f.widthOfTextAtSize(safe, size),
      y,
      size,
      font: f,
      color: ink,
    });
  };

  page.drawRectangle({
    x: 0,
    y: height - 96,
    width,
    height: 96,
    color: DUCELIO_INDIGO,
  });
  text(page, "DUCELIO", left, height - 52, 22, true, rgb(1, 1, 1));
  text(page, "Payment receipt", left, height - 74, 12, false, rgb(1, 1, 1));

  let y = height - 136;
  text(page, `Receipt number: ${r.receiptNumber}`, left, y, 11, true);
  right(`Issued ${formatDate(r.issuedAt)}`, y);
  y -= 34;

  text(page, "Seller", left, y, 9, true, muted);
  text(page, "Billed to", width / 2, y, 9, true, muted);
  y -= 15;
  const sellerLines = seller.configured
    ? [
        seller.legalName,
        ...seller.address.split(/\s*[\n|]\s*/).filter(Boolean),
        ...(seller.taxId ? [`Tax ID: ${seller.taxId}`] : []),
      ]
    : [SELLER_NOT_CONFIGURED];
  let sy = y;
  for (const line of sellerLines.slice(0, 6)) {
    for (const part of wrapText(font, line, 10.5, width / 2 - left - 16)) {
      text(page, part, left, sy);
      sy -= 14;
    }
  }
  text(page, r.learnerName, width / 2, y);
  y = Math.min(sy, y - 14) - 22;

  const rows: [string, string][] = [
    ["Order reference", r.orderId],
    ["Course", r.courseTitle],
    ["Course provider", r.provider],
    ["Payment date", r.paidAt ? formatDate(r.paidAt) : "Not recorded"],
    ["Payment processor", "Stripe"],
  ];
  for (const [label, value] of rows) {
    text(page, label, left, y, 10, true, muted);
    for (const part of wrapText(font, value, 10.5, width - left * 2 - 130)) {
      text(page, part, left + 130, y);
      y -= 14;
    }
    y -= 6;
  }
  y -= 10;
  page.drawLine({
    start: { x: left, y },
    end: { x: width - left, y },
    thickness: 0.8,
    color: DUCELIO_INDIGO,
  });
  y -= 22;
  if (r.listAmountMinor !== null && r.discountMinor) {
    text(page, "List price", left, y);
    right(formatMoney(r.listAmountMinor, r.currency), y);
    y -= 18;
    text(page, "Discount", left, y);
    right(`-${formatMoney(r.discountMinor, r.currency)}`, y);
    y -= 18;
  }
  text(page, "Amount paid", left, y, 12, true);
  right(formatMoney(r.amountMinor, r.currency), y, 12, true);
  y -= 26;
  if (r.refund) {
    text(page, `Refunded on ${formatDate(r.refund.refundedAt)}`, left, y, 10.5, true);
    right(`-${formatMoney(r.refund.amountMinor, r.refund.currency)}`, y, 10.5, true);
    y -= 18;
    text(page, "Status: REFUNDED", left, y, 10.5, true, rgb(0.7, 0.1, 0.1));
    y -= 18;
  } else {
    text(page, "Status: PAID", left, y, 10.5, true);
    y -= 18;
  }

  const footer = [
    "This receipt confirms a payment recorded by Ducelio for access to the course named above.",
    "Ducelio prepares learners for external examinations and does not award external qualifications.",
  ];
  let fy = 72;
  for (const line of footer) {
    for (const part of wrapText(font, line, 8.5, width - left * 2)) {
      text(page, part, left, fy, 8.5, false, muted);
      fy -= 12;
    }
  }
  return pdf.save({ useObjectStreams: false });
}
