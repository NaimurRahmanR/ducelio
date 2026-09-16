import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// V2 correction (item G): dedicated page-behavior coverage for
// src/app/student/leaderboard/page.tsx, mirroring tests/support-page.
// test.ts's own pattern -- mock every @/server/* module the page imports,
// call the exported async Page function directly (no DOM renderer), and
// inspect either the mock call graph or the returned React element tree's
// own text via a small local flattener. Real server-function behavior
// (RPC forwarding, no-recomputation) is covered separately in
// tests/commercial-v1-leaderboard-server.test.ts -- combining both in one
// file is not possible here since the page test must mock
// @/server/commercial-v1-leaderboard wholesale, which would shadow that
// module's REAL implementation for the whole file.
const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  requireStudentPrincipal: vi.fn(),
  listPracticalEnrolments: vi.fn(),
  getCommercialV1Leaderboard: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireActor: mocks.requireActor,
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/course-activation", () => ({
  listPracticalEnrolments: mocks.listPracticalEnrolments,
}));
vi.mock("@/server/commercial-v1-leaderboard", () => ({
  getCommercialV1Leaderboard: mocks.getCommercialV1Leaderboard,
}));
vi.mock("@/components/academy-shell", () => ({
  AcademyShell: ({ children }: { children: ReactNode }) => children,
}));

import Page from "@/app/student/leaderboard/page";

const enrolmentId = "10000000-0000-4000-8000-000000000001";
const snapshotId = "30000000-0000-4000-8000-000000000001";

// React elements are plain {type,props} objects -- this walks .props.children
// and joins every string/number leaf, exactly enough to assert on rendered
// text without pulling in a DOM renderer (no new testing framework).
function flatten(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && node !== null && "props" in node) {
    return flatten((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

const enrolment = { id: enrolmentId, title: "Commercial V1 Course" };

describe("page: /student/leaderboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireActor.mockResolvedValue(undefined);
    mocks.requireStudentPrincipal.mockResolvedValue({
      displayName: "Learner",
      roles: ["STUDENT"],
    });
    mocks.listPracticalEnrolments.mockResolvedValue([enrolment]);
  });

  it("renders an honest not-yet-published state and no ranking table", async () => {
    mocks.getCommercialV1Leaderboard.mockResolvedValue({
      ok: true,
      published: false,
    });
    const el = await Page({ searchParams: Promise.resolve({}) });
    const text = flatten(el);
    expect(text).toMatch(/has been published/i);
    expect(text).not.toMatch(/\bRank\b/);
  });

  it("renders the published projection using the server-returned rank/score/label directly, in the order given (no client-side recomputation or re-sorting)", async () => {
    mocks.getCommercialV1Leaderboard.mockResolvedValue({
      ok: true,
      published: true,
      snapshotId,
      publishedAt: "2026-01-01T00:00:00Z",
      entryCount: 3,
      selfEnrolmentId: enrolmentId,
      selfRank: 2,
      selfScoreBp: 8000,
      nudge:
        "1 learner(s) rank above you; you are tied for your rank with 1 other learner(s).",
      // Deliberately NOT pre-sorted by score to prove the page never
      // re-sorts -- it must render in exactly this order.
      entries: [
        { rank: 2, scoreBp: 8000, label: "You", isSelf: true },
        {
          rank: 1,
          scoreBp: 9000,
          label: "Learner AB12CD34EF56",
          isSelf: false,
        },
        {
          rank: 2,
          scoreBp: 8000,
          label: "Learner CD34EF56AB12",
          isSelf: false,
        },
      ],
    });
    const el = await Page({
      searchParams: Promise.resolve({ enrolmentId }),
    });
    const text = flatten(el);
    // Server-returned order preserved verbatim.
    const youIdx = text.indexOf("You");
    const firstPeerIdx = text.indexOf("Learner AB12CD34EF56");
    const secondPeerIdx = text.indexOf("Learner CD34EF56AB12");
    expect(youIdx).toBeGreaterThan(-1);
    expect(youIdx).toBeLessThan(firstPeerIdx);
    expect(firstPeerIdx).toBeLessThan(secondPeerIdx);
    // Dense ties displayed identically: both rank-2 rows show "2".
    expect((text.match(/\b2\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The current learner is identified as You; peers use the pseudonymous
    // label verbatim, never a real name.
    expect(text).toContain("You");
    expect(text).toContain("Learner AB12CD34EF56");
    expect(text).toContain("Learner CD34EF56AB12");
    // The nudge is rendered exactly as the server derived it -- never a
    // different, page-computed message.
    expect(text).toContain(
      "1 learner(s) rank above you; you are tied for your rank with 1 other learner(s).",
    );
  });

  it("never fetches or displays a leaderboard for a forged/unowned enrolment id not present in the actor's own authorized list", async () => {
    await Page({
      searchParams: Promise.resolve({ enrolmentId: "forged-or-unowned-id" }),
    });
    expect(mocks.getCommercialV1Leaderboard).not.toHaveBeenCalled();
  });

  it("a learner without current STUDENT authority is denied before any leaderboard data is fetched", async () => {
    mocks.requireActor.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(mocks.getCommercialV1Leaderboard).not.toHaveBeenCalled();
  });

  it("renders an honest unavailable state (never a crash or leaked partial data) when the server denies the read -- e.g. an excluded/non-snapshot-member enrolment", async () => {
    mocks.getCommercialV1Leaderboard.mockRejectedValue(
      new Error("The leaderboard could not be loaded."),
    );
    const el = await Page({
      searchParams: Promise.resolve({ enrolmentId }),
    });
    const text = flatten(el);
    expect(text).toMatch(/unavailable/i);
    expect(text).not.toMatch(/\bRank\b/);
  });
});
