import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The REAL TypeScript controller recorder (src/server/tutor-class-notes.ts)
// is driven against this real database through a thin RPC shim, so its
// canonical message is proven byte-compatible with migration 053.
const shim = vi.hoisted(() => ({
  rpc: null as
    null | ((name: string, args: Record<string, unknown>) => unknown),
}));
vi.mock("@/server/identity", () => ({
  getAuthenticatedActor: async () => ({
    id: "10000000-0000-4000-8000-000000000001",
    roles: ["STUDENT"],
  }),
  requireStudentPrincipal: async () => ({
    id: "10000000-0000-4000-8000-000000000001",
    roles: ["STUDENT"],
  }),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => ({
      data: await shim.rpc!(name, args),
      error: null,
    }),
  }),
}));
import {
  listMyTutorClassNotes,
  recordTutorClassNote,
} from "@/server/tutor-class-notes";
import {
  tutorLabFixture,
  asExecutionUser,
  learner,
  foreignLearner,
  type TutorLabFixture,
} from "./tutor-lab-fixture";
import {
  signedTutorLabCommand,
  sendTutorLabCommand,
} from "./tutor-lab-provider-execution-fixture";
import {
  signedProviderCommand,
  sendProviderCommand,
} from "./provider-execution-fixture";
import { enrolledLesson, openExecutionRelease } from "./execution-fixture";
import { tutorLabInteractionFingerprintMaterial } from "@/domain/tutor-lab-execution";

// AC-4 (migration 053): supplementary, versioned Tutor class notes, against
// the real migration chain on PGlite. PGlite is single-connection: these
// tests prove invariants and SEQUENTIAL idempotency only, never true
// independent-connection concurrency.

let f: TutorLabFixture;
beforeAll(async () => {
  f = await tutorLabFixture();
});
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback; reset role");
});
afterAll(async () => {
  await f.db?.close();
});

async function value<T = unknown>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function user(n: number) {
  await asExecutionUser(f.db, n);
}
async function owner() {
  await f.db.exec("reset role");
}
async function denied(sql: string, args: unknown[] = [], message?: string) {
  await f.db.exec("savepoint denial");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await f.db.exec("rollback to savepoint denial;release savepoint denial");
  }
}
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type Final = { state: string; reason: string; budgetStage?: string };
const SUCCEEDED: Final = { state: "SUCCEEDED", reason: "PROVIDER_COMPLETE" };

// One governed Tutor/Lab execution through the real release and attested
// AUTHORIZE/START/FINALIZE surface, in the production order: the release is
// closed (COMPLETED) before FINALIZE. `final: null` leaves it RUNNING.
async function execute(
  handoffId: string,
  final: Final | null = SUCCEEDED,
  options: { closeRelease?: boolean; asUser?: number } = {},
) {
  await user(options.asUser ?? 1);
  const opened = await value<{
    ok: boolean;
    role: string;
    release_id: string;
  }>("select public.begin_tutor_lab_content_release($1,$2) as v", [
    randomUUID(),
    handoffId,
  ]);
  if (!opened.ok) throw new Error(`release refused: ${JSON.stringify(opened)}`);
  const executionId = randomUUID();
  const base = {
    role: opened.role,
    executionId,
    releaseId: opened.release_id,
    actor: options.asUser === 3 ? foreignLearner : learner,
  };
  for (const command of [
    signedTutorLabCommand(f, base),
    signedTutorLabCommand(f, {
      ...base,
      operation: "START",
      state: "RUNNING",
      maxCalls: 0,
      maxOutput: 0,
      maxCost: 0,
    }),
  ]) {
    const result = (await sendTutorLabCommand(f.db, command)) as {
      ok: boolean;
    };
    if (!result.ok)
      throw new Error(`command refused ${JSON.stringify(result)}`);
  }
  if (options.closeRelease !== false) {
    const closed = await value<{ state: string }>(
      "select public.close_tutor_lab_content_release($1,true) as v",
      [opened.release_id],
    );
    expect(closed.state).toBe("COMPLETED");
  }
  if (final) {
    const finalized = (await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        ...base,
        operation: "FINALIZE",
        state: final.state,
        reason: final.reason,
        budgetStage: final.budgetStage ?? "NONE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
        calls: 1,
        attempts: 1,
        output: 50,
        cost: 100,
      }),
    )) as { ok: boolean };
    if (!finalized.ok)
      throw new Error(`finalize refused ${JSON.stringify(finalized)}`);
  }
  return { executionId, releaseId: opened.release_id };
}

// The provider rate limit (5 per minute) would otherwise stop one test
// transaction from creating more than five executions. Shifting earlier
// executions' timestamps back (owner, inside the rolled-back transaction)
// changes nothing this checkpoint relies on.
async function ageExecutions() {
  await owner();
  await f.db.exec(`
    alter table public.tutor_lab_provider_executions disable trigger guard_tutor_lab_provider_execution_history;
    update public.tutor_lab_provider_executions set created_at=created_at-interval '2 hours',
      authorized_at=authorized_at-interval '2 hours', started_at=started_at-interval '2 hours',
      terminal_at=terminal_at-interval '2 hours', expires_at=expires_at-interval '2 hours';
    alter table public.tutor_lab_provider_executions enable trigger guard_tutor_lab_provider_execution_history;
  `);
}

