import { localPostgresDatabase } from "./local-postgres-database";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  people,
  rpc,
  seedPeople,
  as,
  type Query,
} from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";
import { canonicalStudyDays } from "@/domain/academy-scheduler";
import { academyPlanSchema, timetableSchema } from "@/domain/academy-delivery";
let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>,
  q: Query,
  enrolment: string,
  otherEnrolment: string,
  courseId: string;
const { admin, learnerA, learnerB, instructor, registrar } = people;
const reason = "Synthetic activation and recovery acceptance";
let startOn: string;
async function timeFixture(delta: string) {
  // DB-owner temporal fixture: append a genuine immutable schedule revision,
  // with independent temporal fixture roots. No trigger or permission guard is disabled.
  const old = (
    await q(
      "select * from public.academy_schedules where enrolment_id=$1 and superseded_at is null",
      [enrolment],
    )
  ).rows[0];
  await q(
    "update public.academy_schedules set superseded_at=clock_timestamp() where id=$1",
    [old.id],
  );
  const next = (
    await q(
      `insert into public.academy_schedules(enrolment_id,revision,format_id,start_on,end_on,study_days,local_time,timezone,effective_from,request_key,plan_summary)
 select enrolment_id,revision+1,format_id,start_on,end_on,study_days,local_time,timezone,clock_timestamp(),$2,plan_summary from public.academy_schedules where id=$1 returning id`,
      [old.id, randomUUID()],
    )
  ).rows[0].id;
  await q(
    `insert into public.academy_schedule_items(schedule_id,enrolment_id,sequence,unit_index,kind,ref,part,parts,session_index,local_date,starts_at,ends_at,minutes)
 select $2,enrolment_id,sequence,unit_index,kind,ref,part,parts,session_index,current_date,clock_timestamp()+$3::interval+sequence*interval '1 second',clock_timestamp()+$3::interval+sequence*interval '1 second'+make_interval(mins=>minutes),minutes from public.academy_schedule_items where schedule_id=$1`,
    [old.id, next, delta],
  );
  return (
    await q(
      "select * from public.academy_schedule_items where schedule_id=$1 order by sequence",
      [next],
    )
  ).rows;
}
beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, args) => db.query(sql, args) as ReturnType<Query>;
  await seedPeople(q);
  const c = await publishUnifiedTestCourse(q, "unified-activation-test");
  courseId = c.courseId;
  await rpc(q, admin, "create_course_coupon", [
    "ACTIVATE-TEST",
    100,
    new Date(Date.now() + 86400000).toISOString(),
    5,
    courseId,
    reason,
  ]);
  enrolment = (
    await rpc<{ enrolmentId: string }>(
      q,
      learnerA,
      "create_unified_course_order",
      ["unified-activation-test", "ACTIVATE-TEST"],
    )
  ).enrolmentId;
  otherEnrolment = (
    await rpc<{ enrolmentId: string }>(
      q,
      learnerB,
      "create_unified_course_order",
      ["unified-activation-test", "ACTIVATE-TEST"],
    )
  ).enrolmentId;
  startOn = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}, 180000);
