// Independent-review finding (v3, this pass): the acceptance-harness.test.ts
// mocked-pg race test proves scenarioInitialVsInitial/scenarioRecoveryVsRecovery
// target genuinely distinct attempt ids/components -- it does NOT prove the
// rows they insert satisfy migration 031/040's CHECK constraints (multiple
// timestamp columns tied together by exact equality and a fixed deadline).
// Duplicating those constraints as JS assertions in a mock would only prove
// the mock's own (possibly wrong) understanding of the schema. This file
// instead runs the ACTUAL exported scenario functions from
// scripts/acceptance/concurrency.mjs against a REAL migrated PGlite database
// (every migration through 202609250042, via tests/db-helper.ts's
// testDatabase(), the same infrastructure every other local PGlite test in
// this repository already trusts) -- the real CHECK constraints, not a
// hand-copied approximation, are what either accepts or rejects each insert.
//
// PGlite is single-connection/embedded, so this cannot prove genuine
// multi-backend concurrency (concurrency.mjs's own header comments already
// say so, and that is exactly why it targets a real hosted PostgreSQL, not
// PGlite, for the actual race). What it DOES prove, which nothing else in
// this repository proves: the literal SQL text scripts/acceptance/
// concurrency.mjs sends is accepted by the real, currently-migrated schema
// and produces a row whose timestamps/state satisfy every table-level CHECK
// -- never NULL where the state requires NULL, never a stray clock skew
// between "equal" columns, never a deadline a hair over 20 seconds.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
  administrator,
} from "./commercial-v1-assessment-policy-fixture";
import { owner, value } from "./commercial-v1-examiner-recovery-fixture";

const VALID_ENV_ID = "a0000000-0000-4000-8000-000000000001";

async function seedSubmittedAttempt(
  db: PGlite,
  args: {
    assessmentId: string;
    enrolmentId: string;
    cohortId: string;
    programmeVersionId: string;
  },
): Promise<string> {
  await owner(db);
  return value<string>(
    db,
    `insert into assessment_attempts(id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,state,started_at,expires_at,submitted_at,submission_provenance)
     values(gen_random_uuid(),$1,$2,$3,$4,$5,1,'SUBMITTED',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '20 minutes',clock_timestamp()-interval '5 minutes','STUDENT_SUBMIT')
     returning id as v`,
    [
      args.assessmentId,
      args.enrolmentId,
      learner,
      args.cohortId,
      args.programmeVersionId,
    ],
  );
}

