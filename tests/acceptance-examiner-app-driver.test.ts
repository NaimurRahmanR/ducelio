import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ============================================================================
// scripts/acceptance/examiner-app.mjs (the real-application acceptance
// driver) and its local provider stub/preload. No hosted infrastructure:
// prerequisite BLOCKING, secret hygiene, the stub's contract, the preload's
// refusal to run outside the driver, the no-HMAC-in-tooling rule, and the
// scenario PASS/FAIL logic (driven by an in-memory stand-in for the app and
// database, so a replay that creates duplicate history is provably FAIL).
// ============================================================================

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env))
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}
function clearAcceptanceVars() {
  for (const key of Object.keys(process.env))
    if (
      key.startsWith("ACCEPTANCE_") ||
      key.startsWith("ACADEMIC_") ||
      key.startsWith("NEXT_PUBLIC_SUPABASE_")
    )
      delete process.env[key];
}
beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  vi.doUnmock("pg");
  vi.doUnmock("../scripts/acceptance/examiner-provider-stub.mjs");
  vi.resetModules();
});

const SECRET_SENTINELS = {
  ACCEPTANCE_ADMIN_PASSWORD: "admin-password-sentinel-123",
  ACCEPTANCE_LEARNER_PASSWORD: "learner-password-sentinel-123",
  ACADEMIC_EXECUTION_HMAC_KEY_HEX: "0123456789abcdef".repeat(4),
  ACCEPTANCE_DATABASE_URL:
    "postgresql://acceptance:db-password-sentinel@localhost:5432/acceptance",
};
function configureAll() {
  clearAcceptanceVars();
  Object.assign(process.env, {
    ...SECRET_SENTINELS,
    NEXT_PUBLIC_SUPABASE_URL: "https://acceptance.supabase.invalid",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
    ACCEPTANCE_ADMIN_EMAIL: "admin@acceptance.test",
    ACCEPTANCE_LEARNER_EMAIL: "learner@acceptance.test",
    ACCEPTANCE_ENVIRONMENT_ID: "a0000000-0000-4000-8000-000000000001",
    ACCEPTANCE_WRITE_ENABLED: "true",
    ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000002",
  });
}
function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of Object.values(SECRET_SENTINELS))
    expect(text).not.toContain(secret);
  expect(text).not.toContain("db-password-sentinel");
}
function mockControllerKeyPresent(present: boolean) {
  function FakeClient() {
    return {
      connect: async () => {},
      end: async () => {},
      query: async () => ({ rows: [{ present }] }),
    };
  }
  vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
}

describe("examiner-app driver: missing prerequisites are BLOCKED, never PASS, and never print secrets", () => {
  it("with nothing configured all three surfaces are BLOCKED, naming only the missing variables", async () => {
    clearAcceptanceVars();
    vi.resetModules();
    const { runExaminerAppAcceptance, SURFACES } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const results = await runExaminerAppAcceptance();
    expect(results.map((r: { surface: string }) => r.surface)).toEqual(
      Object.values(SURFACES),
    );
    for (const r of results) expect(r.status).toBe("BLOCKED");
    const details = results[0].details.join("\n");
    expect(details).toContain("ACADEMIC_EXECUTION_KEY_ID");
    expect(details).toContain("ACADEMIC_EXECUTION_HMAC_KEY_HEX");
    expect(details).toContain("ACCEPTANCE_WRITE_ENABLED");
  });

  it("an HMAC key the production authority would reject (uppercase hex) is BLOCKED -- the same structural rule as authority.ts -- and its value never appears", async () => {
    configureAll();
    const upper = "ABCDEF0123456789".repeat(4);
    process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = upper;
    vi.resetModules();
    const { runExaminerAppAcceptance } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const results = await runExaminerAppAcceptance();
    for (const r of results) expect(r.status).toBe("BLOCKED");
    expect(results[0].details.join("\n")).toContain(
      "ACADEMIC_EXECUTION_HMAC_KEY_HEX",
    );
    expect(JSON.stringify(results)).not.toContain(upper);
    expectNoSecrets(results);
  });

  it("no matching active hosted controller key => BLOCKED as an explicit operator prerequisite (the driver never provisions keys)", async () => {
    configureAll();
    mockControllerKeyPresent(false);
    vi.resetModules();
    const { runExaminerAppAcceptance } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const results = await runExaminerAppAcceptance();
    for (const r of results) expect(r.status).toBe("BLOCKED");
    expect(results[0].reason).toContain(
      "No active hosted controller key matches ACADEMIC_EXECUTION_KEY_ID",
    );
    expectNoSecrets(results);
  });

  it("the local provider stub failing to start => BLOCKED, never a simulated PASS", async () => {
    configureAll();
    mockControllerKeyPresent(true);
    vi.doMock(
      "../scripts/acceptance/examiner-provider-stub.mjs",
      async (orig) => ({
        ...(await orig<Record<string, unknown>>()),
        startProviderStub: async () => {
          throw new Error("port unavailable");
        },
      }),
    );
    vi.resetModules();
    const { runExaminerAppAcceptance } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const results = await runExaminerAppAcceptance();
    for (const r of results) expect(r.status).toBe("BLOCKED");
    expect(results[0].reason).toContain("provider stub");
    expectNoSecrets(results);
  });

  it("guardScenario maps a write-gate refusal to BLOCKED and any other error to FAIL -- never PASS", async () => {
    const { guardScenario } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    expect(
      (
        await guardScenario("S", async () => {
          throw new AcceptanceWriteNotAuthorizedError("gate");
        })
      ).status,
    ).toBe("BLOCKED");
    expect(
      (
        await guardScenario("S", async () => {
          throw new Error("boom");
        })
      ).status,
    ).toBe("FAIL");
  });

  it("the truthfulness statement disclaims production readiness and live-provider proof", async () => {
    const { TRUTHFULNESS_STATEMENT } =
      await import("../scripts/acceptance/examiner-app.mjs");
    expect(TRUTHFULNESS_STATEMENT).toContain("not production-readiness proof");
    expect(TRUTHFULNESS_STATEMENT).toContain("not LIVE_PROVIDER proof");
  });
});

