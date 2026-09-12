import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  executionFixture,
  asExecutionUser,
  learner,
  administrator,
  foreignLearner,
  type ExecutionFixture,
} from "./execution-fixture";
import { deliveryContextSchema, type DeliveryContext } from "@/domain/delivery";

let fixture: ExecutionFixture,
  db: PGlite,
  enrolment: string,
  version: string,
  cohort: string;
const lessons: string[] = [],
  segments: string[] = [],
  objectives: string[] = [];
async function scalar<T = string>(sql: string, args: unknown[] = []) {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function user(n = 1) {
  await asExecutionUser(db, n);
}
async function owner() {
  await db.exec("reset role");
}
async function denied(sql: string, args: unknown[] = [], message?: string) {
  await db.exec("savepoint denial");
  try {
    await expect(db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await db.exec("rollback to savepoint denial; release savepoint denial");
  }
}
async function save(cadence: number | null = null) {
  return scalar("select public.save_delivery_study_plan($1,$2) as value", [
    enrolment,
    cadence === null ? null : Array.from({ length: cadence }, (_, i) => i + 1),
  ]);
}
async function confirm() {
  return scalar("select public.confirm_delivery_study_plan($1) as value", [
    enrolment,
  ]);
}
async function context(cursor = 0): Promise<DeliveryContext> {
  return deliveryContextSchema.parse(
    await scalar("select public.get_delivery_context($1,$2) as value", [
      enrolment,
      cursor,
    ]),
  );
}
async function historical(cadence = 7) {
  const plan = await save(cadence);
  await db.query(
    "select public.save_delivery_study_plan($1,null,'00:00','UTC')",
    [enrolment],
  );
  await owner();
  // Privileged historical fixture only: no public RPC accepts a past start or clock.
  await db.query(
    "select delivery_private.generate_schedule($1,$2,'00:00','UTC',(clock_timestamp() at time zone 'UTC')::date-3,true)",
    [plan, Array.from({ length: cadence }, (_, i) => i + 1)],
  );
  await db.query(
    "update public.delivery_study_plans set state='CONFIRMED',confirmed_at=clock_timestamp() where id=$1",
    [plan],
  );
  await user();
}
async function planAt(
  days: number[],
  time: string,
  zone: string,
  date: string,
) {
  const plan = await scalar(
    "select public.save_delivery_study_plan($1,$2,$3,$4) as value",
    [enrolment, days, time, zone],
  );
  await owner();
  await db.query(
    "select delivery_private.generate_schedule($1,$2,$3,$4,$5::date,true)",
    [plan, days, time, zone, date],
  );
  await db.query(
    "update public.delivery_study_plans set state='CONFIRMED',confirmed_at=clock_timestamp() where id=$1",
    [plan],
  );
  await user();
  return context();
}
async function progress(index: number, status = "COMPLETED") {
  await user(2);
  const existing = await db.query<{ id: string }>(
    "select id from public.class_sessions where cohort_id=$1 and lesson_id=$2",
    [cohort, lessons[index]],
  );
  const session =
    existing.rows[0]?.id ??
    (await scalar(
      "select public.create_class_session($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','Delivery progress fixture') as value",
      [cohort, lessons[index], administrator],
    ));
  await scalar(
    "select public.record_lesson_progress($1,$2,$3,$4,'Validated segment progress') as value",
    [session, enrolment, segments[index], status],
  );
  await user();
}
beforeAll(async () => {
  fixture = await executionFixture();
  db = fixture.db;
  await owner();
  const programme = randomUUID(),
    moduleId = randomUUID();
  version = randomUUID();
  cohort = randomUUID();
  await db.query(
    "insert into public.programmes(id,slug,title,examination_body,qualification_name) values($1,'delivery-fixture','Delivery fixture','Demo','Demo')",
    [programme],
  );
  await db.query(
    "insert into public.programme_versions(id,programme_id,label) values($1,$2,'Delivery exact version')",
    [version, programme],
  );
  await db.query(
    "insert into public.modules(id,programme_version_id,title,position) values($1,$2,'moduleId',1)",
    [moduleId, version],
  );
  for (let i = 0; i < 30; i++) {
    lessons.push(randomUUID());
    segments.push(randomUUID());
    objectives.push(randomUUID());
    await db.query(
      "insert into public.lessons(id,module_id,programme_version_id,title,position) values($1,$2,$3,$4,$5)",
      [lessons[i], moduleId, version, `Lesson ${i}`, i + 1],
    );
    await db.query(
      "insert into public.lesson_segments(id,lesson_id,programme_version_id,title,position) values($1,$2,$3,'Validated segment',1)",
      [segments[i], lessons[i], version],
    );
    await db.query(
      "insert into public.lesson_objectives(id,lesson_id,programme_version_id,description,position) values($1,$2,$3,'Objective prose must not enter logistics',1)",
      [objectives[i], lessons[i], version],
    );
  }
  await user(2);
  await db.query(
    "select public.publish_programme_version($1,'Reviewed delivery fixture')",
    [version],
  );
  await owner();
  await db.query(
    "insert into public.cohorts(id,programme_version_id,title,starts_on) values($1,$2,'Delivery cohort',current_date-10)",
    [cohort, version],
  );
  await user(2);
  enrolment = await scalar(
    "select public.create_enrolment($1,$2,'Reviewed delivery enrolment') as value",
    [learner, cohort],
  );
  await owner();
});
beforeEach(async () => {
  await db.exec("begin");
  await user();
});
afterEach(async () => {
  await db.exec("rollback; reset role; reset request.jwt.claim.sub");
});
afterAll(async () => {
  await db?.close();
});

describe("governed delivery scheduling", () => {
  it("honours a future cohort start, with immutable original revision dates", async () => {
    await owner();
    await db.query(
      "update public.cohorts set starts_on=current_date+20 where id=$1",
      [cohort],
    );
    await user();
    await save(7);
    await confirm();
    const c = await context();
    expect(c.occurrences[0].scheduledAt.slice(0, 10)).toBe(
      await scalar("select (current_date+20)::text as value"),
    );
    const first = await scalar(
      "select public.get_delivery_schedule_history($1,1) as value",
      [enrolment],
    );
    await db.query(
      "select public.change_future_delivery_schedule($1,array[1,2,3,4,5,6,7],'19:00','Europe/London',current_date+21)",
      [enrolment],
    );
    expect(
      await scalar(
        "select public.get_delivery_schedule_history($1,1) as value",
        [enrolment],
      ),
    ).toEqual(first);
    await user(2);
    expect(
      await scalar(
        "select public.get_delivery_admin_schedule_history($1,1) as value",
        [enrolment],
      ),
    ).toEqual(first);
  });
  it("preserves completed future occurrences when rescheduling", async () => {
    await historical();
    await progress(5);
    const original = (await context()).occurrences[5];
    expect(original.state).toBe("COMPLETED");
    await db.query(
      "select public.change_future_delivery_schedule($1,array[1],'00:00','UTC',current_date+1)",
      [enrolment],
    );
    expect((await context()).occurrences[5]).toEqual(original);
  });
  it("uses the institutional default cadence", async () => {
    await save();
    expect((await context()).plan).toMatchObject({
      state: "DRAFT",
      cadence: 3,
      timezone: "Europe/London",
      studyDays: [1, 3, 5],
      localStartTime: "19:00",
    });
  });
  it.each([1, 7])(
    "generates deterministic cadence %i with next-slot latest-start boundaries",
    async (cadence) => {
      await save(cadence);
      await confirm();
      const c = await context();
      expect(c.occurrences).toHaveLength(25);
      expect(c.nextCursor).toBe(25);
      expect(
        Date.parse(c.occurrences[1].scheduledAt) -
          Date.parse(c.occurrences[0].scheduledAt),
      ).toBe((cadence === 1 ? 7 : 1) * 86400000);
      expect(
        c.occurrences.every(
          (o) =>
            Date.parse(o.nextScheduledAt) - Date.parse(o.latestStartAt) ===
            3600000,
        ),
      ).toBe(true);
    },
  );
  it("schedules the selected Monday/Wednesday/Friday weekdays", async () => {
    await save();
    await confirm();
    const c = await context();
    expect(
      c.occurrences.every((o) =>
        [1, 3, 5].includes(new Date(o.scheduledAt).getUTCDay()),
      ),
    ).toBe(true);
  });
  it.each([[], [0], [8], [1, 1]])(
    "rejects invalid study days %j",
    async (...days) => {
      await denied(
        "select public.save_delivery_study_plan($1,$2)",
        [enrolment, days],
        "INVALID_INPUT",
      );
    },
  );
  it("allows draft change then freezes confirmation, idempotently", async () => {
    const id = await save();
    expect(await save(5)).toBe(id);
    expect((await context()).plan?.cadence).toBe(5);
    expect(await confirm()).toBe(id);
    expect(await confirm()).toBe(id);
    await denied(
      "select public.save_delivery_study_plan($1,array[1,2])",
      [enrolment],
      "PLAN_FROZEN",
    );
    await owner();
    await denied(
      "update public.delivery_study_plans set study_days=array[1,2,3,4,5,6,7] where id=$1",
      [id],
      "immutable",
    );
  });
  it("uses only the enrolled version and curriculum order, with bounded paging", async () => {
    await save();
    await confirm();
    const first = await context(),
      second = await context(25);
    expect(first.plan?.programmeVersionId).toBe(version);
    expect(
      [...first.occurrences, ...second.occurrences].map((o) => o.lessonId),
    ).toEqual(lessons);
    expect(second.nextCursor).toBeNull();
    await denied(
      "select public.get_delivery_context($1,251)",
      [enrolment],
      "INVALID_INPUT",
    );
  });
  it("does not schedule retroactive misses when a cohort already started", async () => {
    await save();
    await confirm();
    const c = await context();
    expect(c.occurrences.every((o) => o.state === "UPCOMING")).toBe(true);
    expect(Date.parse(c.occurrences[0].scheduledAt)).toBeGreaterThan(
      Date.parse(c.serverTime),
    );
  });
  it("rejects foreign enrolment and multi-role visibility on the self surface", async () => {
    await save();
    await owner();
    await db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [foreignLearner],
    );
    await user(3);
    await denied(
      "select public.get_delivery_context($1)",
      [enrolment],
      "NOT_FOUND_OR_FORBIDDEN",
    );
    await denied(
      "select public.save_delivery_study_plan($1,array[1,2,3,4,5,6,7])",
      [enrolment],
      "NOT_FOUND_OR_FORBIDDEN",
    );
  });
  it("denies non-students, but permits explicit assigned staff metadata reads", async () => {
    await save();
    await user(2);
    await denied(
      "select public.get_delivery_context($1)",
      [enrolment],
      "FORBIDDEN",
    );
    expect(
      await scalar("select public.get_delivery_admin_context($1) as value", [
        enrolment,
      ]),
    ).toHaveProperty("plan");
  });
  it("anonymous callers have no delivery RPC access", async () => {
    await db.exec("set role anon");
    await denied(
      "select public.get_delivery_context($1)",
      [enrolment],
      "permission denied",
    );
  });
  it("preserves old dates and misses while changing only future uncompleted occurrences", async () => {
    await historical();
    const before = await context();
    const missed = before.occurrences.filter((o) => o.state === "MISSED");
    expect(missed.length).toBe(3);
    const futureDay = await scalar(
      "select ((clock_timestamp() at time zone 'UTC')::date+2)::text as value",
    );
    await scalar(
      "select public.change_future_delivery_schedule($1,array[1],'00:00','UTC',$2::date) as value",
      [enrolment, futureDay],
    );
    const after = await context();
    expect(after.revisions).toHaveLength(2);
    expect(
      after.occurrences.filter((o) => missed.some((m) => m.id === o.id)),
    ).toEqual(
      before.occurrences.filter((o) => missed.some((m) => m.id === o.id)),
    );
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.scheduled_learning_occurrences where enrolment_id=$1",
        [enrolment],
      ),
    ).toBeGreaterThan(30);
    await denied(
      "update public.scheduled_learning_occurrences set scheduled_at=scheduled_at+interval '1 day' where enrolment_id=$1",
      [enrolment],
      "immutable",
    );
  });
  it("rejects past/same-effective schedule changes", async () => {
    await save();
    await confirm();
    await denied(
      "select public.change_future_delivery_schedule($1,array[1,2,3,4,5,6,7],'19:00','Europe/London',current_date)",
      [enrolment],
      "INVALID_INPUT",
    );
  });
});

