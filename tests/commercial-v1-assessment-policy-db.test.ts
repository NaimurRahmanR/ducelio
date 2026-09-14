import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  administrator,
  COMPONENTS,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";

async function value<T = string>(
  f: AssessmentPolicyFixture,
  sql: string,
  args: unknown[] = [],
) {
  return (await f.db.query<{ v: T }>(sql, args)).rows[0].v;
}
// For a multi-column SELECT (not a single value aliased `as v`).
async function row<T>(
  f: AssessmentPolicyFixture,
  sql: string,
  args: unknown[] = [],
) {
  return (await f.db.query<T>(sql, args)).rows[0];
}
async function owner(f: AssessmentPolicyFixture) {
  await f.db.exec("reset role");
}
async function asLearner(f: AssessmentPolicyFixture) {
  await asPolicyUser(f.db, 1);
}
async function asForeign(f: AssessmentPolicyFixture) {
  await asPolicyUser(f.db, 3);
}
async function startAttempt(f: AssessmentPolicyFixture, assessmentId: string) {
  const id = await value<string>(
    f,
    "select public.start_assessment_attempt($1) as v",
    [assessmentId],
  );
  return row<{ id: string; started_at: string; expires_at: string }>(
    f,
    "select id,started_at,expires_at from public.assessment_attempts where id=$1",
    [id],
  );
}
// Test-only time simulation: the guard_assessment_attempt_history trigger
// (migration 016) makes expires_at immutable for EVERY caller, including the
// owning role -- by design, since no institutional timestamp may ever be
// rewritten in production. There is no deterministic clock-injection helper
// in this harness (see db-helper.ts), so, exactly like this same test suite
// disabling academy_identity around raw auth.users seeding, the trigger is
// disabled for the single owner-level UPDATE that simulates "time has
// already passed" and immediately re-enabled -- a test-only technique, never
// something any governed RPC does.
async function forceExpire(f: AssessmentPolicyFixture, attemptId: string) {
  await owner(f);
  await f.db.exec(
    "alter table public.assessment_attempts disable trigger guard_assessment_attempt_history",
  );
  // expires_at must stay strictly after started_at (a CHECK constraint from
  // migration 016, unrelated to and unrelaxed by this checkpoint), so this
  // sets it to started_at + 1ms -- already safely in the past relative to
  // "now" by the time any subsequent statement runs (multiple further
  // awaited round-trips), without ever violating that constraint.
  await f.db.query(
    "update public.assessment_attempts set expires_at=started_at+interval '1 millisecond' where id=$1",
    [attemptId],
  );
  await f.db.exec(
    "alter table public.assessment_attempts enable trigger guard_assessment_attempt_history",
  );
}
async function denied(
  f: AssessmentPolicyFixture,
  sql: string,
  args: unknown[] = [],
  message?: string,
) {
  await f.db.exec("savepoint denial");
  try {
    await expect(f.db.query(sql, args)).rejects.toThrow(message);
  } finally {
    await f.db.exec("rollback to savepoint denial;release savepoint denial");
  }
}

// =============================================================================
// GRADING POLICY -- WITH LABS
// =============================================================================
describe("Grading policy: WITH_LABS profile", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  it("publishes for a course with a PRACTICAL_LAB and resolves WITH_LABS with exact basis-point weights", async () => {
    await owner(f);
    const policy = await row<{
      resolved_profile: string;
      quiz_1_weight_bp: number;
      quiz_2_weight_bp: number;
      midterm_weight_bp: number;
      quiz_3_weight_bp: number;
      quiz_4_weight_bp: number;
      labs_weight_bp: number;
      final_weight_bp: number;
    }>(
      f,
      "select resolved_profile,quiz_1_weight_bp,quiz_2_weight_bp,midterm_weight_bp,quiz_3_weight_bp,quiz_4_weight_bp,labs_weight_bp,final_weight_bp from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
    );
    expect(policy.resolved_profile).toBe("WITH_LABS");
    expect(policy.quiz_1_weight_bp).toBe(500);
    expect(policy.quiz_2_weight_bp).toBe(500);
    expect(policy.midterm_weight_bp).toBe(2000);
    expect(policy.quiz_3_weight_bp).toBe(500);
    expect(policy.quiz_4_weight_bp).toBe(500);
    expect(policy.labs_weight_bp).toBe(2000);
    expect(policy.final_weight_bp).toBe(4000);
    const total =
      policy.quiz_1_weight_bp +
      policy.quiz_2_weight_bp +
      policy.midterm_weight_bp +
      policy.quiz_3_weight_bp +
      policy.quiz_4_weight_bp +
      policy.labs_weight_bp +
      policy.final_weight_bp;
    expect(total).toBe(10000);
  });
});

