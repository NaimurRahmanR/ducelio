import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The REAL createSupabase (src/server/supabase.ts), @supabase/ssr and
// @supabase/auth-js run here. Only Next's request cookie/header stores, the
// redirect() control flow and the network (fetch) are replaced, so the PKCE
// verifier really is generated, written through Ducelio's cookie adapter,
// carried to the callback and read back by exchangeCodeForSession.
const PROJECT_URL = "https://abcdefghijklmnop.supabase.co";
const STORAGE_KEY = "sb-abcdefghijklmnop-auth-token";
const APP_URL = "http://127.0.0.1:3000";
const AUTH_CODE = "AUTHCODE-SENTINEL-0123456789";
const ACCESS_TOKEN = "ACCESS-TOKEN-SENTINEL";
const REFRESH_TOKEN = "REFRESH-TOKEN-SENTINEL";
const DESCRIPTION = "PROVIDER-DESCRIPTION-SENTINEL";

const jar = vi.hoisted(() => ({
  cookies: new Map<
    string,
    { value: string; options?: Record<string, unknown> }
  >(),
  host: "127.0.0.1:3000",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () =>
      [...jar.cookies].map(([name, cookie]) => ({ name, value: cookie.value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (value === "" && options?.maxAge === 0) jar.cookies.delete(name);
      else jar.cookies.set(name, { value, options });
    },
  }),
  headers: async () => new Headers({ host: jar.host }),
}));
vi.mock("@/lib/env", () => ({
  config: () => ({
    url: PROJECT_URL,
    key: "publishable-test-key",
    configured: true,
    appUrl: APP_URL,
    google: true,
    linkedin: true,
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

import { oauth } from "@/app/auth/actions";
import { GET } from "@/app/auth/callback/route";

const fetchMock = vi.fn<typeof fetch>();
const consoleCalls: string[] = [];

function oauthForm(provider: string, next?: string) {
  const form = new FormData();
  form.set("provider", provider);
  if (next) form.set("next", next);
  return form;
}
async function startOAuth(provider: string, next?: string) {
  const error = await oauth(oauthForm(provider, next)).then(
    () => null,
    (e: unknown) => e as Error,
  );
  const location = error?.message.startsWith("REDIRECT:")
    ? error.message.slice("REDIRECT:".length)
    : null;
  if (!location) throw new Error("oauth() did not redirect");
  return new URL(location);
}
// The mocked next/headers jar IS the callback request's cookie store (the
// route's Supabase client reads it); the Cookie header mirrors it for the
// route's own diagnostic. "without cookies" models a browser that did not
// send the verifier (e.g. a flow begun on another host).
function callbackRequest(query: string, cookies: "with" | "without" = "with") {
  if (cookies === "without") jar.cookies.clear();
  return new NextRequest(`${APP_URL}/auth/callback?${query}`, {
    headers: { host: "127.0.0.1:3000", cookie: cookieHeaderFromJar() },
  });
}
function cookieHeaderFromJar() {
  return [...jar.cookies]
    .map(([name, cookie]) => `${name}=${cookie.value}`)
    .join("; ");
}
function verifierCookies() {
  return [...jar.cookies.keys()].filter((name) =>
    name.endsWith("-code-verifier"),
  );
}
function storedVerifier() {
  const raw = jar.cookies.get(`${STORAGE_KEY}-code-verifier`)?.value ?? "";
  // @supabase/ssr's default base64url cookie encoding of a JSON string.
  const json = raw.startsWith("base64-")
    ? Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8")
    : raw;
  return JSON.parse(json) as string;
}
function tokenResponse() {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      access_token: ACCESS_TOKEN,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: REFRESH_TOKEN,
      user: {
        id: "00000000-0000-4000-8000-0000000000a1",
        aud: "authenticated",
        role: "authenticated",
        email: "learner@example.test",
        email_confirmed_at: "2026-01-01T00:00:00Z",
        app_metadata: { provider: "google" },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function tokenCalls() {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/auth/v1/token"),
  );
}
function diagnostics() {
  return consoleCalls
    .filter((line) => line.startsWith("[ducelio:oauth-diagnostic]"))
    .map((line) =>
      JSON.parse(line.slice("[ducelio:oauth-diagnostic] ".length)),
    );
}

beforeEach(() => {
  jar.cookies.clear();
  jar.host = "127.0.0.1:3000";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => tokenResponse());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NODE_ENV", "development");
  consoleCalls.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OAuth start: Google and LinkedIn share one PKCE server-action mechanism", () => {
  it.each([
    ["google", null],
    ["linkedin_oidc", "openid profile email"],
  ])(
    "%s: the server action persists the PKCE verifier cookies and redirects to Supabase authorize with an S256 challenge and the APP_URL callback",
    async (provider, scopes) => {
      const authorize = await startOAuth(provider, "/courses");

      expect(authorize.origin).toBe(PROJECT_URL);
      expect(authorize.pathname).toBe("/auth/v1/authorize");
      expect(authorize.searchParams.get("provider")).toBe(provider);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
      expect(authorize.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(authorize.searchParams.get("scopes")).toBe(scopes);
      expect(authorize.searchParams.get("redirect_to")).toBe(
        `${APP_URL}/auth/callback?next=%2Fcourses`,
      );

      // The fixed legacy key, the flow's own slot and the flow index.
      expect(verifierCookies()).toEqual(
        expect.arrayContaining([
          `${STORAGE_KEY}-code-verifier`,
          `${STORAGE_KEY}-flows-code-verifier`,
          expect.stringMatching(
            new RegExp(`^${STORAGE_KEY}-flow-[0-9a-f]{32}-code-verifier$`),
          ),
        ]),
      );
      for (const name of verifierCookies())
        expect(jar.cookies.get(name)?.options).toMatchObject({
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: false,
        });
      expect(storedVerifier()).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      // signInWithOAuth builds the URL locally: nothing is sent anywhere.
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("an unavailable provider never starts a flow or writes a verifier", async () => {
    await expect(oauth(oauthForm("github"))).rejects.toThrow(
      "REDIRECT:/login?error=provider-unavailable",
    );
    expect(jar.cookies.size).toBe(0);
  });
});

describe("OAuth callback: real PKCE exchange", () => {
  it("exchanges a valid code with the verifier the server action stored, then signs in", async () => {
    await startOAuth("google");
    const verifier = storedVerifier();

    const response = await GET(
      callbackRequest(`code=${AUTH_CODE}&next=/courses`),
    );

    expect(response.headers.get("location")).toBe(`${APP_URL}/courses`);
    const [[input, init]] = tokenCalls();
    expect(String(input)).toBe(`${PROJECT_URL}/auth/v1/token?grant_type=pkce`);
    expect(JSON.parse(String(init?.body))).toEqual({
      auth_code: AUTH_CODE,
      code_verifier: verifier,
    });
    // The session is written; the consumed verifier is cleared.
    expect(jar.cookies.has(STORAGE_KEY)).toBe(true);
    expect(jar.cookies.has(`${STORAGE_KEY}-code-verifier`)).toBe(false);
  });

  it("also exchanges with an explicit sb_flow_id that names the stored slot", async () => {
    await startOAuth("linkedin_oidc");
    const flowId = verifierCookies()
      .map((name) => /-flow-([0-9a-f]{32})-code-verifier$/.exec(name)?.[1])
      .find(Boolean);
    const verifier = storedVerifier();

    const response = await GET(
      callbackRequest(`code=${AUTH_CODE}&sb_flow_id=${flowId}`),
    );

    expect(response.headers.get("location")).toBe(`${APP_URL}/student`);
    expect(JSON.parse(String(tokenCalls()[0][1]?.body)).code_verifier).toBe(
      verifier,
    );
  });

  it("fails closed with the generic error when the verifier cookie is absent (e.g. the flow began on another host): no exchange request, no session", async () => {
    await startOAuth("google");

    const response = await GET(callbackRequest(`code=${AUTH_CODE}`, "without"));

    expect(response.headers.get("location")).toBe(
      `${APP_URL}/login?error=link-expired`,
    );
    expect(tokenCalls()).toHaveLength(0);
    expect(jar.cookies.has(STORAGE_KEY)).toBe(false);
  });

  it.each([
    [400, "flow_state_not_found"],
    [400, "bad_code_verifier"],
    [500, "unexpected_failure"],
  ])(
    "fails closed with the generic error when Supabase rejects the exchange (HTTP %i %s)",
    async (status, code) => {
      await startOAuth("google");
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ code, message: DESCRIPTION }), {
            status,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          }),
      );

      const response = await GET(callbackRequest(`code=${AUTH_CODE}`));

      expect(response.headers.get("location")).toBe(
        `${APP_URL}/login?error=link-expired`,
      );
      expect(jar.cookies.has(STORAGE_KEY)).toBe(false);
    },
  );

  it.each([
    "https://outside.example/student",
    "//outside.example",
    "/\\outside.example",
    "/admin",
  ])(
    "an arbitrary next target (%s) is never followed after a successful exchange",
    async (next) => {
      await startOAuth("google");
      const response = await GET(
        callbackRequest(`code=${AUTH_CODE}&next=${encodeURIComponent(next)}`),
      );
      expect(response.headers.get("location")).toBe(`${APP_URL}/student`);
    },
  );
});

describe("OAuth diagnostics: bounded, development-only, never secret", () => {
  it("records one bounded start line and one bounded callback line for a successful Google flow", async () => {
    await startOAuth("google");
    await GET(callbackRequest(`code=${AUTH_CODE}`));

    expect(diagnostics()).toEqual([
      {
        stage: "start",
        provider: "google",
        requestHostMatchesAppUrl: true,
        verifierCookieWritten: true,
        authorizeUrlReturned: true,
        errorName: null,
        errorCode: null,
        errorStatus: null,
      },
      {
        stage: "callback",
        outcome: "EXCHANGED",
        hasCode: true,
        hasFlowId: false,
        providerError: null,
        providerErrorCode: null,
        requestHostMatchesAppUrl: true,
        verifierCookiePresent: true,
        sessionCookiePresent: false,
        errorName: null,
        errorCode: null,
        errorStatus: null,
      },
    ]);
  });

  it("identifies a flow started on a host other than APP_URL and the resulting missing verifier", async () => {
    jar.host = "localhost:3000";
    await startOAuth("google");
    await GET(callbackRequest(`code=${AUTH_CODE}`, "without"));

    const [start, callback] = diagnostics();
    expect(start).toMatchObject({ requestHostMatchesAppUrl: false });
    expect(callback).toMatchObject({
      outcome: "VERIFIER_MISSING",
      hasCode: true,
      verifierCookiePresent: false,
      errorName: "AuthPKCECodeVerifierMissingError",
      errorCode: "pkce_code_verifier_not_found",
      errorStatus: 400,
    });
  });

  it("classifies a Supabase rejection by its bounded code and HTTP status only", async () => {
    await startOAuth("linkedin_oidc");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: "flow_state_not_found",
            message: DESCRIPTION,
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    );
    await GET(callbackRequest(`code=${AUTH_CODE}`));

    expect(diagnostics()[1]).toMatchObject({
      outcome: "EXCHANGE_REJECTED",
      errorName: "AuthApiError",
      errorCode: "flow_state_not_found",
      errorStatus: 400,
    });
  });

  it("classifies a Supabase 5xx answer as a server error and a rejected fetch as transport, by status only", async () => {
    await startOAuth("google");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ code: "unexpected_failure", message: DESCRIPTION }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    );
    await GET(callbackRequest(`code=${AUTH_CODE}`));

    await startOAuth("google");
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed ${DESCRIPTION}`);
    });
    await GET(callbackRequest(`code=${AUTH_CODE}`));

    const callbacks = diagnostics().filter((d) => d.stage === "callback");
    expect(callbacks[0]).toMatchObject({
      outcome: "EXCHANGE_SERVER_ERROR",
      errorName: "AuthRetryableFetchError",
      errorStatus: 500,
    });
    expect(callbacks[1]).toMatchObject({
      outcome: "EXCHANGE_TRANSPORT",
      errorName: "AuthRetryableFetchError",
      errorStatus: 0,
    });
    expect(consoleCalls.join("\n")).not.toContain(DESCRIPTION);
  });

  it("records a provider/Supabase error redirect by its bounded codes, never its description", async () => {
    await GET(
      callbackRequest(
        `error=server_error&error_code=unexpected_failure&error_description=${DESCRIPTION}`,
      ),
    );
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        stage: "callback",
        outcome: "PROVIDER_ERROR",
        hasCode: false,
        providerError: "server_error",
        providerErrorCode: "unexpected_failure",
        errorName: null,
      }),
    ]);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("drops unbounded provider error values instead of logging them", async () => {
    await GET(
      callbackRequest(
        `error=${encodeURIComponent("Bad Thing <script>")}&error_code=${"x".repeat(80)}`,
      ),
    );
    expect(diagnostics()[0]).toMatchObject({
      providerError: null,
      providerErrorCode: null,
    });
  });

  it("never logs the authorization code, verifier, flow id, tokens, cookie values, description or callback URL on any path", async () => {
    await startOAuth("google", "/courses");
    const verifier = storedVerifier();
    const cookieValues = [...jar.cookies.values()].map((c) => c.value);
    const flowId = verifierCookies()
      .map((name) => /-flow-([0-9a-f]{32})-code-verifier$/.exec(name)?.[1])
      .find(Boolean) as string;
    await GET(
      callbackRequest(`code=${AUTH_CODE}&sb_flow_id=${flowId}&next=/courses`),
    );
    await GET(callbackRequest(`code=${AUTH_CODE}`, "without"));
    await GET(
      callbackRequest(`error=access_denied&error_description=${DESCRIPTION}`),
    );

    const output = consoleCalls.join("\n");
    expect(diagnostics()).toHaveLength(4);
    for (const secret of [
      AUTH_CODE,
      verifier,
      flowId,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      DESCRIPTION,
      ...cookieValues,
      "/auth/callback",
      "code=",
      "127.0.0.1",
      "localhost",
      PROJECT_URL,
    ])
      expect(output).not.toContain(secret);
  });

  it.each(["production", "test"])(
    "is silent when NODE_ENV is %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      await startOAuth("google");
      await GET(callbackRequest(`code=${AUTH_CODE}`, "without"));
      expect(diagnostics()).toEqual([]);
    },
  );

  it("the public callback response never carries diagnostic detail", async () => {
    await startOAuth("google");
    const response = await GET(callbackRequest(`code=${AUTH_CODE}`, "without"));
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/login?error=link-expired`,
    );
    expect(await response.text()).not.toMatch(
      /AuthPKCE|pkce_code_verifier|VERIFIER_MISSING|diagnostic/,
    );
  });
});
