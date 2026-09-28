import "server-only";
import { acceptanceAppDriverRequestAllowed } from "./acceptance-app-driver";

// ============================================================================
// Commercial V1 FULL_CUSTOMER_JOURNEY acceptance: the fail-closed gate for
// src/app/api/acceptance/customer-journey/route.ts. Its only caller is
// scripts/acceptance/customer-journey.mjs (`npm run acceptance:journey`).
//
// It adds no authority and no second copy of any gate logic: the request
// must first satisfy ONE extra, journey-only condition --
// ACCEPTANCE_JOURNEY_DRIVER_ENABLED is exactly "true", which only the
// journey driver's own child app process ever sets (scripts/acceptance/
// examiner-app.mjs's buildAppChildEnv forces it empty for every other
// driver) -- and then EVERY condition of the already-reviewed examiner-app
// gate (src/server/acceptance-app-driver.ts): the driver enable flag,
// non-production NODE_ENV, the per-run 64-hex token (constant-time), a UUID
// ACCEPTANCE_ENVIRONMENT_ID, loopback APP_URL and Host, no Origin /
// Sec-Fetch-Site header, and the per-request attestation that provider
// traffic in THIS process routes through the marked loopback stub redirect.
// Anything else answers 404 before the body is read, anyone is signed in or
// any operation runs.
// ============================================================================

export async function customerJourneyRequestAllowed(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (env.ACCEPTANCE_JOURNEY_DRIVER_ENABLED !== "true") return false;
  return acceptanceAppDriverRequestAllowed(request, env);
}
