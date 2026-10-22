import { randomBytes, randomUUID } from "node:crypto";
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

// Migration 063 end to end over the REAL Academy Tutor/Lab runtime
// (executeAcademySupport's test entrypoint), the REAL Tutor/Lab attestation
// transport and migration 028 governance, and the REAL database authority on
// a disposable PGlite database. Only identity, the PostgREST transport and
// the provider (a deterministic stub, no paid AI call) are substituted.
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

import { executeAcademySupportWithTestOverrides } from "@/server/tutor-lab-execution/academy";
import {
  DEFAULT_RUNTIME_BUDGET_POLICY,
  ProviderFailure,
  type ProviderAdapter,
  type RuntimeProviderRequest,
} from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

let db: PGlite;
let q: Query;
const learnerA = people.learnerA as Person;
const learnerB = people.learnerB as Person;
const learnerC = people.learnerC as Person;
const enrolments: Record<string, string> = {};
let lessonRef = "";
let objectiveId = "";
let futureObjective = { lessonRef: "", objectiveId: "" };
let labItem = "";
let labLessonRef = "";
let tutorRequestA = "";
let labRequestA = "";

const profile = (ref: string): RuntimeProfile => ({
  ref,
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: {
    ...DEFAULT_RUNTIME_BUDGET_POLICY,
    maxProviderCalls: 1,
    maxAttempts: 1,
    maxInputContextBytes: 64_000,
  },
});
function stub(
  outcome: "success" | "failure" = "success",
  text = "Let us work through this objective step by step.",
  during?: () => Promise<void>,
) {
  const requests: RuntimeProviderRequest[] = [];
  const adapter: ProviderAdapter & { requests: RuntimeProviderRequest[] } = {
    name: "academy-support-stub",
    requests,
    async generate(request) {
      requests.push(request);
      if (during) await during();
      if (outcome === "failure")
        throw new ProviderFailure("PROVIDER_REFUSED", "stub refusal");
      return {
        outputText: text,
        usage: { inputTokens: 90, outputTokens: 35, estimatedCostMicrousd: 60 },
      };
    },
  };
  return adapter;
}
const ask = (
  person: Person,
  requestId: string,
  adapter: ProviderAdapter,
  message = "Can you explain this with an example?",
  idempotencyKey = randomUUID(),
) => {
  m.person = person;
  return executeAcademySupportWithTestOverrides(
    { requestId, message, idempotencyKey },
    {
      resolveProfile: (ref) =>
        ref === "TUTOR_COMMERCIAL_V1" || ref === "LAB_INSTRUCTOR_COMMERCIAL_V1"
          ? profile(ref)
          : null,
      resolveAdapter: () => adapter,
    },
  );
};
const count = async (sql: string, params: unknown[] = []) =>
  (await q(sql, params)).rows[0].n as number;
const openTutor = (
  person: Person,
  enrolmentId: string,
  ref: string,
  objective: string,
) =>
  rpc<{ ok: boolean; code?: string; requestId?: string; resumed?: boolean }>(
    q,
    person,
    "open_my_academy_tutor_support",
    [enrolmentId, ref, objective],
  );
const openLab = (person: Person, enrolmentId: string, item: string) =>
  rpc<{ ok: boolean; code?: string; requestId?: string; resumed?: boolean }>(
    q,
    person,
    "open_my_academy_lab_support",
    [enrolmentId, item],
  );
