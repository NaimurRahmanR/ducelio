import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  AUTHORIZE_FLAG,
  DRIVER_HEADER,
  EnvFileInspectionError,
  LIVE_PROVIDER_SURFACE_SELECTORS,
  ROUTE_PATH,
  TRUTHFULNESS_STATEMENT,
  WITHHELD_FROM_LIVE_PROVIDER_APP,
  buildLiveProviderChildEnv,
  planLiveProviderRun,
  readEnvFileNames,
  runLiveProviderAcceptance,
  sanitizeEvidence,
  LIVE_PROVIDER_SURFACES,
} from "../scripts/acceptance/live-provider.mjs";

// ============================================================================
// scripts/acceptance/live-provider.mjs -- `npm run acceptance:live-provider`.
// ZERO billable traffic: every run below injects a fake app process and a
// fake fetch that impersonates only the local acceptance route. No test
// here starts Next.js or reaches any provider.
// ============================================================================

const OPENAI_KEY = "sk-openai-driver-sentinel";
const ANTHROPIC_KEY = "sk-ant-driver-sentinel";
const [OPENAI_SURFACE, ANTHROPIC_SURFACE, OPS_SURFACE] = LIVE_PROVIDER_SURFACES;
// The fixed single-surface selectors an authorized paid run must name.
const SELECT_OPENAI = "--surface=OPENAI_EXAMINER";
const SELECT_LAB = "--surface=ANTHROPIC_LAB";
const SELECT_OPS = "--surface=ANTHROPIC_OPERATIONS_ENGINEER";

const SECRET_SENTINELS = {
  ACCEPTANCE_DATABASE_URL: "postgres://user:db-sentinel@db.example.com/x",
  ACCEPTANCE_WRITE_ENABLED: "true",
  ACCEPTANCE_ENVIRONMENT_ID: "a0000000-0000-4000-8000-000000000001",
  ACCEPTANCE_ADMIN_EMAIL: "admin@acceptance.test",
  ACCEPTANCE_ADMIN_PASSWORD: "admin-password-sentinel",
  ACCEPTANCE_LEARNER_EMAIL: "learner@acceptance.test",
  ACCEPTANCE_LEARNER_PASSWORD: "learner-password-sentinel",
  ACCEPTANCE_FOREIGN_LEARNER_PASSWORD: "foreign-password-sentinel",
  ACCEPTANCE_UNRELATED_STAFF_PASSWORD: "staff-password-sentinel",
  ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000002",
  ACADEMIC_EXECUTION_HMAC_KEY_HEX: "c".repeat(64),
  STRIPE_SECRET_KEY: "sk_test_stripe-sentinel",
  STRIPE_WEBHOOK_SECRET: "whsec_sentinel",
  COMMERCE_CONTROLLER_KEY_ID: "b0000000-0000-4000-8000-000000000003",
  COMMERCE_CONTROLLER_HMAC_KEY_HEX: "d".repeat(64),
  ACADEMIC_PROVIDER_BASE_URL: "https://legacy.example.com/v1",
  ACADEMIC_PROVIDER_API_KEY: "legacy-key-sentinel",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-sentinel",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
  GITHUB_TOKEN: "ghp_token-sentinel",
  NODE_OPTIONS: "--import=file:///evil-preload.mjs",
};

function authorizedEnv(extra: Record<string, string> = {}) {
  return {
    PATH: "/usr/bin",
    ...SECRET_SENTINELS,
    ACCEPTANCE_LIVE_PROVIDER_OPT_IN: "true",
    OPENAI_API_KEY: OPENAI_KEY,
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    ...extra,
  };
}

function evidenceFor(
  surface: (typeof LIVE_PROVIDER_SURFACES)[number],
  overrides: Record<string, unknown> = {},
) {
  const openai = surface.operation === "OPENAI_EXAMINER_SMOKE";
  const ops = surface.operation === "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE";
  return {
    operation: surface.operation,
    surface: surface.surface,
    providerFamily: surface.providerFamily,
    adapterKind: surface.adapterKind,
    profileRef: surface.profileRef,
    modelId: surface.modelId,
    runtimeOutcome: "SUCCEEDED",
    runtimeDetail: null,
    usage: {
      providerCalls: 1,
      attempts: 1,
      inputTokens: 300,
      outputTokens: 40,
      estimatedCostMicrousd: 108,
      elapsedMs: 900,
    },
    envelope: {
      maxProviderCalls: 1,
      maxAttempts: 1,
      maxOutputTokens: openai || ops ? 1200 : 700,
      maxEstimatedCostMicrousd: ops ? 100000 : openai ? 50000 : 40000,
      totalDeadlineMs: ops ? 20000 : 15000,
    },
    withinEnvelope: true,
    examiner: openai
      ? {
          strictParsePassed: true,
          outcome: "GRADED",
          marksValidationPassed: true,
        }
      : null,
    lab: openai || ops ? null : { outputLength: 120 },
    operationsEngineer: ops ? { outputLength: 160 } : null,
    verdict: "PASS",
    verdictReason: ops
      ? "OPERATIONS_ENGINEER_OUTPUT_ACCEPTED"
      : openai
        ? "EXAMINER_GRADED_VALID"
        : "LAB_OUTPUT_ACCEPTED",
    ...overrides,
  };
}

type RouteReply = { status: number; body: unknown } | "throw";
type Result = {
  surface: string;
  status: string;
  reason: string;
  details?: string[];
};
type CallBody = { operation?: string };

