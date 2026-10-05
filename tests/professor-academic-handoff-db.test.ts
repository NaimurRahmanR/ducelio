import { createHash, createHmac, randomUUID } from "node:crypto";
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
import {
  PROFESSOR_HANDOFF_SUMMARY,
  learnerProfessorHandoffSchema,
  professorTeachingRecordSchema,
} from "@/domain/professor-academic-handoff";

// AC-3 / migration 202610050052 against the real migration chain: the
// minimum-data Professor academic handoff (creation, learner visibility and
// Tutor/Lab consumption). PGlite is single-connection: idempotency here is
// sequential replay evidence, never proof of multi-connection behaviour.
// Every test runs inside its own rolled-back transaction.

let f: TutorLabFixture;
let liveSession: string; // classroom with a SUCCEEDED Professor execution
let emptySession: string; // classroom with no Professor execution
let failedSession: string; // classroom with only a FAILED execution
let sourceExecutionId: string;
let profileRef: string | null;

const LEARNER_SENTINEL = "LEARNER-QUESTION-SENTINEL-7Q";
const PROFESSOR_SENTINEL = "PROFESSOR-ANSWER-SENTINEL-9P";

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0]?.v as T;
}
async function owner() {
  await f.db.exec("reset role");
}
const as = (n: number) => asExecutionUser(f.db, n);
const mac = (canonical: string) =>
  createHmac("sha256", f.key).update(canonical, "utf8").digest("hex");
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
function window() {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { issuedAt, expiresAt: issuedAt + 10 };
}

// A real, attested, provenance-bound Professor classroom execution through
// the migration-025/051 protocols, finalized in the given state.
async function professorExecution(
  classSessionId: string,
  final: "SUCCEEDED" | "FAILED",
): Promise<string> {
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
  const { issuedAt, expiresAt } = window();
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
        state: final,
        reason: final === "SUCCEEDED" ? "PROVIDER_COMPLETE" : "PROVIDER_ERROR",
        ...zero,
        calls: 1,
        attempts: 1,
        input: 100,
        output: 50,
        cost: 1000,
        elapsed: 100,
      }),
    ),
  ).toMatchObject({ ok: true, execution: { state: final } });
  return executionId;
}

