import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
  administrator,
  foreignLearner,
  type AssessmentPolicyFixture,
  type Component,
} from "./commercial-v1-assessment-policy-fixture";
import {
  seedOriginalExecution,
  seedActiveOriginalExecution,
} from "./commercial-v1-examiner-recovery-fixture";

// Migration 202610020047: human academic review + governed manual first grade.
// Terminal Examiner/recovery claims are seeded with database-owner fixture
// authority (the accepted pattern of commercial-v1-examiner-recovery-fixture),
// since no production RPC creates a claim directly in a terminal state. Every
// review action itself runs through the real SECURITY DEFINER RPCs as a
// genuine authenticated session. PGlite is a single connection: these are
// deterministic sequential tests, not multi-connection concurrency evidence.

let db: PGlite;
let f: AssessmentPolicyFixture;
const ids: Record<string, string> = {};

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner() {
  await db.exec("reset role");
}
async function asReviewer() {
  await asPolicyUser(db, 2);
}
async function refused(sql: string, args: unknown[], code: string | RegExp) {
  await expect(db.query(sql, args)).rejects.toThrow(code);
}
const LIST = "select public.list_commercial_v1_academic_review_cases() as v";
const GET = "select public.get_commercial_v1_academic_review_case($1) as v";
const GRADE =
  "select public.submit_commercial_v1_academic_review_assessment_grade($1,$2::jsonb,$3) as v";
const LAB =
  "select public.submit_commercial_v1_academic_review_lab_grade($1,$2,$3) as v";

type CaseSummary = {
  caseId: string;
  caseKind: string;
  targetKind: string;
  component: string | null;
};
async function cases() {
  await asReviewer();
  const list = await value<{ cases: CaseSummary[] }>(LIST);
  await owner();
  return list.cases;
}

// Owner-seeded terminal recovery claim for an original execution, satisfying
// migration 040's unchanged CHECKs (single captured clock value).
async function seedRecovery(
  source: string,
  state: "ESCALATED" | "FAILED" | "TIMEOUT" | "RUNNING",
) {
  await owner();
  const id = randomUUID();
  const reason =
    state === "ESCALATED"
      ? "HUMAN_REVIEW_REQUIRED"
      : state === "TIMEOUT"
        ? "EXECUTION_TIMEOUT"
        : state === "FAILED"
          ? "PROVIDER_UNAVAILABLE"
          : null;
  await db.query(
    `with stamp as (select clock_timestamp() as t)
     insert into commercial_v1_examiner_recovery_executions(
       id,actor_id,source_execution_id,recovery_reason,student_id,enrolment_id,activation_id,capability,target_kind,
       attempt_id,submission_id,component,practical_id,runtime_profile_ref,state,reason_code,created_at,authorized_at,
       started_at,terminal_at,expires_at,max_provider_calls,max_output_tokens,max_estimated_cost_microusd,review_path)
     select $1,$2,x.id,'Recovery attempt',x.student_id,x.enrolment_id,x.activation_id,x.capability,x.target_kind,
       x.attempt_id,x.submission_id,x.component,x.practical_id,'EXAMINER_COMMERCIAL_V1',$3,$4,
       case when $3='RUNNING' then stamp.t-interval '5 seconds' else stamp.t-interval '30 seconds' end,
       case when $3='RUNNING' then stamp.t-interval '5 seconds' else stamp.t-interval '30 seconds' end,
       case when $3='RUNNING' then stamp.t-interval '4 seconds' else stamp.t-interval '25 seconds' end,
       case when $3='RUNNING' then null else stamp.t-interval '20 seconds' end,
       case when $3='RUNNING' then stamp.t+interval '10 seconds' else stamp.t-interval '15 seconds' end,
       1,1200,50000,case when $3='ESCALATED' then 'ACADEMIC_REVIEW' end
     from stamp, commercial_v1_examiner_executions x where x.id=$5`,
    [id, administrator, state, reason, source],
  );
  return id;
}
async function snapshot(table: string, id: string) {
  await owner();
  return (await db.query(`select * from ${table} where id=$1`, [id])).rows[0];
}
async function assessmentQuestions(component: Component) {
  await owner();
  return (
    await db.query<{ id: string; max_marks: number }>(
      "select id,max_marks from assessment_questions where assessment_id=$1 order by position",
      [f.assessmentIds[component]],
    )
  ).rows;
}
const marks = (entries: [string, number][]) =>
  JSON.stringify(
    entries.map(([questionId, marksAwarded]) => ({ questionId, marksAwarded })),
  );

