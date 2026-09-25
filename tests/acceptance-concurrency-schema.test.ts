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

describe("acceptance concurrency: NEVER_TWO_REVISION_ONES completes and validates the admitted revision on a non-10 max-marks assessment (independent-review findings B & D, v5)", () => {
  let f: Awaited<ReturnType<typeof buildAssessmentPolicyFixture>>;
  let attemptId: string;

  beforeAll(async () => {
    // additionalQuizQuestion: true -- QUIZ_1 has TWO real 10-mark
    // questions (real max 20, never the old hard-coded 10) so this test
    // cannot pass merely because the fixture's default shape happens to
    // total 10 either way.
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

  it("leaves exactly one revision with the real 20-mark total, exactly two real question-mark rows, and a revision that satisfies assessment_result_is_valid() -- whatever the scenario's own PASS/FAIL outcome", async () => {
    // Independent-review finding (v5, this pass): PGlite is genuinely
    // single-connection (this file's own header comment already says
    // so), and migration 2609150030's guard_assessment_result_insert()
    // trigger adds an application-level pre-check
    // (`exists(... where enrolment_id=... and component=...)`) BEFORE
    // the unique(enrolment_id,component,revision_number) index is ever
    // reached. Under a real two-BACKEND race, neither transaction's
    // pre-check can see the other's still-uncommitted row, so both pass
    // it and the unique index correctly rejects exactly one with SQLSTATE
    // 23505. Under PGlite's single, serialized connection, the first
    // insert's trigger effectively runs to completion before the second
    // one starts, so the SECOND insert's OWN pre-check now sees the
    // first row and rejects with INVALID_RESULT_REVISION_SEQUENCE
    // instead -- a genuine, structural PGlite limitation for THIS
    // specific table (not present for examiner_executions/
    // examiner_recovery_executions above, which have no such pre-check
    // and so already race correctly even under PGlite). Per the v4
    // SQLSTATE-discipline fix, that non-23505 rejection correctly makes
    // this scenario report FAIL here, never a fabricated PASS -- genuine
    // PASS proof for this specific scenario can only come from a real
    // hosted PostgreSQL run (npm run acceptance:concurrency), not yet
    // executed. What THIS test proves, unconditionally regardless of
    // that PASS/FAIL outcome, is exactly finding B's own stated goal:
    // "so even an unsuccessful acceptance run does not strand an invalid
    // append-only result" -- the admitted revision is still completed
    // with real question marks and verified valid.
    mockPgAroundRealDb();
    const { scenarioNeverTwoRevisionOnes } =
      await import("../scripts/acceptance/concurrency.mjs");
    const result = await scenarioNeverTwoRevisionOnes({
      studentId: learner,
      enrolmentId: f.learnerEnrolmentId,
      activationId: f.activationId,
      assessmentId: f.assessmentIds.QUIZ_1,
      attemptId,
    });
    // Whichever status this reaches, it must never be a rejection this
    // harness's own SQLSTATE discipline should have caught as something
    // OTHER than the documented PGlite-vs-trigger interaction above --
    // pin the exact known reason so any DIFFERENT failure (a genuine
    // regression) still fails this test loudly.
    if (result.status === "FAIL") {
      expect(result.details).toContain("INVALID_RESULT_REVISION_SEQUENCE");
    } else {
      expect(result.status).toBe("PASS");
    }

    await owner(f.db);
    const { rows: resultRows } = await f.db.query<{
      id: string;
      earned_marks_total: number;
      max_marks_total: number;
      valid: boolean;
    }>(
      `select r.id, r.earned_marks_total, r.max_marks_total,
              commercial_v1_private.assessment_result_is_valid(r.id) as valid
       from commercial_v1_assessment_result_revisions r
       where r.enrolment_id=$1 and r.component='QUIZ_1' and r.revision_number=1`,
      [f.learnerEnrolmentId],
    );
    expect(resultRows.length).toBe(1);
    const revision = resultRows[0];
    // Real max (two 10-mark questions), never the old hard-coded 10 --
    // and the v5 full-marks race shape (actualMax/actualMax).
    expect(revision.max_marks_total).toBe(20);
    expect(revision.earned_marks_total).toBe(20);
    expect(revision.valid).toBe(true);

    const { rows: markRows } = await f.db.query<{
      question_id: string;
      marks_awarded: number;
      max_marks_snapshot: number;
    }>(
      "select question_id, marks_awarded, max_marks_snapshot from commercial_v1_assessment_question_marks where result_revision_id=$1",
      [revision.id],
    );
    // One question_marks row per real question -- two for QUIZ_1, never
    // left with none (the exact append-only, unrepairable-history bug
    // this scenario previously left behind).
    expect(markRows.length).toBe(2);
    for (const m of markRows) {
      expect(m.marks_awarded).toBe(10);
      expect(m.max_marks_snapshot).toBe(10);
    }
  });
});
