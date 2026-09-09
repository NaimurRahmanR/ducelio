import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "84000000-0000-4000-8000-000000000002";
const learnerAuth = "84000000-0000-4000-8000-000000000001";
const programmeId = "24000000-0000-4000-8000-000000000001";
const versionId = "24000000-0000-4000-8000-000000000002";
const moduleId = "34000000-0000-4000-8000-000000000001";
const lessonId = "44000000-0000-4000-8000-000000000001";
const otherLessonId = "44000000-0000-4000-8000-000000000002";
const cohortId = "54000000-0000-4000-8000-000000000001";
let segmentId: string;
let otherSegmentId: string;
let enrolmentId: string;
let sessionId: string;

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId,
  ]);
  await db.exec("set role authenticated");
}

async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'progress-admin@example.com',now()),($2,'progress-learner@example.com',now())",
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
     values($1,'progress-test','Progress Test Programme','Ducelio Test Body','Progress Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Progress draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module one',1)",
    [moduleId, versionId],
  );
  await db.query(
    `insert into public.lessons(id,module_id,programme_version_id,title,position)
     values($1,$2,$3,'Lesson one',1),($4,$2,$3,'Lesson two',2)`,
    [lessonId, moduleId, versionId, otherLessonId],
  );
  await db.query(
    `insert into public.lesson_objectives(lesson_id,programme_version_id,description,position)
     values($1,$3,'Objective one',1),($2,$3,'Objective two',1)`,
    [lessonId, otherLessonId, versionId],
  );

  await asAuth(adminAuth);
  const first = await db.query<{ id: string }>(
    "select public.create_lesson_segment($1,'Concept explanation',1,'Planned teaching sequence') as id",
    [lessonId],
  );
  segmentId = first.rows[0].id;
  const second = await db.query<{ id: string }>(
    "select public.create_lesson_segment($1,'Other lesson segment',1,'Planned teaching sequence') as id",
    [otherLessonId],
  );
  otherSegmentId = second.rows[0].id;
  await db.query(
    "select public.publish_programme_version($1,'Progress curriculum reviewed')",
    [versionId],
  );
  await resetRole();

  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Progress cohort',current_date)",
    [cohortId, versionId],
  );

  await asAuth(adminAuth);
  const enrolment = await db.query<{ id: string }>(
    "select public.create_enrolment($1,$2,'Approved progress learner') as id",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;
  const session = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Scheduled progress class'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  sessionId = session.rows[0].id;
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("governed lesson progress", () => {
  it("freezes planned segments after programme publication", async () => {
    await expect(
      db.query(
        "update public.lesson_segments set title='Changed' where id=$1",
        [segmentId],
      ),
    ).rejects.toThrow("immutable");
  });

  it("records planned-segment progress through an authorised instructor", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      "select public.record_lesson_progress($1,$2,$3,'IN_PROGRESS','Teaching progress recorded') as id",
      [sessionId, enrolmentId, segmentId],
    );
    expect(result.rows[0].id).toBeTruthy();
    await resetRole();
  });

  it("supports an audited correction without changing progress identity", async () => {
    await asAuth(adminAuth);
    const before = await db.query<{ id: string }>(
      "select id from public.lesson_progress where enrolment_id=$1 and segment_id=$2",
      [enrolmentId, segmentId],
    );
    const result = await db.query<{ id: string }>(
      "select public.record_lesson_progress($1,$2,$3,'COMPLETED','Segment completion confirmed') as id",
      [sessionId, enrolmentId, segmentId],
    );
    await resetRole();
    expect(result.rows[0].id).toBe(before.rows[0].id);
    const row = await db.query<{ status: string }>(
      "select status from public.lesson_progress where id=$1",
      [before.rows[0].id],
    );
    expect(row.rows[0].status).toBe("COMPLETED");
  });

  it("rejects a segment from a different lesson", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        "select public.record_lesson_progress($1,$2,$3,'COMPLETED','Wrong lesson attempt')",
        [sessionId, enrolmentId, otherSegmentId],
      ),
    ).rejects.toThrow("class session lesson");
    await resetRole();
  });

  it("denies a learner recording their own authoritative progress", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.record_lesson_progress($1,$2,$3,'COMPLETED','Self completion attempt')",
        [sessionId, enrolmentId, segmentId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("lets a learner read their own progress through RLS", async () => {
    await asAuth(learnerAuth);
    const rows = await db.query<{ status: string }>(
      "select status from public.lesson_progress where enrolment_id=$1",
      [enrolmentId],
    );
    await resetRole();
    expect(rows.rows.map((row) => row.status)).toContain("COMPLETED");
  });
});
