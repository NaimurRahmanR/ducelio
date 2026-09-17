import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  getDeliveryAgentAccess: vi.fn(),
  withValidatedProfessorContent: vi.fn(),
  attestProviderExecutionCommand: vi.fn(),
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
vi.mock("@/server/academic-provider-execution/authority", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/academic-provider-execution/authority")
  >("@/server/academic-provider-execution/authority");
  return {
    ProviderExecutionDenied: actual.ProviderExecutionDenied,
    attestProviderExecutionCommand: mocks.attestProviderExecutionCommand,
  };
});

import { executeRoleCapabilityWithTestOverrides } from "@/server/academic-runtime";
import { DeterministicFakeProviderAdapter } from "@/server/academic-runtime/test-fake-provider";
import { DEFAULT_RUNTIME_BUDGET_POLICY } from "@/domain/academic-runtime";
import type { RuntimeProfile } from "@/domain/academic-runtime-profile";

const enrolmentId = "00000000-0000-4000-8000-000000000001";
const lessonId = "00000000-0000-4000-8000-000000000002";
const fakeRelease = {
  release_id: "release-1",
  student_id: "student-1",
  invocation_id: "invocation-1",
};

// PR16A: Professor's role-bound resolution (src/server/academic-runtime/
// profile-registry.ts's resolveRoleBoundRuntimeProfile) requires the exact
// code-owned ref before this test-injected resolveProfile callback is ever
// reached at all.
const testProfile: RuntimeProfile = {
  ref: "PROFESSOR_COMMERCIAL_V1",
  adapterKind: "TEST_DETERMINISTIC",
  budgetPolicy: DEFAULT_RUNTIME_BUDGET_POLICY,
};
const resolveTestProfile = (ref: string | null) =>
  ref === "PROFESSOR_COMMERCIAL_V1" ? testProfile : null;

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
function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    modelProfileRef: "PROFESSOR_COMMERCIAL_V1",
    capabilities: ["get_lesson_context"],
    escalationPolicy: "NONE",
    ...overrides,
  };
}
function recordingAdapter() {
  return new DeterministicFakeProviderAdapter([
    {
      kind: "success",
      response: {
        outputText: "Professor response",
        usage: { inputTokens: 10, outputTokens: 10, estimatedCostMicrousd: 10 },
      },
    },
  ]);
}
function mockGateway(options: {
  callsConsume: boolean;
  data?: unknown;
  resultOk: boolean;
  errorCode?: string;
}) {
  return vi.fn(
    async (_request: unknown, consume?: (ctx: unknown) => Promise<void>) => {
      if (options.callsConsume && consume) {
        await consume({ release: fakeRelease, data: options.data });
      }
      return {
        result: options.resultOk
          ? { ok: true, data: options.data, provenance: {} }
          : {
              ok: false,
              error: {
                code: options.errorCode ?? "POLICY_BLOCKED",
                message: "denied",
              },
              provenance: {},
            },
        releaseFinalizationFailed: false,
      };
    },
  );
}
function governedAttest() {
  return vi.fn(
    async (
      _id: string,
      _release: unknown,
      command: { operation: string; state?: string },
    ) => ({
      state:
        command.operation === "AUTHORIZE"
          ? "AUTHORIZED"
          : command.operation === "START"
            ? "RUNNING"
            : command.state,
    }),
  );
}