describe("examiner-app driver: the local app process never holds privileged or real-provider credentials", () => {
  it("buildAppChildEnv withholds the acceptance DB URL, acceptance credentials and real provider/payment keys, and supplies only the per-run stub key", async () => {
    const { buildAppChildEnv } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const env = buildAppChildEnv(
      {
        ...SECRET_SENTINELS,
        ACCEPTANCE_ADMIN_EMAIL: "admin@acceptance.test",
        ACCEPTANCE_UNRELATED_STAFF_PASSWORD: "staff-password",
        ACCEPTANCE_WRITE_ENABLED: "true",
        OPENAI_API_KEY: "sk-real-openai-sentinel",
        ANTHROPIC_API_KEY: "sk-ant-real-sentinel",
        STRIPE_SECRET_KEY: "sk_test_sentinel",
        ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000002",
        NODE_ENV: "production",
      },
      {
        port: 4123,
        token: "f".repeat(64),
        redirectToken: "1".repeat(64),
        stub: { url: "http://127.0.0.1:5555/v1/responses", apiKey: "stub-key" },
      },
    );
    for (const name of [
      "ACCEPTANCE_DATABASE_URL",
      "ACCEPTANCE_ADMIN_PASSWORD",
      "ACCEPTANCE_LEARNER_PASSWORD",
      "ACCEPTANCE_ADMIN_EMAIL",
      "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
      "ACCEPTANCE_WRITE_ENABLED",
      "ANTHROPIC_API_KEY",
      "STRIPE_SECRET_KEY",
    ])
      expect(env[name]).toBe("");
    expect(env.OPENAI_API_KEY).toBe("stub-key");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.APP_URL).toBe("http://127.0.0.1:4123");
    expect(env.ACCEPTANCE_APP_DRIVER_ENABLED).toBe("true");
    expect(env.ACCEPTANCE_PROVIDER_STUB_URL).toBe(
      "http://127.0.0.1:5555/v1/responses",
    );
    expect(env.NODE_OPTIONS).toMatch(
      /^--import=file:.*examiner-provider-redirect\.mjs$/,
    );
    // The second per-run secret the preload marks its wrapper with.
    expect(env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN).toBe("1".repeat(64));
    // The controller key the real app authority needs is passed through.
    expect(env.ACADEMIC_EXECUTION_HMAC_KEY_HEX).toBe(
      SECRET_SENTINELS.ACADEMIC_EXECUTION_HMAC_KEY_HEX,
    );
  });

  it("buildAppChildEnv refuses to build a child environment without two well-formed per-run tokens", async () => {
    const { buildAppChildEnv } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const stub = { url: "http://127.0.0.1:5555/v1/responses", apiKey: "k" };
    for (const tokens of [
      { token: "f".repeat(64), redirectToken: undefined },
      { token: "f".repeat(64), redirectToken: "F".repeat(64) },
      { token: "short", redirectToken: "1".repeat(64) },
    ])
      expect(() =>
        buildAppChildEnv({}, { port: 1, ...tokens, stub }),
      ).toThrow();
  });

  it("the driver generates a fresh redirect token distinct from its route token, passes it only into the child environment, and never prints or returns it", async () => {
    configureAll();
    mockControllerKeyPresent(true);
    vi.resetModules();
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
    ];
    const { runExaminerAppAcceptance } =
      await import("../scripts/acceptance/examiner-app.mjs");
    let childEnv: Record<string, string> | null = null;
    try {
      // A child that exits immediately: readiness is EXITED, so every
      // surface is BLOCKED before any sign-in or fixture write.
      const results = await runExaminerAppAcceptance({
        startApp: (env: Record<string, string>) => {
          childEnv = env;
          return { exitCode: 1, pid: 0, once: () => {} };
        },
      });
      for (const r of results) expect(r.status).toBe("BLOCKED");
      const env = childEnv as unknown as Record<string, string>;
      expect(env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(env.ACCEPTANCE_APP_DRIVER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN).not.toBe(
        env.ACCEPTANCE_APP_DRIVER_TOKEN,
      );
      const emitted = JSON.stringify(results) + logs.join("\n");
      expect(emitted).not.toContain(env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN);
      expect(emitted).not.toContain(env.ACCEPTANCE_APP_DRIVER_TOKEN);
      expectNoSecrets(results);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the cookie jar keeps session cookies in memory, replaces refreshed values and drops cleared ones", async () => {
    const { createCookieJar } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const jar = createCookieJar();
    const res = (cookies: string[]) => ({
      headers: { getSetCookie: () => cookies },
    });
    jar.absorb(
      res([
        "sb-x-auth-token.0=a; Path=/; HttpOnly",
        "sb-x-auth-token.1=b; Path=/",
      ]),
    );
    expect(jar.header()).toBe("sb-x-auth-token.0=a; sb-x-auth-token.1=b");
    jar.absorb(
      res(["sb-x-auth-token.0=c; Path=/", "sb-x-auth-token.1=; Max-Age=0"]),
    );
    expect(jar.header()).toBe("sb-x-auth-token.0=c");
  });
});