describe("Grading policy: NO_LABS profile", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: false });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  it("publishes for a course with zero PRACTICAL_LAB activities and resolves NO_LABS with exact basis-point weights", async () => {
    await owner(f);
    const policy = await row<{
      resolved_profile: string;
      labs_weight_bp: number;
      final_weight_bp: number;
    }>(
      f,
      "select resolved_profile,labs_weight_bp,final_weight_bp from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
    );
    expect(policy.resolved_profile).toBe("NO_LABS");
    expect(policy.labs_weight_bp).toBe(0);
    expect(policy.final_weight_bp).toBe(6000);
  });
});

// =============================================================================
// PROFILE INTEGRITY
// =============================================================================
describe("Profile integrity: caller cannot choose profile or supply weights", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());

  it("publish_commercial_v1_grading_policy accepts only (activation_id, reason) -- no weight/profile parameter exists to supply", async () => {
    // Calling with any additional positional argument is a hard SQL arity
    // error, not a soft validation failure -- there is structurally no
    // parameter through which a caller could smuggle a profile or weight.
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query(
        "select public.publish_commercial_v1_grading_policy($1,$2,$3)",
        [f.activationId, "reason", "NO_LABS"],
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });

  it("the published policy is immutable: direct UPDATE/DELETE are rejected even as owner-adjacent roles", async () => {
    await f.db.exec("begin");
    await denied(
      f,
      "update public.commercial_v1_grading_policies set labs_weight_bp=0 where activation_id=$1",
      [f.activationId],
      "immutable",
    );
    await denied(
      f,
      "delete from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
      "immutable",
    );
    await f.db.exec("rollback;reset role");
  });

  it("a later component-binding rebind attempt fails once the policy is published (bindings frozen)", async () => {
    await f.db.exec("begin");
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query(
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
        [
          f.activationId,
          "QUIZ_1",
          f.assessmentIds.QUIZ_2,
          "Attempt rebind after publish",
        ],
      ),
    ).rejects.toThrow("POLICY_ALREADY_PUBLISHED");
    await f.db.exec("rollback;reset role");
  });

  it("publication is a no-op replay returning the same immutable policy, never mutating it", async () => {
    await f.db.exec("begin");
    await asPolicyUser(f.db, 2);
    const replay = await value(
      f,
      "select public.publish_commercial_v1_grading_policy($1,$2) as v",
      [f.activationId, "Replay publish"],
    );
    expect(replay).toBe(f.activationId);
    await f.db.exec("reset role");
    await owner(f);
    const count = await value<string>(
      f,
      "select count(*)::text as v from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
    );
    expect(count).toBe("1");
    await f.db.exec("rollback;reset role");
  });
});

// =============================================================================
// COMPONENT IDENTITY
// =============================================================================
describe("Component identity enforcement", () => {
  it.each(COMPONENTS)(
    // Any single missing component leaves exactly 5 bound rows, which the
    // publish RPC's own binding-count check (binding_count<>6) rejects
    // before ever reaching the per-component MISSING_COMPONENT loop --
    // since the six component names are a fixed, PK-unique domain, "exactly
    // 6 rows bound" and "all six required names present" are equivalent by
    // construction (pigeonhole), so INCOMPLETE_COMPONENT_BINDINGS is the
    // real, reachable error for every single-missing case.
    "a %s left unbound fails publication with INCOMPLETE_COMPONENT_BINDINGS",
    async (missing) => {
      const f = await buildAssessmentPolicyFixture({
        withLabs: true,
        publish: false,
        skipComponents: [missing],
      });
      await asPolicyUser(f.db, 2);
      await expect(
        f.db.query(
          "select public.publish_commercial_v1_grading_policy($1,$2)",
          [f.activationId, `Publish with ${missing} unbound`],
        ),
      ).rejects.toThrow("INCOMPLETE_COMPONENT_BINDINGS");
      await f.db.exec("reset role");
      await f.db.close();
    },
  );

  it("fewer than six bound components fails INCOMPLETE_COMPONENT_BINDINGS before the per-component loop even runs", async () => {
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
      skipComponents: ["FINAL", "QUIZ_4"],
    });
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "Publish with two components unbound",
      ]),
    ).rejects.toThrow("INCOMPLETE_COMPONENT_BINDINGS");
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("duplicate component binding is structurally impossible (primary key), and binding the same assessment to two components fails", async () => {
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
    });
    await asPolicyUser(f.db, 2);
    // Same assessment (QUIZ_1's) bound again under MIDTERM's slot: MIDTERM
    // already holds a DIFFERENT assessment, so this hits the update branch
    // trying to set assessment_id to one already used elsewhere in this
    // activation -- the unique(activation_id, assessment_id) constraint
    // rejects it.
    await expect(
      f.db.query(
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
        [
          f.activationId,
          "MIDTERM",
          f.assessmentIds.QUIZ_1,
          "Duplicate assessment binding",
        ],
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("a foreign activation's assessment (different cohort/programme-version/database) cannot be bound", async () => {
    const a = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
    });
    const b = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
    });
    // b's assessment id was never materialised in a's own database at all
    // (separate PGlite instances), so binding it under a's activation
    // tests a nonexistent ID. A separate same-database regression below proves
    // rejection of an existing assessment owned by another activation.
    await asPolicyUser(a.db, 2);
    await expect(
      a.db.query(
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
        [
          a.activationId,
          "QUIZ_1",
          b.assessmentIds.QUIZ_1,
          "Foreign assessment binding",
        ],
      ),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    await a.db.exec("reset role");
    await a.db.close();
    await b.db.close();
  });

  it("attempts_allowed other than 1 is rejected at bind time, before any component-binding row is created", async () => {
    await expect(
      buildAssessmentPolicyFixture({
        withLabs: true,
        publish: false,
        attemptsAllowedOverride: { QUIZ_1: 2 },
      }),
    ).rejects.toThrow("INVALID_ATTEMPTS_ALLOWED");
  });
});

