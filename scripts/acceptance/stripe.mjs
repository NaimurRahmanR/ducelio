#!/usr/bin/env node
// npm run acceptance:stripe [-- --authorize-stripe-test]
//
// Commercial V1 STRIPE TEST-MODE acceptance (docs/38 section 6). An
// operator-attended, explicitly double-authorized run that exercises the
// EXISTING production commerce implementation against the dedicated hosted
// acceptance environment and a Stripe TEST-mode (sandbox) account. It never
// reimplements checkout, fulfillment, the webhook or the commerce HMAC:
//
//   buyer session -> acceptance route CREATE_CHECKOUT
//                 -> createCommercialV1Checkout (production) -> Stripe
//                    Checkout Session (production StripeCommerceProvider,
//                    order-derived idempotency key) -> session bound once
//   buyer session -> acceptance route RECONCILE_ORDER
//                 -> reconcileCommercialV1Order (production success path)
//   ONE manual Stripe-hosted sandbox payment by the operator (test card)
//   genuine Stripe test-mode checkout.session.completed Event, retrieved
//   from Stripe's TEST API, signed locally with stripe-node's official
//   webhooks.generateTestHeaderString helper -> POST to the UNCHANGED
//   production route /api/commerce/stripe-webhook -> verifyWebhookEvent ->
//   attestCommerceFulfillment -> fulfill_commercial_v1_order (hosted DB)
//
// Seven surfaces: STRIPE_TEST:CHECKOUT_BINDING, :REDIRECT_NOT_PAYMENT_PROOF,
// :SIGNED_WEBHOOK_FULFILLMENT, :DUPLICATE_WEBHOOK_IDEMPOTENCY,
// :RECONCILIATION_REPLAY, :REVIEWER_COMPLIMENTARY, :ZERO_PRICE_PROMO_GUARD.
//
// Authorization. A configured Stripe key is NEVER permission. A run needs
// BOTH ACCEPTANCE_STRIPE_TEST_OPT_IN exactly "true" AND the explicit
// --authorize-stripe-test command-line flag; anything else BLOCKS every
// surface before any server, database or Stripe request. The command
// accepts no other argument (unknown arguments are never echoed): no
// run-all mode, endpoint, price, currency or Stripe object selector.
// ACCEPTANCE_STRIPE_LIVE_OPT_IN is reserved for a separate future
// live-money phase and never authorizes this command. A live-mode-shaped key
// (sk_live_/rk_live_/pk_live_) is refused regardless of any flag; the key
// must have the sk_test_ shape, Stripe itself must report the account's
// balance as livemode=false before anything is written, and every Checkout
// Session / Event used must carry livemode=false. This file contains no
// mechanism that can perform a live-money run.
//
// Boundary of the evidence. Stripe cannot deliver a webhook to this
// loopback-only app, so the webhook leg proves the APPLICATION boundary --
// production signature verification, authority and hosted database
// fulfillment of a GENUINE Stripe test-mode event -- never Stripe's network
// delivery to a deployed public endpoint. That remains production
// deployment/operational acceptance.
//
// Secrets. The child app receives only what its production path needs
// (Supabase URL/publishable key, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// COMMERCE_CONTROLLER_*, ACCEPTANCE_ENVIRONMENT_ID, loopback APP_URL, the
// per-run gate settings). Every other inherited credential-shaped name and
// every name in any .env* file Next.js could load is forced empty; an env
// file that cannot be inspected BLOCKS the run before the app starts.
// Nothing here prints a Stripe key, webhook secret, HMAC key, password,
// cookie, JWT, raw event body, raw Stripe object or signature.
//
// Writes. Two permanent, run-id-tagged acceptance courses through the SAME
// gated seedAcceptanceCourse every other acceptance script uses
// (ACCEPTANCE_WRITE_ENABLED + marker row + hosted environment id), their
// offers and one reviewer campaign through the governed admin RPCs, plus
// the institutional history the production entrypoints themselves write.
// Nothing is ever deleted.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import Stripe from "stripe";
import { KNOWN_VARS } from "./env.mjs";
import {
  withConnection,
  withAcceptanceWriteConnection,
  resolveAppUserId,
  AcceptanceWriteNotAuthorizedError,
} from "./db.mjs";
import {
  acceptanceIdentities,
  assertAcceptanceSupabaseWriteAuthorized,
} from "./supabase.mjs";
import { seedAcceptanceCourse } from "./fixtures.mjs";
import { createCookieJar } from "./examiner-app.mjs";
import { readEnvFileNames, EnvFileInspectionError } from "./live-provider.mjs";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
} from "./report.mjs";

export const AUTHORIZE_FLAG = "--authorize-stripe-test";
export const OPT_IN_VAR = "ACCEPTANCE_STRIPE_TEST_OPT_IN";
export const LIVE_OPT_IN_VAR = "ACCEPTANCE_STRIPE_LIVE_OPT_IN";
export const ROUTE_PATH = "/api/acceptance/stripe-app";
export const WEBHOOK_PATH = "/api/commerce/stripe-webhook";
export const DRIVER_HEADER = "x-ducelio-stripe-acceptance-driver";
// Identical to src/server/stripe-acceptance-driver.ts's
// STRIPE_TEST_SECRET_KEY_SHAPE; a test pins them equal.
export const STRIPE_TEST_SECRET_KEY = /^sk_test_[0-9A-Za-z]{16,}$/;
const STRIPE_LIVE_KEY = /^(sk|rk|pk)_live_/;
const STRIPE_WEBHOOK_SECRET = /^whsec_\S{8,}$/;
// Code-owned, never CLI/env input: a tiny, Stripe-valid GBP test amount.
export const TEST_PRICE = Object.freeze({ amountMinor: 100, currency: "GBP" });

export const SURFACES = Object.freeze({
  CHECKOUT_BINDING: "STRIPE_TEST:CHECKOUT_BINDING",
  REDIRECT_NOT_PAYMENT_PROOF: "STRIPE_TEST:REDIRECT_NOT_PAYMENT_PROOF",
  SIGNED_WEBHOOK_FULFILLMENT: "STRIPE_TEST:SIGNED_WEBHOOK_FULFILLMENT",
  DUPLICATE_WEBHOOK_IDEMPOTENCY: "STRIPE_TEST:DUPLICATE_WEBHOOK_IDEMPOTENCY",
  RECONCILIATION_REPLAY: "STRIPE_TEST:RECONCILIATION_REPLAY",
  REVIEWER_COMPLIMENTARY: "STRIPE_TEST:REVIEWER_COMPLIMENTARY",
  ZERO_PRICE_PROMO_GUARD: "STRIPE_TEST:ZERO_PRICE_PROMO_GUARD",
});

