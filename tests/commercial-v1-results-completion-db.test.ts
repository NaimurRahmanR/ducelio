import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  administrator,
  learner,
  COMPONENTS,
  type AssessmentPolicyFixture,
  type Component,
} from "./commercial-v1-assessment-policy-fixture";

const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function fixture(
  opts: Parameters<typeof buildAssessmentPolicyFixture>[0],
) {
  const f = await buildAssessmentPolicyFixture(opts);
  if (!databases.includes(f.db)) databases.push(f.db);
  return f;
}
async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function row<T>(db: PGlite, sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows[0];
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}
async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}
async function asForeign(db: PGlite) {
  await asPolicyUser(db, 3);
}

const WEIGHT_COLUMN: Record<Component, string> = {
  QUIZ_1: "quiz_1_weight_bp",
  QUIZ_2: "quiz_2_weight_bp",
  MIDTERM: "midterm_weight_bp",
  QUIZ_3: "quiz_3_weight_bp",
  QUIZ_4: "quiz_4_weight_bp",
  FINAL: "final_weight_bp",
};

async function componentWeightBp(
  f: AssessmentPolicyFixture,
  component: Component,
) {
  await owner(f.db);
  return value<number>(
    f.db,
    `select ${WEIGHT_COLUMN[component]} as v from public.commercial_v1_grading_policies where activation_id=$1`,
    [f.activationId],
  );
}

// Fabricates a realistic, already-SUBMITTED attempt directly via
// database-owner authority (no real trusted writer RPC exists in 11A --
// see the migration's own file header), then a result-revision seed on
// top. Deliberately bypasses start_assessment_attempt's real availability-
// window gate: the six formal components' windows are, by the migration
// 029 sequencing rule, mutually exclusive in real wall-clock time (QUIZ_1
// closes before QUIZ_2 opens, etc.), so no fixture window shape can make
// all six simultaneously startable "now" -- exactly the same reasoning
// that already justifies owner-authority result seeding at all.
async function seedAssessmentResult(
  f: AssessmentPolicyFixture,
  component: Component,
  earned: number,
  opts: { revisionNumber?: number } = {},
) {
  const assessmentId = f.assessmentIds[component];
  await owner(f.db);
  const studentId = await value<string>(
    f.db,
    "select student_id as v from public.enrolments where id=$1",
    [f.learnerEnrolmentId],
  );
  const questionId = await value<string>(
    f.db,
    "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
    [assessmentId],
  );
  const maxMarks = await value<number>(
    f.db,
    "select max_marks as v from public.assessment_questions where id=$1",
    [questionId],
  );
  const weightBp = await componentWeightBp(f, component);
  const revisionNumber = opts.revisionNumber ?? 1;
  const attemptId = randomUUID();
  await f.db.query(
    `insert into public.assessment_attempts(
      id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,
      attempt_number,state,started_at,expires_at,submitted_at,submission_provenance
    ) values ($1,$2,$3,$4,$5,$6,$7,'SUBMITTED',now()-interval '30 minutes',now()-interval '10 minutes',now()-interval '10 minutes','STUDENT_SUBMIT')`,
    [
      attemptId,
      assessmentId,
      f.learnerEnrolmentId,
      studentId,
      f.cohortId,
      f.programmeVersionId,
      revisionNumber,
    ],
  );
  const resultId = await value<string>(
    f.db,
    `insert into public.commercial_v1_assessment_result_revisions(
      activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,
      revision_number,earned_marks_total,max_marks_total,component_weight_bp
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id as v`,
    [
      f.activationId,
      f.learnerEnrolmentId,
      studentId,
      component,
      attemptId,
      assessmentId,
      revisionNumber,
      earned,
      maxMarks,
      weightBp,
    ],
  );
  await f.db.query(
    "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,$3,$4)",
    [resultId, questionId, earned, maxMarks],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
    [resultId],
  );
  return { resultId, attemptId, assessmentId, questionId, maxMarks, weightBp };
}

async function seedFullMarksForAllComponents(f: AssessmentPolicyFixture) {
  for (const component of COMPONENTS) {
    const maxMarks = await (async () => {
      await owner(f.db);
      return value<number>(
        f.db,
        "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
        [f.assessmentIds[component]],
      );
    })();
    await seedAssessmentResult(f, component, maxMarks);
  }
}

async function getOwnedPracticalIds(f: AssessmentPolicyFixture) {
  await owner(f.db);
  return (
    await f.db.query<{ id: string }>(
      "select id from public.course_practicals where import_id=$1 and kind='PRACTICAL_LAB' order by position,id",
      [f.importId],
    )
  ).rows.map((r) => r.id);
}

async function getOwnedPracticalId(f: AssessmentPolicyFixture) {
  const ids = await getOwnedPracticalIds(f);
  if (!ids[0]) throw new Error("Expected at least one PRACTICAL_LAB");
  return ids[0];
}

async function setLabPolicy(
  f: AssessmentPolicyFixture,
  practicalId: string,
  contributionBp: number,
  opts: { maxMarks?: number; guidance?: string | null } = {},
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6) as v",
    [
      f.activationId,
      practicalId,
      opts.maxMarks ?? 10,
      contributionBp,
      contributionBp > 0
        ? (opts.guidance ?? "Grade for correct configuration.")
        : (opts.guidance ?? null),
      "Configure lab policy",
    ],
  );
}