beforeAll(async () => {
  f = await buildAssessmentPolicyFixture({
    withLabs: true,
    multiObjectiveQuestion: true,
    additionalQuizQuestion: true,
  });
  db = f.db;
  await owner();
  ids.practical = await value<string>(
    "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
    [f.importId],
  );
  await asReviewer();
  await db.query(
    "select set_commercial_v1_lab_policy($1,$2,10,2000,'Protected grading guidance sentinel','Test policy')",
    [f.activationId, ids.practical],
  );
  await db.query(
    "select publish_commercial_v1_result_policy($1,1,false,'Test result policy')",
    [f.activationId],
  );
  // A real learner attempt on QUIZ_1 (two questions): one answered, one not.
  const [q1] = await assessmentQuestions("QUIZ_1");
  await asPolicyUser(db, 1);
  ids.quiz1Attempt = await value<string>(
    "select public.start_assessment_attempt($1) as v",
    [f.assessmentIds.QUIZ_1],
  );
  await db.query(
    "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
    [
      ids.quiz1Attempt,
      q1.id,
      "Protected learner response sentinel",
      randomUUID(),
    ],
  );
  await db.query("select submit_assessment_attempt($1)", [ids.quiz1Attempt]);
  ids.submission = await value<string>(
    "select submit_commercial_v1_lab_work($1,$2,'Protected lab submission sentinel',$3) as v",
    [f.learnerEnrolmentId, ids.practical, randomUUID()],
  );
  // A: initial escalations (assessment + lab).
  ids.initialAssessment = await seedOriginalExecution(f, {
    component: "QUIZ_1",
    state: "ESCALATED",
    attemptId: ids.quiz1Attempt,
  });
  ids.initialLab = await seedOriginalExecution(f, {
    lab: { practicalId: ids.practical, submissionId: ids.submission },
    state: "ESCALATED",
  });
  // B: recovery escalated; C: recovery exhausted.
  ids.quiz2Original = await seedOriginalExecution(f, {
    component: "QUIZ_2",
    state: "FAILED",
  });
  ids.recoveryEscalated = await seedRecovery(ids.quiz2Original, "ESCALATED");
  ids.midtermOriginal = await seedOriginalExecution(f, {
    component: "MIDTERM",
    state: "FAILED",
  });
  ids.recoveryExhausted = await seedRecovery(ids.midtermOriginal, "TIMEOUT");
  // Never routed to human review: still recoverable, active, or result-bearing.
  ids.quiz3Recoverable = await seedOriginalExecution(f, {
    component: "QUIZ_3",
    state: "FAILED",
  });
  ids.quiz4Active = await seedActiveOriginalExecution(f, "QUIZ_4");
  ids.finalOriginal = await seedOriginalExecution(f, {
    component: "FINAL",
    state: "FAILED",
  });
  ids.finalRecoveryActive = await seedRecovery(ids.finalOriginal, "RUNNING");
});
afterAll(async () => {
  await db?.close();
});

