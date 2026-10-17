import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  submissionGradingFixture,
  questionIdOf,
  asPolicyUser,
  learnerAuth,
  type SubmissionGradingFixture,
} from "./commercial-v1-submission-grading-fixture";
import { MIGRATION_059_FIXTURE } from "./commercial-v1-assessment-policy-fixture";
import {
  submissionGradingClient,
  newSubmissionGradingClientState,
  type SubmissionGradingClientState,
} from "./commercial-v1-submission-grading-client";
import {
  startProviderStub,
  createProviderRedirectFetch,
} from "../scripts/acceptance/examiner-provider-stub.mjs";
import {
  academicReviewCaseSchema,
  type AcademicReviewCase,
} from "@/domain/commercial-v1-academic-review";

// ============================================================================
// CP2 deployment bridge, end to end against REAL migrated schemas: this
// application (pre-CP2 code plus the bridge) against
//   * schema 058 -- this repository's chain, what hosted runs today; and
//   * schema 059 -- the same chain plus the reviewed migration 059
//     (tests/fixtures, SHA-256 pinned below), what hosted runs once CP2's
//     migration is applied while this application is still deployed.
// The examiner-app acceptance route, submission grading, the real HMAC
// authority, real DB verification, the real OpenAI Responses adapter and
// the driver's loopback provider stub all run unmodified; only the Supabase
// transport (PGlite) and APP_URL are substituted, exactly as in
// tests/acceptance-examiner-app-grading-db.test.ts. Synthetic content only.
// ============================================================================

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  attestRecoveryContext: vi.fn(),
  attestRegradeContext: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({
  config: () => ({ configured: true, appUrl: "http://127.0.0.1:3100" }),
}));
vi.mock(
  "@/server/commercial-v1-examiner-recovery/authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/server/commercial-v1-examiner-recovery/authority")
    >()),
    attestRecoveryContext: mocks.attestRecoveryContext,
  }),
);
vi.mock(
  "@/server/commercial-v1-examiner-regrade/authority",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/server/commercial-v1-examiner-regrade/authority")
    >()),
    attestRegradeContext: mocks.attestRegradeContext,
  }),
);

import { POST } from "@/app/api/acceptance/examiner-app/route";
import {
  getAcademicReviewWorkspace,
  submitAssessmentReviewGrade,
} from "@/server/commercial-v1-academic-review";
import { getRecoveryContext } from "@/server/commercial-v1-examiner-recovery/context";
import { getRegradeContext } from "@/server/commercial-v1-examiner-regrade/context";
import type { RecoverySnapshot } from "@/domain/commercial-v1-examiner-recovery";
import type { RegradeSnapshot } from "@/domain/commercial-v1-examiner-regrade";
import {
  examinerAssessmentContextSchema,
  examinerAssessmentContextWireSchema,
  legacyExaminerAssessmentContext,
} from "@/domain/commercial-v1-examiner-grading";

const TOKEN = "e".repeat(64);
const REDIRECT_TOKEN = "7".repeat(64);
const ENV_ID = "a0000000-0000-4000-8000-000000000001";
const SCHEMAS = [
  { schema: "058", migration059: false },
  { schema: "059", migration059: true },
] as const;
type Schema = (typeof SCHEMAS)[number]["schema"];

// Synthetic objective + free-text QUIZ_1 in migration 059's additive
// COURSE_PACKAGE_V1 question format (not real exam content).
const OBJECTIVE_QUIZ_1 = [
  {
    position: 1,
    prompt: "Synthetic demo choice question (not real exam content).",
    maxMarks: 2,
    expectedAnswer: "Synthetic protected rationale sentinel",
    markingGuidance: null,
    objectiveRefs: ["obj-1"],
    questionType: "SINGLE_SELECT",
    interaction: {
      options: [1, 2, 3].map((n) => ({
        id: `o${n}`,
        label: `Synthetic option ${n}`,
      })),
    },
    answerKey: { correctOptionId: "o2" },
  },
  {
    position: 2,
    prompt: "Synthetic written question (not real exam content).",
    maxMarks: 5,
    expectedAnswer: "Synthetic protected free-text answer sentinel",
    markingGuidance: null,
    objectiveRefs: ["obj-1"],
  },
];

// Evidence carried between the per-schema blocks (vitest runs a file's
// describe blocks sequentially).
const evidence = {
  providerBodies: {} as Partial<Record<Schema, string>>,
  contexts: {} as Partial<Record<Schema | "059-objective", unknown>>,
};

