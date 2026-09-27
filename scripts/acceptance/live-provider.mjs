#!/usr/bin/env node
// npm run acceptance:live-provider [-- --authorize-live-provider]
//
// Commercial V1 LIVE PROVIDER acceptance (docs/38 section 5): the smallest
// explicitly authorized paid smoke tests against the CURRENT native provider
// adapters, one surface per reviewed provider family:
//
//   LIVE_PROVIDER:OPENAI_EXAMINER  EXAMINER_COMMERCIAL_V1 / OPENAI_RESPONSES
//   LIVE_PROVIDER:ANTHROPIC_LAB    LAB_INSTRUCTOR_COMMERCIAL_V1 / ANTHROPIC_MESSAGES
//
// A key existing -- in .env.local or the shell -- is NEVER permission.
// Billable execution requires BOTH ACCEPTANCE_LIVE_PROVIDER_OPT_IN exactly
// "true" AND the explicit --authorize-live-provider command-line flag;
// without both, every surface reports BLOCKED and this process starts no
// server and makes no network request at all. With both, a surface whose
// own key is absent BLOCKS on its own; the other still runs.
//
// This script never builds a provider request. It starts the real Ducelio
// Next.js server locally (`next dev`, loopback only) and asks the
// fail-closed, acceptance-only route src/app/api/acceptance/live-provider/
// route.ts to run one of two fixed operations, which reach the EXISTING
// production profile registry, native adapter and governed runtime
// (src/server/live-provider-acceptance-driver.ts). Each authorized surface
// is requested exactly once: no script-level retry, no probe call. The only
// provider retry is whatever the production profile permits (maxAttempts 1).
//
// The child server receives only what this route needs: the per-run gate
// settings and the provider key(s) for the authorized surfaces. Every other
// credential -- acceptance database, identities, HMAC/controller keys,
// Stripe, the legacy ACADEMIC_PROVIDER_* pair, Supabase -- is forced to an
// empty string, which Next.js's own .env loader never overrides. Child
// output is never forwarded, and nothing here prints a key, the raw model
// output or provider request/response content.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
} from "./report.mjs";

export const AUTHORIZE_FLAG = "--authorize-live-provider";
export const OPT_IN_VAR = "ACCEPTANCE_LIVE_PROVIDER_OPT_IN";
export const ROUTE_PATH = "/api/acceptance/live-provider";
export const DRIVER_HEADER = "x-ducelio-live-provider-driver";

export const LIVE_PROVIDER_SURFACES = Object.freeze([
  Object.freeze({
    surface: "LIVE_PROVIDER:OPENAI_EXAMINER",
    operation: "OPENAI_EXAMINER_SMOKE",
    keyVar: "OPENAI_API_KEY",
    providerFamily: "OPENAI",
    adapterKind: "OPENAI_RESPONSES",
    profileRef: "EXAMINER_COMMERCIAL_V1",
    modelId: "gpt-5.6-luna",
  }),
  Object.freeze({
    surface: "LIVE_PROVIDER:ANTHROPIC_LAB",
    operation: "ANTHROPIC_LAB_SMOKE",
    keyVar: "ANTHROPIC_API_KEY",
    providerFamily: "ANTHROPIC",
    adapterKind: "ANTHROPIC_MESSAGES",
    profileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
    modelId: "claude-sonnet-5",
  }),
]);

export const TRUTHFULNESS_STATEMENT =
  "A PASS here establishes only LIVE-PROVIDER-TESTED for the named surface: one authorized request through the current production adapter and governed runtime returned a result that passed the existing strict parsing/validation within the production profile's budget envelope. It is not production-readiness proof, not evidence of grading or instructional quality, and no raw provider or model content is acceptance evidence.";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NEXT_BIN = fileURLToPath(
  new URL("../../node_modules/next/dist/bin/next", import.meta.url),
);

// ---------------------------------------------------------------------------
// Authorization. Pure: reads names and the exact opt-in value only.
// ---------------------------------------------------------------------------
export function parseCliArgs(argv) {
  const authorized = argv.includes(AUTHORIZE_FLAG);
  const unrecognized = argv.filter((arg) => arg !== AUTHORIZE_FLAG).length;
  return { authorized, unrecognized };
}

