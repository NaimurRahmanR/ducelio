#!/usr/bin/env node
// npm run acceptance:commerce-revocation
//
// Migration 202610010045 hosted ACCESS-REVOCATION acceptance. An explicit,
// operator-run, MUTATING command against the dedicated hosted acceptance
// environment. It is ACCESS-REVOCATION acceptance, never Stripe-refund
// acceptance: no Stripe request is made and no refund is fabricated.
//
// What it does, through existing governed paths only (no service role, no
// direct-SQL write, no migration 044 guard bypass, no HMAC/signing):
//   1. seedAcceptanceCourse (gated) builds a run-tagged course whose single
//      academic enrolment belongs to the FOREIGN learner, plus one lesson
//      segment added through create_lesson_segment while the version is DRAFT;
//   2. the admin publishes a run-tagged offer and a one-use
//      REVIEWER_COMPLIMENTARY campaign; the affected learner redeems it with
//      their own JWT (redeem_commercial_v1_campaign) -> a commerce-backed
//      entitlement and enrolment, no order or payment;
//   3. the admin schedules a just-started class session and records
//      learning evidence (which applies MASTERY_V1, creating objective
//      mastery) and lesson progress for the affected learner, and one
//      evidence record for the foreign learner;
//   4. the admin cancels the learner's course access with
//      admin_revoke_commercial_v1_entitlement -- the governed cancellation
//      that calls the SAME commercial_v1_commerce_private.revoke_entitlement
//      helper a verified full refund uses;
//   5. real hosted JWT/PostgREST probes then verify retained history,
//      closed content (including resolvable relationship embeds), foreign
//      isolation and non-STUDENT denial, and read-only PostgreSQL verifies
//      the resulting COMMERCE provenance and enrolment withdrawal.
//
// Every write is preceded by BOTH acceptance gates (ACCEPTANCE_WRITE_ENABLED
// plus the direct-database marker, and the hosted Supabase environment id).
// Direct PostgreSQL is used here only for READ-ONLY verification. Created
// rows are permanent institutional history tagged with this run id; nothing
// is deleted. Nothing printed contains a credential, JWT, key or URL.
//
// Requires migration 202610020046 on the hosted database (checked read-only
// before any write): reviewer redemption that creates the enrolment then
// records COMMERCE provenance, so PROVENANCE:REVIEWER_COMMERCE_WITHDRAWAL
// proves the revocation withdraws that enrolment.
//
// Deliberately BLOCKED here (see BLOCKED_SURFACES): paid-fulfilment COMMERCE
// and ACADEMIC provenance, and the academic-enrolment-versus-fulfilment race,
// are written ONLY by HMAC-attested paid fulfilment, which requires genuine
// Stripe TEST-mode payment evidence (an operator-attended, separately
// double-authorized `npm run acceptance:stripe` path). This harness never
// reimplements that signing protocol. Genuine UNKNOWN provenance exists only
// on pre-045 entitlements and cannot be produced without a privileged direct
// write, which this harness refuses to fabricate.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  blocked,
  exitCodeFor,
  fail,
  pass,
  printResult,
  printSummary,
} from "./report.mjs";
import { isConfigured } from "./env.mjs";
import {
  AcceptanceWriteNotAuthorizedError,
  acceptanceDbConfigured,
  resolveAppUserId,
  withAcceptanceWriteConnection,
  withConnection,
} from "./db.mjs";
import {
  acceptanceIdentities,
  acceptanceIdentitiesConfigured,
  assertAcceptanceSupabaseWriteAuthorized,
  foreignLearnerIdentityConfigured,
  hostedSupabaseConfigured,
  unrelatedStaffIdentityConfigured,
} from "./supabase.mjs";
import { buildAcceptancePackage, seedAcceptanceCourse } from "./fixtures.mjs";

export const SURFACES = Object.freeze({
  RETAINED_HISTORY: "ACCESS_REVOCATION:RETAINED_HISTORY",
  CONTENT_CLOSED: "ACCESS_REVOCATION:CONTENT_CLOSED",
  FOREIGN_ISOLATION: "ACCESS_REVOCATION:FOREIGN_ISOLATION",
  NON_STUDENT_DENIED: "ACCESS_REVOCATION:NON_STUDENT_DENIED",
  REVIEWER_COMMERCE: "PROVENANCE:REVIEWER_COMMERCE_WITHDRAWAL",
});
export const PROVENANCE_MIGRATION = "202610020046";
const LIVE_SURFACES = Object.values(SURFACES);

