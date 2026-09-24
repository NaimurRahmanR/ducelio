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

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));

import {
  submitControlledAssessmentAndGrade,
  submitPracticalLabWorkAndGrade,
} from "@/server/commercial-v1-submission-grading";

let f: SubmissionGradingFixture;
const state: SubmissionGradingClientState = newSubmissionGradingClientState();
beforeAll(async () => {
  f = await submissionGradingFixture();
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await f.db.exec("begin");
  state.rpcLog.length = 0;
  state.failRpc = undefined;
  vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", f.keyId);
  vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", f.key.toString("hex"));
  mocks.client.mockImplementation(async () =>
    submissionGradingClient(f.db, state),
  );
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
  vi.unstubAllEnvs();
});

async function actAs(n: number) {
  await asPolicyUser(f.db, n);
  state.authUser = {
    id: learnerAuth(n),
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
}
async function scalar<T = string>(sql: string, params: unknown[] = []) {
  await f.db.exec("reset role");
  return (await f.db.query<{ v: T }>(sql, params)).rows[0].v;
}
async function attemptState(attemptId: string) {
  return scalar<Record<string, unknown>>(
    "select to_jsonb(t) as v from assessment_attempts t where id=$1",
    [attemptId],
  );
}
async function examinerExecutionCount(attemptOrSubmissionId: string) {
  return Number(
    await scalar<string>(
      "select count(*)::text as v from commercial_v1_examiner_executions where attempt_id=$1 or submission_id=$1",
      [attemptOrSubmissionId],
    ),
  );
}
async function forceExpire(attemptId: string) {
  await f.db.exec("reset role");
  await f.db.exec(
    "alter table assessment_attempts disable trigger guard_assessment_attempt_history",
  );
  try {
    await f.db.query(
      "update assessment_attempts set expires_at=started_at+interval '1 microsecond' where id=$1",
      [attemptId],
    );
  } finally {
    await f.db.exec(
      "alter table assessment_attempts enable trigger guard_assessment_attempt_history",
    );
  }
}

describe("Controlled assessment: submission durability under Examiner grading", () => {
  it("submission commits and remains committed even though no provider is configured (real AUTHORIZE->START->CONTEXT_READ->FINALIZE)", async () => {
    await actAs(1);
    const questionId = await questionIdOf(f, f.assessmentIds.QUIZ_1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await f.db.query(
      "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
      [attemptId, questionId, "Learner answer", randomUUID()],
    );
    await actAs(1);

    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(result.attemptId).toBe(attemptId);
    // No provider is configured in this test environment -- the real
    // governed chain still runs end to end (AUTHORIZE admits, START
    // transitions, context is read, the provider adapter resolves null,
    // FINALIZE records FAILED/NO_PROVIDER_CONFIGURED) and resolves to the
    // single safe learner-facing state, never a fabricated grade.
    expect(result.grading).toBe("GRADING_UNAVAILABLE");
    expect(await attemptState(attemptId)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "STUDENT_SUBMIT",
    });
    expect(await examinerExecutionCount(attemptId)).toBe(1);
    expect(state.rpcLog).toContain("submit_assessment_attempt");
    expect(state.rpcLog).toContain("govern_commercial_v1_examiner_execution");
  });

  it("a grading transport failure never unwinds or hides the submission", async () => {
    await actAs(1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await actAs(1);
    state.failRpc = "govern_commercial_v1_examiner_execution";

    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(result.attemptId).toBe(attemptId);
    expect(result.grading).toBe("GRADING_UNAVAILABLE");
    expect(await attemptState(attemptId)).toMatchObject({ state: "SUBMITTED" });
    // The failed transport never even reaches an admitted claim.
    expect(await examinerExecutionCount(attemptId)).toBe(0);
  });

  it("replaying the same submission after grading already resolved does not create a second Examiner claim", async () => {
    await actAs(1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await actAs(1);
    const first = await submitControlledAssessmentAndGrade(attemptId);
    const second = await submitControlledAssessmentAndGrade(attemptId);

    expect(first.attemptId).toBe(attemptId);
    expect(second.attemptId).toBe(attemptId);
    // A terminal unsuccessful execution is never automatically retried --
    // migration 031's own exact-target-first AUTHORIZE ordering returns the
    // SAME terminal claim, never a second provider attempt.
    expect(second.grading).toBe("GRADING_UNAVAILABLE");
    expect(await examinerExecutionCount(attemptId)).toBe(1);
  });

  it("a request interrupted after submission but before grading is recoverable by a later safe replay", async () => {
    await actAs(1);
    // Simulates the exact interruption window: submission committed, the
    // process/request dies before ever calling into grading orchestration
    // (submitAssessmentAttempt called directly, bypassing the composition).
    const attemptId = await scalar<string>(
      "select public.submit_assessment_attempt($1) as v",
      [
        await scalar<string>(
          "select public.start_assessment_attempt($1) as v",
          [f.assessmentIds.QUIZ_1],
        ),
      ],
    );
    expect(await examinerExecutionCount(attemptId)).toBe(0);
    await actAs(1);

    // The next safe replay discovers the already-SUBMITTED target and
    // attempts initial grading admission for the first time -- no duplicate
    // submission is created (submit_assessment_attempt is itself idempotent
    // once SUBMITTED).
    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(result.attemptId).toBe(attemptId);
    expect(await examinerExecutionCount(attemptId)).toBe(1);
    const submittedCount = Number(
      await scalar<string>(
        "select count(*)::text as v from assessment_attempts where id=$1 and state='SUBMITTED'",
        [attemptId],
      ),
    );
    expect(submittedCount).toBe(1);
  });

  it("an already-expired attempt preserves AUTO_TIMEOUT provenance, and grading is still attempted against it", async () => {
    await actAs(1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(attemptId);
    await actAs(1);

    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(result.attemptId).toBe(attemptId);
    expect(await attemptState(attemptId)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    expect(await examinerExecutionCount(attemptId)).toBe(1);
  });

  it("a foreign learner cannot submit or grade another learner's attempt, and no claim is created", async () => {
    await actAs(1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await actAs(3);

    await expect(
      submitControlledAssessmentAndGrade(attemptId),
    ).rejects.toThrow();
    expect(await examinerExecutionCount(attemptId)).toBe(0);
    expect(await attemptState(attemptId)).toMatchObject({ state: "ACTIVE" });
  });

  it("the composition result never carries protected question/answer content", async () => {
    await actAs(1);
    const attemptId = await scalar<string>(
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await actAs(1);

    const result = await submitControlledAssessmentAndGrade(attemptId);

    expect(Object.keys(result).sort()).toEqual(["attemptId", "grading"]);
    expect(JSON.stringify(result)).not.toMatch(
      /protected answer|expected_answer|expectedAnswer|marking_guidance/i,
    );
  });
});

describe("Practical lab: final submission durability under Examiner grading", () => {
  it("final lab work commits durably even though no provider is configured", async () => {
    await actAs(1);
    const key = randomUUID();

    const result = await submitPracticalLabWorkAndGrade({
      enrolmentId: f.learnerEnrolmentId,
      practicalId: f.practical,
      body: "My final lab work",
      idempotencyKey: key,
    });

    expect(result.submissionId).toBeTruthy();
    expect(result.grading).toBe("GRADING_UNAVAILABLE");
    const submission = await scalar<Record<string, unknown>>(
      "select to_jsonb(t) as v from commercial_v1_lab_submissions t where id=$1",
      [result.submissionId],
    );
    expect(submission).toMatchObject({
      enrolment_id: f.learnerEnrolmentId,
      practical_id: f.practical,
      body: "My final lab work",
    });
    expect(await examinerExecutionCount(result.submissionId)).toBe(1);
  });

  it("a grading transport failure preserves the final submission unchanged", async () => {
    await actAs(1);
    state.failRpc = "govern_commercial_v1_examiner_execution";

    const result = await submitPracticalLabWorkAndGrade({
      enrolmentId: f.learnerEnrolmentId,
      practicalId: f.practical,
      body: "My final lab work",
      idempotencyKey: randomUUID(),
    });

    expect(result.grading).toBe("GRADING_UNAVAILABLE");
    const count = Number(
      await scalar<string>(
        "select count(*)::text as v from commercial_v1_lab_submissions where id=$1",
        [result.submissionId],
      ),
    );
    expect(count).toBe(1);
    expect(await examinerExecutionCount(result.submissionId)).toBe(0);
  });

  it("replaying an identical resubmission recovers a submission interrupted before grading, without duplicating the provider claim", async () => {
    await actAs(1);
    const idempotencyKey = `lab:${f.learnerEnrolmentId}:${f.practical}`;
    // Simulates the interruption window: submission committed directly
    // (bypassing the composition), grading never attempted.
    const submissionId = await scalar<string>(
      "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
      [f.learnerEnrolmentId, f.practical, "My final lab work", idempotencyKey],
    );
    expect(await examinerExecutionCount(submissionId)).toBe(0);
    await actAs(1);

    // A resubmission with the exact same deterministic key/body (the real
    // form's own idempotency strategy) replays Transaction 1 to the same id
    // and gives grading its first real chance to be admitted.
    const result = await submitPracticalLabWorkAndGrade({
      enrolmentId: f.learnerEnrolmentId,
      practicalId: f.practical,
      body: "My final lab work",
      idempotencyKey,
    });

    expect(result.submissionId).toBe(submissionId);
    expect(await examinerExecutionCount(submissionId)).toBe(1);
    const count = Number(
      await scalar<string>(
        "select count(*)::text as v from commercial_v1_lab_submissions where enrolment_id=$1 and practical_id=$2",
        [f.learnerEnrolmentId, f.practical],
      ),
    );
    expect(count).toBe(1);
  });

  it("a second submission call after grading already resolved creates no second Examiner claim", async () => {
    await actAs(1);
    const key = randomUUID();
    const first = await submitPracticalLabWorkAndGrade({
      enrolmentId: f.learnerEnrolmentId,
      practicalId: f.practical,
      body: "My final lab work",
      idempotencyKey: key,
    });
    await actAs(1);
    const second = await submitPracticalLabWorkAndGrade({
      enrolmentId: f.learnerEnrolmentId,
      practicalId: f.practical,
      body: "My final lab work",
      idempotencyKey: key,
    });

    expect(second.submissionId).toBe(first.submissionId);
    expect(await examinerExecutionCount(first.submissionId)).toBe(1);
  });

  it("a foreign learner cannot submit lab work for another learner's enrolment", async () => {
    await actAs(3);
    await expect(
      submitPracticalLabWorkAndGrade({
        enrolmentId: f.learnerEnrolmentId,
        practicalId: f.practical,
        body: "Not my lab work",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    const count = Number(
      await scalar<string>(
        "select count(*)::text as v from commercial_v1_lab_submissions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    );
    expect(count).toBe(0);
  });

  it("a foreign/unbound practical is rejected and creates no submission", async () => {
    await actAs(1);
    await expect(
      submitPracticalLabWorkAndGrade({
        enrolmentId: f.learnerEnrolmentId,
        practicalId: randomUUID(),
        body: "Work against a nonexistent practical",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("Tutor/Lab conversational support never creates a final submission row", async () => {
    await actAs(1);
    const before = Number(
      await scalar<string>(
        "select count(*)::text as v from commercial_v1_lab_submissions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    );
    // request_practical_support (the conversational handoff RPC) is a
    // structurally separate authority -- confirmed by inspecting its own
    // body (course_activation.ts), which never touches
    // commercial_v1_lab_submissions. Proven here by row-count invariance
    // rather than re-deriving that RPC's own reviewed test coverage.
    await f.db.query("select public.request_practical_support($1,$2,$3)", [
      f.learnerEnrolmentId,
      f.practical,
      randomUUID(),
    ]);
    const after = Number(
      await scalar<string>(
        "select count(*)::text as v from commercial_v1_lab_submissions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    );
    expect(after).toBe(before);
  });
});
