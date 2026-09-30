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
  asPolicyUser,
  buildAssessmentPolicyFixture,
  foreignLearner,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
import {
  actAs,
  assessmentClient,
  forceExpire,
  newAssessmentClientState,
  UPSTREAM_ERROR_SENTINEL,
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
  STUDENT_ASSESSMENT_READ_STAGES,
  StudentAssessmentReadFailure,
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

// =============================================================================
// Hosted journey run 1790635594309-jz55ep: hosted PostgREST refused
// getStudentAssessments' former select with HTTP 400 PGRST200 ("Could not
// find a relationship between 'assessments' and 'programme_versions'"),
// because assessments has no foreign key to programme_versions. This
// adapter (like every local test double) never resolved embeds the way
// PostgREST does, which is why no local test caught it. These tests check the
// requested selects against the REAL migrated FK graph instead.
// =============================================================================
describe("getStudentAssessments: PostgREST-resolvable reads and fail-closed protected questions", () => {
  beforeEach(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
    state.rpcLog.length = 0;
    state.rpcArgs.length = 0;
    state.selects.length = 0;
    state.failRpc = undefined;
    state.failTableRead = undefined;
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
  // PostgREST embeds a relation only through a foreign key between the two
  // tables (this schema defines no views or computed relationships for
  // them), in either direction.
  async function foreignKeyCount(from: string, to: string) {
    return scalar<number>(
      `select count(*)::int as v from pg_constraint
        where contype='f'
          and ((conrelid=to_regclass('public.'||$1) and confrelid=to_regclass('public.'||$2))
            or (conrelid=to_regclass('public.'||$2) and confrelid=to_regclass('public.'||$1)))`,
      [from, to],
    );
  }
  function embeddedRelations(select: string) {
    return [...select.matchAll(/([a-z_]+)(?:!inner)?\(/g)].map((m) => m[1]);
  }

  it("every relation embedded by getStudentAssessments resolves through a real foreign key in the migrated schema", async () => {
    await beginRead();
    await getStudentAssessments();
    const checked: string[] = [];
    for (const { table, select } of state.selects)
      for (const relation of embeddedRelations(select)) {
        expect(
          await foreignKeyCount(table, relation),
          `${table} -> ${relation} has no foreign key PostgREST could embed through`,
        ).toBeGreaterThan(0);
        checked.push(`${table}->${relation}`);
      }
    expect(checked).toContain("assessments->lessons");
    expect(
      state.selects.some(
        (s) =>
          s.table === "assessments" &&
          embeddedRelations(s.select).includes("programme_versions"),
      ),
    ).toBe(false);
  });

  it("documents the defect: assessments has no foreign key to programme_versions, so the former embed was unresolvable", async () => {
    expect(await foreignKeyCount("assessments", "programme_versions")).toBe(0);
    expect(await foreignKeyCount("assessments", "lessons")).toBeGreaterThan(0);
  });

  it("keeps the learner-facing shape: each assessment carries its visible programme version snapshot and no internal id", async () => {
    await beginRead();
    const view = await getStudentAssessments();
    expect(view.assessments.length).toBeGreaterThan(0);
    for (const assessment of view.assessments) {
      expect(assessment.programme_versions).toEqual({
        label: expect.any(String),
        title_snapshot: expect.toBeOneOf([expect.any(String), null]),
      });
      expect(assessment).not.toHaveProperty("programme_version_id");
      expect(assessment.lessons).toEqual({ title: expect.any(String) });
    }
    expect(
      state.selects.find((s) => s.table === "programme_versions")?.select,
    ).toBe("id,label,title_snapshot");
  });

  it("fails closed when the programme version snapshot cannot be read", async () => {
    await beginRead();
    state.failTableRead = "programme_versions";
    await expect(getStudentAssessments()).rejects.toThrow(
      "Your assessments could not be loaded.",
    );
  });

  it("fails closed -- never an empty question list -- when a LIVE controlled attempt's protected-question read errors", async () => {
    await startCommitted(f.assessmentIds.QUIZ_1);
    await beginRead();
    state.failRpc = "get_active_assessment_questions";
    await expect(getStudentAssessments()).rejects.toThrow(
      "Your assessments could not be loaded.",
    );
    expect(state.rpcLog).toContain("get_active_assessment_questions");
  });

  it("control: the same live attempt without a read error releases its questions", async () => {
    await startCommitted(f.assessmentIds.QUIZ_1);
    await beginRead();
    const view = await getStudentAssessments();
    expect(view.activityState).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    expect(view.activeQuestions).toHaveLength(1);
    expect(JSON.stringify(view)).not.toMatch(PROTECTED);
  });
});

// =============================================================================
// Bounded read-stage diagnostic (hosted journey run #3): one getStudentAssessments
// Supabase request returned an error and the route could only say
// OPERATION_FAILED. Each request's error result now carries exactly one fixed
// stage code; nothing from the upstream error ever leaves the server.
// =============================================================================
describe("getStudentAssessments: bounded read-stage diagnostic", () => {
  beforeEach(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
    state.rpcLog.length = 0;
    state.rpcArgs.length = 0;
    state.selects.length = 0;
    state.failRpc = undefined;
    state.failTableRead = undefined;
    state.errorAfterRpc = undefined;
    mocks.client.mockImplementation(async () => assessmentClient(f.db, state));
  });
  afterEach(async () => {
    state.errorAfterRpc = undefined;
    await f.db.close();
  });

  async function beginRead() {
    await f.db.exec("begin");
    await actAs(f.db, state, 1);
  }
  async function readFailure(): Promise<StudentAssessmentReadFailure> {
    const error = await getStudentAssessments().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StudentAssessmentReadFailure);
    expect(error).toBeInstanceOf(Error);
    return error as StudentAssessmentReadFailure;
  }
  function expectBounded(error: StudentAssessmentReadFailure) {
    expect(error.message).toBe("Your assessments could not be loaded.");
    expect(error.name).toBe("StudentAssessmentReadFailure");
    // Nothing from the upstream error: no message, details, hint, code or SQL.
    const surfaces = [
      error.message,
      String(error),
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyNames(error)),
    ].join("\n");
    expect(surfaces).not.toContain(UPSTREAM_ERROR_SENTINEL);
    expect(surfaces).not.toMatch(
      /relation "secret"|select 1|XX000|details|hint/,
    );
    expect(Object.keys(error).sort()).toEqual(["name", "stage"]);
  }

  it("exposes exactly the six fixed stage codes", () => {
    expect([...STUDENT_ASSESSMENT_READ_STAGES]).toEqual([
      "FINALIZE",
      "READ_ASSESSMENTS",
      "READ_ATTEMPTS",
      "READ_RESPONSES",
      "ACTIVITY",
      "READ_VERSIONS",
    ]);
  });

  it.each([
    ["FINALIZE", { failRpc: "finalize_expired_commercial_v1_attempts" }],
    ["READ_ASSESSMENTS", { failTableRead: "assessments" }],
    ["READ_ATTEMPTS", { failTableRead: "assessment_attempts" }],
    ["READ_RESPONSES", { failTableRead: "assessment_responses" }],
    ["ACTIVITY", { failRpc: "current_academic_activity_state" }],
    ["READ_VERSIONS", { failTableRead: "programme_versions" }],
  ] as const)(
    "an error result from the %s request maps to exactly that stage, with a generic message and no upstream text",
    async (stage, seam) => {
      await beginRead();
      Object.assign(state, seam);
      const error = await readFailure();
      expect(error.stage).toBe(stage);
      expectBounded(error);
    },
  );

  it("does not wrap non-request failures: a missing version snapshot stays a plain generic Error", async () => {
    await beginRead();
    // The versions read succeeds but returns nothing: an invariant failure,
    // not a Supabase request error, so it carries no stage code.
    const client = assessmentClient(f.db, state);
    mocks.client.mockImplementation(async () => ({
      ...client,
      from(table: string) {
        if (table !== "programme_versions") return client.from(table);
        const empty = {
          select: () => empty,
          in: () => empty,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return empty;
      },
    }));
    const error = await getStudentAssessments().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StudentAssessmentReadFailure);
    expect((error as Error).message).toBe(
      "Your assessments could not be loaded.",
    );
  });

  it("a stale expired governed attempt is finalised AUTO_TIMEOUT even though the finalizer's response is an error => FINALIZE, and no later read is used", async () => {
    // An earlier run's attempt, started and committed, then past its deadline
    // and still ACTIVE because nothing has read or finalised it since.
    await f.db.exec("begin");
    let attemptId: string;
    try {
      attemptId = await start(f.assessmentIds.QUIZ_1);
    } finally {
      await f.db.exec("commit");
    }
    await forceExpire(f.db, attemptId);
    await beginRead();
    // The finalizer's database effect is applied, but the client receives
    // an error result (adapter seam only; production finalisation unchanged).
    state.errorAfterRpc = "finalize_expired_commercial_v1_attempts";

    const error = await readFailure();
    expect(error.stage).toBe("FINALIZE");
    expectBounded(error);

    // The state transition nevertheless happened.
    expect(await attemptRow(attemptId)).toMatchObject({
      state: "SUBMITTED",
      submission_provenance: "AUTO_TIMEOUT",
    });
    // And the call stopped at FINALIZE: no projection read or later RPC ran,
    // so nothing from this call is presented as successful evidence.
    expect(state.rpcLog).toEqual([
      "my_coursework_scope",
      "finalize_expired_commercial_v1_attempts",
    ]);
    expect(state.selects).toEqual([]);
  });

  it("control: with no failure the same stale-attempt read succeeds exactly as before (NORMAL, finalised, no questions)", async () => {
    await f.db.exec("begin");
    let attemptId: string;
    try {
      attemptId = await start(f.assessmentIds.QUIZ_1);
    } finally {
      await f.db.exec("commit");
    }
    await forceExpire(f.db, attemptId);
    await beginRead();
    const view = await getStudentAssessments();
    expect(view.activityState).toBe("NORMAL");
    expect(view.activeQuestions).toEqual([]);
    expect(view.attempts.find((a) => a.id === attemptId)?.state).toBe(
      "SUBMITTED",
    );
  });
});