describe("academic review worklist (migration 047)", () => {
  it("lists exactly the result-free human-review cases", async () => {
    const list = await cases();
    const byId = Object.fromEntries(list.map((c) => [c.caseId, c]));
    expect(Object.keys(byId).sort()).toEqual(
      [
        ids.initialAssessment,
        ids.initialLab,
        ids.recoveryEscalated,
        ids.recoveryExhausted,
      ].sort(),
    );
    expect(byId[ids.initialAssessment]).toMatchObject({
      caseKind: "INITIAL_ESCALATION",
      targetKind: "ASSESSMENT_ATTEMPT",
      component: "QUIZ_1",
    });
    expect(byId[ids.initialLab]).toMatchObject({
      caseKind: "INITIAL_ESCALATION",
      targetKind: "LAB_SUBMISSION",
    });
    expect(byId[ids.recoveryEscalated].caseKind).toBe("RECOVERY_ESCALATION");
    expect(byId[ids.recoveryExhausted].caseKind).toBe("RECOVERY_EXHAUSTED");
    // Bounded metadata only: no bodies, answer keys or guidance.
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/sentinel|protected answer/i);
    expect(list[0]).toHaveProperty("learnerName");
    expect(list[0]).toHaveProperty("targetTitle");
  });

  it("returns the protected review context for one open case only", async () => {
    await asReviewer();
    const ctx = await value<{
      assessment: {
        maxMarksTotal: number;
        questions: Array<{
          answered: boolean;
          responseBody: string | null;
          expectedAnswer: string;
          maxMarks: number;
        }>;
      };
    }>(GET, [ids.initialAssessment]);
    expect(ctx.assessment.maxMarksTotal).toBe(20);
    expect(ctx.assessment.questions).toHaveLength(2);
    expect(ctx.assessment.questions[0]).toMatchObject({
      answered: true,
      responseBody: "Protected learner response sentinel",
      maxMarks: 10,
    });
    expect(ctx.assessment.questions[0].expectedAnswer).toMatch(
      /protected answer/,
    );
    expect(ctx.assessment.questions[1]).toMatchObject({
      answered: false,
      responseBody: null,
    });
    const lab = await value<{
      lab: {
        maxMarks: number;
        contributionBp: number;
        submissionBody: string;
        gradingGuidance: string;
      };
    }>(GET, [ids.initialLab]);
    expect(lab.lab).toMatchObject({
      maxMarks: 10,
      contributionBp: 2000,
      submissionBody: "Protected lab submission sentinel",
      gradingGuidance: "Protected grading guidance sentinel",
    });
    for (const notOpen of [
      ids.quiz3Recoverable,
      ids.quiz4Active,
      ids.finalRecoveryActive,
      randomUUID(),
    ])
      await refused(GET, [notOpen], "CASE_NOT_OPEN");
    await owner();
  });
});

