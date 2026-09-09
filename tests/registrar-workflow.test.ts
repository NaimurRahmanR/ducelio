import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const learnerId = "10000000-0000-4000-8000-000000000001";
const registrarId = "10000000-0000-4000-8000-000000000002";
const registrarAuth = "85000000-0000-4000-8000-000000000001";
const academicAdminId = "15000000-0000-4000-8000-000000000001";
const academicAdminAuth = "85000000-0000-4000-8000-000000000002";
const cohortId = "50000000-0000-4000-8000-000000000001";
const lessonId = "40000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let sessionId: string;
let attendanceId: string;
let firstCorrectionId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'registrar@example.com',now()),($2,'academic-admin@example.com',now())",
    [registrarAuth, academicAdminAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [registrarAuth, registrarId],
  );
  await db.query(
    `insert into public.app_users(id,auth_user_id,display_name,is_demo)
     values($1,$2,'Academic Admin',false)`,
    [academicAdminId, academicAdminAuth],
  );
  await db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Academic administrator')",
    [academicAdminId],
  );
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'REGISTRAR'),($2,'ACADEMIC_ADMIN'),($2,'INSTRUCTOR')",
    [registrarId, academicAdminId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");

  const enrolment = await db.query<{ id: string }>(
    "select id from public.enrolments where student_id=$1 and cohort_id=$2",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;

  await asAuth(academicAdminAuth);
  const session = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Create registrar test session'
    ) as id`,
    [cohortId, lessonId, academicAdminId],
  );
  sessionId = session.rows[0].id;
  const attendance = await db.query<{ id: string }>(
    "select public.record_attendance($1,$2,'PRESENT','Initial attendance record') as id",
    [sessionId, enrolmentId],
  );
  attendanceId = attendance.rows[0].id;
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("governed registrar corrections", () => {
  it("records an enrolment correction with immutable before and after values", async () => {
    await asAuth(registrarAuth);
    const result = await db.query<{ id: string }>(
      "select public.registrar_correct_enrolment_status($1,'PAUSED','Correct administrative enrolment status') as id",
      [enrolmentId],
    );
    firstCorrectionId = result.rows[0].id;

    const correction = await db.query<{
      correction_kind: string;
      before_value: string;
      after_value: string;
      corrected_by: string;
    }>(
      "select correction_kind,before_value,after_value,corrected_by from public.registrar_corrections where id=$1",
      [firstCorrectionId],
    );
    await resetRole();

    expect(correction.rows[0]).toEqual({
      correction_kind: "ENROLMENT_STATUS",
      before_value: "ACTIVE",
      after_value: "PAUSED",
      corrected_by: registrarId,
    });
  });

  it("updates the authoritative enrolment while preserving correction history", async () => {
    const current = await db.query<{ status: string }>(
      "select status from public.enrolments where id=$1",
      [enrolmentId],
    );
    expect(current.rows[0].status).toBe("PAUSED");

    await asAuth(registrarAuth);
    await db.query(
      "select public.registrar_correct_enrolment_status($1,'ACTIVE','Restore corrected active status')",
      [enrolmentId],
    );
    const history = await db.query<{
      before_value: string;
      after_value: string;
    }>(
      "select before_value,after_value from public.registrar_corrections where enrolment_id=$1 order by corrected_at,id",
      [enrolmentId],
    );
    await resetRole();

    expect(history.rows).toHaveLength(2);
    expect(history.rows[0]).toEqual({
      before_value: "ACTIVE",
      after_value: "PAUSED",
    });
    expect(history.rows[1]).toEqual({
      before_value: "PAUSED",
      after_value: "ACTIVE",
    });
  });

  it("records an attendance correction without replacing record identity", async () => {
    await asAuth(registrarAuth);
    const correction = await db.query<{ id: string }>(
      "select public.registrar_correct_attendance_status($1,'EXCUSED','Approved documented attendance correction') as id",
      [attendanceId],
    );
    const current = await db.query<{
      id: string;
      status: string;
      updated_by: string;
    }>(
      "select id,status,updated_by from public.attendance_records where id=$1",
      [attendanceId],
    );
    const history = await db.query<{
      before_value: string;
      after_value: string;
    }>(
      "select before_value,after_value from public.registrar_corrections where id=$1",
      [correction.rows[0].id],
    );
    await resetRole();

    expect(current.rows[0]).toEqual({
      id: attendanceId,
      status: "EXCUSED",
      updated_by: registrarId,
    });
    expect(history.rows[0]).toEqual({
      before_value: "PRESENT",
      after_value: "EXCUSED",
    });
  });

  it("prevents registrar-only actors from bypassing the enrolment correction ledger", async () => {
    await asAuth(registrarAuth);
    await expect(
      db.query(
        "select public.change_enrolment_status($1,'PAUSED','Attempt generic registrar status mutation')",
        [enrolmentId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("prevents registrar-only actors from using the ordinary attendance service", async () => {
    await asAuth(registrarAuth);
    await expect(
      db.query(
        "select public.record_attendance($1,$2,'LATE','Attempt ordinary attendance mutation')",
        [sessionId, enrolmentId],
      ),
    ).rejects.toThrow(
      "Registrar role cannot perform academic operational mutations",
    );
    await resetRole();
  });

  it("does not give the registrar class-scheduling authority", async () => {
    await asAuth(registrarAuth);
    await expect(
      db.query(
        `select public.create_class_session(
          $1,$2,$3,now()+interval '1 day',now()+interval '2 days','Attempt registrar scheduling'
        )`,
        [cohortId, lessonId, academicAdminId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("denies an academic administrator who lacks registrar/platform authority", async () => {
    await asAuth(academicAdminAuth);
    await expect(
      db.query(
        "select public.registrar_correct_attendance_status($1,'ABSENT','Attempt non-registrar correction')",
        [attendanceId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("keeps registrar correction history append-only", async () => {
    await expect(
      db.query(
        "update public.registrar_corrections set reason='Changed history' where id=$1",
        [firstCorrectionId],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      db.query("delete from public.registrar_corrections where id=$1", [
        firstCorrectionId,
      ]),
    ).rejects.toThrow("append-only");
  });
});
