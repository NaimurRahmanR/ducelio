import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  client: vi.fn(),
  beginTutorLabContentRelease: vi.fn(),
  closeTutorLabContentRelease: vi.fn(),
  attestTutorLabExecutionCommand: vi.fn(),
  buildTutorContext: vi.fn(),
  buildLabContext: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  resolveRuntimeProfile: vi.fn(),
  resolveAdapterForProfile: vi.fn(),
  runGovernedProviderExecution: vi.fn(),
}));
vi.mock("@/server/identity", () => ({
  requireStudentPrincipal: mocks.requireStudentPrincipal,
}));
vi.mock("@/server/supabase", () => ({ createSupabase: mocks.client }));
vi.mock("@/server/tutor-lab-execution/release", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/tutor-lab-execution/release")
  >("@/server/tutor-lab-execution/release");
  return {
    TutorLabContentReleaseDenied: actual.TutorLabContentReleaseDenied,
    beginTutorLabContentRelease: mocks.beginTutorLabContentRelease,
    closeTutorLabContentRelease: mocks.closeTutorLabContentRelease,
  };
});
vi.mock("@/server/tutor-lab-execution/authority", () => ({
  attestTutorLabExecutionCommand: mocks.attestTutorLabExecutionCommand,
}));
vi.mock("@/server/tutor-lab-execution/context", () => ({
  buildTutorContext: mocks.buildTutorContext,
  buildLabContext: mocks.buildLabContext,
}));
vi.mock("@/server/academic-agent-config", () => ({
  getAgentConfigForEnrolment: mocks.getAgentConfigForEnrolment,
}));
vi.mock("@/server/academic-runtime/profile-registry", () => ({
  resolveRuntimeProfile: mocks.resolveRuntimeProfile,
  resolveAdapterForProfile: mocks.resolveAdapterForProfile,
}));
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: mocks.runGovernedProviderExecution,
}));

import { executeTutorLabSupport } from "@/server/tutor-lab-execution";
import { TutorLabContentReleaseDenied } from "@/server/tutor-lab-execution/release";
import { TutorLabExecutionDenied } from "@/domain/tutor-lab-execution";

const handoffId = "40000000-0000-4000-8000-000000000009";
const idempotencyKey = "40000000-0000-4000-8000-000000000010";

