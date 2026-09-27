// Deterministic LOCAL provider stub for scripts/acceptance/examiner-app.mjs.
// Acceptance tooling only -- never imported by src/**, never a fallback the
// application can reach on its own.
//
// What it proves, and what it does not: the running Ducelio app still
// resolves its real EXAMINER_COMMERCIAL_V1 profile, builds its real OpenAI
// Responses request (src/server/academic-runtime/provider.ts, unmodified),
// and validates the reply with its real response schema, tariff costing,
// runtime budget checks and Examiner marks validation. Only the network
// destination differs: examiner-provider-redirect.mjs (loaded into the
// local acceptance app process alone) sends that one request to this
// loopback server instead of api.openai.com. The marks it returns are a
// fixed deterministic rule, so results here are evidence of the hosted
// HMAC/authority/FINALIZE path -- never LIVE_PROVIDER or grading-quality
// evidence.
//
// It never echoes request content: the only thing it reads from the
// governed context is each answered question's id and maxMarks. Expected
// answers, prompts and learner responses are never stored, logged or
// returned.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const STUB_PATH = "/v1/responses";
const MAX_REQUEST_BYTES = 256 * 1024;
const GRADING_CAPABILITIES = new Set([
  "grade_controlled_assessment",
  "regrade_controlled_assessment",
]);

