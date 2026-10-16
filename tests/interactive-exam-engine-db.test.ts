import { randomUUID } from "node:crypto";
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
  canonicalResponseBody,
  scoreObjectiveResponse,
  type ObjectiveQuestionType,
} from "@/domain/assessment-question-types";
import {
  submissionGradingFixture,
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
  FREE_TEXT_QUESTION,
  packageQuestions,
  syntheticObjectiveQuestions,
} from "./interactive-exam-fixture";
import { answerSaveIdempotencyKey } from "@/server/assessment-save-key";

// CP2 database + real server-orchestrator evidence for the interactive
// examination engine (migration 059). Every learner/admin action runs as a
// genuine authenticated session through the real SECURITY DEFINER RPCs and
// the real Examiner AUTHORIZE -> START -> CONTEXT_READ -> FINALIZE chain with
// real HMAC attestation (test controller key). Synthetic content only.
// PGlite is a single connection: these are deterministic sequential tests,
// not multi-connection concurrency evidence.

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
vi.mock("@/server/academic-runtime/runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/academic-runtime/runtime")>();
  return {
    ...actual,
    runGovernedProviderExecution: (...args: unknown[]) =>
      mocks.provider(...args) ??
      (actual.runGovernedProviderExecution as (...a: unknown[]) => unknown)(
        ...args,
      ),
  };
});

import { submitControlledAssessmentAndGrade } from "@/server/commercial-v1-submission-grading";

const questions = syntheticObjectiveQuestions();
const state: SubmissionGradingClientState = newSubmissionGradingClientState();