describe("completion and catch-up authority", () => {
  it("records a late miss before completion even without an earlier context read", async () => {
    await historical();
    await progress(0);
    const c = await context();
    expect(c.occurrences[0]).toMatchObject({
      state: "COMPLETED",
      catchUp: "RESOLVED",
    });
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.delivery_catch_up",
      ),
    ).toBe(3);
  });
  it("does not rewrite catch-up resolution when completion is reaffirmed", async () => {
    await historical();
    await progress(0);
    await owner();
    const prior = await scalar(
      "select to_jsonb(c) as value from public.delivery_catch_up c join public.scheduled_learning_occurrences o on o.id=c.occurrence_id where o.lesson_id=$1",
      [lessons[0]],
    );
    await progress(0);
    await owner();
    expect(
      await scalar(
        "select to_jsonb(c) as value from public.delivery_catch_up c join public.scheduled_learning_occurrences o on o.id=c.occurrence_id where o.lesson_id=$1",
        [lessons[0]],
      ),
    ).toEqual(prior);
  });
  it("reports current material and all unresolved earlier recovery references", async () => {
    await historical();
    const c = await context();
    expect(c.currentLessonId).toBe(lessons[3]);
    expect(c.recoveryLessonIds).toEqual(lessons.slice(0, 3));
    await progress(1);
    expect((await context()).recoveryLessonIds).toEqual([
      lessons[0],
      lessons[2],
    ]);
  });
  it("does not vacuously complete a lesson with no planned segments", async () => {
    await owner();
    expect(
      await scalar("select delivery_private.completed_at($1,$2) as value", [
        fixture.enrolmentId,
        "40000000-0000-4000-8000-000000000001",
      ]),
    ).toBeNull();
  });
  it.each([
    ["2026-09-12T23:59:59.999999Z", null, "UPCOMING"],
    ["2026-09-13T00:00:00Z", null, "DUE"],
    ["2026-09-13T23:59:59.999999Z", null, "DUE"],
    ["2026-09-14T00:00:00Z", null, "DUE"],
    ["2026-09-14T00:00:00.000001Z", null, "MISSED"],
    ["2026-09-14T00:00:00Z", "2026-09-13T12:00:00Z", "COMPLETED"],
  ])(
    "uses explicit scheduled/latest-start boundary %s → %s",
    async (tick, completed, state) => {
      await owner();
      expect(
        await scalar(
          "select delivery_private.occurrence_state('2026-09-13T00:00Z','2026-09-14T00:00Z',null,$1,$2) as value",
          [completed, tick],
        ),
      ).toBe(state);
    },
  );
  it("persists all missed classes idempotently and retains backlog", async () => {
    await historical();
    const c = await context();
    expect(c.backlogCount).toBe(3);
    expect((await context()).backlogCount).toBe(3);
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.delivery_catch_up",
      ),
    ).toBe(3);
  });
  it("valid progress resolves catch-up without erasing the missed requirement", async () => {
    await historical();
    await context();
    await progress(0);
    const c = await context();
    expect(c.occurrences[0]).toMatchObject({
      state: "COMPLETED",
      catchUp: "RESOLVED",
    });
    expect(c.backlogCount).toBe(2);
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.delivery_catch_up",
      ),
    ).toBe(3);
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.objective_mastery where enrolment_id=$1",
        [enrolment],
      ),
    ).toBe(0);
  });
  it("progress correction reopens backlog with history retained", async () => {
    await historical();
    await progress(0);
    await progress(0, "IN_PROGRESS");
    const c = await context();
    expect(c.occurrences[0]).toMatchObject({
      state: "MISSED",
      catchUp: "REQUIRED",
    });
  });
  it("reading repeatedly, support-plan activity and handoffs cannot complete a lesson", async () => {
    await historical();
    await context();
    await context();
    await scalar(
      "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as value",
      [enrolment, lessons[0], randomUUID()],
    );
    expect((await context()).occurrences[0].state).toBe("MISSED");
    await denied(
      "update public.delivery_catch_up set resolved_at=now()",
      [],
      "permission denied",
    );
  });
  it("students cannot assert progress or delete catch-up history", async () => {
    await historical();
    await context();
    await denied(
      "insert into public.lesson_progress(enrolment_id) values($1)",
      [enrolment],
      "permission denied",
    );
    await owner();
    await denied("delete from public.delivery_catch_up", [], "immutable");
  });
});

