import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const learnerId = "10000000-0000-4000-8000-000000000001";
const instructorId = "10000000-0000-4000-8000-000000000002";
const otherLearnerId = "10000000-0000-4000-8000-000000000003";
const learnerAuth = "83000000-0000-4000-8000-000000000001";
const instructorAuth = "83000000-0000-4000-8000-000000000002";
const otherAuth = "83000000-0000-4000-8000-000000000003";
const cohortId = "50000000-0000-4000-8000-000000000001";
const lessonId = "40000000-0000-4000-8000-000000000001";

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'session-learner@example.com',now()),($2,'session-instructor@example.com',now()),($3,'session-other@example.com',now())",
    [learnerAuth, instructorAuth, otherAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [instructorAuth, instructorId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [otherAuth, otherLearnerId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [instructorId],
  );
});

afterEach(async () => {
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("governed class sessions", () => {
  it("lists only eligible instructors to an authorised administrator", async () => {
    await asAuth(instructorAuth);
    const rows = await db.query<{ user_id: string }>(
      "select user_id from public.list_assignable_instructors()",
    );
    expect(rows.rows.map((row) => row.user_id)).toContain(instructorId);
  });

  it("schedules a session for a published cohort and matching lesson", async () => {
    await asAuth(instructorAuth);
    const result = await db.query<{ id: string }>(
      `select public.create_class_session(
        $1,$2,$3,
        '2026-09-20T18:00:00Z','2026-09-20T19:00:00Z',
        'Approved academy timetable'
      ) as id`,
      [cohortId, lessonId, instructorId],
    );
    expect(result.rows[0].id).toBeTruthy();
  });

  it("rejects overlapping sessions for the same cohort or instructor", async () => {
    await asAuth(instructorAuth);
    await expect(
      db.query(
        `select public.create_class_session(
          $1,$2,$3,
          '2026-09-20T18:30:00Z','2026-09-20T19:30:00Z',
          'Conflicting academy timetable'
        )`,
        [cohortId, lessonId, instructorId],
      ),
    ).rejects.toThrow("overlapping");
  });

  it("allows an enrolled learner to read their cohort session but hides it from another learner", async () => {
    await asAuth(learnerAuth);
    expect((await db.query("select * from public.class_sessions")).rows).toHaveLength(1);
    await resetRole();
    await asAuth(otherAuth);
    expect((await db.query("select * from public.class_sessions")).rows).toHaveLength(0);
  });

  it("denies a learner calling the scheduling RPC directly", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        `select public.create_class_session(
          $1,$2,$3,
          '2026-09-21T18:00:00Z','2026-09-21T19:00:00Z',
          'Unauthorised scheduling attempt'
        )`,
        [cohortId, lessonId, instructorId],
      ),
    ).rejects.toThrow("Access denied");
  });

  it("cancels a scheduled session while preserving its schedule history", async () => {
    await resetRole();
    const session = await db.query<{ id: string }>(
      "select id from public.class_sessions limit 1",
    );
    await asAuth(instructorAuth);
    await db.query(
      "select public.change_class_session_status($1,'CANCELLED','Timetable change approved')",
      [session.rows[0].id],
    );
    await resetRole();
    const row = await db.query<{ status: string }>(
      "select status from public.class_sessions where id=$1",
      [session.rows[0].id],
    );
    expect(row.rows[0].status).toBe("CANCELLED");
    await expect(
      db.query(
        "update public.class_sessions set scheduled_start='2026-09-20T17:00:00Z' where id=$1",
        [session.rows[0].id],
      ),
    ).rejects.toThrow("immutable");
  });
});
