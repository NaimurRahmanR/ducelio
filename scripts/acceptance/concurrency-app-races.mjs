// Application-level concurrency races for `npm run acceptance:concurrency`:
//
//   POSTGRES_CONCURRENCY:LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE
//   POSTGRES_CONCURRENCY:REGRADE_VS_COMPLETION
//
// Why these are NOT NEVER_TWO_REVISION_ONES under another name: that
// scenario races two raw, privileged transactions against the
// unique(enrolment_id,component,revision_number) index. These two drive
// the REAL governed state machines end to end through the real Ducelio app
// server (examiner-app.mjs's shared openExaminerAppSession -- the same
// fail-closed acceptance route, loopback provider stub and genuine hosted
// sessions), so every AUTHORIZE/START/CONTEXT_READ/FINALIZE transition is
// attested by the unmodified src/server/commercial-v1-examiner-*/
// authority.ts modules. Nothing here signs, digests or builds a canonical
// message, and no row the races depend on is written directly:
//
// - LATE_INITIAL: an initial grading execution whose DB-owned 20 s lease
//   genuinely expires while its original application invocation is still
//   alive; migration 031's own lazy-timeout path (driven by a real replay)
//   marks it TIMEOUT; then the original invocation's late FINALIZE and an
//   admin's real recoverExaminerTarget are released together. Tests the
//   execution state machine + the one-claim-per-source recovery authority,
//   not a unique index.
// - REGRADE_VS_COMPLETION: the real regrade FINALIZE (migration 032) and
//   the learner's real public.attempt_commercial_v1_course_completion
//   (migration 030) released together against the SAME enrolment. Both
//   take `enrolments ... FOR UPDATE` before their authoritative reads; this
//   scenario checks the resulting state empirically and accepts exactly the
//   two legitimate serial orders.
//
// Hold points (examiner-provider-stub.mjs): one-shot provider-response
// holds, plus -- for LATE_INITIAL only -- a hold on DELIVERY of the
// already-served initial context-read response inside the app process.
// The second hold exists because the EXAMINER_COMMERCIAL_V1 profile's
// provider deadline (15 s) is shorter than the DB lease (20 s): parking the
// provider call alone would make the runtime abort and FINALIZE FAILED
// while the lease was still live, so the late-FINALIZE race could never be
// reached. The lease itself is never shortened, edited or simulated; the
// only timed wait in this file is for that genuine DB lease to pass.
//
// Start discipline: exactly as concurrency.mjs -- one client-side start
// gate releases both contenders once both are prepared. That proves both
// operations were dispatched together from the client side, never that the
// server began executing them at the same instant.
import { AcceptanceWriteNotAuthorizedError } from "./db.mjs";
import {
  openExaminerAppSession,
  answerQuiz1,
  guardScenario,
  marksFollowRule,
  recordLeaks,
  same,
  stubCallsFor,
  Q,
} from "./examiner-app.mjs";
import { pass, fail, blocked } from "./report.mjs";

export const APP_RACE_SURFACES = Object.freeze({
  LATE_INITIAL:
    "POSTGRES_CONCURRENCY:LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE",
  REGRADE_VS_COMPLETION: "POSTGRES_CONCURRENCY:REGRADE_VS_COMPLETION",
});

// V7: the smallest explicit start barrier. Each contender calls arrive()
// exactly once, when it is fully prepared (connection open and transaction
// begun, or client signed in); every arrive() promise resolves together
// only after all `parties` have arrived. This proves both contenders were
// released from the same client-side point -- not that the server executed
// them at the same instant. (Re-exported by concurrency.mjs.)
export function createStartGate(parties) {
  let arrived = 0;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    arrive() {
      arrived += 1;
      if (arrived >= parties) release();
      return released;
    },
  };
}

