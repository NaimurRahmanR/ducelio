import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const otherLearnerId = "10000000-0000-4000-8000-000000000003";
const adminAuth = "84000000-0000-4000-8000-000000000002";
const learnerAuth = "84000000-0000-4000-8000-000000000001";
const cohortId = "50000000-0000-4000-8000-000000000001";
const lessonId = "40000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let pastSessionId: string;
let futureSessionId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'attendance-admin@example.com',now()),($2,'attendance-learner@example.com',now())",
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

  enrolmentId = (
    await db.query<{ id: string }>(
      "select id from public.enrolments where student_id=$1 and cohort_id=$2",
      [learnerId, cohortId],
    )
  ).rows[0].id;

  await asAuth(adminAuth);
  pastSessionId = (
    await db.query<{ id: string }>(
      "select public.create_class_session($1,$2,$3,'2026-01-05T18:00:00Z','2026-01-05T19:00:00Z','Attendance test session') as id",
      [cohortId, lessonId, adminId],
    )
  ).rows[0].id;
  futureSessionId = (
    await db.query<{ id: string }>(
      "select public.create_class_session($1,$2,$3,'2099-01-05T18:00:00Z','2099-01-05T19:00:00Z','Future attendance test') as id",
      [cohortId, lessonId, adminId],
    )
  ).rows[0].id;
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("governed attendance records", () => {
  it("records attendance only after the session starts and audits the record", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      "select public.record_attendance($1,$2,'PRESENT','Confirmed from class register') as id",
      [pastSessionId, enrolmentId],
    );
    await resetRole();

    const row = await db.query<{ status: string; student_id: string }>(
      "select status,student_id from public.attendance_records where id=$1",
      [result.rows[0].id],
    );
    expect(row.rows[0]).toEqual({ status: "PRESENT", student_id: learnerId });

    const audit = await db.query(
      "select * from public.audit_events where target_id=$1 and target_type='attendance_records'",
      [result.rows[0].id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("corrects attendance in place while preserving one authoritative record", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      "select public.record_attendance($1,$2,'LATE','Register correction after review') as id",
      [pastSessionId, enrolmentId],
    );
    await resetRole();

    const rows = await db.query<{ id: string; status: string }>(
      "select id,status from public.attendance_records where session_id=$1 and enrolment_id=$2",
      [pastSessionId, enrolmentId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ id: result.rows[0].id, status: "LATE" });
  });

  it("denies a learner calling the attendance RPC directly", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.record_attendance($1,$2,'PRESENT','Learner self report')",
        [pastSessionId, enrolmentId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("does not allow attendance to be recorded before a future class starts", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        "select public.record_attendance($1,$2,'PRESENT','Premature attendance entry')",
        [futureSessionId, enrolmentId],
      ),
    ).rejects.toThrow("before the class session starts");
    await resetRole();
  });

  it("rejects an enrolment from a different cohort", async () => {
    const otherCohortId = "50000000-0000-4000-8000-000000000099";
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,'20000000-0000-4000-8000-000000000002','Other attendance cohort','2026-01-01')",
      [otherCohortId],
    );
    await asAuth(adminAuth);
    const otherEnrolment = await db.query<{ id: string }>(
      "select public.create_enrolment($1,$2,'Attendance cohort test') as id",
      [otherLearnerId, otherCohortId],
    );
    await expect(
      db.query(
        "select public.record_attendance($1,$2,'ABSENT','Wrong cohort test entry')",
        [pastSessionId, otherEnrolment.rows[0].id],
      ),
    ).rejects.toThrow("must belong to the class session cohort");
    await resetRole();
  });

  it("prevents deleting attendance history", async () => {
    await expect(
      db.query(
        "delete from public.attendance_records where session_id=$1 and enrolment_id=$2",
        [pastSessionId, enrolmentId],
      ),
    ).rejects.toThrow("immutable");
  });
});
