import { randomUUID } from "node:crypto";
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
  foreignLearner,
  type TutorLabFixture,
} from "./tutor-lab-fixture";
import {
  signedTutorLabCommand,
  sendTutorLabCommand,
} from "./tutor-lab-provider-execution-fixture";

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

async function value<T = string>(sql: string, args: unknown[] = []) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function user(n: number | null) {
  await asExecutionUser(f.db, n);
}
async function owner() {
  await f.db.exec("reset role");
}
async function open(handoffId: string) {
  return (
    await f.db.query<{ value: unknown }>(
      "select public.begin_tutor_lab_content_release($1,$2) as value",
      [randomUUID(), handoffId],
    )
  ).rows[0].value as
    | {
        ok: true;
        role: string;
        reason_code: string;
        release_id: string;
        enrolment_id: string;
        lesson_id: string;
        objective_id: string | null;
        practical_id: string | null;
      }
    | { ok: false; code: string };
}
async function reserve(handoffId: string, key: string, hash = "a".repeat(64)) {
  return (
    await f.db.query<{ value: unknown }>(
      "select public.reserve_tutor_lab_interaction($1,$2,$3) as value",
      [handoffId, key, hash],
    )
  ).rows[0].value as
    { ok: true; duplicate: boolean } | { ok: false; code: string };
}
async function denied(sql: string, args: unknown[] = [], message?: string) {
  await f.db.exec("savepoint denial");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await f.db.exec("rollback to savepoint denial;release savepoint denial");
  }
}

