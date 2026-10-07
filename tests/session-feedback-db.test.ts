import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  administrator,
  asExecutionUser,
  enrolledLesson,
  executionFixture,
  foreignLearner,
  learner,
  learnerAuth,
  type ExecutionFixture,
} from "./execution-fixture";

// AC-6 (migration 055): Sarah post-session feedback and the admin
// teaching-quality aggregate against the real migration chain on PGlite.
// PGlite is a single connection: these tests prove invariants, ownership,
// privacy and SEQUENTIAL idempotency only, never independent-connection
// concurrency (docs/48 lists the hosted races).

const MIGRATION = "supabase/migrations/202610060055_sarah_session_feedback.sql";
const cohortA = "50000000-0000-4000-8000-000000000001";
const cohortB = "50000000-0000-4000-8000-0000000000b2";
const version = "20000000-0000-4000-8000-000000000002";

// Users beyond the execution fixture (1 learner, 2 academic admin +
// instructor + counsellor, 3 learner in no cohort until set up below).
const R4 = 4,
  R5 = 5,
  R6 = 6,
  R7 = 7,
  INSTRUCTOR = 8,
  REGISTRAR = 9,
  PLATFORM = 10,
  COUNSELLOR = 11;
const extraNames: Record<number, string> = {
  [R4]: "Respondent Four",
  [R5]: "Respondent Five",
  [R6]: "Respondent Six",
  [R7]: "Respondent Seven",
  [INSTRUCTOR]: "Instructor Only",
  [REGISTRAR]: "Registrar Only",
  [PLATFORM]: "Platform Only",
  [COUNSELLOR]: "Counsellor Only",
};
const ids: Record<number, string> = {
  1: learner,
  2: administrator,
  3: foreignLearner,
};
const enrolmentOf: Record<number, string> = {};

let f: ExecutionFixture;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function as(n: number | null) {
  await asExecutionUser(f.db, n);
}
async function owner() {
  await f.db.exec("reset role");
}
async function refused(sql: string, args: unknown[], message: string) {
  await f.db.exec("savepoint refused");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await f.db.exec("rollback to savepoint refused; release savepoint refused");
  }
}
async function call<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const keys = Object.keys(args);
  return value<T>(
    `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as v`,
    keys.map((k) => args[k]),
  );
}

let slot = 0;
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
// Distinct, non-overlapping past windows (cohort and instructor overlap
// checks stay satisfied). A larger slot is a more recent session.
async function pastSession(
  cohort = cohortA,
  instructor = administrator,
): Promise<string> {
  slot += 1;
  const start = -60 * 24 * 20 + slot * 120;
  return createSession(cohort, minutes(start), minutes(start + 60), instructor);
}
async function createSession(
  cohort: string,
  start: string,
  end: string,
  instructor = administrator,
) {
  await as(2);
  const id = await value<string>(
    "select public.create_class_session($1,$2,$3,$4,$5,'AC-6 fixture session') as v",
    [cohort, enrolledLesson, instructor, start, end],
  );
  return id;
}
async function mark(session: string, n: number, status = "PRESENT") {
  await as(2);
  await f.db.query(
    "select public.record_attendance($1,$2,$3,'AC-6 fixture attendance')",
    [session, enrolmentOf[n], status],
  );
}
async function cancel(session: string) {
  await as(2);
  await f.db.query(
    "select public.change_class_session_status($1,'CANCELLED','AC-6 fixture cancel')",
    [session],
  );
}
async function submit(
  n: number | null,
  session: string,
  ratings: [number | null, number | null, number | null] = [4, 4, 4],
  request: string | null = randomUUID(),
) {
  await as(n);
  return call("submit_my_session_feedback", {
    p_class_session_id: session,
    p_request_id: request,
    p_clarity_rating: ratings[0],
    p_pace_rating: ratings[1],
    p_usefulness_rating: ratings[2],
  });
}
async function opportunities(n: number) {
  await as(n);
  return call<{
    ok: boolean;
    code?: string;
    opportunities?: Record<string, unknown>[];
  }>("list_my_session_feedback_opportunities");
}
type Quality = {
  minimumResponses: number;
  offset: number;
  hasMore: boolean;
  summary: Record<string, number | null>;
  rows: Record<string, unknown>[];
};
async function quality(n: number, args: Record<string, unknown> = {}) {
  await as(n);
  return call<Quality>("admin_session_teaching_quality", args);
}
async function feedbackRows() {
  await owner();
  return (
    await f.db.query<Record<string, unknown>>(
      "select * from public.session_teaching_feedback order by submitted_at, id",
    )
  ).rows;
}

