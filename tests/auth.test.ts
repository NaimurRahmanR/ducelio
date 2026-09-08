import { describe, it, expect } from "vitest";
import {
  safeAuthDestination,
  signUpSchema,
  confirmationTypeSchema,
} from "@/domain/auth";
describe("authentication application boundaries", () => {
  it("prevents open redirects", () => {
    for (const path of [
      "https://evil.test",
      "//evil.test",
      "/admin",
      "/\\evil.test",
      "%2f%2fevil.test",
      null,
    ])
      expect(safeAuthDestination(path)).toBe("/student");
    expect(safeAuthDestination("/reset-password")).toBe("/reset-password");
  });
  it("requires bounded signup fields and a long password", () => {
    expect(
      signUpSchema.safeParse({
        email: "a@example.com",
        displayName: "Alex",
        password: "short",
      }).success,
    ).toBe(false);
    expect(
      signUpSchema.safeParse({
        email: "a@example.com",
        displayName: "Alex",
        password: "long demo password",
        role: "PLATFORM_ADMIN",
      }),
    ).toMatchObject({ success: true, data: { displayName: "Alex" } });
    const result = signUpSchema.parse({
      email: "a@example.com",
      displayName: "Alex",
      password: "long demo password",
      role: "PLATFORM_ADMIN",
    });
    expect(result).not.toHaveProperty("role");
  });
  it("restricts email confirmation types", () => {
    expect(confirmationTypeSchema.safeParse("invite").success).toBe(false);
    expect(confirmationTypeSchema.safeParse("recovery").success).toBe(true);
  });
});
