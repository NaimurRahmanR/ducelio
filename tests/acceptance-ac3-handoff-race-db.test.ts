import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tutorLabFixture,
  asExecutionUser,
  learner,
  administrator,
  type TutorLabFixture,
} from "./tutor-lab-fixture";
import { learnerAuth } from "./execution-fixture";

// SQL-validity check of the AC-3 acceptance scenario's REAL statements
// (scripts/acceptance/ac3-handoff-race.mjs) against the real migration
// chain in PGlite: the direct fixture seed satisfies every FK/CHECK and the
// RPC's own source verification; the authenticated-learner context
// (request-JWT GUCs + SET LOCAL ROLE authenticated) resolves to the learner;
// the governed RPC creates then replays; the verification reads find
// exactly one projection and one delivery handoff.
//
// PGlite is ONE connection, so the two requests here run SEQUENTIALLY. This
// is NOT concurrency evidence of any kind; only the hosted run of
// POSTGRES_CONCURRENCY:AC3_PROFESSOR_HANDOFF_DUPLICATE can provide that.

let f: TutorLabFixture;
let classSessionId: string;
let ac3: typeof import("../scripts/acceptance/ac3-handoff-race.mjs");

const client = () => ({
  query: (sql: string, params?: unknown[]) => f.db.query(sql, params),
});

beforeAll(async () => {
  ac3 = await import("../scripts/acceptance/ac3-handoff-race.mjs");
  f = await tutorLabFixture();
  await asExecutionUser(f.db, 2);
  const start = new Date(Date.now() - 3 * 24 * 3600_000);
  classSessionId = (
    await f.db.query<{ v: string }>(
      "select public.create_class_session($1,$2,$3,$4,$5,'AC-3 acceptance SQL check') as v",
      [
        f.cohortId,
        f.lessonId,
        administrator,
        start.toISOString(),
        new Date(start.getTime() + 5 * 60_000).toISOString(),
      ],
    )
  ).rows[0].v;
  await asExecutionUser(f.db, 1);
  expect(
    (
      await f.db.query<{ v: { ok: boolean } }>(
        "select public.open_professor_classroom($1) as v",
        [classSessionId],
      )
    ).rows[0].v,
  ).toMatchObject({ ok: true });
  await f.db.exec("reset role");
}, 180000);
afterAll(async () => {
  await f.db?.close();
});

describe("AC-3 acceptance scenario SQL (sequential, single connection)", () => {
  it("seeds a real-shaped source the RPC accepts, then creates once and replays once through the authenticated RPC", async () => {
    await f.db.exec("reset role");
    const seeded = await ac3.seedProfessorExecutionFixture(client(), {
      studentId: learner,
      classSessionId,
    });
    // The seeded provenance matches the frozen AC-2 binding and fingerprint.
    expect(
      (
        await f.db.query(
          "select p.behaviour_version, p.institutional_baseline_version, p.behaviour_fingerprint = agent_behaviour_private.behaviour_fingerprint(p.programme_version_id) as fp, x.state from public.academic_agent_execution_provenance p join public.academic_provider_executions x on x.id=p.professor_execution_id where x.id=$1",
          [seeded.executionId],
        )
      ).rows[0],
    ).toEqual({
      behaviour_version: "PROFESSOR_BEHAVIOUR_V1",
      institutional_baseline_version: "DUCELIO_INSTITUTIONAL_BASELINE_V1",
      fp: true,
      state: "SUCCEEDED",
    });
    const fixture = {
      runId: "ac3-sql-check",
      learnerAuthUserId: learnerAuth(1),
      studentId: learner,
      enrolmentId: f.learnerEnrolmentId,
      programmeVersionId: f.programmeVersionId,
      classSessionId,
      classroomId: seeded.classroomId,
      lessonId: f.lessonId,
      objectiveId: f.objectiveId,
      sourceExecutionId: seeded.executionId,
    };
    const raceStartedAt = (
      await f.db.query<{ t: string }>("select clock_timestamp() as t")
    ).rows[0].t;
    const results = [];
    for (let i = 0; i < 2; i++) {
      await f.db.exec("reset role");
      await ac3.prepareAuthenticatedLearner(client(), fixture);
      results.push(await ac3.callHandoffRpcAndCommit(client(), fixture));
      // SET LOCAL ROLE ended with the transaction.
      expect(
        (await f.db.query<{ r: string }>("select current_user::text as r"))
          .rows[0].r,
      ).not.toBe("authenticated");
    }
    expect(results[0]).toMatchObject({ ok: true, duplicate: false });
    expect(results[1]).toEqual({
      ok: true,
      duplicate: true,
      handoffId: results[0].handoffId,
    });
    const verification = await ac3.queryAc3Verification(
      client(),
      fixture,
      raceStartedAt,
    );
    // The fixture's pre-existing ordinary handoff for the same objective is
    // not attributed to this run.
    expect(verification.deliveryRows).toHaveLength(1);
    // Synthetic distinct pids: this sequential run only checks that the
    // classifier accepts what the real SQL produces.
    expect(
      ac3.classifyAc3Race({
        pids: [1, 2],
        settled: results.map((value) => ({ status: "fulfilled", value })),
        verification,
        fixture,
      }).status,
    ).toBe("PASS");
  });

  it("refuses (BLOCKED) a context whose JWT subject is not the acceptance learner, and leaves no transaction open", async () => {
    await f.db.exec("reset role");
    await expect(
      ac3.prepareAuthenticatedLearner(client(), {
        learnerAuthUserId: learnerAuth(3),
        studentId: learner,
      }),
    ).rejects.toBeInstanceOf(ac3.Ac3ContextUnavailable);
    expect(
      (await f.db.query<{ r: string }>("select current_user::text as r"))
        .rows[0].r,
    ).not.toBe("authenticated");
  });
});
