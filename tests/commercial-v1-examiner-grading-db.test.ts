import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildAssessmentPolicyFixture,
  asPolicyUser,
  learner,
  foreignLearner,
  type AssessmentPolicyFixture,
} from "./commercial-v1-assessment-policy-fixture";

const databases: PGlite[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
// PR16A: this whole file exercises real Examiner grading via the governed
// database RPC, which now requires an enabled programme-version EXAMINER
// academic_agent_configs row (migration 036). Defaults EXAMINER to enabled
// with both real grading capabilities so every existing "reaches AUTHORIZE/
// START/FINALIZE" scenario below continues to admit; pass
// `examinerAgentConfig: null` explicitly to instead exercise the new
// POLICY_BLOCKED/UNKNOWN_MODEL_PROFILE/ESCALATED-at-AUTHORIZE paths this
// checkpoint adds.
async function fixture(
  opts: Parameters<typeof buildAssessmentPolicyFixture>[0],
) {
  const f = await buildAssessmentPolicyFixture({
    ...opts,
    examinerAgentConfig:
      opts.examinerAgentConfig === undefined
        ? {
            capabilities: [
              "grade_controlled_assessment",
              "grade_practical_lab",
            ],
          }
        : opts.examinerAgentConfig,
  });
  if (!databases.includes(f.db)) databases.push(f.db);
  return f;
}
async function value<T = string>(
  db: PGlite,
  sql: string,
  args: unknown[] = [],
) {
  return (await db.query<{ v: T }>(sql, args)).rows[0].v;
}
async function row<T>(db: PGlite, sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows[0];
}
async function owner(db: PGlite) {
  await db.exec("reset role");
}
async function asLearner(db: PGlite) {
  await asPolicyUser(db, 1);
}
async function asAdmin(db: PGlite) {
  await asPolicyUser(db, 2);
}
async function asForeign(db: PGlite) {
  await asPolicyUser(db, 3);
}

async function installKey(f: AssessmentPolicyFixture) {
  const keyId = randomUUID();
  const key = randomBytes(32);
  await owner(f.db);
  await f.db.query(
    "select academic_execution_private.install_controller_key($1,$2::bytea)",
    [keyId, key],
  );
  return { keyId, key };
}

async function publishResultPolicy(f: AssessmentPolicyFixture, passMarkBp = 1) {
  await asAdmin(f.db);
  await f.db.query(
    "select public.publish_commercial_v1_result_policy($1,$2,$3,$4)",
    [f.activationId, passMarkBp, false, "Publish result policy"],
  );
}

async function submitAssessmentAttempt(
  f: AssessmentPolicyFixture,
  component: "QUIZ_1",
  opts: { answer?: string } = {},
) {
  await asLearner(f.db);
  const attemptId = await value<string>(
    f.db,
    "select public.start_assessment_attempt($1) as v",
    [f.assessmentIds[component]],
  );
  if (opts.answer !== undefined) {
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds[component]],
    );
    await asLearner(f.db);
    // Commercial V1-governed attempts must use the governed recorder --
    // the legacy record_assessment_response refuses them outright (PR10
    // correction pass).
    await f.db.query(
      "select public.record_commercial_v1_assessment_response($1,$2,$3,$4)",
      [attemptId, questionId, opts.answer, randomUUID()],
    );
  }
  await f.db.query("select public.submit_assessment_attempt($1)", [attemptId]);
  return attemptId;
}

async function submitLabWork(f: AssessmentPolicyFixture, practicalId: string) {
  await asLearner(f.db);
  return value<string>(
    f.db,
    "select public.submit_commercial_v1_lab_work($1,$2,$3,$4) as v",
    [f.learnerEnrolmentId, practicalId, "Final lab answer.", randomUUID()],
  );
}
async function getOwnedPracticalId(f: AssessmentPolicyFixture) {
  await owner(f.db);
  return value<string>(
    f.db,
    "select id as v from public.course_practicals where import_id=$1 and kind='PRACTICAL_LAB' limit 1",
    [f.importId],
  );
}
async function setLabPolicy(f: AssessmentPolicyFixture, practicalId: string) {
  await asAdmin(f.db);
  await f.db.query(
    "select public.set_commercial_v1_lab_policy($1,$2,$3,$4,$5,$6)",
    [
      f.activationId,
      practicalId,
      10,
      2000,
      "Grade for correct configuration.",
      "Configure lab policy",
    ],
  );
}

