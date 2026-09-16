import { describe, expect, it, vi, beforeEach } from "vitest";

// V2 correction (item G): dedicated server-function coverage for
// src/server/commercial-v1-leaderboard.ts. Mirrors tests/commercial-v1-
// examiner-grading-authority.test.ts's own pattern -- only @/server/
// identity and @/server/supabase are mocked; the REAL exported functions
// run, so this proves the TS layer forwards exactly the intended RPC name/
// args and never fabricates or recomputes what the RPC returned.
const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));

import {
  getCommercialV1Leaderboard,
  publishCommercialV1LeaderboardSnapshot,
} from "@/server/commercial-v1-leaderboard";

const enrolmentId = "10000000-0000-4000-8000-000000000001";
const activationId = "20000000-0000-4000-8000-000000000001";
const snapshotId = "30000000-0000-4000-8000-000000000001";

describe("server: getCommercialV1Leaderboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls the RPC with exactly the requested enrolment id and returns the server-derived result unchanged (no client-side recomputation)", async () => {
    mocks.requireActor.mockResolvedValue({ id: "actor" });
    const published = {
      ok: true,
      published: true,
      snapshotId,
      publishedAt: "2026-01-01T00:00:00Z",
      entryCount: 2,
      selfEnrolmentId: enrolmentId,
      selfRank: 2,
      selfScoreBp: 8000,
      nudge: "1 learner(s) rank above you.",
      entries: [
        { rank: 1, scoreBp: 9000, label: "Learner AB12", isSelf: false },
        { rank: 2, scoreBp: 8000, label: "You", isSelf: true },
      ],
    };
    const rpc = vi.fn().mockResolvedValue({ data: published, error: null });
    mocks.client.mockResolvedValue({ rpc });
    const result = await getCommercialV1Leaderboard(enrolmentId);
    expect(rpc).toHaveBeenCalledWith("get_commercial_v1_leaderboard", {
      p_enrolment_id: enrolmentId,
    });
    expect(result).toEqual(published);
  });

  it("fails closed (throws) rather than swallowing an RPC error", async () => {
    mocks.requireActor.mockResolvedValue({ id: "actor" });
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "denied" } });
    mocks.client.mockResolvedValue({ rpc });
    await expect(getCommercialV1Leaderboard(enrolmentId)).rejects.toThrow();
  });

  it("rejects a malformed/forged enrolment id before the RPC is ever called", async () => {
    mocks.requireActor.mockResolvedValue({ id: "actor" });
    const rpc = vi.fn();
    mocks.client.mockResolvedValue({ rpc });
    await expect(getCommercialV1Leaderboard("not-a-uuid")).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("server: publishCommercialV1LeaderboardSnapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("requires admin authority and forwards exactly activationId/reason to the RPC", async () => {
    mocks.requireActor.mockResolvedValue({ id: "admin" });
    const rpc = vi.fn().mockResolvedValue({ data: snapshotId, error: null });
    mocks.client.mockResolvedValue({ rpc });
    const result = await publishCommercialV1LeaderboardSnapshot({
      activationId,
      reason: "Publish end-of-term leaderboard",
    });
    expect(mocks.requireActor).toHaveBeenCalledWith("admin");
    expect(rpc).toHaveBeenCalledWith(
      "publish_commercial_v1_leaderboard_snapshot",
      {
        p_activation_id: activationId,
        p_reason: "Publish end-of-term leaderboard",
      },
    );
    expect(result).toBe(snapshotId);
  });

  it("rejects -- before the RPC is ever called or admin authority is even checked -- a caller-supplied score, rank or enrolment list the strict input schema does not accept", async () => {
    mocks.requireActor.mockResolvedValue({ id: "admin" });
    const rpc = vi.fn();
    mocks.client.mockResolvedValue({ rpc });
    await expect(
      publishCommercialV1LeaderboardSnapshot({
        activationId,
        reason: "Publish end-of-term leaderboard",
        scoreBp: 9999,
        rank: 1,
      } as never),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied activationId/reason shape the schema does not accept, before the RPC is ever called", async () => {
    mocks.requireActor.mockResolvedValue({ id: "admin" });
    const rpc = vi.fn();
    mocks.client.mockResolvedValue({ rpc });
    await expect(
      publishCommercialV1LeaderboardSnapshot({
        activationId: "not-a-uuid",
        reason: "Publish end-of-term leaderboard",
      }),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
