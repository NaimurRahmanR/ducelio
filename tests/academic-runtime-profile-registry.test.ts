import { describe, expect, it } from "vitest";
import {
  resolveAdapterForProfile,
  resolveRuntimeProfile,
} from "@/server/academic-runtime/profile-registry";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import { PROVIDER_EXECUTION_DB_CEILING } from "@/domain/academic-provider-execution";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

describe("resolveRuntimeProfile", () => {
  it("returns null for a null reference", () => {
    expect(resolveRuntimeProfile(null)).toBeNull();
  });

  it("returns null for any reference other than the one reviewed Commercial V1 profile", () => {
    // The production registry contains exactly one reviewed entry,
    // PROFESSOR_COMMERCIAL_V1 (see the dedicated describe block below);
    // every other reference -- including a plausible-looking guess -- must
    // still fail closed.
    expect(resolveRuntimeProfile("anything-at-all")).toBeNull();
    expect(resolveRuntimeProfile("professor_commercial_v1")).toBeNull();
    expect(resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V2")).toBeNull();
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

describe("the production registry's one reviewed Commercial V1 profile", () => {
  it("resolves PROFESSOR_COMMERCIAL_V1 to a conservative, DB-ceiling-compliant HTTP_JSON profile", () => {
    const profile = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1");
    expect(profile).toMatchObject({
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
    });
    expect(profile?.budgetPolicy.maxProviderCalls).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxProviderCalls,
    );
    expect(profile?.budgetPolicy.maxProviderCalls).toBeGreaterThanOrEqual(1);
    expect(profile?.budgetPolicy.maxOutputTokens).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxOutputTokens,
    );
    expect(profile?.budgetPolicy.maxOutputTokens).toBeGreaterThanOrEqual(1);
    expect(profile?.budgetPolicy.maxEstimatedCostMicrousd).toBeLessThanOrEqual(
      PROVIDER_EXECUTION_DB_CEILING.maxEstimatedCostMicrousd,
    );
    expect(
      profile?.budgetPolicy.maxEstimatedCostMicrousd,
    ).toBeGreaterThanOrEqual(1);
  });

  it("fails closed to null when no provider environment is configured, even for the reviewed profile", () => {
    const profile = resolveRuntimeProfile("PROFESSOR_COMMERCIAL_V1")!;
    expect(resolveAdapterForProfile(profile)).toBeNull();
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
