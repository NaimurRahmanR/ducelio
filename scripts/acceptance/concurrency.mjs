#!/usr/bin/env node
// npm run acceptance:concurrency
//
// True PostgreSQL concurrency acceptance (Checkpoint E3). PGlite is a
// single-connection embedded database and cannot prove independent-session
// locking/uniqueness behaviour. Two kinds of race live here:
//
// - INITIAL_VS_INITIAL, RECOVERY_VS_RECOVERY and NEVER_TWO_REVISION_ONES
//   use TWO genuinely independent `pg` connections (db.mjs's connectMany),
//   each with its own backend process on the server, and race the
//   DATABASE-LEVEL constraint (unique index) the governed RPCs rely on to
//   admit "exactly one" under real contention. They do not re-exercise the
//   HMAC-attested RPC business logic itself (already proven correct, in
//   isolation, by the existing local test suite); see surfaces.mjs's
//   GRADING/INITIAL_RECOVERY/REGRADE comments for why this harness never
//   reimplements that trust-critical protocol.
// - COMPLETION_VS_COMPLETION (V7) is NOT a raw insert race. It drives the
//   governed public.attempt_commercial_v1_course_completion RPC itself,
//   from two independently signed-in learner Supabase clients, against a
//   separate completion-ready course (see scenarioCompletionVsCompletion).
// - LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE and REGRADE_VS_COMPLETION
//   are real-APPLICATION races (concurrency-app-races.mjs): they start the
//   real Ducelio app server through examiner-app.mjs's shared session and
//   drive the unmodified grading/recovery/regrade entrypoints, whose
//   attestations are produced only by the production authority modules.
//   They additionally need the examiner-app prerequisites (controller key,
//   ACADEMIC_EXECUTION_* settings); without them both report BLOCKED.
// - AC3_PROFESSOR_HANDOFF_DUPLICATE (ac3-handoff-race.mjs) is a SEPARATE
//   AC-3 / migration-052 scenario, run after and reported apart from the
//   Commercial V1 scenarios: two independent authenticated-learner
//   connections race the governed request_professor_academic_handoff RPC.
//
// Start discipline (V7): NEVER_TWO_REVISION_ONES,
// COMPLETION_VS_COMPLETION and both application races release both
// contenders from one in-process start gate (createStartGate) once both
// are fully prepared.
// INITIAL_VS_INITIAL/RECOVERY_VS_RECOVERY dispatch both statements from
// the same synchronous Promise.allSettled call. In every case this proves
// both requests were dispatched together from the client side -- never
// that the server began executing them at the same instant. Never
// sequential queries dressed up as concurrency.
//
// Isolation: every row this script creates is tagged with a unique
// acceptance run id (embedded in the course package key seedAcceptanceCourse
// builds -- see fixtures.mjs). Never touches a real learner record; never
// TRUNCATEs, DROPs or issues an unscoped DELETE.
//
// Write safety: every single-connection mutation in this file opens its
// connection through db.mjs's withAcceptanceWriteConnection(), which gates
// via assertAcceptanceDatabaseWriteAuthorized() BEFORE `work` runs a single
// statement, never through bare withConnection() (reserved for read-only
// introspection). Every two-client race instead opens via connectMany()
// and gates both with assertAllAcceptanceDatabaseWriteAuthorized() before
// either side's INSERT. Either way: fails BLOCKED before the first write
// if ACCEPTANCE_WRITE_ENABLED, a valid ACCEPTANCE_ENVIRONMENT_ID and the
// matching in-database acceptance-environment marker are not all present
// (independent-review findings 1 and 2). seedAcceptanceCourse's own writes
// travel through supabase-js/PostgREST instead, gated independently by
// assertAcceptanceSupabaseWriteAuthorized (see fixtures.mjs/supabase.mjs).
//
// Independent-review finding (schema-consistency audit): the owning-chain
// fixture used to build its own programme/version/module/lesson/objective/
// course_package_imports/course_activations graph directly, via raw
// inserts. That graph had drifted badly out of sync with the schema
// (migrations through 2609250042) -- inserting programme_versions as
// PUBLISHED directly (migration 2609080006 rejects this outright: "Create
// programme versions as DRAFT and publish after content validation"),
// skipping the module/lesson/objective graph a real publish requires,
// inserting a synthetic app_users row that violates the base identity
// check (auth_user_id is not null or is_demo), omitting lessons'
// programme_version_id, omitting course_package_imports' PUBLISHED
// lifecycle metadata, missing the course_activation_versions binding
// course_activations now requires (migration 2609140027), and omitting
// assessments.created_by. Rather than re-encode all of that a second time
// in raw SQL -- which is exactly how it drifted -- the owning chain is now
// built through the SAME governed, non-HMAC RPC pipeline fixtures.mjs's
// seedAcceptanceCourse() already uses for RESULT_PROGRESS_COMPLETION
// (import -> validate -> apply -> test -> publish -> activate -> enrol ->
// bind -> policies), so there is exactly one place this graph is
// constructed, kept in sync by the same review that keeps the RPCs
// themselves correct. Only the one thing that pipeline does NOT create --
// real assessment_attempts rows for the concurrency races to target -- is
// still seeded directly here (fixtures.mjs's seedAcceptanceAttempt,
// itself gated), because a real attempt is an ordinary, ungoverned write
// with no HMAC involved and no session/timing concern this harness needs.
// TWO distinct attempts are seeded, against two distinct bound
// assessments (QUIZ_1 and QUIZ_2) -- see seedOwningChain below for why:
// commercial_v1_examiner_executions' unique index on attempt_id alone is
// permanent (rows are never deletable), so INITIAL_VS_INITIAL and
// RECOVERY_VS_RECOVERY cannot safely share one attempt.
//
// This does mean acceptance:concurrency now needs real hosted Supabase
// Auth identities (ACCEPTANCE_ADMIN_EMAIL/PASSWORD,
// ACCEPTANCE_LEARNER_EMAIL/PASSWORD), not only ACCEPTANCE_DATABASE_URL --
// see main()'s guard below, which BLOCKS with a clear message rather than
// attempting a partial/synthetic substitute for either.
//
// Cleanup: unlike the old raw fixture, nothing here is deleted afterwards.
// Every row the governed pipeline creates is real, permanent institutional
// history the instant the programme version is PUBLISHED and enrolled
// (migration 2609080001's guard_curriculum_version trigger rejects the
// UPDATE/DELETE outright), and every raw test-owner row the race scenarios
// insert lands in an explicitly append-only/guarded table
// (assessment_attempts, commercial_v1_examiner_executions,
// commercial_v1_examiner_recovery_executions,
// commercial_v1_assessment_result_revisions -- migrations
// 2609090016/2609160031/2609240040/2609150030 each unconditionally reject
// DELETE). COMPLETION_VS_COMPLETION's separate course and the completion
// receipt the governed RPC writes are equally permanent; its PASS/FAIL
// details name that course's run id/import/enrolment for operator review.
// There is nothing left a cleanup step could safely remove --
// attempting to would throw, exactly as the previous version's ungated
// post-race DELETEs in scenarioRecoveryVsRecovery did the first time this
// ran hosted. logAcceptanceChain() below only logs what this run created,
// tagged by runId, for manual operator review -- mirroring
// fixtures.mjs's own cleanupAcceptanceRun design for the same reason.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  connectMany,
  withConnection,
  withAcceptanceWriteConnection,
  acceptanceDbConfigured,
  assertAllAcceptanceDatabaseWriteAuthorized,
  AcceptanceWriteNotAuthorizedError,
} from "./db.mjs";
import {
  hostedSupabaseConfigured,
  acceptanceIdentities,
  acceptanceIdentitiesConfigured,
} from "./supabase.mjs";
import {
  seedAcceptanceCourse,
  seedAcceptanceAttempt,
  seedAcceptanceResults,
} from "./fixtures.mjs";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
} from "./report.mjs";
import {
  createStartGate,
  runAppRaceScenarios,
} from "./concurrency-app-races.mjs";
import { scenarioAc3ProfessorHandoffDuplicate } from "./ac3-handoff-race.mjs";