describe("Tutor/Lab handoff ownership and role routing", () => {
  it("learner opens their own MISSED_LESSON_PRACTICE handoff as TUTOR", async () => {
    await user(1);
    const result = await open(f.missedLessonHandoffId);
    expect(result).toMatchObject({
      ok: true,
      role: "TUTOR",
      reason_code: "MISSED_LESSON_PRACTICE",
    });
  });
  it("learner opens their own OBJECTIVE_REINFORCEMENT handoff as TUTOR with the exact objective and reason (Blocker 2 regression: never the role name)", async () => {
    await user(1);
    const result = await open(f.objectiveReinforcementHandoffId);
    expect(result).toMatchObject({
      ok: true,
      role: "TUTOR",
      reason_code: "OBJECTIVE_REINFORCEMENT",
    });
    if (result.ok) expect(result.objective_id).toBe(f.objectiveId);
  });
  it("learner opens their own PRACTICAL_PREREQUISITE handoff as TUTOR (no practical bound), with the exact reason", async () => {
    await user(1);
    const result = await open(f.practicalPrerequisiteHandoffId);
    expect(result).toMatchObject({
      ok: true,
      role: "TUTOR",
      reason_code: "PRACTICAL_PREREQUISITE",
      practical_id: null,
    });
  });
  it("learner opens their own PRACTICAL_HELP handoff as LAB_INSTRUCTOR with the exact practical and reason", async () => {
    await user(1);
    const result = await open(f.practicalHelpHandoffId);
    expect(result).toMatchObject({
      ok: true,
      role: "LAB_INSTRUCTOR",
      reason_code: "PRACTICAL_HELP",
      practical_id: f.labPracticalId,
    });
  });
  it("a forged/nonexistent handoff id fails closed", async () => {
    await user(1);
    const result = await open(randomUUID());
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
  it("another student cannot open this learner's handoff", async () => {
    await user(3);
    const result = await open(f.missedLessonHandoffId);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
  it("ACADEMIC_ADMIN alone cannot impersonate a learner support call", async () => {
    await owner();
    await f.db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [foreignLearner],
    );
    await user(3);
    const result = await open(f.missedLessonHandoffId);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
  it("unauthenticated caller is refused", async () => {
    await user(null);
    const result = await open(f.missedLessonHandoffId);
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });
});

describe("Tutor/Lab reason-code selector requirements fail closed", () => {
  // Migration 023's request_delivery_handoff (historical, unmodified) itself
  // permits an OBJECTIVE_REINFORCEMENT handoff with a null objective -- the
  // selector requirement this checkpoint adds is enforced one layer later,
  // at execution time (begin_tutor_lab_content_release), so an already-
  // created such handoff must still fail closed there rather than ever
  // reaching an executable release.
  it("OBJECTIVE_REINFORCEMENT with no objective opens as a handoff but is rejected at execution time", async () => {
    await user(1);
    const handoffId = await value(
      "select public.request_delivery_handoff($1,$2,null,'OBJECTIVE_REINFORCEMENT',$3) as v",
      [f.learnerEnrolmentId, f.lessonId, randomUUID()],
    );
    const result = await open(handoffId);
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("Tutor/Lab idempotency", () => {
  it("K1 accepted, K2 accepted, K1 replay is a safe duplicate, K2 replay also still a duplicate", async () => {
    await user(1);
    const k1Key = randomUUID(),
      k2Key = randomUUID();
    const k1 = await reserve(f.missedLessonHandoffId, k1Key, "a".repeat(64));
    expect(k1).toMatchObject({ ok: true, duplicate: false });
    const k2 = await reserve(f.missedLessonHandoffId, k2Key, "b".repeat(64));
    expect(k2).toMatchObject({ ok: true, duplicate: false });
    const k1Replay = await reserve(
      f.missedLessonHandoffId,
      k1Key,
      "a".repeat(64),
    );
    expect(k1Replay).toMatchObject({ ok: true, duplicate: true });
    const k2Replay = await reserve(
      f.missedLessonHandoffId,
      k2Key,
      "b".repeat(64),
    );
    expect(k2Replay).toMatchObject({ ok: true, duplicate: true });
  });
  it("same key with a different message/handoff fingerprint fails closed as a conflict", async () => {
    await user(1);
    const key = randomUUID();
    await reserve(f.missedLessonHandoffId, key, "a".repeat(64));
    const conflict = await reserve(
      f.objectiveReinforcementHandoffId,
      key,
      "c".repeat(64),
    );
    expect(conflict).toMatchObject({
      ok: false,
      code: "DUPLICATE_KEY_CONFLICT",
    });
  });
  it("a different learner's identical key is independently reservable (never a global key namespace)", async () => {
    await user(2);
    const foreignEnrolmentId = await value(
      "select public.create_enrolment($1,$2,'Tutor/Lab second-learner fixture') as v",
      [foreignLearner, f.cohortId],
    );
    await user(3);
    const foreignHandoffId = await value(
      "select public.request_delivery_handoff($1,$2,null,'MISSED_LESSON_PRACTICE',$3) as v",
      [foreignEnrolmentId, f.lessonId, randomUUID()],
    );
    const sharedKey = randomUUID();
    const mine = await (async () => {
      await user(1);
      return reserve(f.missedLessonHandoffId, sharedKey, "d".repeat(64));
    })();
    expect(mine).toMatchObject({ ok: true, duplicate: false });
    await user(3);
    const theirs = await reserve(foreignHandoffId, sharedKey, "e".repeat(64));
    expect(theirs).toMatchObject({ ok: true, duplicate: false });
  });
  it("reservation rows are immutable and contain no learner prose", async () => {
    await user(1);
    await reserve(f.missedLessonHandoffId, randomUUID(), "f".repeat(64));
    await owner();
    await denied(
      "update public.tutor_lab_interaction_reservations set reserved_at=clock_timestamp()",
    );
    await denied("delete from public.tutor_lab_interaction_reservations");
    const columns = await value<string>(
      "select string_agg(column_name,',') as v from information_schema.columns where table_name='tutor_lab_interaction_reservations'",
    );
    expect(columns).not.toMatch(/message|prompt|response/i);
  });
});

describe("Tutor/Lab content-release lifecycle and assessment firewall", () => {
  it("release opens ACTIVE and closes COMPLETED on success", async () => {
    await user(1);
    const opened = await open(f.missedLessonHandoffId);
    if (!opened.ok) throw new Error("expected success");
    const closed = await value<{ ok: boolean; state: string }>(
      "select public.close_tutor_lab_content_release($1,true) as v",
      [opened.release_id],
    );
    expect(closed).toMatchObject({ ok: true, state: "COMPLETED" });
  });
  it("controlled assessment ACTIVE blocks release opening, even for a valid pre-existing handoff", async () => {
    await user(1);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const result = await open(f.practicalPrerequisiteHandoffId);
    expect(result).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
  });
  it("controlled assessment ACTIVE blocks Lab release opening too", async () => {
    await user(1);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const result = await open(f.practicalHelpHandoffId);
    expect(result).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
  });
  // Documentation truth-sync (independent review): an ACTIVITY_BLOCKED
  // denial is NOT "no release row exists" -- migration 028 deliberately
  // persists one terminal BLOCKED release receipt (immutable denial/audit
  // provenance, itself fail-closed) before returning the denial. This test
  // proves the row exists AND that it is structurally never usable as
  // ACTIVE content-release authority: it cannot be closed as a successful
  // completion, and it authorizes zero provider executions.
  it("an ACTIVITY_BLOCKED denial persists a terminal BLOCKED release receipt, distinct from ACTIVE content-release authority", async () => {
    await user(1);
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const invocationId = randomUUID();
    const result = (
      await f.db.query<{ value: unknown }>(
        "select public.begin_tutor_lab_content_release($1,$2) as value",
        [invocationId, f.practicalPrerequisiteHandoffId],
      )
    ).rows[0].value as { ok: false; code: string };
    expect(result).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });

    // Direct table reads require owner privileges (learners/authenticated
    // have none -- see "Tutor/Lab ACL hardening" below); this is a
    // privileged provenance check, not something the learner's own role
    // could read.
    await owner();
    const row = (
      await f.db.query<{
        id: string;
        state: string;
        terminal_at: string | null;
      }>(
        "select id, state, terminal_at from public.tutor_lab_content_releases where invocation_id=$1",
        [invocationId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.state).toBe("BLOCKED");
    expect(row.terminal_at).not.toBeNull();

    // The receipt is inert: it can never be completed as a successful
    // content release (state<>'ACTIVE' short-circuits close as a no-op).
    await user(1);
    const closed = await value<{
      ok: boolean;
      state: string;
      transitioned: boolean;
    }>("select public.close_tutor_lab_content_release($1,true) as v", [row.id]);
    expect(closed).toEqual({ ok: true, state: "BLOCKED", transitioned: false });

    // And it authorized zero provider executions.
    await owner();
    const executionCount = await value<string>(
      "select count(*)::text as v from public.tutor_lab_provider_executions where release_id=$1",
      [row.id],
    );
    expect(executionCount).toBe("0");
  });
});

describe("Tutor/Lab governed provider execution (AUTHORIZE/START/FINALIZE)", () => {
  async function openRelease(handoffId: string, role: string) {
    await user(1);
    const opened = await open(handoffId);
    if (!opened.ok) throw new Error("expected release to open");
    expect(opened.role).toBe(role);
    return opened;
  }
  it("AUTHORIZE, START and FINALIZE succeed in order for a TUTOR execution", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    const executionId = randomUUID();
    const authorize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
      }),
    );
    expect(authorize).toMatchObject({
      ok: true,
      execution: { state: "AUTHORIZED" },
    });
    const start = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    expect(start).toMatchObject({ ok: true, execution: { state: "RUNNING" } });
    const finalize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
        operation: "FINALIZE",
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
        output: 100,
        cost: 500,
      }),
    );
    expect(finalize).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
  });
  it("a Professor V2 attestation cannot authorize a Tutor/Lab transition (wrong protocol tag/table)", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    // govern_professor_provider_execution looks up its release from
    // academic_content_releases (Professor-only); this Tutor/Lab release
    // lives in the separate tutor_lab_content_releases table entirely, so
    // it is CONTENT_RELEASE_UNAVAILABLE there regardless of the MAC -- the
    // two governance surfaces are structurally unable to see each other's
    // releases at all, a stronger guarantee than a MAC mismatch alone.
    const result = await value<{ ok: boolean; code?: string }>(
      "select public.govern_professor_provider_execution($1,$2,$3,'AUTHORIZE','AUTHORIZED','NONE','NONE',1,700,30000,0,0,0,0,0,0,$4,$5,$6) as v",
      [
        f.keyId,
        randomUUID(),
        release.release_id,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000) + 10,
        "a".repeat(64),
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(undefined);
  });
  it("a LAB_INSTRUCTOR-labelled AUTHORIZE cannot bind to a TUTOR release", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    const result = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "LAB_INSTRUCTOR",
        releaseId: release.release_id,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "CONTEXT_CONFLICT" });
  });
  it("a proposal above the DB ceiling is rejected at the cryptographic layer (UNTRUSTED_EXECUTION), never reaching AUTHORIZE's own business logic", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    const result = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        releaseId: release.release_id,
        maxOutput: 5000,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });
  it("a degenerate zero-budget proposal (within crypto bounds) is rejected by AUTHORIZE's own OUT_OF_ENVELOPE business logic", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    const result = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        releaseId: release.release_id,
        maxOutput: 0,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      execution: { state: "BLOCKED", reasonCode: "OUT_OF_ENVELOPE" },
    });
  });
  it("FINALIZE reporting output/cost above the admitted execution's own ceiling is rejected", async () => {
    const release = await openRelease(f.missedLessonHandoffId, "TUTOR");
    const executionId = randomUUID();
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
        maxOutput: 500,
      }),
    );
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    const finalize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: release.release_id,
        operation: "FINALIZE",
        state: "SUCCEEDED",
        reason: "PROVIDER_COMPLETE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
        output: 9999,
      }),
    );
    expect(finalize).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("Practical provenance and cross-lesson/cross-version isolation", () => {
  it("the practical/objective link cannot be forged; get_owned_practical resolves only the caller's own activated practical", async () => {
    await user(1);
    const result = await value<{ id: string; objectiveIds: string[] }>(
      "select public.get_owned_practical($1,$2) as v",
      [f.learnerEnrolmentId, f.labPracticalId],
    );
    expect(result.id).toBe(f.labPracticalId);
    expect(result.objectiveIds).toContain(f.objectiveId);
  });
  it("a foreign learner cannot resolve another student's practical", async () => {
    await user(3);
    await denied("select public.get_owned_practical($1,$2)", [
      f.learnerEnrolmentId,
      f.labPracticalId,
    ]);
  });
  it("tutor_lab_handoff_practicals is immutable", async () => {
    await owner();
    await denied(
      "update public.tutor_lab_handoff_practicals set practical_id=gen_random_uuid()",
    );
    await denied("delete from public.tutor_lab_handoff_practicals");
  });
});

