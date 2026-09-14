import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMMERCIAL_V1_GRADING_POLICY,
  COMMERCIAL_V1_COMPONENTS,
  COMMERCIAL_V1_WEIGHTS_BP,
  COMMERCIAL_V1_TOTAL_WEIGHT_BP,
  commercialV1ComponentSchema,
  commercialV1ResolvedProfileSchema,
  bindCommercialV1ComponentInputSchema,
  publishCommercialV1GradingPolicyInputSchema,
  commercialV1ActiveAttemptSchema,
  recordCommercialV1ResponseInputSchema,
  recordCommercialV1ResponseResultSchema,
  submissionProvenanceSchema,
} from "@/domain/commercial-v1-assessment-policy";

describe("Commercial V1 formal component vocabulary", () => {
  it("is exactly the six institutionally meaningful components, in order", () => {
    expect(COMMERCIAL_V1_COMPONENTS).toEqual([
      "QUIZ_1",
      "QUIZ_2",
      "MIDTERM",
      "QUIZ_3",
      "QUIZ_4",
      "FINAL",
    ]);
  });
  it("rejects any component name outside the fixed six", () => {
    expect(commercialV1ComponentSchema.safeParse("QUIZ_5").success).toBe(false);
    expect(commercialV1ComponentSchema.safeParse("LABS").success).toBe(false);
    expect(commercialV1ComponentSchema.safeParse("final").success).toBe(false);
  });
});

