import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// src/app/api/acceptance/examiner-app/route.ts -- the acceptance-only HTTP
// hop scripts/acceptance/examiner-app.mjs uses to reach the EXISTING
// production grading/recovery/regrade entrypoints inside a real Next.js
// request.
//
// Only the external Supabase boundary (@/server/supabase) and @/lib/env's
// APP_URL are replaced here. Everything behind the route -- identity
// resolution (getAuthenticatedActor), recoverExaminerTarget, the recovery/
// regrade entrypoints and their authority.ts HMAC transports -- is the real
// production code, so a govern_* RPC reaching the fake below can only have
// been produced by the production authority module, never by the route.
// tests/acceptance-examiner-app-grading-db.test.ts proves the grading path
// end to end against the real migrated schema.
// ============================================================================

const state = vi.hoisted(() => ({
  appUrl: "http://127.0.0.1:3100",
  createSupabase: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: state.createSupabase,
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    config: () => ({
      url: "https://supabase.invalid",
      key: "publishable",
      configured: true,
      appUrl: state.appUrl,
      google: false,
      linkedin: false,
    }),
  };
});

import * as routeModule from "@/app/api/acceptance/examiner-app/route";
import { acceptanceAppDriverRequestAllowed } from "@/server/acceptance-app-driver";
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import { createProviderRedirectFetch } from "../scripts/acceptance/examiner-provider-stub.mjs";

const { POST } = routeModule;
const TOKEN = "a".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const KEY_ID = "b0000000-0000-4000-8000-000000000002";
const KEY_HEX = "c".repeat(64);
const SOURCE = "10000000-0000-4000-8000-0000000000aa";
const ATTEMPT = "10000000-0000-4000-8000-0000000000bb";
const REVISION = "10000000-0000-4000-8000-0000000000cc";
const ACTOR = "10000000-0000-4000-8000-000000000009";
const PASSWORD = "acceptance-password-sentinel";
const REDIRECT_TOKEN = "d".repeat(64);
const STUB_URL = "http://127.0.0.1:5555/v1/responses";
// Stands in for the real network below the redirect wrapper; the gate's
// attestation must be answered by the wrapper itself, never by this.
const networkFetch = vi.fn(
  async () => new Response("unexpected", { status: 200 }),
);
function markedRedirect(token = REDIRECT_TOKEN) {
  return createProviderRedirectFetch(networkFetch, STUB_URL, token);
}

type RpcCall = { name: string; args: Record<string, unknown> };
type FakeOptions = {
  user?: { id: string; email_confirmed_at: string | null } | null;
  roles?: string[];
  envId?: string;
  rpc?: (name: string, args: Record<string, unknown>) => unknown;
  signIn?: { user: { email_confirmed_at: string | null } | null } | "error";
};

function fakeSupabase(options: FakeOptions = {}) {
  const rpcCalls: RpcCall[] = [];
  const user =
    options.user === undefined
      ? { id: "auth-user", email_confirmed_at: "2026-01-01T00:00:00Z" }
      : options.user;
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: null })),
      signInWithPassword: vi.fn(async () =>
        options.signIn === "error"
          ? { data: { user: null, session: null }, error: { message: "x" } }
          : {
              data: options.signIn ?? {
                user: { email_confirmed_at: "2026-01-01T00:00:00Z" },
              },
              error: null,
            },
      ),
      signOut: vi.fn(async () => ({ error: null })),
    },
    // Only what getAuthenticatedActor() reads: the caller's own app_users
    // row and role_grants, resolved from the (fake) Auth session.
    from(table: string) {
      const result =
        table === "app_users"
          ? { data: { id: ACTOR, display_name: "Acceptance" }, error: null }
          : table === "role_grants"
            ? {
                data: (options.roles ?? []).map((role) => ({ role })),
                error: null,
              }
            : { data: null, error: { message: "unexpected table" } };
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => result,
        then: (
          resolve: (v: typeof result) => unknown,
          reject: (e: unknown) => unknown,
        ) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ name, args });
      if (name === "get_ducelio_acceptance_environment_id")
        return { data: options.envId ?? ENV_ID, error: null };
      const custom = options.rpc?.(name, args);
      if (custom !== undefined) return custom;
      return { data: null, error: { message: "unexpected rpc" } };
    }),
  };
  state.createSupabase.mockResolvedValue(client);
  return { client, rpcCalls };
}