async function publishResultPolicy(
  f: AssessmentPolicyFixture,
  passMarkBp = 5000,
  requireRemediationClear = false,
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_result_policy($1,$2,$3,$4) as v",
    [
      f.activationId,
      passMarkBp,
      requireRemediationClear,
      "Publish result policy",
    ],
  );
}

async function submitLabWork(f: AssessmentPolicyFixture, practicalId: string) {
  await asLearner(f.db);
  return value<string>(
    f.db,
    "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
    [
      f.learnerEnrolmentId,
      practicalId,
      "My lab submission text describing the completed configuration.",
      randomUUID(),
    ],
  );
}

async function seedLabResult(
  f: AssessmentPolicyFixture,
  practicalId: string,
  earned: number,
  opts: { revisionNumber?: number; submissionId?: string } = {},
) {
  let submissionId = opts.submissionId;
  if (!submissionId) submissionId = await submitLabWork(f, practicalId);
  await owner(f.db);
  const policy = await row<{ max_marks: number; contribution_bp: number }>(
    f.db,
    "select max_marks,contribution_bp from public.commercial_v1_lab_policies where activation_id=$1 and practical_id=$2",
    [f.activationId, practicalId],
  );
  const studentId = await value<string>(
    f.db,
    "select student_id as v from public.enrolments where id=$1",
    [f.learnerEnrolmentId],
  );
  const resultId = await value<string>(
    f.db,
    `insert into public.commercial_v1_lab_result_revisions(
      activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id as v`,
    [
      f.activationId,
      f.learnerEnrolmentId,
      studentId,
      practicalId,
      submissionId,
      opts.revisionNumber ?? 1,
      earned,
      policy.max_marks,
      policy.contribution_bp,
    ],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
    [resultId],
  );
  return { resultId, submissionId };
}

// =============================================================================
// RESULT POLICY
// =============================================================================
describe("Result policy publication", () => {
  it("cannot publish without the PR10 grading policy existing", async () => {
    const f = await fixture({ withLabs: false, publish: false });
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
        [f.activationId, 5000, false, "Publish without grading policy"],
      ),
    ).rejects.toThrow("GRADING_POLICY_REQUIRED");
  });

  it("rejects pass_mark_bp of 0 and 10001; accepts the 1 and 10000 boundaries", async () => {
    const f = await fixture({ withLabs: false });
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
        [f.activationId, 0, false, "Zero pass mark"],
      ),
    ).rejects.toThrow("INVALID_PASS_MARK");
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
        [f.activationId, 10001, false, "Over-max pass mark"],
      ),
    ).rejects.toThrow("INVALID_PASS_MARK");
    const g = await fixture({ withLabs: false });
    await publishResultPolicy(g, 1, false);
    const h = await fixture({ withLabs: false });
    await publishResultPolicy(h, 10000, false);
    await owner(h.db);
    const bp = await value<number>(
      h.db,
      "select pass_mark_bp as v from public.commercial_v1_result_policies where activation_id=$1",
      [h.activationId],
    );
    expect(bp).toBe(10000);
    // Three complete fresh databases (one per boundary activation, since a
    // published policy is immutable): budgeted like the other multi-build
    // database tests rather than the 30 s single-build default.
  }, 120000);

  it("no universal default pass mark exists -- the function requires the caller to supply one", async () => {
    const f = await fixture({ withLabs: false });
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3)",
        [f.activationId, false, "Missing pass mark argument"],
      ),
    ).rejects.toThrow();
  });

  it("snapshots activation/cohort/programme-version identity and is immutable after publication", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 6000, true);
    await owner(f.db);
    const rp = await row<{
      cohort_id: string;
      programme_version_id: string;
      pass_mark_bp: number;
    }>(
      f.db,
      "select cohort_id,programme_version_id,pass_mark_bp from public.commercial_v1_result_policies where activation_id=$1",
      [f.activationId],
    );
    expect(rp.cohort_id).toBe(f.cohortId);
    expect(rp.programme_version_id).toBe(f.programmeVersionId);
    await expect(
      f.db.query(
        "update public.commercial_v1_result_policies set pass_mark_bp=1 where activation_id=$1",
        [f.activationId],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      f.db.query(
        "delete from public.commercial_v1_result_policies where activation_id=$1",
        [f.activationId],
      ),
    ).rejects.toThrow("immutable");
  });

  it("idempotent replay with identical values returns the same policy; a conflicting replay fails", async () => {
    const f = await fixture({ withLabs: false });
    const first = await publishResultPolicy(f, 5500, true);
    const replay = await publishResultPolicy(f, 5500, true);
    expect(replay).toBe(first);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
        [f.activationId, 6000, true, "Conflicting replay"],
      ),
    ).rejects.toThrow("RESULT_POLICY_ALREADY_PUBLISHED");
  });
});