function signNote(
  input: {
    executionId: string;
    body: string;
    actor?: string;
    tag?: string;
    macBody?: string;
  },
  keyId = f.keyId,
) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10;
  const canonical = [
    input.tag ?? "DUCELIO_TUTOR_CLASS_NOTE_HMAC_SHA256_V1",
    "TUTOR",
    keyId,
    input.actor ?? learner,
    input.executionId,
    sha256(input.macBody ?? input.body),
    String(issuedAt),
    String(expiresAt),
  ].join("\n");
  return [
    keyId,
    input.executionId,
    input.body,
    issuedAt,
    expiresAt,
    createHmac("sha256", f.key).update(canonical).digest("hex"),
  ];
}
type RecordResult =
  | { ok: true; duplicate: boolean; revisionNumber: number }
  | { ok: false; code: string };
async function record(
  input: Parameters<typeof signNote>[0],
  asUser = 1,
): Promise<RecordResult> {
  await user(asUser);
  return value<RecordResult>(
    "select public.record_tutor_class_note($1,$2,$3,$4,$5,$6) as v",
    signNote(input),
  );
}
type NoteList = {
  ok: boolean;
  code?: string;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  notes?: {
    lessonTitle: string;
    objectiveDescription: string | null;
    reasonCode: string;
    createdAt: string;
    revisionCount: number;
    revisions: {
      revisionNumber: number;
      current: boolean;
      body: string;
      createdAt: string;
    }[];
  }[];
};
async function list(asUser = 1, enrolmentId = f.learnerEnrolmentId, page = 0) {
  await user(asUser);
  return value<NoteList>(
    "select public.list_my_tutor_class_notes($1,$2) as v",
    [enrolmentId, page],
  );
}
async function counts() {
  await owner();
  return value<{ series: number; revisions: number }>(
    `select jsonb_build_object(
       'series', (select count(*) from public.tutor_class_note_series),
       'revisions', (select count(*) from public.tutor_class_note_revisions)) as v`,
  );
}
async function startControlledAssessment() {
  await user(1);
  await f.db.query("select public.start_assessment_attempt($1)", [
    f.assessmentId,
  ]);
}

