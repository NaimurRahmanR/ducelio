import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "./db-helper";
import { localPostgresDatabase } from "./local-postgres-database";
import {
  approvedTestPackage,
  completeLabs,
  people,
  responseBody,
  rpc,
  seedPeople,
  publishAcademyCourse,
  type Person,
  type Query,
} from "./academy-fixture";
import { closeSittingNow, sittingClosesIn } from "./academy-release-fixture";
import { validateAcademyCoursePackage } from "@/domain/academy-course-package";
import {
  academyPlanSchema,
  attemptSchema,
  myAcademyEnrolmentsSchema,
  resultsSchema,
  scheduleWriteSchema,
  startAttemptSchema,
  submitAttemptSchema,
  timetableSchema,
} from "@/domain/academy-delivery";

// Migration 202611050075 (docs/61 section 3), end to end over the real
// learner RPCs, on PGlite by default and on a disposable LOCAL PostgreSQL
// when DUCELIO_TEST_POSTGRES_URL is set. Time is moved only by the database
// owner (schedule items/attempt timestamps), exactly like the existing
// Academy suites; no guard is disabled for any learner call.
let db: PGlite | Awaited<ReturnType<typeof localPostgresDatabase>>;
let q: Query;
const reason = "Synthetic learner academic policy acceptance";
const { admin, learnerA, learnerB, learnerC } = people;
const extra: Person[] = Array.from({ length: 11 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `10000000-0000-4000-8000-0000000007${n}`,
    auth: `81000000-0000-4000-8000-0000000007${n}`,
    email: `leaderboard-${n}@example.com`,
    role: "STUDENT",
  };
});
const template = (ref: string) =>
  approvedTestPackage().curriculum.assessmentTemplates.find(
    (t: { key: string }) => t.key === ref,
  );
const maxMarks = (ref: string) =>
  template(ref).questions.reduce(
    (n: number, x: { maxMarks: number }) => n + x.maxMarks,
    0,
  );
const day = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const courses: Record<string, { courseId: string; slug: string }> = {};
const enrol: Record<string, string> = {};
let orgId = "";

async function seedExtraLearners() {
  await q("alter table auth.users disable trigger academy_identity");
  for (const p of extra) {
    await q(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [p.auth, p.email],
    );
    await q(
      "insert into public.app_users(id,auth_user_id,display_name) values($1,$2,$3)",
      [p.id, p.auth, p.email],
    );
    await q(
      "insert into public.role_grants(user_id,role) values($1,'STUDENT')",
      [p.id],
    );
    await q(
      "insert into public.student_profiles(user_id,student_number) values($1,$2)",
      [p.id, `LAP-${p.id.slice(-3)}`],
    );
  }
  await q("alter table auth.users enable trigger academy_identity");
}

