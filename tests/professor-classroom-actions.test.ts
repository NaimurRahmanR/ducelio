import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openProfessorClassroom: vi.fn(),
  recordProfessorClassroomInteraction: vi.fn(),
  executeRoleCapability: vi.fn(),
}));
vi.mock("@/server/professor-classroom", () => ({
  openProfessorClassroom: mocks.openProfessorClassroom,
  recordProfessorClassroomInteraction:
    mocks.recordProfessorClassroomInteraction,
}));
vi.mock("@/server/academic-runtime", () => ({
  executeRoleCapability: mocks.executeRoleCapability,
}));

import {
  beginLessonAction,
  askProfessorAction,
} from "@/app/student/classroom/actions";

const classSessionId = "40000000-0000-4000-8000-000000000009";
const context = {
  classroomId: "aaaaaaaa-0000-4000-8000-000000000001",
  classSessionId,
  enrolmentId: "bbbbbbbb-0000-4000-8000-000000000001",
  programmeVersionId: "cccccccc-0000-4000-8000-000000000001",
  lessonId: "dddddddd-0000-4000-8000-000000000001",
  mode: "LIVE",
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.openProfessorClassroom.mockResolvedValue(context);
  mocks.recordProfessorClassroomInteraction.mockResolvedValue(true);
});

describe("beginLessonAction", () => {
  it("uses server-selected capability/context: enrolmentId/lessonId come from the re-derived classroom, never the form", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 5,
        outputTokens: 5,
        estimatedCostMicrousd: 5,
        elapsedMs: 5,
      },
      response: {
        outputText: "Welcome to the lesson.",
        usage: { inputTokens: 5, outputTokens: 5, estimatedCostMicrousd: 5 },
      },
    });
    const result = await beginLessonAction(
      {},
      form({
        classSessionId,
        idempotencyKey: "key-1",
        // Deliberately supplied but must be ignored entirely.
        enrolmentId: "00000000-0000-4000-8000-000000000000",
        role: "TUTOR",
        capability: "anything",
      }),
    );
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Welcome to the lesson.",
    });
    expect(mocks.executeRoleCapability).toHaveBeenCalledExactlyOnceWith({
      enrolmentId: context.enrolmentId,
      role: "PROFESSOR",
      capability: "get_lesson_context",
      lessonId: context.lessonId,
      classSessionId: context.classSessionId,
      interaction: { kind: "BEGIN_LESSON" },
    });
  });

  it("does not call the provider (or open a classroom via a bogus id) for an invalid classSessionId", async () => {
    const result = await beginLessonAction(
      {},
      form({ classSessionId: "not-a-uuid", idempotencyKey: "key-1" }),
    );
    expect(result).toEqual({ error: "Invalid request." });
    expect(mocks.openProfessorClassroom).not.toHaveBeenCalled();
    expect(mocks.executeRoleCapability).not.toHaveBeenCalled();
  });

  it("classroom denial (foreign/cancelled/not-yet-started/service issue) fails closed without exposing internals", async () => {
    mocks.openProfessorClassroom.mockRejectedValue(new Error("FORBIDDEN"));
    const result = await beginLessonAction(
      {},
      form({ classSessionId, idempotencyKey: "key-1" }),
    );
    expect(result).toEqual({
      error: "This classroom is not currently available.",
    });
    expect(result.error).not.toMatch(/forbidden|sql|uuid|internal/i);
    expect(mocks.executeRoleCapability).not.toHaveBeenCalled();
  });

  it("duplicate submission/idempotency: a repeated key never reaches the provider a second time", async () => {
    mocks.recordProfessorClassroomInteraction.mockResolvedValue(false);
    const result = await beginLessonAction(
      {},
      form({ classSessionId, idempotencyKey: "same-key" }),
    );
    expect(result).toEqual({ status: "DUPLICATE" });
    expect(mocks.executeRoleCapability).not.toHaveBeenCalled();
  });
});

