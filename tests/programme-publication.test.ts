import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const studentId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "81000000-0000-4000-8000-000000000002";
const studentAuth = "81000000-0000-4000-8000-000000000001";
const programmeId = "21000000-0000-4000-8000-000000000001";
const completeVersionId = "21000000-0000-4000-8000-000000000002";
const emptyVersionId = "21000000-0000-4000-8000-000000000003";

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.com',now()),($2,'student@example.com',now())",
    [adminAuth, studentAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [adminAuth, adminId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [studentAuth, studentId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN')",
    [adminId],
  );

  await db.query(
    `insert into public.programmes(id,slug,title,examination_body,qualification_name)
     values($1,'phase-two-test','Phase Two Test Programme','Ducelio Test Body','Test Qualification')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Complete draft'),($3,$2,'Empty draft')",
    [completeVersionId, programmeId, emptyVersionId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values('31000000-0000-4000-8000-000000000001',$1,'Module one',1)",
    [completeVersionId],
  );
  await db.query(
    "insert into public.lessons(id,module_id,programme_version_id,title,position) values('41000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',$1,'Lesson one',1)",
    [completeVersionId],
  );
  await db.query(
    "insert into public.lesson_objectives(id,lesson_id,programme_version_id,description,position) values('42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',$1,'Demonstrate the test objective',1)",
    [completeVersionId],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("governed programme publication", () => {
  it("rejects publication of an incomplete draft", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query("select public.publish_programme_version($1,'Reviewed for release')", [
        emptyVersionId,
      ]),
    ).rejects.toThrow("at least one module");
    await resetRole();
  });

  it("denies publication to a student", async () => {
    await asAuth(studentAuth);
    await expect(
      db.query("select public.publish_programme_version($1,'Attempted release')", [
        completeVersionId,
      ]),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("publishes a complete version with immutable metadata snapshots", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      "select public.publish_programme_version($1,'Curriculum reviewed and approved') as id",
      [completeVersionId],
    );
    expect(result.rows[0].id).toBe(completeVersionId);
    await resetRole();

    const version = await db.query<{
      status: string;
      title_snapshot: string;
      examination_body_snapshot: string;
      qualification_name_snapshot: string;
      published_at: string;
      published_by: string;
    }>(
      `select status,title_snapshot,examination_body_snapshot,qualification_name_snapshot,
              published_at::text,published_by
       from public.programme_versions where id=$1`,
      [completeVersionId],
    );

    expect(version.rows[0].status).toBe("PUBLISHED");
    expect(version.rows[0].title_snapshot).toBe("Phase Two Test Programme");
    expect(version.rows[0].examination_body_snapshot).toBe("Ducelio Test Body");
    expect(version.rows[0].qualification_name_snapshot).toBe("Test Qualification");
    expect(version.rows[0].published_at).toBeTruthy();
    expect(version.rows[0].published_by).toBe(adminId);

    await db.query("update public.programmes set title='Renamed programme' where id=$1", [
      programmeId,
    ]);
    const snapshot = await db.query<{ title_snapshot: string }>(
      "select title_snapshot from public.programme_versions where id=$1",
      [completeVersionId],
    );
    expect(snapshot.rows[0].title_snapshot).toBe("Phase Two Test Programme");
  });

  it("keeps published curriculum content immutable", async () => {
    await expect(
      db.query("update public.lesson_objectives set description='Changed' where programme_version_id=$1", [
        completeVersionId,
      ]),
    ).rejects.toThrow("immutable");
  });
});
