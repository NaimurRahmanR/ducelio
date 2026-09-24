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

export const RECOVERABLE_STATES = [
  "FAILED",
  "TIMEOUT",
  "BUDGET_BLOCKED",
  "CANCELLED",
] as const;

// Test-owner seeding of a terminal ORIGINAL commercial_v1_examiner_executions
// row, mirroring commercial-v1-examiner-regrade-fixture.ts's own seedResult
// pattern: real INSERT satisfying the unchanged migration-031 CHECK
// constraints as the database owner, since no production RPC can create a
// row in a given terminal state directly (initial grading only ever reaches
// one via a real -- or in other test files, mocked -- provider execution).
// No production route can use this raw writer.
export async function seedOriginalExecution(
  f: AssessmentPolicyFixture,
  opts: {
    component?: Component;
    lab?: { practicalId: string; submissionId: string };
    state: (typeof RECOVERABLE_STATES)[number] | "ESCALATED" | "SUCCEEDED";
    reasonCode?: string;
    // Reuse an already-created attempt (e.g. recoveryFixture's own answered
    // QUIZ_1 attempt) instead of creating a fresh one -- each component has
    // attempts_allowed=1, so a component that already has an attempt must
    // never have a second one started.
    attemptId?: string;
  },
) {
  const lab = !!opts.lab;
  await owner(f.db);
  // Test-owner seeded, exactly like commercial-v1-examiner-regrade-fixture.ts's
  // own seedResult: only QUIZ_1's window is open "now" by construction (the
  // other five components deliberately sequence open over real wall-clock
  // hours -- publish_commercial_v1_grading_policy's own non-overlap check
  // requires it), so a genuinely eligible target on any OTHER component can
  // never be produced by actually calling start_assessment_attempt here. No
  // production route can use this raw writer.
  let attemptId: string | null = opts.attemptId ?? null;
  if (!lab && !attemptId) {
    attemptId = await value<string>(
      f.db,
      `insert into assessment_attempts(id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,state,started_at,expires_at,submitted_at,submission_provenance)
       values(gen_random_uuid(),$1,$2,$3,$4,$5,1,'SUBMITTED',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '20 minutes',clock_timestamp()-interval '5 minutes','STUDENT_SUBMIT')
       returning id as v`,
      [
        f.assessmentIds[opts.component!],
        f.learnerEnrolmentId,
        learner,
        f.cohortId,
        f.programmeVersionId,
      ],
    );
  }
  const id = randomUUID();
  const reasonCode =
    opts.reasonCode ??
    (opts.state === "TIMEOUT"
      ? "EXECUTION_TIMEOUT"
      : opts.state === "BUDGET_BLOCKED"
        ? "BUDGET_BLOCKED"
        : opts.state === "CANCELLED"
          ? "CANCELLED"
          : opts.state === "ESCALATED"
            ? "HUMAN_REVIEW_REQUIRED"
            : opts.state === "SUCCEEDED"
              ? "GRADED"
              : "PROVIDER_UNAVAILABLE");
  const budgetStage = opts.state === "BUDGET_BLOCKED" ? "PRE_CALL" : null;
  const reviewPath = opts.state === "ESCALATED" ? "ACADEMIC_REVIEW" : null;
  let resultRevisionId: string | null = null;
  let gradeDigest: string | null = null;
  if (opts.state === "SUCCEEDED") {
    gradeDigest = "a".repeat(64);
    resultRevisionId = await value<string>(
      f.db,
      lab
        ? `insert into commercial_v1_lab_result_revisions(activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp)
           values($1,$2,$3,$4,$5,1,0,10,2000) returning id as v`
        : `insert into commercial_v1_assessment_result_revisions(activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp)
           values($1,$2,$3,$4,$5,$6,1,0,10,commercial_v1_private.expected_component_weight($1,$4)) returning id as v`,
      lab
        ? [
            f.activationId,
            f.learnerEnrolmentId,
            learner,
            opts.lab!.practicalId,
            opts.lab!.submissionId,
          ]
        : [
            f.activationId,
            f.learnerEnrolmentId,
            learner,
            opts.component,
            attemptId,
            f.assessmentIds[opts.component!],
          ],
    );
  }
  await f.db.query(
    `insert into commercial_v1_examiner_executions(
      id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,submission_id,component,practical_id,
      runtime_profile_ref,state,reason_code,budget_stage,created_at,authorized_at,started_at,terminal_at,expires_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd,review_path,grade_digest,result_revision_id
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      'EXAMINER_COMMERCIAL_V1',$11,$12,$13,
      clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '50 seconds',clock_timestamp()-interval '40 seconds',
      clock_timestamp()-interval '40 seconds',1,1200,50000,$14,$15,$16
    )`,
    [
      id,
      learner,
      f.learnerEnrolmentId,
      f.activationId,
      lab ? "grade_practical_lab" : "grade_controlled_assessment",
      lab ? "LAB_SUBMISSION" : "ASSESSMENT_ATTEMPT",
      attemptId,
      lab ? opts.lab!.submissionId : null,
      lab ? null : opts.component,
      lab ? opts.lab!.practicalId : null,
      opts.state,
      reasonCode,
      budgetStage,
      reviewPath,
      gradeDigest,
      resultRevisionId,
    ],
  );
  return id;
}