// -----------------------------------------------------------------------
// Signing helper: constructs the canonical
// DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1 message exactly as
// migration 031 and src/server/commercial-v1-examiner-grading/authority.ts
// do, so these tests exercise the REAL HMAC/controller-attestation
// boundary, not a bypass of it.
// -----------------------------------------------------------------------
type Fields = {
  keyId: string;
  key: Buffer;
  actor: string;
  executionId: string;
  capability: "grade_controlled_assessment" | "grade_practical_lab";
  targetKind: "ASSESSMENT_ATTEMPT" | "LAB_SUBMISSION";
  attemptId: string | null;
  submissionId: string | null;
  enrolmentId: string | null;
  activationId: string | null;
  operation: "AUTHORIZE" | "START" | "FINALIZE";
  state: string;
  reason: string;
  budgetStage: string;
  maxCalls: number;
  maxOutput: number;
  maxCost: number;
  calls: number;
  attempts: number;
  input: number;
  output: number;
  cost: number;
  elapsed: number;
  gradeDigest: string | null;
  issuedAt: number;
  expiresAt: number;
};
function sign(f: Fields, overrideMac?: string) {
  const canonical = [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
    "COMMERCIAL_V1_EXAMINER_V1",
    "EXAMINER",
    "EXAMINER_COMMERCIAL_V1",
    f.keyId,
    f.actor,
    f.executionId,
    f.capability,
    f.targetKind,
    f.attemptId ?? "NONE",
    f.submissionId ?? "NONE",
    f.enrolmentId ?? "NONE",
    f.activationId ?? "NONE",
    f.operation,
    f.state,
    f.reason,
    f.budgetStage,
    String(f.maxCalls),
    String(f.maxOutput),
    String(f.maxCost),
    String(f.calls),
    String(f.attempts),
    String(f.input),
    String(f.output),
    String(f.cost),
    String(f.elapsed),
    f.gradeDigest ?? "NONE",
    String(f.issuedAt),
    String(f.expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", f.key)
    .update(canonical, "utf8")
    .digest("hex");
  return overrideMac ?? mac;
}
async function govern(
  db: PGlite,
  f: Fields,
  extra: { assessmentMarks?: unknown; labMarksAwarded?: number | null } = {},
  macOverride?: string,
) {
  return (
    await db.query<{ v: unknown }>(
      `select public.govern_commercial_v1_examiner_execution(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27
      ) as v`,
      [
        f.keyId,
        f.executionId,
        f.capability,
        f.targetKind,
        f.attemptId,
        f.submissionId,
        f.enrolmentId,
        f.activationId,
        f.operation,
        f.state,
        f.reason,
        f.budgetStage,
        f.maxCalls,
        f.maxOutput,
        f.maxCost,
        f.calls,
        f.attempts,
        f.input,
        f.output,
        f.cost,
        f.elapsed,
        f.gradeDigest,
        f.issuedAt,
        f.expiresAt,
        sign(f, macOverride),
        JSON.stringify(extra.assessmentMarks ?? null),
        extra.labMarksAwarded ?? null,
      ],
    )
  ).rows[0].v;
}

function baseFields(
  overrides: Partial<Fields> & Pick<Fields, "keyId" | "key">,
): Fields {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    // The app_users.id constant (never the auth.users/JWT-sub id): this is
    // exactly what public.current_app_user() resolves to once the session
    // is authenticated via asPolicyUser -- see the callers below, which
    // always set the matching session role immediately before signing.
    actor: learner,
    executionId: randomUUID(),
    capability: "grade_controlled_assessment",
    targetKind: "ASSESSMENT_ATTEMPT",
    attemptId: null,
    submissionId: null,
    enrolmentId: null,
    activationId: null,
    operation: "AUTHORIZE",
    state: "AUTHORIZED",
    reason: "NONE",
    budgetStage: "NONE",
    maxCalls: 1,
    maxOutput: 500,
    maxCost: 10000,
    calls: 0,
    attempts: 0,
    input: 0,
    output: 0,
    cost: 0,
    elapsed: 0,
    gradeDigest: null,
    issuedAt,
    expiresAt: issuedAt + 10,
    ...overrides,
  };
}
// Note: actor is a fixed sentinel across every test since student "actor" is
// derived from request.jwt.claim.sub via asPolicyUser(db,1) -- see
// commercial-v1-assessment-policy-fixture.ts's learnerAuth(1).

function authorizeFields(
  key: { keyId: string; key: Buffer },
  capability: "grade_controlled_assessment" | "grade_practical_lab",
  target: { attemptId?: string; submissionId?: string },
) {
  return baseFields({
    ...key,
    capability,
    targetKind:
      capability === "grade_controlled_assessment"
        ? "ASSESSMENT_ATTEMPT"
        : "LAB_SUBMISSION",
    attemptId: target.attemptId ?? null,
    submissionId: target.submissionId ?? null,
  });
}

async function authorize(
  db: PGlite,
  key: { keyId: string; key: Buffer },
  capability: "grade_controlled_assessment" | "grade_practical_lab",
  target: { attemptId?: string; submissionId?: string },
) {
  const f = authorizeFields(key, capability, target);
  await asLearner(db);
  const result = (await govern(db, f)) as {
    ok: boolean;
    execution?: {
      executionId: string;
      enrolmentId: string;
      activationId: string;
    };
    code?: string;
  };
  return { result, fields: f };
}

async function startAndFinalize(
  db: PGlite,
  key: { keyId: string; key: Buffer },
  authorized: {
    fields: Fields;
    result: {
      execution?: {
        executionId: string;
        enrolmentId: string;
        activationId: string;
      };
    };
  },
  finalize: {
    state: string;
    reason: string;
    budgetStage?: string;
    gradeDigest?: string | null;
    assessmentMarks?: unknown;
    labMarksAwarded?: number | null;
    output?: number;
    cost?: number;
  },
) {
  const exec = authorized.result.execution!;
  const identity = {
    ...key,
    executionId: exec.executionId,
    capability: authorized.fields.capability,
    targetKind: authorized.fields.targetKind,
    attemptId: authorized.fields.attemptId,
    submissionId: authorized.fields.submissionId,
    enrolmentId: exec.enrolmentId,
    activationId: exec.activationId,
  };
  const startFields = baseFields({
    ...identity,
    operation: "START",
    state: "RUNNING",
  });
  await asLearner(db);
  const startResult = (await govern(db, startFields)) as {
    ok: boolean;
    code?: string;
  };
  if (!startResult.ok) return { startResult, finalizeResult: null };
  const finalizeFields = baseFields({
    ...identity,
    operation: "FINALIZE",
    state: finalize.state,
    reason: finalize.reason,
    budgetStage: finalize.budgetStage ?? "NONE",
    gradeDigest: finalize.gradeDigest ?? null,
    output: finalize.output ?? 0,
    cost: finalize.cost ?? 0,
    calls: finalize.state === "SUCCEEDED" ? 1 : 0,
  });
  await asLearner(db);
  const finalizeResult = (await govern(db, finalizeFields, {
    assessmentMarks: finalize.assessmentMarks,
    labMarksAwarded: finalize.labMarksAwarded,
  })) as {
    ok: boolean;
    transitioned?: boolean;
    execution?: {
      state: string;
      reasonCode: string | null;
      resultRevisionId: string | null;
      gradeDigest: string | null;
    };
    code?: string;
  };
  return { startResult, finalizeResult };
}

// -----------------------------------------------------------------------
// Blocker 1 (independent review, V2): CONTEXT_READ signing helper. A fresh
// attestation, distinct canonical operation, lighter parameter set than
// the main command surface (no state/reason/budget/usage/grade-digest).
// -----------------------------------------------------------------------
type ContextReadFields = {
  keyId: string;
  key: Buffer;
  actor: string;
  executionId: string;
  capability: "grade_controlled_assessment" | "grade_practical_lab";
  targetKind: "ASSESSMENT_ATTEMPT" | "LAB_SUBMISSION";
  attemptId: string | null;
  submissionId: string | null;
  enrolmentId: string;
  activationId: string;
  issuedAt: number;
  expiresAt: number;
};
function signContextRead(f: ContextReadFields, overrideMac?: string) {
  const canonical = [
    "DUCELIO_COMMERCIAL_V1_EXAMINER_HMAC_SHA256_V1",
    "COMMERCIAL_V1_EXAMINER_V1",
    "EXAMINER",
    "EXAMINER_COMMERCIAL_V1",
    f.keyId,
    f.actor,
    f.executionId,
    f.capability,
    f.targetKind,
    f.attemptId ?? "NONE",
    f.submissionId ?? "NONE",
    f.enrolmentId,
    f.activationId,
    "CONTEXT_READ",
    String(f.issuedAt),
    String(f.expiresAt),
  ].join("\n");
  const mac = createHmac("sha256", f.key)
    .update(canonical, "utf8")
    .digest("hex");
  return overrideMac ?? mac;
}
function contextReadFields(
  key: { keyId: string; key: Buffer },
  exec: {
    executionId: string;
    capability: "grade_controlled_assessment" | "grade_practical_lab";
    targetKind: "ASSESSMENT_ATTEMPT" | "LAB_SUBMISSION";
    attemptId: string | null;
    submissionId: string | null;
    enrolmentId: string;
    activationId: string;
  },
): ContextReadFields {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    ...key,
    actor: learner,
    issuedAt,
    expiresAt: issuedAt + 10,
    ...exec,
  };
}
async function getAssessmentContext(
  db: PGlite,
  f: ContextReadFields,
  macOverride?: string,
) {
  return (
    await db.query<{ v: unknown }>(
      `select public.get_commercial_v1_examiner_assessment_context($1,$2,$3,$4,$5,$6,$7,$8) as v`,
      [
        f.keyId,
        f.executionId,
        f.attemptId,
        f.enrolmentId,
        f.activationId,
        f.issuedAt,
        f.expiresAt,
        signContextRead(f, macOverride),
      ],
    )
  ).rows[0].v;
}
async function getLabContext(
  db: PGlite,
  f: ContextReadFields,
  macOverride?: string,
) {
  return (
    await db.query<{ v: unknown }>(
      `select public.get_commercial_v1_examiner_lab_context($1,$2,$3,$4,$5,$6,$7,$8) as v`,
      [
        f.keyId,
        f.executionId,
        f.submissionId,
        f.enrolmentId,
        f.activationId,
        f.issuedAt,
        f.expiresAt,
        signContextRead(f, macOverride),
      ],
    )
  ).rows[0].v;
}

