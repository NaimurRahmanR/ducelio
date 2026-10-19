import { describe, expect, it } from "vitest";
import {
  protectedMarkerHits,
  protectedProviderRequestHits,
  RATIONALE_SENTINEL,
} from "../scripts/acceptance/exam-engine-plan.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const baseQuestion = () => ({
  questionId: id,
  position: 6,
  prompt: "Synthetic free-text prompt.",
  maxMarks: 5,
  expectedAnswer: `${RATIONALE_SENTINEL} 6`,
  markingGuidance: null as string | null,
  responseBody: "Learner's synthetic prose.",
});
const baseContext = () => ({
  attemptId: "22222222-2222-4222-8222-222222222222",
  assessmentId: "33333333-3333-4333-8333-333333333333",
  component: "QUIZ_1",
  instructions: "Synthetic instructions.",
  questions: [baseQuestion()],
  title: "QUIZ_1 acceptance checkpoint",
});
// Adversarial cases mutate the context into shapes the type forbids.
type MutableContext = { questions: Record<string, unknown>[] } & Record<
  string,
  unknown
>;
const rawRequest = (
  context: unknown = baseContext(),
  instructions = "Grade only the supplied text.",
) =>
  JSON.stringify({
    model: "acceptance-local-model",
    instructions,
    input: JSON.stringify({
      capability: "grade_controlled_assessment",
      context,
    }),
    max_output_tokens: 500,
    store: false,
  });

describe("A2T provider protection: authorised free-text rubric versus objective leaks", () => {
  it("uses the exact production serializer keys and rejects a role added to input", () => {
    const body = JSON.parse(rawRequest());
    const input = JSON.parse(body.input);
    expect(Object.keys(input).sort()).toEqual(["capability", "context"]);
    input.role = "EXAMINER";
    body.input = JSON.stringify(input);
    expect(protectedProviderRequestHits(JSON.stringify(body))).toEqual([
      "UNEXPECTED_PROVIDER_CONTEXT_SHAPE",
    ]);
  });
  it("proves the original blanket scanner always misflags a valid legacy free-text rubric", () => {
    expect(protectedMarkerHits(rawRequest())).toEqual(
      expect.arrayContaining([
        RATIONALE_SENTINEL,
        "expectedAnswer",
        "markingGuidance",
      ]),
    );
    expect(protectedProviderRequestHits(rawRequest())).toEqual([]);
  });

  it("accepts the exact legacy grading context shape, including nullable marking guidance", () => {
    const ctx = baseContext();
    ctx.questions[0].markingGuidance = "Synthetic text-only rubric.";
    expect(protectedProviderRequestHits(rawRequest(ctx))).toEqual([]);
  });

  it("rejects an objective answer key appended to the free-text question", () => {
    const ctx = baseContext() as unknown as MutableContext;
    ctx.questions[0].answerKey = { correctOptionId: "o1" };
    expect(protectedProviderRequestHits(rawRequest(ctx))).toEqual([
      "UNEXPECTED_PROVIDER_QUESTION_SHAPE",
    ]);
  });

  it("rejects an objective mark or score metadata in the provider context", () => {
    const ctx = baseContext() as unknown as MutableContext;
    ctx.objectiveMarks = [{ questionId: id, marksAwarded: 2 }];
    expect(protectedProviderRequestHits(rawRequest(ctx))).toEqual([
      "UNEXPECTED_PROVIDER_CONTEXT_SHAPE",
    ]);
  });

  it("rejects protected answer-key tokens outside the legacy rubric positions", () => {
    const ctx = baseContext();
    ctx.questions[0].prompt = `Accidental objective ${RATIONALE_SENTINEL}`;
    expect(protectedProviderRequestHits(rawRequest(ctx))).toContain(
      RATIONALE_SENTINEL,
    );
    const clean = baseContext();
    expect(
      protectedProviderRequestHits(
        rawRequest(clean, "answer_key must stay hidden"),
      ),
    ).toContain("answer_key");
  });

  it("rejects objective key-field names hidden in the learner response", () => {
    const ctx = baseContext();
    ctx.questions[0].responseBody = '{"correctOptionIds":["o1"]}';
    expect(protectedProviderRequestHits(rawRequest(ctx))).toContain(
      "correctOptionIds",
    );
  });

  it("rejects missing/extra free-text rubric fields and malformed requests", () => {
    const ctx = baseContext() as unknown as MutableContext;
    delete ctx.questions[0].markingGuidance;
    expect(protectedProviderRequestHits(rawRequest(ctx))).toEqual([
      "UNEXPECTED_PROVIDER_QUESTION_SHAPE",
    ]);
    expect(protectedProviderRequestHits("not-json")).toEqual([
      "INVALID_PROVIDER_REQUEST_FORMAT",
    ]);
  });

  it("fails closed on invalid question types or non-grading provider capabilities", () => {
    const ctx = baseContext() as unknown as MutableContext;
    ctx.questions[0].expectedAnswer = null;
    expect(protectedProviderRequestHits(rawRequest(ctx))).toEqual([
      "INVALID_PROVIDER_QUESTION_TYPES",
    ]);
    const provider = JSON.parse(rawRequest());
    const input = JSON.parse(provider.input);
    input.capability = "read_lesson";
    provider.input = JSON.stringify(input);
    expect(protectedProviderRequestHits(JSON.stringify(provider))).toEqual([
      "UNEXPECTED_PROVIDER_CONTEXT_SHAPE",
    ]);
  });
});
