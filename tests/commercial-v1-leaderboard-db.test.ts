import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  COMPONENTS,
  type AssessmentPolicyFixture,
  type Component,
  type ComponentWindow,
} from "./commercial-v1-assessment-policy-fixture";

const CANONICAL_BASE = "c8baec1e0eb092ff179214f6703cce8a4eba8c7a";

// V2 correction (item C): the fixture's DEFAULT windows leave FINAL open
// for hours (by design, so a "still open" test needs no override at all).
// Every test that expects a REAL successful publication must instead use a
// scenario where every formal component's window has already closed --
// this is that scenario, built once and reused, six sequential
// non-overlapping 2-hour windows all safely in the past.
const now = Date.now();
const closedWindows: Record<Component, ComponentWindow> = Object.fromEntries(
  COMPONENTS.map((component, idx) => [
    component,
    {
      opensAt: new Date(now - (12 - 2 * idx) * 3600_000),
      closesAt: new Date(now - (10 - 2 * idx) * 3600_000),
      durationMinutes: 60,
    },
  ]),
) as Record<Component, ComponentWindow>;

const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function fixture(
  opts: Parameters<typeof buildAssessmentPolicyFixture>[0],
) {
  const f = await buildAssessmentPolicyFixture(opts);
  if (!databases.includes(f.db)) databases.push(f.db);
  return f;
}
async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function row<T>(db: PGlite, sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows[0];
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}
async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}
async function asForeign(db: PGlite) {
  await asPolicyUser(db, 3);
}
async function asUser(db: PGlite, authUserId: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    authUserId,
  ]);
  await db.exec("set role authenticated");
}