describe("DELIVERY_V1 local-time latest-start policy", () => {
  it("does not invent a missed start for work already completed by academic authority", async () => {
    await save(7);
    await confirm();
    await progress(0);
    const o = (await context()).occurrences[0];
    expect(o).toMatchObject({
      state: "COMPLETED",
      catchUp: "NONE",
      startedAt: null,
    });
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.delivery_occurrence_starts",
      ),
    ).toBe(0);
    await user();
    await denied(
      "select public.start_scheduled_learning($1)",
      [o.id],
      "POLICY_BLOCKED",
    );
  });
  it("converts daily London 19:00 to next-day 18:00 latest start", async () => {
    const c = await planAt(
      [1, 2, 3, 4, 5, 6, 7],
      "19:00",
      "Europe/London",
      "2026-09-14",
    );
    expect(new Date(c.occurrences[0].scheduledAt).toISOString()).toBe(
      "2026-09-14T18:00:00.000Z",
    );
    expect(new Date(c.occurrences[0].latestStartAt).toISOString()).toBe(
      "2026-09-15T17:00:00.000Z",
    );
    expect(c.occurrences[0].nextScheduledAt).toBe(c.occurrences[1].scheduledAt);
  });
  it("derives Monday/Wednesday/Friday 19:00 windows from the next selected day", async () => {
    const c = await planAt([1, 3, 5], "19:00", "Europe/London", "2026-09-14");
    expect(
      c.occurrences
        .slice(0, 3)
        .map((o) => new Date(o.latestStartAt).toISOString()),
    ).toEqual([
      "2026-09-16T17:00:00.000Z",
      "2026-09-18T17:00:00.000Z",
      "2026-09-21T17:00:00.000Z",
    ]);
  });
  it.each([
    ["2026-09-14T17:59:59.999999Z", "NOT_OPEN"],
    ["2026-09-14T18:00:00Z", "START_ALLOWED"],
    ["2026-09-15T17:00:00Z", "START_ALLOWED"],
    ["2026-09-15T17:00:00.000001Z", "MISSED"],
  ])("uses the exact DB start boundary at %s", async (tick, expected) => {
    await owner();
    expect(
      await scalar(
        "select delivery_private.start_decision('2026-09-14T18:00Z','2026-09-15T17:00Z',null,$1) as value",
        [tick],
      ),
    ).toBe(expected);
  });
  it("converts a learner's selected Asia/Kolkata timezone without UTC-midnight assumptions", async () => {
    const c = await planAt(
      [1, 2, 3, 4, 5, 6, 7],
      "19:00",
      "Asia/Kolkata",
      "2026-09-14",
    );
    expect(new Date(c.occurrences[0].scheduledAt).toISOString()).toBe(
      "2026-09-14T13:30:00.000Z",
    );
    expect(new Date(c.occurrences[0].latestStartAt).toISOString()).toBe(
      "2026-09-15T12:30:00.000Z",
    );
  });
  it.each([
    ["2026-03-28", 22, "2026-03-29T17:00:00.000Z"],
    ["2026-10-24", 24, "2026-10-25T18:00:00.000Z"],
  ])("uses IANA DST rules across %s", async (date, hours, deadline) => {
    const c = await planAt(
      [1, 2, 3, 4, 5, 6, 7],
      "19:00",
      "Europe/London",
      String(date),
    );
    expect(
      (Date.parse(c.occurrences[0].latestStartAt) -
        Date.parse(c.occurrences[0].scheduledAt)) /
        3600000,
    ).toBe(hours);
    expect(new Date(c.occurrences[0].latestStartAt).toISOString()).toBe(
      deadline,
    );
  });
  it("rejects a nonexistent DST local time rather than silently moving it", async () => {
    await owner();
    await denied(
      "select delivery_private.next_slot('2026-03-28T23:00Z',array[7],'01:30','Europe/London')",
      [],
      "INVALID_LOCAL_TIME",
    );
  });
  it("resolves an ambiguous autumn local time to PostgreSQL standard time", async () => {
    await owner();
    expect(
      await scalar(
        "select to_char(delivery_private.next_slot('2026-10-24T23:00Z',array[7],'01:30','Europe/London') at time zone 'UTC','YYYY-MM-DD HH24:MI') as value",
      ),
    ).toBe("2026-10-25 01:30");
  });
  it("uses the next hypothetical cadence slot for the final lesson", async () => {
    await planAt([1, 3, 5], "19:00", "Europe/London", "2026-09-14");
    const last = (await context(25)).occurrences.at(-1)!;
    await owner();
    const expected = await scalar<string>(
      "select to_jsonb(delivery_private.next_slot($1,array[1,3,5],'19:00','Europe/London')-interval '60 minutes') as value",
      [last.scheduledAt],
    );
    expect(Date.parse(last.latestStartAt)).toBe(Date.parse(expected));
  });
  it.each([
    ["25:00", "Europe/London"],
    ["19:00", "Not/AZone"],
    ["19:00", "GMT"],
  ])("rejects invalid preference %s / %s", async (time, zone) => {
    await denied(
      "select public.save_delivery_study_plan($1,array[1,3,5],$2::time,$3)",
      [enrolment, time, zone],
    );
  });
  it("persists a valid explicit start and returns it idempotently", async () => {
    await historical();
    const o = (await context()).occurrences[3];
    const first = await scalar<{ decision: string; startedAt: string }>(
      "select public.start_scheduled_learning($1) as value",
      [o.id],
    );
    expect(first.decision).toBe("STARTED");
    expect(
      await scalar("select public.start_scheduled_learning($1) as value", [
        o.id,
      ]),
    ).toMatchObject({
      decision: "ALREADY_STARTED",
      startedAt: first.startedAt,
    });
    expect((await context()).occurrences[3].state).toBe("STARTED");
    await owner();
    expect(
      await scalar(
        "select delivery_private.occurrence_state($1,$2,$3,null,$2::timestamptz+interval '1 day') as value",
        [o.scheduledAt, o.latestStartAt, first.startedAt],
      ),
    ).toBe("STARTED");
    await denied(
      "delete from public.delivery_occurrence_starts",
      [],
      "immutable",
    );
  });
  it("preserves a valid historical start when governed completion arrives after latest start", async () => {
    await historical();
    await owner();
    // Historical valid-start fixture, constrained by the same insert guard.
    await db.query(
      "insert into public.delivery_occurrence_starts(occurrence_id,started_at,actor_id,source) select id,scheduled_at+interval '30 minutes',$1,'LEARNER_START' from public.scheduled_learning_occurrences where enrolment_id=$2 and ordinal=1",
      [learner, enrolment],
    );
    await user();
    await progress(0);
    const o = (await context()).occurrences[0];
    expect(o).toMatchObject({ state: "COMPLETED", catchUp: "NONE" });
    expect(o.startedAt).not.toBeNull();
    expect(Date.parse(o.completedAt!)).toBeGreaterThan(
      Date.parse(o.latestStartAt),
    );
  });
  it("commits a late first-start denial and retains the miss after late completion", async () => {
    await historical();
    const o = (await context()).occurrences[0];
    expect(
      await scalar("select public.start_scheduled_learning($1) as value", [
        o.id,
      ]),
    ).toMatchObject({ decision: "MISSED", startedAt: null });
    await progress(0);
    expect((await context()).occurrences[0]).toMatchObject({
      state: "COMPLETED",
      startedAt: null,
      catchUp: "RESOLVED",
    });
  });
  it("does not permit foreign or assessment-blocked first starts", async () => {
    await historical();
    const o = (await context()).occurrences[3];
    await user(3);
    await denied(
      "select public.start_scheduled_learning($1)",
      [o.id],
      "NOT_FOUND_OR_FORBIDDEN",
    );
    await user();
    await db.query("select public.start_assessment_attempt($1)", [
      fixture.assessmentId,
    ]);
    await denied(
      "select public.start_scheduled_learning($1)",
      [o.id],
      "ACTIVITY_BLOCKED",
    );
  });
  it("preserves the predecessor deadline and uses an explicit transition anchor for preference changes", async () => {
    await historical();
    const before = await context();
    const boundary = await scalar<string>(
      "select (current_date+1)::text as value",
    );
    await db.query(
      "select public.change_future_delivery_schedule($1,array[1,3,5],'19:00','Europe/London',$2)",
      [enrolment, boundary],
    );
    const after = await context();
    const anchor = after.occurrences.find((o) => o.transitionAnchor)!;
    const index = anchor.ordinal - 1;
    expect(anchor.scheduledAt).toBe(before.occurrences[index].scheduledAt);
    expect(after.occurrences[index - 1]).toEqual(before.occurrences[index - 1]);
    expect(after.occurrences[index - 1].nextScheduledAt).toBe(
      anchor.scheduledAt,
    );
  });
});

