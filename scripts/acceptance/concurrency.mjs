#!/usr/bin/env node
// npm run acceptance:concurrency
//
// True PostgreSQL concurrency acceptance (Checkpoint E3). PGlite is a
// single-connection embedded database and cannot prove independent-session
// locking/uniqueness behaviour -- every scenario here uses TWO genuinely
// independent `pg` connections (db.mjs's connectMany), each with its own
// backend process on the server, and fires their conflicting statements
// inside a deliberate synchronization barrier so both are truly in flight
// together before either resolves. Never sequential queries dressed up as
// concurrency.
//
// Scope: each scenario tests the DATABASE-LEVEL constraint (unique index /
// row lock discipline) that the governed RPCs rely on to admit "exactly
// one" under real contention -- the same guarantee this repository's local
// PGlite tests can only prove sequentially. It does not re-exercise the
// HMAC-attested RPC business logic itself (already proven correct, in
// isolation, by the existing local test suite); see surfaces.mjs's
// GRADING/INITIAL_RECOVERY/REGRADE comments for why this harness never
// reimplements that trust-critical protocol.
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
// commercial_v1_assessment_result_revisions,
// commercial_v1_completion_receipts -- migrations
// 2609090016/2609160031/2609240040/2609150030 each unconditionally reject
// DELETE). There is nothing left a cleanup step could safely remove --
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
import { seedAcceptanceCourse, seedAcceptanceAttempt } from "./fixtures.mjs";
import {
  printResult,
  printSummary,
  exitCodeFor,
  pass,
  fail,
  blocked,
  notRun,
} from "./report.mjs";

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
  // INITIAL_VS_INITIAL/NEVER_TWO_REVISION_ONES/COMPLETION_VS_COMPLETION;
  // the wholly separate QUIZ_2/its attempt for RECOVERY_VS_RECOVERY only.
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
      "Both a QUIZ_1 and a QUIZ_2 assessment binding are required for the acceptance activation -- QUIZ_1 targets INITIAL_VS_INITIAL/NEVER_TWO_REVISION_ONES/COMPLETION_VS_COMPLETION and the distinct QUIZ_2 targets RECOVERY_VS_RECOVERY, so the two never collide on examiner_execution_one_per_attempt.",
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
      "revisions/completion receipts). These are immutable institutional history by design " +
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