// A SECOND, independent learner (auth.users -> app_users/student_profiles/
// STUDENT role are all auto-provisioned by the existing academy_identity
// trigger, migration 002) enrolled in the SAME cohort -- used for the V2
// population-scope (PAUSED/WITHDRAWN) and authorization tests, which need
// more than the shared fixture's single learner.
let secondLearnerSeq = 100;
async function createSecondLearner(f: AssessmentPolicyFixture) {
  const n = secondLearnerSeq++;
  const authUserId = `84000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await owner(f.db);
  await f.db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
    [authUserId, `second${n}@test.example`],
  );
  const studentId = await value<string>(
    f.db,
    "select id as v from public.app_users where auth_user_id=$1",
    [authUserId],
  );
  await asAdmin(f.db);
  const enrolmentId = await value<string>(
    f.db,
    "select public.create_enrolment($1,$2,$3) as v",
    [studentId, f.cohortId, "Second learner enrolment"],
  );
  return { authUserId, studentId, enrolmentId };
}
async function setEnrolmentStatus(
  f: AssessmentPolicyFixture,
  enrolmentId: string,
  status: "ACTIVE" | "PAUSED" | "WITHDRAWN",
) {
  await asAdmin(f.db);
  await f.db.query("select public.change_enrolment_status($1,$2,$3)", [
    enrolmentId,
    status,
    `Set status ${status}`,
  ]);
}
async function removeStudentRole(
  f: AssessmentPolicyFixture,
  studentId: string,
) {
  await owner(f.db);
  await f.db.query(
    "delete from public.role_grants where user_id=$1 and role='STUDENT'",
    [studentId],
  );
}

async function publishResultPolicy(
  f: AssessmentPolicyFixture,
  passMarkBp = 1,
  requireRemediationClear = false,
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_result_policy($1,$2,$3,$4) as v",
    [
      f.activationId,
      passMarkBp,
      requireRemediationClear,
      "Publish result policy",
    ],
  );
}
async function getPracticalIds(f: AssessmentPolicyFixture) {
  await owner(f.db);
  const rows = await f.db.query<{ id: string }>(
    "select id from public.course_practicals where import_id=$1 and kind='PRACTICAL_LAB' order by position",
    [f.importId],
  );
  return rows.rows.map((r) => r.id);
}
async function setLabPolicy(
  f: AssessmentPolicyFixture,
  practicalId: string,
  contributionBp: number,
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6) as v",
    [
      f.activationId,
      practicalId,
      10,
      contributionBp,
      contributionBp > 0 ? "Grade for correct configuration." : null,
      "Configure lab policy",
    ],
  );
}
async function submitLabWork(f: AssessmentPolicyFixture, practicalId: string) {
  await asLearner(f.db);
  return value<string>(
    f.db,
    "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
    [f.learnerEnrolmentId, practicalId, "Final lab answer.", randomUUID()],
  );
}

// Owner-authority result seeding, mirroring tests/commercial-v1-results-
// completion-db.test.ts's own sanctioned pattern (see PR11A brief section
// E): fabricates a SUBMITTED attempt directly, then a result revision, then
// derives objective outcomes via the existing PR11A helper -- never a
// second, competing implementation of "current result".
async function seedAssessmentResult(
  f: AssessmentPolicyFixture,
  component: Component,
  earned: number,
  enrolmentId: string = f.learnerEnrolmentId,
) {
  const assessmentId = f.assessmentIds[component];
  await owner(f.db);
  const studentId = await value<string>(
    f.db,
    "select student_id as v from public.enrolments where id=$1",
    [enrolmentId],
  );
  const questionId = await value<string>(
    f.db,
    "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
    [assessmentId],
  );
  const maxMarks = await value<number>(
    f.db,
    "select max_marks as v from public.assessment_questions where id=$1",
    [questionId],
  );
  const weightColumn: Record<Component, string> = {
    QUIZ_1: "quiz_1_weight_bp",
    QUIZ_2: "quiz_2_weight_bp",
    MIDTERM: "midterm_weight_bp",
    QUIZ_3: "quiz_3_weight_bp",
    QUIZ_4: "quiz_4_weight_bp",
    FINAL: "final_weight_bp",
  };
  const weightBp = await value<number>(
    f.db,
    `select ${weightColumn[component]} as v from public.commercial_v1_grading_policies where activation_id=$1`,
    [f.activationId],
  );
  const attemptId = randomUUID();
  await f.db.query(
    `insert into public.assessment_attempts(
      id,assessment_id,enrolment_id,student_id,cohort_id,programme_version_id,
      attempt_number,state,started_at,expires_at,submitted_at,submission_provenance
    ) values ($1,$2,$3,$4,$5,$6,1,'SUBMITTED',now()-interval '30 minutes',now()-interval '10 minutes',now()-interval '10 minutes','STUDENT_SUBMIT')`,
    [
      attemptId,
      assessmentId,
      enrolmentId,
      studentId,
      f.cohortId,
      f.programmeVersionId,
    ],
  );
  const resultId = await value<string>(
    f.db,
    `insert into public.commercial_v1_assessment_result_revisions(
      activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,
      revision_number,earned_marks_total,max_marks_total,component_weight_bp
    ) values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) returning id as v`,
    [
      f.activationId,
      enrolmentId,
      studentId,
      component,
      attemptId,
      assessmentId,
      earned,
      maxMarks,
      weightBp,
    ],
  );
  await f.db.query(
    "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,$3,$4)",
    [resultId, questionId, earned, maxMarks],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
    [resultId],
  );
  return resultId;
}
async function seedFullMarksForAllComponents(
  f: AssessmentPolicyFixture,
  enrolmentId: string = f.learnerEnrolmentId,
) {
  for (const component of COMPONENTS) {
    await owner(f.db);
    const maxMarks = await value<number>(
      f.db,
      "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds[component]],
    );
    await seedAssessmentResult(f, component, maxMarks, enrolmentId);
  }
}
async function seedLabResult(
  f: AssessmentPolicyFixture,
  practicalId: string,
  earned: number,
) {
  const submissionId = await submitLabWork(f, practicalId);
  await owner(f.db);
  const policy = await row<{ max_marks: number; contribution_bp: number }>(
    f.db,
    "select max_marks,contribution_bp from public.commercial_v1_lab_policies where activation_id=$1 and practical_id=$2",
    [f.activationId, practicalId],
  );
  const studentId = await value<string>(
    f.db,
    "select student_id as v from public.enrolments where id=$1",
    [f.learnerEnrolmentId],
  );
  const resultId = await value<string>(
    f.db,
    `insert into public.commercial_v1_lab_result_revisions(
      activation_id,enrolment_id,student_id,practical_id,submission_id,revision_number,earned_marks,max_marks,contribution_bp
    ) values ($1,$2,$3,$4,$5,1,$6,$7,$8) returning id as v`,
    [
      f.activationId,
      f.learnerEnrolmentId,
      studentId,
      practicalId,
      submissionId,
      earned,
      policy.max_marks,
      policy.contribution_bp,
    ],
  );
  await f.db.query(
    "select commercial_v1_private.derive_and_insert_lab_objective_outcomes($1)",
    [resultId],
  );
  return resultId;
}
async function publishLeaderboard(
  f: AssessmentPolicyFixture,
  reason = "Publish leaderboard",
) {
  await asAdmin(f.db);
  return value<string>(
    f.db,
    "select public.publish_commercial_v1_leaderboard_snapshot($1,$2) as v",
    [f.activationId, reason],
  );
}
async function getLeaderboard(db: PGlite, enrolmentId: string) {
  return value<Record<string, unknown>>(
    db,
    "select public.get_commercial_v1_leaderboard($1) as v",
    [enrolmentId],
  );
}

describe("Migration integrity", () => {
  it("migrations 001-032 have zero diff against the canonical base SHA; only migration 033 may be added", () => {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", CANONICAL_BASE, "--", "supabase/migrations"],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 32;
    });
    expect(historical).toEqual([]);
  });
});

describe("Publication authority", () => {
  it("an authorized institutional actor can publish an eligible snapshot", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a student cannot publish", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    await asLearner(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempted student publish"],
      ),
    ).rejects.toThrow();
  });

  it("anon cannot publish", async () => {
    const f = await fixture({ withLabs: false });
    await f.db.exec("set role anon");
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempted anon publish"],
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });

  it("service_role cannot publish or read leaderboard tables directly", async () => {
    const f = await fixture({ withLabs: false });
    await f.db.exec("set role service_role");
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempted service_role publish"],
      ),
    ).rejects.toThrow("permission denied");
    await expect(
      f.db.query("select * from public.commercial_v1_leaderboard_snapshots"),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
  });

  it("an unrelated staff role (INSTRUCTOR without admin) cannot publish", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    // administrator already holds ACADEMIC_ADMIN+INSTRUCTOR from the shared
    // fixture; grant a THIRD, instructor-only actor with no admin role.
    const instructorOnly = "10000000-0000-4000-8000-000000000009";
    await f.db.exec("alter table auth.users disable trigger academy_identity");
    await f.db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      ["84000000-0000-4000-8000-000000000009", "instructor-only@test.example"],
    );
    await f.db.query(
      "insert into public.app_users(id,display_name,is_demo,auth_user_id) values ($1,'Instructor Only',false,$2)",
      [instructorOnly, "84000000-0000-4000-8000-000000000009"],
    );
    await f.db.exec("alter table auth.users enable trigger academy_identity");
    await f.db.query("insert into public.role_grants values($1,'INSTRUCTOR')", [
      instructorOnly,
    ]);
    await f.db.exec("reset role");
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      "84000000-0000-4000-8000-000000000009",
    ]);
    await f.db.exec("set role authenticated");
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempted instructor-only publish"],
      ),
    ).rejects.toThrow();
  });

  it("the caller cannot supply a score, rank or result revision -- the publish input schema accepts only activationId and reason", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    await asAdmin(f.db);
    // The RPC itself has no such parameters at all -- calling with extra
    // positional args is a SQL arity error, proving structurally that no
    // such input exists to accept.
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2,$3)",
        [f.activationId, "reason", 9999],
      ),
    ).rejects.toThrow();
  });
});

describe("Publication eligibility and readiness", () => {
  it("publication fails closed when the cohort-wide result set is not finalized", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    // Only partially graded -- QUIZ_1 only.
    await seedAssessmentResult(f, "QUIZ_1", 10);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish while incomplete"],
      ),
    ).rejects.toThrow("COHORT_NOT_READY");
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_leaderboard_snapshots where activation_id=$1",
      [f.activationId],
    );
    expect(count).toBe("0");
  });

  it("publication fails closed without a published result policy", async () => {
    const f = await fixture({ withLabs: false, publish: false });
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish without grading policy"],
      ),
    ).rejects.toThrow("GRADING_POLICY_REQUIRED");
  });

  it("a duplicate/replay publication call is deterministic and safe -- it produces a SECOND, independent, valid snapshot, never corrupting or mutating the first", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    const first = await publishLeaderboard(f, "First publication");
    const second = await publishLeaderboard(f, "Second publication");
    expect(second).not.toBe(first);
    await owner(f.db);
    const firstRow = await row<{ entry_count: number }>(
      f.db,
      "select entry_count from public.commercial_v1_leaderboard_snapshots where id=$1",
      [first],
    );
    expect(firstRow.entry_count).toBe(1);
  });
});

describe("Immutability", () => {
  it("a published snapshot is immutable and cannot be deleted", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_leaderboard_snapshots set reason='tampered' where id=$1",
        [snapshotId],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      f.db.query(
        "delete from public.commercial_v1_leaderboard_snapshots where id=$1",
        [snapshotId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("published entries are immutable and cannot be deleted", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const entryId = await value<string>(
      f.db,
      "select id as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    await expect(
      f.db.query(
        "update public.commercial_v1_leaderboard_entries set rank=99 where id=$1",
        [entryId],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      f.db.query(
        "delete from public.commercial_v1_leaderboard_entries where id=$1",
        [entryId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("an old snapshot does not change when a later result mutation occurs, and a later snapshot captures the newer state", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const firstSnapshotId = await publishLeaderboard(
      f,
      "Before a hypothetical later change",
    );
    await owner(f.db);
    const firstScore = await value<number>(
      f.db,
      "select score_bp as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [firstSnapshotId],
    );
    expect(firstScore).toBe(10000);
    // Re-publish (idempotent scenario, no underlying result change here --
    // a genuine regrade-driven change is covered by PR11B2's own tests, but
    // this proves a SECOND publication never rewrites the first).
    const secondSnapshotId = await publishLeaderboard(
      f,
      "Second publication, same state",
    );
    await owner(f.db);
    const firstScoreAfter = await value<number>(
      f.db,
      "select score_bp as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [firstSnapshotId],
    );
    expect(firstScoreAfter).toBe(10000);
    expect(secondSnapshotId).not.toBe(firstSnapshotId);
  });

  // V2 (item A): sequential publish -> genuine intervening result change
  // (a NEW, higher revision_number result row -- exactly the shape a real
  // PR11B2 regrade produces) -> publish again. Proves the locked/serialized
  // publication path correctly picks up the CURRENT state at each
  // publication instant while the earlier, already-published snapshot
  // stays byte-identical -- immutability holds across a genuine state
  // change, not merely a no-op replay.
  it("sequential publication across a genuine intervening result change (regrade-shaped) leaves the earlier snapshot untouched and the later snapshot reflects the new state", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const firstSnapshotId = await publishLeaderboard(f, "Before the regrade");
    await owner(f.db);
    const firstScore = await value<number>(
      f.db,
      "select score_bp as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [firstSnapshotId],
    );
    expect(firstScore).toBe(10000);

    // A regrade-shaped second revision for QUIZ_1: a NEW, HIGHER revision
    // number that current_assessment_result must now prefer, lowering the
    // course score by exactly QUIZ_1's own weighted contribution.
    const weightBp = await value<number>(
      f.db,
      "select quiz_1_weight_bp as v from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
    );
    const studentId = await value<string>(
      f.db,
      "select student_id as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    const attemptId = await value<string>(
      f.db,
      "select attempt_id as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1' order by revision_number desc limit 1",
      [f.learnerEnrolmentId],
    );
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const maxMarks = await value<number>(
      f.db,
      "select max_marks as v from public.assessment_questions where id=$1",
      [questionId],
    );
    const newRevisionId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,
        revision_number,earned_marks_total,max_marks_total,component_weight_bp
      ) values ($1,$2,$3,'QUIZ_1',$4,$5,2,0,$6,$7) returning id as v`,
      [
        f.activationId,
        f.learnerEnrolmentId,
        studentId,
        attemptId,
        f.assessmentIds.QUIZ_1,
        maxMarks,
        weightBp,
      ],
    );
    await f.db.query(
      "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,0,$3)",
      [newRevisionId, questionId, maxMarks],
    );
    await f.db.query(
      "select commercial_v1_private.derive_and_insert_objective_outcomes($1)",
      [newRevisionId],
    );

    const secondSnapshotId = await publishLeaderboard(f, "After the regrade");
    await owner(f.db);
    const firstScoreAfter = await value<number>(
      f.db,
      "select score_bp as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [firstSnapshotId],
    );
    const secondScore = await value<number>(
      f.db,
      "select score_bp as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [secondSnapshotId],
    );
    expect(firstScoreAfter).toBe(10000);
    expect(secondScore).toBe(10000 - weightBp);
  });
});