const itemFor = async (enrolmentId: string, kind: string, ref: string) =>
  (
    await q(
      `select i.id from public.academy_schedule_items i join public.academy_schedules s on s.id = i.schedule_id
       and s.superseded_at is null where i.enrolment_id = $1 and i.kind = $2 and i.ref = $3 and i.part = 1`,
      [enrolmentId, kind, ref],
    )
  ).rows[0].id as string;
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
  const pkg = approvedTestPackage("academy-tutor-lab-test");
  const course = await publishAcademyCourse(q, "academy-tutor-lab-test", pkg);
  for (const p of [learnerA, learnerB, learnerC]) {
    enrolments[p.id] = await rpc<string>(
      q,
      people.admin,
      "grant_academy_entitlement",
      [course.offerId, p.email, null, "Tutor/Lab acceptance access"],
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
  const lessons = (
    await q(
      `select cl.lesson_ref, (select o.id from public.lesson_objectives o where o.lesson_id = cl.lesson_id
         order by o.position limit 1) objective
       from public.academy_course_lessons cl where cl.course_id = $1 order by cl.sequence`,
      [course.courseId],
    )
  ).rows as { lesson_ref: string; objective: string }[];
  lessonRef = lessons[0].lesson_ref;
  objectiveId = lessons[0].objective;
  futureObjective = {
    lessonRef: lessons.at(-1)!.lesson_ref,
    objectiveId: lessons.at(-1)!.objective,
  };
  // A GRADED practical, so the test proves its rubric and marking
  // guidance never reach the Lab Instructor.
  const graded = (pkg.labs as { activityRef: string; graded: boolean }[]).find(
    (l) => l.graded,
  )!;
  labLessonRef = (
    pkg.curriculum.modules.flatMap(
      (mm: { lessons: unknown[] }) => mm.lessons,
    ) as { key: string; practicalActivities?: { key: string }[] }[]
  ).find((l) =>
    l.practicalActivities?.some((a) => a.key === graded.activityRef),
  )!.key;
  labItem = await itemFor(enrolments[learnerA.id], "LAB", graded.activityRef);
  for (const p of [learnerA, learnerB, learnerC]) {
    await releaseNow(q, enrolments[p.id], "LESSON", lessonRef);
    await releaseNow(q, enrolments[p.id], "LESSON", labLessonRef);
  }
}, 240000);
afterAll(async () => {
  await db?.close();
});

