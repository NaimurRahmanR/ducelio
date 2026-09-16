import { z } from "zod";
import { academicTimestampSchema } from "./academic-reads";

// Commercial V1 PR12: immutable leaderboard snapshots, deterministic dense
// ranking, publication authority and bounded learner-safe projection.
// Migration 202609160033_commercial_v1_leaderboard.sql. PR12 creates no
// marks and reinterprets no weighting -- it consumes the authoritative
// Commercial V1 result state PR11A/PR11B1/PR11B2 already established.
export const COMMERCIAL_V1_LEADERBOARD_POLICY =
  "COMMERCIAL_V1_LEADERBOARD_V1" as const;

// Governed admin publication input: identifiers + a bounded reason only.
// No score, rank, result revision or learner list is ever accepted from a
// caller -- the database derives every ranked value.
export const publishCommercialV1LeaderboardSnapshotInputSchema = z.strictObject(
  {
    activationId: z.uuid(),
    reason: z.string().trim().min(5).max(300),
  },
);
export type PublishCommercialV1LeaderboardSnapshotInput = z.infer<
  typeof publishCommercialV1LeaderboardSnapshotInputSchema
>;

// V2 correction (independent review, item D): peer entries never carry a
// real display name or another learner's enrolment id -- only a
// deterministic, non-academic, rank-independent pseudonymous label. The
// current learner's own row is always labelled "You" (server-derived,
// never recomputed client-side). selfEnrolmentId remains available at the
// TOP LEVEL of the projection (the caller's own state), but no per-entry
// enrolmentId is ever exposed.
export const commercialV1LeaderboardEntrySchema = z.strictObject({
  rank: z.number().int().min(1),
  scoreBp: z.number().int().min(0).max(10000),
  label: z.string(),
  isSelf: z.boolean(),
});
export type CommercialV1LeaderboardEntry = z.infer<
  typeof commercialV1LeaderboardEntrySchema
>;

// Never a protected-content field: only rank/score/pseudonymous label/self.
// No expected answer, marking guidance, lab body, provider output, admin
// regrade reason, grade digest or execution metadata is ever part of this
// contract.
export const commercialV1LeaderboardResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), published: z.literal(false) }),
  z.strictObject({
    ok: z.literal(true),
    published: z.literal(true),
    snapshotId: z.uuid(),
    publishedAt: academicTimestampSchema,
    entryCount: z.number().int().min(1),
    selfEnrolmentId: z.uuid(),
    selfRank: z.number().int().min(1).nullable(),
    selfScoreBp: z.number().int().min(0).max(10000).nullable(),
    nudge: z.string().nullable(),
    entries: z.array(commercialV1LeaderboardEntrySchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["UNAUTHENTICATED", "NOT_FOUND_OR_FORBIDDEN"]),
  }),
]);
export type CommercialV1LeaderboardResult = z.infer<
  typeof commercialV1LeaderboardResultSchema
>;