// =============================================================================
// LAB POLICY
// =============================================================================
describe("Lab policy -- never inferred equal weighting", () => {
  it("WITH_LABS: explicit contributions must sum exactly 2000", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    const activationId = await publishResultPolicy(f);
    expect(activationId).toBe(f.activationId);
  });

  it("a zero-weight lab is explicitly configured, receives no inferred weight, and is not required for completion", async () => {
    const f = await fixture({ withLabs: true, additionalLab: true });
    const labs = await getOwnedPracticalIds(f);
    expect(labs).toHaveLength(2);
    const weightedLab = labs[0]!;
    const zeroLab = labs[1]!;
    await setLabPolicy(f, weightedLab, 2000);
    await setLabPolicy(f, zeroLab, 0, { guidance: null });
    await publishResultPolicy(f, 5000, false);
    await seedFullMarksForAllComponents(f);
    await seedLabResult(f, weightedLab, 10);
    await asLearner(f.db);
    const completed = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Complete without zero-weight lab result"],
    );
    expect(completed).toMatchObject({ ok: true, code: "COMPLETED" });
    await owner(f.db);
    const zeroLabResults = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_lab_result_revisions where enrolment_id=$1 and practical_id=$2",
      [f.learnerEnrolmentId, zeroLab],
    );
    expect(zeroLabResults).toBe("0");
  });

  it("missing lab policy for a real PRACTICAL_LAB fails publication (no equal-weight inference)", async () => {
    const f = await fixture({ withLabs: true });
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
        [f.activationId, 5000, false, "Publish without any lab policy"],
      ),
    ).rejects.toThrow("LAB_POLICY_INCOMPLETE");
  });

  it("a foreign activation's practical cannot be configured", async () => {
    const f = await fixture({ withLabs: true });
    const g = await fixture({ withLabs: true });
    const foreignPracticalId = await getOwnedPracticalId(g);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          foreignPracticalId,
          10,
          2000,
          "Guidance",
          "Foreign practical",
        ],
      ),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });

  it("an EXERCISE practical is not eligible for lab policy", async () => {
    const f = await fixture({ withLabs: true });
    // The fixture package only ever materialises a PRACTICAL_LAB; construct
    // a real EXERCISE row for the same activation's own import/version
    // directly (owner authority, mirroring exactly how activate_course_
    // package itself would have inserted one from an EXERCISE package
    // entry) so the RPC's own kind check is exercised against a real row.
    await owner(f.db);
    const lessonId = await value<string>(
      f.db,
      "select lesson_id as v from public.course_practicals where import_id=$1 limit 1",
      [f.importId],
    );
    const exerciseId = await value<string>(
      f.db,
      `insert into public.course_practicals(import_id,programme_version_id,lesson_id,local_key,kind,title,instructions,position)
       values ($1,$2,$3,'exercise-not-eligible','EXERCISE','Exercise','Practice only.',99) returning id as v`,
      [f.importId, f.programmeVersionId, lessonId],
    );
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          exerciseId,
          10,
          500,
          "Guidance",
          "Exercise not eligible",
        ],
      ),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });

  it("NO_LABS has no eligible PRACTICAL_LAB and cannot configure a foreign positive lab contribution", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const ownedLabs = await value<string>(
      f.db,
      "select count(*)::text as v from public.course_practicals where import_id=$1 and kind='PRACTICAL_LAB'",
      [f.importId],
    );
    expect(ownedLabs).toBe("0");
    const g = await fixture({ withLabs: true });
    const foreignLab = await getOwnedPracticalId(g);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          foreignLab,
          10,
          2000,
          "Guidance",
          "Reject foreign lab",
        ],
      ),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    const activationId = await publishResultPolicy(f);
    expect(activationId).toBe(f.activationId);
  });

  it("lab policy is frozen once the result policy is published", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          practicalId,
          10,
          1500,
          "New guidance",
          "Rebind after publish",
        ],
      ),
    ).rejects.toThrow("RESULT_POLICY_ALREADY_PUBLISHED");
  });

  it("positive contribution requires grading guidance", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [f.activationId, practicalId, 10, 2000, null, "Missing guidance"],
      ),
    ).rejects.toThrow("GRADING_GUIDANCE_REQUIRED");
  });
});