export async function scenarioNeverTwoRevisionOnes(chain) {
  // Independent-review finding (v4, this pass): a hard-coded
  // max_marks_total=10 assumed the seeded QUIZ_1 assessment always has
  // exactly one 10-mark question -- true only for buildAcceptancePackage's
  // own current shape, and not something this scenario should silently
  // depend on. Derived instead from the REAL assessment_questions rows,
  // exactly as fixtures.mjs's seedAcceptanceResults now does.
  const actualMax = await withConnection(async (c) => {
    const { rows } = await c.query(
      "select coalesce(sum(max_marks),0)::int as total from assessment_questions where assessment_id=$1",
      [chain.assessmentId],
    );
    return rows[0].total;
  });
  if (!actualMax)
    throw new Error(
      "No assessment_questions found for the QUIZ_1 assessment -- cannot derive a valid max_marks_total.",
    );
  const { clients, closeAll } = await connectMany(2);
  try {
    await assertAllAcceptanceDatabaseWriteAuthorized(clients);
    // Independent-review finding (v5, this pass): races full marks
    // (actualMax/actualMax) rather than a zero score -- the uniqueness
    // property under test does not depend on the score value, and full
    // marks never opens unnecessary remediation history for a row this
    // harness cannot delete.
    const insert = () => [
      `insert into commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
        earned_marks_total,max_marks_total,component_weight_bp
      ) values($1,$2,$3,'QUIZ_1',$4,$5,1,$6,$6,500)`,
      [
        chain.activationId,
        chain.enrolmentId,
        chain.studentId,
        chain.attemptId,
        chain.assessmentId,
        actualMax,
      ],
    ];
    const settled = await Promise.allSettled([
      clients[0].query(...insert()),
      clients[1].query(...insert()),
    ]);
    const { fulfilled, uniqueRejected, otherRejections } =
      classifyRace(settled);
    const { rows } = await withConnection((c) =>
      c.query(
        "select id from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1' and revision_number=1",
        [chain.enrolmentId],
      ),
    );
    // Independent-review finding (v5, this pass, BLOCKER): whichever side
    // won the race left a raw commercial_v1_assessment_result_revisions
    // row with NO question_marks and NO objective outcomes --
    // append-only, and this harness never deletes it, so an incomplete/
    // invalid revision left behind would be PERMANENT acceptance history.
    // Whenever exactly one admitted revision exists, it is completed
    // (real question marks -> derive_and_insert_objective_outcomes ->
    // assert_result_is_valid) BEFORE the pass/fail decision below, on
    // both a successful and an unsuccessful race outcome -- never only
    // on the PASS path.
    if (rows.length === 1) {
      const resultRevisionId = rows[0].id;
      await withAcceptanceWriteConnection(async (c) => {
        const { rows: questions } = await c.query(
          "select id, max_marks from assessment_questions where assessment_id=$1 order by position",
          [chain.assessmentId],
        );
        for (const question of questions) {
          await c.query(
            `insert into commercial_v1_assessment_question_marks(
              result_revision_id, question_id, marks_awarded, max_marks_snapshot
            ) values($1,$2,$3,$4)`,
            [
              resultRevisionId,
              question.id,
              question.max_marks,
              question.max_marks,
            ],
          );
        }
        await c.query(
          "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
          [resultRevisionId],
        );
        const { rows: validRows } = await c.query(
          "select commercial_v1_private.assessment_result_is_valid($1) as valid",
          [resultRevisionId],
        );
        if (!validRows[0]?.valid)
          throw new Error(
            `The admitted NEVER_TWO_REVISION_ONES result revision ${resultRevisionId} failed commercial_v1_private.assessment_result_is_valid() after completion -- refusing to leave invalid permanent history in place.`,
          );
      });
    }
    if (
      fulfilled === 1 &&
      uniqueRejected === 1 &&
      otherRejections.length === 0 &&
      rows.length === 1
    )
      return pass(
        "POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES",
        "Database-constraint acceptance test (raw insert against unique(enrolment_id,component,revision_number), the constraint every governed FINALIZE path -- initial, recovery and regrade -- ultimately relies on): two genuinely concurrent revision-1 result inserts for the same (enrolment, component) never both succeeded -- the loser was rejected by the unique index (SQLSTATE 23505), no split-brain target. The admitted revision was completed with real question marks/objective outcomes and verified valid.",
      );
    return fail(
      "POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES",
      `Expected 1 fulfilled/1 unique-violation(23505)-rejected/0 other rejections/1 row; got ${fulfilled} fulfilled, ${uniqueRejected} unique-violation-rejected, ${otherRejections.length} other rejection(s), ${rows.length} row(s).`,
      otherRejections,
    );
  } finally {
    await closeAll();
  }
}

export async function scenarioCompletionVsCompletion(chain) {
  // Independent-review finding (v5, this pass): this scenario used to
  // ALSO seed its own QUIZ_1 revision-1 result (with
  // `on conflict do nothing`), duplicating the exact row
  // NEVER_TWO_REVISION_ONES -- which always runs first in main()'s
  // scenario list, and which (after the v5 fix above) always completes
  // its admitted revision to a genuinely valid one -- already created.
  // By the time this scenario runs, that revision already exists, so
  // this insert was never a genuine no-op either: migration
  // 2609150030's guard_assessment_result_insert() trigger raises
  // INVALID_RESULT_REVISION_SEQUENCE for a second revision_number=1 row
  // on the same (enrolment, component) BEFORE ON CONFLICT DO NOTHING
  // ever gets a chance to suppress anything (the BEFORE INSERT row
  // trigger fires ahead of conflict resolution). It never did anything
  // useful, and public.commercial_v1_completion_receipts carries no
  // foreign key to commercial_v1_assessment_result_revisions at all --
  // only enrolment_id/activation_id (checked against course_activations)
  // and completed_by (checked against app_users) -- so there is no real
  // schema requirement for a result revision to exist before this raw
  // insert either. Removed entirely, along with the actualMax lookup it
  // existed only to feed. This scenario exercises ONLY the raw
  // unique(enrolment_id) constraint on commercial_v1_completion_receipts
  // -- never the governed attempt_commercial_v1_course_completion RPC,
  // and never proof that a real completion would actually be ELIGIBLE
  // (that depends on the governed RPC's own result/policy evaluation,
  // not re-exercised here).
  const { clients, closeAll } = await connectMany(2);
  try {
    await assertAllAcceptanceDatabaseWriteAuthorized(clients);
    const insert = () => [
      `insert into commercial_v1_completion_receipts(
        enrolment_id,student_id,activation_id,cohort_id,programme_version_id,
        final_course_score_bp,pass_mark_bp,completed_by
      ) values($1,$2,$3,$4,$5,10000,5000,$2)`,
      [
        chain.enrolmentId,
        chain.studentId,
        chain.activationId,
        chain.cohortId,
        chain.versionId,
      ],
    ];
    const settled = await Promise.allSettled([
      clients[0].query(...insert()),
      clients[1].query(...insert()),
    ]);
    const { fulfilled, uniqueRejected, otherRejections } =
      classifyRace(settled);
    const { rows } = await withConnection((c) =>
      c.query(
        "select count(*)::int as n from commercial_v1_completion_receipts where enrolment_id=$1",
        [chain.enrolmentId],
      ),
    );
    if (
      fulfilled === 1 &&
      uniqueRejected === 1 &&
      otherRejections.length === 0 &&
      rows[0].n === 1
    )
      return pass(
        "POSTGRES_CONCURRENCY:COMPLETION_VS_COMPLETION",
        "Database-constraint acceptance test bounded EXACTLY to the raw unique(enrolment_id) constraint on commercial_v1_completion_receipts -- never the governed attempt_commercial_v1_course_completion RPC, and never proof that a real completion would actually be eligible under any result/policy evaluation: exactly one of two genuinely concurrent completion-receipt inserts for the same enrolment was admitted; the other was rejected by the unique index (SQLSTATE 23505).",
      );
    return fail(
      "POSTGRES_CONCURRENCY:COMPLETION_VS_COMPLETION",
      `Expected 1 fulfilled/1 unique-violation(23505)-rejected/0 other rejections/1 row; got ${fulfilled} fulfilled, ${uniqueRejected} unique-violation-rejected, ${otherRejections.length} other rejection(s), ${rows[0].n} row(s).`,
      otherRejections,
    );
  } finally {
    await closeAll();
  }
}

