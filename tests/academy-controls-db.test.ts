import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asPolicyUser,
  buildAssessmentPolicyFixture,
  learner as institutionalLearner,
} from "./commercial-v1-assessment-policy-fixture";
import {
  approvedTestPackage,
  openSittingNow,
  people,
  publishAcademyCourse,
  releaseNow,
  responseBody,
  rpc,
  seedPeople,
  completeLabs,
  type Person,
  type Query,
} from "./academy-fixture";

// Migration 061 academic controls, adversarially, against a REAL
// institutional Commercial V1 assessment and an Academy enrolment held by
// the SAME learner (PGlite). The real-PostgreSQL race versions are in
// tests/academy-pg-concurrency.test.ts.
let db: PGlite;
let q: Query;
let enrolment: string;
let quiz1Institutional: string;
const learner: Person = {
  id: institutionalLearner,
  auth: "84000000-0000-4000-8000-000000000001",
  email: "policy1@test.example",
  role: "STUDENT",
};
const template = (ref: string) =>
  approvedTestPackage().curriculum.assessmentTemplates.find(
    (t: { key: string }) => t.key === ref,
  );
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);

async function institutional<T>(sql: string, params: unknown[] = []) {
  await asPolicyUser(db, 1);
  try {
    return (await db.query<{ v: T }>(sql, params)).rows[0]?.v;
  } finally {
    await db.exec("reset role");
  }
}
const activity = () =>
  rpc<string>(q, learner, "current_academic_activity_state");

beforeAll(async () => {
  const fixture = await buildAssessmentPolicyFixture({ withLabs: true });
  db = fixture.db;
  quiz1Institutional = fixture.assessmentIds.QUIZ_1;
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  const course = await publishAcademyCourse(
    q,
    "academy-controls-test",
    approvedTestPackage(),
  );
  enrolment = await rpc<string>(q, people.admin, "grant_academy_entitlement", [
    course.offerId,
    learner.email,
    null,
    "Controls acceptance access",
  ]);
  const confirmed = await rpc<{ ok: boolean }>(
    q,
    learner,
    "confirm_my_academy_schedule",
    [
      enrolment,
      "STANDARD_6W",
      addDays(today(), 2),
      [1, 3, 5, 6],
      "19:00",
      "Europe/London",
      randomUUID(),
    ],
  );
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  for (const ref of ["quiz-1", "quiz-2"])
    await openSittingNow(q, enrolment, ref);
}, 240000);
afterAll(async () => {
  await db?.close();
});

