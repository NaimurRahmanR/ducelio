import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// src/app/api/acceptance/customer-journey/route.ts -- the acceptance-only
// HTTP hop scripts/acceptance/customer-journey.mjs uses to reach EXISTING
// production learner entrypoints inside a real Next.js request.
//
// Only the external Supabase boundary (@/server/supabase) and @/lib/env's
// APP_URL are replaced. Everything behind the route (identity resolution,
// createCommercialV1Checkout, the response-writer composition, progress and
// completion) is the real production code.
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
    commerceConfig: () => ({ configured: false }),
  };
});

import { POST } from "@/app/api/acceptance/customer-journey/route";
import { customerJourneyRequestAllowed } from "@/server/acceptance-journey-driver";
import { createProviderRedirectFetch } from "../scripts/acceptance/examiner-provider-stub.mjs";

const TOKEN = "a".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const REDIRECT_TOKEN = "d".repeat(64);
const STUB_URL = "http://127.0.0.1:5555/v1/responses";
const ACTOR = "10000000-0000-4000-8000-000000000009";
const ENROLMENT = "10000000-0000-4000-8000-0000000000ee";
const ATTEMPT = "10000000-0000-4000-8000-0000000000bb";
const QUESTION = "10000000-0000-4000-8000-0000000000cc";
const ENTITLEMENT = "10000000-0000-4000-8000-0000000000aa";
const ACTIVATION = "10000000-0000-4000-8000-0000000000ab";
const networkFetch = vi.fn(
  async () => new Response("unexpected", { status: 200 }),
);

