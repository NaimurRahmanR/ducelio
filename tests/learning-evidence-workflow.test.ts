import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const adminId = "10000000-0000-4000-8000-000000000002";
const learnerId = "10000000-0000-4000-8000-000000000001";
const adminAuth = "86000000-0000-4000-8000-000000000002";
const learnerAuth = "86000000-0000-4000-8000-000000000001";
const programmeId = "26000000-0000-4000-8000-000000000001";
const versionId = "26000000-0000-4000-8000-000000000002";
const moduleId = "36000000-0000-4000-8000-000000000001";
const lessonId = "46000000-0000-4000-8000-000000000001";
const otherLessonId = "46000000-0000-4000-8000-000000000002";
const objectiveId = "47000000-0000-4000-8000-000000000001";
const otherObjectiveId = "47000000-0000-4000-8000-000000000002";
const cohortId = "56000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let sessionId: string;
let evidenceId: string;

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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'evidence-admin@example.com',now()),($2,'evidence-learner@example.com',now())",
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
     values($1,'evidence-test','Evidence Test Programme','Ducelio Test Body','Evidence Test')`,
    [programmeId],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Evidence draft')",
    [versionId, programmeId],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'Module one',1)",
    [moduleId, versionId],
  );
  await db.query(
    `insert into public.lessons(id,module_id,programme_version_id,title,position)
     values($1,$2,$3,'Lesson one',1),($4,$2,$3,'Lesson two',2)`,
    [lessonId, moduleId, versionId, otherLessonId],
  );
  await db.query(
    `insert into public.lesson_objectives(id,lesson_id,programme_version_id,description,position)
     values($1,$2,$4,'Objective one',1),($3,$5,$4,'Objective two',1)`,
    [objectiveId, lessonId, otherObjectiveId, versionId, otherLessonId],
  );

  await asAuth(adminAuth);
  await db.query(
    "select public.publish_programme_version($1,'Evidence curriculum reviewed')",
    [versionId],
  );
  await resetRole();

  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Evidence cohort',current_date)",
    [cohortId, versionId],
  );

  await asAuth(adminAuth);
  const enrolment = await db.query<{ id: string }>(
    "select public.create_enrolment($1,$2,'Approved evidence learner') as id",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;
  const session = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Scheduled evidence class'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  sessionId = session.rows[0].id;
  await resetRole();
});

afterAll(async () => {
  await db?.close();
});

describe("deterministic learning evidence", () => {
  it("records evidence bound to the session, learner and objective", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      `select public.record_learning_evidence(
        $1,$2,$3,'RETRIEVAL_CHECK','CORRECT','retrieval:week1:q1','evidence-test-0001','Observed retrieval result'
      ) as id`,
      [sessionId, enrolmentId, objectiveId],
    );
    evidenceId = result.rows[0].id;
    await resetRole();
    expect(evidenceId).toBeTruthy();
  });

  it("replays an identical source event idempotently", async () => {
    await asAuth(adminAuth);
    const result = await db.query<{ id: string }>(
      `select public.record_learning_evidence(
        $1,$2,$3,'RETRIEVAL_CHECK','CORRECT','retrieval:week1:q1','evidence-test-0001','Retry of same source event'
      ) as id`,
      [sessionId, enrolmentId, objectiveId],
    );
    await resetRole();
    expect(result.rows[0].id).toBe(evidenceId);
  });

  it("rejects reusing an idempotency key for conflicting evidence", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        `select public.record_learning_evidence(
          $1,$2,$3,'RETRIEVAL_CHECK','INCORRECT','retrieval:week1:q1','evidence-test-0001','Conflicting retry'
        )`,
        [sessionId, enrolmentId, objectiveId],
      ),
    ).rejects.toThrow("different evidence");
    await resetRole();
  });

  it("rejects evidence against an objective from a different lesson", async () => {
    await asAuth(adminAuth);
    await expect(
      db.query(
        `select public.record_learning_evidence(
          $1,$2,$3,'CLASS_RESPONSE','PARTIAL','class:other-objective','evidence-test-0002','Wrong objective attempt'
        )`,
        [sessionId, enrolmentId, otherObjectiveId],
      ),
    ).rejects.toThrow("class session lesson");
    await resetRole();
  });

  it("denies learner-authored authoritative evidence", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        `select public.record_learning_evidence(
          $1,$2,$3,'CLASS_RESPONSE','CORRECT','self:attempt','evidence-test-0003','Learner self report'
        )`,
        [sessionId, enrolmentId, objectiveId],
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("keeps evidence append-only", async () => {
    await expect(
      db.query("update public.learning_evidence set result='PARTIAL' where id=$1", [
        evidenceId,
      ]),
    ).rejects.toThrow("append-only");
  });

  it("lets the learner read their own evidence through RLS", async () => {
    await asAuth(learnerAuth);
    const rows = await db.query<{ result: string }>(
      "select result from public.learning_evidence where id=$1",
      [evidenceId],
    );
    await resetRole();
    expect(rows.rows[0].result).toBe("CORRECT");
  });
});
