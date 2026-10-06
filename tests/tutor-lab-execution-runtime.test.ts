import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  requireStudentPrincipal: vi.fn(),
  client: vi.fn(),
  beginTutorLabContentRelease: vi.fn(),
  closeTutorLabContentRelease: vi.fn(),
  attestTutorLabExecutionCommand: vi.fn(),
  buildTutorContext: vi.fn(),
  buildLabContext: vi.fn(),
  getAgentConfigForEnrolment: vi.fn(),
  resolveAdapterForProfile: vi.fn(),
  runGovernedProviderExecution: vi.fn(),
  getProfessorTeachingRecordForRelease: vi.fn(),
  recordTutorClassNote: vi.fn(),
}));
// AC-4: the attested Tutor class-note write; its own authority is tested in
// tutor-class-notes-db.test.ts and tutor-class-notes.test.ts.
vi.mock("@/server/tutor-class-notes", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/tutor-class-notes")
  >("@/server/tutor-class-notes");
  return {
    TutorClassNoteRefused: actual.TutorClassNoteRefused,
    recordTutorClassNote: mocks.recordTutorClassNote,
  };
});
// AC-3: the release-scoped Professor academic handoff read; its own
// authority is tested in professor-academic-handoff-db.test.ts.
vi.mock("@/server/professor-academic-handoff", () => ({
  getProfessorTeachingRecordForRelease:
    mocks.getProfessorTeachingRecordForRelease,
}));
// AC-2: the learner-scoped Level-3 behaviour read resolves to the
// code-owned default here; its own authority is tested in
// agent-behaviour-db.test.ts.
vi.mock("@/server/agent-behaviour-config", async () => {
  const behaviour = await import("@/domain/agent-behaviour");
  return {
    getAgentBehaviourForEnrolment: vi.fn(
      async (
        _enrolmentId: string,
        role: "PROFESSOR" | "TUTOR" | "LAB_INSTRUCTOR",
      ) => behaviour.defaultEffectiveBehaviour(role),
    ),
  };
});
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
// PR16A: role-bound profile resolution (resolveRoleBoundRuntimeProfile) now
// lives entirely in this module, consulting the real, shared domain
// ROLE_RUNTIME_PROFILE_POLICY -- so it (and the real resolveRuntimeProfile
// registry lookup it defaults to) are kept REAL here via importActual,
// exercising the actual production role/profile policy end-to-end. Only
// resolveAdapterForProfile is mocked, since the real one requires live
// provider environment configuration this test never sets up.
vi.mock("@/server/academic-runtime/profile-registry", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/academic-runtime/profile-registry")
  >("@/server/academic-runtime/profile-registry");
  return {
    ...actual,
    resolveAdapterForProfile: mocks.resolveAdapterForProfile,
  };
});
vi.mock("@/server/academic-runtime/runtime", () => ({
  runGovernedProviderExecution: mocks.runGovernedProviderExecution,
}));

