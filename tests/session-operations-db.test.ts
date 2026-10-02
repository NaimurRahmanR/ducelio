import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildPackage } from "./activation-fixture";
import { validateCoursePackage } from "@/domain/course-package";
import type { BatchOptions } from "@/domain/session-operations";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import {
  buildCommerceFixture,
  asPolicyUser,
  administrator,
  learner,
  foreignLearner,
  type CommerceFixture,
} from "./commercial-v1-commerce-fixture";
let f: CommerceFixture;
let lesson: string;
let aclAssertion: string;
async function v<T = string>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0]?.v;
}
const start = "2030-01-05T18:00:00Z",
  end = "2030-01-05T19:00:00Z",
  next = "2030-01-06T18:00:00Z";
const create =
  "select public.create_class_session($1,$2,$3,$4,$5,'Approved session operation') as v";
const reschedule =
  "select public.reschedule_class_session($1,$2,$3,'Approved rescheduling') as v";
const batch =
  "select public.generate_class_session_batch($1,$2,$3,$4::jsonb,'Approved explicit batch') as v";
const item = (s = start, e = end, id = lesson) => ({
  lessonId: id,
  scheduledStart: s,
  scheduledEnd: e,
});
async function session(s = start, e = end) {
  return v(create, [f.cohortId, lesson, administrator, s, e]);
}
async function rejected(sql: string, args: unknown[], code: string) {
  await f.db.exec("savepoint refused");
  await expect(v(sql, args)).rejects.toThrow(code);
  await f.db.exec("rollback to savepoint refused");
}
async function generate(
  items = [item()],
  request = randomUUID(),
  activation = f.activationId,
  instructor = administrator,
) {
  return v<{ sessionIds: string[]; replay: boolean }>(batch, [
    request,
    activation,
    instructor,
    JSON.stringify(items),
  ]);
}
beforeAll(async () => {
  f = await buildCommerceFixture({ throughMigration: 48 });
  await f.db.exec("reset role");
  // Actual effective ACL under Supabase-like broad defaults, not a migration-text guess.
  expect(
    await v<boolean>(
      "select has_table_privilege('service_role','public.class_sessions','INSERT') as v",
    ),
  ).toBe(true);
  const migration = await readFile(
    "supabase/migrations/202610020049_commercial_v1_session_operations.sql",
    "utf8",
  );
  aclAssertion = migration.slice(
    migration.indexOf("do $session_operations_acl$"),
  );
  await f.db.exec(migration);
  lesson = await v(
    "select lesson_id as v from public.course_activation_lessons where import_id=$1 limit 1",
    [f.importId],
  );
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
beforeEach(async () => {
  await f.db.exec("reset role; begin");
  await asPolicyUser(f.db, 2);
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
it.each(["ACADEMIC_ADMIN", "PLATFORM_ADMIN"])(
  "%s can generate and reschedule",
  async (role) => {
    await f.db.exec("reset role");
    await f.db.query(
      "delete from public.role_grants where user_id=$1 and role in ('ACADEMIC_ADMIN','PLATFORM_ADMIN')",
      [administrator],
    );
    await f.db.query("insert into public.role_grants values($1,$2)", [
      administrator,
      role,
    ]);
    await asPolicyUser(f.db, 2);
    const result = await generate();
    expect(result.sessionIds).toHaveLength(1);
    expect(
      await v(reschedule, [result.sessionIds[0], next, randomUUID()]),
    ).toMatchObject({ replay: false });
  },
);
it.each(["REGISTRAR", "INSTRUCTOR", "COUNSELLOR", "STUDENT"])(
  "%s cannot use any scheduling mutation",
  async (role) => {
    const id = await session();
    await f.db.exec("reset role");
    await f.db.query(
      "insert into public.role_grants values($1,$2) on conflict do nothing",
      [learner, role],
    );
    await asPolicyUser(f.db, 1);
    await rejected(
      create,
      [f.cohortId, lesson, administrator, next, "2030-01-06T19:00:00Z"],
      "Access denied",
    );
    await rejected(reschedule, [id, next, randomUUID()], "FORBIDDEN");
    await rejected(
      batch,
      [randomUUID(), f.activationId, administrator, JSON.stringify([item()])],
      "FORBIDDEN",
    );
  },
);
it("deactivated actor has no scheduling authority", async () => {
  await f.db.exec("reset role");
  await f.db.query(
    "update public.app_users set account_status='DEACTIVATED' where id=$1",
    [administrator],
  );
  await asPolicyUser(f.db, 2);
  await rejected(
    batch,
    [randomUUID(), f.activationId, administrator, JSON.stringify([item()])],
    "FORBIDDEN",
  );
});
it.each(["OPEN", "CLOSED"])(
  "%s permits legacy creation, batch and replacement",
  async (status) => {
    if (status === "CLOSED")
      await v(
        "select public.admin_change_cohort_status($1,'CLOSED','Existing delivery continues') as v",
        [f.cohortId],
      );
    const id = await session();
    await v(reschedule, [id, next, randomUUID()]);
    expect(
      (await generate([item("2030-01-07T18:00:00Z", "2030-01-07T19:00:00Z")]))
        .sessionIds,
    ).toHaveLength(1);
  },
);
it("COMPLETED refuses all three operations without changing original", async () => {
  const id = await session();
  for (const status of ["CLOSED", "COMPLETED"])
    await v(
      "select public.admin_change_cohort_status($1,$2,'Delivery lifecycle operation') as v",
      [f.cohortId, status],
    );
  await rejected(
    create,
    [f.cohortId, lesson, administrator, next, "2030-01-06T19:00:00Z"],
    "COHORT_COMPLETED",
  );
  await rejected(reschedule, [id, next, randomUUID()], "COHORT_COMPLETED");
  await rejected(
    batch,
    [randomUUID(), f.activationId, administrator, JSON.stringify([item()])],
    "COHORT_COMPLETED",
  );
});
it.each(["DEACTIVATED", "NO_ROLE", "NO_PROFILE"])(
  "instructor %s is refused",
  async (state) => {
    await f.db.exec("reset role");
    if (state !== "NO_PROFILE")
      await f.db.query(
        "insert into public.staff_profiles(user_id,title) values($1,'Session teacher') on conflict do nothing",
        [foreignLearner],
      );
    if (state !== "NO_ROLE")
      await f.db.query(
        "insert into public.role_grants values($1,'INSTRUCTOR') on conflict do nothing",
        [foreignLearner],
      );
    if (state === "DEACTIVATED")
      await f.db.query(
        "update public.app_users set account_status='DEACTIVATED' where id=$1",
        [foreignLearner],
      );
    await asPolicyUser(f.db, 2);
    await rejected(
      batch,
      [randomUUID(), f.activationId, foreignLearner, JSON.stringify([item()])],
      state === "DEACTIVATED" ? "STAFF_DEACTIVATED" : "INVALID_INSTRUCTOR",
    );
  },
);
it("replacement preserves exact duration, immutable identity and linked audit; replay creates nothing", async () => {
  const id = await session(start, "2030-01-05T19:23:17Z"),
    req = randomUUID();
  const result = await v<{ sessionIds: string[] }>(reschedule, [id, next, req]);
  expect(await v(reschedule, [id, next, req])).toMatchObject({
    replay: true,
    sessionIds: result.sessionIds,
  });
  const rows = (
    await f.db.query<{ id: string; status: string; duration: string }>(
      "select id,status,(scheduled_end-scheduled_start)::text duration from public.class_sessions where cohort_id=$1 order by scheduled_start",
      [f.cohortId],
    )
  ).rows;
  expect(rows.map((r) => r.status)).toEqual(["CANCELLED", "SCHEDULED"]);
  expect(rows[1].duration).toBe(rows[0].duration);
  await f.db.exec("reset role");
  expect(
    await v<number>(
      "select count(*)::int as v from public.audit_events where action='CLASS_SESSION_RESCHEDULED' and target_id=$1 and actor_id=$2",
      [id, administrator],
    ),
  ).toBe(1);
  expect(
    await v(
      "select r.original_id as v from public.class_session_operation_receipts r join public.class_session_operation_items i using(request_id) where i.session_id=$1",
      [result.sessionIds[0]],
    ),
  ).toBe(id);
  await rejected(
    reschedule,
    [id, "2030-01-07T18:00:00Z", req],
    "REQUEST_CONFLICT",
  );
  await rejected(reschedule, [id, next, randomUUID()], "ALREADY_RESCHEDULED");
});
it("failed replacement conflict atomically retains the scheduled original and leaves no receipt", async () => {
  const id = await session();
  await session(next, "2030-01-06T19:00:00Z");
  const req = randomUUID();
  await rejected(reschedule, [id, next, req], "overlapping");
  expect(
    await v("select status as v from public.class_sessions where id=$1", [id]),
  ).toBe("SCHEDULED");
  await f.db.exec("reset role");
  expect(
    await v<number>(
      "select count(*)::int as v from public.class_session_operation_receipts where request_id=$1",
      [req],
    ),
  ).toBe(0);
});
it.each(["COMPLETED", "CANCELLED", "STARTED"])(
  "%s original cannot move",
  async (state) => {
    const id = await session(
      state === "STARTED" ? "2020-01-01T18:00:00Z" : start,
      state === "STARTED" ? "2020-01-01T19:00:00Z" : end,
    );
    if (state !== "STARTED") {
      await f.db.exec("reset role");
      await f.db.query(
        "update public.class_sessions set status=$2 where id=$1",
        [id, state],
      );
      await asPolicyUser(f.db, 2);
    }
    await rejected(
      reschedule,
      [id, next, randomUUID()],
      state === "STARTED" ? "SESSION_STARTED" : "SESSION_CLOSED",
    );
  },
);
it("replacement must be future and original timestamps stay immutable", async () => {
  const id = await session();
  await rejected(
    reschedule,
    [id, "2020-01-01T18:00:00Z", randomUUID()],
    "REPLACEMENT_NOT_FUTURE",
  );
  await f.db.exec("reset role");
  await rejected(
    "update public.class_sessions set scheduled_start=$2 where id=$1 returning id as v",
    [id, next],
    "immutable",
  );
});
it("adjacent batch sessions are allowed and canonical ordering gives stable replay", async () => {
  const rows = [item("2030-01-05T19:00:00Z", "2030-01-05T20:00:00Z"), item()];
  const req = randomUUID();
  const a = await generate(rows, req);
  expect(a.sessionIds).toHaveLength(2);
  expect(await generate(rows.reverse(), req)).toMatchObject({
    replay: true,
    sessionIds: a.sessionIds,
  });
  await rejected(
    batch,
    [req, f.activationId, administrator, JSON.stringify([item()])],
    "REQUEST_CONFLICT",
  );
});
it.each(["duplicate", "overlap"])(
  "batch refuses internal %s atomically",
  async (kind) => {
    await rejected(
      batch,
      [
        randomUUID(),
        f.activationId,
        administrator,
        JSON.stringify([
          item(),
          kind === "duplicate"
            ? item()
            : item("2030-01-05T18:30:00Z", "2030-01-05T20:00:00Z"),
        ]),
      ],
      "BATCH_INTERNAL_OVERLAP",
    );
    expect(
      await v<number>(
        "select count(*)::int as v from public.class_sessions where cohort_id=$1",
        [f.cohortId],
      ),
    ).toBe(0);
  },
);
it("batch rejects foreign activation lesson, missing activation and invalid interval", async () => {
  await rejected(
    batch,
    [
      randomUUID(),
      f.activationId,
      administrator,
      JSON.stringify([item(start, end, randomUUID())]),
    ],
    "ACTIVATION_LESSON_MISMATCH",
  );
  await rejected(
    batch,
    [randomUUID(), randomUUID(), administrator, JSON.stringify([item()])],
    "ACTIVATION_NOT_FOUND",
  );
  await rejected(
    batch,
    [
      randomUUID(),
      f.activationId,
      administrator,
      JSON.stringify([item(end, start)]),
    ],
    "INVALID_INTERVAL",
  );
});
it("batch existing cohort conflict rolls back every row and receipt", async () => {
  await session();
  const req = randomUUID();
  await rejected(
    batch,
    [
      req,
      f.activationId,
      administrator,
      JSON.stringify([item(next, "2030-01-06T19:00:00Z"), item()]),
    ],
    "overlapping",
  );
  await f.db.exec("reset role");
  expect(
    await v<number>(
      "select count(*)::int as v from public.class_session_operation_items",
    ),
  ).toBe(0);
});
it("batch rejects instructor conflict across cohorts", async () => {
  await f.db.exec("reset role");
  const cohort = await v(
    "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Other teaching cohort',current_date) returning id as v",
    [f.programmeVersionId],
  );
  await asPolicyUser(f.db, 2);
  await v(create, [cohort, lesson, administrator, start, end]);
  await rejected(
    batch,
    [randomUUID(), f.activationId, administrator, JSON.stringify([item()])],
    "Instructor already",
  );
});
it("batch does not regenerate cancelled history", async () => {
  const id = await session();
  await v(
    "select public.change_class_session_status($1,'CANCELLED','Cancelled teaching history') as v",
    [id],
  );
  await rejected(
    batch,
    [randomUUID(), f.activationId, administrator, JSON.stringify([item()])],
    "CANCELLED_HISTORY_MATCH",
  );
});
it("100 is a per-request bound; further batches remain valid", async () => {
  const items = Array.from({ length: 100 }, (_, i) =>
    item(
      new Date(Date.UTC(2031, 0, 1, i * 2)).toISOString(),
      new Date(Date.UTC(2031, 0, 1, i * 2 + 1)).toISOString(),
    ),
  );
  await rejected(
    batch,
    [
      randomUUID(),
      f.activationId,
      administrator,
      JSON.stringify([...items, item()]),
    ],
    "BATCH_REQUEST_LIMIT",
  );
  expect((await generate(items)).sessionIds).toHaveLength(100);
  expect(
    (await generate([item("2032-01-01T18:00:00Z", "2032-01-01T19:00:00Z")]))
      .sessionIds,
  ).toHaveLength(1);
});
it("discovery paginates 50 with truthful hasMore and filters", async () => {
  await generate(
    Array.from({ length: 51 }, (_, i) =>
      item(
        new Date(Date.UTC(2031, 0, 1, i * 2)).toISOString(),
        new Date(Date.UTC(2031, 0, 1, i * 2 + 1)).toISOString(),
      ),
    ),
  );
  const sql =
    "select public.admin_list_class_session_operations($1,'SCHEDULED',null,null,$2) as v";
  expect(await v(sql, [f.cohortId, 0])).toMatchObject({ hasMore: true });
  expect(
    (await v<{ rows: unknown[] }>(sql, [f.cohortId, 50])).rows,
  ).toHaveLength(1);
  expect(
    (
      await v<{ rows: unknown[] }>(
        "select public.admin_list_class_session_operations(null,'CANCELLED') as v",
      )
    ).rows,
  ).toHaveLength(0);
});
it("effective application write ACLs are denied while owner and governed RPC remain usable", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect(
      await v<boolean>(
        "select has_table_privilege($1,'public.class_sessions','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') or has_any_column_privilege($1,'public.class_sessions','INSERT,UPDATE') as v",
        [role],
      ),
    ).toBe(false);
  }
  expect(await session()).toBeTruthy();
});
it("learner timetable sees cancelled original and replacement, without rewriting academic history", async () => {
  await v(
    "select public.create_enrolment($1,$2,'Academic timetable enrolment') as v",
    [learner, f.cohortId],
  );
  const id = await session();
  const r = await v<{ sessionIds: string[] }>(reschedule, [
    id,
    next,
    randomUUID(),
  ]);
  await asPolicyUser(f.db, 1);
  const rows = (
    await f.db.query<{ id: string; status: string }>(
      "select id,status from public.list_my_class_sessions() where id in ($1,$2)",
      [id, r.sessionIds[0]],
    )
  ).rows;
  expect(rows.map((x) => x.status)).toEqual(["CANCELLED", "SCHEDULED"]);
});
it("shared lock target and ordering protect instructor eligibility against People mutations", async () => {
  await f.db.exec("reset role");
  const body = await v(
    "select prosrc as v from pg_proc where oid='session_operations_private.instructor(uuid)'::regprocedure",
  );
  expect(body.indexOf("public.app_users")).toBeLessThan(
    body.indexOf("public.staff_profiles"),
  );
  expect(body).toContain("for update");
  const people = await v(
    "select prosrc as v from pg_proc where oid='admin_control_private.lock_person(uuid)'::regprocedure",
  );
  expect(people).toContain("public.app_users");
  expect(people).toContain("for update");
});

it("hardened legacy authority rejects unknown cohort, draft version and foreign curriculum", async () => {
  await rejected(
    create,
    [randomUUID(), lesson, administrator, start, end],
    "Cohort not found",
  );
  await rejected(
    create,
    [f.cohortId, randomUUID(), administrator, start, end],
    "Lesson must belong",
  );
  await f.db.exec("reset role");
  const version = await v(
    "insert into public.programme_versions(programme_id,label) select programme_id,'Draft scheduling version' from public.programme_versions where id=$1 returning id as v",
    [f.programmeVersionId],
  );
  const cohort = await v(
    "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Draft delivery',current_date) returning id as v",
    [version],
  );
  await asPolicyUser(f.db, 2);
  await rejected(
    create,
    [cohort, lesson, administrator, start, end],
    "published programme version",
  );
});
it("replacement identity stays fixed and discovery exposes predecessor/successor", async () => {
  const id = await session();
  const result = await v<{ sessionIds: string[] }>(reschedule, [
    id,
    next,
    randomUUID(),
  ]);
  const identities = (
    await f.db.query(
      "select cohort_id,programme_version_id,lesson_id,instructor_id from public.class_sessions where id in ($1,$2) order by scheduled_start",
      [id, result.sessionIds[0]],
    )
  ).rows;
  expect(identities[0]).toEqual(identities[1]);
  const before = await v<{ rows: { replacementId: string }[] }>(
    "select public.admin_list_class_session_operations(null,null,null,null,0,$1) as v",
    [id],
  );
  expect(before.rows[0].replacementId).toBe(result.sessionIds[0]);
  const after = await v<{ rows: { originalId: string }[] }>(
    "select public.admin_list_class_session_operations(null,null,null,null,0,$1) as v",
    [result.sessionIds[0]],
  );
  expect(after.rows[0].originalId).toBe(id);
});
it("teacher eligibility is rechecked by creation and replacement under the shared lock", async () => {
  const id = await session();
  await f.db.exec("reset role");
  await f.db.query(
    "delete from public.role_grants where user_id=$1 and role='INSTRUCTOR'",
    [administrator],
  );
  await asPolicyUser(f.db, 2);
  await rejected(
    create,
    [f.cohortId, lesson, administrator, next, "2030-01-06T19:00:00Z"],
    "INVALID_INSTRUCTOR",
  );
  await rejected(reschedule, [id, next, randomUUID()], "INVALID_INSTRUCTOR");
  expect(
    await v("select status as v from public.class_sessions where id=$1", [id]),
  ).toBe("SCHEDULED");
});
it("People live-teaching guard remains authoritative after scheduling", async () => {
  await f.db.exec("reset role");
  await f.db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Independent teacher')",
    [foreignLearner],
  );
  await f.db.query(
    "insert into public.role_grants values($1,'INSTRUCTOR'),($2,'PLATFORM_ADMIN')",
    [foreignLearner, administrator],
  );
  await asPolicyUser(f.db, 2);
  await v(create, [f.cohortId, lesson, foreignLearner, start, end]);
  await rejected(
    "select public.admin_revoke_role($1,'INSTRUCTOR','Governed role review') as v",
    [foreignLearner],
    "ACTIVE_TEACHING_ASSIGNMENTS",
  );
});
it("rescheduling refuses existing institutional history without moving or deleting it", async () => {
  const enrolment = await v(
    "select public.create_enrolment($1,$2,'Historical academic enrolment') as v",
    [learner, f.cohortId],
  );
  const id = await session();
  await f.db.exec("reset role");
  await f.db.query(
    "insert into public.attendance_records(session_id,enrolment_id,student_id,status,recorded_by,updated_by) values($1,$2,$3,'EXCUSED',$4,$4)",
    [id, enrolment, learner, administrator],
  );
  await asPolicyUser(f.db, 2);
  await rejected(reschedule, [id, next, randomUUID()], "SESSION_HAS_HISTORY");
  await f.db.exec("reset role");
  expect(
    await v(
      "select session_id as v from public.attendance_records where enrolment_id=$1",
      [enrolment],
    ),
  ).toBe(id);
  expect(
    await v("select status as v from public.class_sessions where id=$1", [id]),
  ).toBe("SCHEDULED");
});
it("batch records individual audits and one immutable receipt; replay adds no audit", async () => {
  const req = randomUUID();
  const rows = [item(), item(next, "2030-01-06T19:00:00Z")];
  const result = await generate(rows, req);
  await generate(rows, req);
  await f.db.exec("reset role");
  expect(
    await v<number>(
      "select count(*)::int as v from public.audit_events where action='CLASS_SESSION_BATCH_GENERATED' and target_id=$1 and actor_id=$2",
      [req, administrator],
    ),
  ).toBe(1);
  expect(
    await v<number>(
      "select count(*)::int as v from public.audit_events where target_type='class_sessions' and target_id=any($1::uuid[])",
      [result.sessionIds],
    ),
  ).toBe(2);
  await rejected(
    "update public.class_session_operation_receipts set reason='Modified audit reason' where request_id=$1 returning request_id as v",
    [req],
    "immutable",
  );
});
it("discovery enforces date windows and refuses non-admin inspection", async () => {
  await generate([item(), item(next, "2030-01-06T19:00:00Z")]);
  expect(
    (
      await v<{ rows: unknown[] }>(
        "select public.admin_list_class_session_operations($1,null,$2,$3) as v",
        [f.cohortId, start, next],
      )
    ).rows,
  ).toHaveLength(1);
  await asPolicyUser(f.db, 1);
  await rejected(
    "select public.admin_list_class_session_operations() as v",
    [],
    "FORBIDDEN",
  );
  await rejected(
    "select public.admin_class_session_batch_options($1) as v",
    [f.activationId],
    "FORBIDDEN",
  );
});
it("activation options expose only mapped lessons and selected default instructor", async () => {
  expect(
    await v("select public.admin_class_session_batch_options($1) as v", [
      f.activationId,
    ]),
  ).toMatchObject({
    hasMore: false,
    lessonsHasMore: false,
    activations: [{ id: f.activationId, instructorId: administrator }],
    lessons: [{ id: lesson }],
  });
});

const classroomInsert =
  "insert into public.professor_classroom_sessions(student_id,class_session_id,enrolment_id,programme_version_id,lesson_id,mode,first_opened_at,last_opened_at) values($1,$2,$3,$4,$5,'CATCH_UP',clock_timestamp(),clock_timestamp()) returning id as v";
async function enrolment() {
  return v(
    "select public.create_enrolment($1,$2,'Classroom retained history enrolment') as v",
    [learner, f.cohortId],
  );
}
it.each(["SCHEDULED", "COMPLETED"])(
  "classroom parent guard preserves non-cancelled %s insertion",
  async (status) => {
    const e = await enrolment();
    const id = await session("2020-01-01T18:00:00Z", "2020-01-01T19:00:00Z");
    if (status === "COMPLETED")
      await v(
        "select public.change_class_session_status($1,'COMPLETED','Finished historical teaching') as v",
        [id],
      );
    await f.db.exec("reset role");
    expect(
      await v(classroomInsert, [learner, id, e, f.programmeVersionId, lesson]),
    ).toBeTruthy();
  },
);
it("classroom insert cannot commit against a cancelled original or missing parent", async () => {
  const e = await enrolment(),
    id = await session();
  await v(reschedule, [id, next, randomUUID()]);
  await f.db.exec("reset role");
  await rejected(
    classroomInsert,
    [learner, id, e, f.programmeVersionId, lesson],
    "CLASSROOM_PARENT_UNAVAILABLE",
  );
  await rejected(
    classroomInsert,
    [learner, randomUUID(), e, f.programmeVersionId, lesson],
    "CLASSROOM_PARENT_UNAVAILABLE",
  );
  expect(
    await v<number>(
      "select count(*)::int as v from public.professor_classroom_sessions",
    ),
  ).toBe(0);
});
it("existing classroom history refuses reschedule and retains its original identity", async () => {
  const e = await enrolment(),
    id = await session();
  await f.db.exec("reset role");
  const classroom = await v(classroomInsert, [
    learner,
    id,
    e,
    f.programmeVersionId,
    lesson,
  ]);
  await asPolicyUser(f.db, 2);
  await rejected(reschedule, [id, next, randomUUID()], "SESSION_HAS_HISTORY");
  await f.db.exec("reset role");
  expect(
    await v(
      "select class_session_id as v from public.professor_classroom_sessions where id=$1",
      [classroom],
    ),
  ).toBe(id);
  expect(
    await v("select status as v from public.class_sessions where id=$1", [id]),
  ).toBe("SCHEDULED");
});
it("classroom parent insertion takes a conflicting row lock and rechecks parent status in a private trigger", async () => {
  await f.db.exec("reset role");
  const body = await v(
    "select prosrc as v from pg_proc where oid='session_operations_private.classroom_parent_guard()'::regprocedure",
  );
  expect(body).toMatch(
    /select status[\s\S]+public\.class_sessions[\s\S]+for share/i,
  );
  expect(body).toContain("parent_status='CANCELLED'");
  expect(body).toContain("not found");
  const trigger = await v<number>(
    "select count(*)::int as v from pg_trigger where tgrelid='public.professor_classroom_sessions'::regclass and tgfoid='session_operations_private.classroom_parent_guard()'::regprocedure and (tgtype & 2)=2 and (tgtype & 4)=4",
  );
  expect(trigger).toBe(1);
});
it("effective ACL matrix includes private schema/helpers, metadata columns and exact authenticated RPC signatures", async () => {
  await f.db.exec("reset role");
  await f.db.exec(aclAssertion);
  expect(
    await v<boolean>(
      "select has_table_privilege('authenticated','public.class_sessions','SELECT') as v",
    ),
  ).toBe(true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect(
      await v<boolean>(
        "select has_schema_privilege($1,'session_operations_private','USAGE,CREATE') as v",
        [role],
      ),
    ).toBe(false);
    expect(
      await v<number>(
        "select count(*)::int as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='session_operations_private' and has_function_privilege($1,p.oid,'EXECUTE')",
        [role],
      ),
    ).toBe(0);
    for (const table of [
      "public.class_session_operation_receipts",
      "public.class_session_operation_items",
    ]) {
      expect(
        await v<boolean>(
          "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as v",
          [role, table],
        ),
      ).toBe(false);
    }
    for (const rpc of [
      "public.create_class_session(uuid,uuid,uuid,timestamptz,timestamptz,text)",
      "public.reschedule_class_session(uuid,timestamptz,uuid,text)",
      "public.generate_class_session_batch(uuid,uuid,uuid,jsonb,text)",
      "public.admin_list_class_session_operations(uuid,text,timestamptz,timestamptz,integer,uuid)",
      "public.admin_class_session_batch_options(uuid,integer,integer)",
    ]) {
      expect(
        await v<boolean>(
          "select has_function_privilege($1,$2,'EXECUTE') as v",
          [role, rpc],
        ),
      ).toBe(role === "authenticated");
    }
  }
});
async function inheritedRole() {
  await f.db.exec(
    "reset role; create role session_operations_test_inherited nologin; grant session_operations_test_inherited to anon,authenticated,service_role",
  );
}
it.each(["INSERT", "UPDATE", "DELETE", "TRUNCATE", "TRIGGER"])(
  "closing ACL assertion rejects inherited class-session %s",
  async (privilege) => {
    await inheritedRole();
    await f.db.exec(
      `grant ${privilege} on public.class_sessions to session_operations_test_inherited`,
    );
    await rejected(
      aclAssertion,
      [],
      "Unsafe effective class-session write privileges",
    );
  },
);
it.each(["INSERT", "UPDATE"])(
  "closing ACL assertion rejects inherited column-only %s",
  async (privilege) => {
    await inheritedRole();
    await f.db.exec(
      `grant ${privilege} (id) on public.class_sessions to session_operations_test_inherited`,
    );
    expect(
      await v<boolean>(
        "select has_table_privilege('anon','public.class_sessions','INSERT,UPDATE') as v",
      ),
    ).toBe(false);
    await rejected(
      aclAssertion,
      [],
      "Unsafe effective class-session write privileges",
    );
  },
);
it.each(["class_session_operation_receipts", "class_session_operation_items"])(
  "closing ACL assertion rejects inherited %s reads",
  async (table) => {
    await inheritedRole();
    await f.db.exec(
      `grant select on public.${table} to session_operations_test_inherited`,
    );
    await rejected(
      aclAssertion,
      [],
      "Unsafe effective session-operation metadata privileges",
    );
  },
);
it("closing ACL assertion rejects metadata column-only access", async () => {
  await inheritedRole();
  await f.db.exec(
    "grant select (request_id) on public.class_session_operation_receipts to session_operations_test_inherited",
  );
  await rejected(
    aclAssertion,
    [],
    "Unsafe effective session-operation metadata privileges",
  );
});
it.each(["USAGE", "CREATE"])(
  "closing ACL assertion rejects inherited private schema %s",
  async (privilege) => {
    await inheritedRole();
    await f.db.exec(
      `grant ${privilege} on schema session_operations_private to session_operations_test_inherited`,
    );
    await rejected(
      aclAssertion,
      [],
      "Unsafe effective session-operation schema privileges",
    );
  },
);
it("closing ACL assertion rejects inherited private helper EXECUTE", async () => {
  await inheritedRole();
  await f.db.exec(
    "grant execute on function session_operations_private.classroom_parent_guard() to session_operations_test_inherited",
  );
  await rejected(
    aclAssertion,
    [],
    "Unsafe effective session-operation function privileges",
  );
});
it("closing ACL assertion refuses public RPC exposure to service-role and unreviewed authenticated overloads", async () => {
  await f.db.exec(
    "reset role; grant execute on function public.reschedule_class_session(uuid,timestamptz,uuid,text) to service_role",
  );
  await rejected(
    aclAssertion,
    [],
    "Unsafe effective session-operation function privileges",
  );
  await f.db.exec(
    "revoke execute on function public.reschedule_class_session(uuid,timestamptz,uuid,text) from service_role; create function public.reschedule_class_session(integer) returns integer language sql set search_path='' as 'select 1'; revoke all on function public.reschedule_class_session(integer) from public,anon,authenticated,service_role; grant execute on function public.reschedule_class_session(integer) to authenticated",
  );
  await rejected(
    aclAssertion,
    [],
    "Unsafe effective session-operation function privileges",
  );
});
const optionsSql =
  "select public.admin_class_session_batch_options($1,$2,$3) as v";
it("activation pages are deterministic, later activations reachable and off-page selection usable in a batch", async () => {
  await f.db.exec("reset role");
  await f.db.query(
    `with extra as (insert into public.cohorts(programme_version_id,title,starts_on) select $1,'Pagination cohort '||n,current_date from generate_series(1,200) n returning id)
    insert into public.course_activations(import_id,programme_version_id,cohort_id,instructor_id,request_hash,created_by,created_at)
    select $2,$1,id,$3,repeat('c',64),$3,'2030-01-01T00:00:00Z' from extra`,
    [f.programmeVersionId, f.importId, administrator],
  );
  await asPolicyUser(f.db, 2);
  const first = await v<BatchOptions>(optionsSql, [null, 0, 0]),
    last = await v<BatchOptions>(optionsSql, [null, 200, 0]);
  expect(first.hasMore).toBe(true);
  expect(first.activations).toHaveLength(200);
  expect(first.selectedActivation).toBeNull();
  expect(first.lessons).toEqual([]);
  expect(last.hasMore).toBe(false);
  expect(last.activations).toHaveLength(1);
  expect(await v<BatchOptions>(optionsSql, [null, 200, 0])).toEqual(last);
  const selected = last.activations[0];
  const selectedOnFirst = await v<BatchOptions>(optionsSql, [
    selected.id,
    0,
    0,
  ]);
  expect(selectedOnFirst.activations.some((x) => x.id === selected.id)).toBe(
    false,
  );
  expect(selectedOnFirst.selectedActivation).toEqual(selected);
  expect(selectedOnFirst.lessons[0].id).toBe(lesson);
  expect(
    (await generate([item()], randomUUID(), selected.id)).sessionIds,
  ).toHaveLength(1);
  await f.db.exec("reset role");
  const ordered = (
    await f.db.query<{ id: string }>(
      "select id from public.course_activations order by created_at,id",
    )
  ).rows.map((x) => x.id);
  expect([...first.activations, ...last.activations].map((x) => x.id)).toEqual(
    ordered,
  );
});
async function largeActivatedCourse() {
  // Build real published, activated curriculum via the established authorities.
  const pkg = buildPackage();
  pkg.packageKey = `session-pagination-${randomUUID()}`;
  const original = structuredClone(pkg.modules[0].lessons[0]);
  pkg.modules[0].lessons = Array.from({ length: 250 }, (_, i) => ({
    ...structuredClone(original),
    key: `lesson-${i + 1}`,
    title: `Lesson ${i + 1}`,
    position: i + 1,
  }));
  pkg.modules.push({
    ...structuredClone(pkg.modules[0]),
    key: "module-2",
    title: "Later module",
    position: 2,
    lessons: [
      {
        ...structuredClone(original),
        key: "lesson-251",
        title: "Lesson 251",
        position: 1,
      },
    ],
  });
  const validated = validateCoursePackage(pkg);
  expect(validated.valid).toBe(true);
  if (!validated.valid)
    throw new Error("Pagination course fixture validation failed");
  const imported = await v(
    "select public.import_course_package($1,1,$2,$3::jsonb,'Pagination course import') as v",
    [pkg.packageKey, pkg.schemaVersion, JSON.stringify(pkg)],
  );
  await v(
    "select public.mark_course_package_validated($1,$2::jsonb,'Pagination course validated') as v",
    [imported, JSON.stringify(validated.report)],
  );
  const version = await v(
    "select public.apply_course_package($1,'Pagination curriculum applied') as v",
    [imported],
  );
  for (const role of [
    "PROFESSOR",
    "TUTOR",
    "LAB_INSTRUCTOR",
    "EXAMINER",
    "COUNSELLOR",
  ])
    await v(
      "select public.set_agent_config($1,$2,false,null,null,'{}','NONE','Pagination disabled agent config') as v",
      [version, role],
    );
  expect(
    await v(
      "select outcome as v from public.run_course_package_test($1,'Pagination pre-publication test')",
      [imported],
    ),
  ).toBe("PASS");
  await v(
    "select public.publish_course_package($1,'Pagination publication') as v",
    [imported],
  );
  await f.db.exec("reset role");
  const cohort = await v(
    "insert into public.cohorts(programme_version_id,title,starts_on) values($1,'Large curriculum cohort',current_date) returning id as v",
    [version],
  );
  await asPolicyUser(f.db, 2);
  const windows = [
    {
      templateKey: "assess-1",
      opensAt: new Date(Date.now() - 3600000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ];
  return v(
    "select public.activate_course_package($1,$2,$3,'[]'::jsonb,$4::jsonb,'Pagination course activation') as v",
    [imported, cohort, administrator, JSON.stringify(windows)],
  );
}
it("lesson page after 250 is reachable and its lesson can fund an independent governed batch", async () => {
  const activation = await largeActivatedCourse();
  const first = await v<BatchOptions>(optionsSql, [activation, 0, 0]);
  expect(first.lessons).toHaveLength(250);
  expect(first.lessonsHasMore).toBe(true);
  const last = await v<BatchOptions>(optionsSql, [activation, 0, 250]);
  expect(last.lessons).toHaveLength(1);
  expect(last.lessonsHasMore).toBe(false);
  expect(last.lessons[0].title).toBe("Lesson 251");
  expect(last.selectedActivation?.id).toBe(activation);
  expect(await v<BatchOptions>(optionsSql, [activation, 0, 250])).toEqual(last);
  expect(
    (
      await generate(
        [item(start, end, last.lessons[0].id)],
        randomUUID(),
        activation,
      )
    ).sessionIds,
  ).toHaveLength(1);
});
it.each([-1, null])("both option offsets refuse %s", async (value) => {
  await rejected(optionsSql, [f.activationId, value, 0], "INVALID_INPUT");
  await rejected(optionsSql, [f.activationId, 0, value], "INVALID_INPUT");
});
it("option offsets reject malformed/overflow values; integer transport maximum returns a bounded empty page", async () => {
  await rejected(
    optionsSql,
    [f.activationId, "invalid", 0],
    "invalid input syntax",
  );
  await rejected(optionsSql, [f.activationId, 0, 2147483648], "out of range");
  expect(
    await v<BatchOptions>(optionsSql, [f.activationId, 2147483647, 2147483647]),
  ).toMatchObject({
    hasMore: false,
    lessonsHasMore: false,
    activations: [],
    lessons: [],
    selectedActivation: { id: f.activationId },
  });
});
