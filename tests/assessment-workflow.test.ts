import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "86000000-0000-4000-8000-000000000002";
const learnerAuth = "86000000-0000-4000-8000-000000000001";
const programmeId = "2a000000-0000-4000-8000-000000000001";
const versionId = "2a000000-0000-4000-8000-000000000002";
const moduleId = "3a000000-0000-4000-8000-000000000001";
const lessonId = "4a000000-0000-4000-8000-000000000001";
const cohortId = "5a000000-0000-4000-8000-000000000001";
let assessmentId: string;
let questionId: string;
let attemptId: string;

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [authId]);
  await db.exec("set role authenticated");
}

async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'assessment-admin@example.com',now()),($2,'assessment-learner@example.com',now())",
    [adminAuth, learnerAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [adminAuth, adminId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [adminId],
  );

  await db.query(
    `insert into public.programmes(id,slug,title,examination_body,qualification_name)
     values($1,'assessment-test','Assessment Test Programme','Ducelio Test Body','Assessment Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Assessment draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Assessment module',1)",
    [moduleId, versionId],
  );
  await db.query(
    `insert into public.lessons(id,module_id,programme_version_id,title,position)
     values($1,$2,$3,'Assessment lesson',1)`,
    [lessonId, moduleId, versionId],
  );
  await db.query(
    `insert into public.lesson_objectives(lesson_id,programme_version_id,description,position)
     values($1,$2,'Complete controlled assessment safely',1)`,
    [lessonId, versionId],
  );

  await asAuth(adminAuth);
  await db.query(
    "select public.publish_programme_version($1,'Assessment curriculum reviewed')",
    [versionId],
  );
  await resetRole();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Assessment cohort',current_date)",
    [cohortId, versionId],
  );
  await asAuth(adminAuth);
  await db.query(
    "select public.create_enrolment($1,$2,'Approved assessment learner')",
    [learnerId, cohortId],
  );
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("controlled assessments", () => {
  it("creates a draft with protected question content denied to learner tables", async () => {
    await asAuth(adminAuth);
    const assessment = await db.query<{ id: string }>(
      `select public.create_assessment(
        $1,$2,$3,'Access control check','Answer independently without tutor help.',
        now()-interval '1 hour',now()+interval '2 hours',60,1,'Create controlled assessment'
      ) as id`,
      [cohortId, lessonId, adminId],
    );
    assessmentId = assessment.rows[0].id;
    const question = await db.query<{ id: string }>(
      `select public.add_assessment_question(
        $1,1,'Explain least privilege.',10,'Grant only permissions required for the task.',
        'Credit accurate least-privilege reasoning.','Add protected assessment question'
      ) as id`,
      [assessmentId],
    );
    questionId = question.rows[0].id;
    await resetRole();

    await asAuth(learnerAuth);
    await expect(
      db.query("select id from public.assessment_questions where assessment_id=$1", [
        assessmentId,
      ]),
    ).rejects.toThrow("permission denied");
    await expect(
      db.query(
        "select question_id from public.assessment_answer_keys where question_id=$1",
        [questionId],
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
  });

  it("does not release questions before an active server-owned attempt", async () => {
    await asAuth(adminAuth);
    await db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Protected assessment ready')",
      [assessmentId],
    );
    await resetRole();

    await asAuth(learnerAuth);
    await expect(
      db.query("select * from public.get_active_assessment_questions($1)", [
        assessmentId,
      ]),
    ).rejects.toThrow("active attempt");
    await resetRole();
  });

  it("starts one controlled attempt and releases only prompts, never answer keys", async () => {
    await asAuth(learnerAuth);
    const attempt = await db.query<{ id: string }>(
      "select public.start_assessment_attempt($1) as id",
      [assessmentId],
    );
    attemptId = attempt.rows[0].id;
    const questions = await db.query<{
      id: string;
      position: number;
      prompt: string;
      max_marks: number;
    }>("select * from public.get_active_assessment_questions($1)", [
      assessmentId,
    ]);
    await expect(
      db.query(
        "select expected_answer from public.assessment_answer_keys where question_id=$1",
        [questionId],
      ),
    ).rejects.toThrow("permission denied");
    await resetRole();
    expect(questions.rows).toEqual([
      {
        id: questionId,
        position: 1,
        prompt: "Explain least privilege.",
        max_marks: 10,
      },
    ]);
  });

  it("blocks normal academic-help actions while the assessment is active", async () => {
    await asAuth(learnerAuth);
    const state = await db.query<{ state: string }>(
      "select public.current_academic_activity_state() as state",
    );
    const explain = await db.query<{ allowed: boolean }>(
      "select public.academic_action_allowed('EXPLAIN') as allowed",
    );
    const examiner = await db.query<{ allowed: boolean }>(
      "select public.academic_action_allowed('EXAMINER_DELIVERY') as allowed",
    );
    await expect(
      db.query("select public.assert_academic_action_allowed('GIVE_FINAL_ANSWER')"),
    ).rejects.toThrow("blocked");
    await resetRole();
    expect(state.rows[0].state).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    expect(explain.rows[0].allowed).toBe(false);
    expect(examiner.rows[0].allowed).toBe(true);
  });

  it("records idempotent append-only response revisions", async () => {
    await asAuth(learnerAuth);
    const first = await db.query<{ id: string }>(
      "select public.record_assessment_response($1,$2,'Least privilege limits permissions to what is necessary.','assessment-response-first') as id",
      [attemptId, questionId],
    );
    const replay = await db.query<{ id: string }>(
      "select public.record_assessment_response($1,$2,'Least privilege limits permissions to what is necessary.','assessment-response-first') as id",
      [attemptId, questionId],
    );
    const second = await db.query<{ id: string }>(
      "select public.record_assessment_response($1,$2,'Least privilege grants only the minimum permissions needed for an authorised task.','assessment-response-second') as id",
      [attemptId, questionId],
    );
    await resetRole();
    expect(replay.rows[0].id).toBe(first.rows[0].id);

    const revisions = await db.query<{ revision_number: number }>(
      "select revision_number from public.assessment_responses where attempt_id=$1 order by revision_number",
      [attemptId],
    );
    expect(revisions.rows.map((row) => row.revision_number)).toEqual([1, 2]);
    await expect(
      db.query("update public.assessment_responses set body='Changed' where id=$1", [
        second.rows[0].id,
      ]),
    ).rejects.toThrow("append-only");
  });

  it("submits the attempt and removes the activity firewall state", async () => {
    await asAuth(learnerAuth);
    await db.query("select public.submit_assessment_attempt($1)", [attemptId]);
    const state = await db.query<{ state: string }>(
      "select public.current_academic_activity_state() as state",
    );
    await expect(
      db.query(
        "select public.record_assessment_response($1,$2,'Late edit','assessment-response-late')",
        [attemptId, questionId],
      ),
    ).rejects.toThrow("no longer active");
    await resetRole();
    expect(state.rows[0].state).toBe("NORMAL");
  });

  it("keeps protected answer keys unreadable to the learner after submission", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select expected_answer from public.assessment_answer_keys where question_id=$1",
        [questionId],
      ),
    ).rejects.toThrow("permission denied");
    const responses = await db.query<{ revision_number: number }>(
      "select revision_number from public.assessment_responses where attempt_id=$1 order by revision_number",
      [attemptId],
    );
    await resetRole();
    expect(responses.rows).toHaveLength(2);
  });

  it("freezes published assessment questions and answer keys", async () => {
    await expect(
      db.query("update public.assessment_questions set prompt='Changed' where id=$1", [
        questionId,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(
        "update public.assessment_answer_keys set expected_answer='Changed' where question_id=$1",
        [questionId],
      ),
    ).rejects.toThrow("immutable");
  });
});