describe("academic review authority (migration 047)", () => {
  const denied = ["STUDENT", "INSTRUCTOR", "REGISTRAR", "COUNSELLOR"];
  it.each(denied)("%s cannot list, read or grade", async (role) => {
    await owner();
    await db.query(
      "delete from role_grants where user_id=$1 and role<>'STUDENT'",
      [foreignLearner],
    );
    if (role !== "STUDENT")
      await db.query("insert into role_grants values($1,$2)", [
        foreignLearner,
        role,
      ]);
    await asPolicyUser(db, 3);
    await refused(LIST, [], "FORBIDDEN");
    await refused(GET, [ids.initialAssessment], "FORBIDDEN");
    await refused(
      GRADE,
      [ids.initialAssessment, "[]", "Unauthorised grading"],
      "FORBIDDEN",
    );
    await refused(
      LAB,
      [ids.initialLab, 5, "Unauthorised grading"],
      "FORBIDDEN",
    );
    await owner();
  });

  it("PLATFORM_ADMIN and ACADEMIC_ADMIN can list the worklist", async () => {
    await owner();
    await db.query(
      "delete from role_grants where user_id=$1 and role<>'STUDENT'",
      [foreignLearner],
    );
    await db.query("insert into role_grants values($1,'PLATFORM_ADMIN')", [
      foreignLearner,
    ]);
    await asPolicyUser(db, 3);
    expect(
      (await value<{ cases: unknown[] }>(LIST)).cases.length,
    ).toBeGreaterThan(0);
    await asReviewer();
    expect(
      (await value<{ cases: unknown[] }>(LIST)).cases.length,
    ).toBeGreaterThan(0);
    await owner();
    await db.query(
      "delete from role_grants where user_id=$1 and role='PLATFORM_ADMIN'",
      [foreignLearner],
    );
  });

  it("a reviewer who is also the learner can never see, read or grade their own work", async () => {
    await owner();
    await db.query("insert into role_grants values($1,'ACADEMIC_ADMIN')", [
      learner,
    ]);
    await asPolicyUser(db, 1);
    expect((await value<{ cases: unknown[] }>(LIST)).cases).toEqual([]);
    await refused(GET, [ids.initialLab], "SELF_REVIEW_FORBIDDEN");
    await refused(
      LAB,
      [ids.initialLab, 5, "Grading my own lab"],
      "SELF_REVIEW_FORBIDDEN",
    );
    await owner();
    await db.query(
      "delete from role_grants where user_id=$1 and role='ACADEMIC_ADMIN'",
      [learner],
    );
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_lab_result_revisions where enrolment_id=$1",
        [f.learnerEnrolmentId],
      ),
    ).toBe(0);
  });

  it("anon and service_role cannot invoke any review function", async () => {
    for (const role of ["anon", "service_role"]) {
      await owner();
      await db.query("select set_config('request.jwt.claim.sub','',false)");
      await db.exec(`set role ${role}`);
      await refused(LIST, [], /permission denied/);
      await refused(
        GRADE,
        [ids.initialAssessment, "[]", "Direct invocation"],
        /permission denied/,
      );
      await refused(
        LAB,
        [ids.initialLab, 1, "Direct invocation"],
        /permission denied/,
      );
      await refused(
        "select * from commercial_v1_academic_review_decisions",
        [],
        /permission denied/,
      );
    }
    await owner();
  });
});