describe("Grading profile identity and weights", () => {
  it("policy_version is the fixed COMMERCIAL_V1_GRADING_V1 string", () => {
    expect(COMMERCIAL_V1_GRADING_POLICY).toBe("COMMERCIAL_V1_GRADING_V1");
  });
  it("resolvedProfile accepts only WITH_LABS or NO_LABS -- never a caller-invented value", () => {
    expect(
      commercialV1ResolvedProfileSchema.safeParse("WITH_LABS").success,
    ).toBe(true);
    expect(commercialV1ResolvedProfileSchema.safeParse("NO_LABS").success).toBe(
      true,
    );
    expect(
      commercialV1ResolvedProfileSchema.safeParse("PARTIAL_LABS").success,
    ).toBe(false);
  });
  it("WITH_LABS weights sum to exactly 10000 basis points, matching the spec exactly", () => {
    const w = COMMERCIAL_V1_WEIGHTS_BP.WITH_LABS;
    expect(w).toEqual({
      QUIZ_1: 500,
      QUIZ_2: 500,
      MIDTERM: 2000,
      QUIZ_3: 500,
      QUIZ_4: 500,
      LABS: 2000,
      FINAL: 4000,
    });
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBe(COMMERCIAL_V1_TOTAL_WEIGHT_BP);
  });
  it("NO_LABS weights sum to exactly 10000 basis points, matching the spec exactly", () => {
    const w = COMMERCIAL_V1_WEIGHTS_BP.NO_LABS;
    expect(w).toEqual({
      QUIZ_1: 500,
      QUIZ_2: 500,
      MIDTERM: 2000,
      QUIZ_3: 500,
      QUIZ_4: 500,
      LABS: 0,
      FINAL: 6000,
    });
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBe(COMMERCIAL_V1_TOTAL_WEIGHT_BP);
  });
  it("every weight constant is an exact integer -- never a float -- structurally ruling out floating-point institutional weighting", () => {
    for (const profile of ["WITH_LABS", "NO_LABS"] as const) {
      for (const value of Object.values(COMMERCIAL_V1_WEIGHTS_BP[profile])) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

describe("Governed RPC input contracts forbid caller-supplied profile/weights/timestamps", () => {
  it("bindCommercialV1ComponentInputSchema is a strictObject with exactly activationId/component/assessmentId/reason", () => {
    const valid = {
      activationId: "aaaaaaaa-0000-4000-8000-000000000001",
      component: "QUIZ_1",
      assessmentId: "bbbbbbbb-0000-4000-8000-000000000001",
      reason: "Bind quiz one for this activation",
    };
    expect(bindCommercialV1ComponentInputSchema.safeParse(valid).success).toBe(
      true,
    );
    for (const extra of [
      { weightBp: 500 },
      { profile: "WITH_LABS" },
      { attemptsAllowed: 3 },
    ]) {
      expect(
        bindCommercialV1ComponentInputSchema.safeParse({ ...valid, ...extra })
          .success,
      ).toBe(false);
    }
  });
  it("publishCommercialV1GradingPolicyInputSchema is a strictObject with exactly activationId/reason -- no weight/profile/lab-presence field exists at all", () => {
    const valid = {
      activationId: "aaaaaaaa-0000-4000-8000-000000000001",
      reason: "Publish the grading policy for this activation",
    };
    expect(
      publishCommercialV1GradingPolicyInputSchema.safeParse(valid).success,
    ).toBe(true);
    for (const extra of [
      { resolvedProfile: "WITH_LABS" },
      { weights: { FINAL: 4000 } },
      { hasLabs: true },
      { finalWeightBp: 9999 },
    ]) {
      expect(
        publishCommercialV1GradingPolicyInputSchema.safeParse({
          ...valid,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("Resume DTO redaction", () => {
  it("commercialV1ActiveAttemptSchema exposes only bounded safe fields, never a question prompt/answer/marking field", () => {
    const valid = {
      attemptId: "aaaaaaaa-0000-4000-8000-000000000001",
      assessmentId: "bbbbbbbb-0000-4000-8000-000000000001",
      attemptNumber: 1,
      title: "Quiz 1",
      startedAt: "2026-09-14T10:00:00Z",
      expiresAt: "2026-09-14T11:00:00Z",
    };
    expect(commercialV1ActiveAttemptSchema.safeParse(valid).success).toBe(true);
    expect(commercialV1ActiveAttemptSchema.safeParse(null).success).toBe(true);
    for (const extra of [
      { expectedAnswer: "leak" },
      { markingGuidance: "leak" },
      { prompt: "leak" },
    ]) {
      expect(
        commercialV1ActiveAttemptSchema.safeParse({ ...valid, ...extra })
          .success,
      ).toBe(false);
    }
  });
});

describe("Server-layer forbidden fields (static source-text proof)", () => {
  it("src/server/commercial-v1-assessment-policy.ts never reads a client-supplied weight/profile/timestamp field", () => {
    const source = readFileSync(
      "src/server/commercial-v1-assessment-policy.ts",
      "utf8",
    );
    expect(source).not.toMatch(
      /weightBp|resolvedProfile|hasLabs|startedAt|expiresAt/i,
    );
  });
  it("the governed publish RPC call forwards only p_activation_id and p_reason", () => {
    const source = readFileSync(
      "src/server/commercial-v1-assessment-policy.ts",
      "utf8",
    );
    const call = source.slice(
      source.indexOf("publish_commercial_v1_grading_policy"),
      source.indexOf("publish_commercial_v1_grading_policy") + 400,
    );
    expect(call).toMatch(/p_activation_id/);
    expect(call).toMatch(/p_reason/);
    expect(call).not.toMatch(/p_profile|p_weight|p_labs/);
  });
});

describe("Dedicated Commercial V1 response RPC contract (independent review blocker fix)", () => {
  it("recordCommercialV1ResponseInputSchema has no state/timestamp/provenance field a caller could supply", () => {
    const valid = {
      attemptId: "aaaaaaaa-0000-4000-8000-000000000001",
      questionId: "bbbbbbbb-0000-4000-8000-000000000001",
      body: "My answer",
      idempotencyKey: "idempotency-key-12345",
    };
    expect(recordCommercialV1ResponseInputSchema.safeParse(valid).success).toBe(
      true,
    );
    for (const extra of [
      { expiresAt: "2026-09-14T10:00:00Z" },
      { submissionProvenance: "STUDENT_SUBMIT" },
      { state: "SUBMITTED" },
    ]) {
      expect(
        recordCommercialV1ResponseInputSchema.safeParse({ ...valid, ...extra })
          .success,
      ).toBe(false);
    }
  });
  it("recordCommercialV1ResponseResultSchema accepts a success shape and every documented ok:false code, including EXPIRED with its state/submittedAt/submissionProvenance fields", () => {
    expect(
      recordCommercialV1ResponseResultSchema.safeParse({
        ok: true,
        responseId: "aaaaaaaa-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
    expect(
      recordCommercialV1ResponseResultSchema.safeParse({
        ok: false,
        code: "EXPIRED",
        state: "SUBMITTED",
        submittedAt: "2026-09-14T10:00:00Z",
        submissionProvenance: "AUTO_TIMEOUT",
      }).success,
    ).toBe(true);
    expect(
      recordCommercialV1ResponseResultSchema.safeParse({
        ok: false,
        code: "NOT_COMMERCIAL_V1_GOVERNED",
      }).success,
    ).toBe(true);
    expect(
      recordCommercialV1ResponseResultSchema.safeParse({
        ok: false,
        code: "SOMETHING_MADE_UP",
      }).success,
    ).toBe(false);
  });
});

describe("Submission provenance is durable, first-class, explicit institutional state (independent review requirement)", () => {
  it("submissionProvenanceSchema distinguishes learner submission, timeout and administrative closure", () => {
    expect(submissionProvenanceSchema.options).toEqual([
      "STUDENT_SUBMIT",
      "AUTO_TIMEOUT",
      "ADMIN_CLOSED",
    ]);
  });
  it("the persistence mechanism is a real table column with PostgreSQL-enforced constraints, not audit_reason/inference/application reconstruction", () => {
    const migration = readFileSync(
      "supabase/migrations/202609140029_commercial_v1_assessment_policy.sql",
      "utf8",
    );
    // The exact additive column onto the pre-existing assessment_attempts
    // table (migration 016, untouched) -- nullable, no inline CHECK on the
    // add itself (the value-set CHECK is added separately, AFTER the
    // one-time historical backfill below, so it can validate against
    // already-backfilled rows rather than blocking the migration).
    expect(migration).toMatch(
      /alter table public\.assessment_attempts\s*\n\s*add column submission_provenance text;/,
    );
    // The one-time historical backfill: every PRE-EXISTING SUBMITTED row
    // (assessment_attempts predates this column entirely) gets the honest
    // LEGACY_UNCLASSIFIED sentinel -- never a fabricated STUDENT_SUBMIT or
    // AUTO_TIMEOUT guess.
    expect(migration).toMatch(
      /update public\.assessment_attempts\s*\n\s*set submission_provenance='LEGACY_UNCLASSIFIED'\s*\n\s*where state='SUBMITTED' and submission_provenance is null;/,
    );
    // The exact four-value CHECK.
    expect(migration).toMatch(
      /add constraint submission_provenance_values\s*\n\s*check\(submission_provenance is null or submission_provenance in \('STUDENT_SUBMIT','AUTO_TIMEOUT','ADMIN_CLOSED','LEGACY_UNCLASSIFIED'\)\)/,
    );
    // The exact named constraint making it schema-impossible for a
    // SUBMITTED attempt to lack provenance, or a non-SUBMITTED attempt to
    // carry one -- the database itself enforces the truthfulness
    // invariant, not application code. Safe against historical data only
    // BECAUSE the backfill above runs first, in the same migration.
    expect(migration).toMatch(
      /add constraint submission_provenance_truthful\s*\n\s*check\(\(state='SUBMITTED'\)=\(submission_provenance is not null\)\)/,
    );
  });
  it("no governed writer function ever writes the legacy sentinel -- it is structurally unreachable outside the one-time backfill", () => {
    const migration = readFileSync(
      "supabase/migrations/202609140029_commercial_v1_assessment_policy.sql",
      "utf8",
    );
    // Exactly one occurrence of the literal assignment, inside the backfill
    // UPDATE itself -- never inside submit_assessment_attempt,
    // finalize_expired_attempts_for_actor, or
    // record_commercial_v1_assessment_response.
    const assignments =
      migration.match(/submission_provenance\s*=\s*'LEGACY_UNCLASSIFIED'/g) ??
      [];
    expect(assignments).toHaveLength(1);
  });
});

describe("Expired response result is a strict terminal DTO", () => {
  const valid = {
    ok: false,
    code: "EXPIRED",
    state: "SUBMITTED",
    submittedAt: "2026-09-14T10:00:00Z",
    submissionProvenance: "AUTO_TIMEOUT",
  };
  it.each(["state", "submittedAt", "submissionProvenance"])(
    "requires %s",
    (key) => {
      const malformed: Record<string, unknown> = { ...valid };
      delete malformed[key];
      expect(
        recordCommercialV1ResponseResultSchema.safeParse(malformed).success,
      ).toBe(false);
    },
  );
  it.each([
    { state: "ACTIVE" },
    { submittedAt: null },
    { submittedAt: "not-a-date" },
    { submissionProvenance: "STUDENT_SUBMIT" },
    { submissionProvenance: "ADMIN_CLOSED" },
    { code: "INVALID_INPUT" },
    { body: "sensitive" },
  ])("rejects impossible or extra fields: %j", (change) => {
    expect(
      recordCommercialV1ResponseResultSchema.safeParse({ ...valid, ...change })
        .success,
    ).toBe(false);
  });
});
