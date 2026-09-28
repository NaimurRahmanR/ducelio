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
//
// Journey mode (`startProviderStub({ journey: true })`, used ONLY by
// scripts/acceptance/customer-journey.mjs) additionally answers the other
// production capabilities a staged learner journey reaches -- the Professor
// classroom read (get_lesson_context), Tutor support (tutor_lab_support over
// OpenAI Responses), Lab Instructor support (tutor_lab_support over the
// Anthropic Messages contract, on its own loopback path) and Examiner lab
// grading (grade_practical_lab) -- with fixed deterministic output. Without
// that flag every one of those is refused exactly as before.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const STUB_PATH = "/v1/responses";
const ANTHROPIC_STUB_PATH = "/v1/messages";
const MAX_REQUEST_BYTES = 256 * 1024;
const GRADING_CAPABILITIES = new Set([
  "grade_controlled_assessment",
  "regrade_controlled_assessment",
]);
const MODEL_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

// Journey mode only: the fixed learner-facing text each conversational role
// returns. Never derived from request content.
export const JOURNEY_STUB_TEXT = Object.freeze({
  PROFESSOR: "Synthetic acceptance Professor response.",
  TUTOR: "Synthetic acceptance Tutor response.",
  LAB_INSTRUCTOR: "Synthetic acceptance Lab Instructor response.",
});

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

