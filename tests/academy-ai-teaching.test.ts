import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "./db-helper";
import {
  approvedTestPackage,
  as,
  openSittingNow,
  people,
  publishAcademyCourse,
  releaseNow,
  rpc,
  seedPeople,
  type Person,
  type Query,
} from "./academy-fixture";

// Migration 062 end to end over the REAL Academy Professor runtime
// (executeAcademyProfessorClassroom's test entrypoint), the REAL release,
// governance (migration 025), provenance and memory code, and the REAL
// database authority on a disposable PGlite database. Only identity, the
// PostgREST transport and the provider (a deterministic stub, no paid AI
// call) are substituted.
const keyId = randomUUID();
const key = randomBytes(32);
process.env.ACADEMIC_EXECUTION_KEY_ID = keyId;
process.env.ACADEMIC_EXECUTION_HMAC_KEY_HEX = key.toString("hex");

const m = vi.hoisted(() => ({
  person: null as null | { id: string; auth: string },
  db: null as unknown,
  // Test hook: runs (as the database owner) just before the named RPC.
  hook: null as null | ((name: string) => Promise<void>),
}));
const actor = () =>
  m.person
    ? {
        id: m.person.id,
        roles: ["STUDENT"],
        displayName: "Academy learner",
      }
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
// A PostgREST-like rpc over PGlite as the signed-in learner, with named
// arguments cast to the function's declared types.
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const db = m.db as PGlite;
      try {
        if (m.hook) await m.hook(name);
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
  DEFAULT_RUNTIME_BUDGET_POLICY,
  type ProviderAdapter,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";
import { ProviderFailure } from "@/domain/academic-runtime";
import { capabilitySchemas } from "@/domain/academic-capabilities";

let db: PGlite;
let q: Query;
const learnerA = people.learnerA as Person;
const learnerB = people.learnerB as Person;
const learnerC = people.learnerC as Person;
const enrolments: Record<string, string> = {};
let lessonRef = "";
let lessonItem = "";
let quizItem = "";
let futureLessonItem = "";
let classroomA = "";
const COHORT_TABLES = [
  "enrolments",
  "professor_classroom_sessions",
  "professor_classroom_turns",
  "professor_classroom_interaction_reservations",
  "academic_agent_execution_provenance",
  "class_sessions",
  "cohorts",
];
const cohortBaseline: Record<string, number> = {};

const profile: RuntimeProfile = {
  ref: "PROFESSOR_COMMERCIAL_V1",
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: {
    ...DEFAULT_RUNTIME_BUDGET_POLICY,
    maxInputContextBytes: 64_000,
  },
};
function stub(
  outcome: "success" | "failure" = "success",
  text = "Welcome to this Security+ lesson. Let us begin with the first objective.",
) {
  const requests: RuntimeProviderRequest[] = [];
  const adapter: ProviderAdapter & { requests: RuntimeProviderRequest[] } = {
    name: "academy-test-stub",
    requests,
    async generate(request) {
      requests.push(request);
      if (outcome === "failure")
        throw new ProviderFailure("PROVIDER_REFUSED", "stub refusal");
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
  person: Person,
  classroomId: string,
  adapter: ProviderAdapter,
  interaction: Record<string, unknown> = { kind: "BEGIN_LESSON" },
) => {
  m.person = person;
  return executeAcademyProfessorClassroomWithTestOverrides(
    { classroomId, interaction },
    {
      resolveProfile: (ref) => (ref === profile.ref ? profile : null),
      resolveAdapter: () => adapter,
    },
  );
};
const count = async (sql: string, params: unknown[] = []) =>
  (await q(sql, params)).rows[0].n as number;
const open = (person: Person, enrolmentId: string, itemId: string) =>
  rpc<{ ok: boolean; code?: string; classroomId?: string; resumed?: boolean }>(
    q,
    person,
    "open_my_academy_professor_classroom",
    [enrolmentId, itemId],
  );
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);

beforeAll(async () => {
  db = await testDatabase();
  m.db = db;
  q = (sql, params) =>
    db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
  await seedPeople(q);
  await q(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  const course = await publishAcademyCourse(
    q,
    "academy-ai-teaching-test",
    approvedTestPackage("academy-ai-teaching-test"),
  );
  for (const table of COHORT_TABLES)
    cohortBaseline[table] = await count(
      `select count(*)::int n from public.${table}`,
    );
  for (const p of [learnerA, learnerB, learnerC]) {
    enrolments[p.id] = await rpc<string>(
      q,
      people.admin,
      "grant_academy_entitlement",
      [course.offerId, p.email, null, "AI teaching acceptance access"],
    );
    const confirmed = await rpc<{ ok: boolean }>(
      q,
      p,
      "confirm_my_academy_schedule",
      [
        enrolments[p.id],
        "STANDARD_6W",
        addDays(today(), 2),
        [1, 3, 5, 6],
        "19:00",
        "Europe/London",
        randomUUID(),
      ],
    );
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
  }
  const items = (
    await q(
      `select i.id, i.kind, i.ref, i.part from public.academy_schedule_items i
       join public.academy_schedules s on s.id = i.schedule_id and s.superseded_at is null
       where i.enrolment_id = $1 order by i.sequence`,
      [enrolments[learnerA.id]],
    )
  ).rows as { id: string; kind: string; ref: string; part: number }[];
  const lesson = items.find((i) => i.kind === "LESSON" && i.part === 1)!;
  lessonRef = lesson.ref;
  lessonItem = lesson.id;
  quizItem = items.find((i) => i.kind === "ASSESSMENT")!.id;
  futureLessonItem = items.filter(
    (i) => i.kind === "LESSON" && i.ref !== lessonRef,
  )[0].id;
}, 240000);
afterAll(async () => {
  await db?.close();
});

describe("entering a scheduled Academy class", () => {
  it("refuses entry before the scheduled time", async () => {
    expect(await open(learnerA, enrolments[learnerA.id], lessonItem)).toEqual({
      ok: false,
      code: "NOT_YET_STARTED",
    });
    expect(
      await count(
        "select count(*)::int n from public.academy_professor_classrooms",
      ),
    ).toBe(0);
  });

  it("opens the learner's own class once its time arrives, and resumes it", async () => {
    for (const p of [learnerA, learnerB, learnerC])
      await releaseNow(q, enrolments[p.id], "LESSON", lessonRef);
    const first = await open(learnerA, enrolments[learnerA.id], lessonItem);
    expect(first).toMatchObject({ ok: true, resumed: false });
    classroomA = first.classroomId!;
    expect(await open(learnerA, enrolments[learnerA.id], lessonItem)).toEqual({
      ok: true,
      classroomId: classroomA,
      resumed: true,
    });
    const state = await rpc<{ ok: boolean; state: Record<string, unknown> }>(
      q,
      learnerA,
      "get_my_academy_professor_classroom_state",
      [classroomA],
    );
    expect(state.ok).toBe(true);
    expect(state.state).toMatchObject({
      classroomId: classroomA,
      classSessionId: lessonItem,
      enrolmentId: enrolments[learnerA.id],
      mode: "CATCH_UP",
    });
    expect(
      (state as unknown as { view: { timezone: string } }).view.timezone,
    ).toBe("Europe/London");
  });

  it("refuses another learner's class and forged enrolment or session ids", async () => {
    // Learner B with A's enrolment, and with B's own enrolment and A's item.
    expect(await open(learnerB, enrolments[learnerA.id], lessonItem)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(await open(learnerB, enrolments[learnerB.id], lessonItem)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(
      await open(learnerA, enrolments[learnerA.id], randomUUID()),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(await open(learnerA, randomUUID(), lessonItem)).toMatchObject({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    // A scheduled assessment is not a class; an unreleased lesson is closed.
    expect(await open(learnerA, enrolments[learnerA.id], quizItem)).toEqual({
      ok: false,
      code: "NOT_A_CLASS",
    });
    expect(
      await open(learnerA, enrolments[learnerA.id], futureLessonItem),
    ).toEqual({ ok: false, code: "NOT_YET_STARTED" });
    for (const fn of [
      "get_my_academy_professor_classroom_state",
      "reserve_my_academy_professor_interaction",
    ])
      expect(
        await rpc(
          q,
          learnerB,
          fn,
          fn.startsWith("reserve") ? [classroomA, "k"] : [classroomA],
        ),
      ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const stranger = stub();
    expect(await run(learnerB, classroomA, stranger)).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    expect(stranger.requests).toHaveLength(0);
    // The runtime rejects a request that names anything but a classroom id
    // and a closed interaction (no enrolment, lesson or free-form JSON).
    m.person = learnerA;
    await expect(
      executeAcademyProfessorClassroomWithTestOverrides({
        classroomId: classroomA,
        interaction: { kind: "BEGIN_LESSON" },
        lessonId: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("governed Professor teaching", () => {
  it("teaches the approved lesson through the existing governed execution", async () => {
    const adapter = stub();
    const result = await run(learnerA, classroomA, adapter);
    expect(result).toMatchObject({
      outcome: "SUCCEEDED",
      classroomMemory: "RECORDED",
    });
    expect(adapter.requests).toHaveLength(1);
    const context = JSON.parse(JSON.stringify(adapter.requests[0])) as Record<
      string,
      unknown
    >;
    const text = JSON.stringify(context);
    const objectives = (
      await q(
        `select o.description from public.lesson_objectives o
         join public.academy_professor_classrooms c on c.lesson_id = o.lesson_id where c.id = $1 order by o.position`,
        [classroomA],
      )
    ).rows.map((r) => r.description as string);
    expect(objectives.length).toBeGreaterThan(0);
    for (const o of objectives)
      expect(text).toContain(JSON.stringify(o).slice(1, -1));
    // No protected assessment content reaches the provider.
    expect(text).not.toMatch(/answerKey|correctOptionId|markingGuidance/);

    const execution = (
      await q(
        `select x.state, x.reason_code, u.provider_calls, u.output_tokens, u.estimated_cost_microusd
         from public.academic_provider_executions x join public.academic_provider_execution_usage u on u.execution_id = x.id
         where x.student_id = $1`,
        [learnerA.id],
      )
    ).rows;
    expect(execution).toEqual([
      {
        state: "SUCCEEDED",
        reason_code: "PROVIDER_COMPLETE",
        provider_calls: 1,
        output_tokens: 40,
        estimated_cost_microusd: 90,
      },
    ]);
    expect(
      (
        await q(
          `select r.capability_name from public.academy_professor_execution_context_releases r
           join public.academy_professor_execution_provenance p on p.execution_id = r.execution_id
           where p.classroom_id = $1 order by r.position`,
          [classroomA],
        )
      ).rows.map((r) => r.capability_name),
    ).toEqual([
      "get_lesson_context",
      "get_lesson_objectives",
      "get_learning_resources",
      "get_current_mastery_state",
    ]);
    // Every release was closed COMPLETED after the provider ran.
    expect(
      await count(
        "select count(*)::int n from public.academic_content_releases where student_id = $1 and state <> 'COMPLETED'",
        [learnerA.id],
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int n from public.academy_professor_classroom_turns where classroom_id = $1",
        [classroomA],
      ),
    ).toBe(1);
  });

  it("continues the class from stored memory on a learner question", async () => {
    const adapter = stub(
      "success",
      "Least privilege limits each account to what it needs.",
    );
    const result = await run(learnerA, classroomA, adapter, {
      kind: "LEARNER_QUESTION",
      learnerMessage: "What does least privilege mean?",
    });
    expect(result).toMatchObject({ outcome: "SUCCEEDED" });
    const sent = JSON.stringify(adapter.requests[0]);
    expect(sent).toContain("Welcome to this Security+ lesson");
    expect(sent).toContain("What does least privilege mean?");
    const turns = await rpc<{ ok: boolean; totalTurns: number }>(
      q,
      learnerA,
      "list_my_academy_professor_turns",
      [classroomA, 50],
    );
    expect(turns).toMatchObject({ ok: true, totalTurns: 2 });
  });

  it("keeps opened, taught, studied, graded and mastery distinct", async () => {
    const progress = await rpc<Record<string, unknown>>(
      q,
      learnerA,
      "get_my_academy_progress",
      [enrolments[learnerA.id]],
    );
    expect(progress).toMatchObject({
      classesOpened: 1,
      teachingInteractions: 2,
      studied: 0,
    });
    expect(
      (progress.objectives as { state: string }[]).every(
        (o) => o.state === "NOT_STARTED",
      ),
    ).toBe(true);
    for (const table of [
      "academy_objective_evidence",
      "academy_objective_mastery",
      "academy_lesson_progress",
      "academy_assessment_attempts",
      "academy_completions",
    ])
      expect(await count(`select count(*)::int n from public.${table}`)).toBe(
        0,
      );
    const timetable = await rpc<{ items: Record<string, unknown>[] }>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolments[learnerA.id]],
    );
    expect(timetable.items.find((i) => i.id === lessonItem)).toMatchObject({
      classOpened: true,
      teachingTurns: 2,
      studied: false,
    });
  });

  it("records a provider failure truthfully, with its usage and no memory", async () => {
    const adapter = stub("failure");
    const result = await run(learnerA, classroomA, adapter, {
      kind: "LEARNER_QUESTION",
      learnerMessage: "Can you explain that again?",
    });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "FAILED" });
    const failed = (
      await q(
        `select x.state, x.reason_code, u.provider_calls, u.attempts from public.academic_provider_executions x
         join public.academic_provider_execution_usage u on u.execution_id = x.id
         where x.student_id = $1 and x.state <> 'SUCCEEDED'`,
        [learnerA.id],
      )
    ).rows;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      state: "FAILED",
      reason_code: "PROVIDER_REFUSED",
      provider_calls: 1,
      attempts: 1,
    });
    expect(
      await count(
        "select count(*)::int n from public.academy_professor_classroom_turns where classroom_id = $1",
        [classroomA],
      ),
    ).toBe(2);
  });

  it("replays a reserved learner action as a duplicate before any provider call", async () => {
    expect(
      await rpc(q, learnerA, "reserve_my_academy_professor_interaction", [
        classroomA,
        "same-key",
      ]),
    ).toEqual({ ok: true, duplicate: false });
    expect(
      await rpc(q, learnerA, "reserve_my_academy_professor_interaction", [
        classroomA,
        "same-key",
      ]),
    ).toEqual({ ok: true, duplicate: true });
  });
});

describe("firewalls and refusals", () => {
  it("refuses forged reads, reused releases and cross-protocol attestations", async () => {
    // A release of another capability, then a consumed release.
    const begin = (capability: string) =>
      rpc<{ ok: boolean; release_id: string }>(
        q,
        learnerA,
        "begin_academic_content_release",
        [randomUUID(), capability, "PROFESSOR_READ_V2"],
      );
    const objectives = await begin("get_lesson_objectives");
    expect(
      await rpc(q, learnerA, "read_my_academy_professor_context", [
        objectives.release_id,
        classroomA,
        "get_lesson_context",
      ]),
    ).toEqual({ ok: false, code: "CONTENT_RELEASE_UNAVAILABLE" });
    expect(
      await rpc(q, learnerA, "read_my_academy_professor_context", [
        objectives.release_id,
        classroomA,
        "get_lesson_objectives",
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await rpc(q, learnerA, "read_my_academy_professor_context", [
        objectives.release_id,
        classroomA,
        "get_lesson_objectives",
      ]),
    ).toEqual({ ok: false, code: "CONTENT_RELEASE_UNAVAILABLE" });
    // Learner B cannot read A's classroom under B's own release.
    const foreign = await rpc<{ release_id: string }>(
      q,
      learnerB,
      "begin_academic_content_release",
      [randomUUID(), "get_lesson_context", "PROFESSOR_READ_V2"],
    );
    expect(
      await rpc(q, learnerB, "read_my_academy_professor_context", [
        foreign.release_id,
        classroomA,
        "get_lesson_context",
      ]),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    // A turn attested with the cohort protocol tag is refused.
    const issued = Math.floor(Date.now() / 1000);
    const executionId = (
      await q(
        "select id from public.academic_provider_executions where student_id = $1 and state = 'SUCCEEDED' limit 1",
        [learnerA.id],
      )
    ).rows[0].id as string;
    const canonical = [
      "DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1",
      "PROFESSOR",
      keyId,
      learnerA.id,
      executionId,
      classroomA,
      "BEGIN_LESSON",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      String(issued),
      String(issued + 10),
    ].join("\n");
    expect(
      await rpc(q, learnerA, "record_my_academy_professor_turn", [
        keyId,
        executionId,
        classroomA,
        "BEGIN_LESSON",
        null,
        "",
        issued,
        issued + 10,
        createHmac("sha256", key).update(canonical).digest("hex"),
      ]),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(
      await rpc(q, learnerA, "record_my_academy_professor_turn", [
        keyId,
        executionId,
        classroomA,
        "BEGIN_LESSON",
        null,
        "Forged",
        issued,
        issued + 10,
        createHmac("sha256", key).update(canonical).digest("hex"),
      ]),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    // Tables are not readable or writable directly by any API role.
    await expect(
      as(q, learnerA, "select * from public.academy_professor_classroom_turns"),
    ).rejects.toThrow();
    await expect(
      as(
        q,
        learnerA,
        "insert into public.academy_professor_classrooms(learner_id) values ($1)",
        [learnerA.id],
      ),
    ).rejects.toThrow();
  });

  it("closes classes and Professor teaching while a controlled assessment is active", async () => {
    const enrolment = enrolments[learnerC.id];
    const opened = await open(
      learnerC,
      enrolment,
      (
        await q(
          `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
           and s.superseded_at is null where i.enrolment_id = $1 and i.kind = 'LESSON' and i.ref = $2 and i.part = 1`,
          [enrolment, lessonRef],
        )
      ).rows[0].id as string,
    );
    expect(opened.ok).toBe(true);
    await openSittingNow(q, enrolment, "quiz-1");
    const started = await rpc<{ ok: boolean; attemptId: string }>(
      q,
      learnerC,
      "start_my_academy_assessment",
      [enrolment, "quiz-1"],
    );
    expect(started.ok).toBe(true);
    const adapter = stub();
    expect(await run(learnerC, opened.classroomId!, adapter)).toMatchObject({
      outcome: "ABSTAINED",
      reason: "ACTIVITY_BLOCKED",
    });
    expect(adapter.requests).toHaveLength(0);
    for (const [fn, args] of [
      ["get_my_academy_professor_classroom_state", [opened.classroomId]],
      ["list_my_academy_professor_turns", [opened.classroomId, 10]],
      ["reserve_my_academy_professor_interaction", [opened.classroomId, "k1"]],
      ["get_my_academy_professor_agent", [enrolment]],
    ] as const)
      expect(await rpc(q, learnerC, fn, [...args])).toEqual({
        ok: false,
        code: "ACTIVITY_BLOCKED",
      });
    expect(
      await count(
        "select count(*)::int n from public.academic_provider_executions where student_id = $1",
        [learnerC.id],
      ),
    ).toBe(0);
    await rpc(q, learnerC, "submit_my_academy_attempt", [started.attemptId]);
    expect(
      await rpc(q, learnerC, "get_my_academy_professor_classroom_state", [
        opened.classroomId,
      ]),
    ).toMatchObject({ ok: true });
  });

  it("blocks a revoked enrolment while its history stays intact", async () => {
    const enrolment = enrolments[learnerB.id];
    const item = (
      await q(
        `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
         and s.superseded_at is null where i.enrolment_id = $1 and i.kind = 'LESSON' and i.ref = $2 and i.part = 1`,
        [enrolment, lessonRef],
      )
    ).rows[0].id as string;
    const opened = await open(learnerB, enrolment, item);
    expect(opened.ok).toBe(true);
    const entitlement = (
      await q(
        "select entitlement_id from public.academy_enrolments where id = $1",
        [enrolment],
      )
    ).rows[0].entitlement_id as string;
    await rpc(q, people.admin, "admin_revoke_academy_entitlement", [
      entitlement,
      "Refund processed for acceptance test",
    ]);
    expect(await open(learnerB, enrolment, item)).toEqual({
      ok: false,
      code: "ACCESS_REVOKED",
    });
    const adapter = stub();
    expect(await run(learnerB, opened.classroomId!, adapter)).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    expect(adapter.requests).toHaveLength(0);
    for (const fn of [
      "get_my_academy_professor_classroom_state",
      "get_my_academy_professor_agent",
    ])
      expect(
        await rpc(q, learnerB, fn, [
          fn.endsWith("agent") ? enrolment : opened.classroomId,
        ]),
      ).toEqual({ ok: false, code: "ACCESS_REVOKED" });
    expect(
      await count(
        "select count(*)::int n from public.academy_professor_classrooms where id = $1",
        [opened.classroomId],
      ),
    ).toBe(1);
  });

  it("keeps class history through a timetable revision", async () => {
    const enrolment = enrolments[learnerA.id];
    const before = await rpc<{ schedule: { revision: number } }>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolment],
    );
    const revised = await rpc<{ ok: boolean }>(
      q,
      learnerA,
      "revise_my_academy_schedule",
      [
        enrolment,
        before.schedule.revision,
        addDays(today(), 4),
        [2, 4, 6, 7],
        "08:00",
        "America/New_York",
        randomUUID(),
      ],
    );
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    // The already-started class was carried unchanged: entering it from the
    // new timetable resumes the same classroom; the superseded entry is
    // refused rather than forked.
    const carried = (
      await q(
        `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
         and s.superseded_at is null where i.enrolment_id = $1 and i.kind = 'LESSON' and i.ref = $2 and i.part = 1`,
        [enrolment, lessonRef],
      )
    ).rows[0].id as string;
    expect(carried).not.toBe(lessonItem);
    expect(await open(learnerA, enrolment, carried)).toEqual({
      ok: true,
      classroomId: classroomA,
      resumed: true,
    });
    expect(await open(learnerA, enrolment, lessonItem)).toEqual({
      ok: false,
      code: "SCHEDULE_SUPERSEDED",
    });
    // The class renders in the learner's CURRENT timetable timezone, which
    // the revision changed; the scheduled instants themselves are unchanged.
    const view = await rpc<{
      ok: boolean;
      state: { scheduledStart: string };
      view: { timezone: string };
    }>(q, learnerA, "get_my_academy_professor_classroom_state", [classroomA]);
    expect(view.view.timezone).toBe("America/New_York");
    const timetable = await rpc<{ items: Record<string, unknown>[] }>(
      q,
      learnerA,
      "get_my_academy_timetable",
      [enrolment],
    );
    expect(timetable.items.find((i) => i.id === carried)).toMatchObject({
      classOpened: true,
      teachingTurns: 2,
    });
    const classroom = (
      await q(
        "select schedule_item_id, scheduled_start from public.academy_professor_classrooms where id = $1",
        [classroomA],
      )
    ).rows[0];
    expect(classroom.schedule_item_id).toBe(lessonItem);
    await expect(
      q(
        "update public.academy_professor_classrooms set opened_at = now() where id = $1",
        [classroomA],
      ),
    ).rejects.toThrow(/IMMUTABLE_HISTORY/);
  });

  it("never touches the cohort classroom, enrolment or provenance records", async () => {
    // Exactly what the curriculum publication pipeline left, before any
    // Academy class existed.
    for (const table of COHORT_TABLES)
      expect(
        await count(`select count(*)::int n from public.${table}`),
        table,
      ).toBe(cohortBaseline[table]);
  });
});

describe("audit regressions", () => {
  const classroomOf = async (person: Person) =>
    (
      await q(
        "select id from public.academy_professor_classrooms where learner_id = $1",
        [person.id],
      )
    ).rows[0].id as string;
  const lessonStartsAt = async (enrolmentId: string, offset: string) => {
    await q(
      "alter table public.academy_schedule_items disable trigger guard_history",
    );
    await q(
      `update public.academy_schedule_items set starts_at = now() + $3::interval, ends_at = now() + $3::interval + interval '1 hour'
       where enrolment_id = $1 and kind = 'LESSON' and ref = $2
         and schedule_id = (select id from public.academy_schedules where enrolment_id = $1 and superseded_at is null)`,
      [enrolmentId, lessonRef, offset],
    );
    await q(
      "alter table public.academy_schedule_items enable trigger guard_history",
    );
  };

  it("reads persisted Academy mastery in the reviewed capability shape", async () => {
    const enrolment = enrolments[learnerA.id];
    const objective = (
      await q(
        `select o.id from public.lesson_objectives o join public.academy_professor_classrooms c
         on c.lesson_id = o.lesson_id where c.id = $1 order by o.position limit 1`,
        [classroomA],
      )
    ).rows[0].id as string;
    const evidence = (
      await q(
        `insert into public.academy_objective_evidence(enrolment_id, objective_id, source_kind, source_id,
           evidence_kind, result, marks, max_marks)
         values ($1, $2, 'ASSESSMENT_ATTEMPT', gen_random_uuid(), 'RETRIEVAL_CHECK', 'CORRECT', 1, 1) returning id`,
        [enrolment, objective],
      )
    ).rows[0].id as string;
    await q(
      `insert into public.academy_objective_mastery(enrolment_id, objective_id, state, evidence_count,
         correct_evidence_count, correct_session_count, correct_kind_count, last_evidence_id, policy_version)
       values ($1, $2, 'DEVELOPING', 1, 1, 1, 1, $3, 'MASTERY_V1')`,
      [enrolment, objective, evidence],
    );
    const release = await rpc<{ release_id: string }>(
      q,
      learnerA,
      "begin_academic_content_release",
      [randomUUID(), "get_current_mastery_state", "PROFESSOR_READ_V2"],
    );
    const read = await rpc<{ ok: boolean; data: unknown }>(
      q,
      learnerA,
      "read_my_academy_professor_context",
      [release.release_id, classroomA, "get_current_mastery_state"],
    );
    expect(read.ok).toBe(true);
    const parsed = capabilitySchemas.get_current_mastery_state.output.parse(
      read.data,
    );
    expect(parsed.records).toEqual([
      expect.objectContaining({
        objectiveId: objective,
        state: "DEVELOPING",
        policyVersion: "MASTERY_V1",
        evidenceCount: 1,
      }),
    ]);
    await rpc(q, learnerA, "close_academic_content_release", [
      release.release_id,
      false,
    ]);
  });

  it("terminalises an execution refused after AUTHORIZE, so it never blocks the next request", async () => {
    const classroom = await classroomOf(learnerC);
    const enrolment = enrolments[learnerC.id];
    // The timetable withdraws the lesson between AUTHORIZE and provenance.
    m.hook = async (name) => {
      if (name !== "record_my_academy_professor_provenance") return;
      m.hook = null;
      await lessonStartsAt(enrolment, "1 day");
    };
    const refused = stub();
    expect(await run(learnerC, classroom, refused)).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    m.hook = null;
    expect(refused.requests).toHaveLength(0);
    expect(
      (
        await q(
          `select x.state, x.reason_code, exists (select 1 from public.academic_provider_execution_usage u
             where u.execution_id = x.id) has_usage
           from public.academic_provider_executions x where x.student_id = $1`,
          [learnerC.id],
        )
      ).rows,
    ).toEqual([
      { state: "FAILED", reason_code: "POLICY_BLOCKED", has_usage: false },
    ]);
    // Immediately afterwards (well inside the 20-second expiry) the next
    // request is admitted: nothing is left AUTHORIZED.
    await lessonStartsAt(enrolment, "-3 hours");
    expect(await run(learnerC, classroom, stub())).toMatchObject({
      outcome: "SUCCEEDED",
    });
    expect(
      await count(
        `select count(*)::int n from public.academic_provider_executions
         where student_id = $1 and state in ('AUTHORIZED','RUNNING')`,
        [learnerC.id],
      ),
    ).toBe(0);
  });

  it("bounds reservations per classroom without breaking replay", async () => {
    const classroom = await classroomOf(learnerC);
    const results = [];
    for (let i = 0; i < 21; i++)
      results.push(
        await rpc<{ ok: boolean; code?: string }>(
          q,
          learnerC,
          "reserve_my_academy_professor_interaction",
          [classroom, `burst-${i}`],
        ),
      );
    expect(results.slice(0, 20).every((r) => r.ok)).toBe(true);
    expect(results[20]).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(
      await rpc(q, learnerC, "reserve_my_academy_professor_interaction", [
        classroom,
        "burst-0",
      ]),
    ).toEqual({ ok: true, duplicate: true });
  });

  it("never lets the cohort protocol cite an Academy execution or release", async () => {
    const execution = (
      await q(
        "select execution_id from public.academy_professor_execution_provenance limit 1",
      )
    ).rows[0].execution_id as string;
    await expect(
      q(
        "insert into public.academic_agent_execution_provenance(execution_kind, professor_execution_id) values ('PROFESSOR_PROVIDER_V2', $1)",
        [execution],
      ),
    ).rejects.toThrow(/ACADEMY_EXECUTION_BOUND/);
    const release = (
      await q(
        "select release_id from public.academy_professor_context_reads limit 1",
      )
    ).rows[0].release_id as string;
    await expect(
      q(
        "insert into public.academic_agent_execution_context_releases(professor_execution_id, release_id, capability_name, position) values ($1, $2, 'get_lesson_context', 1)",
        [execution, release],
      ),
    ).rejects.toThrow(/ACADEMY_RELEASE_BOUND/);
  });

  it("discards a reply when access is revoked during the provider call, keeping its real usage", async () => {
    const enrolment = enrolments[learnerA.id];
    const entitlement = (
      await q(
        "select entitlement_id from public.academy_enrolments where id = $1",
        [enrolment],
      )
    ).rows[0].entitlement_id as string;
    const turnsBefore = await count(
      "select count(*)::int n from public.academy_professor_classroom_turns where classroom_id = $1",
      [classroomA],
    );
    const adapter: ProviderAdapter = {
      name: "revoking-stub",
      async generate() {
        // A refund lands while the Professor is answering.
        await rpc(q, people.admin, "admin_revoke_academy_entitlement", [
          entitlement,
          "Refund during an AI class (acceptance test)",
        ]);
        return {
          outputText: "This reply must not reach a revoked learner.",
          usage: {
            inputTokens: 80,
            outputTokens: 30,
            estimatedCostMicrousd: 70,
          },
        };
      },
    };
    const startedAt = (await q("select clock_timestamp() t")).rows[0].t;
    const result = await run(learnerA, classroomA, adapter);
    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "POLICY_BLOCKED",
    });
    expect(result.usage.providerCalls).toBe(1);
    const last = (
      await q(
        `select x.state, x.reason_code, u.provider_calls, u.output_tokens
         from public.academic_provider_executions x join public.academic_provider_execution_usage u on u.execution_id = x.id
         where x.student_id = $1 order by x.created_at desc limit 1`,
        [learnerA.id],
      )
    ).rows[0];
    expect(last).toEqual({
      state: "FAILED",
      reason_code: "POLICY_BLOCKED",
      provider_calls: 1,
      output_tokens: 30,
    });
    expect(
      await count(
        "select count(*)::int n from public.academy_professor_classroom_turns where classroom_id = $1",
        [classroomA],
      ),
    ).toBe(turnsBefore);
    expect(
      await count(
        `select count(*)::int n from public.academic_content_releases
         where student_id = $1 and started_at >= $2 and state <> 'ABORTED'`,
        [learnerA.id, startedAt],
      ),
    ).toBe(0);
  });
});
