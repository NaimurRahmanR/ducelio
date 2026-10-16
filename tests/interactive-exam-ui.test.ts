import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticObjectiveQuestions } from "./interactive-exam-fixture";

// CP2 learner exam UI, staff review form and server-side boundaries.
// Rendering uses the REAL components and domain logic; only server actions,
// navigation and the transport are stubbed. Synthetic content only.

const mocks = vi.hoisted(() => ({
  recordAssessmentResponse: vi.fn(),
  rpc: vi.fn(),
  requireAnyRole: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/assessments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/assessments")>();
  return {
    ...actual,
    recordAssessmentResponse: mocks.recordAssessmentResponse,
    startAssessmentAttempt: vi.fn(),
  };
});
vi.mock("@/server/identity", () => ({
  requireAnyRole: mocks.requireAnyRole,
  requireActor: vi.fn(),
}));
vi.mock("@/server/supabase", () => ({
  createSupabase: async () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/server/commercial-v1-submission-grading", () => ({
  submitControlledAssessmentAndGrade: vi.fn(),
}));
vi.mock("@/server/assignments", () => ({ submitAssignment: vi.fn() }));

import { ExamWorkspace, type ExamQuestion } from "@/components/exam-workspace";
import { AssessmentReviewForm } from "@/components/academic-review-forms";
import { ObjectiveQuestionEditor } from "@/components/objective-question-editor";
import { saveControlledAssessmentResponse } from "@/app/student/actions";
import {
  addObjectiveAssessmentQuestion,
  ObjectiveQuestionDefinitionError,
} from "@/server/assessments";

const synthetic = syntheticObjectiveQuestions();
const attempt = {
  id: "11111111-1111-4111-8111-111111111111",
  attempt_number: 1,
  expires_at: "2026-10-16T12:30:00.000Z",
};
const serverNow = "2026-10-16T11:00:00.000Z";

function examQuestion(i: number, saved: string | null = null): ExamQuestion {
  const q = synthetic[i];
  return {
    id: `2222222${i}-2222-4222-8222-222222222222`,
    position: q.position,
    prompt: q.prompt,
    max_marks: q.maxMarks,
    question_type: q.questionType,
    interaction: q.interaction,
    saved_body: saved,
    revision_count: saved ? 1 : 0,
  };
}
function render(questions: ExamQuestion[], overrides = {}) {
  return renderToStaticMarkup(
    createElement(ExamWorkspace, {
      title: "Synthetic demo quiz",
      instructions: "Synthetic instructions <b>not bold</b>",
      attempt,
      questions,
      serverNow,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("learner exam workspace", () => {
  it("renders native, labelled controls for every question type with disclosed rules", () => {
    const single = render([examQuestion(0)]);
    expect(single.match(/type="radio"/g)).toHaveLength(3);
    expect(single).toContain("Choose one answer.");
    expect(single).toContain("Full marks only for a completely correct answer");

    const multi = render([examQuestion(1)]);
    expect(multi.match(/type="checkbox"/g)).toHaveLength(4);
    expect(multi).toContain("Select exactly 2 answers.");
    expect(multi).toContain("0 of 2 selected");
    expect(multi).toContain(
      "incorrect selection cancels one correct selection",
    );

    const matching = render([examQuestion(2)]);
    expect(matching.match(/<select/g)).toHaveLength(3);
    expect(matching).toContain('<label for="match-');
    expect(matching).toContain("Each target may be used only once.");

    const ordering = render([examQuestion(3)]);
    expect(ordering).toContain("Move up");
    expect(ordering).toContain("Move down");
    expect(ordering).toContain('aria-live="polite"');
    // Starts from the displayed order, which the key guarantees is not correct.
    expect(ordering.indexOf("Synthetic step 3")).toBeLessThan(
      ordering.indexOf("Synthetic step 1"),
    );

    const config = render([examQuestion(4)]);
    expect(config).toContain("SCENARIO");
    expect(config.match(/<select/g)).toHaveLength(3);
    expect(config).toContain("Rule action");

    const text = render([
      {
        ...examQuestion(0),
        question_type: "FREE_TEXT",
        interaction: null,
      },
    ]);
    expect(text).toContain("<textarea");
    expect(text).toContain("/ 20,000 characters");
  });

  it("restores a saved answer exactly after refresh", () => {
    // The saved option, and only it, is checked (attribute order agnostic).
    expect(render([examQuestion(0, '{"optionId":"o2"}')])).toMatch(
      /<input type="radio"[^>]*checked=""[^>]*value="o2"/,
    );
    const multi = render([examQuestion(1, '{"optionIds":["o1","o3"]}')]);
    expect(multi.match(/checked=""/g)).toHaveLength(2);
    expect(multi).toContain("2 of 2 selected");
    expect(render([examQuestion(2, '{"matches":{"i1":"t2"}}')])).toMatch(
      /<option value="t2" selected="">/,
    );
    expect(render([examQuestion(0, '{"optionId":"o2"}')])).toContain(
      "Answer saved",
    );
  });

  it("shows a server-calibrated countdown and question status navigation", () => {
    const html = render([
      examQuestion(0, '{"optionId":"o1"}'),
      examQuestion(1),
    ]);
    expect(html).toContain('role="timer"');
    expect(html).toContain("1:30:00");
    expect(html).toContain('aria-label="Question 1: Answer saved"');
    expect(html).toContain('aria-label="Question 2: Not answered"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("1 of 2 answered");
    expect(html).toContain("answers are not saved automatically");
  });

  it("locks answering once the database deadline has passed", () => {
    const html = render([examQuestion(0)], {
      attempt: { ...attempt, expires_at: "2026-10-16T10:59:00.000Z" },
    });
    expect(html).toContain("Time is up.");
    expect(html).toContain("Refresh attempt status");
    expect(html).toMatch(/<fieldset class="exam-choices" disabled="">/);
    expect(html).toMatch(
      /<button class="button" disabled="">Save answer<\/button>/,
    );
  });

  it("renders learner content as text and never carries a key", () => {
    const html = render([
      { ...examQuestion(0), prompt: "<script>alert(1)</script>" },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Synthetic instructions &lt;b&gt;");
    for (const field of [
      "correctOptionId",
      "answerKey",
      "correctOrder",
      "mapping",
    ])
      expect(html).not.toContain(field);
  });

  it("posts the revision slot, not a client-built idempotency key (CP2C)", () => {
    const html = render([examQuestion(0, '{"optionId":"o2"}')]);
    expect(html).toContain('name="revisionSlot" value="2"');
    expect(html).not.toContain('name="idempotencyKey"');
  });
});

describe("staff review of objective questions", () => {
  it("shows the learner answer and a locked deterministic mark, not an editable input", () => {
    const q = synthetic[1];
    const html = renderToStaticMarkup(
      createElement(AssessmentReviewForm, {
        caseId: "33333333-3333-4333-8333-333333333333",
        questions: [
          {
            questionId: "44444444-4444-4444-8444-444444444444",
            position: 1,
            prompt: q.prompt,
            maxMarks: q.maxMarks,
            expectedAnswer: "Synthetic rationale",
            markingGuidance: null,
            answered: true,
            responseBody: '{"optionIds":["o1"]}',
            objective: {
              questionType: q.questionType,
              interaction: q.interaction,
              deterministicMarks: 2,
            },
          },
        ],
      }),
    );
    expect(html).toContain("Synthetic option 1");
    expect(html).toContain("Deterministic mark: 2 of 4");
    expect(html).toContain(
      'type="hidden" name="mark:44444444-4444-4444-8444-444444444444" value="2"',
    );
    expect(html).not.toContain('type="number"');
  });
});

describe("objective question authoring", () => {
  it("renders a structured editor whose submit stays disabled until the question is complete", () => {
    const html = renderToStaticMarkup(
      createElement(ObjectiveQuestionEditor, {
        draftAssessments: [{ id: "a", title: "Synthetic draft" }],
      }),
    );
    expect(html).toContain("Multiple choice (one answer)");
    expect(html).toContain("Performance-based: configuration");
    expect(html).toContain('name="interaction"');
    expect(html).toContain('name="answerKey"');
    expect(html).toMatch(
      /<button class="button" disabled="">Add objective question<\/button>/,
    );
  });

  it("refuses an inconsistent definition before any RPC, without echoing it", async () => {
    const [single] = synthetic;
    const input = {
      assessmentId: "55555555-5555-4555-8555-555555555555",
      position: 1,
      prompt: "Synthetic prompt",
      maxMarks: 2,
      questionType: "SINGLE_SELECT",
      interaction: JSON.stringify(single.interaction),
      answerKey: JSON.stringify({ correctOptionId: "secret-zz" }),
      expectedAnswer: "Synthetic rationale",
      markingGuidance: null,
      reason: "Synthetic authoring",
    };
    const error = await addObjectiveAssessmentQuestion(input).catch((e) => e);
    expect(error).toBeInstanceOf(ObjectiveQuestionDefinitionError);
    expect(String(error)).not.toContain("secret-zz");
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({
      data: "66666666-6666-4666-8666-666666666666",
      error: null,
    });
    await addObjectiveAssessmentQuestion({
      ...input,
      answerKey: JSON.stringify(single.answerKey),
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "add_objective_assessment_question",
      expect.objectContaining({
        p_question_type: "SINGLE_SELECT",
        p_interaction: single.interaction,
        p_answer_key: single.answerKey,
      }),
    );
  });
});

describe("learner save action", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries({
      attemptId: attempt.id,
      questionId: "22222220-2222-4222-8222-222222222222",
      idempotencyKey: "assessment-key-0001",
      ...fields,
    }))
      data.append(k, v);
    return data;
  };

  it("canonicalises an objective answer before saving so retries replay", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "x",
    });
    await saveControlledAssessmentResponse(
      {},
      form({
        questionType: "MULTIPLE_SELECT",
        body: '{ "optionIds": ["o3", "o1"] }',
      }),
    );
    expect(mocks.recordAssessmentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ body: '{"optionIds":["o1","o3"]}' }),
    );
  });

  it("refuses a malformed objective answer without calling the writer", async () => {
    expect(
      await saveControlledAssessmentResponse(
        {},
        form({ questionType: "SINGLE_SELECT", body: "not json" }),
      ),
    ).toEqual({ error: expect.stringMatching(/Unable to save this response/) });
    expect(mocks.recordAssessmentResponse).not.toHaveBeenCalled();
  });

  it("passes free text through unchanged", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "x",
    });
    await saveControlledAssessmentResponse(
      {},
      form({ questionType: "FREE_TEXT", body: "  My synthetic answer  " }),
    );
    expect(mocks.recordAssessmentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ body: "  My synthetic answer  " }),
    );
  });

  // CP2C: the workspace posts a revision slot, never a client-built key.
  const slotForm = (body: string, slot = "1", questionType = "FREE_TEXT") => {
    const data = new FormData();
    for (const [k, v] of Object.entries({
      attemptId: attempt.id,
      questionId: "22222220-2222-4222-8222-222222222222",
      questionType,
      revisionSlot: slot,
      body,
    }))
      data.append(k, v);
    return data;
  };
  const sentKey = (call: number) =>
    mocks.recordAssessmentResponse.mock.calls[call][0].idempotencyKey as string;

  it("derives distinct server-side keys for the reported colliding answers", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "x",
    });
    await saveControlledAssessmentResponse({}, slotForm("d27g1xbhlordy"));
    await saveControlledAssessmentResponse({}, slotForm("rae2hl0i00jow"));
    expect(sentKey(0)).not.toBe(sentKey(1));
    expect(sentKey(0)).toMatch(
      /^assessment:11111111-1111-4111-8111-111111111111:question:22222220-2222-4222-8222-222222222222:revision:1:[0-9a-f]{64}$/,
    );
  });

  it("reuses the same key for an identical retry and canonicalises before hashing", async () => {
    mocks.recordAssessmentResponse.mockResolvedValue({
      ok: true,
      responseId: "x",
    });
    await saveControlledAssessmentResponse(
      {},
      slotForm('{"optionIds":["o3","o1"]}', "2", "MULTIPLE_SELECT"),
    );
    await saveControlledAssessmentResponse(
      {},
      slotForm('{ "optionIds": ["o1", "o3"] }', "2", "MULTIPLE_SELECT"),
    );
    expect(sentKey(0)).toBe(sentKey(1));
    expect(sentKey(0)).toContain(":revision:2:");
  });

  it("an invalid revision slot is refused before any write", async () => {
    expect(
      await saveControlledAssessmentResponse({}, slotForm("an answer", "0")),
    ).toEqual({ error: expect.stringMatching(/Unable to save this response/) });
    expect(mocks.recordAssessmentResponse).not.toHaveBeenCalled();
  });
});
