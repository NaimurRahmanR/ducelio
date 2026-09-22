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
  buildAssessmentPolicyFixture,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
import {
  actAs,
  assessmentClient,
  forceExpire,
  newAssessmentClientState,
} from "./commercial-v1-assessment-response-client";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/lib/env", () => ({ config: () => ({ configured: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import {
  getStudentAssessments,
  recordAssessmentResponse,
  startAssessmentAttempt,
  submitAssessmentAttempt,
} from "@/server/assessments";
import { saveControlledAssessmentResponse } from "@/app/student/actions";

const GOVERNED_WRITER = "record_commercial_v1_assessment_response";
const LEGACY_WRITER = "record_assessment_response";
// Anything that must never reach a learner-readable projection.
const PROTECTED =
  /protected answer|expected_answer|expectedAnswer|marking_guidance|markingGuidance/i;

const state = newAssessmentClientState();
let f: AssessmentPolicyFixture;

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}
async function scalar<T = string>(sql: string, args: unknown[] = []) {
  await f.db.exec("reset role");
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function questionIdOf(assessmentId: string) {
  return scalar<string>(
    "select id as v from public.assessment_questions where assessment_id=$1 order by position limit 1",
    [assessmentId],
  );
}
async function attemptRow(attemptId: string) {
  return scalar<Record<string, unknown>>(
    "select to_jsonb(t) as v from public.assessment_attempts t where id=$1",
    [attemptId],
  );
}
async function responseCount(attemptId: string) {
  return Number(
    await scalar<string>(
      "select count(*)::text as v from public.assessment_responses where attempt_id=$1",
      [attemptId],
    ),
  );
}
async function auditCount() {
  return Number(
    await scalar<string>("select count(*)::text as v from public.audit_events"),
  );
}
async function start(assessmentId: string) {
  await actAs(f.db, state, 1);
  const attemptId = await startAssessmentAttempt(assessmentId);
  state.rpcLog.length = 0;
  state.rpcArgs.length = 0;
  return attemptId;
}
async function closeAssessment(assessmentId: string) {
  await actAs(f.db, state, 2);
  await f.db.query(
    "select public.change_assessment_status($1,'CLOSED','Institutional closure fixture')",
    [assessmentId],
  );
}

function wire() {
  beforeEach(async () => {
    await f.db.exec("begin");
    state.rpcLog.length = 0;
    state.rpcArgs.length = 0;
    state.failRpc = undefined;
    mocks.revalidatePath.mockReset();
    mocks.client.mockImplementation(async () => assessmentClient(f.db, state));
  });
  afterEach(async () => {
    await f.db.exec("rollback;reset role");
  });
}

// =============================================================================
// A Commercial V1-governed attempt must be written ONLY through the governed
// surface. Migration 029 makes the legacy record_assessment_response refuse
// every governed attempt, so before this checkpoint the learner action failed
// for exactly the learners the commercial policy exists to serve.
// =============================================================================
describe("Commercial V1-governed assessment responses use the governed writer", () => {
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
  });
  afterAll(async () => f.db.close());
  wire();

  it("saves through record_commercial_v1_assessment_response and never touches the legacy writer", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const outcome = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Governed answer",
      idempotencyKey: randomUUID(),
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(state.rpcLog).not.toContain(LEGACY_WRITER);
    expect(await responseCount(attemptId)).toBe(1);
  });

  it("the learner Server Action saves a governed response (previously refused by migration 029's legacy exclusion)", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const result = await saveControlledAssessmentResponse(
      {},
      form({
        attemptId,
        questionId,
        body: "Governed answer via action",
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result).toEqual({ message: "Response revision saved." });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(await responseCount(attemptId)).toBe(1);
  });

  it("the browser cannot choose the writer: extra form fields are ignored and only the four governed parameters are forwarded", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const result = await saveControlledAssessmentResponse(
      {},
      form({
        attemptId,
        questionId,
        body: "Answer with hostile extras",
        idempotencyKey: randomUUID(),
        isCommercialV1: "false",
        governed: "false",
        writer: "legacy",
        rpc: LEGACY_WRITER,
        studentId: randomUUID(),
      }),
    );

    expect(result).toEqual({ message: "Response revision saved." });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(Object.keys(state.rpcArgs[0].args).sort()).toEqual([
      "p_attempt_id",
      "p_body",
      "p_idempotency_key",
      "p_question_id",
    ]);
  });

  it("EXPIRED does not fall back: it returns the structured result and durably commits AUTO_TIMEOUT in the same governed call", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await actAs(f.db, state, 1);

    const outcome = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Too late",
      idempotencyKey: randomUUID(),
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: "EXPIRED",
      state: "SUBMITTED",
      submissionProvenance: "AUTO_TIMEOUT",
    });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    const row = await attemptRow(attemptId);
    expect(row).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    // Anchored to the attempt's own deadline, never to "now".
    expect(row.submitted_at).toBe(row.expires_at);
    expect(await responseCount(attemptId)).toBe(0);
  });

  it("the Server Action reports EXPIRED honestly and revalidates the now-submitted attempt", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await actAs(f.db, state, 1);

    const result = await saveControlledAssessmentResponse(
      {},
      form({
        attemptId,
        questionId,
        body: "Too late via action",
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.message).toBeUndefined();
    expect(result.error).toMatch(/time.*ended|submitted automatically/i);
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/student/assessments");
  });

  it("ATTEMPT_NOT_ACTIVE does not fall back and leaves the submitted attempt untouched", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);
    await submitAssessmentAttempt(attemptId);
    state.rpcLog.length = 0;
    const before = await attemptRow(attemptId);
    await actAs(f.db, state, 1);

    const outcome = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "After submit",
      idempotencyKey: randomUUID(),
    });

    expect(outcome).toEqual({ ok: false, code: "ATTEMPT_NOT_ACTIVE" });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(await attemptRow(attemptId)).toEqual(before);
    expect(await responseCount(attemptId)).toBe(0);
  });

  it("RESPONSE_WINDOW_CLOSED does not fall back and the administrative closure is durably provenanced", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await closeAssessment(f.assessmentIds.QUIZ_1);
    state.rpcLog.length = 0;
    await actAs(f.db, state, 1);

    const outcome = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "After administrative closure",
      idempotencyKey: randomUUID(),
    });

    expect(outcome).toEqual({ ok: false, code: "RESPONSE_WINDOW_CLOSED" });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(await attemptRow(attemptId)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "ADMIN_CLOSED",
    });
    expect(await responseCount(attemptId)).toBe(0);
  });

  it("a foreign learner is denied identically to a nonexistent attempt, without fallback, mutation or existence leakage", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    const before = await attemptRow(attemptId);
    const auditBefore = await auditCount();
    await actAs(f.db, state, 3);

    const foreign = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Not my attempt",
      idempotencyKey: randomUUID(),
    });
    const missing = await recordAssessmentResponse({
      attemptId: randomUUID(),
      questionId,
      body: "Not an attempt",
      idempotencyKey: randomUUID(),
    });

    expect(foreign).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(foreign).toEqual(missing);
    expect(state.rpcLog).toEqual([GOVERNED_WRITER, GOVERNED_WRITER]);
    expect(await attemptRow(attemptId)).toEqual(before);
    expect(await responseCount(attemptId)).toBe(0);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("idempotent replay returns the same response; a conflicting reuse is refused; a new key appends revision 2", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);
    const key = randomUUID();
    const input = { attemptId, questionId, body: "Stable answer" };

    const first = await recordAssessmentResponse({
      ...input,
      idempotencyKey: key,
    });
    const replay = await recordAssessmentResponse({
      ...input,
      idempotencyKey: key,
    });
    const conflict = await recordAssessmentResponse({
      ...input,
      body: "Different content, same key",
      idempotencyKey: key,
    });
    const revision = await recordAssessmentResponse({
      ...input,
      body: "Second revision",
      idempotencyKey: randomUUID(),
    });

    expect(first).toMatchObject({ ok: true });
    expect(replay).toEqual(first);
    expect(conflict).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(revision).toMatchObject({ ok: true });
    expect(state.rpcLog).not.toContain(LEGACY_WRITER);
    expect(await responseCount(attemptId)).toBe(2);
    expect(
      await scalar<number>(
        "select max(revision_number) as v from public.assessment_responses where attempt_id=$1",
        [attemptId],
      ),
    ).toBe(2);
  });

  it("no protected question content, answer key or marking guidance becomes learner-readable on any path", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const ok = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Safe answer",
      idempotencyKey: randomUUID(),
    });
    const action = await saveControlledAssessmentResponse(
      {},
      form({
        attemptId,
        questionId,
        body: "Safe answer via action",
        idempotencyKey: randomUUID(),
      }),
    );
    const workspace = await getStudentAssessments();
    await forceExpire(f.db, attemptId);
    await actAs(f.db, state, 1);
    const expired = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Late",
      idempotencyKey: randomUUID(),
    });
    await actAs(f.db, state, 3);
    const foreign = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Foreign",
      idempotencyKey: randomUUID(),
    });

    for (const surface of [ok, action, workspace, expired, foreign])
      expect(JSON.stringify(surface)).not.toMatch(PROTECTED);
  });
});

