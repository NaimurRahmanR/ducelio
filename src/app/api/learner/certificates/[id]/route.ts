import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/env";
import { getAuthenticatedActor } from "@/server/identity";
import {
  getMyCertificate,
  renderCertificatePdf,
} from "@/server/learner-certificates";
import { LearnerServiceError } from "@/server/learner-profile";

// Owner-only certificate PDF download, rendered on request from the issued
// certificate row (never from client data).
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
    const certificate = await getMyCertificate(id);
    const pdf = await renderCertificatePdf(certificate, {
      appUrl: config().appUrl,
    });
    return new Response(Buffer.from(pdf), {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `attachment; filename="ducelio-certificate-${certificate.verificationCode}.pdf"`,
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