function request(
  body: unknown,
  headers: Record<string, string | undefined> = {},
): Request {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    "content-type": "application/json",
    host: "127.0.0.1:3100",
    "x-ducelio-acceptance-driver": TOKEN,
    ...headers,
  }))
    if (v !== undefined) merged[k] = v;
  return new Request("http://127.0.0.1:3100/api/acceptance/examiner-app", {
    method: "POST",
    headers: merged,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// The driver's child process as the preload leaves it: the per-run
// redirect token configured AND the current fetch routing through the
// wrapper marked with it.
function enableDriver() {
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ENV_ID);
  vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", REDIRECT_TOKEN);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubGlobal("fetch", markedRedirect());
}
function enableHmac() {
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", KEY_ID);
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", KEY_HEX);
}

beforeEach(() => {
  state.appUrl = "http://127.0.0.1:3100";
  state.createSupabase.mockReset();
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "");
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", "");
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", "");
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  networkFetch.mockClear();
});

const recover = {
  operation: "RECOVER_EXAMINER_TARGET",
  sourceExecutionId: SOURCE,
  reason: "Acceptance recovery",
};
const regrade = {
  operation: "REGRADE_CONTROLLED_ASSESSMENT",
  resultRevisionId: REVISION,
  reason: "Acceptance regrade",
};

describe("acceptance examiner-app route: disabled by default and fail-closed", () => {
  it("answers 404 with no acceptance configuration at all, before any Supabase client exists", async () => {
    fakeSupabase();
    const response = await POST(request(recover));
    expect(response.status).toBe(404);
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it("exposes only POST -- no GET/PUT/DELETE handler exists", () => {
    expect(Object.keys(routeModule)).not.toContain("GET");
    expect(Object.keys(routeModule)).not.toContain("PUT");
    expect(Object.keys(routeModule)).not.toContain("DELETE");
  });

  const refusals: [string, () => void, Record<string, string | undefined>][] = [
    [
      "the enable flag is not exactly 'true'",
      () => vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "TRUE"),
      {},
    ],
    ["NODE_ENV is production", () => vi.stubEnv("NODE_ENV", "production"), {}],
    [
      "no per-run token is configured",
      () => vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", ""),
      {},
    ],
    [
      "the configured token is malformed",
      () => vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", "short"),
      { "x-ducelio-acceptance-driver": "short" },
    ],
    [
      "the request omits the token",
      () => {},
      { "x-ducelio-acceptance-driver": undefined },
    ],
    [
      "the request presents a different token",
      () => {},
      { "x-ducelio-acceptance-driver": "b".repeat(64) },
    ],
    [
      "ACCEPTANCE_ENVIRONMENT_ID is not configured",
      () => vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ""),
      {},
    ],
    [
      "APP_URL is a public origin",
      () => {
        state.appUrl = "https://ducelio.example";
      },
      {},
    ],
    ["the request Host is public", () => {}, { host: "ducelio.example" }],
    [
      "the request comes from a browser (Origin)",
      () => {},
      { origin: "http://127.0.0.1:3100" },
    ],
    [
      "the request comes from a browser (Sec-Fetch-Site)",
      () => {},
      { "sec-fetch-site": "same-origin" },
    ],
    // Independent-review V1 blocker: exact-process provider-redirect
    // attestation.
    [
      "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN is missing",
      () => vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", ""),
      {},
    ],
    [
      "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN is malformed",
      () => vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", "D".repeat(64)),
      {},
    ],
    [
      "the current fetch is unmarked (preload absent)",
      () => vi.stubGlobal("fetch", networkFetch),
      {},
    ],
    [
      "the current fetch is a redirect wrapper marked with a different run's token",
      () => vi.stubGlobal("fetch", markedRedirect("9".repeat(64))),
      {},
    ],
    [
      "the current fetch cannot resolve the sentinel at all (no wrapper, DNS failure)",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("fetch failed");
          }),
        ),
      {},
    ],
  ];
  it.each(refusals)(
    "answers 404, before any Supabase client exists, when %s",
    async (_label, mutate, headers) => {
      enableDriver();
      mutate();
      fakeSupabase({ roles: ["ACADEMIC_ADMIN"] });
      const response = await POST(request(recover, headers));
      expect(response.status).toBe(404);
      expect(state.createSupabase).not.toHaveBeenCalled();
    },
  );

  it("the gate admits the fully configured loopback driver request only while the CURRENT fetch is the correctly marked redirect wrapper -- answered in-process, never by the network", async () => {
    enableDriver();
    expect(await acceptanceAppDriverRequestAllowed(request(recover))).toBe(
      true,
    );
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("the attestation passes through Next.js's own fetch wrapping (real createDedupeFetch plus an outer patched-fetch layer), because it CALLS the current fetch rather than comparing identity", async () => {
    enableDriver();
    const dedupe = createDedupeFetch(markedRedirect());
    const nextPatched = (input: RequestInfo | URL, init?: RequestInit) =>
      dedupe(input, init);
    vi.stubGlobal("fetch", nextPatched);
    expect(await acceptanceAppDriverRequestAllowed(request(recover))).toBe(
      true,
    );
  });

  it("replacing globalThis.fetch after the wrapper was installed makes the route refuse again (404, before any Supabase client exists)", async () => {
    enableDriver();
    expect(await acceptanceAppDriverRequestAllowed(request(recover))).toBe(
      true,
    );
    vi.stubGlobal("fetch", networkFetch);
    fakeSupabase({ roles: ["ACADEMIC_ADMIN"] });
    const response = await POST(request(recover));
    expect(response.status).toBe(404);
    expect(state.createSupabase).not.toHaveBeenCalled();
    expect(networkFetch).toHaveBeenCalledTimes(1);
    expect(String(networkFetch.mock.calls[0]).includes(".invalid")).toBe(true);
  });
});

