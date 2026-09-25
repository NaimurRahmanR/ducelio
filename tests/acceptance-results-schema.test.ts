// Independent-review finding (v3, this pass): seedAcceptanceResults
// (scripts/acceptance/fixtures.mjs) correctly creates a real, non-null
// assessment_attempts row and a result revision, then calls
// commercial_v1_private.derive_and_insert_objective_outcomes(result_id) --
// but that function calls assert_complete_question_marks() FIRST, which
// requires one public.commercial_v1_assessment_question_marks row per real
// public.assessment_questions row bound to the assessment. A prior version
// never inserted any question_marks row at all and hard-coded
// max_marks_total=10 -- every call would throw INCOMPLETE_QUESTION_MARKS.
//
// Independent-review finding (v4, this pass): the v3 coverage only ever
// exercised the fixture's own default one-question-worth-10 shape (so
// max_marks_total=10 could pass even if the derivation logic secretly
// still used a hard-coded literal), and never exercised allCorrect=false
// or a partial-failure rollback against a real database. This file now
// also builds a fixture where QUIZ_1 has TWO real questions (max_marks
// 10 each, total 20 -- never 10), asserts allCorrect=false on a
// completely separate fixture/database, and proves the whole operation
// rolls back to zero committed rows when a failure is injected AFTER at
// least one result/question-mark row has already been written.
//
// As with acceptance-concurrency-schema.test.ts, this runs the ACTUAL
// exported seedAcceptanceResults against a REAL migrated PGlite database
// (every migration through 202609250042) rather than duplicating migration
// 030's validity logic as JS assertions in a mock -- the real
// assessment_result_is_valid()/lab_result_is_valid() functions are what
// either accept or reject the seeded revisions.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
} from "./commercial-v1-assessment-policy-fixture";
import { owner, value } from "./commercial-v1-examiner-recovery-fixture";

const VALID_ENV_ID = "a0000000-0000-4000-8000-000000000001";

async function setupResultFixture(opts: { additionalQuizQuestion: boolean }) {
  const f = await buildAssessmentPolicyFixture({
    withLabs: true,
    additionalQuizQuestion: opts.additionalQuizQuestion,
  });
  await owner(f.db);
  const practicalId = await value<string>(
    f.db,
    "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
    [f.importId],
  );
  // buildAssessmentPolicyFixture only publishes the grading policy
  // internally -- the lab policy and result policy (both required by
  // assessment_result_is_valid/lab_result_is_valid) are published here,
  // the same way tests/commercial-v1-examiner-recovery-fixture.ts's own
  // recoveryFixture() does, and the same way seedAcceptanceCourse itself
  // does via set_commercial_v1_lab_policy/publish_commercial_v1_result_policy.
  await asPolicyUser(f.db, 2); // administrator
  await f.db.query(
    "select set_commercial_v1_lab_policy($1,$2,10,2000,'Acceptance lab policy','Test lab policy')",
    [f.activationId, practicalId],
  );
  await f.db.query(
    "select publish_commercial_v1_result_policy($1,5000,false,'Test result policy')",
    [f.activationId],
  );
  return { f, practicalId };
}

function courseFor(
  f: Awaited<ReturnType<typeof buildAssessmentPolicyFixture>>,
  practicalId: string,
) {
  return {
    importId: f.importId,
    programmeVersionId: f.programmeVersionId,
    activationId: f.activationId,
    cohortId: f.cohortId,
    enrolmentId: f.learnerEnrolmentId,
    practicalId,
    studentId: learner,
  };
}

function mockPgAroundRealDb(
  f: Awaited<ReturnType<typeof buildAssessmentPolicyFixture>>,
  onQuery?: (sql: string, callIndex: number) => void,
) {
  process.env.ACCEPTANCE_DATABASE_URL =
    "postgresql://acceptance:acceptance@localhost:5432/acceptance";
  process.env.ACCEPTANCE_WRITE_ENABLED = "true";
  process.env.ACCEPTANCE_ENVIRONMENT_ID = VALID_ENV_ID;
  let callIndex = 0;
  function FakeClient() {
    return {
      connect: async () => {
        await owner(f.db);
      },
      end: async () => {},
      query: async (sql: string, params: unknown[] = []) => {
        callIndex += 1;
        if (sql.includes("acceptance_marker"))
          return { rows: [{ marker: "x" }] };
        onQuery?.(sql, callIndex);
        const result = await f.db.query(sql, params);
        return { rows: result.rows };
      },
    };
  }
  vi.doMock("pg", () => ({ default: { Client: FakeClient } }));
  vi.resetModules();
}

