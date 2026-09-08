import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const registrarId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000003";
const registrarAuth = "82000000-0000-4000-8000-000000000002";
const learnerAuth = "82000000-0000-4000-8000-000000000003";
const publishedVersionId = "20000000-0000-4000-8000-000000000002";
const cohortId = "52000000-0000-4000-8000-000000000002";
const draftVersionId = "22000000-0000-4000-8000-000000000003";
const draftCohortId = "52000000-0000-4000-8000-000000000003";

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'registrar@example.com',now()),($2,'learner@example.com',now())",
    [registrarAuth, learnerAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [registrarAuth, registrarId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'REGISTRAR')",
    [registrarId],
  );
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'October 2026 cohort','2026-10-01')",
    [cohortId, publishedVersionId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,'20000000-0000-4000-8000-000000000001','Draft enrolment test')",
    [draftVersionId],
  );
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Draft cohort','2026-11-01')",
    [draftCohortId, draftVersionId],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("governed enrolment workflow", () => {
  it("denies a learner creating their own enrolment", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.create_enrolment($1,$2,'Self enrolment attempt')",
        [learnerId, cohortId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("rejects enrolment into a draft curriculum", async () => {
    await asAuth(registrarAuth);
    await expect(
      db.query(
        "select public.create_enrolment($1,$2,'Approved registration')",
        [learnerId, draftCohortId],
      ),
    ).rejects.toThrow("published");
    await resetRole();
  });

  it("creates an audited enrolment with preserved cohort history", async () => {
    await asAuth(registrarAuth);
    const result = await db.query<{ id: string }>(
      "select public.create_enrolment($1,$2,'Approved learner registration') as id",
      [learnerId, cohortId],
    );
    const enrolmentId = result.rows[0].id;
    expect(enrolmentId).toBeTruthy();
    await resetRole();

    const row = await db.query<{
      status: string;
      cohort_title_snapshot: string;
      cohort_starts_on_snapshot: string;
      programme_version_id: string;
    }>(
      "select status,cohort_title_snapshot,cohort_starts_on_snapshot::text,programme_version_id from public.enrolments where id=$1",
      [enrolmentId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "ACTIVE",
      cohort_title_snapshot: "October 2026 cohort",
      cohort_starts_on_snapshot: "2026-10-01",
      programme_version_id: publishedVersionId,
    });

    const audit = await db.query<{ reason: string }>(
      "select reason from public.audit_events where target_id=$1 and target_type='enrolments' order by occurred_at desc limit 1",
      [enrolmentId],
    );
    expect(audit.rows[0].reason).toBe("Approved learner registration");

    await db.query(
      "update public.cohorts set title='Renamed cohort' where id=$1",
      [cohortId],
    );
    const snapshot = await db.query<{ cohort_title_snapshot: string }>(
      "select cohort_title_snapshot from public.enrolments where id=$1",
      [enrolmentId],
    );
    expect(snapshot.rows[0].cohort_title_snapshot).toBe("October 2026 cohort");
  });

  it("allows only governed active-pause-withdraw lifecycle transitions", async () => {
    const existing = await db.query<{ id: string }>(
      "select id from public.enrolments where student_id=$1 and cohort_id=$2",
      [learnerId, cohortId],
    );
    const enrolmentId = existing.rows[0].id;

    await asAuth(registrarAuth);
    await db.query(
      "select public.change_enrolment_status($1,'PAUSED','Learner requested temporary pause')",
      [enrolmentId],
    );
    await db.query(
      "select public.change_enrolment_status($1,'ACTIVE','Learner approved to resume')",
      [enrolmentId],
    );
    await db.query(
      "select public.change_enrolment_status($1,'WITHDRAWN','Learner withdrew from cohort')",
      [enrolmentId],
    );
    await expect(
      db.query(
        "select public.change_enrolment_status($1,'ACTIVE','Attempt to reopen history')",
        [enrolmentId],
      ),
    ).rejects.toThrow("Invalid enrolment status transition");
    await resetRole();

    const final = await db.query<{ status: string }>(
      "select status from public.enrolments where id=$1",
      [enrolmentId],
    );
    expect(final.rows[0].status).toBe("WITHDRAWN");
  });

  it("keeps enrolment identity and curriculum history immutable", async () => {
    await expect(
      db.query(
        "update public.enrolments set cohort_title_snapshot='Changed history' where student_id=$1 and cohort_id=$2",
        [learnerId, cohortId],
      ),
    ).rejects.toThrow();
  });
});
