import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedActor } from "@/server/identity";
import { readPrivateFile } from "@/server/learner-files";

// Private learner files: the owner, or (attached lab evidence only) a reviewer
// of the course's own organisation, as decided by read_private_file. Images
// render inline for the profile page; PDFs and text always download. Nothing
// is cached and nothing is sniffed or scripted by the browser.
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    if (!(await getAuthenticatedActor()))
      return NextResponse.json(
        { error: "Sign in required" },
        { status: 401, headers: PRIVATE_HEADERS },
      );
    const file = await readPrivateFile(id);
    if (!file)
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    const inline = file.contentType.startsWith("image/");
    const contentType =
      file.contentType === "text/plain"
        ? "text/plain; charset=utf-8"
        : file.contentType;
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": contentType,
        "Content-Length": String(file.bytes.length),
        // fileName is restricted to [A-Za-z0-9._() -] by the database.
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${file.fileName}"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
