import { randomBytes, randomUUID, createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
  administrator,
  type AssessmentPolicyFixture,
  type Component,
} from "./commercial-v1-assessment-policy-fixture";
import {
  computeExaminerAssessmentGradeDigest,
  computeExaminerLabGradeDigest,
} from "@/domain/commercial-v1-examiner-grading";
export { asPolicyUser, learner, administrator };
export async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
): Promise<T> {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
export async function owner(db: PGlite) {
  await db.exec("reset role");
}

// Test-owner seeding, using unchanged result insert guards and derivation.
// No production route can use these raw writers.
export async function seedResult(
  f: AssessmentPolicyFixture,
  component: Component,
  earned = 0,
  answer = false,
) {
  await owner(f.db);
  const questions = (
    await f.db.query<{ id: string; max_marks: number }>(
      "select id,max_marks from assessment_questions where assessment_id=$1 order by position",
      [f.assessmentIds[component]],
    )
  ).rows;
  const question = questions[0];
  const attempt = await value(
    f.db,
    `insert into assessment_attempts(id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,state,started_at,expires_at)
    values(gen_random_uuid(),$1,$2,$3,$4,$5,1,'ACTIVE',clock_timestamp()-interval '5 minutes',clock_timestamp()+interval '30 minutes') returning id as v`,
    [
      f.assessmentIds[component],
      f.learnerEnrolmentId,
      learner,
      f.cohortId,
      f.programmeVersionId,
    ],
  );
  if (answer) {
    await asPolicyUser(f.db, 1);
    await f.db.query(
      "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
      [
        attempt,
        question.id,
        "Protected learner response sentinel",
        randomUUID(),
      ],
    );
    await owner(f.db);
  }
  await f.db.query(
    "update assessment_attempts set state='SUBMITTED',submitted_at=clock_timestamp(),submission_provenance='STUDENT_SUBMIT' where id=$1",
    [attempt],
  );
  const result = await value(
    f.db,
    `insert into commercial_v1_assessment_result_revisions(activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp)
    values($1,$2,$3,$4,$5,$6,1,$7,$8,commercial_v1_private.expected_component_weight($1,$4)) returning id as v`,
    [
      f.activationId,
      f.learnerEnrolmentId,
      learner,
      component,
      attempt,
      f.assessmentIds[component],
      earned,
      questions.reduce((sum, q) => sum + q.max_marks, 0),
    ],
  );
  for (const q of questions)
    await f.db.query(
      "insert into commercial_v1_assessment_question_marks values($1,$2,$3,$4)",
      [result, q.id, q.id === question.id ? earned : 0, q.max_marks],
    );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
    [result],
  );
  return { result, attempt, questionId: question.id, max: question.max_marks };
}
export async function regradeFixture(additionalQuizQuestion = false) {
  const f = await buildAssessmentPolicyFixture({
    withLabs: true,
    multiObjectiveQuestion: true,
    additionalQuizQuestion,
  });
  await owner(f.db);
  const practical = await value(
    f.db,
    "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
    [f.importId],
  );
  await asPolicyUser(f.db, 2);
  await f.db.query(
    "select set_commercial_v1_lab_policy($1,$2,10,2000,'Protected grading guidance sentinel','Test policy')",
    [f.activationId, practical],
  );
  await f.db.query(
    "select publish_commercial_v1_result_policy($1,1,false,'Test result policy')",
    [f.activationId],
  );
  const assessment = await seedResult(f, "QUIZ_1", 0, true);
  await asPolicyUser(f.db, 1);
  const submission = await value(
    f.db,
    "select submit_commercial_v1_lab_work($1,$2,'Protected lab submission sentinel',$3) as v",
    [f.learnerEnrolmentId, practical, randomUUID()],
  );
  await owner(f.db);
  const lab = await value(
    f.db,
    `insert into commercial_v1_lab_result_revisions(activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp)
    values($1,$2,$3,$4,$5,1,0,10,2000) returning id as v`,
    [f.activationId, f.learnerEnrolmentId, learner, practical, submission],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
    [lab],
  );
  const keyId = randomUUID(),
    key = randomBytes(32);
  await f.db.query(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  return { ...f, assessment, lab, practical, submission, keyId, key };
}
export type RegradeFixture = Awaited<ReturnType<typeof regradeFixture>>;
export type Args = ReturnType<typeof args>;
export function args(f: RegradeFixture, lab = false) {
  const issued = Math.floor(Date.now() / 1000);
  return {
    p_key_id: f.keyId,
    p_execution_id: randomUUID(),
    p_source_id: lab ? f.lab : f.assessment.result,
    p_request_reason: "Independent institutional review",
    p_capability: lab
      ? "regrade_practical_lab"
      : "regrade_controlled_assessment",
    p_target_kind: lab ? "LAB_SUBMISSION" : "ASSESSMENT_ATTEMPT",
    p_student_id: null as string | null,
    p_attempt_id: null as string | null,
    p_submission_id: null as string | null,
    p_enrolment_id: null as string | null,
    p_activation_id: null as string | null,
    p_operation: "AUTHORIZE",
    p_state: "AUTHORIZED",
    p_reason: "NONE",
    p_budget_stage: "NONE",
    p_max_calls: 1,
    p_max_output: 1200,
    p_max_cost: 50000,
    p_calls: 0,
    p_attempts: 0,
    p_input: 0,
    p_output: 0,
    p_cost: 0,
    p_elapsed: 0,
    p_grade_digest: null as string | null,
    p_issued_at: issued,
    p_expires_at: issued + 10,
    p_mac: "",
    p_assessment_marks: null as unknown,
    p_lab_marks_awarded: null as number | null,
  };
}
// Independent SQL protocol transcription; never uses the production signer.
export function canonical(a: Args, actor = administrator) {
  return [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_REGRADE_HMAC_SHA256_V1",
    "COMMERCIAL_V1_EXAMINER_REGRADE_V1",
    "EXAMINER",
    "EXAMINER_COMMERCIAL_V1",
    a.p_key_id,
    actor,
    a.p_execution_id,
    a.p_source_id,
    Buffer.from(a.p_request_reason, "utf8").toString("hex"),
    a.p_capability,
    a.p_target_kind,
    a.p_student_id ?? "NONE",
    a.p_attempt_id ?? "NONE",
    a.p_submission_id ?? "NONE",
    a.p_enrolment_id ?? "NONE",
    a.p_activation_id ?? "NONE",
    a.p_operation,
    a.p_state,
    a.p_reason,
    a.p_budget_stage,
    a.p_max_calls,
    a.p_max_output,
    a.p_max_cost,
    a.p_calls,
    a.p_attempts,
    a.p_input,
    a.p_output,
    a.p_cost,
    a.p_elapsed,
    a.p_grade_digest ?? "NONE",
    a.p_issued_at,
    a.p_expires_at,
  ].join("\n");
}
export function sign(a: Args, key: Buffer, actor = administrator) {
  return createHmac("sha256", key)
    .update(canonical(a, actor), "utf8")
    .digest("hex");
}
export async function govern(
  f: RegradeFixture,
  a: Args,
  opts: { actor?: string; mac?: string } = {},
) {
  const values = Object.values({
    ...a,
    p_mac: opts.mac ?? sign(a, f.key, opts.actor),
  }).map((v, i) => (i === 28 ? JSON.stringify(v) : v));
  // JSON null must be SQL NULL outside FINALIZE.
  if (a.p_assessment_marks === null) values[28] = null;
  return value<Record<string, unknown>>(
    f.db,
    `select govern_commercial_v1_examiner_regrade(${values.map((_, i) => `$${i + 1}${i === 28 ? "::jsonb" : ""}`).join(",")}) as v`,
    values,
  );
}
export function bound(f: RegradeFixture, a: Args) {
  return {
    ...a,
    p_student_id: learner,
    p_attempt_id:
      a.p_target_kind === "ASSESSMENT_ATTEMPT" ? f.assessment.attempt : null,
    p_submission_id: a.p_target_kind === "LAB_SUBMISSION" ? f.submission : null,
    p_enrolment_id: f.learnerEnrolmentId,
    p_activation_id: f.activationId,
    p_operation: "START",
    p_state: "RUNNING",
  };
}
export async function running(f: RegradeFixture, lab = false) {
  const a = args(f, lab);
  await asPolicyUser(f.db, 2);
  const admitted = await govern(f, a);
  if (admitted.ok !== true) throw new Error(JSON.stringify(admitted));
  const s = bound(f, a);
  const started = await govern(f, s);
  if (started.ok !== true) throw new Error(JSON.stringify(started));
  return s;
}
export function graded(f: RegradeFixture, a: Args, mark = 1): Args {
  const lab = a.p_target_kind === "LAB_SUBMISSION";
  const marks = [{ questionId: f.assessment.questionId, marksAwarded: mark }];
  return {
    ...a,
    p_operation: "FINALIZE",
    p_state: "SUCCEEDED",
    p_reason: "GRADED",
    p_calls: 1,
    p_attempts: 1,
    p_input: 90,
    p_output: 20,
    p_cost: 50,
    p_elapsed: 5,
    p_grade_digest: lab
      ? computeExaminerLabGradeDigest(mark)
      : computeExaminerAssessmentGradeDigest(marks),
    p_assessment_marks: lab ? null : marks,
    p_lab_marks_awarded: lab ? mark : null,
  };
}