beforeAll(async () => {
  f = await executionFixture();
  await owner();
  for (const n of Object.keys(extraNames).map(Number)) {
    await f.db.query(
      "insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)",
      [
        learnerAuth(n),
        `feedback${n}@test.example`,
        JSON.stringify({ display_name: extraNames[n] }),
      ],
    );
    ids[n] = await value<string>(
      "select id as v from public.app_users where auth_user_id=$1",
      [learnerAuth(n)],
    );
  }
  for (const n of [R4, R5, R6, R7])
    await f.db.query(
      "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
      [ids[n], cohortA, version],
    );
  // Staff-only accounts: no STUDENT role.
  for (const [n, role] of [
    [INSTRUCTOR, "INSTRUCTOR"],
    [REGISTRAR, "REGISTRAR"],
    [PLATFORM, "PLATFORM_ADMIN"],
    [COUNSELLOR, "COUNSELLOR"],
  ] as const) {
    await f.db.query(
      "delete from public.role_grants where user_id=$1 and role='STUDENT'",
      [ids[n]],
    );
    await f.db.query("insert into public.role_grants values($1,$2)", [
      ids[n],
      role,
    ]);
  }
  await f.db.query(
    "insert into public.staff_profiles(user_id,title) values($1,'Instructor')",
    [ids[INSTRUCTOR]],
  );
  // A second cohort, where only the foreign learner is enrolled.
  await f.db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Foreign cohort — DEMO','2026-09-01')",
    [cohortB, version],
  );
  await f.db.query(
    "insert into public.enrolments(student_id,cohort_id,programme_version_id) values($1,$2,$3)",
    [foreignLearner, cohortB, version],
  );
  for (const n of [1, 3, R4, R5, R6, R7])
    enrolmentOf[n] = await value<string>(
      "select id as v from public.enrolments where student_id=$1",
      [ids[n]],
    );
}, 120_000);
beforeEach(async () => {
  await f.db.exec("reset role; begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f?.db.close();
});

describe("AC-6 learner submission and eligibility", () => {
  it("records feedback for the learner's own ended, attended session, deriving the learner", async () => {
    const session = await pastSession();
    await mark(session, 1);
    // Still SCHEDULED after its end: admin status lag never blocks feedback.
    await owner();
    expect(
      await value("select status as v from public.class_sessions where id=$1", [
        session,
      ]),
    ).toBe("SCHEDULED");
    expect(await submit(1, session, [5, 3, 4])).toEqual({
      ok: true,
      outcome: "RECORDED",
    });
    const rows = await feedbackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      class_session_id: session,
      student_id: learner,
      policy_version: "SESSION_FEEDBACK_V1",
      clarity_rating: 5,
      pace_rating: 3,
      usefulness_rating: 4,
    });
    // Exactly the reviewed columns: no free text, comments or sentiment.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "clarity_rating",
      "class_session_id",
      "id",
      "pace_rating",
      "policy_version",
      "request_id",
      "student_id",
      "submitted_at",
      "usefulness_rating",
    ]);
  });

  it("accepts a COMPLETED session too", async () => {
    const session = await pastSession();
    await mark(session, 1);
    await as(2);
    await f.db.query(
      "select public.change_class_session_status($1,'COMPLETED','AC-6 fixture complete')",
      [session],
    );
    expect(await submit(1, session)).toMatchObject({ ok: true });
  });

  it("refuses a future session and a session still in progress", async () => {
    const future = await createSession(
      cohortA,
      minutes(60 * 24 * 3),
      minutes(60 * 24 * 3 + 60),
    );
    expect(await submit(1, future)).toEqual({
      ok: false,
      code: "SESSION_NOT_ENDED",
    });
    const live = await createSession(cohortA, minutes(-30), minutes(30));
    await mark(live, 1);
    expect(await submit(1, live)).toEqual({
      ok: false,
      code: "SESSION_NOT_ENDED",
    });
    expect(await feedbackRows()).toHaveLength(0);
  });

  it("refuses a CANCELLED session even with PRESENT attendance", async () => {
    const session = await pastSession();
    await mark(session, 1);
    await cancel(session);
    expect(await submit(1, session)).toEqual({
      ok: false,
      code: "SESSION_CANCELLED",
    });
    expect(await feedbackRows()).toHaveLength(0);
  });

  it("requires authoritative PRESENT attendance: absent, late, excused and missing are refused", async () => {
    for (const status of ["ABSENT", "LATE", "EXCUSED"]) {
      const session = await pastSession();
      await mark(session, 1, status);
      expect(await submit(1, session)).toEqual({
        ok: false,
        code: "ATTENDANCE_NOT_PRESENT",
      });
    }
    const missing = await pastSession();
    expect(await submit(1, missing)).toEqual({
      ok: false,
      code: "ATTENDANCE_NOT_PRESENT",
    });
    expect(await feedbackRows()).toHaveLength(0);
  });

  it("refuses a foreign cohort's session, an unknown session and a withdrawn enrolment without revealing why", async () => {
    const foreign = await pastSession(cohortB);
    await mark(foreign, 3);
    expect(await submit(1, foreign)).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(await submit(1, randomUUID())).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    const own = await pastSession();
    await mark(own, 1);
    await owner();
    await f.db.query(
      "update public.enrolments set status='WITHDRAWN' where id=$1",
      [enrolmentOf[1]],
    );
    expect(await submit(1, own)).toEqual({ ok: false, code: "NOT_ELIGIBLE" });
    expect((await opportunities(1)).opportunities).toEqual([]);
    expect(await feedbackRows()).toHaveLength(0);
  });

  it("staff and admins cannot submit merely because they are staff", async () => {
    const session = await pastSession();
    await mark(session, 1);
    for (const n of [2, INSTRUCTOR, REGISTRAR, PLATFORM, COUNSELLOR])
      expect(await submit(n, session)).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
    expect(await submit(null, session)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    for (const n of [2, INSTRUCTOR, PLATFORM])
      expect(await opportunities(n)).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await feedbackRows()).toHaveLength(0);
  });

  it("a multi-role account gains no wider learner ownership, and no RPC accepts a learner or instructor", async () => {
    await owner();
    await f.db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN'),($1,'INSTRUCTOR'),($1,'REGISTRAR'),($1,'PLATFORM_ADMIN')",
      [learner],
    );
    const foreign = await pastSession(cohortB);
    await mark(foreign, 3);
    expect(await submit(1, foreign)).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(
      (await opportunities(1)).opportunities!.map((o) => o.classSessionId),
    ).not.toContain(foreign);
    await owner();
    const args = await value<string>(
      "select string_agg(pg_get_function_arguments(p.oid), ' | ') as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('submit_my_session_feedback','list_my_session_feedback_opportunities')",
    );
    expect(args).not.toMatch(
      /student|learner|instructor|cohort|lesson|version/i,
    );
  });

  it("refuses ratings outside 1-5 and missing values before writing anything", async () => {
    const session = await pastSession();
    await mark(session, 1);
    for (const ratings of [
      [0, 3, 3],
      [3, 6, 3],
      [3, 3, -1],
      [null, 3, 3],
      [3, null, 3],
      [3, 3, null],
    ] as [number | null, number | null, number | null][])
      expect(await submit(1, session, ratings)).toEqual({
        ok: false,
        code: "INVALID_INPUT",
      });
    expect(await submit(1, session, [3, 3, 3], null)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await feedbackRows()).toHaveLength(0);
    // The table CHECK is the structural backstop for every writer.
    await owner();
    await refused(
      "insert into public.session_teaching_feedback(class_session_id,student_id,request_id,clarity_rating,pace_rating,usefulness_rating) values($1,$2,$3,6,3,3)",
      [session, learner, randomUUID()],
      "check constraint",
    );
  });
});

