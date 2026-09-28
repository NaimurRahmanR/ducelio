import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// src/app/api/acceptance/stripe-app/route.ts and
// src/server/stripe-acceptance-driver.ts -- the acceptance-only HTTP hop
// `npm run acceptance:stripe` uses to reach the EXISTING production
// createCommercialV1Checkout / reconcileCommercialV1Order.
//
// ZERO network: the Supabase boundary (@/server/supabase) is a fake, the two
// production commerce entrypoints are spies (their own behaviour is covered
// by tests/commercial-v1-commerce-server.test.ts), and globalThis.fetch
// throws if anything tries to reach Stripe or anywhere else.
// ============================================================================

const state = vi.hoisted(() => ({
  appUrl: "http://127.0.0.1:3300",
  createSupabase: vi.fn(),
  createCheckout: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({ createSupabase: state.createSupabase }));
vi.mock("@/server/commercial-v1-commerce", () => ({
  createCommercialV1Checkout: state.createCheckout,
  reconcileCommercialV1Order: state.reconcile,
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

import { POST } from "@/app/api/acceptance/stripe-app/route";
import {
  STRIPE_ACCEPTANCE_DRIVER_HEADER,
  STRIPE_TEST_SECRET_KEY_SHAPE,
  stripeAcceptanceRequestAllowed,
} from "@/server/stripe-acceptance-driver";
import { AccessDenied } from "@/domain/policy";
import {
  DRIVER_HEADER,
  ROUTE_PATH,
  STRIPE_TEST_SECRET_KEY,
} from "../scripts/acceptance/stripe.mjs";

const TOKEN = "b".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const TEST_KEY = "sk_test_" + "A1".repeat(12);
const ORDER = "10000000-0000-4000-8000-0000000000aa";
const SESSION = "cs_test_a1B2c3D4e5";
const PASSWORD = "acceptance-password-sentinel";

const networkFetch = vi.fn(async () => {
  throw new Error("Unexpected network request in a zero-traffic test.");
});

function fakeSupabase(
  options: {
    user?: { id: string } | null;
    envId?: string;
    signInError?: boolean;
  } = {},
) {
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.user === undefined ? { id: "u" } : options.user },
        error: null,
      })),
      signInWithPassword: vi.fn(async () =>
        options.signInError
          ? { data: { user: null }, error: { message: "denied" } }
          : {
              data: { user: { email_confirmed_at: "2026-01-01T00:00:00Z" } },
              error: null,
            },
      ),
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc: vi.fn(async (name: string) =>
      name === "get_ducelio_acceptance_environment_id"
        ? { data: options.envId ?? ENV_ID, error: null }
        : { data: null, error: { message: "unexpected rpc" } },
    ),
  };
  state.createSupabase.mockResolvedValue(client);
  return client;
}

function enableGate() {
  vi.stubEnv("ACCEPTANCE_STRIPE_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_STRIPE_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_STRIPE_TEST_OPT_IN", "true");
  vi.stubEnv("ACCEPTANCE_STRIPE_AUTHORIZED", "true");
  vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ENV_ID);
  vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
  vi.stubEnv("NODE_ENV", "test");
}