describe("agent and continuing Counsellor access", () => {
  it("active course opens learning roles and keeps Examiner assessment controlled", async () => {
    expect(
      await scalar("select public.get_delivery_agent_access($1) as value", [
        enrolment,
      ]),
    ).toMatchObject({
      PROFESSOR: "AVAILABLE",
      TUTOR: "AVAILABLE",
      LAB_INSTRUCTOR: "AVAILABLE",
      EXAMINER: "ASSESSMENT_CONTROLLED",
      COUNSELLOR: "AVAILABLE",
    });
  });
  it.each(["COMPLETED", "PAUSED", "WITHDRAWN"])(
    "closes academic roles for %s, retaining Counsellor and materials",
    async (status) => {
      await owner();
      // Official completion has no public workflow yet; privileged fixture only.
      await db.query("update public.enrolments set status=$1 where id=$2", [
        status,
        enrolment,
      ]);
      await user();
      expect(
        await scalar("select public.get_delivery_agent_access($1) as value", [
          enrolment,
        ]),
      ).toMatchObject({
        PROFESSOR: "CLOSED",
        TUTOR: "CLOSED",
        LAB_INSTRUCTOR: "CLOSED",
        EXAMINER: "CLOSED",
        COUNSELLOR: "AVAILABLE",
      });
      expect(
        await scalar<number>(
          "select count(*)::int as value from public.lessons where programme_version_id=$1",
          [version],
        ),
      ).toBe(30);
    },
  );
  it("active controlled assessment blocks learning access and handoff requests", async () => {
    await db.query("select public.start_assessment_attempt($1)", [
      fixture.assessmentId,
    ]);
    expect(
      await scalar("select public.get_delivery_agent_access($1) as value", [
        enrolment,
      ]),
    ).toHaveProperty("PROFESSOR", "ACTIVITY_BLOCKED");
    await denied(
      "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3)",
      [enrolment, lessons[0], randomUUID()],
      "ACTIVITY_BLOCKED",
    );
    expect(
      await scalar("select public.get_counsellor_lifecycle() as value"),
    ).toHaveProperty("available", true);
  });
  it("projects Prospect, Active-course and Post-course without profile inference", async () => {
    expect(
      await scalar("select public.get_counsellor_lifecycle() as value"),
    ).toHaveProperty("mode", "ACTIVE_COURSE");
    await user(3);
    expect(
      await scalar("select public.get_counsellor_lifecycle() as value"),
    ).toHaveProperty("mode", "PROSPECT");
    await owner();
    await db.query(
      "update public.enrolments set status='COMPLETED' where student_id=$1",
      [learner],
    );
    await user();
    expect(
      await scalar("select public.get_counsellor_lifecycle() as value"),
    ).toMatchObject({ mode: "POST_COURSE", available: true });
  });
});

