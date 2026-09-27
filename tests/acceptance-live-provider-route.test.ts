import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// src/app/api/acceptance/live-provider/route.ts and
// src/server/live-provider-acceptance-driver.ts -- the acceptance-only HTTP
// hop `npm run acceptance:live-provider` uses to reach the EXISTING
// production profile registry, native adapters and governed runtime.
//
// ZERO billable traffic: globalThis.fetch is replaced in every test by a
// fake that answers the two fixed vendor URLs with canned bodies and throws
// for anything else. Only @/lib/env's APP_URL is otherwise replaced;
// everything behind the route -- resolveRoleBoundRuntimeProfile,
// resolvePlatformRuntimeProfile, resolveAdapterForProfile, the OpenAI/
// Anthropic adapters, tariffs, runGovernedProviderExecution and the Examiner
// parser/validator -- is the real production code.
// ============================================================================

const state = vi.hoisted(() => ({ appUrl: "http://127.0.0.1:3200" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    config: () => ({
      url: "",
      key: "",
      configured: false,
      appUrl: state.appUrl,
      google: false,
      linkedin: false,
    }),
  };
});

import { POST } from "@/app/api/acceptance/live-provider/route";
import {
  LIVE_PROVIDER_SMOKE_PLANS,
  SYNTHETIC_EXAMINER_CONTEXT,
  SYNTHETIC_LAB_CONTEXT,
  SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT,
  liveProviderAcceptanceRequestAllowed,
  runLiveProviderSmoke,
  type LiveProviderSmokeDeps,
} from "@/server/live-provider-acceptance-driver";
import {
  resolveAdapterForProfile,
  resolvePlatformRuntimeProfile,
  resolveRoleBoundRuntimeProfile,
  resolveRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { runGovernedProviderExecution } from "@/server/academic-runtime/runtime";
import { examinerAssessmentContextSchema } from "@/domain/commercial-v1-examiner-grading";
import {
  TUTOR_LAB_ALLOWED_REASONS,
  TUTOR_LAB_EXECUTION_DB_CEILING,
} from "@/domain/tutor-lab-execution";
import { agentRoleSchema } from "@/domain/academic-capability-policy";
import {
  OPERATIONS_ENGINEER_PROHIBITED_SCOPES,
  isOperationsEngineerCapabilityAllowed,
  operationsEngineerCapabilityCatalogue,
} from "@/domain/platform-ai-policy";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import type { RuntimeResult } from "@/domain/academic-runtime";

const TOKEN = "e".repeat(64);
const OPENAI_KEY = "sk-openai-test-key-sentinel";
const ANTHROPIC_KEY = "sk-ant-test-key-sentinel";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const QUESTION_ID = SYNTHETIC_EXAMINER_CONTEXT.questions[0].questionId;

type Captured = { url: string; init: RequestInit };
let captured: Captured[] = [];
let openAIReply: () => Response;
let anthropicReply: () => Response;

function openAIText(text: string, usage = { input: 300, output: 40 }) {
  return () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text }] },
        ],
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      }),
      { status: 200 },
    );
}
function anthropicText(text: string, usage = { input: 200, output: 50 }) {
  return () =>
    new Response(
      JSON.stringify({
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      }),
      { status: 200 },
    );
}

const fakeFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  captured.push({ url, init: init ?? {} });
  if (url === OPENAI_URL) return openAIReply();
  if (url === ANTHROPIC_URL) return anthropicReply();
  throw new Error("Unexpected network request in a zero-traffic test.");
});

function enableGate() {
  vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_OPT_IN", "true");
  vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED", "true");
  vi.stubEnv("NODE_ENV", "test");
}