describe("AC-6 idempotency and one feedback per learner and session", () => {
  it("replays the same request, conflicts on changed values, and refuses a second distinct submission", async () => {
    const session = await pastSession();
    const other = await pastSession();
    await mark(session, 1);
    await mark(other, 1);
    const key = randomUUID();
    expect(await submit(1, session, [4, 3, 5], key)).toEqual({
      ok: true,
      outcome: "RECORDED",
    });
    expect(await submit(1, session, [4, 3, 5], key)).toEqual({
      ok: true,
      outcome: "REPLAYED",
    });
    expect(await submit(1, session, [4, 3, 4], key)).toEqual({
      ok: false,
      code: "REQUEST_CONFLICT",
    });
    expect(await submit(1, other, [4, 3, 5], key)).toEqual({
      ok: false,
      code: "REQUEST_CONFLICT",
    });
    expect(await submit(1, session, [4, 3, 5])).toEqual({
      ok: false,
      code: "ALREADY_SUBMITTED",
    });
    expect(await submit(1, session, [1, 1, 1])).toEqual({
      ok: false,
      code: "ALREADY_SUBMITTED",
    });
    const rows = await feedbackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clarity_rating: 4,
      pace_rating: 3,
      usefulness_rating: 5,
    });
    expect(
      await value<number>(
        "select count(*)::int as v from public.audit_events where action='SESSION_FEEDBACK_SUBMITTED'",
      ),
    ).toBe(1);
    // A different learner may reuse the same key value for their own row.
    await mark(session, R4);
    expect(await submit(R4, session, [2, 2, 2], key)).toEqual({
      ok: true,
      outcome: "RECORDED",
    });
  });

  it("answers truthfully after a later cancellation: replay still replays and a new key is ALREADY_SUBMITTED", async () => {
    const session = await pastSession();
    await mark(session, 1);
    const key = randomUUID();
    expect(await submit(1, session, [3, 4, 5], key)).toMatchObject({
      outcome: "RECORDED",
    });
    await cancel(session);
    expect(await submit(1, session, [3, 4, 5], key)).toEqual({
      ok: true,
      outcome: "REPLAYED",
    });
    // The learner's own recorded fact dominates the later session state.
    expect(await submit(1, session, [3, 4, 5])).toEqual({
      ok: false,
      code: "ALREADY_SUBMITTED",
    });
    expect(await feedbackRows()).toHaveLength(1);
  });

  it("enforces uniqueness structurally, so even the owner cannot add a second row", async () => {
    const session = await pastSession();
    await mark(session, 1);
    expect(await submit(1, session)).toMatchObject({ ok: true });
    await owner();
    await refused(
      "insert into public.session_teaching_feedback(class_session_id,student_id,request_id,clarity_rating,pace_rating,usefulness_rating) values($1,$2,$3,1,1,1)",
      [session, learner, randomUUID()],
      "duplicate key",
    );
  });

  it("stored feedback is immutable and cannot be deleted, and the insert backstop refuses ineligible rows", async () => {
    const session = await pastSession();
    await mark(session, 1);
    expect(await submit(1, session)).toMatchObject({ ok: true });
    await owner();
    await refused(
      "update public.session_teaching_feedback set clarity_rating=1",
      [],
      "SESSION_FEEDBACK_IMMUTABLE",
    );
    await refused(
      "update public.session_teaching_feedback set submitted_at=now()-interval '1 day'",
      [],
      "SESSION_FEEDBACK_IMMUTABLE",
    );
    await refused(
      "delete from public.session_teaching_feedback",
      [],
      "SESSION_FEEDBACK_IMMUTABLE",
    );
    const absent = await pastSession();
    await mark(absent, R4, "ABSENT");
    await owner();
    await refused(
      "insert into public.session_teaching_feedback(class_session_id,student_id,request_id,clarity_rating,pace_rating,usefulness_rating) values($1,$2,$3,3,3,3)",
      [absent, ids[R4], randomUUID()],
      "SESSION_FEEDBACK_INELIGIBLE",
    );
    expect(await feedbackRows()).toHaveLength(1);
  });

  it("serialises one learner's submissions under the learner lock, in the reviewed lock order", async () => {
    await owner();
    const definition = (
      await value<string>(
        "select pg_get_functiondef('public.submit_my_session_feedback(uuid,uuid,integer,integer,integer)'::regprocedure) as v",
      )
    ).replace(/\s+/g, " ");
    const at = (needle: string) => {
      const i = definition.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const learnerLock = at(
      "from public.student_profiles where user_id = actor for update",
    );
    const replay = at("where student_id = actor and request_id = p_request_id");
    const enrolment = at(
      "where student_id = actor and cohort_id = s.cohort_id and programme_version_id = s.programme_version_id for share",
    );
    const sessionLock = at(
      "from public.class_sessions where id = p_class_session_id for share",
    );
    const attendanceLock = at(
      "a.enrolment_id = e.id and a.student_id = actor for share",
    );
    expect(learnerLock).toBeLessThan(replay);
    expect(replay).toBeLessThan(enrolment);
    expect(enrolment).toBeLessThan(sessionLock);
    expect(sessionLock).toBeLessThan(attendanceLock);
    expect(attendanceLock).toBeLessThan(
      at("insert into public.session_teaching_feedback"),
    );
  });
});