// createStartGate lives with the application races (which also need it)
// and is re-exported here, where the DB-level races and tests use it.
export { createStartGate };

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Independent-review finding (v4, this pass): a rejected race statement
// only counts as the intended "loser" -- proof a unique index admitted
// exactly one of two genuinely concurrent inserts -- when PostgreSQL's
// own error code is EXACTLY 23505 (unique_violation). A prior version
// counted ANY rejection as the loser, which could silently turn a
// transient connection error, an unrelated CHECK/FK violation, or a
// permission problem into an apparent PASS. Every scenario below now
// classifies each rejection explicitly; anything other than a genuine
// 23505 is reported as a distinct, named failure, never folded into the
// expected-loser count.
const UNIQUE_VIOLATION_SQLSTATE = "23505";
function isUniqueViolation(reason) {
  return (
    Boolean(reason) &&
    typeof reason === "object" &&
    reason.code === UNIQUE_VIOLATION_SQLSTATE
  );
}
function classifyRace(settled) {
  const fulfilled = settled.filter((s) => s.status === "fulfilled").length;
  const rejected = settled.filter((s) => s.status === "rejected");
  const uniqueRejected = rejected.filter((s) =>
    isUniqueViolation(s.reason),
  ).length;
  const otherRejections = rejected
    .filter((s) => !isUniqueViolation(s.reason))
    .map((s) =>
      s.reason instanceof Error ? s.reason.message : String(s.reason),
    );
  return { fulfilled, uniqueRejected, otherRejections };
}

