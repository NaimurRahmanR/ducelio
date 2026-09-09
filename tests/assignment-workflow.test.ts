import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "87000000-0000-4000-8000-000000000002";
const learnerAuth = "87000000-0000-4000-8000-000000000001";
const programmeId = "29000000-0000-4000-8000-000000000001";
const versionId = "29000000-0000-4000-8000-000000000002";
const moduleId = "39000000-0000-4000-8000-000000000001";
const lessonId = "49000000-0000-4000-8000-000000000001";
const cohortId = "59000000-0000-4000-8000-000000000001";
let assignmentId: string;
let firstSubmissionId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'assignment-admin@example.com',now()),($2,'assignment-learner@example.com',now())",
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
     values($1,'assignment-test','Assignment Test Programme','Ducelio Test Body','Assignment Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Assignment draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Coursework module',1)",
    [moduleId, versionId],
  );
  await db.query(
    `insert into public.lessons(id,module_id,programme_version_id,title,position)
     values($1,$2,$3,'Coursework lesson',1)`,
    [lessonId, moduleId, versionId],
  );
  await db.query(
    `insert into public.lesson_objectives(lesson_id,programme_version_id,description,position)
     values($1,$2,'Complete ordinary coursework',1)`,
    [lessonId, versionId],
  );

  await asAuth(adminAuth);
  await db.query(
    "select public.publish_programme_version($1,'Assignment curriculum reviewed')",
    [versionId],
  );
  await resetRole();

  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Assignment cohort',current_date)",
    [cohortId, versionId],
  );
  await asAuth(adminAuth);
  await db.query(
    "select public.create_enrolment($1,$2,'Approved assignment learner')",
    [learnerId, cohortId],
  );
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("governed assignments", () => {
  it("creates a draft assignment bound to a published cohort version", async () => {
    await asAuth(adminAuth);
    const created = await db.query<{ id: string }>(
      `select public.create_assignment(
        $1,$2,$3,'Access control reflection','Explain the trade-offs in 300 words.',
        now()-interval '1 hour',now()+interval '2 days','Create coursework assignment'
      ) as id`,
      [cohortId, lessonId, adminId],
    );
    assignmentId = created.rows[0].id;
    await resetRole();

    const row = await db.query<{ status: string; programme_version_id: string }>(
      "select status,programme_version_id from public.assignments where id=$1",
      [assignmentId],
    );
    expect(row.rows[0]).toEqual({ status: "DRAFT", programme_version_id: versionId });
  });

  it("keeps drafts hidden from the learner and publishes through the lifecycle service", async () => {
    await asAuth(learnerAuth);
    const hidden = await db.query("select id from public.assignments where id=$1", [assignmentId]);
    await resetRole();
    expect(hidden.rows).toHaveLength(0);

    await asAuth(adminAuth);
    await db.query(
      "select public.change_assignment_status($1,'PUBLISHED','Coursework ready for learners')",
      [assignmentId],
    );
    await resetRole();

    await asAuth(learnerAuth);
    const visible = await db.query<{ status: string }>(
      "select status from public.assignments where id=$1",
      [assignmentId],
    );
    await resetRole();
    expect(visible.rows[0].status).toBe("PUBLISHED");
  });

  it("records an idempotent learner submission without creating mastery evidence", async () => {
    await asAuth(learnerAuth);
    const first = await db.query<{ id: string }>(
      "select public.submit_assignment($1,'My first coursework response','assignment-key-first') as id",
      [assignmentId],
    );
    firstSubmissionId = first.rows[0].id;
    const replay = await db.query<{ id: string }>(
      "select public.submit_assignment($1,'My first coursework response','assignment-key-first') as id",
      [assignmentId],
    );
    await resetRole();
    expect(replay.rows[0].id).toBe(firstSubmissionId);

    const evidence = await db.query<{ count: number }>(
      "select count(*)::int as count from public.learning_evidence where evidence_reference=$1",
      [firstSubmissionId],
    );
    expect(evidence.rows[0].count).toBe(0);
  });

  it("preserves submissions as append-only attempts", async () => {
    await asAuth(learnerAuth);
    const second = await db.query<{ id: string }>(
      "select public.submit_assignment($1,'My revised coursework response','assignment-key-second') as id",
      [assignmentId],
    );
    await resetRole();

    const attempts = await db.query<{ attempt_number: number }>(
      "select attempt_number from public.assignment_submissions where assignment_id=$1 order by attempt_number",
      [assignmentId],
    );
    expect(attempts.rows.map((row) => row.attempt_number)).toEqual([1, 2]);
    await expect(
      db.query("update public.assignment_submissions set body='Changed' where id=$1", [second.rows[0].id]),
    ).rejects.toThrow("append-only");
  });

  it("freezes published assignment content", async () => {
    await expect(
      db.query("update public.assignments set title='Changed' where id=$1", [assignmentId]),
    ).rejects.toThrow("Invalid assignment lifecycle transition");
  });

  it("lets authorised staff close coursework and blocks later submissions", async () => {
    await asAuth(adminAuth);
    await db.query(
      "select public.change_assignment_status($1,'CLOSED','Coursework collection finished')",
      [assignmentId],
    );
    await resetRole();

    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.submit_assignment($1,'Late response','assignment-key-late')",
        [assignmentId],
      ),
    ).rejects.toThrow("not open");
    await resetRole();
  });

  it("lets the learner read only their own submission history through RLS", async () => {
    await asAuth(learnerAuth);
    const rows = await db.query<{ id: string }>(
      "select id from public.assignment_submissions where assignment_id=$1 order by attempt_number",
      [assignmentId],
    );
    await resetRole();
    expect(rows.rows).toHaveLength(2);
  });
});