const DEFAULT_TIMING = Object.freeze({
  // Generous: `next dev` may compile server modules on first use.
  arrivalTimeoutMs: 90_000,
  settleTimeoutMs: 90_000,
  // The DB lease is 20 s; this only bounds waiting for it.
  leaseWaitLimitMs: 45_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
const timingFor = (ctx) => ({ ...DEFAULT_TIMING, ...(ctx.timing ?? {}) });

export function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label} did not happen within ${Math.round(ms / 1000)} s.`,
            ),
          ),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

// Read-only queries (privileged acceptance connection, no gate needed).
export const RQ = Object.freeze({
  executionLease: `select e.state, clock_timestamp() >= e.expires_at as expired,
      greatest(0, ceil(extract(epoch from (e.expires_at - clock_timestamp())) * 1000))::int as remaining_ms
    from commercial_v1_examiner_executions e where e.id=$1`,
  studentLiveLeases: `select count(*)::int as live,
      coalesce(greatest(0, ceil(extract(epoch from (max(l.expires_at) - clock_timestamp())) * 1000)), 0)::int as remaining_ms
    from (
      select expires_at from commercial_v1_examiner_executions
        where student_id=$1 and state in ('AUTHORIZED','RUNNING') and expires_at>clock_timestamp()
      union all
      select expires_at from commercial_v1_examiner_recovery_executions
        where student_id=$1 and state in ('AUTHORIZED','RUNNING') and expires_at>clock_timestamp()
      union all
      select expires_at from commercial_v1_examiner_regrade_executions
        where student_id=$1 and state in ('AUTHORIZED','RUNNING') and expires_at>clock_timestamp()
    ) l`,
  quiz1Revisions: `select r.id, r.revision_number, r.attempt_id, r.earned_marks_total, r.max_marks_total,
      r.weighted_contribution_bp,
      commercial_v1_private.assessment_result_is_valid(r.id) as valid,
      (select count(*)::int from commercial_v1_assessment_objective_outcomes o where o.result_revision_id=r.id) as outcome_rows
    from commercial_v1_assessment_result_revisions r
    where r.enrolment_id=$1 and r.component='QUIZ_1' order by r.revision_number`,
  regradeClaims: `select e.id, e.state, e.reason_code, e.actor_id, e.student_id, e.result_revision_id, u.provider_calls
    from commercial_v1_examiner_regrade_executions e
    left join commercial_v1_examiner_regrade_usage u on u.execution_id=e.id
    where e.source_result_revision_id=$1`,
  progress: `select commercial_v1_private.course_progress($1) as progress`,
  enrolmentStatus: `select status from enrolments where id=$1`,
  receipts: `select id, student_id, completed_by, final_course_score_bp, pass_mark_bp
    from commercial_v1_completion_receipts where enrolment_id=$1`,
  completionAudits: `select count(*)::int as n from audit_events
    where action='COMMERCIAL_V1_COURSE_COMPLETED' and target_id=$1`,
  // The fresh-admission predicates of migrations 031/040/032 (student_id
  // plus created_at > one captured DB timestamp minus the window), read-only.
  initialAdmissions: admissionWindowSql("commercial_v1_examiner_executions"),
  recoveryAdmissions: admissionWindowSql(
    "commercial_v1_examiner_recovery_executions",
  ),
  regradeAdmissions: admissionWindowSql(
    "commercial_v1_examiner_regrade_executions",
  ),
});

// Production captures clock_timestamp() once (`stamp`) and evaluates both
// windows against that one instant; clock_timestamp() advances even within
// a single statement, so it is captured exactly once here too, in a
// materialized one-row CTE shared by both counts.
function admissionWindowSql(table) {
  return `with stamp as materialized (select clock_timestamp() as t)
    select
      count(*) filter (where created_at > stamp.t - interval '60 seconds')::int as last_minute,
      count(*) filter (where created_at > stamp.t - interval '1 hour')::int as last_hour
    from ${table} cross join stamp where student_id=$1`;
}

// The production per-learner fresh-admission limits every Examiner
// AUTHORIZE path enforces (initial, recovery and regrade alike): admission
// is refused RATE_LIMITED once 5 claims were created in the last 60 s or 30
// in the last hour. The harness reuses one synthetic learner, so recent
// acceptance activity can legitimately exhaust a window. That is a missing
// prerequisite (BLOCKED), never a concurrency FAIL; the harness never
// waits out, resets, deletes, backdates or bypasses that history.
export const ADMISSION_LIMITS = Object.freeze({ perMinute: 5, perHour: 30 });
export const ADMISSION_FAMILIES = Object.freeze({
  INITIAL: Object.freeze({
    label: "initial grading claims (commercial_v1_examiner_executions)",
    sql: RQ.initialAdmissions,
  }),
  RECOVERY: Object.freeze({
    label: "recovery claims (commercial_v1_examiner_recovery_executions)",
    sql: RQ.recoveryAdmissions,
  }),
  REGRADE: Object.freeze({
    label: "regrade claims (commercial_v1_examiner_regrade_executions)",
    sql: RQ.regradeAdmissions,
  }),
});

// Pure: null when one fresh admission is available, else the bounded,
// non-sensitive reason (family, count and window only).
export function admissionWindowExhausted(family, row) {
  const lastMinute = Number(row?.last_minute ?? 0);
  const lastHour = Number(row?.last_hour ?? 0);
  if (lastMinute >= ADMISSION_LIMITS.perMinute)
    return `${family.label}: ${lastMinute} created in the last 60 s (limit ${ADMISSION_LIMITS.perMinute}).`;
  if (lastHour >= ADMISSION_LIMITS.perHour)
    return `${family.label}: ${lastHour} created in the last hour (limit ${ADMISSION_LIMITS.perHour}).`;
  return null;
}

async function admissionBlock(ctx, surface, studentId, families, evidence) {
  const exhausted = [];
  for (const family of families) {
    const [row] = await ctx.query(family.sql, [studentId]);
    const reason = admissionWindowExhausted(family, row);
    if (reason) exhausted.push(reason);
  }
  if (!exhausted.length) return null;
  return blocked(
    surface,
    "Recent synthetic acceptance activity has exhausted the acceptance learner's real production Examiner admission window; the race was not attempted past this point. Rerun once the window has capacity.",
    [...evidence, ...exhausted],
  );
}

async function waitForLeasesToPass(ctx, readLease, label) {
  const t = timingFor(ctx);
  const deadline = Date.now() + t.leaseWaitLimitMs;
  for (;;) {
    const lease = await readLease();
    if (lease.done) return lease.row;
    if (Date.now() >= deadline)
      throw new Error(`${label} did not pass within the bounded wait.`);
    await t.sleep(Math.min(lease.remainingMs + 250, 5_000));
  }
}

// Earlier scenarios in the same run may leave a live AUTHORIZED claim for
// this learner (the DB-constraint races insert them directly); a new
// admission would then be RATE_LIMITED. Waits only for those genuine
// leases to pass -- the governed AUTHORIZE paths time them out lazily.
async function waitForStudentLeasesClear(ctx, studentId) {
  await waitForLeasesToPass(
    ctx,
    async () => {
      const [row] = await ctx.query(RQ.studentLiveLeases, [studentId]);
      return {
        done: !row || row.live === 0,
        remainingMs: row?.remaining_ms ?? 0,
        row,
      };
    },
    "Earlier live Examiner leases for the acceptance learner",
  );
}

const leak = (problems, responses) =>
  recordLeaks(
    problems,
    responses.filter((r) => r && typeof r.text === "string"),
  );

// ---------------------------------------------------------------------------
// LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE -- pure verdict.
// ---------------------------------------------------------------------------
export function evaluateLateInitialRace(o) {
  const problems = [];
  const revision = o.revisions.length === 1 ? o.revisions[0] : null;
  const original = o.executions.length === 1 ? o.executions[0] : null;
  if (!original || original.id !== o.originalExecutionId)
    problems.push(
      `Expected exactly the one original initial execution for the attempt; found ${o.executions.length}.`,
    );
  else if (
    original.state !== "TIMEOUT" ||
    original.reason_code !== "EXECUTION_TIMEOUT" ||
    original.result_revision_id !== null ||
    original.grade_digest !== null ||
    original.provider_calls !== null
  )
    problems.push(
      `The timed-out original execution changed or acquired result/usage state (state ${original.state}, reason ${original.reason_code ?? "none"}, result ${original.result_revision_id ? "present" : "none"}, usage ${original.provider_calls ?? "none"}).`,
    );
  if (!o.originalUnchangedSinceTimeout)
    problems.push(
      "The original execution row changed after the replay timed it out.",
    );
  if (o.originalHoldOutcome !== "RESPONDED")
    problems.push(
      `The original invocation's provider response was not delivered after the lease expired (${o.originalHoldOutcome ?? "unknown"}); the late FINALIZE path was not exercised.`,
    );
  if (
    o.lateResponse?.status !== 200 ||
    o.lateResponse.body?.result?.grading !== "GRADING_UNAVAILABLE"
  )
    problems.push(
      `The late original invocation did not end GRADING_UNAVAILABLE (HTTP ${o.lateResponse?.status ?? "none"}, ${o.lateResponse?.body?.result?.grading ?? o.lateResponse?.body?.error ?? "no result"}).`,
    );

  const claim = o.recoveryClaims.length === 1 ? o.recoveryClaims[0] : null;
  if (!claim)
    problems.push(
      `Expected exactly one recovery claim for the original source; found ${o.recoveryClaims.length}.`,
    );
  else if (
    claim.state !== "SUCCEEDED" ||
    claim.actor_id !== o.recoveryActorId ||
    claim.student_id !== o.studentId ||
    claim.provider_calls !== 1 ||
    !revision ||
    claim.result_revision_id !== revision.id
  )
    problems.push(
      `The recovery claim is not one coherent admin-owned SUCCEEDED claim owning the sole revision (state ${claim.state}).`,
    );
  if (o.recoveryHoldOutcome !== "RESPONDED")
    problems.push(
      `The recovery provider call was not answered through its hold (${o.recoveryHoldOutcome ?? "unknown"}).`,
    );
  if (
    o.recoveryResponse?.status !== 200 ||
    o.recoveryResponse.body?.result?.status !== "RECOVERED" ||
    !revision ||
    o.recoveryResponse.body.result.resultRevisionId !== revision.id
  )
    problems.push(
      `Admin recovery did not report RECOVERED for the sole revision (HTTP ${o.recoveryResponse?.status ?? "none"}, ${o.recoveryResponse?.body?.result?.status ?? o.recoveryResponse?.body?.error ?? "no result"}).`,
    );

  if (!revision)
    problems.push(
      `Expected exactly one QUIZ_1 result revision; found ${o.revisions.length}.`,
    );
  else if (
    revision.revision_number !== 1 ||
    revision.attempt_id !== o.attemptId ||
    revision.valid !== true ||
    revision.outcome_rows < 1 ||
    o.marks?.rows !== o.questionCount ||
    o.marks?.matches !== true ||
    revision.earned_marks_total !== o.marks?.earned
  )
    problems.push(
      "The sole revision's number, provenance, question marks, objective outcomes or validity are incoherent.",
    );

  const calls = o.stubCalls;
  if (
    calls.length !== 2 ||
    !calls.every(
      (c) =>
        c.capability === "grade_controlled_assessment" &&
        c.outcome === "GRADED" &&
        c.held === true,
    )
  )
    problems.push(
      `Expected exactly two held provider calls for the attempt (the late original and the recovery); saw ${calls.length}.`,
    );

  const r = o.replays;
  if (
    r?.recovery?.status !== 200 ||
    r.recovery.body?.result?.status !== "ALREADY_RECOVERED" ||
    !revision ||
    r.recovery.body.result.resultRevisionId !== revision.id ||
    r.learner?.status !== 200 ||
    r.learner.body?.result?.grading !== "GRADING_UNAVAILABLE" ||
    r.historyUnchanged !== true
  )
    problems.push(
      "Replay of recovery or of the initial grading path did not return the existing outcome without new history.",
    );
  return problems;
}