function tutorRelease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    releaseId: "aaaaaaaa-0000-4000-8000-000000000001",
    studentId: "student-1",
    invocationId: "bbbbbbbb-0000-4000-8000-000000000001",
    role: "TUTOR" as const,
    reasonCode: "MISSED_LESSON_PRACTICE" as const,
    enrolmentId: "cccccccc-0000-4000-8000-000000000001",
    lessonId: "dddddddd-0000-4000-8000-000000000001",
    objectiveId: null,
    practicalId: null,
    ...overrides,
  };
}
function labRelease(overrides: Partial<Record<string, unknown>> = {}) {
  return tutorRelease({
    role: "LAB_INSTRUCTOR",
    reasonCode: "PRACTICAL_HELP",
    practicalId: "eeeeeeee-0000-4000-8000-000000000001",
    ...overrides,
  });
}
function successfulResult() {
  return {
    outcome: "SUCCEEDED" as const,
    usage: {
      providerCalls: 1,
      attempts: 1,
      inputTokens: 5,
      outputTokens: 5,
      estimatedCostMicrousd: 5,
      elapsedMs: 5,
    },
    response: {
      outputText: "Here is some guidance.",
      usage: { inputTokens: 5, outputTokens: 5, estimatedCostMicrousd: 5 },
    },
  };
}
function reservationClient(duplicate: boolean, ok = true, code?: string) {
  return vi.fn(async () => ({
    data: ok ? { ok: true, duplicate } : { ok: false, code },
    error: null,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireStudentPrincipal.mockResolvedValue({
    id: "student-1",
    displayName: "Student",
    roles: ["STUDENT"],
  });
  mocks.client.mockImplementation(async () => ({
    rpc: reservationClient(false),
  }));
  mocks.getAgentConfigForEnrolment.mockResolvedValue({
    enabled: true,
    modelProfileRef: "TUTOR_COMMERCIAL_V1",
    capabilities: ["get_lesson_context", "get_lesson_objectives"],
    escalationPolicy: "NONE",
  });
  mocks.resolveRuntimeProfile.mockReturnValue({
    ref: "TUTOR_COMMERCIAL_V1",
    adapterKind: "HTTP_JSON",
    budgetPolicy: {
      maxProviderCalls: 1,
      // Truth-sync (independent review): the shared runtime harness makes a
      // second attempt unreachable once maxProviderCalls=1 (it checks
      // providerCalls>=maxProviderCalls before every attempt), so the
      // production Tutor/Lab profiles truthfully declare maxAttempts=1 --
      // this default mock must match, never the stale maxAttempts=2.
      maxAttempts: 1,
      maxInputContextBytes: 12_000,
      maxOutputTokens: 700,
      totalDeadlineMs: 15_000,
      maxEstimatedCostMicrousd: 30_000,
    },
  });
  mocks.resolveAdapterForProfile.mockReturnValue({ generate: vi.fn() });
  mocks.attestTutorLabExecutionCommand.mockImplementation(
    async (
      _role: string,
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
  mocks.closeTutorLabContentRelease.mockResolvedValue(undefined);
  // Echoes release.reasonCode exactly like the real context builders do
  // (src/server/tutor-lab-execution/context.ts) -- proves the composition
  // boundary passes the release itself (carrying the authoritative reason)
  // through to context construction, never the role name.
  mocks.buildTutorContext.mockImplementation(
    async (release: { reasonCode: string }) => ({
      role: "TUTOR",
      reasonCode: release.reasonCode,
      lesson: { title: "Access Control", position: 1 },
      objectives: [],
      requestedObjective: null,
      resources: null,
    }),
  );
  mocks.buildLabContext.mockImplementation(
    async (release: { reasonCode: string }) => ({
      role: "LAB_INSTRUCTOR",
      reasonCode: release.reasonCode,
      lesson: { title: "Access Control", position: 1 },
      practical: { kind: "PRACTICAL_LAB", title: "Lab", instructions: "Do it" },
      objectives: [],
    }),
  );
  mocks.runGovernedProviderExecution.mockResolvedValue(successfulResult());
});

function request(message = "Please help") {
  return { handoffId, message, idempotencyKey };
}

describe("executeTutorLabSupport: idempotency", () => {
  it("a duplicate reservation short-circuits before opening any release", async () => {
    mocks.client.mockImplementation(async () => ({
      rpc: reservationClient(true),
    }));
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "DUPLICATE" });
    expect(mocks.beginTutorLabContentRelease).not.toHaveBeenCalled();
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
  it("a fresh reservation proceeds to open a release", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    await executeTutorLabSupport(request());
    expect(mocks.beginTutorLabContentRelease).toHaveBeenCalledOnce();
  });
  it("a conflicting reservation (DUPLICATE_KEY_CONFLICT) fails safely without opening a release", async () => {
    mocks.client.mockImplementation(async () => ({
      rpc: reservationClient(false, false, "DUPLICATE_KEY_CONFLICT"),
    }));
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.beginTutorLabContentRelease).not.toHaveBeenCalled();
  });
});

describe("executeTutorLabSupport: assessment firewall", () => {
  it("ACTIVITY_BLOCKED at release-open time returns a safe status with zero provider calls", async () => {
    mocks.beginTutorLabContentRelease.mockRejectedValue(
      new TutorLabContentReleaseDenied("ACTIVITY_BLOCKED"),
    );
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "ACTIVITY_BLOCKED" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    expect(mocks.attestTutorLabExecutionCommand).not.toHaveBeenCalled();
  });
  it("a forged/foreign handoff denial maps to a safe unavailable status, never leaking the raw code", async () => {
    mocks.beginTutorLabContentRelease.mockRejectedValue(
      new TutorLabContentReleaseDenied("NOT_FOUND_OR_FORBIDDEN"),
    );
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
  });
});

describe("executeTutorLabSupport: context construction per role", () => {
  it("TUTOR release builds Tutor context and passes it plus the learner message into the provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    await executeTutorLabSupport(request("What is access control?"));
    expect(mocks.buildTutorContext).toHaveBeenCalledOnce();
    expect(mocks.buildLabContext).not.toHaveBeenCalled();
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.role).toBe("TUTOR");
    expect(requestArg.context).toMatchObject({
      role: "TUTOR",
      learnerMessage: "What is access control?",
    });
  });
  it("LAB_INSTRUCTOR release builds Lab context, never Tutor context", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    mocks.resolveRuntimeProfile.mockReturnValue({
      ref: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
      },
    });
    await executeTutorLabSupport(request());
    expect(mocks.buildLabContext).toHaveBeenCalledOnce();
    expect(mocks.buildTutorContext).not.toHaveBeenCalled();
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.role).toBe("LAB_INSTRUCTOR");
    expect(requestArg.context.practical).toBeDefined();
  });
});