type Pkg = ReturnType<typeof approvedTestPackage>;
async function publishCourse(
  key: string,
  mutate: (pkg: Pkg) => void = () => {},
  organisationId?: string,
) {
  const pkg = approvedTestPackage(key);
  pkg.course.demoContent = true;
  mutate(pkg);
  const checked = validateAcademyCoursePackage(pkg);
  if (!checked.valid) throw new Error(JSON.stringify(checked.errors));
  const packageId = organisationId
    ? await rpc<string>(q, admin, "upload_organisation_course_package", [
        organisationId,
        JSON.stringify(pkg),
        reason,
      ])
    : await rpc<string>(q, admin, "upload_unified_course_package", [
        JSON.stringify(pkg),
        reason,
      ]);
  const stored = await rpc(q, admin, "get_academy_course_package_content", [
    packageId,
  ]);
  const review = validateAcademyCoursePackage(stored);
  if (!review.valid) throw new Error(JSON.stringify(review.errors));
  await rpc(q, admin, "mark_academy_course_package_validated", [
    packageId,
    JSON.stringify(review.review),
    reason,
  ]);
  const published = await rpc<{ courseId: string }>(
    q,
    admin,
    "publish_unified_course",
    [packageId, key, "GBP", 10001, null, reason],
  );
  await rpc(q, admin, "create_course_coupon", [
    `${key.toUpperCase()}-FREE`,
    100,
    new Date(Date.now() + 86400000).toISOString(),
    50,
    published.courseId,
    reason,
  ]);
  courses[key] = { courseId: published.courseId, slug: key };
  return published.courseId;
}
async function join(person: Person, key: string) {
  const r = await rpc<{ ok: boolean; enrolmentId: string }>(
    q,
    person,
    "create_unified_course_order",
    [key, `${key.toUpperCase()}-FREE`],
  );
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.enrolmentId;
}
async function confirm(
  person: Person,
  enrolment: string,
  time: string,
  timezone = "Europe/London",
  startOn = day(1),
) {
  return scheduleWriteSchema.parse(
    await rpc(q, person, "confirm_my_academy_schedule", [
      enrolment,
      "ACCELERATED_2W",
      startOn,
      ALL_DAYS,
      time,
      timezone,
      randomUUID(),
    ]),
  );
}
// Owner-only time travel: every part of one activity starts at now()+offset
// (its unified 23h59m window follows from starts_at).
async function moveItems(
  enrolment: string,
  kind: string,
  ref: string,
  offset: string,
) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  try {
    await q(
      `update public.academy_schedule_items i
          set starts_at = now() + $4::interval + (i.part - 1) * interval '1 minute',
              ends_at = now() + $4::interval + (i.part - 1) * interval '1 minute' + make_interval(mins => i.minutes),
              opens_at = now() + $4::interval + (i.part - 1) * interval '1 minute',
              closes_at = now() + $4::interval + (i.part - 1) * interval '1 minute' + interval '1439 minutes'
        where i.enrolment_id = $1 and i.kind = $2 and i.ref = $3
          and i.schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
      [enrolment, kind, ref, offset],
    );
  } finally {
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
  }
}
async function item(enrolment: string, kind: string, ref: string) {
  return (
    await q(
      `select i.* from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
        where s.enrolment_id = $1 and s.superseded_at is null and i.kind = $2 and i.ref = $3 order by i.sequence limit 1`,
      [enrolment, kind, ref],
    )
  ).rows[0] as { id: string; starts_at: Date; ends_at: Date };
}
async function start(person: Person, enrolment: string, ref: string) {
  return startAttemptSchema.parse(
    await rpc(q, person, "start_my_academy_assessment", [enrolment, ref]),
  );
}
// Answers the first `correct` questions correctly and leaves the rest
// unanswered (0 marks; a deliberately wrong body is not valid for every
// performance-based question type).
async function answer(
  person: Person,
  attemptId: string,
  ref: string,
  correct: number,
) {
  const questions = template(ref).questions;
  let marks = 0;
  for (const [i, question] of questions.entries()) {
    if (i >= correct) continue;
    marks += question.maxMarks;
    const r = await rpc<{ ok: boolean }>(
      q,
      person,
      "record_my_academy_response",
      [
        attemptId,
        question.position,
        responseBody(question, true),
        `k-${randomUUID()}`,
      ],
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
  return marks;
}
async function sit(
  person: Person,
  enrolment: string,
  ref: string,
  correct: number,
) {
  const s = await start(person, enrolment, ref);
  if (!s.ok) throw new Error(JSON.stringify(s));
  const marks = await answer(person, s.attemptId, ref, correct);
  submitAttemptSchema.parse(
    await rpc(q, person, "submit_my_academy_attempt", [s.attemptId]),
  );
  return { attemptId: s.attemptId, marks };
}
const PROTECTED =
  /"score"|maxScore|"marks"|answerKey|correctAnswer|expectedAnswer|explanation|markingGuidance|correctOption|"review"|courseScoreBp":\d/;

beforeAll(async () => {
  db = process.env.DUCELIO_TEST_POSTGRES_URL
    ? await localPostgresDatabase()
    : await testDatabase({ supabaseDefaultPrivileges: true });
  q = (sql, args) => db.query(sql, args) as ReturnType<Query>;
  await seedPeople(q);
  await seedExtraLearners();
  await q(
    `insert into public.role_grants(user_id,role) values('${admin.id}','PLATFORM_ADMIN')`,
  );
  // Course A: quiz-1 authored with 3 attempts (capped at 2, HIGHEST);
  // quiz-2 with 2 attempts scored LATEST.
  await publishCourse("lap-course-a", (pkg) => {
    pkg.curriculum.assessmentTemplates.find(
      (t: { key: string }) => t.key === "quiz-1",
    ).attemptsAllowed = 3;
    pkg.curriculum.assessmentTemplates.find(
      (t: { key: string }) => t.key === "quiz-2",
    ).attemptsAllowed = 2;
    pkg.assessments.find(
      (a: { templateRef: string }) => a.templateRef === "quiz-2",
    ).attemptScoring = "LATEST";
  });
  await publishCourse("lap-course-b");
  orgId = await rpc<string>(q, admin, "create_course_organisation", [
    "lap-northwind",
    "Northwind Learning Partners",
    admin.id,
    reason,
  ]);
  await publishCourse("lap-course-org", () => {}, orgId);
  enrol.aA = await join(learnerA, "lap-course-a");
  enrol.aB = await join(learnerA, "lap-course-b");
  enrol.bA = await join(learnerB, "lap-course-a");
  enrol.cA = await join(learnerC, "lap-course-a");
  enrol.cB = await join(learnerC, "lap-course-b");
  for (const r of [
    await confirm(learnerA, enrol.aA, "09:00"),
    await confirm(learnerB, enrol.bA, "09:00"),
  ])
    if (!r.ok) throw new Error(JSON.stringify(r));
}, 600000);
afterAll(async () => {
  await db?.close();
});

describe("cross-course occupied-interval collisions", () => {
  it("refuses an overlapping preview and confirmation with the conflicting course and times", async () => {
    const preview = academyPlanSchema.parse(
      await rpc(q, learnerA, "preview_my_academy_schedule", [
        enrol.aB,
        "ACCELERATED_2W",
        day(1),
        ALL_DAYS,
        "12:00",
        "Europe/London",
      ]),
    );
    expect(preview).toMatchObject({
      feasible: false,
      code: "SCHEDULE_CONFLICT",
    });
    if (preview.feasible) throw new Error("unreachable");
    expect(preview.conflict).toMatchObject({
      enrolmentId: enrol.aA,
      courseTitle: expect.any(String),
    });
    const other = (
      await q(
        `select i.starts_at, i.ends_at from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
          where s.enrolment_id=$1 and s.superseded_at is null and i.kind=$2 and i.ref=$3 and i.starts_at=$4::timestamptz`,
        [
          enrol.aA,
          preview.conflict!.kind,
          preview.conflict!.ref,
          preview.conflict!.startsAt,
        ],
      )
    ).rows;
    expect(other).toHaveLength(1);
    expect(preview.message).toMatch(/overlaps/);
    const refused = await confirm(learnerA, enrol.aB, "12:00");
    expect(refused).toMatchObject({ ok: false, code: "SCHEDULE_CONFLICT" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_schedules where enrolment_id=$1",
          [enrol.aB],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("ignores the 23h59m availability windows and accepts adjacent occupied intervals", async () => {
    // Course A occupies 09:00-15:00; 16:00-22:00 overlaps only A's
    // availability windows, which never block other activities.
    const ok = await confirm(learnerA, enrol.aB, "16:00");
    expect(ok).toMatchObject({ ok: true, revision: 1 });
    const a = timetableSchema.parse(
      await rpc(q, learnerA, "get_my_academy_timetable", [enrol.aA]),
    );
    const b = timetableSchema.parse(
      await rpc(q, learnerA, "get_my_academy_timetable", [enrol.aB]),
    );
    const overlaps = (
      x: { startsAt: string; endsAt: string },
      y: { startsAt: string; endsAt: string },
    ) =>
      Date.parse(x.startsAt) < Date.parse(y.endsAt) &&
      Date.parse(y.startsAt) < Date.parse(x.endsAt);
    expect(a.items.some((x) => b.items.some((y) => overlaps(x, y)))).toBe(
      false,
    );
    const windowOverlap = a.items.some((x) =>
      b.items.some(
        (y) =>
          Date.parse(x.opensAt!) < Date.parse(y.closesAt!) &&
          Date.parse(y.opensAt!) < Date.parse(x.closesAt!),
      ),
    );
    expect(windowOverlap).toBe(true);
  });

  it("refuses a revision into another course's occupied interval and never rewrites either timetable", async () => {
    const before = (
      await q(
        "select id, revision from public.academy_schedules where enrolment_id = any($1::uuid[]) and superseded_at is null order by enrolment_id",
        [[enrol.aA, enrol.aB]],
      )
    ).rows;
    const preview = academyPlanSchema.parse(
      await rpc(q, learnerA, "preview_my_academy_schedule_revision", [
        enrol.aB,
        day(3),
        ALL_DAYS,
        "08:00",
        "Europe/London",
      ]),
    );
    expect(preview).toMatchObject({
      feasible: false,
      code: "SCHEDULE_CONFLICT",
    });
    expect(
      await rpc(q, learnerA, "revise_my_academy_schedule", [
        enrol.aB,
        1,
        day(3),
        ALL_DAYS,
        "08:00",
        "Europe/London",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "SCHEDULE_CONFLICT" });
    const after = (
      await q(
        "select id, revision from public.academy_schedules where enrolment_id = any($1::uuid[]) and superseded_at is null order by enrolment_id",
        [[enrol.aA, enrol.aB]],
      )
    ).rows;
    expect(after).toEqual(before);
    // A non-overlapping revision is still accepted.
    expect(
      await rpc(q, learnerA, "revise_my_academy_schedule", [
        enrol.aB,
        1,
        day(3),
        ALL_DAYS,
        "15:30",
        "Europe/London",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: true, revision: 2 });
  });

  it("decides collisions on instants across timezones and a daylight-saving change", async () => {
    // Find a day E, within the 180-day start window, on which the London to
    // New York offset changes from 4 to 5 hours (late October / March).
    const offset = (tz: string, at: Date) => {
      const text = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        timeZoneName: "longOffset",
      })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")!.value;
      const m = /GMT([+-])(\d{2}):(\d{2})/.exec(text);
      return m
        ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
        : 0;
    };
    const gap = (iso: string) => {
      const at = new Date(`${iso}T12:00:00Z`);
      return (
        (offset("Europe/London", at) - offset("America/New_York", at)) / 60
      );
    };
    let transition: string | null = null;
    for (let k = 4; k <= 170 && !transition; k++)
      if (gap(day(k - 1)) === 4 && gap(day(k)) === 5) transition = day(k);
    // Course A in London 09:00-15:00; course B in New York 10:30-16:30,
    // i.e. London 14:30 while the gap is 4 hours, 15:30 once it is 5.
    const startA = transition
      ? new Date(Date.parse(`${transition}T00:00:00Z`) - 3 * 86400000)
          .toISOString()
          .slice(0, 10)
      : day(1);
    const free = (
      await rpc<{ ok: boolean }>(q, learnerC, "confirm_my_academy_schedule", [
        enrol.cA,
        "ACCELERATED_2W",
        startA,
        ALL_DAYS,
        "09:00",
        "Europe/London",
        randomUUID(),
      ])
    ).ok;
    expect(free).toBe(true);
    const aItems = timetableSchema.parse(
      await rpc(q, learnerC, "get_my_academy_timetable", [enrol.cA]),
    ).items;
    const preview = (startOn: string) =>
      rpc(q, learnerC, "preview_my_academy_schedule", [
        enrol.cB,
        "ACCELERATED_2W",
        startOn,
        ALL_DAYS,
        "10:30",
        "America/New_York",
      ]).then((r) => academyPlanSchema.parse(r));
    const candidates = transition ? [startA, transition] : [startA];
    for (const startOn of candidates) {
      // Ground truth from instants: preview B's items with A's timetable
      // removed from consideration is not possible, so compute B's own
      // instants from its local wall clock in New York.
      const result = await preview(startOn);
      if (result.feasible) {
        const overlap = result.items.some((b) =>
          aItems.some(
            (a) =>
              Date.parse(a.startsAt) < Date.parse(b.endsAt) &&
              Date.parse(b.startsAt) < Date.parse(a.endsAt),
          ),
        );
        expect(overlap).toBe(false);
      } else {
        expect(result.code).toBe("SCHEDULE_CONFLICT");
        const c = result.conflict!;
        expect(Date.parse(c.itemStartsAt!)).toBeLessThan(Date.parse(c.endsAt));
        expect(Date.parse(c.startsAt)).toBeLessThan(Date.parse(c.itemEndsAt!));
      }
    }
    if (transition) {
      // Before the US change the 4-hour gap makes B overlap A; from the
      // change the 5-hour gap separates them.
      expect(await preview(startA)).toMatchObject({
        feasible: false,
        code: "SCHEDULE_CONFLICT",
      });
      expect(await preview(transition)).toMatchObject({ feasible: true });
    } else {
      console.warn(
        "No London/New York 4h->5h offset change within the start window today; only the instant-based property was asserted.",
      );
    }
  });
});

describe("attempt policy", () => {
  it("caps attempts at two, resumes the same attempt and saved answers, and never returns a score on submission", async () => {
    await moveItems(enrol.aA, "ASSESSMENT", "quiz-1", "-1 hour");
    const first = await start(learnerA, enrol.aA, "quiz-1");
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.resumed).toBe(false);
    await answer(learnerA, first.attemptId, "quiz-1", 3);
    const again = await start(learnerA, enrol.aA, "quiz-1");
    expect(again).toMatchObject({
      ok: true,
      attemptId: first.attemptId,
      resumed: true,
      expiresAt: first.ok ? first.expiresAt : undefined,
    });
    const active = attemptSchema.parse(
      await rpc(q, learnerA, "get_my_academy_attempt", [first.attemptId]),
    );
    if (active.state !== "ACTIVE") throw new Error("expected ACTIVE");
    expect(active.attemptsAllowed).toBe(2);
    expect(active.expiresAt).toBe(first.expiresAt);
    expect(Date.parse(active.expiresAt) - Date.parse(active.startedAt)).toBe(
      25 * 60000,
    );
    // The resumed attempt keeps exactly the saved answers.
    expect(active.questions.map((x) => x.response !== null)).toEqual(
      active.questions.map((_, i) => i < 3),
    );
    expect(JSON.stringify(active)).not.toMatch(PROTECTED);
    const submitted = await rpc(q, learnerA, "submit_my_academy_attempt", [
      first.attemptId,
    ]);
    expect(submitted).toEqual({
      ok: true,
      state: "SUBMITTED",
      submission: "STUDENT_SUBMIT",
    });
    // Retake inside the window, then the cap.
    const second = await sit(learnerA, enrol.aA, "quiz-1", 999);
    expect(second.marks).toBe(maxMarks("quiz-1"));
    expect(
      (
        await q(
          "select attempt_number from public.academy_assessment_attempts where id=$1",
          [second.attemptId],
        )
      ).rows[0].attempt_number,
    ).toBe(2);
    expect(await start(learnerA, enrol.aA, "quiz-1")).toMatchObject({
      ok: false,
      code: "NO_ATTEMPTS_REMAINING",
    });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-1'",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("withholds every result, mark, answer, outcome and completion before release", async () => {
    const attempts = (
      await q(
        "select id from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-1' order by attempt_number",
        [enrol.aA],
      )
    ).rows.map((r) => r.id as string);
    for (const id of attempts) {
      const view = attemptSchema.parse(
        await rpc(q, learnerA, "get_my_academy_attempt", [id]),
      );
      expect(view).toMatchObject({
        state: "SUBMITTED",
        released: false,
        releasedAt: null,
      });
      expect(JSON.stringify(view)).not.toMatch(PROTECTED);
    }
    const results = resultsSchema.parse(
      await rpc(q, learnerA, "get_my_academy_results", [enrol.aA]),
    );
    expect(results).toMatchObject({
      outcome: "IN_PROGRESS",
      courseScoreBp: null,
      status: "ACTIVE",
      completion: null,
    });
    for (const c of results.components.filter((x) => x.source === "ASSESSMENT"))
      expect(c).toMatchObject({
        status: "PENDING",
        scoreBp: null,
        released: false,
        bestScore: null,
        maxScore: null,
        attemptsUsed: null,
      });
    const progress = await rpc<{
      objectives: { state: string; evidence: number }[];
    }>(q, learnerA, "get_my_academy_progress", [enrol.aA]);
    expect(
      progress.objectives.every(
        (o) => o.state === "NOT_STARTED" && o.evidence === 0,
      ),
    ).toBe(true);
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_objective_evidence where enrolment_id=$1",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(0);
    const enrolments = myAcademyEnrolmentsSchema.parse(
      await rpc(q, learnerA, "list_my_academy_enrolments"),
    );
    expect(enrolments.find((e) => e.enrolmentId === enrol.aA)!.status).toBe(
      "ACTIVE",
    );
    const timetable = await rpc(q, learnerA, "get_my_academy_timetable", [
      enrol.aA,
    ]);
    expect(JSON.stringify(timetable)).not.toMatch(PROTECTED);
    const workspace = await rpc<{
      assessment: { ref: string; state: string };
      results: unknown[];
    }>(q, learnerA, "get_my_academy_course_workspace", [enrol.aA]);
    expect(workspace.results).toEqual([]);
    expect(workspace.assessment).toMatchObject({
      ref: "quiz-1",
      state: "SUBMITTED",
      canStart: false,
      reason: "NO_ATTEMPTS_REMAINING",
    });
    expect(JSON.stringify(workspace)).not.toMatch(PROTECTED);
    expect(
      await rpc(q, learnerA, "list_my_academy_released_results", [enrol.aA]),
    ).toEqual([]);
    expect(
      await rpc(q, learnerA, "refresh_my_academy_releases", [enrol.aA]),
    ).toMatchObject({ ok: true, released: [] });
  });

  it("shortens a late start to the window close and refuses starts once it has closed", async () => {
    await sittingClosesIn(q, enrol.aA, "quiz-2", "10 minutes");
    const late = await start(learnerA, enrol.aA, "quiz-2");
    if (!late.ok) throw new Error(JSON.stringify(late));
    const row = (
      await q(
        "select started_at, expires_at from public.academy_assessment_attempts where id=$1",
        [late.attemptId],
      )
    ).rows[0] as { started_at: Date; expires_at: Date };
    const closes = (
      await q(
        `select w.closes_at from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) w
          join public.academy_schedules s on s.id=i.schedule_id
          where s.enrolment_id=$1 and s.superseded_at is null and i.kind='ASSESSMENT' and i.ref='quiz-2'`,
        [enrol.aA],
      )
    ).rows[0].closes_at as Date;
    expect(new Date(row.expires_at).getTime()).toBe(new Date(closes).getTime());
    expect(
      new Date(row.expires_at).getTime() - new Date(row.started_at).getTime(),
    ).toBeLessThan(25 * 60000);
    expect(late.expiresAt && Date.parse(late.expiresAt)).toBe(
      new Date(closes).getTime(),
    );
    await answer(learnerA, late.attemptId, "quiz-2", 2);
    await rpc(q, learnerA, "submit_my_academy_attempt", [late.attemptId]);
    // LATEST scoring: the second attempt (fewer correct) is the one counted.
    await sittingClosesIn(q, enrol.aA, "quiz-2", "3 hours");
    const second = await sit(learnerA, enrol.aA, "quiz-2", 1);
    expect(second.marks).toBeGreaterThan(0);
    await closeSittingNow(q, enrol.aA, "quiz-2");
    expect(await start(learnerA, enrol.aA, "quiz-2")).toMatchObject({
      ok: false,
      code: "SITTING_CLOSED",
    });
  });

  it("refuses an attempt whose sitting would overlap another course's session", async () => {
    await moveItems(enrol.aA, "ASSESSMENT", "quiz-3", "-1 hour");
    await moveItems(enrol.aB, "LESSON", "lesson-1-1", "5 minutes");
    const refused = await start(learnerA, enrol.aA, "quiz-3");
    expect(refused).toMatchObject({ ok: false, code: "SCHEDULE_CONFLICT" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.conflict).toMatchObject({
      enrolmentId: enrol.aB,
      kind: "LESSON",
      ref: "lesson-1-1",
    });
    const ws = await rpc<{ assessment: { canStart: boolean; reason: string } }>(
      q,
      learnerA,
      "get_my_academy_course_workspace",
      [enrol.aA],
    );
    expect(ws.assessment).toMatchObject({
      canStart: false,
      reason: "SCHEDULE_CONFLICT",
    });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-3'",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(0);
    // Once the other session is clear of [now, expires_at), it starts.
    await moveItems(enrol.aB, "LESSON", "lesson-1-1", "2 hours");
    const ok = await start(learnerA, enrol.aA, "quiz-3");
    expect(ok.ok).toBe(true);
    if (ok.ok)
      await rpc(q, learnerA, "submit_my_academy_attempt", [ok.attemptId]);
  });
});

describe("release after the deadline", () => {
  it("reveals the best score, correct answers and marking-guidance explanations once the window closes", async () => {
    await closeSittingNow(q, enrol.aA, "quiz-1");
    const refreshed = await rpc<{ released: string[] }>(
      q,
      learnerA,
      "refresh_my_academy_releases",
      [enrol.aA],
    );
    expect(refreshed.released).toEqual(
      expect.arrayContaining(["quiz-1", "quiz-2"]),
    );
    const attempts = (
      await q(
        "select id, score, max_score from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-1' order by attempt_number",
        [enrol.aA],
      )
    ).rows as { id: string; score: number; max_score: number }[];
    const first = attemptSchema.parse(
      await rpc(q, learnerA, "get_my_academy_attempt", [attempts[0].id]),
    );
    if (first.state !== "SUBMITTED") throw new Error("expected SUBMITTED");
    expect(first).toMatchObject({
      released: true,
      score: attempts[0].score,
      maxScore: maxMarks("quiz-1"),
      reviewAvailable: true,
    });
    expect(first.releasedAt).toBeTruthy();
    const questions = template("quiz-1").questions;
    expect(first.review).toHaveLength(questions.length);
    for (const [i, r] of first.review!.entries()) {
      const source = questions.find(
        (x: { position: number }) => x.position === r.position,
      );
      expect(r.correctAnswer).toEqual(source.answerKey);
      expect(r.explanation).toBe(source.markingGuidance);
      expect(r.expectedAnswer).toBe(source.expectedAnswer);
      expect(r.marks).toBe(i < 3 ? source.maxMarks : 0);
      expect(r.response === null).toBe(i >= 3);
    }
    const results = resultsSchema.parse(
      await rpc(q, learnerA, "get_my_academy_results", [enrol.aA]),
    );
    const quiz1 = results.components.find((c) => c.assessmentRef === "quiz-1")!;
    // HIGHEST: the full-marks retake.
    expect(quiz1).toMatchObject({
      released: true,
      status: "GRADED",
      bestScore: maxMarks("quiz-1"),
      maxScore: maxMarks("quiz-1"),
      attemptsUsed: 2,
      scoreBp: 10000,
    });
    const quiz2 = results.components.find((c) => c.assessmentRef === "quiz-2")!;
    const latest = (
      await q(
        "select score from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-2' order by attempt_number desc limit 1",
        [enrol.aA],
      )
    ).rows[0].score;
    // LATEST: the worse second attempt counts.
    expect(quiz2).toMatchObject({
      released: true,
      bestScore: latest,
      attemptsUsed: 2,
    });
    expect(results.outcome).toBe("IN_PROGRESS");
    expect(results.courseScoreBp).toBeNull();
    const released = await rpc<{ assessmentRef: string; bestScore: number }[]>(
      q,
      learnerA,
      "list_my_academy_released_results",
      [enrol.aA],
    );
    expect(released.map((r) => r.assessmentRef).sort()).toEqual([
      "quiz-1",
      "quiz-2",
    ]);
    // Evidence is written once, at release processing, per submitted attempt.
    const evidence = (
      await q(
        `select count(*)::int n, count(distinct source_id)::int attempts from public.academy_objective_evidence
          where enrolment_id=$1 and source_kind='ASSESSMENT_ATTEMPT'`,
        [enrol.aA],
      )
    ).rows[0];
    expect(evidence.attempts).toBe(4);
    await rpc(q, learnerA, "refresh_my_academy_releases", [enrol.aA]);
    await rpc(q, learnerA, "get_my_academy_attempt", [attempts[0].id]);
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_objective_evidence where enrolment_id=$1",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(evidence.n);
    expect(
      (
        await q(
          "select count(*)::int n from public.audit_events where action='ACADEMY_ASSESSMENT_RELEASED' and target_id=$1",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(2);
    // Another learner can never read or refresh this enrolment.
    await expect(
      rpc(q, learnerB, "refresh_my_academy_releases", [enrol.aA]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, learnerB, "get_my_academy_attempt", [attempts[0].id]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
  });

  it("withholds the answer review while any controlled sitting is active", async () => {
    await moveItems(enrol.aA, "ASSESSMENT", "quiz-4", "-1 hour");
    const s = await start(learnerA, enrol.aA, "quiz-4");
    if (!s.ok) throw new Error(JSON.stringify(s));
    const quiz1 = (
      await q(
        "select id from public.academy_assessment_attempts where enrolment_id=$1 and assessment_ref='quiz-1' order by attempt_number limit 1",
        [enrol.aA],
      )
    ).rows[0].id;
    const view = attemptSchema.parse(
      await rpc(q, learnerA, "get_my_academy_attempt", [quiz1]),
    );
    expect(view).toMatchObject({ released: true, reviewAvailable: false });
    expect(view).not.toHaveProperty("review");
    await answer(learnerA, s.attemptId, "quiz-4", 10);
    await rpc(q, learnerA, "submit_my_academy_attempt", [s.attemptId]);
  });

  it("defers completion to release, and resolves NOT_PASSED deterministically when attempts were unused", async () => {
    await completeLabs(q, learnerB, enrol.bA, 10);
    for (const ref of [
      "quiz-1",
      "quiz-2",
      "midterm",
      "quiz-3",
      "quiz-4",
      "final",
    ]) {
      await moveItems(enrol.bA, "ASSESSMENT", ref, "-1 hour");
      await sit(learnerB, enrol.bA, ref, 999);
    }
    let results = resultsSchema.parse(
      await rpc(q, learnerB, "get_my_academy_results", [enrol.bA]),
    );
    expect(results).toMatchObject({
      outcome: "IN_PROGRESS",
      courseScoreBp: null,
      status: "ACTIVE",
      completion: null,
    });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_completions where enrolment_id=$1",
          [enrol.bA],
        )
      ).rows[0].n,
    ).toBe(0);
    for (const ref of [
      "quiz-1",
      "quiz-2",
      "midterm",
      "quiz-3",
      "quiz-4",
      "final",
    ])
      await closeSittingNow(q, enrol.bA, ref);
    // Stable reads already show the released results; the official record
    // is written by the volatile release processing.
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_completions where enrolment_id=$1",
          [enrol.bA],
        )
      ).rows[0].n,
    ).toBe(0);
    await rpc(q, learnerB, "refresh_my_academy_releases", [enrol.bA]);
    results = resultsSchema.parse(
      await rpc(q, learnerB, "get_my_academy_results", [enrol.bA]),
    );
    expect(results).toMatchObject({
      outcome: "PASSED",
      courseScoreBp: 10000,
      status: "COMPLETED",
    });
    expect(results.completion).toMatchObject({ courseScoreBp: 10000 });
    const progression = await rpc<{
      assessments: { total: number; released: number };
      completion: { completed: boolean };
    }>(q, learnerB, "get_my_academy_progression", [enrol.bA]);
    expect(progression).toMatchObject({
      assessments: { total: 6, released: 6 },
      completion: { completed: true },
    });
    const courses = await rpc<{ enrolmentId: string; status: string }[]>(
      q,
      learnerB,
      "list_my_academy_courses",
    );
    expect(courses.find((c) => c.enrolmentId === enrol.bA)!.status).toBe(
      "COMPLETED",
    );

    // learnerC sat nothing: once every window has closed the course is
    // deterministically NOT_PASSED (released with 0), never left pending.
    await completeLabs(q, learnerC, enrol.cA, 0);
    for (const ref of [
      "quiz-1",
      "quiz-2",
      "midterm",
      "quiz-3",
      "quiz-4",
      "final",
    ])
      await closeSittingNow(q, enrol.cA, ref);
    await rpc(q, learnerC, "refresh_my_academy_releases", [enrol.cA]);
    const notPassed = resultsSchema.parse(
      await rpc(q, learnerC, "get_my_academy_results", [enrol.cA]),
    );
    expect(notPassed).toMatchObject({
      outcome: "NOT_PASSED",
      courseScoreBp: 0,
      status: "ACTIVE",
      completion: null,
    });
    for (const c of notPassed.components.filter(
      (x) => x.source === "ASSESSMENT",
    ))
      expect(c).toMatchObject({
        released: true,
        attemptsUsed: 0,
        bestScore: 0,
        scoreBp: 0,
      });
    const week = await rpc<{
      activities: { kind: string; state: string; enrolmentId: string }[];
    }>(q, learnerC, "list_my_academy_week", [null]);
    expect(
      week.activities
        .filter((a) => a.kind === "ASSESSMENT" && a.enrolmentId === enrol.cA)
        .every((a) => a.state === "MISSED"),
    ).toBe(true);
  });
});

describe("attendance, class evidence and missed classes", () => {
  it("checks in only inside the window, idempotently, and never as completion or mastery", async () => {
    const lesson = await item(enrol.aA, "LESSON", "lesson-1-1");
    const early = await rpc(q, learnerA, "check_in_my_academy_class", [
      enrol.aA,
      lesson.id,
    ]);
    expect(early).toMatchObject({ ok: false, code: "NOT_YET_STARTED" });
    await moveItems(enrol.aA, "LESSON", "lesson-1-1", "-1 hour");
    const first = await rpc<{
      ok: boolean;
      checkedInAt: string;
      replayed: boolean;
    }>(q, learnerA, "check_in_my_academy_class", [enrol.aA, lesson.id]);
    expect(first).toMatchObject({ ok: true, replayed: false });
    const again = await rpc(q, learnerA, "check_in_my_academy_class", [
      enrol.aA,
      lesson.id,
    ]);
    expect(again).toEqual({
      ok: true,
      replayed: true,
      checkedInAt: first.checkedInAt,
    });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_class_attendance where enrolment_id=$1",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await rpc(q, learnerB, "check_in_my_academy_class", [
        enrol.aA,
        lesson.id,
      ]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const quiz = await item(enrol.aA, "ASSESSMENT", "quiz-1");
    expect(
      await rpc(q, learnerA, "check_in_my_academy_class", [enrol.aA, quiz.id]),
    ).toMatchObject({ ok: false, code: "NOT_A_CLASS" });
    await moveItems(enrol.aA, "LESSON", "lesson-1-2", "-26 hours");
    const closed = await item(enrol.aA, "LESSON", "lesson-1-2");
    expect(
      await rpc(q, learnerA, "check_in_my_academy_class", [
        enrol.aA,
        closed.id,
      ]),
    ).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_lesson_progress where enrolment_id=$1",
          [enrol.aA],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      q("delete from public.academy_class_attendance where enrolment_id=$1", [
        enrol.aA,
      ]),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("detects a missed class and gives the next class its objectives as a recap, without completing it", async () => {
    await moveItems(enrol.aA, "LESSON", "lesson-1-1", "-50 hours");
    await moveItems(enrol.aA, "LESSON", "lesson-1-3", "-1 hour");
    const next = await item(enrol.aA, "LESSON", "lesson-1-3");
    const opened = await rpc<{ ok: boolean; classroomId: string }>(
      q,
      learnerA,
      "open_my_academy_professor_classroom",
      [enrol.aA, next.id],
    );
    expect(opened.ok).toBe(true);
    const recap = await rpc<{
      ok: boolean;
      missedLessons: { lessonRef: string; objectives: string[] }[];
    }>(q, learnerA, "get_my_academy_class_recap", [opened.classroomId]);
    expect(recap.ok).toBe(true);
    expect(recap.missedLessons.map((l) => l.lessonRef)).toEqual(["lesson-1-2"]);
    const objectives = (
      await q(
        `select o.description from public.lesson_objectives o join public.academy_course_lessons cl on cl.lesson_id=o.lesson_id
          where cl.course_id=$1 and cl.lesson_ref='lesson-1-2' order by o.position`,
        [courses["lap-course-a"].courseId],
      )
    ).rows.map((r) => r.description);
    expect(recap.missedLessons[0].objectives).toEqual(objectives);
    expect(
      await rpc(q, learnerB, "get_my_academy_class_recap", [
        opened.classroomId,
      ]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const states = Object.fromEntries(
      (
        await Promise.all(
          ["lesson-1-1", "lesson-1-2", "lesson-1-3"].map(async (ref) => [
            ref,
            (
              await q(
                `select academy_private.activity_state(i, w.opens_at, w.closes_at, clock_timestamp()) s
                  from public.academy_schedule_items i cross join lateral academy_private.item_window(i.id) w where i.id=$1`,
                [(await item(enrol.aA, "LESSON", ref)).id],
              )
            ).rows[0].s,
          ]),
        )
      ).map((x) => x as [string, string]),
    );
    expect(states).toEqual({
      "lesson-1-1": "ATTENDED",
      "lesson-1-2": "MISSED",
      "lesson-1-3": "OPEN",
    });
    const progression = await rpc<{
      classes: { attended: number; missed: number };
    }>(q, learnerA, "get_my_academy_progression", [enrol.aA]);
    expect(progression.classes.attended).toBe(1);
    expect(progression.classes.missed).toBeGreaterThanOrEqual(1);
    const workspace = await rpc<{
      currentClass: {
        ref: string;
        state: string;
        classroomId: string;
        evidence: { checkedInAt: string | null; lessonObjectives: unknown[] };
      };
    }>(q, learnerA, "get_my_academy_course_workspace", [enrol.aA]);
    expect(workspace.currentClass).toMatchObject({
      ref: "lesson-1-3",
      state: "OPEN",
      classroomId: opened.classroomId,
      evidence: { checkedInAt: null, correctInClassAnswers: 0 },
    });
  });
});

describe("monthly assessment leaderboards", () => {
  const month = new Date().toISOString().slice(0, 7);
  const previous = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const scores: Record<string, number> = {};

  beforeAll(async () => {
    for (const [i, p] of extra.entries()) {
      enrol[`x${i}`] = await join(p, "lap-course-a");
      const r = await confirm(p, enrol[`x${i}`], "09:00");
      if (!r.ok) throw new Error(JSON.stringify(r));
      await moveItems(enrol[`x${i}`], "ASSESSMENT", "quiz-4", "-1 hour");
      // x0 and x1 tie; x0 started earlier.
      const correct = i <= 1 ? 8 : 2 + i;
      scores[`x${i}`] = (await sit(p, enrol[`x${i}`], "quiz-4", correct)).marks;
    }
    await q(
      "alter table public.academy_assessment_attempts disable trigger guard_history",
    );
    try {
      const at = (n: number) =>
        `date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' + interval '${n} minutes'`;
      await q(
        `update public.academy_assessment_attempts set started_at = ${at(10)} where enrolment_id=$1 and assessment_ref='quiz-4'`,
        [enrol.x0],
      );
      await q(
        `update public.academy_assessment_attempts set started_at = ${at(20)} where enrolment_id=$1 and assessment_ref='quiz-4'`,
        [enrol.x1],
      );
      // x2's first attempt began last month.
      await q(
        `update public.academy_assessment_attempts set started_at = date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - interval '3 days'
          where enrolment_id=$1 and assessment_ref='quiz-4'`,
        [enrol.x2],
      );
    } finally {
      await q(
        "alter table public.academy_assessment_attempts enable trigger guard_history",
      );
    }
    for (const [i] of extra.entries())
      if (i !== 3) await closeSittingNow(q, enrol[`x${i}`], "quiz-4");
    await closeSittingNow(q, enrol.aA, "quiz-4");
    await closeSittingNow(q, enrol.bA, "quiz-4");
    // Course isolation: learnerA's quiz-4 in course B (course A's open
    // class is moved out of the sitting first: it would be a collision).
    await moveItems(enrol.aA, "LESSON", "lesson-1-3", "-3 hours");
    await moveItems(enrol.aB, "ASSESSMENT", "quiz-4", "-1 hour");
    await sit(learnerA, enrol.aB, "quiz-4", 20);
    await closeSittingNow(q, enrol.aB, "quiz-4");
  }, 600000);

  type Board = {
    ok: boolean;
    month: string;
    entries: {
      rank: number;
      label: string;
      bestScore: number;
      maxScore: number;
      isMe: boolean;
    }[];
  };
  const board = (p: Person, e: string, m: string, ref = "quiz-4") =>
    rpc<Board>(q, p, "get_my_academy_assessment_leaderboard", [
      e,
      ref,
      `${m}-01`,
    ]);

  it("ranks released best scores of first attempts in the UTC month: top 10, ties by earlier first attempt, pseudonymous", async () => {
    const mine = await board(learnerA, enrol.aA, month);
    expect(mine.ok).toBe(true);
    expect(mine.month).toBe(month);
    expect(mine.entries).toHaveLength(10);
    const scoresDesc = mine.entries.map((e) => e.bestScore);
    expect([...scoresDesc].sort((a, b) => b - a)).toEqual(scoresDesc);
    expect(mine.entries.map((e) => e.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(mine.entries.every((e) => e.maxScore === maxMarks("quiz-4"))).toBe(
      true,
    );
    const me = mine.entries.filter((e) => e.isMe);
    expect(me).toHaveLength(1);
    expect(me[0].label).toBe("You");
    const others = mine.entries.filter((e) => !e.isMe).map((e) => e.label);
    expect(others.every((l) => /^Learner [0-9A-F]{6}$/.test(l))).toBe(true);
    expect(new Set(others).size).toBe(others.length);
    expect(JSON.stringify(mine)).not.toMatch(
      /learner-|example\.com|10000000-|enrolment/i,
    );
    // Stable pseudonyms; another viewer sees the caller's own row as You.
    const again = await board(learnerA, enrol.aA, month);
    expect(again.entries.map((e) => e.label)).toEqual(
      mine.entries.map((e) => e.label),
    );
    const theirs = await board(extra[0], enrol.x0, month);
    const meThere = theirs.entries.find((e) => e.isMe)!;
    expect(meThere.label).toBe("You");
    expect(meThere.bestScore).toBe(scores.x0);
    // Tie: x0 (earlier first attempt) ranks above x1.
    const x1 = (await board(extra[1], enrol.x1, month)).entries.find(
      (e) => e.isMe,
    )!;
    expect(scores.x0).toBe(scores.x1);
    expect(x1.rank).toBe(meThere.rank + 1);
    // x2 belongs to last month's board; x3 is not released.
    expect(
      (await board(extra[2], enrol.x2, month)).entries.some((e) => e.isMe),
    ).toBe(false);
    const last = await board(extra[2], enrol.x2, previous);
    expect(last.entries).toHaveLength(1);
    expect(last.entries[0]).toMatchObject({ isMe: true, label: "You" });
    const x3 = await board(extra[3], enrol.x3, month);
    expect(x3.entries.some((e) => e.isMe)).toBe(false);
    // Released total in the month is 11 (9 extra + learnerA + learnerB):
    // only the top 10 are listed, so the lowest released score is cut.
    const released = (
      await q(
        `select count(*)::int n from public.academy_assessment_attempts t join public.academy_enrolments e on e.id=t.enrolment_id
          where e.course_id=$1 and t.assessment_ref='quiz-4' and t.attempt_number=1
            and t.started_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
            and academy_private.assessment_released(e.id, 'quiz-4')`,
        [courses["lap-course-a"].courseId],
      )
    ).rows[0].n;
    expect(released).toBe(11);
  });

  it("isolates courses, requires the caller's own enrolment and lists only released boards", async () => {
    const b = await board(learnerA, enrol.aB, month);
    expect(b.entries).toEqual([
      expect.objectContaining({ isMe: true, label: "You", rank: 1 }),
    ]);
    await expect(board(learnerB, enrol.aA, month)).rejects.toThrow(
      /NOT_FOUND_OR_FORBIDDEN/,
    );
    expect(
      await rpc(q, learnerA, "get_my_academy_assessment_leaderboard", [
        enrol.aA,
        "not-an-assessment",
        `${month}-01`,
      ]),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const boards = await rpc<
      { enrolmentId: string; assessmentRef: string; month: string }[]
    >(q, learnerA, "list_my_academy_leaderboards");
    const keys = boards.map(
      (x) => `${x.enrolmentId}:${x.assessmentRef}:${x.month}`,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        `${enrol.aA}:quiz-4:${month}`,
        `${enrol.aA}:quiz-4:${previous}`,
        `${enrol.aB}:quiz-4:${month}`,
        `${enrol.aA}:quiz-1:${month}`,
      ]),
    );
    // quiz-3: learnerB's sitting is released, learnerA's window is still
    // open, so learnerA's own submitted attempt is not on the board.
    const quiz3 = await board(learnerA, enrol.aA, month, "quiz-3");
    expect(quiz3.entries.length).toBeGreaterThan(0);
    expect(quiz3.entries.some((e) => e.isMe)).toBe(false);
    expect(
      (await board(learnerA, enrol.aA, month, "quiz-1")).entries[0],
    ).toMatchObject({ isMe: true, bestScore: maxMarks("quiz-1") });
  });
});