// Builds the minimal, real-shaped owning chain (course/activation/cohort/
// enrolment plus two distinct assessment/attempt pairs, QUIZ_1 and
// QUIZ_2) every race scenario below needs a foreign key into. See the
// module header for why this is now built through the governed RPC
// pipeline (fixtures.mjs's seedAcceptanceCourse) plus two direct, gated
// attempt inserts, rather than raw inserts of the whole graph -- and why
// two distinct attempts, not one shared between scenarios.
export async function seedOwningChain() {
  const admin = await acceptanceIdentities.admin();
  const learner = await acceptanceIdentities.learner();
  const { data: learnerUser, error: learnerUserError } =
    await learner.auth.getUser();
  if (learnerUserError || !learnerUser?.user?.id)
    throw new Error(
      "Could not resolve the acceptance learner's own hosted Supabase Auth user id.",
    );

  // Real course/activation/cohort/enrolment graph, built through the SAME
  // governed RPC pipeline fixtures.mjs's RESULT_PROGRESS_COMPLETION check
  // already uses -- see the module header for why. seedAcceptanceCourse
  // resolves the correct app_users.id internally from the Auth user id.
  const course = await seedAcceptanceCourse(admin, runId, learnerUser.user.id);

  // Independent-review finding (cross-scenario attempt collision, this
  // pass): commercial_v1_examiner_executions carries a PERMANENT unique
  // index on attempt_id alone (examiner_execution_one_per_attempt,
  // migration 2609160031) -- rows are never deletable. INITIAL_VS_INITIAL
  // leaves one admitted row for its attempt forever; if
  // RECOVERY_VS_RECOVERY's own seed insert (a second
  // commercial_v1_examiner_executions row, this time FAILED) targeted the
  // SAME attempt_id, it would violate that unique index before the
  // recovery race even starts. Two DISTINCT bound assessments -- QUIZ_1
  // and QUIZ_2, both already bound by the governed pipeline above -- each
  // get their own real attempt: QUIZ_1/its attempt for
  // INITIAL_VS_INITIAL/NEVER_TWO_REVISION_ONES; the wholly separate
  // QUIZ_2/its attempt for RECOVERY_VS_RECOVERY only.
  // COMPLETION_VS_COMPLETION (V7) never uses this chain's enrolment -- it
  // seeds its own separate completion-ready course.
  // Neither assessment's attempts_allowed=1 governed limit is exceeded --
  // each gets exactly one real attempt, never a second one fabricated
  // against the same assessment merely to dodge the unique index.
  const { assessmentId, recoveryAssessmentId } = await withConnection(
    async (client) => {
      const { rows } = await client.query(
        `select cb.component as component, a.id as assessment_id
         from commercial_v1_component_bindings cb
         join assessments a on a.id=cb.assessment_id
         where cb.activation_id=$1 and cb.component in ('QUIZ_1','QUIZ_2')`,
        [course.activationId],
      );
      const byComponent = Object.fromEntries(
        rows.map((r) => [r.component, r.assessment_id]),
      );
      return {
        assessmentId: byComponent.QUIZ_1 ?? null,
        recoveryAssessmentId: byComponent.QUIZ_2 ?? null,
      };
    },
  );
  if (!assessmentId || !recoveryAssessmentId)
    throw new Error(
      "Both a QUIZ_1 and a QUIZ_2 assessment binding are required for the acceptance activation -- QUIZ_1 targets INITIAL_VS_INITIAL/NEVER_TWO_REVISION_ONES and the distinct QUIZ_2 targets RECOVERY_VS_RECOVERY, so the two never collide on examiner_execution_one_per_attempt.",
    );

  // The one thing the governed pipeline does not create: real attempts
  // for the race scenarios to target (see fixtures.mjs's
  // seedAcceptanceAttempt for why a direct, gated insert is legitimate
  // here rather than exercising start_assessment_attempt's session/timing
  // concerns, which this harness is not testing). One per assessment --
  // never two attempts against the same assessment.
  const attemptId = await withAcceptanceWriteConnection((client) =>
    seedAcceptanceAttempt(client, {
      assessmentId,
      enrolmentId: course.enrolmentId,
      studentId: course.studentId,
      cohortId: course.cohortId,
      programmeVersionId: course.programmeVersionId,
    }),
  );
  const recoveryAttemptId = await withAcceptanceWriteConnection((client) =>
    seedAcceptanceAttempt(client, {
      assessmentId: recoveryAssessmentId,
      enrolmentId: course.enrolmentId,
      studentId: course.studentId,
      cohortId: course.cohortId,
      programmeVersionId: course.programmeVersionId,
    }),
  );

  return {
    importId: course.importId,
    versionId: course.programmeVersionId,
    cohortId: course.cohortId,
    activationId: course.activationId,
    studentId: course.studentId,
    enrolmentId: course.enrolmentId,
    assessmentId,
    attemptId,
    recoveryAssessmentId,
    recoveryAttemptId,
    // Independent-review finding (v5, this pass): the recovery race's
    // actor_id must be a real, verified ACADEMIC_ADMIN/PLATFORM_ADMIN
    // app_users.id (migration 2609240040 defines actor_id as exactly
    // that, and its governed recovery function rejects any other actor)
    // -- never chain.studentId, which is the LEARNER, not the actor.
    // seedAcceptanceCourse already resolved and independently verified
    // this identity; carried through under its own explicit name so no
    // caller can confuse it with the learner or the plain instructor id.
    recoveryActorId: course.recoveryActorId,
  };
}

// See the module header: nothing created above can be safely deleted any
// more (the governed graph is immutable the instant it is published and
// enrolled; every raw test-owner row lands in an append-only/guarded
// table). This only logs what to look for under manual review -- it opens
// no connection and needs no gate, exactly like fixtures.mjs's
// cleanupAcceptanceRun.
function logAcceptanceChain(chain) {
  if (!chain) return;
  console.log(
    `Acceptance run ${runId} created a real Commercial V1 course/activation/enrolment ` +
      `(course_package_imports id ${chain.importId}, activation ${chain.activationId}, ` +
      `enrolment ${chain.enrolmentId}, QUIZ_1 attempt ${chain.attemptId}, ` +
      `QUIZ_2 attempt ${chain.recoveryAttemptId}) plus the institutional-audit rows the ` +
      "scenarios below inserted under it (examiner executions/recovery executions/result " +
      "revisions; COMPLETION_VS_COMPLETION's separate course is named in its own result " +
      "details). These are immutable institutional history by design " +
      "(append-only/guarded triggers reject every DELETE) and are not auto-deleted; they " +
      "remain uniquely identifiable by this run id for manual operator review.",
  );
}

