import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitControlledAssessmentAndGrade: vi.fn(),
  submitPracticalLabWorkAndGrade: vi.fn(),
  recordAssessmentResponse: vi.fn(),
  startAssessmentAttempt: vi.fn(),
  submitAssignment: vi.fn(),
  requestPracticalSupport: vi.fn(),
  executeTutorLabSupport: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/commercial-v1-submission-grading", () => ({
  submitControlledAssessmentAndGrade: mocks.submitControlledAssessmentAndGrade,
  submitPracticalLabWorkAndGrade: mocks.submitPracticalLabWorkAndGrade,
}));
vi.mock("@/server/assessments", () => ({
  recordAssessmentResponse: mocks.recordAssessmentResponse,
  startAssessmentAttempt: mocks.startAssessmentAttempt,
}));
vi.mock("@/server/assignments", () => ({
  submitAssignment: mocks.submitAssignment,
}));
vi.mock("@/server/course-activation", () => ({
  requestPracticalSupport: mocks.requestPracticalSupport,
}));
vi.mock("@/server/tutor-lab-execution", () => ({
  executeTutorLabSupport: mocks.executeTutorLabSupport,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { finishControlledAssessment } from "@/app/student/actions";
import { submitPracticalLabWorkAction } from "@/app/student/practicals/actions";

const attemptId = "11111111-1111-4111-8111-111111111111";
const submissionId = "22222222-2222-4222-8222-222222222222";
const enrolmentId = "33333333-3333-4333-8333-333333333333";
const practicalId = "44444444-4444-4444-8444-444444444444";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("finishControlledAssessment: safe grading status mapping", () => {
  it.each([
    ["GRADED", "Assessment submitted."],
    [
      "ESCALATED",
      "Assessment submitted. This assessment has been sent for academic review.",
    ],
    [
      "GRADING_PENDING",
      "Assessment submitted. Grading is in progress; check back shortly.",
    ],
    [
      "GRADING_UNAVAILABLE",
      "Assessment submitted. Grading is not currently available for this attempt.",
    ],
  ])(
    "maps grading=%s to a calm message, and always revalidates",
    async (grading, expected) => {
      mocks.submitControlledAssessmentAndGrade.mockResolvedValue({
        attemptId,
        grading,
      });

      const result = await finishControlledAssessment({}, form({ attemptId }));

      expect(result).toEqual({ message: expected });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/student/assessments");
    },
  );

  it("never names Examiner/provider/recovery internals in any mapped message", async () => {
    for (const grading of [
      "GRADED",
      "ESCALATED",
      "GRADING_PENDING",
      "GRADING_UNAVAILABLE",
    ]) {
      mocks.submitControlledAssessmentAndGrade.mockResolvedValue({
        attemptId,
        grading,
      });
      const result = await finishControlledAssessment({}, form({ attemptId }));
      expect(result.message).not.toMatch(
        /recovery|examiner|provider|hmac|controller|reason.?code/i,
      );
    }
  });

  it("a submission failure reports the generic error and never revalidates", async () => {
    mocks.submitControlledAssessmentAndGrade.mockRejectedValue(
      new Error("Assessment attempt could not be submitted."),
    );

    const result = await finishControlledAssessment({}, form({ attemptId }));

    expect(result).toEqual({
      error: "Unable to submit this assessment attempt.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(
      "Assessment attempt could not be submitted.",
    );
  });

  it("the browser cannot supply grading capability/provider/marks -- only attemptId reaches composition", async () => {
    mocks.submitControlledAssessmentAndGrade.mockResolvedValue({
      attemptId,
      grading: "GRADED",
    });

    await finishControlledAssessment(
      {},
      form({
        attemptId,
        capability: "grade_controlled_assessment",
        provider: "evil-provider",
        model: "gpt-x",
        marks: "999",
        recovery: "true",
      }),
    );

    expect(mocks.submitControlledAssessmentAndGrade).toHaveBeenCalledTimes(1);
    expect(mocks.submitControlledAssessmentAndGrade).toHaveBeenCalledWith(
      attemptId,
    );
  });
});

describe("submitPracticalLabWorkAction: safe grading status mapping", () => {
  it.each(["GRADED", "ESCALATED", "GRADING_PENDING", "GRADING_UNAVAILABLE"])(
    "reports SUBMITTED with grading=%s",
    async (grading) => {
      mocks.submitPracticalLabWorkAndGrade.mockResolvedValue({
        submissionId,
        grading,
      });

      const result = await submitPracticalLabWorkAction(
        {},
        form({
          enrolmentId,
          practicalId,
          body: "My final lab work",
          idempotencyKey: `lab:${enrolmentId}:${practicalId}`,
        }),
      );

      expect(result).toEqual({ status: "SUBMITTED", grading });
    },
  );

  it("forwards only the four governed fields, ignoring hostile extras", async () => {
    mocks.submitPracticalLabWorkAndGrade.mockResolvedValue({
      submissionId,
      grading: "GRADED",
    });

    await submitPracticalLabWorkAction(
      {},
      form({
        enrolmentId,
        practicalId,
        body: "My final lab work",
        idempotencyKey: "key-1",
        capability: "grade_practical_lab",
        marksAwarded: "999",
        studentId: "attacker",
      }),
    );

    expect(mocks.submitPracticalLabWorkAndGrade).toHaveBeenCalledTimes(1);
    expect(mocks.submitPracticalLabWorkAndGrade).toHaveBeenCalledWith({
      enrolmentId,
      practicalId,
      body: "My final lab work",
      idempotencyKey: "key-1",
    });
  });

  it("a submission failure reports a generic error without echoing the exception", async () => {
    mocks.submitPracticalLabWorkAndGrade.mockRejectedValue(
      new Error("SQL credential sentinel"),
    );

    const result = await submitPracticalLabWorkAction(
      {},
      form({
        enrolmentId,
        practicalId,
        body: "My final lab work",
        idempotencyKey: "key-1",
      }),
    );

    expect(result.status).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });
});
