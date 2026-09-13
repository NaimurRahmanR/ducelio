import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  classroomFixture,
  asClassroomUser,
  scheduleClassSession,
  learner,
  learnerAuth,
  foreignLearner,
  foreignAuth,
  instructorAuth,
  otherCohortId,
  cohortId,
  lessonId,
  type ClassroomFixture,
} from "./professor-classroom-fixture";

let f: ClassroomFixture;
beforeAll(async () => {
  f = await classroomFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role; reset request.jwt.claim.sub");
});
afterAll(async () => {
  await f.db?.close();
});

async function open(db: PGlite, classSessionId: string, auth: string) {
  await asClassroomUser(db, auth);
  return (
    await db.query<{ value: unknown }>(
      "select public.open_professor_classroom($1) as value",
      [classSessionId],
    )
  ).rows[0].value as
    | { ok: true; classroom: Record<string, unknown> }
    | { ok: false; code: string };
}
async function interact(
  db: PGlite,
  classSessionId: string,
  key: string,
  auth: string,
) {
  await asClassroomUser(db, auth);
  return (
    await db.query<{ value: unknown }>(
      "select public.record_professor_classroom_interaction($1,$2) as value",
      [classSessionId, key],
    )
  ).rows[0].value as
    { ok: true; duplicate: boolean } | { ok: false; code: string };
}
async function reject(db: PGlite, sql: string, args: unknown[] = []) {
  await db.exec("savepoint denial");
  try {
    await expect(db.query(sql, args)).rejects.toThrow();
  } finally {
    await db.exec("rollback to savepoint denial; release savepoint denial");
  }
}