export async function scenarioInitialVsInitial(chain) {
  const { clients, closeAll } = await connectMany(2);
  try {
    await assertAllAcceptanceDatabaseWriteAuthorized(clients);
    // Independent-review finding (this pass): AUTHORIZED requires
    // started_at IS NULL (migration 2609160031's state CHECK) -- omitted
    // below, never set. And every timestamp-equality/deadline CHECK
    // (authorized_at=created_at; expires_at<=created_at+20s) must hold
    // EXACTLY -- three separate clock_timestamp() calls are not
    // guaranteed to return the same value, so a single `WITH stamp AS
    // (SELECT clock_timestamp() AS t)` CTE supplies ONE value every
    // computed column derives from. A CTE referencing a VOLATILE function
    // like clock_timestamp() is evaluated exactly once per statement
    // execution, never once per reference.
    const insert = (id) => [
      `with stamp as (select clock_timestamp() as t)
      insert into commercial_v1_examiner_executions(
        id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
        runtime_profile_ref,state,created_at,authorized_at,expires_at,
        max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) select $1,$2,$3,$4,'grade_controlled_assessment','ASSESSMENT_ATTEMPT',$5,'QUIZ_1',
        'EXAMINER_COMMERCIAL_V1','AUTHORIZED',t,t,t+interval '20 seconds',
        1,1200,50000
      from stamp`,
      [
        id,
        chain.studentId,
        chain.enrolmentId,
        chain.activationId,
        chain.attemptId,
      ],
    ];
    // Both connections target the SAME attempt_id (chain.attemptId), which
    // is what the partial unique index examiner_execution_one_per_attempt
    // actually enforces -- the generated row id differs per side (as a real
    // client would), only attempt_id must collide. Fired together via
    // Promise.allSettled so a rejection on one side never hides the other
    // side's real outcome.
    const settled = await Promise.allSettled([
      clients[0].query(...insert(randomUUID())),
      clients[1].query(...insert(randomUUID())),
    ]);
    const { fulfilled, uniqueRejected, otherRejections } =
      classifyRace(settled);
    const { rows } = await withConnection((c) =>
      c.query(
        "select count(*)::int as n from commercial_v1_examiner_executions where attempt_id=$1",
        [chain.attemptId],
      ),
    ).then((r) => r);
    if (
      fulfilled === 1 &&
      uniqueRejected === 1 &&
      otherRejections.length === 0 &&
      rows[0].n === 1
    )
      return pass(
        "POSTGRES_CONCURRENCY:INITIAL_VS_INITIAL",
        "Database-constraint acceptance test (raw insert against examiner_execution_one_per_attempt, not the governed HMAC-attested AUTHORIZE RPC): exactly one of two genuinely concurrent inserts was admitted; the other was rejected by the unique index (SQLSTATE 23505).",
      );
    return fail(
      "POSTGRES_CONCURRENCY:INITIAL_VS_INITIAL",
      `Expected 1 fulfilled/1 unique-violation(23505)-rejected/0 other rejections/1 row; got ${fulfilled} fulfilled, ${uniqueRejected} unique-violation-rejected, ${otherRejections.length} other rejection(s), ${rows[0].n} row(s).`,
      otherRejections,
    );
  } finally {
    await closeAll();
  }
}

