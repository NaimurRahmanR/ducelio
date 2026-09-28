#!/usr/bin/env node
// npm run acceptance:journey
//
// Commercial V1 FULL_CUSTOMER_JOURNEY hosted staged acceptance (docs/38
// section 12). An explicit, operator-run, MUTATING command: it is never
// executed by `npm run acceptance:hosted`, which only points here.
//
// One staged learner journey through the EXISTING production authority
// paths of the real Ducelio app server (`next dev`, loopback only) against
// the dedicated hosted acceptance environment:
//
//   public catalogue/course page (anonymous GET)       -> discoverability
//   examiner-app route SIGN_IN (real SSR session)      -> authentication
//   journey route CREATE_CHECKOUT + reviewer code      -> createCommercialV1Checkout
//       (REVIEWER_COMPLIMENTARY campaign -> governed redemption -> one
//        REVIEWER entitlement + one ACTIVE enrolment; never a direct insert)
//   SAVE/CONFIRM_STUDY_PLAN, GET_DELIVERY_CONTEXT     -> src/server/delivery.ts
//   OPEN_CLASSROOM, PROFESSOR_BEGIN_LESSON/ASK        -> openProfessorClassroom,
//                                                        beginLessonAction/askProfessorAction
//   REQUEST_TUTOR_HANDOFF / REQUEST_PRACTICAL_SUPPORT,
//   TUTOR_LAB_SUPPORT                                 -> requestDeliveryHandoff,
//                                                        requestPracticalSupportAction,
//                                                        requestTutorLabSupportAction
//   START_ASSESSMENT, GET_ACTIVE_QUESTIONS,
//   RECORD_RESPONSE                                    -> src/server/assessments.ts
//   examiner-app route SUBMIT_AND_GRADE_ASSESSMENT     -> submitControlledAssessmentAndGrade
//   examiner-app route RECOVER_EXAMINER_TARGET (admin) -> recoverExaminerTarget
//   SUBMIT_LAB_AND_GRADE                               -> submitPracticalLabWorkAndGrade
//   GET_PROGRESS / ATTEMPT_COMPLETION                  -> getCommercialV1CourseProgress,
//                                                        attemptCommercialV1CourseCompletion
//
// This driver never signs anything, never builds a canonical message, never
// selects a provider/model/capability and never inserts, updates or deletes
// an entitlement, enrolment, attempt, response, submission, execution,
// result revision, receipt or audit row. Every positive-journey result is
// produced by the real application grading/recovery paths; the
// seedAcceptanceResults helper is deliberately NOT used. Fixture setup is
// limited to the SAME gated, governed admin RPCs other acceptance scripts
// use: seedAcceptanceCourse (whose one enrolment is the FOREIGN learner's,
// used only for negative paths), publish_commercial_v1_offer,
// create_commercial_v1_campaign (REVIEWER_COMPLIMENTARY) and
// create_class_session.
//
// Provider: the deterministic loopback stub in journey mode, attested live
// per request by the route gates; every other AI-vendor request is refused
// in the app process. No billable model request is possible. The stub's
// deterministic controls produce the negative paths through production
// code: planFailure() -> a genuine PROVIDER_UNAVAILABLE terminal initial
// grade (MIDTERM), recovered by an institutional admin; planZeroMarks() ->
// a genuine below-pass-mark result set for the foreign learner.
//
// Admission windows: no capacity is pre-computed. A production refusal is
// observed as the product reports it -- an Examiner AUTHORIZE RATE_LIMITED
// surfaces as GRADING_PENDING with no claim row; a Professor/Tutor/Lab
// RATE_LIMITED is persisted as a BLOCKED execution row -- and is reported
// BLOCKED (a prerequisite), never FAIL and never PASS.
//
// Access variant: this run proves the REVIEWER-ENTITLEMENT access variant
// only. Paid checkout, signed webhook fulfilment and payment/webhook replay
// remain separate STRIPE TEST MODE evidence (`npm run acceptance:stripe`);
// no Stripe request is made here and none is claimed.
//
// Timing: six controlled-assessment windows must be strictly sequential
// (publish_commercial_v1_grading_policy), so a full run takes roughly half
// an hour. Everything written is permanent, run-id-tagged institutional
// history; nothing is deleted.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  withConnection,
  withAcceptanceWriteConnection,
  resolveAppUserId,
  AcceptanceWriteNotAuthorizedError,
} from "./db.mjs";
import { assertAcceptanceSupabaseWriteAuthorized } from "./supabase.mjs";
import { seedAcceptanceCourse } from "./fixtures.mjs";
import {
  openExaminerAppSession,
  Q,
  marksFollowRule,
  recordLeaks,
  same,
} from "./examiner-app.mjs";
import { JOURNEY_STUB_TEXT } from "./examiner-provider-stub.mjs";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
} from "./report.mjs";

export const JOURNEY_SURFACES = Object.freeze({
  ACCESS: "FULL_JOURNEY:ACCESS",
  DELIVERY: "FULL_JOURNEY:DELIVERY",
  CLASSROOM: "FULL_JOURNEY:CLASSROOM",
  TUTOR_LAB: "FULL_JOURNEY:TUTOR_LAB",
  ASSESSMENTS: "FULL_JOURNEY:ASSESSMENTS",
  RECOVERY: "FULL_JOURNEY:RECOVERY",
  LAB: "FULL_JOURNEY:LAB",
  PROGRESS_COMPLETION: "FULL_JOURNEY:PROGRESS_COMPLETION",
  NEGATIVE_REPLAY: "FULL_JOURNEY:NEGATIVE_REPLAY",
});
export const AGGREGATE_SURFACE = "FULL_CUSTOMER_JOURNEY";
export const JOURNEY_ROUTE_PATH = "/api/acceptance/customer-journey";
export const COMPONENTS = Object.freeze([
  "QUIZ_1",
  "QUIZ_2",
  "MIDTERM",
  "QUIZ_3",
  "QUIZ_4",
  "FINAL",
]);
// The component whose initial grade is deliberately made terminal
// (PROVIDER_UNAVAILABLE) and then recovered by an institutional admin.
export const RECOVERY_COMPONENT = "MIDTERM";
// Code-owned, never CLI/env input. Windows are strictly sequential and each
// satisfies the governed ASSESSMENT_WINDOW_TOO_SHORT rule
// (window >= duration); a learner may start up to window - duration after
// opening.
export const JOURNEY_SCHEDULE = Object.freeze({
  firstOpensAfterMs: 6 * 60_000,
  windowMinutes: 3,
  durationMinutes: 2,
  startMarginMs: 8_000,
  latestStartSafetyMs: 15_000,
});
export const OFFER_PRICE = Object.freeze({ amountMinor: 100, currency: "GBP" });
export const PASS_MARK_BP = 5000; // fixtures.mjs publish_commercial_v1_result_policy
export const FULL_SCORE_BP = 10000;

// Every negative/replay obligation this run itself must execute.
export const REQUIRED_NEGATIVE_CHECKS = Object.freeze([
  "ACCESS_REPLAY_IDEMPOTENT",
  "FOREIGN_DELIVERY_CONTEXT_DENIED",
  "CLASSROOM_INTERACTION_REPLAY",
  "TUTOR_LAB_INTERACTION_REPLAY",
  "FOREIGN_TUTOR_LAB_DENIED",
  "FOREIGN_RESPONSE_DENIED",
  "FOREIGN_SUBMISSION_DENIED",
  "RESPONSE_REPLAY_IDEMPOTENT",
  "SUBMISSION_REPLAY_IDEMPOTENT",
  "INCOMPLETE_RESULT_COMPLETION_REFUSED",
  "PROVIDER_UNAVAILABLE_FAIL_CLOSED",
  "TERMINAL_INITIAL_GRADE_REQUIRES_RECOVERY",
  "FOREIGN_LAB_SUBMISSION_DENIED",
  "LAB_SUBMISSION_REPLAY_IDEMPOTENT",
  "FOREIGN_PROGRESS_DENIED",
  "FOREIGN_COMPLETION_DENIED",
  "BELOW_PASS_MARK_COMPLETION_REFUSED",
  "COMPLETION_REPLAY_IDEMPOTENT",
]);
// Accounted for, never executed or claimed by this run.
export const SEPARATE_EVIDENCE_NOTE =
  "PAYMENT_WEBHOOK_REPLAY: not executed by this reviewer-entitlement journey (no payment is made). Payment/webhook replay is separate STRIPE TEST MODE evidence from `npm run acceptance:stripe` (STRIPE_TEST:DUPLICATE_WEBHOOK_IDEMPOTENCY, STRIPE_TEST:RECONCILIATION_REPLAY).";

export const TRUTHFULNESS_STATEMENT =
  "This is HOSTED STAGED ACCEPTANCE, not PRODUCTION-PROVEN. A PASS proves one synthetic learner journey through the existing production authority paths of the real Ducelio application server against the dedicated hosted acceptance environment, using the REVIEWER-ENTITLEMENT access variant and a deterministic loopback provider stub. It is not live-provider, grading-quality, Stripe payment/webhook, email-delivery, monitoring, backup/restore, browser/device or production-deployment evidence. Paid checkout and webhook fulfilment remain separate STRIPE TEST MODE evidence.";

// ---------------------------------------------------------------------------
// Pure result logic.
// ---------------------------------------------------------------------------
export class JourneyBlocked extends Error {
  constructor(reason, details = []) {
    super(reason);
    this.name = "JourneyBlocked";
    this.details = details;
  }
}

// One aggregate: PASS only when every named sub-surface PASSed; FAIL when
// any sub-surface FAILed; otherwise BLOCKED. A missing sub-surface is never
// a PASS.
export function aggregateJourney(results) {
  const expected = Object.values(JOURNEY_SURFACES);
  const bySurface = new Map(results.map((r) => [r.surface, r]));
  const failed = expected.filter((s) => bySurface.get(s)?.status === "FAIL");
  if (failed.length)
    return fail(
      AGGREGATE_SURFACE,
      `${failed.length} journey surface(s) violated an expected invariant.`,
      failed,
    );
  const notPassed = expected.filter((s) => bySurface.get(s)?.status !== "PASS");
  if (notPassed.length)
    return blocked(
      AGGREGATE_SURFACE,
      `${notPassed.length} journey surface(s) did not execute to PASS; the full journey is not proven by this run.`,
      notPassed.map((s) => `${s}: ${bySurface.get(s)?.status ?? "MISSING"}`),
    );
  return pass(
    AGGREGATE_SURFACE,
    "Every FULL_JOURNEY sub-surface PASSed in one staged run: hosted staged acceptance of the reviewer-entitlement journey, not PRODUCTION-PROVEN.",
  );
}

export function createNegativeLedger() {
  const entries = new Map();
  return {
    record(name, problems, evidence = []) {
      if (!REQUIRED_NEGATIVE_CHECKS.includes(name))
        throw new Error(`Unknown negative check ${name}.`);
      const prior = entries.get(name);
      const all = [...(prior?.problems ?? []), ...problems];
      entries.set(name, {
        problems: all,
        evidence: [...(prior?.evidence ?? []), ...evidence],
      });
    },
    get: (name) => entries.get(name) ?? null,
    entries: () => new Map(entries),
  };
}

