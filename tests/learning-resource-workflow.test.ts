import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "85000000-0000-4000-8000-000000000002";
const learnerAuth = "85000000-0000-4000-8000-000000000001";
const programmeId = "25000000-0000-4000-8000-000000000001";
const versionId = "25000000-0000-4000-8000-000000000002";
const moduleId = "35000000-0000-4000-8000-000000000001";
const lessonId = "45000000-0000-4000-8000-000000000001";
const cohortId = "55000000-0000-4000-8000-000000000001";
let noteId: string;
let linkId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'resource-admin@example.com',now()),($2,'resource-learner@example.com',now())",
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
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN')",
    [adminId],
  );

  await db.query(
    `insert into public.programmes(id,slug,title,examination_body,qualification_name)
     values($1,'resource-test','Resource Test Programme','Ducelio Test Body','Resource Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Resource draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module one',1)",
    [moduleId, versionId],
  );
  await db.query(
    "insert into public.lessons(id,module_id,programme_version_id,title,position) values($1,$2,$3,'Lesson one',1)",
    [lessonId, moduleId, versionId],
  );
  await db.query(
    "insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values($1,$2,'Objective one',1)",
    [lessonId, versionId],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("governed learning resources", () => {
  it("creates lecture notes and HTTPS references on draft curriculum", async () => {
    await asAuth(adminAuth);
    const note = await db.query<{ id: string }>(
      "select public.create_learning_resource($1,'LECTURE_NOTE','Key concepts','Authentication confirms identity.',null,1,'Add reviewed lecture note') as id",
      [lessonId],
    );
    noteId = note.rows[0].id;
    const link = await db.query<{ id: string }>(
      "select public.create_learning_resource($1,'REFERENCE_LINK','External reference',null,'https://example.com/reference',2,'Add approved reference') as id",
      [lessonId],
    );
    linkId = link.rows[0].id;
    await resetRole();
    expect(noteId).toBeTruthy();
    expect(linkId).toBeTruthy();
  });

  it("rejects non-HTTPS references", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        "select public.create_learning_resource($1,'REFERENCE_LINK','Unsafe link',null,'http://example.com',3,'Reject unsafe reference')",
        [lessonId],
      ),
    ).rejects.toThrow("HTTPS URL");
    await resetRole();
  });

  it("denies learners authoring institutional resources", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.create_learning_resource($1,'LECTURE_NOTE','Self note','Learner text',null,3,'Learner authoring attempt')",
        [lessonId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("freezes resources when the curriculum is published", async () => {
    await asAuth(adminAuth);
    await db.query(
      "select public.publish_programme_version($1,'Resource curriculum reviewed')",
      [versionId],
    );
    await resetRole();
    await expect(
      db.query(
        "update public.learning_resources set title='Changed' where id=$1",
        [noteId],
      ),
    ).rejects.toThrow("immutable");
  });

  it("rejects adding resources after publication", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        "select public.create_learning_resource($1,'LECTURE_NOTE','Late note','Too late',null,3,'Late curriculum change')",
        [lessonId],
      ),
    ).rejects.toThrow("draft programme versions");
    await resetRole();
  });

  it("lets an enrolled learner read published resources through RLS", async () => {
    await db.query(
      "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Resource cohort',current_date)",
      [cohortId, versionId],
    );
    await asAuth(adminAuth);
    await db.query(
      "select public.create_enrolment($1,$2,'Approved resource learner')",
      [learnerId, cohortId],
    );
    await resetRole();

    await asAuth(learnerAuth);
    const rows = await db.query<{ title: string }>(
      "select title from public.learning_resources order by position",
    );
    await resetRole();
    expect(rows.rows.map((row) => row.title)).toEqual([
      "Key concepts",
      "External reference",
    ]);
  });
});