describe("Tutor/Lab ACL hardening", () => {
  const tables = [
    "tutor_lab_handoff_practicals",
    "tutor_lab_content_releases",
    "tutor_lab_provider_executions",
    "tutor_lab_provider_execution_usage",
    "tutor_lab_interaction_reservations",
  ];
  it.each(["anon", "authenticated", "service_role"])(
    "%s has no direct table/column/private-schema privileges",
    async (role) => {
      await owner();
      for (const t of tables) {
        expect(
          await value<boolean>("select has_table_privilege($1,$2,$3) as v", [
            role,
            "public." + t,
            "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER",
          ]),
        ).toBe(false);
      }
      expect(
        await value<boolean>(
          "select has_schema_privilege($1,'tutor_lab_execution_private','USAGE,CREATE') as v",
          [role],
        ),
      ).toBe(false);
    },
  );
  it("service_role cannot invoke governed RPCs or read protected tables directly", async () => {
    await owner();
    await f.db.exec("set role service_role");
    await denied(
      "select public.begin_tutor_lab_content_release($1,$2)",
      [randomUUID(), randomUUID()],
      "permission denied",
    );
    await denied(
      "select * from public.tutor_lab_provider_executions",
      [],
      "permission denied",
    );
  });
  it("audit_events for Tutor/Lab lifecycle contain no learner message or provider content", async () => {
    await user(1);
    const opened = await open(f.missedLessonHandoffId);
    if (!opened.ok) throw new Error("expected success");
    await owner();
    const audit = await value<unknown>(
      "select jsonb_agg(after_state) as v from public.audit_events where source in ('TUTOR_LAB_SUPPORT_V1','ATTESTED_EXECUTION_CONTROLLER','DATABASE_EXECUTION_POLICY')",
    );
    expect(JSON.stringify(audit)).not.toMatch(
      /instructions|Exercise instructions sentinel|Lab instructions sentinel/,
    );
  });
});