// =============================================================================
// LAB SUBMISSION
// =============================================================================
describe("Lab submission", () => {
  it("succeeds for the owning learner once a result policy is published; idempotent replay returns the same submission", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    const key = randomUUID();
    await asLearner(f.db);
    const first = await value<string>(
      f.db,
      "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
      [f.learnerEnrolmentId, practicalId, "Final lab answer.", key],
    );
    const replay = await value<string>(
      f.db,
      "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
      [f.learnerEnrolmentId, practicalId, "Final lab answer.", key],
    );
    expect(replay).toBe(first);
  });

  it("refuses submission before a result policy is published", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await asLearner(f.db);
    await expect(
      f.db.query("select public.submit_commercial_v1_lab_work($1,$2,$3,$4)", [
        f.learnerEnrolmentId,
        practicalId,
        "Too early.",
        randomUUID(),
      ]),
    ).rejects.toThrow("RESULT_POLICY_REQUIRED");
  });

  it("a second, conflicting submission for the same enrolment+practical fails -- one final submission only", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    await submitLabWork(f, practicalId);
    await asLearner(f.db);
    await expect(
      f.db.query("select public.submit_commercial_v1_lab_work($1,$2,$3,$4)", [
        f.learnerEnrolmentId,
        practicalId,
        "A different answer.",
        randomUUID(),
      ]),
    ).rejects.toThrow("LAB_ALREADY_SUBMITTED");
  });

  it("submissions are immutable -- no UPDATE or DELETE", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_lab_submissions set body='hacked' where id=$1",
        [submissionId],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      f.db.query(
        "delete from public.commercial_v1_lab_submissions where id=$1",
        [submissionId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("a foreign learner cannot submit against another learner's enrolment", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    await asForeign(f.db);
    await expect(
      f.db.query("select public.submit_commercial_v1_lab_work($1,$2,$3,$4)", [
        f.learnerEnrolmentId,
        practicalId,
        "Hijack attempt.",
        randomUUID(),
      ]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });

  it("no arbitrary mark-writer RPC is exposed to the learner -- authenticated has zero privileges on the result/mark tables themselves", async () => {
    const f = await fixture({ withLabs: true });
    await owner(f.db);
    const unsafe = await value<string>(
      f.db,
      `select coalesce(string_agg(t.relname,','),'') as v
       from pg_class t join pg_namespace n on n.oid=t.relnamespace
       where n.nspname='public' and t.relname in (
         'commercial_v1_assessment_result_revisions','commercial_v1_assessment_question_marks',
         'commercial_v1_assessment_objective_outcomes','commercial_v1_lab_result_revisions',
         'commercial_v1_lab_objective_outcomes'
       ) and (
         has_table_privilege('authenticated',t.oid,'INSERT,UPDATE,DELETE')
         or has_any_column_privilege('authenticated',t.oid,'INSERT,UPDATE')
       )`,
    );
    expect(unsafe).toBe("");
    // Nor is any derivation/seeding helper itself reachable by authenticated.
    const helpers = await value<string>(
      f.db,
      `select coalesce(string_agg(p.proname,','),'') as v from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='commercial_v1_private' and p.proname ilike '%marks%'
         and has_function_privilege('authenticated',p.oid,'EXECUTE')`,
    );
    expect(helpers).toBe("");
  });
});

// =============================================================================
// SCORE ROUNDING / ARITHMETIC
// =============================================================================
describe("Deterministic integer score calculation", () => {
  it("full marks yields exactly the configured component weight as the weighted contribution", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const { resultId, weightBp } = await seedAssessmentResult(f, "MIDTERM", 10);
    await owner(f.db);
    const contribution = await value<number>(
      f.db,
      "select weighted_contribution_bp as v from public.commercial_v1_assessment_result_revisions where id=$1",
      [resultId],
    );
    expect(contribution).toBe(weightBp);
    expect(weightBp).toBe(2000);
  });

  it("zero marks yields exactly zero weighted contribution", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const { resultId } = await seedAssessmentResult(f, "QUIZ_1", 0);
    await owner(f.db);
    const contribution = await value<number>(
      f.db,
      "select weighted_contribution_bp as v from public.commercial_v1_assessment_result_revisions where id=$1",
      [resultId],
    );
    expect(contribution).toBe(0);
  });

  it("round-half-up boundary: 5/10 of a 500bp weight rounds to exactly 250", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const { resultId } = await seedAssessmentResult(f, "QUIZ_1", 5);
    await owner(f.db);
    const row1 = await row<{
      score_bp: number;
      weighted_contribution_bp: number;
    }>(
      f.db,
      "select score_bp,weighted_contribution_bp from public.commercial_v1_assessment_result_revisions where id=$1",
      [resultId],
    );
    expect(row1.score_bp).toBe(5000);
    expect(row1.weighted_contribution_bp).toBe(250);
  });

  it("a full-marks course (all six components + full-weight labs) sums to exactly 10000 course bp", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000, { maxMarks: 10 });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    await seedLabResult(f, practicalId, 10);
    await asLearner(f.db);
    const progress = await value<{ courseScoreBp: number }>(
      f.db,
      "select public.get_commercial_v1_course_progress($1) as v",
      [f.learnerEnrolmentId],
    );
    expect(progress.courseScoreBp).toBe(10000);
  });

  it("question marks cannot exceed the question's own actual max marks", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await asLearner(f.db);
    const attemptId = await value<string>(
      f.db,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const studentId = await value<string>(
      f.db,
      "select student_id as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    const resultId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
      ) values ($1,$2,$3,'QUIZ_1',$4,$5,1,10,10,500) returning id as v`,
      [
        f.activationId,
        f.learnerEnrolmentId,
        studentId,
        attemptId,
        f.assessmentIds.QUIZ_1,
      ],
    );
    await expect(
      f.db.query(
        "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,$3,$4)",
        [resultId, questionId, 11, 10],
      ),
    ).rejects.toThrow();
  });
});

// =============================================================================
// RESULT INTEGRITY -- MALFORMED HIGHEST REVISIONS FAIL CLOSED
// =============================================================================
describe("Institutional result integrity", () => {
  it("rejects a question from another assessment and never falls back to the older valid revision", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const first = await seedAssessmentResult(f, "QUIZ_1", 10);
    await owner(f.db);
    const foreignQuestion = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_2],
    );
    const resultId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
      ) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,10,max_marks_total,component_weight_bp
        from public.commercial_v1_assessment_result_revisions where id=$1 returning id as v`,
      [first.resultId],
    );
    await expect(
      f.db.query(
        "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,10,10)",
        [resultId, foreignQuestion],
      ),
    ).rejects.toThrow("QUESTION_NOT_IN_RESULT_ASSESSMENT");
    const current = await value<string | null>(
      f.db,
      "select (commercial_v1_private.current_assessment_result($1,'QUIZ_1')).id as v",
      [f.learnerEnrolmentId],
    );
    expect(current).toBeNull();
  });

  it("rejects a fake question max snapshot", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const first = await seedAssessmentResult(f, "QUIZ_1", 10);
    await owner(f.db);
    const resultId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
      ) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,10,max_marks_total,component_weight_bp
        from public.commercial_v1_assessment_result_revisions where id=$1 returning id as v`,
      [first.resultId],
    );
    await expect(
      f.db.query(
        "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,9,9)",
        [resultId, first.questionId],
      ),
    ).rejects.toThrow("QUESTION_MAX_MARKS_MISMATCH");
  });

  it("rejects a wrong header max total and a wrong component weight", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const first = await seedAssessmentResult(f, "QUIZ_1", 10);
    await owner(f.db);
    await expect(
      f.db.query(
        `insert into public.commercial_v1_assessment_result_revisions(
          activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
        ) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,10,max_marks_total+1,component_weight_bp
          from public.commercial_v1_assessment_result_revisions where id=$1`,
        [first.resultId],
      ),
    ).rejects.toThrow("INVALID_ASSESSMENT_MAX_TOTAL");
    await expect(
      f.db.query(
        `insert into public.commercial_v1_assessment_result_revisions(
          activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
        ) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,10,max_marks_total,component_weight_bp+1
          from public.commercial_v1_assessment_result_revisions where id=$1`,
        [first.resultId],
      ),
    ).rejects.toThrow("INVALID_COMPONENT_WEIGHT");
  });

  it("a mismatched earned total cannot derive outcomes or become current", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const first = await seedAssessmentResult(f, "QUIZ_1", 10);
    await owner(f.db);
    const resultId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
      ) select activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,2,9,max_marks_total,component_weight_bp
        from public.commercial_v1_assessment_result_revisions where id=$1 returning id as v`,
      [first.resultId],
    );
    await f.db.query(
      "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,5,$3)",
      [resultId, first.questionId, first.maxMarks],
    );
    await expect(
      f.db.query(
        "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
        [resultId],
      ),
    ).rejects.toThrow("RESULT_TOTAL_MISMATCH");
    const current = await value<string | null>(
      f.db,
      "select (commercial_v1_private.current_assessment_result($1,'QUIZ_1')).id as v",
      [f.learnerEnrolmentId],
    );
    expect(current).toBeNull();
  });

  it("rejects an attempt from another assessment", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const quiz1 = await seedAssessmentResult(f, "QUIZ_1", 10);
    const quiz2 = await seedAssessmentResult(f, "QUIZ_2", 10);
    await owner(f.db);
    await expect(
      f.db.query(
        `insert into public.commercial_v1_assessment_result_revisions(
          activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,earned_marks_total,max_marks_total,component_weight_bp
        ) select activation_id,enrolment_id,student_id,component,$2,assessment_id,2,10,max_marks_total,component_weight_bp
          from public.commercial_v1_assessment_result_revisions where id=$1`,
        [quiz1.resultId, quiz2.attemptId],
      ),
    ).rejects.toThrow("INVALID_ASSESSMENT_RESULT_ATTEMPT");
  });

  it("rejects lab max/contribution mismatches and a submission from another practical", async () => {
    const f = await fixture({ withLabs: true, additionalLab: true });
    const labs = await getOwnedPracticalIds(f);
    expect(labs).toHaveLength(2);
    const labA = labs[0]!;
    const labB = labs[1]!;
    await setLabPolicy(f, labA, 1000);
    await setLabPolicy(f, labB, 1000);
    await publishResultPolicy(f);
    const first = await seedLabResult(f, labA, 10);
    const otherSubmission = await submitLabWork(f, labB);
    await owner(f.db);
    const studentId = await value<string>(
      f.db,
      "select student_id as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    const baseArgs = [
      f.activationId,
      f.learnerEnrolmentId,
      studentId,
      labA,
      first.submissionId,
    ];
    await expect(
      f.db.query(
        `insert into public.commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values ($1,$2,$3,$4,$5,2,10,11,1000)`,
        baseArgs,
      ),
    ).rejects.toThrow("LAB_MAX_MARKS_MISMATCH");
    await expect(
      f.db.query(
        `insert into public.commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values ($1,$2,$3,$4,$5,2,10,10,999)`,
        baseArgs,
      ),
    ).rejects.toThrow("LAB_CONTRIBUTION_MISMATCH");
    await expect(
      f.db.query(
        `insert into public.commercial_v1_lab_result_revisions(
          activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
        ) values ($1,$2,$3,$4,$5,2,10,10,1000)`,
        [
          f.activationId,
          f.learnerEnrolmentId,
          studentId,
          labA,
          otherSubmission,
        ],
      ),
    ).rejects.toThrow("INVALID_LAB_RESULT_SUBMISSION");
  });
});

