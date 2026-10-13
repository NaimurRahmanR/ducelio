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
  // V2 correction (finding 9): safeAuthDestination is a BOUNDED allowlist,
  // not an arbitrary same-origin path -- being same-origin is necessary,
  // never sufficient.
  it("rejects every open-redirect bypass shape", () => {
    for (const path of [
      "https://evil.example",
      "http://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/javascript:alert(1)",
      "%2f%2fevil.example",
      "/%5C%5Cevil.example",
      " //evil.example",
      "//evil.example/../student",
    ])
      expect(safeAuthDestination(path)).toBe("/student");
  });
  it("rejects same-origin paths that are not on the bounded allowlist", () => {
    for (const path of [
      "/admin",
      "/admin/activation",
      "/api/commerce/stripe-webhook",
      "/api/admin",
      "/support",
      "/demo",
      "/unknown-route",
      "/courses/ab",
      "/courses/Not-Lower",
      "/courses/foo/bar",
    ])
      expect(safeAuthDestination(path)).toBe("/student");
  });
  it("allows exactly the destinations an existing auth flow needs: /student, /reset-password, /courses and a valid /courses/<slug>", () => {
    expect(safeAuthDestination("/student")).toBe("/student");
    expect(safeAuthDestination("/reset-password")).toBe("/reset-password");
    expect(safeAuthDestination("/courses")).toBe("/courses");
    expect(safeAuthDestination("/courses/cybersecurity-foundations")).toBe(
      "/courses/cybersecurity-foundations",
    );
  });
  // V3 correction (defect 2): "/courses/" (a bare trailing slash) is the
  // SAME bounded public catalogue destination as "/courses" -- it must be
  // accepted, deterministically canonicalized to "/courses", never
  // rejected as an unknown path.
  it("canonicalizes /courses/ (trailing slash, no slug) to /courses rather than rejecting it", () => {
    expect(safeAuthDestination("/courses/")).toBe("/courses");
  });
  it("drops any query/hash suffix on an allowlisted destination rather than passing it through unexamined", () => {
    expect(safeAuthDestination("/courses/cybersecurity-foundations?x=1")).toBe(
      "/courses/cybersecurity-foundations",
    );
    expect(safeAuthDestination("/student#section")).toBe("/student");
  });
  // LR-03: the one query-bearing destination, so a buyer whose sign-in lapsed
  // during Stripe Checkout returns to reconcile the exact order.
  const ORDER = "10000000-0000-4000-8000-000000000001";
  const SUCCESS = `/checkout/success?order=${ORDER}&session_id=cs_test_a1B2c3`;
  it("keeps a checkout success return with exactly a valid order and session id, rebuilt canonically", () => {
    expect(safeAuthDestination(SUCCESS)).toBe(SUCCESS);
    expect(
      safeAuthDestination(
        `/checkout/success?session_id=cs_live_Z9&order=${ORDER}`,
      ),
    ).toBe(`/checkout/success?order=${ORDER}&session_id=cs_live_Z9`);
  });
  it("rejects every other checkout success shape", () => {
    for (const path of [
      "/checkout/success",
      `/checkout/success?order=${ORDER}`,
      `${SUCCESS}&next=/admin`,
      `${SUCCESS}&order=${ORDER}`,
      `${SUCCESS}#fragment`,
      `/checkout/success?order=not-a-uuid&session_id=cs_test_a1`,
      `/checkout/success?order=${ORDER}&session_id=pi_123`,
      `/checkout/success?order=${ORDER}&session_id=cs_test_a1%26next%3D%2Fadmin`,
      `/checkout/success?order=${ORDER}&session_id=cs_test_a1/../../admin`,
      `//evil.example/checkout/success?order=${ORDER}&session_id=cs_test_a1`,
      `/checkout/success/?order=${ORDER}&session_id=cs_test_a1`,
    ])
      expect(safeAuthDestination(path)).toBe("/student");
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
