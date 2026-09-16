import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_V1_LEADERBOARD_POLICY,
  publishCommercialV1LeaderboardSnapshotInputSchema,
  commercialV1LeaderboardResultSchema,
  commercialV1LeaderboardEntrySchema,
} from "@/domain/commercial-v1-leaderboard";

const activationId = "aaaaaaaa-0000-4000-8000-000000000001";
const enrolmentId = "bbbbbbbb-0000-4000-8000-000000000001";

describe("Policy identity", () => {
  it("is the fixed COMMERCIAL_V1_LEADERBOARD_V1 string", () => {
    expect(COMMERCIAL_V1_LEADERBOARD_POLICY).toBe(
      "COMMERCIAL_V1_LEADERBOARD_V1",
    );
  });
});

describe("Publish input contract forbids caller-supplied ranking state", () => {
  it("accepts only activationId + reason", () => {
    expect(
      publishCommercialV1LeaderboardSnapshotInputSchema.safeParse({
        activationId,
        reason: "Publish end-of-term leaderboard",
      }).success,
    ).toBe(true);
  });
  it("rejects a caller-supplied score, rank, enrolment list or result revision", () => {
    const base = { activationId, reason: "Publish end-of-term leaderboard" };
    for (const extra of [
      { scoreBp: 10000 },
      { rank: 1 },
      { enrolments: [enrolmentId] },
      { resultRevisionId: enrolmentId },
    ]) {
      expect(
        publishCommercialV1LeaderboardSnapshotInputSchema.safeParse({
          ...base,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
  it("rejects a missing or overlong reason", () => {
    expect(
      publishCommercialV1LeaderboardSnapshotInputSchema.safeParse({
        activationId,
      }).success,
    ).toBe(false);
    expect(
      publishCommercialV1LeaderboardSnapshotInputSchema.safeParse({
        activationId,
        reason: "hi",
      }).success,
    ).toBe(false);
  });
});

describe("Leaderboard entry contract", () => {
  it("accepts the bounded shape and rejects an unknown/protected field", () => {
    const base = {
      rank: 1,
      scoreBp: 9500,
      label: "Learner 7F3A91BC204E",
      isSelf: true,
    };
    expect(commercialV1LeaderboardEntrySchema.safeParse(base).success).toBe(
      true,
    );
    for (const extra of [
      { expectedAnswer: "leak" },
      { markingGuidance: "leak" },
      { resultRevisionId: enrolmentId },
      { gradeDigest: "a".repeat(64) },
      // V2 correction (item D): a peer entry may never carry a real display
      // name or another learner's enrolment id -- both are now structurally
      // rejected extra fields, not merely unused.
      { displayName: "Real Name" },
      { enrolmentId },
    ]) {
      expect(
        commercialV1LeaderboardEntrySchema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
    }
  });
});

describe("Leaderboard projection result contract", () => {
  it("accepts the unpublished, published and denied shapes", () => {
    expect(
      commercialV1LeaderboardResultSchema.safeParse({
        ok: true,
        published: false,
      }).success,
    ).toBe(true);
    expect(
      commercialV1LeaderboardResultSchema.safeParse({
        ok: true,
        published: true,
        snapshotId: activationId,
        publishedAt: "2026-01-01T00:00:00Z",
        entryCount: 1,
        selfEnrolmentId: enrolmentId,
        selfRank: 1,
        selfScoreBp: 10000,
        nudge: "You are rank 1.",
        entries: [
          {
            rank: 1,
            scoreBp: 10000,
            label: "You",
            isSelf: true,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      commercialV1LeaderboardResultSchema.safeParse({
        ok: false,
        code: "NOT_FOUND_OR_FORBIDDEN",
      }).success,
    ).toBe(true);
    expect(
      commercialV1LeaderboardResultSchema.safeParse({
        ok: false,
        code: "MADE_UP",
      }).success,
    ).toBe(false);
  });
});

describe("No new AI/provider surface and no arbitrary write route (static source proof)", () => {
  it("migration 033 introduces no provider/model/HMAC call and reuses only existing admin authority", () => {
    const migration = readFileSync(
      "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
      "utf8",
    );
    expect(migration).not.toMatch(
      /extensions\.hmac|govern_commercial_v1_examiner|ACADEMIC_EXECUTION_KEY_ID/,
    );
    expect(migration).toMatch(/course_activation_private\.require_admin\(\)/);
  });
  it("no arbitrary snapshot writer is exposed to authenticated beyond the one governed publish RPC", () => {
    const migration = readFileSync(
      "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
      "utf8",
    );
    const grants = [
      ...migration.matchAll(
        /grant execute on function (public\.\w+)\([^)]*\) to authenticated/g,
      ),
    ].map((m) => m[1]);
    expect(new Set(grants)).toEqual(
      new Set([
        "public.publish_commercial_v1_leaderboard_snapshot",
        "public.get_commercial_v1_leaderboard",
      ]),
    );
  });
});

describe("V2 correction: serialization, authorization and determinism (static source proof)", () => {
  const migration = readFileSync(
    "supabase/migrations/202609160033_commercial_v1_leaderboard.sql",
    "utf8",
  );

  it("item A/V3: publication locks activation, cohort membership, then the complete eligible-enrolment scope", () => {
    const activationLock = migration.indexOf(
      "course_activations where id=p_activation_id for update",
    );
    const cohortLock = migration.indexOf(
      "from public.cohorts where id=activation.cohort_id for update",
    );
    const enrolmentLock = migration.indexOf("order by id\n    for update");
    expect(activationLock).toBeGreaterThan(-1);
    expect(cohortLock).toBeGreaterThan(activationLock);
    expect(enrolmentLock).toBeGreaterThan(cohortLock);

    const enrolmentWorkflow = readFileSync(
      "supabase/migrations/202609080007_phase2_enrolment_workflow.sql",
      "utf8",
    );
    expect(enrolmentWorkflow).toMatch(
      /from public\.cohorts c[\s\S]{0,300}where c\.id = p_cohort_id[\s\S]{0,120}for share of c, v/,
    );
  });

  it("item B: the ranking population is ACTIVE, PAUSED or COMPLETED -- WITHDRAWN is not in the list", () => {
    expect(migration).toMatch(/status in \('ACTIVE','PAUSED','COMPLETED'\)/);
    expect(migration).not.toMatch(/status in \('ACTIVE','COMPLETED'\)/);
  });

  it("item C: publication checks a real bound formal-component window, never a caller-supplied date", () => {
    expect(migration).toMatch(
      /commercial_v1_component_bindings[\s\S]{0,200}closes_at>clock_timestamp\(\)/,
    );
    expect(migration).not.toMatch(/p_closes_at|p_window|p_date/);
  });

  it("item D: the learner projection never selects app_users.display_name", () => {
    // A comment MAY discuss display_name (documenting that it is no longer
    // used); the query itself must never reference it as a column, and the
    // app_users table must never be joined at all in this migration.
    expect(migration).not.toMatch(/\bu\.display_name\b/);
    expect(migration).not.toMatch(/join public\.app_users/);
    expect(migration).toMatch(/'label'/);
  });

  it("item E: the learner-read RPC checks STUDENT authority and snapshot membership itself", () => {
    expect(migration).toMatch(/has_role\('STUDENT'\)/);
    expect(migration).toMatch(/is_member/);
  });

  it("item F: latest-snapshot selection uses a real monotonic secondary key, not published_at alone", () => {
    expect(migration).toMatch(/publication_sequence/);
    expect(migration).toMatch(
      /order by published_at desc,publication_sequence desc/,
    );
  });

  it("V3 efficiency: dense ranking is one set-based INSERT using dense_rank(), with no higher_count loop", () => {
    expect(migration).toMatch(
      /dense_rank\(\) over\(order by staged_score_bp\[i\] desc\)::integer/,
    );
    expect(migration).toMatch(
      /from generate_subscripts\(staged_enrolment_id,1\)/,
    );
    expect(migration).not.toMatch(/higher_count/);
  });
});