describe("one controlled assessment at a time across both exam systems", () => {
  it("an active institutional attempt blocks every Academy sitting", async () => {
    const attempt = await institutional<string>(
      "select public.start_assessment_attempt($1) as v",
      [quiz1Institutional],
    );
    expect(attempt).toBeTruthy();
    expect(await activity()).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    expect(
      await rpc(q, learner, "start_my_academy_assessment", [
        enrolment,
        "quiz-1",
      ]),
    ).toMatchObject({ ok: false, code: "ANOTHER_ASSESSMENT_ACTIVE" });
    expect(
      (
        await q(
          "select count(*)::int n from public.academy_assessment_attempts",
        )
      ).rows[0].n,
    ).toBe(0);
    await institutional("select public.submit_assessment_attempt($1) as v", [
      attempt,
    ]);
    expect(await activity()).toBe("NORMAL");
  });

  it("an active Academy attempt blocks the institutional exam system and other Academy sittings", async () => {
    const started = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      learner,
      "start_my_academy_assessment",
      [enrolment, "quiz-1"],
    );
    expect(started.ok).toBe(true);
    expect(await activity()).toBe("CONTROLLED_ASSESSMENT_ACTIVE");
    // The fixture's QUIZ_2 window is not yet open, so use the database
    // guard directly: no institutional attempt can be inserted at all.
    await expect(
      institutional("select public.start_assessment_attempt($1) as v", [
        quiz1Institutional,
      ]),
    ).rejects.toThrow(
      /Another controlled assessment attempt is already active|No assessment attempts remain/,
    );
    await expect(
      q(
        `insert into public.assessment_attempts(assessment_id, enrolment_id, student_id, cohort_id, programme_version_id, attempt_number, state, started_at, expires_at)
         select a.id, e.id, e.student_id, e.cohort_id, e.programme_version_id, 9, 'ACTIVE', now(), now() + interval '1 hour'
         from public.assessments a join public.enrolments e on e.cohort_id = a.cohort_id and e.student_id = $2 where a.id = $1`,
        [quiz1Institutional, learner.id],
      ),
    ).rejects.toThrow(
      /Another controlled assessment attempt is already active/,
    );
    expect(
      await rpc(q, learner, "start_my_academy_assessment", [
        enrolment,
        "quiz-2",
      ]),
    ).toMatchObject({ ok: false, code: "ANOTHER_ASSESSMENT_ACTIVE" });
    expect(
      await rpc(q, learner, "start_my_academy_assessment", [
        enrolment,
        "quiz-1",
      ]),
    ).toMatchObject({ ok: true, attemptId: started.attemptId, resumed: true });
    // The structural backstop: one active Academy attempt per learner.
    await expect(
      q(
        `insert into public.academy_assessment_attempts(enrolment_id, learner_id, assessment_ref, attempt_number, schedule_item_id, started_at, expires_at)
         select enrolment_id, learner_id, 'quiz-2', 1, schedule_item_id, now(), now() + interval '20 minutes' from public.academy_assessment_attempts where id = $1`,
        [started.attemptId],
      ),
    ).rejects.toThrow(/academy_assessment_attempts_one_active_per_learner/);
  });

  it("closes AI explanation and every learning surface during the sitting, but not logistics", async () => {
    expect(await rpc(q, learner, "academic_action_allowed", ["EXPLAIN"])).toBe(
      false,
    );
    expect(
      await rpc(q, learner, "academic_action_allowed", [
        "COUNSELLOR_LOGISTICS",
      ]),
    ).toBe(true);
    // The Professor/Tutor content-release authority refuses (migration 021).
    expect(
      await rpc(q, learner, "begin_academic_content_release", [
        randomUUID(),
        "get_lesson_context",
        "PROFESSOR_READ_V2",
      ]),
    ).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
    await releaseNow(q, enrolment, "LESSON", "lesson-1-1");
    await expect(
      rpc(q, learner, "get_my_academy_lesson", [enrolment, "lesson-1-1"]),
    ).rejects.toThrow(/ACTIVITY_BLOCKED/);
    expect(
      await rpc(q, learner, "record_my_academy_lesson_studied", [
        enrolment,
        "lesson-1-1",
      ]),
    ).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
    await releaseNow(q, enrolment, "LAB", "lab-1-4-tls-inspection");
    expect(
      await rpc(q, learner, "submit_my_academy_lab", [
        enrolment,
        "lab-1-4-tls-inspection",
        "Findings",
        randomUUID(),
      ]),
    ).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
    const timetable = await rpc<{ examActive: boolean; items: unknown[] }>(
      q,
      learner,
      "get_my_academy_timetable",
      [enrolment],
    );
    expect(timetable.examActive).toBe(true);
    expect(timetable.items.length).toBeGreaterThan(0);
  });

  it("reopens learning when the sitting ends, and an expired attempt never blocks", async () => {
    const attemptId = (
      await q(
        "select id from public.academy_assessment_attempts where state='ACTIVE'",
      )
    ).rows[0].id as string;
    for (const question of template("quiz-1").questions)
      await rpc(q, learner, "record_my_academy_response", [
        attemptId,
        question.position,
        responseBody(question),
        `ctl-${question.position}-key`,
      ]);
    await rpc(q, learner, "submit_my_academy_attempt", [attemptId]);
    expect(await activity()).toBe("NORMAL");
    const lesson = await rpc<{ title: string }>(
      q,
      learner,
      "get_my_academy_lesson",
      [enrolment, "lesson-1-1"],
    );
    expect(lesson.title).toBeTruthy();
    // An attempt whose time ran out is not an active sitting anywhere.
    const second = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      learner,
      "start_my_academy_assessment",
      [enrolment, "quiz-2"],
    );
    expect(second.ok).toBe(true);
    await q(
      "alter table public.academy_assessment_attempts disable trigger guard_history",
    );
    await q(
      "update public.academy_assessment_attempts set started_at = now() - interval '40 minutes', expires_at = now() - interval '1 minute' where id = $1",
      [second.attemptId],
    );
    await q(
      "alter table public.academy_assessment_attempts enable trigger guard_history",
    );
    expect(await activity()).toBe("NORMAL");
    expect(await rpc(q, learner, "academic_action_allowed", ["EXPLAIN"])).toBe(
      true,
    );
  });

  it("refuses an Academy start while an AI content-release lease is open", async () => {
    const lease = await rpc<{ ok: boolean }>(
      q,
      learner,
      "begin_academic_content_release",
      [randomUUID(), "get_lesson_context", "PROFESSOR_READ_V2"],
    );
    expect(lease.ok).toBe(true);
    await openSittingNow(q, enrolment, "midterm");
    expect(
      await rpc(q, learner, "start_my_academy_assessment", [
        enrolment,
        "midterm",
      ]),
    ).toMatchObject({ ok: false, code: "ACTIVITY_BUSY" });
  });
});