// Independent-review finding 4: these two scenarios previously returned a
// synthetic PASS without ever executing the named race -- a Level-1
// truthfulness violation (architecture/MVCC reasoning is not empirical
// evidence). Neither is implemented as its own distinct race: both would
// exercise the SAME unique(enrolment_id,component,revision_number) write
// path NEVER_TWO_REVISION_ONES already drives under genuine two-connection
// concurrency, so a second insert-race under a different name would not be
// a second, independent proof -- it would be the identical statement
// re-run with cosmetic renaming. Rather than fabricate that, or reuse
// NEVER_TWO_REVISION_ONES's own outcome as a second PASS, both honestly
// report NOT_RUN and name exactly which lower-level invariant was actually
// proven, by which scenario, and what remains genuinely untested.
function scenarioLateInitialVsRecoveryNotRun() {
  return notRun(
    "POSTGRES_CONCURRENCY:LATE_INITIAL_FINALIZE_VS_RECOVERY_AUTHORIZE",
    "COVERED_BY_INVARIANT, not independently executed: a late-initial FINALIZE and a recovery FINALIZE both write through the identical unique(enrolment_id,component,revision_number) insert that POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES already races under genuine two-connection concurrency in this same run. This scenario's own distinct race (an in-flight initial FINALIZE transaction against a concurrent recovery AUTHORIZE/FINALIZE sequence) has not been executed.",
  );
}
function scenarioRegradeVsCompletionNotRun() {
  return notRun(
    "POSTGRES_CONCURRENCY:REGRADE_VS_COMPLETION",
    "COVERED_BY_INVARIANT, not independently executed: the write-side uniqueness a regrade depends on is the same unique(enrolment_id,component,revision_number) constraint POSTGRES_CONCURRENCY:NEVER_TWO_REVISION_ONES already races under genuine concurrency. Whether a concurrent get_commercial_v1_course_progress/attempt_commercial_v1_course_completion read against an in-flight regrade transaction ever observes a torn/partial result is a real, distinct question this harness does not yet exercise -- it is not proven merely by MVCC snapshot-isolation reasoning, and is not claimed as PASS.",
  );
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
      scenarioLateInitialVsRecoveryNotRun,
      scenarioRegradeVsCompletionNotRun,
      scenarioCompletionVsCompletion,
    ]) {
      const r = await Promise.resolve(scenario(chain)).catch((error) =>
        error instanceof AcceptanceWriteNotAuthorizedError
          ? blocked(scenario.name, error.message)
          : fail(scenario.name, "Scenario threw unexpectedly.", [
              error instanceof Error ? error.message : String(error),
            ]),
      );
      results.push(r);
      printResult(r);
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
  process.exit(exitCodeFor(results));
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