describe("acceptance examiner-app route: bounded input -- the caller can never supply identity, capability, provider, model or marks", () => {
  beforeEach(enableDriver);

  const smuggled: Record<string, unknown>[] = [
    { ...recover, capability: "grade_practical_lab" },
    { ...recover, targetKind: "LAB_SUBMISSION" },
    { ...recover, actorId: ACTOR },
    { ...regrade, studentId: ACTOR },
    { ...regrade, marks: [{ questionId: SOURCE, marksAwarded: 10 }] },
    { ...regrade, revisionNumber: 7 },
    { ...regrade, provider: "OPENAI_RESPONSES", model: "gpt-x" },
    { ...regrade, runtimeProfileRef: "EXAMINER_COMMERCIAL_V1" },
    {
      operation: "SUBMIT_AND_GRADE_ASSESSMENT",
      attemptId: ATTEMPT,
      studentId: ACTOR,
    },
    {
      operation: "SUBMIT_AND_GRADE_ASSESSMENT",
      attemptId: ATTEMPT,
      marks: [],
    },
    { operation: "SIGN_IN", email: "a@b.test", password: PASSWORD, roles: [] },
    { operation: "GRADE_PRACTICAL_LAB", submissionId: ATTEMPT },
    { operation: "SUBMIT_AND_GRADE_ASSESSMENT", attemptId: "not-a-uuid" },
  ];
  it.each(smuggled)(
    "rejects %j with 400 before any server function or Supabase client runs",
    async (body) => {
      fakeSupabase({ roles: ["ACADEMIC_ADMIN"] });
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(state.createSupabase).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-JSON body with 400", async () => {
    fakeSupabase();
    expect((await POST(request("not json"))).status).toBe(400);
  });
});