const realFetch = globalThis.fetch;
const state: SubmissionGradingClientState = newSubmissionGradingClientState();

function uuidNormalised(text: string) {
  const seen = new Map<string, string>();
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (id) => {
      if (!seen.has(id)) seen.set(id, `<uuid-${seen.size + 1}>`);
      return seen.get(id)!;
    },
  );
}

// The human academic review RPC surface (migration 047, wrapped by 059),
// forwarded for real under the authenticated reviewer's role with named,
// explicitly cast parameters -- the same shape as the grading client.
const REVIEW_RPCS: Record<string, [string, string][]> = {
  list_commercial_v1_academic_review_cases: [],
  get_commercial_v1_academic_review_case: [["p_case_id", "uuid"]],
  submit_commercial_v1_academic_review_assessment_grade: [
    ["p_case_id", "uuid"],
    ["p_marks", "jsonb"],
    ["p_reason", "text"],
  ],
};
async function reviewRpc(
  f: SubmissionGradingFixture,
  name: string,
  args: Record<string, unknown>,
) {
  await f.db.exec("savepoint bridge_review_rpc");
  try {
    const params = REVIEW_RPCS[name];
    const result = await f.db.query<{ v: unknown }>(
      `select public.${name}(${params
        .map(([p, cast], i) => `${p} => $${i + 1}::${cast}`)
        .join(",")}) as v`,
      params.map(([p, cast]) =>
        cast === "jsonb" ? JSON.stringify(args[p]) : args[p],
      ),
    );
    await f.db.exec("release savepoint bridge_review_rpc");
    return { data: result.rows[0]?.v ?? null, error: null };
  } catch (e) {
    await f.db.exec(
      "rollback to savepoint bridge_review_rpc; release savepoint bridge_review_rpc",
    );
    return { data: null, error: { message: (e as Error).message } };
  }
}