export async function scenarioRecoveryVsRecovery(chain) {
  // Requires a terminal FAILED original execution to recover -- seeded the
  // same test-owner way the local recovery fixtures already do.
  //
  // Independent-review finding (cross-scenario attempt collision, this
  // pass): this MUST target chain.recoveryAttemptId/'QUIZ_2', never
  // chain.attemptId/'QUIZ_1' -- INITIAL_VS_INITIAL already leaves a
  // permanent, non-deletable commercial_v1_examiner_executions row for
  // chain.attemptId (examiner_execution_one_per_attempt, migration
  // 2609160031, is a unique index on attempt_id alone). Seeding a second
  // row for that same attempt_id here would violate it before this
  // scenario's own race even starts. See seedOwningChain for how the two
  // distinct assessments/attempts are built.
  const originalId = randomUUID();
  // Independent-review finding (this pass): the same one-stamp-per-
  // statement requirement applies to a historical FAILED row -- five
  // separate clock_timestamp()-derived expressions previously had no
  // guarantee of landing on a single consistent timeline, and could
  // violate authorized_at=created_at or the exact expires_at<=created_at+
  // 20s deadline. ONE stamp `t` now derives a valid, internally
  // consistent historical timeline: created_at=authorized_at=t-60s (equal,
  // as required), started_at=t-50s (>= created_at, < expires_at),
  // terminal_at=expires_at=t-40s (terminal_at >= started_at; expires_at is
  // EXACTLY created_at+20s, satisfying the <= boundary exactly).
  await withAcceptanceWriteConnection(async (c) => {
    return c.query(
      `with stamp as (select clock_timestamp() as t)
      insert into commercial_v1_examiner_executions(
        id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
        runtime_profile_ref,state,reason_code,created_at,authorized_at,started_at,terminal_at,expires_at,
        max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) select $1,$2,$3,$4,'grade_controlled_assessment','ASSESSMENT_ATTEMPT',$5,'QUIZ_2',
        'EXAMINER_COMMERCIAL_V1','FAILED','PROVIDER_UNAVAILABLE',
        t-interval '60 seconds',t-interval '60 seconds',t-interval '50 seconds',t-interval '40 seconds',t-interval '40 seconds',
        1,1200,50000
      from stamp`,
      [
        originalId,
        chain.studentId,
        chain.enrolmentId,
        chain.activationId,
        chain.recoveryAttemptId,
      ],
    );
  });
  const { clients, closeAll } = await connectMany(2);
  try {
    await assertAllAcceptanceDatabaseWriteAuthorized(clients);
    // Independent-review finding (this pass): same one-stamp requirement
    // as the initial-vs-initial race -- started_at was already correctly
    // omitted here (AUTHORIZED requires it NULL), but created_at/
    // authorized_at/expires_at each came from a separate clock_timestamp()
    // call with no equality/deadline guarantee. ONE stamp `t` fixes that.
    const insert = (id, actorId) => [
      `with stamp as (select clock_timestamp() as t)
      insert into commercial_v1_examiner_recovery_executions(
        id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,capability,target_kind,
        attempt_id,component,runtime_profile_ref,state,created_at,authorized_at,expires_at,
        max_provider_calls,max_output_tokens,max_estimated_cost_microusd
      ) select $1,$2,$3,'Concurrency acceptance race',$4,$5,$6,'grade_controlled_assessment','ASSESSMENT_ATTEMPT',
        $7,'QUIZ_2','EXAMINER_COMMERCIAL_V1','AUTHORIZED',t,t,t+interval '20 seconds',
        1,1200,50000
      from stamp`,
      [
        id,
        actorId,
        originalId,
        chain.studentId,
        chain.enrolmentId,
        chain.activationId,
        chain.recoveryAttemptId,
      ],
    ];
    // Independent-review finding (v5, this pass, BLOCKER): actor_id must
    // be the real, verified ACADEMIC_ADMIN/PLATFORM_ADMIN
    // (chain.recoveryActorId) -- migration 2609240040 defines actor_id as
    // exactly that, and the governed recovery function rejects any other
    // actor. student_id (chain.studentId, set inside insert() above)
    // correctly remains the learner; conflating the two here was the bug.
    const settled = await Promise.allSettled([
      clients[0].query(...insert(randomUUID(), chain.recoveryActorId)),
      clients[1].query(...insert(randomUUID(), chain.recoveryActorId)),
    ]);
    const { fulfilled, uniqueRejected, otherRejections } =
      classifyRace(settled);
    const { rows } = await withConnection((c) =>
      c.query(
        "select count(*)::int as n from commercial_v1_examiner_recovery_executions where source_execution_id=$1",
        [originalId],
      ),
    );
    // Independent-review finding (schema-consistency audit): these two
    // rows can no longer be deleted -- both
    // commercial_v1_examiner_recovery_executions and
    // commercial_v1_examiner_executions unconditionally reject DELETE
    // (migration 2609240040/2609160031's guard triggers: "Examiner
    // recovery execution history cannot be deleted" /
    // "Examiner execution history cannot be deleted"). A previous version
    // of this scenario tried to DELETE them anyway (ungated originally,
    // then gated but still targeting an undeletable row) -- it would have
    // thrown here on every real hosted run. They are left in place as
    // permanent, run-scoped institutional history instead; see
    // logAcceptanceChain in main()'s finally block.
    if (
      fulfilled === 1 &&
      uniqueRejected === 1 &&
      otherRejections.length === 0 &&
      rows[0].n === 1
    )
      return pass(
        "POSTGRES_CONCURRENCY:RECOVERY_VS_RECOVERY",
        "Database-constraint acceptance test (raw insert against examiner_recovery_one_per_source, not the governed HMAC-attested recovery AUTHORIZE RPC): exactly one of two genuinely concurrent recovery-claim inserts was admitted for the same source; the other was rejected by the unique index (SQLSTATE 23505).",
      );
    return fail(
      "POSTGRES_CONCURRENCY:RECOVERY_VS_RECOVERY",
      `Expected 1 fulfilled/1 unique-violation(23505)-rejected/0 other rejections/1 row; got ${fulfilled} fulfilled, ${uniqueRejected} unique-violation-rejected, ${otherRejections.length} other rejection(s), ${rows[0].n} row(s).`,
      otherRejections,
    );
  } finally {
    await closeAll();
  }
}