async function recordTurn(executionId: string, classSessionId: string) {
  const { issuedAt, expiresAt } = window();
  const canonical = [
    "DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1",
    "PROFESSOR",
    f.keyId,
    learner,
    executionId,
    classSessionId,
    "LEARNER_QUESTION",
    sha(LEARNER_SENTINEL),
    sha(PROFESSOR_SENTINEL),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  expect(
    await value(
      "select public.record_professor_classroom_turn($1,$2,$3,'LEARNER_QUESTION',$4,$5,$6,$7,$8) as v",
      [
        f.keyId,
        executionId,
        classSessionId,
        LEARNER_SENTINEL,
        PROFESSOR_SENTINEL,
        issuedAt,
        expiresAt,
        mac(canonical),
      ],
    ),
  ).toMatchObject({ ok: true });
}

async function classSession(live: boolean) {
  await owner();
  return value<string>(
    `insert into public.class_sessions(cohort_id,programme_version_id,lesson_id,instructor_id,scheduled_start,scheduled_end,created_by) values($1,$2,$3,$4,${
      live
        ? "clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes'"
        : "clock_timestamp()-interval '3 hours',clock_timestamp()-interval '2 hours'"
    },$4) returning id as v`,
    [f.cohortId, f.programmeVersionId, f.lessonId, administrator],
  );
}

beforeAll(async () => {
  f = await tutorLabFixture();
  await owner();
  profileRef = await value<string | null>(
    "select agent_behaviour_private.runtime_profile_ref($1,'PROFESSOR') as v",
    [f.programmeVersionId],
  );
  liveSession = await classSession(true);
  emptySession = await classSession(false);
  failedSession = await classSession(false);
  await as(1);
  for (const s of [liveSession, emptySession, failedSession])
    expect(
      await value("select public.open_professor_classroom($1) as v", [s]),
    ).toMatchObject({ ok: true });
  await professorExecution(failedSession, "FAILED");
  sourceExecutionId = await professorExecution(liveSession, "SUCCEEDED");
  await as(1);
  await recordTurn(sourceExecutionId, liveSession);
  await owner();
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

const requestSql =
  "select public.request_professor_academic_handoff($1,$2,$3,$4) as v";
type CreateResult = {
  ok: boolean;
  code?: string;
  duplicate?: boolean;
  handoffId?: string;
};
async function request(
  args: [string, string | null, string | null, string | null],
  n = 1,
) {
  await as(n);
  const result = await value<CreateResult>(requestSql, args);
  await owner();
  return result;
}
const tutorRequest = (session = liveSession) =>
  request([session, "OBJECTIVE_REINFORCEMENT", f.objectiveId, null]);
const labRequest = (practical = f.labPracticalId) =>
  request([liveSession, "PRACTICAL_HELP", null, practical]);
async function link(handoffId: string) {
  await owner();
  return (
    await f.db.query<Record<string, unknown>>(
      "select * from public.professor_academic_handoffs where handoff_id=$1",
      [handoffId],
    )
  ).rows[0];
}
async function openTutorLabRelease(handoffId: string, n = 1) {
  await as(n);
  const result = await value<{
    ok: boolean;
    release_id: string;
    code?: string;
  }>("select public.begin_tutor_lab_content_release($1,$2) as v", [
    randomUUID(),
    handoffId,
  ]);
  return result;
}
async function recordFor(releaseId: string, n = 1) {
  await as(n);
  const result = await value<Record<string, unknown>>(
    "select public.get_professor_academic_handoff_for_release($1) as v",
    [releaseId],
  );
  await owner();
  return result;
}
async function refused(sql: string, args: unknown[], message: string) {
  await f.db.exec("savepoint refusal");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await f.db.exec("rollback to savepoint refusal; release savepoint refusal");
  }
}

describe("creation", () => {
  it("lets the owning learner create a minimum-data Tutor handoff from a verified SUCCEEDED Professor execution", async () => {
    const result = await tutorRequest();
    expect(result).toMatchObject({ ok: true, duplicate: false });
    const row = await link(result.handoffId!);
    expect(row).toMatchObject({
      handoff_policy: "PROFESSOR_ACADEMIC_HANDOFF_V1",
      student_id: learner,
      enrolment_id: f.learnerEnrolmentId,
      programme_version_id: f.programmeVersionId,
      class_session_id: liveSession,
      lesson_id: f.lessonId,
      objective_id: f.objectiveId,
      practical_id: null,
      source_role: "PROFESSOR",
      destination_role: "TUTOR",
      reason_code: "OBJECTIVE_REINFORCEMENT",
      source_professor_execution_id: sourceExecutionId,
      summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
      scope_key: `OBJECTIVE:${f.objectiveId}`,
    });
    // The source provenance is the execution's own AC-2 provenance row.
    expect(
      await value(
        "select id as v from public.academic_agent_execution_provenance where professor_execution_id=$1",
        [sourceExecutionId],
      ),
    ).toBe(row.source_provenance_id);
    // The composed delivery handoff is an ordinary, unmodified learner
    // handoff that the existing Tutor authority can consume.
    expect(
      (
        await f.db.query(
          "select initiator_kind,destination_profile,reason_code,lesson_id,objective_id,summary,provenance,status from public.delivery_handoffs where id=$1",
          [result.handoffId],
        )
      ).rows[0],
    ).toEqual({
      initiator_kind: "LEARNER",
      destination_profile: "TUTOR",
      reason_code: "OBJECTIVE_REINFORCEMENT",
      lesson_id: f.lessonId,
      objective_id: f.objectiveId,
      summary: "Learner requests objective reinforcement.",
      provenance: "LEARNER_REQUEST",
      status: "OPEN",
    });
  });

  it("creates a Lab Instructor handoff only for a lab practical of the source lesson", async () => {
    const result = await labRequest();
    expect(result).toMatchObject({ ok: true, duplicate: false });
    expect(await link(result.handoffId!)).toMatchObject({
      destination_role: "LAB_INSTRUCTOR",
      reason_code: "PRACTICAL_HELP",
      practical_id: f.labPracticalId,
      objective_id: null,
      summary: PROFESSOR_HANDOFF_SUMMARY.PRACTICAL_HELP,
    });
    // An exercise (not a lab) and an unknown practical are refused.
    expect(await labRequest(f.exercisePracticalId)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(await labRequest(randomUUID())).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });

  it("is idempotent: a repeated request returns the same handoff and creates nothing new", async () => {
    const first = await tutorRequest();
    const counts = async () =>
      value<string>(
        "select (select count(*) from public.professor_academic_handoffs)::text || '/' || (select count(*) from public.delivery_handoffs)::text as v",
      );
    const before = await counts();
    const second = await tutorRequest();
    expect(second).toEqual({
      ok: true,
      duplicate: true,
      handoffId: first.handoffId,
    });
    expect(await counts()).toBe(before);
  });

  it("refuses a foreign learner, who has no such classroom", async () => {
    expect(
      await request(
        [liveSession, "OBJECTIVE_REINFORCEMENT", f.objectiveId, null],
        3,
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    await owner();
    expect(
      await value(
        "select count(*)::int as v from public.professor_academic_handoffs",
      ),
    ).toBe(0);
  });

  it("requires a real SUCCEEDED Professor execution in that classroom: none, or only a FAILED one, is refused", async () => {
    expect(await tutorRequest(emptySession)).toEqual({
      ok: false,
      code: "NO_SOURCE_EXECUTION",
    });
    expect(await tutorRequest(failedSession)).toEqual({
      ok: false,
      code: "NO_SOURCE_EXECUTION",
    });
    // The failed classroom really has a provenance-bound FAILED execution.
    await owner();
    expect(
      await value(
        "select array_agg(x.state) as v from public.academic_agent_execution_provenance p join public.academic_provider_executions x on x.id=p.professor_execution_id join public.professor_classroom_sessions c on c.id=p.classroom_id where c.class_session_id=$1",
        [failedSession],
      ),
    ).toEqual(["FAILED"]);
  });

  it("refuses an objective that is not in the source lesson and version", async () => {
    await owner();
    const foreignObjective = await value<string>(
      "select id as v from public.lesson_objectives where programme_version_id<>$1 limit 1",
      [f.programmeVersionId],
    );
    expect(
      await request([
        liveSession,
        "OBJECTIVE_REINFORCEMENT",
        foreignObjective,
        null,
      ]),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(
      await request([
        liveSession,
        "OBJECTIVE_REINFORCEMENT",
        randomUUID(),
        null,
      ]),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("accepts only the two reviewed reason codes and one matching scope, and no summary at all", async () => {
    for (const args of [
      [liveSession, "FREE_TEXT_REASON", f.objectiveId, null],
      [liveSession, "MISSED_LESSON_PRACTICE", f.objectiveId, null],
      [liveSession, "OBJECTIVE_REINFORCEMENT", null, null],
      [liveSession, "OBJECTIVE_REINFORCEMENT", f.objectiveId, f.labPracticalId],
      [liveSession, "PRACTICAL_HELP", f.objectiveId, null],
      [liveSession, "PRACTICAL_HELP", f.objectiveId, f.labPracticalId],
      [liveSession, null, f.objectiveId, null],
    ] as [string, string | null, string | null, string | null][])
      expect(await request(args)).toEqual({
        ok: false,
        code: "INVALID_INPUT",
      });
    // There is no summary, destination, execution or provenance parameter.
    await owner();
    expect(
      await value<string>(
        "select pg_get_function_identity_arguments('public.request_professor_academic_handoff'::regproc) as v",
      ),
    ).toBe(
      "p_class_session_id uuid, p_reason_code text, p_objective_id uuid, p_practical_id uuid",
    );
  });

  it("never stores transcript, question, answer or any free text: only fixed codes, ids and the fixed summary", async () => {
    const tutor = await tutorRequest();
    const lab = await labRequest();
    await owner();
    // The table has no free-text column beyond the CHECK-pinned summary.
    expect(
      (
        await f.db.query<{ name: string }>(
          "select column_name as name from information_schema.columns where table_schema='public' and table_name='professor_academic_handoffs' order by ordinal_position",
        )
      ).rows.map((r) => r.name),
    ).toEqual([
      "id",
      "handoff_policy",
      "handoff_id",
      "student_id",
      "enrolment_id",
      "programme_version_id",
      "classroom_id",
      "class_session_id",
      "lesson_id",
      "objective_id",
      "practical_id",
      "source_role",
      "destination_role",
      "reason_code",
      "source_professor_execution_id",
      "source_provenance_id",
      "summary",
      "scope_key",
      "created_at",
    ]);
    const stored = JSON.stringify([
      await link(tutor.handoffId!),
      await link(lab.handoffId!),
      (
        await f.db.query(
          "select * from public.delivery_handoffs where id in ($1,$2)",
          [tutor.handoffId, lab.handoffId],
        )
      ).rows,
      (
        await f.db.query(
          "select * from public.audit_events where target_type='professor_academic_handoffs'",
        )
      ).rows,
    ]);
    // The classroom turn really holds the sentinels; the handoff does not.
    expect(
      await value(
        "select count(*)::int as v from public.professor_classroom_turns where learner_message=$1 and professor_message=$2",
        [LEARNER_SENTINEL, PROFESSOR_SENTINEL],
      ),
    ).toBe(1);
    expect(stored).not.toContain(LEARNER_SENTINEL);
    expect(stored).not.toContain(PROFESSOR_SENTINEL);
    // A summary other than the fixed one is refused by the CHECK.
    await refused(
      "insert into public.professor_academic_handoffs(handoff_id,student_id,enrolment_id,programme_version_id,classroom_id,class_session_id,lesson_id,objective_id,destination_role,reason_code,source_professor_execution_id,source_provenance_id,summary,scope_key) select handoff_id,student_id,enrolment_id,programme_version_id,classroom_id,class_session_id,lesson_id,objective_id,destination_role,reason_code,source_professor_execution_id,source_provenance_id,'Learner struggled and seems anxious',scope_key from public.professor_academic_handoffs where handoff_id=$1",
      [tutor.handoffId],
      "violates check constraint",
    );
  });

  it("is refused while a controlled assessment is active", async () => {
    await as(1);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    expect(
      await value(requestSql, [
        liveSession,
        "OBJECTIVE_REINFORCEMENT",
        f.objectiveId,
        null,
      ]),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
    expect(
      await value(
        "select public.list_my_professor_academic_handoffs($1) as v",
        [liveSession],
      ),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
  });
});

describe("learner visibility", () => {
  it("shows the owning learner exactly the approved fields, and nothing to anyone else", async () => {
    const tutor = await tutorRequest();
    await labRequest();
    await as(1);
    const listed = await value<{
      ok: true;
      handoffs: Record<string, unknown>[];
    }>("select public.list_my_professor_academic_handoffs($1) as v", [
      liveSession,
    ]);
    expect(listed.ok).toBe(true);
    expect(listed.handoffs).toHaveLength(2);
    for (const h of listed.handoffs) {
      expect(Object.keys(h).sort()).toEqual(
        [
          "createdAt",
          "destinationRole",
          "handoffId",
          "lessonTitle",
          "objectiveDescription",
          "practicalTitle",
          "reasonCode",
          "summary",
        ].sort(),
      );
      expect(learnerProfessorHandoffSchema.safeParse(h).success).toBe(true);
    }
    expect(listed.handoffs[0]).toMatchObject({
      handoffId: tutor.handoffId,
      destinationRole: "TUTOR",
      practicalTitle: null,
    });
    const text = JSON.stringify(listed);
    expect(text).not.toContain(sourceExecutionId);
    expect(text).not.toContain(LEARNER_SENTINEL);
    await as(3);
    expect(
      await value(
        "select public.list_my_professor_academic_handoffs($1) as v",
        [liveSession],
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

describe("Tutor/Lab consumption", () => {
  it("gives a Tutor release of a Professor Tutor handoff the bounded record", async () => {
    const tutor = await tutorRequest();
    const release = await openTutorLabRelease(tutor.handoffId!);
    expect(release).toMatchObject({ ok: true });
    const read = await recordFor(release.release_id);
    expect(read).toMatchObject({ ok: true, available: true });
    const record = (read as { record: Record<string, unknown> }).record;
    expect(professorTeachingRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      sourceRole: "PROFESSOR",
      destinationRole: "TUTOR",
      reasonCode: "OBJECTIVE_REINFORCEMENT",
      scope: "OBJECTIVE",
    });
    expect(JSON.stringify(read)).not.toContain(sourceExecutionId);
  });

  it("gives a Lab release of a Professor Lab handoff its record", async () => {
    const lab = await labRequest();
    const release = await openTutorLabRelease(lab.handoffId!);
    expect(release).toMatchObject({ ok: true });
    expect(await recordFor(release.release_id)).toMatchObject({
      ok: true,
      available: true,
      record: { destinationRole: "LAB_INSTRUCTOR", scope: "PRACTICAL" },
    });
  });

  it("reports no record for an ordinary learner handoff (AC-2 behaviour preserved)", async () => {
    for (const handoff of [
      f.objectiveReinforcementHandoffId,
      f.practicalHelpHandoffId,
    ]) {
      const release = await openTutorLabRelease(handoff);
      expect(release).toMatchObject({ ok: true });
      expect(await recordFor(release.release_id)).toEqual({
        ok: true,
        available: false,
      });
    }
  });

  it("refuses a foreign learner, a closed release and a mismatched projection (cross-destination misuse)", async () => {
    const tutor = await tutorRequest();
    const release = await openTutorLabRelease(tutor.handoffId!);
    expect(await recordFor(release.release_id, 3)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    await as(1);
    await f.db.query("select public.close_tutor_lab_content_release($1,true)", [
      release.release_id,
    ]);
    expect(await recordFor(release.release_id)).toEqual({
      ok: false,
      code: "RELEASE_NOT_ACTIVE",
    });
    // An owner-forged projection claiming a Tutor objective follow-up on a
    // LAB delivery handoff is never released to that Lab release.
    await owner();
    const row = await link(tutor.handoffId!);
    const otherClassroom = await value<string>(
      "select id as v from public.professor_classroom_sessions where class_session_id=$1",
      [emptySession],
    );
    await f.db.query(
      "insert into public.professor_academic_handoffs(handoff_id,student_id,enrolment_id,programme_version_id,classroom_id,class_session_id,lesson_id,objective_id,destination_role,reason_code,source_professor_execution_id,source_provenance_id,summary,scope_key) values($1,$2,$3,$4,$5,$6,$7,$8,'TUTOR','OBJECTIVE_REINFORCEMENT',$9,$10,$11,$12)",
      [
        f.practicalHelpHandoffId,
        learner,
        f.learnerEnrolmentId,
        f.programmeVersionId,
        otherClassroom,
        emptySession,
        f.lessonId,
        f.objectiveId,
        sourceExecutionId,
        row.source_provenance_id,
        PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
        `OBJECTIVE:${f.objectiveId}`,
      ],
    );
    const forgedRelease = await openTutorLabRelease(f.practicalHelpHandoffId);
    expect(forgedRelease).toMatchObject({ ok: true });
    const forged = await recordFor(forgedRelease.release_id);
    expect(forged).toEqual({ ok: false, code: "CONTEXT_CONFLICT" });
  });

  it("is refused while a controlled assessment is active, even for an open release", async () => {
    const tutor = await tutorRequest();
    const release = await openTutorLabRelease(tutor.handoffId!);
    expect(release).toMatchObject({ ok: true });
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    expect(await recordFor(release.release_id)).toEqual({
      ok: false,
      code: "ACTIVITY_BLOCKED",
    });
  });
});

describe("authority, immutability and access", () => {
  it("is immutable and has no direct client table access", async () => {
    const tutor = await tutorRequest();
    await owner();
    await refused(
      "update public.professor_academic_handoffs set reason_code='PRACTICAL_HELP' where handoff_id=$1",
      [tutor.handoffId],
      "PROFESSOR_HANDOFF_IMMUTABLE",
    );
    await refused(
      "delete from public.professor_academic_handoffs where handoff_id=$1",
      [tutor.handoffId],
      "PROFESSOR_HANDOFF_IMMUTABLE",
    );
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await value(
          "select has_table_privilege($1,'public.professor_academic_handoffs','SELECT,INSERT,UPDATE,DELETE') as v",
          [role],
        ),
      ).toBe(false);
      expect(
        await value(
          "select has_function_privilege($1,'public.request_professor_academic_handoff(uuid,text,uuid,uuid)','EXECUTE') as v",
          [role],
        ),
      ).toBe(role === "authenticated");
    }
    await as(1);
    await refused(
      "select * from public.professor_academic_handoffs",
      [],
      "permission denied",
    );
  });

  it("never creates or changes mastery, evidence, grades, progress, completion or attendance", async () => {
    await owner();
    const tables = [
      "objective_mastery",
      "learning_evidence",
      "lesson_progress",
      "attendance_records",
    ];
    const existing = (
      await f.db.query<{ t: string }>(
        "select table_name as t from information_schema.tables where table_schema='public' and table_name = any($1)",
        [tables],
      )
    ).rows.map((r) => r.t);
    expect(existing.length).toBeGreaterThan(0);
    const snapshot = async () => {
      await owner();
      const out: Record<string, number> = {};
      for (const t of existing)
        out[t] = await value<number>(
          `select count(*)::int as v from public.${t}`,
        );
      return out;
    };
    const before = await snapshot();
    await tutorRequest();
    await labRequest();
    expect(await snapshot()).toEqual(before);
  });

  it("leaves ordinary learner delivery handoffs working and lists Professor ones as ordinary learner handoffs", async () => {
    const tutor = await tutorRequest();
    await as(1);
    const plain = await value<string>(
      "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as v",
      [f.learnerEnrolmentId, f.lessonId, randomUUID()],
    );
    expect(plain).toMatch(/^[0-9a-f-]{36}$/);
    const listed = await value<{ id: string; provenance: string }[]>(
      "select public.list_delivery_handoffs($1,0) as v",
      [f.learnerEnrolmentId],
    );
    expect(listed.map((h) => h.id)).toEqual(
      expect.arrayContaining([tutor.handoffId, plain]),
    );
    expect(listed.find((h) => h.id === tutor.handoffId)?.provenance).toBe(
      "LEARNER_REQUEST",
    );
  });

  it("freezes the AC-3-aware Tutor/Lab role versions for a version published after migration 052", async () => {
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
        behaviour_version: "LAB_INSTRUCTOR_BEHAVIOUR_V2",
      },
      { role: "PROFESSOR", behaviour_version: "PROFESSOR_BEHAVIOUR_V1" },
      { role: "TUTOR", behaviour_version: "TUTOR_BEHAVIOUR_V2" },
    ]);
  });
});