const SIGNED_FULFILMENT_REASON =
  "Requires HMAC-attested PAID fulfilment, which needs genuine Stripe TEST-mode payment evidence (operator-attended, separately double-authorized `npm run acceptance:stripe`). This harness never reimplements the commerce signing protocol.";
export const BLOCKED_SURFACES = Object.freeze([
  ["PROVENANCE:ACADEMIC_FIRST", SIGNED_FULFILMENT_REASON],
  [
    "PROVENANCE:COMMERCE_FIRST",
    `Paid-fulfilment COMMERCE provenance. ${SIGNED_FULFILMENT_REASON} Reviewer-redemption COMMERCE provenance is covered by PROVENANCE:REVIEWER_COMMERCE_WITHDRAWAL.`,
  ],
  [
    "PROVENANCE:UNKNOWN",
    "Genuine UNKNOWN provenance exists only on pre-045 entitlements. After migration 202610020046 no governed path creates one, and producing one would require a privileged direct insert/update into commercial_v1_entitlements, which this harness refuses to fabricate.",
  ],
  [
    "PROVENANCE:ENROLMENT_VS_FULFILMENT_CONTENTION",
    `${SIGNED_FULFILMENT_REASON} No sequential substitute is reported as concurrency.`,
  ],
  [
    "STRIPE_TEST:REFUND_LIFECYCLE",
    "Not exercised by this command: no Stripe request is made and no refund is fabricated. Stripe TEST-mode refund acceptance needs its own configured and explicitly authorized run.",
  ],
]);

// The exact renderable shapes the three production student readers
// (src/server/learning-evidence.ts, objective-mastery.ts, lesson-progress.ts)
// parse from get_student_retained_learning_history. Exact key sets: any
// additional field is treated as a content leak.
const MASTERY_STATES = [
  "NOT_STARTED",
  "DEVELOPING",
  "DEMONSTRATED",
  "NEEDS_REINFORCEMENT",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID.test(v);
const isText = (v) => typeof v === "string" && v.length > 0;
const isStamp = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v) => Number.isInteger(v) && v >= 0;
const oneOf = (values) => (v) => values.includes(v);
const object = (fields) => ({ object: fields });

export const HISTORY_SHAPES = Object.freeze({
  evidence: {
    id: isUuid,
    objective_id: isUuid,
    evidence_kind: oneOf([
      "CLASS_RESPONSE",
      "RETRIEVAL_CHECK",
      "PRACTICAL_TASK",
      "DEBUGGING_TASK",
    ]),
    result: oneOf(["CORRECT", "PARTIAL", "INCORRECT"]),
    evidence_reference: isText,
    recorded_at: isStamp,
    lesson_objectives: object({ description: isText, position: isCount }),
    lessons: object({ title: isText }),
  },
  mastery: {
    id: isUuid,
    objective_id: isUuid,
    lesson_id: isUuid,
    state: oneOf(MASTERY_STATES),
    evidence_count: isCount,
    correct_evidence_count: isCount,
    correct_session_count: isCount,
    correct_kind_count: isCount,
    policy_version: isText,
    evaluated_at: isStamp,
    lesson_objectives: object({
      description: isText,
      position: isCount,
      lessons: object({ title: isText }),
    }),
  },
  progress: {
    id: isUuid,
    lesson_id: isUuid,
    segment_id: isUuid,
    status: oneOf(["IN_PROGRESS", "COMPLETED"]),
    updated_at: isStamp,
    lesson_segments: object({
      title: isText,
      position: isCount,
      lessons: object({ title: isText }),
    }),
  },
});

function shapeProblems(value, shape, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [`${path} is not an object`];
  const problems = [];
  const expected = Object.keys(shape).sort();
  const actual = Object.keys(value).sort();
  for (const key of actual)
    if (!expected.includes(key)) problems.push(`${path}.${key} is unexpected`);
  for (const key of expected) {
    const rule = shape[key];
    if (!(key in value)) problems.push(`${path}.${key} is missing`);
    else if (typeof rule === "function") {
      if (!rule(value[key]))
        problems.push(`${path}.${key} has an invalid value`);
    } else
      problems.push(
        ...shapeProblems(value[key], rule.object, `${path}.${key}`),
      );
  }
  return problems;
}

/** Exact-shape validation of one retained-history row for `kind`. */
export function historyRowProblems(kind, row) {
  return shapeProblems(row, HISTORY_SHAPES[kind], kind);
}