// V7 (Defect A): one contender's whole revision-1 write -- the result
// revision, one question-marks row per REAL question, derived objective
// outcomes and a successful assessment_result_is_valid() assertion -- inside
// ONE transaction on ONE independent connection, before COMMIT. The
// previous shape raced bare revision inserts, let the winner COMMIT with no
// marks/outcomes, and only completed it afterwards in a second transaction:
// if that repair failed, an invalid immutable revision stayed committed
// forever. Now a contender either commits a complete, verified-valid
// revision or rolls back everything it wrote. The loser's unique-index
// rejection (SQLSTATE 23505) happens at its INSERT, which blocks on the
// winner's uncommitted index entry until the winner commits.
async function commitCompleteRevisionOne(client, gate, chain, questions) {
  try {
    await client.query("begin");
  } finally {
    // Arrive even if BEGIN failed, so the other contender is never
    // stranded at the gate; the BEGIN error still propagates.
    await gate.arrive();
  }
  try {
    const maxMarksTotal = questions.reduce((sum, q) => sum + q.max_marks, 0);
    const { rows } = await client.query(
      `insert into commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
        earned_marks_total,max_marks_total,component_weight_bp
      ) values($1,$2,$3,'QUIZ_1',$4,$5,1,$6,$6,500)
      returning id`,
      [
        chain.activationId,
        chain.enrolmentId,
        chain.studentId,
        chain.attemptId,
        chain.assessmentId,
        maxMarksTotal,
      ],
    );
    const resultRevisionId = rows[0].id;
    for (const question of questions) {
      await client.query(
        `insert into commercial_v1_assessment_question_marks(
          result_revision_id, question_id, marks_awarded, max_marks_snapshot
        ) values($1,$2,$3,$4)`,
        [resultRevisionId, question.id, question.max_marks, question.max_marks],
      );
    }
    await client.query(
      "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
      [resultRevisionId],
    );
    const { rows: validRows } = await client.query(
      "select commercial_v1_private.assessment_result_is_valid($1) as valid",
      [resultRevisionId],
    );
    if (validRows[0]?.valid !== true)
      throw new Error(
        `NEVER_TWO_REVISION_ONES result revision ${resultRevisionId} failed commercial_v1_private.assessment_result_is_valid() inside its own transaction -- rolled back, never committed.`,
      );
    await client.query("commit");
    return resultRevisionId;
  } catch (error) {
    // The original error (23505 for the expected loser) stays the one
    // classifyRace sees; a failed ROLLBACK on a broken connection is moot
    // because the server aborts the transaction when closeAll() ends it.
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function scenarioNeverTwoRevisionOnes(chain) {
  // Real questions (and so the real max_marks_total) come from
  // assessment_questions, never a hard-coded 10. Races full marks, so the
  // surviving revision never opens remediation history this harness
  // cannot delete.
  const questions = await withConnection(async (c) => {
    const { rows } = await c.query(
      "select id, max_marks from assessment_questions where assessment_id=$1 order by position",
      [chain.assessmentId],
    );
    return rows;
  });
  if (!questions.length)
    throw new Error(
      "No assessment_questions found for the QUIZ_1 assessment -- cannot build a valid result revision.",
    );
  const { clients, closeAll } = await connectMany(2);
  try {
    await assertAllAcceptanceDatabaseWriteAuthorized(clients);
    const gate = createStartGate(clients.length);
    const settled = await Promise.allSettled(
      clients.map((client) =>
        commitCompleteRevisionOne(client, gate, chain, questions),
      ),
    );
    const { fulfilled, uniqueRejected, otherRejections } =
      classifyRace(settled);
    const winnerId =
      settled.find((s) => s.status === "fulfilled")?.value ?? null;
    // Every QUIZ_1 revision for this enrolment, whatever its number: the
    // race must leave exactly one, it must be revision 1, it must be the
    // one the winning contender committed, and it must be valid.
    const { rows } = await withConnection((c) =>
      c.query(
        `select id, revision_number,
                commercial_v1_private.assessment_result_is_valid(id) as valid
         from commercial_v1_assessment_result_revisions
         where enrolment_id=$1 and component='QUIZ_1'`,
        [chain.enrolmentId],
      ),
    );
    const survivor = rows.length === 1 ? rows[0] : null;
    if (
      fulfilled === 1 &&
      uniqueRejected === 1 &&
      otherRejections.length === 0 &&
      survivor?.revision_number === 1 &&
      survivor.valid === true &&
      survivor.id === winnerId
    )
      return pass(
        "POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES",
        "Database-constraint acceptance test (raw transactional write against unique(enrolment_id,component,revision_number), the constraint every governed FINALIZE path -- initial, recovery and regrade -- ultimately relies on): two independent connections each began a transaction, were released together from one start gate, and each tried to write a COMPLETE revision 1 (revision, every question mark, derived objective outcomes, validity asserted) before COMMIT. Exactly one committed; the other was rejected by the unique index (SQLSTATE 23505) and rolled back. Exactly one valid revision 1 survives.",
      );
    return fail(
      "POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES",
      `Expected 1 committed/1 unique-violation(23505)-rolled-back/0 other rejections and exactly one surviving valid revision 1 matching the winner; got ${fulfilled} committed, ${uniqueRejected} unique-violation-rejected, ${otherRejections.length} other rejection(s), ${rows.length} QUIZ_1 revision(s) (${rows.map((r) => `revision ${r.revision_number} valid=${r.valid}`).join(", ") || "none"}).`,
      otherRejections,
    );
  } finally {
    await closeAll();
  }
}

// V7 (Defect B): COMPLETION_VS_COMPLETION used to race two raw INSERTs into
// commercial_v1_completion_receipts from privileged pg connections --
// bypassing the real institutional completion authority entirely. It now
// drives the governed public.attempt_commercial_v1_course_completion RPC
// (current_app_user() identity, enrolment row lock FOR UPDATE, real
// course_progress eligibility, receipt + status + audit written by the RPC
// itself) from two independently signed-in learner clients.
//
// It needs its OWN completion-ready course: NEVER_TWO_REVISION_ONES
// already leaves a permanent QUIZ_1 revision 1 on the owning chain's
// enrolment, so seedAcceptanceResults(course, true) -- which writes valid
// results for all six components plus the lab in one transaction -- would
// collide with it there. The separate course is built through the same
// governed helpers RESULT_PROGRESS_COMPLETION uses (seedAcceptanceCourse,
// seedAcceptanceResults), each carrying its own write gates; nothing here
// fabricates enrolment status or inserts a receipt.
export async function scenarioCompletionVsCompletion(chain) {
  const surface = "POSTGRES_CONCURRENCY:COMPLETION_VS_COMPLETION";
  const completionRunId = `${runId}-completion`;

  // Two separate sign-ins -> two independent learner sessions/clients,
  // never one shared client. Both must resolve to the same learner.
  const admin = await acceptanceIdentities.admin();
  const learners = [
    await acceptanceIdentities.learner(),
    await acceptanceIdentities.learner(),
  ];
  const learnerIds = [];
  for (const learner of learners) {
    const { data, error } = await learner.auth.getUser();
    if (error || !data?.user?.id)
      throw new Error(
        "Could not resolve the acceptance learner's own hosted Supabase Auth user id.",
      );
    learnerIds.push(data.user.id);
  }
  if (learners[0] === learners[1] || learnerIds[0] !== learnerIds[1])
    throw new Error(
      "COMPLETION_VS_COMPLETION requires two independent sessions of the SAME acceptance learner.",
    );

  const course = await seedAcceptanceCourse(
    admin,
    completionRunId,
    learnerIds[0],
  );
  if (course.enrolmentId === chain?.enrolmentId)
    throw new Error(
      "COMPLETION_VS_COMPLETION must use its own completion-ready enrolment, never the owning chain's.",
    );
  await seedAcceptanceResults(course, true);
  const evidence = [
    `Completion course run ${completionRunId}: course_package_imports ${course.importId}, activation ${course.activationId}, enrolment ${course.enrolmentId}`,
  ];

  const gate = createStartGate(learners.length);
  const settled = await Promise.allSettled(
    learners.map(async (learner, index) => {
      await gate.arrive();
      return learner.rpc("attempt_commercial_v1_course_completion", {
        p_enrolment_id: course.enrolmentId,
        p_reason: `Concurrency acceptance completion ${index + 1}`,
      });
    }),
  );

  const problems = [];
  const responses = settled.map((s, index) => {
    if (s.status === "rejected") {
      problems.push(
        `Call ${index + 1} threw: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
      );
      return null;
    }
    if (s.value?.error) {
      problems.push(`Call ${index + 1} errored: ${s.value.error.message}`);
      return null;
    }
    return s.value?.data ?? null;
  });
  const codes = responses.map((r) => r?.code ?? "NO_RESPONSE").sort();
  if (codes[0] !== "ALREADY_COMPLETED" || codes[1] !== "COMPLETED")
    problems.push(
      `Expected exactly one COMPLETED and one ALREADY_COMPLETED; got ${JSON.stringify(responses)}.`,
    );
  if (!responses.every((r) => r?.ok === true))
    problems.push("Both completion responses must be ok=true.");
  const completed = responses.find((r) => r?.code === "COMPLETED") ?? null;

  // Independent read-only verification of the institutional state the
  // governed RPC left behind.
  const state = await withConnection(async (c) => {
    const receipts = (
      await c.query(
        `select id, student_id, activation_id, cohort_id, programme_version_id,
                final_course_score_bp, pass_mark_bp, completed_by
         from commercial_v1_completion_receipts where enrolment_id=$1`,
        [course.enrolmentId],
      )
    ).rows;
    const enrolment =
      (
        await c.query(
          "select status, student_id, cohort_id, programme_version_id from enrolments where id=$1",
          [course.enrolmentId],
        )
      ).rows[0] ?? null;
    const activation =
      (
        await c.query(
          "select cohort_id, programme_version_id from course_activations where id=$1",
          [course.activationId],
        )
      ).rows[0] ?? null;
    const policy =
      (
        await c.query(
          "select pass_mark_bp from commercial_v1_result_policies where activation_id=$1",
          [course.activationId],
        )
      ).rows[0] ?? null;
    const completionAudits = (
      await c.query(
        "select count(*)::int as n from audit_events where action='COMMERCIAL_V1_COURSE_COMPLETED' and target_id=$1",
        [course.enrolmentId],
      )
    ).rows[0].n;
    return { receipts, enrolment, activation, policy, completionAudits };
  });

  const { receipts, enrolment, activation, policy, completionAudits } = state;
  const receipt = receipts.length === 1 ? receipts[0] : null;
  if (!receipt)
    problems.push(
      `Expected exactly one completion receipt for the enrolment; found ${receipts.length}.`,
    );
  if (enrolment?.status !== "COMPLETED")
    problems.push(
      `Expected enrolment status COMPLETED; got ${enrolment?.status ?? "no enrolment"}.`,
    );
  if (completionAudits !== 1)
    problems.push(
      `Expected exactly one COMMERCIAL_V1_COURSE_COMPLETED audit event; found ${completionAudits}.`,
    );
  if (receipt && enrolment && activation && policy) {
    if (
      !responses.every((r) => r?.receiptId === receipt.id) ||
      receipt.student_id !== enrolment.student_id ||
      receipt.student_id !== course.studentId ||
      receipt.completed_by !== course.studentId
    )
      problems.push(
        "Receipt identity is incoherent: both responses must name the one receipt, and its student/completed_by must be the enrolment's own learner.",
      );
    if (
      receipt.activation_id !== course.activationId ||
      receipt.cohort_id !== enrolment.cohort_id ||
      receipt.programme_version_id !== enrolment.programme_version_id ||
      activation.cohort_id !== enrolment.cohort_id ||
      activation.programme_version_id !== enrolment.programme_version_id
    )
      problems.push(
        "Receipt activation/cohort/programme-version lineage does not match the governed enrolment/activation.",
      );
    if (
      receipt.pass_mark_bp !== policy.pass_mark_bp ||
      receipt.final_course_score_bp < receipt.pass_mark_bp ||
      receipt.final_course_score_bp !== completed?.courseScoreBp
    )
      problems.push(
        `Receipt score/pass-mark state is incoherent (final ${receipt.final_course_score_bp}, pass mark ${receipt.pass_mark_bp}, policy ${policy.pass_mark_bp}, COMPLETED response ${completed?.courseScoreBp}).`,
      );
  } else if (receipt) {
    problems.push(
      "Could not read the enrolment, activation or result policy to verify the receipt lineage.",
    );
  }

  if (problems.length === 0)
    return pass(
      surface,
      "Governed completion acceptance test (public.attempt_commercial_v1_course_completion, not a raw receipt insert): two independently signed-in sessions of the same learner were released together from one start gate against a separate, legitimately completion-ready enrolment. Exactly one call returned COMPLETED and the other ALREADY_COMPLETED naming the same receipt; exactly one receipt, one completion audit event and enrolment status COMPLETED resulted, with coherent lineage and score. Proves the operation is idempotent under concurrently dispatched calls; does not prove the two server transactions overlapped in time.",
      evidence,
    );
  return fail(
    surface,
    "Governed concurrent completion did not produce exactly one coherent completion.",
    [...evidence, ...problems],
  );
}

// LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE and REGRADE_VS_COMPLETION
// used to be honest NOT_RUN placeholders (COVERED_BY_INVARIANT). They are
// now executed as distinct real-application races -- see
// concurrency-app-races.mjs for why neither is a renamed repeat of
// NEVER_TWO_REVISION_ONES. Until a hosted operator run actually executes
// them, their last recorded hosted evidence remains NOT_RUN (docs/38).

// Both application races share one real-app session (never the owning
// chain: each seeds its own course) and return one result per surface.
function scenarioApplicationRaces() {
  return runAppRaceScenarios();
}

async function main() {
  if (!acceptanceDbConfigured()) {
    const r = blocked(
      "POSTGRES_CONCURRENCY",
      "ACCEPTANCE_DATABASE_URL is not configured.",
      [
        "Provision a dedicated staging/acceptance PostgreSQL with at least two available connections.",
      ],
    );
    printResult(r);
    printSummary([r], "Commercial V1 true-PostgreSQL-concurrency acceptance");
    process.exit(0);
    return;
  }
  // Independent-review finding (schema-consistency audit): the owning
  // chain is now built through real, authenticated hosted Supabase Auth
  // identities (see seedOwningChain/module header), not only a direct
  // database connection -- BLOCK with a clear, specific prerequisite
  // rather than attempting a partial/synthetic substitute for either.
  if (!hostedSupabaseConfigured() || !acceptanceIdentitiesConfigured()) {
    const r = blocked(
      "POSTGRES_CONCURRENCY",
      "Hosted Supabase and/or acceptance identities are not configured.",
      [
        "Set NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and ACCEPTANCE_ADMIN_EMAIL/ACCEPTANCE_ADMIN_PASSWORD plus ACCEPTANCE_LEARNER_EMAIL/ACCEPTANCE_LEARNER_PASSWORD -- the owning-chain fixture builds a real course/activation/enrolment through the same governed RPCs the application itself uses, which requires real, already-signed-up hosted identities.",
      ],
    );
    printResult(r);
    printSummary([r], "Commercial V1 true-PostgreSQL-concurrency acceptance");
    process.exit(0);
    return;
  }

  console.log(
    "===== Commercial V1 true PostgreSQL concurrency acceptance =====",
  );
  console.log(`Acceptance run: ${runId}`);
  console.log("");

  let chain;
  const results = [];
  try {
    chain = await seedOwningChain();
    for (const scenario of [
      scenarioInitialVsInitial,
      scenarioRecoveryVsRecovery,
      scenarioNeverTwoRevisionOnes,
      scenarioApplicationRaces,
      scenarioCompletionVsCompletion,
    ]) {
      const outcome = await Promise.resolve(scenario(chain)).catch((error) =>
        error instanceof AcceptanceWriteNotAuthorizedError
          ? blocked(scenario.name, error.message)
          : fail(scenario.name, "Scenario threw unexpectedly.", [
              error instanceof Error ? error.message : String(error),
            ]),
      );
      for (const r of [outcome].flat()) {
        results.push(r);
        printResult(r);
      }
    }
  } catch (error) {
    const r =
      error instanceof AcceptanceWriteNotAuthorizedError
        ? blocked("POSTGRES_CONCURRENCY", error.message, [
            "See scripts/acceptance/db.mjs's acceptanceMarkerProvisioningSql() for how to designate a database as a disposable acceptance environment.",
          ])
        : fail(
            "POSTGRES_CONCURRENCY",
            "Owning-chain fixture setup failed before any scenario could run.",
            [error instanceof Error ? error.message : String(error)],
          );
    results.push(r);
    printResult(r);
  } finally {
    logAcceptanceChain(chain);
  }

  printSummary(results, "Commercial V1 true-PostgreSQL-concurrency acceptance");

  // AC-3 (migration 052) is a SEPARATE scenario with its own fixture,
  // header and summary; it is never evidence for, nor evidenced by, the
  // Commercial V1 scenarios above. See ac3-handoff-race.mjs.
  console.log("");
  console.log(
    "===== AC-3 true PostgreSQL concurrency acceptance (separate from Commercial V1) =====",
  );
  const ac3 = await scenarioAc3ProfessorHandoffDuplicate(`ac3-${runId}`);
  printResult(ac3);
  printSummary([ac3], "AC-3 true-PostgreSQL-concurrency acceptance");
  process.exit(exitCodeFor([...results, ac3]));
}

// Independent-review finding (this pass): main() calls process.exit()
// directly, so importing this module for a behavioural test of
// seedOwningChain/the scenario functions (never source-text-only) must
// never trigger it as a side effect of the import itself -- that would
// kill the test process. Standard Node "run only as the entry script"
// guard: `pathToFileURL` normalizes process.argv[1] cross-platform
// (Windows argv paths use backslashes and no file:// scheme, so a plain
// string comparison against import.meta.url would silently never match).
// `npm run acceptance:concurrency` (node scripts/acceptance/concurrency.mjs)
// still runs main() exactly as before; a test's `await import(...)` of
// this same file does not.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
