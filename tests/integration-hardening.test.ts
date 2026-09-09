import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const learnerId = "10000000-0000-4000-8000-000000000001";
const otherLearnerId = "10000000-0000-4000-8000-000000000003";
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerAuth = "88000000-0000-4000-8000-000000000001";
const adminAuth = "88000000-0000-4000-8000-000000000002";
const versionId = "20000000-0000-4000-8000-000000000002";
const cohortId = "50000000-0000-4000-8000-000000000001";
const lessonId = "40000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let sessionId: string;
let assessmentId: string;
let questionId: string;
let secondAttemptId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'hardening-learner@example.com',now()),($2,'hardening-admin@example.com',now())",
    [learnerAuth, adminAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [adminAuth, adminId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [adminId],
  );
  const existing = await db.query<{ id: string }>(
    "select id from public.enrolments where student_id=$1 and cohort_id=$2",
    [learnerId, cohortId],
  );
  enrolmentId = existing.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("phase 2 integration hardening", () => {
  it("keeps an existing active enrolment idempotent but rejects duplicate creation over paused history", async () => {
    await asAuth(adminAuth);
    const replay = await db.query<{ id: string }>(
      "select public.create_enrolment($1,$2,'Confirm existing active enrolment') as id",
      [learnerId, cohortId],
    );
    expect(replay.rows[0].id).toBe(enrolmentId);

    await db.query(
      "select public.change_enrolment_status($1,'PAUSED','Pause for hardening test')",
      [enrolmentId],
    );
    await expect(
      db.query(
        "select public.create_enrolment($1,$2,'Attempt duplicate paused enrolment')",
        [learnerId, cohortId],
      ),
    ).rejects.toThrow("PAUSED");
    await db.query(
      "select public.change_enrolment_status($1,'ACTIVE','Restore after hardening test')",
      [enrolmentId],
    );
    await resetRole();
  });

  it("returns a safe learner timetable projection with instructor identity", async () => {
    await asAuth(adminAuth);
    const created = await db.query<{ id: string }>(
      `select public.create_class_session(
        $1,$2,$3,now()+interval '1 day',now()+interval '1 day 1 hour',
        'Create hardening projection session'
      ) as id`,
      [cohortId, lessonId, adminId],
    );
    sessionId = created.rows[0].id;
    await resetRole();

    await asAuth(learnerAuth);
    const rows = await db.query<{
      id: string;
      instructor_name: string;
      instructor_title: string;
      lesson_title: string;
    }>(
      "select id,instructor_name,instructor_title,lesson_title from public.list_my_class_sessions() where id=$1",
      [sessionId],
    );
    await resetRole();

    expect(rows.rows[0]).toEqual({
      id: sessionId,
      instructor_name: "Sarah Mitchell",
      instructor_title: "Learner success counsellor",
      lesson_title: "Access Control Fundamentals — DEMO",
    });
  });

  it("continues assessment attempt numbering after an administrative void", async () => {
    await asAuth(adminAuth);
    const assessment = await db.query<{ id: string }>(
      `select public.create_assessment(
        $1,$2,$3,'Hardening controlled assessment','Answer independently.',
        now()-interval '1 hour',now()+interval '4 hours',60,2,
        'Create hardening assessment'
      ) as id`,
      [cohortId, lessonId, adminId],
    );
    assessmentId = assessment.rows[0].id;
    const question = await db.query<{ id: string }>(
      `select public.add_assessment_question(
        $1,1,'Explain authentication.',10,'Authentication verifies identity.',null,
        'Add hardening question'
      ) as id`,
      [assessmentId],
    );
    questionId = question.rows[0].id;
    await db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Publish hardening assessment')",
      [assessmentId],
    );
    await resetRole();

    await asAuth(learnerAuth);
    const first = await db.query<{ id: string }>(
      "select public.start_assessment_attempt($1) as id",
      [assessmentId],
    );
    await resetRole();

    await asAuth(adminAuth);
    await db.query(
      "select public.void_assessment_attempt($1,'Void first hardening attempt')",
      [first.rows[0].id],
    );
    await resetRole();

    await asAuth(learnerAuth);
    const second = await db.query<{ id: string }>(
      "select public.start_assessment_attempt($1) as id",
      [assessmentId],
    );
    secondAttemptId = second.rows[0].id;
    await resetRole();

    const attempt = await db.query<{ attempt_number: number }>(
      "select attempt_number from public.assessment_attempts where id=$1",
      [secondAttemptId],
    );
    expect(attempt.rows[0].attempt_number).toBe(2);
  });

  it("binds assessment response student and assessment identity to its attempt", async () => {
    await expect(
      db.query(
        `insert into public.assessment_responses(
          attempt_id,question_id,assessment_id,student_id,revision_number,body,idempotency_key
        ) values($1,$2,$3,$4,1,'Forged response identity','hardening-forged-response')`,
        [secondAttemptId, questionId, assessmentId, otherLearnerId],
      ),
    ).rejects.toThrow();
  });

  it("keeps large lecture-note content out of generic audit payloads", async () => {
    const programmeId = "2f000000-0000-4000-8000-000000000001";
    const draftVersionId = "2f000000-0000-4000-8000-000000000002";
    const moduleId = "3f000000-0000-4000-8000-000000000001";
    const draftLessonId = "4f000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into public.programmes(id,slug,title,examination_body,qualification_name)
       values($1,'hardening-resource','Hardening Resource Programme','Ducelio','Hardening')`,
      [programmeId],
    );
    await db.query(
      "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Hardening draft')",
      [draftVersionId, programmeId],
    );
    await db.query(
      "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Hardening module',1)",
      [moduleId, draftVersionId],
    );
    await db.query(
      `insert into public.lessons(id,module_id,programme_version_id,title,position)
       values($1,$2,$3,'Hardening lesson',1)`,
      [draftLessonId, moduleId, draftVersionId],
    );

    await asAuth(adminAuth);
    const resource = await db.query<{ id: string }>(
      `select public.create_learning_resource(
        $1,'LECTURE_NOTE','Hardening note','Sensitive-sized learning content',null,1,
        'Create hardening resource'
      ) as id`,
      [draftLessonId],
    );
    await resetRole();

    const audit = await db.query<{ title: string; body: string | null }>(
      `select after_state->>'title' as title,after_state->>'body' as body
       from public.audit_events
       where target_type='learning_resources' and target_id=$1
       order by occurred_at desc limit 1`,
      [resource.rows[0].id],
    );
    expect(audit.rows[0]).toEqual({ title: "Hardening note", body: null });
  });

  it("rejects a cross-cohort instructor overlap after the concurrency hardening", async () => {
    const secondCohortId = "5f000000-0000-4000-8000-000000000001";
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Hardening second cohort',current_date)",
      [secondCohortId, versionId],
    );

    await asAuth(adminAuth);
    await expect(
      db.query(
        `select public.create_class_session(
          $1,$2,$3,now()+interval '1 day 30 minutes',now()+interval '1 day 2 hours',
          'Attempt overlapping instructor session'
        )`,
        [secondCohortId, lessonId, adminId],
      ),
    ).rejects.toThrow("Instructor already has an overlapping class session");
    await resetRole();
  });
});
