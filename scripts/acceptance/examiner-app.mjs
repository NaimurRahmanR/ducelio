#!/usr/bin/env node
// npm run acceptance:examiner-app
//
// Real-application acceptance for EXAMINER_APP:GRADING,
// EXAMINER_APP:INITIAL_RECOVERY and EXAMINER_APP:REGRADE (docs/38).
//
// The ordinary direct harness (surfaces.mjs) deliberately BLOCKS these three
// surfaces: their HMAC canonical message is built in exactly one place,
// src/server/commercial-v1-examiner-*/authority.ts, and no acceptance
// script may build a second one. This driver therefore never signs
// anything. It starts the REAL Ducelio Next.js server locally (`next dev`,
// loopback only) against the hosted acceptance Supabase project and drives
// the EXISTING production entrypoints over HTTP through the fail-closed,
// acceptance-only route src/app/api/acceptance/examiner-app/route.ts:
//
//   learner session  -> submitControlledAssessmentAndGrade
//                       -> gradeControlledAssessmentAttempt -> authority.ts
//   admin session    -> recoverExaminerTarget -> recovery authority.ts
//   admin session    -> regradeControlledAssessment -> regrade authority.ts
//
// Sessions are genuine hosted Supabase Auth sessions held as the app's own
// SSR cookies (in memory only, never printed). Every institutional outcome
// is then verified independently, read-only, against the hosted database.
//
// Provider: a deterministic LOCAL stub (examiner-provider-stub.mjs) speaking
// the OpenAI Responses contract the real adapter already uses; the child app
// is given only a per-run stub key, and every other request to a real AI
// vendor is refused inside that process. Loading the preload through
// NODE_OPTIONS is NOT relied on as proof: the route gate attests, per
// request and inside the exact process serving it, that the CURRENT
// globalThis.fetch routes through the redirect wrapper marked with this
// run's ACCEPTANCE_PROVIDER_REDIRECT_TOKEN (src/server/acceptance-app-
// driver.ts's providerRedirectAttested) -- otherwise the route answers 404,
// readiness reports GATE_REFUSED and every surface is BLOCKED before any
// sign-in or fixture write. Results are therefore evidence of hosted HMAC
// authority/FINALIZE behaviour -- never LIVE_PROVIDER evidence, and never a
// substitute for docs/38 section 4's adversarial MAC cases (tampered,
// expired, cross-protocol), which this driver does not execute.
//
// Writes: this run creates two permanent, run-id-tagged acceptance courses
// through the SAME gated governed fixtures every other acceptance script
// uses (seedAcceptanceCourse: ACCEPTANCE_WRITE_ENABLED + marker row +
// hosted environment id, all required), plus the institutional history the
// production entrypoints themselves write. Nothing is ever deleted.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  withConnection,
  acceptanceDbConfigured,
  AcceptanceWriteNotAuthorizedError,
} from "./db.mjs";
import { isConfigured } from "./env.mjs";
import {
  hostedSupabaseConfigured,
  acceptanceIdentities,
  acceptanceIdentitiesConfigured,
  foreignLearnerIdentityConfigured,
  unrelatedStaffIdentityConfigured,
} from "./supabase.mjs";
import { seedAcceptanceCourse, seedAcceptanceResults } from "./fixtures.mjs";
import { startProviderStub, stubMarks } from "./examiner-provider-stub.mjs";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
} from "./report.mjs";