async function scalar<T = string>(
  f: SubmissionGradingFixture,
  sql: string,
  params: unknown[] = [],
) {
  await f.db.exec("reset role");
  return (await f.db.query<{ v: T }>(sql, params)).rows[0]?.v as T;
}
// Every statement that may legitimately fail runs inside its own savepoint,
// so a refusal never poisons the test's surrounding transaction.
async function sq<T = Record<string, unknown>>(
  f: SubmissionGradingFixture,
  sql: string,
  params: unknown[] = [],
) {
  await f.db.exec("savepoint cp2_statement");
  try {
    const result = await f.db.query<T>(sql, params);
    await f.db.exec("release savepoint cp2_statement");
    return result;
  } catch (error) {
    await f.db.exec(
      "rollback to savepoint cp2_statement; release savepoint cp2_statement",
    );
    throw error;
  }
}
async function actAs(f: SubmissionGradingFixture, n: number) {
  await asPolicyUser(f.db, n);
  state.authUser = {
    id: learnerAuth(n),
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}
async function questionIds(f: SubmissionGradingFixture) {
  await f.db.exec("reset role");
  return (
    await f.db.query<{ id: string; position: number }>(
      "select id,position from assessment_questions where assessment_id=$1 order by position",
      [f.assessmentIds.QUIZ_1],
    )
  ).rows.map((r) => r.id);
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
  key: string = randomUUID(),
) {
  await actAs(f, 1);
  return (
    await f.db.query<{ v: Record<string, unknown> }>(
      "select public.record_commercial_v1_assessment_response($1,$2,$3,$4) as v",
      [attemptId, questionId, body, key],
    )
  ).rows[0].v;
}
const body = (i: number, response: unknown) =>
  canonicalResponseBody(questions[i].questionType, response);
const PROTECTED_KEY_FIELDS = [
  "answerKey",
  "answer_key",
  "correctOptionId",
  "correctOptionIds",
  "correctOrder",
  "mapping",
  "Synthetic protected rationale sentinel",
];

function withTransaction(get: () => SubmissionGradingFixture) {
  beforeEach(async () => {
    const f = get();
    await f.db.exec("begin");
    state.rpcLog.length = 0;
    state.failRpc = undefined;
    vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", f.keyId);
    vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", f.key.toString("hex"));
    mocks.client.mockImplementation(async () =>
      submissionGradingClient(f.db, state),
    );
    mocks.provider.mockReturnValue(undefined);
  });
  afterEach(async () => {
    await get().db.exec("rollback; reset role");
    vi.unstubAllEnvs();
  });
}

// ---------------------------------------------------------------------------
describe("objective-only assessment (all five objective types)", () => {
  let f: SubmissionGradingFixture;
  beforeAll(async () => {
    f = await submissionGradingFixture({ quiz1Questions: packageQuestions() });
  }, 120000);
  afterAll(async () => {
    await f?.db.close();
  });
  withTransaction(() => f);

  it("activation materialised one protected definition and key per objective question", async () => {
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from assessment_question_interactions where assessment_id=$1",
          [f.assessmentIds.QUIZ_1],
        ),
      ),
    ).toBe(5);
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from assessment_question_objective_keys k join assessment_question_interactions i using(question_id) where i.assessment_id=$1",
          [f.assessmentIds.QUIZ_1],
        ),
      ),
    ).toBe(5);
    // Legacy free-text components carry no objective definition.
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from assessment_question_interactions where assessment_id=$1",
          [f.assessmentIds.QUIZ_2],
        ),
      ),
    ).toBe(0);
  });

  it("no learner-facing role can read the protected tables or the private scorer", async () => {
    for (const n of [1, 2, 3]) {
      await asPolicyUser(f.db, n);
      for (const table of [
        "assessment_question_interactions",
        "assessment_question_objective_keys",
      ])
        await expect(
          sq(f, `select * from public.${table} limit 1`),
        ).rejects.toThrow(/permission denied/);
      await expect(
        sq(
          f,
          "select assessment_interaction_private.objective_marks(gen_random_uuid(),gen_random_uuid())",
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("published definitions and keys are immutable, even to the database owner", async () => {
    const [q1] = await questionIds(f);
    await f.db.exec("reset role");
    await expect(
      sq(
        f,
        'update assessment_question_objective_keys set answer_key=\'{"correctOptionId":"o1"}\' where question_id=$1',
        [q1],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sq(
        f,
        "delete from assessment_question_interactions where question_id=$1",
        [q1],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("releases learner-visible definitions only inside the learner's own active attempt, never a key", async () => {
    await actAs(f, 1);
    await expect(
      sq(f, "select * from public.get_active_assessment_exam_state($1)", [
        f.assessmentIds.QUIZ_1,
      ]),
    ).rejects.toThrow(/active attempt/);
    await startAttempt(f);
    await actAs(f, 1);
    const rows = (
      await f.db.query<{ question_type: string; definition: unknown }>(
        "select * from public.get_active_assessment_exam_state($1)",
        [f.assessmentIds.QUIZ_1],
      )
    ).rows;
    expect(rows.map((r) => r.question_type)).toEqual(
      questions.map((q) => q.questionType),
    );
    const text = JSON.stringify(rows);
    for (const secret of PROTECTED_KEY_FIELDS)
      expect(text).not.toContain(secret);
    // A foreign learner gets nothing.
    await actAs(f, 3);
    await expect(
      sq(f, "select * from public.get_active_assessment_exam_state($1)", [
        f.assessmentIds.QUIZ_1,
      ]),
    ).rejects.toThrow();
  });

  it("validates every response against the published definition and refuses hostile input without writing", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    const hostile: [number, string][] = [
      [0, "not json"],
      [0, '{"optionId":"zz"}'],
      [0, '{"optionId":"o1","extra":true}'],
      [0, '{"optionIds":["o1"]}'],
      [1, '{"optionIds":["o1","o1"]}'],
      [1, '{"optionIds":["o1","o2","o3"]}'],
      [2, '{"matches":{"i1":"t1","i2":"t1"}}'],
      [2, '{"matches":{"i9":"t1"}}'],
      [3, '{"order":["s1","s2","s3"]}'],
      [3, '{"order":["s1","s1","s2","s3"]}'],
      [4, '{"values":{"action":"maybe"}}'],
      [4, '{"values":{"shell":"rm -rf /"}}'],
      [4, '{"values":{}}'],
      [0, JSON.stringify({ optionId: "o1".repeat(5000) })],
      [
        0,
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
      ],
    ];
    for (const [i, b] of hostile) {
      const result = await save(f, attemptId, ids[i], b);
      expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
    }
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from assessment_responses where attempt_id=$1",
          [attemptId],
        ),
      ),
    ).toBe(0);
    // The legacy writer is equally guarded (it raises).
    await actAs(f, 1);
    await expect(
      sq(f, "select public.record_assessment_response($1,$2,$3,$4)", [
        attemptId,
        ids[0],
        '{"optionId":"zz"}',
        randomUUID(),
      ]),
    ).rejects.toThrow(/valid structured assessment response/);
  });

  it("saves are append-only, idempotent on replay and resumable", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    const key = randomUUID();
    const first = await save(
      f,
      attemptId,
      ids[0],
      body(0, { optionId: "o1" }),
      key,
    );
    const replay = await save(
      f,
      attemptId,
      ids[0],
      body(0, { optionId: "o1" }),
      key,
    );
    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(
      await save(f, attemptId, ids[0], body(0, { optionId: "o3" }), key),
    ).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    await save(f, attemptId, ids[0], body(0, { optionId: "o2" }));
    await actAs(f, 1);
    const resumed = (
      await f.db.query<{
        question_id: string;
        saved_body: string | null;
        revision_count: number;
      }>("select * from public.get_active_assessment_exam_state($1)", [
        f.assessmentIds.QUIZ_1,
      ])
    ).rows.find((r) => r.question_id === ids[0]);
    expect(resumed).toMatchObject({
      saved_body: body(0, { optionId: "o2" }),
      revision_count: 2,
    });
  });

  it("grades deterministically end to end with no provider call, and replays without a second grade", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    const answers: unknown[] = [
      { optionId: "o2" }, // correct: 2/2
      { optionIds: ["o1", "o2"] }, // net 1-1=0: 0/4
      { matches: { i1: "t1", i2: "t3", i3: "t2" } }, // 1/3 items: floor(6/3)=2
      { order: ["s1", "s2", "s3", "s4"] }, // all in place: 4/4
      // question 5 left unanswered: 0/3
    ];
    for (const [i, answer] of answers.entries())
      expect((await save(f, attemptId, ids[i], body(i, answer))).ok).toBe(true);
    const expected = questions.map((q, i) =>
      scoreObjectiveResponse(
        q.questionType,
        q.interaction,
        q.answerKey,
        q.maxMarks,
        answers[i] ?? null,
      ),
    );
    expect(expected).toEqual([2, 0, 2, 4, 0]);

    await actAs(f, 1);
    const result = await submitControlledAssessmentAndGrade(attemptId);
    expect(result).toEqual({ attemptId, grading: "GRADED" });
    expect(mocks.provider).not.toHaveBeenCalled();

    const execution = await scalar<Record<string, unknown>>(
      f,
      "select jsonb_build_object('state',x.state,'calls',u.provider_calls,'revision',x.result_revision_id) as v from commercial_v1_examiner_executions x join commercial_v1_examiner_execution_usage u on u.execution_id=x.id where x.attempt_id=$1",
      [attemptId],
    );
    expect(execution).toMatchObject({ state: "SUCCEEDED", calls: 0 });
    const marks = (
      await f.db.query<{ question_id: string; marks_awarded: number }>(
        "select question_id,marks_awarded from commercial_v1_assessment_question_marks where result_revision_id=$1",
        [execution.revision],
      )
    ).rows;
    expect(
      ids.map((id) => marks.find((m) => m.question_id === id)?.marks_awarded),
    ).toEqual(expected);
    expect(
      await scalar(
        f,
        "select jsonb_build_object('earned',earned_marks_total,'max',max_marks_total) as v from commercial_v1_assessment_result_revisions where id=$1",
        [execution.revision],
      ),
    ).toEqual({ earned: 8, max: 19 });

    await actAs(f, 1);
    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "GRADED",
    });
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from commercial_v1_assessment_result_revisions where attempt_id=$1",
          [attemptId],
        ),
      ),
    ).toBe(1);
  });

  it("a forged objective mark is refused even when signed with the controller key", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o1" })); // wrong: 0
    await actAs(f, 1);
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    // Drive the governed chain directly with a valid MAC but a forged mark.
    const { attestExaminerExecutionCommand } =
      await import("@/server/commercial-v1-examiner-grading/authority");
    const { computeExaminerAssessmentGradeDigest } =
      await import("@/domain/commercial-v1-examiner-grading");
    const executionId = randomUUID();
    await actAs(f, 1);
    const authorized = await attestExaminerExecutionCommand(executionId, {
      operation: "AUTHORIZE",
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      budget: {
        maxProviderCalls: 1,
        maxOutputTokens: 1200,
        maxEstimatedCostMicrousd: 50000,
      },
    });
    const identity = {
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      enrolmentId: authorized.snapshot.enrolmentId,
      activationId: authorized.snapshot.activationId,
    } as const;
    await attestExaminerExecutionCommand(executionId, {
      operation: "START",
      ...identity,
    });
    const forged = [{ questionId: ids[0], marksAwarded: 2 }];
    const finalized = await attestExaminerExecutionCommand(executionId, {
      operation: "FINALIZE",
      ...identity,
      state: "SUCCEEDED",
      reason: "GRADED",
      budgetStage: null,
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
      gradeDigest: computeExaminerAssessmentGradeDigest(forged),
      assessmentMarks: forged,
      labMarksAwarded: null,
    });
    expect(finalized.snapshot).toMatchObject({
      state: "FAILED",
      reasonCode: "RESULT_INTEGRITY_FAILED",
    });
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from commercial_v1_assessment_result_revisions where attempt_id=$1",
          [attemptId],
        ),
      ),
    ).toBe(0);
  });

  it("an owner-level forged result revision that disagrees with the scorer is refused by the table guard", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o1" })); // wrong: 0
    await actAs(f, 1);
    expect(await submitControlledAssessmentAndGrade(attemptId)).toMatchObject({
      grading: "GRADED",
    });
    await f.db.exec("reset role");
    // A database-owner writer (no RPC, no attestation) attempts revision 2
    // awarding full marks to the wrongly answered objective question.
    await expect(
      sq(
        f,
        `with r as (select * from commercial_v1_assessment_result_revisions where attempt_id=$1),
         rev as (insert into commercial_v1_assessment_result_revisions(
             activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
             earned_marks_total,max_marks_total,component_weight_bp)
           select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,
             2,max_marks_total,component_weight_bp from r returning id)
         insert into commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot)
         select rev.id,$2,2,2 from rev`,
        [attemptId, ids[0]],
      ),
    ).rejects.toThrow(/OBJECTIVE_MARKS_MISMATCH/);
  });

  it("an expired attempt keeps answers saved before the deadline and refuses later saves", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o2" }));
    await f.db.exec("reset role");
    await f.db.exec(
      "alter table assessment_attempts disable trigger guard_assessment_attempt_history",
    );
    await f.db.query(
      "update assessment_attempts set expires_at=started_at+interval '1 microsecond' where id=$1",
      [attemptId],
    );
    await f.db.exec(
      "alter table assessment_attempts enable trigger guard_assessment_attempt_history",
    );
    const late = await save(
      f,
      attemptId,
      ids[1],
      body(1, { optionIds: ["o1"] }),
    );
    expect(late).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(
      await scalar(
        f,
        "select jsonb_build_object('state',state,'provenance',submission_provenance) as v from assessment_attempts where id=$1",
        [attemptId],
      ),
    ).toEqual({ state: "SUBMITTED", provenance: "AUTO_TIMEOUT" });
    expect(
      Number(
        await scalar(
          f,
          "select count(*)::text as v from assessment_responses where attempt_id=$1",
          [attemptId],
        ),
      ),
    ).toBe(1);
  });

  it("the SQL scorer agrees with the documented reference policy on randomized responses", async () => {
    // Deterministic pseudo-random generator: reproducible evidence.
    let seed = 20261016;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const variants: { type: ObjectiveQuestionType; rule: string }[] = [
      { type: "SINGLE_SELECT", rule: "ALL_OR_NOTHING" },
      { type: "MULTIPLE_SELECT", rule: "ALL_OR_NOTHING" },
      { type: "MULTIPLE_SELECT", rule: "NET_PROPORTIONAL" },
      { type: "PBQ_MATCHING", rule: "ALL_OR_NOTHING" },
      { type: "PBQ_MATCHING", rule: "PER_ITEM_PROPORTIONAL" },
      { type: "PBQ_ORDERING", rule: "ALL_OR_NOTHING" },
      { type: "PBQ_ORDERING", rule: "PER_POSITION_PROPORTIONAL" },
      { type: "PBQ_CONFIGURATION", rule: "ALL_OR_NOTHING" },
      { type: "PBQ_CONFIGURATION", rule: "PER_FIELD_PROPORTIONAL" },
    ];
    const response = (q: (typeof questions)[number]): unknown => {
      const def = q.interaction as Record<string, { id: string }[]>;
      switch (q.questionType) {
        case "SINGLE_SELECT":
          return { optionId: pick(def.options).id };
        case "MULTIPLE_SELECT": {
          const ids = def.options.map((o) => o.id).filter(() => rand() < 0.5);
          return { optionIds: (ids.length ? ids : ["o1"]).slice(0, 2) };
        }
        case "PBQ_MATCHING":
          return {
            matches: Object.fromEntries(
              def.items
                .filter(() => rand() < 0.8)
                .map((item, i) => [
                  item.id,
                  def.targets[(i + Math.floor(rand() * 3)) % 3].id,
                ]),
            ),
          };
        case "PBQ_ORDERING":
          return {
            order: [...def.steps.map((s) => s.id)].sort(() => rand() - 0.5),
          };
        case "PBQ_CONFIGURATION":
          return {
            values: Object.fromEntries(
              (
                q.interaction as {
                  fields: { id: string; options: { id: string }[] }[];
                }
              ).fields
                .filter(() => rand() < 0.8)
                .map((field) => [field.id, pick(field.options).id]),
            ),
          };
      }
    };
    await f.db.exec("reset role");
    let compared = 0;
    for (const variant of variants) {
      const base = questions.find((q) => q.questionType === variant.type)!;
      const interaction =
        variant.type === "SINGLE_SELECT"
          ? base.interaction
          : { ...(base.interaction as object), scoringRule: variant.rule };
      const q = { ...base, interaction };
      for (let n = 0; n < 40; n++) {
        const r = response(q);
        const text = JSON.stringify(r);
        const max = 1 + Math.floor(rand() * 20);
        const sql = (
          await f.db.query<{ v: number }>(
            "select assessment_interaction_private.score_response($1,$2::jsonb,$3::jsonb,$4,$5) as v",
            [
              variant.type,
              JSON.stringify(interaction),
              JSON.stringify(q.answerKey),
              max,
              text,
            ],
          )
        ).rows[0].v;
        const reference = scoreObjectiveResponse(
          variant.type,
          interaction,
          q.answerKey,
          max,
          r,
        );
        expect({ variant, text, max, sql }).toEqual({
          variant,
          text,
          max,
          sql: reference,
        });
        compared++;
      }
    }
    expect(compared).toBe(360);
  });
});