/**
 * Package text that must never come back through a learner history read:
 * prompts, expected answers, marking guidance, instructions, bodies and
 * agent notes. Labels (titles/descriptions) are permitted by design.
 */
export function sensitivePackageStrings(pkg) {
  const found = new Set();
  const walk = (node, key = "") => {
    if (typeof node === "string") {
      if (
        /prompt|expectedAnswer|markingGuidance|instructions|body|content|notes/i.test(
          key,
        ) &&
        node.trim().length >= 12
      )
        found.add(node.trim());
      return;
    }
    if (Array.isArray(node)) node.forEach((item) => walk(item, key));
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(pkg);
  return [...found];
}

export function leakedSensitiveStrings(value, sensitive) {
  const text = JSON.stringify(value ?? null);
  return sensitive.filter((s) => text.includes(s));
}

const idsOf = (rows) => new Set((rows ?? []).map((r) => r?.id));

export function evaluateRetainedHistory({ after, expected, sensitive }) {
  const surface = SURFACES.RETAINED_HISTORY;
  const problems = [];
  const pick = (kind, id) => (after[kind] ?? []).find((r) => r?.id === id);
  const evidence = pick("evidence", expected.evidenceId);
  const mastery = pick("mastery", expected.masteryId);
  const progress = pick("progress", expected.progressId);
  for (const kind of ["evidence", "mastery", "progress"]) {
    if (!Array.isArray(after[kind])) {
      problems.push(`${kind}: the projection did not return a list`);
      continue;
    }
    for (const row of after[kind])
      problems.push(...historyRowProblems(kind, row));
  }
  if (!evidence)
    problems.push("the revoked learner's evidence record is missing");
  if (!mastery)
    problems.push("the revoked learner's mastery record is missing");
  if (!progress)
    problems.push("the revoked learner's progress record is missing");
  if (evidence) {
    if (evidence.lessons?.title !== expected.lessonTitle)
      problems.push("evidence lesson title label does not match");
    if (
      evidence.lesson_objectives?.description !== expected.objectiveDescription
    )
      problems.push("evidence objective description label does not match");
  }
  if (mastery) {
    if (mastery.lesson_objectives?.lessons?.title !== expected.lessonTitle)
      problems.push("mastery lesson title label does not match");
    if (
      mastery.lesson_objectives?.description !== expected.objectiveDescription
    )
      problems.push("mastery objective description label does not match");
  }
  if (progress) {
    if (progress.lesson_segments?.title !== expected.segmentTitle)
      problems.push("progress segment title label does not match");
    if (progress.lesson_segments?.lessons?.title !== expected.lessonTitle)
      problems.push("progress lesson title label does not match");
  }
  const leaks = leakedSensitiveStrings(after, sensitive);
  if (leaks.length)
    problems.push(
      `${leaks.length} protected package text value(s) were returned`,
    );
  return problems.length
    ? fail(
        surface,
        "Retained history after access revocation is incomplete or over-exposed.",
        problems.slice(0, 20),
      )
    : pass(
        surface,
        "After access revocation, the learner's own JWT retrieved their evidence, mastery and progress through hosted get_student_retained_learning_history, in the exact shapes and labels the student readers render.",
        [
          `rows: evidence=${after.evidence.length}, mastery=${after.mastery.length}, progress=${after.progress.length}`,
          `mastery state ${mastery.state}; progress ${progress.status}`,
        ],
      );
}

export function evaluateContentClosed({ before, after, embeds, historyLeaks }) {
  const surface = SURFACES.CONTENT_CLOSED;
  const problems = [];
  if (!(before.lessons > 0))
    problems.push(
      "the learner could not read the lesson before revocation, so closure cannot be attributed to revocation",
    );
  for (const [table, outcome] of Object.entries(after)) {
    if (outcome.error)
      problems.push(
        `${table}: the read errored instead of returning an RLS-filtered result`,
      );
    else if (outcome.count !== 0)
      problems.push(
        `${table}: ${outcome.count} row(s) still readable after revocation`,
      );
  }
  for (const embed of embeds)
    if (!embed.error && embed.visibleEmbeds > 0)
      problems.push(
        `${embed.name}: a relationship embed exposed curriculum after revocation`,
      );
  if (historyLeaks > 0)
    problems.push(
      "the retained-history projection returned protected package text",
    );
  if (problems.length)
    return fail(
      surface,
      "Substantive course content is still reachable after access revocation.",
      problems,
    );
  // An embed that errored, or whose owning row was not visible, proves
  // nothing about hidden curriculum: never a PASS.
  const unproven = embeds
    .filter((e) => e.error || e.rows !== 1)
    .map((e) =>
      e.error
        ? `${e.name}: PostgREST refused the embed (${e.code ?? "error"}), so hosted embed behaviour is unproven`
        : `${e.name}: the learner's own row was not returned (${e.rows}), so a hidden embed is unproven`,
    );
  if (unproven.length)
    return blocked(
      surface,
      "Direct content reads are closed, but hosted relationship-embed behaviour was not proven.",
      unproven,
    );
  return pass(
    surface,
    "With the learner's JWT, direct PostgREST reads of modules, lessons, objectives, segments, learning resources, assignments and assessments for the revoked course return nothing (the lesson was readable before revocation). The learner's own evidence and progress rows remain visible with their curriculum embeds resolved but empty. The projection returned no prompts, answers, guidance, instructions or bodies.",
    embeds.map((e) => `${e.name}: own row visible, curriculum embeds hidden`),
  );
}

export function evaluateForeignIsolation({
  foreignHistory,
  foreignDirect,
  affectedIds,
  foreignOwnEvidenceId,
}) {
  const surface = SURFACES.FOREIGN_ISOLATION;
  const problems = [];
  for (const kind of ["evidence", "mastery", "progress"]) {
    if (foreignHistory[kind]?.error) {
      problems.push(
        `${kind}: the foreign learner's own projection call failed`,
      );
      continue;
    }
    const seen = idsOf(foreignHistory[kind]?.data);
    if (affectedIds.some((id) => seen.has(id)))
      problems.push(
        `${kind}: the foreign learner received the affected learner's record`,
      );
  }
  for (const [table, count] of Object.entries(foreignDirect))
    if (count !== 0)
      problems.push(
        `${table}: the foreign learner read ${count} of the affected learner's rows directly`,
      );
  if (!idsOf(foreignHistory.evidence?.data).has(foreignOwnEvidenceId))
    problems.push(
      "the foreign learner's own evidence was not returned, so isolation is not distinguishable from an empty projection",
    );
  return problems.length
    ? fail(surface, "Retained history is not isolated per learner.", problems)
    : pass(
        surface,
        "The foreign learner's JWT received their own retained evidence but none of the affected learner's evidence, mastery or progress, through the projection or direct PostgREST reads.",
      );
}

const forbidden = (r) =>
  Boolean(r?.error) &&
  (r.data === null || r.data === undefined) &&
  /FORBIDDEN|42501|permission denied/i.test(
    `${r.error.message ?? ""} ${r.error.code ?? ""}`,
  );

export function evaluateNonStudent({ identity, results, anon }) {
  const surface = SURFACES.NON_STUDENT_DENIED;
  if (!identity)
    return blocked(
      surface,
      "No configured authenticated identity verifiably lacks STUDENT (sign-up provisions STUDENT to every account). Provision a staff identity without the STUDENT grant to exercise this surface.",
    );
  const problems = [];
  for (const [kind, r] of Object.entries(results))
    if (!forbidden(r))
      problems.push(`${kind}: a non-STUDENT identity was not refused`);
  if (!forbidden(anon)) problems.push("an anonymous call was not refused");
  return problems.length
    ? fail(
        surface,
        "get_student_retained_learning_history is callable without STUDENT authority.",
        problems,
      )
    : pass(
        surface,
        `A real hosted non-STUDENT JWT (${identity}) is refused for every history kind, and anonymous access is refused.`,
      );
}

export function evaluateReviewerCommerceProvenance({
  entitlement,
  enrolmentBefore,
  enrolmentAfter,
  revokeResult,
  audit,
  contentBefore,
  contentAfter,
}) {
  const surface = SURFACES.REVIEWER_COMMERCE;
  const problems = [];
  if (entitlement?.source !== "REVIEWER")
    problems.push("the entitlement is not a reviewer-complimentary grant");
  if (entitlement?.enrolment_origin !== "COMMERCE")
    problems.push(
      `entitlement provenance is ${entitlement?.enrolment_origin ?? "missing"}, not COMMERCE`,
    );
  if (entitlement?.state !== "REVOKED" || !entitlement?.revoked_at)
    problems.push("the entitlement is not durably REVOKED");
  if (revokeResult?.code !== "ACCESS_REVOKED")
    problems.push(
      `the governed cancellation returned ${revokeResult?.code ?? "nothing"}, not ACCESS_REVOKED`,
    );
  if (enrolmentBefore !== "ACTIVE" || enrolmentAfter !== "WITHDRAWN")
    problems.push(
      `the redemption-created enrolment went ${enrolmentBefore} -> ${enrolmentAfter}, not ACTIVE -> WITHDRAWN`,
    );
  if (
    audit?.enrolment_origin !== "COMMERCE" ||
    audit?.previous_enrolment_status !== "ACTIVE" ||
    audit?.state !== "REVOKED"
  )
    problems.push(
      "no matching COMMERCIAL_V1_ENTITLEMENT_REVOKED audit evidence",
    );
  if (!(contentBefore > 0) || contentAfter !== 0)
    problems.push("commercial content access was not closed by the revocation");
  return problems.length
    ? fail(
        surface,
        "Reviewer-created COMMERCE access did not revoke as migrations 045/046 specify.",
        problems,
      )
    : pass(
        surface,
        "A reviewer-complimentary redemption that created the enrolment recorded COMMERCE provenance; the governed cancellation revoked it (ACCESS_REVOKED), withdrew the enrolment ACTIVE -> WITHDRAWN with matching audit, and closed commercial content access.",
      );
}

// ---------------------------------------------------------------------------
// Orchestration (injectable for local tests; real hosted defaults).
// ---------------------------------------------------------------------------
export function missingPrerequisites() {
  const missing = [];
  if (process.env.ACCEPTANCE_WRITE_ENABLED?.trim() !== "true")
    missing.push("ACCEPTANCE_WRITE_ENABLED is not exactly 'true'");
  if (!isConfigured("ACCEPTANCE_ENVIRONMENT_ID"))
    missing.push("ACCEPTANCE_ENVIRONMENT_ID");
  if (!hostedSupabaseConfigured()) missing.push("hosted Supabase URL/key");
  if (!acceptanceDbConfigured()) missing.push("ACCEPTANCE_DATABASE_URL");
  if (!acceptanceIdentitiesConfigured())
    missing.push("admin/learner identities");
  if (!foreignLearnerIdentityConfigured())
    missing.push("foreign learner identity");
  if (!unrelatedStaffIdentityConfigured())
    missing.push("unrelated staff identity");
  return missing;
}

export async function assertWriteGates(client) {
  await assertAcceptanceSupabaseWriteAuthorized(client);
  await withAcceptanceWriteConnection(async () => {});
}

export function defaultDeps() {
  return {
    runId: `${Date.now()}-${randomUUID().slice(0, 6)}`,
    missingPrerequisites,
    signIn: acceptanceIdentities,
    assertWriteGates,
    seedCourse: (admin, runId, enrolledAuthUserId) =>
      seedAcceptanceCourse(admin, runId, enrolledAuthUserId, {
        lessonSegment: true,
      }),
    query: (sql, params = []) =>
      withConnection((client) => client.query(sql, params).then((r) => r.rows)),
    resolveAppUserId: (authUserId) =>
      withConnection((client) => resolveAppUserId(client, authUserId)),
    anonRpc: null,
    log: console.log,
  };
}

class SetupBlocked extends Error {}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  // Bounded database refusal text only (e.g. a guard code); never request data.
  if (error)
    throw new SetupBlocked(
      `${name} was refused (${error.code ?? "no code"}: ${String(error.message ?? "").slice(0, 160)}).`,
    );
  return data;
}
async function authUserId(client) {
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user?.id)
    throw new SetupBlocked("A signed-in identity has no Auth user id.");
  return data.user.id;
}
async function hasRole(client, role) {
  const { data, error } = await client.rpc("has_role", { wanted: role });
  if (error)
    throw new SetupBlocked(
      "has_role could not be evaluated for a signed-in identity.",
    );
  return data === true;
}
async function history(client) {
  const out = {};
  for (const kind of ["evidence", "mastery", "progress"]) {
    const { data, error } = await client.rpc(
      "get_student_retained_learning_history",
      { p_kind: kind },
    );
    out[kind] = { data, error };
  }
  return out;
}
async function count(client, table, column, value) {
  const { data, error } = await client
    .from(table)
    .select("id")
    .eq(column, value)
    .limit(50);
  return error
    ? { error: true, count: null }
    : { error: false, count: data.length };
}