describe("askProfessorAction", () => {
  it("a bounded learner question reaches the provider context via the reviewed interaction shape", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 5,
        outputTokens: 5,
        estimatedCostMicrousd: 5,
        elapsedMs: 5,
      },
      response: {
        outputText: "Here is the answer.",
        usage: { inputTokens: 5, outputTokens: 5, estimatedCostMicrousd: 5 },
      },
    });
    const result = await askProfessorAction(
      {},
      form({
        classSessionId,
        idempotencyKey: "key-2",
        message: "  What is access control?  ",
      }),
    );
    expect(result).toEqual({
      status: "SUCCEEDED",
      text: "Here is the answer.",
    });
    expect(mocks.executeRoleCapability).toHaveBeenCalledExactlyOnceWith({
      enrolmentId: context.enrolmentId,
      role: "PROFESSOR",
      capability: "get_lesson_context",
      lessonId: context.lessonId,
      classSessionId: context.classSessionId,
      interaction: {
        kind: "LEARNER_QUESTION",
        learnerMessage: "What is access control?",
      },
    });
  });

  it("an empty message fails before any classroom lookup or provider call", async () => {
    const result = await askProfessorAction(
      {},
      form({ classSessionId, idempotencyKey: "key-2", message: "   " }),
    );
    expect(result.error).toBeTruthy();
    expect(mocks.openProfessorClassroom).not.toHaveBeenCalled();
    expect(mocks.executeRoleCapability).not.toHaveBeenCalled();
  });

  it("an overlong (>2000 char) message fails before any classroom lookup or provider call", async () => {
    const result = await askProfessorAction(
      {},
      form({
        classSessionId,
        idempotencyKey: "key-2",
        message: "x".repeat(2001),
      }),
    );
    expect(result.error).toBeTruthy();
    expect(mocks.openProfessorClassroom).not.toHaveBeenCalled();
    expect(mocks.executeRoleCapability).not.toHaveBeenCalled();
  });

  it("a message of exactly 2000 characters is accepted", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage: {
        providerCalls: 1,
        attempts: 1,
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostMicrousd: 1,
        elapsedMs: 1,
      },
      response: {
        outputText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
      },
    });
    const result = await askProfessorAction(
      {},
      form({
        classSessionId,
        idempotencyKey: "key-2",
        message: "x".repeat(2000),
      }),
    );
    expect(result.status).toBe("SUCCEEDED");
  });

  it("arbitrary extra form fields (role/capability/provider/model/budget) never reach executeRoleCapability", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "ABSTAINED",
      usage: {
        providerCalls: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        elapsedMs: 0,
      },
      reason: "POLICY_BLOCKED",
    });
    await askProfessorAction(
      {},
      form({
        classSessionId,
        idempotencyKey: "key-2",
        message: "A question",
        role: "EXAMINER",
        capability: "delete_everything",
        provider: "attacker-controlled",
        model: "gpt-999",
        maxProviderCalls: "1000",
        maxEstimatedCostMicrousd: "999999999",
      }),
    );
    const call = mocks.executeRoleCapability.mock.calls[0][0];
    expect(Object.keys(call).sort()).toEqual(
      [
        "capability",
        "classSessionId",
        "enrolmentId",
        "interaction",
        "lessonId",
        "role",
      ].sort(),
    );
    expect(call.role).toBe("PROFESSOR");
    expect(call.capability).toBe("get_lesson_context");
  });

  it.each([
    ["ACTIVITY_BLOCKED", "ACTIVITY_BLOCKED"],
    ["POLICY_BLOCKED", "UNAVAILABLE"],
    ["NO_PROVIDER_CONFIGURED", "UNAVAILABLE"],
    ["UNKNOWN_MODEL_PROFILE", "UNAVAILABLE"],
    ["NO_EXECUTION_PATH", "UNAVAILABLE"],
  ] as const)(
    "maps ABSTAINED/%s to the safe learner status %s without exposing the raw reason",
    async (reason, status) => {
      mocks.executeRoleCapability.mockResolvedValue({
        outcome: "ABSTAINED",
        usage: {
          providerCalls: 0,
          attempts: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicrousd: 0,
          elapsedMs: 0,
        },
        reason,
      });
      const result = await askProfessorAction(
        {},
        form({ classSessionId, idempotencyKey: "key-3", message: "hi" }),
      );
      expect(result).toEqual({ status });
    },
  );

  it.each(["BUDGET_BLOCKED", "TIMEOUT", "FAILED", "CANCELLED"] as const)(
    "maps provider %s to a safe RETRY_LATER state with no raw provider/network payload",
    async (outcome) => {
      mocks.executeRoleCapability.mockResolvedValue(
        outcome === "FAILED"
          ? {
              outcome,
              usage: {
                providerCalls: 1,
                attempts: 1,
                inputTokens: 0,
                outputTokens: 0,
                estimatedCostMicrousd: 0,
                elapsedMs: 1,
              },
              reason: "PROVIDER_ERROR",
            }
          : outcome === "BUDGET_BLOCKED"
            ? {
                outcome,
                usage: {
                  providerCalls: 1,
                  attempts: 1,
                  inputTokens: 0,
                  outputTokens: 0,
                  estimatedCostMicrousd: 0,
                  elapsedMs: 1,
                },
                stage: "POST_CALL",
              }
            : {
                outcome,
                usage: {
                  providerCalls: 0,
                  attempts: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  estimatedCostMicrousd: 0,
                  elapsedMs: 0,
                },
              },
      );
      const result = await askProfessorAction(
        {},
        form({ classSessionId, idempotencyKey: "key-4", message: "hi" }),
      );
      expect(result).toEqual({ status: "RETRY_LATER" });
      expect(JSON.stringify(result)).not.toMatch(
        /provider|network|payload|http|fetch/i,
      );
    },
  );

  it("maps ESCALATED to a safe academic-review status", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
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
    const result = await askProfessorAction(
      {},
      form({ classSessionId, idempotencyKey: "key-5", message: "hi" }),
    );
    expect(result).toEqual({ status: "ESCALATED" });
  });

  // Correction pass (independent review, Blocker 3): executeRoleCapability
  // is the existing, unmodified governed entrypoint, but this call site
  // must not assume it can only ever resolve. An unexpected infrastructure/
  // database/controller/schema/runtime exception must become the same safe
  // RETRY_LATER learner state already used for an ordinary provider
  // failure -- never propagate the raw exception, its message, or any
  // secret-looking substring to the learner, and never attempt a second
  // executeRoleCapability call automatically. The idempotency key has
  // already been reserved by this point and stays consumed; only a fresh
  // deliberate learner action (a fresh key) may try again.
  it("an unexpected executeRoleCapability exception becomes a safe RETRY_LATER result, never the raw exception", async () => {
    mocks.executeRoleCapability.mockRejectedValue(
      new Error(
        "ECONNREFUSED postgres://controller:s3cr3t-p4ssw0rd@db.internal:5432/academy controller_key=ctrl_live_abc123",
      ),
    );
    const result = await askProfessorAction(
      {},
      form({ classSessionId, idempotencyKey: "key-6", message: "hi" }),
    );
    expect(result).toEqual({ status: "RETRY_LATER" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /s3cr3t|controller_key|postgres:\/\/|ECONNREFUSED/i,
    );
    expect(mocks.executeRoleCapability).toHaveBeenCalledTimes(1);
  });

  it("the same unexpected-exception safety applies to beginLessonAction, with no automatic retry", async () => {
    mocks.executeRoleCapability.mockRejectedValue(
      new Error("controller signature verification failed: key=ctrl_live_xyz"),
    );
    const result = await beginLessonAction(
      {},
      form({ classSessionId, idempotencyKey: "key-7" }),
    );
    expect(result).toEqual({ status: "RETRY_LATER" });
    expect(JSON.stringify(result)).not.toMatch(/ctrl_live|signature/i);
    expect(mocks.executeRoleCapability).toHaveBeenCalledTimes(1);
  });
});

describe("AC-2 classroom memory states", () => {
  const usage = {
    providerCalls: 1,
    attempts: 1,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostMicrousd: 1,
    elapsedMs: 1,
  };
  it("returns the confirmed answer and says when it was not recorded", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "SUCCEEDED",
      usage,
      response: {
        outputText: "Answer",
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 1 },
      },
      classroomMemory: "NOT_RECORDED",
    });
    expect(
      await askProfessorAction(
        {},
        form({ classSessionId, idempotencyKey: "k-mem", message: "Why?" }),
      ),
    ).toEqual({ status: "SUCCEEDED", text: "Answer", memoryNotRecorded: true });
  });
  it("reports the explicit memory capacity state", async () => {
    mocks.executeRoleCapability.mockResolvedValue({
      outcome: "ABSTAINED",
      usage,
      reason: "POLICY_BLOCKED",
      classroomMemory: "CAPACITY_REACHED",
    });
    expect(
      await askProfessorAction(
        {},
        form({ classSessionId, idempotencyKey: "k-full", message: "Why?" }),
      ),
    ).toEqual({ status: "MEMORY_FULL" });
  });
});