describe("bounded structured liaison and privacy", () => {
  it("keeps OPEN learner referrals immutable without modifying academic authority", async () => {
    const id = await scalar(
      "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3) as value",
      [enrolment, lessons[0], randomUUID()],
    );
    await owner();
    await denied(
      "update public.delivery_handoffs set status='ACKNOWLEDGED' where id=$1",
      [id],
      "immutable",
    );
    await denied(
      "delete from public.delivery_handoffs where id=$1",
      [id],
      "immutable",
    );
    for (const table of [
      "learning_evidence",
      "lesson_progress",
      "objective_mastery",
    ])
      expect(
        await scalar<number>(
          `select count(*)::int as value from public.${table} where enrolment_id=$1`,
          [enrolment],
        ),
      ).toBe(0);
  });
  it.each([
    ["MISSED_LESSON_PRACTICE", "TUTOR"],
    ["OBJECTIVE_REINFORCEMENT", "TUTOR"],
    ["PRACTICAL_PREREQUISITE", "TUTOR"],
    ["PRACTICAL_HELP", "LAB_INSTRUCTOR"],
  ])("derives the reviewed route for %s", async (reason, destination) => {
    const request = randomUUID();
    const args = [enrolment, lessons[0], objectives[0], reason, request];
    const id = await scalar(
      "select public.request_delivery_handoff($1,$2,$3,$4,$5) as value",
      args,
    );
    expect(
      await scalar(
        "select public.request_delivery_handoff($1,$2,$3,$4,$5) as value",
        args,
      ),
    ).toBe(id);
    const rows = await scalar<Record<string, unknown>[]>(
      "select public.list_delivery_handoffs($1) as value",
      [enrolment],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      initiator_kind: "LEARNER",
      status: "OPEN",
      destination_profile: destination,
      provenance: "LEARNER_REQUEST",
    });
    expect(String(rows[0].summary).length).toBeLessThanOrEqual(120);
    expect(rows[0]).not.toHaveProperty("source_profile");
    expect(rows[0]).not.toHaveProperty("resolved_at");
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.objective_mastery where enrolment_id=$1",
        [enrolment],
      ),
    ).toBe(0);
  });
  it("rejects forged reason, wrong lesson version and neighbouring objective", async () => {
    for (const args of [
      [enrolment, lessons[0], null, "EXAM_ANSWER", randomUUID()],
      [enrolment, lessons[0], objectives[1], "PRACTICAL_HELP", randomUUID()],
      [
        enrolment,
        "40000000-0000-4000-8000-000000000001",
        null,
        "PRACTICAL_HELP",
        randomUUID(),
      ],
    ])
      await denied(
        "select public.request_delivery_handoff($1,$2,$3,$4,$5)",
        args,
      );
  });
  it("foreign learners cannot inspect or mutate another referral", async () => {
    const id = await scalar(
      "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3) as value",
      [enrolment, lessons[0], randomUUID()],
    );
    await user(3);
    await denied(
      "select public.list_delivery_handoffs($1)",
      [enrolment],
      "NOT_FOUND_OR_FORBIDDEN",
    );
    await denied(
      "update public.delivery_handoffs set status='OPEN' where id=$1",
      [id],
      "permission denied",
    );
  });
  it("caps open handoffs and returns bounded pages", async () => {
    for (let i = 0; i < 20; i++)
      await scalar(
        "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3) as value",
        [enrolment, lessons[0], randomUUID()],
      );
    await denied(
      "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3)",
      [enrolment, lessons[0], randomUUID()],
      "LIMIT_EXCEEDED",
    );
    expect(
      await scalar<unknown[]>(
        "select public.list_delivery_handoffs($1) as value",
        [enrolment],
      ),
    ).toHaveLength(20);
  });
  it("audits metadata only and fails closed on audit failure", async () => {
    await save();
    await confirm();
    await owner();
    const audit = await scalar<unknown>(
      "select jsonb_agg(after_state) as value from public.audit_events where source='DELIVERY_V1'",
    );
    expect(JSON.stringify(audit)).not.toMatch(
      /Objective prose|evidence_reference|answer_key|marking_guidance|support prose|summary|prompt|credential/,
    );
    await db.exec(
      "create function delivery_private.test_audit_failure() returns trigger language plpgsql as $$begin if NEW.source='DELIVERY_V1' then raise exception 'audit unavailable'; end if; return NEW; end$$; create trigger test_audit_failure before insert on public.audit_events for each row execute function delivery_private.test_audit_failure()",
    );
    await user();
    await denied(
      "select public.request_delivery_handoff($1,$2,null,'PRACTICAL_HELP',$3)",
      [enrolment, lessons[0], randomUUID()],
      "audit unavailable",
    );
    expect(
      await scalar<unknown[]>(
        "select public.list_delivery_handoffs($1) as value",
        [enrolment],
      ),
    ).toHaveLength(0);
  });
  it.each(["authenticated", "service_role"])(
    "%s cannot mutate tables or call private delivery helpers",
    async (role) => {
      await owner();
      expect(
        await scalar<boolean>(
          "select has_table_privilege($1,'public.delivery_study_plans','INSERT,UPDATE,DELETE') as value",
          [role],
        ),
      ).toBe(false);
      expect(
        await scalar<boolean>(
          "select has_schema_privilege($1,'delivery_private','USAGE') as value",
          [role],
        ),
      ).toBe(false);
      await db.exec(`set role ${role}`);
      await denied(
        "insert into public.delivery_study_plans(enrolment_id) values($1)",
        [enrolment],
        "permission denied",
      );
      await denied(
        "select delivery_private.refresh_catch_up($1)",
        [enrolment],
        "permission denied",
      );
    },
  );
});

