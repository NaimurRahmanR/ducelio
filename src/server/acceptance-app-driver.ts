import "server-only";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/env";

// ============================================================================
// Commercial V1 examiner-app acceptance: the fail-closed gate for
// src/app/api/acceptance/examiner-app/route.ts.
//
// That route exists ONLY so scripts/acceptance/examiner-app.mjs can drive
// the EXISTING production grading/recovery/regrade entrypoints through the
// real running Next.js server (docs/38: the HMAC canonical message is built
// in exactly one place, src/server/commercial-v1-examiner-*/authority.ts,
// and no acceptance script may build a second one). It adds no authority of
// its own. It is unreachable -- the route answers 404 -- unless EVERY one of
// these independent conditions holds for the request:
//
//   1. ACCEPTANCE_APP_DRIVER_ENABLED is exactly "true" (never set by any
//      deployment; the driver sets it only in its own child app process);
//   2. NODE_ENV is not "production" (defence in depth only -- never the
//      boundary on its own);
//   3. ACCEPTANCE_APP_DRIVER_TOKEN is a 64-hex per-run secret and the
//      request presents exactly that value (constant-time comparison) --
//      the driver generates a fresh one per run and never persists it;
//   4. ACCEPTANCE_ENVIRONMENT_ID is a UUID (the route additionally requires
//      the hosted get_ducelio_acceptance_environment_id() RPC to return it
//      for the caller's real session -- see acceptanceEnvironmentMatches);
//   5. APP_URL and the request's own Host are loopback, so a deployed app
//      (https://<public host>) can never satisfy the gate;
//   6. the request carries no Origin / Sec-Fetch-Site header, i.e. it is
//      not a browser request (browsers always send these on a POST; the
//      driver's Node fetch sends neither);
//   7. the provider redirect is attested live IN THIS PROCESS (see
//      providerRedirectAttested below) -- checked last, per request, before
//      the route reads the body, signs anyone in or calls any operation.
// ============================================================================

export const ACCEPTANCE_APP_DRIVER_HEADER = "x-ducelio-acceptance-driver";

const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

// Independent-review V1 blocker: loading the driver's preload through
// NODE_OPTIONS is never treated as proof that provider traffic is
// redirected in the process serving THIS request. The preload
// (scripts/acceptance/examiner-provider-redirect.mjs) installs a wrapper
// marked with the per-run ACCEPTANCE_PROVIDER_REDIRECT_TOKEN that answers
// one in-process sentinel request with that marker. This calls the CURRENT
// globalThis.fetch -- whatever it is now -- with that sentinel. Next.js
// re-wraps globalThis.fetch inside its server (patchFetch/dedupe, which do
// not expose what they wrap), so an identity check on the function would
// refuse every real request; calling it proves the marked wrapper is in the
// exact fetch chain the production provider adapter will use for this
// request. If the preload is absent, or fetch was replaced by anything not
// routing through the wrapper, nothing answers: the sentinel's .invalid
// host can never resolve (no HTTP connection is possible), the call fails
// or returns without the marker, and the gate refuses. These constants are
// duplicated verbatim from scripts/acceptance/examiner-provider-stub.mjs
// (src/** never imports scripts/**); a test pins them equal.
export const PROVIDER_REDIRECT_ATTESTATION_URL =
  "http://provider-redirect-attestation.ducelio.invalid/v1";
export const PROVIDER_REDIRECT_ATTESTATION_HEADER =
  "x-ducelio-provider-redirect-attestation";

export async function providerRedirectAttested(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const expected = env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN ?? "";
  if (!TOKEN.test(expected)) return false;
  try {
    const response = await globalThis.fetch(PROVIDER_REDIRECT_ATTESTATION_URL, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    const supplied =
      response.headers.get(PROVIDER_REDIRECT_ATTESTATION_HEADER) ?? "";
    return (
      response.status === 204 &&
      TOKEN.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

function requestGatePasses(
  request: Request,
  env: Record<string, string | undefined>,
): boolean {
  if (env.ACCEPTANCE_APP_DRIVER_ENABLED !== "true") return false;
  if (env.NODE_ENV === "production") return false;
  const expected = env.ACCEPTANCE_APP_DRIVER_TOKEN ?? "";
  if (!TOKEN.test(expected)) return false;
  if (!UUID.test(env.ACCEPTANCE_ENVIRONMENT_ID?.trim() ?? "")) return false;
  const supplied = request.headers.get(ACCEPTANCE_APP_DRIVER_HEADER) ?? "";
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

export async function acceptanceAppDriverRequestAllowed(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!requestGatePasses(request, env)) return false;
  return providerRedirectAttested(env);
}

type AcceptanceEnvironmentClient = {
  rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }>;
};

// The existing acceptance-environment binding (docs/38, scripts/acceptance/
// supabase.mjs): the hosted project must itself report exactly this
// deployment's ACCEPTANCE_ENVIRONMENT_ID through the operator-provisioned,
// authenticated-only get_ducelio_acceptance_environment_id() RPC. It is
// never a Ducelio migration, so a real production project cannot answer it.
export async function acceptanceEnvironmentMatches(
  client: AcceptanceEnvironmentClient,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const expected = env.ACCEPTANCE_ENVIRONMENT_ID?.trim().toLowerCase() ?? "";
  if (!UUID.test(expected)) return false;
  try {
    const { data, error } = await client.rpc(
      "get_ducelio_acceptance_environment_id",
    );
    return (
      !error &&
      typeof data === "string" &&
      data.trim().toLowerCase() === expected
    );
  } catch {
    return false;
  }
}