import { executeTutorLabSupport } from "@/server/tutor-lab-execution";
import { TutorLabContentReleaseDenied } from "@/server/tutor-lab-execution/release";
import { TutorLabExecutionDenied } from "@/domain/tutor-lab-execution";
import * as behaviourConfig from "@/server/agent-behaviour-config";
import { defaultEffectiveBehaviour } from "@/domain/agent-behaviour";
import { PROFESSOR_HANDOFF_SUMMARY } from "@/domain/professor-academic-handoff";
import { providerInstructions } from "@/server/academic-runtime/provider";

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
  mocks.getProfessorTeachingRecordForRelease.mockResolvedValue(null);
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
  // PR16A: modelProfileRef "TUTOR_COMMERCIAL_V1" (the default agent config
  // above) now resolves through the REAL resolveRoleBoundRuntimeProfile /
  // resolveRuntimeProfile / production registry (see the importActual mock
  // above) -- no fixture profile is injected here any more.
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
    await executeTutorLabSupport(request());
    expect(mocks.buildLabContext).toHaveBeenCalledOnce();
    expect(mocks.buildTutorContext).not.toHaveBeenCalled();
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.role).toBe("LAB_INSTRUCTOR");
    expect(requestArg.context.practical).toBeDefined();
  });

  // AC-2 governed behaviour.
  it("TUTOR receives its role behaviour and is told no governed Professor teaching record exists", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    await executeTutorLabSupport(request("Explain it again"));
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.behaviour).toEqual(defaultEffectiveBehaviour("TUTOR"));
    expect(providerInstructions(requestArg)).toContain(
      "You are executing as the Ducelio TUTOR",
    );
    expect(requestArg.context).toMatchObject({
      role: "TUTOR",
      behaviourVersion: "TUTOR_BEHAVIOUR_V2",
      professorTeachingRecord: {
        available: false,
        reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
      },
    });
    expect(requestArg.context).not.toHaveProperty("sessionTiming");
  });

  it("LAB_INSTRUCTOR is told no session clock exists and is instructed never to fabricate execution", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    await executeTutorLabSupport(request("My command failed"));
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.context).toMatchObject({
      role: "LAB_INSTRUCTOR",
      behaviourVersion: "LAB_INSTRUCTOR_BEHAVIOUR_V2",
      sessionTiming: { available: false, remainingMinutes: null },
      professorTeachingRecord: {
        available: false,
        reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
      },
    });
    const instructions = providerInstructions(requestArg);
    expect(instructions).toContain(
      "You are executing as the Ducelio LAB_INSTRUCTOR",
    );
    expect(instructions).toMatch(
      /Never claim that a command, code or task ran/,
    );
  });

  it("AC-3: a V2 Tutor receives the governed Professor record for its own release, bounded and non-authoritative", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.getProfessorTeachingRecordForRelease.mockResolvedValue({
      policy: "PROFESSOR_ACADEMIC_HANDOFF_V1",
      sourceRole: "PROFESSOR",
      destinationRole: "TUTOR",
      reasonCode: "OBJECTIVE_REINFORCEMENT",
      scope: "OBJECTIVE",
      summary: PROFESSOR_HANDOFF_SUMMARY.OBJECTIVE_REINFORCEMENT,
      recordedAt: "2026-10-06T09:30:00+00:00",
    });
    await executeTutorLabSupport(request("Help with this objective"));
    expect(mocks.getProfessorTeachingRecordForRelease).toHaveBeenCalledWith(
      tutorRelease().releaseId,
    );
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.context).toMatchObject({
      professorTeachingRecord: {
        available: true,
        authority: "NON_AUTHORITATIVE_TEACHING_CONTINUITY",
        sourceRole: "PROFESSOR",
        reasonCode: "OBJECTIVE_REINFORCEMENT",
        scope: "OBJECTIVE",
      },
    });
    const instructions = providerInstructions(requestArg);
    expect(instructions).toContain("TUTOR_BEHAVIOUR_V2");
    expect(instructions).toMatch(/not a transcript, not mastery, not evidence/);
  });

  it("AC-3: a Tutor pinned to V1 is never given a Professor record, even if one exists", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    vi.mocked(
      behaviourConfig.getAgentBehaviourForEnrolment,
    ).mockResolvedValueOnce({
      ...defaultEffectiveBehaviour("TUTOR"),
      behaviourVersion: "TUTOR_BEHAVIOUR_V1",
    });
    await executeTutorLabSupport(request());
    expect(mocks.getProfessorTeachingRecordForRelease).not.toHaveBeenCalled();
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.context).toMatchObject({
      behaviourVersion: "TUTOR_BEHAVIOUR_V1",
      professorTeachingRecord: {
        available: false,
        reason: "NO_GOVERNED_PROFESSOR_TEACHING_RECORD",
      },
    });
    expect(providerInstructions(requestArg)).toContain(
      "No governed record of what the Professor taught is available to you",
    );
  });

  it("AC-3: a refused Professor record read fails closed with no provider call", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.getProfessorTeachingRecordForRelease.mockRejectedValue(
      new Error("ACTIVITY_BLOCKED"),
    );
    const result = await executeTutorLabSupport(request());
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "UNAVAILABLE" });
  });

  it("fails closed with no provider call when the programme behaviour cannot be resolved", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    vi.mocked(
      behaviourConfig.getAgentBehaviourForEnrolment,
    ).mockRejectedValueOnce(new Error("unavailable"));
    const result = await executeTutorLabSupport(request());
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "UNAVAILABLE" });
  });

  it("fails closed with no provider call when the pinned role behaviour version has no reviewed text", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    vi.mocked(
      behaviourConfig.getAgentBehaviourForEnrolment,
    ).mockResolvedValueOnce({
      ...defaultEffectiveBehaviour("TUTOR"),
      behaviourVersion: "PROFESSOR_BEHAVIOUR_V1",
    });
    const result = await executeTutorLabSupport(request());
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "UNAVAILABLE" });
  });

  it("passes the frozen binding's pinned version and values to the provider", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    const frozen = {
      ...defaultEffectiveBehaviour("TUTOR"),
      config: {
        ...defaultEffectiveBehaviour("TUTOR").config,
        challengeLevel: "FOUNDATION" as const,
      },
    };
    vi.mocked(
      behaviourConfig.getAgentBehaviourForEnrolment,
    ).mockResolvedValueOnce(frozen);
    await executeTutorLabSupport(request());
    const [, requestArg] = mocks.runGovernedProviderExecution.mock.calls[0];
    expect(requestArg.behaviour).toEqual(frozen);
    expect(requestArg.context).toMatchObject({
      behaviourVersion: "TUTOR_BEHAVIOUR_V2",
    });
    expect(providerInstructions(requestArg)).toContain(
      "Pitch explanations and questions at foundation level",
    );
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

// PR16A: role binding is now decided entirely by the REAL, shared
// resolveRoleBoundRuntimeProfile / domain ROLE_RUNTIME_PROFILE_POLICY (see
// the importActual mock above) -- not by any fixture registry this test
// file constructs. These cases exercise the actual production policy
// end-to-end: a config naming another role's (or Professor's, or an
// unknown) profile ref must fail closed with zero provider calls, never
// merely "exists in the shared registry".
describe("executeTutorLabSupport: role-owned profile binding (Blocker 3 regression)", () => {
  it("TUTOR + TUTOR_COMMERCIAL_V1 (explicit or defaulted via null) is eligible", async () => {
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

describe("executeTutorLabSupport: AC-4 Tutor class notes", () => {
  async function importRefused() {
    return (await import("@/server/tutor-class-notes")).TutorClassNoteRefused;
  }
  function finalizeExecutionId() {
    const finalize = mocks.attestTutorLabExecutionCommand.mock.calls.find(
      (call) => (call[3] as { operation: string }).operation === "FINALIZE",
    );
    return finalize?.[1] as string;
  }

  it("keeps a SUCCEEDED Tutor answer the learner asked to keep: exactly the confirmed output, under the execution id this server finalized, after FINALIZE", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.recordTutorClassNote.mockResolvedValue({
      revisionNumber: 2,
      duplicate: false,
    });
    const result = await executeTutorLabSupport({
      ...request(),
      saveAsClassNote: true,
    });
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here is some guidance.",
      role: "TUTOR",
      classNote: { state: "SAVED", revisionNumber: 2 },
    });
    expect(mocks.recordTutorClassNote).toHaveBeenCalledExactlyOnceWith({
      executionId: finalizeExecutionId(),
      body: "Here is some guidance.",
    });
    const finalizeOrder = Math.max(
      ...mocks.attestTutorLabExecutionCommand.mock.invocationCallOrder,
    );
    const closeOrder =
      mocks.closeTutorLabContentRelease.mock.invocationCallOrder[0];
    expect(
      mocks.recordTutorClassNote.mock.invocationCallOrder[0],
    ).toBeGreaterThan(finalizeOrder);
    expect(finalizeOrder).toBeGreaterThan(closeOrder);
  });

  it("never records a note unless the learner asked, and adds no classNote field", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    const result = await executeTutorLabSupport(request());
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here is some guidance.",
      role: "TUTOR",
    });
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });

  it("is Tutor-only: a Lab Instructor answer is never kept, even when asked", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(labRelease());
    mocks.getAgentConfigForEnrolment.mockResolvedValue({
      enabled: true,
      modelProfileRef: "LAB_INSTRUCTOR_COMMERCIAL_V1",
      capabilities: ["get_lesson_context", "get_lesson_objectives"],
      escalationPolicy: "NONE",
    });
    const result = await executeTutorLabSupport({
      ...request(),
      saveAsClassNote: true,
    });
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here is some guidance.",
      role: "LAB_INSTRUCTOR",
    });
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an abstained execution",
      { outcome: "ABSTAINED", reason: "POLICY_BLOCKED" },
    ],
    ["a failed execution", { outcome: "FAILED", reason: "PROVIDER_ERROR" }],
    [
      "an escalated execution",
      { outcome: "ESCALATED", reviewPath: "ACADEMIC_REVIEW" },
    ],
    [
      "a budget-blocked execution",
      { outcome: "BUDGET_BLOCKED", stage: "POST_CALL" },
    ],
    ["a timed-out execution", { outcome: "TIMEOUT" }],
  ])("records no note for %s", async (_label, outcome) => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.runGovernedProviderExecution.mockResolvedValue({
      ...outcome,
      usage: successfulResult().usage,
    });
    const result = await executeTutorLabSupport({
      ...request(),
      saveAsClassNote: true,
    });
    expect(result.status).not.toBe("SUCCEEDED");
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });

  it("records no note when FINALIZE is not confirmed, or when the release did not close", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.attestTutorLabExecutionCommand.mockImplementation(
      async (
        _r: string,
        _i: string,
        _rel: unknown,
        command: { operation: string },
      ) => {
        if (command.operation === "FINALIZE") throw new Error("not confirmed");
        return {
          state: command.operation === "AUTHORIZE" ? "AUTHORIZED" : "RUNNING",
        };
      },
    );
    expect(
      await executeTutorLabSupport({ ...request(), saveAsClassNote: true }),
    ).toEqual({ status: "RETRY_LATER" });
    mocks.attestTutorLabExecutionCommand.mockImplementation(
      async (
        _r: string,
        _i: string,
        _rel: unknown,
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
    mocks.closeTutorLabContentRelease.mockRejectedValue(new Error("aborted"));
    expect(
      await executeTutorLabSupport({ ...request(), saveAsClassNote: true }),
    ).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });

  it("an answer longer than the note bound is not kept, the learner is told, and nothing is sent", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    const long = "x".repeat(8001);
    mocks.runGovernedProviderExecution.mockResolvedValue({
      ...successfulResult(),
      response: { ...successfulResult().response, outputText: long },
    });
    const result = await executeTutorLabSupport({
      ...request(),
      saveAsClassNote: true,
    });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      text: long,
      classNote: { state: "NOT_SAVED", reason: "TOO_LONG" },
    });
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });

  it.each([
    ["REVISION_LIMIT_REACHED", { state: "NOT_SAVED", reason: "LIMIT_REACHED" }],
    ["ACTIVITY_BLOCKED", { state: "NOT_SAVED", reason: "ACTIVITY_BLOCKED" }],
    ["PROVENANCE_MISMATCH", { state: "NOT_SAVED", reason: "UNAVAILABLE" }],
    ["SOURCE_NOT_ELIGIBLE", { state: "NOT_SAVED", reason: "UNAVAILABLE" }],
    ["SERVICE_UNAVAILABLE", { state: "NOT_SAVED", reason: "UNAVAILABLE" }],
  ] as const)(
    "a %s refusal never changes the confirmed answer and maps to a safe note outcome",
    async (code, outcome) => {
      const TutorClassNoteRefused = await importRefused();
      mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
      mocks.recordTutorClassNote.mockRejectedValue(
        new TutorClassNoteRefused(code),
      );
      const result = await executeTutorLabSupport({
        ...request(),
        saveAsClassNote: true,
      });
      expect(result).toEqual({
        status: "SUCCEEDED",
        text: "Here is some guidance.",
        role: "TUTOR",
        classNote: outcome,
      });
    },
  );

  it("an unexpected recorder exception is a safe UNAVAILABLE note outcome, never a raw throw", async () => {
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.recordTutorClassNote.mockRejectedValue(
      new Error("postgres://controller:s3cr3t@db.internal"),
    );
    const result = await executeTutorLabSupport({
      ...request(),
      saveAsClassNote: true,
    });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      classNote: { state: "NOT_SAVED", reason: "UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t|postgres/);
  });
});