// ---------------------------------------------------------------------------
describe("mixed assessment: deterministic objective marks + governed Examiner free-text marks", () => {
  let f: SubmissionGradingFixture;
  beforeAll(async () => {
    f = await submissionGradingFixture({
      quiz1Questions: [
        ...packageQuestions(questions.slice(0, 2)),
        { ...FREE_TEXT_QUESTION, position: 3 },
      ],
    });
  }, 120000);
  afterAll(async () => {
    await f?.db.close();
  });
  withTransaction(() => f);

  it("the provider sees only the free-text question; one revision combines both without duplication", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o2" })); // 2/2
    await save(f, attemptId, ids[1], body(1, { optionIds: ["o1"] })); // 2/4
    await save(f, attemptId, ids[2], "Synthetic free-text learner answer.");
    mocks.provider.mockImplementation(async () => ({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 40,
        outputTokens: 20,
        estimatedCostMicrousd: 100,
        elapsedMs: 5,
      },
      response: {
        outputText: JSON.stringify({
          outcome: "GRADED",
          marks: [{ questionId: ids[2], marksAwarded: 3 }],
        }),
        usage: {
          inputTokens: 40,
          outputTokens: 20,
          estimatedCostMicrousd: 100,
        },
      },
    }));

    await actAs(f, 1);
    const result = await submitControlledAssessmentAndGrade(attemptId);
    expect(result).toEqual({ attemptId, grading: "GRADED" });

    expect(mocks.provider).toHaveBeenCalledTimes(1);
    const request = mocks.provider.mock.calls[0][1] as {
      context: { questions: { questionId: string }[] };
    };
    expect(request.context.questions.map((q) => q.questionId)).toEqual([
      ids[2],
    ]);
    const sent = JSON.stringify(request);
    expect(sent).not.toContain("objectiveMarks");
    expect(sent).not.toContain("Synthetic option");
    expect(sent).not.toContain("Synthetic demo question");
    expect(sent).not.toContain("Synthetic protected rationale sentinel");

    const revision = await scalar<string>(
      f,
      "select result_revision_id::text as v from commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    const marks = (
      await f.db.query<{ question_id: string; marks_awarded: number }>(
        "select question_id,marks_awarded from commercial_v1_assessment_question_marks where result_revision_id=$1",
        [revision],
      )
    ).rows;
    expect(
      ids.map((id) => marks.find((m) => m.question_id === id)?.marks_awarded),
    ).toEqual([2, 2, 3]);
    expect(
      await scalar(
        f,
        "select jsonb_build_object('earned',earned_marks_total,'max',max_marks_total,'revisions',(select count(*) from commercial_v1_assessment_result_revisions x where x.attempt_id=$2)) as v from commercial_v1_assessment_result_revisions where id=$1",
        [revision, attemptId],
      ),
    ).toEqual({ earned: 7, max: 11, revisions: 1 });
  });

  it("CP2C: answers that collided under the old 32-bit checksum are both kept; identical retries replay", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    const [a, b] = ["d27g1xbhlordy", "rae2hl0i00jow"];
    // Both saves answer revision slot 1 (e.g. a retry from a page that had
    // not yet refreshed): the server-derived keys must still differ.
    const keyFor = (body: string) =>
      answerSaveIdempotencyKey({
        attemptId,
        questionId: ids[2],
        revisionSlot: 1,
        body,
      });
    expect(keyFor(a)).not.toBe(keyFor(b));
    const first = await save(f, attemptId, ids[2], a, keyFor(a));
    const second = await save(f, attemptId, ids[2], b, keyFor(b));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.responseId).not.toBe(first.responseId);
    expect(await save(f, attemptId, ids[2], a, keyFor(a))).toEqual(first);
    expect(await save(f, attemptId, ids[2], b, keyFor(b))).toEqual(second);
    expect(
      (
        await f.db.query<{ revision_number: number; body: string }>(
          "select revision_number,body from assessment_responses where attempt_id=$1 and question_id=$2 order by revision_number",
          [attemptId, ids[2]],
        )
      ).rows,
    ).toEqual([
      { revision_number: 1, body: a },
      { revision_number: 2, body: b },
    ]);
    // The database rule is unchanged: one key can never carry two answers
    // (this is what a shared 32-bit checksum caused).
    expect(
      await save(f, attemptId, ids[2], "a third answer", keyFor(a)),
    ).toEqual({
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("a provider that tries to mark an objective question is refused as invalid output", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o1" })); // 0
    await save(f, attemptId, ids[2], "Synthetic free-text learner answer.");
    mocks.provider.mockImplementation(async () => ({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 40,
        outputTokens: 20,
        estimatedCostMicrousd: 100,
        elapsedMs: 5,
      },
      response: {
        outputText: JSON.stringify({
          outcome: "GRADED",
          marks: [
            { questionId: ids[2], marksAwarded: 3 },
            { questionId: ids[0], marksAwarded: 2 },
          ],
        }),
        usage: {
          inputTokens: 40,
          outputTokens: 20,
          estimatedCostMicrousd: 100,
        },
      },
    }));
    await actAs(f, 1);
    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "GRADING_UNAVAILABLE",
    });
    expect(
      await scalar(
        f,
        "select jsonb_build_object('state',state,'reason',reason_code) as v from commercial_v1_examiner_executions where attempt_id=$1",
        [attemptId],
      ),
    ).toEqual({ state: "FAILED", reason: "OUTPUT_INVALID" });
  });
});

