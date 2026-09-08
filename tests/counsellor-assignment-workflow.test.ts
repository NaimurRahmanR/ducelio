import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const otherLearnerId = "10000000-0000-4000-8000-000000000003";
const adminAuth = "82000000-0000-4000-8000-000000000002";
const learnerAuth = "82000000-0000-4000-8000-000000000001";

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin-assignment@example.com',now()),($2,'learner-assignment@example.com',now())",
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
});

afterAll(async () => {
  await db?.close();
});

describe("governed counsellor assignment workspace", () => {
  it("returns only staff with the COUNSELLOR role to an authorised admin", async () => {
    await asAuth(adminAuth);
    const rows = await db.query<{ user_id: string; display_name: string }>(
      "select user_id,display_name from public.list_assignable_counsellors()",
    );
    await resetRole();

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].user_id).toBe(adminId);
  });

  it("returns no assignment candidates to a learner", async () => {
    await asAuth(learnerAuth);
    const rows = await db.query(
      "select * from public.list_assignable_counsellors()",
    );
    await resetRole();
    expect(rows.rows).toEqual([]);
  });

  it("reassigns a learner while preserving the closed relationship", async () => {
    await db.query(
      "insert into public.staff_profiles(user_id,title) values($1,'Second counsellor')",
      [otherLearnerId],
    );
    await db.query(
      "insert into public.role_grants(user_id,role) values($1,'COUNSELLOR')",
      [otherLearnerId],
    );

    await asAuth(adminAuth);
    await db.query(
      "select public.assign_counsellor($1,$2,'Reviewed support reassignment')",
      [learnerId, otherLearnerId],
    );
    await resetRole();

    const rows = await db.query<{
      counsellor_id: string;
      ended_at: string | null;
    }>(
      "select counsellor_id,ended_at::text from public.counsellor_assignments where student_id=$1 order by starts_at",
      [learnerId],
    );

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].ended_at).toBeTruthy();
    expect(rows.rows[1].counsellor_id).toBe(otherLearnerId);
    expect(rows.rows[1].ended_at).toBeNull();
  });

  it("denies a learner calling the assignment RPC directly", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.assign_counsellor($1,$2,'Unauthorised reassignment')",
        [learnerId, adminId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });
});