afterEach(() => {
  vi.doUnmock("pg");
  vi.resetModules();
});

describe("acceptance result seeding satisfies migration 030's real validity functions on a non-10 max-marks assessment (independent-review findings 2 & 4)", () => {
  it("seedAcceptanceResults(allCorrect=true) derives QUIZ_1's real 20-mark total (two real questions, never a hard-coded 10), populates one question_marks row per question, and produces result/lab revisions that satisfy assessment_result_is_valid/lab_result_is_valid", async () => {
    const { f, practicalId } = await setupResultFixture({
      additionalQuizQuestion: true,
    });
    mockPgAroundRealDb(f);
    const { seedAcceptanceResults } =
      await import("../scripts/acceptance/fixtures.mjs");
    // Would previously throw INCOMPLETE_QUESTION_MARKS before this even
    // resolves -- reaching the assertions below is itself part of the proof.
    await seedAcceptanceResults(courseFor(f, practicalId), true);

    await owner(f.db);
    const { rows: quiz1Questions } = await f.db.query<{ n: number }>(
      "select count(*)::int as n from assessment_questions where assessment_id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    expect(quiz1Questions[0].n).toBe(2); // additionalQuizQuestion: true

    const { rows: resultRows } = await f.db.query<{
      id: string;
      component: string;
      valid: boolean;
      earned_marks_total: number;
      max_marks_total: number;
    }>(
      `select r.id, r.component, r.earned_marks_total, r.max_marks_total,
              commercial_v1_private.assessment_result_is_valid(r.id) as valid
       from commercial_v1_assessment_result_revisions r where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    expect(resultRows.length).toBe(6);
    const quiz1Result = resultRows.find((r) => r.component === "QUIZ_1")!;
    // The whole point: QUIZ_1's real total is 20 (two 10-mark questions),
    // never the old hard-coded 10 -- and every component's max_marks_total
    // equals the real sum of its own assessment_questions.
    expect(quiz1Result.max_marks_total).toBe(20);
    for (const row of resultRows) {
      expect(row.valid).toBe(true);
      // allCorrect=true: earned must equal the real max, never a
      // hard-coded constant unrelated to the actual question(s).
      expect(row.earned_marks_total).toBe(row.max_marks_total);
    }

    const { rows: markRows } = await f.db.query<{
      question_id: string;
      marks_awarded: number;
      max_marks_snapshot: number;
    }>(
      `select m.question_id, m.marks_awarded, m.max_marks_snapshot
       from public.commercial_v1_assessment_question_marks m
       join public.commercial_v1_assessment_result_revisions r on r.id=m.result_revision_id
       where r.id=$1`,
      [quiz1Result.id],
    );
    // One question_marks row per real question -- two for QUIZ_1, not one.
    expect(markRows.length).toBe(2);
    for (const m of markRows) {
      expect(m.marks_awarded).toBe(10);
      expect(m.max_marks_snapshot).toBe(10);
    }

    const { rows: labRows } = await f.db.query<{
      id: string;
      valid: boolean;
    }>(
      `select r.id, commercial_v1_private.lab_result_is_valid(r.id) as valid
       from commercial_v1_lab_result_revisions r where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    expect(labRows.length).toBe(1);
    expect(labRows[0].valid).toBe(true);
  });

  it("seedAcceptanceResults(allCorrect=false), on a completely fresh fixture/database, still inserts one question_marks row per question (marks_awarded=0), earned_marks_total=0, and every revision remains valid", async () => {
    const { f, practicalId } = await setupResultFixture({
      additionalQuizQuestion: true,
    });
    mockPgAroundRealDb(f);
    const { seedAcceptanceResults } =
      await import("../scripts/acceptance/fixtures.mjs");
    await seedAcceptanceResults(courseFor(f, practicalId), false);

    await owner(f.db);
    const { rows: resultRows } = await f.db.query<{
      id: string;
      component: string;
      valid: boolean;
      earned_marks_total: number;
      max_marks_total: number;
    }>(
      `select r.id, r.component, r.earned_marks_total, r.max_marks_total,
              commercial_v1_private.assessment_result_is_valid(r.id) as valid
       from commercial_v1_assessment_result_revisions r where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    expect(resultRows.length).toBe(6);
    const quiz1Result = resultRows.find((r) => r.component === "QUIZ_1")!;
    expect(quiz1Result.max_marks_total).toBe(20);
    for (const row of resultRows) {
      expect(row.valid).toBe(true);
      expect(row.earned_marks_total).toBe(0);
      expect(row.max_marks_total).toBeGreaterThan(0);
    }

    // Zero-score questions still get exactly one mark row each -- never
    // silently skipped because the score is zero.
    const { rows: markRows } = await f.db.query<{
      n: number;
      awarded_sum: number;
    }>(
      `select count(*)::int as n, coalesce(sum(m.marks_awarded),0)::int as awarded_sum
       from public.commercial_v1_assessment_question_marks m
       join public.commercial_v1_assessment_result_revisions r on r.id=m.result_revision_id
       where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    // 2 questions for QUIZ_1 + 1 each for the other 5 components = 7.
    expect(markRows[0].n).toBe(7);
    expect(markRows[0].awarded_sum).toBe(0);

    const { rows: labRows } = await f.db.query<{
      id: string;
      valid: boolean;
      earned_marks: number;
    }>(
      `select r.id, r.earned_marks, commercial_v1_private.lab_result_is_valid(r.id) as valid
       from commercial_v1_lab_result_revisions r where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    expect(labRows.length).toBe(1);
    expect(labRows[0].earned_marks).toBe(0);
    expect(labRows[0].valid).toBe(true);
  });
});

describe("acceptance result seeding rollback leaves zero committed rows, even after a partial write (independent-review finding 5, v4)", () => {
  it("a failure injected AFTER the first component's result revision and question marks are written rolls back to zero rows -- no partial acceptance history is left behind", async () => {
    const { f, practicalId } = await setupResultFixture({
      additionalQuizQuestion: false,
    });
    // Fail the SECOND component's assessment_result_revisions insert --
    // by then, the first component's result revision AND its question
    // marks row have already been sent to the real database on this same
    // (uncommitted) transaction. If the transaction wrapper did not
    // actually roll back, that first component's rows would remain.
    let resultInsertCount = 0;
    mockPgAroundRealDb(f, (sql) => {
      if (
        sql.includes("insert into commercial_v1_assessment_result_revisions")
      ) {
        resultInsertCount += 1;
        if (resultInsertCount === 2) {
          throw new Error(
            "simulated failure after the first component's result/question-marks rows were already written",
          );
        }
      }
    });
    const { seedAcceptanceResults } =
      await import("../scripts/acceptance/fixtures.mjs");
    await expect(
      seedAcceptanceResults(courseFor(f, practicalId), true),
    ).rejects.toThrow(/simulated failure/);

    await owner(f.db);
    const { rows: resultRows } = await f.db.query<{ n: number }>(
      "select count(*)::int as n from commercial_v1_assessment_result_revisions where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    // No result revision for this enrolment survived, so no question_marks
    // row could legitimately reference one (the FK itself would forbid an
    // orphan) -- checked directly and independently anyway, never inferred.
    const { rows: markRows } = await f.db.query<{ n: number }>(
      `select count(*)::int as n from public.commercial_v1_assessment_question_marks m
       join public.commercial_v1_assessment_result_revisions r on r.id=m.result_revision_id
       where r.enrolment_id=$1`,
      [f.learnerEnrolmentId],
    );
    const { rows: attemptRows } = await f.db.query<{ n: number }>(
      "select count(*)::int as n from assessment_attempts where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    // The first component's result revision, its question marks, AND its
    // seeded assessment_attempts row must ALL be gone -- the whole
    // operation is one transaction, not a per-component one.
    expect(resultRows[0].n).toBe(0);
    expect(markRows[0].n).toBe(0);
    expect(attemptRows[0].n).toBe(0);
  });
});