describe("examiner-app driver: the deterministic local provider stub", () => {
  async function post(
    stub: { url: string; apiKey: string },
    body: unknown,
    key = stub.apiKey,
  ) {
    return fetch(stub.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  const governed = (capability: string) => ({
    model: "gpt-5.6-luna",
    instructions: "Return ONLY JSON.",
    max_output_tokens: 1200,
    store: false,
    input: JSON.stringify({
      capability,
      context: {
        attemptId: "10000000-0000-4000-8000-0000000000bb",
        questions: [
          {
            questionId: "10000000-0000-4000-8000-000000000001",
            maxMarks: 10,
            expectedAnswer: "Acceptance answer.",
            responseBody: "Synthetic",
          },
        ],
      },
    }),
  });

  it("answers the real OpenAI Responses shape with deterministic marks, never echoing protected content; regrade awards one mark less; planned failure is one-shot 503", async () => {
    const { startProviderStub } =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const stub = await startProviderStub();
    try {
      expect(
        (await post(stub, governed("grade_controlled_assessment"), "wrong"))
          .status,
      ).toBe(401);
      expect((await post(stub, { hello: "world" })).status).toBe(400);
      expect((await post(stub, governed("grade_practical_lab"))).status).toBe(
        400,
      );

      const graded = await post(stub, governed("grade_controlled_assessment"));
      const text = await graded.text();
      expect(graded.status).toBe(200);
      const body = JSON.parse(text);
      expect(body.status).toBe("completed");
      expect(JSON.parse(body.output[0].content[0].text)).toEqual({
        outcome: "GRADED",
        marks: [
          {
            questionId: "10000000-0000-4000-8000-000000000001",
            marksAwarded: 10,
          },
        ],
      });
      expect(text).not.toContain("Acceptance answer.");
      expect(text).not.toContain("Synthetic");

      const regraded = await (
        await post(stub, governed("regrade_controlled_assessment"))
      ).json();
      expect(
        JSON.parse(regraded.output[0].content[0].text).marks[0].marksAwarded,
      ).toBe(9);

      stub.planFailure();
      expect(
        (await post(stub, governed("grade_controlled_assessment"))).status,
      ).toBe(503);
      expect(
        (await post(stub, governed("grade_controlled_assessment"))).status,
      ).toBe(200);
      expect(stub.calls.map((c: { outcome: string }) => c.outcome)).toEqual([
        "REJECTED",
        "REJECTED",
        "GRADED",
        "GRADED",
        "PROVIDER_UNAVAILABLE",
        "GRADED",
      ]);
      expectNoSecrets(stub.calls);
    } finally {
      await stub.close();
    }
  });

  it("the redirect wrapper sends ONLY the exact OpenAI Responses URL to the loopback stub, refuses every other AI-vendor request, and passes other traffic through", async () => {
    const { createProviderRedirectFetch } =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const seen: string[] = [];
    const base = vi.fn(async (input: unknown) => {
      seen.push(String(input));
      return new Response("ok");
    });
    const wrapped = createProviderRedirectFetch(
      base,
      "http://127.0.0.1:5555/v1/responses",
      "2".repeat(64),
    );
    await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    await wrapped("https://acceptance.supabase.co/rest/v1/rpc/x");
    await expect(
      wrapped("https://api.openai.com/v1/chat/completions"),
    ).rejects.toThrow();
    await expect(
      wrapped("https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow();
    await expect(
      wrapped(
        new Request("https://api.openai.com/v1/responses", { method: "POST" }),
      ),
    ).rejects.toThrow();
    expect(seen).toEqual([
      "http://127.0.0.1:5555/v1/responses",
      "https://acceptance.supabase.co/rest/v1/rpc/x",
    ]);
    for (const bad of [
      "https://127.0.0.1:5555/v1/responses",
      "http://example.com:5555/v1/responses",
      "http://127.0.0.1:5555/other",
    ])
      expect(() =>
        createProviderRedirectFetch(base, bad, "2".repeat(64)),
      ).toThrow();
  });

  it("the wrapper itself carries the per-run marker (non-enumerable, non-writable, non-configurable) and answers the attestation sentinel in-process with it -- never via the network; a malformed token is refused", async () => {
    const {
      createProviderRedirectFetch,
      PROVIDER_REDIRECT_MARKER,
      PROVIDER_REDIRECT_ATTESTATION_URL,
      PROVIDER_REDIRECT_ATTESTATION_HEADER,
    } = await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const base = vi.fn(async () => new Response("network"));
    const token = "3".repeat(64);
    const wrapped = createProviderRedirectFetch(
      base,
      "http://127.0.0.1:5555/v1/responses",
      token,
    );
    expect(PROVIDER_REDIRECT_MARKER).toBe(
      Symbol.for("ducelio.acceptance.provider-redirect-v1"),
    );
    expect(
      Object.getOwnPropertyDescriptor(wrapped, PROVIDER_REDIRECT_MARKER),
    ).toEqual({
      value: token,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    const answer = await wrapped(PROVIDER_REDIRECT_ATTESTATION_URL, {
      method: "POST",
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get(PROVIDER_REDIRECT_ATTESTATION_HEADER)).toBe(
      token,
    );
    expect(base).not.toHaveBeenCalled();
    for (const bad of [undefined, "", "3".repeat(63), "G".repeat(64)])
      expect(() =>
        createProviderRedirectFetch(
          base,
          "http://127.0.0.1:5555/v1/responses",
          bad,
        ),
      ).toThrow();
  });

  it("the gate module's sentinel URL and header are exactly the wrapper's, and the sentinel host can never resolve", async () => {
    const stubModule =
      await import("../scripts/acceptance/examiner-provider-stub.mjs");
    const gate = await import("@/server/acceptance-app-driver");
    expect(gate.PROVIDER_REDIRECT_ATTESTATION_URL).toBe(
      stubModule.PROVIDER_REDIRECT_ATTESTATION_URL,
    );
    expect(gate.PROVIDER_REDIRECT_ATTESTATION_HEADER).toBe(
      stubModule.PROVIDER_REDIRECT_ATTESTATION_HEADER,
    );
    // RFC 2606 .invalid: an unredirected attestation can never open an
    // HTTP connection.
    expect(new URL(gate.PROVIDER_REDIRECT_ATTESTATION_URL).hostname).toMatch(
      /\.invalid$/,
    );
  });

  it("the preload refuses to load in any process the driver did not configure (it can never silently install itself)", () => {
    const preload = pathToFileURL(
      fileURLToPath(
        new URL(
          "../scripts/acceptance/examiner-provider-redirect.mjs",
          import.meta.url,
        ),
      ),
    ).href;
    const env = { ...process.env };
    delete env.ACCEPTANCE_APP_DRIVER_ENABLED;
    delete env.ACCEPTANCE_PROVIDER_STUB_URL;
    const run = spawnSync(process.execPath, ["--import", preload, "-e", ""], {
      env,
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      "may only be loaded by the examiner app acceptance driver",
    );
  });

  const preloadHref = () =>
    pathToFileURL(
      fileURLToPath(
        new URL(
          "../scripts/acceptance/examiner-provider-redirect.mjs",
          import.meta.url,
        ),
      ),
    ).href;
  const driverEnv = (redirectToken: string | undefined) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ACCEPTANCE_APP_DRIVER_ENABLED: "true",
      ACCEPTANCE_PROVIDER_STUB_URL: "http://127.0.0.1:5555/v1/responses",
      ACCEPTANCE_PROVIDER_REDIRECT_TOKEN: redirectToken,
    };
    if (redirectToken === undefined)
      delete env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN;
    return env;
  };

  it.each([
    ["missing", undefined],
    ["malformed (uppercase)", "A".repeat(64)],
    ["malformed (short)", "a".repeat(63)],
  ])(
    "the preload refuses to load when ACCEPTANCE_PROVIDER_REDIRECT_TOKEN is %s, even with the other driver settings present",
    (_label, token) => {
      const run = spawnSync(
        process.execPath,
        ["--import", preloadHref(), "-e", ""],
        { env: driverEnv(token), encoding: "utf8" },
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        "may only be loaded by the examiner app acceptance driver",
      );
    },
  );

  it("in a real subprocess, the preload installs a globalThis.fetch marked with EXACTLY the configured token, which answers the attestation sentinel with it", () => {
    const token = "4".repeat(64);
    // The child checks everything itself and reports only an exit code --
    // the token is never printed.
    const check = [
      'const marker = Symbol.for("ducelio.acceptance.provider-redirect-v1");',
      "const d = Object.getOwnPropertyDescriptor(globalThis.fetch, marker);",
      "const expected = process.env.ACCEPTANCE_PROVIDER_REDIRECT_TOKEN;",
      "if (!d || d.value !== expected || d.writable || d.enumerable || d.configurable) process.exit(3);",
      'const r = await fetch("http://provider-redirect-attestation.ducelio.invalid/v1", { method: "POST" });',
      'if (r.status !== 204 || r.headers.get("x-ducelio-provider-redirect-attestation") !== expected) process.exit(4);',
    ].join("\n");
    const run = spawnSync(
      process.execPath,
      ["--import", preloadHref(), "--input-type=module", "-e", check],
      { env: driverEnv(token), encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(token);
  });
});

describe("examiner-app driver: acceptance tooling never constructs an HMAC or canonical message", () => {
  const TOOLING = [
    "../scripts/acceptance/examiner-app.mjs",
    "../scripts/acceptance/examiner-provider-stub.mjs",
    "../scripts/acceptance/examiner-provider-redirect.mjs",
    "../src/app/api/acceptance/examiner-app/route.ts",
    "../src/server/acceptance-app-driver.ts",
  ];
  it("no driver, stub, preload, route or gate file signs, digests, or names a protocol tag / MAC parameter", async () => {
    for (const file of TOOLING) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/createHmac|subtle\.sign|\.digest\(/);
      expect(text).not.toMatch(/HMAC_SHA256|p_mac\b|COMMERCIAL_V1_EXAMINER_V1/);
    }
  });

  it("the route and gate never read the controller key; the route reaches only the existing production entrypoints", async () => {
    const route = await readFile(
      new URL(
        "../src/app/api/acceptance/examiner-app/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const gate = await readFile(
      new URL("../src/server/acceptance-app-driver.ts", import.meta.url),
      "utf8",
    );
    for (const text of [route, gate])
      expect(text).not.toMatch(/ACADEMIC_EXECUTION_(KEY_ID|HMAC_KEY_HEX)/);
    expect(route).toContain(
      'import { submitControlledAssessmentAndGrade } from "@/server/commercial-v1-submission-grading";',
    );
    expect(route).toContain(
      'import { recoverExaminerTarget } from "@/server/commercial-v1-examiner-recovery/operations";',
    );
    expect(route).toContain(
      'import { regradeControlledAssessment } from "@/server/commercial-v1-examiner-regrade";',
    );
    expect(route).not.toMatch(/authority"|govern_commercial_v1/);
  });

  it("no application module references the stub, the preload, or acceptance credentials", async () => {
    const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
      }
      return out;
    }
    for (const file of await walk(srcRoot)) {
      const text = await readFile(file, "utf8");
      // Comments may name them (the gate documents the attestation); no
      // application module may ever import or load them.
      expect(text).not.toMatch(
        /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*examiner-provider-(stub|redirect)/,
      );
      expect(text).not.toMatch(/ACCEPTANCE_[A-Z_]*_(EMAIL|PASSWORD)/);
      expect(text).not.toContain("ACCEPTANCE_DATABASE_URL");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario logic against an in-memory stand-in for the app + hosted DB.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Faults = {
  replayDuplicatesExecution?: boolean;
  leakExpectedAnswer?: boolean;
  noProvider?: boolean;
  learnerMayRegrade?: boolean;
  replayDuplicatesRecovery?: boolean;
  regradeMutatesSource?: boolean;
};
function world(faults: Faults = {}) {
  const course = {
    enrolmentId: "enrolment",
    activationId: "activation",
    studentId: "student",
    recoveryActorId: "admin",
    quiz1AssessmentId: "assessment",
  };
  const executions: Row[] = [];
  const revisions: Row[] = [];
  const regrades: Row[] = [];
  const recoveries: Row[] = [];
  const stubCalls: Row[] = [];
  let failNext = false;
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const jars = { learner: { size: 1 }, admin: { size: 1 } };

  function newRevision(attemptId: string, number: number, earned: number) {
    const revision = {
      id: id("revision"),
      revision_number: number,
      attempt_id: attemptId,
      earned_marks_total: earned,
      max_marks_total: 10,
      valid: true,
      outcome_rows: 1,
      enrolment_id: course.enrolmentId,
    };
    revisions.push(revision);
    return revision;
  }
  function execution(attemptId: string, succeeded: boolean) {
    stubCalls.push({
      capability: "grade_controlled_assessment",
      attemptId,
      outcome: succeeded ? "GRADED" : "PROVIDER_UNAVAILABLE",
    });
    const revision = succeeded ? newRevision(attemptId, 1, 10) : null;
    executions.push({
      id: id("execution"),
      attempt_id: attemptId,
      state: succeeded ? "SUCCEEDED" : "FAILED",
      reason_code: succeeded ? "GRADED" : "PROVIDER_UNAVAILABLE",
      student_id: course.studentId,
      enrolment_id: course.enrolmentId,
      activation_id: course.activationId,
      capability: "grade_controlled_assessment",
      runtime_profile_ref: "EXAMINER_COMMERCIAL_V1",
      grade_digest: succeeded ? "d".repeat(64) : null,
      result_revision_id: revision?.id ?? null,
      provider_calls: 1,
    });
  }
  const ok = (result: Row) => {
    const body = { ok: true, result };
    let text = JSON.stringify(body);
    if (faults.leakExpectedAnswer) text += " Acceptance answer.";
    return { status: 200, body, text };
  };

  const app = {
    async call(jar: unknown, payload: Row) {
      const admin = jar === jars.admin;
      switch (payload.operation) {
        case "SUBMIT_AND_GRADE_ASSESSMENT": {
          const attemptId = payload.attemptId as string;
          const existing = executions.filter((e) => e.attempt_id === attemptId);
          if (faults.noProvider)
            return ok({ attemptId, grading: "GRADING_UNAVAILABLE" });
          if (!existing.length || faults.replayDuplicatesExecution) {
            const succeeded = !failNext;
            failNext = false;
            execution(attemptId, succeeded);
            return ok({
              attemptId,
              grading: succeeded ? "GRADED" : "GRADING_UNAVAILABLE",
            });
          }
          return ok({
            attemptId,
            grading:
              existing[0].state === "SUCCEEDED"
                ? "GRADED"
                : "GRADING_UNAVAILABLE",
          });
        }
        case "REGRADE_CONTROLLED_ASSESSMENT": {
          const source = revisions.find(
            (r) => r.id === payload.resultRevisionId,
          );
          if ((!admin && !faults.learnerMayRegrade) || !source)
            return ok({
              status: "UNAVAILABLE",
              executionId: null,
              resultRevisionId: null,
            });
          const claim = regrades.find((r) => r.source === source.id);
          if (claim)
            return ok({
              status: "ALREADY_REGRADED",
              executionId: claim.id,
              resultRevisionId: claim.result_revision_id,
            });
          stubCalls.push({
            capability: "regrade_controlled_assessment",
            attemptId: source.attempt_id,
            outcome: "GRADED",
          });
          const revision = newRevision(source.attempt_id as string, 2, 9);
          if (faults.regradeMutatesSource) source.earned_marks_total = 0;
          const created = {
            id: id("regrade"),
            source: source.id,
            state: "SUCCEEDED",
            actor_id: course.recoveryActorId,
            student_id: course.studentId,
            result_revision_id: revision.id,
            provider_calls: 1,
          };
          regrades.push(created);
          return ok({
            status: "REGRADED",
            executionId: created.id,
            resultRevisionId: revision.id,
          });
        }
        case "RECOVER_EXAMINER_TARGET": {
          const source = executions.find(
            (e) => e.id === payload.sourceExecutionId,
          );
          if (!admin || !source)
            return ok({ status: "UNAVAILABLE", resultRevisionId: null });
          const claim = recoveries.find((r) => r.source === source.id);
          if (claim && !faults.replayDuplicatesRecovery)
            return ok({
              status: "ALREADY_RECOVERED",
              resultRevisionId: claim.result_revision_id,
            });
          stubCalls.push({
            capability: "grade_controlled_assessment",
            attemptId: source.attempt_id,
            outcome: "GRADED",
          });
          const revision = claim
            ? revisions.find((r) => r.id === claim.result_revision_id)!
            : newRevision(source.attempt_id as string, 1, 10);
          recoveries.push({
            id: id("recovery"),
            source: source.id,
            state: "SUCCEEDED",
            actor_id: course.recoveryActorId,
            student_id: course.studentId,
            result_revision_id: revision.id,
            provider_calls: 1,
          });
          return ok({
            status: claim ? "ALREADY_RECOVERED" : "RECOVERED",
            resultRevisionId: revision.id,
          });
        }
      }
      return { status: 400, body: { error: "INVALID_REQUEST" }, text: "" };
    },
  };

  async function query(sql: string, params: unknown[]) {
    const [p] = params;
    if (sql.includes("to_jsonb(r) as revision")) {
      const r = revisions.find((x) => x.id === p);
      return r
        ? [
            {
              revision: { ...r },
              marks: [{ q: "q1", m: r.earned_marks_total }],
            },
          ]
        : [];
    }
    if (sql.includes("to_jsonb(e) as execution")) {
      const e = executions.find((x) => x.id === p);
      return e ? [{ execution: { ...e } }] : [];
    }
    if (sql.includes("commercial_v1_examiner_execution_usage"))
      return executions.filter((e) => e.attempt_id === p);
    if (sql.includes("commercial_v1_examiner_regrade_executions"))
      return regrades.filter((r) => r.source === p);
    if (sql.includes("commercial_v1_examiner_recovery_executions"))
      return recoveries.filter((r) => r.source === p);
    if (sql.includes("from commercial_v1_assessment_question_marks m")) {
      const r = revisions.find((x) => x.id === p)!;
      return [
        {
          question_id: "q1",
          marks_awarded: r.earned_marks_total,
          max_marks: 10,
        },
      ];
    }
    if (sql.includes("from assessment_questions where")) return [{ n: 1 }];
    if (sql.includes("from commercial_v1_assessment_result_revisions r"))
      return revisions
        .filter((r) => r.enrolment_id === p)
        .sort(
          (a, b) =>
            (a.revision_number as number) - (b.revision_number as number),
        );
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }

  let attempt = 0;
  const ctx = {
    runId: "test-run",
    app,
    jars,
    query,
    stub: {
      calls: stubCalls,
      planFailure() {
        failNext = true;
      },
    },
    learnerClient: {
      rpc: async (name: string) => ({
        data:
          name === "start_assessment_attempt"
            ? `attempt-${++attempt}`
            : name === "get_active_assessment_questions"
              ? [{ id: "q1" }]
              : { ok: true, responseId: "response" },
        error: null,
      }),
    },
    adminClient: {
      rpc: async () => ({ data: { recoveryStatus: "ELIGIBLE" }, error: null }),
    },
  };
  return { ctx, course, revisions, executions };
}

describe("examiner-app driver: scenario PASS requires every invariant; duplicate history, leaks and bypasses are FAIL", () => {
  async function load() {
    return import("../scripts/acceptance/examiner-app.mjs");
  }

  it("GRADING, REGRADE and INITIAL_RECOVERY PASS against a coherent world", async () => {
    const { scenarioGrading, scenarioRegrade, scenarioInitialRecovery } =
      await load();
    const { ctx, course } = world();
    const graded = await scenarioGrading(ctx, course);
    expect(graded.result.status).toBe("PASS");
    expect((await scenarioRegrade(ctx, course, graded)).status).toBe("PASS");
    const recovery = world();
    expect(
      (await scenarioInitialRecovery(recovery.ctx, recovery.course)).status,
    ).toBe("PASS");
  });

  it("GRADING FAILs when replay creates a second execution/provider call", async () => {
    const { scenarioGrading } = await load();
    const { ctx, course } = world({ replayDuplicatesExecution: true });
    expect((await scenarioGrading(ctx, course)).result.status).toBe("FAIL");
  });

  it("GRADING FAILs when an HTTP response carries protected answer-key content", async () => {
    const { scenarioGrading } = await load();
    const { ctx, course } = world({ leakExpectedAnswer: true });
    const graded = await scenarioGrading(ctx, course);
    expect(graded.result.status).toBe("FAIL");
    expect(graded.result.details.join("\n")).not.toContain(
      "Acceptance answer.",
    );
  });

  it("GRADING FAILs (never simulated PASS) when the app reports no provider", async () => {
    const { scenarioGrading } = await load();
    const { ctx, course } = world({ noProvider: true });
    expect((await scenarioGrading(ctx, course)).result.status).toBe("FAIL");
  });

  it("REGRADE is BLOCKED without a valid GRADING revision, FAILs if a learner obtains a regrade, and FAILs if the source revision changes", async () => {
    const { scenarioGrading, scenarioRegrade } = await load();
    const blockedWorld = world();
    expect(
      (await scenarioRegrade(blockedWorld.ctx, blockedWorld.course, null))
        .status,
    ).toBe("BLOCKED");
    for (const fault of [
      { learnerMayRegrade: true },
      { regradeMutatesSource: true },
    ]) {
      const { ctx, course } = world(fault);
      const graded = await scenarioGrading(ctx, course);
      expect((await scenarioRegrade(ctx, course, graded)).status).toBe("FAIL");
    }
  });

  it("INITIAL_RECOVERY FAILs when replay creates a second recovery claim/provider call", async () => {
    const { scenarioInitialRecovery } = await load();
    const { ctx, course } = world({ replayDuplicatesRecovery: true });
    expect((await scenarioInitialRecovery(ctx, course)).status).toBe("FAIL");
  });
});

describe("examiner-app driver: acceptance course fixture enables only the reviewed EXAMINER configuration", () => {
  it("buildAcceptancePackage keeps every role disabled by default and, with examinerEnabled, enables only EXAMINER with its single allowed profile, controlled-assessment grading and no escalation", async () => {
    const { buildAcceptancePackage } =
      await import("../scripts/acceptance/fixtures.mjs");
    const plain = buildAcceptancePackage("run-a");
    for (const role of Object.values(plain.agentConfiguration) as {
      enabled: boolean;
    }[])
      expect(role.enabled).toBe(false);
    const examiner = buildAcceptancePackage("run-b", { examinerEnabled: true });
    expect(examiner.agentConfiguration.EXAMINER).toEqual({
      enabled: true,
      modelProfileRef: "EXAMINER_COMMERCIAL_V1",
      instructionalNotes: null,
      capabilities: ["grade_controlled_assessment"],
      escalationPolicy: "NONE",
    });
    for (const role of ["PROFESSOR", "TUTOR", "LAB_INSTRUCTOR", "COUNSELLOR"])
      expect(examiner.agentConfiguration[role].enabled).toBe(false);
  });
});