describe("AC-4 Tutor class note creation", () => {
  it("records revision 1 for a SUCCEEDED Tutor execution, bound to its source and provenance", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    const body = "Access control limits who may use a resource.";
    expect(await record({ executionId, body })).toEqual({
      ok: true,
      duplicate: false,
      revisionNumber: 1,
    });
    await owner();
    const row = await value<Record<string, unknown>>(
      `select jsonb_build_object('revision', r.revision_number, 'author', r.author_role,
         'student', r.student_id, 'body', r.body, 'digest', r.body_sha256,
         'provenanceMatches', p.tutor_lab_execution_id = r.source_tutor_execution_id,
         'seriesHandoff', s.handoff_id, 'seriesEnrolment', s.enrolment_id, 'seriesLesson', s.lesson_id,
         'seriesVersion', s.programme_version_id, 'seriesReason', s.reason_code, 'policy', s.note_policy) as v
       from public.tutor_class_note_revisions r
       join public.tutor_class_note_series s on s.id = r.series_id
       join public.academic_agent_execution_provenance p on p.id = r.source_provenance_id
       where r.source_tutor_execution_id = $1`,
      [executionId],
    );
    expect(row).toEqual({
      revision: 1,
      author: "TUTOR",
      student: learner,
      body,
      digest: sha256(body),
      provenanceMatches: true,
      seriesHandoff: f.missedLessonHandoffId,
      seriesEnrolment: f.learnerEnrolmentId,
      seriesLesson: f.lessonId,
      seriesVersion: f.programmeVersionId,
      seriesReason: "MISSED_LESSON_PRACTICE",
      policy: "TUTOR_CLASS_NOTE_V1",
    });
  });

  it("works for every Tutor handoff reason, binding the objective when the handoff has one", async () => {
    for (const [handoffId, reason, objective] of [
      [f.objectiveReinforcementHandoffId, "OBJECTIVE_REINFORCEMENT", true],
      [f.practicalPrerequisiteHandoffId, "PRACTICAL_PREREQUISITE", false],
    ] as const) {
      const { executionId } = await execute(handoffId);
      expect(await record({ executionId, body: `Note for ${reason}` })).toEqual(
        { ok: true, duplicate: false, revisionNumber: 1 },
      );
      await owner();
      const series = await value<{ reason: string; objective: string | null }>(
        "select jsonb_build_object('reason', reason_code, 'objective', objective_id) as v from public.tutor_class_note_series where handoff_id=$1",
        [handoffId],
      );
      expect(series).toEqual({
        reason,
        objective: objective ? f.objectiveId : null,
      });
    }
  });

  it("refuses a Lab Instructor source, even a SUCCEEDED one", async () => {
    const { executionId } = await execute(f.practicalHelpHandoffId);
    expect(await record({ executionId, body: "Lab answer" })).toEqual({
      ok: false,
      code: "SOURCE_NOT_ELIGIBLE",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses a Professor execution: the Professor execution universe is never a note source", async () => {
    await user(1);
    const releaseId = (await openExecutionRelease(f.db)).release_id;
    const executionId = randomUUID();
    const authorized = (await sendProviderCommand(
      f.db,
      signedProviderCommand(f, { executionId, releaseId }),
    )) as { ok: boolean };
    expect(authorized.ok).toBe(true);
    expect(await record({ executionId, body: "Professor answer" })).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it.each([
    ["FAILED", { state: "FAILED", reason: "PROVIDER_ERROR" }],
    ["ABSTAINED", { state: "ABSTAINED", reason: "POLICY_BLOCKED" }],
    ["ESCALATED", { state: "ESCALATED", reason: "HUMAN_REVIEW_REQUIRED" }],
    [
      "BUDGET_BLOCKED",
      {
        state: "BUDGET_BLOCKED",
        reason: "BUDGET_BLOCKED",
        budgetStage: "POST_CALL",
      },
    ],
    ["CANCELLED", { state: "CANCELLED", reason: "CANCELLED" }],
    [
      "timed out (FAILED/EXECUTION_TIMEOUT)",
      { state: "FAILED", reason: "EXECUTION_TIMEOUT" },
    ],
  ] as const)("refuses a %s Tutor execution", async (_label, final) => {
    const { executionId } = await execute(f.missedLessonHandoffId, final);
    expect(await record({ executionId, body: "Not a success" })).toEqual({
      ok: false,
      code: "SOURCE_NOT_ELIGIBLE",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses a still-RUNNING (non-terminal) Tutor execution", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId, null);
    expect(await record({ executionId, body: "Running" })).toEqual({
      ok: false,
      code: "SOURCE_NOT_ELIGIBLE",
    });
  });

  it("refuses a SUCCEEDED execution whose content release never closed COMPLETED", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId, SUCCEEDED, {
      closeRelease: false,
    });
    expect(await record({ executionId, body: "Release still open" })).toEqual({
      ok: false,
      code: "SOURCE_NOT_ELIGIBLE",
    });
  });

  it("refuses another learner's execution and an unknown execution id", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    expect(
      await record({ executionId, body: "Mine", actor: foreignLearner }, 3),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(
      await record({ executionId: randomUUID(), body: "Unknown" }),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses an attestation over different text, under another protocol tag, or for another actor", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    expect(
      await record({ executionId, body: "Forged text", macBody: "Real text" }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    expect(
      await record({
        executionId,
        body: "Turn tag",
        tag: "DUCELIO_CLASSROOM_TURN_HMAC_SHA256_V1",
      }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    expect(
      await record({ executionId, body: "Other actor", actor: foreignLearner }),
    ).toEqual({ ok: false, code: "ATTESTATION_INVALID" });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses missing provenance", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await owner();
    await f.db.exec(
      "alter table public.academic_agent_execution_provenance disable trigger guard_agent_execution_provenance",
    );
    await f.db.query(
      "delete from public.academic_agent_execution_provenance where tutor_lab_execution_id=$1",
      [executionId],
    );
    await f.db.exec(
      "alter table public.academic_agent_execution_provenance enable trigger guard_agent_execution_provenance",
    );
    expect(await record({ executionId, body: "No provenance" })).toEqual({
      ok: false,
      code: "PROVENANCE_INVALID",
    });
  });

  async function corruptProvenance(
    executionId: string,
    set: string,
    args: unknown[] = [],
  ) {
    await owner();
    await f.db.exec(
      "alter table public.academic_agent_execution_provenance disable trigger guard_agent_execution_provenance",
    );
    await f.db.query(
      `update public.academic_agent_execution_provenance set ${set} where tutor_lab_execution_id=$1`,
      [executionId, ...args],
    );
    await f.db.exec(
      "alter table public.academic_agent_execution_provenance enable trigger guard_agent_execution_provenance",
    );
  }

  it.each([
    [
      "a behaviour version other than the frozen binding",
      "behaviour_version='TUTOR_BEHAVIOUR_V1'",
    ],
    ["a corrupt behaviour fingerprint", "behaviour_fingerprint=repeat('a',64)"],
    [
      "another runtime profile",
      "runtime_profile_ref='LAB_INSTRUCTOR_COMMERCIAL_V1'",
    ],
    [
      "another Level-1 baseline",
      "institutional_baseline_version='DUCELIO_INSTITUTIONAL_BASELINE_V1'||''",
    ],
  ])("refuses provenance with %s", async (label, set) => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    if (label === "another Level-1 baseline") {
      // The provenance CHECK admits only the reviewed baseline, so this
      // case corrupts the database mirror instead (inside the rolled-back
      // transaction), which the provenance must equal.
      await owner();
      await f.db.exec(
        "create or replace function agent_behaviour_private.institutional_baseline_version() returns text language sql immutable set search_path='' as $$ select 'DUCELIO_INSTITUTIONAL_BASELINE_V2'::text $$",
      );
    } else await corruptProvenance(executionId, set);
    expect(await record({ executionId, body: "Corrupt" })).toEqual({
      ok: false,
      code: "PROVENANCE_MISMATCH",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses cross-enrolment provenance", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await corruptProvenance(executionId, "enrolment_id=$2", [f.enrolmentId]);
    expect(await record({ executionId, body: "Cross enrolment" })).toEqual({
      ok: false,
      code: "PROVENANCE_MISMATCH",
    });
  });

  it("refuses cross-version provenance", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await owner();
    const otherVersion = await value<string>(
      "select programme_version_id as v from public.enrolments where id=$1",
      [f.enrolmentId],
    );
    expect(otherVersion).not.toBe(f.programmeVersionId);
    await corruptProvenance(executionId, "programme_version_id=$2", [
      otherVersion,
    ]);
    expect(await record({ executionId, body: "Cross version" })).toEqual({
      ok: false,
      code: "PROVENANCE_MISMATCH",
    });
  });

  async function corruptRelease(
    releaseId: string,
    set: string,
    args: unknown[],
  ) {
    await owner();
    await f.db.exec(
      "alter table public.tutor_lab_content_releases disable trigger guard_tutor_lab_release_history",
    );
    await f.db.query(
      `update public.tutor_lab_content_releases set ${set} where id=$1`,
      [releaseId, ...args],
    );
    await f.db.exec(
      "alter table public.tutor_lab_content_releases enable trigger guard_tutor_lab_release_history",
    );
  }

  it("refuses a cross-lesson source (release lesson differs from its handoff)", async () => {
    const { executionId, releaseId } = await execute(f.missedLessonHandoffId);
    await corruptRelease(releaseId, "lesson_id=$2", [enrolledLesson]);
    expect(await record({ executionId, body: "Cross lesson" })).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
  });

  it("refuses a same-version cross-lesson source (another lesson of the same programme version)", async () => {
    const { executionId, releaseId } = await execute(f.missedLessonHandoffId);
    await owner();
    // A second lesson in the SAME published version, so only the
    // release-vs-handoff lesson agreement can catch it. Inserted as owner
    // with the curriculum freeze disabled, inside the rolled-back
    // transaction.
    await f.db.exec(
      "alter table public.lessons disable trigger freeze_content; alter table public.lessons disable trigger materialized_curriculum_serialization",
    );
    const otherLesson = await value<string>(
      "insert into public.lessons(module_id,programme_version_id,title,position) select module_id,programme_version_id,'AC-4 other lesson',99 from public.lessons where id=$1 returning id as v",
      [f.lessonId],
    );
    await f.db.exec(
      "alter table public.lessons enable trigger freeze_content; alter table public.lessons enable trigger materialized_curriculum_serialization",
    );
    await corruptRelease(releaseId, "lesson_id=$2", [otherLesson]);
    expect(await record({ executionId, body: "Same-version lesson" })).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });

  it("refuses a cross-objective source (another objective of the same lesson)", async () => {
    // The seed enrolment's lesson has five objectives in one version.
    await user(1);
    const objectives = (
      await f.db.query<{ id: string }>(
        "select id from public.lesson_objectives where lesson_id=$1 order by position",
        [enrolledLesson],
      )
    ).rows.map((row) => row.id);
    expect(objectives.length).toBeGreaterThan(1);
    const handoffId = await value<string>(
      "select public.request_delivery_handoff($1,$2,$3,'OBJECTIVE_REINFORCEMENT',$4) as v",
      [f.enrolmentId, enrolledLesson, objectives[0], randomUUID()],
    );
    const { executionId, releaseId } = await execute(handoffId);
    await corruptRelease(releaseId, "objective_id=$2", [objectives[1]]);
    expect(await record({ executionId, body: "Other objective" })).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
  });

  it("refuses a cross-enrolment source (release enrolment differs from its handoff)", async () => {
    const { executionId, releaseId } = await execute(f.missedLessonHandoffId);
    await corruptRelease(releaseId, "enrolment_id=$2", [f.enrolmentId]);
    expect(await record({ executionId, body: "Cross enrolment" })).toEqual({
      ok: false,
      code: "CONTEXT_CONFLICT",
    });
  });

  it("refuses invalid input and non-learners before any read", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    expect(await record({ executionId, body: "x".repeat(8001) })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await record({ executionId, body: "   \n " })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    await owner();
    await f.db.query(
      "delete from public.role_grants where user_id=$1 and role='STUDENT'",
      [learner],
    );
    expect(await record({ executionId, body: "No student role" })).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
  });

  it("accepts a body of exactly 8,000 characters", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    expect(await record({ executionId, body: "é".repeat(8000) })).toMatchObject(
      {
        ok: true,
      },
    );
  });
});

describe("AC-4 controlled-assessment firewall", () => {
  it("blocks creation at the write boundary, writing no body and no receipt", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await startControlledAssessment();
    expect(
      await record({ executionId, body: "Protected explanation" }),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
    await owner();
    expect(
      await value<number>(
        "select count(*)::int as v from public.audit_events where target_type like 'tutor_class_note%'",
      ),
    ).toBe(0);
  });

  it("blocks the learner read of a note created before the assessment", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Created before the assessment" });
    expect((await list()).ok).toBe(true);
    await startControlledAssessment();
    expect(await list()).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
  });
});

describe("AC-4 idempotency and append-only versioning", () => {
  it("a retry of the same source execution replays the same revision", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    const body = "Idempotent note";
    expect(await record({ executionId, body })).toEqual({
      ok: true,
      duplicate: false,
      revisionNumber: 1,
    });
    expect(await record({ executionId, body })).toEqual({
      ok: true,
      duplicate: true,
      revisionNumber: 1,
    });
    expect(await counts()).toEqual({ series: 1, revisions: 1 });
  });

  it("the same source execution can never create a second revision, even with different text", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "First text" });
    expect(await record({ executionId, body: "Different text" })).toEqual({
      ok: false,
      code: "SOURCE_CONFLICT",
    });
    expect(await counts()).toEqual({ series: 1, revisions: 1 });
  });

  it("allocates contiguous revision numbers per note, keeps history unchanged and marks the latest current", async () => {
    const bodies = ["First answer", "Second answer", "Third answer"];
    for (const body of bodies) {
      const { executionId } = await execute(f.missedLessonHandoffId);
      await record({ executionId, body });
    }
    const other = await execute(f.practicalPrerequisiteHandoffId);
    await record({ executionId: other.executionId, body: "Other topic" });
    const result = await list();
    expect(result.ok).toBe(true);
    const note = result.notes!.find(
      (n) => n.reasonCode === "MISSED_LESSON_PRACTICE",
    )!;
    expect(note.revisionCount).toBe(3);
    expect(
      note.revisions.map((r) => [r.revisionNumber, r.current, r.body]),
    ).toEqual([
      [3, true, "Third answer"],
      [2, false, "Second answer"],
      [1, false, "First answer"],
    ]);
    const otherNote = result.notes!.find(
      (n) => n.reasonCode === "PRACTICAL_PREREQUISITE",
    )!;
    expect(otherNote.revisions).toHaveLength(1);
    expect(await counts()).toEqual({ series: 2, revisions: 4 });
  });

  it("refuses an eleventh revision of one note", async () => {
    for (let i = 1; i <= 10; i += 1) {
      if (i % 4 === 0) await ageExecutions();
      const { executionId } = await execute(f.missedLessonHandoffId);
      expect(await record({ executionId, body: `Answer ${i}` })).toEqual({
        ok: true,
        duplicate: false,
        revisionNumber: i,
      });
    }
    await ageExecutions();
    const { executionId } = await execute(f.missedLessonHandoffId);
    expect(await record({ executionId, body: "Answer 11" })).toEqual({
      ok: false,
      code: "REVISION_LIMIT_REACHED",
    });
    expect(await counts()).toEqual({ series: 1, revisions: 10 });
  });

  it("the database owns revision allocation: a direct owner insert's revision number is replaced, and a bogus source is refused", async () => {
    const first = await execute(f.missedLessonHandoffId);
    await record({ executionId: first.executionId, body: "One" });
    const second = await execute(f.missedLessonHandoffId);
    await owner();
    const series = await value<string>(
      "select id as v from public.tutor_class_note_series where handoff_id=$1",
      [f.missedLessonHandoffId],
    );
    const provenance = await value<string>(
      "select id as v from public.academic_agent_execution_provenance where tutor_lab_execution_id=$1",
      [second.executionId],
    );
    const allocated = await value<number>(
      "insert into public.tutor_class_note_revisions(series_id,student_id,revision_number,source_tutor_execution_id,source_provenance_id,body,body_sha256) values($1,$2,7,$3,$4,'Two',repeat('0',64)) returning revision_number as v",
      [series, learner, second.executionId, provenance],
    );
    expect(allocated).toBe(2);
    const lab = await execute(f.practicalHelpHandoffId);
    await owner();
    const labProvenance = await value<string>(
      "select id as v from public.academic_agent_execution_provenance where tutor_lab_execution_id=$1",
      [lab.executionId],
    );
    await denied(
      "insert into public.tutor_class_note_revisions(series_id,student_id,revision_number,source_tutor_execution_id,source_provenance_id,body,body_sha256) values($1,$2,1,$3,$4,'Lab',repeat('0',64))",
      [series, learner, lab.executionId, labProvenance],
      "TUTOR_CLASS_NOTE_SOURCE_INVALID",
    );
    await denied(
      "insert into public.tutor_class_note_series(handoff_id,student_id,enrolment_id,programme_version_id,lesson_id,objective_id,reason_code) values($1,$2,$3,$4,$5,null,'PRACTICAL_PREREQUISITE')",
      [
        f.practicalHelpHandoffId,
        learner,
        f.learnerEnrolmentId,
        f.programmeVersionId,
        f.lessonId,
      ],
      "TUTOR_CLASS_NOTE_SCOPE_INVALID",
    );
  });

  it("history is immutable: UPDATE and DELETE are refused for every writer", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Immutable" });
    await owner();
    for (const sql of [
      "update public.tutor_class_note_revisions set body='Rewritten'",
      "update public.tutor_class_note_revisions set revision_number=2",
      "delete from public.tutor_class_note_revisions",
      "update public.tutor_class_note_series set lesson_id=lesson_id",
      "delete from public.tutor_class_note_series",
    ])
      await denied(sql, [], "TUTOR_CLASS_NOTE_IMMUTABLE");
    expect(await counts()).toEqual({ series: 1, revisions: 1 });
  });
});