// One isolated fixture per scenario: env, transport and capture wiring are
// identical to the existing examiner-app grading suite.
function scenario(
  options: Parameters<typeof submissionGradingFixture>[0],
  capture: { context?: Schema | "059-objective"; body?: Schema } = {},
) {
  const ctx = {} as {
    f: SubmissionGradingFixture;
    stub: Awaited<ReturnType<typeof startProviderStub>>;
  };
  beforeAll(async () => {
    ctx.f = await submissionGradingFixture(options);
    ctx.stub = await startProviderStub();
  }, 120000);
  afterAll(async () => {
    await ctx.stub?.close();
    await ctx.f?.db.close();
  });
  beforeEach(async () => {
    const { f, stub } = ctx;
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
    vi.stubEnv("ACCEPTANCE_PROVIDER_REDIRECT_TOKEN", REDIRECT_TOKEN);
    const recordingFetch: typeof fetch = async (input, init) => {
      if (
        capture.body &&
        String(input instanceof Request ? input.url : input).startsWith(
          stub.url,
        ) &&
        typeof init?.body === "string"
      )
        evidence.providerBodies[capture.body] = init.body;
      return realFetch(input, init);
    };
    vi.stubGlobal(
      "fetch",
      createProviderRedirectFetch(recordingFetch, stub.url, REDIRECT_TOKEN),
    );
    mocks.client.mockImplementation(async () => {
      const client = submissionGradingClient(f.db, state);
      return {
        ...client,
        async rpc(name: string, args: Record<string, unknown> = {}) {
          if (name === "get_ducelio_acceptance_environment_id")
            return { data: ENV_ID, error: null };
          if (name in REVIEW_RPCS) return reviewRpc(f, name, args);
          const result = await client.rpc(name, args);
          if (
            capture.context &&
            name === "get_commercial_v1_examiner_assessment_context"
          )
            evidence.contexts[capture.context] = result.data;
          return result;
        },
      };
    });
  });
  afterEach(async () => {
    await ctx.f.db.exec("rollback; reset role");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  return ctx;
}

async function actAs(f: SubmissionGradingFixture, n: 1 | 2) {
  await asPolicyUser(f.db, n);
  state.authUser = {
    id: learnerAuth(n),
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}
async function rows<T>(
  f: SubmissionGradingFixture,
  sql: string,
  params: unknown[] = [],
) {
  await f.db.exec("reset role");
  return (await f.db.query<T>(sql, params)).rows;
}
async function quizQuestions(f: SubmissionGradingFixture) {
  return rows<{ id: string; position: number }>(
    f,
    "select id, position from assessment_questions where assessment_id=$1 order by position",
    [f.assessmentIds.QUIZ_1],
  );
}
async function startAttempt(f: SubmissionGradingFixture) {
  await actAs(f, 1);
  return (
    await f.db.query<{ v: string }>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    )
  ).rows[0].v;
}
async function save(
  f: SubmissionGradingFixture,
  attemptId: string,
  questionId: string,
  body: string,
) {
  await actAs(f, 1);
  return (
    await f.db.query<{ v: { ok: boolean } }>(
      "select record_commercial_v1_assessment_response($1,$2,$3,$4) as v",
      [attemptId, questionId, body, randomUUID()],
    )
  ).rows[0].v;
}
async function freeTextAttempt(f: SubmissionGradingFixture) {
  const attemptId = await startAttempt(f);
  const questionId = await questionIdOf(f, f.assessmentIds.QUIZ_1);
  expect(
    (
      await save(
        f,
        attemptId,
        questionId,
        "Synthetic acceptance learner response.",
      )
    ).ok,
  ).toBe(true);
  await actAs(f, 1);
  return attemptId;
}
async function objectiveAttempt(f: SubmissionGradingFixture) {
  const attemptId = await startAttempt(f);
  const [choice, written] = await quizQuestions(f);
  // Canonical structured body of migration 059's SINGLE_SELECT.
  expect((await save(f, attemptId, choice.id, '{"optionId":"o2"}')).ok).toBe(
    true,
  );
  expect(
    (await save(f, attemptId, written.id, "Synthetic written answer.")).ok,
  ).toBe(true);
  await actAs(f, 1);
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
// Each test runs in its own rolled-back transaction on a fresh fixture, so
// exactly one escalated QUIZ_1 assessment case exists.
function onlyEscalatedQuizCase(
  cases: Awaited<ReturnType<typeof getAcademicReviewWorkspace>>["cases"],
) {
  const matching = cases.filter(
    (c) =>
      c.targetKind === "ASSESSMENT_ATTEMPT" &&
      c.component === "QUIZ_1" &&
      c.caseState === "ESCALATED",
  );
  expect(matching).toHaveLength(1);
  return matching[0];
}
async function executionsOf(f: SubmissionGradingFixture, attemptId: string) {
  return rows<{
    state: string;
    reason_code: string | null;
    provider_calls: number | null;
  }>(
    f,
    `select e.state, e.reason_code, u.provider_calls
     from commercial_v1_examiner_executions e
     left join commercial_v1_examiner_execution_usage u on u.execution_id=e.id
     where e.attempt_id=$1`,
    [attemptId],
  );
}

it("the migration 059 fixture is byte-identical to the reviewed CP2 migration", () => {
  expect(
    createHash("sha256")
      .update(readFileSync(MIGRATION_059_FIXTURE))
      .digest("hex"),
  ).toBe("2a200a89ed11625703cd326b30ffdcc8df2462e5f9089ece5c677df71db1f2f7");
});

describe.each(SCHEMAS)(
  "free-text Examiner grading on schema $schema",
  ({ schema, migration059 }) => {
    const ctx = scenario({ migration059 }, { context: schema, body: schema });

    it("the database is on the intended schema", async () => {
      const [{ present }] = await rows<{ present: boolean }>(
        ctx.f,
        "select to_regnamespace('assessment_interaction_private') is not null as present",
      );
      expect(present).toBe(migration059);
    });

    it("grades through the real chain: one SUCCEEDED execution, one valid full-marks revision; replay adds nothing", async () => {
      const { f, stub } = ctx;
      const attemptId = await freeTextAttempt(f);
      const response = await grade(attemptId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        result: { attemptId, grading: "GRADED" },
      });
      expect(state.rpcLog).toEqual([
        "submit_assessment_attempt",
        "govern_commercial_v1_examiner_execution",
        "govern_commercial_v1_examiner_execution",
        "get_commercial_v1_examiner_assessment_context",
        "govern_commercial_v1_examiner_execution",
      ]);
      expect(stub.calls).toHaveLength(1);
      expect(await executionsOf(f, attemptId)).toEqual([
        { state: "SUCCEEDED", reason_code: "GRADED", provider_calls: 1 },
      ]);
      const revisions = await rows<{
        earned: number;
        max: number;
        valid: boolean;
      }>(
        f,
        `select earned_marks_total as earned, max_marks_total as max,
                commercial_v1_private.assessment_result_is_valid(id) as valid
         from commercial_v1_assessment_result_revisions where attempt_id=$1`,
        [attemptId],
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0].valid).toBe(true);
      expect(revisions[0].earned).toBe(revisions[0].max);
      await actAs(f, 1);
      expect((await (await grade(attemptId)).json()).result.grading).toBe(
        "GRADED",
      );
      expect(stub.calls).toHaveLength(1);
      expect(
        await rows(
          f,
          "select 1 from commercial_v1_assessment_result_revisions where attempt_id=$1",
          [attemptId],
        ),
      ).toHaveLength(1);
    });

    it("a provider failure still yields the recoverable FAILED/PROVIDER_UNAVAILABLE execution and no result", async () => {
      const { f, stub } = ctx;
      const attemptId = await freeTextAttempt(f);
      stub.planFailure();
      expect((await (await grade(attemptId)).json()).result.grading).toBe(
        "GRADING_UNAVAILABLE",
      );
      expect(await executionsOf(f, attemptId)).toEqual([
        {
          state: "FAILED",
          reason_code: "PROVIDER_UNAVAILABLE",
          provider_calls: 1,
        },
      ]);
    });
  },
);

describe("the free-text provider request is unchanged by migration 059", () => {
  it("059 adds only the zero objective keys to the database context", () => {
    const before = evidence.contexts["058"] as Record<string, unknown>;
    const after = evidence.contexts["059"] as Record<string, unknown>;
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(before).not.toHaveProperty("objectiveMarks");
    expect(before).not.toHaveProperty("objectiveQuestionCount");
    expect(after.objectiveMarks).toEqual([]);
    expect(after.objectiveQuestionCount).toBe(0);
    const {
      objectiveMarks: _marks,
      objectiveQuestionCount: _count,
      ...rest
    } = after;
    void _marks;
    void _count;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(before).sort());
    expect(uuidNormalised(JSON.stringify(rest))).toBe(
      uuidNormalised(JSON.stringify(before)),
    );
  });

  it("the provider HTTP request body is byte-identical on 058 and 059 (identifiers normalised)", () => {
    const before = evidence.providerBodies["058"];
    const after = evidence.providerBodies["059"];
    expect(before).toBeTruthy();
    expect(uuidNormalised(after!)).toBe(uuidNormalised(before!));
    expect(after).not.toContain("objectiveMarks");
    expect(after).not.toContain("objectiveQuestionCount");
  });
});

