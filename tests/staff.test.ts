import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  createSupabase: vi.fn(),
}));
vi.mock("@/server/identity", () => ({ requireActor: mocks.requireActor }));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.createSupabase }));
import { getAdminOverview, getCounsellorCaseload } from "@/server/staff";
describe("staff service authorization before database access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireActor.mockRejectedValue(new Error("Access denied"));
  });
  it("requires counsellor area access before reading assignments", async () => {
    await expect(getCounsellorCaseload()).rejects.toThrow("Access denied");
    expect(mocks.requireActor).toHaveBeenCalledWith("support");
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });
  it("requires administration access before reading institutional records", async () => {
    await expect(getAdminOverview()).rejects.toThrow("Access denied");
    expect(mocks.requireActor).toHaveBeenCalledWith("admin");
    expect(mocks.createSupabase).not.toHaveBeenCalled();
  });
});
