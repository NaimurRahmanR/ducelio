import { createHmac, randomUUID } from "node:crypto";
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
  tutorLabFixture,
  asExecutionUser,
  learner,
  administrator,
  type TutorLabFixture,
} from "./tutor-lab-fixture";
import { openExecutionRelease } from "./execution-fixture";
import {
  signedProviderCommand,
  sendProviderCommand,
} from "./provider-execution-fixture";

// AC-3 correction: a programme version published BEFORE migration 052 is
// frozen (AC-2 binding) on TUTOR_BEHAVIOUR_V1 / LAB_INSTRUCTOR_BEHAVIOUR_V1,
// whose runtime never reads a Professor record. The database must therefore
// refuse a Professor academic handoff for it, before anything is written,
// while its ordinary learner Tutor/Lab handoffs keep working. The fixture
// publishes through the real publication trigger while the database runs
// migration 051's own role-version definition (read from that file). Every
// test runs inside its own rolled-back transaction.

let f: TutorLabFixture;
let session: string;
let sourceExecutionId: string;

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner() {
  await f.db.exec("reset role");
}
const as = (n: number) => asExecutionUser(f.db, n);
const mac = (canonical: string) =>
  createHmac("sha256", f.key).update(canonical, "utf8").digest("hex");

// A real, attested, provenance-bound SUCCEEDED Professor classroom execution
// (migrations 025/051 protocols).
async function succeededProfessorExecution(classSessionId: string) {
  const profileRef = await value<string | null>(
    "select agent_behaviour_private.runtime_profile_ref($1,'PROFESSOR') as v",
    [f.programmeVersionId],
  );
  await as(1);
  const releaseId = (await openExecutionRelease(f.db)).release_id;
  const objectivesReleaseId = (
    await value<{ release_id: string }>(
      "select public.begin_academic_content_release($1,'get_lesson_objectives','PROFESSOR_READ_V2') as v",
      [randomUUID()],
    )
  ).release_id;
  const executionId = randomUUID();
  expect(
    await sendProviderCommand(
      f.db,
      signedProviderCommand(f, {
        executionId,
        releaseId,
        operation: "AUTHORIZE",
        state: "AUTHORIZED",
      }),
    ),
  ).toMatchObject({ ok: true });
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const manifest = [
    ["get_lesson_context", releaseId],
    ["get_lesson_objectives", objectivesReleaseId],
  ];
  const canonical = [
    "DUCELIO_AGENT_PROVENANCE_HMAC_SHA256_V1",
    "PROFESSOR",
    f.keyId,
    learner,
    executionId,
    releaseId,
    classSessionId,
    manifest.map(([c, r]) => `${c}:${r}`).join(","),
    profileRef ?? "NONE",
    "DUCELIO_INSTITUTIONAL_BASELINE_V1",
    "PROFESSOR_BEHAVIOUR_V1",
    "AGENT_BEHAVIOUR_DEFAULT_V1",
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  expect(
    await value(
      "select public.record_professor_execution_provenance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as v",
      [
        f.keyId,
        executionId,
        releaseId,
        classSessionId,
        manifest.map(([c]) => c),
        manifest.map(([, r]) => r),
        profileRef,
        "DUCELIO_INSTITUTIONAL_BASELINE_V1",
        "PROFESSOR_BEHAVIOUR_V1",
        "AGENT_BEHAVIOUR_DEFAULT_V1",
        issuedAt,
        expiresAt,
        mac(canonical),
      ],
    ),
  ).toEqual({ ok: true });
  const zero = { maxCalls: 0, maxOutput: 0, maxCost: 0 };
  expect(
    await sendProviderCommand(
      f.db,
      signedProviderCommand(f, {
        executionId,
        releaseId,
        operation: "START",
        state: "RUNNING",
        ...zero,
      }),
    ),
  ).toMatchObject({ ok: true });
  for (const id of [objectivesReleaseId, releaseId])
    await f.db.query("select public.close_academic_content_release($1,true)", [
      id,
    ]);
  expect(
    await sendProviderCommand(
      f.db,
      signedProviderCommand(f, {
        executionId,
        releaseId,
        operation: "FINALIZE",
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        ...zero,
        calls: 1,
        attempts: 1,
        input: 100,
        output: 50,
        cost: 1000,
        elapsed: 100,
      }),
    ),
  ).toMatchObject({ ok: true, execution: { state: "SUCCEEDED" } });
  await owner();
  return executionId;
}

beforeAll(async () => {
  f = await tutorLabFixture({ publishBeforeMigration052: true });
  await owner();
  session = await value<string>(
    "insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,created_by) values($1,$2,$3,$4,clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes',$4) returning id as v",
    [f.cohortId, f.programmeVersionId, f.lessonId, administrator],
  );
  await as(1);
  expect(
    await value("select public.open_professor_classroom($1) as v", [session]),
  ).toMatchObject({ ok: true });
  await owner();
  sourceExecutionId = await succeededProfessorExecution(session);
}, 180000);
beforeEach(async () => {
  await owner();
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});

const counts = async () => {
  await owner();
  return value<{ delivery: number; professor: number }>(
    "select jsonb_build_object('delivery',(select count(*) from public.delivery_handoffs),'professor',(select count(*) from public.professor_academic_handoffs)) as v",
  );
};

describe("a programme version published before migration 052 (Tutor/Lab pinned V1)", () => {
  it("is genuinely frozen on V1 for Tutor and Lab, and has a real SUCCEEDED provenance-bound Professor execution", async () => {
    await owner();
    expect(
      (
        await f.db.query<{ role: string; behaviour_version: string }>(
          "select role,behaviour_version from public.academic_agent_behaviour_bindings where programme_version_id=$1 order by role",
          [f.programmeVersionId],
        )
      ).rows,
    ).toEqual([
      {
        role: "LAB_INSTRUCTOR",
        behaviour_version: "LAB_INSTRUCTOR_BEHAVIOUR_V1",
      },
      { role: "PROFESSOR", behaviour_version: "PROFESSOR_BEHAVIOUR_V1" },
      { role: "TUTOR", behaviour_version: "TUTOR_BEHAVIOUR_V1" },
    ]);
    // The frozen V1 bindings verify (the AC-2 resolver accepts them).
    for (const role of ["TUTOR", "LAB_INSTRUCTOR"])
      expect(
        await value(
          "select agent_behaviour_private.effective_behaviour($1,$2) as v",
          [f.programmeVersionId, role],
        ),
      ).toMatchObject({ ok: true, state: "BOUND" });
    // The current code version is V2 again after publication: the binding,
    // not the current version, decides.
    expect(
      await value(
        "select agent_behaviour_private.role_behaviour_version('TUTOR') as v",
      ),
    ).toBe("TUTOR_BEHAVIOUR_V2");
    expect(
      await value(
        "select x.state as v from public.academic_provider_executions x join public.academic_agent_execution_provenance p on p.professor_execution_id=x.id join public.professor_classroom_sessions c on c.id=p.classroom_id where x.id=$1 and c.class_session_id=$2",
        [sourceExecutionId, session],
      ),
    ).toBe("SUCCEEDED");
  });

  it("refuses OBJECTIVE_REINFORCEMENT (Tutor pinned V1) before writing anything", async () => {
    const before = await counts();
    await as(1);
    expect(
      await value(
        "select public.request_professor_academic_handoff($1,'OBJECTIVE_REINFORCEMENT',$2,null) as v",
        [session, f.objectiveId],
      ),
    ).toEqual({ ok: false, code: "DESTINATION_BEHAVIOUR_UNSUPPORTED" });
    expect(await counts()).toEqual(before);
  });

  it("refuses PRACTICAL_HELP (Lab Instructor pinned V1) before writing anything", async () => {
    const before = await counts();
    await as(1);
    expect(
      await value(
        "select public.request_professor_academic_handoff($1,'PRACTICAL_HELP',null,$2) as v",
        [session, f.labPracticalId],
      ),
    ).toEqual({ ok: false, code: "DESTINATION_BEHAVIOUR_UNSUPPORTED" });
    expect(await counts()).toEqual(before);
  });

  it("keeps the ordinary learner Tutor and Lab handoff flows working for the same version", async () => {
    const before = await counts();
    await as(1);
    const tutorHandoff = await value<string>(
      "select public.request_delivery_handoff($1,$2,$3,'OBJECTIVE_REINFORCEMENT',$4) as v",
      [f.learnerEnrolmentId, f.lessonId, f.objectiveId, randomUUID()],
    );
    const labHandoff = await value<string>(
      "select public.request_practical_support($1,$2,$3) as v",
      [f.learnerEnrolmentId, f.labPracticalId, randomUUID()],
    );
    for (const handoff of [tutorHandoff, labHandoff]) {
      expect(handoff).toMatch(/^[0-9a-f-]{36}$/);
      // And the Tutor/Lab authority still opens a release for it.
      await as(1);
      expect(
        await value(
          "select public.begin_tutor_lab_content_release($1,$2) as v",
          [randomUUID(), handoff],
        ),
      ).toMatchObject({ ok: true });
    }
    expect(await counts()).toEqual({
      delivery: before.delivery + 2,
      professor: before.professor,
    });
    // The fixture's pre-existing ordinary handoffs are untouched too.
    await as(1);
    expect(
      await value("select public.begin_tutor_lab_content_release($1,$2) as v", [
        randomUUID(),
        f.objectiveReinforcementHandoffId,
      ]),
    ).toMatchObject({ ok: true });
  });

  it("gives the learner's own V1 bindings to the learner-scoped read used by the classroom page", async () => {
    await as(1);
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'TUTOR') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({ ok: true, behaviourVersion: "TUTOR_BEHAVIOUR_V1" });
    expect(
      await value(
        "select public.get_agent_behaviour_for_enrolment($1,'LAB_INSTRUCTOR') as v",
        [f.learnerEnrolmentId],
      ),
    ).toMatchObject({
      ok: true,
      behaviourVersion: "LAB_INSTRUCTOR_BEHAVIOUR_V1",
    });
  });
});