describe("executeTutorLabSupport: authoritative reason code reaches the provider (Blocker 2 regression)", () => {
  it.each([
    "MISSED_LESSON_PRACTICE",
    "OBJECTIVE_REINFORCEMENT",
    "PRACTICAL_PREREQUISITE",
  ] as const)(
    "TUTOR + %s: provider context carries the exact reason, never the role name",
    async (reasonCode) => {
      mocks.beginTutorLabContentRelease.mockResolvedValue(
        tutorRelease({ reasonCode }),
      );
      await executeTutorLabSupport(request());
      const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
      expect(requestArg.context.reasonCode).toBe(reasonCode);
      expect(requestArg.context.reasonCode).not.toBe("TUTOR");
    },
  );
  it("LAB_INSTRUCTOR + PRACTICAL_HELP: provider context carries the exact reason, never the role name", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    mocks.resolveRuntimeProfile.mockReturnValue({
      ref: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON",
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
      },
    });
    await executeTutorLabSupport(request());
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.context.reasonCode).toBe("PRACTICAL_HELP");
    expect(requestArg.context.reasonCode).not.toBe("LAB_INSTRUCTOR");
  });
  it("the reason code is read exclusively from the server-derived release -- executeTutorLabSupport's own request type has no reasonCode field for a browser to supply, and an extra one is never forwarded to the context builder", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(
      tutorRelease({ reasonCode: "OBJECTIVE_REINFORCEMENT" }),
    );
    await executeTutorLabSupport({
      ...request(),
      // @ts-expect-error -- deliberately simulating a forged extra field;
      // TutorLabSupportRequest has no reasonCode member at all.
      reasonCode: "PRACTICAL_HELP",
    });
    expect(mocks.buildTutorContext).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reasonCode: "OBJECTIVE_REINFORCEMENT" }),
    );
  });
});