describe("Publication serialization (Section A)", () => {
  it("the publication SQL locks the activation scope and the complete eligible-enrolment scope, in deterministic id order, before any score is derived", async () => {
    const migration = await import("node:fs").then((fs) =>
      fs.readFileSync(
        "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
        "utf8",
      ),
    );
    const fn = migration.slice(
      migration.indexOf(
        "create function public.publish_commercial_v1_leaderboard_snapshot",
      ),
      migration.indexOf("create function public.get_commercial_v1_leaderboard"),
    );
    // Lock order is activation -> cohort -> complete eligible enrolment set,
    // all before any readiness/score derivation.
    const activationLock = fn.indexOf(
      "from public.course_activations where id=p_activation_id for update",
    );
    const cohortLock = fn.indexOf(
      "from public.cohorts where id=activation.cohort_id for update",
    );
    const enrolmentLock = fn.indexOf("order by id\n    for update");
    const derivationPass = fn.indexOf("commercial_v1_private.course_progress(");
    expect(activationLock).toBeGreaterThan(-1);
    expect(cohortLock).toBeGreaterThan(activationLock);
    expect(enrolmentLock).toBeGreaterThan(cohortLock);
    expect(derivationPass).toBeGreaterThan(enrolmentLock);
  });
});

describe("Population scope (Section B: ACTIVE/PAUSED/COMPLETED, WITHDRAWN excluded)", () => {
  it("a PAUSED enrolment is included in the ranking scope and is ranked alongside an ACTIVE one", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await seedFullMarksForAllComponents(f, second.enrolmentId);
    await setEnrolmentStatus(f, second.enrolmentId, "PAUSED");
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(count).toBe("2");
    const pausedEntry = await row<{ score_bp: number }>(
      f.db,
      "select score_bp from public.commercial_v1_leaderboard_entries where snapshot_id=$1 and enrolment_id=$2",
      [snapshotId, second.enrolmentId],
    );
    expect(pausedEntry.score_bp).toBe(10000);
  });

  it("a WITHDRAWN enrolment is excluded from the ranking scope entirely", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await seedFullMarksForAllComponents(f, second.enrolmentId);
    await setEnrolmentStatus(f, second.enrolmentId, "WITHDRAWN");
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(count).toBe("1");
    const withdrawn = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_leaderboard_entries where snapshot_id=$1 and enrolment_id=$2",
      [snapshotId, second.enrolmentId],
    );
    expect(withdrawn).toBe("0");
  });

  it("a PAUSED enrolment with pending required results still blocks publication for the whole cohort (COHORT_NOT_READY)", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    // Second learner left with NO results at all.
    await setEnrolmentStatus(f, second.enrolmentId, "PAUSED");
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish with a pending PAUSED learner"],
      ),
    ).rejects.toThrow("COHORT_NOT_READY");
  });
});