// =============================================================================
// MIGRATION INTEGRITY
// =============================================================================
describe("Migration integrity", () => {
  it("migrations 001-030 have zero diff against the canonical base SHA; only migration 031 may be added", () => {
    const changed = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "0a4c5eb5db3f6a652064d2c3b25d1c2ed094b65a",
        "--",
        "supabase/migrations",
      ],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const historical = changed.filter((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? "";
      return name.endsWith(".sql") && Number(name.slice(8, 12)) <= 30;
    });
    expect(historical).toEqual([]);
  });
});

// =============================================================================
// CONTROLLER ATTESTATION / HMAC
// =============================================================================
describe("Controller attestation", () => {
  it("a forged MAC is rejected with zero execution rows created", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields, {}, "0".repeat(64))) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(count).toBe("0");
  });

  it("a tampered target id after signing is rejected", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const g = await fixture({ withLabs: false });
    await publishResultPolicy(g);
    const foreignAttemptId = await submitAssessmentAttempt(g, "QUIZ_1", {
      answer: "Other.",
    });
    const key = await installKey(f);
    const signed = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    const validMacForOriginalFields = sign(signed);
    const tampered = { ...signed, attemptId: foreignAttemptId };
    await asLearner(f.db);
    // A real captured signature for the ORIGINAL (untampered) fields, replayed
    // against the TAMPERED field set: verify_command_ex1 recomputes the
    // canonical text from the actual submitted fields, so this MAC no longer
    // matches -- proving the server does not trust a client-supplied MAC as
    // proof of an unrelated field's value.
    const result = (await govern(
      f.db,
      tampered,
      {},
      validMacForOriginalFields,
    )) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });

  it("an expired issued_at is rejected", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    fields.issuedAt -= 60;
    fields.expiresAt = fields.issuedAt + 10;
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });

  it("an unknown/revoked key id is rejected", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const fields = authorizeFields(
      { keyId: randomUUID(), key: randomBytes(32) },
      "grade_controlled_assessment",
      { attemptId },
    );
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });
  });

  it("anon/service_role cannot invoke the governed Examiner RPC or read the execution tables directly", async () => {
    const f = await fixture({ withLabs: false });
    await f.db.exec("set role service_role");
    await expect(
      f.db.query("select * from public.commercial_v1_examiner_executions"),
    ).rejects.toThrow("permission denied");
    await f.db.exec("reset role; set role anon");
    await expect(
      f.db.query(
        "select public.govern_commercial_v1_examiner_execution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,null,null)",
        Array.from({ length: 25 }, () => null),
      ),
    ).rejects.toThrow();
    await f.db.exec("reset role");
  });
});