function parseGovernedRequest(raw, journey = false) {
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
  if (journey && !GRADING_CAPABILITIES.has(capability))
    return parseJourneyInput(input, raw, "OPENAI", body.model);
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

// Journey mode only. Reads nothing from the governed context beyond the
// bounded identifiers/limits it needs to answer deterministically (the lab
// submission id and maxMarks; the conversational role); lesson content,
// learner messages, submission bodies and grading guidance are never read,
// stored or returned.
const TEXT_ROLES = Object.freeze({
  OPENAI: new Set(["TUTOR"]),
  ANTHROPIC: new Set(["LAB_INSTRUCTOR"]),
});
function parseJourneyInput(input, raw, transport, model) {
  const capability = input?.capability;
  const context = input?.context;
  const common = {
    capability,
    transport,
    model: MODEL_ID.test(model ?? "") ? model : null,
    requestBytes: Buffer.byteLength(raw),
  };
  if (transport === "OPENAI" && capability === "grade_practical_lab") {
    if (
      typeof context?.submissionId !== "string" ||
      !Number.isInteger(context.maxMarks) ||
      context.maxMarks < 0
    )
      return null;
    return {
      ...common,
      kind: "LAB_GRADING",
      submissionId: context.submissionId,
      maxMarks: context.maxMarks,
    };
  }
  if (transport === "OPENAI" && capability === "get_lesson_context")
    return { ...common, kind: "TEXT", role: "PROFESSOR" };
  if (
    capability === "tutor_lab_support" &&
    TEXT_ROLES[transport].has(context?.role)
  )
    return { ...common, kind: "TEXT", role: context.role };
  return null;
}

function parseAnthropicRequest(raw) {
  const body = JSON.parse(raw);
  if (
    typeof body?.model !== "string" ||
    typeof body.system !== "string" ||
    !Number.isInteger(body.max_tokens) ||
    !Array.isArray(body.messages) ||
    body.messages.length !== 1 ||
    body.messages[0]?.role !== "user" ||
    typeof body.messages[0].content !== "string"
  )
    return null;
  return parseJourneyInput(
    JSON.parse(body.messages[0].content),
    raw,
    "ANTHROPIC",
    body.model,
  );
}

// ---------------------------------------------------------------------------
// Acceptance-only synchronization holds (scripts/acceptance/
// concurrency-app-races.mjs). Entirely in THIS (driver) process; nothing
// about them is reachable from a browser or from the app's HTTP surface.
// With no hold armed, every request is answered exactly as before.
//
// A hold is one-shot: it captures exactly the NEXT matching request after it
// is armed, reports that the request has arrived (`arrived`), and keeps it
// parked until the driver calls release() -- an explicit barrier, never a
// sleep. `settled` reports what finally happened to the parked request:
// RESPONDED (released and answered), CLIENT_ABORTED (the caller gave up
// first, e.g. the app runtime's own provider deadline fired) or CANCELLED
// (teardown). close() cancels every outstanding hold before the server
// stops, so a failed scenario can never leave a request -- or the driver --
// hanging.
// ---------------------------------------------------------------------------
export const CONTEXT_HOLD_PATH = "/v1/acceptance-holds/context-read";

function createHold(kind) {
  let signalArrival;
  let rejectArrival;
  let signalRelease;
  let signalSettled;
  const hold = {
    kind,
    state: "ARMED",
    arrival: null,
    arrived: new Promise((resolve, reject) => {
      signalArrival = resolve;
      rejectArrival = reject;
    }),
    released: new Promise((resolve) => {
      signalRelease = resolve;
    }),
    settled: new Promise((resolve) => {
      signalSettled = resolve;
    }),
    release() {
      if (hold.state === "ARMED" || hold.state === "HELD") signalRelease(true);
    },
    arrive(arrival) {
      hold.state = "HELD";
      hold.arrival = arrival;
      signalArrival(arrival);
    },
    settle(outcome) {
      if (hold.state === "SETTLED") return;
      hold.state = "SETTLED";
      signalSettled(outcome);
    },
    cancel() {
      if (hold.state === "ARMED") {
        rejectArrival(
          new Error(
            `The ${kind} hold was cancelled before any request arrived.`,
          ),
        );
        hold.settle("CANCELLED");
      }
      // A parked request is released with `false`: its handler answers a
      // refusal instead of the governed response, then settles CANCELLED.
      signalRelease(false);
    },
  };
  // A cancelled, never-awaited arrival must not surface as an unhandled
  // rejection in the driver process.
  hold.arrived.catch(() => {});
  return hold;
}

// The oldest still-armed hold; a hold cancelled before any request arrived
// is discarded, never allowed to capture a later, unrelated request.
function nextHold(queue) {
  while (queue.length && queue[0].state === "SETTLED") queue.shift();
  return queue.shift() ?? null;
}

// Resolves true when released, false when cancelled or when the waiting
// request's own connection closes first.
function awaitRelease(hold, res) {
  return new Promise((resolve) => {
    const onClose = () => {
      if (!res.writableFinished) resolve(false);
    };
    res.once("close", onClose);
    hold.released.then((released) => {
      res.off("close", onClose);
      resolve(released);
    });
  });
}

/**
 * Starts the stub on an ephemeral 127.0.0.1 port. Every request must carry
 * the per-run bearer key this function generated (handed to the child app
 * as its OPENAI_API_KEY -- never a real provider key). `planFailure()`
 * makes exactly the NEXT accepted request answer HTTP 503, which the real
 * adapter maps to PROVIDER_UNAVAILABLE -- how the driver creates a
 * genuinely recoverable initial execution through production code.
 *
 * `holdNextProviderResponse()` / `holdNextContextRead()` arm the one-shot
 * acceptance holds described above. The context-read control endpoint is
 * authenticated by its own per-run token (`contextHoldControl.token`),
 * distinct from the provider key, and is only ever handed to an app child
 * the concurrency driver explicitly configures for it.
 */
//
// `journey: true` (customer-journey.mjs only) additionally answers the
// journey capabilities described in the module header, the Anthropic
// Messages path (authenticated by the same per-run key as `x-api-key`), and
// arms `planZeroMarks()`: exactly the NEXT graded Examiner request (initial,
// recovery, regrade or lab) awards zero marks -- how the journey produces a
// genuine below-pass-mark result through production grading. Journey call
// records also carry the transport, model id, role and lab submission id.
export async function startProviderStub({ journey = false } = {}) {
  const apiKey = `acceptance-stub-${randomBytes(24).toString("hex")}`;
  const contextHoldToken = randomBytes(32).toString("hex");
  const calls = [];
  const providerHolds = [];
  const contextHolds = [];
  const everyHold = [];
  let failNext = false;
  let zeroNext = false;
  const record = (request, outcome, extra = {}) =>
    journey
      ? {
          capability: request?.capability ?? null,
          attemptId: request?.attemptId ?? null,
          submissionId: request?.submissionId ?? null,
          transport: request?.transport ?? null,
          role: request?.role ?? null,
          model: request?.model ?? null,
          outcome,
          ...extra,
        }
      : {
          capability: request?.capability ?? null,
          attemptId: request?.attemptId ?? null,
          outcome,
          ...extra,
        };
  const arm = (queue, kind) => {
    const hold = createHold(kind);
    queue.push(hold);
    everyHold.push(hold);
    return hold;
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === CONTEXT_HOLD_PATH) {
      if (
        !sameSecret(
          req.headers.authorization ?? "",
          `Bearer ${contextHoldToken}`,
        )
      )
        return reply(401, { error: "unauthorized" });
      const hold = nextHold(contextHolds);
      if (!hold) return reply(200, { held: false });
      hold.arrive({ kind: "CONTEXT_READ" });
      const released = await awaitRelease(hold, res);
      hold.settle(
        released ? "RESPONDED" : res.destroyed ? "CLIENT_ABORTED" : "CANCELLED",
      );
      if (res.writableEnded || res.destroyed) return;
      return reply(200, { held: true, released });
    }
    const anthropic = journey && req.url === ANTHROPIC_STUB_PATH;
    if (req.method !== "POST" || (req.url !== STUB_PATH && !anthropic))
      return reply(404, { error: "not_found" });
    const presented = anthropic
      ? String(req.headers["x-api-key"] ?? "")
      : String(req.headers.authorization ?? "");
    if (!sameSecret(presented, anthropic ? apiKey : `Bearer ${apiKey}`))
      return reply(401, { error: "unauthorized" });
    let request;
    try {
      const raw = await readBody(req);
      request = anthropic
        ? parseAnthropicRequest(raw)
        : parseGovernedRequest(raw, journey);
    } catch {
      request = null;
    }
    if (!request) {
      calls.push(record(null, "REJECTED"));
      return reply(400, { error: "unexpected_request" });
    }
    if (journey && !request.kind)
      Object.assign(request, {
        kind: "ASSESSMENT_GRADING",
        transport: "OPENAI",
        model: null,
      });
    const hold = nextHold(providerHolds);
    if (hold) {
      hold.arrive({
        capability: request.capability,
        attemptId: request.attemptId,
      });
      const released = await awaitRelease(hold, res);
      if (!released) {
        const aborted = !res.writableEnded && res.destroyed;
        hold.settle(aborted ? "CLIENT_ABORTED" : "CANCELLED");
        calls.push(
          record(request, aborted ? "CLIENT_ABORTED" : "HOLD_CANCELLED", {
            held: true,
          }),
        );
        if (!res.writableEnded && !res.destroyed)
          reply(503, { error: "acceptance_hold_cancelled" });
        return;
      }
    }
    // Only a released hold marks its call; unheld calls keep their exact
    // previous shape.
    const heldMark = hold ? { held: true } : {};
    if (failNext) {
      failNext = false;
      calls.push(record(request, "PROVIDER_UNAVAILABLE", heldMark));
      reply(503, { error: "acceptance_stub_unavailable" });
      hold?.settle("RESPONDED");
      return;
    }
    const graded =
      request.kind === undefined ||
      request.kind === "ASSESSMENT_GRADING" ||
      request.kind === "LAB_GRADING";
    const zero = journey && graded && zeroNext;
    if (zero) zeroNext = false;
    let text;
    if (request.kind === "TEXT") text = JOURNEY_STUB_TEXT[request.role];
    else if (request.kind === "LAB_GRADING")
      text = JSON.stringify({
        outcome: "GRADED",
        marksAwarded: zero ? 0 : request.maxMarks,
      });
    else
      text = JSON.stringify({
        outcome: "GRADED",
        marks: stubMarks(request.capability, request.questions).map((m) =>
          zero ? { ...m, marksAwarded: 0 } : m,
        ),
      });
    calls.push(
      record(
        request,
        request.kind === "TEXT" ? "ANSWERED" : "GRADED",
        journey ? { ...heldMark, zeroMarks: zero } : heldMark,
      ),
    );
    const inputTokens = Math.min(Math.ceil(request.requestBytes / 4), 100_000);
    const outputTokens = Math.min(Math.ceil(text.length / 4), 200);
    reply(
      200,
      anthropic
        ? {
            type: "message",
            stop_reason: "end_turn",
            content: [{ type: "text", text }],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }
        : {
            status: "completed",
            output: [
              { type: "message", content: [{ type: "output_text", text }] },
            ],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
    );
    hold?.settle("RESPONDED");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${STUB_PATH}`,
    // Journey mode only; null otherwise (the Anthropic path answers 404).
    anthropicUrl: journey
      ? `http://127.0.0.1:${port}${ANTHROPIC_STUB_PATH}`
      : null,
    apiKey,
    calls,
    planFailure() {
      failNext = true;
    },
    planZeroMarks() {
      if (!journey)
        throw new Error("planZeroMarks is available in journey mode only.");
      zeroNext = true;
    },
    // Disarms any one-shot control a caller armed but never used (e.g. the
    // production path refused admission before any provider call), so it
    // can never capture a later, unrelated request.
    clearPlans() {
      failNext = false;
      zeroNext = false;
    },
    holdNextProviderResponse: () => arm(providerHolds, "provider"),
    holdNextContextRead: () => arm(contextHolds, "context-read"),
    contextHoldControl: Object.freeze({
      url: `http://127.0.0.1:${port}${CONTEXT_HOLD_PATH}`,
      token: contextHoldToken,
    }),
    close: () => {
      for (const hold of everyHold) hold.cancel();
      providerHolds.length = 0;
      contextHolds.length = 0;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
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

// The one protected-context RPC whose already-served RESPONSE the
// concurrency driver may ask the app process to hold before handing it back
// to the (unmodified) initial-grading orchestrator. Why a second hold point
// exists at all: the EXAMINER_COMMERCIAL_V1 runtime profile's provider
// deadline (15 s) is shorter than migration 031's DB-owned execution lease
// (20 s), so a provider-only hold can never keep the original invocation
// alive past the lease -- the runtime would abort and FINALIZE FAILED while
// the lease was still live. Holding delivery of this response keeps the
// original request genuinely in flight past its lease without touching the
// lease, the attestation, the request or the response bytes.
export const CONTEXT_HOLD_RPC_PATH =
  "/rest/v1/rpc/get_commercial_v1_examiner_assessment_context";
const HOLD_TOKEN = /^[0-9a-f]{64}$/;

function validContextHold(contextHold) {
  if (contextHold == null) return null;
  const control = new URL(contextHold.url ?? "");
  const supabase = new URL(contextHold.supabaseUrl ?? "");
  if (
    control.protocol !== "http:" ||
    control.hostname !== "127.0.0.1" ||
    control.pathname !== CONTEXT_HOLD_PATH ||
    control.username ||
    control.password ||
    !HOLD_TOKEN.test(contextHold.token ?? "") ||
    !/^https?:$/.test(supabase.protocol)
  )
    throw new Error(
      "The acceptance context-read hold needs a loopback control URL, a 64-hex control token and the Supabase URL.",
    );
  return {
    controlUrl: control.href,
    token: contextHold.token,
    supabaseOrigin: supabase.origin,
  };
}

function isContextReadRpc(url, supabaseOrigin) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === supabaseOrigin &&
      parsed.pathname === CONTEXT_HOLD_RPC_PATH
    );
  } catch {
    return false;
  }
}

// Journey mode only: the Anthropic stub path must be on the SAME loopback
// stub origin as the OpenAI path. Absent (null), Anthropic stays refused.
function validAnthropicStub(anthropicStubUrl, openAITarget) {
  if (anthropicStubUrl == null) return null;
  const target = new URL(anthropicStubUrl);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== ANTHROPIC_STUB_PATH ||
    target.username ||
    target.password ||
    target.search ||
    target.origin !== openAITarget.origin
  )
    throw new Error(
      "The acceptance Anthropic stub URL must be http://127.0.0.1:<stub port>/v1/messages.",
    );
  return target;
}

