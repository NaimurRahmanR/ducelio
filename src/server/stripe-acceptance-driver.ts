import "server-only";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/env";

// ============================================================================
// Commercial V1 STRIPE TEST-MODE acceptance: the fail-closed gate for
// src/app/api/acceptance/stripe-app/route.ts. Its only caller is
// scripts/acceptance/stripe.mjs (`npm run acceptance:stripe`), which starts
// a local `next dev` child for exactly one explicitly double-authorized,
// operator-attended run.
//
// The route adds no commerce logic of its own: it is a thin HTTP hop into
// the EXISTING production createCommercialV1Checkout and
// reconcileCommercialV1Order, executed inside a real Next.js request so
// identity resolves exactly as it does for the product. It is deliberately
// NOT the examiner-app gate (src/server/acceptance-app-driver.ts): Stripe
// acceptance has no AI provider redirect to attest, and this gate refuses to
// run in a process carrying any examiner-app or live-provider driver marker.
// The route answers 404 unless EVERY one of these holds, checked before the
// body is read, anyone is signed in or any operation runs:
//
//   1. ACCEPTANCE_STRIPE_DRIVER_ENABLED is exactly "true" (set only in the
//      driver's own child process, never by any deployment);
//   2. NODE_ENV is not "production";
//   3. ACCEPTANCE_STRIPE_DRIVER_TOKEN is a 64-hex per-run secret and the
//      request presents exactly that value (constant-time comparison);
//   4. ACCEPTANCE_STRIPE_TEST_OPT_IN is exactly "true";
//   5. ACCEPTANCE_STRIPE_AUTHORIZED is exactly "true" -- the driver's
//      propagation of the operator's explicit --authorize-stripe-test flag;
//   6. STRIPE_SECRET_KEY in this process has the Stripe TEST-mode shape
//      (sk_test_...), so this route can never drive a live-mode account;
//   7. ACCEPTANCE_ENVIRONMENT_ID is a UUID (the route additionally requires
//      the hosted get_ducelio_acceptance_environment_id() RPC to return it
//      for the caller's real session);
//   8. no examiner-app / live-provider driver marker and no
//      ACCEPTANCE_STRIPE_LIVE_OPT_IN value is present in this process;
//   9. APP_URL and the request's own Host are loopback;
//  10. the request carries no Origin / Sec-Fetch-Site header.
// ============================================================================

export const STRIPE_ACCEPTANCE_DRIVER_HEADER =
  "x-ducelio-stripe-acceptance-driver";

const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identical to scripts/acceptance/stripe.mjs's STRIPE_TEST_SECRET_KEY (src/**
// never imports scripts/**); a test pins them equal.
export const STRIPE_TEST_SECRET_KEY_SHAPE = /^sk_test_[0-9A-Za-z]{16,}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Present only in another acceptance driver's child process, or reserved for
// a separate future live-money phase. Any value here refuses the route.
const FOREIGN_MARKERS = [
  "ACCEPTANCE_APP_DRIVER_ENABLED",
  "ACCEPTANCE_APP_DRIVER_TOKEN",
  "ACCEPTANCE_PROVIDER_STUB_URL",
  "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
  "ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED",
  "ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN",
  "ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED",
  "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
] as const;

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function stripeAcceptanceRequestAllowed(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.ACCEPTANCE_STRIPE_DRIVER_ENABLED !== "true") return false;
  if (env.NODE_ENV === "production") return false;
  const expected = env.ACCEPTANCE_STRIPE_DRIVER_TOKEN ?? "";
  if (!TOKEN.test(expected)) return false;
  if (env.ACCEPTANCE_STRIPE_TEST_OPT_IN !== "true") return false;
  if (env.ACCEPTANCE_STRIPE_AUTHORIZED !== "true") return false;
  if (!STRIPE_TEST_SECRET_KEY_SHAPE.test(env.STRIPE_SECRET_KEY?.trim() ?? ""))
    return false;
  if (!UUID.test(env.ACCEPTANCE_ENVIRONMENT_ID?.trim() ?? "")) return false;
  if (FOREIGN_MARKERS.some((name) => (env[name] ?? "") !== "")) return false;
  const supplied = request.headers.get(STRIPE_ACCEPTANCE_DRIVER_HEADER) ?? "";
  if (!TOKEN.test(supplied)) return false;
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    return false;
  let appHost: string;
  try {
    appHost = new URL(config().appUrl).host;
  } catch {
    return false;
  }
  if (!isLoopbackHost(appHost)) return false;
  if (!isLoopbackHost(request.headers.get("host"))) return false;
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site"))
    return false;
  return true;
}