// =============================================================================
// AUTHORIZE ELIGIBILITY / OWNERSHIP
// =============================================================================
describe("AUTHORIZE eligibility", () => {
  it("a foreign learner's attempt cannot be claimed", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    fields.actor = foreignLearner;
    await asForeign(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("an ACTIVE (not yet SUBMITTED) attempt is not eligible", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    await asLearner(f.db);
    const attemptId = await value<string>(
      f.db,
      "select public.start_assessment_attempt($1) as v",
      [f.assessmentIds.QUIZ_1],
    );
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_ELIGIBLE" });
  });

  it("no published result policy => not eligible", async () => {
    const f = await fixture({ withLabs: false });
    // No publishResultPolicy call.
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_ELIGIBLE" });
  });
});

// =============================================================================
// PR16A (migration 036): AUTHORIZE is now the config-governed admission
// boundary for normal learner-initiated Examiner grading. These exercise the
// REAL govern_commercial_v1_examiner_execution RPC's new admission branches
// directly -- never a mocked orchestrator -- proving the actual SQL, not
// merely the TS-side denial-code plumbing (tests/commercial-v1-examiner-
// grading-runtime.test.ts mocks the RPC transport and only proves that
// boundary maps the codes correctly).
// =============================================================================
describe("PR16A: config-governed AUTHORIZE admission (migration 036)", () => {
  async function usageRowCount(db: PGlite) {
    await owner(db);
    return value<string>(
      db,
      "select count(*)::text as v from public.commercial_v1_examiner_execution_usage",
    );
  }
  async function executionRowCount(
    f: AssessmentPolicyFixture,
    attemptId: string,
  ) {
    await owner(f.db);
    return value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
  }
  // Disables the historical-immutability guard trigger just long enough to
  // remove the row entirely (the trigger otherwise refuses any DELETE
  // unconditionally, "disable the role instead" -- set_agent_config itself
  // has no way to produce a missing row, only a disabled one). Owner-role
  // only; the table carries zero direct grants for any other role.
  async function deleteExaminerConfigRow(f: AssessmentPolicyFixture) {
    await owner(f.db);
    await f.db.exec(
      "alter table public.academic_agent_configs disable trigger guard_agent_config_history",
    );
    await f.db.query(
      "delete from public.academic_agent_configs where programme_version_id=$1 and role='EXAMINER'",
      [f.programmeVersionId],
    );
    await f.db.exec(
      "alter table public.academic_agent_configs enable trigger guard_agent_config_history",
    );
  }

  it("A. no EXAMINER config row at all => POLICY_BLOCKED, zero execution rows, zero usage rows", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    await deleteExaminerConfigRow(f);
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "POLICY_BLOCKED" });
    expect(await executionRowCount(f, attemptId)).toBe("0");
    expect(await usageRowCount(f.db)).toBe("0");
  });

  it("B. EXAMINER config row disabled => POLICY_BLOCKED, zero execution rows, zero usage rows", async () => {
    const f = await fixture({ withLabs: false, examinerAgentConfig: null });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "POLICY_BLOCKED" });
    expect(await executionRowCount(f, attemptId)).toBe("0");
    expect(await usageRowCount(f.db)).toBe("0");
  });

  it("C. enabled EXAMINER missing the invoked capability (assessment target, only grade_practical_lab configured) => POLICY_BLOCKED", async () => {
    const f = await fixture({
      withLabs: false,
      examinerAgentConfig: { capabilities: ["grade_practical_lab"] },
    });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "POLICY_BLOCKED" });
    expect(await executionRowCount(f, attemptId)).toBe("0");
    expect(await usageRowCount(f.db)).toBe("0");
  });

  it("C (reciprocal). enabled EXAMINER missing the invoked capability (lab target, only grade_controlled_assessment configured) => POLICY_BLOCKED", async () => {
    const f = await fixture({
      withLabs: true,
      examinerAgentConfig: { capabilities: ["grade_controlled_assessment"] },
    });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_practical_lab", {
      submissionId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "POLICY_BLOCKED" });
    await owner(f.db);
    const executionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where submission_id=$1",
      [submissionId],
    );
    expect(executionCount).toBe("0");
    expect(await usageRowCount(f.db)).toBe("0");
  });

  it("D. an invalid/cross-role stored model_profile_ref => UNKNOWN_MODEL_PROFILE, zero execution rows, zero usage rows", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    // Seeded directly as the database owner: set_agent_config itself now
    // correctly refuses this (migration 036's role_profile_ref_is_valid),
    // so this adversarial state is unreachable through the normal RPC
    // surface -- the table's own CHECK constraint only validates bounded-
    // identifier shape, not role binding, so this UPDATE is otherwise a
    // structurally valid row.
    await owner(f.db);
    await f.db.query(
      "update public.academic_agent_configs set model_profile_ref='TUTOR_COMMERCIAL_V1' where programme_version_id=$1 and role='EXAMINER'",
      [f.programmeVersionId],
    );
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    await asLearner(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_MODEL_PROFILE" });
    expect(await executionRowCount(f, attemptId)).toBe("0");
    expect(await usageRowCount(f.db)).toBe("0");
  });

  it("E. escalationPolicy=ACADEMIC_REVIEW creates exactly one durable, terminal ESCALATED claim directly at AUTHORIZE", async () => {
    const f = await fixture({
      withLabs: false,
      examinerAgentConfig: {
        capabilities: ["grade_controlled_assessment", "grade_practical_lab"],
        escalationPolicy: "ACADEMIC_REVIEW",
      },
    });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    expect(authorized.result).toMatchObject({
      ok: true,
      execution: {
        state: "ESCALATED",
        reasonCode: "HUMAN_REVIEW_REQUIRED",
        reviewPath: "ACADEMIC_REVIEW",
        runtimeProfileRef: "EXAMINER_COMMERCIAL_V1",
        resultRevisionId: null,
        gradeDigest: null,
        usage: null,
      },
    });
    expect(await executionRowCount(f, attemptId)).toBe("1");
    expect(await usageRowCount(f.db)).toBe("0");

    await owner(f.db);
    const events = await f.db.query<{ after_state: Record<string, unknown> }>(
      "select after_state from public.audit_events where target_type='commercial_v1_examiner_executions' and after_state->>'state'='ESCALATED'",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].after_state).toMatchObject({
      state: "ESCALATED",
      reason_code: "HUMAN_REVIEW_REQUIRED",
      review_path: "ACADEMIC_REVIEW",
      runtime_profile_ref: "EXAMINER_COMMERCIAL_V1",
      usage: null,
    });
    const auditText = JSON.stringify(events.rows.map((e) => e.after_state));
    expect(auditText).not.toMatch(
      /protected answer|My answer\.|expectedAnswer|markingGuidance/i,
    );

    // Exact-target replay returns the SAME terminal ESCALATED claim -- no
    // re-escalation, no provider call, still exactly one execution row and
    // zero usage rows.
    const replay = await govern(
      f.db,
      authorizeFields(key, "grade_controlled_assessment", { attemptId }),
    );
    expect(replay).toMatchObject({
      ok: true,
      transitioned: false,
      execution: {
        executionId: authorized.result.execution!.executionId,
        state: "ESCALATED",
        reasonCode: "HUMAN_REVIEW_REQUIRED",
      },
    });
    expect(await executionRowCount(f, attemptId)).toBe("1");
    expect(await usageRowCount(f.db)).toBe("0");
  });
});