/**
 * Wraps `baseFetch` so that ONLY the exact OpenAI Responses URL the real
 * adapter calls is sent to the loopback stub, and every other request to a
 * real AI vendor host is refused outright (no silent passthrough to a paid
 * provider). All other traffic -- hosted Supabase in particular -- is
 * untouched. The returned function is marked with `redirectToken` (see
 * PROVIDER_REDIRECT_MARKER above) and answers the in-process attestation
 * sentinel with it.
 *
 * `contextHold` (concurrency driver only; absent for examiner-app) makes the
 * wrapper, AFTER the context-read RPC has completed against the database,
 * ask the driver's loopback control endpoint whether to park the response;
 * the endpoint answers immediately unless the driver armed a hold. The
 * response is never read, copied, logged or altered here.
 */
export function createProviderRedirectFetch(
  baseFetch,
  stubUrl,
  redirectToken,
  contextHold = null,
  { anthropicStubUrl = null } = {},
) {
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
  const hold = validContextHold(contextHold);
  const anthropicTarget = validAnthropicStub(anthropicStubUrl, target);
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
    // Journey driver only: the exact Anthropic Messages URL the real Lab
    // Instructor adapter calls goes to the SAME loopback stub (its own
    // path). Without anthropicStubUrl it is refused below, as before.
    if (
      anthropicTarget &&
      url === ANTHROPIC_MESSAGES_URL &&
      !(input instanceof Request)
    )
      return baseFetch(anthropicTarget.href, init);
    if (
      typeof url === "string" &&
      /^https?:\/\/([^/]*\.)?(openai|anthropic)\.com(?=[:/]|$)/i.test(url)
    )
      throw new TypeError(
        "Acceptance app driver: real AI provider access is disabled in this process.",
      );
    if (hold && isContextReadRpc(url, hold.supabaseOrigin)) {
      const response = await baseFetch(input, init);
      // Fail-open for the HOLD only: if the control endpoint is unreachable
      // the response is delivered unheld, and the driver -- which waits for
      // an explicit arrival -- reports the race as not reached (FAIL),
      // never as a PASS.
      await baseFetch(hold.controlUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${hold.token}` },
      })
        .then((control) => control.arrayBuffer())
        .catch(() => {});
      return response;
    }
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