// A fake loopback app: a readiness probe ({}) gets 400 (gate passed,
// strict input refused); each operation gets the scripted reply.
function fakeApp(
  replies: Partial<Record<string, RouteReply>> = {},
  readiness = 400,
) {
  const childEnvs: Record<string, string>[] = [];
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: CallBody;
  }[] = [];
  const startApp = vi.fn((env: Record<string, string>) => {
    childEnvs.push(env);
    return { exitCode: null, pid: 0 };
  });
  const stopApp = vi.fn(async () => {});
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body,
    });
    if (!body.operation)
      return new Response(JSON.stringify({ error: "INVALID_REQUEST" }), {
        status: readiness,
      });
    const reply =
      replies[body.operation] ??
      ({
        status: 200,
        body: {
          ok: true,
          evidence: evidenceFor(
            LIVE_PROVIDER_SURFACES.find(
              (s: { operation: string }) => s.operation === body.operation,
            )!,
          ),
        },
      } as RouteReply);
    if (reply === "throw") throw new Error("socket hang up");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  const operationCalls = () => calls.filter((c) => c.body.operation);
  return { startApp, stopApp, fetchImpl, childEnvs, calls, operationCalls };
}

async function run(
  env: Record<string, string>,
  argv: string[],
  app = fakeApp(),
) {
  const outcome = await runLiveProviderAcceptance({
    env,
    argv,
    startApp: app.startApp,
    stopApp: app.stopApp,
    fetchImpl: app.fetchImpl,
    envFileNames: [],
    readinessPollMs: 1,
    readinessTimeoutMs: 1000,
  });
  return {
    results: outcome.results as (Result & { details: string[] })[],
    providerRequestsMade: outcome.providerRequestsMade as number | null,
    app,
  };
}

function noSecretsIn(value: unknown) {
  const text = JSON.stringify(value);
  // ACCEPTANCE_WRITE_ENABLED's "true" is a flag, not a secret.
  for (const [name, secret] of [
    ["OPENAI_API_KEY", OPENAI_KEY],
    ["ANTHROPIC_API_KEY", ANTHROPIC_KEY],
    ...Object.entries(SECRET_SENTINELS),
  ])
    if (name !== "ACCEPTANCE_WRITE_ENABLED") expect(text).not.toContain(secret);
}