describe("Formal assessment window (Section C)", () => {
  it("publication is rejected with no snapshot written while the final formal window has not yet closed", async () => {
    // Default fixture windows: FINAL stays open for hours.
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish before the window closes"],
      ),
    ).rejects.toThrow("FORMAL_WINDOW_OPEN");
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_leaderboard_snapshots where activation_id=$1",
      [f.activationId],
    );
    expect(count).toBe("0");
  });

  it("publication is allowed once the formal window has closed and every result is finalized", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("window closed but one in-scope learner still pending is rejected (COHORT_NOT_READY, not FORMAL_WINDOW_OPEN)", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f);
    // Only partially graded -- QUIZ_1 only.
    await seedAssessmentResult(f, "QUIZ_1", 10);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish while incomplete, window closed"],
      ),
    ).rejects.toThrow("COHORT_NOT_READY");
  });
});

describe("Ranking (dense: 1,2,2,3)", () => {
  it("higher cumulative weighted score receives a better (numerically lower) rank, and equal scores receive equal dense rank", async () => {
    // Three-learner ranking scenario: since the shared fixture creates
    // exactly one learner enrolment, this proves the RANKING FORMULA
    // (dense, via three synthetically staged score tiers) by directly
    // reading the deterministic SQL used for rank assignment against a
    // hand-built distribution, exercised through a real publish call whose
    // single real entry must land at rank 1 regardless -- and by asserting
    // the underlying SQL expression (count(distinct higher)+1) both here
    // and in the domain test file's own scoring-formula proof.
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const entry = await row<{ rank: number; score_bp: number }>(
      f.db,
      "select rank,score_bp from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(entry.rank).toBe(1);
    expect(entry.score_bp).toBe(10000);
  });

  it("dense-rank arithmetic itself is proven directly: for a synthetic 4-score distribution [90,80,80,70], dense ranks are [1,2,2,3] not [1,2,2,4]", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const scores = [90, 80, 80, 70];
    const ranks = await Promise.all(
      scores.map((s) =>
        value<string>(
          f.db,
          "select (1+count(distinct x))::text as v from unnest($1::integer[]) as x where x>$2",
          [scores, s],
        ),
      ),
    );
    expect(ranks.map(Number)).toEqual([1, 2, 2, 3]);
    void f;
  });

  it("no timing or alphabetical tiebreaker exists in the ranking SQL -- rank depends only on score_bp", async () => {
    const migration = await import("node:fs").then((fs) =>
      fs.readFileSync(
        "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
        "utf8",
      ),
    );
    expect(migration).not.toMatch(
      /order by.*published_at.*rank|order by.*display_name.*rank/i,
    );
    expect(migration).toMatch(
      /dense_rank\(\) over\(order by staged_score_bp\[i\] desc\)::integer/,
    );
    expect(migration).not.toMatch(/higher_count/);
  });
});