function request(
  body: unknown,
  headers: Record<string, string | undefined> = {},
): Request {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    "content-type": "application/json",
    host: "127.0.0.1:3300",
    [STRIPE_ACCEPTANCE_DRIVER_HEADER]: TOKEN,
    ...headers,
  }))
    if (v !== undefined) merged[k] = v;
  return new Request(`http://127.0.0.1:3300${ROUTE_PATH}`, {
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
  state.appUrl = "http://127.0.0.1:3300";
  state.createSupabase.mockReset();
  state.createCheckout.mockReset();
  state.reconcile.mockReset();
  networkFetch.mockClear();
  vi.stubGlobal("fetch", networkFetch);
  for (const name of [
    "ACCEPTANCE_STRIPE_DRIVER_ENABLED",
    "ACCEPTANCE_STRIPE_DRIVER_TOKEN",
    "ACCEPTANCE_STRIPE_TEST_OPT_IN",
    "ACCEPTANCE_STRIPE_AUTHORIZED",
    "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
    "ACCEPTANCE_ENVIRONMENT_ID",
    "ACCEPTANCE_APP_DRIVER_ENABLED",
    "ACCEPTANCE_APP_DRIVER_TOKEN",
    "ACCEPTANCE_PROVIDER_STUB_URL",
    "ACCEPTANCE_PROVIDER_REDIRECT_TOKEN",
    "ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED",
    "ACCEPTANCE_LIVE_PROVIDER_DRIVER_TOKEN",
    "ACCEPTANCE_LIVE_PROVIDER_AUTHORIZED",
    "STRIPE_SECRET_KEY",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Stripe acceptance route gate: 404 unless every condition holds (F)", () => {
  it("answers 404 with no acceptance configuration, without reading the body or touching Supabase/commerce", async () => {
    const req = request({ operation: "CREATE_CHECKOUT", offerSlug: "abc" });
    const response = await POST(req);
    expect(response.status).toBe(404);
    expect(req.bodyUsed).toBe(false);
    expect(state.createSupabase).not.toHaveBeenCalled();
    expect(state.createCheckout).not.toHaveBeenCalled();
  });

  const refusals: [string, () => void, Record<string, string | undefined>][] = [
    [
      "driver not enabled",
      () => vi.stubEnv("ACCEPTANCE_STRIPE_DRIVER_ENABLED", "false"),
      {},
    ],
    ["production NODE_ENV", () => vi.stubEnv("NODE_ENV", "production"), {}],
    [
      "malformed per-run token",
      () => vi.stubEnv("ACCEPTANCE_STRIPE_DRIVER_TOKEN", "short"),
      { [STRIPE_ACCEPTANCE_DRIVER_HEADER]: "short" },
    ],
    [
      "wrong driver header",
      () => {},
      { [STRIPE_ACCEPTANCE_DRIVER_HEADER]: "c".repeat(64) },
    ],
    [
      "missing driver header",
      () => {},
      { [STRIPE_ACCEPTANCE_DRIVER_HEADER]: undefined },
    ],
    [
      "test opt-in not exactly 'true'",
      () => vi.stubEnv("ACCEPTANCE_STRIPE_TEST_OPT_IN", "TRUE"),
      {},
    ],
    [
      "CLI authorization not propagated",
      () => vi.stubEnv("ACCEPTANCE_STRIPE_AUTHORIZED", ""),
      {},
    ],
    [
      "live-mode Stripe key in the process",
      () => vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_" + "A1".repeat(12)),
      {},
    ],
    ["no Stripe key", () => vi.stubEnv("STRIPE_SECRET_KEY", ""), {}],
    [
      "malformed environment id",
      () => vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", "not-a-uuid"),
      {},
    ],
    [
      "ACCEPTANCE_STRIPE_LIVE_OPT_IN present",
      () => vi.stubEnv("ACCEPTANCE_STRIPE_LIVE_OPT_IN", "true"),
      {},
    ],
    [
      "examiner-app driver marker present",
      () => vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true"),
      {},
    ],
    [
      "live-provider driver marker present",
      () => vi.stubEnv("ACCEPTANCE_LIVE_PROVIDER_DRIVER_ENABLED", "true"),
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
    ["browser Origin", () => {}, { origin: "http://127.0.0.1:3300" }],
    ["browser Sec-Fetch-Site", () => {}, { "sec-fetch-site": "same-origin" }],
  ];
  for (const [label, arrange, headers] of refusals) {
    it(`404 when ${label}`, async () => {
      enableGate();
      arrange();
      fakeSupabase();
      const req = request(
        { operation: "CREATE_CHECKOUT", offerSlug: "abc" },
        headers,
      );
      const response = await POST(req);
      expect(response.status).toBe(404);
      expect(req.bodyUsed).toBe(false);
      expect(state.createSupabase).not.toHaveBeenCalled();
      expect(state.createCheckout).not.toHaveBeenCalled();
    });
  }

  it("admits the driver when every condition holds (strict validation then answers 400 for an empty body)", async () => {
    enableGate();
    expect(stripeAcceptanceRequestAllowed(request({}))).toBe(true);
    const result = await callRoute({});
    expect(result.status).toBe(400);
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it("404 when the caller's hosted session does not report ACCEPTANCE_ENVIRONMENT_ID", async () => {
    enableGate();
    fakeSupabase({ envId: "a0000000-0000-4000-8000-000000000999" });
    const result = await callRoute({
      operation: "CREATE_CHECKOUT",
      offerSlug: "abc",
    });
    expect(result.status).toBe(404);
    expect(state.createCheckout).not.toHaveBeenCalled();
  });

  it("the gate's key shape, header and route path are pinned equal to the driver's", () => {
    expect(STRIPE_TEST_SECRET_KEY_SHAPE.source).toBe(
      STRIPE_TEST_SECRET_KEY.source,
    );
    expect(STRIPE_ACCEPTANCE_DRIVER_HEADER).toBe(DRIVER_HEADER);
    expect(ROUTE_PATH).toBe("/api/acceptance/stripe-app");
  });
});

describe("Stripe acceptance route: strict schemas reject caller-supplied authority (G)", () => {
  const forbidden: [string, Record<string, unknown>][] = [
    ["amount", { amountMinor: 1 }],
    ["amount (alt)", { amount: 1 }],
    ["currency", { currency: "USD" }],
    ["learner id", { learnerId: ORDER }],
    ["student id", { studentId: ORDER }],
    ["actor id", { actorId: ORDER }],
    ["entitlement id", { entitlementId: ORDER }],
    ["activation override", { activationId: ORDER }],
    ["cohort override", { cohortId: ORDER }],
    ["provider", { provider: "STRIPE" }],
    ["Stripe key", { stripeSecretKey: TEST_KEY }],
    ["webhook secret", { webhookSecret: "whsec_x" }],
    ["HMAC", { mac: "f".repeat(64) }],
    ["arbitrary URL", { successUrl: "https://evil.example.com" }],
    ["arbitrary function", { rpc: "fulfill_commercial_v1_order" }],
  ];
  for (const [label, extra] of forbidden) {
    it(`CREATE_CHECKOUT rejects a caller-supplied ${label} with 400 before any server function runs`, async () => {
      enableGate();
      fakeSupabase();
      const result = await callRoute({
        operation: "CREATE_CHECKOUT",
        offerSlug: "acceptance-stripe-paid-x",
        ...extra,
      });
      expect(result.status).toBe(400);
      expect(state.createSupabase).not.toHaveBeenCalled();
      expect(state.createCheckout).not.toHaveBeenCalled();
    });
    it(`RECONCILE_ORDER rejects a caller-supplied ${label} with 400`, async () => {
      enableGate();
      fakeSupabase();
      const result = await callRoute({
        operation: "RECONCILE_ORDER",
        orderId: ORDER,
        sessionId: SESSION,
        ...extra,
      });
      expect(result.status).toBe(400);
      expect(state.reconcile).not.toHaveBeenCalled();
    });
  }

  it("rejects unknown operations, including any generic commerce executor", async () => {
    enableGate();
    for (const operation of [
      "FULFILL_ORDER",
      "CREATE_CAMPAIGN",
      "PUBLISH_OFFER",
      "RUN_RPC",
      "WEBHOOK",
    ]) {
      const result = await callRoute({ operation });
      expect(result.status).toBe(400);
    }
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it("RECONCILE_ORDER accepts only Stripe TEST-mode session ids", async () => {
    enableGate();
    fakeSupabase();
    for (const sessionId of ["cs_live_a1B2c3", "pi_test_1", "", "cs_test_"]) {
      const result = await callRoute({
        operation: "RECONCILE_ORDER",
        orderId: ORDER,
        sessionId,
      });
      expect(result.status).toBe(400);
    }
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("CREATE_CHECKOUT rejects a malformed slug or campaign code", async () => {
    enableGate();
    fakeSupabase();
    for (const extra of [
      { offerSlug: "Bad Slug!" },
      { offerSlug: "abc", campaignCode: "x" },
      { offerSlug: "abc", campaignCode: 0 },
    ]) {
      const result = await callRoute({
        operation: "CREATE_CHECKOUT",
        ...extra,
      });
      expect(result.status).toBe(400);
    }
    expect(state.createCheckout).not.toHaveBeenCalled();
  });
});

describe("Stripe acceptance route: thin hop into existing production entrypoints only (H)", () => {
  it("SIGN_IN uses the real SSR sign-in and never echoes credentials or tokens", async () => {
    enableGate();
    const client = fakeSupabase();
    const result = await callRoute({
      operation: "SIGN_IN",
      email: "learner@acceptance.test",
      password: PASSWORD,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(client.auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(result.text).not.toContain(PASSWORD);
  });

  it("SIGN_IN into a project that does not report the environment id signs out and answers 404", async () => {
    enableGate();
    const client = fakeSupabase({
      envId: "a0000000-0000-4000-8000-000000000999",
    });
    const result = await callRoute({
      operation: "SIGN_IN",
      email: "learner@acceptance.test",
      password: PASSWORD,
    });
    expect(result.status).toBe(404);
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("CREATE_CHECKOUT calls createCommercialV1Checkout with only the slug and optional code, and returns bounded fields", async () => {
    enableGate();
    fakeSupabase();
    state.createCheckout.mockResolvedValue({
      ok: true,
      kind: "CHECKOUT",
      url: `https://checkout.stripe.com/c/pay/${SESSION}`,
      orderId: ORDER,
    });
    const result = await callRoute({
      operation: "CREATE_CHECKOUT",
      offerSlug: "acceptance-stripe-paid-x",
    });
    expect(state.createCheckout).toHaveBeenCalledTimes(1);
    expect(state.createCheckout).toHaveBeenCalledWith(
      "acceptance-stripe-paid-x",
      undefined,
    );
    expect(result.body).toEqual({
      ok: true,
      result: {
        ok: true,
        kind: "CHECKOUT",
        orderId: ORDER,
        url: `https://checkout.stripe.com/c/pay/${SESSION}`,
      },
    });
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("CREATE_CHECKOUT forwards a campaign code and maps ACCESS_GRANTED / denial results", async () => {
    enableGate();
    fakeSupabase();
    state.createCheckout.mockResolvedValueOnce({
      ok: true,
      kind: "ACCESS_GRANTED",
      entitlementId: ORDER,
      enrolmentId: ORDER,
      offerSlug: "abc",
    });
    const granted = await callRoute({
      operation: "CREATE_CHECKOUT",
      offerSlug: "abc",
      campaignCode: "rev-123x",
    });
    expect(state.createCheckout).toHaveBeenLastCalledWith("abc", "REV-123X");
    expect(granted.body.result).toEqual({
      ok: true,
      kind: "ACCESS_GRANTED",
      entitlementId: ORDER,
      enrolmentId: ORDER,
      offerSlug: "abc",
    });
    state.createCheckout.mockResolvedValueOnce({
      ok: false,
      code: "CODE_UNAVAILABLE",
    });
    const denied = await callRoute({
      operation: "CREATE_CHECKOUT",
      offerSlug: "abc",
      campaignCode: "ZPF-1",
    });
    expect(denied.body.result).toEqual({ ok: false, code: "CODE_UNAVAILABLE" });
  });

  it("RECONCILE_ORDER calls reconcileCommercialV1Order with exactly orderId and sessionId", async () => {
    enableGate();
    fakeSupabase();
    state.reconcile.mockResolvedValue({
      ok: true,
      fulfilled: false,
      code: "NOT_PAID",
      orderId: ORDER,
    });
    const result = await callRoute({
      operation: "RECONCILE_ORDER",
      orderId: ORDER,
      sessionId: SESSION,
    });
    expect(state.reconcile).toHaveBeenCalledWith({
      orderId: ORDER,
      sessionId: SESSION,
    });
    expect(result.body.result).toEqual({
      ok: true,
      fulfilled: false,
      replay: null,
      code: "NOT_PAID",
      orderId: ORDER,
    });
  });

  it("operations without a real session answer 401; production AccessDenied answers 403", async () => {
    enableGate();
    fakeSupabase({ user: null });
    expect(
      (await callRoute({ operation: "CREATE_CHECKOUT", offerSlug: "abc" }))
        .status,
    ).toBe(401);
    expect(state.createCheckout).not.toHaveBeenCalled();
    fakeSupabase();
    state.createCheckout.mockRejectedValue(new AccessDenied());
    expect(
      (await callRoute({ operation: "CREATE_CHECKOUT", offerSlug: "abc" }))
        .status,
    ).toBe(403);
  });

  it("the route source imports only the two production commerce entrypoints and never Stripe, keys or fulfillment", () => {
    const source = readFileSync(
      "src/app/api/acceptance/stripe-app/route.ts",
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(
      /import \{\s*createCommercialV1Checkout,\s*reconcileCommercialV1Order,\s*\} from "@\/server\/commercial-v1-commerce";/,
    );
    for (const forbidden of [
      '"stripe"',
      "commerceConfig",
      "attestCommerceFulfillment",
      "fulfill_commercial_v1_order",
      "getCommerceProvider",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "COMMERCE_CONTROLLER",
      "createHmac",
      ".rpc(",
      "stripe-webhook",
    ])
      expect(code).not.toContain(forbidden);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