export const SURFACES = Object.freeze({
  GRADING: "EXAMINER_APP:GRADING",
  INITIAL_RECOVERY: "EXAMINER_APP:INITIAL_RECOVERY",
  REGRADE: "EXAMINER_APP:REGRADE",
});
export const ROUTE_PATH = "/api/acceptance/examiner-app";
export const DRIVER_HEADER = "x-ducelio-acceptance-driver";
export const TRUTHFULNESS_STATEMENT =
  "These results prove only the named hosted application authority surfaces (EXAMINER_APP:GRADING, EXAMINER_APP:INITIAL_RECOVERY, EXAMINER_APP:REGRADE) driven through the real Ducelio application server with a deterministic local provider stub. They are not production-readiness proof, not LIVE_PROVIDER proof and not evidence of grading quality, and they do not execute docs/38 section 4's adversarial tampered/expired/cross-protocol MAC cases (those remain separate local evidence).";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NEXT_BIN = fileURLToPath(
  new URL("../../node_modules/next/dist/bin/next", import.meta.url),
);
// The checkout the acceptance app server runs: this file's own repository
// and its own Next.js binary, never another worktree.
export const APP_CHECKOUT = Object.freeze({
  root: REPO_ROOT,
  nextBin: NEXT_BIN,
});
const PRELOAD = fileURLToPath(
  new URL("./examiner-provider-redirect.mjs", import.meta.url),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exactly the authority modules' own structural rule (lowercase only).
const CONTROLLER_KEY_HEX = /^[0-9a-f]{64}$/;
const LEARNER_RESPONSE = "Synthetic acceptance learner response.";
// Protected content that must never appear in any HTTP response: the
// acceptance package's expected answer and lab grading guidance
// (fixtures.mjs), plus the context field names that carry them.
export const PROTECTED_MARKERS = Object.freeze([
  "Acceptance answer.",
  "Acceptance grading guidance.",
  "expectedAnswer",
  "markingGuidance",
]);

// ---------------------------------------------------------------------------
// Prerequisites. Names only -- a value is never read into a message.
// ---------------------------------------------------------------------------
export function examinerAppPrerequisites(env = process.env) {
  const missing = [];
  if (!acceptanceDbConfigured()) missing.push("ACCEPTANCE_DATABASE_URL");
  if (!hostedSupabaseConfigured())
    missing.push(
      "NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  if (!acceptanceIdentitiesConfigured())
    missing.push(
      "ACCEPTANCE_ADMIN_EMAIL/PASSWORD and ACCEPTANCE_LEARNER_EMAIL/PASSWORD",
    );
  if (!isConfigured("ACCEPTANCE_ENVIRONMENT_ID"))
    missing.push("ACCEPTANCE_ENVIRONMENT_ID");
  if (env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    missing.push("ACCEPTANCE_WRITE_ENABLED");
  if (!UUID.test(env.ACADEMIC_EXECUTION_KEY_ID?.trim() ?? ""))
    missing.push("ACADEMIC_EXECUTION_KEY_ID");
  if (!CONTROLLER_KEY_HEX.test(env.ACADEMIC_EXECUTION_HMAC_KEY_HEX ?? ""))
    missing.push("ACADEMIC_EXECUTION_HMAC_KEY_HEX");
  if (!existsSync(NEXT_BIN)) missing.push("node_modules/next (npm install)");
  if (!existsSync(PRELOAD))
    missing.push("scripts/acceptance/examiner-provider-redirect.mjs");
  return missing;
}

export function blockedAll(reason, details = []) {
  return Object.values(SURFACES).map((surface) =>
    blocked(surface, reason, details),
  );
}

// ---------------------------------------------------------------------------
// HTTP client: one in-memory cookie jar per identity. Cookie values are
// session secrets -- they are never printed or returned.
// ---------------------------------------------------------------------------
export function createCookieJar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    absorb(response) {
      const lines = response.headers.getSetCookie?.() ?? [];
      for (const line of lines) {
        const [pair, ...attributes] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attributes.some((attribute) => {
          const [key, raw = ""] = attribute.split("=");
          const k = key.trim().toLowerCase();
          if (k === "max-age") return Number(raw.trim()) <= 0;
          if (k === "expires") return Date.parse(raw.trim()) <= Date.now();
          return false;
        });
        if (!value || expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    get size() {
      return cookies.size;
    },
  };
}

// `routePath` defaults to the examiner-app route; the customer-journey
// driver binds a second client, with the same per-run token, to its own
// acceptance route (see openExaminerAppSession's routeClient).
export function createAppDriverClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  routePath = ROUTE_PATH,
}) {
  return {
    async call(jar, payload) {
      const response = await fetchImpl(`${baseUrl}${routePath}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [DRIVER_HEADER]: token,
          ...(jar && jar.size ? { cookie: jar.header() } : {}),
        },
        body: JSON.stringify(payload),
      });
      jar?.absorb(response);
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status, body, text };
    },
  };
}

// ---------------------------------------------------------------------------
// The local application server. Its environment is the operator's own
// (hosted Supabase URL/publishable key, ACADEMIC_EXECUTION_* controller
// key, ACCEPTANCE_ENVIRONMENT_ID) minus everything the app must not hold:
// the privileged acceptance database URL, acceptance credentials and real
// provider/payment keys are forced to empty strings, which Next.js's own
// .env loader never overrides.
// ---------------------------------------------------------------------------
const WITHHELD_FROM_APP = [
  "ACCEPTANCE_DATABASE_URL",
  "ACCEPTANCE_DATABASE_INSECURE_TLS",
  "ACCEPTANCE_WRITE_ENABLED",
  "ACCEPTANCE_EXPIRED_LEARNER_JWT",
  "ACCEPTANCE_LIVE_PROVIDER_OPT_IN",
  "ACCEPTANCE_STRIPE_LIVE_OPT_IN",
  "ANTHROPIC_API_KEY",
  "ACADEMIC_PROVIDER_BASE_URL",
  "ACADEMIC_PROVIDER_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "COMMERCE_CONTROLLER_KEY_ID",
  "COMMERCE_CONTROLLER_HMAC_KEY_HEX",
];

const PER_RUN_TOKEN = /^[0-9a-f]{64}$/;

// `contextHold` is passed ONLY by the concurrency driver
// (concurrency-app-races.mjs): the stub's context-read control endpoint and
// its own per-run token. Otherwise both variables are forced empty, so a
// stray parent value can never enable the hold in an examiner-app child.
//
// `journey` is passed ONLY by the customer-journey driver
// (customer-journey.mjs): it enables that driver's own acceptance route
// (ACCEPTANCE_JOURNEY_DRIVER_ENABLED), redirects the Lab Instructor's
// Anthropic Messages adapter to the SAME loopback stub (journey mode) and
// hands that adapter the per-run stub key. Otherwise all three are forced
// empty, exactly like the other withheld names.
export function buildAppChildEnv(
  parentEnv,
  { port, token, redirectToken, stub, contextHold = null, journey = false },
) {
  if (
    !PER_RUN_TOKEN.test(token ?? "") ||
    !PER_RUN_TOKEN.test(redirectToken ?? "") ||
    (contextHold && !PER_RUN_TOKEN.test(contextHold.token ?? ""))
  )
    throw new Error(
      "Per-run acceptance tokens must be 64 lowercase hex characters.",
    );
  if (journey && !stub.anthropicUrl)
    throw new Error(
      "The customer-journey child needs a journey-mode provider stub.",
    );
  const env = { ...parentEnv };
  for (const name of Object.keys(env))
    if (/^ACCEPTANCE_.*_(EMAIL|PASSWORD)$/.test(name)) env[name] = "";
  for (const name of WITHHELD_FROM_APP) env[name] = "";
  delete env.NODE_ENV;
  return {
    ...env,
    ACCEPTANCE_APP_DRIVER_ENABLED: "true",
    ACCEPTANCE_APP_DRIVER_TOKEN: token,
    ACCEPTANCE_PROVIDER_STUB_URL: stub.url,
    ACCEPTANCE_PROVIDER_REDIRECT_TOKEN: redirectToken,
    ACCEPTANCE_CONTEXT_HOLD_URL: contextHold?.url ?? "",
    ACCEPTANCE_CONTEXT_HOLD_TOKEN: contextHold?.token ?? "",
    ACCEPTANCE_JOURNEY_DRIVER_ENABLED: journey ? "true" : "",
    ACCEPTANCE_PROVIDER_ANTHROPIC_STUB_URL: journey ? stub.anthropicUrl : "",
    // WITHHELD_FROM_APP already forced the real key empty above.
    ANTHROPIC_API_KEY: journey ? stub.apiKey : "",
    OPENAI_API_KEY: stub.apiKey,
    APP_URL: `http://127.0.0.1:${port}`,
    NODE_OPTIONS: `--import=${pathToFileURL(PRELOAD).href}`,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startAppServer(env, port) {
  const child = spawn(
    process.execPath,
    [
      NEXT_BIN,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      `${port}`,
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  // App output is deliberately NOT forwarded: a framework error page or
  // log line could echo configuration. Only its exit is observed.
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function stopAppServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", `${child.pid}`, "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}

// Ready = the acceptance route compiled AND its gate admitted this driver
// in the process serving the request -- including the per-request
// attestation that the CURRENT fetch there routes through the marked
// provider redirect: an empty-body POST passes the gate and is then refused
// 400 by strict input validation. 404 means the gate refused, e.g. the
// redirect is not live in that process (never retried as success). This
// happens before any sign-in or seedAcceptanceCourse call.
async function waitForAppReady(app, child, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return "EXITED";
    try {
      const { status } = await app.call(null, {});
      if (status === 400) return "READY";
      if (status === 404) return "GATE_REFUSED";
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "TIMEOUT";
}

// ---------------------------------------------------------------------------
// Scenario helpers.
// ---------------------------------------------------------------------------
export const Q = {
  initialExecutions: `select e.id, e.state, e.reason_code, e.student_id, e.enrolment_id, e.activation_id,
      e.capability, e.runtime_profile_ref, e.grade_digest, e.result_revision_id, u.provider_calls
    from commercial_v1_examiner_executions e
    left join commercial_v1_examiner_execution_usage u on u.execution_id=e.id
    where e.attempt_id=$1`,
  revisions: `select r.id, r.revision_number, r.attempt_id, r.earned_marks_total, r.max_marks_total,
      commercial_v1_private.assessment_result_is_valid(r.id) as valid,
      (select count(*)::int from commercial_v1_assessment_objective_outcomes o where o.result_revision_id=r.id) as outcome_rows
    from commercial_v1_assessment_result_revisions r
    where r.enrolment_id=$1 and r.component='QUIZ_1' order by r.revision_number`,
  marks: `select m.question_id, m.marks_awarded, q.max_marks
    from commercial_v1_assessment_question_marks m
    join assessment_questions q on q.id=m.question_id
    where m.result_revision_id=$1`,
  questionCount: `select count(*)::int as n from assessment_questions where assessment_id=$1`,
  revisionSnapshot: `select to_jsonb(r) as revision,
      (select coalesce(jsonb_agg(to_jsonb(m) order by m.question_id), '[]'::jsonb)
         from commercial_v1_assessment_question_marks m where m.result_revision_id=r.id) as marks
    from commercial_v1_assessment_result_revisions r where r.id=$1`,
  executionSnapshot: `select to_jsonb(e) as execution from commercial_v1_examiner_executions e where e.id=$1`,
  regradeExecutions: `select e.id, e.state, e.actor_id, e.student_id, e.result_revision_id, u.provider_calls
    from commercial_v1_examiner_regrade_executions e
    left join commercial_v1_examiner_regrade_usage u on u.execution_id=e.id
    where e.source_result_revision_id=$1`,
  recoveryExecutions: `select e.id, e.state, e.actor_id, e.student_id, e.result_revision_id, u.provider_calls
    from commercial_v1_examiner_recovery_executions e
    left join commercial_v1_examiner_recovery_usage u on u.execution_id=e.id
    where e.source_execution_id=$1`,
};

export function leakedProtectedContent(texts) {
  return PROTECTED_MARKERS.filter((marker) =>
    texts.some((text) => typeof text === "string" && text.includes(marker)),
  );
}

export function stubCallsFor(stub, attemptId) {
  return stub.calls.filter((c) => c.attemptId === attemptId);
}

async function rpcData(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} was refused.`);
  return data;
}

// A real learner attempt with every question answered, through the
// learner's own authenticated hosted session (RLS/grants apply). Protected
// question content is never read (get_active_assessment_questions returns
// no answer key) and never logged.
export async function answerQuiz1(ctx, course) {
  const attemptId = await rpcData(
    ctx.learnerClient,
    "start_assessment_attempt",
    {
      p_assessment_id: course.quiz1AssessmentId,
    },
  );
  const questions = await rpcData(
    ctx.learnerClient,
    "get_active_assessment_questions",
    { p_assessment_id: course.quiz1AssessmentId },
  );
  if (!Array.isArray(questions) || questions.length === 0)
    throw new Error("The acceptance QUIZ_1 exposes no questions.");
  for (const question of questions) {
    const recorded = await rpcData(
      ctx.learnerClient,
      "record_commercial_v1_assessment_response",
      {
        p_attempt_id: attemptId,
        p_question_id: question.id,
        p_body: LEARNER_RESPONSE,
        p_idempotency_key: randomUUID(),
      },
    );
    if (recorded?.ok !== true)
      throw new Error(
        `record_commercial_v1_assessment_response refused (${recorded?.code ?? "unknown"}).`,
      );
  }
  return attemptId;
}

// Marks the deterministic stub rule implies for a revision's real rows.
export async function marksFollowRule(ctx, revisionId, capability) {
  const rows = await ctx.query(Q.marks, [revisionId]);
  const expected = stubMarks(
    capability,
    rows.map((r) => ({ questionId: r.question_id, maxMarks: r.max_marks })),
  );
  const earned = expected.reduce((sum, m) => sum + m.marksAwarded, 0);
  const matches = rows.every(
    (r, i) => r.marks_awarded === expected[i].marksAwarded,
  );
  return { rows: rows.length, matches, earned };
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const recordLeaks = (problems, responses) => {
  const leaked = leakedProtectedContent(responses.map((r) => r.text));
  if (leaked.length)
    problems.push(
      `An HTTP response contained protected assessment content markers (${leaked.length}).`,
    );
};

// ---------------------------------------------------------------------------
// EXAMINER_APP:GRADING
// ---------------------------------------------------------------------------
export async function scenarioGrading(ctx, course) {
  const problems = [];
  const responses = [];
  const attemptId = await answerQuiz1(ctx, course);
  const first = await ctx.app.call(ctx.jars.learner, {
    operation: "SUBMIT_AND_GRADE_ASSESSMENT",
    attemptId,
  });
  responses.push(first);
  if (
    first.status !== 200 ||
    first.body?.result?.attemptId !== attemptId ||
    first.body.result.grading !== "GRADED"
  )
    problems.push(
      `Learner submit-and-grade did not report GRADED (HTTP ${first.status}, ${first.body?.result?.grading ?? first.body?.error ?? "no result"}).`,
    );

  const executions = await ctx.query(Q.initialExecutions, [attemptId]);
  const execution = executions.length === 1 ? executions[0] : null;
  if (!execution)
    problems.push(
      `Expected exactly one initial Examiner execution for the attempt; found ${executions.length} (zero means hosted AUTHORIZE refused the attestation -- check the controller key).`,
    );
  else if (
    execution.state !== "SUCCEEDED" ||
    execution.student_id !== course.studentId ||
    execution.enrolment_id !== course.enrolmentId ||
    execution.activation_id !== course.activationId ||
    execution.capability !== "grade_controlled_assessment" ||
    execution.runtime_profile_ref !== "EXAMINER_COMMERCIAL_V1" ||
    !execution.grade_digest ||
    !execution.result_revision_id ||
    execution.provider_calls !== 1
  )
    problems.push(
      `Initial execution is not a coherent learner-owned SUCCEEDED execution (state ${execution.state}, reason ${execution.reason_code ?? "none"}).`,
    );

  const revisions = await ctx.query(Q.revisions, [course.enrolmentId]);
  const revision = revisions.length === 1 ? revisions[0] : null;
  const questionCount = (
    await ctx.query(Q.questionCount, [course.quiz1AssessmentId])
  )[0]?.n;
  if (!revision)
    problems.push(
      `Expected exactly one QUIZ_1 result revision; found ${revisions.length}.`,
    );
  else {
    const marks = await marksFollowRule(
      ctx,
      revision.id,
      "grade_controlled_assessment",
    );
    if (
      revision.id !== execution?.result_revision_id ||
      revision.revision_number !== 1 ||
      revision.attempt_id !== attemptId ||
      revision.valid !== true ||
      revision.outcome_rows < 1 ||
      marks.rows !== questionCount ||
      !marks.matches ||
      revision.earned_marks_total !== marks.earned
    )
      problems.push(
        "The authoritative revision's provenance, question marks, objective outcomes or validity are incoherent.",
      );
  }
  const graded = stubCallsFor(ctx.stub, attemptId);
  if (
    graded.length !== 1 ||
    graded[0].capability !== "grade_controlled_assessment" ||
    graded[0].outcome !== "GRADED"
  )
    problems.push(
      `Expected exactly one provider-stub grading call for the attempt; saw ${graded.length}.`,
    );

  // Replay: the same learner request again must not create a second
  // execution, provider call or result.
  const replay = await ctx.app.call(ctx.jars.learner, {
    operation: "SUBMIT_AND_GRADE_ASSESSMENT",
    attemptId,
  });
  responses.push(replay);
  const replayExecutions = await ctx.query(Q.initialExecutions, [attemptId]);
  const replayRevisions = await ctx.query(Q.revisions, [course.enrolmentId]);
  if (
    replay.status !== 200 ||
    replay.body?.result?.grading !== "GRADED" ||
    replayExecutions.length !== 1 ||
    replayExecutions[0].id !== execution?.id ||
    replayRevisions.length !== 1 ||
    replayRevisions[0].id !== revision?.id ||
    stubCallsFor(ctx.stub, attemptId).length !== 1
  )
    problems.push(
      "Replay created additional execution/result/provider history or did not return the existing grade.",
    );
  recordLeaks(problems, responses);

  const evidence = [
    `attempt ${attemptId}`,
    `execution ${execution?.id ?? "none"}`,
    `result revision ${revision?.id ?? "none"}`,
  ];
  return {
    result: problems.length
      ? fail(
          SURFACES.GRADING,
          "Real-app grading did not meet every acceptance invariant.",
          [...evidence, ...problems],
        )
      : pass(
          SURFACES.GRADING,
          "A real learner session drove the existing submission/grading composition through the real app server; hosted HMAC authority admitted it, the provider path ran once, FINALIZE wrote exactly one valid, coherent revision, and replay created nothing new.",
          evidence,
        ),
    revisionId: revision?.valid === true ? revision.id : null,
    attemptId,
  };
}

// Non-admin sessions must never obtain a regrade/recovery through this path.
async function deniedToNonAdmins(
  ctx,
  payload,
  grantedStatuses,
  countRows,
  problems,
  responses,
) {
  const identities = [["learner", ctx.jars.learner]];
  if (ctx.jars.staff) identities.push(["unrelated staff", ctx.jars.staff]);
  for (const [label, jar] of identities) {
    const response = await ctx.app.call(jar, payload);
    responses.push(response);
    const status = response.body?.result?.status;
    if (response.status !== 200 || !status || grantedStatuses.includes(status))
      problems.push(
        `A ${label} session was not refused (HTTP ${response.status}).`,
      );
    if ((await countRows()) !== 0)
      problems.push(`A ${label} session created institutional history.`);
  }
}

// ---------------------------------------------------------------------------
// EXAMINER_APP:REGRADE -- uses GRADING's own valid, current revision 1.
// ---------------------------------------------------------------------------
export async function scenarioRegrade(ctx, course, graded) {
  if (!graded?.revisionId)
    return blocked(
      SURFACES.REGRADE,
      "Requires the valid current result revision EXAMINER_APP:GRADING produces; none is available in this run.",
    );
  const problems = [];
  const responses = [];
  const source = graded.revisionId;
  const reason = `Examiner app acceptance regrade ${ctx.runId}`;
  const before = (await ctx.query(Q.revisionSnapshot, [source]))[0];
  const granted = ["REGRADED", "ALREADY_REGRADED"];
  const regradeRows = async (id) =>
    (await ctx.query(Q.regradeExecutions, [id])).length;

  await deniedToNonAdmins(
    ctx,
    {
      operation: "REGRADE_CONTROLLED_ASSESSMENT",
      resultRevisionId: source,
      reason,
    },
    granted,
    () => regradeRows(source),
    problems,
    responses,
  );

  const unknownSource = randomUUID();
  const wrong = await ctx.app.call(ctx.jars.admin, {
    operation: "REGRADE_CONTROLLED_ASSESSMENT",
    resultRevisionId: unknownSource,
    reason,
  });
  responses.push(wrong);
  if (
    wrong.status !== 200 ||
    granted.includes(wrong.body?.result?.status) ||
    (await regradeRows(unknownSource)) !== 0
  )
    problems.push("A nonexistent source revision was not refused.");

  const stubBefore = stubCallsFor(ctx.stub, graded.attemptId).length;
  const first = await ctx.app.call(ctx.jars.admin, {
    operation: "REGRADE_CONTROLLED_ASSESSMENT",
    resultRevisionId: source,
    reason,
  });
  responses.push(first);
  const outcome = first.body?.result ?? {};
  if (
    first.status !== 200 ||
    outcome.status !== "REGRADED" ||
    !outcome.executionId ||
    !outcome.resultRevisionId
  )
    problems.push(
      `Admin regrade did not report REGRADED (HTTP ${first.status}, ${outcome.status ?? first.body?.error ?? "no result"}).`,
    );

  const claims = await ctx.query(Q.regradeExecutions, [source]);
  const claim = claims.length === 1 ? claims[0] : null;
  if (
    !claim ||
    claim.id !== outcome.executionId ||
    claim.state !== "SUCCEEDED" ||
    claim.actor_id !== course.recoveryActorId ||
    claim.student_id !== course.studentId ||
    claim.result_revision_id !== outcome.resultRevisionId ||
    claim.provider_calls !== 1
  )
    problems.push(
      `Expected exactly one coherent admin-owned SUCCEEDED regrade claim; found ${claims.length}.`,
    );

  const revisions = await ctx.query(Q.revisions, [course.enrolmentId]);
  const latest = revisions[revisions.length - 1];
  if (revisions.length !== 2 || latest?.id !== outcome.resultRevisionId)
    problems.push(
      `Expected revision 1 plus exactly one new current revision; found ${revisions.length}.`,
    );
  else {
    const marks = await marksFollowRule(
      ctx,
      latest.id,
      "regrade_controlled_assessment",
    );
    if (
      latest.revision_number !== 2 ||
      latest.attempt_id !== graded.attemptId ||
      latest.valid !== true ||
      latest.outcome_rows < 1 ||
      !marks.matches ||
      latest.earned_marks_total !== marks.earned
    )
      problems.push(
        "The regrade revision's number, marks, objective outcomes or validity are incoherent.",
      );
  }
  const after = (await ctx.query(Q.revisionSnapshot, [source]))[0];
  if (!before || !same(before, after))
    problems.push(
      "The source revision or its question marks changed; revision history must be immutable.",
    );
  const regradeCalls = stubCallsFor(ctx.stub, graded.attemptId).slice(
    stubBefore,
  );
  if (
    regradeCalls.length !== 1 ||
    regradeCalls[0].capability !== "regrade_controlled_assessment"
  )
    problems.push(
      `Expected exactly one provider-stub regrade call; saw ${regradeCalls.length}.`,
    );

  // Replay, then the now-stale source with a different reason. Migration
  // 032 checks the existing claim BEFORE currency, so both return the
  // existing claim's outcome and must create nothing.
  for (const [label, replayReason] of [
    ["Replay", reason],
    ["Stale-source request", `${reason} (stale source)`],
  ]) {
    const replay = await ctx.app.call(ctx.jars.admin, {
      operation: "REGRADE_CONTROLLED_ASSESSMENT",
      resultRevisionId: source,
      reason: replayReason,
    });
    responses.push(replay);
    if (
      replay.status !== 200 ||
      replay.body?.result?.status !== "ALREADY_REGRADED" ||
      replay.body.result.executionId !== outcome.executionId ||
      replay.body.result.resultRevisionId !== outcome.resultRevisionId ||
      (await regradeRows(source)) !== 1 ||
      (await ctx.query(Q.revisions, [course.enrolmentId])).length !== 2 ||
      stubCallsFor(ctx.stub, graded.attemptId).length !== stubBefore + 1
    )
      problems.push(
        `${label} did not return the existing regrade without creating new history.`,
      );
  }
  recordLeaks(problems, responses);

  const evidence = [
    `source revision ${source}`,
    `regrade execution ${outcome.executionId ?? "none"}`,
    `new revision ${outcome.resultRevisionId ?? "none"}`,
  ];
  return problems.length
    ? fail(
        SURFACES.REGRADE,
        "Real-app regrade did not meet every acceptance invariant.",
        [...evidence, ...problems],
      )
    : pass(
        SURFACES.REGRADE,
        "An authenticated institutional admin regraded the current valid revision through the real app server; hosted regrade HMAC authority admitted it, exactly one next revision was written atomically and is current and valid, the source revision is unchanged, non-admins and an unknown source were refused, and replay/stale-source requests returned the existing regrade without new history.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// EXAMINER_APP:INITIAL_RECOVERY -- its own separate course: a genuinely
// recoverable initial execution is created through production code (the
// stub answers the learner's grading call with HTTP 503 ->
// PROVIDER_UNAVAILABLE), never by writing an execution row directly.
// ---------------------------------------------------------------------------
export async function scenarioInitialRecovery(ctx, course) {
  const problems = [];
  const responses = [];
  const attemptId = await answerQuiz1(ctx, course);
  ctx.stub.planFailure();
  const graded = await ctx.app.call(ctx.jars.learner, {
    operation: "SUBMIT_AND_GRADE_ASSESSMENT",
    attemptId,
  });
  responses.push(graded);
  const originals = await ctx.query(Q.initialExecutions, [attemptId]);
  const original = originals.length === 1 ? originals[0] : null;
  if (
    graded.status !== 200 ||
    graded.body?.result?.grading !== "GRADING_UNAVAILABLE" ||
    !original ||
    original.state !== "FAILED" ||
    original.reason_code !== "PROVIDER_UNAVAILABLE" ||
    original.result_revision_id !== null ||
    (await ctx.query(Q.revisions, [course.enrolmentId])).length !== 0
  )
    return fail(
      SURFACES.INITIAL_RECOVERY,
      "Could not create a genuinely recoverable initial execution through the real grading path.",
      [
        `attempt ${attemptId}`,
        `initial executions ${originals.length}`,
        `state ${original?.state ?? "none"}`,
      ],
    );
  const source = original.id;
  const originalBefore = (await ctx.query(Q.executionSnapshot, [source]))[0];
  const target = await rpcData(
    ctx.adminClient,
    "get_commercial_v1_examiner_recovery_target",
    {
      p_source_execution_id: source,
    },
  );
  if (target?.recoveryStatus !== "ELIGIBLE")
    problems.push(
      "The institutional recovery target read did not report the source as ELIGIBLE.",
    );

  const reason = `Examiner app acceptance recovery ${ctx.runId}`;
  const granted = ["RECOVERED", "ALREADY_RECOVERED"];
  const recoveryRows = async () =>
    (await ctx.query(Q.recoveryExecutions, [source])).length;
  await deniedToNonAdmins(
    ctx,
    { operation: "RECOVER_EXAMINER_TARGET", sourceExecutionId: source, reason },
    granted,
    recoveryRows,
    problems,
    responses,
  );

  const stubBefore = stubCallsFor(ctx.stub, attemptId).length;
  const first = await ctx.app.call(ctx.jars.admin, {
    operation: "RECOVER_EXAMINER_TARGET",
    sourceExecutionId: source,
    reason,
  });
  responses.push(first);
  const outcome = first.body?.result ?? {};
  if (
    first.status !== 200 ||
    outcome.status !== "RECOVERED" ||
    !outcome.resultRevisionId
  )
    problems.push(
      `Admin recovery did not report RECOVERED (HTTP ${first.status}, ${outcome.status ?? first.body?.error ?? "no result"}).`,
    );
  const claims = await ctx.query(Q.recoveryExecutions, [source]);
  const claim = claims.length === 1 ? claims[0] : null;
  if (
    !claim ||
    claim.state !== "SUCCEEDED" ||
    claim.actor_id !== course.recoveryActorId ||
    claim.student_id !== course.studentId ||
    claim.result_revision_id !== outcome.resultRevisionId ||
    claim.provider_calls !== 1
  )
    problems.push(
      `Expected exactly one coherent admin-owned SUCCEEDED recovery claim; found ${claims.length}.`,
    );
  const revisions = await ctx.query(Q.revisions, [course.enrolmentId]);
  const revision = revisions.length === 1 ? revisions[0] : null;
  if (!revision || revision.id !== outcome.resultRevisionId)
    problems.push(
      `Expected exactly one recovered result revision; found ${revisions.length}.`,
    );
  else {
    const marks = await marksFollowRule(
      ctx,
      revision.id,
      "grade_controlled_assessment",
    );
    if (
      revision.revision_number !== 1 ||
      revision.attempt_id !== attemptId ||
      revision.valid !== true ||
      revision.outcome_rows < 1 ||
      !marks.matches ||
      revision.earned_marks_total !== marks.earned
    )
      problems.push(
        "The recovered revision's provenance, marks, objective outcomes or validity are incoherent.",
      );
  }
  const originalAfter = (await ctx.query(Q.executionSnapshot, [source]))[0];
  if (!originalBefore || !same(originalBefore, originalAfter))
    problems.push(
      "The original initial execution changed; its history must remain immutable.",
    );
  const recoveryCalls = stubCallsFor(ctx.stub, attemptId).slice(stubBefore);
  if (recoveryCalls.length !== 1 || recoveryCalls[0].outcome !== "GRADED")
    problems.push(
      `Expected exactly one provider-stub recovery call; saw ${recoveryCalls.length}.`,
    );

  const replay = await ctx.app.call(ctx.jars.admin, {
    operation: "RECOVER_EXAMINER_TARGET",
    sourceExecutionId: source,
    reason,
  });
  responses.push(replay);
  if (
    replay.status !== 200 ||
    replay.body?.result?.status !== "ALREADY_RECOVERED" ||
    replay.body.result.resultRevisionId !== outcome.resultRevisionId ||
    (await recoveryRows()) !== 1 ||
    (await ctx.query(Q.revisions, [course.enrolmentId])).length !== 1 ||
    stubCallsFor(ctx.stub, attemptId).length !== stubBefore + 1
  )
    problems.push(
      "Replay did not return the existing recovery without creating new history.",
    );
  recordLeaks(problems, responses);

  const evidence = [
    `source execution ${source}`,
    `recovery result revision ${outcome.resultRevisionId ?? "none"}`,
  ];
  return problems.length
    ? fail(
        SURFACES.INITIAL_RECOVERY,
        "Real-app initial-grade recovery did not meet every acceptance invariant.",
        [...evidence, ...problems],
      )
    : pass(
        SURFACES.INITIAL_RECOVERY,
        "A genuinely recoverable (FAILED/PROVIDER_UNAVAILABLE) initial execution created by the real grading path was recovered by an authenticated institutional admin through recoverExaminerTarget on the real app server; hosted recovery HMAC authority admitted exactly one claim, one valid revision resulted, the original execution is unchanged, non-admins were refused, and replay created nothing new.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------
async function controllerKeyInstalled(keyId) {
  const { rows } = await withConnection((c) =>
    c.query(
      "select exists(select 1 from academic_execution_private.controller_keys where id=$1 and revoked_at is null) as present",
      [keyId],
    ),
  );
  return rows[0]?.present === true;
}

export async function guardScenario(surface, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blocked(surface, error.message);
    return fail(surface, "Scenario stopped unexpectedly.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function signInThroughApp(app, jar, emailVar, passwordVar) {
  const response = await app.call(jar, {
    operation: "SIGN_IN",
    email: process.env[emailVar],
    password: process.env[passwordVar],
  });
  return response.status === 200 && response.body?.ok === true && jar.size > 0;
}

// ---------------------------------------------------------------------------
// The shared real-application session: prerequisite checks, the local
// provider stub, the fail-closed app child, readiness and genuine app
// sign-ins. Used by runExaminerAppAcceptance below and by the concurrency
// driver's application races (concurrency-app-races.mjs), so this
// security-relevant startup exists exactly once.
//
// Always returns `close` (idempotent) plus either a `refusal`
// ({reason, details} -- the caller reports BLOCKED) or a `session`. Throws
// only for an unexpected error, after closing everything it opened.
// `startApp` exists only so tests can observe the child environment the
// driver generates without spawning Next.js. `contextHold` enables the
// concurrency driver's context-read delivery hold in the child; it is never
// set by runExaminerAppAcceptance. `journey` (customer-journey.mjs only)
// starts the stub in journey mode, builds the journey child environment
// (buildAppChildEnv), additionally requires and signs in the synthetic
// FOREIGN learner, and exposes both learners' hosted Auth user ids.
// ---------------------------------------------------------------------------
export async function openExaminerAppSession({
  startApp = startAppServer,
  contextHold = false,
  journey = false,
  // CP2 exam-engine acceptance only: raw provider-request inspection.
  inspectProviderRequest = null,
} = {}) {
  let stub;
  let child;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await stopAppServer(child);
    await stub?.close();
  };
  const refuse = (reason, details = []) => ({
    refusal: { reason, details },
    close,
  });

  const missing = examinerAppPrerequisites();
  if (journey && !foreignLearnerIdentityConfigured())
    missing.push("ACCEPTANCE_FOREIGN_LEARNER_EMAIL/PASSWORD");
  if (missing.length)
    return refuse(
      "Examiner app acceptance prerequisites are missing or malformed.",
      missing.map((name) => `${name} is missing or malformed.`),
    );
  const keyId = process.env.ACADEMIC_EXECUTION_KEY_ID.trim();
  try {
    if (!(await controllerKeyInstalled(keyId)))
      return refuse(
        "No active hosted controller key matches ACADEMIC_EXECUTION_KEY_ID.",
        [
          "Operator prerequisite: install the matching key with academic_execution_private.install_controller_key (docs/38). This driver never provisions keys.",
        ],
      );
  } catch {
    return refuse(
      "Could not verify the hosted controller key (read-only check failed).",
    );
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    try {
      stub = await startProviderStub({
        journey,
        inspect: inspectProviderRequest,
        identifiers: Boolean(inspectProviderRequest),
      });
    } catch {
      return refuse("The local deterministic provider stub could not start.");
    }
    const port = await freePort();
    const token = randomBytes(32).toString("hex");
    // A second, independent per-run secret: the marker the provider
    // redirect wrapper carries in the child process. Never printed.
    const redirectToken = randomBytes(32).toString("hex");
    child = startApp(
      buildAppChildEnv(process.env, {
        port,
        token,
        redirectToken,
        stub,
        contextHold: contextHold ? stub.contextHoldControl : null,
        journey,
      }),
      port,
    );
    const app = createAppDriverClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    });
    const readiness = await waitForAppReady(app, child);
    if (readiness !== "READY")
      return refuse(
        `The local Ducelio app server did not become ready (${readiness}).`,
        [
          "GATE_REFUSED means the acceptance route's fail-closed gate refused this driver: APP_URL/Host must be loopback, ACCEPTANCE_ENVIRONMENT_ID must be a UUID, and the provider redirect must be attested live in the app's request process (if not, no provider request can have been made). EXITED/TIMEOUT: run `npm run dev` manually to diagnose; stop any other dev server using this checkout first.",
        ],
      );

    const jars = { learner: createCookieJar(), admin: createCookieJar() };
    if (
      !(await signInThroughApp(
        app,
        jars.learner,
        "ACCEPTANCE_LEARNER_EMAIL",
        "ACCEPTANCE_LEARNER_PASSWORD",
      )) ||
      !(await signInThroughApp(
        app,
        jars.admin,
        "ACCEPTANCE_ADMIN_EMAIL",
        "ACCEPTANCE_ADMIN_PASSWORD",
      ))
    )
      return refuse(
        "Real app sign-in failed for the acceptance learner/admin, or the hosted project did not report ACCEPTANCE_ENVIRONMENT_ID.",
      );
    if (journey) {
      const foreign = createCookieJar();
      if (
        !(await signInThroughApp(
          app,
          foreign,
          "ACCEPTANCE_FOREIGN_LEARNER_EMAIL",
          "ACCEPTANCE_FOREIGN_LEARNER_PASSWORD",
        ))
      )
        return refuse(
          "Real app sign-in failed for the acceptance foreign learner.",
        );
      jars.foreign = foreign;
    }
    if (unrelatedStaffIdentityConfigured()) {
      const staff = createCookieJar();
      if (
        await signInThroughApp(
          app,
          staff,
          "ACCEPTANCE_UNRELATED_STAFF_EMAIL",
          "ACCEPTANCE_UNRELATED_STAFF_PASSWORD",
        )
      )
        jars.staff = staff;
    }

    const adminClient = await acceptanceIdentities.admin();
    const learnerClient = await acceptanceIdentities.learner();
    const { data: learnerUser, error: learnerUserError } =
      await learnerClient.auth.getUser();
    if (learnerUserError || !learnerUser?.user?.id)
      return refuse(
        "Could not resolve the acceptance learner's hosted Auth user id.",
      );
    let foreignAuthUserId = null;
    if (journey) {
      const { data: foreignUser, error: foreignUserError } = await (
        await acceptanceIdentities.foreignLearner()
      ).auth.getUser();
      foreignAuthUserId = foreignUserError ? null : foreignUser?.user?.id;
      if (!foreignAuthUserId || foreignAuthUserId === learnerUser.user.id)
        return refuse(
          "The acceptance learner and foreign learner must be two distinct, real hosted Auth users.",
        );
    }
    const session = {
      runId,
      app,
      baseUrl: `http://127.0.0.1:${port}`,
      // Another acceptance route in the SAME child, with the same per-run
      // token -- the token itself is never exposed on the session.
      routeClient: (routePath) =>
        createAppDriverClient({
          baseUrl: `http://127.0.0.1:${port}`,
          token,
          routePath,
        }),
      jars,
      stub,
      adminClient,
      learnerClient,
      learnerAuthUserId: learnerUser.user.id,
      foreignAuthUserId,
      query: (sql, params) =>
        withConnection((c) => c.query(sql, params)).then((r) => r.rows),
      seed: (label) =>
        seedAcceptanceCourse(
          adminClient,
          `${runId}-${label}`,
          learnerUser.user.id,
          {
            examinerEnabled: true,
          },
        ),
      // Gated like every fixture write (concurrency-app-races.mjs only).
      seedResults: seedAcceptanceResults,
    };
    return { session, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runExaminerAppAcceptance({
  startApp = startAppServer,
} = {}) {
  let opened = null;
  try {
    opened = await openExaminerAppSession({ startApp });
    if (opened.refusal)
      return blockedAll(opened.refusal.reason, opened.refusal.details);
    const ctx = opened.session;

    // Each surface is guarded on its own: one surface's unexpected error
    // is that surface's FAIL (or BLOCKED for a write-gate refusal), never
    // silently another's. REGRADE BLOCKS if GRADING yielded no valid
    // revision to regrade.
    let gradingCourse = null;
    let graded = null;
    const grading = await guardScenario(SURFACES.GRADING, async () => {
      gradingCourse = await ctx.seed("examiner-grade");
      graded = await scenarioGrading(ctx, gradingCourse);
      return graded.result;
    });
    const regrade = await guardScenario(SURFACES.REGRADE, () =>
      scenarioRegrade(ctx, gradingCourse, graded),
    );
    const recovery = await guardScenario(SURFACES.INITIAL_RECOVERY, async () =>
      scenarioInitialRecovery(ctx, await ctx.seed("examiner-recovery")),
    );
    return [grading, recovery, regrade];
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blockedAll(error.message);
    return Object.values(SURFACES).map((surface) =>
      fail(surface, "Examiner app acceptance stopped unexpectedly.", [
        error instanceof Error ? error.message : String(error),
      ]),
    );
  } finally {
    await opened?.close();
  }
}

async function main() {
  console.log("===== Commercial V1 examiner real-application acceptance =====");
  const results = await runExaminerAppAcceptance();
  for (const r of results) printResult(r);
  printSummary(results, "Commercial V1 examiner real-application acceptance");
  console.log("");
  console.log(TRUTHFULNESS_STATEMENT);
  process.exit(exitCodeFor(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