// A real ACTIVE/RUNNING original claim -- never itself recoverable, used to
// prove recovery denies a non-terminal target. Inserted the same test-owner
// way (no production RPC exposes a raw claim insert either), state RUNNING.
export async function seedActiveOriginalExecution(
  f: AssessmentPolicyFixture,
  component: Component,
) {
  await owner(f.db);
  const attemptId = await value<string>(
    f.db,
    `insert into assessment_attempts(id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,attempt_number,state,started_at,expires_at,submitted_at,submission_provenance)
     values(gen_random_uuid(),$1,$2,$3,$4,$5,1,'SUBMITTED',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '20 minutes',clock_timestamp()-interval '5 minutes','STUDENT_SUBMIT')
     returning id as v`,
    [
      f.assessmentIds[component],
      f.learnerEnrolmentId,
      learner,
      f.cohortId,
      f.programmeVersionId,
    ],
  );
  const id = randomUUID();
  await f.db.query(
    `insert into commercial_v1_examiner_executions(
      id,student_id,enrolment_id,activation_id,capability,target_kind,attempt_id,component,
      runtime_profile_ref,state,created_at,authorized_at,started_at,expires_at,
      max_provider_calls,max_output_tokens,max_estimated_cost_microusd
    ) values (
      $1,$2,$3,$4,'grade_controlled_assessment','ASSESSMENT_ATTEMPT',$5,$6,
      'EXAMINER_COMMERCIAL_V1','RUNNING',clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '20 seconds',
      1,1200,50000
    )`,
    [id, learner, f.learnerEnrolmentId, f.activationId, attemptId, component],
  );
  return id;
}

