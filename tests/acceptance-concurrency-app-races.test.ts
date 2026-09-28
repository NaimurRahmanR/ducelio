import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ============================================================================
// scripts/acceptance/concurrency-app-races.mjs (the two real-application
// concurrency races) and the acceptance-only synchronization it needs:
// examiner-provider-stub.mjs's one-shot holds, the redirect wrapper's
// context-read delivery hold, and examiner-app.mjs's shared session. No
// hosted infrastructure and no external network: the stub runs on
// loopback, and the app/database are in-memory stand-ins whose provider
// traffic goes through the REAL stub holds, so the races' ordering, gates
// and verdicts are exercised behaviourally.
// ============================================================================

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env))
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}
beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  vi.doUnmock("pg");
  vi.resetModules();
});

const ATTEMPT = "10000000-0000-4000-8000-0000000000bb";
const QUESTION = "10000000-0000-4000-8000-000000000001";
const PROTECTED = "Acceptance answer.";

type Stub = {
  url: string;
  apiKey: string;
  calls: Record<string, unknown>[];
  planFailure(): void;
  holdNextProviderResponse(): Hold;
  holdNextContextRead(): Hold;
  contextHoldControl: { url: string; token: string };
  close(): Promise<void>;
};
type Hold = {
  state: string;
  arrived: Promise<Record<string, unknown>>;
  settled: Promise<string>;
  release(): void;
  cancel(): void;
};

async function loadStub() {
  return (await import("../scripts/acceptance/examiner-provider-stub.mjs")) as unknown as {
    startProviderStub(): Promise<Stub>;
    createProviderRedirectFetch(
      base: unknown,
      stubUrl: string,
      token: string,
      contextHold?: unknown,
    ): (input: unknown, init?: unknown) => Promise<Response>;
    CONTEXT_HOLD_RPC_PATH: string;
  };
}

const governed = (capability: string, attemptId = ATTEMPT) => ({
  model: "gpt-5.6-luna",
  instructions: "Return ONLY JSON.",
  max_output_tokens: 1200,
  store: false,
  input: JSON.stringify({
    capability,
    context: {
      attemptId,
      questions: [
        {
          questionId: QUESTION,
          maxMarks: 10,
          expectedAnswer: PROTECTED,
          responseBody: "Synthetic",
        },
      ],
    },
  }),
});
function postTo(stub: Stub, body: unknown, signal?: AbortSignal) {
  return fetch(stub.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stub.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}
const tick = () => new Promise((r) => setTimeout(r, 50));
function bounded<T>(promise: Promise<T>, ms = 5_000) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out (would hang)")), ms),
    ),
  ]);
}

type RaceResult = {
  surface: string;
  status: string;
  reason: string;
  details?: string[];
};
async function runRace(scenario: Promise<unknown>): Promise<RaceResult> {
  return (await bounded(scenario, 15_000)) as RaceResult;
}

// ---------------------------------------------------------------------------
// The stub: default behaviour unchanged; explicit one-shot holds.
// ---------------------------------------------------------------------------
describe("provider stub: default behaviour is unchanged when no hold is armed", () => {
  it("answers exactly as before -- no held marker -- and planFailure() stays a one-shot 503", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      expect(
        (await postTo(stub, governed("grade_controlled_assessment"))).status,
      ).toBe(200);
      stub.planFailure();
      expect(
        (await postTo(stub, governed("grade_controlled_assessment"))).status,
      ).toBe(503);
      expect(
        (await postTo(stub, governed("regrade_controlled_assessment"))).status,
      ).toBe(200);
      expect(stub.calls).toEqual([
        {
          capability: "grade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "GRADED",
        },
        {
          capability: "grade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "PROVIDER_UNAVAILABLE",
        },
        {
          capability: "regrade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "GRADED",
        },
      ]);
    } finally {
      await stub.close();
    }
  });
});