// =============================================================================
// ORDERING
// =============================================================================
describe("Chronological ordering / non-overlap enforcement", () => {
  it("a valid chronological non-overlapping sequence publishes successfully", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    expect(f.published).toBe(true);
    await f.db.close();
  });

  it("QUIZ_2 scheduled before QUIZ_1 fails publication", async () => {
    const now = new Date();
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
      windows: {
        QUIZ_1: {
          opensAt: new Date(now.getTime() + 4 * 3600_000),
          closesAt: new Date(now.getTime() + 5 * 3600_000),
          durationMinutes: 30,
        },
        QUIZ_2: {
          opensAt: new Date(now.getTime() - 24 * 3600_000),
          closesAt: new Date(now.getTime() - 23 * 3600_000),
          durationMinutes: 30,
        },
      },
    });
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "Publish with QUIZ_2 before QUIZ_1",
      ]),
    ).rejects.toThrow("ASSESSMENT_SEQUENCE_INVALID");
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("MIDTERM scheduled before QUIZ_2 fails publication", async () => {
    const now = new Date();
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
      windows: {
        QUIZ_2: {
          opensAt: new Date(now.getTime() + 8 * 3600_000),
          closesAt: new Date(now.getTime() + 9 * 3600_000),
          durationMinutes: 30,
        },
        MIDTERM: {
          opensAt: new Date(now.getTime() + 4 * 3600_000),
          closesAt: new Date(now.getTime() + 5 * 3600_000),
          durationMinutes: 30,
        },
      },
    });
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "Publish with MIDTERM before QUIZ_2",
      ]),
    ).rejects.toThrow("ASSESSMENT_SEQUENCE_INVALID");
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("FINAL scheduled before QUIZ_4 fails publication", async () => {
    const now = new Date();
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
      windows: {
        QUIZ_4: {
          opensAt: new Date(now.getTime() + 12 * 3600_000),
          closesAt: new Date(now.getTime() + 13 * 3600_000),
          durationMinutes: 30,
        },
        FINAL: {
          opensAt: new Date(now.getTime() + 10 * 3600_000),
          closesAt: new Date(now.getTime() + 11 * 3600_000),
          durationMinutes: 30,
        },
      },
    });
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "Publish with FINAL before QUIZ_4",
      ]),
    ).rejects.toThrow("ASSESSMENT_SEQUENCE_INVALID");
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("overlapping adjacent formal windows fail publication", async () => {
    const now = new Date();
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      publish: false,
      windows: {
        QUIZ_1: {
          opensAt: new Date(now.getTime() - 24 * 3600_000),
          closesAt: new Date(now.getTime() + 5 * 3600_000),
          durationMinutes: 30,
        },
        QUIZ_2: {
          opensAt: new Date(now.getTime() + 4 * 3600_000),
          closesAt: new Date(now.getTime() + 6 * 3600_000),
          durationMinutes: 30,
        },
      },
    });
    await asPolicyUser(f.db, 2);
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "Publish with overlapping QUIZ_1/QUIZ_2",
      ]),
    ).rejects.toThrow("ASSESSMENT_SEQUENCE_INVALID");
    await f.db.exec("reset role");
    await f.db.close();
  });
});

// =============================================================================
// ATTEMPT START / LATEST-START / ONE-SITTING
// =============================================================================
describe("Attempt start: latest-start and full-duration semantics", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  it("a governed assessment can start during its valid window and receives the FULL configured duration, not shortened", async () => {
    await asLearner(f);
    const attempt = await startAttempt(f, f.assessmentIds.QUIZ_1);
    const started = new Date(attempt.started_at).getTime();
    const expires = new Date(attempt.expires_at).getTime();
    expect(expires - started).toBe(60 * 60_000);
  });

  it("client-supplied started_at/expires_at are impossible -- start_assessment_attempt takes only an assessment id", async () => {
    await asLearner(f);
    await expect(
      f.db.query("select public.start_assessment_attempt($1,$2)", [
        f.assessmentIds.QUIZ_2,
        new Date().toISOString(),
      ]),
    ).rejects.toThrow();
  });

  it("cannot start before opens_at", async () => {
    await asLearner(f);
    await expect(
      f.db.query("select public.start_assessment_attempt($1)", [
        f.assessmentIds.QUIZ_2,
      ]),
    ).rejects.toThrow("has not opened");
  });
});

