import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

export const learner = "10000000-0000-4000-8000-000000000001";
export const foreignLearner = "10000000-0000-4000-8000-000000000003";
export const instructor = "10000000-0000-4000-8000-000000000002";
export const learnerAuth = "83000000-0000-4000-8000-000000000001";
export const foreignAuth = "83000000-0000-4000-8000-000000000003";
export const instructorAuth = "83000000-0000-4000-8000-000000000002";
// Seed data (supabase/seed.sql): the only enrolled student (learner) is
// bound to exactly this cohort/programme-version/lesson. foreignLearner has
// no enrolment at all -- an intentionally simple, real "foreign student"
// fixture for ownership-denial tests.
export const cohortId = "50000000-0000-4000-8000-000000000001";
export const programmeVersionId = "20000000-0000-4000-8000-000000000002";
export const lessonId = "40000000-0000-4000-8000-000000000001";
// A second cohort under the same published programme version, used only to
// prove a real-but-mismatched enrolment (a genuine enrolment for a
// DIFFERENT cohort) is denied just as a wholly foreign learner is.
export const otherCohortId = "50000000-0000-4000-8000-000000000099";

export type ClassroomFixture = Awaited<ReturnType<typeof classroomFixture>>;
export async function classroomFixture() {
  const db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  for (const [id, auth, email] of [
    [learner, learnerAuth, "classroom-learner@test.example"],
    [foreignLearner, foreignAuth, "classroom-foreign@test.example"],
    [instructor, instructorAuth, "classroom-instructor@test.example"],
  ] as const) {
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [auth, email],
    );
    await db.query(
      "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
      [auth, id],
    );
  }
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [instructor],
  );
  // Seed data already gives this user a staff_profiles row (as a
  // COUNSELLOR); no separate insert is needed or safe here.
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Second DEMO cohort','2026-09-01')",
    [otherCohortId, programmeVersionId],
  );
  return { db };
}

export async function asClassroomUser(db: PGlite, auth: string | null) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    auth ?? "",
  ]);
  await db.exec("set role authenticated");
}

export async function scheduleClassSession(
  db: PGlite,
  scheduledStart: string,
  scheduledEnd: string,
  reason = "Classroom fixture session",
) {
  await asClassroomUser(db, instructorAuth);
  const result = await db.query<{ id: string }>(
    "select public.create_class_session($1,$2,$3,$4,$5,$6) as id",
    [cohortId, lessonId, instructor, scheduledStart, scheduledEnd, reason],
  );
  return result.rows[0].id;
}