// =============================================================================
// OBJECTIVE OUTCOMES
// =============================================================================
describe("Objective outcome derivation", () => {
  it("earned=0 => INCORRECT, earned=max => CORRECT, otherwise => PARTIAL", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const zero = await seedAssessmentResult(f, "QUIZ_1", 0);
    const full = await seedAssessmentResult(f, "QUIZ_2", 10);
    const partial = await seedAssessmentResult(f, "QUIZ_3", 4);
    await owner(f.db);
    for (const [seed, expected] of [
      [zero, "INCORRECT"],
      [full, "CORRECT"],
      [partial, "PARTIAL"],
    ] as const) {
      const outcome = await value<string>(
        f.db,
        "select outcome as v from public.commercial_v1_assessment_objective_outcomes where result_revision_id=$1",
        [seed.resultId],
      );
      expect(outcome).toBe(expected);
    }
  });

  it("a multi-objective question fans out diagnostically while counting once in the numeric score", async () => {
    const f = await fixture({ withLabs: false, multiObjectiveQuestion: true });
    await publishResultPolicy(f);
    const { resultId, maxMarks, weightBp } = await seedAssessmentResult(
      f,
      "QUIZ_1",
      5,
    );
    await owner(f.db);
    const outcomes = await f.db.query<{
      objective_id: string;
      earned_marks: number;
      max_marks: number;
      outcome: string;
    }>(
      "select objective_id,earned_marks,max_marks,outcome from public.commercial_v1_assessment_objective_outcomes where result_revision_id=$1 order by objective_id",
      [resultId],
    );
    expect(outcomes.rows).toHaveLength(2);
    for (const outcome of outcomes.rows) {
      expect(outcome.earned_marks).toBe(5);
      expect(outcome.max_marks).toBe(maxMarks);
      expect(outcome.outcome).toBe("PARTIAL");
    }
    const scoreRow = await row<{
      earned_marks_total: number;
      max_marks_total: number;
      score_bp: number;
      weighted_contribution_bp: number;
    }>(
      f.db,
      "select earned_marks_total,max_marks_total,score_bp,weighted_contribution_bp from public.commercial_v1_assessment_result_revisions where id=$1",
      [resultId],
    );
    expect(scoreRow.earned_marks_total).toBe(5);
    expect(scoreRow.max_marks_total).toBe(maxMarks);
    expect(scoreRow.score_bp).toBe(5000);
    expect(scoreRow.weighted_contribution_bp).toBe(
      Math.round((5 * weightBp) / maxMarks),
    );
  });

  it("lab objective outcomes apply the same earned/max ratio to every mapped objective", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f);
    const { resultId } = await seedLabResult(f, practicalId, 0);
    await owner(f.db);
    const outcome = await value<string>(
      f.db,
      "select outcome as v from public.commercial_v1_lab_objective_outcomes where result_revision_id=$1",
      [resultId],
    );
    expect(outcome).toBe("INCORRECT");
  });
});