describe("No institutional side effects", () => {
  it("opening a release and reserving an interaction never touches attendance/evidence/mastery/progress", async () => {
    await user(1);
    await open(f.missedLessonHandoffId);
    await reserve(f.missedLessonHandoffId, randomUUID(), "9".repeat(64));
    await owner();
    for (const t of [
      "attendance_records",
      "learning_evidence",
      "objective_mastery",
      "lesson_progress",
    ]) {
      expect(
        await value<number>(
          "select count(*)::int as v from public." +
            t +
            " where enrolment_id=$1",
          [f.learnerEnrolmentId],
        ),
      ).toBe(0);
    }
  });
});

describe("Practical handoff replay conflict (Blocker 1 regression)", () => {
  it("PRACTICAL_LAB: same request_id + same practical is idempotent; same request_id + a DIFFERENT same-kind practical in the same lesson fails CONTEXT_CONFLICT, and the stored link is never overwritten", async () => {
    await user(1);
    const requestId = randomUUID();
    const first = await value(
      "select public.request_practical_support($1,$2,$3) as v",
      [f.learnerEnrolmentId, f.labPracticalId, requestId],
    );
    // K + practical A replay -> succeeds/idempotently returns same handoff.
    const replaySame = await value(
      "select public.request_practical_support($1,$2,$3) as v",
      [f.learnerEnrolmentId, f.labPracticalId, requestId],
    );
    expect(replaySame).toBe(first);
    // K + practical B (same kind, same lesson) -> fails CONTEXT_CONFLICT.
    await denied(
      "select public.request_practical_support($1,$2,$3)",
      [f.learnerEnrolmentId, f.labPracticalId2, requestId],
      "CONTEXT_CONFLICT",
    );
    await owner();
    // The stored link remains practical A; no second provenance row exists.
    const link = await value<string>(
      "select practical_id as v from public.tutor_lab_handoff_practicals where handoff_id=$1",
      [first],
    );
    expect(link).toBe(f.labPracticalId);
    const linkCount = await value<number>(
      "select count(*)::int as v from public.tutor_lab_handoff_practicals where handoff_id=$1",
      [first],
    );
    expect(linkCount).toBe(1);
  });
  it("the same ambiguity applies to EXERCISE/PRACTICAL_PREREQUISITE", async () => {
    await user(1);
    const requestId = randomUUID();
    const first = await value(
      "select public.request_practical_support($1,$2,$3) as v",
      [f.learnerEnrolmentId, f.exercisePracticalId, requestId],
    );
    const replaySame = await value(
      "select public.request_practical_support($1,$2,$3) as v",
      [f.learnerEnrolmentId, f.exercisePracticalId, requestId],
    );
    expect(replaySame).toBe(first);
    await denied(
      "select public.request_practical_support($1,$2,$3)",
      [f.learnerEnrolmentId, f.exercisePracticalId2, requestId],
      "CONTEXT_CONFLICT",
    );
    await owner();
    const link = await value<string>(
      "select practical_id as v from public.tutor_lab_handoff_practicals where handoff_id=$1",
      [first],
    );
    expect(link).toBe(f.exercisePracticalId);
    const linkCount = await value<number>(
      "select count(*)::int as v from public.tutor_lab_handoff_practicals where handoff_id=$1",
      [first],
    );
    expect(linkCount).toBe(1);
  });
});