describe("Attempt start: Commercial V1 does not silently shorten a late-starting attempt", () => {
  it("legacy behaviour grants a SHORTENED attempt near closes_at; Commercial V1 refuses the start entirely instead", async () => {
    const now = new Date();
    const tight = {
      opensAt: new Date(now.getTime() - 24 * 3600_000),
      closesAt: new Date(now.getTime() + 30 * 60_000), // 30 minutes remain
      durationMinutes: 60, // longer than what remains
    };
    // Only QUIZ_1's window is overridden; the default QUIZ_2 window
    // (opens +4h) already falls safely after QUIZ_1's new closes_at
    // (+30min), so chronological ordering remains valid without touching
    // the other five components' default windows.
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      windows: { QUIZ_1: tight },
    });
    await owner(f);
    // A sibling LEGACY (non-governed) assessment with the identical tight
    // window/duration, created directly (not bound to any policy).
    const legacyAssessmentId = await value(
      f,
      "select public.create_assessment($1,$2,$3,'Legacy tight window','Independent answer.',$4,$5,$6,1,'Legacy sibling fixture') as v",
      [
        f.cohortId,
        (
          await f.db.query<{ id: string }>(
            "select lesson_id as id from public.course_assessment_bindings where activation_id=$1 limit 1",
            [f.activationId],
          )
        ).rows[0].id,
        administrator,
        tight.opensAt.toISOString(),
        tight.closesAt.toISOString(),
        tight.durationMinutes,
      ],
    );
    await f.db.query(
      "select public.add_assessment_question($1,1,'Legacy prompt',10,'Legacy answer',null,'Legacy sibling question')",
      [legacyAssessmentId],
    );
    await f.db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Publish legacy sibling')",
      [legacyAssessmentId],
    );

    await asPolicyUser(f.db, 1);
    // Legacy path: start succeeds, but the attempt is SHORTENED to whatever
    // remains before closes_at (never the full 60 minutes).
    const legacyAttempt = await startAttempt(f, legacyAssessmentId);
    const legacyDurationMs =
      new Date(legacyAttempt.expires_at).getTime() -
      new Date(legacyAttempt.started_at).getTime();
    expect(legacyDurationMs).toBeLessThan(60 * 60_000);
    expect(legacyDurationMs).toBeGreaterThan(0);

    // Existing-attempt handling precedes all fresh-start availability checks.
    await expect(
      f.db.query("select public.start_assessment_attempt($1)", [
        f.assessmentIds.QUIZ_1,
      ]),
    ).rejects.toThrow(
      "Another controlled assessment attempt is already active",
    );
    await asPolicyUser(f.db, 2);
    await f.db.query(
      "select public.void_assessment_attempt($1,'Finish legacy comparison fixture')",
      [legacyAttempt.id],
    );
    await asPolicyUser(f.db, 1);

    // Commercial V1 (governed) path: the SAME window/duration shape refuses
    // the start outright -- never a shortened attempt.
    await expect(
      f.db.query("select public.start_assessment_attempt($1)", [
        f.assessmentIds.QUIZ_1,
      ]),
    ).rejects.toThrow("closed");

    await f.db.exec("reset role");
    await f.db.close();
  });
});

