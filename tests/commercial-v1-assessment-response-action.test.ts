import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAssessmentResponse: vi.fn(),
  startAssessmentAttempt: vi.fn(),
  submitAssessmentAttempt: vi.fn(),
  submitAssignment: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/assessments", () => ({
  recordAssessmentResponse: mocks.recordAssessmentResponse,
  startAssessmentAttempt: mocks.startAssessmentAttempt,
  submitAssessmentAttempt: mocks.submitAssessmentAttempt,
}));
vi.mock("@/server/assignments", () => ({
  submitAssignment: mocks.submitAssignment,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { saveControlledAssessmentResponse } from "@/app/student/actions";

const attemptId = "11111111-1111-4111-8111-111111111111";
const questionId = "22222222-2222-4222-8222-222222222222";
const generic =
  "Unable to save this response. Check the active attempt, protected question, time window and submission reference.";

function form(extra: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    attemptId,
    questionId,
    body: "An answer",
    idempotencyKey: "assessment-key-0001",
    ...extra,
  }))
    data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("saveControlledAssessmentResponse outcome mapping", () => {
  it("reports success and revalidates", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "33333333-3333-4333-8333-333333333333",
    });

    expect(await saveControlledAssessmentResponse({}, form())).toEqual({
      message: "Response revision saved.",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/student/assessments");
  });

  it.each([
    [
      { ok: false, code: "EXPIRED" },
      /time for this assessment has ended.*submitted automatically/i,
    ],
    [
      { ok: false, code: "RESPONSE_WINDOW_CLOSED" },
      /no longer accepting responses/i,
    ],
    [{ ok: false, code: "ATTEMPT_NOT_ACTIVE" }, /no longer active/i],
  ])(
    "maps the structured refusal %j to its own message and still revalidates",
    async (outcome, message) => {
      mocks.recordAssessmentResponse.mockResolvedValue(outcome);

      const result = await saveControlledAssessmentResponse({}, form());

      expect(result.message).toBeUndefined();
      expect(result.error).toMatch(message);
      // A governed refusal can itself have durably finalised the attempt.
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/student/assessments");
    },
  );

  it.each(["NOT_FOUND_OR_FORBIDDEN", "INVALID_INPUT", "IDEMPOTENCY_CONFLICT"])(
    "%s uses the generic message, which reveals nothing about whether the attempt exists",
    async (code) => {
      mocks.recordAssessmentResponse.mockResolvedValue({ ok: false, code });

      expect(await saveControlledAssessmentResponse({}, form())).toEqual({
        error: generic,
      });
    },
  );

  it("a thrown error becomes the generic message without echoing the exception", async () => {
    mocks.recordAssessmentResponse.mockRejectedValue(
      new Error("SQL credential sentinel"),
    );

    const result = await saveControlledAssessmentResponse({}, form());

    expect(result).toEqual({ error: generic });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("forwards only the four form fields; hostile extras never reach the server boundary", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "33333333-3333-4333-8333-333333333333",
    });

    await saveControlledAssessmentResponse(
      {},
      form({ isCommercialV1: "false", writer: "legacy", studentId: "x" }),
    );

    expect(mocks.recordAssessmentResponse).toHaveBeenCalledTimes(1);
    expect(mocks.recordAssessmentResponse.mock.calls[0][0]).toEqual({
      attemptId,
      questionId,
      body: "An answer",
      idempotencyKey: "assessment-key-0001",
    });
  });
});