describe("acceptance concurrency SQL against a REAL migrated schema (independent-review finding 1, v3)", () => {
  let f: Awaited<ReturnType<typeof buildAssessmentPolicyFixture>>;
  let attemptId: string;
  let recoveryAttemptId: string;

  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
    attemptId = await seedSubmittedAttempt(f.db, {
      assessmentId: f.assessmentIds.QUIZ_1,
      enrolmentId: f.learnerEnrolmentId,
      cohortId: f.cohortId,
      programmeVersionId: f.programmeVersionId,
    });
    recoveryAttemptId = await seedSubmittedAttempt(f.db, {
      assessmentId: f.assessmentIds.QUIZ_2,
      enrolmentId: f.learnerEnrolmentId,
      cohortId: f.cohortId,
      programmeVersionId: f.programmeVersionId,
    });
  }, 60000);

  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  function chain() {
    return {
      studentId: learner,
      enrolmentId: f.learnerEnrolmentId,
      activationId: f.activationId,
      cohortId: f.cohortId,
      versionId: f.programmeVersionId,
      assessmentId: f.assessmentIds.QUIZ_1,
      attemptId,
      recoveryAssessmentId: f.assessmentIds.QUIZ_2,
      recoveryAttemptId,
      // The fixture's own administrator identity carries ACADEMIC_ADMIN
      // (see commercial-v1-assessment-policy-fixture.ts's own setup) --
      // a real, verified admin actor, never chain.studentId (the learner).
      recoveryActorId: administrator,
    };
  }

  // Wraps the REAL PGlite database as a fake `pg` Client -- every query a
  // fresh withConnection()/withAcceptanceWriteConnection()/connectMany()
  // "connection" issues (including db.mjs's own acceptance-marker gate
  // probe, synthesized here since that marker table is acceptance-tooling-
  // only and never a Ducelio migration -- see db.mjs's own header comment)
  // is routed to the SAME real, migrated schema. `reset role` on every
  // connect() mirrors the privileged, RLS-bypassing role
  // ACCEPTANCE_DATABASE_URL is provisioned with in a real hosted
  // environment (see docs/38) -- never `authenticated`/`anon`, which these
  // tables revoke all access from entirely (migration 2609160031/2609240040).
  function mockPgAroundRealDb() {
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    function FakeClient() {
      return {
        connect: async () => {
          await owner(f.db);
        },
        end: async () => {},
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          const result = await f.db.query(sql, params);
          return { rows: result.rows };
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
  }

  it("scenarioInitialVsInitial's AUTHORIZED row satisfies migration 031's timestamp/state CHECK constraints on the real migrated schema (started_at NULL; authorized_at=created_at; expires_at=created_at+20s)", async () => {
    mockPgAroundRealDb();
    const { scenarioInitialVsInitial } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioInitialVsInitial(chain());
    // A CHECK-constraint violation on the admitted row would show up as a
    // FAIL here (0 fulfilled) rather than PASS -- assert PASS first so a
    // regression fails loudly with the harness's own diagnostic, not just
    // a raw SQL error three lines down.
    expect(result.status).toBe("PASS");

    await owner(f.db);
    const { rows } = await f.db.query<{
      started_at: string | null;
      authorized_at: string;
      created_at: string;
      expires_at: string;
      state: string;
    }>(
      "select started_at, authorized_at, created_at, expires_at, state from commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.state).toBe("AUTHORIZED");
    expect(row.started_at).toBeNull();
    expect(new Date(row.authorized_at).getTime()).toBe(
      new Date(row.created_at).getTime(),
    );
    expect(new Date(row.expires_at).getTime()).toBe(
      new Date(row.created_at).getTime() + 20_000,
    );
  });

  it("scenarioRecoveryVsRecovery's FAILED source row and AUTHORIZED recovery row satisfy migration 031/040's CHECK constraints on the real migrated schema", async () => {
    mockPgAroundRealDb();
    const { scenarioRecoveryVsRecovery } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioRecoveryVsRecovery(chain());
    expect(result.status).toBe("PASS");

    await owner(f.db);
    const { rows: sourceRows } = await f.db.query<{
      created_at: string;
      authorized_at: string;
      started_at: string;
      terminal_at: string;
      expires_at: string;
      state: string;
    }>(
      "select created_at, authorized_at, started_at, terminal_at, expires_at, state from commercial_v1_examiner_executions where attempt_id=$1",
      [recoveryAttemptId],
    );
    expect(sourceRows.length).toBe(1);
    const source = sourceRows[0];
    expect(source.state).toBe("FAILED");
    expect(new Date(source.authorized_at).getTime()).toBe(
      new Date(source.created_at).getTime(),
    );
    expect(new Date(source.expires_at).getTime()).toBe(
      new Date(source.created_at).getTime() + 20_000,
    );
    expect(new Date(source.started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(source.created_at).getTime(),
    );
    expect(new Date(source.started_at).getTime()).toBeLessThan(
      new Date(source.expires_at).getTime(),
    );
    expect(new Date(source.terminal_at).getTime()).toBeGreaterThanOrEqual(
      new Date(source.started_at).getTime(),
    );

    const { rows: recoveryRows } = await f.db.query<{
      started_at: string | null;
      authorized_at: string;
      created_at: string;
      expires_at: string;
      state: string;
      actor_id: string;
      student_id: string;
    }>(
      "select started_at, authorized_at, created_at, expires_at, state, actor_id, student_id from commercial_v1_examiner_recovery_executions where attempt_id=$1",
      [recoveryAttemptId],
    );
    expect(recoveryRows.length).toBe(1);
    const recovery = recoveryRows[0];
    expect(recovery.state).toBe("AUTHORIZED");
    expect(recovery.started_at).toBeNull();
    expect(new Date(recovery.authorized_at).getTime()).toBe(
      new Date(recovery.created_at).getTime(),
    );
    expect(new Date(recovery.expires_at).getTime()).toBe(
      new Date(recovery.created_at).getTime() + 20_000,
    );

    // Independent-review finding (v5, this pass, BLOCKER): actor_id must
    // be the real, verified admin actor -- never the learner (student_id
    // is a DIFFERENT column, and must remain the learner).
    expect(recovery.actor_id).toBe(administrator);
    expect(recovery.actor_id).not.toBe(learner);
    expect(recovery.student_id).toBe(learner);
    const { rows: roleRows } = await f.db.query<{ role: string }>(
      "select role from role_grants where user_id=$1 and role in ('ACADEMIC_ADMIN','PLATFORM_ADMIN')",
      [recovery.actor_id],
    );
    expect(roleRows.length).toBeGreaterThan(0);
  });
});

describe("acceptance concurrency: NEVER_TWO_REVISION_ONES commits only a complete, valid revision 1 inside each contender's own transaction (V7, Defect A)", () => {
  let f: Awaited<ReturnType<typeof buildAssessmentPolicyFixture>>;
  let attemptId: string;

  beforeAll(async () => {
    // additionalQuizQuestion: true -- QUIZ_1 has TWO real 10-mark
    // questions (real max 20, never the old hard-coded 10).
    f = await buildAssessmentPolicyFixture({
      withLabs: false,
      additionalQuizQuestion: true,
    });
    // commercial_v1_result_policies is required both by migration
    // 2609150030's guard_assessment_result_insert() trigger and by
    // assessment_result_is_valid() -- buildAssessmentPolicyFixture only
    // publishes the grading policy internally.
    await asPolicyUser(f.db, 2); // administrator
    await f.db.query(
      "select publish_commercial_v1_result_policy($1,5000,false,'Test result policy')",
      [f.activationId],
    );
    attemptId = await seedSubmittedAttempt(f.db, {
      assessmentId: f.assessmentIds.QUIZ_1,
      enrolmentId: f.learnerEnrolmentId,
      cohortId: f.cohortId,
      programmeVersionId: f.programmeVersionId,
    });
  }, 60000);

  afterEach(() => {
    vi.doUnmock("pg");
    vi.resetModules();
  });

  function chain() {
    return {
      studentId: learner,
      enrolmentId: f.learnerEnrolmentId,
      activationId: f.activationId,
      assessmentId: f.assessmentIds.QUIZ_1,
      attemptId,
    };
  }

  // PGlite is ONE embedded session, so two fake "connections" cannot hold
  // two independent transactions at once. This fake serializes whole
  // transactions instead: BEGIN is deferred until a contender's first real
  // statement (after the start gate), which then waits for any other
  // contender's transaction to COMMIT/ROLLBACK first -- the same ordering
  // a real server imposes when the second INSERT blocks on the first's
  // uncommitted unique-index entry. Non-transactional reads also wait, so
  // nothing ever runs inside another contender's open transaction.
  //
  // One structural PGlite difference remains: guard_assessment_result_insert()
  // pre-checks for an existing revision BEFORE the unique index is reached.
  // Here the loser starts only after the winner COMMITTED, so that
  // pre-check sees the row and raises INVALID_RESULT_REVISION_SEQUENCE
  // rather than SQLSTATE 23505. The harness's SQLSTATE discipline correctly
  // reports that as FAIL (PASS proof needs a real hosted PostgreSQL run);
  // what these tests prove is what actually gets COMMITTED.
  function mockSerializedPgAroundRealDb(
    options: { forceInvalid?: boolean } = {},
  ) {
    process.env.ACCEPTANCE_DATABASE_URL =
      "postgresql://acceptance:acceptance@localhost:5432/acceptance";
    process.env.ACCEPTANCE_WRITE_ENABLED = "true";
    process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
    let transactionTail: Promise<void> = Promise.resolve();
    const statements: { client: number; sql: string }[] = [];
    let nextClient = 0;
    function FakeClient() {
      const clientNo = nextClient++;
      let beginPending = false;
      let endTransaction: (() => void) | null = null;
      return {
        connect: async () => {
          await transactionTail;
          await owner(f.db);
        },
        end: async () => {},
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("acceptance_marker"))
            return { rows: [{ marker: "x" }] };
          const trimmed = sql.trim().toLowerCase();
          if (trimmed === "begin") {
            beginPending = true;
            return { rows: [] };
          }
          if (beginPending) {
            beginPending = false;
            const previous = transactionTail;
            transactionTail = new Promise<void>((resolve) => {
              endTransaction = resolve;
            });
            await previous;
            await f.db.query("begin");
          } else if (!endTransaction) {
            await transactionTail;
          }
          statements.push({ client: clientNo, sql: trimmed });
          try {
            if (
              options.forceInvalid &&
              trimmed.includes("assessment_result_is_valid($1) as valid")
            )
              return { rows: [{ valid: false }] };
            const result = await f.db.query(sql, params);
            return { rows: result.rows };
          } finally {
            if (
              endTransaction &&
              (trimmed === "commit" || trimmed === "rollback")
            ) {
              (endTransaction as () => void)();
              endTransaction = null;
            }
          }
        },
      };
    }
    vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
    vi.resetModules();
    return statements;
  }

  async function quiz1Revisions() {
    await owner(f.db);
    const { rows } = await f.db.query<{
      id: string;
      revision_number: number;
      earned_marks_total: number;
      max_marks_total: number;
      valid: boolean;
    }>(
      `select r.id, r.revision_number, r.earned_marks_total, r.max_marks_total,
              commercial_v1_private.assessment_result_is_valid(r.id) as valid
       from commercial_v1_assessment_result_revisions r
       where r.enrolment_id=$1 and r.component='QUIZ_1'`,
      [f.learnerEnrolmentId],
    );
    return rows;
  }

  // Runs FIRST (vitest runs a file's tests in declaration order): proves a
  // validity failure inside the contender transaction leaves NOTHING
  // committed on the real schema -- no revision and no question marks.
  it("a validity failure inside the contender transaction rolls back completely -- no committed half-built revision or question marks remain", async () => {
    const statements = mockSerializedPgAroundRealDb({ forceInvalid: true });
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioNeverTwoRevisionOnes(chain());
    expect(result.status).toBe("FAIL");
    expect(result.details?.join("\n")).toContain(
      "failed commercial_v1_private.assessment_result_is_valid() inside its own transaction",
    );
    // Neither contender ever issued COMMIT; both rolled back.
    expect(statements.some((s) => s.sql === "commit")).toBe(false);
    expect(statements.filter((s) => s.sql === "rollback").length).toBe(2);

    expect(await quiz1Revisions()).toEqual([]);
    const { rows: marks } = await f.db.query<{ n: number }>(
      `select count(*)::int as n from commercial_v1_assessment_question_marks m
       join assessment_questions q on q.id=m.question_id
       where q.assessment_id=$1`,
      [f.assessmentIds.QUIZ_1],
    );
    expect(marks[0].n).toBe(0);
  });

  it("each contender writes revision + every question mark + objective outcomes + validity on its OWN client before COMMIT; exactly one complete, valid revision 1 (the winner's) survives", async () => {
    const statements = mockSerializedPgAroundRealDb();
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioNeverTwoRevisionOnes(chain());
    // See mockSerializedPgAroundRealDb: under PGlite the loser is rejected
    // by the trigger pre-check, not 23505, so this is a documented FAIL.
    expect(result.status).toBe("FAIL");
    expect(result.details?.join("\n")).toContain(
      "INVALID_RESULT_REVISION_SEQUENCE",
    );
    expect(result.reason).toContain("got 1 committed");

    // The winner's statements, in order, on ONE client, all before COMMIT.
    const commits = statements.filter((s) => s.sql === "commit");
    expect(commits.length).toBe(1);
    const winnerClient = commits[0].client;
    const winner = statements
      .filter((s) => s.client === winnerClient)
      .map((s) => s.sql);
    const revisionAt = winner.findIndex((s) =>
      s.startsWith("insert into commercial_v1_assessment_result_revisions"),
    );
    const markIndexes = winner
      .map((s, i) =>
        s.startsWith("insert into commercial_v1_assessment_question_marks")
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    const deriveAt = winner.findIndex((s) =>
      s.includes("derive_and_insert_objective_outcomes"),
    );
    const validAt = winner.findIndex((s) =>
      s.includes("assessment_result_is_valid($1) as valid"),
    );
    const commitAt = winner.indexOf("commit");
    expect(revisionAt).toBeGreaterThanOrEqual(0);
    expect(markIndexes.length).toBe(2); // one per REAL question
    expect(Math.min(...markIndexes)).toBeGreaterThan(revisionAt);
    expect(deriveAt).toBeGreaterThan(Math.max(...markIndexes));
    expect(validAt).toBeGreaterThan(deriveAt);
    expect(commitAt).toBeGreaterThan(validAt);
    // The loser attempted its own revision insert on a DIFFERENT client
    // and rolled back.
    const loser = statements
      .filter((s) => s.client !== winnerClient)
      .map((s) => s.sql);
    expect(
      loser.some((s) =>
        s.startsWith("insert into commercial_v1_assessment_result_revisions"),
      ),
    ).toBe(true);
    expect(loser).toContain("rollback");
    expect(loser).not.toContain("commit");

    const revisions = await quiz1Revisions();
    expect(revisions.length).toBe(1);
    const revision = revisions[0];
    expect(revision.revision_number).toBe(1);
    expect(revision.max_marks_total).toBe(20);
    expect(revision.earned_marks_total).toBe(20);
    expect(revision.valid).toBe(true);
    const { rows: markRows } = await f.db.query<{ marks_awarded: number }>(
      "select marks_awarded from commercial_v1_assessment_question_marks where result_revision_id=$1",
      [revision.id],
    );
    expect(markRows.map((m) => m.marks_awarded)).toEqual([10, 10]);
    const { rows: outcomeRows } = await f.db.query<{ n: number }>(
      "select count(*)::int as n from commercial_v1_assessment_objective_outcomes where result_revision_id=$1",
      [revision.id],
    );
    expect(outcomeRows[0].n).toBeGreaterThan(0);
  });
});