describe("Academy AI Tutor", () => {
  it("opens only for an objective of a released lesson of the learner's own course", async () => {
    const own = enrolments[learnerA.id];
    expect(
      await openTutor(
        learnerA,
        own,
        futureObjective.lessonRef,
        futureObjective.objectiveId,
      ),
    ).toEqual({ ok: false, code: "NOT_RELEASED" });
    // An objective of a different lesson is refused under this lesson.
    expect(
      await openTutor(learnerA, own, lessonRef, futureObjective.objectiveId),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(
      await openTutor(learnerB, own, lessonRef, objectiveId),
    ).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const first = await openTutor(learnerA, own, lessonRef, objectiveId);
    expect(first).toMatchObject({ ok: true, resumed: false });
    tutorRequestA = first.requestId!;
    expect(await openTutor(learnerA, own, lessonRef, objectiveId)).toEqual({
      ok: true,
      requestId: tutorRequestA,
      resumed: true,
    });
  });

  it("teaches through the existing governed Tutor execution and records the exchange", async () => {
    const adapter = stub();
    const cohortProvenance = await count(
      "select count(*)::int n from public.academic_agent_execution_provenance",
    );
    expect(await ask(learnerA, tutorRequestA, adapter)).toEqual({
      status: "SUCCEEDED",
      text: "Let us work through this objective step by step.",
      role: "TUTOR",
      record: "RECORDED",
    });
    expect(adapter.requests).toHaveLength(1);
    const sent = JSON.stringify(adapter.requests[0]);
    const objective = (
      await q(
        "select description from public.lesson_objectives where id = $1",
        [objectiveId],
      )
    ).rows[0].description as string;
    expect(sent).toContain(JSON.stringify(objective).slice(1, -1));
    expect(sent).toContain("OBJECTIVE_REINFORCEMENT");
    expect(sent).toContain("Can you explain this with an example?");
    expect(sent).not.toMatch(
      /answerKey|correctOptionId|markingGuidance|rubric/i,
    );
    const execution = (
      await q(
        `select x.agent_profile, x.state, x.reason_code, u.provider_calls, u.output_tokens, u.estimated_cost_microusd,
           r.state release_state, r.academy_request_id, r.enrolment_id, r.handoff_id
         from public.tutor_lab_provider_executions x
         join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id
         join public.tutor_lab_content_releases r on r.id = x.release_id
         where x.student_id = $1`,
        [learnerA.id],
      )
    ).rows;
    expect(execution).toEqual([
      {
        agent_profile: "TUTOR",
        state: "SUCCEEDED",
        reason_code: "PROVIDER_COMPLETE",
        provider_calls: 1,
        output_tokens: 35,
        estimated_cost_microusd: 60,
        release_state: "COMPLETED",
        academy_request_id: tutorRequestA,
        enrolment_id: null,
        handoff_id: null,
      },
    ]);
    expect(
      await count(
        "select count(*)::int n from public.academy_support_execution_provenance where request_id = $1",
        [tutorRequestA],
      ),
    ).toBe(1);
    // Cohort provenance is never written for an Academy execution.
    expect(
      await count(
        "select count(*)::int n from public.academic_agent_execution_provenance",
      ),
    ).toBe(cohortProvenance);
    expect(
      await count(
        `select count(*)::int n from public.audit_events where action = 'TUTOR_LAB_RELEASE_COMPLETED'
           and after_state->>'academy_request_id' = $1`,
        [tutorRequestA],
      ),
    ).toBe(1);
    const turns = await rpc<{ ok: boolean; totalTurns: number }>(
      q,
      learnerA,
      "list_my_academy_support_turns",
      [tutorRequestA, 50],
    );
    expect(turns).toMatchObject({ ok: true, totalTurns: 1 });
  });

  it("refuses a duplicate submission before any provider call", async () => {
    const adapter = stub();
    const keyOnce = randomUUID();
    expect(
      await ask(learnerA, tutorRequestA, adapter, "Same question", keyOnce),
    ).toMatchObject({ status: "SUCCEEDED" });
    expect(
      await ask(learnerA, tutorRequestA, adapter, "Same question", keyOnce),
    ).toEqual({ status: "DUPLICATE" });
    // The same key with a different message is a conflict, never a new call.
    expect(
      await ask(learnerA, tutorRequestA, adapter, "Different text", keyOnce),
    ).toEqual({ status: "UNAVAILABLE" });
    expect(adapter.requests).toHaveLength(1);
  });

  it("records a provider failure truthfully, with its usage and no exchange", async () => {
    const before = await count(
      "select count(*)::int n from public.academy_support_turns where request_id = $1",
      [tutorRequestA],
    );
    expect(await ask(learnerA, tutorRequestA, stub("failure"))).toEqual({
      status: "RETRY_LATER",
    });
    const failed = (
      await q(
        `select x.state, x.reason_code, u.provider_calls from public.tutor_lab_provider_executions x
         join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id
         where x.student_id = $1 and x.state <> 'SUCCEEDED'`,
        [learnerA.id],
      )
    ).rows;
    expect(failed).toEqual([
      { state: "FAILED", reason_code: "PROVIDER_REFUSED", provider_calls: 1 },
    ]);
    expect(
      await count(
        "select count(*)::int n from public.academy_support_turns where request_id = $1",
        [tutorRequestA],
      ),
    ).toBe(before);
  });
});

describe("Academy AI Lab Instructor", () => {
  it("opens only from the learner's own started practical session", async () => {
    const own = enrolments[learnerA.id];
    expect(await openLab(learnerA, own, labItem)).toEqual({
      ok: false,
      code: "NOT_YET_STARTED",
    });
    const lessonItem = await itemFor(own, "LESSON", lessonRef);
    expect(await openLab(learnerA, own, lessonItem)).toEqual({
      ok: false,
      code: "NOT_A_PRACTICAL",
    });
    for (const p of [learnerA, learnerB, learnerC])
      await releaseNow(q, enrolments[p.id], "LAB");
    expect(await openLab(learnerB, enrolments[learnerB.id], labItem)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    const first = await openLab(learnerA, own, labItem);
    expect(first).toMatchObject({ ok: true, resumed: false });
    labRequestA = first.requestId!;
  });

  it("guides the practical from its instructions and objectives, never its rubric", async () => {
    const adapter = stub("success", "Start by listing what you know.");
    expect(await ask(learnerA, labRequestA, adapter)).toMatchObject({
      status: "SUCCEEDED",
      role: "LAB_INSTRUCTOR",
      record: "RECORDED",
    });
    const sent = JSON.stringify(adapter.requests[0]);
    expect(sent).toContain("PRACTICAL_HELP");
    expect(sent).toContain('"role":"LAB_INSTRUCTOR"');
    expect(sent).not.toContain("TEST-ONLY synthetic criterion");
    expect(sent).not.toContain("TEST-ONLY synthetic marking guidance");
    expect(sent).not.toMatch(/markingGuidance|rubric|maxMarks/);
    const view = await rpc<{
      ok: boolean;
      request: { practical: { instructions: string }; graded: boolean };
    }>(q, learnerA, "get_my_academy_support_request", [labRequestA]);
    expect(view.ok).toBe(true);
    expect(view.request.graded).toBe(true);
    expect(sent).toContain(
      JSON.stringify(view.request.practical.instructions).slice(1, 40),
    );
  });

  it("writes no grade, mastery, progress, submission or completion", async () => {
    for (const table of [
      "academy_objective_evidence",
      "academy_objective_mastery",
      "academy_lesson_progress",
      "academy_lab_submissions",
      "academy_lab_marks",
      "academy_assessment_attempts",
      "academy_completions",
    ])
      expect(
        await count(`select count(*)::int n from public.${table}`),
        table,
      ).toBe(0);
  });
});

describe("refusals and isolation", () => {
  it("never serves another learner's request or reuses a consumed release", async () => {
    const adapter = stub();
    expect(await ask(learnerB, tutorRequestA, adapter)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(adapter.requests).toHaveLength(0);
    for (const [fn, args] of [
      ["get_my_academy_support_request", [tutorRequestA]],
      ["list_my_academy_support_turns", [tutorRequestA, 10]],
      ["begin_my_academy_support_release", [randomUUID(), tutorRequestA]],
    ] as const)
      expect(await rpc(q, learnerB, fn, [...args])).toEqual({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
      });
    expect(
      await count(
        "select count(*)::int n from public.tutor_lab_provider_executions where student_id = $1",
        [learnerB.id],
      ),
    ).toBe(0);
    // A release reads its context once only.
    const grant = await rpc<{ ok: boolean; release_id: string }>(
      q,
      learnerA,
      "begin_my_academy_support_release",
      [randomUUID(), tutorRequestA],
    );
    expect(grant.ok).toBe(true);
    expect(
      await rpc(q, learnerA, "read_my_academy_support_context", [
        grant.release_id,
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await rpc(q, learnerA, "read_my_academy_support_context", [
        grant.release_id,
      ]),
    ).toEqual({ ok: false, code: "CONTENT_RELEASE_UNAVAILABLE" });
    // The cohort close path can never complete an Academy release.
    expect(
      await rpc(q, learnerA, "close_tutor_lab_content_release", [
        grant.release_id,
        true,
      ]),
    ).toMatchObject({ ok: true, state: "ABORTED" });
    // The release table admits exactly one source per row.
    await expect(
      q(
        `insert into public.tutor_lab_content_releases(student_id, invocation_id, agent_profile, lesson_id, state,
           started_at, expires_at) values ($1, gen_random_uuid(), 'TUTOR',
           (select lesson_id from public.academy_support_requests where id = $2), 'ACTIVE', now(), now() + interval '30 seconds')`,
        [learnerA.id, tutorRequestA],
      ),
    ).rejects.toThrow(/tutor_lab_content_releases_source/);
    await expect(
      as(q, learnerA, "select * from public.academy_support_turns"),
    ).rejects.toThrow();
  });

  it("blocks Tutor and Lab help during a controlled assessment", async () => {
    const enrolment = enrolments[learnerC.id];
    const opened = await openTutor(learnerC, enrolment, lessonRef, objectiveId);
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
    expect(await ask(learnerC, opened.requestId!, adapter)).toEqual({
      status: "ACTIVITY_BLOCKED",
    });
    expect(adapter.requests).toHaveLength(0);
    expect(
      await openLab(
        learnerC,
        enrolment,
        await itemFor(
          enrolment,
          "LAB",
          (
            await q(
              "select practical_key from public.academy_support_requests where id = $1",
              [labRequestA],
            )
          ).rows[0].practical_key as string,
        ),
      ),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
    for (const [fn, args] of [
      ["get_my_academy_support_agent", [enrolment, "TUTOR"]],
      ["list_my_academy_support_turns", [opened.requestId, 10]],
    ] as const)
      expect(await rpc(q, learnerC, fn, [...args])).toEqual({
        ok: false,
        code: "ACTIVITY_BLOCKED",
      });
    expect(
      await count(
        "select count(*)::int n from public.tutor_lab_provider_executions where student_id = $1",
        [learnerC.id],
      ),
    ).toBe(0);
    await rpc(q, learnerC, "submit_my_academy_attempt", [started.attemptId]);
  });

  it("discards a reply when access is revoked during the provider call, keeping its real usage", async () => {
    const entitlement = (
      await q(
        "select entitlement_id from public.academy_enrolments where id = $1",
        [enrolments[learnerA.id]],
      )
    ).rows[0].entitlement_id as string;
    const turnsBefore = await count(
      "select count(*)::int n from public.academy_support_turns where request_id = $1",
      [labRequestA],
    );
    const adapter = stub(
      "success",
      "This must not reach a revoked learner.",
      () =>
        rpc(q, people.admin, "admin_revoke_academy_entitlement", [
          entitlement,
          "Refund during AI Lab help (acceptance test)",
        ]).then(() => undefined),
    );
    expect(await ask(learnerA, labRequestA, adapter)).toEqual({
      status: "UNAVAILABLE",
    });
    const last = (
      await q(
        `select x.state, x.reason_code, u.provider_calls, u.output_tokens, r.state release_state
         from public.tutor_lab_provider_executions x
         join public.tutor_lab_provider_execution_usage u on u.execution_id = x.id
         join public.tutor_lab_content_releases r on r.id = x.release_id
         where x.student_id = $1 order by x.created_at desc limit 1`,
        [learnerA.id],
      )
    ).rows[0];
    expect(last).toEqual({
      state: "FAILED",
      reason_code: "CONTENT_RELEASE_UNAVAILABLE",
      provider_calls: 1,
      output_tokens: 35,
      release_state: "ABORTED",
    });
    expect(
      await count(
        "select count(*)::int n from public.academy_support_turns where request_id = $1",
        [labRequestA],
      ),
    ).toBe(turnsBefore);
    // Afterwards nothing opens, and the history stays.
    expect(
      await openTutor(
        learnerA,
        enrolments[learnerA.id],
        lessonRef,
        objectiveId,
      ),
    ).toEqual({ ok: false, code: "ACCESS_REVOKED" });
    expect(await ask(learnerA, tutorRequestA, stub())).toEqual({
      status: "UNAVAILABLE",
    });
    expect(
      await count(
        "select count(*)::int n from public.academy_support_requests where learner_id = $1",
        [learnerA.id],
      ),
    ).toBe(2);
  });
});