export const TRUTHFULNESS_STATEMENT =
  "A PASS here establishes only STRIPE TEST MODE acceptance for the named surface: the existing production commerce code, driven through the real Ducelio app server against the hosted acceptance environment and a Stripe TEST-mode account, with one manual Stripe-hosted sandbox payment. The webhook surfaces deliver a GENUINE Stripe test-mode event to the production webhook route after signing it locally with stripe-node's official test helper, so they prove the application webhook boundary, not Stripe's network delivery to a deployed public endpoint. No real money or real card is involved. This is not live-money payment acceptance, not production webhook endpoint availability, not card/payment quality, refund/dispute or subscription evidence, and not production-readiness proof.";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NEXT_BIN = fileURLToPath(
  new URL("../../node_modules/next/dist/bin/next", import.meta.url),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TEST_SESSION_ID = /^cs_test_[0-9A-Za-z]{1,190}$/;
const OPERATOR_TIMEOUT_MS = 30 * 60_000;

const ZERO_CALLS =
  "Zero Stripe requests were made, no server was started and nothing was written.";

function blockAll(reason, details) {
  return Object.values(SURFACES).map((surface) =>
    blocked(surface, reason, details),
  );
}

// ---------------------------------------------------------------------------
// Authorization. Pure: reads argv, the exact opt-in values and key SHAPES
// only. Arguments are never echoed (one could be a pasted key).
// ---------------------------------------------------------------------------
export function parseCliArgs(argv) {
  let authorizeCount = 0;
  let unrecognized = 0;
  for (const arg of argv) {
    if (arg === AUTHORIZE_FLAG) authorizeCount += 1;
    else unrecognized += 1;
  }
  return {
    authorized: authorizeCount === 1 && unrecognized === 0,
    unrecognized,
    repeated: authorizeCount > 1,
  };
}

function configuredIn(env, name) {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const entry = KNOWN_VARS.find((e) => e.name === name);
  return entry?.validate ? entry.validate(raw.trim()) : true;
}

// Names only -- a value is never read into a message.
export function stripePrerequisites(env, { nextBinExists = true } = {}) {
  const missing = [];
  for (const name of [
    "ACCEPTANCE_DATABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "ACCEPTANCE_ENVIRONMENT_ID",
    "ACCEPTANCE_ADMIN_EMAIL",
    "ACCEPTANCE_ADMIN_PASSWORD",
    "ACCEPTANCE_LEARNER_EMAIL",
    "ACCEPTANCE_LEARNER_PASSWORD",
    "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
    "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
    "COMMERCE_CONTROLLER_KEY_ID",
    "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
  ])
    if (!configuredIn(env, name)) missing.push(name);
  if (env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    missing.push("ACCEPTANCE_WRITE_ENABLED");
  if (!STRIPE_TEST_SECRET_KEY.test(env.STRIPE_SECRET_KEY?.trim() ?? ""))
    missing.push("STRIPE_SECRET_KEY (Stripe TEST-mode sk_test_ key)");
  if (!STRIPE_WEBHOOK_SECRET.test(env.STRIPE_WEBHOOK_SECRET?.trim() ?? ""))
    missing.push("STRIPE_WEBHOOK_SECRET");
  if (!nextBinExists) missing.push("node_modules/next (npm install)");
  return missing;
}

// Returns { runnable: true } or { runnable: false, results } -- never a key.
export function planStripeRun(env, argv, { nextBinExists = true } = {}) {
  // Refused regardless of any flag, before anything else is considered.
  if (STRIPE_LIVE_KEY.test(env.STRIPE_SECRET_KEY?.trim() ?? ""))
    return {
      runnable: false,
      results: blockAll("LIVE_MODE_KEY_REFUSED", [
        "STRIPE_SECRET_KEY has a LIVE-mode shape. This command only ever runs against a Stripe TEST-mode (sandbox) account and contains no live-money mode.",
        ZERO_CALLS,
      ]),
    };
  const { authorized, unrecognized, repeated } = parseCliArgs(argv);
  if (unrecognized > 0)
    return {
      runnable: false,
      results: blockAll("UNRECOGNIZED_ARGUMENT", [
        `Only ${AUTHORIZE_FLAG} is accepted (arguments are never echoed).`,
        ZERO_CALLS,
      ]),
    };
  if (repeated)
    return {
      runnable: false,
      results: blockAll("REPEATED_ARGUMENT", [
        `${AUTHORIZE_FLAG} was given more than once.`,
        ZERO_CALLS,
      ]),
    };
  const optedIn = env[OPT_IN_VAR] === "true";
  if (!optedIn || !authorized) {
    const details = [];
    if (!optedIn) details.push(`${OPT_IN_VAR} is not exactly 'true'.`);
    if (!authorized)
      details.push(`The ${AUTHORIZE_FLAG} command-line flag was not given.`);
    details.push(
      "Stripe test-mode acceptance requires BOTH; a configured Stripe key is never itself permission.",
    );
    if ((env[LIVE_OPT_IN_VAR] ?? "").trim() !== "")
      details.push(
        `${LIVE_OPT_IN_VAR} is reserved for a separate future live-money phase and never authorizes this command.`,
      );
    details.push(ZERO_CALLS);
    return {
      runnable: false,
      results: blockAll("EXPLICIT_AUTHORIZATION_REQUIRED", details),
    };
  }
  const missing = stripePrerequisites(env, { nextBinExists });
  if (missing.length)
    return {
      runnable: false,
      results: blockAll("PREREQUISITES_MISSING", [
        ...missing.map((name) => `${name} is missing or malformed.`),
        ZERO_CALLS,
      ]),
    };
  return { runnable: true };
}

// ---------------------------------------------------------------------------
// The local application server's environment.
// ---------------------------------------------------------------------------
// Forwarded (trimmed) from the operator's environment: exactly what the
// production checkout/reconcile/webhook path and the route gate read.
export const FORWARDED_TO_STRIPE_APP = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "COMMERCE_CONTROLLER_KEY_ID",
  "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
  "ACCEPTANCE_ENVIRONMENT_ID",
]);
export const WITHHELD_FROM_STRIPE_APP = Object.freeze([
  "ACCEPTANCE_DATABASE_URL",
  "ACCEPTANCE_DATABASE_INSECURE_TLS",
  "ACCEPTANCE_WRITE_ENABLED",
  "ACCEPTANCE_EXPIRED_LEARNER_JWT",
  "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
  "ACCEPTANCE_LIVE_PROVIDER_OPT_IN",
  "ACCEPTANCE_APP_DRIVER_ENABLED",
  "ACCEPTANCE_APP_DRIVER_TOKEN",
  "ACCEPTANCE_PROVIDER_STUB_URL",
  "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
  "ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED",
  "ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN",
  "ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED",
  "ACADEMIC_EXECUTION_KEY_ID",
  "ACADEMIC_EXECUTION_HMAC_KEY_HEX",
  "ACADEMIC_PROVIDER_BASE_URL",
  "ACADEMIC_PROVIDER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  // Not matched by SENSITIVE_NAME below; withheld by name rather than by a
  // broad /PAT/ rule that could blank ordinary variables.
  "GITHUB_PAT",
  "NODE_OPTIONS",
]);
// Any other inherited name that looks like a credential is blanked too
// (the same rule as the live-provider driver).
const SENSITIVE_NAME =
  /^(ACCEPTANCE_|ACADEMIC_|STRIPE_|COMMERCE_|OPENAI_|ANTHROPIC_|PG)|SUPABASE|DATABASE_URL|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
const PER_RUN_TOKEN = /^[0-9a-f]{64}$/;