describe("Professor classroom interaction reaching the governed runtime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      displayName: "Student",
      roles: ["STUDENT"],
    });
    mocks.getDeliveryAgentAccess.mockResolvedValue(availableAccess());
    mocks.attestProviderExecutionCommand.mockImplementation(governedAttest());
  });

  it("BEGIN_LESSON reaches the provider context, carrying only the fixed interaction kind", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId, title: "Access Control" },
        resultOk: true,
      }),
    );
    const adapter = recordingAdapter();

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
        interaction: { kind: "BEGIN_LESSON" },
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(result.outcome).toBe("SUCCEEDED");
    expect(adapter.lastRequest?.context).toMatchObject({
      capability: "get_lesson_context",
      data: { enrolmentId, lessonId, title: "Access Control" },
      interaction: { kind: "BEGIN_LESSON" },
    });
  });

  it("a bounded LEARNER_QUESTION reaches the provider context exactly as submitted, trimmed and bounded", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const adapter = recordingAdapter();

    await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
        interaction: {
          kind: "LEARNER_QUESTION",
          learnerMessage: "What is access control?",
        },
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(adapter.lastRequest?.context).toMatchObject({
      interaction: {
        kind: "LEARNER_QUESTION",
        learnerMessage: "What is access control?",
      },
    });
  });

  it("requests without any interaction behave exactly as before (existing non-classroom callers unaffected)", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const adapter = recordingAdapter();

    await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(adapter.lastRequest?.context).not.toHaveProperty("interaction");
  });

  it.each([
    { kind: "LEARNER_QUESTION" }, // missing required learnerMessage
    { kind: "LEARNER_QUESTION", learnerMessage: "" }, // empty after trim
    { kind: "LEARNER_QUESTION", learnerMessage: "x".repeat(2001) }, // overlong
    { kind: "LEARNER_QUESTION", learnerMessage: "ok", extra: "field" }, // strict object
    { kind: "BEGIN_LESSON", extra: "field" }, // strict object
    { kind: "SOMETHING_ELSE" }, // unknown kind
  ])(
    "rejects a malformed interaction outright, never a partial pass-through: %j",
    async (interaction) => {
      await expect(
        executeRoleCapabilityWithTestOverrides(
          {
            enrolmentId,
            role: "PROFESSOR",
            capability: "get_lesson_context",
            lessonId,
            interaction,
          },
          {
            resolveProfile: resolveTestProfile,
            resolveAdapter: () => recordingAdapter(),
          },
        ),
      ).rejects.toThrow();
      expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
    },
  );

  it("no arbitrary caller field beyond the reviewed request shape reaches executeRoleCapability's own validation", async () => {
    await expect(
      executeRoleCapabilityWithTestOverrides(
        {
          enrolmentId,
          role: "PROFESSOR",
          capability: "get_lesson_context",
          lessonId,
          interaction: { kind: "BEGIN_LESSON" },
          provider: "attacker-controlled",
          budget: { maxProviderCalls: 999 },
        },
        {
          resolveProfile: resolveTestProfile,
          resolveAdapter: () => recordingAdapter(),
        },
      ),
    ).rejects.toThrow();
  });

  it("controlled assessment (or any other existing Academy OS denial) blocks the interaction before any provider call", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: false,
        resultOk: false,
        errorCode: "ACTIVITY_BLOCKED",
      }),
    );
    const adapter = recordingAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
        interaction: {
          kind: "LEARNER_QUESTION",
          learnerMessage: "Can you help during my assessment?",
        },
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "ABSTAINED" });
  });

  it("V2 governance (migration 025 AUTHORIZE/START/FINALIZE) still runs for a classroom interaction", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId, lessonId },
        resultOk: true,
      }),
    );
    const operations: string[] = [];
    mocks.attestProviderExecutionCommand.mockImplementation(
      async (
        _id: string,
        _release: unknown,
        command: { operation: string; state?: string },
      ) => {
        operations.push(command.operation);
        return {
          state:
            command.operation === "AUTHORIZE"
              ? "AUTHORIZED"
              : command.operation === "START"
                ? "RUNNING"
                : command.state,
        };
      },
    );

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
        interaction: { kind: "BEGIN_LESSON" },
      },
      {
        resolveProfile: resolveTestProfile,
        resolveAdapter: () => recordingAdapter(),
      },
    );

    expect(operations).toEqual(["AUTHORIZE", "START", "FINALIZE"]);
    expect(result.outcome).toBe("SUCCEEDED");
  });

  it.each(["TUTOR", "LAB_INSTRUCTOR", "EXAMINER", "COUNSELLOR"] as const)(
    "%s still has no execution path even when a classroom interaction is supplied",
    async (role) => {
      mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
      const adapter = recordingAdapter();
      const generateSpy = vi.spyOn(adapter, "generate");

      const result = await executeRoleCapabilityWithTestOverrides(
        {
          enrolmentId,
          role,
          capability: "get_lesson_context",
          lessonId,
          interaction: { kind: "BEGIN_LESSON" },
        },
        { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
      );

      expect(result).toMatchObject({
        outcome: "ABSTAINED",
        reason: "NO_EXECUTION_PATH",
      });
      expect(generateSpy).not.toHaveBeenCalled();
      expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
      expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
    },
  );
});