export async function scenarioLateInitialFinalizeVsRecovery(ctx) {
  const surface = APP_RACE_SURFACES.LATE_INITIAL;
  const t = timingFor(ctx);
  const responses = [];
  const course = await ctx.seed("late-initial");
  const evidence = [
    `course_package_imports ${course.importId}, activation ${course.activationId}, enrolment ${course.enrolmentId}`,
  ];
  const stop = (reason, details = []) =>
    fail(surface, reason, [...evidence, ...details]);
  await waitForStudentLeasesClear(ctx, course.studentId);
  // Live leases and admission windows are separate prerequisites: both
  // fresh admissions this race needs must be available before any grading.
  const noCapacity = await admissionBlock(
    ctx,
    surface,
    course.studentId,
    [ADMISSION_FAMILIES.INITIAL, ADMISSION_FAMILIES.RECOVERY],
    evidence,
  );
  if (noCapacity) return noCapacity;
  const attemptId = await answerQuiz1(ctx, course);
  evidence.push(`attempt ${attemptId}`);

  const contextHold = ctx.stub.holdNextContextRead();
  const originalHold = ctx.stub.holdNextProviderResponse();
  let recoveryHold = null;
  let recoverySide = null;
  const original = settle(
    ctx.app.call(ctx.jars.learner, {
      operation: "SUBMIT_AND_GRADE_ASSESSMENT",
      attemptId,
    }),
  );
  const originalOutcome = async () => {
    const settled = await within(
      original,
      t.settleTimeoutMs,
      "The original request",
    );
    return settled.ok
      ? `HTTP ${settled.value.status} ${settled.value.body?.result?.grading ?? settled.value.body?.error ?? ""}`.trim()
      : "request error";
  };
  try {
    // 1. The real initial AUTHORIZE/START/CONTEXT_READ path has run.
    try {
      await within(
        contextHold.arrived,
        t.arrivalTimeoutMs,
        "The original grading request reaching its context-read hold",
      );
    } catch (error) {
      contextHold.cancel();
      originalHold.cancel();
      return stop(
        "The original grading request never reached the held context read.",
        [
          error.message,
          `original request: ${await originalOutcome().catch(() => "still pending")}`,
        ],
      );
    }
    const started = await ctx.query(Q.initialExecutions, [attemptId]);
    const execution = started.length === 1 ? started[0] : null;
    const [lease] = execution
      ? await ctx.query(RQ.executionLease, [execution.id])
      : [];
    if (!execution || execution.state !== "RUNNING" || lease?.expired !== false)
      return stop(
        "Expected exactly one genuinely active (RUNNING, unexpired) initial execution while the original request was held.",
        [
          `initial executions ${started.length}`,
          `state ${execution?.state ?? "none"}`,
        ],
      );
    const executionId = execution.id;
    evidence.push(`original execution ${executionId}`);

    // 2. The genuine DB-owned lease passes; expires_at is never touched.
    const expired = await waitForLeasesToPass(
      ctx,
      async () => {
        const [row] = await ctx.query(RQ.executionLease, [executionId]);
        return {
          done: row?.expired === true,
          remainingMs: row?.remaining_ms ?? 0,
          row,
        };
      },
      "The original execution's 20 s lease",
    );
    if (expired.state !== "RUNNING")
      return stop(
        `The original execution left RUNNING before the replay could time it out (state ${expired.state}).`,
      );

    // 3. A real replay of the same initial path lazily times it out.
    const replay = await ctx.app.call(ctx.jars.learner, {
      operation: "SUBMIT_AND_GRADE_ASSESSMENT",
      attemptId,
    });
    responses.push(replay);
    const afterReplay = await ctx.query(Q.initialExecutions, [attemptId]);
    const timedOut = afterReplay.length === 1 ? afterReplay[0] : null;
    if (
      replay.status !== 200 ||
      replay.body?.result?.grading !== "GRADING_UNAVAILABLE" ||
      timedOut?.id !== executionId ||
      timedOut.state !== "TIMEOUT" ||
      timedOut.reason_code !== "EXECUTION_TIMEOUT" ||
      timedOut.result_revision_id !== null ||
      (await ctx.query(Q.revisions, [course.enrolmentId])).length !== 0 ||
      stubCallsFor(ctx.stub, attemptId).length !== 0 ||
      contextHold.state !== "HELD"
    )
      return stop(
        "The replay did not lazily time out the same original execution without a second execution, revision or provider call.",
        [
          `replay HTTP ${replay.status} ${replay.body?.result?.grading ?? ""}`.trim(),
          `initial executions ${afterReplay.length}`,
          `state ${timedOut?.state ?? "none"}`,
        ],
      );
    const timedOutSnapshot = (
      await ctx.query(Q.executionSnapshot, [executionId])
    )[0];
    // Re-checked immediately before the fresh recovery admission, while the
    // original is still parked before its provider deadline starts.
    const noRecoveryCapacity = await admissionBlock(
      ctx,
      surface,
      course.studentId,
      [ADMISSION_FAMILIES.RECOVERY],
      evidence,
    );
    if (noRecoveryCapacity) return noRecoveryCapacity;

    // 4. The still-alive original proceeds to its provider call, after the
    //    lease, and parks there.
    contextHold.release();
    let originalArrival;
    try {
      originalArrival = await within(
        originalHold.arrived,
        t.arrivalTimeoutMs,
        "The late original request reaching its provider hold",
      );
    } catch (error) {
      originalHold.cancel();
      return stop(
        "The late original request never reached its provider call.",
        [
          error.message,
          `original request: ${await originalOutcome().catch(() => "still pending")}`,
        ],
      );
    }
    if (
      originalArrival.capability !== "grade_controlled_assessment" ||
      originalArrival.attemptId !== attemptId
    )
      return stop("The held provider call was not the original grading call.");

    // 5. One start gate: release the late original AND dispatch recovery.
    recoveryHold = ctx.stub.holdNextProviderResponse();
    const reason = `Concurrency acceptance late-initial recovery ${ctx.runId}`;
    const gate = createStartGate(2);
    const lateSide = (async () => {
      await gate.arrive();
      originalHold.release();
      return original;
    })();
    recoverySide = settle(
      (async () => {
        await gate.arrive();
        return ctx.app.call(ctx.jars.admin, {
          operation: "RECOVER_EXAMINER_TARGET",
          sourceExecutionId: executionId,
          reason,
        });
      })(),
    );

    // 6. Recovery crossed its own real AUTHORIZE/START/CONTEXT_READ path.
    const problems = [];
    try {
      const arrival = await within(
        recoveryHold.arrived,
        t.arrivalTimeoutMs,
        "The recovery request reaching its provider hold",
      );
      const claims = await ctx.query(Q.recoveryExecutions, [executionId]);
      if (
        arrival.capability !== "grade_controlled_assessment" ||
        arrival.attemptId !== attemptId ||
        claims.length !== 1 ||
        claims[0].state !== "RUNNING"
      )
        problems.push(
          "The held recovery provider call was not a RUNNING recovery claim for this source.",
        );
    } catch (error) {
      problems.push(error.message);
    }
    recoveryHold.release();

    const [late, recovery] = await Promise.all([
      within(lateSide, t.settleTimeoutMs, "The late original request"),
      within(recoverySide, t.settleTimeoutMs, "The recovery request"),
    ]);
    const lateResponse = late.ok ? late.value : null;
    const recoveryResponse = recovery.ok ? recovery.value : null;
    responses.push(lateResponse, recoveryResponse);

    // 7. Independent read of the durable hosted state.
    const executions = await ctx.query(Q.initialExecutions, [attemptId]);
    const recoveryClaims = await ctx.query(Q.recoveryExecutions, [executionId]);
    const revisions = await ctx.query(Q.revisions, [course.enrolmentId]);
    const questionCount = (
      await ctx.query(Q.questionCount, [course.quiz1AssessmentId])
    )[0]?.n;
    const marks =
      revisions.length === 1
        ? await marksFollowRule(
            ctx,
            revisions[0].id,
            "grade_controlled_assessment",
          )
        : null;
    const snapshotAfter = (
      await ctx.query(Q.executionSnapshot, [executionId])
    )[0];
    const stubCalls = [...stubCallsFor(ctx.stub, attemptId)];
    const originalHoldOutcome = await originalHold.settled;
    const recoveryHoldOutcome = await recoveryHold.settled;

    // 8. Replays create nothing new.
    const recoveryReplay = await ctx.app.call(ctx.jars.admin, {
      operation: "RECOVER_EXAMINER_TARGET",
      sourceExecutionId: executionId,
      reason,
    });
    const learnerReplay = await ctx.app.call(ctx.jars.learner, {
      operation: "SUBMIT_AND_GRADE_ASSESSMENT",
      attemptId,
    });
    responses.push(recoveryReplay, learnerReplay);
    const historyUnchanged =
      (await ctx.query(Q.initialExecutions, [attemptId])).length ===
        executions.length &&
      (await ctx.query(Q.recoveryExecutions, [executionId])).length ===
        recoveryClaims.length &&
      (await ctx.query(Q.revisions, [course.enrolmentId])).length ===
        revisions.length &&
      stubCallsFor(ctx.stub, attemptId).length === stubCalls.length;

    problems.push(
      ...evaluateLateInitialRace({
        attemptId,
        originalExecutionId: executionId,
        recoveryActorId: course.recoveryActorId,
        studentId: course.studentId,
        questionCount,
        lateResponse,
        recoveryResponse,
        originalHoldOutcome,
        recoveryHoldOutcome,
        executions,
        originalUnchangedSinceTimeout:
          Boolean(timedOutSnapshot) && same(timedOutSnapshot, snapshotAfter),
        recoveryClaims,
        revisions,
        marks,
        stubCalls,
        replays: {
          recovery: recoveryReplay,
          learner: learnerReplay,
          historyUnchanged,
        },
      }),
    );
    leak(problems, responses);
    evidence.push(
      `recovery result revision ${recoveryResponse?.body?.result?.resultRevisionId ?? "none"}`,
    );
    if (problems.length)
      return stop(
        "The late initial FINALIZE vs recovery race did not leave exactly one coherent recovered result.",
        problems,
      );
    return pass(
      surface,
      "Real-application race (not a raw insert): a learner's real initial grading request passed hosted AUTHORIZE/START/CONTEXT_READ and was held in flight while its genuine 20 s DB lease expired; a real replay of the same path lazily moved that same execution to TIMEOUT with no second execution, revision or provider call. The still-alive original invocation then received its provider response and, released from one client-side start gate together with an authenticated admin's real recoverExaminerTarget request, returned GRADING_UNAVAILABLE while the database kept the original TIMEOUT with no result or usage. Exactly one admin-owned recovery claim succeeded, owning the one valid revision 1, and replays created nothing new. Proves both requests were dispatched together from the client side; does not prove the server transactions overlapped in time.",
      evidence,
    );
  } finally {
    // Never leave a parked request behind (no-ops once settled).
    contextHold.cancel();
    originalHold.cancel();
    recoveryHold?.cancel();
    await within(original, t.settleTimeoutMs, "original").catch(() => {});
    if (recoverySide)
      await within(recoverySide, t.settleTimeoutMs, "recovery").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// REGRADE_VS_COMPLETION -- pure verdict. Returns the serial order the
// durable state proves (or null) plus every problem found.
// ---------------------------------------------------------------------------
export const SERIAL_ORDERS = Object.freeze({
  REGRADE_FIRST: "REGRADE_FIRST",
  COMPLETION_FIRST: "COMPLETION_FIRST",
});

export function evaluateRegradeCompletionRace(o) {
  const problems = [];
  const source = o.revisions.find((r) => r.id === o.sourceRevisionId) ?? null;
  const next =
    o.revisions.length === 2 && source?.revision_number === 1
      ? o.revisions.find((r) => r.id !== o.sourceRevisionId)
      : null;
  const order =
    o.revisions.length === 2 && next
      ? SERIAL_ORDERS.REGRADE_FIRST
      : o.revisions.length === 1 && source
        ? SERIAL_ORDERS.COMPLETION_FIRST
        : null;
  if (!order)
    problems.push(
      `The QUIZ_1 revision history (${o.revisions.length} revision(s)) cannot be explained by either serial order.`,
    );
  if (o.revisions.some((r) => r.valid !== true))
    problems.push("A QUIZ_1 result revision is invalid or partial.");
  if (!source || source.revision_number !== 1 || !o.sourceUnchanged)
    problems.push("The regrade source revision is missing or changed.");

  const claim = o.regradeClaims.length === 1 ? o.regradeClaims[0] : null;
  if (
    !claim ||
    claim.actor_id !== o.regradeActorId ||
    claim.student_id !== o.studentId ||
    claim.provider_calls !== 1
  )
    problems.push(
      `Expected exactly one admin-owned regrade claim with exactly one recorded provider call; found ${o.regradeClaims.length}.`,
    );
  if (
    o.regradeStubCalls.length !== 1 ||
    o.regradeStubCalls[0].capability !== "regrade_controlled_assessment" ||
    o.regradeStubCalls[0].outcome !== "GRADED" ||
    o.regradeStubCalls[0].held !== true ||
    o.regradeHoldOutcome !== "RESPONDED"
  )
    problems.push(
      `Expected exactly one held, answered regrade provider call; saw ${o.regradeStubCalls.length}.`,
    );

  const receipt = o.receipts.length === 1 ? o.receipts[0] : null;
  if (!receipt)
    problems.push(
      `Expected exactly one completion receipt; found ${o.receipts.length}.`,
    );
  if (o.completionAudits !== 1)
    problems.push(
      `Expected exactly one COMMERCIAL_V1_COURSE_COMPLETED audit event; found ${o.completionAudits}.`,
    );
  if (o.enrolmentStatus !== "COMPLETED")
    problems.push(
      `Expected enrolment status COMPLETED; got ${o.enrolmentStatus ?? "none"}.`,
    );
  const completed = o.completion?.data ?? null;
  if (
    o.completion?.error ||
    completed?.ok !== true ||
    completed.code !== "COMPLETED" ||
    !receipt ||
    completed.receiptId !== receipt.id ||
    completed.courseScoreBp !== receipt.final_course_score_bp
  )
    problems.push(
      `The completion call did not report COMPLETED for the one receipt (${completed?.code ?? "no response"}).`,
    );
  if (receipt) {
    if (
      receipt.student_id !== o.studentId ||
      receipt.completed_by !== o.studentId ||
      receipt.pass_mark_bp !== o.passMarkBp ||
      receipt.final_course_score_bp < receipt.pass_mark_bp
    )
      problems.push(
        "The receipt's learner, pass mark or passing score is incoherent.",
      );
    if (receipt.final_course_score_bp !== o.scoreNow)
      problems.push(
        `The receipt score (${receipt.final_course_score_bp}) differs from the score of the current authoritative results (${o.scoreNow}).`,
      );
  }

  if (order === SERIAL_ORDERS.REGRADE_FIRST) {
    if (
      next.revision_number !== 2 ||
      next.attempt_id !== o.attemptId ||
      next.outcome_rows < 1 ||
      o.nextRevisionMarks?.rows !== o.questionCount ||
      o.nextRevisionMarks?.matches !== true ||
      next.earned_marks_total !== o.nextRevisionMarks?.earned
    )
      problems.push(
        "The regrade revision's number, provenance or marks are incoherent.",
      );
    if (
      claim &&
      (claim.state !== "SUCCEEDED" || claim.result_revision_id !== next.id)
    )
      problems.push(
        "The regrade claim does not own the committed next revision.",
      );
    const result = o.regradeResponse?.body?.result;
    if (
      o.regradeResponse?.status !== 200 ||
      result?.status !== "REGRADED" ||
      result.resultRevisionId !== next.id ||
      result.executionId !== claim?.id
    )
      problems.push(
        `A next revision was committed but the regrade did not report REGRADED for it (${result?.status ?? "no result"}).`,
      );
    if (o.scoreNow === o.scoreBefore)
      problems.push(
        "The regrade did not change the course score, so the receipt's lineage cannot be distinguished from the superseded result.",
      );
    const replay = o.replays?.regrade?.body?.result;
    if (
      replay?.status !== "ALREADY_REGRADED" ||
      replay.resultRevisionId !== next.id
    )
      problems.push("Regrade replay did not return the existing regrade.");
  }
  if (order === SERIAL_ORDERS.COMPLETION_FIRST) {
    if (
      claim &&
      (claim.state !== "FAILED" || claim.result_revision_id !== null)
    )
      problems.push(
        `After completion the regrade claim must end FAILED without a result (state ${claim.state}).`,
      );
    if (
      o.regradeResponse?.status !== 200 ||
      o.regradeResponse.body?.result?.status !== "TARGET_NOT_ELIGIBLE"
    )
      problems.push(
        `After completion the regrade must be refused TARGET_NOT_ELIGIBLE (got ${o.regradeResponse?.body?.result?.status ?? "no result"}).`,
      );
    if (receipt && receipt.final_course_score_bp !== o.scoreBefore)
      problems.push(
        "The receipt score is not the score of the result that was authoritative when completion committed.",
      );
    const replay = o.replays?.regrade?.body?.result?.status;
    if (replay === "REGRADED" || replay === "ALREADY_REGRADED")
      problems.push("A regrade replay after completion reported a grade.");
  }

  const completionReplay = o.replays?.completion?.data;
  if (
    completionReplay?.ok !== true ||
    completionReplay.code !== "ALREADY_COMPLETED" ||
    !receipt ||
    completionReplay.receiptId !== receipt.id ||
    o.replays?.historyUnchanged !== true
  )
    problems.push(
      "Completion/regrade replay did not return the existing outcome without new history.",
    );
  return { order, problems };
}

export async function scenarioRegradeVsCompletion(ctx) {
  const surface = APP_RACE_SURFACES.REGRADE_VS_COMPLETION;
  const t = timingFor(ctx);
  const responses = [];
  const course = await ctx.seed("regrade-completion");
  const evidence = [
    `course_package_imports ${course.importId}, activation ${course.activationId}, enrolment ${course.enrolmentId}`,
  ];
  const stop = (reason, details = []) =>
    fail(surface, reason, [...evidence, ...details]);
  await waitForStudentLeasesClear(ctx, course.studentId);
  const noCapacity = await admissionBlock(
    ctx,
    surface,
    course.studentId,
    [ADMISSION_FAMILIES.INITIAL, ADMISSION_FAMILIES.REGRADE],
    evidence,
  );
  if (noCapacity) return noCapacity;

  // A genuine current QUIZ_1 result: real answered responses + the real
  // initial grading FINALIZE -- never a response-less seeded attempt.
  const attemptId = await answerQuiz1(ctx, course);
  const graded = await ctx.app.call(ctx.jars.learner, {
    operation: "SUBMIT_AND_GRADE_ASSESSMENT",
    attemptId,
  });
  responses.push(graded);
  const initial = await ctx.query(RQ.quiz1Revisions, [course.enrolmentId]);
  if (
    graded.status !== 200 ||
    graded.body?.result?.grading !== "GRADED" ||
    initial.length !== 1 ||
    initial[0].valid !== true
  )
    return stop(
      "Could not create a genuine, valid QUIZ_1 result through the real grading path.",
      [
        `grading HTTP ${graded.status} ${graded.body?.result?.grading ?? ""}`.trim(),
        `QUIZ_1 revisions ${initial.length}`,
      ],
    );
  const sourceRevisionId = initial[0].id;
  evidence.push(`attempt ${attemptId}`, `source revision ${sourceRevisionId}`);

  // Every other requirement for legitimate completion readiness.
  await ctx.seedResults(course, true, { excludeComponents: ["QUIZ_1"] });
  const before = (await ctx.query(RQ.progress, [course.enrolmentId]))[0]
    ?.progress;
  const statusBefore = (
    await ctx.query(RQ.enrolmentStatus, [course.enrolmentId])
  )[0]?.status;
  if (
    before?.ok !== true ||
    before.pending?.length !== 0 ||
    !Number.isInteger(before.courseScoreBp) ||
    before.courseScoreBp < before.passMarkBp ||
    statusBefore !== "ACTIVE" ||
    (await ctx.query(RQ.receipts, [course.enrolmentId])).length !== 0
  )
    return stop(
      "The enrolment was not legitimately completion-ready before the race.",
      [
        `status ${statusBefore ?? "none"}`,
        `pending ${before?.pending?.length ?? "unknown"}`,
      ],
    );
  const scoreBefore = before.courseScoreBp;
  const sourceBefore = (
    await ctx.query(Q.revisionSnapshot, [sourceRevisionId])
  )[0];
  const stubBefore = stubCallsFor(ctx.stub, attemptId).length;
  // Re-checked immediately before the fresh regrade admission.
  const noRegradeCapacity = await admissionBlock(
    ctx,
    surface,
    course.studentId,
    [ADMISSION_FAMILIES.REGRADE],
    evidence,
  );
  if (noRegradeCapacity) return noRegradeCapacity;

  // Real regrade AUTHORIZE/START/CONTEXT_READ, then held at the provider.
  const regradeHold = ctx.stub.holdNextProviderResponse();
  const reason = `Concurrency acceptance regrade vs completion ${ctx.runId}`;
  const regradeCall = settle(
    ctx.app.call(ctx.jars.admin, {
      operation: "REGRADE_CONTROLLED_ASSESSMENT",
      resultRevisionId: sourceRevisionId,
      reason,
    }),
  );
  try {
    let arrival;
    try {
      arrival = await within(
        regradeHold.arrived,
        t.arrivalTimeoutMs,
        "The regrade request reaching its provider hold",
      );
    } catch (error) {
      regradeHold.cancel();
      const settled = await within(
        regradeCall,
        t.settleTimeoutMs,
        "regrade",
      ).catch(() => null);
      return stop("The regrade request never reached its provider call.", [
        error.message,
        `regrade: ${settled?.ok ? (settled.value.body?.result?.status ?? settled.value.status) : "no response"}`,
      ]);
    }
    const running = await ctx.query(RQ.regradeClaims, [sourceRevisionId]);
    if (
      arrival.capability !== "regrade_controlled_assessment" ||
      arrival.attemptId !== attemptId ||
      running.length !== 1 ||
      running[0].state !== "RUNNING"
    )
      return stop(
        "The held provider call was not a RUNNING regrade of this source.",
      );

    // One start gate: regrade FINALIZE proceeds AND the learner's real
    // completion RPC is invoked for the same enrolment.
    const gate = createStartGate(2);
    const regradeSide = (async () => {
      await gate.arrive();
      regradeHold.release();
      return regradeCall;
    })();
    const completionSide = settle(
      (async () => {
        await gate.arrive();
        return ctx.learnerClient.rpc(
          "attempt_commercial_v1_course_completion",
          {
            p_enrolment_id: course.enrolmentId,
            p_reason: `Concurrency acceptance completion ${ctx.runId}`,
          },
        );
      })(),
    );
    const [regrade, completion] = await Promise.all([
      within(regradeSide, t.settleTimeoutMs, "The regrade request"),
      within(completionSide, t.settleTimeoutMs, "The completion call"),
    ]);
    const regradeResponse = regrade.ok ? regrade.value : null;
    responses.push(regradeResponse);

    // Independent read of the authoritative state.
    const revisions = await ctx.query(RQ.quiz1Revisions, [course.enrolmentId]);
    const nextRevision = revisions.find((r) => r.id !== sourceRevisionId);
    const questionCount = (
      await ctx.query(Q.questionCount, [course.quiz1AssessmentId])
    )[0]?.n;
    const nextRevisionMarks = nextRevision
      ? await marksFollowRule(
          ctx,
          nextRevision.id,
          "regrade_controlled_assessment",
        )
      : null;
    const regradeClaims = await ctx.query(RQ.regradeClaims, [sourceRevisionId]);
    const enrolmentStatus = (
      await ctx.query(RQ.enrolmentStatus, [course.enrolmentId])
    )[0]?.status;
    const receipts = await ctx.query(RQ.receipts, [course.enrolmentId]);
    const completionAudits = (
      await ctx.query(RQ.completionAudits, [course.enrolmentId])
    )[0]?.n;
    const now = (await ctx.query(RQ.progress, [course.enrolmentId]))[0]
      ?.progress;
    const sourceAfter = (
      await ctx.query(Q.revisionSnapshot, [sourceRevisionId])
    )[0];
    const regradeStubCalls = stubCallsFor(ctx.stub, attemptId).slice(
      stubBefore,
    );
    const regradeHoldOutcome = await regradeHold.settled;

    // Replays create nothing new.
    const completionReplay = await ctx.learnerClient.rpc(
      "attempt_commercial_v1_course_completion",
      {
        p_enrolment_id: course.enrolmentId,
        p_reason: `Concurrency acceptance completion replay ${ctx.runId}`,
      },
    );
    const regradeReplay = await ctx.app.call(ctx.jars.admin, {
      operation: "REGRADE_CONTROLLED_ASSESSMENT",
      resultRevisionId: sourceRevisionId,
      reason,
    });
    responses.push(regradeReplay);
    const historyUnchanged =
      (await ctx.query(RQ.quiz1Revisions, [course.enrolmentId])).length ===
        revisions.length &&
      (await ctx.query(RQ.regradeClaims, [sourceRevisionId])).length ===
        regradeClaims.length &&
      (await ctx.query(RQ.receipts, [course.enrolmentId])).length ===
        receipts.length &&
      (await ctx.query(RQ.completionAudits, [course.enrolmentId]))[0]?.n ===
        completionAudits &&
      stubCallsFor(ctx.stub, attemptId).length ===
        stubBefore + regradeStubCalls.length;

    const { order, problems } = evaluateRegradeCompletionRace({
      sourceRevisionId,
      attemptId,
      studentId: course.studentId,
      regradeActorId: course.recoveryActorId,
      questionCount,
      scoreBefore,
      scoreNow: now?.courseScoreBp ?? null,
      passMarkBp: before.passMarkBp,
      regradeResponse,
      regradeHoldOutcome,
      completion: completion.ok
        ? completion.value
        : { error: completion.error },
      revisions,
      nextRevisionMarks,
      regradeClaims,
      enrolmentStatus,
      receipts,
      completionAudits,
      sourceUnchanged: Boolean(sourceBefore) && same(sourceBefore, sourceAfter),
      regradeStubCalls,
      replays: {
        completion: completionReplay,
        regrade: regradeReplay,
        historyUnchanged,
      },
    });
    leak(problems, responses);
    evidence.push(
      `serial order observed: ${order ?? "none"}`,
      `receipt ${receipts[0]?.id ?? "none"}`,
      `regrade execution ${regradeClaims[0]?.id ?? "none"}`,
    );
    if (problems.length)
      return stop(
        "The regrade vs completion race left state that neither legitimate serial order explains.",
        problems,
      );
    return pass(
      surface,
      order === SERIAL_ORDERS.REGRADE_FIRST
        ? "Real-application race (not a raw insert): an authenticated admin's real regrade passed hosted AUTHORIZE/START/CONTEXT_READ and was held at its provider call; its FINALIZE and the learner's real attempt_commercial_v1_course_completion for the same completion-ready enrolment were then released from one client-side start gate. Observed serial order: REGRADE_FIRST -- exactly one valid next revision was committed and reported REGRADED, and exactly one completion receipt/audit was then written from that new current result (receipt score equals the post-regrade course score). Replays created nothing new. Proves both operations were dispatched together from the client side; does not prove the server transactions overlapped in time."
        : "Real-application race (not a raw insert): an authenticated admin's real regrade passed hosted AUTHORIZE/START/CONTEXT_READ and was held at its provider call; its FINALIZE and the learner's real attempt_commercial_v1_course_completion for the same completion-ready enrolment were then released from one client-side start gate. Observed serial order: COMPLETION_FIRST -- exactly one completion receipt/audit was written from the result authoritative at that moment, the enrolment became COMPLETED, and the regrade's success was refused TARGET_NOT_ELIGIBLE with no next revision committed. Replays created nothing new. Proves both operations were dispatched together from the client side; does not prove the server transactions overlapped in time.",
      evidence,
    );
  } finally {
    regradeHold.cancel();
    await within(regradeCall, t.settleTimeoutMs, "regrade").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Orchestration: one real-application session for both races. Missing
// examiner-app prerequisites (controller key, app driver settings, etc.)
// report BLOCKED -- never NOT_RUN dressed up, never a PASS.
// ---------------------------------------------------------------------------
export async function runAppRaceScenarios({
  open = openExaminerAppSession,
} = {}) {
  const surfaces = Object.values(APP_RACE_SURFACES);
  let opened = null;
  try {
    opened = await open({ contextHold: true });
    if (opened.refusal)
      return surfaces.map((surface) =>
        blocked(surface, opened.refusal.reason, opened.refusal.details),
      );
    const ctx = opened.session;
    const late = await guardScenario(APP_RACE_SURFACES.LATE_INITIAL, () =>
      scenarioLateInitialFinalizeVsRecovery(ctx),
    );
    const regrade = await guardScenario(
      APP_RACE_SURFACES.REGRADE_VS_COMPLETION,
      () => scenarioRegradeVsCompletion(ctx),
    );
    return [late, regrade];
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return surfaces.map((surface) => blocked(surface, error.message));
    return surfaces.map((surface) =>
      fail(surface, "The application race session stopped unexpectedly.", [
        error instanceof Error ? error.message : String(error),
      ]),
    );
  } finally {
    await opened?.close();
  }
}