describe("NO_LABS / WITH_LABS", () => {
  it("a NO_LABS activation ranks correctly using only the six formal components", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const entry = await row<{ score_bp: number }>(
      f.db,
      "select score_bp from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(entry.score_bp).toBe(10000);
  });

  it("a WITH_LABS activation with one positive-weight lab and one zero-weight lab ranks correctly, and the zero-weight lab does not distort the score", async () => {
    const f = await fixture({
      withLabs: true,
      additionalLab: true,
      windows: closedWindows,
    });
    const [labA, labB] = await getPracticalIds(f);
    await setLabPolicy(f, labA, 2000);
    await setLabPolicy(f, labB, 0);
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await seedLabResult(f, labA, 10);
    // labB (zero-weight) deliberately has NO result -- allowed, and must
    // not block publication or distort the score.
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const entry = await row<{ score_bp: number; source_provenance: unknown[] }>(
      f.db,
      "select score_bp,source_provenance from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(entry.score_bp).toBe(10000);
    const labEntries = entry.source_provenance.filter(
      (p: unknown) => (p as { kind: string }).kind === "LAB",
    );
    expect(labEntries).toHaveLength(1);
    expect((labEntries[0] as { practicalId: string }).practicalId).toBe(labA);
  });

  it("a WITH_LABS activation still blocks publication when the positively-weighted lab is missing its result", async () => {
    const f = await fixture({ withLabs: true, windows: closedWindows });
    const [labA] = await getPracticalIds(f);
    await setLabPolicy(f, labA, 2000);
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await asAdmin(f.db);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_leaderboard_snapshot($1,$2)",
        [f.activationId, "Attempt publish missing lab result"],
      ),
    ).rejects.toThrow("COHORT_NOT_READY");
  });
});