export async function recoveryFixture(opts: { withLabs?: boolean } = {}) {
  const f = await buildAssessmentPolicyFixture({
    withLabs: opts.withLabs ?? true,
    multiObjectiveQuestion: true,
    examinerAgentConfig: {
      capabilities: ["grade_controlled_assessment", "grade_practical_lab"],
      escalationPolicy: "NONE",
    },
  });
  await owner(f.db);
  const practical =
    (opts.withLabs ?? true)
      ? await value<string>(
          f.db,
          "select id as v from course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
          [f.importId],
        )
      : null;
  await asPolicyUser(f.db, 2);
  if (practical)
    await f.db.query(
      "select set_commercial_v1_lab_policy($1,$2,10,2000,'Protected grading guidance sentinel','Test policy')",
      [f.activationId, practical],
    );
  await f.db.query(
    "select publish_commercial_v1_result_policy($1,1,false,'Test result policy')",
    [f.activationId],
  );

  // A real SUBMITTED, answered attempt with NO result -- exactly the shape
  // an eligible recovery target has. assessment_questions is protected
  // (RLS/ACL), so it is read as owner -- a learner reaches its content only
  // through the governed get_active_assessment_questions RPC in production.
  await owner(f.db);
  const questionId = await value<string>(
    f.db,
    "select id as v from assessment_questions where assessment_id=$1 order by position limit 1",
    [f.assessmentIds.QUIZ_1],
  );
  await asPolicyUser(f.db, 1);
  const attemptId = await value<string>(
    f.db,
    "select public.start_assessment_attempt($1) as v",
    [f.assessmentIds.QUIZ_1],
  );
  await f.db.query(
    "select record_commercial_v1_assessment_response($1,$2,$3,$4)",
    [
      attemptId,
      questionId,
      "Protected learner response sentinel",
      randomUUID(),
    ],
  );
  await f.db.query("select submit_assessment_attempt($1)", [attemptId]);

  let submission: string | null = null;
  if (practical)
    submission = await value<string>(
      f.db,
      "select submit_commercial_v1_lab_work($1,$2,'Protected lab submission sentinel',$3) as v",
      [f.learnerEnrolmentId, practical, randomUUID()],
    );

  const keyId = randomUUID(),
    key = randomBytes(32);
  await owner(f.db);
  await f.db.query(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );

  const assessmentOriginal = await seedOriginalExecution(f, {
    component: "QUIZ_1",
    state: "FAILED",
    attemptId,
  });
  const labOriginal = submission
    ? await seedOriginalExecution(f, {
        lab: { practicalId: practical!, submissionId: submission },
        state: "FAILED",
      })
    : null;

  return {
    ...f,
    practical,
    submission,
    attemptId,
    questionId,
    assessmentOriginal,
    labOriginal,
    keyId,
    key,
  };
}
export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;

export type Args = ReturnType<typeof args>;
export function args(f: RecoveryFixture, lab = false) {
  const issued = Math.floor(Date.now() / 1000);
  return {
    p_key_id: f.keyId,
    p_execution_id: randomUUID(),
    p_source_execution_id: lab ? f.labOriginal! : f.assessmentOriginal,
    p_recovery_reason: "Independent institutional recovery review",
    p_capability: lab ? "grade_practical_lab" : "grade_controlled_assessment",
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
    "DUCELIO_COMMERCIAL_V1_EXAMINER_RECOVERY_HMAC_SHA256_V1",
    "COMMERCIAL_V1_EXAMINER_INITIAL_RECOVERY_V1",
    "EXAMINER",
    "EXAMINER_COMMERCIAL_V1",
    a.p_key_id,
    actor,
    a.p_execution_id,
    a.p_source_execution_id,
    Buffer.from(a.p_recovery_reason, "utf8").toString("hex"),
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
  f: RecoveryFixture,
  a: Args,
  opts: { actor?: string; mac?: string } = {},
) {
  const values = Object.values({
    ...a,
    p_mac: opts.mac ?? sign(a, f.key, opts.actor),
  }).map((v, i) => (i === 28 ? JSON.stringify(v) : v));
  if (a.p_assessment_marks === null) values[28] = null;
  return value<Record<string, unknown>>(
    f.db,
    `select govern_commercial_v1_examiner_recovery(${values.map((_, i) => `$${i + 1}${i === 28 ? "::jsonb" : ""}`).join(",")}) as v`,
    values,
  );
}
export function bound(f: RecoveryFixture, a: Args) {
  return {
    ...a,
    p_student_id: learner,
    p_attempt_id: a.p_target_kind === "ASSESSMENT_ATTEMPT" ? f.attemptId : null,
    p_submission_id: a.p_target_kind === "LAB_SUBMISSION" ? f.submission : null,
    p_enrolment_id: f.learnerEnrolmentId,
    p_activation_id: f.activationId,
    p_operation: "START",
    p_state: "RUNNING",
  };
}
export async function running(f: RecoveryFixture, lab = false) {
  const a = args(f, lab);
  await asPolicyUser(f.db, 2);
  const admitted = await govern(f, a);
  if (admitted.ok !== true) throw new Error(JSON.stringify(admitted));
  const s = bound(f, a);
  const started = await govern(f, s);
  if (started.ok !== true) throw new Error(JSON.stringify(started));
  return s;
}
export function graded(f: RecoveryFixture, a: Args, mark = 1): Args {
  const lab = a.p_target_kind === "LAB_SUBMISSION";
  const marks = [{ questionId: f.questionId, marksAwarded: mark }];
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