describe("acceptance examiner-app route: real Supabase Auth identity is required", () => {
  beforeEach(enableDriver);

  it("SIGN_IN uses the real signInWithPassword flow and returns no token or credential in the body", async () => {
    const { client } = fakeSupabase();
    const response = await POST(
      request({
        operation: "SIGN_IN",
        email: "learner@acceptance.test",
        password: PASSWORD,
      }),
    );
    expect(response.status).toBe(200);
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "learner@acceptance.test",
      password: PASSWORD,
    });
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(PASSWORD);
    expect(text.toLowerCase()).not.toContain("token");
  });

  it("SIGN_IN refuses invalid credentials (401) and an unconfirmed email (401, session signed out)", async () => {
    let { client } = fakeSupabase({ signIn: "error" });
    let response = await POST(
      request({
        operation: "SIGN_IN",
        email: "x@acceptance.test",
        password: PASSWORD,
      }),
    );
    expect(response.status).toBe(401);
    ({ client } = fakeSupabase({
      signIn: { user: { email_confirmed_at: null } },
    }));
    response = await POST(
      request({
        operation: "SIGN_IN",
        email: "x@acceptance.test",
        password: PASSWORD,
      }),
    );
    expect(response.status).toBe(401);
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("SIGN_IN against a project that does not report ACCEPTANCE_ENVIRONMENT_ID answers 404 and signs the session out", async () => {
    const { client } = fakeSupabase({
      envId: "d0000000-0000-4000-8000-000000000009",
    });
    const response = await POST(
      request({
        operation: "SIGN_IN",
        email: "x@acceptance.test",
        password: PASSWORD,
      }),
    );
    expect(response.status).toBe(404);
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("an unauthenticated caller gets 401 and nothing is executed", async () => {
    const { rpcCalls } = fakeSupabase({ user: null });
    const response = await POST(request(recover));
    expect(response.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });

  it("an authenticated session in a different environment gets 404 and nothing is executed", async () => {
    const { rpcCalls } = fakeSupabase({
      roles: ["ACADEMIC_ADMIN"],
      envId: "d0000000-0000-4000-8000-000000000009",
    });
    const response = await POST(request(recover));
    expect(response.status).toBe(404);
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "get_ducelio_acceptance_environment_id",
    ]);
  });
});

describe("acceptance examiner-app route: learners and non-admin staff cannot use it as a recovery/regrade authority bypass", () => {
  beforeEach(() => {
    enableDriver();
    enableHmac();
  });
  const identities: [string, string[]][] = [
    ["a learner", ["STUDENT"]],
    ["non-admin staff", ["INSTRUCTOR"]],
    ["a registrar", ["REGISTRAR"]],
  ];
  for (const [label, roles] of identities) {
    it(`${label} is refused by the real recoverExaminerTarget authority -- no target read, no govern call`, async () => {
      const { rpcCalls } = fakeSupabase({ roles });
      const response = await POST(request(recover));
      expect(response.status).toBe(200);
      expect((await response.json()).result).toEqual({
        status: "UNAVAILABLE",
        resultRevisionId: null,
      });
      expect(rpcCalls.map((c) => c.name)).toEqual([
        "get_ducelio_acceptance_environment_id",
      ]);
    });

    it(`${label} is refused by the real regrade authority -- no govern call`, async () => {
      const { rpcCalls } = fakeSupabase({ roles });
      const response = await POST(request(regrade));
      expect(response.status).toBe(200);
      expect((await response.json()).result).toEqual({
        status: "UNAVAILABLE",
        executionId: null,
        resultRevisionId: null,
      });
      expect(rpcCalls.map((c) => c.name)).toEqual([
        "get_ducelio_acceptance_environment_id",
      ]);
    });
  }
});

describe("acceptance examiner-app route: routes into the EXISTING production authorities, which alone sign", () => {
  beforeEach(enableDriver);

  const target = {
    sourceExecutionId: SOURCE,
    targetKind: "ASSESSMENT_ATTEMPT",
    capability: "grade_controlled_assessment",
    studentId: "10000000-0000-4000-8000-000000000001",
    enrolmentId: "10000000-0000-4000-8000-000000000002",
    activationId: "10000000-0000-4000-8000-000000000003",
    component: "QUIZ_1",
    practicalId: null,
    originalState: "FAILED",
    originalReasonCode: "PROVIDER_UNAVAILABLE",
    terminalAt: "2026-01-01T00:00:00Z",
    recoveryExecutionId: null,
    recoveryState: null,
    recoveryStatus: "ELIGIBLE",
  };

  it("an admin RECOVER resolves the target server-side, then the real recovery authority signs govern_commercial_v1_examiner_recovery", async () => {
    enableHmac();
    const { rpcCalls } = fakeSupabase({
      roles: ["ACADEMIC_ADMIN"],
      rpc: (name) =>
        name === "get_commercial_v1_examiner_recovery_target"
          ? { data: target, error: null }
          : name === "govern_commercial_v1_examiner_recovery"
            ? { data: { ok: false, code: "TARGET_NOT_ELIGIBLE" }, error: null }
            : undefined,
    });
    const response = await POST(request(recover));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).result).toEqual({
      status: "TARGET_NOT_ELIGIBLE",
      resultRevisionId: null,
    });
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "get_ducelio_acceptance_environment_id",
      "get_commercial_v1_examiner_recovery_target",
      "govern_commercial_v1_examiner_recovery",
    ]);
    const govern = rpcCalls[2].args;
    expect(govern.p_source_execution_id).toBe(SOURCE);
    // Capability comes from the server-side target read, never the caller.
    expect(govern.p_capability).toBe("grade_controlled_assessment");
    expect(govern.p_key_id).toBe(KEY_ID);
    expect(govern.p_mac).toMatch(/^[0-9a-f]{64}$/);
    // Neither the key nor the MAC ever reaches the HTTP response.
    expect(text).not.toContain(KEY_HEX);
    expect(text).not.toContain(String(govern.p_mac));
  });

  it("an admin REGRADE reaches the real regrade authority, which signs govern_commercial_v1_examiner_regrade", async () => {
    enableHmac();
    const { rpcCalls } = fakeSupabase({
      roles: ["PLATFORM_ADMIN"],
      rpc: (name) =>
        name === "govern_commercial_v1_examiner_regrade"
          ? { data: { ok: false, code: "NOT_CURRENT_RESULT" }, error: null }
          : undefined,
    });
    const response = await POST(request(regrade));
    const text = await response.text();
    expect(JSON.parse(text).result).toEqual({
      status: "NOT_CURRENT_RESULT",
      executionId: null,
      resultRevisionId: null,
    });
    const govern = rpcCalls.find(
      (c) => c.name === "govern_commercial_v1_examiner_regrade",
    )!;
    expect(govern.args.p_source_id).toBe(REVISION);
    expect(govern.args.p_capability).toBe("regrade_controlled_assessment");
    expect(govern.args.p_mac).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain(KEY_HEX);
  });

  it("without ACADEMIC_EXECUTION_* configured, recovery and regrade fail closed inside the real authorities -- no govern call", async () => {
    const { rpcCalls } = fakeSupabase({
      roles: ["ACADEMIC_ADMIN"],
      rpc: (name) =>
        name === "get_commercial_v1_examiner_recovery_target"
          ? { data: target, error: null }
          : undefined,
    });
    const recovered = await (await POST(request(recover))).json();
    const regraded = await (await POST(request(regrade))).json();
    expect(recovered.result.status).toBe("UNAVAILABLE");
    expect(regraded.result.status).toBe("UNAVAILABLE");
    expect(rpcCalls.some((c) => c.name.startsWith("govern_"))).toBe(false);
  });

  it("a learner SUBMIT_AND_GRADE runs the real submission then the real grading authority; without ACADEMIC_EXECUTION_* it fails closed to GRADING_UNAVAILABLE with no govern call", async () => {
    const { rpcCalls } = fakeSupabase({
      roles: ["STUDENT"],
      rpc: (name) =>
        name === "submit_assessment_attempt"
          ? { data: ATTEMPT, error: null }
          : undefined,
    });
    const response = await POST(
      request({ operation: "SUBMIT_AND_GRADE_ASSESSMENT", attemptId: ATTEMPT }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual({
      attemptId: ATTEMPT,
      grading: "GRADING_UNAVAILABLE",
    });
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "get_ducelio_acceptance_environment_id",
      "submit_assessment_attempt",
    ]);
  });

  it("the learner grading path with HMAC configured reaches govern_commercial_v1_examiner_execution signed by the real grading authority", async () => {
    enableHmac();
    const { rpcCalls } = fakeSupabase({
      roles: ["STUDENT"],
      rpc: (name) =>
        name === "submit_assessment_attempt"
          ? { data: ATTEMPT, error: null }
          : name === "govern_commercial_v1_examiner_execution"
            ? { data: { ok: false, code: "TARGET_NOT_ELIGIBLE" }, error: null }
            : undefined,
    });
    const response = await POST(
      request({ operation: "SUBMIT_AND_GRADE_ASSESSMENT", attemptId: ATTEMPT }),
    );
    expect((await response.json()).result.grading).toBe("GRADING_UNAVAILABLE");
    const govern = rpcCalls.find(
      (c) => c.name === "govern_commercial_v1_examiner_execution",
    )!;
    expect(govern.args.p_operation).toBe("AUTHORIZE");
    expect(govern.args.p_attempt_id).toBe(ATTEMPT);
    expect(govern.args.p_capability).toBe("grade_controlled_assessment");
    expect(govern.args.p_mac).toMatch(/^[0-9a-f]{64}$/);
  });
});
