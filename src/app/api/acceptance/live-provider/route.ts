import { NextResponse } from "next/server";
import { z } from "zod";
import {
  LIVE_PROVIDER_SMOKE_OPERATIONS,
  liveProviderAcceptanceRequestAllowed,
  runLiveProviderSmoke,
} from "@/server/live-provider-acceptance-driver";

// ============================================================================
// ACCEPTANCE-ONLY. Not a product API. See src/server/live-provider-
// acceptance-driver.ts for the fail-closed gate (404 unless every
// acceptance condition holds) and scripts/acceptance/live-provider.mjs for
// its only caller.
//
// The caller chooses exactly one of three fixed operations and nothing else.
// The strict schema rejects any other field -- provider, model, profile,
// endpoint, key, budget, context, role, capability, prompt/instructions --
// with 400 before any provider work. The response carries safe metadata
// only (see LiveProviderSmokeEvidence): never raw model output, provider
// request/response content, the synthetic context or a key.
// ============================================================================

export const dynamic = "force-dynamic";

const requestSchema = z.strictObject({
  operation: z.enum(LIVE_PROVIDER_SMOKE_OPERATIONS),
});

const NO_STORE = { "Cache-Control": "private, no-store" };
function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
function notFound() {
  return new NextResponse(null, { status: 404, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!liveProviderAcceptanceRequestAllowed(request)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST" });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "INVALID_REQUEST" });

  try {
    const evidence = await runLiveProviderSmoke(parsed.data.operation);
    return json(200, { ok: true, evidence });
  } catch {
    return json(500, { error: "OPERATION_FAILED" });
  }
}
