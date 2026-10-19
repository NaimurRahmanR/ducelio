#!/usr/bin/env node
// CP2 hosted exam-engine acceptance (operator-run, MUTATING).
//
//   node --env-file=<acceptance .env.local, outside the checkout> \
//     scripts/acceptance/exam-engine.mjs --chrome=<chrome.exe> --evidence=<dir outside the repo>
//
// Never run by any other command. It writes permanent, run-id-tagged,
// SYNTHETIC institutional history to the dedicated ducelio-acceptance
// project only (see exam-engine-plan.mjs plannedHostedWrites), and only when
// every gate below passes:
//   1. prerequisites: the examiner-app prerequisites (acceptance identities,
//      matching controller key id/secret, ACCEPTANCE_WRITE_ENABLED=true),
//      the foreign learner and unrelated staff identities, a Chrome path and
//      an evidence directory outside this repository;
//   2. migration 059 is present in the hosted ledger (read-only check);
//   3. the shared app session (real `next dev` on loopback, the
//      deterministic provider stub -- no billable model request is
//      possible -- and real Auth sign-ins);
//   4. seeding through seedAcceptanceCourse, which itself enforces the
//      direct-database marker gate AND the hosted-RPC environment gate.
// A failed gate yields BLOCKED for every surface and nothing is written.
//
// Learner and staff actions use their own authenticated sessions (real
// Supabase Auth, PostgREST, RLS and grants) or the real UI in Chrome; the
// direct database connection is used READ-ONLY, for evidence. Nothing
// protected is ever logged: page text, prompts, answers and keys stay in
// memory and are only scanned for protected markers.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withConnection } from "./db.mjs";
import { buildAcceptancePackage, seedAcceptanceCourse } from "./fixtures.mjs";
import {
  examinerAppPrerequisites,
  openExaminerAppSession,
} from "./examiner-app.mjs";
import {
  foreignLearnerIdentityConfigured,
  unrelatedStaffIdentityConfigured,
  anonClient,
  acceptanceIdentities,
} from "./supabase.mjs";
import {
  applyExamEnginePlan,
  canonicalBody,
  OBJECTIVE_TYPES,
  plannedHostedWrites,
  protectedMarkerHits,
  protectedProviderRequestHits,
  questionsFor,
  examEngineQuestions,
  TIMED_COMPONENT,
} from "./exam-engine-plan.mjs";
import {
  enterAnswer,
  launchBrowser,
  assessmentCardSelector,
  navStatus,
  openQuestion,
  saveOpenQuestion,
  signInThroughUi,
  submitFinalAnswers,
} from "./exam-engine-browser.mjs";
import { pass, fail, blocked, printResult, printSummary } from "./report.mjs";

export const SURFACES = Object.freeze([
  "CP2:AUTHORING",
  "CP2:PROTECTION",
  "CP2:BROWSER_EXAM",
  "CP2:MIXED_GRADING",
  "CP2:OBJECTIVE_ONLY",
  "CP2:LEGACY_FREE_TEXT",
  "CP2:TIMED_EXPIRY",
  "CP2:ACADEMIC_REVIEW",
  "CP2:COMPATIBILITY",
  "CP2:AUDIT_MINIMISATION",
  "CP2:WRITE_LEDGER",
]);
const LEGACY_CONTEXT_KEYS = Object.freeze([
  "assessmentId",
  "attemptId",
  "component",
  "instructions",
  "questions",
  "title",
]);
const WINDOW_MINUTES = 6;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Fail closed BEFORE the first synthetic course import. Build the same base
// package shape used by seedAcceptanceCourse and apply the actual CP2 plan.
// This guard is pure: it does not authenticate, connect, or write.
export function assertExamEngineSchedulePlan(
  buildCourse = (course) =>
    applyExamEnginePlan(
      buildAcceptancePackage("cp2-a2-prewrite", { examinerEnabled: true }),
      course,
    ),
) {
  const components = new Set([
    "quiz_1",
    "quiz_2",
    "midterm",
    "quiz_3",
    "quiz_4",
    "final",
  ]);
  for (const [course, windowMinutes] of [
    ["main", WINDOW_MINUTES],
    ["review", 90],
  ]) {
    const templates = buildCourse(course)?.assessmentTemplates;
    if (!Array.isArray(templates) || templates.length !== components.size)
      throw new Error("EXAM_ENGINE_SCHEDULE_INVALID");
    const seen = new Set();
    for (const template of templates) {
      if (
        !components.has(template?.key) ||
        seen.has(template.key) ||
        !Number.isInteger(template.durationMinutes) ||
        template.durationMinutes < 1 ||
        template.durationMinutes > windowMinutes
      )
        throw new Error("EXAM_ENGINE_SCHEDULE_INVALID");
      seen.add(template.key);
    }
  }
  return true;
}

// Return ONLY allowlisted operation identifiers, never upstream messages,
// SQL diagnostics, authentication data, or assessment payloads.
export function classifyExamEngineSetupFailure(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const match = /^([a-z][a-z0-9_]{1,80}) failed:/.exec(message);
  const allowed = new Set([
    "import_course_package",
    "mark_course_package_validated",
    "apply_course_package",
    "run_course_package_test",
    "publish_course_package",
    "admin_create_cohort",
    "activate_course_package",
    "create_enrolment",
    "bind_commercial_v1_assessment_component",
    "publish_commercial_v1_grading_policy",
    "publish_commercial_v1_lab_policy",
    "publish_commercial_v1_result_policy",
    "set_agent_config",
  ]);
  return match && allowed.has(match[1])
    ? `RPC_REFUSED:${match[1]}`
    : "SETUP_EXCEPTION";
}