export function evaluateNegativeLedger(ledger) {
  const surface = JOURNEY_SURFACES.NEGATIVE_REPLAY;
  const entries = ledger.entries();
  const details = [];
  const failed = [];
  const missing = [];
  for (const name of REQUIRED_NEGATIVE_CHECKS) {
    const entry = entries.get(name);
    if (!entry) {
      missing.push(name);
      details.push(`${name}: NOT EXECUTED`);
    } else if (entry.problems.length) {
      failed.push(name);
      details.push(`${name}: FAIL -- ${entry.problems.join(" ")}`);
    } else details.push(`${name}: PASS`);
  }
  details.push(SEPARATE_EVIDENCE_NOTE);
  if (failed.length)
    return fail(
      surface,
      `${failed.length} negative/replay check(s) violated an expected invariant.`,
      details,
    );
  if (missing.length)
    return blocked(
      surface,
      `${missing.length} required negative/replay check(s) were not executed because an earlier stage did not run.`,
      details,
    );
  return pass(
    surface,
    "Every required negative/replay check executed in this run and held: access/interaction/response/submission/lab/completion replays created no new history, the foreign learner was refused on every resource, incomplete and below-pass completions were refused, and a provider-unavailable terminal initial grade failed closed and required institutional recovery.",
    details,
  );
}

