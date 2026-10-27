import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  PREPARATION_DISCLAIMER,
  renderCertificatePdf,
  type LearnerCertificate,
} from "@/server/learner-certificates";
import {
  renderReceiptPdf,
  SELLER_NOT_CONFIGURED,
  type PaymentReceipt,
} from "@/server/learner-receipts";

// Generates both PDFs, reloads them with pdf-lib and reads the drawn text
// back from the page content streams (pdf-lib writes standard-font text as
// WinAnsi hex strings shown with Tj).
async function pdfText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  let text = "";
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.get(PDFName.of("Filter"));
    const raw =
      filter?.toString() === "/FlateDecode"
        ? inflateSync(Buffer.from(object.contents))
        : Buffer.from(object.contents);
    for (const m of raw.toString("latin1").matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g))
      text += Buffer.from(m[1], "hex").toString("latin1") + "\n";
  }
  return { doc, pages, text };
}

const certificate: LearnerCertificate = {
  certificateId: "11111111-1111-4111-8111-111111111111",
  enrolmentId: "22222222-2222-4222-8222-222222222222",
  verificationCode: "ABCD-EFGH-JKLM-NPQR",
  learnerName: "Zoë Ångström",
  courseTitle: "TEST ONLY Security+ SY0-701 Preparation",
  issuerName: "Synthetic Tenant One",
  examinationBody: "CompTIA",
  qualificationName: "TEST ONLY preparation course",
  completedAt: "2026-10-20T10:00:00Z",
  issuedAt: "2026-10-21T10:00:00Z",
  revoked: false,
  revokedAt: null,
  emailDelivery: "QUEUED",
};

const receipt: PaymentReceipt = {
  receiptId: "33333333-3333-4333-8333-333333333333",
  receiptNumber: "DUC-R-2026-000001",
  issuedAt: "2026-10-22T09:00:00Z",
  orderId: "44444444-4444-4444-8444-444444444444",
  courseTitle: "TEST ONLY Security+ SY0-701 Preparation",
  provider: "Synthetic Tenant One",
  learnerName: "Ada Lovelace",
  amountMinor: 10000,
  currency: "GBP",
  listAmountMinor: 12500,
  discountMinor: 2500,
  paidAt: "2026-10-22T08:59:00Z",
  refund: null,
  emailDelivery: "SENT",
};

describe("certificate PDF", () => {
  it("is a parseable A4 landscape PDF with the certificate fields", async () => {
    const bytes = await renderCertificatePdf(certificate, {
      appUrl: "https://example.test",
    });
    const { doc, pages, text } = await pdfText(bytes);
    expect(pages).toHaveLength(1);
    const { width, height } = pages[0].getSize();
    expect(Math.round(width)).toBe(842);
    expect(Math.round(height)).toBe(595);
    expect(doc.getTitle()).toContain(certificate.courseTitle);
    for (const expected of [
      "Certificate of Completion",
      "Zoë Ångström",
      certificate.courseTitle,
      "Provided by Synthetic Tenant One",
      "Completed on 20 October 2026",
      "Verification code: ABCD-EFGH-JKLM-NPQR",
      "https://example.test/verify?code=ABCD-EFGH-JKLM-NPQR",
    ])
      expect(text).toContain(expected);
    expect(text.replace(/\n/g, " ")).toContain(PREPARATION_DISCLAIMER);
    expect(text).not.toContain("REVOKED");
  });

  it("omits the examination disclaimer without an external qualification and marks revocation", async () => {
    const { text } = await pdfText(
      await renderCertificatePdf(
        {
          ...certificate,
          examinationBody: null,
          revoked: true,
          revokedAt: "2026-10-25T00:00:00Z",
          learnerName: "名前 Test",
        },
        { appUrl: "https://example.test" },
      ),
    );
    expect(text.replace(/\n/g, " ")).not.toContain("examination body");
    expect(text).toContain("REVOKED");
    // Unencodable characters never break generation.
    expect(text).toContain("?? Test");
  });
});

describe("receipt PDF", () => {
  it("states that seller details are not configured instead of inventing them", async () => {
    const { pages, text } = await pdfText(
      await renderReceiptPdf(receipt, {
        legalName: "",
        address: "",
        taxId: "",
        configured: false,
      }),
    );
    expect(pages).toHaveLength(1);
    for (const expected of [
      "Receipt number: DUC-R-2026-000001",
      SELLER_NOT_CONFIGURED,
      "Ada Lovelace",
      receipt.orderId,
      receipt.courseTitle,
      "Synthetic Tenant One",
      "£125.00",
      "-£25.00",
      "£100.00",
      "Status: PAID",
    ])
      expect(text).toContain(expected);
  });

  it("prints configured seller identity and a verified refund", async () => {
    const { text } = await pdfText(
      await renderReceiptPdf(
        {
          ...receipt,
          listAmountMinor: null,
          discountMinor: null,
          refund: {
            amountMinor: 10000,
            currency: "GBP",
            refundedAt: "2026-10-24T12:00:00Z",
          },
        },
        {
          legalName: "TEST ONLY Seller Ltd",
          address: "1 Synthetic Street | Testville",
          taxId: "GB000000000",
          configured: true,
        },
      ),
    );
    for (const expected of [
      "TEST ONLY Seller Ltd",
      "1 Synthetic Street",
      "Testville",
      "Tax ID: GB000000000",
      "Refunded on 24 October 2026",
      "Status: REFUNDED",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain(SELLER_NOT_CONFIGURED);
    expect(text).not.toContain("List price");
  });
});
