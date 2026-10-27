import "server-only";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { z } from "zod";
import { callLearnerRpc } from "./learner-profile";
import { createSupabase } from "./supabase";

// Certificates (docs/61 section 4). Issued by the database only from a real
// academy_completions row; this module validates projections and renders the
// PDF. The issuer is the course organisation; Ducelio prepares learners for
// external examinations and never awards the external qualification.
export const PREPARATION_DISCLAIMER =
  "This certificate confirms completion of a Ducelio preparation course. It is not an official certification from the examination body.";

export const certificateSchema = z.object({
  certificateId: z.uuid(),
  enrolmentId: z.uuid(),
  verificationCode: z
    .string()
    .regex(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/),
  learnerName: z.string(),
  courseTitle: z.string(),
  issuerName: z.string(),
  examinationBody: z.string().nullable(),
  qualificationName: z.string().nullable(),
  completedAt: z.string(),
  issuedAt: z.string(),
  revoked: z.boolean(),
  revokedAt: z.string().nullable(),
  emailDelivery: z.enum(["QUEUED", "SENT", "FAILED", "NOT_QUEUED"]),
});
export type LearnerCertificate = z.infer<typeof certificateSchema>;

const issueResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    replayed: z.boolean(),
    certificate: certificateSchema,
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

// Idempotent: a repeat returns the same certificate and never queues a
// second email. NOT_COMPLETED until the completion row exists.
export async function issueMyCertificate(enrolmentId: unknown) {
  return issueResultSchema.parse(
    await callLearnerRpc("issue_my_certificate", {
      p_enrolment_id: z.uuid().parse(enrolmentId),
    }),
  );
}

export async function getMyCertificates() {
  return z
    .object({
      certificates: z.array(certificateSchema),
      eligible: z.array(
        z.object({
          enrolmentId: z.uuid(),
          courseTitle: z.string(),
          completedAt: z.string(),
        }),
      ),
    })
    .parse(await callLearnerRpc("get_my_certificates"));
}

export async function getMyCertificate(certificateId: unknown) {
  return certificateSchema.parse(
    await callLearnerRpc("get_my_certificate", {
      p_certificate_id: z.uuid().parse(certificateId),
    }),
  );
}

export const verificationSchema = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    valid: z.boolean(),
    revoked: z.boolean(),
    verificationCode: z.string(),
    learnerName: z.string(),
    courseTitle: z.string(),
    issuerName: z.string(),
    completedOn: z.string(),
    issuedOn: z.string(),
    revokedOn: z.string().nullable(),
    preparationCourse: z.boolean(),
  }),
]);
export type CertificateVerification = z.infer<typeof verificationSchema>;

// Public: anonymous or signed-in. Returns only the minimal public fields.
export async function verifyCertificate(
  code: unknown,
): Promise<CertificateVerification> {
  const parsed = z.string().trim().min(16).max(40).safeParse(code);
  if (!parsed.success) return { found: false };
  const { data, error } = await (
    await createSupabase()
  ).rpc("verify_certificate", { p_code: parsed.data });
  if (error) throw new Error("VERIFICATION_UNAVAILABLE");
  return verificationSchema.parse(data);
}

// ---------------------------------------------------------------------------
// PDF rendering (pdf-lib standard fonts, WinAnsi). Characters the standard
// fonts cannot encode are transliterated where possible, else replaced, so a
// learner's name can never make generation fail.
// ---------------------------------------------------------------------------
export const DUCELIO_INDIGO = rgb(0x31 / 255, 0x26 / 255, 0x80 / 255);
const INK = rgb(0.13, 0.13, 0.18);
const MUTED = rgb(0.38, 0.38, 0.45);

export function pdfSafeText(font: PDFFont, text: string) {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    if (supported.has(ch.codePointAt(0)!)) {
      out += ch;
      continue;
    }
    const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += [...base].every((c) => supported.has(c.codePointAt(0)!))
      ? base
      : "?";
  }
  return out;
}

