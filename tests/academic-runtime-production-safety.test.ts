import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file proves finding #3 technically, not by comment/convention:
// production server code cannot reach a test-injected adapter or profile
// resolver, and the deterministic fake provider cannot be constructed under
// NODE_ENV=production.
const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  getDeliveryAgentAccess: vi.fn(),
  withValidatedProfessorContent: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/academic-agent-config", () => ({
  getAgentConfigForEnrolment: mocks.getAgentConfigForEnrolment,
}));
vi.mock("@/server/delivery", () => ({
  getDeliveryAgentAccess: mocks.getDeliveryAgentAccess,
}));
vi.mock("@/server/academic-capabilities", () => ({
  withValidatedProfessorContent: mocks.withValidatedProfessorContent,
}));

import {
  executeRoleCapability,
  executeRoleCapabilityWithTestOverrides,
} from "@/server/academic-runtime";
import { DeterministicFakeProviderAdapter } from "@/server/academic-runtime/test-fake-provider";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const mutableEnv = process.env as Record<string, string | undefined>;
function setNodeEnv(value: string | undefined) {
  if (value === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = value;
}

const enrolmentId = "00000000-0000-4000-8000-000000000001";
const lessonId = "00000000-0000-4000-8000-000000000002";

function availableAccess() {
  return {
    enrolmentId,
    PROFESSOR: "AVAILABLE" as const,
    TUTOR: "AVAILABLE" as const,
    LAB_INSTRUCTOR: "AVAILABLE" as const,
    EXAMINER: "ASSESSMENT_CONTROLLED" as const,
    COUNSELLOR: "AVAILABLE" as const,
  };
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
});

describe("deterministic fake provider cannot exist in production", () => {
  it("constructs freely outside production", () => {
    setNodeEnv("test");
    expect(() => new DeterministicFakeProviderAdapter([])).not.toThrow();
  });

  it("6. refuses to construct under NODE_ENV=production", () => {
    setNodeEnv("production");
    expect(() => new DeterministicFakeProviderAdapter([])).toThrow(
      "must never run in production",
    );
  });
});

describe("executeRoleCapabilityWithTestOverrides is fail-closed in production", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      displayName: "Student",
      roles: ["STUDENT"],
    });
    mocks.getDeliveryAgentAccess.mockResolvedValue(availableAccess());
  });

  it("1. deterministic dependency injection works under normal test semantics", async () => {
    setNodeEnv("test");
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      // PR16A: Professor's role-bound resolution rejects any ref other than
      // the exact code-owned "PROFESSOR_COMMERCIAL_V1" before resolveProfile
      // is ever reached -- see src/server/academic-runtime/profile-
      // registry.ts's resolveRoleBoundRuntimeProfile.
      modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context"],
      escalationPolicy: "NONE",
    });
    mocks.withValidatedProfessorContent.mockResolvedValue({
      result: { ok: true, data: { lessonId }, provenance: {} },
      releaseFinalizationFailed: false,
    });
    const resolveProfile = vi.fn(() => ({
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "TEST_DETERMINISTIC" as const,
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 16000,
        maxOutputTokens: 1000,
        totalDeadlineMs: 5000,
        maxEstimatedCostMicrousd: 50_000,
      },
    }));
    const resolveAdapter = vi.fn(() => null);
    await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
      },
      { resolveProfile, resolveAdapter },
    );
    expect(resolveProfile).toHaveBeenCalled();
  });

  it("2/3/4. rejects outright under NODE_ENV=production before any override can run", async () => {
    setNodeEnv("production");
    const resolveProfile = vi.fn();
    const resolveAdapter = vi.fn();
    await expect(
      executeRoleCapabilityWithTestOverrides(
        {
          enrolmentId,
          role: "PROFESSOR",
          capability: "get_lesson_context",
          lessonId,
        },
        { resolveProfile, resolveAdapter },
      ),
    ).rejects.toThrow("must never run in production");
    // Neither injected dependency was ever reached: the guard fires before
    // any of this function's own logic, including identity/delivery checks.
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(mocks.requireStudentPrincipal).not.toHaveBeenCalled();
    expect(mocks.getDeliveryAgentAccess).not.toHaveBeenCalled();
  });

  it("2/3/4. still rejects a supplied custom adapter/resolver in production even with otherwise-valid request shape", async () => {
    setNodeEnv("production");
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "test-profile",
      capabilities: ["get_lesson_context"],
      escalationPolicy: "NONE",
    });
    const customAdapter = { name: "malicious", generate: vi.fn() };
    await expect(
      executeRoleCapabilityWithTestOverrides(
        {
          enrolmentId,
          role: "PROFESSOR",
          capability: "get_lesson_context",
          lessonId,
        },
        {
          resolveProfile: () => ({
            ref: "test-profile",
            adapterKind: "TEST_DETERMINISTIC",
            budgetPolicy: {
              maxProviderCalls: 1,
              maxAttempts: 1,
              maxInputContextBytes: 16000,
              maxOutputTokens: 1000,
              totalDeadlineMs: 5000,
              maxEstimatedCostMicrousd: 50_000,
            },
          }),
          resolveAdapter: () => customAdapter,
        },
      ),
    ).rejects.toThrow("must never run in production");
    expect(customAdapter.generate).not.toHaveBeenCalled();
  });

  it("5. normal production execution (executeRoleCapability) resolves only through the code-owned registry, never an override", async () => {
    setNodeEnv("production");
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      // Not present in the production registry (which ships empty): this
      // proves executeRoleCapability consulted the REAL registry, not any
      // test fixture, because it has no parameter through which a test
      // registry could even be supplied.
      modelProfileRef: "test-profile",
      capabilities: ["get_lesson_context"],
      escalationPolicy: "NONE",
    });
    const result = await executeRoleCapability({
      enrolmentId,
      role: "PROFESSOR",
      capability: "get_lesson_context",
      lessonId,
    });
    expect(result.outcome).toBe("ABSTAINED");
    if (result.outcome === "ABSTAINED")
      expect(result.reason).toBe("UNKNOWN_MODEL_PROFILE");
    expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
  });

  it("executeRoleCapability has no override parameter at all (structural, not conventional, prevention)", () => {
    // executeRoleCapability's declared arity is exactly one parameter
    // (the request): there is no second "options"/"overrides" argument a
    // caller could pass an adapter/resolver through, in production or
    // otherwise.
    expect(executeRoleCapability.length).toBe(1);
  });
});