describe("AC-6 learner opportunities", () => {
  it("lists only the learner's own ended, PRESENT, non-cancelled, unrated sessions, newest first", async () => {
    const eligible = await pastSession();
    const newer = await pastSession();
    const submitted = await pastSession();
    const absent = await pastSession();
    const late = await pastSession();
    const unmarked = await pastSession();
    const cancelled = await pastSession();
    const foreign = await pastSession(cohortB);
    for (const s of [eligible, newer, submitted, cancelled]) await mark(s, 1);
    await mark(absent, 1, "ABSENT");
    await mark(late, 1, "LATE");
    await mark(foreign, 3);
    await cancel(cancelled);
    const future = await createSession(
      cohortA,
      minutes(60 * 24 * 5),
      minutes(60 * 24 * 5 + 60),
    );
    expect(await submit(1, submitted)).toMatchObject({ ok: true });
    const result = await opportunities(1);
    expect(result.ok).toBe(true);
    expect(result.opportunities!.map((o) => o.classSessionId)).toEqual([
      newer,
      eligible,
    ]);
    for (const absentId of [
      submitted,
      absent,
      late,
      unmarked,
      cancelled,
      foreign,
      future,
    ])
      expect(JSON.stringify(result)).not.toContain(absentId);
    expect(Object.keys(result.opportunities![0]).sort()).toEqual([
      "classSessionId",
      "cohortTitle",
      "instructorName",
      "lessonTitle",
      "programmeTitle",
      "scheduledEnd",
      "scheduledStart",
    ]);
    // Another learner's list is their own.
    expect(
      (await opportunities(3)).opportunities!.map((o) => o.classSessionId),
    ).toEqual([foreign]);
  });

  it("is bounded to the 10 most recent eligible sessions", async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const s = await pastSession();
      await mark(s, 1);
      sessions.push(s);
    }
    const listed = (await opportunities(1)).opportunities!.map(
      (o) => o.classSessionId,
    );
    expect(listed).toHaveLength(10);
    expect(listed).toEqual(sessions.slice(2).reverse());
  });
});