export function wrapText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
) {
  const lines: string[] = [];
  let line = "";
  for (const word of pdfSafeText(font, text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line)
      line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawCentred(
  page: PDFPage,
  font: PDFFont,
  text: string,
  y: number,
  size: number,
  color = INK,
) {
  const safe = pdfSafeText(font, text);
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, {
    x: (page.getWidth() - width) / 2,
    y,
    size,
    font,
    color,
  });
}

// Shrinks a single line to fit, down to a floor, before wrapping.
function fitSize(font: PDFFont, text: string, size: number, maxWidth: number) {
  let s = size;
  while (
    s > 14 &&
    font.widthOfTextAtSize(pdfSafeText(font, text), s) > maxWidth
  )
    s -= 1;
  return s;
}

export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

export async function renderCertificatePdf(
  certificate: LearnerCertificate,
  options: { appUrl: string },
): Promise<Uint8Array> {
  const c = certificateSchema.parse(certificate);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificate of Completion - ${c.courseTitle}`);
  pdf.setAuthor(c.issuerName);
  pdf.setSubject(`Ducelio certificate ${c.verificationCode}`);
  pdf.setCreator("Ducelio");
  pdf.setProducer("Ducelio");
  const page = pdf.addPage([841.89, 595.28]); // A4 landscape
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();

  // Frame: an indigo outer border, a thin inner rule and a top band.
  page.drawRectangle({
    x: 18,
    y: 18,
    width: width - 36,
    height: height - 36,
    borderColor: DUCELIO_INDIGO,
    borderWidth: 4,
  });
  page.drawRectangle({
    x: 30,
    y: 30,
    width: width - 60,
    height: height - 60,
    borderColor: DUCELIO_INDIGO,
    borderWidth: 0.8,
  });
  page.drawRectangle({
    x: 30,
    y: height - 92,
    width: width - 60,
    height: 62,
    color: DUCELIO_INDIGO,
  });
  drawCentred(page, sansBold, "DUCELIO", height - 62, 22, rgb(1, 1, 1));
  drawCentred(page, sans, "THE DIGITAL ACADEMY", height - 80, 9, rgb(1, 1, 1));

  drawCentred(page, serifBold, "Certificate of Completion", height - 150, 34);
  drawCentred(page, serif, "This is to certify that", height - 190, 14, MUTED);
  const nameSize = fitSize(serifBold, c.learnerName, 30, width - 160);
  drawCentred(
    page,
    serifBold,
    c.learnerName,
    height - 232,
    nameSize,
    DUCELIO_INDIGO,
  );
  page.drawLine({
    start: { x: width / 2 - 180, y: height - 244 },
    end: { x: width / 2 + 180, y: height - 244 },
    thickness: 0.8,
    color: DUCELIO_INDIGO,
  });
  drawCentred(
    page,
    serif,
    "has successfully completed the course",
    height - 272,
    14,
    MUTED,
  );
  let y = height - 304;
  for (const line of wrapText(serifBold, c.courseTitle, 20, width - 200).slice(
    0,
    2,
  )) {
    drawCentred(page, serifBold, line, y, 20);
    y -= 24;
  }
  drawCentred(page, sans, `Provided by ${c.issuerName}`, y - 4, 12, INK);
  drawCentred(
    page,
    sans,
    `Completed on ${formatDate(c.completedAt)}`,
    y - 24,
    12,
    INK,
  );

  // Footer: issue date and verification on the left and right.
  const verifyUrl = `${options.appUrl}/verify?code=${c.verificationCode}`;
  page.drawText(pdfSafeText(sans, `Issued ${formatDate(c.issuedAt)}`), {
    x: 60,
    y: 112,
    size: 10,
    font: sans,
    color: MUTED,
  });
  page.drawText(
    pdfSafeText(sansBold, `Verification code: ${c.verificationCode}`),
    {
      x: 60,
      y: 96,
      size: 10,
      font: sansBold,
      color: INK,
    },
  );
  page.drawText(pdfSafeText(sans, `Verify at ${verifyUrl}`), {
    x: 60,
    y: 81,
    size: 9,
    font: sans,
    color: MUTED,
  });
  if (c.examinationBody) {
    let dy = 112;
    for (const line of wrapText(sans, PREPARATION_DISCLAIMER, 8.5, 320)) {
      page.drawText(line, {
        x: width - 380,
        y: dy,
        size: 8.5,
        font: sans,
        color: MUTED,
      });
      dy -= 12;
    }
  }
  if (c.revoked)
    drawCentred(page, sansBold, "REVOKED", 150, 28, rgb(0.7, 0.1, 0.1));
  return pdf.save({ useObjectStreams: false });
}
