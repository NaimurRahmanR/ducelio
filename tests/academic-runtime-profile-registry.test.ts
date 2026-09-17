import { describe, expect, it } from "vitest";
import {
  resolveAdapterForProfile,
  resolveRoleBoundRuntimeProfile,
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

// PR16A regression matrix (checkpoint section 16): every role's runtime
// null/cross-role semantics, exercised directly against the real production
// registry (no test-injected resolver) so this proves the ACTUAL shipped
// PROFESSOR_COMMERCIAL_V1/TUTOR_COMMERCIAL_V1/LAB_INSTRUCTOR_COMMERCIAL_V1/
// EXAMINER_COMMERCIAL_V1 entries, not merely the domain policy in isolation.
describe("resolveRoleBoundRuntimeProfile", () => {
  it("PROFESSOR: resolves its exact ref and fails closed for null or any other role's/unknown ref", () => {
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "PROFESSOR_COMMERCIAL_V1"),
    ).toMatchObject({ ref: "PROFESSOR_COMMERCIAL_V1" });
    expect(resolveRoleBoundRuntimeProfile("PROFESSOR", null)).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "TUTOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile(
        "PROFESSOR",
        "LAB_INSTRUCTOR_COMMERCIAL_V1",
      ),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "EXAMINER_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("PROFESSOR", "unknown-ref"),
    ).toBeNull();
  });

  it("TUTOR: null defaults to TUTOR_COMMERCIAL_V1; any other role's/unknown ref fails closed", () => {
    expect(resolveRoleBoundRuntimeProfile("TUTOR", null)).toMatchObject({
      ref: "TUTOR_COMMERCIAL_V1",
    });
    expect(
      resolveRoleBoundRuntimeProfile("TUTOR", "TUTOR_COMMERCIAL_V1"),
    ).toMatchObject({ ref: "TUTOR_COMMERCIAL_V1" });
    expect(
      resolveRoleBoundRuntimeProfile("TUTOR", "PROFESSOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("TUTOR", "LAB_INSTRUCTOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("TUTOR", "EXAMINER_COMMERCIAL_V1"),
    ).toBeNull();
    expect(resolveRoleBoundRuntimeProfile("TUTOR", "unknown-ref")).toBeNull();
  });

  it("LAB_INSTRUCTOR: null defaults to LAB_INSTRUCTOR_COMMERCIAL_V1; any other role's/unknown ref fails closed", () => {
    expect(
      resolveRoleBoundRuntimeProfile("LAB_INSTRUCTOR", null),
    ).toMatchObject({ ref: "LAB_INSTRUCTOR_COMMERCIAL_V1" });
    expect(
      resolveRoleBoundRuntimeProfile(
        "LAB_INSTRUCTOR",
        "LAB_INSTRUCTOR_COMMERCIAL_V1",
      ),
    ).toMatchObject({ ref: "LAB_INSTRUCTOR_COMMERCIAL_V1" });
    expect(
      resolveRoleBoundRuntimeProfile(
        "LAB_INSTRUCTOR",
        "PROFESSOR_COMMERCIAL_V1",
      ),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("LAB_INSTRUCTOR", "TUTOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile(
        "LAB_INSTRUCTOR",
        "EXAMINER_COMMERCIAL_V1",
      ),
    ).toBeNull();
  });

  it("EXAMINER: null defaults to EXAMINER_COMMERCIAL_V1; any other role's/unknown ref fails closed", () => {
    expect(resolveRoleBoundRuntimeProfile("EXAMINER", null)).toMatchObject({
      ref: "EXAMINER_COMMERCIAL_V1",
    });
    expect(
      resolveRoleBoundRuntimeProfile("EXAMINER", "EXAMINER_COMMERCIAL_V1"),
    ).toMatchObject({ ref: "EXAMINER_COMMERCIAL_V1" });
    expect(
      resolveRoleBoundRuntimeProfile("EXAMINER", "PROFESSOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("EXAMINER", "TUTOR_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile(
        "EXAMINER",
        "LAB_INSTRUCTOR_COMMERCIAL_V1",
      ),
    ).toBeNull();
  });

  it("COUNSELLOR: never resolves a profile, regardless of ref -- no provider execution path exists", () => {
    expect(resolveRoleBoundRuntimeProfile("COUNSELLOR", null)).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("COUNSELLOR", "EXAMINER_COMMERCIAL_V1"),
    ).toBeNull();
    expect(
      resolveRoleBoundRuntimeProfile("COUNSELLOR", "anything-at-all"),
    ).toBeNull();
  });

  it("consults an injected registry lookup only after role/null validation has already accepted the ref", () => {
    const calls: string[] = [];
    const profile: RuntimeProfile = {
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC",
      budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
    };
    const injected = (ref: string) => {
      calls.push(ref);
      return ref === "TUTOR_COMMERCIAL_V1" ? profile : null;
    };
    expect(
      resolveRoleBoundRuntimeProfile(
        "TUTOR",
        "PROFESSOR_COMMERCIAL_V1",
        injected,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(resolveRoleBoundRuntimeProfile("TUTOR", null, injected)).toBe(
      profile,
    );
    expect(calls).toEqual(["TUTOR_COMMERCIAL_V1"]);
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