// Runs the stages in order. A stage whose prerequisite stages did not PASS
// is BLOCKED without executing; an unexpected exception is that stage's
// FAIL; a JourneyBlocked (a production admission/window prerequisite) or a
// write-gate refusal is BLOCKED.
export async function runJourneyStages(stages, { onResult } = {}) {
  const results = [];
  const byKey = new Map();
  for (const stage of stages) {
    const unmet = stage.needs.filter((key) => byKey.get(key) !== "PASS");
    let result;
    if (unmet.length)
      result = blocked(
        stage.surface,
        "Not executed: prerequisite journey surface(s) did not PASS.",
        unmet.map((key) => JOURNEY_SURFACES[key]),
      );
    else result = await guardStage(stage.surface, stage.run);
    byKey.set(stage.key, result.status);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

export async function guardStage(surface, run) {
  try {
    const result = await run();
    if (!result || result.surface !== surface)
      return fail(surface, "The stage returned no result for its surface.");
    return result;
  } catch (error) {
    if (error instanceof JourneyBlocked)
      return blocked(surface, error.message, error.details);
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blocked(surface, error.message);
    return fail(surface, "The stage stopped unexpectedly.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

// Durable access state for the learner + offer, checked independently.
export function accessProblems(snapshot, granted, expected, label) {
  const problems = [];
  const entitlement =
    snapshot.entitlements.length === 1 ? snapshot.entitlements[0] : null;
  const enrolment =
    snapshot.enrolments.length === 1 ? snapshot.enrolments[0] : null;
  const redemption =
    snapshot.redemptions.length === 1 ? snapshot.redemptions[0] : null;
  if (granted?.kind !== "ACCESS_GRANTED")
    problems.push(
      `${label}: the production checkout entrypoint did not report ACCESS_GRANTED.`,
    );
  if (
    !entitlement ||
    entitlement.id !== granted?.entitlementId ||
    entitlement.learner_id !== expected.learnerId ||
    entitlement.offer_id !== expected.offerId ||
    entitlement.activation_id !== expected.activationId ||
    entitlement.source !== "REVIEWER" ||
    entitlement.order_id !== null ||
    entitlement.state !== "ACTIVE" ||
    entitlement.enrolment_id !== enrolment?.id ||
    entitlement.campaign_redemption_id !== redemption?.id
  )
    problems.push(
      `${label}: expected exactly one coherent learner-owned REVIEWER entitlement; found ${snapshot.entitlements.length}.`,
    );
  if (
    !redemption ||
    redemption.campaign_id !== expected.campaignId ||
    redemption.entitlement_source !== "REVIEWER" ||
    redemption.effective_price_amount_minor !== 0
  )
    problems.push(
      `${label}: expected exactly one zero-price REVIEWER redemption of this campaign; found ${snapshot.redemptions.length}.`,
    );
  if (
    !enrolment ||
    enrolment.id !== granted?.enrolmentId ||
    enrolment.status !== "ACTIVE" ||
    enrolment.student_id !== expected.learnerId ||
    enrolment.programme_version_id !== expected.programmeVersionId
  )
    problems.push(
      `${label}: expected exactly one ACTIVE learner enrolment in the offer's cohort; found ${snapshot.enrolments.length}.`,
    );
  if (snapshot.orders !== 0 || snapshot.paymentEvents !== 0)
    problems.push(
      `${label}: a commercial order (${snapshot.orders}) or payment event (${snapshot.paymentEvents}) exists for a complimentary grant.`,
    );
  return problems;
}

// FOREIGN_DELIVERY_CONTEXT_DENIED: exactly the production ownership
// refusal (delivery_private.enrolment's NOT_FOUND_OR_FORBIDDEN, mapped by
// src/server/delivery.ts to DeliveryDenied and by the route to this body).
export function foreignDeliveryDenialProblems(response) {
  const body = response?.body;
  return response?.status === 200 &&
    body?.ok === false &&
    body.error === "DELIVERY_DENIED" &&
    body.code === "NOT_FOUND_OR_FORBIDDEN"
    ? []
    : [
        `The foreign learner's read of another learner's delivery context was not refused NOT_FOUND_OR_FORBIDDEN (HTTP ${response?.status ?? "none"}, ${body?.error ?? "no error"}/${body?.code ?? "no code"}).`,
      ];
}

// FOREIGN_TUTOR_LAB_DENIED: judged only from the foreign probe itself --
// its own response status and what it added to the owner's handoff. Every
// problem names the evidence actually observed.
export function foreignTutorProbeProblems({ status, before, after, ownerId }) {
  const problems = [];
  if (status === "SUCCEEDED" || status === "DUPLICATE")
    problems.push(
      `The foreign learner's Tutor support probe on another learner's handoff returned ${status}.`,
    );
  const reservationKey = (r) => `${r.student_id}:${r.idempotency_key}`;
  const knownReservations = new Set(before.reservations.map(reservationKey));
  const addedReservations = after.reservations.filter(
    (r) => !knownReservations.has(reservationKey(r)),
  );
  if (addedReservations.length)
    problems.push(
      `The foreign probe added ${addedReservations.length} interaction reservation(s) to another learner's Tutor handoff.`,
    );
  const knownExecutions = new Set(before.executions.map((e) => e.id));
  const addedExecutions = after.executions.filter(
    (e) => !knownExecutions.has(e.id),
  );
  if (addedExecutions.length)
    problems.push(
      `The foreign probe added ${addedExecutions.length} provider execution(s) to another learner's Tutor handoff.`,
    );
  const nonOwner = [...after.reservations, ...after.executions].filter(
    (row) => row.student_id !== ownerId,
  );
  if (nonOwner.length)
    problems.push(
      `${nonOwner.length} reservation/execution row(s) on the learner's Tutor handoff are owned by another learner.`,
    );
  return problems;
}

// Durable completion state, checked independently.
export function completionProblems(state, expected, label) {
  const problems = [];
  const receipt = state.receipts.length === 1 ? state.receipts[0] : null;
  if (
    !receipt ||
    receipt.id !== expected.receiptId ||
    receipt.student_id !== expected.learnerId ||
    receipt.completed_by !== expected.learnerId ||
    receipt.final_course_score_bp !== expected.courseScoreBp ||
    receipt.pass_mark_bp !== expected.passMarkBp
  )
    problems.push(
      `${label}: expected exactly one coherent learner completion receipt; found ${state.receipts.length}.`,
    );
  if (state.audits !== 1)
    problems.push(
      `${label}: expected exactly one COMMERCIAL_V1_COURSE_COMPLETED audit event; found ${state.audits}.`,
    );
  if (state.enrolmentStatus !== "COMPLETED")
    problems.push(`${label}: the enrolment is not COMPLETED.`);
  return problems;
}

// ---------------------------------------------------------------------------
// Independent, read-only hosted database reads (privileged acceptance
// connection; SELECT only).
// ---------------------------------------------------------------------------
export const JQ = Object.freeze({
  dbNow: `select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms,
      clock_timestamp() as ts`,
  lessons: "select id from lessons where programme_version_id=$1 order by id",
  // Bounded, read-only: the fixture lesson's own objective ids (never prose).
  lessonObjectives: `select id from lesson_objectives
    where lesson_id=$1 and programme_version_id=$2 order by id limit 2`,
  entitlements: `select id, learner_id, offer_id, activation_id, order_id, enrolment_id, source, campaign_redemption_id, state
    from commercial_v1_entitlements where learner_id=$1 and activation_id=$2`,
  enrolments: `select id, status, student_id, programme_version_id from enrolments where student_id=$1 and cohort_id=$2`,
  redemptions: `select id, campaign_id, entitlement_source, effective_price_amount_minor
    from commercial_v1_campaign_redemptions where learner_id=$1 and offer_id=$2`,
  orders: `select count(*)::int as n from commercial_v1_orders where learner_id=$1 and activation_id=$2`,
  paymentEvents: `select count(*)::int as n from commercial_v1_payment_events p
    join commercial_v1_orders o on o.id=p.order_id where o.learner_id=$1 and o.activation_id=$2`,
  studyPlan: `select id, state, student_id, programme_version_id from delivery_study_plans where enrolment_id=$1`,
  occurrences: `select count(*)::int as n from scheduled_learning_occurrences where enrolment_id=$1`,
  classroomSessions: `select id, student_id, enrolment_id, lesson_id, mode from professor_classroom_sessions
    where class_session_id=$1 and student_id=$2`,
  classroomReservations: `select idempotency_key from professor_classroom_interaction_reservations
    where classroom_id=$1 order by idempotency_key`,
  professorExecutions: `select e.id, e.state, e.reason_code, u.provider_calls
    from academic_provider_executions e left join academic_provider_execution_usage u on u.execution_id=e.id
    where e.student_id=$1 and e.created_at >= $2::timestamptz order by e.created_at`,
  handoff: `select id, enrolment_id, requested_by, destination_profile, reason_code, lesson_id, objective_id
    from delivery_handoffs where id=$1`,
  tutorLabExecutions: `select e.id, e.state, e.reason_code, e.agent_profile, e.student_id, u.provider_calls
    from tutor_lab_provider_executions e
    join tutor_lab_content_releases r on r.id=e.release_id
    left join tutor_lab_provider_execution_usage u on u.execution_id=e.id
    where r.handoff_id=$1`,
  tutorLabRateLimited: `select count(*)::int as n from tutor_lab_provider_executions
    where student_id=$1 and created_at >= $2::timestamptz and state='BLOCKED' and reason_code='RATE_LIMITED'`,
  tutorLabReservations: `select student_id, idempotency_key from tutor_lab_interaction_reservations where handoff_id=$1`,
  attempt: `select id, state, student_id, enrolment_id, assessment_id from assessment_attempts where id=$1`,
  responses: `select question_id, count(*)::int as n from assessment_responses where attempt_id=$1 group by question_id`,
  componentRevisions: `select r.id, r.revision_number, r.attempt_id, r.earned_marks_total, r.max_marks_total,
      commercial_v1_private.assessment_result_is_valid(r.id) as valid,
      (select count(*)::int from commercial_v1_assessment_objective_outcomes o where o.result_revision_id=r.id) as outcome_rows
    from commercial_v1_assessment_result_revisions r
    where r.enrolment_id=$1 and r.component=$2 order by r.revision_number`,
  labSubmissions: `select id, student_id, enrolment_id, practical_id from commercial_v1_lab_submissions where enrolment_id=$1`,
  labExecutions: `select e.id, e.state, e.capability, e.student_id, e.enrolment_id, e.result_revision_id, u.provider_calls
    from commercial_v1_examiner_executions e
    left join commercial_v1_examiner_execution_usage u on u.execution_id=e.id
    where e.submission_id=$1`,
  labRevisions: `select r.id, r.revision_number, r.submission_id, r.earned_marks, r.max_marks,
      commercial_v1_private.lab_result_is_valid(r.id) as valid
    from commercial_v1_lab_result_revisions r where r.enrolment_id=$1 order by r.revision_number`,
  currentResults: `select c.component, r.id, r.weighted_contribution_bp,
      case when r.id is null then null else commercial_v1_private.assessment_result_is_valid(r.id) end as valid
    from unnest(array['QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL']) as c(component)
    left join lateral commercial_v1_private.current_assessment_result($1, c.component) r on true
    order by array_position(array['QUIZ_1','QUIZ_2','MIDTERM','QUIZ_3','QUIZ_4','FINAL'], c.component)`,
  currentLab: `select r.id, r.weighted_contribution_bp,
      case when r.id is null then null else commercial_v1_private.lab_result_is_valid(r.id) end as valid
    from commercial_v1_private.current_lab_result($1, $2) r`,
  receipts: `select id, student_id, completed_by, final_course_score_bp, pass_mark_bp
    from commercial_v1_completion_receipts where enrolment_id=$1`,
  completionAudits: `select count(*)::int as n from audit_events
    where action='COMMERCIAL_V1_COURSE_COMPLETED' and target_id=$1`,
  enrolmentStatus: `select status from enrolments where id=$1`,
});

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function resultOf(response) {
  return response?.status === 200 && response.body?.ok === true
    ? (response.body.result ?? null)
    : null;
}
const granted = (response) => resultOf(response)?.status;
const GRANTED_RECOVERY = ["RECOVERED", "ALREADY_RECOVERED"];

async function fetchPage(baseUrl, jar, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: jar?.size ? { cookie: jar.header() } : {},
  });
  jar?.absorb(response);
  return { status: response.status, text: await response.text() };
}

async function assertWriteGates(adminClient) {
  await assertAcceptanceSupabaseWriteAuthorized(adminClient);
  await withAcceptanceWriteConnection(async () => {});
}

// ---------------------------------------------------------------------------
// Fixture setup through gated, governed admin RPCs only.
// ---------------------------------------------------------------------------
export function componentWindows(firstOpensAt, schedule = JOURNEY_SCHEDULE) {
  const windowMs = schedule.windowMinutes * 60_000;
  const durationMs = schedule.durationMinutes * 60_000;
  return Object.fromEntries(
    COMPONENTS.map((component, index) => {
      const opensAt = firstOpensAt + index * windowMs;
      return [
        component,
        { opensAt, latestStartAt: opensAt + windowMs - durationMs },
      ];
    }),
  );
}

async function setupFixtures(ctx, s) {
  try {
    const dbNow = await ctx.dbNowMs();
    const firstOpensAt = dbNow + JOURNEY_SCHEDULE.firstOpensAfterMs;
    s.course = await seedAcceptanceCourse(
      ctx.adminClient,
      `${ctx.runId}-journey`,
      ctx.foreignAuthUserId,
      {
        journeyAgents: true,
        assessmentDurationMinutes: JOURNEY_SCHEDULE.durationMinutes,
        assessmentSchedule: {
          firstOpensAt,
          windowMinutes: JOURNEY_SCHEDULE.windowMinutes,
        },
      },
    );
    s.windows = componentWindows(firstOpensAt);
    s.course.title = `Acceptance Run ${ctx.runId}-journey`;
    // The seeded enrolment belongs to the FOREIGN learner only.
    s.foreign = {
      studentId: s.course.studentId,
      enrolmentId: s.course.enrolmentId,
    };
    const lessons = await ctx.query(JQ.lessons, [s.course.programmeVersionId]);
    if (lessons.length !== 1)
      throw new Error(
        "The acceptance programme did not have exactly one lesson.",
      );
    s.lessonId = lessons[0].id;
    // OBJECTIVE_REINFORCEMENT needs the lesson's REAL objective (domain
    // handoffInput + migration 043). The fixture has exactly one.
    const objectives = await ctx.query(JQ.lessonObjectives, [
      s.lessonId,
      s.course.programmeVersionId,
    ]);
    if (objectives.length !== 1)
      throw new Error(
        "The acceptance lesson did not have exactly one objective.",
      );
    s.objectiveId = objectives[0].id;

    s.offer = {
      slug: `acceptance-journey-${ctx.runId}`,
      code: `JRN-${ctx.runId.toUpperCase()}`,
    };
    await assertWriteGates(ctx.adminClient);
    const offer = await ctx.adminClient.rpc("publish_commercial_v1_offer", {
      p_activation_id: s.course.activationId,
      p_slug: s.offer.slug,
      p_price_amount_minor: OFFER_PRICE.amountMinor,
      p_currency: OFFER_PRICE.currency,
      p_summary:
        "Synthetic customer-journey acceptance offer. Not a real course, qualification or price.",
      p_delivery_plan: "STANDARD_6_WEEK",
      p_reason: `Customer journey acceptance offer ${ctx.runId}`,
    });
    if (offer.error || typeof offer.data !== "string")
      throw new Error("publish_commercial_v1_offer was refused.");
    s.offer.offerId = offer.data;
    await assertWriteGates(ctx.adminClient);
    const campaign = await ctx.adminClient.rpc(
      "create_commercial_v1_campaign",
      {
        p_offer_slug: s.offer.slug,
        p_code: s.offer.code,
        p_kind: "REVIEWER_COMPLIMENTARY",
        p_percent_off: null,
        p_fixed_price_amount_minor: 0,
        p_max_redemptions: 1,
        p_starts_at: new Date(dbNow - 60_000).toISOString(),
        p_ends_at: new Date(dbNow + 3 * 3600_000).toISOString(),
        p_reason: `Customer journey acceptance reviewer campaign ${ctx.runId}`,
      },
    );
    if (campaign.error || typeof campaign.data !== "string")
      throw new Error("create_commercial_v1_campaign was refused.");
    s.offer.campaignId = campaign.data;
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError) throw error;
    throw new JourneyBlocked(
      "Acceptance fixture setup through the governed admin RPCs did not complete; no journey stage was executed.",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:ACCESS -- discoverability, genuine session, reviewer access.
// ---------------------------------------------------------------------------
async function accessSnapshot(ctx, s) {
  const [entitlements, enrolments, redemptions, orders, events] =
    await Promise.all([
      ctx.query(JQ.entitlements, [s.learnerId, s.course.activationId]),
      ctx.query(JQ.enrolments, [s.learnerId, s.course.cohortId]),
      ctx.query(JQ.redemptions, [s.learnerId, s.offer.offerId]),
      ctx.query(JQ.orders, [s.learnerId, s.course.activationId]),
      ctx.query(JQ.paymentEvents, [s.learnerId, s.course.activationId]),
    ]);
  return {
    entitlements,
    enrolments,
    redemptions,
    orders: orders[0]?.n ?? 0,
    paymentEvents: events[0]?.n ?? 0,
  };
}

export async function stageAccess(ctx, s) {
  const surface = JOURNEY_SURFACES.ACCESS;
  const problems = [];
  const responses = [];
  const evidence = [`offer ${s.offer.slug}`, `campaign ${s.offer.campaignId}`];

  const catalogue = await fetchPage(ctx.baseUrl, null, "/courses");
  const detail = await fetchPage(ctx.baseUrl, null, `/courses/${s.offer.slug}`);
  if (
    catalogue.status !== 200 ||
    !catalogue.text.includes(`href="/courses/${s.offer.slug}"`)
  )
    problems.push("The public course catalogue did not list the offer.");
  if (detail.status !== 200 || !detail.text.includes(s.course.title))
    problems.push("The public course page did not render the offer.");

  const before = await accessSnapshot(ctx, s);
  if (
    before.entitlements.length ||
    before.enrolments.length ||
    before.redemptions.length ||
    before.orders ||
    before.paymentEvents
  )
    return fail(
      surface,
      "The learner already held access to the new offer.",
      evidence,
    );

  const learnerPage = await fetchPage(
    ctx.baseUrl,
    ctx.jars.learner,
    "/student/progress",
  );
  if (learnerPage.status !== 200)
    problems.push(
      `The learner's real app session did not load a protected learner page (HTTP ${learnerPage.status}).`,
    );

  const request = {
    operation: "CREATE_CHECKOUT",
    offerSlug: s.offer.slug,
    campaignCode: s.offer.code,
  };
  const firstResponse = await ctx.journey.call(ctx.jars.learner, request);
  responses.push(firstResponse);
  const first = resultOf(firstResponse);
  const expected = {
    learnerId: s.learnerId,
    offerId: s.offer.offerId,
    activationId: s.course.activationId,
    campaignId: s.offer.campaignId,
    programmeVersionId: s.course.programmeVersionId,
  };
  const after = await accessSnapshot(ctx, s);
  problems.push(...accessProblems(after, first, expected, "First redemption"));

  const replayResponse = await ctx.journey.call(ctx.jars.learner, request);
  responses.push(replayResponse);
  const replay = resultOf(replayResponse);
  const replayed = await accessSnapshot(ctx, s);
  const replayProblems = accessProblems(replayed, first, expected, "Replay");
  if (
    replay?.kind !== "ACCESS_GRANTED" ||
    replay.entitlementId !== first?.entitlementId ||
    replay.enrolmentId !== first?.enrolmentId ||
    !same(after, replayed)
  )
    replayProblems.push(
      "Replaying the reviewer code did not return the same entitlement and enrolment without new history.",
    );
  ctx.negatives.record("ACCESS_REPLAY_IDEMPOTENT", replayProblems);

  const entitledView = await fetchPage(
    ctx.baseUrl,
    ctx.jars.learner,
    `/courses/${s.offer.slug}`,
  );
  if (!entitledView.text.includes("You already have access to this course."))
    problems.push("The real course page did not show the learner as entitled.");
  recordLeaks(problems, [
    ...responses,
    catalogue,
    detail,
    learnerPage,
    entitledView,
  ]);

  s.enrolmentId = after.enrolments.length === 1 ? after.enrolments[0].id : null;
  evidence.push(
    `entitlement ${first?.entitlementId ?? "none"} source=REVIEWER`,
    `enrolment ${first?.enrolmentId ?? "none"}`,
    `orders=${after.orders} paymentEvents=${after.paymentEvents}`,
  );
  return problems.length || replayProblems.length || !s.enrolmentId
    ? fail(
        surface,
        "Reviewer-entitlement access did not meet every invariant.",
        [...evidence, ...problems, ...replayProblems],
      )
    : pass(
        surface,
        "The offer was discoverable on the real public pages; a genuine hosted session redeemed a REVIEWER_COMPLIMENTARY code through the production checkout entrypoint, producing exactly one learner-owned REVIEWER entitlement and one ACTIVE enrolment with no order or payment event; replay reused the same access.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:DELIVERY
// ---------------------------------------------------------------------------
export async function stageDelivery(ctx, s) {
  const surface = JOURNEY_SURFACES.DELIVERY;
  const problems = [];
  const responses = [];
  const call = async (jar, payload) => {
    const response = await ctx.journey.call(jar, payload);
    responses.push(response);
    return response;
  };
  const enrolmentId = s.enrolmentId;
  const saved = resultOf(
    await call(ctx.jars.learner, {
      operation: "SAVE_STUDY_PLAN",
      enrolmentId,
      studyDays: [1, 2, 3, 4, 5, 6, 7],
      localStartTime: "19:00",
      timezone: "Europe/London",
    }),
  );
  const confirmed = resultOf(
    await call(ctx.jars.learner, {
      operation: "CONFIRM_STUDY_PLAN",
      enrolmentId,
    }),
  );
  const reconfirmed = resultOf(
    await call(ctx.jars.learner, {
      operation: "CONFIRM_STUDY_PLAN",
      enrolmentId,
    }),
  );
  if (
    !saved?.planId ||
    confirmed?.planId !== saved.planId ||
    reconfirmed?.planId !== saved.planId
  )
    problems.push(
      "Saving/confirming the study plan did not converge on one plan.",
    );

  const context = resultOf(
    await call(ctx.jars.learner, {
      operation: "GET_DELIVERY_CONTEXT",
      enrolmentId,
    }),
  );
  if (
    context?.enrolmentId !== enrolmentId ||
    context.enrolmentStatus !== "ACTIVE" ||
    context.academicEligibility !== "SUBJECT_TO_ACTIVITY" ||
    context.planId !== saved?.planId ||
    context.planState !== "CONFIRMED" ||
    context.planProgrammeVersionId !== s.course.programmeVersionId ||
    context.occurrenceCount < 1 ||
    !context.occurrenceLessonIds.every((id) => id === s.lessonId)
  )
    problems.push(
      "The learner delivery context is not a usable confirmed plan for this enrolment.",
    );
  const access = resultOf(
    await call(ctx.jars.learner, {
      operation: "GET_AGENT_ACCESS",
      enrolmentId,
    }),
  );
  if (
    access?.PROFESSOR !== "AVAILABLE" ||
    access.TUTOR !== "AVAILABLE" ||
    access.LAB_INSTRUCTOR !== "AVAILABLE"
  )
    problems.push("Professor/Tutor/Lab delivery access is not AVAILABLE.");

  const plans = await ctx.query(JQ.studyPlan, [enrolmentId]);
  const plan = plans.length === 1 ? plans[0] : null;
  const occurrences =
    (await ctx.query(JQ.occurrences, [enrolmentId]))[0]?.n ?? 0;
  if (
    !plan ||
    plan.id !== saved?.planId ||
    plan.state !== "CONFIRMED" ||
    plan.student_id !== s.learnerId ||
    plan.programme_version_id !== s.course.programmeVersionId ||
    occurrences < 1
  )
    problems.push(
      `Expected one CONFIRMED learner-owned study plan with scheduled occurrences; found ${plans.length} plan(s), ${occurrences} occurrence(s).`,
    );

  // Foreign learner: another learner's delivery context is not readable.
  const foreign = await call(ctx.jars.foreign, {
    operation: "GET_DELIVERY_CONTEXT",
    enrolmentId,
  });
  // Only the exact production ownership refusal counts: an unrelated
  // denial (e.g. SERVICE_UNAVAILABLE) proves nothing about ownership. The
  // SAME problems gate this surface, whose PASS claims the refusal.
  const foreignProblems = foreignDeliveryDenialProblems(foreign);
  ctx.negatives.record("FOREIGN_DELIVERY_CONTEXT_DENIED", foreignProblems);
  problems.push(...foreignProblems);
  recordLeaks(problems, responses);

  const evidence = [
    `study plan ${saved?.planId ?? "none"}`,
    `occurrences ${occurrences}`,
  ];
  return problems.length
    ? fail(surface, "Delivery setup did not meet every invariant.", [
        ...evidence,
        ...problems,
      ])
    : pass(
        surface,
        "The learner saved and confirmed a study plan through the governed delivery authority (confirm replay converged on the same plan), received a usable CONFIRMED delivery context for exactly this enrolment and programme version, and Professor/Tutor/Lab access is AVAILABLE; the foreign learner was refused.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:CLASSROOM
// ---------------------------------------------------------------------------
export async function stageClassroom(ctx, s) {
  const surface = JOURNEY_SURFACES.CLASSROOM;
  const problems = [];
  const responses = [];
  const call = async (payload) => {
    const response = await ctx.journey.call(ctx.jars.learner, payload);
    responses.push(response);
    return response;
  };
  // Scheduling is institutional setup through the governed admin RPC. A
  // short window just in the past (CATCH_UP) REDUCES the risk of colliding
  // with another run's session for the shared acceptance instructor; it
  // does not rule it out (a fast rerun after an interrupted run can still
  // overlap). The RPC's own overlap refusal is then reported BLOCKED.
  const dbNow = await ctx.dbNowMs();
  await assertWriteGates(ctx.adminClient);
  const scheduled = await ctx.adminClient.rpc("create_class_session", {
    p_cohort_id: s.course.cohortId,
    p_lesson_id: s.lessonId,
    p_instructor_id: s.course.instructorId,
    p_scheduled_start: new Date(dbNow - 180_000).toISOString(),
    p_scheduled_end: new Date(dbNow - 120_000).toISOString(),
    p_reason: `Customer journey acceptance class ${ctx.runId}`,
  });
  if (scheduled.error || typeof scheduled.data !== "string")
    throw new JourneyBlocked(
      "The governed admin scheduling RPC refused the acceptance class session (e.g. an overlapping recent acceptance session for the shared instructor); rerun later.",
    );
  s.classSessionId = scheduled.data;
  const since = (await ctx.query(JQ.dbNow, []))[0].ts;
  const stubBefore = ctx.stub.calls.length;

  const opened = resultOf(
    await call({
      operation: "OPEN_CLASSROOM",
      classSessionId: s.classSessionId,
    }),
  );
  if (
    !opened?.classroomId ||
    opened.classSessionId !== s.classSessionId ||
    opened.enrolmentId !== s.enrolmentId ||
    opened.lessonId !== s.lessonId ||
    opened.mode !== "CATCH_UP"
  )
    problems.push(
      "Opening the classroom did not resolve this learner's own enrolment and lesson.",
    );

  const beginKey = `journey-${ctx.runId}-begin`;
  const askKey = `journey-${ctx.runId}-ask`;
  const begin = resultOf(
    await call({
      operation: "PROFESSOR_BEGIN_LESSON",
      classSessionId: s.classSessionId,
      idempotencyKey: beginKey,
    }),
  );
  const ask = resultOf(
    await call({
      operation: "PROFESSOR_ASK",
      classSessionId: s.classSessionId,
      idempotencyKey: askKey,
      message: "Synthetic acceptance learner question.",
    }),
  );
  const executions = await ctx.query(JQ.professorExecutions, [
    s.learnerId,
    since,
  ]);
  if (executions.some((e) => e.reason_code === "RATE_LIMITED"))
    throw new JourneyBlocked(
      "The production Professor admission window refused this learner (RATE_LIMITED, persisted by the product); rerun once it has capacity.",
    );
  for (const [label, outcome] of [
    ["Begin lesson", begin],
    ["Ask", ask],
  ])
    if (
      outcome?.status !== "SUCCEEDED" ||
      outcome.text !== JOURNEY_STUB_TEXT.PROFESSOR
    )
      problems.push(
        `${label} did not return SUCCEEDED through the governed Professor path (${outcome?.status ?? "no result"}).`,
      );

  const replay = resultOf(
    await call({
      operation: "PROFESSOR_BEGIN_LESSON",
      classSessionId: s.classSessionId,
      idempotencyKey: beginKey,
    }),
  );
  const rows = await ctx.query(JQ.classroomSessions, [
    s.classSessionId,
    s.learnerId,
  ]);
  const classroom = rows.length === 1 ? rows[0] : null;
  if (
    !classroom ||
    classroom.id !== opened?.classroomId ||
    classroom.enrolment_id !== s.enrolmentId ||
    classroom.lesson_id !== s.lessonId
  )
    problems.push("Expected exactly one durable learner-owned classroom row.");
  const reservations = classroom
    ? (await ctx.query(JQ.classroomReservations, [classroom.id])).map(
        (r) => r.idempotency_key,
      )
    : [];
  const after = await ctx.query(JQ.professorExecutions, [s.learnerId, since]);
  if (
    after.length !== 2 ||
    after.some((e) => e.state !== "SUCCEEDED" || e.provider_calls !== 1)
  )
    problems.push(
      `Expected exactly two SUCCEEDED governed Professor executions with one provider call each; found ${after.length}.`,
    );
  const professorCalls = ctx.stub.calls
    .slice(stubBefore)
    .filter((c) => c.role === "PROFESSOR");
  if (
    professorCalls.length !== 2 ||
    professorCalls.some(
      (c) => c.transport !== "OPENAI" || c.model !== "gpt-5.6-terra",
    )
  )
    problems.push(
      `Expected two stubbed Professor provider calls on the PROFESSOR_COMMERCIAL_V1 profile; saw ${professorCalls.length}.`,
    );
  // The SAME problems gate this surface, whose PASS claims the replay.
  const replayProblems =
    replay?.status === "DUPLICATE" &&
    same(reservations, [askKey, beginKey].sort())
      ? []
      : [
          "Replaying a classroom interaction key was not a DUPLICATE with exactly the two original reservations.",
        ];
  ctx.negatives.record("CLASSROOM_INTERACTION_REPLAY", replayProblems);
  problems.push(...replayProblems);
  recordLeaks(problems, responses);

  const evidence = [
    `class session ${s.classSessionId}`,
    `classroom ${opened?.classroomId ?? "none"}`,
    `professor executions ${after.map((e) => e.id).join(",") || "none"}`,
  ];
  return problems.length
    ? fail(surface, "The classroom did not meet every invariant.", [
        ...evidence,
        ...problems,
      ])
    : pass(
        surface,
        "A real ClassSession classroom was opened for this learner's own enrolment; Begin/Ask ran through the learner Professor Server Actions and the governed provider-execution authority (two SUCCEEDED executions, one stubbed call each on the Professor profile), and a replayed key was a DUPLICATE with no new reservation, execution or provider call.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:TUTOR_LAB
// ---------------------------------------------------------------------------
export async function stageTutorLab(ctx, s) {
  const surface = JOURNEY_SURFACES.TUTOR_LAB;
  const problems = [];
  const responses = [];
  const call = async (jar, payload) => {
    const response = await ctx.journey.call(jar, payload);
    responses.push(response);
    return response;
  };
  const since = (await ctx.query(JQ.dbNow, []))[0].ts;
  const stubBefore = ctx.stub.calls.length;
  const tutorHandoff = resultOf(
    await call(ctx.jars.learner, {
      operation: "REQUEST_TUTOR_HANDOFF",
      enrolmentId: s.enrolmentId,
      lessonId: s.lessonId,
      objectiveId: s.objectiveId,
    }),
  )?.handoffId;
  const labHandoff = resultOf(
    await call(ctx.jars.learner, {
      operation: "REQUEST_PRACTICAL_SUPPORT",
      enrolmentId: s.enrolmentId,
      practicalId: s.course.practicalId,
      requestId: randomUUID(),
    }),
  )?.handoffId;
  if (!tutorHandoff || !labHandoff)
    return fail(
      surface,
      "The learner could not open Tutor/Lab handoffs through the governed paths.",
    );

  // [role, handoff, transport, model, reason, expected objective]: practical
  // support is lesson-level (request_practical_support passes no objective).
  const cases = [
    [
      "TUTOR",
      tutorHandoff,
      "OPENAI",
      "gpt-5.6-luna",
      "OBJECTIVE_REINFORCEMENT",
      s.objectiveId,
    ],
    [
      "LAB_INSTRUCTOR",
      labHandoff,
      "ANTHROPIC",
      "claude-sonnet-5",
      "PRACTICAL_HELP",
      null,
    ],
  ];
  const replayProblems = [];
  for (const [
    role,
    handoffId,
    transport,
    model,
    reason,
    objectiveId,
  ] of cases) {
    const key = randomUUID();
    const payload = {
      operation: "TUTOR_LAB_SUPPORT",
      handoffId,
      message: `Synthetic acceptance ${role.toLowerCase()} question.`,
      idempotencyKey: key,
    };
    const first = resultOf(await call(ctx.jars.learner, payload));
    if (
      (await ctx.query(JQ.tutorLabRateLimited, [s.learnerId, since]))[0]?.n > 0
    )
      throw new JourneyBlocked(
        "The production Tutor/Lab admission window refused this learner (RATE_LIMITED, persisted by the product); rerun once it has capacity.",
      );
    const replay = resultOf(await call(ctx.jars.learner, payload));
    const handoff = (await ctx.query(JQ.handoff, [handoffId]))[0];
    const executions = await ctx.query(JQ.tutorLabExecutions, [handoffId]);
    const calls = ctx.stub.calls
      .slice(stubBefore)
      .filter((c) => c.role === role);
    if (
      first?.status !== "SUCCEEDED" ||
      first.role !== role ||
      first.text !== JOURNEY_STUB_TEXT[role]
    )
      problems.push(
        `${role} support did not return SUCCEEDED from the governed path (${first?.status ?? "no result"}).`,
      );
    if (
      handoff?.enrolment_id !== s.enrolmentId ||
      handoff.requested_by !== s.learnerId ||
      handoff.destination_profile !== role ||
      handoff.reason_code !== reason ||
      handoff.lesson_id !== s.lessonId ||
      handoff.objective_id !== objectiveId
    )
      problems.push(
        `The ${role} handoff is not a learner-owned ${reason} handoff for the fixture lesson${objectiveId ? " and objective" : ""} with a server-derived ${role} destination.`,
      );
    if (
      executions.length !== 1 ||
      executions[0].state !== "SUCCEEDED" ||
      executions[0].agent_profile !== role ||
      executions[0].student_id !== s.learnerId ||
      executions[0].provider_calls !== 1
    )
      problems.push(
        `Expected exactly one SUCCEEDED ${role} execution for its handoff; found ${executions.length}.`,
      );
    if (
      calls.length !== 1 ||
      calls[0].transport !== transport ||
      calls[0].model !== model
    )
      problems.push(
        `Expected one stubbed ${role} provider call on its own profile; saw ${calls.length}.`,
      );
    if (replay?.status !== "DUPLICATE")
      replayProblems.push(
        `Replaying the ${role} support key was not a DUPLICATE.`,
      );
  }
  ctx.negatives.record("TUTOR_LAB_INTERACTION_REPLAY", replayProblems);

  // Foreign probe, measured ONLY by what the probe itself did: a snapshot of
  // the handoff's reservations/executions before and after. The owner's own
  // execution count is the positive path's invariant (checked above), never
  // re-labelled here as a foreign isolation breach.
  const snapshot = async () => ({
    reservations: await ctx.query(JQ.tutorLabReservations, [tutorHandoff]),
    executions: await ctx.query(JQ.tutorLabExecutions, [tutorHandoff]),
  });
  const beforeProbe = await snapshot();
  const foreign = resultOf(
    await call(ctx.jars.foreign, {
      operation: "TUTOR_LAB_SUPPORT",
      handoffId: tutorHandoff,
      message: "Synthetic foreign learner question.",
      idempotencyKey: randomUUID(),
    }),
  );
  const afterProbe = await snapshot();
  // The SAME problems gate this surface, whose PASS claims the refusal.
  const foreignProblems = foreignTutorProbeProblems({
    status: foreign?.status ?? null,
    before: beforeProbe,
    after: afterProbe,
    ownerId: s.learnerId,
  });
  ctx.negatives.record("FOREIGN_TUTOR_LAB_DENIED", foreignProblems);
  recordLeaks(problems, responses);

  const evidence = [
    `tutor handoff ${tutorHandoff}`,
    `lab handoff ${labHandoff}`,
  ];
  return problems.length || replayProblems.length || foreignProblems.length
    ? fail(surface, "Tutor/Lab support did not meet every invariant.", [
        ...evidence,
        ...problems,
        ...replayProblems,
        ...foreignProblems,
      ])
    : pass(
        surface,
        "Learner-requested Tutor and Lab handoffs each ran once through the learner Server Action and the governed Tutor/Lab execution authority, with the destination role derived server-side (Tutor on its OpenAI profile, Lab Instructor on its Anthropic profile, both stubbed); replayed keys were DUPLICATE and the foreign learner was refused.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:ASSESSMENTS (+ RECOVERY at RECOVERY_COMPONENT).
// ---------------------------------------------------------------------------
async function sleepUntilDb(ctx, targetMs, label) {
  for (;;) {
    const now = await ctx.dbNowMs();
    if (now >= targetMs) return;
    const wait = Math.min(targetMs - now, 30_000);
    ctx.log(`    waiting ${Math.ceil((targetMs - now) / 1000)} s for ${label}`);
    await ctx.sleep(wait);
  }
}

async function start(ctx, jar, assessmentId, responses) {
  const response = await ctx.journey.call(jar, {
    operation: "START_ASSESSMENT",
    assessmentId,
  });
  responses.push(response);
  return resultOf(response)?.attemptId ?? null;
}

async function activeQuestions(ctx, jar, responses) {
  const response = await ctx.journey.call(jar, {
    operation: "GET_ACTIVE_QUESTIONS",
  });
  responses.push(response);
  return resultOf(response);
}

async function answer(ctx, jar, attemptId, questions, responses, tag) {
  const recorded = [];
  for (const question of questions) {
    const payload = {
      operation: "RECORD_RESPONSE",
      attemptId,
      questionId: question.id,
      body: "Synthetic acceptance learner response.",
      idempotencyKey: `journey-${tag}-${question.id}`,
    };
    const response = await ctx.journey.call(jar, payload);
    responses.push(response);
    recorded.push({ payload, result: resultOf(response) });
  }
  return recorded;
}

async function submitAndGrade(ctx, jar, attemptId, responses) {
  const response = await ctx.app.call(jar, {
    operation: "SUBMIT_AND_GRADE_ASSESSMENT",
    attemptId,
  });
  responses.push(response);
  return resultOf(response)?.grading ?? null;
}

// GRADING_PENDING with no claim row is the product's own report of an
// Examiner admission refusal (RATE_LIMITED / an already-active claim).
async function blockIfAdmissionRefused(ctx, grading, targetRows, label) {
  if (grading === "GRADING_PENDING" && targetRows.length === 0) {
    ctx.stub.clearPlans();
    throw new JourneyBlocked(
      `The production Examiner admission refused ${label} (reported GRADING_PENDING with no claim); rerun once the learner's admission window has capacity.`,
    );
  }
}

async function verifyGradedComponent(
  ctx,
  s,
  component,
  attemptId,
  enrolmentId,
  studentId,
  zero,
) {
  const problems = [];
  const executions = await ctx.query(Q.initialExecutions, [attemptId]);
  const execution = executions.length === 1 ? executions[0] : null;
  if (
    !execution ||
    execution.state !== "SUCCEEDED" ||
    execution.student_id !== studentId ||
    execution.enrolment_id !== enrolmentId ||
    execution.capability !== "grade_controlled_assessment" ||
    execution.runtime_profile_ref !== "EXAMINER_COMMERCIAL_V1" ||
    execution.provider_calls !== 1
  )
    problems.push(
      `${component}: expected exactly one coherent SUCCEEDED initial Examiner execution; found ${executions.length}.`,
    );
  const revisions = await ctx.query(JQ.componentRevisions, [
    enrolmentId,
    component,
  ]);
  const revision = revisions.length === 1 ? revisions[0] : null;
  const questionCount = (
    await ctx.query(Q.questionCount, [
      s.course.assessmentIdsByComponent[component],
    ])
  )[0]?.n;
  if (
    !revision ||
    revision.id !== execution?.result_revision_id ||
    revision.revision_number !== 1 ||
    revision.attempt_id !== attemptId ||
    revision.valid !== true ||
    revision.outcome_rows < 1 ||
    revision.earned_marks_total !== (zero ? 0 : revision.max_marks_total)
  )
    problems.push(
      `${component}: expected exactly one valid revision 1 produced by the real grading FINALIZE; found ${revisions.length}.`,
    );
  else if (!zero) {
    const marks = await marksFollowRule(
      ctx,
      revision.id,
      "grade_controlled_assessment",
    );
    if (marks.rows !== questionCount || !marks.matches)
      problems.push(
        `${component}: the revision's question marks do not match the provider output.`,
      );
  }
  const attempt = (await ctx.query(JQ.attempt, [attemptId]))[0];
  if (
    attempt?.state !== "SUBMITTED" ||
    attempt.student_id !== studentId ||
    attempt.enrolment_id !== enrolmentId
  )
    problems.push(
      `${component}: the attempt is not a SUBMITTED attempt owned by its learner.`,
    );
  return { problems, revision };
}

export async function stageAssessments(ctx, s) {
  const surface = JOURNEY_SURFACES.ASSESSMENTS;
  const problems = [];
  const responses = [];
  const evidence = [];
  s.foreignProblems = [];
  for (const component of COMPONENTS) {
    ctx.stub.clearPlans();
    const window = s.windows[component];
    const assessmentId = s.course.assessmentIdsByComponent[component];
    if (
      (await ctx.dbNowMs()) >
      window.latestStartAt - JOURNEY_SCHEDULE.latestStartSafetyMs
    )
      throw new JourneyBlocked(
        `The ${component} assessment window passed its latest start before the journey reached it (setup ran long); rerun.`,
      );
    if (component === "QUIZ_1") {
      const idle = await activeQuestions(ctx, ctx.jars.learner, responses);
      if (idle?.activeAttemptId !== null || idle.questions.length !== 0)
        problems.push(
          "Questions were released before the learner started an attempt.",
        );
    }
    await sleepUntilDb(
      ctx,
      window.opensAt + JOURNEY_SCHEDULE.startMarginMs,
      `${component} to open`,
    );

    const attemptId = await start(
      ctx,
      ctx.jars.learner,
      assessmentId,
      responses,
    );
    const foreignAttemptId = await start(
      ctx,
      ctx.jars.foreign,
      assessmentId,
      responses,
    );
    if (!attemptId) {
      problems.push(
        `${component}: the learner could not start the attempt in its open window.`,
      );
      break;
    }
    if (!foreignAttemptId)
      s.foreignProblems.push(
        `${component}: the foreign learner could not start.`,
      );
    const released = await activeQuestions(ctx, ctx.jars.learner, responses);
    const questionCount = (await ctx.query(Q.questionCount, [assessmentId]))[0]
      ?.n;
    if (
      released?.activeAttemptId !== attemptId ||
      released.activeAssessmentId !== assessmentId ||
      released.activityState !== "CONTROLLED_ASSESSMENT_ACTIVE" ||
      released.questions.length !== questionCount
    ) {
      problems.push(
        `${component}: the learner-safe question release does not match the active attempt.`,
      );
      break;
    }
    if (component === "QUIZ_1") {
      const firewall = resultOf(
        await ctx.journey.call(ctx.jars.learner, {
          operation: "GET_AGENT_ACCESS",
          enrolmentId: s.enrolmentId,
        }),
      );
      if (firewall?.PROFESSOR !== "ACTIVITY_BLOCKED")
        problems.push(
          "The controlled-assessment firewall did not block Professor access during the active attempt.",
        );
      // Foreign learner against this learner's ACTIVE attempt.
      const foreignRecord = resultOf(
        await ctx.journey.call(ctx.jars.foreign, {
          operation: "RECORD_RESPONSE",
          attemptId,
          questionId: released.questions[0].id,
          body: "Synthetic foreign learner response.",
          idempotencyKey: `journey-foreign-${randomUUID()}`,
        }),
      );
      ctx.negatives.record(
        "FOREIGN_RESPONSE_DENIED",
        foreignRecord?.ok === false &&
          foreignRecord.code === "NOT_FOUND_OR_FORBIDDEN" &&
          (await ctx.query(JQ.responses, [attemptId])).length === 0
          ? []
          : [
              "The foreign learner's response on another learner's attempt was not refused NOT_FOUND_OR_FORBIDDEN with no row.",
            ],
      );
      const foreignSubmit = await ctx.app.call(ctx.jars.foreign, {
        operation: "SUBMIT_AND_GRADE_ASSESSMENT",
        attemptId,
      });
      responses.push(foreignSubmit);
      const stillActive =
        (await ctx.query(JQ.attempt, [attemptId]))[0]?.state === "ACTIVE";
      const claims = await ctx.query(Q.initialExecutions, [attemptId]);
      ctx.negatives.record(
        "FOREIGN_SUBMISSION_DENIED",
        resultOf(foreignSubmit) === null && stillActive && claims.length === 0
          ? []
          : [
              "The foreign learner could submit or grade another learner's attempt.",
            ],
      );
    }

    const recorded = await answer(
      ctx,
      ctx.jars.learner,
      attemptId,
      released.questions,
      responses,
      `${ctx.runId}-${component}`,
    );
    if (recorded.some((r) => r.result?.ok !== true)) {
      problems.push(
        `${component}: the governed response writer refused the learner's own response.`,
      );
      break;
    }
    if (component === "QUIZ_1") {
      const [first] = recorded;
      const replay = resultOf(
        await ctx.journey.call(ctx.jars.learner, first.payload),
      );
      const conflict = resultOf(
        await ctx.journey.call(ctx.jars.learner, {
          ...first.payload,
          body: "A different body.",
        }),
      );
      const counts = await ctx.query(JQ.responses, [attemptId]);
      ctx.negatives.record(
        "RESPONSE_REPLAY_IDEMPOTENT",
        replay?.ok === true &&
          replay.responseId === first.result.responseId &&
          conflict?.ok === false &&
          conflict.code === "IDEMPOTENCY_CONFLICT" &&
          counts.length === released.questions.length &&
          counts.every((c) => c.n === 1)
          ? []
          : [
              "Replaying a response did not return the same response (or a conflicting replay was not refused) without a new row.",
            ],
      );
    }

    const recovery = component === RECOVERY_COMPONENT;
    if (recovery) ctx.stub.planFailure();
    const stubBefore = ctx.stub.calls.length;
    const grading = await submitAndGrade(
      ctx,
      ctx.jars.learner,
      attemptId,
      responses,
    );
    const claims = await ctx.query(Q.initialExecutions, [attemptId]);
    await blockIfAdmissionRefused(
      ctx,
      grading,
      claims,
      `the learner's ${component} grading`,
    );
    if (recovery) {
      // RECOVERY reports its own result; the remaining components still run.
      s.recoveryResult = await guardStage(JOURNEY_SURFACES.RECOVERY, () =>
        recoverTerminalGrade(
          ctx,
          s,
          attemptId,
          grading,
          claims,
          stubBefore,
          responses,
        ),
      );
    } else {
      if (grading !== "GRADED")
        problems.push(
          `${component}: the real submission/grading composition reported ${grading ?? "no result"}.`,
        );
      const verified = await verifyGradedComponent(
        ctx,
        s,
        component,
        attemptId,
        s.enrolmentId,
        s.learnerId,
        false,
      );
      problems.push(...verified.problems);
      evidence.push(
        `${component} attempt ${attemptId} revision ${verified.revision?.id ?? "none"}`,
      );
      if (component === "QUIZ_1") {
        const replayGrading = await submitAndGrade(
          ctx,
          ctx.jars.learner,
          attemptId,
          responses,
        );
        const replayClaims = await ctx.query(Q.initialExecutions, [attemptId]);
        const replayRevisions = await ctx.query(JQ.componentRevisions, [
          s.enrolmentId,
          component,
        ]);
        ctx.negatives.record(
          "SUBMISSION_REPLAY_IDEMPOTENT",
          replayGrading === "GRADED" &&
            replayClaims.length === 1 &&
            replayRevisions.length === 1 &&
            ctx.stub.calls.length === stubBefore + 1
            ? []
            : [
                "Replaying submit-and-grade created new execution/result/provider history or did not return GRADED.",
              ],
        );
        const incomplete = resultOf(
          await ctx.journey.call(ctx.jars.learner, {
            operation: "ATTEMPT_COMPLETION",
            enrolmentId: s.enrolmentId,
            reason: `Customer journey acceptance early completion ${ctx.runId}`,
          }),
        );
        const status = (await ctx.query(JQ.enrolmentStatus, [s.enrolmentId]))[0]
          ?.status;
        const receipts = await ctx.query(JQ.receipts, [s.enrolmentId]);
        ctx.negatives.record(
          "INCOMPLETE_RESULT_COMPLETION_REFUSED",
          incomplete?.ok === false &&
            incomplete.code === "COMPONENTS_INCOMPLETE" &&
            status === "ACTIVE" &&
            receipts.length === 0
            ? []
            : [
                "Completion with an incomplete result set was not refused COMPONENTS_INCOMPLETE without a receipt.",
              ],
        );
      }
    }
    if (problems.length) break;

    // Foreign learner: its own attempt, graded zero through production
    // grading (deterministic stub control), for the below-pass-mark path.
    if (foreignAttemptId) {
      const foreignQuestions = await activeQuestions(
        ctx,
        ctx.jars.foreign,
        responses,
      );
      const foreignRecorded = await answer(
        ctx,
        ctx.jars.foreign,
        foreignAttemptId,
        foreignQuestions?.questions ?? [],
        responses,
        `${ctx.runId}-foreign-${component}`,
      );
      ctx.stub.planZeroMarks();
      const foreignBefore = ctx.stub.calls.length;
      const foreignGrading = await submitAndGrade(
        ctx,
        ctx.jars.foreign,
        foreignAttemptId,
        responses,
      );
      const zeroCall = ctx.stub.calls.slice(foreignBefore);
      const foreignClaims = await ctx.query(Q.initialExecutions, [
        foreignAttemptId,
      ]);
      await blockIfAdmissionRefused(
        ctx,
        foreignGrading,
        foreignClaims,
        `the foreign learner's ${component} grading`,
      );
      const verified = await verifyGradedComponent(
        ctx,
        s,
        component,
        foreignAttemptId,
        s.foreign.enrolmentId,
        s.foreign.studentId,
        true,
      );
      if (
        foreignRecorded.some((r) => r.result?.ok !== true) ||
        foreignGrading !== "GRADED" ||
        zeroCall.length !== 1 ||
        zeroCall[0].attemptId !== foreignAttemptId ||
        zeroCall[0].zeroMarks !== true
      )
        s.foreignProblems.push(
          `${component}: the foreign learner's zero-mark grading did not run as planned.`,
        );
      s.foreignProblems.push(...verified.problems);
    }
  }
  ctx.stub.clearPlans();
  recordLeaks(problems, responses);
  if (!s.recoveryResult)
    s.recoveryResult = blocked(
      JOURNEY_SURFACES.RECOVERY,
      `Not reached: ${RECOVERY_COMPONENT} was not submitted in this run.`,
    );
  return problems.length
    ? fail(
        surface,
        "The controlled assessments did not meet every invariant.",
        [...evidence, ...problems],
      )
    : pass(
        surface,
        `Every component was started in its real open window through the learner path, learner-safe questions were released only for the active attempt (with the controlled-assessment firewall active), responses were recorded by the governed writer, and ${COMPONENTS.length - 1} components were submitted and graded by the real production composition, each with exactly one SUCCEEDED Examiner execution and one valid revision 1 (${RECOVERY_COMPONENT} is reported under FULL_JOURNEY:RECOVERY).`,
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:RECOVERY -- a genuinely terminal initial grade (the stub's
// planned 503 -> PROVIDER_UNAVAILABLE), recovered by an institutional
// admin through recoverExaminerTarget.
// ---------------------------------------------------------------------------
async function recoverTerminalGrade(
  ctx,
  s,
  attemptId,
  grading,
  claims,
  stubBefore,
  responses,
) {
  const surface = JOURNEY_SURFACES.RECOVERY;
  const component = RECOVERY_COMPONENT;
  const problems = [];
  const original = claims.length === 1 ? claims[0] : null;
  const firstCalls = ctx.stub.calls.slice(stubBefore);
  const failClosed = [];
  if (
    grading !== "GRADING_UNAVAILABLE" ||
    !original ||
    original.state !== "FAILED" ||
    original.reason_code !== "PROVIDER_UNAVAILABLE" ||
    original.result_revision_id !== null ||
    firstCalls.length !== 1 ||
    firstCalls[0].outcome !== "PROVIDER_UNAVAILABLE" ||
    (await ctx.query(JQ.componentRevisions, [s.enrolmentId, component]))
      .length !== 0
  )
    failClosed.push(
      "A provider-unavailable initial grade did not fail closed to one FAILED claim with no result.",
    );
  const progress = resultOf(
    await ctx.journey.call(ctx.jars.learner, {
      operation: "GET_PROGRESS",
      enrolmentId: s.enrolmentId,
    }),
  );
  if (progress?.components?.[component]?.status !== "PENDING")
    failClosed.push(
      `Progress did not show ${component} as PENDING after the failed grade.`,
    );
  ctx.negatives.record("PROVIDER_UNAVAILABLE_FAIL_CLOSED", failClosed);
  if (!original || original.state !== "FAILED")
    return fail(
      surface,
      "Could not create a genuinely terminal initial grade through the real grading path.",
      failClosed,
    );

  // The learner cannot fix it: a retry returns the terminal claim.
  const retry = await submitAndGrade(
    ctx,
    ctx.jars.learner,
    attemptId,
    responses,
  );
  const afterRetry = await ctx.query(Q.initialExecutions, [attemptId]);
  const terminal = [];
  if (
    retry !== "GRADING_UNAVAILABLE" ||
    afterRetry.length !== 1 ||
    ctx.stub.calls.length !== stubBefore + 1
  )
    terminal.push(
      "A learner retry of a terminal initial grade created new history or a provider call.",
    );

  const source = original.id;
  const before = (await ctx.query(Q.executionSnapshot, [source]))[0];
  const reason = `Customer journey acceptance recovery ${ctx.runId}`;
  const learnerTry = await ctx.app.call(ctx.jars.learner, {
    operation: "RECOVER_EXAMINER_TARGET",
    sourceExecutionId: source,
    reason,
  });
  responses.push(learnerTry);
  if (
    GRANTED_RECOVERY.includes(granted(learnerTry)) ||
    (await ctx.query(Q.recoveryExecutions, [source])).length !== 0
  )
    terminal.push("The learner obtained an institutional recovery.");

  const recoverBefore = ctx.stub.calls.length;
  const first = await ctx.app.call(ctx.jars.admin, {
    operation: "RECOVER_EXAMINER_TARGET",
    sourceExecutionId: source,
    reason,
  });
  responses.push(first);
  const outcome = resultOf(first) ?? {};
  const recoveries = await ctx.query(Q.recoveryExecutions, [source]);
  if (outcome.status !== "RECOVERED" && recoveries.length === 0)
    throw new JourneyBlocked(
      `The production recovery admission refused the institutional recovery (${outcome.status ?? `HTTP ${first.status}`}); rerun once the admission window has capacity.`,
    );
  const claim = recoveries.length === 1 ? recoveries[0] : null;
  if (
    outcome.status !== "RECOVERED" ||
    !claim ||
    claim.state !== "SUCCEEDED" ||
    claim.actor_id !== s.course.recoveryActorId ||
    claim.student_id !== s.learnerId ||
    claim.result_revision_id !== outcome.resultRevisionId ||
    claim.provider_calls !== 1
  )
    problems.push(
      `Expected exactly one coherent admin-owned SUCCEEDED recovery claim; found ${recoveries.length}.`,
    );
  const revisions = await ctx.query(JQ.componentRevisions, [
    s.enrolmentId,
    component,
  ]);
  const revision = revisions.length === 1 ? revisions[0] : null;
  if (
    !revision ||
    revision.id !== outcome.resultRevisionId ||
    revision.revision_number !== 1 ||
    revision.attempt_id !== attemptId ||
    revision.valid !== true ||
    revision.outcome_rows < 1 ||
    revision.earned_marks_total !== revision.max_marks_total
  )
    problems.push(
      `Expected exactly one valid recovered revision 1; found ${revisions.length}.`,
    );
  const after = (await ctx.query(Q.executionSnapshot, [source]))[0];
  if (!before || !same(before, after))
    problems.push("The original initial execution changed.");
  const recoveryCalls = ctx.stub.calls.slice(recoverBefore);
  if (recoveryCalls.length !== 1 || recoveryCalls[0].outcome !== "GRADED")
    problems.push(
      `Expected exactly one stubbed recovery provider call; saw ${recoveryCalls.length}.`,
    );
  const replay = await ctx.app.call(ctx.jars.admin, {
    operation: "RECOVER_EXAMINER_TARGET",
    sourceExecutionId: source,
    reason,
  });
  responses.push(replay);
  if (
    granted(replay) !== "ALREADY_RECOVERED" ||
    (await ctx.query(Q.recoveryExecutions, [source])).length !== 1 ||
    (await ctx.query(JQ.componentRevisions, [s.enrolmentId, component]))
      .length !== 1 ||
    ctx.stub.calls.length !== recoverBefore + 1
  )
    problems.push(
      "Recovery replay did not return the existing recovery without new history.",
    );
  ctx.negatives.record("TERMINAL_INITIAL_GRADE_REQUIRES_RECOVERY", [
    ...terminal,
    ...problems,
  ]);

  const evidence = [
    `${component} attempt ${attemptId}`,
    `source execution ${source}`,
    `recovered revision ${outcome.resultRevisionId ?? "none"}`,
  ];
  return problems.length || terminal.length || failClosed.length
    ? fail(
        surface,
        "Terminal initial grade recovery did not meet every invariant.",
        [...evidence, ...failClosed, ...terminal, ...problems],
      )
    : pass(
        surface,
        `The learner's real ${component} submission met a provider-unavailable grade that failed closed (one FAILED claim, no result, progress PENDING, learner retry created nothing, learner could not recover); an authenticated institutional admin then recovered it through recoverExaminerTarget: one admin-owned recovery claim, one valid revision 1, the original execution unchanged, and replay created nothing new.`,
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:LAB -- the governed FINAL practical/lab submission + real
// Examiner lab grading.
// ---------------------------------------------------------------------------
export async function stageLab(ctx, s) {
  const surface = JOURNEY_SURFACES.LAB;
  const problems = [];
  const responses = [];
  const call = async (jar, payload) => {
    const response = await ctx.journey.call(jar, payload);
    responses.push(response);
    return response;
  };
  const labPayload = (enrolmentId, tag) => ({
    operation: "SUBMIT_LAB_AND_GRADE",
    enrolmentId,
    practicalId: s.course.practicalId,
    body: "Synthetic acceptance final lab submission.",
    idempotencyKey: `journey-lab-${ctx.runId}-${tag}`,
  });

  const failLab = (reason, details) => {
    recordLeaks(details, responses);
    return fail(surface, reason, details);
  };

  ctx.stub.clearPlans();
  const foreignTry = await call(
    ctx.jars.foreign,
    labPayload(s.enrolmentId, "foreign-on-learner"),
  );
  // The SAME problems gate this surface, whose PASS claims the refusal. A
  // known ownership failure stops the stage before any further lab history
  // (the learner's real submission or the foreign learner's own lab).
  const foreignDenialProblems =
    resultOf(foreignTry) === null &&
    (await ctx.query(JQ.labSubmissions, [s.enrolmentId])).length === 0
      ? []
      : [
          "The foreign learner could submit lab work into another learner's enrolment.",
        ];
  ctx.negatives.record("FOREIGN_LAB_SUBMISSION_DENIED", foreignDenialProblems);
  if (foreignDenialProblems.length)
    return failLab(
      "The final lab did not meet every invariant; the stage stopped before any further lab submission.",
      [...foreignDenialProblems],
    );

  const stubBefore = ctx.stub.calls.length;
  const payload = labPayload(s.enrolmentId, "learner");
  const first = resultOf(await call(ctx.jars.learner, payload));
  const executions = first?.submissionId
    ? await ctx.query(JQ.labExecutions, [first.submissionId])
    : [];
  await blockIfAdmissionRefused(
    ctx,
    first?.grading,
    executions,
    "the learner's lab grading",
  );
  const submissions = await ctx.query(JQ.labSubmissions, [s.enrolmentId]);
  const submission = submissions.length === 1 ? submissions[0] : null;
  if (
    first?.grading !== "GRADED" ||
    !submission ||
    submission.id !== first.submissionId ||
    submission.student_id !== s.learnerId ||
    submission.practical_id !== s.course.practicalId
  )
    problems.push(
      "The final lab submission was not one learner-owned GRADED submission.",
    );
  const execution = executions.length === 1 ? executions[0] : null;
  if (
    !execution ||
    execution.state !== "SUCCEEDED" ||
    execution.capability !== "grade_practical_lab" ||
    execution.student_id !== s.learnerId ||
    execution.enrolment_id !== s.enrolmentId ||
    execution.provider_calls !== 1
  )
    problems.push(
      `Expected exactly one SUCCEEDED Examiner lab execution; found ${executions.length}.`,
    );
  const revisions = await ctx.query(JQ.labRevisions, [s.enrolmentId]);
  const revision = revisions.length === 1 ? revisions[0] : null;
  if (
    !revision ||
    revision.id !== execution?.result_revision_id ||
    revision.revision_number !== 1 ||
    revision.submission_id !== first?.submissionId ||
    revision.valid !== true ||
    revision.earned_marks !== revision.max_marks
  )
    problems.push(
      `Expected exactly one valid lab revision 1 lineaged to the submission; found ${revisions.length}.`,
    );
  const labCalls = ctx.stub.calls.slice(stubBefore);
  if (
    labCalls.length !== 1 ||
    labCalls[0].capability !== "grade_practical_lab" ||
    labCalls[0].submissionId !== first?.submissionId
  )
    problems.push(
      `Expected one stubbed lab grading call for the submission; saw ${labCalls.length}.`,
    );

  const replay = resultOf(await call(ctx.jars.learner, payload));
  // The SAME problems gate this surface, whose PASS claims the replay.
  const replayProblems =
    replay?.submissionId === first?.submissionId &&
    replay.grading === "GRADED" &&
    (await ctx.query(JQ.labSubmissions, [s.enrolmentId])).length === 1 &&
    (first?.submissionId
      ? (await ctx.query(JQ.labExecutions, [first.submissionId])).length === 1
      : false) &&
    (await ctx.query(JQ.labRevisions, [s.enrolmentId])).length === 1 &&
    ctx.stub.calls.length === stubBefore + 1
      ? []
      : [
          "Replaying the lab submission created new submission/execution/result/provider history.",
        ];
  ctx.negatives.record("LAB_SUBMISSION_REPLAY_IDEMPOTENT", replayProblems);
  problems.push(...replayProblems);
  // A known learner-lab invariant failure stops here: the zero-mark plan is
  // never armed and the foreign learner's own lab is never submitted.
  if (problems.length)
    return failLab(
      "The final lab did not meet every invariant; the stage stopped before the foreign learner's own lab.",
      [
        `lab submission ${first?.submissionId ?? "none"}`,
        `lab revision ${revision?.id ?? "none"}`,
        ...problems,
      ],
    );

  // Foreign learner's own lab, graded zero for the below-pass path.
  ctx.stub.planZeroMarks();
  const foreignBefore = ctx.stub.calls.length;
  const foreign = resultOf(
    await call(ctx.jars.foreign, labPayload(s.foreign.enrolmentId, "foreign")),
  );
  // A real production Examiner admission refusal for the foreign learner's
  // own lab is a BLOCKED prerequisite, decided before any zero-mark
  // invariant is evaluated (and it disarms the unused zero-mark plan).
  const foreignExecutions = foreign?.submissionId
    ? await ctx.query(JQ.labExecutions, [foreign.submissionId])
    : [];
  await blockIfAdmissionRefused(
    ctx,
    foreign?.grading,
    foreignExecutions,
    "the foreign learner's lab grading",
  );
  const foreignRevisions = await ctx.query(JQ.labRevisions, [
    s.foreign.enrolmentId,
  ]);
  const zeroCall = ctx.stub.calls.slice(foreignBefore);
  if (
    foreign?.grading !== "GRADED" ||
    zeroCall.length !== 1 ||
    zeroCall[0].submissionId !== foreign.submissionId ||
    zeroCall[0].zeroMarks !== true ||
    foreignRevisions.length !== 1 ||
    foreignRevisions[0].earned_marks !== 0 ||
    foreignRevisions[0].valid !== true
  )
    (s.foreignProblems ??= []).push(
      "The foreign learner's zero-mark lab grading did not run as planned.",
    );
  recordLeaks(problems, responses);

  const evidence = [
    `lab submission ${first?.submissionId ?? "none"}`,
    `lab revision ${revision?.id ?? "none"}`,
  ];
  return problems.length
    ? fail(surface, "The final lab did not meet every invariant.", [
        ...evidence,
        ...problems,
      ])
    : pass(
        surface,
        "The learner submitted final lab work through the governed FINAL submission entrypoint; the real Examiner lab authority graded it once (one SUCCEEDED execution, one valid revision 1 lineaged to the submission), replay returned the same submission with no new history, and the foreign learner could not submit into this enrolment.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// FULL_JOURNEY:PROGRESS_COMPLETION
// ---------------------------------------------------------------------------
async function completionState(ctx, enrolmentId) {
  const [receipts, audits, status] = await Promise.all([
    ctx.query(JQ.receipts, [enrolmentId]),
    ctx.query(JQ.completionAudits, [enrolmentId]),
    ctx.query(JQ.enrolmentStatus, [enrolmentId]),
  ]);
  return {
    receipts,
    audits: audits[0]?.n ?? 0,
    enrolmentStatus: status[0]?.status ?? null,
  };
}

export async function stageProgressCompletion(ctx, s) {
  const surface = JOURNEY_SURFACES.PROGRESS_COMPLETION;
  const problems = [];
  const responses = [];
  const call = async (jar, payload) => {
    const response = await ctx.journey.call(jar, payload);
    responses.push(response);
    return resultOf(response);
  };
  const reason = `Customer journey acceptance completion ${ctx.runId}`;

  // Foreign learner against this learner's enrolment.
  const foreignProgress = await call(ctx.jars.foreign, {
    operation: "GET_PROGRESS",
    enrolmentId: s.enrolmentId,
  });
  ctx.negatives.record(
    "FOREIGN_PROGRESS_DENIED",
    foreignProgress?.ok === false &&
      foreignProgress.code === "NOT_FOUND_OR_FORBIDDEN"
      ? []
      : ["The foreign learner could read another learner's progress."],
  );
  const foreignCompletion = await call(ctx.jars.foreign, {
    operation: "ATTEMPT_COMPLETION",
    enrolmentId: s.enrolmentId,
    reason,
  });
  const untouched = await completionState(ctx, s.enrolmentId);
  ctx.negatives.record(
    "FOREIGN_COMPLETION_DENIED",
    foreignCompletion?.ok === false &&
      foreignCompletion.code === "NOT_FOUND_OR_FORBIDDEN" &&
      untouched.receipts.length === 0 &&
      untouched.enrolmentStatus === "ACTIVE"
      ? []
      : ["The foreign learner could complete another learner's enrolment."],
  );

  const progress = await call(ctx.jars.learner, {
    operation: "GET_PROGRESS",
    enrolmentId: s.enrolmentId,
  });
  const current = await ctx.query(JQ.currentResults, [s.enrolmentId]);
  const lab = (
    await ctx.query(JQ.currentLab, [s.enrolmentId, s.course.practicalId])
  )[0];
  const allRevisions = await Promise.all(
    COMPONENTS.map((c) => ctx.query(JQ.componentRevisions, [s.enrolmentId, c])),
  );
  const derived =
    current.reduce((sum, r) => sum + (r.weighted_contribution_bp ?? 0), 0) +
    (lab?.weighted_contribution_bp ?? 0);
  if (
    progress?.ok !== true ||
    progress.pendingCount !== 0 ||
    progress.enrolmentStatus !== "ACTIVE" ||
    progress.completed !== false ||
    progress.passMarkBp !== PASS_MARK_BP ||
    progress.courseScoreBp !== FULL_SCORE_BP ||
    progress.courseScoreBp !== derived
  )
    problems.push(
      "The authoritative progress read is not a complete, full-score, not-yet-completed projection of the current revisions.",
    );
  for (const [index, row] of current.entries()) {
    if (!row.id || row.valid !== true || allRevisions[index].length !== 1)
      problems.push(
        `${row.component}: expected exactly one valid current revision (no duplicate initial result).`,
      );
    if (
      progress?.components?.[row.component]?.weightedContributionBp !==
      row.weighted_contribution_bp
    )
      problems.push(
        `${row.component}: the progress contribution is not the current revision's.`,
      );
  }
  if (
    !lab?.id ||
    lab.valid !== true ||
    progress?.labs?.[s.course.practicalId]?.status !== "FINALIZED"
  )
    problems.push("The lab has no valid current result in progress.");
  const entitlements = await ctx.query(JQ.entitlements, [
    s.learnerId,
    s.course.activationId,
  ]);
  if (entitlements.length !== 1)
    problems.push("The learner no longer holds exactly one entitlement.");
  if (problems.length)
    return fail(
      surface,
      "Progress before completion did not meet every invariant.",
      problems,
    );

  const first = await call(ctx.jars.learner, {
    operation: "ATTEMPT_COMPLETION",
    enrolmentId: s.enrolmentId,
    reason,
  });
  const done = await completionState(ctx, s.enrolmentId);
  const expected = {
    receiptId: first?.receiptId,
    learnerId: s.learnerId,
    courseScoreBp: FULL_SCORE_BP,
    passMarkBp: PASS_MARK_BP,
  };
  if (first?.ok !== true || first.code !== "COMPLETED")
    problems.push(
      "The production completion entrypoint did not report COMPLETED.",
    );
  problems.push(...completionProblems(done, expected, "Completion"));

  const replay = await call(ctx.jars.learner, {
    operation: "ATTEMPT_COMPLETION",
    enrolmentId: s.enrolmentId,
    reason,
  });
  const replayed = await completionState(ctx, s.enrolmentId);
  ctx.negatives.record("COMPLETION_REPLAY_IDEMPOTENT", [
    ...(replay?.ok === true &&
    replay.code === "ALREADY_COMPLETED" &&
    replay.receiptId === first?.receiptId
      ? []
      : ["Completion replay did not return the existing receipt."]),
    ...completionProblems(replayed, expected, "Replay"),
  ]);
  const completedView = await call(ctx.jars.learner, {
    operation: "GET_PROGRESS",
    enrolmentId: s.enrolmentId,
  });
  if (completedView?.completed !== true)
    problems.push("Progress does not report the enrolment as completed.");

  // Below pass mark: the foreign learner's own genuinely graded, complete,
  // zero-score result set.
  const foreignOwn = await call(ctx.jars.foreign, {
    operation: "GET_PROGRESS",
    enrolmentId: s.foreign.enrolmentId,
  });
  const belowPass = await call(ctx.jars.foreign, {
    operation: "ATTEMPT_COMPLETION",
    enrolmentId: s.foreign.enrolmentId,
    reason: `Customer journey acceptance below-pass completion ${ctx.runId}`,
  });
  const foreignState = await completionState(ctx, s.foreign.enrolmentId);
  ctx.negatives.record("BELOW_PASS_MARK_COMPLETION_REFUSED", [
    ...(s.foreignProblems ?? []),
    ...(foreignOwn?.ok === true &&
    foreignOwn.pendingCount === 0 &&
    foreignOwn.courseScoreBp < PASS_MARK_BP &&
    belowPass?.ok === false &&
    belowPass.code === "BELOW_PASS_MARK" &&
    foreignState.receipts.length === 0 &&
    foreignState.audits === 0 &&
    foreignState.enrolmentStatus === "ACTIVE"
      ? []
      : [
          "A complete below-pass-mark result set was not refused BELOW_PASS_MARK without a receipt.",
        ]),
  ]);
  recordLeaks(problems, responses);

  const evidence = [
    `receipt ${first?.receiptId ?? "none"}`,
    `courseScoreBp ${progress?.courseScoreBp}`,
  ];
  return problems.length
    ? fail(surface, "Progress/completion did not meet every invariant.", [
        ...evidence,
        ...problems,
      ])
    : pass(
        surface,
        "The authoritative progress read matched the current valid revisions (one per component plus the lab, no pending items) before completion; the production completion entrypoint moved the ACTIVE enrolment to COMPLETED with exactly one receipt and one audit event, and replay returned the same receipt.",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------
function blockedAll(reason, details = []) {
  const results = Object.values(JOURNEY_SURFACES).map((surface) =>
    blocked(surface, reason, details),
  );
  return [...results, aggregateJourney(results)];
}

// The ONE staged journey. Each positive stage runs only when every earlier
// positive stage PASSed, so a broken journey never goes on to write
// irreversible assessment/lab/completion history. RECOVERY executes nothing
// of its own: it reports the result captured when ASSESSMENTS reached
// RECOVERY_COMPONENT, and is BLOCKED if that point was never reached.
// NEGATIVE_REPLAY evaluates the accumulated ledger at the end.
export const STAGE_GRAPH = Object.freeze([
  Object.freeze({ key: "ACCESS", needs: Object.freeze([]) }),
  Object.freeze({ key: "DELIVERY", needs: Object.freeze(["ACCESS"]) }),
  Object.freeze({ key: "CLASSROOM", needs: Object.freeze(["DELIVERY"]) }),
  Object.freeze({ key: "TUTOR_LAB", needs: Object.freeze(["CLASSROOM"]) }),
  Object.freeze({ key: "ASSESSMENTS", needs: Object.freeze(["TUTOR_LAB"]) }),
  Object.freeze({ key: "RECOVERY", needs: Object.freeze([]) }),
  Object.freeze({
    key: "LAB",
    needs: Object.freeze(["ASSESSMENTS", "RECOVERY"]),
  }),
  Object.freeze({
    key: "PROGRESS_COMPLETION",
    needs: Object.freeze(["ASSESSMENTS", "RECOVERY", "LAB"]),
  }),
  Object.freeze({ key: "NEGATIVE_REPLAY", needs: Object.freeze([]) }),
]);

export function reportRecovery(_ctx, s) {
  return (
    s.recoveryResult ??
    blocked(
      JOURNEY_SURFACES.RECOVERY,
      `Not reached: the ${RECOVERY_COMPONENT} terminal-grade recovery was not executed in this run.`,
    )
  );
}

export const STAGE_RUNNERS = Object.freeze({
  ACCESS: stageAccess,
  DELIVERY: stageDelivery,
  CLASSROOM: stageClassroom,
  TUTOR_LAB: stageTutorLab,
  ASSESSMENTS: stageAssessments,
  RECOVERY: reportRecovery,
  LAB: stageLab,
  PROGRESS_COMPLETION: stageProgressCompletion,
  NEGATIVE_REPLAY: (ctx) => evaluateNegativeLedger(ctx.negatives),
});

// `runners` exists only so tests can observe which stages execute.
export function buildStages(ctx, s, runners = STAGE_RUNNERS) {
  return STAGE_GRAPH.map(({ key, needs }) => ({
    key,
    surface: JOURNEY_SURFACES[key],
    needs,
    run: async () => runners[key](ctx, s),
  }));
}

export async function runCustomerJourney({
  open = (options) => openExaminerAppSession({ ...options, journey: true }),
  log = console.log,
  onResult,
} = {}) {
  let opened = null;
  try {
    opened = await open({});
    if (opened.refusal)
      return blockedAll(opened.refusal.reason, opened.refusal.details);
    const session = opened.session;
    const journey = session.routeClient(JOURNEY_ROUTE_PATH);
    // The journey route compiled and its own gate (journey marker + the
    // reviewed examiner-app gate incl. provider-redirect attestation)
    // admitted this driver: an empty body passes the gate and is refused
    // 400 by strict validation.
    const probe = await journey.call(null, {});
    if (probe.status !== 400)
      return blockedAll(
        `The customer-journey acceptance route did not admit this driver (HTTP ${probe.status}).`,
        [
          "404 means its fail-closed gate refused: ACCEPTANCE_JOURNEY_DRIVER_ENABLED must be set in the app child and the provider redirect must be attested live.",
        ],
      );
    const ctx = {
      runId: session.runId,
      baseUrl: session.baseUrl,
      app: session.app,
      journey,
      jars: session.jars,
      stub: session.stub,
      adminClient: session.adminClient,
      foreignAuthUserId: session.foreignAuthUserId,
      query: session.query,
      negatives: createNegativeLedger(),
      log,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      dbNowMs: async () => Number((await session.query(JQ.dbNow, []))[0].ms),
    };
    const [learnerId, foreignId] = await withConnection(async (c) => [
      await resolveAppUserId(c, session.learnerAuthUserId),
      await resolveAppUserId(c, session.foreignAuthUserId),
    ]);
    if (!learnerId || !foreignId)
      return blockedAll(
        "The acceptance learner/foreign learner have no linked app_users rows.",
      );
    const s = { learnerId };
    log(
      `Acceptance run ${ctx.runId}: seeding the synthetic journey course (governed admin RPCs)...`,
    );
    try {
      await setupFixtures(ctx, s);
    } catch (error) {
      if (error instanceof JourneyBlocked)
        return blockedAll(error.message, error.details);
      throw error;
    }
    if (s.foreign.studentId !== foreignId)
      return blockedAll("The seeded enrolment is not the foreign learner's.");
    log(
      `Course ${s.course.activationId}, offer ${s.offer.slug}. The assessment windows open in about ${Math.round(JOURNEY_SCHEDULE.firstOpensAfterMs / 60_000)} minutes; a full run takes roughly half an hour.`,
    );
    const results = await runJourneyStages(buildStages(ctx, s), { onResult });
    return [...results, aggregateJourney(results)];
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return blockedAll(error.message);
    const results = Object.values(JOURNEY_SURFACES).map((surface) =>
      fail(surface, "The customer-journey acceptance stopped unexpectedly.", [
        error instanceof Error ? error.message : String(error),
      ]),
    );
    return [...results, aggregateJourney(results)];
  } finally {
    await opened?.close();
  }
}

async function main() {
  console.log(
    "===== Commercial V1 FULL_CUSTOMER_JOURNEY hosted staged acceptance =====",
  );
  console.log(
    "Explicit operator-run, MUTATING command (run-id-tagged synthetic history; nothing is deleted).",
  );
  console.log("");
  const results = await runCustomerJourney({ onResult: printResult });
  printResult(results[results.length - 1]);
  printSummary(
    results,
    "Commercial V1 FULL_CUSTOMER_JOURNEY (hosted staged acceptance)",
  );
  console.log("");
  console.log(TRUTHFULNESS_STATEMENT);
  process.exit(exitCodeFor(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
