import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedActor } from "@/server/identity";
import { LearnerServiceError } from "@/server/learner-profile";
import {
  getMyPaymentReceipt,
  renderReceiptPdf,
  sellerIdentity,
} from "@/server/learner-receipts";

// Owner-only receipt PDF, rendered from the authoritative order rows. Seller
// identity comes from configuration; when absent the PDF says so.
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const actor = await getAuthenticatedActor().catch(() => null);
  if (!actor)
    return NextResponse.json(
      { error: "Sign in required" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  if (!actor.roles.includes("STUDENT"))
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403, headers: PRIVATE_HEADERS },
    );
  try {
    const receipt = await getMyPaymentReceipt(id);
    const pdf = await renderReceiptPdf(receipt, sellerIdentity());
    return new Response(Buffer.from(pdf), {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `attachment; filename="ducelio-receipt-${receipt.receiptNumber}.pdf"`,
      },
    });
  } catch (error) {
    const notFound =
      (error instanceof LearnerServiceError &&
        error.code === "NOT_FOUND_OR_FORBIDDEN") ||
      (error instanceof Error && error.name === "ZodError");
    return NextResponse.json(
      { error: notFound ? "Not found" : "Unavailable" },
      { status: notFound ? 404 : 503, headers: PRIVATE_HEADERS },
    );
  }
}