describe("Reservation proves handoff ownership before insert (Blocker 5 regression)", () => {
  it("the owning learner can reserve against their own handoff", async () => {
    await user(1);
    const result = await reserve(f.missedLessonHandoffId, randomUUID());
    expect(result).toMatchObject({ ok: true, duplicate: false });
  });
  it("a foreign learner cannot reserve against another learner's real handoff -- and gets the identical bounded outcome a nonexistent UUID would", async () => {
    await user(3);
    const foreignReal = await reserve(f.missedLessonHandoffId, randomUUID());
    const nonexistent = await reserve(randomUUID(), randomUUID());
    expect(foreignReal).toEqual(nonexistent);
    expect(foreignReal).toMatchObject({
      ok: false,
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
  });
  it("zero reservation rows are created for a denied (foreign/nonexistent) call", async () => {
    await user(3);
    const key = randomUUID();
    await reserve(f.missedLessonHandoffId, key);
    await owner();
    const count = await value<number>(
      "select count(*)::int as v from public.tutor_lab_interaction_reservations where idempotency_key=$1",
      [key],
    );
    expect(count).toBe(0);
  });
  it("a multi-role STUDENT+staff account gains no broader reservation scope", async () => {
    await owner();
    await f.db.query(
      "insert into public.role_grants values($1,'ACADEMIC_ADMIN')",
      [foreignLearner],
    );
    await user(3);
    const result = await reserve(f.missedLessonHandoffId, randomUUID());
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

describe("Assessment firewall: time-of-check/time-of-use transitions (security acceptance gap)", () => {
  it("A: release already open, then assessment starts, then AUTHORIZE is blocked with zero successful execution authority", async () => {
    const release = await (async () => {
      await user(1);
      const opened = await open(f.missedLessonHandoffId);
      if (!opened.ok) throw new Error("expected release to open while NORMAL");
      return opened;
    })();
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const authorize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        releaseId: release.release_id,
      }),
    );
    expect(authorize).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
    await owner();
    const executions = await value<number>(
      "select count(*)::int as v from public.tutor_lab_provider_executions where release_id=$1",
      [release.release_id],
    );
    expect(executions).toBe(0);
  });
  it("B: AUTHORIZE already succeeded while NORMAL, then assessment starts, then START is blocked with a terminal safe failure", async () => {
    await user(1);
    const opened = await open(f.missedLessonHandoffId);
    if (!opened.ok) throw new Error("expected release to open while NORMAL");
    const executionId = randomUUID();
    const authorize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: opened.release_id,
      }),
    );
    expect(authorize).toMatchObject({
      ok: true,
      execution: { state: "AUTHORIZED" },
    });
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const start = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: opened.release_id,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    expect(start).toMatchObject({ ok: false, code: "ACTIVITY_BLOCKED" });
    await owner();
    const row = await value<{ state: string }>(
      "select row_to_json(e) as v from public.tutor_lab_provider_executions e where id=$1",
      [executionId],
    );
    expect(row.state).toBe("FAILED");
  });
  it("C: context-build race -- once a controlled assessment becomes active, the underlying context reads fail closed even against an already-open release", async () => {
    await user(1);
    const opened = await open(f.practicalHelpHandoffId);
    if (!opened.ok) throw new Error("expected release to open while NORMAL");
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    // get_owned_practical is the exact RPC Lab context construction calls;
    // it independently re-enforces the same EXPLAIN firewall.
    await denied(
      "select public.get_owned_practical($1,$2)",
      [f.learnerEnrolmentId, f.labPracticalId],
      "blocked",
    );
  });
  it("D: release-close race -- a normal execution that reached RUNNING while NORMAL cannot COMPLETE once a controlled assessment becomes active; successful content never escapes", async () => {
    await user(1);
    const opened = await open(f.missedLessonHandoffId);
    if (!opened.ok) throw new Error("expected release to open while NORMAL");
    const executionId = randomUUID();
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: opened.release_id,
      }),
    );
    await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: opened.release_id,
        operation: "START",
        state: "RUNNING",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    // Provider output is now held internally (simulated: nothing has been
    // sent to FINALIZE yet). Assessment becomes active before close.
    await f.db.query("select public.start_assessment_attempt($1)", [
      f.assessmentId,
    ]);
    const closed = await value<{
      ok: boolean;
      state: string;
      transitioned: boolean;
    }>("select public.close_tutor_lab_content_release($1,true) as v", [
      opened.release_id,
    ]);
    // complete=true was requested, but the release refuses to report
    // COMPLETED once the firewall is active -- it ABORTS instead, exactly
    // the signal the TS composition boundary uses to discard any provider
    // success and FINALIZE the execution as a safe failure instead.
    expect(closed).toMatchObject({ ok: true, state: "ABORTED" });
    // The execution itself is still only ever finalizable as a genuine
    // failure from here on in the real composition flow (src/server/
    // tutor-lab-execution/index.ts): FINALIZE has no activity check of its
    // own by design (it always runs strictly after the release has already
    // closed), but the composition boundary never calls it with SUCCEEDED
    // once closeTutorLabContentRelease has thrown on a mismatched ABORTED
    // result -- see tests/tutor-lab-execution-runtime.test.ts's dedicated
    // "release-close failure discards a genuine provider success" case.
    const finalize = await sendTutorLabCommand(
      f.db,
      signedTutorLabCommand(f, {
        role: "TUTOR",
        executionId,
        releaseId: opened.release_id,
        operation: "FINALIZE",
        state: "FAILED",
        reason: "CONTENT_RELEASE_UNAVAILABLE",
        maxCalls: 0,
        maxOutput: 0,
        maxCost: 0,
      }),
    );
    expect(finalize).toMatchObject({
      ok: true,
      execution: { state: "FAILED" },
    });
  });
});

describe("Migrations 001-027 remain untouched by this fixture", () => {
  it("delivery_handoffs still enforces status='OPEN' and remains immutable", async () => {
    await owner();
    await denied(
      "update public.delivery_handoffs set status='RESOLVED' where id=$1",
      [f.missedLessonHandoffId],
      "immutable",
    );
  });
});