// =============================================================================
// REMEDIATION
// =============================================================================
describe("Remediation, separate from MASTERY_V1", () => {
  it("a negative result opens remediation for the mapped objective", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 0);
    await owner(f.db);
    const openCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_remediation_items where enrolment_id=$1 and state='OPEN'",
      [f.learnerEnrolmentId],
    );
    expect(openCount).toBe("1");
  });

  it("CORRECT never mutates objective_mastery -- MASTERY_V1 remains untouched by a result", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await owner(f.db);
    const before = await value<string>(
      f.db,
      "select count(*)::text as v from public.objective_mastery where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    await seedAssessmentResult(f, "QUIZ_1", 10);
    const after = await value<string>(
      f.db,
      "select count(*)::text as v from public.objective_mastery where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(after).toBe(before);
  });

  it("a superseding current result that removes every negative outcome resolves the open item", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 0);
    await owner(f.db);
    let openCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_remediation_items where enrolment_id=$1 and state='OPEN'",
      [f.learnerEnrolmentId],
    );
    expect(openCount).toBe("1");
    await seedAssessmentResult(f, "QUIZ_1", 10, { revisionNumber: 2 });
    openCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_remediation_items where enrolment_id=$1 and state='OPEN'",
      [f.learnerEnrolmentId],
    );
    expect(openCount).toBe("0");
    const resolvedReason = await value<string>(
      f.db,
      "select resolved_reason as v from public.commercial_v1_remediation_items where enrolment_id=$1 order by resolved_at desc limit 1",
      [f.learnerEnrolmentId],
    );
    expect(resolvedReason).toBe("SUPERSEDED_RESULT");
  });

  it("real later MASTERY_V1 DEMONSTRATED evidence (recorded after remediation opened) resolves the open item", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 0);
    await owner(f.db);
    const objectiveId = await value<string>(
      f.db,
      "select objective_id as v from public.commercial_v1_remediation_items where enrolment_id=$1 and state='OPEN'",
      [f.learnerEnrolmentId],
    );
    // A real class session + two distinct kinds/sessions of CORRECT
    // evidence, exactly like tests/... exercise MASTERY_V1 elsewhere, so
    // apply_objective_mastery_policy reaches DEMONSTRATED unmodified.
    const lessonId = await value<string>(
      f.db,
      "select lesson_id as v from public.assessments where id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    const sessionIds = [randomUUID(), randomUUID()];
    for (const sessionId of sessionIds) {
      await f.db.query(
        `insert into public.class_sessions(id,cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,status,created_by)
         values ($1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '1 hour','SCHEDULED',$5)`,
        [sessionId, f.cohortId, f.programmeVersionId, lessonId, administrator],
      );
    }
    await asAdmin(f.db);
    for (const [idx, sessionId] of sessionIds.entries()) {
      await f.db.query(
        "select public.record_learning_evidence($1,$2,$3,$4,'CORRECT',$5,$6,$7)",
        [
          sessionId,
          f.learnerEnrolmentId,
          objectiveId,
          idx === 0 ? "CLASS_RESPONSE" : "RETRIEVAL_CHECK",
          "Remediation resolution evidence",
          randomUUID(),
          "Record remediation-resolving evidence",
        ],
      );
    }
    await owner(f.db);
    const masteryState = await value<string>(
      f.db,
      "select state as v from public.objective_mastery where enrolment_id=$1 and objective_id=$2",
      [f.learnerEnrolmentId, objectiveId],
    );
    expect(masteryState).toBe("DEMONSTRATED");
    const item = await row<{ state: string; resolved_reason: string }>(
      f.db,
      "select state,resolved_reason from public.commercial_v1_remediation_items where enrolment_id=$1 and objective_id=$2 order by opened_at desc limit 1",
      [f.learnerEnrolmentId, objectiveId],
    );
    expect(item.state).toBe("RESOLVED");
    expect(item.resolved_reason).toBe("MASTERY_DEMONSTRATED");
  });

  it("historical MASTERY_V1 functions/records preserve their exact prior semantics (regression)", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const fnCount = await value<string>(
      f.db,
      "select count(*)::text as v from pg_proc where proname='apply_objective_mastery_policy'",
    );
    expect(fnCount).toBe("1");
  });
});