type RpcCall = { name: string; args: Record<string, unknown> };
function fakeSupabase(
  options: {
    user?: { id: string; email_confirmed_at: string | null } | null;
    roles?: string[];
    envId?: string;
    rpc?: (name: string, args: Record<string, unknown>) => unknown;
  } = {},
) {
  const rpcCalls: RpcCall[] = [];
  const user =
    options.user === undefined
      ? { id: "auth-user", email_confirmed_at: "2026-01-01T00:00:00Z" }
      : options.user;
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    from(table: string) {
      const result =
        table === "app_users"
          ? { data: { id: ACTOR, display_name: "Acceptance" }, error: null }
          : table === "role_grants"
            ? {
                data: (options.roles ?? ["STUDENT"]).map((role) => ({ role })),
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
) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    "content-type": "application/json",
    host: "127.0.0.1:3100",
    "x-ducelio-acceptance-driver": TOKEN,
    ...headers,
  }))
    if (v !== undefined) merged[k] = v;
  return new Request("http://127.0.0.1:3100/api/acceptance/customer-journey", {
    method: "POST",
    headers: merged,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function enableDriver({ journey = true, redirect = true } = {}) {
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ENV_ID);
  vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", REDIRECT_TOKEN);
  vi.stubEnv("ACCEPTANCE_JOURNEY_DRIVER_ENABLED", journey ? "true" : "");
  vi.stubEnv("NODE_ENV", "test");
  if (redirect)
    vi.stubGlobal(
      "fetch",
      createProviderRedirectFetch(networkFetch, STUB_URL, REDIRECT_TOKEN),
    );
}

beforeEach(() => {
  state.appUrl = "http://127.0.0.1:3100";
  state.createSupabase.mockReset();
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "");
  vi.stubEnv("ACCEPTANCE_JOURNEY_DRIVER_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  networkFetch.mockClear();
});

const progress = { operation: "GET_PROGRESS", enrolmentId: ENROLMENT };

describe("customer-journey route: disabled by default and fail-closed", () => {
  it("answers 404 with no acceptance configuration, before any Supabase client exists", async () => {
    fakeSupabase();
    expect((await POST(request(progress))).status).toBe(404);
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it("answers 404 when the examiner-app gate is satisfied but the journey marker is absent (another driver's child)", async () => {
    enableDriver({ journey: false });
    fakeSupabase();
    expect((await POST(request(progress))).status).toBe(404);
    expect(await customerJourneyRequestAllowed(request(progress))).toBe(false);
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it("answers 404 when the provider redirect is not attested live in this process, even with the journey marker", async () => {
    enableDriver({ redirect: false });
    vi.stubGlobal("fetch", networkFetch);
    fakeSupabase();
    expect((await POST(request(progress))).status).toBe(404);
    expect(state.createSupabase).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong token", { "x-ducelio-acceptance-driver": "b".repeat(64) }],
    ["a browser Origin", { origin: "http://127.0.0.1:3100" }],
    ["a non-loopback Host", { host: "ducelio.example" }],
  ])("answers 404 for %s", async (_label, headers) => {
    enableDriver();
    fakeSupabase();
    expect((await POST(request(progress, headers))).status).toBe(404);
  });

  it("answers 404 when the caller's hosted project does not report this acceptance environment", async () => {
    enableDriver();
    fakeSupabase({ envId: "a0000000-0000-4000-8000-000000000099" });
    expect((await POST(request(progress))).status).toBe(404);
  });

  it("answers 401 without a real session", async () => {
    enableDriver();
    fakeSupabase({ user: null });
    expect((await POST(request(progress))).status).toBe(401);
  });
});

describe("customer-journey route: strict finite operation union", () => {
  it.each([
    ["unknown operation", { operation: "DELETE_EVERYTHING" }],
    [
      "sign-in is not on this route",
      { operation: "SIGN_IN", email: "a@b.c", password: "x" },
    ],
    [
      "grading is not on this route",
      { operation: "SUBMIT_AND_GRADE_ASSESSMENT", attemptId: ATTEMPT },
    ],
    [
      "recovery is not on this route",
      {
        operation: "RECOVER_EXAMINER_TARGET",
        sourceExecutionId: ATTEMPT,
        reason: "x",
      },
    ],
    [
      "checkout without a reviewer code",
      { operation: "CREATE_CHECKOUT", offerSlug: "acceptance-journey-x" },
    ],
    [
      "smuggled learner id on checkout",
      {
        operation: "CREATE_CHECKOUT",
        offerSlug: "acceptance-journey-x",
        campaignCode: "JRN-ABCD",
        learnerId: ACTOR,
      },
    ],
    [
      "smuggled price on checkout",
      {
        operation: "CREATE_CHECKOUT",
        offerSlug: "acceptance-journey-x",
        campaignCode: "JRN-ABCD",
        priceAmountMinor: 0,
      },
    ],
    [
      "smuggled student id on a response",
      {
        operation: "RECORD_RESPONSE",
        attemptId: ATTEMPT,
        questionId: QUESTION,
        body: "x",
        idempotencyKey: "k".repeat(10),
        studentId: ACTOR,
      },
    ],
    [
      "smuggled marks on a lab submission",
      {
        operation: "SUBMIT_LAB_AND_GRADE",
        enrolmentId: ENROLMENT,
        practicalId: QUESTION,
        body: "x",
        idempotencyKey: "k".repeat(10),
        marksAwarded: 10,
      },
    ],
    [
      "smuggled role/capability on Tutor/Lab",
      {
        operation: "TUTOR_LAB_SUPPORT",
        handoffId: ATTEMPT,
        message: "x",
        idempotencyKey: ATTEMPT,
        role: "EXAMINER",
      },
    ],
    [
      "smuggled score on completion",
      {
        operation: "ATTEMPT_COMPLETION",
        enrolmentId: ENROLMENT,
        reason: "Completion",
        courseScoreBp: 10000,
      },
    ],
    [
      "smuggled provider on the Professor",
      {
        operation: "PROFESSOR_ASK",
        classSessionId: ATTEMPT,
        idempotencyKey: "k".repeat(10),
        message: "x",
        model: "gpt",
      },
    ],
    [
      "a malformed id",
      { operation: "GET_PROGRESS", enrolmentId: "not-a-uuid" },
    ],
  ])(
    "rejects %s with 400 before any Supabase client exists",
    async (_label, body) => {
      enableDriver();
      fakeSupabase();
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
      expect(state.createSupabase).not.toHaveBeenCalled();
    },
  );
});

describe("customer-journey route: thin hops into the production entrypoints", () => {
  it("CREATE_CHECKOUT reaches createCommercialV1Checkout with only the slug and code, and returns only bounded identifiers (never a URL)", async () => {
    enableDriver();
    const { rpcCalls } = fakeSupabase({
      rpc: (name) => {
        if (name === "preview_commercial_v1_campaign")
          return {
            data: {
              ok: true,
              effectivePriceAmountMinor: 0,
              currency: "GBP",
              kind: "REVIEWER_COMPLIMENTARY",
              reused: false,
            },
            error: null,
          };
        if (name === "redeem_commercial_v1_campaign")
          return {
            data: {
              ok: true,
              path: "ACCESS_GRANTED",
              reused: false,
              offerSlug: "acceptance-journey-x",
              activationId: ACTIVATION,
              effectivePriceAmountMinor: 0,
              currency: "GBP",
              entitlementId: ENTITLEMENT,
              enrolmentId: ENROLMENT,
            },
            error: null,
          };
        return undefined;
      },
    });
    const response = await POST(
      request({
        operation: "CREATE_CHECKOUT",
        offerSlug: "acceptance-journey-x",
        campaignCode: "JRN-ABCD",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        ok: true,
        kind: "ACCESS_GRANTED",
        entitlementId: ENTITLEMENT,
        enrolmentId: ENROLMENT,
        offerSlug: "acceptance-journey-x",
      },
    });
    const commerce = rpcCalls.filter(
      (c) => c.name !== "get_ducelio_acceptance_environment_id",
    );
    expect(commerce.map((c) => c.name)).toEqual([
      "preview_commercial_v1_campaign",
      "redeem_commercial_v1_campaign",
    ]);
    for (const c of commerce)
      expect(c.args).toEqual({
        p_offer_slug: "acceptance-journey-x",
        p_code: "JRN-ABCD",
      });
  });

  it("RECORD_RESPONSE goes through the server-owned response writer composition and relays the governed refusal code for another learner's attempt", async () => {
    enableDriver();
    const { rpcCalls } = fakeSupabase({
      rpc: (name) =>
        name === "record_commercial_v1_assessment_response"
          ? { data: { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" }, error: null }
          : undefined,
    });
    const response = await POST(
      request({
        operation: "RECORD_RESPONSE",
        attemptId: ATTEMPT,
        questionId: QUESTION,
        body: "Synthetic",
        idempotencyKey: "journey-key-123",
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      result: { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" },
    });
    expect(rpcCalls.map((c) => c.name)).toContain(
      "record_commercial_v1_assessment_response",
    );
    expect(rpcCalls.map((c) => c.name)).not.toContain(
      "record_assessment_response",
    );
  });

  it("GET_PROGRESS and ATTEMPT_COMPLETION reach the production authority RPCs and relay only bounded codes", async () => {
    enableDriver();
    const { rpcCalls } = fakeSupabase({
      rpc: (name, args) => {
        if (name === "get_commercial_v1_course_progress")
          return {
            data: { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" },
            error: null,
          };
        if (name === "attempt_commercial_v1_course_completion")
          return {
            data: {
              ok: false,
              code: "COMPONENTS_INCOMPLETE",
              pending: [{ kind: "ASSESSMENT", component: "QUIZ_2" }],
            },
            error: null,
            args,
          };
        return undefined;
      },
    });
    expect(await (await POST(request(progress))).json()).toEqual({
      ok: true,
      result: { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" },
    });
    expect(
      await (
        await POST(
          request({
            operation: "ATTEMPT_COMPLETION",
            enrolmentId: ENROLMENT,
            reason: "Journey completion",
          }),
        )
      ).json(),
    ).toEqual({
      ok: true,
      result: { ok: false, code: "COMPONENTS_INCOMPLETE" },
    });
    expect(
      rpcCalls.find((c) => c.name === "attempt_commercial_v1_course_completion")
        ?.args,
    ).toEqual({
      p_enrolment_id: ENROLMENT,
      p_reason: "Journey completion",
    });
  });

  it("maps a delivery denial to a bounded code and an unexpected failure to OPERATION_FAILED without leaking its message", async () => {
    enableDriver();
    fakeSupabase({
      rpc: (name) => {
        if (name === "get_delivery_context")
          return { data: null, error: { message: "NOT_FOUND_OR_FORBIDDEN" } };
        if (name === "get_commercial_v1_course_progress")
          return { data: null, error: { message: "internal detail sentinel" } };
        return undefined;
      },
    });
    expect(
      await (
        await POST(
          request({
            operation: "GET_DELIVERY_CONTEXT",
            enrolmentId: ENROLMENT,
          }),
        )
      ).json(),
    ).toEqual({
      ok: false,
      error: "DELIVERY_DENIED",
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    const failed = await POST(request(progress));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("internal detail sentinel");
  });
});