export function buildStripeChildEnv(
  parentEnv,
  { port, token, authorized, envFileNames = [] },
) {
  if (authorized !== true || parentEnv[OPT_IN_VAR] !== "true")
    throw new Error(
      "A Stripe acceptance child environment requires explicit double authorization.",
    );
  if (!STRIPE_TEST_SECRET_KEY.test(parentEnv.STRIPE_SECRET_KEY?.trim() ?? ""))
    throw new Error("A Stripe TEST-mode secret key is required.");
  if (!PER_RUN_TOKEN.test(token ?? ""))
    throw new Error("The per-run driver token must be 64 lowercase hex.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("A valid loopback port is required.");
  const env = { ...parentEnv };
  for (const name of Object.keys(env))
    if (SENSITIVE_NAME.test(name)) env[name] = "";
  for (const name of envFileNames) env[name] = "";
  for (const name of WITHHELD_FROM_STRIPE_APP) env[name] = "";
  delete env.NODE_ENV;
  const forwarded = Object.fromEntries(
    FORWARDED_TO_STRIPE_APP.map((name) => [
      name,
      (parentEnv[name] ?? "").trim(),
    ]),
  );
  return {
    ...env,
    ...forwarded,
    ACCEPTANCE_STRIPE_DRIVER_ENABLED: "true",
    ACCEPTANCE_STRIPE_DRIVER_TOKEN: token,
    ACCEPTANCE_STRIPE_TEST_OPT_IN: "true",
    ACCEPTANCE_STRIPE_AUTHORIZED: "true",
    APP_URL: `http://127.0.0.1:${port}`,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startAppServer(env, port) {
  const child = spawn(
    process.execPath,
    [
      NEXT_BIN,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      `${port}`,
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  // App output is deliberately NOT forwarded: a framework error page or
  // log line could echo configuration.
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function stopAppServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", `${child.pid}`, "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}

// ---------------------------------------------------------------------------
// HTTP clients. Cookie values and webhook signatures are never printed or
// returned.
// ---------------------------------------------------------------------------
async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function createStripeAppClient({ baseUrl, token, fetchImpl = fetch }) {
  return {
    async call(jar, payload) {
      const response = await fetchImpl(`${baseUrl}${ROUTE_PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [DRIVER_HEADER]: token,
          ...(jar && jar.size ? { cookie: jar.header() } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
      jar?.absorb(response);
      return { status: response.status, body: await readJson(response) };
    },
  };
}

// The UNCHANGED production webhook route. No acceptance header, no cookie:
// exactly what Stripe itself would send.
export function createWebhookClient({ baseUrl, fetchImpl = fetch }) {
  return {
    async post(rawBody, signatureHeader) {
      const headers = { "content-type": "application/json" };
      if (signatureHeader !== null)
        headers["stripe-signature"] = signatureHeader;
      const response = await fetchImpl(`${baseUrl}${WEBHOOK_PATH}`, {
        method: "POST",
        redirect: "manual",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(90_000),
      });
      return { status: response.status, body: await readJson(response) };
    },
  };
}

// stripe-node's own official webhook TEST helper -- the Stripe signature
// scheme is never hand-rolled here. Local computation only; no request.
export function signWebhookPayload(payload, secret) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

// Ready = the route compiled AND its gate admitted this driver: an empty
// body passes the gate and is then refused 400 by strict input validation.
async function waitForAppReady(app, child, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined)
      return "EXITED";
    try {
      const { status } = await app.call(null, {});
      if (status === 400) return "READY";
      if (status === 404) return "GATE_REFUSED";
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "TIMEOUT";
}

// ---------------------------------------------------------------------------
// Bounded parsing of route responses and Stripe objects. Nothing
// unvalidated is ever printed.
// ---------------------------------------------------------------------------
export function checkoutResult(response) {
  if (response?.status !== 200 || response.body?.ok !== true) return null;
  const r = response.body.result;
  if (!r || typeof r !== "object") return null;
  if (r.ok === false)
    return CODE.test(r.code ?? "") ? { kind: "DENIED", code: r.code } : null;
  if (r.ok === true && r.kind === "CHECKOUT")
    return UUID.test(r.orderId ?? "") && typeof r.url === "string"
      ? { kind: "CHECKOUT", orderId: r.orderId, url: r.url }
      : null;
  if (r.ok === true && r.kind === "ACCESS_GRANTED")
    return UUID.test(r.entitlementId ?? "") &&
      UUID.test(r.enrolmentId ?? "") &&
      typeof r.offerSlug === "string"
      ? {
          kind: "ACCESS_GRANTED",
          entitlementId: r.entitlementId,
          enrolmentId: r.enrolmentId,
          offerSlug: r.offerSlug,
        }
      : null;
  return null;
}

export function reconcileResult(response) {
  if (response?.status !== 200 || response.body?.ok !== true) return null;
  const r = response.body.result;
  if (!r || typeof r.ok !== "boolean") return null;
  const bool = (v) => v === null || typeof v === "boolean";
  if (!bool(r.fulfilled) || !bool(r.replay)) return null;
  if (r.code !== null && !CODE.test(r.code ?? "")) return null;
  if (r.orderId !== null && !UUID.test(r.orderId ?? "")) return null;
  return {
    ok: r.ok,
    fulfilled: r.fulfilled,
    replay: r.replay,
    code: r.code,
    orderId: r.orderId,
  };
}

// The payable URL must name exactly this session (Checkout URLs carry the
// session id in their path, including on a custom Checkout domain).
export function checkoutUrlNamesSession(url, sessionId) {
  if (typeof url !== "string" || !TEST_SESSION_ID.test(sessionId ?? ""))
    return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.pathname.split("/").includes(sessionId)
    );
  } catch {
    return false;
  }
}

// Fail-closed Checkout Session validation against DATABASE-owned facts.
// Problems name the drifted field, never its value.
export function checkoutSessionProblems(session, expected) {
  if (!session || typeof session !== "object")
    return ["Stripe returned no Checkout Session."];
  const problems = [];
  if (session.object !== "checkout.session")
    problems.push("The Stripe object is not a checkout.session.");
  if (session.id !== expected.sessionId)
    problems.push(
      "The Stripe session id differs from the database-bound session.",
    );
  if (session.livemode !== false) problems.push("livemode is not false.");
  if (session.mode !== "payment") problems.push("mode is not 'payment'.");
  if (session.payment_status !== expected.paymentStatus)
    problems.push(`payment_status is not '${expected.paymentStatus}'.`);
  if (session.amount_total !== expected.amountMinor)
    problems.push("amount_total differs from the database order amount.");
  if (
    typeof session.currency !== "string" ||
    session.currency.toUpperCase() !== expected.currency
  )
    problems.push("currency differs from the database order currency.");
  if (session.metadata?.orderId !== expected.orderId)
    problems.push("metadata.orderId does not name the exact order.");
  if (session.client_reference_id !== expected.orderId)
    problems.push("client_reference_id does not name the exact order.");
  const methods = session.payment_method_types;
  if (!Array.isArray(methods) || methods.length !== 1 || methods[0] !== "card")
    problems.push("payment_method_types is not exactly ['card'].");
  if (expected.state === "open") {
    if (session.status !== "open") problems.push("The session is not open.");
    if (!checkoutUrlNamesSession(session.url, expected.sessionId))
      problems.push("No open Checkout URL names this session.");
  }
  if (expected.state === "complete" && session.status !== "complete")
    problems.push("The session status is not 'complete'.");
  return problems;
}

// A genuine Stripe test-mode checkout.session.completed Event for exactly
// this session/order, carrying the exact paid amount and currency.
export function completionEventProblems(event, expected) {
  if (!event || typeof event !== "object") return ["Stripe returned no Event."];
  const problems = [];
  if (event.object !== "event") problems.push("The object is not an event.");
  if (typeof event.id !== "string" || !/^evt_[0-9A-Za-z]+$/.test(event.id))
    problems.push("The event id is not a Stripe event id.");
  if (event.type !== "checkout.session.completed")
    problems.push("The event type is not checkout.session.completed.");
  if (event.livemode !== false)
    problems.push("The event livemode is not false.");
  if (
    typeof event.created !== "number" ||
    event.created < expected.sessionCreated
  )
    problems.push("The event predates the session.");
  return [
    ...problems,
    ...checkoutSessionProblems(event.data?.object, {
      ...expected,
      paymentStatus: "paid",
      state: "complete",
    }).map((p) => `Event session: ${p}`),
  ];
}

// Bounded, fail-closed Stripe list pagination. Walks a code-owned filter
// (never caller input) with Stripe's normal starting_after cursor, 100
// objects per page, for at most `pageCap` pages. Only `exhausted: true`
// (Stripe returned has_more=false) licenses an exact "only these match"
// conclusion; a scan that hits the cap -- or cannot advance its cursor --
// while has_more is still true is a partial result and callers must BLOCK
// rather than infer uniqueness from it. Matching objects are kept in
// memory only; nothing here is printed.
export const LIST_PAGE_SIZE = 100;
export const DEFAULT_LIST_PAGE_CAP = 10;

export async function scanBoundedList(list, params, isMatch, pageCap) {
  if (!Number.isInteger(pageCap) || pageCap < 1 || pageCap > 50)
    throw new Error("A small positive page cap is required.");
  const matches = [];
  let pages = 0;
  let startingAfter = null;
  while (pages < pageCap) {
    const page = await list({
      ...params,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    pages += 1;
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const item of data) if (isMatch(item)) matches.push(item);
    if (page?.has_more !== true) return { matches, pages, exhausted: true };
    const last = data[data.length - 1]?.id;
    if (typeof last !== "string" || last === "" || last === startingAfter)
      break;
    startingAfter = last;
  }
  return { matches, pages, exhausted: false };
}

// Bounded error summaries: a Stripe SDK error message can quote part of a
// key, so only its type/code is ever shown; everything is key-redacted.
export function safeErrorSummary(error) {
  if (error && typeof error.type === "string" && /^Stripe/.test(error.type))
    return `Stripe API error (${error.type}${typeof error.code === "string" ? `/${error.code}` : ""}); message withheld.`;
  const message = error instanceof Error ? error.message : "Non-Error thrown.";
  return message
    .replace(/\b(sk|rk|pk)_(test|live)_[0-9A-Za-z]+/g, "[redacted-stripe-key]")
    .replace(/\bwhsec_\S+/g, "[redacted-webhook-secret]")
    .slice(0, 300);
}

async function guardScenario(surface, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blocked(surface, error.message);
    return fail(surface, "Scenario stopped unexpectedly.", [
      safeErrorSummary(error),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Independent, read-only hosted database reads.
// ---------------------------------------------------------------------------
export const Q = Object.freeze({
  orders: `select id, learner_id, offer_id, activation_id, cohort_id, amount_minor, currency, provider,
      provider_session_id, state, fulfilled_at, campaign_redemption_id
    from commercial_v1_orders where learner_id=$1 and activation_id=$2 order by created_at`,
  paymentEventsForOrder: `select provider, provider_event_id, session_id, amount_minor, currency, status
    from commercial_v1_payment_events where order_id=$1`,
  paymentEventsForEvent: `select order_id, session_id, amount_minor, currency, status
    from commercial_v1_payment_events where provider='STRIPE' and provider_event_id=$1`,
  paymentEventCount: `select count(*)::int as n from commercial_v1_payment_events p
    join commercial_v1_orders o on o.id=p.order_id where o.learner_id=$1 and o.activation_id=$2`,
  entitlements: `select id, learner_id, offer_id, activation_id, order_id, enrolment_id, source, campaign_redemption_id, state
    from commercial_v1_entitlements where learner_id=$1 and activation_id=$2`,
  enrolments: `select id, status, programme_version_id from enrolments where student_id=$1 and cohort_id=$2`,
  redemptions: `select id, campaign_id, entitlement_source, effective_price_amount_minor
    from commercial_v1_campaign_redemptions where learner_id=$1 and offer_id=$2`,
  campaignByCode: `select id from commercial_v1_campaigns where code=$1`,
  controllerKeyProbe: `select encode(extensions.hmac(convert_to($2,'UTF8'), secret, 'sha256'),'hex') as probe_mac
    from commercial_v1_commerce_private.controller_keys where id=$1 and revoked_at is null`,
});

// The buyer's complete commerce/academic footprint for one course.
export async function snapshot(ctx, course) {
  const orders = await ctx.query(Q.orders, [ctx.buyerId, course.activationId]);
  const entitlements = await ctx.query(Q.entitlements, [
    ctx.buyerId,
    course.activationId,
  ]);
  const enrolments = await ctx.query(Q.enrolments, [
    ctx.buyerId,
    course.cohortId,
  ]);
  const redemptions = await ctx.query(Q.redemptions, [
    ctx.buyerId,
    course.offerId,
  ]);
  const events = await ctx.query(Q.paymentEventCount, [
    ctx.buyerId,
    course.activationId,
  ]);
  return {
    orders,
    entitlements,
    enrolments,
    redemptions,
    paymentEvents: events[0]?.n ?? 0,
  };
}

const isEmpty = (s) =>
  s.orders.length === 0 &&
  s.entitlements.length === 0 &&
  s.enrolments.length === 0 &&
  s.redemptions.length === 0 &&
  s.paymentEvents === 0;
const time = (v) =>
  v === null || v === undefined ? null : new Date(v).getTime();
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Read-only: proves the operator installed the matching key WITHOUT sending
// the key to the database or reading its secret back. The database MACs a
// fresh per-run probe (a domain-separated string that can never be a
// fulfillment canonical message) and only the MAC is compared locally.
export async function controllerKeyStatus(env, query) {
  const keyId = env.COMMERCE_CONTROLLER_KEY_ID.trim();
  const probe = `DUCELIO_ACCEPTANCE_COMMERCE_KEY_PROBE_V1:${randomBytes(16).toString("hex")}`;
  const rows = await query(Q.controllerKeyProbe, [keyId, probe]);
  if (rows.length !== 1) return "ABSENT";
  const expected = createHmac(
    "sha256",
    Buffer.from(env.COMMERCE_CONTROLLER_HMAC_KEY_HEX.trim(), "hex"),
  )
    .update(probe, "utf8")
    .digest("hex");
  const supplied = String(rows[0].probe_mac ?? "");
  return supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ? "MATCH"
    : "MISMATCH";
}

// ---------------------------------------------------------------------------
// Fixtures: two unique run-tagged activations through the gated
// seedAcceptanceCourse, enrolling the FOREIGN synthetic learner (the buyer
// must not already be enrolled), then a governed offer on each.
// ---------------------------------------------------------------------------
function campaignWindow() {
  return {
    p_starts_at: new Date(Date.now() - 60_000).toISOString(),
    p_ends_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  };
}

async function assertWriteGates(adminClient) {
  await assertAcceptanceSupabaseWriteAuthorized(adminClient);
  await withAcceptanceWriteConnection(async () => {});
}

async function authUserId(client) {
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function seedCommerceCourse(adminClient, runId, label, enrolleeAuthId) {
  const course = await seedAcceptanceCourse(
    adminClient,
    `${runId}-${label}`,
    enrolleeAuthId,
  );
  const slug = `acceptance-${label}-${runId}`;
  await assertWriteGates(adminClient);
  const { data, error } = await adminClient.rpc("publish_commercial_v1_offer", {
    p_activation_id: course.activationId,
    p_slug: slug,
    p_price_amount_minor: TEST_PRICE.amountMinor,
    p_currency: TEST_PRICE.currency,
    p_summary:
      "Synthetic Stripe TEST-MODE acceptance offer. Not a real course, qualification or price.",
    p_delivery_plan: "STANDARD_6_WEEK",
    p_reason: `Stripe test-mode acceptance offer ${runId}`,
  });
  if (error || !UUID.test(String(data ?? "")))
    throw new Error("publish_commercial_v1_offer was refused.");
  return {
    slug,
    offerId: data,
    activationId: course.activationId,
    cohortId: course.cohortId,
    programmeVersionId: course.programmeVersionId,
    priceMinor: TEST_PRICE.amountMinor,
    currency: TEST_PRICE.currency,
  };
}

async function prepareStripeFixtures({ runId }) {
  const adminClient = await acceptanceIdentities.admin();
  await assertWriteGates(adminClient);
  const buyerAuthId = await authUserId(await acceptanceIdentities.learner());
  const foreignAuthId = await authUserId(
    await acceptanceIdentities.foreignLearner(),
  );
  if (!buyerAuthId || !foreignAuthId || buyerAuthId === foreignAuthId)
    throw new Error(
      "The acceptance learner (buyer) and foreign learner (seeded-course enrollee) must be two distinct, real hosted Auth users.",
    );
  const buyerId = await withConnection((c) => resolveAppUserId(c, buyerAuthId));
  if (!buyerId)
    throw new Error(
      "No public.app_users row is linked to the acceptance learner's Auth user id.",
    );
  const paid = await seedCommerceCourse(
    adminClient,
    runId,
    "stripe-paid",
    foreignAuthId,
  );
  const reviewer = await seedCommerceCourse(
    adminClient,
    runId,
    "stripe-reviewer",
    foreignAuthId,
  );
  return { adminClient, buyerId, paid, reviewer };
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:ZERO_PRICE_PROMO_GUARD -- on the paid offer, before checkout.
// ---------------------------------------------------------------------------
export async function scenarioZeroPricePromoGuard(ctx, course) {
  const problems = [];
  const evidence = [
    `offer ${course.slug}`,
    `activation ${course.activationId}`,
  ];
  if (!isEmpty(await snapshot(ctx, course)))
    return fail(
      SURFACES.ZERO_PRICE_PROMO_GUARD,
      "The buyer is not a fresh purchaser of the new acceptance offer.",
      evidence,
    );
  const attempts = [
    {
      label: "FIXED_PRICE 0",
      code: `ZPF-${ctx.runTag}`,
      args: {
        p_kind: "FIXED_PRICE",
        p_percent_off: null,
        p_fixed_price_amount_minor: 0,
      },
    },
    {
      label: "PERCENT_OFF 100",
      code: `ZPP-${ctx.runTag}`,
      args: {
        p_kind: "PERCENT_OFF",
        p_percent_off: 100,
        p_fixed_price_amount_minor: null,
      },
    },
  ];
  for (const attempt of attempts) {
    await ctx.assertWriteGates();
    const { error } = await ctx.adminClient.rpc(
      "create_commercial_v1_campaign",
      {
        p_offer_slug: course.slug,
        p_code: attempt.code,
        ...attempt.args,
        p_max_redemptions: 1,
        ...campaignWindow(),
        p_reason: `Stripe test-mode acceptance zero-price guard ${ctx.runId}`,
      },
    );
    if (!error)
      problems.push(
        `${attempt.label}: the governed campaign authority ACCEPTED a non-reviewer zero-price campaign.`,
      );
    else if (
      !String(error.message ?? "").includes("ZERO_PRICE_RESERVED_FOR_REVIEWERS")
    )
      problems.push(
        `${attempt.label}: refused, but not by the ZERO_PRICE_RESERVED_FOR_REVIEWERS launch policy.`,
      );
    else
      evidence.push(
        `${attempt.label}: refused (ZERO_PRICE_RESERVED_FOR_REVIEWERS)`,
      );
    if ((await ctx.query(Q.campaignByCode, [attempt.code])).length !== 0)
      problems.push(`${attempt.label}: a campaign row exists for the code.`);
    // The buyer then presents that code through the real production
    // checkout entrypoint.
    const outcome = checkoutResult(
      await ctx.app.call(ctx.jars.buyer, {
        operation: "CREATE_CHECKOUT",
        offerSlug: course.slug,
        campaignCode: attempt.code,
      }),
    );
    if (outcome?.kind !== "DENIED" || outcome.code !== "CODE_UNAVAILABLE")
      problems.push(
        `${attempt.label}: the buyer's checkout with the refused code was not denied as CODE_UNAVAILABLE (${outcome?.kind ?? "no valid response"}).`,
      );
  }
  const after = await snapshot(ctx, course);
  if (!isEmpty(after))
    problems.push(
      "The buyer holds an order, entitlement, enrolment, campaign redemption or payment event for the offer after the refused zero-price attempts.",
    );
  evidence.push(
    `buyer orders=${after.orders.length} entitlements=${after.entitlements.length} enrolments=${after.enrolments.length} redemptions=${after.redemptions.length} paymentEvents=${after.paymentEvents}`,
  );
  return problems.length
    ? fail(
        SURFACES.ZERO_PRICE_PROMO_GUARD,
        "A non-reviewer zero-price promotion was not fully refused.",
        [...evidence, ...problems],
      )
    : pass(
        SURFACES.ZERO_PRICE_PROMO_GUARD,
        "The governed admin campaign authority refused both non-reviewer zero-price shapes under the launch policy; no campaign row exists, the buyer's checkout with either code was denied, and no order, redemption, entitlement, enrolment or payment event resulted.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:REVIEWER_COMPLIMENTARY -- its own activation/offer.
// ---------------------------------------------------------------------------
export async function scenarioReviewerComplimentary(ctx, course) {
  const surface = SURFACES.REVIEWER_COMPLIMENTARY;
  const evidence = [
    `offer ${course.slug}`,
    `activation ${course.activationId}`,
  ];
  if (!isEmpty(await snapshot(ctx, course)))
    return fail(
      surface,
      "The buyer is not a fresh purchaser of the reviewer acceptance offer.",
      evidence,
    );
  const code = `REV-${ctx.runTag}`;
  await ctx.assertWriteGates();
  const { data: campaignId, error } = await ctx.adminClient.rpc(
    "create_commercial_v1_campaign",
    {
      p_offer_slug: course.slug,
      p_code: code,
      p_kind: "REVIEWER_COMPLIMENTARY",
      p_percent_off: null,
      p_fixed_price_amount_minor: 0,
      p_max_redemptions: 1,
      ...campaignWindow(),
      p_reason: `Stripe test-mode acceptance reviewer campaign ${ctx.runId}`,
    },
  );
  if (error || !UUID.test(String(campaignId ?? "")))
    return fail(
      surface,
      "The governed campaign authority refused the reviewer-complimentary campaign.",
      evidence,
    );
  evidence.push(`campaign ${campaignId}`);

  const problems = [];
  const request = {
    operation: "CREATE_CHECKOUT",
    offerSlug: course.slug,
    campaignCode: code,
  };
  const first = checkoutResult(await ctx.app.call(ctx.jars.buyer, request));
  if (first?.kind !== "ACCESS_GRANTED" || first.offerSlug !== course.slug)
    problems.push(
      `The production checkout entrypoint did not grant reviewer access (${first?.kind ?? "no valid response"}${first?.code ? ` ${first.code}` : ""}).`,
    );

  const verify = (s, label) => {
    const entitlement = s.entitlements.length === 1 ? s.entitlements[0] : null;
    const redemption = s.redemptions.length === 1 ? s.redemptions[0] : null;
    const enrolment = s.enrolments.length === 1 ? s.enrolments[0] : null;
    if (
      !entitlement ||
      entitlement.id !== first?.entitlementId ||
      entitlement.learner_id !== ctx.buyerId ||
      entitlement.offer_id !== course.offerId ||
      entitlement.source !== "REVIEWER" ||
      entitlement.order_id !== null ||
      entitlement.state !== "ACTIVE" ||
      entitlement.enrolment_id !== enrolment?.id ||
      entitlement.campaign_redemption_id !== redemption?.id
    )
      problems.push(
        `${label}: expected exactly one coherent REVIEWER entitlement with no order; found ${s.entitlements.length}.`,
      );
    if (
      !redemption ||
      redemption.campaign_id !== campaignId ||
      redemption.entitlement_source !== "REVIEWER" ||
      redemption.effective_price_amount_minor !== 0
    )
      problems.push(
        `${label}: expected exactly one zero-price REVIEWER redemption of this campaign; found ${s.redemptions.length}.`,
      );
    if (
      !enrolment ||
      enrolment.id !== first?.enrolmentId ||
      enrolment.status !== "ACTIVE" ||
      enrolment.programme_version_id !== course.programmeVersionId
    )
      problems.push(
        `${label}: expected exactly one ACTIVE enrolment in the offer's cohort; found ${s.enrolments.length}.`,
      );
    if (s.orders.length !== 0 || s.paymentEvents !== 0)
      problems.push(
        `${label}: a commercial order (${s.orders.length}) or payment event (${s.paymentEvents}) exists for a complimentary grant.`,
      );
  };
  const after = await snapshot(ctx, course);
  verify(after, "First redemption");

  const replay = checkoutResult(await ctx.app.call(ctx.jars.buyer, request));
  if (
    replay?.kind !== "ACCESS_GRANTED" ||
    replay.entitlementId !== first?.entitlementId ||
    replay.enrolmentId !== first?.enrolmentId
  )
    problems.push(
      "Replaying the reviewer code did not return the same entitlement and enrolment.",
    );
  verify(await snapshot(ctx, course), "Replay");

  evidence.push(
    `entitlement ${first?.entitlementId ?? "none"} source=REVIEWER`,
    `enrolment ${first?.enrolmentId ?? "none"}`,
    `effectivePriceMinor=0 orders=${after.orders.length} paymentEvents=${after.paymentEvents}`,
  );
  return problems.length
    ? fail(
        surface,
        "Reviewer-complimentary access did not meet every acceptance invariant.",
        [...evidence, ...problems],
      )
    : pass(
        surface,
        "A real REVIEWER_COMPLIMENTARY campaign redeemed through the production checkout entrypoint granted exactly one REVIEWER entitlement and one ACTIVE enrolment at effective price 0; the hosted database holds no commercial order or payment event for the course (the production ACCESS_GRANTED path does not enter paid checkout), and replaying the code reused the same access.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:CHECKOUT_BINDING
// ---------------------------------------------------------------------------
export async function scenarioCheckoutBinding(ctx, course) {
  const surface = SURFACES.CHECKOUT_BINDING;
  const request = { operation: "CREATE_CHECKOUT", offerSlug: course.slug };
  const first = checkoutResult(await ctx.app.call(ctx.jars.buyer, request));
  if (first?.kind !== "CHECKOUT")
    return {
      result: fail(
        surface,
        "The production checkout entrypoint did not return a Stripe Checkout for the buyer.",
        [
          `outcome ${first?.kind ?? "no valid response"}${first?.code ? ` ${first.code}` : ""}`,
        ],
      ),
      order: null,
    };
  const rows = await ctx.query(Q.orders, [ctx.buyerId, course.activationId]);
  const row = rows.length === 1 ? rows[0] : null;
  if (
    !row ||
    row.id !== first.orderId ||
    row.learner_id !== ctx.buyerId ||
    row.offer_id !== course.offerId ||
    row.cohort_id !== course.cohortId ||
    row.state !== "PENDING" ||
    row.provider !== "STRIPE" ||
    row.amount_minor !== course.priceMinor ||
    row.currency !== course.currency ||
    row.campaign_redemption_id !== null ||
    !TEST_SESSION_ID.test(row.provider_session_id ?? "")
  )
    return {
      result: fail(
        surface,
        "The database does not hold exactly one coherent PENDING order, snapshotting the offer's own amount/currency, bound to one Stripe test-mode session.",
        [`orders for buyer+activation ${rows.length}`],
      ),
      order: null,
    };
  const sessionId = row.provider_session_id;
  const expected = {
    sessionId,
    orderId: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
  };
  const problems = [];
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);
  problems.push(
    ...checkoutSessionProblems(session, {
      ...expected,
      paymentStatus: "unpaid",
      state: "open",
    }),
  );
  if (!checkoutUrlNamesSession(first.url, sessionId))
    problems.push(
      "The Checkout URL returned to the buyer does not name the database-bound session.",
    );

  // Idempotent retry: the SAME order, the SAME bound session.
  const second = checkoutResult(await ctx.app.call(ctx.jars.buyer, request));
  if (
    second?.kind !== "CHECKOUT" ||
    second.orderId !== row.id ||
    !checkoutUrlNamesSession(second.url, sessionId)
  )
    problems.push(
      "Retrying checkout did not return the same order and the same bound session.",
    );
  const retried = await ctx.query(Q.orders, [ctx.buyerId, course.activationId]);
  if (
    retried.length !== 1 ||
    retried[0].id !== row.id ||
    retried[0].state !== "PENDING" ||
    retried[0].provider_session_id !== sessionId
  )
    problems.push(
      `Retrying checkout left ${retried.length} orders or rebound the Stripe session.`,
    );
  // Stripe side: every Checkout Session created since the bound one, walked
  // with bounded pagination. Only an exhausted listing (has_more=false) may
  // establish that the bound session is the order's ONLY session.
  const scan = await scanBoundedList(
    (params) => ctx.stripe.checkout.sessions.list(params),
    { created: { gte: session?.created ?? 0 } },
    (s) => s?.client_reference_id === row.id || s?.metadata?.orderId === row.id,
    ctx.listPageCap,
  );
  const forOrder = scan.matches;
  if (forOrder.length > 1)
    problems.push(
      `Stripe holds ${forOrder.length} Checkout Sessions for this order${scan.exhausted ? "" : " (at least; the listing was not exhausted)"}; expected exactly the one bound session.`,
    );
  else if (
    scan.exhausted &&
    (forOrder.length !== 1 || forOrder[0].id !== sessionId)
  )
    problems.push(
      "The exhausted Stripe session listing does not contain exactly the bound session for this order.",
    );

  const evidence = [
    `order ${row.id}`,
    `activation ${course.activationId}`,
    `session ${sessionId}`,
    `amount ${row.amount_minor} ${row.currency} (database-owned)`,
    `stripe livemode=${session?.livemode} mode=${session?.mode} payment_status=${session?.payment_status} status=${session?.status}`,
    `stripe sessions referencing this order=${forOrder.length} (bounded listing ${scan.exhausted ? "exhausted" : "NOT exhausted"} after ${scan.pages} page(s), cap ${ctx.listPageCap})`,
  ].map(String);
  if (problems.length)
    return {
      result: fail(
        surface,
        "Checkout creation/binding did not meet every acceptance invariant.",
        [...evidence, ...problems],
      ),
      order: null,
    };
  if (!scan.exhausted)
    return {
      result: blocked(surface, "CHECKOUT_SESSION_SCAN_NOT_EXHAUSTED", [
        ...evidence,
        `The bounded Stripe Checkout Session listing still reported has_more after ${scan.pages} page(s) of ${LIST_PAGE_SIZE}; a second session for the order cannot be ruled out, so no PASS is claimed. Re-run when the sandbox is quieter.`,
      ]),
      order: null,
    };
  return {
    result: pass(
      surface,
      "The production checkout entrypoint created one database-owned PENDING order and one Stripe TEST-mode card-only payment session whose amount, currency and order reference match the database exactly, bound once; a retry reused the same order and session, and an exhausted bounded listing of Stripe Checkout Sessions shows exactly one session for the order.",
      evidence,
    ),
    order: { ...expected, sessionCreated: session.created },
  };
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:REDIRECT_NOT_PAYMENT_PROOF
// ---------------------------------------------------------------------------
function pendingUntouched(s, order) {
  return (
    s.orders.length === 1 &&
    s.orders[0].id === order.orderId &&
    s.orders[0].state === "PENDING" &&
    s.orders[0].fulfilled_at === null &&
    s.orders[0].provider_session_id === order.sessionId &&
    s.entitlements.length === 0 &&
    s.enrolments.length === 0 &&
    s.redemptions.length === 0 &&
    s.paymentEvents === 0
  );
}

export async function scenarioRedirectNotPaymentProof(ctx, course, order) {
  const surface = SURFACES.REDIRECT_NOT_PAYMENT_PROOF;
  const problems = [];
  const r = reconcileResult(
    await ctx.app.call(ctx.jars.buyer, {
      operation: "RECONCILE_ORDER",
      orderId: order.orderId,
      sessionId: order.sessionId,
    }),
  );
  if (
    r?.ok !== true ||
    r.fulfilled !== false ||
    r.code !== "NOT_PAID" ||
    r.orderId !== order.orderId
  )
    problems.push(
      `Success-page reconciliation of the unpaid session did not report NOT_PAID (${r?.code ?? (r ? `fulfilled=${r.fulfilled}` : "no valid response")}).`,
    );
  const s = await snapshot(ctx, course);
  if (!pendingUntouched(s, order))
    problems.push(
      "The order is no longer PENDING, or an entitlement, enrolment or payment event exists without payment.",
    );
  const evidence = [
    `order ${order.orderId}`,
    `session ${order.sessionId}`,
    `reconcile=${r?.code ?? "none"} orderState=${s.orders[0]?.state ?? "none"} entitlements=${s.entitlements.length} enrolments=${s.enrolments.length} paymentEvents=${s.paymentEvents}`,
  ];
  return problems.length
    ? fail(
        surface,
        "A Checkout Session / success redirect produced state without payment.",
        [...evidence, ...problems],
      )
    : pass(
        surface,
        "The production success-page reconciliation retrieved the real unpaid Stripe session and returned NOT_PAID; the order stayed PENDING with no entitlement, enrolment or payment event -- a session id / redirect is not payment proof.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// The ONE manual Stripe-hosted sandbox payment, then the genuine event.
// ---------------------------------------------------------------------------
export function sandboxPaymentInstructions(url) {
  return [
    "------------------------------------------------------------------------",
    "STRIPE TEST MODE -- sandbox Checkout only. No real money moves.",
    "Open this Stripe-hosted TEST-mode Checkout page yourself (preferably in a",
    "private browser window that is NOT signed in to any local Ducelio app):",
    `  ${url}`,
    "Pay ONLY with a Stripe documented sandbox test card, e.g. 4242 4242 4242 4242,",
    "any future expiry date and any CVC. NEVER enter a real card.",
    "If Checkout asks for a name, email, address or postcode, enter synthetic,",
    "non-personal test values only (e.g. 'Acceptance Test', test@example.com).",
    "NEVER enter real card or personal customer details for this acceptance run.",
    "Ducelio and this script never see or collect card details.",
    "Stripe may then redirect your browser to a local page; you can close it.",
    "Complete the sandbox Checkout, then press Enter to continue.",
    "------------------------------------------------------------------------",
  ];
}

// Operator-attended only: without an interactive terminal (or on timeout)
// the payment is never assumed.
export function promptOperator({
  input = process.stdin,
  output = process.stdout,
  timeoutMs = OPERATOR_TIMEOUT_MS,
} = {}) {
  if (!input.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: false });
    const timer = setTimeout(() => rl.close(), timeoutMs);
    rl.once("line", () => {
      clearTimeout(timer);
      resolve(true);
      rl.close();
    });
    rl.once("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Returns { status: "READY", event } or a terminal outcome for the three
// payment-dependent surfaces: BLOCKED (evidence unobtainable) or FAIL.
export async function collectSandboxPayment(ctx, course, order) {
  const open = await ctx.stripe.checkout.sessions.retrieve(order.sessionId);
  const openProblems = checkoutSessionProblems(open, {
    ...order,
    paymentStatus: "unpaid",
    state: "open",
  });
  if (openProblems.length)
    return {
      status: "FAIL",
      reason:
        "The bound session is no longer an open unpaid test-mode session.",
      details: openProblems,
    };
  for (const line of sandboxPaymentInstructions(open.url)) ctx.print(line);
  if (!(await ctx.waitForOperator()))
    return {
      status: "BLOCKED",
      reason: "SANDBOX_PAYMENT_NOT_CONFIRMED",
      details: [
        "The operator did not confirm the sandbox payment (no interactive terminal, end of input or timeout). A payment is never assumed.",
      ],
    };

  let paid = null;
  for (let i = 0; i < ctx.paymentPollAttempts; i += 1) {
    const s = await ctx.stripe.checkout.sessions.retrieve(order.sessionId);
    if (s?.payment_status === "paid") {
      paid = s;
      break;
    }
    if (i < ctx.paymentPollAttempts - 1) await ctx.sleep(ctx.paymentPollMs);
  }
  if (!paid)
    return {
      status: "BLOCKED",
      reason: "SANDBOX_PAYMENT_NOT_OBSERVED",
      details: [
        `Stripe did not report the session as paid within ${ctx.paymentPollAttempts} bounded retrievals.`,
      ],
    };
  const paidProblems = checkoutSessionProblems(paid, {
    ...order,
    paymentStatus: "paid",
    state: "complete",
  });
  if (paidProblems.length)
    return {
      status: "FAIL",
      reason: "The paid Stripe session does not match the database order.",
      details: paidProblems,
    };

  // Nothing but this run's own deliveries may fulfil the order: a Stripe
  // webhook endpoint that reaches this acceptance database, or a browser
  // signed in as the buyer on the success redirect, would make the
  // application-boundary evidence below unattributable.
  if (!pendingUntouched(await snapshot(ctx, course), order))
    return {
      status: "BLOCKED",
      reason: "ORDER_FULFILLED_OUTSIDE_THIS_RUN",
      details: [
        "The order was fulfilled (or gained payment/entitlement state) before this run delivered any webhook. Ensure no Stripe webhook endpoint delivers to an app bound to this acceptance database, and complete the sandbox payment in a browser that is not signed in to the local app as the buyer.",
      ],
    };

  // Each lookup walks the whole bounded event window (created since the
  // session) until has_more=false; only then may "exactly one completion
  // event for this session" be concluded.
  let match = null;
  let scanPages = 0;
  for (let i = 0; i < ctx.eventPollAttempts && !match; i += 1) {
    const scan = await scanBoundedList(
      (params) => ctx.stripe.events.list(params),
      {
        type: "checkout.session.completed",
        created: { gte: order.sessionCreated },
      },
      (e) => e?.data?.object?.id === order.sessionId,
      ctx.listPageCap,
    );
    scanPages = scan.pages;
    if (scan.matches.length > 1)
      return {
        status: "FAIL",
        reason:
          "Stripe reports more than one completion event for the session.",
        details: [`matching events at least ${scan.matches.length}`],
      };
    if (!scan.exhausted)
      return {
        status: "BLOCKED",
        reason: "COMPLETION_EVENT_SCAN_NOT_EXHAUSTED",
        details: [
          `The bounded checkout.session.completed listing still reported has_more after ${scan.pages} page(s) of ${LIST_PAGE_SIZE}; a unique completion event cannot be established, so none is used.`,
        ],
      };
    if (scan.matches.length === 1) match = scan.matches[0];
    else if (i < ctx.eventPollAttempts - 1) await ctx.sleep(ctx.eventPollMs);
  }
  if (!match)
    return {
      status: "BLOCKED",
      reason: "COMPLETION_EVENT_NOT_FOUND",
      details: [
        `No checkout.session.completed event for the session within ${ctx.eventPollAttempts} bounded, exhausted lookups (created since the session).`,
      ],
    };
  const event = await ctx.stripe.events.retrieve(match.id);
  const eventProblems =
    event?.id === match.id
      ? completionEventProblems(event, order)
      : ["Stripe returned a different event on retrieval."];
  if (eventProblems.length)
    return {
      status: "FAIL",
      reason: "The Stripe completion event does not match the session/order.",
      details: eventProblems,
    };
  return { status: "READY", event, eventScanPages: scanPages };
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:SIGNED_WEBHOOK_FULFILLMENT
// ---------------------------------------------------------------------------
function fulfilledProblems(
  s,
  eventRows,
  orderEvents,
  order,
  event,
  course,
  ctx,
) {
  const problems = [];
  const o = s.orders.length === 1 ? s.orders[0] : null;
  if (
    !o ||
    o.id !== order.orderId ||
    o.state !== "FULFILLED" ||
    o.fulfilled_at === null ||
    o.provider_session_id !== order.sessionId ||
    o.amount_minor !== order.amountMinor ||
    o.currency !== order.currency
  )
    problems.push(
      "The order is not exactly one FULFILLED order with its original session/amount/currency.",
    );
  const ev = eventRows.length === 1 ? eventRows[0] : null;
  if (
    !ev ||
    ev.order_id !== order.orderId ||
    ev.session_id !== order.sessionId ||
    ev.amount_minor !== order.amountMinor ||
    ev.currency !== order.currency ||
    ev.status !== "PAID"
  )
    problems.push(
      `Expected exactly one PAID payment event for the Stripe event id with the exact session/amount/currency; found ${eventRows.length}.`,
    );
  if (orderEvents.length !== 1 || orderEvents[0].provider_event_id !== event.id)
    problems.push(
      `Expected the order's only payment event to be the delivered Stripe event; found ${orderEvents.length}.`,
    );
  const enrolment = s.enrolments.length === 1 ? s.enrolments[0] : null;
  if (
    !enrolment ||
    enrolment.status !== "ACTIVE" ||
    enrolment.programme_version_id !== course.programmeVersionId
  )
    problems.push(
      `Expected exactly one ACTIVE buyer enrolment in the paid cohort; found ${s.enrolments.length}.`,
    );
  const e = s.entitlements.length === 1 ? s.entitlements[0] : null;
  if (
    !e ||
    e.learner_id !== ctx.buyerId ||
    e.offer_id !== course.offerId ||
    e.activation_id !== course.activationId ||
    e.order_id !== order.orderId ||
    e.enrolment_id !== enrolment?.id ||
    e.source !== "PAID_ORDER" ||
    e.campaign_redemption_id !== null ||
    e.state !== "ACTIVE"
  )
    problems.push(
      `Expected exactly one ACTIVE PAID_ORDER entitlement linking buyer, offer, activation, order and enrolment; found ${s.entitlements.length}.`,
    );
  if (s.redemptions.length !== 0)
    problems.push("A campaign redemption exists for the paid order.");
  return problems;
}

async function fulfilledState(ctx, course, order, event) {
  const s = await snapshot(ctx, course);
  const eventRows = await ctx.query(Q.paymentEventsForEvent, [event.id]);
  const orderEvents = await ctx.query(Q.paymentEventsForOrder, [order.orderId]);
  return { s, eventRows, orderEvents };
}

export async function scenarioSignedWebhookFulfillment(
  ctx,
  course,
  order,
  event,
  eventScanPages = null,
) {
  const surface = SURFACES.SIGNED_WEBHOOK_FULFILLMENT;
  // The genuine Stripe Event, serialized in memory; never printed.
  const rawBody = JSON.stringify(event);
  const problems = [];
  const unsigned = await ctx.webhook.post(rawBody, null);
  const forged = await ctx.webhook.post(
    rawBody,
    ctx.sign(rawBody, `whsec_${randomBytes(24).toString("hex")}`),
  );
  if (unsigned.status !== 400 || forged.status !== 400)
    problems.push(
      `Unsigned/wrongly-signed deliveries were not refused with 400 (HTTP ${unsigned.status}/${forged.status}).`,
    );
  if (!pendingUntouched(await snapshot(ctx, course), order))
    problems.push(
      "An unsigned or wrongly signed delivery changed order, entitlement, enrolment or payment-event state.",
    );
  const evidence = [
    `order ${order.orderId}`,
    `session ${order.sessionId}`,
    `stripe event ${event.id} (livemode=false, checkout.session.completed)`,
    ...(eventScanPages === null
      ? []
      : [
          `completion events for this session=1 (bounded listing exhausted after ${eventScanPages} page(s))`,
        ]),
    `invalid-signature HTTP ${forged.status}; missing-signature HTTP ${unsigned.status}`,
  ];
  if (problems.length)
    return {
      result: fail(
        surface,
        "Invalid webhook signatures were not refused cleanly.",
        [...evidence, ...problems],
      ),
      fulfilled: null,
    };

  const valid = await ctx.webhook.post(
    rawBody,
    ctx.sign(rawBody, ctx.webhookSecret),
  );
  if (valid.status !== 200 || !sameJson(valid.body, { received: true }))
    problems.push(
      `The production webhook route did not accept and reconcile the validly signed event (HTTP ${valid.status}).`,
    );
  const { s, eventRows, orderEvents } = await fulfilledState(
    ctx,
    course,
    order,
    event,
  );
  problems.push(
    ...fulfilledProblems(s, eventRows, orderEvents, order, event, course, ctx),
  );
  evidence.push(
    `valid-signature HTTP ${valid.status}`,
    `orderState=${s.orders[0]?.state ?? "none"} paymentEvents(event)=${eventRows.length} entitlements=${s.entitlements.length} enrolments=${s.enrolments.length}`,
    `entitlement ${s.entitlements[0]?.id ?? "none"} enrolment ${s.enrolments[0]?.id ?? "none"}`,
  );
  if (problems.length)
    return {
      result: fail(
        surface,
        "Signed-webhook fulfillment did not meet every acceptance invariant.",
        [...evidence, ...problems],
      ),
      fulfilled: null,
    };
  return {
    result: pass(
      surface,
      "Unsigned and wrongly signed deliveries of the genuine Stripe test-mode event were refused with no state change; the validly signed delivery to the production webhook route was verified by StripeCommerceProvider and fulfilled by the hosted database authority: one FULFILLED order, one PAID payment event with Stripe's exact session/amount/currency, and exactly one PAID_ORDER entitlement and one ACTIVE enrolment with coherent lineage. No financial fact came from the driver or a client.",
      evidence,
    ),
    fulfilled: {
      rawBody,
      entitlementId: s.entitlements[0].id,
      enrolmentId: s.enrolments[0].id,
      fulfilledAt: time(s.orders[0].fulfilled_at),
    },
  };
}

function unchangedSinceFulfillment(state, fulfilled, event) {
  const { s, eventRows, orderEvents } = state;
  return (
    s.orders.length === 1 &&
    s.orders[0].state === "FULFILLED" &&
    time(s.orders[0].fulfilled_at) === fulfilled.fulfilledAt &&
    eventRows.length === 1 &&
    orderEvents.length === 1 &&
    orderEvents[0].provider_event_id === event.id &&
    s.entitlements.length === 1 &&
    s.entitlements[0].id === fulfilled.entitlementId &&
    s.enrolments.length === 1 &&
    s.enrolments[0].id === fulfilled.enrolmentId
  );
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:DUPLICATE_WEBHOOK_IDEMPOTENCY -- the EXACT same event body.
// ---------------------------------------------------------------------------
export async function scenarioDuplicateWebhook(
  ctx,
  course,
  order,
  event,
  fulfilled,
) {
  const surface = SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY;
  const again = await ctx.webhook.post(
    fulfilled.rawBody,
    ctx.sign(fulfilled.rawBody, ctx.webhookSecret),
  );
  const problems = [];
  if (again.status !== 200 || !sameJson(again.body, { received: true }))
    problems.push(
      `The duplicate delivery was not safely accepted (HTTP ${again.status}).`,
    );
  const state = await fulfilledState(ctx, course, order, event);
  if (!unchangedSinceFulfillment(state, fulfilled, event))
    problems.push(
      "The duplicate delivery created another payment event, entitlement or enrolment, or changed the fulfilled order.",
    );
  const evidence = [
    `stripe event ${event.id}`,
    `duplicate HTTP ${again.status}`,
    `paymentEvents(event)=${state.eventRows.length} paymentEvents(order)=${state.orderEvents.length} entitlements=${state.s.entitlements.length} enrolments=${state.s.enrolments.length}`,
  ];
  return problems.length
    ? fail(surface, "Duplicate webhook delivery was not idempotent.", [
        ...evidence,
        ...problems,
      ])
    : pass(
        surface,
        "Re-delivering the exact same genuine Stripe event with a valid signature was accepted and changed nothing: still one payment event for the event id, one entitlement, one enrolment and the same fulfilled order.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// STRIPE_TEST:RECONCILIATION_REPLAY -- success page after the webhook.
// ---------------------------------------------------------------------------
export async function scenarioReconciliationReplay(
  ctx,
  course,
  order,
  event,
  fulfilled,
) {
  const surface = SURFACES.RECONCILIATION_REPLAY;
  const r = reconcileResult(
    await ctx.app.call(ctx.jars.buyer, {
      operation: "RECONCILE_ORDER",
      orderId: order.orderId,
      sessionId: order.sessionId,
    }),
  );
  const problems = [];
  if (
    r?.ok !== true ||
    r.fulfilled !== true ||
    r.replay !== true ||
    r.orderId !== order.orderId
  )
    problems.push(
      `Success-page reconciliation did not converge as a replay of the fulfilled order (${r ? `fulfilled=${r.fulfilled} replay=${r.replay} code=${r.code}` : "no valid response"}).`,
    );
  const state = await fulfilledState(ctx, course, order, event);
  if (!unchangedSinceFulfillment(state, fulfilled, event))
    problems.push(
      "Reconciliation created another payment event, entitlement or enrolment, or changed the fulfilled order.",
    );
  const evidence = [
    `order ${order.orderId}`,
    `fulfilled=${r?.fulfilled} replay=${r?.replay}`,
    `paymentEvents(order)=${state.orderEvents.length} entitlements=${state.s.entitlements.length} enrolments=${state.s.enrolments.length}`,
  ];
  return problems.length
    ? fail(
        surface,
        "Success-page reconciliation did not converge on the webhook's fulfillment.",
        [...evidence, ...problems],
      )
    : pass(
        surface,
        "After webhook fulfillment, the production success-page reconciliation reported fulfilled=true replay=true for the same order and created no additional payment event, entitlement or enrolment: webhook and success page converge on one database authority.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// Orchestration. Every dependency is injectable so tests observe the
// driver without Next.js, a database, Supabase or Stripe.
// ---------------------------------------------------------------------------
const REPORT_ORDER = [
  SURFACES.CHECKOUT_BINDING,
  SURFACES.REDIRECT_NOT_PAYMENT_PROOF,
  SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
  SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
  SURFACES.RECONCILIATION_REPLAY,
  SURFACES.REVIEWER_COMPLIMENTARY,
  SURFACES.ZERO_PRICE_PROMO_GUARD,
];

function defaultQuery(sql, params) {
  return withConnection((c) => c.query(sql, params)).then((r) => r.rows);
}

function createTestModeStripeClient(secretKey) {
  if (!STRIPE_TEST_SECRET_KEY.test(secretKey))
    throw new Error("A Stripe TEST-mode secret key is required.");
  return new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 20_000 });
}

export async function runStripeAcceptance({
  env = process.env,
  argv = process.argv.slice(2),
  startApp = startAppServer,
  stopApp = stopAppServer,
  fetchImpl = fetch,
  envFileNames,
  envFileDir,
  createStripeClient = createTestModeStripeClient,
  query = defaultQuery,
  prepareFixtures = prepareStripeFixtures,
  writeGates = assertWriteGates,
  waitForOperator = promptOperator,
  print = (line) => console.log(line),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readinessTimeoutMs = 240_000,
  readinessPollMs = 1000,
  paymentPollAttempts = 5,
  paymentPollMs = 3000,
  eventPollAttempts = 6,
  eventPollMs = 5000,
  listPageCap = DEFAULT_LIST_PAGE_CAP,
} = {}) {
  const plan = planStripeRun(env, argv, {
    nextBinExists: startApp !== startAppServer || existsSync(NEXT_BIN),
  });
  if (!plan.runnable) return { results: plan.results };

  // Enumerated BEFORE anything else: an env file whose names cannot be
  // inspected blocks the run with nothing started.
  let childEnvFileNames;
  try {
    childEnvFileNames = envFileNames ?? readEnvFileNames(envFileDir);
  } catch (error) {
    return {
      results: blockAll("ENV_FILE_NOT_INSPECTABLE", [
        error instanceof EnvFileInspectionError
          ? error.message
          : "An env file exists but its variable names could not be inspected.",
        ZERO_CALLS,
      ]),
    };
  }

  // Operator prerequisite, read-only; this driver never provisions keys.
  let keyStatus;
  try {
    keyStatus = await controllerKeyStatus(env, query);
  } catch {
    keyStatus = "ERROR";
  }
  if (keyStatus !== "MATCH")
    return {
      results: blockAll(
        keyStatus === "ERROR"
          ? "COMMERCE_CONTROLLER_KEY_UNVERIFIED"
          : `COMMERCE_CONTROLLER_KEY_${keyStatus}`,
        [
          keyStatus === "ABSENT"
            ? "No active hosted commercial_v1_commerce_private.controller_keys row matches COMMERCE_CONTROLLER_KEY_ID."
            : keyStatus === "MISMATCH"
              ? "The active hosted controller key for COMMERCE_CONTROLLER_KEY_ID does not match COMMERCE_CONTROLLER_HMAC_KEY_HEX."
              : "The read-only hosted controller-key check failed.",
          "Operator prerequisite: install the matching key with commercial_v1_commerce_private.install_controller_key (docs/38). This driver never provisions keys.",
          "Zero Stripe requests were made, no server was started and nothing was written.",
        ],
      ),
    };

  // Stripe itself must report TEST mode before anything is written.
  let stripe;
  try {
    stripe = createStripeClient(env.STRIPE_SECRET_KEY.trim());
    const balance = await stripe.balance.retrieve();
    if (balance?.livemode !== false)
      return {
        results: blockAll("STRIPE_ACCOUNT_NOT_TEST_MODE", [
          "Stripe did not report livemode=false for this key. Nothing was started or written.",
        ]),
      };
  } catch (error) {
    return {
      results: blockAll("STRIPE_TEST_MODE_UNVERIFIED", [
        safeErrorSummary(error),
        "Nothing was started or written.",
      ]),
    };
  }

  const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  let child;
  try {
    const port = await freePort();
    const token = randomBytes(32).toString("hex");
    child = startApp(
      buildStripeChildEnv(env, {
        port,
        token,
        authorized: parseCliArgs(argv).authorized,
        envFileNames: childEnvFileNames,
      }),
      port,
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = createStripeAppClient({ baseUrl, token, fetchImpl });
    const readiness = await waitForAppReady(
      app,
      child,
      readinessTimeoutMs,
      readinessPollMs,
    );
    if (readiness !== "READY")
      return {
        results: blockAll(
          `The local Ducelio app server did not become ready (${readiness}).`,
          [
            "GATE_REFUSED: the Stripe acceptance route gate refused this driver. EXITED/TIMEOUT: run `npm run dev` to diagnose; stop any other dev server using this checkout first.",
            "Nothing was written.",
          ],
        ),
      };

    const buyer = createCookieJar();
    const signIn = await app.call(buyer, {
      operation: "SIGN_IN",
      email: env.ACCEPTANCE_LEARNER_EMAIL,
      password: env.ACCEPTANCE_LEARNER_PASSWORD,
    });
    if (signIn.status !== 200 || signIn.body?.ok !== true || buyer.size === 0)
      return {
        results: blockAll(
          "Real app sign-in failed for the acceptance learner (buyer), or the hosted project did not report ACCEPTANCE_ENVIRONMENT_ID.",
          ["Nothing was written."],
        ),
      };

    let fixtures;
    try {
      fixtures = await prepareFixtures({ runId });
    } catch (error) {
      if (error instanceof AcceptanceWriteNotAuthorizedError)
        return { results: blockAll(error.message) };
      return {
        results: Object.values(SURFACES).map((surface) =>
          fail(surface, "Acceptance fixture preparation failed.", [
            safeErrorSummary(error),
          ]),
        ),
      };
    }

    const ctx = {
      runId,
      runTag: runId.toUpperCase(),
      app,
      webhook: createWebhookClient({ baseUrl, fetchImpl }),
      jars: { buyer },
      stripe,
      sign: signWebhookPayload,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET.trim(),
      query,
      adminClient: fixtures.adminClient,
      buyerId: fixtures.buyerId,
      assertWriteGates: () => writeGates(fixtures.adminClient),
      waitForOperator,
      print,
      sleep,
      paymentPollAttempts,
      paymentPollMs,
      eventPollAttempts,
      eventPollMs,
      listPageCap,
    };
    const out = new Map();
    const blockRest = (names, reason, details) => {
      for (const name of names) out.set(name, blocked(name, reason, details));
    };

    // Payment-independent surfaces first.
    out.set(
      SURFACES.ZERO_PRICE_PROMO_GUARD,
      await guardScenario(SURFACES.ZERO_PRICE_PROMO_GUARD, () =>
        scenarioZeroPricePromoGuard(ctx, fixtures.paid),
      ),
    );
    out.set(
      SURFACES.REVIEWER_COMPLIMENTARY,
      await guardScenario(SURFACES.REVIEWER_COMPLIMENTARY, () =>
        scenarioReviewerComplimentary(ctx, fixtures.reviewer),
      ),
    );

    const paymentSurfaces = [
      SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
      SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
      SURFACES.RECONCILIATION_REPLAY,
    ];
    let binding = null;
    out.set(
      SURFACES.CHECKOUT_BINDING,
      await guardScenario(SURFACES.CHECKOUT_BINDING, async () => {
        binding = await scenarioCheckoutBinding(ctx, fixtures.paid);
        return binding.result;
      }),
    );
    const order =
      out.get(SURFACES.CHECKOUT_BINDING).status === "PASS"
        ? binding.order
        : null;
    if (!order) {
      blockRest(
        [SURFACES.REDIRECT_NOT_PAYMENT_PROOF, ...paymentSurfaces],
        "REQUIRES_CHECKOUT_BINDING",
        [
          "Requires a verified, database-bound test-mode Checkout Session from STRIPE_TEST:CHECKOUT_BINDING.",
        ],
      );
    } else {
      out.set(
        SURFACES.REDIRECT_NOT_PAYMENT_PROOF,
        await guardScenario(SURFACES.REDIRECT_NOT_PAYMENT_PROOF, () =>
          scenarioRedirectNotPaymentProof(ctx, fixtures.paid, order),
        ),
      );
      if (out.get(SURFACES.REDIRECT_NOT_PAYMENT_PROOF).status !== "PASS") {
        blockRest(paymentSurfaces, "REQUIRES_REDIRECT_NOT_PAYMENT_PROOF", [
          "The operator is never asked to pay unless the unpaid session is first proven to grant nothing.",
        ]);
      } else {
        let payment;
        try {
          payment = await collectSandboxPayment(ctx, fixtures.paid, order);
        } catch (error) {
          payment = {
            status: "FAIL",
            reason: "Sandbox payment verification stopped unexpectedly.",
            details: [safeErrorSummary(error)],
          };
        }
        if (payment.status !== "READY") {
          const verdict = payment.status === "BLOCKED" ? blocked : fail;
          out.set(
            SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
            verdict(
              SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
              payment.reason,
              payment.details,
            ),
          );
          blockRest(
            paymentSurfaces.slice(1),
            "REQUIRES_SIGNED_WEBHOOK_FULFILLMENT",
            [
              "Requires the fulfilled order from STRIPE_TEST:SIGNED_WEBHOOK_FULFILLMENT.",
            ],
          );
        } else {
          let webhook = null;
          out.set(
            SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
            await guardScenario(
              SURFACES.SIGNED_WEBHOOK_FULFILLMENT,
              async () => {
                webhook = await scenarioSignedWebhookFulfillment(
                  ctx,
                  fixtures.paid,
                  order,
                  payment.event,
                  payment.eventScanPages,
                );
                return webhook.result;
              },
            ),
          );
          if (out.get(SURFACES.SIGNED_WEBHOOK_FULFILLMENT).status !== "PASS") {
            blockRest(
              paymentSurfaces.slice(1),
              "REQUIRES_SIGNED_WEBHOOK_FULFILLMENT",
              [
                "Requires the fulfilled order from STRIPE_TEST:SIGNED_WEBHOOK_FULFILLMENT.",
              ],
            );
          } else {
            out.set(
              SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY,
              await guardScenario(SURFACES.DUPLICATE_WEBHOOK_IDEMPOTENCY, () =>
                scenarioDuplicateWebhook(
                  ctx,
                  fixtures.paid,
                  order,
                  payment.event,
                  webhook.fulfilled,
                ),
              ),
            );
            out.set(
              SURFACES.RECONCILIATION_REPLAY,
              await guardScenario(SURFACES.RECONCILIATION_REPLAY, () =>
                scenarioReconciliationReplay(
                  ctx,
                  fixtures.paid,
                  order,
                  payment.event,
                  webhook.fulfilled,
                ),
              ),
            );
          }
        }
      }
    }
    return { results: REPORT_ORDER.map((name) => out.get(name)) };
  } catch (error) {
    return {
      results: Object.values(SURFACES).map((surface) =>
        fail(surface, "Stripe test-mode acceptance stopped unexpectedly.", [
          safeErrorSummary(error),
        ]),
      ),
    };
  } finally {
    await stopApp(child);
  }
}

async function main() {
  console.log("===== Commercial V1 Stripe TEST-MODE acceptance =====");
  const { results } = await runStripeAcceptance();
  for (const r of results) printResult(r);
  printSummary(results, "Commercial V1 Stripe TEST-MODE acceptance");
  console.log("");
  console.log(TRUTHFULNESS_STATEMENT);
  process.exit(exitCodeFor(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