describe("provider stub: one-shot provider holds are explicit barriers", () => {
  it("parks exactly the next accepted request, reports its arrival without protected content, and answers only once released", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const hold = stub.holdNextProviderResponse();
      let delivered = false;
      const pending = postTo(
        stub,
        governed("grade_controlled_assessment"),
      ).then(async (r) => {
        delivered = true;
        return { status: r.status, body: await r.json() };
      });
      const arrival = await bounded(hold.arrived);
      expect(arrival).toEqual({
        capability: "grade_controlled_assessment",
        attemptId: ATTEMPT,
      });
      expect(JSON.stringify(arrival)).not.toContain(PROTECTED);
      await tick();
      expect(delivered).toBe(false);
      expect(stub.calls).toHaveLength(0);
      // One-shot: an unrelated request meanwhile is not captured.
      expect(
        (await postTo(stub, governed("regrade_controlled_assessment"))).status,
      ).toBe(200);
      hold.release();
      const response = await bounded(pending);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.output[0].content[0].text).marks).toEqual(
        [{ questionId: QUESTION, marksAwarded: 10 }],
      );
      expect(await hold.settled).toBe("RESPONDED");
      expect(stub.calls).toEqual([
        {
          capability: "regrade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "GRADED",
        },
        {
          capability: "grade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "GRADED",
          held: true,
        },
      ]);
    } finally {
      await stub.close();
    }
  });

  it("a released held request still honours planFailure()", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const hold = stub.holdNextProviderResponse();
      stub.planFailure();
      const pending = postTo(stub, governed("grade_controlled_assessment"));
      await bounded(hold.arrived);
      hold.release();
      expect((await bounded(pending)).status).toBe(503);
      expect(
        (await postTo(stub, governed("grade_controlled_assessment"))).status,
      ).toBe(200);
      expect(stub.calls.map((c) => c.outcome)).toEqual([
        "PROVIDER_UNAVAILABLE",
        "GRADED",
      ]);
    } finally {
      await stub.close();
    }
  });

  it("teardown cancels parked and armed holds, so close() and the parked request never hang", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    const parked = stub.holdNextProviderResponse();
    const pending = postTo(stub, governed("grade_controlled_assessment")).then(
      (r) => r.status,
    );
    await bounded(parked.arrived);
    const armed = stub.holdNextContextRead();
    const armedArrival = armed.arrived.then(
      () => "arrived",
      () => "rejected",
    );
    await bounded(stub.close());
    expect(await bounded(pending)).toBe(503);
    expect(await parked.settled).toBe("CANCELLED");
    expect(await armedArrival).toBe("rejected");
    expect(await armed.settled).toBe("CANCELLED");
    expect(stub.calls).toEqual([
      expect.objectContaining({ outcome: "HOLD_CANCELLED", held: true }),
    ]);
  });

  it("a caller that gives up while parked is recorded CLIENT_ABORTED, never as a response", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const hold = stub.holdNextProviderResponse();
      const controller = new AbortController();
      const pending = postTo(
        stub,
        governed("grade_controlled_assessment"),
        controller.signal,
      ).then(
        () => "answered",
        () => "aborted",
      );
      await bounded(hold.arrived);
      controller.abort();
      expect(await bounded(pending)).toBe("aborted");
      expect(await bounded(hold.settled)).toBe("CLIENT_ABORTED");
      expect(stub.calls).toEqual([
        expect.objectContaining({ outcome: "CLIENT_ABORTED", held: true }),
      ]);
    } finally {
      await stub.close();
    }
  });

  it("a hold cancelled before any arrival never captures a later request", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const hold = stub.holdNextProviderResponse();
      hold.cancel();
      expect(
        (await bounded(postTo(stub, governed("grade_controlled_assessment"))))
          .status,
      ).toBe(200);
      expect(stub.calls).toEqual([
        {
          capability: "grade_controlled_assessment",
          attemptId: ATTEMPT,
          outcome: "GRADED",
        },
      ]);
    } finally {
      await stub.close();
    }
  });

  it("the context-read control endpoint has its own per-run token, answers immediately with no hold armed, and parks only when armed", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    const control = stub.contextHoldControl;
    const ask = (token: string) =>
      fetch(control.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    try {
      expect(control.url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/v1\/acceptance-holds\/context-read$/,
      );
      expect(control.token).toMatch(/^[0-9a-f]{64}$/);
      expect((await ask("0".repeat(64))).status).toBe(401);
      // The provider key is a different secret and never opens the control.
      expect((await ask(stub.apiKey)).status).toBe(401);
      expect(await (await ask(control.token)).json()).toEqual({ held: false });

      const hold = stub.holdNextContextRead();
      let answered = false;
      const pending = ask(control.token).then(async (r) => {
        answered = true;
        return r.json();
      });
      expect(await bounded(hold.arrived)).toEqual({ kind: "CONTEXT_READ" });
      await tick();
      expect(answered).toBe(false);
      hold.release();
      expect(await bounded(pending)).toEqual({ held: true, released: true });
      expect(stub.calls).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The redirect wrapper's context-read delivery hold.
// ---------------------------------------------------------------------------
describe("redirect wrapper: the context-read delivery hold is exact, optional and never alters traffic", () => {
  const STUB_URL = "http://127.0.0.1:5555/v1/responses";
  const CONTROL = "http://127.0.0.1:5555/v1/acceptance-holds/context-read";
  const SUPABASE = "https://acceptance.supabase.invalid";
  const hold = { url: CONTROL, token: "6".repeat(64), supabaseUrl: SUPABASE };

  it("only after the exact context RPC completes, asks the control endpoint (no body), then returns the untouched response", async () => {
    const { createProviderRedirectFetch, CONTEXT_HOLD_RPC_PATH } =
      await loadStub();
    expect(CONTEXT_HOLD_RPC_PATH).toBe(
      "/rest/v1/rpc/get_commercial_v1_examiner_assessment_context",
    );
    const base = vi.fn(
      async (input: unknown) => new Response(`body:${String(input)}`),
    );
    const wrapped = createProviderRedirectFetch(
      base,
      STUB_URL,
      "5".repeat(64),
      hold,
    );
    const rpc = `${SUPABASE}${CONTEXT_HOLD_RPC_PATH}`;
    const response = await wrapped(rpc, { method: "POST", body: "{}" });
    expect(await response.text()).toBe(`body:${rpc}`);
    expect(base.mock.calls.map((c) => String(c[0]))).toEqual([rpc, CONTROL]);
    expect((base.mock.calls[1] as unknown[])[1]).toEqual({
      method: "POST",
      headers: { authorization: `Bearer ${"6".repeat(64)}` },
    });

    base.mockClear();
    await wrapped(
      `${SUPABASE}/rest/v1/rpc/govern_commercial_v1_examiner_execution`,
      {
        method: "POST",
      },
    );
    await wrapped(`https://elsewhere.invalid${CONTEXT_HOLD_RPC_PATH}`, {
      method: "POST",
    });
    await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    expect(base.mock.calls.map((c) => String(c[0]))).toEqual([
      `${SUPABASE}/rest/v1/rpc/govern_commercial_v1_examiner_execution`,
      `https://elsewhere.invalid${CONTEXT_HOLD_RPC_PATH}`,
      STUB_URL,
    ]);
    // No live provider traffic can escape with the hold configured.
    await expect(
      wrapped("https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow();
    await expect(
      wrapped("https://api.openai.com/v1/chat/completions"),
    ).rejects.toThrow();
  });

  it("without a hold configuration the context RPC is passed through with no control call (examiner-app behaviour)", async () => {
    const { createProviderRedirectFetch, CONTEXT_HOLD_RPC_PATH } =
      await loadStub();
    const base = vi.fn(async () => new Response("ok"));
    const wrapped = createProviderRedirectFetch(base, STUB_URL, "5".repeat(64));
    await wrapped(`${SUPABASE}${CONTEXT_HOLD_RPC_PATH}`, { method: "POST" });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("an unreachable control endpoint delivers the response unheld (the driver then sees no arrival and FAILs)", async () => {
    const { createProviderRedirectFetch, CONTEXT_HOLD_RPC_PATH } =
      await loadStub();
    const base = vi.fn(async (input: unknown) => {
      if (String(input) === CONTROL) throw new TypeError("connection refused");
      return new Response("context");
    });
    const wrapped = createProviderRedirectFetch(
      base,
      STUB_URL,
      "5".repeat(64),
      hold,
    );
    expect(
      await (await wrapped(`${SUPABASE}${CONTEXT_HOLD_RPC_PATH}`)).text(),
    ).toBe("context");
  });

  it("refuses a non-loopback, non-http, wrong-path or unauthenticated hold configuration", async () => {
    const { createProviderRedirectFetch } = await loadStub();
    const base = vi.fn();
    for (const bad of [
      {
        ...hold,
        url: "http://example.com:5555/v1/acceptance-holds/context-read",
      },
      {
        ...hold,
        url: "https://127.0.0.1:5555/v1/acceptance-holds/context-read",
      },
      { ...hold, url: "http://127.0.0.1:5555/v1/responses" },
      { ...hold, token: "short" },
      { ...hold, token: "G".repeat(64) },
      { ...hold, supabaseUrl: "" },
    ])
      expect(() =>
        createProviderRedirectFetch(base, STUB_URL, "5".repeat(64), bad),
      ).toThrow();
  });

  it("end to end with the real stub: the database-side read completes first, then delivery waits for the driver's release", async () => {
    const {
      startProviderStub,
      createProviderRedirectFetch,
      CONTEXT_HOLD_RPC_PATH,
    } = await loadStub();
    let served = 0;
    const database = http.createServer((_req, res) => {
      served += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, served }));
    });
    await new Promise<void>((resolve) =>
      database.listen(0, "127.0.0.1", resolve),
    );
    const databaseUrl = `http://127.0.0.1:${(database.address() as AddressInfo).port}`;
    const stub = await startProviderStub();
    try {
      const wrapped = createProviderRedirectFetch(
        fetch,
        stub.url,
        "5".repeat(64),
        {
          ...stub.contextHoldControl,
          supabaseUrl: databaseUrl,
        },
      );
      const contextHold = stub.holdNextContextRead();
      let delivered = false;
      const pending = wrapped(`${databaseUrl}${CONTEXT_HOLD_RPC_PATH}`, {
        method: "POST",
      }).then(async (r) => {
        delivered = true;
        return r.json();
      });
      await bounded(contextHold.arrived);
      expect(served).toBe(1);
      await tick();
      expect(delivered).toBe(false);
      contextHold.release();
      expect(await bounded(pending)).toEqual({ ok: true, served: 1 });
      expect(await contextHold.settled).toBe("RESPONDED");
    } finally {
      await stub.close();
      await new Promise((resolve) => database.close(resolve));
    }
  });
});

describe("preload: the context-read hold is configured completely or not at all", () => {
  const preload = pathToFileURL(
    fileURLToPath(
      new URL(
        "../scripts/acceptance/examiner-provider-redirect.mjs",
        import.meta.url,
      ),
    ),
  ).href;
  const driverEnv = (extra: Record<string, string>) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ACCEPTANCE_APP_DRIVER_ENABLED: "true",
      ACCEPTANCE_PROVIDER_STUB_URL: "http://127.0.0.1:5555/v1/responses",
      ACCEPTANCE_PROVIDER_REDIRECT_TOKEN: "4".repeat(64),
      ...extra,
    };
    return env;
  };
  const run = (extra: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", preload, "-e", ""], {
      env: driverEnv(extra),
      encoding: "utf8",
    });

  it("refuses a half-configured hold", () => {
    const partial: Record<string, string>[] = [
      {
        ACCEPTANCE_CONTEXT_HOLD_URL:
          "http://127.0.0.1:5555/v1/acceptance-holds/context-read",
      },
      { ACCEPTANCE_CONTEXT_HOLD_TOKEN: "7".repeat(64) },
    ];
    for (const extra of partial) {
      const result = run(extra);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("completely or not at all");
    }
  });

  it("loads with a complete hold configuration, and refuses one without a Supabase URL", () => {
    const complete = {
      ACCEPTANCE_CONTEXT_HOLD_URL:
        "http://127.0.0.1:5555/v1/acceptance-holds/context-read",
      ACCEPTANCE_CONTEXT_HOLD_TOKEN: "7".repeat(64),
      NEXT_PUBLIC_SUPABASE_URL: "https://acceptance.supabase.invalid",
    };
    const ok = run(complete);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(run({ ...complete, NEXT_PUBLIC_SUPABASE_URL: "" }).status).not.toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// The shared session / child environment.
// ---------------------------------------------------------------------------
describe("shared app session: only the concurrency driver's child can hold context reads", () => {
  const base = {
    port: 4123,
    token: "f".repeat(64),
    redirectToken: "1".repeat(64),
    stub: { url: "http://127.0.0.1:5555/v1/responses", apiKey: "stub-key" },
  };

  it("buildAppChildEnv forces the hold variables empty unless the driver passes a well-formed hold", async () => {
    const { buildAppChildEnv } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const stray = buildAppChildEnv(
      {
        ACCEPTANCE_CONTEXT_HOLD_URL:
          "http://127.0.0.1:9/v1/acceptance-holds/context-read",
        ACCEPTANCE_CONTEXT_HOLD_TOKEN: "9".repeat(64),
      },
      base,
    );
    expect(stray.ACCEPTANCE_CONTEXT_HOLD_URL).toBe("");
    expect(stray.ACCEPTANCE_CONTEXT_HOLD_TOKEN).toBe("");
    const control = {
      url: "http://127.0.0.1:5555/v1/acceptance-holds/context-read",
      token: "8".repeat(64),
    };
    const held = buildAppChildEnv({}, { ...base, contextHold: control });
    expect(held.ACCEPTANCE_CONTEXT_HOLD_URL).toBe(control.url);
    expect(held.ACCEPTANCE_CONTEXT_HOLD_TOKEN).toBe(control.token);
    expect(() =>
      buildAppChildEnv(
        {},
        { ...base, contextHold: { ...control, token: "short" } },
      ),
    ).toThrow();
  });

  it("openExaminerAppSession({contextHold:true}) hands the child the stub's loopback control and token; runExaminerAppAcceptance never does; neither is ever reported", async () => {
    for (const key of Object.keys(process.env))
      if (
        key.startsWith("ACCEPTANCE_") ||
        key.startsWith("ACADEMIC_") ||
        key.startsWith("NEXT_PUBLIC_SUPABASE_")
      )
        delete process.env[key];
    Object.assign(process.env, {
      ACCEPTANCE_DATABASE_URL:
        "postgresql://acceptance:pw@localhost:5432/acceptance",
      NEXT_PUBLIC_SUPABASE_URL: "https://acceptance.supabase.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
      ACCEPTANCE_ADMIN_EMAIL: "admin@acceptance.test",
      ACCEPTANCE_ADMIN_PASSWORD: "admin-password",
      ACCEPTANCE_LEARNER_EMAIL: "learner@acceptance.test",
      ACCEPTANCE_LEARNER_PASSWORD: "learner-password",
      ACCEPTANCE_ENVIRONMENT_ID: "a0000000-0000-4000-8000-000000000001",
      ACCEPTANCE_WRITE_ENABLED: "true",
      ACADEMIC_EXECUTION_KEY_ID: "b0000000-0000-4000-8000-000000000002",
      ACADEMIC_EXECUTION_HMAC_KEY_HEX: "0123456789abcdef".repeat(4),
    });
    function FakeClient() {
      return {
        connect: async () => {},
        end: async () => {},
        query: async () => ({ rows: [{ present: true }] }),
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    const { openExaminerAppSession, runExaminerAppAcceptance } =
      await import("../scripts/acceptance/examiner-app.mjs");
    const envs: Record<string, string>[] = [];
    const startApp = (env: Record<string, string>) => {
      envs.push(env);
      return { exitCode: 1, pid: 0, once: () => {} };
    };
    const opened = await openExaminerAppSession({
      startApp,
      contextHold: true,
    });
    await opened.close();
    await opened.close(); // idempotent
    expect(opened.refusal.reason).toContain("did not become ready (EXITED)");
    const results = await runExaminerAppAcceptance({ startApp });
    for (const r of results) expect(r.status).toBe("BLOCKED");
    const [raceEnv, examinerEnv] = envs;
    expect(raceEnv.ACCEPTANCE_CONTEXT_HOLD_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/acceptance-holds\/context-read$/,
    );
    expect(raceEnv.ACCEPTANCE_CONTEXT_HOLD_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(examinerEnv.ACCEPTANCE_CONTEXT_HOLD_URL).toBe("");
    expect(examinerEnv.ACCEPTANCE_CONTEXT_HOLD_TOKEN).toBe("");
    const emitted = JSON.stringify([opened.refusal, results]);
    expect(emitted).not.toContain(raceEnv.ACCEPTANCE_CONTEXT_HOLD_TOKEN);
  });
});

describe("runAppRaceScenarios: an unavailable session is BLOCKED (never PASS or a synthetic NOT_RUN) and is always closed", () => {
  it("maps a refusal and a write-gate error to BLOCKED, any other error to FAIL, and asks only for the context hold", async () => {
    const races =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    const { AcceptanceWriteNotAuthorizedError } =
      await import("../scripts/acceptance/db.mjs");
    const surfaces = Object.values(races.APP_RACE_SURFACES);
    let closed = 0;
    const close = async () => {
      closed += 1;
    };
    const refusing = vi.fn(async () => ({
      refusal: { reason: "prerequisites missing", details: ["X is missing"] },
      close,
    }));
    const refused = await races.runAppRaceScenarios({ open: refusing });
    expect(refusing).toHaveBeenCalledWith({ contextHold: true });
    expect(refused.map((r: { surface: string }) => r.surface)).toEqual(
      surfaces,
    );
    for (const r of refused) expect(r.status).toBe("BLOCKED");
    expect(closed).toBe(1);

    const gated = await races.runAppRaceScenarios({
      open: async () => {
        throw new AcceptanceWriteNotAuthorizedError("gate");
      },
    });
    for (const r of gated) expect(r.status).toBe("BLOCKED");
    const broken = await races.runAppRaceScenarios({
      open: async () => {
        throw new Error("boom");
      },
    });
    for (const r of broken) expect(r.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Pure verdicts.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const ok = (result: Row) => ({
  status: 200,
  body: { ok: true, result },
  text: JSON.stringify({ ok: true, result }),
});

function coherentLateObservation(): Row {
  const revision = {
    id: "revision-1",
    revision_number: 1,
    attempt_id: ATTEMPT,
    earned_marks_total: 10,
    valid: true,
    outcome_rows: 1,
  };
  const held = {
    capability: "grade_controlled_assessment",
    attemptId: ATTEMPT,
    outcome: "GRADED",
    held: true,
  };
  return {
    attemptId: ATTEMPT,
    originalExecutionId: "execution-1",
    recoveryActorId: "admin",
    studentId: "student",
    questionCount: 1,
    lateResponse: ok({ attemptId: ATTEMPT, grading: "GRADING_UNAVAILABLE" }),
    recoveryResponse: ok({
      status: "RECOVERED",
      resultRevisionId: revision.id,
    }),
    originalHoldOutcome: "RESPONDED",
    recoveryHoldOutcome: "RESPONDED",
    executions: [
      {
        id: "execution-1",
        state: "TIMEOUT",
        reason_code: "EXECUTION_TIMEOUT",
        result_revision_id: null,
        grade_digest: null,
        provider_calls: null,
      },
    ],
    originalUnchangedSinceTimeout: true,
    recoveryClaims: [
      {
        id: "recovery-1",
        state: "SUCCEEDED",
        actor_id: "admin",
        student_id: "student",
        result_revision_id: revision.id,
        provider_calls: 1,
      },
    ],
    revisions: [revision],
    marks: { rows: 1, matches: true, earned: 10 },
    stubCalls: [held, { ...held }],
    replays: {
      recovery: ok({
        status: "ALREADY_RECOVERED",
        resultRevisionId: revision.id,
      }),
      learner: ok({ attemptId: ATTEMPT, grading: "GRADING_UNAVAILABLE" }),
      historyUnchanged: true,
    },
  };
}

describe("LATE_INITIAL verdict: only one coherent recovered result, with the timed-out original untouched, is PASS", () => {
  it("accepts the coherent state", async () => {
    const { evaluateLateInitialRace } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    expect(evaluateLateInitialRace(coherentLateObservation())).toEqual([]);
  });

  const torn: [string, (o: Row) => void][] = [
    [
      "the late FINALIZE restored the original to SUCCEEDED",
      (o) => {
        (o.executions as Row[])[0].state = "SUCCEEDED";
        (o.executions as Row[])[0].result_revision_id = "revision-1";
      },
    ],
    [
      "the timed-out original recorded provider usage",
      (o) => ((o.executions as Row[])[0].provider_calls = 1),
    ],
    [
      "a second initial execution exists",
      (o) => (o.executions as Row[]).push({ id: "execution-2" }),
    ],
    [
      "the original row changed after timing out",
      (o) => (o.originalUnchangedSinceTimeout = false),
    ],
    [
      "the late invocation reported GRADED",
      (o) => (o.lateResponse = ok({ grading: "GRADED" })),
    ],
    [
      "the original provider call was abandoned (late FINALIZE never reached)",
      (o) => (o.originalHoldOutcome = "CLIENT_ABORTED"),
    ],
    [
      "two recovery claims",
      (o) =>
        (o.recoveryClaims as Row[]).push({
          ...(o.recoveryClaims as Row[])[0],
          id: "recovery-2",
        }),
    ],
    [
      "the recovery did not succeed",
      (o) => ((o.recoveryClaims as Row[])[0].state = "FAILED"),
    ],
    [
      "two revision 1 rows",
      (o) =>
        (o.revisions as Row[]).push({
          ...(o.revisions as Row[])[0],
          id: "revision-2",
        }),
    ],
    [
      "the sole revision is invalid",
      (o) => ((o.revisions as Row[])[0].valid = false),
    ],
    [
      "duplicate question marks",
      (o) => (o.marks = { rows: 2, matches: true, earned: 10 }),
    ],
    [
      "only one provider call (no late original call)",
      (o) => (o.stubCalls as Row[]).pop(),
    ],
    [
      "a replay created history",
      (o) => ((o.replays as Row).historyUnchanged = false),
    ],
    [
      "an unauthenticated recovery response",
      (o) => (o.recoveryResponse = null),
    ],
  ];
  it.each(torn)("FAILs when %s", async (_label, mutate) => {
    const { evaluateLateInitialRace } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    const observation = coherentLateObservation();
    mutate(observation);
    expect(evaluateLateInitialRace(observation).length).toBeGreaterThan(0);
  });
});

function coherentRegradeObservation(
  order: "REGRADE_FIRST" | "COMPLETION_FIRST",
): Row {
  const source = {
    id: "revision-1",
    revision_number: 1,
    attempt_id: ATTEMPT,
    earned_marks_total: 10,
    valid: true,
    outcome_rows: 1,
  };
  const next = {
    ...source,
    id: "revision-2",
    revision_number: 2,
    earned_marks_total: 9,
  };
  const regradeFirst = order === "REGRADE_FIRST";
  const score = regradeFirst ? 9900 : 10000;
  return {
    sourceRevisionId: source.id,
    attemptId: ATTEMPT,
    studentId: "student",
    regradeActorId: "admin",
    questionCount: 1,
    scoreBefore: 10000,
    scoreNow: score,
    passMarkBp: 5000,
    regradeResponse: regradeFirst
      ? ok({
          status: "REGRADED",
          executionId: "regrade-1",
          resultRevisionId: next.id,
        })
      : ok({
          status: "TARGET_NOT_ELIGIBLE",
          executionId: null,
          resultRevisionId: null,
        }),
    regradeHoldOutcome: "RESPONDED",
    completion: {
      data: {
        ok: true,
        code: "COMPLETED",
        receiptId: "receipt-1",
        courseScoreBp: score,
      },
      error: null,
    },
    revisions: regradeFirst ? [source, next] : [source],
    nextRevisionMarks: regradeFirst
      ? { rows: 1, matches: true, earned: 9 }
      : null,
    regradeClaims: [
      {
        id: "regrade-1",
        state: regradeFirst ? "SUCCEEDED" : "FAILED",
        reason_code: regradeFirst ? "GRADED" : "INTERNAL_ERROR",
        actor_id: "admin",
        student_id: "student",
        result_revision_id: regradeFirst ? next.id : null,
        provider_calls: 1,
      },
    ],
    enrolmentStatus: "COMPLETED",
    receipts: [
      {
        id: "receipt-1",
        student_id: "student",
        completed_by: "student",
        final_course_score_bp: score,
        pass_mark_bp: 5000,
      },
    ],
    completionAudits: 1,
    sourceUnchanged: true,
    regradeStubCalls: [
      {
        capability: "regrade_controlled_assessment",
        attemptId: ATTEMPT,
        outcome: "GRADED",
        held: true,
      },
    ],
    replays: {
      completion: {
        data: { ok: true, code: "ALREADY_COMPLETED", receiptId: "receipt-1" },
        error: null,
      },
      regrade: regradeFirst
        ? ok({
            status: "ALREADY_REGRADED",
            executionId: "regrade-1",
            resultRevisionId: next.id,
          })
        : ok({
            status: "UNAVAILABLE",
            executionId: null,
            resultRevisionId: null,
          }),
      historyUnchanged: true,
    },
  };
}

describe("REGRADE_VS_COMPLETION verdict: exactly the two legitimate serial orders PASS; torn state FAILs", () => {
  it.each(["REGRADE_FIRST", "COMPLETION_FIRST"] as const)(
    "accepts a coherent %s state and names that order",
    async (order) => {
      const { evaluateRegradeCompletionRace } =
        await import("../scripts/acceptance/concurrency-app-races.mjs");
      expect(
        evaluateRegradeCompletionRace(coherentRegradeObservation(order)),
      ).toEqual({
        order,
        problems: [],
      });
    },
  );

  const torn: [
    string,
    "REGRADE_FIRST" | "COMPLETION_FIRST",
    (o: Row) => void,
  ][] = [
    [
      "the receipt used the superseded result although the regrade committed first",
      "REGRADE_FIRST",
      (o) => {
        (o.receipts as Row[])[0].final_course_score_bp = 10000;
        (o.completion as Row).data = {
          ok: true,
          code: "COMPLETED",
          receiptId: "receipt-1",
          courseScoreBp: 10000,
        };
      },
    ],
    [
      "a post-completion regrade revision was committed (success after COMPLETED)",
      "COMPLETION_FIRST",
      (o) => {
        (o.revisions as Row[]).push({
          id: "revision-2",
          revision_number: 2,
          attempt_id: ATTEMPT,
          earned_marks_total: 9,
          valid: true,
          outcome_rows: 1,
        });
        o.scoreNow = 9900;
      },
    ],
    [
      "a next revision exists but the regrade was reported refused",
      "REGRADE_FIRST",
      (o) => (o.regradeResponse = ok({ status: "TARGET_NOT_ELIGIBLE" })),
    ],
    [
      "the regrade reported REGRADED but no next revision exists",
      "COMPLETION_FIRST",
      (o) =>
        (o.regradeResponse = ok({
          status: "REGRADED",
          resultRevisionId: "revision-2",
        })),
    ],
    [
      "the regrade claim SUCCEEDED after completion",
      "COMPLETION_FIRST",
      (o) => ((o.regradeClaims as Row[])[0].state = "SUCCEEDED"),
    ],
    [
      "two completion receipts",
      "REGRADE_FIRST",
      (o) =>
        (o.receipts as Row[]).push({
          ...(o.receipts as Row[])[0],
          id: "receipt-2",
        }),
    ],
    [
      "two completion audits",
      "COMPLETION_FIRST",
      (o) => (o.completionAudits = 2),
    ],
    [
      "the enrolment is not COMPLETED",
      "COMPLETION_FIRST",
      (o) => (o.enrolmentStatus = "ACTIVE"),
    ],
    [
      "a partial/invalid next revision",
      "REGRADE_FIRST",
      (o) => ((o.revisions as Row[])[1].valid = false),
    ],
    [
      "three QUIZ_1 revisions",
      "REGRADE_FIRST",
      (o) =>
        (o.revisions as Row[]).push({
          ...(o.revisions as Row[])[1],
          id: "revision-3",
          revision_number: 3,
        }),
    ],
    [
      "the source revision changed",
      "COMPLETION_FIRST",
      (o) => (o.sourceUnchanged = false),
    ],
    [
      "two regrade executions",
      "REGRADE_FIRST",
      (o) =>
        (o.regradeClaims as Row[]).push({
          ...(o.regradeClaims as Row[])[0],
          id: "regrade-2",
        }),
    ],
    [
      "a second regrade provider call",
      "COMPLETION_FIRST",
      (o) =>
        (o.regradeStubCalls as Row[]).push({
          ...(o.regradeStubCalls as Row[])[0],
        }),
    ],
    [
      "the regrade did not change the score (lineage indistinguishable)",
      "REGRADE_FIRST",
      (o) => (o.scoreNow = o.scoreBefore),
    ],
    [
      "the completion call failed",
      "COMPLETION_FIRST",
      (o) => (o.completion = { data: null, error: { message: "denied" } }),
    ],
    [
      "a replay created history",
      "REGRADE_FIRST",
      (o) => ((o.replays as Row).historyUnchanged = false),
    ],
  ];
  it.each(torn)("FAILs when %s", async (_label, order, mutate) => {
    const { evaluateRegradeCompletionRace } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    const observation = coherentRegradeObservation(order);
    mutate(observation);
    expect(
      evaluateRegradeCompletionRace(observation).problems.length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Behavioural orchestration: in-memory app + database, REAL stub holds.
// The stand-in app follows the production shapes the races depend on
// (migration 031's lazy timeout and TIMEOUT-refused FINALIZE; migration
// 040's one claim per source; migrations 030/032's shared enrolment lock),
// and routes every provider call -- and, like the preload, the initial
// context read -- through the real stub.
// ---------------------------------------------------------------------------
async function providerCall(stub: Stub, capability: string, attemptId: string) {
  const response = await postTo(stub, governed(capability, attemptId));
  return response.status === 200;
}
// Per-family admission-window rows the stand-in database reports. An
// array is consumed one row per query (the last row then sticks), so a
// window can become exhausted between the up-front check and the re-check.
type WindowRow = { last_minute: number; last_hour: number };
type Windows = Partial<
  Record<"INITIAL" | "RECOVERY" | "REGRADE", WindowRow | WindowRow[]>
>;
function admissionRows(
  races: { RQ: Record<string, string> },
  sql: string,
  windows: Windows,
) {
  const family =
    sql === races.RQ.initialAdmissions
      ? "INITIAL"
      : sql === races.RQ.recoveryAdmissions
        ? "RECOVERY"
        : sql === races.RQ.regradeAdmissions
          ? "REGRADE"
          : null;
  if (!family) return null;
  const configured = windows[family] ?? { last_minute: 0, last_hour: 0 };
  const row = Array.isArray(configured)
    ? configured.length > 1
      ? configured.shift()!
      : configured[0]
    : configured;
  return [{ ...row }];
}

const learnerRpcs = () => {
  let attempt = 0;
  return async (name: string) => ({
    data:
      name === "start_assessment_attempt"
        ? `attempt-${++attempt}`
        : name === "get_active_assessment_questions"
          ? [{ id: QUESTION }]
          : { ok: true },
    error: null,
  });
};

async function lateWorld(
  stub: Stub,
  faults: {
    lateFinalizeSucceeds?: boolean;
    noPreloadHold?: boolean;
    recoveryWritesTwice?: boolean;
    windows?: Windows;
  } = {},
) {
  const races = await import("../scripts/acceptance/concurrency-app-races.mjs");
  const { Q } = await import("../scripts/acceptance/examiner-app.mjs");
  const course = {
    importId: "import",
    activationId: "activation",
    enrolmentId: "enrolment",
    studentId: "student",
    recoveryActorId: "admin",
    quiz1AssessmentId: "assessment",
  };
  const sqlSeen: string[] = [];
  const learnerCalls: string[] = [];
  const lateRpcs = learnerRpcs();
  const events: string[] = [];
  const operations: string[] = [];
  const executions: Row[] = [];
  const revisions: Row[] = [];
  const recoveries: Row[] = [];
  let leaseExpired = false;
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const jars = { learner: { size: 1 }, admin: { size: 1 } };
  const newRevision = (attemptId: string) => {
    const revision = {
      id: id("revision"),
      revision_number: 1,
      attempt_id: attemptId,
      earned_marks_total: 10,
      max_marks_total: 10,
      valid: true,
      outcome_rows: 1,
    };
    revisions.push(revision);
    return revision;
  };
  const app = {
    async call(jar: unknown, payload: Row) {
      operations.push(payload.operation as string);
      if (payload.operation === "SUBMIT_AND_GRADE_ASSESSMENT") {
        const attemptId = payload.attemptId as string;
        const existing = executions.find((e) => e.attempt_id === attemptId);
        if (existing) {
          if (existing.state === "RUNNING" && leaseExpired) {
            existing.state = "TIMEOUT";
            existing.reason_code = "EXECUTION_TIMEOUT";
            events.push("lazy-timeout");
          }
          return ok({
            attemptId,
            grading:
              existing.state === "SUCCEEDED" ? "GRADED" : "GRADING_UNAVAILABLE",
          });
        }
        const execution: Row = {
          id: id("execution"),
          attempt_id: attemptId,
          state: "RUNNING",
          reason_code: null,
          grade_digest: null,
          result_revision_id: null,
          provider_calls: null,
        };
        executions.push(execution);
        if (!faults.noPreloadHold)
          await fetch(stub.contextHoldControl.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${stub.contextHoldControl.token}`,
            },
          }).then((r) => r.arrayBuffer());
        events.push("initial-context-delivered");
        const graded = await providerCall(
          stub,
          "grade_controlled_assessment",
          attemptId,
        );
        events.push("initial-finalize");
        const allowed =
          faults.lateFinalizeSucceeds ||
          (execution.state === "RUNNING" && !leaseExpired);
        if (graded && allowed) {
          const revision = newRevision(attemptId);
          Object.assign(execution, {
            state: "SUCCEEDED",
            reason_code: "GRADED",
            result_revision_id: revision.id,
            grade_digest: "d".repeat(64),
            provider_calls: 1,
          });
          return ok({ attemptId, grading: "GRADED" });
        }
        return ok({ attemptId, grading: "GRADING_UNAVAILABLE" });
      }
      if (payload.operation === "RECOVER_EXAMINER_TARGET") {
        const source = executions.find(
          (e) => e.id === payload.sourceExecutionId,
        );
        const claim = recoveries.find((r) => r.source === source?.id);
        if (jar !== jars.admin)
          return ok({ status: "UNAVAILABLE", resultRevisionId: null });
        if (claim)
          return ok({
            status:
              claim.state === "SUCCEEDED" ? "ALREADY_RECOVERED" : "UNAVAILABLE",
            resultRevisionId: claim.result_revision_id,
          });
        if (source?.state !== "TIMEOUT")
          return ok({ status: "TARGET_NOT_ELIGIBLE", resultRevisionId: null });
        events.push("recovery-authorized");
        const created: Row = {
          id: id("recovery"),
          source: source.id,
          state: "RUNNING",
          actor_id: course.recoveryActorId,
          student_id: course.studentId,
          result_revision_id: null,
          provider_calls: null,
        };
        recoveries.push(created);
        await providerCall(
          stub,
          "grade_controlled_assessment",
          source.attempt_id as string,
        );
        const revision = newRevision(source.attempt_id as string);
        if (faults.recoveryWritesTwice)
          newRevision(source.attempt_id as string);
        Object.assign(created, {
          state: "SUCCEEDED",
          result_revision_id: revision.id,
          provider_calls: 1,
        });
        return ok({ status: "RECOVERED", resultRevisionId: revision.id });
      }
      return { status: 400, body: { error: "INVALID_REQUEST" }, text: "" };
    },
  };
  async function query(sql: string, params: unknown[]) {
    sqlSeen.push(sql);
    const window = admissionRows(races, sql, faults.windows ?? {});
    if (window) return window;
    const [p] = params;
    if (sql === Q.initialExecutions)
      return executions
        .filter((e) => e.attempt_id === p)
        .map((e) => ({ ...e }));
    if (sql === races.RQ.executionLease)
      return executions
        .filter((e) => e.id === p)
        .map((e) => ({
          state: e.state,
          expired: leaseExpired,
          remaining_ms: leaseExpired ? 0 : 20_000,
        }));
    if (sql === races.RQ.studentLiveLeases)
      return [{ live: 0, remaining_ms: 0 }];
    if (sql === Q.revisions) return revisions.map((r) => ({ ...r }));
    if (sql === Q.questionCount) return [{ n: 1 }];
    if (sql === Q.marks) {
      const r = revisions.find((x) => x.id === p)!;
      return [
        {
          question_id: QUESTION,
          marks_awarded: r.earned_marks_total,
          max_marks: 10,
        },
      ];
    }
    if (sql === Q.executionSnapshot)
      return executions
        .filter((e) => e.id === p)
        .map((e) => ({ execution: { ...e } }));
    if (sql === Q.recoveryExecutions)
      return recoveries.filter((r) => r.source === p).map((r) => ({ ...r }));
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }
  const ctx = {
    runId: "test-run",
    app,
    jars,
    stub,
    query,
    seed: async () => course,
    learnerClient: {
      rpc: (name: string) => {
        learnerCalls.push(name);
        return lateRpcs(name);
      },
    },
    timing: {
      arrivalTimeoutMs: 2_000,
      settleTimeoutMs: 5_000,
      leaseWaitLimitMs: 5_000,
      // The only timed wait in the race: the stand-in's lease passes.
      sleep: async () => {
        events.push("lease-wait");
        leaseExpired = true;
      },
    },
  };
  return {
    ctx,
    events,
    operations,
    executions,
    revisions,
    recoveries,
    races,
    sqlSeen,
    learnerCalls,
  };
}

describe("LATE_INITIAL orchestration (real stub holds, in-memory app/DB)", () => {
  it("PASSes only after: context hold reached, genuine lease wait, replay-driven TIMEOUT, then late original + recovery released from one gate", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub);
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.details).toBeDefined();
      expect(result.status).toBe("PASS");
      const at = (e: string) => world.events.indexOf(e);
      expect(at("lease-wait")).toBeGreaterThanOrEqual(0);
      expect(at("lazy-timeout")).toBeGreaterThan(at("lease-wait"));
      expect(at("initial-context-delivered")).toBeGreaterThan(
        at("lazy-timeout"),
      );
      expect(at("initial-finalize")).toBeGreaterThan(at("lazy-timeout"));
      expect(at("recovery-authorized")).toBeGreaterThan(at("lazy-timeout"));
      // Only the real app route operations -- never a signer or raw write.
      expect([...new Set(world.operations)].sort()).toEqual([
        "RECOVER_EXAMINER_TARGET",
        "SUBMIT_AND_GRADE_ASSESSMENT",
      ]);
      expect(stub.calls.every((c) => c.held === true)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(PROTECTED);
    } finally {
      await stub.close();
    }
  });

  it("FAILs if a late FINALIZE could still succeed after TIMEOUT", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub, { lateFinalizeSucceeds: true });
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.status).toBe("FAIL");
    } finally {
      await stub.close();
    }
  });

  it("FAILs if recovery writes a second revision", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub, { recoveryWritesTwice: true });
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.status).toBe("FAIL");
    } finally {
      await stub.close();
    }
  });

  it("FAILs -- never PASS, never hangs -- when the context-read hold is not live in the app", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub, { noPreloadHold: true });
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.status).toBe("FAIL");
      expect(result.reason).toContain("never reached the held context read");
      expect(world.recoveries).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });
});

async function regradeWorld(
  stub: Stub,
  order: "REGRADE_FIRST" | "COMPLETION_FIRST",
  faults: {
    completionUsesSuperseded?: boolean;
    regradeIgnoresCompletion?: boolean;
    windows?: Windows;
  } = {},
) {
  const races = await import("../scripts/acceptance/concurrency-app-races.mjs");
  const { Q } = await import("../scripts/acceptance/examiner-app.mjs");
  const course = {
    importId: "import",
    activationId: "activation",
    enrolmentId: "enrolment",
    studentId: "student",
    recoveryActorId: "admin",
    quiz1AssessmentId: "assessment",
  };
  const OTHER_COMPONENTS_BP = 9000;
  const QUIZ_1_WEIGHT_BP = 1000;
  const sqlSeen: string[] = [];
  const learnerCalls: string[] = [];
  const events: string[] = [];
  const operations: string[] = [];
  const revisions: Row[] = [];
  const claims: Row[] = [];
  const receipts: Row[] = [];
  let audits = 0;
  let status = "ACTIVE";
  let seeded = false;
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  let regradeFinalized!: () => void;
  const regradeDone = new Promise<void>((r) => (regradeFinalized = r));
  let completionCommitted!: () => void;
  const completionDone = new Promise<void>((r) => (completionCommitted = r));
  const weighted = (r: Row) =>
    Math.round(((r.earned_marks_total as number) * QUIZ_1_WEIGHT_BP) / 10);
  const current = () => revisions[revisions.length - 1];
  const score = (r = current()) => OTHER_COMPONENTS_BP + weighted(r);
  const jars = { learner: { size: 1 }, admin: { size: 1 } };
  const revision = (number: number, earned: number) => {
    const r = {
      id: id("revision"),
      revision_number: number,
      attempt_id: "attempt-1",
      earned_marks_total: earned,
      max_marks_total: 10,
      valid: true,
      outcome_rows: 1,
    };
    revisions.push(r);
    return r;
  };
  const app = {
    async call(jar: unknown, payload: Row) {
      operations.push(payload.operation as string);
      if (payload.operation === "SUBMIT_AND_GRADE_ASSESSMENT") {
        await providerCall(
          stub,
          "grade_controlled_assessment",
          payload.attemptId as string,
        );
        if (!revisions.length) revision(1, 10);
        return ok({ attemptId: payload.attemptId, grading: "GRADED" });
      }
      if (payload.operation === "REGRADE_CONTROLLED_ASSESSMENT") {
        const existing = claims.find(
          (c) => c.source === payload.resultRevisionId,
        );
        if (jar !== jars.admin) return ok({ status: "UNAVAILABLE" });
        if (existing)
          return existing.state === "SUCCEEDED"
            ? ok({
                status: "ALREADY_REGRADED",
                executionId: existing.id,
                resultRevisionId: existing.result_revision_id,
              })
            : ok({
                status: "UNAVAILABLE",
                executionId: null,
                resultRevisionId: null,
              });
        const claim: Row = {
          id: id("regrade"),
          source: payload.resultRevisionId,
          state: "RUNNING",
          reason_code: null,
          actor_id: course.recoveryActorId,
          student_id: course.studentId,
          result_revision_id: null,
          provider_calls: null,
        };
        claims.push(claim);
        events.push("regrade-running");
        await providerCall(stub, "regrade_controlled_assessment", "attempt-1");
        // The shared enrolment lock: FINALIZE waits for a completion
        // that won the lock first.
        if (order === "COMPLETION_FIRST") await completionDone;
        events.push("regrade-finalize");
        claim.provider_calls = 1;
        if (status === "ACTIVE" || faults.regradeIgnoresCompletion) {
          const next = revision(2, 9);
          Object.assign(claim, {
            state: "SUCCEEDED",
            reason_code: "GRADED",
            result_revision_id: next.id,
          });
          regradeFinalized();
          return ok({
            status: "REGRADED",
            executionId: claim.id,
            resultRevisionId: next.id,
          });
        }
        Object.assign(claim, {
          state: "FAILED",
          reason_code: "INTERNAL_ERROR",
        });
        regradeFinalized();
        return ok({
          status: "TARGET_NOT_ELIGIBLE",
          executionId: null,
          resultRevisionId: null,
        });
      }
      return { status: 400, body: { error: "INVALID_REQUEST" }, text: "" };
    },
  };
  const rpcs = learnerRpcs();
  const learnerClient = {
    async rpc(name: string, args: Row) {
      learnerCalls.push(name);
      if (name !== "attempt_commercial_v1_course_completion") return rpcs(name);
      operations.push("attempt_commercial_v1_course_completion");
      if (!claims.some((c) => c.state === "RUNNING") && !receipts.length)
        events.push("completion-before-regrade-was-running");
      if (order === "REGRADE_FIRST" && !receipts.length) await regradeDone;
      if (status === "COMPLETED")
        return {
          data: {
            ok: true,
            code: "ALREADY_COMPLETED",
            receiptId: receipts[0].id,
          },
          error: null,
        };
      events.push("completion-commit");
      const final = faults.completionUsesSuperseded
        ? score(revisions[0])
        : score();
      const receipt = {
        id: id("receipt"),
        enrolment_id: args.p_enrolment_id,
        student_id: course.studentId,
        completed_by: course.studentId,
        final_course_score_bp: final,
        pass_mark_bp: 5000,
      };
      receipts.push(receipt);
      audits += 1;
      status = "COMPLETED";
      completionCommitted();
      return {
        data: {
          ok: true,
          code: "COMPLETED",
          receiptId: receipt.id,
          courseScoreBp: final,
        },
        error: null,
      };
    },
  };
  async function query(sql: string, params: unknown[]) {
    sqlSeen.push(sql);
    const window = admissionRows(races, sql, faults.windows ?? {});
    if (window) return window;
    const [p] = params;
    if (sql === races.RQ.studentLiveLeases)
      return [{ live: 0, remaining_ms: 0 }];
    if (sql === races.RQ.quiz1Revisions)
      return revisions.map((r) => ({
        ...r,
        weighted_contribution_bp: weighted(r),
      }));
    if (sql === races.RQ.progress)
      return [
        {
          progress: {
            ok: true,
            pending: seeded
              ? []
              : [{ kind: "ASSESSMENT", component: "QUIZ_2" }],
            courseScoreBp: seeded ? score() : null,
            passMarkBp: 5000,
          },
        },
      ];
    if (sql === races.RQ.enrolmentStatus) return [{ status }];
    if (sql === races.RQ.receipts) return receipts.map((r) => ({ ...r }));
    if (sql === races.RQ.completionAudits) return [{ n: audits }];
    if (sql === races.RQ.regradeClaims)
      return claims.filter((c) => c.source === p).map((c) => ({ ...c }));
    if (sql === Q.revisionSnapshot)
      return revisions
        .filter((r) => r.id === p)
        .map((r) => ({ revision: { ...r }, marks: [] }));
    if (sql === Q.questionCount) return [{ n: 1 }];
    if (sql === Q.marks) {
      const r = revisions.find((x) => x.id === p)!;
      return [
        {
          question_id: QUESTION,
          marks_awarded: r.earned_marks_total,
          max_marks: 10,
        },
      ];
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  }
  const ctx = {
    runId: "test-run",
    app,
    jars,
    stub,
    query,
    learnerClient,
    seed: async () => course,
    seedResults: async (
      _course: unknown,
      allCorrect: boolean,
      options: Row,
    ) => {
      expect(allCorrect).toBe(true);
      expect(options).toEqual({ excludeComponents: ["QUIZ_1"] });
      seeded = true;
    },
    timing: {
      arrivalTimeoutMs: 2_000,
      settleTimeoutMs: 5_000,
      leaseWaitLimitMs: 5_000,
      sleep: async () => {},
    },
  };
  return {
    ctx,
    events,
    operations,
    races,
    revisions,
    receipts,
    claims,
    sqlSeen,
    learnerCalls,
  };
}

describe("REGRADE_VS_COMPLETION orchestration (real stub hold, in-memory app/DB)", () => {
  it.each(["REGRADE_FIRST", "COMPLETION_FIRST"] as const)(
    "PASSes and names the observed order when %s wins the enrolment lock",
    async (order) => {
      const { startProviderStub } = await loadStub();
      const stub = await startProviderStub();
      try {
        const world = await regradeWorld(stub, order);
        const result = await runRace(
          world.races.scenarioRegradeVsCompletion(world.ctx),
        );
        expect(result.status).toBe("PASS");
        expect(result.reason).toContain(`Observed serial order: ${order}`);
        expect(result.details).toContain(`serial order observed: ${order}`);
        // Completion is dispatched only after the regrade is RUNNING and held.
        expect(world.events).not.toContain(
          "completion-before-regrade-was-running",
        );
        expect([...new Set(world.operations)].sort()).toEqual([
          "REGRADE_CONTROLLED_ASSESSMENT",
          "SUBMIT_AND_GRADE_ASSESSMENT",
          "attempt_commercial_v1_course_completion",
        ]);
        expect(world.receipts).toHaveLength(1);
      } finally {
        await stub.close();
      }
    },
  );

  it.each([
    ["REGRADE_FIRST", { completionUsesSuperseded: true }],
    ["COMPLETION_FIRST", { regradeIgnoresCompletion: true }],
  ] as const)("FAILs a torn %s world (%j)", async (order, faults) => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await regradeWorld(stub, order, faults);
      const result = await runRace(
        world.races.scenarioRegradeVsCompletion(world.ctx),
      );
      expect(result.status).toBe("FAIL");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Production admission windows (5 / 60 s and 30 / 1 h per learner and
// execution family): recent synthetic acceptance activity BLOCKS a race,
// read-only, instead of making it FAIL.
// ---------------------------------------------------------------------------
const FULL_MINUTE = { last_minute: 5, last_hour: 5 };
const FULL_HOUR = { last_minute: 0, last_hour: 30 };
const JUST_BELOW = { last_minute: 4, last_hour: 29 };
const OPEN = { last_minute: 0, last_hour: 0 };
const ADMISSION_SQL =
  /from commercial_v1_examiner_(executions|recovery_executions|regrade_executions) cross join stamp where student_id=\$1$/;

function expectOnlyReadOnlyAdmissionQueries(sqlSeen: string[]) {
  const admissions = sqlSeen.filter((sql) => ADMISSION_SQL.test(sql.trim()));
  expect(admissions.length).toBeGreaterThan(0);
  for (const sql of sqlSeen) {
    expect(sql.trim()).toMatch(/^(select|with)\b/i);
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\btruncate\b/i);
  }
}

describe("admission windows: the exact production limits, read-only, against the database clock", () => {
  it("each family query mirrors the production predicate (student_id, created_at > DB clock - window) and writes nothing", async () => {
    const { RQ, ADMISSION_FAMILIES, ADMISSION_LIMITS } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    expect(ADMISSION_LIMITS).toEqual({ perMinute: 5, perHour: 30 });
    for (const [family, table] of [
      ["INITIAL", "commercial_v1_examiner_executions"],
      ["RECOVERY", "commercial_v1_examiner_recovery_executions"],
      ["REGRADE", "commercial_v1_examiner_regrade_executions"],
    ] as const) {
      const sql = ADMISSION_FAMILIES[family].sql as string;
      expect(sql).toBe(
        RQ[`${family.toLowerCase()}Admissions` as keyof typeof RQ],
      );
      expect(sql.trim()).toMatch(
        /^with stamp as materialized \(select clock_timestamp\(\) as t\)\s+select\b/,
      );
      expect(sql).toContain(
        `from ${table} cross join stamp where student_id=$1`,
      );
      // Production evaluates both windows against ONE captured instant.
      expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1);
      expect(sql).toContain("created_at > stamp.t - interval '60 seconds'");
      expect(sql).toContain("created_at > stamp.t - interval '1 hour'");
      expect(sql.match(/created_at > (\S+) - interval/g)).toEqual([
        "created_at > stamp.t - interval",
        "created_at > stamp.t - interval",
      ]);
      expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|now\(\)/i);
    }
  });

  it("each family query is valid, read-only SQL against the real migrated schema and returns one 0/0 row for a learner with no claims", async () => {
    const { ADMISSION_FAMILIES } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    const { testDatabase } = await import("./db-helper");
    const db = await testDatabase();
    try {
      for (const family of Object.values(ADMISSION_FAMILIES) as {
        sql: string;
      }[]) {
        const { rows } = await db.query(family.sql, [
          "00000000-0000-4000-8000-00000000abcd",
        ]);
        expect(rows).toEqual([{ last_minute: 0, last_hour: 0 }]);
      }
    } finally {
      await db.close();
    }
  }, 120_000);

  it("is exhausted at >= 5 in the last minute or >= 30 in the last hour, and available just below", async () => {
    const { admissionWindowExhausted, ADMISSION_FAMILIES } =
      await import("../scripts/acceptance/concurrency-app-races.mjs");
    const family = ADMISSION_FAMILIES.RECOVERY;
    expect(admissionWindowExhausted(family, JUST_BELOW)).toBeNull();
    expect(admissionWindowExhausted(family, OPEN)).toBeNull();
    expect(admissionWindowExhausted(family, FULL_MINUTE)).toBe(
      "recovery claims (commercial_v1_examiner_recovery_executions): 5 created in the last 60 s (limit 5).",
    );
    expect(admissionWindowExhausted(family, FULL_HOUR)).toBe(
      "recovery claims (commercial_v1_examiner_recovery_executions): 30 created in the last hour (limit 30).",
    );
  });
});

describe("LATE_INITIAL: an exhausted admission window is BLOCKED, never FAIL", () => {
  it.each([
    ["initial", { INITIAL: FULL_MINUTE }, "initial grading claims"],
    ["recovery", { RECOVERY: FULL_HOUR }, "recovery claims"],
  ] as const)(
    "%s window exhausted -> BLOCKED before any fresh grading operation",
    async (_label, windows, familyLabel) => {
      const { startProviderStub } = await loadStub();
      const stub = await startProviderStub();
      try {
        const world = await lateWorld(stub, { windows: { ...windows } });
        const result = await runRace(
          world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
        );
        expect(result.status).toBe("BLOCKED");
        expect(result.details!.join("\n")).toContain(familyLabel);
        expect(world.operations).toEqual([]);
        expect(world.learnerCalls).not.toContain("start_assessment_attempt");
        expect(world.executions).toHaveLength(0);
        expect(world.recoveries).toHaveLength(0);
        expect(stub.calls).toHaveLength(0);
        expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
      } finally {
        await stub.close();
      }
    },
  );

  it("a recovery window exhausted by the time of the fresh recovery admission -> BLOCKED with no recovery dispatched, and nothing hangs", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub, {
        windows: { RECOVERY: [{ ...OPEN }, { ...FULL_MINUTE }] },
      });
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.status).toBe("BLOCKED");
      expect(result.details!.join("\n")).toContain(
        "recovery claims (commercial_v1_examiner_recovery_executions): 5 created in the last 60 s (limit 5).",
      );
      expect(world.operations).not.toContain("RECOVER_EXAMINER_TARGET");
      expect(world.recoveries).toHaveLength(0);
      expect(world.executions.map((e) => e.state)).toEqual(["TIMEOUT"]);
      expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
    } finally {
      await stub.close();
    }
  });

  it("counts just below both thresholds do not block", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await lateWorld(stub, {
        windows: { INITIAL: { ...JUST_BELOW }, RECOVERY: { ...JUST_BELOW } },
      });
      const result = await runRace(
        world.races.scenarioLateInitialFinalizeVsRecovery(world.ctx),
      );
      expect(result.status).toBe("PASS");
      expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
    } finally {
      await stub.close();
    }
  });
});

describe("REGRADE_VS_COMPLETION: an exhausted admission window is BLOCKED, never FAIL", () => {
  it.each([
    ["initial", { INITIAL: FULL_HOUR }, "initial grading claims"],
    ["regrade", { REGRADE: FULL_MINUTE }, "regrade claims"],
  ] as const)(
    "%s window exhausted -> BLOCKED before any fresh grading operation",
    async (_label, windows, familyLabel) => {
      const { startProviderStub } = await loadStub();
      const stub = await startProviderStub();
      try {
        const world = await regradeWorld(stub, "REGRADE_FIRST", {
          windows: { ...windows },
        });
        const result = await runRace(
          world.races.scenarioRegradeVsCompletion(world.ctx),
        );
        expect(result.status).toBe("BLOCKED");
        expect(result.details!.join("\n")).toContain(familyLabel);
        expect(world.operations).toEqual([]);
        expect(world.learnerCalls).not.toContain("start_assessment_attempt");
        expect(world.revisions).toHaveLength(0);
        expect(world.receipts).toHaveLength(0);
        expect(stub.calls).toHaveLength(0);
        expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
      } finally {
        await stub.close();
      }
    },
  );

  it("a regrade window exhausted by the time of the fresh regrade admission -> BLOCKED with no regrade or completion dispatched", async () => {
    const { startProviderStub } = await loadStub();
    const stub = await startProviderStub();
    try {
      const world = await regradeWorld(stub, "REGRADE_FIRST", {
        windows: { REGRADE: [{ ...OPEN }, { ...FULL_HOUR }] },
      });
      const result = await runRace(
        world.races.scenarioRegradeVsCompletion(world.ctx),
      );
      expect(result.status).toBe("BLOCKED");
      expect(result.details!.join("\n")).toContain(
        "regrade claims (commercial_v1_examiner_regrade_executions): 30 created in the last hour (limit 30).",
      );
      expect(world.operations).toEqual(["SUBMIT_AND_GRADE_ASSESSMENT"]);
      expect(world.claims).toHaveLength(0);
      expect(world.receipts).toHaveLength(0);
      expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
    } finally {
      await stub.close();
    }
  });

  it.each(["REGRADE_FIRST", "COMPLETION_FIRST"] as const)(
    "counts just below both thresholds do not block (%s)",
    async (order) => {
      const { startProviderStub } = await loadStub();
      const stub = await startProviderStub();
      try {
        const world = await regradeWorld(stub, order, {
          windows: { INITIAL: { ...JUST_BELOW }, REGRADE: { ...JUST_BELOW } },
        });
        const result = await runRace(
          world.races.scenarioRegradeVsCompletion(world.ctx),
        );
        expect(result.status).toBe("PASS");
        expectOnlyReadOnlyAdmissionQueries(world.sqlSeen);
      } finally {
        await stub.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Static guards: the race tooling never signs, never writes directly and
// never reaches a provider on its own.
// ---------------------------------------------------------------------------
describe("race tooling reaches authority only through the real app and governed RPCs", () => {
  it("never signs, digests, names a MAC parameter, calls a govern RPC, writes SQL, edits a lease or fetches", async () => {
    const text = await readFile(
      new URL(
        "../scripts/acceptance/concurrency-app-races.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(text).not.toMatch(/createHmac|subtle\.sign|\.digest\(/);
    expect(text).not.toMatch(/HMAC_SHA256|p_mac\b|COMMERCIAL_V1_EXAMINER_V1/);
    expect(text).not.toMatch(/govern_commercial_v1|attest[A-Z]/);
    expect(text).not.toMatch(
      /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i,
    );
    expect(text).not.toMatch(/\bfetch\(|openai\.com|anthropic\.com|_API_KEY/);
    // The only operations it sends are the route's existing bounded ones.
    const operations = [...text.matchAll(/operation: "([A-Z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(operations)).toEqual(
      new Set([
        "SUBMIT_AND_GRADE_ASSESSMENT",
        "RECOVER_EXAMINER_TARGET",
        "REGRADE_CONTROLLED_ASSESSMENT",
      ]),
    );
  });

  it("concurrency.mjs executes the application races instead of the old NOT_RUN placeholders", async () => {
    const text = await readFile(
      new URL("../scripts/acceptance/concurrency.mjs", import.meta.url),
      "utf8",
    );
    expect(text).not.toMatch(/NotRun\b|notRun\(/);
    expect(text).toContain("scenarioApplicationRaces");
    expect(text).toContain("runAppRaceScenarios");
  });

  it("the acceptance route offers no hold or race control", async () => {
    const route = await readFile(
      new URL(
        "../src/app/api/acceptance/examiner-app/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(route).not.toMatch(
      /holdNext|contextHold|_HOLD|HOLD_|acceptance-holds/,
    );
  });
});