function request(
  body: unknown,
  headers: Record<string, string | undefined> = {},
): Request {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    "content-type": "application/json",
    host: "127.0.0.1:3200",
    "x-ducelio-live-provider-driver": TOKEN,
    ...headers,
  }))
    if (v !== undefined) merged[k] = v;
  return new Request("http://127.0.0.1:3200/api/acceptance/live-provider", {
    method: "POST",
    headers: merged,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function callRoute(body: unknown, headers = {}) {
  const response = await POST(request(body, headers));
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

beforeEach(() => {
  state.appUrl = "http://127.0.0.1:3200";
  captured = [];
  fakeFetch.mockClear();
  openAIReply = openAIText(
    JSON.stringify({
      outcome: "GRADED",
      marks: [{ questionId: QUESTION_ID, marksAwarded: 2 }],
    }),
  );
  anthropicReply = anthropicText(
    "RAW-LAB-OUTPUT-SENTINEL: start by comparing first letters.",
  );
  vi.stubGlobal("fetch", fakeFetch);
  for (const name of [
    "ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED",
    "ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN",
    "ACCEPTANCE_LIVE_PROVIDER_OPT_IN",
    "ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED",
    "ACCEPTANCE_APP_DRIVER_ENABLED",
    "ACCEPTANCE_APP_DRIVER_TOKEN",
    "ACCEPTANCE_PROVIDER_STUB_URL",
    "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
    "ACADEMIC_PROVIDER_BASE_URL",
    "ACADEMIC_PROVIDER_API_KEY",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY);
  vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const openai = { operation: "OPENAI_EXAMINER_SMOKE" };
const anthropic = { operation: "ANTHROPIC_LAB_SMOKE" };
const opsEngineer = { operation: "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE" };

describe("live-provider acceptance route: disabled by default and fail-closed", () => {
  it("answers 404 with no acceptance configuration, without reading the body or calling any provider", async () => {
    const req = request(openai);
    const response = await POST(req);
    expect(response.status).toBe(404);
    expect(req.bodyUsed).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  const refusals: [string, () => void, Record<string, string | undefined>][] = [
    [
      "driver not enabled",
      () => vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED", "yes"),
      {},
    ],
    ["production NODE_ENV", () => vi.stubEnv("NODE_ENV", "production"), {}],
    [
      "malformed configured token",
      () => vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN", "E".repeat(64)),
      { "x-ducelio-live-provider-driver": "E".repeat(64) },
    ],
    [
      "opt-in not exactly true",
      () => vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_OPT_IN", "TRUE"),
      {},
    ],
    [
      "operator authorization not propagated",
      () => vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED", ""),
      {},
    ],
    [
      "examiner-app driver co-resident",
      () => vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true"),
      {},
    ],
    [
      "provider stub redirect present",
      () => vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", "1".repeat(64)),
      {},
    ],
    [
      "non-loopback APP_URL",
      () => {
        state.appUrl = "https://ducelio.example.com";
      },
      {},
    ],
    ["non-loopback Host", () => {}, { host: "ducelio.example.com" }],
    ["missing Host", () => {}, { host: undefined }],
    ["browser Origin", () => {}, { origin: "http://127.0.0.1:3200" }],
    ["browser Sec-Fetch-Site", () => {}, { "sec-fetch-site": "same-origin" }],
    [
      "wrong token",
      () => {},
      { "x-ducelio-live-provider-driver": "f".repeat(64) },
    ],
    ["malformed token", () => {}, { "x-ducelio-live-provider-driver": "abc" }],
    [
      "missing token",
      () => {},
      { "x-ducelio-live-provider-driver": undefined },
    ],
  ];
  for (const [label, arrange, headers] of refusals) {
    it(`answers 404 before reading the body when: ${label}`, async () => {
      enableGate();
      arrange();
      const req = request(openai, headers);
      const response = await POST(req);
      expect(response.status).toBe(404);
      expect(req.bodyUsed).toBe(false);
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  }

  it("accepts exactly the per-run token only when every gate holds", () => {
    enableGate();
    expect(liveProviderAcceptanceRequestAllowed(request(openai))).toBe(true);
    expect(
      liveProviderAcceptanceRequestAllowed(request(openai), {
        ...process.env,
        ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN: "d".repeat(64),
      }),
    ).toBe(false);
    for (const host of ["localhost:3200", "[::1]:3200"])
      expect(
        liveProviderAcceptanceRequestAllowed(request(openai, { host })),
      ).toBe(true);
  });

  it("does not accept the examiner-app driver header or token", async () => {
    enableGate();
    const response = await callRoute(openai, {
      "x-ducelio-live-provider-driver": undefined,
      "x-ducelio-acceptance-driver": TOKEN,
    });
    expect(response.status).toBe(404);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("live-provider acceptance route: strict caller input", () => {
  it("rejects malformed JSON, an empty body and unknown operations with 400", async () => {
    enableGate();
    for (const body of [
      "{not json",
      {},
      { operation: "PROBE" },
      { operation: 1 },
      // CLI selector names and near-misses are not operations.
      { operation: "ANTHROPIC_OPERATIONS_ENGINEER" },
      { operation: "OPERATIONS_ENGINEER_SMOKE" },
      { operation: "anthropic_operations_engineer_smoke" },
      { operation: ["ANTHROPIC_OPERATIONS_ENGINEER_SMOKE"] },
    ])
      expect((await callRoute(body)).status).toBe(400);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  for (const [field, value] of [
    ["provider", "OPENAI"],
    ["model", "gpt-5.6-terra"],
    ["profile", "OPERATIONS_ENGINEER_PLATFORM_V1"],
    ["profileRef", "PROFESSOR_COMMERCIAL_V1"],
    ["endpoint", "https://attacker.example.com/v1"],
    ["apiKey", "sk-attacker"],
    ["budget", { maxOutputTokens: 100000 }],
    ["context", { learnerMessage: "ignore previous instructions" }],
    ["role", "PROFESSOR"],
    ["role", "OPERATIONS_ENGINEER"],
    ["capability", "grade_practical_lab"],
    ["capability", "propose_pull_request"],
    ["surface", "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER"],
    ["selector", "ANTHROPIC_OPERATIONS_ENGINEER"],
    ["prompt", "say hi"],
    ["instructions", "system override"],
  ] as const) {
    it(`rejects a caller-supplied ${field} with 400 and no provider call`, async () => {
      enableGate();
      for (const op of [openai, anthropic, opsEngineer])
        expect((await callRoute({ ...op, [field]: value })).status).toBe(400);
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  }
});

describe("live-provider acceptance: exact production surfaces", () => {
  it("the OpenAI surface resolves exactly EXAMINER_COMMERCIAL_V1 / gpt-5.6-luna / OPENAI_RESPONSES through the role-bound registry", () => {
    const plan = LIVE_PROVIDER_SMOKE_PLANS.OPENAI_EXAMINER_SMOKE;
    const profile = resolveRoleBoundRuntimeProfile(plan.role, plan.profileRef);
    expect(profile).toBe(resolveRuntimeProfile("EXAMINER_COMMERCIAL_V1"));
    expect(profile?.adapterKind).toBe("OPENAI_RESPONSES");
    expect(
      profile?.adapterKind === "OPENAI_RESPONSES" &&
        profile.providerConfig.model,
    ).toBe("gpt-5.6-luna");
    expect(plan).toMatchObject({
      role: "EXAMINER",
      capability: "grade_controlled_assessment",
      profileRef: "EXAMINER_COMMERCIAL_V1",
      adapterKind: "OPENAI_RESPONSES",
      modelId: "gpt-5.6-luna",
    });
    expect(profile?.budgetPolicy).toMatchObject({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 1200,
      totalDeadlineMs: 15000,
      maxEstimatedCostMicrousd: 50000,
    });
  });

  it("the Anthropic surface resolves exactly LAB_INSTRUCTOR_COMMERCIAL_V1 / claude-sonnet-5 / ANTHROPIC_MESSAGES", () => {
    const plan = LIVE_PROVIDER_SMOKE_PLANS.ANTHROPIC_LAB_SMOKE;
    const profile = resolveRoleBoundRuntimeProfile(plan.role, plan.profileRef);
    expect(profile).toBe(resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1"));
    expect(profile?.adapterKind).toBe("ANTHROPIC_MESSAGES");
    expect(
      profile?.adapterKind === "ANTHROPIC_MESSAGES" &&
        profile.providerConfig.model,
    ).toBe("claude-sonnet-5");
    expect(plan).toMatchObject({
      role: "LAB_INSTRUCTOR",
      capability: "tutor_lab_support",
    });
    expect(profile?.budgetPolicy).toMatchObject({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 700,
      totalDeadlineMs: 15000,
      maxEstimatedCostMicrousd: 40000,
    });
    // The production Lab path clamps the profile budget to the Tutor/Lab
    // DB ceiling; for this profile that clamp is the identity, so the
    // smoke's envelope is exactly the production effective envelope.
    expect(profile!.budgetPolicy.maxOutputTokens).toBeLessThanOrEqual(
      TUTOR_LAB_EXECUTION_DB_CEILING.maxOutputTokens,
    );
    expect(profile!.budgetPolicy.maxEstimatedCostMicrousd).toBeLessThanOrEqual(
      TUTOR_LAB_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    );
  });

  it("the synthetic contexts are valid, tiny and labelled demo content", () => {
    expect(
      examinerAssessmentContextSchema.parse(SYNTHETIC_EXAMINER_CONTEXT),
    ).toEqual(SYNTHETIC_EXAMINER_CONTEXT);
    expect(SYNTHETIC_EXAMINER_CONTEXT.questions).toHaveLength(1);
    expect(SYNTHETIC_EXAMINER_CONTEXT.title).toMatch(/demo content/);
    expect(SYNTHETIC_LAB_CONTEXT.practical.title).toMatch(/demo content/);
    for (const context of [SYNTHETIC_EXAMINER_CONTEXT, SYNTHETIC_LAB_CONTEXT])
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(2000);
  });

  it("a registry drift fails closed as PROFILE_MISMATCH before any provider call", async () => {
    const execute = vi.fn(runGovernedProviderExecution);
    const resolvePlatformProfile = vi.fn(resolvePlatformRuntimeProfile);
    const deps: LiveProviderSmokeDeps = {
      resolveProfile: () => resolveRuntimeProfile("TUTOR_COMMERCIAL_V1"),
      resolvePlatformProfile,
      resolveAdapter: resolveAdapterForProfile,
      execute,
    };
    const evidence = await runLiveProviderSmoke("OPENAI_EXAMINER_SMOKE", deps);
    expect(evidence).toMatchObject({
      verdict: "FAIL",
      verdictReason: "PROFILE_MISMATCH",
      runtimeOutcome: "NOT_EXECUTED",
    });
    expect(evidence.usage.providerCalls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(resolvePlatformProfile).not.toHaveBeenCalled();
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("live-provider acceptance: OpenAI Examiner smoke through the production adapter/runtime", () => {
  it("a valid GRADED response passes strict parse and marks validation, with one call inside the production envelope", async () => {
    enableGate();
    const { status, body, text } = await callRoute(openai);
    expect(status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(OPENAI_URL);
    expect(captured[0].init.redirect).toBe("error");
    expect(
      (captured[0].init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${OPENAI_KEY}`);
    const sent = JSON.parse(String(captured[0].init.body));
    expect(sent).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 1200,
      reasoning: { effort: "medium" },
      store: false,
    });
    expect(JSON.parse(sent.input)).toMatchObject({
      capability: "grade_controlled_assessment",
    });
    expect(body.evidence).toEqual({
      operation: "OPENAI_EXAMINER_SMOKE",
      surface: "LIVE_PROVIDER:OPENAI_EXAMINER",
      providerFamily: "OPENAI",
      adapterKind: "OPENAI_RESPONSES",
      profileRef: "EXAMINER_COMMERCIAL_V1",
      modelId: "gpt-5.6-luna",
      runtimeOutcome: "SUCCEEDED",
      runtimeDetail: null,
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 300,
        outputTokens: 40,
        // ceil((300 * 200000 + 40 * 1200000) / 1e6): the production tariff.
        estimatedCostMicrousd: 108,
        elapsedMs: expect.any(Number),
      },
      envelope: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxOutputTokens: 1200,
        maxEstimatedCostMicrousd: 50000,
        totalDeadlineMs: 15000,
      },
      withinEnvelope: true,
      examiner: {
        strictParsePassed: true,
        outcome: "GRADED",
        marksValidationPassed: true,
      },
      lab: null,
      operationsEngineer: null,
      verdict: "PASS",
      verdictReason: "EXAMINER_GRADED_VALID",
    });
    for (const secret of [
      OPENAI_KEY,
      ANTHROPIC_KEY,
      TOKEN,
      "marksAwarded",
      QUESTION_ID,
      "expectedAnswer",
      "Award 2 marks",
      "What is 2 + 3?",
    ])
      expect(text).not.toContain(secret);
  });

  it("a valid ESCALATE is a valid strict Examiner outcome, not malformed", async () => {
    enableGate();
    openAIReply = openAIText(JSON.stringify({ outcome: "ESCALATE" }));
    const { body } = await callRoute(openai);
    expect(body.evidence).toMatchObject({
      verdict: "PASS",
      verdictReason: "EXAMINER_ESCALATE_VALID",
      examiner: {
        strictParsePassed: true,
        outcome: "ESCALATE",
        marksValidationPassed: null,
      },
    });
  });

  it("invalid Examiner JSON is not accepted and never echoed", async () => {
    enableGate();
    openAIReply = openAIText(
      'RAW-EXAMINER-SENTINEL ```json {"outcome":"GRADED","marks":[]}```',
    );
    const { body, text } = await callRoute(openai);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "SUCCEEDED",
      verdict: "FAIL",
      verdictReason: "EXAMINER_OUTPUT_INVALID",
      examiner: { strictParsePassed: false, outcome: null },
    });
    expect(text).not.toContain("RAW-EXAMINER-SENTINEL");
  });

  it("strict schema extras (e.g. a rationale field) are not accepted", async () => {
    enableGate();
    openAIReply = openAIText(
      JSON.stringify({ outcome: "ESCALATE", rationale: "RAW-RATIONALE" }),
    );
    const { body, text } = await callRoute(openai);
    expect(body.evidence.verdictReason).toBe("EXAMINER_OUTPUT_INVALID");
    expect(text).not.toContain("RAW-RATIONALE");
  });

  for (const [label, marks] of [
    [
      "above the authoritative maxMarks",
      [{ questionId: QUESTION_ID, marksAwarded: 3 }],
    ],
    [
      "for an unknown question",
      [{ questionId: "5a1e0000-0000-4000-8000-00000000ffff", marksAwarded: 1 }],
    ],
    ["missing the answered question", []],
    [
      "duplicating the answered question",
      [
        { questionId: QUESTION_ID, marksAwarded: 1 },
        { questionId: QUESTION_ID, marksAwarded: 1 },
      ],
    ],
  ] as const) {
    it(`GRADED marks ${label} are not accepted`, async () => {
      enableGate();
      openAIReply = openAIText(JSON.stringify({ outcome: "GRADED", marks }));
      const { body } = await callRoute(openai);
      expect(body.evidence).toMatchObject({
        verdict: "FAIL",
        verdictReason: "EXAMINER_MARKS_INVALID",
        examiner: {
          strictParsePassed: true,
          outcome: "GRADED",
          marksValidationPassed: false,
        },
      });
    });
  }

  it("a provider error maps to the bounded failure vocabulary, is not retried and never echoes the provider body", async () => {
    enableGate();
    openAIReply = () =>
      new Response(`upstream said: ${OPENAI_KEY} RAW-ERROR-SENTINEL`, {
        status: 503,
      });
    const { body, text } = await callRoute(openai);
    expect(captured).toHaveLength(1);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "FAILED",
      runtimeDetail: "PROVIDER_UNAVAILABLE",
      verdict: "FAIL",
      usage: { providerCalls: 1, attempts: 1 },
    });
    expect(text).not.toContain("RAW-ERROR-SENTINEL");
    expect(text).not.toContain(OPENAI_KEY);
  });

  it("output over the profile's token ceiling is BUDGET_BLOCKED post-call and fails", async () => {
    enableGate();
    openAIReply = openAIText(JSON.stringify({ outcome: "ESCALATE" }), {
      input: 300,
      output: 5000,
    });
    const { body } = await callRoute(openai);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "BUDGET_BLOCKED",
      runtimeDetail: "POST_CALL",
      verdict: "FAIL",
      withinEnvelope: false,
      examiner: null,
    });
    expect(captured).toHaveLength(1);
  });

  it("a missing OpenAI key BLOCKS only the OpenAI surface, with zero provider calls", async () => {
    enableGate();
    vi.stubEnv("OPENAI_API_KEY", "");
    const openaiResult = await callRoute(openai);
    expect(openaiResult.body.evidence).toMatchObject({
      verdict: "BLOCKED",
      verdictReason: "RUNTIME_ABSTAINED_NO_PROVIDER_CONFIGURED",
      usage: { providerCalls: 0 },
    });
    expect(fakeFetch).not.toHaveBeenCalled();
    const anthropicResult = await callRoute(anthropic);
    expect(anthropicResult.body.evidence.verdict).toBe("PASS");
    expect(captured.map((c) => c.url)).toEqual([ANTHROPIC_URL]);
  });

  it("never routes through the legacy ACADEMIC_PROVIDER_* gateway", async () => {
    enableGate();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ACADEMIC_PROVIDER_BASE_URL", "https://legacy.example.com/v1");
    vi.stubEnv("ACADEMIC_PROVIDER_API_KEY", "legacy-key");
    const { body } = await callRoute(openai);
    expect(body.evidence.verdict).toBe("BLOCKED");
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("live-provider acceptance: Anthropic Lab smoke through the production adapter/runtime", () => {
  it("a valid response passes the production bounded parser; only its length is returned", async () => {
    enableGate();
    const { status, body, text } = await callRoute(anthropic);
    expect(status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(ANTHROPIC_URL);
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    const sent = JSON.parse(String(captured[0].init.body));
    expect(sent).toMatchObject({ model: "claude-sonnet-5", max_tokens: 700 });
    expect(JSON.parse(sent.messages[0].content)).toMatchObject({
      capability: "tutor_lab_support",
      context: { role: "LAB_INSTRUCTOR" },
    });
    expect(body.evidence).toMatchObject({
      surface: "LIVE_PROVIDER:ANTHROPIC_LAB",
      adapterKind: "ANTHROPIC_MESSAGES",
      profileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      modelId: "claude-sonnet-5",
      runtimeOutcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 200,
        outputTokens: 50,
        // ceil((200 * 2000000 + 50 * 10000000) / 1e6)
        estimatedCostMicrousd: 900,
      },
      envelope: {
        maxProviderCalls: 1,
        maxOutputTokens: 700,
        maxEstimatedCostMicrousd: 40000,
        totalDeadlineMs: 15000,
      },
      withinEnvelope: true,
      examiner: null,
      lab: {
        outputLength:
          "RAW-LAB-OUTPUT-SENTINEL: start by comparing first letters.".length,
      },
      verdict: "PASS",
      verdictReason: "LAB_OUTPUT_ACCEPTED",
    });
    for (const secret of [
      "RAW-LAB-OUTPUT-SENTINEL",
      ANTHROPIC_KEY,
      OPENAI_KEY,
      TOKEN,
      "alphabetical",
    ])
      expect(text).not.toContain(secret);
  });

  it("an empty output fails the production bounded parser", async () => {
    enableGate();
    anthropicReply = anthropicText("");
    const { body } = await callRoute(anthropic);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "FAILED",
      runtimeDetail: "PROVIDER_INVALID_RESPONSE",
      verdict: "FAIL",
    });
  });

  it("a rate-limit is not retried beyond the profile's single attempt", async () => {
    enableGate();
    anthropicReply = () => new Response("slow down", { status: 429 });
    const { body } = await callRoute(anthropic);
    expect(captured).toHaveLength(1);
    expect(body.evidence).toMatchObject({
      runtimeDetail: "PROVIDER_RATE_LIMITED",
      verdict: "FAIL",
      usage: { providerCalls: 1, attempts: 1 },
    });
  });

  it("a missing Anthropic key BLOCKS only the Anthropic surface", async () => {
    enableGate();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await callRoute(anthropic)).body.evidence.verdict).toBe("BLOCKED");
    expect(fakeFetch).not.toHaveBeenCalled();
    expect((await callRoute(openai)).body.evidence.verdict).toBe("PASS");
    expect(captured.map((c) => c.url)).toEqual([OPENAI_URL]);
  });
});

describe("live-provider acceptance: no duplicated trust-critical provider logic", () => {
  const driver = readFileSync(
    "src/server/live-provider-acceptance-driver.ts",
    "utf8",
  );
  const route = readFileSync(
    "src/app/api/acceptance/live-provider/route.ts",
    "utf8",
  );
  const script = readFileSync("scripts/acceptance/live-provider.mjs", "utf8");
  it("builds no provider request, tariff or response schema of its own", () => {
    for (const source of [driver, route, script]) {
      expect(source).not.toContain("api.openai.com");
      expect(source).not.toContain("api.anthropic.com");
      expect(source).not.toContain("max_output_tokens");
      expect(source).not.toContain("x-api-key");
      expect(source).not.toContain("MicrousdPerMillionTokens");
    }
    expect(driver).not.toMatch(/\bfetch\(/);
    expect(route).not.toMatch(/\bfetch\(/);
    expect(driver).toContain("runGovernedProviderExecution");
    expect(driver).toContain("resolveAdapterForProfile");
    expect(driver).toContain("parseExaminerAssessmentProviderOutput");
    expect(driver).toContain("validateExaminerAssessmentMarks");
    expect(driver).toContain("resolvePlatformRuntimeProfile");
  });

  it("never force-casts the platform role into the academic AgentRole", () => {
    expect(driver).not.toMatch(/as\s+(unknown\s+as\s+)?AgentRole/);
    expect(driver).not.toMatch(/OPERATIONS_ENGINEER"\s+as\b/);
  });
});

// ---------------------------------------------------------------------------
// V2 corrections.
// ---------------------------------------------------------------------------
type SmokeOperation = keyof typeof LIVE_PROVIDER_SMOKE_PLANS;

describe("live-provider acceptance: the exact one-call execution envelope is pinned before provider work", () => {
  it("each plan pins exactly the current production profile's envelope (and OpenAI reasoning effort)", () => {
    for (const plan of Object.values(LIVE_PROVIDER_SMOKE_PLANS)) {
      const profile = resolveRuntimeProfile(plan.profileRef)!;
      expect(plan.envelope).toEqual({
        maxProviderCalls: profile.budgetPolicy.maxProviderCalls,
        maxAttempts: profile.budgetPolicy.maxAttempts,
        maxOutputTokens: profile.budgetPolicy.maxOutputTokens,
        maxEstimatedCostMicrousd: profile.budgetPolicy.maxEstimatedCostMicrousd,
        totalDeadlineMs: profile.budgetPolicy.totalDeadlineMs,
      });
      expect(plan.envelope.maxProviderCalls).toBe(1);
      expect(plan.envelope.maxAttempts).toBe(1);
    }
    expect(
      LIVE_PROVIDER_SMOKE_PLANS.OPENAI_EXAMINER_SMOKE.reasoningEffort,
    ).toBe("medium");
    expect(LIVE_PROVIDER_SMOKE_PLANS.ANTHROPIC_LAB_SMOKE.reasoningEffort).toBe(
      null,
    );
  });

  const drifts: [
    SmokeOperation,
    string,
    (p: RuntimeProfile) => RuntimeProfile,
  ][] = [
    [
      "OPENAI_EXAMINER_SMOKE",
      "maxAttempts 2",
      (p) => ({ ...p, budgetPolicy: { ...p.budgetPolicy, maxAttempts: 2 } }),
    ],
    [
      "OPENAI_EXAMINER_SMOKE",
      "maxProviderCalls 2",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxProviderCalls: 2 },
      }),
    ],
    [
      "OPENAI_EXAMINER_SMOKE",
      "maxOutputTokens 5000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxOutputTokens: 5000 },
      }),
    ],
    [
      "OPENAI_EXAMINER_SMOKE",
      "reasoningEffort high",
      (p) =>
        p.adapterKind === "OPENAI_RESPONSES"
          ? {
              ...p,
              providerConfig: { ...p.providerConfig, reasoningEffort: "high" },
            }
          : p,
    ],
    [
      "ANTHROPIC_LAB_SMOKE",
      "maxAttempts 2",
      (p) => ({ ...p, budgetPolicy: { ...p.budgetPolicy, maxAttempts: 2 } }),
    ],
    [
      "ANTHROPIC_LAB_SMOKE",
      "maxProviderCalls 2",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxProviderCalls: 2 },
      }),
    ],
    [
      "ANTHROPIC_LAB_SMOKE",
      "maxEstimatedCostMicrousd 90000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxEstimatedCostMicrousd: 90_000 },
      }),
    ],
    [
      "ANTHROPIC_LAB_SMOKE",
      "totalDeadlineMs 60000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, totalDeadlineMs: 60_000 },
      }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "maxAttempts 2",
      (p) => ({ ...p, budgetPolicy: { ...p.budgetPolicy, maxAttempts: 2 } }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "maxProviderCalls 2",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxProviderCalls: 2 },
      }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "maxOutputTokens 4000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxOutputTokens: 4000 },
      }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "maxEstimatedCostMicrousd 500000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, maxEstimatedCostMicrousd: 500_000 },
      }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "totalDeadlineMs 60000",
      (p) => ({
        ...p,
        budgetPolicy: { ...p.budgetPolicy, totalDeadlineMs: 60_000 },
      }),
    ],
    [
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "model claude-sonnet-5",
      (p) =>
        p.adapterKind === "ANTHROPIC_MESSAGES"
          ? {
              ...p,
              providerConfig: { ...p.providerConfig, model: "claude-sonnet-5" },
            }
          : p,
    ],
  ];
  for (const [operation, label, change] of drifts) {
    it(`${operation}: correct profile/model but drifted ${label} is PROFILE_MISMATCH with no adapter, runtime or provider reached`, async () => {
      enableGate();
      const plan = LIVE_PROVIDER_SMOKE_PLANS[operation];
      const profile = change(resolveRuntimeProfile(plan.profileRef)!);
      expect(profile.ref).toBe(plan.profileRef);
      const resolveAdapter = vi.fn(resolveAdapterForProfile);
      const execute = vi.fn(runGovernedProviderExecution);
      const evidence = await runLiveProviderSmoke(operation, {
        resolveProfile: () => profile,
        resolvePlatformProfile: () => profile,
        resolveAdapter,
        execute,
      });
      expect(evidence).toMatchObject({
        verdict: "FAIL",
        verdictReason: "PROFILE_MISMATCH",
        runtimeOutcome: "NOT_EXECUTED",
        usage: { providerCalls: 0, attempts: 0 },
      });
      expect(resolveAdapter).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  }
});

describe("live-provider acceptance: PASS proves exactly one provider request", () => {
  function deps(usage: {
    providerCalls: number;
    attempts: number;
  }): LiveProviderSmokeDeps {
    const result: RuntimeResult = {
      outcome: "SUCCEEDED",
      usage: {
        ...usage,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 1,
        elapsedMs: 5,
      },
      response: {
        outputText: JSON.stringify({ outcome: "ESCALATE" }),
        usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicrousd: 1 },
      },
    };
    return {
      resolveProfile: (role, ref) => resolveRoleBoundRuntimeProfile(role, ref),
      resolvePlatformProfile: (role) => resolvePlatformRuntimeProfile(role),
      resolveAdapter: () => null,
      execute: async () => result,
    };
  }

  for (const operation of [
    "OPENAI_EXAMINER_SMOKE",
    "ANTHROPIC_LAB_SMOKE",
    "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
  ] as const) {
    it(`${operation}: an otherwise-PASS result with providerCalls=0 is FAIL`, async () => {
      expect(
        await runLiveProviderSmoke(
          operation,
          deps({ providerCalls: 0, attempts: 1 }),
        ),
      ).toMatchObject({
        verdict: "FAIL",
        verdictReason: "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
      });
    });
    it(`${operation}: an otherwise-PASS result with attempts=0 is FAIL`, async () => {
      expect(
        await runLiveProviderSmoke(
          operation,
          deps({ providerCalls: 1, attempts: 0 }),
        ),
      ).toMatchObject({
        verdict: "FAIL",
        verdictReason: "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
      });
    });
    it(`${operation}: providerCalls=1 and attempts=1 is allowed to PASS`, async () => {
      expect(
        (
          await runLiveProviderSmoke(
            operation,
            deps({ providerCalls: 1, attempts: 1 }),
          )
        ).verdict,
      ).toBe("PASS");
    });
    it(`${operation}: more than one call remains FAIL`, async () => {
      expect(
        (
          await runLiveProviderSmoke(
            operation,
            deps({ providerCalls: 2, attempts: 2 }),
          )
        ).verdict,
      ).toBe("FAIL");
    });
  }
});

describe("live-provider acceptance: the synthetic Lab reason follows the production authority", () => {
  it("uses PRACTICAL_HELP, a reason the existing TUTOR_LAB_ALLOWED_REASONS admits for LAB_INSTRUCTOR and not a Tutor-only reason", async () => {
    expect(SYNTHETIC_LAB_CONTEXT.reasonCode).toBe("PRACTICAL_HELP");
    const labReasons: readonly string[] =
      TUTOR_LAB_ALLOWED_REASONS.LAB_INSTRUCTOR;
    const tutorReasons: readonly string[] = TUTOR_LAB_ALLOWED_REASONS.TUTOR;
    expect(labReasons).toContain(SYNTHETIC_LAB_CONTEXT.reasonCode);
    expect(tutorReasons).not.toContain(SYNTHETIC_LAB_CONTEXT.reasonCode);
    enableGate();
    await callRoute(anthropic);
    const sent = JSON.parse(String(captured[0].init.body));
    expect(JSON.parse(sent.messages[0].content).context.reasonCode).toBe(
      "PRACTICAL_HELP",
    );
  });
});

// ---------------------------------------------------------------------------
// Operations Engineer (OPERATIONS_ENGINEER_PLATFORM_V1 / claude-opus-5-5).
// ---------------------------------------------------------------------------
const OPS_RAW_OUTPUT =
  "RAW-OPS-OUTPUT-SENTINEL: rerun the synthetic job with verbose logging.";

describe("live-provider acceptance: Operations Engineer surface maps exactly to the platform profile", () => {
  const plan = LIVE_PROVIDER_SMOKE_PLANS.ANTHROPIC_OPERATIONS_ENGINEER_SMOKE;

  it("pins OPERATIONS_ENGINEER_PLATFORM_V1 / ANTHROPIC_MESSAGES / claude-opus-5-5 with no reasoning effort", () => {
    expect(plan).toMatchObject({
      surface: "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER",
      providerFamily: "ANTHROPIC",
      profilePlane: "PLATFORM",
      role: "OPERATIONS_ENGINEER",
      capability: "read_system_health",
      profileRef: "OPERATIONS_ENGINEER_PLATFORM_V1",
      adapterKind: "ANTHROPIC_MESSAGES",
      modelId: "claude-opus-5-5",
      reasoningEffort: null,
    });
  });

  it("pins the exact one-call budget envelope: calls 1, attempts 1, output 1200, cost 100000, deadline 20000", () => {
    expect(plan.envelope).toEqual({
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: 1200,
      maxEstimatedCostMicrousd: 100_000,
      totalDeadlineMs: 20_000,
    });
  });

  it("the production platform resolver returns exactly the registry profile the plan pins", () => {
    const profile = resolvePlatformRuntimeProfile("OPERATIONS_ENGINEER");
    expect(profile).toBe(
      resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1"),
    );
    expect(profile?.ref).toBe("OPERATIONS_ENGINEER_PLATFORM_V1");
    expect(profile?.adapterKind).toBe("ANTHROPIC_MESSAGES");
    expect(
      profile?.adapterKind === "ANTHROPIC_MESSAGES" &&
        profile.providerConfig.model,
    ).toBe("claude-opus-5-5");
    expect(profile?.budgetPolicy).toMatchObject(plan.envelope);
  });

  it("the platform profile is unreachable through the academic role-bound resolver", () => {
    for (const role of agentRoleSchema.options)
      expect(
        resolveRoleBoundRuntimeProfile(role, "OPERATIONS_ENGINEER_PLATFORM_V1"),
      ).toBeNull();
  });

  it("uses an existing observation capability from the Operations Engineer catalogue", () => {
    expect(isOperationsEngineerCapabilityAllowed(plan.capability)).toBe(true);
    expect(
      (operationsEngineerCapabilityCatalogue as readonly string[]).includes(
        plan.capability,
      ),
    ).toBe(true);
    expect(
      (OPERATIONS_ENGINEER_PROHIBITED_SCOPES as readonly string[]).includes(
        plan.capability,
      ),
    ).toBe(false);
  });

  it("the synthetic context is tiny, labelled demo content with no obvious real-user or secret data", () => {
    const text = JSON.stringify(SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT);
    expect(Buffer.byteLength(text)).toBeLessThan(2000);
    expect(SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT.label).toMatch(/demo content/);
    expect(SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT.systemStatus).toBe(
      "SYNTHETIC",
    );
    for (const pattern of [
      /@/, // e-mail addresses
      /https?:\/\//i,
      /postgres(ql)?:\/\//i,
      /\bsk[-_]/i,
      /\bghp_/i,
      /\bey[A-Za-z0-9_-]{10,}/, // JWT-shaped
      /[0-9a-f]{32,}/i, // long hex (keys/tokens)
      /api[_-]?key|secret|password|token|credential|service[_-]?role/i,
      /learner|student|customer|enrol/i,
      /supabase|stripe|github/i,
    ])
      expect(text).not.toMatch(pattern);
  });

  it("the platform resolver -- never the academic resolver -- is used, and the academic surfaces never use the platform resolver", async () => {
    const execute = vi.fn(async (): Promise<RuntimeResult> => ({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostMicrousd: 1,
        elapsedMs: 5,
      },
      response: {
        outputText: JSON.stringify({ outcome: "ESCALATE" }),
        usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicrousd: 1 },
      },
    }));
    const resolveProfile = vi.fn(resolveRoleBoundRuntimeProfile);
    const resolvePlatformProfile = vi.fn(resolvePlatformRuntimeProfile);
    const deps: LiveProviderSmokeDeps = {
      resolveProfile: (role, ref) => resolveProfile(role, ref),
      resolvePlatformProfile: (role) => resolvePlatformProfile(role),
      resolveAdapter: () => null,
      execute,
    };
    const evidence = await runLiveProviderSmoke(
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      deps,
    );
    expect(evidence.verdict).toBe("PASS");
    expect(resolvePlatformProfile).toHaveBeenCalledTimes(1);
    expect(resolvePlatformProfile).toHaveBeenCalledWith("OPERATIONS_ENGINEER");
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toEqual([
      null,
      {
        role: "OPERATIONS_ENGINEER",
        capability: "read_system_health",
        context: SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT,
      },
      resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1")!.budgetPolicy,
    ]);

    resolvePlatformProfile.mockClear();
    for (const operation of [
      "OPENAI_EXAMINER_SMOKE",
      "ANTHROPIC_LAB_SMOKE",
    ] as const)
      await runLiveProviderSmoke(operation, deps);
    expect(resolveProfile).toHaveBeenCalledTimes(2);
    expect(resolvePlatformProfile).not.toHaveBeenCalled();
  });

  for (const [label, resolved] of [
    ["the platform resolver returns null", () => null],
    [
      "the platform resolver returns the Lab (Sonnet) profile",
      () => resolveRuntimeProfile("LAB_INSTRUCTOR_COMMERCIAL_V1"),
    ],
    [
      "the platform resolver returns the Counsellor profile",
      () => resolveRuntimeProfile("COUNSELLOR_PLATFORM_V1"),
    ],
  ] as const) {
    it(`PROFILE_MISMATCH with no adapter, runtime or provider when ${label}`, async () => {
      enableGate();
      const resolveAdapter = vi.fn(resolveAdapterForProfile);
      const execute = vi.fn(runGovernedProviderExecution);
      const evidence = await runLiveProviderSmoke(
        "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
        {
          resolveProfile: () =>
            resolveRuntimeProfile("OPERATIONS_ENGINEER_PLATFORM_V1"),
          resolvePlatformProfile: resolved,
          resolveAdapter,
          execute,
        },
      );
      expect(evidence).toMatchObject({
        verdict: "FAIL",
        verdictReason: "PROFILE_MISMATCH",
        runtimeOutcome: "NOT_EXECUTED",
        usage: { providerCalls: 0, attempts: 0 },
        operationsEngineer: null,
      });
      expect(resolveAdapter).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  }
});

describe("live-provider acceptance: Operations Engineer smoke through the production adapter/runtime", () => {
  it("a valid Opus response passes the production bounded parser; only its length is returned, in the Operations Engineer field", async () => {
    enableGate();
    anthropicReply = anthropicText(OPS_RAW_OUTPUT);
    const { status, body, text } = await callRoute(opsEngineer);
    expect(status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(ANTHROPIC_URL);
    expect(captured[0].init.redirect).toBe("error");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    const sent = JSON.parse(String(captured[0].init.body));
    expect(sent).toMatchObject({ model: "claude-opus-5-5", max_tokens: 1200 });
    expect(JSON.parse(sent.messages[0].content)).toEqual({
      capability: "read_system_health",
      context: SYNTHETIC_OPERATIONS_ENGINEER_CONTEXT,
    });
    expect(body).toEqual({
      ok: true,
      evidence: {
        operation: "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
        surface: "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER",
        providerFamily: "ANTHROPIC",
        adapterKind: "ANTHROPIC_MESSAGES",
        profileRef: "OPERATIONS_ENGINEER_PLATFORM_V1",
        modelId: "claude-opus-5-5",
        runtimeOutcome: "SUCCEEDED",
        runtimeDetail: null,
        usage: {
          providerCalls: 1,
          attempts: 1,
          inputTokens: 200,
          outputTokens: 50,
          // ceil((200 * 4000000 + 50 * 20000000) / 1e6): the registry tariff.
          estimatedCostMicrousd: 1800,
          elapsedMs: expect.any(Number),
        },
        envelope: {
          maxProviderCalls: 1,
          maxAttempts: 1,
          maxOutputTokens: 1200,
          maxEstimatedCostMicrousd: 100000,
          totalDeadlineMs: 20000,
        },
        withinEnvelope: true,
        examiner: null,
        lab: null,
        operationsEngineer: { outputLength: OPS_RAW_OUTPUT.length },
        verdict: "PASS",
        verdictReason: "OPERATIONS_ENGINEER_OUTPUT_ACCEPTED",
      },
    });
    for (const secret of [
      "RAW-OPS-OUTPUT-SENTINEL",
      "verbose logging",
      ANTHROPIC_KEY,
      OPENAI_KEY,
      TOKEN,
      "synthetic-nightly-report",
      "diagnostic next step",
    ])
      expect(text).not.toContain(secret);
  });

  it("the Lab surface keeps its own evidence field and never fills the Operations Engineer field", async () => {
    enableGate();
    const { body } = await callRoute(anthropic);
    expect(body.evidence).toMatchObject({
      verdictReason: "LAB_OUTPUT_ACCEPTED",
      lab: { outputLength: expect.any(Number) },
      operationsEngineer: null,
    });
    const examiner = await callRoute(openai);
    expect(examiner.body.evidence.operationsEngineer).toBeNull();
  });

  it("an empty output fails the production bounded parser", async () => {
    enableGate();
    anthropicReply = anthropicText("");
    const { body } = await callRoute(opsEngineer);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "FAILED",
      runtimeDetail: "PROVIDER_INVALID_RESPONSE",
      verdict: "FAIL",
      operationsEngineer: null,
    });
  });

  it("output over 1200 tokens is BUDGET_BLOCKED post-call and fails", async () => {
    enableGate();
    anthropicReply = anthropicText(OPS_RAW_OUTPUT, {
      input: 200,
      output: 5000,
    });
    const { body, text } = await callRoute(opsEngineer);
    expect(captured).toHaveLength(1);
    expect(body.evidence).toMatchObject({
      runtimeOutcome: "BUDGET_BLOCKED",
      verdict: "FAIL",
      withinEnvelope: false,
      operationsEngineer: null,
    });
    expect(text).not.toContain("RAW-OPS-OUTPUT-SENTINEL");
  });

  it("a rate-limit is not retried beyond the profile's single attempt and never echoes the provider body", async () => {
    enableGate();
    anthropicReply = () =>
      new Response(`slow down ${ANTHROPIC_KEY} RAW-ERROR-SENTINEL`, {
        status: 429,
      });
    const { body, text } = await callRoute(opsEngineer);
    expect(captured).toHaveLength(1);
    expect(body.evidence).toMatchObject({
      runtimeDetail: "PROVIDER_RATE_LIMITED",
      verdict: "FAIL",
      usage: { providerCalls: 1, attempts: 1 },
    });
    expect(text).not.toContain("RAW-ERROR-SENTINEL");
    expect(text).not.toContain(ANTHROPIC_KEY);
  });

  it("a missing Anthropic key BLOCKS with zero provider calls", async () => {
    enableGate();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { body } = await callRoute(opsEngineer);
    expect(body.evidence).toMatchObject({
      verdict: "BLOCKED",
      verdictReason: "RUNTIME_ABSTAINED_NO_PROVIDER_CONFIGURED",
      usage: { providerCalls: 0 },
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("the route gate still refuses the Operations Engineer operation with 404 before reading the body", async () => {
    enableGate();
    vi.stubEnv("NODE_ENV", "production");
    const req = request(opsEngineer);
    expect((await POST(req)).status).toBe(404);
    expect(req.bodyUsed).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