export function examEnginePrerequisites(env, { chromePath, evidenceDir }) {
  const missing = examinerAppPrerequisites(env).map(
    (name) => `${name} is missing or malformed.`,
  );
  if (!foreignLearnerIdentityConfigured())
    missing.push("ACCEPTANCE_FOREIGN_LEARNER_EMAIL/PASSWORD are missing.");
  if (!unrelatedStaffIdentityConfigured())
    missing.push("ACCEPTANCE_UNRELATED_STAFF_EMAIL/PASSWORD are missing.");
  if (!chromePath || !existsSync(chromePath))
    missing.push("--chrome must name an installed Chrome executable.");
  if (!evidenceDir) missing.push("--evidence is required.");
  else if (!relative(REPO_ROOT, resolve(evidenceDir)).startsWith(".."))
    missing.push("--evidence must be outside this repository.");
  return missing;
}

export async function migration059Applied(query = defaultQuery) {
  const [row] = await query(
    `select exists(select 1 from supabase_migrations.schema_migrations where version='202610160059') as ledger,
            to_regnamespace('assessment_interaction_private') is not null as schema`,
  );
  return row?.ledger === true && row?.schema === true;
}
const defaultQuery = (sql, params) =>
  withConnection((c) => c.query(sql, params)).then((r) => r.rows);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(iso, label, log) {
  const ms = Date.parse(iso) - Date.now();
  if (ms > 0) {
    log(`waiting ${Math.ceil(ms / 1000)} s for ${label}`);
    await sleep(ms + 2000);
  }
}
async function rpc(client, name, args = {}) {
  const { data, error } = await client.rpc(name, args);
  return { data, error };
}
async function poll(read, done, ms = 90000) {
  let value;
  for (let t = 0; t < ms; t += 2000) {
    value = await read();
    if (done(value)) return value;
    await sleep(2000);
  }
  return value;
}
// Only allowlisted failure classes enter terminal output/evidence: never
// serialize raw upstream errors, credentials, learner answers or SQL text.
export function classifyExamEngineSurfaceFailure(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const exact = new Map([
    ["UI sign-in did not complete.", "UI_SIGN_IN_INCOMPLETE"],
    [
      "The new run assessment is not on the learner's first assessments page.",
      "ASSESSMENT_CARD_NOT_VISIBLE",
    ],
    [
      "The expected assessment start control was unavailable.",
      "ASSESSMENT_START_CONTROL_UNAVAILABLE",
    ],
    ["The exam workspace did not open.", "EXAM_WORKSPACE_NOT_OPEN"],
    ["start_assessment_attempt was refused.", "ATTEMPT_START_REFUSED"],
    ["Element not found or disabled.", "UI_CONTROL_NOT_FOUND"],
    ["Field not found or not focusable.", "UI_FIELD_NOT_FOUND"],
    ["No academic review case was opened.", "REVIEW_CASE_NOT_OPENED"],
  ]);
  if (exact.has(message)) return exact.get(message);
  if (message.startsWith("Page evaluation failed:"))
    return "PAGE_EVALUATION_REFUSED";
  if (message.startsWith("A ") && message.endsWith(" answer was refused."))
    return "ANSWER_SAVE_REFUSED";
  return "SURFACE_EXCEPTION";
}

// The React SSR stream may separate numeric JSX children with <!-- -->
// markers. Inspect bounded, visible text rather than fragile raw HTML bytes.
// Never log or persist the HTML, which may contain learner/reviewer content.
export function reviewPageContainsLockedMark(html, earned, maximum) {
  if (
    typeof html !== "string" ||
    !Number.isInteger(earned) ||
    !Number.isInteger(maximum) ||
    earned < 0 ||
    maximum < 0
  )
    return false;
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
  const match = /Deterministic mark:\s*(\d+)\s+of\s+(\d+)(?!\d)/.exec(visible);
  return !!match && Number(match[1]) === earned && Number(match[2]) === maximum;
}

// A guarded surface: errors remain FAIL, but expose a bounded diagnostic.
export async function surface(name, run) {
  try {
    return await run();
  } catch (error) {
    return fail(name, "The surface threw before completing.", [
      `Failure class: ${classifyExamEngineSurfaceFailure(error)}`,
    ]);
  }
}
const verdict = (name, problems, summary) =>
  problems.length ? fail(name, summary, problems) : pass(name, summary);

const Q = {
  attempt: `select id, state, submission_provenance, expires_at from assessment_attempts where id=$1`,
  executions: `select e.state, e.reason_code, u.provider_calls from commercial_v1_examiner_executions e
    left join commercial_v1_examiner_execution_usage u on u.execution_id=e.id where e.attempt_id=$1`,
  latestRevision: `select r.id, commercial_v1_private.assessment_result_is_valid(r.id) as valid
    from commercial_v1_assessment_result_revisions r where r.attempt_id=$1 order by r.revision_number desc limit 1`,
  marks: `select q.position, m.marks_awarded, q.max_marks from commercial_v1_assessment_question_marks m
    join assessment_questions q on q.id=m.question_id where m.result_revision_id=$1 order by q.position`,
  questions: `select q.id, q.position, coalesce(i.question_type,'FREE_TEXT') as question_type
    from assessment_questions q left join assessment_question_interactions i on i.question_id=q.id
    where q.assessment_id=$1 order by q.position`,
  lesson: `select lesson_id from assessments where id=$1`,
  reviewCase: `select case_id from commercial_v1_review_private.open_cases where attempt_id=$1`,
  audit: `select coalesce(jsonb_agg(jsonb_build_object('a',action,'b',before_state,'s',after_state,'r',reason)),'[]'::jsonb)::text as payload
    from audit_events where target_id = any($1::uuid[])`,
};