describe("AC-6 admin teaching quality", () => {
  async function rated(
    respondents: [number, [number, number, number]][],
    extraPresent: number[] = [],
    instructor = administrator,
    cohort = cohortA,
  ) {
    const session = await pastSession(cohort, instructor);
    for (const [n] of respondents) await mark(session, n);
    for (const n of extraPresent) await mark(session, n);
    for (const [n, ratings] of respondents)
      expect(await submit(n, session, ratings)).toMatchObject({ ok: true });
    return session;
  }
  const rowFor = (q: Quality, session: string) =>
    q.rows.find((r) => r.sessionId === session)!;

  it("is available to Academic Admin and Platform Admin only", async () => {
    const session = await rated(
      [
        [1, [5, 5, 5]],
        [R4, [4, 4, 4]],
        [R5, [3, 3, 3]],
      ],
      [],
      ids[INSTRUCTOR],
    );
    // The instructor who taught the session, a counsellor, a registrar and
    // a learner are all refused.
    for (const n of [INSTRUCTOR, COUNSELLOR, REGISTRAR, 1]) {
      await as(n);
      await refused(
        "select public.admin_session_teaching_quality() as v",
        [],
        "FORBIDDEN",
      );
    }
    await as(null);
    await refused(
      "select public.admin_session_teaching_quality() as v",
      [],
      "FORBIDDEN",
    );
    for (const n of [2, PLATFORM]) {
      const q = await quality(n);
      expect(rowFor(q, session)).toMatchObject({ responseCount: 3 });
    }
  });

  it("counts responses and present learners, hides scores below 3 responses and shows exact averages from 3", async () => {
    const session = await rated(
      [
        [1, [5, 4, 3]],
        [R4, [4, 4, 2]],
      ],
      [R5, R6],
    );
    let row = rowFor(await quality(2), session);
    expect(row).toMatchObject({
      presentCount: 4,
      responseCount: 2,
      scoresAvailable: false,
      clarityAverage: null,
      paceAverage: null,
      usefulnessAverage: null,
    });
    expect(await submit(R5, session, [3, 1, 4])).toMatchObject({ ok: true });
    row = rowFor(await quality(2), session);
    expect(row).toMatchObject({
      presentCount: 4,
      responseCount: 3,
      scoresAvailable: true,
      clarityAverage: 4,
      paceAverage: 3,
      usefulnessAverage: 3,
    });
    expect(await submit(R6, session, [2, 2, 2])).toMatchObject({ ok: true });
    row = rowFor(await quality(2), session);
    expect(row).toMatchObject({
      responseCount: 4,
      clarityAverage: 3.5,
      paceAverage: 2.75,
      usefulnessAverage: 2.75,
    });
    // Numbers, not strings: no numeric/string ambiguity reaches the UI.
    expect(typeof row.clarityAverage).toBe("number");
    expect(typeof row.responseCount).toBe("number");
  });

  it("summarises only sessions that meet the threshold, so hidden sessions cannot be derived", async () => {
    const scored = await rated([
      [1, [5, 5, 5]],
      [R4, [5, 5, 5]],
      [R5, [2, 2, 2]],
    ]);
    const hidden = await rated([
      [1, [1, 1, 1]],
      [R4, [1, 1, 1]],
    ]);
    const q = await quality(2);
    expect(rowFor(q, hidden)).toMatchObject({
      scoresAvailable: false,
      clarityAverage: null,
    });
    expect(rowFor(q, scored)).toMatchObject({ clarityAverage: 4 });
    expect(q.minimumResponses).toBe(3);
    expect(q.summary).toEqual({
      sessionCount: 2,
      responseCount: 5,
      scoredSessionCount: 1,
      scoredResponseCount: 3,
      clarityAverage: 4,
      paceAverage: 4,
      usefulnessAverage: 4,
    });
  });

  it("filters by instructor, cohort and date window, and refuses invalid filters", async () => {
    const byInstructor = await rated([[1, [5, 5, 5]]], [], ids[INSTRUCTOR]);
    const byAdmin = await rated([[R4, [3, 3, 3]]]);
    const foreign = await rated([[3, [2, 2, 2]]], [], administrator, cohortB);
    const sessionsOf = async (args: Record<string, unknown>) =>
      (await quality(2, args)).rows.map((r) => r.sessionId);
    expect(await sessionsOf({ p_instructor_id: ids[INSTRUCTOR] })).toEqual([
      byInstructor,
    ]);
    const cohortAOnly = await sessionsOf({ p_cohort_id: cohortA });
    expect(cohortAOnly).toContain(byAdmin);
    expect(cohortAOnly).not.toContain(foreign);
    expect(await sessionsOf({ p_cohort_id: cohortB })).toEqual([foreign]);
    await owner();
    const start = await value<string>(
      "select scheduled_start::text as v from public.class_sessions where id=$1",
      [byAdmin],
    );
    expect(
      await sessionsOf({
        p_from: start,
        p_until: new Date(Date.parse(start) + 60_000).toISOString(),
      }),
    ).toEqual([byAdmin]);
    await as(2);
    for (const args of [
      { p_offset: -1 },
      { p_offset: 100001 },
      { p_from: minutes(10), p_until: minutes(-10) },
    ])
      await refused(
        `select public.admin_session_teaching_quality(${Object.keys(args)
          .map((k, i) => `${k} => $${i + 1}`)
          .join(",")}) as v`,
        Object.values(args),
        "INVALID_INPUT",
      );
  });

  it("keeps feedback for a session cancelled later but excludes it from the active aggregate", async () => {
    const session = await rated([
      [1, [5, 5, 5]],
      [R4, [4, 4, 4]],
      [R5, [3, 3, 3]],
    ]);
    expect(rowFor(await quality(2), session)).toBeDefined();
    await cancel(session);
    const q = await quality(2);
    expect(q.rows.map((r) => r.sessionId)).not.toContain(session);
    expect(q.summary.responseCount).toBe(0);
    expect(q.summary.clarityAverage).toBeNull();
    expect(await feedbackRows()).toHaveLength(3);
  });

  it("never exposes learner identity, individual ratings, request ids, feedback ids or submission times", async () => {
    const session = await rated([
      [1, [5, 1, 2]],
      [R4, [4, 2, 3]],
      [R5, [3, 3, 4]],
    ]);
    const q = await quality(2);
    const json = JSON.stringify(q);
    await owner();
    const numbers = (
      await f.db.query<{ n: string }>(
        "select student_number as n from public.student_profiles",
      )
    ).rows.map((r) => r.n);
    const feedback = await feedbackRows();
    for (const secret of [
      learner,
      ids[R4],
      ids[R5],
      foreignLearner,
      "Alex Morgan",
      "Respondent Four",
      "Respondent Five",
      ...numbers,
      ...feedback.map((r) => String(r.id)),
      ...feedback.map((r) => String(r.request_id)),
    ])
      expect(json).not.toContain(secret);
    expect(json).not.toMatch(/student|learner|submitted|respondent|request/i);
    expect(Object.keys(rowFor(q, session)).sort()).toEqual([
      "clarityAverage",
      "cohortTitle",
      "instructorName",
      "lessonTitle",
      "paceAverage",
      "presentCount",
      "programmeTitle",
      "responseCount",
      "scheduledEnd",
      "scheduledStart",
      "scoresAvailable",
      "sessionId",
      "status",
      "usefulnessAverage",
      "versionLabel",
    ]);
  });
});