// =============================================================================
// Hosted journey run #4: the foreign learner's current_academic_activity_state
// request never reached the Supabase API gateway (the edge logs show the
// finalizer and all three concurrent table reads of that call, and no
// activity request), so the read failed as ACTIVITY. postgrest-js already
// retries GET table reads on a rejected fetch but never a POST .rpc(). The
// read-only activity RPC alone is now retried exactly once, and only when the
// first result has no HTTP status at all (status 0).
// =============================================================================
describe("getStudentAssessments: one bounded retry of a transport-failed ACTIVITY read", () => {
  const ACTIVITY = "current_academic_activity_state";
  const QUESTIONS = "get_active_assessment_questions";

  beforeEach(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
    state.rpcLog.length = 0;
    state.rpcArgs.length = 0;
    state.selects.length = 0;
    state.failRpc = undefined;
    state.failTableRead = undefined;
    state.errorAfterRpc = undefined;
    state.transportFail = undefined;
    mocks.client.mockImplementation(async () => assessmentClient(f.db, state));
    // Learner B (policy user 3) is enrolled in the same cohort as learner A.
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.create_enrolment($1,$2,'Policy fixture foreign enrolment')",
      [foreignLearner, f.cohortId],
    );
    await f.db.exec("reset role");
  });
  afterEach(async () => {
    state.transportFail = undefined;
    await f.db.close();
  });

  async function startCommittedAs(n: number, assessmentId: string) {
    await f.db.exec("begin");
    try {
      await actAs(f.db, state, n);
      return await startAssessmentAttempt(assessmentId);
    } finally {
      await f.db.exec("commit");
      state.rpcLog.length = 0;
      state.rpcArgs.length = 0;
      state.selects.length = 0;
    }
  }
  async function beginReadAs(n: number) {
    await f.db.exec("begin");
    await actAs(f.db, state, n);
    state.rpcLog.length = 0;
    state.selects.length = 0;
  }
  const calls = (name: string) =>
    state.rpcLog.filter((logged) => logged === name).length;
  const reads = (table: string) =>
    state.selects.filter((s) => s.table === table).length;
  async function readFailure() {
    const error = await getStudentAssessments().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StudentAssessmentReadFailure);
    const failure = error as StudentAssessmentReadFailure;
    expect(failure.message).toBe("Your assessments could not be loaded.");
    expect(Object.keys(failure).sort()).toEqual(["name", "stage"]);
    expect(
      [String(failure), failure.stack ?? "", JSON.stringify(failure)].join(
        "\n",
      ),
    ).not.toMatch(/UPSTREAM-SENTINEL|fetch failed|details/);
    return failure;
  }

  it("1. a first ACTIVITY transport failure (status 0) is retried once; the retry's result is used and the read succeeds exactly as without the failure", async () => {
    await beginReadAs(1);
    const expected = await getStudentAssessments();
    state.rpcLog.length = 0;
    state.selects.length = 0;
    state.transportFail = { name: ACTIVITY, times: 1 };

    const view = await getStudentAssessments();

    expect(view).toEqual(expected);
    expect(view.activityState).toBe("NORMAL");
    expect(calls(ACTIVITY)).toBe(2);
    expect(state.transportFail.times).toBe(0);
    expect(state.rpcLog).toEqual([
      "my_coursework_scope",
      "finalize_expired_commercial_v1_attempts",
      ACTIVITY,
      ACTIVITY,
    ]);
    // The table reads ran once each; only the activity RPC was repeated.
    expect(reads("assessments")).toBe(1);
    expect(reads("assessment_attempts")).toBe(1);
    expect(reads("assessment_responses")).toBe(1);
  });

  it("2. ACTIVITY transport failures on both calls => exactly two calls, then StudentAssessmentReadFailure(ACTIVITY); never a loop", async () => {
    await beginReadAs(1);
    state.transportFail = { name: ACTIVITY, times: 5 };

    const failure = await readFailure();

    expect(failure.stage).toBe("ACTIVITY");
    expect(calls(ACTIVITY)).toBe(2);
    expect(state.transportFail.times).toBe(3);
    expect(calls(QUESTIONS)).toBe(0);
    expect(reads("programme_versions")).toBe(0);
  });

  it("3. an ordinary ACTIVITY error result (the adapter's PostgREST error, HTTP 400) is not retried", async () => {
    await beginReadAs(1);
    state.failRpc = ACTIVITY;

    const failure = await readFailure();

    expect(failure.stage).toBe("ACTIVITY");
    expect(calls(ACTIVITY)).toBe(1);
  });

  it.each([400, 401, 403, 404, 500, 502, 503, 504, 520])(
    "3b. an ACTIVITY error result with HTTP status %i is not retried",
    async (status) => {
      await beginReadAs(1);
      const client = assessmentClient(f.db, state);
      mocks.client.mockImplementation(async () => ({
        ...client,
        async rpc(name: string, args?: Record<string, unknown>) {
          if (name !== ACTIVITY) return client.rpc(name, args);
          state.rpcLog.push(name);
          return {
            data: null,
            error: {
              message: "UPSTREAM-SENTINEL",
              details: "",
              hint: "",
              code: "",
            },
            status,
            statusText: "",
          };
        },
      }));

      const failure = await readFailure();

      expect(failure.stage).toBe("ACTIVITY");
      expect(calls(ACTIVITY)).toBe(1);
    },
  );

  it.each([
    ["FINALIZE", "finalize_expired_commercial_v1_attempts"],
    ["READ_ASSESSMENTS", "assessments"],
    ["READ_ATTEMPTS", "assessment_attempts"],
    ["READ_RESPONSES", "assessment_responses"],
    ["READ_VERSIONS", "programme_versions"],
  ] as const)(
    "4. a transport failure (status 0) of the %s request is never retried",
    async (stage, name) => {
      await beginReadAs(1);
      state.transportFail = { name, times: 1 };

      const failure = await readFailure();

      expect(failure.stage).toBe(stage);
      if (stage === "FINALIZE") {
        expect(calls(name)).toBe(1);
        expect(state.rpcLog).toEqual(["my_coursework_scope", name]);
        expect(state.selects).toEqual([]);
      } else {
        expect(reads(name)).toBe(1);
        // The activity read itself succeeded, so it ran once.
        expect(calls(ACTIVITY)).toBe(1);
      }
    },
  );

  it("4b. a transport failure of the protected-question read is not retried and still fails closed for a live attempt", async () => {
    await startCommittedAs(1, f.assessmentIds.QUIZ_1);
    await beginReadAs(1);
    state.transportFail = { name: QUESTIONS, times: 1 };

    const error = await getStudentAssessments().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StudentAssessmentReadFailure);
    expect((error as Error).message).toBe(
      "Your assessments could not be loaded.",
    );
    expect(calls(QUESTIONS)).toBe(1);
    expect(calls(ACTIVITY)).toBe(1);
  });

  it("4c. write RPCs are never retried: a transport-failed start or submit is attempted once and reported as a failure", async () => {
    await f.db.exec("begin");
    await actAs(f.db, state, 1);
    state.transportFail = { name: "start_assessment_attempt", times: 1 };
    await expect(
      startAssessmentAttempt(f.assessmentIds.QUIZ_1),
    ).rejects.toThrow("Assessment attempt could not be started.");
    expect(calls("start_assessment_attempt")).toBe(1);
    expect(
      await scalar<number>(
        "select count(*)::int as v from public.assessment_attempts where assessment_id=$1",
        [f.assessmentIds.QUIZ_1],
      ),
    ).toBe(0);

    await actAs(f.db, state, 1);
    const attemptId = await startAssessmentAttempt(f.assessmentIds.QUIZ_1);
    state.transportFail = { name: "submit_assessment_attempt", times: 1 };
    await expect(submitAssessmentAttempt(attemptId)).rejects.toThrow(
      "Assessment attempt could not be submitted.",
    );
    expect(calls("submit_assessment_attempt")).toBe(1);
    expect(await attemptRow(attemptId)).toMatchObject({ state: "ACTIVE" });
    await f.db.exec("rollback");
  });

  it("5. learner B with its own ACTIVE controlled attempt gets CONTROLLED_ASSESSMENT_ACTIVE after one transport failure and one retry; learner A stays isolated", async () => {
    const attemptB = await startCommittedAs(3, f.assessmentIds.QUIZ_1);

    await beginReadAs(3);
    state.transportFail = { name: ACTIVITY, times: 1 };
    const viewB = await getStudentAssessments();
    await f.db.exec("rollback");

    expect(calls(ACTIVITY)).toBe(2);
    expect(viewB.activityState).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    expect(viewB.attempts.map((a) => a.id)).toEqual([attemptB]);
    expect(viewB.attempts[0].state).toBe("ACTIVE");
    expect(viewB.activeQuestions).toHaveLength(1);
    expect(state.rpcArgs.find((c) => c.name === QUESTIONS)?.args).toEqual({
      p_assessment_id: f.assessmentIds.QUIZ_1,
    });

    // Learner A has no attempt of its own: the same transport failure and
    // retry yields A's own NORMAL state, none of B's attempt and no questions.
    await beginReadAs(1);
    state.rpcArgs.length = 0;
    state.transportFail = { name: ACTIVITY, times: 1 };
    const viewA = await getStudentAssessments();
    await f.db.exec("rollback");

    expect(calls(ACTIVITY)).toBe(2);
    expect(viewA.activityState).toBe("NORMAL");
    expect(viewA.attempts).toEqual([]);
    expect(viewA.responses).toEqual([]);
    expect(viewA.activeQuestions).toEqual([]);
    expect(calls(QUESTIONS)).toBe(0);
  });

  it("6. the retry never bypasses own-attempt checks: no protected question content is released to a learner without its own ACTIVE attempt, and none is ever exposed", async () => {
    await startCommittedAs(3, f.assessmentIds.QUIZ_1);

    await beginReadAs(1);
    state.transportFail = { name: ACTIVITY, times: 1 };
    const viewA = await getStudentAssessments();
    await f.db.exec("rollback");
    expect(calls(ACTIVITY)).toBe(2);
    expect(viewA.activeQuestions).toEqual([]);
    expect(calls(QUESTIONS)).toBe(0);
    expect(JSON.stringify(viewA)).not.toMatch(PROTECTED);

    await beginReadAs(3);
    state.transportFail = { name: ACTIVITY, times: 1 };
    const viewB = await getStudentAssessments();
    expect(viewB.activeQuestions).toHaveLength(1);
    expect(JSON.stringify(viewB)).not.toMatch(PROTECTED);
  });
});