describe("executeTutorLabSupport: role-owned profile binding (Blocker 3 regression)", () => {
  function professorProfile() {
    return {
      ref: "PROFESSOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON" as const,
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 2,
        maxInputContextBytes: 16_000,
        maxOutputTokens: 900,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 40_000,
      },
    };
  }
  function labProfile() {
    return {
      ref: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON" as const,
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
      },
    };
  }
  function tutorProfile() {
    return {
      ref: "TUTOR_COMMERCIAL_V1",
      adapterKind: "HTTP_JSON" as const,
      budgetPolicy: {
        maxProviderCalls: 1,
        maxAttempts: 1,
        maxInputContextBytes: 12_000,
        maxOutputTokens: 700,
        totalDeadlineMs: 15_000,
        maxEstimatedCostMicrousd: 30_000,
      },
    };
  }
  // resolveRuntimeProfile is mocked at module level as a plain lookup (as
  // the real shared registry would behave): it happily resolves ANY of the
  // three refs regardless of who asks. The code-owned role binding this
  // blocker adds must reject a mismatched ref BEFORE that lookup is ever
  // trusted, never relying on "exists in registry" as authorization.
  function registryLookup(): Record<string, ReturnType<typeof tutorProfile>> {
    return {
      PROFESSOR_COMMERCIAL_V1: professorProfile(),
      TUTOR_COMMERCIAL_V1: tutorProfile(),
      LAB_INSTRUCTOR_COMMERCIAL_V1: labProfile(),
    };
  }
  it("TUTOR + TUTOR_COMMERCIAL_V1 (explicit or defaulted via null) is eligible", async () => {
    const registry = registryLookup();
    mocks.resolveRuntimeProfile.mockImplementation(
      (ref: string) => registry[ref] ?? null,
    );
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "TUTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result.status).toBe("SUCCEEDED");
    expect(mocks.runGovernedProviderExecution).toHaveBeenCalledOnce();
  });
  it("LAB_INSTRUCTOR + LAB_INSTRUCTOR_COMMERCIAL_V1 is eligible", async () => {
    const registry = registryLookup();
    mocks.resolveRuntimeProfile.mockImplementation(
      (ref: string) => registry[ref] ?? null,
    );
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result.status).toBe("SUCCEEDED");
    expect(mocks.runGovernedProviderExecution).toHaveBeenCalledOnce();
  });
  it.each([
    ["TUTOR", tutorRelease, "PROFESSOR_COMMERCIAL_V1"],
    ["TUTOR", tutorRelease, "LAB_INSTRUCTOR_COMMERCIAL_V1"],
    ["LAB_INSTRUCTOR", labRelease, "TUTOR_COMMERCIAL_V1"],
    ["LAB_INSTRUCTOR", labRelease, "PROFESSOR_COMMERCIAL_V1"],
  ] as const)(
    "%s stored config naming %s fails closed with zero provider calls (cross-role/Professor profile rejection)",
    async (_role, releaseFactory, storedRef) => {
      const registry = registryLookup();
      mocks.resolveRuntimeProfile.mockImplementation(
        (ref: string) => registry[ref] ?? null,
      );
      mocks.beginTutorLabContentRelease.mockResolvedValue(releaseFactory());
      mocks.getAgentConfigForEnrolment.mockResolvedValue({
        enabled: true,
        modelProfileRef: storedRef,
        capabilities: ["get_lesson_context", "get_lesson_objectives"],
        escalationPolicy: "NONE",
      });
      const result = await executeTutorLabSupport(request());
      expect(result).toEqual({ status: "UNAVAILABLE" });
      expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
      expect(mocks.attestTutorLabExecutionCommand).not.toHaveBeenCalled();
    },
  );
  it("an unknown/unresolvable stored profile ref fails closed with zero provider calls", async () => {
    mocks.resolveRuntimeProfile.mockReturnValue(null);
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "SOME_UNKNOWN_PROFILE",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
});

describe("executeTutorLabSupport: role/config enforcement", () => {
  it("disabled agent configuration fails closed without a provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: false,
      modelProfileRef: null,
      capabilities: [],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
  it("a capability outside the role's own catalogue fails closed (context builder itself denies)", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.buildTutorContext.mockRejectedValue(
      new TutorLabExecutionDenied("POLICY_BLOCKED"),
    );
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    // The release is still closed (aborted), never left dangling.
    expect(mocks.closeTutorLabContentRelease).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
  });
  it("an unresolved model profile abstains before any provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.resolveRuntimeProfile.mockReturnValue(null);
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
});

// Correction pass (independent review, final blocker): buildTutorContext/
// buildLabContext check capabilities against the configuration THEY read,
// but executeTutorLabSupport then reads agent configuration a second,
// LATER time before ever calling AUTHORIZE. Without re-checking the exact
// same capabilities against that later read, an admin narrowing a
// capability between those two reads (while leaving the role enabled and
// its profile ref unchanged) would let a provider call proceed on content
// the CURRENT configuration no longer authorizes. These tests simulate
// exactly that narrowing by mocking the context builder to have already
// "succeeded" while the final getAgentConfigForEnrolment mock reflects the
// narrower, later configuration.
describe("executeTutorLabSupport: final capability revalidation before AUTHORIZE (independent review, final blocker)", () => {
  function builtTutorContext(
    overrides: Partial<{
      resources: { title: string; kind: string }[] | null;
    }> = {},
  ) {
    return {
      role: "TUTOR" as const,
      reasonCode: "MISSED_LESSON_PRACTICE" as const,
      lesson: { title: "Access Control", position: 1 },
      objectives: [],
      requestedObjective: null,
      resources: null,
      ...overrides,
    };
  }
  function builtLabContext() {
    return {
      role: "LAB_INSTRUCTOR" as const,
      reasonCode: "PRACTICAL_HELP" as const,
      lesson: { title: "Access Control", position: 1 },
      practical: {
        kind: "PRACTICAL_LAB" as const,
        title: "Lab",
        instructions: "Do it",
      },
      objectives: [],
    };
  }
  it("A: Tutor context already built, final config has narrowed away get_lesson_objectives -- zero AUTHORIZE, zero provider call, safe failure", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.buildTutorContext.mockResolvedValue(builtTutorContext());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "TUTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.attestTutorLabExecutionCommand).not.toHaveBeenCalled();
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
  it("B: Lab context already built successfully, final config has narrowed away a required capability -- zero attestation, zero provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.buildLabContext.mockResolvedValue(builtLabContext());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.attestTutorLabExecutionCommand).not.toHaveBeenCalled();
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
  it("C: Tutor context actually contains learning resources, final config has narrowed away only get_learning_resources -- zero provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.buildTutorContext.mockResolvedValue(
      builtTutorContext({
        resources: [{ title: "Reading", kind: "ARTICLE" }],
      }),
    );
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "TUTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.attestTutorLabExecutionCommand).not.toHaveBeenCalled();
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
  });
  it("D: Tutor context contains no resources at all, final config also lacks get_learning_resources -- the optional capability contributed no content, so execution remains eligible", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.buildTutorContext.mockResolvedValue(
      builtTutorContext({ resources: null }),
    );
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "TUTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport(request());
    expect(result.status).toBe("SUCCEEDED");
    expect(mocks.runGovernedProviderExecution).toHaveBeenCalledOnce();
  });
});

