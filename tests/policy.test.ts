import { describe, it, expect } from "vitest";
import {
  canEnter,
  canAccessSupport,
  assertArea,
  type Actor,
} from "@/domain/policy";
import type { Role } from "@/domain/academy";
const actor = (role: Role, id = "student"): Actor => ({
  id,
  displayName: "Test",
  roles: [role],
});
describe("role and relationship boundaries", () => {
  it.each(["INSTRUCTOR", "COUNSELLOR", "STUDENT"] as Role[])(
    "denies %s the administration shell",
    (role) => {
      expect(canEnter(actor(role), "admin")).toBe(false);
      expect(() => assertArea(actor(role), "admin")).toThrow("Access denied");
    },
  );
  it.each(["ACADEMIC_ADMIN", "REGISTRAR", "PLATFORM_ADMIN"] as Role[])(
    "permits %s the administration shell",
    (role) => expect(canEnter(actor(role), "admin")).toBe(true),
  );
  it("requires counsellor role and active assignment", () => {
    expect(canAccessSupport(actor("COUNSELLOR"), "other", true)).toBe(true);
    expect(canAccessSupport(actor("COUNSELLOR"), "other", false)).toBe(false);
    expect(canAccessSupport(actor("INSTRUCTOR"), "other", true)).toBe(false);
  });
  it("prevents cross-student access and private-note access", () => {
    expect(canAccessSupport(actor("STUDENT"), "other", false)).toBe(false);
    expect(canAccessSupport(actor("STUDENT"), "student", false)).toBe(true);
    expect(canAccessSupport(actor("STUDENT"), "student", false, true)).toBe(
      false,
    );
  });
  it("does not give admins blanket private support access", () =>
    expect(
      canAccessSupport(actor("PLATFORM_ADMIN"), "other", false, true),
    ).toBe(false));
});