// Correction pass (independent review, Blocker 2): a classroom interaction
// is semantically valid ONLY for role PROFESSOR + capability EXACTLY
// get_lesson_context + a present lessonId + an absent objectiveId. Every
// other combination must fail closed BEFORE withValidatedProfessorContent,
// the provider adapter, or migration 025's AUTHORIZE/START/FINALIZE
// governance are ever reached -- proven here by zero calls to any of them,
// not merely a bounded ABSTAINED outcome.
describe("Professor classroom interaction bound to get_lesson_context only", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireStudentPrincipal.mockResolvedValue({
      id: "student-1",
      displayName: "Student",
      roles: ["STUDENT"],
    });
    mocks.getDeliveryAgentAccess.mockResolvedValue(availableAccess());
    mocks.attestProviderExecutionCommand.mockImplementation(governedAttest());
  });

  it.each([
    "get_actor_context",
    "get_activity_permissions",
    "get_current_learner_context",
    "get_lesson_objectives",
    "get_current_class_session",
    "get_learning_resources",
    "get_permitted_learning_history",
    "get_current_mastery_state",
  ] as const)(
    "a classroom interaction attached to %s (every non-get_lesson_context Professor capability) fails closed before any provider call or execution attestation",
    async (capability) => {
      mocks.getAgentConfigForEnrolment.mockResolvedValue(
        enabledConfig({ capabilities: [capability] }),
      );
      const adapter = recordingAdapter();
      const generateSpy = vi.spyOn(adapter, "generate");

      const result = await executeRoleCapabilityWithTestOverrides(
        {
          enrolmentId,
          role: "PROFESSOR",
          capability,
          lessonId,
          interaction: { kind: "BEGIN_LESSON" },
        },
        { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
      );

      expect(result).toMatchObject({
        outcome: "ABSTAINED",
        reason: "NO_EXECUTION_PATH",
      });
      expect(generateSpy).not.toHaveBeenCalled();
      expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
      expect(mocks.attestProviderExecutionCommand).not.toHaveBeenCalled();
    },
  );

  it("get_lesson_context with an interaction but objectiveId ALSO supplied (an alternate selector) fails closed", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    const adapter = recordingAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        lessonId,
        objectiveId: "00000000-0000-4000-8000-000000000099",
        interaction: { kind: "BEGIN_LESSON" },
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "NO_EXECUTION_PATH",
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
  });

  it("get_lesson_context with an interaction but no lessonId fails closed", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(enabledConfig());
    const adapter = recordingAdapter();
    const generateSpy = vi.spyOn(adapter, "generate");

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_lesson_context",
        interaction: { kind: "BEGIN_LESSON" },
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(result).toMatchObject({
      outcome: "ABSTAINED",
      reason: "NO_EXECUTION_PATH",
    });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(mocks.withValidatedProfessorContent).not.toHaveBeenCalled();
  });

  it("requests WITHOUT any interaction remain fully unaffected for every other Professor capability (backward compatible)", async () => {
    mocks.getAgentConfigForEnrolment.mockResolvedValue(
      enabledConfig({ capabilities: ["get_current_class_session"] }),
    );
    mocks.withValidatedProfessorContent.mockImplementation(
      mockGateway({
        callsConsume: true,
        data: { enrolmentId },
        resultOk: true,
      }),
    );
    const adapter = recordingAdapter();

    const result = await executeRoleCapabilityWithTestOverrides(
      {
        enrolmentId,
        role: "PROFESSOR",
        capability: "get_current_class_session",
      },
      { resolveProfile: resolveTestProfile, resolveAdapter: () => adapter },
    );

    expect(result.outcome).toBe("SUCCEEDED");
  });
});
