import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "./db-helper";
import {
  people,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";
import { publishUnifiedTestCourse } from "./unified-course-fixture";

// Migration 075 class evidence and missed-class recap, end to end over the
// REAL Academy Professor runtime and the REAL learner-academics server
// module on PGlite. Only identity, the PostgREST transport and the provider
// (a deterministic stub, no paid AI call) are substituted, exactly as in
// tests/academy-ai-teaching.test.ts.
const keyId = randomUUID();
const key = randomBytes(32);
process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = key.toString("hex");

const m = vi.hoisted(() => ({
  person: null as null | { id: string; auth: string },
  db: null as unknown,
}));
const actor = () =>
  m.person
    ? { id: m.person.id, roles: ["STUDENT"], displayName: "Academy learner" }
    : null;
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => actor(),
  getCurrentActor: async () => actor(),
  requireStudentPrincipal: async () => {
    const a = actor();
    if (!a) throw new Error("unauthenticated");
    return a;
  },
  requireActor: async () => actor(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const db = m.db as PGlite;
      try {
        const sig = await db.query<{ names: string[]; types: string[] }>(
          `select p.proargnames names, array(select format_type(t,null) from unnest(p.proargtypes) t) types
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,
          [name],
        );
        const { names, types } = sig.rows[0] ?? { names: [], types: [] };
        const used = (names ?? [])
          .map((n, i) => ({ n, t: types[i] }))
          .filter((p) => p.n in args);
        const values = used.map((p) =>
          p.t === "jsonb" && args[p.n] != null
            ? JSON.stringify(args[p.n])
            : Array.isArray(args[p.n])
              ? `{${(args[p.n] as string[]).join(",")}}`
              : args[p.n],
        );
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          m.person?.auth ?? "",
        ]);
        await db.exec(m.person ? "set role authenticated" : "set role anon");
        try {
          const r = await db.query<{ v: unknown }>(
            `select public.${name}(${used.map((p, i) => `${p.n} => $${i + 1}::${p.t}`).join(",")}) v`,
            values,
          );
          return { data: r.rows[0].v, error: null };
        } finally {
          await db.exec("reset role");
        }
      } catch (e) {
        const err = e as { message: string; code?: string };
        return { data: null, error: { message: err.message, code: err.code } };
      }
    },
  }),
}));

import { executeAcademyProfessorClassroomWithTestOverrides } from "@/server/academic-runtime/academy-professor";
import {
  checkInToClass,
  getMyClassEvidence,
  getMyCourseProgression,
  getMyCourseWorkspace,
  getMyLearnerWeek,
  getMyNextActivity,
  getMyReleasedResults,
  listMyLeaderboards,
  listMyLearnerCourses,
  refreshMyReleases,
} from "@/server/learner-academics";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type ProviderAdapter,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

let db: PGlite;
let q: Query;
const learner = people.learnerA as Person;
const reason = "Synthetic class evidence acceptance";
let enrolment = "";
let classroomId = "";
let lessonObjective = "";
let foreignObjective = "";
let missedTitle = "";
let missedObjectives: string[] = [];

const profile: RuntimeProfile = {
  ref: "PROFESSOR_COMMERCIAL_V1",
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: {
    ...DEFAULT_RUNTIME_BUDGET_POLICY,
    maxInputContextBytes: 64_000,
  },
};
function stub(text: string) {
  const requests: RuntimeProviderRequest[] = [];
  const adapter: ProviderAdapter & { requests: RuntimeProviderRequest[] } = {
    name: "class-evidence-stub",
    requests,
    async generate(request) {
      requests.push(request);
      return {
        outputText: text,
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          estimatedCostMicrousd: 90,
        },
      };
    },
  };
  return adapter;
}
const run = (
  adapter: ProviderAdapter,
  interaction: Record<string, unknown>,
) => {
  m.person = learner;
  return executeAcademyProfessorClassroomWithTestOverrides(
    { classroomId, interaction },
    {
      resolveProfile: (ref) => (ref === profile.ref ? profile : null),
      resolveAdapter: () => adapter,
    },
  );
};
async function moveItems(kind: string, ref: string, offset: string) {
  await q(
    "alter table public.academy_schedule_items disable trigger guard_history",
  );
  try {
    await q(
      `update public.academy_schedule_items i
          set starts_at = now() + $4::interval, ends_at = now() + $4::interval + make_interval(mins => i.minutes),
              opens_at = now() + $4::interval, closes_at = now() + $4::interval + interval '1439 minutes'
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
const lessonItem = async (ref: string) =>
  (
    await q(
      `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id=i.schedule_id
        where s.enrolment_id=$1 and s.superseded_at is null and i.kind='LESSON' and i.ref=$2 order by i.sequence limit 1`,
      [enrolment, ref],
    )
  ).rows[0].id as string;
const objectivesOf = async (ref: string) =>
  (
    await q(
      `select o.id, o.description from public.lesson_objectives o join public.academy_course_lessons cl on cl.lesson_id=o.lesson_id
        join public.academy_enrolments e on e.course_id=cl.course_id where e.id=$1 and cl.lesson_ref=$2 order by o.position`,
      [enrolment, ref],
    )
  ).rows as { id: string; description: string }[];
function sign(canonical: string) {
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

beforeAll(async () => {
  db = await testDatabase();
  m.db = db;
  q = (sql, params) => db.query(sql, params) as ReturnType<Query>;
  await seedPeople(q);
  await q(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  const { courseId } = await publishUnifiedTestCourse(
    q,
    "class-evidence-course",
  );
  await rpc(q, people.admin, "create_course_coupon", [
    "CLASS-EVIDENCE-FREE",
    100,
    new Date(Date.now() + 86400000).toISOString(),
    5,
    courseId,
    reason,
  ]);
  enrolment = (
    await rpc<{ enrolmentId: string }>(
      q,
      learner,
      "create_unified_course_order",
      ["class-evidence-course", "CLASS-EVIDENCE-FREE"],
    )
  ).enrolmentId;
  const confirmed = await rpc<{ ok: boolean }>(
    q,
    learner,
    "confirm_my_academy_schedule",
    [
      enrolment,
      "ACCELERATED_2W",
      new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      [1, 2, 3, 4, 5, 6, 7],
      "09:00",
      "Europe/London",
      randomUUID(),
    ],
  );
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  // lesson-1-1 was missed (window closed, no attendance); lesson-1-2 is open.
  await moveItems("LESSON", "lesson-1-1", "-26 hours");
  await moveItems("LESSON", "lesson-1-2", "-1 hour");
  const own = await objectivesOf("lesson-1-2");
  const missed = await objectivesOf("lesson-1-1");
  lessonObjective = own[0].id;
  foreignObjective = missed[0].id;
  missedObjectives = missed.map((o) => o.description);
  missedTitle = (
    await q(
      `select l.title from public.lessons l join public.academy_course_lessons cl on cl.lesson_id=l.id
        join public.academy_enrolments e on e.course_id=cl.course_id where e.id=$1 and cl.lesson_ref='lesson-1-1'`,
      [enrolment],
    )
  ).rows[0].title as string;
}, 300000);
afterAll(async () => {
  await db?.close();
});

describe("check-in through the learner academics server module", () => {
  it("records attendance and opens the existing classroom flow", async () => {
    m.person = learner;
    const item = await lessonItem("lesson-1-2");
    const first = await checkInToClass(enrolment, item);
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      classroomCode: null,
    });
    if (!first.ok || !first.classroomId) throw new Error(JSON.stringify(first));
    classroomId = first.classroomId;
    const again = await checkInToClass(enrolment, item);
    expect(again).toMatchObject({
      ok: true,
      replayed: true,
      classroomId,
      checkedInAt: first.checkedInAt,
    });
    expect(
      await checkInToClass(enrolment, await lessonItem("lesson-1-1")),
    ).toEqual({
      ok: false,
      code: "WINDOW_CLOSED",
    });
  });
});

describe("governed Professor recap and display-only class evidence", () => {
  it("gives the next class the missed lesson's objectives and records only the lesson's own objectives", async () => {
    const line = `DUCELIO_CLASS_EVIDENCE ${JSON.stringify({
      coveredObjectiveRefs: [lessonObjective, foreignObjective],
      check: { objectiveRef: lessonObjective, correct: true },
    })}`;
    const visible =
      "Quick recap of last class, then a check: which control type is a policy?";
    const adapter = stub(`${visible}\n${line}`);
    const result = await run(adapter, { kind: "BEGIN_LESSON" });
    expect(result).toMatchObject({
      outcome: "SUCCEEDED",
      classroomMemory: "RECORDED",
    });
    if (result.outcome !== "SUCCEEDED") throw new Error("unreachable");
    // The learner never sees the evidence line, in the reply or in memory.
    expect(result.response.outputText).toBe(visible);
    const turn = (
      await q(
        "select professor_message from public.academy_professor_classroom_turns where classroom_id=$1",
        [classroomId],
      )
    ).rows;
    expect(turn).toEqual([{ professor_message: visible }]);
    // The recap reached the provider as code-owned server context.
    const context = adapter.requests[0].context as {
      serverContext: { academyClass: Record<string, unknown> };
    };
    expect(context.serverContext.academyClass).toMatchObject({
      authority: "AUTHORITATIVE_SERVER_DERIVED",
      missedClassRecap: {
        required: true,
        missedLessons: [
          { lessonTitle: missedTitle, objectives: missedObjectives },
        ],
      },
    });
    expect(JSON.stringify(adapter.requests[0])).not.toMatch(
      /answerKey|correctOptionId|markingGuidance/,
    );
    // Only the classroom lesson's objective was recorded; never mastery.
    expect(
      (
        await q(
          "select objective_id from public.academy_class_covered_objectives where classroom_id=$1",
          [classroomId],
        )
      ).rows,
    ).toEqual([{ objective_id: lessonObjective }]);
    expect(
      (
        await q(
          "select objective_id, correct, source from public.academy_class_checks where classroom_id=$1",
          [classroomId],
        )
      ).rows,
    ).toEqual([
      {
        objective_id: lessonObjective,
        correct: true,
        source: "PROFESSOR_EXECUTION",
      },
    ]);
    for (const table of [
      "academy_objective_evidence",
      "academy_objective_mastery",
      "academy_lesson_progress",
    ])
      expect(
        (await q(`select count(*)::int n from public.${table}`)).rows[0].n,
      ).toBe(0);
    m.person = learner;
    const week = await getMyLearnerWeek();
    const lessonId = await lessonItem("lesson-1-2");
    const evidence = await getMyClassEvidence(enrolment, week.weekStart);
    expect(evidence[lessonId]).toMatchObject({
      checkedInAt: expect.any(String),
      correctInClassAnswers: 1,
      topicsCovered: [expect.any(String)],
    });
    expect(
      evidence[lessonId].lessonObjectives
        .filter((o) => o.covered)
        .map((o) => o.ref),
    ).toEqual([lessonObjective]);
  });

  it("refuses forged, foreign-objective and unrecorded evidence at the database", async () => {
    // A second governed exchange without an evidence line.
    const result = await run(stub("Let us continue with the next objective."), {
      kind: "LEARNER_QUESTION",
      learnerMessage: "Can we continue?",
    });
    expect(result).toMatchObject({
      outcome: "SUCCEEDED",
      classroomMemory: "RECORDED",
    });
    const execution = (
      await q(
        `select t.execution_id from public.academy_professor_classroom_turns t
          where t.classroom_id=$1 and not exists (select 1 from public.academy_class_evidence_records r where r.execution_id=t.execution_id)`,
        [classroomId],
      )
    ).rows[0].execution_id as string;
    const issued = Math.floor(Date.now() / 1000);
    const call = (covered: string[], mac?: string) => {
      const canonical = [
        "DUCELIO_ACADEMY_CLASS_EVIDENCE_HMAC_SHA256_V1",
        "PROFESSOR",
        keyId,
        learner.id,
        execution,
        classroomId,
        [...covered].sort().join(","),
        "NONE",
        "NONE",
        String(issued),
        String(issued + 10),
      ].join("\n");
      return rpc(q, learner, "record_my_academy_class_evidence", [
        keyId,
        execution,
        classroomId,
        covered,
        null,
        null,
        issued,
        issued + 10,
        mac ?? sign(canonical),
      ]);
    };
    expect(await call([lessonObjective], "0".repeat(64))).toEqual({
      ok: false,
      code: "ATTESTATION_INVALID",
    });
    expect(await call([foreignObjective])).toEqual({
      ok: false,
      code: "OBJECTIVE_OUTSIDE_LESSON",
    });
    expect(
      await rpc(q, people.learnerB, "record_my_academy_class_evidence", [
        keyId,
        execution,
        classroomId,
        [lessonObjective],
        null,
        null,
        issued,
        issued + 10,
        "0".repeat(64),
      ]),
    ).toMatchObject({ ok: false });
    expect(await call([lessonObjective])).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(await call([lessonObjective])).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(
      (await q("select count(*)::int n from public.academy_objective_evidence"))
        .rows[0].n,
    ).toBe(0);
  });
});

describe("learner academics projections parse the shared contract", () => {
  it("returns courses, week, next activity, workspace, progression, results and leaderboards", async () => {
    m.person = learner;
    const courses = await listMyLearnerCourses();
    expect(courses).toEqual([
      expect.objectContaining({
        enrolmentId: enrolment,
        provider: "Ducelio",
        status: "ACTIVE",
        scheduled: true,
      }),
    ]);
    const week = await getMyLearnerWeek();
    expect(
      week.activities.some(
        (a) => a.ref === "lesson-1-2" && a.state === "ATTENDED",
      ),
    ).toBe(true);
    expect(await getMyNextActivity()).not.toBeNull();
    const workspace = await getMyCourseWorkspace(enrolment);
    expect(workspace.course.enrolmentId).toBe(enrolment);
    expect(workspace.currentClass).toMatchObject({
      ref: "lesson-1-2",
      state: "ATTENDED",
      classroomId,
      evidence: { correctInClassAnswers: 1 },
    });
    expect(workspace.tutorAvailable).toBe(true);
    expect(workspace.results).toEqual([]);
    const progression = await getMyCourseProgression(enrolment);
    expect(progression.classes).toMatchObject({ attended: 1, missed: 1 });
    expect(progression.completion.completed).toBe(false);
    expect(await getMyReleasedResults()).toEqual([]);
    expect(await getMyReleasedResults(enrolment)).toEqual([]);
    expect(await listMyLeaderboards()).toEqual([]);
    expect(await refreshMyReleases(enrolment)).toEqual({ released: [] });
    m.person = people.learnerB as Person;
    await expect(getMyCourseWorkspace(enrolment)).rejects.toThrow();
  });
});