describe("live-provider driver: explicit double authorization", () => {
  it("with neither the env opt-in nor the CLI flag: every surface BLOCKED, no server, zero requests", async () => {
    const env = authorizedEnv();
    delete (env as Record<string, string>).ACCEPTANCE_LIVE_PROVIDER_OPT_IN;
    const { results, providerRequestsMade, app } = await run(env, []);
    expect(results.map((r: Result) => [r.surface, r.status, r.reason])).toEqual(
      [
        [OPENAI_SURFACE.surface, "BLOCKED", "EXPLICIT_AUTHORIZATION_REQUIRED"],
        [
          ANTHROPIC_SURFACE.surface,
          "BLOCKED",
          "EXPLICIT_AUTHORIZATION_REQUIRED",
        ],
        [OPS_SURFACE.surface, "BLOCKED", "EXPLICIT_AUTHORIZATION_REQUIRED"],
      ],
    );
    expect(providerRequestsMade).toBe(0);
    expect(app.startApp).not.toHaveBeenCalled();
    expect(app.fetchImpl).not.toHaveBeenCalled();
    noSecretsIn(results);
  });

  it("the CLI flag alone is insufficient", async () => {
    const env = authorizedEnv();
    delete (env as Record<string, string>).ACCEPTANCE_LIVE_PROVIDER_OPT_IN;
    const { results, app } = await run(env, [AUTHORIZE_FLAG, SELECT_OPS]);
    expect(results.every((r: Result) => r.status === "BLOCKED")).toBe(true);
    expect(results[0].details.join(" ")).toContain(
      "ACCEPTANCE_LIVE_PROVIDER_OPT_IN is not exactly 'true'",
    );
    expect(app.startApp).not.toHaveBeenCalled();
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it("the env opt-in alone is insufficient, even with a surface selected", async () => {
    const { results, app } = await run(authorizedEnv(), [SELECT_OPS]);
    expect(results.every((r: Result) => r.status === "BLOCKED")).toBe(true);
    expect(results[0].details.join(" ")).toContain(
      `The ${AUTHORIZE_FLAG} command-line flag was not given.`,
    );
    expect(app.startApp).not.toHaveBeenCalled();
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it("an opt-in that is not exactly 'true' is insufficient even with the flag", async () => {
    for (const value of ["TRUE", "yes", " true", "1"]) {
      const { results, app } = await run(
        authorizedEnv({ ACCEPTANCE_LIVE_PROVIDER_OPT_IN: value }),
        [AUTHORIZE_FLAG, SELECT_LAB],
      );
      expect(results.every((r: Result) => r.status === "BLOCKED")).toBe(true);
      expect(app.startApp).not.toHaveBeenCalled();
    }
  });

  it("an unrecognized argument BLOCKS without echoing it (it might be a pasted key)", async () => {
    const { results, app } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
      SELECT_LAB,
      "sk-pasted-key-sentinel",
    ]);
    expect(
      results.every((r: Result) => r.reason === "UNRECOGNIZED_ARGUMENT"),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("sk-pasted-key-sentinel");
    expect(app.startApp).not.toHaveBeenCalled();
  });

  it("a selected surface whose key is missing BLOCKS on its own; nothing starts and no other surface runs instead", async () => {
    const env = authorizedEnv({ OPENAI_API_KEY: "  " });
    const { results, app, providerRequestsMade } = await run(env, [
      AUTHORIZE_FLAG,
      SELECT_OPENAI,
    ]);
    expect(results.map((r: Result) => [r.surface, r.status, r.reason])).toEqual(
      [
        [
          OPENAI_SURFACE.surface,
          "BLOCKED",
          "OPENAI_API_KEY is not configured.",
        ],
        [ANTHROPIC_SURFACE.surface, "NOT_RUN", "NOT_SELECTED"],
        [OPS_SURFACE.surface, "NOT_RUN", "NOT_SELECTED"],
      ],
    );
    expect(app.startApp).not.toHaveBeenCalled();
    expect(app.fetchImpl).not.toHaveBeenCalled();
    expect(providerRequestsMade).toBe(0);
  });

  it("a missing OpenAI key does not affect a selected Anthropic surface, and the child never receives the OpenAI key", async () => {
    const env = authorizedEnv({ OPENAI_API_KEY: "  " });
    const { results, app, providerRequestsMade } = await run(env, [
      AUTHORIZE_FLAG,
      SELECT_LAB,
    ]);
    expect(results.map((r: Result) => [r.surface, r.status])).toEqual([
      [OPENAI_SURFACE.surface, "NOT_RUN"],
      [ANTHROPIC_SURFACE.surface, "PASS"],
      [OPS_SURFACE.surface, "NOT_RUN"],
    ]);
    expect(app.operationCalls().map((c) => c.body)).toEqual([
      { operation: "ANTHROPIC_LAB_SMOKE" },
    ]);
    expect(app.childEnvs[0].OPENAI_API_KEY).toBe("");
    expect(app.childEnvs[0].ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
    expect(providerRequestsMade).toBe(1);
  });

  it("a missing Anthropic key BLOCKS a selected Anthropic surface; a selected OpenAI surface still runs", async () => {
    const env = authorizedEnv();
    delete (env as Record<string, string>).ANTHROPIC_API_KEY;
    for (const selector of [SELECT_LAB, SELECT_OPS]) {
      const blockedRun = await run(env, [AUTHORIZE_FLAG, selector]);
      expect(
        blockedRun.results.filter((r: Result) => r.status === "BLOCKED"),
      ).toEqual([
        expect.objectContaining({
          reason: "ANTHROPIC_API_KEY is not configured.",
        }),
      ]);
      expect(blockedRun.app.startApp).not.toHaveBeenCalled();
    }
    const { results, app } = await run(env, [AUTHORIZE_FLAG, SELECT_OPENAI]);
    expect(results.map((r: Result) => [r.surface, r.status])).toEqual([
      [OPENAI_SURFACE.surface, "PASS"],
      [ANTHROPIC_SURFACE.surface, "NOT_RUN"],
      [OPS_SURFACE.surface, "NOT_RUN"],
    ]);
    expect(app.operationCalls().map((c) => c.body)).toEqual([
      { operation: "OPENAI_EXAMINER_SMOKE" },
    ]);
    expect(app.childEnvs[0].ANTHROPIC_API_KEY).toBe("");
    expect(app.childEnvs[0].OPENAI_API_KEY).toBe(OPENAI_KEY);
  });

  it("with neither key, even fully authorized and selected, nothing starts", async () => {
    const env = authorizedEnv({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" });
    for (const selector of [SELECT_OPENAI, SELECT_LAB, SELECT_OPS]) {
      const { results, app, providerRequestsMade } = await run(env, [
        AUTHORIZE_FLAG,
        selector,
      ]);
      expect(
        results.every((r: Result) => ["BLOCKED", "NOT_RUN"].includes(r.status)),
      ).toBe(true);
      expect(app.startApp).not.toHaveBeenCalled();
      expect(providerRequestsMade).toBe(0);
    }
  });

  it("planLiveProviderRun never returns a key value", () => {
    for (const selector of [SELECT_OPENAI, SELECT_LAB, SELECT_OPS]) {
      const plan = planLiveProviderRun(authorizedEnv(), [
        AUTHORIZE_FLAG,
        selector,
      ]);
      expect(
        plan.filter((p: { runnable: boolean }) => p.runnable),
      ).toHaveLength(1);
      noSecretsIn(plan);
    }
  });
});

describe("live-provider driver: explicit single-surface selection", () => {
  type PlanEntry = {
    surface: string;
    selector: string;
    runnable: boolean;
    result: Result | null;
  };
  const plan = (env: Record<string, string>, argv: string[]) =>
    planLiveProviderRun(env, argv) as PlanEntry[];

  it("the selector allowlist is exactly the three fixed surfaces", () => {
    expect(LIVE_PROVIDER_SURFACE_SELECTORS).toEqual([
      "OPENAI_EXAMINER",
      "ANTHROPIC_LAB",
      "ANTHROPIC_OPERATIONS_ENGINEER",
    ]);
    expect(LIVE_PROVIDER_SURFACES.map((s: PlanEntry) => s.surface)).toEqual([
      "LIVE_PROVIDER:OPENAI_EXAMINER",
      "LIVE_PROVIDER:ANTHROPIC_LAB",
      "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER",
    ]);
    expect(OPS_SURFACE).toMatchObject({
      operation: "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      keyVar: "ANTHROPIC_API_KEY",
      providerFamily: "ANTHROPIC",
      adapterKind: "ANTHROPIC_MESSAGES",
      profileRef: "OPERATIONS_ENGINEER_PLATFORM_V1",
      modelId: "claude-opus-5-5",
    });
  });

  it("a fully authorized run with both keys but NO selector BLOCKS every surface; nothing starts", async () => {
    const { results, app, providerRequestsMade } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
    ]);
    expect(
      results.every(
        (r: Result) =>
          r.status === "BLOCKED" && r.reason === "SURFACE_SELECTION_REQUIRED",
      ),
    ).toBe(true);
    expect(results[0].details.join(" ")).toContain(
      "--surface=ANTHROPIC_OPERATIONS_ENGINEER",
    );
    expect(app.startApp).not.toHaveBeenCalled();
    expect(app.fetchImpl).not.toHaveBeenCalled();
    expect(providerRequestsMade).toBe(0);
  });

  it("an unknown selector BLOCKS every surface without echoing it", async () => {
    for (const bad of [
      "--surface=sk-ant-pasted-key-sentinel",
      "--surface=ANTHROPIC_OPS",
      "--surface=anthropic_lab",
      "--surface=OPERATIONS_ENGINEER",
      "--surface=ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
      "--surface=ALL",
      "--surface=",
      "--surface= ANTHROPIC_LAB",
    ]) {
      const { results, app } = await run(authorizedEnv(), [
        AUTHORIZE_FLAG,
        bad,
      ]);
      expect(
        results.every(
          (r: Result) =>
            r.status === "BLOCKED" && r.reason === "UNKNOWN_SURFACE_SELECTOR",
        ),
      ).toBe(true);
      expect(JSON.stringify(results)).not.toContain(
        "sk-ant-pasted-key-sentinel",
      );
      expect(JSON.stringify(results)).not.toContain('ANTHROPIC_OPS"');
      expect(app.startApp).not.toHaveBeenCalled();
    }
  });

  it("an unknown selector alongside a valid one still BLOCKS", async () => {
    const { results, app } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
      SELECT_LAB,
      "--surface=BOGUS",
    ]);
    expect(results.every((r: Result) => r.status === "BLOCKED")).toBe(true);
    expect(app.startApp).not.toHaveBeenCalled();
  });

  it("more than one selector -- even the same one twice -- BLOCKS every surface", async () => {
    for (const argv of [
      [AUTHORIZE_FLAG, SELECT_LAB, SELECT_OPS],
      [AUTHORIZE_FLAG, SELECT_OPS, SELECT_OPS],
      [AUTHORIZE_FLAG, SELECT_OPENAI, SELECT_LAB, SELECT_OPS],
    ]) {
      const { results, app } = await run(authorizedEnv(), argv);
      expect(
        results.every(
          (r: Result) =>
            r.status === "BLOCKED" && r.reason === "MULTIPLE_SURFACE_SELECTORS",
        ),
      ).toBe(true);
      expect(app.startApp).not.toHaveBeenCalled();
    }
  });

  it("the space-separated form is not a selector (fails closed as an unrecognized argument)", async () => {
    const { results, app } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
      "--surface",
      "ANTHROPIC_LAB",
    ]);
    expect(
      results.every((r: Result) => r.reason === "UNRECOGNIZED_ARGUMENT"),
    ).toBe(true);
    expect(app.startApp).not.toHaveBeenCalled();
  });

  it("a selector can never be supplied through the environment", async () => {
    const env = authorizedEnv({
      ACCEPTANCE_LIVE_PROVIDER_SURFACE: "ANTHROPIC_OPERATIONS_ENGINEER",
      LIVE_PROVIDER_SURFACE: "ANTHROPIC_OPERATIONS_ENGINEER",
      SURFACE: "ANTHROPIC_OPERATIONS_ENGINEER",
      // What npm sets for `npm run acceptance:live-provider --surface=X`
      // (flag given without `--`, so it never reaches argv).
      npm_config_surface: "ANTHROPIC_OPERATIONS_ENGINEER",
      npm_config_authorize_live_provider: "true",
    });
    const { results, app } = await run(env, [AUTHORIZE_FLAG]);
    expect(
      results.every((r: Result) => r.reason === "SURFACE_SELECTION_REQUIRED"),
    ).toBe(true);
    expect(app.startApp).not.toHaveBeenCalled();
    const noFlag = await run(env, [SELECT_OPS]);
    expect(
      noFlag.results.every(
        (r: Result) => r.reason === "EXPLICIT_AUTHORIZATION_REQUIRED",
      ),
    ).toBe(true);
    expect(noFlag.app.startApp).not.toHaveBeenCalled();
  });

  it("a configured key plus a selector is never itself authorization", async () => {
    const env = authorizedEnv();
    delete (env as Record<string, string>).ACCEPTANCE_LIVE_PROVIDER_OPT_IN;
    for (const selector of [SELECT_OPENAI, SELECT_LAB, SELECT_OPS]) {
      const { results, app } = await run(env, [selector]);
      expect(
        results.every(
          (r: Result) => r.reason === "EXPLICIT_AUTHORIZATION_REQUIRED",
        ),
      ).toBe(true);
      expect(app.startApp).not.toHaveBeenCalled();
    }
  });

  for (const [selector, surface, operation] of [
    [SELECT_OPENAI, "LIVE_PROVIDER:OPENAI_EXAMINER", "OPENAI_EXAMINER_SMOKE"],
    [SELECT_LAB, "LIVE_PROVIDER:ANTHROPIC_LAB", "ANTHROPIC_LAB_SMOKE"],
    [
      SELECT_OPS,
      "LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER",
      "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE",
    ],
  ] as const) {
    it(`${selector} makes exactly that one surface runnable and every other surface NOT_RUN`, async () => {
      const entries = plan(authorizedEnv(), [AUTHORIZE_FLAG, selector]);
      expect(entries.filter((p) => p.runnable).map((p) => p.surface)).toEqual([
        surface,
      ]);
      for (const p of entries.filter((e) => !e.runnable))
        expect(p.result).toMatchObject({
          status: "NOT_RUN",
          reason: "NOT_SELECTED",
        });
      const { results, app, providerRequestsMade } = await run(
        authorizedEnv(),
        [AUTHORIZE_FLAG, selector],
      );
      expect(app.operationCalls().map((c) => c.body)).toEqual([{ operation }]);
      expect(
        results
          .filter((r: Result) => r.status === "PASS")
          .map((r) => r.surface),
      ).toEqual([surface]);
      expect(providerRequestsMade).toBe(1);
    });
  }

  it("with ANTHROPIC_OPERATIONS_ENGINEER selected: only ANTHROPIC_API_KEY reaches the child, the OpenAI key stays blank and the Lab surface never runs", async () => {
    const { results, app, providerRequestsMade } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
      SELECT_OPS,
    ]);
    const child = app.childEnvs[0];
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(child.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
    expect(child.OPENAI_API_KEY).toBe("");
    for (const name of Object.keys(SECRET_SENTINELS))
      expect(child[name]).toBe("");
    expect(child.NODE_OPTIONS).toBe("");
    expect(app.operationCalls().map((c) => c.body)).toEqual([
      { operation: "ANTHROPIC_OPERATIONS_ENGINEER_SMOKE" },
    ]);
    expect(results.map((r: Result) => [r.surface, r.status, r.reason])).toEqual(
      [
        [OPENAI_SURFACE.surface, "NOT_RUN", "NOT_SELECTED"],
        [ANTHROPIC_SURFACE.surface, "NOT_RUN", "NOT_SELECTED"],
        [OPS_SURFACE.surface, "PASS", "OPERATIONS_ENGINEER_OUTPUT_ACCEPTED"],
      ],
    );
    expect(results[2].details).toContain("outputLength=160");
    expect(providerRequestsMade).toBe(1);
    noSecretsIn(results);
  });

  it("with only ANTHROPIC_API_KEY configured, no argument combination makes both Anthropic surfaces runnable", () => {
    const env = authorizedEnv({ OPENAI_API_KEY: "" });
    const tokens = [
      AUTHORIZE_FLAG,
      SELECT_OPENAI,
      SELECT_LAB,
      SELECT_OPS,
      "--surface=ALL",
    ];
    // Every ordered subset of up to four tokens.
    const argvs: string[][] = [[]];
    for (let depth = 0; depth < 4; depth++)
      for (const prefix of argvs.filter((a) => a.length === depth))
        for (const token of tokens) argvs.push([...prefix, token]);
    for (const argv of argvs) {
      const runnable = plan(env, argv).filter((p) => p.runnable);
      expect(runnable.length).toBeLessThanOrEqual(1);
    }
    for (const argv of argvs) {
      const runnable = plan(authorizedEnv(), argv).filter((p) => p.runnable);
      expect(runnable.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("live-provider driver: fully authorized run against a fake app", () => {
  it("sends a readiness probe plus exactly one operation for the selected surface, with a fresh per-run token", async () => {
    const { results, app, providerRequestsMade } = await run(authorizedEnv(), [
      AUTHORIZE_FLAG,
      SELECT_OPENAI,
    ]);
    expect(results.map((r: Result) => [r.surface, r.status])).toEqual([
      [OPENAI_SURFACE.surface, "PASS"],
      [ANTHROPIC_SURFACE.surface, "NOT_RUN"],
      [OPS_SURFACE.surface, "NOT_RUN"],
    ]);
    expect(app.operationCalls().map((c) => c.body)).toEqual([
      { operation: "OPENAI_EXAMINER_SMOKE" },
    ]);
    const env = app.childEnvs[0];
    const token = env.ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (const call of app.calls) {
      expect(call.url).toBe(`${env.APP_URL}${ROUTE_PATH}`);
      expect(call.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(call.headers[DRIVER_HEADER]).toBe(token);
      expect(call.headers).not.toHaveProperty("origin");
      // The caller sends an operation name and nothing else.
      expect(Object.keys(call.body).every((k) => k === "operation")).toBe(true);
    }
    expect(providerRequestsMade).toBe(1);
    expect(app.stopApp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results)).not.toContain(token);
    noSecretsIn(results);
    const second = await run(authorizedEnv(), [AUTHORIZE_FLAG, SELECT_OPENAI]);
    expect(
      second.app.childEnvs[0].ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN,
    ).not.toBe(token);
  });

  it("a FAIL verdict is reported as FAIL and never retried", async () => {
    const app = fakeApp({
      OPENAI_EXAMINER_SMOKE: {
        status: 200,
        body: {
          ok: true,
          evidence: evidenceFor(OPENAI_SURFACE, {
            runtimeOutcome: "FAILED",
            runtimeDetail: "PROVIDER_UNAVAILABLE",
            examiner: null,
            verdict: "FAIL",
            verdictReason: "RUNTIME_FAILED",
          }),
        },
      },
    });
    const { results } = await run(
      authorizedEnv(),
      [AUTHORIZE_FLAG, SELECT_OPENAI],
      app,
    );
    expect(results[0]).toMatchObject({
      status: "FAIL",
      reason: "RUNTIME_FAILED",
    });
    expect(
      app
        .operationCalls()
        .filter(
          (c: { body: CallBody }) =>
            c.body.operation === "OPENAI_EXAMINER_SMOKE",
        ),
    ).toHaveLength(1);
  });

  it("a route that does not answer is FAIL (not retried), and the request count is reported as unknown", async () => {
    const app = fakeApp({ OPENAI_EXAMINER_SMOKE: "throw" });
    const { results, providerRequestsMade } = await run(
      authorizedEnv(),
      [AUTHORIZE_FLAG, SELECT_OPENAI],
      app,
    );
    expect(results[0]).toMatchObject({
      status: "FAIL",
      reason: "ROUTE_DID_NOT_ANSWER",
    });
    expect(results[1].status).toBe("NOT_RUN");
    expect(results[2].status).toBe("NOT_RUN");
    expect(
      app
        .operationCalls()
        .filter(
          (c: { body: CallBody }) =>
            c.body.operation === "OPENAI_EXAMINER_SMOKE",
        ),
    ).toHaveLength(1);
    expect(providerRequestsMade).toBeNull();
  });

  it("evidence reporting more than one provider call is FAIL regardless of verdict", async () => {
    const app = fakeApp({
      ANTHROPIC_LAB_SMOKE: {
        status: 200,
        body: {
          ok: true,
          evidence: evidenceFor(ANTHROPIC_SURFACE, {
            usage: {
              providerCalls: 2,
              attempts: 2,
              inputTokens: 1,
              outputTokens: 1,
              estimatedCostMicrousd: 1,
              elapsedMs: 1,
            },
          }),
        },
      },
    });
    const { results } = await run(
      authorizedEnv(),
      [AUTHORIZE_FLAG, SELECT_LAB],
      app,
    );
    expect(results[1]).toMatchObject({
      status: "FAIL",
      reason: "MORE_THAN_ONE_PROVIDER_CALL",
    });
  });

  it("evidence that does not match the exact surface, or carries free text, is rejected", async () => {
    for (const bad of [
      evidenceFor(OPENAI_SURFACE, { modelId: "gpt-5.6-terra" }),
      evidenceFor(OPENAI_SURFACE, { profileRef: "TUTOR_COMMERCIAL_V1" }),
      evidenceFor(OPENAI_SURFACE, {
        runtimeDetail: "OpenAI rejected the request (401) RAW",
      }),
      evidenceFor(OPENAI_SURFACE, { verdictReason: "raw model text here" }),
      evidenceFor(OPENAI_SURFACE, {
        examiner: {
          strictParsePassed: true,
          outcome: "5",
          marksValidationPassed: true,
        },
      }),
    ]) {
      const app = fakeApp({
        OPENAI_EXAMINER_SMOKE: {
          status: 200,
          body: { ok: true, evidence: bad },
        },
      });
      const { results } = await run(
        authorizedEnv(),
        [AUTHORIZE_FLAG, SELECT_OPENAI],
        app,
      );
      expect(results[0]).toMatchObject({
        status: "FAIL",
        reason: "ROUTE_RETURNED_NO_VALID_EVIDENCE",
      });
      expect(JSON.stringify(results)).not.toContain("RAW");
    }
  });

  it("Operations Engineer evidence that does not match its exact surface, or misuses another surface's field, is rejected", async () => {
    for (const bad of [
      evidenceFor(OPS_SURFACE, { modelId: "claude-sonnet-5" }),
      evidenceFor(OPS_SURFACE, { profileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1" }),
      evidenceFor(OPS_SURFACE, { surface: "LIVE_PROVIDER:ANTHROPIC_LAB" }),
      evidenceFor(OPS_SURFACE, { operation: "ANTHROPIC_LAB_SMOKE" }),
      evidenceFor(OPS_SURFACE, { operationsEngineer: { outputLength: "RAW" } }),
      evidenceFor(OPS_SURFACE, { operationsEngineer: undefined }),
      evidenceFor(OPS_SURFACE, { lab: { outputLength: 5 } }),
      evidenceFor(OPS_SURFACE, {
        examiner: {
          strictParsePassed: true,
          outcome: "GRADED",
          marksValidationPassed: true,
        },
      }),
    ]) {
      const app = fakeApp({
        ANTHROPIC_OPERATIONS_ENGINEER_SMOKE: {
          status: 200,
          body: { ok: true, evidence: bad },
        },
      });
      const { results } = await run(
        authorizedEnv(),
        [AUTHORIZE_FLAG, SELECT_OPS],
        app,
      );
      expect(results[2]).toMatchObject({
        status: "FAIL",
        reason: "ROUTE_RETURNED_NO_VALID_EVIDENCE",
      });
      expect(JSON.stringify(results)).not.toContain("RAW");
    }
    // ...and the Lab surface may not carry the Operations Engineer field.
    expect(
      sanitizeEvidence(
        evidenceFor(ANTHROPIC_SURFACE, {
          operationsEngineer: { outputLength: 5 },
        }),
        ANTHROPIC_SURFACE,
      ),
    ).toBeNull();
  });

  it("Operations Engineer raw output fields are dropped, never printed", () => {
    const sanitized = sanitizeEvidence(
      {
        ...evidenceFor(OPS_SURFACE),
        outputText: "RAW-MODEL-OUTPUT",
        operationsEngineer: { outputLength: 10, text: "RAW-MODEL-OUTPUT" },
      },
      OPS_SURFACE,
    );
    expect(sanitized).toMatchObject({
      operationsEngineer: { outputLength: 10 },
      lab: null,
      examiner: null,
    });
    expect(JSON.stringify(sanitized)).not.toContain("RAW");
  });

  it("extra fields in evidence (e.g. raw output) are dropped, never printed", () => {
    const sanitized = sanitizeEvidence(
      {
        ...evidenceFor(ANTHROPIC_SURFACE),
        outputText: "RAW-MODEL-OUTPUT",
        lab: { outputLength: 10, text: "RAW-MODEL-OUTPUT" },
        usage: { ...evidenceFor(ANTHROPIC_SURFACE).usage, raw: "RAW" },
      },
      ANTHROPIC_SURFACE,
    );
    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).not.toContain("RAW");
  });

  it("a 404 readiness (gate refused) BLOCKS the selected surface with no operation request", async () => {
    const app = fakeApp({}, 404);
    const { results, providerRequestsMade } = await run(
      authorizedEnv(),
      [AUTHORIZE_FLAG, SELECT_OPS],
      app,
    );
    expect(results.map((r: Result) => r.status)).toEqual([
      "NOT_RUN",
      "NOT_RUN",
      "BLOCKED",
    ]);
    expect(results[2].reason).toContain("GATE_REFUSED");
    expect(app.operationCalls()).toHaveLength(0);
    expect(providerRequestsMade).toBe(0);
    expect(app.stopApp).toHaveBeenCalledTimes(1);
  });
});

describe("live-provider driver: the child process receives only what the route needs", () => {
  it("withholds every unrelated secret and passes only the granted provider key(s)", () => {
    const env = buildLiveProviderChildEnv(authorizedEnv(), {
      port: 4321,
      token: "a".repeat(64),
      authorized: true,
      grant: { OPENAI_API_KEY: true },
      envFileNames: ["SOME_FILE_ONLY_SECRET", "APP_URL"],
    });
    for (const name of [
      ...Object.keys(SECRET_SENTINELS),
      "ACCEPTANCE_ENVIRONMENT_ID",
      "SOME_FILE_ONLY_SECRET",
      "ANTHROPIC_API_KEY",
    ])
      expect(env[name]).toBe("");
    for (const name of WITHHELD_FROM_LIVE_PROVIDER_APP)
      if (name !== "OPENAI_API_KEY") expect(env[name]).toBe("");
    expect(env.OPENAI_API_KEY).toBe(OPENAI_KEY);
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.APP_URL).toBe("http://127.0.0.1:4321");
    expect(env).toMatchObject({
      ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED: "true",
      ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN: "a".repeat(64),
      ACCEPTANCE_LIVE_PROVIDER_OPT_IN: "true",
      ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED: "true",
    });
    // The examiner-app stub/redirect markers the route gate refuses.
    for (const name of [
      "ACCEPTANCE_APP_DRIVER_ENABLED",
      "ACCEPTANCE_APP_DRIVER_TOKEN",
      "ACCEPTANCE_PROVIDER_STUB_URL",
      "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
    ])
      expect(env[name]).toBe("");
  });

  it("an Operations Engineer grant passes only ANTHROPIC_API_KEY", () => {
    const env = buildLiveProviderChildEnv(authorizedEnv(), {
      port: 4321,
      token: "a".repeat(64),
      authorized: true,
      grant: { ANTHROPIC_API_KEY: true },
      envFileNames: [],
    });
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
    expect(env.OPENAI_API_KEY).toBe("");
    for (const name of WITHHELD_FROM_LIVE_PROVIDER_APP)
      if (name !== "ANTHROPIC_API_KEY") expect(env[name]).toBe("");
  });

  it("refuses to build a child environment without double authorization or a well-formed per-run token", () => {
    const base = {
      port: 4321,
      token: "a".repeat(64),
      authorized: true,
      grant: { OPENAI_API_KEY: true },
    };
    expect(() =>
      buildLiveProviderChildEnv(authorizedEnv(), {
        ...base,
        authorized: false,
      }),
    ).toThrow();
    expect(() =>
      buildLiveProviderChildEnv(
        authorizedEnv({ ACCEPTANCE_LIVE_PROVIDER_OPT_IN: "yes" }),
        base,
      ),
    ).toThrow();
    for (const token of [undefined, "short", "A".repeat(64)])
      expect(() =>
        buildLiveProviderChildEnv(authorizedEnv(), { ...base, token }),
      ).toThrow();
    // The thrown messages never include a value.
    try {
      buildLiveProviderChildEnv(authorizedEnv(), {
        ...base,
        authorized: false,
      });
    } catch (error) {
      noSecretsIn(String(error));
    }
  });

  it("readEnvFileNames returns names only from every file Next.js may load", () => {
    const dir = mkdtempSync(join(tmpdir(), "ducelio-live-provider-"));
    try {
      writeFileSync(
        join(dir, ".env.local"),
        "OPENAI_API_KEY=sk-file-sentinel\nSTRIPE_SECRET_KEY=sk_test_x\n",
      );
      writeFileSync(join(dir, ".env.development"), "UNRELATED_THING=abc\n");
      const names = readEnvFileNames(dir);
      expect(names.sort()).toEqual(
        ["OPENAI_API_KEY", "STRIPE_SECRET_KEY", "UNRELATED_THING"].sort(),
      );
      expect(JSON.stringify(names)).not.toContain("sk-file-sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("live-provider driver: the real CLI without authorization", () => {
  it("`node scripts/acceptance/live-provider.mjs` reports BLOCKED and zero provider requests without starting a server", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/acceptance/live-provider.mjs"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          OPENAI_API_KEY: OPENAI_KEY,
          ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[BLOCKED] LIVE_PROVIDER:OPENAI_EXAMINER -- EXPLICIT_AUTHORIZATION_REQUIRED",
    );
    expect(result.stdout).toContain(
      "[BLOCKED] LIVE_PROVIDER:ANTHROPIC_LAB -- EXPLICIT_AUTHORIZATION_REQUIRED",
    );
    expect(result.stdout).toContain(
      "[BLOCKED] LIVE_PROVIDER:ANTHROPIC_OPERATIONS_ENGINEER -- EXPLICIT_AUTHORIZATION_REQUIRED",
    );
    expect(result.stdout).toContain(
      "Provider requests made by this invocation: 0",
    );
    expect(result.stdout).toContain(TRUTHFULNESS_STATEMENT);
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it("the truthfulness statement disclaims production readiness and model quality", () => {
    expect(TRUTHFULNESS_STATEMENT).toContain("LIVE-PROVIDER-TESTED");
    expect(TRUTHFULNESS_STATEMENT).toContain("not production-readiness proof");
    expect(TRUTHFULNESS_STATEMENT).toContain(
      "not evidence of grading or instructional quality",
    );
    expect(TRUTHFULNESS_STATEMENT).toContain(
      "not evidence of Operations Engineer diagnostic, coding, remediation or deployment capability",
    );
  });
});

// ---------------------------------------------------------------------------
// V2 corrections.
// ---------------------------------------------------------------------------
describe("live-provider driver: a PASS must prove exactly one provider request", () => {
  function usage(providerCalls: number, attempts: number) {
    return {
      providerCalls,
      attempts,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicrousd: 1,
      elapsedMs: 1,
    };
  }
  for (const [surface, selector, index] of [
    [ANTHROPIC_SURFACE, SELECT_LAB, 1],
    [OPS_SURFACE, SELECT_OPS, 2],
  ] as const) {
    async function consume(u: ReturnType<typeof usage>) {
      const app = fakeApp({
        [surface.operation]: {
          status: 200,
          body: {
            ok: true,
            evidence: evidenceFor(surface, { usage: u }),
          },
        },
      });
      const { results } = await run(
        authorizedEnv(),
        [AUTHORIZE_FLAG, selector],
        app,
      );
      return results[index];
    }

    it(`${surface.surface}: PASS with providerCalls=0 is FAIL`, async () => {
      expect(await consume(usage(0, 1))).toMatchObject({
        status: "FAIL",
        reason: "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
      });
    });
    it(`${surface.surface}: PASS with attempts=0 is FAIL`, async () => {
      expect(await consume(usage(1, 0))).toMatchObject({
        status: "FAIL",
        reason: "PASS_WITHOUT_EXACTLY_ONE_PROVIDER_REQUEST",
      });
    });
    it(`${surface.surface}: PASS with providerCalls=1 and attempts=1 is allowed`, async () => {
      expect((await consume(usage(1, 1))).status).toBe("PASS");
    });
    it(`${surface.surface}: more than one call or attempt remains FAIL`, async () => {
      for (const u of [usage(2, 1), usage(1, 2), usage(2, 2)])
        expect(await consume(u)).toMatchObject({
          status: "FAIL",
          reason: "MORE_THAN_ONE_PROVIDER_CALL",
        });
    });
  }
});

describe("live-provider driver: env-file inspection fails closed", () => {
  function tempDir() {
    return mkdtempSync(join(tmpdir(), "ducelio-live-provider-env-"));
  }

  it("readable env-file names are blanked in the child, including dotenv colon/export forms", async () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, ".env.local"),
        "UNRELATED_FILE_SECRET=file-value-sentinel\nexport EXPORTED_NAME=x\nCOLON_NAME: y\n",
      );
      const names = readEnvFileNames(dir);
      expect(names).toEqual(
        expect.arrayContaining([
          "UNRELATED_FILE_SECRET",
          "EXPORTED_NAME",
          "COLON_NAME",
        ]),
      );
      const app = fakeApp();
      const outcome = await runLiveProviderAcceptance({
        env: authorizedEnv(),
        argv: [AUTHORIZE_FLAG, SELECT_OPS],
        startApp: app.startApp,
        stopApp: app.stopApp,
        fetchImpl: app.fetchImpl,
        envFileDir: dir,
        readinessPollMs: 1,
        readinessTimeoutMs: 1000,
      });
      expect(app.startApp).toHaveBeenCalledTimes(1);
      for (const name of [
        "UNRELATED_FILE_SECRET",
        "EXPORTED_NAME",
        "COLON_NAME",
      ])
        expect(app.childEnvs[0][name]).toBe("");
      expect(JSON.stringify(outcome)).not.toContain("file-value-sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const uninspectable: [string, (dir: string) => void][] = [
    [
      "an existing .env.local that cannot be read (a directory)",
      (dir) => mkdirSync(join(dir, ".env.local")),
    ],
    [
      "an existing .env.development whose bytes are not valid UTF-8",
      (dir) =>
        writeFileSync(
          join(dir, ".env.development"),
          Buffer.concat([
            Buffer.from("OPENAI_API_KEY=sk-undecodable-sentinel\n"),
            Buffer.from([0xff, 0xfe, 0xfd]),
          ]),
        ),
    ],
  ];
  for (const [label, arrange] of uninspectable) {
    it(`${label} blocks before the app starts, with zero provider requests and no contents reported`, async () => {
      const dir = tempDir();
      try {
        arrange(dir);
        expect(() => readEnvFileNames(dir)).toThrow(EnvFileInspectionError);
        const app = fakeApp();
        const { results, providerRequestsMade } = await (async () => {
          const outcome = await runLiveProviderAcceptance({
            env: authorizedEnv(),
            argv: [AUTHORIZE_FLAG, SELECT_LAB],
            startApp: app.startApp,
            stopApp: app.stopApp,
            fetchImpl: app.fetchImpl,
            envFileDir: dir,
            readinessPollMs: 1,
            readinessTimeoutMs: 1000,
          });
          return outcome as {
            results: (Result & { details: string[] })[];
            providerRequestsMade: number | null;
          };
        })();
        expect(results.map((r) => [r.status, r.reason])).toEqual([
          ["NOT_RUN", "NOT_SELECTED"],
          ["BLOCKED", "ENV_FILE_NOT_INSPECTABLE"],
          ["NOT_RUN", "NOT_SELECTED"],
        ]);
        expect(results[1].details.join(" ")).toMatch(
          /\.env\.(local|development) exists but its variable names could not be inspected\./,
        );
        expect(providerRequestsMade).toBe(0);
        expect(app.startApp).not.toHaveBeenCalled();
        expect(app.fetchImpl).not.toHaveBeenCalled();
        expect(JSON.stringify(results)).not.toContain(
          "sk-undecodable-sentinel",
        );
        expect(JSON.stringify(results)).not.toContain(dir);
        noSecretsIn(results);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("an uninspectable env file never matters without authorization (nothing is inspected or started)", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, ".env.local"));
      const app = fakeApp();
      const outcome = await runLiveProviderAcceptance({
        env: authorizedEnv(),
        argv: [SELECT_OPS],
        startApp: app.startApp,
        stopApp: app.stopApp,
        fetchImpl: app.fetchImpl,
        envFileDir: dir,
      });
      expect(
        (outcome.results as Result[]).every(
          (r) => r.reason === "EXPLICIT_AUTHORIZATION_REQUIRED",
        ),
      ).toBe(true);
      expect(app.startApp).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
