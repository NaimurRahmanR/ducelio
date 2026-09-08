import { describe, it, expect, vi, beforeEach } from "vitest";
const getCurrentActor = vi.hoisted(() => vi.fn());
vi.mock("@/server/identity", () => ({ getCurrentActor }));
import { GET } from "@/app/api/admin/route";
describe("protected route handler", () => {
  beforeEach(() => getCurrentActor.mockReset());
  it("returns 401 without an authenticated identity", async () => {
    getCurrentActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
  it("returns 403 to a student", async () => {
    getCurrentActor.mockResolvedValue({ id: "s", roles: ["STUDENT"] });
    expect((await GET()).status).toBe(403);
  });
  it("admits an authorised administrator", async () => {
    getCurrentActor.mockResolvedValue({ id: "a", roles: ["ACADEMIC_ADMIN"] });
    expect((await GET()).status).toBe(200);
  });
});