function keyConfigured(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

// Returns, per surface, either a final BLOCKED result or `runnable: true`.
// Never returns a key value.
export function planLiveProviderRun(env, argv) {
  const { authorized, unrecognized } = parseCliArgs(argv);
  const optedIn = env[OPT_IN_VAR] === "true";
  const zeroCalls = "Zero provider requests were made.";
  if (unrecognized > 0)
    return LIVE_PROVIDER_SURFACES.map((s) => ({
      ...s,
      runnable: false,
      result: blocked(s.surface, "UNRECOGNIZED_ARGUMENT", [
        `Only ${AUTHORIZE_FLAG} is accepted (arguments are never echoed).`,
        zeroCalls,
      ]),
    }));
  if (!optedIn || !authorized) {
    const missing = [];
    if (!optedIn) missing.push(`${OPT_IN_VAR} is not exactly 'true'.`);
    if (!authorized)
      missing.push(`The ${AUTHORIZE_FLAG} command-line flag was not given.`);
    return LIVE_PROVIDER_SURFACES.map((s) => ({
      ...s,
      runnable: false,
      result: blocked(s.surface, "EXPLICIT_AUTHORIZATION_REQUIRED", [
        ...missing,
        "Billable execution requires BOTH; a configured provider key is never itself permission.",
        zeroCalls,
      ]),
    }));
  }
  return LIVE_PROVIDER_SURFACES.map((s) =>
    keyConfigured(env, s.keyVar)
      ? { ...s, runnable: true, result: null }
      : {
          ...s,
          runnable: false,
          result: blocked(s.surface, `${s.keyVar} is not configured.`, [
            zeroCalls,
          ]),
        },
  );
}

// ---------------------------------------------------------------------------
// The local application server's environment.
// ---------------------------------------------------------------------------
export const WITHHELD_FROM_LIVE_PROVIDER_APP = Object.freeze([
  "ACCEPTANCE_DATABASE_URL",
  "ACCEPTANCE_DATABASE_INSECURE_TLS",
  "ACCEPTANCE_WRITE_ENABLED",
  "ACCEPTANCE_ENVIRONMENT_ID",
  "ACCEPTANCE_EXPIRED_LEARNER_JWT",
  "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
  "ACCEPTANCE_APP_DRIVER_ENABLED",
  "ACCEPTANCE_APP_DRIVER_TOKEN",
  "ACCEPTANCE_PROVIDER_STUB_URL",
  "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
  "ACADEMIC_EXECUTION_KEY_ID",
  "ACADEMIC_EXECUTION_HMAC_KEY_HEX",
  "ACADEMIC_PROVIDER_BASE_URL",
  "ACADEMIC_PROVIDER_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "COMMERCE_CONTROLLER_KEY_ID",
  "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NODE_OPTIONS",
]);
// Any other inherited name that looks like a credential is blanked too.
const SENSITIVE_NAME =
  /^(ACCEPTANCE_|ACADEMIC_|STRIPE_|COMMERCE_|OPENAI_|ANTHROPIC_|PG)|SUPABASE|DATABASE_URL|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
// Every file Next.js may load for any mode; each name they define is
// forced empty so the child can never pick up a value from them.
const NEXT_ENV_FILES = Object.freeze([
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
]);

// Thrown when an env file exists but its names cannot be safely enumerated.
// Carries only the fixed file name -- never contents, values or the OS
// error text.
export class EnvFileInspectionError extends Error {
  constructor(file) {
    super(`${file} exists but its variable names could not be inspected.`);
    this.file = file;
  }
}

// Also matches dotenv's `NAME: value` and `export NAME=` line forms (which
// Next.js's loader accepts but node:util's parseEnv may not); over-matching
// only blanks an extra name, which is harmless.
const ENV_LINE_NAME = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=|:[ \t])/gm;

// Names only -- a value read here is discarded immediately. Fails closed:
// the child's secret minimisation depends on enumerating every name Next.js
// could load, so an existing file that cannot be read or decoded (e.g. a
// directory, a permission error, invalid UTF-8) throws instead of being
// silently skipped.
export function readEnvFileNames(dir = REPO_ROOT) {
  const names = new Set();
  for (const file of NEXT_ENV_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(path),
      );
      for (const name of Object.keys(parseEnv(text))) names.add(name);
    } catch {
      throw new EnvFileInspectionError(file);
    }
    for (const match of text.matchAll(ENV_LINE_NAME)) names.add(match[1]);
  }
  return [...names];
}