describe("schema 059 with an objective question: this application fails closed", () => {
  const ctx = scenario(
    { migration059: true, quiz1QuestionsAfterValidation: OBJECTIVE_QUIZ_1 },
    { context: "059-objective" },
  );

  it("refuses before any provider call: one FAILED/INTERNAL_ERROR execution with zero usage, no result, no marks", async () => {
    const { f, stub } = ctx;
    const attemptId = await objectiveAttempt(f);
    const response = await grade(attemptId);
    expect(response.status).toBe(200);
    expect((await response.json()).result.grading).toBe("GRADING_UNAVAILABLE");
    expect(stub.calls).toHaveLength(0);
    expect(await executionsOf(f, attemptId)).toEqual([
      { state: "FAILED", reason_code: "INTERNAL_ERROR", provider_calls: 0 },
    ]);
    expect(
      await rows(
        f,
        "select 1 from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [attemptId],
      ),
    ).toHaveLength(0);
    // The database context that was refused really carried the objective
    // question (removed from `questions`, marked by the DB scorer).
    const context = evidence.contexts["059-objective"] as {
      questions: unknown[];
      objectiveMarks: { marksAwarded: number }[];
      objectiveQuestionCount: number;
    };
    expect(context.objectiveQuestionCount).toBe(1);
    expect(context.questions).toHaveLength(1);
    expect(context.objectiveMarks).toEqual([
      expect.objectContaining({ marksAwarded: 2 }),
    ]);
  });
});

function recoverySnapshot(attemptId: string, component: string) {
  return {
    targetKind: "ASSESSMENT_ATTEMPT",
    capability: "grade_controlled_assessment",
    attemptId,
    component,
    submissionId: null,
    practicalId: null,
    sourceExecutionId: randomUUID(),
    sourceResultRevisionId: randomUUID(),
  };
}