const Q = {
  provenanceMigration:
    "select version from supabase_migrations.schema_migrations where version=$1",
  dbNowMs: "select (extract(epoch from clock_timestamp())*1000)::bigint as ms",
  lesson: "select title from lessons where id=$1",
  objective:
    "select id, description, position from lesson_objectives where lesson_id=$1 order by position limit 1",
  segment: "select title, position from lesson_segments where id=$1",
  entitlement:
    "select id, enrolment_id, source, enrolment_origin, state, revoked_at from commercial_v1_entitlements where id=$1",
  enrolmentStatus: "select status from enrolments where id=$1",
  mastery:
    "select id from objective_mastery where enrolment_id=$1 and objective_id=$2",
  revocationAudit:
    "select after_state from audit_events where action='COMMERCIAL_V1_ENTITLEMENT_REVOKED' and target_id=$1 order by occurred_at desc limit 1",
};

export async function runCommerceRevocationAcceptance(deps = defaultDeps()) {
  const fixed = BLOCKED_SURFACES.map(([surface, reason]) =>
    blocked(surface, reason),
  );
  const allLive = (make, reason, details) =>
    LIVE_SURFACES.map((s) => make(s, reason, details));
  const missing = deps.missingPrerequisites();
  if (missing.length)
    return [
      ...allLive(
        blocked,
        "Prerequisites missing; nothing was signed in or written.",
        missing,
      ),
      ...fixed,
    ];
  const { runId, log } = deps;
  try {
    const admin = await deps.signIn.admin();
    const learner = await deps.signIn.learner();
    const foreign = await deps.signIn.foreignLearner();
    const staff = await deps.signIn.unrelatedStaff();
    if (
      !(await hasRole(learner, "STUDENT")) ||
      !(await hasRole(foreign, "STUDENT"))
    )
      throw new SetupBlocked(
        "The learner and foreign learner must both hold STUDENT.",
      );
    for (const role of [
      "INSTRUCTOR",
      "ACADEMIC_ADMIN",
      "PLATFORM_ADMIN",
      "REGISTRAR",
    ])
      if (await hasRole(learner, role))
        throw new SetupBlocked(
          `The affected learner holds ${role}, which grants staff content access; content closure would be meaningless.`,
        );
    let nonStudent = null;
    for (const [label, client] of [
      ["unrelated staff", staff],
      ["acceptance admin", admin],
    ])
      if (!(await hasRole(client, "STUDENT"))) {
        nonStudent = { label, client };
        break;
      }
    const learnerAuth = await authUserId(learner);
    const foreignAuth = await authUserId(foreign);
    const [learnerId, foreignId] = [
      await deps.resolveAppUserId(learnerAuth),
      await deps.resolveAppUserId(foreignAuth),
    ];
    if (!learnerId || !foreignId)
      throw new SetupBlocked("The learner identities have no app_users rows.");
    let applied = [];
    try {
      applied = await deps.query(Q.provenanceMigration, [PROVENANCE_MIGRATION]);
    } catch {
      applied = [];
    }
    if (!applied.length)
      throw new SetupBlocked(
        `Migration ${PROVENANCE_MIGRATION} is not recorded as applied on the hosted acceptance database; apply it before this run. Nothing was written.`,
      );

    log(`Acceptance run ${runId}: seeding the course through governed RPCs...`);
    const course = await deps.seedCourse(admin, runId, foreignAuth);
    if (!course.lessonSegment?.segmentId)
      throw new SetupBlocked("The course has no lesson segment.");
    const { lessonId, segmentId } = course.lessonSegment;
    const [lessonRow] = await deps.query(Q.lesson, [lessonId]);
    const [objective] = await deps.query(Q.objective, [lessonId]);
    const [segmentRow] = await deps.query(Q.segment, [segmentId]);
    if (!lessonRow || !objective || !segmentRow)
      throw new SetupBlocked(
        "The fixture lesson/objective/segment could not be read.",
      );
    const dbNow = Number((await deps.query(Q.dbNowMs))[0].ms);

    const slug = `acceptance-revocation-${runId}`.toLowerCase();
    const code = `REV-${runId}`.toUpperCase();
    await deps.assertWriteGates(admin);
    await rpc(admin, "publish_commercial_v1_offer", {
      p_activation_id: course.activationId,
      p_slug: slug,
      p_price_amount_minor: 100,
      p_currency: "GBP",
      p_summary:
        "Synthetic access-revocation acceptance offer. Not a real course, qualification or price.",
      p_delivery_plan: "STANDARD_6_WEEK",
      p_reason: `Access revocation acceptance offer ${runId}`,
    });
    await deps.assertWriteGates(admin);
    await rpc(admin, "create_commercial_v1_campaign", {
      p_offer_slug: slug,
      p_code: code,
      p_kind: "REVIEWER_COMPLIMENTARY",
      p_percent_off: null,
      p_fixed_price_amount_minor: 0,
      p_max_redemptions: 1,
      p_starts_at: new Date(dbNow - 60_000).toISOString(),
      p_ends_at: new Date(dbNow + 3 * 3600_000).toISOString(),
      p_reason: `Access revocation acceptance reviewer campaign ${runId}`,
    });
    await deps.assertWriteGates(learner);
    const redemption = await rpc(learner, "redeem_commercial_v1_campaign", {
      p_offer_slug: slug,
      p_code: code,
    });
    if (
      redemption?.ok !== true ||
      redemption.path !== "ACCESS_GRANTED" ||
      !redemption.entitlementId
    )
      throw new SetupBlocked(
        `Reviewer redemption did not grant access (${redemption?.code ?? "no code"}).`,
      );
    const enrolmentId = redemption.enrolmentId;

    await deps.assertWriteGates(admin);
    const sessionId = await rpc(admin, "create_class_session", {
      p_cohort_id: course.cohortId,
      p_lesson_id: lessonId,
      p_instructor_id: course.instructorId,
      p_scheduled_start: new Date(dbNow - 120_000).toISOString(),
      p_scheduled_end: new Date(dbNow + 30 * 60_000).toISOString(),
      p_reason: `Access revocation acceptance session ${runId}`,
    });
    const evidence = async (enrolment, who) => {
      await deps.assertWriteGates(admin);
      return rpc(admin, "record_learning_evidence", {
        p_session_id: sessionId,
        p_enrolment_id: enrolment,
        p_objective_id: objective.id,
        p_evidence_kind: "CLASS_RESPONSE",
        p_result: "CORRECT",
        p_evidence_reference: `acceptance-revocation-${runId}-${who}`,
        p_idempotency_key: `acceptance-revocation-${runId}-${who}`,
        p_reason: `Access revocation acceptance evidence ${runId}`,
      });
    };
    const evidenceId = await evidence(enrolmentId, "learner");
    const foreignEvidenceId = await evidence(course.enrolmentId, "foreign");
    await deps.assertWriteGates(admin);
    const progressId = await rpc(admin, "record_lesson_progress", {
      p_session_id: sessionId,
      p_enrolment_id: enrolmentId,
      p_segment_id: segmentId,
      p_status: "COMPLETED",
      p_reason: `Access revocation acceptance progress ${runId}`,
    });
    const [masteryRow] = await deps.query(Q.mastery, [
      enrolmentId,
      objective.id,
    ]);
    if (!masteryRow)
      throw new SetupBlocked(
        "Evidence did not produce an objective mastery record.",
      );

    const contentBefore =
      (
        await count(
          learner,
          "lessons",
          "programme_version_id",
          course.programmeVersionId,
        )
      ).count ?? 0;
    const [{ status: enrolmentBefore } = {}] = await deps.query(
      Q.enrolmentStatus,
      [enrolmentId],
    );

    log(
      "Revoking the learner's course access through the governed cancellation...",
    );
    await deps.assertWriteGates(admin);
    const revokeResult = await rpc(
      admin,
      "admin_revoke_commercial_v1_entitlement",
      {
        p_entitlement_id: redemption.entitlementId,
        p_reason: `Access revocation acceptance ${runId}`,
      },
    );

    // ---- Post-revocation, read-only verification. ----
    const learnerHistory = await history(learner);
    const after = Object.fromEntries(
      Object.entries(learnerHistory).map(([k, r]) => [
        k,
        r.error ? null : r.data,
      ]),
    );
    const sensitive = sensitivePackageStrings(buildAcceptancePackage(runId));
    const v = course.programmeVersionId;
    const contentAfter = {
      modules: await count(learner, "modules", "programme_version_id", v),
      lessons: await count(learner, "lessons", "programme_version_id", v),
      lesson_objectives: await count(
        learner,
        "lesson_objectives",
        "programme_version_id",
        v,
      ),
      lesson_segments: await count(
        learner,
        "lesson_segments",
        "programme_version_id",
        v,
      ),
      learning_resources: await count(
        learner,
        "learning_resources",
        "programme_version_id",
        v,
      ),
      assignments: await count(
        learner,
        "assignments",
        "programme_version_id",
        v,
      ),
      assessments: await count(
        learner,
        "assessments",
        "programme_version_id",
        v,
      ),
    };
    const probeEmbed = async (name, table, select, id, embedKeys) => {
      const { data, error } = await learner
        .from(table)
        .select(select)
        .eq("id", id);
      if (error) return { name, error: true, code: error.code ?? null };
      const rows = data ?? [];
      return {
        name,
        error: false,
        rows: rows.length,
        visibleEmbeds: rows.filter((r) => embedKeys.some((k) => r?.[k])).length,
      };
    };
    const embeds = [
      await probeEmbed(
        "learning_evidence -> lessons, lesson_objectives",
        "learning_evidence",
        "id,lessons(title),lesson_objectives(description)",
        evidenceId,
        ["lessons", "lesson_objectives"],
      ),
      await probeEmbed(
        "lesson_progress -> lesson_segments",
        "lesson_progress",
        "id,lesson_segments(title)",
        progressId,
        ["lesson_segments"],
      ),
    ];

    const foreignHistory = await history(foreign);
    const foreignDirect = {
      learning_evidence:
        (await count(foreign, "learning_evidence", "id", evidenceId)).count ??
        -1,
      objective_mastery:
        (await count(foreign, "objective_mastery", "id", masteryRow.id))
          .count ?? -1,
      lesson_progress:
        (await count(foreign, "lesson_progress", "id", progressId)).count ?? -1,
    };
    const nonStudentResults = nonStudent
      ? await history(nonStudent.client)
      : {};
    const anon = deps.anonRpc
      ? await deps.anonRpc()
      : await (
          await import("./supabase.mjs")
        )
          .anonClient()
          .rpc("get_student_retained_learning_history", { p_kind: "evidence" });

    const [entitlement] = await deps.query(Q.entitlement, [
      redemption.entitlementId,
    ]);
    const [{ status: enrolmentAfter } = {}] = await deps.query(
      Q.enrolmentStatus,
      [enrolmentId],
    );
    const [auditRow] = await deps.query(Q.revocationAudit, [
      redemption.entitlementId,
    ]);

    const leaks = leakedSensitiveStrings(after, sensitive).length;
    const results = [
      Object.values(learnerHistory).some((r) => r.error)
        ? fail(
            SURFACES.RETAINED_HISTORY,
            "The learner's own projection call failed after revocation.",
          )
        : evaluateRetainedHistory({
            after,
            expected: {
              evidenceId,
              masteryId: masteryRow.id,
              progressId,
              lessonTitle: lessonRow.title,
              objectiveDescription: objective.description,
              segmentTitle: segmentRow.title,
            },
            sensitive,
          }),
      evaluateContentClosed({
        before: { lessons: contentBefore },
        after: contentAfter,
        embeds,
        historyLeaks: leaks,
      }),
      evaluateForeignIsolation({
        foreignHistory,
        foreignDirect,
        affectedIds: [evidenceId, masteryRow.id, progressId],
        foreignOwnEvidenceId: foreignEvidenceId,
      }),
      evaluateNonStudent({
        identity: nonStudent?.label ?? null,
        results: nonStudentResults,
        anon,
      }),
      evaluateReviewerCommerceProvenance({
        entitlement,
        enrolmentBefore,
        enrolmentAfter,
        revokeResult,
        audit: auditRow?.after_state,
        contentBefore,
        contentAfter: contentAfter.lessons.count,
      }),
    ].map((r) => ({ ...r, details: [...(r.details ?? []), `run ${runId}`] }));
    return [...results, ...fixed];
  } catch (error) {
    if (error instanceof AcceptanceWriteNotAuthorizedError)
      return [...allLive(blocked, error.message), ...fixed];
    if (error instanceof SetupBlocked)
      return [
        ...allLive(
          blocked,
          `Setup through governed paths did not complete: ${error.message}`,
        ),
        ...fixed,
      ];
    return [
      ...allLive(
        fail,
        "The access-revocation acceptance stopped unexpectedly.",
        [error instanceof Error ? error.message : String(error)],
      ),
      ...fixed,
    ];
  }
}

async function main() {
  console.log("===== Migration 045 hosted ACCESS-REVOCATION acceptance =====");
  console.log(
    "Explicit operator-run, MUTATING command (run-tagged synthetic history; nothing is deleted). Not Stripe-refund acceptance.",
  );
  console.log("");
  const results = await runCommerceRevocationAcceptance();
  for (const r of results) printResult(r);
  printSummary(results, "Migration 045 hosted ACCESS-REVOCATION acceptance");
  process.exit(exitCodeFor(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