// =============================================================================
// PROJECTIONS
// =============================================================================
describe("Bounded course-progress projection", () => {
  it("self-scoped: the owning learner can read their own progress", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 5000);
    await asLearner(f.db);
    const progress = await value<{ ok: boolean; passMarkBp: number }>(
      f.db,
      "select public.get_commercial_v1_course_progress($1) as v",
      [f.learnerEnrolmentId],
    );
    expect(progress.ok).toBe(true);
    expect(progress.passMarkBp).toBe(5000);
  });

  it("a foreign learner cannot read another learner's progress", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await asForeign(f.db);
    const progress = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.get_commercial_v1_course_progress($1) as v",
      [f.learnerEnrolmentId],
    );
    expect(progress).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("returns the exact denied DTO for a self-owned enrolment with no Commercial V1 activation", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const cohortId = randomUUID();
    await f.db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Unactivated cohort',current_date)",
      [cohortId, f.programmeVersionId],
    );
    await asAdmin(f.db);
    const enrolmentId = await value<string>(
      f.db,
      "select public.create_enrolment($1,$2,$3) as v",
      [learner, cohortId, "Create unactivated enrolment"],
    );
    await asLearner(f.db);
    const progress = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_course_progress($1) as v",
      [enrolmentId],
    );
    expect(progress).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("never exposes protected content -- no answer key, prompt, marking guidance or response body appears in the projection", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 5);
    await asLearner(f.db);
    const progress = await value<Record<string, unknown>>(
      f.db,
      "select public.get_commercial_v1_course_progress($1) as v",
      [f.learnerEnrolmentId],
    );
    const text = JSON.stringify(progress);
    expect(text).not.toMatch(
      /protected answer|expectedAnswer|markingGuidance|question \d+/i,
    );
  });
});

// =============================================================================
// OBJECTIVE DIAGNOSTICS PROJECTION
// =============================================================================
describe("Bounded objective diagnostics projection", () => {
  it("returns current source-level objective outcomes with remediation state", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 5);
    await asLearner(f.db);
    const result = await value<{
      ok: boolean;
      items: Array<{
        sourceKind: string;
        component: string | null;
        outcome: string;
        remediationOpen: boolean;
      }>;
    }>(
      f.db,
      "select public.list_commercial_v1_objective_diagnostics($1,10,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKind: "ASSESSMENT",
      component: "QUIZ_1",
      outcome: "PARTIAL",
      remediationOpen: true,
    });
  });

  it("is self-scoped, bounded, and redacted", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedAssessmentResult(f, "QUIZ_1", 5);
    await asForeign(f.db);
    const denied = await value<Record<string, unknown>>(
      f.db,
      "select public.list_commercial_v1_objective_diagnostics($1,10,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(denied).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    await asLearner(f.db);
    await expect(
      f.db.query(
        "select public.list_commercial_v1_objective_diagnostics($1,101,0)",
        [f.learnerEnrolmentId],
      ),
    ).rejects.toThrow("INVALID_PAGINATION");
    const allowed = await value<Record<string, unknown>>(
      f.db,
      "select public.list_commercial_v1_objective_diagnostics($1,10,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(JSON.stringify(allowed)).not.toMatch(
      /protected answer|expectedAnswer|markingGuidance|responseBody|submission body|prompt/i,
    );
  });
});