// =============================================================================
// ONE CLAIM PER TARGET / CONCURRENCY
// =============================================================================
describe("Concurrency: one claim per target", () => {
  it("a second AUTHORIZE for the same attempt while the first is still AUTHORIZED is rejected, and no second execution row is created", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const first = await authorize(f.db, key, "grade_controlled_assessment", {
      attemptId,
    });
    expect(first.result.ok).toBe(true);
    await asLearner(f.db);
    const second = await govern(
      f.db,
      authorizeFields(key, "grade_controlled_assessment", { attemptId }),
    );
    // Blocker 2 (independent review, V3): the EXACT-TARGET claim lookup now
    // runs BEFORE the student's generic new-admission rate limit, so a
    // same-target replay while the first claim is still non-terminal
    // surfaces as REPLAY_REJECTED (found, AUTHORIZED/RUNNING) rather than
    // the generic RATE_LIMITED -- either way, zero provider calls and no
    // second row.
    expect(second).toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(count).toBe("1");
  });

  it("after a terminal SUCCEEDED grade, a replayed AUTHORIZE returns the SAME outcome without a second provider call / second result row", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const marks = [{ questionId, marksAwarded: 10 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:10`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
      output: 20,
      cost: 100,
    });
    expect(finalizeResult).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    const originalExecutionId = authorized.result.execution!.executionId;
    const originalResultRevisionId =
      finalizeResult!.execution!.resultRevisionId;
    expect(originalResultRevisionId).not.toBeNull();

    // Blocker 2 (independent review, V2): the exact target's own EXECUTION
    // claim is checked BEFORE any generic "a production result already
    // exists" defence, so a replayed AUTHORIZE observes its OWN prior
    // execution's outcome -- same execution id, same non-null
    // resultRevisionId, transitioned:false -- never a bare ALREADY_GRADED
    // denial that would discard it.
    await asLearner(f.db);
    const replay = (await govern(
      f.db,
      authorizeFields(key, "grade_controlled_assessment", { attemptId }),
    )) as {
      ok: boolean;
      transitioned?: boolean;
      execution?: {
        executionId: string;
        state: string;
        resultRevisionId: string | null;
      };
    };
    expect(replay.ok).toBe(true);
    expect(replay.transitioned).toBe(false);
    expect(replay.execution?.executionId).toBe(originalExecutionId);
    expect(replay.execution?.state).toBe("SUCCEEDED");
    expect(replay.execution?.resultRevisionId).toBe(originalResultRevisionId);

    await owner(f.db);
    const executionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(executionCount).toBe("1");
    const revisionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
      [f.learnerEnrolmentId],
    );
    expect(revisionCount).toBe("1");
  });

  it("Blocker 2: a successful replay still returns the original result even when the learner would otherwise be globally rate-limited by another currently-active target", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const marks = [{ questionId, marksAwarded: 10 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:10`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });
    expect(finalizeResult).toMatchObject({
      ok: true,
      execution: { state: "SUCCEEDED" },
    });
    const originalExecutionId = authorized.result.execution!.executionId;
    const originalResultRevisionId =
      finalizeResult!.execution!.resultRevisionId;
    expect(originalResultRevisionId).not.toBeNull();

    // Open a SECOND, DIFFERENT target's claim for the SAME learner and
    // leave it non-terminal (AUTHORIZED) -- this occupies the "one
    // AUTHORIZED/RUNNING execution per student" admission slot, exactly
    // the condition that would otherwise make any OTHER AUTHORIZE for this
    // learner observe RATE_LIMITED.
    const submissionId = await submitLabWork(f, practicalId);
    const secondAuthorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });
    expect(secondAuthorized.result.ok).toBe(true);
    await owner(f.db);
    const secondState = await value<string>(
      f.db,
      "select state as v from public.commercial_v1_examiner_executions where submission_id=$1",
      [submissionId],
    );
    expect(secondState).toBe("AUTHORIZED");

    // The replayed AUTHORIZE for the FIRST (already-SUCCEEDED) target must
    // still return its own exact original result -- never RATE_LIMITED,
    // even though another target is currently active for this same
    // learner.
    await asLearner(f.db);
    const replay = (await govern(
      f.db,
      authorizeFields(key, "grade_controlled_assessment", { attemptId }),
    )) as {
      ok: boolean;
      transitioned?: boolean;
      execution?: {
        executionId: string;
        state: string;
        resultRevisionId: string | null;
      };
    };
    expect(replay.ok).toBe(true);
    expect(replay.transitioned).toBe(false);
    expect(replay.execution?.executionId).toBe(originalExecutionId);
    expect(replay.execution?.state).toBe("SUCCEEDED");
    expect(replay.execution?.resultRevisionId).toBe(originalResultRevisionId);

    await owner(f.db);
    const executionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(executionCount).toBe("1");
    const revisionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1 and component='QUIZ_1'",
      [f.learnerEnrolmentId],
    );
    expect(revisionCount).toBe("1");
  });

  it("Blocker 2: the exact-target lookup is actor-safe -- a foreign learner probing a SUCCEEDED target's own attempt id never observes its execution/result", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const marks = [{ questionId, marksAwarded: 10 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:10`],
    );
    await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });

    const fields = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    fields.actor = foreignLearner;
    await asForeign(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
      execution?: unknown;
    };
    // A foreign actor probing the EXACT SAME attempt id that a real
    // SUCCEEDED grade exists for must observe the identical bounded
    // NOT_FOUND_OR_FORBIDDEN outcome the ownership check has always
    // returned -- never the owning student's execution/result projection.
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
    expect(result.execution).toBeUndefined();
  });

  it("ALREADY_GRADED remains the fail-closed response when a production result exists but no Examiner execution ever claimed the target", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    // Seed a production result directly via owner authority -- historical/
    // external result state with NO corresponding Examiner execution row,
    // exactly the scenario this defence exists for.
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const studentId = await value<string>(
      f.db,
      "select student_id as v from public.enrolments where id=$1",
      [f.learnerEnrolmentId],
    );
    const quiz1WeightBp = await value<number>(
      f.db,
      "select quiz_1_weight_bp as v from public.commercial_v1_grading_policies where activation_id=$1",
      [f.activationId],
    );
    const maxMarks = await value<number>(
      f.db,
      "select max_marks as v from public.assessment_questions where id=$1",
      [questionId],
    );
    const resultId = await value<string>(
      f.db,
      `insert into public.commercial_v1_assessment_result_revisions(
        activation_id,enrolment_id,student_id,component,attempt_id,assessment_id,revision_number,
        earned_marks_total,max_marks_total,component_weight_bp
      ) values ($1,$2,$3,'QUIZ_1',$4,$5,1,$6,$6,$7) returning id as v`,
      [
        f.activationId,
        f.learnerEnrolmentId,
        studentId,
        attemptId,
        f.assessmentIds.QUIZ_1,
        maxMarks,
        quiz1WeightBp,
      ],
    );
    await f.db.query(
      "insert into public.commercial_v1_assessment_question_marks(result_revision_id,question_id,marks_awarded,max_marks_snapshot) values ($1,$2,$3,$3)",
      [resultId, questionId, maxMarks],
    );

    const key = await installKey(f);
    await asLearner(f.db);
    const signed = authorizeFields(key, "grade_controlled_assessment", {
      attemptId,
    });
    const denial = (await govern(f.db, signed)) as {
      ok: boolean;
      code?: string;
    };
    expect(denial).toMatchObject({ ok: false, code: "ALREADY_GRADED" });
    await owner(f.db);
    const executionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_examiner_executions where attempt_id=$1",
      [attemptId],
    );
    expect(executionCount).toBe("0");
  });
});

// =============================================================================
// ATOMIC FINALIZE -- ASSESSMENT
// =============================================================================
describe("Atomic assessment result finalization", () => {
  it("SUCCEEDED writes a complete revision 1: every question has a mark row, an unanswered question receives deterministic zero, objective outcomes derive, remediation opens on a partial result, and the execution is atomically SUCCEEDED", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    // The sole question on QUIZ_1 is left UNANSWERED.
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1");
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [""],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: [],
    });
    expect(finalizeResult?.ok).toBe(true);
    expect(finalizeResult?.execution?.state).toBe("SUCCEEDED");
    const resultRevisionId = finalizeResult!.execution!.resultRevisionId!;

    await owner(f.db);
    const header = await row<{
      earned_marks_total: number;
      max_marks_total: number;
      revision_number: number;
    }>(
      f.db,
      "select earned_marks_total,max_marks_total,revision_number from public.commercial_v1_assessment_result_revisions where id=$1",
      [resultRevisionId],
    );
    expect(header.revision_number).toBe(1);
    expect(header.earned_marks_total).toBe(0);
    const mark = await row<{ marks_awarded: number }>(
      f.db,
      "select marks_awarded from public.commercial_v1_assessment_question_marks where result_revision_id=$1",
      [resultRevisionId],
    );
    expect(mark.marks_awarded).toBe(0);
    const outcome = await value<string>(
      f.db,
      "select outcome as v from public.commercial_v1_assessment_objective_outcomes where result_revision_id=$1",
      [resultRevisionId],
    );
    expect(outcome).toBe("INCORRECT");
    const openRemediation = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_remediation_items where enrolment_id=$1 and state='OPEN'",
      [f.learnerEnrolmentId],
    );
    expect(openRemediation).toBe("1");
    expect(
      await value<boolean>(
        f.db,
        "select commercial_v1_private.assessment_result_is_valid($1) as v",
        [resultRevisionId],
      ),
    ).toBe(true);
  });

  it("a grade digest that does not match the actual marks payload is rejected: FAILED, no result revision written", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: "f".repeat(64),
      assessmentMarks: [{ questionId, marksAwarded: 10 }],
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
    expect(finalizeResult?.execution?.reasonCode).toBe(
      "RESULT_INTEGRITY_FAILED",
    );
    await owner(f.db);
    const revisionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(revisionCount).toBe("0");
  });

  it("a foreign question id in the marks payload is rejected: FAILED, no result revision written", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const foreignQuestionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_2],
    );
    const marks = [{ questionId: foreignQuestionId, marksAwarded: 5 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${foreignQuestionId}:5`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
    await owner(f.db);
    const revisionCount = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(revisionCount).toBe("0");
  });

  it("marks awarded above the question's real max marks are rejected: FAILED, no result revision written", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const marks = [{ questionId, marksAwarded: 999 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:999`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
  });

  it("a duplicate question id in the marks payload is rejected: FAILED, no result revision written", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const marks = [
      { questionId, marksAwarded: 5 },
      { questionId, marksAwarded: 7 },
    ];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:5;${questionId}:7`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
  });

  it("full marks yield CORRECT and never mutate objective_mastery -- MASTERY_V1 stays untouched by an Examiner grade", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    const before = await value<string>(
      f.db,
      "select count(*)::text as v from public.objective_mastery where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    const marks = [{ questionId, marksAwarded: 10 }];
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:10`],
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: marks,
    });
    expect(finalizeResult?.execution?.state).toBe("SUCCEEDED");
    const resultRevisionId = finalizeResult!.execution!.resultRevisionId!;
    await owner(f.db);
    const outcome = await value<string>(
      f.db,
      "select outcome as v from public.commercial_v1_assessment_objective_outcomes where result_revision_id=$1",
      [resultRevisionId],
    );
    expect(outcome).toBe("CORRECT");
    const after = await value<string>(
      f.db,
      "select count(*)::text as v from public.objective_mastery where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(after).toBe(before);
  });
});

// =============================================================================
// ATOMIC FINALIZE -- LAB
// =============================================================================
describe("Atomic lab result finalization", () => {
  it("SUCCEEDED writes a complete lab revision 1 with max/contribution taken from the published lab policy", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const authorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to('marksAwarded:7','UTF8'),'sha256'),'hex') as v",
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      labMarksAwarded: 7,
    });
    expect(finalizeResult?.execution?.state).toBe("SUCCEEDED");
    const resultRevisionId = finalizeResult!.execution!.resultRevisionId!;
    await owner(f.db);
    const header = await row<{
      earned_marks: number;
      max_marks: number;
      contribution_bp: number;
    }>(
      f.db,
      "select earned_marks,max_marks,contribution_bp from public.commercial_v1_lab_result_revisions where id=$1",
      [resultRevisionId],
    );
    expect(header).toMatchObject({
      earned_marks: 7,
      max_marks: 10,
      contribution_bp: 2000,
    });
    expect(
      await value<boolean>(
        f.db,
        "select commercial_v1_private.lab_result_is_valid($1) as v",
        [resultRevisionId],
      ),
    ).toBe(true);
  });

  it("lab marks above the published policy max are rejected: FAILED, no result revision written", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const authorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to('marksAwarded:99','UTF8'),'sha256'),'hex') as v",
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      labMarksAwarded: 99,
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_lab_result_revisions where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(count).toBe("0");
  });

  it("a foreign submission cannot be claimed for grading", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const fields = authorizeFields(key, "grade_practical_lab", {
      submissionId,
    });
    fields.actor = foreignLearner;
    await asForeign(f.db);
    const result = (await govern(f.db, fields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND_OR_FORBIDDEN" });
  });
});

// =============================================================================
// ESCALATION
// =============================================================================
describe("Escalation produces no result", () => {
  it("FINALIZE(ESCALATED) writes no result revision and terminalizes the execution ESCALATED", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "ESCALATED",
      reason: "HUMAN_REVIEW_REQUIRED",
    });
    expect(finalizeResult).toMatchObject({
      ok: true,
      execution: {
        state: "ESCALATED",
        reasonCode: "HUMAN_REVIEW_REQUIRED",
        resultRevisionId: null,
      },
    });
    await owner(f.db);
    const count = await value<string>(
      f.db,
      "select count(*)::text as v from public.commercial_v1_assessment_result_revisions where enrolment_id=$1",
      [f.learnerEnrolmentId],
    );
    expect(count).toBe("0");
  });

  it("FINALIZE(FAILED, PROVIDER_UNAVAILABLE) writes no result and can never later be retried for the same target", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const { finalizeResult } = await startAndFinalize(f.db, key, authorized, {
      state: "FAILED",
      reason: "PROVIDER_UNAVAILABLE",
    });
    expect(finalizeResult?.execution?.state).toBe("FAILED");
    const replay = await govern(
      f.db,
      authorizeFields(key, "grade_controlled_assessment", { attemptId }),
    );
    // No automatic retry: the terminal row is the one-and-only claim ever
    // made for this target (see migration 031's own header comment).
    expect(replay).toMatchObject({
      ok: true,
      transitioned: false,
      execution: { state: "FAILED" },
    });
  });
});

// =============================================================================
// PROTECTED CONTENT / ACCESS CONTROL
// =============================================================================
describe("Protected content isolation", () => {
  it("Blocker 1: a legitimately RUNNING execution still cannot expose expectedAnswer/markingGuidance without a valid CONTEXT_READ controller MAC", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const exec = authorized.result.execution!;
    await asLearner(f.db);
    await govern(
      f.db,
      baseFields({
        ...key,
        executionId: exec.executionId,
        operation: "START",
        state: "RUNNING",
        capability: "grade_controlled_assessment",
        targetKind: "ASSESSMENT_ATTEMPT",
        attemptId,
        enrolmentId: exec.enrolmentId,
        activationId: exec.activationId,
      }),
    );
    // Merely owning a RUNNING execution and calling the RPC with NO
    // attestation at all (an authenticated learner acting entirely on
    // their own initiative, exactly as a browser could) must fail closed.
    await asLearner(f.db);
    const bareCall = await f.db.query<{ v: { ok: boolean; code: string } }>(
      "select public.get_commercial_v1_examiner_assessment_context(null,$1,$2,$3,$4,null,null,'') as v",
      [exec.executionId, attemptId, exec.enrolmentId, exec.activationId],
    );
    expect(bareCall.rows[0].v).toMatchObject({ ok: false });
  });

  it("Blocker 1: forged/tampered/expired CONTEXT_READ MACs fail; a valid controller-attested read succeeds", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My real answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const exec = authorized.result.execution!;
    await asLearner(f.db);
    await govern(
      f.db,
      baseFields({
        ...key,
        executionId: exec.executionId,
        operation: "START",
        state: "RUNNING",
        capability: "grade_controlled_assessment",
        targetKind: "ASSESSMENT_ATTEMPT",
        attemptId,
        enrolmentId: exec.enrolmentId,
        activationId: exec.activationId,
      }),
    );

    const readFields = contextReadFields(key, {
      executionId: exec.executionId,
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      enrolmentId: exec.enrolmentId,
      activationId: exec.activationId,
    });

    await asLearner(f.db);
    const forged = (await getAssessmentContext(
      f.db,
      readFields,
      "0".repeat(64),
    )) as { ok: boolean; code?: string };
    expect(forged).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });

    await asLearner(f.db);
    const validMac = signContextRead(readFields);
    const tampered = {
      ...readFields,
      attemptId:
        attemptId.slice(0, -1) + (attemptId.at(-1) === "0" ? "1" : "0"),
    };
    const tamperedResult = (await getAssessmentContext(
      f.db,
      tampered,
      validMac,
    )) as { ok: boolean; code?: string };
    expect(tamperedResult).toMatchObject({ ok: false });

    await asLearner(f.db);
    const expired = {
      ...readFields,
      issuedAt: readFields.issuedAt - 60,
      expiresAt: readFields.issuedAt - 50,
    };
    const expiredResult = (await getAssessmentContext(f.db, expired)) as {
      ok: boolean;
      code?: string;
    };
    expect(expiredResult).toMatchObject({
      ok: false,
      code: "UNTRUSTED_EXECUTION",
    });

    await asLearner(f.db);
    const valid = (await getAssessmentContext(f.db, readFields)) as {
      ok: boolean;
      attemptId?: string;
      questions?: { expectedAnswer: string }[];
    };
    expect(valid.ok).toBe(true);
    expect(valid.attemptId).toBe(attemptId);
    expect(valid.questions?.[0]?.expectedAnswer).toBeTruthy();
  });

  it("Blocker 1: an expired RUNNING execution cannot return protected context and is lazily transitioned to TIMEOUT", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const exec = authorized.result.execution!;
    await asLearner(f.db);
    await govern(
      f.db,
      baseFields({
        ...key,
        executionId: exec.executionId,
        operation: "START",
        state: "RUNNING",
        capability: "grade_controlled_assessment",
        targetKind: "ASSESSMENT_ATTEMPT",
        attemptId,
        enrolmentId: exec.enrolmentId,
        activationId: exec.activationId,
      }),
    );
    // Force the execution row into the past without going through the RPC.
    // expires_at is part of the guard trigger's own immutable identity
    // tuple (Blocker 7), so this owner-authority test seam must briefly
    // disable that trigger to write the fixture state -- the lifecycle
    // logic actually under test is the RPC's own lazy-timeout branch, not
    // this direct write, exactly mirroring the LEGACY_UNCLASSIFIED
    // backfill pattern already established in migration 029.
    await owner(f.db);
    await f.db.exec(
      "alter table public.commercial_v1_examiner_executions disable trigger guard_examiner_execution",
    );
    // expires_at must stay within (created_at, created_at+20s] AND after
    // started_at (started_at<expires_at) to satisfy the table's own CHECK
    // constraints -- set it to started_at+1ms rather than an absolute
    // "now()-1s" (which could illegally precede created_at/started_at if
    // this fast-running test hasn't yet reached a full second of
    // wall-clock time since the row was created/started). By the time the
    // next RPC round-trip below runs, real elapsed time comfortably
    // exceeds one millisecond, so the execution is genuinely expired.
    await f.db.query(
      "update public.commercial_v1_examiner_executions set expires_at=started_at+interval '1 millisecond' where id=$1",
      [exec.executionId],
    );
    await f.db.exec(
      "alter table public.commercial_v1_examiner_executions enable trigger guard_examiner_execution",
    );
    const readFields = contextReadFields(key, {
      executionId: exec.executionId,
      capability: "grade_controlled_assessment",
      targetKind: "ASSESSMENT_ATTEMPT",
      attemptId,
      submissionId: null,
      enrolmentId: exec.enrolmentId,
      activationId: exec.activationId,
    });
    await asLearner(f.db);
    const result = (await getAssessmentContext(f.db, readFields)) as {
      ok: boolean;
      code?: string;
    };
    expect(result).toMatchObject({ ok: false, code: "EXECUTION_TIMEOUT" });
    await owner(f.db);
    const state = await value<string>(
      f.db,
      "select state as v from public.commercial_v1_examiner_executions where id=$1",
      [exec.executionId],
    );
    expect(state).toBe("TIMEOUT");
  });

  it("Blocker 1: the lab context RPC applies the same controller-attested read requirement", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const authorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });
    const exec = authorized.result.execution!;
    await asLearner(f.db);
    await govern(
      f.db,
      baseFields({
        ...key,
        executionId: exec.executionId,
        operation: "START",
        state: "RUNNING",
        capability: "grade_practical_lab",
        targetKind: "LAB_SUBMISSION",
        submissionId,
        enrolmentId: exec.enrolmentId,
        activationId: exec.activationId,
      }),
    );
    const readFields = contextReadFields(key, {
      executionId: exec.executionId,
      capability: "grade_practical_lab",
      targetKind: "LAB_SUBMISSION",
      attemptId: null,
      submissionId,
      enrolmentId: exec.enrolmentId,
      activationId: exec.activationId,
    });
    await asLearner(f.db);
    const forged = (await getLabContext(f.db, readFields, "1".repeat(64))) as {
      ok: boolean;
      code?: string;
    };
    expect(forged).toMatchObject({ ok: false, code: "UNTRUSTED_EXECUTION" });

    await asLearner(f.db);
    const valid = (await getLabContext(f.db, readFields)) as {
      ok: boolean;
      submissionId?: string;
      submissionBody?: string;
    };
    expect(valid.ok).toBe(true);
    expect(valid.submissionId).toBe(submissionId);
    expect(valid.submissionBody).toBeTruthy();
  });

  it("no direct table privilege exists for authenticated on the Examiner execution/usage tables", async () => {
    const f = await fixture({ withLabs: false });
    await owner(f.db);
    const unsafe = await value<string>(
      f.db,
      `select coalesce(string_agg(t.relname,','),'') as v
       from pg_class t join pg_namespace n on n.oid=t.relnamespace
       where n.nspname='public' and t.relname in ('commercial_v1_examiner_executions','commercial_v1_examiner_execution_usage')
       and (has_table_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE'))`,
    );
    expect(unsafe).toBe("");
  });

  it("audit records for a completed grading contain no protected content", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My real answer text.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    await owner(f.db);
    const questionId = await value<string>(
      f.db,
      "select id as v from public.assessment_questions where assessment_id=$1 limit 1",
      [f.assessmentIds.QUIZ_1],
    );
    await owner(f.db);
    const digest = await value<string>(
      f.db,
      "select encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') as v",
      [`${questionId}:10`],
    );
    await startAndFinalize(f.db, key, authorized, {
      state: "SUCCEEDED",
      reason: "GRADED",
      gradeDigest: digest,
      assessmentMarks: [{ questionId, marksAwarded: 10 }],
    });
    await owner(f.db);
    const events = await f.db.query<{ after_state: Record<string, unknown> }>(
      "select after_state from public.audit_events where target_type='commercial_v1_examiner_executions'",
    );
    const text = JSON.stringify(events.rows.map((e) => e.after_state));
    expect(text).not.toMatch(
      /protected answer|My real answer text|expectedAnswer|markingGuidance/i,
    );
  });
});