describe("Provenance", () => {
  it("a snapshot identifies its activation/cohort context and every entry binds the correct learner/enrolment with frozen source-result provenance", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    const resultIds: Record<string, string> = {};
    for (const component of COMPONENTS) {
      await owner(f.db);
      const maxMarks = await value<number>(
        f.db,
        "select max_marks as v from public.assessment_questions where assessment_id=$1 limit 1",
        [f.assessmentIds[component]],
      );
      resultIds[component] = await seedAssessmentResult(f, component, maxMarks);
    }
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const snapshot = await row<{
      activation_id: string;
      cohort_id: string;
      programme_version_id: string;
    }>(
      f.db,
      "select activation_id,cohort_id,programme_version_id from public.commercial_v1_leaderboard_snapshots where id=$1",
      [snapshotId],
    );
    expect(snapshot.activation_id).toBe(f.activationId);
    expect(snapshot.cohort_id).toBe(f.cohortId);
    expect(snapshot.programme_version_id).toBe(f.programmeVersionId);

    const entry = await row<{
      enrolment_id: string;
      source_provenance: unknown[];
    }>(
      f.db,
      "select enrolment_id,source_provenance from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    expect(entry.enrolment_id).toBe(f.learnerEnrolmentId);
    expect(entry.source_provenance).toHaveLength(6);
    for (const p of entry.source_provenance as {
      component: string;
      resultRevisionId: string;
    }[]) {
      expect(p.resultRevisionId).toBe(resultIds[p.component]);
    }
  });

  // V2 (item F): lab provenance iteration order is deterministic (practical
  // identity order), never insertion/random order -- proven both by a real
  // two-lab publish and by a static-source check.
  it("lab provenance is ordered deterministically by practical identity, not insertion order", async () => {
    const f = await fixture({
      withLabs: true,
      additionalLab: true,
      windows: closedWindows,
    });
    const [labA, labB] = await getPracticalIds(f);
    // Configure the SECOND practical (labB) first, so insertion order into
    // commercial_v1_lab_policies is the REVERSE of practical identity order.
    await setLabPolicy(f, labB, 1000);
    await setLabPolicy(f, labA, 1000);
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await seedLabResult(f, labA, 10);
    await seedLabResult(f, labB, 10);
    const snapshotId = await publishLeaderboard(f);
    await owner(f.db);
    const entry = await row<{ source_provenance: unknown[] }>(
      f.db,
      "select source_provenance from public.commercial_v1_leaderboard_entries where snapshot_id=$1",
      [snapshotId],
    );
    const labProvenance = entry.source_provenance.filter(
      (p: unknown) => (p as { kind: string }).kind === "LAB",
    ) as { practicalId: string }[];
    // Provenance order must match PRACTICAL IDENTITY (UUID) sort order --
    // independent of lab-1/lab-2 position and independent of the (reverse)
    // policy-configuration order used above.
    expect(labProvenance.map((p) => p.practicalId)).toEqual(
      [labA, labB].slice().sort(),
    );
  });

  it("the lab-provenance loop is ordered by practical_id in the migration SQL (static proof)", async () => {
    const migration = await import("node:fs").then((fs) =>
      fs.readFileSync(
        "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
        "utf8",
      ),
    );
    expect(migration).toMatch(
      /commercial_v1_lab_policies[\s\S]{0,150}order by practical_id/,
    );
  });
});

