import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";
import { seedOriginalExecution } from "./commercial-v1-examiner-recovery-fixture";

// Migration 202610020047 policy regressions:
//  * question-set size: the human-review writer validates every question of
//    the authoritative assessment exactly once, at the largest assessment the
//    repository can bind to a component (100 questions -- see the bound
//    proof below; a 101-question review case is not representable);
//  * explicit academic-record policy: already-submitted, escalated work
//    still receives its legitimate first grade after the enrolment is later
//    WITHDRAWN, without reactivating the enrolment or enabling completion.

let db: PGlite;
let f: AssessmentPolicyFixture;
const ids: Record<string, string> = {};

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner() {
  await db.exec("reset role");
}
async function refused(sql: string, args: unknown[], code: string | RegExp) {
  await expect(db.query(sql, args)).rejects.toThrow(code);
}
async function questionIds(assessmentId: string) {
  await owner();
  return (
    await db.query<{ id: string }>(
      "select id from assessment_questions where assessment_id=$1 order by position",
      [assessmentId],
    )
  ).rows.map((r) => r.id);
}
const GET = "select public.get_commercial_v1_academic_review_case($1) as v";
const GRADE =
  "select public.submit_commercial_v1_academic_review_assessment_grade($1,$2::jsonb,$3) as v";
const marks = (entries: [string, number][]) =>
  JSON.stringify(
    entries.map(([questionId, marksAwarded]) => ({ questionId, marksAwarded })),
  );

beforeAll(async () => {
  f = await buildAssessmentPolicyFixture({
    withLabs: false,
    quiz1QuestionCount: 100,
  });
  db = f.db;
  await asPolicyUser(db, 2);
  await db.query(
    "select publish_commercial_v1_result_policy($1,1,false,'Test result policy')",
    [f.activationId],
  );
  const [q1, q2] = await questionIds(f.assessmentIds.QUIZ_1);
  await asPolicyUser(db, 1);
  ids.attempt = await value<string>(
    "select public.start_assessment_attempt($1) as v",
    [f.assessmentIds.QUIZ_1],
  );
  for (const q of [q1, q2])
    await db.query(
      "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
      [ids.attempt, q, "Learner response", randomUUID()],
    );
  await db.query("select submit_assessment_attempt($1)", [ids.attempt]);
  ids.largeCase = await seedOriginalExecution(f, {
    component: "QUIZ_1",
    state: "ESCALATED",
    attemptId: ids.attempt,
  });
  ids.withdrawnCase = await seedOriginalExecution(f, {
    component: "QUIZ_2",
    state: "ESCALATED",
  });
});
afterAll(async () => {
  await db?.close();
});