describe("AC-4 learner-safe read", () => {
  it("returns exactly the learner-safe projection, with no internal identifiers", async () => {
    const { executionId, releaseId } = await execute(
      f.objectiveReinforcementHandoffId,
    );
    await record({ executionId, body: "Objective note" });
    const result = await list();
    expect(Object.keys(result).sort()).toEqual(
      ["hasMore", "notes", "ok", "page", "pageSize"].sort(),
    );
    expect(result).toMatchObject({
      ok: true,
      page: 0,
      pageSize: 5,
      hasMore: false,
    });
    const [note] = result.notes!;
    expect(Object.keys(note).sort()).toEqual(
      [
        "createdAt",
        "lessonTitle",
        "objectiveDescription",
        "reasonCode",
        "revisionCount",
        "revisions",
      ].sort(),
    );
    expect(Object.keys(note.revisions[0]).sort()).toEqual(
      ["body", "createdAt", "current", "revisionNumber"].sort(),
    );
    expect(note.objectiveDescription).toBeTruthy();
    await owner();
    const internal = await value<string[]>(
      `select array[s.id::text, s.handoff_id::text, r.id::text, r.source_tutor_execution_id::text,
         r.source_provenance_id::text, s.enrolment_id::text, s.lesson_id::text, r.body_sha256] as v
       from public.tutor_class_note_series s join public.tutor_class_note_revisions r on r.series_id=s.id`,
    );
    const serialised = JSON.stringify(result);
    for (const id of [...internal, releaseId, learner, f.keyId])
      expect(serialised).not.toContain(id);
    expect(serialised).not.toMatch(
      /TUTOR_BEHAVIOUR|COMMERCIAL_V1|fingerprint|provenance|execution|hmac/i,
    );
  });

  it("is owner-only: another learner cannot read this learner's notes", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Private to the learner" });
    expect(await list(3)).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
    await owner();
    expect(
      await value<number>(
        "select count(*)::int as v from public.tutor_class_note_series where student_id=$1",
        [foreignLearner],
      ),
    ).toBe(0);
  });

  it("is enrolment-scoped: a note from the learner's other enrolment never appears in this one", async () => {
    await user(1);
    const otherHandoff = await value<string>(
      "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as v",
      [f.enrolmentId, enrolledLesson, randomUUID()],
    );
    const other = await execute(otherHandoff);
    expect(
      await record({
        executionId: other.executionId,
        body: "Other enrolment note",
      }),
    ).toMatchObject({ ok: true });
    const mine = await execute(f.missedLessonHandoffId);
    await record({
      executionId: mine.executionId,
      body: "This enrolment note",
    });
    const here = await list();
    expect(here.notes!.map((n) => n.revisions[0].body)).toEqual([
      "This enrolment note",
    ]);
    const there = await list(1, f.enrolmentId);
    expect(there.notes!.map((n) => n.revisions[0].body)).toEqual([
      "Other enrolment note",
    ]);
  });

  it("pages notes five at a time, newest first", async () => {
    const handoffs: string[] = [];
    await user(1);
    for (let i = 0; i < 6; i += 1)
      handoffs.push(
        await value<string>(
          "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as v",
          [f.learnerEnrolmentId, f.lessonId, randomUUID()],
        ),
      );
    for (const [i, handoffId] of handoffs.entries()) {
      if (i > 0 && i % 4 === 0) await ageExecutions();
      const { executionId } = await execute(handoffId);
      await record({ executionId, body: `Topic ${i}` });
    }
    const first = await list();
    expect(first.notes).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(first.notes![0].revisions[0].body).toBe("Topic 5");
    const second = await list(1, f.learnerEnrolmentId, 1);
    expect(second.notes!.map((n) => n.revisions[0].body)).toEqual(["Topic 0"]);
    expect(second.hasMore).toBe(false);
    expect(await list(1, f.learnerEnrolmentId, 50)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
});

describe("AC-4 authority boundaries", () => {
  it("grants no client table privilege and executes only the two reviewed RPCs, for authenticated only", async () => {
    await owner();
    for (const role of ["anon", "authenticated", "service_role"])
      for (const table of [
        "public.tutor_class_note_series",
        "public.tutor_class_note_revisions",
      ]) {
        expect(
          await value<boolean>(
            "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as v",
            [role, table],
          ),
        ).toBe(false);
      }
    const fns = await f.db.query<{
      proname: string;
      nspname: string;
      anon: boolean;
      authenticated: boolean;
      service: boolean;
    }>(
      `select p.proname, n.nspname, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
         has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
         has_function_privilege('service_role',p.oid,'EXECUTE') as service
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='tutor_class_note_private' or p.proname in ('record_tutor_class_note','list_my_tutor_class_notes')`,
    );
    expect(fns.rows.length).toBeGreaterThan(2);
    for (const fn of fns.rows) {
      expect(fn.anon).toBe(false);
      expect(fn.service).toBe(false);
      expect(fn.authenticated).toBe(fn.nspname === "public");
    }
    expect(
      fns.rows
        .filter((fn) => fn.nspname === "public")
        .map((fn) => fn.proname)
        .sort(),
    ).toEqual(["list_my_tutor_class_notes", "record_tutor_class_note"]);
    expect(
      await value<boolean>(
        "select has_schema_privilege('authenticated','tutor_class_note_private','USAGE') as v",
      ),
    ).toBe(false);
  });

  it("an authenticated learner cannot read or write the note tables directly", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Direct access" });
    await user(1);
    await denied("select * from public.tutor_class_note_revisions");
    await denied("select * from public.tutor_class_note_series");
    await denied(
      "insert into public.tutor_class_note_series(handoff_id,student_id,enrolment_id,programme_version_id,lesson_id,reason_code) values($1,$2,$3,$4,$5,'MISSED_LESSON_PRACTICE')",
      [
        f.missedLessonHandoffId,
        learner,
        f.learnerEnrolmentId,
        f.programmeVersionId,
        f.lessonId,
      ],
    );
    await denied("update public.tutor_class_note_revisions set body='x'");
    await denied("delete from public.tutor_class_note_revisions");
  });

  it("is never stored in learning_resources and leaves published curriculum unchanged", async () => {
    await owner();
    const snapshot = () =>
      value<string>(
        `select md5(concat_ws('|',
           (select string_agg(to_jsonb(v)::text, ',' order by v.id) from public.programme_versions v where v.id=$1),
           (select string_agg(to_jsonb(m)::text, ',' order by m.id) from public.modules m where m.programme_version_id=$1),
           (select string_agg(to_jsonb(l)::text, ',' order by l.id) from public.lessons l where l.programme_version_id=$1),
           (select string_agg(to_jsonb(o)::text, ',' order by o.id) from public.lesson_objectives o where o.programme_version_id=$1),
           (select string_agg(to_jsonb(c)::text, ',' order by c.id) from public.course_practicals c where c.programme_version_id=$1),
           (select string_agg(to_jsonb(i)::text, ',' order by i.id) from public.course_package_imports i where i.programme_version_id=$1),
           (select count(*)::text from public.learning_resources))) as v`,
        [f.programmeVersionId],
      );
    const before = await snapshot();
    const { executionId } = await execute(f.objectiveReinforcementHandoffId);
    await record({ executionId, body: "Supplementary only" });
    await owner();
    expect(await snapshot()).toBe(before);
    expect(
      await value<number>(
        "select count(*)::int as v from public.learning_resources where body like '%Supplementary only%'",
      ),
    ).toBe(0);
    expect(
      await value<string>(
        "select pg_get_constraintdef(oid) as v from pg_constraint where conrelid='public.learning_resources'::regclass and pg_get_constraintdef(oid) like '%LECTURE_NOTE%'",
      ),
    ).not.toContain("CLASS_NOTE");
  });

  it("creates no evidence, mastery, progress, attendance, result, completion or enrolment change", async () => {
    await owner();
    const institutional = () =>
      value<Record<string, unknown>>(
        `select jsonb_build_object(
           'evidence', (select count(*) from public.learning_evidence),
           'mastery', (select count(*) from public.objective_mastery),
           'masteryHistory', (select count(*) from public.objective_mastery_history),
           'progress', (select count(*) from public.lesson_progress),
           'attendance', (select count(*) from public.attendance_records),
           'attempts', (select count(*) from public.assessment_attempts),
           'assessmentResults', (select count(*) from public.commercial_v1_assessment_result_revisions),
           'labResults', (select count(*) from public.commercial_v1_lab_result_revisions),
           'completion', (select count(*) from public.commercial_v1_completion_receipts),
           'enrolments', (select string_agg(id::text || ':' || status, ',' order by id) from public.enrolments)) as v`,
      );
    const before = await institutional();
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Not a record of anything" });
    await list();
    await owner();
    expect(await institutional()).toEqual(before);
  });

  it("audits identifiers, role and revision only: never the note body or its digest", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    const body = "Audit sentinel body text";
    await record({ executionId, body });
    await owner();
    const audit = await f.db.query<{
      action: string;
      after_state: Record<string, unknown>;
    }>(
      "select action, after_state from public.audit_events where target_type like 'tutor_class_note%' order by action",
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "TUTOR_CLASS_NOTE_REVISION_CREATED",
      "TUTOR_CLASS_NOTE_SERIES_CREATED",
    ]);
    const serialised = JSON.stringify(audit.rows);
    expect(serialised).not.toContain(body);
    expect(serialised).not.toContain(sha256(body));
    expect(Object.keys(audit.rows[0].after_state).sort()).toEqual(
      [
        "author_role",
        "created_at",
        "revision_id",
        "revision_number",
        "series_id",
        "source_tutor_execution_id",
      ].sort(),
    );
  });
});

