import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "88000000-0000-4000-8000-000000000002";
const learnerAuth = "88000000-0000-4000-8000-000000000001";
const programmeId = "28000000-0000-4000-8000-000000000001";
const versionId = "28000000-0000-4000-8000-000000000002";
const moduleId = "38000000-0000-4000-8000-000000000001";
const lessonId = "48000000-0000-4000-8000-000000000001";
const objectiveId = "48000000-0000-4000-8000-000000000002";
const cohortId = "58000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let firstSessionId: string;
let secondSessionId: string;
let masteryId: string;

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authId,
  ]);
  await db.exec("set role authenticated");
}

async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

async function recordEvidence(
  sessionId: string,
  kind: string,
  result: string,
  key: string,
) {
  return db.query<{ id: string }>(
    `select public.record_learning_evidence(
      $1,$2,$3,$4,$5,$6,$7,'Mastery policy evidence'
    ) as id`,
    [
      sessionId,
      enrolmentId,
      objectiveId,
      kind,
      result,
      `mastery-${key}`,
      `mastery-key-${key}`,
    ],
  );
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'mastery-admin@example.com',now()),($2,'mastery-learner@example.com',now())",
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
     values($1,'mastery-test','Mastery Test Programme','Ducelio Test Body','Mastery Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Mastery draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module one',1)",
    [moduleId, versionId],
  );
  await db.query(
    `insert into public.lessons(id,module_id,programme_version_id,title,position)
     values($1,$2,$3,'Mastery lesson',1)`,
    [lessonId, moduleId, versionId],
  );
  await db.query(
    `insert into public.lesson_objectives(id,lesson_id,programme_version_id,description,position)
     values($1,$2,$3,'Demonstrate the mastery policy objective',1)`,
    [objectiveId, lessonId, versionId],
  );

  await asAuth(adminAuth);
  await db.query(
    "select public.publish_programme_version($1,'Mastery curriculum reviewed')",
    [versionId],
  );
  await resetRole();

  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Mastery cohort',current_date)",
    [cohortId, versionId],
  );

  await asAuth(adminAuth);
  const enrolment = await db.query<{ id: string }>(
    "select public.create_enrolment($1,$2,'Approved mastery learner') as id",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;

  const firstSession = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '4 hours',now()-interval '3 hours','First mastery session'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  firstSessionId = firstSession.rows[0].id;

  const secondSession = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Second mastery session'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  secondSessionId = secondSession.rows[0].id;
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("deterministic objective mastery", () => {
  it("keeps the first correct observation at DEVELOPING", async () => {
    await asAuth(adminAuth);
    await recordEvidence(firstSessionId, "CLASS_RESPONSE", "CORRECT", "first");
    await resetRole();

    const row = await db.query<{
      id: string;
      state: string;
      correct_session_count: number;
      correct_kind_count: number;
    }>(
      "select id,state,correct_session_count,correct_kind_count from public.objective_mastery where enrolment_id=$1 and objective_id=$2",
      [enrolmentId, objectiveId],
    );
    masteryId = row.rows[0].id;
    expect(row.rows[0].state).toBe("DEVELOPING");
    expect(row.rows[0].correct_session_count).toBe(1);
    expect(row.rows[0].correct_kind_count).toBe(1);
  });

  it("requires correct evidence across two sessions and two kinds for DEMONSTRATED", async () => {
    await asAuth(adminAuth);
    await recordEvidence(
      secondSessionId,
      "RETRIEVAL_CHECK",
      "CORRECT",
      "second",
    );
    await resetRole();

    const row = await db.query<{
      state: string;
      correct_session_count: number;
      correct_kind_count: number;
    }>(
      "select state,correct_session_count,correct_kind_count from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(row.rows[0].state).toBe("DEMONSTRATED");
    expect(row.rows[0].correct_session_count).toBe(2);
    expect(row.rows[0].correct_kind_count).toBe(2);
  });

  it("moves demonstrated mastery to NEEDS_REINFORCEMENT after weaker new evidence", async () => {
    await asAuth(adminAuth);
    await recordEvidence(secondSessionId, "PRACTICAL_TASK", "PARTIAL", "third");
    await resetRole();

    const row = await db.query<{ state: string }>(
      "select state from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(row.rows[0].state).toBe("NEEDS_REINFORCEMENT");
  });

  it("restores DEMONSTRATED after later correct evidence when diversity remains sufficient", async () => {
    await asAuth(adminAuth);
    await recordEvidence(
      secondSessionId,
      "PRACTICAL_TASK",
      "CORRECT",
      "fourth",
    );
    await resetRole();

    const row = await db.query<{ state: string }>(
      "select state from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(row.rows[0].state).toBe("DEMONSTRATED");
  });

  it("records only real state transitions in immutable history", async () => {
    const history = await db.query<{ from_state: string; to_state: string }>(
      "select from_state,to_state from public.objective_mastery_history where mastery_id=$1 order by changed_at,id",
      [masteryId],
    );
    expect(
      history.rows.map((row) => `${row.from_state}->${row.to_state}`),
    ).toEqual([
      "NOT_STARTED->DEVELOPING",
      "DEVELOPING->DEMONSTRATED",
      "DEMONSTRATED->NEEDS_REINFORCEMENT",
      "NEEDS_REINFORCEMENT->DEMONSTRATED",
    ]);

    await expect(
      db.query(
        "update public.objective_mastery_history set to_state='DEVELOPING' where mastery_id=$1",
        [masteryId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("does not derive mastery from lesson progress or attendance", async () => {
    const evidenceCount = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.learning_evidence where enrolment_id=$1 and objective_id=$2",
      [enrolmentId, objectiveId],
    );
    const mastery = await db.query<{ evidence_count: number }>(
      "select evidence_count from public.objective_mastery where id=$1",
      [masteryId],
    );
    expect(mastery.rows[0].evidence_count).toBe(evidenceCount.rows[0].count);
  });

  it("lets the learner read their own mastery through RLS", async () => {
    await asAuth(learnerAuth);
    const rows = await db.query<{ state: string }>(
      "select state from public.objective_mastery where id=$1",
      [masteryId],
    );
    await resetRole();
    expect(rows.rows[0].state).toBe("DEMONSTRATED");
  });
});