// =============================================================================
// ONE-SITTING / REPLAY
// =============================================================================
describe("One-sitting replay safety", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  it("a repeated start does not create a new attempt, and never resets started_at/expires_at", async () => {
    await asLearner(f);
    const first = await startAttempt(f, f.assessmentIds.QUIZ_1);
    const second = await startAttempt(f, f.assessmentIds.QUIZ_1);
    expect(second.id).toBe(first.id);
    // pglite parses timestamptz columns into Date objects, so compare by
    // instant (getTime()), not reference identity.
    expect(new Date(second.started_at).getTime()).toBe(
      new Date(first.started_at).getTime(),
    );
    expect(new Date(second.expires_at).getTime()).toBe(
      new Date(first.expires_at).getTime(),
    );
    const count = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_attempts where assessment_id=$1",
      [f.assessmentIds.QUIZ_1],
    );
    expect(count).toBe("1");
  });

  it("resume (get_commercial_v1_active_attempt) returns the SAME active attempt and its true timing", async () => {
    await asLearner(f);
    const started = await startAttempt(f, f.assessmentIds.QUIZ_1);
    const resumed = await value<{
      attemptId: string;
      assessmentId: string;
    }>(f, "select public.get_commercial_v1_active_attempt() as v");
    expect(resumed.attemptId).toBe(started.id);
    expect(resumed.assessmentId).toBe(f.assessmentIds.QUIZ_1);
  });

  it("a foreign learner cannot read or resume another learner's attempt", async () => {
    await asLearner(f);
    const started = await startAttempt(f, f.assessmentIds.QUIZ_1);
    await asForeign(f);
    const resumed = await value<null>(
      f,
      "select public.get_commercial_v1_active_attempt() as v",
    );
    expect(resumed).toBeNull();
    await expect(
      f.db.query("select * from public.assessment_attempts where id=$1", [
        started.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });
});

// =============================================================================
// RESPONSES
// =============================================================================
describe("Response write boundary", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  async function activeAttemptAndQuestion() {
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    // The learner-safe way to discover a question id: the same protected-
    // content release RPC a real client uses, never a direct table read
    // (which RLS denies to a learner entirely).
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    return { attemptId, questionId };
  }

  it("a response succeeds before expiry and stays append-only, via the dedicated Commercial V1 RPC", async () => {
    await asLearner(f);
    const { attemptId, questionId } = await activeAttemptAndQuestion();
    const firstResult = await value<{ ok: boolean; responseId: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'First answer',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(firstResult).toEqual({ ok: true, responseId: expect.any(String) });
    const secondResult = await value<{ ok: boolean; responseId: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Revised answer',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(secondResult.ok).toBe(true);
    expect(secondResult.responseId).not.toBe(firstResult.responseId);
    // authenticated has no direct UPDATE grant at all on assessment_responses
    // (migration 016 grants SELECT only), so the ACL layer alone already
    // blocks a learner; exercising the append-only TRIGGER itself (the
    // second, independent guarantee) requires the owner role, mirroring
    // tests/assessment-workflow.test.ts's own "freezes published assessment
    // questions and answer keys" pattern.
    await owner(f);
    await expect(
      f.db.query(
        "update public.assessment_responses set body='hack' where id=$1",
        [firstResult.responseId],
      ),
    ).rejects.toThrow("append-only");
  });

  it("a foreign learner cannot write against another learner's attempt via the dedicated RPC", async () => {
    await asLearner(f);
    const { attemptId, questionId } = await activeAttemptAndQuestion();
    await asForeign(f);
    const result = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Hijack',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    // Bounded, non-leaking denial -- never distinguishable from "attempt
    // does not exist" (see the NOT_FOUND_OR_FORBIDDEN test group below).
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    const count = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(count).toBe("0");
  });

  it("answer keys and marking guidance remain inaccessible to the learner even mid-attempt", async () => {
    await asLearner(f);
    const { questionId } = await activeAttemptAndQuestion();
    await expect(
      f.db.query(
        "select expected_answer from public.assessment_answer_keys where question_id=$1",
        [questionId],
      ),
    ).rejects.toThrow("permission denied");
  });

  it("a nonexistent attempt id gets the identical NOT_FOUND_OR_FORBIDDEN outcome as a foreign one", async () => {
    await asLearner(f);
    const { questionId } = await activeAttemptAndQuestion();
    const result = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Ghost attempt',$3) as v",
      [randomUUID(), questionId, randomUUID()],
    );
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

// =============================================================================
// LEGACY/GOVERNED RPC MUTUAL EXCLUSION (independent review blocker)
// =============================================================================
describe("Neither response RPC can be used to bypass the other's semantics", () => {
  it("the legacy record_assessment_response is refused for a Commercial V1-governed attempt -- cannot be used as a deadline/finalization bypass", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    await expect(
      f.db.query(
        "select public.record_assessment_response($1,$2,'Bypass attempt',$3)",
        [attemptId, questionId, randomUUID()],
      ),
    ).rejects.toThrow("record_commercial_v1_assessment_response");
    const count = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(count).toBe("0");
    await f.db.close();
  });

  it("the dedicated Commercial V1 RPC is refused for a NON-governed attempt", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await owner(f);
    // A plain, non-activation, non-governed assessment (legacy shape),
    // exactly like tests/assessment-workflow.test.ts's own fixtures.
    const lessonId = await value<string>(
      f,
      "select lesson_id as v from public.course_assessment_bindings where activation_id=$1 limit 1",
      [f.activationId],
    );
    const legacyAssessmentId = await value<string>(
      f,
      "select public.create_assessment($1,$2,$3,'Legacy non-governed quiz','Independent answer.',now()-interval '1 hour',now()+interval '2 hours',30,1,'Legacy sibling fixture') as v",
      [f.cohortId, lessonId, administrator],
    );
    await f.db.query(
      "select public.add_assessment_question($1,1,'Legacy prompt',10,'Legacy answer',null,'Legacy sibling question')",
      [legacyAssessmentId],
    );
    await f.db.query(
      "select public.change_assessment_status($1,'PUBLISHED','Publish legacy sibling')",
      [legacyAssessmentId],
    );
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [legacyAssessmentId],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [legacyAssessmentId],
    );
    const result = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Wrong surface',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(result).toEqual({ ok: false, code: "NOT_COMMERCIAL_V1_GOVERNED" });
    await f.db.close();
  });
});

// =============================================================================
// NORMAL SUBMISSION
// =============================================================================
describe("Normal STUDENT_SUBMIT semantics", () => {
  let f: AssessmentPolicyFixture;
  beforeAll(async () => {
    f = await buildAssessmentPolicyFixture({ withLabs: true });
  });
  afterAll(async () => f.db.close());
  beforeEach(async () => f.db.exec("begin"));
  afterEach(async () => f.db.exec("rollback;reset role"));

  it("a valid pre-expiry submission is provenanced STUDENT_SUBMIT with an authoritative submitted timestamp", async () => {
    await asLearner(f);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    const submitted = await row<{
      state: string;
      submission_provenance: string;
      submitted_at: string | null;
    }>(
      f,
      "select state,submission_provenance,submitted_at from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(submitted.state).toBe("SUBMITTED");
    expect(submitted.submission_provenance).toBe("STUDENT_SUBMIT");
    expect(submitted.submitted_at).not.toBeNull();
  });

  it("a repeated submission is idempotent, never creating duplicate terminal history", async () => {
    await asLearner(f);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    const before = await value<string>(
      f,
      "select submitted_at::text as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    const after = await value<string>(
      f,
      "select submitted_at::text as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(after).toBe(before);
  });
});

// =============================================================================
// AUTO TIMEOUT
// =============================================================================
describe("AUTO_TIMEOUT semantics", () => {
  it("expiry deterministically finalises the attempt as AUTO_TIMEOUT, anchored to expires_at (not a later cleanup time)", async () => {
    const now = new Date();
    const f = await buildAssessmentPolicyFixture({
      withLabs: true,
      windows: {
        QUIZ_1: {
          opensAt: new Date(now.getTime() - 2 * 3600_000),
          closesAt: new Date(now.getTime() + 3 * 3600_000),
          durationMinutes: 60,
        },
      },
    });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    // Simulate elapsed real time deterministically (see forceExpire) rather
    // than waiting out the 1-minute duration in a flaky real-time sleep.
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    await f.db.query("select public.finalize_expired_commercial_v1_attempts()");
    const finalized = await row<{
      state: string;
      submission_provenance: string;
      submitted_at: string;
      expires_at: string;
    }>(
      f,
      "select state,submission_provenance,submitted_at::text,expires_at::text from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(finalized.state).toBe("SUBMITTED");
    expect(finalized.submission_provenance).toBe("AUTO_TIMEOUT");
    expect(finalized.submitted_at).toBe(finalized.expires_at);
    await f.db.close();
  });

  it("the timeout finalizer is idempotent -- repeated calls create no duplicate history", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    await f.db.query("select public.finalize_expired_commercial_v1_attempts()");
    const first = await value<string>(
      f,
      "select submitted_at::text as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    await f.db.query("select public.finalize_expired_commercial_v1_attempts()");
    const second = await value<string>(
      f,
      "select submitted_at::text as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(second).toBe(first);
    const responseCount = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_attempts where id=$1 and state='SUBMITTED'",
      [attemptId],
    );
    expect(responseCount).toBe("1");
    await f.db.close();
  });

  it("a terminal timed-out attempt can never become ACTIVE again via another start call", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    // Any subsequent action against this student lazily finalizes it first
    // (e.g. resume), and the assessment now has exactly one non-voided
    // attempt already consumed (attempts_allowed=1), so a further start
    // must fail rather than reactivate.
    await f.db.query("select public.get_commercial_v1_active_attempt()");
    await expect(
      f.db.query("select public.start_assessment_attempt($1)", [
        f.assessmentIds.QUIZ_1,
      ]),
    ).rejects.toThrow("No assessment attempts remain");
    await f.db.close();
  });

  it("a late student submit past expires_at is truthfully recorded as AUTO_TIMEOUT, never STUDENT_SUBMIT", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    await f.db.query("select public.submit_assessment_attempt($1)", [
      attemptId,
    ]);
    const provenance = await value<string>(
      f,
      "select submission_provenance as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(provenance).toBe("AUTO_TIMEOUT");
    await f.db.close();
  });

  // Independent review blocker: the expired-response path must durably
  // finalize AUTO_TIMEOUT in the SAME governed operation that refuses the
  // write -- never depending on a raised exception that would roll the
  // transition back. record_commercial_v1_assessment_response returns a
  // deterministic jsonb result (never raises) for this exact case.
  it("a response at/after expires_at persists no response AND durably finalizes the attempt AUTO_TIMEOUT in that same call", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    // The institutional "original expires_at" this test anchors against is
    // whatever is CURRENTLY stored on the attempt at the moment of
    // finalization -- forceExpire is the test harness's own stand-in for
    // "authoritative time has now passed the deadline", so the value it
    // sets IS that deadline, read back fresh (never before forceExpire ran,
    // which would capture the pre-simulation value instead).
    const expiresAt = await value<string>(
      f,
      "select expires_at::text as v from public.assessment_attempts where id=$1",
      [attemptId],
    );

    const result = await value<{
      ok: boolean;
      code: string;
      state: string;
      submittedAt: string;
      submissionProvenance: string;
    }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Late write',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    // 5. the mutation itself is refused -- never a fake response id, never
    //    a pretended success.
    expect(result.ok).toBe(false);
    expect(result.code).toBe("EXPIRED");
    // 2. the same governed request durably converges the attempt to
    //    AUTO_TIMEOUT -- visible in this very call's own return value.
    expect(result.state).toBe("SUBMITTED");
    expect(result.submissionProvenance).toBe("AUTO_TIMEOUT");
    // 3. the effective submission timestamp is anchored to the attempt's
    //    ORIGINAL expires_at (captured before forceExpire touched the row),
    //    never to "now".
    expect(new Date(result.submittedAt).getTime()).toBe(
      new Date(expiresAt).getTime(),
    );

    // Do not insert a response row.
    const responseCount = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(responseCount).toBe("0");

    // 6. the timeout transition was NOT rolled back merely because the
    //    response operation was refused -- confirmed by reading the row
    //    back directly (a fresh read, independent of the RPC's own return
    //    value), and durably so a resume/start/read sees it too.
    const persisted = await row<{
      state: string;
      submission_provenance: string;
      submitted_at: string;
    }>(
      f,
      "select state,submission_provenance,submitted_at::text from public.assessment_attempts where id=$1",
      [attemptId],
    );
    expect(persisted.state).toBe("SUBMITTED");
    expect(persisted.submission_provenance).toBe("AUTO_TIMEOUT");
    expect(new Date(persisted.submitted_at).getTime()).toBe(
      new Date(expiresAt).getTime(),
    );

    // 8. a subsequent resume sees the already-terminal state, not stale
    //    ACTIVE.
    const resumed = await value<null>(
      f,
      "select public.get_commercial_v1_active_attempt() as v",
    );
    expect(resumed).toBeNull();

    await f.db.close();
  });

  it("repeated expired-response calls are idempotent -- identical result, no duplicate terminal history", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);

    const first = await value<{
      ok: boolean;
      code: string;
      submittedAt: string;
    }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'First late write',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    const second = await value<{
      ok: boolean;
      code: string;
      submittedAt: string;
    }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Second late write',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(first).toEqual({
      ok: false,
      code: "EXPIRED",
      state: "SUBMITTED",
      submittedAt: first.submittedAt,
      submissionProvenance: "AUTO_TIMEOUT",
    });
    expect(second).toEqual(first);
    const responseCount = await value<string>(
      f,
      "select count(*)::text as v from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(responseCount).toBe("0");
    // Exactly one terminal transition -- state is a single row, but prove
    // no second SUBMITTED-transition audit event was created either.
    await owner(f);
    const auditCount = await value<string>(
      f,
      "select count(*)::text as v from public.audit_events where target_id=$1 and target_type='assessment_attempts' and after_state->>'state'='SUBMITTED'",
      [attemptId],
    );
    expect(auditCount).toBe("1");
    await f.db.close();
  });

  it("previously persisted pre-expiry revisions remain the submitted work after an expired-response call", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const beforeExpiry = await value<{ ok: boolean; responseId: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Valid pre-expiry answer',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(beforeExpiry.ok).toBe(true);

    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    const lateResult = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Late write attempt',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(lateResult).toMatchObject({ ok: false, code: "EXPIRED" });

    const responses = await f.db.query<{ body: string }>(
      "select body from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(responses.rows).toHaveLength(1);
    expect(responses.rows[0].body).toBe("Valid pre-expiry answer");
    await f.db.close();
  });

  it("a foreign student and a cross-attempt call remain refused (NOT_FOUND_OR_FORBIDDEN) even at/after expiry -- no cross-learner AUTO_TIMEOUT leakage", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 3);
    const result = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Foreign late write',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    await owner(f);
    const state = await value<string>(
      f,
      "select state as v from public.assessment_attempts where id=$1",
      [attemptId],
    );
    // A foreign caller's request does not even get to observe or trigger
    // the owner's own finalization -- ownership is proven (and denied)
    // BEFORE the expiry branch is ever reached.
    expect(state).toBe("ACTIVE");
    await f.db.close();
  });

  it("a response comfortably before expiry succeeds; a response at the expiry boundary persists none", async () => {
    // Two ends of the same boundary in one test, both against the same
    // attempt: well before expires_at (large margin, deterministic) versus
    // as close to exactly-at-expiry as this harness can force (expires_at
    // set to started_at+1ms -- a genuinely microsecond-exact wall-clock
    // race is not provable without a clock-injection test helper this
    // harness does not provide; the migration's own comparison operator is
    // `stamp>=expires_at`, so this near-boundary case exercises the same
    // branch a literal exact-instant call would).
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await asPolicyUser(f.db, 1);
    const attemptId = await value<string>(
      f,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const questionId = await value<string>(
      f,
      "select id::text as v from public.get_active_assessment_questions($1) limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const early = await value<{ ok: boolean; responseId: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'Well before expiry',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(early.ok).toBe(true);

    await forceExpire(f, attemptId);
    await asPolicyUser(f.db, 1);
    const atBoundary = await value<{ ok: boolean; code: string }>(
      f,
      "select public.record_commercial_v1_assessment_response($1,$2,'At the boundary',$3) as v",
      [attemptId, questionId, randomUUID()],
    );
    expect(atBoundary).toMatchObject({ ok: false, code: "EXPIRED" });
    const responses = await f.db.query<{ body: string }>(
      "select body from public.assessment_responses where attempt_id=$1",
      [attemptId],
    );
    expect(responses.rows).toHaveLength(1);
    expect(responses.rows[0].body).toBe("Well before expiry");
    await f.db.close();
  });
});

// =============================================================================
// AUTHORITY PRESERVATION
// =============================================================================
describe("Authority preservation", () => {
  it("migrations 001-028 have zero diff against the canonical base SHA", async () => {
    const historical = readdirSync("supabase/migrations").filter(
      (name) => name.endsWith(".sql") && Number(name.slice(8, 12)) <= 28,
    );
    expect(historical).toHaveLength(28);
    expect(
      execFileSync(
        "git",
        [
          "diff",
          "--exit-code",
          "b20f603346e615ab268af6833dca3449ca3e4a7c",
          "--",
          ...historical.map((name) => "supabase/migrations/" + name),
        ],
        { encoding: "utf8" },
      ),
    ).toBe("");
  });

  it("service_role and anon cannot invoke the new governed RPCs or read the new tables directly -- proven at runtime, not only by the migration's own deploy-time ACL assertion", async () => {
    const f = await buildAssessmentPolicyFixture({ withLabs: true });
    await f.db.exec("set role service_role");
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "service_role shortcut attempt",
      ]),
    ).rejects.toThrow("permission denied");
    await expect(
      f.db.query(
        "select public.bind_commercial_v1_assessment_component($1,$2,$3,$4)",
        [
          f.activationId,
          "QUIZ_1",
          f.assessmentIds.QUIZ_1,
          "service_role shortcut attempt",
        ],
      ),
    ).rejects.toThrow("permission denied");
    await expect(
      f.db.query("select * from public.commercial_v1_grading_policies"),
    ).rejects.toThrow("permission denied");
    await expect(
      f.db.query("select * from public.commercial_v1_component_bindings"),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role; set role anon");
    await expect(
      f.db.query("select public.publish_commercial_v1_grading_policy($1,$2)", [
        f.activationId,
        "anon shortcut attempt",
      ]),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role");
    await f.db.close();
  });

  it("Professor's execution/budget tables and Tutor/Lab's execution tables are never referenced: only the pre-existing academic_content_releases exclusion-check/expiry call this migration deliberately preserves from migration 021", async () => {
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(
      "supabase/migrations/202609140029_commercial_v1_assessment_policy.sql",
      "utf8",
    );
    // start_assessment_attempt legitimately calls
    // expire_my_academic_content_releases() and reads
    // academic_content_releases -- this is migration 021's own pre-existing
    // Professor-content-release mutual-exclusion check, preserved exactly
    // (see the CREATE OR REPLACE'd function's own comment); that is the
    // ONLY acceptable reference to Professor's release surface anywhere in
    // this file. Professor's PROVIDER-EXECUTION/budget tables and every
    // Tutor/Lab execution table must never appear at all.
    expect(migration).not.toMatch(
      /public\.academic_provider_executions|public\.tutor_lab_content_releases|public\.tutor_lab_provider_executions|has_role\('EXAMINER'\)/,
    );
    const releaseReferences = (
      migration.match(
        /public\.academic_content_releases|expire_my_academic_content_releases/g,
      ) ?? []
    ).length;
    // Exactly the expected, reviewed reference count: one read in the
    // exclusion EXISTS check, one call to the expiry function, and their
    // matching mentions inside the explanatory comment above them.
    expect(releaseReferences).toBeGreaterThan(0);
    expect(migration).toMatch(
      /perform public\.expire_my_academic_content_releases\(\);\s*\n\s*if exists\(select 1 from public\.academic_content_releases/,
    );
  });
});