describe("recovery and regrade context readers with the real database contexts", () => {
  const cases = [
    { name: "058", accept: true },
    { name: "059", accept: true },
    { name: "059-objective", accept: false },
  ] as const;
  it.each(cases)(
    "context from $name: accepted=$accept, and an accepted context is exactly the pre-059 shape",
    async ({ name, accept }) => {
      const wire = evidence.contexts[name] as Record<string, unknown> & {
        attemptId: string;
        component: string;
      };
      expect(wire).toBeTruthy();
      const snapshot = recoverySnapshot(wire.attemptId, wire.component);
      mocks.attestRecoveryContext.mockResolvedValueOnce(wire);
      mocks.attestRegradeContext.mockResolvedValueOnce(wire);
      const recovery = getRecoveryContext(
        snapshot as unknown as RecoverySnapshot,
        "Bridge compatibility check",
      );
      const regrade = getRegradeContext(
        snapshot as unknown as RegradeSnapshot,
        "Bridge compatibility check",
      );
      if (!accept) {
        await expect(recovery).rejects.toMatchObject({
          code: "SERVICE_UNAVAILABLE",
        });
        await expect(regrade).rejects.toMatchObject({
          code: "SERVICE_UNAVAILABLE",
        });
        return;
      }
      const legacyKeys = Object.keys(evidence.contexts["058"] as object)
        .filter((k) => k !== "ok")
        .sort();
      for (const result of [await recovery, await regrade]) {
        expect(result.kind).toBe("ASSESSMENT");
        expect(Object.keys(result.context).sort()).toEqual(legacyKeys);
      }
    },
  );
});

describe.each(SCHEMAS)(
  "academic review of an escalated free-text attempt on schema $schema",
  ({ migration059 }) => {
    const ctx = scenario({ migration059, escalateToAcademicReview: true });

    it("the open case is readable through the application and a human grade records", async () => {
      const { f, stub } = ctx;
      const attemptId = await freeTextAttempt(f);
      expect((await (await grade(attemptId)).json()).result.grading).toBe(
        "ESCALATED",
      );
      expect(stub.calls).toHaveLength(0);
      await actAs(f, 2);
      const workspace = await getAcademicReviewWorkspace();
      const summary = onlyEscalatedQuizCase(workspace.cases);
      expect(summary).toBeTruthy();
      await actAs(f, 2);
      const opened = await getAcademicReviewWorkspace(summary!.caseId);
      expect(opened.selectedError).toBeNull();
      const selected = opened.selected as Extract<
        AcademicReviewCase,
        { targetKind: "ASSESSMENT_ATTEMPT" }
      >;
      expect(selected.assessment.questions).toHaveLength(1);
      expect(selected.assessment.questions[0].objective ?? null).toBeNull();
      await actAs(f, 2);
      const graded = await submitAssessmentReviewGrade({
        caseId: summary!.caseId,
        marks: [
          {
            questionId: selected.assessment.questions[0].questionId,
            marksAwarded: 3,
          },
        ],
        reason: "Bridge compatibility human review",
      });
      expect(graded).toMatchObject({ ok: true });
    });
  },
);

describe("schema 059: an escalated objective attempt fails closed in this application's review", () => {
  const ctx = scenario({
    migration059: true,
    escalateToAcademicReview: true,
    quiz1QuestionsAfterValidation: OBJECTIVE_QUIZ_1,
  });

  it("the case list loads, the objective case is refused (SERVICE_UNAVAILABLE) and the DB refuses a non-deterministic mark", async () => {
    const { f } = ctx;
    const attemptId = await objectiveAttempt(f);
    expect((await (await grade(attemptId)).json()).result.grading).toBe(
      "ESCALATED",
    );
    await actAs(f, 2);
    const workspace = await getAcademicReviewWorkspace();
    const summary = onlyEscalatedQuizCase(workspace.cases)!;
    expect(summary).toBeTruthy();
    await actAs(f, 2);
    const opened = await getAcademicReviewWorkspace(summary.caseId);
    expect(opened.selected).toBeNull();
    expect(opened.selectedError).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    // The raw database case really is an objective case, and this
    // application's case schema refuses it rather than showing free text.
    await actAs(f, 2);
    const raw = (
      await f.db.query<{
        v: { assessment: { questions: { objective: unknown }[] } };
      }>("select public.get_commercial_v1_academic_review_case($1) as v", [
        summary.caseId,
      ])
    ).rows[0].v;
    expect(raw.assessment.questions.map((q) => q.objective === null)).toEqual([
      false,
      true,
    ]);
    expect(academicReviewCaseSchema.safeParse(raw).success).toBe(false);
    const [choice, written] = await quizQuestions(f);
    // Even a client that bypassed this application's refusal cannot land a
    // human objective mark that differs from the deterministic one (2): the
    // database refuses it specifically, and accepts the deterministic mark.
    const forged = await reviewRpc(
      f,
      "submit_commercial_v1_academic_review_assessment_grade",
      {
        p_case_id: summary.caseId,
        p_marks: [
          { questionId: choice.id, marksAwarded: 0 },
          { questionId: written.id, marksAwarded: 3 },
        ],
        p_reason: "Bridge forged objective mark",
      },
    );
    expect(forged.error?.message).toContain("OBJECTIVE_MARKS_MISMATCH");
    expect(
      await rows(
        f,
        "select 1 from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [attemptId],
      ),
    ).toHaveLength(0);
    await actAs(f, 2);
    const deterministic = await reviewRpc(
      f,
      "submit_commercial_v1_academic_review_assessment_grade",
      {
        p_case_id: summary.caseId,
        p_marks: [
          { questionId: choice.id, marksAwarded: 2 },
          { questionId: written.id, marksAwarded: 3 },
        ],
        p_reason: "Deterministic objective mark control",
      },
    );
    expect(deterministic.error).toBeNull();
  });
});