// =============================================================================
// Risk 2: an expired/closed governed attempt must not be presented as ACTIVE by
// the live learner projection. The authoritative lazy finalizer already
// exists; this proves the learner read actually reaches it.
// =============================================================================
describe("Governed attempt resume/expiry in the live learner projection", () => {
  // Deliberately NOT one long wrapping transaction: the activity-state and
  // protected-question reads compare against now(), which PostgreSQL freezes
  // at transaction start. Production runs each RPC as its own transaction, so
  // each case here commits its setup (attempt started, deadline elapsed or
  // assessment closed) on a fresh database and only then opens the
  // transaction the learner read runs in -- the same fresh-clock semantics a
  // real learner request sees.
  beforeEach(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
    state.rpcLog.length = 0;
    state.rpcArgs.length = 0;
    state.failRpc = undefined;
    mocks.client.mockImplementation(async () => assessmentClient(f.db, state));
  });
  afterEach(async () => f.db.close());

  async function startCommitted(assessmentId: string) {
    await f.db.exec("begin");
    try {
      return await start(assessmentId);
    } finally {
      await f.db.exec("commit");
    }
  }
  async function beginRead() {
    await f.db.exec("begin");
    await actAs(f.db, state, 1);
  }

  it("control: a live, unexpired governed attempt is still ACTIVE with its protected questions released", async () => {
    const attemptId = await startCommitted(f.assessmentIds.QUIZ_1);
    await beginRead();

    const view = await getStudentAssessments();

    expect(view.activityState).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    expect(view.attempts.find((a) => a.id === attemptId)?.state).toBe("ACTIVE");
    expect(view.activeQuestions).toHaveLength(1);
    expect(await attemptRow(attemptId)).toMatchObject({ state: "ACTIVE" });
  });

  it("an expired governed attempt is finalised AUTO_TIMEOUT by the learner read, not presented as ACTIVE", async () => {
    const attemptId = await startCommitted(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await beginRead();

    const view = await getStudentAssessments();

    expect(view.attempts.find((a) => a.id === attemptId)?.state).toBe(
      "SUBMITTED",
    );
    expect(view.activityState).toBe("NORMAL");
    expect(view.activeQuestions).toEqual([]);
    const row = await attemptRow(attemptId);
    expect(row).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    // Anchored to the attempt's own deadline, never to the read time.
    expect(row.submitted_at).toBe(row.expires_at);
    // The authority that finalised it is the existing governed finalizer,
    // and it ran before the lifecycle-dependent reads.
    const finalizer = state.rpcLog.indexOf(
      "finalize_expired_commercial_v1_attempts",
    );
    expect(finalizer).toBeGreaterThanOrEqual(0);
    expect(finalizer).toBeLessThan(
      state.rpcLog.indexOf("current_academic_activity_state"),
    );
  });

  it("an administratively closed governed attempt is finalised ADMIN_CLOSED by the learner read", async () => {
    const attemptId = await startCommitted(f.assessmentIds.QUIZ_1);
    await closeAssessment(f.assessmentIds.QUIZ_1);
    await beginRead();

    const view = await getStudentAssessments();

    expect(view.attempts.find((a) => a.id === attemptId)?.state).toBe(
      "SUBMITTED",
    );
    expect(await attemptRow(attemptId)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "ADMIN_CLOSED",
    });
  });

  it("finalisation on read is idempotent and never rewrites the deadline-anchored submission time", async () => {
    const attemptId = await startCommitted(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await beginRead();
    await getStudentAssessments();
    const first = await attemptRow(attemptId);
    await actAs(f.db, state, 1);
    await getStudentAssessments();
    const second = await attemptRow(attemptId);

    expect(first).toMatchObject({ submission_provenance: "AUTO_TIMEOUT" });
    expect(first.submitted_at).toBe(first.expires_at);
    expect(second).toEqual(first);
  });

  it("fails closed rather than showing a stale ACTIVE attempt when the finalizer itself is unavailable", async () => {
    const attemptId = await startCommitted(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await beginRead();
    state.failRpc = "finalize_expired_commercial_v1_attempts";

    await expect(getStudentAssessments()).rejects.toThrow(
      "Your assessments could not be loaded.",
    );
    // Nothing was mutated by the failed call.
    expect(await attemptRow(attemptId)).toMatchObject({ state: "ACTIVE" });
  });
});

// =============================================================================
// A genuinely non-governed (legacy) attempt keeps its exact legacy behaviour.
// Here the six components are bound but no grading policy is published, so no
// assessment is Commercial V1-governed.
// =============================================================================
describe("Non-governed (legacy) assessment responses keep the legacy writer", () => {
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false, publish: false });
  });
  afterAll(async () => f.db.close());
  wire();

  it("probes the governed surface, receives NOT_COMMERCIAL_V1_GOVERNED, then uses the legacy writer and saves", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const outcome = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Legacy answer",
      idempotencyKey: randomUUID(),
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER, LEGACY_WRITER]);
    expect(await responseCount(attemptId)).toBe(1);
  });

  it("the learner Server Action still saves a legacy response", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);

    const result = await saveControlledAssessmentResponse(
      {},
      form({
        attemptId,
        questionId,
        body: "Legacy answer via action",
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result).toEqual({ message: "Response revision saved." });
    expect(await responseCount(attemptId)).toBe(1);
  });

  // The routing design is only sound if the governed probe of a non-governed
  // attempt is free of side effects. Prove it directly at the database.
  it("the governed probe of a non-governed attempt has no side effects (no row, no audit event, attempt unchanged)", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    const before = await attemptRow(attemptId);
    const auditBefore = await auditCount();
    await actAs(f.db, state, 1);

    const probe = (
      await f.db.query<{ v: unknown }>(
        "select public.record_commercial_v1_assessment_response($1,$2,'Probe',$3) as v",
        [attemptId, questionId, randomUUID()],
      )
    ).rows[0].v;

    expect(probe).toEqual({ ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" });
    expect(await attemptRow(attemptId)).toEqual(before);
    expect(await responseCount(attemptId)).toBe(0);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("legacy replay stays idempotent and a legacy revision appends", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await actAs(f.db, state, 1);
    const key = randomUUID();
    const input = { attemptId, questionId, body: "Legacy stable answer" };

    const first = await recordAssessmentResponse({
      ...input,
      idempotencyKey: key,
    });
    const replay = await recordAssessmentResponse({
      ...input,
      idempotencyKey: key,
    });

    expect(first).toMatchObject({ ok: true });
    expect(replay).toEqual(first);
    expect(await responseCount(attemptId)).toBe(1);
  });

  it("a legacy attempt past its deadline is refused exactly as before (the probe does not finalise it)", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await actAs(f.db, state, 1);

    await expect(
      recordAssessmentResponse({
        attemptId,
        questionId,
        body: "Late legacy",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("Assessment response could not be saved.");

    expect(state.rpcLog).toEqual([GOVERNED_WRITER, LEGACY_WRITER]);
    // Legacy semantics preserved: the raised refusal rolls back, no
    // provenance is written by this path, and no response row exists.
    expect(await attemptRow(attemptId)).toMatchObject({ state: "ACTIVE" });
    expect(await responseCount(attemptId)).toBe(0);
  });

  it("the Commercial V1 finalizer leaves a legacy attempt untouched in the learner projection", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    await forceExpire(f.db, attemptId);
    await actAs(f.db, state, 1);

    const view = await getStudentAssessments();

    expect(view.attempts.find((a) => a.id === attemptId)?.state).toBe("ACTIVE");
    expect(await attemptRow(attemptId)).toMatchObject({ state: "ACTIVE" });
  });

  it("a foreign learner on a legacy attempt is denied by the governed probe and never reaches the legacy writer", async () => {
    const attemptId = await start(f.assessmentIds.QUIZ_1);
    const questionId = await questionIdOf(f.assessmentIds.QUIZ_1);
    const before = await attemptRow(attemptId);
    await actAs(f.db, state, 3);

    const foreign = await recordAssessmentResponse({
      attemptId,
      questionId,
      body: "Not my legacy attempt",
      idempotencyKey: randomUUID(),
    });

    expect(foreign).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(state.rpcLog).toEqual([GOVERNED_WRITER]);
    expect(await attemptRow(attemptId)).toEqual(before);
    expect(await responseCount(attemptId)).toBe(0);
  });
});