describe("manual first grade: assessment (migration 047)", () => {
  it("rejects incomplete, foreign, duplicate, out-of-range and over-specified marks", async () => {
    const [q1, q2] = await assessmentQuestions("QUIZ_1");
    const [foreign] = await assessmentQuestions("QUIZ_2");
    await asReviewer();
    const reason = "Escalated grading reviewed";
    await refused(
      GRADE,
      [ids.initialAssessment, marks([[q1.id, 7]]), reason],
      "INCOMPLETE_QUESTION_MARKS",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 7],
          [q2.id, 0],
          [foreign.id, 0],
        ]),
        reason,
      ],
      "FOREIGN_QUESTION",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 7],
          [q1.id, 7],
        ]),
        reason,
      ],
      "DUPLICATE_QUESTION",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, -1],
          [q2.id, 0],
        ]),
        reason,
      ],
      "MARKS_BELOW_ZERO",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 11],
          [q2.id, 0],
        ]),
        reason,
      ],
      "MARKS_EXCEED_MAX",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 7],
          [q2.id, 3],
        ]),
        reason,
      ],
      "UNANSWERED_QUESTION_GRADED",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 7.5],
          [q2.id, 0],
        ]),
        reason,
      ],
      "INVALID_MARKS",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        JSON.stringify([
          { questionId: q1.id, marksAwarded: 7, maxMarks: 7 },
          { questionId: q2.id, marksAwarded: 0, maxMarks: 1 },
        ]),
        reason,
      ],
      "INVALID_MARKS",
    );
    await refused(
      GRADE,
      [
        ids.initialAssessment,
        marks([
          [q1.id, 7],
          [q2.id, 0],
        ]),
        "no",
      ],
      "INVALID_REASON",
    );
    await refused(
      LAB,
      [ids.initialAssessment, 5, reason],
      "TARGET_KIND_MISMATCH",
    );
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_assessment_result_revisions where attempt_id=$1",
        [ids.quiz1Attempt],
      ),
    ).toBe(0);
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_academic_review_decisions",
      ),
    ).toBe(0);
  });

  it("creates exactly one valid authoritative revision 1, provenance and audit", async () => {
    const [q1, q2] = await assessmentQuestions("QUIZ_1");
    const before = await snapshot(
      "commercial_v1_examiner_executions",
      ids.initialAssessment,
    );
    await asReviewer();
    const result = await value<Record<string, unknown>>(GRADE, [
      ids.initialAssessment,
      marks([
        [q1.id, 7],
        [q2.id, 0],
      ]),
      "  Escalated grading reviewed by the academic board  ",
    ]);
    expect(result).toMatchObject({
      ok: true,
      code: "RESULT_CREATED",
      revisionNumber: 1,
      earnedMarks: 7,
      maxMarks: 20,
    });
    ids.quiz1Result = result.resultRevisionId as string;
    await owner();
    const revision = (
      await db.query(
        "select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp,provenance from commercial_v1_assessment_result_revisions where id=$1",
        [ids.quiz1Result],
      )
    ).rows[0];
    expect(revision).toEqual({
      activation_id: f.activationId,
      enrolment_id: f.learnerEnrolmentId,
      student_id: learner,
      component: "QUIZ_1",
      attempt_id: ids.quiz1Attempt,
      assessment_id: f.assessmentIds.QUIZ_1,
      revision_number: 1,
      earned_marks_total: 7,
      max_marks_total: 20,
      component_weight_bp: await value(
        "select commercial_v1_private.expected_component_weight($1,'QUIZ_1') as v",
        [f.activationId],
      ),
      provenance: "COMMERCIAL_V1_RESULTS_V1",
    });
    expect(
      await value(
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [ids.quiz1Result],
      ),
    ).toBe(true);
    const outcomes = (
      await db.query<{
        earned_marks: number;
        max_marks: number;
        outcome: string;
      }>(
        "select earned_marks,max_marks,outcome from commercial_v1_assessment_objective_outcomes where result_revision_id=$1",
        [ids.quiz1Result],
      )
    ).rows;
    // Both questions map to both objectives (multi-objective fixture).
    expect(outcomes).toEqual([
      { earned_marks: 7, max_marks: 20, outcome: "PARTIAL" },
      { earned_marks: 7, max_marks: 20, outcome: "PARTIAL" },
    ]);
    const decision = (
      await db.query(
        "select actor_id,case_kind,source_execution_id,recovery_execution_id,case_state,target_kind,assessment_result_revision_id,result_revision_number,decision_kind,status,reason from commercial_v1_academic_review_decisions where source_execution_id=$1",
        [ids.initialAssessment],
      )
    ).rows[0];
    expect(decision).toEqual({
      actor_id: administrator,
      case_kind: "INITIAL_ESCALATION",
      source_execution_id: ids.initialAssessment,
      recovery_execution_id: null,
      case_state: "ESCALATED",
      target_kind: "ASSESSMENT_ATTEMPT",
      assessment_result_revision_id: ids.quiz1Result,
      result_revision_number: 1,
      decision_kind: "MANUAL_FIRST_GRADE",
      status: "RESULT_CREATED",
      reason: "Escalated grading reviewed by the academic board",
    });
    const audit = (
      await db.query<{
        actor_id: string;
        source: string;
        after_state: Record<string, unknown>;
      }>(
        "select actor_id,source,after_state from audit_events where action='COMMERCIAL_V1_ACADEMIC_REVIEW_FIRST_GRADE' and after_state->>'result_revision_id'=$1",
        [ids.quiz1Result],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: administrator,
      source: "HUMAN_ACADEMIC_REVIEW",
    });
    expect(JSON.stringify(audit[0].after_state)).not.toMatch(
      /sentinel|protected answer|mac|secret/i,
    );
    // The terminal Examiner execution is untouched.
    expect(
      await snapshot(
        "commercial_v1_examiner_executions",
        ids.initialAssessment,
      ),
    ).toEqual(before);
  });

  it("a repeated or late submission never creates another revision 1", async () => {
    const [q1, q2] = await assessmentQuestions("QUIZ_1");
    await asReviewer();
    const replay = await value<Record<string, unknown>>(GRADE, [
      ids.initialAssessment,
      marks([
        [q1.id, 10],
        [q2.id, 0],
      ]),
      "A second reviewer submits later",
    ]);
    expect(replay).toMatchObject({
      ok: true,
      code: "ALREADY_RESOLVED",
      resultRevisionId: ids.quiz1Result,
    });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
        [f.learnerEnrolmentId],
      ),
    ).toBe(1);
    expect((await cases()).map((c) => c.caseId)).not.toContain(
      ids.initialAssessment,
    );
    // Database-level backstops independent of the RPC.
    await expect(
      db.query(
        "insert into commercial_v1_assessment_result_revisions(activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,1,0,max_marks_total,component_weight_bp from commercial_v1_assessment_result_revisions where id=$1",
        [ids.quiz1Result],
      ),
    ).rejects.toThrow(/INVALID_RESULT_REVISION_SEQUENCE|duplicate key/);
    await expect(
      db.query(
        "insert into commercial_v1_academic_review_decisions select * from commercial_v1_academic_review_decisions where source_execution_id=$1",
        [ids.initialAssessment],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("decisions are append-only and downstream progress observes the result", async () => {
    await owner();
    await expect(
      db.query(
        "update commercial_v1_academic_review_decisions set reason='Rewritten reason' where source_execution_id=$1",
        [ids.initialAssessment],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      db.query(
        "delete from commercial_v1_academic_review_decisions where source_execution_id=$1",
        [ids.initialAssessment],
      ),
    ).rejects.toThrow("append-only");
    await asReviewer();
    const progress = await value<{
      components: Record<string, { status: string; scoreBp?: number }>;
    }>("select public.get_commercial_v1_course_progress($1) as v", [
      f.learnerEnrolmentId,
    ]);
    expect(progress.components.QUIZ_1).toMatchObject({
      status: "FINALIZED",
      scoreBp: 3500,
    });
    await owner();
    // The existing regrade authority resolves the human-created revision as
    // its current, valid source.
    const source = (
      await db.query<{
        is_current: boolean;
        is_valid: boolean;
        revision_number: number;
      }>(
        "select is_current,is_valid,revision_number from commercial_v1_regrade_private.source($1,'ASSESSMENT_ATTEMPT')",
        [ids.quiz1Result],
      )
    ).rows[0];
    expect(source).toEqual({
      is_current: true,
      is_valid: true,
      revision_number: 1,
    });
  });
});

describe("manual first grade: lab (migration 047)", () => {
  it("rejects out-of-range marks and uses only the published lab policy", async () => {
    await asReviewer();
    await refused(
      LAB,
      [ids.initialLab, -1, "Escalated lab reviewed"],
      "MARKS_BELOW_ZERO",
    );
    await refused(
      LAB,
      [ids.initialLab, 11, "Escalated lab reviewed"],
      "MARKS_EXCEED_MAX",
    );
    await refused(
      GRADE,
      [ids.initialLab, "[]", "Escalated lab reviewed"],
      "TARGET_KIND_MISMATCH",
    );
    const result = await value<Record<string, unknown>>(LAB, [
      ids.initialLab,
      10,
      "Escalated lab reviewed",
    ]);
    expect(result).toMatchObject({
      ok: true,
      code: "RESULT_CREATED",
      revisionNumber: 1,
      earnedMarks: 10,
      maxMarks: 10,
    });
    expect(
      await value(LAB, [ids.initialLab, 3, "Escalated lab reviewed again"]),
    ).toMatchObject({
      code: "ALREADY_RESOLVED",
      resultRevisionId: result.resultRevisionId,
    });
    await owner();
    const row = (
      await db.query(
        "select practical_id,submission_id,enrolment_id,student_id,revision_number,earned_marks,max_marks,contribution_bp from commercial_v1_lab_result_revisions where id=$1",
        [result.resultRevisionId],
      )
    ).rows[0];
    expect(row).toEqual({
      practical_id: ids.practical,
      submission_id: ids.submission,
      enrolment_id: f.learnerEnrolmentId,
      student_id: learner,
      revision_number: 1,
      earned_marks: 10,
      max_marks: 10,
      contribution_bp: 2000,
    });
    expect(
      await value("select commercial_v1_private.lab_result_is_valid($1) as v", [
        result.resultRevisionId,
      ]),
    ).toBe(true);
    expect(
      await value(
        "select count(*)::int as v from commercial_v1_lab_result_revisions where enrolment_id=$1 and practical_id=$2",
        [f.learnerEnrolmentId, ids.practical],
      ),
    ).toBe(1);
  });
});

describe("recovery cases and status truth (migration 047)", () => {
  it("resolves recovery-escalated and exhausted cases and the recovery worklist stops claiming they are stranded", async () => {
    const statusOf = async (source: string) => {
      await asReviewer();
      const list = await value<{
        targets: Array<{ sourceExecutionId: string; recoveryStatus: string }>;
      }>("select public.list_commercial_v1_examiner_recovery_targets() as v");
      await owner();
      return list.targets.find((t) => t.sourceExecutionId === source)
        ?.recoveryStatus;
    };
    expect(await statusOf(ids.quiz2Original)).toBe("RECOVERY_ESCALATED");
    expect(await statusOf(ids.midtermOriginal)).toBe("RECOVERY_EXHAUSTED");
    expect(await statusOf(ids.quiz3Recoverable)).toBe("ELIGIBLE");
    const recoveryBefore = await snapshot(
      "commercial_v1_examiner_recovery_executions",
      ids.recoveryExhausted,
    );
    for (const [caseId, component] of [
      [ids.recoveryEscalated, "QUIZ_2"],
      [ids.recoveryExhausted, "MIDTERM"],
    ] as const) {
      const [q] = await assessmentQuestions(component);
      await asReviewer();
      // No learner response exists for these owner-seeded attempts: only 0.
      await refused(
        GRADE,
        [caseId, marks([[q.id, 5]]), "Recovery case reviewed"],
        "UNANSWERED_QUESTION_GRADED",
      );
      expect(
        await value(GRADE, [
          caseId,
          marks([[q.id, 0]]),
          "Recovery case reviewed",
        ]),
      ).toMatchObject({
        code: "RESULT_CREATED",
      });
    }
    expect(await statusOf(ids.quiz2Original)).toBe(
      "RESOLVED_BY_ACADEMIC_REVIEW",
    );
    expect(await statusOf(ids.midtermOriginal)).toBe(
      "RESOLVED_BY_ACADEMIC_REVIEW",
    );
    expect(await statusOf(ids.quiz3Recoverable)).toBe("ELIGIBLE");
    expect(
      await snapshot(
        "commercial_v1_examiner_recovery_executions",
        ids.recoveryExhausted,
      ),
    ).toEqual(recoveryBefore);
    await owner();
    expect(
      (
        await db.query(
          "select case_kind,recovery_execution_id from commercial_v1_academic_review_decisions where source_execution_id=$1",
          [ids.midtermOriginal],
        )
      ).rows[0],
    ).toEqual({
      case_kind: "RECOVERY_EXHAUSTED",
      recovery_execution_id: ids.recoveryExhausted,
    });
    expect(await cases()).toEqual([]);
  });
});