describe("bridge wire contracts (exact shapes only)", () => {
  const base = {
    attemptId: randomUUID(),
    assessmentId: randomUUID(),
    component: "QUIZ_1",
    title: "Synthetic",
    instructions: "Synthetic",
    questions: [
      {
        questionId: randomUUID(),
        position: 1,
        prompt: "Synthetic",
        maxMarks: 5,
        expectedAnswer: "Synthetic",
        markingGuidance: null,
        responseBody: "Synthetic",
      },
    ],
  };
  const mark = { questionId: randomUUID(), marksAwarded: 1 };
  it.each([
    ["pre-059 shape", {}, true],
    [
      "059 shape without objective questions",
      { objectiveMarks: [], objectiveQuestionCount: 0 },
      true,
    ],
    ["objectiveMarks alone", { objectiveMarks: [] }, false],
    ["objectiveQuestionCount alone", { objectiveQuestionCount: 0 }, false],
    [
      "a non-zero objective count",
      { objectiveMarks: [], objectiveQuestionCount: 1 },
      false,
    ],
    [
      "an objective mark",
      { objectiveMarks: [mark], objectiveQuestionCount: 0 },
      false,
    ],
  ] as const)("%s -> accepted=%s", (_name, extra, accepted) => {
    const wire = examinerAssessmentContextWireSchema.parse({
      ...base,
      ...extra,
    });
    const context = legacyExaminerAssessmentContext(wire);
    if (!accepted) return expect(context).toBeNull();
    expect(context).toEqual(base);
    expect(examinerAssessmentContextSchema.parse(context)).toEqual(base);
  });
  it("every other unknown or malformed key is still refused", () => {
    for (const extra of [
      { answerKey: {} },
      { objectiveMarks: [{ ...mark, extra: 1 }], objectiveQuestionCount: 0 },
      { objectiveQuestionCount: -1, objectiveMarks: [] },
      { objectiveQuestionCount: 0.5, objectiveMarks: [] },
    ])
      expect(
        examinerAssessmentContextWireSchema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
  });
  it("review questions accept only an absent or null objective", () => {
    const question = {
      questionId: randomUUID(),
      position: 1,
      prompt: "Synthetic",
      maxMarks: 5,
      expectedAnswer: null,
      markingGuidance: null,
      answered: true,
      responseBody: "Synthetic",
    };
    const reviewCase = (q: Record<string, unknown>) => ({
      caseId: randomUUID(),
      caseKind: "INITIAL_ESCALATION",
      caseState: "ESCALATED",
      caseReasonCode: "ACADEMIC_REVIEW",
      caseOpenedAt: "2026-10-17T00:00:00Z",
      targetKind: "ASSESSMENT_ATTEMPT",
      component: "QUIZ_1",
      targetTitle: null,
      programmeTitle: null,
      cohortTitle: null,
      learnerName: null,
      studentNumber: null,
      submittedAt: null,
      assessment: {
        title: "Synthetic",
        instructions: null,
        componentWeightBp: null,
        maxMarksTotal: 5,
        questions: [q],
      },
    });
    const ok = (q: Record<string, unknown>) =>
      academicReviewCaseSchema.safeParse(reviewCase(q)).success;
    expect(ok(question)).toBe(true);
    expect(ok({ ...question, objective: null })).toBe(true);
    expect(
      ok({
        ...question,
        objective: {
          questionType: "SINGLE_SELECT",
          interaction: {},
          deterministicMarks: 2,
        },
      }),
    ).toBe(false);
    expect(ok({ ...question, objective: {} })).toBe(false);
  });
});