// ---------------------------------------------------------------------------
describe("human academic review of an escalated objective attempt", () => {
  let f: SubmissionGradingFixture;
  beforeAll(async () => {
    f = await submissionGradingFixture({
      quiz1Questions: [
        ...packageQuestions(questions.slice(0, 2)),
        { ...FREE_TEXT_QUESTION, position: 3 },
      ],
      escalateToAcademicReview: true,
    });
  }, 120000);
  afterAll(async () => {
    await f?.db.close();
  });
  withTransaction(() => f);

  it("shows locked deterministic marks to the reviewer and refuses any other objective mark", async () => {
    const attemptId = await startAttempt(f);
    const ids = await questionIds(f);
    await save(f, attemptId, ids[0], body(0, { optionId: "o2" })); // 2
    await save(f, attemptId, ids[1], body(1, { optionIds: ["o3"] })); // 2
    await save(f, attemptId, ids[2], "Synthetic free-text learner answer.");
    await actAs(f, 1);
    expect(await submitControlledAssessmentAndGrade(attemptId)).toEqual({
      attemptId,
      grading: "ESCALATED",
    });
    await asPolicyUser(f.db, 2);
    const list = (
      await f.db.query<{ v: { cases: { caseId: string }[] } }>(
        "select public.list_commercial_v1_academic_review_cases() as v",
      )
    ).rows[0].v;
    expect(list.cases).toHaveLength(1);
    const reviewCase = (
      await f.db.query<{
        v: {
          assessment: {
            questions: {
              questionId: string;
              objective: {
                questionType: string;
                deterministicMarks: number;
              } | null;
            }[];
          };
        };
      }>("select public.get_commercial_v1_academic_review_case($1) as v", [
        list.cases[0].caseId,
      ])
    ).rows[0].v;
    expect(
      reviewCase.assessment.questions.map(
        (q) => q.objective?.deterministicMarks ?? null,
      ),
    ).toEqual([2, 2, null]);
    const grade = (marks: number[]) =>
      sq(
        f,
        "select public.submit_commercial_v1_academic_review_assessment_grade($1,$2::jsonb,$3) as v",
        [
          list.cases[0].caseId,
          JSON.stringify(
            ids.map((questionId, i) => ({
              questionId,
              marksAwarded: marks[i],
            })),
          ),
          "Synthetic escalated attempt reviewed",
        ],
      );
    await expect(grade([0, 2, 4])).rejects.toThrow(/OBJECTIVE_MARKS_MISMATCH/);
    await asPolicyUser(f.db, 2);
    await expect(grade([2, 2, 4])).resolves.toBeDefined();
    expect(
      await scalar(
        f,
        "select jsonb_build_object('earned',earned_marks_total,'max',max_marks_total) as v from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [attemptId],
      ),
    ).toEqual({ earned: 8, max: 11 });
  });
});