describe("professor classroom: ownership and eligibility", () => {
  it("opens a LIVE classroom for a currently-scheduled session owned by the learner", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2026-09-13T09:00:00Z",
      "2026-09-13T10:00:00Z",
    );
    // clock_timestamp() drives eligibility; this fixed window is chosen to
    // straddle "now" only in the sense that the DB independently computes
    // LIVE/CATCH_UP itself -- the test below proves both branches directly
    // by using explicit past/future windows instead of depending on the
    // real wall clock.
    const result = await open(f.db, sessionId, learnerAuth);
    expect(result.ok).toBe(true);
  });

  it("computes LIVE for a session whose window currently contains the moment of the call", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2026-01-01T00:00:00Z",
      "2099-01-01T00:00:00Z",
    );
    const result = await open(f.db, sessionId, learnerAuth);
    expect(result).toMatchObject({ ok: true, classroom: { mode: "LIVE" } });
  });

  it("computes CATCH_UP for a session whose window has already ended", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const result = await open(f.db, sessionId, learnerAuth);
    expect(result).toMatchObject({
      ok: true,
      classroom: { mode: "CATCH_UP" },
    });
  });

  it("refuses a future session with NOT_YET_STARTED: no early classroom start", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2099-01-01T00:00:00Z",
      "2099-01-01T01:00:00Z",
    );
    const result = await open(f.db, sessionId, learnerAuth);
    expect(result).toMatchObject({ ok: false, code: "NOT_YET_STARTED" });
  });

  it("refuses a cancelled session with CANCELLED, regardless of its scheduled time", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await asClassroomUser(f.db, instructorAuth);
    await f.db.query(
      "select public.change_class_session_status($1,'CANCELLED','Classroom fixture cancellation')",
      [sessionId],
    );
    const result = await open(f.db, sessionId, learnerAuth);
    expect(result).toMatchObject({ ok: false, code: "CANCELLED" });
  });

  it("denies a wholly foreign learner (no enrolment at all)", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const result = await open(f.db, sessionId, foreignAuth);
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("denies a learner with a real enrolment for a DIFFERENT cohort/programme relationship", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await asClassroomUser(f.db, instructorAuth);
    await f.db.query(
      "select public.create_enrolment($1,$2,'Classroom fixture mismatched enrolment')",
      [foreignLearner, otherCohortId],
    );
    const result = await open(f.db, sessionId, foreignAuth);
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("denies a non-existent class session id", async () => {
    const result = await open(
      f.db,
      "00000000-0000-4000-8000-000000000000",
      learnerAuth,
    );
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("denies an unauthenticated caller", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const result = await open(f.db, sessionId, "");
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("professor classroom: resume, non-authoritative persistence, idempotency", () => {
  it("is idempotent/resumable: opening the same session twice returns the same classroom row with an advancing lastOpenedAt", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const first = await open(f.db, sessionId, learnerAuth);
    const second = await open(f.db, sessionId, learnerAuth);
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(second.classroom.classroomId).toBe(first.classroom.classroomId);
    expect(second.classroom.firstOpenedAt).toBe(first.classroom.firstOpenedAt);
    await f.db.exec("reset role");
    const [row] = (
      await f.db.query<{ count: number }>(
        "select count(*)::int as count from public.professor_classroom_sessions where class_session_id=$1",
        [sessionId],
      )
    ).rows;
    expect(row.count).toBe(1);
    await f.db.exec("set role authenticated");
  });

  it("records first/last opened timestamps and correctly derived relationships", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const result = await open(f.db, sessionId, learnerAuth);
    if (!result.ok) throw new Error("expected success");
    expect(result.classroom).toMatchObject({
      classSessionId: sessionId,
      lessonId,
      mode: "CATCH_UP",
      lessonTitle: "Access Control Fundamentals — DEMO",
    });
    expect(result.classroom.firstOpenedAt).toBeTruthy();
    expect(result.classroom.lastOpenedAt).toBeTruthy();
  });

  it("classroom state cannot alter attendance, learning evidence or mastery", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    await interact(f.db, sessionId, "key-1", learnerAuth);
    await f.db.exec("reset role");
    const attendance = await f.db.query<{ count: number }>(
      "select count(*)::int as count from public.attendance_records where session_id=$1",
      [sessionId],
    );
    expect(attendance.rows[0].count).toBe(0);
    const evidence = await f.db.query<{ count: number }>(
      "select count(*)::int as count from public.learning_evidence where student_id=$1",
      [learner],
    );
    expect(evidence.rows[0].count).toBe(0);
    const mastery = await f.db.query<{ count: number }>(
      "select count(*)::int as count from public.objective_mastery where student_id=$1",
      [learner],
    );
    expect(mastery.rows[0].count).toBe(0);
    await f.db.exec("set role authenticated");
  });

  it("a fresh idempotency key proceeds; the same key repeated is reported as a duplicate", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    const firstAttempt = await interact(
      f.db,
      sessionId,
      "same-key",
      learnerAuth,
    );
    expect(firstAttempt).toMatchObject({ ok: true, duplicate: false });
    const replay = await interact(f.db, sessionId, "same-key", learnerAuth);
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    const differentKey = await interact(
      f.db,
      sessionId,
      "different-key",
      learnerAuth,
    );
    expect(differentKey).toMatchObject({ ok: true, duplicate: false });
  });

  // Correction pass (independent review, Blocker 1): idempotency must
  // survive OUT-OF-ORDER replay, not merely "compare against the most
  // recently seen key". K1 then K2 then a REPLAYED K1 must still be
  // reported as a duplicate -- proving durable per-classroom uniqueness
  // (professor_classroom_interaction_reservations, migration 026) rather
  // than the old, insufficient "compare against last_interaction_key" design
  // that this exact sequence would have defeated (K1 -> accepted, K2 ->
  // accepted/last key becomes K2, K1 replayed -> WRONGLY accepted again
  // because only K2 was ever remembered).
  it("old-key replay remains a duplicate even after an intervening different key: K1 -> K2 -> K1 replay", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    const k1 = await interact(f.db, sessionId, "K1", learnerAuth);
    expect(k1).toMatchObject({ ok: true, duplicate: false });
    const k2 = await interact(f.db, sessionId, "K2", learnerAuth);
    expect(k2).toMatchObject({ ok: true, duplicate: false });
    const k1Replayed = await interact(f.db, sessionId, "K1", learnerAuth);
    expect(k1Replayed).toMatchObject({ ok: true, duplicate: true });
    // A further replay of K2 (now no longer "the latest key" either) must
    // also still be recognised, proving this is not merely a two-slot
    // window.
    const k2Replayed = await interact(f.db, sessionId, "K2", learnerAuth);
    expect(k2Replayed).toMatchObject({ ok: true, duplicate: true });
    // Exactly two reservation rows exist for this classroom: one per
    // genuinely distinct key ever spent, never one per interaction attempt.
    await f.db.exec("reset role");
    const count = await f.db.query<{ count: number }>(
      "select count(*)::int as count from public.professor_classroom_interaction_reservations",
    );
    expect(count.rows[0].count).toBe(2);
    await f.db.exec("set role authenticated");
  });

  it("the same idempotency key value is independently reservable per learner: never a global key namespace, and a learner can never reserve or observe another learner's classroom reservation", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await asClassroomUser(f.db, instructorAuth);
    await f.db.query(
      "select public.create_enrolment($1,$2,'Classroom fixture second learner')",
      [foreignLearner, cohortId],
    );
    await open(f.db, sessionId, learnerAuth);
    await open(f.db, sessionId, foreignAuth);
    const first = await interact(f.db, sessionId, "shared-key", learnerAuth);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    // The exact same key value, reserved by a wholly different learner's own
    // classroom, must proceed independently -- proving the reservation is
    // scoped to (classroom_id, key), never (key) alone.
    const second = await interact(f.db, sessionId, "shared-key", foreignAuth);
    expect(second).toMatchObject({ ok: true, duplicate: false });
  });

  it("an interaction requires an already-opened classroom", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    const result = await interact(f.db, sessionId, "some-key", learnerAuth);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("lists opened classroom session ids only for the calling learner", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    await asClassroomUser(f.db, learnerAuth);
    const mine = await f.db.query<{
      list_my_professor_classroom_session_ids: string[];
    }>("select public.list_my_professor_classroom_session_ids()");
    expect(mine.rows[0].list_my_professor_classroom_session_ids).toContain(
      sessionId,
    );
    await asClassroomUser(f.db, foreignAuth);
    const foreign = await f.db.query<{
      list_my_professor_classroom_session_ids: string[];
    }>("select public.list_my_professor_classroom_session_ids()");
    expect(
      foreign.rows[0].list_my_professor_classroom_session_ids,
    ).not.toContain(sessionId);
  });
});