describe("provider attribution and learner projections", () => {
  it("names the course organisation as provider, Ducelio for historical courses", async () => {
    const legacy = await publishAcademyCourse(
      q,
      "lap-legacy-course",
      approvedTestPackage("lap-legacy-package"),
    );
    await rpc(q, admin, "grant_academy_entitlement", [
      legacy.offerId,
      learnerA.email,
      null,
      reason,
    ]);
    const orgEnrolment = await join(learnerA, "lap-course-org");
    const enrolments = myAcademyEnrolmentsSchema.parse(
      await rpc(q, learnerA, "list_my_academy_enrolments"),
    );
    const byCourse = Object.fromEntries(
      enrolments.map((e) => [e.courseId, e.organisationName]),
    );
    expect(byCourse[courses["lap-course-org"].courseId]).toBe(
      "Northwind Learning Partners",
    );
    expect(byCourse[courses["lap-course-a"].courseId]).toBe("Ducelio");
    expect(byCourse[legacy.courseId]).toBe("Ducelio");
    const list = await rpc<{ enrolmentId: string; provider: string }[]>(
      q,
      learnerA,
      "list_my_academy_courses",
    );
    expect(list.find((c) => c.enrolmentId === orgEnrolment)!.provider).toBe(
      "Northwind Learning Partners",
    );
    expect(list).toHaveLength(4);
  });

  it("returns every activity of the learner's week across courses, with server-derived states", async () => {
    const week = await rpc<{
      weekStart: string;
      timezone: string;
      activities: {
        itemId: string;
        enrolmentId: string;
        startsAt: string;
        state: string;
        provider: string;
      }[];
    }>(q, learnerA, "list_my_academy_week", [day(8)]);
    expect(new Date(`${week.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(week.timezone).toBe("Europe/London");
    const expected = (
      await q(
        `select count(*)::int n from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id and s.superseded_at is null
          join public.academy_enrolments e on e.id=s.enrolment_id and e.learner_id=$1
          where i.starts_at >= ($2::date + time '00:00') at time zone 'Europe/London'
            and i.starts_at < ($2::date + 7 + time '00:00') at time zone 'Europe/London'`,
        [learnerA.id, week.weekStart],
      )
    ).rows[0].n;
    expect(week.activities).toHaveLength(expected);
    expect(expected).toBeGreaterThan(20);
    expect(new Set(week.activities.map((a) => a.enrolmentId))).toEqual(
      new Set([enrol.aA, enrol.aB]),
    );
    expect(week.activities.every((a) => a.state === "UPCOMING")).toBe(true);
    const evidence = await rpc<{ evidence: Record<string, unknown> }>(
      q,
      learnerA,
      "list_my_academy_class_evidence",
      [null, day(8)],
    );
    const lessons = week.activities.filter(
      (a) => (a as unknown as { kind: string }).kind === "LESSON",
    );
    expect(Object.keys(evidence.evidence).sort()).toEqual(
      lessons.map((l) => l.itemId).sort(),
    );
    const next = await rpc<{ state: string } | null>(
      q,
      learnerA,
      "get_my_academy_next_activity",
    );
    expect(["OPEN", "UPCOMING"]).toContain(next!.state);
    await expect(
      rpc(q, null, "list_my_academy_week", [null]),
    ).rejects.toThrow();
  });

  it("keeps every new learner RPC authenticated-only and every new table closed", async () => {
    const fns = [
      "refresh_my_academy_releases(uuid)",
      "check_in_my_academy_class(uuid,uuid)",
      "record_my_academy_class_evidence(uuid,uuid,uuid,uuid[],uuid,boolean,bigint,bigint,text)",
      "get_my_academy_class_recap(uuid)",
      "list_my_academy_courses()",
      "list_my_academy_week(date)",
      "get_my_academy_next_activity()",
      "list_my_academy_class_evidence(uuid,date)",
      "list_my_academy_released_results(uuid)",
      "get_my_academy_progression(uuid)",
      "get_my_academy_course_workspace(uuid)",
      "get_my_academy_assessment_leaderboard(uuid,text,date)",
      "list_my_academy_leaderboards()",
    ];
    for (const f of fns) {
      const r = (
        await q(
          `select has_function_privilege('anon', $1, 'EXECUTE') anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') auth,
                  has_function_privilege('service_role', $1, 'EXECUTE') svc,
                  (select prosecdef from pg_proc where oid = $1::regprocedure) definer,
                  (select proconfig from pg_proc where oid = $1::regprocedure) config`,
          [`public.${f}`],
        )
      ).rows[0];
      expect(r).toMatchObject({
        anon: false,
        auth: true,
        svc: false,
        definer: true,
      });
      expect(r.config).toEqual(['search_path=""']);
    }
    for (const t of [
      "academy_assessment_releases",
      "academy_class_attendance",
      "academy_class_evidence_records",
      "academy_class_checks",
      "academy_class_covered_objectives",
    ])
      for (const role of ["anon", "authenticated", "service_role"])
        expect(
          (
            await q(
              "select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') p",
              [role, `public.${t}`],
            )
          ).rows[0].p,
        ).toBe(false);
  });
});