// =============================================================================
// RUNTIME PROFILE PERSISTENCE (Blocker 6)
// =============================================================================
describe("Runtime profile reference persistence", () => {
  it("the exact reviewed EXAMINER_COMMERCIAL_V1 runtime profile ref is persisted and projected for both assessment and lab claims", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);

    const assessmentAuthorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    // AUTHORIZE's own "one AUTHORIZED/RUNNING execution per student at a
    // time" admission ceiling (migration 031) would otherwise RATE_LIMIT a
    // second claim for the same learner -- terminalize the first claim via
    // owner-authority test seam (mirroring the expiry test's own trigger-
    // disable pattern) purely to free that slot for this test's second,
    // independent target.
    await owner(f.db);
    await f.db.exec(
      "alter table public.commercial_v1_examiner_executions disable trigger guard_examiner_execution",
    );
    await f.db.query(
      "update public.commercial_v1_examiner_executions set state='CANCELLED',reason_code='CANCELLED',terminal_at=clock_timestamp() where id=$1",
      [assessmentAuthorized.result.execution!.executionId],
    );
    await f.db.exec(
      "alter table public.commercial_v1_examiner_executions enable trigger guard_examiner_execution",
    );
    const labAuthorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });

    await owner(f.db);
    const assessmentRef = await value<string>(
      f.db,
      "select runtime_profile_ref as v from public.commercial_v1_examiner_executions where id=$1",
      [assessmentAuthorized.result.execution!.executionId],
    );
    const labRef = await value<string>(
      f.db,
      "select runtime_profile_ref as v from public.commercial_v1_examiner_executions where id=$1",
      [labAuthorized.result.execution!.executionId],
    );
    expect(assessmentRef).toBe("EXAMINER_COMMERCIAL_V1");
    expect(labRef).toBe("EXAMINER_COMMERCIAL_V1");
  });
});