describe("AC-6 audit and absence of academic side effects", () => {
  it("audits only the feedback id, session id, action and time, with no actor and no ratings", async () => {
    const session = await pastSession();
    await mark(session, 1);
    const key = randomUUID();
    expect(await submit(1, session, [5, 2, 1], key)).toMatchObject({
      ok: true,
    });
    expect(await submit(1, session, [5, 2, 1], key)).toMatchObject({
      outcome: "REPLAYED",
    });
    await owner();
    const events = (
      await f.db.query<Record<string, unknown>>(
        "select * from public.audit_events where target_type='session_teaching_feedback'",
      )
    ).rows;
    expect(events).toHaveLength(1);
    const [feedback] = await feedbackRows();
    expect(events[0]).toMatchObject({
      actor_id: null,
      action: "SESSION_FEEDBACK_SUBMITTED",
      target_id: feedback.id,
      source: "LEARNER_SESSION_FEEDBACK",
      before_state: null,
    });
    const after = events[0].after_state as Record<string, unknown>;
    expect(Object.keys(after).sort()).toEqual([
      "action",
      "class_session_id",
      "feedback_id",
      "submitted_at",
    ]);
    expect(after.class_session_id).toBe(session);
    const text = JSON.stringify(events[0]);
    for (const secret of [
      learner,
      "Alex Morgan",
      "DUC-DEMO-001",
      key,
      "rating",
    ])
      expect(text).not.toContain(secret);
  });

  it("changes no attendance, session, progress, evidence, mastery, grade, enrolment, configuration or Sarah state", async () => {
    const session = await pastSession();
    await mark(session, 1);
    await owner();
    const tables = (
      await f.db.query<{ t: string }>(
        `select t from unnest(array[
          'attendance_records','class_sessions','enrolments','lesson_progress','learning_evidence',
          'objective_mastery','objective_mastery_history','assessment_attempts','assignment_submissions',
          'registrar_corrections','academic_agent_configs','learning_resources','lessons','cohorts',
          'staff_profiles','role_grants','student_support_profiles','support_events','support_followups',
          'institutional_notifications','sarah_interaction_reservations','sarah_executions',
          'sarah_support_profile_proposals','counsellor_assignments','commercial_v1_orders']) t
         where to_regclass('public.' || t) is not null order by t`,
      )
    ).rows.map((r) => r.t);
    expect(tables.length).toBeGreaterThan(20);
    const snapshot = async () => {
      await owner();
      const out: Record<string, string> = {};
      for (const t of tables)
        out[t] = await value<string>(
          `select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) as v from public.${t} x`,
        );
      return out;
    };
    const before = await snapshot();
    expect(await submit(1, session, [1, 1, 1])).toMatchObject({ ok: true });
    expect(await snapshot()).toEqual(before);
  });
});