const PER_RUN_TOKEN = /^[0-9a-f]{64}$/;

export function buildLiveProviderChildEnv(
  parentEnv,
  { port, token, authorized, grant, envFileNames = [] },
) {
  if (authorized !== true || parentEnv[OPT_IN_VAR] !== "true")
    throw new Error(
      "A live-provider child environment requires explicit double authorization.",
    );
  if (!PER_RUN_TOKEN.test(token ?? ""))
    throw new Error("The per-run driver token must be 64 lowercase hex.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("A valid loopback port is required.");
  const env = { ...parentEnv };
  for (const name of Object.keys(env))
    if (SENSITIVE_NAME.test(name)) env[name] = "";
  for (const name of envFileNames) env[name] = "";
  for (const name of WITHHELD_FROM_LIVE_PROVIDER_APP) env[name] = "";
  delete env.NODE_ENV;
  return {
    ...env,
    ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED: "true",
    ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN: token,
    ACCEPTANCE_LIVE_PROVIDER_OPT_IN: "true",
    ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED: "true",
    OPENAI_API_KEY: grant?.OPENAI_API_KEY
      ? parentEnv.OPENAI_API_KEY.trim()
      : "",
    ANTHROPIC_API_KEY: grant?.ANTHROPIC_API_KEY
      ? parentEnv.ANTHROPIC_API_KEY.trim()
      : "",
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
// HTTP client for the acceptance route. One request per call; never
// retried here.
// ---------------------------------------------------------------------------
export function createLiveProviderClient({
  baseUrl,
  token,
  fetchImpl = fetch,
}) {
  return {
    async call(payload, timeoutMs) {
      const response = await fetchImpl(`${baseUrl}${ROUTE_PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", [DRIVER_HEADER]: token },
        body: JSON.stringify(payload),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
  };
}

// Ready = the route compiled AND its gate admitted this driver: an empty
// body passes the gate and is then refused 400 by strict input validation,
// before any provider work. 404 means the gate refused.
async function waitForAppReady(client, child, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined)
      return "EXITED";
    try {
      const { status } = await client.call({}, 10_000);
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
// Evidence. The route's response is re-validated field by field against a
// closed vocabulary before anything is printed, so even a misbehaving
// server could not route raw text into the report.
// ---------------------------------------------------------------------------
const RUNTIME_OUTCOMES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ABSTAINED",
  "ESCALATED",
  "BUDGET_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
  "NOT_EXECUTED",
]);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isBool = (v) => typeof v === "boolean";
const USAGE_KEYS = [
  "providerCalls",
  "attempts",
  "inputTokens",
  "outputTokens",
  "estimatedCostMicrousd",
  "elapsedMs",
];
const ENVELOPE_KEYS = [
  "maxProviderCalls",
  "maxAttempts",
  "maxOutputTokens",
  "maxEstimatedCostMicrousd",
  "totalDeadlineMs",
];

function pick(obj, keys, check) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const k of keys) {
    if (!check(obj[k])) return null;
    out[k] = obj[k];
  }
  return out;
}

export function sanitizeEvidence(evidence, surface) {
  if (!evidence || typeof evidence !== "object") return null;
  if (
    evidence.operation !== surface.operation ||
    evidence.surface !== surface.surface ||
    evidence.providerFamily !== surface.providerFamily ||
    evidence.adapterKind !== surface.adapterKind ||
    evidence.profileRef !== surface.profileRef ||
    evidence.modelId !== surface.modelId
  )
    return null;
  if (!RUNTIME_OUTCOMES.has(evidence.runtimeOutcome)) return null;
  if (evidence.runtimeDetail !== null && !CODE.test(evidence.runtimeDetail))
    return null;
  if (!["PASS", "FAIL", "BLOCKED"].includes(evidence.verdict)) return null;
  if (!CODE.test(evidence.verdictReason ?? "")) return null;
  if (!isBool(evidence.withinEnvelope)) return null;
  const usage = pick(evidence.usage, USAGE_KEYS, isCount);
  if (!usage) return null;
  const envelope =
    evidence.envelope === null
      ? null
      : pick(evidence.envelope, ENVELOPE_KEYS, isCount);
  if (evidence.envelope !== null && !envelope) return null;
  let examiner = null;
  if (evidence.examiner !== null) {
    const e = evidence.examiner;
    if (
      !e ||
      !isBool(e.strictParsePassed) ||
      ![null, "GRADED", "ESCALATE"].includes(e.outcome) ||
      !(e.marksValidationPassed === null || isBool(e.marksValidationPassed))
    )
      return null;
    examiner = {
      strictParsePassed: e.strictParsePassed,
      outcome: e.outcome,
      marksValidationPassed: e.marksValidationPassed,
    };
  }
  let lab = null;
  if (evidence.lab !== null) {
    if (!evidence.lab || !isCount(evidence.lab.outputLength)) return null;
    lab = { outputLength: evidence.lab.outputLength };
  }
  return {
    operation: evidence.operation,
    surface: evidence.surface,
    providerFamily: evidence.providerFamily,
    adapterKind: evidence.adapterKind,
    profileRef: evidence.profileRef,
    modelId: evidence.modelId,
    runtimeOutcome: evidence.runtimeOutcome,
    runtimeDetail: evidence.runtimeDetail,
    usage,
    envelope,
    withinEnvelope: evidence.withinEnvelope,
    examiner,
    lab,
    verdict: evidence.verdict,
    verdictReason: evidence.verdictReason,
  };
}

export function evidenceDetails(e) {
  const details = [
    `adapter=${e.adapterKind} profile=${e.profileRef} model=${e.modelId}`,
    `runtimeOutcome=${e.runtimeOutcome}${e.runtimeDetail ? ` (${e.runtimeDetail})` : ""}`,
    `providerCalls=${e.usage.providerCalls} attempts=${e.usage.attempts} inputTokens=${e.usage.inputTokens} outputTokens=${e.usage.outputTokens} estimatedCostMicrousd=${e.usage.estimatedCostMicrousd} elapsedMs=${e.usage.elapsedMs}`,
  ];
  if (e.envelope)
    details.push(
      `withinProfileEnvelope=${e.withinEnvelope} (maxProviderCalls=${e.envelope.maxProviderCalls} maxAttempts=${e.envelope.maxAttempts} maxOutputTokens=${e.envelope.maxOutputTokens} maxEstimatedCostMicrousd=${e.envelope.maxEstimatedCostMicrousd} totalDeadlineMs=${e.envelope.totalDeadlineMs})`,
    );
  if (e.examiner)
    details.push(
      `examinerOutcome=${e.examiner.outcome ?? "NONE"} strictParse=${e.examiner.strictParsePassed ? "passed" : "failed"} marksValidation=${e.examiner.marksValidationPassed === null ? "n/a" : e.examiner.marksValidationPassed ? "passed" : "failed"}`,
    );
  if (e.lab) details.push(`outputLength=${e.lab.outputLength}`);
  return details;
}

function resultFromEvidence(surface, evidence) {
  const details = evidenceDetails(evidence);
  if (evidence.usage.providerCalls > 1 || evidence.usage.attempts > 1)
    return fail(surface.surface, "MORE_THAN_ONE_PROVIDER_CALL", details);
  // A PASS must itself prove exactly one provider request happened; the
  // server enforces the same rule, and this consumer never trusts it alone.
  if (
    evidence.verdict === "PASS" &&
    (evidence.usage.providerCalls !== 1 || evidence.usage.attempts !== 1)
  )
    return fail(
      surface.surface,
      "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
      details,
    );
  if (evidence.verdict === "PASS")
    return pass(surface.surface, evidence.verdictReason, details);
  if (evidence.verdict === "BLOCKED")
    return blocked(surface.surface, evidence.verdictReason, details);
  return fail(surface.surface, evidence.verdictReason, details);
}

// ---------------------------------------------------------------------------
// The run. `startApp`, `stopApp`, `fetchImpl`, `envFileNames` and
// `envFileDir` exist only so tests can observe the driver without spawning
// Next.js or touching the network.
// ---------------------------------------------------------------------------
export async function runLiveProviderAcceptance({
  env = process.env,
  argv = process.argv.slice(2),
  startApp = startAppServer,
  stopApp = stopAppServer,
  fetchImpl = fetch,
  envFileNames,
  envFileDir,
  readinessTimeoutMs = 240_000,
  readinessPollMs = 1000,
  operationTimeoutMs = 90_000,
} = {}) {
  const plan = planLiveProviderRun(env, argv);
  const runnable = plan.filter((p) => p.runnable);
  // `providerRequestsMade` is the sum of providerCalls the route reported;
  // null means at least one operation's outcome is unknown.
  let providerRequestsMade = 0;
  if (runnable.length === 0)
    return { results: plan.map((p) => p.result), providerRequestsMade };

  const blockRunnable = (reason, details) =>
    plan.map((p) =>
      p.runnable ? blocked(p.surface, reason, details) : p.result,
    );
  if (startApp === startAppServer && !existsSync(NEXT_BIN))
    return {
      results: blockRunnable("node_modules/next is missing (npm install).", [
        "Zero provider requests were made.",
      ]),
      providerRequestsMade,
    };

  // Enumerated BEFORE any server starts: an env file whose names cannot be
  // inspected blocks the run with zero provider requests.
  let childEnvFileNames;
  try {
    childEnvFileNames = envFileNames ?? readEnvFileNames(envFileDir);
  } catch (error) {
    return {
      results: blockRunnable("ENV_FILE_NOT_INSPECTABLE", [
        error instanceof EnvFileInspectionError
          ? error.message
          : "An env file exists but its variable names could not be inspected.",
        "The app server was not started. Zero provider requests were made.",
      ]),
      providerRequestsMade,
    };
  }

  let child;
  try {
    const port = await freePort();
    const token = randomBytes(32).toString("hex");
    const grant = Object.fromEntries(runnable.map((p) => [p.keyVar, true]));
    child = startApp(
      buildLiveProviderChildEnv(env, {
        port,
        token,
        authorized: parseCliArgs(argv).authorized,
        grant,
        envFileNames: childEnvFileNames,
      }),
      port,
    );
    const client = createLiveProviderClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      fetchImpl,
    });
    const readiness = await waitForAppReady(
      client,
      child,
      readinessTimeoutMs,
      readinessPollMs,
    );
    if (readiness !== "READY")
      return {
        results: blockRunnable(
          `The local Ducelio app server did not become ready (${readiness}).`,
          [
            "Zero provider requests were made (the readiness probe never reaches a provider).",
            "GATE_REFUSED: the live-provider route gate refused this driver. EXITED/TIMEOUT: run `npm run dev` to diagnose; stop any other dev server using this checkout first.",
          ],
        ),
        providerRequestsMade,
      };

    const results = [];
    for (const p of plan) {
      if (!p.runnable) {
        results.push(p.result);
        continue;
      }
      let response;
      try {
        response = await client.call(
          { operation: p.operation },
          operationTimeoutMs,
        );
      } catch {
        providerRequestsMade = null;
        results.push(
          fail(p.surface, "ROUTE_DID_NOT_ANSWER", [
            "The acceptance route did not answer in time; a provider request may or may not have been made. Not retried.",
          ]),
        );
        continue;
      }
      const evidence =
        response.status === 200 && response.body?.ok === true
          ? sanitizeEvidence(response.body.evidence, p)
          : null;
      if (!evidence) {
        providerRequestsMade = null;
        results.push(
          fail(p.surface, "ROUTE_RETURNED_NO_VALID_EVIDENCE", [
            `HTTP ${response.status}. Not retried; a provider request may or may not have been made.`,
          ]),
        );
        continue;
      }
      if (providerRequestsMade !== null)
        providerRequestsMade += evidence.usage.providerCalls;
      results.push(resultFromEvidence(p, evidence));
    }
    return { results, providerRequestsMade };
  } catch {
    return {
      results: plan.map((p) =>
        p.runnable
          ? fail(p.surface, "Live-provider acceptance stopped unexpectedly.")
          : p.result,
      ),
      providerRequestsMade: null,
    };
  } finally {
    await stopApp(child);
  }
}

async function main() {
  console.log("===== Commercial V1 live-provider acceptance =====");
  const { results, providerRequestsMade } = await runLiveProviderAcceptance();
  for (const r of results) printResult(r);
  printSummary(results, "Commercial V1 live-provider acceptance");
  console.log("");
  console.log(
    `Provider requests made by this invocation: ${providerRequestsMade === null ? "UNKNOWN (see FAIL details)" : providerRequestsMade}`,
  );
  console.log(TRUTHFULNESS_STATEMENT);
  process.exit(exitCodeFor(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
