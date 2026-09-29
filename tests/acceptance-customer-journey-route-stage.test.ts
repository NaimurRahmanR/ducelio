import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// src/app/api/acceptance/customer-journey/route.ts -- the bounded
// assessment read-stage diagnostic in its catch block. getStudentAssessments
// is replaced here ONLY so each thrown error can be chosen precisely; the
// real StudentAssessmentReadFailure class (and its stage list) is used, and
// the gate, schema, session and environment checks run unmodified.
// tests/acceptance-customer-journey-route.test.ts covers the same contract
// end to end through the real getStudentAssessments.
// ============================================================================

const state = vi.hoisted(() => ({
  createSupabase: vi.fn(),
  getStudentAssessments: vi.fn(),
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
      appUrl: "http://127.0.0.1:3100",
      google: false,
      linkedin: false,
    }),
    commerceConfig: () => ({ configured: false }),
  };
});
vi.mock("@/server/assessments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/assessments")>();
  return { ...actual, getStudentAssessments: state.getStudentAssessments };
});

import { POST } from "@/app/api/acceptance/customer-journey/route";
import {
  STUDENT_ASSESSMENT_READ_STAGES,
  StudentAssessmentReadFailure,
} from "@/server/assessments";
import { createProviderRedirectFetch } from "../scripts/acceptance/examiner-provider-stub.mjs";

const TOKEN = "a".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const REDIRECT_TOKEN = "d".repeat(64);
const networkFetch = vi.fn(
  async () => new Response("unexpected", { status: 200 }),
);

function enableDriver() {
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ENV_ID);
  vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", REDIRECT_TOKEN);
  vi.stubEnv("ACCEPTANCE_JOURNEY_DRIVER_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubGlobal(
    "fetch",
    createProviderRedirectFetch(
      networkFetch,
      "http://127.0.0.1:5555/v1/responses",
      REDIRECT_TOKEN,
    ),
  );
  state.createSupabase.mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: { id: "auth-user", email_confirmed_at: "2026-01-01T00:00:00Z" },
        },
        error: null,
      })),
    },
    rpc: vi.fn(async (name: string) =>
      name === "get_ducelio_acceptance_environment_id"
        ? { data: ENV_ID, error: null }
        : { data: null, error: { message: "unexpected rpc" } },
    ),
  });
}
function request() {
  return new Request("http://127.0.0.1:3100/api/acceptance/customer-journey", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3100",
      "x-ducelio-acceptance-driver": TOKEN,
    },
    body: JSON.stringify({ operation: "GET_ACTIVE_QUESTIONS" }),
  });
}

beforeEach(() => {
  state.createSupabase.mockReset();
  state.getStudentAssessments.mockReset();
  enableDriver();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("customer-journey route: assessmentReadStage contract", () => {
  it("A. StudentAssessmentReadFailure(FINALIZE) => HTTP 500 { error: OPERATION_FAILED, assessmentReadStage: FINALIZE }", async () => {
    state.getStudentAssessments.mockRejectedValue(
      new StudentAssessmentReadFailure("FINALIZE"),
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "OPERATION_FAILED",
      assessmentReadStage: "FINALIZE",
    });
  });

  it.each([...STUDENT_ASSESSMENT_READ_STAGES])(
    "B. StudentAssessmentReadFailure(%s) returns only that fixed code",
    async (stage) => {
      state.getStudentAssessments.mockRejectedValue(
        new StudentAssessmentReadFailure(stage),
      );
      const response = await POST(request());
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        error: "OPERATION_FAILED",
        assessmentReadStage: stage,
      });
      expect(Object.keys(body).sort()).toEqual([
        "assessmentReadStage",
        "error",
      ]);
    },
  );

  it("B2. a StudentAssessmentReadFailure whose stage was forged at runtime to a non-whitelisted value is never relayed", async () => {
    const forged = new StudentAssessmentReadFailure("FINALIZE");
    Object.defineProperty(forged, "stage", { value: "DROP TABLE secret" });
    state.getStudentAssessments.mockRejectedValue(forged);
    const response = await POST(request());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "OPERATION_FAILED" });
    expect(text).not.toContain("DROP TABLE");
  });

  it("C. an ordinary unexpected Error returns only { error: OPERATION_FAILED } -- no message, stage, stack, SQL or details", async () => {
    const raw = new Error(
      'secret/raw postgres text: select * from "secret" -- detail: hint',
    );
    (raw as Error & { details?: string }).details = "secret details";
    state.getStudentAssessments.mockRejectedValue(raw);
    const response = await POST(request());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "OPERATION_FAILED" });
    expect(text).not.toMatch(
      /secret|postgres|select|assessmentReadStage|stack|details|hint|at \S+ \(/,
    );
  });
});
