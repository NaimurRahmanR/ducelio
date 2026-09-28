// Preload for the LOCAL acceptance app process only. scripts/acceptance/
// examiner-app.mjs passes it to the `next dev` child it spawns via
// NODE_OPTIONS=--import=<this file>; nothing else loads it, and no src/**
// module references it. Refuses to load (the child app then fails to start,
// and the driver reports BLOCKED) unless the driver's own per-run
// acceptance settings are present -- it can never silently install itself.
//
// Loading this preload is NOT itself treated as proof the redirect is live:
// the installed wrapper carries the per-run ACCEPTANCE_PROVIDER_REDIRECT_TOKEN
// as its own marker, and the acceptance route gate
// (src/server/acceptance-app-driver.ts) attests, inside the exact process
// serving each acceptance request, that the CURRENT globalThis.fetch routes
// through this marked wrapper before any operation runs. See
// examiner-provider-stub.mjs's PROVIDER_REDIRECT_MARKER comment.
//
// ACCEPTANCE_CONTEXT_HOLD_URL/_TOKEN are set only by the concurrency
// driver's app child (scripts/acceptance/concurrency-app-races.mjs) and
// enable the context-read delivery hold described in
// examiner-provider-stub.mjs. Both or neither: a half-configured hold
// refuses to load rather than silently running without it.
import { createProviderRedirectFetch } from "./examiner-provider-stub.mjs";

const redirectToken = process.env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN ?? "";
if (
  process.env.ACCEPTANCE_APP_DRIVER_ENABLED !== "true" ||
  !process.env.ACCEPTANCE_PROVIDER_STUB_URL ||
  !/^[0-9a-f]{64}$/.test(redirectToken)
)
  throw new Error(
    "examiner-provider-redirect.mjs may only be loaded by the examiner app acceptance driver.",
  );

const holdUrl = process.env.ACCEPTANCE_CONTEXT_HOLD_URL ?? "";
const holdToken = process.env.ACCEPTANCE_CONTEXT_HOLD_TOKEN ?? "";
if (Boolean(holdUrl) !== Boolean(holdToken))
  throw new Error(
    "examiner-provider-redirect.mjs: the acceptance context-read hold must be configured completely or not at all.",
  );

// ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL is set only by the customer-journey
// driver's app child (scripts/acceptance/customer-journey.mjs), together with
// ACCEPTANCE_JOURNEY_DRIVER_ENABLED. Otherwise Anthropic stays refused.
const anthropicStubUrl =
  process.env.ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL ?? "";
if (
  anthropicStubUrl &&
  process.env.ACCEPTANCE_JOURNEY_DRIVER_ENABLED !== "true"
)
  throw new Error(
    "examiner-provider-redirect.mjs: the Anthropic stub redirect is available to the customer-journey driver only.",
  );

globalThis.fetch = createProviderRedirectFetch(
  globalThis.fetch.bind(globalThis),
  process.env.ACCEPTANCE_PROVIDER_STUB_URL,
  redirectToken,
  holdUrl
    ? {
        url: holdUrl,
        token: holdToken,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      }
    : null,
  { anthropicStubUrl: anthropicStubUrl || null },
);