// ---------------------------------------------------------------------------
export async function runExamEngineAcceptance({
  chromePath,
  evidenceDir,
  log = (m) => console.log(m),
  openSession = openExaminerAppSession,
  checkMigration = migration059Applied,
  checkSchedule = assertExamEngineSchedulePlan,
} = {}) {
  const blockAll = (reason, details = []) =>
    SURFACES.map((s) => blocked(s, reason, details));
  const missing = examEnginePrerequisites(process.env, {
    chromePath,
    evidenceDir,
  });
  if (missing.length)
    return {
      results: blockAll(
        "Prerequisites are missing; nothing was written.",
        missing,
      ),
    };
  if (process.env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    return {
      results: blockAll(
        "ACCEPTANCE_WRITE_ENABLED is not exactly 'true'; nothing was written.",
      ),
    };
  // Nothing has been opened or written at this point.
  try {
    if (checkSchedule() !== true)
      throw new Error("EXAM_ENGINE_SCHEDULE_INVALID");
  } catch {
    return {
      results: blockAll(
        "Synthetic assessment durations exceed scheduled windows; nothing was written.",
      ),
    };
  }
  try {
    if (!(await checkMigration()))
      return {
        results: blockAll(
          "Migration 059 is not applied on the target; nothing was written.",
        ),
      };
  } catch {
    return {
      results: blockAll(
        "The read-only migration check failed; nothing was written.",
      ),
    };
  }

  const providerRequests = [];
  const opened = await openSession({
    journey: true,
    inspectProviderRequest: (raw) =>
      providerRequests.push({
        at: Date.now(),
        hits: protectedProviderRequestHits(raw),
      }),
  });
  if (opened.refusal)
    return { results: blockAll(opened.refusal.reason, opened.refusal.details) };
  const { session, close } = opened;
  const evidence = {
    runId: session.runId,
    startedAt: new Date().toISOString(),
    synthetic: true,
    plan: plannedHostedWrites(),
    created: {},
    surfaces: {},
  };
  const results = [];
  const record = (r) => {
    results.push(r);
    const failureClass = (r.details ?? []).find((detail) =>
      /^Failure class: [A-Z_]+$/.test(detail),
    );
    evidence.surfaces[r.surface] = {
      status: r.status,
      reason: r.reason,
      ...(failureClass ? { failureClass: failureClass.slice(15) } : {}),
    };
    printResult(r);
  };
  let browser;
  let setupStage = "SEED_MAIN";
  try {
    // ---- Seeding (gated inside seedAcceptanceCourse) -----------------------
    const firstOpensAt = Date.now() + 120_000;
    const main = await seedAcceptanceCourse(
      session.adminClient,
      `${session.runId}-cp2-main`,
      session.learnerAuthUserId,
      {
        examinerEnabled: true,
        transformPackage: (pkg) => applyExamEnginePlan(pkg, "main"),
        assessmentSchedule: { firstOpensAt, windowMinutes: WINDOW_MINUTES },
      },
    );
    setupStage = "SEED_REVIEW";
    const review = await seedAcceptanceCourse(
      session.adminClient,
      `${session.runId}-cp2-review`,
      session.learnerAuthUserId,
      {
        examinerEnabled: true,
        transformPackage: (pkg) => applyExamEnginePlan(pkg, "review"),
        assessmentSchedule: { firstOpensAt, windowMinutes: 90 },
      },
    );
    setupStage = "RUN_SURFACES";
    const windows = Object.fromEntries(
      ["QUIZ_1", "QUIZ_2", "MIDTERM", "QUIZ_3"].map((c, i) => [
        c,
        new Date(firstOpensAt + i * WINDOW_MINUTES * 60_000).toISOString(),
      ]),
    );
    evidence.created.main = {
      importId: main.importId,
      activationId: main.activationId,
      cohortId: main.cohortId,
      enrolmentId: main.enrolmentId,
      assessments: main.assessmentIdsByComponent,
    };
    evidence.created.review = {
      importId: review.importId,
      activationId: review.activationId,
      cohortId: review.cohortId,
      enrolmentId: review.enrolmentId,
      assessments: review.assessmentIdsByComponent,
    };
    const ids = main.assessmentIdsByComponent;
    const learner = session.learnerClient;
    const admin = session.adminClient;
    const foreign = await acceptanceIdentities.foreignLearner();
    const staff = await acceptanceIdentities.unrelatedStaff();
    const anon = anonClient();
    const grade = (attemptId) =>
      session.app.call(session.jars.learner, {
        operation: "SUBMIT_AND_GRADE_ASSESSMENT",
        attemptId,
      });

    // ---- CP2:AUTHORING -------------------------------------------------------
    record(
      await surface("CP2:AUTHORING", async () => {
        const problems = [];
        const [{ lesson_id }] = await session.query(Q.lesson, [ids.QUIZ_1]);
        const draft = await rpc(admin, "create_assessment", {
          p_cohort_id: main.cohortId,
          p_lesson_id: lesson_id,
          p_instructor_id: main.instructorId,
          p_title: "CP2 synthetic authoring check (DRAFT, never published)",
          p_instructions: "Synthetic demo only. Not real exam content.",
          p_opens_at: new Date(Date.now() + 86_400_000).toISOString(),
          p_closes_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          p_duration_minutes: 30,
          p_attempts_allowed: 1,
          p_reason: "CP2 acceptance authoring check",
        });
        if (draft.error) throw new Error("create_assessment was refused.");
        evidence.created.authoringDraftAssessmentId = draft.data;
        const questions = examEngineQuestions();
        for (const q of questions.filter(
          (x) => x.questionType !== "FREE_TEXT",
        )) {
          const added = await rpc(admin, "add_objective_assessment_question", {
            p_assessment_id: draft.data,
            p_position: q.position,
            p_prompt: q.prompt,
            p_max_marks: q.maxMarks,
            p_question_type: q.questionType,
            p_interaction: q.interaction,
            p_answer_key: q.answerKey,
            p_expected_answer: q.expectedAnswer,
            p_marking_guidance: null,
            p_reason: "CP2 acceptance authoring check",
          });
          if (added.error)
            problems.push(`${q.questionType} could not be authored.`);
        }
        const bad = await rpc(admin, "add_objective_assessment_question", {
          p_assessment_id: draft.data,
          p_position: 9,
          p_prompt: "Synthetic invalid key check.",
          p_max_marks: 1,
          p_question_type: "SINGLE_SELECT",
          p_interaction: questions[0].interaction,
          p_answer_key: { correctOptionId: "o9" },
          p_expected_answer: "Synthetic",
          p_marking_guidance: null,
          p_reason: "CP2 acceptance authoring check",
        });
        if (!bad.error)
          problems.push("An answer key naming no option was accepted.");
        const listed = await rpc(
          admin,
          "list_assessment_authoring_interactions",
          {
            p_assessment_id: draft.data,
          },
        );
        const types = (listed.data ?? []).map((r) => r.question_type).sort();
        if (
          JSON.stringify(types) !== JSON.stringify([...OBJECTIVE_TYPES].sort())
        )
          problems.push(
            "The authoring list does not show exactly the five authored types.",
          );
        if (protectedMarkerHits(JSON.stringify(listed.data)).length)
          problems.push("The authoring list carried answer-key material.");
        for (const [who, client] of [
          ["learner", learner],
          ["unrelated staff", staff],
          ["anon", anon],
        ]) {
          const r = await rpc(
            client,
            "list_assessment_authoring_interactions",
            { p_assessment_id: draft.data },
          );
          if (!r.error && (r.data ?? []).length)
            problems.push(`${who} could list authoring interactions.`);
          const w = await rpc(client, "add_objective_assessment_question", {
            p_assessment_id: draft.data,
            p_position: 10,
            p_prompt: "Synthetic",
            p_max_marks: 1,
            p_question_type: "SINGLE_SELECT",
            p_interaction: questions[0].interaction,
            p_answer_key: questions[0].answerKey,
            p_expected_answer: "Synthetic",
            p_marking_guidance: null,
            p_reason: "CP2 forbidden authoring probe",
          });
          if (!w.error)
            problems.push(`${who} could author an objective question.`);
        }
        return verdict(
          "CP2:AUTHORING",
          problems,
          "Staff authored all five objective types on a DRAFT; invalid keys, learners, unrelated staff and anon were refused; no key was listed.",
        );
      }),
    );

    // ---- CP2:PROTECTION ------------------------------------------------------
    record(
      await surface("CP2:PROTECTION", async () => {
        const problems = [];
        for (const [who, client] of [
          ["learner", learner],
          ["foreign learner", foreign],
          ["unrelated staff", staff],
          ["admin", admin],
          ["anon", anon],
        ])
          for (const table of [
            "assessment_question_interactions",
            "assessment_question_objective_keys",
          ]) {
            const { data, error } = await client
              .from(table)
              .select("*")
              .limit(1);
            if (!error || (data ?? []).length)
              problems.push(`${who} could read ${table}.`);
          }
        const before = await rpc(learner, "get_active_assessment_exam_state", {
          p_assessment_id: ids.QUIZ_1,
        });
        if ((before.data ?? []).length)
          problems.push(
            "Definitions were released before the attempt started.",
          );
        return verdict(
          "CP2:PROTECTION",
          problems,
          "No API role (including staff and anon) can read either CP2 table; nothing is released before an attempt.",
        );
      }),
    );

    // ---- CP2:BROWSER_EXAM (QUIZ_1, real UI) ----------------------------------
    let quiz1Attempt = null;
    record(
      await surface("CP2:BROWSER_EXAM", async () => {
        const problems = [];
        const plan = questionsFor("main", "QUIZ_1");
        browser = await launchBrowser({ chromePath });
        const { page } = browser;
        if (
          !(await signInThroughUi(
            page,
            session.baseUrl,
            process.env.ACCEPTANCE_LEARNER_EMAIL,
            process.env.ACCEPTANCE_LEARNER_PASSWORD,
          ))
        )
          throw new Error("UI sign-in did not complete.");
        await page.goto(
          `${session.baseUrl}/student/assessments`,
          "!!document.querySelector('h1')",
        );
        const title = "QUIZ_1 acceptance checkpoint";
        // Bind to this run's assessment UUID. Both synthetic courses (and
        // historical runs) intentionally share the exact same visible title.
        const card = assessmentCardSelector(ids.QUIZ_1, title);
        if (!(await page.waitFor(`!!${card}`)))
          throw new Error(
            "The new run assessment is not on the learner's first assessments page.",
          );
        await waitUntil(windows.QUIZ_1, "QUIZ_1 window", log);
        // If the exact card is not actionable, fail without starting an
        // identically titled assessment from another synthetic run.
        if (
          !(await page.evaluate(
            `!!(${card})?.querySelector('form button') && !(${card})?.querySelector('form button').disabled`,
          ))
        )
          throw new Error(
            "The expected assessment start control was unavailable.",
          );
        await page.click(`${card}.querySelector('form button')`);
        if (!(await page.waitFor("!!document.querySelector('.exam')", 30000)))
          throw new Error("The exam workspace did not open.");
        const [attempt] = await session.query(
          "select id from assessment_attempts where assessment_id=$1 and state='ACTIVE'",
          [ids.QUIZ_1],
        );
        quiz1Attempt = attempt?.id;
        evidence.created.quiz1AttemptId = quiz1Attempt;
        for (const q of plan) {
          await openQuestion(page, q.position);
          await enterAnswer(page, q, q.answers.best);
          if (!(await saveOpenQuestion(page, q.position)))
            problems.push(`Q${q.position} (${q.questionType}) did not save.`);
        }
        const state =
          (
            await rpc(learner, "get_active_assessment_exam_state", {
              p_assessment_id: ids.QUIZ_1,
            })
          ).data ?? [];
        const dbQuestions = await session.query(Q.questions, [ids.QUIZ_1]);
        for (const q of plan) {
          const row = state.find(
            (r) =>
              r.question_id ===
              dbQuestions.find((d) => d.position === q.position)?.id,
          );
          if (
            row?.saved_body !== canonicalBody(q.questionType, q.answers.best) ||
            row?.revision_count !== 1
          )
            problems.push(
              `Q${q.position} was not saved once with its canonical body.`,
            );
        }
        if (protectedMarkerHits(JSON.stringify(state)).length)
          problems.push("The learner exam state carried protected material.");
        if (protectedMarkerHits(await page.html()).length)
          problems.push("The exam page carried protected material.");
        const foreignState = await rpc(
          foreign,
          "get_active_assessment_exam_state",
          { p_assessment_id: ids.QUIZ_1 },
        );
        if ((foreignState.data ?? []).length)
          problems.push("Another learner received this attempt's definitions.");
        const forged = await rpc(
          foreign,
          "record_commercial_v1_assessment_response",
          {
            p_attempt_id: quiz1Attempt,
            p_question_id: dbQuestions[0].id,
            p_body: canonicalBody("SINGLE_SELECT", { optionId: "o1" }),
            p_idempotency_key: randomUUID(),
          },
        );
        if (forged.data?.ok === true)
          problems.push("Another learner wrote to this attempt.");
        await page.reload("!!document.querySelector('.exam')");
        for (const q of plan)
          if ((await navStatus(page, q.position)) !== "saved")
            problems.push(`Q${q.position} was not restored after refresh.`);
        await openQuestion(page, 3);
        if (
          !(await page.evaluate(
            `document.querySelector('.exam-main form.exam-actions button').disabled`,
          ))
        )
          problems.push("An unchanged saved answer could be saved again.");
        const matching = plan.find((q) => q.questionType === "PBQ_MATCHING");
        await enterAnswer(page, matching, matching.answers.partial);
        await saveOpenQuestion(page, matching.position);
        const after =
          (
            await rpc(learner, "get_active_assessment_exam_state", {
              p_assessment_id: ids.QUIZ_1,
            })
          ).data ?? [];
        const m = after.find(
          (r) =>
            r.question_id ===
            dbQuestions.find((d) => d.position === matching.position).id,
        );
        if (
          m?.revision_count !== 2 ||
          m?.saved_body !==
            canonicalBody("PBQ_MATCHING", matching.answers.partial)
        )
          problems.push("A changed answer did not become the second revision.");
        if (!(await submitFinalAnswers(page)))
          problems.push("Review-and-submit did not complete.");
        if (page.consoleErrors.length)
          problems.push(
            `The page reported ${page.consoleErrors.length} script error(s).`,
          );
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot(
          join(evidenceDir, `cp2-quiz1-${session.runId}.png`),
        );
        return verdict(
          "CP2:BROWSER_EXAM",
          problems,
          "Real UI: all six types answered, saved canonically, isolated from another learner, restored after refresh, re-saved only when changed, then submitted.",
        );
      }),
    );

    // ---- CP2:MIXED_GRADING ---------------------------------------------------
    record(
      await surface("CP2:MIXED_GRADING", async () => {
        if (!quiz1Attempt)
          return blocked(
            "CP2:MIXED_GRADING",
            "No QUIZ_1 attempt was submitted.",
          );
        const problems = [];
        const executions = await poll(
          () => session.query(Q.executions, [quiz1Attempt]),
          (r) => r.some((e) => e.state === "SUCCEEDED" || e.state === "FAILED"),
        );
        if (
          executions.length !== 1 ||
          executions[0].state !== "SUCCEEDED" ||
          executions[0].provider_calls !== 1
        )
          problems.push(
            "Expected exactly one SUCCEEDED execution with one provider call.",
          );
        const calls = session.stub.calls.filter(
          (c) => c.attemptId === quiz1Attempt,
        );
        const dbQuestions = await session.query(Q.questions, [ids.QUIZ_1]);
        const freeText = dbQuestions
          .filter((q) => q.question_type === "FREE_TEXT")
          .map((q) => q.id);
        if (
          calls.length !== 1 ||
          JSON.stringify(calls[0].questionIds) !== JSON.stringify(freeText)
        )
          problems.push(
            "The provider did not receive exactly the free-text question.",
          );
        if (
          JSON.stringify(calls[0]?.contextKeys) !==
          JSON.stringify(LEGACY_CONTEXT_KEYS)
        )
          problems.push(
            "The provider context key set differs from the pre-CP2 shape.",
          );
        const [revision] = await session.query(Q.latestRevision, [
          quiz1Attempt,
        ]);
        const marks = revision
          ? await session.query(Q.marks, [revision.id])
          : [];
        const plan = questionsFor("main", "QUIZ_1");
        for (const q of plan.filter((x) => x.questionType !== "FREE_TEXT")) {
          const expected =
            q.questionType === "PBQ_MATCHING"
              ? q.answers.partialMarks
              : q.maxMarks;
          if (
            marks.find((r) => r.position === q.position)?.marks_awarded !==
            expected
          )
            problems.push(
              `Q${q.position} did not receive the deterministic mark ${expected}.`,
            );
        }
        if (!revision?.valid)
          problems.push("The result revision is not valid.");
        if (providerRequests.some((r) => r.hits.length))
          problems.push("A provider request carried protected material.");
        return verdict(
          "CP2:MIXED_GRADING",
          problems,
          "One provider call with only the free-text question and the pre-CP2 context shape; objective marks equal the database scorer.",
        );
      }),
    );

    // ---- CP2:OBJECTIVE_ONLY (QUIZ_2) -----------------------------------------
    const answerViaApi = async (
      assessmentId,
      plan,
      choice = "best",
      skip = [],
    ) => {
      const started = await rpc(learner, "start_assessment_attempt", {
        p_assessment_id: assessmentId,
      });
      if (started.error)
        throw new Error("start_assessment_attempt was refused.");
      const dbQuestions = await session.query(Q.questions, [assessmentId]);
      for (const q of plan) {
        if (skip.includes(q.position)) continue;
        const saved = await rpc(
          learner,
          "record_commercial_v1_assessment_response",
          {
            p_attempt_id: started.data,
            p_question_id: dbQuestions.find((d) => d.position === q.position)
              .id,
            p_body: canonicalBody(q.questionType, q.answers[choice]),
            p_idempotency_key: randomUUID(),
          },
        );
        if (saved.data?.ok !== true)
          throw new Error(`A ${q.questionType} answer was refused.`);
      }
      return started.data;
    };
    record(
      await surface("CP2:OBJECTIVE_ONLY", async () => {
        await waitUntil(windows.QUIZ_2, "the QUIZ_2 window", log);
        const problems = [];
        const plan = questionsFor("main", "QUIZ_2");
        const attemptId = await answerViaApi(ids.QUIZ_2, plan);
        evidence.created.quiz2AttemptId = attemptId;
        const graded = await grade(attemptId);
        if (graded.body?.result?.grading !== "GRADED")
          problems.push("QUIZ_2 was not GRADED.");
        const [execution] = await session.query(Q.executions, [attemptId]);
        if (execution?.provider_calls !== 0)
          problems.push("An objective-only attempt reached the provider.");
        if (session.stub.calls.some((c) => c.attemptId === attemptId))
          problems.push("The provider stub saw the objective-only attempt.");
        const [revision] = await session.query(Q.latestRevision, [attemptId]);
        const marks = revision
          ? await session.query(Q.marks, [revision.id])
          : [];
        if (
          !revision?.valid ||
          marks.length !== plan.length ||
          marks.some((m) => m.marks_awarded !== m.max_marks)
        )
          problems.push(
            "Deterministic full marks were not recorded for every objective question.",
          );
        return verdict(
          "CP2:OBJECTIVE_ONLY",
          problems,
          "All five objective types graded deterministically with zero provider calls.",
        );
      }),
    );

    // ---- CP2:LEGACY_FREE_TEXT (MIDTERM) --------------------------------------
    record(
      await surface("CP2:LEGACY_FREE_TEXT", async () => {
        await waitUntil(windows.MIDTERM, "the MIDTERM window", log);
        const problems = [];
        const attemptId = await answerViaApi(ids.MIDTERM, [
          {
            position: 1,
            questionType: "FREE_TEXT",
            answers: { best: "Synthetic legacy written answer." },
          },
        ]);
        evidence.created.midtermAttemptId = attemptId;
        const graded = await grade(attemptId);
        if (graded.body?.result?.grading !== "GRADED")
          problems.push("The legacy free-text attempt was not GRADED.");
        const calls = session.stub.calls.filter(
          (c) => c.attemptId === attemptId,
        );
        if (
          calls.length !== 1 ||
          JSON.stringify(calls[0].contextKeys) !==
            JSON.stringify(LEGACY_CONTEXT_KEYS)
        )
          problems.push("The legacy provider request changed shape.");
        return verdict(
          "CP2:LEGACY_FREE_TEXT",
          problems,
          "A legacy free-text assessment grades exactly as before CP2.",
        );
      }),
    );

    // ---- CP2:TIMED_EXPIRY (QUIZ_3) -------------------------------------------
    record(
      await surface("CP2:TIMED_EXPIRY", async () => {
        await waitUntil(windows.QUIZ_3, `the ${TIMED_COMPONENT} window`, log);
        const problems = [];
        const plan = questionsFor("main", TIMED_COMPONENT);
        const attemptId = await answerViaApi(ids.QUIZ_3, plan, "best", [2]);
        evidence.created.quiz3AttemptId = attemptId;
        const [attempt] = await session.query(Q.attempt, [attemptId]);
        await waitUntil(
          new Date(attempt.expires_at).toISOString(),
          "the 1-minute attempt to expire",
          log,
        );
        const dbQuestions = await session.query(Q.questions, [ids.QUIZ_3]);
        const late = await rpc(
          learner,
          "record_commercial_v1_assessment_response",
          {
            p_attempt_id: attemptId,
            p_question_id: dbQuestions[1].id,
            p_body: "Synthetic late answer.",
            p_idempotency_key: randomUUID(),
          },
        );
        if (late.data?.ok === true)
          problems.push("A save after the deadline was accepted.");
        await rpc(learner, "finalize_expired_commercial_v1_attempts");
        const [final] = await session.query(Q.attempt, [attemptId]);
        if (
          final.state !== "SUBMITTED" ||
          final.submission_provenance !== "AUTO_TIMEOUT"
        )
          problems.push("The expired attempt was not finalised AUTO_TIMEOUT.");
        const graded = await grade(attemptId);
        if (graded.body?.result?.grading !== "GRADED")
          problems.push("The timed-out attempt was not graded.");
        const [revision] = await session.query(Q.latestRevision, [attemptId]);
        const marks = revision
          ? await session.query(Q.marks, [revision.id])
          : [];
        if (
          marks.find((m) => m.position === 1)?.marks_awarded !==
            plan[0].maxMarks ||
          marks.find((m) => m.position === 2)?.marks_awarded !== 0
        )
          problems.push(
            "The saved answer was not graded and the unsaved one not zeroed.",
          );
        return verdict(
          "CP2:TIMED_EXPIRY",
          problems,
          "Late save refused; AUTO_TIMEOUT once; the answer saved before the deadline was graded.",
        );
      }),
    );

    // ---- CP2:ACADEMIC_REVIEW (review course) ---------------------------------
    record(
      await surface("CP2:ACADEMIC_REVIEW", async () => {
        const problems = [];
        const plan = questionsFor("review", "QUIZ_1");
        const rid = review.assessmentIdsByComponent.QUIZ_1;
        const attemptId = await answerViaApi(rid, plan);
        evidence.created.reviewAttemptId = attemptId;
        const graded = await grade(attemptId);
        if (graded.body?.result?.grading !== "ESCALATED")
          problems.push("The review-course attempt was not escalated.");
        const [kase] = await poll(
          () => session.query(Q.reviewCase, [attemptId]),
          (r) => r.length > 0,
          30000,
        );
        if (!kase) throw new Error("No academic review case was opened.");
        evidence.created.reviewCaseId = kase.case_id;
        const opened = await rpc(
          admin,
          "get_commercial_v1_academic_review_case",
          { p_case_id: kase.case_id },
        );
        const objective = opened.data?.assessment?.questions?.find(
          (q) => q.objective,
        )?.objective;
        if (objective?.deterministicMarks !== plan[0].maxMarks)
          problems.push(
            "The reviewer did not see the locked deterministic mark.",
          );
        const keyHits = protectedMarkerHits(JSON.stringify(opened.data)).filter(
          (h) =>
            !["expectedAnswer", "markingGuidance"].includes(h) &&
            !h.startsWith("CP2E"),
        );
        if (keyHits.length)
          problems.push("The review case carried answer-key material.");
        const page = await fetch(
          `${session.baseUrl}/admin/academic-review?case=${kase.case_id}`,
          {
            headers: { cookie: session.jars.admin.header() },
            redirect: "manual",
          },
        );
        const html = await page.text();
        if (
          page.status !== 200 ||
          !reviewPageContainsLockedMark(
            html,
            plan[0].maxMarks,
            plan[0].maxMarks,
          )
        )
          problems.push(
            "The academic review page did not show the locked deterministic mark.",
          );
        const qs = await session.query(Q.questions, [rid]);
        const submit = (objectiveMark) =>
          rpc(admin, "submit_commercial_v1_academic_review_assessment_grade", {
            p_case_id: kase.case_id,
            p_marks: [
              { questionId: qs[0].id, marksAwarded: objectiveMark },
              { questionId: qs[1].id, marksAwarded: 3 },
            ],
            p_reason: "CP2 synthetic human review",
          });
        const forged = await submit(0);
        if (!forged.error)
          problems.push(
            "A human mark differing from the deterministic one was accepted.",
          );
        const ok = await submit(plan[0].maxMarks);
        if (ok.error)
          problems.push("The deterministic human review grade was refused.");
        return verdict(
          "CP2:ACADEMIC_REVIEW",
          problems,
          "Escalated case shows the locked deterministic mark; a forged objective mark is refused; the review grade records.",
        );
      }),
    );

    // ---- CP2:COMPATIBILITY -----------------------------------------------------
    record(
      await surface("CP2:COMPATIBILITY", async () => {
        const problems = [];
        const timings = {};
        for (const [jar, path] of [
          ["learner", "/student/assessments"],
          ["learner", "/student/assessments?page=2"],
          ["learner", "/student/progress"],
          ["learner", "/student/results"],
          ["admin", "/admin/course-engineering"],
          ["admin", "/admin/academic-review"],
        ]) {
          const t0 = Date.now();
          const r = await fetch(`${session.baseUrl}${path}`, {
            headers: { cookie: session.jars[jar].header() },
            redirect: "manual",
          });
          timings[path] = Date.now() - t0;
          if (r.status !== 200) problems.push(`${path} answered ${r.status}.`);
          if (
            protectedMarkerHits(await r.text()).some(
              (h) =>
                h.startsWith("CP2E") || /correct|answer_?Key|mapping/i.test(h),
            )
          )
            problems.push(`${path} carried protected material.`);
        }
        evidence.timingsMs = timings;
        return verdict(
          "CP2:COMPATIBILITY",
          problems,
          "Existing learner and admin surfaces load with CP2 data present.",
        );
      }),
    );

    // ---- CP2:AUDIT_MINIMISATION ------------------------------------------------
    record(
      await surface("CP2:AUDIT_MINIMISATION", async () => {
        const qids = (
          await session.query(
            "select question_id from assessment_question_interactions where assessment_id = any($1::uuid[])",
            [
              [
                ...Object.values(ids),
                ...Object.values(review.assessmentIdsByComponent),
                evidence.created.authoringDraftAssessmentId,
              ].filter(Boolean),
            ],
          )
        ).map((r) => r.question_id);
        const [{ payload }] = await session.query(Q.audit, [qids]);
        const problems = [];
        if (
          protectedMarkerHits(payload).length ||
          payload.includes("Synthetic option")
        )
          problems.push("An audit row carried definition or key content.");
        if (!qids.length)
          problems.push("No objective definitions were found for this run.");
        return verdict(
          "CP2:AUDIT_MINIMISATION",
          problems,
          `Audit rows for ${qids.length} objective definitions carry identifiers and type only.`,
        );
      }),
    );

    // ---- CP2:WRITE_LEDGER --------------------------------------------------------
    record(
      await surface("CP2:WRITE_LEDGER", async () => {
        const all = [
          ...Object.values(ids),
          ...Object.values(review.assessmentIdsByComponent),
        ];
        const [counts] = await session.query(
          `select (select count(*) from assessment_question_interactions where assessment_id = any($1::uuid[]))::int as interactions,
                  (select count(*) from assessment_question_objective_keys k join assessment_question_interactions i on i.question_id=k.question_id where i.assessment_id = any($1::uuid[]))::int as keys,
                  (select count(*) from assessment_attempts where assessment_id = any($1::uuid[]))::int as attempts`,
          [all],
        );
        evidence.actual = counts;
        const plan = plannedHostedWrites();
        const expectedObjective =
          plan.exact.main.assessment_question_interactions +
          plan.exact.review.assessment_question_interactions;
        const problems = [];
        if (
          counts.interactions !== expectedObjective ||
          counts.keys !== expectedObjective
        )
          problems.push("Objective definitions/keys differ from the plan.");
        if (counts.attempts !== plan.run.assessment_attempts)
          problems.push(
            `Attempts ${counts.attempts} differ from the plan (${plan.run.assessment_attempts}).`,
          );
        return verdict(
          "CP2:WRITE_LEDGER",
          problems,
          "Created rows match the reviewed write plan.",
        );
      }),
    );
    return { results, evidence };
  } catch (error) {
    // The seeder can have made durable writes before it throws. Report
    // partial-write uncertainty truthfully and persist bounded evidence.
    const code = classifyExamEngineSetupFailure(error);
    evidence.failure = { stage: setupStage, code, partialWritesPossible: true };
    const remaining = SURFACES.filter(
      (name) => !results.some((r) => r.surface === name),
    );
    for (const [index, name] of remaining.entries()) {
      const reason = `A2 stopped at ${setupStage}; partial synthetic records may exist.`;
      record(
        index === 0
          ? fail(name, reason, [`Failure class: ${code}`])
          : blocked(name, reason),
      );
    }
    return { results, evidence };
  } finally {
    await browser?.close();
    await close();
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, `cp2-exam-engine-${session.runId}.json`),
      JSON.stringify(evidence, null, 2),
      { flag: "wx" },
    );
  }
}

export function examEngineExitCode(results) {
  if (results.length !== SURFACES.length) return 1;
  const seen = new Map(results.map((r) => [r.surface, r.status]));
  return seen.size === SURFACES.length &&
    SURFACES.every((name) => seen.get(name) === "PASS")
    ? 0
    : 1;
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const arg = (name) =>
    process.argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  console.log(
    "===== CP2 hosted exam-engine acceptance (MUTATING, synthetic) =====",
  );
  try {
    const { results } = await runExamEngineAcceptance({
      chromePath: arg("chrome"),
      evidenceDir: arg("evidence"),
    });
    printSummary(results, "CP2 hosted exam-engine acceptance");
    process.exitCode = examEngineExitCode(results);
  } catch {
    console.error("CP2 acceptance did not complete; no successful gate.");
    process.exitCode = 1;
  }
}