describe("executeTutorLabSupport: provider outcomes and the critical success rule", () => {
  it("SUCCEEDED escapes only after release close and FINALIZE both succeed", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here is some guidance.",
      role: "TUTOR",
    });
    const operations = mocks.attestTutorLabExecutionCommand.mock.calls.map(
      (call) => call[3].operation,
    );
    expect(operations).toEqual(["AUTHORIZE", "START", "FINALIZE"]);
  });
  it("a release-close failure discards a genuine provider success", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.closeTutorLabContentRelease.mockRejectedValue(
      new Error("close failed"),
    );
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "UNAVAILABLE" });
  });
  it("a FINALIZE mismatch/failure never reports SUCCEEDED", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.attestTutorLabExecutionCommand.mockImplementation(
      async (
        _role: string,
        _id: string,
        _release: unknown,
        command: { operation: string; state?: string },
      ) => {
        if (command.operation === "FINALIZE")
          throw new Error("finalize failed");
        return {
          state: command.operation === "AUTHORIZE" ? "AUTHORIZED" : "RUNNING",
        };
      },
    );
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "RETRY_LATER" });
  });
  it.each([
    [
      "TIMEOUT",
      {
        outcome: "TIMEOUT",
        usage: {
          providerCalls: 0,
          attempts: 1,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicrousd: 0,
          elapsedMs: 15000,
        },
      },
    ],
    [
      "FAILED",
      {
        outcome: "FAILED",
        reason: "PROVIDER_INVALID_RESPONSE",
        usage: {
          providerCalls: 1,
          attempts: 1,
          inputTokens: 1,
          outputTokens: 0,
          estimatedCostMicrousd: 1,
          elapsedMs: 1,
        },
      },
    ],
  ] as const)(
    "a provider %s never lets content escape, mapping to a safe RETRY_LATER",
    async (_label, runtimeResult) => {
      mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
      mocks.runGovernedProviderExecution.mockResolvedValue(runtimeResult);
      const result = await executeTutorLabSupport(request());
      expect(result).toEqual({ status: "RETRY_LATER" });
    },
  );
  it("ESCALATED maps to a safe academic-review status", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.runGovernedProviderExecution.mockResolvedValue({
      outcome: "ESCALATED",
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
      reviewPath: "ACADEMIC_REVIEW",
    });
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({ status: "ESCALATED" });
  });
});

describe("executeTutorLabSupport: unexpected exception safety", () => {
  it("an unexpected exception from attestation becomes a safe RETRY_LATER, never a raw throw", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.attestTutorLabExecutionCommand.mockRejectedValue(
      new Error("controller signature verification failed: key=ctrl_live_xyz"),
    );
    const result = await executeTutorLabSupport(request());
    expect(result.status).toBe("UNAVAILABLE");
    expect(JSON.stringify(result)).not.toMatch(/ctrl_live|signature/i);
  });
});