// Deterministic rule: initial grading/recovery award each answered
// question its full maxMarks; a regrade awards one mark less (never below
// zero), so a regrade revision is observably the regrade call's own output.
export function stubMarks(capability, questions) {
  return questions.map((q) => ({
    questionId: q.questionId,
    marksAwarded:
      capability === "regrade_controlled_assessment"
        ? Math.max(0, q.maxMarks - 1)
        : q.maxMarks,
  }));
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("REQUEST_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseGovernedRequest(raw) {
  const body = JSON.parse(raw);
  if (
    typeof body?.model !== "string" ||
    typeof body.instructions !== "string" ||
    typeof body.input !== "string" ||
    !Number.isInteger(body.max_output_tokens) ||
    body.store !== false
  )
    return null;
  const input = JSON.parse(body.input);
  const capability = input?.capability;
  const questions = input?.context?.questions;
  if (!GRADING_CAPABILITIES.has(capability) || !Array.isArray(questions))
    return null;
  const bounded = questions.map((q) => ({
    questionId: q?.questionId,
    maxMarks: q?.maxMarks,
  }));
  if (
    bounded.some(
      (q) =>
        typeof q.questionId !== "string" ||
        !Number.isInteger(q.maxMarks) ||
        q.maxMarks < 0,
    )
  )
    return null;
  return {
    capability,
    attemptId:
      typeof input.context.attemptId === "string"
        ? input.context.attemptId
        : null,
    questions: bounded,
    requestBytes: Buffer.byteLength(raw),
  };
}

/**
 * Starts the stub on an ephemeral 127.0.0.1 port. Every request must carry
 * the per-run bearer key this function generated (handed to the child app
 * as its OPENAI_API_KEY -- never a real provider key). `planFailure()`
 * makes exactly the NEXT accepted request answer HTTP 503, which the real
 * adapter maps to PROVIDER_UNAVAILABLE -- how the driver creates a
 * genuinely recoverable initial execution through production code.
 */
export async function startProviderStub() {
  const apiKey = `acceptance-stub-${randomBytes(24).toString("hex")}`;
  const calls = [];
  let failNext = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== STUB_PATH)
      return reply(404, { error: "not_found" });
    if (!sameSecret(req.headers.authorization ?? "", `Bearer ${apiKey}`))
      return reply(401, { error: "unauthorized" });
    let request;
    try {
      request = parseGovernedRequest(await readBody(req));
    } catch {
      request = null;
    }
    if (!request) {
      calls.push({ capability: null, attemptId: null, outcome: "REJECTED" });
      return reply(400, { error: "unexpected_request" });
    }
    if (failNext) {
      failNext = false;
      calls.push({
        capability: request.capability,
        attemptId: request.attemptId,
        outcome: "PROVIDER_UNAVAILABLE",
      });
      return reply(503, { error: "acceptance_stub_unavailable" });
    }
    const text = JSON.stringify({
      outcome: "GRADED",
      marks: stubMarks(request.capability, request.questions),
    });
    calls.push({
      capability: request.capability,
      attemptId: request.attemptId,
      outcome: "GRADED",
    });
    reply(200, {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: {
        input_tokens: Math.min(Math.ceil(request.requestBytes / 4), 100_000),
        output_tokens: Math.min(Math.ceil(text.length / 4), 200),
      },
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${STUB_PATH}`,
    apiKey,
    calls,
    planFailure() {
      failNext = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Runtime attestation of the redirect (independent-review V1 blocker).
// Passing the preload through NODE_OPTIONS is never, by itself, treated as
// proof the redirect is live in the process that serves an acceptance
// request. The wrapper function carries a per-run marker token under
// PROVIDER_REDIRECT_MARKER (non-enumerable, non-writable,
// non-configurable) and answers exactly one in-process sentinel request,
// PROVIDER_REDIRECT_ATTESTATION_URL, with that same token -- without any
// network I/O. src/server/acceptance-app-driver.ts calls the CURRENT
// globalThis.fetch with that sentinel before accepting any acceptance
// operation. Next.js itself re-wraps globalThis.fetch inside its server
// (patchFetch -> createDedupeFetch, which does not expose what it wraps),
// so an identity check on globalThis.fetch alone would refuse every real
// request; calling it instead proves the marked wrapper sits in the exact
// fetch chain the production provider adapter uses in that process. If the
// preload is absent or fetch was replaced by anything that does not route
// through this wrapper, nothing answers the sentinel (its .invalid host can
// never resolve, so no HTTP connection is ever possible) and the route
// answers 404. The sentinel URL and header are duplicated verbatim in the
// gate module (src/** cannot import scripts/**); a test pins them equal.
export const PROVIDER_REDIRECT_MARKER = Symbol.for(
  "ducelio.acceptance.provider-redirect-v1",
);
export const PROVIDER_REDIRECT_ATTESTATION_URL =
  "http://provider-redirect-attestation.ducelio.invalid/v1";
export const PROVIDER_REDIRECT_ATTESTATION_HEADER =
  "x-ducelio-provider-redirect-attestation";
const REDIRECT_TOKEN = /^[0-9a-f]{64}$/;

function requestUrl(input) {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input?.url;
}

/**
 * Wraps `baseFetch` so that ONLY the exact OpenAI Responses URL the real
 * adapter calls is sent to the loopback stub, and every other request to a
 * real AI vendor host is refused outright (no silent passthrough to a paid
 * provider). All other traffic -- hosted Supabase in particular -- is
 * untouched. The returned function is marked with `redirectToken` (see
 * PROVIDER_REDIRECT_MARKER above) and answers the in-process attestation
 * sentinel with it.
 */
export function createProviderRedirectFetch(baseFetch, stubUrl, redirectToken) {
  const target = new URL(stubUrl);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== STUB_PATH ||
    target.username ||
    target.password
  )
    throw new Error(
      "The acceptance provider stub URL must be http://127.0.0.1:<port>/v1/responses.",
    );
  if (!REDIRECT_TOKEN.test(redirectToken ?? ""))
    throw new Error(
      "The acceptance provider redirect token must be 64 lowercase hex characters.",
    );
  async function acceptanceProviderFetch(input, init) {
    const url = requestUrl(input);
    if (
      url === PROVIDER_REDIRECT_ATTESTATION_URL &&
      !(input instanceof Request)
    )
      return new Response(null, {
        status: 204,
        headers: {
          [PROVIDER_REDIRECT_ATTESTATION_HEADER]:
            acceptanceProviderFetch[PROVIDER_REDIRECT_MARKER],
        },
      });
    if (url === OPENAI_RESPONSES_URL && !(input instanceof Request))
      return baseFetch(target.href, init);
    if (
      typeof url === "string" &&
      /^https?:\/\/([^/]*\.)?(openai|anthropic)\.com(?=[:/]|$)/i.test(url)
    )
      throw new TypeError(
        "Acceptance app driver: real AI provider access is disabled in this process.",
      );
    return baseFetch(input, init);
  }
  Object.defineProperty(acceptanceProviderFetch, PROVIDER_REDIRECT_MARKER, {
    value: redirectToken,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return acceptanceProviderFetch;
}