describe("second-review delivery authority corrections", () => {
  it("instructor/admin IN_PROGRESS within the start window creates no learner start", async () => {
    await historical();
    expect((await context()).occurrences[3].state).toBe("DUE");
    await progress(3, "IN_PROGRESS");
    expect((await context()).occurrences[3]).toMatchObject({
      state: "DUE",
      startedAt: null,
      catchUp: "NONE",
    });
    await owner();
    expect(
      await scalar<number>(
        "select count(*)::int as value from public.delivery_occurrence_starts",
      ),
    ).toBe(0);
  });
  it("exposes no learner acknowledgement RPC", async () => {
    expect(
      await scalar<number>(
        "select count(*)::int as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acknowledge_delivery_handoff'",
      ),
    ).toBe(0);
  });
  it.each([
    ["2026-09-14T09:00:00Z", "2026-09-14", "2026-09-14T18:00:00.000Z"],
    ["2026-09-14T19:00:00Z", "2026-09-14", "2026-09-16T18:00:00.000Z"],
    ["2026-09-14T18:00:00Z", "2026-09-14", "2026-09-16T18:00:00.000Z"],
    ["2026-09-14T09:00:00Z", "2026-09-21", "2026-09-21T18:00:00.000Z"],
  ])(
    "selects the first eligible slot strictly after %s with cohort floor %s",
    async (confirmed, floor, expected) => {
      const plan = await save();
      await owner();
      // Fixed DB-clock input only to a private fixture path, never a public parameter.
      await db.query(
        "select delivery_private.generate_schedule($1,array[1,3,5],'19:00','Europe/London',$2::date,true,$3::timestamptz)",
        [plan, floor, confirmed],
      );
      const rows = (
        await db.query<{ scheduled_at: Date; state: string }>(
          "select scheduled_at,delivery_private.occurrence_state(scheduled_at,latest_start_at,null,null,$2::timestamptz) as state from public.scheduled_learning_occurrences where enrolment_id=$1 order by ordinal",
          [enrolment, confirmed],
        )
      ).rows;
      expect(new Date(rows[0].scheduled_at).toISOString()).toBe(expected);
      expect(rows).toHaveLength(30);
      expect(
        rows.every(
          (row) =>
            row.state === "UPCOMING" &&
            new Date(row.scheduled_at).getTime() > Date.parse(confirmed),
        ),
      ).toBe(true);
    },
  );
  it("public confirmation uses its DB timestamp without retroactive misses", async () => {
    await save(7);
    await confirm();
    const c = await context();
    await owner();
    const expected = await scalar<Date>(
      "select delivery_private.next_slot(confirmed_at,study_days,local_start_time,timezone) as value from public.delivery_study_plans where enrolment_id=$1",
      [enrolment],
    );
    expect(new Date(c.occurrences[0].scheduledAt).toISOString()).toBe(
      new Date(expected).toISOString(),
    );
    expect(
      c.occurrences.every(
        (o) =>
          o.startedAt === null &&
          o.catchUp === "NONE" &&
          Date.parse(o.scheduledAt) > Date.parse(c.plan!.confirmedAt!),
      ),
    ).toBe(true);
    expect(c.backlogCount).toBe(0);
  });
});