// ---------------------------------------------------------------------------
describe("package validation, preview redaction and governed authoring in the database", () => {
  let f: SubmissionGradingFixture;
  beforeAll(async () => {
    f = await submissionGradingFixture({ quiz1Questions: packageQuestions() });
  }, 120000);
  afterAll(async () => {
    await f?.db.close();
  });
  withTransaction(() => f);

  async function importRaw(pkg: unknown) {
    await asPolicyUser(f.db, 2);
    const id = (
      await f.db.query<{ v: string }>(
        "select public.import_course_package($1,1,'COURSE_PACKAGE_V1',$2::jsonb,'Synthetic import') as v",
        [(pkg as { packageKey: string }).packageKey, JSON.stringify(pkg)],
      )
    ).rows[0].v;
    return id;
  }
  async function stagedPackage() {
    await f.db.exec("reset role");
    const raw = (
      await f.db.query<{ v: Record<string, unknown> }>(
        "select raw_package as v from course_package_imports where id=$1",
        [f.importId],
      )
    ).rows[0].v;
    return { ...raw, packageKey: `cp2-synthetic-${randomUUID()}` } as {
      packageKey: string;
      assessmentTemplates: { questions: Record<string, unknown>[] }[];
    };
  }

  it("the database validator rejects an inconsistent key even when the TypeScript validator is bypassed", async () => {
    const tampered = await stagedPackage();
    tampered.assessmentTemplates[0].questions[0].answerKey = {
      correctOptionId: "nope",
    };
    const id = await importRaw(tampered);
    await expect(
      sq(
        f,
        "select public.mark_course_package_validated($1,'{}'::jsonb,'Synthetic validation')",
        [id],
      ),
    ).rejects.toThrow(/An objective question answer key is invalid/);
    const freeTextWithKey = await stagedPackage();
    const q = freeTextWithKey.assessmentTemplates[0].questions[0];
    delete q.questionType;
    await asPolicyUser(f.db, 2);
    const id2 = await importRaw(freeTextWithKey);
    await expect(
      sq(
        f,
        "select public.mark_course_package_validated($1,'{}'::jsonb,'Synthetic validation')",
        [id2],
      ),
    ).rejects.toThrow(/not permitted on a free-text question/);
  });

  it("the staging preview never carries an answer key or rationale", async () => {
    await asPolicyUser(f.db, 2);
    const preview = (
      await f.db.query<{ v: unknown }>(
        "select to_jsonb(p) as v from public.get_course_package_preview($1) p",
        [f.importId],
      )
    ).rows[0].v;
    const text = JSON.stringify(preview);
    for (const secret of PROTECTED_KEY_FIELDS)
      expect(text).not.toContain(secret);
    expect(text).toContain("Synthetic option 1"); // learner-visible content remains
  });

  it("governed authoring: admin can add to a draft only; learners cannot; errors never echo content", async () => {
    await asPolicyUser(f.db, 2);
    const cohort = await scalar<string>(
      f,
      "select cohort_id::text as v from assessments where id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    const lesson = await scalar<string>(
      f,
      "select lesson_id::text as v from assessments where id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    await asPolicyUser(f.db, 2);
    const draft = (
      await f.db.query<{ v: string }>(
        "select public.create_assessment($1,$2,$3,'Synthetic draft','Synthetic instructions',now(),now()+interval '1 day',30,1,'Synthetic draft for CP2') as v",
        [cohort, lesson, "10000000-0000-4000-8000-000000000002"],
      )
    ).rows[0].v;
    const [single] = questions;
    const add = (assessment: string, key: unknown) =>
      sq(
        f,
        "select public.add_objective_assessment_question($1,1,'Synthetic prompt',2,'SINGLE_SELECT',$2::jsonb,$3::jsonb,'Synthetic rationale',null,'Synthetic authoring') as v",
        [assessment, JSON.stringify(single.interaction), JSON.stringify(key)],
      );
    await expect(add(draft, { correctOptionId: "secret-zz" })).rejects.toThrow(
      /^Objective question answer key is invalid$/,
    );
    await asPolicyUser(f.db, 2);
    await expect(add(draft, single.answerKey)).resolves.toBeDefined();
    await asPolicyUser(f.db, 2);
    await expect(
      add(f.assessmentIds.QUIZ_1, single.answerKey),
    ).rejects.toThrow();
    await asPolicyUser(f.db, 1);
    await expect(add(draft, single.answerKey)).rejects.toThrow(/Access denied/);
  });
});
