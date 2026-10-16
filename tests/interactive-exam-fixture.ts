import type { ObjectiveQuestionType } from "@/domain/assessment-question-types";

// SYNTHETIC, labelled demo content for CP2 tests only. Not real course,
// certification or exam content; no official question bank is reproduced.

export const SYNTHETIC = {
  options: (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `o${i + 1}`,
      label: `Synthetic option ${i + 1}`,
    })),
};

export type SyntheticObjectiveQuestion = {
  position: number;
  prompt: string;
  maxMarks: number;
  expectedAnswer: string;
  markingGuidance: string | null;
  objectiveRefs: string[];
  questionType: ObjectiveQuestionType;
  interaction: unknown;
  answerKey: unknown;
  // A fully correct learner response (scores maxMarks).
  bestResponse: unknown;
};

// One question of each objective type, positions 1..5.
export function syntheticObjectiveQuestions(): SyntheticObjectiveQuestion[] {
  const base = (position: number) => ({
    position,
    prompt: `Synthetic demo question ${position} (not real exam content).`,
    expectedAnswer: `Synthetic protected rationale sentinel ${position}`,
    markingGuidance: null,
    objectiveRefs: ["obj-1"],
  });
  return [
    {
      ...base(1),
      maxMarks: 2,
      questionType: "SINGLE_SELECT",
      interaction: { options: SYNTHETIC.options(3) },
      answerKey: { correctOptionId: "o2" },
      bestResponse: { optionId: "o2" },
    },
    {
      ...base(2),
      maxMarks: 4,
      questionType: "MULTIPLE_SELECT",
      interaction: {
        options: SYNTHETIC.options(4),
        requiredSelections: 2,
        scoringRule: "NET_PROPORTIONAL",
      },
      answerKey: { correctOptionIds: ["o1", "o3"] },
      bestResponse: { optionIds: ["o1", "o3"] },
    },
    {
      ...base(3),
      maxMarks: 6,
      questionType: "PBQ_MATCHING",
      interaction: {
        items: [1, 2, 3].map((n) => ({
          id: `i${n}`,
          label: `Synthetic item ${n}`,
        })),
        targets: [1, 2, 3].map((n) => ({
          id: `t${n}`,
          label: `Synthetic target ${n}`,
        })),
        allowTargetReuse: false,
        scoringRule: "PER_ITEM_PROPORTIONAL",
      },
      answerKey: { mapping: { i1: "t1", i2: "t2", i3: "t3" } },
      bestResponse: { matches: { i1: "t1", i2: "t2", i3: "t3" } },
    },
    {
      ...base(4),
      maxMarks: 4,
      questionType: "PBQ_ORDERING",
      interaction: {
        // Displayed order; deliberately not the correct order.
        steps: [3, 1, 4, 2].map((n) => ({
          id: `s${n}`,
          label: `Synthetic step ${n}`,
        })),
        scoringRule: "ALL_OR_NOTHING",
      },
      answerKey: { correctOrder: ["s1", "s2", "s3", "s4"] },
      bestResponse: { order: ["s1", "s2", "s3", "s4"] },
    },
    {
      ...base(5),
      maxMarks: 3,
      questionType: "PBQ_CONFIGURATION",
      interaction: {
        scenario:
          "Synthetic scenario: a demo host must refuse remote shell access. No command is executed; choose settings only.",
        fields: [
          {
            id: "action",
            label: "Rule action",
            options: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
          {
            id: "protocol",
            label: "Protocol",
            options: [
              { id: "tcp", label: "TCP" },
              { id: "udp", label: "UDP" },
            ],
          },
          {
            id: "port",
            label: "Port",
            options: [
              { id: "p22", label: "22" },
              { id: "p80", label: "80" },
              { id: "p443", label: "443" },
            ],
          },
        ],
        scoringRule: "PER_FIELD_PROPORTIONAL",
      },
      answerKey: { values: { action: "deny", protocol: "tcp", port: "p22" } },
      bestResponse: {
        values: { action: "deny", protocol: "tcp", port: "p22" },
      },
    },
  ];
}

// Package-shaped questions (without the test-only bestResponse).
export function packageQuestions(
  questions: SyntheticObjectiveQuestion[] = syntheticObjectiveQuestions(),
) {
  return questions.map(({ bestResponse: _best, ...q }) => {
    void _best;
    return q;
  });
}

export const FREE_TEXT_QUESTION = {
  position: 6,
  prompt: "Synthetic written question: explain one control in your own words.",
  maxMarks: 5,
  expectedAnswer: "Synthetic protected free-text answer sentinel",
  markingGuidance: null,
  objectiveRefs: ["obj-1"],
};