describe("authorised lesson release", () => {
  it("never releases a lesson before its own scheduled session, whatever the order of requests", async () => {
    for (const ref of ["lesson-5-6", "lesson-3-1", "not-a-lesson"])
      await expect(
        rpc(q, learner, "get_my_academy_lesson", [enrolment, ref]),
      ).rejects.toThrow(/NOT_RELEASED|NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, people.learnerB, "get_my_academy_lesson", [
        enrolment,
        "lesson-1-1",
      ]),
    ).rejects.toThrow(/NOT_FOUND_OR_FORBIDDEN/);
    await expect(
      rpc(q, people.admin, "get_my_academy_lesson", [enrolment, "lesson-1-1"]),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});

describe("objective evidence and MASTERY_V1", () => {
  it("records one database-derived observation per assessed objective, immutably", async () => {
    const rows = (
      await q(
        "select result, evidence_kind, source_kind from public.academy_objective_evidence where enrolment_id = $1",
        [enrolment],
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (r) =>
          r.evidence_kind === "RETRIEVAL_CHECK" &&
          r.source_kind === "ASSESSMENT_ATTEMPT",
      ),
    ).toBe(true);
    await expect(
      q(
        "update public.academy_objective_evidence set result = 'CORRECT' where enrolment_id = $1",
        [enrolment],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
    await expect(
      q(
        "delete from public.academy_objective_mastery_history where enrolment_id = $1",
        [enrolment],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
    // One evidence kind can never demonstrate mastery under MASTERY_V1.
    const states = (
      await q(
        "select distinct state from public.academy_objective_mastery where enrolment_id = $1",
        [enrolment],
      )
    ).rows.map((r) => r.state);
    expect(states).not.toContain("DEMONSTRATED");
  });

  it("demonstrates an objective only with correct evidence from two sessions of two kinds", async () => {
    // Expire the open lease, then mark every practical in full.
    const release = (
      await q(
        "select id from public.academic_content_releases where student_id = $1 and state = 'ACTIVE'",
        [learner.id],
      )
    ).rows[0].id;
    await rpc(q, learner, "close_academic_content_release", [release, false]);
    await completeLabs(q, learner, enrolment, 10);
    const objective = (
      await q(
        `select e.objective_id from public.academy_objective_evidence e where e.enrolment_id = $1
      group by e.objective_id having count(distinct e.evidence_kind) = 2 and bool_and(e.result = 'CORRECT') limit 1`,
        [enrolment],
      )
    ).rows[0];
    expect(objective).toBeTruthy();
    const mastery = (
      await q(
        "select state, correct_session_count, correct_kind_count from public.academy_objective_mastery where enrolment_id = $1 and objective_id = $2",
        [enrolment, objective.objective_id],
      )
    ).rows[0];
    expect(mastery).toMatchObject({
      state: "DEMONSTRATED",
      correct_kind_count: 2,
    });
    const progress = await rpc<{ objectives: { state: string }[] }>(
      q,
      learner,
      "get_my_academy_progress",
      [enrolment],
    );
    expect(progress.objectives.some((o) => o.state === "DEMONSTRATED")).toBe(
      true,
    );
  });

  it("applies the exact MASTERY_V1 transition table", async () => {
    const cases: [string, string, number, number, string][] = [
      ["NOT_STARTED", "CORRECT", 1, 1, "DEVELOPING"],
      ["NOT_STARTED", "CORRECT", 2, 1, "DEVELOPING"],
      ["DEVELOPING", "CORRECT", 2, 2, "DEMONSTRATED"],
      ["DEVELOPING", "PARTIAL", 2, 2, "DEVELOPING"],
      ["DEMONSTRATED", "PARTIAL", 2, 2, "NEEDS_REINFORCEMENT"],
      ["DEMONSTRATED", "INCORRECT", 3, 2, "NEEDS_REINFORCEMENT"],
      ["NEEDS_REINFORCEMENT", "CORRECT", 3, 2, "DEMONSTRATED"],
      ["NEEDS_REINFORCEMENT", "CORRECT", 1, 1, "DEVELOPING"],
    ];
    for (const [from, result, sessions, kinds, expected] of cases)
      expect(
        (
          await q(
            "select academy_private.mastery_v1_next_state($1,$2,$3,$4) s",
            [from, result, sessions, kinds],
          )
        ).rows[0].s,
      ).toBe(expected);
  });

  it("never lets confirmed study or page reads create evidence or mastery", async () => {
    const before = (
      await q("select count(*)::int n from public.academy_objective_evidence")
    ).rows[0].n;
    await rpc(q, learner, "get_my_academy_lesson", [enrolment, "lesson-1-1"]);
    await rpc(q, learner, "record_my_academy_lesson_studied", [
      enrolment,
      "lesson-1-1",
    ]);
    await rpc(q, learner, "get_my_academy_progress", [enrolment]);
    expect(
      (await q("select count(*)::int n from public.academy_objective_evidence"))
        .rows[0].n,
    ).toBe(before);
  });
});