describe("executeTutorLabSupport: AC-4 note choice in the reservation fingerprint", () => {
  async function reservedHash(saveAsClassNote?: boolean) {
    const rpc = reservationClient(false);
    mocks.client.mockImplementation(async () => ({ rpc }));
    mocks.beginTutorLabContentRelease.mockResolvedValue(tutorRelease());
    mocks.recordTutorClassNote.mockResolvedValue({
      revisionNumber: 1,
      duplicate: false,
    });
    await executeTutorLabSupport(
      saveAsClassNote === undefined
        ? request("Explain least privilege")
        : { ...request("Explain least privilege"), saveAsClassNote },
    );
    const call = (
      rpc.mock.calls as unknown as [string, { p_request_hash: string }][]
    ).find(([name]) => name === "reserve_tutor_lab_interaction");
    return call![1].p_request_hash;
  }
  const historical = createHash("sha256")
    .update(`${handoffId}\nExplain least privilege`, "utf8")
    .digest("hex");

  it("a no-note (omitted) request keeps the exact pre-AC-4 request hash", async () => {
    expect(await reservedHash()).toBe(historical);
  });
  it("an explicit false is the same no-note request as omitted", async () => {
    expect(await reservedHash(false)).toBe(historical);
  });
  it("saveAsClassNote=true is a different, domain-separated request hash", async () => {
    const withNote = await reservedHash(true);
    expect(withNote).not.toBe(historical);
    expect(withNote).toBe(
      createHash("sha256")
        .update(
          `AC4_SAVE_AS_CLASS_NOTE\n${handoffId}\nExplain least privilege`,
          "utf8",
        )
        .digest("hex"),
    );
  });
  it("a reservation conflict (same key, different note choice) fails closed with no release, provider call or note", async () => {
    mocks.client.mockImplementation(async () => ({
      rpc: reservationClient(false, false, "DUPLICATE_KEY_CONFLICT"),
    }));
    expect(
      await executeTutorLabSupport({ ...request(), saveAsClassNote: true }),
    ).toEqual({ status: "UNAVAILABLE" });
    expect(mocks.beginTutorLabContentRelease).not.toHaveBeenCalled();
    expect(mocks.runGovernedProviderExecution).not.toHaveBeenCalled();
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });
  it("a true duplicate stays a DUPLICATE with no second note", async () => {
    mocks.client.mockImplementation(async () => ({
      rpc: reservationClient(true),
    }));
    expect(
      await executeTutorLabSupport({ ...request(), saveAsClassNote: true }),
    ).toEqual({ status: "DUPLICATE" });
    expect(mocks.recordTutorClassNote).not.toHaveBeenCalled();
  });
});
