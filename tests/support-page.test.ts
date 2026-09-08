import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  caseload: vi.fn(),
  profile: vi.fn(),
  plan: vi.fn(),
  followups: vi.fn(),
  events: vi.fn(),
  interactions: vi.fn(),
  programmes: vi.fn(),
}));
vi.mock("@/server/staff", () => ({ getCounsellorCaseload: mocks.caseload }));
vi.mock("@/server/support", () => ({
  getStudentSupportProfile: mocks.profile,
  getStudyPlan: mocks.plan,
  getSupportFollowups: mocks.followups,
  getOpenSupportEvents: mocks.events,
  getPrivateInteractions: mocks.interactions,
  getStudentProgrammeMembership: mocks.programmes,
}));
vi.mock("@/components/staff-shell", () => ({ StaffShell: () => null }));
vi.mock("@/components/counsellor-workspace", () => ({
  CounsellorWorkspace: () => null,
}));
import Page from "@/app/support/page";
const learnerId = "10000000-0000-4000-8000-000000000001";
describe("counsellor learner selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.caseload.mockResolvedValue({
      actor: { displayName: "Counsellor" },
      learners: [{ id: learnerId, display_name: "Learner" }],
    });
    mocks.profile.mockResolvedValue(null);
    mocks.plan.mockResolvedValue({ plan: null, items: [] });
    for (const f of [
      mocks.followups,
      mocks.events,
      mocks.interactions,
      mocks.programmes,
    ])
      f.mockResolvedValue([]);
  });
  it("does not fetch private data for a forged or unassigned learner ID", async () => {
    await Page({
      searchParams: Promise.resolve({ student: "unassigned-learner" }),
    });
    for (const f of [
      mocks.profile,
      mocks.plan,
      mocks.followups,
      mocks.events,
      mocks.interactions,
      mocks.programmes,
    ])
      expect(f).not.toHaveBeenCalled();
  });
  it("loads records only for a learner returned in the authorised caseload", async () => {
    await Page({ searchParams: Promise.resolve({ student: learnerId }) });
    for (const f of [
      mocks.profile,
      mocks.plan,
      mocks.followups,
      mocks.events,
      mocks.interactions,
      mocks.programmes,
    ])
      expect(f).toHaveBeenCalledWith(learnerId);
  });
  it("does not load a case when the caseload is empty", async () => {
    mocks.caseload.mockResolvedValue({
      actor: { displayName: "Counsellor" },
      learners: [],
    });
    await Page({ searchParams: Promise.resolve({}) });
    expect(mocks.interactions).not.toHaveBeenCalled();
  });
});
