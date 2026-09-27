import { randomUUID } from "node:crypto";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  submissionGradingFixture,
  questionIdOf,
  asPolicyUser,
  learnerAuth,
  type SubmissionGradingFixture,
} from "./commercial-v1-submission-grading-fixture";
import {
  submissionGradingClient,
  newSubmissionGradingClientState,
  type SubmissionGradingClientState,
} from "./commercial-v1-submission-grading-client";
import {
  startProviderStub,
  createProviderRedirectFetch,
} from "../scripts/acceptance/examiner-provider-stub.mjs";

// ============================================================================
// End to end, against the REAL migrated schema (PGlite, authenticated role,
// all RLS/ACLs, the real migration-031/036 HMAC verification and FINALIZE):
//
//   acceptance route (real gate + parsing)
//   -> submitControlledAssessmentAndGrade (real)
//   -> gradeControlledAssessmentAttempt (real)
//   -> commercial-v1-examiner-grading/authority.ts (real HMAC signing)
//   -> govern_commercial_v1_examiner_execution (real DB verification)
//   -> real EXAMINER_COMMERCIAL_V1 profile -> real OpenAI Responses adapter
//   -> createProviderRedirectFetch (the driver's preload logic)
//   -> startProviderStub (the driver's real loopback stub server)
//   -> real response/usage/marks validation -> real FINALIZE
//
// Only the Supabase transport (a PGlite-backed client) and APP_URL are
// substituted. This is the local proof that the examiner-app driver's
// provider stub genuinely satisfies the production adapter, and that the
// route reaches the production grading authority rather than any copy of it.
// ============================================================================

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({
  config: () => ({ configured: true, appUrl: "http://127.0.0.1:3100" }),
}));

import { POST } from "@/app/api/acceptance/examiner-app/route";

const TOKEN = "e".repeat(64);
const REDIRECT_TOKEN = "7".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";

let f: SubmissionGradingFixture;
let stub: Awaited<ReturnType<typeof startProviderStub>>;
const realFetch = globalThis.fetch;
const state: SubmissionGradingClientState = newSubmissionGradingClientState();

beforeAll(async () => {
  f = await submissionGradingFixture();
  stub = await startProviderStub();
}, 60000);
afterAll(async () => {
  await stub?.close();
  await f?.db.close();
});
beforeEach(async () => {
  await f.db.exec("begin");
  state.rpcLog.length = 0;
  stub.calls.length = 0;
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", f.keyId);
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", f.key.toString("hex"));
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_ENABLED", "true");
  vi.stubEnv("ACCEPTANCE_APP_DRIVER_TOKEN", TOKEN);
  vi.stubEnv("ACCEPTANCE_ENVIRONMENT_ID", ENV_ID);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OPENAI_API_KEY", stub.apiKey);
  // Exactly what the driver's preload installs in the app process: the
  // redirect wrapper marked with this run's redirect token, which the route
  // gate attests before accepting the request.
  vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", REDIRECT_TOKEN);
  vi.stubGlobal(
    "fetch",
    createProviderRedirectFetch(realFetch, stub.url, REDIRECT_TOKEN),
  );
  mocks.client.mockImplementation(async () => {
    const client = submissionGradingClient(f.db, state);
    return {
      ...client,
      async rpc(name: string, args: Record<string, unknown> = {}) {
        // The operator-provisioned acceptance-environment RPC is never a
        // Ducelio migration, so it is answered here like the hosted one.
        if (name === "get_ducelio_acceptance_environment_id")
          return { data: ENV_ID, error: null };
        return client.rpc(name, args);
      },
    };
  });
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function actAsLearner() {
  await asPolicyUser(f.db, 1);
  state.authUser = {
    id: learnerAuth(1),
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}
async function rows<T>(sql: string, params: unknown[] = []) {
  await f.db.exec("reset role");
  const result = (await f.db.query<T>(sql, params)).rows;
  await actAsLearner();
  return result;
}
async function answeredAttempt() {
  await actAsLearner();
  const questionId = await questionIdOf(f, f.assessmentIds.QUIZ_1);
  const attemptId = (
    await f.db.query<{ v: string }>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    )
  ).rows[0].v;
  await f.db.query(
    "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
    [
      attemptId,
      questionId,
      "Synthetic acceptance learner response.",
      randomUUID(),
    ],
  );
  await actAsLearner();
  return attemptId;
}
function grade(attemptId: string) {
  return POST(
    new Request("http://127.0.0.1:3100/api/acceptance/examiner-app", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3100",
        "x-ducelio-acceptance-driver": TOKEN,
      },
      body: JSON.stringify({
        operation: "SUBMIT_AND_GRADE_ASSESSMENT",
        attemptId,
      }),
    }),
  );
}