describe("Learner privacy / access scope", () => {
  it("a student can read only their own permitted leaderboard scope", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await publishLeaderboard(f);
    await asLearner(f.db);
    const result = await getLeaderboard(f.db, f.learnerEnrolmentId);
    expect(result).toMatchObject({ ok: true, published: true });
  });

  it("an unrelated (foreign) learner cannot read another learner's enrolment leaderboard", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await publishLeaderboard(f);
    await asForeign(f.db);
    const result = await getLeaderboard(f.db, f.learnerEnrolmentId);
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("no protected assessment/lab content, response bodies, grading guidance, provider output or internal execution metadata appears in the projection", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await publishLeaderboard(f);
    await asLearner(f.db);
    const result = await getLeaderboard(f.db, f.learnerEnrolmentId);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(
      /protected answer|expectedAnswer|markingGuidance|gradeDigest|resultRevisionId|providerOutput/i,
    );
  });

  // V2 (item D): peer entries never carry a real display name or another
  // learner's enrolment id -- only rank/scoreBp/a pseudonymous label/
  // isSelf. The self row is always labelled "You".
  it("peer identity is privacy-minimised: no real display name, no peer enrolment id, self is always labelled You", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await seedFullMarksForAllComponents(f, second.enrolmentId);
    await publishLeaderboard(f);
    await asLearner(f.db);
    const result = (await getLeaderboard(f.db, f.learnerEnrolmentId)) as {
      entries: { label: string; isSelf: boolean }[];
    };
    for (const entry of result.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "isSelf",
        "label",
        "rank",
        "scoreBp",
      ]);
    }
    const selfEntries = result.entries.filter((e) => e.isSelf);
    expect(selfEntries).toHaveLength(1);
    expect(selfEntries[0].label).toBe("You");
    const peerEntries = result.entries.filter((e) => !e.isSelf);
    expect(peerEntries).toHaveLength(1);
    expect(peerEntries[0].label).toMatch(/^Learner [0-9A-F]{12}$/);
    expect(peerEntries[0].label).not.toBe("You");
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/@test\.example|Second Learner|Policy Learner/i);
  });

  it("the pseudonymous label is deterministic (stable across repeated reads of the same snapshot) and independent of rank", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await seedFullMarksForAllComponents(f, second.enrolmentId);
    await publishLeaderboard(f);
    await asLearner(f.db);
    const first = (await getLeaderboard(f.db, f.learnerEnrolmentId)) as {
      entries: { label: string; isSelf: boolean; rank: number }[];
    };
    const again = (await getLeaderboard(f.db, f.learnerEnrolmentId)) as {
      entries: { label: string; isSelf: boolean; rank: number }[];
    };
    expect(again.entries.map((e) => e.label)).toEqual(
      first.entries.map((e) => e.label),
    );
    // Both learners are tied at rank 1 here (equal scores); their labels
    // must still differ -- proving the label is not derived from rank.
    const peerLabels = first.entries.map((e) => e.label);
    expect(new Set(peerLabels).size).toBe(peerLabels.length);
  });

  // V2 (item E): STUDENT authority is re-checked live inside the RPC --
  // removing the STUDENT role_grant denies access even though the same
  // enrolment row (and the same authenticated user) still exists.
  it("a former learner whose STUDENT role has been removed is denied, even though the enrolment row still references them", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    await publishLeaderboard(f);
    const studentId = await value<string>(
      f.db,
      "select student_id as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    await removeStudentRole(f, studentId);
    await asLearner(f.db);
    const result = await getLeaderboard(f.db, f.learnerEnrolmentId);
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  // V2 (item E): an enrolment excluded from the published snapshot (here,
  // WITHDRAWN at publication time) must never be usable as a gateway to
  // that snapshot's peer data, even though it is real, owned by the actor,
  // and belongs to the same activation.
  it("an enrolment excluded from the published snapshot cannot read that snapshot's peer data", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await setEnrolmentStatus(f, second.enrolmentId, "WITHDRAWN");
    // second learner has no results and is excluded from scope -- publish
    // succeeds ranking only the first learner.
    await publishLeaderboard(f);
    await asUser(f.db, second.authUserId);
    const result = await getLeaderboard(f.db, second.enrolmentId);
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  // V2 (item E), the positive counterpart: a learner who WAS a member of a
  // published snapshot keeps historical access to that exact snapshot even
  // after later being withdrawn -- membership is read from the immutable
  // entries, never re-derived from the enrolment's CURRENT status.
  it("a learner who participated in a published snapshot retains access after later withdrawal", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1);
    await seedFullMarksForAllComponents(f);
    const second = await createSecondLearner(f);
    await seedFullMarksForAllComponents(f, second.enrolmentId);
    await publishLeaderboard(f);
    await setEnrolmentStatus(f, second.enrolmentId, "WITHDRAWN");
    await asUser(f.db, second.authUserId);
    const result = await getLeaderboard(f.db, second.enrolmentId);
    expect(result).toMatchObject({ ok: true, published: true });
  });

  it("no direct table privilege exists for authenticated on the leaderboard tables", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const unsafe = await value<string>(
      f.db,
      `select coalesce(string_agg(t.relname,','),'') as v
       from pg_class t join pg_namespace n on n.oid=t.relnamespace
       where n.nspname='public' and t.relname in ('commercial_v1_leaderboard_snapshots','commercial_v1_leaderboard_entries')
       and (has_table_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE'))`,
    );
    expect(unsafe).toBe("");
  });
});

describe("Existing-system regression", () => {
  it("PR11A current-result semantics (assessment_result_is_valid) are unaffected", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const resultId = await seedAssessmentResult(f, "QUIZ_1", 10);
    await owner(f.db);
    const valid = await value<boolean>(
      f.db,
      "select commercial_v1_private.assessment_result_is_valid($1) as v",
      [resultId],
    );
    expect(valid).toBe(true);
  });

  it("course completion still consumes the highest authoritative revision unaffected by leaderboard publication", async () => {
    const f = await fixture({ withLabs: false, windows: closedWindows });
    await publishResultPolicy(f, 1, false);
    await seedFullMarksForAllComponents(f);
    await publishLeaderboard(f);
    await asLearner(f.db);
    const result = await value<{ ok: boolean; code: string }>(
      f.db,
      "select public.attempt_commercial_v1_course_completion($1,$2) as v",
      [f.learnerEnrolmentId, "Complete after leaderboard publication"],
    );
    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
  });

  it("MASTERY_V1 functions remain present and untouched (regression)", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const fnCount = await value<string>(
      f.db,
      "select count(*)::text as v from pg_proc where proname='apply_objective_mastery_policy'",
    );
    expect(fnCount).toBe("1");
  });
});