afterAll(async () => {
  await db?.close();
});
describe("individual course activation and 23h59m authority", () => {
  it("purchase grants access without a duration or timetable", async () => {
    expect(
      (
        await q("select format_id from public.academy_enrolments where id=$1", [
          enrolment,
        ])
      ).rows[0].format_id,
    ).toBeNull();
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_schedules where enrolment_id=$1",
          [enrolment],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("previews every feasible duration, in academic order, with exact elapsed windows including DST", async () => {
    for (const f of approvedTestPackage().deliveryFormats) {
      const raw = await rpc(q, learnerA, "preview_my_academy_schedule", [
        enrolment,
        f.formatId,
        startOn,
        canonicalStudyDays(f.maxStudyDaysPerWeek),
        "09:00",
        "Europe/London",
      ]);
      const plan = academyPlanSchema.parse(raw);
      expect(plan.feasible).toBe(true);
      if (!plan.feasible) throw new Error(plan.message);
      expect(new Set(plan.items.map((i) => i.kind))).toEqual(
        new Set(["LESSON", "LAB", "REVISION", "ASSESSMENT"]),
      );
      for (const i of plan.items) {
        expect(i.opensAt).toBe(i.startsAt);
        expect(Date.parse(i.closesAt!) - Date.parse(i.opensAt!)).toBe(
          1439 * 60000,
        );
      }
      for (let i = 1; i < plan.items.length; i++)
        expect(Date.parse(plan.items[i].startsAt)).toBeGreaterThanOrEqual(
          Date.parse(plan.items[i - 1].startsAt),
        );
    }
  });
  it("confirms once, rejects changed same-key choices and a second activation", async () => {
    const key = randomUUID(),
      args = [
        enrolment,
        "STANDARD_6W",
        startOn,
        [1, 2, 3, 4, 5, 6],
        "09:00",
        "Europe/London",
        key,
      ];
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", args),
    ).toMatchObject({ ok: true, replayed: false, revision: 1 });
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", args),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", [
        ...args.slice(0, 4),
        "10:00",
        "Europe/London",
        key,
      ]),
    ).toMatchObject({ ok: false, code: "REQUEST_CONFLICT" });
    expect(
      await rpc(q, learnerA, "confirm_my_academy_schedule", [
        ...args.slice(0, 6),
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "PLAN_EXISTS" });
    const t = timetableSchema.parse(
      await rpc(q, learnerA, "get_my_academy_timetable", [enrolment]),
    );
    for (const i of t.items)
      expect(Date.parse(i.closesAt!) - Date.parse(i.startsAt)).toBe(
        1439 * 60000,
      );
  });
  it("refuses impossible choices and foreign enrolment activation", async () => {
    await expect(
      rpc(q, learnerA, "confirm_my_academy_schedule", [
        otherEnrolment,
        "STANDARD_6W",
        startOn,
        [1, 2, 3, 4, 5, 6],
        "09:00",
        "Europe/London",
        randomUUID(),
      ]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    expect(
      await rpc(q, learnerB, "preview_my_academy_schedule", [
        otherEnrolment,
        "STANDARD_6W",
        startOn,
        [1],
        "09:00",
        "Europe/London",
      ]),
    ).toMatchObject({ feasible: false });
  });
  it("denies all learning entry points before release", async () => {
    const items = (
      await q(
        "select * from public.academy_schedule_items where enrolment_id=$1 order by sequence",
        [enrolment],
      )
    ).rows;
    const lesson = items.find((i) => i.kind === "LESSON")!,
      lab = items.find((i) => i.kind === "LAB")!,
      revision = items.find((i) => i.kind === "REVISION")!,
      exam = items.find((i) => i.kind === "ASSESSMENT")!;
    await expect(
      rpc(q, learnerA, "get_my_academy_lesson", [enrolment, lesson.ref]),
    ).rejects.toThrow("NOT_RELEASED");
    expect(
      await rpc(q, learnerA, "open_my_academy_professor_classroom", [
        enrolment,
        lesson.id,
      ]),
    ).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    expect(
      await rpc(q, learnerA, "submit_my_academy_lab", [
        enrolment,
        lab.ref,
        "Synthetic response",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    await expect(
      rpc(q, learnerA, "get_my_unified_revision", [enrolment, revision.id]),
    ).rejects.toThrow("NOT_RELEASED");
    expect(
      await rpc(q, learnerA, "start_my_academy_assessment", [
        enrolment,
        exam.ref,
      ]),
    ).toMatchObject({ ok: false, code: "SITTING_NOT_OPEN" });
  });
  it("uses inclusive opening and exclusive closing for every kind, with no public clock override", async () => {
    await q("select set_config('request.jwt.claim.sub',$1,false)", [
      learnerA.auth,
    ]);
    try {
      const items = (
        await q(
          "select * from public.academy_schedule_items where enrolment_id=$1 order by sequence",
          [enrolment],
        )
      ).rows;
      for (const kind of ["LESSON", "LAB", "REVISION", "ASSESSMENT"]) {
        const i = items.find((i) => i.kind === kind)!;
        const args = [enrolment, kind, i.ref, i.starts_at];
        expect(
          (
            await q(
              "select academy_private.unified_activity_open_at($1,$2,$3,null,$4) v",
              args,
            )
          ).rows[0].v,
        ).toBe(true);
        expect(
          (
            await q(
              "select academy_private.unified_activity_open_at($1,$2,$3,null,$4::timestamptz+interval '1439 minutes') v",
              args,
            )
          ).rows[0].v,
        ).toBe(false);
        expect(
          (
            await q(
              "select academy_private.unified_activity_open_at($1,$2,$3,null,$4::timestamptz-interval '1 microsecond') v",
              args,
            )
          ).rows[0].v,
        ).toBe(false);
      }
    } finally {
      await q("select set_config('request.jwt.claim.sub','',false)");
    }
    await expect(
      as(
        q,
        learnerA,
        "select academy_private.unified_activity_open_at($1,'LESSON','forged',null,now())",
        [enrolment],
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("opens live learning, revision, and independent timed attempts, retaining the exam firewall", async () => {
    const items = await timeFixture("-10 minutes");
    const lesson = items.find((i) => i.kind === "LESSON")!,
      revision = items.find((i) => i.kind === "REVISION")!,
      exam = items.find((i) => i.kind === "ASSESSMENT")!;
    expect(
      await rpc(q, learnerA, "get_my_academy_lesson", [enrolment, lesson.ref]),
    ).toBeTruthy();
    expect(
      await rpc(q, learnerA, "open_my_academy_professor_classroom", [
        enrolment,
        lesson.id,
      ]),
    ).toMatchObject({ ok: true });
    const r = await rpc(q, learnerA, "get_my_unified_revision", [
      enrolment,
      revision.id,
    ]);
    expect(JSON.stringify(r)).not.toMatch(
      /answerKey|markingGuidance|expectedAnswer/,
    );
    const a = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      learnerA,
      "start_my_academy_assessment",
      [enrolment, exam.ref],
    );
    expect(a.ok).toBe(true);
    const timer = (
      await q(
        "select extract(epoch from expires_at-started_at)/60 duration from public.academy_assessment_attempts where id=$1",
        [a.attemptId],
      )
    ).rows[0];
    expect(Number(timer.duration)).toBeLessThan(1439);
    await expect(
      rpc(q, learnerA, "get_my_unified_revision", [enrolment, revision.id]),
    ).rejects.toThrow("ACTIVITY_BLOCKED");
    await rpc(q, learnerA, "submit_my_academy_attempt", [a.attemptId]);
  });
  it("closes expired learning and requires a reviewed, immutable recovery without resetting results", async () => {
    const items = await timeFixture("-3 days");
    const lesson = items.find((i) => i.kind === "LESSON")!,
      lab = items.find((i) => i.kind === "LAB")!;
    await expect(
      rpc(q, learnerA, "get_my_academy_lesson", [enrolment, lesson.ref]),
    ).rejects.toThrow("NOT_RELEASED");
    expect(
      await rpc(q, learnerA, "open_my_academy_professor_classroom", [
        enrolment,
        lesson.id,
      ]),
    ).toMatchObject({ ok: false });
    expect(
      await rpc(q, learnerA, "submit_my_academy_lab", [
        enrolment,
        lab.ref,
        "Late synthetic response",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    const at = new Date(Date.now() + 3600000).toISOString(),
      key = randomUUID();
    const args = [enrolment, lesson.id, at, "MISSED_WINDOW", key];
    const r = await rpc<{ requestId: string }>(
      q,
      learnerA,
      "request_my_course_recovery",
      args,
    );
    expect(
      await rpc(q, learnerA, "request_my_course_recovery", args),
    ).toMatchObject({ requestId: r.requestId, replayed: true });
    for (const who of [learnerA, instructor, registrar])
      await expect(
        rpc(q, who, "review_course_recovery", [r.requestId, true, reason]),
      ).rejects.toThrow("FORBIDDEN");
    expect(
      await rpc(q, admin, "review_course_recovery", [
        r.requestId,
        true,
        reason,
      ]),
    ).toMatchObject({ ok: true, state: "APPROVED" });
    expect(
      await rpc(q, admin, "review_course_recovery", [
        r.requestId,
        true,
        reason,
      ]),
    ).toMatchObject({ replayed: true });
    expect(
      (
        await rpc<unknown[]>(q, learnerA, "list_my_course_recoveries", [
          enrolment,
        ])
      ).length,
    ).toBe(1);
    await expect(
      rpc(q, learnerB, "list_my_course_recoveries", [enrolment]),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    const t = timetableSchema.parse(
      await rpc(q, learnerA, "get_my_academy_timetable", [enrolment]),
    );
    const recovered = t.items.find((i) => i.id === lesson.id)!;
    expect(Date.parse(recovered.opensAt!)).toBe(Date.parse(at));
    expect(Date.parse(recovered.closesAt!) - Date.parse(at)).toBe(1439 * 60000);
    await expect(
      q("update public.course_engine_recoveries set opens_at=now()"),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    await expect(
      q("delete from public.course_engine_recoveries"),
    ).rejects.toThrow("IMMUTABLE_HISTORY");
    const exam = items.find((i) => i.kind === "ASSESSMENT")!;
    await expect(
      rpc(q, learnerA, "request_my_course_recovery", [
        enrolment,
        exam.id,
        at,
        "MISSED_WINDOW",
        randomUUID(),
      ]),
    ).rejects.toThrow("RECOVERY_NOT_ELIGIBLE");
  });
});