describe("question-set size (migration 047)", () => {
  it("the repository binds at most 100 questions to a component assessment", async () => {
    await owner();
    const imp = (
      await db.query<{
        package_key: string;
        package_revision: number;
        schema_version: string;
        raw_package: { assessmentTemplates: Array<{ questions: unknown[] }> };
      }>(
        "select package_key,package_revision,schema_version,raw_package from course_package_imports where id=$1",
        [f.importId],
      )
    ).rows[0];
    const pkg = structuredClone(imp.raw_package);
    const template = pkg.assessmentTemplates[0];
    template.questions = Array.from({ length: 101 }, (_, i) => ({
      ...(template.questions[0] as object),
      position: i + 1,
    }));
    // The database package validator (enforced again inside activation).
    await refused(
      "select course_engineering_private.assert_full_package_valid($1,$2,$3,$4::jsonb)",
      [
        imp.package_key,
        imp.package_revision,
        imp.schema_version,
        JSON.stringify(pkg),
      ],
      "between one and 100 questions",
    );
    // Activation publishes each assessment; published questions are frozen
    // for every writer, so no 101st question can be added afterwards.
    await refused(
      "insert into assessment_questions(assessment_id,position,prompt,max_marks,created_by) select assessment_id,101,'Extra',10,created_by from assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
      "Published assessment questions are immutable",
    );
  });

  it("returns every question of the largest assessment and validates each exactly once", async () => {
    const qs = await questionIds(f.assessmentIds.QUIZ_1);
    const [foreign] = await questionIds(f.assessmentIds.QUIZ_2);
    expect(qs).toHaveLength(100);
    const full: [string, number][] = qs.map((id, i) => [
      id,
      i === 0 ? 7 : i === 1 ? 4 : 0,
    ]);
    await asPolicyUser(db, 2);
    const ctx = await value<{
      assessment: { maxMarksTotal: number; questions: unknown[] };
    }>(GET, [ids.largeCase]);
    expect(ctx.assessment.questions).toHaveLength(100);
    expect(ctx.assessment.maxMarksTotal).toBe(1000);
    const reason = "Large escalated assessment reviewed";
    await refused(
      GRADE,
      [ids.largeCase, marks(full.slice(0, 99)), reason],
      "INCOMPLETE_QUESTION_MARKS",
    );
    await refused(
      GRADE,
      [ids.largeCase, marks([...full.slice(0, 99), [qs[0], 7]]), reason],
      "DUPLICATE_QUESTION",
    );
    await refused(
      GRADE,
      [ids.largeCase, marks([...full, [foreign, 0]]), reason],
      "FOREIGN_QUESTION",
    );
    await refused(
      GRADE,
      [ids.largeCase, marks([[qs[0], -1], ...full.slice(1)]), reason],
      "MARKS_BELOW_ZERO",
    );
    await refused(
      GRADE,
      [ids.largeCase, marks([[qs[0], 11], ...full.slice(1)]), reason],
      "MARKS_EXCEED_MAX",
    );
    // Over max on the LAST question: every entry is checked, not a prefix.
    await refused(
      GRADE,
      [ids.largeCase, marks([...full.slice(0, 99), [qs[99], 11]]), reason],
      "MARKS_EXCEED_MAX",
    );
    const result = await value<Record<string, unknown>>(GRADE, [
      ids.largeCase,
      marks(full),
      reason,
    ]);
    expect(result).toMatchObject({
      code: "RESULT_CREATED",
      revisionNumber: 1,
      earnedMarks: 11,
      maxMarks: 1000,
    });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_assessment_question_marks where result_revision_id=$1",
        [result.resultRevisionId],
      ),
    ).toBe(100);
    expect(
      await value(
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [result.resultRevisionId],
      ),
    ).toBe(true);
  });
});

describe("explicit post-withdrawal first-grade policy (migration 047)", () => {
  it("grades already-submitted escalated work after WITHDRAWN without reactivation or completion", async () => {
    await asPolicyUser(db, 2);
    await db.query(
      "select public.change_enrolment_status($1,'WITHDRAWN','Learner withdrew after submitting')",
      [f.learnerEnrolmentId],
    );
    await owner();
    expect(
      await value("select status as v from enrolments where id=$1", [
        f.learnerEnrolmentId,
      ]),
    ).toBe("WITHDRAWN");
    const enrolmentAuditBefore = await value<number>(
      "select count(*)::int as v from audit_events where target_type='enrolments' and target_id=$1",
      [f.learnerEnrolmentId],
    );
    // The case stays open for its legitimate first grade.
    await asPolicyUser(db, 2);
    const list = await value<{ cases: Array<{ caseId: string }> }>(
      "select public.list_commercial_v1_academic_review_cases() as v",
    );
    expect(list.cases.map((c) => c.caseId)).toContain(ids.withdrawnCase);
    const [q] = await questionIds(f.assessmentIds.QUIZ_2);
    await asPolicyUser(db, 2);
    const result = await value<Record<string, unknown>>(GRADE, [
      ids.withdrawnCase,
      marks([[q, 0]]),
      "Submitted work graded after withdrawal",
    ]);
    expect(result).toMatchObject({ code: "RESULT_CREATED", revisionNumber: 1 });
    await owner();
    expect(
      await value(
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [result.resultRevisionId],
      ),
    ).toBe(true);
    // The review never touches the enrolment: still WITHDRAWN, no new write.
    expect(
      await value("select status as v from enrolments where id=$1", [
        f.learnerEnrolmentId,
      ]),
    ).toBe("WITHDRAWN");
    expect(
      await value<number>(
        "select count(*)::int as v from audit_events where target_type='enrolments' and target_id=$1",
        [f.learnerEnrolmentId],
      ),
    ).toBe(enrolmentAuditBefore);
    // Completion stays unavailable under the existing non-ACTIVE rule.
    await asPolicyUser(db, 1);
    expect(
      await value(
        "select public.attempt_commercial_v1_course_completion($1,'Requesting completion') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({ ok: false, code: "ENROLMENT_NOT_ACTIVE" });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_completion_receipts where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    ).toBe(0);
  });
});
