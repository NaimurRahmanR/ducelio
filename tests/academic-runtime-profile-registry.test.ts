import { describe, expect, it } from "vitest";
import {
  resolveAdapterForProfile,
  resolveRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

describe("resolveRuntimeProfile", () => {
  it("returns null for a null reference", () => {
    expect(resolveRuntimeProfile(null)).toBeNull();
  });

  it("returns null for an unknown reference against the production registry", () => {
    // The production registry ships empty until a real provider is
    // reviewed and added; no commercial-v1-course-agent-runtime checkpoint
    // has made that choice yet.
    expect(resolveRuntimeProfile("anything-at-all")).toBeNull();
  });

  it("resolves a profile only through an explicitly supplied registry, never implicitly", () => {
    const profile: RuntimeProfile = {
      ref: "explicit-test-profile",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    const customRegistry = { "explicit-test-profile": profile };
    expect(resolveRuntimeProfile("explicit-test-profile")).toBeNull();
    expect(resolveRuntimeProfile("explicit-test-profile", customRegistry)).toBe(
      profile,
    );
  });
});

describe("resolveAdapterForProfile", () => {
  it("never resolves a production adapter for a TEST_DETERMINISTIC profile", () => {
    const profile: RuntimeProfile = {
      ref: "test-profile",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    expect(resolveAdapterForProfile(profile)).toBeNull();
  });

  it("fails closed for an HTTP_JSON profile when no provider environment is configured", () => {
    const profile: RuntimeProfile = {
      ref: "http-profile",
      adapterKind: "HTTP_JSON",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    expect(resolveAdapterForProfile(profile)).toBeNull();
  });
});