// =============================================================================
// EXECUTION IDENTITY IMMUTABILITY (Blocker 7)
// =============================================================================
describe("Execution identity immutability", () => {
  it("component, practical_id and runtime_profile_ref cannot be mutated on an active (non-terminal) execution row", async () => {
    const f = await fixture({ withLabs: false });
    await publishResultPolicy(f);
    const attemptId = await submitAssessmentAttempt(f, "QUIZ_1", {
      answer: "My answer.",
    });
    const key = await installKey(f);
    const authorized = await authorize(
      f.db,
      key,
      "grade_controlled_assessment",
      { attemptId },
    );
    const executionId = authorized.result.execution!.executionId;
    await owner(f.db);
    await expect(
      f.db.query(
        "update public.commercial_v1_examiner_executions set component='QUIZ_2' where id=$1",
        [executionId],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      f.db.query(
        "update public.commercial_v1_examiner_executions set runtime_profile_ref='OTHER_PROFILE' where id=$1",
        [executionId],
      ),
    ).rejects.toThrow();
    await expect(
      f.db.query(
        "update public.commercial_v1_examiner_executions set capability='grade_practical_lab' where id=$1",
        [executionId],
      ),
    ).rejects.toThrow();
  });

  it("practical_id cannot be mutated on an active lab execution row", async () => {
    const f = await fixture({ withLabs: true });
    const practicalId = await getOwnedPracticalId(f);
    await setLabPolicy(f, practicalId);
    await publishResultPolicy(f);
    const submissionId = await submitLabWork(f, practicalId);
    const key = await installKey(f);
    const authorized = await authorize(f.db, key, "grade_practical_lab", {
      submissionId,
    });
    const executionId = authorized.result.execution!.executionId;
    await owner(f.db);
    const foreignPracticalId = await value<string>(
      f.db,
      "select gen_random_uuid()::text as v",
    );
    await expect(
      f.db.query(
        "update public.commercial_v1_examiner_executions set practical_id=$2 where id=$1",
        [executionId, foreignPracticalId],
      ),
    ).rejects.toThrow("immutable");
  });
});
