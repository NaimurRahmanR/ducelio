import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_QUESTION_TYPES,
  SCORING_RULES,
  answerKeyIssues,
  canonicalResponseBody,
  describeObjectiveResponse,
  interactionIssues,
  parseResponseBody,
  responseIssues,
  scoreObjectiveResponse,
  selectionInstruction,
} from "@/domain/assessment-question-types";
import { validateCoursePackage } from "@/domain/course-package";
import { buildPackage } from "./activation-fixture";
import {
  SYNTHETIC,
  syntheticObjectiveQuestions,
} from "./interactive-exam-fixture";

// Synthetic, labelled demo content only (no real exam or course material).

describe("objective question definitions", () => {
  it("accepts every synthetic definition and its key", () => {
    for (const q of syntheticObjectiveQuestions()) {
      expect(interactionIssues(q.questionType, q.interaction)).toEqual([]);
      expect(
        answerKeyIssues(q.questionType, q.interaction, q.answerKey),
      ).toEqual([]);
    }
  });

  it.each([
    ["SINGLE_SELECT", { options: [{ id: "a", label: "Only one" }] }],
    [
      "SINGLE_SELECT",
      {
        options: [
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ],
      },
    ],
    [
      "SINGLE_SELECT",
      {
        options: [
          { id: "A", label: "x" },
          { id: "b", label: "y" },
        ],
      },
    ],
    [
      "SINGLE_SELECT",
      {
        options: [
          { id: "a", label: "   " },
          { id: "b", label: "y" },
        ],
      },
    ],
    [
      "SINGLE_SELECT",
      {
        options: [
          { id: "a", label: "x", extra: 1 },
          { id: "b", label: "y" },
        ],
      },
    ],
    [
      "MULTIPLE_SELECT",
      {
        options: SYNTHETIC.options(3),
        requiredSelections: 3,
        scoringRule: "ALL_OR_NOTHING",
      },
    ],
    [
      "MULTIPLE_SELECT",
      {
        options: SYNTHETIC.options(4),
        requiredSelections: null,
        scoringRule: "PER_ITEM_PROPORTIONAL",
      },
    ],
    [
      "PBQ_MATCHING",
      {
        items: SYNTHETIC.options(3),
        targets: SYNTHETIC.options(2),
        allowTargetReuse: false,
        scoringRule: "ALL_OR_NOTHING",
      },
    ],
    [
      "PBQ_ORDERING",
      { steps: SYNTHETIC.options(2), scoringRule: "ALL_OR_NOTHING" },
    ],
    [
      "PBQ_CONFIGURATION",
      {
        scenario: "Synthetic scenario",
        fields: [
          { id: "f", label: "x", options: SYNTHETIC.options(2) },
          { id: "f", label: "y", options: SYNTHETIC.options(2) },
        ],
        scoringRule: "ALL_OR_NOTHING",
      },
    ],
    ["PBQ_CONFIGURATION", null],
  ] as const)("rejects malformed %s interaction %#", (type, interaction) => {
    expect(interactionIssues(type, interaction).length).toBeGreaterThan(0);
  });

  it("rejects keys that disagree with their interaction", () => {
    const [single, multi, matching, ordering, config] =
      syntheticObjectiveQuestions();
    expect(
      answerKeyIssues(single.questionType, single.interaction, {
        correctOptionId: "nope",
      }).length,
    ).toBeGreaterThan(0);
    // Required-selection count must equal the number of correct options.
    expect(
      answerKeyIssues(multi.questionType, multi.interaction, {
        correctOptionIds: ["o1"],
      }).length,
    ).toBeGreaterThan(0);
    // Every option correct is not a question.
    expect(
      answerKeyIssues(
        "MULTIPLE_SELECT",
        {
          options: SYNTHETIC.options(3),
          requiredSelections: null,
          scoringRule: "ALL_OR_NOTHING",
        },
        { correctOptionIds: ["o1", "o2", "o3"] },
      ).length,
    ).toBeGreaterThan(0);
    // Incomplete matching key / reused target without permission.
    expect(
      answerKeyIssues(matching.questionType, matching.interaction, {
        mapping: { i1: "t1" },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      answerKeyIssues(matching.questionType, matching.interaction, {
        mapping: { i1: "t1", i2: "t1", i3: "t3" },
      }).length,
    ).toBeGreaterThan(0);
    // The displayed order may not already be the correct order.
    const steps = (ordering.interaction as { steps: { id: string }[] }).steps;
    expect(
      answerKeyIssues(ordering.questionType, ordering.interaction, {
        correctOrder: steps.map((s) => s.id),
      }).length,
    ).toBeGreaterThan(0);
    expect(
      answerKeyIssues(config.questionType, config.interaction, {
        values: { action: "allow" },
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("learner responses and canonical bodies", () => {
  it("canonicalises sets and keys so a retried save is byte-identical", () => {
    expect(
      canonicalResponseBody("MULTIPLE_SELECT", { optionIds: ["o3", "o1"] }),
    ).toBe('{"optionIds":["o1","o3"]}');
    expect(
      canonicalResponseBody("PBQ_MATCHING", {
        matches: { i2: "t1", i1: "t2" },
      }),
    ).toBe('{"matches":{"i1":"t2","i2":"t1"}}');
    // Ordering is meaningful and is preserved.
    expect(
      canonicalResponseBody("PBQ_ORDERING", { order: ["s3", "s1", "s2"] }),
    ).toBe('{"order":["s3","s1","s2"]}');
    expect(() =>
      canonicalResponseBody("SINGLE_SELECT", { optionId: "x", extra: 1 }),
    ).toThrow();
  });

  it("rejects hostile or malformed responses", () => {
    const [single, multi, matching, ordering, config] =
      syntheticObjectiveQuestions();
    const bad: [typeof single, unknown][] = [
      [single, { optionId: "zz" }],
      [single, { optionId: ["o1"] }],
      [single, { optionIds: ["o1"] }],
      [multi, { optionIds: ["o1", "o1"] }],
      [multi, { optionIds: ["o1", "o2", "o3"] }], // more than required (2)
      [multi, { optionIds: [] }],
      [matching, { matches: {} }],
      [matching, { matches: { i1: "t1", i2: "t1" } }], // reuse not allowed
      [matching, { matches: { nope: "t1" } }],
      [ordering, { order: ["s1", "s2"] }],
      [ordering, { order: ["s1", "s1", "s2", "s3"] }],
      [config, { values: { action: "nope" } }],
      [config, { values: { __proto__: "allow" } }],
      [config, { values: {} }],
    ];
    for (const [q, response] of bad)
      expect(
        responseIssues(q.questionType, q.interaction, response).length,
      ).toBeGreaterThan(0);
    expect(parseResponseBody("SINGLE_SELECT", "not json")).toBeNull();
    expect(parseResponseBody("SINGLE_SELECT", '{"optionId":1}')).toBeNull();
  });

  it("describes a saved answer using learner-visible labels only", () => {
    const [, , matching] = syntheticObjectiveQuestions();
    expect(
      describeObjectiveResponse(
        "PBQ_MATCHING",
        matching.interaction,
        '{"matches":{"i1":"t2"}}',
      ),
    ).toEqual(["Synthetic item 1 → Synthetic target 2"]);
    expect(
      describeObjectiveResponse("PBQ_MATCHING", matching.interaction, "{}"),
    ).toEqual([]);
  });

  it("states explicit selection instructions", () => {
    const [, multi] = syntheticObjectiveQuestions();
    expect(selectionInstruction(multi.questionType, multi.interaction)).toBe(
      "Select exactly 2 answers.",
    );
    expect(
      selectionInstruction("MULTIPLE_SELECT", {
        ...(multi.interaction as object),
        requiredSelections: null,
      }),
    ).toBe("Select all answers that apply.");
  });
});

describe("documented scoring policy (reference implementation)", () => {
  const [single, multi, matching, ordering, config] =
    syntheticObjectiveQuestions();
  const score = (q: typeof single, response: unknown, max = q.maxMarks) =>
    scoreObjectiveResponse(
      q.questionType,
      q.interaction,
      q.answerKey,
      max,
      response,
    );

  it("SINGLE_SELECT is all or nothing", () => {
    expect(score(single, { optionId: "o2" })).toBe(single.maxMarks);
    expect(score(single, { optionId: "o1" })).toBe(0);
    expect(score(single, null)).toBe(0);
  });

  it("MULTIPLE_SELECT NET_PROPORTIONAL: wrong selections cancel right ones, never negative, rounded down", () => {
    // key {o1,o3}, max 4
    expect(score(multi, { optionIds: ["o1", "o3"] })).toBe(4);
    expect(score(multi, { optionIds: ["o1"] })).toBe(2);
    expect(score(multi, { optionIds: ["o1", "o2"] })).toBe(0);
    expect(score(multi, { optionIds: ["o2", "o4"] })).toBe(0);
    expect(score(multi, { optionIds: ["o1", "o3"] }, 5)).toBe(5);
    expect(score(multi, { optionIds: ["o3"] }, 5)).toBe(2); // floor(5/2)
  });

  it("MULTIPLE_SELECT ALL_OR_NOTHING requires the exact set", () => {
    const strict = {
      ...multi,
      interaction: {
        ...(multi.interaction as object),
        scoringRule: "ALL_OR_NOTHING",
      },
    };
    expect(score(strict, { optionIds: ["o3", "o1"] })).toBe(4);
    expect(score(strict, { optionIds: ["o1"] })).toBe(0);
  });

  it("PBQ_MATCHING PER_ITEM_PROPORTIONAL counts correct items", () => {
    // key i1->t1 i2->t2 i3->t3, max 6
    expect(score(matching, { matches: { i1: "t1", i2: "t2", i3: "t3" } })).toBe(
      6,
    );
    expect(score(matching, { matches: { i1: "t1", i2: "t3" } })).toBe(2);
    expect(score(matching, { matches: { i1: "t2" } })).toBe(0);
  });

  it("PBQ_ORDERING ALL_OR_NOTHING needs every step in place", () => {
    expect(score(ordering, { order: ["s1", "s2", "s3", "s4"] })).toBe(
      ordering.maxMarks,
    );
    expect(score(ordering, { order: ["s1", "s2", "s4", "s3"] })).toBe(0);
  });

  it("PBQ_ORDERING PER_POSITION_PROPORTIONAL counts steps in place", () => {
    const proportional = {
      ...ordering,
      interaction: {
        ...(ordering.interaction as object),
        scoringRule: "PER_POSITION_PROPORTIONAL",
      },
    };
    expect(score(proportional, { order: ["s1", "s2", "s4", "s3"] }, 8)).toBe(4);
  });

  it("PBQ_CONFIGURATION PER_FIELD_PROPORTIONAL counts correct settings", () => {
    // key action=deny protocol=tcp port=p22, max 3
    expect(
      score(config, {
        values: { action: "deny", protocol: "tcp", port: "p22" },
      }),
    ).toBe(3);
    expect(score(config, { values: { action: "deny", port: "p80" } })).toBe(1);
  });

  it("never exceeds max marks and is integral for every rule", () => {
    for (const type of OBJECTIVE_QUESTION_TYPES)
      for (const rule of SCORING_RULES[type])
        expect(rule.length).toBeGreaterThan(0);
    for (const q of syntheticObjectiveQuestions())
      for (const max of [1, 2, 3, 7, 100]) {
        const s = scoreObjectiveResponse(
          q.questionType,
          q.interaction,
          q.answerKey,
          max,
          q.bestResponse,
        );
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBe(max);
      }
  });
});

describe("COURSE_PACKAGE_V1 additive compatibility", () => {
  it("an existing package without any extension validates exactly as before", () => {
    const legacy = buildPackage();
    const result = validateCoursePackage(legacy);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(
        result.package.assessmentTemplates[0].questions[0],
      ).not.toHaveProperty("questionType");
      expect(Object.keys(result.report).sort()).toEqual([
        "assessmentTemplateCount",
        "assignmentTemplateCount",
        "lessonCount",
        "moduleCount",
        "objectiveCount",
        "packageKey",
        "packageRevision",
        "practicalActivityCount",
        "resourceCount",
      ]);
    }
  });

  it("accepts objective questions with interaction and answer key", () => {
    const pkg = buildPackage();
    pkg.assessmentTemplates[0].questions = syntheticObjectiveQuestions().map(
      ({ bestResponse: _b, ...q }) => {
        void _b;
        return q;
      },
    );
    expect(validateCoursePackage(pkg).valid).toBe(true);
  });

  it.each([
    [
      { questionType: "FREE_TEXT", interaction: { options: [] } },
      "interaction",
    ],
    [{ answerKey: { correctOptionId: "o1" } }, "answerKey"],
    [{ questionType: "SINGLE_SELECT" }, "interaction"],
    [{ questionType: "ESSAY" }, "questionType"],
  ])("rejects an inconsistent question extension %#", (extension, field) => {
    const pkg = buildPackage();
    Object.assign(pkg.assessmentTemplates[0].questions[0], extension);
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.some((e) => e.path.includes(field))).toBe(true);
  });

  it("reports an invalid answer key without echoing it", () => {
    const pkg = buildPackage();
    const [single] = syntheticObjectiveQuestions();
    Object.assign(pkg.assessmentTemplates[0].questions[0], {
      questionType: single.questionType,
      interaction: single.interaction,
      answerKey: { correctOptionId: "secret-zz" },
    });
    const result = validateCoursePackage(pkg);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-zz");
  });
});