describe("professor classroom: immutability, RLS/ACL, no leakage", () => {
  it("classroom identity fields cannot be updated and rows cannot be deleted", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    await f.db.exec("reset role");
    await reject(
      f.db,
      "update public.professor_classroom_sessions set class_session_id=gen_random_uuid() where class_session_id=$1",
      [sessionId],
    );
    await reject(
      f.db,
      "delete from public.professor_classroom_sessions where class_session_id=$1",
      [sessionId],
    );
    await f.db.exec("set role authenticated");
  });

  it("denies direct authenticated table access", async () => {
    await asClassroomUser(f.db, learnerAuth);
    await reject(f.db, "select * from public.professor_classroom_sessions");
    await reject(
      f.db,
      "insert into public.professor_classroom_sessions(student_id,class_session_id,enrolment_id,programme_version_id,lesson_id,mode,first_opened_at,last_opened_at) values($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$2,'LIVE',clock_timestamp(),clock_timestamp())",
      [learner, lessonId],
    );
    await reject(
      f.db,
      "select * from public.professor_classroom_interaction_reservations",
    );
    await reject(
      f.db,
      "insert into public.professor_classroom_interaction_reservations(classroom_id,idempotency_key,reserved_at) values(gen_random_uuid(),'key',clock_timestamp())",
    );
  });

  it("denies service_role and anon direct table/function access", async () => {
    await f.db.exec("reset role");
    for (const role of ["service_role", "anon"]) {
      await f.db.exec(`set role ${role}`);
      await reject(f.db, "select * from public.professor_classroom_sessions");
      await reject(
        f.db,
        "select * from public.professor_classroom_interaction_reservations",
      );
      await reject(f.db, "select public.open_professor_classroom($1)", [
        "00000000-0000-4000-8000-000000000000",
      ]);
      await reject(
        f.db,
        "select public.record_professor_classroom_interaction($1,$2)",
        ["00000000-0000-4000-8000-000000000000", "key"],
      );
      await reject(
        f.db,
        "select public.list_my_professor_classroom_session_ids()",
      );
      await f.db.exec("reset role");
    }
    await f.db.exec("set role authenticated");
  });

  it("interaction reservation rows are immutable: cannot be updated or deleted, even by the owning learner's session role", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    await interact(f.db, sessionId, "immutable-key", learnerAuth);
    await f.db.exec("reset role");
    await reject(
      f.db,
      "update public.professor_classroom_interaction_reservations set reserved_at=clock_timestamp()",
    );
    await reject(
      f.db,
      "delete from public.professor_classroom_interaction_reservations",
    );
    await f.db.exec("set role authenticated");
  });

  it("audit_events receives no professor-classroom entries (non-authoritative UX state, not institutional evidence)", async () => {
    const sessionId = await scheduleClassSession(
      f.db,
      "2020-01-01T00:00:00Z",
      "2020-01-01T01:00:00Z",
    );
    await open(f.db, sessionId, learnerAuth);
    await interact(f.db, sessionId, "audit-check-key", learnerAuth);
    await interact(f.db, sessionId, "audit-check-key-2", learnerAuth);
    await f.db.exec("reset role");
    const events = await f.db.query<{ count: number }>(
      "select count(*)::int as count from public.audit_events where target_type in ('professor_classroom_sessions','professor_classroom','professor_classroom_interaction_reservations')",
    );
    expect(events.rows[0].count).toBe(0);
    await f.db.exec("set role authenticated");
  });
});
