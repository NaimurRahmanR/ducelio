import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./db-helper";

let db: PGlite;
const learnerId = "10000000-0000-4000-8000-000000000001";
const otherLearnerId = "10000000-0000-4000-8000-000000000003";
const learnerAuth = "81000000-0000-4000-8000-000000000001";
const otherLearnerAuth = "81000000-0000-4000-8000-000000000003";
const adminId = "16000000-0000-4000-8000-000000000001";
const adminAuth = "81000000-0000-4000-8000-000000000002";
const cohortId = "50000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000002";
const lessonId = "40000000-0000-4000-8000-000000000001";
const planId = "60000000-0000-4000-8000-000000000001";
const planItemId = "66000000-0000-4000-8000-000000000001";
let enrolmentId: string;
let sessionId: string;
let attendanceId: string;
let assignmentId: string;
let masteryId: string;
let notificationId: string;

async function asAuth(authId: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [authId]);
  await db.exec("set role authenticated");
}

async function resetRole() {
  await db.exec("reset role; reset request.jwt.claim.sub");
}

async function refresh() {
  await asAuth(adminAuth);
  const result = await db.query<{
    result: {
      openSupportEvents: number;
      unreadNotifications: number;
      policyVersion: string;
    };
  }>(
    "select public.refresh_deterministic_support_triggers('Evaluate deterministic support test rules') as result",
  );
  await resetRole();
  return result.rows[0].result;
}