describe("AC-6 ACL and RLS", () => {
  it("denies direct table access to application roles and to service_role", async () => {
    const session = await pastSession();
    await mark(session, 1);
    expect(await submit(1, session)).toMatchObject({ ok: true });
    for (const role of ["authenticated", "anon", "service_role"]) {
      await owner();
      if (role === "authenticated") await as(1);
      else await f.db.exec(`set role ${role}`);
      for (const sql of [
        "select * from public.session_teaching_feedback",
        "select count(*) from public.session_teaching_feedback",
        `insert into public.session_teaching_feedback(class_session_id,student_id,request_id,clarity_rating,pace_rating,usefulness_rating) values('${session}','${learner}','${randomUUID()}',3,3,3)`,
        "update public.session_teaching_feedback set clarity_rating=1",
        "delete from public.session_teaching_feedback",
        "truncate public.session_teaching_feedback",
      ])
        await refused(sql, [], "permission denied");
    }
  });

  it("verifies effective privileges: three authenticated-only RPCs, a closed private schema, no service_role ambient authority", async () => {
    await owner();
    const fns = (
      await f.db.query<{
        name: string;
        anon: boolean;
        auth: boolean;
        service: boolean;
      }>(
        `select p.oid::regprocedure::text as name,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'session_feedback_private'
           or (n.nspname = 'public' and p.proname in ('list_my_session_feedback_opportunities','submit_my_session_feedback','admin_session_teaching_quality'))
         order by 1`,
      )
    ).rows;
    expect(fns.filter((x) => x.auth).map((x) => x.name)).toEqual([
      "admin_session_teaching_quality(uuid,uuid,timestamp with time zone,timestamp with time zone,integer)",
      "list_my_session_feedback_opportunities()",
      "submit_my_session_feedback(uuid,uuid,integer,integer,integer)",
    ]);
    expect(fns.some((x) => x.anon || x.service)).toBe(false);
    expect(
      fns.filter((x) => x.name.startsWith("session_feedback_private")).length,
    ).toBe(2);
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        await value<boolean>(
          "select has_schema_privilege($1,'session_feedback_private','USAGE,CREATE') or has_table_privilege($1,'public.session_teaching_feedback','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,'public.session_teaching_feedback','SELECT,INSERT,UPDATE,REFERENCES') as v",
          [role],
        ),
      ).toBe(false);
    expect(
      await value<boolean>(
        "select relrowsecurity as v from pg_class where oid='public.session_teaching_feedback'::regclass",
      ),
    ).toBe(true);
    // The migration's own self-verification passes against the live ACL...
    const migration = readFileSync(resolve(MIGRATION), "utf8");
    const check = migration.slice(
      migration.indexOf("do $session_feedback_acl$"),
    );
    await f.db.exec(check);
    // ...and fails closed on an unexpected grant.
    await f.db.exec(
      "grant select on public.session_teaching_feedback to service_role",
    );
    await refused(
      check,
      [],
      "Unsafe session-feedback table privileges for service_role",
    );
  });

  it("is additive: the migration modifies no earlier object and calls no model or Sarah execution", () => {
    const sql = readFileSync(resolve(MIGRATION), "utf8").toLowerCase();
    for (const forbidden of [
      "create or replace",
      "drop ",
      "alter table public.class_sessions",
      "alter table public.attendance_records",
      "sarah_executions",
      "govern_sarah_execution",
      "verify_mac",
      "openai",
      "provider_execution",
      "provider_calls",
      "recommend",
      "pricing",
      "commercial_v1",
      "comment",
      "sentiment",
    ])
      expect(sql, forbidden).not.toContain(forbidden);
  });
});