describe("AC-4 real controller recorder against the real database", () => {
  it("the TypeScript recorder's attestation is accepted, and the learner read parses strictly", async () => {
    const { executionId } = await execute(f.objectiveReinforcementHandoffId);
    await user(1);
    shim.rpc = async (name, args) => {
      const keys = Object.keys(args);
      return (
        await f.db.query<{ v: unknown }>(
          `select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(",")}) as v`,
          keys.map((key) => args[key]),
        )
      ).rows[0].v;
    };
    vi.stubEnv("ACADEMIC_EXECUTION_KEY_ID", f.keyId);
    vi.stubEnv("ACADEMIC_EXECUTION_HMAC_KEY_HEX", f.key.toString("hex"));
    try {
      const body = "Least privilege grants only the access a task needs. 𝔸é";
      expect(await recordTutorClassNote({ executionId, body })).toEqual({
        revisionNumber: 1,
        duplicate: false,
      });
      expect(await recordTutorClassNote({ executionId, body })).toEqual({
        revisionNumber: 1,
        duplicate: true,
      });
      const page = await listMyTutorClassNotes({
        enrolmentId: f.learnerEnrolmentId,
        page: 0,
      });
      expect(page).toMatchObject({ status: "OK", page: 0, hasMore: false });
      if (page.status !== "OK") throw new Error("expected notes");
      expect(page.notes[0].revisions[0]).toMatchObject({
        revisionNumber: 1,
        current: true,
        body,
      });
      await expect(
        recordTutorClassNote({ executionId, body: "Different text" }),
      ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
    } finally {
      vi.unstubAllEnvs();
      shim.rpc = null;
    }
  });
});

describe("AC-4 independent-review corrections: firewall locking contract", () => {
  // PGlite is a single connection: these tests cannot reproduce a real
  // concurrent race. They pin that the learner-profile row lock (the row
  // start_assessment_attempt locks first) is actually TAKEN, in the
  // documented order, so its accidental removal fails the suite.
  async function profileLockedByThisTransaction(studentId: string) {
    await owner();
    return value<boolean>(
      "select (select xmax::text from public.student_profiles where user_id=$1) = pg_current_xact_id_if_assigned()::text as v",
      [studentId],
    );
  }
  async function noTransactionIdYet() {
    await owner();
    return value<string | null>(
      "select pg_current_xact_id_if_assigned()::text as v",
    );
  }

  it("the learner read takes the learner-profile row lock before returning notes", async () => {
    expect(await noTransactionIdYet()).toBeNull();
    expect((await list()).ok).toBe(true);
    expect(await profileLockedByThisTransaction(learner)).toBe(true);
  });

  it("note creation takes the learner-profile row lock right after attestation, before any source read", async () => {
    expect(await noTransactionIdYet()).toBeNull();
    expect(
      await record({ executionId: randomUUID(), body: "Unknown source" }),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(await profileLockedByThisTransaction(learner)).toBe(true);
  });

  it("fails closed when the STUDENT caller has no learner profile to lock", async () => {
    const administrator = "10000000-0000-4000-8000-000000000002";
    await owner();
    expect(
      await value<number>(
        "select count(*)::int as v from public.student_profiles where user_id=$1",
        [administrator],
      ),
    ).toBe(0);
    await f.db.query(
      "insert into public.role_grants values($1,'STUDENT') on conflict do nothing",
      [administrator],
    );
    expect(
      await record(
        { executionId: randomUUID(), body: "No profile", actor: administrator },
        2,
      ),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await list(2)).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("locks profile, then enrolment, before the firewall; both RPCs are VOLATILE", async () => {
    await owner();
    const definition = async (name: string) =>
      (
        await value<string>(
          "select pg_get_functiondef(p.oid) as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
          [name],
        )
      ).replace(/\s+/g, " ");
    const write = await definition("record_tutor_class_note");
    const profileLock = write.indexOf(
      "from public.student_profiles where user_id = actor for update",
    );
    const enrolmentLock = write.indexOf(
      "from public.enrolments where id = r.enrolment_id and student_id = actor for update",
    );
    const activeCheck = write.indexOf("e.status <> 'ACTIVE'");
    const firewall = write.indexOf(
      "if public.academic_content_release_explain_allowed()",
    );
    const insert = write.indexOf("insert into public.tutor_class_note_series");
    expect(profileLock).toBeGreaterThan(write.indexOf("ATTESTATION_INVALID"));
    expect(enrolmentLock).toBeGreaterThan(profileLock);
    expect(activeCheck).toBeGreaterThan(enrolmentLock);
    expect(firewall).toBeGreaterThan(enrolmentLock);
    expect(insert).toBeGreaterThan(firewall);

    const read = await definition("list_my_tutor_class_notes");
    const readLock = read.indexOf(
      "from public.student_profiles where user_id = actor for update",
    );
    expect(readLock).toBeGreaterThan(0);
    expect(
      read.indexOf("if public.academic_content_release_explain_allowed()"),
    ).toBeGreaterThan(readLock);
    expect(read.indexOf("'notes'")).toBeGreaterThan(readLock);
    for (const signature of [
      "public.list_my_tutor_class_notes(uuid,integer)",
      "public.record_tutor_class_note(uuid,uuid,text,bigint,bigint,text)",
    ])
      expect(
        await value<string>(
          "select provolatile::text as v from pg_proc where oid=$1::regprocedure",
          [signature],
        ),
      ).toBe("v");
  });

  it("the corrected path still refuses creation and reading during an already-active controlled assessment", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await record({ executionId, body: "Before" });
    const second = await execute(f.missedLessonHandoffId);
    await startControlledAssessment();
    expect(
      await record({ executionId: second.executionId, body: "During" }),
    ).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
    expect(await list()).toEqual({ ok: false, code: "ACTIVITY_BLOCKED" });
    expect(await counts()).toEqual({ series: 1, revisions: 1 });
  });

  it("refuses creation once the enrolment is no longer ACTIVE", async () => {
    const { executionId } = await execute(f.missedLessonHandoffId);
    await owner();
    await f.db.exec("alter table public.enrolments disable trigger user");
    await f.db.query(
      "update public.enrolments set status='PAUSED' where id=$1",
      [f.learnerEnrolmentId],
    );
    await f.db.exec("alter table public.enrolments enable trigger user");
    expect(await record({ executionId, body: "Paused" })).toEqual({
      ok: false,
      code: "ENROLMENT_NOT_ACTIVE",
    });
    expect(await counts()).toEqual({ series: 0, revisions: 0 });
  });
});

describe("AC-4 independent-review corrections: structural revision guard", () => {
  async function directInsert(executionId: string) {
    await owner();
    const series = await value<string>(
      "select id as v from public.tutor_class_note_series where handoff_id=$1",
      [f.missedLessonHandoffId],
    );
    const provenance = await value<string>(
      "select id as v from public.academic_agent_execution_provenance where tutor_lab_execution_id=$1",
      [executionId],
    );
    await denied(
      "insert into public.tutor_class_note_revisions(series_id,student_id,revision_number,source_tutor_execution_id,source_provenance_id,body,body_sha256) values($1,$2,1,$3,$4,'Direct',repeat('0',64))",
      [series, learner, executionId, provenance],
      "TUTOR_CLASS_NOTE_SOURCE_INVALID",
    );
  }

  it("refuses a direct revision from a SUCCEEDED Tutor execution whose release never closed COMPLETED", async () => {
    const first = await execute(f.missedLessonHandoffId);
    await record({ executionId: first.executionId, body: "Series exists" });
    const unclosed = await execute(f.missedLessonHandoffId, SUCCEEDED, {
      closeRelease: false,
    });
    await directInsert(unclosed.executionId);
  });

  it("refuses a direct revision whose release scope does not match the series (objective)", async () => {
    const first = await execute(f.missedLessonHandoffId);
    await record({ executionId: first.executionId, body: "Series exists" });
    const second = await execute(f.missedLessonHandoffId);
    await owner();
    await f.db.exec(
      "alter table public.tutor_lab_content_releases disable trigger guard_tutor_lab_release_history",
    );
    await f.db.query(
      "update public.tutor_lab_content_releases set objective_id=$2 where id=$1",
      [second.releaseId, f.objectiveId],
    );
    await f.db.exec(
      "alter table public.tutor_lab_content_releases enable trigger guard_tutor_lab_release_history",
    );
    await directInsert(second.executionId);
  });
});

describe("AC-4 independent-review corrections: note choice in the reservation fingerprint", () => {
  it("the same idempotency key cannot silently switch the note choice (real migration-028 reservation RPC)", async () => {
    const hash = (save: boolean) =>
      sha256(
        tutorLabInteractionFingerprintMaterial(
          f.missedLessonHandoffId,
          "Explain least privilege",
          save,
        ),
      );
    const reserve = (key: string, requestHash: string) =>
      value<{ ok: boolean; duplicate?: boolean; code?: string }>(
        "select public.reserve_tutor_lab_interaction($1,$2,$3) as v",
        [f.missedLessonHandoffId, key, requestHash],
      );
    await user(1);
    const noNoteKey = randomUUID();
    expect(await reserve(noNoteKey, hash(false))).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(await reserve(noNoteKey, hash(true))).toEqual({
      ok: false,
      code: "DUPLICATE_KEY_CONFLICT",
    });
    expect(await reserve(noNoteKey, hash(false))).toEqual({
      ok: true,
      duplicate: true,
    });
    const noteKey = randomUUID();
    expect(await reserve(noteKey, hash(true))).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(await reserve(noteKey, hash(false))).toEqual({
      ok: false,
      code: "DUPLICATE_KEY_CONFLICT",
    });
    expect(await reserve(noteKey, hash(true))).toEqual({
      ok: true,
      duplicate: true,
    });
  });
});