beforeAll(async () => {
  db = await testDatabase();
  await db.exec("alter table auth.users disable trigger academy_identity");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'notification-learner@example.com',now()),($2,'notification-admin@example.com',now()),($3,'notification-other@example.com',now())",
    [learnerAuth, adminAuth, otherLearnerAuth],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [learnerAuth, learnerId],
  );
  await db.query(
    "update public.app_users set auth_user_id=$1,is_demo=false where id=$2",
    [otherLearnerAuth, otherLearnerId],
  );
  await db.query(
    `insert into public.app_users(id,auth_user_id,display_name,is_demo)
     values($1,$2,'Notification Admin',false)`,
    [adminId, adminAuth],
  );
  await db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Academic administrator')",
    [adminId],
  );
  await db.query(
    "insert into public.role_grants(user_id,role) values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR')",
    [adminId],
  );
  await db.exec("alter table auth.users enable trigger academy_identity");

  const enrolment = await db.query<{ id: string }>(
    "select id from public.enrolments where student_id=$1 and cohort_id=$2",
    [learnerId, cohortId],
  );
  enrolmentId = enrolment.rows[0].id;

  await asAuth(adminAuth);
  const session = await db.query<{ id: string }>(
    `select public.create_class_session(
      $1,$2,$3,now()-interval '3 hours',now()-interval '2 hours','Create notification test session'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  sessionId = session.rows[0].id;
  const attendance = await db.query<{ id: string }>(
    "select public.record_attendance($1,$2,'ABSENT','Recorded learner absence') as id",
    [sessionId, enrolmentId],
  );
  attendanceId = attendance.rows[0].id;

  const assignment = await db.query<{ id: string }>(
    `select public.create_assignment(
      $1,$2,$3,'Notification test assignment','Complete the bounded coursework task.',
      now()-interval '1 hour',now()+interval '24 hours','Create notification test assignment'
    ) as id`,
    [cohortId, lessonId, adminId],
  );
  assignmentId = assignment.rows[0].id;
  await db.query(
    "select public.change_assignment_status($1,'PUBLISHED','Publish notification test assignment')",
    [assignmentId],
  );
  await resetRole();

  await db.query(
    `insert into public.study_plan_items(id,plan_id,student_id,title,due_on,status,created_by)
     values($1,$2,$3,'Overdue deterministic plan item',current_date-1,'PLANNED',$4)`,
    [planItemId, planId, learnerId, adminId],
  );

  const objective = await db.query<{ id: string }>(
    "select id from public.lesson_objectives where lesson_id=$1 order by position limit 1",
    [lessonId],
  );
  const evidence = await db.query<{ id: string }>(
    `insert into public.learning_evidence(
      enrolment_id,student_id,objective_id,lesson_id,programme_version_id,session_id,
      evidence_kind,result,evidence_reference,idempotency_key,recorded_by
    ) values($1,$2,$3,$4,$5,$6,'RETRIEVAL_CHECK','PARTIAL','notification-test-evidence','notification-evidence-key',$7)
    returning id`,
    [
      enrolmentId,
      learnerId,
      objective.rows[0].id,
      lessonId,
      versionId,
      sessionId,
      adminId,
    ],
  );
  const mastery = await db.query<{ id: string }>(
    `insert into public.objective_mastery(
      enrolment_id,student_id,objective_id,lesson_id,programme_version_id,state,
      evidence_count,correct_evidence_count,correct_session_count,correct_kind_count,
      last_evidence_id,policy_version,evaluated_by
    ) values($1,$2,$3,$4,$5,'NEEDS_REINFORCEMENT',1,0,0,0,$6,'MASTERY_V1',$7)
    returning id`,
    [
      enrolmentId,
      learnerId,
      objective.rows[0].id,
      lessonId,
      versionId,
      evidence.rows[0].id,
      adminId,
    ],
  );
  masteryId = mastery.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("deterministic support notifications", () => {
  it("denies learners from running the institutional support scan", async () => {
    await asAuth(learnerAuth);
    await expect(
      db.query(
        "select public.refresh_deterministic_support_triggers('Learner tries support scan')",
      ),
    ).rejects.toThrow("Access denied");
    await resetRole();
  });

  it("creates support events and learner notifications only from authoritative rules", async () => {
    const result = await refresh();
    expect(result.policyVersion).toBe("SUPPORT_V1");

    const events = await db.query<{ kind: string; source_reference: string }>(
      `select kind,source_reference from public.support_events
       where student_id=$1 and deduplication_key like 'support:v1:%' order by kind`,
      [learnerId],
    );
    expect(events.rows).toEqual(
      expect.arrayContaining([
        { kind: "MISSED_CLASS", source_reference: `attendance:${attendanceId}` },
        { kind: "DEADLINE_APPROACHING", source_reference: `assignment:${assignmentId}` },
        { kind: "PLAN_OVERDUE", source_reference: `study-plan-item:${planItemId}` },
        { kind: "OBJECTIVE_REINFORCEMENT", source_reference: `mastery:${masteryId}` },
      ]),
    );

    const notifications = await db.query<{ id: string; kind: string }>(
      `select id,kind from public.institutional_notifications
       where student_id=$1 order by created_at,id`,
      [learnerId],
    );
    expect(notifications.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining([
        "MISSED_CLASS",
        "ASSIGNMENT_DEADLINE",
        "PLAN_OVERDUE",
        "MASTERY_REINFORCEMENT",
        "SUPPORT_FOLLOWUP",
      ]),
    );
    notificationId = notifications.rows[0].id;
  });

  it("is idempotent and never manufactures an INACTIVITY event", async () => {
    const before = await db.query<{ count: number }>(
      "select count(*)::int as count from public.institutional_notifications",
    );
    await refresh();
    const after = await db.query<{ count: number }>(
      "select count(*)::int as count from public.institutional_notifications",
    );
    const inactivity = await db.query<{ count: number }>(
      "select count(*)::int as count from public.support_events where kind='INACTIVITY' and deduplication_key like 'support:v1:%'",
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(inactivity.rows[0].count).toBe(0);
  });

  it("resolves a missed-class event when authoritative attendance is corrected", async () => {
    await asAuth(adminAuth);
    await db.query(
      "select public.record_attendance($1,$2,'PRESENT','Correct documented attendance')",
      [sessionId, enrolmentId],
    );
    await resetRole();
    await refresh();

    const event = await db.query<{ status: string }>(
      "select status from public.support_events where source_reference=$1 and kind='MISSED_CLASS'",
      [`attendance:${attendanceId}`],
    );
    expect(event.rows[0].status).toBe("RESOLVED");
  });

  it("resolves an approaching-deadline event after a real submission is recorded", async () => {
    await asAuth(learnerAuth);
    await db.query(
      "select public.submit_assignment($1,'Submitted response','notification-assignment-submission')",
      [assignmentId],
    );
    await resetRole();
    await refresh();

    const event = await db.query<{ status: string }>(
      "select status from public.support_events where source_reference=$1 and kind='DEADLINE_APPROACHING'",
      [`assignment:${assignmentId}`],
    );
    expect(event.rows[0].status).toBe("RESOLVED");
  });

  it("resolves plan and mastery support events when their owning records change", async () => {
    await db.query("update public.study_plan_items set status='DONE' where id=$1", [
      planItemId,
    ]);
    await db.query(
      "update public.objective_mastery set state='DEMONSTRATED' where id=$1",
      [masteryId],
    );
    await refresh();

    const rows = await db.query<{ kind: string; status: string }>(
      `select kind,status from public.support_events
       where source_reference in ($1,$2) order by kind`,
      [`study-plan-item:${planItemId}`, `mastery:${masteryId}`],
    );
    expect(rows.rows).toEqual([
      { kind: "OBJECTIVE_REINFORCEMENT", status: "RESOLVED" },
      { kind: "PLAN_OVERDUE", status: "RESOLVED" },
    ]);
  });

  it("keeps learner notifications scoped to the authenticated student", async () => {
    await asAuth(otherLearnerAuth);
    const other = await db.query(
      "select id from public.institutional_notifications where student_id=$1",
      [learnerId],
    );
    await resetRole();
    expect(other.rows).toHaveLength(0);

    await asAuth(learnerAuth);
    const own = await db.query(
      "select id from public.institutional_notifications where student_id=$1",
      [learnerId],
    );
    await resetRole();
    expect(own.rows.length).toBeGreaterThan(0);
  });

  it("lets a learner mark only their own notification read while preserving provenance", async () => {
    await asAuth(otherLearnerAuth);
    await expect(
      db.query("select public.mark_institutional_notification_read($1)", [
        notificationId,
      ]),
    ).rejects.toThrow("Access denied");
    await resetRole();

    await asAuth(learnerAuth);
    await db.query("select public.mark_institutional_notification_read($1)", [
      notificationId,
    ]);
    const read = await db.query<{ read_at: string | null }>(
      "select read_at from public.institutional_notifications where id=$1",
      [notificationId],
    );
    await resetRole();
    expect(read.rows[0].read_at).not.toBeNull();

    await expect(
      db.query(
        "update public.institutional_notifications set title='Changed provenance' where id=$1",
        [notificationId],
      ),
    ).rejects.toThrow("provenance is immutable");
    await expect(
      db.query("delete from public.institutional_notifications where id=$1", [
        notificationId,
      ]),
    ).rejects.toThrow("cannot be deleted");
  });
});