describe("examiner-app acceptance route: real grading lifecycle against the migrated schema", () => {
  it("grades through the real authority and the real adapter via the driver's stub: one SUCCEEDED execution, one valid revision, full marks; replay adds nothing", async () => {
    const attemptId = await answeredAttempt();
    const response = await grade(attemptId);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      result: { attemptId, grading: "GRADED" },
    });
    // The real AUTHORIZE/START/CONTEXT_READ/FINALIZE chain ran.
    expect(state.rpcLog).toEqual([
      "submit_assessment_attempt",
      "govern_commercial_v1_examiner_execution",
      "govern_commercial_v1_examiner_execution",
      "get_commercial_v1_examiner_assessment_context",
      "govern_commercial_v1_examiner_execution",
    ]);
    expect(stub.calls).toEqual([
      {
        capability: "grade_controlled_assessment",
        attemptId,
        outcome: "GRADED",
      },
    ]);

    const executions = await rows<{
      id: string;
      state: string;
      result_revision_id: string;
      provider_calls: number;
    }>(
      `select e.id, e.state, e.result_revision_id, u.provider_calls
       from commercial_v1_examiner_executions e
       left join commercial_v1_examiner_execution_usage u on u.execution_id=e.id
       where e.attempt_id=$1`,
      [attemptId],
    );
    expect(executions).toHaveLength(1);
    expect(executions[0].state).toBe("SUCCEEDED");
    expect(executions[0].provider_calls).toBe(1);
    const revisions = await rows<{
      id: string;
      revision_number: number;
      earned_marks_total: number;
      max_marks_total: number;
      valid: boolean;
    }>(
      `select r.id, r.revision_number, r.earned_marks_total, r.max_marks_total,
              commercial_v1_private.assessment_result_is_valid(r.id) as valid
       from commercial_v1_assessment_result_revisions r where r.attempt_id=$1`,
      [attemptId],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: executions[0].result_revision_id,
      revision_number: 1,
      valid: true,
    });
    // The stub's deterministic rule: full marks for each answered question.
    expect(revisions[0].earned_marks_total).toBe(revisions[0].max_marks_total);

    // Replay: no new execution, provider call or revision.
    const replay = await grade(attemptId);
    expect((await replay.json()).result.grading).toBe("GRADED");
    expect(stub.calls).toHaveLength(1);
    expect(
      await rows(
        "select 1 from commercial_v1_examiner_executions where attempt_id=$1",
        [attemptId],
      ),
    ).toHaveLength(1);
    expect(
      await rows(
        "select 1 from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [attemptId],
      ),
    ).toHaveLength(1);
    // The HTTP body never carries protected assessment content.
    for (const marker of ["expectedAnswer", "markingGuidance", "prompt"])
      expect(text).not.toContain(marker);
  });

  it("a planned stub failure yields a genuinely recoverable FAILED/PROVIDER_UNAVAILABLE execution and no result -- the path the driver uses to create its recovery fixture", async () => {
    const attemptId = await answeredAttempt();
    stub.planFailure();
    const response = await grade(attemptId);
    expect((await response.json()).result.grading).toBe("GRADING_UNAVAILABLE");
    const executions = await rows<{ state: string; reason_code: string }>(
      "select state, reason_code from commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(executions).toEqual([
      { state: "FAILED", reason_code: "PROVIDER_UNAVAILABLE" },
    ]);
    expect(
      await rows(
        "select 1 from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [attemptId],
      ),
    ).toHaveLength(0);
  });

  it("with no provider key in the app process the real chain records NO_PROVIDER_CONFIGURED and never fabricates a grade", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const attemptId = await answeredAttempt();
    const response = await grade(attemptId);
    expect((await response.json()).result.grading).toBe("GRADING_UNAVAILABLE");
    expect(stub.calls).toHaveLength(0);
    const executions = await rows<{ state: string; reason_code: string }>(
      "select state, reason_code from commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(executions).toEqual([
      { state: "FAILED", reason_code: "NO_PROVIDER_CONFIGURED" },
    ]);
  });
});
