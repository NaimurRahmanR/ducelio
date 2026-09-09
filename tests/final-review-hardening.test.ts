import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminId = "10000000-0000-4000-8000-000000000002";
const instructorId = "17000000-0000-4000-8000-000000000001";
const learnerAuth = "89000000-0000-4000-8000-000000000001";
const adminAuth = "89000000-0000-4000-8000-000000000002";
const instructorAuth = "89000000-0000-4000-8000-000000000003";
const cohortId = "50000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000002";
const lessonId = "40000000-0000-4000-8000-000000000001";
let enrolmentId: string;

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
    `insert into auth.users(id,email,email_confirmed_at)
     values($1,'final-review-learner@example.com',now()),
           ($2,'final-review-admin@example.com',now()),
           ($3,'final-review-instructor@example.com',now())`,
    [learnerAuth, adminAuth, instructorAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [adminAuth, adminId],
  );
  await db.query(
    `insert into public.app_users(id,auth_user_id,display_name,is_demo)
     values($1,$2,'Final Review Instructor',false)`,
    [instructorId, instructorAuth],
  );
  await db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Instructor')",
    [instructorId],
  );
  await db.query(
    `insert into public.role_grants(user_id,role)
     values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR'),($2,'INSTRUCTOR')`,
    [adminId, instructorId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");

  const enrolment = await db.query<{ id: string }>(
    "select id from public.enrolments where student_id=$1 and cohort_id=$2",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("final Phase 2 review hardening", () => {
  it("requires an explicit class-session relationship before an instructor can self-author coursework or assessments", async () => {
    await asAuth(instructorAuth);
    await expect(
      db.query(
        `select public.create_assignment(
          $1,$2,$3,'Unassigned coursework','Should not be authorised.',
          now()+interval '1 day',now()+interval '2 days','Attempt unassigned coursework authoring'
        )`,
        [cohortId, lessonId, instructorId],
      ),
    ).rejects.toThrow("assigned class session");
    await expect(
      db.query(
        `select public.create_assessment(
          $1,$2,$3,'Unassigned assessment','Should not be authorised.',
          now()+interval '1 day',now()+interval '2 days',30,1,
          'Attempt unassigned assessment authoring'
        )`,
        [cohortId, lessonId, instructorId],
      ),
    ).rejects.toThrow("assigned class session");
    await resetRole();

    await asAuth(adminAuth);
    await db.query(
      `select public.create_class_session(
        $1,$2,$3,now()+interval '30 days',now()+interval '30 days 1 hour',
        'Assign instructor for final review'
      )`,
      [cohortId, lessonId, instructorId],
    );
    await resetRole();

    await asAuth(instructorAuth);
    const assignment = await db.query<{ id: string }>(
      `select public.create_assignment(
        $1,$2,$3,'Assigned coursework','Authoring is now relationship scoped.',
        now()+interval '1 day',now()+interval '2 days','Create assigned coursework'
      ) as id`,
      [cohortId, lessonId, instructorId],
    );
    const assessment = await db.query<{ id: string }>(
      `select public.create_assessment(
        $1,$2,$3,'Assigned assessment','Authoring is now relationship scoped.',
        now()+interval '1 day',now()+interval '2 days',30,1,
        'Create assigned assessment'
      ) as id`,
      [cohortId, lessonId, instructorId],
    );
    await resetRole();

    expect(assignment.rows[0].id).toBeTruthy();
    expect(assessment.rows[0].id).toBeTruthy();
  });

  it("keeps support-only notification detail outside Academic Admin reads", async () => {
    const followupId = "6f000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into public.support_followups(
        id,student_id,event_id,title,due_on,status,created_by
      ) values($1,$2,null,'Sensitive counsellor follow-up title',current_date,'OPEN',$3)`,
      [followupId, learnerId, adminId],
    );

    await asAuth(adminAuth);
    await db.query(
      "select public.refresh_deterministic_support_triggers('Final review privacy scan')",
    );
    const adminView = await db.query(
      `select id from public.institutional_notifications
       where source_type='SUPPORT_FOLLOWUP' and source_id=$1`,
      [followupId],
    );
    await resetRole();
    expect(adminView.rows).toHaveLength(0);

    await asAuth(learnerAuth);
    const learnerView = await db.query<{ title: string; kind: string }>(
      `select title,kind from public.institutional_notifications
       where source_type='SUPPORT_FOLLOWUP' and source_id=$1`,
      [followupId],
    );
    await resetRole();

    expect(learnerView.rows).toEqual([
      { title: "Learner-support follow-up", kind: "SUPPORT_FOLLOWUP" },
    ]);
  });

  it("finalises an expired ACTIVE attempt before starting the next allowed attempt", async () => {
    await asAuth(adminAuth);
    const assessment = await db.query<{ id: string }>(
      `select public.create_assessment(
        $1,$2,$3,'Expiry lifecycle assessment','Test deterministic expiry handling.',
        now()-interval '1 hour',now()+interval '4 hours',60,2,
        'Create expiry lifecycle assessment'
      ) as id`,
      [cohortId, lessonId, adminId],
    );
    const assessmentId = assessment.rows[0].id;
    await db.query(
      `select public.add_assessment_question(
        $1,1,'Explain least privilege.',10,'Grant only required permissions.',null,
        'Add expiry lifecycle question'
      )`,
      [assessmentId],
    );
    await db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Publish expiry lifecycle assessment')",
      [assessmentId],
    );
    await resetRole();

    const expired = await db.query<{ id: string }>(
      `insert into public.assessment_attempts(
        assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,
        attempt_number,state,started_at,expires_at
      ) values(
        $1,$2,$3,$4,$5,1,'ACTIVE',now()-interval '2 hours',now()-interval '1 hour'
      ) returning id`,
      [assessmentId, enrolmentId, learnerId, cohortId, versionId],
    );

    await asAuth(learnerAuth);
    const next = await db.query<{ id: string }>(
      "select public.start_assessment_attempt($1) as id",
      [assessmentId],
    );
    const states = await db.query<{
      id: string;
      state: string;
      attempt_number: number;
      submitted_at: string | null;
    }>(
      `select id,state,attempt_number,submitted_at
       from public.assessment_attempts
       where id in ($1,$2)
       order by attempt_number`,
      [expired.rows[0].id, next.rows[0].id],
    );
    await db.query("select public.submit_assessment_attempt($1)", [
      next.rows[0].id,
    ]);
    await resetRole();

    expect(states.rows[0].state).toBe("SUBMITTED");
    expect(states.rows[0].attempt_number).toBe(1);
    expect(states.rows[0].submitted_at).not.toBeNull();
    expect(states.rows[1].state).toBe("ACTIVE");
    expect(states.rows[1].attempt_number).toBe(2);
  });
});