const deliveryTables = [
  "delivery_study_plans",
  "delivery_schedule_revisions",
  "scheduled_learning_occurrences",
  "delivery_occurrence_starts",
  "delivery_catch_up",
  "delivery_handoffs",
];
const deliveryRpcs = [
  "save_delivery_study_plan",
  "confirm_delivery_study_plan",
  "change_future_delivery_schedule",
  "get_delivery_context",
  "get_delivery_admin_context",
  "get_delivery_agent_access",
  "get_counsellor_lifecycle",
  "request_delivery_handoff",
  "list_delivery_handoffs",
  "list_delivery_admin_handoffs",
  "get_delivery_schedule_history",
  "get_delivery_admin_schedule_history",
  "start_scheduled_learning",
];
const tableRights = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];
const columnRights = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
async function acceptanceSql() {
  const migration = await readFile(
    "supabase/migrations/202609110023_phase3_delivery_lifecycle.sql",
    "utf8",
  );
  const start = migration.indexOf("-- Effective-ACL acceptance:");
  expect(start).toBeGreaterThan(0);
  return migration.slice(start);
}
describe("delivery effective ACL acceptance", () => {
  it.each(["anon", "authenticated", "service_role"])(
    "%s has no table/column/private access and only intended public RPC rights",
    async (role) => {
      await owner();
      for (const table of deliveryTables) {
        for (const right of tableRights)
          expect(
            await scalar<boolean>(
              "select has_table_privilege($1,$2,$3) as value",
              [role, "public." + table, right],
            ),
          ).toBe(false);
        const columns = (
          await db.query<{ attname: string }>(
            "select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped",
            ["public." + table],
          )
        ).rows;
        for (const column of columns)
          for (const right of columnRights)
            expect(
              await scalar<boolean>(
                "select has_column_privilege($1,$2,$3,$4) as value",
                [role, "public." + table, column.attname, right],
              ),
            ).toBe(false);
      }
      for (const right of ["USAGE", "CREATE"])
        expect(
          await scalar<boolean>(
            "select has_schema_privilege($1,'delivery_private',$2) as value",
            [role, right],
          ),
        ).toBe(false);
      const functions = (
        await db.query<{ oid: number; nspname: string }>(
          "select p.oid,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='delivery_private' or (n.nspname='public' and p.proname=any($1))",
          [deliveryRpcs],
        )
      ).rows;
      expect(functions.filter((f) => f.nspname === "public")).toHaveLength(
        deliveryRpcs.length,
      );
      expect(
        functions.filter((f) => f.nspname === "delivery_private").length,
      ).toBeGreaterThan(10);
      for (const f of functions)
        expect(
          await scalar<boolean>(
            "select has_function_privilege($1,$2::oid,'EXECUTE') as value",
            [role, f.oid],
          ),
        ).toBe(role === "authenticated" && f.nspname === "public");
    },
  );
  it.each(
    deliveryTables.flatMap((table) =>
      [...tableRights, ...columnRights.map((r) => r + " (id)")].map((right) => [
        table,
        right,
      ]),
    ),
  )(
    "rejects inherited %s %s even after direct revocation",
    async (table, right) => {
      await owner();
      await db.exec(
        "create role unsafe_delivery_member; grant unsafe_delivery_member to service_role",
      );
      await db.exec(
        "grant " +
          right +
          " on public." +
          table +
          " to unsafe_delivery_member; revoke all on public." +
          table +
          " from service_role",
      );
      await denied(
        await acceptanceSql(),
        [],
        "Unsafe effective delivery privileges",
      );
    },
  );
  it.each(["USAGE", "CREATE"])(
    "rejects inherited private schema %s",
    async (right) => {
      await owner();
      await db.exec(
        "create role unsafe_delivery_member; grant unsafe_delivery_member to service_role; grant " +
          right +
          " on schema delivery_private to unsafe_delivery_member",
      );
      await denied(
        await acceptanceSql(),
        [],
        "Unsafe effective delivery privileges",
      );
    },
  );
  it("rejects inherited execution on every private helper and public delivery RPC", async () => {
    await owner();
    await db.exec(
      "create role unsafe_delivery_member; grant unsafe_delivery_member to service_role",
    );
    const funcs = (
      await db.query<{ signature: string }>(
        "select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='delivery_private' or (n.nspname='public' and p.proname=any($1))",
        [deliveryRpcs],
      )
    ).rows;
    const acceptance = await acceptanceSql();
    for (const f of funcs) {
      await db.exec(
        "grant execute on function " +
          f.signature +
          " to unsafe_delivery_member",
      );
      await denied(acceptance, [], "Unsafe effective delivery privileges");
      await db.exec(
        "revoke execute on function " +
          f.signature +
          " from unsafe_delivery_member",
      );
    }
  });
  it("rejects authenticated private helper inheritance and missing intended public permission", async () => {
    await owner();
    await db.exec(
      "create role unsafe_delivery_member; grant unsafe_delivery_member to authenticated; grant execute on function delivery_private.guard_history() to unsafe_delivery_member",
    );
    await denied(
      await acceptanceSql(),
      [],
      "Unsafe effective delivery privileges",
    );
    await db.exec(
      "revoke execute on function delivery_private.guard_history() from unsafe_delivery_member; revoke execute on function public.confirm_delivery_study_plan(uuid) from authenticated",
    );
    await denied(
      await acceptanceSql(),
      [],
      "Unsafe effective delivery privileges",
    );
  });
});