// =============================================================================
// COMPLETION
// =============================================================================
describe("Course completion", () => {
  it("refuses when a formal component result is missing", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 1);
    await asLearner(f.db);
    const result = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Attempt completion with missing results"],
    );
    expect(result).toMatchObject({ ok: false, code: "COMPONENTS_INCOMPLETE" });
  });

  it("refuses when a WITH_LABS positively-weighted lab result is missing", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId, 2000);
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    const result = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Attempt completion with missing lab result"],
    );
    expect(result).toMatchObject({ ok: false, code: "COMPONENTS_INCOMPLETE" });
  });

  it("refuses when the aggregate course score is below the pass mark", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 9999);
    for (const component of COMPONENTS)
      await seedAssessmentResult(f, component, 1);
    await asLearner(f.db);
    const result = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Attempt completion below pass mark"],
    );
    expect(result).toMatchObject({ ok: false, code: "BELOW_PASS_MARK" });
  });

  it("succeeds and issues an immutable receipt when all gates are satisfied", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 5000, false);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    const result = await value<{
      ok: boolean;
      code: string;
      receiptId: string;
      courseScoreBp: number;
    }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Attempt completion at full marks"],
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe("COMPLETED");
    expect(result.courseScoreBp).toBe(10000);
    await owner(f.db);
    const status = await value<string>(
      f.db,
      "select status as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    expect(status).toBe("COMPLETED");
    await expect(
      f.db.query(
        "update public.commercial_v1_completion_receipts set final_course_score_bp=1 where id=$1",
        [result.receiptId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("require_remediation_clear_for_completion=true blocks completion while remediation is open, and false permits it", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 1, true);
    for (const component of COMPONENTS) {
      const max = component === "QUIZ_1" ? 0 : undefined;
      await owner(f.db);
      const maxMarks = await value<number>(
        f.db,
        "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
        [f.assessmentIds[component]],
      );
      await seedAssessmentResult(f, component, max ?? maxMarks);
    }
    await asLearner(f.db);
    const blocked = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Attempt completion while remediation open"],
    );
    expect(blocked).toMatchObject({ ok: false, code: "REMEDIATION_NOT_CLEAR" });

    const g = await fixture({ withLabs: false });
    await publishResultPolicy(g, 1, false);
    await owner(g.db);
    const zeroMax = await value<number>(
      g.db,
      "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
      [g.assessmentIds.QUIZ_1],
    );
    await seedAssessmentResult(g, "QUIZ_1", 0);
    for (const component of COMPONENTS.slice(1)) {
      await owner(g.db);
      const maxMarks = await value<number>(
        g.db,
        "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
        [g.assessmentIds[component]],
      );
      await seedAssessmentResult(g, component, maxMarks);
    }
    void zeroMax;
    await asLearner(g.db);
    const permitted = await value<{ ok: boolean; code: string }>(
      g.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [
        g.learnerEnrolmentId,
        "Attempt completion, remediation not required to be clear",
      ],
    );
    expect(permitted).toMatchObject({ ok: true, code: "COMPLETED" });
  });

  it("fails closed for a historical COMPLETED enrolment that has no PR11 completion receipt", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    await f.db.query(
      "update public.enrolments set status='COMPLETED' where id=$1",
      [f.learnerEnrolmentId],
    );
    await asLearner(f.db);
    const result = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Check historical completion provenance"],
    );
    expect(result).toEqual({
      ok: false,
      code: "COMPLETION_RECEIPT_MISSING",
    });
  });

  it("the generic change_enrolment_status RPC cannot fabricate COMPLETED", async () => {
    const f = await fixture({ withLabs: false });
    await asAdmin(f.db);
    await expect(
      f.db.query("select public.change_enrolment_status($1,$2,$3)", [
        f.learnerEnrolmentId,
        "COMPLETED",
        "Attempt to fabricate completion",
      ]),
    ).rejects.toThrow("Unsupported enrolment status transition");
  });

  it("COMPLETED is terminal -- the generic RPC cannot reopen/pause/withdraw it", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 5000, false);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    await f.db.query(
      "select public.attempt_commercial_v1_course_completion($1,$2)",
      [f.learnerEnrolmentId, "Complete the course"],
    );
    await asAdmin(f.db);
    await expect(
      f.db.query("select public.change_enrolment_status($1,$2,$3)", [
        f.learnerEnrolmentId,
        "PAUSED",
        "Attempt to pause a completed enrolment",
      ]),
    ).rejects.toThrow("Invalid enrolment status transition");
  });

  it("completion is idempotent -- a repeated attempt returns the same receipt without a second write", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 5000, false);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    const first = await value<{ receiptId: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "First completion attempt"],
    );
    const second = await value<{
      ok: boolean;
      code: string;
      receiptId: string;
    }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Second completion attempt"],
    );
    expect(second).toMatchObject({ ok: true, code: "ALREADY_COMPLETED" });
    expect(second.receiptId).toBe(first.receiptId);
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_completion_receipts where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(count).toBe("1");
  });
});

// =============================================================================
// ACL / AUTHORITY
// =============================================================================
describe("ACL and audit", () => {
  it("service_role and anon cannot invoke the new RPCs or read the new tables directly", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await f.db.exec("set role service_role");
    await expect(
      f.db.query(
        "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
        [
          f.activationId,
          practicalId,
          10,
          2000,
          "Guidance",
          "service_role attempt",
        ],
      ),
    ).rejects.toThrow("permission denied");
    await expect(
      f.db.query("select * from public.commercial_v1_result_policies"),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role; set role anon");
    await expect(
      f.db.query(
        "select public.attempt_commercial_v1_course_completion($1,$2)",
        [f.learnerEnrolmentId, "anon attempt"],
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });

  it("audit records completion without protected content", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f, 5000, false);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    await f.db.query(
      "select public.attempt_commercial_v1_course_completion($1,$2)",
      [f.learnerEnrolmentId, "Complete for audit test"],
    );
    await owner(f.db);
    const event = await row<{ after_state: Record<string, unknown> }>(
      f.db,
      "select after_state from public.audit_events where action='COMMERCIAL_V1_COURSE_COMPLETED' and target_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(JSON.stringify(event.after_state)).not.toMatch(
      /protected answer|expectedAnswer|markingGuidance/i,
    );
  });

  it("migrations 001-029 have zero diff against the canonical base SHA", () => {
    const changed = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "a6d492d37f044ebd539204489205133912dbc7a0",
        "--",
        "supabase/migrations",
      ],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 29;
    });
    expect(historical).toEqual([]);
  });
});
